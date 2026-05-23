# WXML LSP Hover v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `textDocument/hover` for `.wxml` files. Hovering an identifier or tag in the editor returns a two-line markdown card naming the symbol, classifying it (`data` / `property` / `setData` / `injector` / `page method` / `component method` / `custom component` / `wxs module`), and pointing at where it is defined.

**Architecture:** Graph-driven, read-only. The hover handler runs a parallel matcher pipeline next to `getDefinition`, ordered eventHandler → expressionRef → component-tag → wxs-decl. Two additive narrow-range fields are added to `shared/wxml-symbol-extractor.mjs` (`wxs.nameRange`, `components.tagNameRange`) without bumping `graph.version`. Hover never re-parses and never infers types.

**Tech Stack:** Node.js (no runtime deps beyond `web-tree-sitter`), JSON-RPC LSP via stdio, Tree-sitter WXML grammar, project graph extractor.

**Spec:** `docs/superpowers/specs/2026-05-23-wxml-lsp-hover-v1-design.md` (commit `3a38c12`).

**Test harness:** No `npm` scripts exist. Verifiers run as `node scripts/<name>.mjs`; the umbrella shell `bash scripts/verify-tree-sitter.sh` runs them all (with `tree-sitter-cli` available). The new verifiers must be wired into the umbrella.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `shared/wxml-symbol-extractor.mjs` | Modify | Add `nameRange` to wxs symbol pushes (lines 261, 270); add `tagNameRange` to components push (line 299). |
| `fixtures/wasm-spike/*-symbols-baseline.json` | Regenerate | Every baseline that contains wxs or component entries grows new `nameRange` / `tagNameRange` keys. |
| `scripts/verify-wxml-narrow-ranges.mjs` | Create | Focused assertion test for the two new narrow-range fields (TDD-friendly; doesn't depend on baseline diff). |
| `scripts/verify-tree-sitter.sh` | Modify | Wire the new verifier into the umbrella. |
| `server/wxml-language-service.mjs` | Modify | Add exported `getHover()` next to `getDefinition()`; add internal `formatHoverMarkdown()` helper and `relativeToGraphRoot()` helper. |
| `server/wxml-lsp.mjs` | Modify | Declare `hoverProvider: true`; dispatch `textDocument/hover`. |
| `scripts/verify-wxml-language-service.mjs` | Modify | Add hover scenarios H-1 through H-19 (H-13 omitted — see Task 7 Step 5 rationale) plus S-C3 and S-W4 legacy-graph degradation cases. |
| `scripts/verify-lsp-diagnostics.mjs` | Modify | Add three LSP-level hover scenarios (L-H1/L-H2/L-H3) and register them under the `graph-smoke` suite. |

Commit cadence: one commit per task. All tasks operate on `main` (project authorizes this for wxml-zed).

---

## Task 1: Add `wxs.nameRange` to symbol extractor

**Files:**
- Create: `scripts/verify-wxml-narrow-ranges.mjs`
- Modify: `shared/wxml-symbol-extractor.mjs` (lines around 245-271)
- Modify: `scripts/verify-tree-sitter.sh` (umbrella entry)

**Background:** `<wxs module="X" src="..." />` and inline `<wxs module="X">...</wxs>` currently push `{ kind: "wxs", name, range }` with `range = rangeOf(node)` (whole element). Hover needs a narrow `nameRange` pointing at the `X` characters inside the quotes of `module="X"`. Helper `innerValueRange(quotedValueNode)` already exists at line 12 of the extractor and is reused.

- [ ] **Step 1: Write the failing test (new focused verifier)**

Create `scripts/verify-wxml-narrow-ranges.mjs`:

```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTRACTOR = path.join(ROOT, "scripts/extract-wxml-symbols.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extract(file) {
  const out = execFileSync(process.execPath, [EXTRACTOR, file], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out);
}

// S-W1: external <wxs module="format" src="../../utils/format.wxs" /> in home.wxml
// produces a wxs symbol with nameRange covering the `format` characters only.
function testExternalWxsNameRange() {
  const result = extract("fixtures/miniprogram/pages/home/home.wxml");
  const file = result[0];
  const wxs = file.symbols.find((s) => s.kind === "wxs" && s.name === "format");
  assert(wxs, `S-W1: expected wxs symbol named 'format'; got ${JSON.stringify(file.symbols)}`);
  assert(wxs.nameRange, `S-W1: expected nameRange on wxs symbol; got ${JSON.stringify(wxs)}`);
  // home.wxml line 3 (0-based row 2): `<wxs module="format" src="../../utils/format.wxs" />`
  //                                          ^col 13           ^col 19 (exclusive end after "format")
  assert(wxs.nameRange.start.row === 2, `S-W1: row ${wxs.nameRange.start.row}`);
  assert(wxs.nameRange.start.column === 13, `S-W1: start col ${wxs.nameRange.start.column}`);
  assert(wxs.nameRange.end.row === 2, `S-W1: end row ${wxs.nameRange.end.row}`);
  assert(wxs.nameRange.end.column === 19, `S-W1: end col ${wxs.nameRange.end.column}`);
}

// S-W2: inline <wxs module="inline">...</wxs> in fixtures/test.wxml line 93 (row 92)
function testInlineWxsNameRange() {
  const result = extract("fixtures/test.wxml");
  const file = result[0];
  const wxs = file.symbols.find((s) => s.kind === "wxs" && s.name === "inline");
  assert(wxs, `S-W2: expected wxs symbol named 'inline'; got ${JSON.stringify(file.symbols)}`);
  assert(wxs.nameRange, `S-W2: expected nameRange on inline wxs symbol; got ${JSON.stringify(wxs)}`);
  assert(wxs.nameRange.start.row === wxs.nameRange.end.row,
    `S-W2: nameRange spans rows ${wxs.nameRange.start.row}->${wxs.nameRange.end.row}`);
  // narrow: end - start must equal the name length (6 chars: "inline")
  assert(wxs.nameRange.end.column - wxs.nameRange.start.column === 6,
    `S-W2: expected 6-char-wide nameRange, got ${wxs.nameRange.end.column - wxs.nameRange.start.column}`);
}

// S-W3: a <wxs ... /> without a `module` attribute produces no symbol entry
// (pre-existing behavior; assert it explicitly so the new nameRange code path
// doesn't accidentally start synthesizing empty-named symbols).
function testMalformedWxsProducesNoSymbol() {
  // wxs-injection.wxml line 12: `<wxs src="./fallback-only.wxs">` — no module attr.
  const result = extract("fixtures/wxs-injection.wxml");
  const file = result[0];
  const noNameWxs = file.symbols.filter((s) => s.kind === "wxs" && !s.name);
  assert(noNameWxs.length === 0,
    `S-W3: expected no nameless wxs symbol; got ${JSON.stringify(noNameWxs)}`);
}

const CASES = [
  ["S-W1: external wxs nameRange", testExternalWxsNameRange],
  ["S-W2: inline wxs nameRange", testInlineWxsNameRange],
  ["S-W3: malformed wxs produces no symbol", testMalformedWxsProducesNoSymbol],
];

let passed = 0, failed = 0;
for (const [label, fn] of CASES) {
  try {
    fn();
    process.stdout.write(`PASS ${label}\n`);
    passed += 1;
  } catch (err) {
    process.stdout.write(`FAIL ${label}\n  ${err.message}\n`);
    failed += 1;
  }
}
process.stdout.write(`\nResult: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`
Expected: both S-W1 and S-W2 FAIL with messages like "expected nameRange on wxs symbol".

- [ ] **Step 3: Implement `wxs.nameRange` in the extractor**

In `shared/wxml-symbol-extractor.mjs`, modify the `wxs_external` and `wxs_inline` branches (around lines 245-271).

Replace this block:

```js
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
    }
