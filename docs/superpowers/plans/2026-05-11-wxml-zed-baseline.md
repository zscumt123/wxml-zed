# wxml-zed Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the current WXML extension checkout into an independent `wxml-zed` project with a first-party vendored `tree-sitter-wxml` grammar and a documented local verification workflow.

**Architecture:** Keep the Zed extension at the repository root and vendor the grammar source under `grammar/tree-sitter-wxml/` without using a git submodule. Before changing the permanent manifest, run a local-loading spike to determine the exact `file://` grammar contract Zed accepts for this workspace; the manifest must use the verified form. Existing query/snippet work is classified first, then either adopted into the baseline or explicitly deferred.

**Tech Stack:** Zed extension manifest and language query files, Tree-sitter grammar source, TOML, Scheme query files, JSON snippets, shell verification commands, Node/NPM `npx tree-sitter-cli`.

---

## File Structure

- Create `docs/baseline-worktree-classification.md`: records how each current uncommitted file is handled before baseline work begins.
- Create `grammar/tree-sitter-wxml/`: vendored grammar source seeded from the currently pinned grammar snapshot, with no `.git` directory.
- Modify `extension.toml`: independent `wxml-zed` metadata and local `file://` grammar repository.
- Modify `languages/wxml/config.toml`: set language name to `WXML` so snippet scope matches `snippets/wxml.json`.
- Move `test.wxml` to `fixtures/test.wxml`: fixture coverage lives outside the repository root.
- Modify `README.md`: independent project README with dev-extension, grammar, and verification instructions.
- Create or modify `LICENSE`: MIT license for `wxml-zed` with preserved provenance.
- Create `NOTICE`: provenance note for copied or adapted source.
- Create `scripts/verify-tree-sitter.sh`: repeatable grammar parse and query verification command wrapper.
- Adopt `snippets/wxml.json`, `languages/wxml/textobjects.scm`, `languages/wxml/highlights.scm`, and `languages/wxml/outline.scm` into the baseline after verification, or rewrite inherited extension files before redistribution if licensing is not clear.

## Task 1: Classify Existing Dirty Worktree

**Files:**
- Create: `docs/baseline-worktree-classification.md`

- [ ] **Step 1: Inspect current dirty files**

Run:

```bash
git status --short
```

Expected output includes these paths:

```text
 M README.md
 M extension.toml
 M languages/wxml/highlights.scm
 M languages/wxml/outline.scm
 M test.wxml
?? LICENSE
?? languages/wxml/textobjects.scm
?? snippets/
```

- [ ] **Step 2: Create the classification document**

Create `docs/baseline-worktree-classification.md` with this content:

```markdown
# Baseline Worktree Classification

Date: 2026-05-11

This document classifies the dirty working tree before converting the project into the independent `wxml-zed` baseline.

## Adopt

- `LICENSE`: adopt after adjusting provenance language for the independent project.
- `languages/wxml/highlights.scm`: adopt as the syntax-level baseline after query verification; future grammar work may simplify it.
- `languages/wxml/outline.scm`: adopt as the syntax-level baseline after query verification; future grammar work may simplify it.
- `languages/wxml/textobjects.scm`: adopt after README text object wording is corrected to match Zed Vim capture behavior.
- `snippets/wxml.json`: adopt after `languages/wxml/config.toml` is renamed to `WXML`, so snippet scope matches `wxml.json`.
- `test.wxml`: adopt as the fixture, moved to `fixtures/test.wxml`.

## Rewrite

- `README.md`: rewrite around independent `wxml-zed` ownership, vendored grammar, local dev install, verification commands, and license/provenance.
- `extension.toml`: rewrite metadata for independent `wxml-zed` and point the grammar at the vendored local source.
- `languages/wxml/config.toml`: update the language display name to `WXML`; keep the existing grammar name and editor settings.

## Defer

- LSP, diagnostics, cross-file navigation, marketplace packaging, and grammar node redesign are deferred until the baseline repository structure is working and verified.
```

- [ ] **Step 3: Review the classification**

Run:

```bash
rg -n "Adopt|Rewrite|Defer|submodule|BlockLune" docs/baseline-worktree-classification.md
```

Expected: output shows the three classification sections and no instruction to use a git submodule.

- [ ] **Step 4: Commit classification**

Run:

```bash
git add docs/baseline-worktree-classification.md
git commit -m "docs: classify baseline worktree changes"
```

Expected: commit succeeds and includes only `docs/baseline-worktree-classification.md`.

## Task 2: Vendor tree-sitter-wxml Source

**Files:**
- Create: `grammar/tree-sitter-wxml/`
- Create: `NOTICE`

- [ ] **Step 1: Seed the grammar source without a submodule**

Run:

```bash
TMP_GRAMMAR_DIR="$(mktemp -d /private/tmp/wxml-zed-tree-sitter-wxml.XXXXXX)"
git clone https://github.com/BlockLune/tree-sitter-wxml "$TMP_GRAMMAR_DIR"
git -C "$TMP_GRAMMAR_DIR" checkout 81bd97fa3bbc43516ad0e7ea5518d72651d954bf
mkdir -p grammar
rsync -a --delete --exclude .git "$TMP_GRAMMAR_DIR"/ grammar/tree-sitter-wxml/
```

Expected:

```bash
test -f grammar/tree-sitter-wxml/grammar.js
test -f grammar/tree-sitter-wxml/package.json
test ! -d grammar/tree-sitter-wxml/.git
```

- [ ] **Step 2: Create provenance notice**

Create `NOTICE` with this content:

```text
wxml-zed includes source code originally adapted from:

- BlockLune/zed-wxml, used as the initial Zed extension baseline.
- BlockLune/tree-sitter-wxml, used as the initial WXML Tree-sitter grammar seed.

wxml-zed is independently maintained from this baseline onward. Vendored grammar source under grammar/tree-sitter-wxml is maintained as first-party project source in this repository and is not a git submodule.
```

- [ ] **Step 3: Verify vendored grammar files are present**

Run:

```bash
test -f grammar/tree-sitter-wxml/grammar.js
test -f grammar/tree-sitter-wxml/src/parser.c
test -f grammar/tree-sitter-wxml/src/node-types.json
test ! -d grammar/tree-sitter-wxml/.git
```

Expected: all commands exit with status `0`.

- [ ] **Step 4: Commit vendored grammar and notice**

Run:

```bash
git add grammar/tree-sitter-wxml NOTICE
git commit -m "chore: vendor tree-sitter-wxml grammar"
```

Expected: commit succeeds and no `.git` directory is staged under `grammar/tree-sitter-wxml`.

## Task 3: Spike Zed Local Grammar Loading

**Files:**
- Modify temporarily: `extension.toml`
- Create: `docs/local-grammar-loading.md`

- [ ] **Step 1: Create a temporary worktree-local manifest variant using file URL and pinned rev**

Temporarily replace only the `[grammars.wxml]` section in `extension.toml` with this content:

```toml
[grammars.wxml]
repository = "file:///Users/zs/Desktop/study/wxml-zed/grammar/tree-sitter-wxml"
rev = "81bd97fa3bbc43516ad0e7ea5518d72651d954bf"
```

- [ ] **Step 2: Manually test Zed dev-extension grammar loading**

Run this manual check in Zed:

```text
1. Run `zed: install dev extension`.
2. Select `/Users/zs/Desktop/study/wxml-zed`.
3. Open `test.wxml`.
4. Run `zed: open log`.
5. Search the log for `wxml`, `grammar`, `tree-sitter-wxml`, and `error`.
```

Expected: the extension installs, WXML files open with the WXML language, and the Zed log has no grammar loading error for `wxml`.

- [ ] **Step 3: If pinned-rev file URL fails, test a separate local git checkout**

Only run this step if Step 2 fails because Zed requires git metadata for the `rev`. Keep `grammar/tree-sitter-wxml` vendored without nested git metadata, and create a separate local grammar checkout for Zed loading:

```bash
LOCAL_GRAMMAR_GIT_DIR="/private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511"
test ! -e "$LOCAL_GRAMMAR_GIT_DIR"
git clone https://github.com/BlockLune/tree-sitter-wxml "$LOCAL_GRAMMAR_GIT_DIR"
git -C "$LOCAL_GRAMMAR_GIT_DIR" checkout 81bd97fa3bbc43516ad0e7ea5518d72651d954bf
```

Then temporarily set:

```toml
[grammars.wxml]
repository = "file:///private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511"
rev = "81bd97fa3bbc43516ad0e7ea5518d72651d954bf"
```

Expected: either Zed accepts this form, or the log gives a concrete error that local grammar loading cannot use this layout.

If `/private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511` already exists, stop and choose a new explicit path before editing `extension.toml`; do not delete an existing directory as part of this plan.

- [ ] **Step 4: Document the verified local grammar contract**

Create `docs/local-grammar-loading.md` with one of these exact results.

If Step 2 worked:

```markdown
# Local Grammar Loading

Date: 2026-05-11

Zed dev-extension loading accepts a `file://` grammar repository pointing at `/Users/zs/Desktop/study/wxml-zed/grammar/tree-sitter-wxml` with `rev = "81bd97fa3bbc43516ad0e7ea5518d72651d954bf"`.

The vendored grammar directory does not need a nested `.git` directory for local development in this workspace.

Manual verification:

- Installed `/Users/zs/Desktop/study/wxml-zed` with `zed: install dev extension`.
- Opened `test.wxml`.
- Checked `zed: open log`.
- No WXML grammar loading errors were present.
```

If Step 3 was required:

```markdown
# Local Grammar Loading

Date: 2026-05-11

Zed dev-extension loading requires the local `file://` grammar repository to be a git checkout that contains the configured `rev`.

For the baseline, keep the grammar source vendored in this repository without a nested `.git` directory. Local Zed grammar loading should use a separately cloned grammar checkout until this project has a controlled public grammar repository.

Manual verification:

- `file://` pointing at `grammar/tree-sitter-wxml` without nested git metadata failed.
- `file://` pointing at a separate local git checkout was tested.
- Zed log result was recorded during the test.
```

- [ ] **Step 5: Confirm vendored grammar still has no nested git metadata**

Run:

```bash
test ! -d grammar/tree-sitter-wxml/.git
```

Expected: command exits with status `0`.

- [ ] **Step 6: Commit local grammar loading documentation**

Run:

```bash
git add docs/local-grammar-loading.md
git commit -m "docs: record local grammar loading contract"
```

Expected: commit succeeds and contains `docs/local-grammar-loading.md`.

## Task 4: Normalize Extension Metadata and Language Name

**Files:**
- Modify: `extension.toml`
- Modify: `languages/wxml/config.toml`

- [ ] **Step 1: Replace `extension.toml`**

Replace `extension.toml` with this content:

```toml
id = "wxml-zed"
name = "WXML"
description = "WXML (WeiXin Markup Language) support for Zed."
version = "0.2.0"
schema_version = 1
authors = ["zscumt123", "wxml-zed contributors"]
repository = "https://github.com/zscumt123/wxml-zed"

snippets = ["./snippets/wxml.json"]

[grammars.wxml]
repository = "file:///Users/zs/Desktop/study/wxml-zed/grammar/tree-sitter-wxml"
rev = "81bd97fa3bbc43516ad0e7ea5518d72651d954bf"
```

- [ ] **Step 2: Update language display name**

In `languages/wxml/config.toml`, change only the first line:

```toml
name = "WXML"
```

The file should still contain:

```toml
grammar = "wxml"
path_suffixes = ["wxml"]
```

- [ ] **Step 3: Verify metadata no longer points at old extension identity**

Run:

```bash
rg -n 'BlockLune/zed-wxml|id = "wxml"|name = "WeiXin Markup Language"' extension.toml languages/wxml/config.toml
```

Expected: no output.

- [ ] **Step 4: Verify local grammar URL is the current workspace path**

Run:

```bash
rg -n "file:///Users/zs/Desktop/study/wxml-zed/grammar/tree-sitter-wxml|rev = \"81bd97fa3bbc43516ad0e7ea5518d72651d954bf\"" extension.toml
```

Expected: both the `file://` repository and verified `rev` lines are printed. If Task 3 showed Zed needs a separate local git checkout, use the verified `file://` path from `docs/local-grammar-loading.md` instead of the vendored path.

