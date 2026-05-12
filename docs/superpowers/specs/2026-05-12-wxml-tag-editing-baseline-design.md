# WXML Tag Editing Baseline Design

Date: 2026-05-12

## Goal

Make WXML tag editing behavior explicit, bounded, and verifiable before adding a
language server.

This phase improves the parts of editing that a Zed language extension can own
with stable files:

- bracket matching for WXML structures,
- autoclose configuration for punctuation and comments,
- snippets for common paired and self-closing WXML forms,
- automated checks that prove those files still parse and match real WXML nodes.

It does not promise semantic tag completion such as typing `<view>` and having
Zed infer and insert `</view>`. That belongs in a later language-server or HTML
language-service integration phase.

## Current State

`languages/wxml/config.toml` already defines a WXML language, file suffix,
comment delimiters, and basic autoclose pairs:

- `{}`, `[]`, and `()`,
- single and double quotes outside comments, text, and WXS raw text,
- `<` to `>`,
- `!--` to `--` for comments,
- `autoclose_before = ">})"`.

`languages/wxml/brackets.scm` already captures several structural pairs:

- generic `element` start and end tags,
- `block`, `slot`, `template`, and `wxs` paired forms,
- angle brackets and quote pairs.

`snippets/wxml.json` already contains useful paired snippets such as `view`,
`button`, `scroll-view`, `block`, `templatedef`, and `wxsinline`, plus
self-closing snippets such as `image`, `input`, `templateuse`, `wxsext`,
`import`, and `include`.

The gap is that this behavior is not a named editing contract. The verification
script only confirms query files execute against `fixtures/test.wxml`; it does
not assert that tag editing captures remain present. There is also no focused
fixture for bracket/comment/interpolation editing behavior.

## Scope

Included:

- Add a focused tag-editing fixture.
- Strengthen `brackets.scm` where the grammar exposes stable nodes or tokens.
- Preserve the existing autoclose configuration and document its limits.
- Add verification assertions for structural bracket captures and snippet JSON.
- Record manual Zed smoke evidence after reloading the dev extension.
- Update README wording only if it currently over- or under-claims the editing
  baseline.

Excluded:

- Semantic insertion of matching end tags from arbitrary typed start tags.
- Rename-paired-tag behavior.
- Selection wrapping commands.
- Emmet-style abbreviation expansion.
- HTML language server integration.
- A WXML language server.
- Formatting changes.
- Marketplace publishing.

## Design

### Editing Contract

This phase defines a conservative editing contract:

1. Zed can autoclose punctuation and comment delimiters according to
   `languages/wxml/config.toml`.
2. Zed can match and color structural tag pairs described by
   `languages/wxml/brackets.scm`.
3. Common paired tags are available through snippets instead of semantic tag
   generation.
4. WXS raw text remains protected from quote and angle-bracket autoclose rules.

The contract is intentionally syntax-level. It should keep working without a
project index, component registry, WeChat runtime knowledge, or LSP process.

### Bracket Query Model

`brackets.scm` should remain grammar-driven rather than string-search-driven.
Preferred captures:

```scheme
((element (start_tag) @open (end_tag) @close) (#set! newline.only))
((block_element (block_start_tag) @open (block_end_tag) @close) (#set! newline.only))
((slot_element (slot_start_tag) @open (slot_end_tag) @close) (#set! newline.only))
((template_definition (template_definition_start_tag) @open (template_end_tag) @close) (#set! newline.only))
((template_usage (template_usage_start_tag) @open (template_end_tag) @close) (#set! newline.only))
((template_fallback (template_fallback_start_tag) @open (template_end_tag) @close) (#set! newline.only))
((wxs_inline (wxs_inline_start_tag) @open (wxs_end_tag) @close) (#set! newline.only))
((wxs_fallback (wxs_fallback_start_tag) @open (wxs_end_tag) @close) (#set! newline.only))
```

The implementation may add explicit interpolation and comment bracket captures
only if `tree-sitter-cli query` and Zed accept them cleanly. If the external
tokens for `{{`, `}}`, `<!--`, or `-->` cannot be captured reliably, comments
should remain covered by `block_comment` in `config.toml`, and interpolation
should remain covered by `{}` autoclose plus parser/highlight behavior.

### Fixture Contract

Add `fixtures/tag-editing.wxml` as a focused integration fixture. It should be
small and include:

- a normal paired built-in component,
- nested paired tags,
- a self-closing component,
- a `block` pair,
- a `slot` pair and self-closing `slot`,
- a `template name` pair,
- a paired `template is` body,
- a paired `template` fallback body without `name` or `is`,
- an inline `wxs` pair,
- a recovered paired `wxs` body that parses as `wxs_fallback`,
- at least one interpolation in text,
- at least one interpolation in an attribute,
- a WXML comment.

This fixture is not a replacement for `fixtures/test.wxml`. It exists to make
editing behavior easy to query and assert.

### Verification Contract

`scripts/verify-tree-sitter.sh` should keep its existing broad checks and add a
focused brackets query against `fixtures/tag-editing.wxml`.

Required assertions:

- `brackets.scm` query succeeds against the focused fixture.
- Query output includes captures for generic element start/end tags.
- Query output includes captures for `block_element`.
- Query output includes captures for `slot_element`.
- Query output includes captures for paired `template_definition`.
- Query output includes captures for paired `template_usage`.
- Query output includes captures for paired `template_fallback`.
- Query output includes captures for `wxs_inline`.
- Query output includes captures for `wxs_fallback`.
- The focused fixture parses without grammar errors.
- Snippet JSON remains valid.
- Snippet assertions prove the required baseline snippets still exist with the
  expected prefixes.

The script should prefer concrete `rg` assertions over only checking exit code.
If implementation adds interpolation or comment bracket captures, it must also
add concrete assertions for them.

### Snippet Contract

Snippets remain the first-phase answer for common paired tag insertion. The
baseline should explicitly cover these categories:

- paired container: `view`,
- paired text content: `text`,
- paired interaction: `button`,
- conditional container: `wxif`,
- loop container: `wxfor`,
- logical wrapper: `block`,
- template definition: `templatedef`,
- inline WXS module: `wxsinline`,
- self-closing media/control/import forms: `image`, `input`, `templateuse`,
  `wxsext`, `import`, and `include`.

If a snippet is changed, `scripts/verify-tree-sitter.sh` must continue parsing
`snippets/wxml.json` as JSON. It must also assert that the baseline snippet
keys and prefixes still exist:

| Key | Prefix |
| --- | --- |
| `view` | `view` |
| `text` | `text` |
| `button` | `button` |
| `wx:if` | `wxif` |
| `wx:for` | `wxfor` |
| `block` | `block` |
| `template definition` | `templatedef` |
| `wxs inline` | `wxsinline` |
| `image` | `image` |
| `input` | `input` |
| `template use` | `templateuse` |
| `wxs external` | `wxsext` |
| `import` | `import` |
| `include` | `include` |

This phase does not need to add a custom generic wrap-selection snippet unless
Zed's native snippet behavior can be verified against selected text.

### Documentation

README should stay conservative. It may say WXML has basic tag editing support
through autoclose, bracket matching, comments, and snippets. It must not claim:

- automatic semantic end-tag insertion,
- paired tag rename,
- Emmet,
- selection wrapping,
- LSP-backed completion.

## Error Handling

Malformed tag structures should not make query files fail to load. The focused
fixture should use valid WXML so verification failures point to query/config
regressions, not intentional parser recovery.

If a planned bracket capture is not supported by Zed or `tree-sitter-cli`, the
implementation should remove that capture and keep the behavior documented as
out of scope instead of relying on an unverified query.

## Manual Smoke

After implementation:

1. Rebuild or reload the WXML dev extension in Zed.
2. Open a `.wxml` file with nested tags and interpolation.
3. Confirm the status bar language remains `WXML`.
4. Confirm there are no new WXML grammar or query errors in `Zed.log`.
5. Confirm common snippets still appear for WXML.

Visual confirmation is useful, but automated query output is the source of
truth for this phase.

## Acceptance Criteria

- A focused tag-editing fixture exists.
- `brackets.scm` remains valid and its important structural captures are
  asserted by `scripts/verify-tree-sitter.sh`.
- `config.toml` keeps the existing WXML autoclose and comment behavior unless a
  verified improvement replaces it.
- Snippet JSON remains valid, required snippet key/prefix pairs are asserted,
  and README accurately describes snippet-based tag insertion.
- The full `scripts/verify-tree-sitter.sh` check passes.
- Zed dev extension smoke shows WXML still loads without new grammar/query
  errors.
- The design explicitly defers semantic tag completion to a later LSP or HTML
  language-service phase.
