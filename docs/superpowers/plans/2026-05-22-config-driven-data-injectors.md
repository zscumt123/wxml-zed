# Config-Driven Data Injectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-level `wxml-zed.config.json` mechanism that declares helper-class data-injection patterns. When the JS extractor sees a matching `new ClassName(string-literal).method(this)` call inside an owner-context function body, the produces-template's substituted identifier(s) are merged into the page's `dataKeys` with `source: "injector"`. v1 is narrow: only direct expression shape with non-empty `constructorArgs` matches.

**Architecture:** Two extension points. (1) A new `shared/project-config.mjs` module hosts `loadProjectConfig(projectRoot)` — reads + validates `<projectRoot>/wxml-zed.config.json`. (2) `shared/js-method-extractor.mjs` gains `matchInjectorCall` + `applyTemplate` + `walkOwnerFunctionForInjectors` helpers running alongside the existing setData walker; `extractMethods` accepts an `options.dataInjectors` parameter. `scripts/extract-wxml-project-graph.mjs` calls the loader at graph build time and threads injectors through. The LSP overlay path is unaffected (JS extraction happens at graph build only). Editing `wxml-zed.config.json` triggers a graph rebuild via the existing `**/*.json` watcher in `server/wxml-lsp.mjs` — no separate watcher needed.

**Tech Stack:** Same as existing extractor: web-tree-sitter (JS grammar), Node ESM modules, JSON for config. New shared module pattern matches existing `shared/wxml-symbol-extractor.mjs` (extract logic + CLI wrapper consumer pattern).

---

## Spec Reference

Authoritative design: `docs/superpowers/specs/2026-05-22-config-driven-data-injectors-design.md`. Critical points locked there (spec wins on ambiguity):

- **Lookup direction**: by exact `className` identifier at the `new` expression. NOT the imported source path.
- **`constructorArgs` v1 REQUIRED non-empty**. Empty array → load-time validation reject with stderr warn.
- **Match conditions (9 conditions)**: see spec Decision Matrix. Critically: call expression → member expression → new expression with `identifier` constructor → `property_identifier` method → `arguments` exactly one named child of type `this` → first N constructor args must be `string` type with extractable `string_fragment` (N = `constructorArgs.length`).
- **Source field**: dataKeys now accept three values: `"data"`, `"setData"`, `"injector"`. propertyKeys unchanged (`"property"` only).
- **Merge order**: data block first, setData walker second, injector walker third. Dedup by `name`; first source wins.
- **`hasDynamicData` is NOT affected by injector logic**. v1 never escalates.
- **Walker boundary**: identical to setData walker (stops at `function_expression` / `function_declaration` / `method_definition` / `generator_function` / `generator_function_declaration`; descends into `arrow_function`).
- **`nameRange`**: points at the first constructor literal's `string_fragment` range. All produces from one match share this range.
- **Diagnostic message**: NO new diagnostic code in this round. Just affects dataKeys → in-scope identifiers → suppresses existing `missing-expression-ref` warnings.

## File Structure

**Created:**

- `shared/project-config.mjs` — new module. Exports `loadProjectConfig(projectRoot)` and the internal validator. Self-contained: reads JSON, validates, returns normalized `{ dataInjectors: [...] }` shape.
- `scripts/verify-project-config-loading.mjs` — new unit test runner for `loadProjectConfig`. Self-contained: uses tmpdir-based fixtures, no dependencies on other verify scripts.

**Modified:**

- `shared/js-method-extractor.mjs` — add three new helper functions (`matchInjectorCall`, `applyTemplate`, `walkOwnerFunctionForInjectors`); extend `extractMethods` to accept `options.dataInjectors` and run the new walker after the setData walker.
- `scripts/extract-wxml-project-graph.mjs` — import `loadProjectConfig`, call it at graph build time, pass `options.dataInjectors` through to `extractMethods` in `attachScripts`.
- `scripts/verify-js-script-info.mjs` — add 12 synthetic test cases (J1–J12); update structural source-validity assertion to accept `"injector"`.
- `scripts/verify-tree-sitter.sh` — wire `verify-project-config-loading.mjs` into the umbrella verifier so config-loader regressions cannot silently bypass the main test command.

**No other source changes.** No new LSP capabilities. `server/wxml-language-service.mjs` is NOT modified — the injector keys flow through the existing `expressionRefDiagnostics` via the augmented dataKeys.

## Sequencing Notes

Every commit is independently green. The injector helpers in Task 2 are unreferenced dead code; Task 3 wires them in along with J1 as the regression lock. The chelaile dogfood in Task 5 confirms the real-project outcome.

- Task 1 (commit, green): `loadProjectConfig` module + 5 config loader tests + umbrella verifier wiring.
- Task 2 (commit, green): three injector helpers in `shared/js-method-extractor.mjs` as unreferenced dead code.
- Task 3 (commit, green): wire helpers into `extractMethods` + thread `options.dataInjectors` from graph extractor + J1 happy-path test + accept `"injector"` in source-validity assertion.
- Task 4 (commit, green): 11 more synthetic test cases (J2–J12), including additive duplicate-class config coverage.
- Task 5 (commit, green): chelaile dogfood with temporary config + Outcome notes + spike notes follow-up.

---

## Task 1: `loadProjectConfig` + 5 config loader unit tests

**Files:**
- Create: `/Users/zs/Desktop/study/wxml-zed/shared/project-config.mjs`
- Create: `/Users/zs/Desktop/study/wxml-zed/scripts/verify-project-config-loading.mjs`
- Modify: `/Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Create `shared/project-config.mjs` with the loader + validator**

Write `/Users/zs/Desktop/study/wxml-zed/shared/project-config.mjs` with the following exact content:

```js
import fs from "node:fs";
import path from "node:path";

const IDENTIFIER_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

// Validates a single dataInjector entry. Returns the normalized entry on
// success, or null on validation failure (with a stderr warning).
//
// Required fields:
//   - className: non-empty string
//   - constructorArgs: non-empty array of valid JS identifiers
//   - methods: object with >= 1 entry; each value is an array of template strings
//
// v1 explicitly rejects empty constructorArgs because the matcher's nameRange
// depends on having at least one constructor literal to point at.
function validateInjector(entry, index, configPath) {
  const warn = (reason) => {
    process.stderr.write(`[wxml-zed] dataInjectors[${index}]: ${reason}: ${configPath}\n`);
  };

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    warn("entry must be an object");
    return null;
  }

  if (typeof entry.className !== "string" || entry.className.length === 0) {
    warn("className must be a non-empty string");
    return null;
  }

  if (!Array.isArray(entry.constructorArgs) || entry.constructorArgs.length === 0) {
    warn("constructorArgs must be a non-empty array of identifier names (v1 requires >= 1)");
    return null;
  }
  for (const name of entry.constructorArgs) {
    if (typeof name !== "string" || !IDENTIFIER_SHAPE.test(name)) {
      warn(`constructorArgs entry ${JSON.stringify(name)} is not a valid identifier`);
      return null;
    }
  }

  if (!entry.methods || typeof entry.methods !== "object" || Array.isArray(entry.methods)) {
    warn("methods must be an object (method name -> produces template array)");
    return null;
  }
  const methodNames = Object.keys(entry.methods);
  if (methodNames.length === 0) {
    warn("methods must have at least one entry");
    return null;
  }
  for (const methodName of methodNames) {
    const produces = entry.methods[methodName];
    if (!Array.isArray(produces)) {
      warn(`methods[${JSON.stringify(methodName)}] must be an array of template strings`);
      return null;
    }
    for (const tmpl of produces) {
      if (typeof tmpl !== "string") {
        warn(`methods[${JSON.stringify(methodName)}] contains a non-string template`);
        return null;
      }
    }
  }

  return {
    className: entry.className,
    constructorArgs: [...entry.constructorArgs],
    methods: { ...entry.methods },
  };
}

function validateDataInjectors(arr, configPath) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const normalized = validateInjector(arr[i], i, configPath);
    if (normalized) out.push(normalized);
  }
  return out;
}

// Returns { dataInjectors: [normalized entries] }. Silent and returns empty
// injectors when the config file doesn't exist. Logs a stderr warning and
// returns empty injectors when the file exists but JSON parsing fails. Top-
// level `dataInjectors` field absent is treated as empty.
export function loadProjectConfig(projectRoot) {
  const configPath = path.join(projectRoot, "wxml-zed.config.json");
  if (!fs.existsSync(configPath)) {
    return { dataInjectors: [] };
  }
  let raw;
  try {
    const text = fs.readFileSync(configPath, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    process.stderr.write(`[wxml-zed] failed to parse ${configPath}: ${err?.message || err}\n`);
    return { dataInjectors: [] };
  }
  return {
    dataInjectors: validateDataInjectors(raw?.dataInjectors ?? [], configPath),
  };
}
```

- [ ] **Step 2: Create `scripts/verify-project-config-loading.mjs` with 5 test cases**

Write `/Users/zs/Desktop/study/wxml-zed/scripts/verify-project-config-loading.mjs` with exactly:

```js
#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectConfig } from "../shared/project-config.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mkTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wxml-zed-config-test-"));
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured.join("");
}

