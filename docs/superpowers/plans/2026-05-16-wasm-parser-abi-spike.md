# WASM Parser ABI Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify a working `tree-sitter-cli` + `web-tree-sitter` minor-version pair, build a WXML wasm parser from the vendored grammar, and prove the wasm loads in Node with a matching `LANGUAGE_VERSION`. This is step 1 of an 8-step plan to replace the runtime `npx tree-sitter-cli parse --cst` shell-out (currently 60s for 10 files in `fixtures/miniprogram`) with an in-process WASM parser.

**Architecture:** Default to the minor version line that the vendored grammar was tested against (`tree-sitter-cli ^0.25.8` per `grammar/tree-sitter-wxml/package.json`). Use the matching `web-tree-sitter@0.25.x`. Only escalate to a newer minor (0.26.x) if 0.25.x fails the ABI load. Build wasm with `tree-sitter build --wasm --docker` (local Docker is available; no Emscripten needed). Persist `web-tree-sitter` as a real devDependency in a new root `package.json` so the committed smoke script runs on a fresh clone. Smoke script discovers the actual ABI surface at runtime (logs both `language.version`/`language.abiVersion` and any package-level `LANGUAGE_VERSION`/`MIN_COMPATIBLE_VERSION` exports) instead of asserting a specific field name. Steps 2-8 of the broader spike (extractor rewrite, full fixture compare, profile re-run, LSP suite) are out of scope and will be re-planned after step 1's outcome.

