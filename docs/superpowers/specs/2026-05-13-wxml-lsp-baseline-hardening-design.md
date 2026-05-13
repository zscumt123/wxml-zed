# WXML LSP Baseline Hardening Design

Date: 2026-05-13

## Goal

Harden the current WXML LSP diagnostics prototype so it is stable enough to be
the base for later navigation and completion work.

The existing prototype proves one editor-facing capability: reporting a missing
local component declared in `usingComponents` and used in a WXML file. This
phase keeps that diagnostic rule narrow, but improves the server lifecycle,
diagnostic refresh behavior, graph build scheduling, protocol harness coverage,
and local Zed development documentation.

## Current State

The current baseline includes:

- `src/lib.rs` Zed extension glue that launches `node server/wxml-lsp.mjs`.
- `extension.toml` language server registration for `WXML`.
- `server/wxml-lsp.mjs`, a dependency-free stdio LSP server.
- `scripts/extract-wxml-project-graph.mjs`, a deterministic project graph
  extractor for one mini program root.
- `scripts/verify-lsp-diagnostics.mjs`, a protocol harness that verifies the
  `missing-card` warning in `fixtures/miniprogram/pages/home/home.wxml`.
- README documentation that describes the prototype boundary and Node
  requirement.

The main weakness is that `server/wxml-lsp.mjs` builds the graph synchronously
with `execFileSync` inside `didOpen` and `didSave`. That blocks the server while
the extractor runs. The harness also verifies only one happy path, so lifecycle,
root resolution variants, clean files, and refresh behavior are not protected.

Manual Zed testing also showed two real development constraints that should be
documented: the worktree must be trusted before Zed starts the LSP in Restricted
Mode, and Zed may need an extension reload or restart before it picks up changes
to the Node server script.

## Scope

Included:

- Replace synchronous project graph builds in the LSP server with an async,
  coalesced build queue.
- Cache the latest graph by mini program root.
- Keep only one graph build running per root at a time.
- Re-run queued diagnostics after the relevant graph build completes.
- Add `textDocument/didClose` handling that clears diagnostics for closed WXML
  files.
- Keep unsupported requests explicit by returning JSON-RPC `-32601`.
- Keep unsupported notifications ignored.
- Expand the LSP harness to cover root resolution, clean files, refresh after
  save, and close behavior.
- Document Zed trust, reload, and restart notes for local LSP development.

Excluded:

- Go-to-definition.
- Completion.
- Hover.
- Document symbols.
- Semantic tokens.
- Code actions.
- Formatting.
- Watch mode or file-system watchers.
- Incremental text parsing.
- `subPackages`.
- npm components.
- plugin components.
- `componentGenerics`.
- Production packaging of a Node runtime.
- Marketplace publishing.

## Architecture

### Server State

`server/wxml-lsp.mjs` should stay dependency-free and continue to speak LSP over
stdio with the existing `Content-Length` framing helpers.

The server should introduce small internal state maps instead of a large
framework:

```text
rootCandidates: string[]
openDocuments: Map<uri, { path: string }>
graphsByRoot: Map<projectRoot, graph>
buildStateByRoot: Map<projectRoot, { running: boolean, queued: boolean }>
pendingDiagnosticsByRoot: Map<projectRoot, Set<uri>>
```

Only `openDocuments` and diagnostics scheduling are LSP state. The project graph
extractor remains the source of truth for pages, WXML files, local
`usingComponents`, and unresolved component entries.

### Async Graph Builds

Replace the current synchronous graph build with an async helper that runs:

```text
node <extension-root>/scripts/extract-wxml-project-graph.mjs <mini-program-root>
```

Use `execFile` from `node:child_process`, wrapped in a Promise, with the same
environment currently used by the synchronous path:

```text
HOME = WXML_ZED_HOME || /private/tmp
npm_config_cache = NPM_CONFIG_CACHE || npm_config_cache || /private/tmp/npm-cache
cwd = <extension-root>
```

For each mini program root:

1. If no build is running, start one.
2. If a build is already running, mark the root as queued.
3. Add the requesting document URI to that root's pending diagnostics set.
4. When the build finishes, store the graph in `graphsByRoot` and publish
   diagnostics for all pending open documents under that root.
5. If a queued rebuild was requested while the first build was running, start
   one more build after publishing the first result.

This keeps the server responsive and avoids launching redundant graph builds
for repeated `didOpen` or `didSave` events.

### Diagnostic Scheduling

`didOpen` and `didSave` should call a scheduler instead of computing
diagnostics directly.

For a WXML URI:

1. Convert the URI to a file path. Non-file URIs are ignored.
2. Resolve the nearest mini program root by walking upward from the document
   path and looking for `app.json`.
3. If no document-local root exists, use the first initialization root that
   directly contains `app.json`.
4. If no project root exists, publish empty diagnostics for that URI and log the
   reason.
5. Add the URI to the pending diagnostics set for that root.
6. Trigger the root's async graph build.

