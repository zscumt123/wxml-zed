# WXML Template Navigation Polish v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add regression coverage that locks direct-scope WXML template navigation, declaration-focused document symbols, and outline-query navigation boundaries without expanding WXML semantics.

**Architecture:** Treat this as a hardening slice. Prefer fixture and harness updates over production code changes. If any planned regression exposes a production mismatch, stop and review the spec before changing `server/wxml-language-service.mjs`; keep `server/wxml-lsp.mjs`, graph schema, and grammar unchanged.

**Tech Stack:** Node.js ESM verification scripts, existing WXML mini program fixtures, Tree-sitter query verification, stdio LSP harness.

---

## File Structure

- Modify `fixtures/miniprogram/pages/home/home.wxml`: add a real direct-include template usage for `secondaryRow` without moving existing line-sensitive diagnostics.
- Modify `scripts/verify-tree-sitter.sh`: assert the new template reference enters the project graph and add outline-query negative checks for non-navigation entries.
- Modify `scripts/verify-wxml-language-service.mjs`: add direct include template definition regression coverage and duplicate-template document-symbol coverage.
- Modify `scripts/verify-lsp-diagnostics.mjs`: add protocol-level direct include template definition coverage.
- No changes expected in `server/wxml-language-service.mjs`, `server/wxml-lsp.mjs`, `scripts/extract-wxml-symbols.mjs`, `scripts/extract-wxml-project-graph.mjs`, grammar files, graph schema, or README.

## Task 0: Prepare Implementation Branch

**Files:**
- Verify: git state
- Verify: baseline total verification

- [ ] **Step 1: Confirm main is clean**

Run:

```bash
git status --short --branch
```

Expected: current branch is `main` and there are no modified, staged, or untracked files.

- [ ] **Step 2: Create the feature branch**

Run:

```bash
git checkout -b wxml-template-navigation-polish-v1
```

Expected: branch switches to `wxml-template-navigation-polish-v1`.

- [ ] **Step 3: Run baseline verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 with final output:

```text
wxml-zed tree-sitter verification passed
```

Tree-sitter parser-directory warnings are acceptable if the command exits 0.

## Task 1: Add Real Direct-Include Template Navigation Coverage

**Files:**
- Modify: `fixtures/miniprogram/pages/home/home.wxml`
- Modify: `scripts/verify-tree-sitter.sh`
- Modify: `scripts/verify-wxml-language-service.mjs`
- Modify: `scripts/verify-lsp-diagnostics.mjs`
- Test: `node scripts/verify-wxml-language-service.mjs`
- Test: `node scripts/verify-lsp-diagnostics.mjs`

- [ ] **Step 1: Add a real include-backed template usage fixture**

In `fixtures/miniprogram/pages/home/home.wxml`, append this line after the final `</view>`:

```xml
<template is="secondaryRow" data="{{label: 'Secondary'}}" />
```

Expected final lines:

```xml
  <view class="total">
    {{format.price(total)}}
  </view>
</view>
<template is="secondaryRow" data="{{label: 'Secondary'}}" />
```

Do not insert lines above `<missing-card>`. Its diagnostic must remain on line 14.

- [ ] **Step 2: Assert the new reference enters the project graph**

In `scripts/verify-tree-sitter.sh`, after:

```javascript
assert(home.references.some((reference) => reference.kind === "template" && reference.name === "loadingRow"), "Missing loadingRow template reference");
```

Add:

```javascript
assert(home.references.some((reference) => reference.kind === "template" && reference.name === "secondaryRow"), "Missing secondaryRow template reference");
```

- [ ] **Step 3: Add direct language-service include-template definition test**

In `scripts/verify-wxml-language-service.mjs`, add this function immediately after the `assertStaticTemplateDefinition(graph)` function definition and before `cloneGraph(graph)`:

```javascript
function assertDirectIncludeTemplateDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 21, character: 4 },
    extensionRoot: ROOT,
  });
  assertLocation(
    location,
    SECONDARY_WXML,
    { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
    "direct include template definition",
  );
}
```

At the bottom of `scripts/verify-wxml-language-service.mjs`, after:

```javascript
assertStaticTemplateDefinition(graph);
```

Add:

```javascript
assertDirectIncludeTemplateDefinition(graph);
```