**Tech Stack:** `tree-sitter-cli` (via `npx`, locked to grammar's tested minor), `web-tree-sitter` (real devDependency in new root `package.json`), Docker (already installed: 28.5.2), Node.js ESM.

**Out of scope:**
- Modifying `scripts/extract-wxml-symbols.mjs` or `extract-wxml-project-graph.mjs`
- Touching `server/wxml-lsp.mjs`
- Performance comparison vs. current CLI fork path

---

## File Structure

- Create: `package.json` (new at repo root; declares `web-tree-sitter` devDep, sets `"type": "module"`)
- Create: `package-lock.json` (npm install side effect — must commit for reproducibility)
- Modify: `.gitignore` (add `/node_modules`)
- Create: `scripts/verify-wasm-parser.mjs`
  - Loads `grammar/tree-sitter-wxml/tree-sitter-wxml.wasm` via `web-tree-sitter`
  - Parses `fixtures/miniprogram/pages/home/home.wxml`
  - Discovers and prints whatever ABI fields the loaded `web-tree-sitter` exposes (does not hardcode `language.version` vs `language.abiVersion`)
  - Exits 1 on any error (load failure, parse failure, root node has errors, no recognizable ABI field)
- Create: `grammar/tree-sitter-wxml/tree-sitter-wxml.wasm` (build artifact; ~MB binary)
- Create: `docs/wasm-parser-spike-notes.md`
  - Record the chosen `tree-sitter-cli` + `web-tree-sitter` versions and whatever ABI fields the smoke run discovered
  - Note any version pairs tried and rejected, with the error message

---

### Task 1: Pick a Compatible Version Pair (default 0.25.x)

**Files:**
- None yet (research only; decision recorded in Task 5)

**Selection rule (in order — do not skip):**
1. **Default to the grammar's tested minor: 0.25.x.** `grammar/tree-sitter-wxml/package.json` declares `tree-sitter-cli ^0.25.8`. The grammar source was last verified against this minor. Do NOT pick a higher minor just because it exists.
2. Only escalate to 0.26.x if Task 2 build OR Task 5 load fails on 0.25.x with an ABI/incompatibility error. Document the failure first.

**Steps:**
- [ ] Run `npm view tree-sitter-cli@0.25 version --json`. Note: use `version` (singular), not `versions` — the plural form with a range argument returns one full versions array **per matching version** (nested + repeated, mixing 0.23.x–0.26.x output), which is misleading. The singular form returns a clean flat list of 0.25.x patches.

  Expected as of 2026-05-16 (from a local check): `["0.25.0", "0.25.1", ..., "0.25.10"]`. Pick the highest patch. Call it `CLI_VERSION`. If reality differs from the expected list, follow the rule (highest 0.25.x patch), not the example.
- [ ] Run `npm view web-tree-sitter@0.25 version --json`. Same rule — singular, clean list.

  Expected as of 2026-05-16: `["0.25.0", ..., "0.25.10"]`. Pick the highest patch. Call it `WEB_VERSION`.
  - Patch numbers between the two packages do NOT need to match. Same minor is what matters.
  - If `npm view web-tree-sitter@0.25 version --json` returns `[]` or errors, this is a real signal — `web-tree-sitter` may not have shipped 0.25.x. Stop and re-plan rather than silently jumping to 0.26.
- [ ] Write the chosen pair into `docs/wasm-parser-spike-notes.md` immediately (don't wait for Task 5) — even before build, so the version selection is auditable.

### Task 2: Build the WASM Artifact

**Files:**
- Create: `grammar/tree-sitter-wxml/tree-sitter-wxml.wasm`

- [ ] Confirm Docker is running: `docker ps` (should not error).
- [ ] From `grammar/tree-sitter-wxml/`, run:
  ```bash
  npx -y tree-sitter-cli@<CLI_VERSION> build --wasm --docker
  ```
  This pulls an Emscripten Docker image on first run (slow), then emits `tree-sitter-wxml.wasm` in the current directory.
- [ ] Verify the artifact exists and is non-empty:
  ```bash
  ls -lh grammar/tree-sitter-wxml/tree-sitter-wxml.wasm
  ```
  Expected: a file in the 100KB-2MB range.
- [ ] Verify it's a valid wasm binary header:
  ```bash
  xxd grammar/tree-sitter-wxml/tree-sitter-wxml.wasm | head -1
  ```
  Expected: starts with `0061 736d` (the WASM magic number `\0asm`).

If `tree-sitter build --wasm --docker` fails with an unrecognized flag, the chosen CLI version may be too old. Older CLIs use `tree-sitter build-wasm` (no space). Try that form before changing CLI versions.

### Task 3: Set Up Root npm Scaffolding

**Files:**
- Create: `package.json`
- Create: `package-lock.json` (npm install side effect)
- Modify: `.gitignore`

This task makes the committed smoke script runnable on a fresh clone via `npm install`. Without it, `--no-save` would leave an untracked `node_modules/` and break `git status` cleanness, and a fresh clone could not run the script at all.

- [ ] Append `/node_modules` to `.gitignore`. Current contents are `/grammars`, `/target`, `extension.wasm` — append `/node_modules` as a fourth line.
- [ ] Create `package.json` at repo root:
  ```json
  {
    "name": "wxml-zed",
    "private": true,
    "type": "module",
    "devDependencies": {
      "web-tree-sitter": "<WEB_VERSION_FROM_TASK_1>"
    }
  }
  ```
  Use an exact version (no caret) to keep the ABI pair pinned. Substitute `<WEB_VERSION_FROM_TASK_1>` with the patch chosen in Task 1.
- [ ] Run `npm install`. Expected: creates `node_modules/` and `package-lock.json`. Should not warn about engines or peer conflicts (web-tree-sitter has no required peers).
- [ ] Verify `node_modules/web-tree-sitter/` exists and contains either `tree-sitter.js` (older) or `web-tree-sitter.js` (newer). Note which file is present — this confirms the package layout for Task 4's import statement.
- [ ] Verify `git status` shows only `.gitignore` modified and `package.json` + `package-lock.json` as new files (no `node_modules/` should appear since gitignore now excludes it).

### Task 4: Write the Smoke Load Script (ABI-discovery, not assertion)

**Files:**
- Create: `scripts/verify-wasm-parser.mjs`

The script must NOT hardcode whether ABI is exposed as `language.version`, `language.abiVersion`, or via package-level exports. The web-tree-sitter API surface differs between minor versions. Instead, **enumerate all plausible fields and let the run reveal which exist**.

- [ ] Create `scripts/verify-wasm-parser.mjs`:

  ```js
  import path from "node:path";
  import { fileURLToPath } from "node:url";
  import fs from "node:fs/promises";
  import * as TreeSitter from "web-tree-sitter";

  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const WASM = path.join(ROOT, "grammar/tree-sitter-wxml/tree-sitter-wxml.wasm");
  const FIXTURE = path.join(ROOT, "fixtures/miniprogram/pages/home/home.wxml");

  function pickNumeric(obj, names) {
    for (const name of names) {
      const value = obj?.[name];
      if (typeof value === "number") return { name, value };
    }
    return null;
  }

  async function main() {
    const Parser = TreeSitter.Parser ?? TreeSitter.default;
    const Language = TreeSitter.Language ?? Parser?.Language;
    if (!Parser || !Language) {
      throw new Error(`web-tree-sitter API surface unrecognized; exports: ${Object.keys(TreeSitter).join(", ")}`);
    }

    await Parser.init();
    const language = await Language.load(WASM);
    const parser = new Parser();
    parser.setLanguage(language);

    const source = await fs.readFile(FIXTURE, "utf8");
    const tree = parser.parse(source);

    const moduleExports = Object.keys(TreeSitter);
    const languageKeys = Object.keys(language);
    const abiOnLanguage = pickNumeric(language, ["abiVersion", "version", "languageVersion"]);
    const runtimeAbi = pickNumeric(TreeSitter, ["LANGUAGE_VERSION"]);
    const minCompat = pickNumeric(TreeSitter, ["MIN_COMPATIBLE_VERSION", "MIN_COMPATIBLE_LANGUAGE_VERSION"]);

    const report = {
      moduleExports,
      languageKeys,
      abiOnLanguage,
      runtimeAbi,
      minCompat,
      rootType: tree.rootNode.type,
      rootNamedChildCount: tree.rootNode.namedChildCount,
      rootHasError: tree.rootNode.hasError,
      sourceBytes: Buffer.byteLength(source, "utf8"),
    };

    console.log(JSON.stringify(report, null, 2));

    const failures = [];
    if (tree.rootNode.hasError) failures.push("rootNode.hasError = true");
    if (!abiOnLanguage) failures.push("no numeric ABI/version field on language");
    if (runtimeAbi && abiOnLanguage && abiOnLanguage.value > runtimeAbi.value) {
      failures.push(`wasm ABI ${abiOnLanguage.value} exceeds runtime LANGUAGE_VERSION ${runtimeAbi.value}`);
    }
    if (minCompat && abiOnLanguage && abiOnLanguage.value < minCompat.value) {
      failures.push(`wasm ABI ${abiOnLanguage.value} below runtime MIN_COMPATIBLE ${minCompat.value}`);
    }
    if (failures.length) {
      console.error("FAIL:", failures.join("; "));
      process.exit(1);
    }
  }

  main().catch((err) => {
    console.error("FAIL:", err?.message || err);
    process.exit(1);
  });
  ```

- [ ] Run `node --check scripts/verify-wasm-parser.mjs`. Expected: no output, exit 0.

### Task 5: Run the Smoke and Record Outcome

**Files:**
- Create: `docs/wasm-parser-spike-notes.md` (or append to it if Task 1 already wrote the version pair there)

- [ ] Run the smoke:
  ```bash
  node scripts/verify-wasm-parser.mjs
  ```
- [ ] **Pass criteria** (exit 0 plus all of):
  - `abiOnLanguage` is non-null with a numeric value (whichever field name was found — `version`, `abiVersion`, etc.)
  - `rootHasError` is `false`
  - `rootNamedChildCount` > 0
  - If both `runtimeAbi` (package-level `LANGUAGE_VERSION`) and `minCompat` are present, `abiOnLanguage.value` is within `[minCompat.value, runtimeAbi.value]`
- [ ] **If load fails** with anything resembling `Incompatible language version`: record the exact error and the JSON report (or stack trace) in the notes doc. Then per the Task 1 escalation rule, switch both sides to 0.26.x, redo Task 2 build + Task 3 npm install + this run. Do not skip recording the failure.
- [ ] Update `docs/wasm-parser-spike-notes.md` with:
  - Final chosen `CLI_VERSION` and `WEB_VERSION` (exact, with patch)
  - The full JSON report from the successful run
  - Which ABI field name was discovered on `language` (record `abiOnLanguage.name` so the future extractor rewrite knows what to use)
  - Any rejected pairs and their error messages
  - One sentence: "Step 1 of the WASM spike passed; extractor rewrite is unblocked."

### Task 6: Commit

- [ ] Inspect what's pending:
  ```bash
  git status
  ```
  Expected unstaged/new files: `.gitignore` (modified), `package.json`, `package-lock.json`, `grammar/tree-sitter-wxml/tree-sitter-wxml.wasm`, `scripts/verify-wasm-parser.mjs`, `docs/wasm-parser-spike-notes.md`, `docs/superpowers/plans/2026-05-16-wasm-parser-abi-spike.md`. **`node_modules/` MUST NOT appear** (gitignore catches it). If it does appear, fix `.gitignore` first and re-check.
- [ ] Stage explicitly (no `git add .`):
  ```bash
  git add .gitignore package.json package-lock.json \
          grammar/tree-sitter-wxml/tree-sitter-wxml.wasm \
          scripts/verify-wasm-parser.mjs \
          docs/wasm-parser-spike-notes.md \
          docs/superpowers/plans/2026-05-16-wasm-parser-abi-spike.md
  ```
- [ ] Verify nothing else is staged:
  ```bash
  git diff --cached --stat
  ```
  Expected: exactly the 7 files above.
- [ ] Commit:
  ```bash
  git commit -m "$(cat <<'EOF'
  spike: verify wasm parser ABI with web-tree-sitter

  Step 1 of replacing the per-file `npx tree-sitter-cli` shell-out with
  an in-process wasm parser. Builds tree-sitter-wxml.wasm via
  tree-sitter-cli docker mode, pins web-tree-sitter as a real devDep
  for reproducibility, and runs an ABI-discovery smoke that records
  whichever language/version field the loaded runtime exposes.
  Extractor rewrite stays out of scope until this load passes.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```
- [ ] Verify clean: `git status` should show nothing to commit and no untracked files (`node_modules/` excluded by gitignore).

---

## Self-Review

**Spec coverage:**
- Match grammar's tested toolchain (0.25.x default, 0.26.x only on failure) → Task 1 ✅
- Build wasm without local Emscripten → Task 2 (uses `--docker`) ✅
- Reproducible deps (real devDep, gitignored node_modules, locked patch) → Task 3 ✅
- ABI-discovery smoke that doesn't bet on a specific field name → Task 4 ✅
- Verify load via `web-tree-sitter` ABI-correctly → Task 5 ✅
- Document chosen pair AND discovered ABI field name → Tasks 1, 5 ✅
- Single commit covering scaffold + wasm + smoke + doc → Task 6 ✅
- Out-of-scope items (extractor changes, debounce, perf compare) explicitly excluded ✅

**Placeholders:** `CLI_VERSION` and `WEB_VERSION` are Task 1 outputs (explicitly required to be written into the notes doc immediately), substituted into Tasks 2-3 commands. `<WEB_VERSION_FROM_TASK_1>` in the `package.json` template is the same value. No silent TBDs.

**Type consistency:** The smoke script uses defensive lookup (`TreeSitter.Parser ?? TreeSitter.default`, `pickNumeric` over candidate field name lists) precisely because the `web-tree-sitter` API surface is not consistent across minors. Task 4 will not fail spuriously on field-name guessing.

**Known fragility documented in plan:**
- WXML grammar's root node type is recorded, not asserted (Task 5 just records `rootType`)
- ABI field name on `language` is discovered, not hardcoded (Task 4 enumerates `abiVersion`, `version`, `languageVersion`)
- Module export shape is discovered (`Parser ?? default`)
- 0.25.x → 0.26.x escalation is explicit, not silent
