# WXML LSP Completion Baseline Design

## Goal

Add the first narrow `textDocument/completion` baseline for WXML.

This slice should prove that the existing project graph and
`server/wxml-language-service.mjs` boundary can power edit-time assistance, not
only diagnostics, definitions, and document symbols.

The baseline is intentionally small:

- complete WXML tag names from built-in components and visible local
  `usingComponents`;
- complete static template names inside `<template is="...">`;
- complete a small fixed set of common WXML attribute names inside a start tag.

The implementation should optimize for predictable behavior, testability, and
future extension points rather than broad completion coverage.

## Non-Goals

- Do not implement fuzzy ranking, snippet insertion, or commit characters.
- Do not complete attribute values other than static template names in `is`.
- Do not complete event handler names, data fields, WXS module members, or
  JavaScript expressions inside interpolation.
- Do not implement npm/plugin component completion.
- Do not implement `componentGenerics`.
- Do not implement recursive/full template visibility.
- Do not add per-keystroke graph rebuilds or file watching.
- Do not move completion logic into `server/wxml-lsp.mjs`.
- Do not change the project graph schema unless a test proves the current graph
  cannot represent a required baseline case.

## Current Context

The repository already has these layers:

- Tree-sitter grammar and query files for syntax-level WXML editor support.
- `scripts/extract-wxml-symbols.mjs`, which extracts WXML dependencies,
  template symbols, template references, WXS modules, and custom component
  candidates.
- `scripts/extract-wxml-project-graph.mjs`, which builds a mini program graph
  with pages, subpackages, local and app-global `usingComponents`, WXML file
  models, and unresolved entries.
- `server/wxml-lsp.mjs`, which owns stdio JSON-RPC, root discovery, graph build
  scheduling, graph caching, open document tracking, and LSP request dispatch.
- `server/wxml-language-service.mjs`, which owns pure WXML mapping for
  diagnostics, definitions, and document symbols.

Completion should follow the same top-down architecture:

1. the LSP host resolves the document and current project graph;
2. the language service maps graph plus source context to LSP completion items;
3. the LSP host returns the items without embedding WXML semantic rules.

## Completion API

Add a new named export to `server/wxml-language-service.mjs`:

```javascript
getCompletions({ graph, documentPath, position, sourceText, extensionRoot })
```

Rules:

- Inputs are plain data: graph JSON, absolute document path, LSP position,
  current document text, and `extensionRoot`.
- Output is an LSP-compatible `CompletionItem[]`.
- Missing file models, invalid positions, unsupported contexts, or missing
  `sourceText` return `[]`.
- The function must not read files, spawn processes, write JSON-RPC messages, or
  mutate server state.
- Position/context detection may use source text scanning for this baseline.
  It should be conservative: if the context is ambiguous, return `[]`.

`server/wxml-lsp.mjs` should:

- advertise `completionProvider`;
- handle `textDocument/completion`;
- use the open document text from `didOpen` / `didChange`;
- await the current project graph through the existing graph request path;
- call `getCompletions(...)`;
- respond with `CompletionItem[]`;
- keep `handleMessage` non-blocking by dispatching async handlers.

The LSP should add full-text sync support only as far as completion requires
current open document text. It does not need semantic incremental parsing in
this slice.

## Source Text Tracking

The current LSP advertises:

```javascript
textDocumentSync: {
  openClose: true,
  change: 0,
  save: true,
}
```

Completion needs current source text. Change text sync to full-document changes:

```javascript
textDocumentSync: {
  openClose: true,
  change: 1,
  save: true,
}
```

Track open documents as:

```javascript
{
  path,
  text,
}
```

`didOpen` stores `params.textDocument.text` when provided.

The current diagnostics path also records open documents. This slice must not
let diagnostics scheduling overwrite the stored text. Implement this by either:

- making diagnostics scheduling preserve an existing `{ path, text }` entry; or
- splitting document tracking from diagnostics scheduling so `didOpen`,
  `didChange`, `didSave`, and `textDocument/completion` all read the same open
  document record.

`didOpen` should store the document text before scheduling diagnostics.

`didChange` replaces the open document text from the first full-content change
where `range` is absent and `text` is a string. Range-based incremental changes
are out of scope and should be ignored rather than partially applied.