```

with:

```js
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
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`
Expected: `PASS S-W1`, `PASS S-W2`, `PASS S-W3`, `Result: 3 passed, 0 failed`. (S-W3 — malformed wxs produces no symbol — already passes against the existing extractor behavior; the new code path doesn't regress it.)

- [ ] **Step 5: Regenerate symbol baselines**

The additive `nameRange` field will break every existing baseline that contains a wxs symbol. Regenerate each affected baseline:

```bash
node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > fixtures/wasm-spike/home-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs $(find fixtures/miniprogram -name "*.wxml" | sort) > fixtures/wasm-spike/miniprogram-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/test.wxml > fixtures/wasm-spike/test-wxml-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/real-world/component.wxml fixtures/real-world/page.wxml fixtures/real-world/templates.wxml > fixtures/wasm-spike/real-world-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/real-world/edge-recovery.wxml > fixtures/wasm-spike/edge-recovery-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/non-ascii.wxml > fixtures/wasm-spike/non-ascii-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/wx-for-unquoted.wxml > fixtures/wasm-spike/wx-for-unquoted-symbols-baseline.json
```

Verify the diffs are **only** new `nameRange` blocks on wxs symbol entries. Because `nameRange` is a nested object (`"nameRange": { "start": { "row": .., "column": .. }, "end": { ... } }`), a textual grep would false-positive on the inner `start`/`row`/`column` lines. Instead, inspect manually:

```bash
git diff fixtures/wasm-spike/
```

Skim the diff. Every added block must be a `nameRange: { ... }` value attached to a symbols[].kind === "wxs" entry. Confirm:
1. No deletions of existing fields.
2. No additions outside `nameRange` keys on wxs symbols.
3. The number of added `nameRange` keys equals the number of wxs symbol entries across all touched baselines.

If anything else changed, STOP and investigate.

- [ ] **Step 6: Wire the new verifier into the umbrella**

Modify `scripts/verify-tree-sitter.sh`. Find the existing line:

```
node "$ROOT_DIR/scripts/verify-wasm-symbol-baselines.mjs"
```

Add this line directly after it:

```
node "$ROOT_DIR/scripts/verify-wxml-narrow-ranges.mjs"
```

- [ ] **Step 7: Run the baseline verifier + new verifier to confirm everything passes**

Run: `node scripts/verify-wasm-symbol-baselines.mjs && node scripts/verify-wxml-narrow-ranges.mjs`
Expected: both report all cases passing.

- [ ] **Step 8: Commit**

```bash
git add shared/wxml-symbol-extractor.mjs scripts/verify-wxml-narrow-ranges.mjs scripts/verify-tree-sitter.sh fixtures/wasm-spike/
git commit -m "feat: add narrow nameRange to wxs module symbols

