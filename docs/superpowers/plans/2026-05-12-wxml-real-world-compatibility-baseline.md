# WXML Real-World Compatibility Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a realistic WXML fixture set and verification assertions that prove parser and query behavior survives representative mini program markup.

**Architecture:** Keep this phase inside the existing syntax-level extension boundary. Add handwritten fixtures under `fixtures/real-world/`, then extend `scripts/verify-tree-sitter.sh` to parse every real-world fixture and assert representative parse/query contracts. Do not add LSP, cross-file resolution, formatter logic, or marketplace metadata.

**Tech Stack:** Tree-sitter WXML grammar, Tree-sitter CLI, Bash verification script, ripgrep assertions, Markdown docs, Zed dev-extension smoke checks.

---

## File Structure

- Create `fixtures/real-world/page.wxml`: page-level fixture with built-ins, custom components, directives, events, imports/includes, template usage, WXS usage, entities, data/model/generic attributes.
- Create `fixtures/real-world/component.wxml`: component-level fixture with slots, nested custom components, conditional states, event forwarding, dataset attributes, dynamic attributes.
- Create `fixtures/real-world/templates.wxml`: template-only fixture with multiple definitions, static/dynamic usage, fallback body, spread-like data.
- Create `fixtures/real-world/edge-recovery.wxml`: intentionally malformed editing fixture that may contain `ERROR` nodes but should preserve useful high-level nodes.
- Modify `scripts/verify-tree-sitter.sh`: add real-world fixture constants, parse loop, representative query runs, and concrete `rg` assertions.
- Modify `README.md`: describe the real-world fixture layer in verification/development instructions.
- Modify `docs/local-grammar-loading.md`: record manual Zed smoke evidence after opening the real-world fixtures.
- Optional modify `grammar/tree-sitter-wxml/test/corpus/*.txt`: only if the new fixtures reveal a narrow grammar behavior worth locking down atomically.

---

### Task 1: Add Real-World Fixtures

**Files:**
- Create: `fixtures/real-world/page.wxml`
- Create: `fixtures/real-world/component.wxml`
- Create: `fixtures/real-world/templates.wxml`
- Create: `fixtures/real-world/edge-recovery.wxml`

- [ ] **Step 1: Create fixture directory**

Run:

```bash
mkdir -p fixtures/real-world
```

Expected: command exits 0.

- [ ] **Step 2: Create `fixtures/real-world/page.wxml`**

Create the file with exactly this content:

```wxml
<import src="./templates.wxml" />
<include src="./shared/header.wxml" />
<wxs module="format" src="./utils/format.wxs" />

<view class="page page-{{theme}}" data-page-id="{{pageId}}">
  <page-meta root-font-size="{{fontSize}}" />
  <navigation-bar title="{{title}}" loading="{{loading}}" />

  <scroll-view
    scroll-y
    class="feed {{loading ? 'is-loading' : ''}}"
    bindscrolltolower="loadMore"
    capture-bind:touchstart="onCaptureStart"
  >
    <block wx:if="{{loading}}">
      <template is="loadingRow" data="{{message: 'Loading'}}" />
    </block>
    <block wx:elif="{{items.length}}">
      <user-card
        wx:for="{{items}}"
        wx:for-item="user"
        wx:for-index="idx"
        wx:key="id"
        id="user-{{user.id}}"
        class="card {{user.active ? 'active' : ''}}"
        data-id="{{user.id}}"
        generic:Badge="status-badge"
        bind:select="onSelectUser"
        catchtap="onCardTap"
        mut-bind:expanded="onExpandedChange"
      >
        <price-row slot="footer" value="{{format.price(user.price)}}" />
      </user-card>
    </block>
    <empty-state wx:else title="No users" bindretry="reload" />
  </scroll-view>

  <input model:value="{{keyword}}" placeholder="Search {{title}}" confirm-type="search" />
  <button disabled="{{loading}}" open-type="share" capture-catchtap="onShareTap">
    Share &amp; refresh &#36;{{total}}
  </button>

  <template is="{{useCompact ? 'compactFooter' : 'fullFooter'}}" data="{{...footer}}" />
</view>
```

- [ ] **Step 3: Create `fixtures/real-world/component.wxml`**

