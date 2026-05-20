#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";

import { BUILTIN_TAGS } from "../shared/wxml-builtins.mjs";
import { matchEventBinding } from "../shared/event-binding-patterns.mjs";
import {
  looksLikeObjectLiteralExpression,
  stripStringLiterals,
  topLevelIdentifiers,
} from "../shared/wxml-expression-helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(ROOT, "grammar/tree-sitter-wxml/tree-sitter-wxml.wasm");
const PROFILE_ENABLED = process.env.WXML_ZED_PROFILE === "1";

const CONTROL_TAGS = new Set(["template", "wxs", "import", "include", "slot", "block"]);

function innerValueRange(quotedValueNode) {
  // quoted_attribute_value spans the full "..." (or '...'). Shrink by one
  // column on each side so nameRange points at the inner handler text.
  // Multi-line attribute values fall back to the full node range.
  const text = quotedValueNode.text;
  if (text.length >= 2
      && (text[0] === '"' || text[0] === "'")
      && text[text.length - 1] === text[0]
      && quotedValueNode.startPosition.row === quotedValueNode.endPosition.row) {
    return {
      start: { row: quotedValueNode.startPosition.row, column: quotedValueNode.startPosition.column + 1 },
      end:   { row: quotedValueNode.endPosition.row,   column: quotedValueNode.endPosition.column - 1 },
    };
  }
  // Fallback (we hit this for non-stdlib quote chars or multi-line values).
  return {
    start: { row: quotedValueNode.startPosition.row, column: quotedValueNode.startPosition.column },
    end:   { row: quotedValueNode.endPosition.row,   column: quotedValueNode.endPosition.column },
  };
}

function elapsedMs(start) {
  return Number((performance.now() - start).toFixed(2));
}

// Expression helpers moved to shared/ for cross-consumer reuse (server LSP +
// extractor). Imported above; behavior unchanged.

function profileEvent(event) {
  if (!PROFILE_ENABLED) return;
  process.stderr.write(`WXML_ZED_PROFILE ${JSON.stringify({
    source: "extract-wxml-symbols",
    ...event,
  })}\n`);
}

function toPosix(p) {
  return p.split(path.sep).join(path.posix.sep);
}

function relativePathFromRoot(filePath) {
  return toPosix(path.relative(ROOT, path.resolve(filePath)));
}

function normalizeDependency(filePath, value) {
  if (!value || value.includes("{{") || !/^\.\.?\//.test(value)) {
    return undefined;
  }
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(relativePathFromRoot(filePath)), value),
  );
}

function rangeOf(node) {
  return {
    start: { row: node.startPosition.row, column: node.startPosition.column },
    end: { row: node.endPosition.row, column: node.endPosition.column },
  };
}

function firstChildOfType(node, type) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === type) return child;
  }
  return null;
}

function unquote(text) {
  if (text.length >= 2) {
    const a = text[0], b = text[text.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return text.slice(1, -1);
  }
  return text;
}

function attributeRawValue(attributeNode) {
  const valueNode = firstChildOfType(attributeNode, "quoted_attribute_value")
    ?? firstChildOfType(attributeNode, "attribute_value");
  if (!valueNode) return undefined;
  return unquote(valueNode.text);
}

function findAttributeByName(parent, attributeNodeType, expectedName) {
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (child.type !== attributeNodeType) continue;
    const nameNode = firstChildOfType(child, "attribute_name");
    if (nameNode && nameNode.text === expectedName) return child;
  }
  return null;
}

function findAnyAttribute(parent, expectedName) {
  for (let i = 0; i < parent.namedChildCount; i++) {
    const child = parent.namedChild(i);
    if (!child.type.endsWith("attribute") && child.type !== "attribute") continue;
    const nameNode = firstChildOfType(child, "attribute_name");
    if (nameNode && nameNode.text === expectedName) return child;
  }
  return null;
}

// Multi-line expression handling: given expression text and a character
// offset into it, compute {rowDelta, columnOfRow} so the caller can derive
// file-level row/column from the expression node's start position.
function offsetToPositionWithin(text, offset) {
  let row = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      row += 1;
      lastNewline = i;
    }
  }
  return { rowDelta: row, columnOfRow: offset - lastNewline - 1 };
}

// Returns the inner string of an attribute's value when it's a plain string
// literal (NOT an interpolation). Used for wx:for-item / wx:for-index where
// the value is a bare name like "user". Handles both quoted ("user") and
// unquoted (user) forms — tree-sitter-wxml exposes them as distinct nodes.
function quotedAttrTextValue(attrNode) {
  const quoted = firstChildOfType(attrNode, "quoted_attribute_value");
  if (quoted) {
    for (let i = 0; i < quoted.namedChildCount; i++) {
      if (quoted.namedChild(i).type === "interpolation") return null;
    }
    const text = quoted.text;
    if (text.length >= 2 && (text[0] === '"' || text[0] === "'")) {
      return text.slice(1, -1);
    }
    return text;
  }
  const unquoted = firstChildOfType(attrNode, "attribute_value");
  if (unquoted) {
    return unquoted.text;
  }
  return null;
}

