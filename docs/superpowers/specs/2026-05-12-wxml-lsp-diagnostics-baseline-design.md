# WXML LSP Diagnostics Baseline Design

Date: 2026-05-12

## Goal

Build the smallest Zed-integrated WXML language server prototype that proves the
project graph can produce a real editor-facing capability.

The first capability is diagnostics for missing local components declared in
`usingComponents`. This is intentionally narrower than completion,
go-to-definition, hover, document symbols, semantic tokens, or formatting.

## Current State

The extension currently provides syntax-level language support:

- `extension.toml` registers the WXML language, snippets, and Tree-sitter
  grammar.
- `languages/wxml/` contains config and query files.
- `scripts/extract-wxml-symbols.mjs` emits a deterministic per-file WXML model.
- `scripts/extract-wxml-project-graph.mjs` emits a deterministic project graph
  from `app.json`, page/component JSON files, local relative `usingComponents`,
  and WXML `import`/`include` dependencies.
- `fixtures/miniprogram/` contains a missing local component declaration:
  `missing-card`.

The extension does not yet provide a language server. Zed language servers are
registered in `extension.toml` and launched through Rust extension code via
`language_server_command`. The WXML LSP process itself can still be a Node
stdio server; Rust only needs to return the command used to launch it.

## Scope

Included:

- Add a minimal Zed Rust extension glue layer that launches a Node stdio LSP
  server.
- Register a WXML language server in `extension.toml`.
- Add a Node stdio LSP server for WXML.
- Add diagnostics for missing local `usingComponents` entries that are used as
  tags in the currently diagnosed WXML file.
- Reuse `scripts/extract-wxml-project-graph.mjs` for project graph construction.
- Add a protocol-level test harness that starts the Node server over stdio and
  verifies published diagnostics for the fixture project.
- Document the prototype boundary in README.

Excluded:

- Completion.
- Hover.
- Go-to-definition.
- Document symbols.
- Semantic tokens.
- Code actions.
- Formatting.
- Incremental parsing.
- File watching.
- Multi-root workspaces.
- `subPackages`.
- npm components.
- plugin components.
- `componentGenerics`.
- Running the Tree-sitter CLI on every keystroke.
- Production packaging of a Node runtime or marketplace publishing.

## Architecture

### Zed Extension Glue

Add the minimal Rust files expected by a Zed extension with runtime behavior:

```text
Cargo.toml
src/lib.rs
```

`extension.toml` should add:

```toml
[language_servers.wxml-lsp]
name = "WXML LSP"
languages = ["WXML"]

[language_servers.wxml-lsp.language_ids]
WXML = "wxml"
```

`src/lib.rs` should implement `zed::Extension` and return a `zed::Command` that
launches `node` with an absolute path to the server script:

```text
node <extension-root>/server/wxml-lsp.mjs
```

For this local prototype, `<extension-root>` is the Rust crate directory from
`env!("CARGO_MANIFEST_DIR")`. `src/lib.rs` should construct the server script
path with:

```text
PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("server/wxml-lsp.mjs")
```

and pass that path as the first argument to `node`. The implementation must not
leave `<extension-root>` as a placeholder or depend on the language server
process being launched from the extension directory.

The Rust glue should find `node` through the worktree environment, following the
same pattern as Zed language server examples that use `worktree.which(...)` and
`worktree.shell_env()`. The Node server should locate the extension root from
its own script path via `import.meta.url`.

This baseline may require `node` to exist on the user's `PATH`. That is
acceptable for a local prototype and must be documented.

### Node LSP Server

Add:

```text
server/wxml-lsp.mjs
```

The server should speak LSP over stdio using the standard `Content-Length`
framing.

Supported requests/notifications:

- `initialize`
- `initialized`
- `shutdown`
- `exit`
- `textDocument/didOpen`
- `textDocument/didSave`

The `initialize` result must advertise the synchronization capability needed for
Zed to send the events this prototype depends on:

```json
{
  "capabilities": {
    "textDocumentSync": {
      "openClose": true,
      "change": 0,
      "save": true
    }
  }
}
```

The server should publish diagnostics with:

```text
textDocument/publishDiagnostics
```

The server does not need an npm dependency. A small JSON-RPC/LSP framing helper
is enough for this phase.

### Project Graph Loading

The Node server should record initialization roots from these sources, in
priority order:

1. `initialize.params.rootUri`
2. `initialize.params.workspaceFolders[0].uri`
3. Current process working directory

For each `didOpen` or `didSave` diagnostics run, the server should resolve the
mini program project root in this order:

1. Walk upward from the current document path and use the nearest ancestor
   directory that contains `app.json`.
2. Use the first initialization root that directly contains `app.json`.

This document-first lookup is required so diagnostics still work when Zed opens
the extension repository root while the mini program fixture lives under
`fixtures/miniprogram`.

The server should build the project graph by invoking:

```text
node <extension-root>/scripts/extract-wxml-project-graph.mjs <mini-program-root>
```

The graph may be rebuilt on `didOpen` and `didSave`. That is acceptable for the
small prototype, but the server must not rebuild on every text change because
this graph path shells out to the current project graph extractor and
Tree-sitter CLI.

