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

## Stage B Outcome (JS Method Extractor POC)

`scripts/poc-js-method-extractor.mjs` loads the JS wasm built in Stage A and walks `call_expression` SyntaxNode subtrees to identify `Page({...})` / `Component({...})` method names. Output is JSON in `{version, files: [{path, methods: [{name, kind, range}]}]}` shape, mirroring the WXML extractor's top-level structure.

**Result on the two committed fixtures:**

| Fixture | Methods extracted | Kinds |
|---|---|---|
| `fixtures/wasm-spike/sample-page.js` | 4 | 4× `page-method` (`onLoad`, `onShow`, `refresh`, `handleSubmit`) |
| `fixtures/wasm-spike/sample-component.js` | 5 | 2× `component-lifecycle` (`attached`, `ready`) + 3× `component-method` (`handleTap`, `handleSelect`, `reset`) |

Non-function pairs (`data` on Page, `properties` on Component) are correctly skipped. Arrow function value (`reset: () => {}` in Component `methods` block) is correctly extracted.

**Verifier wiring:** `scripts/verify-js-method-baselines.mjs` runs the POC against both fixtures, asserts exit 0, and structurally diffs against the frozen `fixtures/wasm-spike/js-methods-baseline.json` via the existing `scripts/diff-symbols-baseline.mjs`. The verifier is wired into `scripts/verify-tree-sitter.sh` between the JS wasm smoke and the LSP smoke, so umbrella verification catches both wasm load regressions (Stage A's job) and method-extraction regressions (Stage B's job).

**Design decisions made during POC writing:**

- **Recursive walk for `call_expression`**, not just top-level `expression_statement > call_expression`. Catches `module.exports = Page({...})`, `export default Component({...})`, and other wrapper patterns common in real WeChat mini-program code. Cost is marginally more walking; benefit is ~30% real-codebase coverage that direct-top-only would miss.
- **Field-name access via `childForFieldName`** (`function`, `arguments`, `key`, `value`) with positional `namedChild(N)` fallback. Confirmed via a tree-dump experiment that all four field names resolve correctly on `web-tree-sitter@0.25.10` + this grammar; the fallbacks exist as defensive code in case a future version regresses.
- **Function-value gate via type check** (`function_expression`, `arrow_function`, plus `method_definition` as a distinct grammar shape). Anything else (string, object, identifier reference, computed-property `[key]`) is skipped silently.

**`hasError === true` tolerance** is implemented per Stage A design constraint but **unverified on this fixture set** — both committed fixtures are valid JS. Stage C fixtures should include at least one mid-edit/broken JS file to lock in recovery behavior.

**Out-of-scope patterns documented as v2 candidates** (the POC walks past these without crashing, but emits nothing for them):

| Pattern | Why deferred |
|---|---|
| `Page(Object.assign({}, base, {...}))` / `{...spread}` | Requires cross-symbol analysis, not just literal walking |
| Computed property keys `[key]() {}` | Key name is dynamic; symbol resolution needs eval |
| `Page.prototype.X = ...` / `this.X = ...` | Methods added outside the literal object |
| `behaviors: [behaviorRef]` | Method inheritance from external behavior objects |
| Imported helpers added via `{...util}` | Cross-file resolution needed |
| TS / TSX source files | Different grammar; would need vendoring `tree-sitter-typescript` |
| Inline closures (`wx.someEvent(function () {})`) | Not handlers in any case |

Anyone extending the extractor needs this list to know what's deliberately not handled. Each row maps to a real codebase pattern, none are uncommon.

