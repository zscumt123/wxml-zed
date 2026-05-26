# WXML wx:for Definition Parity (A) + Declaration-Side Hover (D) Design

## Goal

Wire the existing per-element `wxForScopes[]` resolver to two more interaction
points:

- **A — getDefinition step 2a parity.** cmd-click on `{{item}}` / `{{item.name}}`
  resolves the loop binding (same as hover already does) and now returns a
  `Location` pointing at the declaration.
- **D — declaration-side hover.** Hovering the name inside `wx:for-item="foo"` /
  `wx:for-index="idx"` renders the same hover card the use-site already produces.

This is **surface work**, not model work. `wxForScopes[]` already exists and
hover (step 2a) already proved the per-element scope resolver runs correctly,
including `<block wx:for>` (commit `ebd5ffa`). A and D add two more outputs from
the same resolver. Completion and diagnostics are **unchanged** — they stay on
the flat `wxForBindings` compat shim until the dogfood-gated v2-B / v2-C phases.

## Non-Goals

- Do not change `getCompletions` behavior. Still suggests wx:for names file-wide
  via the shim. (v2-B.)
- Do not change `getDiagnostics` behavior. Still accepts any wx:for name anywhere
  as in-scope for `missing-expression-ref`. (v2-C.)
- Do not build definition-from-declaration (jumping a `wx:for-item="foo"`
  declaration to itself). No useful target.
- Do not change declaration-side hover for default `item` / `index` — there is no
  declaration text to put a cursor on.
- Do not change WXML grammar / query files.
- Do not bump `graph.version` — the one schema addition is additive.
- Release hardening (README / extension.toml / final verification) is a separate
  later step, not part of this spec.

## Current Baseline

`shared/wxml-symbol-extractor.mjs` builds `wxForScopes[]`, one entry per element
carrying `wx:for`:

```js
{
  scopeRange,        // element span the binding is visible in
  wxForRange,        // rangeOf(wxForAttr) — the WHOLE `wx:for="{{users}}"`
                     // attribute (name + value), not just the value. Used for
                     // self-exclusion: an identifier inside this range (which
                     // includes the iterable `{{users}}`) does not bind to this
                     // loop's own var.
  itemName, itemNameRange, itemSource,   // itemSource: "explicit" | "implicit"
  indexName, indexNameRange, indexSource, // indexSource: "explicit" | "implicit"
  ownerTag,          // tag name, or null on grammar error-recovery
}
```

`itemNameRange` / `indexNameRange` are non-null only when the corresponding
source is `"explicit"` (an actual `wx:for-item=`/`wx:for-index=` value); for
`"implicit"` they are `null` and `itemName`/`indexName` default to
`"item"`/`"index"`.

`server/wxml-hover.mjs` consumes it: `findMatchingWxForBinding(scopes, position,
name)` reverse-scans (innermost-first) returning the first scope whose
`scopeRange` contains the position, whose `wxForRange` does **not**, and whose
`itemName`/`indexName` equals `name`. `makeWxForHover(scope, kind, refRange)`
renders the card.

`getDefinition` in `server/wxml-language-service.mjs` has **no** wx:for branch —
this is the asymmetry A closes. (Hover *resolves and explains* a loop binding;
definition currently produces no `Location` for that same resolution.)

## Schema Change (additive)

Add one field to each `wxForScopes[]` entry in `shared/wxml-symbol-extractor.mjs`:

```js
// rangeOf(firstChildOfType(wxForAttr, "attribute_name")) — the `wx:for`
// name token ONLY. Must NOT be rangeOf(wxForAttr): that is the whole
// attribute (already stored as wxForRange), and would make default
// definition jump to the entire `wx:for="{{...}}"` span.
wxForKeywordRange,
```

