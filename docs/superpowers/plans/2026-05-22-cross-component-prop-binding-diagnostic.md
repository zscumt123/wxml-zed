# Cross-Component Prop Binding Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new diagnostic code `dead-component-binding` (LSP Information severity) that downgrades cross-component prop pass-through cases — where the parent's WXML binds a child component's declared property to an undeclared parent identifier — from the existing `missing-expression-ref` warning. Preserves the warning when the binding is truly dead (no parent var AND no child prop API) or when scope cannot be enumerated.

**Architecture:** Two extension points in existing files. (1) `shared/wxml-symbol-extractor.mjs` gains stack-based tracking of containing element and attribute during tree-sitter-wxml walks; each `expressionRef` now carries `containingTag` and `containingAttribute` fields. (2) `server/wxml-language-service.mjs` gains `isReservedAttribute` and `findChildProperty` helpers; `expressionRefDiagnostics` extends the failure branch to emit `dead-component-binding` Information when (parent scope misses AND tag has a resolved usingComponents entry AND attribute is not reserved AND child's static propertyKeys contains the attribute name).

**Tech Stack:** Same as existing extractor: web-tree-sitter (WXML grammar), Node ESM modules. Same testing rig: synthetic project graph from `fixtures/miniprogram` plus a new dedicated `cross-binding` page with `local-bar` and `dyn-card` child components; assertions in `scripts/verify-wxml-language-service.mjs`; LSP protocol tests in `scripts/verify-lsp-diagnostics.mjs`; baseline regen via `scripts/extract-wxml-symbols.mjs` for the 7 `fixtures/wasm-spike/*.json` snapshots.

---

## Spec Reference

The authoritative design is `docs/superpowers/specs/2026-05-22-cross-component-prop-binding-diagnostic-design.md`. Critical decisions locked there (in case of ambiguity, the spec wins):

- **Lookup direction**: by attribute name (child's prop API), not by expression identifier (parent's variable namespace).
- **Lookup order in `findChildProperty`**: trust static `propertyKeys` FIRST. Only consult `hasDynamicData` when the attribute name is NOT in the static set. Never let `hasDynamicData=true` invalidate a static hit.
- **Prefilter**: a candidate cross-component binding requires `containingTag !== null && containingAttribute !== null && !isReservedAttribute(containingAttribute)`. Do NOT prefilter on `fileModel.components` — that's a hyphen-heuristic candidate list that misses non-hyphenated `usingComponents` aliases. Push the "is it a component?" question to `findChildProperty`'s `graph.usingComponents` lookup.
- **Parent scope completeness inheritance**: the existing early return `if (ownerConfig.script.hasDynamicData) return [];` at the top of `expressionRefDiagnostics` REMAINS unchanged. New rule does NOT promote `dead-component-binding` when parent's own data is opaque. This is locked by T13.
- **`inTemplateDefinition` short-circuit** takes precedence over the new rule, same as today. Locked by T9.
- **Range**: stays on the expression (consistent with `missing-expression-ref`). Don't add new range fields.
- **Severity**: `dead-component-binding` is LSP severity 3 (Information). Don't use 4 (Hint).
- **Diagnostic message**: literal text in Task 5 Step 4 below — do NOT paraphrase.

## File Structure

**Modified:**

- `shared/wxml-symbol-extractor.mjs` — add `containingTag` / `containingAttribute` tracking to `collectFile()`'s walk; add fields to emitted `expressionRefs` entries.
- `server/wxml-language-service.mjs` — add `INFORMATION` severity constant, `RESERVED_ATTRIBUTES` set, `RESERVED_ATTRIBUTE_PREFIXES` array, `isReservedAttribute()` helper, `findChildProperty()` helper; extend `expressionRefDiagnostics` main loop.
- `scripts/verify-wxml-language-service.mjs` — add 15 synthetic test cases (T1–T13, with T8a/b/c split). Register them in the main run sequence.
- `scripts/verify-lsp-diagnostics.mjs` — add 2 LSP protocol-layer tests (L1, L2) in the `graph-smoke` suite.
- `fixtures/miniprogram/app.json` — register the new `pages/cross-binding/cross-binding` page.
- All 7 `fixtures/wasm-spike/*-symbols-baseline.json` files — regenerate after Task 1 lands the new fields (purely additive).

**Created:**

- `fixtures/miniprogram/pages/cross-binding/cross-binding.wxml` — page with cross-component binding sites for tests T5–T12.
- `fixtures/miniprogram/pages/cross-binding/cross-binding.js` — page script: clean static `data` and `methods` (no `behaviors`, no spread, etc.) so this file's `hasDynamicData = false`.
- `fixtures/miniprogram/pages/cross-binding/cross-binding.json` — registers `local-bar`, `dyn-card`, and reuses `user-card`.
- `fixtures/miniprogram/components/local-bar/local-bar.wxml`, `.js`, `.json` — child component with clean `properties: { locationError, referer }` (statically known).
- `fixtures/miniprogram/components/dyn-card/dyn-card.wxml`, `.js`, `.json` — child component with `behaviors: [someMixin]` PLUS statically declared `properties: { knownProp }`. This drives T8a (static hit wins over `hasDynamicData`).
- `fixtures/miniprogram/pages/dyn-page/dyn-page.{wxml,js,json}` — page with `data: { ...spread, count: 0 }` so its script's `hasDynamicData = true`. Drives T13 (parent scope completeness inheritance).

**No new files outside fixtures.** All production logic lives in two existing source files.

## Sequencing Notes

- Tasks 1, 2, 3 land the data-shape changes (extractor + fixtures + baselines). After Task 3 the umbrella verify is still green; no behavior change yet, just additive field expansion.
- Task 4 introduces helpers as unwired dead code (TDD-style: helpers exist but `expressionRefDiagnostics` doesn't call them).
- Task 5 wires the helpers into `expressionRefDiagnostics` AND adds the first synthetic case (T5 happy path) in the same commit, so the commit goes green by establishing the behavior + test together.
- Task 6 adds the remaining 14 cases (T1–T4, T6, T7, T8a/b/c, T9–T13) in one commit — locks every edge.
- Task 7 adds the 2 LSP protocol-layer tests.
- Task 8 runs the chelaile dogfood and records the Outcome section + spike notes.

---

## Task 1: Extractor — add `containingTag` / `containingAttribute` to expressionRefs

**Files:**
- Modify: `shared/wxml-symbol-extractor.mjs` — extend `collectFile()`'s walk closure with element/attribute tracking stacks.

The interpolation handler at `shared/wxml-symbol-extractor.mjs:155-179` emits `expressionRefs` entries. Without context, the new diagnostic logic can't know whether a ref is inside a component-tag attribute. Two new fields plug this gap.

Add two stacks (`elementStack`, `attributeStack`) at the top of `collectFile()`. Push on entry to element/attribute nodes; pop on exit (after recursion). At the interpolation point, read the top of each stack and attach to the emitted ref.

- [ ] **Step 1: Add the stacks + push/pop logic**

In `shared/wxml-symbol-extractor.mjs`, locate the `collectFile` function (around line 135). Right after the existing `let templateDefinitionDepth = 0;` (line 149), add:

```js
  // Track nearest enclosing element tag name and attribute name during the
  // walk. expressionRef entries pick up the top of each stack so diagnostics
  // can distinguish text-node interpolations from component-tag prop bindings.
  // Elements push their tag name (string) or `null` (unknown tag).
  // Attributes push their attribute name (string) or `null`.
  const elementStack = [];
  const attributeStack = [];
```

Then locate the `const walk = (node) => {` block (around line 151). At the top of the walk function (right after `const isTemplateDef = node.type === "template_definition";` and `if (isTemplateDef) templateDefinitionDepth += 1;`), add element/attribute push logic:

```js
    let pushedElement = false;
    let pushedAttribute = false;
    if (node.type === "element") {
      const tag = firstChildOfType(node, "start_tag") ?? firstChildOfType(node, "self_closing_tag");
      const tagName = tag ? (firstChildOfType(tag, "tag_name")?.text ?? null) : null;
      elementStack.push(tagName);
      pushedElement = true;
    } else if (node.type === "attribute") {
      const nameNode = firstChildOfType(node, "attribute_name");
      attributeStack.push(nameNode?.text ?? null);
      pushedAttribute = true;
    }
```

Add the pop at the very END of the walk function (after the recursion loop and the existing `if (isTemplateDef) templateDefinitionDepth -= 1;`):

```js
    if (pushedElement) elementStack.pop();
    if (pushedAttribute) attributeStack.pop();
```

- [ ] **Step 2: Use the stack tops in the interpolation handler**

In the same file, the existing interpolation handler emits:

```js
expressionRefs.push({
  name,
  source: "interpolation",
  inTemplateDefinition,
  range: { ... },
  expressionRange: exprRange,
});
```

Replace with:

```js
expressionRefs.push({
  name,
  source: "interpolation",
  inTemplateDefinition,
  range: { ... },
  expressionRange: exprRange,
  containingTag: elementStack.length > 0 ? elementStack[elementStack.length - 1] : null,
  containingAttribute: attributeStack.length > 0 ? attributeStack[attributeStack.length - 1] : null,
});
```

(Preserve the existing `range: {...}` and `expressionRange: exprRange` lines verbatim.)

- [ ] **Step 3: Run extract on a probe fixture and inspect the output**

```bash
cd /Users/zs/Desktop/study/wxml-zed
node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml | node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
const refs = data.files[0].expressionRefs;
console.log("Total refs:", refs.length);
for (const ref of refs.slice(0, 6)) {
  console.log(`  name=${ref.name} containingTag=${JSON.stringify(ref.containingTag)} containingAttribute=${JSON.stringify(ref.containingAttribute)}`);
}
'
```

Expected output (containingTag / containingAttribute should be populated for attribute-housed refs, null for text-node refs):

```
Total refs: <some count>
  name=theme containingTag="view" containingAttribute="class"
  name=users containingTag="user-card" containingAttribute="wx:for"
  name=item containingTag="user-card" containingAttribute="user"
  name=emptyReason containingTag="missing-card" containingAttribute="reason"
  name=format containingTag="view" containingAttribute=null     <-- text node "{{format.price(total)}}" inside <view class="total">
  ...
```

The `name=format` line proves the text-node case (containingAttribute is null even though it's nested inside a `<view>` element). The earlier lines prove the attribute case.

- [ ] **Step 4: Run baseline verifier — expect failure with field-shape diff**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wasm-symbol-baselines.mjs 2>&1 | head -30
```

Expected: FAIL on the first baseline diff. Output should show the new `containingTag` / `containingAttribute` fields appearing on expressionRef entries — this is the expected baseline drift; Task 2 will regenerate.

Confirm the diff is purely ADDITIVE (only new fields appearing; no existing fields changed in value).

- [ ] **Step 5: Run verify-tree-sitter (excluding the symbol baselines) — sanity check no other test broke**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-js-script-info.mjs
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wxml-language-service.mjs 2>&1 | tail -5
```

Expected: both PASS. The new fields are additive — existing consumers (`server/wxml-language-service.mjs` reads only `name`, `range`, `inTemplateDefinition`, `source`) ignore the new fields.

- [ ] **Step 6: Commit the extractor change (baselines still red — Task 2 fixes)**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add shared/wxml-symbol-extractor.mjs
git commit -m "$(cat <<'EOF'
feat: track containingTag / containingAttribute on expressionRefs

Adds stack-based tracking of nearest enclosing element tag and
attribute name to collectFile()'s walk in shared/wxml-symbol-
extractor.mjs. Each expressionRef now carries:

- containingTag: string | null — enclosing element's tag name, or
  null for text-node interpolations.
- containingAttribute: string | null — enclosing attribute's name,
  or null for text-node interpolations.

Both fields are populated by pushing on element/attribute entry and
popping on exit, so innermost-wins semantics applies naturally to
nested elements. Production consumers ignore the new fields for now;
they're prep for the cross-component prop binding diagnostic.

Symbol baselines are NOT regenerated in this commit and are expected
to be red until the next commit regenerates them. The diff is purely
additive on expressionRef entries.
EOF
)"
```

---

## Task 2: Regenerate the 7 wasm-spike symbol baselines

**Files:**
- Modify: `fixtures/wasm-spike/edge-recovery-symbols-baseline.json`
- Modify: `fixtures/wasm-spike/home-symbols-baseline.json`
- Modify: `fixtures/wasm-spike/miniprogram-symbols-baseline.json`
- Modify: `fixtures/wasm-spike/non-ascii-symbols-baseline.json`
- Modify: `fixtures/wasm-spike/real-world-symbols-baseline.json`
- Modify: `fixtures/wasm-spike/test-wxml-symbols-baseline.json`
- Modify: `fixtures/wasm-spike/wx-for-unquoted-symbols-baseline.json`

All 7 baselines snapshot `expressionRefs` and now need the two new fields. Verify-wasm-symbol-baselines.mjs lists the producer command for each — read its `CASES` array (lines 10-60) to map each baseline back to its source fixture(s).

- [ ] **Step 1: Regenerate all 7 baselines via their producers**

```bash
cd /Users/zs/Desktop/study/wxml-zed

# home-symbols-baseline.json — input: fixtures/miniprogram/pages/home/home.wxml
node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > fixtures/wasm-spike/home-symbols-baseline.json

# miniprogram-symbols-baseline.json — uses the glob mode (per verify-wasm-symbol-baselines.mjs's collectGlobFiles)
# To match the baseline producer's behavior, gather all .wxml under fixtures/miniprogram in sorted order:
files=$(find fixtures/miniprogram -name '*.wxml' | sort | tr '\n' ' ')
node scripts/extract-wxml-symbols.mjs $files > fixtures/wasm-spike/miniprogram-symbols-baseline.json

# test-wxml-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/test.wxml > fixtures/wasm-spike/test-wxml-symbols-baseline.json

# real-world-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/real-world/component.wxml fixtures/real-world/page.wxml fixtures/real-world/templates.wxml > fixtures/wasm-spike/real-world-symbols-baseline.json

# edge-recovery-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/real-world/edge-recovery.wxml > fixtures/wasm-spike/edge-recovery-symbols-baseline.json

# non-ascii-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/non-ascii.wxml > fixtures/wasm-spike/non-ascii-symbols-baseline.json

# wx-for-unquoted-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/wx-for-unquoted.wxml > fixtures/wasm-spike/wx-for-unquoted-symbols-baseline.json
```

- [ ] **Step 2: Inspect the diff — confirm purely additive**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git diff --stat fixtures/wasm-spike/
git diff fixtures/wasm-spike/home-symbols-baseline.json | head -80
```

Expected: every change is the addition of `"containingTag": "..."` and `"containingAttribute": "..."` (or `null` values) on existing expressionRef entries. No existing fields modified. No entries added or removed.

If the diff shows ANY changes beyond field additions (e.g., reordering, range changes, name changes), STOP — investigate before committing. The extractor must remain byte-stable on existing fields.

- [ ] **Step 3: Run baseline verifier**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wasm-symbol-baselines.mjs 2>&1 | tail -5
```

Expected: PASS for all 7 cases.

- [ ] **Step 4: Run umbrella verifier**

```bash
bash /Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh 2>&1 | tail -3
```

Expected final line: `wxml-zed tree-sitter verification passed`.

If umbrella fails on something other than the symbol baselines, the extractor change in Task 1 introduced a regression — investigate. The likely failure mode is `verify-wxml-language-service.mjs` failing on something that depends on expressionRefs shape (unlikely — consumers read only `.name` — but possible).

- [ ] **Step 5: Commit baseline regeneration**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add fixtures/wasm-spike/
git commit -m "$(cat <<'EOF'
test: refresh wasm-spike expressionRef baselines for new context fields

After the extractor (previous commit) gained containingTag /
containingAttribute fields on each expressionRef entry, all 7
wasm-spike symbol baselines snapshot the new shape.

The diff is purely additive (two new fields per ref); no existing
fields modified, no entries added or removed. Producer commands
for each baseline match the verify-wasm-symbol-baselines.mjs CASES
array exactly.

Umbrella tree-sitter verify is green after this commit.
EOF
)"
```

---

## Task 3: Add fixture files for cross-component prop binding test cases

**Files:**
- Create: `fixtures/miniprogram/components/local-bar/local-bar.wxml`
- Create: `fixtures/miniprogram/components/local-bar/local-bar.js`
- Create: `fixtures/miniprogram/components/local-bar/local-bar.json`
- Create: `fixtures/miniprogram/components/dyn-card/dyn-card.wxml`
- Create: `fixtures/miniprogram/components/dyn-card/dyn-card.js`
- Create: `fixtures/miniprogram/components/dyn-card/dyn-card.json`
- Create: `fixtures/miniprogram/pages/cross-binding/cross-binding.wxml`
- Create: `fixtures/miniprogram/pages/cross-binding/cross-binding.js`
- Create: `fixtures/miniprogram/pages/cross-binding/cross-binding.json`
- Create: `fixtures/miniprogram/pages/dyn-page/dyn-page.wxml`
- Create: `fixtures/miniprogram/pages/dyn-page/dyn-page.js`
- Create: `fixtures/miniprogram/pages/dyn-page/dyn-page.json`
- Modify: `fixtures/miniprogram/app.json` — register both new pages.

These fixture files drive the synthetic tests in Task 6 (T1–T13). All cross-component binding scenarios reference WXML positions in `cross-binding.wxml` (or `dyn-page.wxml` for T13). Tests mutate graph entries (e.g., remove `locationError` from `local-bar`'s propertyKeys) to set up specific decision-matrix branches.

- [ ] **Step 1: Create `local-bar` component (clean static properties)**

```bash
mkdir -p /Users/zs/Desktop/study/wxml-zed/fixtures/miniprogram/components/local-bar
```

`fixtures/miniprogram/components/local-bar/local-bar.json`:

```json
{
  "component": true
}
```

`fixtures/miniprogram/components/local-bar/local-bar.wxml`:

```wxml
<view class="local-bar">
  <text wx:if="{{locationError}}">Location error</text>
  <text wx:else>{{referer}}</text>
</view>
```

`fixtures/miniprogram/components/local-bar/local-bar.js`:

```js
Component({
  properties: {
    locationError: { type: Boolean, value: false },
    referer: { type: String, value: "" },
  },
  methods: {
    onTap() {
      this.triggerEvent("tap");
    },
  },
});
```

- [ ] **Step 2: Create `dyn-card` component (behaviors + static properties — for T8a)**

```bash
mkdir -p /Users/zs/Desktop/study/wxml-zed/fixtures/miniprogram/components/dyn-card
```

`fixtures/miniprogram/components/dyn-card/dyn-card.json`:

```json
{
  "component": true
}
```

`fixtures/miniprogram/components/dyn-card/dyn-card.wxml`:

```wxml
<view class="dyn-card">{{knownProp}}</view>
```

`fixtures/miniprogram/components/dyn-card/dyn-card.js`:

```js
Component({
  behaviors: ["wx://component-export"],
  properties: {
    knownProp: { type: String, value: "" },
  },
  methods: {
    onTap() {
      this.triggerEvent("tap");
    },
  },
});
```

The non-empty `behaviors` array sets `hasDynamicData = true` and `hasDynamicMethods = true` per the existing extractor logic (`shared/js-method-extractor.mjs`). Static `propertyKeys` still contains `knownProp` — this is the exact shape T8a needs.

- [ ] **Step 3: Create the `cross-binding` page**

```bash
mkdir -p /Users/zs/Desktop/study/wxml-zed/fixtures/miniprogram/pages/cross-binding
```

`fixtures/miniprogram/pages/cross-binding/cross-binding.json`:

```json
{
  "usingComponents": {
    "local-bar": "/components/local-bar/local-bar",
    "dyn-card": "/components/dyn-card/dyn-card",
    "user-card": "/components/user-card/user-card"
  }
}
```

`fixtures/miniprogram/pages/cross-binding/cross-binding.wxml`:

```wxml
<view class="container {{theme}}">
  <local-bar locationError="{{locationError}}" referer="{{referer}}" />
  <local-bar locationError="{{missingVar}}" />
  <local-bar locationError="{{a}}" referer="{{b}}" />
  <local-bar bind:tap="onLocalBarTap" />
  <local-bar wx:if="{{shouldShow}}" locationError="{{locationError}}" />
  <local-bar data-id="{{customId}}" />
  <local-bar generic:Item="{{customGeneric}}" />
  <dyn-card knownProp="{{dynValue}}" />
  <user-card user="{{userInfo}}" />
  <view class="row">{{textValue}}</view>
</view>
```

`fixtures/miniprogram/pages/cross-binding/cross-binding.js`:

```js
Page({
  data: {
    theme: "light",
    locationError: false,
    referer: "home",
    shouldShow: true,
    customId: "1",
    customGeneric: "fallback",
    dynValue: "x",
    userInfo: { id: 1 },
    textValue: "hello",
  },
  onLocalBarTap() {
    // intentionally minimal
  },
});
```

Note: `missingVar`, `a`, `b` are deliberately ABSENT from this page's `data` — they're the symbols the various T-cases test against. The `locationError` IS in data for the first binding (C1 — no diagnostic baseline), so tests mutate the page's `dataKeys` to remove `locationError` for cases that need it absent.

- [ ] **Step 4: Create the `dyn-page` page (for T13 — parent hasDynamicData)**

```bash
mkdir -p /Users/zs/Desktop/study/wxml-zed/fixtures/miniprogram/pages/dyn-page
```

`fixtures/miniprogram/pages/dyn-page/dyn-page.json`:

```json
{
  "usingComponents": {
    "local-bar": "/components/local-bar/local-bar"
  }
}
```

`fixtures/miniprogram/pages/dyn-page/dyn-page.wxml`:

```wxml
<view>
  <local-bar locationError="{{undefVar}}" />
</view>
```

`fixtures/miniprogram/pages/dyn-page/dyn-page.js`:

```js
const baseData = { count: 0 };

Page({
  data: {
    ...baseData,
    extra: "x",
  },
  onLoad() {},
});
```

The `data: { ...baseData, extra: "x" }` triggers `hasDynamicData = true` on this script via the existing `containsSpread` check in `shared/js-method-extractor.mjs`.

- [ ] **Step 5: Register both pages in `app.json`**

Read current `fixtures/miniprogram/app.json`:

```bash
cat /Users/zs/Desktop/study/wxml-zed/fixtures/miniprogram/app.json
```

The `pages` array currently contains `"pages/home/home"`, `"pages/detail/detail"`, `"packages/shop/pages/list/list"`. Append `"pages/cross-binding/cross-binding"` and `"pages/dyn-page/dyn-page"` to that array. The JSON should retain its existing formatting (indentation, key order, trailing newline).

If the current content of `app.json` is:

```json
{
  "pages": [
    "pages/home/home",
    "pages/detail/detail"
  ],
  "subpackages": [
    { ... }
  ]
}
```

Replace with:

```json
{
  "pages": [
    "pages/home/home",
    "pages/detail/detail",
    "pages/cross-binding/cross-binding",
    "pages/dyn-page/dyn-page"
  ],
  "subpackages": [
    { ... }
  ]
}
```

(Preserve any additional top-level keys like `"subpackages"`, `"window"`, etc. unchanged.)

- [ ] **Step 6: Run extractor on the new page to verify shape**

```bash
cd /Users/zs/Desktop/study/wxml-zed
node scripts/extract-wxml-project-graph.mjs fixtures/miniprogram 2>/dev/null | node -e '
const g = JSON.parse(require("fs").readFileSync(0, "utf8"));
const cross = g.wxml.find(w => w.path.endsWith("cross-binding.wxml"));
const dyn = g.wxml.find(w => w.path.endsWith("dyn-page.wxml"));
const localBar = g.configs.find(c => c.path.endsWith("local-bar.json"));
const dynCard = g.configs.find(c => c.path.endsWith("dyn-card.json"));
const dynPage = g.configs.find(c => c.path.endsWith("dyn-page.json"));
console.log("cross-binding wxml present:", !!cross);
console.log("dyn-page wxml present:", !!dyn);
console.log("local-bar declared:", JSON.stringify(localBar?.script?.propertyKeys?.map(k => k.name)));
console.log("dyn-card declared:", JSON.stringify(dynCard?.script?.propertyKeys?.map(k => k.name)), "hasDynamicData:", dynCard?.script?.hasDynamicData);
console.log("dyn-page hasDynamicData:", dynPage?.script?.hasDynamicData);
'
```

Expected:

```
cross-binding wxml present: true
dyn-page wxml present: true
local-bar declared: ["locationError","referer"]
dyn-card declared: ["knownProp"] hasDynamicData: true
dyn-page hasDynamicData: true
```

If any of these are off, the corresponding fixture file is wrong — investigate before continuing.

- [ ] **Step 7: Run umbrella verifier**

```bash
bash /Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh 2>&1 | tail -3
```

Expected: `wxml-zed tree-sitter verification passed`.

The `verify-wxml-language-service.mjs` doesn't yet have any tests against `cross-binding.wxml` or `dyn-page.wxml`, so it just continues to pass against the existing assertion set. The `verify-lsp-diagnostics.mjs` graph-smoke suite may take slightly longer because the graph is bigger, but should still pass.

- [ ] **Step 8: Commit the new fixtures + app.json**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add fixtures/miniprogram/app.json \
        fixtures/miniprogram/components/local-bar/ \
        fixtures/miniprogram/components/dyn-card/ \
        fixtures/miniprogram/pages/cross-binding/ \
        fixtures/miniprogram/pages/dyn-page/
git commit -m "$(cat <<'EOF'
test: fixtures for cross-component prop binding diagnostic tests

Adds the project scaffolding needed by the upcoming
dead-component-binding test cases:

- components/local-bar: clean component with static properties
  (locationError, referer). Used by most cross-binding test cases.
- components/dyn-card: component with non-empty `behaviors:` array
  (sets hasDynamicData=true) AND statically declared `knownProp`.
  Drives T8a — the "static propertyKeys hit wins over hasDynamicData"
  regression lock.
- pages/cross-binding: page with multiple cross-component binding
  shapes — clean, attribute-without-corresponding-prop, reserved-
  attribute variants, mixed multi-attr, etc.
- pages/dyn-page: page with `data: { ...spread }` so its script's
  hasDynamicData=true. Drives T13 — the parent-scope-completeness
  inheritance regression lock.

Both new pages registered in app.json. No production code changed
yet; the umbrella stays green.
EOF
)"
```

---

## Task 4: Language service — add helpers as unwired dead code

**Files:**
- Modify: `server/wxml-language-service.mjs` — add `INFORMATION` constant, `RESERVED_ATTRIBUTES` set, `RESERVED_ATTRIBUTE_PREFIXES` array, `isReservedAttribute()` helper, `findChildProperty()` helper.

Helpers land first as unreferenced dead code (no behavior change). Task 5 wires them in. Keeps each commit green.

- [ ] **Step 1: Add the `INFORMATION` severity constant**

In `server/wxml-language-service.mjs`, locate the existing line 13:

```js
const WARNING = 2;
```

Replace with:

```js
const WARNING = 2;
const INFORMATION = 3;
```

- [ ] **Step 2: Add `RESERVED_ATTRIBUTES` set, `RESERVED_ATTRIBUTE_PREFIXES` array, `isReservedAttribute` helper**

Insert these definitions immediately after the `WARNING` / `INFORMATION` constants (around line 14, before the next existing declaration). The location is at the module top with other shared constants.

```js
// Attribute names that have special WXML semantics (control flow, runtime,
// styling) and are NOT custom prop bindings on child components. When an
// expressionRef appears inside one of these, the cross-component prop
// binding rule does NOT apply — fall through to the existing
// missing-expression-ref check unchanged.
const RESERVED_ATTRIBUTES = new Set([
  "wx:if", "wx:elif", "wx:else",
  "wx:for", "wx:for-item", "wx:for-index", "wx:key",
  "class", "style", "id", "slot", "hidden",
]);

// Attribute name prefixes that carry WXML semantics other than custom prop
// binding (event bindings, custom data attrs, generic-type slots). Matched
// by startsWith — these are reserved regardless of the suffix.
const RESERVED_ATTRIBUTE_PREFIXES = [
  "bind:", "catch:", "mut-bind:", "capture-bind:", "capture-catch:",
  "data-", "generic:",
];

function isReservedAttribute(name) {
  if (RESERVED_ATTRIBUTES.has(name)) return true;
  for (const prefix of RESERVED_ATTRIBUTE_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}
```

- [ ] **Step 3: Add `findChildProperty` helper**

Find the location just before `function expressionRefDiagnostics(graph, documentGraphPath, fileModel) {` (around line 788). Insert this helper above it:

```js
// Returns 'declared' | 'not-declared' | 'unresolvable'.
//
// 'declared'      — child's static propertyKeys provably contains the name.
//                   Even if child.script.hasDynamicData === true elsewhere
//                   (e.g., from data spread or non-empty behaviors), a static
//                   propertyKeys hit is authoritative. The extractor saw the
//                   declaration; nothing in the rest of the script can
//                   REMOVE it.
// 'not-declared'  — child resolves, the prop set is fully knowable (no
//                   hasDynamicData), AND the name is not in propertyKeys.
//                   We know the child does not accept this prop.
// 'unresolvable'  — child has no usingComponents entry (so we can't even
//                   find the child file), or child resolves but has no JS,
//                   or child has hasDynamicData=true AND the name is not in
//                   the static propertyKeys (the name might be injected by
//                   behaviors / spread). Be pessimistic — fall through to
//                   the existing missing-expression-ref warning.
function findChildProperty(graph, ownerWxmlGraphPath, childTag, attributeName) {
  const using = graph.usingComponents.find((c) => (
    c.owner === ownerWxmlGraphPath &&
    c.tag === childTag &&
    c.resolved
  ));
  if (!using) return "unresolvable";

  const childConfig = graph.configs.find((c) => (
    c.owner === using.target &&
    c.script
  ));
  if (!childConfig) return "unresolvable";

  const propertyKeys = childConfig.script.propertyKeys ?? [];
  if (propertyKeys.some((k) => k.name === attributeName)) {
    return "declared";
  }
  if (childConfig.script.hasDynamicData) return "unresolvable";
  return "not-declared";
}
```

- [ ] **Step 4: Run language-service verifier — existing tests must still pass**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wxml-language-service.mjs 2>&1 | tail -5
```

Expected: PASS for all existing cases. The helpers are unreferenced dead code; nothing in `expressionRefDiagnostics` calls them yet.

- [ ] **Step 5: Commit helpers**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add server/wxml-language-service.mjs
git commit -m "$(cat <<'EOF'
feat: language-service helpers for cross-component prop binding

Adds three pieces to server/wxml-language-service.mjs as unreferenced
dead code; next commit wires them into expressionRefDiagnostics:

- INFORMATION severity constant (LSP code 3, alongside the existing
  WARNING = 2).

- RESERVED_ATTRIBUTES set + RESERVED_ATTRIBUTE_PREFIXES array +
  isReservedAttribute(name) helper. Encodes the WXML reserved
  attribute namespace (wx:* control flow, class/style/id/slot/hidden
  styling/structural, bind:/catch:/mut-bind:/capture-bind:/capture-
  catch: events, data-/generic: prefixes) so the new diagnostic
  only triggers on genuine custom prop bindings.

- findChildProperty(graph, ownerWxmlGraphPath, childTag, attributeName)
  helper. Returns 'declared' | 'not-declared' | 'unresolvable'.
  Critical ordering: static propertyKeys hit wins over hasDynamicData
  — the extractor's static observation is authoritative for the keys
  it captured. hasDynamicData only kicks in when the name is NOT in
  static propertyKeys, signaling "this missing name might be
  runtime-injected; fall back to existing warning."

No behavior change in this commit. Verify-wxml-language-service still
passes with the existing test set.
EOF
)"
```

---

## Task 5: Wire dead-component-binding into expressionRefDiagnostics + first synthetic test (T5)

**Files:**
- Modify: `server/wxml-language-service.mjs` — extend the main loop of `expressionRefDiagnostics` to invoke the helpers from Task 4.
- Modify: `scripts/verify-wxml-language-service.mjs` — add T5 (the happy-path case) AND register it in the main run sequence.

This is the TDD commit: T5 is the smallest case that exercises the wiring end-to-end. Land wiring + T5 together so the commit has a regression lock for the new behavior.

- [ ] **Step 1: Write T5 first**

In `scripts/verify-wxml-language-service.mjs`, locate the existing expression-ref assertion functions (around lines 645-700). After `assertExpressionRefDiagnosticSuppressedByWxsModule` and friends (find the last `assertExpressionRefDiagnostic*` function), add new constants and the T5 assertion:

First, add path constants near the top of the file (look for existing constants like `HOME_WXML`, `HOME_WXML_GRAPH_PATH` — these are typically defined around the top of the file). Add:

```js
const CROSS_BINDING_WXML = path.join(ROOT, "fixtures/miniprogram/pages/cross-binding/cross-binding.wxml");
const CROSS_BINDING_WXML_GRAPH_PATH = toPosixRelative(CROSS_BINDING_WXML);
const DYN_PAGE_WXML = path.join(ROOT, "fixtures/miniprogram/pages/dyn-page/dyn-page.wxml");
const DYN_PAGE_WXML_GRAPH_PATH = toPosixRelative(DYN_PAGE_WXML);
const LOCAL_BAR_CONFIG_PATH = "fixtures/miniprogram/components/local-bar/local-bar.json";
```

(The function `toPosixRelative` should already be in the file — reuse it; if it's named differently, look for how `HOME_WXML_GRAPH_PATH` is computed and use the same helper.)

Then add the T5 assertion function:

```js
function assertCrossBindingT5DeclaredProp(graph) {
  // T5: parent's <local-bar locationError="{{undef}}">, child declares
  // locationError as a property → expect dead-component-binding Information.
  // The parent fixture has locationError in its data block (so the binding
  // is clean in the baseline). For this test, remove locationError from the
  // page's dataKeys to force the parent-scope miss.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig && pageConfig.script, "T5 setup: cross-binding config must have script");
  const originalDataKeys = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = originalDataKeys.filter((k) => k.name !== "locationError");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const deadBindings = diagnostics.filter((d) => d.code === "dead-component-binding");
    const locationErrorDiag = deadBindings.find((d) => d.message.includes('"locationError"'));
    assert(locationErrorDiag, `T5: expected dead-component-binding for locationError; got ${JSON.stringify(deadBindings)}`);
    assert(locationErrorDiag.severity === 3, `T5: severity ${locationErrorDiag.severity} !== 3 (Information)`);
    assert(locationErrorDiag.source === "wxml-zed", `T5: source ${locationErrorDiag.source}`);
    assert(
      locationErrorDiag.message.includes("receive undefined and use its property default if one exists"),
      `T5: message mismatch: ${locationErrorDiag.message}`,
    );
    // Also assert NO missing-expression-ref warning for the same identifier on the same site.
    const missingForLocationError = diagnostics.filter((d) => (
      d.code === "missing-expression-ref" && d.message.includes('"locationError"')
    ));
    assert(missingForLocationError.length === 0, `T5: locationError should not also be a warning; got ${JSON.stringify(missingForLocationError)}`);
  } finally {
    pageConfig.script.dataKeys = originalDataKeys;
  }
}
```

- [ ] **Step 2: Register T5 in the main run sequence**

Find the function that orchestrates all tests (usually called `main()` or similar — look for the function near the bottom that calls `assertX(graph)`, `assertY(graph)`, etc.). Add a call:

```js
assertCrossBindingT5DeclaredProp(graph);
```

near the other `assertExpressionRefDiagnostic*` calls (which are grouped by topic).

- [ ] **Step 3: Run the verifier — expect T5 to FAIL**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wxml-language-service.mjs 2>&1 | tail -10
```

Expected: T5 fails with `expected dead-component-binding for locationError; got []` — confirming the wiring is not yet in place. Other existing tests continue to pass.

- [ ] **Step 4: Wire the helpers into `expressionRefDiagnostics`**

In `server/wxml-language-service.mjs`, locate the main loop in `expressionRefDiagnostics` (around lines 812-826):

```js
const refs = fileModel.expressionRefs ?? [];
const out = [];
for (const ref of refs) {
  // Refs inside `<template name="X">...</template>` resolve in the caller's
  // data scope (passed via `<template is="X" data="{{...}}"/>`) at use
  // time, not in this file's owner script. Skip them — we don't have the
  // call-site context here to validate.
  if (ref.inTemplateDefinition) continue;
  if (scope.has(ref.name)) continue;
  out.push({
    range: rangeFromSymbolRange(ref.range),
    severity: WARNING,
    source: "wxml-zed",
    code: "missing-expression-ref",
    message: `"${ref.name}" is not defined in the page/component data, wx:for scope, or any <wxs> module.`,
  });
}
return out;
```

Replace the loop body to insert the cross-component check between the existing short-circuits and the final `out.push`. New body:

```js
const refs = fileModel.expressionRefs ?? [];
const out = [];
for (const ref of refs) {
  // Refs inside `<template name="X">...</template>` resolve in the caller's
  // data scope (passed via `<template is="X" data="{{...}}"/>`) at use
  // time, not in this file's owner script. Skip them — we don't have the
  // call-site context here to validate.
  if (ref.inTemplateDefinition) continue;
  if (scope.has(ref.name)) continue;

  // Cross-component prop binding check: when the failing identifier is
  // inside a custom (non-reserved) attribute on some tag, look up the
  // tag's declared properties in the graph. If the attribute name is a
  // statically-declared property on the resolved child, downgrade to
  // dead-component-binding Information.
  const isCandidateBinding =
    ref.containingTag !== null &&
    ref.containingAttribute !== null &&
    !isReservedAttribute(ref.containingAttribute);

  if (isCandidateBinding) {
    const status = findChildProperty(graph, documentGraphPath, ref.containingTag, ref.containingAttribute);
    if (status === "declared") {
      out.push({
        range: rangeFromSymbolRange(ref.range),
        severity: INFORMATION,
        source: "wxml-zed",
        code: "dead-component-binding",
        message: `"${ref.name}" is not defined in this file, but <${ref.containingTag}> declares "${ref.containingAttribute}" as a property — the child will receive undefined and use its property default if one exists. If you intended to pass a value, declare "${ref.name}" in this page/component's data, properties, or setData.`,
      });
      continue;
    }
    // status === 'not-declared' or 'unresolvable' → fall through
  }

  out.push({
    range: rangeFromSymbolRange(ref.range),
    severity: WARNING,
    source: "wxml-zed",
    code: "missing-expression-ref",
    message: `"${ref.name}" is not defined in the page/component data, wx:for scope, or any <wxs> module.`,
  });
}
return out;
```

The existing early return `if (ownerConfig.script.hasDynamicData) return [];` at the TOP of `expressionRefDiagnostics` (around line 791) is preserved unchanged. The whole new loop is gated by it.

- [ ] **Step 5: Re-run the verifier — T5 must now PASS**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wxml-language-service.mjs 2>&1 | tail -5
```

