# Grammar Public Repo + `extension.toml` Repin (publish-readiness #3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the WXML tree-sitter grammar to a public git repo and repin `extension.toml`'s `[grammars.wxml]` off the local `file:///private/tmp/...` path.

**Architecture:** Two agent tasks with a USER-OPS PAUSE between them. Task 1 (agent, in-repo): add `LICENSE` + `NOTICE` to `grammar/tree-sitter-wxml/` and sync the repository coordinate in `tree-sitter.json` + `package.json`. Then a **PAUSE** for the user to create the public GitHub repo + push (outward ops the agent must not do) and hand back the commit sha. Task 2 (agent, in-repo, gated on that sha): repin `extension.toml`. Conservative: keep the vendored grammar source, no submodule, LSP `tree-sitter-wxml.wasm` untouched.

**Tech Stack:** tree-sitter grammar repo (already complete: `grammar.js` + committed `src/parser.c`), Zed `[grammars.wxml]` config, `gh` CLI (user-side).

**Spec:** `docs/superpowers/specs/2026-05-28-grammar-public-repo-repin-design.md`

---

## File Structure

- **Create** `grammar/tree-sitter-wxml/LICENSE` — MIT (BlockLune original + zscumt123 modifications). [Task 1]
- **Create** `grammar/tree-sitter-wxml/NOTICE` — provenance. [Task 1]
- **Modify** `grammar/tree-sitter-wxml/tree-sitter.json` — `metadata.links.repository` → new URL. [Task 1]
- **Modify** `grammar/tree-sitter-wxml/package.json` — `repository` → new URL. [Task 1]
- **Modify** `extension.toml` — `[grammars.wxml]` `repository` + `rev`. [Task 2, gated on the user-provided sha]

Untouched: the grammar's other ecosystem coords (`Cargo.toml`, `pyproject.toml`, `CMakeLists.txt`, `Makefile`, `go.mod`, Go binding import path) — deferred per spec; the LSP `tree-sitter-wxml.wasm` path; `languages/wxml/*.scm` queries; LSP/scripts/artifact.

---

## Task 1: Grammar publish prep (LICENSE + NOTICE + repository metadata)

**Files:**
- Create: `grammar/tree-sitter-wxml/LICENSE`
- Create: `grammar/tree-sitter-wxml/NOTICE`
- Modify: `grammar/tree-sitter-wxml/tree-sitter.json`
- Modify: `grammar/tree-sitter-wxml/package.json`

- [ ] **Step 1: Create `grammar/tree-sitter-wxml/LICENSE`** with exactly:
```
MIT License

Copyright (c) BlockLune (original tree-sitter-wxml)
Copyright (c) 2026 zscumt123 and wxml-zed contributors (modifications)

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

- [ ] **Step 2: Create `grammar/tree-sitter-wxml/NOTICE`** with exactly:
```
tree-sitter-wxml

Adapted from BlockLune/tree-sitter-wxml (MIT). Maintained as part of the
wxml-zed project. Original copyright held by BlockLune; modifications by
zscumt123 and wxml-zed contributors. See LICENSE for the MIT terms.
```

- [ ] **Step 3: Update `tree-sitter.json` repository coordinate**

In `grammar/tree-sitter-wxml/tree-sitter.json`, inside `metadata.links`, replace:
```json
      "repository": "https://github.com/BlockLune/tree-sitter-wxml",
```
with:
```json
      "repository": "https://github.com/zscumt123/tree-sitter-wxml",
```
(Leave `metadata.links.funding` and `metadata.authors` = BlockLune unchanged.)

- [ ] **Step 4: Update `package.json` repository coordinate**

In `grammar/tree-sitter-wxml/package.json`, replace:
```json
  "repository": "https://github.com/blocklune/tree-sitter-wxml",
```
with:
```json
  "repository": "https://github.com/zscumt123/tree-sitter-wxml",
```
(Leave `author` and `funding` = BlockLune unchanged.)

- [ ] **Step 5: Verify the grammar dir is a complete, publishable, buildable set**

```bash
cd grammar/tree-sitter-wxml
git check-ignore -v src/parser.c src/grammar.json src/scanner.c grammar.js tree-sitter.json; echo "check-ignore exit=$?"
ls LICENSE NOTICE src/parser.c grammar.js tree-sitter.json
cd ../..
```
Expected: `check-ignore exit=1` (NONE of the buildable sources are git-ignored, so they will all travel when the dir is pushed); the `ls` lists all files (LICENSE + NOTICE now present, parser.c/grammar.js/tree-sitter.json present → Zed can build without `tree-sitter generate`).

- [ ] **Step 6: Collateral check — the verifier suite is unaffected**

This task only adds grammar-dir metadata files; nothing reads them. Confirm no collateral damage:
```bash
node scripts/verify-wxml-narrow-ranges.mjs 2>&1 | tail -1
node scripts/verify-wasm-symbol-baselines.mjs 2>&1 | tail -1
node scripts/verify-wxml-language-service.mjs; echo "ls exit=$?"
node scripts/verify-lsp-artifact.mjs >"$TMPDIR/a.txt" 2>&1; echo "artifact exit=$?"; tail -1 "$TMPDIR/a.txt"
```
Expected: narrow-ranges `20 passed, 0 failed`; wasm `All 8 ... match.`; `ls exit=0`; `artifact exit=0` with the OK line.

- [ ] **Step 7: Commit**

```bash
git add grammar/tree-sitter-wxml/LICENSE grammar/tree-sitter-wxml/NOTICE grammar/tree-sitter-wxml/tree-sitter.json grammar/tree-sitter-wxml/package.json
git commit -m "chore(grammar): add LICENSE/NOTICE + point repository metadata at the public repo

