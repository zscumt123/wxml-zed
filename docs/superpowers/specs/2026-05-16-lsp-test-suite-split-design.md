# LSP Test Suite Split Design

## Goal

Make routine WXML verification reliable without hiding the slow full LSP
protocol harness.

The current `scripts/verify-lsp-diagnostics.mjs` runs every protocol scenario by
default. Many scenarios start a fresh LSP process and rebuild the mini program
project graph. On the current machine, some graph builds take multiple minutes,
so the full harness can exceed an hour and occasionally times out in unrelated
cold-build scenarios.

## Scope

Add named LSP suites:

- `fast`: protocol-only checks that do not require project graph extraction.
- `smoke`: `fast` plus unsupported-request behavior; still protocol-only and
  suitable for routine wrappers.
- `graph-smoke`: `smoke` plus a narrow graph-backed definition and completion
  check for explicit LSP graph sanity verification.
- `full`: every existing scenario.

The direct harness should keep backward compatibility: no arguments still run
the full scenario list, and existing substring filters still work. The local
Tree-sitter verification wrapper should use `--suite smoke` so routine
verification remains meaningful without paying for every cold graph scenario.

## Non-Goals

- Do not change LSP behavior.
- Do not remove any existing scenario.
- Do not cache graphs across LSP process boundaries in this slice.
- Do not rewrite the fixture graph extractor.

## CLI Contract

Supported forms:

```bash
node scripts/verify-lsp-diagnostics.mjs
node scripts/verify-lsp-diagnostics.mjs --suite smoke
node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke
node scripts/verify-lsp-diagnostics.mjs --suite full
node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke completion
node scripts/verify-lsp-diagnostics.mjs "watch registration"
```

Unknown suites should fail clearly. Filters should apply after suite selection.

## Acceptance Criteria

- `--suite fast` runs only protocol-only scenarios.
- `--suite smoke` stays protocol-only and should finish quickly.
- `--suite graph-smoke` includes watcher registration plus representative
  definition and completion scenarios.
- No-argument behavior remains full harness behavior.
- `scripts/verify-tree-sitter.sh` uses the smoke LSP suite.
- README documents the routine smoke command and the explicit full command.