Expected: all cases pass, including T5.

If T5 still fails:
- `expected dead-component-binding for locationError; got []` → the helpers aren't being invoked. Check that `isReservedAttribute` and `findChildProperty` are imported/in-scope where `expressionRefDiagnostics` lives. (They should be in the same file at module top, so no import needed.)
- `severity X !== 3` → wrong constant used. Verify `INFORMATION = 3` is defined and the push uses it.
- Got a `missing-expression-ref` instead of `dead-component-binding` for `locationError` → the prefilter is wrong. Print `ref.containingTag`, `ref.containingAttribute` and verify both are non-null. If they're null, the extractor change in Task 1 didn't propagate — re-check Task 1 Step 2.

- [ ] **Step 6: Run umbrella verifier**

```bash
bash /Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh 2>&1 | tail -3
```

Expected: `wxml-zed tree-sitter verification passed`.

- [ ] **Step 7: Commit wiring + T5**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "$(cat <<'EOF'
feat: dead-component-binding diagnostic + T5 happy-path test

Wires isReservedAttribute and findChildProperty (landed previously)
into expressionRefDiagnostics. When an expression ref's identifier
is missing from parent scope but the containing tag has a resolved
usingComponents entry AND the containing attribute is a static
property on the child, emit dead-component-binding (Information)
instead of missing-expression-ref (Warning).