After a graph build succeeds, diagnostics are computed from the latest graph
using the existing rule:

- Match `graph.unresolved` entries where `kind === "component"`,
  `reason === "missing-file"`, and `owner` equals the current document graph
  path.
- Only report tags that also appear in that document's `components` list.
- Use the WXML component candidate range as the diagnostic range.
- Publish warning diagnostics with `source: "wxml-zed"` and
  `code: "missing-local-component"`.

If a graph has no WXML entry for a document, publish an empty diagnostics array
and log the missing graph entry. The server should not crash.

### Close Behavior

`textDocument/didClose` should:

1. Remove the URI from `openDocuments`.
2. Remove the URI from any pending diagnostics set.
3. Publish an empty diagnostics array for the URI.

This ensures stale warnings disappear when a file is closed and prevents async
graph completion from republishing diagnostics for closed documents.

### Request and Notification Handling

The server should preserve the existing protocol behavior:

- `initialize` returns `textDocumentSync.openClose = true`,
  `change = 0`, and `save = true`.
- `initialized` is ignored.
- `shutdown` responds with `null` and marks shutdown requested.
- `exit` exits with `0` after shutdown and `1` otherwise.
- Unsupported requests return `-32601 Method not found`.
- Unsupported notifications are ignored.

This allows Zed configuration notifications to arrive without breaking the LSP
session while still surfacing real unsupported request mistakes in the harness.

## Test Harness

Expand `scripts/verify-lsp-diagnostics.mjs` from a single happy-path script into
a small protocol test harness with reusable helpers:

- Start the server with `node server/wxml-lsp.mjs`.
- Send JSON-RPC messages with incrementing IDs.
- Wait for responses by ID.
- Wait for diagnostics by URI and expected predicate.
- Shut the server down cleanly.

Required scenarios:

1. Repository root initialization:
   - Initialize with the repository root.
   - Open `fixtures/miniprogram/pages/home/home.wxml`.
   - Assert exactly one `missing-card` warning with the current severity,
     source, code, message, and range.

2. Mini program root initialization:
   - Initialize with `fixtures/miniprogram` as the root.
   - Open the same home file.
   - Assert the same one warning.

3. Clean component file:
   - Open `fixtures/miniprogram/components/user-card/user-card.wxml`.
   - Assert zero diagnostics.

4. Close clears diagnostics:
   - Open the home file and observe the `missing-card` warning.
   - Send `textDocument/didClose`.
   - Assert the server publishes an empty diagnostics array for the home URI.

5. Save refresh clears fixed component:
   - Copy `fixtures/miniprogram` to a temporary directory under `/private/tmp`.
   - Open the temp `pages/home/home.wxml` and assert one warning.
   - Create the missing component files under the temp project's
     `components/missing-card/` path.
   - Send `textDocument/didSave` for the temp home file.
   - Assert diagnostics become empty.

6. Unsupported request behavior:
   - Send a harmless unsupported request such as `workspace/symbol`.
   - Assert the response error code is `-32601`.

The harness must avoid mutating tracked fixtures. Temporary projects should be
created under `/private/tmp` and cleaned up at the end of the run.

`scripts/verify-tree-sitter.sh` should continue to call the LSP harness as part
of the full local verification path.

## Documentation

Update README development notes to cover:

- The LSP server now uses an async graph build queue and cached graph state.
- Diagnostics still run on open/save only.
- Zed Restricted Mode requires trusting the worktree before the LSP starts.
- If Node server changes do not appear in Zed immediately, reload extensions or
  restart Zed.
- The prototype still requires `node` on `PATH` and does not package Node.

The feature matrix should still describe this as prototype diagnostics. It
should not imply production-ready language-service behavior.

## Error Handling

The server should never terminate because graph extraction fails, JSON parsing
fails, a document is outside a mini program root, or Zed sends an unsupported
notification.

Failure behavior:

- Log a concise `[wxml-lsp] ...` message to stderr.
- Publish empty diagnostics for affected open documents.
- Keep serving later LSP messages.

If an async build fails while another rebuild was queued, the server should
still run the queued rebuild. A transient failure should not permanently wedge a
root's build state.

## Acceptance Criteria

- `node scripts/verify-lsp-diagnostics.mjs` passes.
- `scripts/verify-tree-sitter.sh` passes.
- The LSP harness verifies repository-root and mini-program-root initialization.
- The harness verifies clean-file diagnostics, didClose clearing, didSave
  refresh, and unsupported request errors.
- `server/wxml-lsp.mjs` no longer uses `execFileSync` for graph builds.
- Diagnostics are not republished for closed documents after async graph builds
  complete.
- README documents Zed worktree trust and reload or restart notes for local LSP
  development.

## Out of Scope for Next Plan

The next implementation plan should not include navigation, completion,
document symbols, or file watching. Once this hardening slice passes, the next
feature slice can safely choose between document symbols and component/template
go-to-definition using the stabilized graph scheduling path.
