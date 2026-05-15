# WXML LSP Completion Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a narrow `textDocument/completion` baseline for WXML tag names, static template names, and common attribute names.

**Architecture:** Keep `server/wxml-lsp.mjs` as the protocol host and graph coordinator. Add pure completion mapping to `server/wxml-language-service.mjs`, backed by the existing project graph and current open document text. Move built-in WXML tag names into a shared JS module so completion and component-candidate filtering use the same source, with a verification check against `highlights.scm`.

**Tech Stack:** Node.js ESM, dependency-free JSON-RPC/LSP stdio server, existing WXML project graph JSON model, fixture-driven verification scripts, Markdown docs.

---

## File Structure

- Create `shared/wxml-builtins.mjs`
  - Owns the canonical JS list of built-in WXML / mini program tag names.
  - Export both `BUILTIN_TAG_NAMES` and `BUILTIN_TAGS`.
- Create `scripts/verify-wxml-builtins.mjs`
  - Compares `shared/wxml-builtins.mjs` with the `@tag.builtin` list in `languages/wxml/highlights.scm`.
- Modify `scripts/extract-wxml-symbols.mjs`
  - Import `BUILTIN_TAGS` from the shared module and remove the private duplicate list.
- Modify `scripts/verify-tree-sitter.sh`
  - Run `scripts/verify-wxml-builtins.mjs` as part of total verification.
- Modify `server/wxml-language-service.mjs`
  - Import built-ins and export `getCompletions({ graph, documentPath, position, sourceText, extensionRoot })`.
  - Keep all completion context detection and completion item construction pure.
- Modify `server/wxml-lsp.mjs`
  - Advertise `completionProvider`.
  - Track open document text from `didOpen`, full `didChange`, and optional `didSave.text`.
  - Preserve open document text when scheduling diagnostics.
  - Handle `textDocument/completion` by awaiting graph availability and calling `getCompletions`.
- Modify `scripts/verify-wxml-language-service.mjs`
  - Add direct unit coverage for completion contexts and fail-closed behavior.
- Modify `scripts/verify-lsp-diagnostics.mjs`
  - Add protocol-level completion helper methods and scenarios.
- Modify `README.md`
  - Document the new completion support and unsupported boundaries.

---

### Task 0: Branch and Baseline Verification

**Files:**
- Read: `docs/superpowers/specs/2026-05-15-wxml-lsp-completion-baseline-design.md`
- Verify: current repository state

- [ ] **Step 1: Confirm branch and clean worktree**

Run:

```bash
git branch --show-current
git status --short
```

Expected:

```text
wxml-lsp-completion-baseline
```

`git status --short` should print nothing.

- [ ] **Step 2: Run baseline syntax checks**

Run:

```bash
node --check server/wxml-language-service.mjs
node --check server/wxml-lsp.mjs
node --check scripts/verify-wxml-language-service.mjs
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: all commands exit `0`.

- [ ] **Step 3: Run baseline behavior checks**

Run these sequentially, not in parallel, because `tree-sitter-cli` can contend on its temp lock cache:

```bash
node scripts/verify-wxml-language-service.mjs
node scripts/verify-lsp-diagnostics.mjs
scripts/verify-tree-sitter.sh
```

Expected:

- `node scripts/verify-wxml-language-service.mjs` exits `0`.
- `node scripts/verify-lsp-diagnostics.mjs` exits `0`.
- `scripts/verify-tree-sitter.sh` prints `wxml-zed tree-sitter verification passed`.

---

### Task 1: Shared Built-In Tag Source

**Files:**
- Create: `shared/wxml-builtins.mjs`
- Create: `scripts/verify-wxml-builtins.mjs`
- Modify: `scripts/extract-wxml-symbols.mjs`
- Modify: `scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Create the shared built-in list**

Create `shared/wxml-builtins.mjs`:

```javascript
export const BUILTIN_TAG_NAMES = [
  "view", "scroll-view", "swiper", "swiper-item", "movable-area", "movable-view",
  "cover-view", "cover-image", "match-media", "page-container", "root-portal",
  "share-element", "text", "rich-text", "icon", "progress", "button", "checkbox",
  "checkbox-group", "editor", "form", "input", "label", "picker", "picker-view",
  "picker-view-column", "radio", "radio-group", "slider", "switch", "textarea",
  "keyboard-accessory", "navigator", "functional-page-navigator", "audio", "image",
  "video", "camera", "live-player", "live-pusher", "voip-room", "map", "canvas",
  "open-data", "web-view", "ad", "ad-custom", "official-account", "open-container",
  "page-meta", "navigation-bar", "custom-wrapper",
];

export const BUILTIN_TAGS = new Set(BUILTIN_TAG_NAMES);
```

- [ ] **Step 2: Use the shared list in the symbol extractor**

In `scripts/extract-wxml-symbols.mjs`, replace the private `BUILTIN_TAGS` declaration with:

```javascript
import { BUILTIN_TAGS } from "../shared/wxml-builtins.mjs";
```

Keep the existing imports:

```javascript
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
```

Do not change `CONTROL_TAGS` or component candidate extraction behavior.

- [ ] **Step 3: Add the drift verifier**

Create `scripts/verify-wxml-builtins.mjs`:

```javascript
#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_TAG_NAMES } from "../shared/wxml-builtins.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HIGHLIGHTS = path.join(ROOT, "languages/wxml/highlights.scm");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function highlightBuiltinTags(source) {
  const anyOfStart = source.indexOf("(#any-of? @tag.builtin");
  assert(anyOfStart !== -1, "Missing @tag.builtin #any-of? predicate");

  const tail = source.slice(anyOfStart);
  const end = tail.indexOf(")");
  assert(end !== -1, "Unterminated @tag.builtin #any-of? predicate");

  const predicate = tail.slice(0, end);
  return [...predicate.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

const source = fs.readFileSync(HIGHLIGHTS, "utf8");
const highlightTags = highlightBuiltinTags(source);

const expected = [...BUILTIN_TAG_NAMES].sort();
const actual = [...highlightTags].sort();

assert(
  JSON.stringify(actual) === JSON.stringify(expected),
  `Built-in tag drift between shared JS list and highlights.scm\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`,
);
```

- [ ] **Step 4: Wire the verifier into total verification**

In `scripts/verify-tree-sitter.sh`, after `ROOT_DIR=...` variables and before Tree-sitter parse/query work, add:

```bash
node "$ROOT_DIR/scripts/verify-wxml-builtins.mjs"
```

- [ ] **Step 5: Verify Task 1**

Run:

```bash
node --check shared/wxml-builtins.mjs
node --check scripts/verify-wxml-builtins.mjs
node --check scripts/extract-wxml-symbols.mjs
node scripts/verify-wxml-builtins.mjs
node scripts/extract-wxml-symbols.mjs fixtures/real-world/page.wxml fixtures/real-world/component.wxml fixtures/real-world/templates.wxml >/tmp/wxml-zed-symbols.json
scripts/verify-tree-sitter.sh
```

Expected:

- All commands exit `0`.
- `scripts/verify-tree-sitter.sh` prints `wxml-zed tree-sitter verification passed`.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add shared/wxml-builtins.mjs scripts/verify-wxml-builtins.mjs scripts/extract-wxml-symbols.mjs scripts/verify-tree-sitter.sh
git commit -m "refactor: share wxml built-in tag list"
```

---

### Task 2: Direct Completion Tests

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`
- Test target: `server/wxml-language-service.mjs`

- [ ] **Step 1: Import `fs` and `getCompletions`**

At the top of `scripts/verify-wxml-language-service.mjs`, add `fs`:

```javascript
import fs from "node:fs";
```

Update the language-service import to include `getCompletions`:

```javascript
import {
  getCompletions,
  getDefinition,
  getDiagnostics,
  getDocumentSymbols,
} from "../server/wxml-language-service.mjs";
```

- [ ] **Step 2: Add completion test helpers**

Add these helpers after `assertDeepEqual(...)`:

```javascript
function sourceWithCursor(source) {
  const offset = source.indexOf("|");
  assert(offset !== -1, `Missing cursor marker in source: ${source}`);
  const cleanSource = source.slice(0, offset) + source.slice(offset + 1);
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return {
    source: cleanSource,
    position: {
      line: lines.length - 1,
      character: lines[lines.length - 1].length,
    },
  };
}

function homeSourceWithCursor(insert) {
  const source = fs.readFileSync(HOME_WXML, "utf8");
  return sourceWithCursor(`${source}\n${insert}`);
}

function completionLabels(items) {
  return items.map((item) => item.label);
}

function completionByLabel(items, label) {
  return items.find((item) => item.label === label);
}

function assertCompletionLabelsInclude(items, labels, label) {
  const actual = new Set(completionLabels(items));
  for (const expected of labels) {
    assert(actual.has(expected), `${label}: missing completion ${expected}; got ${JSON.stringify([...actual])}`);
  }
}

function assertNoCompletionLabel(items, forbidden, label) {
  assert(
    !completionLabels(items).includes(forbidden),
    `${label}: unexpected completion ${forbidden}; got ${JSON.stringify(completionLabels(items))}`,
  );
}

function assertCompletionTextEdit(item, range, newText, label) {
  assert(item, `${label}: missing completion item`);
  assertDeepEqual(item.textEdit, { range, newText }, `${label} textEdit`);
}
```

- [ ] **Step 3: Add direct completion tests**

Add these test functions before `const graph = loadGraph();`:

```javascript
function assertTagCompletion(graph) {
  const { source, position } = sourceWithCursor("<user-|");
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertCompletionLabelsInclude(items, ["global-badge", "user-card", "view"], "tag completion");
  assertNoCompletionLabel(items, "missing-card", "tag completion");
  assertCompletionTextEdit(
    completionByLabel(items, "user-card"),
    { start: { line: 0, character: 1 }, end: { line: 0, character: 6 } },
    "user-card",
    "tag completion user-card",
  );
}

function assertClosingTagCompletionReturnsEmpty(graph) {
  const { source, position } = sourceWithCursor("</|");
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertDeepEqual(items, [], "closing tag completion");
}

function assertOutsideTagCompletionReturnsEmpty(graph) {
  const { source, position } = sourceWithCursor("{{ | }}");
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertDeepEqual(items, [], "outside tag completion");
}

function assertTemplateCompletion(graph) {
  const { source, position } = homeSourceWithCursor('<template is="load|" />');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertCompletionLabelsInclude(items, ["loadingRow", "secondaryRow"], "template completion");
  assertCompletionTextEdit(
    completionByLabel(items, "loadingRow"),
    { start: { line: 23, character: 14 }, end: { line: 23, character: 18 } },
    "loadingRow",
    "template completion loadingRow",
  );
}

function assertDynamicTemplateCompletionReturnsEmpty(graph) {
  const { source, position } = homeSourceWithCursor('<template is="{{current|}}" />');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertDeepEqual(items, [], "dynamic template completion");
}

function assertAttributeCompletion(graph) {
  const { source, position } = sourceWithCursor("<user-card wx:| />");
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertCompletionLabelsInclude(items, ["wx:if", "bindtap", "capture-bind:tap"], "attribute completion");
  assertCompletionTextEdit(
    completionByLabel(items, "wx:if"),
    { start: { line: 0, character: 11 }, end: { line: 0, character: 14 } },
    "wx:if",
    "attribute completion wx:if",
  );
}

function assertAttributeValueCompletionReturnsEmpty(graph) {
  const { source, position } = sourceWithCursor('<view class="|" />');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertDeepEqual(items, [], "attribute value completion");
}

function assertExcludedContextsReturnEmpty(graph) {
  for (const [label, markedSource] of [
    ["comment tag", "<!-- <view | -->"],
    ["interpolation tag", "{{ '<view |' }}"],
    ["inline wxs tag", '<wxs module="tools">var tag = "<view |"</wxs>'],
  ]) {
    const { source, position } = sourceWithCursor(markedSource);
    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });
    assertDeepEqual(items, [], label);
  }
}

function assertInvalidCompletionInputsReturnEmpty(graph) {
  const { source, position } = sourceWithCursor("<vi|");
  assertDeepEqual(
    getCompletions({
      graph,
      documentPath: path.join(MINIPROGRAM_ROOT, "missing.wxml"),
      position,
      sourceText: source,
      extensionRoot: ROOT,
    }),
    [],
    "missing file model completion",
  );
  assertDeepEqual(
    getCompletions({
      graph,
      documentPath: HOME_WXML,
      position: { line: 99, character: 0 },
      sourceText: source,
      extensionRoot: ROOT,
    }),
    [],
    "invalid position completion",
  );
  assertDeepEqual(
    getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: undefined,
      extensionRoot: ROOT,
    }),
    [],
    "missing sourceText completion",
  );
}
```