- [ ] **Step 5: Commit metadata changes**

Run:

```bash
git add extension.toml languages/wxml/config.toml
git commit -m "chore: rename extension to wxml-zed"
```

Expected: commit succeeds.

## Task 5: Move Fixture Into fixtures/

**Files:**
- Move: `test.wxml` to `fixtures/test.wxml`

- [ ] **Step 1: Create fixtures directory and move file**

Run:

```bash
mkdir -p fixtures
git mv test.wxml fixtures/test.wxml
```

Expected:

```bash
test -f fixtures/test.wxml
test ! -f test.wxml
```

- [ ] **Step 2: Verify fixture still contains required syntax coverage**

Run:

```bash
rg -n "capture-bind|capture-catch|generic:|wx:key=\"\\*this\"|<template name=|<template is=|<wxs module=|<import src=|<include src=|&amp;|disabled hidden" fixtures/test.wxml
```

Expected: every listed pattern appears at least once.

- [ ] **Step 3: Commit fixture move**

Run:

```bash
git add fixtures/test.wxml
git commit -m "test: move wxml fixture under fixtures"
```

Expected: commit succeeds and records `test.wxml` as renamed to `fixtures/test.wxml`.

## Task 6: Add Verification Script

**Files:**
- Create: `scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Create scripts directory**

Run:

```bash
mkdir -p scripts
```

- [ ] **Step 2: Create verification script**

Create `scripts/verify-tree-sitter.sh` with this content:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRAMMAR_DIR="$ROOT_DIR/grammar/tree-sitter-wxml"
FIXTURE="$ROOT_DIR/fixtures/test.wxml"
CACHE_DIR="${NPM_CONFIG_CACHE:-/private/tmp/npm-cache}"

export HOME="${WXML_ZED_HOME:-/private/tmp}"
export npm_config_cache="$CACHE_DIR"

npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$FIXTURE" >/tmp/wxml-zed-parse.out
npx tree-sitter-cli test --grammar-path "$GRAMMAR_DIR" >/tmp/wxml-zed-corpus-test.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/highlights.scm" "$FIXTURE" >/tmp/wxml-zed-highlights-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/outline.scm" "$FIXTURE" >/tmp/wxml-zed-outline-query.out

if [ -f "$ROOT_DIR/languages/wxml/textobjects.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/textobjects.scm" "$FIXTURE" >/tmp/wxml-zed-textobjects-query.out
fi

node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$ROOT_DIR/snippets/wxml.json"

echo "wxml-zed tree-sitter verification passed"
```

- [ ] **Step 3: Make script executable**

Run:

```bash
chmod +x scripts/verify-tree-sitter.sh
```

- [ ] **Step 4: Run verification script**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected output ends with:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 5: Commit verification script**

Run:

```bash
git add scripts/verify-tree-sitter.sh
git commit -m "test: add tree-sitter verification script"
```

Expected: commit succeeds.

## Task 7: Adopt Snippets and Text Objects

**Files:**
- Modify: `snippets/wxml.json`
- Modify: `languages/wxml/textobjects.scm`

- [ ] **Step 1: Validate snippets JSON**

Run:

```bash
node -e 'JSON.parse(require("fs").readFileSync("snippets/wxml.json", "utf8")); console.log("snippets ok")'
```

Expected:

```text
snippets ok
```

- [ ] **Step 2: Verify snippet scope pairing**

Run:

```bash
rg -n 'name = "WXML"' languages/wxml/config.toml
test -f snippets/wxml.json
```

Expected: the `name = "WXML"` line is printed and `snippets/wxml.json` exists.

- [ ] **Step 3: Verify textobjects query compiles**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected output ends with:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 4: Commit snippets and text objects**

Run:

```bash
git add snippets/wxml.json languages/wxml/textobjects.scm
git commit -m "feat: add wxml snippets and text objects"
```

Expected: commit succeeds.

## Task 8: Adopt Highlight and Outline Queries

**Files:**
- Modify: `languages/wxml/highlights.scm`
- Modify: `languages/wxml/outline.scm`

- [ ] **Step 1: Verify highlight and outline queries compile**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected output ends with:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 2: Spot-check outline captures**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli query --grammar-path grammar/tree-sitter-wxml languages/wxml/outline.scm fixtures/test.wxml | rg 'capture: .*name|capture: .*item'
```

Expected output includes captures for:

```text
"./item.wxml"
"../common/header.wxml"
"userCard"
"utils"
"inline"
```

- [ ] **Step 3: Commit adopted query files**

Run:

```bash
git add languages/wxml/highlights.scm languages/wxml/outline.scm
git commit -m "feat: refine wxml highlights and outline"
```

Expected: commit succeeds.

## Task 9: Normalize License and README

**Files:**
- Modify: `LICENSE`
- Modify: `README.md`

- [ ] **Step 1: Replace `LICENSE`**

Replace `LICENSE` with this content:

```text
MIT License

Copyright (c) 2026 zscumt123 and wxml-zed contributors

Portions of this project are adapted from public WXML extension and Tree-sitter
grammar sources. See NOTICE for provenance.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Replace `README.md`**

Replace `README.md` with this content:

```markdown
# wxml-zed

WXML ([WeiXin Markup Language](https://developers.weixin.qq.com/miniprogram/dev/reference/wxml/)) support for the [Zed](https://zed.dev) editor.

`wxml-zed` is independently maintained. The project includes both the Zed language extension and the WXML Tree-sitter grammar source used during local development.

## Features

| Capability | Status |
| --- | --- |
| `.wxml` file association | Implemented |
| Tree-sitter grammar vendored in this repository | Implemented |
| Syntax highlighting for tags, attributes, directives, interpolation, entities, and WXS raw text | Implemented |
| JavaScript injection for `{{ ... }}` expressions and inline WXS bodies | Implemented |
| Outline entries for template definitions, WXS modules, imports, and includes | Implemented |
| Snippets scoped to the `WXML` language | Implemented |
| Vim text objects for elements, comments, and WXS bodies | Implemented |
| LSP diagnostics and cross-file navigation | Not implemented |

## Repository Layout

```text
extension.toml
languages/wxml/
snippets/wxml.json
fixtures/test.wxml
grammar/tree-sitter-wxml/
scripts/verify-tree-sitter.sh
```

## Local Development

Install the extension in Zed with `zed: install dev extension` and select this repository.

The local dev manifest points `[grammars.wxml]` at:

```text
file:///Users/zs/Desktop/study/wxml-zed/grammar/tree-sitter-wxml
```

If the repository is moved, update that path in `extension.toml` before reinstalling the dev extension.

## Verification

Run:

```bash
scripts/verify-tree-sitter.sh
```

This checks:

- Tree-sitter parse output for `fixtures/test.wxml`
- Tree-sitter grammar corpus tests
- highlight query compilation
- outline query compilation
- text object query compilation
- snippet JSON validity

Manual Zed verification:

1. Run `zed: install dev extension`.
2. Select this repository.
3. Open `fixtures/test.wxml`.
4. Check highlighting, outline entries, snippets, and Vim text objects.

## Scope

This baseline is syntax-level support only. It does not include a language server, diagnostics, template go-to-definition, component resolution, or marketplace packaging.

Formatting currently delegates to Prettier's HTML parser via `prettier_parser_name = "html"`. That parser is not WXML-aware.

## Redistribution Status

This baseline is for local development until inherited extension files are rewritten or redistribution rights for the inherited extension baseline are resolved. The vendored grammar package declares MIT metadata in its package files, but the extension wrapper baseline still needs clean provenance handling before public redistribution.

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
```

- [ ] **Step 3: Check README does not describe the project as a fork**

Run:

```bash
rg -n "fork|Originally created|BlockLune/tree-sitter-wxml|BlockLune/zed-wxml" README.md
```

