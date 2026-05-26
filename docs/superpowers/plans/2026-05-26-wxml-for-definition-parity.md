# WXML wx:for Definition Parity (A) + Declaration-Side Hover (D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing per-element `wxForScopes[]` resolver to two more interaction points — cmd-click on `{{item}}` returns a `Location` (definition parity with hover), and hovering `wx:for-item="foo"` renders the loop card (declaration-side hover) — with zero behavior change to completion/diagnostics.

**Architecture:** Extract the pure position→scope resolvers into a new leaf module `server/wxml-for-scope.mjs` (no sibling imports, so it can't deepen the existing hover↔language-service cycle). `getDefinition` gains a wx:for branch mirroring hover step 2a; `getHover` gains a declaration-side branch. One additive `wxForKeywordRange` field on each scope is the definition target for default `item`/`index`. No `graph.version` bump.

**Tech Stack:** Node ESM (`.mjs`), tree-sitter WXML grammar, custom verifier scripts (no test framework — plain `assert()` runners), LSP stdio JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-05-26-wxml-for-definition-parity-design.md`

---

## File Structure

- **Modify** `shared/wxml-symbol-extractor.mjs` — add `wxForKeywordRange` to each `wxForScopes[]` entry (Task 1).
- **Create** `server/wxml-for-scope.mjs` — pure leaf module: `containsPosition`, `findMatchingWxForBinding` (moved from hover), `findWxForDeclarationAtPosition` (new) (Task 2).
- **Modify** `server/wxml-hover.mjs` — import resolvers from the leaf module; drop the local `findMatchingWxForBinding`; add the declaration-side hover branch (Tasks 2, 4).
- **Modify** `server/wxml-language-service.mjs` — import `containsPosition` from the leaf module (drop the local defs); add the `getDefinition` wx:for branch (Tasks 2, 3).
- **Modify** `scripts/verify-wxml-narrow-ranges.mjs` — S-F9 (`wxForKeywordRange` narrow) (Task 1).
- **Modify** `scripts/verify-wxml-language-service.mjs` — definition cases D-1..D-9, declaration-hover cases HD-1..HD-3 (Tasks 3, 4).
- **Modify** `scripts/verify-lsp-diagnostics.mjs` — host-wire definition test L-W2 + scenario registration (Task 5).
- **Regenerate** `fixtures/wasm-spike/*-symbols-baseline.json` (8 files) — additive `wxForKeywordRange` (Task 1).

---

## Task 1: Extract `wxForKeywordRange` on each wx:for scope

**Files:**
- Modify: `shared/wxml-symbol-extractor.mjs` (the `wxForScopes.push({ ... })` block)
- Test: `scripts/verify-wxml-narrow-ranges.mjs` (new case S-F9)
- Regenerate: `fixtures/wasm-spike/*-symbols-baseline.json`

- [ ] **Step 1: Write the failing test (S-F9)**

In `scripts/verify-wxml-narrow-ranges.mjs`, add this function just after `testBlockElementCreatesScope` (the S-F8 function):

```js
// S-F9: wxForKeywordRange is the narrow `wx:for` attribute-NAME token range
// (the definition target for default item/index), NOT the whole attribute.
function testWxForKeywordRange() {
  const result = extract("fixtures/miniprogram/pages/loops/loops.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  // The only implicit-item scope is the default <view wx:for="{{users}}"> loop.
  const usersScope = scopes.find((s) => s.itemName === "item" && s.itemSource === "implicit");
  assert(usersScope, `S-F9: expected implicit users scope; got ${JSON.stringify(scopes.map((s) => ({ i: s.itemName, src: s.itemSource })))}`);
  const kr = usersScope.wxForKeywordRange;
  assert(kr, `S-F9: wxForKeywordRange must be present; got ${JSON.stringify(usersScope)}`);
  assert(kr.start.row === kr.end.row, `S-F9: keyword range must be single-line; got ${JSON.stringify(kr)}`);
  assert(kr.end.column - kr.start.column === 6, `S-F9: 'wx:for' is 6 chars; got width ${kr.end.column - kr.start.column}`);
  const text = fs.readFileSync(path.join(ROOT, "fixtures/miniprogram/pages/loops/loops.wxml"), "utf8");
  const line = text.split("\n")[kr.start.row];
  const slice = line.slice(kr.start.column, kr.end.column);
  assert(slice === "wx:for", `S-F9: keyword range must cover exactly 'wx:for'; got '${slice}'`);
}
```

Register it in the `CASES` array (after the S-F8 entry):

```js
  ["S-F9: wxForKeywordRange covers the narrow wx:for attribute-name token", testWxForKeywordRange],
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`
Expected: `FAIL S-F9: ...` with "wxForKeywordRange must be present" (field doesn't exist yet). The other S-F cases still PASS.

- [ ] **Step 3: Add the field in the extractor**

In `shared/wxml-symbol-extractor.mjs`, inside the `if (wxForAttr) {` block, just before the `wxForScopes.push({` call, add the name-node lookup:

```js
          // Narrow range over the `wx:for` attribute-NAME token (e.g. the
          // literal `wx:for`), used as the definition target for default
          // item/index which have no explicit name attribute. Must NOT be
          // rangeOf(wxForAttr) — that is the whole `wx:for="{{...}}"` attribute
          // (already stored as wxForRange). Null-safe for grammar edge cases.
          const wxForNameNode = firstChildOfType(wxForAttr, "attribute_name");
```

Then add this line inside the `wxForScopes.push({ ... })` object literal (place it right after the `wxForRange:` line):

```js
            wxForKeywordRange: wxForNameNode ? rangeOf(wxForNameNode) : null,
```

- [ ] **Step 4: Run S-F9 to verify it passes**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`
Expected: all cases PASS including `PASS S-F9: ...`. Final line `Result: 15 passed, 0 failed`.

- [ ] **Step 5: Regenerate the 8 wasm symbol baselines (additive)**

The baselines embed full `wxForScopes[]`, so they now need the new field. The baseline verifier writes a fresh extraction to `$TMPDIR/wasm-baseline-<name>.json` for every case before diffing — use those as the regenerated content.

Run (produces fresh tmp files; will report diffs — that's expected):
```bash
node scripts/verify-wasm-symbol-baselines.mjs || true
```

Copy the fresh outputs over the committed baselines:
```bash
for f in home-symbols-baseline miniprogram-symbols-baseline test-wxml-symbols-baseline real-world-symbols-baseline edge-recovery-symbols-baseline non-ascii-symbols-baseline wx-for-unquoted-symbols-baseline wx-for-block-symbols-baseline; do
  cp "$TMPDIR/wasm-baseline-$f.json" "fixtures/wasm-spike/$f.json"
done
```

- [ ] **Step 6: Verify the baseline change is ADDITIVE only (structured)**

A line-grep is unreliable here — the new `wxForKeywordRange` object adds nested
`start`/`end`/`row`/`column` lines that don't contain the word
`wxForKeywordRange`. Instead, structurally compare the committed baselines
(`git show HEAD:<f>`, still pre-change at this point) against the working-tree
versions: strip every `wxForKeywordRange` key from the new JSON and assert deep
equality with the old. Equality proves the ONLY change was adding that field.

```bash
node -e '
const fs = require("fs"), cp = require("child_process");
const strip = (o) => Array.isArray(o) ? o.map(strip)
  : (o && typeof o === "object")
    ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== "wxForKeywordRange").map(([k, v]) => [k, strip(v)]))
    : o;
const files = cp.execSync("git diff --name-only -- fixtures/wasm-spike/", { encoding: "utf8" }).split("\n").filter(Boolean);
let bad = 0;
for (const f of files) {
  const oldJson = JSON.stringify(strip(JSON.parse(cp.execSync("git show HEAD:" + f, { encoding: "utf8" }))));
  const newJson = JSON.stringify(strip(JSON.parse(fs.readFileSync(f, "utf8"))));
  if (oldJson !== newJson) { console.error("NON-ADDITIVE change in " + f); bad++; }
  else { console.log("additive-only OK: " + f); }
}
process.exit(bad ? 1 : 0);
'
```
Expected: `additive-only OK:` for all 8 changed baselines, exit 0. If any file
reports NON-ADDITIVE, stop — the extractor edit had an unintended side effect.

Then confirm the verifier is green:
Run: `node scripts/verify-wasm-symbol-baselines.mjs`
Expected: `All 8 wasm symbol baselines match.`

- [ ] **Step 7: Commit**

```bash
git add shared/wxml-symbol-extractor.mjs scripts/verify-wxml-narrow-ranges.mjs fixtures/wasm-spike/
git commit -m "feat(extractor): add narrow wxForKeywordRange to wx:for scopes

Definition target for default item/index. Additive field (no graph.version
bump); 8 wasm baselines regenerated additively. Locked by S-F9.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Extract pure resolvers into leaf module `server/wxml-for-scope.mjs`

**Files:**
- Create: `server/wxml-for-scope.mjs`
- Modify: `server/wxml-hover.mjs` (imports + drop local `findMatchingWxForBinding`)
- Modify: `server/wxml-language-service.mjs` (drop local `containsPosition` + 3 point helpers; import from leaf)

This is a **behavior-preserving refactor**. The guard is that all existing hover wx:for tests (W-1..W-11, L-W1) stay green.

- [ ] **Step 1: Create the leaf module**

Create `server/wxml-for-scope.mjs` with exactly this content:

```js
// Pure, dependency-free resolvers over wxForScopes[] + an LSP position.
// Leaf module: imports NOTHING from sibling server/wxml-*.mjs, so both
// wxml-hover.mjs and wxml-language-service.mjs can import from it without
// forming a circular module graph. (containsPosition + findMatchingWxForBinding
// were moved here from those two modules; findWxForDeclarationAtPosition is new.
// See docs/superpowers/plans/2026-05-26-wxml-for-definition-parity.md.)

function symbolPointToLsp(point) {
  return { line: point.row, character: point.column };
}

function isPositionAtOrAfter(position, boundary) {
  return (
    position.line > boundary.line ||
    (position.line === boundary.line && position.character >= boundary.character)
  );
}

function isPositionBefore(position, boundary) {
  return (
    position.line < boundary.line ||
    (position.line === boundary.line && position.character < boundary.character)
  );
}

// Half-open containment: [start, end). Range is in symbol-extractor point form
// ({ row, column }); position is in LSP form ({ line, character }).
export function containsPosition(range, position) {
  const start = symbolPointToLsp(range.start);
  const end = symbolPointToLsp(range.end);
  return isPositionAtOrAfter(position, start) && isPositionBefore(position, end);
}

/**
 * Scan wxForScopes in reverse extraction order (innermost-first AND
 * later-source-first for ties) and return the first scope whose itemName
 * or indexName matches the requested name at this cursor position.
 *
 * A scope is "active" when the cursor is inside its scopeRange AND NOT
 * inside its own wxForRange (the iterable-exclusion rule: in
 * <view wx:for="{{item}}" wx:for-item="item">, cursor inside the wx:for
 * value evaluates in the outer scope).
 */
export function findMatchingWxForBinding(scopes, position, name) {
  for (let i = (scopes ?? []).length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!containsPosition(scope.scopeRange, position)) continue;
    if (containsPosition(scope.wxForRange, position)) continue;
    if (name === scope.itemName) return { scope, kind: "item" };
    if (name === scope.indexName) return { scope, kind: "index" };
  }
  return null;
}

