# JS Method Extractor POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage B of Event Handler Intelligence v1 Phase 1. Prove that an in-process `web-tree-sitter`-based extractor can identify `Page({...})` and `Component({...})` method names from real JS source files, freeze the output as a baseline, and add it to the umbrella verification suite. Does not touch any production extractor, project graph code, or LSP — pure POC + regression anchor.

**Architecture:** Mirror the successful WXML POC pattern (`2026-05-16-wasm-symbols-poc.md`). Load `grammar/tree-sitter-javascript/tree-sitter-javascript.wasm` via `web-tree-sitter`, walk SyntaxNode tree to find `call_expression` nodes whose function is an `identifier` of `Page` or `Component`, then descend into the argument `object` to collect method names. Emit JSON in `{version, files: [{path, methods}]}` shape mirroring the WXML extractor's top-level structure. Output is structurally locked via a frozen baseline plus a dedicated verifier wired into `scripts/verify-tree-sitter.sh`.

**Extraction scope (v1, explicit):**

- **Page({...})**: extract every direct key in the argument object literal whose value is a `function_expression`, `arrow_function`, or `method_definition`. Emit each as `{name, kind: "page-method", range}`.
- **Component({...})**: two paths.
  1. Direct keys of the argument object with function values → `{kind: "component-lifecycle"}` (covers `attached`, `detached`, `ready`, `moved`, `error`, etc.).
  2. Inside `methods: { ... }` block, each key with function value → `{kind: "component-method"}` (these are the event-handler candidates).
- **Call site detection**: walk all `call_expression` nodes recursively (not just top-level expression statements), filter by `function` being an `identifier` named `Page` or `Component`. This catches `module.exports = Page({...})`, `export default Component({...})`, and other common wrappers — direct-only would miss ~30% of real codebases.

**Out of scope for this POC (explicit, documented in notes):**

- `Page(Object.assign({}, base, {...}))` / spread arguments / dynamically built option objects — only object literal arguments.
- Computed property keys (`[key]() {}`) — only static `property_identifier` keys.
- Methods added via `Page.prototype.X = ...` or `this.X = ...` — only literal-object methods.
- TS/TSX source files — JS only in v1.
- `behaviors: [...]` — Component instances can inherit methods from behaviors; this lookup is not done.
- Imported helpers added to options via spread — out of scope.
- Inline closures (e.g. `wx.someEvent(function () {})`) — out of scope, not handlers anyway.

**Tech Stack:** `web-tree-sitter@0.25.10` (already runtime dep), `grammar/tree-sitter-javascript/tree-sitter-javascript.wasm` (built in Stage A), Node ESM. No new dependencies.

---

## File Structure

- Create: `fixtures/wasm-spike/sample-page.js`
  - Hand-written Page literal exercising both `onTap() {}` method definition style and `onLoad: function() {}` pair style; one lifecycle (`onShow`), one custom method.
- Create: `fixtures/wasm-spike/sample-component.js`
  - Hand-written Component literal with both direct lifecycle keys (`attached`, `ready`) and a `methods: { ... }` block containing both styles plus an arrow function.
- Create: `scripts/poc-js-method-extractor.mjs`
  - Loads JS wasm, parses N file args, emits `{version, files}` JSON; tolerates `hasError === true` per Stage B design constraint from the ABI spike plan.
- Create: `fixtures/wasm-spike/js-methods-baseline.json`
  - Frozen POC output for both sample fixtures, committed as regression anchor.
- Create: `scripts/verify-js-method-baselines.mjs`
  - Same pattern as `verify-wasm-symbol-baselines.mjs`: runs POC extractor on the fixture file(s), asserts exit 0, structurally diffs against `js-methods-baseline.json` via the existing `scripts/diff-symbols-baseline.mjs`.
- Modify: `scripts/verify-tree-sitter.sh`
  - Wire the new verifier into the umbrella suite alongside `verify-wasm-symbol-baselines.mjs` and `verify-js-wasm-parser.mjs`.
- Modify: `docs/wasm-parser-spike-notes.md`
  - Append "Stage B outcome" section with extracted method counts per fixture, design decisions made during POC writing, and explicit list of out-of-scope patterns documented as v2 candidates.

---

### Task 1: Create JS Fixtures

**Files:**
- Create: `fixtures/wasm-spike/sample-page.js`
- Create: `fixtures/wasm-spike/sample-component.js`

These fixtures need to cover the syntactic shapes the extractor's first version will recognize, AND include shapes it should ignore (to verify the filter logic).