Create the file with exactly this content:

```wxml
<view class="profile-card {{state}}" data-component-id="{{id}}">
  <slot name="header">
    <text>{{title}}</text>
  </slot>

  <block wx:if="{{loading}}">
    <loading-spinner size="small" />
  </block>
  <block wx:elif="{{user}}">
    <image class="avatar" src="{{user.avatar}}" mode="aspectFill" lazy-load />
    <view class="body" catch:tap="onBodyTap" data-id="{{user.id}}">
      <text class="name">{{user.name}}</text>
      <text class="meta">{{user.city || 'Unknown'}}</text>
      <status-badge value="{{user.status}}" bindchange="onStatusChange" />
    </view>
  </block>
  <block wx:else>
    <empty-state title="Missing user" bindretry="onRetry" />
  </block>

  <slot name="footer" />
  <view slot="actions">
    <button bindtap="onConfirm" data-id="{{id}}">Confirm</button>
    <button catchtap="onCancel" hidden="{{readonly}}">Cancel</button>
  </view>
</view>
```

- [ ] **Step 4: Create `fixtures/real-world/templates.wxml`**

Create the file with exactly this content:

```wxml
<template name="loadingRow">
  <view class="loading-row">
    <text>{{message}}</text>
  </view>
</template>

<template name="compactFooter">
  <view class="footer compact">
    <text>{{summary}}</text>
  </view>
</template>

<template name="fullFooter">
  <view class="footer full">
    <text>{{summary}}</text>
    <button bindtap="onFooterTap">More</button>
  </view>
</template>

<template is="compactFooter" data="{{summary: 'Static'}}" />

<template is="{{expanded ? 'fullFooter' : 'compactFooter'}}" data="{{...footer}}">
  <view slot="extra">
    <text>{{footer.note}}</text>
  </view>
</template>

<template>
  <text>fallback {{label}}</text>
</template>
```

- [ ] **Step 5: Create `fixtures/real-world/edge-recovery.wxml`**

Create the file with exactly this content:

```wxml
<view class="editing">
  <text>{{unfinished</text>
  <user-card data-id="{{id}}">
    <text>Still useful</text>
  </user-card-mismatch>

<wxs src="./fallback.wxs">
  var fallback = function () { return "recover"; };
</wxs>
```

- [ ] **Step 6: Parse each fixture directly**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli parse --grammar-path grammar/tree-sitter-wxml fixtures/real-world/page.wxml
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli parse --grammar-path grammar/tree-sitter-wxml fixtures/real-world/component.wxml
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli parse --grammar-path grammar/tree-sitter-wxml fixtures/real-world/templates.wxml
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli parse --grammar-path grammar/tree-sitter-wxml fixtures/real-world/edge-recovery.wxml || true
```

Expected:

- The first three commands exit 0.
- `page.wxml`, `component.wxml`, and `templates.wxml` parse without `ERROR` nodes.
- `edge-recovery.wxml` may exit non-zero because Tree-sitter returns failure when the parse tree contains `ERROR`; its output should still print useful surviving nodes such as `wxs_fallback`, `raw_text`, or `interpolation`.

- [ ] **Step 7: Commit fixtures**

Run:

```bash
git add fixtures/real-world/page.wxml fixtures/real-world/component.wxml fixtures/real-world/templates.wxml fixtures/real-world/edge-recovery.wxml
git commit -m "test: add real world wxml fixtures"
```

Expected: commit succeeds with only the four fixture files.

---

### Task 2: Add Real-World Verification Assertions

**Files:**
- Modify: `scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Add real-world fixture variables**

In `scripts/verify-tree-sitter.sh`, after:

```bash
TAG_EDITING_FIXTURE="$ROOT_DIR/fixtures/tag-editing.wxml"
BRACKETS_QUERY="$ROOT_DIR/languages/wxml/brackets.scm"
```

add:

```bash
REAL_WORLD_DIR="$ROOT_DIR/fixtures/real-world"
REAL_WORLD_PAGE="$REAL_WORLD_DIR/page.wxml"
REAL_WORLD_COMPONENT="$REAL_WORLD_DIR/component.wxml"
REAL_WORLD_TEMPLATES="$REAL_WORLD_DIR/templates.wxml"
REAL_WORLD_RECOVERY="$REAL_WORLD_DIR/edge-recovery.wxml"
```