/**
 * Declaration-side lookup: return { scope, kind } when the cursor is inside an
 * EXPLICIT wx:for-item / wx:for-index attribute value (itemNameRange /
 * indexNameRange). Implicit bindings have null name ranges, so they never match
 * here — there is no declaration text to put a cursor on.
 */
export function findWxForDeclarationAtPosition(scopes, position) {
  for (let i = (scopes ?? []).length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (scope.itemNameRange && containsPosition(scope.itemNameRange, position)) {
      return { scope, kind: "item" };
    }
    if (scope.indexNameRange && containsPosition(scope.indexNameRange, position)) {
      return { scope, kind: "index" };
    }
  }
  return null;
}
```

- [ ] **Step 2: Remove the moved code from `wxml-language-service.mjs`**

Delete these four function definitions from `server/wxml-language-service.mjs` (they now live in the leaf module): `symbolPointToLsp`, `isPositionAtOrAfter`, `isPositionBefore`, and the exported `containsPosition`. The block to delete looks like:

```js
function symbolPointToLsp(point) {
  return {
    line: point.row,
    character: point.column,
  };
}
// ... isPositionAtOrAfter, isPositionBefore ...
export function containsPosition(range, position) {
  const start = symbolPointToLsp(range.start);
  const end = symbolPointToLsp(range.end);
  return isPositionAtOrAfter(position, start) && isPositionBefore(position, end);
}
```

Then import `containsPosition` from the leaf module (a **local binding** is required — this module has 5 internal `containsPosition(...)` call sites) and re-export it to preserve the `@internal` surface. A bare `export { containsPosition } from "./..."` would NOT create a usable local binding, so do both an import and an export. Add near the top of the file with the other imports:

```js
// containsPosition moved to the pure leaf module. Import for local use (5 call
// sites here) AND re-export to preserve the @internal surface this module
// previously provided to siblings.
import { containsPosition } from "./wxml-for-scope.mjs";
export { containsPosition };
```

- [ ] **Step 3: Rewire `wxml-hover.mjs` imports and drop its local resolver**

In `server/wxml-hover.mjs`:

(a) Remove `containsPosition` from the existing `import { ... } from "./wxml-language-service.mjs";` block (keep `findOwnerConfigWithScript`, `findWxmlFileModel`, `isInsideGraphRoot`, `rangeFromSymbolRange`).

(b) Add a new import from the leaf module:

```js
import {
  containsPosition,
  findMatchingWxForBinding,
  findWxForDeclarationAtPosition,
} from "./wxml-for-scope.mjs";
```

(c) Delete the local `function findMatchingWxForBinding(...) { ... }` definition (it's now imported). Keep `makeWxForHover` and `HOVER_KIND_LABELS` — those stay here.

(d) Update the TDZ note comment block: `containsPosition` is no longer imported from language-service, so remove it from the parenthetical helper list. The cycle still exists for the remaining language-service helpers, so keep the note itself. Change the list to: `(findOwnerConfigWithScript, findWxmlFileModel, isInsideGraphRoot, rangeFromSymbolRange)`.

- [ ] **Step 4: Run the resolver-move guard (W-1..W-11 + L-W1)**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: all assertions pass, including the W-1..W-11 hover cases. Process exits 0.

Run: `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke`
Expected: all green, including `hover wx:for binding` (L-W1).

This proves the extraction changed no hover behavior.

- [ ] **Step 5: Commit**

```bash
git add server/wxml-for-scope.mjs server/wxml-hover.mjs server/wxml-language-service.mjs
git commit -m "refactor(server): extract pure wx:for resolvers to leaf wxml-for-scope.mjs

