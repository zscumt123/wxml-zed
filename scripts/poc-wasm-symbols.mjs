#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { Parser, Language } from "web-tree-sitter";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WASM = path.join(ROOT, "grammar/tree-sitter-wxml/tree-sitter-wxml.wasm");

const RESERVED_TAGS = new Set(["template", "slot", "block", "import", "include", "wxs"]);

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

function* childrenOfType(node, type) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === type) yield child;
  }
}

function unquote(text) {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function attributeRawValue(attributeNode) {
  const valueNode = firstChildOfType(attributeNode, "quoted_attribute_value")
    ?? firstChildOfType(attributeNode, "attribute_value");
  if (!valueNode) return undefined;
  return unquote(valueNode.text);
}

function attributeIsDynamic(attributeNode) {
  const valueNode = firstChildOfType(attributeNode, "quoted_attribute_value")
    ?? firstChildOfType(attributeNode, "attribute_value");
  if (!valueNode) return false;
  for (let i = 0; i < valueNode.namedChildCount; i++) {
    if (valueNode.namedChild(i).type === "interpolation") return true;
  }
  return false;
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

function tagNameOf(elementNode) {
  const tag = firstChildOfType(elementNode, "start_tag")
    ?? firstChildOfType(elementNode, "self_closing_tag")
    ?? firstChildOfType(elementNode, "template_definition_start_tag");
  if (!tag) return null;
  return firstChildOfType(tag, "tag_name")?.text ?? null;
}

function collectComponents(rootNode) {
  const out = [];
  const walk = (node) => {
    if (node.type === "element") {
      const tag = firstChildOfType(node, "start_tag") ?? firstChildOfType(node, "self_closing_tag");
      if (tag) {
        const name = firstChildOfType(tag, "tag_name")?.text;
        if (name && name.includes("-") && !RESERVED_TAGS.has(name)) {
          out.push({ tag: name, range: rangeOf(node) });
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
  };
  walk(rootNode);
  return out;
}

function collectDependenciesAndSymbols(rootNode, inputAbs) {
  const dependencies = [];
  const symbols = [];

  const walk = (node) => {
    if (node.type === "import_statement" || node.type === "include_statement") {
      const kind = node.type === "import_statement" ? "import" : "include";
      const srcAttr = findAnyAttribute(node, "src");
      const value = srcAttr ? attributeRawValue(srcAttr) : undefined;
      if (value !== undefined) {
        const normalized = path.relative(
          process.cwd(),
          path.resolve(path.dirname(inputAbs), value),
        );
        dependencies.push({ kind, value, range: rangeOf(node), normalized });
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
        const normalized = path.relative(
          process.cwd(),
          path.resolve(path.dirname(inputAbs), srcValue),
        );
        const entry = { kind: "wxs", value: srcValue, range: rangeOf(node), normalized };
        if (moduleValue !== undefined) entry.module = moduleValue;
        dependencies.push(entry);
      }
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
    }
    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
  };
  walk(rootNode);
  return { dependencies, symbols };
}

function collectReferences(rootNode) {
  const out = [];
  const walk = (node) => {
    if (node.type === "template_usage") {
      const tag = firstChildOfType(node, "template_usage_self_closing_tag")
        ?? firstChildOfType(node, "template_usage_start_tag")
        ?? node;
      const isAttr = findAttributeByName(tag, "template_is_attribute", "is")
        ?? findAnyAttribute(tag, "is");
      if (isAttr) {
        const raw = attributeRawValue(isAttr) ?? "";
        const dynamic = attributeIsDynamic(isAttr);
        const entry = {
          kind: "template",
          dynamic,
          raw,
          range: rangeOf(node),
        };
        entry.name = dynamic ? raw : raw;
        out.push(entry);
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
  };
  walk(rootNode);
  return out;
}

function byPosition(a, b) {
  const ar = a.range.start, br = b.range.start;
  if (ar.row !== br.row) return ar.row - br.row;
  return ar.column - br.column;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node scripts/poc-wasm-symbols.mjs <file.wxml> [<file2.wxml> ...]");
    process.exit(1);
  }

  await Parser.init();
  const language = await Language.load(WASM);
  const parser = new Parser();
  parser.setLanguage(language);

  const files = [];
  for (const arg of args) {
    const inputAbs = path.resolve(process.cwd(), arg);
    const inputRel = path.relative(process.cwd(), inputAbs);
    const source = await fs.readFile(inputAbs, "utf8");
    const tree = parser.parse(source);

    const { dependencies, symbols } = collectDependenciesAndSymbols(tree.rootNode, inputAbs);
    const references = collectReferences(tree.rootNode);
    const components = collectComponents(tree.rootNode);

    dependencies.sort(byPosition);
    symbols.sort(byPosition);
    references.sort(byPosition);
    components.sort(byPosition);

    files.push({ path: inputRel, dependencies, symbols, references, components });
  }

  console.log(JSON.stringify({ version: 1, files }, null, 2));
}

main().catch((err) => {
  console.error("FAIL:", err?.message || err);
  process.exit(1);
});