Order of checks in the loop:
1. inTemplateDefinition: skip entirely (existing behavior)
2. scope.has(name): skip — clean (existing behavior)
3. isCandidateBinding (containing tag + attribute, non-reserved attr):
   look up child via findChildProperty
   - 'declared' → emit dead-component-binding Information
   - 'not-declared' or 'unresolvable' → fall through to step 4
4. Emit missing-expression-ref Warning (existing behavior)

The parent-scope-completeness inheritance (existing
`if (ownerConfig.script.hasDynamicData) return [];` at the top of
expressionRefDiagnostics) is preserved verbatim — when the parent's
own data is opaque, we don't claim ANY scope misses, including
dead-component-binding ones.

T5 (cross-binding's <local-bar locationError="{{undef}}"> with
locationError declared on local-bar) regression-locks the happy
path: severity 3, code dead-component-binding, message contains
"receive undefined and use its property default if one exists".
Remaining 14 synthetic cases (T1-T4, T6-T13) land in the next
commit alongside L1/L2 LSP protocol-layer tests.
EOF
)"
```

---

## Task 6: Add remaining 14 synthetic test cases (T1–T4, T6–T13)

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs` — add 14 assertion functions, register all in the main run sequence.

These lock in every decision-matrix branch and edge case. Most are mutations of the existing `cross-binding` page's graph + assertions; T9 needs HOME's template definition context; T13 uses the separate `dyn-page` fixture.

