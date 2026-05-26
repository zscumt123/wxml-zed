# WXML Completion Cursor-Scope Tightening (v2-B) Design

## Goal

Make `{{ }}` expression completion offer a `wx:for` loop binding (`item` / `index`
/ explicit names) **only when the cursor is inside that loop's scope**, matching
the per-element scope semantics that hover and definition already use via
`wxForScopes[]`. Today completion reads the flat file-level `wxForBindings` shim,
so every loop's binding names are suggested everywhere in the file —
inconsistent with hover/definition and noisy in multi-loop files.

## Non-Goals

- **Do not open completion inside `<template name>` bodies.** It is fully
  suppressed today (`interpolationCompletionContext` returns `{ suppress: true }`
  via a live-buffer `isCursorInsideTemplateDefinitionBody` scan). That trivially
  respects the template boundary by never leaking a loop name; offering
  template-local loop completion would require reconciling the live unsaved
  buffer against saved-graph scope ranges and is deferred.
- **Do not retire the `wxForBindings` shim.** After this change, completion no
  longer reads it, but `expressionRefDiagnostics` still does. The shim is retired
  only when v2-C migrates diagnostics. This phase leaves the shim and its
  W-7 byte-equal invariant untouched.
- Do not change data/property/wxs or event-handler completion, the
  object-literal / member-access / string-literal suppression rules, or the
  final label sort.
- No grammar change; no `graph.version` bump (consumer-side only).

## Current Baseline

`dataRefCompletionItems(graph, documentGraphPath, fileModel, range)`
(`server/wxml-language-service.mjs:645`) builds completion items: data keys +
property keys (from `ownerConfig`), wxs module symbols, then the flat wx:for
block:

```js
const bindings = fileModel.wxForBindings;
if (bindings) {
  if (bindings.hasAnyWxFor) {
    pushName("item", "wx:for item");
    pushName("index", "wx:for index");
  }
  for (const name of bindings.items ?? []) pushName(name, "wx:for item");
  for (const name of bindings.indexes ?? []) pushName(name, "wx:for index");
}
```

It receives **no `position`**, so it cannot scope. It is the only completion
consumer of `wxForBindings`. `getCompletions` (`:722`) already has `position` and
computes `interpolationContext` (which suppresses template-body / object-literal /
string-literal / member-access contexts before completion items are built). It
calls `dataRefCompletionItems(graph, documentGraphPath, fileModel,
interpolationContext.range)` at `:739`. Items are sorted by `label` just before
return. `pushName` dedups by name via a `seen` set (first push wins the
label/detail).

The pure leaf module `server/wxml-for-scope.mjs` already holds `containsPosition`,
`findMatchingWxForBinding`, `findWxForDeclarationAtPosition`,
`findEnclosingTemplateRange`, `scopesDeclaredWithin`.

## Design

### New pure leaf helper `activeWxForBindingsAt`

Add to `server/wxml-for-scope.mjs`:

