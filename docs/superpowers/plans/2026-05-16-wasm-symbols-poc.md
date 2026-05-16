# WASM Symbol Extractor POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a `web-tree-sitter`-based extractor can reconstruct the same single-file symbol JSON as `scripts/extract-wxml-symbols.mjs` produces today. This is step 2 of the 8-step plan to replace the runtime `npx tree-sitter-cli parse --cst` shell-out. The deliverable is a standalone POC script plus a diff harness — nothing in the existing extractor or LSP is touched.

**Architecture:** Add a new POC script that loads `grammar/tree-sitter-wxml/tree-sitter-wxml.wasm` via `web-tree-sitter` (pinned at 0.25.10 from step 1), parses one WXML file, walks the real `SyntaxNode` tree, and emits JSON in the exact same shape `extract-wxml-symbols.mjs` does. Freeze the legacy extractor's current single-file output for `fixtures/miniprogram/pages/home/home.wxml` as a baseline checked into the repo so the diff is reproducible on any machine (independent of the legacy extractor's environment quirks). Write a small diff harness that normalizes both sides (stable array ordering, deep equality on objects) and reports the first divergence. Iterate on the POC until diff is clean for this one fixture.

**Scope (single fixture):** `fixtures/miniprogram/pages/home/home.wxml`. It exercises 6 of the 7 node-kind paths the legacy extractor emits:
- `import_statement` → dependencies[].kind=import
- `include_statement` → dependencies[].kind=include
- `wxs_external` (with `wxs_module_attribute` + `wxs_src_attribute`) → dependencies[].kind=wxs **and** symbols[].kind=wxs
- `<template is="...">` → references[].kind=template, dynamic=false for literal `is`
- element with tag_name containing `-` → components[]

The remaining path — `<template name="...">` definitions producing symbols[].kind=template — is **not** in home.wxml. POC must implement it (otherwise step 3 full-fixture compare will fail) but it stays unverified on this single fixture. It will be verified in step 3 when other fixtures are added to the diff harness.

**Out of scope:**
- Modifying `scripts/extract-wxml-symbols.mjs` (that is step 4)
- Modifying `scripts/extract-wxml-project-graph.mjs`
- Touching `server/wxml-lsp.mjs` or any LSP plumbing
- Multi-file processing (POC is single-file only; step 3 expands to fixtures/miniprogram)
- Fixing the `parseCst` color-handling bug in the legacy extractor (separate concern; the frozen baseline neutralizes it for our purposes)
- UTF-16 vs byte column reconciliation if it appears — home.wxml is ASCII; defer to step 3

**Tech Stack:** Node.js ESM, `web-tree-sitter@0.25.10` (already devDep from step 1), `node:path`, `node:fs/promises`. No new dependencies.

---

## File Structure

- Create: `fixtures/wasm-spike/home-symbols-baseline.json`
  - The legacy extractor's exact output for `fixtures/miniprogram/pages/home/home.wxml` (3147 bytes, captured 2026-05-16 with `NO_COLOR=1 WXML_ZED_HOME=$TMPDIR/wxml-home NPM_CONFIG_CACHE=$TMPDIR/npm-spike-cache NPM_CONFIG_PREFIX=$TMPDIR/npm-spike-prefix` and the 0.25.10 npx cache binary having exec bit).
  - Committed verbatim so the POC has a stable reference target.
- Create: `scripts/poc-wasm-symbols.mjs`
  - Loads wasm via `web-tree-sitter`
  - Parses the given WXML file path
  - Walks SyntaxNode tree to extract dependencies / symbols / references / components
  - Emits the `{ version: 1, files: [...] }` JSON shape on stdout
  - Single-file only (one positional arg)
- Create: `scripts/diff-symbols-baseline.mjs`
  - Reads two JSON files (POC output + baseline)
  - Normalizes (stable array sort by source position, deep equality)
  - Exits 0 if equivalent, 1 with first divergence printed otherwise
- Modify: `docs/wasm-parser-spike-notes.md`
  - Append "Step 2 outcome" section recording POC pass

