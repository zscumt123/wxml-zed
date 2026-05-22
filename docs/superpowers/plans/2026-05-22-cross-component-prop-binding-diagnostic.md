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
- **Prefilter**: a candidate cross-component binding requires `containingAttribute !== null && !isReservedAttribute(containingAttribute)`. Do NOT prefilter on `fileModel.components` — that's a hyphen-heuristic candidate list that misses non-hyphenated `usingComponents` aliases. Push the "is it a component?" question to `findChildProperty`'s `graph.usingComponents` lookup.
- **Parent scope completeness inheritance**: the existing early return `if (ownerConfig.script.hasDynamicData) return [];` at the top of `expressionRefDiagnostics` REMAINS unchanged. New rule does NOT promote `dead-component-binding` when parent's own data is opaque. This is locked by T13.
- **`inTemplateDefinition` short-circuit** takes precedence over the new rule, same as today. Locked by T9.
- **Range**: stays on the expression (consistent with `missing-expression-ref`). Don't add new range fields.
- **Severity**: `dead-component-binding` is LSP severity 3 (Information). Don't use 4 (Hint).
- **Diagnostic message**: literal text in Task 3 Step 5 below — do NOT paraphrase.
- **`containingTag` semantics**: tracks nearest enclosing element for ALL interpolations (including text nodes). The prefilter excludes text nodes via `containingAttribute !== null`. Text-node `containingTag` is still populated for future Hover/Definition leverage.

## File Structure

**Modified:**

- `shared/wxml-symbol-extractor.mjs` — add `containingTag` / `containingAttribute` tracking to `collectFile()`'s walk; add fields to emitted `expressionRefs` entries.
- `server/wxml-language-service.mjs` — add `INFORMATION` severity constant, `RESERVED_ATTRIBUTES` set, `RESERVED_ATTRIBUTE_PREFIXES` array, `isReservedAttribute()` helper, `findChildProperty()` helper; extend `expressionRefDiagnostics` main loop.
- `scripts/verify-wxml-language-service.mjs` — add 15 synthetic test cases (T1–T13, with T8a/b/c split). Register them in the main run sequence.
- `scripts/verify-lsp-diagnostics.mjs` — add 2 LSP protocol-layer tests (L1, L2) in the `graph-smoke` suite.
- `fixtures/miniprogram/app.json` — register the new `pages/cross-binding/cross-binding` and `pages/dyn-page/dyn-page` pages.
- All 7 `fixtures/wasm-spike/*-symbols-baseline.json` files — regenerate as part of Task 1 (purely additive new fields + new fixture files appearing in the miniprogram glob).

**Created:**

- `fixtures/miniprogram/pages/cross-binding/cross-binding.wxml` — page with cross-component binding sites for tests T5–T12. Default state has every referenced identifier in scope so the baseline is diagnostic-free; each test mutates the page's `dataKeys` to drop ONE specific identifier and asserts the resulting exact diagnostic count.
- `fixtures/miniprogram/pages/cross-binding/cross-binding.js` — page script: clean static `data` and `methods` (no `behaviors`, no spread). Page's `hasDynamicData = false`.
- `fixtures/miniprogram/pages/cross-binding/cross-binding.json` — registers `local-bar`, `dyn-card`, and reuses `user-card`.
- `fixtures/miniprogram/components/local-bar/local-bar.wxml`, `.js`, `.json` — child component with clean `properties: { locationError, referer }` (statically known).
- `fixtures/miniprogram/components/dyn-card/dyn-card.wxml`, `.js`, `.json` — child component with `behaviors: ["wx://component-export"]` (sets `hasDynamicData = true`) PLUS statically declared `properties: { knownProp }`. Drives T8a (static hit wins over `hasDynamicData`).
- `fixtures/miniprogram/pages/dyn-page/dyn-page.{wxml,js,json}` — page with `data: { ...baseData, extra: "x" }` so its script's `hasDynamicData = true`. Drives T13 (parent scope completeness inheritance).

**No new files outside fixtures.** All production logic lives in two existing source files.

## Sequencing Notes

Every commit is independently green — no red intermediate state. Combined Task 1 (extractor + new fixtures + baseline regen) avoids the glob-baseline drift: `verify-wasm-symbol-baselines.mjs` regenerates the `miniprogram-symbols-baseline.json` from a glob over `fixtures/miniprogram/`, so adding new wxml files there forces a regen. Doing the regen in the SAME commit that adds the files keeps the umbrella green at every point.

- Task 0 (Setup, no commit): Capture the BEFORE dogfood snapshot from the current main HEAD before any code changes land. Stored under an explicit `--out` directory so it's reproducible across machines.
- Task 1 (combined commit, green): extractor changes + new fixture files + baseline regen.
- Task 2 (commit, green): language-service helpers as unreferenced dead code.
- Task 3 (commit, green): wire helpers into `expressionRefDiagnostics` + T5 happy-path test.
- Task 4 (commit, green): 14 remaining synthetic cases T1–T4, T6, T7, T8a/b/c, T9–T13.
- Task 5 (commit, green): 2 LSP protocol-layer tests L1, L2.
- Task 6 (commit, green): real-project dogfood AFTER snapshot + Outcome notes.

---

## Task 0: Capture BEFORE dogfood snapshot

**No commit. Pure data capture before any code changes.**

The Acceptance Criteria's dogfood gates compare against the current `mp-wx-chelaile/wx` diagnostic state (the P2 round 1 AFTER ≡ P2.2-B BEFORE). Capture this snapshot now into an explicit, reproducible path so Task 6's verification is deterministic regardless of `$TMPDIR` or session-private paths.

- [ ] **Step 1: Create the dogfood snapshot directory**

```bash
mkdir -p /tmp/wxml-zed-diagnostics-p22b/before
```

- [ ] **Step 2: Run dump against chelaile, write BEFORE to the explicit path**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/dump-project-diagnostics.mjs \
  /Users/zs/Desktop/zs_work/mp-wx-chelaile/wx \
  --out /tmp/wxml-zed-diagnostics-p22b/before