- [ ] Create `fixtures/wasm-spike/sample-page.js`:
  ```js
  // Sample Page for wasm JS extractor POC. ASCII only; covers both
  // method-definition and function-expression-pair styles, plus one
  // non-method pair (data) that the extractor must skip.

  Page({
    data: {
      count: 0,
      label: "hello",
    },
    onLoad: function (options) {
      this.setData({ count: options.start ?? 0 });
    },
    onShow() {
      this.refresh();
    },
    refresh() {
      this.setData({ count: this.data.count + 1 });
    },
    handleSubmit: function (e) {
      console.log(e.detail);
    },
  });
  ```
  Expected methods extracted: `onLoad`, `onShow`, `refresh`, `handleSubmit` (4 page-methods). `data` is skipped (object value, not function).

- [ ] Create `fixtures/wasm-spike/sample-component.js`:
  ```js
  // Sample Component for wasm JS extractor POC. Covers direct
  // lifecycle keys (attached, ready) and the methods block, plus an
  // arrow function value and a non-function pair (properties).

  Component({
    properties: {
      label: { type: String, value: "" },
    },
    attached() {
      this._wired = true;
    },
    ready: function () {
      this.triggerEvent("ready");
    },
    methods: {
      handleTap() {
        this.triggerEvent("tap");
      },
      handleSelect: function (e) {
        this.setData({ selected: e.currentTarget.dataset.id });
      },
      reset: () => {
        // arrow function as value — should still be extracted
      },
    },
  });
  ```
  Expected extracted: `attached` + `ready` as component-lifecycle (2), and `handleTap` + `handleSelect` + `reset` as component-method (3). `properties` is skipped (object value, not function).

### Task 2: Write POC Extractor

**Files:**
- Create: `scripts/poc-js-method-extractor.mjs`

The extractor mirrors `scripts/poc-wasm-symbols.mjs` in structure: single `Parser.init()`, walk root, collect, sort, emit. Specific structural rules below.