```js
/**
 * All wx:for bindings (item + index of every loop) whose scope is active at the
 * position: scopeRange contains the position AND the loop's own wxForRange does
 * NOT (iterable-exclusion — an identifier inside `wx:for="{{x}}"` evaluates in
 * the OUTER scope, so the loop's own binding is not active there).
 *
 * Returned INNERMOST-FIRST (reverse extraction order, which is pre-order so
 * children come after parents). Callers that dedup by name keep the innermost
 * binding's kind/detail on a same-name shadow. Ordering does NOT determine UI
 * display order — getCompletions sorts items by label afterward; it only decides
 * which binding wins dedup.
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

This is the position→active-bindings primitive v2-C will reuse for diagnostics.

### `dataRefCompletionItems` change

- Add a `position` parameter (last); thread it from the `getCompletions` call site
  (`:739`) — `dataRefCompletionItems(graph, documentGraphPath, fileModel,
  interpolationContext.range, position)`.
- **Move** the wx:for block to the **top** of the function — pushed **before**
  data/property and before wxs — and replace the flat `wxForBindings` block with:

```js
// Active wx:for bindings FIRST so an in-scope loop variable shadows a
// same-named data/property/wxs symbol, matching hover/definition (wx:for is
// step 2a, ahead of 2b/2c/2d — server/wxml-language-service.mjs:987). seen
// first-wins then gives the loop binding the candidate.
for (const { name, kind } of activeWxForBindingsAt(fileModel.wxForScopes, position)) {
  pushName(name, kind === "item" ? "wx:for item" : "wx:for index");
}
// ...then the existing data/property push, then the wxs push (unchanged).
```

`hasAnyWxFor`-driven `item`/`index` injection is gone: a default loop's
`itemName`/`indexName` literally **are** `"item"`/`"index"`, so they're offered
exactly (and only) inside a default loop's active scope. `pushName`'s `seen` dedup
+ the final label sort are unchanged; only the **push order** moves so that
shadowing is consistent with hover/definition. Concretely: with `data.item`
present plus a default loop, the cursor inside that loop offers `item` as
**`wx:for item`** (loop pushed first → wins dedup); the cursor outside any loop
offers `item` as `data` (the loop block pushes nothing there). This removes the
prior completion-vs-hover/definition labelling mismatch rather than preserving it.

### Template body, object-literal, etc. — unchanged

All upstream suppression in `interpolationCompletionContext` is untouched.
Completion inside a `<template name>` body still returns `[]` before
`dataRefCompletionItems` runs, so `activeWxForBindingsAt` never executes there.

### Staleness (honest note)

Completion runs against the **live buffer** `sourceText` for the cursor position
but the **saved graph** for `fileModel.wxForScopes` (no overlay — confirmed in
`server/wxml-lsp.mjs` `completionsForRequest`). The flat shim was
position-independent; scoping introduces position-sensitivity, so on an *unsaved
structural edit* (e.g. lines inserted above an existing loop) the graph's
`scopeRange` can lag the buffer position and a binding may be momentarily
under-offered. This is transient, self-heals on save/rebuild, and is low-harm
(completion only ever *omits* a candidate, never raises a false error) — the same
class of staleness the graph-derived data-key completion already has.

## Testing

### Unit (pure helper) — `scripts/verify-wxml-narrow-ranges.mjs`

`activeWxForBindingsAt` over **synthetic** scopes (no extraction needed):
- **B-U1 outside:** position outside all scopeRanges → `[]`.
- **B-U2 single loop:** one scope containing position → `[{item},{index}]` with that scope's names.
- **B-U3 nested union:** outer+inner both contain position (different names) → both loops' item+index, **innermost-first** (inner entries precede outer).
- **B-U4 same-name shadow:** outer item `x`, inner item `x`, both contain position → inner's `{x,item}` appears before outer's `{x,item}` (innermost-first ordering, so a `seen`-dedup keeps the inner one).
- **B-U5 iterable-exclusion:** position inside inner loop's `wxForRange` (its `{{...}}` iterable) but inside outer's `scopeRange` → inner excluded, outer's bindings present.
- **B-U6 defensive:** a scope missing `scopeRange`/`wxForRange` is skipped without throwing.

### Integration (real fixture as sourceText AND graph) — `scripts/verify-wxml-language-service.mjs`

Existing completion tests use synthetic `sourceText` with a real graph; that
cannot test position-scoping (the synthetic cursor isn't inside the graph's real
loop ranges). These tests therefore read the fixture file from disk as
`sourceText` and use the matching `documentPath`, placing the cursor at the
**root** of an existing interpolation (right after `{{`, so the prefix is empty
and identifier completion fires). Helper: `loopsCompletionAt(graph, line, char)`
reads `LOOPS_WXML` and calls `getCompletions`; assert against `items.map(i =>
i.label)` and, where detail matters, the matching item's `detail`.

Cases on `fixtures/miniprogram/pages/loops/loops.wxml`:
- **B-1 outside loop:** cursor at root of `{{item}}` on the `outside-loop` line →
  the `item` candidate's detail is **`data`** (not `wx:for item`) — the complement
  of B-2, proving the loop block contributes nothing outside a loop. No `wx:for
  index` candidate; explicit loop names (`prod`, `idx`, `outer`, `inner`, `grp`)
  absent.
- **B-2 default loop body (shadows data):** cursor at root of `{{item.name}}`
  (inside `wx:for="{{users}}"`) → the `item` candidate's detail is **`wx:for
  item`**, NOT `data` — even though `loops.js` declares `data: { item: {...} }`.
  This is the load-bearing shadowing lock (loop pushed before data → wins dedup,
  matching hover/definition). Also: an `index` candidate with detail `wx:for
  index` is present; explicit names (`prod`/`idx`/`outer`/`inner`/`grp`) absent.
- **B-3 explicit loop body:** cursor at root of `{{prod.title}}` (inside
  `wx:for-item="prod" wx:for-index="idx"`) → `prod` and `idx` present; `index`
  absent (not in scope, not a data key); other loops' names (`outer`/`inner`/
  `grp`) absent.
- **B-4 nested loops:** cursor at root of `{{inner.value}}` (and `{{outer.label}}`)
  on the nested line → both `outer` and `inner` present; `prod`/`idx`/`grp` absent.
- **B-5 iterable-exclusion with outer allowed:** cursor inside the inner loop's
  iterable `{{outer.entries}}` (the `wx:for="{{outer.entries}}"` value) → `inner`
  absent (its own iterable excludes it) but `outer` present (outer loop still in
  scope). This is the key lock: exclusion is per-scope, not blanket.
- **B-6 block loop:** cursor at root of `{{grp.label}}` (inside `<block
  wx:for="{{groups}}" wx:for-item="grp">`) → `grp` present; other loops' names absent.

Template-body suppression lock on `fixtures/miniprogram/pages/tpl-loops/tpl-loops.wxml`:
- **B-7 template body suppressed:** cursor at root of `{{row.label}}` inside
  `tpl-row` → `getCompletions` returns `[]` (suppression unchanged; no loop or
  data candidates).

### Regression / invariant

- Existing completion tests (data-ref / property / wxs module / event-handler /
  object-literal / member-access / string-literal / template suppression) stay
  green — they assert position-independent behavior the change preserves.
- `W-7` byte-equal stays green; `wxForBindings` shim and diagnostics are untouched.
- Hover/definition (W/D/HD + T-series) untouched.
- No `graph.version` bump; full offline verifier suite + graph-smoke green.

## Acceptance Criteria

1. Inside a loop body, the loop's `item`/`index` (or explicit names) are offered
   as `wx:for` completion candidates, and an in-scope loop binding **shadows** a
   same-named data/property/wxs symbol (detail `wx:for item`/`wx:for index`, not
   `data`) — consistent with hover/definition. (B-2, B-3, B-6)
2. Outside any loop, no default `item`/`index` and no explicit loop name is
   offered as a `wx:for` binding; a same-named data field is offered as `data`. (B-1)
3. Nested loops offer the union of all enclosing loops' bindings; an explicit
   name from a sibling/unrelated loop is not offered. (B-3, B-4)
4. A same-name binding shadowed across nesting appears once, with the innermost
   loop's detail (via innermost-first ordering + `seen` dedup). (B-U4)
5. Inside a loop's own `wx:for` iterable expression, that loop's binding is not
   offered, but an enclosing loop's bindings still are. (B-5, B-U5)
6. Completion inside a `<template name>` body remains fully suppressed. (B-7)
7. `activeWxForBindingsAt` returns innermost-first and skips range-less scopes;
   final completion display order is still label-sorted. (B-U1..B-U6)
8. All existing completion tests, hover/definition tests, W-7, and the full
   verifier suite stay green; `graph.version` and the `wxForBindings` shim
   unchanged.
