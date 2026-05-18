# Event Handler Data Model — Stage C Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the JS method extraction (Stage B POC) and a new WXML event-handler extraction layer into the production project graph, producing a single data model where each `.wxml` file's owner (page or component) carries both its bound event handler usages and its sibling `.js` file's available methods. **Stage C ends with a complete data model in `extract-wxml-project-graph.mjs`'s output; no LSP feature work happens here** — definition, completion, and diagnostic are Phase 2+.

**Architecture:** Three logically distinct sub-stages, one commit each.

1. **C1 — JS extractor productionization:** Lift the Stage B POC's extraction logic into a shared module (`shared/js-method-extractor.mjs`) so both the POC script and the graph extractor can use it without forking a child process. Add `nameRange` on every emitted method (LSP definition will eventually jump there). Add a broken-JS fixture that exercises `hasError === true` recovery and lock the partial-extraction outcome in the JS method baseline.
2. **C2 — WXML schema bump for event handlers:** Extend `scripts/extract-wxml-symbols.mjs` with an `eventHandlers[]` array per file. Detect all WXML event binding forms (`bindXXX`, `bind:XXX`, `catchXXX`, `catch:XXX`, `mut-bind:XXX`, `capture-bind*`, `capture-catch*`). Emit `{event, handler, binding, dynamic, range, nameRange}`. Regenerate all 6 committed wasm symbol baselines (home, miniprogram, test, real-world, edge-recovery, non-ascii) with the new field.
3. **C3 — Graph integration:** Modify `scripts/extract-wxml-project-graph.mjs` to read each non-app config's sibling `.js` file and attach the extracted methods to `configs[].script`. Add 7 `.js` fixtures to `fixtures/miniprogram/` (one per page/component) so the integration has real shapes to walk. Add assertions in `scripts/verify-wxml-language-service.mjs` to lock the new graph behavior.

**Out of scope for Stage C (explicit):**

- LSP `textDocument/definition` / `completion` / diagnostic for event handlers — these are Phase 2+, gated on this data model existing.
- Adding a frozen graph baseline + dedicated graph verifier. Currently only the language-service test covers graph behavior; adding a graph baseline is a separate follow-up task (would be useful but is scope creep here).
- Cross-file/cross-symbol resolution: behaviors, spread, `Object.assign`, imported helpers, prototype assignment — all stay in the "v2 candidates" list documented in Stage B's notes.
- TS/TSX support — JS only.
- Dynamic handler resolution (`bindtap="{{dynamicName}}"`): we extract `dynamic: true` flag but no expression evaluation.

**Tech Stack:** Same as Stage B — `web-tree-sitter@0.25.10`, both WXML and JS wasms, Node ESM. No new dependencies.

**Plan-sync discipline:** Per `memory/feedback_sync_plan_after_inline_fixes.md`, every commit's File Structure and Task list MUST exhaustively name modified files. If execution surfaces a needed change not in the plan, update the plan BEFORE the commit (or in a sibling commit), never leave drift.

---

## File Structure

**Commit C1 (JS productionization):**

- Create: `shared/js-method-extractor.mjs` — pure function `extractMethods(parser, source)` that returns `[{name, kind, range, nameRange}]`. Reuses the Stage B POC walk logic, adds `nameRange` (the `property_identifier` range, not the whole `method_definition`/`pair`).
- Modify: `scripts/poc-js-method-extractor.mjs` — replace inline extraction with import from `shared/js-method-extractor.mjs`. CLI surface unchanged. Output JSON gains `nameRange` per method.
- Create: `fixtures/wasm-spike/broken-page.js` — Page literal with intentional syntax break (e.g. unclosed paren in one method body) such that `hasError === true` but at least one method is still recoverable.
- Modify: `fixtures/wasm-spike/js-methods-baseline.json` — regenerated with `nameRange` field on every method + new entry for `broken-page.js`.
- Modify: `scripts/verify-js-method-baselines.mjs` — add `broken-page.js` to the fixture list.

**Commit C2 (WXML eventHandlers):**

- Modify: `scripts/extract-wxml-symbols.mjs` — add element walk for event-binding attributes; emit `eventHandlers[]` per file.
- Modify: `fixtures/wasm-spike/home-symbols-baseline.json` — regen with `eventHandlers[]`.
- Modify: `fixtures/wasm-spike/miniprogram-symbols-baseline.json` — regen.
- Modify: `fixtures/wasm-spike/test-wxml-symbols-baseline.json` — regen.
- Modify: `fixtures/wasm-spike/real-world-symbols-baseline.json` — regen.
- Modify: `fixtures/wasm-spike/edge-recovery-symbols-baseline.json` — regen (expected: `eventHandlers: []` because parse-error fragment has none extractable).
- Modify: `fixtures/wasm-spike/non-ascii-symbols-baseline.json` — regen.

**Commit C3 (Graph integration + miniprogram .js fixtures):**

