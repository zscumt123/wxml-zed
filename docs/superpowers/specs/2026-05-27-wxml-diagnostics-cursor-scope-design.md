# WXML Diagnostics Cursor-Scope Tightening (v2-C) Design

## Goal

Make the `missing-expression-ref` diagnostic judge a `wx:for` loop binding as
in-scope **only at positions inside that loop's active scope**, matching the
per-element semantics hover, definition, and (since v2-B) completion already use
via `wxForScopes[]`. Today `expressionRefDiagnostics` builds a single flat scope
set that dumps every loop's `item`/`index`/explicit names from the file-level
`wxForBindings` shim, so any `wx:for` anywhere in the file makes those names
legal everywhere — a `{{item}}` written *outside* every loop is silently
accepted even though WXML evaluates it as undefined.

```html
<view wx:for="{{list}}">{{item.name}}</view>  <!-- in-loop: legal -->
<view>{{item.name}}</view>                     <!-- out-of-loop: undefined in WXML, but not flagged today -->
```

After this change the second `{{item.name}}` warns; the first stays clean.

## Empirical pre-scan (risk is measured, not assumed)

Before specifying, a throwaway analysis (`$TMPDIR`, read-only, never written into
any third-party tree) counted refs that **pass today** (name present in the flat
shim) but **would warn** under per-position scoping (name not in global scope AND
not active at the ref's own position):

| Corpus | graph wxml files | non-template refs | loop-dependent refs | in-scope | **newly-warned** |
|---|---|---|---|---|---|
| our `fixtures/miniprogram` | 17 | 47 | 8 | 8 | **0** |
| chelaile (real) | 196 | 1700 | 331 | 331 | **0** |

(Counts are over the app.json-reachable graph — what `expressionRefDiagnostics`
actually runs on. `fixtures/miniprogram` has 18 `.wxml` on disk; the 18th,
`templates/unrelated.wxml`, is not reachable from `app.json` so it has no owner
script and is skipped anyway. The on-disk count matters only for the wasm
baseline glob — see Regression.)

All 331 loop-variable references in a real 196-file project sit inside their
loop's active scope: **zero new warnings**. The scan demonstrably sees `wx:for`
refs (it lists them), so the zero is real, not a masking bug. Consequences:

- **Regression risk ≈ 0.** Existing verifier baselines do not change; chelaile
  produces no noise.
- The "new red squiggles" risk does not materialize on real code — authors
  don't write loop variables outside loops (the page wouldn't render).
- Therefore the change ships as a plain `missing-expression-ref` **Warning** with
  no severity downgrade and no new diagnostic code. dogfood becomes a
  *confirmation* step, not a go/no-go gate (still run post-implementation as the
  canonical guard; if some specific pattern ever does surface noise, suppress
  that pattern then — do not pre-build classification machinery now, YAGNI).
- Neither real corpus produces a single new-warning sample, so a **synthetic
  fixture** is required to exercise the new warning path at all.

## Current Baseline

`expressionRefDiagnostics(graph, documentGraphPath, fileModel)`
(`server/wxml-language-service.mjs:847`) bails when there is no owner script or
`hasDynamicData` is true, then builds one flat `scope` Set:

```js
const scope = new Set();
for (const key of ownerConfig.script.dataKeys ?? []) scope.add(key.name);
for (const key of ownerConfig.script.propertyKeys ?? []) scope.add(key.name);
for (const sym of fileModel.symbols ?? []) {
  if (sym.kind === "wxs" && typeof sym.name === "string") scope.add(sym.name);
}
const bindings = fileModel.wxForBindings;
if (bindings) {
  if (bindings.hasAnyWxFor) { scope.add("item"); scope.add("index"); }
  for (const name of bindings.items ?? []) scope.add(name);
  for (const name of bindings.indexes ?? []) scope.add(name);
}
```

Then per ref: skip if `ref.inTemplateDefinition`; skip if `scope.has(ref.name)`;
else run the cross-component prop check (`dead-component-binding` Information) or
fall through to a `missing-expression-ref` Warning. Each `ref` carries
`{ name, range: { start: { row, column }, ... }, inTemplateDefinition,
containingTag, containingAttribute }` (`shared/wxml-symbol-extractor.mjs:194`).

The pure leaf `server/wxml-for-scope.mjs` already exports
`activeWxForBindingsAt(scopes, position)` (added in v2-B): reverse-scan,
keep scopes whose `scopeRange` contains the LSP position but whose own
`wxForRange` does NOT (iterable-exclusion), return each loop's `{name, kind}`
item+index pair.

## Design

### §1 — Split flat scope into global + per-ref local

`expressionRefDiagnostics` keeps the same bail conditions and the same
cross-component / warning emission. Two changes:

1. Build only the **global** scope from data keys + property keys + wxs symbols.
   Delete the `fileModel.wxForBindings` block entirely (including the
   `hasAnyWxFor`-driven `item`/`index` injection).