This is the definition target for **default** `item` / `index`, which have no
explicit name attribute to point at. Pointing at the `wx:for` attribute name (not
the tag name, not the whole attribute) is semantically correct: the `wx:for`
attribute is *the reason* default `item`/`index` are introduced. The extraction
must use the `attribute_name` child node (the same `firstChildOfType(attr,
"attribute_name")` pattern used elsewhere in the extractor at lines 83/93/177/210),
producing a narrow range over the literal text `wx:for`. Same additive pattern as
`wxs.nameRange` and `components.tagNameRange` — no `graph.version` bump.

`scripts/extract-wxml-symbols.mjs` needs no change for this: `wxForKeywordRange`
is nested inside existing `wxForScopes[]` entries (nested additions ride through;
only new *top-level* fields need the destructure/return update — as `wxForScopes`
itself did).

## Module Structure (resolver extraction)

`findMatchingWxForBinding` currently lives in `server/wxml-hover.mjs`. A needs the
**same** resolver from `getDefinition` in `server/wxml-language-service.mjs`. But
the module graph is **already circular**: `wxml-hover.mjs` imports helpers from
`wxml-language-service.mjs`, which re-exports `getHover` from `wxml-hover.mjs`
(`server/wxml-language-service.mjs:965`). It survives only by a documented TDZ
rule (no imported helper called at module top level — hover header comment). Adding
a reverse import of a hover helper into language-service would tighten that cycle.

To avoid deepening the footgun, extract the **pure** position→scope resolvers into
a new leaf module `server/wxml-for-scope.mjs` with **no** back-imports from either
consumer:

- `findMatchingWxForBinding(scopes, position, name)` — moved verbatim from hover
  (used by hover step 2a and definition A).
- `findWxForDeclarationAtPosition(scopes, position)` — **new**, returns
  `{ scope, kind: "item" | "index" }` or `null` when `position` falls inside a
  scope's `itemNameRange` / `indexNameRange` (used by D).

These are pure functions over `wxForScopes[]` + `position` (they need only
`containsPosition`, which also moves or is duplicated as a tiny local — it has no
other dependencies). `makeWxForHover` and `HOVER_KIND_LABELS` **stay** in
`wxml-hover.mjs` (card rendering is hover-specific). Both `wxml-hover.mjs` and
`wxml-language-service.mjs` import the resolvers from `wxml-for-scope.mjs`. This
removes a hover↔language-service edge rather than adding one.

## A — getDefinition step 2a

Add a wx:for branch to `getDefinition`, placed where hover step 2a sits —
**before** the component / wxs fall-through branches, mirroring hover's matcher
order. It calls `findMatchingWxForBinding` (now from `wxml-for-scope.mjs`). On a
match, select the target range from the matched scope by **which binding matched**
(item vs index) and **its source**, then return a single `Location` in the **same
file**:

| Resolved binding                                    | Target range        |
| --------------------------------------------------- | ------------------- |
| `item` binding, `itemSource === "explicit"`         | `itemNameRange`     |
| `index` binding, `indexSource === "explicit"`       | `indexNameRange`    |
| `item` binding, `itemSource === "implicit"`         | `wxForKeywordRange` |
| `index` binding, `indexSource === "implicit"`       | `wxForKeywordRange` |

Semantics inherited from the shared resolver (already proven by hover W-1..W-10):

- **Shadowing (W-8):** when a data key and a wx:for binding share a name, wx:for
  wins — definition resolves to the loop declaration, not the data declaration.
- **Nested (innermost-wins):** reverse-scan returns the innermost matching scope.
- **Self-exclusion:** an identifier inside the loop's own iterable expression
  (`{{users}}` in `wx:for="{{users}}"`) does not bind to that loop's var.
- **Outside-loop miss:** an identifier with no containing scope returns no wx:for
  `Location` — and (per the matcher) falls through to the remaining definition
  branches, exactly as hover falls through. It is **not** an authoritative null.

## D — declaration-side hover