- Create: `fixtures/miniprogram/pages/home/home.js` — Page with method matching home.wxml's `bind:select="handleSelect"` plus a few siblings
- Create: `fixtures/miniprogram/pages/detail/detail.js` — minimal Page
- Create: `fixtures/miniprogram/packages/shop/pages/list/list.js` — minimal Page
- Create: `fixtures/miniprogram/components/user-card/user-card.js` — Component with `methods` block including `select` (matches a handler home.wxml binds via the user-card component)
- Create: `fixtures/miniprogram/components/local-badge/local-badge.js` — minimal Component
- Create: `fixtures/miniprogram/components/status-badge/status-badge.js` — minimal Component
- Create: `fixtures/miniprogram/components/global-badge/global-badge.js` — minimal Component
- Modify: `scripts/extract-wxml-project-graph.mjs` — import `extractMethods`; for each non-app config, resolve sibling `.js`; on success attach `configs[i].script = {path, methods}`; on missing/failed parse, omit field (do not error).
- Modify: `scripts/verify-wxml-language-service.mjs` — add assertions verifying graph emits `configs[].script` correctly, including the `home` page's `handleSelect` being reachable.

---

## Sub-stage C1: JS Extractor Productionization

### Task C1.1: Extract Shared Module

**Files:**
- Create: `shared/js-method-extractor.mjs`

- [ ] Create `shared/js-method-extractor.mjs` exporting a single named function `extractMethods(parser, source) -> [{name, kind, range, nameRange}]`. Pure: takes the already-initialized parser and source string, returns array. No fs / no Parser.init (callers do those).

  The body is the Stage B POC's walk logic with one addition: `nameRange` field. For both `method_definition` and `pair` paths, `nameRange = rangeOf(propertyIdentifierNode)`. Existing `range` stays as the whole node range.

  ```js
  import { rangeOf, firstChildOfType, fieldChild } from "./wasm-tree-helpers.mjs";
  ```

  Wait — those helpers don't exist yet. Either:
  - **(a)** Define `rangeOf`, `firstChildOfType`, `fieldChild`, `FUNCTION_VALUE_TYPES`, `FACTORY_NAMES` inline in this module
  - **(b)** Also create `shared/wasm-tree-helpers.mjs` for shared utilities

  Choose **(a)** — these helpers are small and duplicating them is cheaper than the indirection cost for one extra consumer (the POC). Refactor later if a third caller appears.

  Full file content (write this exactly, do not reference external helpers):

  ```js
  import { performance } from "node:perf_hooks";

  const FUNCTION_VALUE_TYPES = new Set(["function_expression", "arrow_function"]);
  const FACTORY_NAMES = new Set(["Page", "Component"]);

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

  function fieldChild(node, fieldName) {
    return node.childForFieldName ? node.childForFieldName(fieldName) : null;
  }

  function isPageOrComponentCall(callNode) {
    const fn = fieldChild(callNode, "function");
    if (!fn || fn.type !== "identifier") return null;
    if (!FACTORY_NAMES.has(fn.text)) return null;
    return fn.text;
  }

  function optionsObject(callNode) {
    const args = fieldChild(callNode, "arguments");
    if (!args) return null;
    const first = args.namedChild(0);
    if (!first || first.type !== "object") return null;
    return first;
  }

  function methodEntriesFromObject(objectNode, kind) {
    const out = [];
    for (let i = 0; i < objectNode.namedChildCount; i++) {
      const child = objectNode.namedChild(i);
      if (child.type === "method_definition") {
        const nameNode = firstChildOfType(child, "property_identifier");
        if (!nameNode) continue;
        out.push({
          name: nameNode.text,
          kind,
          range: rangeOf(child),
          nameRange: rangeOf(nameNode),
        });
      } else if (child.type === "pair") {
        const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
        if (!keyNode || keyNode.type !== "property_identifier") continue;
        const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
        if (!valueNode || !FUNCTION_VALUE_TYPES.has(valueNode.type)) continue;
        out.push({
          name: keyNode.text,
          kind,
          range: rangeOf(child),
          nameRange: rangeOf(keyNode),
        });
      }
    }
    return out;
  }

  function methodsBlockOf(objectNode) {
    for (let i = 0; i < objectNode.namedChildCount; i++) {
      const child = objectNode.namedChild(i);
      if (child.type !== "pair") continue;
      const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
      if (!keyNode || keyNode.type !== "property_identifier" || keyNode.text !== "methods") continue;
      const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
      if (valueNode && valueNode.type === "object") return valueNode;
    }
    return null;
  }

  export function extractMethods(parser, source) {
    const tree = parser.parse(source);
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
  ```

- [ ] Verify: `node --check shared/js-method-extractor.mjs` → exit 0.

### Task C1.2: Refactor POC to use shared module

**Files:**
- Modify: `scripts/poc-js-method-extractor.mjs`

