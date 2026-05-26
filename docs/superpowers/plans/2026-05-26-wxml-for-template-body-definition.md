# WXML wx:for Definition + Hover Inside `<template name>` Bodies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve a `wx:for` loop binding referenced inside a `<template name>` body (definition + hover), restricted to loops declared within that same template, while still suppressing caller-scope data/property/wxs references.

**Architecture:** Two pure leaf helpers in `server/wxml-for-scope.mjs` find the enclosing template range and filter `wxForScopes` to loops declared within it. `getDefinition` and `getHover` replace their blunt `inTemplateDefinition` early-return with a same-template `wx:for` lookup that falls back to the existing suppression. `findMatchingWxForBinding` is unchanged.

**Tech Stack:** Node ESM (`.mjs`), tree-sitter WXML grammar, custom `assert()` verifier scripts, LSP stdio JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-05-26-wxml-for-template-body-definition-design.md`

---

## File Structure

- **Create** `fixtures/miniprogram/pages/tpl-loops/tpl-loops.{wxml,js,json}` — the template-body test fixture (Task 1).
- **Modify** `fixtures/miniprogram/app.json` — register the new page (Task 1).
- **Regenerate** `fixtures/wasm-spike/miniprogram-symbols-baseline.json` — new fixture appears in the glob (Task 1).
- **Modify** `scripts/verify-wasm-symbol-baselines.mjs` — de-hardcode the stale `miniprogram (12 fixtures)` label (Task 1).
- **Modify** `scripts/verify-wxml-narrow-ranges.mjs` — add the W-7 frozen entry for the new fixture (Task 1).
- **Modify** `server/wxml-for-scope.mjs` — add `findEnclosingTemplateRange` + `scopesDeclaredWithin` (Task 2).
- **Modify** `server/wxml-language-service.mjs` — template-body `wx:for` branch in `getDefinition` (Task 2).
- **Modify** `server/wxml-hover.mjs` — template-body `wx:for` branch in `getHover` (Task 3).
- **Modify** `scripts/verify-wxml-language-service.mjs` — T-1..T-14 (Tasks 2, 3).

---

## Task 1: Fixture + registration + baseline regen + label de-hardcode

**Files:**
- Create: `fixtures/miniprogram/pages/tpl-loops/tpl-loops.wxml`, `.js`, `.json`
- Modify: `fixtures/miniprogram/app.json`
- Modify: `scripts/verify-wasm-symbol-baselines.mjs`
- Modify: `scripts/verify-wxml-narrow-ranges.mjs`
- Regenerate: `fixtures/wasm-spike/miniprogram-symbols-baseline.json`

- [ ] **Step 1: Create the fixture files**

`fixtures/miniprogram/pages/tpl-loops/tpl-loops.wxml`:
```wxml
<view class="tpl-loops">
  <!-- Case 1a: explicit wx:for-item + wx:for-index inside the template body. -->
  <template name="tpl-row">
    <view wx:for="{{rows}}" wx:for-item="row" wx:for-index="idx" wx:key="id">
      {{row.label}} #{{idx}} ({{theme}})
    </view>
  </template>

  <!-- Case 1b: implicit default item/index inside the template body. -->
  <template name="tpl-implicit">
    <view wx:for="{{rows}}" wx:key="id">{{item}} {{index}}</view>
  </template>

  <!-- Case 2: outer wx:for ENCLOSING the template definition (must NOT leak). -->
  <view wx:for="{{groups}}">
    <template name="tpl-inner">{{item}}</template>
  </view>

  <template is="tpl-row" />
  <template is="tpl-implicit" />
  <template is="tpl-inner" />
</view>
```

`fixtures/miniprogram/pages/tpl-loops/tpl-loops.js`:
```js
Page({ data: { rows: [], groups: [], theme: "x" }, onLoad() {} });
```

`fixtures/miniprogram/pages/tpl-loops/tpl-loops.json`:
```json
{}
```

- [ ] **Step 2: Register the page in app.json**

Read `fixtures/miniprogram/app.json` and add `"pages/tpl-loops/tpl-loops"` to the `pages` array (append as the last entry; keep valid JSON — add a comma after the previous last entry).

- [ ] **Step 3: De-hardcode the stale baseline label**

In `scripts/verify-wasm-symbol-baselines.mjs`, the miniprogram case label is a hardcoded count that is already stale (the glob matches 17 `.wxml` files, becoming 18 here):

```js
    name: "miniprogram (12 fixtures)",
