# WXML Template Definition Navigation v1 Design

## Goal

Extend the existing WXML LSP `textDocument/definition` capability to support a narrow template navigation slice:

- Static `<template is="name">` usages navigate to a matching `<template name="name">` definition.
- Matching uses the current project graph model and the existing language-service boundary.

This continues the project-graph-driven navigation path after component, import/include, and external WXS definition support.

## Non-Goals

- Do not support dynamic `<template is="{{...}}">` expressions.
- Do not implement template visibility rules based on `import` or `include` dependency chains.
- Do not support LSP references, workspace symbols, rename, completion, or hover.
- Do not change the WXML grammar, Tree-sitter queries, or graph extractor schema.
- Do not move feature logic into `server/wxml-lsp.mjs`.

## Current Baseline

The WXML symbol extractor already emits:

- `fileModel.references[]` entries for template usage.
- Static template usages with `kind: "template"`, `dynamic: false`, `raw`, `name`, and a declaration-level `range`.
- Dynamic template usages with `dynamic: true` and no `name`.
- `fileModel.symbols[]` entries for template definitions with `kind: "template"`, `name`, and definition range.

The mini-program project graph already includes imported WXML files discovered through WXML dependencies, so the current fixture graph contains:

- `pages/home/home.wxml` with a static `loadingRow` template reference.
- `templates/common.wxml` with the `loadingRow` template definition.

`server/wxml-language-service.mjs` is the feature-mapping boundary for `getDefinition()`. The LSP host must remain a protocol and graph scheduling layer.

## Navigation Semantics

`getDefinition({ graph, documentPath, position, extensionRoot })` returns a single LSP `Location` or `null`.

Resolution order stays conservative:

1. If the position is inside a resolved component usage, return the component target.
2. Otherwise, if the position is inside a supported dependency declaration, return the dependency target.
3. Otherwise, if the position is inside a static template usage, return the matching template definition.
4. Otherwise return `null`.

Template navigation applies to the whole template usage declaration range for v1:

```xml
<template is="loadingRow" data="{{message: 'Loading users'}}" />
```

Supported template usage:

- `reference.kind === "template"`.
- `reference.dynamic === false`.
- `reference.name` is a non-empty string.
- The cursor position is inside `reference.range`.

Template target lookup:

- Search `graph.wxml[].symbols` for `symbol.kind === "template"` and `symbol.name === reference.name`.
- If exactly one matching template definition exists, return that definition file.
- If no matching definitions exist, return `null`.
- If more than one matching definition exists, return `null` to avoid ambiguous navigation.

For v1, graph-wide lookup is intentional. It is broader than WeChat template visibility rules, but it keeps the feature small and uses only data already present in the graph. Dependency-scoped visibility can be designed later when there is a concrete need.

Unsupported cases return `null`:

- Dynamic template usage such as `<template is="{{currentTemplate}}">`.
- Missing `reference.name`.
- No matching template definition.
- More than one matching template definition.
- Cursor outside the template usage declaration range.

## Architecture

`server/wxml-language-service.mjs` remains the implementation location.

Implementation shape:

- Keep existing component definition lookup unchanged.
- Keep existing dependency definition lookup unchanged.
- Add a template definition lookup after dependency lookup.
- Use existing `containsPosition()` against template reference ranges.
- Return a `Location` pointing at the WXML file that owns the unique matching template symbol.
- Use the existing zero range target convention for file-level definition locations in this prototype.

`server/wxml-lsp.mjs` should not change for this feature. It already delegates definition requests to `getDefinition()` after building or retrieving the graph.

## Testing

Direct language-service verification must cover:

- Existing component definition still resolves.
- Existing import/include/external WXS definitions still resolve.
- Static `<template is="loadingRow">` resolves to `fixtures/miniprogram/templates/common.wxml`.
- Dynamic template references return `null`.
- Missing template references return `null`.
- Duplicate template definitions return `null`.
- Non-template positions still return `null`.

Protocol-level LSP verification must cover:

- Static template definition navigation through `textDocument/definition`.
- Existing component and dependency definition scenarios remain green.

The total verification script must continue to pass:

```sh
scripts/verify-tree-sitter.sh
```

## Documentation

After implementation, update `README.md` to state that prototype go-to-definition supports:

- local WXML components;
- WXML import/include dependencies;
- external WXS files;
- static template usage to unique template definitions.

The README must continue to mark dynamic template navigation, template visibility rules, workspace-wide indexing, completion, hover, references, rename, and npm/plugin component navigation as unsupported.