Extends shared/wxml-symbol-extractor.mjs to attach an inner-value range
on wxs symbols pointing at the module=\"X\" characters. Hover v1 hit-tests
against this range so that hovering inside <wxs> children does not
mis-trigger. graph.version is unchanged (additive field). Symbol
baselines regenerated to include the new key."
```

---

## Task 2: Add `components.tagNameRange` to symbol extractor

**Files:**
- Modify: `shared/wxml-symbol-extractor.mjs` (around line 294-300)
- Modify: `scripts/verify-wxml-narrow-ranges.mjs` (add S-C cases)
- Regenerate: `fixtures/wasm-spike/*-symbols-baseline.json`

**Background:** `fileModel.components[]` entries push `{ tag, range }` where `range` is the whole element (line 299). Hover needs a `tagNameRange` covering only the tag-name token of the start tag. The tag_name node is already located at line 297 (`firstChildOfType(tag, "tag_name")`); we just need its position via `rangeOf`.

- [ ] **Step 1: Extend the focused verifier with S-C cases**

Edit `scripts/verify-wxml-narrow-ranges.mjs`. Add these test functions before the `CASES` array:

```js
// S-C1: <user-card ...> in home.wxml line 8 (row 7) produces a component
// with tagNameRange covering only "user-card" chars.
function testComponentTagNameRange() {
  const result = extract("fixtures/miniprogram/pages/home/home.wxml");
  const file = result[0];
  const comp = file.components.find((c) => c.tag === "user-card");
  assert(comp, `S-C1: expected component 'user-card'; got ${JSON.stringify(file.components)}`);
  assert(comp.tagNameRange, `S-C1: expected tagNameRange; got ${JSON.stringify(comp)}`);
  // home.wxml line 8: `  <user-card`
  //                     ^col 3 (after "  <") ... 9 chars of "user-card" → end col 12
  assert(comp.tagNameRange.start.row === 7, `S-C1: start row ${comp.tagNameRange.start.row}`);
  assert(comp.tagNameRange.start.column === 3, `S-C1: start col ${comp.tagNameRange.start.column}`);
  assert(comp.tagNameRange.end.column - comp.tagNameRange.start.column === "user-card".length,
    `S-C1: width ${comp.tagNameRange.end.column - comp.tagNameRange.start.column}`);
}

// S-C2: self-closing <global-badge label="..." /> in home.wxml line 16 (row 15)
// also produces tagNameRange (self_closing_tag path).
function testSelfClosingComponentTagNameRange() {
  const result = extract("fixtures/miniprogram/pages/home/home.wxml");
  const file = result[0];
  const comp = file.components.find((c) => c.tag === "global-badge");
  assert(comp, `S-C2: expected component 'global-badge'; got ${JSON.stringify(file.components)}`);
  assert(comp.tagNameRange, `S-C2: expected tagNameRange on self-closing; got ${JSON.stringify(comp)}`);
  assert(comp.tagNameRange.end.column - comp.tagNameRange.start.column === "global-badge".length,
    `S-C2: width ${comp.tagNameRange.end.column - comp.tagNameRange.start.column}`);
}
```

Append the new cases to the `CASES` array (after the existing two):

```js
  ["S-C1: component tagNameRange (start tag)", testComponentTagNameRange],
  ["S-C2: component tagNameRange (self-closing tag)", testSelfClosingComponentTagNameRange],
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`
Expected: S-W1, S-W2, S-W3 PASS; S-C1, S-C2 FAIL with "expected tagNameRange".

- [ ] **Step 3: Implement `tagNameRange` on components**

In `shared/wxml-symbol-extractor.mjs`, modify the element branch around line 294. Replace:

```js
    } else if (node.type === "element") {
      const tag = firstChildOfType(node, "start_tag") ?? firstChildOfType(node, "self_closing_tag");
      if (tag) {
        const name = firstChildOfType(tag, "tag_name")?.text;
        if (name && name.includes("-") && !CONTROL_TAGS.has(name) && !BUILTIN_TAGS.has(name)) {
          components.push({ tag: name, range: rangeOf(node) });
        }
      }
    }
```

with:

```js
    } else if (node.type === "element") {
      const tag = firstChildOfType(node, "start_tag") ?? firstChildOfType(node, "self_closing_tag");
      if (tag) {
        const tagNameNode = firstChildOfType(tag, "tag_name");
        const name = tagNameNode?.text;
        if (name && name.includes("-") && !CONTROL_TAGS.has(name) && !BUILTIN_TAGS.has(name)) {
          const entry = { tag: name, range: rangeOf(node) };
          if (tagNameNode) entry.tagNameRange = rangeOf(tagNameNode);
          components.push(entry);
        }
      }
    }
```

- [ ] **Step 4: Run to verify all narrow-range cases pass**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`
Expected: `Result: 5 passed, 0 failed` (S-W1, S-W2, S-W3, S-C1, S-C2).

- [ ] **Step 5: Regenerate baselines for the components change**

Same commands as Task 1 Step 5. Then inspect the diff manually:

```bash
git diff fixtures/wasm-spike/
```

Confirm every new block is a `tagNameRange: { ... }` value attached to a `components[]` entry. Confirm:
1. No deletions of existing fields.
2. No additions outside `tagNameRange` keys on component entries.
3. The number of added `tagNameRange` keys equals the number of component entries across all touched baselines.

If anything else changed, STOP and investigate.

- [ ] **Step 6: Run the baseline verifier to confirm**

Run: `node scripts/verify-wasm-symbol-baselines.mjs`
Expected: all cases pass.

- [ ] **Step 7: Commit**

```bash
git add shared/wxml-symbol-extractor.mjs scripts/verify-wxml-narrow-ranges.mjs fixtures/wasm-spike/
git commit -m "feat: add narrow tagNameRange to custom component symbols

Extends fileModel.components[] entries with a tagNameRange covering only
the tag-name token of the start (or self-closing) tag. Hover v1 uses
this range so that hovering inside <local-card>'s children does not
mis-trigger the component card. graph.version is unchanged (additive
field)."
```

---

## Task 3: Scaffold `getHover()` + expression-ref branch (dataKey / propertyKey)

**Files:**
- Modify: `server/wxml-language-service.mjs` (add `getHover`, `formatHoverMarkdown`, `relativeToGraphRoot` helpers)
- Modify: `scripts/verify-wxml-language-service.mjs` (add H-1, H-2, H-3, H-4, H-11, H-12 scenarios + import)

**Background:** The hover handler returns an LSP `Hover` object `{ contents: { kind: "markdown", value }, range }` or `null`. The expression-ref AUTHORITATIVE branch chains lookups: `dataKeys` → `propertyKeys` → in-file wxs symbol names. This task implements the first two lookups only; the wxs fallback is added in Task 4.

- [ ] **Step 1: Add the failing hover scenarios to the language-service verifier**

Edit `scripts/verify-wxml-language-service.mjs`. First, extend the import at line 7-12 to include `getHover`:

```js
import {
  getCompletions,
  getDefinition,
  getDiagnostics,
  getDocumentSymbols,
  getHover,
} from "../server/wxml-language-service.mjs";
```

Then add this block of test functions after the existing data-ref definition tests (search for `assertDataRefDefinitionMissingKeyReturnsNull` and insert after that function's closing `}`):

```js
// Phase 3 Stage C — Hover v1 ------------------------------------------------

function hoverContents(hover) {
  if (!hover) return null;
  return hover.contents && hover.contents.value;
}

function assertHoverOnDataRef(graph) {
  // home.wxml line 5 (row 4): `<view class="home {{theme}}">`
  // 'theme' starts at col 20; cursor mid-name at col 22.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 4, character: 22 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-1: expected Hover, got null");
  const value = hoverContents(hover);
  assert(value.startsWith("**theme** — `data`"), `H-1: bad title: ${value}`);
  assert(value.includes("Defined in `pages/home/home.js:"), `H-1: bad source line: ${value}`);
  assert(hover.contents.kind === "markdown", `H-1: kind ${hover.contents.kind}`);
  assert(hover.range, "H-1: expected range");
}

function assertHoverOnPropertyRef(graph) {
  // user-card.wxml line 2 (row 1): expressionRef `user` → property
  const hover = getHover({
    graph,
    documentPath: USER_CARD_WXML,
    position: { line: 1, character: 25 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-2: expected Hover, got null");
  const value = hoverContents(hover);
  assert(value.startsWith("**user** — `property`"), `H-2: bad title: ${value}`);
  assert(value.includes("Defined in `components/user-card/user-card.js:"), `H-2: bad source line: ${value}`);
}

function assertHoverInTemplateDefinitionReturnsNull(graph) {
  // H-12: synthesize an expressionRef inside template_definition. Hover must
  // short-circuit and return null even though "theme" is a real data key.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.expressionRefs;
  const synthetic = {
    name: "theme",
    source: "interpolation",
    inTemplateDefinition: true,
    range: { start: { row: 100, column: 0 }, end: { row: 100, column: 5 } },
    expressionRange: { start: { row: 100, column: 0 }, end: { row: 100, column: 5 } },
  };
  homeFile.expressionRefs = [...original, synthetic];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 100, character: 2 },
      extensionRoot: ROOT,
    });
    assert(hover === null, `H-12: expected null in template_definition, got ${JSON.stringify(hover)}`);
  } finally {
    homeFile.expressionRefs = original;
  }
}

function assertHoverOnMemberChainReturnsNull(graph) {
  // H-11: cursor on `name` in `{{user.name}}`. topLevelIdentifiers skips
  // identifiers preceded by ".", so no expressionRef is produced for `name`.
  // user-card.wxml has `{{user.name}}` near the start.
  // 'name' would start at col 30 on row 1; verify hover returns null.
  const hover = getHover({
    graph,
    documentPath: USER_CARD_WXML,
    position: { line: 1, character: 30 },
    extensionRoot: ROOT,
  });
  assert(hover === null, `H-11: expected null on member chain, got ${JSON.stringify(hover)}`);
}

function assertHoverOnMissingDataReturnsNull(graph) {
  // H-4 negative twin: temporarily remove `theme` from dataKeys, hover must return null.
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  const original = homeConfig.script.dataKeys;
  homeConfig.script.dataKeys = original.filter((k) => k.name !== "theme");
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 4, character: 22 },
      extensionRoot: ROOT,
    });
    assert(hover === null, `H-4 (missing key): expected null, got ${JSON.stringify(hover)}`);
  } finally {
    homeConfig.script.dataKeys = original;
  }
}

function assertHoverSourceLabelsDataKind(graph) {
  // H-3: a key whose source is "setData" gets `setData` kind, not `data`.
  // We synthesize on home.js script so we don't depend on a specific fixture.
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  const originalKeys = homeConfig.script.dataKeys;
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const originalRefs = homeFile.expressionRefs;
  const syntheticKey = {
    name: "__hover_test_setData__",
    nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 5 } },
    source: "setData",
  };
  const syntheticRef = {
    name: "__hover_test_setData__",
    source: "interpolation",
    inTemplateDefinition: false,
    range: { start: { row: 200, column: 0 }, end: { row: 200, column: 5 } },
    expressionRange: { start: { row: 200, column: 0 }, end: { row: 200, column: 5 } },
  };
  homeConfig.script.dataKeys = [...originalKeys, syntheticKey];
  homeFile.expressionRefs = [...originalRefs, syntheticRef];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 200, character: 2 },
      extensionRoot: ROOT,
    });
    assert(hover, "H-3 (setData): expected Hover");
    const value = hoverContents(hover);
    assert(value.startsWith("**__hover_test_setData__** — `setData`"), `H-3: bad kind label: ${value}`);
  } finally {
    homeConfig.script.dataKeys = originalKeys;
    homeFile.expressionRefs = originalRefs;
  }
}

function assertHoverSourceLabelsInjectorKind(graph) {
  // H-4: a key whose source is "injector" gets `injector` kind.
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  const originalKeys = homeConfig.script.dataKeys;
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const originalRefs = homeFile.expressionRefs;
  const syntheticKey = {
    name: "__hover_test_injector__",
    nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 5 } },
    source: "injector",
  };
  const syntheticRef = {
    name: "__hover_test_injector__",
    source: "interpolation",
    inTemplateDefinition: false,
    range: { start: { row: 201, column: 0 }, end: { row: 201, column: 5 } },
    expressionRange: { start: { row: 201, column: 0 }, end: { row: 201, column: 5 } },
  };
  homeConfig.script.dataKeys = [...originalKeys, syntheticKey];
  homeFile.expressionRefs = [...originalRefs, syntheticRef];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 201, character: 2 },
      extensionRoot: ROOT,
    });
    assert(hover, "H-4 (injector): expected Hover");
    const value = hoverContents(hover);
    assert(value.startsWith("**__hover_test_injector__** — `injector`"), `H-4: bad kind label: ${value}`);
  } finally {
    homeConfig.script.dataKeys = originalKeys;
    homeFile.expressionRefs = originalRefs;
  }
}
```

Register the new scenarios in the `SCENARIOS` table (or wherever runners are dispatched — search for the existing pattern that calls `assertDataRefDefinitionToData(graph)` and add parallel calls):

```js
  ["H-1 hover on data ref", assertHoverOnDataRef],
  ["H-2 hover on property ref", assertHoverOnPropertyRef],
  ["H-3 hover labels setData source", assertHoverSourceLabelsDataKind],
  ["H-4 hover labels injector source", assertHoverSourceLabelsInjectorKind],
  ["H-11 hover on member chain returns null", assertHoverOnMemberChainReturnsNull],
  ["H-12 hover in template definition returns null", assertHoverInTemplateDefinitionReturnsNull],
```

(If `verify-wxml-language-service.mjs` uses a flat `for` loop over function literals rather than a labelled array, append direct calls to the runner block at the bottom of the file — match the existing convention.)

- [ ] **Step 2: Run to verify these all fail**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: FAIL with "getHover is not a function" or undefined export error.

- [ ] **Step 3: Implement helpers + scaffold `getHover` + expression-ref dataKey/propertyKey branches**

In `server/wxml-language-service.mjs`, add three new internal helpers and one exported function. Insert immediately before the `getDefinition` definition (around line 961).

First, the helpers:

```js
// ---- Hover (Phase 3 Stage C) ---------------------------------------------

const HOVER_KIND_LABELS = {
  data: "data",
  setData: "setData",
  injector: "injector",
  property: "property",
  pageMethod: "page method",
  componentMethod: "component method",
  customComponent: "custom component",
  wxsModule: "wxs module",
};

function relativeToGraphRoot(graphPath, graphRoot) {
  // Returns null when graphPath escapes graphRoot — never leak absolute paths.
  if (!isInsideGraphRoot(graphPath, graphRoot)) return null;
  const rel = path.posix.relative(graphRoot, graphPath);
  return rel === "" ? graphPath : rel;
}

function formatHoverMarkdown({ name, kindLabel, sourcePath, sourceLine, arrow, inlineNote }) {
  const title = `**${name}** — \`${kindLabel}\``;
  let source;
  if (inlineNote) {
    source = inlineNote;
  } else if (arrow) {
    source = `→ \`${sourcePath}\``;
  } else {
    source = `Defined in \`${sourcePath}:${sourceLine}\``;
  }
  return `${title}\n\n${source}`;
}

function hoverFromGraphPathLocation({ name, kindLabel, scriptPath, nameRange, graphRoot, refRange }) {
  const rel = relativeToGraphRoot(scriptPath, graphRoot);
  if (!rel) return null;
  return {
    contents: {
      kind: "markdown",
      value: formatHoverMarkdown({
        name,
        kindLabel,
        sourcePath: rel,
        sourceLine: nameRange.start.row + 1,
      }),
    },
    range: rangeFromSymbolRange(refRange),
  };
}
```

Next, `getHover` itself. Add immediately before `getDefinition`:

```js
export function getHover({ graph, documentPath, position, extensionRoot }) {
  if (!position || typeof position.line !== "number" || typeof position.character !== "number") {
    return null;
  }
  const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) return null;

  // 1. Event handler match — TODO Task 5.

  // 2. Expression ref match — AUTHORITATIVE.
  const expressionRefMatch = (fileModel.expressionRefs ?? [])
    .find((entry) => containsPosition(entry.range, position));
  if (expressionRefMatch) {
    if (expressionRefMatch.inTemplateDefinition) return null;
    const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
    if (!ownerConfig) return null;

    // 2a. dataKeys lookup → kind label per dataKey.source
    const dataKey = (ownerConfig.script.dataKeys ?? []).find((k) => k.name === expressionRefMatch.name);
    if (dataKey) {
      const kindLabel = HOVER_KIND_LABELS[dataKey.source] ?? HOVER_KIND_LABELS.data;
      return hoverFromGraphPathLocation({
        name: dataKey.name,
        kindLabel,
        scriptPath: ownerConfig.script.path,
        nameRange: dataKey.nameRange,
        graphRoot: graph.root,
        refRange: expressionRefMatch.range,
      });
    }

    // 2b. propertyKeys lookup → kind label "property"
    const propKey = (ownerConfig.script.propertyKeys ?? []).find((k) => k.name === expressionRefMatch.name);
    if (propKey) {
      return hoverFromGraphPathLocation({
        name: propKey.name,
        kindLabel: HOVER_KIND_LABELS.property,
        scriptPath: ownerConfig.script.path,
        nameRange: propKey.nameRange,
        graphRoot: graph.root,
        refRange: expressionRefMatch.range,
      });
    }

    // 2c. wxs symbol fallback — TODO Task 4.

    return null;
  }

  // 3. Component tag match — TODO Task 6.
  // 4. Wxs module declaration match — TODO Task 7.

  return null;
}
```

- [ ] **Step 4: Run hover scenarios to confirm they pass**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: H-1, H-2, H-3, H-4, H-11, H-12 all PASS. No regressions in existing scenarios.

- [ ] **Step 5: Commit**

```bash
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat: scaffold getHover with expression-ref data/property branch

Adds exported getHover() to server/wxml-language-service.mjs with the
expression-ref AUTHORITATIVE branch resolving against dataKeys (kind
labels: data/setData/injector) and propertyKeys (kind label: property).
Returns LSP Hover with two-line markdown and a narrow range. Other
matchers (event handler, component, wxs declaration) and the wxs
expression-ref fallback land in subsequent commits."
```

---

## Task 4: Add wxs cross-reference fallback to expression-ref branch

**Files:**
- Modify: `server/wxml-language-service.mjs` (the TODO comment "2c. wxs symbol fallback" placeholder)
- Modify: `scripts/verify-wxml-language-service.mjs` (add H-10)

**Background:** `home.wxml` has `{{format.price(total)}}` on line 19 (row 18). `format` is a wxs module name. Step 2c looks up `fileModel.symbols` for `{ kind: "wxs", name: "format" }` and renders kind label `wxs module` with the external wxs's resolved file path.

- [ ] **Step 1: Write the failing test H-10**

Add to `scripts/verify-wxml-language-service.mjs` next to the other hover scenarios:

```js
function assertHoverOnWxsExpressionRef(graph) {
  // H-10: home.wxml line 19 (row 18): `    {{format.price(total)}}`
  // 'format' starts at col 6; cursor mid-name at col 8.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 18, character: 8 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-10: expected Hover for {{format.x}}");
  const value = hoverContents(hover);
  assert(value.startsWith("**format** — `wxs module`"), `H-10: bad title: ${value}`);
  assert(value.includes("→ `utils/format.wxs`"), `H-10: bad source line: ${value}`);
}
```

Register:

```js
  ["H-10 hover on wxs ident in interpolation", assertHoverOnWxsExpressionRef],
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: H-10 FAIL ("expected Hover for {{format.x}}", got `null` because step 2c is not implemented).

- [ ] **Step 3: Implement step 2c**

In `server/wxml-language-service.mjs`, replace the `// 2c. wxs symbol fallback — TODO Task 4.` placeholder with:

```js
    // 2c. In-file wxs symbol names → kind label "wxs module"
    const wxsSymbol = (fileModel.symbols ?? [])
      .find((s) => s.kind === "wxs" && s.name === expressionRefMatch.name);
    if (wxsSymbol) {
      // External wxs has a matching dependency entry whose `normalized` is the file path.
      const wxsDep = (fileModel.dependencies ?? [])
        .find((d) => d.kind === "wxs" && d.module === expressionRefMatch.name && d.normalized);
      if (wxsDep) {
        const rel = relativeToGraphRoot(wxsDep.normalized, graph.root);
        if (!rel) return null;
        return {
          contents: {
            kind: "markdown",
            value: formatHoverMarkdown({
              name: expressionRefMatch.name,
              kindLabel: HOVER_KIND_LABELS.wxsModule,
              sourcePath: rel,
              arrow: true,
            }),
          },
          range: rangeFromSymbolRange(expressionRefMatch.range),
        };
      }
      // Inline wxs (no dependency entry): no file path to point at.
      return {
        contents: {
          kind: "markdown",
          value: formatHoverMarkdown({
            name: expressionRefMatch.name,
            kindLabel: HOVER_KIND_LABELS.wxsModule,
            inlineNote: "inline wxs module in this file",
          }),
        },
        range: rangeFromSymbolRange(expressionRefMatch.range),
      };
    }
```

- [ ] **Step 4: Run to verify H-10 passes**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: H-10 PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat: hover wxs module refs in interpolations

Extends getHover's expression-ref branch with step 2c: when the name
matches an in-file wxs symbol, render kind label \"wxs module\" and
point at the resolved .wxs file (external) or note \"inline wxs module
in this file\" (inline). Stays inside the AUTHORITATIVE expression-ref
branch — no fall-through to other matchers."
```

---

## Task 5: Add event-handler hover branch

**Files:**
- Modify: `server/wxml-language-service.mjs` (the `// 1. Event handler match — TODO Task 5.` placeholder)
- Modify: `scripts/verify-wxml-language-service.mjs` (add H-5, H-6, H-17)

**Background:** `home.wxml` line 12 has `bind:select="handleSelect"`. Hover on `handleSelect` resolves through `script.methods`. Kind is `page method` when `ownerConfig.kind === "page"`, `component method` when `ownerConfig.kind === "component"`. Dynamic handlers (`bindtap="{{...}}"`) return null.

- [ ] **Step 1: Write failing tests H-5, H-6, H-17**

Add to `scripts/verify-wxml-language-service.mjs`:

```js
function assertHoverOnPageMethod(graph) {
  // home.wxml line 12 (row 11): `    bind:select="handleSelect"`
  // 'handleSelect' starts inside the quotes. Cursor at character mid-name.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 11, character: 22 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-5: expected Hover for page method handleSelect");
  const value = hoverContents(hover);
  assert(value.startsWith("**handleSelect** — `page method`"), `H-5: bad title: ${value}`);
  assert(value.includes("Defined in `pages/home/home.js:"), `H-5: bad source: ${value}`);
}

function assertHoverOnComponentMethod(graph) {
  // H-6: user-card.wxml has no bind*/catch* in the fixture, but user-card.js
  // does declare a method `onCardTap` and user-card.json sets component: true.
  // Synthesize an eventHandler on the user-card file model whose handler name
  // matches the existing method, then hover at the synthetic nameRange.
  const userCardGraphPath = path.posix.relative(ROOT, USER_CARD_WXML).split(path.sep).join("/");
  const userCardFile = graph.wxml.find((f) => f.path === userCardGraphPath);
  assert(userCardFile, "H-6 setup: user-card file model");
  const userCardConfig = graph.configs.find((c) => c.owner === userCardGraphPath);
  assert(userCardConfig && userCardConfig.kind === "component",
    `H-6 setup: user-card config must be kind=component; got ${JSON.stringify(userCardConfig?.kind)}`);
  assert(userCardConfig.script.methods.some((m) => m.name === "onCardTap"),
    `H-6 setup: user-card.js must declare onCardTap; got ${JSON.stringify(userCardConfig.script.methods.map((m) => m.name))}`);
  const original = userCardFile.eventHandlers;
  const synthetic = {
    event: "tap",
    handler: "onCardTap",
    binding: "bind:",
    dynamic: false,
    range: { start: { row: 120, column: 0 }, end: { row: 120, column: 25 } },
    nameRange: { start: { row: 120, column: 10 }, end: { row: 120, column: 19 } },
  };
  userCardFile.eventHandlers = [...original, synthetic];
  try {
    const hover = getHover({
      graph,
      documentPath: USER_CARD_WXML,
      position: { line: 120, character: 15 },
      extensionRoot: ROOT,
    });
    assert(hover, "H-6: expected Hover for component method");
    const value = hoverContents(hover);
    assert(value.startsWith("**onCardTap** — `component method`"),
      `H-6: bad title: ${value}`);
    assert(value.includes("Defined in `components/user-card/user-card.js:"),
      `H-6: bad source: ${value}`);
  } finally {
    userCardFile.eventHandlers = original;
  }
}

