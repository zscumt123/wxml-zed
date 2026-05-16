# Graph Extractor Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in graph extractor profiling that identifies where WXML project graph builds spend time.

**Architecture:** Keep extractor stdout unchanged. Emit structured profile events to stderr only when `WXML_ZED_PROFILE=1` is set, then add a wrapper script that parses those events and prints a concise timing report.

**Tech Stack:** Node.js ESM, built-in `perf_hooks`, `child_process`, Markdown docs.

---

## File Structure

- Modify `scripts/extract-wxml-symbols.mjs`
  - Add opt-in profile event emission.
  - Measure per-file read, Tree-sitter CST, CST parsing, and model extraction.
- Modify `scripts/extract-wxml-project-graph.mjs`
  - Add opt-in profile event emission.
  - Measure total graph extraction and each symbol extractor batch.
- Create `scripts/profile-wxml-project-graph.mjs`
  - Run the graph extractor with profiling enabled.
  - Parse profile events from stderr.
  - Print a human-readable timing summary.
- Modify `README.md`
  - Document the profiling command.

---

### Task 1: Instrument Symbol Extraction

**Files:**
- Modify: `scripts/extract-wxml-symbols.mjs`

- [ ] Add `performance.now()` timing helpers.
- [ ] Emit `symbol-file` events with read, CST, parse, extract, and total milliseconds.
- [ ] Emit `symbol-total` event with file count and total milliseconds.
- [ ] Run `node --check scripts/extract-wxml-symbols.mjs`.
- [ ] Run `WXML_ZED_PROFILE=1 node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml >/tmp/wxml-symbol-profile.json`.

### Task 2: Instrument Project Graph Extraction

**Files:**
- Modify: `scripts/extract-wxml-project-graph.mjs`

- [ ] Add profiling helpers.
- [ ] Emit `graph-symbol-batch` events around child symbol extraction.
- [ ] Emit `graph-total` event with graph counts and total milliseconds.
- [ ] Run `node --check scripts/extract-wxml-project-graph.mjs`.
- [ ] Run `WXML_ZED_PROFILE=1 node scripts/extract-wxml-project-graph.mjs fixtures/miniprogram >/tmp/wxml-graph-profile.json`.

### Task 3: Add Profile Wrapper

**Files:**
- Create: `scripts/profile-wxml-project-graph.mjs`

- [ ] Run graph extractor with `WXML_ZED_PROFILE=1`.
- [ ] Parse profile JSON lines from stderr.
- [ ] Print total time, graph time, symbol child time, top slow files, and event counts.
- [ ] Run `node --check scripts/profile-wxml-project-graph.mjs`.
- [ ] Run `node scripts/profile-wxml-project-graph.mjs fixtures/miniprogram`.

### Task 4: Docs and Verification

**Files:**
- Modify: `README.md`

- [ ] Document the profiling command in the development section.
- [ ] Run `node --check scripts/extract-wxml-symbols.mjs`.
- [ ] Run `node --check scripts/extract-wxml-project-graph.mjs`.
- [ ] Run `node --check scripts/profile-wxml-project-graph.mjs`.
- [ ] Run `node scripts/verify-lsp-diagnostics.mjs --suite smoke`.
- [ ] Run `git diff --check main..HEAD`.
