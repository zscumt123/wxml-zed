# WXML Tag Editing Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WXML tag editing support fixture-backed, documented, and enforced by `scripts/verify-tree-sitter.sh`.

**Architecture:** Keep this phase inside Zed language extension primitives: language config, Tree-sitter bracket queries, snippets, fixtures, and shell verification. Do not add an LSP, Emmet, semantic end-tag insertion, paired-tag rename, or selection wrapping. Existing `brackets.scm` already has the required structural captures, so this plan focuses on making those captures explicit and regression-tested.

**Tech Stack:** Zed language config (`config.toml`), Tree-sitter query files (`brackets.scm`), Tree-sitter CLI, shell verification, JSON snippets, Markdown docs.

---

## File Structure

- Create `fixtures/tag-editing.wxml`: focused fixture for paired tags, self-closing tags, template variants, WXS variants, comments, and interpolation.
- Modify `scripts/verify-tree-sitter.sh`: add focused tag-editing parse/query checks and snippet key/prefix assertions.
- Modify `README.md`: document basic tag editing support without claiming semantic end-tag insertion.
- Modify `docs/local-grammar-loading.md`: record manual Zed smoke evidence after implementation.
- Verify `languages/wxml/brackets.scm`: no planned change unless the focused query unexpectedly fails. Current captures already cover `element`, `block_element`, `slot_element`, `template_definition`, `template_usage`, `template_fallback`, `wxs_inline`, and `wxs_fallback`.

## Task 1: Add Focused Tag Editing Fixture and Bracket Assertions

**Files:**
- Create: `fixtures/tag-editing.wxml`
- Modify: `scripts/verify-tree-sitter.sh`
- Verify: `languages/wxml/brackets.scm`

- [ ] **Step 1: Create the focused tag-editing fixture**

Create `fixtures/tag-editing.wxml` with exactly this content:

```wxml
<!-- tag editing baseline fixture -->
<view class="card {{state}}">
  <text>{{title}}</text>
  <image src="{{avatar}}" />
  <block wx:if="{{visible}}">
    <slot name="header"><text>Header</text></slot>
    <slot name="footer" />
  </block>
</view>

<template name="itemCard">
  <view class="item">{{item.name}}</view>
</template>

<template is="itemCard" data="{{item}}">
  <view>fallback {{item.name}}</view>
</template>

<template>
  <text>anonymous fallback</text>
</template>

<wxs module="tools">
  var label = function (value) { return value || ""; };
  module.exports.label = label;
</wxs>

<wxs src="./legacy.wxs">
  var recovered = true;
</wxs>
```

- [ ] **Step 2: Add the fixture variable to the verification script**

In `scripts/verify-tree-sitter.sh`, change the fixture variable block from:

```bash
FIXTURE="$ROOT_DIR/fixtures/test.wxml"
INJECTION_FIXTURE="$ROOT_DIR/fixtures/wxs-injection.wxml"
CACHE_DIR="${NPM_CONFIG_CACHE:-/private/tmp/npm-cache}"
```

to:

```bash
FIXTURE="$ROOT_DIR/fixtures/test.wxml"
INJECTION_FIXTURE="$ROOT_DIR/fixtures/wxs-injection.wxml"
TAG_EDITING_FIXTURE="$ROOT_DIR/fixtures/tag-editing.wxml"
CACHE_DIR="${NPM_CONFIG_CACHE:-/private/tmp/npm-cache}"
```

- [ ] **Step 3: Strengthen the brackets verification block**

Replace the current brackets block:

```bash
if [ -f "$ROOT_DIR/languages/wxml/brackets.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/brackets.scm" "$FIXTURE" >/tmp/wxml-zed-brackets-query.out
fi
```

with:

```bash
if [ -f "$ROOT_DIR/languages/wxml/brackets.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/brackets.scm" "$FIXTURE" >/tmp/wxml-zed-brackets-query.out
  npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$TAG_EDITING_FIXTURE" >/tmp/wxml-zed-tag-editing-parse.out
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/brackets.scm" "$TAG_EDITING_FIXTURE" >/tmp/wxml-zed-tag-editing-brackets-query.out

  rg -n '\(element' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
  rg -n '\(block_element' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
  rg -n '\(slot_element' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
  rg -n '\(template_definition' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
  rg -n '\(template_usage' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
  rg -n '\(template_fallback' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
  rg -n '\(wxs_inline' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
  rg -n '\(wxs_fallback' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
  rg -n '\(comment' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
  test "$(rg -c '\(interpolation' /tmp/wxml-zed-tag-editing-parse.out)" -ge 4

  rg -n 'text: `<view class="card \{\{state\}\}">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
  rg -n 'text: `<block wx:if="\{\{visible\}\}">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
  rg -n 'text: `<slot name="header">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
  rg -n 'text: `<template name="itemCard">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
  rg -n 'text: `<template is="itemCard" data="\{\{item\}\}">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
  rg -n 'text: `<template>`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
  rg -n 'text: `<wxs module="tools">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
  rg -n 'text: `<wxs src="./legacy\.wxs">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
  test "$(rg -c 'capture: [0-9]+ - open' /tmp/wxml-zed-tag-editing-brackets-query.out)" -ge 12
  test "$(rg -c 'capture: [0-9]+ - close' /tmp/wxml-zed-tag-editing-brackets-query.out)" -ge 12
