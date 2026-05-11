# WXS JavaScript Injection Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WXML interpolation and WXS JavaScript injection behavior explicit, fixture-backed, and enforced by `scripts/verify-tree-sitter.sh`.

**Architecture:** Keep JavaScript injection in Tree-sitter query files; do not add a standalone WXS grammar or language server. Add a focused fixture and strengthen verification so query output must contain concrete `raw_text` and `expression` captures. Prefer parent-scoped WXS injection captures for semantic clarity, while keeping interpolation injection unchanged.

**Tech Stack:** Zed language query files (`.scm`), Tree-sitter CLI query output, shell verification, WXML fixture files, Markdown docs.

---

## File Structure

- Create `fixtures/wxs-injection.wxml`: focused integration fixture for interpolation, `wxs_inline`, and `wxs_fallback` raw text injection.
- Modify `languages/wxml/injections.scm`: make WXS raw-text injection parent-scoped to `wxs_inline` and `wxs_fallback`, and keep interpolation `expression` injection.
- Modify `scripts/verify-tree-sitter.sh`: query the new fixture and assert concrete injection captures for inline WXS, fallback WXS, and interpolation.
- Modify `README.md`: make WXS injection wording explicit as highlighting-only and not a WXS/LSP/type-checking feature.
- Modify `docs/local-grammar-loading.md`: record the final manual Zed smoke evidence after rebuild.

No grammar source changes are planned for this phase. If implementation discovers that query parent scoping is not accepted by Zed or the Tree-sitter CLI, keep the existing direct `raw_text` capture and still enforce fixture-backed assertions.

## Task 1: Add Focused Injection Fixture and Concrete Assertions

**Files:**
- Create: `fixtures/wxs-injection.wxml`
- Modify: `scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Create the focused injection fixture**

Create `fixtures/wxs-injection.wxml` with exactly this content:

```wxml
<view>{{ user.name || "Guest" }}</view>

<wxs module="math">
  var double = function (x) { return x * 2; };
  var meta = { label: "double" };
  module.exports.double = double;
  module.exports.meta = meta;
</wxs>

<view>{{ math.double(count) }}</view>

<wxs src="./fallback-only.wxs">
  var fallback = function () { return "fallback"; };
