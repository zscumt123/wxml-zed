# WXML LSP Navigation v1 Design

## Goal

Extend the existing WXML LSP `textDocument/definition` capability from component-only navigation to a small dependency-navigation slice:

- `<import src="...">` opens the resolved WXML dependency.
- `<include src="...">` opens the resolved WXML dependency.
- External `<wxs module="..." src="...">` opens the resolved WXS dependency.

This keeps the LSP prototype focused on project-graph value while preserving the current language-service boundary.

## Non-Goals

- Do not add template-definition navigation for `<template is="...">`.
- Do not add dynamic template navigation for `<template is="{{...}}">`.
- Do not add workspace-wide symbol indexing.
- Do not add completion, hover, references, rename, or diagnostics for dependency misses.
- Do not change the WXML grammar or query files.
- Do not move feature logic back into `server/wxml-lsp.mjs`.

## Current Baseline

The project graph already exposes dependency entries extracted from WXML:

- `fileModel.dependencies[]` includes `kind`, `value`, `range`, optional `normalized`, and optional `module`.
- `import`, `include`, and external `wxs` dependencies already have declaration-level ranges.
- The graph builder follows resolved WXML dependencies when they are relative, inside the mini-program root, and present on disk.
- The LSP host delegates feature behavior to `server/wxml-language-service.mjs` through `getDefinition()`.

Existing component definition behavior must stay unchanged.

## Navigation Semantics

`getDefinition({ graph, documentPath, position, extensionRoot })` will return a single LSP `Location` or `null`.

Resolution order:

1. If the position is inside a component usage range and that component resolves through `usingComponents`, return the component target WXML file.
2. Otherwise, if the position is inside a dependency declaration range and that dependency resolves to a supported local file, return that dependency target file.
3. Otherwise return `null`.

Dependency navigation applies to the whole declaration range, not only the `src` attribute value. For v1, a cursor anywhere inside the declaration should resolve:

```xml
<import src="../../templates/common.wxml" />
<include src="../../shared/header.wxml" />
<wxs module="format" src="../../utils/format.wxs" />
```

Supported dependency targets:

- `import`: requires a normalized relative path ending in `.wxml`.
- `include`: requires a normalized relative path ending in `.wxml`.
- `wxs`: requires a normalized relative path ending in `.wxs`.

Unsupported cases return `null`:

- Missing `normalized`.
- Dynamic or interpolated `src`.
- Non-relative `src`.
- Dependency target outside the mini-program root represented by `graph.root`.
- Dependency target missing from disk or unresolved by the graph.
- Inline `<wxs module="...">...</wxs>` because it is a local symbol, not a file dependency.

## Architecture

`server/wxml-language-service.mjs` remains the feature boundary.

Implementation shape:

- Keep component-definition lookup in `getDefinition()`.
- Add a dependency-definition lookup in the same service module.
- Use `containsPosition()` against dependency declaration ranges.
- Convert graph-relative `normalized` targets to file URLs with the existing location helper.
- Validate that the dependency is supported and resolved before returning a location.

`server/wxml-lsp.mjs` should remain a protocol host:

- No dependency-kind branching in the LSP host.
- No path-resolution business rules in the LSP host.
- Continue using the existing async graph build and request handling path.

## Graph Contract

Navigation v1 relies on the current graph schema; it does not require schema changes.

The language service may infer resolution from:

- `dependency.normalized` for candidate dependency target path.
- `graph.wxml[].path` for known WXML targets.
- `graph.root` for the mini-program root boundary that every dependency target must stay inside.
- File existence under `extensionRoot` for supported non-WXML targets such as `.wxs`, after the `graph.root` boundary check.
- `graph.unresolved` entries to avoid returning locations for known unresolved WXML dependencies.

The graph builder currently records unresolved WXML dependencies, but it does not record unresolved WXS dependencies. The language service therefore owns WXS target validation: a WXS target must have `dependency.normalized`, end in `.wxs`, resolve under `graph.root`, and exist on disk before `getDefinition()` may return a location.

The service must not shell out or rebuild the graph. It consumes the graph passed by the LSP host or direct tests.

## Testing

Direct language-service verification must cover:

- Existing component definition still resolves.
- `import` definition resolves to `fixtures/miniprogram/templates/common.wxml`.
- `include` definition resolves to `fixtures/miniprogram/shared/header.wxml`.
- External `wxs` definition resolves to `fixtures/miniprogram/utils/format.wxs`.
- Missing WXML dependency positions return `null`.
- Missing WXS dependency positions return `null`.
- Outside-root WXS dependency positions return `null`.
- Unsupported or non-dependency positions return `null`.

Protocol-level LSP verification must cover the same success paths through `textDocument/definition`:

- Import declaration position.
- Include declaration position.
- External WXS declaration position.
- Existing component definition remains green.

The total verification script must continue to pass:

```sh
scripts/verify-tree-sitter.sh
```

## Documentation

Update `README.md` after implementation to state that the prototype LSP definition provider supports:

- local component usages from `usingComponents`;
- WXML import/include dependencies;
- external WXS file dependencies.

The README must continue to mark template navigation, completion, hover, references, rename, and workspace-wide indexing as unsupported.