Move containsPosition + findMatchingWxForBinding into a dependency-free leaf
module so getDefinition can reuse the resolver without deepening the existing
hover<->language-service cycle. Add findWxForDeclarationAtPosition for the
upcoming declaration-side hover. Behavior-preserving: W-1..W-11 + L-W1 green.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: getDefinition step 2a (A) + legacy-graph degrade

**Files:**
- Modify: `server/wxml-language-service.mjs` (`getDefinition`, expression-ref block)
- Test: `scripts/verify-wxml-language-service.mjs` (D-1..D-9)

- [ ] **Step 1: Write the failing tests (D-1..D-9)**

In `scripts/verify-wxml-language-service.mjs`, add a small local helper and the ten assert functions (D-1..D-10) just before the runner block (the area where `assertHoverOnBlockWxForItem` is defined). Note: `getDefinition` returns ranges in LSP form (`{ start: { line, character } }`).

```js
// Returns the single-line text covered by an LSP range, for asserting a
// definition Location points at the expected declaration token.
function lspRangeText(lines, range) {
  if (range.start.line !== range.end.line) return null;
  return lines[range.start.line].slice(range.start.character, range.end.character);
}

function loopsLines() {
  return fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
}

function defAt(graph, lineIdx, character) {
  return getDefinition({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character },
    extensionRoot: ROOT,
  });
}

function assertDefinitionExplicitWxForItem(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{prod.title}}"));
  const ch = lines[i].indexOf("{{prod.title}}") + 2; // on `p` of prod
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-1: expected Location for explicit wx:for-item `prod`");
  assert(loc.uri.endsWith("/fixtures/miniprogram/pages/loops/loops.wxml"), `D-1: same-file uri; got ${loc.uri}`);
  assert(lspRangeText(lines, loc.range) === "prod", `D-1: range must cover 'prod'; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionExplicitWxForIndex(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("#{{idx}}"));
  const ch = lines[i].indexOf("#{{idx}}") + 3; // on `i` of idx (skip `#{{`)
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-2: expected Location for explicit wx:for-index `idx`");
  assert(lspRangeText(lines, loc.range) === "idx", `D-2: range must cover 'idx'; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionDefaultWxForItem(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{item.name}}"));
  const ch = lines[i].indexOf("{{item.name}}") + 2; // on `i` of item
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-3: expected Location for default item");
  assert(loc.uri.endsWith("/fixtures/miniprogram/pages/loops/loops.wxml"), `D-3: same-file uri; got ${loc.uri}`);
  assert(lspRangeText(lines, loc.range) === "wx:for", `D-3: default item must jump to the wx:for token; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionDefaultWxForIndex(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("({{index}})"));
  const ch = lines[i].indexOf("({{index}})") + 3; // on `i` of index (skip `({{`)
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-4: expected Location for default index");
  assert(lspRangeText(lines, loc.range) === "wx:for", `D-4: default index must jump to the wx:for token; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionNestedShadowing(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{outer.label}} :: {{inner.value}}"));
  const innerCh = lines[i].indexOf("{{inner.value}}") + 2;
  const innerLoc = defAt(graph, i, innerCh + 1);
  assert(innerLoc && lspRangeText(lines, innerLoc.range) === "inner", `D-5: inner ref must jump to wx:for-item="inner"; got '${innerLoc && lspRangeText(lines, innerLoc.range)}'`);
  const outerCh = lines[i].indexOf("{{outer.label}}") + 2;
  const outerLoc = defAt(graph, i, outerCh + 1);
  assert(outerLoc && lspRangeText(lines, outerLoc.range) === "outer", `D-5: outer ref must jump to wx:for-item="outer"; got '${outerLoc && lspRangeText(lines, outerLoc.range)}'`);
}

function assertDefinitionWxForShadowsData(graph) {
  // Collision loop body: {{item.label}} resolves to wx:for-item="item" (in-file),
  // NOT data.item in loops.js.
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{item.label}}"));
  const ch = lines[i].indexOf("{{item.label}}") + 2;
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-6: expected Location for shadowing item");
  assert(loc.uri.endsWith("/fixtures/miniprogram/pages/loops/loops.wxml"), `D-6: wx:for must win over data (stay in-file); got ${loc.uri}`);
  assert(lspRangeText(lines, loc.range) === "item", `D-6: must jump to wx:for-item="item"; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionOutsideLoopFallsThroughToData(graph) {
  // Outside any loop, {{item}} is NOT a binding; the wx:for branch finds no
  // scope and control falls through to the data lookup → loops.js.
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("outside-loop") && l.includes("{{item}}"));
  const ch = lines[i].indexOf("{{item}}") + 2;
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-7: expected fall-through Location to data.item");
  assert(loc.uri.endsWith("/fixtures/miniprogram/pages/loops/loops.js"), `D-7: outside loop must fall through to data (loops.js); got ${loc.uri}`);
}

function assertDefinitionBlockWxForItem(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{grp.label}}"));
  const ch = lines[i].indexOf("{{grp.label}}") + 2;
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-8: expected Location for <block wx:for> item `grp`");
  assert(loc.uri.endsWith("/fixtures/miniprogram/pages/loops/loops.wxml"), `D-8: same-file uri; got ${loc.uri}`);
  assert(lspRangeText(lines, loc.range) === "grp", `D-8: must jump to wx:for-item="grp"; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionWxForLegacyGraphDegrades(graph) {
  // Simulate a graph built before wxForKeywordRange existed (no version bump):
  // strip the field, then request definition on the default index, which has no
  // data fallback. The wx:for branch must degrade to a clean null WITHOUT
  // throwing in rangeFromSymbolRange.
  const cloned = JSON.parse(JSON.stringify(graph));
  const loopsFile = cloned.wxml.find((f) => f.path === LOOPS_WXML_GRAPH_PATH);
  assert(loopsFile, "D-9 setup: loops file in cloned graph");
  let stripped = 0;
  for (const s of loopsFile.wxForScopes ?? []) {
    if ("wxForKeywordRange" in s) { delete s.wxForKeywordRange; stripped += 1; }
  }
  assert(stripped > 0, "D-9 setup: expected at least one wxForKeywordRange to strip");
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("({{index}})"));
  const ch = lines[i].indexOf("({{index}})") + 3;
  let loc;
  try {
    loc = getDefinition({
      graph: cloned,
      documentPath: LOOPS_WXML,
      position: { line: i, character: ch + 1 },
      extensionRoot: ROOT,
    });
  } catch (err) {
    throw new Error(`D-9: getDefinition threw on a graph missing wxForKeywordRange: ${err.message}`);
  }
  assert(loc === null, `D-9: degraded implicit-index definition must be null; got ${JSON.stringify(loc)}`);
}

function assertDefinitionWxForExplicitLegacyDegrades(graph) {
  // Source-based selection guard: an EXPLICIT binding whose nameRange is missing
  // on a legacy graph must NOT fall back to wxForKeywordRange (would jump to the
  // wx:for token, wrong per spec). It must degrade — here `prod` has no data
  // fallback, so the result is a clean null without throwing.
  const cloned = JSON.parse(JSON.stringify(graph));
  const loopsFile = cloned.wxml.find((f) => f.path === LOOPS_WXML_GRAPH_PATH);
  assert(loopsFile, "D-10 setup: loops file in cloned graph");
  const prodScope = (loopsFile.wxForScopes ?? []).find((s) => s.itemName === "prod");
  assert(prodScope && prodScope.itemSource === "explicit", "D-10 setup: expected explicit prod scope");
  delete prodScope.itemNameRange; // simulate pre-field legacy graph
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{prod.title}}"));
  const ch = lines[i].indexOf("{{prod.title}}") + 2;
  let loc;
  try {
    loc = getDefinition({
      graph: cloned,
      documentPath: LOOPS_WXML,
      position: { line: i, character: ch + 1 },
      extensionRoot: ROOT,
    });
  } catch (err) {
    throw new Error(`D-10: getDefinition threw on explicit scope missing itemNameRange: ${err.message}`);
  }
  assert(loc === null, `D-10: explicit binding missing nameRange must degrade to null (not jump to wx:for); got ${JSON.stringify(loc)}`);
}
```

Register all ten in the runner block (append after the `assertHoverOnBlockWxForItem(graph);` line):

```js
assertDefinitionExplicitWxForItem(graph);
assertDefinitionExplicitWxForIndex(graph);
assertDefinitionDefaultWxForItem(graph);
assertDefinitionDefaultWxForIndex(graph);
assertDefinitionNestedShadowing(graph);
assertDefinitionWxForShadowsData(graph);
assertDefinitionOutsideLoopFallsThroughToData(graph);
assertDefinitionBlockWxForItem(graph);
assertDefinitionWxForLegacyGraphDegrades(graph);
assertDefinitionWxForExplicitLegacyDegrades(graph);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: throws on D-1 (or D-3) — definition returns `null` because `getDefinition` has no wx:for branch yet. (D-7 might pass incidentally via the data path; the explicit/default cases will fail.)

- [ ] **Step 3: Add the wx:for branch to `getDefinition`**

In `server/wxml-language-service.mjs`, extend the leaf-module import added in Task 2 Step 2 to also pull in the resolver:

```js
import { containsPosition, findMatchingWxForBinding } from "./wxml-for-scope.mjs";
export { containsPosition };
```

Then, inside `getDefinition`, in the `if (expressionRefMatch) {` block, immediately after `if (expressionRefMatch.inTemplateDefinition) return null;` and **before** the `const ownerConfig = ...` line, insert:

```js
    // 2a. wx:for binding — mirrors getHover step 2a. A loop binding shadows
    // data/property/wxs of the same name inside the loop body (parity with W-8).
    // Resolves to a same-file Location: explicit name → its narrow nameRange;
    // implicit default item/index → the `wx:for` attribute-name token.
    const wxForBinding = findMatchingWxForBinding(
      fileModel.wxForScopes,
      position,
      expressionRefMatch.name,
    );
    if (wxForBinding) {
      const { scope, kind } = wxForBinding;
      // Select the target range by SOURCE, not by presence (matches the spec
      // table): explicit → its name range; implicit → the wx:for token. Keying
      // on source means an explicit binding whose nameRange is missing on a
      // legacy graph does NOT wrongly fall back to wxForKeywordRange — it yields
      // undefined and degrades to fall-through, exactly like a missing implicit
      // wxForKeywordRange. Both degrade paths avoid passing undefined into
      // rangeFromSymbolRange (which dereferences range.start.row and would throw).
      const targetRange = kind === "item"
        ? (scope.itemSource === "explicit" ? scope.itemNameRange : scope.wxForKeywordRange)
        : (scope.indexSource === "explicit" ? scope.indexNameRange : scope.wxForKeywordRange);
      if (targetRange) {
        return locationForGraphPathWithRange(documentGraphPath, targetRange, extensionRoot);
      }
      // targetRange absent (legacy graph) → fall through to data/property/wxs.
    }
```

Note the control flow: when `wxForBinding` matches and `targetRange` is present, return the in-file Location. When `wxForBinding` is null (outside any loop) or `targetRange` is absent (degraded graph), do **not** return — control falls through to the existing 2b/2c data/property/wxs lookup, then the block's final `return null`.

- [ ] **Step 4: Run to verify they pass**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: all assertions pass, including D-1..D-9. Process exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat(definition): wx:for binding parity (getDefinition step 2a)

cmd-click on {{item}} / {{foo}} now returns a same-file Location: explicit
names jump to their wx:for-item/index value, default item/index jump to the
wx:for attribute-name token. Shadowing/nesting/iterable-exclusion inherited
from the shared resolver. Target range selected by source (explicit -> name
range, implicit -> wx:for token); legacy graphs missing either range degrade by
falling through (no crash, no wrong jump). Cases D-1..D-10.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Declaration-side hover (D)

**Files:**
- Modify: `server/wxml-hover.mjs` (`getHover`, new branch)
- Test: `scripts/verify-wxml-language-service.mjs` (HD-1..HD-3)

- [ ] **Step 1: Write the failing tests (HD-1..HD-3)**

In `scripts/verify-wxml-language-service.mjs`, add these three functions near the other hover asserts (e.g. after `assertHoverOnBlockWxForItem`). They reuse the existing `hoverContents` helper.

```js
function assertHoverOnWxForItemDeclaration(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(`wx:for-item="prod"`));
  const ch = lines[i].indexOf(`wx:for-item="prod"`) + `wx:for-item="`.length; // on `p`
  const hover = getHover({ graph, documentPath: LOOPS_WXML, position: { line: i, character: ch + 1 }, extensionRoot: ROOT });
  assert(hover, "HD-1: expected Hover on wx:for-item declaration");
  const value = hoverContents(hover);
  assert(value.startsWith("**prod** — `wx:for-item`"), `HD-1: bad title; got ${value}`);
}

function assertHoverOnWxForIndexDeclaration(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(`wx:for-index="idx"`));
  const ch = lines[i].indexOf(`wx:for-index="idx"`) + `wx:for-index="`.length; // on `i`
  const hover = getHover({ graph, documentPath: LOOPS_WXML, position: { line: i, character: ch + 1 }, extensionRoot: ROOT });
  assert(hover, "HD-2: expected Hover on wx:for-index declaration");
  const value = hoverContents(hover);
  assert(value.startsWith("**idx** — `wx:for-index`"), `HD-2: bad title; got ${value}`);
}

function assertHoverOnIterableValueResolvesData(graph) {
  // The `users` inside wx:for="{{users}}" is the iterable, NOT a declaration.
  // The declaration-side branch must NOT fire; it resolves as data (loops.js).
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(`wx:for="{{users}}"`));
  const ch = lines[i].indexOf(`wx:for="{{users}}"`) + `wx:for="{{`.length; // on `u`
  const hover = getHover({ graph, documentPath: LOOPS_WXML, position: { line: i, character: ch + 1 }, extensionRoot: ROOT });
  assert(hover, "HD-3: expected Hover for `users` on the iterable value");
  const value = hoverContents(hover);
  assert(value.includes("`data`"), `HD-3: iterable value must resolve as data, not a wx:for card; got ${value}`);
}
```

Register in the runner block (after the D-1..D-9 lines):

```js
assertHoverOnWxForItemDeclaration(graph);
assertHoverOnWxForIndexDeclaration(graph);
assertHoverOnIterableValueResolvesData(graph);
```

- [ ] **Step 2: Run to verify HD-1/HD-2 fail**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: throws on HD-1 — hover returns `null` on the declaration value (no branch yet). HD-3 likely already passes (the iterable `users` resolves as data today).

- [ ] **Step 3: Add the declaration-side hover branch**

In `server/wxml-hover.mjs`, inside `getHover`, insert this branch immediately after the `if (expressionRefMatch) { ... }` block closes and **before** the `// 3. Component tag match` comment:

```js
  // D. Declaration-side hover: cursor inside an EXPLICIT wx:for-item /
  // wx:for-index attribute value. Renders the same card as the use-site (2a).
  // These name ranges never overlap interpolation or event-handler ranges, so
  // this cannot collide with branches 1/2. Implicit bindings have null name
  // ranges and never match (the resolver guards on range presence).
  const wxForDecl = findWxForDeclarationAtPosition(fileModel.wxForScopes, position);
  if (wxForDecl) {
    const refRange = wxForDecl.kind === "item"
      ? wxForDecl.scope.itemNameRange
      : wxForDecl.scope.indexNameRange;
    return makeWxForHover(wxForDecl.scope, wxForDecl.kind, refRange);
  }
```

(`findWxForDeclarationAtPosition` is already imported from `wxml-for-scope.mjs` per Task 2 Step 3.)

- [ ] **Step 4: Run to verify they pass**

Run: `node scripts/verify-wxml-language-service.mjs`
Expected: all pass, including HD-1, HD-2, HD-3.

- [ ] **Step 5: Commit**

```bash
git add server/wxml-hover.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat(hover): declaration-side wx:for hover

Hovering an explicit wx:for-item / wx:for-index attribute value renders the
same loop card as the use-site. The iterable value (wx:for=\"{{users}}\") still
resolves as data — the branch only fires inside explicit name ranges. Cases
HD-1..HD-3.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Host-wire definition test (L-W2) + scenario registration

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs` (new test + `scenarios` + `graph-smoke`)

