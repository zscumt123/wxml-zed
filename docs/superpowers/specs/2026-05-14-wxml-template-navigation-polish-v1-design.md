# WXML Template Navigation Polish v1 Design

## Goal

Stabilize the current direct-scope template navigation baseline by tightening
navigation consistency and adding regression coverage.

This slice does not expand WXML semantics. It protects the behavior already
implemented for static template go-to-definition:

- static `<template is="name">` usages resolve within the current WXML file plus
  direct `import` / `include` WXML dependencies;
- unrelated graph-wide duplicate template names do not block direct visible
  definitions;
- dynamic template expressions remain unsupported.

## Non-Goals

- Do not implement recursive template dependency visibility.
- Do not implement full WeChat runtime template visibility semantics.
- Do not add npm/plugin component navigation.
- Do not add references, rename, completion, hover, semantic tokens, or
  workspace symbols.
- Do not change the WXML grammar or graph schema.
- Do not move language behavior into `server/wxml-lsp.mjs`.
- Do not turn Tree-sitter `outline.scm` into a semantic cross-file feature.

## Current Baseline

`server/wxml-language-service.mjs` owns editor-facing language behavior for
diagnostics, definitions, and document symbols. `server/wxml-lsp.mjs` remains a
stdio JSON-RPC host and graph scheduler.

Static template definition lookup currently has a direct-scope rule:

1. local template definitions in the owner file are considered first;
2. direct `import` / `include` WXML dependencies are considered second;
3. direct dependency files are de-duplicated by `dependency.normalized`;
4. duplicate visible definitions return `null`;
5. dynamic template usages return `null`.

Document symbols currently expose a flat list of navigable declaration and
dependency entries:

- `<template name="...">` as a function symbol;
- inline/external `<wxs module="...">` as module symbols;
- `<import src="...">` and `<include src="...">` as file symbols;
- external WXS dependencies as module symbols.

Tree-sitter `outline.scm` is still syntax-level UI support for Zed. It should
remain a lightweight outline query, not a project-aware semantic index.

## Navigation Consistency Contract

### Definition Target Ranges

`textDocument/definition` should keep the current public target range behavior:

- template definitions use the extracted target template symbol range;
- WXML import/include definitions return a zero range in the target file;
- external WXS definitions return a zero range in the target file;
- component definitions keep the existing target-file zero range behavior.

This slice should not change the public LSP shape. It should add tests for
target ranges only where they are not already covered.

### Declaration Ranges

`textDocument/documentSymbol` should use the original source declaration ranges:

- template definitions use the extracted template symbol range;
- WXML import/include entries use their dependency declaration ranges;
- inline WXS entries use their extracted WXS symbol ranges;
- external WXS entries use their dependency declaration ranges.

These ranges are document-structure ranges, not definition target ranges.

### Document Symbols

`getDocumentSymbols()` should keep returning only declarations and dependency
entries that are useful for navigation:

- include local template definitions even if they shadow imported definitions;
- include duplicate template definitions as separate symbol entries, because
  document symbols describe file structure rather than definition eligibility;
- include import/include/external-WXS entries based on the original declaration
  ranges;
- exclude component usage tags and built-in tags.

Document symbols must not try to resolve template visibility conflicts. Conflict
handling belongs to `getDefinition()`.

### Outline Query

`languages/wxml/outline.scm` should keep `@item` captures aligned with the
declaration classes that document symbols expose:

- template definitions;
- WXS module declarations;
- import declarations;
- include declarations.

It should not show template usages, component usages, built-in tags, block
elements, or slot elements as top-level navigation entries. Non-navigation
captures such as comment `@annotation` may remain in the outline query.

## Regression Fixture Scope

Use the existing `fixtures/miniprogram/` tree and add only the minimum extra
fixture content needed to lock the direct-scope semantics.

The regression suite should prove these cases:

1. a template in the current file shadows a direct dependency definition;
2. a template in a direct `import` dependency resolves;
3. a template in a direct `include` dependency resolves;
4. an unrelated graph-wide duplicate does not block a visible direct dependency
   definition;
5. duplicate direct dependency definitions return `null`;
6. duplicate dependency entries for the same normalized file count once;
7. dynamic template usages still return `null`;
8. document symbols still expose declarations even when definition lookup would
   return `null` for duplicate definitions.

Synthetic graph cases are acceptable for conflict scenarios where creating more
fixture files would add noise. Real fixture files are preferred for the
import/include happy paths because they protect the extractor and graph wiring.

## Architecture

Keep implementation boundaries unchanged:

- `server/wxml-language-service.mjs` may gain small helper functions only if they
  simplify shared testable behavior.
- `server/wxml-lsp.mjs` must remain protocol-only.
- `scripts/extract-wxml-symbols.mjs` and
  `scripts/extract-wxml-project-graph.mjs` should not need schema changes.
- Tree-sitter query changes, if any, are limited to keeping `outline.scm`
  aligned with already-supported declaration entries.

If a desired test requires recursive traversal, workspace indexing, or runtime
WeChat template semantics, the test is out of scope for this slice.

## Testing

Direct language-service verification must cover:

- definition target ranges for templates and dependencies;
- document-symbol declaration ranges for templates and dependencies;
- local-shadow template navigation;
- direct import template navigation;
- direct include template navigation;
- unrelated graph-wide duplicates not blocking visible direct definitions;
- template references whose only matching definition is outside current/direct
  dependency scope returning `null`;
- duplicate direct dependency definitions returning `null`;
- duplicate normalized dependency entries counting once;
- dynamic template references returning `null`;
- document symbols for local and duplicate template declarations.

Protocol-level LSP verification must cover:

- the same public `textDocument/definition` behavior for at least one static
  direct-scope template usage;
- `textDocument/documentSymbol` behavior for declaration/dependency entries;
- existing diagnostics and component/dependency navigation paths remain green.

Tree-sitter verification must cover:

- `outline.scm` still uses `@item` only for declaration-level navigation entries;
- `scripts/verify-tree-sitter.sh` remains the total verification entrypoint.

Final verification must include:

```sh
node scripts/verify-wxml-language-service.mjs
node scripts/verify-lsp-diagnostics.mjs
scripts/verify-tree-sitter.sh
```

Syntax checks should cover touched Node scripts.

## Documentation

Update `README.md` only if implementation changes user-visible behavior or
clarifies an existing boundary.

The README should continue to describe static template navigation as scoped to
the current file and direct `import` / `include` dependencies. It should
continue to mark dynamic template navigation, recursive/full template
visibility, npm/plugin component navigation, and `componentGenerics` as
unsupported.

## Acceptance Criteria

- Direct-scope template navigation remains unchanged for existing supported
  cases.
- Additional regression tests prove local shadowing, direct include/import
  navigation, duplicate conflict behavior, and dynamic-template null behavior.
- Document symbols and outline behavior remain declaration-focused.
- `server/wxml-lsp.mjs` stays free of template visibility logic.
- No graph schema, grammar, or package metadata changes are required.
- Total verification passes on `main` after merge.