```
Change it to:
```js
    name: "miniprogram (all .wxml fixtures)",
```

- [ ] **Step 4: Regenerate the miniprogram baseline**

The baseline verifier writes a fresh extraction to `$TMPDIR/wasm-baseline-<name>.json` before diffing. Run it (it will report the miniprogram diff — expected), then copy the fresh miniprogram baseline over the committed one:
```bash
node scripts/verify-wasm-symbol-baselines.mjs || true
cp "$TMPDIR/wasm-baseline-miniprogram-symbols-baseline.json" fixtures/wasm-spike/miniprogram-symbols-baseline.json
```

- [ ] **Step 5: Verify the baseline change is purely additive (only tpl-loops added)**

```bash
node -e '
const fs = require("fs"), cp = require("child_process");
const f = "fixtures/wasm-spike/miniprogram-symbols-baseline.json";
const oldFiles = (() => { const d = JSON.parse(cp.execSync("git show HEAD:" + f, { encoding: "utf8" })); return d.files || d; })();
const newFiles = (() => { const d = JSON.parse(fs.readFileSync(f, "utf8")); return d.files || d; })();
const added = newFiles.filter((x) => x.path.includes("pages/tpl-loops/"));
const newMinusTpl = newFiles.filter((x) => !x.path.includes("pages/tpl-loops/"));
if (added.length !== 1) { console.error("expected exactly 1 tpl-loops entry, got " + added.length); process.exit(1); }
if (JSON.stringify(newMinusTpl) !== JSON.stringify(oldFiles)) { console.error("EXISTING baseline entries changed — not purely additive"); process.exit(1); }
console.log("additive OK: tpl-loops.wxml added; " + oldFiles.length + " -> " + newFiles.length + " entries");
'
```
Expected: `additive OK: tpl-loops.wxml added; N -> N+1 entries`, exit 0.

- [ ] **Step 6: Add the W-7 frozen snapshot entry**

In `scripts/verify-wxml-narrow-ranges.mjs`, add an entry to the `W7_FROZEN_WX_FOR_BINDINGS` map (near the other `miniprogram-symbols-baseline.json::...` entries, sorted by key). The new fixture has explicit `row`/`idx` plus implicit loops, so its shim is `{"items":["row"],"indexes":["idx"],"hasAnyWxFor":true}`:

```js
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/pages/tpl-loops/tpl-loops.wxml": {"items":["row"],"indexes":["idx"],"hasAnyWxFor":true},
```

(If the value is wrong, the W-7 assertion prints the exact expected literal — paste that.)

- [ ] **Step 7: Verify baselines + narrow ranges green**

```bash
node scripts/verify-wasm-symbol-baselines.mjs
node scripts/verify-wxml-narrow-ranges.mjs
```
Expected: `All 8 wasm symbol baselines match.` and `Result: 15 passed, 0 failed` (W-7 green with the new entry).

- [ ] **Step 8: Commit**

```bash
git add fixtures/miniprogram/pages/tpl-loops/ fixtures/miniprogram/app.json fixtures/wasm-spike/miniprogram-symbols-baseline.json scripts/verify-wasm-symbol-baselines.mjs scripts/verify-wxml-narrow-ranges.mjs
git commit -m "test(fixture): tpl-loops page for template-body wx:for cases

Case 1a (explicit item+index), 1b (implicit item/index), and Case 2 (outer
loop enclosing a template definition). Registered as a page; miniprogram
baseline regenerated additively; W-7 frozen entry added; de-hardcoded the
stale 'miniprogram (N fixtures)' label.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Leaf helpers + getDefinition template-body branch