---

### Task 1: Freeze the Baseline

**Files:**
- Create: `fixtures/wasm-spike/home-symbols-baseline.json`

Purpose: lock the legacy extractor's output as committed reference data. Required because the legacy extractor is environment-fragile (requires writable HOME, NO_COLOR=1, working npx cache binary perms) and that fragility shouldn't poison the POC iteration loop.

- [ ] Verify the working tree is clean and we're on `wxml-lsp-watch-registration`:
  ```bash
  git status
  git rev-parse --abbrev-ref HEAD
  ```
- [ ] Re-generate the baseline from a known-good environment (the same env that worked at end of step 1):
  ```bash
  chmod +x /tmp/claude-501/npm-spike-cache/_npx/3c6034397c31e6a8/node_modules/tree-sitter-cli/tree-sitter 2>/dev/null || true
  NO_COLOR=1 WXML_ZED_HOME="$TMPDIR/wxml-home" NPM_CONFIG_CACHE="$TMPDIR/npm-spike-cache" NPM_CONFIG_PREFIX="$TMPDIR/npm-spike-prefix" \
    node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > "$TMPDIR/home-symbols-baseline.json" 2>/dev/null
  wc -c "$TMPDIR/home-symbols-baseline.json"
  ```
  Expected: 3147 bytes (will likely match exactly; if it differs by a small amount due to fixture edits, that's fine — record the new size in the notes doc later).
- [ ] Sanity-check it has non-empty arrays (no silent color failure):
  ```bash
  node -e 'const j=require("fs").readFileSync(process.env.TMPDIR+"/home-symbols-baseline.json","utf8"); const m=JSON.parse(j); console.log({deps:m.files[0].dependencies.length, syms:m.files[0].symbols.length, refs:m.files[0].references.length, comps:m.files[0].components.length})'
  ```
  Expected: `{ deps: 3, syms: 1, refs: 2, comps: 3 }`. If any are 0, the color bug bit again — stop and diagnose.
- [ ] Move it into the repo as committed fixture:
  ```bash
  mkdir -p fixtures/wasm-spike
  cp "$TMPDIR/home-symbols-baseline.json" fixtures/wasm-spike/home-symbols-baseline.json
  ```

### Task 2: Write the POC Extractor

**Files:**
- Create: `scripts/poc-wasm-symbols.mjs`

This is the substantive task. Implement node-by-node to match the baseline. Use the baseline (`fixtures/wasm-spike/home-symbols-baseline.json`) as the contract.

**Reference info captured during baseline inspection (so the writer doesn't have to re-derive):**
- Range shape is `{ start: { row, column }, end: { row, column } }`, 0-indexed
- Source ordering: arrays are ordered by source position (row, then column), not by node kind
- `dependencies[].normalized` = `path.resolve(path.dirname(inputFilePath), value)` then made relative to `process.cwd()` (matches baseline `"fixtures/miniprogram/templates/common.wxml"` shape)
- `dependencies[].value` = the raw attribute value, **unquoted** (e.g. `../../templates/common.wxml`, not `"../../templates/common.wxml"`)
- wxs `dependencies` entries carry an extra `module` field (string from `wxs_module_attribute`)
- `references[].dynamic` is `false` when `is="literal"`, `true` when `is="{{expr}}"`; for `dynamic:false`, `raw` and `name` are identical
- `symbols[].kind` is `"wxs"` (for `<wxs module="X" src="...">`) or `"template"` (for `<template name="X">`); home.wxml only exercises the wxs path
- `components[]` is elements whose `tag_name` contains `-`, with the full element range (open to close, including self-closing `/>`)

**Steps:**

- [ ] Build the boilerplate (wasm load) by adapting `scripts/verify-wasm-parser.mjs`:
  ```js
  import path from "node:path";
  import { fileURLToPath } from "node:url";
  import fs from "node:fs/promises";
  import { Parser, Language } from "web-tree-sitter";

  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const WASM = path.join(ROOT, "grammar/tree-sitter-wxml/tree-sitter-wxml.wasm");

  async function loadParser() {
    await Parser.init();
    const language = await Language.load(WASM);
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  }
  ```

- [ ] Add CLI arg parsing: one positional, the WXML file path (relative to cwd, like the legacy extractor):
  ```js
  const inputArg = process.argv[2];
  if (!inputArg) { console.error("Usage: node scripts/poc-wasm-symbols.mjs <file.wxml>"); process.exit(1); }
  const inputAbs = path.resolve(process.cwd(), inputArg);
  const inputRel = path.relative(process.cwd(), inputAbs); // matches baseline `path` field shape
  const source = await fs.readFile(inputAbs, "utf8");
  ```

- [ ] Add a `rangeOf(node)` helper that emits the baseline shape exactly:
  ```js
  function rangeOf(node) {
    return {
      start: { row: node.startPosition.row, column: node.startPosition.column },
      end:   { row: node.endPosition.row,   column: node.endPosition.column   },
    };
  }
  ```

- [ ] Add an `attrValue(elementNode, attrName)` helper that finds an `attribute` (or specialized variant like `wxs_module_attribute`, `wxs_src_attribute`, `template_is_attribute`, `template_name_attribute`) under the element's open tag and returns its unquoted value. The baseline shows `"value": "../../templates/common.wxml"` (no surrounding quotes). Strip surrounding `"` or `'` from `quoted_attribute_value`.

- [ ] Implement `dependencies` extraction by walking the root's descendants. For each `import_statement` / `include_statement` / `wxs_external`:
  - `kind` = "import" | "include" | "wxs"
  - `value` = unquoted `src` attribute value
  - `range` = `rangeOf(node)` (the whole statement element)
  - `normalized` = `path.relative(process.cwd(), path.resolve(path.dirname(inputAbs), value))`
  - For wxs only: `module` = unquoted `module` attribute value
  - Push to a flat list; final order is by `(start.row, start.column)`.

- [ ] Implement `symbols` extraction:
  - For each `wxs_external`: emit `{ kind: "wxs", name: <module value>, range: rangeOf(node) }`
  - For each `<template>` element with a `name` attribute (not `is`): emit `{ kind: "template", name: <name value>, range: rangeOf(templateElement) }`
  - Order by `(start.row, start.column)`.

- [ ] Implement `references` extraction:
  - For each `<template>` element with an `is` attribute:
    - Look at the attribute value node. If it contains an interpolation node (typically `interpolation` or has child of that type), `dynamic = true`. Otherwise `dynamic = false`.
    - `raw` = the full attribute value text (still without surrounding quotes; for static, it's the literal name; for dynamic, it's the raw expression text including `{{ }}` markers — match what the baseline produces; on `dynamic:false` the baseline shows `raw` and `name` identical, so for now derive `name` = `raw` when not dynamic, and leave `name` as the raw expression when dynamic, since home.wxml has no dynamic cases to contradict).
    - `range` = `rangeOf(templateElement)`
  - Order by `(start.row, start.column)`.

- [ ] Implement `components` extraction:
  - Walk all element nodes (likely `element` or `self_closing_tag` types — confirm via the wasm parse tree dump in Task 2 verification). For each, find its `tag_name` child.
  - If `tag_name.text` contains `-` AND is not one of the reserved built-ins (`template`, `slot`, `block`, `import`, `include`, `wxs`), emit `{ tag: <text>, range: rangeOf(element) }`.
  - The reserved list comes from `grammar/tree-sitter-wxml/CLAUDE.md` ("Reserved elements"). None of those contain `-` anyway, but be defensive.
  - Order by `(start.row, start.column)`.

- [ ] Emit final JSON:
  ```js
  console.log(JSON.stringify({
    version: 1,
    files: [{ path: inputRel, dependencies, symbols, references, components }]
  }, null, 2));
  ```

- [ ] Verify the script parses cleanly:
  ```bash
  node --check scripts/poc-wasm-symbols.mjs
  ```
  Expected: no output, exit 0.

### Task 3: Write the Diff Harness

**Files:**
- Create: `scripts/diff-symbols-baseline.mjs`

- [ ] Implement:
  ```js
  #!/usr/bin/env node
  import fs from "node:fs/promises";

  function sortDeterministic(value) {
    if (Array.isArray(value)) {
      const sorted = value.map(sortDeterministic);
      sorted.sort((a, b) => {
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

  function firstDiff(a, b, path = "$") {
    if (typeof a !== typeof b) return `${path}: type ${typeof a} vs ${typeof b}`;
    if (a === null || typeof a !== "object") {
      if (a !== b) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
      return null;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
      for (let i = 0; i < a.length; i++) {
        const d = firstDiff(a[i], b[i], `${path}[${i}]`);
        if (d) return d;
      }
      return null;
    }
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return `${path}: keys ${ak.length} vs ${bk.length} (${ak} vs ${bk})`;
    for (const k of ak) {
      if (!Object.hasOwn(b, k)) return `${path}: missing key ${k} on right`;
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }

  async function main() {
    const [pocPath, baselinePath] = process.argv.slice(2);
    if (!pocPath || !baselinePath) {
      console.error("Usage: node scripts/diff-symbols-baseline.mjs <poc.json> <baseline.json>");
      process.exit(1);
    }
    const poc = JSON.parse(await fs.readFile(pocPath, "utf8"));
    const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
    const nPoc = sortDeterministic(poc);
    const nBase = sortDeterministic(baseline);
    const diff = firstDiff(nPoc, nBase);
    if (diff) {
      console.error("DIFF:", diff);
      process.exit(1);
    }
    console.log("OK: structurally equivalent");
  }

  main().catch((e) => { console.error("FAIL:", e?.message || e); process.exit(1); });
  ```
- [ ] `node --check scripts/diff-symbols-baseline.mjs` → exit 0.

### Task 4: Run POC and Iterate Until Diff is Clean

**Files:** none (iteration on `scripts/poc-wasm-symbols.mjs`)

- [ ] Generate POC output and compare:
  ```bash
  node scripts/poc-wasm-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > "$TMPDIR/poc-home.json"
  node scripts/diff-symbols-baseline.mjs "$TMPDIR/poc-home.json" fixtures/wasm-spike/home-symbols-baseline.json
  ```
- [ ] If `DIFF: ...` is reported, **read the path** (e.g. `$.files[0].dependencies[1].normalized`), fix the corresponding code in `poc-wasm-symbols.mjs`, re-run. Likely first-iteration mismatches and where to look:
  - `path: type undefined vs string` → some field missing in POC (often `module` on wxs entry, or `dynamic` on reference)
  - `range.end.column mismatch` → element range includes/excludes trailing `/>` differently; check whether we're using the element node or the open-tag node
  - `tag` mismatches on components → component detection is including reserved elements
  - `normalized` mismatches → path resolution is using wrong base dir; should be `path.dirname(inputAbs)`, not cwd directly
- [ ] Repeat until `OK: structurally equivalent`. Cap at ~10 iterations; if mismatches keep surfacing past that, escalate (likely a fundamental shape misread).
- [ ] Once clean, run one more time to confirm idempotent:
  ```bash
  node scripts/poc-wasm-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > "$TMPDIR/poc-home.json"
  node scripts/diff-symbols-baseline.mjs "$TMPDIR/poc-home.json" fixtures/wasm-spike/home-symbols-baseline.json
  ```
  Expected: `OK: structurally equivalent`.

### Task 5: Record Outcome

**Files:**
- Modify: `docs/wasm-parser-spike-notes.md`

- [ ] Append a section:
  ```markdown
  ## Step 2 Outcome (POC)

  POC at `scripts/poc-wasm-symbols.mjs` produces structurally-equivalent output to the legacy `extract-wxml-symbols.mjs` for `fixtures/miniprogram/pages/home/home.wxml`. Compared via `scripts/diff-symbols-baseline.mjs` against the frozen baseline at `fixtures/wasm-spike/home-symbols-baseline.json`.

  **Verified node-kind paths:** import_statement, include_statement, wxs_external (with module + src attrs), `<template is="...">` static reference, custom-component candidate detection.

  **Not yet verified on this fixture (will be in step 3 with broader fixtures):** `<template name="...">` definition → symbols[].kind=template, and dynamic `<template is="{{expr}}">` → references[].dynamic=true.

  **Anomalies observed during iteration:** [fill in if any non-trivial mismatch found, especially around range column units or reserved-element handling — leave blank if iteration was clean]

  Step 2 of the WASM spike passed; broader fixture compare (step 3) is unblocked.
  ```

### Task 6: Commit

- [ ] Inspect:
  ```bash
  git status
  ```
  Expected new files: `fixtures/wasm-spike/home-symbols-baseline.json`, `scripts/poc-wasm-symbols.mjs`, `scripts/diff-symbols-baseline.mjs`, `docs/superpowers/plans/2026-05-16-wasm-symbols-poc.md`. Expected modified: `docs/wasm-parser-spike-notes.md`. `node_modules/` must not appear.
- [ ] Stage explicitly:
  ```bash
  git add fixtures/wasm-spike/home-symbols-baseline.json \
          scripts/poc-wasm-symbols.mjs \
          scripts/diff-symbols-baseline.mjs \
          docs/wasm-parser-spike-notes.md \
          docs/superpowers/plans/2026-05-16-wasm-symbols-poc.md
  ```
- [ ] Verify staged set:
  ```bash
  git diff --cached --stat
  ```
  Expected: 5 files.
- [ ] Commit:
  ```bash
  git commit -m "$(cat <<'EOF'
  spike: poc wasm-based wxml symbol extractor (single file)

  Step 2 of replacing the per-file `npx tree-sitter-cli` shell-out.
  Adds an in-process web-tree-sitter POC that reproduces the legacy
  extract-wxml-symbols.mjs JSON shape for home.wxml from real
  SyntaxNode walks, plus a structural-equivalence diff harness and a
  committed baseline JSON snapshot.

  Verified node paths: import_statement, include_statement,
  wxs_external (with module+src), static <template is="literal">
  references, hyphenated tag component candidates. Template-name
  definitions and dynamic-is references are implemented but unverified
  on this fixture; they get exercised in step 3 (broader fixtures).

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```
- [ ] `git status` → working tree clean.

---

## Self-Review

**Spec coverage:**
- POC reproduces legacy JSON shape for one fixture → Tasks 2, 4 ✅
- Standalone (no legacy extractor / LSP changes) → "Out of scope" section ✅
- Frozen baseline checked in → Task 1 ✅
- Structural-equivalence diff (normalized) → Task 3 ✅
- All 6 verifiable + 1 unverified-but-implemented node paths covered → Task 2 step list ✅
- Outcome recorded → Task 5 ✅
- One commit → Task 6 ✅

**Placeholders:** Task 5's "anomalies observed" line is conditional — explicitly "leave blank if iteration was clean", which is a real instruction not a TBD. Task 2's `references` extraction notes that dynamic-template `name` derivation is unverified on this fixture; that's a documented known unknown, not vagueness.

**Type consistency:**
- `rangeOf(node)` shape matches baseline exactly throughout
- `dependencies[].value` is unquoted; the same unquoting is used for `wxs.module` and `references[].raw`
- `path.relative(process.cwd(), ...)` is used for both top-level `path` and `dependencies[].normalized`
- Array ordering is `(start.row, start.column)` everywhere

**Known fragility:**
- WASM parse tree's actual node type names (`element`, `self_closing_tag`, `wxs_external_self_closing_tag` per the CST dump captured in step 1) may differ in subtle ways from what the legacy extractor sees in CLI text CST. Task 4 iteration will surface this; the diff harness output points to the exact field that disagrees.
- `references[].raw` vs `name` semantics on dynamic `is="{{...}}"` is a guess — verified only when step 3 hits a fixture with dynamic templates.
- `column` units (UTF-16 vs byte) won't bite home.wxml (pure ASCII) but will likely surface in step 3.
