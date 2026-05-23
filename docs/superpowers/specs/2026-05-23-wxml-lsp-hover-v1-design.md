# WXML LSP Hover v1 Design

## Goal

Add `textDocument/hover` to the WXML LSP. Hovering an identifier or tag in `.wxml` returns a small markdown card that names the symbol, classifies its kind, and points at the file where it is defined. Hover v1 is a read-only, graph-driven explanation surface — it never re-parses, never infers types, and never produces output that is not derivable from the existing project graph plus one small additive schema extension.

## Non-Goals

- Do not add hover for `wx:for-item` / `wx:for-index` identifiers. Today's graph carries `wxForBindings` as a file-level name set with no per-binding declaration position; producing useful hover for these names requires a per-element scope graph and is deferred to Hover v2.
- Do not add hover for member chains past the root identifier (`{{user.name}}` hover on `name` returns `null`; only `user` resolves).
- Do not add hover for template names (`<template name="...">` and `<template is="...">`).
- Do not infer or display JavaScript types, method signatures, or jsdoc — Hover v1 has no JS type extractor.
- Do not unify hover and definition into a shared `resolveSymbolAt` resolver — v1 ships a parallel pipeline; unification is reserved for a later stage when a third consumer (quick-fix or rename) lands.
- Do not change the WXML grammar or query files.
- Do not move feature logic out of `server/wxml-language-service.mjs`.

## Current Baseline

- `server/wxml-lsp.mjs:707` declares only `definitionProvider: true` among navigation capabilities; no hover handler is registered.
- `server/wxml-language-service.mjs:961` defines `getDefinition({ graph, documentPath, position, extensionRoot })`, the existing 5-branch ordered resolver (event handler → expression ref → component tag → dependency → template).
- `shared/wxml-symbol-extractor.mjs:261` and `:270` push `wxs` symbols shaped `{ kind: "wxs", name, range }` where `range` covers the entire `<wxs>...</wxs>` element. No narrow range for the `module="X"` attribute value exists.
- `shared/wxml-symbol-extractor.mjs:299` pushes components shaped `{ tag, range }` where `range` is the **whole element range** (`rangeOf(node)` on the element node, not on the start tag or tag name). Hover hit-testing against this would over-trigger on children.
- `shared/wxml-symbol-extractor.mjs:12` already exposes `innerValueRange(quotedValueNode)`, used at line 220 to produce narrow event-handler `nameRange`s. Same helper applies to `module` attribute values. A separate narrow-tag-name range needs walking `firstChildOfType(startTag, "tag_name")` and reading its position.
- `fileModel.expressionRefs[]` entries carry `{ name, source: "interpolation", inTemplateDefinition, range, expressionRange, containingTag, containingAttribute }`; `range` is the narrow identifier range, suitable for hover hit-testing.
- `fileModel.eventHandlers[]` entries carry `{ handler, nameRange, dynamic, ... }` with narrow `nameRange`.
- `ownerConfig.script` provides `dataKeys[]`, `propertyKeys[]`, `methods[]`. `dataKeys` carry a `source` discriminator: `"data" | "setData" | "injector"`. `propertyKeys` carry `source: "property"`.
- `graph.version` is `1` (`scripts/extract-wxml-project-graph.mjs:265`). The `wxs.nameRange` extension below is additive (existing consumers ignore the new field), so v1 does **not** bump `graph.version`.

## Hover Targets

Hover v1 handles exactly four classes of cursor position. Anything else returns `null`.

| # | Cursor on | Resolved as | Kind label |
|---|---|---|---|
| 1 | `{{ident}}` / `{{ident.x}}` root `ident` | `script.dataKeys` (by `name`) then `script.propertyKeys` | `data` \| `setData` \| `injector` \| `property` |
| 2 | `bindtap="onTap"` (and other `bind*` / `catch*`) handler name | `script.methods` (by `name`) | `page method` \| `component method` |
| 3 | `<custom-tag>` element name | `graph.usingComponents` (by `owner` + `tag` + `resolved`) | `custom component` |
| 4 | `module="m"` value in `<wxs module="m" src="...">` or `<wxs module="m">...</wxs>`; and `m` in `{{m.fn()}}` | `fileModel.symbols` wxs entries by name (declaration side); for the interpolation side the expression-ref matcher already covers it | `wxs module` |