**Files:**
- Modify: `server/wxml-for-scope.mjs`
- Modify: `server/wxml-language-service.mjs`
- Test: `scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Write the failing definition tests (T-1, T-3, T-5, T-7, T-9, T-11)**

In `scripts/verify-wxml-language-service.mjs`, add the path constant near the other constants (after `MINIPROGRAM_ROOT` is defined):

```js
const TPL_LOOPS_WXML = path.join(MINIPROGRAM_ROOT, "pages/tpl-loops/tpl-loops.wxml");
```

Add these helpers + tests just before the runner block (reuse the existing `lspRangeText` and `hoverContents` helpers):

```js
function tplLines() {
  return fs.readFileSync(TPL_LOOPS_WXML, "utf8").split("\n");
}
function tplRow(lines, needle, label) {
  const i = lines.findIndex((l) => l.includes(needle));
  assert(i >= 0, `${label} setup: line containing ${JSON.stringify(needle)}`);
  return i;
}
function tplDefAt(graph, line, character) {
  return getDefinition({ graph, documentPath: TPL_LOOPS_WXML, position: { line, character }, extensionRoot: ROOT });
}
const TPL_URI_TAIL = "/fixtures/miniprogram/pages/tpl-loops/tpl-loops.wxml";

function assertTplDefExplicitItem(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{row.label}}", "T-1");
  const ch = lines[i].indexOf("{{row.label}}") + 2; // on `r` of row
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc, "T-1: expected Location for explicit item `row`");
  assert(loc.uri.endsWith(TPL_URI_TAIL), `T-1: same-file uri; got ${loc.uri}`);
  assert(lspRangeText(lines, loc.range) === "row", `T-1: range must cover 'row'; got '${lspRangeText(lines, loc.range)}'`);
}

function assertTplDefExplicitIndex(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "#{{idx}}", "T-3");
  const ch = lines[i].indexOf("#{{idx}}") + 3; // on `i` of idx (skip `#{{`)
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc, "T-3: expected Location for explicit index `idx`");
  assert(lspRangeText(lines, loc.range) === "idx", `T-3: range must cover 'idx'; got '${lspRangeText(lines, loc.range)}'`);
}

function assertTplDefImplicitItem(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{item}} {{index}}", "T-5"); // tpl-implicit line
  const ch = lines[i].indexOf("{{item}} {{index}}") + 2; // on `i` of item
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc, "T-5: expected Location for implicit item");
  assert(lspRangeText(lines, loc.range) === "wx:for", `T-5: implicit item must jump to the wx:for token; got '${lspRangeText(lines, loc.range)}'`);
}

function assertTplDefImplicitIndex(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{item}} {{index}}", "T-7");
  const ch = lines[i].indexOf("{{index}}") + 2; // on `i` of index
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc, "T-7: expected Location for implicit index");
  assert(lspRangeText(lines, loc.range) === "wx:for", `T-7: implicit index must jump to the wx:for token; got '${lspRangeText(lines, loc.range)}'`);
}

function assertTplDefDataRefSuppressed(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "({{theme}})", "T-9");
  const ch = lines[i].indexOf("{{theme}}") + 2; // on `t` of theme
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc === null, `T-9: data ref inside template must stay suppressed (null); got ${JSON.stringify(loc)}`);
}

function assertTplDefCase2NoLeak(graph) {
  const lines = tplLines();
  const i = tplRow(lines, 'name="tpl-inner"', "T-11"); // the tpl-inner line carries {{item}}
  const ch = lines[i].indexOf("{{item}}") + 2;
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc === null, `T-11: outer loop must NOT leak into template body; got ${JSON.stringify(loc)}`);
}
```

Register them in the runner block (append after the last existing assertion call):
```js
assertTplDefExplicitItem(graph);
assertTplDefExplicitIndex(graph);
assertTplDefImplicitItem(graph);
assertTplDefImplicitIndex(graph);
assertTplDefDataRefSuppressed(graph);
assertTplDefCase2NoLeak(graph);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: throws on **T-1** (`expected Location for explicit item \`row\``) — template refs return null today. (T-9 and T-11 expect null and pass even now; the suite still fails on T-1.)