function testCL1MissingFile() {
  // C-L1: config file does NOT exist. Loader returns empty injectors silently.
  const root = mkTmpProject();
  try {
    let result;
    const stderr = captureStderr(() => { result = loadProjectConfig(root); });
    assert(result.dataInjectors.length === 0, `C-L1: expected empty injectors; got ${JSON.stringify(result)}`);
    assert(stderr === "", `C-L1: expected no stderr; got ${JSON.stringify(stderr)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCL2MalformedJson() {
  // C-L2: config file exists but contains invalid JSON.
  // Loader writes a stderr warn and returns empty injectors.
  const root = mkTmpProject();
  try {
    fs.writeFileSync(path.join(root, "wxml-zed.config.json"), "{ not valid json", "utf8");
    let result;
    const stderr = captureStderr(() => { result = loadProjectConfig(root); });
    assert(result.dataInjectors.length === 0, `C-L2: expected empty injectors; got ${JSON.stringify(result)}`);
    assert(stderr.includes("failed to parse"), `C-L2: expected stderr to mention failed parse; got ${JSON.stringify(stderr)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCL3ValidFullConfig() {
  // C-L3: valid config with one injector. Loader returns normalized entry.
  const root = mkTmpProject();
  try {
    const config = {
      dataInjectors: [
        {
          className: "LoadStates",
          constructorArgs: ["name"],
          methods: {
            applyTo: ["${name}_state", "${name}_states"],
            applyStateTo: ["${name}_state"],
          },
        },
      ],
    };
    fs.writeFileSync(path.join(root, "wxml-zed.config.json"), JSON.stringify(config), "utf8");
    let result;
    const stderr = captureStderr(() => { result = loadProjectConfig(root); });
    assert(stderr === "", `C-L3: expected no stderr; got ${JSON.stringify(stderr)}`);
    assert(result.dataInjectors.length === 1, `C-L3: expected 1 injector; got ${result.dataInjectors.length}`);
    const entry = result.dataInjectors[0];
    assert(entry.className === "LoadStates", `C-L3: className ${entry.className}`);
    assert(entry.constructorArgs.length === 1 && entry.constructorArgs[0] === "name", `C-L3: constructorArgs ${JSON.stringify(entry.constructorArgs)}`);
    assert(Object.keys(entry.methods).length === 2, `C-L3: methods count ${Object.keys(entry.methods).length}`);
    assert(entry.methods.applyTo.length === 2, `C-L3: applyTo produces count ${entry.methods.applyTo.length}`);
    assert(entry.methods.applyStateTo.length === 1, `C-L3: applyStateTo produces count ${entry.methods.applyStateTo.length}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCL4MixedValidInvalid() {
  // C-L4: config has 2 valid + 2 invalid entries. Loader keeps the 2 valid
  // and writes stderr warns for the 2 invalid ones.
  const root = mkTmpProject();
  try {
    const config = {
      dataInjectors: [
        {
          // valid
          className: "LoadStates",
          constructorArgs: ["name"],
          methods: { applyTo: ["${name}_state"] },
        },
        {
          // invalid — no className
          constructorArgs: ["name"],
          methods: { applyTo: ["${name}_state"] },
        },
        {
          // invalid — empty constructorArgs
          className: "X",
          constructorArgs: [],
          methods: { applyTo: ["static_x"] },
        },
        {
          // valid
          className: "States",
          constructorArgs: ["name"],
          methods: { applyTo: ["${name}_state"] },
        },
      ],
    };
    fs.writeFileSync(path.join(root, "wxml-zed.config.json"), JSON.stringify(config), "utf8");
    let result;
    const stderr = captureStderr(() => { result = loadProjectConfig(root); });
    assert(result.dataInjectors.length === 2, `C-L4: expected 2 valid injectors; got ${result.dataInjectors.length}`);
    assert(result.dataInjectors[0].className === "LoadStates", `C-L4: first valid is LoadStates`);
    assert(result.dataInjectors[1].className === "States", `C-L4: second valid is States`);
    assert(stderr.includes("dataInjectors[1]"), `C-L4: expected stderr to mention index 1; got ${JSON.stringify(stderr)}`);
    assert(stderr.includes("dataInjectors[2]"), `C-L4: expected stderr to mention index 2; got ${JSON.stringify(stderr)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCL5EmptyConstructorArgs() {
  // C-L5: standalone test for the constructorArgs=[] rejection. v1 must
  // reject explicit empty array (NOT default to empty).
  const root = mkTmpProject();
  try {
    const config = {
      dataInjectors: [
        {
          className: "X",
          constructorArgs: [],
          methods: { applyTo: ["static_x"] },
        },
      ],
    };
    fs.writeFileSync(path.join(root, "wxml-zed.config.json"), JSON.stringify(config), "utf8");
    let result;
    const stderr = captureStderr(() => { result = loadProjectConfig(root); });
    assert(result.dataInjectors.length === 0, `C-L5: expected 0 injectors (empty constructorArgs rejected); got ${result.dataInjectors.length}`);
    assert(stderr.includes("constructorArgs must be a non-empty array"), `C-L5: expected stderr to mention empty constructorArgs; got ${JSON.stringify(stderr)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const CASES = [
  ["C-L1: missing file returns empty", testCL1MissingFile],
  ["C-L2: malformed JSON returns empty with stderr warn", testCL2MalformedJson],
  ["C-L3: valid config returns normalized injectors", testCL3ValidFullConfig],
  ["C-L4: mixed valid+invalid entries — valid kept, invalid warn+skip", testCL4MixedValidInvalid],
  ["C-L5: empty constructorArgs explicitly rejected (v1)", testCL5EmptyConstructorArgs],
];

let passed = 0;
let failed = 0;
for (const [label, fn] of CASES) {
  try {
    fn();
    process.stdout.write(`PASS ${label}\n`);
    passed += 1;
  } catch (err) {
    process.stdout.write(`FAIL ${label}\n  ${err.message}\n`);
    failed += 1;
  }
}
process.stdout.write(`\nResult: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 3: Run the verify script — all 5 must pass**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-project-config-loading.mjs
```

Expected:

```
PASS C-L1: missing file returns empty
PASS C-L2: malformed JSON returns empty with stderr warn
PASS C-L3: valid config returns normalized injectors
PASS C-L4: mixed valid+invalid entries — valid kept, invalid warn+skip
PASS C-L5: empty constructorArgs explicitly rejected (v1)

Result: 5 passed, 0 failed
```

If any fails, the loader logic is wrong — fix in `shared/project-config.mjs` and re-run.

- [ ] **Step 4: Wire the config loader verifier into the umbrella script**

In `/Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh`, near the bottom where the node verifiers are listed, insert the new verifier after `verify-js-script-info.mjs`:

```bash
node "$ROOT_DIR/scripts/verify-js-script-info.mjs"
node "$ROOT_DIR/scripts/verify-project-config-loading.mjs"
node "$ROOT_DIR/scripts/verify-wxml-expression-helpers.mjs"
```

This is intentional even though Task 1's loader is not yet consumed by production code: config validation is now part of the project contract, so the umbrella command must run it.

- [ ] **Step 5: Run the umbrella verify — confirm no other test breaks**

```bash
bash /Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh 2>&1 | tail -3
```

Expected final line: `wxml-zed tree-sitter verification passed`. The new loader is isolated (no existing production consumer imports it yet), but the umbrella now proves its 5 cases every run.

If EACCES on tree-sitter-cli, run node sub-verifiers manually:

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wxml-language-service.mjs
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-js-script-info.mjs
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-lsp-diagnostics.mjs --suite graph-smoke
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wasm-symbol-baselines.mjs
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-project-config-loading.mjs
```

All must exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add shared/project-config.mjs scripts/verify-project-config-loading.mjs scripts/verify-tree-sitter.sh
git commit -m "$(cat <<'EOF'
feat: loadProjectConfig + 5 config loader unit tests (P2.2-A scaffolding)

Adds shared/project-config.mjs hosting loadProjectConfig(projectRoot),
which reads and validates <projectRoot>/wxml-zed.config.json. v1
scope:

- Missing file → returns { dataInjectors: [] } silently.
- Malformed JSON → stderr warn, returns empty.
- Per-entry validation: className must be non-empty string;
  constructorArgs must be non-empty array of valid identifiers
  (v1 explicitly rejects empty array because matchInjectorCall's
  nameRange depends on a first-literal range); methods must be
  object with >= 1 entry, each value an array of string templates.
- Bad entries → stderr warn + skip; other entries unaffected.

Adds scripts/verify-project-config-loading.mjs with 5 cases
covering missing file, malformed JSON, valid config, mixed
valid+invalid, and empty constructorArgs rejection. Uses tmpdir-
based fixtures with try/finally cleanup; captures stderr via
process.stderr.write override.

Wires verify-project-config-loading.mjs into scripts/verify-tree-sitter.sh
so config-loader regressions are covered by the umbrella verifier from
the first commit. No production consumer wires loadProjectConfig yet;
Task 3 connects it to the graph extractor.
EOF
)"
```

---

## Task 2: Injector walker helpers as unwired dead code

**Files:**
- Modify: `/Users/zs/Desktop/study/wxml-zed/shared/js-method-extractor.mjs`

Add three helpers as unreferenced dead code. Task 3 wires them in along with the first synthetic test.

- [ ] **Step 1: Add `matchInjectorCall` helper**

In `/Users/zs/Desktop/study/wxml-zed/shared/js-method-extractor.mjs`, locate `walkOwnerFunctionForSetData` (around line 340). Insert the new helpers AFTER `walkOwnerFunctionForSetData` and BEFORE `extractMethods`. First add:

```js
// Detect `new <ClassName>(<args>).<methodName>(this)` direct-expression
// shape. Returns matched dataKey entries (with source: "injector") on hit,
// null otherwise. Whitespace/newlines are insignificant — gates only on AST
// shape. Constructor arg substitution requires first N args to be string
// literals (N = injector.constructorArgs.length). Subsequent args are
// ignored.
function matchInjectorCall(callNode, dataInjectors) {
  if (callNode.type !== "call_expression") return null;

  const memberExpr = fieldChild(callNode, "function");
  if (!memberExpr || memberExpr.type !== "member_expression") return null;

  const newExpr = fieldChild(memberExpr, "object");
  if (!newExpr || newExpr.type !== "new_expression") return null;

  const ctorIdent = fieldChild(newExpr, "constructor");
  if (!ctorIdent || ctorIdent.type !== "identifier") return null;
  const className = ctorIdent.text;

  const methodIdent = fieldChild(memberExpr, "property");
  if (!methodIdent || methodIdent.type !== "property_identifier") return null;
  const methodName = methodIdent.text;

  // Receiver must be exactly [this].
  const callArgs = fieldChild(callNode, "arguments");
  if (!callArgs || callArgs.namedChildCount !== 1) return null;
  const receiver = callArgs.namedChild(0);
  if (!receiver || receiver.type !== "this") return null;

  // Find matching injectors (className + methodName both required). Multiple
  // config entries with the same className are additive; do NOT stop at the
  // first match. Use own-property checks so prototype names like `toString`
  // cannot accidentally match.
  const matchedConfigs = dataInjectors.filter((cfg) => (
    cfg.className === className &&
    Object.hasOwn(cfg.methods, methodName)
  ));
  if (matchedConfigs.length === 0) return null;

  const keys = [];
  const ctorArgs = fieldChild(newExpr, "arguments");
  if (!ctorArgs) return null;

  for (const matched of matchedConfigs) {
    // Extract first N constructor literals for this config entry. Different
    // entries with the same className may declare different constructorArgs;
    // each entry is evaluated independently.
    const required = matched.constructorArgs.length;
    if (ctorArgs.namedChildCount < required) continue;

    const subst = Object.create(null);
    let primaryRange = null;
    let ok = true;
    for (let i = 0; i < required; i++) {
      const argNode = ctorArgs.namedChild(i);
      if (!argNode || argNode.type !== "string") {
        ok = false;
        break;
      }
      const fragment = firstChildOfType(argNode, "string_fragment");
      if (!fragment) {
        ok = false;
        break;
      }
      subst[matched.constructorArgs[i]] = fragment.text;
      if (primaryRange === null) primaryRange = rangeOf(fragment);
    }
    if (!ok) continue;

    // Apply produces templates. Per-template failures skip just that key.
    for (const template of matched.methods[methodName]) {
      const name = applyTemplate(template, subst);
      if (name === null) continue;
      if (!IDENTIFIER_SHAPE.test(name)) continue;
      keys.push({ name, nameRange: primaryRange, source: "injector" });
    }
  }
  return keys;
}
```

- [ ] **Step 2: Add `applyTemplate` helper**

Immediately after `matchInjectorCall`:

```js
// Substitute ${argName} placeholders in a template string using the subst
// map. Returns null on any failure (unclosed ${, unknown argName) — that
// template is skipped silently. Plain text outside ${...} is preserved
// verbatim.
function applyTemplate(template, subst) {
  let out = "";
  let i = 0;
  while (i < template.length) {
    if (template[i] === "$" && template[i + 1] === "{") {
      const end = template.indexOf("}", i + 2);
      if (end === -1) return null;
      const argName = template.slice(i + 2, end);
      if (!Object.hasOwn(subst, argName)) return null;
      out += subst[argName];
      i = end + 1;
    } else {
      out += template[i];
      i += 1;
    }
  }
  return out;
}
```

- [ ] **Step 3: Add `walkOwnerFunctionForInjectors` helper**

Immediately after `applyTemplate`:

```js
// Walks call_expression descendants of `funcNode`, running matchInjectorCall
// on each. Same boundary semantics as walkOwnerFunctionForSetData: stops at
// nested function_expression / function_declaration / method_definition /
// generator_function / generator_function_declaration (those rebind `this`);
// descends into arrow_function (lexical `this`).
//
// Sink accumulates matched keys: { keys: [...] }. No `dynamic` flag — v1
// never escalates to hasDynamicData.
function walkOwnerFunctionForInjectors(funcNode, sink, dataInjectors) {
  const visit = (node) => {
    if (node !== funcNode && (
      node.type === "function_expression" ||
      node.type === "function_declaration" ||
      node.type === "method_definition" ||
      node.type === "generator_function" ||
      node.type === "generator_function_declaration"
    )) {
      return;
    }
    if (node.type === "call_expression") {
      const keys = matchInjectorCall(node, dataInjectors);
      if (keys !== null) {
        for (const key of keys) sink.keys.push(key);
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
  };
  visit(funcNode);
}
```

- [ ] **Step 4: Run verify-js-script-info — existing 47 cases must still pass**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-js-script-info.mjs
```

Expected: `[verify-js-script-info] All 47 script-info cases match. PASS`.

The new helpers are unreferenced dead code. `extractMethods` doesn't call them; existing test cases are unaffected.

- [ ] **Step 5: Run umbrella**

```bash
bash /Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh 2>&1 | tail -3
```

Expected: `wxml-zed tree-sitter verification passed` (or node sub-verifiers all pass individually if tree-sitter-cli EACCES).

- [ ] **Step 6: Commit**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add shared/js-method-extractor.mjs
git commit -m "$(cat <<'EOF'
feat: injector walker helpers (matchInjectorCall, applyTemplate, walkOwnerFunctionForInjectors)

Adds three helpers to shared/js-method-extractor.mjs as
unreferenced dead code; Task 3 wires them in:

- matchInjectorCall(callNode, dataInjectors): detects
  `new <ClassName>(<args>).<methodName>(this)` direct expression
  shape. Match requires call_expression → member_expression →
  new_expression (identifier ctor) → property_identifier method →
  exactly one `this` receiver argument. Every matching config entry
  for the same className + methodName is additive; own-property
  checks prevent prototype names like toString from matching.
  First N constructor args must be string literals (N =
  injector.constructorArgs.length); subsequent args are ignored.
  Returns matched dataKey entries with source: "injector" and
  nameRange pointing at the first constructor literal's
  string_fragment range, or null on no match.

- applyTemplate(template, subst): substitutes ${argName}
  placeholders using the subst map. Uses own-property lookup on a
  null-prototype substitution map. Returns null on unclosed ${ or
  unknown argName — that template is skipped silently.

- walkOwnerFunctionForInjectors(funcNode, sink, dataInjectors):
  mirrors walkOwnerFunctionForSetData's boundary semantics. Stops
  at nested function_expression / function_declaration /
  method_definition / generator_function /
  generator_function_declaration; descends into arrow_function.
  Sink accumulates { keys: [...] }; v1 never escalates dynamic.

verify-js-script-info still passes with 47 cases unchanged.
EOF
)"
```

---

## Task 3: Wire helpers + thread config + J1 happy-path lock

**Files:**
- Modify: `/Users/zs/Desktop/study/wxml-zed/shared/js-method-extractor.mjs` — `extractMethods` accepts `options.dataInjectors`; new walker runs after setData walker.
- Modify: `/Users/zs/Desktop/study/wxml-zed/scripts/extract-wxml-project-graph.mjs` — calls `loadProjectConfig`, threads through.
- Modify: `/Users/zs/Desktop/study/wxml-zed/scripts/verify-js-script-info.mjs` — adds J1 with exact-count assertion; updates source-validity to accept `"injector"`.

- [ ] **Step 1: Update `extractMethods` signature and add the injector walker block**

In `/Users/zs/Desktop/study/wxml-zed/shared/js-method-extractor.mjs`, locate the `extractMethods` signature:

```js
export function extractMethods(parser, source) {
```

Replace with:

```js
export function extractMethods(parser, source, options = {}) {
  const dataInjectors = options.dataInjectors ?? [];
```

Then locate the setData dedup merge block (around lines 458-463):

```js
          const existingDataNames = new Set(dataKeys.map((k) => k.name));
          for (const key of setDataSink.keys) {
            if (existingDataNames.has(key.name)) continue;
            existingDataNames.add(key.name);
            dataKeys.push(key);
          }
```

Immediately AFTER this block (still inside the `else if (firstArg)` branch), insert:

```js
          // Injector walker: same scope iteration as setData walker, but
          // matches `new X(literal).method(this)` shapes against config-
          // declared injectors. Runs only if dataInjectors is non-empty
          // (zero injectors = no work, no allocation).
          if (dataInjectors.length > 0) {
            const injectorSink = { keys: [] };
            if (factory === "Page") {
              for (const fn of functionValuedPairs(opts)) {
                walkOwnerFunctionForInjectors(fn, injectorSink, dataInjectors);
              }
            } else {
              for (const fn of functionValuedPairs(opts)) {
                walkOwnerFunctionForInjectors(fn, injectorSink, dataInjectors);
              }
              const methodsBlockForInjector = methodsBlockOf(opts);
              if (methodsBlockForInjector) {
                for (const fn of functionValuedPairs(methodsBlockForInjector)) {
                  walkOwnerFunctionForInjectors(fn, injectorSink, dataInjectors);
                }
              }
              for (const blockName of ["lifetimes", "pageLifetimes", "observers"]) {
                const block = namedObjectBlock(opts, blockName);
                if (block) {
                  for (const fn of functionValuedPairs(block)) {
                    walkOwnerFunctionForInjectors(fn, injectorSink, dataInjectors);
                  }
                }
              }
              const propertiesBlockForInjector = propertiesBlockOf(opts);
              if (propertiesBlockForInjector) {
                for (const obs of propertyObservers(propertiesBlockForInjector)) {
                  walkOwnerFunctionForInjectors(obs, injectorSink, dataInjectors);
                }
              }
            }

            // Merge into dataKeys with dedup (data block + setData already
            // present in dataKeys; injector entries are last-priority).
            const existingNamesAfterSetData = new Set(dataKeys.map((k) => k.name));
            for (const key of injectorSink.keys) {
              if (existingNamesAfterSetData.has(key.name)) continue;
              existingNamesAfterSetData.add(key.name);
              dataKeys.push(key);
            }
          }
```

- [ ] **Step 2: Update `scripts/extract-wxml-project-graph.mjs` to load and thread the config**

Add the import near the top of the file (alongside existing imports):

```js
import { loadProjectConfig } from "../shared/project-config.mjs";
```

Find the `attachScripts(graph)` function (around line 422). Change its signature:

```js
async function attachScripts(graph, projectRoot) {
```

Inside `attachScripts`, immediately after the `for (const config of graph.configs)` loop's start but BEFORE entering the loop body, load the config once:

```js
async function attachScripts(graph, projectRoot) {
  const projectConfig = loadProjectConfig(projectRoot);
  const dataInjectors = projectConfig.dataInjectors;
  // ... (rest of existing function body)
```

Then locate the `extractMethods(parser, source)` call (around line 462):

```js
      info = extractMethods(parser, source);
```

Replace with:

```js
      info = extractMethods(parser, source, { dataInjectors });
```

Finally update the call to `attachScripts` at the bottom of the file (around line 484):

```js
await attachScripts(graph);
```

Replace with:

```js
await attachScripts(graph, path.resolve(projectRoot));
```

- [ ] **Step 3: Update `verify-js-script-info.mjs` source-validity assertion**

In `/Users/zs/Desktop/study/wxml-zed/scripts/verify-js-script-info.mjs`, locate the existing dataKeys structural assertion. After Task 1 of P2 round 1 it has this shape (or close to it):

```js
for (const entry of result.dataKeys) {
  // ... nameRange check ...
  assert(
    entry.source === "data" || entry.source === "setData",
    `${label}: dataKey "${entry.name}" has invalid source ${JSON.stringify(entry.source)}`,
  );
}
```

Update the assertion's accepted-source set to include `"injector"`:

```js
  assert(
    entry.source === "data" || entry.source === "setData" || entry.source === "injector",
    `${label}: dataKey "${entry.name}" has invalid source ${JSON.stringify(entry.source)}`,
  );
```

- [ ] **Step 4: Add J1 (happy path) to verify-js-script-info.mjs**

The existing file has a `CASES` array of test cases. Locate it (search for "label:" entries). Add J1 to the CASES array using the current verifier field names: `label`, `source`, `hasDynamicMethods`, `methodNames`, `dataKeys`, `propertyKeys`, `hasDynamicData`, and optional `dataKeySources`. Add one new optional field: `dataInjectors`.

The runner currently destructures case fields in the `for (const { ... } of CASES)` loop and calls `extractMethods(parser, source)`. Add `dataInjectors` to that destructuring list, then pass it through:

```js
for (const { label, source, hasDynamicMethods, methodNames, dataKeys, propertyKeys, hasDynamicData, dataKeySources, propertyKeySources, dataInjectors } of CASES) {
  const result = extractMethods(parser, source, { dataInjectors: dataInjectors ?? [] });
  // existing assertions continue unchanged...
}
```

If the local code has been refactored to use `c.source` instead of destructuring, use the equivalent form:

```js
const result = extractMethods(parser, c.source, { dataInjectors: c.dataInjectors ?? [] });
```

Add this J1 case at the end of CASES (before the closing `];`):

```js
{
  label: "J1: injector — happy path, new LoadStates('load').applyTo(this) in onLoad",
  source: `Page({
    data: {},
    onLoad() {
      new LoadStates("load").applyTo(this);
    },
  });`,
  dataInjectors: [
    {
      className: "LoadStates",
      constructorArgs: ["name"],
      methods: {
        applyTo: ["${name}_state", "${name}_states"],
      },
    },
  ],
  methodNames: ["onLoad"],
  dataKeys: ["load_state", "load_states"],
  dataKeySources: { load_state: "injector", load_states: "injector" },
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

Do not use `expectedDataKeys` / `expectedMethods` style names here; the current runner destructures `dataKeys`, `methodNames`, `hasDynamicData`, etc. directly.

- [ ] **Step 5: Run verify-js-script-info — expect 48 cases pass (47 + J1)**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-js-script-info.mjs
```

Expected: `[verify-js-script-info] All 48 script-info cases match. PASS`.

Failure-mode triage:

- J1 fails with `dataKeys length 0 expected 2` → wiring not invoking the walker. Check Step 1's insertion location. The new block must be inside the `else if (firstArg)` branch, after the setData merge.
- J1 fails with source `setData` instead of `injector` → walker found the call but the matchInjectorCall return shape is wrong. Check the `source: "injector"` literal in matchInjectorCall.
- Pre-existing case fails on source-validity → Step 3's source-set update wasn't applied. Re-check.
- J1 fails with `Cannot read property of undefined` on options.dataInjectors → Step 1's default value `options = {}` not applied. Re-check the signature change.

- [ ] **Step 6: Smoke-test the graph extractor with a config**

Quick sanity check that the wiring works end-to-end through the graph extractor:

```bash
# Create a tiny project with a config + matching source.
TMP=$(mktemp -d)
cat > "$TMP/app.json" <<'JSON'
{ "pages": ["pages/home/home"] }
JSON
mkdir -p "$TMP/pages/home"
cat > "$TMP/pages/home/home.json" <<'JSON'
{}
JSON
cat > "$TMP/pages/home/home.wxml" <<'WXML'
<view>{{load_state}}</view>
WXML
cat > "$TMP/pages/home/home.js" <<'JS'
Page({
  data: {},
  onLoad() {
    new LoadStates("load").applyTo(this);
  },
});
JS
cat > "$TMP/wxml-zed.config.json" <<'JSON'
{
  "dataInjectors": [
    {
      "className": "LoadStates",
      "constructorArgs": ["name"],
      "methods": { "applyTo": ["${name}_state", "${name}_states"] }
    }
  ]
}
JSON

node /Users/zs/Desktop/study/wxml-zed/scripts/extract-wxml-project-graph.mjs "$TMP" 2>&1 | node -e '
const g = JSON.parse(require("fs").readFileSync(0, "utf8"));
const home = g.configs.find(c => c.path.endsWith("home/home.json"));
console.log("home dataKeys:", home?.script?.dataKeys?.map(k => `${k.name}(${k.source})`));
'

rm -rf "$TMP"
```

Expected output:

```
home dataKeys: [ 'load_state(injector)', 'load_states(injector)' ]
```

If the output shows `load_state(injector), load_states(injector)`, the wiring works end-to-end. If the dataKeys is empty or missing source labels, debug the integration.

- [ ] **Step 7: Run umbrella verifier**

```bash
bash /Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh 2>&1 | tail -3
```

Expected: `wxml-zed tree-sitter verification passed` (or all node sub-verifiers pass individually).

- [ ] **Step 8: Commit**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add shared/js-method-extractor.mjs scripts/extract-wxml-project-graph.mjs scripts/verify-js-script-info.mjs
git commit -m "$(cat <<'EOF'
feat: wire injector walker + J1 happy-path lock

Wires the three injector helpers (landed previous commit) into
extractMethods + the graph extractor:

- extractMethods now accepts options.dataInjectors. The injector
  walker runs AFTER the setData walker block, using the same scope
  iteration pattern (Page top-level functions; Component top-level
  lifecycle + methods + lifetimes + pageLifetimes + observers +
  property observers). Merges into dataKeys with last-priority
  dedup: data block first, setData walker second, injector walker
  third.

- scripts/extract-wxml-project-graph.mjs loads
  <projectRoot>/wxml-zed.config.json once at graph build time
  (via loadProjectConfig from previous commit's shared/
  project-config.mjs). Threads through to extractMethods as
  options.dataInjectors. Zero-cost when config is missing
  (loader returns empty injectors silently).

- scripts/verify-js-script-info.mjs's source-validity assertion
  now accepts "injector" as a valid dataKey.source value (third
  alongside "data" and "setData"). Adds J1 happy-path test case:
  Page with `new LoadStates("load").applyTo(this)` in onLoad +
  config declaring LoadStates → dataKeys gains `load_state`,
  `load_states`, both with source: "injector".

48 cases pass (47 existing + J1). LSP overlay path unaffected;
editing wxml-zed.config.json triggers graph rebuild via existing
**/*.json watcher (no separate config watcher needed).
EOF
)"
```

---

## Task 4: J2–J12 — 11 more synthetic test cases

**Files:**
- Modify: `/Users/zs/Desktop/study/wxml-zed/scripts/verify-js-script-info.mjs` — append 11 new test cases.

These lock all the non-happy-path branches: no injectors, multi-class, non-literal arg, non-this receiver, no-method-match, no-class-match, data block dedup, arrow descends, regular function blocks, undefined template variable, and duplicate className/method entries applying additively.

Add each case to the CASES array in the same format as J1.

- [ ] **Step 1: Add J2 (no injectors)**

```js
{
  label: "J2: injector — same source as J1 but no dataInjectors config",
  source: `Page({
    data: {},
    onLoad() {
      new LoadStates("load").applyTo(this);
    },
  });`,
  dataInjectors: [],
  methodNames: ["onLoad"],
  dataKeys: [],
  dataKeySources: {},
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

- [ ] **Step 2: Add J3 (multiple distinct names)**

```js
{
  label: "J3: injector — two new expressions with distinct first-args produce all keys",
  source: `Page({
    data: {},
    onLoad() {
      new LoadStates("foo").applyTo(this);
      new LoadStates("bar").applyTo(this);
    },
  });`,
  dataInjectors: [
    {
      className: "LoadStates",
      constructorArgs: ["name"],
      methods: { applyTo: ["${name}_state", "${name}_states"] },
    },
  ],
  methodNames: ["onLoad"],
  dataKeys: ["foo_state", "foo_states", "bar_state", "bar_states"],
  dataKeySources: {
    foo_state: "injector",
    foo_states: "injector",
    bar_state: "injector",
    bar_states: "injector",
  },
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

- [ ] **Step 3: Add J4 (non-literal constructor arg)**

```js
{
  label: "J4: injector — non-literal constructor arg skips match",
  source: `Page({
    data: {},
    onLoad() {
      new LoadStates(name).applyTo(this);
    },
  });`,
  dataInjectors: [
    {
      className: "LoadStates",
      constructorArgs: ["name"],
      methods: { applyTo: ["${name}_state", "${name}_states"] },
    },
  ],
  methodNames: ["onLoad"],
  dataKeys: [],
  dataKeySources: {},
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

- [ ] **Step 4: Add J5 (receiver not this)**

```js
{
  label: "J5: injector — receiver not `this` skips match",
  source: `Page({
    data: {},
    onLoad() {
      new LoadStates("load").applyTo(otherPage);
    },
  });`,
  dataInjectors: [
    {
      className: "LoadStates",
      constructorArgs: ["name"],
      methods: { applyTo: ["${name}_state", "${name}_states"] },
    },
  ],
  methodNames: ["onLoad"],
  dataKeys: [],
  dataKeySources: {},
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

- [ ] **Step 5: Add J6 (className matches but method does not)**

```js
{
  label: "J6: injector — className matches but methodName not in config",
  source: `Page({
    data: {},
    onLoad() {
      new LoadStates("load").otherMethod(this);
    },
  });`,
  dataInjectors: [
    {
      className: "LoadStates",
      constructorArgs: ["name"],
      methods: { applyTo: ["${name}_state", "${name}_states"] },
    },
  ],
  methodNames: ["onLoad"],
  dataKeys: [],
  dataKeySources: {},
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

- [ ] **Step 6: Add J7 (className does not match)**

```js
{
  label: "J7: injector — className doesn't match any config",
  source: `Page({
    data: {},
    onLoad() {
      new OtherClass("load").applyTo(this);
    },
  });`,
  dataInjectors: [
    {
      className: "LoadStates",
      constructorArgs: ["name"],
      methods: { applyTo: ["${name}_state", "${name}_states"] },
    },
  ],
  methodNames: ["onLoad"],
  dataKeys: [],
  dataKeySources: {},
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

- [ ] **Step 7: Add J8 (data block dedup — data wins over injector)**

```js
{
  label: "J8: injector — data block name wins over injector dedup",
  source: `Page({
    data: { load_state: null },
    onLoad() {
      new LoadStates("load").applyTo(this);
    },
  });`,
  dataInjectors: [
    {
      className: "LoadStates",
      constructorArgs: ["name"],
      methods: { applyTo: ["${name}_state", "${name}_states"] },
    },
  ],
  methodNames: ["onLoad"],
  dataKeys: ["load_state", "load_states"],
  dataKeySources: { load_state: "data", load_states: "injector" },
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

- [ ] **Step 8: Add J9 (arrow descends)**

```js
{
  label: "J9: injector — walker descends into nested arrow (setTimeout)",
  source: `Page({
    data: {},
    onLoad() {
      setTimeout(() => new LoadStates("load").applyTo(this), 0);
    },
  });`,
  dataInjectors: [
    {
      className: "LoadStates",
      constructorArgs: ["name"],
      methods: { applyTo: ["${name}_state", "${name}_states"] },
    },
  ],
  methodNames: ["onLoad"],
  dataKeys: ["load_state", "load_states"],
  dataKeySources: { load_state: "injector", load_states: "injector" },
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

- [ ] **Step 9: Add J10 (regular function boundary blocks)**

```js
{
  label: "J10: injector — nested regular function boundary blocks walker",
  source: `Page({
    data: {},
    onLoad() {
      setTimeout(function () { new LoadStates("load").applyTo(this); }, 0);
    },
  });`,
  dataInjectors: [
    {
      className: "LoadStates",
      constructorArgs: ["name"],
      methods: { applyTo: ["${name}_state", "${name}_states"] },
    },
  ],
  methodNames: ["onLoad"],
  dataKeys: [],
  dataKeySources: {},
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

- [ ] **Step 10: Add J11 (undefined template variable)**

```js
{
  label: "J11: injector — undefined ${unknown} skips just that template",
  source: `Page({
    data: {},
    onLoad() {
      new X("a").m(this);
    },
  });`,
  dataInjectors: [
    {
      className: "X",
      constructorArgs: ["name"],
      methods: { m: ["${unknown}_x", "${name}_ok"] },
    },
  ],
  methodNames: ["onLoad"],
  dataKeys: ["a_ok"],
  dataKeySources: { a_ok: "injector" },
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

- [ ] **Step 11: Add J12 (same className + same method entries are additive)**

```js
{
  label: "J12: injector — duplicate className/method config entries are additive",
  source: `Page({
    data: {},
    onLoad() {
      new LoadStates("load").applyTo(this);
    },
  });`,
  dataInjectors: [
    {
      className: "LoadStates",
      constructorArgs: ["name"],
      methods: { applyTo: ["${name}_state"] },
    },
    {
      className: "LoadStates",
      constructorArgs: ["name"],
      methods: { applyTo: ["${name}_states"] },
    },
  ],
  methodNames: ["onLoad"],
  dataKeys: ["load_state", "load_states"],
  dataKeySources: { load_state: "injector", load_states: "injector" },
  propertyKeys: [],
  hasDynamicMethods: false,
  hasDynamicData: false,
},
```

This locks the spec rule that duplicate `className` entries are kept and methods merge additively. It would fail if `matchInjectorCall` uses `.find(...)` instead of collecting every matching config.

- [ ] **Step 12: Run verify — 59 cases must pass (47 + J1 + J2–J12)**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-js-script-info.mjs
```

Expected: `[verify-js-script-info] All 59 script-info cases match. PASS`.

Per-case failure-mode triage:

- **J2 fails with non-empty dataKeys** → walker block isn't gated on `dataInjectors.length > 0`. Check Task 3 Step 1's `if (dataInjectors.length > 0)` wrapper.
- **J3 fails with only 2 keys instead of 4** → walker is matching the first new expression but stopping. Likely the visit function's recursion ends prematurely; check the recursion at the end of `walkOwnerFunctionForInjectors`'s `visit` function.
- **J4 fails with non-empty dataKeys** → matchInjectorCall isn't checking that constructor args are string literals. Check the loop in `matchInjectorCall`: `if (!argNode || argNode.type !== "string") return null;`.
- **J5 fails** → receiver check missing. Check `if (receiver.type !== "this") return null;`.
- **J6 fails** → method-name check missing. Check `Object.hasOwn(cfg.methods, methodName)`.
- **J7 fails** → className check missing. Check `cfg.className === className`.
- **J8 fails with load_state source as "injector"** → dedup is wrong. Data block keys are pushed first by `extractDataKeys`; the injector merge's `existingNamesAfterSetData.has` check must catch this. Verify the dedup uses the CURRENT `dataKeys` array (which already has data block + setData entries) when building `existingNamesAfterSetData`.
- **J9 fails with empty dataKeys** → walker boundary check is OVER-broad (excluding arrow_function). Check the boundary check in `walkOwnerFunctionForInjectors`: arrow_function MUST NOT be in the boundary set.
- **J10 fails with non-empty dataKeys** → walker boundary check is missing function_expression. Verify the 5-type boundary set in `walkOwnerFunctionForInjectors`.
- **J11 fails with both keys or no keys** → applyTemplate isn't returning null on unknown ${argName}. Check the `if (!Object.hasOwn(subst, argName)) return null;` line.
- **J12 fails with only one key** → matcher is stopping at the first duplicate-class config entry. Replace `.find(...)` with additive collection over all matching entries.

- [ ] **Step 13: Umbrella verify**

```bash
bash /Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh 2>&1 | tail -3
```

Expected: `wxml-zed tree-sitter verification passed`.

- [ ] **Step 14: Commit**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add scripts/verify-js-script-info.mjs
git commit -m "$(cat <<'EOF'
test: lock 11 more injector walker decision-matrix branches (J2-J12)

Adds J2-J12 to verify-js-script-info.mjs with exact dataKey +
dataKeySources matching. Combined with J1 (Task 3) these 12
cases cover all of v1's match conditions and non-match paths:

- J1: happy path — `new LoadStates("load").applyTo(this)` in
       owner-context → load_state, load_states injected.
- J2: same source, no injectors config → no keys.
- J3: two new expressions, different first-args → all 4 keys.
- J4: non-literal constructor arg → no match.
- J5: receiver not `this` → no match.
- J6: className matches but methodName not in config → no match.
- J7: className doesn't match any config → no match.
- J8: data block declares the name → "data" source wins via
       dedup; injector still adds the second name.
- J9: walker descends into nested arrow (setTimeout) → match.
- J10: walker stops at nested regular function boundary → no match.
       (Validates the 5-type boundary set matches the setData
       walker's design.)
- J11: undefined ${unknown} in template → that template skipped,
       other templates in same produces array still emit.
- J12: duplicate className + same method config entries → additive
       merge across matching entries, not first-match-only.

59 cases pass (47 existing + 12 J-cases). All exact-count
assertions.
EOF
)"
```

---

## Task 5: chelaile dogfood + Outcome notes + spike notes follow-up

**Files:**
- Modify: `/Users/zs/Desktop/study/wxml-zed/docs/superpowers/plans/2026-05-22-config-driven-data-injectors.md` (this plan) — append Outcome section.
- Modify: `/Users/zs/Desktop/study/wxml-zed/docs/wasm-parser-spike-notes.md` — append follow-up section.

- [ ] **Step 1: Create the chelaile dogfood snapshot directory and config paths**

```bash
mkdir -p /tmp/wxml-zed-diagnostics-p22a/before /tmp/wxml-zed-diagnostics-p22a/after
CHELAILE_ROOT=/Users/zs/Desktop/zs_work/mp-wx-chelaile/wx
CHELAILE_CONFIG="$CHELAILE_ROOT/wxml-zed.config.json"
CHELAILE_CONFIG_BACKUP=/tmp/wxml-zed-diagnostics-p22a/wxml-zed.config.json.backup
```

- [ ] **Step 2: Guard against overwriting a real chelaile config**

Before writing the temporary config, check whether chelaile already has a `wxml-zed.config.json`.

```bash
CHELAILE_ROOT=/Users/zs/Desktop/zs_work/mp-wx-chelaile/wx
CHELAILE_CONFIG="$CHELAILE_ROOT/wxml-zed.config.json"
CHELAILE_CONFIG_BACKUP=/tmp/wxml-zed-diagnostics-p22a/wxml-zed.config.json.backup
if [ -f "$CHELAILE_CONFIG" ]; then
  cp "$CHELAILE_CONFIG" "$CHELAILE_CONFIG_BACKUP"
  echo "Existing chelaile wxml-zed.config.json backed up to $CHELAILE_CONFIG_BACKUP"
else
  rm -f "$CHELAILE_CONFIG_BACKUP"
fi
```

This prevents the dogfood run from destroying a real user/project config. Step 8 restores the backup if one existed.

- [ ] **Step 3: Capture BEFORE snapshot (current state, before temporary config)**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/dump-project-diagnostics.mjs \
  /Users/zs/Desktop/zs_work/mp-wx-chelaile/wx \
  --out /tmp/wxml-zed-diagnostics-p22a/before
```

Verify BEFORE matches the post-P2.2-B state:

```bash
node -e 'const j = JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-diagnostics-p22a/before/wx.summary.json", "utf8")); console.log("BEFORE total:", j.total, "byCode:", JSON.stringify(j.byCode));'
```

Expected: `BEFORE total: 26 byCode: {"missing-expression-ref":7,"missing-event-handler":7,"dead-component-binding":12}` (or close — the precise byCode depends on chelaile working-tree state).

- [ ] **Step 4: Drop a temporary `wxml-zed.config.json` into chelaile (NOT committed there)**

```bash
CHELAILE_CONFIG=/Users/zs/Desktop/zs_work/mp-wx-chelaile/wx/wxml-zed.config.json
cat > "$CHELAILE_CONFIG" <<'JSON'
{
  "dataInjectors": [
    {
      "className": "LoadStates",
      "constructorArgs": ["name"],
      "methods": {
        "applyTo": ["${name}_state", "${name}_states"],
        "applyStateTo": ["${name}_state"],
        "applyStatesTo": ["${name}_states"]
      }
    },
    {
      "className": "States",
      "constructorArgs": ["name"],
      "methods": {
        "applyTo": ["${name}_state", "${name}_states"],
        "applyStateTo": ["${name}_state"],
        "applyStatesTo": ["${name}_states"]
      }
    }
  ]
}
JSON
```

This file is temporary for verification. We do NOT commit it to chelaile (it's not our project); the wxml-zed plan's Outcome section documents the config inline so future users know what to put in their own projects.

- [ ] **Step 5: Capture AFTER snapshot (with config)**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/dump-project-diagnostics.mjs \
  /Users/zs/Desktop/zs_work/mp-wx-chelaile/wx \
  --out /tmp/wxml-zed-diagnostics-p22a/after
```

- [ ] **Step 6: Verify acceptance gates**

```bash
node -e '
const before = JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-diagnostics-p22a/before/wx.summary.json"));
const after = JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-diagnostics-p22a/after/wx.summary.json"));
console.log("=== BEFORE ===");
console.log("  total:", before.total);
console.log("  byCode:", JSON.stringify(before.byCode));
console.log("=== AFTER ===");
console.log("  total:", after.total);
console.log("  byCode:", JSON.stringify(after.byCode));
console.log("=== ACCEPTANCE CHECKS ===");
const beforeEvt = before.byCode["missing-event-handler"] || 0;
const afterEvt = after.byCode["missing-event-handler"] || 0;
console.log(`  missing-event-handler: ${beforeEvt} -> ${afterEvt} (must equal)`);
if (beforeEvt !== afterEvt) { console.log("  FAIL"); process.exit(1); }
console.log("  PASS: event-handler count preserved");
const beforeExprRef = before.byCode["missing-expression-ref"] || 0;
const afterExprRef = after.byCode["missing-expression-ref"] || 0;
console.log(`  missing-expression-ref: ${beforeExprRef} -> ${afterExprRef} (must decrease by 2)`);
if (afterExprRef !== beforeExprRef - 2) { console.log("  FAIL"); process.exit(1); }
console.log("  PASS: 2 load_state warnings cleared via injector config");
const beforeDead = before.byCode["dead-component-binding"] || 0;
const afterDead = after.byCode["dead-component-binding"] || 0;
console.log(`  dead-component-binding: ${beforeDead} -> ${afterDead} (expected to decrease when same injected keys appear in component bindings)`);
if (afterDead > beforeDead) { console.log("  FAIL"); process.exit(1); }
console.log("  PASS: dead-component-binding did not increase");
console.log("  TOTAL:", before.total, "->", after.total);
'
```

Expected: every check PASS, exit 0. If any check fails, investigate before continuing.

Failure-mode triage:

- `missing-expression-ref` did not decrease by 2 → config not loaded. Check chelaile project root has `wxml-zed.config.json` with the exact content from Step 3. Check the loader reads it (run a one-off `node -e 'import("/Users/zs/Desktop/study/wxml-zed/shared/project-config.mjs").then(m => console.log(JSON.stringify(m.loadProjectConfig("/Users/zs/Desktop/zs_work/mp-wx-chelaile/wx"), null, 2)))'`).
- `missing-event-handler` count changed → precision regression. Sample the new diagnostics to find which event handler is now affected; this would be a bug.
- `dead-component-binding` count increases → precision regression. If it decreases, sample before/after first: injected parent dataKeys can legitimately suppress prior dead-component-binding entries for the same names.

- [ ] **Step 7: Capture surviving sample (should be 5)**

```bash
grep '"code":"missing-expression-ref"' /tmp/wxml-zed-diagnostics-p22a/after/wx.jsonl | while read -r line; do
  echo "$line" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(`${d.file}:${d.line+1}  name=${d.name}`);'
done
```

Expected output (5 entries):

```
ad/components/taro-weapp/comp.wxml:3  name=i
pages/linedetail/components/bus-profile-normal/cell-history/index.wxml:7  name=cell
pages/login/components/sync-popup/index.wxml:1  name=show
pages/main/home-page/components/operation-postion/index.wxml:1  name=hiddenOperation
pages/more-buses/components/bus/index.wxml:32  name=tomorrow
```

These are the SAME 5 entries documented in P2.2-B's Outcome as "4 reserved-attribute + 1 Taro template-fragment". Confirms the 2 helper-mediated load_state entries cleared.

- [ ] **Step 8: Restore or remove the temporary config from chelaile**

```bash
CHELAILE_CONFIG=/Users/zs/Desktop/zs_work/mp-wx-chelaile/wx/wxml-zed.config.json
CHELAILE_CONFIG_BACKUP=/tmp/wxml-zed-diagnostics-p22a/wxml-zed.config.json.backup
if [ -f "$CHELAILE_CONFIG_BACKUP" ]; then
  cp "$CHELAILE_CONFIG_BACKUP" "$CHELAILE_CONFIG"
  echo "Restored original chelaile wxml-zed.config.json from backup"
else
  rm -f "$CHELAILE_CONFIG"
  echo "Removed temporary chelaile wxml-zed.config.json"
fi
```

- [ ] **Step 9: Append Outcome section to this plan**

Append to the END of `/Users/zs/Desktop/study/wxml-zed/docs/superpowers/plans/2026-05-22-config-driven-data-injectors.md`:

```markdown
---

## Outcome

Real-project dogfood on `mp-wx-chelaile/wx` with the following temporary `wxml-zed.config.json` placed at the project root:

\`\`\`json
{
  "dataInjectors": [
    {
      "className": "LoadStates",
      "constructorArgs": ["name"],
      "methods": {
        "applyTo": ["${name}_state", "${name}_states"],
        "applyStateTo": ["${name}_state"],
        "applyStatesTo": ["${name}_states"]
      }
    },
    {
      "className": "States",
      "constructorArgs": ["name"],
      "methods": {
        "applyTo": ["${name}_state", "${name}_states"],
        "applyStateTo": ["${name}_state"],
        "applyStatesTo": ["${name}_states"]
      }
    }
  ]
}
\`\`\`

| metric | BEFORE (P2.2-B AFTER) | AFTER (P2.2-A) |
|---|---|---|
| total | 26 | 18 |
| missing-event-handler | 7 | 7 |
| missing-expression-ref | 7 | 5 |
| dead-component-binding | 12 | 6 |

### Hard gates (all passed)

- `missing-event-handler`: 7 → 7 (precision preserved)
- `missing-expression-ref`: 7 → 5 (2 `load_state` warnings cleared via injector config)
- `dead-component-binding`: 12 → 6 (6 `states-view` `load_state`/`load_states` pass-through entries also became in-scope parent dataKeys)
- Total: 26 → 18

### Surviving 5 entries (matches P2.2-B's classification table exactly)

| # | file:line | name | bucket |
|---|---|---|---|
| 1 | `pages/main/home-page/components/operation-postion/index.wxml:1` | hiddenOperation | reserved-attribute (wx:if) |
| 2 | `pages/login/components/sync-popup/index.wxml:1` | show | reserved-attribute (wx:if) |
| 3 | `pages/linedetail/components/bus-profile-normal/cell-history/index.wxml:7` | cell | reserved-attribute (wx:if) |
| 4 | `pages/more-buses/components/bus/index.wxml:32` | tomorrow | reserved-attribute (wx:if) |
| 5 | `ad/components/taro-weapp/comp.wxml:3` | i | template-fragment scope (Taro compiled) |

The 4 reserved-attribute entries are correct by design — the dead-component-binding rule excludes `wx:if` and similar reserved attributes from cross-component classification. The Taro entry is a known compiled-output pattern that isn't a standard WeChat WXML form.

### Cleared dead-component-binding entries

The original plan expected `dead-component-binding` to stay at 12, but dogfood showed a correct broader effect: the same injected keys also appear in `states-view` component bindings. Once `load_state` / `load_states` are in the parent dataKeys, those bindings are no longer dead. Cleared entries:

| file:line | identifier | child prop |
|---|---|---|
| `pages/main/fav-page/index.wxml:3` | load_states | states |
| `pages/main/fav-page/index.wxml:3` | load_state | state |
| `pages/metro-line/index.wxml:5` | load_states | states |
| `pages/metro-station/index.wxml:4` | load_states | states |
| `pages/my-fav/index.wxml:1` | load_states | states |
| `pages/my-fav/index.wxml:1` | load_state | state |

### Buckets (next-round input)

- **Reserved-attribute inside wx:if** (4 entries) — could be a future "expressions inside control-flow attributes" diagnostic refinement. Out of scope for this round.
- **Taro compiled template-fragment** (1 entry) — niche compiler-output pattern. Probably not worth its own round unless dogfood reveals more Taro-affected projects.

The config-driven injector approach has zero false positives: every produces-template substitution is grounded in a literal at the call site, and every match condition is AST-shape-precise.
```

- [ ] **Step 10: Append spike-notes follow-up**

Append to `/Users/zs/Desktop/study/wxml-zed/docs/wasm-parser-spike-notes.md` AFTER the existing "Follow-up: cross-component prop binding diagnostic" section's closing `---`:

```markdown
### Follow-up: config-driven data injectors (P2.2-A)

P2.2-A added a project-level `wxml-zed.config.json` mechanism for
declaring helper-class data-injection patterns. v1 narrow scope:
recognizes `new ClassName(string-literal).method(this)` direct
expression shape (whitespace/newlines insignificant — AST-shape-
based, not line-based). Plan:
`docs/superpowers/plans/2026-05-22-config-driven-data-injectors.md`.

Mechanism: `shared/project-config.mjs` hosts `loadProjectConfig` which
reads + validates the config file at graph build time.
`shared/js-method-extractor.mjs` gains `matchInjectorCall` +
`applyTemplate` + `walkOwnerFunctionForInjectors` running alongside
the existing setData walker. Matched calls produce identifier keys
via produces-template substitution; merged into dataKeys with
`source: "injector"` (third valid value alongside `"data"` and
`"setData"`).

The injector walker reuses the setData walker's owner-context scope
enumeration and identical boundary semantics (stops at nested
function_expression / function_declaration / method_definition /
generator_function / generator_function_declaration; descends into
arrow_function).

Outcome on the same chelaile snapshot: 26 → 18 total. The 7
`missing-event-handler` (real bugs) preserved unchanged. 2
helper-mediated `load_state` warnings (from `States.applyTo(this)`
pattern, documented in P2.2-B's surviving-bucket classification) now
cleared via a 2-entry config (`LoadStates` + `States`). 5 surviving
warnings match P2.2-B's full classification table: 4 inside `wx:if`
(reserved-attribute, correctly NOT downgraded) + 1 Taro compiled
template-fragment.

Dogfood also corrected the initial acceptance assumption that
`dead-component-binding` would stay unchanged. It dropped 12 → 6
because six `states-view` bindings used the same injected parent
identifiers (`load_state` / `load_states`) for child props
(`state` / `states`). Once the config makes those parent identifiers
in-scope, those bindings are no longer dead — a legitimate precision
improvement, not a cross-component regression.

The config-driven approach has zero false positives by construction:
every match requires AST-precise conditions (className identifier,
method property identifier, `this` receiver, string-literal first
args) AND every produces-template substitution is grounded in a
literal at the call site.

LSP overlay path unaffected; editing `wxml-zed.config.json` triggers
a graph rebuild via the existing `**/*.json` watcher
(`server/wxml-lsp.mjs`'s `WATCH_REGISTRATION_GLOBS` +
`GRAPH_AFFECTING_EXTENSIONS`).

---
```

- [ ] **Step 11: Commit Outcome + spike notes**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add docs/superpowers/plans/2026-05-22-config-driven-data-injectors.md docs/wasm-parser-spike-notes.md
git commit -m "$(cat <<'EOF'
docs: record P2.2-A dogfood outcome on chelaile

Captures the before/after diagnostic counts after config-driven
data injectors land. With a 2-entry wxml-zed.config.json on
chelaile (LoadStates + States), the 2 surviving helper-mediated
load_state warnings from P2.2-B clear, and 6 states-view
dead-component-binding entries using the same injected keys also
clear correctly. The surviving 5 missing-expression-ref entries
match P2.2-B's full classification exactly:

- missing-event-handler: 7 -> 7 (precision preserved)
- missing-expression-ref: 7 -> 5 (2 cleared via config)
- dead-component-binding: 12 -> 6 (6 states-view load_state/load_states bindings cleared)
- total: 26 -> 18

Surviving 5: 4 inside wx:if (reserved-attribute, correctly NOT
downgraded by the cross-component rule) + 1 Taro compiled
template-fragment.

The injector approach has zero false positives by construction:
every match requires AST-precise conditions, every produces
template substitution is grounded in a call-site literal.
EOF
)"
```

---

## Acceptance Criteria

These are absolute pass/fail gates:

1. All existing tests pass (`bash scripts/verify-tree-sitter.sh` → `wxml-zed tree-sitter verification passed`, or node sub-verifiers all pass individually if tree-sitter-cli has EACCES).
2. `verify-project-config-loading.mjs` reports all 5 cases (C-L1 to C-L5) pass.
3. `verify-js-script-info.mjs` reports all 59 cases (47 existing + J1–J12) pass with exact dataKeys + dataKeySources matching.
4. Source-validity assertion in `verify-js-script-info.mjs` now accepts `"injector"` as a valid `dataKey.source` value.
5. chelaile dogfood with the 2-entry config:
   - `missing-event-handler`: 7 → 7
   - `missing-expression-ref`: 7 → 5 (2 load_state cleared)
   - `dead-component-binding`: 12 → 6
   - Total: 26 → 18
6. Outcome section in this plan has real numbers (no `<N>` / `<M>` placeholders).
7. Every commit on the implementation branch is independently green.

## Self-Review

- All file paths absolute and resolve to real locations.
- `loadProjectConfig` signature consistent: `(projectRoot) → { dataInjectors: [...] }`. Used in Task 1, exported from `shared/project-config.mjs`. Consumed in Task 3 by `scripts/extract-wxml-project-graph.mjs`.
- `matchInjectorCall(callNode, dataInjectors)` signature consistent: returns array of keys or null. Used in Task 2 (definition) and Task 2's `walkOwnerFunctionForInjectors` (consumer).
- `applyTemplate(template, subst)` signature consistent: returns string or null. Used inside `matchInjectorCall`.
- `walkOwnerFunctionForInjectors(funcNode, sink, dataInjectors)` signature consistent. Called from Task 3's wiring block.
- `extractMethods(parser, source, options = {})` — backwards compatible (callers without `options` still work).
- Boundary set: identical 5 types between setData walker and injector walker. Locked by J9 (arrow descends) and J10 (regular function blocks).
- Dedup order: data block (source: "data") → setData (source: "setData") → injector (source: "injector"). First-name-wins. Locked by J8 (data block wins).
- Empty `constructorArgs` reject at LOAD time (validation), not at match time. Test C-L5.
- Acceptance criteria's chelaile gates are concrete numbers (not `<N>` placeholders).
- Each commit is green: Task 1 lands new files + umbrella wiring (no production behavior change); Task 2 adds unreferenced dead code; Task 3 wires + adds J1 (TDD-green); Task 4 adds J2–J12 (all should pass against Task 3's wiring); Task 5 is docs-only.
- chelaile dogfood uses an explicit `/tmp/wxml-zed-diagnostics-p22a/{before,after}/` path scheme (no `/tmp/claude-501/` / no `$TMPDIR` dependency).
- The temporary chelaile config in Task 5 is restored from backup if a real config existed, otherwise removed — not left behind and not destructive.

---

## Outcome

Real-project dogfood on `mp-wx-chelaile/wx` with a temporary `wxml-zed.config.json` placed at the project root:

```json
{
  "dataInjectors": [
    {
      "className": "LoadStates",
      "constructorArgs": ["name"],
      "methods": {
        "applyTo": ["${name}_state", "${name}_states"],
        "applyStateTo": ["${name}_state"],
        "applyStatesTo": ["${name}_states"]
      }
    },
    {
      "className": "States",
      "constructorArgs": ["name"],
      "methods": {
        "applyTo": ["${name}_state", "${name}_states"],
        "applyStateTo": ["${name}_state"],
        "applyStatesTo": ["${name}_states"]
      }
    }
  ]
}
```

Snapshot caveat: chelaile was on `feature/skill-bus` at `7fb6f7e782961393f115bb51f82fdd773fbf17e5` with 4 dirty files before adding the temporary config. Counts are dogfood evidence, not a clean release baseline.

| metric | BEFORE (P2.2-B after) | AFTER (P2.2-A) |
|---|---:|---:|
| total | 26 | 18 |
| missing-event-handler | 7 | 7 |
| missing-expression-ref | 7 | 5 |
| dead-component-binding | 12 | 6 |

Hard gates:
- `missing-event-handler`: 7 → 7 (precision preserved)
- `missing-expression-ref`: 7 → 5 (2 helper-mediated `load_state` warnings cleared via injector config)
- `dead-component-binding`: 12 → 6 (6 `states-view` pass-through bindings using `load_state` / `load_states` also became valid parent-scope bindings)
- Total: 26 → 18

Surviving 5 `missing-expression-ref` entries:

| file:line | name | bucket |
|---|---|---|
| `ad/components/taro-weapp/comp.wxml:3` | i | template-fragment scope (Taro compiled) |
| `pages/linedetail/components/bus-profile-normal/cell-history/index.wxml:7` | cell | reserved-attribute (`wx:if`) |
| `pages/login/components/sync-popup/index.wxml:1` | show | reserved-attribute (`wx:if`) |
| `pages/main/home-page/components/operation-postion/index.wxml:1` | hiddenOperation | reserved-attribute (`wx:if`) |
| `pages/more-buses/components/bus/index.wxml:32` | tomorrow | reserved-attribute (`wx:if`) |

Cleared `dead-component-binding` entries:

| file:line | identifier | child prop |
|---|---|---|
| `pages/main/fav-page/index.wxml:3` | load_states | states |
| `pages/main/fav-page/index.wxml:3` | load_state | state |
| `pages/metro-line/index.wxml:5` | load_states | states |
| `pages/metro-station/index.wxml:4` | load_states | states |
| `pages/my-fav/index.wxml:1` | load_states | states |
| `pages/my-fav/index.wxml:1` | load_state | state |

This corrected the original plan assumption that `dead-component-binding` would remain unchanged. The decrease is expected: config-injected dataKeys make the parent identifiers real, so those component bindings are no longer dead.