- [ ] **Step 2: Add parse and query commands**

In `scripts/verify-tree-sitter.sh`, after the existing tag-editing bracket assertions and before the `node -e` snippet assertion block, add:

```bash
for real_world_fixture in "$REAL_WORLD_PAGE" "$REAL_WORLD_COMPONENT" "$REAL_WORLD_TEMPLATES"; do
  npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$real_world_fixture" >/tmp/wxml-zed-real-world-$(basename "$real_world_fixture" .wxml)-parse.out
done
npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$REAL_WORLD_RECOVERY" >/tmp/wxml-zed-real-world-recovery-parse.out || true

npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/highlights.scm" "$REAL_WORLD_PAGE" >/tmp/wxml-zed-real-world-page-highlights-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/outline.scm" "$REAL_WORLD_PAGE" >/tmp/wxml-zed-real-world-page-outline-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/outline.scm" "$REAL_WORLD_TEMPLATES" >/tmp/wxml-zed-real-world-templates-outline-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/injections.scm" "$REAL_WORLD_PAGE" >/tmp/wxml-zed-real-world-page-injections-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/injections.scm" "$REAL_WORLD_RECOVERY" >/tmp/wxml-zed-real-world-recovery-injections-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$BRACKETS_QUERY" "$REAL_WORLD_COMPONENT" >/tmp/wxml-zed-real-world-component-brackets-query.out
if [ -f "$ROOT_DIR/languages/wxml/indents.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/indents.scm" "$REAL_WORLD_PAGE" >/tmp/wxml-zed-real-world-page-indents-query.out
fi
```

- [ ] **Step 3: Add valid-fixture parse assertions**

Immediately after the commands from Step 2, add:

```bash
rg -n '\(import_statement' /tmp/wxml-zed-real-world-page-parse.out >/dev/null
rg -n '\(include_statement' /tmp/wxml-zed-real-world-page-parse.out >/dev/null
rg -n '\(wxs_external' /tmp/wxml-zed-real-world-page-parse.out >/dev/null
rg -n '\(block_element' /tmp/wxml-zed-real-world-page-parse.out >/dev/null
rg -n '\(template_usage' /tmp/wxml-zed-real-world-page-parse.out >/dev/null
rg -n '\(entity' /tmp/wxml-zed-real-world-page-parse.out >/dev/null
test "$(rg -c '\(interpolation' /tmp/wxml-zed-real-world-page-parse.out)" -ge 10
test "$(rg -c '\(element' /tmp/wxml-zed-real-world-page-parse.out)" -ge 8
test "$(rg -c '\(ERROR' /tmp/wxml-zed-real-world-page-parse.out)" -eq 0

rg -n '\(slot_element' /tmp/wxml-zed-real-world-component-parse.out >/dev/null
rg -n '\(block_element' /tmp/wxml-zed-real-world-component-parse.out >/dev/null
test "$(rg -c '\(element' /tmp/wxml-zed-real-world-component-parse.out)" -ge 8
test "$(rg -c '\(interpolation' /tmp/wxml-zed-real-world-component-parse.out)" -ge 8
test "$(rg -c '\(ERROR' /tmp/wxml-zed-real-world-component-parse.out)" -eq 0

test "$(rg -c '\(template_definition' /tmp/wxml-zed-real-world-templates-parse.out)" -ge 3
rg -n '\(template_usage' /tmp/wxml-zed-real-world-templates-parse.out >/dev/null
rg -n '\(template_fallback' /tmp/wxml-zed-real-world-templates-parse.out >/dev/null
test "$(rg -c '\(ERROR' /tmp/wxml-zed-real-world-templates-parse.out)" -eq 0
```

- [ ] **Step 4: Add recovery parse assertions**

After valid-fixture assertions, add:

```bash
rg -n '\(wxs_fallback' /tmp/wxml-zed-real-world-recovery-parse.out >/dev/null
rg -n '\(raw_text' /tmp/wxml-zed-real-world-recovery-parse.out >/dev/null
rg -n '\(interpolation' /tmp/wxml-zed-real-world-recovery-parse.out >/dev/null
test "$(rg -c '\(ERROR' /tmp/wxml-zed-real-world-recovery-parse.out)" -ge 1
```

This deliberately allows `ERROR` nodes only in the recovery fixture.

- [ ] **Step 5: Add query output assertions**

After recovery parse assertions, add:

```bash
rg -n 'text: `scroll-view`' /tmp/wxml-zed-real-world-page-highlights-query.out >/dev/null
rg -n 'text: `user-card`' /tmp/wxml-zed-real-world-page-highlights-query.out >/dev/null
rg -n 'text: `wx:for`' /tmp/wxml-zed-real-world-page-highlights-query.out >/dev/null
rg -n 'text: `capture-bind:touchstart`' /tmp/wxml-zed-real-world-page-highlights-query.out >/dev/null
rg -n 'text: `mut-bind:expanded`' /tmp/wxml-zed-real-world-page-highlights-query.out >/dev/null
rg -n 'text: `generic:Badge`' /tmp/wxml-zed-real-world-page-highlights-query.out >/dev/null
rg -n 'text: `&amp;`' /tmp/wxml-zed-real-world-page-highlights-query.out >/dev/null

rg -n 'text: `"./templates.wxml"`' /tmp/wxml-zed-real-world-page-outline-query.out >/dev/null
rg -n 'text: `"./shared/header.wxml"`' /tmp/wxml-zed-real-world-page-outline-query.out >/dev/null
rg -n 'text: `"format"`' /tmp/wxml-zed-real-world-page-outline-query.out >/dev/null
rg -n 'text: `"loadingRow"`' /tmp/wxml-zed-real-world-templates-outline-query.out >/dev/null
rg -n 'text: `"compactFooter"`' /tmp/wxml-zed-real-world-templates-outline-query.out >/dev/null
rg -n 'text: `"fullFooter"`' /tmp/wxml-zed-real-world-templates-outline-query.out >/dev/null

rg -n 'text: `theme`' /tmp/wxml-zed-real-world-page-injections-query.out >/dev/null
rg -n 'text: `loading \? .is-loading. : ..`' /tmp/wxml-zed-real-world-page-injections-query.out >/dev/null
rg -n 'text: `format\.price\(user\.price\)`' /tmp/wxml-zed-real-world-page-injections-query.out >/dev/null
rg -n 'text: `useCompact \? .compactFooter. : .fullFooter.`' /tmp/wxml-zed-real-world-page-injections-query.out >/dev/null
rg -n 'capture: injection\.content' /tmp/wxml-zed-real-world-recovery-injections-query.out >/dev/null
test "$(rg -c 'capture: injection\.content' /tmp/wxml-zed-real-world-recovery-injections-query.out)" -ge 1

rg -n 'text: `<view class="profile-card \{\{state\}\}" data-component-id="\{\{id\}\}">`' /tmp/wxml-zed-real-world-component-brackets-query.out >/dev/null
rg -n 'text: `<slot name="header">`' /tmp/wxml-zed-real-world-component-brackets-query.out >/dev/null
rg -n 'text: `<block wx:if="\{\{loading\}\}">`' /tmp/wxml-zed-real-world-component-brackets-query.out >/dev/null
test "$(rg -c 'capture: [0-9]+ - open' /tmp/wxml-zed-real-world-component-brackets-query.out)" -ge 8
test "$(rg -c 'capture: [0-9]+ - close' /tmp/wxml-zed-real-world-component-brackets-query.out)" -ge 8
```

- [ ] **Step 6: Run full verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected:

- The script exits 0.
- The output ends with `wxml-zed tree-sitter verification passed`.
- Tree-sitter may print parser-directory warnings; those warnings are acceptable if the final exit code is 0.

- [ ] **Step 7: If any exact text assertion differs, inspect query output and adjust only the assertion**

