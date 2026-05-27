# WXML Diagnostics Cursor-Scope Tightening (v2-C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `missing-expression-ref` diagnostic treat a `wx:for` binding as in-scope only at positions inside that loop's active scope (per-element), so a loop variable referenced outside its loop is flagged — matching hover/definition/completion semantics.

**Architecture:** One consumer-side change to `expressionRefDiagnostics` in `server/wxml-language-service.mjs`: split the single flat scope set into a file-global set (data/property/wxs) plus a per-ref active-loop lookup via the existing pure helper `activeWxForBindingsAt(scopes, position)` (added in v2-B). A new `scope-leak` fixture provides the only sample that actually triggers a new warning (real corpora produce none — see spec pre-scan). The extractor, grammar, completion, hover, and definition are untouched.

**Tech Stack:** Node ESM, no test framework (plain `assert()` runner scripts), tree-sitter-wxml wasm extractor (unchanged here).

**Spec:** `docs/superpowers/specs/2026-05-27-wxml-diagnostics-cursor-scope-design.md`

**Plan note — test location refinement:** the spec said E-1..E-7 go in `verify-lsp-diagnostics.mjs` (graph-smoke). This plan instead places them in `verify-wxml-language-service.mjs`, which is where every `getDiagnostics`-based scope-logic test already lives (`assertMissingCardDiagnostic` et al.). The v2-C change is scope *logic*, not wire format — LSP wire format for `missing-expression-ref`/`dead-component-binding` is already covered by the existing protocol scenarios in `verify-lsp-diagnostics.mjs` and does not change. This is a HOW refinement within the spec's WHAT (E-1..E-7 verify the scope behavior).

---

## File Structure

- **Create** `fixtures/miniprogram/pages/scope-leak/scope-leak.wxml` — the new-warning sample (loop vars not data-backed).
- **Create** `fixtures/miniprogram/pages/scope-leak/scope-leak.js` — `Page({ data: { list, a, g } })`.
- **Create** `fixtures/miniprogram/pages/scope-leak/scope-leak.json` — minimal page config.
- **Modify** `fixtures/miniprogram/app.json` — register the page.
- **Modify** `fixtures/wasm-spike/miniprogram-symbols-baseline.json` — regenerate (the wasm `miniprogram` case globs every `.wxml`).
- **Modify** `scripts/verify-wxml-narrow-ranges.mjs` — add the `scope-leak` entry to `W7_FROZEN_WX_FOR_BINDINGS`.
- **Modify** `server/wxml-language-service.mjs:847` — `expressionRefDiagnostics` (split scope + per-ref active lookup) and the `missing-expression-ref` message constant.
- **Modify** `scripts/verify-wxml-language-service.mjs` — add E-1..E-7 `getDiagnostics`-based tests.

---

## Task 1: Add the `scope-leak` fixture + keep all baselines green (no behavior change)

This task is purely additive infrastructure. With the current (unchanged) diagnostics code the fixture produces zero diagnostics (every loop name is still globally in the flat shim), so the only work is making the fixture exist, registering it, and updating the two baselines the new `.wxml` perturbs.

**Files:**
- Create: `fixtures/miniprogram/pages/scope-leak/scope-leak.wxml`
- Create: `fixtures/miniprogram/pages/scope-leak/scope-leak.js`
- Create: `fixtures/miniprogram/pages/scope-leak/scope-leak.json`
- Modify: `fixtures/miniprogram/app.json`
- Modify: `fixtures/wasm-spike/miniprogram-symbols-baseline.json`
- Modify: `scripts/verify-wxml-narrow-ranges.mjs` (the `W7_FROZEN_WX_FOR_BINDINGS` map)

- [ ] **Step 1: Create the fixture WXML**