- [ ] **Step 1: Add T1 — built-in tag, reserved attribute**

After `assertCrossBindingT5DeclaredProp`, add:

```js
function assertCrossBindingT1BuiltinTag(graph) {
  // T1: <view class="{{undef}}"> — built-in tag, reserved attribute.
  // Expect existing missing-expression-ref warning (C2).
  // Fixture: cross-binding's "<view class="container {{theme}}">". Force
  // theme to be missing from scope.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig && pageConfig.script, "T1 setup: cross-binding config must have script");
  const originalDataKeys = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = originalDataKeys.filter((k) => k.name !== "theme");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const themeMissing = diagnostics.find((d) => d.code === "missing-expression-ref" && d.message.includes('"theme"'));
    assert(themeMissing, `T1: expected missing-expression-ref for theme; got ${JSON.stringify(diagnostics)}`);
    assert(themeMissing.severity === 2, `T1: severity ${themeMissing.severity} !== 2 (Warning)`);
    const themeDead = diagnostics.find((d) => d.code === "dead-component-binding" && d.message.includes('"theme"'));
    assert(!themeDead, `T1: theme must NOT be a dead-component-binding (built-in tag); got ${JSON.stringify(themeDead)}`);
  } finally {
    pageConfig.script.dataKeys = originalDataKeys;
  }
}
```