- [ ] **Step 1: Write the host-wire test**

In `scripts/verify-lsp-diagnostics.mjs`, add this function next to `testHoverWxForBinding`:

```js
async function testDefinitionWxForBinding() {
  // L-W2: open loops.wxml, go-to-definition on the default-loop `item` in
  // {{item.name}}, assert it resolves to a same-file Location (the wx:for attr).
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(LOOPS_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 0, "loops diagnostics before definition wx:for");
    // loops.wxml line 4 (row 3): `    {{item.name}} ({{index}})` — cursor on `item`.
    const result = await client.definition(LOOPS_WXML, { line: 3, character: 7 });
    assert(result, "L-W2: expected Location, got null");
    const loc = Array.isArray(result) ? result[0] : result;
    assert(
      loc && typeof loc.uri === "string" && loc.uri.endsWith("/fixtures/miniprogram/pages/loops/loops.wxml"),
      `L-W2: expected same-file loops.wxml Location; got ${JSON.stringify(result)}`,
    );
    // Also assert the wire-level range points at the `wx:for` token (default
    // item → wxForKeywordRange), so the integration path can't pass with a
    // same-file-but-wrong range.
    const r = loc.range;
    assert(r && r.start.line === r.end.line, `L-W2: expected single-line range; got ${JSON.stringify(r)}`);
    const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
    const slice = lines[r.start.line].slice(r.start.character, r.end.character);
    assert(slice === "wx:for", `L-W2: wire range must cover the wx:for token; got '${slice}'`);
  });
}
```