The kind label vocabulary is closed: exactly the 8 values listed above. No other labels are produced.

## Hover Content

Each hover returns an LSP `Hover` object:

```js
{
  contents: { kind: "markdown", value: "<two-line markdown>" },
  range: <narrow token range under the cursor>
}
```

### Two-line format

The markdown body is always:

```
**<name>** — `<kind label>`

<source-line>
```

with exactly one blank line between the title line and the source line. No third line, no link syntax, no code fence beyond the inline backticks shown.

### Source line per target

| Target | Source line |
|---|---|
| data / property / setData / injector | `Defined in <relative-path>:<line>` where `line` is the 1-based start line of the resolved `dataKey.nameRange` or `propertyKey.nameRange` |
| page / component method | `Defined in <relative-path>:<line>` where `line` is the 1-based start line of `method.nameRange` |
| custom component | `→ <relative-path>` of the `usingComponent.target` WXML file (no line — components point at file root) |
| wxs module | `→ <relative-path>` of the WXS dependency target if external (resolved via the matching `fileModel.dependencies[]` `wxs` entry by `module`); for inline `<wxs module="m">...</wxs>` the source line is `inline wxs module in this file` (no path) |

### Path formatting rules

- Paths are project-relative (relative to `graph.root`), use forward slashes, no `./` prefix.
- If the resolved location is outside `graph.root` (should not happen for v1 targets but defensive), return `null` — no hover rather than absolute-path leakage.
- Line numbers are 1-based and refer to the resolved name range start.

### Range field

The `range` returned alongside `contents` is the narrow token range under the cursor:

- For expression-ref hover: the `expressionRef.range` (already narrow).
- For event-handler hover: the `eventHandler.nameRange`.
- For component hover: the new narrow `component.tagNameRange` (see schema change below). The existing `component.range` is the whole element and is not suitable for hover hit-testing or range reporting.
- For wxs `module="m"` hover: the new `wxs.nameRange` (see schema change below).
- For wxs `m` inside `{{m.fn()}}`: covered by expression-ref path, range = `expressionRef.range`.

### Hover misses

The hover handler returns `null` (not an empty Hover, not "unknown symbol") in any of these cases:

- Cursor not inside any of the four target ranges.
- Cursor inside an expression-ref `range` but `inTemplateDefinition === true`.
- Cursor inside an event-handler `nameRange` but `dynamic === true`.
- Expression-ref name is not present in `dataKeys`, `propertyKeys`, or in-file wxs symbol names (the three lookups inside the AUTHORITATIVE expression-ref branch — see Resolver Pipeline step 2).
- Event-handler name is not present in `script.methods`.
- Component tag is not resolved through `usingComponents`, or `usingComponent.target` is missing.
- WXS `module="m"` has no matching `fileModel.dependencies[]` entry **and** no matching wxs symbol — i.e. the extractor produced nothing usable.
- Resolved location's relative path computation fails (target outside `graph.root`).

Hover never overlaps with diagnostics: missing-expression-ref / missing-handler already publish diagnostics, so the hover handler does not echo "unknown symbol" text.

## Resolver Pipeline

Hover gets its own resolver, parallel to `getDefinition`, ordered identically so the two stay behaviorally aligned:

```
getHover({ graph, documentPath, position, extensionRoot }):
  1. event handler match    → if cursor in eventHandlers[i].nameRange, AUTHORITATIVE
  2. expression ref match   → if cursor in expressionRefs[i].range, AUTHORITATIVE
       2a. look up dataKeys[]    by name → kind label per dataKey.source
       2b. else look up propertyKeys[] by name → kind label `property`
       2c. else look up symbols[] kind === "wxs" by name → kind label `wxs module`
       2d. else return null
  3. component tag match    → if cursor in components[i].tagNameRange
  4. wxs module decl match  → if cursor in symbols[i] where kind === "wxs" and nameRange contains position
```

