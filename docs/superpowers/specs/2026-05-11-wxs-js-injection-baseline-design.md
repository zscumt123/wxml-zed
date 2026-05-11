# WXS JavaScript Injection Baseline Design

Date: 2026-05-11

## Goal

Make WXML's embedded JavaScript experience explicit and verifiable before any
language-server work starts.

This phase tightens the editor contract for:

- `{{ ... }}` interpolation expressions.
- Inline paired `<wxs module="..."> ... </wxs>` bodies.
- Recovery WXS bodies that still expose `raw_text`.

The goal is not to build a standalone WXS grammar. The goal is to make the
current JavaScript injection behavior reliable, scoped, documented, and covered
by automated checks.

## Current State

The extension already has `languages/wxml/injections.scm`:

```scheme
((raw_text) @injection.content
  (#set! injection.language "javascript")
  (#set! injection.include-children))

((expression) @injection.content
  (#set! injection.language "javascript")
  (#set! injection.include-children))
```

This is functional but broad:

- Every `raw_text` node is injected as JavaScript.
- Every interpolation `expression` is injected as JavaScript.
- The verification script only checks that the query compiles and runs; it does
  not assert concrete injection captures.
- There is no dedicated fixture proving inline WXS and interpolation injection
  continue to work after grammar changes.

After the semantic grammar baseline, `raw_text` is currently only produced for
WXS-like paired nodes. That makes the broad `raw_text` query acceptable today,
but the contract should still be documented and tested so later grammar changes
do not accidentally inject unrelated raw text.

## Scope

Included:

- Add a dedicated WXS/injection fixture.
- Add automated checks that assert concrete injection captures for inline WXS
  body JavaScript and interpolation JavaScript.
- Keep injection language as `javascript`.
- Keep injection behavior syntax-level only.
- Ensure recovery WXS raw text does not break query execution.
- Update README/docs only where needed to describe the verified scope.

Excluded:

- Standalone `tree-sitter-wxs`.
- JavaScript parsing inside the WXML grammar itself.
- Type checking, diagnostics, completion, go-to-definition, or module
  resolution.
- WeChat WXS API semantic modeling.
- Importing or bundling an additional JavaScript grammar.
- Marketplace packaging or publishing.

## Design

### Injection Model

Use Tree-sitter injection queries as the only mechanism for embedded JavaScript
in this phase.

`expression` captures continue to inject JavaScript for interpolation:

```wxml
<view>{{ user.name || fallback }}</view>
```

`raw_text` captures continue to inject JavaScript for paired WXS bodies:

```wxml
<wxs module="math">
  var double = function (x) { return x * 2; };
  module.exports.double = double;
</wxs>
```

The implementation should prefer a query shape that is explicit about WXS
parents if Zed and `tree-sitter-cli query` both accept it cleanly, for example:

```scheme
((wxs_inline (raw_text) @injection.content)
  (#set! injection.language "javascript"))
```

If explicit parent-scoped captures lose compatibility with Zed or the CLI, the
existing direct `raw_text` capture may stay, but the fixture and verification
must make the intended WXS-only contract clear.

### Verification Contract

The verification script should assert behavior, not only query validity.

It should produce a stable injection query output file and check for:

- At least one `raw_text` capture from an inline `wxs_inline` body.
- At least one `raw_text` capture from a recovered `wxs_fallback` body.
- At least one `expression` capture from a WXML interpolation.
- No query error from `injections.scm`.

The script may use `rg` against query output because Tree-sitter query output is
already the integration boundary being validated in this repository.

### Fixture Contract

Add a fixture focused on injection behavior. It should include:

- A normal interpolation expression outside WXS.
- An inline WXS module with representative WXS/JavaScript:
  - function assignment
  - `module.exports`
  - object literal assignment
- A second WXML interpolation that calls the WXS module.
- A small recovery WXS case that still produces `raw_text`, so the query path is
  tested against both `wxs_inline` and `wxs_fallback`.

The fixture should not duplicate the full broad `fixtures/test.wxml`; it should
be small and purpose-built.

### Documentation

README wording should stay conservative:

- WXS bodies are injected as JavaScript for highlighting.
- WXS is not type-checked.
- External WXS files are not resolved.
- Interpolation expressions are injected as JavaScript-like expressions for
  highlighting only.

## Error Handling

Malformed WXS should not make injection checks fail unless the grammar emits a
parse error for the fixture itself.

The grammar's existing `wxs_fallback` recovery is allowed to expose `raw_text`.
This phase should not try to distinguish valid WXS from recovered WXS in the
injection query unless doing so is necessary to avoid incorrect captures.

## Testing

Required automated checks:

- `scripts/verify-tree-sitter.sh`
- `tree-sitter-cli query` against `languages/wxml/injections.scm` and the new
  injection fixture.
- Concrete assertions over injection query output for `raw_text` and
  `expression`.
- Existing corpus tests still pass.

Manual Zed smoke:

- Rebuild the dev extension.
- Open a `.wxml` file with inline WXS.
- Confirm the language remains `WXML`.
- Confirm no WXML grammar or query errors appear in Zed logs.

Visual confirmation of token colors is useful but not sufficient as the only
evidence; automated query output is the source of truth for this phase.

## Acceptance Criteria

- A focused WXS injection fixture exists.
- `scripts/verify-tree-sitter.sh` fails if `injections.scm` stops capturing
  WXS `raw_text`.
- `scripts/verify-tree-sitter.sh` fails if interpolation `expression` injection
  stops being captured.
- Existing semantic grammar corpus remains green.
- Zed dev extension rebuilds with the updated files.
- README/docs accurately describe the feature as highlighting-only.