- [ ] **Step 2: Register the scenario**

In the `scenarios` array, add after the `["hover wx:for binding", testHoverWxForBinding],` line:

```js
  ["definition wx:for binding", testDefinitionWxForBinding],
```

In `SCENARIO_SUITES["graph-smoke"]`, add after the `"hover wx:for binding",` line:

```js
    "definition wx:for binding",
```

- [ ] **Step 3: Run the graph-smoke suite**

Run: `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke`
Expected: all green; the suite now runs 21 scenarios (was 20), including `definition wx:for binding`.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-lsp-diagnostics.mjs
git commit -m "test(lsp): L-W2 host-wire test for wx:for definition

Drives textDocument/definition on {{item}} through the real LSP path and
asserts a same-file Location. Registered in scenarios + graph-smoke (20->21).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Full verification sweep + invariant confirmation

**Files:** none (verification only)

- [ ] **Step 1: Run the umbrella verifier**

Run: `bash scripts/verify-tree-sitter.sh`
Expected: completes with no failures. This runs the full chain including `verify-wxml-language-service.mjs`, `verify-wasm-symbol-baselines.mjs` (8/8), `verify-wxml-narrow-ranges.mjs` (15/15, incl. S-F9), and `verify-lsp-diagnostics.mjs --suite graph-smoke` (21 scenarios).

- [ ] **Step 2: Confirm the zero-behavior-change invariant**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`
Expected: `W-7: wxForBindings compat shim is byte-equal across all baselines` PASSES — proving completion/diagnostics inputs are unchanged. Also confirm no new wx:for completion/diagnostic scenario was added (this plan added only definition + hover cases).

- [ ] **Step 3: Confirm working tree is clean and the branch builds the expected commits**

Run: `git status --short && git log --oneline -6`
Expected: clean tree; the last commits are Tasks 1–5 plus this verification (no commit needed for Task 6 unless a fix was required).

- [ ] **Step 4 (if any verifier failed): debug, fix, re-run**

If `verify-tree-sitter.sh` reports a failure, do NOT claim completion. Read the failing assertion, fix the offending task's code, re-run that sub-verifier, then re-run the umbrella. Commit the fix referencing the task it belongs to.
