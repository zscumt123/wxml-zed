import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BUILTIN_TAG_NAMES } from "../shared/wxml-builtins.mjs";
import { isEventHandlerCompletionTrigger } from "../shared/event-binding-patterns.mjs";
import { METHOD_KIND_COMPONENT_LIFECYCLE } from "../shared/js-method-extractor.mjs";
import {
  looksLikeObjectLiteralExpression,
  stripStringLiterals,
} from "../shared/wxml-expression-helpers.mjs";

const WARNING = 2;
const INFORMATION = 3;

// Attribute names that have special WXML semantics (control flow, runtime,
// styling) and are NOT custom prop bindings on child components. When an
// expressionRef appears inside one of these, the cross-component prop
// binding rule does NOT apply — fall through to the existing
// missing-expression-ref check unchanged.
const RESERVED_ATTRIBUTES = new Set([
  "wx:if", "wx:elif", "wx:else",
  "wx:for", "wx:for-item", "wx:for-index", "wx:key",
  "class", "style", "id", "slot", "hidden",
]);

// Attribute name prefixes that carry WXML semantics other than custom prop
// binding (event bindings, custom data attrs, generic-type slots). Matched
// by startsWith — these are reserved regardless of the suffix.
// Note: only the colon forms are listed for the event-binding prefixes
// (bind:tap, catch:tap, etc.). The no-colon forms (bindtap, catchtap,
// capture-bindtap, capture-catchtap, mut-bindtap) conventionally take
// a string method name, not a `{{...}}` interpolation, so they don't
// produce expressionRefs that would reach the dead-component-binding
// check. If the no-colon form ever appears with an expression, it
// falls through to missing-expression-ref — acceptable since the
// no-colon form is rare in modern WeChat code.
const RESERVED_ATTRIBUTE_PREFIXES = [
  "bind:", "catch:", "mut-bind:", "capture-bind:", "capture-catch:",
  "data-", "generic:",
  "model:", // two-way binding on a child component's property
];