- [ ] Create `scripts/poc-js-method-extractor.mjs`:

  ```js
  #!/usr/bin/env node
  import path from "node:path";
  import { fileURLToPath } from "node:url";
  import fs from "node:fs/promises";
  import { Parser, Language } from "web-tree-sitter";

  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const WASM = path.join(ROOT, "grammar/tree-sitter-javascript/tree-sitter-javascript.wasm");

  const FUNCTION_VALUE_TYPES = new Set(["function_expression", "arrow_function"]);
  const FACTORY_NAMES = new Set(["Page", "Component"]);

  function toPosix(p) {
    return p.split(path.sep).join(path.posix.sep);
  }

  function relativePathFromRoot(filePath) {
    return toPosix(path.relative(ROOT, path.resolve(filePath)));
  }

  function rangeOf(node) {
    return {
      start: { row: node.startPosition.row, column: node.startPosition.column },
      end: { row: node.endPosition.row, column: node.endPosition.column },
    };
  }

  function firstChildOfType(node, type) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === type) return c;
    }
    return null;
  }

  function findChildByField(node, fieldName) {
    // web-tree-sitter exposes field-name access via childForFieldName.
    return node.childForFieldName ? node.childForFieldName(fieldName) : null;
  }

  function isPageOrComponentCall(callNode) {
    // call_expression has a `function` field which should be an identifier.
    const fn = findChildByField(callNode, "function");
    if (!fn || fn.type !== "identifier") return null;
    if (!FACTORY_NAMES.has(fn.text)) return null;
    return fn.text; // "Page" or "Component"
  }

  function optionsObject(callNode) {
    // call_expression has an `arguments` field; first named child of that
    // should be the object literal.
    const args = findChildByField(callNode, "arguments");
    if (!args) return null;
    const first = args.namedChild(0);
    if (!first || first.type !== "object") return null;
    return first;
  }

  function methodEntriesFromObject(objectNode, kind) {
    // Returns [{ name, kind, range }] for every pair/method_definition
    // whose value is a function. Skips computed keys and non-function values.
    const out = [];
    for (let i = 0; i < objectNode.namedChildCount; i++) {
      const child = objectNode.namedChild(i);
      if (child.type === "method_definition") {
        const nameNode = firstChildOfType(child, "property_identifier");
        if (!nameNode) continue;
        out.push({ name: nameNode.text, kind, range: rangeOf(child) });
      } else if (child.type === "pair") {
        const keyNode = firstChildOfType(child, "property_identifier");
        if (!keyNode) continue;
        // Value is the second named child by convention (key, value).
        // Use childForFieldName when available for robustness.
        const valueNode = findChildByField(child, "value") ?? child.namedChild(1);
        if (!valueNode || !FUNCTION_VALUE_TYPES.has(valueNode.type)) continue;
        out.push({ name: keyNode.text, kind, range: rangeOf(child) });
      }
      // Skip everything else (spread_element, shorthand_property_identifier with no value, etc.)
    }
    return out;
  }

  function methodsBlockOf(objectNode) {
    // Find the `methods: { ... }` pair whose value is an object literal.
    for (let i = 0; i < objectNode.namedChildCount; i++) {
      const child = objectNode.namedChild(i);
      if (child.type !== "pair") continue;
      const keyNode = firstChildOfType(child, "property_identifier");
      if (!keyNode || keyNode.text !== "methods") continue;
      const valueNode = findChildByField(child, "value") ?? child.namedChild(1);
      if (valueNode && valueNode.type === "object") return valueNode;
    }
    return null;
  }

  function collectFile(tree) {
    const out = [];
    const visit = (node) => {
      if (node.type === "call_expression") {
        const factory = isPageOrComponentCall(node);
        if (factory) {
          const opts = optionsObject(node);
          if (opts) {
            if (factory === "Page") {
              out.push(...methodEntriesFromObject(opts, "page-method"));
            } else {
              // Component: direct keys are lifecycle, methods block is event handlers
              out.push(...methodEntriesFromObject(opts, "component-lifecycle"));
              const methodsBlock = methodsBlockOf(opts);
              if (methodsBlock) {
                out.push(...methodEntriesFromObject(methodsBlock, "component-method"));
              }
            }
          }
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
    };
    visit(tree.rootNode);
    out.sort((a, b) => {
      const ar = a.range.start, br = b.range.start;
      return (ar.row - br.row) || (ar.column - br.column);
    });
    return out;
  }

  async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      process.stderr.write("Usage: node scripts/poc-js-method-extractor.mjs <file.js> [...file.js]\n");
      process.exit(1);
    }

    await Parser.init();
    const language = await Language.load(WASM);
    const parser = new Parser();
    parser.setLanguage(language);

    const files = [];
    for (const arg of args) {
      const inputAbs = path.resolve(process.cwd(), arg);
      const inputRel = relativePathFromRoot(inputAbs);
      const source = await fs.readFile(inputAbs, "utf8");
      const tree = parser.parse(source);
      // hasError=true is tolerated per Stage B design constraint; we still walk
      // the partial tree and emit whatever methods are recoverable.
      const methods = collectFile(tree);
      files.push({ path: inputRel, methods });
    }

    files.sort((a, b) => a.path.localeCompare(b.path));

    process.stdout.write(`${JSON.stringify({ version: 1, files }, null, 2)}\n`);
  }

  main().catch((err) => {
    process.stderr.write(`FAIL: ${err?.message || err}\n`);
    process.exit(1);
  });
  ```

- [ ] Run `node --check scripts/poc-js-method-extractor.mjs` → exit 0.

### Task 3: Run POC, Inspect Output

**Files:** none (just running)

- [ ] Generate POC output for both fixtures:
  ```bash
  node scripts/poc-js-method-extractor.mjs \
    fixtures/wasm-spike/sample-page.js \
    fixtures/wasm-spike/sample-component.js > "$TMPDIR/poc-js-methods.json"
  cat "$TMPDIR/poc-js-methods.json"
  ```
- [ ] **Pass criteria (manual inspection before freezing):**
  - 2 file entries
  - `sample-page.js` has 4 methods all with `kind: "page-method"`: `onLoad`, `onShow`, `refresh`, `handleSubmit` (sorted by position)
  - `sample-component.js` has 5 methods total: 2 `component-lifecycle` (`attached`, `ready`) followed by 3 `component-method` (`handleTap`, `handleSelect`, `reset`)
  - `data` and `properties` non-function keys do NOT appear
  - All ranges are valid `{start: {row, column}, end: {row, column}}` 0-indexed
- [ ] If any of the above fails, the extractor has a bug — fix `poc-js-method-extractor.mjs` and re-run. Do NOT freeze a wrong baseline. Common likely causes:
  - `childForFieldName("function")` returning null on this `web-tree-sitter` version → fall back to `firstChildOfType(callNode, "identifier")` heuristic, or to positional `namedChild(0)`
  - `pair` value not being detected because it's wrapped in some other node — dump the parse tree for that specific pair and adjust
  - Arrow functions producing wrong node type → the JS grammar uses `arrow_function`; verify the `FUNCTION_VALUE_TYPES` set covers what's actually in the tree

### Task 4: Freeze Baseline