`didSave` should keep the existing diagnostic scheduling behavior. If
`params.text` is present, update the open document text before scheduling.

`didClose` removes the document and clears diagnostics as it does today.

## Completion Contexts

### Tag Name Completion

Offer tag name completions when the cursor is inside an opening tag name prefix.

Supported examples:

```wxml
<
<vi
<user-
```

Unsupported examples:

```wxml
</
<view |
{{ |
```

Sources:

- built-in WXML / mini program components from a reusable JavaScript constant
  owned by this repository;
- visible custom components from `graph.usingComponents` where:
  - `owner` is the current document graph path;
  - `resolved === true`;
  - `tag` is a non-empty string.

The reusable built-in component list should become the source used by the
language service and the symbol extractor's component-candidate filtering.
`languages/wxml/highlights.scm` cannot import JavaScript, so the implementation
plan must include a drift check that compares the JS list with the highlight
query's `@tag.builtin` list.

Return labels as tag names. Built-ins and custom components can both use
`CompletionItemKind.Class` or a locally documented numeric kind. The item should
replace the current tag-name prefix with the selected label. Tests should assert
labels, replacement ranges, and stable ordering, not depend on Zed-specific
rendering.

Ordering:

1. custom components for the current owner, sorted by tag;
2. built-in components, sorted alphabetically.

This keeps project-specific items near the top without inventing ranking.

### Template `is` Completion

Offer template name completions only when the cursor is inside the value of a
`template` tag's `is` attribute.

Supported examples:

```wxml
<template is="|
<template is="load|
```

Unsupported examples:

```wxml
<template data="|
<view is="|
<template is="{{dynamic}}|
<!-- <template is="| -->
<wxs module="tools">var tag = "<template is=\"|\""</wxs>
```

Sources:

- local template definitions in the current WXML file;
- direct `import` / `include` WXML dependency files, using the same direct-scope
  visibility rule as template go-to-definition.

Dynamic template expressions remain unsupported. If the `is` attribute value
contains `{{`, return `[]`.

Ordering:

1. local templates sorted by source order;
2. direct dependency templates sorted by dependency declaration order, then
   source order within each dependency file;
3. de-duplicate repeated names, keeping the first visible item.

This mirrors the existing direct-scope model while avoiding recursive template
semantics.

Completion de-duplicates repeated template names only as a candidate-display
strategy. It does not change definition eligibility: duplicate visible template
definitions should continue to make `textDocument/definition` return `null`.

### Attribute Name Completion

Offer attribute name completions when the cursor is inside a start tag after the
tag name and not inside an attribute value.

Supported examples:

```wxml
<view |
<user-card wx:|
```

Unsupported examples:

```wxml
<view class="|
</view |
{{ |
<!-- <view | -->
<wxs module="tools">var tag = "<view |"</wxs>
```

The first baseline should use a small fixed list:

- `wx:if`
- `wx:elif`
- `wx:else`
- `wx:for`
- `wx:for-item`
- `wx:for-index`
- `wx:key`
- `class`
- `style`
- `id`
- `bindtap`
- `catchtap`
- `capture-bind:tap`
- `capture-catch:tap`
- `generic:selectable`

Avoid context-specific attribute filtering in this slice. It can be added later
once completion context detection is proven.

## Completion Item Shape

Use plain `CompletionItem` objects.

Recommended baseline fields:

```javascript
{
  label: "view",
  kind: 7,
  detail: "built-in component",
  textEdit: {
    range: {
      start: { line: 0, character: 1 },
      end: { line: 0, character: 3 },
    },
    newText: "view",
  },
}
```

Kinds should be centralized in `server/wxml-language-service.mjs` with short
constant names. The exact numeric choices are less important than keeping them
stable and tested.

Use `textEdit` to replace the current typed prefix for all supported completion
contexts:

- tag name prefix after `<`;
- template `is` value prefix inside quotes;
- attribute name prefix after whitespace in a start tag.

Do not set `insertText`, `sortText`, commit characters, or snippet-formatted
insertions in this baseline.

## Error Handling

Completion should fail closed:

- invalid URI returns `[]`;
- missing project root returns `[]`;
- graph extraction failure returns `[]`;
- stale or missing open document text returns `[]`;
- ambiguous source context returns `[]`.
- positions inside WXML comments, interpolation expressions, or inline WXS raw
  text return `[]`.

Unexpected exceptions should be caught in the LSP handler, logged to stderr with
the existing `[wxml-lsp]` prefix, and returned as `[]`.

## Testing

### Direct Language-Service Tests

Extend `scripts/verify-wxml-language-service.mjs`.

Required cases:

1. tag completion includes owner-local custom components and built-ins;
2. tag completion does not appear in closing tags;
3. tag completion returns `[]` outside tag-name context;
4. template `is` completion includes local templates and direct import/include
   templates;
5. template `is` completion excludes dynamic `{{...}}` values;
6. template `is` completion does not recurse through dependency dependencies;
7. attribute completion appears after a start tag name;
8. attribute completion returns `[]` inside quoted attribute values;
9. replacement ranges cover only the typed prefix;
10. comment, interpolation, and inline WXS raw-text contexts return `[]`;
11. missing file model or invalid position returns `[]`.

Synthetic source text is acceptable for cursor-context cases. Fixture-backed
graph data should be used for component and template visibility cases.

### Protocol LSP Tests

Extend `scripts/verify-lsp-diagnostics.mjs`.

Required cases:

1. `initialize` advertises `completionProvider`;
2. `didOpen` stores source text before diagnostics finish, so an immediate
   completion request can wait for the graph and return real items without
   first waiting for `publishDiagnostics`;
3. tag completion in `pages/home/home.wxml` includes `user-card`,
   `global-badge`, and `view`;
4. template `is` completion includes `loadingRow` and `secondaryRow`;
5. attribute completion includes `wx:if`, `bindtap`, and `capture-bind:tap`;
6. `didChange` with full document text updates the completion source text;
7. diagnostics scheduling preserves open document text after `didOpen`;
8. delayed graph build does not block unrelated request handling;
9. existing diagnostics, definition, and document-symbol scenarios remain green.

The protocol harness should add a `completion(filePath, position)` helper and a
`changeDocument(filePath, text, version)` helper that sends full-content
`textDocument/didChange`.

### Total Verification

The total verification entrypoint remains:

```sh
scripts/verify-tree-sitter.sh
```

Final verification should include:

```sh
node --check server/wxml-language-service.mjs
node --check server/wxml-lsp.mjs
node --check scripts/verify-wxml-language-service.mjs
node --check scripts/verify-lsp-diagnostics.mjs
node scripts/verify-wxml-language-service.mjs
node scripts/verify-lsp-diagnostics.mjs
scripts/verify-tree-sitter.sh
```

## Documentation

Update `README.md` after implementation to add prototype completion support to
the feature matrix and LSP scope section.

The README should say completion is limited to:

- WXML tag names from built-ins and resolved owner-local components;
- static direct-scope template names in `<template is="">`;
- a small fixed set of common WXML attributes.

It should continue to mark npm/plugin components, `componentGenerics`, recursive
template visibility, expression completion, WXS module completion, hover,
formatting, semantic tokens, and code actions as unsupported.

## Acceptance Criteria

- `server/wxml-lsp.mjs` advertises and handles `textDocument/completion`.
- `server/wxml-language-service.mjs` exposes a pure `getCompletions(...)`
  function.
- Completion uses current open document text from `didOpen` / full `didChange`.
- Diagnostics scheduling preserves the stored open document text instead of
  replacing it with a path-only record.
- Tag completion returns built-ins plus resolved current-owner components.
- Built-in tag names used by completion and component-candidate filtering share
  one JS source, with a verification check against `highlights.scm`.
- Template `is` completion returns local and direct import/include static
  template names only.
- Template completion de-duplicates display candidates without changing
  duplicate-definition navigation behavior.
- Attribute completion returns the fixed baseline attribute list only in start
  tag attribute context.
- Unsupported or ambiguous contexts return `[]`.
- Existing diagnostics, definition, and document-symbol behavior remains
  unchanged.
- README documents the new completion scope and unsupported boundaries.
- Total verification passes on `main` after merge.