Prep tree-sitter-wxml for publishing as its own public repo: MIT LICENSE (BlockLune
original + zscumt123 modifications), provenance NOTICE, and the repository coordinate
synced in both tree-sitter.json and package.json. Other ecosystem coords (Cargo/
pyproject/CMake/Make/go.mod) intentionally left for a later package-publishing cleanup.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## ⏸ USER-OPS PAUSE (not an agent task — outward-facing GitHub ops)

After Task 1 commits, **execution PAUSES**. The agent must NOT create the repo or push (NEVER push to BlockLune `origin`; never push without explicit request). The controller hands this checklist to the user; the user runs it and returns the commit sha. (Requires `gh` authenticated as zscumt123.)

```bash
# Publish the grammar dir as a standalone public repo, print the sha to hand back.
SRC="/Users/zs/Desktop/study/wxml-zed/grammar/tree-sitter-wxml"
DEST="$(mktemp -d)/tree-sitter-wxml"
cp -R "$SRC" "$DEST"
cd "$DEST"
rm -rf .git build prebuilds node_modules target   # drop any local build artifacts; .gitignore also excludes them
git init -b main
git add -A                                          # respects the grammar dir's .gitignore (keeps src/parser.c + tree-sitter-wxml.wasm, drops *.o/build)
git commit -m "tree-sitter-wxml: initial public publish (MIT; BlockLune original, zscumt123 modifications)"
gh repo create zscumt123/tree-sitter-wxml --public --source=. --remote=origin --push
git rev-parse HEAD                                  # ← give this sha back to the agent for Task 2
```

Sanity (optional): on the new repo, `src/parser.c`, `grammar.js`, `tree-sitter.json`, `LICENSE`, `NOTICE` should all be present (so Zed can build the grammar). The user provides the printed sha.

---

## Task 2: Repin `extension.toml` to the public repo (GATED on the user-provided sha)

**Do not start until the user has published the repo and provided the commit sha** from the ops pause. Substitute that sha for `<SHA-FROM-OPS-STEP>` below.

**Files:**
- Modify: `extension.toml`

- [ ] **Step 1: Repin `[grammars.wxml]`**

In `extension.toml`, replace:
```toml
[grammars.wxml]
repository = "file:///private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511"
rev = "fa31bef18059aacecc00a580463a6422c8a70fea"
```
with (using the real sha the user returned):
```toml
[grammars.wxml]
repository = "https://github.com/zscumt123/tree-sitter-wxml"
rev = "<SHA-FROM-OPS-STEP>"
```

- [ ] **Step 2: Verify no `file://` remains + the new pointer is set**

```bash
grep -n "file://" extension.toml && echo "FAIL: file:// still present" || echo "OK: no file:// in extension.toml"
grep -A2 "\[grammars.wxml\]" extension.toml
```
Expected: `OK: no file:// in extension.toml`; the block shows the github URL + the real sha (40-hex, not the old `fa31bef...`).

- [ ] **Step 3: Commit**

```bash
git add extension.toml
git commit -m "build(extension): repin wxml grammar to the public tree-sitter-wxml repo

Replaces the unpublishable file:///private/tmp/... grammar pointer with the public
github.com/zscumt123/tree-sitter-wxml repo at the published rev.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Post-implementation validation (manual, real Zed — NOT an automated task)

The repin's real proof is dogfood (the user, after Task 2; record in spike-notes):
1. Reinstall/reload the dev extension in Zed (so it re-resolves the grammar).
2. Confirm Zed clones + builds the grammar from `github.com/zscumt123/tree-sitter-wxml` at the pinned rev — NOT from `file:///tmp` (check the extension's grammar build; no local-path reference).
3. Open a real `.wxml`: WXML syntax highlighting and the outline render correctly (the rebuilt grammar works).

---

## Self-review checklist (run by plan author)

- **Spec coverage:** LICENSE/NOTICE → Task 1 Steps 1-2; tree-sitter.json + package.json repository sync → Task 1 Steps 3-4 (the review-added dual-file fix); buildable-set verification → Task 1 Step 5; collateral-green → Task 1 Step 6; deferred other ecosystem coords → File Structure note + Task 1 Step 7 commit message; public repo publish → USER-OPS PAUSE; gated repin (no `file://`) → Task 2; conservative model (no submodule / keep vendored source / LSP wasm untouched) → not touched anywhere; dogfood validation → Post-implementation section.
- **Placeholder scan:** `<SHA-FROM-OPS-STEP>` is a deliberately gated substitution (clearly flagged, sourced from the ops pause), not a TBD. All file contents/edits are exact.
- **Type/name consistency:** repo URL `https://github.com/zscumt123/tree-sitter-wxml` identical in LICENSE-adjacent edits, tree-sitter.json, package.json, and the Task 2 repin. The two source files have DIFFERENT current casing (`tree-sitter.json` = `BlockLune`, `package.json` = `blocklune`) — the exact old-strings in Steps 3/4 match each file's actual casing.