fi
```

These assertions intentionally combine parse output and bracket query output. The parse output proves the fixture contains every required grammar node; the query output proves `brackets.scm` still captures representative opening tags.

- [ ] **Step 4: Run focused parse and query commands**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli parse --grammar-path grammar/tree-sitter-wxml fixtures/tag-editing.wxml
```

Expected: command exits 0 and output includes:

```text
(block_element
(slot_element
(template_definition
(template_usage
(template_fallback
(wxs_inline
(wxs_fallback
```

Then run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli query --grammar-path grammar/tree-sitter-wxml languages/wxml/brackets.scm fixtures/tag-editing.wxml
```

Expected: command exits 0 and output includes these exact captured texts:

```text
text: `<view class="card {{state}}">`
text: `<block wx:if="{{visible}}">`
text: `<slot name="header">`
text: `<template name="itemCard">`
text: `<template is="itemCard" data="{{item}}">`
text: `<template>`
text: `<wxs module="tools">`
text: `<wxs src="./legacy.wxs">`
```

- [ ] **Step 5: Run full verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected:

```text
wxml-zed tree-sitter verification passed
```

Tree-sitter parser-directory warnings are acceptable. Missing `rg` assertions, query errors, parse errors, or a missing fixture are failures.

- [ ] **Step 6: Commit fixture and bracket verification**

Run:

```bash
git add fixtures/tag-editing.wxml scripts/verify-tree-sitter.sh
git commit -m "test: verify wxml tag editing captures"
```

Expected: commit succeeds with those two paths.

## Task 2: Add Required Snippet Key/Prefix Assertions

**Files:**
- Modify: `scripts/verify-tree-sitter.sh`
- Verify: `snippets/wxml.json`

- [ ] **Step 1: Replace the current snippet JSON-only check**

In `scripts/verify-tree-sitter.sh`, replace:

```bash
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$ROOT_DIR/snippets/wxml.json"
```

with:

```bash
node -e '
const fs = require("fs");
const snippets = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const required = {
  "view": "view",
  "text": "text",
  "button": "button",
  "wx:if": "wxif",
  "wx:for": "wxfor",
  "block": "block",
  "template definition": "templatedef",
  "wxs inline": "wxsinline",
  "image": "image",
  "input": "input",
  "template use": "templateuse",
  "wxs external": "wxsext",
  "import": "import",
  "include": "include",
};
for (const [key, prefix] of Object.entries(required)) {
  const snippet = snippets[key];
  if (!snippet) {
    throw new Error(`Missing WXML snippet: ${key}`);
  }
  if (snippet.prefix !== prefix) {
    throw new Error(`WXML snippet ${key} prefix ${snippet.prefix} !== ${prefix}`);
  }
}
' "$ROOT_DIR/snippets/wxml.json"
```

- [ ] **Step 2: Run the snippet assertion directly**

Run:

```bash
node -e '
const fs = require("fs");
const snippets = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const required = {
  "view": "view",
  "text": "text",
  "button": "button",
  "wx:if": "wxif",
  "wx:for": "wxfor",
  "block": "block",
  "template definition": "templatedef",
  "wxs inline": "wxsinline",
  "image": "image",
  "input": "input",
  "template use": "templateuse",
  "wxs external": "wxsext",
  "import": "import",
  "include": "include",
};
for (const [key, prefix] of Object.entries(required)) {
  const snippet = snippets[key];
  if (!snippet) {
    throw new Error(`Missing WXML snippet: ${key}`);
  }
  if (snippet.prefix !== prefix) {
    throw new Error(`WXML snippet ${key} prefix ${snippet.prefix} !== ${prefix}`);
  }
}
' snippets/wxml.json
```

Expected: command exits 0 with no output.

- [ ] **Step 3: Run full verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 4: Commit snippet assertion hardening**

Run:

```bash
git add scripts/verify-tree-sitter.sh
git commit -m "test: assert baseline wxml snippets"
```

Expected: commit succeeds with `scripts/verify-tree-sitter.sh`.

## Task 3: Document the Tag Editing Baseline

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the feature matrix row**

In `README.md`, add this row after the existing `WXML snippets` row:

```markdown
| Basic tag editing through bracket matching, autoclose pairs, comments, and snippets | Yes |
```

The resulting feature table block should include:

```markdown
| WXML snippets | Yes |
| Basic tag editing through bracket matching, autoclose pairs, comments, and snippets | Yes |
| Tree-sitter parse/query verification script | Yes |
```

- [ ] **Step 2: Update the development verification wording**

Change this paragraph:

```markdown
The script parses `fixtures/test.wxml`, runs the grammar corpus tests, validates
the highlight, outline, and text object queries, and checks snippet JSON syntax.
```

to:

```markdown
The script parses `fixtures/test.wxml`, runs the grammar corpus tests, validates
the highlight, outline, text object, injection, and bracket queries, checks the
focused WXS and tag-editing fixtures, and asserts baseline snippet keys.
```

- [ ] **Step 3: Update the manual Zed inspection wording**

Change this list item:

```markdown
4. Open `fixtures/test.wxml` and inspect highlighting, outline, snippets, and
   text object behavior.
