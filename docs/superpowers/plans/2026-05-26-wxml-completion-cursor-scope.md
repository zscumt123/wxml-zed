# WXML Completion Cursor-Scope Tightening (v2-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `{{ }}` expression completion offers a `wx:for` loop binding only inside that loop's active scope (matching hover/definition), and an in-scope loop binding shadows a same-named data/property/wxs symbol.

**Architecture:** A new pure leaf helper `activeWxForBindingsAt(scopes, position)` returns the loop bindings active at a position; `dataRefCompletionItems` pushes them FIRST (so they win `seen` dedup over data/property/wxs) and gains a `position` parameter. Template-body completion stays suppressed; the `wxForBindings` shim is retained for diagnostics.

**Tech Stack:** Node ESM (`.mjs`), custom `assert()` verifier scripts, LSP stdio JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-05-26-wxml-completion-cursor-scope-design.md`

---

## File Structure

- **Modify** `server/wxml-for-scope.mjs` — add pure `activeWxForBindingsAt` (Task 1).
- **Modify** `scripts/verify-wxml-narrow-ranges.mjs` — unit tests B-U1..B-U6 (Task 1).
- **Modify** `server/wxml-language-service.mjs` — reorder + position-scope `dataRefCompletionItems`; thread `position` from `getCompletions` (Task 2).
- **Modify** `scripts/verify-wxml-language-service.mjs` — integration tests B-1..B-7 (Task 2).

---

## Task 1: Leaf helper `activeWxForBindingsAt` + unit tests

**Files:**
- Modify: `server/wxml-for-scope.mjs`
- Test: `scripts/verify-wxml-narrow-ranges.mjs`

- [ ] **Step 1: Write the failing unit tests (B-U1..B-U6)**

In `scripts/verify-wxml-narrow-ranges.mjs`, add an import at the top (with the other imports) and the test functions before the `CASES` array. The helper operates on synthetic scopes — no extraction needed.

```js
import { activeWxForBindingsAt } from "../server/wxml-for-scope.mjs";
```

```js
// Synthetic scope/range builders for activeWxForBindingsAt unit tests.
function rng(sr, sc, er, ec) {
  return { start: { row: sr, column: sc }, end: { row: er, column: ec } };
}
function scope(itemName, indexName, scopeRange, wxForRange) {
  return { itemName, indexName, scopeRange, wxForRange };
}

function testActiveBindingsOutside() {
  const scopes = [scope("item", "index", rng(0, 0, 5, 0), rng(0, 0, 0, 20))];
  const out = activeWxForBindingsAt(scopes, { line: 10, character: 0 });
  assert(out.length === 0, `B-U1: outside all scopes must be empty; got ${JSON.stringify(out)}`);
}

function testActiveBindingsSingle() {
  const scopes = [scope("item", "index", rng(0, 0, 5, 0), rng(0, 0, 0, 20))];
  const out = activeWxForBindingsAt(scopes, { line: 2, character: 4 });
  assert(out.length === 2, `B-U2: single active loop → item+index; got ${JSON.stringify(out)}`);
  assert(out[0].name === "item" && out[0].kind === "item", `B-U2: item entry; got ${JSON.stringify(out)}`);
  assert(out[1].name === "index" && out[1].kind === "index", `B-U2: index entry; got ${JSON.stringify(out)}`);
}

function testActiveBindingsNestedInnermostFirst() {
  // Pre-order extraction: outer pushed first, inner second.
  const scopes = [
    scope("outer", "oi", rng(0, 0, 10, 0), rng(0, 0, 0, 20)),
    scope("inner", "ii", rng(2, 0, 8, 0), rng(2, 0, 2, 20)),
  ];
  const out = activeWxForBindingsAt(scopes, { line: 5, character: 5 });
  // innermost-first: inner's bindings precede outer's.
  assert(out.map((b) => b.name).join(",") === "inner,ii,outer,oi",
    `B-U3: nested union innermost-first; got ${JSON.stringify(out.map((b) => b.name))}`);
}

