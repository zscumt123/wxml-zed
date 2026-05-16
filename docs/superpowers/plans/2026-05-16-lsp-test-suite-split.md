# LSP Test Suite Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fast/smoke/graph-smoke/full LSP harness suites so routine verification avoids hour-long cold graph runs while full coverage remains explicit.

**Architecture:** Keep all scenarios in `scripts/verify-lsp-diagnostics.mjs`. Add suite metadata and a small CLI parser that selects a suite before applying existing substring filters. Keep routine smoke protocol-only, and make graph-backed smoke explicit as `graph-smoke`. Update the wrapper and README to use the smoke suite for local verification.

**Tech Stack:** Node.js ESM, Bash, Markdown docs.

---

## File Structure

- Modify `scripts/verify-lsp-diagnostics.mjs`
  - Add named suite scenario sets.
  - Add `--suite <fast|smoke|graph-smoke|full>` parsing.
  - Preserve existing no-argument full behavior and substring filters.
- Modify `scripts/verify-tree-sitter.sh`
  - Run `node scripts/verify-lsp-diagnostics.mjs --suite smoke`.
- Modify `README.md`
  - Document smoke and full LSP verification commands.

---

### Task 1: Harness Suite Selection

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`

- [ ] Add `SCENARIO_SUITES` with `fast`, `smoke`, `graph-smoke`, and `full`.
- [ ] Add `parseArgs(argv)` that accepts `--suite <name>` and positional substring filters.
- [ ] Select scenarios by suite first, then apply filters.
- [ ] Run `node --check scripts/verify-lsp-diagnostics.mjs`.
- [ ] Run `node scripts/verify-lsp-diagnostics.mjs --suite fast`.
- [ ] Run `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke completion`.
- [ ] Commit with `test: add lsp harness suites`.

### Task 2: Routine Verification Wrapper

**Files:**
- Modify: `scripts/verify-tree-sitter.sh`
- Modify: `README.md`

- [ ] Change the wrapper to call `node "$ROOT_DIR/scripts/verify-lsp-diagnostics.mjs" --suite smoke`.
- [ ] Update README to describe smoke as the routine wrapper behavior and full as explicit.
- [ ] Run `bash -n scripts/verify-tree-sitter.sh`.
- [ ] Run `rg -n 'suite smoke|suite full|verify-lsp-diagnostics' README.md scripts/verify-tree-sitter.sh`.
- [ ] Commit with `docs: document lsp verification suites`.

### Task 3: Final Verification

**Files:**
- Verify: changed set

- [ ] Run `node --check scripts/verify-lsp-diagnostics.mjs`.
- [ ] Run `bash -n scripts/verify-tree-sitter.sh`.
- [ ] Run `node scripts/verify-lsp-diagnostics.mjs --suite fast`.
- [ ] Run `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke completion`.
- [ ] Run `git diff --check main..HEAD`.
- [ ] Review changed files for test-infra-only scope.