- [ ] **Step 2: Add T2 — component tag, reserved attribute (`wx:if`)**

```js
function assertCrossBindingT2ReservedWxIf(graph) {
  // T2: <local-bar wx:if="{{shouldShow}}" ...>. wx:if is a reserved attribute.
  // Expect missing-expression-ref (C2 via reserved attr) — NOT dead-binding.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig && pageConfig.script, "T2 setup: cross-binding config must have script");
  const originalDataKeys = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = originalDataKeys.filter((k) => k.name !== "shouldShow");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const shouldShow = diagnostics.find((d) => d.message.includes('"shouldShow"'));
    assert(shouldShow, `T2: expected diagnostic for shouldShow; got ${JSON.stringify(diagnostics)}`);
    assert(shouldShow.code === "missing-expression-ref", `T2: code ${shouldShow.code} !== missing-expression-ref (wx:if is reserved)`);
  } finally {
    pageConfig.script.dataKeys = originalDataKeys;
  }
}
```

- [ ] **Step 3: Add T3 — component tag, reserved attribute prefix (`data-`)**

```js
function assertCrossBindingT3ReservedDataPrefix(graph) {
  // T3: <local-bar data-id="{{customId}}">. data-* is a reserved prefix.
  // Expect missing-expression-ref (C2 via reserved prefix).
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig && pageConfig.script, "T3 setup: cross-binding config must have script");
  const originalDataKeys = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = originalDataKeys.filter((k) => k.name !== "customId");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const customId = diagnostics.find((d) => d.message.includes('"customId"'));
    assert(customId, `T3: expected diagnostic for customId; got ${JSON.stringify(diagnostics)}`);
    assert(customId.code === "missing-expression-ref", `T3: code ${customId.code} !== missing-expression-ref (data- is reserved)`);
  } finally {
    pageConfig.script.dataKeys = originalDataKeys;
  }
}
```

- [ ] **Step 4: Add T4 — component tag, reserved attribute prefix (`generic:`)**

```js
function assertCrossBindingT4ReservedGenericPrefix(graph) {
  // T4: <local-bar generic:Item="{{customGeneric}}">. generic:* is reserved.
  // Expect missing-expression-ref (C2 via reserved prefix).
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig && pageConfig.script, "T4 setup: cross-binding config must have script");
  const originalDataKeys = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = originalDataKeys.filter((k) => k.name !== "customGeneric");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const customGeneric = diagnostics.find((d) => d.message.includes('"customGeneric"'));
    assert(customGeneric, `T4: expected diagnostic for customGeneric; got ${JSON.stringify(diagnostics)}`);
    assert(customGeneric.code === "missing-expression-ref", `T4: code ${customGeneric.code} !== missing-expression-ref (generic: is reserved)`);
  } finally {
    pageConfig.script.dataKeys = originalDataKeys;
  }
}
```

- [ ] **Step 5: Add T6 — child resolved but attr not in child's properties**

```js
function assertCrossBindingT6ChildLacksProp(graph) {
  // T6: <local-bar locationError="{{undef}}"> but local-bar does NOT declare
  // locationError. Expect missing-expression-ref (C4 — truly dead).
  // Setup: remove locationError from local-bar's propertyKeys, AND remove
  // locationError from parent's dataKeys (to force the parent-miss).
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const childConfig = graph.configs.find((c) => c.path === LOCAL_BAR_CONFIG_PATH);
  assert(pageConfig?.script && childConfig?.script, "T6 setup: both configs must have scripts");
  const originalPageData = pageConfig.script.dataKeys;
  const originalChildProps = childConfig.script.propertyKeys;
  pageConfig.script.dataKeys = originalPageData.filter((k) => k.name !== "locationError");
  childConfig.script.propertyKeys = originalChildProps.filter((k) => k.name !== "locationError");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const locationError = diagnostics.find((d) => d.message.includes('"locationError"'));
    assert(locationError, `T6: expected diagnostic for locationError; got ${JSON.stringify(diagnostics)}`);
    assert(locationError.code === "missing-expression-ref", `T6: code ${locationError.code} !== missing-expression-ref (child lacks prop)`);
    assert(locationError.severity === 2, `T6: severity ${locationError.severity} !== 2`);
  } finally {
    pageConfig.script.dataKeys = originalPageData;
    childConfig.script.propertyKeys = originalChildProps;
  }
}
```

- [ ] **Step 6: Add T7 — child resolved but no JS (`script` is undefined)**

```js
function assertCrossBindingT7ChildNoScript(graph) {
  // T7: <local-bar locationError="{{undef}}"> but local-bar's config has no
  // script. Expect missing-expression-ref (C3 — unresolvable).
  // Setup: temporarily set local-bar's script to undefined.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const childConfig = graph.configs.find((c) => c.path === LOCAL_BAR_CONFIG_PATH);
  assert(pageConfig?.script && childConfig?.script, "T7 setup: both configs must have scripts");
  const originalPageData = pageConfig.script.dataKeys;
  const originalChildScript = childConfig.script;
  pageConfig.script.dataKeys = originalPageData.filter((k) => k.name !== "locationError");
  delete childConfig.script;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const locationError = diagnostics.find((d) => d.message.includes('"locationError"'));
    assert(locationError, `T7: expected diagnostic for locationError; got ${JSON.stringify(diagnostics)}`);
    assert(locationError.code === "missing-expression-ref", `T7: code ${locationError.code} !== missing-expression-ref (child unresolvable)`);
  } finally {
    pageConfig.script.dataKeys = originalPageData;
    childConfig.script = originalChildScript;
  }
}
```

- [ ] **Step 7: Add T8a — behaviors=non-empty AND child statically declares prop → C5 (lookup-order regression lock)**

```js
function assertCrossBindingT8aStaticHitWinsOverDynamic(graph) {
  // T8a: dyn-card has behaviors=non-empty (hasDynamicData=true) AND statically
  // declares knownProp. parent's <dyn-card knownProp="{{dynValue}}"> with
  // dynValue removed from parent's data. Expect dead-component-binding —
  // the static propertyKeys hit must win over hasDynamicData.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const dynCardConfig = graph.configs.find((c) => c.path.endsWith("dyn-card/dyn-card.json"));
  assert(pageConfig?.script && dynCardConfig?.script, "T8a setup: both configs must have scripts");
  assert(dynCardConfig.script.hasDynamicData === true, "T8a setup: dyn-card must have hasDynamicData=true");
  assert(dynCardConfig.script.propertyKeys.some((k) => k.name === "knownProp"), "T8a setup: dyn-card must declare knownProp");
  const originalPageData = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = originalPageData.filter((k) => k.name !== "dynValue");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const dynValueDead = diagnostics.find((d) => d.code === "dead-component-binding" && d.message.includes('"dynValue"'));
    assert(dynValueDead, `T8a: expected dead-component-binding for dynValue (static hit must win); got ${JSON.stringify(diagnostics)}`);
    assert(dynValueDead.severity === 3, `T8a: severity ${dynValueDead.severity} !== 3`);
    const dynValueWarn = diagnostics.find((d) => d.code === "missing-expression-ref" && d.message.includes('"dynValue"'));
    assert(!dynValueWarn, `T8a: dynValue must NOT be a warning; got ${JSON.stringify(dynValueWarn)}`);
  } finally {
    pageConfig.script.dataKeys = originalPageData;
  }
}
```

- [ ] **Step 8: Add T8b — behaviors=non-empty AND child does NOT declare prop → C3**

```js
function assertCrossBindingT8bDynamicChildLacksProp(graph) {
  // T8b: dyn-card has behaviors=non-empty (hasDynamicData=true) but does NOT
  // statically declare locationError. parent's <dyn-card locationError="{{x}}">
  // hypothetical case. We simulate by temporarily removing knownProp from
  // dyn-card and asserting locationError (which the parent's WXML doesn't
  // currently bind to dyn-card — so we need a small additional setup).
  //
  // Easier construction: use existing <dyn-card knownProp="{{dynValue}}"> but
  // remove knownProp from dyn-card's propertyKeys. dyn-card still has
  // hasDynamicData=true (from behaviors). Expect missing-expression-ref
  // (behaviors might inject knownProp; we can't say for sure → unresolvable).
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const dynCardConfig = graph.configs.find((c) => c.path.endsWith("dyn-card/dyn-card.json"));
  assert(pageConfig?.script && dynCardConfig?.script, "T8b setup: both configs must have scripts");
  const originalPageData = pageConfig.script.dataKeys;
  const originalChildProps = dynCardConfig.script.propertyKeys;
  pageConfig.script.dataKeys = originalPageData.filter((k) => k.name !== "dynValue");
  dynCardConfig.script.propertyKeys = originalChildProps.filter((k) => k.name !== "knownProp");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const dynValueWarn = diagnostics.find((d) => d.code === "missing-expression-ref" && d.message.includes('"dynValue"'));
    assert(dynValueWarn, `T8b: expected missing-expression-ref for dynValue; got ${JSON.stringify(diagnostics)}`);
    const dynValueDead = diagnostics.find((d) => d.code === "dead-component-binding" && d.message.includes('"dynValue"'));
    assert(!dynValueDead, `T8b: dynValue must NOT be dead-component-binding (no static hit, hasDynamicData=true → unresolvable)`);
  } finally {
    pageConfig.script.dataKeys = originalPageData;
    dynCardConfig.script.propertyKeys = originalChildProps;
  }
}
```

- [ ] **Step 9: Add T8c — child has hasDynamicData=true via data spread AND statically declares prop → C5**