function testActiveBindingsShadowInnermostFirst() {
  const scopes = [
    scope("x", "oi", rng(0, 0, 10, 0), rng(0, 0, 0, 20)),
    scope("x", "ii", rng(2, 0, 8, 0), rng(2, 0, 2, 20)),
  ];
  const out = activeWxForBindingsAt(scopes, { line: 5, character: 5 });
  // Both "x" present; the INNER one comes first so a seen-dedup keeps it.
  const firstX = out.find((b) => b.name === "x");
  assert(out[0].name === "x" && out[0].kind === "item", `B-U4: inner x first; got ${JSON.stringify(out)}`);
  assert(firstX === out[0], `B-U4: innermost x must be the first x`);
}

function testActiveBindingsIterableExclusion() {
  const scopes = [
    scope("outer", "oi", rng(0, 0, 10, 0), rng(0, 0, 0, 20)),
    scope("inner", "ii", rng(2, 0, 8, 0), rng(2, 0, 2, 40)),
  ];
  // Position inside inner's wxForRange (its iterable) → inner excluded, outer kept.
  const out = activeWxForBindingsAt(scopes, { line: 2, character: 10 });
  const names = out.map((b) => b.name);
  assert(!names.includes("inner") && !names.includes("ii"), `B-U5: inner excluded inside its iterable; got ${JSON.stringify(names)}`);
  assert(names.includes("outer"), `B-U5: enclosing outer still active; got ${JSON.stringify(names)}`);
}

function testActiveBindingsDefensive() {
  const scopes = [
    { itemName: "a", indexName: "ai" }, // no scopeRange / wxForRange
    scope("b", "bi", rng(0, 0, 5, 0), rng(0, 0, 0, 20)),
  ];
  let out;
  try {
    out = activeWxForBindingsAt(scopes, { line: 2, character: 2 });
  } catch (err) {
    throw new Error(`B-U6: threw on range-less scope: ${err.message}`);
  }
  assert(out.map((b) => b.name).join(",") === "b,bi", `B-U6: range-less scope skipped; got ${JSON.stringify(out)}`);
}
```

Register in the `CASES` array (append after the S-F9 entry):

```js
  ["B-U1: activeWxForBindingsAt outside all scopes", testActiveBindingsOutside],
  ["B-U2: activeWxForBindingsAt single loop", testActiveBindingsSingle],
  ["B-U3: activeWxForBindingsAt nested innermost-first", testActiveBindingsNestedInnermostFirst],
  ["B-U4: activeWxForBindingsAt same-name shadow innermost-first", testActiveBindingsShadowInnermostFirst],
  ["B-U5: activeWxForBindingsAt iterable-exclusion keeps outer", testActiveBindingsIterableExclusion],
  ["B-U6: activeWxForBindingsAt skips range-less scopes", testActiveBindingsDefensive],
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`
Expected: fails on B-U1 with an import/export error or `activeWxForBindingsAt is not a function` — the helper doesn't exist yet.

- [ ] **Step 3: Add the helper**

In `server/wxml-for-scope.mjs`, append after `scopesDeclaredWithin`:

```js
/**
 * All wx:for bindings (item + index of every loop) whose scope is active at the
 * position: scopeRange contains the position AND the loop's own wxForRange does
 * NOT (iterable-exclusion — an identifier inside `wx:for="{{x}}"` evaluates in
 * the OUTER scope, so the loop's own binding is not active there).
 *
 * Returned INNERMOST-FIRST (reverse extraction order; extraction is pre-order so
 * children come after parents). Callers that dedup by name keep the innermost
 * binding's kind/detail on a same-name shadow. Ordering does NOT determine UI
 * order — getCompletions sorts items by label afterward.
 *
 * Scopes missing scopeRange/wxForRange are skipped defensively (legacy graphs).
 */
