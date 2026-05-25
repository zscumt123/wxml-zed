# WXML wx:for Per-Element Scope Graph (Phase 1: Hover Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-element `wxForScopes[]` to `fileModel` and consume it from `getHover` step 2a so cursor-on-`{{item}}` / `{{index}}` resolves per WXML lexical scope semantics. Legacy `wxForBindings` becomes a derived compat shim; completion / diagnostics / definition behavior is unchanged in this phase.

**Architecture:** Single extractor pass produces `wxForScopes[]` (real loops only) plus internal `wxForLooseItems` / `wxForLooseIndexes` accumulators (legacy quirk preservation). `wxForBindings` is emitted as a derived view of both. Hover's expression-ref AUTHORITATIVE branch gains a new step 2a above dataKeys/propertyKeys/wxs that scans `wxForScopes` reverse-extraction-order (innermost-first), with `wxForRange` exclusion so a loop's own iterable expression doesn't bind to its own loop variable.

**Tech Stack:** Node.js, web-tree-sitter, WXML grammar; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-25-wxml-for-scope-graph-design.md` (commit `2749c91`).

**Test harness:** No npm scripts. Run verifiers directly via `node scripts/<name>.mjs`; umbrella is `bash scripts/verify-tree-sitter.sh`.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `fixtures/miniprogram/pages/loops/loops.wxml` | Create | Real loop fixtures: default wx:for, explicit names, nested shadowing, iterable name collision. Underpins W-1/W-2/W-3/W-4/W-9. |
| `fixtures/miniprogram/pages/loops/loops.js` | Create | Page script with `data: { item: ... }` for W-8/W-10 priority tests + the loops fixture's iterables. |
| `fixtures/miniprogram/pages/loops/loops.json` | Create | Empty page config. |
| `fixtures/miniprogram/app.json` | Modify | Register the new `pages/loops/loops` path. |
| `fixtures/wasm-spike/wx-for-empty-attr.wxml` | Create | Standalone S-F4 fixture (empty `wx:for-item=""`). |
| `fixtures/wasm-spike/wx-for-loose-attr.wxml` | Create | Standalone S-F5 fixture (loose `wx:for-item` without `wx:for`). |
| `fixtures/wasm-spike/wx-for-bare.wxml` | Create | Standalone S-F6 fixture (bare `wx:for` with no value — legacy hasAnyWxFor preservation). |
| `fixtures/wasm-spike/wx-for-interp-item.wxml` | Create | Standalone S-F7 fixture (`wx:for-item="{{dyn}}"` — legacy quotedAttrTextValue interpolation gate). |
| `shared/wxml-symbol-extractor.mjs` | Modify | Add `wxForScopes` accumulator, `wxForLooseItems` / `wxForLooseIndexes` accumulators, derive `wxForBindings` from both at emit time. |
| `fixtures/wasm-spike/*-symbols-baseline.json` | Regenerate | Add `wxForScopes` field on every fileModel; `wxForBindings` shape must byte-equal pre-change values. |
| `scripts/verify-wxml-narrow-ranges.mjs` | Modify | Add S-F1 through S-F7 plus W-7 frozen-snapshot invariant. |
| `server/wxml-hover.mjs` | Modify | Add `wxForItem` / `wxForIndex` kind labels, `findMatchingWxForBinding`, `makeWxForHover`; insert step 2a at top of expression-ref AUTHORITATIVE branch. |
| `scripts/verify-wxml-language-service.mjs` | Modify | Add W-1 through W-10. |
| `scripts/verify-lsp-diagnostics.mjs` | Modify | Add L-W1 scenario, register in `graph-smoke` suite. |
| `docs/wasm-parser-spike-notes.md` | Modify | Append 2026-05-25 dogfood entry. |

Commit cadence: one commit per task. Work on `main` (project-authorized).

---

## Task 1: Add the `pages/loops/` real-loop fixture

**Files:**
- Create: `fixtures/miniprogram/pages/loops/loops.wxml`
- Create: `fixtures/miniprogram/pages/loops/loops.js`
- Create: `fixtures/miniprogram/pages/loops/loops.json`
- Modify: `fixtures/miniprogram/app.json`
- Regenerate: every baseline in `fixtures/wasm-spike/` that touches the `miniprogram` glob (specifically `miniprogram-symbols-baseline.json`)

**Background:** All W-* hover tests need real WXML positions inside loops. Adding a dedicated `pages/loops/` page with multiple loop shapes gives every later test a stable cursor target without touching home.wxml. This task does ONLY the fixture additions — no extractor or hover changes. Baselines regenerate to include the new file with its *current-shape* (pre-wxForScopes) `wxForBindings`. That snapshot becomes the W-7 frozen-literal for the new fixture.

- [ ] **Step 1: Create `fixtures/miniprogram/pages/loops/loops.wxml`**

```wxml
<view class="loops">
  <!-- Default wx:for: itemName="item", indexName="index". -->
  <view class="row" wx:for="{{users}}" wx:key="id">
    {{item.name}} ({{index}})
  </view>

  <!-- Explicit wx:for-item and wx:for-index. -->
  <view class="row" wx:for="{{products}}" wx:key="sku" wx:for-item="prod" wx:for-index="idx">
    {{prod.title}} #{{idx}}
  </view>

  <!-- Nested loops with shadowing on inner name; outer remains addressable. -->
  <view wx:for="{{groups}}" wx:for-item="outer" wx:key="id">
    <view wx:for="{{outer.entries}}" wx:for-item="inner" wx:key="id">
      {{outer.label}} :: {{inner.value}}
    </view>
  </view>

  <!-- Iterable name collision: wx:for="{{item}}" wx:for-item="item".
       Inside wx:for="{{item}}" the `item` reads from outer scope (data),
       inside body it's the loop variable. -->
  <view wx:for="{{item}}" wx:for-item="item" wx:key="id">
    {{item.label}}
  </view>

  <!-- A reference OUTSIDE any wx:for body — should NOT have item in scope. -->
  <view class="outside-loop">{{item}}</view>
</view>
```

- [ ] **Step 2: Create `fixtures/miniprogram/pages/loops/loops.js`**

```js
Page({
  data: {
    item: { label: "fallback-from-data" },
    users: [],
    products: [],
    groups: [],
  },
  onLoad() {},
});
```

(The `item` in data is intentional — used by W-8 / W-10 to test priority of wx:for binding shadowing data.)

- [ ] **Step 3: Create `fixtures/miniprogram/pages/loops/loops.json`**

```json
{
  "navigationBarTitleText": "Loops"
}
```

- [ ] **Step 4: Register the page in `fixtures/miniprogram/app.json`**

Modify the `pages` array. Replace:

```json
  "pages": [
    "pages/home/home",
    "pages/detail/detail",
    "pages/cross-binding/cross-binding",
    "pages/dyn-page/dyn-page"
  ],
```

with:

```json
  "pages": [
    "pages/home/home",
    "pages/detail/detail",
    "pages/cross-binding/cross-binding",
    "pages/dyn-page/dyn-page",
    "pages/loops/loops"
  ],
```

- [ ] **Step 5: Regenerate the miniprogram baseline**

```bash
node scripts/extract-wxml-symbols.mjs $(find fixtures/miniprogram -name "*.wxml" | sort) > fixtures/wasm-spike/miniprogram-symbols-baseline.json
```

Inspect: `git diff fixtures/wasm-spike/miniprogram-symbols-baseline.json` should show only ADDITIONS for the new `pages/loops/loops.wxml` entry — no changes to existing entries.

- [ ] **Step 6: Confirm everything still passes**

```bash
node scripts/verify-wxml-narrow-ranges.mjs
node scripts/verify-wasm-symbol-baselines.mjs
node scripts/verify-wxml-language-service.mjs
node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke
```

All four must exit 0. The graph + language service now sees the new page; no behavior changes expected.

- [ ] **Step 7: Commit**

```bash
git add fixtures/miniprogram/pages/loops/ fixtures/miniprogram/app.json fixtures/wasm-spike/miniprogram-symbols-baseline.json
git commit -m "test: add pages/loops/ fixture with multiple wx:for shapes

Real-loop fixtures for upcoming wx:for-scope-graph tests: default
wx:for, explicit wx:for-item/wx:for-index, nested shadowing, iterable
name collision, and an outside-loop reference. Page script declares
data: { item: ... } so priority tests can verify wx:for shadows data.
Baseline regen is purely additive (existing fixtures unchanged)."
```

---

## Task 2: Extract `wxForScopes` and derive `wxForBindings` from it

**Files:**
- Modify: `shared/wxml-symbol-extractor.mjs` (around lines 142-144, 224-231, 340-343)
- Create: `fixtures/wasm-spike/wx-for-empty-attr.wxml`
- Create: `fixtures/wasm-spike/wx-for-loose-attr.wxml`
- Modify: `scripts/verify-wxml-narrow-ranges.mjs` (add S-F1 through S-F7 and W-7)
- Regenerate: all 7 baselines in `fixtures/wasm-spike/` (add `wxForScopes` field; `wxForBindings` byte-equal)

**Background:** Per the spec, the extractor now produces a per-element `wxForScopes[]` (only for elements that actually have `wx:for`). It also keeps two internal "loose names" accumulators to preserve the legacy quirk where `wx:for-item` without `wx:for` still contributes to `wxForBindings.items`. `wxForBindings` is emitted as the union of explicit-from-scopes plus loose names — byte-equal to pre-change output on every fixture (locked by W-7).

- [ ] **Step 1: Snapshot pre-change `wxForBindings` for every miniprogram baseline**

This is the W-7 reference data. Read each baseline and capture the exact `wxForBindings` shape per fileModel for inlining in the verifier.

```bash
for f in fixtures/wasm-spike/*-symbols-baseline.json; do
  echo "===== $f ====="
  node -e "
    const data = JSON.parse(require('fs').readFileSync('$f', 'utf8'));
    for (const file of (data.files || data)) {
      console.log(JSON.stringify({ path: file.path, wxForBindings: file.wxForBindings }));
    }
  "
done
```

Save the output. Each line is a `{ path, wxForBindings }` literal that will be inlined as a frozen snapshot in the W-7 test (Step 8 below). The baselines that contain `pages/loops/loops.wxml` (added in Task 1) will already include its current-shape `wxForBindings` — capture that too.

- [ ] **Step 2: Create standalone fixtures for S-F4, S-F5, S-F6, S-F7**

`fixtures/wasm-spike/wx-for-empty-attr.wxml`:

```wxml
<view wx:for="{{xs}}" wx:for-item="" wx:for-index="">
  {{item}}{{index}}
</view>
```

`fixtures/wasm-spike/wx-for-loose-attr.wxml`:

```wxml
<view wx:for-item="loose" wx:for-index="loose_idx">
  {{loose}}
</view>
```

`fixtures/wasm-spike/wx-for-bare.wxml`:

```wxml
<view wx:for>
  {{item}}
</view>
```

(`wx:for` with no value — legacy extractor sets `hasAnyWxFor: true` for this even though the loop has no iterable; new schema must preserve via a scope record with defaults.)

`fixtures/wasm-spike/wx-for-interp-item.wxml`:

```wxml
<view wx:for="{{xs}}" wx:for-item="{{dyn}}">
  {{item}}
</view>
```

(`wx:for-item` value is a `{{...}}` interpolation. Legacy `quotedAttrTextValue` returns `null` for any value containing an `interpolation` child, so the new code must use the same helper to read the item/index name — otherwise the literal string `"{{dyn}}"` would leak into the explicit-binding path. S-F7 locks this.)

These are standalone (not registered in `app.json`) — same pattern as the existing `fixtures/wasm-spike/non-ascii.wxml`.

- [ ] **Step 3: Add S-F1 through S-F7 to the verifier**

Edit `scripts/verify-wxml-narrow-ranges.mjs`. Append these test functions before the `CASES` array:

```js
// S-F1: explicit wx:for-item / wx:for-index produce one scope with
// explicit source + narrow nameRange.
function testExplicitScopeShape() {
  const result = extract("fixtures/miniprogram/pages/loops/loops.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(Array.isArray(scopes), `S-F1: wxForScopes must be an array; got ${typeof scopes}`);
  const prodScope = scopes.find((s) => s.itemName === "prod");
  assert(prodScope, `S-F1: expected scope with itemName 'prod'; got ${JSON.stringify(scopes.map((s) => s.itemName))}`);
  assert(prodScope.itemSource === "explicit", `S-F1: itemSource ${prodScope.itemSource}`);
  assert(prodScope.itemNameRange, `S-F1: explicit itemName must carry nameRange`);
  assert(prodScope.indexName === "idx", `S-F1: indexName ${prodScope.indexName}`);
  assert(prodScope.indexSource === "explicit", `S-F1: indexSource ${prodScope.indexSource}`);
  assert(prodScope.indexNameRange, `S-F1: explicit indexName must carry nameRange`);
  assert(prodScope.ownerTag === "view", `S-F1: ownerTag ${prodScope.ownerTag}`);
  assert(prodScope.scopeRange, `S-F1: scopeRange must be present`);
  assert(prodScope.wxForRange, `S-F1: wxForRange must be present`);
}

// S-F2: default wx:for (no wx:for-item / wx:for-index attrs) produces
// implicit-source defaults with null nameRange.
function testImplicitScopeShape() {
  const result = extract("fixtures/miniprogram/pages/loops/loops.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  // The first <view wx:for="{{users}}" wx:key="id"> has no explicit item/index.
  const usersScope = scopes.find((s) => s.itemName === "item" && s.itemSource === "implicit");
  assert(usersScope, `S-F2: expected implicit scope with itemName 'item' (default); got ${JSON.stringify(scopes.map((s) => ({ i: s.itemName, src: s.itemSource })))}`);
  assert(usersScope.itemNameRange === null, `S-F2: implicit itemNameRange must be null`);
  assert(usersScope.indexName === "index", `S-F2: implicit indexName`);
  assert(usersScope.indexSource === "implicit", `S-F2: implicit indexSource`);
  assert(usersScope.indexNameRange === null, `S-F2: implicit indexNameRange must be null`);
}

// S-F3: nested loops produce two scope entries; the inner scopeRange is
// strictly inside the outer.
function testNestedScopes() {
  const result = extract("fixtures/miniprogram/pages/loops/loops.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  const outer = scopes.find((s) => s.itemName === "outer");
  const inner = scopes.find((s) => s.itemName === "inner");
  assert(outer, `S-F3: outer scope missing`);
  assert(inner, `S-F3: inner scope missing`);
  // Inner is strictly within outer.
  assert(outer.scopeRange.start.row <= inner.scopeRange.start.row, `S-F3: outer must start at or above inner`);
  assert(outer.scopeRange.end.row >= inner.scopeRange.end.row, `S-F3: outer must end at or below inner`);
  const outerArea = (outer.scopeRange.end.row - outer.scopeRange.start.row) * 1000
    + (outer.scopeRange.end.column - outer.scopeRange.start.column);
  const innerArea = (inner.scopeRange.end.row - inner.scopeRange.start.row) * 1000
    + (inner.scopeRange.end.column - inner.scopeRange.start.column);
  assert(innerArea < outerArea, `S-F3: inner scope must be strictly smaller than outer (outer=${outerArea}, inner=${innerArea})`);
}

// S-F4: empty wx:for-item="" / wx:for-index="" → treated as implicit
// per the spec (legacy v.length > 0 gate preserved).
function testEmptyAttrFallsBackToImplicit() {
  const result = extract("fixtures/wasm-spike/wx-for-empty-attr.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(scopes.length === 1, `S-F4: expected exactly one scope; got ${scopes.length}`);
  const s = scopes[0];
  assert(s.itemName === "item" && s.itemSource === "implicit" && s.itemNameRange === null,
    `S-F4: empty wx:for-item should fall back to implicit; got ${JSON.stringify(s)}`);
  assert(s.indexName === "index" && s.indexSource === "implicit" && s.indexNameRange === null,
    `S-F4: empty wx:for-index should fall back to implicit; got ${JSON.stringify(s)}`);
}

// S-F5: loose wx:for-item (no wx:for) produces ZERO wxForScopes entries
// but the derived wxForBindings.items still contains "loose"
// (legacy quirk preserved via internal loose-names accumulator).
function testLooseAttrCompat() {
  const result = extract("fixtures/wasm-spike/wx-for-loose-attr.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(scopes.length === 0, `S-F5: loose wx:for-item without wx:for must NOT create a scope; got ${JSON.stringify(scopes)}`);
  const bindings = file.wxForBindings;
  assert(bindings, `S-F5: expected wxForBindings (compat shim)`);
  assert(bindings.items.includes("loose"), `S-F5: derived wxForBindings.items must include legacy loose name; got ${JSON.stringify(bindings.items)}`);
  assert(bindings.indexes.includes("loose_idx"), `S-F5: derived wxForBindings.indexes must include legacy loose name; got ${JSON.stringify(bindings.indexes)}`);
  assert(bindings.hasAnyWxFor === false, `S-F5: hasAnyWxFor must be false (no real wx:for present); got ${bindings.hasAnyWxFor}`);
}

// S-F6: bare wx:for (no value at all) — legacy hasAnyWxFor === true must
// be preserved. The new schema does this by creating a scope record with
// defaults whenever the wx:for ATTRIBUTE is present, regardless of value.
function testBareWxForCreatesScope() {
  const result = extract("fixtures/wasm-spike/wx-for-bare.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(scopes.length === 1, `S-F6: bare wx:for must create exactly one scope; got ${scopes.length}`);
  const s = scopes[0];
  assert(s.itemName === "item" && s.itemSource === "implicit",
    `S-F6: bare wx:for scope should have implicit defaults; got ${JSON.stringify(s)}`);
  assert(s.indexName === "index" && s.indexSource === "implicit",
    `S-F6: same for index; got ${JSON.stringify(s)}`);
  assert(s.wxForRange, `S-F6: wxForRange must exist (covers the bare wx:for attr)`);
  const bindings = file.wxForBindings;
  assert(bindings.hasAnyWxFor === true,
    `S-F6: derived hasAnyWxFor must be true (legacy parity); got ${bindings.hasAnyWxFor}`);
}

// S-F7: wx:for-item="{{dyn}}" (dynamic interpolation as the binding name).
// The legacy quotedAttrTextValue helper returns null when the quoted value
// contains an `interpolation` child, gating dynamic names OUT of wxForItems.
// The new extractor MUST use the same helper (not attributeRawValue, which
// would unquote to the literal string "{{dyn}}" and leak it as explicit).
function testInterpolatedItemNameFallsBackToImplicit() {
  const result = extract("fixtures/wasm-spike/wx-for-interp-item.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(scopes.length === 1, `S-F7: expected exactly one scope; got ${scopes.length}`);
  const s = scopes[0];
  assert(s.itemName === "item" && s.itemSource === "implicit" && s.itemNameRange === null,
    `S-F7: dynamic wx:for-item="{{dyn}}" must fall back to implicit; got ${JSON.stringify(s)}`);
  const bindings = file.wxForBindings;
  assert(!bindings.items.includes("{{dyn}}"),
    `S-F7: wxForBindings.items must NOT contain the literal "{{dyn}}"; got ${JSON.stringify(bindings.items)}`);
  assert(!bindings.items.includes("dyn"),
    `S-F7: wxForBindings.items must NOT contain "dyn" either; got ${JSON.stringify(bindings.items)}`);
}
```

Append to the `CASES` array (next to the existing S-W / S-C cases):

```js
  ["S-F1: explicit wx:for-item / wx:for-index", testExplicitScopeShape],
  ["S-F2: default wx:for produces implicit scope", testImplicitScopeShape],
  ["S-F3: nested loops produce nested scopes", testNestedScopes],
  ["S-F4: empty explicit attrs fall back to implicit", testEmptyAttrFallsBackToImplicit],
  ["S-F5: loose attrs without wx:for preserve legacy compat", testLooseAttrCompat],
  ["S-F6: bare wx:for preserves legacy hasAnyWxFor", testBareWxForCreatesScope],
  ["S-F7: dynamic wx:for-item interpolation does not leak into items", testInterpolatedItemNameFallsBackToImplicit],
```

- [ ] **Step 4: Run the verifier — confirm most S-F cases fail**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`

Expected: `Result: 7 passed, 5 failed`. The 7 passing are the 5 prior S-W/S-C cases plus **S-F5** (loose-attrs compat — passes under legacy by accident: scopes undefined → `?? []` → empty array satisfies the `scopes.length === 0` assertion; legacy `wxForItems` already contains "loose" via the pre-existing quirk; `hasAnyWxFor` is correctly false) plus **S-F7** (the dynamic-interpolation case — legacy `quotedAttrTextValue` already returns null for `wx:for-item="{{dyn}}"`, so legacy `wxForBindings.items` doesn't contain "{{dyn}}" and the assertion holds; the `scopes.length === 1` part fails... wait — that means S-F7 also fails on the scopes count. So actually: 6 passed, 6 failed).

Reconciled expectation: **`Result: 6 passed, 6 failed`**. The 6 passing are the 5 prior S-W/S-C cases plus **S-F5**. The 6 failing are S-F1/S-F2/S-F3/S-F4/S-F6/S-F7 — all require the new `wxForScopes` field to be populated.

If S-F5 happens to FAIL under legacy on your machine (e.g., a baseline-time accumulator difference), STOP and investigate — that means the legacy quirk wasn't quite where we thought it was, which has implications for the compat-shim derivation.

- [ ] **Step 5: Implement the extractor change**

Edit `shared/wxml-symbol-extractor.mjs`. Find the wx:for handling block around lines 142-144:

```js
  const wxForItems = new Set();
  const wxForIndexes = new Set();
  let hasAnyWxFor = false;
```

Replace with:

```js
  // wxForScopes: real per-element loop scopes (one entry per element with wx:for).
  const wxForScopes = [];
  // Loose accumulators preserve the legacy quirk where wx:for-item /
  // wx:for-index without wx:for still leaks into wxForBindings.items /
  // .indexes. Not surfaced in the public schema; only used to derive the
  // compat shim. Will be removed when wxForBindings itself is retired.
  const wxForLooseItems = new Set();
  const wxForLooseIndexes = new Set();
```

(`hasAnyWxFor` is no longer needed as a separate accumulator — it's derived from `wxForScopes.length > 0` at emit time.)

The element-traversal code needs significant change to build scope records. Find the element branch (search for `node.type === "element"`, around line 294 — the same branch that pushes `components`). Within that branch, BEFORE the component push, scan the element's attributes for `wx:for`. If found, build a scope record. Replace the element branch's body (the `if (tag)` block):

```js
    } else if (node.type === "element") {
      const tag = firstChildOfType(node, "start_tag") ?? firstChildOfType(node, "self_closing_tag");
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

          wxForScopes.push({
            scopeRange: rangeOf(node),
            wxForRange: rangeOf(wxForAttr),
            itemName: itemExplicit ? itemRaw : "item",
            itemNameRange: itemExplicit && itemValueNode ? innerValueRange(itemValueNode) : null,
            itemSource: itemExplicit ? "explicit" : "implicit",
            indexName: indexExplicit ? indexRaw : "index",
            indexNameRange: indexExplicit && indexValueNode ? innerValueRange(indexValueNode) : null,
            indexSource: indexExplicit ? "explicit" : "implicit",
            ownerTag: name ?? null,
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
```

Now find the existing attribute-level wx:for handling around lines 224-231 (in the `if (node.type === "attribute")` block):

```js
        if (attrName === "wx:for") {
          hasAnyWxFor = true;
        } else if (attrName === "wx:for-item") {
          const v = quotedAttrTextValue(node);
          if (typeof v === "string" && v.length > 0) wxForItems.add(v);
        } else if (attrName === "wx:for-index") {
          const v = quotedAttrTextValue(node);
          if (typeof v === "string" && v.length > 0) wxForIndexes.add(v);
        }
```

Delete this block entirely — the new element-level scope extraction subsumes it (the loose-attr fallback above handles the legacy quirk).

Find the emit site around lines 340-343:

```js
    wxForBindings: {
      items: [...wxForItems].sort(),
      indexes: [...wxForIndexes].sort(),
      hasAnyWxFor,
```

Replace with the derived shim:

```js
    wxForScopes,
    /** @deprecated compatibility shim derived from wxForScopes plus loose-attr accumulators;
     * new code should consume wxForScopes directly. */
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
```

(Replace the `hasAnyWxFor` line and the closing `}` of the old object literal accordingly — match the surrounding emit-object syntax.)

- [ ] **Step 6: Run the S-F verifier — confirm cases now pass**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`

