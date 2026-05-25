# WXML wx:for Per-Element Scope Graph (Phase 1: Hover Only) Design

## Goal

Add a per-element scope graph for `wx:for` declarations to `fileModel`, and use it from `getHover` to resolve cursor-on-`{{item}}` / cursor-on-`{{index}}` correctly per WXML's lexical scope semantics. This is **infrastructure** work first, **hover** consumer second — three other consumers (completion, diagnostics, definition) remain on the current file-level shim and migrate in separate, dogfood-gated phases.

## Non-Goals

- Do not change `getCompletions` behavior. It continues to suggest wx:for binding names file-wide.
- Do not change `getDiagnostics` behavior. It continues to accept any wx:for binding name anywhere in the file as "in scope" for `missing-expression-ref`.
- Do not add `getDefinition` jump from `{{item}}` to `<view wx:for-item="item">`. Deferred to a later phase.
- Do not implement declaration-side hover (cursor on the `item` inside `wx:for-item="item"` attribute value). Deferred to v1.5.
- Do not change WXML grammar / query files.
- Do not bump `graph.version` — the addition is additive.

## Current Baseline

`shared/wxml-symbol-extractor.mjs:142-144, 224-231, 340-343` extracts file-level `wxForBindings`:

```js
wxForBindings: {
  items: [...wxForItems].sort(),        // explicit wx:for-item names only
  indexes: [...wxForIndexes].sort(),    // explicit wx:for-index names only
  hasAnyWxFor: boolean,                  // default item/index fallback signal
}
```

Consumers:

- `server/wxml-language-service.mjs:687-694` (completion): suggests every name in `items` / `indexes` plus `item` / `index` defaults when `hasAnyWxFor` is true.
- `server/wxml-language-service.mjs:878-885` (diagnostics): adds the same names to the file-level scope set used to suppress `missing-expression-ref`.

Hover and definition have no wx:for integration; the `Hover v1` spec (`2026-05-23`) deferred this case because the graph lacked per-element scope.

## Data Schema

### New field: `wxForScopes[]`

For every `wx:for` element in the file, the extractor emits one entry:

```js
{
  scopeRange: { start, end },     // element node range — the subtree the binding applies to
  wxForRange: { start, end },     // the wx:for attribute's range — used to exclude its own iterable

  itemName: string,               // "item" if implicit, otherwise the explicit non-empty wx:for-item value
  itemNameRange: Range | null,    // narrow range of the wx:for-item attr value; null when implicit
  itemSource: "explicit" | "implicit",

  indexName: string,              // "index" if implicit, otherwise the explicit non-empty wx:for-index value
  indexNameRange: Range | null,
  indexSource: "explicit" | "implicit",

  ownerTag: string | null,        // tag name (e.g. "view"); null tolerated on grammar error-recovery
}
```

**Schema invariants**:

- A `wxForScopes` entry is created **only when the `wx:for` attribute is extractable on the element**. If `wx:for` is missing (e.g., `<view wx:for-item="x">` without `wx:for` — malformed WXML but tolerated by the legacy extractor), no scope record is created. `wxForRange` is therefore **mandatory** and the algorithm assumes it exists.
- `scopeRange` is always the element node range; `wxForRange` is always the `wx:for` attribute node range. Both are required.

