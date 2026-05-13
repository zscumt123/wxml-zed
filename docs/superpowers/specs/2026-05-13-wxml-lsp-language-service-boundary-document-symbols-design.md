# WXML LSP Language Service Boundary and Document Symbols Baseline Design

## Goal

Establish a top-down internal boundary for WXML LSP features, then use
`textDocument/documentSymbol` as the first new capability built through that
boundary.

This slice is not only about adding outline-like LSP symbols. It should prevent
future LSP features from growing directly inside `server/wxml-lsp.mjs`. The
server should become a protocol host and graph coordinator, while WXML-specific
editor behavior lives in a reusable language-service module.

## Current Context

The repository already has these layers:

- Tree-sitter grammar and query files for syntax-level Zed support.
- `scripts/extract-wxml-symbols.mjs`, which emits per-file WXML syntax models.
- `scripts/extract-wxml-project-graph.mjs`, which emits a project graph with
  WXML files, dependencies, symbols, template references, component candidates,
  `usingComponents`, and unresolved entries.
- `server/wxml-lsp.mjs`, a dependency-free Node stdio LSP prototype.

`server/wxml-lsp.mjs` currently owns too many responsibilities:

- JSON-RPC/LSP framing and request dispatch.
- Workspace/root discovery.
- Project graph build scheduling and cache waiters.
- Diagnostic mapping.
- Definition mapping.
- Path and range conversions.

That was acceptable for the first diagnostics and definition baselines. It is
not a good shape for document symbols, completion, hover, references, semantic
tokens, or JSON/WXML cross-file navigation.

## Design Direction

Use a three-layer mental model:

1. **Protocol host**
   - File: `server/wxml-lsp.mjs`.
   - Owns JSON-RPC framing, LSP lifecycle, capability advertisement, request
     dispatch, workspace/root discovery, open document tracking, and graph
     scheduling.
   - It should not contain WXML feature logic beyond calling the language
     service and publishing/sending results.

2. **Graph provider**
   - Still implemented inside `server/wxml-lsp.mjs` for this slice.
   - Owns running `scripts/extract-wxml-project-graph.mjs`, caching graph state
     per mini program root, coalescing builds, and resolving waiters.
   - A later slice may extract it into a separate module, but this slice should
     avoid a broad scheduler refactor.

3. **WXML language service**
   - New module: `server/wxml-language-service.mjs`.
   - Owns pure WXML feature mapping from graph models to LSP shapes.
   - It must not read files, spawn processes, inspect environment variables,
     write JSON-RPC messages, or mutate server state.
   - It should be usable from protocol tests without starting a full LSP server
     in future slices.

This split keeps the current project graph as the semantic boundary. LSP
features should ask the graph provider for a current graph, then ask the
language service to answer the feature.

## Language Service Contract

Create `server/wxml-language-service.mjs` with these named exports:

```javascript
getDiagnostics({ graph, documentPath, extensionRoot })
getDefinition({ graph, documentPath, position, extensionRoot })
getDocumentSymbols({ graph, documentPath, extensionRoot })
```

Supporting helpers may also live in this module if they are feature-neutral:

```javascript
graphPathForAbsolute(filePath, extensionRoot)
absolutePathForGraphPath(graphPath, extensionRoot)
rangeFromSymbolRange(range)
containsPosition(range, position)
```

Rules:

- Inputs are plain data: graph JSON, absolute document paths, LSP positions, and
  `extensionRoot`.
- Outputs are LSP-compatible data: `Diagnostic[]`, `Location | null`, and
  `DocumentSymbol[]`.
- Missing file models return empty or null results, not thrown errors.
- The module has no process-level side effects.
- LSP method handlers remain responsible for logging unexpected failures and
  sending protocol responses.

Existing diagnostics and definition behavior should be moved behind this
service boundary before adding document symbols. That migration is part of the
slice because otherwise the new capability would set the wrong pattern.

## Document Symbol Scope

Add `textDocument/documentSymbol` support for WXML files represented in the
current project graph.

The first baseline should return a flat `DocumentSymbol[]`, not nested symbols.
Flat symbols are simpler, deterministic, and enough to verify the boundary.

Include these symbol kinds:

- `template` definitions from `fileModel.symbols[]` where `kind === "template"`.
- `wxs` modules from `fileModel.symbols[]` where `kind === "wxs"`.
- `import` dependencies from `fileModel.dependencies[]` where `kind === "import"`.
- `include` dependencies from `fileModel.dependencies[]` where `kind === "include"`.
- External `wxs` dependencies from `fileModel.dependencies[]` where
  `kind === "wxs"` only when there is no `wxs` symbol with the same range.

Do not include component usages in this baseline. Component tags can be numerous
and are better handled later once we decide whether document symbols should
represent structure, dependencies, or both. They can still power completion,
definition, and diagnostics through the same language-service boundary.

For this slice, document symbols represent declaration and dependency entry
points, not the WXML DOM structure. If we later want a structural outline, that
should be designed as a separate nested-symbol feature instead of being mixed
into this baseline.

## Document Symbol Mapping

Return LSP `DocumentSymbol` objects.

Use this mapping:

| Graph item | LSP name | LSP kind | Detail |
| --- | --- | --- | --- |
| template symbol | template name | `12` Function | `template` |
| wxs symbol | module name | `2` Module | `wxs` |
| import dependency | normalized path if present, else raw value | `1` File | `import` |
| include dependency | normalized path if present, else raw value | `1` File | `include` |
| wxs dependency without matching wxs symbol | module name if present, else normalized path or raw value | `2` Module | `wxs external` |

Use each graph item's range for both `range` and `selectionRange`. The graph
currently stores element-level ranges, not exact attribute-name ranges. That is
acceptable for the baseline and should be documented by tests.

