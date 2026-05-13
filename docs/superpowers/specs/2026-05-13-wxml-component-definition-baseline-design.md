# WXML Component Definition Baseline Design

Date: 2026-05-13

## Goal

Add the first navigation capability to the WXML language server: go to
definition from a local custom component tag in a WXML file to the resolved
component `.wxml` file.

This slice should prove that the existing project graph and the hardened LSP
graph scheduler can answer request/response language-service features, not only
publish diagnostics.

## Current State

The current LSP prototype:

- Launches through Zed's Rust extension glue as `node server/wxml-lsp.mjs`.
- Builds a mini program project graph asynchronously on open/save.
- Caches the latest graph by mini program root.
- Coalesces repeated same-root graph requests.
- Publishes diagnostics for missing local `usingComponents` entries that are
  also used as component tags in the current WXML file.
- Has a protocol harness in `scripts/verify-lsp-diagnostics.mjs`.

The project graph already contains the data needed for a narrow component
definition feature:

- `graph.wxml[].components[]` lists custom component tag candidates and their
  source ranges.
- `graph.usingComponents[]` lists owner/tag declarations, resolved target WXML
  paths, and `resolved` status.

For example, `fixtures/miniprogram/pages/home/home.wxml` contains
`<user-card ... />`, and `fixtures/miniprogram/pages/home/home.json` resolves
`user-card` to `fixtures/miniprogram/components/user-card/user-card.wxml`.

## Scope

Included:

- Advertise `definitionProvider: true` from `initialize`.
- Handle `textDocument/definition`.
- Resolve definitions only for local custom component tags represented in
  `graph.wxml[].components[]`.
- Return the resolved component `.wxml` file when the matching
  `graph.usingComponents[]` entry is `resolved === true`.
- Return `null` when the cursor is outside a component tag, on a built-in tag,
  on a missing component, or when no project graph can be resolved.
- Reuse the current graph cache and build scheduling path.
- Extend the existing protocol harness to cover definition requests and keep
  the diagnostics scenarios passing.
- Document the feature boundary in README.

Excluded:

- Template definition navigation.
- `import` or `include` navigation.
- WXS navigation.
- npm components.
- plugin components.
- `componentGenerics`.
- Fallback navigation to component `.json` files.
- Hover.
- Completion.
- Document symbols.
- Code actions.
- File watching.
- Multi-root workspace improvements.

## Architecture

### LSP Capability

`initialize` should return:

```json
{
  "capabilities": {
    "textDocumentSync": {
      "openClose": true,
      "change": 0,
      "save": true
    },
    "definitionProvider": true
  }
}
```

This is a request/response feature. Unlike diagnostics, the server must respond
to the request ID with either a `Location` or `null`.

### Graph Availability

Definition requests should use the same mini program root resolution as
diagnostics:

1. Convert `textDocument.uri` to a file path.
2. Walk upward from the document to find the nearest `app.json`.
3. If no document-local root exists, try initialization roots that directly
   contain `app.json`.

The server should answer from the latest cached graph when possible. If the root
has no cached graph and no graph build is running, the definition request should
trigger a graph build for that root and wait for it. If a graph build is already
running for that root, the definition request should wait for the current/latest
build and then answer. If no graph can be built, respond with `null`.

The request handler must not block the JSON-RPC message loop. Waiting for graph
availability should be implemented with Promises attached to the existing async
build path. Definition requests must not rely on diagnostics having already
opened or built the graph.

### Graph Build Waiters

Add per-root graph waiters to the server state:

```text
graphWaitersByRoot: Map<projectRoot, Set<{ resolve, reject }>>
```

When a graph build completes with the current generation, resolve the waiters
with the graph after storing it in `graphsByRoot`. When a current-generation
build fails, resolve waiters with `undefined` or reject and have callers convert
the failure to `null`; either behavior is acceptable as long as
`textDocument/definition` always responds and the LSP process stays alive.

If a stale build completes and queues a newer rebuild, do not resolve waiters
with stale graph data. Waiters should resolve only when the latest queued build
finishes or fails.

Register a waiter before triggering a graph build for a definition request. This
prevents a fast graph build from completing before the request has subscribed to
the result.

### Definition Resolution

For a definition request:

1. Resolve the document path and project root.
2. Ensure a current graph is available.
3. Convert the document path to the graph path with the existing
   `graphPathForAbsolute`.
4. Find the current document's `graph.wxml[]` entry.
5. Find the first component candidate whose range contains the requested LSP
   position.
