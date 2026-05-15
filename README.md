# wxml-zed

WXML (WeiXin Markup Language) support for the Zed editor.

This repository is an independently maintained Zed extension. The Tree-sitter
grammar is vendored under `grammar/tree-sitter-wxml/` as project source, not as a
git submodule.

## Features

| Capability | Status |
| --- | --- |
| `.wxml` file association | Yes |
| WXML Tree-sitter grammar | Yes |
| Syntax highlighting for tags, attributes, strings, comments, entities, and interpolation | Yes |
| Built-in mini program component highlighting | Yes |
| `wx:*`, event, `model:`, `generic:`, and `data-` directive highlighting | Yes |
| Local property highlighting for declaration attributes on `template`, `wxs`, `import`, and `include` | Yes |
| JavaScript highlighting injection for interpolation and inline `wxs` bodies | Yes |
| Outline entries for template definitions, WXS modules, imports, and includes | Yes |
| Vim text objects for elements, comments, and WXS bodies | Yes |
| WXML snippets | Yes |
| Basic tag editing through bracket matching, autoclose pairs, comments, and snippets | Yes |
| Tree-sitter parse/query verification script | Yes |
| Pre-LSP dependency and symbol model extractor | Yes |
| Pre-LSP project graph extractor for pages, subpackages, local components, and app-global components | Yes |
| Prototype LSP diagnostics for missing local `usingComponents` | Yes |
| Prototype go-to-definition for local WXML components, import/include dependencies, external WXS files, and direct-scope static templates | Yes |
| Internal WXML language-service boundary for LSP features | Yes |
| Prototype LSP document symbols for WXML declarations and dependencies | Yes |
| Prototype LSP completion for built-in tags, resolved local components, direct-scope static templates, and common attributes | Yes |
| Prototype watched-file graph refresh for open-document diagnostics, definition, and completion | Yes |
| Dynamic template completion/navigation, recursive/full template visibility, npm/plugin component support, and full component resolution navigation | Planned |

## Install

The extension is not published to the Zed extension marketplace yet. Install it
as a local development extension:

1. Clone this repository.
2. In Zed, run `zed: install dev extension`.
3. Select the repository directory.
4. Open a `.wxml` file.

## Develop

Run the local verification checks from the repository root:

```bash
scripts/verify-tree-sitter.sh
```

The script parses `fixtures/test.wxml`, runs the grammar corpus tests, validates
the highlight, outline, text object, injection, and bracket queries, checks the
focused WXS, tag-editing, and real-world compatibility fixtures, and asserts
baseline snippet keys plus the pre-LSP dependency, symbol, and project graph
models. It also verifies the pure WXML language-service mapping layer and starts
the prototype WXML language server over stdio to verify missing local component
diagnostics, go-to-definition for resolved local components, WXML
import/include dependencies, external WXS dependencies, and static template
definitions, plus flat document symbols for WXML declaration/dependency entries
and baseline completion for tags, static templates, and common WXML attributes.
The protocol harness also verifies watched-file graph refresh for JSON component
registration changes and component file creation/deletion.

The prototype LSP requires `node` on `PATH`. Zed launches the Node stdio server
through `language_server_command`; this extension does not package a Node
runtime. The server builds the mini program project graph asynchronously on
open/save, caches the latest graph by mini program root, and coalesces repeated
same-root diagnostic requests so graph extraction does not block the LSP message
loop.

For local Zed development, `extension.toml` currently points `[grammars.wxml]` at
this local git checkout:

```text
file:///private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511
```

Zed accepted that form during the local loading spike. It did not accept the
vendored non-git grammar directory directly when using a pinned `rev`. If the
temporary checkout is removed or this repository is moved to another machine,
recreate a local git checkout of the grammar at the pinned revision and update
`extension.toml` accordingly. The vendored grammar under
`grammar/tree-sitter-wxml/` remains the first-party source baseline for this
repository. See `docs/local-grammar-loading.md` for the observed Zed behavior.

For local WXML LSP development:

- If the worktree opens in Restricted Mode, trust the worktree before expecting
  `wxml-lsp` diagnostics. Zed will not start the language server for an
  untrusted worktree.
- If changes to `server/wxml-lsp.mjs` do not appear immediately, run
  `zed: reload extensions`; if an old server process is still active, restart
  Zed.
- LSP diagnostics run for open WXML documents on open/save and on relevant
  `workspace/didChangeWatchedFiles` refreshes. There is still no Node-side file
  watcher, no project-wide diagnostics publication, and no per-keystroke graph
  rebuild.

When changing queries or snippets:

1. Edit files under `languages/wxml/` or `snippets/`.
2. Run `scripts/verify-tree-sitter.sh`.
3. In Zed, run `zed: reload extensions` or reinstall the dev extension.
4. Open `fixtures/test.wxml`, `fixtures/tag-editing.wxml`, and the files under
   `fixtures/real-world/`; inspect highlighting, outline, snippets, text
   objects, injection behavior, and basic tag editing behavior.

## Scope

