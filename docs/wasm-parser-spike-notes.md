# WASM Parser ABI Spike — Notes

Step 1 of the broader plan to replace runtime `npx tree-sitter-cli parse --cst` with an in-process WASM parser. Plan: `docs/superpowers/plans/2026-05-16-wasm-parser-abi-spike.md`.

## Version Pair Chosen

- `tree-sitter-cli`: **0.25.10** (highest 0.25.x patch as of 2026-05-16)
- `web-tree-sitter`: **0.25.10** (highest 0.25.x patch as of 2026-05-16, pinned in root `package.json`)

**Rationale:** `grammar/tree-sitter-wxml/package.json` declares `tree-sitter-cli ^0.25.8` as its devDependency. Matching the grammar's tested minor avoids unknown ABI drift. Patches happen to align exactly between the two packages, which is convenient but not required.

**Queries used:**

```bash
npm view tree-sitter-cli@0.25 version --json
npm view web-tree-sitter@0.25 version --json
```

Both returned `["0.25.0", ..., "0.25.10"]`.

## Build Outcome

**Path taken:** Local Emscripten, NOT `--docker`.

The plan defaulted to `tree-sitter build --wasm --docker`, but on this machine Docker Hub was unreachable (`net/http: TLS handshake timeout` pulling `emscripten/emsdk:4.0.4`, then a follow-up `docker pull` produced zero bytes for 5+ minutes). Fell back to installing Emscripten via Homebrew:

```bash
brew install emscripten   # installs 5.0.7 plus deps (openjdk, libtiff, etc.) — ~916MB cellar
export EM_CACHE="$TMPDIR/em-cache"  # the brew-installed emcc cannot write inside its cellar; must override cache dir
cd grammar/tree-sitter-wxml
npx -y tree-sitter-cli@0.25.10 build --wasm   # no --docker
```

**Artifact:** `grammar/tree-sitter-wxml/tree-sitter-wxml.wasm`, 31KB, valid WASM magic (`0061 736d`).

For future re-builds: the `EM_CACHE` override is required. Without it, brew-installed Emscripten errors with `Operation not permitted: '/opt/homebrew/Cellar/emscripten/.../libexec/cache'`. A persistent solution would be exporting `EM_CACHE` in shell rc, or fixing the Docker Hub path with a registry mirror so `--docker` works.

### Plan deviation: grammar/.gitignore tweak

The plan's "7 files committed" list became 8 files. The vendored grammar's own `.gitignore` (`grammar/tree-sitter-wxml/.gitignore:42`) excludes `*.wasm` as a build volatile — inherited from the upstream tree-sitter grammar template. For wxml-zed we want this specific wasm tracked as a distributable artifact, so a negation was added: `!tree-sitter-wxml.wasm`. This was not anticipated in the plan; the deviation is intentional and minimal (one targeted exception, not a removal of the volatile ignore).

## Smoke Run Report

```bash
node scripts/verify-wasm-parser.mjs
```

```json
{
  "moduleExports": [
    "CaptureQuantifier",
    "LANGUAGE_VERSION",
    "Language",
    "LookaheadIterator",
    "MIN_COMPATIBLE_VERSION",
    "Node",
    "Parser",
    "Query",
    "Tree",
    "TreeCursor"
  ],
  "languageKeys": ["0", "types", "fields"],
  "abiOnLanguage": { "name": "abiVersion", "value": 15 },
  "runtimeAbi": { "name": "LANGUAGE_VERSION", "value": 15 },
  "minCompat": { "name": "MIN_COMPATIBLE_VERSION", "value": 13 },
  "rootType": "document",
  "rootNamedChildCount": 5,
  "rootHasError": false,
  "sourceBytes": 572
}
```

Exit code 0.

## ABI Surface Discovered (for the future extractor rewrite)