function assertHoverOnDynamicHandlerReturnsNull(graph) {
  // H-17: synthesize a dynamic event handler entry; hover must return null.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.eventHandlers;
  const synthetic = {
    event: "tap",
    handler: "{{maybeHandler}}",
    binding: "bind:",
    dynamic: true,
    range: { start: { row: 110, column: 0 }, end: { row: 110, column: 25 } },
    nameRange: { start: { row: 110, column: 5 }, end: { row: 110, column: 20 } },
  };
  homeFile.eventHandlers = [...original, synthetic];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 110, character: 10 },
      extensionRoot: ROOT,
    });
    assert(hover === null, `H-17: expected null on dynamic handler, got ${JSON.stringify(hover)}`);
  } finally {
    homeFile.eventHandlers = original;
  }
}
```

Register:

```js
  ["H-5 hover on page method handler", assertHoverOnPageMethod],
  ["H-6 hover on component method handler", assertHoverOnComponentMethod],
  ["H-17 hover on dynamic handler returns null", assertHoverOnDynamicHandlerReturnsNull],
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: H-5, H-6, H-17 FAIL (event handler branch is still a TODO).

- [ ] **Step 3: Implement event-handler branch**

In `server/wxml-language-service.mjs`, replace `// 1. Event handler match — TODO Task 5.` with:

```js
  const eventHandlerMatch = (fileModel.eventHandlers ?? [])
    .find((entry) => containsPosition(entry.nameRange, position));
  if (eventHandlerMatch) {
    if (eventHandlerMatch.dynamic) return null;
    const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
    if (!ownerConfig) return null;
    const method = ownerConfig.script.methods.find((m) => m.name === eventHandlerMatch.handler);
    if (!method) return null;
    const kindLabel = ownerConfig.kind === "component"
      ? HOVER_KIND_LABELS.componentMethod
      : HOVER_KIND_LABELS.pageMethod;
    return hoverFromGraphPathLocation({
      name: method.name,
      kindLabel,
      scriptPath: ownerConfig.script.path,
      nameRange: method.nameRange,
      graphRoot: graph.root,
      refRange: eventHandlerMatch.nameRange,
    });
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: H-5, H-6, H-17 PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat: hover event handlers as page/component methods

Adds the event-handler AUTHORITATIVE branch to getHover. Resolves the
handler name against ownerConfig.script.methods and labels the kind by
ownerConfig.kind (\"page\" -> page method, \"component\" -> component
method). Dynamic handlers (bindtap=\"{{x}}\") return null."
```

---

## Task 6: Add component-tag hover branch

**Files:**
- Modify: `server/wxml-language-service.mjs` (the `// 3. Component tag match — TODO Task 6.` placeholder)
- Modify: `scripts/verify-wxml-language-service.mjs` (add H-7, H-18, H-19)