export function activeWxForBindingsAt(scopes, position) {
  const out = [];
  for (let i = (scopes ?? []).length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!scope.scopeRange || !scope.wxForRange) continue;
    if (!containsPosition(scope.scopeRange, position)) continue;
    if (containsPosition(scope.wxForRange, position)) continue;
    out.push({ name: scope.itemName, kind: "item" });
    out.push({ name: scope.indexName, kind: "index" });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`
Expected: all cases pass, including B-U1..B-U6. Final line `Result: 21 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add server/wxml-for-scope.mjs scripts/verify-wxml-narrow-ranges.mjs
git commit -m "feat(for-scope): activeWxForBindingsAt(scopes, position) leaf helper

Returns wx:for bindings (item+index) whose scope is active at the position
(scopeRange contains it, wxForRange does not — iterable-exclusion),
innermost-first so callers' name-dedup keeps the innermost on a shadow.
Skips range-less scopes defensively. The position->active-bindings primitive
for completion (v2-B) and later diagnostics (v2-C). Unit cases B-U1..B-U6.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Position-scope `dataRefCompletionItems` + integration tests

**Files:**
- Modify: `server/wxml-language-service.mjs`
- Test: `scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Write the failing integration tests (B-1..B-7)**

In `scripts/verify-wxml-language-service.mjs`, add a helper + the test functions before the runner block. `LOOPS_WXML`, `TPL_LOOPS_WXML`, `ROOT`, `getCompletions`, `assert`, `fs` already exist.

```js
function loopsCompletion(graph, lineIdx, character) {
  return getCompletions({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character },
    sourceText: fs.readFileSync(LOOPS_WXML, "utf8"),
    extensionRoot: ROOT,
  });
}
function rootCharOf(lines, lineIdx, needle) {
  return lines[lineIdx].indexOf(needle) + 2; // first char after `{{`
}

function assertCompletionOutsideLoop(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes("outside-loop") && l.includes("{{item}}"));
  assert(i >= 0, "B-1 setup: outside-loop {{item}} line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{item}}"));
  const labels = items.map((x) => x.label);
  const item = items.find((x) => x.label === "item");
  assert(item && item.detail === "data", `B-1: item must be 'data' outside any loop; got ${item && item.detail}`);
  assert(!items.some((x) => x.detail === "wx:for index"), `B-1: no wx:for index outside loop; got ${JSON.stringify(labels)}`);
  for (const n of ["prod", "idx", "outer", "inner", "grp"]) {
    assert(!labels.includes(n), `B-1: explicit loop name '${n}' must be absent outside loops; got ${JSON.stringify(labels)}`);
  }
}

function assertCompletionDefaultLoopShadowsData(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes("{{item.name}}"));
  assert(i >= 0, "B-2 setup: {{item.name}} line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{item.name}}"));
  const item = items.find((x) => x.label === "item");
  assert(item && item.detail === "wx:for item", `B-2: in-scope item must shadow data.item (wx:for item); got ${item && item.detail}`);
  const index = items.find((x) => x.label === "index");
  assert(index && index.detail === "wx:for index", `B-2: index present as wx:for index; got ${index && index.detail}`);
  const labels = items.map((x) => x.label);
  for (const n of ["prod", "idx", "outer", "inner", "grp"]) {
    assert(!labels.includes(n), `B-2: '${n}' absent in default loop; got ${JSON.stringify(labels)}`);
  }
}

function assertCompletionExplicitLoop(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes("{{prod.title}}"));
  assert(i >= 0, "B-3 setup: {{prod.title}} line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{prod.title}}"));
  const labels = items.map((x) => x.label);
  const prod = items.find((x) => x.label === "prod");
  const idx = items.find((x) => x.label === "idx");
  assert(prod && prod.detail === "wx:for item", `B-3: prod as wx:for item; got ${prod && prod.detail}`);
  assert(idx && idx.detail === "wx:for index", `B-3: idx as wx:for index; got ${idx && idx.detail}`);
  assert(!labels.includes("index"), `B-3: default 'index' not in explicit loop; got ${JSON.stringify(labels)}`);
  for (const n of ["outer", "inner", "grp"]) {
    assert(!labels.includes(n), `B-3: other loop name '${n}' absent; got ${JSON.stringify(labels)}`);
  }
}