- **Field name on `Language`:** `abiVersion` (not `version`, not `languageVersion`)
- **Package-level exports:** `LANGUAGE_VERSION` and `MIN_COMPATIBLE_VERSION` are direct named exports of `web-tree-sitter`
- **API surface:** ESM named exports work (`import { Parser, Language } from "web-tree-sitter"`). The defensive `import * as` fallback in the smoke script was unnecessary on this version but is kept for robustness.
- **WXML grammar root node:** `document` (5 named children for the home.wxml fixture)
- **`Language` enumerable keys:** `["0", "types", "fields"]` — the language object exposes very few enumerable own keys; `abiVersion` is a getter, not own-enumerable. The smoke's `pickNumeric` works because it accesses by property name, not by enumerating.

## Rejected Pairs

None. 0.25.10 ↔ 0.25.10 produced ABI 15 on both sides, within the runtime's `[13, 15]` compat range. No escalation to 0.26.x needed.

## Verdict

Step 1 of the WASM spike passed; extractor rewrite is unblocked.

Future tasks can confidently:
- Import `Parser` and `Language` from `web-tree-sitter`
- Call `await Parser.init()` once per process
- Call `await Language.load(WASM_PATH)` once per parser
- Use `language.abiVersion` to record what wasm was loaded
- Traverse `tree.rootNode` (type `document`) with `.namedChildren`, `.descendantsOfType()`, `.walk()` instead of parsing CLI CST text

## Step 2 Outcome (POC)

POC at `scripts/poc-wasm-symbols.mjs` reproduces the legacy `extract-wxml-symbols.mjs` output for `fixtures/miniprogram/pages/home/home.wxml`. Verified against the frozen baseline at `fixtures/wasm-spike/home-symbols-baseline.json` via `scripts/diff-symbols-baseline.mjs`.

**Result:** clean on first run. POC output (3147 bytes) is **byte-identical** to the legacy baseline (3147 bytes), not just structurally equivalent. No iteration was needed.

**Verified node-kind paths on home.wxml:**
- `import_statement` → dependencies[].kind=import (1 occurrence, row 0)
- `include_statement` → dependencies[].kind=include (1 occurrence, row 1)
- `wxs_external` (with `wxs_module_attribute` + `wxs_src_attribute`) → dependencies[].kind=wxs + symbols[].kind=wxs (1 occurrence, row 2)
- `template_usage` with static `template_is_attribute` → references[].kind=template, dynamic=false (2 occurrences, rows 5 and 21)
- `element` with hyphenated `tag_name` (filtering reserved tags) → components[] (3 occurrences: rows 7, 14, 15)

**Implemented but unverified on this fixture (will be exercised in step 3 with broader fixtures):**
- `template_definition` → symbols[].kind=template (home.wxml has none; common.wxml does — node type confirmed via separate inspection)
- `template_usage` with dynamic `is="{{expr}}"` → references[].dynamic=true (home.wxml has none)

**Anomalies observed during iteration:** none. First run was both structurally and byte-equivalent. Source ordering and field shapes matched on first attempt because the legacy extractor uses the same source-position ordering and the same `path.relative` semantics.

**Useful WXML grammar shape facts captured for downstream extractor work:**
- `<import src="...">` and `<include src="...">` parse to top-level `import_statement` / `include_statement` named children of `document`, **not** to `element` nodes.
- `<wxs module="..." src="...">` parses to top-level `wxs_external` wrapping `wxs_external_self_closing_tag`; the module/src attributes have specialized node types (`wxs_module_attribute`, `wxs_src_attribute`).
- `<template name="...">...</template>` parses to top-level `template_definition` with `template_definition_start_tag` + `template_end_tag`.
- `<template is="...">` parses to top-level `template_usage` (with `_self_closing_tag` or `_start_tag` child); the `is` attribute has specialized type `template_is_attribute`.
- Regular elements parse to `element` wrapping `start_tag` + `end_tag`, or `element` wrapping `self_closing_tag`. The `tag_name` is a named child of whichever tag form is present.
- Interpolation in attribute values appears as a named child of `quoted_attribute_value` with type `interpolation`. The POC uses this to distinguish dynamic vs static `template is="..."`.

