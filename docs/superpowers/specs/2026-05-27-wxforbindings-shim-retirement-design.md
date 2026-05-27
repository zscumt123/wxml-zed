# `wxForBindings` Compat Shim Retirement Design

## Goal

Remove the legacy `wxForBindings` flat compat shim from the symbol-extractor
output. As of v2-C it has **zero runtime consumers** (completion migrated to
`wxForScopes` + `activeWxForBindingsAt` in v2-B, diagnostics in v2-C); only the
verifier suite still reads it. This phase deletes the derivation, the loose-attr
accumulators that exist solely to feed it, the dead code path that populates
them, and the shim-specific test assertions — closing out the `wxForScopes`
migration that v2-A through v2-C performed.

## Non-Goals

- No change to `wxForScopes` or any other extractor output field. Hover,
  definition, completion, and diagnostics are untouched (they already consume
  `wxForScopes`).
- No grammar change. No new feature.
- Historical docs (specs/plans/spike-notes that mention `wxForBindings`) are
  records of past work and are left as-is.

## Current State (the cascade)

`wxForBindings` is referenced in:

- **`shared/wxml-symbol-extractor.mjs`** — the derivation itself:
  - `wxForBindings: (() => { ... })()` block (~lines 413-426) deriving
    `{ items, indexes, hasAnyWxFor }` from `wxForScopes` (explicit item/index
    names) unioned with the loose accumulators.
  - `wxForLooseItems` / `wxForLooseIndexes` Set declarations (~lines 148-149)
    plus their comment (~144-147).
  - The `else` branch (~lines 362-376) that `.add()`s into those accumulators —
    its own comment states it exists only "for the compat shim" and explicitly
    does **not** create a scope.
  - A comment at ~line 325 referencing the dynamic-leak quirk into
    `wxForBindings.items`.
- **`scripts/extract-wxml-symbols.mjs`** — passthrough only: destructured from
  `collectFile` (line 43) and re-emitted in the returned object (line 56).
- **`scripts/verify-wxml-narrow-ranges.mjs`** — five shim-reading sites:
  - `S-F5` (`testLooseAttrCompat`), `S-F6` (`testBareWxForCreatesScope`),
    `S-F7` (`testInterpolatedItemNameFallsBackToImplicit`), `S-F8`
    (`testBlockElementCreatesScope`) — each asserts on `wxForScopes` (the real
    behavior) **and** has a few trailing `file.wxForBindings` assertions.
  - `W-7` (`testCompatShimByteEqual`) + the `W7_FROZEN_WX_FOR_BINDINGS` map — a
    byte-equal invariant over the derived shim across all baselines.
- **8 wasm baselines** (`fixtures/wasm-spike/*-symbols-baseline.json`) — every
  fileModel snapshot embeds a `wxForBindings` object.
- **`server/wxml-language-service.mjs:854`** and
  **`scripts/verify-wxml-language-service.mjs:2032`** — comments only (accurate
  history; no code reads the field).

## Design

### 1. Extractor — delete derivation + dead feeders

In `shared/wxml-symbol-extractor.mjs`:
- Delete the `wxForBindings: (() => { ... })()` block from the returned object,
  so the output object ends after `wxForScopes`.
- Delete the `wxForLooseItems` / `wxForLooseIndexes` declarations and their
  leading comment.
- Delete the `else` branch that feeds those accumulators (the `if
  (elementHasWxFor) { ...create scope... }` keeps its body; the `else { ... }`
  is removed entirely). An element carrying `wx:for-item`/`wx:for-index` without
  a `wx:for` now simply produces no scope and no binding — which is the correct
  WeChat semantic; the `else` only ever existed to preserve the shim quirk.
- Remove (or de-shim) the line ~325 comment that talks about leaking `{{dyn}}`
  into `wxForBindings.items`; keep any part that still describes `wxForScopes`
  behavior.

Result: extractor output drops the `wxForBindings` key; `wxForScopes` and all
other fields are byte-identical to before.

### 2. CLI passthrough

In `scripts/extract-wxml-symbols.mjs`: remove `wxForBindings` from the
destructuring on line 43 and from the returned object on line 56.

### 3. Regenerate the 8 wasm baselines

The baselines are extractor-output snapshots; with the field gone from the
extractor, each must be regenerated so it no longer contains `wxForBindings`.
This is mechanical (re-run the extractor, overwrite the baseline), and
`verify-wasm-symbol-baselines.mjs` then diffs clean. The baselines change ONLY
by the removal of the `wxForBindings` object in each fileModel — no other field
moves.

### 4. narrow-ranges tests — convert four, delete W-7