function assertCompletionNestedUnion(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes("{{outer.label}} :: {{inner.value}}"));
  assert(i >= 0, "B-4 setup: nested loop body line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{inner.value}}"));
  const labels = items.map((x) => x.label);
  assert(labels.includes("outer") && labels.includes("inner"), `B-4: nested scope offers both outer+inner; got ${JSON.stringify(labels)}`);
  for (const n of ["prod", "idx", "grp"]) {
    assert(!labels.includes(n), `B-4: unrelated loop name '${n}' absent; got ${JSON.stringify(labels)}`);
  }
}

function assertCompletionIterableExclusion(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes('wx:for="{{outer.entries}}"'));
  assert(i >= 0, "B-5 setup: inner loop iterable line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{outer.entries}}"));
  const labels = items.map((x) => x.label);
  assert(labels.includes("outer"), `B-5: enclosing 'outer' still offered inside inner iterable; got ${JSON.stringify(labels)}`);
  assert(!labels.includes("inner"), `B-5: 'inner' excluded inside its own iterable; got ${JSON.stringify(labels)}`);
}

function assertCompletionBlockLoop(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes("{{grp.label}}"));
  assert(i >= 0, "B-6 setup: {{grp.label}} line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{grp.label}}"));
  const labels = items.map((x) => x.label);
  const grp = items.find((x) => x.label === "grp");
  assert(grp && grp.detail === "wx:for item", `B-6: grp as wx:for item in <block wx:for>; got ${grp && grp.detail}`);
  for (const n of ["prod", "idx", "outer", "inner"]) {
    assert(!labels.includes(n), `B-6: other loop name '${n}' absent; got ${JSON.stringify(labels)}`);
  }
}

function assertCompletionTemplateBodySuppressed(graph) {
  const source = fs.readFileSync(TPL_LOOPS_WXML, "utf8");
  const lines = source.split("\n");
  const i = lines.findIndex((l) => l.includes("{{row.label}}"));
  assert(i >= 0, "B-7 setup: tpl-loops {{row.label}} line");
  const ch = lines[i].indexOf("{{row.label}}") + 2;
  const items = getCompletions({ graph, documentPath: TPL_LOOPS_WXML, position: { line: i, character: ch }, sourceText: source, extensionRoot: ROOT });
  assert(items.length === 0, `B-7: completion inside <template name> body must stay suppressed; got ${items.length} items`);
}
```

Register in the runner block (append after the last existing `assertX(graph);` call):

```js
assertCompletionOutsideLoop(graph);
assertCompletionDefaultLoopShadowsData(graph);
assertCompletionExplicitLoop(graph);
assertCompletionNestedUnion(graph);
assertCompletionIterableExclusion(graph);
assertCompletionBlockLoop(graph);
assertCompletionTemplateBodySuppressed(graph);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: fails on the first B-case to run, **B-1** (`no wx:for index outside loop`) — today the flat `wxForBindings` block offers `index` (and explicit loop names) file-wide via `hasAnyWxFor`, so they appear outside loops. (B-2 would also fail: `item` is labelled `data` today because data is pushed before the loop block.) The point is the B-suite fails pre-change.

- [ ] **Step 3: Reorder + position-scope `dataRefCompletionItems`**

In `server/wxml-language-service.mjs`:

(a) Extend the leaf import (line 16) to add `activeWxForBindingsAt`:
```js
import { containsPosition, findMatchingWxForBinding, findEnclosingTemplateRange, scopesDeclaredWithin, activeWxForBindingsAt } from "./wxml-for-scope.mjs";
```

(b) Change the function signature to accept `position`:
```js
function dataRefCompletionItems(graph, documentGraphPath, fileModel, range, position) {
```