Step 2 of the WASM spike passed; broader fixture compare (step 3) is unblocked.

## Step 3 Outcome (Fixture Sweep)

POC at `scripts/poc-wasm-symbols.mjs` now accepts N file args and matches the legacy extractor's combined output for all 11 fixtures in `fixtures/miniprogram/`. Verified via `scripts/diff-symbols-baseline.mjs` against `fixtures/wasm-spike/miniprogram-symbols-baseline.json`.

**Result:** byte-identical (6720 bytes both sides) on first run, idempotent across re-runs. Zero iterations needed.

**Newly verified paths (vs step 2):**
- `template_definition` → symbols[].kind=template (exercised by `templates/common.wxml` → `loadingRow`, `templates/secondary.wxml` → `secondaryRow`, `templates/unrelated.wxml` → `loadingRow`)
- Multi-file output: `files: [...]` preserves arg order across 11 entries
- Diff harness now reports diffs with file path (`$.files[<path>].…`); not exercised because there were no diffs to report

**Per-fixture counts captured during sanity check:**

| File | deps | syms | refs | comps |
|---|---|---|---|---|
| components/global-badge/global-badge.wxml | 0 | 0 | 0 | 0 |
| components/local-badge/local-badge.wxml | 0 | 0 | 0 | 0 |
| components/status-badge/status-badge.wxml | 0 | 0 | 0 | 0 |
| components/user-card/user-card.wxml | 0 | 0 | 0 | 1 |
| packages/shop/pages/list/list.wxml | 0 | 0 | 0 | 1 |
| pages/detail/detail.wxml | 1 | 0 | 0 | 0 |
| pages/home/home.wxml | 3 | 1 | 2 | 3 |
| shared/header.wxml | 0 | 0 | 0 | 0 |
| templates/common.wxml | 0 | 1 | 0 | 0 |
| templates/secondary.wxml | 0 | 1 | 0 | 0 |
| templates/unrelated.wxml | 0 | 1 | 0 | 0 |

**Still unverified after step 3:**
- Dynamic `<template is="{{expr}}">` → no fixture exercises this. Implementation is in place but unproven. Synthetic fixture needed in a focused later step if the path proves load-bearing.
- UTF-16 vs byte column units → no non-ASCII fixture. Same situation; defer to a synthetic fixture step.

**Anomalies / iterations during Task 4:** none — clean on first run.

**Operational gotcha hit during baseline generation (not a POC issue):**
- Legacy extractor calls `npx tree-sitter-cli parse` without a version pin. On a cold npm cache, npx re-resolves and re-fetches metadata per invocation; for 11 files this took ~40 min before being killed.
- Workaround: `npm install --no-save tree-sitter-cli@0.26.8` into the root `node_modules` so npx finds a local install and resolves instantly. Wall time dropped to 22s.
- 0.25.10 (the version we used for wasm build) is NOT API-compatible here — the legacy extractor uses `--grammar-path` which 0.25.10 doesn't accept ("unexpected argument"). Had to pin 0.26.8 for the legacy path specifically. This drift between "version we built wasm with" and "version the legacy extractor uses" is fine because they're independent paths; only the wasm ABI matters for the POC, and 0.25.10's wasm loads correctly under `web-tree-sitter@0.25.10`.

Step 3 of the WASM spike passed; extractor replacement (step 4) is unblocked.

## Pre-Step-4 Alignment Pass

Step 3 verified equivalence within `fixtures/miniprogram` but a review surfaced **5 silent semantic deltas** between POC and legacy that the miniprogram fixtures didn't exercise. Fixed in this alignment commit (no behavior change against the existing step-2/step-3 baselines — those remained byte-identical — but POC is now safe to substitute for the legacy extractor):