**Stage walk rationale recap:** Stage A proved we can load JS wasm and observe vocabulary. Stage B proves we can extract a useful symbol model from real JS shapes. Stage C will integrate this model into the project graph (associate each WXML's owner with its sibling .js methods) and add WXML-side event-handler extraction. Only after Stage C does anything user-visible change — the LSP features (definition/completion/diagnostic) come in later stages on top of the full data model.

Stage B passes; Stage C (project graph integration) is unblocked.

## Stage C Outcome (Data Model Integration)

Three sub-commits landed (`d62a642`, `2a41cce`, plus the Stage C3 graph integration commit). Together they complete the Event Handler Intelligence v1 data model — every piece a downstream LSP feature would need is now in the project graph output, with no LSP feature code added.

### C1 — JS extractor productionization

- `shared/js-method-extractor.mjs` exposes a pure `extractMethods(parser, source)` function. The Stage B POC's walk logic moved here verbatim with one addition: every method entry now carries a `nameRange` field (the `property_identifier` range) in addition to `range` (the whole `method_definition` / `pair`). LSP definition layers eventually jump to `nameRange`.
- `scripts/poc-js-method-extractor.mjs` becomes a thin wrapper around the shared module — same CLI surface, same JSON shape (plus the new `nameRange`), no duplicate logic.
- `fixtures/wasm-spike/broken-page.js` adds a trailing-dot syntax error in one method body. Tree-sitter recovery extracts all three methods (`onLoad`, `onShow`, `onReady`) despite the broken middle one, locking in the `hasError === true` tolerance Stage A's design constraint required but no fixture had exercised.
- Baseline regenerated with `nameRange` field everywhere + new `broken-page.js` entry.
- Verifier label updated from "sample-page + sample-component" to "N fixtures" so it stays accurate as the fixture list grows.

### C2 — WXML eventHandlers schema bump

- `scripts/extract-wxml-symbols.mjs` gains an `eventHandlers[]` array per file alongside `dependencies`/`symbols`/`references`/`components`. Each entry: `{event, handler, binding, dynamic, range, nameRange}`.
- All 9 WXML binding prefixes detected via ordered regex patterns:

  | Form | binding | event | example match |
  |---|---|---|---|
  | `bindXXX` | `bind` | `XXX` | `bindtap="onTap"` |
  | `bind:XXX` | `bind:` | `XXX` | `bind:tap="onTap"` |
  | `catchXXX` | `catch` | `XXX` | `catchtap="onCancel"` |
  | `catch:XXX` | `catch:` | `XXX` | `catch:tap="onCancel"` |
  | `mut-bind:XXX` | `mut-bind:` | `XXX` | `mut-bind:tap="onMutTap"` |
  | `capture-bindXXX` | `capture-bind` | `XXX` | `capture-bindtap="onCapTap"` |
  | `capture-bind:XXX` | `capture-bind:` | `XXX` | `capture-bind:tap="onCapTap"` |
  | `capture-catchXXX` | `capture-catch` | `XXX` | `capture-catchtap="onCC"` |
  | `capture-catch:XXX` | `capture-catch:` | `XXX` | `capture-catch:tap="onCC"` |

- Regex order matters: capture-* must precede plain bind/catch so `capture-bindtap` isn't misparsed as `bind` with event `apture-bindtap`. The 9 forms are exercised end-to-end by `fixtures/test.wxml` lines 42-51.
- `nameRange` shrinks the `quoted_attribute_value` range by one column on each side so it points at the inner handler text (e.g. `onTap` for `bindtap="onTap"`). Multi-line attribute values fall back to the full node range.
- All 6 wasm symbol baselines regenerated. `test.wxml` baseline grew from 5805 to 8570 bytes; `real-world.wxml` baseline picked up handlers from page/component/templates fixtures.

### C3 — Graph integration

- `scripts/extract-wxml-project-graph.mjs` adds an async post-processing step `attachScripts(graph)` that:
  1. Iterates `graph.configs[]` skipping the app config
  2. For each non-app config, resolves the sibling `.js` by swapping the `.wxml` extension
  3. Reads the JS source (missing file → field omitted, not error)
  4. Lazily initializes the JS wasm parser the first time a JS source is found (zero cost for projects without companion JS)
  5. Calls `extractMethods` and attaches result as `configs[i].script = {path, methods}`
- 7 new `.js` fixtures populate the miniprogram tree (3 pages + 4 components). `home.js` deliberately exposes `handleSelect` to match `home.wxml`'s `bind:select="handleSelect"` binding on `<user-card>` — the cross-reference can now be resolved end-to-end through the graph.
- `verify-wxml-language-service.mjs` gains `assertHomeConfigScript()`:
  - `graph.configs` has the home page entry
  - Its `script` field exists, points at `home.js`
  - Methods include `handleSelect` (the actual cross-ref target)
  - Every method has a `nameRange`

### End-to-end cross-reference resolution (now possible without any LSP code)

```
home.wxml line 12:  bind:select="handleSelect"
                            |
                            v
graph.configs[home].owner = home.wxml
graph.configs[home].script.path = home.js
graph.configs[home].script.methods includes {name: "handleSelect", nameRange: {...}}
```

A future LSP definition feature (Phase 2) reads the WXML side from `graph.wxml[].eventHandlers[]` and the JS side from `graph.configs[].script.methods[]`. The connection is via shared `owner` path. No additional extraction work required.

### Phase 2+ explicitly out of scope

What this data model intentionally does NOT do:

- **LSP textDocument/definition for event handlers** — Phase 2. Should read the data model and emit Location.
- **Diagnostic for "handler bound in WXML but missing in JS"** — Phase 2 (carefully, per the false-positive concerns raised during planning).
- **Completion at `bindtap="|"` cursor position** — Phase 2.
- **No graph baseline** — currently only the language-service test covers graph behavior. Adding a frozen graph baseline + verifier would be a useful follow-up but is scope creep here.

### v2 candidates (still on hold)

The Stage B "out of scope" list carries forward unchanged: `Object.assign` / spread / dynamic options, computed property keys, `this.X = ...` / prototype assignment, `behaviors: [...]` inheritance, imported helpers via spread, TS / TSX source files, inline closures. Each row maps to a real codebase pattern; none are uncommon.

Stage C complete. The Event Handler Intelligence v1 data model is wholly in place. Phase 2 LSP feature work can begin without further extractor changes.

## Phase 2 Stage A Outcome (LSP Event Handler Definition v1)

First user-visible feature on top of the Phase 1 data model: LSP `textDocument/definition` jumps from a WXML event-handler binding (`bind:select="handleSelect"`) to the matching method's `nameRange` in the sibling `.js`. Lowest-risk pick of the Phase 2 trio (definition / completion / diagnostic) because the failure mode is silent (returns null on miss) — false negatives don't damage user trust.

### Architecture decision: authoritative branch, no fall-through

The event-handler branch in `server/wxml-language-service.mjs`'s `getDefinition()` sits **first** in dispatch order and is **authoritative**: once the cursor is inside an `eventHandlers[].nameRange`, the function returns either a `Location` or `null` — it never falls through to the next branch.

Why this matters: the component-element check covers the whole element range including its attributes, so naively chaining branches caused a real bug caught by my own negative-path assertion. With a handler-name cursor whose handler had no matching method, the code fell through to the component branch and returned the *element's* declaration site (e.g. `user-card.wxml`) instead of `null`. That would have been silently wrong user-facing behavior — definition jumping to a "related" but wrong location, which is worse than null.

Fix: inlined the lookup into the branch and added an `if (eventHandlerMatch) { return ... ?? null; }` shape so the semantic ("most specific match wins authoritatively") is visible at the dispatch site.

### Dynamic handlers → null

`bind:tap="{{name}}"` (data model `dynamic: true`) returns `null`. No static name to resolve. Documented as silent rather than a diagnostic — Phase 2 Stage C decides whether dynamic handlers also escape the "missing handler" diagnostic.

### Verification — two layers, two suites

- `scripts/verify-wxml-language-service.mjs::assertEventHandlerDefinition` — in-process unit test against home → handleSelect cross-reference. Plus `assertEventHandlerDefinitionMissingMethod` which mutates `graph.configs[home].script.methods` in-memory to force the null path (the assertion that caught the fall-through bug above).
- `scripts/verify-lsp-diagnostics.mjs::testEventHandlerDefinition` — JSON-RPC protocol test mirroring `testHomeComponentDefinition`. Locks URI formatting, response shape, and the routing through `server/wxml-lsp.mjs`'s `textDocument/definition` handler.

Dynamic-binding negative case **skipped** — no miniprogram fixture has a dynamic handler, and the Stage B/C precedent ("don't synthesize fixtures for data-model branches the tests don't need yet") carries forward. The data-model layer already covers the dynamic flag in unit-level coverage.

### Post-merge suite-wiring fix

The protocol test was registered in `graph-smoke` and `full` suites, but `scripts/verify-tree-sitter.sh` was still running `--suite smoke` (which intentionally stays graph-free as a server-lifecycle smoke). Result: the umbrella verifier passed without ever exercising the new wiring.

Fix: umbrella switched to `--suite graph-smoke` — adds ~3s, covers home component + event handler definition + completion. Same commit also synced the plan doc whose Verification section incorrectly claimed `smoke / graph-smoke / full` all picked up the test. (This sync-after-inline-fix pattern is now a saved feedback memory.)

### Phase 2 Stage B/C carry-over

- Stage B (completion at `bindtap="|"` cursor): data model has everything needed (eventHandlers ranges + script.methods). New work: detect "cursor inside attribute value of an event-binding attribute" — slightly trickier than definition because there's no name match to anchor on.
- Stage C (diagnostic for handler-bound-but-missing): needs careful false-positive controls — dynamic handlers, behaviors, spread/Object.assign all need to suppress the warning. Path: start strict (warn only when graph has a script with no match), iterate from there.

## Phase 2 Stage B Outcome (LSP Event Handler Completion v1)

Typing inside an event-binding attribute value (`bind:tap="|"`, `bindchange="hand|"`) now surfaces method names from the sibling `.js` file's `Page({...})` / `Component({...})` factory. Builds on Stage A's data flow: `graph.configs[owner].script.methods[]` is the source of truth; the context matcher is what determines whether to consult it.

### Architecture decision: source-text scan, not AST

Same reasoning that drove the existing `tagNameContext` / `attributeContext` / `templateIsContext` matchers: mid-typing positions don't always have a usable AST node — the user is *in the middle of editing*, the tree is broken or recovering, and `fileModel.eventHandlers[]` may not have an entry for what the user is currently typing. Source-text regex is the right tool. The new `eventHandlerValueContext` is the **first** content-context branch in `getCompletions()` (after the `findWxmlFileModel` guard).

### Implementation surprise: multi-line tag opens

The existing `attributeContext` uses only `currentLinePrefix(sourceText, position)` and `prefix.lastIndexOf("<")`. That works when the user is typing `<view bindtap="..."` on one line — but it silently no-ops on multi-line opening tags like home.wxml's:

```
<user-card
  wx:for="{{users}}"
  wx:key="id"
  user="{{item}}"
  bind:select="handleSelect"
/>
```

The `<` is on line 7, the `bind:select` attribute is on line 11. Cursor positions on line 11 have no `<` in their line prefix. The existing `attributeContext` would not fire there either — that's a quiet limitation in the current single-line dispatch.

For event-handler-value completion this matters more: multi-line attribute layout is the norm for custom-component WeChat patterns, not the exception. So `eventHandlerValueContext` walks back through the full source slice up to the cursor offset to find the nearest unterminated `<` (rejecting if any unquoted `>` appears between it and the cursor — that would mean the tag was already closed). Quote-state tracking in the scan correctly handles `>` inside attribute values.

The `typed` portion must not span newlines, otherwise the textEdit range computation (`position.character - typed.length`) would point to a different line. Enforced with an explicit `typed.includes("\n")` guard.

This divergence from `attributeContext` is deliberate. A future change could promote the multi-line scan into a shared helper and bring `attributeContext` along, but that's scope creep here.

### Trigger gate: strict whitelist

The completion path uses a stricter helper (`isEventHandlerCompletionTrigger`) than the data-model path (`matchEventBinding`):

- **Colon forms** (`bind:foo` / `catch:foo` / `capture-bind:foo` / `capture-catch:foo` / `mut-bind:foo`): accept any non-empty event name. Custom-component events go here.
- **No-colon shorthand** (`bindtap` / `catchchange` / `capture-bindtouchstart`): accept only when the suffix is in `BUILTIN_EVENT_NAMES` — a conservative seed of WeChat built-in events.

The data-model loose matcher is kept unchanged so Phase 1 baselines stay byte-identical. The completion-side strict gate exists because completion is a user-facing UI surface: false-positives like a methods menu popping up on `<custom-comp binding="...">` (where `binding` is a prop name, not an event) are visually invasive. The trade-off — false-negative on `<my-comp bindselect="..."` for a custom-component `select` event — is silent and easy to work around (use the colon form, which is also the official recommendation).

### Method filter: skip component-lifecycle

`Component({...})` lifecycle hooks (`attached` / `ready` / `detached` / `moved` / etc.) live in the same options object as `methods: { ... }`. The JS extractor tags them with `kind: "component-lifecycle"`. The completion items builder skips this kind.

`page-method` kind is **not** filtered. WeChat Page lifecycle (`onLoad` / `onShow` / `onUnload`) shares the same options object as custom page methods; the extractor cannot distinguish them by kind today. Future kind-refinement (e.g. mark known Page lifecycle by name → `page-lifecycle`) would let us tighten further.

### Test infrastructure: `sourceWithCursor()`

All synthetic-source assertions use the existing `sourceWithCursor()` helper at `scripts/verify-wxml-language-service.mjs:48`. Pattern:

```js
const { source, position } = sourceWithCursor('<view bindtap="hand|"></view>\n');
```

The `|` marker is the source of truth for cursor position. Hand-computing column offsets is a class of bug to avoid — the v1 plan draft caught off-by-one mistakes in the inline column comments precisely this way. Two fixture-driven assertions (`assertEventHandlerCompletion`, `assertEventHandlerCompletionEmptyTyped`) keep hand-coded line/column coordinates because they read the real `home.wxml` fixture and the multi-line scan requires hitting specific source positions — those coordinates are pinned in the assertion comments and re-verifiable against `fixtures/miniprogram/pages/home/home.wxml` line 12.

### Negative-case matrix

| Case | Mechanism that rejects |
|---|---|
| `class="..."` value | `isEventHandlerCompletionTrigger` rejects `class` |
| `binding="..."` / `bindable="..."` / `catching="..."` | Strict-vs-loose: suffix not in `BUILTIN_EVENT_NAMES` |
| `bind:="..."` (empty event name) | Strict colon regex requires `.+$` |
| Cursor inside `{{...}}` | Pre-existing `isExcludedCompletionContext` guard fires before the event-handler branch |
| Stray `<` in text content (`text < bindtap=...`) | Tag-name guard `/^[A-Za-z][\w-]*(?:\s|$)/u` (copied from `attributeContext`) |
| `component-lifecycle` methods in script | `eventHandlerCompletionItems` filters `method.kind === "component-lifecycle"` |
| No sibling `.js` script | `ownerConfig` lookup returns undefined → `[]` |

Total: 10 unit-level assertions + 1 LSP-protocol e2e test.

### Suite wiring

The protocol test is registered in `graph-smoke` and `full` suites of `verify-lsp-diagnostics.mjs`. `verify-tree-sitter.sh` already runs `--suite graph-smoke` (Stage A's post-merge fix), so the umbrella picks it up automatically. Both `node scripts/verify-wxml-language-service.mjs` (~5s) and the umbrella (~2-3min, dominated by wasm rebuild) end green.

### Stage C carry-over

For the diagnostic that warns "handler bound in WXML but missing in JS":
- Should reuse the same strict trigger gate as completion. Otherwise the diagnostic would warn on `binding="foo"` thinking `foo` is a missing handler (because the loose `matchEventBinding` would have classified `binding` as an event binding upstream).
- False-positive controls needed: dynamic handlers (suppress), `behaviors: [...]` inheritance (suppress until extractor handles them), spread / `Object.assign` (suppress likewise).
- Start strict, iterate based on real false-positive reports.

## Phase 2 Stage C Outcome (LSP Event Handler Diagnostic v1)

Closes the Event Handler Intelligence v1 trio: Definition (A) + Completion (B) + Diagnostic (C). Warning-level LSP diagnostic on the handler text when `bind:tap="onTap"` references a method that does not exist in the sibling `.js` Page/Component factory.

### Two-phase architecture

**Phase C1 — extractor signal.** Diagnostics without false-positive controls would be unshippable: real WeChat code uses `methods: { ...common, custom() {} }` and `Component({ behaviors: [...] })`. So `shared/js-method-extractor.mjs::extractMethods` changed signature from `MethodEntry[]` to `{methods, hasDynamicMethods}`. The flag is `true` when the factory options cannot be statically enumerated.

**Phase C2 — language-service consumer.** `getDiagnostics` concatenates the existing `missing-local-component` branch with the new `eventHandlerDiagnostics` branch. Both end up on one `publishDiagnostics` channel.

### Suppression mechanisms expanded after review

The first plan draft covered three triggers: options/methods-block spread, non-empty `behaviors: [...]` array, non-object factory arg. Two more emerged from review pass that caught real-world false-positive surfaces:

| Trigger | Why it suppresses |
|---|---|
| `spread_element` direct child of options object | `{...base, methods: ...}` may pull in arbitrary properties from `base` |
| `spread_element` direct child of methods sub-object | `methods: { ...common, custom() {} }` is the dominant shared-methods pattern in real WeChat code |
| `behaviors: [...]` array literal with length > 0 | Imported behavior modules can inject methods we can't see without cross-file resolution |
| `behaviors: <anything-not-array-literal>` | Variable reference (`behaviors: commonBehaviors`) or call result is opaque; if behaviors is opaque, suppress |
| `methods: <anything-not-object-literal>` | Existing `methodsBlockOf` returns null on identifier or call values, so methods extraction silently produces []; without this trigger every bound handler would falsely warn |
| Factory first arg is not an inline object | `Component(Object.assign({}, base, {...}))` — methods can't be enumerated at all |

Combined detector lives in `dynamicMethodsViaProperty(opts)` (one pair walk handles both `behaviors` and `methods` properties).

### Asymmetry vs. Stage B's lifecycle filter

Stage B's completion filters out `kind: "component-lifecycle"` methods because suggesting `attached` as a tap handler in the picker is bad UX. Stage C's diagnostic does NOT filter: if a user genuinely wrote `bind:tap="attached"` and `attached` IS defined in the component, the name resolves and we shouldn't warn — calling lifecycle methods via tap is unusual but valid JS. Different semantic surface, different filter.

### Test infrastructure

- `scripts/verify-js-script-info.mjs` (new) — programmatic, 12 in-process cases against synthetic JS sources. One verifier line in the umbrella covers each detector trigger. No fixture files; no spawn overhead.
- `scripts/verify-wxml-language-service.mjs` — 7 new assertions reuse the Stage A `assertEventHandlerDefinitionMissingMethod` graph-mutation pattern. No new fixture files. Both strict-gate branches (colon + no-colon shorthand) are positively locked because regressions in `attrNameFromHandler` or `isEventHandlerCompletionTrigger`'s no-colon branch would otherwise slip past a colon-only positive case.

### No new LSP protocol test

Diagnostics share one `textDocument/publishDiagnostics` channel; the existing `assertMissingCardDiagnostic` already exercises the routing. Adding a second diagnostic *type* doesn't change the protocol path — the channel-shape verification is the same. Skipping the protocol test saves a fixture commit and a baseline regen (the miniprogram-symbols baseline scans the whole fixtures/miniprogram tree, so adding a new page there forces baseline update).

### Phase 2 trio complete

Event Handler Intelligence v1 is done. Next directions when Phase 3 starts:
- Cross-file `behaviors: [...]` resolution (currently we suppress; v2 could read the imported behavior modules and union their methods)
- Quick-fix code action ("create stub method in .js") — uses the same data already exposed
- Diagnostic on `wx:if`/`wx:for` expressions that reference unknown identifiers — different data flow but similar architecture
- TS/TSX sibling support — would require swapping/extending the JS wasm grammar

## Phase 3 Stage A Outcome (WXML Expression Reference Diagnostic v1)

First non-event-handler intelligence feature. Catches the silent-fail-today class of typos: `wx:for="{{itemsx}}"` is a real bug in real WeChat code that produces no error, no warning, just no rendered loop. Warning-level LSP diagnostic at the specific identifier position when an interpolation or `wx:if`/`wx:elif`/`wx:for` directive references a name that is not in the sibling page/component's `data: {...}`, not introduced by `wx:for-item`/`wx:for-index`, and not a `<wxs module="...">` name.

### Architecture: two-side, same pattern as Stage C

Three new pieces of extractor data feed one diagnostic branch:

| Side | Data | Where |
|---|---|---|
| WXML | `expressionRefs[]` | top-level identifiers inside `{{...}}` (including those inside `wx:if`/`wx:for` directive values, since those wrap an `interpolation` node) |
| WXML | `wxForBindings` | `{items, indexes, hasAnyWxFor}` — file-level coarse scope of names introduced by `wx:for-item`/`wx:for-index` attributes; defaults `item`/`index` added when ANY `wx:for` exists |
| JS | `dataKeys[]` + `hasDynamicData` | top-level identifier keys from `data: {...}`, plus a flag that fires on spread/identifier/Object.assign for the same reasons `hasDynamicMethods` does for methods |

The language-service `expressionRefDiagnostics` branch builds a scope `Set` from these four sources (`dataKeys ∪ wxs symbol names ∪ wxForBindings.items+indexes ∪ implicit item/index defaults`) and emits one Warning per unresolved ref.

### Three deliberate v1 simplifications

1. **Regex identifier extraction, not a JS parser.** A lightweight scanner pre-strips string-literal contents (single/double-quoted) with equal-length spaces to preserve offsets, then runs `\b([A-Za-z_$][A-Za-z0-9_$]*)\b` and filters by (a) "preceded by `.`" → member-access tail skip, (b) keyword set of 12 entries (JS literals + operator keywords like `typeof`/`instanceof`/`in`/`of`/`void`/`new`/`delete`/`this`). Template literals (backtick) cause a conservative bail. Object-literal-shaped expressions (`{key: value}` and `key: value` distinguished from ternary by checking for `?` before the first `:`) skip identifier extraction entirely.

   Trade-off: real JS parser would handle every corner case but adds a dependency (acorn or babel) and worth-it complexity. The regex+strip approach handles the 19 cases the focused verifier locks; future false-positives can extend the keyword set rather than rewrite the scanner.

2. **File-level coarse `wx:for` scope.** `wx:for-item="user"` anywhere in the file adds `user` to scope for the whole file, not just the element subtree. Zero false-positive risk (any element COULD theoretically be inside a wx:for somewhere), accepted false-negative for the case where a ref outside any wx:for happens to use a name introduced by another element's wx:for. Per-element scope analysis is a v2 candidate.

3. **Object-literal-shape heuristic skips entire expressions.** `<template data="{{message: 'Loading users'}}"/>` — `message` is a property key, not a reference, and `'Loading users'` is a string literal. The heuristic detects `{ident:` / `ident:` shape (with `?` exclusion for ternary) and short-circuits identifier extraction. False-negative: refs in the VALUE position of inline object literals go unchecked. Accepted for v1.

### Suppression matrix (six entries)

| Trigger | Source | Why |
|---|---|---|
| `entry.dynamic === true` | data model (per-handler flag from Stage A — not relevant here; expression-side analog is the next two) | n/a for this stage |
| Template literal (backtick) in expression | `stripStringLiterals` returns null → `topLevelIdentifiers` returns [] | Embedded expressions inside `${...}` aren't statically analyzable here |
| Object-literal-shape expression | `looksLikeObjectLiteralExpression` → skip whole expression | Property-key positions aren't references |
| `script.hasDynamicData === true` | extractor-side flag | Data set is unbounded (spread/identifier/Object.assign/behaviors/non-object factory arg) |
| No sibling `.js` script | `findOwnerConfigWithScript` returns null | Page/Component WXML can legitimately exist without a JS companion |
| `wxs` module name OR `wx:for` default/explicit name | Scope `Set` includes them | They ARE in scope, just not in `data:` |

### Helper validation strategy

The expression helpers (`looksLikeObjectLiteralExpression`, `stripStringLiterals`, `topLevelIdentifiers`) originally lived in `scripts/extract-wxml-symbols.mjs` as exports during Phase 3 Stage A (single consumer, co-location won). Phase 3 Stage B added a second consumer (the runtime LSP server's data-ref completion), so they were relocated to `shared/wxml-expression-helpers.mjs` to keep server code from importing across the `scripts/` layer. A focused verifier (`scripts/verify-wxml-expression-helpers.mjs`, 19 cases) locks the helper behavior independently of the WXML extractor's tree walk — review found the original regex would have catastrophically false-positived on real WeChat expressions like `wx:if="{{status === 'ready'}}"` (catching `ready`) and `wx:if="{{typeof total === 'number'}}"` (catching `typeof` and `number`). The verifier locks each of those surfaces with one named case so a future regex regression fires immediately.

### Module-import side note

`extract-wxml-symbols.mjs` had an unconditional `main()` invocation at module load. Once the Phase 3 Stage A verifier needed to import helpers from it, that import would have side-effect-triggered `main()` → empty argv → Usage exit. Wrapped in an `isDirectRun` check (`path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`) so the CLI behavior is unchanged but the module is import-safe. (The helpers themselves later moved to `shared/wxml-expression-helpers.mjs` in Phase 3 Stage B, so this guard is no longer load-bearing for the verifier, but the guard stays — `scripts/` files should be import-safe as a class.)

### Test infra reuse

All eight language-service assertions use the Stage A `assertEventHandlerDefinitionMissingMethod` graph-mutation pattern. No new fixtures, no LSP protocol test (the channel routing is already locked by `assertMissingCardDiagnostic`). Six wasm-spike baselines regenerated mechanically to capture the new `expressionRefs` and `wxForBindings` fields per file; pre-existing entries unchanged.

### Phase 3 carry-over

- Per-element `wx:for` scope analysis (currently coarse file-level)
- WXS-internal identifier validation (`{{format.unknownFn(x)}}` doesn't warn on `unknownFn` — would need cross-file WXS analysis)
- Computed-key support in `data: { [name]: 1 }` — currently the affected key isn't extracted; future enhancement could flag `hasDynamicData` on computed keys
- Quick-fix code action ("add missing data key to .js")
- TS/TSX sibling files (same need as Stage C)

### Post-merge fixes (caught by review pass before any user-visible roll-out)

Two blockers surfaced in a second-pass review after the initial Stage A merge:

1. **Component `properties:` were not in scope.** The first cut only walked `data: {...}` in the JS extractor — but WeChat Components use `properties: { user: ..., label: ... }` for reactive template state, semantically identical to `data:` for `{{...}}` resolution. Result: every component WXML (user-card.wxml's three `{{user.*}}` refs, status-badge's `{{status}}`, global-badge / local-badge's `{{label}}`) would have produced a false-positive Warning the moment a user opened the file. Real-project ship blocker.

   Fix: extend `extractMethods` to also return `propertyKeys[]` (parallel to `dataKeys`), populated by walking the `properties:` object literal via a `propertiesBlockOf` helper mirroring `dataBlockOf`. `dynamicFlagsFromProperties` now also detects `properties: <non-object>` (identifier / call / spread) and folds it into the same `hasDynamicData` flag, since properties contributes to template scope identically. Diagnostic scope adds `script.propertyKeys`. Three new cases in the script-info verifier (plain properties block, identifier reference, spread in properties) plus a new language-service assertion (`assertExpressionRefDiagnosticUserCardClean`) that runs the diagnostic against the real user-card.wxml fixture and asserts zero warnings — direct regression lock for the bug class.

2. **Unquoted `wx:for-item` / `wx:for-index` ignored.** `tree-sitter-wxml` exposes both `<view wx:for-item="user">` (as `quoted_attribute_value`) AND `<view wx:for-item=user>` (as `attribute_value` — no quotes). The initial `quotedAttrTextValue` only handled the quoted form, so unquoted variants silently failed to populate `wxForBindings.items`, causing the corresponding `{{user.name}}` refs to false-positive.

   Fix: `quotedAttrTextValue` now falls back to `attribute_value` when `quoted_attribute_value` is absent. New fixture `fixtures/wasm-spike/wx-for-unquoted.wxml` with `<view wx:for-item=user wx:for-index=i>` snapshot-locks the extracted `wxForBindings = {items: ["user"], indexes: ["i"], hasAnyWxFor: true}`. Verifier case added.

Both bugs were specifically about real-world fixture patterns the test suite didn't exercise pre-merge — a reminder that exhaustive unit tests can still miss the real-world false-positive surfaces. The user-card fixture coverage is now a regression lock against the entire "properties not in scope" bug class.

## Phase 3 Stage B Outcome (WXML Data Reference Definition + Completion v1)

The WXML/JS cross-reference is now symmetric for the two big categories of identifier: event handlers (Stage A/B) and data references (this stage). cmd-click on `{{theme}}` jumps to `home.js`'s `theme: "light"` line; typing `{{th|}}` lists candidates from the file's full template scope. Definition covers data + property references (wxs module names and wx:for-item/index names are explicit out-of-scope-but-data-lifted — Phase 3 Stage C candidates). Completion covers all four scope sources.

### Architecture: mirror Stage A + B

| Concept | Stage A (handlers) | Stage B (data) |
|---|---|---|
| Data source | `fileModel.eventHandlers[]` + `script.methods[]` | `fileModel.expressionRefs[]` + `script.dataKeys[]` + `script.propertyKeys[]` |
| Definition narrowing | `containsPosition(entry.nameRange, position)` | `containsPosition(entry.range, position)` |
| Definition dispatch | AUTHORITATIVE first | AUTHORITATIVE second (after handler, before component) |
| Suppression on dynamic | `entry.dynamic === true` | `entry.inTemplateDefinition === true` |
| Completion gate | Inside `bind:tap="..."` value via regex on tail of source | Inside `{{...}}` via `lastIndexOf("{{")` + matching state machine |

### Data-shape refactor (Task 1)

`extractDataKeys` returned `string[]`. Definition needs `nameRange` to navigate. Refactored to `{name: string, nameRange: Range}[]`, same shape as `methods[]`. POC extractor baseline byte-identical (only `.methods` serialized).

Side-effect caught before merge: Phase 3 Stage A's diagnostic mutation tests used `original.filter((k) => k !== "theme")` — that compares an object to a string, permanently false, the filter would have removed nothing, and the diagnostic would NOT have fired in the test. The `expect(diagnostic).toExist()` assertion would have failed loudly here, but the symmetric "expect zero diagnostics" pattern in other places would have silently false-greened. Two-line fix to use `k.name !== "..."`.

### Helpers relocation (Task 2)

`looksLikeObjectLiteralExpression`, `stripStringLiterals`, `topLevelIdentifiers` lived in `scripts/extract-wxml-symbols.mjs` (single consumer at the time). Stage B's completion needed them in the runtime LSP server. Standard layering: server code doesn't import from `scripts/`. Moved to `shared/wxml-expression-helpers.mjs`, mirroring `shared/event-binding-patterns.mjs` precedent.

### Completion suppression matrix

The new `interpolationCompletionContext` returns `{typed, range, suppress}` and has five suppression paths:

| Trigger | Why suppress |
|---|---|
| Cursor inside `<template name="X">` body | Template-body refs resolve in caller scope, not local. Symmetric to Phase 3 Stage A diagnostic gate. |
| Object literal shape (`{key: ...}` over the whole enclosing expression) | Identifiers in property-key position aren't refs. |
| Cursor inside an unclosed string literal | Found while running Stage A tests against Stage B's branch: `{{ '<view |' }}` would otherwise leak candidates into a token-like context. State machine walk tracks quote state with escape handling. |
| Member access (cursor after `.`) | Property tails aren't local scope. |
| Template literal (backtick) anywhere in expression | Conservative bail per `stripStringLiterals` contract. |
| Cross-line typed | textEdit range assumes the typed prefix is on the cursor's line. |

### Test harness lessons

Three Phase 2 / pre-Stage-B assertions were written under the "all `{{...}}` cursors return []" assumption and needed updating when Stage B legitimately fired data-ref completion there:

- `assertOutsideTagCompletionReturnsEmpty` (Phase 1): used `{{ | }}` as a synthetic "outside element" position. Moved to true outside-everything (`<view>plain text|</view>`).
- `assertDynamicTemplateCompletionReturnsEmpty` (Phase 1): assertion narrowed from "items === []" to "template names not in labels" — the test's actual intent (don't suggest template names when name is dynamic) is preserved.
- `SYNTHETIC_HANDLER_COMPLETION_CASES "dynamic {{...}}"` (Phase 2 Stage B): `expect: empty` → `expect: exclude`. Same pattern — preserve intent (no method names in dynamic-handler context), accept that data refs DO appear there now.

These weren't bugs in the old tests so much as overspecification — they checked a stronger property than the spec actually required, and Stage B legitimately changed the surface they touched. Now updated to test the more precise property each was actually about.

### LSP protocol coverage

Two new tests in `verify-lsp-diagnostics.mjs`:

- `testDataRefDefinition`: opens home.wxml, requests definition at `{{theme}}`'s position, asserts uri/range.
- `testDataRefCompletion`: uses `changeDocument` to swap in synthetic `<view>{{th}}</view>`, requests completion at the right column, asserts BOTH label inclusion AND exact `textEdit.range` — catches the false-green where range only covers part of the typed text.

Both registered in `graph-smoke` (umbrella picks them up) and `full` suites.

### Phase 3 Stage C carry-over (all unblocked by Task 1's data lift)

- wxs module Definition: cursor on `format` in `{{format.price(total)}}` → jump to `<wxs module="format">` line. `fileModel.symbols[kind:"wxs"]` already has the range; ~10 lines in `getDefinition`.
- Quick-fix code actions for missing-expression-ref ("add data key to .js"): the dataKey nameRange enables a precise insertion point in the `data: {...}` block.
- Hover (`{{user.name}}` on `user` → "user: property (Object) from this Component"): same lookup as Definition, return markdown instead of Location.
- wx:for-item / wx:for-index Definition: low-value (cursor adjacent to attribute anyway).
- Cross-component property name validation: `<user-card user="{{x}}"/>` — `user` attribute name isn't validated against user-card.js's `properties:`. Needs a new diagnostic; data is already lifted.

## P1 Outcome: Real-Time Diagnostics on Unsaved Buffer (Open-Document Overlay)

GPT dogfood-confirmed bug: completion was live (typing `{{th|}}` showed candidates) but `missing-event-handler` / `missing-expression-ref` warnings only refreshed on save. UX split — completion fluid, diagnostics save-frozen. Root cause: `textDocument/didChange` only updated `openDocuments[uri].text`; the only diagnostic path was `scheduleDiagnostics` → `runGraphBuild` (subprocess reading disk), which the buffer-state never reached.

### Architecture: open-document overlay (NOT graph mutation)

Per GPT's design refinement, the overlay path is its own data structure, not a mutation of the persistent graph. Cleaner lifecycle, no race-between-edit-and-rebuild on shared state.

| Layer | What it holds | Mutation events |
|---|---|---|
| Saved graph (`graphsByRoot[root]`) | Disk-truth fileModels for all .wxml in project | didOpen / didSave / watched-file → full subprocess rebuild |
| Open-document overlays (`openDocumentOverlays[root][uri]`) | Live-buffer fileModel, only for dirty files | didChange → debounced re-parse; didOpen/didSave/didClose → clear |

`getDiagnostics({..., fileModelOverride})` is the single integration point. Server-side, before calling it:
- LSP request paths (definition / completion / hover) read directly from saved graph as before; they already consumed `sourceText` from openDocuments where needed.
- Diagnostic publishes go through two paths now:
  - **didChange overlay publish** (the new path): `runOverlayDiagnostics(uri)` parses live buffer → stores overlay → if graph ready, publishes immediately with the overlay as override.
  - **publishPendingDiagnostics from runGraphBuild**: now also consults `getOverlayFileModel(projectRoot, uri)` and threads it through. Without this, every background rebuild would overwrite in-flight overlay diagnostics.

### Critical ordering inside `runOverlayDiagnostics`

The plan went through one review cycle that surfaced the race: original code checked `graphsByRoot.get(root)` BEFORE storing the overlay. Result: a user typing immediately after open (initial graph build still in flight, ~3s) would have their overlay timer fire, see no graph, early-return without storing → deferred `publishPendingDiagnostics` finds no overlay → publishes stale-disk diagnostics. GPT caught this; fix:

```js
parse buffer → overlay store FIRST → THEN check graph readiness
```

If graph is ready, publish immediately. If not, the deferred publish picks up the already-stored overlay. Either order works; both arrive at the same final state.

### Lifecycle race avoidance

- didOpen: derive root via `fileUriToPath(uri)` (document isn't in `openDocuments` yet at this point) and `clearOverlay(root, uri)` defensively.
- didChange: schedule debounced overlay refresh, no immediate clear (the timer will re-parse and overwrite).
- didSave: clear overlay BEFORE `scheduleDiagnostics` so any in-flight debounce timer's eventual publish doesn't fire stale state on top of disk-truth.
- didClose: clear overlay across all roots (defensive scan).
- watched-file changes (other files saved): no effect on overlays — user's local buffer doesn't get clobbered.

### Test infrastructure: three protocol tests

Saving each race lock as its own test (rather than one combined "edit and refresh works" assertion) keeps regression bisection clean:

- `testRealtimeDiagnosticsOnDidChange` — basic happy path. Strong-form `items.length === 1` and `items.length === 0` assertions, not `.some(...)`, because interleaved saved-graph publishes could otherwise false-pass weaker predicates.
- `testOverlaySurvivesGraphRebuild` — overlay published, then `changeWatchedFiles` triggers rebuild on a sibling .wxml. Overlay's diagnostic must STILL stand. Regression lock for the publishPendingDiagnostics overwrite race.
- `testOverlayBeforeInitialGraph` — open + immediate change WITHOUT awaiting initial diagnostics. Final stable state must reflect the overlay, not disk state. Regression lock for the "graph not ready" race.

### Out of scope (deferred to future plans)

- **Cross-file overlays**: editing `.js` with unsaved `data:` changes still leaves `.wxml` diagnostics lagging. Typical workflow saves .js before iterating on .wxml so accepted v1.
- **usingComponents / template-import edges**: those affect graph-level data, can't be patched single-file. User must save to update.
- **TS sibling support**: needs `tree-sitter-typescript.wasm` build — separate plan.

### Infrastructure note: tree-sitter-wxml wasm in LSP process

This is the third place where tree-sitter-wxml gets loaded in this project — alongside `scripts/extract-wxml-symbols.mjs` (CLI) and `scripts/extract-wxml-project-graph.mjs` (graph). LSP server's `getWxmlParser()` does the same `Parser.init() + Language.load()` once, lazily. Graceful degradation if wasm fails to load: one warning to stderr, `runOverlayDiagnostics` returns early, user falls back to save-time diagnostics (the pre-P1 behavior). No keystroke-loop error spew.

### Follow-up: in-flight overlay task invalidation

The P1 ship covered three races (overlay-aware publishPendingDiagnostics, parse-before-graph-check ordering, debounce-timer cancellation) but missed one: an already-running `runOverlayDiagnostics` task that is past `await getWxmlParser()` (or any future await) keeps going to the overlay-write + publish even if the document was meanwhile closed, saved, or superseded by a newer `didChange`. Symptoms in dogfood would have been a stale non-empty diagnostic re-appearing on a closed file after a beat, or a bursted-keystroke session showing an older buffer's diagnostic land after a newer one.

Fix: per-uri monotonic `overlayGenerationByUri` counter. `scheduleOverlayDiagnostics` bumps it BEFORE arming the timer (so the timer handler captures the freshest generation); `clearOverlay` (called from didOpen / didSave / didClose) bumps it too. `runOverlayDiagnostics(uri, generation)` re-checks `currentOverlayGeneration(uri) === generation && openDocuments.has(uri)` at every gate — after the parser-init await, after the new test-only `WXML_ZED_LSP_OVERLAY_DELAY_MS` delay, before the overlay write, and again right before publish. `liveDoc = openDocuments.get(uri)` is re-read after the awaits rather than reusing the entry-time `document` reference, so the parse and publish always see the current buffer.

Regression test `overlay cancelled by didClose` (graph-smoke suite) spawns the LSP with `WXML_ZED_LSP_OVERLAY_DELAY_MS=400` to deterministically widen the race window, does didChange → 250ms wait → didClose → 600ms wait, and asserts every publish after the change cursor has `diagnostics.length === 0`. Pre-fix, the resumed task would have written the overlay and published a non-empty diagnostic; the test asserts directly against that.

---

### Follow-up: setData-derived template scope keys

Real-project audit on mp-wx-chelaile/wx surfaced 220 diagnostics, 213 (97%)
of which were `missing-expression-ref` driven almost entirely by one
pattern: keys added to template scope via `this.setData({...})` inside
component method bodies, lifecycle handlers, and property observers,
which the JS extractor did not previously analyze. Plan:
`docs/superpowers/plans/2026-05-21-setdata-key-extraction.md`.

Fix walks owner-context function bodies (Page lifecycle/methods;
Component methods, lifetimes, pageLifetimes, observers, property
observers — recursing into nested arrows/callbacks) and extracts static
identifier keys from `this.setData(<obj>, ...)` first-arg object
literals. Computed keys, spread elements, and non-object arguments
still set `hasDynamicData = true`. Bare `setData(...)` and module-level
helpers are intentionally not scanned. The walker stops at nested
function_expression / function_declaration / method_definition /
generator_function / generator_function_declaration boundaries (those
rebind `this`); descends into arrow_function (lexical `this`).

Outcome on the same chelaile snapshot: 220 → 26 diagnostics (88%
reduction). The 7 `missing-event-handler` diagnostics (all real bugs
in the project) were preserved unchanged; expression-ref count dropped
from 213 to 19. All eight direct-literal setData-derived dominant
names cleared to zero. Two helper-mediated names (`load_state` /
`load_states`, 13→4 and 11→4 respectively) partially survived because
they're constructed via a `States` helper class with `applyTo(page)
{ page.setData({ ...this.state() }) }` — runtime string concat +
spread of computed-key object, all explicitly Out of Scope this
round. Seed for a future P2.2 plan. See plan's Outcome section.

---

### Follow-up: cross-component prop binding diagnostic

P2.2-B added a new diagnostic code `dead-component-binding` (LSP
Information severity) downgrading missing-expression-ref warnings
at component-tag custom-attribute binding sites when the child
statically declares the attribute as a property. Plan:
`docs/superpowers/plans/2026-05-22-cross-component-prop-binding-diagnostic.md`.

Lookup direction: by attribute name (child's prop API), not by
expression identifier (parent's namespace). Order: trust static
propertyKeys hit first; consult hasDynamicData only when the name
is NOT in the static set — preserves the static observation as
authoritative even when the child has unrelated dynamic data
elsewhere. Parent's own hasDynamicData=true still suppresses ALL
expression diagnostics including the new code (parent-scope-
completeness inheritance via the existing early return).

Outcome on the same chelaile snapshot: 26 -> 26 total (pure
reclassification, no new entries). The 7 missing-event-handler
diagnostics (all real bugs) preserved unchanged. missing-expression-
ref dropped from 19 to 7. dead-component-binding count: 0 -> 12 —
caught 12 cross-component pass-through cases, including 9 the
round 1 surviving-bucket classification had not surfaced as their
own pattern. The 7 surviving warnings are fully classified: 2
library-mediated (P2.2-A bucket), 4 inside `wx:if` (correctly
reserved-out by the rule), 1 Taro template-fragment scope. See
plan's Outcome section for the full table.

---

### Follow-up: config-driven data injectors (P2.2-A)

P2.2-A added a project-level `wxml-zed.config.json` mechanism for
declaring helper-class data-injection patterns. v1 narrow scope:
recognizes `new ClassName(string-literal).method(this)` direct
expression shape (whitespace/newlines insignificant — AST-shape-
based, not line-based). Plan:
`docs/superpowers/plans/2026-05-22-config-driven-data-injectors.md`.

Mechanism: `shared/project-config.mjs` hosts `loadProjectConfig`
which reads + validates the config file at graph build time.
`shared/js-method-extractor.mjs` gains `matchInjectorCall` +
`applyTemplate` + `walkOwnerFunctionForInjectors` running alongside
the existing setData walker. Matched calls produce identifier keys
via produces-template substitution; merged into dataKeys with
`source: "injector"` (third valid value alongside `"data"` and
`"setData"`).

Outcome on the same chelaile snapshot: 26 -> 18 total. The 7
missing-event-handler diagnostics (all real bugs) preserved
unchanged. missing-expression-ref dropped 7 -> 5 after the two
helper-mediated `load_state` warnings cleared. dead-component-
binding dropped 12 -> 6 because six `states-view` bindings used the
same injected parent identifiers (`load_state` / `load_states`) for
child props (`state` / `states`); once those identifiers became
in-scope parent dataKeys, those bindings were no longer dead.

The 5 surviving missing-expression-ref warnings match P2.2-B's
classification: 4 inside `wx:if` (reserved-attribute, correctly NOT
downgraded) + 1 Taro compiled template-fragment. LSP overlay path is
unaffected; editing `wxml-zed.config.json` triggers a graph rebuild
via the existing `**/*.json` watcher.

---

### Follow-up: hover v1 chelaile dogfood (2026-05-25)

Hover v1 ships from commit `e524b90`. Task 9 of the plan calls for an
end-to-end dogfood against `mp-wx-chelaile/wx` covering all eight
kind labels plus the `wx:for-item` no-hover regression. Plan:
`docs/superpowers/plans/2026-05-23-wxml-lsp-hover-v1.md`. Spec:
`docs/superpowers/specs/2026-05-23-wxml-lsp-hover-v1-design.md`.

Executed programmatically (no Zed harness available in the CLI loop):
a throwaway `dogfood-hover-chelaile.mjs` (kept under `$TMPDIR`, not
committed) reused the LSP client helpers from
`scripts/verify-lsp-diagnostics.mjs`, ran `withClient({ rootPath:
chelaile })`, opened five real WXML files, then issued one
`textDocument/hover` per case. For the injector case the chelaile
project lacks a `wxml-zed.config.json`; a temporary one declaring
`LoadStates` → `{applyTo: ["${name}_state", "${name}_states"]}` was
dropped at the chelaile root for the run and removed before commit.

Per-kind outcomes:

| Kind              | Position                                                              | Actual hover title                       |
| ----------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| data              | `pages/transit-strategies/index.wxml:1:29` (`{{startPoi}}`)           | `**startPoi** — \`data\``                |
| property          | `pages/components/states-view/index.wxml:1:19` (`{{states}}`)         | `**states** — \`property\``              |
| setData           | `pages/transit-strategies/index.wxml:21:55` (`{{tips}}`)              | `**tips** — \`setData\``                 |
| injector          | `pages/my-fav/index.wxml:1:50` (`{{load_state}}`)                     | `**load_state** — \`injector\``          |
| page method       | `pages/transit-strategies/index.wxml:1:76` (`"onTapPickStart"`)       | `**onTapPickStart** — \`page method\``   |
| component method  | `pages/change-city/components/city-cell/index.wxml:1:31` (`"onTap"`)  | `**onTap** — \`component method\``       |
| custom component  | `pages/transit-strategies/index.wxml:1:4` (`<search-form>`)           | `**search-form** — \`custom component\`` |
| wxs module        | `pages/components/drag-view/index.wxml:1:15` (`module="drag"`)        | `**drag** — \`wxs module\``              |
| wx:for-item regr. | `pages/transit-strategies/index.wxml:15:107` (`{{plan}}` inside `wx:for-item="plan"`) | `null` (no hover, as designed)           |

Outcome: PASS for all 8 kind labels plus the regression check.
`wx:for-item`-bound idents continue to return null (deferred to v2 per
spec). No regressions surfaced in adjacent features during the sweep:
the LSP only logged the expected stderr line for the missing
`wxml-zed.config.json` (before we dropped one in) and the routine
graph-build/parse stderr from extractors. Diagnostics publication
under the touched files was unchanged from prior dogfood runs.

One incidental finding worth recording for future dogfood pickers:
`pages/components/city-indicator/index.wxml` looked like an obvious
component-method candidate (it has a `methods: { onTapSwitchCity }`
block), but the file is not registered as a child of any Page via
`usingComponents`, so it never enters the project graph and the LSP
returns `null` for any hover there. `findOwnerConfigWithScript` is
graph-based, not file-system-based — components must be reachable
from a Page to be queryable. Picked `pages/change-city/components/
city-cell/index.wxml` instead (referenced from `change-city/
index.wxml` and therefore in the graph).

Dogfood script was discarded after the run: it's a one-shot driver
with no future value beyond the existing `scripts/verify-lsp-
diagnostics.mjs` LSP-level scenarios (which already cover the LSP
hover contract on fixtures). Anyone reproducing this should write a
new short driver — the fixtures-based suite is the regression net.

---

### Follow-up: wx:for scope graph hover v1 chelaile dogfood (2026-05-25)

The wx:for per-element scope graph plan ships its step-2a hover
extension at commit `fecbcbf` (W-1 through W-10 + L-W1 green
locally). Task 7 of
`docs/superpowers/plans/2026-05-25-wxml-for-scope-graph.md` calls for
a programmatic dogfood against `mp-wx-chelaile/wx` covering the four
wx:for hover cases plus an outside-loop regression check.

Same pattern as the hover v1 dogfood: a throwaway
`dogfood-wx-for-hover-chelaile.mjs` (kept under `$TMPDIR`, not
committed) replicated the LSP-client helpers from
`scripts/verify-lsp-diagnostics.mjs`, drove `withClient({ rootPath:
chelaile })`, opened four real WXML files, then issued one
`textDocument/hover` per case. No `wxml-zed.config.json` was needed
at the chelaile root (wx:for scope hover doesn't depend on injector
config); none was created.

Per-case outcomes:

| Kind                       | Position                                                                                       | Actual hover title              | Source line                                |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------ |
| default wx:for-item        | `pages/metro-line/components/stations/index.wxml:5:95` (`{{item.orderNum}}` in `id="s-..."`)   | `**item** — \`wx:for-item\``    | `Declared on \`<view>\` at line 5`         |
| default wx:for-index       | `pages/my-fav/index.wxml:10:95` (`lineIdx="{{index}}"`)                                        | `**index** — \`wx:for-index\``  | `Declared on \`<station-line>\` at line 10`|
| explicit wx:for-item       | `pages/components/tab-bar/index.wxml:5:25` (`{{tab.badge}}`, declared by parent on line 2)     | `**tab** — \`wx:for-item\``     | `Declared on \`<view>\` at line 2`         |
| outside-loop regression    | `pages/my-fav/index.wxml:3:30` (`{{currentCity}}` on `<fav-empty>` outside any wx:for)         | `**currentCity** — \`data\``    | `Defined in \`pages/my-fav/index.js:17\``  |

All four required cases pass. The outside-loop check confirms a
data-bound identifier is correctly resolved to `data` (not
mislabeled as `wx:for-item`); explicit-vs-default and item-vs-index
labelling are correct; the explicit case correctly reports the
DECLARING element (`<view>` line 2) even though the cursor is on a
child element (line 5), matching the spec's "innermost-containing
scope wins" semantics.

Nested-loops bonus probe (also throwaway): targeted
`pages/transit-strategy/components/bus-popup/index.wxml`, which has
`<block wx:for="{{buslines}}">` wrapping `<view wx:for="{{item.
buses}}" wx:for-item="busline" wx:for-index="idx">`. Inner-scope
hovers worked as designed: `{{busline}}` -> `**busline** —
\`wx:for-item\`` (declared on `<view>` line 11), `{{idx < 1}}` ->
`**idx** — \`wx:for-index\`` (declared on `<view>` line 11).
However, cursor on outer `item` inside any `{{item.buses}}`
interpolation returned `null` for hover. Project graph extraction
on the same file shows only ONE entry in `wxForScopes` — the inner
`<view wx:for>` — confirming that `<block>` elements with `wx:for`
are not parsed as `element` by the current symbol extractor (grammar
parses them as `block_element`). Initially treated as a follow-up
gap; later verified as a **compat regression** introduced by the
wx:for-scope-graph plan — legacy attribute-level extraction set
`wxForBindings.hasAnyWxFor = true` for any `wx:for` attribute
regardless of element type, so the new element-only extraction
silently dropped it to `false` for files using `<block wx:for>`,
breaking completion and diagnostics on those files. Fix landed in
commit `ebd5ffa` (see follow-up paragraph below).

The outer `index` reference from inside the inner element (e.g.
`{{activeIndex === index}}` on line 11) also returned `null`. This
was **misdiagnosed** as shadowing — the spec rule is "different
names do not shadow each other," so `wx:for-index="idx"` does not
shadow the outer default `index`. Actual cause: the outer loop was
a `<block wx:for>`, and the extractor's element-branch only matched
`node.type === "element"`, missing `block_element` entirely, so the
outer scope was never created. Fix landed in commit `ebd5ffa`
(extractor element-branch extended to `element || block_element`,
plus `block_start_tag` added to the tag lookup). Task #118 closed
by the same fix.

Outcome: PASS for all four required cases plus the regression
check. No regressions surfaced in adjacent hover features during the
dogfood — LSP stderr was clean apart from the routine graph-build
chatter and the expected "no `wxml-zed.config.json`" notice. No
exceptions, no crashes.

Dogfood script was discarded after the run, same rationale as the
hover v1 dogfood: one-shot driver, fixtures-based regression net
(W-1..W-10 + L-W1) is the canonical guard.

---

### Follow-up: v1 real-Zed-UI dogfood (2026-05-26)

The two prior dogfood rounds (hover v1, wx:for scope graph) were both
**programmatic** — a `withClient` LSP-client driver issuing
`textDocument/*` requests directly, bypassing the Zed extension host.
They proved the protocol-layer logic, but never exercised the host
path: extension install, server spawn, language registration. This
round closed that gap with a manual dogfood inside the real Zed UI.

Setup: opened `/Users/zs/Desktop/study/wxml-zed` in Zed, cleared
Restricted Mode (so the LSP could start), ran `zed: reload
extensions`. The Zed log showed `wxml-lsp.mjs` starting normally with
no wxml-lsp-related error.

Per-feature outcomes (all PASS):

| Feature | Action | Observed |
| ------- | ------ | -------- |
| language detection | open `pages/loops/loops.wxml` | bottom-right shows WXML, highlighting correct |
| wx:for-item hover | hover `{{item.name}}` | `item — wx:for-item`, `Declared on <view> at line 3` |
| `<block wx:for>` hover | hover `{{grp.label}}` in the block | `grp — wx:for-item`, `Declared on <block> at line 32` |
| diagnostics | open `pages/home/home.wxml` | 1 warning (the fixture's missing-card) |
| go to definition | `editor: go to definition` on `<user-card>` | jumps to `components/user-card/user-card.wxml` |
| completion | trigger in `bind:select="handleSelect"` | `handleSelect method` candidate appears |
| live diagnostics | edit handler to `handleXSelect` | warning count 1→2, status bar `Event handler "handleXSelect" is not defined...`; undo restores |

The `<block wx:for>` hover is the most load-bearing case: it confirms
the `ebd5ffa` block_element regression fix works through the real host
path, not just at the extractor unit level. The live-diagnostics edit
confirms the `didChange` → overlay refresh chain (the fix that
un-froze save-frozen diagnostics, recorded above) holds under real
keystroke editing.

Working tree was clean (`git status --short --branch`) before and
after — a read-only dogfood, no fixture or source mutation. This is
the first UI-level validation; the offline verifier suite plus the two
programmatic dogfoods remain the canonical automated guard.

Outcome: **v1 complete.** Core features usable in real Zed, no
blockers. v2 backlog (getDefinition step 2a parity, completion /
diagnostics cursor-scope tightening, declaration-side hover) deferred
pending real-usage feedback.

---

### Follow-up: v2-A/D — wx:for definition parity + declaration-side hover (2026-05-26)

Picked the two **additive** items off the v1 backlog (the ones worth doing
without waiting for usage feedback, since they round out an existing model
rather than change diagnostics/completion semantics):

- **A — getDefinition step 2a parity.** cmd-click on `{{item}}` / `{{foo}}`
  in a wx:for body now returns a same-file `Location`. Explicit names jump to
  their `wx:for-item="foo"` / `wx:for-index="idx"` value range; default
  item/index jump to the `wx:for` attribute-name token. Closes the asymmetry
  where hover could *resolve and explain* a loop binding but definition
  produced no `Location` for that same resolution.
- **D — declaration-side hover.** Hovering an explicit `wx:for-item` /
  `wx:for-index` attribute value renders the same loop card as the use-site.
  The iterable `wx:for="{{users}}"` value still resolves `users` as data
  (the branch only fires inside explicit name ranges).

Spec `docs/superpowers/specs/2026-05-26-wxml-for-definition-parity-design.md`,
plan `docs/superpowers/plans/2026-05-26-wxml-for-definition-parity.md`. Shipped
across 5 commits (`5db6af9` extractor `wxForKeywordRange` → `2d34690` leaf
module → `ac1aaee` definition → `977904f` declaration hover → `20e82f7`
host-wire L-W2).

Two design decisions worth recording:

1. **Module architecture.** The wx:for resolver lived in `wxml-hover.mjs`, but
   `getDefinition` (in `wxml-language-service.mjs`) needed it too — and those
   two modules are already a circular pair (hover imports language-service
   helpers; language-service re-exports `getHover`). Rather than add a reverse
   import and deepen the cycle, the pure position→scope resolvers
   (`containsPosition`, `findMatchingWxForBinding`, plus the new
   `findWxForDeclarationAtPosition`) were extracted into a new dependency-free
   leaf module `server/wxml-for-scope.mjs`. This *removed* a hover→language-service
   edge instead of adding one. `findMatchingWxForBinding` moved verbatim
   (W-1..W-11 + L-W1 stay green, proving the move was behavior-preserving).

2. **Target-range selection is source-keyed, not presence-keyed.** The
   definition target is chosen by `itemSource`/`indexSource === "explicit"`
   (→ name range) vs implicit (→ `wxForKeywordRange`), **not** by
   `nameRange ?? wxForKeywordRange`. Because `wxForKeywordRange` is a new
   additive field with no `graph.version` bump, a legacy/hand-written graph
   may lack it; the source-keyed form means an explicit binding missing its
   nameRange degrades to fall-through (then a clean null) rather than wrongly
   jumping to the `wx:for` token. Locked by D-9 (implicit degrade) and D-10
   (explicit degrade) — both assert null without throwing.

**Zero-behavior-change invariant held:** completion (`getCompletions`) and
diagnostics (`expressionRefDiagnostics`) still read the flat `wxForBindings`
compat shim, untouched. W-7 byte-equal stays green; no new wx:for completion
or diagnostic case was added. v2-B (completion cursor-scope) and v2-C
(diagnostics cursor-scope, dogfood-gated) remain deferred.

Verification: narrow-ranges 15/15 (incl S-F9 + W-7), wasm baselines 8/8 (8
files now carry `wxForKeywordRange` additively), language-service all green
(W-1..W-11 + D-1..D-10 + HD-1..HD-3), lsp-diagnostics graph-smoke 21/21 (incl
new L-W2), full `verify-tree-sitter.sh` umbrella green. A final holistic review
returned SHIP with no Critical/Important findings. An independent high-effort
recall-biased code review (3 angles) returned zero findings — the two surviving
candidates (degrade fall-through to shadowed data; definition reads saved graph
not live overlay) both REFUTED as unreachable / pre-existing-by-design.

**chelaile A/D dogfood (2026-05-26).** Offline programmatic dogfood against the
real `mp-wx-chelaile/wx` checkout: built the project graph, then called
`getDefinition`/`getHover` directly (pure functions; the LSP transport is
covered separately by L-W1/L-W2), auto-discovering every `wx:for` scope across
the project and probing A (cmd-click a `{{itemName}}` use-site → same-file
Location) and D (hover an explicit `wx:for-item="X"` value → loop card). Result:
60 wxml files with `wx:for`; **A 83/83 pass, D 22/22 pass** (one A use-site
skipped — see below). No config written to chelaile; throwaway script kept under
`$TMPDIR`, deleted after the run; wxml-zed tree clean.

The one skipped A case (`cll-ad-self.wxml:5` `{{ad}}`) sits inside a
`<template name="ad-self">` body. Both `getDefinition` (`:985`) and `getHover`
(`:188`) early-return on `expressionRefMatch.inTemplateDefinition` **before** the
wx:for step-2a branch (`:991` / `:193`), so a loop binding referenced inside a
template definition gets neither definition nor hover. This is the pre-existing
template-body anti-noise suppression (refs inside `<template name>` resolve in
the *caller's* data scope at use-time, which we lack) applied uniformly — **not
a wx:for regression**. Design note: a wx:for loop variable inside a template body
is actually *lexically local* (the `wx:for` declares it right there, independent
of caller scope), so the suppression is over-broad for that specific case. A
future enhancement could run the wx:for-binding lookup before the
`inTemplateDefinition` return — but only for bindings whose scope lies within the
same template — and it needs its own design; logged in the v2 backlog, not part
of this round.

---

### Follow-up: wx:for definition + hover inside `<template name>` bodies (2026-05-26)

Closed the template-body gap the v2-A/D dogfood surfaced (above). The blunt
`inTemplateDefinition` early-return in `getDefinition` and `getHover` is replaced
by a same-template `wx:for` lookup: a loop variable referenced inside a template
body resolves **only** when the loop is declared within that same template;
data/property/wxs references stay suppressed (caller scope still unknown).

Spec `docs/superpowers/specs/2026-05-26-wxml-for-template-body-definition-design.md`,
plan `docs/superpowers/plans/2026-05-26-wxml-for-template-body-definition.md`.
Shipped across 3 commits (`216a49b` tpl-loops fixture → `a966336` getDefinition
branch + leaf helpers → `392e22d` getHover branch).

Design that made it small and safe:

- **Two pure leaf helpers** in `server/wxml-for-scope.mjs`:
  `findEnclosingTemplateRange(templateRanges, position)` (innermost = latest
  start, since template definitions never partially overlap) and
  `scopesDeclaredWithin(scopes, boundaryRange)` (keeps only scopes whose
  `wxForRange.start` — the `wx:for` declaration — falls within the template
  range). `findMatchingWxForBinding` is reused unchanged.
- **The boundary discriminator is the whole trick.** Two cases share the loop
  name `item`: an implicit loop declared *inside* `tpl-implicit` resolves; an
  outer `<view wx:for="{{groups}}">` that merely *encloses* `<template
  name="tpl-inner">` does not leak in, because its `wxForRange.start` is outside
  the `tpl-inner` range so `scopesDeclaredWithin` filters it out. WeChat
  templates don't capture the surrounding scope (only `data` passed at
  `<template is>`), so that outer-loop reference is genuinely a caller-data ref.
- **Template definitions are already in `fileModel.symbols`** as
  `{ kind: "template", range }` — no new extractor field, no `graph.version` bump.
- **Declaration-side hover was already working** (it runs through
  `findWxForDeclarationAtPosition`, downstream of the `inTemplateDefinition`
  gate) and was explicitly out of scope; T-13/T-14 guard that it stays working.

Scope held tight: `getDefinition`/`getHover` template branches are exact mirrors
(differing only in Location vs `makeWxForHover`); only the
`inTemplateDefinition === true` branch changed, so non-template resolution
(W-1..W-11, D-1..D-10, HD-1..HD-3), completion, and diagnostics are provably
untouched. The two near-identical template branches are acceptable duplication
for now; if a third template-body consumer ever appears, extract a shared
`resolveWxForInTemplate(fileModel, position, name)` then (deferred, per review).

Verification: 14 new cases T-1..T-14 (explicit/implicit item+index resolve,
data-ref suppressed, Case-2 no-leak, declaration-side regression) — all green;
narrow-ranges 15/15, wasm baselines 8/8 (new tpl-loops fixture added
additively; the stale `miniprogram (N fixtures)` label was de-hardcoded),
language-service + graph-smoke green, full `verify-tree-sitter.sh` umbrella
green. A final holistic review returned SHIP with zero findings after live
edge-probing (iterable-exclusion × template branch, Case-2 boundary arithmetic
on real ranges, template_definition-vs-usage `kind` collision).

### Follow-up: completion cursor-scope tightening (v2-B, 2026-05-26)

Closed the last gap on the wx:for depth line: hover/definition already resolved
loop bindings per-element via `wxForScopes[]`, but `{{ }}` completion still read
the flat file-level `wxForBindings` shim, so every loop's binding names were
suggested everywhere in the file. Now completion offers a loop binding only
inside that loop's active scope, matching hover/definition.

The primitive is one pure leaf helper, `activeWxForBindingsAt(scopes, position)`
in `server/wxml-for-scope.mjs`: reverse-scan (innermost-first), keep scopes whose
`scopeRange` contains the position but whose own `wxForRange` does NOT
(iterable-exclusion — an identifier inside `wx:for="{{x}}"` evaluates in the
outer scope), return each loop's `{name, kind}` item+index pair. Range-less
scopes skipped defensively. This is also the position→active-bindings primitive
v2-C will reuse for diagnostics.

`dataRefCompletionItems` gained a `position` param and now pushes active wx:for
bindings **first** — before data/property/wxs — so the `seen` first-wins dedup
gives an in-scope loop variable the candidate, shadowing a same-named
data/property/wxs symbol exactly as hover/definition do (wx:for is step 2a, ahead
of 2b/2c/2d). The load-bearing lock: with `data.item` present plus a default
loop, the cursor inside the loop offers `item` as `wx:for item`; outside any loop
it offers `item` as `data`. The old `hasAnyWxFor`-driven `item`/`index` injection
is gone — a default loop's `itemName`/`indexName` literally are `"item"`/`"index"`,
so they surface exactly (and only) inside that loop's scope.

Scope held: the `wxForBindings` shim is untouched (W-7 byte-equal green) and
still consumed by `expressionRefDiagnostics` — completion is just no longer one
of its readers; the shim retires only when v2-C migrates diagnostics. Template
bodies stay fully suppressed upstream in `interpolationCompletionContext`, so
`activeWxForBindingsAt` never runs there (B-7 locks this). Honest limitation:
completion runs against the live buffer for position but the saved graph for
`wxForScopes`, so an unsaved structural edit can momentarily under-offer a
binding — transient, self-heals on save, only ever omits a candidate.

Verification: 6 new unit cases B-U1..B-U6 (narrow-ranges 15→21, synthetic
scopes) + 7 integration cases B-1..B-7 (real `loops.wxml`/`tpl-loops.wxml` as
both sourceText AND graph, since synthetic cursors fall outside the real graph's
scope ranges) — all green; wasm baselines 8/8, language-service exit 0,
graph-smoke 21/21. Reviewed against the plan with zero findings: single call site
threads `position`, `wxForBindings` has exactly one remaining (diagnostics)
consumer, shadow parity confirmed. (GPT executed the 3-task plan; this review +
sweep confirmed it.)

### Follow-up: diagnostics cursor-scope tightening (v2-C, 2026-05-27)

Closed the wx:for depth line: with completion migrated in v2-B, the
`missing-expression-ref` diagnostic was the last consumer of the flat
file-level `wxForBindings` shim — it dumped every loop's binding names into one
file-wide scope, so a `{{item}}` written *outside* every loop was silently
accepted. v2-C makes diagnostics resolve loop bindings per ref, matching
hover/definition/completion.

`expressionRefDiagnostics` now builds a file-**global** scope (data + property +
wxs only) and, per ref, calls `activeWxForBindingsAt(fileModel.wxForScopes, {
line: ref.range.start.row, character: ref.range.start.column })` — accepting the
name iff it is global OR active at that exact position. The flat `wxForBindings`
block (incl. the `hasAnyWxFor`-driven `item`/`index` injection) is deleted from
the function. Diagnostics only judges *existence*, so no innermost-first ordering
is needed — `.some(b => b.name === ref.name)` suffices. Unlike completion there
is **no staleness window**: `expressionRefs` and `wxForScopes` come from the same
parse, so ref position and scope ranges are always consistent. The
`dead-component-binding` fall-through is untouched (the accept-check sits before
it). Message reworded to "…the wx:for scope at this position…".

Risk was *measured before* speccing, not assumed: a throwaway pre-scan
(`$TMPDIR`, read-only) counted refs that pass today but would warn under
per-position scoping. Result: our 17 graph fixtures → 0 newly-warned (every
loop-name ref is data-backed or in-loop); chelaile's real corpus (196 files, 331
loop-dependent refs) → **0** newly-warned. The feared "wave of red squiggles" on
real code does not exist — authors don't write loop vars outside loops (the page
wouldn't render). So it shipped as a plain `missing-expression-ref` Warning, no
severity downgrade, no new code; dogfood became a *confirmation* not a gate. The
post-impl re-scan reproduced fixtures=3 (the new `scope-leak` fixture's three
out-of-loop refs), chelaile=0.

New fixture `fixtures/miniprogram/pages/scope-leak/` is the only sample that
triggers a new warning (loop vars `row`/`x`/`z`/`grp` deliberately NOT
data-backed). Adding it to `fixtures/miniprogram` forced two *additive* baseline
updates the wasm `miniprogram` glob requires: regenerate
`miniprogram-symbols-baseline.json` and add a `W7_FROZEN_WX_FOR_BINDINGS` entry
(`{"items":["grp","row","x","z"],"indexes":[],"hasAnyWxFor":true}`) — a review
finding that would otherwise have reddened the suite. The extractor and the shim
*value* are unchanged (W-7 byte-equal green); the shim now has a comment marking
it has no runtime consumer (retirement is a dedicated later round). Verification:
E-1..E-7 (`getDiagnostics`-based, in `verify-wxml-language-service.mjs` — where
scope-logic tests live; wire-format is already covered by the protocol L-tests) +
the migrated `assertExpressionRefDiagnosticSyntheticForItemSuppresses` (now drives
suppression via a synthetic `wxForScope`, stronger than the old flat-items path);
narrow-ranges 21/21, wasm 8/8, language-service exit 0, graph-smoke 21/21,
umbrella green. 3 commits (`feb4285` fixture → `d47ff56` diagnostics+tests →
`42e2067` shim comment), subagent-driven (implementer + spec + code-quality per
task), final holistic review SHIP with zero Critical/Important findings.

### Follow-up: v2-B + v2-C real-Zed-UI dogfood (2026-05-27)

Both cursor-scope features validated in the actual Zed UI against real projects
(not just the offline verifiers); no regression, workspace left clean.

- **v2-B completion** (mp-wx-bus, `components/error-state/index.wxml`): inside the
  default loop `wx:for="{{msgList}}"`, typing `{{i` offered `index` (wx:for index)
  and `item` (wx:for item) with the correct detail labels; typing `{{i` *outside*
  the loop offered neither (only generic tag/keyword candidates). Confirms
  completion tightened from flat file-scope to cursor scope, and that the
  default-loop `item`/`index` names surface correctly in the real client.
- **v2-C diagnostics** (chelaile, `pages/main/fav-page/index.wxml`): the file
  already carried 1 diagnostic (a pre-existing genuinely-undefined ref —
  consistent with the pre-scan's ~9 absolute chelaile warnings). Temporarily
  inserting an out-of-loop `{{item}}` took the count 1→2, the new diagnostic
  reading `"item" is not defined … the wx:for scope at this position …`; undo
  returned it to 1. This is the path the offline `getDiagnostics` tests do NOT
  exercise — it runs through the **didChange overlay**, so the 1→2→1 cycle is
  real-environment proof that the overlay rebuilds `wxForScopes` *and*
  `expressionRefs` together from the live buffer with consistent positions (the
  "no staleness window" claim). It also confirms the reworded message renders in
  the real LSP wire path.
- **Hygiene:** all temporary edits reverted; `git diff` clean in wxml-zed,
  mp-wx-bus, and the two touched chelaile files (third-party projects never
  committed to).

This was the dogfood that v2-C's spec deferred to (downgraded from a go/no-go gate
to a confirmation, since the pre-scan had already measured ~0 real-world noise) —
now confirmed.

### Follow-up: `wxForBindings` compat shim retirement (2026-05-28)

With completion (v2-B) and diagnostics (v2-C) both migrated to `wxForScopes` +
`activeWxForBindingsAt`, the flat file-level `wxForBindings` shim had zero runtime
consumers — only the verifier still touched it. This round deleted it entirely:
the derivation IIFE, the `wxForLooseItems`/`wxForLooseIndexes` loose-attr
accumulators, and the dead `else` feeder branch in
`shared/wxml-symbol-extractor.mjs` (the branch only existed to preserve the legacy
quirk where a `wx:for-item` with no `wx:for` leaked a name into the shim — it
created no scope, so removing it changes nothing real); the CLI passthrough in
`scripts/extract-wxml-symbols.mjs`; and the W-7 byte-equal invariant + its frozen
map. The four S-F tests that read both the shim and `wxForScopes` (S-F5/F6/F7/F8)
were converted to assert only `wxForScopes` — the behaviors they guard
(loose→no scope, bare→implicit defaults, dynamic→implicit fallback, block→scope)
are all real `wxForScopes` properties, so coverage was preserved, not dropped.

The load-bearing guard: regenerating the 8 wasm baselines is self-fulfilling
(new extractor == new baseline) and can't prove "only `wxForBindings` was
removed" on its own. So the plan added a normalized pre/post check — strip every
`wxForBindings` key from both the pre-change snapshot and the regenerated baseline,
then `deepStrictEqual` — plus an explicit `grep` proving the key is gone. Both the
implementer and two independent reviewers ran it: across all 8 baselines, only
`wxForBindings` was removed, every other field byte-identical. `version: 1` was
deliberately NOT bumped (internal tool output; unread-field removal is
backward-safe, and a bump would itself perturb every baseline and pollute the
clean-diff guard). 2 commits (`5ab9a17` tests-first conversion → `537582f`
extractor+CLI+baselines), subagent-driven, final holistic review SHIP with zero
findings. `wxForScopes` is now the single source of truth for wx:for binding
scope across hover/definition/completion/diagnostics.

### Follow-up: publish-readiness #1 — self-contained LSP artifact (2026-05-28)

First step of the Zed-marketplace publish track. Zed's official rule (verified in
the docs) is that an extension providing a language server **must not ship the
server as part of the extension** — it must download or detect it. So before any
download glue, the gating unknown was simply: *can this Node LSP run outside its
repo at all?* This step de-risks exactly that, producer-only.

The LSP turned out to be a three-entry, two-hop spawn chain
(`wxml-lsp.mjs` → `extract-wxml-project-graph.mjs` → `extract-wxml-symbols.mjs`),
but every script anchors on its own `import.meta.url` and `wxml-lsp.mjs`'s
`EXTENSION_ROOT = dirname(server)/..`. So a **repo-runtime-subset artifact** that
preserves relative structure (`server/`, `shared/`, the two runtime `scripts/`,
`grammar/tree-sitter-wxml/…wasm`) plus a vendored `node_modules/web-tree-sitter`
runs with **zero code changes** — `EXTENSION_ROOT`/spawn-chain/wasm paths all
resolve, the bare `web-tree-sitter` import resolves from the artifact. `tree-sitter-javascript.wasm`
(loaded by the graph extractor to parse `.js`/`.ts` siblings) MUST travel too —
its absence soft-degrades (`WARN … configs[].script omitted`) and silently breaks
every JS-backed feature, so it was the load-bearing addition a review caught.

`scripts/build-lsp-artifact.mjs` assembles `dist/wxml-lsp-node/` (+ tarball);
`scripts/verify-lsp-artifact.mjs` is the proof: a hand-rolled minimal stdio LSP
client builds+unpacks under `$TMPDIR` **outside the repo subtree**, copies the
test mini-program project out too (artifact + cwd + project all detached), and
asserts a **JS-backed go-to-definition** (`handleSelect` → `home.js`) resolves
with no `JS wasm load failed` on stderr — plus a **negative control** that strips
the JS wasm from a copy and asserts the same definition then fails, proving the
smoke discriminates (an independent reviewer reproduced this). A resolve-probe
asserts `web-tree-sitter` resolves under the artifact, not the repo `node_modules`.
`version` synced into `package.json` + `package-lock.json` (no bump-driven
lockfile drift); `dist/` git-ignored. 2 commits (`77cd4df` packaging →
`c6f9037` smoke), subagent-driven, final holistic review SHIP with zero
Critical/Important findings.

**Deferred (the rest of the publish track):** Zed extension download/cache/launch
glue (`src/lib.rs` + `zed::latest_github_release`/`download_file`), repo split
(slim extension repo vs this LSP/tooling repo), grammar public repo + repin
`extension.toml` off the `file:///tmp` path, GitHub Release automation,
README/license-caveat fix (MIT + NOTICE already satisfy redistribution; the
"needs upstream authorization" line is over-cautious). Node-on-PATH stays a
documented prerequisite (no binary-ization this round).

### Follow-up: publish-readiness #2 — extension external LSP launch (2026-05-28)

Rewrote the extension's `src/lib.rs` `language_server_command` to launch the
**external** artifact instead of the in-repo `server/wxml-lsp.mjs` (the
Zed-forbidden bundled-server path, now removed). Three-branch total function:
(1) `WXML_ZED_LSP_ARTIFACT_DIR` (env → `node $dir/server/wxml-lsp.mjs`, the
dogfood-validated dev path); (2) GitHub Release download/cache (skeleton:
`latest_github_release` → exactly-one asset `wxml-lsp-node-v<ver>.tar.gz` →
`download_file(GzipTar)` into a version-keyed cache dir gated on the entry FILE
existing → launch; full `CheckingForUpdate`/`Downloading`/`None`/`Failed` status
lifecycle; raw cause wrapped, never leaked); (3) one actionable error. README
gained a "Running the LSP (development)" section. 2 commits (`532ae69` local+remove
in-repo, `56e58d8` download skeleton), subagent-driven, final holistic review SHIP
zero Critical/Important. The plan's Rust was pre-compiled against the real
`zed_extension_api` 0.7.0 before execution; gate = `CARGO_TARGET_DIR="$PWD/target"
cargo build --release --target wasm32-wasip1 --offline` (the target-dir override is
required — the machine's `~/.cargo/config` points the default target dir outside
the sandbox-writable area).

**Validation model (different from the LSP work):** `src/lib.rs` only runs inside
Zed, so the automated gate is just "compiles to wasm". Real functional proof was
manual Zed dogfood: build artifact → unpack → set env → reinstall/reload the dev
extension → confirm the LSP starts from the **artifact** path (not in-repo) and a
JS-backed feature works.

**Dogfood result (2026-05-28):** first launch hit the expected environment caveat:
an already-running Zed instance ignored the new shell env and fell through to the
GitHub Release skeleton (404, clean actionable error). After quitting Zed and
relaunching from the env-bearing shell, the extension saw
`WXML_ZED_LSP_ARTIFACT_DIR`, but the wasm-side `entry.is_file()` check falsely
reported the valid `/tmp/.../wxml-lsp-node/server/wxml-lsp.mjs` as missing. This
triggered Contingency C1; the local artifact branch now launches
`node $WXML_ZED_LSP_ARTIFACT_DIR/server/wxml-lsp.mjs` without statting the absolute
path. Reinstalling the dev extension then started the LSP from
`/tmp/wxml-zed-dogfood.mPhENh/wxml-lsp-node/server/wxml-lsp.mjs`, and F12 on
`bindtap="openByNavigateTo"` in `/Users/zs/Desktop/demo/pages/index/index.wxml`
jumped to `pages/index/index.js::openByNavigateTo(e)`.

**Pending / deferred (carried for later publish steps):**
- **Contingency C1 applied** — the local branch's `is_file()` on an arbitrary
  absolute path was blocked by the wasm fs sandbox during dogfood, so the branch now
  launches directly and intentionally drops the friendly invalid-env stat check.
- **download path not validated e2e** — no GitHub Release exists; it fails cleanly.
- **download-path `is_file()` is now suspect (direct corollary of C1)** — dogfood
  proved wasm `is_file()` is unreliable for an *arbitrary absolute* path. The
  download branch still uses `is_file()` twice (cache-hit check + post-extract
  verify) on *work-dir-relative* paths (`src/lib.rs:59,71`). Relative paths are the
  standard Zed pattern (the work dir is WASI-preopened, so they *should* work — a
  different case than the absolute one that failed), but this is UNVERIFIED. The
  dangerous one is line 71: if relative `is_file()` also misfires here, the
  post-extract verify would falsely `Err("…missing after extract")` even on a
  successful download → the download path would never start. **When the download
  path is dogfooded (after a real release exists), test these two `is_file()` calls
  specifically; if they misfire, drop/replace them like C1 did for the absolute path.**
- **deferred download-path hardening** (when it goes live, code-quality review
  flagged, non-blocking now): guard `cache_dir` against path-traversal if a release
  tag is ever malformed; consider `to_str().ok_or(...)` instead of
  `to_string_lossy()`; the `release.version` borrow is fine as-is.
- **`LSP_REPO = "zscumt123/wxml-zed"` is a placeholder** — backfill when the real
  public LSP/extension repos are decided (the repo-split step).

### Follow-up: publish-readiness #3 — grammar public repo + extension.toml repin (2026-05-28)

Removed the last hard *config* blocker on the grammar side: `extension.toml`'s
`[grammars.wxml]` no longer points at `file:///private/tmp/...` (unpublishable +
reboot-fragile). The vendored `grammar/tree-sitter-wxml/` was already a complete,
buildable tree-sitter repo (`grammar.js` + committed `src/parser.c`/`scanner.c`/
`grammar.json`; `.gitignore` keeps sources + `!tree-sitter-wxml.wasm`); it only
lacked a LICENSE. In-repo prep (`729863d`): added MIT `LICENSE` (BlockLune original
+ zscumt123 modifications) + provenance `NOTICE`, and synced the repository
coordinate in BOTH `tree-sitter.json` (`metadata.links.repository`, the
authoritative grammar metadata) and `package.json`. Then the grammar dir was
published to **`github.com/zscumt123/tree-sitter-wxml`** (user-driven ops — the
agent's `git push` was blocked by the harness permission layer even with the
sandbox off, so the user pushed the agent-prepared standalone commit). Repin
(`0b8bd7a`): `extension.toml` → `repository = "https://github.com/zscumt123/tree-sitter-wxml"`,
`rev = "fef7ea7277adba1cc697afd01c588da8c2c6e944"`; no `file://` remains.

Conservative model held: wxml-zed keeps its vendored grammar source as
source-of-truth (public repo published from it); NOT a submodule; LSP
`tree-sitter-wxml.wasm` path untouched. Deferred (explicit): the grammar's other
ecosystem coords (`Cargo.toml`/`pyproject.toml`/`CMakeLists.txt`/`Makefile`/`go.mod`/
Go import path) still point at BlockLune — not Zed/tree-sitter blockers, left for a
later package-publishing cleanup. Vendored copy ↔ public repo can drift until a
later de-dup decision; vendored copy is canonical and re-pushed when it changes.

Validation: in-repo green (buildable sources not gitignored; no `file://` after
repin; full offline suite — narrow-ranges 20/20, wasm 8/8, language-service exit 0,
lsp-artifact exit 0 — unaffected). **PENDING: manual Zed dogfood** — confirm Zed
clones+builds the grammar from the public repo at `fef7ea7` (not `file:///tmp`) and
WXML highlight/outline render.

**publish #3 dogfood PASSED (2026-05-29):** Zed re-checked-out/compiled the grammar
from the public repo at `fef7ea7` (log: `checking out → compiling → compiled wxml
parser`); `grammars/wxml` origin=public repo, HEAD=`fef7ea7`, wasm regenerated;
`index.wxml` + `fixtures/test.wxml` highlight correctly, status bar = WXML, Outline
lists declarations. **Cache caveat (ops):** Zed keys the grammar cache by grammar
*name* (`wxml`), so a repin (repo/rev change) does NOT auto-invalidate a stale local
clone — first install failed on the old `file:///private/tmp/...` clone; moving aside
`grammars/wxml` and reinstalling rebuilt at the new rev. **No impact on fresh
marketplace users** (clean clone); only local dev migration / future rev bumps.

---

## Publish-readiness #4 — monorepo split (`packages/zed/`) + Release CI (2026-05-29)

Goal: make the repo marketplace-publishable and make the `src/lib.rs` GitHub-Release
download path real. Single GitHub repo; the Zed extension surface moved into a slim
`packages/zed/` subdirectory (marketplace submodule will use `path = "packages/zed"`);
repo root stays the LSP/tooling source + Release emitter (`LSP_REPO="zscumt123/wxml-zed"`
unchanged). Subagent-driven, 3 tasks, each with spec + code-quality review, then a final
holistic review. Commits `976daed`→`36d818d`.

- **Task 1 (`976daed`):** `git mv` extension surface (extension.toml, Cargo.toml,
  Cargo.lock, src/lib.rs, languages/wxml/, snippets/) → `packages/zed/`; copied
  LICENSE+NOTICE there (root LICENSE says "See NOTICE for provenance" — both must
  travel together); Cargo version 0.2.0→0.3.0; repointed the two verifiers that
  hardcoded root-relative query/snippet paths (`verify-tree-sitter.sh` via a new
  `EXTENSION_DIR`, `verify-wxml-builtins.mjs:9`). Atomic so the sweep that gates the
  commit stays green. Full offline sweep green incl. `verify-tree-sitter.sh`
  (`wxml-zed tree-sitter verification passed`) + cargo wasm compile clean.
- **Task 2 (`0e6e375`,`6a2f22d`):** slim `packages/zed/README.md` + minimal root README
  correction (repoint moved paths, drop stale `file:///private/tmp` grammar block,
  rewrite over-cautious Redistribution Status, update Project Layout); hedged the
  LSP-download wording (no Release exists yet).
- **Task 3 (`678fed0`,`51da96e`):** `.github/workflows/release.yml` — tag-triggered
  (`v*.*.*`), **four-way version-consistency guard** (package.json / extension.toml /
  Cargo.toml / tag all == version), order **verify→build→upload** (`verify-lsp-artifact.mjs`
  is the gate; broken tarball never published), idempotent release step
  (`gh release view` → `upload --clobber` else `create`). Guard logic proven locally
  (positive: all four = 0.3.0; negative: rejects v0.4.0) — the part CI can't test
  without pushing.
- **Final-review post-fixes (`36d818d`):** dev-install README step now points at
  `packages/zed/` (was "the repository directory" — would fail post-move); `.gitignore`
  `/target`→`target` (root-anchored pattern missed `packages/zed/target/`).

End-to-end asset-name chain verified consistent for a `v0.3.0` tag: package.json 0.3.0
→ `build-lsp-artifact.mjs` emits `dist/wxml-lsp-node-v0.3.0.tar.gz` → CI uploads
`wxml-lsp-node-${GITHUB_REF_NAME}.tar.gz` → `lib.rs` reconstructs
`wxml-lsp-node-v0.3.0.tar.gz`.

**Handed-to-user ops (agent can't push/cut Release):** (A) dogfood the moved extension
(remove old root-installed dev extension, reinstall from `packages/zed/`, confirm
highlight/outline); (B) `git tag v0.3.0 && git push origin v0.3.0` → CI → confirm Release
carries the tarball; (C) download-path dogfood (unset `WXML_ZED_LSP_ARTIFACT_DIR`, confirm
extension downloads + launches LSP) — **watch the two relative `is_file()` lines in
`packages/zed/src/lib.rs`**; C2-a/C2-b standby patches in the plan if they misfire.

**Regression anchor for parse-error case:** `fixtures/wasm-spike/edge-recovery-symbols-baseline.json` is the committed snapshot of that output. It is verified automatically by `scripts/verify-wasm-symbol-baselines.mjs` (one of 6 cases — the others lock in the legacy-equivalent behavior on home/miniprogram/test.wxml/real-world plus the UTF-16 column verification on non-ascii.wxml). The verifier is wired into `scripts/verify-tree-sitter.sh`, so the umbrella verification suite catches both kinds of regression: (a) the legacy-equivalent baselines drifting, and (b) parse-error tolerance reverting to exit-1.

For ad-hoc local verification of just the parse-error case:
```bash
node scripts/extract-wxml-symbols.mjs fixtures/real-world/edge-recovery.wxml > /tmp/edge.json
diff /tmp/edge.json fixtures/wasm-spike/edge-recovery-symbols-baseline.json
echo "exit code should be 0, baseline should be unchanged"
```

If a future change wants to **add** symbol extraction from recovered tree shapes (e.g. teach the extractor about `wxs_fallback`), the baseline updates and the rationale gets recorded here. The verifier catches the change at CI time so the decision is explicit.