Expected: `Result: 12 passed, 0 failed` (5 prior S-W/S-C + 7 new S-F). W-7 is added in Step 8 below; not in this count yet.

If any S-F fails, STOP and debug:
- S-F1 explicit shape mismatch → check `attributeRawValue` returns unwrapped value, not quoted.
- S-F3 nested ordering → confirm extraction is depth-first.
- S-F4 → confirm `length > 0` gate is mirrored on BOTH the value-presence check AND on whether to mark explicit/implicit.
- S-F5 → confirm the loose accumulators are populated only in the `else` branch (no wx:for attr present).
- S-F6 → confirm scope creation is NOT gated on `wxForValueNode` (bare `wx:for` has no value but must still create a scope to preserve legacy `hasAnyWxFor: true`).
- S-F7 → confirm item/index name reads use `quotedAttrTextValue` (returns null on interpolation children), NOT `attributeRawValue` (which would leak `"{{dyn}}"` as a literal explicit name).

- [ ] **Step 7: Regenerate all 7 baselines**

```bash
node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > fixtures/wasm-spike/home-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs $(find fixtures/miniprogram -name "*.wxml" | sort) > fixtures/wasm-spike/miniprogram-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/test.wxml > fixtures/wasm-spike/test-wxml-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/real-world/component.wxml fixtures/real-world/page.wxml fixtures/real-world/templates.wxml > fixtures/wasm-spike/real-world-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/real-world/edge-recovery.wxml > fixtures/wasm-spike/edge-recovery-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/non-ascii.wxml > fixtures/wasm-spike/non-ascii-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/wx-for-unquoted.wxml > fixtures/wasm-spike/wx-for-unquoted-symbols-baseline.json
```

