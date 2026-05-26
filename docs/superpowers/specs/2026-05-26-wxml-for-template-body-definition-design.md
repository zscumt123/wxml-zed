# WXML wx:for Definition + Hover Inside `<template name>` Bodies Design

## Goal

Let go-to-definition and hover resolve a `wx:for` loop binding **referenced
inside a `<template name="...">` body**, restricted to loops **declared within
that same template**. This closes the one gap the chelaile A/D dogfood surfaced
(`{{ad}}` inside `<template name="ad-self">` returned null): a loop variable
declared inside a template is lexically local and resolvable, but today the
`inTemplateDefinition` anti-noise gate suppresses all expression-reference
resolution inside template bodies before the `wx:for` branch runs.

## Background — why it's suppressed today

Expression references inside `<template name="X">` resolve in the **caller's**
data scope at use time (via `<template is="X" data="{{...}}"/>`), which the
language service does not have. So `getDefinition`
(`server/wxml-language-service.mjs:985`) and `getHover`
(`server/wxml-hover.mjs:188`) both early-return on
`expressionRefMatch.inTemplateDefinition` **before** the `wx:for` step-2a branch.
That is correct for data/property/wxs references, but over-broad for `wx:for`
loop variables, which are local to the template, not supplied by the caller.

There are two cases the design must separate:

- **Case 1 — loop declared inside the template body** (resolvable):
  ```wxml
  <template name="tpl-row">
    <view wx:for="{{rows}}" wx:for-item="row">{{row.label}}</view>
  </template>
  ```
  `{{row}}` is the local loop variable → definition/hover should resolve to the
  `wx:for-item="row"` declaration in the same file.

- **Case 2 — loop encloses the template definition** (must NOT leak):
  ```wxml
  <view wx:for="{{groups}}">
    <template name="tpl-inner">{{item}}</template>
  </view>
  ```
  WeChat templates do not capture the surrounding scope — they only receive
  `data` passed at `<template is data="{{...}}"/>`. So `{{item}}` inside
  `tpl-inner` is a caller-data reference, **not** the enclosing loop's `item`.
  Our `wxForScopes` are built from raw AST nesting, so the outer loop's
  `scopeRange` spuriously contains the template body; resolution must reject it.

## Scope (what this builds)

Use-site resolution only, for references inside template bodies:

- `getDefinition` on `{{loopVar}}` / `{{loopVar.x}}` inside a `<template name>`
  body → same-file `Location` (explicit name → its `wx:for-item`/`-index` value
  range; implicit default → `wxForKeywordRange`), but **only** when the matched
  loop is declared within the same template.
- `getHover` on the same → the loop card (`makeWxForHover`), same restriction.

## Non-Goals

- **Declaration-side hover (D) is already unaffected and unchanged.** Hovering a
  `wx:for-item="X"` attribute value runs through `findWxForDeclarationAtPosition`
  in a branch that sits *after* the `expressionRefMatch` block, so it never hits
  the `inTemplateDefinition` early-return. It already works inside templates. Do
  not touch it.
- Do **not** resolve data/property/wxs references inside template bodies — the
  caller's data scope is still unknown; those stay suppressed (return null).
- Do **not** change completion (v2-B) or diagnostics. Diagnostics already skip
  `inTemplateDefinition` refs (`expressionRefDiagnostics`,
  `server/wxml-language-service.mjs:873`); leave that as-is.
- Do **not** support nested `<template name>` inside `<template name>` with any
  special semantics beyond "innermost enclosing template wins."
- Do **not** change the WXML grammar or `graph.version` (this is a consumer-side
  change plus reuse of existing `symbols` template ranges).

## Current Baseline

- `wxForScopes[]` already includes loops declared inside template bodies — the
  extractor walks into `template_definition` nodes
  (`shared/wxml-symbol-extractor.mjs`). Each scope carries `scopeRange`,
  `wxForRange` (the whole `wx:for="..."` attribute), `itemName/itemNameRange/
  itemSource`, `indexName/indexNameRange/indexSource`, `wxForKeywordRange`,
  `ownerTag`.
- Template definitions are emitted into `fileModel.symbols` as
  `{ kind: "template", name, range }` where `range` is the whole
  `<template name>...</template>` node (`shared/wxml-symbol-extractor.mjs:287`).
  This is the boundary data the design needs — no new extractor field.
- `expressionRefMatch.inTemplateDefinition` is a boolean (no template id); the
  enclosing template is found by containment against the `symbols` template
  ranges.