- [ ] Replace inline extraction logic with `import { extractMethods } from "../shared/js-method-extractor.mjs"`. Delete the now-duplicate helpers (`rangeOf`, `firstChildOfType`, `fieldChild`, `isPageOrComponentCall`, `optionsObject`, `methodEntriesFromObject`, `methodsBlockOf`, `collectFile`, `FUNCTION_VALUE_TYPES`, `FACTORY_NAMES`). Keep `toPosix`, `relativePathFromRoot`, `main`.

  The new `main` body simplifies to:

  ```js
  // ... imports, ROOT, WASM, toPosix, relativePathFromRoot unchanged ...

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
      const methods = extractMethods(parser, source);
      files.push({ path: inputRel, methods });
    }

    files.sort((a, b) => a.path.localeCompare(b.path));

    process.stdout.write(`${JSON.stringify({ version: 1, files }, null, 2)}\n`);
  }
  ```

- [ ] Verify: `node --check scripts/poc-js-method-extractor.mjs` → exit 0.

### Task C1.3: Create broken-page.js fixture

**Files:**
- Create: `fixtures/wasm-spike/broken-page.js`

- [ ] Create a JS source that:
  - Has a clear syntax error somewhere (e.g. an unclosed parenthesis in one method body)
  - But has at least one cleanly-defined method elsewhere that recovery should still capture
  - Use ASCII only, keep it small

  Suggested content:

  ```js
  // Intentionally broken Page for hasError recovery regression test.
  // The `onShow` method body has an unclosed paren; tree-sitter should
  // mark the root ERROR but still recover `onLoad` and `onReady`.

  Page({
    onLoad() {
      this.ready = true;
    },
    onShow() {
      if (this.foo {
    },
    onReady() {
      // intentionally clean — recovery should reach this
    },
  });
  ```

  Note: the exact methods recovered may vary by grammar version. Task C1.5 will run the POC and observe what's actually extracted; if it's only `onLoad`, that's still proof of recovery (since the alternative is "abort with empty model"). The baseline locks whatever the current outcome is.

### Task C1.4: Add broken-page.js to verifier and regen baseline

**Files:**
- Modify: `scripts/verify-js-method-baselines.mjs`
- Modify: `fixtures/wasm-spike/js-methods-baseline.json`

- [ ] In `verify-js-method-baselines.mjs`, append `"fixtures/wasm-spike/broken-page.js"` to the `FIXTURES` array.

- [ ] Regen the baseline with all 3 fixtures (including the new broken-page and the existing two with `nameRange` now present from C1.2):

  ```bash
  node scripts/poc-js-method-extractor.mjs \
    fixtures/wasm-spike/sample-page.js \
    fixtures/wasm-spike/sample-component.js \
    fixtures/wasm-spike/broken-page.js > fixtures/wasm-spike/js-methods-baseline.json
  ```

- [ ] Open the regenerated baseline and verify visually:
  - Every method entry has a `nameRange` field
  - `broken-page.js` entry has `methods: [...]` with at least one recovered method (or `methods: []` with documentation in the notes — both are valid "didn't abort" outcomes)
  - Existing `sample-page.js` and `sample-component.js` entries have the same counts as before (4 page-method, 2 component-lifecycle + 3 component-method)

### Task C1.5: Run umbrella + commit C1

**Files:** none (verification only); commit step

- [ ] Run `node scripts/verify-js-method-baselines.mjs` standalone — must PASS.
- [ ] Run `bash scripts/verify-tree-sitter.sh 2>&1 | tail -15` — full umbrella must end with `wxml-zed tree-sitter verification passed`.
- [ ] Inspect:
  ```bash
  git status
  ```
  Expected:
  - `?? shared/js-method-extractor.mjs`
  - `?? fixtures/wasm-spike/broken-page.js`
  - `M scripts/poc-js-method-extractor.mjs`
  - `M scripts/verify-js-method-baselines.mjs`
  - `M fixtures/wasm-spike/js-methods-baseline.json`
  - `?? docs/superpowers/plans/2026-05-17-event-handler-data-model-stage-c.md`

- [ ] Stage:
  ```bash
  git add shared/js-method-extractor.mjs \
          fixtures/wasm-spike/broken-page.js \
          scripts/poc-js-method-extractor.mjs \
          scripts/verify-js-method-baselines.mjs \
          fixtures/wasm-spike/js-methods-baseline.json \
          docs/superpowers/plans/2026-05-17-event-handler-data-model-stage-c.md
  ```