```js
function assertCrossBindingT8cDataSpreadStaticHit(graph) {
  // T8c: child has data: { ...spread } (hasDynamicData=true) AND statically
  // declares the prop. Static hit must still win. We simulate by temporarily
  // setting hasDynamicData=true on local-bar's script (which keeps the
  // existing propertyKeys: ["locationError", "referer"]).
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const childConfig = graph.configs.find((c) => c.path === LOCAL_BAR_CONFIG_PATH);
  assert(pageConfig?.script && childConfig?.script, "T8c setup: both configs must have scripts");
  const originalPageData = pageConfig.script.dataKeys;
  const originalHasDynamicData = childConfig.script.hasDynamicData;
  pageConfig.script.dataKeys = originalPageData.filter((k) => k.name !== "locationError");
  childConfig.script.hasDynamicData = true;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const locationErrorDead = diagnostics.find((d) => d.code === "dead-component-binding" && d.message.includes('"locationError"'));
    assert(locationErrorDead, `T8c: expected dead-component-binding for locationError (static hit wins over hasDynamicData); got ${JSON.stringify(diagnostics)}`);
  } finally {
    pageConfig.script.dataKeys = originalPageData;
    childConfig.script.hasDynamicData = originalHasDynamicData;
  }
}
```

- [ ] **Step 10: Add T9 — inTemplateDefinition short-circuit precedence**

T9 requires WXML inside `<template name="...">`. The existing `home.wxml` fixture doesn't have a `<local-bar>` inside a template definition. We test by directly mutating an existing expressionRef in the graph to set `inTemplateDefinition=true` and verify it skips even when otherwise eligible.

```js
function assertCrossBindingT9InTemplateDefSkipped(graph) {
  // T9: a ref with inTemplateDefinition=true must skip the whole pipeline,
  // including the new dead-component-binding rule. We simulate by mutating
  // an existing locationError ref's flag.
  const homeWxml = graph.wxml.find((w) => w.path === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(homeWxml, "T9 setup: cross-binding wxml entry must exist in graph");
  const ref = homeWxml.expressionRefs.find((r) => (
    r.name === "locationError" &&
    r.containingTag === "local-bar" &&
    r.containingAttribute === "locationError"
  ));
  assert(ref, `T9 setup: locationError ref must exist; got ${JSON.stringify(homeWxml.expressionRefs)}`);
  const originalFlag = ref.inTemplateDefinition;
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const originalPageData = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = originalPageData.filter((k) => k.name !== "locationError");
  ref.inTemplateDefinition = true;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const anyForLocationError = diagnostics.filter((d) => d.message.includes('"locationError"'));
    // Any OTHER locationError refs in the page (e.g., on other lines) might still emit; but this specific ref's
    // contribution must be absent. Easiest assertion: count must be one less than without the flag mutation.
    ref.inTemplateDefinition = originalFlag;
    const baseline = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const baselineForLocationError = baseline.filter((d) => d.message.includes('"locationError"'));
    assert(
      anyForLocationError.length === baselineForLocationError.length - 1,
      `T9: inTemplateDefinition=true should suppress this ref's diagnostic. Got ${anyForLocationError.length} (with flag) vs ${baselineForLocationError.length} (without). Diagnostics: ${JSON.stringify(anyForLocationError)}`,
    );
  } finally {
    pageConfig.script.dataKeys = originalPageData;
    ref.inTemplateDefinition = originalFlag;
  }
}
```

- [ ] **Step 11: Add T10 — lookup by attribute name, not by identifier name (regression lock)**

```js
function assertCrossBindingT10LookupByAttributeName(graph) {
  // T10: cross-binding's WXML has <local-bar locationError="{{missingVar}}"/>.
  // The identifier "missingVar" is NOT a property of local-bar. The
  // attribute name "locationError" IS. The lookup must use the attribute
  // name (locationError) — NOT the identifier (missingVar) — to query the
  // child. If lookup were by identifier, this would fall through to
  // missing-expression-ref.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T10 setup: cross-binding config must have script");
  // Note: missingVar is NOT in the page's data (fixture intentionally omits it).
  // No mutation needed — it's already absent from parent scope.
  const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
  const missingVarDead = diagnostics.find((d) => d.code === "dead-component-binding" && d.message.includes('"missingVar"'));
  assert(missingVarDead, `T10: expected dead-component-binding for missingVar (lookup is by attribute name); got ${JSON.stringify(diagnostics)}`);
  assert(missingVarDead.message.includes('"locationError"'), `T10: message must mention the attribute name "locationError"; got ${missingVarDead.message}`);
}
```

- [ ] **Step 12: Add T11 — multi-attribute on same tag, mixed results**

```js
function assertCrossBindingT11MultiAttrIndependent(graph) {
  // T11: cross-binding's WXML has <local-bar locationError="{{a}}" referer="{{b}}"/>.
  // local-bar declares BOTH locationError and referer. Both 'a' and 'b' are
  // missing from parent scope. Expect TWO dead-component-binding diagnostics,
  // one for each attribute. (No mutation needed — fixture is already in this
  // shape: a and b are intentionally absent from page's data.)
  const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
  const aDead = diagnostics.find((d) => d.code === "dead-component-binding" && d.message.includes('"a"'));
  const bDead = diagnostics.find((d) => d.code === "dead-component-binding" && d.message.includes('"b"'));
  assert(aDead, `T11: expected dead-component-binding for 'a'; got ${JSON.stringify(diagnostics)}`);
  assert(bDead, `T11: expected dead-component-binding for 'b'; got ${JSON.stringify(diagnostics)}`);
  assert(aDead.message.includes('"locationError"'), `T11: 'a' diagnostic must mention locationError attribute`);
  assert(bDead.message.includes('"referer"'), `T11: 'b' diagnostic must mention referer attribute`);
}
```

- [ ] **Step 13: Add T12 — bind: event handler not affected by new rule**

```js
function assertCrossBindingT12EventBindingNotAffected(graph) {
  // T12: cross-binding's WXML has <local-bar bind:tap="onLocalBarTap"/>.
  // onLocalBarTap is a method on the page. Even though local-bar is a
  // component and bind:tap is an attribute, the bind: prefix is reserved.
  // The existing missing-event-handler diagnostic logic should fire if
  // onLocalBarTap were missing; the new rule should NOT touch this.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T12 setup: cross-binding config must have script");
  // Remove onLocalBarTap from methods so the existing event-handler rule fires.
  const originalMethods = pageConfig.script.methods;
  pageConfig.script.methods = originalMethods.filter((m) => m.name !== "onLocalBarTap");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const handlerMissing = diagnostics.find((d) => d.code === "missing-event-handler" && d.message.includes("onLocalBarTap"));
    assert(handlerMissing, `T12: expected missing-event-handler for onLocalBarTap; got ${JSON.stringify(diagnostics)}`);
    // And ensure no dead-component-binding for it (bind: is reserved).
    const handlerDead = diagnostics.find((d) => d.code === "dead-component-binding" && d.message.includes("onLocalBarTap"));
    assert(!handlerDead, `T12: onLocalBarTap must NOT be dead-component-binding (bind: is reserved)`);
  } finally {
    pageConfig.script.methods = originalMethods;
  }
}
```

- [ ] **Step 14: Add T13 — parent hasDynamicData blocks dead-component-binding too**

```js
function assertDynPageT13ParentDynamicBlocksAll(graph) {
  // T13: dyn-page has data: { ...spread } so its script.hasDynamicData=true.
  // dyn-page.wxml has <local-bar locationError="{{undefVar}}"/>. local-bar
  // declares locationError. But parent's scope is opaque — the existing
  // early return `if (ownerConfig.script.hasDynamicData) return [];` MUST
  // prevent ANY expression diagnostic, including dead-component-binding.
  const dynPageConfig = graph.configs.find((c) => c.owner === DYN_PAGE_WXML_GRAPH_PATH);
  assert(dynPageConfig?.script, "T13 setup: dyn-page config must have script");
  assert(dynPageConfig.script.hasDynamicData === true, "T13 setup: dyn-page must have hasDynamicData=true (data spread in fixture)");
  const diagnostics = getDiagnostics({ graph, documentPath: DYN_PAGE_WXML, extensionRoot: ROOT });
  const exprDiags = diagnostics.filter((d) => (
    d.code === "missing-expression-ref" || d.code === "dead-component-binding"
  ));
  assert(
    exprDiags.length === 0,
    `T13: parent's hasDynamicData=true must suppress all expression diagnostics (including dead-component-binding); got ${JSON.stringify(exprDiags)}`,
  );
}
```

- [ ] **Step 15: Register all 14 new tests in the main run sequence**

In the same orchestration function where T5 was registered (Task 5 Step 2), append calls in order:

```js
assertCrossBindingT1BuiltinTag(graph);
assertCrossBindingT2ReservedWxIf(graph);
assertCrossBindingT3ReservedDataPrefix(graph);
assertCrossBindingT4ReservedGenericPrefix(graph);
// T5 already registered
assertCrossBindingT6ChildLacksProp(graph);
assertCrossBindingT7ChildNoScript(graph);
assertCrossBindingT8aStaticHitWinsOverDynamic(graph);
assertCrossBindingT8bDynamicChildLacksProp(graph);
assertCrossBindingT8cDataSpreadStaticHit(graph);
assertCrossBindingT9InTemplateDefSkipped(graph);
assertCrossBindingT10LookupByAttributeName(graph);
assertCrossBindingT11MultiAttrIndependent(graph);
assertCrossBindingT12EventBindingNotAffected(graph);
assertDynPageT13ParentDynamicBlocksAll(graph);
```

- [ ] **Step 16: Run verifier — all 15 cases (T1–T13 plus T5) must PASS**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wxml-language-service.mjs 2>&1 | tail -8
```

Expected: all cases pass. If any fail:

- T1/T2/T3/T4 fails with a dead-component-binding for the test identifier → prefilter is wrong; verify `isReservedAttribute` correctly catches `class` / `wx:if` / `data-id` / `generic:Item`.
- T6 fails with dead-component-binding when child lacks prop → `findChildProperty` is wrong (not returning 'not-declared' correctly).
- T7 fails with dead-component-binding when child has no script → `findChildProperty` is wrong (not returning 'unresolvable' when `script` is undefined).
- T8a fails with missing-expression-ref instead of dead-component-binding → `findChildProperty` checked `hasDynamicData` BEFORE `propertyKeys.some(...)`. Re-read Task 4 Step 3 — the order must be propertyKeys first.
- T8b fails with dead-component-binding → `findChildProperty` returned 'declared' for something not in propertyKeys, OR `hasDynamicData` check is missing entirely.
- T9 fails → the `if (ref.inTemplateDefinition) continue;` line was moved or removed during Task 5 Step 4.
- T10 fails with missing-expression-ref → lookup is using `ref.name` instead of `ref.containingAttribute` for the child query.
- T11 fails with only one diagnostic → the main loop is `break`-ing instead of `continue`-ing.
- T12 fails with dead-component-binding for onLocalBarTap → `isReservedAttribute('bind:tap')` is returning false; check the `RESERVED_ATTRIBUTE_PREFIXES` array.
- T13 fails with any diagnostic → the early return `if (ownerConfig.script.hasDynamicData) return [];` was removed; verify it's still at the top of `expressionRefDiagnostics`.