```

to:

```markdown
4. Open `fixtures/test.wxml` and `fixtures/tag-editing.wxml` and inspect
   highlighting, outline, snippets, text objects, and basic tag editing behavior.
```

- [ ] **Step 4: Add conservative scope wording**

After the existing WXS scope paragraph:

```markdown
Inline `wxs` bodies and WXML interpolation expressions are injected as
JavaScript for syntax highlighting only. The extension does not type-check WXS,
resolve external `.wxs` files, validate WeChat WXS APIs, or provide WXS module
completion. Those behaviors belong in a later language-service layer.
```

add:

```markdown
Basic tag editing support is provided through Zed's language config, bracket
queries, comments, and snippets. The extension does not provide semantic end-tag
insertion, paired-tag rename, Emmet expansion, or selection wrapping.
```

- [ ] **Step 5: Check README wording**

Run:

```bash
rg -n 'Basic tag editing|semantic end-tag|paired-tag rename|tag-editing' README.md
```

Expected: output includes the new feature row, the new scope paragraph, and the updated manual inspection step.

- [ ] **Step 6: Run full verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 7: Commit README documentation**

Run:

```bash
git add README.md
git commit -m "docs: document wxml tag editing baseline"
```

Expected: commit succeeds with `README.md`.

## Task 4: Manual Zed Smoke and Evidence

**Files:**
- Modify: `docs/local-grammar-loading.md`

- [ ] **Step 1: Reload or rebuild the dev extension in Zed**

In Zed:

1. Open the Extensions panel.
2. Search for `wxml`.
3. Click `Rebuild` on `WXML v0.2.0`, or run `zed: reload extensions` if Rebuild does not produce visible feedback.

Expected: no visible WXML extension error.

- [ ] **Step 2: Open the focused fixture in Zed**

Open:

```text
/Users/zs/Desktop/study/wxml-zed/fixtures/tag-editing.wxml
```

Expected:

- Status bar language is `WXML`.
- The file displays WXML highlighting.
- Snippets are available for the WXML language when typing prefixes such as `view`, `wxfor`, or `templatedef`.

- [ ] **Step 3: Check Zed log for WXML errors**

Run:

```bash
tail -n 120 /Users/zs/Library/Logs/Zed/Zed.log
```

Expected: no new WXML grammar or query errors after the reload/rebuild attempt. General unrelated LSP warnings for other workspaces are not WXML failures.

- [ ] **Step 4: Append smoke evidence**

Append this section to `docs/local-grammar-loading.md`:

```markdown

Tag editing baseline smoke check:

- Reloaded or rebuilt WXML v0.2.0 from Zed after adding `fixtures/tag-editing.wxml`.
- Opened `fixtures/tag-editing.wxml`; the status bar language remained `WXML`.
- Zed log showed no new WXML grammar or query errors after the reload/rebuild attempt.
- `scripts/verify-tree-sitter.sh` asserted tag-editing bracket captures and required snippet key/prefix pairs.
```

- [ ] **Step 5: Commit smoke documentation**

Run:

```bash
git add docs/local-grammar-loading.md
git commit -m "docs: record tag editing smoke check"
```

Expected: commit succeeds with `docs/local-grammar-loading.md`.

## Task 5: Final Verification and Review Gate

**Files:**
- Verify repository state only.

- [ ] **Step 1: Run full verification on the final branch**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 2: Run focused query output checks for review evidence**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli query --grammar-path grammar/tree-sitter-wxml languages/wxml/brackets.scm fixtures/tag-editing.wxml
```

Expected output includes:

```text
text: `<view class="card {{state}}">`
text: `<template>`
text: `<wxs src="./legacy.wxs">`
```

Then run:

```bash
node -e '
const fs = require("fs");
const snippets = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log(["view", "wx:for", "template definition", "wxs inline"].map((key) => `${key}:${snippets[key].prefix}`).join("\n"));
' snippets/wxml.json
```

Expected:

```text
view:view
wx:for:wxfor
template definition:templatedef
wxs inline:wxsinline
```

- [ ] **Step 3: Confirm branch state**

Run:

```bash
git status --short --branch
git log --oneline main..HEAD
```

Expected:

- Worktree is clean.
- Branch contains the tag-editing design commits plus implementation and smoke commits.

- [ ] **Step 4: Request code review before merge**

Use `superpowers:requesting-code-review` with:

- Base: `main`
- Head: current branch `HEAD`
- Description: `WXML tag editing baseline with focused bracket and snippet assertions`
- Requirements: `docs/superpowers/specs/2026-05-12-wxml-tag-editing-baseline-design.md`

Expected: reviewer verdict is `Ready to merge` or only minor non-blocking comments.

- [ ] **Step 5: Finish branch after review is clean**

After review is clean, use `superpowers:finishing-a-development-branch`.

Expected: present merge/push/keep/discard options to the user, then follow the selected option.