- [ ] **Step 4: Add protocol-level include-template definition test**

In `scripts/verify-lsp-diagnostics.mjs`, add this function immediately after the closing brace of `testStaticTemplateDefinition`:

```javascript
async function testDirectIncludeTemplateDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before direct include template definition");
    const result = await client.definition(HOME_WXML, { line: 21, character: 4 });
    assertLocation(
      result,
      SECONDARY_WXML,
      { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
      "direct include template definition",
    );
  });
}
```

In the `tests` array near the bottom of `scripts/verify-lsp-diagnostics.mjs`, after:

```javascript
["static template definition", testStaticTemplateDefinition],
```

Add:

```javascript
["direct include template definition", testDirectIncludeTemplateDefinition],
```

- [ ] **Step 5: Run direct language-service verification**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: exit code 0. Parser-directory warnings are acceptable if the command exits 0.

- [ ] **Step 6: Run protocol verification**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: exit code 0 and output includes:

```text
[verify-lsp-diagnostics] direct include template definition
```

- [ ] **Step 7: Commit direct include regression coverage**

Run:

```bash
git add fixtures/miniprogram/pages/home/home.wxml scripts/verify-tree-sitter.sh scripts/verify-wxml-language-service.mjs scripts/verify-lsp-diagnostics.mjs
git commit -m "test: cover direct include template navigation"
```

## Task 2: Add Document-Symbol Duplicate Template Regression Coverage

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`
- Test: `node scripts/verify-wxml-language-service.mjs`
- Test: `node --check scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Add duplicate-template document-symbol test**

In `scripts/verify-wxml-language-service.mjs`, after `assertTemplateDocumentSymbols(graph)`, add:

```javascript
function assertDuplicateTemplateDocumentSymbols(graph) {
  const withFirstDefinition = graphWithTemplateSymbol(
    graph,
    "fixtures/miniprogram/pages/home/home.wxml",
    {
      kind: "template",
      name: "duplicateLocalSymbol",
      range: templateSymbolRange(21, 24),
    },
  );
  const testGraph = graphWithTemplateSymbol(
    withFirstDefinition,
    "fixtures/miniprogram/pages/home/home.wxml",
    {
      kind: "template",
      name: "duplicateLocalSymbol",
      range: templateSymbolRange(25, 28),
    },
  );
  const symbols = getDocumentSymbols({ graph: testGraph, documentPath: HOME_WXML, extensionRoot: ROOT });
  const duplicateSymbols = symbols.filter((symbol) => symbol.name === "duplicateLocalSymbol");
  assertDeepEqual(
    duplicateSymbols,
    [
      {
        name: "duplicateLocalSymbol",
        kind: 12,
        detail: "template",
        range: { start: { line: 21, character: 2 }, end: { line: 24, character: 13 } },
        selectionRange: { start: { line: 21, character: 2 }, end: { line: 24, character: 13 } },
      },
      {
        name: "duplicateLocalSymbol",
        kind: 12,
        detail: "template",
        range: { start: { line: 25, character: 2 }, end: { line: 28, character: 13 } },
        selectionRange: { start: { line: 25, character: 2 }, end: { line: 28, character: 13 } },
      },
    ],
    "duplicate template document symbols",
  );
}
```

This test intentionally uses duplicate definitions that would make definition lookup return `null`; document symbols should still describe both declarations.

- [ ] **Step 2: Call duplicate-template document-symbol test**

At the bottom of `scripts/verify-wxml-language-service.mjs`, after:

```javascript
assertTemplateDocumentSymbols(graph);
```

Add:

```javascript
assertDuplicateTemplateDocumentSymbols(graph);
```

- [ ] **Step 3: Run syntax check**

Run:

```bash
node --check scripts/verify-wxml-language-service.mjs
```

Expected: exit code 0.

- [ ] **Step 4: Run direct language-service verification**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: exit code 0. Parser-directory warnings are acceptable if the command exits 0.

- [ ] **Step 5: Commit document-symbol regression coverage**

Run:

```bash
git add scripts/verify-wxml-language-service.mjs
git commit -m "test: cover duplicate template document symbols"
```

## Task 3: Add Outline Query Navigation-Boundary Checks