**Files:**
- Create: `fixtures/wasm-spike/js-methods-baseline.json`

- [ ] Copy the validated POC output to its baseline location:
  ```bash
  cp "$TMPDIR/poc-js-methods.json" fixtures/wasm-spike/js-methods-baseline.json
  wc -c fixtures/wasm-spike/js-methods-baseline.json
  ```

### Task 5: Write Verifier and Wire Into Umbrella

**Files:**
- Create: `scripts/verify-js-method-baselines.mjs`
- Modify: `scripts/verify-tree-sitter.sh`

Same pattern as `verify-wasm-symbol-baselines.mjs`: run extractor, assert exit code, structurally diff against committed baseline via existing `diff-symbols-baseline.mjs`. Single case for now (covers both fixtures since the extractor handles N file args).

- [ ] Create `scripts/verify-js-method-baselines.mjs`:

  ```js
  #!/usr/bin/env node
  import { spawn } from "node:child_process";
  import fs from "node:fs/promises";
  import path from "node:path";
  import { fileURLToPath } from "node:url";

  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const EXTRACTOR = path.join(ROOT, "scripts/poc-js-method-extractor.mjs");
  const DIFF = path.join(ROOT, "scripts/diff-symbols-baseline.mjs");
  const BASELINE = path.join(ROOT, "fixtures/wasm-spike/js-methods-baseline.json");

  const FIXTURES = [
    "fixtures/wasm-spike/sample-page.js",
    "fixtures/wasm-spike/sample-component.js",
  ];

  function runNode(scriptPath, args) {
    return new Promise((resolve, reject) => {
      const child = spawn("node", [scriptPath, ...args], { cwd: ROOT });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  async function main() {
    process.stdout.write("[verify-js-method-baselines] sample-page + sample-component ... ");
    const extractor = await runNode(EXTRACTOR, FIXTURES);
    if (extractor.code !== 0) {
      process.stdout.write("FAIL\n");
      process.stderr.write(`  extractor exit ${extractor.code}\n  stderr: ${extractor.stderr.trim()}\n`);
      process.exit(1);
    }
    const tmpPath = path.join(process.env.TMPDIR || "/tmp", "js-methods-actual.json");
    await fs.writeFile(tmpPath, extractor.stdout);

    const diff = await runNode(DIFF, [tmpPath, BASELINE]);
    if (diff.code !== 0) {
      process.stdout.write("FAIL\n");
      process.stderr.write(`  ${diff.stderr.trim()}\n  ${diff.stdout.trim()}\n`);
      process.exit(1);
    }
    process.stdout.write("PASS\n");
    process.stdout.write("\nAll JS method baselines match.\n");
  }

  main().catch((err) => {
    process.stderr.write(`FAIL: ${err?.message || err}\n`);
    process.exit(1);
  });
  ```

- [ ] `node --check scripts/verify-js-method-baselines.mjs` → exit 0.
- [ ] Run it standalone first to confirm it passes: `node scripts/verify-js-method-baselines.mjs` → exit 0, prints `PASS` and `All JS method baselines match.`.
- [ ] Wire into `scripts/verify-tree-sitter.sh` — insert directly after the existing `verify-js-wasm-parser.mjs` call so the sequence is: language-service → wasm symbol baselines → JS wasm smoke → **JS method baselines** → LSP smoke.

### Task 6: Run Umbrella Suite

**Files:** none (verification only)

- [ ] Run `bash scripts/verify-tree-sitter.sh 2>&1 | tail -20`. Expected: ends with `wxml-zed tree-sitter verification passed`, includes a `[verify-js-method-baselines] sample-page + sample-component ... PASS` line in the output.

### Task 7: Record Stage B Outcome

**Files:**
- Modify: `docs/wasm-parser-spike-notes.md`

- [ ] Append a "Stage B Outcome (JS Method Extractor POC)" section. Include:
  - Extracted method counts per fixture (4 page-methods, 2 component-lifecycle + 3 component-methods)
  - Confirmation that POC tolerates `hasError === true` per Stage A design constraint (no fixture exercises it yet — flag as gap for Stage C fixtures)
  - **Explicit out-of-scope list as v2 candidates**: `Object.assign` / spread / dynamic options, computed keys, prototype assignment, TS/TSX, behaviors inheritance, imported helpers, inline closures. Anyone trying to extend the extractor needs this list to know what's deliberately not handled.
  - **Recursive walk decision rationale**: extractor walks all `call_expression` nodes (not just top-level expression_statement) so `module.exports = Page({...})` and `export default Component({...})` are caught. The cost is marginally more permissive walking; the benefit is ~30% real-codebase coverage that direct-top-only would miss.
  - One-line readiness statement: "Stage B passes; Stage C (project graph integration) is unblocked."