Inspect `git diff fixtures/wasm-spike/`:
1. Every changed baseline has a new `wxForScopes` array on at least some fileModels.
2. Every existing `wxForBindings` value is byte-identical to the pre-Task-2 shape (this is what W-7 will lock).
3. No deletions of other fields, no other field changes.

If any pre-existing `wxForBindings` value changed, STOP — the derivation logic has a bug. Check that the loose accumulator order matches the legacy emit order (sorted + deduped).

- [ ] **Step 8: Add W-7 frozen-snapshot invariant test**

Append to `scripts/verify-wxml-narrow-ranges.mjs`:

```js
// W-7: derived wxForBindings must byte-equal the pre-change snapshot
// for every file in every baseline. The snapshot is the literal
// wxForBindings that the legacy extractor produced before this change.
// Captured in Step 1 above; inlined here as a closed reference set.
const W7_FROZEN_WX_FOR_BINDINGS = {
  // Format: "<baseline-file>::<file-path>": <wxForBindings literal>
  // PASTE the output from Step 1 here. Example shape:
  // "miniprogram-symbols-baseline.json::fixtures/miniprogram/pages/home/home.wxml": {
  //   items: [], indexes: [], hasAnyWxFor: true,
  // },
  // ...
};

function testCompatShimByteEqual() {
  const baselineDir = path.join(ROOT, "fixtures/wasm-spike");
  const files = fs.readdirSync(baselineDir).filter((f) => f.endsWith("-symbols-baseline.json"));
  const actualKeys = new Set();
  for (const baselineName of files) {
    const baselinePath = path.join(baselineDir, baselineName);
    const data = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const fileModels = Array.isArray(data) ? data : data.files;
    for (const fileModel of fileModels) {
      const key = `${baselineName}::${fileModel.path}`;
      actualKeys.add(key);
      const expected = W7_FROZEN_WX_FOR_BINDINGS[key];
      // Strict: every fileModel across every baseline MUST have a frozen
      // snapshot. A missing key means the implementer didn't paste in
      // all literals from Step 1, which would let regressions slip through.
      assert(
        expected !== undefined,
        `W-7: missing frozen snapshot for ${key}. Paste the literal from Step 1's command output into W7_FROZEN_WX_FOR_BINDINGS.`,
      );
      const actual = fileModel.wxForBindings;
      assert(
        JSON.stringify(actual) === JSON.stringify(expected),
        `W-7: wxForBindings byte-equal failed for ${key}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`,
      );
    }
  }
  // Strict the other direction too: no frozen key may name a file that
  // doesn't exist in any baseline (catches stale snapshots after a
  // fixture rename or removal).
  for (const key of Object.keys(W7_FROZEN_WX_FOR_BINDINGS)) {
    assert(
      actualKeys.has(key),
      `W-7: stale snapshot for ${key} — no matching fileModel found. Remove from W7_FROZEN_WX_FOR_BINDINGS.`,
    );
  }
}
```

Add `import fs from "node:fs";` at the top of the file if not already imported.

Append to the `CASES` array:

```js
  ["W-7: wxForBindings compat shim is byte-equal across all baselines", testCompatShimByteEqual],