**Files:**
- Modify: `scripts/verify-tree-sitter.sh`
- Test: `scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Query outline output for real-world component fixture**

In `scripts/verify-tree-sitter.sh`, after:

```bash
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/outline.scm" "$REAL_WORLD_PAGE" >/tmp/wxml-zed-real-world-page-outline-query.out
```

Add:

```bash
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/outline.scm" "$REAL_WORLD_COMPONENT" >/tmp/wxml-zed-real-world-component-outline-query.out
```

- [ ] **Step 2: Add outline negative assertions for non-navigation entries**

After the existing outline positive assertions:

```bash
rg -n 'text: `"loadingRow"`' /tmp/wxml-zed-real-world-templates-outline-query.out >/dev/null
rg -n 'text: `"compactFooter"`' /tmp/wxml-zed-real-world-templates-outline-query.out >/dev/null
rg -n 'text: `"fullFooter"`' /tmp/wxml-zed-real-world-templates-outline-query.out >/dev/null
```

Add:

```bash
if rg -n 'capture: [0-9]+ - item.*text: `<template is=' /tmp/wxml-zed-real-world-page-outline-query.out >/dev/null; then
  echo "Template usage leaked into page outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `"loadingRow"`' /tmp/wxml-zed-real-world-page-outline-query.out >/dev/null; then
  echo "Template usage name leaked into page outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `<user-card' /tmp/wxml-zed-real-world-page-outline-query.out >/dev/null; then
  echo "Component usage leaked into page outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `user-card`' /tmp/wxml-zed-real-world-page-outline-query.out >/dev/null; then
  echo "Component usage name leaked into page outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `<block' /tmp/wxml-zed-real-world-component-outline-query.out >/dev/null; then
  echo "Block element leaked into component outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `<slot' /tmp/wxml-zed-real-world-component-outline-query.out >/dev/null; then
  echo "Slot element leaked into component outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `"header"`' /tmp/wxml-zed-real-world-component-outline-query.out >/dev/null; then
  echo "Slot name leaked into component outline items" >&2
  exit 1
fi
```

These checks intentionally inspect `@item` captures in outline query output, not LSP document symbols. Comment `@annotation` captures may remain; only `@item` navigation leaks are being guarded.

- [ ] **Step 3: Run total verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 with final output:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 4: Commit outline boundary coverage**

Run:

```bash
git add scripts/verify-tree-sitter.sh
git commit -m "test: cover outline navigation boundaries"
```

## Task 4: Final Verification and Review

**Files:**
- Verify: all changed files
- Verify: `server/wxml-lsp.mjs`
- Verify: README unchanged

- [ ] **Step 1: Run direct language-service verification**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: exit code 0.

- [ ] **Step 2: Run protocol verification**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: exit code 0.

- [ ] **Step 3: Run syntax checks**

Run:

```bash
node --check scripts/verify-wxml-language-service.mjs
node --check scripts/verify-lsp-diagnostics.mjs
node --check server/wxml-language-service.mjs
node --check server/wxml-lsp.mjs
```

Expected: all commands exit 0.

- [ ] **Step 4: Run total verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 with final output:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 5: Verify architecture boundaries**

Run:

```bash
rg -n "secondaryRow|duplicateLocalSymbol|direct include template definition|outline navigation boundaries" server/wxml-lsp.mjs server/wxml-language-service.mjs README.md
```

Expected:

- exit code 1 with no matches is the expected clean result;
- no matches in `server/wxml-lsp.mjs`;
- no matches in `server/wxml-language-service.mjs`;
- no matches in `README.md`.

If this command finds matches in those files, stop and inspect before proceeding.

- [ ] **Step 6: Verify diff shape**

Run:

```bash
git diff --stat main..HEAD
git diff --check main..HEAD
```

Expected: diff is limited to fixture and verification harness files. `git diff --check` emits no whitespace errors.

- [ ] **Step 7: Request code review before merge**

Use `superpowers:requesting-code-review` before merging.

Review context:

```text
Description: Added regression coverage for WXML direct-scope template navigation polish.
Requirements: Preserve current direct-scope template navigation semantics; add direct include template definition coverage; prove document symbols expose duplicate template declarations independently of definition eligibility; guard outline @item navigation boundaries; do not change graph schema, grammar, README, or LSP host.
Base: main at the start of the implementation branch.
Head: current feature branch.
```

Fix any Critical or Important findings before merge.