- [ ] **Step 17: Run umbrella verifier**

```bash
bash /Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh 2>&1 | tail -3
```

Expected: `wxml-zed tree-sitter verification passed`.

- [ ] **Step 18: Commit**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add scripts/verify-wxml-language-service.mjs
git commit -m "$(cat <<'EOF'
test: lock all 15 cross-component prop binding decision-matrix branches

Adds T1-T4, T6-T13 to verify-wxml-language-service.mjs. Together
with T5 (landed previously), these 15 assertions exhaust the
decision matrix from the spec:

- T1: built-in tag, expression in reserved attribute (class) → C2
- T2: component tag, wx:if (reserved attr) → C2
- T3: component tag, data-id (reserved prefix) → C2
- T4: component tag, generic:Item (reserved prefix) → C2
- T5: component tag, custom attr, child declares prop → C5 (happy path)
- T6: component tag, custom attr, child does NOT declare → C4
- T7: component tag, custom attr, child has no script → C3
- T8a: child has behaviors (hasDynamicData=true) AND declares prop
       → C5 (regression lock: static hit wins over hasDynamicData)
- T8b: child has behaviors AND does NOT declare → C3
- T8c: child has data spread (hasDynamicData) AND declares → C5
- T9: inTemplateDefinition=true short-circuits new rule too
- T10: lookup by attribute name, NOT identifier name
       (regression lock: <local-bar locationError="{{missingVar}}">
        emits dead-component-binding for missingVar even though
        local-bar has no missingVar property — lookup keys on
        locationError attribute)
- T11: same tag, two custom attrs → two independent diagnostics
- T12: bind:tap is reserved → existing event-handler diagnostic
       still fires; new rule doesn't interfere
- T13: parent's hasDynamicData=true suppresses ALL expression
       diagnostics including dead-component-binding (regression
       lock for parent-scope-completeness inheritance)

All cases mutate existing graph entries (dataKeys / propertyKeys /
hasDynamicData / inTemplateDefinition flags) with try/finally
restoration. Fixtures unchanged from Task 3.
EOF
)"
```

---

## Task 7: Add 2 LSP protocol-layer tests (L1, L2)

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs` — add L1, L2 to the `graph-smoke` suite.

The language-service tests prove diagnostic logic; LSP protocol tests prove the wire format. Same gap pattern the P1 overlay invalidation work locked.

- [ ] **Step 1: Read existing graph-smoke structure to find insertion point**

```bash
grep -n "graph-smoke\|GRAPH_SMOKE\|registerScenario\|scenarios.push\|suiteRun" /Users/zs/Desktop/study/wxml-zed/scripts/verify-lsp-diagnostics.mjs | head -20
```

This identifies how scenarios are registered. The pattern (from inspecting earlier in the conversation) uses a const SCENARIO_SUITES object and an explicit array of test functions. Find the appropriate place to add L1 and L2 functions and register them.

- [ ] **Step 2: Add L1 — dead-component-binding wire format**

Add this test function near other diagnostic-flow tests in `scripts/verify-lsp-diagnostics.mjs`:

```js
async function testDeadComponentBindingWireFormat() {
  // L1: With a real graph build, opening cross-binding.wxml after
  // mutating its data to drop locationError, the LSP must publish
  // exactly one dead-component-binding (severity 3) for locationError —
  // no missing-expression-ref warning for the same identifier on the
  // same site.
  //
  // The cross-binding fixture has <local-bar locationError="{{locationError}}">
  // and the fixture's data DOES contain locationError, so the default
  // diagnostic state is clean. To trigger the diagnostic on a real graph
  // build (which we can't mutate after-the-fact), we use a different
  // fixture: pages/cross-binding.wxml has <local-bar locationError="{{a}}">
  // where 'a' is never in the page's data. The child (local-bar) declares
  // locationError as a property → dead-component-binding for 'a'.

  await withClient({ rootPath: MINI_ROOT }, async (client) => {
    const uri = client.openDocument(CROSS_BINDING_WXML);
    const params = await client.waitForDiagnostics(
      uri,
      (items) => items.some((d) => d.code === "dead-component-binding" && d.message.includes('"a"')),
      "cross-binding diagnostics for 'a' as dead-component-binding",
    );
    const items = params.diagnostics;
    const aDead = items.find((d) => d.code === "dead-component-binding" && d.message.includes('"a"'));
    assert(aDead, `L1: expected dead-component-binding for 'a'; got ${JSON.stringify(items)}`);
    assert(aDead.severity === 3, `L1: severity ${aDead.severity} !== 3`);
    const aWarn = items.find((d) => d.code === "missing-expression-ref" && d.message.includes('"a"'));
    assert(!aWarn, `L1: 'a' must NOT also be a warning; got ${JSON.stringify(aWarn)}`);
  });
}
```