Run the relevant command from the failure. Example for injection:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli query --grammar-path grammar/tree-sitter-wxml languages/wxml/injections.scm fixtures/real-world/page.wxml
```

Expected: query output contains equivalent captures for the same expressions. If Tree-sitter escapes quote text differently than the planned `rg` pattern, update the `rg` pattern only; do not weaken the contract to an exit-code-only check. For multiline WXS `raw_text`, assert `capture: injection.content` and keep the parse-output `wxs_fallback`/`raw_text` checks as the content contract, because Tree-sitter query output may omit `text:` for multiline captures.

- [ ] **Step 8: Commit verification hardening**

Run:

```bash
git add scripts/verify-tree-sitter.sh
git commit -m "test: verify real world wxml compatibility"
```

Expected: commit succeeds with only `scripts/verify-tree-sitter.sh`.

---

### Task 3: Add Corpus Tests Only for Newly Exposed Grammar Contracts

**Files:**
- Optional create: `grammar/tree-sitter-wxml/test/corpus/real_world_recovery.txt`
- Optional create: `grammar/tree-sitter-wxml/test/corpus/custom_component_composition.txt`

- [ ] **Step 1: Decide whether corpus tests are needed**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: if all real-world assertions pass without grammar changes, skip this task and do not create corpus files.

- [ ] **Step 2: If recovery behavior needs an atomic corpus lock, create `grammar/tree-sitter-wxml/test/corpus/real_world_recovery.txt`**

Only do this if Task 2 exposed recovery behavior that should be locked down separately. Create:

```text
==================
recovered wxs fallback during editing
==================

<wxs src="./fallback.wxs">
  var fallback = function () { return "recover"; };
</wxs>

---

(document
  (wxs_fallback
    (wxs_fallback_start_tag
      (wxs_src_attribute
        (attribute_name)
        (quoted_attribute_value)))
    (raw_text)
    (wxs_end_tag
      (tag_name))))
```

- [ ] **Step 3: Run corpus tests if a corpus file was added**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli test --grammar-path grammar/tree-sitter-wxml
```

Expected: corpus tests pass.

- [ ] **Step 4: Commit corpus tests if any were added**

Run only if a corpus file was added:

```bash
git add grammar/tree-sitter-wxml/test/corpus/real_world_recovery.txt
git commit -m "test: cover real world wxml recovery"
```

Expected: commit succeeds with only the corpus file. If no corpus file was needed, skip this step.

---

### Task 4: Document Real-World Compatibility Layer

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update verification paragraph**

In `README.md`, replace this paragraph:

```md
The script parses `fixtures/test.wxml`, runs the grammar corpus tests, validates
the highlight, outline, text object, injection, and bracket queries, checks the
focused WXS and tag-editing fixtures, and asserts baseline snippet keys.
```

with:

```md
The script parses `fixtures/test.wxml`, runs the grammar corpus tests, validates
the highlight, outline, text object, injection, and bracket queries, checks the
focused WXS, tag-editing, and real-world compatibility fixtures, and asserts
baseline snippet keys.
```

- [ ] **Step 2: Update dev inspection instructions**

In `README.md`, replace:

```md
4. Open `fixtures/test.wxml` and `fixtures/tag-editing.wxml` and inspect
   highlighting, outline, snippets, text objects, and basic tag editing behavior.
```

with:

```md
4. Open `fixtures/test.wxml`, `fixtures/tag-editing.wxml`, and the files under
   `fixtures/real-world/`; inspect highlighting, outline, snippets, text
   objects, injection behavior, and basic tag editing behavior.
```

- [ ] **Step 3: Add scope sentence**

In the `Scope` section, after the tag-editing paragraph, add:

```md
The `fixtures/real-world/` files are compatibility fixtures for representative
WXML syntax and query behavior. They do not imply project-level understanding,
component registration validation, cross-file navigation, or diagnostics.
```

- [ ] **Step 4: Run README wording check**

Run:

```bash
rg -n 'real-world|project-level|cross-file|diagnostics|fixtures/real-world' README.md
```

Expected: output includes the verification paragraph, dev inspection step, and scope sentence.

- [ ] **Step 5: Commit README update**

Run:

```bash
git add README.md
git commit -m "docs: document real world wxml fixtures"
```

Expected: commit succeeds with only `README.md`.

---

### Task 5: Zed Smoke and Final Verification

**Files:**
- Modify: `docs/local-grammar-loading.md`