6. Find a matching `graph.usingComponents[]` entry where:
   - `owner` equals the document graph path.
   - `tag` equals the component candidate tag.
   - `resolved === true`.
   - `target` exists.
7. Return a single `Location`:

```json
{
  "uri": "file:///absolute/path/to/target.wxml",
  "range": {
    "start": { "line": 0, "character": 0 },
    "end": { "line": 0, "character": 0 }
  }
}
```

If any step fails, respond with `null`.

The component range check should treat the start as inclusive and the end as
exclusive. That avoids a cursor immediately after the closing `>` counting as
inside the component.

### Position Semantics

The existing graph ranges are zero-based row/column ranges from the symbol
extractor. LSP positions are also zero-based line/character positions. The
definition handler can compare them directly after mapping:

```text
range.start.row    <=> position.line
range.start.column <=> position.character
range.end.row      <=> position.line
range.end.column   <=> position.character
```

No UTF-16 conversion is needed for this baseline because the tested component
tag ranges are ASCII tag names. UTF-16 edge cases can be handled in a later
broader symbol-positioning pass if needed.

## Protocol Harness

Extend `scripts/verify-lsp-diagnostics.mjs` rather than adding a new harness.
The existing harness already supports requests, responses, initialization, and
document open/save.

Add helper methods:

- `definition(filePath, position)` to send `textDocument/definition`.
- `assertLocationTarget(result, targetPath)` to compare file URI and zero-zero
  range.

Required scenarios:

1. Home page component definition:
   - Initialize at repository root.
   - Open `fixtures/miniprogram/pages/home/home.wxml`.
   - Wait for diagnostics to ensure the graph has been built.
   - Request definition at a position inside `<user-card`.
   - Assert the target URI is
     `fixtures/miniprogram/components/user-card/user-card.wxml`.

2. Nested component definition:
   - Open `fixtures/miniprogram/components/user-card/user-card.wxml`.
   - Request definition at a position inside `<status-badge`.
   - Assert the target URI is
     `fixtures/miniprogram/components/status-badge/status-badge.wxml`.

3. Missing component returns null:
   - Request definition at a position inside `<missing-card`.
   - Assert result is `null`.

4. Non-component position returns null:
   - Request definition on a normal text/interpolation/blank area in
     `home.wxml`.
   - Assert result is `null`.

5. Built-in tag returns null:
   - Request definition on the `<view>` tag in `home.wxml`.
   - Assert result is `null`.

6. Definition can build the graph:
   - Start a fresh server.
   - Initialize at repository root.
   - Request definition for `<user-card>` before waiting for any diagnostics
     publication.
   - Assert the target URI is
     `fixtures/miniprogram/components/user-card/user-card.wxml`.

7. Existing diagnostics scenarios still pass:
   - Repository root initialization.
   - Mini program root initialization.
   - Clean component diagnostics.
   - `didClose` clearing.
   - `didSave` refresh.
   - Unsupported request behavior.
   - Coalesced async graph behavior.

## Documentation

Update README:

- Feature matrix should list prototype go-to-definition for local WXML
  components as supported.
- Scope should state that `server/wxml-lsp.mjs` supports missing-component
  diagnostics and local component go-to-definition only.
- Explicitly keep template/import/include/WXS/npm/plugin/generic navigation out
  of scope.

## Error Handling

The definition handler must always respond to the request. Failure to resolve a
root, build a graph, find a WXML model, find a component under the cursor, or
find a resolved component declaration should produce `null`, not an error
response.

Unexpected implementation errors should be logged to stderr with the existing
`[wxml-lsp]` prefix and then converted to `null` for the request.

## Acceptance Criteria

- `node scripts/verify-lsp-diagnostics.mjs` passes.
- `scripts/verify-tree-sitter.sh` passes.
- The LSP initialize response advertises `definitionProvider: true`.
- `textDocument/definition` on `<user-card>` returns
  `components/user-card/user-card.wxml`.
- `textDocument/definition` on nested `<status-badge>` returns
  `components/status-badge/status-badge.wxml`.
- `textDocument/definition` on `<missing-card>` returns `null`.
- `textDocument/definition` outside a component candidate returns `null`.
- `textDocument/definition` on a built-in `<view>` tag returns `null`.
- `textDocument/definition` can trigger graph construction when no cached graph
  exists yet.
- Existing diagnostics behavior still passes the current harness.
- README documents the new navigation boundary without claiming unsupported
  navigation features.

## Out of Scope for Next Plan

The next implementation plan should not expand navigation beyond local WXML
component tags. If this baseline passes, a later slice can add template/import
navigation or component completion using the same graph availability mechanism.