```

Populate `W7_FROZEN_WX_FOR_BINDINGS` with the snapshot literals captured in Step 1. (For brevity in this plan, the actual literal values depend on the current baseline contents — the implementer must paste them in. The Step 1 command output gives the exact JSON.)

- [ ] **Step 9: Run the full verifier**

```bash
node scripts/verify-wxml-narrow-ranges.mjs
node scripts/verify-wasm-symbol-baselines.mjs
node scripts/verify-wxml-language-service.mjs
node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke
```

All must exit 0. Specifically: narrow-ranges should now report 13 passed (5 prior + 7 S-F + W-7).

- [ ] **Step 10: Commit**

```bash
git add shared/wxml-symbol-extractor.mjs fixtures/wasm-spike/ scripts/verify-wxml-narrow-ranges.mjs
git commit -m "feat(extractor): emit per-element wxForScopes; derive wxForBindings as compat shim

Adds wxForScopes[] to fileModel — one entry per element that has a
wx:for attribute, carrying scopeRange (element node range), wxForRange
(the wx:for attribute range for iterable-exclusion), item/index names
+ explicit nameRanges + source markers, and ownerTag.

Legacy wxForBindings is now derived from wxForScopes (explicit names
only) plus internal wxForLooseItems / wxForLooseIndexes accumulators
that preserve the legacy quirk where wx:for-item / wx:for-index
without wx:for still leak into items[] / indexes[]. The shim is
marked @deprecated; W-7 invariant locks byte-equal across all
existing fixtures.