2. Per ref, compute the **active** loop bindings at the ref's own position and
   accept the name if it is global OR active:

```js
const global = new Set();
for (const key of ownerConfig.script.dataKeys ?? []) global.add(key.name);
for (const key of ownerConfig.script.propertyKeys ?? []) global.add(key.name);
for (const sym of fileModel.symbols ?? []) {
  if (sym.kind === "wxs" && typeof sym.name === "string") global.add(sym.name);
}

for (const ref of refs) {
  if (ref.inTemplateDefinition) continue;
  if (global.has(ref.name)) continue;
  const active = activeWxForBindingsAt(fileModel.wxForScopes, {
    line: ref.range.start.row,
    character: ref.range.start.column,
  });
  if (active.some((b) => b.name === ref.name)) continue;
  // ...unchanged: cross-component dead-component-binding check, else Warning.
}
```

Notes:
- **Position conversion is explicit and load-bearing:** `activeWxForBindingsAt`
  takes an LSP `{ line, character }`; `ref.range.start` is symbol-form
  `{ row, column }`. Passing the wrong shape silently returns `[]` (every loop
  ref would warn), so the conversion is part of the spec.
- **Existence only, no ordering.** Diagnostics asks "is this name in scope here",
  not "which binding wins". `activeWxForBindingsAt`'s innermost-first ordering is
  irrelevant; `.some(b => b.name === ref.name)` suffices. No new Set is built per
  ref.
- **No staleness window (unlike completion).** `expressionRefs` and
  `wxForScopes` come from the same parse (the same graph or didChange overlay
  `fileModel`), so the ref position and scope ranges are always consistent. The
  live-buffer-vs-saved-graph skew documented for v2-B completion does not apply.
- **No new import.** `activeWxForBindingsAt` was already added to the leaf import
  block in v2-B (completion uses it), so the symbol is already in scope in
  `server/wxml-language-service.mjs`. Confirm; do not duplicate the import.

### §2 — message wording

The Warning constant says "wx:for scope" in a whole-file voice. Tighten to name
the position:

> `"${ref.name}" is not defined in the page/component data, the wx:for scope at this position, or any <wxs> module.`

Only this one constant changes. The `dead-component-binding` Information message
is untouched (it concerns cross-component prop binding, not loop scope). **Code
and severity are unchanged** (`missing-expression-ref` / Warning).

### §3 — shim retained, template body still suppressed

- **`wxForBindings` shim is NOT removed this round.** After this change
  diagnostics no longer reads it, leaving it with **zero runtime consumers**. Add
  a one-line comment at the shim's definition marking it "as of v2-C: only the
  W-7 legacy byte-equal baseline reads this; no runtime consumer." The `W-7`
  byte-equal invariant stays green. Retirement (delete shim + retire/convert W-7)
  is a separate later round, started on demand.
- **Template bodies stay fully suppressed.** `if (ref.inTemplateDefinition)
  continue` is unchanged. Known limitation (recorded, not fixed here): a wx:for
  or wrong ref inside a `<template name>` body is never diagnosed, an asymmetry
  with hover/definition which (since the template-body feature) resolve
  template-local loops. Opening it would require swapping §1's per-ref lookup for
  a "loops declared within this template" variant — a separate round.
- **graph / extractor / completion / hover / definition are untouched.** Scope is
  one function + one message constant + a new fixture and its tests.

## New Fixture

`fixtures/miniprogram/pages/scope-leak/scope-leak.{wxml,js,json}` — purpose-built
so loop variable names are **not** data-backed (no fallback), exercising the new
warning path that neither real corpus produces. `scope-leak.js` data holds only
the iterable sources (`list`, `a`, `g`), never the loop bindings
(`row`, `x`, `z`, `grp`):

```html
<view wx:for="{{list}}" wx:for-item="row">{{row.name}}</view>  <!-- in-loop: clean -->
<view>{{row.name}}</view>                                       <!-- out-of-loop: Warning -->

<view wx:for="{{a}}" wx:for-item="x">
  <view wx:for="{{x.items}}" wx:for-item="z">{{x}} {{z}}</view> <!-- nested + iterable-exclusion -->
</view>
<view>{{z}}</view>                                              <!-- sibling no-leak: Warning -->

<block wx:for="{{g}}" wx:for-item="grp">{{grp}}</block>         <!-- block loop: clean -->
<view>{{grp}}</view>                                            <!-- block out-of-loop: Warning -->
```

`scope-leak` must be registered in `fixtures/miniprogram/app.json` `pages` and
have a `scope-leak.js` (`Page({ data: { list, a, g } })`) sibling — otherwise
`findOwnerConfigWithScript` returns null, `expressionRefDiagnostics` bails, and
the E-series tests pass vacuously. This is the same registration the existing
`loops`/`tpl-loops` fixtures use.