function isReservedAttribute(name) {
  if (RESERVED_ATTRIBUTES.has(name)) return true;
  for (const prefix of RESERVED_ATTRIBUTE_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

const DOCUMENT_SYMBOL_KIND_FILE = 1;
const DOCUMENT_SYMBOL_KIND_MODULE = 2;
const DOCUMENT_SYMBOL_KIND_FUNCTION = 12;
const COMPLETION_ITEM_KIND_FUNCTION = 3;
const COMPLETION_ITEM_KIND_CLASS = 7;
const COMPLETION_ITEM_KIND_PROPERTY = 10;

const COMMON_ATTRIBUTE_NAMES = [
  "wx:if",
  "wx:elif",
  "wx:else",
  "wx:for",
  "wx:for-item",
  "wx:for-index",
  "wx:key",
  "class",
  "style",
  "id",
  "bindtap",
  "catchtap",
  "capture-bind:tap",
  "capture-catch:tap",
  "generic:selectable",
];

const ZERO_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

function toPosix(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

export function graphPathForAbsolute(filePath, extensionRoot) {
  return toPosix(path.relative(extensionRoot, path.resolve(filePath)));
}

export function absolutePathForGraphPath(graphPath, extensionRoot) {
  return path.resolve(extensionRoot, graphPath);
}

export function rangeFromSymbolRange(range) {
  return {
    start: {
      line: range.start.row,
      character: range.start.column,
    },
    end: {
      line: range.end.row,
      character: range.end.column,
    },
  };
}

function isPositionBefore(position, boundary) {
  return (
    position.line < boundary.line ||
    (position.line === boundary.line && position.character < boundary.character)
  );
}

function isPositionAtOrAfter(position, boundary) {
  return (
    position.line > boundary.line ||
    (position.line === boundary.line && position.character >= boundary.character)
  );
}

function symbolPointToLsp(point) {
  return {
    line: point.row,
    character: point.column,
  };
}

export function containsPosition(range, position) {
  const start = symbolPointToLsp(range.start);
  const end = symbolPointToLsp(range.end);
  return isPositionAtOrAfter(position, start) && isPositionBefore(position, end);
}

function rangeKey(range) {
  return `${range.start.row}:${range.start.column}-${range.end.row}:${range.end.column}`;
}

// @internal — exported only for sibling server/wxml-*.mjs modules; not part of
// the public LSP-host import surface (use getHover/getDefinition/etc instead).
export function findWxmlFileModel(graph, documentPath, extensionRoot) {
  const documentGraphPath = graphPathForAbsolute(documentPath, extensionRoot);
  const fileModel = graph.wxml.find((entry) => entry.path === documentGraphPath);
  return { documentGraphPath, fileModel };
}

function locationForGraphPath(graphPath, extensionRoot) {
  return {
    uri: pathToFileURL(absolutePathForGraphPath(graphPath, extensionRoot)).href,
    range: ZERO_RANGE,
  };
}

function locationForGraphPathWithRange(graphPath, range, extensionRoot) {
  return {
    uri: pathToFileURL(absolutePathForGraphPath(graphPath, extensionRoot)).href,
    range: rangeFromSymbolRange(range),
  };
}

// @internal — exported only for sibling server/wxml-*.mjs modules.
export function isInsideGraphRoot(graphPath, graphRoot) {
  const relative = path.posix.relative(graphRoot, graphPath);
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

function hasUnresolvedWxmlDependency(graph, owner, dependency) {
  return graph.unresolved.some((entry) => (
    entry.kind === "wxml-dependency" &&
    entry.owner === owner &&
    entry.target === dependency.normalized
  ));
}

function isKnownWxmlTarget(graph, target) {
  return graph.wxml.some((entry) => entry.path === target);
}

function isExistingWxsTarget(target, extensionRoot) {
  return fs.existsSync(absolutePathForGraphPath(target, extensionRoot));
}

function dependencyTargetForDefinition(graph, owner, dependency, extensionRoot) {
  if (!dependency.normalized) {
    return undefined;
  }
  if (!isInsideGraphRoot(dependency.normalized, graph.root)) {
    return undefined;
  }

  if ((dependency.kind === "import" || dependency.kind === "include") && dependency.normalized.endsWith(".wxml")) {
    if (hasUnresolvedWxmlDependency(graph, owner, dependency)) {
      return undefined;
    }
    return isKnownWxmlTarget(graph, dependency.normalized) ? dependency.normalized : undefined;
  }

  if (dependency.kind === "wxs" && dependency.normalized.endsWith(".wxs")) {
    return isExistingWxsTarget(dependency.normalized, extensionRoot) ? dependency.normalized : undefined;
  }

  return undefined;
}

function dependencyDefinitionForPosition({ graph, documentGraphPath, fileModel, position, extensionRoot }) {
  const dependency = fileModel.dependencies.find((entry) => containsPosition(entry.range, position));
  if (!dependency) {
    return null;
  }

  const target = dependencyTargetForDefinition(graph, documentGraphPath, dependency, extensionRoot);
  if (!target) {
    return null;
  }

  return locationForGraphPath(target, extensionRoot);
}

function templateDefinitionsInFile(fileModel, name) {
  return fileModel.symbols
    .filter((symbol) => symbol.kind === "template" && symbol.name === name)
    .map((symbol) => ({ fileModel, symbol }));
}

function directTemplateDependencyFiles(graph, fileModel) {
  const filesByPath = new Map(graph.wxml.map((entry) => [entry.path, entry]));
  const seen = new Set();
  const files = [];

  for (const dependency of fileModel.dependencies) {
    if (dependency.kind !== "import" && dependency.kind !== "include") continue;
    if (typeof dependency.normalized !== "string") continue;
    if (seen.has(dependency.normalized)) continue;

    const dependencyFile = filesByPath.get(dependency.normalized);
    if (!dependencyFile) continue;

    seen.add(dependency.normalized);
    files.push(dependencyFile);
  }

  return files;
}

function visibleTemplateDefinitions(graph, fileModel, name) {
  const localMatches = templateDefinitionsInFile(fileModel, name);
  if (localMatches.length > 0) {
    return localMatches;
  }

  return directTemplateDependencyFiles(graph, fileModel)
    .flatMap((dependencyFile) => templateDefinitionsInFile(dependencyFile, name));
}

function lineTextAt(sourceText, line) {
  const lines = sourceText.split("\n");
  return lines[line];
}

function offsetAt(sourceText, position) {
  if (!position || typeof position.line !== "number" || typeof position.character !== "number") {
    return undefined;
  }
  const lines = sourceText.split("\n");
  if (position.line < 0 || position.line >= lines.length) return undefined;
  if (position.character < 0 || position.character > lines[position.line].length) return undefined;

  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    offset += lines[line].length + 1;
  }
  return offset + position.character;
}

function isInsideDelimitedRange(sourceText, offset, open, close) {
  const before = sourceText.slice(0, offset);
  const start = before.lastIndexOf(open);
  if (start === -1) return false;
  const end = before.lastIndexOf(close);
  return end < start;
}

function isInsideInlineWxsRawText(sourceText, offset) {
  const before = sourceText.slice(0, offset);
  const start = before.lastIndexOf("<wxs");
  if (start === -1) return false;
  const end = before.lastIndexOf("</wxs>");
  const openEnd = before.indexOf(">", start);
  if (openEnd === -1 || end > start) return false;
  const openTag = before.slice(start, openEnd + 1);
  return !/\/>\s*$/u.test(openTag);
}

function isInsideRawTextOrComment(sourceText, offset) {
  // Comments and inline <wxs> raw text never accept completions.
  // The {{...}} interpolation case used to be excluded here too, but
  // moved out — data-ref completion now handles inside-{{...}} positions.
  return (
    isInsideDelimitedRange(sourceText, offset, "<!--", "-->") ||
    isInsideInlineWxsRawText(sourceText, offset)
  );
}

function currentLinePrefix(sourceText, position) {
  const line = lineTextAt(sourceText, position.line);
  if (typeof line !== "string") return undefined;
  return line.slice(0, position.character);
}

function contextRange(position, startCharacter) {
  return {
    start: { line: position.line, character: startCharacter },
    end: { line: position.line, character: position.character },
  };
}

function tagNameContext(sourceText, position) {
  const prefix = currentLinePrefix(sourceText, position);
  if (typeof prefix !== "string") return undefined;

  const match = prefix.match(/<([A-Za-z][\w-]*)?$/u);
  if (!match) return undefined;
  if (prefix.endsWith("</")) return undefined;

  const typed = match[1] || "";
  return {
    type: "tag",
    typed,
    range: contextRange(position, position.character - typed.length),
  };
}

function attributeContext(sourceText, position) {
  const prefix = currentLinePrefix(sourceText, position);
  if (typeof prefix !== "string") return undefined;
  const openIndex = prefix.lastIndexOf("<");
  if (openIndex === -1 || prefix.slice(openIndex).startsWith("</")) return undefined;
  const tagContent = prefix.slice(openIndex + 1);
  if (!/^[A-Za-z][\w-]*(?:\s|$)/u.test(tagContent)) return undefined;

  const quoteCount = (tagContent.match(/["']/gu) || []).length;
  if (quoteCount % 2 === 1) return undefined;

  const attrMatch = tagContent.match(/(?:^|\s)([\w:-]*)$/u);
  if (!attrMatch) return undefined;
  const typed = attrMatch[1] || "";
  const startCharacter = position.character - typed.length;
  if (startCharacter <= openIndex + 1) return undefined;

  return {
    type: "attribute",
    typed,
    range: contextRange(position, startCharacter),
  };
}

// Hot-path bound: getCompletions fires per keystroke. A full
// `sourceText.slice(0, offset)` would allocate the entire file prefix every
// call. 4KB covers any realistic multi-line opening tag — if `<` is further
// back than this, the cursor is not inside an opening tag.
const HANDLER_VALUE_SCAN_BACK = 4096;

function eventHandlerValueContext(sourceText, position) {
  // Multi-line aware: WXML opens like `<user-card\n  bind:select="..."` are
  // common. Walk back through the bounded slice ending at the cursor to find
  // the nearest unterminated `<` (with no unquoted `>` between it and the
  // cursor).
  const offset = offsetAt(sourceText, position);
  if (offset === undefined) return undefined;
  const scanStart = Math.max(0, offset - HANDLER_VALUE_SCAN_BACK);
  const slice = sourceText.slice(scanStart, offset);
  const openIndex = slice.lastIndexOf("<");
  if (openIndex === -1) return undefined;
  if (slice.slice(openIndex, openIndex + 2) === "</") return undefined;

  // Reject if any `>` outside an attribute-value quote appears between the
  // `<` and the cursor — that would mean the tag was already closed.
  const tagSlice = slice.slice(openIndex);
  let inQuote = null;
  for (let i = 1; i < tagSlice.length; i += 1) {
    const ch = tagSlice[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ">") {
      return undefined;
    }
  }

  // tag-name guard: same shape as `attributeContext` requires.
  const tagContent = tagSlice.slice(1);
  if (!/^[A-Za-z][\w-]*(?:\s|$)/u.test(tagContent)) return undefined;

  const match = tagContent.match(/\s([\w:-]+)=(["'])([^"'<>]*)$/u);
  if (!match) return undefined;

  const attrName = match[1];
  if (!isEventHandlerCompletionTrigger(attrName)) return undefined;

  const typed = match[3];
  // textEdit.range assumes typed lives on the cursor's line. If the user
  // typed a newline mid-value, give up rather than emit a bogus range.
  if (typed.includes("\n")) return undefined;

  const startCharacter = position.character - typed.length;
  return {
    type: "event-handler-value",
    typed,
    range: contextRange(position, startCharacter),
  };
}

function isCursorInsideTemplateDefinitionBody(sourceText, offset) {
  // Source-text walk (NOT graph-based): completion fires on every keystroke
  // against the current buffer, but the graph only rebuilds on save. If a
  // user types a new `<template name="X">...</template>` in an unsaved
  // buffer, fileModel.symbols wouldn't include it yet — so we'd leak owner
  // data candidates into the template body. Reading sourceText directly
  // makes the check live with the buffer.
  //
  // A two-regex count would mis-handle comments (`<!-- <template name=X> -->`
  // would false-bump depth, `<!-- </template> -->` inside a real definition
  // would false-decrement) and attribute values containing tag-like text
  // (`<view data="<template name=fake>">` would false-bump). Use a forward
  // state machine instead: skip past comments, respect attribute-value
  // quoting, count only real opening `<template name=>` and `</template>`,
  // and ignore self-closing template definitions (they don't introduce a
  // body that can wrap the cursor).
  let i = 0;
  let depth = 0;
  while (i < offset) {
    // HTML comment — skip past closing `-->`.
    if (sourceText.startsWith("<!--", i)) {
      const end = sourceText.indexOf("-->", i + 4);
      i = end === -1 ? offset : end + 3;
      continue;
    }
    // Opening `<template ...>` — check it's a definition (has name= attribute)
    // and not self-closing before adjusting depth.
    if (
      sourceText.startsWith("<template", i)
      && i + 9 < sourceText.length
      && /[\s>/]/.test(sourceText[i + 9])
    ) {
      const tagEnd = findUnquotedGreaterThan(sourceText, i + 9);
      if (tagEnd === -1) break;
      const tagText = sourceText.slice(i, tagEnd + 1);
      const isSelfClosing = tagText[tagText.length - 2] === "/";
      // `\b` would match `data-name=` (boundary at the dash). Require an
      // attribute boundary — start of string or whitespace — before `name`
      // so suffix-match attributes (`data-name`, `foo-name`) don't false-
      // trigger template-definition suppression.
      const isDefinition = /(?:^|\s)name\s*=/u.test(tagText);
      if (isDefinition && !isSelfClosing) depth += 1;
      i = tagEnd + 1;
      continue;
    }
    // Closing `</template>` — decrement; clamp at zero.
    if (sourceText.startsWith("</template", i)) {
      const close = sourceText.indexOf(">", i);
      if (close === -1) break;
      depth = Math.max(0, depth - 1);
      i = close + 1;
      continue;
    }
    // ANY OTHER opening tag — skip past its `>` (quote-aware), so attribute
    // values like `<view data="<template name=fake>">` don't false-bump.
    if (sourceText[i] === "<" && i + 1 < sourceText.length) {
      const next = sourceText[i + 1];
      if (next === "/" || next === "!" || next === "?" || /[A-Za-z]/u.test(next)) {
        const tagEnd = findUnquotedGreaterThan(sourceText, i + 1);
        if (tagEnd === -1) break;
        i = tagEnd + 1;
        continue;
      }
    }
    i += 1;
  }
  return depth > 0;
}

// Walks forward from `start` (positioned somewhere inside a tag, after the
// opening `<`) and returns the index of the tag's closing `>`. Skips `>`
// characters that appear inside attribute-value quotes (`<view data=">"`).
// Returns -1 if no closing `>` exists before end-of-source.
function findUnquotedGreaterThan(sourceText, start) {
  let inQuote = null;
  for (let i = start; i < sourceText.length; i += 1) {
    const ch = sourceText[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function interpolationCompletionContext(sourceText, position) {
  const offset = offsetAt(sourceText, position);
  if (offset === undefined) return undefined;
  if (!isInsideDelimitedRange(sourceText, offset, "{{", "}}")) return undefined;

  // Find the most recent `{{` start before cursor — the interpolation we're in.
  const before = sourceText.slice(0, offset);
  const startIdx = before.lastIndexOf("{{");
  if (startIdx === -1) return undefined;

  // Cursor inside `<template name="X">...</template>` body? Symmetric to
  // expressionRefDiagnostics' inTemplateDefinition gate — template-body
  // refs resolve against caller scope, not this file's owner script.
  // Source-text scan, not graph-based: completion runs against the live
  // buffer text, which can be unsaved/un-graphed.
  if (isCursorInsideTemplateDefinitionBody(sourceText, offset)) {
    return { typed: "", suppress: true };
  }

  // Inspect the full enclosing expression (start to matching }}) for
  // object-literal shape, which suppresses identifier completion across
  // the whole expression.
  const endIdx = sourceText.indexOf("}}", offset);
  const fullExpr = endIdx !== -1 ? sourceText.slice(startIdx + 2, endIdx) : sourceText.slice(startIdx + 2);
  if (looksLikeObjectLiteralExpression(fullExpr)) return { typed: "", suppress: true };

  // Prefix from `{{` to cursor; partial identifier at the end.
  const exprPrefix = sourceText.slice(startIdx + 2, offset);
  const stripped = stripStringLiterals(exprPrefix);
  if (stripped === null) return { typed: "", suppress: true };

  // Cursor inside an unclosed string literal? `{{ '<view |' }}`-style tokens
  // shouldn't surface identifier candidates. Walk the prefix tracking quote
  // state with escape handling; if we end still inside a quote, suppress.
  let inQuote = null;
  for (let i = 0; i < exprPrefix.length; i += 1) {
    const ch = exprPrefix[i];
    if (inQuote) {
      if (ch === "\\" && i + 1 < exprPrefix.length) { i += 1; continue; }
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    }
  }
  if (inQuote !== null) return { typed: "", suppress: true };

  const m = stripped.match(/([A-Za-z_$][A-Za-z0-9_$]*)$/u);
  const typed = m ? m[1] : "";

  // Member access: if the char just before typed is `.`, suppress.
  const prevIdx = stripped.length - typed.length - 1;
  if (prevIdx >= 0 && stripped[prevIdx] === ".") {
    return { typed: "", suppress: true };
  }

  // Cross-line typed isn't supported — the textEdit range assumes typed
  // lives on the cursor's line.
  if (typed.includes("\n")) return { typed: "", suppress: true };

  const startCharacter = position.character - typed.length;
  return {
    typed,
    suppress: false,
    range: {
      start: { line: position.line, character: startCharacter },
      end: { line: position.line, character: position.character },
    },
  };
}

function templateIsContext(sourceText, position) {
  const prefix = currentLinePrefix(sourceText, position);
  if (typeof prefix !== "string") return undefined;
  const match = prefix.match(/<template\b[^>]*\bis=(["'])([^"']*)$/u);
  if (!match) return undefined;
  const typed = match[2];
  if (typed.includes("{{")) return undefined;
  return {
    type: "template",
    typed,
    range: contextRange(position, position.character - typed.length),
  };
}

function completionItem(label, kind, detail, range) {
  return {
    label,
    kind,
    detail,
    textEdit: {
      range,
      newText: label,
    },
  };
}

function componentCompletionItems(graph, documentGraphPath, range) {
  const customTags = graph.usingComponents
    .filter((entry) => (
      entry.owner === documentGraphPath &&
      entry.resolved === true &&
      typeof entry.tag === "string" &&
      entry.tag.length > 0
    ))
    .map((entry) => entry.tag)
    .sort();

  const seen = new Set();
  const items = [];
  for (const tag of customTags) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    items.push(completionItem(tag, COMPLETION_ITEM_KIND_CLASS, "component", range));
  }
  for (const tag of [...BUILTIN_TAG_NAMES].sort()) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    items.push(completionItem(tag, COMPLETION_ITEM_KIND_CLASS, "built-in component", range));
  }
  return items;
}

function visibleTemplateCompletionItems(graph, fileModel, range) {
  const items = [];
  const seen = new Set();

  function pushTemplate(symbol) {
    if (seen.has(symbol.name)) return;
    seen.add(symbol.name);
    items.push(completionItem(symbol.name, COMPLETION_ITEM_KIND_FUNCTION, "template", range));
  }

  for (const symbol of fileModel.symbols) {
    if (symbol.kind === "template" && typeof symbol.name === "string" && symbol.name.length > 0) {
      pushTemplate(symbol);
    }
  }

  for (const dependencyFile of directTemplateDependencyFiles(graph, fileModel)) {
    for (const symbol of dependencyFile.symbols) {
      if (symbol.kind === "template" && typeof symbol.name === "string" && symbol.name.length > 0) {
        pushTemplate(symbol);
      }
    }
  }

  return items;
}

function attributeCompletionItems(range) {
  return COMMON_ATTRIBUTE_NAMES.map((name) => (
    completionItem(name, COMPLETION_ITEM_KIND_PROPERTY, "attribute", range)
  ));
}

// Locate the owner config (page/component .json) for a WXML document's
// graph path, returning null if it has no sibling JS script. Shared by the
// event-handler definition (getDefinition) and completion paths.
// @internal — exported only for sibling server/wxml-*.mjs modules.
export function findOwnerConfigWithScript(graph, documentGraphPath) {
  return graph.configs.find((c) => (
    c.owner === documentGraphPath && c.script && Array.isArray(c.script.methods)
  )) ?? null;
}

function dataRefCompletionItems(graph, documentGraphPath, fileModel, range) {
  const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
  const seen = new Set();
  const items = [];

  const pushName = (name, detail) => {
    if (typeof name !== "string" || name.length === 0) return;
    if (seen.has(name)) return;
    seen.add(name);
    items.push(completionItem(name, COMPLETION_ITEM_KIND_PROPERTY, detail, range));
  };

  if (ownerConfig && !ownerConfig.script.hasDynamicData) {
    for (const key of ownerConfig.script.dataKeys ?? []) pushName(key.name, "data");
    for (const key of ownerConfig.script.propertyKeys ?? []) pushName(key.name, "property");
  }

  for (const sym of fileModel.symbols ?? []) {
    if (sym.kind === "wxs") pushName(sym.name, "wxs module");
  }

  const bindings = fileModel.wxForBindings;
  if (bindings) {
    if (bindings.hasAnyWxFor) {
      pushName("item", "wx:for item");
      pushName("index", "wx:for index");
    }
    for (const name of bindings.items ?? []) pushName(name, "wx:for item");
    for (const name of bindings.indexes ?? []) pushName(name, "wx:for index");
  }

  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

function eventHandlerCompletionItems(graph, documentGraphPath, range) {
  const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
  if (!ownerConfig) return [];

  const seen = new Set();
  const items = [];
  for (const method of ownerConfig.script.methods) {
    if (typeof method.name !== "string" || method.name.length === 0) continue;
    // Component({...}) top-level lifecycle hooks (attached/ready/detached/moved)
    // live alongside `methods:` in the same options object. They are not event
    // handlers. Page-method kind is not filtered: extractor cannot distinguish
    // Page lifecycle (onLoad/onShow) from custom handlers by kind today.
    if (method.kind === METHOD_KIND_COMPONENT_LIFECYCLE) continue;
    if (seen.has(method.name)) continue;
    seen.add(method.name);
    items.push(completionItem(method.name, COMPLETION_ITEM_KIND_FUNCTION, "method", range));
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

function templateDefinitionForPosition({ graph, fileModel, position, extensionRoot }) {
  const reference = fileModel.references.find((entry) => (
    entry.kind === "template" &&
    entry.dynamic === false &&
    typeof entry.name === "string" &&
    entry.name.length > 0 &&
    containsPosition(entry.range, position)
  ));
  if (!reference) {
    return null;
  }

  const matches = visibleTemplateDefinitions(graph, fileModel, reference.name);
  if (matches.length !== 1) {
    return null;
  }

  const match = matches[0];
  return locationForGraphPathWithRange(match.fileModel.path, match.symbol.range, extensionRoot);
}

export function getCompletions({ graph, documentPath, position, sourceText, extensionRoot }) {
  if (typeof sourceText !== "string") {
    return [];
  }
  const offset = offsetAt(sourceText, position);
  if (offset === undefined || isInsideRawTextOrComment(sourceText, offset)) {
    return [];
  }

  const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) {
    return [];
  }

  const interpolationContext = interpolationCompletionContext(sourceText, position);
  if (interpolationContext) {
    if (interpolationContext.suppress) return [];
    return dataRefCompletionItems(graph, documentGraphPath, fileModel, interpolationContext.range);
  }

  const handlerValueContext = eventHandlerValueContext(sourceText, position);
  if (handlerValueContext) {
    return eventHandlerCompletionItems(graph, documentGraphPath, handlerValueContext.range);
  }

  const templateContext = templateIsContext(sourceText, position);
  if (templateContext) {
    return visibleTemplateCompletionItems(graph, fileModel, templateContext.range);
  }

  const tagContext = tagNameContext(sourceText, position);
  if (tagContext) {
    return componentCompletionItems(graph, documentGraphPath, tagContext.range);
  }

  const attrContext = attributeContext(sourceText, position);
  if (attrContext) {
    return attributeCompletionItems(attrContext.range);
  }

  return [];
}

function attrNameFromHandler(entry) {
  return `${entry.binding}${entry.event}`;
}

function eventHandlerDiagnostics(graph, documentGraphPath, fileModel) {
  const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
  // No sibling .js script: don't warn. Page/Component WXML can legitimately
  // ship without a .js companion; diagnostics here would be noisy.
  if (!ownerConfig) return [];
  // hasDynamicMethods means the extractor saw spread / behaviors / a non-
  // object methods value / a non-object factory arg — methods array is
  // incomplete by definition, so warnings would be false positives.
  if (ownerConfig.script.hasDynamicMethods) return [];

  const methodNames = new Set(
    ownerConfig.script.methods
      .map((m) => m.name)
      .filter((name) => typeof name === "string" && name.length > 0),
  );

  const handlers = fileModel.eventHandlers ?? [];
  const out = [];
  for (const entry of handlers) {
    if (entry.dynamic) continue;
    // Filter the false-positive class that the data model's loose matcher
    // accepts (`binding=`, `bindable=`, …) — same strict gate completion uses.
    if (!isEventHandlerCompletionTrigger(attrNameFromHandler(entry))) continue;
    if (typeof entry.handler !== "string" || entry.handler.length === 0) continue;
    // `catchtouchmove="true"` (and friends) is the documented WeChat idiom
    // for "block this event without supplying a handler" — `"true"` /
    // `"false"` aren't method references, so don't warn about them.
    if (entry.handler === "true" || entry.handler === "false") continue;
    if (methodNames.has(entry.handler)) continue;
    out.push({
      range: rangeFromSymbolRange(entry.nameRange),
      severity: WARNING,
      source: "wxml-zed",
      code: "missing-event-handler",
      message: `Event handler "${entry.handler}" is not defined in the page/component script.`,
    });
  }
  return out;
}

// Returns 'declared' | 'not-declared' | 'unresolvable'.
//
// 'declared'      — child's static propertyKeys provably contains the name.
//                   Even if child.script.hasDynamicData === true elsewhere
//                   (data spread, non-empty behaviors), a static hit is
//                   authoritative. Nothing in the rest of the script can
//                   REMOVE what the extractor already observed.
// 'not-declared'  — child resolves, prop set is fully knowable
//                   (no hasDynamicData), AND the name is not in propertyKeys.
// 'unresolvable'  — child has no resolved usingComponents entry, OR child
//                   resolves but has no JS, OR child has hasDynamicData=true
//                   AND the name is not in the static propertyKeys (might
//                   be injected by behaviors / spread).
function findChildProperty(graph, ownerWxmlGraphPath, childTag, attributeName) {
  const using = graph.usingComponents.find((c) => (
    c.owner === ownerWxmlGraphPath &&
    c.tag === childTag &&
    c.resolved
  ));
  if (!using) return "unresolvable";

  const childConfig = graph.configs.find((c) => (
    c.owner === using.target &&
    c.script
  ));
  if (!childConfig) return "unresolvable";

  const propertyKeys = childConfig.script.propertyKeys ?? [];
  if (propertyKeys.some((k) => k.name === attributeName)) {
    return "declared";
  }
  if (childConfig.script.hasDynamicData) return "unresolvable";
  return "not-declared";
}

function expressionRefDiagnostics(graph, documentGraphPath, fileModel) {
  const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
  if (!ownerConfig) return [];
  if (ownerConfig.script.hasDynamicData) return [];

  const scope = new Set();
  for (const key of ownerConfig.script.dataKeys ?? []) scope.add(key.name);
  // Component properties contribute to template scope identically to data
  // (see WeChat docs on `properties:` — values are reactive template state).
  for (const key of ownerConfig.script.propertyKeys ?? []) scope.add(key.name);
  for (const sym of fileModel.symbols ?? []) {
    if (sym.kind === "wxs" && typeof sym.name === "string") scope.add(sym.name);
  }
  const bindings = fileModel.wxForBindings;
  if (bindings) {
    if (bindings.hasAnyWxFor) {
      scope.add("item");
      scope.add("index");
    }
    for (const name of bindings.items ?? []) scope.add(name);
    for (const name of bindings.indexes ?? []) scope.add(name);
  }

  const refs = fileModel.expressionRefs ?? [];
  const out = [];
  for (const ref of refs) {
    // Refs inside `<template name="X">...</template>` resolve in the caller's
    // data scope at use time (via `<template is="X" data="{{...}}"/>`), not
    // in this file's owner script. Skip — we don't have call-site context.
    if (ref.inTemplateDefinition) continue;
    if (scope.has(ref.name)) continue;

    // Cross-component prop binding check: if the failing identifier is
    // inside a non-reserved attribute and the child component statically
    // declares that attribute as a property, downgrade to
    // dead-component-binding Information.
    const isCandidateBinding =
      ref.containingAttribute !== null &&
      !isReservedAttribute(ref.containingAttribute);

    if (isCandidateBinding) {
      const status = findChildProperty(graph, documentGraphPath, ref.containingTag, ref.containingAttribute);
      if (status === "declared") {
        out.push({
          range: rangeFromSymbolRange(ref.range),
          severity: INFORMATION,
          source: "wxml-zed",
          code: "dead-component-binding",
          message: `"${ref.name}" is not defined in this file, but <${ref.containingTag}> declares "${ref.containingAttribute}" as a property — the child will receive undefined and use its property default if one exists. If you intended to pass a value, declare "${ref.name}" in this page/component's data, properties, or setData.`,
        });
        continue;
      }
      // status === 'not-declared' or 'unresolvable' → fall through to warning
    }

    out.push({
      range: rangeFromSymbolRange(ref.range),
      severity: WARNING,
      source: "wxml-zed",
      code: "missing-expression-ref",
      message: `"${ref.name}" is not defined in the page/component data, wx:for scope, or any <wxs> module.`,
    });
  }
  return out;
}

export function getDiagnostics({ graph, documentPath, extensionRoot, fileModelOverride }) {
  const { documentGraphPath, fileModel: graphFileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  // documentGraphPath always derives from path resolution; it's the
  // cross-file lookup key, identical whether overlay'd or not. Only the
  // fileModel itself is overridable.
  const fileModel = fileModelOverride ?? graphFileModel;
  if (!fileModel) {
    return [];
  }

  const usedComponents = new Map(fileModel.components.map((component) => [component.tag, component]));
  const componentDiags = graph.unresolved
    .filter((entry) => (
      entry.kind === "component" &&
      entry.owner === documentGraphPath &&
      entry.reason === "missing-file" &&
      usedComponents.has(entry.tag)
    ))
    .map((entry) => {
      const component = usedComponents.get(entry.tag);
      return {
        range: rangeFromSymbolRange(component.range),
        severity: WARNING,
        source: "wxml-zed",
        code: "missing-local-component",
        message: `Missing local component "${entry.tag}": ${entry.value}`,
      };
    });

  const handlerDiags = eventHandlerDiagnostics(graph, documentGraphPath, fileModel);
  const expressionDiags = expressionRefDiagnostics(graph, documentGraphPath, fileModel);
  return [...componentDiags, ...handlerDiags, ...expressionDiags];
}

export { getHover } from "./wxml-hover.mjs";

export function getDefinition({ graph, documentPath, position, extensionRoot }) {
  if (!position || typeof position.line !== "number" || typeof position.character !== "number") {
    return null;
  }

  const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) {
    return null;
  }

  // Event handler binding: cursor inside a `bindtap="onTap"` value text.
  // This branch is AUTHORITATIVE — if the cursor is inside a handler
  // nameRange, do not fall through to component/dependency checks even
  // on a miss. Otherwise clicking on a handler name could surprise the
  // user by jumping to the enclosing component's .wxml instead of saying
  // "no definition found."
  const eventHandlerMatch = (fileModel.eventHandlers ?? [])
    .find((entry) => containsPosition(entry.nameRange, position));
  if (eventHandlerMatch) {
    if (eventHandlerMatch.dynamic) return null;
    const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
    if (!ownerConfig) return null;
    const method = ownerConfig.script.methods.find((m) => m.name === eventHandlerMatch.handler);
    if (!method) return null;
    return locationForGraphPathWithRange(ownerConfig.script.path, method.nameRange, extensionRoot);
  }

  // Expression reference: cursor inside a `{{theme}}` interpolation ref name.
  // AUTHORITATIVE — narrow nameRange dominates the broader component-element
  // range that follows. Resolution chain (parallel to getHover step 2):
  //   2a. dataKeys (requires ownerConfig)
  //   2b. propertyKeys (requires ownerConfig)
  //   2c. in-file wxs symbol (works without ownerConfig — template-only files)
  // None of these matches → return null (missing-expression-ref diagnostic
  // will warn separately).
  const expressionRefMatch = (fileModel.expressionRefs ?? [])
    .find((entry) => containsPosition(entry.range, position));
  if (expressionRefMatch) {
    if (expressionRefMatch.inTemplateDefinition) return null;
    // ownerConfig is needed by 2a/2b only — 2c reads from fileModel and works
    // even for template-only WXML files (no JS sibling).
    const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
    if (ownerConfig) {
      const dataKey = (ownerConfig.script.dataKeys ?? []).find((k) => k.name === expressionRefMatch.name);
      if (dataKey) {
        return locationForGraphPathWithRange(ownerConfig.script.path, dataKey.nameRange, extensionRoot);
      }
      const propKey = (ownerConfig.script.propertyKeys ?? []).find((k) => k.name === expressionRefMatch.name);
      if (propKey) {
        return locationForGraphPathWithRange(ownerConfig.script.path, propKey.nameRange, extensionRoot);
      }
    }
    // 2c. In-file wxs symbol — external jumps to the resolved .wxs file,
    // inline jumps to the <wxs module="X"> element's nameRange in this file.
    // Mirrors getHover step 2c (server/wxml-language-service.mjs:1135 area):
    // external-vs-inline discrimination by presence of dep entry; dep without
    // `normalized` ⇒ unresolved external ⇒ null. Keep the two in sync.
    const wxsSymbol = (fileModel.symbols ?? [])
      .find((s) => s.kind === "wxs" && s.name === expressionRefMatch.name);
    if (wxsSymbol) {
      const wxsDep = (fileModel.dependencies ?? [])
        .find((d) => d.kind === "wxs" && d.module === expressionRefMatch.name);
      if (wxsDep) {
        if (!wxsDep.normalized) return null;
        return locationForGraphPath(wxsDep.normalized, extensionRoot);
      }
      // Inline: jump to the declaration's nameRange in this file. Task 1
      // (commit 243d148) added nameRange to every wxs symbol the extractor
      // emits; the `nameRange &&` guard is defensive against legacy graphs
      // predating that field, parallel to branch 4's same defensiveness
      // (also matches S-W4 legacy-graph-degrades test).
      if (wxsSymbol.nameRange) {
        return locationForGraphPathWithRange(documentGraphPath, wxsSymbol.nameRange, extensionRoot);
      }
      return null;
    }
    return null;
  }

  const component = fileModel.components.find((entry) => containsPosition(entry.range, position));
  if (component) {
    const usingComponent = graph.usingComponents.find((entry) => (
      entry.owner === documentGraphPath &&
      entry.tag === component.tag &&
      entry.resolved === true &&
      entry.target
    ));
    if (usingComponent) {
      return locationForGraphPath(usingComponent.target, extensionRoot);
    }
  }

  const dependencyDefinition = dependencyDefinitionForPosition({
    graph,
    documentGraphPath,
    fileModel,
    position,
    extensionRoot,
  });
  if (dependencyDefinition) {
    return dependencyDefinition;
  }

  return templateDefinitionForPosition({
    graph,
    fileModel,
    position,
    extensionRoot,
  });
}

function documentSymbol(name, kind, detail, range) {
  const lspRange = rangeFromSymbolRange(range);
  return {
    name,
    kind,
    detail,
    range: lspRange,
    selectionRange: lspRange,
  };
}

function symbolNameFromDependency(dependency) {
  return dependency.normalized || dependency.value;
}

export function getDocumentSymbols({ graph, documentPath, extensionRoot }) {
  const { fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) {
    return [];
  }

  const symbols = [];
  const wxsSymbolRanges = new Set();

  for (const symbol of fileModel.symbols) {
    if (symbol.kind === "template") {
      symbols.push(documentSymbol(symbol.name, DOCUMENT_SYMBOL_KIND_FUNCTION, "template", symbol.range));
    }
    if (symbol.kind === "wxs") {
      wxsSymbolRanges.add(rangeKey(symbol.range));
      symbols.push(documentSymbol(symbol.name, DOCUMENT_SYMBOL_KIND_MODULE, "wxs", symbol.range));
    }
  }

  for (const dependency of fileModel.dependencies) {
    if (dependency.kind === "import") {
      symbols.push(documentSymbol(symbolNameFromDependency(dependency), DOCUMENT_SYMBOL_KIND_FILE, "import", dependency.range));
    }
    if (dependency.kind === "include") {
      symbols.push(documentSymbol(symbolNameFromDependency(dependency), DOCUMENT_SYMBOL_KIND_FILE, "include", dependency.range));
    }
    if (dependency.kind === "wxs" && !wxsSymbolRanges.has(rangeKey(dependency.range))) {
      symbols.push(documentSymbol(dependency.module || symbolNameFromDependency(dependency), DOCUMENT_SYMBOL_KIND_MODULE, "wxs external", dependency.range));
    }
  }

  return symbols.sort((left, right) => (
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character
  ));
}