- [ ] **Step 4: Call completion tests**

At the bottom of `scripts/verify-wxml-language-service.mjs`, after `assertComponentUsageExcluded(graph);`, add:

```javascript
assertTagCompletion(graph);
assertClosingTagCompletionReturnsEmpty(graph);
assertOutsideTagCompletionReturnsEmpty(graph);
assertTemplateCompletion(graph);
assertDynamicTemplateCompletionReturnsEmpty(graph);
assertAttributeCompletion(graph);
assertAttributeValueCompletionReturnsEmpty(graph);
assertExcludedContextsReturnEmpty(graph);
assertInvalidCompletionInputsReturnEmpty(graph);
```

- [ ] **Step 5: Run direct tests and confirm failure**

Run:

```bash
node --check scripts/verify-wxml-language-service.mjs
node scripts/verify-wxml-language-service.mjs
```

Expected:

- Syntax check exits `0`.
- Behavior check fails with an import error like:

```text
does not provide an export named 'getCompletions'
```

- [ ] **Step 6: Commit failing direct tests**

Run:

```bash
git add scripts/verify-wxml-language-service.mjs
git commit -m "test: add wxml completion service coverage"
```

---

### Task 3: Language-Service Completion Implementation

**Files:**
- Modify: `server/wxml-language-service.mjs`
- Test: `scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Import built-ins and add completion constants**

At the top of `server/wxml-language-service.mjs`, after Node imports, add:

```javascript
import { BUILTIN_TAG_NAMES } from "../shared/wxml-builtins.mjs";
```

After document symbol kind constants, add:

```javascript
const COMPLETION_ITEM_KIND_CLASS = 7;
const COMPLETION_ITEM_KIND_PROPERTY = 10;
const COMPLETION_ITEM_KIND_FUNCTION = 3;

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
```

- [ ] **Step 2: Add source and context helpers**

Add this block after `visibleTemplateDefinitions(...)`:

```javascript
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
  return end < start && before.indexOf(">", start) !== -1;
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

function filterByPrefix(items, typed) {
  if (!typed) return items;
  return items.filter((item) => item.label.startsWith(typed));
}
```

- [ ] **Step 3: Add completion source helpers**

Add this block after the context helpers:

```javascript
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
```

- [ ] **Step 4: Export `getCompletions`**

Add this export before `getDiagnostics(...)`:

```javascript
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

  const templateContext = templateIsContext(sourceText, position);
  if (templateContext) {
    return filterByPrefix(
      visibleTemplateCompletionItems(graph, fileModel, templateContext.range),
      templateContext.typed,
    );
  }

  const tagContext = tagNameContext(sourceText, position);
  if (tagContext) {
    return filterByPrefix(
      componentCompletionItems(graph, documentGraphPath, tagContext.range),
      tagContext.typed,
    );
  }

  const attrContext = attributeContext(sourceText, position);
  if (attrContext) {
    return filterByPrefix(attributeCompletionItems(attrContext.range), attrContext.typed);
  }

  return [];
}
```

- [ ] **Step 5: Run direct tests and fix only this task's failures**

Run:

```bash
node --check server/wxml-language-service.mjs
node --check scripts/verify-wxml-language-service.mjs
node scripts/verify-wxml-language-service.mjs
```

Expected: all commands exit `0`.

If the expected line number in `assertTemplateCompletion` is off, inspect `nl -ba fixtures/miniprogram/pages/home/home.wxml`; update the expected `line` only to match the appended synthetic source line.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat: add wxml completion language service"
```

---

### Task 4: LSP Text Sync and Completion Protocol

**Files:**
- Modify: `server/wxml-lsp.mjs`
- Test: `scripts/verify-lsp-diagnostics.mjs`

- [ ] **Step 1: Import `getCompletions`**

Update the import in `server/wxml-lsp.mjs`:

```javascript
import {
  getCompletions,
  getDefinition,
  getDiagnostics,
  getDocumentSymbols,
} from "./wxml-language-service.mjs";
```