Create `fixtures/miniprogram/pages/scope-leak/scope-leak.wxml` with EXACTLY this content (line positions are load-bearing for Task 2's tests — keep blank lines):

```html
<view wx:for="{{list}}" wx:for-item="row">{{row.name}}</view>
<view>{{row.name}}</view>

<view wx:for="{{a}}" wx:for-item="x">
  <view wx:for="{{x.items}}" wx:for-item="z">{{x}} {{z}}</view>
</view>

<view>{{z}}</view>

<block wx:for="{{g}}" wx:for-item="grp">{{grp}}</block>
<view>{{grp}}</view>
```

0-indexed lines that will warn under the new code: line 1 (`{{row.name}}` out of loop), line 7 (`{{z}}` after the outer loop closes), line 10 (`{{grp}}` after the block loop). In-loop references (lines 0, 4, 9) stay clean; iterables `{{list}}`/`{{a}}`/`{{g}}` resolve as data, and `{{x.items}}` resolves `x` against the still-active outer loop.

- [ ] **Step 2: Create the fixture JS** (`scope-leak.js`)

```js
Page({
  data: {
    list: [],
    a: [],
    g: [],
  },
  onLoad() {},
});
```

Note: data holds ONLY the iterable sources (`list`, `a`, `g`). The loop bindings (`row`, `x`, `z`, `grp`) are deliberately absent so they are not data-backed.

- [ ] **Step 3: Create the fixture JSON** (`scope-leak.json`)

```json
{
  "navigationBarTitleText": "Scope Leak"
}
```

- [ ] **Step 4: Register the page in `app.json`**

In `fixtures/miniprogram/app.json`, add `"pages/scope-leak/scope-leak"` to the `pages` array (after the `tpl-loops` entry):

```json
  "pages": [
    "pages/home/home",
    "pages/detail/detail",
    "pages/cross-binding/cross-binding",
    "pages/dyn-page/dyn-page",
    "pages/loops/loops",
    "pages/tpl-loops/tpl-loops",
    "pages/scope-leak/scope-leak"
  ],
```

- [ ] **Step 5: Confirm the new fixture currently produces NO diagnostics (old behavior)**

Run (documentPath must be ABSOLUTE and extensionRoot the repo root, mirroring how `verify-wxml-language-service.mjs` calls `getDiagnostics`):
```bash
node -e "
import('./server/wxml-language-service.mjs').then(async (m) => {
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const ROOT = process.cwd();
  const out = execFileSync(process.execPath, ['scripts/extract-wxml-project-graph.mjs', path.join(ROOT, 'fixtures/miniprogram')], { encoding: 'utf8', stdio: ['ignore','pipe','inherit'] });
  const graph = JSON.parse(out);
  const d = m.getDiagnostics({ graph, documentPath: path.join(ROOT, 'fixtures/miniprogram/pages/scope-leak/scope-leak.wxml'), extensionRoot: ROOT });
  console.log('diagnostics:', JSON.stringify(d));
});
"
```
Expected: `diagnostics: []` — proves the fixture is graph-reachable (ownerConfig found) AND that the flat-shim code does not yet flag the out-of-loop refs. (A non-`[]` here would mean an unintended diagnostic, e.g. a typo'd iterable name; fix the fixture before continuing.)

- [ ] **Step 6: Regenerate the wasm miniprogram baseline**

The `verify-wasm-symbol-baselines.mjs` `miniprogram` case globs `fixtures/miniprogram` for every `.wxml` and diffs the extractor output (order-independent). Regenerate the baseline from the same extractor:

```bash
node scripts/extract-wxml-symbols.mjs $(find fixtures/miniprogram -name '*.wxml' | sort) > fixtures/wasm-spike/miniprogram-symbols-baseline.json
```

- [ ] **Step 7: Add the W-7 frozen entry for the new fixture**

`scripts/verify-wxml-narrow-ranges.mjs`'s `W7_FROZEN_WX_FOR_BINDINGS` asserts every baseline fileModel has a frozen `wxForBindings` snapshot (and vice-versa). First read the actual value the extractor produced:

```bash
node -e "
const d = JSON.parse(require('fs').readFileSync('fixtures/wasm-spike/miniprogram-symbols-baseline.json','utf8'));
const files = d.files || d;
const f = files.find((x) => x.path === 'fixtures/miniprogram/pages/scope-leak/scope-leak.wxml');
console.log(JSON.stringify(f.wxForBindings));
"
```
Expected output: `{"items":["grp","row","x","z"],"indexes":[],"hasAnyWxFor":true}` (explicit item names sorted; no `wx:for-index` used). Use the actual printed value (not this expected string) in the next edit.

Then add this line to the `W7_FROZEN_WX_FOR_BINDINGS` map, immediately after the existing `loops.wxml` line (keys are kept in sorted order; `scope-leak` sorts after `loops`, before `tpl-loops`):

```js
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/pages/scope-leak/scope-leak.wxml": {"items":["grp","row","x","z"],"indexes":[],"hasAnyWxFor":true},
```

- [ ] **Step 8: Run the perturbed verifiers — confirm green**

Run:
```bash
node scripts/verify-wasm-symbol-baselines.mjs
node scripts/verify-wxml-narrow-ranges.mjs
node scripts/verify-wxml-language-service.mjs; echo "ls exit=$?"
node scripts/verify-lsp-diagnostics.mjs --suite=graph-smoke > "$TMPDIR/gs.txt" 2>&1; echo "gs exit=$?"
```
Expected: wasm `All 8 wasm symbol baselines match.`; narrow-ranges `Result: 21 passed, 0 failed`; `ls exit=0`; `gs exit=0`. (No behavior changed yet; these confirm the additive fixture didn't break anything.)

- [ ] **Step 9: Commit**

```bash
git add fixtures/miniprogram/pages/scope-leak/ fixtures/miniprogram/app.json fixtures/wasm-spike/miniprogram-symbols-baseline.json scripts/verify-wxml-narrow-ranges.mjs
git commit -m "test(fixtures): add scope-leak fixture for diagnostics cursor-scope (v2-C)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Tighten `expressionRefDiagnostics` to per-position wx:for scope (TDD)

**Files:**
- Test: `scripts/verify-wxml-language-service.mjs` (add E-1..E-7)
- Modify: `server/wxml-language-service.mjs:847` (`expressionRefDiagnostics`) and the `missing-expression-ref` message constant

- [ ] **Step 1: Write the failing tests (E-1..E-7)**

In `scripts/verify-wxml-language-service.mjs`, add a `SCOPE_LEAK_WXML` path constant near the other fixture paths (after the `TPL_LOOPS_WXML` line, ~line 34):

```js
const SCOPE_LEAK_WXML = path.join(MINIPROGRAM_ROOT, "pages/scope-leak/scope-leak.wxml");
```

Then add these test functions (place them after the v2-B completion tests, before the `const graph = loadGraph();` runner block):

```js
// Phase 3 v2-C — cursor-scoped wx:for diagnostics ---------------------------

function scopeLeakWarnings(graph) {
  const diagnostics = getDiagnostics({ graph, documentPath: SCOPE_LEAK_WXML, extensionRoot: ROOT });
  return diagnostics.filter((d) => d.code === "missing-expression-ref");
}

// E-1..E-6: exactly the three out-of-loop references warn; in-loop, nested,
// iterable-exclusion, and block-loop references stay clean.
function assertScopeLeakWarnsOnlyOutOfLoop(graph) {
  const warns = scopeLeakWarnings(graph);
  const byLine = warns.map((d) => d.range.start.line).sort((a, b) => a - b);
  assertDeepEqual(byLine, [1, 7, 10], "v2-C: missing-expression-ref only on out-of-loop refs (lines 1,7,10)");
  for (const d of warns) {
    assert(d.severity === 2, `v2-C: out-of-loop ref must be Warning(2); got ${d.severity} @${d.range.start.line}`);
    assert(d.source === "wxml-zed", `v2-C: source wxml-zed; got ${d.source}`);
  }
  // Lock which identifier warns on each line (E-2 row, E-4 z, E-6 grp).
  const nameAt = (line) => {
    const d = warns.find((w) => w.range.start.line === line);
    return d ? d.message.match(/^"([^"]+)"/)?.[1] : null;
  };
  assert(nameAt(1) === "row", `E-2: line 1 must warn on 'row'; got ${nameAt(1)}`);
  assert(nameAt(7) === "z", `E-4: line 7 must warn on 'z'; got ${nameAt(7)}`);
  assert(nameAt(10) === "grp", `E-6: line 10 must warn on 'grp'; got ${nameAt(10)}`);
}

// E-1/E-3/E-5/E-6: no warning on any in-scope line (in-loop, nested body,
// inner iterable resolving the outer binding, block-loop body).
function assertScopeLeakCleanInScope(graph) {
  const warns = scopeLeakWarnings(graph);
  for (const line of [0, 4, 9]) {
    const hit = warns.find((d) => d.range.start.line === line);
    assert(!hit, `v2-C: in-scope line ${line} must NOT warn; got ${JSON.stringify(hit)}`);
  }
}

// E-7 (message): the reworded constant names the position.
function assertScopeLeakMessageWording(graph) {
  const warns = scopeLeakWarnings(graph);
  assert(warns.length > 0, "E-7: expected at least one warning to check message");
  assert(
    warns[0].message.includes("the wx:for scope at this position"),
    `E-7: message must name the position; got ${warns[0].message}`,
  );
}
```

Register the three in the runner block (with the other `assert...(graph)` calls at the bottom of the file, after the v2-B completion calls):

```js
// Phase 3 v2-C — cursor-scoped wx:for diagnostics
assertScopeLeakWarnsOnlyOutOfLoop(graph);
assertScopeLeakCleanInScope(graph);
assertScopeLeakMessageWording(graph);
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `node scripts/verify-wxml-language-service.mjs; echo "exit=$?"`
Expected: FAIL (non-zero exit) with an error like `v2-C: missing-expression-ref only on out-of-loop refs (lines 1,7,10): expected [1,7,10], got []` — the current flat-shim code treats `row`/`z`/`grp` as globally in scope, so no out-of-loop warning fires yet. (If instead it fails with `expected ... got []` AND Step 5 of Task 1 had shown `[]`, the fixture is wired correctly and this is the expected red state. A failure mentioning the page not found means the app.json registration from Task 1 is missing.)

- [ ] **Step 3: Implement the scope split in `expressionRefDiagnostics`**

In `server/wxml-language-service.mjs`, replace the flat-scope body of `expressionRefDiagnostics` (the block from `const scope = new Set();` through the end of the `wxForBindings` block, lines ~852-868) with a global-only set, and move the wx:for check to a per-ref active lookup.

Replace this:
```js
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
```

with this (file-global scope only; the flat `wxForBindings` block is deleted — completion already stopped reading the shim in v2-B, and diagnostics is its last consumer):
```js
  // File-global scope: data + properties + wxs modules. wx:for bindings are NOT
  // global — they are resolved per ref at the ref's own position below, so a loop
  // variable referenced outside its loop is correctly flagged. (wxForBindings flat
  // shim is intentionally no longer read here; see v2-C spec.)
  const global = new Set();
  for (const key of ownerConfig.script.dataKeys ?? []) global.add(key.name);
  // Component properties contribute to template scope identically to data
  // (see WeChat docs on `properties:` — values are reactive template state).
  for (const key of ownerConfig.script.propertyKeys ?? []) global.add(key.name);
  for (const sym of fileModel.symbols ?? []) {
    if (sym.kind === "wxs" && typeof sym.name === "string") global.add(sym.name);
  }
```

Then change the per-ref acceptance check. Replace:
```js
    if (ref.inTemplateDefinition) continue;
    if (scope.has(ref.name)) continue;
```
with:
```js
    if (ref.inTemplateDefinition) continue;
    if (global.has(ref.name)) continue;
    // wx:for binding active at THIS ref's position (item+index of every enclosing
    // loop, minus a loop's own iterable per iterable-exclusion). expressionRefs and
    // wxForScopes come from the same parse, so positions are consistent (no live-
    // buffer staleness). activeWxForBindingsAt takes an LSP position; ref.range.start
    // is symbol-form { row, column } — convert explicitly.
    const active = activeWxForBindingsAt(fileModel.wxForScopes, {
      line: ref.range.start.row,
      character: ref.range.start.column,
    });
    if (active.some((binding) => binding.name === ref.name)) continue;
```

`activeWxForBindingsAt` is already imported at the top of the file (v2-B added it to the leaf import block — do not add a duplicate import).

- [ ] **Step 4: Reword the `missing-expression-ref` message constant**

In the same function, in the final `out.push({ ... code: "missing-expression-ref" ... })`, change the message from:
```js
      message: `"${ref.name}" is not defined in the page/component data, wx:for scope, or any <wxs> module.`,
```
to:
```js
      message: `"${ref.name}" is not defined in the page/component data, the wx:for scope at this position, or any <wxs> module.`,
```
(Do NOT touch the `dead-component-binding` message — it concerns cross-component prop binding, not loop scope.)

- [ ] **Step 5: Run the tests — verify they pass**

Run: `node scripts/verify-wxml-language-service.mjs; echo "exit=$?"`
Expected: `exit=0` (E-1..E-7 green, and every pre-existing hover/definition/completion/diagnostics test still green — the change only removes the flat-shim global injection and adds per-position resolution). If the E-tests still show `got []`, re-check Task 1 Step 4 (app.json registration) and that `activeWxForBindingsAt` is imported.

- [ ] **Step 6: Commit**

```bash
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat(diagnostics): cursor-scope wx:for bindings (v2-C)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Full verification sweep + post-implementation pre-scan

**Files:** none modified (verification only; may add a one-line shim comment).

- [ ] **Step 1: Run the full offline verifier suite**

Run:
```bash
node scripts/verify-wxml-narrow-ranges.mjs
node scripts/verify-wasm-symbol-baselines.mjs
node scripts/verify-wxml-language-service.mjs; echo "ls exit=$?"
node scripts/verify-lsp-diagnostics.mjs --suite=graph-smoke > "$TMPDIR/gs.txt" 2>&1; echo "gs exit=$?"; grep -c "verify-lsp-diagnostics" "$TMPDIR/gs.txt"
```
Expected: narrow-ranges `21 passed, 0 failed`; wasm `All 8 wasm symbol baselines match.`; `ls exit=0`; `gs exit=0` with `21` scenarios.

- [ ] **Step 2: Run the umbrella verifier**

Run (sandbox blocks the npx tree-sitter-cli spawn → run with sandbox disabled, this is an environment constraint not a code issue):
```bash
bash scripts/verify-tree-sitter.sh
```
Expected: exits 0 / all sections green.

- [ ] **Step 3: Mark the `wxForBindings` shim as having no runtime consumer**

In `shared/wxml-symbol-extractor.mjs`, find where `wxForBindings` is built/returned and add a one-line comment marking that as of v2-C only the W-7 legacy baseline reads it (retirement is a separate later round). Locate it:
```bash
grep -n "wxForBindings" shared/wxml-symbol-extractor.mjs
```
Add a comment adjacent to the `wxForBindings` derivation, e.g.:
```js
// Legacy compat shim. As of v2-C no runtime consumer reads this (completion
// migrated in v2-B, diagnostics in v2-C); only verify-wxml-narrow-ranges' W-7
// byte-equal invariant still asserts it. Retire in a dedicated later round.
```
(Do not change the derived value — W-7 must stay byte-equal.)

- [ ] **Step 4: Re-run the empirical pre-scan as a confirmation**

Confirm the change adds new warnings only via `scope-leak` and nowhere else. Recreate the throwaway scan in `$TMPDIR` (read-only; never written into chelaile) — it builds the project graph and counts refs that pass under the global+active rule:

```bash
node -e '
import("file://" + process.cwd() + "/server/wxml-language-service.mjs").then(async (ls) => {
  const forScope = await import("file://" + process.cwd() + "/server/wxml-for-scope.mjs");
  const { execFileSync } = await import("node:child_process");
  for (const proj of ["fixtures/miniprogram", "/Users/zs/Desktop/zs_work/mp-wx-chelaile/wx"]) {
    let scanned = 0, newWarn = 0;
    const out = execFileSync(process.execPath, ["scripts/extract-wxml-project-graph.mjs", proj], { encoding: "utf8", stdio: ["ignore","pipe","inherit"], maxBuffer: 1<<28 });
    const graph = JSON.parse(out);
    for (const fm of graph.wxml ?? []) {
      const oc = ls.findOwnerConfigWithScript(graph, fm.path);
      if (!oc || oc.script.hasDynamicData) continue;
      const g = new Set();
      for (const k of oc.script.dataKeys ?? []) g.add(k.name);
      for (const k of oc.script.propertyKeys ?? []) g.add(k.name);
      for (const s of fm.symbols ?? []) if (s.kind === "wxs" && typeof s.name === "string") g.add(s.name);
      const flat = new Set(g);
      const b = fm.wxForBindings; if (b) { if (b.hasAnyWxFor){flat.add("item");flat.add("index");} for (const n of b.items??[]) flat.add(n); for (const n of b.indexes??[]) flat.add(n); }
      for (const ref of fm.expressionRefs ?? []) {
        if (ref.inTemplateDefinition) continue;
        if (!flat.has(ref.name)) continue; // already warns today
        scanned++;
        const active = forScope.activeWxForBindingsAt(fm.wxForScopes, { line: ref.range.start.row, character: ref.range.start.column });
        if (!(g.has(ref.name) || active.some((x) => x.name === ref.name))) newWarn++;
      }
    }
    console.log(proj, "passing-today refs:", scanned, "newly-warned:", newWarn);
  }
});
'
```
Expected: `fixtures/miniprogram ... newly-warned: 3` (the scope-leak fixture's three out-of-loop refs) and `mp-wx-chelaile/wx ... newly-warned: 0` (real corpus is clean — matches the spec pre-scan). If chelaile shows new warnings, STOP and report the patterns before shipping.

- [ ] **Step 5: Commit the shim comment (if Step 3 changed a file)**

```bash
git add shared/wxml-symbol-extractor.mjs
git commit -m "docs(shim): mark wxForBindings as having no runtime consumer (v2-C)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-review checklist (already run by plan author)

- **Spec coverage:** §1 scope split → Task 2 Step 3; §2 message → Task 2 Step 4; §3 shim-comment → Task 3 Step 3; §3 template-body unchanged → no task (intentionally untouched); new fixture → Task 1; E-1..E-7 → Task 2 Step 1; wasm/W-7 additive updates → Task 1 Steps 6-7; post-impl pre-scan → Task 3 Step 4.
- **No placeholders:** every code/command step shows exact content.
- **Type/name consistency:** `activeWxForBindingsAt(scopes, position)` signature matches `server/wxml-for-scope.mjs`; diagnostic object shape (`range.start.line`, `severity`, `code`, `source`, `message`) matches existing tests; `global`/`active` names consistent across Task 2 steps.