Expected: no output.

- [ ] **Step 4: Commit license and README**

Run:

```bash
git add LICENSE README.md
git commit -m "docs: document independent wxml-zed baseline"
```

Expected: commit succeeds.

## Task 10: Final Baseline Verification

**Files:**
- No new files

- [ ] **Step 1: Run full verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected output ends with:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 2: Confirm there are no git submodules**

Run:

```bash
test ! -f .gitmodules
find grammar/tree-sitter-wxml -name .git -print
```

Expected: first command exits `0`; second command prints nothing.

- [ ] **Step 3: Manually verify Zed dev-extension installation**

Run this manual check in Zed:

```text
1. Run `zed: install dev extension`.
2. Select `/Users/zs/Desktop/study/wxml-zed`.
3. Open `/Users/zs/Desktop/study/wxml-zed/fixtures/test.wxml`.
4. Confirm the selected language is `WXML`.
5. Confirm syntax highlighting is present.
6. Confirm outline contains entries for `"./item.wxml"`, `"../common/header.wxml"`, `"userCard"`, `"utils"`, and `"inline"`.
7. Run `zed: open log` and search for `wxml` and `grammar`.
```

Expected: WXML opens with the dev extension and the Zed log has no WXML grammar loading error.

- [ ] **Step 4: Record manual Zed verification**

Append this section to `docs/local-grammar-loading.md`:

```markdown

## Final Dev Extension Check

Date: 2026-05-11

- Installed `/Users/zs/Desktop/study/wxml-zed` with `zed: install dev extension`.
- Opened `/Users/zs/Desktop/study/wxml-zed/fixtures/test.wxml`.
- Confirmed language: `WXML`.
- Confirmed syntax highlighting loaded.
- Confirmed outline entries for imports, includes, template definition, and WXS modules.
- Checked Zed log for WXML grammar loading errors.
```

- [ ] **Step 5: Confirm old remote grammar is gone from active config**

Run:

```bash
rg -n "BlockLune|github.com/BlockLune" extension.toml languages README.md
```

Expected: no output from `extension.toml`, `languages/`, or `README.md`.

- [ ] **Step 6: Confirm expected project files exist**

Run:

```bash
test -f extension.toml
test -f languages/wxml/config.toml
test -f snippets/wxml.json
test -f fixtures/test.wxml
test -f grammar/tree-sitter-wxml/grammar.js
test -f scripts/verify-tree-sitter.sh
test -f NOTICE
test -f LICENSE
```

Expected: all commands exit with status `0`.

- [ ] **Step 7: Commit any final metadata-only adjustments**

If the previous steps required no edits, skip this step. If they required small metadata corrections, run:

```bash
git add extension.toml languages/wxml/config.toml README.md NOTICE LICENSE scripts/verify-tree-sitter.sh docs/local-grammar-loading.md
git commit -m "chore: finalize wxml-zed baseline"
```

Expected: commit succeeds only if files changed.

## Self-Review

Spec coverage:

- Independent `wxml-zed` metadata: Task 4.
- First-party grammar without submodule: Task 2 and Task 10.
- Local Zed grammar loading from vendored source: Task 3, Task 4, and Task 10.
- Language name and snippet scope alignment: Task 4 and Task 7.
- Fixture relocation and coverage: Task 5.
- Verification workflow: Task 6 and Task 10.
- README rewrite: Task 9.
- License and provenance: Task 2 and Task 9.
- Dirty worktree classification: Task 1.
- No LSP or marketplace work mixed in: Task 9 documents scope; no tasks implement LSP or publishing.

Placeholder scan:

- No `TBD`, `TODO`, or unspecified implementation steps are used.
- All file edits include exact target paths and exact replacement content where applicable.

Consistency check:

- The language name is consistently `WXML`.
- The grammar name remains `wxml`.
- The local grammar path is consistently `/Users/zs/Desktop/study/wxml-zed/grammar/tree-sitter-wxml`, and the plan requires manual Zed verification before treating it as valid.
- The fixture path is consistently `fixtures/test.wxml`.