- [ ] **Step 2: Replace document tracking helpers**

Replace `scheduleDiagnostics(uri)` with these functions:

```javascript
function recordOpenDocument(uri, text = undefined) {
  const documentPath = fileUriToPath(uri);
  if (!documentPath) {
    return undefined;
  }

  const existing = openDocuments.get(uri);
  const document = {
    path: documentPath,
    text: typeof text === "string" ? text : existing?.text,
  };
  openDocuments.set(uri, document);
  return document;
}

function updateOpenDocumentText(uri, text) {
  if (typeof text !== "string") {
    return recordOpenDocument(uri);
  }
  return recordOpenDocument(uri, text);
}

function scheduleDiagnostics(uri, text = undefined) {
  const document = recordOpenDocument(uri, text);
  if (!document) {
    return;
  }

  const projectRoot = resolveMiniProgramRoot(document.path);
  if (!projectRoot) {
    logDiagnosticError(`No app.json found for ${document.path}`);
    publishDiagnostics(uri, []);
    return;
  }

  const state = stateForRoot(projectRoot);
  state.latestGeneration += 1;
  pendingForRoot(projectRoot).set(uri, state.latestGeneration);
  runGraphBuild(projectRoot);
}
```

- [ ] **Step 3: Add completion request handling**

Add these functions after `handleDocumentSymbolRequest(...)`:

```javascript
async function completionsForRequest(params) {
  const uri = params?.textDocument?.uri;
  const documentPath = fileUriToPath(uri);
  if (!documentPath) {
    return [];
  }

  const document = openDocuments.get(uri);
  if (!document || typeof document.text !== "string") {
    return [];
  }

  const projectRoot = resolveMiniProgramRoot(documentPath);
  if (!projectRoot) {
    logDiagnosticError(`No app.json found for ${documentPath}`);
    return [];
  }

  const graph = await ensureGraphForRequest(projectRoot);
  if (!graph) {
    return [];
  }

  return getCompletions({
    graph,
    documentPath,
    position: params?.position,
    sourceText: document.text,
    extensionRoot: EXTENSION_ROOT,
  });
}

async function handleCompletionRequest(id, params) {
  try {
    respond(id, await completionsForRequest(params));
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    respond(id, []);
  }
}
```

- [ ] **Step 4: Advertise completion and full text sync**

In `initialize(...)`, change capabilities to:

```javascript
capabilities: {
  textDocumentSync: {
    openClose: true,
    change: 1,
    save: true,
  },
  definitionProvider: true,
  documentSymbolProvider: true,
  completionProvider: {
    triggerCharacters: ["<", " ", ":", "\"", "'"],
  },
},
```

- [ ] **Step 5: Wire didOpen, didChange, didSave, completion**

In `handleMessage(...)`, replace the relevant cases with:

```javascript
case "textDocument/didOpen":
  scheduleDiagnostics(
    message.params?.textDocument?.uri,
    message.params?.textDocument?.text,
  );
  break;

case "textDocument/didChange":
  {
    const uri = message.params?.textDocument?.uri;
    const fullChange = Array.isArray(message.params?.contentChanges)
      ? message.params.contentChanges.find((change) => !change.range && typeof change.text === "string")
      : undefined;
    if (fullChange) {
      updateOpenDocumentText(uri, fullChange.text);
    }
  }
  break;

case "textDocument/didSave":
  scheduleDiagnostics(message.params?.textDocument?.uri, message.params?.text);
  break;

case "textDocument/completion":
  handleCompletionRequest(message.id, message.params);
  break;
```

Keep existing `didClose`, `definition`, and `documentSymbol` cases.

- [ ] **Step 6: Update initialize test expectation**

In `scripts/verify-lsp-diagnostics.mjs`, update `initialize()` assertions:

```javascript
assert(response.result?.capabilities?.textDocumentSync?.change === 1, "full text sync not advertised");
assert(response.result?.capabilities?.completionProvider, "completionProvider not advertised");
```

This replaces the old assertion:

```javascript
assert(response.result?.capabilities?.textDocumentSync?.change === 0, "incremental sync should be disabled");
```

- [ ] **Step 7: Run syntax and existing protocol tests**

Run:

```bash
node --check server/wxml-lsp.mjs
node --check scripts/verify-lsp-diagnostics.mjs
node scripts/verify-lsp-diagnostics.mjs
```

Expected:

- Syntax checks exit `0`.
- Protocol tests exit `0`.
- Existing diagnostics, definition, and document symbol scenarios remain green.

- [ ] **Step 8: Commit Task 4**

Run:

```bash
git add server/wxml-lsp.mjs scripts/verify-lsp-diagnostics.mjs
git commit -m "feat: wire wxml completion over lsp"
```

---

### Task 5: Protocol Completion Coverage

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`
- Test: `server/wxml-lsp.mjs`

- [ ] **Step 1: Add LSP client completion helpers**

Inside `class LspClient`, after `documentSymbols(filePath)`, add:

```javascript
async completion(filePath, position) {
  const id = this.request("textDocument/completion", {
    textDocument: { uri: pathToFileURL(filePath).href },
    position,
  });
  const response = await this.waitForResponse(id);
  if (response.error) {
    throw new Error(`Completion request failed: ${JSON.stringify(response.error)}`);
  }
  return response.result;
}
```

After `saveDocument(filePath)`, add:

```javascript
changeDocument(filePath, text, version = 2) {
  const uri = pathToFileURL(filePath).href;
  this.send("textDocument/didChange", {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
}
```

- [ ] **Step 2: Add protocol completion assertion helpers**

After `assertTemplateDocumentSymbols(...)`, add:

```javascript
function completionLabels(items) {
  assert(Array.isArray(items), `Expected completion array, got ${JSON.stringify(items)}`);
  return items.map((item) => item.label);
}

function assertCompletionLabelsInclude(items, labels, label) {
  const actual = new Set(completionLabels(items));
  for (const expected of labels) {
    assert(actual.has(expected), `${label}: missing completion ${expected}; got ${JSON.stringify([...actual])}`);
  }
}

function assertCompletionTextEdit(items, label, textEdit, message) {
  const item = items.find((entry) => entry.label === label);
  assert(item, `${message}: missing ${label}; got ${JSON.stringify(items)}`);
  assertDeepEqual(item.textEdit, textEdit, `${message} textEdit`);
}
```

- [ ] **Step 3: Add completion protocol scenarios**

Add these functions before the `scenarios` array:

```javascript
async function testCompletionImmediatelyAfterOpen() {
  await withClient({ rootPath: ROOT }, async (client) => {
    client.openDocument(HOME_WXML);
    const result = await client.completion(HOME_WXML, { line: 7, character: 6 });
    assertCompletionLabelsInclude(result, ["user-card", "global-badge", "view"], "immediate tag completion");
  });
}

async function testTagCompletion() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before tag completion");
    const result = await client.completion(HOME_WXML, { line: 7, character: 6 });
    assertCompletionLabelsInclude(result, ["user-card", "global-badge", "view"], "tag completion");
    assertCompletionTextEdit(
      result,
      "user-card",
      {
        range: { start: { line: 7, character: 3 }, end: { line: 7, character: 6 } },
        newText: "user-card",
      },
      "tag completion user-card",
    );
  });
}

async function testTemplateCompletion() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before template completion");
    const result = await client.completion(HOME_WXML, { line: 5, character: 20 });
    assertCompletionLabelsInclude(result, ["loadingRow", "secondaryRow"], "template completion");
    assertCompletionTextEdit(
      result,
      "loadingRow",
      {
        range: { start: { line: 5, character: 16 }, end: { line: 5, character: 20 } },
        newText: "loadingRow",
      },
      "template completion loadingRow",
    );
  });
}

async function testAttributeCompletion() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const source = `${fs.readFileSync(HOME_WXML, "utf8")}\n<view wx: />\n`;
    const uri = client.openDocument(HOME_WXML);
    client.changeDocument(HOME_WXML, source);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before attribute completion");
    const result = await client.completion(HOME_WXML, { line: 23, character: 9 });
    assertCompletionLabelsInclude(result, ["wx:if", "bindtap", "capture-bind:tap"], "attribute completion");
  });
}