**Background:** `home.wxml` line 8 has `<user-card ...>`. Hover on the tag name resolves through `graph.usingComponents` to the target WXML path. Hovering inside children must return null (Task 2's `tagNameRange` enables this).

- [ ] **Step 1: Write failing tests H-7, H-18, H-19**

```js
function assertHoverOnCustomComponent(graph) {
  // home.wxml line 8 (row 7): `  <user-card`
  // tag name starts at col 3; cursor mid-name at col 5.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 7, character: 5 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-7: expected Hover for <user-card>");
  const value = hoverContents(hover);
  assert(value.startsWith("**user-card** — `custom component`"), `H-7: bad title: ${value}`);
  assert(value.includes("→ `components/user-card/user-card.wxml`"), `H-7: bad source: ${value}`);
}

function assertHoverInsideComponentChildrenReturnsNull(graph) {
  // H-18: cursor in whitespace inside <user-card ...> children (e.g. column
  // 10 of line 9 which is `    wx:for="{{users}}"` — that's inside the
  // user-card start tag but past tag_name). tagNameRange must restrict.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 8, character: 4 },
    extensionRoot: ROOT,
  });
  // We expect null because: not in any expressionRef, not in any
  // eventHandler.nameRange at that position, and outside tagNameRange.
  assert(hover === null, `H-18: expected null inside user-card start-tag attributes, got ${JSON.stringify(hover)}`);
}

function assertHoverOnClosingTagReturnsNull(graph) {
  // H-19: home.wxml has no closing </user-card> (self-closing structure),
  // so synthesize position past the start-tag's tagNameRange boundary.
  // Pick a column known to be after tagNameRange.end on the start-tag row.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 7, character: 20 },
    extensionRoot: ROOT,
  });
  assert(hover === null, `H-19: expected null past tagNameRange end, got ${JSON.stringify(hover)}`);
}

function assertHoverComponentLegacyGraphDegradesGracefully(graph) {
  // S-C3: legacy graph without tagNameRange — hover must return null instead
  // of falling back to the wide element range.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.components;
  homeFile.components = original.map((c) => {
    const { tagNameRange: _tnr, ...rest } = c;
    return rest;
  });
  try {
    // Cursor mid-tag of <user-card> on line 8 (row 7), col 5.
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 7, character: 5 },
      extensionRoot: ROOT,
    });
    assert(hover === null,
      `S-C3: legacy graph (no tagNameRange) must not trigger component hover; got ${JSON.stringify(hover)}`);
  } finally {
    homeFile.components = original;
  }
}
```

Register:

```js
  ["H-7 hover on custom component tag", assertHoverOnCustomComponent],
  ["H-18 hover inside component children returns null", assertHoverInsideComponentChildrenReturnsNull],
  ["H-19 hover past tagNameRange returns null", assertHoverOnClosingTagReturnsNull],
  ["S-C3 component hover legacy graph degrades", assertHoverComponentLegacyGraphDegradesGracefully],
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: H-7, H-18, H-19 FAIL (component branch still TODO).

- [ ] **Step 3: Implement component branch**

In `server/wxml-language-service.mjs`, replace `// 3. Component tag match — TODO Task 6.` with:

```js
  const componentMatch = (fileModel.components ?? [])
    .find((entry) => entry.tagNameRange && containsPosition(entry.tagNameRange, position));
  if (componentMatch) {
    const usingComponent = graph.usingComponents.find((entry) => (
      entry.owner === documentGraphPath &&
      entry.tag === componentMatch.tag &&
      entry.resolved === true &&
      entry.target
    ));
    if (!usingComponent) return null;
    const rel = relativeToGraphRoot(usingComponent.target, graph.root);
    if (!rel) return null;
    return {
      contents: {
        kind: "markdown",
        value: formatHoverMarkdown({
          name: componentMatch.tag,
          kindLabel: HOVER_KIND_LABELS.customComponent,
          sourcePath: rel,
          arrow: true,
        }),
      },
      range: rangeFromSymbolRange(componentMatch.tagNameRange),
    };
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: H-7, H-18, H-19 PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat: hover custom component tags

Adds the component-tag branch to getHover, restricted to
component.tagNameRange so children and attribute regions do not
mis-trigger. Resolves through graph.usingComponents and renders the
target .wxml path. Falls back to null when the component is missing
from usingComponents."
```

---

## Task 7: Add wxs-declaration hover branch

**Files:**
- Modify: `server/wxml-language-service.mjs` (the `// 4. Wxs module declaration match — TODO Task 7.` placeholder)
- Modify: `scripts/verify-wxml-language-service.mjs` (add H-8, H-9, H-16)

**Background:** `home.wxml` line 3 has `<wxs module="format" src="../../utils/format.wxs" />`. Hover on `format` inside `module="format"` resolves to the resolved wxs file path (external) or notes "inline wxs module in this file" (inline). Cursor inside `<wxs>...</wxs>` body (not in nameRange) must return null.

- [ ] **Step 1: Write failing tests H-8, H-9, H-16**

```js
function assertHoverOnExternalWxsDeclaration(graph) {
  // H-8: home.wxml line 3 (row 2): `<wxs module="format" src="../../utils/format.wxs" />`
  // 'format' starts at col 13. Cursor mid-name at col 15.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 2, character: 15 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-8: expected Hover for external <wxs module=\"format\">");
  const value = hoverContents(hover);
  assert(value.startsWith("**format** — `wxs module`"), `H-8: bad title: ${value}`);
  assert(value.includes("→ `utils/format.wxs`"), `H-8: bad source: ${value}`);
}

function assertHoverOnInlineWxsDeclaration(graph) {
  // H-9: requires a fixture with inline <wxs module="X">. We use
  // fixtures/test.wxml line 93 (`<wxs module="inline">`).
  // But loadGraph() only extracts the mini-program fixture. To test inline
  // hover, we feed a synthetic fileModel via fileModelOverride? getHover
  // doesn't currently accept overrides. Instead: synthesize an inline wxs
  // symbol on the existing home file model.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.symbols;
  const syntheticSymbol = {
    kind: "wxs",
    name: "__hover_inline_wxs__",
    range: { start: { row: 300, column: 0 }, end: { row: 302, column: 6 } },
    nameRange: { start: { row: 300, column: 13 }, end: { row: 300, column: 32 } },
  };
  homeFile.symbols = [...original, syntheticSymbol];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 300, character: 20 },
      extensionRoot: ROOT,
    });
    assert(hover, "H-9: expected Hover for inline wxs");
    const value = hoverContents(hover);
    assert(value.startsWith("**__hover_inline_wxs__** — `wxs module`"), `H-9: bad title: ${value}`);
    assert(value.includes("inline wxs module in this file"), `H-9: bad source: ${value}`);
  } finally {
    homeFile.symbols = original;
  }
}

function assertHoverInsideWxsBodyReturnsNull(graph) {
  // H-16: cursor inside <wxs>...</wxs> body, NOT in module value range.
  // home.wxml has external self-closing wxs only, so synthesize symbol with
  // wide range but narrow nameRange, then put cursor in the gap.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.symbols;
  const syntheticSymbol = {
    kind: "wxs",
    name: "__hover_body_wxs__",
    range: { start: { row: 310, column: 0 }, end: { row: 315, column: 6 } },
    nameRange: { start: { row: 310, column: 13 }, end: { row: 310, column: 30 } },
  };
  homeFile.symbols = [...original, syntheticSymbol];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 312, character: 4 },  // inside body, outside nameRange
      extensionRoot: ROOT,
    });
    assert(hover === null, `H-16: expected null inside wxs body, got ${JSON.stringify(hover)}`);
  } finally {
    homeFile.symbols = original;
  }
}
```

Register:

```js
  ["H-8 hover on external wxs declaration", assertHoverOnExternalWxsDeclaration],
  ["H-9 hover on inline wxs declaration", assertHoverOnInlineWxsDeclaration],
  ["H-16 hover inside wxs body returns null", assertHoverInsideWxsBodyReturnsNull],
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: H-8, H-9, H-16 FAIL (wxs branch still TODO).

- [ ] **Step 3: Implement wxs-declaration branch**

In `server/wxml-language-service.mjs`, replace `// 4. Wxs module declaration match — TODO Task 7.` with:

```js
  const wxsDeclMatch = (fileModel.symbols ?? [])
    .find((s) => s.kind === "wxs" && s.nameRange && containsPosition(s.nameRange, position));
  if (wxsDeclMatch) {
    const wxsDep = (fileModel.dependencies ?? [])
      .find((d) => d.kind === "wxs" && d.module === wxsDeclMatch.name && d.normalized);
    if (wxsDep) {
      const rel = relativeToGraphRoot(wxsDep.normalized, graph.root);
      if (!rel) return null;
      return {
        contents: {
          kind: "markdown",
          value: formatHoverMarkdown({
            name: wxsDeclMatch.name,
            kindLabel: HOVER_KIND_LABELS.wxsModule,
            sourcePath: rel,
            arrow: true,
          }),
        },
        range: rangeFromSymbolRange(wxsDeclMatch.nameRange),
      };
    }
    return {
      contents: {
        kind: "markdown",
        value: formatHoverMarkdown({
          name: wxsDeclMatch.name,
          kindLabel: HOVER_KIND_LABELS.wxsModule,
          inlineNote: "inline wxs module in this file",
        }),
      },
      range: rangeFromSymbolRange(wxsDeclMatch.nameRange),
    };
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: H-8, H-9, H-16 PASS, no regressions.

- [ ] **Step 5: Add miss-case sweep (H-14, H-15; H-13 documented as covered elsewhere)**

Append these to the verifier:

```js
// H-13 (object-literal interpolation returns null) is intentionally NOT
// asserted in this verifier. The mechanism is `topLevelIdentifiers()`
// short-circuiting via `looksLikeObjectLiteralExpression()`, which is already
// covered by:
//   - scripts/verify-wxml-expression-helpers.mjs: "object literal shape"
//     (line ~24) and the looksLikeObjectLiteralExpression direct assertions
//     (line ~49-52).
// A hover-side test would either duplicate that coverage with a tautological
// position assertion, or require a new WXML fixture containing `{{ {a: 1} }}`.
// Hover's contract for "no expressionRef at position -> null" is covered by
// H-14 (whitespace) and H-15 (inside <import>). Keeping H-13 here would risk
// going green even if the helper regressed, so it is deliberately omitted.

function assertHoverInWhitespaceReturnsNull(graph) {
  // H-14: blank line 4 (row 3) in home.wxml.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 3, character: 0 },
    extensionRoot: ROOT,
  });
  assert(hover === null, `H-14: expected null in whitespace, got ${JSON.stringify(hover)}`);
}

