# wxml-zed Project Baseline Design

Date: 2026-05-11

## Decision

`wxml-zed` will be developed as an independent Zed extension for WXML. It is not a BlockLune upstream PR track, and its Tree-sitter grammar will be maintained by this project.

The project will use a single repository that contains both the Zed extension and the WXML grammar source. The grammar will not be included as a git submodule.

## Goals

- Create a clean local development baseline for a complete WXML Zed extension.
- Maintain `tree-sitter-wxml` as first-party source inside this repository.
- Make grammar changes, query changes, fixtures, and verification commands evolve together.
- Keep the first implementation phase focused on syntax-level support and project structure.
- Preserve enough provenance and license clarity for existing copied code without presenting this as an upstream fork.

## Non-Goals

- No LSP implementation in the baseline phase.
- No marketplace publishing in the baseline phase.
- No git submodule setup for the grammar.
- No compatibility promise with BlockLune's repository structure.
- No broad rewrite of highlighting or snippets until the grammar baseline is in place.

## Repository Layout

The target structure is:

```text
wxml-zed/
  extension.toml
  languages/
    wxml/
      config.toml
      highlights.scm
      injections.scm
      indents.scm
      outline.scm
      textobjects.scm
  snippets/
    wxml.json
  fixtures/
    test.wxml
  grammar/
    tree-sitter-wxml/
      grammar.js
      package.json
      src/
      test/
        corpus/
  docs/
    superpowers/
      specs/
```

`test.wxml` should move under `fixtures/` so the repository root is reserved for extension metadata, docs, and project-level tooling.

## Extension Metadata

`extension.toml` should describe this as the `wxml-zed` project:

- `id` should become a new extension id, such as `wxml-zed`, to avoid claiming the existing `wxml` marketplace identity.
- `name` should stay user-facing and clear, such as `WXML`.
- `authors` should name this project's maintainer.
- `repository` should point to this project's repository once it exists.
- `version` should advance from the inherited `0.1.0` baseline.

`languages/wxml/config.toml` should use `name = "WXML"` and `grammar = "wxml"`. The language name matters because Zed scopes snippets by the lowercase language name, so `snippets/wxml.json` should map cleanly to the WXML language.

During local development, the grammar entry must load the grammar source from this repository. Use a `file://` grammar repository URL pointing at `grammar/tree-sitter-wxml/` so Zed dev-extension installs exercise the vendored grammar rather than the old remote grammar.

Before marketplace publishing, confirm whether the extension can keep using a controlled local grammar path from the extension package or must reference a public git repository and commit. If a public grammar repository is required, split or mirror `grammar/tree-sitter-wxml` at that point and pin the controlled revision.

## Grammar Strategy

The grammar is the authority for WXML syntax shape. Zed query files should not compensate for poor node modeling when the grammar can express the concept directly.

Initial grammar work should focus on stable nodes for:

- template definitions: `<template name="...">`
- template usage: `<template is="..." />` and paired template usage
- inline WXS: `<wxs module="..."> ... </wxs>`
- external WXS: `<wxs module="..." src="..." />`
- imports: `<import src="..." />`
- includes: `<include src="..." />`
- block and slot elements
- WXML attributes including `wx:*`, events, `model:*`, `generic:*`, `data-*`, boolean attributes, and interpolated attribute values

The grammar package should include corpus tests for each supported syntax surface before Zed queries depend on that node shape.

## Zed Query Strategy

The Zed extension layer should consume the grammar in focused query files:

- `highlights.scm`: tags, built-in components, directives, attributes, interpolation, raw WXS bodies, and punctuation.
- `outline.scm`: navigable declarations only, primarily template definitions, WXS modules, imports, and includes.
- `injections.scm`: JavaScript injection for interpolation expressions and WXS bodies.
- `textobjects.scm`: element, comment, and WXS body text objects with names that match Zed Vim behavior.
- `indents.scm` and `brackets.scm`: basic editing ergonomics.

When a query becomes awkward because the grammar collapses distinct WXML concepts into generic `element` nodes, fix the grammar first.

## Fixtures and Verification

The baseline should include a fixture WXML file that covers:

- ordinary built-in components
- custom components
- `wx:if`, `wx:elif`, `wx:else`
- full and short `wx:for`
- `block`
- `slot` element versus `slot` attribute
- template definitions and usage
- inline and external WXS
- import and include
- event prefixes including `bind`, `catch`, `mut-bind`, `capture-bind`, and `capture-catch`
- `generic:*`, `model:*`, `data-*`
- boolean attributes
- interpolated text and interpolated attributes
- HTML entities

Verification should include:

- grammar corpus tests inside `grammar/tree-sitter-wxml`
- Tree-sitter parse checks against the fixture
- Tree-sitter query checks for Zed query files
- manual Zed dev-extension install and reload checks

## Documentation

The README should be rewritten around this independent project:

- what the extension supports
- what is intentionally out of scope
- how to install as a Zed dev extension
- how to run grammar and query checks
- how the grammar source is maintained
- license and provenance notes

The README should avoid claiming unverified support. For example, snippets and Vim text objects should only be marked complete once their file naming and capture names have been verified against Zed behavior.

## License and Provenance

Because the current working tree contains code derived from an existing public repository, the baseline should preserve appropriate provenance in the license or notice text.

The project should not present itself as an upstream fork. It should state that `wxml-zed` is independently maintained, while separately documenting any copied or adapted sources if needed.

Baseline license work is required, not deferred to marketplace publishing:

- Use MIT for `wxml-zed`.
- Preserve required copyright/provenance for copied or adapted source in `LICENSE`, `NOTICE`, or README.
- For files that should no longer depend on inherited behavior, classify them as rewrites in the implementation plan and replace them deliberately.
- Do not claim that the project has no relation to inherited code unless the affected files have been rewritten or provenance has been handled.

Before marketplace publishing, re-check that all included extension and grammar source has a clear redistributable license.

## Implementation Sequence

1. Classify the current dirty working tree by file: adopt, rewrite, or defer. Do not silently mix unreviewed fork-oriented changes into the independent baseline.
2. Normalize project identity and metadata for `wxml-zed`.
3. Set the language name to `WXML` so language metadata, snippets, and future LSP mappings agree.
4. Add `grammar/tree-sitter-wxml` as first-party source, not a submodule.
5. Configure Zed dev-extension grammar loading to use the vendored grammar source.
6. Move the WXML fixture into `fixtures/`.
7. Add or document local verification commands for grammar parse, corpus, and query checks.
8. Adjust README to describe the independent project and current baseline.
9. Only then start improving grammar node modeling and downstream Zed queries.

## Acceptance Criteria

- The repository clearly represents `wxml-zed` as an independent project.
- The grammar source exists inside the repository without a git submodule.
- Zed dev-extension installs load the vendored grammar rather than the old remote grammar.
- `languages/wxml/config.toml` uses `name = "WXML"` and snippets are scoped accordingly.
- Zed extension files remain loadable as a dev extension.
- Fixtures and verification workflow are documented.
- Existing uncommitted extension improvements are either reconciled into the baseline or deliberately deferred.
- License and provenance handling is explicit for inherited or adapted files.
- No LSP or marketplace publishing work is mixed into the baseline.
