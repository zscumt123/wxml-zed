# WXML Real-World Compatibility Baseline Design

Date: 2026-05-12

## Goal

Create a realistic compatibility baseline for WXML parsing and query behavior
before adding higher-level language features.

The current extension has a syntax-level baseline, WXS injection checks, and a
tag-editing fixture. The next risk is broader: a real mini program project does
not look like a single curated syntax sample. It has page-level layout,
custom components, nested templates, slot usage, event variants, data bindings,
imports/includes, WXS modules, and sometimes malformed or partially edited
markup. This phase should turn those shapes into repeatable fixtures and
script assertions.

The outcome is a guardrail: future grammar, highlight, outline, injection,
indent, bracket, snippet, or LSP work can run one script and prove it did not
break representative WXML files.

## Current State

Existing coverage:

- `fixtures/test.wxml` is a broad single-file syntax fixture.
- `fixtures/wxs-injection.wxml` focuses JavaScript injection inside
  interpolation and WXS bodies.
- `fixtures/tag-editing.wxml` focuses structural bracket captures and snippet
  availability.
- `grammar/tree-sitter-wxml/test/corpus/` covers many atomic grammar cases:
  elements, conditionals, list rendering, interpolation, entities, events,
  imports, includes, templates, slots, WXS, and recovery.
- `scripts/verify-tree-sitter.sh` parses the main fixture, runs grammar corpus
  tests, validates query files, asserts WXS injection captures, asserts
  tag-editing bracket captures, and asserts baseline snippet prefixes.

Gaps:

- There is no fixture that resembles a real page/component tree.
- There is no multi-file fixture set for page, component, template partial, and
  WXS helper shapes.
- The script does not assert compatibility categories such as custom
  components, declaration dependencies, page-level event/data patterns, or
  parser recovery in the same place.
- Existing coverage is strong for individual syntax features, but weaker as a
  regression harness for realistic WXML compositions.

## Scope

Included:

- Add a `fixtures/real-world/` fixture set with small but realistic WXML files.
- Cover page-level WXML, component-level WXML, template partials, WXS module
  usage, and intentionally recoverable editing states.
- Extend `scripts/verify-tree-sitter.sh` with parse and query assertions for
  those fixtures.
- Assert important parse nodes and representative query captures, not just
  command exit codes.
- Update README development guidance to mention the real-world compatibility
  fixture set.
- Document any grammar limitation found during fixture creation.

Excluded:

- LSP implementation.
- Cross-file symbol resolution.
- Component path resolution.
- Diagnostics for missing imports, missing components, or invalid WXS APIs.
- Formatting changes.
- Marketplace publishing.
- Large copied production fixtures.
- Clean-room license work.

If the fixture exposes a real parser bug, this phase may include a narrow
grammar fix and a matching corpus test. It should not become a grammar rewrite.

## Design

### Fixture Set

Create `fixtures/real-world/` with focused files:

- `page.wxml`: representative page markup.
- `component.wxml`: representative custom component markup.
- `templates.wxml`: reusable templates and template usage.
- `edge-recovery.wxml`: malformed or partially edited WXML that should still
  parse with useful recovery.

These files should be handwritten and compact. They should not be copied from a
closed source app or from upstream projects. The point is to encode shapes, not
real business content.

### Page Fixture Contract

`page.wxml` should include:

- built-in components such as `view`, `text`, `image`, `button`, `scroll-view`,
  and `input`;
- custom component tags such as `user-card`, `price-row`, or
  `empty-state`;
- `wx:if`, `wx:elif`, `wx:else`, `wx:for`, `wx:for-item`,
  `wx:for-index`, and `wx:key`;
- `bind`, `catch`, `capture-bind`, `capture-catch`, and `mut-bind`
  event forms;
- `model:value`, `data-*`, `generic:*`, boolean attributes, and dynamic class
  or style interpolation;
- `import`, `include`, `template is`, and external `wxs` usage;
- entities in text content.

### Component Fixture Contract

`component.wxml` should include:

- named slots and slot attributes;
- nested custom components;
- conditional empty/loading/content states;
- paired and self-closing built-in components;
- event forwarding and dataset attributes;
- dynamic attributes with interpolation.

### Template Fixture Contract

`templates.wxml` should include:

- at least two `template name` definitions;
- static `template is` usage;
- dynamic `template is="{{...}}"` usage;
- `data="{{...}}"` spread-like usage;
- nested fallback body for paired template usage.

### Recovery Fixture Contract

`edge-recovery.wxml` should include intentionally recoverable edit states:

