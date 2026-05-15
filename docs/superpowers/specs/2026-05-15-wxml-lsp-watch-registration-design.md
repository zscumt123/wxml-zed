# WXML LSP Watch Registration Design

## Goal

Deliver real Zed watched-file notifications to the existing WXML LSP graph
refresh path.

The previous graph lifecycle slice made `server/wxml-lsp.mjs` handle
`workspace/didChangeWatchedFiles`, but Zed does not send that notification
unless the language server registers file watchers. A local Zed probe confirmed
that:

- Zed advertises `workspace.didChangeWatchedFiles.dynamicRegistration`;
- `client/registerCapability` with `workspace/didChangeWatchedFiles` succeeds;
- after registration, external `.json` edits produce real
  `workspace/didChangeWatchedFiles` notifications.

## Scope

Implement dynamic watcher registration inside `server/wxml-lsp.mjs`.

The server should:

- detect support from the `initialize` capabilities;
- after `initialized`, request registration for relevant `.json`, `.wxml`, and
  `.wxs` file patterns;
- ignore the client's response to the registration request without treating it
  as an unknown method;
- keep the existing watched-file refresh implementation unchanged.

## Non-Goals

- Do not implement a Rust-side watcher.
- Do not add Node `fs.watch` or `chokidar`.
- Do not publish project-wide diagnostics.
- Do not add npm/plugin component resolution.
- Do not change `server/wxml-language-service.mjs`.

## Protocol Shape

When supported, the server sends:

```json
{
  "jsonrpc": "2.0",
  "id": "wxml-zed-watch-registration",
  "method": "client/registerCapability",
  "params": {
    "registrations": [
      {
        "id": "wxml-zed-watched-files",
        "method": "workspace/didChangeWatchedFiles",
        "registerOptions": {
          "watchers": [
            { "globPattern": "**/*.json" },
            { "globPattern": "**/*.wxml" },
            { "globPattern": "**/*.wxs" }
          ]
        }
      }
    ]
  }
}
```

If the client does not advertise dynamic registration, the server should not
send this request. The protocol harness should cover both supported and
unsupported clients.

## Acceptance Criteria

- Zed-compatible dynamic watcher registration is sent after `initialized` when
  the client advertises support.
- The registration request uses `.json`, `.wxml`, and `.wxs` glob patterns.
- Registration responses do not produce `Method not found` errors.
- Clients without dynamic watcher support do not receive registration requests.
- Existing diagnostics, definition, document symbol, completion, and watched
  refresh tests still pass.
