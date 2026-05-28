# Third-Party Notices

The WXML LSP distributable artifact (`wxml-lsp-node`) bundles the following
third-party components. Each is distributed under its own license; the full
license texts are included in the artifact at the paths noted below.

## tree-sitter-javascript
- Bundled as: `grammar/tree-sitter-javascript/tree-sitter-javascript.wasm` (compiled grammar; parses `.js`/`.ts` owner scripts).
- License: MIT — Copyright (c) 2014 Max Brunsfeld.
- Full text: `grammar/tree-sitter-javascript/LICENSE`.

## tree-sitter-wxml
- Bundled as: `grammar/tree-sitter-wxml/tree-sitter-wxml.wasm` (compiled WXML grammar).
- License: MIT — initial grammar seed from BlockLune/tree-sitter-wxml, maintained as first-party project source thereafter (see `NOTICE`).

## web-tree-sitter
- Bundled as: `node_modules/web-tree-sitter/` (Tree-sitter runtime, including `tree-sitter.wasm`).
- License: MIT.
- Full text: `node_modules/web-tree-sitter/LICENSE`.

wxml-zed itself is MIT licensed; see `LICENSE` and `NOTICE`.
