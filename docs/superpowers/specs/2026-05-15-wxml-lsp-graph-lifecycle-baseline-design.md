# WXML LSP Graph Lifecycle Baseline Design

## Goal

Add a narrow graph refresh lifecycle for the WXML LSP prototype.

The current server can build a mini program project graph on open/save and on
cache-miss requests. That is enough for static fixtures, but it is not enough
for editor behavior after files outside the active WXML document change. This
slice should prove that diagnostics, definition, and completion can observe a
fresh graph after relevant project files change.

The baseline is intentionally small:

- react to LSP `workspace/didChangeWatchedFiles` notifications;
- invalidate and rebuild the cached project graph for affected mini program
  roots;
- republish diagnostics for already-open WXML documents in those roots;
- make later definition and completion requests consume the refreshed graph.

This is a graph lifecycle slice, not a new semantic feature slice.

## Non-Goals

- Do not implement a Node `fs.watch` / `chokidar` file watcher.
- Do not package or configure a production watcher runtime.
- Do not implement npm/plugin component resolution.
- Do not implement `componentGenerics`.
- Do not add recursive/full template visibility.
- Do not rebuild the graph on every WXML text edit.
- Do not move WXML semantic mapping into `server/wxml-lsp.mjs`.
- Do not change the project graph schema unless a test proves the current graph
  cannot represent the lifecycle case.
- Do not rely on a private testing-only refresh request.

## Current Context

The LSP stack already has these layers:

- `scripts/extract-wxml-project-graph.mjs` builds a complete graph snapshot for a
  mini program root from `app.json`, page/component JSON files, component WXML
  files, and direct WXML dependencies.
- `server/wxml-language-service.mjs` converts a graph snapshot into diagnostics,
  definitions, document symbols, and completion items.
- `server/wxml-lsp.mjs` owns JSON-RPC, root discovery, graph build scheduling,
  graph caching, open document tracking, and pending diagnostic publication.

The existing lifecycle is:

1. `didOpen` records the WXML document and schedules diagnostics.
2. `didSave` schedules diagnostics.
3. definition, document-symbol, and completion requests call the graph request
   path if no stable cached graph exists.
4. Graph builds are coalesced per project root so concurrent requests do not run
   multiple extractors.

There is no explicit invalidation path for project files that are not the active
WXML document. After a JSON file or component file changes, the cached graph can
stay stale until another open/save path happens to rebuild it.

## LSP Capability

For this baseline, the server should handle
`workspace/didChangeWatchedFiles` whenever the client sends it. Do not add
server-initiated `client/registerCapability` yet, and do not depend on a new
Rust-side watcher registration path in this slice.

The protocol harness will simulate `workspace/didChangeWatchedFiles` directly.
A later Zed integration slice can decide whether explicit client capability
registration or extension-side watcher configuration is needed for real editor
delivery.

## Watched Change Handling

Add a `workspace/didChangeWatchedFiles` notification handler in
`server/wxml-lsp.mjs`.

Input:

```json
{
  "changes": [
    { "uri": "file:///...", "type": 1 }
  ]
}
```

The `type` value is not semantically important in this baseline. Created,
changed, and deleted events all mean "the graph for this root may be stale".

For each changed URI:

1. Convert file URI to an absolute path.
2. Resolve the mini program root using the changed path, not only an open WXML
   document path.
3. Ignore non-file URIs and paths that are not under a root with `app.json`.
4. Group changes by project root.
5. For each affected root, invalidate the stable cached graph and schedule a
   rebuild.

Root resolution must work for deleted files. If a changed file no longer exists,
the server can still find the root by walking parent directories looking for
`app.json`.

Watched-file root resolution must be stricter than request/document root
resolution. It must not unconditionally fall back to `rootCandidates` when the
changed path is outside those roots. A watched change is eligible only when:

- walking upward from the changed path finds an `app.json`; or
- the changed path is inside a known `rootCandidate` that contains `app.json`.

This prevents an unrelated file outside the workspace from invalidating the
current mini program graph.

## Relevant Files

The baseline should treat these paths as graph-affecting:

- `app.json`;
- page and component `.json` files;
- local component `.wxml` files;
- WXML files reached by direct `import` or `include`.

The first implementation should conservatively refresh for any `.json`,
`.wxml`, or `.wxs` file under a mini program root. That is acceptable because
the graph extractor is the source of truth and the current fixture graph is
small. The server should still ignore unrelated extensions to avoid unnecessary
rebuilds for files like images or stylesheets.

## Refresh Semantics

Introduce a graph lifecycle helper in `server/wxml-lsp.mjs` with behavior like:

```javascript
refreshGraphForRoot(projectRoot)
```

Responsibilities:

- mark the cached graph for `projectRoot` stale;
- increment the root generation;
- mark all currently open WXML documents under that root as pending diagnostics;
- run or queue a graph build through the existing coalescing path.

This helper should reuse the current graph build state rather than creating a
second scheduling mechanism.

When the rebuild succeeds:

- replace the cached graph for the root;
- publish diagnostics for pending open WXML documents under that root;
- resolve graph waiters with the fresh graph.

When the rebuild fails:

- publish empty diagnostics for pending open WXML documents, matching the
  current failure behavior;
- resolve graph waiters with `undefined`;
- keep the server responsive.

## Requests During Refresh

Definition and completion requests must not use a stale graph while a refresh
is running or queued.

Expected behavior:

- If there is a stable cached graph and no refresh is pending, requests may use
  it immediately.
- If a watched-file notification invalidated the graph, requests should wait for
  the next graph build and consume that result.
- Unsupported requests should still receive `-32601` promptly while the graph
  build runs.

This preserves the existing "async handlers do not block the message loop"
property.

## Diagnostics Scope

Watched-file refresh should republish diagnostics only for WXML documents that
are currently open in the server.

The server should not scan and publish diagnostics for every WXML file in the
project. That would turn this slice into project-wide diagnostics and complicate
performance expectations too early.

Closed documents should stay closed:

- `didClose` removes the document from open tracking;
- a later watched-file refresh must not publish diagnostics for that URI.

## Test Scenarios

Extend `scripts/verify-lsp-diagnostics.mjs` with protocol-level tests using a
temporary copy of `fixtures/miniprogram`.

### JSON `usingComponents` Change

1. Open `pages/home/home.wxml` in the temp project.
2. Wait for the existing `missing-card` diagnostic.
3. Rewrite `pages/home/home.json` so `missing-card` points at an existing local
   component, for example `../../components/user-card/user-card`.
4. Send `workspace/didChangeWatchedFiles` for `pages/home/home.json`.
5. Expect diagnostics for home to clear.
6. Expect completion at `<missing-|` or `<user-|` to include the now-resolved
   `missing-card` tag.

### Component File Creation

1. Open `pages/home/home.wxml` in the temp project.
2. Wait for the existing `missing-card` diagnostic.
3. Create `components/missing-card/missing-card.wxml` and
   `components/missing-card/missing-card.json`.
4. Send `workspace/didChangeWatchedFiles` for the new component files.
5. Expect diagnostics for home to clear.
6. Expect completion to include `missing-card`.

### Component File Deletion

1. Open `pages/home/home.wxml` in the temp project.
2. Wait for baseline diagnostics.
3. Delete `components/user-card/user-card.wxml`.
4. Send `workspace/didChangeWatchedFiles` for the deleted `.wxml`.
5. Expect diagnostics to include `user-card` as missing when the tag is used.
6. Expect go-to-definition on `<user-card>` to return `null`.
7. Expect tag completion to exclude `user-card`.

### Refresh Coalescing and Responsiveness

1. Start the LSP with `WXML_ZED_LSP_GRAPH_DELAY_MS=250` and graph counter file
   enabled.
2. Open home WXML.
3. Send multiple watched-file notifications for the same root.
4. Immediately send an unsupported request such as `workspace/symbol`.
5. Expect a prompt `-32601` response before diagnostics settle.
6. Assert the graph extractor does not run concurrently and settles cleanly.

### Irrelevant Changes

1. Open home WXML and wait for diagnostics.
2. Send watched-file changes for an unrelated extension such as `.png` under the
   root and for a file outside any mini program root.
3. Assert no graph build starts and no new diagnostics are published after a
   settle interval.

## Documentation

Update `README.md` after implementation to describe:

- watched-file graph refresh as prototype LSP behavior;
- diagnostics still only publish for open WXML documents;
- there is still no production file watcher, npm/plugin resolution,
  `componentGenerics`, or project-wide diagnostics.

## Acceptance Criteria

- `server/wxml-lsp.mjs` handles `workspace/didChangeWatchedFiles`.
- Graph refresh invalidates stale cached graphs and uses the next build for
  diagnostics, definition, and completion.
- Open WXML diagnostics refresh after relevant JSON/component WXML changes.
- Requests remain responsive while graph refresh runs.
- Closed documents do not receive diagnostics from later watched-file refreshes.
- Irrelevant file changes do not trigger graph rebuilds.
- Existing completion, definition, document-symbol, and diagnostics regressions
  still pass.

## Verification

Run these checks after implementation:

```bash
node --check server/wxml-lsp.mjs
node --check scripts/verify-lsp-diagnostics.mjs
node scripts/verify-lsp-diagnostics.mjs
scripts/verify-tree-sitter.sh
```

`scripts/verify-tree-sitter.sh` should still print:

```text
wxml-zed tree-sitter verification passed
```