</wxs>
```

- [ ] **Step 2: Add concrete injection assertions**

In `scripts/verify-tree-sitter.sh`, after the existing optional `injections.scm` query against `fixtures/test.wxml`, add a second query against the new fixture and concrete assertions:

```bash
INJECTION_FIXTURE="$ROOT_DIR/fixtures/wxs-injection.wxml"
```

Place it near the existing `FIXTURE` variable:

```bash
FIXTURE="$ROOT_DIR/fixtures/test.wxml"
INJECTION_FIXTURE="$ROOT_DIR/fixtures/wxs-injection.wxml"
```

Then replace the current injections block:

```bash
if [ -f "$ROOT_DIR/languages/wxml/injections.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/injections.scm" "$FIXTURE" >/tmp/wxml-zed-injections-query.out
fi
```

with:

```bash
if [ -f "$ROOT_DIR/languages/wxml/injections.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/injections.scm" "$FIXTURE" >/tmp/wxml-zed-injections-query.out
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/injections.scm" "$INJECTION_FIXTURE" >/tmp/wxml-zed-wxs-injections-query.out
  npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$INJECTION_FIXTURE" >/tmp/wxml-zed-wxs-injection-parse.out

  test "$(rg -c 'capture: .*injection\.content' /tmp/wxml-zed-wxs-injections-query.out)" -ge 4
  rg -n 'text: ` user\.name \|\| "Guest" `' /tmp/wxml-zed-wxs-injections-query.out >/dev/null
  rg -n 'text: ` math\.double\(count\) `' /tmp/wxml-zed-wxs-injections-query.out >/dev/null
  rg -n '\(wxs_inline' /tmp/wxml-zed-wxs-injection-parse.out >/dev/null
  rg -n '\(wxs_fallback' /tmp/wxml-zed-wxs-injection-parse.out >/dev/null
  test "$(rg -c '\(raw_text' /tmp/wxml-zed-wxs-injection-parse.out)" -ge 2
  test "$(rg -c '\(expression' /tmp/wxml-zed-wxs-injection-parse.out)" -ge 2
fi
```

These assertions intentionally combine query output and parse output. The query
output proves injection captures exist; the parse output proves those captures
are backed by `wxs_inline`, `wxs_fallback`, `raw_text`, and `expression` nodes.
Do not assert multiline `raw_text` body text from query output: Tree-sitter CLI
does not print `text:` for multiline captures.

- [ ] **Step 3: Run verification and confirm the current behavior**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: this may pass immediately if the existing broad `raw_text` and `expression` injection already emits the required captures. If it fails, the failure should come from the new query or parse assertions, proving the script now catches concrete injection regressions.

- [ ] **Step 4: Inspect injection output if assertions fail**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli query --grammar-path grammar/tree-sitter-wxml languages/wxml/injections.scm fixtures/wxs-injection.wxml
```

Expected query output should contain four `injection.content` captures:

- one interpolation capture for ` user.name || "Guest" `
- one raw-text capture for the inline WXS body
- one interpolation capture for ` math.double(count) `
- one raw-text capture for the recovered WXS body

Then run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli parse --grammar-path grammar/tree-sitter-wxml fixtures/wxs-injection.wxml
```

Expected parse output should contain `wxs_inline`, `wxs_fallback`, at least two
`raw_text` nodes, and at least two `expression` nodes.

- [ ] **Step 5: Do not commit yet**

Leave the fixture and verification changes uncommitted until Task 2 is complete. The plan expects the fixture, query, verification, and README/docs updates to be committed together after full validation.

## Task 2: Scope WXS Injection Query and Preserve Interpolation Injection

**Files:**
- Modify: `languages/wxml/injections.scm`
- Verify: `fixtures/wxs-injection.wxml`

- [ ] **Step 1: Replace the WXS raw-text injection query**

Replace `languages/wxml/injections.scm` with:

```scheme
((wxs_inline
  (raw_text) @injection.content)
  (#set! injection.language "javascript")
  (#set! injection.include-children))

((wxs_fallback
  (raw_text) @injection.content)
  (#set! injection.language "javascript")
  (#set! injection.include-children))

((expression) @injection.content
  (#set! injection.language "javascript")
  (#set! injection.include-children))
```

This keeps interpolation injection broad because `expression` is already specific to WXML interpolation nodes, while making raw-text injection explicit to WXS parent nodes.

- [ ] **Step 2: Run the focused query**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli query --grammar-path grammar/tree-sitter-wxml languages/wxml/injections.scm fixtures/wxs-injection.wxml
```

Expected: command succeeds and includes `injection.content` captures for both `raw_text` bodies and both interpolation expressions.

- [ ] **Step 3: Run full verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected:

```text
wxml-zed tree-sitter verification passed
```

Tree-sitter parser-directory warnings are acceptable. Query errors or missing `rg` assertions are failures.

- [ ] **Step 4: Confirm semantic corpus still passes**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli test --grammar-path grammar/tree-sitter-wxml
```

Expected: all corpus tests pass, including `reserved_tag_recovery`, `wxs_inline`, and `wxs_external`.

## Task 3: Document Highlighting-Only Scope

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Inspect current README wording**

Run:

```bash
rg -n "WXS|wxs|JavaScript|injection|language-service|type" README.md
```

Expected: output includes the existing WXS scope section and feature matrix.

- [ ] **Step 2: Update README wording**

In `README.md`, ensure the WXS wording communicates all four facts below:

```markdown
Inline `wxs` bodies and WXML interpolation expressions are injected as
JavaScript for syntax highlighting only. The extension does not type-check WXS,
resolve external `.wxs` files, validate WeChat WXS APIs, or provide WXS module
completion. Those behaviors belong in a later language-service layer.
```

Use the existing README structure; replace the current WXS paragraph if one already exists rather than adding a duplicate section.

- [ ] **Step 3: Verify README wording**

Run:

```bash
rg -n 'syntax highlighting only|does not type-check WXS|resolve external `\.wxs` files|language-service layer' README.md
```

Expected: all phrases are present in README output.

## Task 4: Automated Verification and Commit

**Files:**
- Create: `fixtures/wxs-injection.wxml`
- Modify: `languages/wxml/injections.scm`
- Modify: `scripts/verify-tree-sitter.sh`
- Modify: `README.md`

- [ ] **Step 1: Run final automated verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 2: Run targeted injection query and save output for review**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli query --grammar-path grammar/tree-sitter-wxml languages/wxml/injections.scm fixtures/wxs-injection.wxml >/tmp/wxml-zed-wxs-injections-review.out
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli parse --grammar-path grammar/tree-sitter-wxml fixtures/wxs-injection.wxml >/tmp/wxml-zed-wxs-injection-parse-review.out
```

Then run:

```bash
rg -n 'capture: .*injection\.content|user\.name|math\.double' /tmp/wxml-zed-wxs-injections-review.out
rg -n '\(wxs_inline|\(wxs_fallback|\(raw_text|\(expression' /tmp/wxml-zed-wxs-injection-parse-review.out
rg -n 'var double = function|var fallback = function' fixtures/wxs-injection.wxml
```

Expected: query output shows injection captures for the interpolation expressions
and raw-text ranges; parse output shows `wxs_inline`, `wxs_fallback`, `raw_text`,
and `expression`; fixture output shows the inline and fallback WXS JavaScript
body text.

- [ ] **Step 3: Check git diff**

Run:

```bash
git diff --stat
git diff -- fixtures/wxs-injection.wxml languages/wxml/injections.scm scripts/verify-tree-sitter.sh README.md
```

Expected: diff is limited to the fixture, injection query, verification script, and README.

- [ ] **Step 4: Commit the implementation**

Run:

```bash
git add fixtures/wxs-injection.wxml languages/wxml/injections.scm scripts/verify-tree-sitter.sh README.md
git commit -m "test: verify wxs javascript injections"
```

Expected: commit succeeds with those four paths.

## Task 5: Manual Zed Smoke and Documentation

**Files:**
- Modify: `docs/local-grammar-loading.md`

- [ ] **Step 1: Rebuild the dev extension in Zed**

In Zed:

1. Open the Extensions panel.
2. Search for `wxml`.
3. Click `Rebuild` on `WXML v0.2.0`.

Expected: rebuild completes without a visible error.

- [ ] **Step 2: Verify Zed log**

Run:

```bash
tail -n 80 /Users/zs/Library/Logs/Zed/Zed.log
```

Expected: latest relevant lines include:

```text
compiled grammar wxml
finished compiling extension
```

There should be no new WXML grammar or query error after the rebuild timestamp.

- [ ] **Step 3: Verify editor language state**

Open any `.wxml` file in Zed.

Expected: the status bar language remains `WXML`.

- [ ] **Step 4: Record smoke evidence**

Append a `WXS injection baseline smoke check` section to `docs/local-grammar-loading.md`.

Use this structure. The second bullet must use the exact timestamp observed in Step 2, using the same timestamp format as the log line.

```markdown
WXS injection baseline smoke check:

- Rebuilt WXML v0.2.0 from Zed's Extensions panel.
- Zed log at 2026-05-11T19:07:43+08:00 reported `compiled grammar wxml` and `finished compiling extension`.
- The open `.wxml` file remained recognized as `WXML` in the status bar after the rebuild.
- `scripts/verify-tree-sitter.sh` asserted injection captures for WXML interpolation, inline WXS raw text, and recovered WXS raw text.
```

The timestamp above is only an example of the required format. Replace it with the actual timestamp from Step 2 before committing.

- [ ] **Step 5: Commit smoke documentation**

Run:

```bash
git add docs/local-grammar-loading.md
git commit -m "docs: record wxs injection smoke check"
```

Expected: commit succeeds.

## Task 6: Final Verification and Handoff

**Files:**
- Verify repository state only.

- [ ] **Step 1: Run final verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 2: Confirm branch status**

Run:

```bash
git status --short --branch
git log --oneline main..HEAD
```

Expected:

- Worktree is clean.
- Branch contains the WXS injection design commit plus implementation and smoke commits.

- [ ] **Step 3: Request code review before merge**

Use `superpowers:requesting-code-review` with:

- Base: `main`
- Head: current branch `HEAD`
- Description: "WXS JavaScript injection baseline with fixture-backed query assertions"
- Requirements: `docs/superpowers/specs/2026-05-11-wxs-js-injection-baseline-design.md`

Expected: reviewer verdict is `Ready to merge` or only minor non-blocking comments.

- [ ] **Step 4: Finish branch**

After review is clean, use `superpowers:finishing-a-development-branch`.

Expected: present merge/push/keep/discard options to the user.