- [ ] Commit (commit C1):
  ```bash
  git commit -m "$(cat <<'EOF'
  spike: lift js method extraction to shared module + nameRange + broken-js fixture

  Stage C step 1 of Event Handler Intelligence v1 Phase 1.

  - Extracted Stage B POC's walk logic into shared/js-method-extractor.mjs
    so the upcoming graph integration (C3) can call it in-process. POC
    script becomes a thin wrapper around the shared module.
  - Every emitted method gains a nameRange field (the property_identifier
    range) in addition to range (the whole method_definition/pair). LSP
    definition layers eventually jump to nameRange.
  - Added fixtures/wasm-spike/broken-page.js with intentional syntax
    error; locks in the hasError-tolerance behavior Stage A's design
    constraint required but no fixture had exercised. Baseline updated
    accordingly.

  No graph or WXML extractor code touched yet. C2 (WXML eventHandlers
  schema bump) is unblocked next.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Sub-stage C2: WXML Event Handler Extraction

### Task C2.1: Add eventHandlers walk to WXML extractor

**Files:**
- Modify: `scripts/extract-wxml-symbols.mjs`

WXML event-binding attribute forms to detect, per WeChat docs:

| Form | Example | binding | event |
|---|---|---|---|
| `bindXXX` | `bindtap` | `bind` | `tap` |
| `bind:XXX` | `bind:tap` | `bind:` | `tap` |
| `catchXXX` | `catchtap` | `catch` | `tap` |
| `catch:XXX` | `catch:tap` | `catch:` | `tap` |
| `mut-bind:XXX` | `mut-bind:tap` | `mut-bind:` | `tap` |
| `capture-bindXXX` | `capture-bindtap` | `capture-bind` | `tap` |
| `capture-bind:XXX` | `capture-bind:tap` | `capture-bind:` | `tap` |
| `capture-catchXXX` | `capture-catchtap` | `capture-catch` | `tap` |
| `capture-catch:XXX` | `capture-catch:tap` | `capture-catch:` | `tap` |

The non-colon forms have to be matched against a recognized event suffix (e.g. `tap`, `touchstart`, `touchmove`, `touchend`, `touchcancel`, `change`, `input`, `submit`, `focus`, `blur`, `load`, `error`, `confirm`, `scroll`, `scrolltolower`, `scrolltoupper`, `longtap`, `longpress`, `transitionend`, `animationstart`, `animationiteration`, `animationend`, `swipe`). Keep this list short and add a "fallback: if attribute name starts with `bind`/`catch`/`capture-bind`/`capture-catch` and doesn't match a colon-form, treat everything after the prefix as the event name." This avoids hardcoding every WeChat event.

**Detection algorithm:** for each `attribute_name` text under an element's start_tag / self_closing_tag, match in order:

1. If matches `^(capture-(?:bind|catch)):(.+)$` → binding=capture-bind:/capture-catch:, event=group 2
2. Else if matches `^(capture-(?:bind|catch))(.+)$` → binding=capture-bind/capture-catch, event=group 2
3. Else if matches `^mut-bind:(.+)$` → binding=mut-bind:, event=group 1
4. Else if matches `^(bind|catch):(.+)$` → binding=bind:/catch:, event=group 2
5. Else if matches `^(bind|catch)(.+)$` → binding=bind/catch, event=group 2
6. Else → not an event handler, skip

Order matters: capture-* must be tested before plain bind/catch to avoid `capture-bindtap` matching as `bind` with event `capture-bindtap` (broken).

For each match emit:
```js
{
  event: <matched event name>,
  handler: <attribute value, unquoted>,
  binding: <prefix from match>,
  dynamic: handler.includes("{{"),
  range: rangeOf(attributeNode),    // whole `bindtap="onTap"`
  nameRange: <range inside the quotes, pointing to just `onTap`>,
}
```

For `nameRange`: the WXML grammar's `quoted_attribute_value` wraps the value including quote chars. The actual handler text sits between the quote chars. To compute `nameRange`:
- Get the `quoted_attribute_value` node's range
- Shrink start.column by +1 (past opening quote) and end.column by -1 (past closing quote)
- This assumes single-line attribute values (which WXML attributes almost always are). For multi-line attribute values, use the raw text length on each row — but defer that complexity until a fixture forces it.

**Implementation steps:**

- [ ] Add to `extract-wxml-symbols.mjs` (near existing pushDependency / pushSymbol):

  ```js
  const EVENT_PATTERNS = [
    { re: /^(capture-(?:bind|catch)):(.+)$/, bindingFromMatch: (m) => `${m[1]}:`, eventFromMatch: (m) => m[2] },
    { re: /^(capture-(?:bind|catch))(.+)$/,  bindingFromMatch: (m) => m[1],       eventFromMatch: (m) => m[2] },
    { re: /^mut-bind:(.+)$/,                  bindingFromMatch: () => "mut-bind:", eventFromMatch: (m) => m[1] },
    { re: /^(bind|catch):(.+)$/,              bindingFromMatch: (m) => `${m[1]}:`, eventFromMatch: (m) => m[2] },
    { re: /^(bind|catch)(.+)$/,               bindingFromMatch: (m) => m[1],       eventFromMatch: (m) => m[2] },
  ];

  function matchEventBinding(attrName) {
    for (const p of EVENT_PATTERNS) {
      const m = attrName.match(p.re);
      if (m) return { binding: p.bindingFromMatch(m), event: p.eventFromMatch(m) };
    }
    return null;
  }

  function innerValueRange(quotedValueNode) {
    // quoted_attribute_value spans "..." (or '...'). The handler text sits
    // between the quotes. For single-line single-quote-char values, shrink
    // the range by one column on each side. If the quote char is unexpected
    // or the value spans multiple lines, fall back to the full node range.
    const text = quotedValueNode.text;
    if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]
        && quotedValueNode.startPosition.row === quotedValueNode.endPosition.row) {
      return {
        start: { row: quotedValueNode.startPosition.row, column: quotedValueNode.startPosition.column + 1 },
        end:   { row: quotedValueNode.endPosition.row,   column: quotedValueNode.endPosition.column - 1 },
      };
    }
    return rangeOf(quotedValueNode);
  }

  function pushEventHandler(fileModel, attributeNode) {
    const nameNode = firstChildOfType(attributeNode, "attribute_name");
    if (!nameNode) return;
    const matched = matchEventBinding(nameNode.text);
    if (!matched) return;
    const valueNode = firstChildOfType(attributeNode, "quoted_attribute_value")
                   ?? firstChildOfType(attributeNode, "attribute_value");
    if (!valueNode) return;
    const handler = unquote(valueNode.text);
    fileModel.eventHandlers.push({
      event: matched.event,
      handler,
      binding: matched.binding,
      dynamic: handler.includes("{{"),
      range: rangeOf(attributeNode),
      nameRange: innerValueRange(valueNode),
    });
  }
  ```

- [ ] In the file model initialization, add `eventHandlers: []`.

- [ ] In the element-walking loop, for each `attribute` node found under a start_tag / self_closing_tag, call `pushEventHandler(fileModel, attributeNode)`. (Walk recursively so nested elements are covered.)

- [ ] In the JSON output, ensure `eventHandlers` appears after `components` (or wherever ordering is consistent across baselines — match the existing key sort order).

- [ ] Verify: `node --check scripts/extract-wxml-symbols.mjs` → exit 0.

### Task C2.2: Regen all 6 wasm symbol baselines

**Files:**
- Modify: `fixtures/wasm-spike/{home,miniprogram,test-wxml,real-world,edge-recovery,non-ascii}-symbols-baseline.json`

- [ ] Run the extractor on each fixture set and regenerate the baselines. Use the same args as `verify-wasm-symbol-baselines.mjs` runs internally:

  ```bash
  node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > fixtures/wasm-spike/home-symbols-baseline.json

  find fixtures/miniprogram -type f -name "*.wxml" | sort | \
    xargs node scripts/extract-wxml-symbols.mjs > fixtures/wasm-spike/miniprogram-symbols-baseline.json

  node scripts/extract-wxml-symbols.mjs fixtures/test.wxml > fixtures/wasm-spike/test-wxml-symbols-baseline.json

  node scripts/extract-wxml-symbols.mjs \
    fixtures/real-world/component.wxml \
    fixtures/real-world/page.wxml \
    fixtures/real-world/templates.wxml > fixtures/wasm-spike/real-world-symbols-baseline.json

  node scripts/extract-wxml-symbols.mjs fixtures/real-world/edge-recovery.wxml > fixtures/wasm-spike/edge-recovery-symbols-baseline.json

  node scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/non-ascii.wxml > fixtures/wasm-spike/non-ascii-symbols-baseline.json
  ```

- [ ] Spot-check that the changes are only additive (new `eventHandlers` array on each file; no other fields disappeared):

  ```bash
  git diff fixtures/wasm-spike/test-wxml-symbols-baseline.json | head -40
  ```

  Expect to see additions of `eventHandlers: [{event: "tap", handler: "onTap", binding: "bind", ...}, ...]` matching the 9 bindings in test.wxml lines 43-51.

- [ ] Run `node scripts/verify-wasm-symbol-baselines.mjs` — all 6 cases must PASS.

### Task C2.3: Run umbrella + commit C2

- [ ] Run `bash scripts/verify-tree-sitter.sh 2>&1 | tail -15` — must end with verification passed.
- [ ] Inspect:
  ```bash
  git status
  ```
  Expected: 7 modified files (extract-wxml-symbols.mjs + 6 baselines). Plan doc edits if any inline plan adjustments happened during C2 execution.

- [ ] Stage:
  ```bash
  git add scripts/extract-wxml-symbols.mjs \
          fixtures/wasm-spike/home-symbols-baseline.json \
          fixtures/wasm-spike/miniprogram-symbols-baseline.json \
          fixtures/wasm-spike/test-wxml-symbols-baseline.json \
          fixtures/wasm-spike/real-world-symbols-baseline.json \
          fixtures/wasm-spike/edge-recovery-symbols-baseline.json \
          fixtures/wasm-spike/non-ascii-symbols-baseline.json
  ```
- [ ] Commit (commit C2):
  ```bash
  git commit -m "$(cat <<'EOF'
  feat: extract wxml event handlers into symbol model

  Stage C step 2 of Event Handler Intelligence v1 Phase 1.

  scripts/extract-wxml-symbols.mjs now emits an eventHandlers[] array
  per file alongside dependencies/symbols/references/components. Each
  entry captures {event, handler, binding, dynamic, range, nameRange}
  for all WXML event binding forms: bindXXX, bind:XXX, catchXXX,
  catch:XXX, mut-bind:XXX, capture-bindXXX, capture-bind:XXX,
  capture-catchXXX, capture-catch:XXX. nameRange points inside the
  quote chars so LSP definition (Phase 2+) can jump to just the
  handler name token.

  All 6 committed wasm symbol baselines regenerated with the new
  field. No graph integration yet (that's C3); no LSP behavior change.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Sub-stage C3: Graph Integration + Miniprogram .js Fixtures

### Task C3.1: Create 7 .js fixtures for miniprogram

**Files:**
- Create: `fixtures/miniprogram/pages/home/home.js`
- Create: `fixtures/miniprogram/pages/detail/detail.js`
- Create: `fixtures/miniprogram/packages/shop/pages/list/list.js`
- Create: `fixtures/miniprogram/components/user-card/user-card.js`
- Create: `fixtures/miniprogram/components/local-badge/local-badge.js`
- Create: `fixtures/miniprogram/components/status-badge/status-badge.js`
- Create: `fixtures/miniprogram/components/global-badge/global-badge.js`

Each file must use the appropriate factory (`Page` for pages, `Component` for components) and include at least one method. For the page/component combinations that have event bindings in the corresponding `.wxml`, the JS file must include a matching handler name so downstream graph consumers can see the cross-reference work.

home.wxml binds `handleSelect` on `<user-card>`. user-card is a Component, so user-card.js should expose `handleSelect` in its `methods` block. But actually `bind:select="handleSelect"` is on the home page's `<user-card>` element — the WeChat event flow calls the handler defined on the **parent** Page (home), not the component. So home.js needs `handleSelect`.

- [ ] Create `fixtures/miniprogram/pages/home/home.js`:
  ```js
  Page({
    data: { users: [], total: 0, theme: "light", emptyReason: "" },
    onLoad() {
      this.refresh();
    },
    refresh() {
      this.setData({ users: [], total: 0 });
    },
    handleSelect(e) {
      console.log("user selected", e.detail);
    },
  });
  ```

- [ ] Create `fixtures/miniprogram/pages/detail/detail.js`:
  ```js
  Page({
    data: {},
    onLoad(options) {
      this.id = options.id;
    },
  });
  ```

- [ ] Create `fixtures/miniprogram/packages/shop/pages/list/list.js`:
  ```js
  Page({
    data: { items: [] },
    onShow() {
      this.refresh();
    },
    refresh() {
      this.setData({ items: [] });
    },
  });
  ```

- [ ] Create `fixtures/miniprogram/components/user-card/user-card.js`:
  ```js
  Component({
    properties: {
      user: { type: Object, value: {} },
    },
    methods: {
      onCardTap() {
        this.triggerEvent("select", { id: this.data.user.id });
      },
    },
  });
  ```

- [ ] Create `fixtures/miniprogram/components/local-badge/local-badge.js`:
  ```js
  Component({
    properties: { label: { type: String, value: "" } },
    methods: {},
  });
  ```

- [ ] Same skeleton (with appropriate name) for `status-badge.js` and `global-badge.js`.

### Task C3.2: Integrate JS extraction into graph extractor

**Files:**
- Modify: `scripts/extract-wxml-project-graph.mjs`

- [ ] At the top of the file, import the shared module and add JS wasm setup:

  ```js
  import { Parser, Language } from "web-tree-sitter";
  import { extractMethods } from "../shared/js-method-extractor.mjs";

  // ... existing imports + ROOT constant ...

  const JS_WASM = path.join(ROOT, "grammar/tree-sitter-javascript/tree-sitter-javascript.wasm");
  ```

- [ ] Add an async `attachScripts(graph)` helper. Parser initialization is **lazy** (only attempted when at least one sibling .js exists) and **wrapped in try/catch**: if the JS wasm fails to load, emit one stderr WARN and silently omit `script` from all remaining configs rather than crashing the graph build. This matches the per-file omission policy (missing/unreadable .js → field absent) and ensures WXML-only projects aren't broken by a corrupt JS wasm artifact.

  ```js
  async function attachScripts(graph) {
    // Failure modes — all silently omit the field, never crash graph build:
    //   - sibling .js absent / unreadable
    //   - JS wasm load failure (one stderr WARN on first attempt; subsequent configs skipped)
    //   - extractMethods throws (defensive)
    let parser;
    let parserSetupAttempted = false;
    let parserSetupFailed = false;
    for (const config of graph.configs) {
      if (config.kind === "app" || !config.owner) continue;
      const ownerAbs = path.resolve(ROOT, config.owner);
      const jsAbs = ownerAbs.replace(/\.wxml$/, ".js");
      let source;
      try {
        source = await fsp.readFile(jsAbs, "utf8");
      } catch {
        continue;
      }
      if (!parserSetupAttempted) {
        parserSetupAttempted = true;
        try {
          await Parser.init();
          const jsLanguage = await Language.load(JS_WASM);
          parser = new Parser();
          parser.setLanguage(jsLanguage);
        } catch (err) {
          parserSetupFailed = true;
          process.stderr.write(
            `WARN: JS wasm load failed (${err?.message || err}); configs[].script omitted for this graph build\n`,
          );
        }
      }
      if (parserSetupFailed) continue;
      let methods;
      try {
        methods = extractMethods(parser, source);
      } catch {
        continue;
      }
      config.script = {
        path: toPosixPath(path.relative(ROOT, jsAbs)),
        methods,
      };
    }
  }
  ```

  Note: even when wasm parse produces a tree with `hasError=true`, `extractMethods` returns whatever it walked — it doesn't throw. The catch around `extractMethods` is defensive only.

- [ ] Right before serializing the graph, call `await attachScripts(graph)`. Order is preserved — `script` field appears or is absent per config; configs[] array length unchanged.

- [ ] Verify: `node --check scripts/extract-wxml-project-graph.mjs` → exit 0.

- [ ] Smoke-run on miniprogram:
  ```bash
  node scripts/extract-wxml-project-graph.mjs fixtures/miniprogram > "$TMPDIR/graph.json"
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.env.TMPDIR+"/graph.json","utf8")); for (const c of m.configs) if (c.script) console.log(c.path, "->", c.script.path, c.script.methods.map(x=>x.name).join(","));'
  ```
  Expected output (rough):
  ```
  fixtures/miniprogram/pages/home/home.json -> fixtures/miniprogram/pages/home/home.js -> onLoad,refresh,handleSelect
  fixtures/miniprogram/pages/detail/detail.json -> fixtures/miniprogram/pages/detail/detail.js -> onLoad
  fixtures/miniprogram/components/user-card/user-card.json -> ... -> onCardTap
  ... etc ...
  ```

  If any expected `.js` doesn't show up, the integration walk is missing that config. Investigate before continuing.

### Task C3.3: Add language-service assertion for new graph field

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`

- [ ] Add a new assertion block in `verify-wxml-language-service.mjs` (after the existing `assert(home.references...` line) that checks:

  ```js
  const homeConfig = graph.configs.find((c) => c.owner === "fixtures/miniprogram/pages/home/home.wxml");
  assert(homeConfig, "graph.configs missing home page config");
  assert(homeConfig.script, "home page config missing script field");
  assert(homeConfig.script.path === "fixtures/miniprogram/pages/home/home.js",
    `home script path: expected home.js, got ${homeConfig.script.path}`);
  assert(homeConfig.script.methods.some((m) => m.name === "handleSelect"),
    "home script methods missing handleSelect (target of bind:select in home.wxml)");
  assert(homeConfig.script.methods.every((m) => m.nameRange && typeof m.nameRange.start.row === "number"),
    "every home script method must have a nameRange");
  ```

- [ ] Verify: `node --check scripts/verify-wxml-language-service.mjs` → exit 0.
- [ ] Standalone run: `node scripts/verify-wxml-language-service.mjs` → exit 0.

### Task C3.4: Run umbrella + commit C3

- [ ] Run `bash scripts/verify-tree-sitter.sh 2>&1 | tail -15` — must end with verification passed.
- [ ] Inspect:
  ```bash
  git status
  ```
  Expected: 7 new .js fixtures + 2 modified scripts.
- [ ] Stage:
  ```bash
  git add fixtures/miniprogram/pages/home/home.js \
          fixtures/miniprogram/pages/detail/detail.js \
          fixtures/miniprogram/packages/shop/pages/list/list.js \
          fixtures/miniprogram/components/user-card/user-card.js \
          fixtures/miniprogram/components/local-badge/local-badge.js \
          fixtures/miniprogram/components/status-badge/status-badge.js \
          fixtures/miniprogram/components/global-badge/global-badge.js \
          scripts/extract-wxml-project-graph.mjs \
          scripts/verify-wxml-language-service.mjs
  ```
- [ ] Commit (commit C3):
  ```bash
  git commit -m "$(cat <<'EOF'
  feat: integrate js method extraction into project graph

  Stage C step 3 of Event Handler Intelligence v1 Phase 1.

  scripts/extract-wxml-project-graph.mjs now reads each non-app
  config's sibling .js file (resolved by replacing .wxml extension)
  and attaches the extracted methods as configs[].script = {path,
  methods}. Uses shared/js-method-extractor.mjs in-process — no
  forked child for the JS extraction since graph extractor is its
  only caller. Missing or unreadable .js files are silently omitted
  (field absent), not error.

  Adds 7 .js fixtures under fixtures/miniprogram/ covering all
  pages and components. Notable: home.js exposes handleSelect to
  match home.wxml's bind:select binding on user-card.

  verify-wxml-language-service.mjs gains assertions locking the
  new graph.configs[].script shape on the home page config,
  including that nameRange flows through end to end.

  Stage C complete. Full event handler data model is now available
  in the graph output. Phase 2 (LSP definition/completion/diagnostic
  on top of this model) is unblocked but explicitly out of scope.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

### Task C3.5: Record Stage C outcome in notes

**Files:**
- Modify: `docs/wasm-parser-spike-notes.md`

This is a separate commit because the doc update spans the full Stage C arc, not any single sub-commit.

- [ ] Append a "Stage C Outcome (Data Model Integration)" section covering:
  - Shared JS extractor module + nameRange addition
  - broken-page.js fixture locking hasError tolerance
  - WXML extractor's new eventHandlers[] field with 9-binding-form coverage in test.wxml baseline
  - Graph extractor's new `configs[].script` field linking owner .wxml to sibling .js methods
  - Concrete cross-reference example: home.wxml's `bind:select="handleSelect"` resolves through graph to home.js's `handleSelect` method
  - Explicit Stage D+ readiness statement: "Data model complete. LSP definition/completion/diagnostic features can now consume this model without further extractor work."
  - List of items still deferred to Phase 2+ (LSP features) and v2 candidates (behaviors, spread, computed keys, TS/TSX, etc.)

- [ ] Stage and commit:
  ```bash
  git add docs/wasm-parser-spike-notes.md
  git commit -m "docs: record Stage C event handler data model integration outcome

  Notes covering all three Stage C sub-commits (shared JS extractor +
  nameRange + broken-js fixture; WXML eventHandlers schema; graph
  configs[].script integration). Explicit ready statement for Phase 2
  LSP features. Deferred items list refreshed.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  "
  ```

---

## Self-Review

**Spec coverage:**
- JS POC → shared module + nameRange + broken-js fixture → C1 ✅
- WXML extractor gains eventHandlers[] across all 9 binding forms → C2 ✅
- Graph extractor attaches sibling .js methods to configs[].script → C3 ✅
- Cross-reference verifiable end to end (home bind:select → home.js handleSelect) → C3.3 assertion ✅
- All 6 WXML symbol baselines regenerated for schema bump → C2.2 ✅
- JS method baseline updated for nameRange + new fixture → C1.4 ✅
- No LSP feature work, no graph baseline, no behaviors / spread / TS → out-of-scope explicit ✅

**Placeholders:** None. Every fixture file content is concrete; every regen command is exact; every assertion has its expected value spelled out.

**Type consistency:**
- `nameRange` is a `{start: {row, column}, end: {row, column}}` shape throughout, matching `range`.
- `configs[].script` shape: `{path: string, methods: Array}` consistently between graph extractor emission and language-service consumption.
- `eventHandlers[]` entry shape exactly matches what the graph integration consumers will see — though Stage C doesn't yet have a graph consumer of eventHandlers, the shape choice anticipates Phase 2 needing it.

**Plan-doc-sync check (from feedback memory `sync-plan-after-inline-fixes`):**
- File Structure section lists every file touched by every sub-commit
- Every sub-commit's expected `git status` + `git add` lists are exhaustive
- If execution surfaces a needed change (e.g. a fixture has to be split, or graph extractor needs an extra field to make assertions pass), update THIS plan before committing the corresponding sub-stage — never let plan and code drift.

**Known fragility:**
- The exact methods that `broken-page.js` recovers depend on tree-sitter-javascript's error recovery, which can shift across grammar versions. Task C1.4 explicitly notes that whatever the current outcome is gets baselined; if a future grammar upgrade changes recovery, the baseline regenerates and the rationale gets a note.
- `nameRange` inside `quoted_attribute_value` assumes single-line single-quote-char attribute values. WXML allows attribute values on multiple lines but it's rare; the fallback to full node range is documented in C2.1's `innerValueRange` implementation.
- Event-pattern regex order matters and is tested only against the 9 explicit forms in test.wxml. Any new binding prefix added by WeChat in the future may need an additional regex.
- Sibling .js resolution by extension swap (`.wxml` → `.js`) assumes the conventional WeChat mini-program layout. Codebases using non-conventional layouts (e.g. compiled output, Taro) won't be supported — explicit Phase 2+ concern.
