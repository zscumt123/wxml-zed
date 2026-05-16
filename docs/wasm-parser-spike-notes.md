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
