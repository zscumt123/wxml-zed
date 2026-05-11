# WXML Semantic Grammar Baseline Design

Date: 2026-05-11

## Decision

The next functional phase will harden WXML grammar semantics before adding
larger editor features such as LSP diagnostics or cross-file navigation.

This phase is intentionally top-down: define the language model that Zed should
consume, then update grammar, corpus tests, fixtures, and query files around
that model. The goal is not to rewrite the whole grammar in one pass. The goal is
to make the highest-value WXML declarations and structural concepts explicit so
later editor features have stable nodes to depend on.

## Product Direction

`wxml-zed` should evolve through these layers:

1. File-level declarations and dependencies.
2. Component tree structure.
3. Directives and bindings.
4. Expressions and embedded languages.
5. Editor and semantic features built on top of stable syntax.

This phase focuses on layer 1 and the minimum layer 2 structure required to make
layer 1 useful in Zed queries.

## Goals

- Replace tag-name predicate workarounds in Zed queries with semantic grammar
  nodes where the grammar can represent the concept directly.
- Make WXML declaration nodes explicit for outline and future navigation:
  template definitions, template usage, WXS modules, imports, and includes.
- Preserve existing parse coverage and editor behavior while improving node
  shape.
- Keep the implementation small enough to verify with corpus tests and the
  existing `scripts/verify-tree-sitter.sh` workflow.

## Non-Goals

- No LSP implementation in this phase.
- No marketplace or publishing work.
- No full clean-room rewrite of the grammar.
- No broad built-in component registry inside the grammar.
- No complete attribute taxonomy for every directive and binding form.
- No semantic validation such as missing `wx:key`, unresolved component paths, or
  missing template definitions.

## Semantic Model

The grammar should expose these first-class nodes:

- `template_definition`: paired `<template name="...">...</template>`.
- `template_usage`: self-closing or paired `<template is="...">...</template>`.
- `wxs_inline`: paired `<wxs module="...">...</wxs>` with a raw WXS body.
- `wxs_external`: self-closing `<wxs module="..." src="..." />`.
- `import_statement`: self-closing `<import src="..." />`.
- `include_statement`: self-closing `<include src="..." />`.
- `block_element`: paired `<block>...</block>`.
- `slot_element`: paired or self-closing `<slot ...>` when used as a slot
  element.

Ordinary elements should remain generic for now:

- paired custom or built-in elements stay under `element`.
- self-closing custom or built-in elements stay under `self_closing_tag`.
- built-in component recognition remains a Zed query/highlight concern, not a
  grammar concern.

## Important Distinctions

`template` is overloaded in WXML:

- `<template name="card">...</template>` declares a template and should parse as
  `template_definition`.
- `<template is="card" data="{{...}}" />` uses a template and should parse as
  `template_usage`.
- `<template is="{{dynamicName}}" />` is still template usage, even when the
  target is dynamic.

`wxs` has two forms:

- `<wxs module="math">...</wxs>` should parse as `wxs_inline`.
- `<wxs module="math" src="./math.wxs" />` should parse as `wxs_external`.

The grammar does not need to enforce required attributes in this phase. For
example, malformed `<template>` or `<wxs>` tags can still parse if the current
grammar can recover. The first requirement is stable node shape for valid WXML.

## Query Strategy

After the grammar exposes semantic nodes, Zed query files should consume them:

- `outline.scm` should match `template_definition`, `wxs_inline`,
  `wxs_external`, `import_statement`, and `include_statement`.
- `highlights.scm` should keep declaration attribute property highlighting, but
  should target semantic nodes where possible instead of matching generic
  `element/self_closing_tag` with tag-name predicates.
- `injections.scm` should continue injecting JavaScript into interpolation
  expressions and WXS raw text. If the WXS node names change, injections must be
  updated with the grammar.
- `textobjects.scm` should keep existing behavior unless node renames require a
  narrow update.

The target is not query cleverness. If a query needs to ask "is this tag named
`wxs`?" for a core WXML declaration, that is a signal that the grammar node is
too generic.

## Corpus and Fixture Requirements

Each semantic node must have a corpus test under
`grammar/tree-sitter-wxml/test/corpus/`.

Required corpus coverage:

- template definition with `name`.
- static template usage.
- dynamic template usage with `is="{{...}}"`.
- paired template usage with children.
- inline WXS module.
- external self-closing WXS module.
- import statement.
- include statement.
- paired block element.
- slot element and normal `slot` attribute on a non-slot element.

`fixtures/test.wxml` should continue to cover the same syntax surface and should
be updated only if needed to exercise renamed nodes or new valid examples.

## Verification

The existing verification script remains the primary automated check:

```bash
scripts/verify-tree-sitter.sh
```

The implementation must also inspect parse output for representative examples
to confirm semantic node names appear as intended. Passing queries alone is not
enough if the grammar still hides core declarations under generic element nodes.

Manual Zed verification remains useful after the grammar and query updates:

- reinstall or rebuild the dev extension,
- open a `.wxml` file,
- confirm the language is `WXML`,
- confirm highlighting still renders,
- confirm the outline still shows declaration/dependency items.

## Acceptance Criteria

- Valid template definitions parse as `template_definition`.
- Valid template usage parses as `template_usage`.
- Inline WXS parses as `wxs_inline`.
- External self-closing WXS parses as `wxs_external`.
- Import and include statements keep explicit statement nodes.
- `outline.scm` no longer needs a generic `element/self_closing_tag` predicate to
  discover external WXS modules.
- Existing highlight, injection, text object, and snippet checks still pass via
  `scripts/verify-tree-sitter.sh`.
- `fixtures/test.wxml` still parses successfully.
- No LSP, publishing, remote, or clean-room licensing work is mixed into this
  phase.

## Implementation Order

1. Add or adjust grammar rules for semantic declaration nodes.
2. Regenerate parser artifacts if the repository workflow requires it.
3. Add or update corpus tests for each semantic node.
4. Update Zed query files to consume the semantic nodes.
5. Run the verification script and targeted parse inspections.
6. Rebuild/reinstall the Zed dev extension for a manual smoke check.

## Risks

- Tree-sitter precedence changes can accidentally route normal elements into
  declaration nodes or vice versa. Corpus tests should include both declaration
  and non-declaration examples.
- Renaming existing nodes can break Zed queries. Query updates must land in the
  same implementation slice as grammar changes.
- Attribute-based distinctions such as template definition versus usage may be
  hard to express perfectly in Tree-sitter grammar rules. If a perfect split
  makes the grammar brittle, prefer stable valid-case node shape and document the
  recovery behavior for malformed tags.