- The pure resolvers live in `server/wxml-for-scope.mjs`
  (`containsPosition`, `findMatchingWxForBinding`, `findWxForDeclarationAtPosition`).

## Design

### New pure helpers in `server/wxml-for-scope.mjs`

Two dependency-free additions (range/position math only):

```js
// Innermost template range containing the position, or null. templateRanges is
// an array of symbol-extractor ranges ({ start:{row,column}, end:{row,column} }).
// Template definitions never partially overlap, so among the ranges that contain
// the position the innermost is simply the one whose start point is latest — no
// span/area heuristic needed (and two templates can't share a start point).
export function findEnclosingTemplateRange(templateRanges, position) {
  let best = null;
  for (const range of templateRanges ?? []) {
    if (!containsPosition(range, position)) continue;
    if (best === null || startsAfter(range.start, best.start)) best = range;
  }
  return best;
}

// a strictly after b in (row, column) order
function startsAfter(a, b) {
  return a.row > b.row || (a.row === b.row && a.column > b.column);
}

// Scopes whose wx:for DECLARATION (wxForRange start) falls within boundaryRange.
// Used to keep only loops declared inside the enclosing template, so an outer
// loop that merely encloses the template definition (Case 2) is excluded.
export function scopesDeclaredWithin(scopes, boundaryRange) {
  return (scopes ?? []).filter((scope) => containsPosition(boundaryRange, {
    line: scope.wxForRange.start.row,
    character: scope.wxForRange.start.column,
  }));
}
```

`findMatchingWxForBinding` is **unchanged** (zero risk to the non-template A/D paths).

### `getDefinition` change (`server/wxml-language-service.mjs`)

Replace the unconditional early-return inside the `expressionRefMatch` block:

```js
if (expressionRefMatch.inTemplateDefinition) {
  // Template bodies suppress caller-scope data/property/wxs refs, but a wx:for
  // loop variable declared INSIDE the same template is lexically local and
  // resolvable. Restrict to scopes declared within the enclosing template so an
  // outer loop enclosing the template definition (Case 2) cannot leak in.
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

The target-range selection is identical to the non-template step 2a (source-keyed,
with the same legacy-graph degrade: absent `targetRange` → fall through to the
final `return null`). The non-template path below this block is unchanged.

### `getHover` change (`server/wxml-hover.mjs`)

Symmetric replacement of the `inTemplateDefinition` early-return:

```js
if (expressionRefMatch.inTemplateDefinition) {
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

`findEnclosingTemplateRange` and `scopesDeclaredWithin` are imported from
`wxml-for-scope.mjs` (the same leaf-module import that already brings in
`findMatchingWxForBinding`, `findWxForDeclarationAtPosition`, `containsPosition`).

## Testing

### New fixture

A dedicated page keeps `loops.wxml`'s frozen W-1..W-11 / D-1..D-10 positions and
its W-7 snapshot untouched. Create:

- `fixtures/miniprogram/pages/tpl-loops/tpl-loops.wxml`:
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
  Note `{{item}}` appears in both `tpl-implicit` (`{{item}} {{index}}`) and
  `tpl-inner` (`{{item}}`); tests must target each by its distinctive
  surrounding line text, not a bare `{{item}}` search.
- `fixtures/miniprogram/pages/tpl-loops/tpl-loops.js`:
  ```js
  Page({ data: { rows: [], groups: [], theme: "x" }, onLoad() {} });
  ```
- `fixtures/miniprogram/pages/tpl-loops/tpl-loops.json`: `{}`
- `fixtures/miniprogram/app.json`: add `"pages/tpl-loops/tpl-loops"` to `pages`.

### Verifier cases (`scripts/verify-wxml-language-service.mjs`, flat runner)

Use a `TPL_LOOPS_WXML` path + `readFileSync`/`indexOf` position helpers
(mirroring the D-series). Add `findIndex >= 0` setup guards.

Explicit-name cases (`tpl-row`):
- **T-1 (explicit item, definition):** def on `{{row.label}}` → same-file
  Location, range text === `"row"`.
- **T-2 (explicit item, hover):** hover same → title `**row** — \`wx:for-item\``.
- **T-3 (explicit index, definition):** def on `#{{idx}}` → range text === `"idx"`.
- **T-4 (explicit index, hover):** hover same → title `**idx** — \`wx:for-index\``.

Implicit-name cases (`tpl-implicit`, line `{{item}} {{index}}` — both fall back
to the `wx:for` keyword token):
- **T-5 (implicit item, definition):** def on `{{item}}` → range text === `"wx:for"`.
- **T-6 (implicit item, hover):** hover same → title `**item** — \`wx:for-item\``.
- **T-7 (implicit index, definition):** def on `{{index}}` → range text === `"wx:for"`.
- **T-8 (implicit index, hover):** hover same → title `**index** — \`wx:for-index\``.

Suppression / no-leak controls:
- **T-9 (data-ref suppressed, definition):** def on `{{theme}}` inside `tpl-row`
  → `null` (even though `theme` is a valid data key — template-body suppression holds).
- **T-10 (data-ref suppressed, hover):** hover on `{{theme}}` → `null`.
- **T-11 (Case 2 no-leak, definition):** def on `{{item}}` inside `tpl-inner` →
  `null` (must not resolve to the enclosing `<view wx:for="{{groups}}">` default
  `item`; this is the boundary discriminator — same `item` name resolves in
  `tpl-implicit` (T-5) but not in `tpl-inner`).
- **T-12 (Case 2 no-leak, hover):** hover on `{{item}}` inside `tpl-inner` → `null`.
- **T-13 (declaration-side item unaffected):** hover on the `wx:for-item="row"`
  value inside `tpl-row` → title `**row** — \`wx:for-item\`` (confirms D still
  works inside templates; guards against accidentally gating it).
- **T-14 (declaration-side index unaffected):** hover on the `wx:for-index="idx"`
  value inside `tpl-row` → title `**idx** — \`wx:for-index\``.

### Regression / invariant guards

- **Non-template paths unchanged:** the full `loops.wxml` suite (W-1..W-11,
  D-1..D-10, HD-1..HD-3) must stay green — the change only alters the
  `inTemplateDefinition === true` branch.
- **Pure-helper unit coverage** in `scripts/verify-wxml-narrow-ranges.mjs` is
  optional; the behavior is fully exercised by the language-service T-series
  cases (T-1..T-14). (If added, assert
  `scopesDeclaredWithin` excludes an outer-declared scope and
  `findEnclosingTemplateRange` returns the innermost range.)
- **Baselines:** the new fixture appears in the miniprogram glob, so
  `verify-wasm-symbol-baselines.mjs` regenerates additively (new file) and W-7
  gains one frozen entry (`miniprogram-symbols-baseline.json::fixtures/
  miniprogram/pages/tpl-loops/tpl-loops.wxml`). Regenerate per the W-7 Step-1
  command and paste the literal. Also **de-hardcode** the `miniprogram (12
  fixtures)` case `name` in `verify-wasm-symbol-baselines.mjs` — that count is a
  hardcoded label and is already stale (the glob currently matches 17 `.wxml`
  files, becoming 18 with this fixture). Change it to a count-free label such as
  `miniprogram (all .wxml fixtures)` so it can't drift again. The new
  `tpl-loops.js` does **not** affect the JS baselines — `verify-js-method-
  baselines.mjs` lists specific `wasm-spike` files and does not glob
  `fixtures/miniprogram`.
- **graph-smoke:** no new host-wire scenario required — the LSP transport is
  already covered by L-W1/L-W2; this is a pure resolution-logic change behind the
  same handlers. (Adding one is optional, not required.)
- `graph.version` unchanged.

## Acceptance Criteria

1. Definition on a `wx:for` loop variable (item **or** index, explicit **or**
   implicit) referenced inside the template that declares it resolves to a
   same-file Location — explicit → its name range, implicit → the `wx:for`
   token. (T-1, T-3, T-5, T-7)
2. Hover on the same renders the correct loop card (`wx:for-item` vs
   `wx:for-index`, with the resolved name). (T-2, T-4, T-6, T-8)
3. Data/property/wxs references inside a template body still return null for both
   definition and hover. (T-9, T-10)
4. A reference inside a template body whose name matches an **outer** loop that
   merely encloses the template definition returns null — no scope leak — even
   though the same name resolves inside a template that declares it. (T-11, T-12)
5. Declaration-side hover on a `wx:for-item` **and** `wx:for-index` value inside
   a template still works. (T-13, T-14)
6. All non-template wx:for definition/hover behavior is unchanged (W-1..W-11,
   D-1..D-10, HD-1..HD-3 green).
7. Completion and diagnostics behavior unchanged; `graph.version` unchanged; all
   offline verifiers green.