graph.version unchanged (additive). Baselines regenerated."
```

---

## Task 3: Hover step 2a scaffold + simple cases (W-1, W-5, W-6)

**Files:**
- Modify: `server/wxml-hover.mjs` (add kind labels, helpers, step 2a)
- Modify: `scripts/verify-wxml-language-service.mjs` (add W-1, W-5, W-6)

**Background:** Insert the wx:for binding lookup as step 2a at the TOP of the expression-ref AUTHORITATIVE branch. The algorithm scans `wxForScopes` reverse extraction order (innermost-first), filters to active scopes (cursor in scopeRange AND NOT in wxForRange), and returns the first scope whose itemName/indexName matches the cursor's identifier. Hover content: two-line markdown with `wx:for-item` / `wx:for-index` kind label and "Declared on `<view>` at line N" source line.

- [ ] **Step 1: Add failing tests W-1, W-5, W-6**

Edit `scripts/verify-wxml-language-service.mjs`. Add a constant near other path constants at the top of the file (under existing `LOOPS_*` constants if any; otherwise insert):

```js
const LOOPS_WXML = path.join(MINIPROGRAM_ROOT, "pages/loops/loops.wxml");
const LOOPS_WXML_GRAPH_PATH = "fixtures/miniprogram/pages/loops/loops.wxml";
```

Append test functions next to existing hover assertions:

```js
function assertHoverOnWxForDefaultItem(graph) {
  // W-1: loops.wxml line 3 has `<view class="row" wx:for="{{users}}" wx:key="id">`
  // and line 4 has `{{item.name}} ({{index}})`. Cursor on `item` in {{item.name}}.
  // Find the exact column at runtime to avoid brittleness.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("{{item.name}}"));
  assert(lineIdx >= 0, "W-1 setup: expected line with `{{item.name}}` in loops.wxml");
  const charIdx = lines[lineIdx].indexOf("item");

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },  // mid-name
    extensionRoot: ROOT,
  });
  assert(hover, "W-1: expected Hover for default wx:for item, got null");
  const value = hoverContents(hover);
  assert(value.startsWith("**item** — `wx:for-item`"), `W-1: bad title: ${value}`);
  assert(value.includes("Declared on `<view>` at line "), `W-1: bad source line: ${value}`);
}

function assertHoverOnReferenceOutsideLoopReturnsNull(graph) {
  // W-5: loops.wxml has `<view class="outside-loop">{{item}}</view>` at the
  // bottom — outside every wx:for body. Hover on `item` must NOT resolve
  // to a wx:for binding. (It WILL resolve to data.item via 2b dataKey,
  // because loops.js declares data.item. That's correct — W-5 specifically
  // checks the wx:for step DOESN'T fire here. We assert by checking the
  // kind label is `data`, not `wx:for-item`.)
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("outside-loop") && l.includes("{{item}}"));
  assert(lineIdx >= 0, "W-5 setup: expected line with outside-loop {{item}}");
  const charIdx = lines[lineIdx].indexOf("{{item}}") + 2;  // inside the {{

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-5: expected Hover for outside-loop {{item}} (resolves to data); got null");
  const value = hoverContents(hover);
  assert(!value.includes("wx:for-item"), `W-5: outside-loop hover MUST NOT be wx:for-item; got ${value}`);
  assert(value.includes("`data`"), `W-5: expected data kind label; got ${value}`);
}