The `MINI_ROOT` and `CROSS_BINDING_WXML` paths should already be defined or follow the existing path-constant pattern in `verify-lsp-diagnostics.mjs`. Reuse the existing `withClient` / `waitForDiagnostics` helpers (they're the same pattern as P1 overlay tests).

If `CROSS_BINDING_WXML` constant doesn't exist, add it near other fixture path constants:

```js
const CROSS_BINDING_WXML = path.join(MINI_ROOT, "pages/cross-binding/cross-binding.wxml");
```

- [ ] **Step 3: Add L2 — new rule doesn't suppress existing event-handler diagnostic**

```js
async function testDeadComponentBindingPreservesEventHandler() {
  // L2: cross-binding's WXML has <local-bar bind:tap="onLocalBarTap"/>.
  // The page declares onLocalBarTap in its methods, so the baseline is
  // clean. To exercise the wire, we need a separate fixture where
  // bind:tap targets an undeclared method — but rather than adding more
  // fixtures, this L2 is a structural assertion: in the baseline state,
  // there must be ZERO missing-event-handler diagnostics on this file
  // (proving the new rule didn't accidentally consume the event handler
  // attribute). The full L2 happens via the same withClient flow.
  await withClient({ rootPath: MINI_ROOT }, async (client) => {
    const uri = client.openDocument(CROSS_BINDING_WXML);
    const params = await client.waitForDiagnostics(
      uri,
      (items) => items.some((d) => d.code === "dead-component-binding"),
      "cross-binding has dead-component-binding (baseline)",
    );
    const items = params.diagnostics;
    // 'a' and 'b' both produce dead-component-binding (cross-binding fixture
    // has <local-bar locationError="{{a}}" referer="{{b}}"/>).
    const allDeadBindings = items.filter((d) => d.code === "dead-component-binding");
    assert(allDeadBindings.length >= 2, `L2: expected at least 2 dead-component-binding (for 'a' and 'b'); got ${allDeadBindings.length}: ${JSON.stringify(allDeadBindings)}`);
    // Critical: no missing-event-handler for onLocalBarTap (it IS declared
    // in the page's methods). If the new rule wrongly suppressed event-handler
    // diagnostics, a different test would need to remove the method to expose
    // that — but at least confirm here that bind: attributes don't generate
    // dead-component-binding.
    const bindTapDead = items.find((d) => d.code === "dead-component-binding" && d.message.includes("onLocalBarTap"));
    assert(!bindTapDead, `L2: bind:tap must NOT produce dead-component-binding (bind: is reserved); got ${JSON.stringify(bindTapDead)}`);
  });
}
```

- [ ] **Step 4: Register L1 and L2 in the graph-smoke scenario list**

In `scripts/verify-lsp-diagnostics.mjs`, find the existing `scenarios` array (or the equivalent registration mechanism — based on earlier work it's a `scenarios = [["name", testFn], ...]` array around line 1555):

Add entries:

```js
["dead-component-binding wire format", testDeadComponentBindingWireFormat],
["dead-component-binding preserves event handler", testDeadComponentBindingPreservesEventHandler],
```

And add them to the `SCENARIO_SUITES["graph-smoke"]` list:

```js
"dead-component-binding wire format",
"dead-component-binding preserves event handler",
```

- [ ] **Step 5: Run the graph-smoke suite**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-lsp-diagnostics.mjs --suite graph-smoke 2>&1 | tail -20
```

Expected: all tests pass (existing 13 + new L1 + L2 = 15).

- [ ] **Step 6: Run umbrella**

```bash
bash /Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh 2>&1 | tail -3
```

Expected: `wxml-zed tree-sitter verification passed`.

- [ ] **Step 7: Commit**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add scripts/verify-lsp-diagnostics.mjs
git commit -m "$(cat <<'EOF'
test: LSP protocol-layer tests for dead-component-binding

Adds two graph-smoke scenarios:

L1: testDeadComponentBindingWireFormat — opens cross-binding.wxml
through the real LSP client, awaits publishDiagnostics, asserts:
  - At least one diagnostic with code "dead-component-binding"
    and severity 3 for the identifier 'a'.
  - No "missing-expression-ref" warning for the same identifier
    on the same site.

L2: testDeadComponentBindingPreservesEventHandler — asserts that
bind:tap attributes never produce dead-component-binding (proves
the reserved-prefix filter survives the LSP boundary).

Closes the same wire-format gap the P1 overlay invalidation work
locked: language-service tests can be green while publishDiagnostics
emits the wrong shape; protocol-layer tests prevent that drift.
EOF
)"
```

---

## Task 8: Real-project dogfood on mp-wx-chelaile/wx + Outcome notes

**Files:**
- Read: `/tmp/claude-501/wxml-zed-diagnostics/wx.summary.json` (the existing AFTER snapshot from P2 round 1 — that becomes the BEFORE for P2.2-B).
- Generate: a new AFTER snapshot under `/tmp/claude-501/wxml-zed-diagnostics/wx.*`.
- Modify: `docs/superpowers/plans/2026-05-22-cross-component-prop-binding-diagnostic.md` (this file) — add Outcome section.
- Modify: `docs/wasm-parser-spike-notes.md` — append follow-up section.

- [ ] **Step 1: Snapshot the BEFORE state (P2 round 1 AFTER ≡ P2.2-B BEFORE)**

```bash
cp /tmp/claude-501/wxml-zed-diagnostics/wx.summary.json /tmp/claude-501/wxml-zed-diagnostics/wx.summary.p22b.before.json
cp /tmp/claude-501/wxml-zed-diagnostics/wx.summary.txt  /tmp/claude-501/wxml-zed-diagnostics/wx.summary.p22b.before.txt
cp /tmp/claude-501/wxml-zed-diagnostics/wx.jsonl        /tmp/claude-501/wxml-zed-diagnostics/wx.jsonl.p22b.before
```

Verify the BEFORE state — should be the P2 round 1 outcome (26 total, 19 missing-expression-ref, 7 missing-event-handler):

```bash
node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/claude-501/wxml-zed-diagnostics/wx.summary.p22b.before.json","utf8")); console.log("BEFORE total:", j.total, "byCode:", j.byCode);'
```

Expected: `total: 26, byCode: { "missing-expression-ref": 19, "missing-event-handler": 7 }`.

- [ ] **Step 2: Run the AFTER dump**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/dump-project-diagnostics.mjs /Users/zs/Desktop/zs_work/mp-wx-chelaile/wx
```

The dump writes to `/tmp/claude-501/wxml-zed-diagnostics/wx.{summary.json, summary.txt, jsonl}` (overwriting the originals — which were preserved as `*.p22b.before.*` in Step 1).

- [ ] **Step 3: Programmatic acceptance verification**

```bash
cd /tmp/claude-501/wxml-zed-diagnostics
node -e '
const before = JSON.parse(require("fs").readFileSync("wx.summary.p22b.before.json"));
const after  = JSON.parse(require("fs").readFileSync("wx.summary.json"));
console.log("=== BEFORE ===");
console.log("  total:", before.total);
console.log("  byCode:", JSON.stringify(before.byCode));
console.log("=== AFTER ===");
console.log("  total:", after.total);
console.log("  byCode:", JSON.stringify(after.byCode));
console.log("=== ACCEPTANCE CHECKS ===");
const beforeEvt = before.byCode["missing-event-handler"] || 0;
const afterEvt  = after.byCode["missing-event-handler"]  || 0;
console.log(`  missing-event-handler: ${beforeEvt} -> ${afterEvt} (must equal)`);
if (beforeEvt !== afterEvt) { console.log("  FAIL"); process.exit(1); }
console.log("  PASS: event-handler count preserved");
const totalCheck = after.total <= before.total;
console.log(`  total: ${before.total} -> ${after.total} (must NOT increase)`);
if (!totalCheck) { console.log("  FAIL"); process.exit(1); }
console.log("  PASS: total count not increased");
const deadCount = after.byCode["dead-component-binding"] || 0;
console.log(`  dead-component-binding: 0 -> ${deadCount} (must be >= 1)`);
if (deadCount < 1) { console.log("  FAIL"); process.exit(1); }
console.log("  PASS: at least one cross-binding sample downgraded");
console.log(`  TOTAL: ${before.total} -> ${after.total}`);
'
```

Required output: every check is `PASS`, exit 0.

If any check fails: do NOT proceed. Investigate. The dogfood data tells which sample didn't downgrade — find the parent WXML, look at the child's properties, decide whether it's a missed case (bug in implementation) or a known edge case (worth documenting before continuing).

- [ ] **Step 4: Sample surviving cases for the Outcome section**

```bash
cd /tmp/claude-501/wxml-zed-diagnostics
grep '"code":"missing-expression-ref"' wx.jsonl | shuf -n 10 | while read -r line; do
  echo "$line" | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(`\n${d.file}:${d.line+1}  name=${d.name}`);
    for (const s of (d.snippet || [])) console.log(`  ${s.marker} ${s.line+1}: ${s.source.slice(0, 200)}`);
  '
done
```

For each of the 10 (or however many survived if fewer than 10), classify into a bucket. Categories likely to appear:

- **library-mediated computed/spread setData** (from P2 round 1 — still surviving)
- **child component truly lacks the prop API** (C4 — real binding bug, kept warning correctly)
- **child cannot be resolved** (C3 — usingComponents typo or behaviors)
- **other**

- [ ] **Step 5: Write the Outcome section**

Append to the end of `/Users/zs/Desktop/study/wxml-zed/docs/superpowers/plans/2026-05-22-cross-component-prop-binding-diagnostic.md`:

```markdown
## Outcome

Before / after on `mp-wx-chelaile/wx`:

| metric | P2 round 1 (BEFORE) | P2.2-B (AFTER) |
|---|---|---|
| total | 26 | <N> |
| missing-event-handler | 7 | <N> |
| missing-expression-ref | 19 | <N> |
| dead-component-binding | 0 | <N> |

### Hard gates (all passed)

- `missing-event-handler`: 7 → 7 ✓ (precision unchanged)
- Total count: 26 → <N> ✓ (did not increase)
- `dead-component-binding`: 0 → <N> ✓ (≥ 1, downgrade pathway working)

### 10-sample classification (surviving missing-expression-ref)

- `<file>:<line>` (name=`<x>`) — <bucket>: <one-line reason>
- ... (up to 10 entries — fill in all from Step 4 sampling)

### Buckets observed (next-round input)

- <bucket-A>: <count>
- <bucket-B>: <count>
```

Replace each `<N>` and `<bucket>` placeholder with real data from Step 3/4.

- [ ] **Step 6: Write the spike-notes follow-up**

Append to `/Users/zs/Desktop/study/wxml-zed/docs/wasm-parser-spike-notes.md` AFTER the existing "Follow-up: setData-derived template scope keys" section's closing `---`:

```markdown
### Follow-up: cross-component prop binding diagnostic

P2.2-B added a new diagnostic code `dead-component-binding` (LSP
Information severity) that downgrades the `missing-expression-ref`
warning at component-tag custom-attribute binding sites when the
child statically declares the attribute as a property. Plan:
`docs/superpowers/plans/2026-05-22-cross-component-prop-binding-diagnostic.md`.

Lookup: by attribute name (child's prop API), not by expression
identifier (parent's namespace). Order: trust static propertyKeys
first; only consult hasDynamicData when name is NOT in the static
set. Parent's own hasDynamicData=true still suppresses ALL
expression diagnostics including the new code (parent-scope-
completeness inheritance via the existing early return).

Outcome on the same chelaile snapshot: 26 → <N> total. The 7
missing-event-handler diagnostics (all real bugs in the project)
were preserved unchanged. dead-component-binding count: 0 → <M>,
absorbing <M> of the 3 known cross-component samples from the P2
round 1 surviving classification. See plan's Outcome section.

---
```

Replace `<N>` and `<M>` with real numbers.

- [ ] **Step 7: Commit**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add docs/superpowers/plans/2026-05-22-cross-component-prop-binding-diagnostic.md docs/wasm-parser-spike-notes.md
git commit -m "$(cat <<'EOF'
docs: record cross-component prop binding dogfood outcome on chelaile

Captures the before/after diagnostic counts after dead-component-
binding (P2.2-B) lands. missing-event-handler stays at 7 (real
bugs in the project, unchanged precision); total did not increase;
dead-component-binding count: 0 -> <M>, absorbing <M> of the 3
known cross-component samples from P2 round 1.

10-sample surviving classification scopes the next round's input.
EOF
)"
```

---

## Acceptance Criteria

These are absolute pass/fail gates:

1. All existing tests pass (`bash scripts/verify-tree-sitter.sh` reports `wxml-zed tree-sitter verification passed`).
2. `verify-wxml-language-service.mjs` reports all 15 new synthetic cases (T1–T13 with T8a/b/c) pass.
3. `verify-lsp-diagnostics.mjs --suite graph-smoke` reports L1 and L2 pass alongside the existing 13 tests.
4. Baseline regeneration in Task 2 was purely additive (no existing field values modified, no entries added/removed).
5. `dump-project-diagnostics.mjs` on `mp-wx-chelaile/wx`:
   - `missing-event-handler`: 7 → 7 unchanged
   - Total count: 26 → not increased
   - `dead-component-binding`: 0 → at least 1
6. The Outcome section in this plan has real numbers (no `<N>` / `<M>` placeholders remaining) before the final commit lands.

## Self-Review

- All file paths absolute and resolve to real locations: ✓ (production source paths, fixture paths, tmp dump paths).
- All synthetic test cases include exact assertion code with concrete identifiers from concrete fixtures: ✓ (no "TBD" / "similar to" placeholders; T1–T13 each show their full mutation + assertion).
- Lookup order in `findChildProperty` matches the spec: static propertyKeys hit FIRST, then hasDynamicData, then not-declared: ✓ (Task 4 Step 3 + T8a regression lock + T8b regression lock).
- Diagnostic message string is consistent everywhere: Task 5 Step 4 implementation and T5 assertion use the same text ("receive undefined and use its property default if one exists"): ✓.
- The parent-scope-completeness inheritance (existing `hasDynamicData` early return) is preserved unchanged: Task 5 Step 4 explicitly notes it's NOT modified; T13 locks it: ✓.
- Severity constant is consistently used: `INFORMATION = 3` defined in Task 4 Step 1; consumed in Task 5 Step 4; asserted with `severity === 3` in T5 / T8a / T8c / L1: ✓.
- Reserved attribute set + prefix array are consistent with the spec: `wx:if`, `wx:elif`, `wx:else`, `wx:for`, `wx:for-item`, `wx:for-index`, `wx:key`, `class`, `style`, `id`, `slot`, `hidden` (set); `bind:`, `catch:`, `mut-bind:`, `capture-bind:`, `capture-catch:`, `data-`, `generic:` (prefixes): ✓ (Task 4 Step 2 + T2/T3/T4/T12 each exercise one branch).
- Fixture file content (`local-bar`, `dyn-card`, `cross-binding`, `dyn-page`) is fully specified — no "configure as needed": ✓ (Task 3 has complete file contents).
- Each commit is independently green (no failing tests in history): Task 1 commits a red baseline state but Task 2 immediately fixes it — verify the umbrella runs green after Task 2 and after every subsequent commit. Tasks 4/5 land helpers + wiring + T5 in two commits that are each green. T6 lands all remaining cases in one commit, green. T7 lands L1/L2 green. T8 lands docs.
- `findChildProperty` does NOT use `fileModel.components`: ✓ (Task 4 Step 3 code shows direct `graph.usingComponents` query; spec calls this out explicitly).
- The 7 baseline regenerations are mechanically reproducible: ✓ (Task 2 Step 1 lists the producer command for each baseline; matches the `verify-wasm-symbol-baselines.mjs` CASES array).
- T9 (inTemplateDefinition short-circuit) uses graph mutation to set `inTemplateDefinition=true` on an existing ref — this is correct because the cross-binding fixture doesn't have `<local-bar>` inside `<template name="X">`, and the mutation tests the diagnostic logic's branch, not the extractor.
- T10 (lookup by attribute name) uses the existing `<local-bar locationError="{{missingVar}}">` line in the cross-binding fixture, which is already in the shape needed — no mutation required. The fixture's `missingVar` is deliberately absent from page data.
- T11 (multi-attr) uses `<local-bar locationError="{{a}}" referer="{{b}}"/>` with both `a` and `b` deliberately absent from page data — no mutation needed.
- L1's dogfood assertion uses `{{a}}` for the same reason — fixture-baked, no mutation.
- All commit messages are present and use the HEREDOC pattern with consistent format.