- an unclosed normal element;
- an incomplete interpolation;
- a mismatched or missing end tag around a common component;
- a WXS fallback shape that should still preserve raw text when possible.

The verification should not demand a perfectly shaped parse tree for this file.
It should assert that parsing completes and that useful high-level nodes still
appear where the grammar can recover.

`edge-recovery.wxml` may contain `ERROR` nodes. That is acceptable for this
fixture only, because it represents in-progress editing. The script must still
assert useful surviving nodes so recovery does not degrade into total parse
collapse.

### Verification Contract

Extend `scripts/verify-tree-sitter.sh` with a real-world section.

Required checks:

- Parse every `fixtures/real-world/*.wxml` file.
- Run `highlights.scm`, `outline.scm`, `injections.scm`, `brackets.scm`, and
  `indents.scm` against representative real-world fixtures. Optional query
  files remain optional where the existing script already treats them as
  optional, but `brackets.scm` remains required.
- Assert that page/component fixtures contain `element`, `block_element`,
  `template_usage`, `import_statement`, `include_statement`,
  `wxs_external`, `interpolation`, and `entity` where expected.
- Assert that template fixtures contain `template_definition`,
  `template_usage`, and `template_fallback` where expected.
- Assert that recovery fixture parsing does not fail and still contains at
  least one useful high-level node such as `element`, `wxs_fallback`, or
  `interpolation`.
- Assert outline output for declaration/dependency items in the real-world
  fixture set, such as import/include src values, template names, and WXS module
  names.
- Assert injection output includes representative WXML interpolation content
  and WXS raw text from the real-world fixture set.

The script should keep concrete `rg` assertions for important contracts. Exit
code-only query execution is useful but insufficient for compatibility claims.
Not every fixture needs every query assertion. The rule is: parse every
real-world file, then query representative files with assertions tied to the
contract being tested.

### Grammar Corpus Contract

If a fixture reveals a parser behavior that should be stable and atomic, add a
matching corpus test under `grammar/tree-sitter-wxml/test/corpus/`.

Examples:

- custom component tag names with hyphens;
- complex directive combinations;
- recoverable WXS fallback bodies;
- nested template usage.

Do not duplicate the entire real-world fixture in corpus form. Corpus tests
should remain small and explain one grammar rule or recovery behavior at a
time.

### Documentation

README should explain that `scripts/verify-tree-sitter.sh` includes both:

- focused fixtures for specific editor/query contracts, and
- real-world compatibility fixtures for representative WXML compositions.

The documentation should avoid claiming semantic project understanding. The
fixture set proves syntax/query resilience only.

## Error Handling

For valid real-world fixtures, parse or query failures should fail the script.

For `edge-recovery.wxml`, the expected behavior is resilient parsing, not a
perfect AST. Assertions should be loose enough to allow Tree-sitter recovery,
but strict enough to catch total parse collapse or broken high-level node
recognition.

If a query file fails on realistic WXML because the query is too broad or too
specific, prefer tightening the query or fixture assertion over weakening the
entire verification section.

## Testing

Primary command:

```bash
scripts/verify-tree-sitter.sh
```

Focused checks during implementation:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli parse --grammar-path grammar/tree-sitter-wxml fixtures/real-world/page.wxml
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli query --grammar-path grammar/tree-sitter-wxml languages/wxml/highlights.scm fixtures/real-world/page.wxml
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli query --grammar-path grammar/tree-sitter-wxml languages/wxml/outline.scm fixtures/real-world/templates.wxml
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli query --grammar-path grammar/tree-sitter-wxml languages/wxml/injections.scm fixtures/real-world/page.wxml
```

Manual smoke after script verification:

- Reload or reinstall the dev extension in Zed.
- Open `fixtures/real-world/page.wxml` and
  `fixtures/real-world/component.wxml`.
- Confirm the status bar language is `WXML`.
- Confirm highlighting renders and no new WXML grammar/query errors appear in
  Zed logs.

## Acceptance Criteria

- `fixtures/real-world/` contains realistic page, component, template, and
  recovery fixtures.
- `scripts/verify-tree-sitter.sh` parses those fixtures and asserts real
  compatibility contracts with concrete checks.
- Existing broad fixture, WXS injection fixture, and tag-editing fixture checks
  still pass.
- Any required grammar fix has a focused corpus test.
- README documents the fixture layers without claiming semantic project
  intelligence.
- Manual Zed smoke evidence is recorded if the implementation changes fixtures
  or queries in a way users should inspect visually.
