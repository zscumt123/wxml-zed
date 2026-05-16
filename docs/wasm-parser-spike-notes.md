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