If no mini program root can be resolved for a document, graph extraction fails,
or the graph has no entry for the document, the server should publish an empty
diagnostics array for that document and log the reason to stderr. It should not
crash the LSP process. Publishing an empty array is required so Zed clears stale
diagnostics after a file or project graph changes.

### Diagnostic Rule

Rule name:

```text
wxml/missing-local-component
```

For each WXML file diagnostics run:

1. Find the graph `wxml` entry for that document path.
2. Find unresolved component declarations in `graph.unresolved` whose `owner`
   equals the document path and `reason === "missing-file"`.
3. Only report diagnostics for unresolved component tags that are actually used
   in the WXML file's `components` list.
4. Use the component candidate range from the WXML model as the diagnostic
   range.
5. Severity is warning.
6. Message format:

   ```text
   Missing local component "missing-card": ../../components/missing-card/missing-card
   ```

The diagnostic should include:

```json
{
  "source": "wxml-zed",
  "code": "missing-local-component"
}
```

Built-in WXML tags must not produce diagnostics.

Unresolved declarations that are not used in the current WXML file must not
produce diagnostics in this phase.

### URI and Path Rules

- Convert `file://` URIs to absolute paths.
- Convert absolute paths to the POSIX graph path convention emitted by
  `scripts/extract-wxml-project-graph.mjs` before lookup. In this prototype,
  that means paths relative to the extension repository root.
- Use POSIX separators in graph paths.
- Support only local file URIs.
- Non-file URIs produce no diagnostics.

## Protocol Test Harness

Add:

```text
scripts/verify-lsp-diagnostics.mjs
```

The harness should:

1. Spawn `node server/wxml-lsp.mjs` with cwd set to the repository root.
2. Send `initialize` with:
   - `rootUri` pointing to the repository root
   - `workspaceFolders[0].uri` pointing to the repository root
   - `capabilities.textDocument.publishDiagnostics.relatedInformation = false`
3. Send `initialized`.
4. Send `textDocument/didOpen` for
   `fixtures/miniprogram/pages/home/home.wxml`.
5. Wait for `textDocument/publishDiagnostics`.
6. Assert exactly one diagnostic for `missing-card`.
7. Assert diagnostic severity, source, code, message, and range.
8. Send `shutdown`.
9. Send `exit`.

Expected diagnostic range for the fixture is the full `<missing-card ... />`
element range in zero-based LSP coordinates:

```json
{
  "start": { "line": 14, "character": 2 },
  "end": { "line": 14, "character": 43 }
}
```

The harness should fail if:

- No diagnostics arrive.
- More than one diagnostic arrives for the home page.
- The diagnostic is not attached to `missing-card`.
- The diagnostic range is not exactly the expected fixture range above.
- The server only works when `rootUri` is already the mini program root.
- The LSP process exits unexpectedly.

## Verification Contract

Add a dedicated verification command:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Then integrate it into `scripts/verify-tree-sitter.sh` after the project graph
assertions or document it as a separate LSP check. The preferred baseline is to
run it from `scripts/verify-tree-sitter.sh` so one command covers all local
checks.

Expected final verification:

```bash
scripts/verify-tree-sitter.sh
```

The script should still print:

```text
wxml-zed tree-sitter verification passed
```

## README Contract

README should document:

- WXML now has a prototype language server.
- The language server currently only reports missing local components declared
  in `usingComponents` and used in WXML.
- The prototype requires `node` on `PATH`.
- It does not provide completion, hover, go-to-definition, document symbols,
  semantic tokens, formatting, file watching, npm/plugin component resolution,
  or `subPackages`.

## Risks and Constraints

- Zed requires Rust glue for extension-provided language servers. A pure Node
  server is not enough for Zed integration.
- Node performance is acceptable for this diagnostic-only prototype, but the
  current graph path shells out to the Tree-sitter CLI and should not run on
  every keystroke.
- Rebuilding the graph on open/save is acceptable for the fixture baseline; a
  future production LSP should keep cached graph state and add invalidation.
- The prototype depends on `node` being available. Packaging a Node runtime is
  explicitly out of scope.
- Zed dev-extension behavior must be tested manually after the protocol harness
  passes because the automated harness only verifies the LSP process itself.

## Acceptance Criteria

- `extension.toml` registers `wxml-lsp` for the `WXML` language.
- `Cargo.toml` and `src/lib.rs` provide minimal Zed extension glue.
- `server/wxml-lsp.mjs` starts as a stdio LSP server.
- Opening `fixtures/miniprogram/pages/home/home.wxml` through the harness
  produces exactly one missing component diagnostic for `missing-card` even
  though the harness initializes the LSP with the repository root.
- `scripts/verify-lsp-diagnostics.mjs` passes.
- `scripts/verify-tree-sitter.sh` runs the LSP diagnostics harness and passes.
- README documents the LSP prototype boundary and Node requirement.
- No completion, hover, go-to-definition, document symbols, semantic tokens,
  formatting, file watching, npm/plugin resolution, or `subPackages` support is
  introduced.
