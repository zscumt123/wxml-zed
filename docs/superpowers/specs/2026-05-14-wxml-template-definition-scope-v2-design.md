# WXML Template Definition Scope v2 Design

## Goal

Refine static template go-to-definition so it resolves within a narrow visible
scope instead of searching the whole project graph.

This slice keeps the existing `textDocument/definition` capability and improves
one behavior:

- Static `<template is="name">` usages navigate to the nearest visible
  `<template name="name">` definition.

For this phase, "visible" means the current WXML file plus its direct
`import` / `include` WXML dependencies.

## Non-Goals

- Do not support dynamic `<template is="{{...}}">` expressions.
- Do not implement recursive template dependency visibility.
- Do not implement full WeChat runtime template visibility semantics.
- Do not add LSP references, workspace symbols, rename, completion, or hover.
- Do not change the WXML grammar, Tree-sitter queries, or graph schema version.
- Do not move feature logic into `server/wxml-lsp.mjs`.

## Current Baseline

Template definition navigation v1 resolves a static template usage by searching
all `graph.wxml[].symbols` for a matching template name. It returns the target
only when the match is globally unique.

That is conservative, but it is too broad for real projects:

- An unrelated WXML file elsewhere in the graph can create a duplicate template
  name and incorrectly disable navigation.
- A local template definition in the same file cannot shadow an imported
  template with the same name.

The existing graph already contains the data needed for a narrower slice:

- each WXML file model has `dependencies[]`;
- `import` and `include` dependencies have normalized WXML graph paths when they
  resolve inside the project;
- each WXML file model has `symbols[]` for template definitions;
- each WXML file model has `references[]` for template usages.

`server/wxml-language-service.mjs` is the language feature boundary. The LSP host
continues to handle JSON-RPC and graph scheduling only.

## Navigation Semantics

Resolution order in `getDefinition()` stays unchanged:

1. component definition;
2. WXML import/include/external-WXS dependency definition;
3. static template definition;
4. `null`.

Static template navigation applies when:

- `reference.kind === "template"`;
- `reference.dynamic === false`;
- `reference.name` is a non-empty string;
- cursor position is inside `reference.range`.

### Visible Files

For a template reference in owner file `owner.wxml`, the visible file list is:

1. `owner.wxml`;
2. direct WXML dependencies from `owner.wxml` where:
   - `dependency.kind` is `"import"` or `"include"`;
   - `dependency.normalized` is a string;
   - `dependency.normalized` exists as a `graph.wxml[].path` entry.

Do not traverse dependencies of those dependency files.

Ignore external WXS dependencies for template visibility.

### Nearest Definition Rule

Given a static reference name:

1. Search the owner file first.
2. If the owner file contains exactly one matching template definition, return it.
3. If the owner file contains more than one matching template definition, return
   `null`.
4. If the owner file contains no matching definition, search direct visible
   import/include dependency files.
5. If exactly one direct dependency definition matches, return it.
6. If no direct dependency definition matches, return `null`.
7. If more than one direct dependency definition matches, return `null`.

This keeps local definitions nearest without inventing ordering rules for
multiple imported files.

### Unsupported Cases

Return `null` for:

- dynamic template usages;
- missing template names;
- cursor positions outside a template usage range;
- duplicate local definitions for the same name;
- duplicate direct dependency definitions for the same name;
- definitions that exist only outside the current file and direct dependencies.

## Architecture

Implementation remains in `server/wxml-language-service.mjs`.

Expected helper shape:

- Replace graph-wide `templateDefinitionsForName(graph, name)` usage with helpers
  that operate on file models:
  - `templateDefinitionsInFile(fileModel, name)`;
  - `directTemplateDependencyFiles(graph, fileModel)`;
  - `visibleTemplateDefinitions(graph, fileModel, name)`.
- Keep returned template definition locations using
  `locationForGraphPathWithRange(match.fileModel.path, match.symbol.range,
  extensionRoot)`.
- Keep component and dependency definition behavior unchanged.

The symbol extractor and project graph extractor should not need schema changes.
If implementation discovers that existing dependency normalization is
insufficient, stop and review before expanding scope.

## Fixture Shape

Extend `fixtures/miniprogram/` with focused template scope fixtures:

```text
fixtures/miniprogram/
  pages/home/home.wxml
  templates/common.wxml
  templates/secondary.wxml
  templates/unrelated.wxml
```

Required fixture behavior:

- `pages/home/home.wxml` imports `../../templates/common.wxml`.
- `pages/home/home.wxml` includes `../../templates/secondary.wxml`.
- `templates/common.wxml` defines `loadingRow`.
- `templates/unrelated.wxml` also defines `loadingRow`, but is not a direct
  dependency of `pages/home/home.wxml`.
- `pages/home/home.wxml` uses `<template is="loadingRow" />`.

This proves unrelated graph-wide duplicates no longer disable a direct visible
template definition.

Additional conflict tests can be synthetic graph tests in
`scripts/verify-wxml-language-service.mjs` so the fixture tree does not need many
near-identical WXML files.

## Testing

Direct language-service verification must cover:

- Existing component definition still resolves.
- Existing import/include/external-WXS definitions still resolve.
- Existing static `loadingRow` usage resolves to the direct dependency definition
  in `fixtures/miniprogram/templates/common.wxml`.
- An unrelated graph-wide duplicate `loadingRow` definition does not block the
  direct dependency definition.
- A local template definition shadows a direct dependency definition with the
  same name.
- Duplicate local definitions for the same name return `null`.
- Duplicate direct dependency definitions for the same name return `null`.
- A template definition that exists only outside the current file and direct
  dependencies returns `null`.
- Dynamic template references still return `null`.
- Existing missing-template and non-template negative cases remain green.

Protocol-level LSP verification must cover:

- Static template definition navigation still works through
  `textDocument/definition`.
- A graph-wide unrelated duplicate fixture does not break the protocol-level
  `loadingRow` definition scenario.
- Existing component, dependency, diagnostics, and document-symbol scenarios
  remain green.

The total verification script must continue to pass:

```sh
scripts/verify-tree-sitter.sh
```

## Documentation

After implementation, update `README.md` to say static template
go-to-definition resolves only within the current WXML file and its direct
`import` / `include` dependencies.

The README must continue to mark dynamic template navigation, recursive template
visibility, full template visibility-rule navigation, workspace-wide indexing,
completion, hover, references, rename, npm/plugin component navigation, and
`componentGenerics` as unsupported.