The inner loop's iterable `{{x.items}}` references the **outer** binding `x`,
which is active there (outer `scopeRange` contains it, outer `wxForRange` does
not) → no warning, proving an enclosing loop's binding survives inside a nested
loop's iterable. The inner binding `z` is not active inside its own iterable
(iterable-exclusion); `z` referenced after the outer loop closes warns
(sibling no-leak). Final exact shapes are settled in the plan; the set of
behaviors above is fixed.

## Testing

Diagnostics are protocol-level (range/code/severity wire format), so tests go in
`scripts/verify-lsp-diagnostics.mjs` (graph-smoke suite), not the
language-service runner. New scenarios on `scope-leak.wxml`:

- **E-1 in-loop clean:** `{{row.name}}` inside `wx:for-item="row"` → no diagnostic.
- **E-2 out-of-loop warns:** `{{row.name}}` outside every loop →
  `missing-expression-ref` Warning whose range covers the `row` identifier.
- **E-3 nested inner clean:** `{{x}}` (outer) and `{{z}}` (inner) inside the
  inner loop body → no diagnostic (both enclosing loops active).
- **E-4 sibling no-leak:** `{{z}}` after the outer loop closes → Warning
  (`z` from a closed loop is not in scope at that position).
- **E-5 iterable-exclusion:** `{{x}}` inside the inner loop's iterable
  `wx:for="{{x.items}}"` → no diagnostic (enclosing `x` still active there),
  confirming exclusion is per-scope, not blanket.
- **E-6 block loop:** `{{grp}}` inside `<block wx:for>` clean; `{{grp}}` after it
  warns.
- **E-7 regression — no new warnings elsewhere:** existing graph-smoke scenarios
  keep the same diagnostic `code`/`severity`/`range`/count; only `scope-leak`
  introduces new Warnings. (The pre-scan's 0-newly-warned on every existing
  graph file holds.)

### Regression / invariant

- All existing graph-smoke scenarios (21) stay green: diagnostic
  `code`/`severity`/`range`/count are unchanged. The only object-level change is
  the `missing-expression-ref` **message** text wherever that code is emitted
  (§2's reworded constant). Existing assertions match on code + the quoted
  identifier substring (e.g. `.message.includes('"__undef_a__"')`), not the full
  message string, so they stay green; do not claim the diagnostic objects are
  byte-identical — the message field changes.
- `verify-wxml-language-service.mjs` (hover/definition/completion + W/D/HD/T/B
  series) untouched and green.
- **wasm symbol baselines + W-7 must be updated for the new fixture (NOT
  unchanged).** `verify-wasm-symbol-baselines.mjs`'s `miniprogram` case globs
  `fixtures/miniprogram` recursively for every `.wxml`, so adding
  `scope-leak.wxml` (18→19 on disk) requires regenerating
  `fixtures/wasm-spike/miniprogram-symbols-baseline.json`. Correspondingly,
  `scripts/verify-wxml-narrow-ranges.mjs`'s `W7_FROZEN_WX_FOR_BINDINGS` map needs
  a new entry
  `miniprogram-symbols-baseline.json::fixtures/miniprogram/pages/scope-leak/scope-leak.wxml`
  with the fixture's frozen `wxForBindings` (non-empty: it has `wx:for` loops —
  `hasAnyWxFor: true`, sorted explicit `items`/`indexes`), or W-7's
  missing-frozen-snapshot assert fires. The extractor itself is **not** modified;
  these are purely additive baseline/map updates for the new fixture.
- `W-7` byte-equal stays green after the map update; the `wxForBindings` shim is
  byte-unchanged for all pre-existing files.
- No `graph.version` bump (consumer-side only).
- Post-implementation: re-run the pre-scan on our fixtures + chelaile; confirm
  newly-warned count matches the spec's intent (0 outside `scope-leak`).

## Acceptance Criteria

1. Inside a loop body, the loop's `item`/`index`/explicit binding referenced in an
   expression produces no diagnostic. (E-1, E-3, E-6)
2. Outside any loop, a reference to a loop binding that is not also a
   data/property/wxs name produces a `missing-expression-ref` Warning at the
   identifier's range. (E-2, E-6)
3. A sibling/unrelated loop's binding does not leak into another position. (E-4)
4. Nested loops keep all enclosing loops' bindings in scope. (E-3)
5. Inside a loop's own `wx:for` iterable expression, that loop's binding is not in
   scope, but an enclosing loop's bindings are. (E-5)
6. Completion inside a `<template name>` body — and diagnostics inside it — remain
   suppressed; the template-body diagnostic asymmetry is recorded as a known
   limitation, not fixed. (unchanged behavior)
7. `missing-expression-ref` code and Warning severity are unchanged; only the
   message constant is reworded to name the position.
8. The full verifier suite stays green after the additive baseline updates: the
   wasm `miniprogram` baseline and the `W7_FROZEN_WX_FOR_BINDINGS` map gain a
   `scope-leak` entry (the extractor is unmodified, the shim is byte-unchanged for
   all pre-existing files). `graph.version` is unchanged; the `wxForBindings` shim
   is left in place (retirement is a later round).