function assertHoverInsideImportReturnsNull(graph) {
  // H-15: cursor inside <import src="..."> — dependency hover is out of scope.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 0, character: 10 },
    extensionRoot: ROOT,
  });
  assert(hover === null, `H-15: expected null inside <import>, got ${JSON.stringify(hover)}`);
}

function assertHoverWxsLegacyGraphDegradesGracefully(graph) {
  // S-W4: legacy graph without nameRange on wxs symbols — hover must return
  // null instead of falling back to the wide element range.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.symbols;
  homeFile.symbols = original.map((s) => {
    if (s.kind !== "wxs") return s;
    const { nameRange: _nr, ...rest } = s;
    return rest;
  });
  try {
    // Cursor mid-`format` of <wxs module="format" ...> on line 3 (row 2), col 15.
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 2, character: 15 },
      extensionRoot: ROOT,
    });
    assert(hover === null,
      `S-W4: legacy graph (no wxs nameRange) must not trigger wxs hover; got ${JSON.stringify(hover)}`);
  } finally {
    homeFile.symbols = original;
  }
}
```

Register:

```js
  // H-13 intentionally omitted — see comment block above (covered by
  // scripts/verify-wxml-expression-helpers.mjs).
  ["H-14 hover in whitespace returns null", assertHoverInWhitespaceReturnsNull],
  ["H-15 hover inside <import> returns null", assertHoverInsideImportReturnsNull],
  ["S-W4 wxs hover legacy graph degrades", assertHoverWxsLegacyGraphDegradesGracefully],
```

- [ ] **Step 6: Run to verify miss-case sweep passes**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: H-14, H-15 PASS.

- [ ] **Step 7: Commit**

```bash
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat: hover wxs module declarations + miss-case sweep

Adds the wxs declaration branch to getHover, restricted to
wxs.nameRange so cursor inside <wxs>...</wxs> body does not trigger.
External wxs renders \"→ <relative wxs path>\"; inline wxs renders
\"inline wxs module in this file\". Also adds miss-case scenarios
(H-14, H-15) confirming hover returns null where no matcher applies.
H-13 (object-literal interpolation) is intentionally omitted — the
underlying mechanism is covered by verify-wxml-expression-helpers.mjs."
```

---

## Task 8: Wire `hoverProvider` into the LSP host

**Files:**
- Modify: `server/wxml-lsp.mjs` (capabilities at line 707; dispatch around line 804)
- Modify: `scripts/verify-lsp-diagnostics.mjs` (add three hover scenarios + register in `graph-smoke`)

**Background:** The language service is feature-complete now. The LSP host needs to declare `hoverProvider: true` and dispatch `textDocument/hover` to `languageService.getHover()`.

- [ ] **Step 1: Read existing dispatch shape for `textDocument/definition`**

Reference: `server/wxml-lsp.mjs:804-808`. The `definition` case constructs `{ graph, documentPath, position, extensionRoot }` from `params` and calls `languageService.getDefinition(...)`. Mirror its shape exactly.

- [ ] **Step 2: Write failing LSP scenarios L-H1, L-H2, L-H3**

Edit `scripts/verify-lsp-diagnostics.mjs`. Add these scenario functions before the `scenarios` array near line 1700:

```js
async function testHoverCapabilityAdvertised() {
  const session = await startSession();
  try {
    const init = await session.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(MINIPROGRAM_ROOT).href,
      capabilities: {},
    });
    assert(
      init.capabilities && init.capabilities.hoverProvider === true,
      `L-H1: expected hoverProvider:true, got ${JSON.stringify(init.capabilities)}`,
    );
  } finally {
    await session.shutdown();
  }
}

async function testHoverReturnsMarkdownForDataRef() {
  const session = await startSession();
  try {
    await initializeAndOpen(session, HOME_WXML);
    const result = await session.request("textDocument/hover", {
      textDocument: { uri: pathToFileURL(HOME_WXML).href },
      position: { line: 4, character: 22 },
    });
    assert(result, "L-H2: expected Hover, got null");
    assert(result.contents && result.contents.kind === "markdown",
      `L-H2: expected markdown, got ${JSON.stringify(result.contents)}`);
    assert(result.contents.value.startsWith("**theme** — `data`"),
      `L-H2: bad content: ${result.contents.value}`);
  } finally {
    await session.shutdown();
  }
}

async function testHoverReturnsNullForMemberChain() {
  const session = await startSession();
  try {
    await initializeAndOpen(session, USER_CARD_WXML);
    const result = await session.request("textDocument/hover", {
      textDocument: { uri: pathToFileURL(USER_CARD_WXML).href },
      position: { line: 1, character: 30 },
    });
    assert(result === null, `L-H3: expected null for member chain, got ${JSON.stringify(result)}`);
  } finally {
    await session.shutdown();
  }
}
```

(If `startSession` / `initializeAndOpen` are not the exact helper names used in the file, search for the existing helper that the `event handler definition` scenario uses — line 1731 of `SCENARIO_SUITES["graph-smoke"]` — and mirror its pattern verbatim.)

Append the new scenarios to the `scenarios` array:

```js
  ["hover capability advertised", testHoverCapabilityAdvertised],
  ["hover returns markdown for data ref", testHoverReturnsMarkdownForDataRef],
  ["hover returns null for member chain", testHoverReturnsNullForMemberChain],
