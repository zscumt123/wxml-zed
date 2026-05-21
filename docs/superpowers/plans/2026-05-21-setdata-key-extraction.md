# setData-Derived Template Scope Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the JS method extractor to capture keys added to template scope via `this.setData({...})` calls inside Page/Component method bodies, eliminating the dominant `missing-expression-ref` false-positive pattern on real-world WeChat mini-programs.

**Architecture:** Add a setData walker that recurses into owner-context function bodies (Page top-level functions; Component methods/lifetimes/pageLifetimes/observers/properties.observer) and finds `this.setData(<obj>, ...)` calls. Extract static keys from the object literal argument with a `source: "setData"` marker. Merge into existing `dataKeys` (dedup by name, "data" source wins on collision). Computed keys, spread elements, and non-object arguments still trigger `hasDynamicData = true` so we don't lie about completeness. Existing `dataKeys`/`propertyKeys` entries gain a `source` discriminator (`"data"` / `"property"`) so future consumers (Hover, Definition) can show provenance.

**Tech Stack:** web-tree-sitter (JS grammar, already loaded), Node ESM modules. Same testing rig as the rest of the extractor: synthetic source strings in `scripts/verify-js-script-info.mjs`, fixture-based snapshot via `scripts/verify-js-method-baselines.mjs`, real-project dogfood via `scripts/dump-project-diagnostics.mjs`.

---

## Background

