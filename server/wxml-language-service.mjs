import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BUILTIN_TAG_NAMES } from "../shared/wxml-builtins.mjs";
import { isEventHandlerCompletionTrigger } from "../shared/event-binding-patterns.mjs";
import { METHOD_KIND_COMPONENT_LIFECYCLE } from "../shared/js-method-extractor.mjs";

const WARNING = 2;
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

function findWxmlFileModel(graph, documentPath, extensionRoot) {
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

function isInsideGraphRoot(graphPath, graphRoot) {
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

function isExcludedCompletionContext(sourceText, offset) {
  return (
    isInsideDelimitedRange(sourceText, offset, "<!--", "-->") ||
    isInsideDelimitedRange(sourceText, offset, "{{", "}}") ||
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
function findOwnerConfigWithScript(graph, documentGraphPath) {
  return graph.configs.find((c) => (
    c.owner === documentGraphPath && c.script && Array.isArray(c.script.methods)
  )) ?? null;
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
  if (offset === undefined || isExcludedCompletionContext(sourceText, offset)) {
    return [];
  }

  const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) {
    return [];
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

export function getDiagnostics({ graph, documentPath, extensionRoot }) {
  const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) {
    return [];
  }

  const usedComponents = new Map(fileModel.components.map((component) => [component.tag, component]));
  return graph.unresolved
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
}

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
