import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_TAGS } from "./wxml-builtins.mjs";
import { matchEventBinding } from "./event-binding-patterns.mjs";
import { topLevelIdentifiers } from "./wxml-expression-helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  return {
    start: { row: quotedValueNode.startPosition.row, column: quotedValueNode.startPosition.column },
    end:   { row: quotedValueNode.endPosition.row,   column: quotedValueNode.endPosition.column },
  };
}

export function toPosix(p) {
  return p.split(path.sep).join(path.posix.sep);
}

export function relativePathFromRoot(filePath) {
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

export function collectFile(tree, inputAbs) {
  const dependencies = [];
  const symbols = [];
  const references = [];
  const components = [];
  const eventHandlers = [];
  const expressionRefs = [];
  // wxForScopes: real per-element loop scopes (one entry per element with wx:for).
  const wxForScopes = [];
  // Loose accumulators preserve the legacy quirk where wx:for-item /
  // wx:for-index without wx:for still leaks into wxForBindings.items /
  // .indexes. Not surfaced in the public schema; only used to derive the
  // compat shim. Will be removed when wxForBindings itself is retired.
  const wxForLooseItems = new Set();
  const wxForLooseIndexes = new Set();
  // Track depth inside `<template name="X">...</template>` nodes. Expressions
  // inside a template definition resolve in the caller's data scope at use
  // time (via `<template is="X" data="{{...}}"/>`), NOT in the file's own
  // sibling .js data — so the diagnostic must skip them.
  let templateDefinitionDepth = 0;
  // Track nearest enclosing element tag name and attribute name during the
  // walk. expressionRef entries pick up the top of each stack so diagnostics
  // can distinguish text-node interpolations (containingAttribute=null) from
  // component-tag prop bindings (containingAttribute=<name>). containingTag
  // is populated for ALL interpolations inside a valid WXML element —
  // including text nodes — so future Hover/Definition features have the
  // enclosing context to leverage.
  const elementStack = [];
  const attributeStack = [];

  const walk = (node) => {
    const isTemplateDef = node.type === "template_definition";
    if (isTemplateDef) templateDefinitionDepth += 1;

    let pushedElement = false;
    let pushedAttribute = false;
    if (node.type === "element") {
      const tag = firstChildOfType(node, "start_tag") ?? firstChildOfType(node, "self_closing_tag");
      const tagName = tag ? (firstChildOfType(tag, "tag_name")?.text ?? null) : null;
      elementStack.push(tagName);
      pushedElement = true;
    } else if (node.type === "attribute") {
      const nameNode = firstChildOfType(node, "attribute_name");
      attributeStack.push(nameNode?.text ?? null);
      pushedAttribute = true;
    }

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
            containingTag: elementStack.length > 0 ? elementStack[elementStack.length - 1] : null,
            containingAttribute: attributeStack.length > 0 ? attributeStack[attributeStack.length - 1] : null,
          });
        }
      }
    }
    if (node.type === "attribute") {
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
        const entry = { kind: "wxs", name: moduleValue, range: rangeOf(node) };
        const moduleValueNode = moduleAttr
          ? (firstChildOfType(moduleAttr, "quoted_attribute_value")
             ?? firstChildOfType(moduleAttr, "attribute_value"))
          : null;
        if (moduleValueNode) entry.nameRange = innerValueRange(moduleValueNode);
        symbols.push(entry);
      }
    } else if (node.type === "wxs_inline") {
      const startTag = firstChildOfType(node, "wxs_inline_start_tag");
      const moduleAttr = startTag
        ? (findAttributeByName(startTag, "wxs_module_attribute", "module") ?? findAnyAttribute(startTag, "module"))
        : null;
      const moduleValue = moduleAttr ? attributeRawValue(moduleAttr) : undefined;
      if (moduleValue !== undefined) {
        const entry = { kind: "wxs", name: moduleValue, range: rangeOf(node) };
        const moduleValueNode = moduleAttr
          ? (firstChildOfType(moduleAttr, "quoted_attribute_value")
             ?? firstChildOfType(moduleAttr, "attribute_value"))
          : null;
        if (moduleValueNode) entry.nameRange = innerValueRange(moduleValueNode);
        symbols.push(entry);
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
    } else if (node.type === "element" || node.type === "block_element") {
      const tag = firstChildOfType(node, "start_tag")
        ?? firstChildOfType(node, "self_closing_tag")
        ?? firstChildOfType(node, "block_start_tag");
      if (tag) {
        const tagNameNode = firstChildOfType(tag, "tag_name");
        const name = tagNameNode?.text;

        // wx:for scope extraction (independent of component check).
        const wxForAttr = findAnyAttribute(tag, "wx:for");
        const wxForItemAttr = findAnyAttribute(tag, "wx:for-item");
        const wxForIndexAttr = findAnyAttribute(tag, "wx:for-index");
        if (wxForAttr) {
          // Scope creation gates ONLY on wx:for attribute presence. The
          // legacy extractor sets hasAnyWxFor = true for bare `wx:for`
          // (no value); we must preserve that by creating a scope record
          // with defaults regardless of whether wx:for has a value.
          //
          // IMPORTANT: read item/index names with quotedAttrTextValue (NOT
          // attributeRawValue). The legacy helper returns null when the
          // quoted value contains an `interpolation` child — this is the
          // gate that keeps dynamic names like wx:for-item="{{dyn}}" out
          // of the explicit-binding path. Using attributeRawValue would
          // leak the literal "{{dyn}}" into wxForBindings.items and
          // break W-7 byte-equal. Locked by S-F7.
          const itemRaw = wxForItemAttr ? quotedAttrTextValue(wxForItemAttr) : undefined;
          const indexRaw = wxForIndexAttr ? quotedAttrTextValue(wxForIndexAttr) : undefined;
          const itemValueNode = wxForItemAttr
            ? (firstChildOfType(wxForItemAttr, "quoted_attribute_value")
               ?? firstChildOfType(wxForItemAttr, "attribute_value"))
            : null;
          const indexValueNode = wxForIndexAttr
            ? (firstChildOfType(wxForIndexAttr, "quoted_attribute_value")
               ?? firstChildOfType(wxForIndexAttr, "attribute_value"))
            : null;

          const itemExplicit = typeof itemRaw === "string" && itemRaw.length > 0;
          const indexExplicit = typeof indexRaw === "string" && indexRaw.length > 0;

          // Narrow range over the `wx:for` attribute-NAME token (e.g. the
          // literal `wx:for`), used as the definition target for implicit
          // item/index which have no explicit name attribute. Must NOT be
          // rangeOf(wxForAttr) — that is the whole `wx:for="{{...}}"` attribute
          // (already stored as wxForRange). Null-safe for grammar edge cases.
          // Note: for a bare `wx:for` (no `="..."` value) this coincides with
          // wxForRange, since the attribute node then spans only the keyword token.
          const wxForKeywordNode = firstChildOfType(wxForAttr, "attribute_name");

          wxForScopes.push({
            scopeRange: rangeOf(node),
            wxForRange: rangeOf(wxForAttr),
            wxForKeywordRange: wxForKeywordNode ? rangeOf(wxForKeywordNode) : null,
            itemName: itemExplicit ? itemRaw : "item",
            itemNameRange: itemExplicit && itemValueNode ? innerValueRange(itemValueNode) : null,
            itemSource: itemExplicit ? "explicit" : "implicit",
            indexName: indexExplicit ? indexRaw : "index",
            indexNameRange: indexExplicit && indexValueNode ? innerValueRange(indexValueNode) : null,
            indexSource: indexExplicit ? "explicit" : "implicit",
            ownerTag: name ?? null,  // null on grammar error-recovery (missing tag_name)
          });
        } else {
          // Loose wx:for-item / wx:for-index (no wx:for on this element).
          // Preserve legacy behavior verbatim: same quotedAttrTextValue
          // helper (interpolation values return null and don't leak)
          // and same `length > 0` gate. Feed into loose accumulators
          // for the compat shim only; do NOT create a scope.
          if (wxForItemAttr) {
            const v = quotedAttrTextValue(wxForItemAttr);
            if (typeof v === "string" && v.length > 0) wxForLooseItems.add(v);
          }
          if (wxForIndexAttr) {
            const v = quotedAttrTextValue(wxForIndexAttr);
            if (typeof v === "string" && v.length > 0) wxForLooseIndexes.add(v);
          }
        }

        // Existing custom-component extraction (preserved).
        if (name && name.includes("-") && !CONTROL_TAGS.has(name) && !BUILTIN_TAGS.has(name)) {
          const entry = { tag: name, range: rangeOf(node) };
          if (tagNameNode) entry.tagNameRange = rangeOf(tagNameNode);
          components.push(entry);
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));

    if (isTemplateDef) templateDefinitionDepth -= 1;
    if (pushedElement) elementStack.pop();
    if (pushedAttribute) attributeStack.pop();
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
    wxForScopes,
    /** @deprecated compatibility shim derived from wxForScopes plus loose-attr accumulators;
     * new code should consume wxForScopes directly.
     * Legacy compat shim. As of v2-C no runtime consumer reads this (completion
     * migrated in v2-B, diagnostics in v2-C); only verify-wxml-narrow-ranges' W-7
     * byte-equal invariant still asserts it. Retire in a dedicated later round. */
    wxForBindings: (() => {
      const explicitItems = wxForScopes
        .filter((s) => s.itemSource === "explicit")
        .map((s) => s.itemName);
      const explicitIndexes = wxForScopes
        .filter((s) => s.indexSource === "explicit")
        .map((s) => s.indexName);
      return {
        items: [...new Set([...explicitItems, ...wxForLooseItems])].sort(),
        indexes: [...new Set([...explicitIndexes, ...wxForLooseIndexes])].sort(),
        hasAnyWxFor: wxForScopes.length > 0,
      };
    })(),
  };
}