"AUTHORITATIVE" matches the existing `getDefinition` semantics: a cursor inside a narrow nameRange/expression range that fails to resolve returns `null` and does not fall through to broader ranges. This prevents a hover on `bindtap="onTap"` from accidentally showing a custom-component card when `onTap` is unresolved.

Step 2c is what enables `{{format.price(x)}}` hover on `format` to resolve to a wxs module: the expression ref runs first (because it has the narrowest range), and we extend its lookup chain to also consider in-file wxs symbol names. This stays under the AUTHORITATIVE umbrella — if none of 2a/2b/2c match, the result is `null`, not a fall-through to step 4.

Note that `getDefinition` will need the parallel step 2c added later (a wxs interpolation reference should jump to the `<wxs>` declaration in the same file). That is out of scope for hover v1, captured in Open Questions.

No dependency or template branches: dependency hover (showing the `src` target on `<import src>` / `<include src>` / `<wxs src>` declarations) is intentionally out of scope for v1 — definition already covers those clicks.

## Graph Schema Changes

Two additive changes to `shared/wxml-symbol-extractor.mjs`. Both are additive (existing consumers ignore the new fields), so `graph.version` does **not** change. Absent fields on legacy graphs mean "narrow range not available, skip hover for this target."

### Change 1: `wxs.nameRange`

For `wxs_external` and `wxs_inline` branches that push `{ kind: "wxs", name, range }`, also attach `nameRange` covering the `module` attribute value characters (inside the quotes, excluding the quote chars themselves):

```js
symbols.push({
  kind: "wxs",
  name: moduleValue,
  range: rangeOf(node),
  nameRange: innerValueRange(<value-node-of-moduleAttr>),
});
```

The node-walking pattern matches the event-handler `nameRange` derivation at line 220. If `innerValueRange` cannot produce a range (no inner value node, malformed attribute), `nameRange` is omitted and hover on that wxs declaration returns `null`.

### Change 2: `components.tagNameRange`

For the existing component push at line 299, also attach `tagNameRange` covering the tag-name token of the start tag (or self-closing tag):

```js
components.push({
  tag: name,
  range: rangeOf(node),
  tagNameRange: rangeOf(tag_name_node),
});
```