```

The dump uses the project root's basename for output filenames. The chelaile project's basename is `wx`, so this writes:
- `/tmp/wxml-zed-diagnostics-p22b/before/wx.summary.json`
- `/tmp/wxml-zed-diagnostics-p22b/before/wx.summary.txt`
- `/tmp/wxml-zed-diagnostics-p22b/before/wx.jsonl`

- [ ] **Step 3: Verify the BEFORE snapshot matches P2 round 1 outcome**

```bash
node -e '
const j = JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-diagnostics-p22b/before/wx.summary.json", "utf8"));
console.log("BEFORE total:", j.total);
console.log("BEFORE byCode:", JSON.stringify(j.byCode));
'
```

Expected output:

```
BEFORE total: 26
BEFORE byCode: {"missing-expression-ref":19,"missing-event-handler":7}
```

If `total` or `byCode` differs significantly, the chelaile working tree may have drifted from the P2 round 1 snapshot. Verify whether the drift is from chelaile changes (acceptable) or from local changes to wxml-zed not yet committed (investigate). Record the observed BEFORE numbers — they become the baseline for Task 6's deltas regardless of whether they exactly match the original P2 round 1 outcome.

---

## Task 1: Extractor + new fixtures + baseline regen (combined green commit)

**Files:**
- Modify: `shared/wxml-symbol-extractor.mjs` — add stack-based tracking + new fields to expressionRef.
- Create: `fixtures/miniprogram/components/local-bar/local-bar.{wxml,js,json}` (3 files)
- Create: `fixtures/miniprogram/components/dyn-card/dyn-card.{wxml,js,json}` (3 files)
- Create: `fixtures/miniprogram/pages/cross-binding/cross-binding.{wxml,js,json}` (3 files)
- Create: `fixtures/miniprogram/pages/dyn-page/dyn-page.{wxml,js,json}` (3 files)
- Modify: `fixtures/miniprogram/app.json` — register the two new pages.
- Modify: 7 files under `fixtures/wasm-spike/*-symbols-baseline.json` — regenerate after the above land.

Combining all of this into one commit ensures every intermediate state during execution is recoverable, and downstream tasks (2–6) all start from a green tree.

- [ ] **Step 1: Add the new fixture component `local-bar`**

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

- [ ] **Step 2: Add the new fixture component `dyn-card`**

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

- [ ] **Step 3: Add the `cross-binding` page**

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
    missingVar: false,
    a: false,
    b: "",
  },
  onLocalBarTap() {
    // intentionally minimal
  },
});
```

Every WXML-referenced identifier is in `data`, so the page's baseline diagnostic state is clean (zero expression-ref or dead-component-binding diagnostics). Tests mutate `dataKeys` to drop ONE specific entry and assert exact resulting counts.

- [ ] **Step 4: Add the `dyn-page` page (for T13)**

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

The `data: { ...baseData, extra: "x" }` triggers `hasDynamicData = true` per the existing `containsSpread` check.

- [ ] **Step 5: Register both pages in `app.json`**

```bash
cat /Users/zs/Desktop/study/wxml-zed/fixtures/miniprogram/app.json
```

The existing file looks like:

```json
{
  "pages": [
    "pages/home/home",
    "pages/detail/detail"
  ],
  "subpackages": [
    {
      "root": "packages/shop",
      "pages": [
        "pages/list/list"
      ]
    }
  ]
}
```

Append `pages/cross-binding/cross-binding` and `pages/dyn-page/dyn-page` to the top-level `pages` array (preserving order, indentation, trailing newline). Result:

```json
{
  "pages": [
    "pages/home/home",
    "pages/detail/detail",
    "pages/cross-binding/cross-binding",
    "pages/dyn-page/dyn-page"
  ],
  "subpackages": [
    {
      "root": "packages/shop",
      "pages": [
        "pages/list/list"
      ]
    }
  ]
}
```

If app.json has other top-level keys (`window`, etc.), preserve them verbatim — only `pages` changes.

- [ ] **Step 6: Add element/attribute tracking stacks to the extractor walk**

In `shared/wxml-symbol-extractor.mjs`, locate `collectFile` (around line 135). Right after the existing `let templateDefinitionDepth = 0;` line, add:

```js
  // Track nearest enclosing element tag name and attribute name during the
  // walk. expressionRef entries pick up the top of each stack so diagnostics
  // can distinguish text-node interpolations (containingAttribute=null) from
  // component-tag prop bindings (containingAttribute=<name>). containingTag
  // is populated for ALL interpolations inside a valid WXML element —
  // including text nodes — so future Hover/Definition features have the
  // enclosing context to leverage.
  const elementStack = [];
  const attributeStack = [];
```

Locate `const walk = (node) => {` (around line 151). Add push logic immediately after the existing `if (isTemplateDef) templateDefinitionDepth += 1;` line:

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

Add the pop logic at the END of the walk function (after the recursion loop and the existing `if (isTemplateDef) templateDefinitionDepth -= 1;`):

```js
    if (pushedElement) elementStack.pop();
    if (pushedAttribute) attributeStack.pop();
```

- [ ] **Step 7: Use the stacks in the interpolation handler**

Locate the existing expressionRef push (around line 167):

```js
expressionRefs.push({
  name,
  source: "interpolation",
  inTemplateDefinition,
  range: {
    start: { row: startRow, column: startCol },
    end: { row: startRow, column: startCol + name.length },
  },
  expressionRange: exprRange,
});
```

Replace with:

```js
expressionRefs.push({
  name,
  source: "interpolation",
  inTemplateDefinition,
  range: {
    start: { row: startRow, column: startCol },
    end: { row: startRow, column: startCol + name.length },
  },
  expressionRange: exprRange,
  containingTag: elementStack.length > 0 ? elementStack[elementStack.length - 1] : null,
  containingAttribute: attributeStack.length > 0 ? attributeStack[attributeStack.length - 1] : null,
});
```

- [ ] **Step 8: Probe the new fields**

```bash
cd /Users/zs/Desktop/study/wxml-zed
node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/cross-binding/cross-binding.wxml | node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
const refs = data.files[0].expressionRefs;
console.log("Total refs:", refs.length);
for (const ref of refs) {
  console.log(`  name=${ref.name} containingTag=${JSON.stringify(ref.containingTag)} containingAttribute=${JSON.stringify(ref.containingAttribute)}`);
}
'
```

Expected: each expressionRef has both fields populated. Spot-checks:

- `theme` → `containingTag="view", containingAttribute="class"` (line 1: `<view class="... {{theme}}">`)
- `locationError` (multiple) → `containingTag="local-bar", containingAttribute="locationError"` (lines 2, 6)
- `missingVar` → `containingTag="local-bar", containingAttribute="locationError"` (line 3)
- `a` → `containingTag="local-bar", containingAttribute="locationError"` (line 4)
- `b` → `containingTag="local-bar", containingAttribute="referer"` (line 4)
- `shouldShow` → `containingTag="local-bar", containingAttribute="wx:if"` (line 6)
- `customId` → `containingTag="local-bar", containingAttribute="data-id"` (line 7)
- `customGeneric` → `containingTag="local-bar", containingAttribute="generic:Item"` (line 8)
- `dynValue` → `containingTag="dyn-card", containingAttribute="knownProp"` (line 9)
- `userInfo` → `containingTag="user-card", containingAttribute="user"` (line 10)
- `textValue` → `containingTag="view", containingAttribute=null` (line 11, text node inside `<view class="row">`)

If any ref shows unexpected `containingTag` / `containingAttribute`, the stack push/pop ordering is wrong — re-verify Step 6 places the push BEFORE recursion and the pop AFTER it.

- [ ] **Step 9: Regenerate all 7 wasm-spike baselines**

```bash
cd /Users/zs/Desktop/study/wxml-zed

# home-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > fixtures/wasm-spike/home-symbols-baseline.json

# miniprogram-symbols-baseline.json — glob mode over fixtures/miniprogram
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

- [ ] **Step 10: Inspect the diff — purely additive**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git diff --stat fixtures/wasm-spike/ fixtures/miniprogram/app.json
git diff fixtures/wasm-spike/home-symbols-baseline.json | head -60
```

Expected:

- Existing expressionRef entries gain `containingTag` and `containingAttribute` fields (with string or null values). No existing field values modified.
- `miniprogram-symbols-baseline.json` gets the largest addition: it now includes all expressionRefs from `cross-binding.wxml`, `dyn-page.wxml`, `local-bar.wxml`, `dyn-card.wxml`. These are new entries, not modifications.
- `app.json` has only the two new entries in the `pages` array.

If you see ANY existing fields changing values (not just adding new ones), STOP — investigate. The extractor must be byte-stable on existing fields.

- [ ] **Step 11: Run baseline verifier**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wasm-symbol-baselines.mjs 2>&1 | tail -5
```

Expected: PASS for all 7 cases.

- [ ] **Step 12: Run umbrella verifier**

```bash
bash /Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh 2>&1 | tail -3
```

Expected final line: `wxml-zed tree-sitter verification passed`. The umbrella covers all node-based sub-verifiers; if any tree-sitter-cli command fails with EACCES on the cached binary, chmod +x and retry (environmental, not a plan issue).

- [ ] **Step 13: Commit (single combined commit)**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add shared/wxml-symbol-extractor.mjs \
        fixtures/miniprogram/app.json \
        fixtures/miniprogram/components/local-bar/ \
        fixtures/miniprogram/components/dyn-card/ \
        fixtures/miniprogram/pages/cross-binding/ \
        fixtures/miniprogram/pages/dyn-page/ \
        fixtures/wasm-spike/
git commit -m "$(cat <<'EOF'
feat: containingTag/containingAttribute on expressionRefs + cross-binding fixtures

Extractor change (shared/wxml-symbol-extractor.mjs):

- Adds stack-based tracking of nearest enclosing element and
  attribute during the WXML walk. Each expressionRef now carries:
  - containingTag: string | null — innermost enclosing element's
    tag name. Populated for ANY interpolation inside a valid WXML
    element (including text-node interpolations). Future Hover /
    Definition features can leverage this even for non-attribute
    sites.
  - containingAttribute: string | null — innermost enclosing
    attribute's name, or null for text-node interpolations.
    The cross-component prop diagnostic prefilter uses this null
    check to distinguish attribute sites from text-node sites.

Fixtures (fixtures/miniprogram/):

- components/local-bar: clean Component with static properties
  (locationError, referer).
- components/dyn-card: Component with behaviors: [...] (sets
  hasDynamicData=true) PLUS static properties: { knownProp }.
  Drives the lookup-order regression lock — static propertyKeys
  hits must win over hasDynamicData=true.
- pages/cross-binding: page with cross-component binding sites.
  Every referenced identifier is in the page's default data so
  the baseline state is diagnostic-free; tests mutate dataKeys
  to drop ONE specific entry per case.
- pages/dyn-page: page with data: { ...spread, extra: "x" } so
  its script's hasDynamicData=true. Drives T13.
- app.json: registers both new pages.

Baselines (fixtures/wasm-spike/):

- All 7 *-symbols-baseline.json files regenerated. Existing
  expressionRefs gain the two new fields; the miniprogram
  baseline also picks up the new fixture files via its glob
  producer. Diff is purely additive on existing entries.

The umbrella `bash scripts/verify-tree-sitter.sh` is green at this
commit. No production code (server/) is changed yet; the new
fields are unread by current consumers.
EOF
)"
```

---

## Task 2: Language service — add helpers as unwired dead code

**Files:**
- Modify: `server/wxml-language-service.mjs` — add `INFORMATION` constant, `RESERVED_ATTRIBUTES` set, `RESERVED_ATTRIBUTE_PREFIXES` array, `isReservedAttribute()` helper, `findChildProperty()` helper.

Helpers land first as unreferenced dead code. Task 3 wires them in. Keeps each commit green.

- [ ] **Step 1: Add the `INFORMATION` severity constant**

In `server/wxml-language-service.mjs`, locate line 13:

```js
const WARNING = 2;
```

Replace with:

```js
const WARNING = 2;
const INFORMATION = 3;
```

- [ ] **Step 2: Add `RESERVED_ATTRIBUTES`, `RESERVED_ATTRIBUTE_PREFIXES`, `isReservedAttribute`**

Insert immediately after the severity constants:

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

Insert immediately before `function expressionRefDiagnostics(graph, documentGraphPath, fileModel) {` (around line 788):

```js
// Returns 'declared' | 'not-declared' | 'unresolvable'.
//
// 'declared'      — child's static propertyKeys provably contains the name.
//                   Even if child.script.hasDynamicData === true elsewhere
//                   (data spread, non-empty behaviors), a static hit is
//                   authoritative. Nothing in the rest of the script can
//                   REMOVE what the extractor already observed.
// 'not-declared'  — child resolves, prop set is fully knowable
//                   (no hasDynamicData), AND the name is not in propertyKeys.
// 'unresolvable'  — child has no resolved usingComponents entry, OR child
//                   resolves but has no JS, OR child has hasDynamicData=true
//                   AND the name is not in the static propertyKeys (might
//                   be injected by behaviors / spread).
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

- [ ] **Step 4: Verify existing tests still pass (helpers are dead code)**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wxml-language-service.mjs 2>&1 | tail -5
```

Expected: PASS. The helpers are unreferenced — nothing in `expressionRefDiagnostics` calls them yet.

- [ ] **Step 5: Commit helpers**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add server/wxml-language-service.mjs
git commit -m "$(cat <<'EOF'
feat: language-service helpers for cross-component prop binding

Adds to server/wxml-language-service.mjs as unreferenced dead code;
next commit wires them in:

- INFORMATION = 3 (LSP severity, alongside existing WARNING = 2).
- RESERVED_ATTRIBUTES set + RESERVED_ATTRIBUTE_PREFIXES array +
  isReservedAttribute(name) helper.
- findChildProperty(graph, ownerWxmlGraphPath, childTag,
  attributeName). Critical ordering: static propertyKeys hit wins
  over hasDynamicData. The extractor's static observation is
  authoritative for the keys it captured; hasDynamicData only kicks
  in when the name is NOT in static propertyKeys.

verify-wxml-language-service still passes with the existing test set.
EOF
)"
```

---

## Task 3: Wire dead-component-binding into expressionRefDiagnostics + first synthetic test (T5)

**Files:**
- Modify: `server/wxml-language-service.mjs` — extend `expressionRefDiagnostics` main loop.
- Modify: `scripts/verify-wxml-language-service.mjs` — add T5 (happy-path) with exact-count assertions; register in main run.

TDD commit: T5 is the smallest case that exercises the wiring end-to-end. The cross-binding fixture's default state is diagnostic-free (every identifier is in `dataKeys`), so removing `locationError` from `dataKeys` produces exactly the diagnostics T5 expects — no need to filter against background noise.

- [ ] **Step 1: Add path constants and helper to verify-wxml-language-service.mjs**

Near the top of `scripts/verify-wxml-language-service.mjs` (alongside `HOME_WXML` / `HOME_WXML_GRAPH_PATH`), add:

```js
const CROSS_BINDING_WXML = path.join(ROOT, "fixtures/miniprogram/pages/cross-binding/cross-binding.wxml");
const CROSS_BINDING_WXML_GRAPH_PATH = toPosixRelative(CROSS_BINDING_WXML);
const DYN_PAGE_WXML = path.join(ROOT, "fixtures/miniprogram/pages/dyn-page/dyn-page.wxml");
const DYN_PAGE_WXML_GRAPH_PATH = toPosixRelative(DYN_PAGE_WXML);
const LOCAL_BAR_CONFIG_PATH = "fixtures/miniprogram/components/local-bar/local-bar.json";
const DYN_CARD_CONFIG_PATH = "fixtures/miniprogram/components/dyn-card/dyn-card.json";
```

(Reuse the existing `toPosixRelative` helper or whichever name converts an absolute path to the graph-relative posix path. Look at how `HOME_WXML_GRAPH_PATH` is computed and mirror that.)

- [ ] **Step 2: Write T5 first (TDD — expect failure)**

After the existing `assertExpressionRefDiagnostic*` group, add:

```js
function assertCrossBindingT5DeclaredProp(graph) {
  // T5 (happy path): parent's <local-bar locationError="{{locationError}}">
  // on lines 2 and 6 of cross-binding.wxml. With locationError removed from
  // the page's dataKeys, both refs become unresolved against parent scope.
  // local-bar declares locationError as a property → exactly 2
  // dead-component-binding Information diagnostics for locationError,
  // and ZERO missing-expression-ref for locationError.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T5 setup: cross-binding config must have script");
  const originalDataKeys = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = originalDataKeys.filter((k) => k.name !== "locationError");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const allDead = diagnostics.filter((d) => d.code === "dead-component-binding");
    const locationErrorDead = allDead.filter((d) => d.message.includes('"locationError"'));
    const locationErrorWarn = diagnostics.filter((d) => (
      d.code === "missing-expression-ref" && d.message.includes('"locationError"')
    ));
    assert(
      locationErrorDead.length === 2,
      `T5: expected exactly 2 dead-component-binding for locationError; got ${locationErrorDead.length}. All: ${JSON.stringify(allDead)}`,
    );
    assert(
      locationErrorWarn.length === 0,
      `T5: locationError must NOT also be a warning; got ${locationErrorWarn.length}: ${JSON.stringify(locationErrorWarn)}`,
    );
    for (const d of locationErrorDead) {
      assert(d.severity === 3, `T5: severity ${d.severity} !== 3 for ${JSON.stringify(d)}`);
      assert(d.source === "wxml-zed", `T5: source ${d.source}`);
      assert(
        d.message.includes("receive undefined and use its property default if one exists"),
        `T5: message mismatch: ${d.message}`,
      );
    }
    // Also assert there are no UNEXPECTED diagnostics on this file
    // (locationError is the only thing removed; everything else should
    // remain in scope).
    const otherDiags = diagnostics.filter((d) => !d.message.includes('"locationError"'));
    assert(
      otherDiags.length === 0,
      `T5: unexpected non-locationError diagnostics: ${JSON.stringify(otherDiags)}`,
    );
  } finally {
    pageConfig.script.dataKeys = originalDataKeys;
  }
}
```

Register T5 in the main run function (look for where `assertExpressionRefDiagnosticClean(graph)` etc. are called; add `assertCrossBindingT5DeclaredProp(graph);` adjacent).

- [ ] **Step 3: Run the verifier — T5 must FAIL**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wxml-language-service.mjs 2>&1 | tail -10
```

Expected: T5 fails with `expected exactly 2 dead-component-binding for locationError; got 0`. Other tests pass.

If T5 produces a different failure (e.g., crash), investigate before continuing.

- [ ] **Step 4: Wire the helpers into `expressionRefDiagnostics`**

Locate the main loop (around lines 812-826):

```js
const refs = fileModel.expressionRefs ?? [];
const out = [];
for (const ref of refs) {
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

Replace with:

```js
const refs = fileModel.expressionRefs ?? [];
const out = [];
for (const ref of refs) {
  // Refs inside `<template name="X">...</template>` resolve in the caller's
  // data scope at use time (via `<template is="X" data="{{...}}"/>`), not
  // in this file's owner script. Skip — we don't have call-site context.
  if (ref.inTemplateDefinition) continue;
  if (scope.has(ref.name)) continue;

  // Cross-component prop binding check: if the failing identifier is
  // inside a non-reserved attribute and the child component statically
  // declares that attribute as a property, downgrade to
  // dead-component-binding Information.
  const isCandidateBinding =
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
    // status === 'not-declared' or 'unresolvable' → fall through to warning
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

The existing early return `if (ownerConfig.script.hasDynamicData) return [];` at the TOP of `expressionRefDiagnostics` (around line 791) is preserved verbatim. The new loop is gated by it.

- [ ] **Step 5: Re-run verifier — T5 must now PASS**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wxml-language-service.mjs 2>&1 | tail -5
```

Expected: all cases pass including T5.

Failure-mode triage:
- T5 fails with `got 0` → helpers aren't invoked. Verify `isReservedAttribute` / `findChildProperty` are defined in the same file as `expressionRefDiagnostics` (no import needed since same module).
- T5 fails with `severity X !== 3` → wrong constant. Verify `INFORMATION = 3` is defined at module top.
- T5 fails with `got N` where N !== 2 → either extra refs to locationError exist (check the WXML — should be lines 2 and 6 only) or one of the refs isn't getting caught.
- T5 fails with `locationError must NOT also be a warning` → the new branch has `continue;` missing after the `out.push(dead-component-binding)`.

- [ ] **Step 6: Run umbrella**

```bash
bash /Users/zs/Desktop/study/wxml-zed/scripts/verify-tree-sitter.sh 2>&1 | tail -3
```

Expected: `wxml-zed tree-sitter verification passed`.

- [ ] **Step 7: Commit wiring + T5**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "$(cat <<'EOF'
feat: dead-component-binding diagnostic + T5 happy-path regression lock

Wires isReservedAttribute and findChildProperty (landed in previous
commit) into expressionRefDiagnostics. When an expression ref's
identifier is missing from parent scope but is inside a non-reserved
attribute AND the child component statically declares the attribute
as a property, emit dead-component-binding (severity 3 Information)
instead of the existing missing-expression-ref (severity 2 Warning).

Loop ordering (top to bottom):
1. inTemplateDefinition → skip entirely
2. scope.has(ref.name) → clean, skip
3. isCandidateBinding (non-null containingAttribute, not reserved):
   - findChildProperty 'declared' → emit dead-component-binding
   - 'not-declared' or 'unresolvable' → fall through
4. emit missing-expression-ref warning (existing behavior)

The existing early-return for parent's hasDynamicData=true is
preserved verbatim above the loop — parent scope completeness
inheritance.

T5 regression-locks the happy path with exact-count assertions:
removing locationError from cross-binding's dataKeys must produce
EXACTLY 2 dead-component-binding (lines 2 and 6), 0 missing-
expression-ref for the same name, and no other diagnostics.
EOF
)"
```

---

## Task 4: Remaining 14 synthetic cases (T1–T4, T6–T13) with exact-count assertions

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs` — add 14 assertion functions, register in main run.

Each test mutates ONE specific graph entry, computes diagnostics, and asserts the EXACT resulting code/count distribution. The cross-binding fixture's default state is diagnostic-free (all identifiers are in `dataKeys`), so each mutation produces a deterministic set of diagnostics — no `.find()` masking.

For each test below, the mutation is shown explicitly and the expected diagnostic counts are precise.

- [ ] **Step 1: T1 — built-in tag, reserved attribute (class)**

```js
function assertCrossBindingT1BuiltinTag(graph) {
  // T1: remove `theme` from data → line 1's <view class="container {{theme}}">
  // produces exactly 1 missing-expression-ref. No dead-component-binding
  // (view is a built-in tag; class is a reserved attribute regardless).
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T1 setup: cross-binding config must have script");
  const originalDataKeys = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = originalDataKeys.filter((k) => k.name !== "theme");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"theme"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"theme"'));
    assert(warn.length === 1, `T1: expected exactly 1 missing-expression-ref for theme; got ${warn.length}`);
    assert(dead.length === 0, `T1: theme must NOT be dead-component-binding; got ${dead.length}`);
    const others = diagnostics.filter((d) => !d.message.includes('"theme"'));
    assert(others.length === 0, `T1: unexpected non-theme diagnostics: ${JSON.stringify(others)}`);
  } finally {
    pageConfig.script.dataKeys = originalDataKeys;
  }
}
```

- [ ] **Step 2: T2 — component tag, reserved attribute (wx:if)**

```js
function assertCrossBindingT2ReservedWxIf(graph) {
  // T2: remove `shouldShow` from data → line 6's <local-bar wx:if="{{shouldShow}}" ...>
  // produces missing-expression-ref. wx:if is reserved; even though local-bar
  // is a component, the attr is reserved → no dead-component-binding.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T2 setup");
  const original = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = original.filter((k) => k.name !== "shouldShow");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"shouldShow"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"shouldShow"'));
    assert(warn.length === 1, `T2: expected 1 missing-expression-ref for shouldShow; got ${warn.length}`);
    assert(dead.length === 0, `T2: shouldShow must NOT be dead-component-binding (wx:if reserved); got ${dead.length}`);
    const others = diagnostics.filter((d) => !d.message.includes('"shouldShow"'));
    assert(others.length === 0, `T2: unexpected others: ${JSON.stringify(others)}`);
  } finally {
    pageConfig.script.dataKeys = original;
  }
}
```

- [ ] **Step 3: T3 — component tag, reserved prefix (data-)**

```js
function assertCrossBindingT3ReservedDataPrefix(graph) {
  // T3: remove `customId` from data → line 7's <local-bar data-id="{{customId}}">
  // produces missing-expression-ref. data-* is a reserved prefix.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T3 setup");
  const original = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = original.filter((k) => k.name !== "customId");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"customId"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"customId"'));
    assert(warn.length === 1, `T3: expected 1 missing-expression-ref for customId; got ${warn.length}`);
    assert(dead.length === 0, `T3: customId must NOT be dead-component-binding (data- reserved); got ${dead.length}`);
    const others = diagnostics.filter((d) => !d.message.includes('"customId"'));
    assert(others.length === 0, `T3: unexpected others: ${JSON.stringify(others)}`);
  } finally {
    pageConfig.script.dataKeys = original;
  }
}
```

- [ ] **Step 4: T4 — component tag, reserved prefix (generic:)**

```js
function assertCrossBindingT4ReservedGenericPrefix(graph) {
  // T4: remove `customGeneric` from data → line 8's <local-bar generic:Item="{{customGeneric}}">
  // produces missing-expression-ref. generic:* is a reserved prefix.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T4 setup");
  const original = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = original.filter((k) => k.name !== "customGeneric");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"customGeneric"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"customGeneric"'));
    assert(warn.length === 1, `T4: expected 1 missing-expression-ref for customGeneric; got ${warn.length}`);
    assert(dead.length === 0, `T4: customGeneric must NOT be dead-component-binding (generic: reserved); got ${dead.length}`);
    const others = diagnostics.filter((d) => !d.message.includes('"customGeneric"'));
    assert(others.length === 0, `T4: unexpected others: ${JSON.stringify(others)}`);
  } finally {
    pageConfig.script.dataKeys = original;
  }
}
```

- [ ] **Step 5: T6 — child resolved but attr not in propertyKeys**

```js
function assertCrossBindingT6ChildLacksProp(graph) {
  // T6: remove `locationError` from page data AND from local-bar propertyKeys.
  // Lines 2 + 6 reference {{locationError}} on local-bar's `locationError`
  // attribute. local-bar no longer declares it. Expect 2 missing-expression-ref
  // and 0 dead-component-binding.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const childConfig = graph.configs.find((c) => c.path === LOCAL_BAR_CONFIG_PATH);
  assert(pageConfig?.script && childConfig?.script, "T6 setup");
  const origPage = pageConfig.script.dataKeys;
  const origChild = childConfig.script.propertyKeys;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "locationError");
  childConfig.script.propertyKeys = origChild.filter((k) => k.name !== "locationError");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"locationError"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"locationError"'));
    assert(warn.length === 2, `T6: expected 2 missing-expression-ref for locationError; got ${warn.length}`);
    assert(dead.length === 0, `T6: locationError must NOT be dead-component-binding (child lacks prop); got ${dead.length}`);
    for (const d of warn) assert(d.severity === 2, `T6: severity ${d.severity} !== 2`);
  } finally {
    pageConfig.script.dataKeys = origPage;
    childConfig.script.propertyKeys = origChild;
  }
}
```

- [ ] **Step 6: T7 — child resolved but script is undefined**

```js
function assertCrossBindingT7ChildNoScript(graph) {
  // T7: remove `locationError` from page + delete local-bar's script entirely.
  // findChildProperty returns 'unresolvable' (no script). Expect 2
  // missing-expression-ref, 0 dead-component-binding.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const childConfig = graph.configs.find((c) => c.path === LOCAL_BAR_CONFIG_PATH);
  assert(pageConfig?.script && childConfig?.script, "T7 setup");
  const origPage = pageConfig.script.dataKeys;
  const origChildScript = childConfig.script;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "locationError");
  delete childConfig.script;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"locationError"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"locationError"'));
    assert(warn.length === 2, `T7: expected 2 missing-expression-ref for locationError; got ${warn.length}`);
    assert(dead.length === 0, `T7: must NOT be dead-component-binding (child has no script); got ${dead.length}`);
  } finally {
    pageConfig.script.dataKeys = origPage;
    childConfig.script = origChildScript;
  }
}
```

- [ ] **Step 7: T8a — behaviors=non-empty AND static hit wins (regression lock)**

```js
function assertCrossBindingT8aStaticHitWinsOverDynamic(graph) {
  // T8a (regression lock for lookup ordering): dyn-card has behaviors
  // (hasDynamicData=true) AND statically declares knownProp. Remove dynValue
  // from page data. Line 9's <dyn-card knownProp="{{dynValue}}"> must
  // downgrade to dead-component-binding because the static propertyKeys
  // hit precedes the hasDynamicData fallback.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const dynCardConfig = graph.configs.find((c) => c.path === DYN_CARD_CONFIG_PATH);
  assert(pageConfig?.script && dynCardConfig?.script, "T8a setup");
  assert(dynCardConfig.script.hasDynamicData === true, "T8a setup: dyn-card must have hasDynamicData=true");
  assert(dynCardConfig.script.propertyKeys.some((k) => k.name === "knownProp"), "T8a setup: dyn-card must declare knownProp");
  const origPage = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "dynValue");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"dynValue"'));
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"dynValue"'));
    assert(dead.length === 1, `T8a: expected 1 dead-component-binding for dynValue (static hit wins); got ${dead.length}`);
    assert(warn.length === 0, `T8a: dynValue must NOT be a warning; got ${warn.length}`);
    assert(dead[0].severity === 3, `T8a: severity ${dead[0].severity} !== 3`);
  } finally {
    pageConfig.script.dataKeys = origPage;
  }
}
```

- [ ] **Step 8: T8b — behaviors=non-empty AND child does NOT declare prop**

```js
function assertCrossBindingT8bDynamicChildLacksProp(graph) {
  // T8b: remove dynValue from page AND remove knownProp from dyn-card's
  // propertyKeys. dyn-card still has hasDynamicData=true (from behaviors).
  // findChildProperty: not in static set + hasDynamicData → 'unresolvable'.
  // Expect 1 missing-expression-ref, 0 dead-component-binding.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const dynCardConfig = graph.configs.find((c) => c.path === DYN_CARD_CONFIG_PATH);
  assert(pageConfig?.script && dynCardConfig?.script, "T8b setup");
  const origPage = pageConfig.script.dataKeys;
  const origChild = dynCardConfig.script.propertyKeys;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "dynValue");
  dynCardConfig.script.propertyKeys = origChild.filter((k) => k.name !== "knownProp");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"dynValue"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"dynValue"'));
    assert(warn.length === 1, `T8b: expected 1 missing-expression-ref; got ${warn.length}`);
    assert(dead.length === 0, `T8b: must NOT be dead-component-binding (no static hit + hasDynamicData → unresolvable); got ${dead.length}`);
  } finally {
    pageConfig.script.dataKeys = origPage;
    dynCardConfig.script.propertyKeys = origChild;
  }
}
```

- [ ] **Step 9: T8c — child has hasDynamicData=true (simulated data spread) AND static hit wins**

```js
function assertCrossBindingT8cDataSpreadStaticHit(graph) {
  // T8c: remove locationError from page AND set local-bar.script.hasDynamicData=true
  // (simulates the child having data: { ...spread } elsewhere). propertyKeys
  // still contains locationError. Static hit must still win → 2
  // dead-component-binding.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const childConfig = graph.configs.find((c) => c.path === LOCAL_BAR_CONFIG_PATH);
  assert(pageConfig?.script && childConfig?.script, "T8c setup");
  const origPage = pageConfig.script.dataKeys;
  const origHasDynamic = childConfig.script.hasDynamicData;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "locationError");
  childConfig.script.hasDynamicData = true;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"locationError"'));
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"locationError"'));
    assert(dead.length === 2, `T8c: expected 2 dead-component-binding for locationError; got ${dead.length}`);
    assert(warn.length === 0, `T8c: locationError must NOT be a warning; got ${warn.length}`);
  } finally {
    pageConfig.script.dataKeys = origPage;
    childConfig.script.hasDynamicData = origHasDynamic;
  }
}
```

- [ ] **Step 10: T9 — inTemplateDefinition short-circuit precedence**

```js
function assertCrossBindingT9InTemplateDefSkipped(graph) {
  // T9: mutate ONE specific locationError ref's inTemplateDefinition flag to
  // true. Then remove locationError from page data. The flagged ref must be
  // suppressed entirely; the other (unflagged) ref still emits.
  // Expect 1 dead-component-binding (NOT 2 — one was suppressed).
  const wxmlEntry = graph.wxml.find((w) => w.path === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(wxmlEntry, "T9 setup: cross-binding wxml entry");
  const targets = wxmlEntry.expressionRefs.filter((r) => (
    r.name === "locationError" &&
    r.containingTag === "local-bar" &&
    r.containingAttribute === "locationError"
  ));
  assert(targets.length === 2, `T9 setup: expected 2 locationError refs on local-bar.locationError; got ${targets.length}`);
  const ref = targets[0];
  const originalFlag = ref.inTemplateDefinition;
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const origPage = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "locationError");
  ref.inTemplateDefinition = true;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"locationError"'));
    assert(dead.length === 1, `T9: expected exactly 1 dead-component-binding (other was suppressed by inTemplateDefinition); got ${dead.length}`);
  } finally {
    pageConfig.script.dataKeys = origPage;
    ref.inTemplateDefinition = originalFlag;
  }
}
```

- [ ] **Step 11: T10 — lookup by attribute name, not identifier name**

```js
function assertCrossBindingT10LookupByAttributeName(graph) {
  // T10 (regression lock): line 3 has <local-bar locationError="{{missingVar}}"/>.
  // Remove missingVar from page data. The identifier 'missingVar' is NOT a
  // property of local-bar — but the attribute 'locationError' IS. Lookup must
  // key on attribute name → 1 dead-component-binding for missingVar.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T10 setup");
  const original = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = original.filter((k) => k.name !== "missingVar");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"missingVar"'));
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"missingVar"'));
    assert(dead.length === 1, `T10: expected 1 dead-component-binding for missingVar (lookup by attribute name); got ${dead.length}`);
    assert(warn.length === 0, `T10: missingVar must NOT be a warning; got ${warn.length}`);
    assert(
      dead[0].message.includes('"locationError"'),
      `T10: message must mention the attribute name "locationError"; got ${dead[0].message}`,
    );
  } finally {
    pageConfig.script.dataKeys = original;
  }
}
```

- [ ] **Step 12: T11 — multi-attribute on same tag, independent diagnostics**

```js
function assertCrossBindingT11MultiAttrIndependent(graph) {
  // T11: line 4 has <local-bar locationError="{{a}}" referer="{{b}}"/>. Remove
  // BOTH 'a' and 'b' from page data. local-bar declares BOTH locationError
  // AND referer. Expect 2 dead-component-binding total — one for each attr.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T11 setup");
  const original = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = original.filter((k) => k.name !== "a" && k.name !== "b");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const aDead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"a"'));
    const bDead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"b"'));
    assert(aDead.length === 1, `T11: expected 1 dead-component-binding for 'a'; got ${aDead.length}`);
    assert(bDead.length === 1, `T11: expected 1 dead-component-binding for 'b'; got ${bDead.length}`);
    assert(aDead[0].message.includes('"locationError"'), `T11: 'a' must mention locationError attr`);
    assert(bDead[0].message.includes('"referer"'), `T11: 'b' must mention referer attr`);
    const totalNonAB = diagnostics.filter((d) => !d.message.includes('"a"') && !d.message.includes('"b"'));
    assert(totalNonAB.length === 0, `T11: unexpected others: ${JSON.stringify(totalNonAB)}`);
  } finally {
    pageConfig.script.dataKeys = original;
  }
}
```

- [ ] **Step 13: T12 — bind: prefix reserved, event-handler unaffected**

```js
function assertCrossBindingT12EventBindingNotAffected(graph) {
  // T12: line 5 has <local-bar bind:tap="onLocalBarTap"/>. Remove
  // onLocalBarTap from the page's methods. The existing missing-event-handler
  // rule must fire (1 diagnostic); the new dead-component-binding rule must
  // NOT fire (bind: is reserved).
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T12 setup");
  const original = pageConfig.script.methods;
  pageConfig.script.methods = original.filter((m) => m.name !== "onLocalBarTap");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const handlerMiss = diagnostics.filter((d) => d.code === "missing-event-handler" && d.message.includes("onLocalBarTap"));
    const handlerDead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes("onLocalBarTap"));
    assert(handlerMiss.length === 1, `T12: expected 1 missing-event-handler for onLocalBarTap; got ${handlerMiss.length}`);
    assert(handlerDead.length === 0, `T12: onLocalBarTap must NOT be dead-component-binding (bind: reserved); got ${handlerDead.length}`);
  } finally {
    pageConfig.script.methods = original;
  }
}
```

- [ ] **Step 14: T13 — parent hasDynamicData=true suppresses ALL expression diagnostics**

```js
function assertDynPageT13ParentDynamicBlocksAll(graph) {
  // T13: dyn-page has data: { ...spread } → script.hasDynamicData=true. Its
  // wxml has <local-bar locationError="{{undefVar}}"/>. local-bar declares
  // locationError. Without the inheritance, this would be a dead-component-
  // binding. With the inheritance, the existing early return in
  // expressionRefDiagnostics suppresses ALL expression diagnostics including
  // dead-component-binding. Expect 0 diagnostics of either code.
  const dynConfig = graph.configs.find((c) => c.owner === DYN_PAGE_WXML_GRAPH_PATH);
  assert(dynConfig?.script, "T13 setup: dyn-page config");
  assert(dynConfig.script.hasDynamicData === true, "T13 setup: dyn-page must have hasDynamicData=true");
  const diagnostics = getDiagnostics({ graph, documentPath: DYN_PAGE_WXML, extensionRoot: ROOT });
  const exprDiags = diagnostics.filter((d) => (
    d.code === "missing-expression-ref" || d.code === "dead-component-binding"
  ));
  assert(
    exprDiags.length === 0,
    `T13: parent hasDynamicData=true must suppress ALL expression diagnostics; got ${exprDiags.length}: ${JSON.stringify(exprDiags)}`,
  );
}
```

- [ ] **Step 15: Register all 14 in the main run**

In the same orchestration function where T5 was registered (Task 3 Step 2), add adjacent calls:

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

- [ ] **Step 16: Run verifier — all 15 cases (T1–T13 + T5) must PASS**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-wxml-language-service.mjs 2>&1 | tail -8
```

Expected: all PASS. Failure-mode triage uses the per-test error message verbatim — exact-count assertions point directly at the broken branch.

- [ ] **Step 17: Run umbrella**

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

Adds T1-T4, T6-T13 to verify-wxml-language-service.mjs with exact-
count assertions (not .find()-style; each test asserts the precise
diagnostic distribution after a specific dataKeys / propertyKeys
mutation). Together with T5 (landed previously), the 15 assertions
exhaust the decision matrix:

- T1: built-in tag with reserved attr (class)            → 1 warning
- T2: component tag with reserved attr (wx:if)           → 1 warning
- T3: component tag with reserved prefix (data-)         → 1 warning
- T4: component tag with reserved prefix (generic:)      → 1 warning
- T5: component tag, custom attr, child declares prop    → 2 info
- T6: component tag, custom attr, child does NOT declare → 2 warning
- T7: component tag, custom attr, child has no script    → 2 warning
- T8a: behaviors=non-empty, static propertyKeys has attr → 1 info
       (regression lock: static hit wins over hasDynamicData)
- T8b: behaviors=non-empty, propertyKeys lacks attr      → 1 warning
- T8c: data spread + static propertyKeys has attr        → 2 info
- T9: inTemplateDefinition=true suppresses ref           → 1 info
       (only 1 — the other locationError ref is unflagged)
- T10: lookup by attribute name (regression lock)        → 1 info
       (identifier missingVar isn't a child prop, but
        attribute locationError IS — message mentions
        locationError, not missingVar)
- T11: multi-attr on same tag, both unresolved           → 2 info
       (independent diagnostics for each attribute)
- T12: bind: reserved, event handler unaffected          → 1 missing-event-handler
       (new rule doesn't intercept event-handler path)
- T13: parent's hasDynamicData=true                      → 0 diagnostics
       (existing early return inherits to new code too)

All mutations are try/finally restored. Fixture file content
unchanged from Task 1.
EOF
)"
```

---

## Task 5: LSP protocol-layer tests (L1, L2)

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs` — add L1 and L2 in the `graph-smoke` suite.

The language-service tests prove logic; LSP tests prove wire format. L2 specifically uses `changeDocument` to engineer a state where BOTH a `dead-component-binding` and a `missing-event-handler` exist on the same file's published diagnostics — proving the new rule does not suppress the existing event-handler diagnostic at the protocol layer.

- [ ] **Step 1: Add path constants and locate insertion point**

In `scripts/verify-lsp-diagnostics.mjs`, locate the existing fixture path constants. Add adjacent:

```js
const CROSS_BINDING_WXML = path.join(MINI_ROOT, "pages/cross-binding/cross-binding.wxml");
```

(Reuse `MINI_ROOT` or whichever constant points at `fixtures/miniprogram/`.)

- [ ] **Step 2: Add L1 — dead-component-binding wire format**

```js
async function testDeadComponentBindingWireFormat() {
  // L1: open cross-binding.wxml. The fixture's default data includes 'a' so
  // line 4's <local-bar locationError="{{a}}"> would be clean. To engineer
  // a dead-component-binding via the LSP path, use changeDocument to drop
  // 'a' from references (i.e., switch the binding to a known-undefined
  // identifier).
  //
  // Strategy: open the doc, await initial empty diagnostics, then
  // changeDocument to a WXML where one binding references an undefined
  // identifier (which local-bar declares as a prop). Assert that
  // publishDiagnostics carries dead-component-binding with severity 3.
  await withClient({ rootPath: MINI_ROOT }, async (client) => {
    const uri = client.openDocument(CROSS_BINDING_WXML);
    await client.waitForDiagnostics(
      uri,
      (items) => items.length === 0,
      "L1: initial cross-binding diagnostics empty (baseline)",
    );

    // Inject an undefined identifier into a custom attribute on local-bar.
    // local-bar declares locationError as a property, so this should produce
    // exactly one dead-component-binding.
    const modified = `<view class="container {{theme}}">
  <local-bar locationError="{{__undef_a__}}" referer="{{referer}}" />
  <view class="row">{{textValue}}</view>
</view>
`;
    const cursor = client.diagnosticCursor();
    client.changeDocument(CROSS_BINDING_WXML, modified);

    const params = await client.waitForDiagnosticsAfter(
      uri,
      cursor,
      (items) => items.some((d) => d.code === "dead-component-binding" && d.message.includes('"__undef_a__"')),
      "L1: dead-component-binding for __undef_a__ via LSP wire",
    );
    const items = params.diagnostics;
    const dead = items.filter((d) => d.code === "dead-component-binding" && d.message.includes('"__undef_a__"'));
    const warn = items.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"__undef_a__"'));
    assert(dead.length === 1, `L1: expected 1 dead-component-binding for __undef_a__; got ${dead.length}`);
    assert(dead[0].severity === 3, `L1: severity ${dead[0].severity} !== 3`);
    assert(warn.length === 0, `L1: __undef_a__ must NOT also be a warning; got ${warn.length}`);
  });
}
```

- [ ] **Step 3: Add L2 — new rule doesn't suppress existing event-handler diagnostic (via didChange)**

```js
async function testDeadComponentBindingPreservesEventHandler() {
  // L2: engineer a state where the file's publishDiagnostics carries BOTH a
  // dead-component-binding AND a missing-event-handler. Open cross-binding,
  // then changeDocument so:
  // - line has <local-bar locationError="{{__undef_a__}}"> → dead-component-binding
  // - line has <local-bar bind:tap="__notInJs__"> → missing-event-handler
  //
  // Assert both appear in the SAME publishDiagnostics. Proves the new rule
  // does not suppress event-handler diagnostics at the wire layer.
  await withClient({ rootPath: MINI_ROOT }, async (client) => {
    const uri = client.openDocument(CROSS_BINDING_WXML);
    await client.waitForDiagnostics(
      uri,
      (items) => items.length === 0,
      "L2: initial cross-binding diagnostics empty (baseline)",
    );

    const modified = `<view class="container {{theme}}">
  <local-bar locationError="{{__undef_a__}}" />
  <local-bar bind:tap="__notInJs__" />
  <view class="row">{{textValue}}</view>
</view>
`;
    const cursor = client.diagnosticCursor();
    client.changeDocument(CROSS_BINDING_WXML, modified);

    const params = await client.waitForDiagnosticsAfter(
      uri,
      cursor,
      (items) => (
        items.some((d) => d.code === "dead-component-binding" && d.message.includes('"__undef_a__"')) &&
        items.some((d) => d.code === "missing-event-handler" && d.message.includes("__notInJs__"))
      ),
      "L2: both dead-component-binding and missing-event-handler on same file",
    );
    const items = params.diagnostics;
    const dead = items.filter((d) => d.code === "dead-component-binding");
    const handler = items.filter((d) => d.code === "missing-event-handler" && d.message.includes("__notInJs__"));
    assert(dead.length >= 1, `L2: expected at least 1 dead-component-binding; got ${dead.length}`);
    assert(handler.length === 1, `L2: expected exactly 1 missing-event-handler for __notInJs__; got ${handler.length}: ${JSON.stringify(handler)}`);
    assert(dead.some((d) => d.severity === 3), "L2: at least one dead-component-binding must have severity 3");
    assert(handler[0].severity === 2, `L2: missing-event-handler severity ${handler[0].severity} !== 2`);
  });
}
```

- [ ] **Step 4: Register L1 and L2 in the graph-smoke scenario list**

Find the existing `scenarios` array (around line 1555 — see `grep -n "^const scenarios" scripts/verify-lsp-diagnostics.mjs`). Add entries:

```js
["dead-component-binding wire format", testDeadComponentBindingWireFormat],
["dead-component-binding preserves event handler", testDeadComponentBindingPreservesEventHandler],
```

Add to `SCENARIO_SUITES["graph-smoke"]`:

```js
"dead-component-binding wire format",
"dead-component-binding preserves event handler",
```

- [ ] **Step 5: Run the graph-smoke suite**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/verify-lsp-diagnostics.mjs --suite graph-smoke 2>&1 | tail -20
```

Expected: PASS for all existing tests + L1 + L2 (15 total).

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
test: LSP protocol-layer tests for dead-component-binding (L1, L2)

L1: testDeadComponentBindingWireFormat — opens cross-binding.wxml,
uses changeDocument to inject an undefined identifier into
<local-bar locationError="{{__undef_a__}}">, awaits publishDiagnostics,
asserts exactly one diagnostic with code "dead-component-binding"
and severity 3 for __undef_a__, and zero "missing-expression-ref"
for the same name.

L2: testDeadComponentBindingPreservesEventHandler — uses
changeDocument to put BOTH a dead-component-binding-triggering
binding AND a missing-event-handler-triggering bind:tap in the same
file. Asserts publishDiagnostics carries both in the same publish:
the new rule does not consume or suppress the existing event-handler
diagnostic path at the wire layer.

Closes the wire-format gap (language-service tests can be green
while publishDiagnostics emits the wrong shape; protocol tests
prevent that drift).
EOF
)"
```

---

## Task 6: Real-project dogfood + Outcome notes

**Files:**
- Read: `/tmp/wxml-zed-diagnostics-p22b/before/wx.summary.json` (from Task 0).
- Write: `/tmp/wxml-zed-diagnostics-p22b/after/*` (fresh AFTER dump).
- Modify: this plan file — add Outcome section.
- Modify: `docs/wasm-parser-spike-notes.md` — append follow-up.

- [ ] **Step 1: Create the AFTER snapshot directory**

```bash
mkdir -p /tmp/wxml-zed-diagnostics-p22b/after
```

- [ ] **Step 2: Run dump against chelaile, write AFTER to the explicit path**

```bash
node /Users/zs/Desktop/study/wxml-zed/scripts/dump-project-diagnostics.mjs \
  /Users/zs/Desktop/zs_work/mp-wx-chelaile/wx \
  --out /tmp/wxml-zed-diagnostics-p22b/after
```

Writes:
- `/tmp/wxml-zed-diagnostics-p22b/after/wx.summary.json`
- `/tmp/wxml-zed-diagnostics-p22b/after/wx.summary.txt`
- `/tmp/wxml-zed-diagnostics-p22b/after/wx.jsonl`

- [ ] **Step 3: Programmatic acceptance verification**

```bash
node -e '
const before = JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-diagnostics-p22b/before/wx.summary.json"));
const after  = JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-diagnostics-p22b/after/wx.summary.json"));
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
'
```

Required: every check PASSES; exit 0.

If any check fails: investigate before committing. The known cross-binding samples (`locationError` on 3 files, `popupLevel` on 1 file from P2 round 1's classification) should produce dead-component-binding entries IF the corresponding child components declare those props statically. Trace via:

```bash
grep '"code":"missing-expression-ref"' /tmp/wxml-zed-diagnostics-p22b/after/wx.jsonl | head -10
```

- [ ] **Step 4: Stratified 10-sample classification of surviving missing-expression-ref**

```bash
grep '"code":"missing-expression-ref"' /tmp/wxml-zed-diagnostics-p22b/after/wx.jsonl | shuf -n 10 | while read -r line; do
  echo "$line" | node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(`\n${d.file}:${d.line+1}  name=${d.name}`);
    for (const s of (d.snippet || [])) console.log(`  ${s.marker} ${s.line+1}: ${s.source.slice(0, 200)}`);
  '
done
```

Classify each sample. Likely buckets:

- **library-mediated computed/spread setData** (from P2 round 1 — still surviving)
- **child truly lacks the prop API** (C4 — real binding bug, kept warning correctly)
- **child can't be resolved** (C3 — usingComponents missing entry or hasDynamicData + no static hit)
- **other**

- [ ] **Step 5: Write the Outcome section into this plan**

Append to the end of `/Users/zs/Desktop/study/wxml-zed/docs/superpowers/plans/2026-05-22-cross-component-prop-binding-diagnostic.md`:

```markdown
## Outcome

Before / after on `mp-wx-chelaile/wx`:

| metric | BEFORE (P2 round 1 AFTER) | AFTER (P2.2-B) |
|---|---|---|
| total | <BEFORE total> | <AFTER total> |
| missing-event-handler | <BEFORE evt> | <AFTER evt> |
| missing-expression-ref | <BEFORE expr> | <AFTER expr> |
| dead-component-binding | 0 | <AFTER dead> |

Hard gates (all passed):
- missing-event-handler unchanged
- Total count did not increase
- dead-component-binding count >= 1

10-sample classification (surviving missing-expression-ref):

- `<file>:<line>` (name=`<x>`) — <bucket>: <reason>
- ... (up to 10)

Buckets (next-round input):

- <bucket>: <count>
```

Replace each `<...>` placeholder with actual data from Step 3 / Step 4. The plan must have ZERO `<>`-style placeholders remaining before commit.

- [ ] **Step 6: Append spike-notes follow-up**

Append to `/Users/zs/Desktop/study/wxml-zed/docs/wasm-parser-spike-notes.md` AFTER the existing "Follow-up: setData-derived template scope keys" section's closing `---`:

```markdown
### Follow-up: cross-component prop binding diagnostic

P2.2-B added a new diagnostic code `dead-component-binding` (LSP
Information severity) downgrading missing-expression-ref warnings
at component-tag custom-attribute binding sites when the child
statically declares the attribute as a property. Plan:
`docs/superpowers/plans/2026-05-22-cross-component-prop-binding-diagnostic.md`.

Lookup direction: by attribute name (child's prop API), not by
expression identifier (parent's namespace). Order: trust static
propertyKeys hit first; consult hasDynamicData only when the name
is NOT in the static set. Parent's own hasDynamicData=true still
suppresses ALL expression diagnostics including the new code
(parent-scope-completeness inheritance).

Outcome on the same chelaile snapshot: <BEFORE total> -> <AFTER total>
total. The <BEFORE evt> missing-event-handler diagnostics (all real
bugs) preserved unchanged. dead-component-binding count: 0 ->
<AFTER dead>, absorbing the cross-component samples from P2 round
1's surviving classification. See plan's Outcome section.

---
```

Replace placeholders with real numbers.

- [ ] **Step 7: Commit**

```bash
cd /Users/zs/Desktop/study/wxml-zed
git add docs/superpowers/plans/2026-05-22-cross-component-prop-binding-diagnostic.md docs/wasm-parser-spike-notes.md
git commit -m "$(cat <<'EOF'
docs: record cross-component prop binding dogfood outcome on chelaile

Captures the before/after diagnostic counts after dead-component-
binding (P2.2-B) lands. missing-event-handler stays unchanged
(precision preserved); total did not increase; dead-component-
binding count: 0 -> N, absorbing the known cross-component samples
from P2 round 1's surviving classification.

10-sample surviving classification scopes the next round's input.
EOF
)"
```

---

## Acceptance Criteria

These are absolute pass/fail gates:

1. All existing tests pass (`bash scripts/verify-tree-sitter.sh` reports `wxml-zed tree-sitter verification passed`).
2. `verify-wxml-language-service.mjs` reports all 15 new synthetic cases (T1–T13 with T8a/b/c) pass with exact-count assertions.
3. `verify-lsp-diagnostics.mjs --suite graph-smoke` reports L1 and L2 pass alongside the existing tests. L2 specifically uses `changeDocument` to engineer a state where both a `dead-component-binding` and a `missing-event-handler` are published together — proving the new rule does not suppress the existing event-handler diagnostic at the protocol layer.
4. Baseline regeneration in Task 1 was purely additive (no existing field values modified, no entries removed).
5. `dump-project-diagnostics.mjs` on `mp-wx-chelaile/wx` (Task 6) compared against the Task 0 BEFORE snapshot:
   - `missing-event-handler` unchanged
   - Total count not increased
   - `dead-component-binding` count at least 1
6. The Outcome section in this plan and the spike-notes follow-up have real numbers (no `<...>` placeholders remaining) before the final commit lands.
7. Every commit on the implementation branch is independently green (no red intermediate state).

## Self-Review

- All file paths absolute and resolve to real locations.
- All synthetic test cases include exact mutation + exact-count assertions; no `.find()`-only assertions that could mask over-emission.
- Lookup order in `findChildProperty` matches the spec: static propertyKeys hit FIRST, then hasDynamicData, then not-declared. T8a regression-locks this against future regression.
- Diagnostic message string is consistent: Task 3 Step 4 implementation and T5 assertion use the same text ("receive undefined and use its property default if one exists").
- The parent-scope-completeness inheritance (existing `hasDynamicData` early return) is preserved unchanged in Task 3 Step 4 and locked by T13.
- Severity constant: `INFORMATION = 3` defined once in Task 2 Step 1; consumed in Task 3 Step 4; asserted with `severity === 3` in T5, T8a, T8c, L1.
- Reserved attribute set + prefix array: identical between Task 2 Step 2 and the assertions in T2/T3/T4/T12. Reserved set = {wx:if, wx:elif, wx:else, wx:for, wx:for-item, wx:for-index, wx:key, class, style, id, slot, hidden}; reserved prefixes = [bind:, catch:, mut-bind:, capture-bind:, capture-catch:, data-, generic:].
- Fixture content fully specified — no "configure as needed". cross-binding.js's `data` block includes every WXML-referenced identifier so the baseline state is diagnostic-free.
- `findChildProperty` does NOT use `fileModel.components` — uses `graph.usingComponents` directly so non-hyphenated component aliases are caught.
- 7 baseline regenerations all happen in Task 1 (combined commit) — no red intermediate state.
- T9's mutation targets ONE specific ref's `inTemplateDefinition` flag; the assertion of `dead.length === 1` (not 2) verifies the flag actually suppresses that ref.
- T10 uses `<local-bar locationError="{{missingVar}}">` — verifies lookup keys on attribute name (locationError), not identifier name (missingVar).
- T11 mutates BOTH `a` and `b` away simultaneously — two diagnostics expected.
- T12 removes `onLocalBarTap` from methods — proves the existing event-handler path still fires after the new rule lands.
- T13 uses the dedicated `dyn-page` fixture whose script.hasDynamicData=true.
- L1 uses `changeDocument` to inject an undefined identifier into a custom attribute — exercises the LSP wire format for `dead-component-binding`.
- L2 uses `changeDocument` to engineer both diagnostic codes on the same file — proves the new rule does not consume the event-handler path at the wire layer.
- Dogfood uses explicit `--out /tmp/wxml-zed-diagnostics-p22b/{before,after}/` paths — no dependency on `/tmp/claude-501/` or session-private paths.
- Each commit message is HEREDOC-formatted with consistent style.