function assertHoverOnWxForMemberChainReturnsNull(graph) {
  // W-6: cursor on `.name` part of {{item.name}} — member chain, not
  // top-level identifier, so no expressionRef is produced. Hover null.
  // (Mirrors existing H-11 logic.)
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("{{item.name}}"));
  assert(lineIdx >= 0, "W-6 setup: line with {{item.name}}");
  const charIdx = lines[lineIdx].indexOf("{{item.name}}") + "{{item.".length;  // on `n` of name

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover === null, `W-6: expected null on member chain, got ${JSON.stringify(hover)}`);
}
```

Append to the flat runner block at the bottom:

```js
// Phase 3 Stage D — wx:for scope hover
assertHoverOnWxForDefaultItem(graph);
assertHoverOnReferenceOutsideLoopReturnsNull(graph);
assertHoverOnWxForMemberChainReturnsNull(graph);
```

- [ ] **Step 2: Run — confirm W-1/W-5 fail**

Run: `node scripts/verify-wxml-language-service.mjs`

Expected: W-1 FAILS with "expected Hover for default wx:for item, got null" (step 2a not implemented; falls through to 2b/2c/2d which all miss for default-name `item`). W-5 may PASS or FAIL depending on whether `data.item` is in scope (loops.js declares it, so dataKey resolves → W-5 passes). W-6 should PASS (member chain).

- [ ] **Step 3: Implement step 2a in `server/wxml-hover.mjs`**

Add to `HOVER_KIND_LABELS`:

```js
const HOVER_KIND_LABELS = {
  data: "data",
  setData: "setData",
  injector: "injector",
  property: "property",
  pageMethod: "page method",
  componentMethod: "component method",
  customComponent: "custom component",
  wxsModule: "wxs module",
  wxForItem: "wx:for-item",        // NEW
  wxForIndex: "wx:for-index",      // NEW
};
```

Add two new helpers BEFORE `getHover`:

```js
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
function findMatchingWxForBinding(scopes, position, name) {
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
 * Render a wx:for binding hover. Same-file always — wx:for declarations
 * never cross-file by scope semantics. Source line shape:
 *   ownerTag present + explicit name → `Declared on `<tag>` at line N`
 *   ownerTag null    + explicit name → `Declared in wx:for at line N`
 *   ownerTag present + implicit name → `Declared on `<tag>` at line N` (line from wxForRange)
 *   ownerTag null    + implicit name → `Declared in wx:for at line N`
 */
function makeWxForHover(scope, kind, refRange) {
  const isItem = kind === "item";
  const name = isItem ? scope.itemName : scope.indexName;
  const kindLabel = isItem ? HOVER_KIND_LABELS.wxForItem : HOVER_KIND_LABELS.wxForIndex;
  const explicitNameRange = isItem ? scope.itemNameRange : scope.indexNameRange;
  const lineRange = explicitNameRange ?? scope.wxForRange;
  const lineNo = lineRange.start.row + 1;
  const sourceLine = scope.ownerTag
    ? `Declared on \`<${scope.ownerTag}>\` at line ${lineNo}`
    : `Declared in wx:for at line ${lineNo}`;
  return {
    contents: {
      kind: "markdown",
      value: `**${name}** — \`${kindLabel}\`\n\n${sourceLine}`,
    },
    range: rangeFromSymbolRange(refRange),
  };
}
```

Insert step 2a at the TOP of the expression-ref AUTHORITATIVE branch in `getHover`. Find the existing `if (expressionRefMatch)` block (around line 130 in `wxml-hover.mjs`). Immediately after `if (expressionRefMatch.inTemplateDefinition) return null;`, insert:

```js
    // 2a. wx:for binding lookup — opportunistic, no ownerConfig needed.
    // Per WXML lexical scope semantics, wx:for-item / wx:for-index shadow
    // data / property / wxs of the same name inside the loop body.
    const wxForBinding = findMatchingWxForBinding(
      fileModel.wxForScopes,
      position,
      expressionRefMatch.name,
    );
    if (wxForBinding) {
      return makeWxForHover(wxForBinding.scope, wxForBinding.kind, expressionRefMatch.range);
    }
```

The existing dataKeys/propertyKeys/wxs blocks should follow unchanged (they become 2b, 2c, 2d in spirit but the code labels are arbitrary — the comments already say so).

- [ ] **Step 4: Run — confirm W-1, W-5, W-6 all pass**

Run: `node scripts/verify-wxml-language-service.mjs`

Expected: exit 0. W-1 now finds the default `item` via 2a. W-5 still resolves to dataKey (outside any loop, so 2a misses, 2b finds `data.item`). W-6 still null (no expressionRef for member-chain).

- [ ] **Step 5: Commit**

```bash
git add server/wxml-hover.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat(hover): step 2a — wx:for binding lookup with reverse-extraction scan

Adds findMatchingWxForBinding (innermost-first scan of wxForScopes with
wxForRange exclusion) and makeWxForHover (two-line markdown with
wx:for-item / wx:for-index kind labels). Step 2a sits at the top of
getHover's expression-ref AUTHORITATIVE branch so loop variables shadow
data / property / wxs per lexical scope semantics.

Covers W-1 (default wx:for item hover), W-5 (outside-loop falls through
to dataKey correctly), W-6 (member chain returns null)."
```

---

## Task 4: Explicit names + nested shadowing + iterable exclusion (W-2, W-3, W-4, W-9)

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs` (add W-2, W-3, W-4, W-9)

**Background:** These tests exercise the harder corners of step 2a using the loops fixture: explicit `wx:for-item="prod"`, explicit `wx:for-index="idx"`, nested loops with name-collision shadowing, and the iterable-exclusion rule.

- [ ] **Step 1: Add W-2, W-3, W-4, W-9**

Append to `scripts/verify-wxml-language-service.mjs`:

```js
function assertHoverOnExplicitWxForItem(graph) {
  // W-2: <view wx:for="{{products}}" wx:for-item="prod" ...>{{prod.title}}</view>
  // Cursor on `prod` in {{prod.title}}.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("{{prod.title}}"));
  assert(lineIdx >= 0, "W-2 setup: line with {{prod.title}}");
  const charIdx = lines[lineIdx].indexOf("{{prod.title}}") + 2;  // on `p` of prod

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-2: expected Hover for explicit wx:for-item 'prod'");
  const value = hoverContents(hover);
  assert(value.startsWith("**prod** — `wx:for-item`"), `W-2: bad title: ${value}`);
}

function assertHoverOnExplicitWxForIndex(graph) {
  // W-3: same line — cursor on `idx` in #{{idx}}.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("#{{idx}}"));
  assert(lineIdx >= 0, "W-3 setup: line with #{{idx}}");
  const charIdx = lines[lineIdx].indexOf("#{{idx}}") + 3;  // on `i` of idx

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-3: expected Hover for explicit wx:for-index 'idx'");
  const value = hoverContents(hover);
  assert(value.startsWith("**idx** — `wx:for-index`"), `W-3: bad title: ${value}`);
}

function assertHoverNestedShadowing(graph) {
  // W-4: nested loops. The fixture has:
  //   <view wx:for="{{groups}}" wx:for-item="outer">
  //     <view wx:for="{{outer.entries}}" wx:for-item="inner">
  //       {{outer.label}} :: {{inner.value}}
  //     </view>
  //   </view>
  // Inside the inner subtree, hover `outer` → outer scope (inner only
  // shadows `inner`); hover `inner` → inner scope.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("{{outer.label}} :: {{inner.value}}"));
  assert(lineIdx >= 0, "W-4 setup: line with `{{outer.label}} :: {{inner.value}}`");
  const text = lines[lineIdx];

  // Cursor on `outer` in {{outer.label}} (inside inner subtree).
  const outerChar = text.indexOf("{{outer.label}}") + 2;
  const hoverOuter = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: outerChar + 1 },
    extensionRoot: ROOT,
  });
  assert(hoverOuter, "W-4: expected Hover for `outer` inside inner subtree");
  const outerValue = hoverContents(hoverOuter);
  assert(outerValue.startsWith("**outer** — `wx:for-item`"),
    `W-4: outer hover should be wx:for-item; got ${outerValue}`);

  // Cursor on `inner` in {{inner.value}} (inside inner subtree).
  const innerChar = text.indexOf("{{inner.value}}") + 2;
  const hoverInner = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: innerChar + 1 },
    extensionRoot: ROOT,
  });
  assert(hoverInner, "W-4: expected Hover for `inner`");
  const innerValue = hoverContents(hoverInner);
  assert(innerValue.startsWith("**inner** — `wx:for-item`"),
    `W-4: inner hover should be wx:for-item; got ${innerValue}`);
}

function assertHoverIterableExclusion(graph) {
  // W-9: <view wx:for="{{item}}" wx:for-item="item" ...>
  // The fixture has this exact pattern. Cursor on `item` INSIDE the
  // wx:for="{{item}}" attribute value MUST resolve to outer scope
  // (data.item from loops.js), NOT to this loop's own itemName.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  // Skip the comment line in the fixture (the `<!-- Iterable name
  // collision: ... -->` comment quotes both substrings verbatim, so a
  // naive `includes` predicate matches it before the real element).
  const lineIdx = lines.findIndex((l) =>
    l.includes(`wx:for="{{item}}"`)
    && l.includes(`wx:for-item="item"`)
    && !l.trimStart().startsWith("<!--"));
  assert(lineIdx >= 0, "W-9 setup: line with `wx:for=\"{{item}}\" wx:for-item=\"item\"`");
  const charIdx = lines[lineIdx].indexOf(`wx:for="{{item}}"`) + `wx:for="{{`.length;  // on `i` of `item` inside {{

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-9: expected Hover for iterable-side `item` (resolves to data)");
  const value = hoverContents(hover);
  assert(!value.includes("wx:for-item"),
    `W-9: iterable-side hover MUST NOT bind to the loop's own wx:for-item; got ${value}`);
  assert(value.includes("`data`"),
    `W-9: expected data kind label (loops.js declares data.item); got ${value}`);
}
```

Append to the flat runner block:

```js
assertHoverOnExplicitWxForItem(graph);
assertHoverOnExplicitWxForIndex(graph);
assertHoverNestedShadowing(graph);
assertHoverIterableExclusion(graph);
```

- [ ] **Step 2: Run — confirm all 4 pass**

Run: `node scripts/verify-wxml-language-service.mjs`

Expected: exit 0. If W-4 fails on the outer-name lookup, the algorithm is wrong (likely returning early on innermost-only). If W-9 fails by binding to the loop's own item, the wxForRange exclusion is missing or wrong.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-wxml-language-service.mjs
git commit -m "test(hover): wx:for explicit names + nested shadowing + iterable exclusion

W-2 explicit wx:for-item='prod', W-3 explicit wx:for-index='idx',
W-4 nested loops (outer-name hover inside inner subtree resolves to
outer scope; inner-name hovers to inner), W-9 iterable exclusion
(cursor inside wx:for=\"{{item}}\" must not bind to the loop's own
wx:for-item='item', falls through to outer data)."
```