async function testDidChangeUpdatesCompletionSource() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const source = `${fs.readFileSync(HOME_WXML, "utf8")}\n<template is="sec" />\n`;
    client.openDocument(HOME_WXML);
    client.changeDocument(HOME_WXML, source);
    const result = await client.completion(HOME_WXML, { line: 23, character: 17 });
    assertCompletionLabelsInclude(result, ["secondaryRow"], "didChange template completion");
    assertCompletionTextEdit(
      result,
      "secondaryRow",
      {
        range: { start: { line: 23, character: 14 }, end: { line: 23, character: 17 } },
        newText: "secondaryRow",
      },
      "didChange template completion secondaryRow",
    );
  });
}

async function testCompletionBuildDoesNotBlockRequestLoop() {
  await withClient({
    rootPath: ROOT,
    env: { WXML_ZED_LSP_GRAPH_DELAY_MS: "250" },
  }, async (client) => {
    client.openDocument(HOME_WXML);
    const completionPromise = client.completion(HOME_WXML, { line: 7, character: 6 });
    const id = client.request("workspace/symbol", { query: "user-card" });
    const unsupported = await client.waitForResponse(id);
    assert(unsupported.error?.code === -32601, `Expected unsupported response during completion build: ${JSON.stringify(unsupported)}`);
    const result = await completionPromise;
    assertCompletionLabelsInclude(result, ["user-card", "view"], "delayed completion");
  });
}
```

- [ ] **Step 4: Register protocol completion scenarios**

In the `scenarios` array, add these entries after the document symbol scenarios and before diagnostics lifecycle scenarios:

```javascript
["completion immediately after open", testCompletionImmediatelyAfterOpen],
["tag completion", testTagCompletion],
["template completion", testTemplateCompletion],
["attribute completion", testAttributeCompletion],
["didChange updates completion source", testDidChangeUpdatesCompletionSource],
["completion build does not block request loop", testCompletionBuildDoesNotBlockRequestLoop],
```

- [ ] **Step 5: Run protocol tests**

Run:

```bash
node --check scripts/verify-lsp-diagnostics.mjs
node scripts/verify-lsp-diagnostics.mjs
```

Expected:

- Syntax check exits `0`.
- Protocol test exits `0`.
- Output includes:

```text
[verify-lsp-diagnostics] tag completion
[verify-lsp-diagnostics] template completion
[verify-lsp-diagnostics] didChange updates completion source
```

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add scripts/verify-lsp-diagnostics.mjs
git commit -m "test: cover wxml completion over lsp"
```

---

### Task 6: README Completion Scope

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update feature matrix**

In the feature matrix, after the document symbol row, add:

```markdown
| Prototype LSP completion for built-in tags, resolved local components, direct-scope static templates, and common attributes | Yes |
```

Change the planned row from:

```markdown
| Dynamic template, recursive/full template visibility, npm/plugin component, and full component resolution navigation | Planned |
```

to:

```markdown
| Dynamic template completion/navigation, recursive/full template visibility, npm/plugin component support, and full component resolution navigation | Planned |
```

- [ ] **Step 2: Update develop verification paragraph**

In the `Develop` section paragraph that starts with “The script parses”, update the LSP sentence so it says:

```markdown
It also verifies the pure WXML language-service mapping layer and starts
the prototype WXML language server over stdio to verify missing local component
diagnostics, go-to-definition for resolved local components, WXML
import/include dependencies, external WXS dependencies, and static template
definitions, flat document symbols for WXML declaration/dependency entries, and
baseline completion for built-in tags, resolved local components, direct-scope
static templates, and common attributes.
```

- [ ] **Step 3: Update scope section**

In `## Scope`, update the first paragraph so it includes:

```markdown
baseline completion for WXML tag names from built-ins and resolved owner-local
components, static direct-scope template names in `<template is="">`, and a
small fixed set of common WXML attributes.
```

Keep the unsupported list explicit:

```markdown
dynamic template completion/navigation, recursive/full template visibility,
expression completion, WXS module completion, npm/plugin component navigation,
`componentGenerics`, hover, semantic tokens, code actions, formatting, file
watching, and production Node runtime packaging.
```

- [ ] **Step 4: Update `server/wxml-lsp.mjs` scope paragraph**

In the paragraph beginning with `` `server/wxml-lsp.mjs` is a minimal stdio LSP prototype``, add:

```markdown
It also returns completion items for WXML tag names from built-ins and resolved
owner-local components, static direct-scope template names, and a fixed baseline
attribute list.
```