Ordering should follow source order. If symbols and dependencies come from
separate graph arrays, merge them and sort by range start row/column.

The protocol handler returns `[]` when:

- the URI is not a file URI,
- no mini program root can be resolved,
- graph construction fails,
- the graph does not contain the requested WXML file,
- the file contains no included baseline symbol kinds.

## LSP Protocol Changes

`server/wxml-lsp.mjs` should:

- Advertise `documentSymbolProvider: true`.
- Handle `textDocument/documentSymbol`.
- Resolve the document path from `params.textDocument.uri`.
- Resolve the mini program root.
- Await a current graph via the existing graph request path.
- Call `getDocumentSymbols({ graph, documentPath, extensionRoot })`.
- Respond with `DocumentSymbol[]`.
- Keep JSON-RPC message processing responsive; do not `await` inside
  `handleMessage`.

The method should reuse the same graph availability behavior as definition:

- Use a stable cached graph immediately when available.
- If no graph exists, trigger graph construction and wait.
- If a graph build is already running, wait for the latest/current graph.
- Return `[]` if no usable graph is available.

## Test Strategy

Extend `scripts/verify-lsp-diagnostics.mjs` rather than adding a new harness.
The harness already covers stdio framing, initialization, graph build waiting,
and responsiveness.

Required protocol scenarios:

1. `initialize` advertises `documentSymbolProvider: true`.
2. `textDocument/documentSymbol` for
   `fixtures/miniprogram/pages/home/home.wxml` returns flat symbols for:
   - import `fixtures/miniprogram/templates/common.wxml`
   - include `fixtures/miniprogram/shared/header.wxml`
   - wxs module `format`
   It must assert source order, `name`, `kind`, `detail`, `range`, and
   `selectionRange`. The expected order is import, include, then wxs.
3. `textDocument/documentSymbol` for
   `fixtures/miniprogram/templates/common.wxml` returns template symbol
   `loadingRow`. It must assert `name`, `kind`, `detail`, `range`, and
   `selectionRange`.
4. `textDocument/documentSymbol` for
   `fixtures/miniprogram/components/user-card/user-card.wxml` returns `[]`.
   This proves component usages are intentionally excluded from the baseline.
5. Document symbols can trigger graph construction without prior diagnostics.
6. A delayed graph build does not block unrelated request handling. Start a
   document symbol request with `WXML_ZED_LSP_GRAPH_DELAY_MS=250`, immediately
   send `workspace/symbol`, assert the existing `-32601` response arrives, then
   assert document symbols eventually resolve.
7. A WXS element represented in both `fileModel.symbols[]` and
   `fileModel.dependencies[]` produces one document symbol, not a duplicate.
8. Existing diagnostics and definition scenarios still pass after moving logic
   behind the language service.

Required service-level scenarios:

1. Directly import `server/wxml-language-service.mjs` from a Node verification
   script or focused test harness.
2. Call `getDiagnostics`, `getDefinition`, and `getDocumentSymbols` with fixture
   graph data.
3. Assert the same pure outputs as the protocol harness for missing component
   diagnostics, resolved component definition, scoped document symbols, and
   no duplicate WXS symbols.

These direct tests are required because this slice is primarily validating the
language-service boundary. The protocol harness still verifies stdio behavior,
capability advertisement, graph waiting, and request-loop responsiveness.

## README Updates

Update README to describe:

- The new language-service boundary at a high level.
- `textDocument/documentSymbol` as a prototype LSP capability.
- The intentionally flat symbol baseline.
- Exclusions: component usage symbols, nested WXML structure, JSON document
  symbols, semantic tokens, completion, hover, references, file watching, npm
  or plugin component resolution.

The README should not imply that Zed's existing Tree-sitter outline and LSP
document symbols are identical. They are separate mechanisms that can share
model concepts over time.

## Out of Scope

- Nested document symbols for full WXML element structure.
- Component usage symbols.
- JSON document symbols.
- `workspace/symbol`.
- Completion, hover, references, rename, semantic tokens, code actions, or
  formatting.
- Moving graph scheduling into a separate module.
- File watching or incremental graph invalidation.
- npm/plugin component resolution.
- `componentGenerics`.
- Exact attribute-range selection for symbol names.

## Risks and Constraints

- `server/wxml-lsp.mjs` may still be large after this slice because graph
  scheduling remains there. That is intentional. The goal is to extract feature
  logic first, not perform a broad server rewrite.
- Document symbols based on dependencies are not a full structural outline.
  This is acceptable because the baseline's primary purpose is validating the
  language-service boundary.
- Tree-sitter CLI local cache warnings may appear during graph extraction. The
  existing verification scripts already tolerate current warning output as long
  as exit codes and assertions pass.
- If graph ranges change in a future grammar update, document symbol ranges
  should follow the graph contract rather than duplicating parsing logic in the
  LSP server.

## Acceptance Criteria

- `server/wxml-language-service.mjs` exists and contains WXML feature mapping
  logic for diagnostics, definition, and document symbols.
- Direct service-level tests cover diagnostics, definition, document symbols,
  and WXS symbol de-duplication without starting the LSP server.
- `server/wxml-lsp.mjs` keeps protocol, lifecycle, graph scheduling, and request
  dispatch responsibilities, and delegates WXML feature answers to the language
  service.
- Existing diagnostics behavior remains unchanged.
- Existing component definition behavior remains unchanged.
- `textDocument/documentSymbol` returns the scoped flat symbol list described in
  this spec.
- Document symbol requests can build or wait for a graph without blocking
  unrelated JSON-RPC requests.
- `node scripts/verify-lsp-diagnostics.mjs` passes.
- `scripts/verify-tree-sitter.sh` passes.
- README documents the capability and its limits.
