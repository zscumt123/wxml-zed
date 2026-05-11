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