---

## Task 5: Priority tests — wx:for shadows data (W-8, W-10)

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs` (add W-8, W-10)

**Background:** loops.js declares `data: { item: ... }`. W-8 asserts that inside any wx:for body, hovering a name that's ALSO in data resolves to wx:for-item (lexical shadowing); the symmetric outside-loop case is already covered by W-5. W-10 is the explicit positive arm of the same property to make the contract unambiguous.

- [ ] **Step 1: Add W-8 and W-10**

Append to `scripts/verify-wxml-language-service.mjs`:

```js
function assertHoverWxForShadowsData(graph) {
  // W-8: loops.js has data.item. The fourth loop in loops.wxml is
  // <view wx:for="{{item}}" wx:for-item="item">{{item.label}}</view>.
  // Cursor on `item` inside {{item.label}} (loop body) MUST resolve to
  // wx:for-item, NOT data.item.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("{{item.label}}"));
  assert(lineIdx >= 0, "W-8 setup: line with {{item.label}} (collision-loop body)");
  const charIdx = lines[lineIdx].indexOf("{{item.label}}") + 2;  // on `i` of item

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-8: expected Hover for item inside collision loop body");
  const value = hoverContents(hover);
  assert(value.startsWith("**item** — `wx:for-item`"),
    `W-8: loop body hover MUST be wx:for-item (shadows data.item); got ${value}`);
}

function assertHoverDataOutsideLoopBody(graph) {
  // W-10: explicit positive arm — outside the collision loop body,
  // {{item}} resolves to data.item. (Already covered by W-5; kept
  // separately to lock the contract symmetrically with W-8.)
  // Reuses W-5's outside-loop position; the assertion is identical.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("outside-loop") && l.includes("{{item}}"));
  assert(lineIdx >= 0, "W-10 setup: line with outside-loop {{item}}");
  const charIdx = lines[lineIdx].indexOf("{{item}}") + 2;

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-10: expected Hover");
  const value = hoverContents(hover);
  assert(value.includes("`data`"),
    `W-10: outside-loop hover MUST be data, not wx:for-item; got ${value}`);
}
```

Append to the flat runner block:

```js
assertHoverWxForShadowsData(graph);
assertHoverDataOutsideLoopBody(graph);
```

- [ ] **Step 2: Run — confirm both pass**

Run: `node scripts/verify-wxml-language-service.mjs`

Expected: exit 0. If W-8 returns `data` instead of `wx:for-item`, the priority order is wrong (step 2a is being applied AFTER step 2b instead of before).

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-wxml-language-service.mjs
git commit -m "test(hover): wx:for shadows data of the same name (W-8, W-10)

W-8 asserts that inside the collision loop body, hover on `item`
resolves to wx:for-item (not data.item from loops.js) — confirms
step 2a runs before step 2b dataKeys. W-10 is the symmetric outside-
loop arm: same name, no loop in scope, hover resolves to data."
```

