# WXML Dependency and Symbol Model Baseline Design

Date: 2026-05-12

## Goal

Define a small, verifiable dependency and symbol model for WXML files before
building any language server behavior.

The extension now has stable syntax coverage, query checks, WXS injection
checks, tag-editing checks, and real-world compatibility fixtures. The next
useful layer is not a full LSP yet; it is a reusable static model that answers:

- Which files does this WXML file reference?
- Which templates does this file define?
- Which templates does this file use?
- Which WXS modules does this file declare or import?
- Which custom component tags are present as unresolved candidates?

This phase should create the contract and verification harness for that model.
Later work can plug the same model into go-to-definition, diagnostics,
completion, or an LSP process.

## Current State

The grammar already exposes the most important structural nodes:

- `import_statement`
- `include_statement`
- `template_definition`
- `template_usage`
- `template_fallback`
- `wxs_inline`
- `wxs_external`
- generic `element` and `self_closing_tag`

`languages/wxml/outline.scm` already extracts navigable declaration-like items:

- `template name`
- inline WXS `module`
- external WXS `module`
- `import src`
- `include src`

The missing piece is a normalized model. Outline output is editor-oriented; it
does not distinguish dependency kind, symbol kind, source file, range, raw
value, normalized value, static-vs-dynamic template usage, or custom component
candidates.

## Scope

Included:

- Define a JSON-compatible symbol/dependency model.
- Add a small extraction script or CLI that parses selected WXML fixtures and
  emits deterministic JSON.
- Use the existing grammar and fixtures; do not introduce a separate parser.
- Cover declarations and references from `fixtures/real-world/page.wxml`,
  `fixtures/real-world/component.wxml`, and `fixtures/real-world/templates.wxml`.
- Add verification assertions for the model output.
- Document model boundaries in README or a focused docs file.

Excluded:

- Zed LSP integration.
- Rust extension work.
- File existence checks.
- Path normalization beyond preserving the literal `src` value and computing a
  simple file-relative normalized path when safe.
- Resolving dynamic `template is="{{...}}"` expressions.
- Resolving WeChat `usingComponents` JSON.
- Cross-file go-to-definition.
- Diagnostics for missing symbols or missing files.
- JavaScript/WXS semantic analysis.

## Design

### Model Shape

The model should be JSON and deterministic. A single run over a list of files
should emit:

```json
{
  "version": 1,
  "files": [
    {
      "path": "fixtures/real-world/page.wxml",
      "dependencies": [],
      "symbols": [],
      "references": [],
      "components": []
    }
  ]
}
```

Each `dependencies` entry:

```json
{
  "kind": "import",
  "value": "./templates.wxml",
  "normalized": "fixtures/real-world/templates.wxml",
  "range": {
    "start": { "row": 0, "column": 0 },
    "end": { "row": 0, "column": 33 }
  }
}
```

Rules:

- `kind` is one of `import`, `include`, or `wxs`.
- `import` and `include` dependencies use `src` as `value`.
- external `wxs` dependencies use `src` as `value` and include `module` when
  present.
- inline WXS modules are symbols, not dependencies.
- `normalized` should be present only for relative literal paths that can be
  safely joined with the WXML file directory. Dynamic values stay absent.
- `range` should point to the whole statement or start tag node, not just the
  attribute value.

Each `symbols` entry:

```json
{
  "kind": "template",
  "name": "loadingRow",
  "range": {
    "start": { "row": 0, "column": 0 },
    "end": { "row": 4, "column": 11 }
  }
}
```

Rules:

- `kind` is one of `template` or `wxs`.
- `template_definition` creates `kind: "template"`.
- `wxs_inline` creates `kind: "wxs"`.
- `wxs_external` may also create a `kind: "wxs"` symbol for the imported module,
  because later completion and go-to-definition need the module name even when
  the body lives in another file.

Each `references` entry:

```json
{
  "kind": "template",
  "name": "loadingRow",
  "dynamic": false,
  "raw": "loadingRow",
  "range": {
    "start": { "row": 15, "column": 6 },
    "end": { "row": 15, "column": 64 }
  }
}
```

Rules:

- Static `template is="loadingRow"` should set `dynamic: false` and `name`.
- Dynamic `template is="{{useCompact ? 'compactFooter' : 'fullFooter'}}"`
  should set `dynamic: true`, keep `raw`, and omit `name`.
- `template_fallback` is not a reference.

Each `components` entry:

```json
{
  "tag": "user-card",
  "range": {
    "start": { "row": 18, "column": 6 },
    "end": { "row": 32, "column": 18 }
  }
}
```

Rules:

- A component candidate is a generic element tag that is not a known WXML
  built-in and not a control tag (`template`, `wxs`, `import`, `include`,
  `slot`, `block`).
- Hyphenated tags such as `user-card`, `price-row`, `empty-state`,
  `loading-spinner`, and `status-badge` should be captured.
- Built-ins from `highlights.scm` should be excluded.
- The extractor should not validate whether a component is registered. This is
  only a candidate list.

### Extraction Approach

Use a local script first, not a Zed extension or LSP process.

Recommended file:

- `scripts/extract-wxml-symbols.mjs`

The script should:

1. Use `tree-sitter-cli parse --grammar-path grammar/tree-sitter-wxml` with XML
   or CST output only if that is enough to extract fields reliably.
2. Prefer the generated Tree-sitter Node binding only if it is already usable
   from this repository without adding heavy setup.
3. Emit sorted, stable JSON.

If direct Tree-sitter API setup becomes too heavy, a narrower first cut may use
Tree-sitter query output plus fixture-level assertions. That fallback is
acceptable only if the model contract remains JSON and deterministic.

The script should be fixture-oriented in this phase. It does not need to scan
an entire project tree. Explicit file paths are enough:

```bash
node scripts/extract-wxml-symbols.mjs fixtures/real-world/page.wxml fixtures/real-world/templates.wxml
```

### Verification Contract

Extend `scripts/verify-tree-sitter.sh` to run the extractor against the
real-world fixture set and assert the generated JSON contains expected entries.

Required assertions:

- `page.wxml` dependencies include:
  - `import` `./templates.wxml`
  - `include` `./shared/header.wxml`
  - external WXS module `format` with `src` `./utils/format.wxs`
- `templates.wxml` symbols include templates:
  - `loadingRow`
  - `compactFooter`
  - `fullFooter`
- `page.wxml` template references include:
  - static `loadingRow`
  - one dynamic template usage for `{{useCompact ? ...}}`
- component candidates include:
  - `user-card`
  - `price-row`
  - `empty-state`
  - `loading-spinner`
  - `status-badge`
- component candidates do not include built-ins such as `view`, `text`,
  `button`, `image`, `scroll-view`, or `input`.

Assertions should use Node to parse the JSON rather than brittle string grep.

### Documentation

Document this as a pre-LSP semantic model:

- It extracts static syntax facts.
- It does not validate project correctness.
- It does not resolve dynamic expressions.
- It does not read `app.json`, `page.json`, or `component.json`.
- It is intended to become the data source for later navigation,
  diagnostics, and completion.

## Error Handling

Valid fixture files should fail extraction if parsing fails or if required
structural nodes cannot be read.

Recovery fixtures should not be part of the model baseline in this phase. They
remain parser/query resilience fixtures, not semantic model inputs.

If a value is dynamic or cannot be normalized safely, keep the raw value and
omit the normalized field rather than guessing.

## Testing

Primary verification:

```bash
scripts/verify-tree-sitter.sh
```

Focused verification:

```bash
node scripts/extract-wxml-symbols.mjs fixtures/real-world/page.wxml fixtures/real-world/component.wxml fixtures/real-world/templates.wxml
```

The focused command should output valid JSON with stable key ordering.

## Acceptance Criteria

- A committed spec and implementation plan exist for the model.
- A deterministic extractor emits JSON for the real-world fixtures.
- `scripts/verify-tree-sitter.sh` validates the extractor output with parsed
  JSON assertions.
- The model captures dependencies, symbols, template references, and component
  candidates.
- README or docs describe this as a pre-LSP static model, not a complete
  language service.
- Existing parser/query verification still passes.