1. **Dynamic template detection.** Legacy uses `value.includes("{{")` on the raw attribute value. POC was walking the syntax tree for an `interpolation` child node. The string-based check is now used (matches legacy exactly, even on pathological inputs).
2. **`references[].name` on dynamic refs.** Legacy only sets `entry.name` when `!dynamic`. POC was setting it unconditionally. Fixed.
3. **`dependencies[].normalized` gates.** Legacy only computes `normalized` when the src starts with `./` or `../` AND does not contain `{{`. POC was computing it for any src. Fixed.
4. **Base path for `normalized`.** Legacy uses `ROOT` (script's repo-root, derived from `import.meta.url`) and explicit `path.posix.*` operations. POC was using `process.cwd()` and native `path.*`. Fixed — POC now matches legacy regardless of cwd or platform.
5. **`BUILTIN_TAGS` filter on components.** Legacy excludes both control tags AND the WeChat mini-program built-in tags (`shared/wxml-builtins.mjs`: page-meta, navigation-bar, scroll-view, swiper-item, etc., 50+ tags). POC was only excluding control tags, so it was emitting `page-meta`, `navigation-bar`, `scroll-view` etc. as fake "components". Fixed by importing `BUILTIN_TAGS` from `shared/wxml-builtins.mjs`.

Plus one POC bug that was orthogonal to the GPT findings but surfaced when widening the fixture set:

6. **`wxs_inline` block handling.** Legacy emits a `symbols[].kind=wxs` entry for inline `<wxs module="X">...</wxs>` blocks (node type `wxs_inline` in the wasm parse tree, distinct from `wxs_external`). POC only handled `wxs_external`. Added a `wxs_inline` branch that emits the symbol only — no dependency, since there's no `src`.

### Verification matrix (after fix)

| Fixture set | Files | Legacy size | POC size | Byte-identical | Structural equivalent |
|---|---|---|---|---|---|
| `home.wxml` (step 2) | 1 | 3147 | 3147 | ✅ | ✅ |
| `fixtures/miniprogram/` (step 3) | 11 | 6720 | 6720 | ✅ | ✅ |
| `fixtures/test.wxml` (new) | 1 | 3401 | 3401 | ✅ | ✅ |
| `fixtures/real-world/` (new, 3 of 4 — `edge-recovery.wxml` excluded; legacy errors on it too) | 3 | 5805 | 5805 | ✅ | ✅ |

**Newly verified paths (vs step 3):**
- Dynamic `<template is="{{expr}}">` → `references[].dynamic=true` with no `name` field (test.wxml has 1, real-world fixtures have 2 more)
- `wxs_inline` blocks → `symbols[].kind=wxs` (test.wxml has 1)
- Component filter correctly skips WeChat built-ins like `scroll-view`, `page-meta`, `navigation-bar`
- `normalized` correctly skipped on absolute paths, non-relative paths, and dynamic `{{...}}` paths

**Still unverified:**
- UTF-16 vs byte column units — no non-ASCII fixture in repo. Synthetic fixture needed if/when it proves load-bearing.

Step 4 (replacing `scripts/extract-wxml-symbols.mjs` internals) is now genuinely unblocked.

### Alignment Pass 2 — cwd-independence and files[] ordering

The first alignment pass fixed `dependencies[].normalized`'s base path but missed two more places where POC still diverged from legacy:

7. **`files[].path` was cwd-relative**, not repo-root-relative. Legacy uses `relativePath(filePath)` (repo-root + POSIX). POC was using `path.relative(process.cwd(), inputAbs)`. Empirical confirmation: running `node ../scripts/poc-wasm-symbols.mjs ../fixtures/test.wxml` from `grammar/` produced `files[].path = "../fixtures/test.wxml"` while legacy produced `"fixtures/test.wxml"`. Fixed by routing through the existing `relativePathFromRoot` helper that was already used for `normalized`.
8. **`files[]` was emitted in argv order, not sorted by path.** Legacy line 312 does `model.files.sort((a, b) => a.path.localeCompare(b.path))` as the last step. POC was preserving argv order. Currently invisible in tests because every call site pipes `find … | sort | xargs`, but a behavioral divergence the moment any caller hands files in a different order. Fixed.

**Verification after pass 2:**
- All 4 baselines still byte-identical to legacy (no regression — the existing baselines were generated from repo root with sorted args, so the bugs didn't manifest in them either)
- Run from `grammar/` cwd: output now identical to repo-root run
- Run with shuffled args (`templates.wxml component.wxml page.wxml`): output now identical to sorted-args run

Step 4 prerequisites are now actually complete: POC matches legacy on output shape, normalization rules, dynamic-detection semantics, built-in-tag filter, inline wxs handling, cwd, AND arg order.

## Step 4 Outcome (Production Extractor Swap)

`scripts/extract-wxml-symbols.mjs` now uses `web-tree-sitter` in-process instead of forking `npx tree-sitter-cli parse --cst` per file. The legacy text-CST scaffolding (`execFileSync`, `parseCst`, `findAll`/`findFirst`/`directChild`/`attributeName`/`attributeValue`/`attributesFrom`, the `WXML_ZED_HOME`/`npm_config_cache` env dance) is gone. File dropped from 334 to 250 lines.

### Profile speedup on `fixtures/miniprogram` (10 WXML files)

| Metric | Before (CLI fork per file) | After (in-process wasm) | Ratio |
|---|---|---|---|
| Wall time | 60.72s | **200.91ms** | ~300× |
| Graph total | 60.69s | 175.14ms | ~350× |
| Symbol child time (across 2 batches) | 60.68s | 166.92ms | ~360× |
| Tree-sitter CST time (10 files) | 60.52s | **3.63ms** | ~16,700× |
| Model extraction time | 2.60ms | 1.83ms | ~1.4× |
| CST parse time | 1.26ms | 0.00ms | n/a — see below |

### Behavioral preservation

- All 4 committed baselines (home.wxml, miniprogram, test.wxml, real-world) remain **byte-identical** after the swap.
- `scripts/verify-wxml-language-service.mjs` passes.
- `node scripts/verify-lsp-diagnostics.mjs --suite smoke` passes.
- `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke` passes in ~2s (the README previously warned this "can still take minutes"; the legacy CLI fork was the only minute-scale work in the path).
- `node scripts/verify-lsp-diagnostics.mjs --suite full` passes (41 test cases) in ~17s.

### Profile-event field semantics

`parseMs` is now always `0`. There is no longer a "parse the text CST that the CLI printed" step — the SyntaxNode tree comes directly out of `parser.parse(source)` and is consumed in place. The field is kept on every `symbol-file` event so `scripts/profile-wxml-project-graph.mjs:72` (`sum(fileEvents, "parseMs")`) doesn't have to special-case absence. Reading `CST parse time: 0.00ms` in profile output is now the expected steady state, not a bug.

`cstMs` now reflects the actual `parser.parse(source)` time in-process; previously it included the entire `npx` fork + tree-sitter init + CST text emission + pipe round-trip.

### Deferred cleanup

- `scripts/extract-wxml-project-graph.mjs` still passes `HOME` and `npm_config_cache` env vars to the child process (lines 85-89). The child no longer uses them. Safe to delete in a follow-up commit; not load-bearing.
- The `fixtures/wasm-spike/*-baseline.json` files are kept as regression-test anchors. They can also be regenerated by running the new extractor (`node scripts/extract-wxml-symbols.mjs <files> > <baseline>.json`) since output is byte-identical.

### Known remaining risk

- ~~UTF-16 vs byte column units still unverified~~ — **resolved in a step-4 follow-up commit**: column units confirmed as UTF-16 code units, matching LSP protocol default; `fixtures/wasm-spike/non-ascii.wxml` is the regression anchor. See "UTF-16 column units — confirmed and locked in" below for details.
- This is now the first commit where `grammar/tree-sitter-wxml/tree-sitter-wxml.wasm` is **load-bearing for LSP runtime behavior**. Removing or corrupting that file silently breaks symbol extraction. It is in git, gitignored properly via the `!tree-sitter-wxml.wasm` negation added in step 1, and verified at load time by the smoke script.

Step 4 complete; the wasm path is now the production code path for symbol extraction.

### Intentional behavior change on parse-error inputs

Legacy `extract-wxml-symbols.mjs` exited 1 whenever `tree-sitter-cli parse --cst` failed — which happens on any file with parse errors (e.g. `fixtures/real-world/edge-recovery.wxml`). The new in-process path **does not exit 1 on parse errors**; it walks the partial SyntaxNode tree that tree-sitter's error recovery produced and emits whatever symbol structure it can identify. For `edge-recovery.wxml` specifically the result is an empty symbol model (`dependencies: [], symbols: [], references: [], components: []`) at exit 0 — see `fixtures/wasm-spike/edge-recovery-symbols-baseline.json`.

**Why this is the right choice, not just an oversight:**

1. **LSP graph builds must tolerate partial input.** Users edit WXML one keystroke at a time. Any keystroke can put a file in temporarily-broken state. If the symbol extractor exits 1 on a single broken file, `extract-wxml-project-graph.mjs` (which uses `execFileSync`) throws and the entire project's graph build collapses. With the new behavior, only that one file contributes no symbols and the rest of the project still gets indexed.
2. **tree-sitter's whole reason for being is error recovery.** The legacy CLI's exit-1 was tool-side politeness, not a semantic correctness signal. Using error recovery is the point of the technology.
3. **The fixture is literally named `edge-recovery`.** Its purpose is to verify recovery, not to enforce abort-on-error.

**Observed partial-extraction behavior on `edge-recovery.wxml`:** The wasm parse tree has `rootNode.hasError === true` and `rootNode.type === "ERROR"`. Even with 4 named children visible at root (`wxs_fallback`, two bare `start_tag`s, an `interpolation`), the extractor emits no symbols because:
- The grammar's error recovery rewrites the broken `<wxs>` as node type `wxs_fallback`, not `wxs_external` — the extractor doesn't recognize that recovery node type.
- The mismatched `<user-card>...</user-card-mismatch>` produces bare `start_tag` without an `element` wrapper — the extractor only emits components for elements with a recognizable open/close pair.

These behaviors are acceptable for the LSP use case: when the user finishes typing and the tags balance, the parser produces a clean tree and symbols appear. Until then, no false positives leak into completion/definition results.

### UTF-16 column units — confirmed and locked in

The notes previously flagged "UTF-16 vs byte column units" as the last remaining unverified risk after step 4. Step-4-followup investigation resolved it:

**Empirical test:** parsed `"你好 <import src=\"./a.wxml\" />"` with `web-tree-sitter@0.25.10` loading `tree-sitter-wxml.wasm`. `import_statement` reported `startPosition.column = 3`. UTF-16 code units predict col 3 (`你`=0, `好`=1, ` `=2, `<`=3); UTF-8 bytes would predict col 7 (你=0-2, 好=3-5, ` `=6, `<`=7).

**Conclusion:** `web-tree-sitter` emits column counts in **UTF-16 code units**. This matches the LSP protocol's default `positionEncoding` (UTF-16), so the extractor's `column` field can flow into the LSP `character` field with **zero conversion**.

**LSP link verified:** `server/wxml-language-service.mjs:54` is `character: range.start.column` — direct pass-through. The reverse direction (`line.slice(0, position.character)` at line 257) is also correct because JavaScript strings are internally UTF-16 and `String.prototype.slice` indexes by code unit.

**Regression anchor:** `fixtures/wasm-spike/non-ascii.wxml` and its frozen baseline `non-ascii-symbols-baseline.json` are checked by `scripts/verify-wasm-symbol-baselines.mjs` (case 6). If a future `web-tree-sitter` upgrade changes column units to UTF-8 bytes, this baseline diff catches it before merge.

### Grammar limitation surfaced during this fixture work (not a spike blocker)

While constructing the non-ASCII fixture, found that `tree-sitter-wxml` grammar rejects both Chinese tag names (`<用户-卡片>`) and Chinese attribute names (`数据="x"`) — the parser drops into ERROR state. This is a grammar-side gap, not an extractor bug. WeChat WXML spec arguably allows non-ASCII identifiers per JS identifier rules, but it's an unusual pattern in production WXML. Recorded here so a future grammar improvement task starts from a known scope. Fixture deliberately avoids these constructs to keep the column verification clean.

## JS Parser ABI (Event Handler Intelligence v1, Stage A)

To support upcoming WXML event-handler → JS method navigation (Page/Component method extraction), we vendor `tree-sitter-javascript` alongside `tree-sitter-wxml` and confirm both parsers load under the same `web-tree-sitter@0.25.10` runtime.

**Version pair:**
- `tree-sitter-javascript`: **0.25.0** (only published 0.25.x patch as of 2026-05-17)
- `web-tree-sitter`: 0.25.10 (unchanged — already runtime dep)
- Built with the same `tree-sitter-cli@0.25.10` we use for WXML, via local Emscripten 5.0.7 (`EM_CACHE` override required, same as WXML build)

**Artifact:** `grammar/tree-sitter-javascript/tree-sitter-javascript.wasm`, 402KB (~13× the size of the 31KB WXML wasm — JS grammar exposes 265 node types vs WXML's much smaller surface).

**Smoke verification** (`scripts/verify-js-wasm-parser.mjs`):

```json
{
  "wxmlAbi": 15,
  "jsAbi": 15,
  "jsNodeTypeCount": 265,
  "nodeTypesPresent": {
    "call_expression": 3,
    "identifier": 3,
    "arguments": 3,
    "object": 5,
    "pair": 6,
    "property_identifier": 11,
    "method_definition": 2,
    "function_expression": 2,
    "arrow_function": 0,
    "string": 0,
    "string_fragment": 0
  }
}
```

- Both wasms loaded in the same `Parser.init()` without conflict
- ABI matches exactly (15 == 15), not just within compat range
- All node types Stage B (method extractor) needs are present in the sample's parse tree: `call_expression` for `Page(...)` / `Component(...)`, `object` for the argument literal, `method_definition` for `onTap() {}` style, `pair` + `function_expression` for `onLoad: function () {}` style

**Vendoring scope:** copied `LICENSE`, `README.md`, `binding.gyp`, `grammar.js`, `package.json`, `tree-sitter.json`, `bindings/`, `queries/`, `src/` from the published 0.25.0 tarball. Excluded `prebuilds/` (native binding, we use wasm) and the tarball's prebuilt wasm (we self-build for ABI control). Grammar gitignore mirrors the WXML pattern: ignore `*.wasm` as build volatile, negate `!tree-sitter-javascript.wasm` so the committed artifact tracks.

Stage A passes; Stage B (JS method extractor POC) is unblocked.

---

**Regression anchor for parse-error case:** `fixtures/wasm-spike/edge-recovery-symbols-baseline.json` is the committed snapshot of that output. It is verified automatically by `scripts/verify-wasm-symbol-baselines.mjs` (one of 6 cases — the others lock in the legacy-equivalent behavior on home/miniprogram/test.wxml/real-world plus the UTF-16 column verification on non-ascii.wxml). The verifier is wired into `scripts/verify-tree-sitter.sh`, so the umbrella verification suite catches both kinds of regression: (a) the legacy-equivalent baselines drifting, and (b) parse-error tolerance reverting to exit-1.

For ad-hoc local verification of just the parse-error case:
```bash
node scripts/extract-wxml-symbols.mjs fixtures/real-world/edge-recovery.wxml > /tmp/edge.json
diff /tmp/edge.json fixtures/wasm-spike/edge-recovery-symbols-baseline.json
echo "exit code should be 0, baseline should be unchanged"
```

If a future change wants to **add** symbol extraction from recovered tree shapes (e.g. teach the extractor about `wxs_fallback`), the baseline updates and the rationale gets recorded here. The verifier catches the change at CI time so the decision is explicit.