- [ ] **Step 1: Run full verification before Zed smoke**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected:

- The script exits 0.
- The output ends with `wxml-zed tree-sitter verification passed`.

- [ ] **Step 2: Open real-world fixtures in Zed**

Run:

```bash
/Applications/Zed.app/Contents/MacOS/cli -e /Users/zs/Desktop/study/wxml-zed/fixtures/real-world/page.wxml
/Applications/Zed.app/Contents/MacOS/cli -e /Users/zs/Desktop/study/wxml-zed/fixtures/real-world/component.wxml
```

Expected:

- Zed opens the files.
- Status bar language is `WXML`.
- Highlighting renders.

- [ ] **Step 3: Check Zed log for WXML errors**

Run:

```bash
tail -n 160 /Users/zs/Library/Logs/Zed/Zed.log
```

Expected:

- No new WXML grammar or query errors appear after opening the real-world fixtures.
- Unrelated Zed account, binary, or edit-prediction log entries can be ignored.

- [ ] **Step 4: Record smoke evidence**

Append this section to `docs/local-grammar-loading.md`:

```md

Real-world compatibility baseline smoke check:

- Opened `fixtures/real-world/page.wxml` and `fixtures/real-world/component.wxml` in Zed after adding the fixture set.
- The status bar language remained `WXML`, and WXML highlighting rendered in the editor.
- Zed log showed no new WXML grammar or query errors after opening the fixtures.
- `scripts/verify-tree-sitter.sh` parsed all real-world fixtures and asserted representative parse, outline, injection, highlight, bracket, and snippet contracts.
```

- [ ] **Step 5: Run final checks**

Run:

```bash
scripts/verify-tree-sitter.sh
git diff --check
git status --short --branch
```

Expected:

- Verification exits 0 and prints `wxml-zed tree-sitter verification passed`.
- `git diff --check` exits 0.
- `git status --short --branch` shows only `docs/local-grammar-loading.md` modified before the final commit.

- [ ] **Step 6: Commit smoke evidence**

Run:

```bash
git add docs/local-grammar-loading.md
git commit -m "docs: record real world compatibility smoke"
```

Expected: commit succeeds with only `docs/local-grammar-loading.md`.

---

### Task 6: Review Gate

**Files:**
- Review: all files changed since `main`

- [ ] **Step 1: Inspect branch diff**

Run:

```bash
git diff --stat main..HEAD
git diff --name-only main..HEAD
```

Expected changed files:

- `docs/local-grammar-loading.md`
- `docs/superpowers/plans/2026-05-12-wxml-real-world-compatibility-baseline.md`
- `docs/superpowers/specs/2026-05-12-wxml-real-world-compatibility-baseline-design.md`
- `fixtures/real-world/page.wxml`
- `fixtures/real-world/component.wxml`
- `fixtures/real-world/templates.wxml`
- `fixtures/real-world/edge-recovery.wxml`
- `scripts/verify-tree-sitter.sh`
- `README.md`
- optional corpus file only if Task 3 was needed.

- [ ] **Step 2: Run final verification**

Run:

```bash
scripts/verify-tree-sitter.sh
git diff --check main..HEAD
```

Expected:

- Verification exits 0 and prints `wxml-zed tree-sitter verification passed`.
- `git diff --check main..HEAD` exits 0.

- [ ] **Step 3: Request review**

Ask for review with this summary:

```text
Review request: WXML real-world compatibility baseline.

Requirements:
- Adds handwritten real-world WXML fixtures for page, component, templates, and recoverable editing states.
- Extends scripts/verify-tree-sitter.sh so parse/query contracts are asserted with concrete rg checks.
- Keeps this phase syntax-level only: no LSP, no cross-file resolution, no diagnostics.
- Updates README and local Zed smoke evidence.

Verification:
- scripts/verify-tree-sitter.sh
- git diff --check main..HEAD
```

- [ ] **Step 4: Fix review findings before merge**

For each review finding:

1. Confirm it is technically valid against the current code.
2. Make the smallest scoped fix.
3. Run `scripts/verify-tree-sitter.sh`.
4. Commit the fix with a specific message.

Expected: no known Important or Critical review findings remain before merge.