- [ ] **Step 3: Add the two pure leaf helpers**

In `server/wxml-for-scope.mjs`, append:

```js
// a strictly after b in (row, column) order
function startsAfter(a, b) {
  return a.row > b.row || (a.row === b.row && a.column > b.column);
}

/**
 * Innermost template-definition range containing the position, or null.
 * templateRanges: symbol-extractor ranges ({ start:{row,column}, end:{row,column} }).
 * Template definitions never partially overlap, so the innermost containing one
 * is simply the range whose start point is latest (and two templates can't share
 * a start point).
 */
export function findEnclosingTemplateRange(templateRanges, position) {
  let best = null;
  for (const range of templateRanges ?? []) {
    if (!containsPosition(range, position)) continue;
    if (best === null || startsAfter(range.start, best.start)) best = range;
  }
  return best;
}

/**
 * Scopes whose wx:for DECLARATION (wxForRange start) falls within boundaryRange.
 * Keeps only loops declared inside the enclosing template, so an outer loop that
 * merely encloses the template definition (Case 2) is excluded.
 */
export function scopesDeclaredWithin(scopes, boundaryRange) {
  return (scopes ?? []).filter((scope) => containsPosition(boundaryRange, {
    line: scope.wxForRange.start.row,
    character: scope.wxForRange.start.column,
  }));
}
```

- [ ] **Step 4: Import the helpers and replace the early-return in getDefinition**

In `server/wxml-language-service.mjs`, extend the leaf-module import (currently `import { containsPosition, findMatchingWxForBinding } from "./wxml-for-scope.mjs";`):

```js
import { containsPosition, findMatchingWxForBinding, findEnclosingTemplateRange, scopesDeclaredWithin } from "./wxml-for-scope.mjs";
```

Then, inside `getDefinition`'s `if (expressionRefMatch) {` block, replace:

```js
    if (expressionRefMatch.inTemplateDefinition) return null;
```

with:

```js
    if (expressionRefMatch.inTemplateDefinition) {
      // Template bodies suppress caller-scope data/property/wxs refs, but a
      // wx:for loop variable declared INSIDE the same template is lexically
      // local and resolvable. Restrict to scopes declared within the enclosing
      // template so an outer loop enclosing the template definition cannot leak.
      const templateRanges = (fileModel.symbols ?? [])
        .filter((s) => s.kind === "template")
        .map((s) => s.range);
      const boundary = findEnclosingTemplateRange(templateRanges, position);
      if (boundary) {
        const localScopes = scopesDeclaredWithin(fileModel.wxForScopes, boundary);
        const wxForBinding = findMatchingWxForBinding(localScopes, position, expressionRefMatch.name);
        if (wxForBinding) {
          const { scope, kind } = wxForBinding;
          const targetRange = kind === "item"
            ? (scope.itemSource === "explicit" ? scope.itemNameRange : scope.wxForKeywordRange)
            : (scope.indexSource === "explicit" ? scope.indexNameRange : scope.wxForKeywordRange);
          if (targetRange) {
            return locationForGraphPathWithRange(documentGraphPath, targetRange, extensionRoot);
          }
        }
      }
      return null; // data/property/wxs in template bodies stay suppressed
    }
```

- [ ] **Step 5: Run to verify the definition tests pass**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: exit 0 — T-1, T-3, T-5, T-7, T-9, T-11 all pass, and every pre-existing assertion (W-1..W-11, D-1..D-10, HD-1..HD-3) still passes.

- [ ] **Step 6: Commit**

```bash
git add server/wxml-for-scope.mjs server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat(definition): resolve wx:for bindings inside <template name> bodies

Replace getDefinition's blunt inTemplateDefinition early-return with a
same-template wx:for lookup: loops declared INSIDE the enclosing template
resolve (explicit -> name range, implicit -> wx:for token); an outer loop
enclosing the template definition is excluded (no leak); data/property/wxs
stay suppressed. Two pure leaf helpers (findEnclosingTemplateRange,
scopesDeclaredWithin). Cases T-1/T-3/T-5/T-7/T-9/T-11.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: getHover template-body branch

**Files:**
- Modify: `server/wxml-hover.mjs`
- Test: `scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Write the failing hover tests (T-2, T-4, T-6, T-8, T-10, T-12, T-13, T-14)**