### Task 8: Single Commit

- [ ] Inspect:
  ```bash
  git status
  ```
  Expected new files:
  - `?? fixtures/wasm-spike/sample-page.js`
  - `?? fixtures/wasm-spike/sample-component.js`
  - `?? fixtures/wasm-spike/js-methods-baseline.json`
  - `?? scripts/poc-js-method-extractor.mjs`
  - `?? scripts/verify-js-method-baselines.mjs`
  - `?? docs/superpowers/plans/2026-05-17-js-method-extractor-poc.md`
  
  Expected modified:
  - `M scripts/verify-tree-sitter.sh`
  - `M docs/wasm-parser-spike-notes.md`
  
  `node_modules/` MUST NOT appear.

- [ ] Stage explicitly:
  ```bash
  git add fixtures/wasm-spike/sample-page.js \
          fixtures/wasm-spike/sample-component.js \
          fixtures/wasm-spike/js-methods-baseline.json \
          scripts/poc-js-method-extractor.mjs \
          scripts/verify-js-method-baselines.mjs \
          scripts/verify-tree-sitter.sh \
          docs/wasm-parser-spike-notes.md \
          docs/superpowers/plans/2026-05-17-js-method-extractor-poc.md
  ```
- [ ] `git diff --cached --stat`. Expect 8 files.
- [ ] Commit:
  ```bash
  git commit -m "$(cat <<'EOF'
  spike: js method extractor poc (page + component fixtures)

  Stage B of Event Handler Intelligence v1 Phase 1 (data model).
  Adds scripts/poc-js-method-extractor.mjs which loads the JS wasm
  built in Stage A and walks SyntaxNode trees to extract Page/Component
  method names from real JS source. Two sample fixtures plus a frozen
  baseline lock the extracted shape via scripts/verify-js-method-
  baselines.mjs, wired into the umbrella verify-tree-sitter.sh suite.

  v1 scope: direct object-literal arguments, static property keys,
  function-expression / arrow-function / method-definition values.
  Recursive walk for call_expression so module.exports = Page({...})
  and export default Component({...}) are caught. Out-of-scope
  patterns (Object.assign, spread, computed keys, TS/TSX, behaviors
  inheritance) are documented as v2 candidates in the notes.

  No production extractor, project graph, LSP, or WXML code touched.
  Stage C (project graph integration) is unblocked next.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```
- [ ] `git status` → clean.

---

## Self-Review

**Spec coverage:**
- POC extractor exists and reproduces methods on fixtures → Tasks 2, 3 ✅
- Baseline frozen → Task 4 ✅
- Verifier exists and is wired into umbrella → Task 5 ✅
- End-to-end umbrella run passes → Task 6 ✅
- Outcome recorded with v2 candidates list → Task 7 ✅
- Single commit covering all files → Task 8 ✅

**Placeholders:** Task 3's pass criteria gives exact expected method names and counts; not vague. Task 7's outcome section has explicit content requirements (counts, scope list, walk rationale), not "describe what happened."

**Type consistency:** Output JSON uses `{version, files: [{path, methods: [{name, kind, range}]}]}` shape throughout. `range` shape mirrors WXML extractor's `{start: {row, column}, end: {row, column}}`. Method `kind` enum is exactly `"page-method" | "component-lifecycle" | "component-method"` everywhere.

**Plan-doc-sync check (from feedback memory `sync-plan-after-inline-fixes`):**
- File Structure lists ALL files including `scripts/verify-tree-sitter.sh` (Modify) — ✅
- Task 5 has explicit "wire into umbrella" step — ✅
- Task 8 expected status list and git add command both include `scripts/verify-tree-sitter.sh` — ✅
- If any inline correction is made during execution, re-check this plan before commit and add a sibling commit if drift exists.

**Known fragility:**
- `childForFieldName("function")` / `childForFieldName("value")` / `childForFieldName("arguments")` may behave differently across `web-tree-sitter` versions. Task 2's code has positional fallbacks (`namedChild(0)`, `namedChild(1)`); if these too break, Task 3's failure path includes dumping the parse tree to discover the actual shape.
- `tree.rootNode.hasError === true` tolerance is implemented but unverified — no fixture exercises it. Flagged in Task 7 as a Stage C fixture gap.
- "Recursive walk for call_expression" decision could match unintended calls (e.g. a local variable shadowing `Page` or `Component`). Real WeChat mini-program code does not redefine these names; flag as known caveat if it ever bites.