P2 audit on `mp-wx-chelaile/wx` (commit `0acc7a3` of wxml-zed; chelaile @ `0c21dc5`, 6 dirty files — not a clean release baseline) produced 220 diagnostics: 213 `missing-expression-ref` (96.8%) + 7 `missing-event-handler` (3.2%). All 7 event-handler diagnostics are real bugs (typo'd handler names, handlers defined on the wrong file, etc.) — those stay. The expression-ref dominant noise pattern is reproducible smoking gun:

```js
// pages/components/station-line/stn-empty/index.js
Component({
  data: { visible: false },
  methods: {
    reload() {
      this.setData({
        LINE_STATE,             // imported JS constant
        describe: line.desc,    // computed runtime value
      });
    },
  },
});
```

```wxml
<!-- index.wxml references LINE_STATE and describe, both flagged missing -->
<block wx:elif="{{line.state === LINE_STATE.NO_DATA}}">
  <view class="line-1">{{describe}}</view>
```

Top expression-ref names from chelaile (`/tmp/claude-501/wxml-zed-diagnostics/wx.summary.txt`) all fit this shape: `load_state` (13), `load_states` (11), `LINE_STATE` (6), `describe` (6), `time` (9), `tag` (7), `tagList` (7), `physicalDistance` (9), `logicDistance` (6), `inTargetRange` (9). They are runtime data injected through setData, not module helpers or typos.

Architectural decision discussed and agreed before planning:

- **Option 1 (rejected)** — set `hasDynamicData = true` whenever a file contains any setData call. Kills the noise but also kills the diagnostic in any file that uses setData (most files), eliminating the value of expression-ref entirely.
- **Option 2 (this plan)** — walk setData call sites, extract static keys, fold into scope. Only fall back to `hasDynamicData = true` when the setData argument is genuinely unanalyzable (variable, spread, non-object).

## File Structure

**Modified:**
- `shared/js-method-extractor.mjs` — main change point. Add helpers: `extractSetDataKeysFromCall(callNode)` (returns `{keys, dynamic}`); `walkOwnerFunctionForSetData(funcOrMethodNode, sink)`. Wire into the existing Page/Component visit branch. Add `source` field to all existing dataKey/propertyKey emissions.
- `scripts/verify-js-script-info.mjs` — add synthetic test cases covering every setData shape; assert `source` is present on every entry.
- `fixtures/wasm-spike/sample-component.js` — has `this.setData({ selected: ... })` inside `handleSelect`. After this change, `selected` will appear in dataKeys with `source: "setData"`. Update the JS-methods baseline (`fixtures/wasm-spike/js-methods-baseline.json`) only if it includes dataKeys (it currently does not — verify before updating).

**No new files.** All new logic lives in the existing extractor.

**Docs:**
- `docs/superpowers/plans/2026-05-21-setdata-key-extraction.md` — this file. Gains an "Outcome" section in Task 5 with chelaile before/after numbers.
- `docs/wasm-parser-spike-notes.md` — gains a short follow-up entry referencing this plan and the before/after dogfood numbers, mirroring how P1 was recorded.

## Owner-Context Scopes (exhaustive list)

The walker MUST scan function bodies in exactly these positions and nowhere else. Anything outside this list (module-level helpers, arrow functions assigned to `const`, methods defined on imported classes) is OUT OF SCOPE — those don't run on the page/component instance and their setData calls would not affect template scope.

**Page({ ... }) options object:**
- Every top-level pair whose value is a function (lifecycle: `onLoad`, `onShow`, `onReady`, `onHide`, `onUnload`, `onPullDownRefresh`, `onReachBottom`, `onShareAppMessage`, `onShareTimeline`, `onAddToFavorites`, `onPageScroll`, `onResize`, `onTabItemTap` — plus user-defined methods).
- We do not enumerate names; any function-valued pair counts.

**Component({ ... }) options object:**
- Top-level function-valued pairs (legacy lifecycle: `created`, `attached`, `ready`, `moved`, `detached`, `error`).
- `methods: { ... }` — every function-valued pair.
- `lifetimes: { ... }` — every function-valued pair (modern lifecycle).
- `pageLifetimes: { ... }` — every function-valued pair (component-side `show`/`hide`/`resize`).
- `observers: { ... }` — every function-valued pair (multi-field watcher syntax).
- `properties: { <name>: { observer: ... } }` — the `observer` function inside each property descriptor.

**Wrapper factories** — `Fw.Page({...})` / `app.Component({...})` etc. unwrap the same way the existing `isPageOrComponentCall` does, then apply Page or Component rules above.

**NOT scanned:**
- Module-level functions, arrow functions assigned to const, exported helpers.
- `setData` calls reachable only through nested helper functions outside the option-object closure.
- `behaviors:` injection (those bring in scope from another file we don't follow).

## Edge Case Decisions (already agreed)

| Shape | Behavior |
|---|---|
| `this.setData({ a: 1, b, "c": 2 })` | Extract `a`/`b`/`c` with `source: "setData"`. Keys come from `pair` (identifier or string with valid identifier shape) and `shorthand_property_identifier`. |
| `this.setData({ "with-dash": 1 })` | Skip — not a valid JS identifier, can't be referenced from a WXML expression anyway. Same rule the data-block extractor uses (`IDENTIFIER_SHAPE`). |
| `this.setData({ [name]: 1, foo: 2 })` | Extract `foo`. Set `hasDynamicData = true` because the computed key is unknown. |
| `this.setData({ ...payload, foo: 1 })` | Extract `foo`. Set `hasDynamicData = true` because spread may contain keys we can't enumerate. |
| `this.setData(payload)` | Set `hasDynamicData = true`. No keys extracted (argument is not an object literal). |
| `this.setData()` (no args) | Skip. Genuinely a no-op call. Don't crash. |
| `this.setData({}, callback)` | Extract from the first arg only; callback (second arg) ignored. |
| `setData({...})` (no `this.`) | Skip. Method-call-only — the `setData` keyword without `this` could be anything. |
| `this.setData` inside a nested arrow / setTimeout(arrow) / Promise.then(arrow) callback within an owner-context function | Extract. Arrow functions inherit `this` lexically, so `this` is still the component instance. The walker descends into arrow_function nodes. |
| `this.setData` inside a nested regular `function () {}` or `function* () {}` (e.g., `setTimeout(function () { this.setData(...) })`) | Skip. Regular functions and generators rebind `this`; the receiver here is the timer / Promise / generator context, not the component. Extracting would let typos hide. The walker stops at function_expression / function_declaration / method_definition / generator_function / generator_function_declaration boundaries. (Async functions reuse function_expression / function_declaration in tree-sitter-javascript, so they're covered automatically.) |
| `this.setData` inside a function defined as a value but not in an owner-context scope (e.g., `data: { onClick: function() { this.setData(...) } }`) | Skip. `data:` block values aren't event handlers; their `this` is unbound. |

## Dedup Rule

`dataKeys` is a flat array, dedup by `name`. When the same name appears in both the static `data: { ... }` block and a setData call:

- Keep the entry with `source: "data"` (more authoritative — has the static default value declared).
- Drop the setData entry silently (no warning; this is common — devs declare `foo: null` in data then setData a real value later).
- Order: emit `data:` block keys first, then setData keys (preserves natural reading order in completion lists).

`propertyKeys` is unaffected by setData (properties belong to the parent component, not setData).

---

## Task 1: Add `source` discriminator to existing dataKeys/propertyKeys

**Files:**
- Modify: `shared/js-method-extractor.mjs:167-194` (`extractDataKeys`)
- Modify: `shared/js-method-extractor.mjs:196-255` (`extractMethods` — propertyKeys collection)
- Modify: `scripts/verify-js-script-info.mjs` — structural assertion section

This is preparatory. We tag existing entries before adding setData entries so the merge in Task 3 is uniform.

- [ ] **Step 1: Add a `source` parameter to `extractDataKeys`**

Replace the existing `extractDataKeys` (lines 167-194) with:

```js
function extractDataKeys(dataObjectNode, source) {
  const out = [];
  for (let i = 0; i < dataObjectNode.namedChildCount; i++) {
    const child = dataObjectNode.namedChild(i);
    if (child.type === "pair") {
      const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
      if (!keyNode) continue;
      if (keyNode.type === "property_identifier") {
        out.push({ name: keyNode.text, nameRange: rangeOf(keyNode), source });
      } else if (keyNode.type === "string") {
        const fragment = firstChildOfType(keyNode, "string_fragment");
        const text = fragment ? fragment.text : "";
        if (IDENTIFIER_SHAPE.test(text)) {
          out.push({ name: text, nameRange: rangeOf(fragment), source });
        }
      }
    } else if (child.type === "shorthand_property_identifier") {
      out.push({ name: child.text, nameRange: rangeOf(child), source });
    }
  }
  return out;
}
```

- [ ] **Step 2: Update the two callers in `extractMethods` to pass `source`**

In `extractMethods` (around lines 233-243), change:

```js
const dataBlock = dataBlockOf(opts);
if (dataBlock) {
  if (containsSpread(dataBlock)) hasDynamicData = true;
  dataKeys.push(...extractDataKeys(dataBlock));
}

const propertiesBlock = propertiesBlockOf(opts);
if (propertiesBlock) {
  if (containsSpread(propertiesBlock)) hasDynamicData = true;
  propertyKeys.push(...extractDataKeys(propertiesBlock));
}
```

to:

```js
const dataBlock = dataBlockOf(opts);
if (dataBlock) {
  if (containsSpread(dataBlock)) hasDynamicData = true;
  dataKeys.push(...extractDataKeys(dataBlock, "data"));
}

const propertiesBlock = propertiesBlockOf(opts);
if (propertiesBlock) {
  if (containsSpread(propertiesBlock)) hasDynamicData = true;
  propertyKeys.push(...extractDataKeys(propertiesBlock, "property"));
}
```

- [ ] **Step 3: Add `source` to structural assertion in verify-js-script-info.mjs**

In `scripts/verify-js-script-info.mjs:319-329`, expand the structural assertion loop to also check `source`:

```js
// Structural assertion: each returned entry has a nameRange with numeric row/column
// and a source discriminator.
for (const entry of result.dataKeys) {
  assert(
    entry.nameRange
      && typeof entry.nameRange.start?.row === "number"
      && typeof entry.nameRange.start?.column === "number"
      && typeof entry.nameRange.end?.row === "number"
      && typeof entry.nameRange.end?.column === "number",
    `${label}: dataKey "${entry.name}" missing valid nameRange ${JSON.stringify(entry.nameRange)}`,
  );
  assert(
    entry.source === "data" || entry.source === "setData",
    `${label}: dataKey "${entry.name}" has invalid source ${JSON.stringify(entry.source)}`,
  );
}
for (const entry of result.propertyKeys) {
  assert(
    entry.nameRange
      && typeof entry.nameRange.start?.row === "number"
      && typeof entry.nameRange.start?.column === "number"
      && typeof entry.nameRange.end?.row === "number"
      && typeof entry.nameRange.end?.column === "number",
    `${label}: propertyKey "${entry.name}" missing valid nameRange ${JSON.stringify(entry.nameRange)}`,
  );
  assert(
    entry.source === "property",
    `${label}: propertyKey "${entry.name}" has invalid source ${JSON.stringify(entry.source)}`,
  );
}
```

- [ ] **Step 4: Run verify-js-script-info to confirm Task 1 passes**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-js-script-info.mjs
```

Expected output: `PASS\n\nAll <N> script-info cases match.\n`

If a case fails, the diff will show that the new structural assertion caught a missing `source` field — fix the relevant emission site, do NOT loosen the assertion.

- [ ] **Step 5: Commit**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add shared/js-method-extractor.mjs scripts/verify-js-script-info.mjs
git commit -m "$(cat <<'EOF'
refactor: tag dataKeys/propertyKeys with source discriminator

Adds a source field ("data" or "property") on every dataKey and
propertyKey entry emitted by extractMethods. Preparatory for the
setData walker, which will emit dataKey entries with source:
"setData" and rely on this field to dedupe against authoritative
data-block declarations. Existing consumers (diagnostic, completion,
definition) read only .name and are unaffected. Structural assertions
in verify-js-script-info now enforce the field's presence.
EOF
)"
```

---

## Task 2: setData walker — extract static keys from a single call

**Files:**
- Modify: `shared/js-method-extractor.mjs` — add new helpers `extractSetDataKeysFromCall` and `walkOwnerFunctionForSetData`.
- Modify: `scripts/verify-js-script-info.mjs` — add unit-style cases that exercise the walker through a Page wrapper.

The helper does the per-call analysis. Walking the right function bodies is Task 3.

- [ ] **Step 1: Add `extractSetDataKeysFromCall` helper**

Insert AFTER the existing `extractDataKeys` function (around line 195, before `extractMethods`):

```js
// Detects `this.setData(<arg>, ...)` shape and returns the call's first-arg
// node if matched. Returns null otherwise. Note: bare `setData(...)` without
// `this.` is intentionally NOT matched — there's no way to know what
// `setData` refers to without scope tracking, and false positives there
// would expand template scope on unrelated helpers.
function setDataCallArgNode(callNode) {
  const fn = fieldChild(callNode, "function");
  if (!fn || fn.type !== "member_expression") return null;
  const object = fieldChild(fn, "object");
  const property = fieldChild(fn, "property");
  if (!object || object.type !== "this") return null;
  if (!property || property.type !== "property_identifier") return null;
  if (property.text !== "setData") return null;
  const args = fieldChild(callNode, "arguments");
  if (!args || args.namedChildCount === 0) return null;
  return args.namedChild(0);
}

// Given a single `this.setData(<arg>, ...)` call, return { keys, dynamic }.
//   keys     — array of { name, nameRange, source: "setData" } extracted from
//              static identifier/shorthand/quoted-identifier properties.
//   dynamic  — true if any computed key, spread element, or non-object first
//              arg appeared. Tells the caller to force hasDynamicData = true
//              for the whole script (even if we did extract some keys).
function extractSetDataKeysFromCall(callNode) {
  const arg = setDataCallArgNode(callNode);
  if (!arg) return { keys: [], dynamic: false };
  if (arg.type !== "object") {
    // setData(payload) / setData(callExpr()) / setData(arrayLiteral) —
    // first arg is not statically analyzable. Mark dynamic; no keys.
    return { keys: [], dynamic: true };
  }
  const keys = [];
  let dynamic = false;
  for (let i = 0; i < arg.namedChildCount; i++) {
    const child = arg.namedChild(i);
    if (child.type === "spread_element") {
      dynamic = true;
      continue;
    }
    if (child.type === "pair") {
      const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
      if (!keyNode) {
        dynamic = true;
        continue;
      }
      if (keyNode.type === "computed_property_name") {
        // setData({ [expr]: value }) — key is computed at runtime.
        dynamic = true;
        continue;
      }
      if (keyNode.type === "property_identifier") {
        keys.push({ name: keyNode.text, nameRange: rangeOf(keyNode), source: "setData" });
      } else if (keyNode.type === "string") {
        const fragment = firstChildOfType(keyNode, "string_fragment");
        const text = fragment ? fragment.text : "";
        if (IDENTIFIER_SHAPE.test(text)) {
          keys.push({ name: text, nameRange: rangeOf(fragment), source: "setData" });
        }
        // Quoted key with non-identifier shape (e.g., "with-dash") is silently
        // skipped: it cannot be referenced from a WXML expression anyway.
      } else {
        // Number-literal key (`{ 0: ... }`) etc. — not template-referenceable.
      }
    } else if (child.type === "shorthand_property_identifier") {
      keys.push({ name: child.text, nameRange: rangeOf(child), source: "setData" });
    }
    // Object methods (`{ foo() {} }`) are intentionally ignored — those don't
    // happen in real setData calls and would just be noise.
  }
  return { keys, dynamic };
}
```

- [ ] **Step 2: Add `walkOwnerFunctionForSetData` helper**

Insert after `extractSetDataKeysFromCall`:

```js
// Walks call_expression descendants of `funcNode` (a function or method
// definition node), running extractSetDataKeysFromCall on each.
//
// Critical: stops at nested function boundaries that REBIND `this` —
// regular function_expression / function_declaration / method_definition /
// generator_function / generator_function_declaration each get their own
// `this`, so a `this.setData(...)` inside them is NOT a call on the
// component instance and must be ignored. arrow_function
// continues to be walked because arrows inherit `this` lexically; that
// covers the common Promise.then(res => this.setData(...)) /
// setTimeout(() => this.setData(...)) patterns.
//
// Sink is a mutable { keys, dynamic } accumulator passed by the caller —
// we merge into it rather than allocating per-function.
function walkOwnerFunctionForSetData(funcNode, sink) {
  const visit = (node) => {
    // Don't descend into nested non-arrow function bodies. The root
    // funcNode itself is exempt: we always want to enter its body.
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
      const result = extractSetDataKeysFromCall(node);
      if (result.dynamic) sink.dynamic = true;
      for (const key of result.keys) sink.keys.push(key);
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
  };
  visit(funcNode);
}
```

- [ ] **Step 3: Run verify-js-script-info — existing cases must still pass**

The two new helpers (`extractSetDataKeysFromCall`, `walkOwnerFunctionForSetData`) are unreferenced dead code at this point — Task 3 wires them in. No new test cases land here. The existing cases must still pass exactly as they did after Task 1.

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-js-script-info.mjs
```

Expected: `PASS\n\nAll <N> script-info cases match.\n` where `<N>` is the same count as after Task 1. If anything fails, the helpers must have introduced a syntax error or shadowed an existing symbol — fix before committing.

- [ ] **Step 4: Commit helpers only (no failing tests in history)**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add shared/js-method-extractor.mjs
git commit -m "$(cat <<'EOF'
feat: setData walker helpers (extractSetDataKeysFromCall, walkOwnerFunctionForSetData)

Adds two helper functions in shared/js-method-extractor.mjs:

- extractSetDataKeysFromCall(callNode) returns { keys, dynamic } from
  a single this.setData(<obj>, ...) call. Handles static identifier
  keys, shorthand properties, quoted-identifier-shape keys, and flags
  computed keys / spread elements / non-object args as dynamic.

- walkOwnerFunctionForSetData(funcNode, sink) walks call_expression
  descendants of funcNode and merges every setData call's keys into
  the shared sink. Stops at nested function_expression /
  function_declaration / method_definition boundaries (those rebind
  this); descends into arrow_function (lexical this).

Helpers are unwired dead code at this commit — Task 3 lands the
Page/Component scope wiring along with the synthetic test cases that
exercise both helpers.
EOF
)"
```

---

## Task 3: Wire walker into Page/Component owner-context scopes

**Files:**
- Modify: `shared/js-method-extractor.mjs` — extend the existing Page/Component branch in `extractMethods` to invoke the walker.
- Modify: `scripts/verify-js-script-info.mjs` — add cases covering all Component scope variants + the dedup rule.

This wires the walker into every owner-context scope from the "Owner-Context Scopes" section above.

- [ ] **Step 1: Add helpers to enumerate function-valued pairs in an option object**

Insert these helpers in `shared/js-method-extractor.mjs`, after `propertiesBlockOf` (around line 163):

```js
// Returns every top-level pair in `objectNode` whose value is a function
// expression / arrow function / method-definition shorthand. Used to find
// Page lifecycle handlers and Component legacy lifecycle handlers.
function functionValuedPairs(objectNode) {
  const out = [];
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (child.type === "method_definition") {
      out.push(child);
    } else if (child.type === "pair") {
      const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
      if (valueNode && FUNCTION_VALUE_TYPES.has(valueNode.type)) {
        out.push(valueNode);
      }
    }
  }
  return out;
}

// Returns the inner object node for a named pair (e.g. `lifetimes: { ... }`).
// Returns null if the key is missing or the value isn't an object literal.
function namedObjectBlock(objectNode, blockName) {
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (child.type !== "pair") continue;
    const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
    if (!keyNode || keyNode.type !== "property_identifier" || keyNode.text !== blockName) continue;
    const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
    if (valueNode && valueNode.type === "object") return valueNode;
  }
  return null;
}

// Collects observer function nodes from `properties: { <name>: { observer: <fn> } }`.
function propertyObservers(propertiesBlockNode) {
  const out = [];
  for (let i = 0; i < propertiesBlockNode.namedChildCount; i++) {
    const propPair = propertiesBlockNode.namedChild(i);
    if (propPair.type !== "pair") continue;
    const descriptor = fieldChild(propPair, "value") ?? propPair.namedChild(1);
    if (!descriptor || descriptor.type !== "object") continue;
    for (let j = 0; j < descriptor.namedChildCount; j++) {
      const field = descriptor.namedChild(j);
      if (field.type === "method_definition") {
        const nameNode = firstChildOfType(field, "property_identifier");
        if (nameNode && nameNode.text === "observer") out.push(field);
      } else if (field.type === "pair") {
        const keyNode = fieldChild(field, "key") ?? firstChildOfType(field, "property_identifier");
        if (!keyNode || keyNode.type !== "property_identifier" || keyNode.text !== "observer") continue;
        const valueNode = fieldChild(field, "value") ?? field.namedChild(1);
        if (valueNode && FUNCTION_VALUE_TYPES.has(valueNode.type)) out.push(valueNode);
      }
    }
  }
  return out;
}
```

Note: `FUNCTION_VALUE_TYPES` is the existing `Set(["function_expression", "arrow_function"])` at file top. `method_definition` is checked separately because it's a different node type entirely (not a pair).

- [ ] **Step 2: Invoke the walker from `extractMethods` for Page and Component scopes**

In `extractMethods`, after the existing data/properties extraction block (around line 244, immediately before the closing `}` of `} else if (firstArg) {`), add:

```js
          // setData key collection. Sink accumulates across every owner-
          // context function body; merged into dataKeys after the visit.
          const setDataSink = { keys: [], dynamic: false };

          if (factory === "Page") {
            // Page: every top-level function-valued pair is an owner-
            // context function (lifecycle + user-defined methods both live
            // here; there's no separate methods block).
            for (const fn of functionValuedPairs(opts)) {
              walkOwnerFunctionForSetData(fn, setDataSink);
            }
          } else {
            // Component: walk legacy top-level lifecycle + the methods,
            // lifetimes, pageLifetimes, observers blocks + observer functions
            // inside properties descriptors.
            for (const fn of functionValuedPairs(opts)) {
              walkOwnerFunctionForSetData(fn, setDataSink);
            }
            const methodsBlock = methodsBlockOf(opts);
            if (methodsBlock) {
              for (const fn of functionValuedPairs(methodsBlock)) {
                walkOwnerFunctionForSetData(fn, setDataSink);
              }
            }
            for (const blockName of ["lifetimes", "pageLifetimes", "observers"]) {
              const block = namedObjectBlock(opts, blockName);
              if (block) {
                for (const fn of functionValuedPairs(block)) {
                  walkOwnerFunctionForSetData(fn, setDataSink);
                }
              }
            }
            const propertiesBlockForObservers = propertiesBlockOf(opts);
            if (propertiesBlockForObservers) {
              for (const obs of propertyObservers(propertiesBlockForObservers)) {
                walkOwnerFunctionForSetData(obs, setDataSink);
              }
            }
          }

          if (setDataSink.dynamic) hasDynamicData = true;

          // Dedup setData keys against the data block: data-block declaration
          // is more authoritative (has a static default value), so keep it
          // and silently drop the setData copy. Preserves natural reading
          // order: data block first, then setData additions.
          const existingDataNames = new Set(dataKeys.map((k) => k.name));
          for (const key of setDataSink.keys) {
            if (existingDataNames.has(key.name)) continue;
            existingDataNames.add(key.name);
            dataKeys.push(key);
          }
```

Place this block immediately after `propertiesBlock` handling (lines 239-243 before this change), still inside the `else if (firstArg)` branch.

- [ ] **Step 3: Add all synthetic test cases to verify-js-script-info**

Insert into the `CASES` array, after the existing cases. This block covers Page scope (4 cases), Component scopes (6 cases — methods/lifetimes/pageLifetimes/observers/property-observer/legacy-top-level), nested function behavior (2 cases — arrow descends / regular function stops), edge cases (5 cases — spread / non-object / empty / dedup / bare-without-this / module-level helper), and computed-key dynamic flag (1 case). 18 cases total.

Every case explicitly declares `dataKeySources` and `propertyKeySources`. Existing cases earlier in the file (with `dataKeys: []` / `propertyKeys: []`) do NOT need updating — the per-case assertion treats missing `dataKeySources` / `propertyKeySources` as "don't check" (still relies on the Task 1 structural assertion for source-field validity).

```js
{
  label: "Page with static setData in lifecycle",
  source: `Page({
    data: { count: 0 },
    onLoad() {
      this.setData({ message: "hi", visible: true });
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["onLoad"],
  dataKeys: ["count", "message", "visible"],
  dataKeySources: { count: "data", message: "setData", visible: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "Page setData with shorthand property",
  source: `Page({
    data: {},
    onShow() {
      const userName = "x";
      this.setData({ userName });
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["onShow"],
  dataKeys: ["userName"],
  dataKeySources: { userName: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "Page setData with quoted identifier-shape key",
  source: `Page({
    data: {},
    custom() {
      this.setData({ "foo": 1, "with-dash": 2, "bar": 3 });
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["custom"],
  dataKeys: ["foo", "bar"],
  dataKeySources: { foo: "setData", bar: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "Page setData with computed key triggers dynamic",
  source: `Page({
    data: {},
    onLoad() {
      this.setData({ [dynName]: 1, staticName: 2 });
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["onLoad"],
  dataKeys: ["staticName"],
  dataKeySources: { staticName: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: true,
},
{
  label: "Component setData inside methods block",
  source: `Component({
    data: { visible: false },
    methods: {
      reload() { this.setData({ describe: "x", count: 1 }); },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["reload"],
  dataKeys: ["visible", "describe", "count"],
  dataKeySources: { visible: "data", describe: "setData", count: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "Component setData inside lifetimes",
  source: `Component({
    data: {},
    lifetimes: {
      attached() { this.setData({ ready: true }); },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: [],
  dataKeys: ["ready"],
  dataKeySources: { ready: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "Component setData inside pageLifetimes",
  source: `Component({
    data: {},
    pageLifetimes: {
      show() { this.setData({ active: true }); },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: [],
  dataKeys: ["active"],
  dataKeySources: { active: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "Component setData inside observers",
  source: `Component({
    data: {},
    observers: {
      "field"() { this.setData({ derived: 1 }); },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: [],
  dataKeys: ["derived"],
  dataKeySources: { derived: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "Component setData inside property observer",
  source: `Component({
    data: {},
    properties: {
      value: { type: String, observer() { this.setData({ derived: 1 }); } },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: [],
  dataKeys: ["derived"],
  dataKeySources: { derived: "setData" },
  propertyKeys: ["value"],
  propertyKeySources: { value: "property" },
  hasDynamicData: false,
},
{
  label: "Component setData inside legacy top-level lifecycle",
  source: `Component({
    data: {},
    attached() { this.setData({ ready: true }); },
  });`,
  hasDynamicMethods: false,
  methodNames: ["attached"],
  dataKeys: ["ready"],
  dataKeySources: { ready: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "Component setData inside nested arrow (setTimeout) is extracted",
  source: `Component({
    data: {},
    methods: {
      kick() { setTimeout(() => this.setData({ later: 1 }), 100); },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["kick"],
  dataKeys: ["later"],
  dataKeySources: { later: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "Component nested regular function this.setData is ignored",
  source: `Component({
    data: { foo: 1 },
    methods: {
      run() {
        setTimeout(function () { this.setData({ ignored: 1 }); }, 0);
      },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["run"],
  dataKeys: ["foo"],
  dataKeySources: { foo: "data" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "Component setData spread triggers dynamic but still keeps static keys",
  source: `Component({
    data: {},
    methods: {
      reload() { this.setData({ ...payload, keep: 1 }); },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["reload"],
  dataKeys: ["keep"],
  dataKeySources: { keep: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: true,
},
{
  label: "Component setData non-object arg triggers dynamic",
  source: `Component({
    data: { foo: 1 },
    methods: {
      apply() { this.setData(payload); },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["apply"],
  dataKeys: ["foo"],
  dataKeySources: { foo: "data" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: true,
},
{
  label: "Component setData empty args is a no-op",
  source: `Component({
    data: { foo: 1 },
    methods: {
      apply() { this.setData(); },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["apply"],
  dataKeys: ["foo"],
  dataKeySources: { foo: "data" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "Component setData dedup: data block wins on collision",
  source: `Component({
    data: { visible: false },
    methods: {
      toggle() { this.setData({ visible: true, derived: 1 }); },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["toggle"],
  dataKeys: ["visible", "derived"],
  dataKeySources: { visible: "data", derived: "setData" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "bare setData(...) without this. is ignored",
  source: `Component({
    data: { foo: 1 },
    methods: {
      apply() { setData({ should_not_appear: 1 }); },
    },
  });`,
  hasDynamicMethods: false,
  methodNames: ["apply"],
  dataKeys: ["foo"],
  dataKeySources: { foo: "data" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
{
  label: "setData in module-level helper is ignored",
  source: `function helper() { this.setData({ nope: 1 }); }
    Component({
      data: { foo: 1 },
      methods: { run() { helper(); } },
    });`,
  hasDynamicMethods: false,
  methodNames: ["run"],
  dataKeys: ["foo"],
  dataKeySources: { foo: "data" },
  propertyKeys: [],
  propertyKeySources: {},
  hasDynamicData: false,
},
```

- [ ] **Step 4: Add explicit dataKeySources / propertyKeySources assertions**

Locate the per-case loop in `scripts/verify-js-script-info.mjs` (the loop iterating `CASES`). After the existing dataKeys / propertyKeys name-list assertions and the Task 1 structural source-validity loop, insert these two assertions:

```js
// Per-case explicit source map. Optional: if the case omits dataKeySources,
// skip this check (older cases that pre-date the source discriminator).
// When present, the assertion is exact-match — every dataKey name MUST
// appear in the expected map, and no extras allowed. This catches both
// "missed an entry" and "tagged with the wrong source" wiring bugs.
if (dataKeySources) {
  const actual = Object.fromEntries(result.dataKeys.map((k) => [k.name, k.source]));
  const expected = dataKeySources;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  assert(
    actualKeys.length === expectedKeys.length && actualKeys.every((k, i) => k === expectedKeys[i]),
    `${label}: dataKeySources key set expected [${expectedKeys.join(", ")}], got [${actualKeys.join(", ")}]`,
  );
  for (const name of actualKeys) {
    assert(
      actual[name] === expected[name],
      `${label}: dataKey "${name}" expected source ${JSON.stringify(expected[name])}, got ${JSON.stringify(actual[name])}`,
    );
  }
}
if (propertyKeySources) {
  const actual = Object.fromEntries(result.propertyKeys.map((k) => [k.name, k.source]));
  const expected = propertyKeySources;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  assert(
    actualKeys.length === expectedKeys.length && actualKeys.every((k, i) => k === expectedKeys[i]),
    `${label}: propertyKeySources key set expected [${expectedKeys.join(", ")}], got [${actualKeys.join(", ")}]`,
  );
  for (const name of actualKeys) {
    assert(
      actual[name] === expected[name],
      `${label}: propertyKey "${name}" expected source ${JSON.stringify(expected[name])}, got ${JSON.stringify(actual[name])}`,
    );
  }
}
```

Also update the case destructuring at the top of the loop to extract the two new fields. Find the existing line that destructures from each CASES entry (e.g. `const { label, source, hasDynamicMethods, methodNames, dataKeys, propertyKeys, hasDynamicData } = case_;`) and add `dataKeySources` and `propertyKeySources` to it.

- [ ] **Step 5: Run verify-js-script-info — all 18 new cases must PASS**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-js-script-info.mjs
```

Expected: `PASS\n\nAll <N> script-info cases match.\n` where N = (count after Task 1) + 18.

Failure triage:

- "Component setData inside lifetimes" / "pageLifetimes" / "observers" / "property observer" fails with empty dataKeys → the corresponding scope branch in Step 2's wiring is missing or has a typo. Re-read against the Owner-Context Scopes list.
- "Component nested regular function this.setData is ignored" fails because `ignored` appears in dataKeys → the boundary check in `walkOwnerFunctionForSetData` (Task 2 Step 2) isn't excluding `function_expression`. Verify the `node !== funcNode &&` clause is present so the root function still gets walked.
- "Component setData inside nested arrow (setTimeout) is extracted" fails with empty dataKeys → the boundary check is over-broad and excluding `arrow_function`. The boundary set must include ONLY `function_expression`, `function_declaration`, `method_definition`, `generator_function`, `generator_function_declaration` — NOT `arrow_function`.
- "Component setData dedup: data block wins on collision" reports `visible` with source `setData` → the dedup loop in Step 2 emits data-block entries first; setData entries skip names already in the set. Verify the `existingDataNames` Set is populated from `dataKeys` before the merge loop runs.
- "bare setData(...) without this. is ignored" reports `should_not_appear` in dataKeys → `setDataCallArgNode` (Task 2 Step 1) isn't enforcing `object.type !== "this"`. Add the check.
- "setData in module-level helper is ignored" reports `nope` in dataKeys → the walker is being called on something other than the Page/Component option-object scopes. Confirm Step 2's invocations only call `walkOwnerFunctionForSetData` from inside the `isPageOrComponentCall` branch.

- [ ] **Step 6: Commit**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add shared/js-method-extractor.mjs scripts/verify-js-script-info.mjs
git commit -m "$(cat <<'EOF'
feat: extract setData keys into template scope (Page/Component scopes)

Wires the setData walker (helpers landed in previous commit) across
every owner-context function body:

- Page: every top-level function-valued pair (lifecycle + user methods).
- Component: legacy top-level lifecycle + methods block + lifetimes /
  pageLifetimes / observers blocks + properties.<X>.observer descriptors.

Walker recurses into nested arrow_function bodies (lexical this) but
stops at function_expression / function_declaration / method_definition
/ generator_function / generator_function_declaration boundaries (those
rebind this — a setTimeout(function () { this.setData ... }) is NOT a
call on the component instance).

setData keys merge into dataKeys with source: "setData". Data block
declarations win on name collision. Non-object args, spread elements,
and computed keys still trigger hasDynamicData = true. Bare setData(...)
without this. and module-level helpers are intentionally not scanned.

Adds 18 synthetic test cases in verify-js-script-info covering all
scopes, edge cases, and the dedup rule. Each case explicitly declares
dataKeySources / propertyKeySources for exact-match source verification.
EOF
)"
```

---

## Task 4: Update existing fixtures + run umbrella verify

**Files:**
- Check: `fixtures/wasm-spike/sample-component.js` — has `this.setData({ selected: e.currentTarget.dataset.id })`. With Task 3 landed, `selected` will appear in dataKeys.
- Check: `fixtures/wasm-spike/js-methods-baseline.json` and other wasm-spike baselines — if they include dataKeys, they need updating.
- Run: `scripts/verify-tree-sitter.sh` umbrella to catch any drift.

- [ ] **Step 1: Verify whether any baseline includes dataKeys**

```bash
grep -lE '"dataKeys"|"propertyKeys"' /Users/zs/Desktop/study/wxml-zed/fixtures/wasm-spike/*.json
```

If output is empty: no baseline updates needed. Skip Step 2 and proceed to Step 3.

If output lists files: each must be updated. Run the relevant extractor against each fixture to regenerate the affected sections, hand-merge into the baseline JSON, and verify the regeneration is byte-stable on a second run.

- [ ] **Step 2: Regenerate baselines that include dataKeys (if any)**

If Step 1 listed any files, regenerate them:

```bash
cd /Users/zs/Desktop/study/wxml-zed
# Identify which script writes each baseline. For wasm-spike:
node scripts/extract-wxml-symbols.mjs fixtures/real-world/page.wxml fixtures/real-world/component.wxml fixtures/real-world/templates.wxml > /tmp/real-world-regen.json
# Compare against the existing baseline:
diff fixtures/wasm-spike/real-world-symbols-baseline.json /tmp/real-world-regen.json
# If the diff is purely additive (new setData-sourced entries appearing) and
# expected, replace the baseline:
# cp /tmp/real-world-regen.json fixtures/wasm-spike/real-world-symbols-baseline.json
```

For other baselines, run the script that produces them (read the top of each `verify-*.mjs` in scripts/ to identify which writes which baseline). DO NOT mass-overwrite without inspecting the diff.

- [ ] **Step 3: Run the umbrella verification**

```bash
cd /Users/zs/Desktop/study/wxml-zed
bash scripts/verify-tree-sitter.sh 2>&1 | tail -20
```

Expected final line: `wxml-zed tree-sitter verification passed`.

Failure modes:
- A wasm-symbol baseline diff catches a setData-introduced key. Re-run Step 2 for that specific fixture.
- `verify-lsp-diagnostics --suite graph-smoke` flakes — re-run; if it consistently fails, the wiring broke an existing test (most likely fixtures/miniprogram's home page). Read the failing test case and trace.

- [ ] **Step 4: Commit fixture + baseline updates (if any)**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git status   # confirm only fixture/baseline files changed
git add fixtures/wasm-spike/   # or specific files identified in Step 1
git commit -m "$(cat <<'EOF'
test: refresh wasm-spike baselines for setData-derived dataKeys

After the setData walker (previous commit), sample-component.js's
this.setData({ selected: ... }) call surfaces "selected" in the
extracted dataKeys with source: "setData". Baselines that snapshot
dataKeys are regenerated to reflect the new entries; behavior is
purely additive (no existing keys removed, no name changes).
EOF
)"
```

If Step 1 found no files to update, skip this commit step — Task 4 is a no-op pass-through and the umbrella verification in Step 3 is the only artifact.

---

## Task 5: Real-project dogfood diff on mp-wx-chelaile/wx + plan outcome notes

**Files:**
- Read: `/tmp/claude-501/wxml-zed-diagnostics/wx.summary.json` (the BEFORE snapshot from P2 audit — already on disk).
- Generate: a fresh AFTER dump under `/tmp/claude-501/wxml-zed-diagnostics/wx.summary.json` (overwrites the BEFORE snapshot — back it up first).
- Modify: this plan file — add an "Outcome" section.
- Modify: `docs/wasm-parser-spike-notes.md` — short follow-up entry.

- [ ] **Step 1: Snapshot the BEFORE state**

```bash
cp /tmp/claude-501/wxml-zed-diagnostics/wx.summary.json /tmp/claude-501/wxml-zed-diagnostics/wx.summary.before.json
cp /tmp/claude-501/wxml-zed-diagnostics/wx.summary.txt /tmp/claude-501/wxml-zed-diagnostics/wx.summary.before.txt
cp /tmp/claude-501/wxml-zed-diagnostics/wx.jsonl /tmp/claude-501/wxml-zed-diagnostics/wx.jsonl.before
```

These three files are the BEFORE baseline. Acceptance criteria below compare against them.

- [ ] **Step 2: Run the dump tool against chelaile post-fix**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/dump-project-diagnostics.mjs /Users/zs/Desktop/zs_work/mp-wx-chelaile/wx
```

Expected: the stdout summary shows a substantially reduced expression-ref count.

- [ ] **Step 3: Verify acceptance criteria**

Read both summary.json files and confirm:

```bash
cd /tmp/claude-501/wxml-zed-diagnostics
node -e '
const before = JSON.parse(require("fs").readFileSync("wx.summary.before.json"));
const after  = JSON.parse(require("fs").readFileSync("wx.summary.json"));
console.log("=== BEFORE ===");
console.log("  total:", before.total);
console.log("  byCode:", JSON.stringify(before.byCode));
console.log("=== AFTER ===");
console.log("  total:", after.total);
console.log("  byCode:", JSON.stringify(after.byCode));
console.log("=== ACCEPTANCE CHECKS ===");
// 1. Event-handler stays at 7 (precision regression lock).
const beforeEvt = before.byCode["missing-event-handler"] || 0;
const afterEvt  = after.byCode["missing-event-handler"]  || 0;
console.log(`  missing-event-handler: ${beforeEvt} -> ${afterEvt} (must equal)`);
if (beforeEvt !== afterEvt) { console.log("  ❌ FAIL"); process.exit(1); }
console.log("  ✅ event-handler count preserved");
// 2. Specific setData-derived names previously dominant must drop to 0.
const targets = ["load_state","load_states","LINE_STATE","describe","time","tag","tagList","physicalDistance","logicDistance","inTargetRange"];
const beforeNames = before.byName["missing-expression-ref"] || {};
const afterNames  = after.byName["missing-expression-ref"]  || {};
let ok = true;
for (const n of targets) {
  const b = beforeNames[n] || 0;
  const a = afterNames[n]  || 0;
  const pass = a === 0;
  console.log(`  ${n}: ${b} -> ${a}  ${pass ? "✅" : "❌"}`);
  if (!pass) ok = false;
}
if (!ok) { console.log("  ❌ FAIL"); process.exit(1); }
console.log("  ✅ all setData-derived dominant names cleared");
// 3. Informational: total drop.
console.log(`  TOTAL: ${before.total} -> ${after.total}`);
'
```

Expected output: every check is `✅`. If any `❌` appears, do NOT proceed — investigate which scope the walker missed.

Common failure modes:

- A target name stayed nonzero → the file where it occurs has its setData call in a scope the walker doesn't cover. Re-read `Owner-Context Scopes` list against the actual JS file (use `dump-project-diagnostics` JSONL to find file paths).
- event-handler count changed → a new diagnostic appeared from baseline drift. Inspect `diff <(grep '"code":"missing-event-handler"' wx.jsonl.before) <(grep '"code":"missing-event-handler"' wx.jsonl)`.

- [ ] **Step 4: Stratified-sample 10 surviving expression-ref entries**

Each must be either (a) a real bug, or (b) a category the next P2 round can address:

```bash
cd /tmp/claude-501/wxml-zed-diagnostics
grep '"code":"missing-expression-ref"' wx.jsonl | shuf -n 10 | while read line; do
  echo "$line" | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(`\n${d.file}:${d.line+1}  name=${d.name}`);
    for (const s of d.snippet) console.log(`  ${s.marker} ${s.line+1}: ${s.source.slice(0, 200)}`);
  '
done
```

For each surviving sample, read the corresponding JS and write a one-line classification into this plan's Outcome section: real bug, cross-component prop scope edge case, template-fragment data inheritance, or other named bucket. Do NOT silently dismiss surviving entries — they shape the next P2 round.

- [ ] **Step 5: Write the Outcome section into this plan**

Append the following section to `docs/superpowers/plans/2026-05-21-setdata-key-extraction.md` (after the existing `## Owner-Context Scopes` / decision sections, before the task list — actually, since the task list is the document, append at very end):

```markdown
## Outcome (filled in at Task 5 completion)

Before / after on `mp-wx-chelaile/wx` (chelaile @ <commit-hash>, dirty count <N>):

| metric | before | after |
|---|---|---|
| total | 220 | <N> |
| missing-event-handler | 7 | <N> |
| missing-expression-ref | 213 | <N> |
| missing-local-component | 0 | <N> |

Dominant setData-derived names (target: → 0):

| name | before | after |
|---|---|---|
| load_state | 13 | <N> |
| load_states | 11 | <N> |
| LINE_STATE | 6 | <N> |
| describe | 6 | <N> |
| time | 9 | <N> |
| tag | 7 | <N> |
| tagList | 7 | <N> |
| physicalDistance | 9 | <N> |
| logicDistance | 6 | <N> |
| inTargetRange | 9 | <N> |

Surviving expression-ref classification (10-sample random):

- `<file>:<line>` (name=`<x>`) — <bucket>: <one-line reason>
- ... (10 entries)

Buckets observed (next-P2 input):
- <bucket-A>: <count from sample>
- <bucket-B>: ...
```

Replace each `<N>` with the actual number from Step 3 output, and fill in the 10-sample lines from Step 4 verbatim. If a bucket appears repeatedly, that's the input for the next P2 round.

- [ ] **Step 6: Append a follow-up note to `docs/wasm-parser-spike-notes.md`**

After the existing "Follow-up: in-flight overlay task invalidation" section (which ends with `---` separator), append:

```markdown
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
helpers are intentionally not scanned.

Outcome on the same chelaile snapshot: 220 → <N> diagnostics. The 7
`missing-event-handler` diagnostics (all real bugs in the project)
were preserved unchanged; expression-ref count dropped from 213 to
<M>. See plan's Outcome section for the 10-sample surviving-noise
classification that scopes the next P2 round.

---
```

(Replace `<N>` and `<M>` with the actual numbers from Step 3.)

- [ ] **Step 7: Commit outcome notes**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add docs/superpowers/plans/2026-05-21-setdata-key-extraction.md docs/wasm-parser-spike-notes.md
git commit -m "$(cat <<'EOF'
docs: record setData walker dogfood outcome on mp-wx-chelaile/wx

Captures the before/after diagnostic counts after the setData key
extractor lands. missing-event-handler stays at 7 (real bugs in
the project, unchanged precision); missing-expression-ref drops
from 213 to <M>. Dominant setData-derived names (load_state,
LINE_STATE, describe, time, tag, etc.) cleared to zero. Surviving
expression-ref sample (10 random) classified into buckets to scope
the next P2 round.
EOF
)"
```

---

## Acceptance Criteria

These are absolute pass/fail gates. They do NOT include a target reduction number — the goal is high-precision noise elimination, not hitting an arbitrary digit.

1. **All cases in `scripts/verify-js-script-info.mjs` pass.** Includes the 18 new Task 3 cases: 4 Page-scope, 6 Component scope variants, 2 nested-function behavior, and 6 edge / dynamic cases.
2. **`bash scripts/verify-tree-sitter.sh` umbrella passes.** Captures the LSP graph-smoke suite (including the P1 overlay regression locks) and all baseline-snapshot verifications.
3. **`missing-event-handler` count on mp-wx-chelaile/wx is unchanged (7 → 7).** This is the precision regression lock — the walker MUST NOT affect event-handler diagnostics.
4. **Every direct-literal setData-derived dominant name drops to 0**: `LINE_STATE`, `describe`, `time`, `tag`, `tagList`, `physicalDistance`, `logicDistance`, `inTargetRange`. These are exactly the names whose pre-fix occurrences traced back to literal `this.setData({ <name>: ... })` calls in owner-context scopes the walker handles; survivors here indicate the walker missed a scope.

   Two pre-fix-top-10 names — `load_state` and `load_states` — are explicitly EXEMPT from the absolute-zero gate. They come from a helper-class pattern (`new LoadStates('load').applyTo(this)` where keys are constructed via string concat + spread inside a helper class), which the plan declared Out of Scope for this round. Their partial drops are tracked in the Outcome section as the seed for a separate P2.2 plan.
5. **10 random surviving expression-ref entries are classified, not dismissed.** Each must be either a real bug or a named category for the next P2 round (cross-component prop scope, template fragment data inheritance, etc.).

## Out of Scope (deferred)

- **Behavior-injected data keys.** WeChat behaviors mixin `data:` into their host components. We already set `hasDynamicData = true` whenever non-empty `behaviors:` array appears, which is the safe fallback. Following behavior chains would require multi-file resolution and is its own plan.
- **TypeScript siblings.** `.ts` files defining `Component({ ... })` still don't parse — needs `tree-sitter-typescript.wasm` build (separate plan).
- **setData in helper modules.** If a component imports a `setStateHelper(this, {...})` utility, those keys won't be extracted. Real-world impact is small; if dogfood surfaces this as a category in Task 5 Step 4, it becomes the next P2 round's target.
- **Quick-fix code actions** (e.g., "add this key to data block"). Source field is preserved for this future feature, but the action itself is out of scope.

## Self-Review

- All file paths absolute and resolve to real locations.
- All synthetic test cases include exact source strings.
- All assertion strings include the failure message verbatim.
- `setDataCallArgNode` / `extractSetDataKeysFromCall` / `walkOwnerFunctionForSetData` / `functionValuedPairs` / `namedObjectBlock` / `propertyObservers` names consistent across all tasks.
- Task 1's structural assertion change is wired into the existing per-case loop in verify-js-script-info, not a separate block.
- Task 2 commits **helpers only** — no failing tests in history. Helpers are unwired dead code at that commit; Task 3 lands wiring + tests in a single green commit. This preserves bisect-friendliness.
- Task 3's wiring respects the dedup rule (data-block-first emission order) per the Dedup Rule section.
- Task 3 cases use **explicit `dataKeySources` / `propertyKeySources` maps**, NOT a regex on source text. Per-case assertion is exact-match on the source map; older cases that omit the maps fall back to the Task 1 structural validity check.
- Task 4 handles the empty-baseline-list case (no commit if nothing changed).
- Task 5's acceptance script exits non-zero on any check failure (gates further work).
- `source` field values are exactly `"data"`, `"property"`, `"setData"` — three literals, used identically in extractor emission and assertion check.
- Walker recursion stops at `function_expression` / `function_declaration` / `method_definition` / `generator_function` / `generator_function_declaration` boundaries (those rebind `this`); descends into `arrow_function` (lexical `this`). Root `funcNode` itself is always entered (the `node !== funcNode &&` guard).
- Bare `setData(...)` without `this.` is explicitly rejected by `setDataCallArgNode`'s `object.type !== "this"` check.
- Module-level `function helper() { this.setData(...) }` is excluded because the walker is only called from inside the Page/Component option-object visit — there's no entry point to walk module-level functions.
- 18 new cases in Task 3 Step 3: 4 Page-scope (static / shorthand / quoted / computed-key) + 6 Component scope variants (methods / lifetimes / pageLifetimes / observers / property-observer / legacy-top-level) + 2 nested-function behavior (arrow descends / regular function stops) + 6 edge cases (spread / non-object / empty / dedup / bare-without-this / module-level helper) = 18 ✓

## Outcome

Before / after on `mp-wx-chelaile/wx` (chelaile @ 0c21dc53048274eabdff4d115b953e56efc66b33, dirty count 6):

| metric | before | after |
|---|---|---|
| total | 220 | 26 |
| missing-event-handler | 7 | 7 |
| missing-expression-ref | 213 | 19 |
| missing-local-component | 0 | 0 |

Net: 88% diagnostic reduction. `missing-event-handler` precision preserved (all 7 are real bugs in the project: typo'd handler names, handlers defined on the wrong file).

### Dominant setData-derived names: target → result

| name | before | after | status |
|---|---|---|---|
| LINE_STATE | 6 | 0 | cleared |
| describe | 6 | 0 | cleared |
| time | 9 | 0 | cleared |
| tag | 7 | 0 | cleared |
| tagList | 7 | 0 | cleared |
| physicalDistance | 9 | 0 | cleared |
| logicDistance | 6 | 0 | cleared |
| inTargetRange | 9 | 0 | cleared |
| load_state | 13 | 4 | partial — helper-mediated |
| load_states | 11 | 4 | partial — helper-mediated |

### Why load_state / load_states didn't fully clear

The 8 surviving entries (4 files × 2 names) all originate from a project-internal helper class at `pages/components/states-view/States.js`:

```js
class States {
  constructor(name) {
    this.stateName  = name + '_state';   // computed at runtime
    this.statesName = name + '_states';
  }
  applyTo(page) { page.setData({ ...this.state() }); }  // spread of computed-key obj
}
```

Pages instantiate as `new LoadStates('load', LOAD_STATES.LOADING).applyTo(this)`. The final keys (`load_state`, `load_states`) are constructed via string concatenation inside the helper class, then merged into `page.setData(...)` via spread of a computed-key object. All three (helper indirection, computed key, spread) are explicitly Out of Scope per the plan's Out of Scope section; the walker correctly sets `hasDynamicData = true` for these files but cannot enumerate the specific keys.

Catching this would require following `applyTo(this)` / similar cross-method patterns and tracking constructor-arg-derived keys — a cross-function/class data flow analysis significantly larger than the static-literal-key extractor in this round. Deferred to a separate P2.2 plan.

Affected files (8 entries):
- `pages/main/fav-page/index.wxml` (2)
- `pages/my-fav/index.wxml` (2)
- `pages/metro-line/index.wxml` (2)
- `pages/metro-station/index.wxml` (2)

### Surviving expression-ref classification (10-sample random)

Seeded shuffle (mulberry32, seed=42) over the 19 surviving `missing-expression-ref` entries:

- `pages/my-fav/index.wxml:0` (name=`load_state`) — library-mediated computed/spread setData: derived from `States` helper class `applyTo(this)` pattern, key built via string concat in constructor + spread on `page.setData`.
- `pages/main/fav-page/index.wxml:2` (name=`load_state`) — library-mediated computed/spread setData: same `States` helper pattern as above.
- `pages/metro-station/index.wxml:3` (name=`load_states`) — library-mediated computed/spread setData: same `States` helper pattern (companion key from same instance).
- `pages/my-fav/index.wxml:8` (name=`locationError`) — cross-component prop pass-through: `<local-bar locationError="{{locationError}}"/>` references a parent-page identifier that is never declared/set on the my-fav page itself; `local-bar` declares `locationError` as a `Component({ properties })` field. Dead pass-through binding (always resolves to `undefined` at runtime; child uses its property default).
- `ad/components/taro-weapp/comp.wxml:2` (name=`i`) — template-fragment scope (Taro compiled artifact): `comp.wxml` is a Taro-emitted file whose `<template is="...">` invocation expects `i` to come from the parent `<template name="taro_tmpl">`/`tmpl_0_*` template-data scope in `base.wxml`. Names defined inside a sibling `<template name>`'s data passing, not in page/component data.
- `pages/fullscreen-map/index.wxml:3` (name=`popupLevel`) — cross-component prop pass-through: `<map-btn popupLevel="{{popupLevel}}"/>` references a parent identifier not declared on the fullscreen-map page; `map-btn` declares `popupLevel` as its own property.
- `pages/main/fav-page/index.wxml:2` (name=`load_state`) — library-mediated computed/spread setData: same `States` helper pattern (second occurrence on the same line — class binding).
- `pages/stop-detail/components/my-map/index.wxml:7` (name=`locationError`) — cross-component prop pass-through: `<local-bar locationError="{{locationError}}"/>` on a component that does not itself declare `locationError` in its `properties`/`data`.
- `pages/my-fav/index.wxml:0` (name=`load_state`) — library-mediated computed/spread setData: same `States` helper pattern (second occurrence on the same line).
- `pages/main/fav-page/index.wxml:2` (name=`load_states`) — library-mediated computed/spread setData: same `States` helper pattern.

### Buckets observed (next-P2 input)

- library-mediated computed/spread setData: 6
- cross-component prop pass-through (parent never declares the name): 3
- template-fragment scope (Taro compiled artifact): 1

The library-mediated category dominates the 19 surviving entries and is the natural target for P2.2. Cross-component prop pass-through is a secondary candidate — these are real "dead bindings" in the project (the binding resolves to `undefined` at runtime, and the child component falls back to its property default), so they are either latent bugs or intentional no-ops. A future scope-aware analysis could classify or suppress them per-component.
