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
| LSP diagnostics, cross-file navigation, and component resolution | Planned |

## Install

The extension is not published to the Zed extension marketplace yet. Install it
as a local development extension:

1. Clone this repository.
2. In Zed, run `zed: install dev extension`.
3. Select the repository directory.
4. Open a `.wxml` file.

## Develop

Run the Tree-sitter checks from the repository root:

```bash
scripts/verify-tree-sitter.sh
```

The script parses `fixtures/test.wxml`, runs the grammar corpus tests, validates
the highlight, outline, text object, injection, and bracket queries, checks the
focused WXS, tag-editing, and real-world compatibility fixtures, and asserts
baseline snippet keys plus the pre-LSP dependency and symbol model.

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

When changing queries or snippets:

1. Edit files under `languages/wxml/` or `snippets/`.
2. Run `scripts/verify-tree-sitter.sh`.
3. In Zed, run `zed: reload extensions` or reinstall the dev extension.
4. Open `fixtures/test.wxml`, `fixtures/tag-editing.wxml`, and the files under
   `fixtures/real-world/`; inspect highlighting, outline, snippets, text
   objects, injection behavior, and basic tag editing behavior.

## Scope

This baseline is syntax-level editor support. It intentionally does not provide
diagnostics, symbol indexing, component/template go-to-definition, or WXML-aware
formatting.

Formatting is delegated to Zed's configured HTML parser. That is a practical
baseline, not a semantic WXML formatter.

Inline `wxs` bodies and WXML interpolation expressions are injected as
JavaScript for syntax highlighting only. The extension does not type-check WXS,
resolve external `.wxs` files, validate WeChat WXS APIs, or provide WXS module
completion. Those behaviors belong in a later language-service layer.

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

## Redistribution Status

This repository includes provenance notes in `NOTICE`. The current baseline is
usable for local development, but the original public seed repositories did not
include an explicit license at the time this baseline was created. Before
publishing a marketplace extension or redistributing packaged artifacts, either
obtain upstream authorization or replace inherited source/query content with
clean-room equivalents.

## Project Layout

- `extension.toml`: Zed extension metadata and grammar registration.
- `languages/wxml/`: language config and Tree-sitter query files.
- `grammar/tree-sitter-wxml/`: vendored grammar source.
- `fixtures/test.wxml`: syntax coverage fixture.
- `scripts/extract-wxml-symbols.mjs`: pre-LSP static dependency/symbol extractor.
- `scripts/verify-tree-sitter.sh`: local verification wrapper.
- `docs/`: baseline design, plan, and local loading notes.

## License

MIT. See `LICENSE` and `NOTICE`.
