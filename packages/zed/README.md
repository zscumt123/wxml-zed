# WXML for Zed

WXML (WeiXin Markup Language) support for the Zed editor: syntax highlighting,
outline, snippets, and a language server providing diagnostics, go-to-definition,
hover, and completion for WeChat Mini-Program WXML projects.

## Requirements

This extension does **not** bundle the language server. It requires:

- **`node` on your `PATH`** — Zed launches the WXML language server as a Node
  process.

On first use the extension downloads the `wxml-lsp-node` artifact from this
project's GitHub Releases and caches it locally. No manual install step is needed.

## Grammar

Syntax highlighting uses the [`tree-sitter-wxml`](https://github.com/zscumt123/tree-sitter-wxml)
grammar, pinned in `extension.toml`.

## Local development

To run a locally-built language server instead of the released artifact, set
`WXML_ZED_LSP_ARTIFACT_DIR` to an unpacked `wxml-lsp-node` artifact directory
(must contain `server/wxml-lsp.mjs`). See the repository root README for building
the artifact (`npm run build:lsp`).

## License

MIT. Portions adapted from upstream WXML extension and Tree-sitter grammar
sources — see `LICENSE` and `NOTICE`.