Add a hover branch driven by `findWxForDeclarationAtPosition(scopes, position)`
(from `wxml-for-scope.mjs`): when it returns `{ scope, kind }` — i.e. the cursor
is inside an explicit `itemNameRange` / `indexNameRange` — render the same card via
`makeWxForHover(scope, kind, range)`
(`**foo** — \`wx:for-item\`` / `Declared on <view> at line N`, or
`Declared in wx:for at line N` when `ownerTag` is null).

- Triggers **only** on the name attribute values (`wx:for-item=` / `wx:for-index=`).
- Hovering the `wx:for="{{users}}"` value resolves `users` through the **existing**
  expression-ref hover (it's a data key) — unchanged, no collision, because an
  attribute-value name range is not an interpolation range.
- Default item/index: no declaration text → branch does not fire.

Placement: a new branch in the hover pipeline. It cannot collide with branch 2
(expression-ref) for the reason above.

## Testing

New cases in `scripts/verify-wxml-language-service.mjs` (the flat `assertX(graph)`
runner, not a SCENARIOS array):

- **Definition (A):** explicit-item, explicit-index, default-item, default-index,
  nested-shadow (innermost wins), data-vs-wxfor-shadow (wx:for wins), outside-loop
  (no wx:for Location). Assert the returned `Location.range` equals the expected
  declaration range.
- **Declaration hover (D):** cursor on `wx:for-item="foo"` value → item card;
  cursor on `wx:for-index="idx"` value → index card; cursor on `wx:for="{{users}}"`
  value → resolves `users` as data (not a wx:for card).

One host-wire test in `scripts/verify-lsp-diagnostics.mjs` (mirroring L-W1): drive
`textDocument/definition` on `{{item}}` through the real LSP path and assert the
`Location` comes back. Add to both the `scenarios` array and the
`SCENARIO_SUITES["graph-smoke"]` set; update the graph-smoke count.

Fixtures: reuse `fixtures/miniprogram/pages/loops/loops.wxml` (already has default
/ explicit / nested / `<block wx:for>` shapes). Extend only if a target range case
is missing.

**Resolver-move guard:** `findMatchingWxForBinding` moves from `wxml-hover.mjs` to
`wxml-for-scope.mjs` verbatim. The existing hover wx:for cases (W-1..W-10 in
`verify-wxml-language-service.mjs`, L-W1 in `verify-lsp-diagnostics.mjs`) must stay
green unchanged — that proves the extraction is behavior-preserving for hover.

**Invariant guard (zero-behavior-change for completion/diagnostics):** A and D add
no wx:for completion or diagnostic case. The existing W-7 byte-equal snapshot and
the graph-smoke completion/diagnostic scenarios already lock this; confirm they
stay green and unchanged.

Additive-schema guard: the 8 wasm symbol baselines
(`scripts/verify-wasm-symbol-baselines.mjs`) regenerate to include
`wxForKeywordRange` on each scope; regenerate and re-commit them. Narrow-range
verifier (`scripts/verify-wxml-narrow-ranges.mjs`) gains a case asserting
`wxForKeywordRange` covers exactly the `wx:for` attribute-name token.

## Acceptance Criteria

1. cmd-click on `{{foo}}` (explicit) jumps to the `wx:for-item="foo"` value range.
2. cmd-click on `{{idx}}` (explicit) jumps to the `wx:for-index="idx"` value range.
3. cmd-click on `{{item}}` / `{{index}}` (implicit) jumps to the `wx:for`
   attribute-name token (`wxForKeywordRange`), not the whole attribute or tag.
4. cmd-click resolves nested/shadowing per hover semantics (innermost wins;
   wx:for beats data of the same name).
5. cmd-click on an identifier outside any loop produces no wx:for Location and
   falls through to the remaining definition branches.
6. Hover on `wx:for-item="foo"` / `wx:for-index="idx"` value renders the loop card.
7. Hover on `wx:for="{{users}}"` value still resolves `users` as data.
8. Completion and diagnostics outputs are byte-equal to pre-change (verified by
   W-7 + graph-smoke staying green with no new wx:for cases).
9. All offline verifiers green; `graph.version` unchanged.