In `scripts/verify-wxml-narrow-ranges.mjs`:
- **Convert S-F5/S-F6/S-F7/S-F8**: remove the trailing `const bindings =
  file.wxForBindings; assert(...)` lines from each, keeping every `wxForScopes`
  assertion (which is the real point of each test). Specifically:
  - **S-F5** keeps `scopes.length === 0` (loose `wx:for-item` without `wx:for`
    creates no scope); drop the four shim assertions. (The legacy "loose name
    leaks into the shim" behavior is intentionally gone with the shim — there is
    nothing left to assert.) Update the test's wording so it reads as "loose
    attr creates no scope" rather than "compat".
  - **S-F6** keeps the bare-`wx:for` implicit-defaults scope assertions; drop the
    `hasAnyWxFor` shim check (redundant — `scopes.length === 1` already proves a
    loop exists).
  - **S-F7** keeps the dynamic-`wx:for-item="{{dyn}}"` → implicit fallback scope
    assertions (`itemName === "item"`, `itemSource === "implicit"`,
    `itemNameRange === null`); drop the two shim "does not contain dyn" checks
    (already implied by the scope assertion).
  - **S-F8** keeps the `<block wx:for>` scope assertions (`itemName === "row"`,
    `ownerTag === "block"`, `wxForRange` present); drop the two shim checks.
- **Delete W-7**: remove `testCompatShimByteEqual`, the `W7_FROZEN_WX_FOR_BINDINGS`
  map, its regeneration-instruction comment block, and its entry in the `CASES`
  array. `CASES` count goes 21 → 20.

### 5. Comments

The two comment-only references (`server/wxml-language-service.mjs:854`,
`scripts/verify-wxml-language-service.mjs:2032`) accurately describe history and
may be left untouched; optionally tidy the phrasing to past tense. No code there
reads the field.

### 6. Schema-version safety check

Confirm no consumer gates on a graph schema/`graph.version` that would break when
a field disappears (the field removal only drops data nothing reads, and graphs
are rebuilt in-memory each session — but verify there is no persisted-cache
version assertion). If a version constant exists and is meant to track output
shape, decide explicitly whether to bump it; default expectation is no bump
needed (removal of an unread field is backward-safe for all current consumers).

## Testing

### Normalized pre/post baseline diff (the load-bearing guard)

`verify-wasm-symbol-baselines.mjs` alone CANNOT prove "only `wxForBindings` was
removed": once the baselines are regenerated, it merely confirms the new
extractor equals the new baseline — it cannot catch incidental drift in some
other field that rode along. So before regenerating, capture the originals and do
an explicit normalized comparison:

1. **Before any code change**, snapshot the baselines:
   `cp fixtures/wasm-spike/*-symbols-baseline.json "$TMPDIR/wxforbindings-before/"`
   (create the dir first).
2. After the extractor change + baseline regen, run a one-shot script that, for
   each baseline file, loads BOTH the `$TMPDIR/wxforbindings-before/` copy and the
   regenerated repo copy, **recursively deletes every `wxForBindings` key** from
   both trees, and asserts the normalized trees are `deepEqual`.
3. **Expected: exact equality for all 8 baselines.** Any inequality means a field
   other than `wxForBindings` drifted — STOP and investigate before committing.

As a human cross-check, `git diff fixtures/wasm-spike` should show ONLY removed
`wxForBindings` objects (and the surrounding comma/brace adjustments) — no
additions or changes to any other field. This normalized deepEqual is what
actually enforces Acceptance Criterion 1; it is a one-time implementation-phase
check (a throwaway `$TMPDIR` script), not a committed verifier.

### Suite verification

- `node scripts/verify-wxml-narrow-ranges.mjs` → 20 passed, 0 failed (was 21;
  W-7 removed; S-F5..F8 converted and still green on their `wxForScopes`
  assertions).
- `node scripts/verify-wasm-symbol-baselines.mjs` → all 8 match (regenerated
  baselines, field absent).
- `node scripts/verify-wxml-language-service.mjs` → exit 0 (hover/definition/
  completion/diagnostics + B + E series unaffected — none read the shim).
- `node scripts/verify-lsp-diagnostics.mjs --suite=graph-smoke` → exit 0.
- `bash scripts/verify-tree-sitter.sh` umbrella → green (sandbox-disable needed
  for the tree-sitter-cli spawn, environment constraint).
- Grep proof: `grep -rn "wxForBindings" server/ shared/ scripts/` returns only
  comment references (no code reads/writes the field) after the change.

## Acceptance Criteria

1. The extractor output no longer contains a `wxForBindings` key; `wxForScopes`
   and all other fields are byte-identical to before for every fixture —
   **enforced by the normalized pre/post deepEqual** (Testing §1), not merely by
   the regenerate-then-verify cycle.
2. The loose accumulators and the dead `else` feeder branch are removed; an
   element with `wx:for-item`/`-index` but no `wx:for` produces no scope (S-F5
   still green) and contributes no binding anywhere.
3. The CLI extractor (`extract-wxml-symbols.mjs`) no longer emits the field.
4. All 8 wasm baselines are regenerated and verify clean with the field absent.
5. S-F5/S-F6/S-F7/S-F8 retain their `wxForScopes` assertions and pass; W-7 and
   its frozen map are deleted; narrow-ranges is 20/20.
6. The full verifier suite (narrow-ranges, wasm, language-service, graph-smoke,
   umbrella) is green.
7. No runtime code references `wxForBindings` (only historical comments/docs
   remain).
