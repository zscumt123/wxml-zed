# WASM Symbol Extractor Fixture Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the wasm-based POC (`scripts/poc-wasm-symbols.mjs`) to process all 11 WXML fixtures in `fixtures/miniprogram/` in a single invocation, match the legacy extractor's combined multi-file JSON output, and freeze that combined baseline. This is step 3 of the 8-step plan; step 2 already proved single-file equivalence for `home.wxml`.

**Architecture:** Teach the POC to accept N file args (currently single arg) and emit `{ version: 1, files: [...] }` with one entry per arg, in arg order — matching the legacy extractor's behavior. Generate the legacy extractor's combined output for all 11 fixtures using the same known-good env from step 2 (NO_COLOR, writable WXML_ZED_HOME, working npx cache binary). Freeze the result. Run POC with the same arg list. Compare with the existing structural diff harness (with a small enhancement so per-file diffs report the offending file's `path` instead of just an array index).

**Risk-coverage matrix (what step 3 verifies and what stays deferred):**

| Path | home.wxml (step 2) | After step 3 | Notes |
|---|---|---|---|
| import_statement / include_statement / wxs_external | ✅ | ✅ | More instances across fixtures |
| static `template_usage` | ✅ | ✅ | More instances |
| hyphenated component candidates | ✅ | ✅ | More instances; reserved-tag filter retested |
| `template_definition` → symbols.template | implemented, unverified | ✅ | 3 fixtures have these |
| Dynamic `<template is="{{expr}}">` | unverified | **still unverified** | 0 fixtures use this — needs synthetic fixture (deferred to a later step) |
| UTF-16 vs byte column units | not exercised | **still not exercised** | 0 fixtures have non-ASCII — also needs synthetic fixture |
| Multi-file output ordering | N/A | ✅ | New: arg-order preservation in `files: [...]` |

**Out of scope:**
- Modifying `scripts/extract-wxml-symbols.mjs` (step 4)
- Modifying `scripts/extract-wxml-project-graph.mjs` or `server/wxml-lsp.mjs`
- Adding synthetic fixtures for dynamic-is or multi-byte coverage — those go in a later focused step if the deferred risks bite
- Performance comparison (step 5 territory)

**Tech Stack:** No new dependencies. Same `web-tree-sitter@0.25.10` and Node ESM. Legacy extractor is invoked as a subprocess (same as step 2) only for baseline freezing.

---

## File Structure

- Modify: `scripts/poc-wasm-symbols.mjs`
  - Accept N positional file args (currently 1)
  - Emit one `files[]` entry per arg, preserving arg order
  - Single shared `Parser`/`Language` instance across all files (init + load once)
- Modify: `scripts/diff-symbols-baseline.mjs`
  - When sorting arrays of objects with `.path` (no `.range`), sort by `.path`
  - When reporting a diff, include the `.path` of the enclosing file entry if the divergence is below a `files[i]` boundary, e.g. `$.files[fixtures/miniprogram/templates/common.wxml].symbols[0].name: X vs Y`
- Create: `fixtures/wasm-spike/miniprogram-symbols-baseline.json`
  - Legacy extractor's combined output for all 11 fixtures (one invocation, all 11 files passed)
  - Committed verbatim
- Modify: `docs/wasm-parser-spike-notes.md`
  - Append "Step 3 outcome" section

---

### Task 1: Extend POC to Multi-File

**Files:**
- Modify: `scripts/poc-wasm-symbols.mjs`

- [ ] Replace single-arg handling with N-arg loop. Specifically, change the `main` function so it:
  1. Initializes `Parser` and `Language` **once** (not per file)
  2. Iterates over `process.argv.slice(2)`, parsing each file, appending one entry to `files[]`
  3. Preserves arg order (do NOT sort `files[]`)

  Reference shape of the modified main (write the full function, not a sketch):
  ```js
  async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      console.error("Usage: node scripts/poc-wasm-symbols.mjs <file.wxml> [<file2.wxml> ...]");
      process.exit(1);
    }

    await Parser.init();
    const language = await Language.load(WASM);
    const parser = new Parser();
    parser.setLanguage(language);

    const files = [];
    for (const arg of args) {
      const inputAbs = path.resolve(process.cwd(), arg);
      const inputRel = path.relative(process.cwd(), inputAbs);
      const source = await fs.readFile(inputAbs, "utf8");
      const tree = parser.parse(source);

      const { dependencies, symbols } = collectDependenciesAndSymbols(tree.rootNode, inputAbs);
      const references = collectReferences(tree.rootNode);
      const components = collectComponents(tree.rootNode);

      dependencies.sort(byPosition);
      symbols.sort(byPosition);
      references.sort(byPosition);
      components.sort(byPosition);

      files.push({ path: inputRel, dependencies, symbols, references, components });
    }

    console.log(JSON.stringify({ version: 1, files }, null, 2));
  }
  ```

- [ ] Verify syntax: `node --check scripts/poc-wasm-symbols.mjs`. Expected: exit 0.
- [ ] Verify single-file still works (regression check against step 2 baseline):
  ```bash
  node scripts/poc-wasm-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > "$TMPDIR/poc-home-regression.json"
  node scripts/diff-symbols-baseline.mjs "$TMPDIR/poc-home-regression.json" fixtures/wasm-spike/home-symbols-baseline.json
  ```
  Expected: `OK: structurally equivalent`. If this fails, the multi-file refactor broke single-file output and Task 2 cannot proceed.

### Task 2: Enhance Diff Harness for Multi-File Diagnostics

**Files:**
- Modify: `scripts/diff-symbols-baseline.mjs`

Two enhancements: (a) sort `files: [...]` by `.path` for deterministic comparison, (b) make the diff output mention the file path when divergence is inside a `files[i]` subtree.

- [ ] Update `sortDeterministic` to prefer `.path` for objects that have it (in addition to current `.range.start`):
  ```js
  function sortDeterministic(value) {
    if (Array.isArray(value)) {
      const sorted = value.map(sortDeterministic);
      sorted.sort((a, b) => {
        if (typeof a?.path === "string" && typeof b?.path === "string" && a.path !== b.path) {
          return a.path.localeCompare(b.path);
        }
        const ar = a?.range?.start, br = b?.range?.start;
        if (ar && br) {
          if (ar.row !== br.row) return ar.row - br.row;
          if (ar.column !== br.column) return ar.column - br.column;
        }
        return JSON.stringify(a).localeCompare(JSON.stringify(b));
      });
      return sorted;
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const k of Object.keys(value).sort()) out[k] = sortDeterministic(value[k]);
      return out;
    }
    return value;
  }
  ```

- [ ] Update `firstDiff` to substitute the file's `.path` into the diff path when descending into a `files[i]` array. Add this at the top of the array-handling branch:
  ```js
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${p}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const child = a[i];
      const labelSegment = (typeof child?.path === "string") ? `[${child.path}]` : `[${i}]`;
      const d = firstDiff(a[i], b[i], `${p}${labelSegment}`);
      if (d) return d;
    }
    return null;
  }
  ```
  This means a divergence in `home.wxml`'s `symbols[0].name` reports as `$.files[fixtures/miniprogram/pages/home/home.wxml].symbols[0].name: ...` instead of `$.files[0].symbols[0].name: ...`.

- [ ] Verify: `node --check scripts/diff-symbols-baseline.mjs`. Expected: exit 0.
- [ ] Regression-check the diff harness still works for the step-2 single-file case (since the existing baseline has `files: [single entry]`):
  ```bash
  node scripts/poc-wasm-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > "$TMPDIR/poc-home.json"
  node scripts/diff-symbols-baseline.mjs "$TMPDIR/poc-home.json" fixtures/wasm-spike/home-symbols-baseline.json
  ```
  Expected: `OK: structurally equivalent`.

### Task 3: Freeze the Combined Legacy Baseline

**Files:**
- Create: `fixtures/wasm-spike/miniprogram-symbols-baseline.json`

- [ ] **Pre-install `tree-sitter-cli@0.26.8` into root `node_modules`** (not as a real devDep — `--no-save` keeps `package.json` clean). Without this, the legacy extractor's per-file `npx tree-sitter-cli` calls do a cold-resolve each invocation and 11 files take ~40 min instead of ~22s. 0.26.x is required because 0.25.x rejects the legacy extractor's `--grammar-path` flag.
  ```bash
  NPM_CONFIG_CACHE="$TMPDIR/npm-spike-cache" npm install --no-save tree-sitter-cli@0.26.8
  ls -la node_modules/tree-sitter-cli/tree-sitter   # confirm exec bit set
  ```
- [ ] Run the legacy extractor once with all 11 files. **Note:** In zsh, an unquoted `$FILES` from `$(find ... | sort)` is NOT word-split — the whole newline-joined string becomes a single argv entry and the extractor reports `ENOENT`. Use `xargs` (POSIX-portable) so the shell does not matter:
  ```bash
  find fixtures/miniprogram -type f -name "*.wxml" | sort | \
    NO_COLOR=1 WXML_ZED_HOME="$TMPDIR/wxml-home" NPM_CONFIG_CACHE="$TMPDIR/npm-spike-cache" NPM_CONFIG_PREFIX="$TMPDIR/npm-spike-prefix" \
    xargs node scripts/extract-wxml-symbols.mjs > "$TMPDIR/miniprogram-baseline.json" 2>/dev/null
  wc -c "$TMPDIR/miniprogram-baseline.json"
  ```
  Place the env vars on `xargs` (not on `find`) because the pipe scopes them to the left side only. Expected: roughly 6KB for 11 files (~6720 bytes observed 2026-05-16). If output is <1KB the color bug bit; if it's empty and exit is 1, the npx tree-sitter-cli binary's exec bit was reset (`chmod +x` it).
  **Operational note from 2026-05-16:** the legacy extractor calls `npx tree-sitter-cli` with no version pin. On a cold npm cache, npx re-resolves per invocation and 11 files took ~40 min. Pre-install `tree-sitter-cli@0.26.8` into root `node_modules` (use 0.26.x — 0.25.x rejects the extractor's `--grammar-path` flag) with `NPM_CONFIG_CACHE="$TMPDIR/npm-spike-cache" npm install --no-save tree-sitter-cli@0.26.8` first; wall time then drops to ~22s.

- [ ] Sanity-check the output:
  ```bash
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.env.TMPDIR+"/miniprogram-baseline.json","utf8")); console.log("files:", m.files.length); for (const f of m.files) console.log("  ", f.path, "deps", f.dependencies.length, "syms", f.symbols.length, "refs", f.references.length, "comps", f.components.length)'
  ```
  Expected output has 11 entries. At minimum, `templates/common.wxml`, `templates/secondary.wxml`, and `templates/unrelated.wxml` should each have at least one `symbols` entry with `kind: "template"` (because those are the fixtures with `<template name="...">`).

- [ ] Copy into the repo:
  ```bash
  cp "$TMPDIR/miniprogram-baseline.json" fixtures/wasm-spike/miniprogram-symbols-baseline.json
  ```

### Task 4: Run POC Against All Fixtures and Iterate

**Files:** none (iteration on `scripts/poc-wasm-symbols.mjs` if needed)

- [ ] Generate POC output with the same arg ordering as Task 3 (also via xargs, for the zsh word-splitting reason noted in Task 3):
  ```bash
  find fixtures/miniprogram -type f -name "*.wxml" | sort | \
    xargs node scripts/poc-wasm-symbols.mjs > "$TMPDIR/poc-miniprogram.json"
  wc -c "$TMPDIR/poc-miniprogram.json"
  ```
- [ ] Diff:
  ```bash
  node scripts/diff-symbols-baseline.mjs "$TMPDIR/poc-miniprogram.json" fixtures/wasm-spike/miniprogram-symbols-baseline.json
  ```
- [ ] If a `DIFF:` is reported, the path now includes the offending file (e.g. `$.files[fixtures/miniprogram/templates/common.wxml].symbols[0].name: ...`). Likely first-iteration issues and where to fix:
  - **`template_definition` symbols missing or with wrong name** → check `findAttributeByName(startTag, "template_name_attribute", "name")` actually matches the parsed shape. If the grammar names the inner attribute differently, dump the tree for `templates/common.wxml` and adjust.
  - **Component candidates missing on some fixtures** → walk may be missing nested elements. The current `collectComponents` walks recursively but only checks `node.type === "element"`. If a fixture uses `template_usage` or other non-`element` wrappers as parents of components, they could be missed. Verify by dumping the suspect file's tree.
  - **`references` empty when baseline has entries** → `template_usage` may parse as a different node type when not at top level (e.g. inside another element); confirm the recursive walk reaches them. Currently `collectReferences` does walk recursively, so this should already work.
  - **dependencies missing `module` field** on wxs entries → only happens if the wxs has no `module` attribute. Verify against the baseline.
  - **range mismatches** → may indicate wasm grammar handles a specific element shape differently from the CLI text CST. Compare `node.startPosition` / `endPosition` directly with the baseline `range` to see byte offsets.
- [ ] Iterate until the diff is clean. Cap at ~8 iterations; if mismatches keep surfacing past that, the wasm grammar likely produces a meaningfully different tree shape for some fixture and we need to investigate that fixture in isolation.
- [ ] Once clean, run once more to confirm idempotency:
  ```bash
  find fixtures/miniprogram -type f -name "*.wxml" | sort | \
    xargs node scripts/poc-wasm-symbols.mjs > "$TMPDIR/poc-miniprogram-2.json"
  diff "$TMPDIR/poc-miniprogram.json" "$TMPDIR/poc-miniprogram-2.json" && echo "idempotent"
  node scripts/diff-symbols-baseline.mjs "$TMPDIR/poc-miniprogram-2.json" fixtures/wasm-spike/miniprogram-symbols-baseline.json
  ```
  Expected: `idempotent` and `OK: structurally equivalent`.

### Task 5: Record Outcome

**Files:**
- Modify: `docs/wasm-parser-spike-notes.md`

- [ ] Append a "Step 3 Outcome" section:
  ```markdown
  ## Step 3 Outcome (Fixture Sweep)

  POC at `scripts/poc-wasm-symbols.mjs` now accepts N file args and matches the legacy extractor's combined output for all 11 fixtures in `fixtures/miniprogram/`. Verified via `scripts/diff-symbols-baseline.mjs` against `fixtures/wasm-spike/miniprogram-symbols-baseline.json`.

  **Result:** [byte-identical / structurally equivalent / iterated N times — fill in what actually happened].

  **Newly verified paths (vs step 2):**
  - `template_definition` → symbols[].kind=template (exercised by templates/common.wxml, templates/secondary.wxml, templates/unrelated.wxml)
  - Multi-file output: `files: [...]` order preserves arg order
  - Diff harness now reports diffs with file path: `$.files[<path>].…`

  **Still unverified after step 3:**
  - Dynamic `<template is="{{expr}}">` → no fixture exercises this; synthetic fixture needed in a later step if the path proves load-bearing
  - UTF-16 vs byte column units → no non-ASCII fixture; same situation

  **Anomalies / iterations:** [fill in any non-trivial fix made during Task 4 iteration, or "none — clean on first run" if so]

  Step 3 of the WASM spike passed; extractor replacement (step 4) is unblocked.
  ```

### Task 6: Commit

- [ ] Inspect:
  ```bash
  git status
  ```
  Expected:
  - `M scripts/poc-wasm-symbols.mjs` (multi-file extension)
  - `M scripts/diff-symbols-baseline.mjs` (path-aware diagnostics)
  - `M docs/wasm-parser-spike-notes.md`
  - `?? fixtures/wasm-spike/miniprogram-symbols-baseline.json`
  - `?? docs/superpowers/plans/2026-05-16-wasm-symbols-fixture-sweep.md`
  - `node_modules/` MUST NOT appear.
- [ ] Stage explicitly:
  ```bash
  git add scripts/poc-wasm-symbols.mjs \
          scripts/diff-symbols-baseline.mjs \
          docs/wasm-parser-spike-notes.md \
          fixtures/wasm-spike/miniprogram-symbols-baseline.json \
          docs/superpowers/plans/2026-05-16-wasm-symbols-fixture-sweep.md
  ```
- [ ] `git diff --cached --stat`. Expected: 5 files.
- [ ] Commit:
  ```bash
  git commit -m "$(cat <<'EOF'
  spike: wasm symbol extractor matches legacy across miniprogram fixtures

  Step 3 of replacing the per-file npx tree-sitter-cli shell-out.
  Extends the wasm POC to accept N file args and produce one entry per
  arg in arg order, freezes the legacy extractor's combined output for
  all 11 fixtures in fixtures/miniprogram/ as a baseline, and verifies
  the wasm POC matches it via a slightly enhanced diff harness that
  reports per-file paths in divergence diagnostics.

  Newly verified vs step 2: template_definition symbols, multi-file
  output ordering. Still unverified (no fixture exercises them): dynamic
  <template is="{{expr}}"> references and UTF-16 vs byte column units;
  both stay deferred to a later focused step if they prove load-bearing.

  No existing extractor or LSP code touched.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```
- [ ] `git status` → clean.

---

## Self-Review

**Spec coverage:**
- POC handles N files preserving arg order → Task 1 ✅
- Combined legacy baseline frozen → Task 3 ✅
- Diff harness reports per-file path in diagnostics → Task 2 ✅
- All 11 fixtures verified vs legacy → Task 4 ✅
- Outcome recorded with explicit notes on what's still unverified → Task 5 ✅
- One commit → Task 6 ✅
- step 2 single-file regression still passes → Tasks 1 and 2 each include this check

**Placeholders:** Task 5's "Anomalies / iterations" is an explicit conditional fill-in, not a TBD. Task 4 lists likely first-iteration failure modes inline rather than just "fix it".

**Type consistency:** Diff path format extension (`[<path>]` instead of `[<index>]`) is only applied when the array element has a `.path` string — for nested arrays inside a file (dependencies, symbols, references, components) the existing `[<index>]` form is preserved.

**Known fragility carried over from step 2:**
- Dynamic-is and multi-byte column risk remain unverified through step 3 — explicitly called out in the risk-coverage matrix and in Task 5's "still unverified" line. Not a plan bug; a documented scope choice.

**Operational risks specific to step 3:**
- Legacy extractor takes ~6s per file. 11 files ≈ 70s wall time per baseline regeneration. Task 3 timeout-tolerance is implicit; the build is run once and frozen.
- The 0.26.x npx-cached `tree-sitter` binary's exec bit may have been reset since step 2; Task 3 starts with a defensive `chmod +x`.
- If the legacy extractor's color bug bites again (NO_COLOR=1 not respected on some file), Task 3's sanity-check on `files: 11` and template-symbols counts catches it before the baseline gets frozen.