(c) Inside the function, move the wx:for block to the TOP (right after `pushName` is defined, BEFORE the data/property push) and replace the flat `wxForBindings` block. The body becomes:
```js
  const pushName = (name, detail) => {
    if (typeof name !== "string" || name.length === 0) return;
    if (seen.has(name)) return;
    seen.add(name);
    items.push(completionItem(name, COMPLETION_ITEM_KIND_PROPERTY, detail, range));
  };

  // Active wx:for bindings FIRST so an in-scope loop variable shadows a
  // same-named data/property/wxs symbol, matching hover/definition (wx:for is
  // step 2a, ahead of 2b/2c/2d). seen first-wins gives the loop the candidate.
  for (const { name, kind } of activeWxForBindingsAt(fileModel.wxForScopes, position)) {
    pushName(name, kind === "item" ? "wx:for item" : "wx:for index");
  }

  if (ownerConfig && !ownerConfig.script.hasDynamicData) {
    for (const key of ownerConfig.script.dataKeys ?? []) pushName(key.name, "data");
    for (const key of ownerConfig.script.propertyKeys ?? []) pushName(key.name, "property");
  }

  for (const sym of fileModel.symbols ?? []) {
    if (sym.kind === "wxs") pushName(sym.name, "wxs module");
  }

  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
```
Delete the old `const bindings = fileModel.wxForBindings; if (bindings) { ... }` block entirely.

(d) Update the call site in `getCompletions` (line 739) to pass `position`:
```js
    return dataRefCompletionItems(graph, documentGraphPath, fileModel, interpolationContext.range, position);
```

- [ ] **Step 4: Run to verify they pass**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: exit 0 — B-1..B-7 pass, and every pre-existing completion test (data-ref / property / wxs module / object-literal / member-access / template suppression) plus all other assertions still pass.

- [ ] **Step 5: Commit**

```bash
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat(completion): cursor-scope wx:for bindings + shadow parity (v2-B)

dataRefCompletionItems now takes the cursor position and offers only the
wx:for bindings active at that position (via activeWxForBindingsAt), pushed
BEFORE data/property/wxs so an in-scope loop variable shadows a same-named
symbol — consistent with hover/definition. Removes the file-wide flat
wxForBindings consumption (shim retained for diagnostics). Template-body
completion stays suppressed upstream. Cases B-1..B-7.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Run the offline verifiers**

```bash
node scripts/verify-wxml-narrow-ranges.mjs
node scripts/verify-wasm-symbol-baselines.mjs
node scripts/verify-wxml-language-service.mjs ; echo "ls-exit: $?"
node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke ; echo "lsp-exit: $?"
```
Expected: narrow-ranges `21 passed, 0 failed` (incl B-U1..B-U6); `All 8 wasm symbol baselines match.`; language-service `ls-exit: 0` (B-1..B-7 + all pre-existing); graph-smoke `lsp-exit: 0`.

- [ ] **Step 2: Confirm no collateral change**

The change touches only `dataRefCompletionItems` (completion) and adds a leaf helper. Confirm in the Step 1 runs: existing completion tests (data ref, property, wxs module, object-literal/member-access/string suppression) stay green; hover/definition (W/D/HD + T-series) untouched; W-7 byte-equal green; the `wxForBindings` shim is still present in the extractor (only completion stopped reading it). No `graph.version` change in the diff.

- [ ] **Step 3: Run the umbrella verifier (if the environment permits)**

```bash
bash scripts/verify-tree-sitter.sh
```
Expected: `wxml-zed tree-sitter verification passed`. If it fails early with `EACCES` spawning the npx `tree-sitter` binary, that is a known sandbox restriction unrelated to this change — the Step 1 offline verifiers are the authoritative guard.

- [ ] **Step 4: Confirm clean tree and expected commits**

```bash
git status --short && git log --oneline -3
```
Expected: clean tree; the last commits are Tasks 1–2.

- [ ] **Step 5 (only if a verifier failed): debug, fix, re-run**

Do not claim completion on a red verifier. Read the failing assertion, fix the owning task's code, re-run that sub-verifier, then re-run Step 1. Commit the fix referencing the task it belongs to.