This baseline is syntax-level editor support plus narrow prototype LSP behavior:
missing local component diagnostics, go-to-definition for resolved local WXML
component tags, go-to-definition for WXML import/include and external WXS file
dependencies, go-to-definition for static template usages within the current
file and direct `import` / `include` dependencies, and flat document symbols for
WXML declaration/dependency entries. It also provides baseline completion for
built-in tags, resolved owner-local/app-global component tags, static templates
visible from the current file or direct `import` / `include` dependencies, and
common WXML attributes.
The LSP host can also refresh the cached project graph from
`workspace/didChangeWatchedFiles` notifications for relevant `.json`, `.wxml`,
and `.wxs` files, then republish diagnostics for already-open WXML documents.
It intentionally does not provide symbol indexing, dynamic template
completion/navigation, recursive/full template visibility, expression
completion, WXS module completion, hover, nested structural document symbols,
semantic tokens, code actions, formatting, Node-side production file watching,
project-wide diagnostics, npm/plugin component navigation, `componentGenerics`,
independent-subpackage component isolation rules, or production Node runtime
packaging.

Formatting is delegated to Zed's configured HTML parser. That is a practical
baseline, not a semantic WXML formatter.

Inline `wxs` bodies and WXML interpolation expressions are injected as
JavaScript for syntax highlighting only. The extension can navigate from
external WXS declarations to resolved local `.wxs` files, but it does not
type-check WXS, validate WeChat WXS APIs, resolve WXS module APIs, or provide
WXS module completion. Those behaviors belong in a later language-service
layer.

Basic tag editing support is provided through Zed's language config, bracket
queries, comments, and snippets. The extension does not provide semantic end-tag
insertion, paired-tag rename, Emmet expansion, or selection wrapping.

The `fixtures/real-world/` files are compatibility fixtures for representative
WXML syntax and query behavior. They do not imply project-level understanding,
component registration validation, cross-file navigation, or diagnostics.

`scripts/extract-wxml-symbols.mjs` emits a deterministic JSON model for static
WXML dependencies, template symbols, template references, WXS modules, and
custom component candidates. It does not validate file existence, read
`usingComponents`, resolve dynamic template expressions, or provide LSP
behavior.

`scripts/extract-wxml-project-graph.mjs` emits a deterministic JSON graph for a
single mini program project root. It reads top-level `app.json.pages`,
`app.json.subPackages` / `subpackages`, app-global and owner-local
`usingComponents`, local relative component paths, local root-absolute component
paths, and the existing WXML symbol model. It does not resolve npm components,
plugin components, `componentGenerics`, watch mode, or editor navigation.

`server/wxml-lsp.mjs` is a minimal stdio LSP prototype and protocol host. WXML
feature mapping lives in `server/wxml-language-service.mjs`, which converts the
project graph into diagnostics, definitions, and document symbols without
owning JSON-RPC IO or graph scheduling. The LSP reports local `usingComponents`
entries that resolve to a missing file and are also used as custom component
tags in the current WXML file. It supports go-to-definition from resolved local
custom component tags to their target `.wxml` files, from WXML
`import`/`include` declarations to their target `.wxml` files, and from external
WXS declarations to their target `.wxs` files, and from static template usages
to matching template definitions in the current file or direct `import` /
`include` dependencies. It also returns a flat document-symbol list for WXML
declaration/dependency entries such as template definitions, WXS
modules, imports, and includes. Completion items are available for built-in
tags, resolved local component tags, direct-scope static templates, and common
WXML attributes; unsupported contexts return no completion list instead of
guessing. For the baseline fixture this
reports `missing-card` in `pages/home/home.wxml`, resolves `<user-card>` to
`components/user-card/user-card.wxml`, resolves the top-level `import`,
`include`, and external `wxs` declarations to their target files, resolves the
static `loadingRow` template usage to `templates/common.wxml`, resolves the
subpackage `<global-badge>` usage through app-global `usingComponents`, resolves
the home page `<global-badge>` usage through the owner-local override, and
returns document symbols for those dependency entries. Diagnostics still run on
open/save and relevant `workspace/didChangeWatchedFiles` notifications for
already-open WXML documents. There is still no Node-side production file
watcher, project-wide diagnostics, incremental parsing, nested structural
document symbols, component usage symbols, JSON document symbols, dynamic
template completion/navigation, recursive/full template visibility, expression
completion, WXS module completion, npm/plugin component navigation, or
`componentGenerics` support.

## Redistribution Status

This repository includes provenance notes in `NOTICE`. The current baseline is
usable for local development, but the original public seed repositories did not
include an explicit license at the time this baseline was created. Before
publishing a marketplace extension or redistributing packaged artifacts, either
obtain upstream authorization or replace inherited source/query content with
clean-room equivalents.

## Project Layout

- `extension.toml`: Zed extension metadata, grammar registration, snippets, and
  WXML LSP registration.
- `Cargo.toml` and `src/lib.rs`: minimal Zed Rust extension glue for launching
  the Node LSP prototype.
- `languages/wxml/`: language config and Tree-sitter query files.
- `grammar/tree-sitter-wxml/`: vendored grammar source.
- `fixtures/test.wxml`: syntax coverage fixture.
- `scripts/extract-wxml-symbols.mjs`: pre-LSP static dependency/symbol extractor.
- `scripts/extract-wxml-project-graph.mjs`: pre-LSP mini program project graph extractor.
- `server/wxml-lsp.mjs`: prototype stdio language server.
- `server/wxml-language-service.mjs`: pure graph-to-LSP feature mapping for the Node LSP prototype.
- `scripts/verify-wxml-language-service.mjs`: direct verification for the WXML language-service boundary.
- `scripts/verify-lsp-diagnostics.mjs`: protocol-level LSP harness for diagnostics, definition, document symbols, and completion.
- `scripts/verify-tree-sitter.sh`: local verification wrapper.
- `docs/`: baseline design, plan, and local loading notes.

## License

MIT. See `LICENSE` and `NOTICE`.