In `scripts/verify-wxml-language-service.mjs`, add these tests near the Task 2 ones (reuse `tplLines`, `tplRow`, `hoverContents`):

```js
function tplHoverAt(graph, line, character) {
  return getHover({ graph, documentPath: TPL_LOOPS_WXML, position: { line, character }, extensionRoot: ROOT });
}

function assertTplHoverExplicitItem(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{row.label}}", "T-2");
  const ch = lines[i].indexOf("{{row.label}}") + 2;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-2: expected Hover for explicit item `row`");
  assert(hoverContents(hov).startsWith("**row** — `wx:for-item`"), `T-2: bad title; got ${hoverContents(hov)}`);
}

function assertTplHoverExplicitIndex(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "#{{idx}}", "T-4");
  const ch = lines[i].indexOf("#{{idx}}") + 3;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-4: expected Hover for explicit index `idx`");
  assert(hoverContents(hov).startsWith("**idx** — `wx:for-index`"), `T-4: bad title; got ${hoverContents(hov)}`);
}

function assertTplHoverImplicitItem(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{item}} {{index}}", "T-6");
  const ch = lines[i].indexOf("{{item}} {{index}}") + 2;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-6: expected Hover for implicit item");
  assert(hoverContents(hov).startsWith("**item** — `wx:for-item`"), `T-6: bad title; got ${hoverContents(hov)}`);
}

function assertTplHoverImplicitIndex(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{item}} {{index}}", "T-8");
  const ch = lines[i].indexOf("{{index}}") + 2;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-8: expected Hover for implicit index");
  assert(hoverContents(hov).startsWith("**index** — `wx:for-index`"), `T-8: bad title; got ${hoverContents(hov)}`);
}

function assertTplHoverDataRefSuppressed(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "({{theme}})", "T-10");
  const ch = lines[i].indexOf("{{theme}}") + 2;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov === null, `T-10: data ref hover inside template must stay suppressed (null); got ${JSON.stringify(hov)}`);
}

function assertTplHoverCase2NoLeak(graph) {
  const lines = tplLines();
  const i = tplRow(lines, 'name="tpl-inner"', "T-12");
  const ch = lines[i].indexOf("{{item}}") + 2;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov === null, `T-12: outer loop must NOT leak into template body hover; got ${JSON.stringify(hov)}`);
}

function assertTplHoverDeclItem(graph) {
  const lines = tplLines();
  const i = tplRow(lines, 'wx:for-item="row"', "T-13");
  const ch = lines[i].indexOf('wx:for-item="row"') + 'wx:for-item="'.length; // on `r`
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-13: expected declaration-side Hover for `row`");
  assert(hoverContents(hov).startsWith("**row** — `wx:for-item`"), `T-13: bad title; got ${hoverContents(hov)}`);
}

function assertTplHoverDeclIndex(graph) {
  const lines = tplLines();
  const i = tplRow(lines, 'wx:for-index="idx"', "T-14");
  const ch = lines[i].indexOf('wx:for-index="idx"') + 'wx:for-index="'.length; // on `i`
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-14: expected declaration-side Hover for `idx`");
  assert(hoverContents(hov).startsWith("**idx** — `wx:for-index`"), `T-14: bad title; got ${hoverContents(hov)}`);
}
```

Register in the runner block (after the Task 2 registrations):
```js
assertTplHoverExplicitItem(graph);
assertTplHoverExplicitIndex(graph);
assertTplHoverImplicitItem(graph);
assertTplHoverImplicitIndex(graph);
assertTplHoverDataRefSuppressed(graph);
assertTplHoverCase2NoLeak(graph);
assertTplHoverDeclItem(graph);
assertTplHoverDeclIndex(graph);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: throws on **T-2** (`expected Hover for explicit item \`row\``) — use-site hover in template bodies returns null today. (T-10/T-12 expect null and pass now; T-13/T-14 are declaration-side hover which already works and pass now; the suite still fails on T-2.)