`tag_name_node` is the same node already located by `firstChildOfType(tag, "tag_name")` at line 297 (whose `.text` is read to derive `name`); we just need its position. If for some reason the tag_name node is missing (defensive — shouldn't happen because we already gated on `name`), `tagNameRange` is omitted and the component branch returns `null`.

`range` is preserved so existing consumers (definition, diagnostics) remain unchanged.

## File-Level Changes

1. `shared/wxml-symbol-extractor.mjs` — add `nameRange` to both `wxs_external` and `wxs_inline` symbol pushes (reuse `innerValueRange`); add `tagNameRange` to the components push (reuse `rangeOf` on the existing `tag_name` node). ~15 lines total.
2. `server/wxml-language-service.mjs` — add `getHover({ graph, documentPath, position, extensionRoot })` next to `getDefinition`. New helper `formatHoverMarkdown({ name, kindLabel, sourcePath, line })` returning the two-line string. Reuse `findWxmlFileModel`, `findOwnerConfigWithScript`, `containsPosition`, `graphPathForAbsolute`. ~150 lines.
3. `server/wxml-lsp.mjs`:
   - Declare `hoverProvider: true` in capabilities (line ~707, next to `definitionProvider: true`).
   - Add `case "textDocument/hover":` in the request dispatch (next to `textDocument/definition`, line ~804). Delegate to `languageService.getHover(...)`, return `null` if no hit.
4. `scripts/verify-wxml-language-service.mjs` — add hover test cases, see Test Plan.
5. `scripts/verify-wasm-symbol-baselines.mjs` — extend with cases asserting `wxs` symbols carry `nameRange` and `components` entries carry `tagNameRange`, both with the expected narrow start/end. If the existing baseline fixture file would become noisy, add a new sibling verifier and wire it into `scripts/verify-tree-sitter.sh` next to the existing entries.

## Test Plan

There is no `package.json` script entry today (`package.json` has no `scripts` field). Verification runs via the umbrella shell script `bash scripts/verify-tree-sitter.sh` when `tree-sitter-cli` is usable on the local machine; otherwise individual node sub-verifiers are run directly (e.g. `node scripts/verify-wxml-language-service.mjs`). The new hover tests follow that convention.

### Symbol extractor cases (extend `scripts/verify-wasm-symbol-baselines.mjs`)

`scripts/verify-wxml-symbol-extractor.mjs` does not exist. The closest existing home for symbol-shape assertions is `scripts/verify-wasm-symbol-baselines.mjs`; new wxs / component nameRange checks should land there (or, if its fixture model would be polluted, in a new sibling file added to the same umbrella shell entry).

- **S-W1**: external `<wxs module="format" src="./fmt.wxs" />` produces a wxs symbol with `nameRange` covering the `format` chars inside the quotes (not the whole element, not including the quote chars).
- **S-W2**: inline `<wxs module="m">module.exports = {}</wxs>` produces a wxs symbol with `nameRange` covering the `m` chars.
- **S-W3**: malformed wxs without a `module` attribute produces no symbol (existing behavior preserved).
- **S-W4**: legacy graph without `nameRange` (simulated by removing the field) gracefully degrades — hover returns `null` for target #4 but everything else works.
- **S-C1**: `<local-card prop="x"></local-card>` produces a components entry with `tagNameRange` covering `local-card` in the start tag (not the whole element, not including `<` or `>`).
- **S-C2**: self-closing `<local-card />` produces a components entry with `tagNameRange` covering the tag name only.
- **S-C3**: legacy graph without `tagNameRange` gracefully degrades — hover returns `null` for target #3 but everything else works.

### Hover handler cases (`verify-wxml-language-service`)

- **H-1**: cursor on `theme` in `{{theme}}` where `theme` is in `data` → markdown `**theme** — \`data\`` / `Defined in pages/cart/cart.js:<line>`.
- **H-2**: cursor on `user` in `{{user}}` where `user` is a property → kind label `property`.
- **H-3**: cursor on `count` in `{{count}}` where `count` is touched only by `setData` → kind label `setData`.
- **H-4**: cursor on `loadingState` in `{{loadingState}}` where the key was contributed by a configured `dataInjectors` entry → kind label `injector`.
- **H-5**: cursor on `onTap` in `bindtap="onTap"` where the page defines `onTap()` → kind label `page method`.
- **H-6**: cursor on `onTap` in `bindtap="onTap"` where the owner config has `kind === "component"` → kind label `component method`. (`kind === "page"` produces `page method` per H-5; `kind === "app"` cannot own .wxml files and is filtered earlier at `scripts/extract-wxml-project-graph.mjs:439`.)
- **H-7**: cursor on `<local-card>` tag name → kind label `custom component`, source line `→ components/user-card/user-card.wxml`.
- **H-8**: cursor on `format` in `module="format"` of an external `<wxs>` → kind label `wxs module`, source line `→ utils/format.wxs`.
- **H-9**: cursor on `format` in `module="format"` of an inline `<wxs>` → kind label `wxs module`, source line `inline wxs module in this file`.
- **H-10**: cursor on `format` in `{{format.price(x)}}` where `format` matches an in-file wxs module name → kind label `wxs module`. Resolved via the expression-ref AUTHORITATIVE branch step 2c (dataKeys → propertyKeys → wxs symbols).
- **H-11**: cursor on `name` in `{{user.name}}` → `null` (member chain past root).
- **H-12**: cursor on `theme` inside a `<template name="...">` definition body → `null` (`inTemplateDefinition === true`).
- **H-13**: cursor inside `{{ {a: 1} }}` (object literal expression) → `null`. Rationale: `topLevelIdentifiers` skips object-literal expressions via `looksLikeObjectLiteralExpression`, so no expressionRef is produced and there is nothing to hover. (Function calls like `{{ computeKey() }}` are **not** skipped — the root `computeKey` becomes a regular expressionRef and hover resolves it through dataKeys/propertyKeys/wxs the same as any other ident.)
- **H-14**: cursor in whitespace inside `<view>` body → `null`.
- **H-15**: cursor inside `<import src="...">` declaration → `null` (dependency hover is out of scope; definition already covers it).
- **H-16**: cursor inside `<wxs>...</wxs>` body but **not** in `module="m"` value range → `null` (whole-element range does not trigger).
- **H-17**: cursor on `onTap` in `bindtap="{{dynamicHandler}}"` → `null` (dynamic event handler).
- **H-18**: cursor inside the children of `<local-card><view>hi</view></local-card>` on the `<view>` tag or its text → `null` (component hover restricted to `tagNameRange`, not whole-element).
- **H-19**: cursor on `local-card` in the closing tag `</local-card>` → `null` for v1 (`tagNameRange` covers the opening tag only — out of scope is fine; users almost always hover the opening tag).

### LSP integration cases (`verify-lsp-diagnostics` or new `verify-lsp-hover`)

- **L-H1**: server advertises `hoverProvider: true` in initialize response.
- **L-H2**: `textDocument/hover` returns the expected `Hover` object end-to-end for H-1.
- **L-H3**: `textDocument/hover` returns `null` for H-11.

## Acceptance Criteria

1. `bash scripts/verify-tree-sitter.sh` passes; or if `tree-sitter-cli` has EACCES, all node sub-verifiers (`verify-wasm-symbol-baselines`, `verify-js-method-baselines`, `verify-js-script-info`, `verify-wxml-language-service`, `verify-lsp-diagnostics`, …) pass individually.
2. New hover cases (S-W1–S-W4, S-C1–S-C3, H-1–H-19, L-H1–L-H3) all pass.
3. Manual dogfood in the chelaile workspace:
   - Hover on at least one `data`, one `property`, one `setData`-only, one `injector` ident produces the expected markdown.
   - Hover on at least one page-method and one component-method handler produces the expected markdown.
   - Hover on at least one custom component tag produces the expected markdown.
   - Hover on at least one external `<wxs module="...">` declaration produces the expected markdown.
   - Hover on `wx:for-item` returns nothing (verifying the deferral, not a regression).
4. `getDefinition` behavior is unchanged — no test in `verify-wxml-language-service` for definition regresses.
5. No new dependencies added. No grammar or query changes.

## Risks and Mitigations

- **Risk**: hover-on-attribute-name (e.g. cursor on `bindtap` itself, not the value) accidentally triggers attribute-value match.
  - **Mitigation**: `containsPosition(entry.nameRange, position)` against `nameRange` (the value range), not the whole-attribute range. nameRange does not cover the attribute name.

- **Risk**: `innerValueRange` returns `undefined` for an oddly-shaped wxs attribute and we crash.
  - **Mitigation**: omit `nameRange` when the helper returns nothing; hover handler treats missing `nameRange` as "no target" and returns `null`.

- **Risk**: project root path computation for a target outside `graph.root` leaks absolute paths.
  - **Mitigation**: explicit guard — relative path that escapes `graph.root` returns `null` instead of falling back to absolute.

- **Risk**: hover and definition resolvers drift over time.
  - **Mitigation**: both files live in the same module (`wxml-language-service.mjs`); when adding a new symbol kind the reviewer is expected to touch both. v2 unification (`resolveSymbolAt`) is captured as a follow-up.

## Open Questions

None blocking. Items intentionally left for v2:

- Per-element scope graph for `wx:for-item` / `wx:for-index` hover.
- Shared `resolveSymbolAt` resolver consumed by definition + hover + future quick-fix.
- Hover for member chains (`{{user.name}}` on `name`).
- Hover for template names.
- Type-aware hover (JS-side type extractor).
- `getDefinition` step 2c parity: a click on `format` in `{{format.price(x)}}` should jump to the in-file `<wxs module="format">` declaration. Add when v2 unification lands so hover and definition stay aligned.