---

## Task 6: LSP host wire test (L-W1)

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs` (add L-W1, register in `graph-smoke`)

**Background:** Mirror the existing L-H1/L-H2/L-H3/L-H4 host-level scenarios. L-W1 confirms a real `textDocument/hover` request on a wx:for binding returns the expected markdown payload through the LSP wire.

- [ ] **Step 1: Add L-W1 scenario**

Edit `scripts/verify-lsp-diagnostics.mjs`. Near the existing hover scenarios, add a constant and a function:

```js
const LOOPS_WXML = path.join(MINIPROGRAM_ROOT, "pages/loops/loops.wxml");

async function testHoverWxForBinding() {
  // L-W1: open loops.wxml, hover the default-loop `item` in {{item.name}},
  // assert the wire-level markdown payload.
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(LOOPS_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 0, "loops diagnostics before hover wx:for");
    // loops.wxml line 4 (row 3): `    {{item.name}} ({{index}})` — cursor on `item`.
    // We hardcode the position; if the fixture changes, this test will fail loudly.
    const result = await client.hover(LOOPS_WXML, { line: 3, character: 7 });
    assert(result, "L-W1: expected Hover, got null");
    assert(
      result.contents?.kind === "markdown",
      `L-W1: expected markdown contents, got ${JSON.stringify(result.contents)}`,
    );
    const value = result.contents?.value;
    assert(
      typeof value === "string" && value.startsWith("**item** — `wx:for-item`"),
      `L-W1: bad title ${JSON.stringify(value)}`,
    );
    assert(
      typeof value === "string" && value.includes("Declared on `<view>` at line "),
      `L-W1: bad source line ${JSON.stringify(value)}`,
    );
  });
}
```

Register in the `scenarios` array (next to the other hover entries):

```js
  ["hover wx:for binding", testHoverWxForBinding],
```

Add to `SCENARIO_SUITES["graph-smoke"]`:

```js
    "hover wx:for binding",
```

- [ ] **Step 2: Run — confirm pass**

```bash
node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke
```

Expected: 19 prior + 1 new = 20 scenarios pass.

If L-W1 hardcoded position is wrong (line 3 char 7 may need adjustment depending on indentation in loops.wxml), correct the position to land mid-`item` in the actual fixture.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-lsp-diagnostics.mjs
git commit -m "test(lsp): L-W1 host wire test for wx:for binding hover

End-to-end textDocument/hover on loops.wxml's default-loop {{item.name}}
asserts the markdown payload starts with **item** — \`wx:for-item\`
and contains the \`Declared on <view> at line N\` source line. Locks
the wire-level serialization for the wx:for step 2a addition."
```

---

## Task 7: Chelaile dogfood + spike-notes entry

**Files:** none in this repo — manual + docs update.

**Background:** Mirrors Hover v1's Task 9. Programmatic LSP dogfood against the chelaile mini-program to confirm wx:for-item / wx:for-index hover renders correctly on real production WXML; record outcomes in spike notes.

- [ ] **Step 1: Programmatic chelaile dogfood**

Use the same `withClient({ rootPath: "/Users/zs/Desktop/zs_work/mp-wx-chelaile/wx" }, ...)` pattern from Hover v1's Task 9. Identify in chelaile:

- A page WXML with a default `<view wx:for="{{xs}}">` and a `{{item.X}}` reference. Hover on `item` should render `**item** — \`wx:for-item\`` + `Declared on \`<view>\` at line N`.
- A page WXML with explicit `wx:for-item="X"` and `{{X.Y}}`. Hover on `X` should render explicit name.
- A page WXML with a `{{wx:for-item-name}}` reference OUTSIDE any `wx:for`. Hover should NOT show wx:for-item (resolves to data, property, wxs, or nothing — exact kind depends on the file).

Use grep to locate positions; use a throwaway script in `$TMPDIR`. Do NOT commit anything to the chelaile workspace.

If the chelaile project has no clear nested-loop case, that's fine — record as "not observed in chelaile."

- [ ] **Step 2: Capture findings**

Tabulate:

| Kind | Position | Expected | Actual |
|---|---|---|---|
| default wx:for-item | `<file>:<line>:<col>` | `**item** — \`wx:for-item\`` + source line | `<paste actual title line>` |
| default wx:for-index | ... | ... | ... |
| explicit wx:for-item | ... | ... | ... |
| outside-loop reference (regression) | ... | must NOT be wx:for-item | ... |

- [ ] **Step 3: Append to `docs/wasm-parser-spike-notes.md`**

Add a new dated subsection following the existing convention (read the tail of the file to match style):

```markdown
### 2026-05-25 — wx:for scope graph hover dogfood (chelaile)

- Default wx:for-item / -index render correctly on sampled pages.
- Explicit wx:for-item names render correctly.
- Outside-loop references correctly NOT shown as wx:for-item.
- Nested loops (if observed): inner-name shadows correctly; outer-name still addressable.
- No regressions observed in adjacent hover features (data, property, setData, injector, page method, component method, custom component, wxs module).
```

(Replace bullets with actual findings; if any kind didn't pass, write the actual failure.)

- [ ] **Step 4: Commit spike-notes entry**

```bash
git add docs/wasm-parser-spike-notes.md
git commit -m "docs: record wx:for scope graph hover dogfood outcome"
```

---

## Verification Summary

After all 7 tasks, the following must pass:

- `node scripts/verify-wxml-narrow-ranges.mjs` — 5 prior + 7 S-F + W-7 = 13 cases.
- `node scripts/verify-wasm-symbol-baselines.mjs` — 7 baselines green.
- `node scripts/verify-wxml-language-service.mjs` — pre-existing + W-1, W-2, W-3, W-4, W-5, W-6, W-8, W-9, W-10 = 9 new hover scenarios (W-7 lives in narrow-ranges).
- `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke` — 19 prior + L-W1 = 20 scenarios.

Manual:
- Chelaile dogfood confirms hover renders for default and explicit wx:for-item/index; outside-loop references not mislabeled; no adjacent-feature regressions.

`graph.version` unchanged (still `1`). `wxForBindings` byte-equal across every fixture (W-7 invariant).