- [ ] **Step 3: Import the helpers and replace the early-return in getHover**

In `server/wxml-hover.mjs`, extend the leaf-module import block to add the two helpers:

```js
import {
  containsPosition,
  findMatchingWxForBinding,
  findWxForDeclarationAtPosition,
  findEnclosingTemplateRange,
  scopesDeclaredWithin,
} from "./wxml-for-scope.mjs";
```

Then, inside `getHover`'s `if (expressionRefMatch) {` block, replace:

```js
    if (expressionRefMatch.inTemplateDefinition) return null;
```

with:

```js
    if (expressionRefMatch.inTemplateDefinition) {
      // Same as getDefinition: a wx:for loop variable declared inside the same
      // template is resolvable; an outer loop enclosing the template definition
      // must not leak; data/property/wxs stay suppressed (caller scope unknown).
      const templateRanges = (fileModel.symbols ?? [])
        .filter((s) => s.kind === "template")
        .map((s) => s.range);
      const boundary = findEnclosingTemplateRange(templateRanges, position);
      if (boundary) {
        const localScopes = scopesDeclaredWithin(fileModel.wxForScopes, boundary);
        const wxForBinding = findMatchingWxForBinding(localScopes, position, expressionRefMatch.name);
        if (wxForBinding) {
          return makeWxForHover(wxForBinding.scope, wxForBinding.kind, expressionRefMatch.range);
        }
      }
      return null;
    }
```

- [ ] **Step 4: Run to verify the hover tests pass**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: exit 0 — all T-1..T-14 pass, plus every pre-existing assertion (W-1..W-11, D-1..D-10, HD-1..HD-3).

- [ ] **Step 5: Commit**

```bash
git add server/wxml-hover.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat(hover): resolve wx:for bindings inside <template name> bodies

Symmetric to the getDefinition change: getHover's inTemplateDefinition
early-return now first tries a same-template wx:for lookup (loops declared
inside the enclosing template resolve; outer-enclosing loops don't leak;
data/property/wxs stay suppressed). Cases T-2/T-4/T-6/T-8/T-10/T-12, plus
T-13/T-14 confirming declaration-side hover is unaffected.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Run the offline verifiers**

```bash
node scripts/verify-wxml-narrow-ranges.mjs
node scripts/verify-wasm-symbol-baselines.mjs
node scripts/verify-wxml-language-service.mjs ; echo "ls-exit: $?"
node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke ; echo "lsp-exit: $?"
```
Expected: narrow-ranges `15 passed, 0 failed`; `All 8 wasm symbol baselines match.`; language-service `ls-exit: 0` (T-1..T-14 + all pre-existing); graph-smoke `lsp-exit: 0`.

- [ ] **Step 2: Confirm non-template behavior is unchanged**

The change only alters the `inTemplateDefinition === true` branch. Confirm the loops.wxml suite (W-1..W-11, D-1..D-10, HD-1..HD-3) is green in the Step 1 language-service run, and that no completion/diagnostic scenario changed (graph-smoke green, W-7 byte-equal green).

- [ ] **Step 3: Run the umbrella verifier (if the environment permits)**

```bash
bash scripts/verify-tree-sitter.sh
```
Expected: `wxml-zed tree-sitter verification passed`. If it fails early with `EACCES` spawning the npx `tree-sitter` binary, that is a known sandbox restriction unrelated to this change — the Step 1 offline verifiers are the authoritative guard. (Re-run outside the sandbox to confirm if desired.)

- [ ] **Step 4: Confirm clean tree and expected commits**

```bash
git status --short && git log --oneline -4
```
Expected: clean tree; the last commits are Tasks 1–3.

- [ ] **Step 5 (only if a verifier failed): debug, fix, re-run**

Do not claim completion on a red verifier. Read the failing assertion, fix the owning task's code, re-run that sub-verifier, then re-run Step 1. Commit the fix referencing the task it belongs to.
