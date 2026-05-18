# Event Handler Diagnostic v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 2 Stage C, closing the Event Handler Intelligence v1 trio. Emit an LSP Warning diagnostic on the handler name when a WXML event-handler binding (`bind:tap="onTap"`) references a method that doesn't exist in the sibling `.js` Page/Component factory. Comes with disciplined false-positive controls so real WeChat code using spread / `Object.assign` / `behaviors` is not flagged.

**Architecture:** Two phases. **Phase C1** extends `shared/js-method-extractor.mjs` to detect suppressor signals (spread elements, `behaviors: [...]`, non-object factory arg) and surface them as `script.hasDynamicMethods: boolean` alongside the existing `methods` array. **Phase C2** adds an `eventHandlerDiagnostics` helper in `server/wxml-language-service.mjs`; `getDiagnostics()` now concatenates missing-local-component diagnostics with event-handler diagnostics. The diagnostic suppresses on: handler `dynamic=true`; owner has no sibling script; `script.hasDynamicMethods=true`; attr name fails the strict `isEventHandlerCompletionTrigger` gate (so `binding="foo"` doesn't get warned about); name matches *any* method kind (lifecycle counts — calling `bind:tap="attached"` is unusual but valid).

**Verification:** Unit-level only.
- `scripts/verify-js-script-info.mjs` (new programmatic verifier) covers the extractor's `hasDynamicMethods` flag on **12** synthetic JS inputs: plain Page, plain Component, options spread, methods-block spread, non-empty `behaviors: [...]`, empty `behaviors: []`, `behaviors: identifier`, `methods: identifier`, `methods: Object.assign(...)`, `Object.assign(...)` factory arg, Page with spread, no factory call.
- `scripts/verify-wxml-language-service.mjs` adds **7** `assertEventHandlerDiagnostic*` assertions: positive-clean (home.wxml unchanged → no new diagnostics); positive emission via colon strict-gate branch (`bind:select` missing handler); positive emission via no-colon short-form branch (`bindtap` missing handler); four suppressions (dynamic, `hasDynamicMethods`, loose-but-not-strict event binding, no sibling script).
- **No new LSP protocol test.** Diagnostics share one `textDocument/publishDiagnostics` channel; the existing `assertMissingCardDiagnostic` already exercises the routing. Adding a second diagnostic *type* doesn't change the protocol path.
- **No new fixtures.** All negative cases use in-memory graph mutation following the Stage A `assertEventHandlerDefinitionMissingMethod` precedent.

**Out of scope (v1):**
- Cross-file `behaviors: [...]` resolution (we suppress when behaviors present; we don't read the imported behavior modules)
- `Object.assign(opts, other)` where `opts` is a let-bound variable later passed to the factory — too dynamic; the flag covers only the inline form via the "first arg not an inline object" check
- TS / TSX sibling files
- Quick-fix code action ("create stub method in .js") — Phase 3 candidate
- Computed property keys (`methods: { [name]: function() {} }`) — uncommon; methods that don't get extracted *won't* produce false negatives because they'd already be missing from extracted methods; they may produce false-positives on bound handlers that match the computed name, accepted

**Tech Stack:** No new dependencies. Reuses the existing tree-sitter-javascript parser path, the strict gate from `shared/event-binding-patterns.mjs`, and the `findOwnerConfigWithScript` helper added during Stage B's simplify pass.

---

## File Structure

- Modify: `shared/js-method-extractor.mjs`
  - Change `extractMethods(parser, source)` return type from `MethodEntry[]` to `{methods: MethodEntry[], hasDynamicMethods: boolean}`
  - Add internal `detectDynamicMethodsInOptions(opts)` that returns `true` if a `spread_element` or non-empty `behaviors` array is present in the options object literal or its `methods:` sub-object
  - Update `extractMethods` to also flag `hasDynamicMethods=true` when the factory's first arg is not a plain object (handles the `Object.assign(...)` case where existing `optionsObject()` returns null)
- Modify: `scripts/poc-js-method-extractor.mjs`
  - Unpack `.methods` from new return shape so the existing baseline file stays byte-identical
- Modify: `scripts/extract-wxml-project-graph.mjs`
  - Use both fields: `config.script = {path, methods, hasDynamicMethods}`
- Create: `scripts/verify-js-script-info.mjs`
  - Programmatic in-process test against synthetic JS sources covering each suppressor signal
- Modify: `scripts/verify-tree-sitter.sh`
  - Add the new verifier between `verify-js-method-baselines.mjs` and `verify-lsp-diagnostics.mjs`
- Modify: `server/wxml-language-service.mjs`
  - Add `eventHandlerDiagnostics(graph, documentGraphPath, fileModel)` helper near the existing `getDiagnostics`
  - Add `attrNameFromHandler(entry)` tiny helper that returns `entry.binding + entry.event`
  - Modify `getDiagnostics` to `return [...componentDiags, ...eventHandlerDiags]`
- Modify: `scripts/verify-wxml-language-service.mjs`
  - 7 new `assertEventHandlerDiagnostic*` assertions registered in the runner list near the existing diagnostic asserts
- Modify: `docs/wasm-parser-spike-notes.md`
  - Append a Stage C section after the Stage B section, before the trailing regression-anchor block

---

### Task 1: Extend extractMethods to detect dynamic-method signals

**Files:**
- Modify: `shared/js-method-extractor.mjs:86-115` (`extractMethods`)

The detector triggers `hasDynamicMethods=true` when ANY of these are true:

1. The factory call's first argument is not a plain object literal (covers `Object.assign(...)`, identifier reference, function call producing options, etc.). Today `optionsObject()` returns `null` in this case and the function silently skips. Instead we should flag and continue.
2. Any `spread_element` is a direct child of the options object literal (`{...base, methods: ...}`).
3. Any `spread_element` is a direct child of the `methods` sub-object literal (`methods: { ...common, custom() {} }`). Only relevant for `Component(...)`.
4. The options object has a `methods` property whose value is **not** an inline object literal — e.g. `methods: commonMethods` (identifier), `methods: Object.assign({}, common, {...})` (call), `methods: getMethods()` (call). The existing `methodsBlockOf` returns null in these cases so methods extraction silently produces []; without flagging, every handler bound in WXML would falsely warn as missing.
5. The options object has a `behaviors` property. If the value is an array literal, suppress only when it's non-empty (empty `behaviors: []` cannot inject anything). If the value is anything else (identifier, call, etc.), suppress unconditionally — same reasoning as (4): variable references may inject methods we can't statically see.

- [ ] **Step 1: Add a `containsSpread(objectNode)` helper**

  Insert after `methodsBlockOf` (around line 84):

  ```js
  function containsSpread(objectNode) {
    for (let i = 0; i < objectNode.namedChildCount; i++) {
      if (objectNode.namedChild(i).type === "spread_element") return true;
    }
    return false;
  }
  ```

- [ ] **Step 2: Add a `dynamicMethodsViaProperty(objectNode)` helper**

  Insert next to `containsSpread`. The detector walks the options object's `pair` children once, looking for `behaviors` and `methods` properties; if EITHER signals dynamic methods, return true.

  Semantics:
  - `behaviors`: array literal → true iff non-empty; any other value type (identifier, call, etc.) → true (we can't statically know what methods they inject).
  - `methods`: object literal → false (the existing `methodsBlockOf` walker handles it; spreads within get caught by the methods-block scan at Step 3 of `extractMethods`); any other value type → true.

  ```js
  function dynamicMethodsViaProperty(objectNode) {
    for (let i = 0; i < objectNode.namedChildCount; i++) {
      const child = objectNode.namedChild(i);
      if (child.type !== "pair") continue;
      const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
      if (!keyNode || keyNode.type !== "property_identifier") continue;
      const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
      if (!valueNode) continue;

      if (keyNode.text === "behaviors") {
        if (valueNode.type === "array") {
          if (valueNode.namedChildCount > 0) return true;
        } else {
          return true;
        }
      } else if (keyNode.text === "methods") {
        if (valueNode.type !== "object") return true;
      }
    }
    return false;
  }
  ```

- [ ] **Step 3: Change `extractMethods` to return `{methods, hasDynamicMethods}`**

  Rewrite the function body. The walk now produces a flag in addition to the methods array. Replace the existing function (lines 86-115):

  ```js
  export function extractMethods(parser, source) {
    const tree = parser.parse(source);
    const methods = [];
    let hasDynamicMethods = false;
    const visit = (node) => {
      if (node.type === "call_expression") {
        const factory = isPageOrComponentCall(node);
        if (factory) {
          // Look at the first argument directly so we can flag non-object
          // factory args (e.g. Object.assign(...)).
          const args = fieldChild(node, "arguments");
          const firstArg = args ? args.namedChild(0) : null;
          if (firstArg && firstArg.type !== "object") {
            hasDynamicMethods = true;
          } else if (firstArg) {
            const opts = firstArg;
            if (containsSpread(opts) || dynamicMethodsViaProperty(opts)) {
              hasDynamicMethods = true;
            }
            if (factory === "Page") {
              methods.push(...methodEntriesFromObject(opts, METHOD_KIND_PAGE));
            } else {
              methods.push(...methodEntriesFromObject(opts, METHOD_KIND_COMPONENT_LIFECYCLE));
              const methodsBlock = methodsBlockOf(opts);
              if (methodsBlock) {
                if (containsSpread(methodsBlock)) {
                  hasDynamicMethods = true;
                }
                methods.push(...methodEntriesFromObject(methodsBlock, METHOD_KIND_COMPONENT_METHOD));
              }
            }
          }
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
    };
    visit(tree.rootNode);
    methods.sort((a, b) => {
      const ar = a.range.start, br = b.range.start;
      return (ar.row - br.row) || (ar.column - br.column);
    });
    return { methods, hasDynamicMethods };
  }
  ```

- [ ] **Step 4: Syntax check**

  Run: `node --check shared/js-method-extractor.mjs`
  Expected: exit 0.

- [ ] **Step 5: Update POC extractor to unpack `.methods`**

  In `scripts/poc-js-method-extractor.mjs:36`, the call is:
  ```js
  const methods = extractMethods(parser, source);
  ```
  Change to:
  ```js
  const { methods } = extractMethods(parser, source);
  ```
  This preserves the baseline file byte-identically — `files.push({ path: inputRel, methods })` on the next line is unchanged.

- [ ] **Step 6: Update graph extractor to use both fields**

  In `scripts/extract-wxml-project-graph.mjs:441`, the call is:
  ```js
  methods = extractMethods(parser, source);
  ```
  and at line 445:
  ```js
  config.script = {
    path: toPosixPath(path.relative(ROOT, jsAbs)),
    methods,
  };
  ```

  Change to:
  ```js
  let info;
  try {
    info = extractMethods(parser, source);
  } catch {
    continue;
  }
  config.script = {
    path: toPosixPath(path.relative(ROOT, jsAbs)),
    methods: info.methods,
    hasDynamicMethods: info.hasDynamicMethods,
  };
  ```

  (Replace the existing `let methods; try { methods = ... } catch { continue; } config.script = {...}` block — the variable name changes from `methods` to `info`.)

- [ ] **Step 7: Verify baselines unchanged**

  Run: `node scripts/verify-js-method-baselines.mjs`
  Expected: `[verify-js-method-baselines] 3 fixtures ... PASS` and exit 0.

  If the baseline diff shows any change: revert the POC extractor change — the only reason for a diff is that `.methods` wasn't unpacked, so the file would be `{ path, methods: { methods: [...], hasDynamicMethods: ... } }` instead of `{ path, methods: [...] }`.

- [ ] **Step 8: Commit Phase C1 (extractor only)**

  ```bash
  git add shared/js-method-extractor.mjs \
          scripts/poc-js-method-extractor.mjs \
          scripts/extract-wxml-project-graph.mjs
  git commit -m "feat: js-method-extractor flags hasDynamicMethods

  Phase 2 Stage C prep. extractMethods now returns
  {methods, hasDynamicMethods} instead of just the array. The flag is
  true when the factory options literally cannot be statically
  enumerated:
   - spread_element in options or in the methods sub-object
   - non-empty behaviors: [...] array literal
   - behaviors: <non-array-value> (identifier, call, etc.) — variable
     reference may inject methods we can't see
   - methods: <non-object-value> (identifier, Object.assign(...),
     function call) — same reasoning; the existing methodsBlockOf
     returns null and methods extraction silently produces []
   - factory first arg is not an inline object literal (e.g.
     Object.assign(...) as the whole options)

  Existing js-methods-baseline.json stays byte-identical — the POC
  extractor unpacks .methods before serialization. Graph extractor
  starts surfacing hasDynamicMethods on configs[].script."
  ```

---

### Task 2: Add programmatic verifier for hasDynamicMethods

**Files:**
- Create: `scripts/verify-js-script-info.mjs`
- Modify: `scripts/verify-tree-sitter.sh:440` (insert after the existing js-method baselines line)

The existing `verify-js-method-baselines.mjs` only exercises the `.methods` array. Add a focused verifier for the new flag against synthetic inline sources — no fixture files, faster to iterate.

- [ ] **Step 1: Create the verifier**

  Create `scripts/verify-js-script-info.mjs`:

  ```js
  #!/usr/bin/env node
  import path from "node:path";
  import { fileURLToPath } from "node:url";
  import { Parser, Language } from "web-tree-sitter";
  import { extractMethods } from "../shared/js-method-extractor.mjs";

  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const JS_WASM = path.join(ROOT, "grammar/tree-sitter-javascript/tree-sitter-javascript.wasm");

  const CASES = [
    {
      label: "plain Page",
      source: `Page({ data: {}, onLoad() {}, custom() {} });`,
      hasDynamicMethods: false,
      methodNames: ["onLoad", "custom"],
    },
    {
      label: "plain Component",
      source: `Component({ methods: { a() {}, b() {} } });`,
      hasDynamicMethods: false,
      methodNames: ["a", "b"],
    },
    {
      label: "Component with spread in options",
      source: `Component({ ...base, methods: { custom() {} } });`,
      hasDynamicMethods: true,
      methodNames: ["custom"],
    },
    {
      label: "Component with spread in methods block",
      source: `Component({ methods: { ...common, custom() {} } });`,
      hasDynamicMethods: true,
      methodNames: ["custom"],
    },
    {
      label: "Component with non-empty behaviors array literal",
      source: `Component({ behaviors: [foo, bar], methods: { custom() {} } });`,
      hasDynamicMethods: true,
      methodNames: ["custom"],
    },
    {
      label: "Component with empty behaviors array literal",
      source: `Component({ behaviors: [], methods: { custom() {} } });`,
      hasDynamicMethods: false,
      methodNames: ["custom"],
    },
    {
      label: "Component with behaviors identifier (variable reference)",
      source: `Component({ behaviors: commonBehaviors, methods: { custom() {} } });`,
      hasDynamicMethods: true,
      methodNames: ["custom"],
      // Variable reference may inject methods we can't statically see.
      // Suppress unconditionally.
    },
    {
      label: "Component with methods identifier (variable reference)",
      source: `Component({ methods: commonMethods });`,
      hasDynamicMethods: true,
      methodNames: [],
      // methodsBlockOf returns null on non-object values — methods is empty.
      // Without the flag every handler binding would falsely warn.
    },
    {
      label: "Component with methods: Object.assign(...)",
      source: `Component({ methods: Object.assign({}, common, { custom() {} }) });`,
      hasDynamicMethods: true,
      methodNames: [],
      // Same reasoning as above — the value is a call, not an object literal.
    },
    {
      label: "Component with Object.assign factory arg",
      source: `Component(Object.assign({}, base, { methods: { custom() {} } }));`,
      hasDynamicMethods: true,
      methodNames: [],
    },
    {
      label: "Page with spread in options",
      source: `Page({ ...base, onLoad() {} });`,
      hasDynamicMethods: true,
      methodNames: ["onLoad"],
    },
    {
      label: "no factory call",
      source: `const x = 1;`,
      hasDynamicMethods: false,
      methodNames: [],
    },
  ];

  function assert(condition, message) {
    if (!condition) {
      process.stderr.write(`FAIL: ${message}\n`);
      process.exit(1);
    }
  }

  async function main() {
    process.stdout.write(`[verify-js-script-info] ${CASES.length} cases ... `);
    await Parser.init();
    const lang = await Language.load(JS_WASM);
    const parser = new Parser();
    parser.setLanguage(lang);

    for (const { label, source, hasDynamicMethods, methodNames } of CASES) {
      const result = extractMethods(parser, source);
      assert(
        typeof result === "object" && result !== null && Array.isArray(result.methods),
        `${label}: bad return shape ${JSON.stringify(result)}`,
      );
      assert(
        result.hasDynamicMethods === hasDynamicMethods,
        `${label}: hasDynamicMethods expected ${hasDynamicMethods}, got ${result.hasDynamicMethods}`,
      );
      const actualNames = result.methods.map((m) => m.name).sort();
      const expectedNames = [...methodNames].sort();
      assert(
        actualNames.length === expectedNames.length && actualNames.every((n, i) => n === expectedNames[i]),
        `${label}: methods expected [${expectedNames.join(", ")}], got [${actualNames.join(", ")}]`,
      );
    }
    process.stdout.write("PASS\n");
    process.stdout.write(`\nAll ${CASES.length} script-info cases match.\n`);
  }

  main().catch((err) => {
    process.stderr.write(`FAIL: ${err?.message || err}\n`);
    process.exit(1);
  });
  ```

- [ ] **Step 2: Make it executable and run**

  Run: `chmod +x scripts/verify-js-script-info.mjs && node scripts/verify-js-script-info.mjs`
  Expected:
  ```
  [verify-js-script-info] 12 cases ... PASS

  All 12 script-info cases match.
  ```

  If any case fails, the extractor's detector logic from Task 1 has a bug. Read the failure message to identify which case, then re-check the corresponding branch in `extractMethods`. Most likely culprits:
  - `containsSpread`: wrong node type or wrong scope (options vs methods)
  - `dynamicMethodsViaProperty` on `behaviors`: missing the "non-array value → true" branch, OR the empty-array check inverted
  - `dynamicMethodsViaProperty` on `methods`: missing the "non-object value → true" branch (this is the false-positive-on-`methods: commonMethods` case)
  - Non-object first arg: factory might not be entering the `if (firstArg && firstArg.type !== "object")` branch — verify with `console.error(firstArg && firstArg.type)` temporarily

- [ ] **Step 3: Add to umbrella verifier**

  In `scripts/verify-tree-sitter.sh`, find the line:
  ```bash
  node "$ROOT_DIR/scripts/verify-js-method-baselines.mjs"
  ```

  Insert immediately after it:
  ```bash
  node "$ROOT_DIR/scripts/verify-js-script-info.mjs"
  ```

- [ ] **Step 4: Run umbrella to confirm the new line lands**

  Run: `bash scripts/verify-tree-sitter.sh 2>&1 | grep -E "verify-js-script-info|verification passed"`
  Expected:
  ```
  [verify-js-script-info] 12 cases ... PASS
  wxml-zed tree-sitter verification passed
  ```

  If the script-info line is missing, the umbrella didn't pick up the new line — re-check the insertion in `verify-tree-sitter.sh`.

- [ ] **Step 5: Commit Phase C1 verifier**

  ```bash
  git add scripts/verify-js-script-info.mjs scripts/verify-tree-sitter.sh
  git commit -m "test: programmatic coverage for hasDynamicMethods detector

  Twelve cases against synthetic JS sources covering each detector
  trigger: plain Page / plain Component (no flag); spread in options;
  spread in methods block; behaviors array literal (non-empty and
  empty); behaviors identifier reference; methods identifier
  reference; methods: Object.assign(...); Object.assign(...) as
  factory first arg; Page with spread; no factory call. In-process
  (no spawn), parses each source with web-tree-sitter and asserts
  both hasDynamicMethods and the extracted method names."
  ```

---

### Task 3: Add eventHandlerDiagnostics in language-service

**Files:**
- Modify: `server/wxml-language-service.mjs` — add helper + modify `getDiagnostics`

The new diagnostic concatenates with the existing missing-local-component diagnostics. Order doesn't semantically matter for LSP — clients sort/render however they like — but we list missing-local-component first to keep the existing test (`assertMissingCardDiagnostic` checks index 0) stable.

- [ ] **Step 1: Add `attrNameFromHandler` and `eventHandlerDiagnostics` helpers**

  Insert immediately before the existing `export function getDiagnostics` (around line 539). Note that `findOwnerConfigWithScript` is already defined nearby (Stage B's simplify pass added it).

  ```js
  function attrNameFromHandler(entry) {
    // entry.binding is e.g. "bind:" / "bind" / "capture-bind:" / "capture-bind"
    // / "catch:" / "catch" / "mut-bind:" (always colon).
    // entry.event is e.g. "tap" / "select".
    // Concatenation reconstructs the original attribute name.
    return `${entry.binding}${entry.event}`;
  }

  function eventHandlerDiagnostics(graph, documentGraphPath, fileModel) {
    const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
    // No sibling .js script: don't warn. Page/Component WXML can legitimately
    // ship without a .js companion in some edge cases (e.g. partial source
    // imports). Diagnostics here would be noisy false positives.
    if (!ownerConfig) return [];
    if (ownerConfig.script.hasDynamicMethods) return [];

    const methodNames = new Set(
      ownerConfig.script.methods
        .map((m) => m.name)
        .filter((name) => typeof name === "string" && name.length > 0),
    );

    const handlers = fileModel.eventHandlers ?? [];
    const out = [];
    for (const entry of handlers) {
      if (entry.dynamic) continue;
      // Filter out the false-positive class that the data model's loose
      // matcher accepts: `binding="foo"`, `bindable="foo"`, etc. The strict
      // gate is the same one completion uses.
      if (!isEventHandlerCompletionTrigger(attrNameFromHandler(entry))) continue;
      if (typeof entry.handler !== "string" || entry.handler.length === 0) continue;
      if (methodNames.has(entry.handler)) continue;
      out.push({
        range: rangeFromSymbolRange(entry.nameRange),
        severity: WARNING,
        source: "wxml-zed",
        code: "missing-event-handler",
        message: `Event handler "${entry.handler}" is not defined in the page/component script.`,
      });
    }
    return out;
  }
  ```

  Notes:
  - `rangeFromSymbolRange` already exists in this file (used by the missing-local-component branch).
  - `WARNING = 2` is already defined at line 7.
  - `isEventHandlerCompletionTrigger` is already imported (Stage B).

- [ ] **Step 2: Modify `getDiagnostics` to concat the new branch**

  Current shape (lines 539-563): early-return on missing fileModel, then return missing-local-component diagnostics directly. Change to compute both and concat:

  ```js
  export function getDiagnostics({ graph, documentPath, extensionRoot }) {
    const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
    if (!fileModel) {
      return [];
    }

    const usedComponents = new Map(fileModel.components.map((component) => [component.tag, component]));
    const componentDiags = graph.unresolved
      .filter((entry) => (
        entry.kind === "component" &&
        entry.owner === documentGraphPath &&
        entry.reason === "missing-file" &&
        usedComponents.has(entry.tag)
      ))
      .map((entry) => {
        const component = usedComponents.get(entry.tag);
        return {
          range: rangeFromSymbolRange(component.range),
          severity: WARNING,
          source: "wxml-zed",
          code: "missing-local-component",
          message: `Missing local component "${entry.tag}": ${entry.value}`,
        };
      });

    const handlerDiags = eventHandlerDiagnostics(graph, documentGraphPath, fileModel);
    return [...componentDiags, ...handlerDiags];
  }
  ```

- [ ] **Step 3: Syntax check**

  Run: `node --check server/wxml-language-service.mjs`
  Expected: exit 0.

- [ ] **Step 4: Verify existing diagnostic tests still pass**

  Run: `node scripts/verify-wxml-language-service.mjs 2>&1 | tail -3`
  Expected: exits 0; no thrown assertion. Critical: `assertMissingCardDiagnostic` still expects `length === 1`, so home.wxml's `bind:select="handleSelect"` must NOT produce a new event-handler warning (handleSelect exists in `home.js`).

  If `assertMissingCardDiagnostic` now fails with `length === 2`: the diagnostic emitted a false positive. Inspect — most likely either:
  - The strict gate rejected `bind:select` (it should accept: `bind:` is a colon form with a non-empty event name). Check the regex.
  - The lookup failed to find `handleSelect` in `script.methods` (unlikely; existing Stage A tests would also fail).

- [ ] **Step 5: No commit yet** — Task 4 adds the new assertions. Commit together with them so the history clearly shows feature + tests landing as a unit.

---

### Task 4: Add language-service assertions

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`

Add seven assertions covering the positive-clean path, both strict-gate positive-emission branches (colon and no-colon shorthand), and four suppression paths. All use in-memory graph mutation following the Stage A `assertEventHandlerDefinitionMissingMethod` precedent (line 173 of this file).

- [ ] **Step 1: Add the positive (clean) assertion**

  Insert after the existing `assertShopListDiagnosticsClean` (around line 117 of `verify-wxml-language-service.mjs`):

  ```js
  function assertEventHandlerDiagnosticCleanWhenHandlerExists(graph) {
    // home.wxml's `bind:select="handleSelect"` resolves to handleSelect in
    // home.js. No new warning should be emitted. (The existing
    // assertMissingCardDiagnostic checks length === 1 — this assertion
    // double-locks by explicitly asserting no missing-event-handler code.)
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
    assert(
      handlerDiags.length === 0,
      `event handler diagnostic (clean): unexpected handler warnings ${JSON.stringify(handlerDiags)}`,
    );
  }
  ```

- [ ] **Step 2: Add the warning-emission assertion**

  ```js
  function assertEventHandlerDiagnosticMissingHandler(graph) {
    // Mutate: drop handleSelect from home.js methods. The WXML still has
    // `bind:select="handleSelect"`. Diagnostic must emit.
    const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
    assert(homeConfig && homeConfig.script, "test setup: home config must have script");
    const originalMethods = homeConfig.script.methods;
    homeConfig.script.methods = originalMethods.filter((m) => m.name !== "handleSelect");
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
      assert(handlerDiags.length === 1, `expected 1 handler diagnostic, got ${handlerDiags.length}: ${JSON.stringify(handlerDiags)}`);
      const d = handlerDiags[0];
      assert(d.severity === 2, `severity: ${d.severity}`);
      assert(d.source === "wxml-zed", `source: ${d.source}`);
      assert(
        d.message === 'Event handler "handleSelect" is not defined in the page/component script.',
        `message: ${d.message}`,
      );
      // home.wxml line 12 `    bind:select="handleSelect"` — handler at cols 17..29 (exclusive).
      // nameRange is the inner value range (innerValueRange shrinks by one column each side
      // around the quotes), so the diagnostic should point at handleSelect itself.
      assertDeepEqual(
        d.range,
        { start: { line: 11, character: 17 }, end: { line: 11, character: 29 } },
        "handler diagnostic range",
      );
    } finally {
      homeConfig.script.methods = originalMethods;
    }
  }
  ```

- [ ] **Step 2b: Add the no-colon short-form positive emission assertion**

  The fixture-driven `assertEventHandlerDiagnosticMissingHandler` (Step 2) exercises only the **colon form** (`bind:select` → `attrNameFromHandler` produces `"bind:select"`, strict gate accepts via the colon branch). The no-colon shorthand (`bindtap` → `attrNameFromHandler` produces `"bindtap"`, strict gate accepts via the BUILTIN_EVENT_NAMES branch) is structurally different and needs its own positive lock — otherwise regressions in either `attrNameFromHandler` or the no-colon strict-gate branch would silently slip through.

  Inject a synthetic non-dynamic handler whose `binding` is no-colon and `event` is in the built-in whitelist, with a deliberately-missing handler name:

  ```js
  function assertEventHandlerDiagnosticMissingHandlerNoColon(graph) {
    const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
    assert(homeFile && Array.isArray(homeFile.eventHandlers), "test setup: home file must have eventHandlers");
    const synthetic = {
      event: "tap",
      handler: "__missing_tap__",
      binding: "bind",           // no colon — exercises the no-colon strict-gate branch
      dynamic: false,
      range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
      nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    };
    homeFile.eventHandlers.push(synthetic);
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
      const ours = handlerDiags.find((d) => d.message.includes("__missing_tap__"));
      assert(
        ours,
        `event handler diagnostic (no-colon short form): expected emission for __missing_tap__; got ${JSON.stringify(handlerDiags)}`,
      );
      assert(ours.severity === 2, `severity: ${ours.severity}`);
      assert(ours.source === "wxml-zed", `source: ${ours.source}`);
    } finally {
      const idx = homeFile.eventHandlers.indexOf(synthetic);
      if (idx >= 0) homeFile.eventHandlers.splice(idx, 1);
    }
  }
  ```

- [ ] **Step 3: Add the dynamic-handler suppression assertion**

  ```js
  function assertEventHandlerDiagnosticSuppressedByDynamic(graph) {
    // Inject a synthetic dynamic eventHandler entry pointing at a missing
    // method. The dynamic flag must suppress the diagnostic.
    const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
    assert(homeFile && Array.isArray(homeFile.eventHandlers), "test setup: home file must have eventHandlers");
    const synthetic = {
      event: "tap",
      handler: "__missing_dynamic__",
      binding: "bind:",
      dynamic: true,
      range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
      nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    };
    homeFile.eventHandlers.push(synthetic);
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
      assert(
        handlerDiags.every((d) => !d.message.includes("__missing_dynamic__")),
        `event handler diagnostic (dynamic suppress): leaked diagnostic ${JSON.stringify(handlerDiags)}`,
      );
    } finally {
      const idx = homeFile.eventHandlers.indexOf(synthetic);
      if (idx >= 0) homeFile.eventHandlers.splice(idx, 1);
    }
  }
  ```

  Note: the fileModel is loaded from `graph.wxml` via `findWxmlFileModel`. Mutating `graph.wxml[i].eventHandlers` directly mutates what the function will read. Verify the field name with `grep "wxml.find\|graph.wxml" server/wxml-language-service.mjs` if needed; it's the standard graph schema.

- [ ] **Step 4: Add the hasDynamicMethods suppression assertion**

  ```js
  function assertEventHandlerDiagnosticSuppressedByDynamicMethods(graph) {
    const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
    assert(homeConfig && homeConfig.script, "test setup: home config must have script");
    // Mutate methods AND set the flag, so the assertion would otherwise warn.
    const originalMethods = homeConfig.script.methods;
    const originalFlag = homeConfig.script.hasDynamicMethods;
    homeConfig.script.methods = originalMethods.filter((m) => m.name !== "handleSelect");
    homeConfig.script.hasDynamicMethods = true;
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
      assert(
        handlerDiags.length === 0,
        `event handler diagnostic (hasDynamicMethods): expected suppression, got ${JSON.stringify(handlerDiags)}`,
      );
    } finally {
      homeConfig.script.methods = originalMethods;
      homeConfig.script.hasDynamicMethods = originalFlag;
    }
  }
  ```

- [ ] **Step 5: Add the strict-gate suppression assertion**

  ```js
  function assertEventHandlerDiagnosticSuppressedByLooseBinding(graph) {
    // Inject a synthetic eventHandler with a binding+event that matches the
    // loose data-model regex but NOT the strict completion-trigger gate.
    // Reconstructed attrName: "bind" + "ing" = "binding". The strict gate
    // rejects "binding" (suffix "ing" not in BUILTIN_EVENT_NAMES, no colon).
    // Diagnostic must not fire even though no `__missing_loose__` method exists.
    const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
    assert(homeFile && Array.isArray(homeFile.eventHandlers), "test setup: home file must have eventHandlers");
    const synthetic = {
      event: "ing",
      handler: "__missing_loose__",
      binding: "bind",
      dynamic: false,
      range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
      nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    };
    homeFile.eventHandlers.push(synthetic);
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
      assert(
        handlerDiags.every((d) => !d.message.includes("__missing_loose__")),
        `event handler diagnostic (loose binding suppress): leaked diagnostic ${JSON.stringify(handlerDiags)}`,
      );
    } finally {
      const idx = homeFile.eventHandlers.indexOf(synthetic);
      if (idx >= 0) homeFile.eventHandlers.splice(idx, 1);
    }
  }
  ```

- [ ] **Step 6: Add the no-script suppression assertion**

  ```js
  function assertEventHandlerDiagnosticNoScriptSkips(graph) {
    const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
    assert(homeConfig && homeConfig.script, "test setup: home config must have script");
    const savedScript = homeConfig.script;
    delete homeConfig.script;
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
      assert(
        handlerDiags.length === 0,
        `event handler diagnostic (no script): expected suppression, got ${JSON.stringify(handlerDiags)}`,
      );
    } finally {
      homeConfig.script = savedScript;
    }
  }
  ```

- [ ] **Step 7: Register all seven in the runner**

  Find the existing diagnostic assertion calls (around line 1108-1109):
  ```js
  assertMissingCardDiagnostic(graph);
  assertShopListDiagnosticsClean(graph);
  ```

  Add immediately after:
  ```js
  // Phase 2 Stage C — Event handler diagnostic
  assertEventHandlerDiagnosticCleanWhenHandlerExists(graph);
  assertEventHandlerDiagnosticMissingHandler(graph);
  assertEventHandlerDiagnosticMissingHandlerNoColon(graph);
  assertEventHandlerDiagnosticSuppressedByDynamic(graph);
  assertEventHandlerDiagnosticSuppressedByDynamicMethods(graph);
  assertEventHandlerDiagnosticSuppressedByLooseBinding(graph);
  assertEventHandlerDiagnosticNoScriptSkips(graph);
  ```

- [ ] **Step 8: Run the test**

  Run: `node scripts/verify-wxml-language-service.mjs`
  Expected: exit 0, no thrown assertion. Total assertions in the file grow by 7 (one positive-clean, two positive-emission, four suppression).

  If any fails, the message identifies which case. Common failure causes:
  - "leaked diagnostic" on dynamic-suppress: `entry.dynamic` is being checked but the loose-binding suppression got there first (the synthetic entry has `binding: "bind:", event: "tap"`, strict-gate passes; ensure the `if (entry.dynamic) continue` is BEFORE the strict-gate check).
  - "expected 1 handler diagnostic" on missing-handler: the strict gate is rejecting `bind:select` — re-check the regex in `isEventHandlerCompletionTrigger`.
  - "bad range": innerValueRange shrinks by one column each side of quotes; the diagnostic should land on the handler text proper. If you get an off-by-one or the full attribute range, `rangeFromSymbolRange` is being called on the wrong field.

- [ ] **Step 9: Run umbrella to confirm no other regressions**

  Run: `bash scripts/verify-tree-sitter.sh 2>&1 | tail -3`
  Expected: ends with `wxml-zed tree-sitter verification passed`, exit 0. Takes 2-3 minutes due to wasm rebuild.

- [ ] **Step 10: Commit Phase C2 (feature + tests together)**

  ```bash
  git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
  git commit -m "feat: lsp diagnostic for missing wxml event handlers

  Phase 2 Stage C of Event Handler Intelligence v1. Closes the trio:
  Definition (A) + Completion (B) + Diagnostic (C). Warning-level
  diagnostic emitted on the handler name when bind:tap=\"onTap\" refers
  to a method that does not exist in the sibling .js page/component
  factory.

  Disciplined suppression — false-positives are louder than misses:
   - handler is dynamic ({{...}}) -> skip
   - owner has no sibling script -> skip
   - script.hasDynamicMethods -> skip; the flag triggers on options/
     methods-block spread, behaviors as array literal (non-empty) or
     any non-array value, methods as any non-object value (identifier,
     Object.assign(), function call), and non-object factory first arg
   - attr name fails the strict event-binding gate (binding=, etc) -> skip
   - any method name match (lifecycle counted) -> skip

  Seven new assertions cover the positive-clean path, both strict-gate
  emission branches (colon + no-colon shorthand), and the four
  suppression paths via in-memory graph mutation
  (matching Stage A's assertEventHandlerDefinitionMissingMethod
  precedent — no new fixtures, no protocol-layer test needed since
  diagnostics share one publishDiagnostics channel already exercised
  by the existing missing-local-component case)."
  ```

---

### Task 5: Notes + plan sync

**Files:**
- Modify: `docs/wasm-parser-spike-notes.md` — append Stage C section before the trailing regression-anchor block
- Modify: this plan doc if any inline correction was made during execution (per `feedback_sync_plan_after_inline_fixes.md` memory)

- [ ] **Step 1: Draft the notes section**

  Insert after the Stage B section and before the `**Regression anchor for parse-error case:**` block. Cover:
  - Closing the Phase 2 trio.
  - Two-phase architecture: extractor extension (signal) + language-service consumer (diagnostic).
  - The four suppression mechanisms and the rationale for each. Emphasize the asymmetry: diagnostic accepts lifecycle name matches (completion did NOT for UX); diagnostic uses strict gate (completion did too, for the same reason).
  - **`hasDynamicMethods` triggers expanded after review feedback**: original draft only covered options/methods-block spread + non-empty `behaviors: [...]` array + non-object factory arg. Review caught two real-world false-positive surfaces and they were added: (a) `methods: variableReference` and `methods: Object.assign(...)` — the existing `methodsBlockOf` returns null on non-object values, so without flagging this case every bound handler false-warns; (b) `behaviors: variableReference` — variable could inject methods, original logic only matched array literals. The detector now uses one combined `dynamicMethodsViaProperty(opts)` walk that covers both properties in a single pass.
  - `hasDynamicMethods` design: returned as part of `extractMethods` result rather than a separate function — the detector walks the same options object the methods walker is already on, so combining them is cheaper.
  - Test infra reuse: existing `assertEventHandlerDefinitionMissingMethod` (Stage A) established the graph-mutation pattern; all seven Stage C assertions follow it.
  - No new LSP protocol test: the rationale (diagnostics share one channel, the existing missing-local-component protocol test exercises the routing).
  - Phase 2 complete. Phase 3 candidates: cross-file behaviors resolution; quick-fix code action (create stub method); diagnostic on `wx:if`/`wx:for` expressions that reference unknown identifiers.

- [ ] **Step 2: Sync this plan doc if anything diverged during execution**

  Re-read the plan doc and ensure the code blocks in Task 1–4 match what was actually shipped. If the implementation differs (different node-type names, different helper signatures, different test ranges), update the plan inline so future readers see truth. This step is the explicit hand-off for the `feedback_sync_plan_after_inline_fixes.md` discipline.

- [ ] **Step 3: Commit**

  ```bash
  git add docs/wasm-parser-spike-notes.md docs/superpowers/plans/2026-05-18-event-handler-diagnostic.md
  git commit -m "docs: record Phase 2 Stage C outcome in spike notes

  Append Stage C section covering: two-phase architecture (extractor
  signal + language-service diagnostic); four suppression mechanisms
  and the rationale for each (especially the asymmetry vs. Stage B
  completion's lifecycle filter); test infra reuse via graph mutation;
  rationale for skipping a new LSP protocol test. Phase 2 trio
  complete."
  ```

---

## Sequencing Notes

- Tasks 1 & 2 form Phase C1 (extractor side). Two commits: extractor + POC/graph updates, then the new verifier. Splitting these means the verifier commit can stand alone if the extractor commit needs a rebase/revert.
- Tasks 3 & 4 form Phase C2 (language-service side). One commit each step had been considered, but the feature is small enough that feature+tests landing together is more atomic for bisecting.
- Task 5 closes with notes + plan sync per the saved feedback discipline.

## Self-Review Checklist (run before handing off)

- [ ] All `Files:` paths resolve to real locations in the current tree.
- [ ] Every step that changes code shows the actual code (no "..." or "similar to").
- [ ] Every step that runs a command shows the exact command and expected output.
- [ ] No "TBD" / "appropriate" / "similar to" placeholders.
- [ ] Type names consistent across tasks: `extractMethods` (new return `{methods, hasDynamicMethods}`), `eventHandlerDiagnostics`, `attrNameFromHandler`, `findOwnerConfigWithScript` (reused from Stage B), `isEventHandlerCompletionTrigger` (reused), `containsSpread`, `dynamicMethodsViaProperty`.
- [ ] All seven assertion names match the registration list at Step 7.
- [ ] Both strict-gate branches are positively locked: colon form via `assertEventHandlerDiagnosticMissingHandler` (fixture-driven, `bind:select`); no-colon short form via `assertEventHandlerDiagnosticMissingHandlerNoColon` (synthetic, `bindtap`).
- [ ] All four `hasDynamicMethods` triggers are positively locked in `verify-js-script-info.mjs`: options-spread, methods-block-spread, behaviors (array literal & identifier), methods (non-object value), Object.assign factory arg.
- [ ] The diagnostic `code` field is consistently `"missing-event-handler"` in both Task 3's emit and Task 4's filter.
- [ ] `range` field of the diagnostic uses `rangeFromSymbolRange(entry.nameRange)` (LSP `{line, character}` shape, not the raw `{row, column}` shape).
- [ ] home.wxml line 12 column offsets in `assertEventHandlerDiagnosticMissingHandler` (17, 29) verified against the actual fixture line.