function byPosition(a, b) {
  const ar = a.range.start, br = b.range.start;
  return (ar.row - br.row) || (ar.column - br.column);
}

function collectFile(tree, inputAbs) {
  const dependencies = [];
  const symbols = [];
  const references = [];
  const components = [];
  const eventHandlers = [];
  const expressionRefs = [];
  const wxForItems = new Set();
  const wxForIndexes = new Set();
  let hasAnyWxFor = false;
  // Track depth inside `<template name="X">...</template>` nodes. Expressions
  // inside a template definition resolve in the caller's data scope at use
  // time (via `<template is="X" data="{{...}}"/>`), NOT in the file's own
  // sibling .js data — so the diagnostic must skip them.
  let templateDefinitionDepth = 0;

  const walk = (node) => {
    const isTemplateDef = node.type === "template_definition";
    if (isTemplateDef) templateDefinitionDepth += 1;

    if (node.type === "interpolation") {
      const exprNode = firstChildOfType(node, "expression");
      if (exprNode) {
        const exprText = exprNode.text;
        const exprStartRow = exprNode.startPosition.row;
        const exprStartCol = exprNode.startPosition.column;
        const exprRange = rangeOf(exprNode);
        const inTemplateDefinition = templateDefinitionDepth > 0;
        for (const { name, offset } of topLevelIdentifiers(exprText)) {
          const { rowDelta, columnOfRow } = offsetToPositionWithin(exprText, offset);
          const startRow = exprStartRow + rowDelta;
          const startCol = rowDelta === 0 ? exprStartCol + columnOfRow : columnOfRow;
          expressionRefs.push({
            name,
            source: "interpolation",
            inTemplateDefinition,
            range: {
              start: { row: startRow, column: startCol },
              end: { row: startRow, column: startCol + name.length },
            },
            expressionRange: exprRange,
          });
        }
      }
    }
    if (node.type === "attribute") {
      // Event-handler attribute? Detect via prefix regex on attribute_name.
      const nameNode = firstChildOfType(node, "attribute_name");
      if (nameNode) {
        const attrName = nameNode.text;
        const matched = matchEventBinding(attrName);
        if (matched) {
          const valueNode = firstChildOfType(node, "quoted_attribute_value")
            ?? firstChildOfType(node, "attribute_value");
          if (valueNode) {
            const handler = attributeRawValue(node) ?? "";
            eventHandlers.push({
              event: matched.event,
              handler,
              binding: matched.binding,
              dynamic: handler.includes("{{"),
              range: rangeOf(node),
              nameRange: innerValueRange(valueNode),
            });
          }
        }
        // wx:for / wx:for-item / wx:for-index — value-side scope plumbing.
        // Expression values inside wx:for / wx:if / wx:elif are surfaced via
        // the interpolation walker above; we only need plain-string handling
        // here for the binding-name attributes.
        if (attrName === "wx:for") {
          hasAnyWxFor = true;
        } else if (attrName === "wx:for-item") {
          const v = quotedAttrTextValue(node);
          if (typeof v === "string" && v.length > 0) wxForItems.add(v);
        } else if (attrName === "wx:for-index") {
          const v = quotedAttrTextValue(node);
          if (typeof v === "string" && v.length > 0) wxForIndexes.add(v);
        }
      }
    }
    if (node.type === "import_statement" || node.type === "include_statement") {
      const kind = node.type === "import_statement" ? "import" : "include";
      const srcAttr = findAnyAttribute(node, "src");
      const value = srcAttr ? attributeRawValue(srcAttr) : undefined;
      if (value !== undefined) {
        const entry = { kind, value, range: rangeOf(node) };
        const normalized = normalizeDependency(inputAbs, value);
        if (normalized) entry.normalized = normalized;
        dependencies.push(entry);
      }
    } else if (node.type === "wxs_external") {
      const inner = firstChildOfType(node, "wxs_external_self_closing_tag") ?? node;
      const moduleAttr = findAttributeByName(inner, "wxs_module_attribute", "module")
        ?? findAnyAttribute(inner, "module");
      const srcAttr = findAttributeByName(inner, "wxs_src_attribute", "src")
        ?? findAnyAttribute(inner, "src");
      const moduleValue = moduleAttr ? attributeRawValue(moduleAttr) : undefined;
      const srcValue = srcAttr ? attributeRawValue(srcAttr) : undefined;
      if (srcValue !== undefined) {
        const entry = { kind: "wxs", value: srcValue, range: rangeOf(node) };
        const normalized = normalizeDependency(inputAbs, srcValue);
        if (normalized) entry.normalized = normalized;
        if (moduleValue !== undefined) entry.module = moduleValue;
        dependencies.push(entry);
      }
      if (moduleValue !== undefined) {
        symbols.push({ kind: "wxs", name: moduleValue, range: rangeOf(node) });
      }
    } else if (node.type === "wxs_inline") {
      const startTag = firstChildOfType(node, "wxs_inline_start_tag");
      const moduleAttr = startTag
        ? (findAttributeByName(startTag, "wxs_module_attribute", "module") ?? findAnyAttribute(startTag, "module"))
        : null;
      const moduleValue = moduleAttr ? attributeRawValue(moduleAttr) : undefined;
      if (moduleValue !== undefined) {
        symbols.push({ kind: "wxs", name: moduleValue, range: rangeOf(node) });
      }
    } else if (node.type === "template_definition") {
      const startTag = firstChildOfType(node, "template_definition_start_tag");
      const nameAttr = startTag
        ? (findAttributeByName(startTag, "template_name_attribute", "name") ?? findAnyAttribute(startTag, "name"))
        : null;
      const nameValue = nameAttr ? attributeRawValue(nameAttr) : undefined;
      if (nameValue !== undefined) {
        symbols.push({ kind: "template", name: nameValue, range: rangeOf(node) });
      }
    } else if (node.type === "template_usage") {
      const tag = firstChildOfType(node, "template_usage_self_closing_tag")
        ?? firstChildOfType(node, "template_usage_start_tag")
        ?? node;
      const isAttr = findAttributeByName(tag, "template_is_attribute", "is")
        ?? findAnyAttribute(tag, "is");
      if (isAttr) {
        const raw = attributeRawValue(isAttr) ?? "";
        const dynamic = raw.includes("{{");
        const entry = { kind: "template", dynamic, raw, range: rangeOf(node) };
        if (!dynamic) entry.name = raw;
        references.push(entry);
      }
    } else if (node.type === "element") {
      const tag = firstChildOfType(node, "start_tag") ?? firstChildOfType(node, "self_closing_tag");
      if (tag) {
        const name = firstChildOfType(tag, "tag_name")?.text;
        if (name && name.includes("-") && !CONTROL_TAGS.has(name) && !BUILTIN_TAGS.has(name)) {
          components.push({ tag: name, range: rangeOf(node) });
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));

    if (isTemplateDef) templateDefinitionDepth -= 1;
  };
  walk(tree.rootNode);

  dependencies.sort(byPosition);
  symbols.sort(byPosition);
  references.sort(byPosition);
  components.sort(byPosition);
  eventHandlers.sort(byPosition);
  expressionRefs.sort(byPosition);

  return {
    dependencies,
    symbols,
    references,
    components,
    eventHandlers,
    expressionRefs,
    wxForBindings: {
      items: [...wxForItems].sort(),
      indexes: [...wxForIndexes].sort(),
      hasAnyWxFor,
    },
  };
}

async function extractFile(parser, filePath) {
  const totalStart = performance.now();
  const inputAbs = path.resolve(filePath);
  const inputRel = relativePathFromRoot(inputAbs);

  const readStart = performance.now();
  const source = await fs.readFile(inputAbs, "utf8");
  const readMs = elapsedMs(readStart);

  const cstStart = performance.now();
  const tree = parser.parse(source);
  const cstMs = elapsedMs(cstStart);

  const extractStart = performance.now();
  const { dependencies, symbols, references, components, eventHandlers, expressionRefs, wxForBindings } = collectFile(tree, inputAbs);
  const extractMs = elapsedMs(extractStart);

  profileEvent({
    type: "symbol-file",
    path: inputRel,
    readMs,
    cstMs,
    parseMs: 0,
    extractMs,
    totalMs: elapsedMs(totalStart),
  });

  return { path: inputRel, dependencies, symbols, references, components, eventHandlers, expressionRefs, wxForBindings };
}

async function main() {
  const inputFiles = process.argv.slice(2);
  if (inputFiles.length === 0) {
    process.stderr.write("Usage: node scripts/extract-wxml-symbols.mjs <file.wxml> [...file.wxml]\n");
    process.exit(2);
  }

  const totalStart = performance.now();

  await Parser.init();
  const language = await Language.load(WASM);
  const parser = new Parser();
  parser.setLanguage(language);

  const files = [];
  for (const file of inputFiles) {
    files.push(await extractFile(parser, file));
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  profileEvent({
    type: "symbol-total",
    fileCount: inputFiles.length,
    totalMs: elapsedMs(totalStart),
  });

  process.stdout.write(`${JSON.stringify({ version: 1, files }, null, 2)}\n`);
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`FAIL: ${err?.message || err}\n`);
    process.exit(1);
  });
}