**Implicit vs explicit rules for `itemName` / `indexName`** (must match legacy extractor's semantics for the compat shim to hold):

- `wx:for-item` attribute is **missing** → `itemName: "item"`, `itemNameRange: null`, `itemSource: "implicit"`.
- `wx:for-item` is **present with `value.length > 0`** → `itemName: value`, `itemNameRange: <narrow range of value>`, `itemSource: "explicit"`. This includes whitespace-only values like `"   "` (treated as a literal explicit name; the legacy `quotedAttrTextValue` does not trim and the gate is strictly `length > 0`, see `shared/wxml-symbol-extractor.mjs:226-228`). This is preserved verbatim — even though it is nonsensical WXML, intentional behavior change here would break W-7 byte-equal.
- `wx:for-item` is **present with empty value** `""` → treated identically to missing: `itemName: "item"`, `itemNameRange: null`, `itemSource: "implicit"`.
- Same three rules for `wx:for-index` / `indexName`.

**Legacy quirk: loose `wx:for-item` / `wx:for-index` without `wx:for`**:

The legacy extractor (`shared/wxml-symbol-extractor.mjs:224-231`) populates `wxForItems` / `wxForIndexes` from any `wx:for-item` / `wx:for-index` attribute it encounters, regardless of whether the same element has `wx:for`. So `<view wx:for-item="x">{{x}}</view>` adds `"x"` to `wxForItems` even though there is no actual loop. This is a real quirk (`hasAnyWxFor` is correctly gated on `wx:for` itself, so completion suppresses the `item`/`index` defaults in this case, but explicit named items leak in regardless).

The new `wxForScopes` schema **does not** create entries for loose attrs (no `wx:for` → no scope). To preserve W-7 byte-equal, the extractor maintains a parallel internal `wxForLooseItems` / `wxForLooseIndexes` accumulator used only for the compat shim derivation (see next section). These loose names are NOT surfaced in the public schema and will be dropped when the legacy `wxForBindings` field is itself retired in a later phase.

**Why a flat array, not a tree.** Nested `wx:for` produces multiple entries with overlapping `scopeRange`s. Consumers select the innermost containing scope by scanning the flat list. A tree representation would force the consumer to walk it anyway, and a flat list is trivially serializable to JSON.

**Why `scopeRange` not `range`.** The codebase uses `range` for token / symbol / dependency ranges. `scopeRange` is semantically distinct (subtree extent) and naming it differently prevents readers from accidentally treating it as a hover-target range.

**Why keep `wxForRange` separately.** It does two jobs:
- **Iterable exclusion**: a cursor inside `wx:for="{{...}}"` evaluates in the *outer* scope; the loop variable this element declares is not yet in scope at that position. Active-scope filtering must exclude the scope when `cursor ∈ scope.wxForRange`.
- **Implicit-default fallback**: for `<view wx:for="{{xs}}">...</view>` with no `wx:for-item` attribute, hover on `item` has no `itemNameRange` to point at. The displayed line falls back to `wxForRange.start.row + 1`.

**Why `ownerTag` is nullable.** Grammar error recovery can produce elements where `tag_name` is missing or malformed. We still want to extract the scope (so descendant interpolations work); the hover-display path drops the `on <tag>` segment when `ownerTag === null`.

### Compatibility shim: `wxForBindings` derived from `wxForScopes` (+ loose names)

The legacy `wxForBindings` field stays in the graph but is now **derived** at emit time from two sources: the new `wxForScopes` array and the internal loose-names accumulators that preserve the legacy `wx:for-item` / `wx:for-index` quirk:

```js
const explicitItemsFromScopes = wxForScopes
  .filter((s) => s.itemSource === "explicit")
  .map((s) => s.itemName);
const explicitIndexesFromScopes = wxForScopes
  .filter((s) => s.indexSource === "explicit")
  .map((s) => s.indexName);

wxForBindings: {
  items:   [...new Set([...explicitItemsFromScopes,   ...wxForLooseItems])].sort(),
  indexes: [...new Set([...explicitIndexesFromScopes, ...wxForLooseIndexes])].sort(),
  hasAnyWxFor: wxForScopes.length > 0,
}
```

**Invariant**: for every existing fixture, the derived `wxForBindings` is byte-equal to the current implementation's output. This is locked by W-7 (see Test Plan). When this invariant holds, completion and diagnostics behavior is provably unchanged.

The legacy field is marked `@deprecated — compatibility shim derived from wxForScopes plus loose-attr accumulators; new code should consume wxForScopes directly` in source. When `wxForBindings` itself is retired in a later phase, the loose-names accumulators go with it.

## Resolver Pipeline

Hover's expression-ref AUTHORITATIVE branch gains a new step **2a** at the top of the lookup chain:

```
2a. wx:for binding lookup (NEW; no ownerConfig needed)
2b. dataKeys           (requires ownerConfig)
2c. propertyKeys       (requires ownerConfig)
2d. in-file wxs symbol (no ownerConfig)
return null            (AUTHORITATIVE terminator)
```

**Why 2a first.** `wx:for-item="item"` declares a local variable. WXML's evaluation matches lexical scope semantics common to JS / Python / etc.: the loop variable shadows enclosing data/property/wxs of the same name. A user hovering `{{item}}` inside the loop body wants the loop binding, not a global data property that happens to share a name.

### Active scope algorithm

For a cursor at `position` and a name to resolve, scan `wxForScopes` in **reverse extraction order** (extractor walks top-down depth-first, so reverse iteration yields innermost-first AND later-source-first for ties), filtering to active scopes (cursor in `scopeRange`, cursor NOT in `wxForRange`), and return the first scope whose `itemName` or `indexName` matches the requested name:

```js
function findMatchingWxForBinding(scopes, position, name) {
  for (let i = (scopes ?? []).length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!containsPosition(scope.scopeRange, position)) continue;
    if (containsPosition(scope.wxForRange, position)) continue;  // iterable-exclusion
    if (name === scope.itemName) return { scope, kind: "item" };
    if (name === scope.indexName) return { scope, kind: "index" };
  }
  return null;
}
```

**Why scan all active scopes, not just the innermost.** A naive "find innermost active scope, then check its names" approach fails the nested-shadowing case where the outer name is requested:

```xml
<view wx:for-item="outer">
  <view wx:for-item="inner">
    {{outer}}    <!-- innermost scope is `inner`; its itemName doesn't match `outer` -->
  </view>
</view>
```

Walking innermost-first AND checking names at each step lets the loop continue past `inner` (no match) and resolve at `outer`. Inner shadows outer only when **names collide**, never when they differ.

**Why reverse extraction order is the right ordering.** The extractor pushes scopes in source-position order during a depth-first walk:
- Outer wx:for element entered first → pushed at index N.
- Inner wx:for element (descendant) entered second → pushed at index N+1.
- Sibling wx:for at outer level (next subtree) → pushed at index N+2.

Reverse iteration gives innermost-first for any cursor position. Ties (two scopes with identical `scopeRange` — rare, only via synthetic tests) resolve to last-extracted = later in source, which is the conventional shadowing-sibling winner.

**wxForRange exclusion**: in `<view wx:for="{{item}}" wx:for-item="item">...</view>`, hovering the iterable-side `item` (inside `wx:for="{{...}}"`) skips this scope (cursor ∈ wxForRange) and continues outward; eventually finding an outer `item` in data, or returning null.

### Step 2a body

```js
const binding = findMatchingWxForBinding(
  fileModel.wxForScopes,
  position,
  expressionRefMatch.name,
);
if (binding) {
  return makeWxForHover(binding.scope, binding.kind, expressionRefMatch.range);
}
// fall through to 2b
```

Not matching means the name comes from elsewhere — we fall through to 2b/2c/2d. Crucially we do **not** return null on a non-match here; 2a is opportunistic, not authoritative.

## Hover Content

Two new kind labels in `HOVER_KIND_LABELS`:

```js
wxForItem:  "wx:for-item",
wxForIndex: "wx:for-index",
```

`makeWxForHover(scope, kind, refRange)` returns:

| condition | source line |
|---|---|
| `scope.ownerTag !== null` AND (kind explicit) | `` Declared on `<${ownerTag}>` at line ${nameRange.start.row + 1} `` |
| `scope.ownerTag === null` AND (kind explicit) | `` Declared in wx:for at line ${nameRange.start.row + 1} `` |
| `scope.ownerTag !== null` AND (kind implicit, default name) | `` Declared on `<${ownerTag}>` at line ${wxForRange.start.row + 1} `` |
| `scope.ownerTag === null` AND (kind implicit, default name) | `` Declared in wx:for at line ${wxForRange.start.row + 1} `` |

Title line follows the existing two-line format:

```
**item** — `wx:for-item`

Declared on `<view>` at line 8
```

No path is rendered — wx:for declarations are always same-file by scope semantics.

The `range` field on the returned Hover is `expressionRefMatch.range` (narrow ident range), matching all other expression-ref branches.

## File-Level Changes

1. `shared/wxml-symbol-extractor.mjs`:
   - Add `wxForScopes` accumulator alongside existing `wxForItems` / `wxForIndexes` / `hasAnyWxFor`.
   - During element traversal, when an element carries `wx:for` (with or without `wx:for-item` / `wx:for-index`), build a scope record and push it.
   - Derive `wxForBindings` from `wxForScopes` at emit time.
   - Reuse `innerValueRange` for `itemNameRange` / `indexNameRange` (same pattern as wxs.nameRange).
   - Read `tag_name_node.text` for `ownerTag` (parallel to components extraction's existing `firstChildOfType(tag, "tag_name")?.text` pattern). `ownerTag` is a string, not a range; if `tag_name_node` is missing under grammar error-recovery, set `ownerTag: null` rather than dropping the scope.
   - Reuse `rangeOf(node)` for `scopeRange` and `rangeOf(wx:for attr node)` for `wxForRange`.

2. `server/wxml-hover.mjs`:
   - Add `HOVER_KIND_LABELS.wxForItem` and `HOVER_KIND_LABELS.wxForIndex`.
   - Add private helpers `findMatchingWxForBinding` (the reverse-scan algorithm from the Resolver Pipeline section above) and `makeWxForHover` (the 4-corner source-line formatter from the Hover Content section).
   - Insert step 2a at the top of the expression-ref AUTHORITATIVE branch's lookup chain.

3. `scripts/verify-wxml-language-service.mjs`: add W-1 through W-10 hover scenarios (see Test Plan).

4. `scripts/verify-wxml-narrow-ranges.mjs` (or a new sibling verifier): add 7 narrow-range cases for `wxForScopes` field-shape (S-F1 through S-F7) plus the W-7 compat invariant.

5. `fixtures/wasm-spike/*-symbols-baseline.json`: regenerate. Diff must be additive (new `wxForScopes` key on every fileModel) AND the derived `wxForBindings` must be byte-equal to the pre-change shape.

## Test Plan

All tests run via existing node sub-verifiers; the umbrella shell `bash scripts/verify-tree-sitter.sh` runs them all.

### Narrow-range / extractor cases (`verify-wxml-narrow-ranges.mjs`)

- **S-F1**: explicit `<view wx:for="{{xs}}" wx:for-item="foo" wx:for-index="bar">` produces one scope with `itemName === "foo"`, `itemSource === "explicit"`, `itemNameRange` covering only `foo`; same for index.
- **S-F2**: implicit `<view wx:for="{{xs}}">{{item}}</view>` produces one scope with `itemName === "item"`, `itemSource === "implicit"`, `itemNameRange === null`. Same for index.
- **S-F3**: nested loops produce two scope entries with overlapping `scopeRange`s; the inner scope's range is strictly smaller.
- **S-F4**: `<view wx:for="{{xs}}" wx:for-item="" wx:for-index="">` (empty explicit values) extracts as implicit: `itemName === "item"`, `itemSource === "implicit"`, `itemNameRange === null` (same for index). Confirms the legacy `v.length > 0` gate is preserved in the new schema.
- **S-F5** (loose-attrs compat): a fixture containing `<view wx:for-item="loose">{{loose}}</view>` (no `wx:for` — malformed but legacy-tolerated) produces ZERO entries in `wxForScopes`, but the derived `wxForBindings.items` still contains `"loose"` and `hasAnyWxFor === false`. Locks the loose-attrs preservation contract in the compat shim. (Use a real fixture file or synthesize via the extractor unit test scaffold — pick whichever is simpler.)
- **S-F6** (bare wx:for): `<view wx:for>{{item}}</view>` (`wx:for` attribute present with no value at all) produces exactly one scope with implicit defaults; `wxForBindings.hasAnyWxFor === true`. Locks legacy parity — the old extractor sets `hasAnyWxFor` on the attribute-name check alone, irrespective of value, and the new schema must mirror this by gating scope creation on `wx:for` attribute presence (not on its value).
- **S-F7** (dynamic item/index names): `<view wx:for="{{xs}}" wx:for-item="{{dyn}}">{{item}}</view>` — the `wx:for-item` value contains an interpolation. The legacy `quotedAttrTextValue` helper returns `null` for any value containing an `interpolation` child, so the new code MUST use the same helper (not `attributeRawValue`) to read item/index names. Expected: the scope falls back to implicit `itemName === "item"`, and `wxForBindings.items` does NOT contain the literal string `"{{dyn}}"`. Same applies to loose `wx:for-item="{{dyn}}"` without `wx:for`: must not leak into `wxForBindings.items`.

### Hover scenarios (`verify-wxml-language-service.mjs`)

- **W-1**: default wx:for, hover `{{item}}` → `**item** — \`wx:for-item\`` + `Declared on \`<view>\` at line N` (N = wx:for attr row + 1).
- **W-2**: explicit `wx:for-item="foo"`, hover `{{foo.name}}` on `foo` → `**foo** — \`wx:for-item\`` + line = `wx:for-item` attr row + 1.
- **W-3**: explicit `wx:for-index="bar"`, hover `{{bar}}` → `**bar** — \`wx:for-index\``.
- **W-4 (nested shadowing)**: outer `wx:for-item="outer"`, inner `wx:for-item="inner"`. Inside the inner subtree:
  - hover `{{outer}}` → still resolves to outer scope (inner only shadows `inner`).
  - hover `{{inner}}` → resolves to inner scope.
  - hover `{{outer}}` outside the inner subtree (still inside outer) → outer scope.
- **W-5**: `{{item}}` written entirely outside any `wx:for` → step 2a must NOT fire (no `wx:for-item` kind label). The cursor may still resolve via 2b/2c/2d if a `data` / `property` / `wxs` source of the same name exists — that is correct fall-through behavior. The invariant is "scope-out must not be mislabeled as wx:for-item", not "must return null." Test asserts the returned hover (if any) does NOT carry the `wx:for-item` kind label.
- **W-6**: member-chain `{{item.name}}`, hover on `name` → null (sub-step path filter; covered already by H-11 in hover v1).
- **W-7 (compat invariant)**: before any implementation work begins, capture the current `wxForBindings` shape (a small JSON object per fixture) by running the existing extractor on each baseline fixture and saving the literal `wxForBindings` value. Inline those captured literals in a new assertion in `verify-wxml-narrow-ranges.mjs` (or a focused new verifier). Post-implementation, run the extractor again and assert each fixture's emitted `wxForBindings` deep-equals the frozen literal. This is decoupled from the regenerated baseline files (which now also contain `wxForScopes`) and proves the shim is a true byte-for-byte view of the legacy field.
- **W-8 (priority: wx:for wins)**: synthesize a `data: { item: ... }` on the home config; in a wx:for subtree, hover `{{item}}` → `wx:for-item` kind label (NOT `data`). Outside the subtree, the same `{{item}}` → `data` kind. Confirms 2a runs before 2b.
- **W-9 (iterable exclusion)**: `<view wx:for="{{item}}" wx:for-item="item">...</view>` — the extractor already produces an expressionRef for `item` inside `wx:for="{{item}}"` (top-level identifier in an interpolated attribute value). Hover at that position must NOT resolve to this loop's own `itemName`; it should either resolve to an outer scope / data ref named `item`, or return null if no outer source exists. Use a real fixture WXML (one new file added to `fixtures/miniprogram/` is fine; or synthesize an expressionRef + scope pair on the home file model — pick whichever is simpler at implementation time).
- **W-10 (loop body shadowing data)**: same fixture as W-8's positive arm: in the loop body, `{{item}}` resolves to wx:for-item even when `data.item` exists. (Effectively the explicit-form of W-8; redundant if W-8 covers both arms, otherwise keep both for clarity.)

### LSP host scenario (`verify-lsp-diagnostics.mjs`)

- **L-W1** (graph-smoke suite): end-to-end `textDocument/hover` returns `**item** — \`wx:for-item\`` markdown for cursor inside a real fixture wx:for body. (Mirrors L-H2's shape.)

### Negative regressions

- Existing 25 hover scenarios continue to pass (the 2a addition is opportunistic; non-wx:for cursors are unaffected).
- All 7 baselines pass after regeneration (additive `wxForScopes` + unchanged derived `wxForBindings`).
- All prior graph-smoke scenarios pass (19 today including Hover v1's L-H4 + L-W1 added below = 20 total).

## Acceptance Criteria

1. `node scripts/verify-wxml-narrow-ranges.mjs` passes (5 prior + 7 new = 12, plus W-7 invariant = 13).
2. `node scripts/verify-wasm-symbol-baselines.mjs` passes (7).
3. `node scripts/verify-wxml-language-service.mjs` passes (existing + W-1 through W-10).
4. `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke` passes (19 prior including Hover v1's L-H4 + L-W1 = 20 scenarios).
5. The W-7 compat invariant holds: derived `wxForBindings` byte-equals pre-change output across every fixture. Completion and diagnostics tests show **zero** behavior changes.
6. `graph.version` unchanged (still 1).
7. Chelaile dogfood: hover on a real wx:for-item / wx:for-index renders the expected card; nested-loop hover picks the innermost binding; outside-loop hover returns nothing.

## Risks and Mitigations

- **Risk**: derived `wxForBindings` drifts from the legacy implementation in some edge case (e.g. duplicate wx:for-item names, or a malformed wx:for missing both item and index attrs).
  - **Mitigation**: W-7 invariant test on every existing fixture. Plus a defensive check: if `wxForScopes` is empty AND the original code path would have emitted `hasAnyWxFor: true` for the same fixture, the migration is wrong.

- **Risk**: nested-loop scope selection picks the wrong scope when sibling subtrees have identical scopeRange sizes.
  - **Mitigation**: ties resolve to last-extracted. Document this in the helper; W-4 tests both shadowing directions.

- **Risk**: grammar error-recovery produces an element where `wx:for` is partially-parsed; `wxForRange` derivation fails.
  - **Mitigation**: scope creation is gated on `wx:for` being extractable, so a failed-derivation element produces NO scope (rather than a scope with a null wxForRange). The cursor at that position falls through to 2b/2c/2d. The legacy `hasAnyWxFor` flag may also drop to `false` in this case, mirroring legacy's behavior for the same malformed input. No new failure mode introduced.

- **Risk**: a real wx:for-item is shadowing real production code that depended on file-level scope semantics (e.g., the same name as a global data property used outside the loop).
  - **Mitigation**: this would only affect hover behavior in v1 (completion / diagnostics unchanged). Worst case: a hover shows wx:for-item where the user expected data — informative, not destructive. If dogfood complains, we tune.

## Open Questions

None blocking. Items intentionally left for follow-ups:

- `getDefinition` step 2a parity (cmd-click on `{{item}}` jumps to declaring element).
- `getCompletions` cursor-scope tightening (suggest only in-scope binding names).
- `getDiagnostics` cursor-scope tightening (warn on `{{item}}` outside loop subtree).
- Declaration-side hover (cursor on the `item` inside `wx:for-item="item"` attr value).
- Removing the `wxForBindings` shim once all consumers have migrated.