Keep unsupported behavior explicit:

```markdown
There is no dynamic template completion/navigation, recursive/full template
visibility, expression completion, WXS module completion, npm/plugin component
navigation, or `componentGenerics` support.
```

- [ ] **Step 5: Verify README updates**

Run:

```bash
rg -n 'completion|dynamic template completion|direct-scope static templates|common attributes|WXS module completion' README.md
git diff --check README.md
```

Expected:

- `rg` prints the new completion support and unsupported boundaries.
- `git diff --check README.md` exits `0`.

- [ ] **Step 6: Commit Task 6**

Run:

```bash
git add README.md
git commit -m "docs: document wxml completion baseline"
```

---

### Task 7: Final Verification and Review

**Files:**
- Verify all touched files
- Review: `server/wxml-language-service.mjs`, `server/wxml-lsp.mjs`, `scripts/verify-wxml-language-service.mjs`, `scripts/verify-lsp-diagnostics.mjs`, `scripts/extract-wxml-symbols.mjs`, `shared/wxml-builtins.mjs`, `scripts/verify-wxml-builtins.mjs`, `README.md`

- [ ] **Step 1: Run syntax checks**

Run:

```bash
node --check shared/wxml-builtins.mjs
node --check scripts/verify-wxml-builtins.mjs
node --check scripts/extract-wxml-symbols.mjs
node --check server/wxml-language-service.mjs
node --check server/wxml-lsp.mjs
node --check scripts/verify-wxml-language-service.mjs
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run behavior checks sequentially**

Run:

```bash
node scripts/verify-wxml-builtins.mjs
node scripts/verify-wxml-language-service.mjs
node scripts/verify-lsp-diagnostics.mjs
scripts/verify-tree-sitter.sh
```

Expected:

- all commands exit `0`;
- `scripts/verify-tree-sitter.sh` prints `wxml-zed tree-sitter verification passed`.

- [ ] **Step 3: Run diff checks**

Run:

```bash
git diff --check main..HEAD
git diff --stat main..HEAD
rg -n 'getCompletions|completionProvider|didChange|BUILTIN_TAG_NAMES|verify-wxml-builtins' server scripts shared README.md
```

Expected:

- `git diff --check main..HEAD` exits `0`;
- `git diff --stat main..HEAD` includes only expected files;
- `rg` shows completion implementation, protocol wiring, shared built-ins, verifier, and README documentation.

- [ ] **Step 4: Local review checklist**

Manually inspect:

```bash
git diff main..HEAD -- server/wxml-language-service.mjs
git diff main..HEAD -- server/wxml-lsp.mjs
git diff main..HEAD -- scripts/verify-wxml-language-service.mjs
git diff main..HEAD -- scripts/verify-lsp-diagnostics.mjs
git diff main..HEAD -- shared/wxml-builtins.mjs scripts/verify-wxml-builtins.mjs scripts/extract-wxml-symbols.mjs
git diff main..HEAD -- README.md
```

Check:

- `server/wxml-lsp.mjs` contains only protocol/text-sync/graph coordination logic.
- `server/wxml-language-service.mjs` contains WXML completion semantics and no JSON-RPC or process spawning.
- Diagnostics scheduling preserves open document text.
- Completion returns `[]` for unsupported contexts.
- Built-in tag drift check prevents `shared/wxml-builtins.mjs` and `highlights.scm` from diverging silently.
- Existing diagnostics, definition, and document-symbol behavior remains covered.

- [ ] **Step 5: Request review before merge**

Report:

```text
Completion baseline implemented on branch wxml-lsp-completion-baseline.
Verification passed:
- node --check shared/wxml-builtins.mjs scripts/verify-wxml-builtins.mjs scripts/extract-wxml-symbols.mjs server/wxml-language-service.mjs server/wxml-lsp.mjs scripts/verify-wxml-language-service.mjs scripts/verify-lsp-diagnostics.mjs
- node scripts/verify-wxml-builtins.mjs
- node scripts/verify-wxml-language-service.mjs
- node scripts/verify-lsp-diagnostics.mjs
- scripts/verify-tree-sitter.sh
Ready for review.
```

Do not merge until review is complete and the user asks to merge.