```

And add them to the `graph-smoke` suite (around line 1727):

```js
  "graph-smoke": [
    "watch registration when supported",
    "watch registration skipped when unsupported",
    "home component definition",
    "event handler definition",
    "data ref definition",
    "completion immediately after open",
    "event handler completion",
    "data ref completion",
    "realtime diagnostics on didChange",
    "overlay survives graph rebuild",
    "overlay before initial graph",
    "overlay cancelled by didClose",
    "unsupported request behavior",
    "dead-component-binding wire format",
    "dead-component-binding preserves event handler",
    "hover capability advertised",
    "hover returns markdown for data ref",
    "hover returns null for member chain",
  ],
```

- [ ] **Step 3: Run to verify they fail**

Run: `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke`
Expected: hover scenarios FAIL — capability missing (`hoverProvider` not in initialize response) or request returns `null`.

- [ ] **Step 4: Declare `hoverProvider` in capabilities**

In `server/wxml-lsp.mjs`, find the capabilities block around line 707:

```js
    capabilities: {
      // ...
      definitionProvider: true,
```

Add immediately after `definitionProvider: true,`:

```js
      hoverProvider: true,
```

- [ ] **Step 5: Wire `textDocument/hover` dispatch (three edits)**

The existing pattern (see `definitionForRequest` at line 579 and `handleDefinitionRequest` at line 604) uses paired `xForRequest(params)` + `handleXRequest(id, params)` helpers, with the request enum imported at the top.

**Edit 5a** — extend the import (lines 8-13):

Replace:

```js
import {
  getCompletions,
  getDefinition,
  getDiagnostics,
  getDocumentSymbols,
} from "./wxml-language-service.mjs";
```

with:

```js
import {
  getCompletions,
  getDefinition,
  getDiagnostics,
  getDocumentSymbols,
  getHover,
} from "./wxml-language-service.mjs";
```

**Edit 5b** — add the two helpers immediately after `handleDefinitionRequest` (around line 612, before `documentSymbolsForRequest`):

```js
async function hoverForRequest(params) {
  const documentPath = fileUriToPath(params?.textDocument?.uri);
  if (!documentPath) {
    return null;
  }

  const projectRoot = resolveMiniProgramRoot(documentPath);
  if (!projectRoot) {
    logDiagnosticError(`No app.json found for ${documentPath}`);
    return null;
  }

  const graph = await ensureGraphForRequest(projectRoot);
  if (!graph) {
    return null;
  }

  return getHover({
    graph,
    documentPath,
    position: params?.position,
    extensionRoot: EXTENSION_ROOT,
  });
}

async function handleHoverRequest(id, params) {
  try {
    respond(id, await hoverForRequest(params));
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    respond(id, null);
  }
}
```

**Edit 5c** — add the dispatch case immediately after `case "textDocument/definition":` (around line 806):

```js
    case "textDocument/hover":
      handleHoverRequest(message.id, message.params);
      break;
```

- [ ] **Step 6: Run to verify the LSP hover scenarios pass**

Run: `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke`
Expected: all `graph-smoke` scenarios pass, including the three new hover scenarios.

- [ ] **Step 7: Run the full umbrella to confirm no regressions**

Run: `bash scripts/verify-tree-sitter.sh`
Expected: green. If `tree-sitter-cli` has EACCES, run the node sub-verifiers individually:

```bash
node scripts/verify-wxml-narrow-ranges.mjs
node scripts/verify-wasm-symbol-baselines.mjs
node scripts/verify-wxml-language-service.mjs
node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke
node scripts/verify-js-method-baselines.mjs
node scripts/verify-js-script-info.mjs
```

All must pass.

- [ ] **Step 8: Commit**

```bash
git add server/wxml-lsp.mjs scripts/verify-lsp-diagnostics.mjs
git commit -m "feat: wire textDocument/hover into the LSP host

Declares hoverProvider:true in server capabilities and dispatches
textDocument/hover requests to languageService.getHover. Adds three
LSP-level scenarios under the graph-smoke suite covering capability
advertisement, a markdown hover for a data ref, and null for a member
chain."
```

---

## Task 9: Dogfood verification in the chelaile workspace

**Files:** none in this repo — manual verification step.

**Background:** Per spec Acceptance #3. The chelaile project at `/Users/zs/Desktop/zs_work/mp-wx-chelaile/wx/` is the existing dogfood target. Run the extension there and confirm hover works for each kind. No commit should land in chelaile — it's a third-party project, only check that the hover feature behaves end-to-end.

- [ ] **Step 1: Build/install the extension into Zed (if applicable)**

Follow the project's existing dogfood instructions (likely covered in earlier plans — search `docs/superpowers/plans/` for "dogfood" if unsure). If the workflow is "open chelaile in Zed with the local extension symlinked", confirm the symlink is current and Zed reloaded.

- [ ] **Step 2: Manually hover each kind**

Open chelaile WXML files and verify hover for at least one of each:
- **data**: a `{{some_data}}` reference where `some_data` is declared in `data: { ... }` of the page/component .js.
- **property**: a `{{some_prop}}` reference where `some_prop` is declared in `properties` of a component .js.
- **setData**: a key touched only by `setData()` in the .js, not in the `data` literal.
- **injector**: a key contributed by a configured data injector (see `wxml-zed.config.json` `dataInjectors`).
- **page method**: a `bindtap="..."` handler on a Page-owned WXML.
- **component method**: a `bindtap="..."` handler on a Component-owned WXML.
- **custom component**: a `<some-tag>` for a tag listed in `usingComponents`.
- **wxs module declaration**: a `<wxs module="...">` cursor on the module value.

For each: confirm the popup shows the correct kind label and a sensible relative path.

- [ ] **Step 3: Confirm wx:for-item hover returns nothing**

Hover an identifier that is bound by `wx:for-item="..."`. The expected behavior is **no hover popup** (deferred to v2). This is a no-regression check, not a feature check.

- [ ] **Step 4: Record outcomes in dogfood notes**

Edit `docs/wasm-parser-spike-notes.md` and append a short subsection under the most-recent dogfood section:

```markdown
### YYYY-MM-DD — Hover v1 dogfood (chelaile)

- All eight kind labels rendered correctly on sampled WXML files.
- wx:for-item hover returned nothing (deferred to v2 as designed).
- No regressions observed in completion / definition / diagnostics during the sweep.
```

Replace `YYYY-MM-DD` with today's date.

- [ ] **Step 5: Commit dogfood notes**

```bash
git add docs/wasm-parser-spike-notes.md
git commit -m "docs: record hover v1 dogfood outcome"
```

---

## Verification Summary

After all tasks, the following must pass:

- `node scripts/verify-wxml-narrow-ranges.mjs` — 5 cases (S-W1, S-W2, S-W3, S-C1, S-C2).
- `node scripts/verify-wasm-symbol-baselines.mjs` — 7 baseline cases, all green.
- `node scripts/verify-wxml-language-service.mjs` — pre-existing scenarios + 20 new scenarios (H-1, H-2, H-3, H-4, H-5, H-6, H-7, H-8, H-9, H-10, H-11, H-12, H-14, H-15, H-16, H-17, H-18, H-19, S-C3, S-W4). H-13 is documented as covered by `verify-wxml-expression-helpers.mjs` rather than asserted here.
- `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke` — pre-existing scenarios + L-H1, L-H2, L-H3.

Manual:
- Chelaile dogfood: hover renders for each of 8 kind labels; wx:for-item hover returns nothing.

`graph.version` MUST remain `1` (additive schema changes only).
