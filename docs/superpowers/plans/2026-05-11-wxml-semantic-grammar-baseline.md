# WXML Semantic Grammar Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make core WXML declarations parse as semantic grammar nodes and update Zed queries to consume those nodes.

**Architecture:** Harden `grammar/tree-sitter-wxml` first, then update Zed query files in `languages/wxml`. Keep the vendored grammar, generated parser artifacts, and the local Zed grammar checkout in sync so automated Tree-sitter checks and manual Zed checks exercise the same grammar revision.

**Tech Stack:** Tree-sitter grammar DSL (`grammar.js`), generated Tree-sitter C artifacts, corpus tests, Zed query files (`.scm`), shell verification with `scripts/verify-tree-sitter.sh`.

---

## File Structure

- Modify `grammar/tree-sitter-wxml/grammar.js`: introduce semantic declaration nodes and narrow attribute helper nodes.
- Modify `grammar/tree-sitter-wxml/src/grammar.json`: regenerated parser grammar artifact.
- Modify `grammar/tree-sitter-wxml/src/node-types.json`: regenerated node type artifact.
- Modify `grammar/tree-sitter-wxml/src/parser.c`: regenerated parser artifact.
- Modify `grammar/tree-sitter-wxml/test/corpus/template_definition.txt`: expect `template_definition`.
- Modify `grammar/tree-sitter-wxml/test/corpus/template_usage.txt`: expect `template_usage`.
- Modify `grammar/tree-sitter-wxml/test/corpus/wxs_inline.txt`: expect `wxs_inline`.
- Modify `grammar/tree-sitter-wxml/test/corpus/wxs_external.txt`: expect `wxs_external`.
- Verify `grammar/tree-sitter-wxml/test/corpus/self_closing_tags.txt`: prove normal self-closing components remain generic after semantic tags move out of the generic rule.
- Create `grammar/tree-sitter-wxml/test/corpus/slot_element.txt`: paired and self-closing slot semantic coverage plus normal `slot` attribute non-coverage.
- Modify `languages/wxml/outline.scm`: consume semantic nodes instead of matching self-closing external WXS through generic `element`.
- Modify `languages/wxml/highlights.scm`: property captures target semantic start/self-closing tag nodes.
- Modify `languages/wxml/textobjects.scm`: update renamed template/WXS node patterns and add self-closing slot handling.
- Modify `extension.toml`: update `[grammars.wxml].rev` to the synced local grammar checkout commit.
- Modify `docs/local-grammar-loading.md`: record the new local grammar checkout revision used for manual Zed verification.

## Task 1: Add Failing Semantic Corpus Expectations

**Files:**
- Modify: `grammar/tree-sitter-wxml/test/corpus/template_definition.txt`
- Modify: `grammar/tree-sitter-wxml/test/corpus/template_usage.txt`
- Modify: `grammar/tree-sitter-wxml/test/corpus/wxs_inline.txt`
- Modify: `grammar/tree-sitter-wxml/test/corpus/wxs_external.txt`
- Create: `grammar/tree-sitter-wxml/test/corpus/slot_element.txt`

- [ ] **Step 1: Replace template definition expected tree**

Edit `grammar/tree-sitter-wxml/test/corpus/template_definition.txt` so the expected tree is:

```text
==================
Template definition
==================

<template name="userCard">
  <view class="card">
    <text>{{name}}</text>
    <text>{{age}}</text>
  </view>
</template>

---

(document
  (template_definition
    (template_definition_start_tag
      (tag_name)
      (template_name_attribute
        (attribute_name)
        (quoted_attribute_value)))
    (element
      (start_tag
        (tag_name)
        (attribute
          (attribute_name)
          (quoted_attribute_value)))
      (element
        (start_tag
          (tag_name))
        (interpolation
          (expression))
        (end_tag
          (tag_name)))
      (element
        (start_tag
          (tag_name))
        (interpolation
          (expression))
        (end_tag
          (tag_name)))
      (end_tag
        (tag_name)))
    (template_end_tag
      (tag_name))))
```

- [ ] **Step 2: Replace template usage expected tree**

Edit `grammar/tree-sitter-wxml/test/corpus/template_usage.txt` so the expected tree is:

```text
==================
Template usage
==================

<template is="userCard" data="{{...user}}" />
<template is="{{cond ? 'tplA' : 'tplB'}}" data="{{payload}}" />
<template is="layout" data="{{title: 'Main'}}">
  <text slot="header">Header</text>
  <text>Content</text>
</template>

---

(document
  (template_usage
    (template_usage_self_closing_tag
      (tag_name)
      (template_is_attribute
        (attribute_name)
        (quoted_attribute_value))
      (attribute
        (attribute_name)
        (quoted_attribute_value
          (interpolation
            (expression))))))
  (template_usage
    (template_usage_self_closing_tag
      (tag_name)
      (template_is_attribute
        (attribute_name)
        (quoted_attribute_value
          (interpolation
            (expression))))
      (attribute
        (attribute_name)
        (quoted_attribute_value
          (interpolation
            (expression))))))
  (template_usage
    (template_usage_start_tag
      (tag_name)
      (template_is_attribute
        (attribute_name)
        (quoted_attribute_value))
      (attribute
        (attribute_name)
        (quoted_attribute_value
          (interpolation
            (expression)))))
    (element
      (start_tag
        (tag_name)
        (attribute
          (attribute_name)
          (quoted_attribute_value)))
      (text)
      (end_tag
        (tag_name)))
    (element
      (start_tag
        (tag_name))
      (text)
      (end_tag
        (tag_name)))
    (template_end_tag
      (tag_name))))
```

- [ ] **Step 3: Replace WXS inline expected tree**

Edit `grammar/tree-sitter-wxml/test/corpus/wxs_inline.txt` so the WXS node is `wxs_inline`:

```text
==================
WXS inline module
==================

<view>2 * 7 = {{inline.double(7)}}</view>
<wxs module="inline">
  var double = function (x) { return x * 2; };
  module.exports.double = double;
</wxs>
<view>2 * 8 = {{inline.double(8)}}</view>

---

(document
  (element
    (start_tag
      (tag_name))
    (text)
    (interpolation
      (expression))
    (end_tag
      (tag_name)))
  (wxs_inline
    (wxs_inline_start_tag
      (tag_name)
      (wxs_module_attribute
        (attribute_name)
        (quoted_attribute_value)))
    (raw_text)
    (wxs_end_tag
      (tag_name)))
  (element
    (start_tag
      (tag_name))
    (text)
    (interpolation
      (expression))
    (end_tag
      (tag_name))))
```

- [ ] **Step 4: Replace WXS external expected tree**

Edit `grammar/tree-sitter-wxml/test/corpus/wxs_external.txt` so self-closing WXS parses as `wxs_external`:

```text
==================
WXS external module
==================

<wxs module="m" src="./demo.wxs" />
<wxs module="utils" src="../common/utils.wxs" />

---

(document
  (wxs_external
    (wxs_external_self_closing_tag
      (tag_name)
      (wxs_module_attribute
        (attribute_name)
        (quoted_attribute_value))
      (wxs_src_attribute
        (attribute_name)
        (quoted_attribute_value))))
  (wxs_external
    (wxs_external_self_closing_tag
      (tag_name)
      (wxs_module_attribute
        (attribute_name)
        (quoted_attribute_value))
      (wxs_src_attribute
        (attribute_name)
        (quoted_attribute_value)))))
```

- [ ] **Step 5: Create slot semantic corpus**

Create `grammar/tree-sitter-wxml/test/corpus/slot_element.txt`:

```text
==================
Slot elements and slot attributes
==================

<slot name="header"></slot>
<slot name="footer" />
<view>
  <text slot="footer">Footer content</text>
</view>

---

(document
  (slot_element
    (slot_start_tag
      (tag_name)
      (attribute
        (attribute_name)
        (quoted_attribute_value)))
    (slot_end_tag
      (tag_name)))
  (slot_element
    (slot_self_closing_tag
      (tag_name)
      (attribute
        (attribute_name)
        (quoted_attribute_value))))
  (element
    (start_tag
      (tag_name))
    (element
      (start_tag
        (tag_name)
        (attribute
          (attribute_name)
          (quoted_attribute_value)))
      (text)
      (end_tag
        (tag_name)))
    (end_tag
      (tag_name))))
```

- [ ] **Step 6: Run corpus tests and confirm they fail for semantic nodes**

Run from repository root:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli test --grammar-path grammar/tree-sitter-wxml
```

Expected: command fails. Failure output should show current nodes such as `template_element`, `wxs_element`, or generic `element/self_closing_tag` where the new corpus expects `template_definition`, `template_usage`, `wxs_inline`, `wxs_external`, or self-closing `slot_element`.

- [ ] **Step 7: Commit failing corpus expectations**

Run:

```bash
git add grammar/tree-sitter-wxml/test/corpus/template_definition.txt grammar/tree-sitter-wxml/test/corpus/template_usage.txt grammar/tree-sitter-wxml/test/corpus/wxs_inline.txt grammar/tree-sitter-wxml/test/corpus/wxs_external.txt grammar/tree-sitter-wxml/test/corpus/slot_element.txt
git commit -m "test: add semantic wxml grammar expectations"
```

Expected: commit succeeds with only corpus files staged.

## Task 2: Implement Semantic Grammar Nodes and Regenerate Artifacts

**Files:**
- Modify: `grammar/tree-sitter-wxml/grammar.js`
- Modify: `grammar/tree-sitter-wxml/src/grammar.json`
- Modify: `grammar/tree-sitter-wxml/src/node-types.json`
- Modify: `grammar/tree-sitter-wxml/src/parser.c`

- [ ] **Step 1: Update `_node` declaration order**

In `grammar/tree-sitter-wxml/grammar.js`, replace the declaration portion of `_node` so semantic nodes are tried before generic `element`:

```js
    _node: ($) =>
      choice(
        $.entity,
        $.text,
        $.interpolation,
        $.import_statement,
        $.include_statement,
        $.template_definition,
        $.template_usage,
        $.slot_element,
        $.block_element,
        $.wxs_inline,
        $.wxs_external,
        $.element,
      ),
```

- [ ] **Step 2: Restrict generic self-closing special tags**

In `grammar/tree-sitter-wxml/grammar.js`, replace `self_closing_tag` with the generic form below. This keeps normal self-closing components generic while reserving `template`, `slot`, and `wxs` for semantic rules:

```js
    self_closing_tag: ($) =>
      seq(
        "<",
        alias($._start_tag_name, $.tag_name),
        repeat($.attribute),
        "/>"
      ),
```

- [ ] **Step 3: Replace template rules**

Replace the existing `template_element`, `template_start_tag`, and `template_end_tag` rules with:

```js
    template_definition: ($) =>
      prec(3, seq(
        $.template_definition_start_tag,
        repeat($._node),
        $.template_end_tag,
      )),

    template_usage: ($) =>
      prec(3, choice(
        $.template_usage_self_closing_tag,
        seq(
          $.template_usage_start_tag,
          repeat($._node),
          $.template_end_tag,
        ),
      )),

    template_definition_start_tag: ($) =>
      seq(
        "<",
        alias(token("template"), $.tag_name),
        repeat($.attribute),
        $.template_name_attribute,
        repeat($.attribute),
        ">"
      ),

    template_usage_start_tag: ($) =>
      seq(
        "<",
        alias(token("template"), $.tag_name),
        repeat($.attribute),
        $.template_is_attribute,
        repeat($.attribute),
        ">"
      ),

    template_usage_self_closing_tag: ($) =>
      seq(
        "<",
        alias(token("template"), $.tag_name),
        repeat($.attribute),
        $.template_is_attribute,
        repeat($.attribute),
        "/>"
      ),

    template_name_attribute: ($) =>
      seq(
        alias(token("name"), $.attribute_name),
        optional(seq("=", choice($.attribute_value, $.quoted_attribute_value))),
      ),

    template_is_attribute: ($) =>
      seq(
        alias(token("is"), $.attribute_name),
        optional(seq("=", choice($.attribute_value, $.quoted_attribute_value))),
      ),

    template_end_tag: ($) => seq("</", alias(token("template"), $.tag_name), ">"),
```

- [ ] **Step 4: Replace slot rules**

Replace the existing `slot_element`, `slot_start_tag`, and `slot_end_tag` rules with:

```js
    slot_element: ($) =>
      prec(2, choice(
        seq(
          $.slot_start_tag,
          repeat($._node),
          $.slot_end_tag,
        ),
        $.slot_self_closing_tag,
      )),

    slot_start_tag: ($) =>
      seq("<", alias(token("slot"), $.tag_name), repeat($.attribute), ">"),

    slot_self_closing_tag: ($) =>
      seq("<", alias(token("slot"), $.tag_name), repeat($.attribute), "/>"),

    slot_end_tag: ($) => seq("</", alias(token("slot"), $.tag_name), ">"),
```

- [ ] **Step 5: Replace WXS rules**

Replace the existing `wxs_element`, `wxs_start_tag`, and `wxs_end_tag` rules with:

```js
    wxs_inline: ($) =>
      prec(3, seq(
        $.wxs_inline_start_tag,
        optional($.raw_text),
        $.wxs_end_tag,
      )),

    wxs_external: ($) =>
      prec(3, $.wxs_external_self_closing_tag),

    wxs_inline_start_tag: ($) =>
      seq(
        "<",
        alias(token("wxs"), $.tag_name),
        repeat($.attribute),
        $.wxs_module_attribute,
        repeat($.attribute),
        ">"
      ),

    wxs_external_self_closing_tag: ($) =>
      seq(
        "<",
        alias(token("wxs"), $.tag_name),
        repeat($.attribute),
        $.wxs_module_attribute,
        repeat($.attribute),
        $.wxs_src_attribute,
        repeat($.attribute),
        "/>"
      ),

    wxs_module_attribute: ($) =>
      seq(
        alias(token("module"), $.attribute_name),
        optional(seq("=", choice($.attribute_value, $.quoted_attribute_value))),
      ),

    wxs_src_attribute: ($) =>
      seq(
        alias(token("src"), $.attribute_name),
        optional(seq("=", choice($.attribute_value, $.quoted_attribute_value))),
      ),

    wxs_end_tag: ($) => seq("</", alias(token("wxs"), $.tag_name), ">"),
```

- [ ] **Step 6: Keep block rules unchanged**

Confirm `block_element`, `block_start_tag`, and `block_end_tag` still exist and still parse paired `<block>...</block>`:

```bash
rg -n "block_element|block_start_tag|block_end_tag" grammar/tree-sitter-wxml/grammar.js
```

Expected: all three rule names are present.

- [ ] **Step 7: Regenerate parser artifacts**

Run from `grammar/tree-sitter-wxml`:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli generate
```

Expected: command exits `0` and updates generated files under `grammar/tree-sitter-wxml/src/`.

- [ ] **Step 8: Run corpus tests and inspect failures**

Run from repository root:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli test --grammar-path grammar/tree-sitter-wxml
```

Expected: either all corpus tests pass, or failures are limited to exact tree-shape differences caused by the new node names. If failures show normal `image` or `input` self-closing tags no longer parse, fix `self_closing_tag` before proceeding.

- [ ] **Step 9: Verify representative parse node names**

Run:

```bash
NPM_CONFIG_CACHE=/private/tmp/npm-cache HOME=/private/tmp npx tree-sitter-cli parse --grammar-path grammar/tree-sitter-wxml fixtures/test.wxml
```

Expected: output contains `template_definition`, `template_usage`, `wxs_inline`, `wxs_external`, `import_statement`, `include_statement`, and `slot_element`.

- [ ] **Step 10: Commit grammar and generated artifacts**

Run:

```bash
git add grammar/tree-sitter-wxml/grammar.js grammar/tree-sitter-wxml/src/grammar.json grammar/tree-sitter-wxml/src/node-types.json grammar/tree-sitter-wxml/src/parser.c grammar/tree-sitter-wxml/test/corpus/template_definition.txt grammar/tree-sitter-wxml/test/corpus/template_usage.txt grammar/tree-sitter-wxml/test/corpus/wxs_inline.txt grammar/tree-sitter-wxml/test/corpus/wxs_external.txt grammar/tree-sitter-wxml/test/corpus/slot_element.txt
git commit -m "feat: add semantic wxml grammar nodes"
```

Expected: commit succeeds. The diff includes `grammar.js`, generated `src` artifacts, and corpus files.

## Task 3: Update Zed Queries for Semantic Nodes

**Files:**
- Modify: `languages/wxml/outline.scm`
- Modify: `languages/wxml/highlights.scm`
- Modify: `languages/wxml/textobjects.scm`

- [ ] **Step 1: Replace outline query**

Replace `languages/wxml/outline.scm` with:

```scheme
; Outline: declarative / navigable items only
; (template definitions, wxs modules, import/include file references)

; <template name="..."> ... </template>
((template_definition
  (template_definition_start_tag
    (template_name_attribute
      (attribute_name) @_n
      [(attribute_value) (quoted_attribute_value)] @name))) @item
 (#eq? @_n "name"))

; <wxs module="..."> ... </wxs>
((wxs_inline
  (wxs_inline_start_tag
    (wxs_module_attribute
      (attribute_name) @_n
      [(attribute_value) (quoted_attribute_value)] @name))) @item
 (#eq? @_n "module"))

; <wxs module="..." src="..." />
((wxs_external
  (wxs_external_self_closing_tag
    (wxs_module_attribute
      (attribute_name) @_n
      [(attribute_value) (quoted_attribute_value)] @name))) @item
 (#eq? @_n "module"))

; <import src="..." />
((import_statement
   (attribute
     (attribute_name) @_n
     [(attribute_value) (quoted_attribute_value)] @name)) @item
 (#eq? @_n "src"))

; <include src="..." />
((include_statement
   (attribute
     (attribute_name) @_n
     [(attribute_value) (quoted_attribute_value)] @name)) @item
 (#eq? @_n "src"))

(comment) @annotation
```

- [ ] **Step 2: Update highlight property captures**

In `languages/wxml/highlights.scm`, replace the declaration-specific property capture block with:

```scheme
; Special attribute names on declaration elements only
((template_definition_start_tag
  (template_name_attribute (attribute_name) @property))
  (#eq? @property "name"))

((template_usage_start_tag
  (template_is_attribute (attribute_name) @property))
  (#eq? @property "is"))

((template_usage_self_closing_tag
  (template_is_attribute (attribute_name) @property))
  (#eq? @property "is"))

((wxs_inline_start_tag
  (wxs_module_attribute (attribute_name) @property))
  (#eq? @property "module"))

((wxs_external_self_closing_tag
  (wxs_module_attribute (attribute_name) @property))
  (#eq? @property "module"))

((wxs_external_self_closing_tag
  (wxs_src_attribute (attribute_name) @property))
  (#eq? @property "src"))

((import_statement (attribute (attribute_name) @property)
  (#eq? @property "src")))

((include_statement (attribute (attribute_name) @property)
  (#eq? @property "src")))
```

Expected: no remaining property capture pattern targets `wxs_start_tag` or `template_start_tag`.

- [ ] **Step 3: Update text objects**

In `languages/wxml/textobjects.scm`, replace template and WXS object sections with:

```scheme
; Block / slot / template elements
(block_element
  (block_start_tag)
  (_)* @class.inside
  (block_end_tag)) @class.around

(slot_element
  (slot_start_tag)
  (_)* @class.inside
  (slot_end_tag)) @class.around

(slot_element
  (slot_self_closing_tag)) @class.around

(template_definition
  (template_definition_start_tag)
  (_)* @class.inside
  (template_end_tag)) @class.around

(template_usage
  (template_usage_start_tag)
  (_)* @class.inside
  (template_end_tag)) @class.around

(template_usage
  (template_usage_self_closing_tag)) @class.around

; <wxs> body — function-like (vaf/vif targets the JS body)
(wxs_inline
  (wxs_inline_start_tag)
  (raw_text)? @function.inside
  (wxs_end_tag)) @function.around

(wxs_external
  (wxs_external_self_closing_tag)) @function.around
```

Keep the existing comment and generic `element` sections unchanged.

- [ ] **Step 4: Run query verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: command exits `0` and prints `wxml-zed tree-sitter verification passed`.

- [ ] **Step 5: Inspect outline output**

Run:

```bash
rg -n 'template_definition|wxs_inline|wxs_external|capture: .*name|capture: .*item' /tmp/wxml-zed-outline-query.out
```

Expected: output includes `userCard`, `utils`, `inline`, `./item.wxml`, and `../common/header.wxml`. It should not require a generic external-WXS `element/self_closing_tag` match in `languages/wxml/outline.scm`.

- [ ] **Step 6: Commit query updates**

Run:

```bash
git add languages/wxml/outline.scm languages/wxml/highlights.scm languages/wxml/textobjects.scm
git commit -m "feat: consume semantic wxml nodes in zed queries"
```

Expected: commit succeeds with only query files staged.

## Task 4: Sync Local Zed Grammar Checkout and Manifest Rev

**Files:**
- Modify: `extension.toml`
- Modify: `docs/local-grammar-loading.md`
- External local checkout: `/private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511`

- [ ] **Step 1: Verify local grammar checkout exists**

Run:

```bash
test -d /private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511/.git
```

Expected: exit code `0`. If it fails, recreate the checkout from the current vendored grammar content before continuing.

- [ ] **Step 2: Sync vendored grammar to local checkout**

Run from repository root:

```bash
rsync -a --delete --exclude .git grammar/tree-sitter-wxml/ /private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511/
```

Expected: command exits `0`.

- [ ] **Step 3: Commit local checkout**

Run:

```bash
git -C /private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511 status --short
git -C /private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511 add .
git -C /private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511 commit -m "feat: add semantic wxml grammar nodes"
```

Expected: the first command shows grammar/parser/corpus changes, and the commit succeeds.

- [ ] **Step 4: Capture local grammar revision**

Run:

```bash
LOCAL_GRAMMAR_REV="$(git -C /private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511 rev-parse HEAD)"
printf '%s\n' "$LOCAL_GRAMMAR_REV"
```

Expected: output is a 40-character commit SHA. Save this SHA as `LOCAL_GRAMMAR_REV` for the next step.

- [ ] **Step 5: Update `extension.toml` grammar revision**

Run this command from repository root to replace the `rev = "..."` line in `extension.toml` with the exact SHA from Step 4:

```bash
LOCAL_GRAMMAR_REV="$(git -C /private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511 rev-parse HEAD)"
perl -0pi -e 's/rev = "[^"]+"/rev = "'$LOCAL_GRAMMAR_REV'"/' extension.toml
```

Expected: repository path remains unchanged and only `rev` changes in this section.

- [ ] **Step 6: Update local loading documentation**

Run this command from repository root to append the local checkout evidence to `docs/local-grammar-loading.md`:

```bash
LOCAL_GRAMMAR_REV="$(git -C /private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511 rev-parse HEAD)"
printf '\nSemantic grammar baseline smoke check:\n\n- Synced `grammar/tree-sitter-wxml/` into `/private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511`.\n- Committed the local grammar checkout at `%s`.\n- Updated `extension.toml` to pin `[grammars.wxml].rev` to that commit before rebuilding the dev extension.\n' "$LOCAL_GRAMMAR_REV" >> docs/local-grammar-loading.md
```

- [ ] **Step 7: Verify manifest points at the synced rev**

Run:

```bash
rg -n 'repository = "file:///private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511"|rev = "' extension.toml
```

Expected: output shows the local checkout repository and the new commit SHA.

- [ ] **Step 8: Commit manifest and docs**

Run:

```bash
git add extension.toml docs/local-grammar-loading.md
git commit -m "chore: pin zed grammar checkout for semantic baseline"
```

Expected: commit succeeds with only `extension.toml` and `docs/local-grammar-loading.md` staged.

## Task 5: Final Verification and Zed Smoke Check

**Files:**
- Modify: `docs/local-grammar-loading.md` only if manual smoke evidence needs an additional note.

- [ ] **Step 1: Run full automated verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: command exits `0` and prints `wxml-zed tree-sitter verification passed`.

- [ ] **Step 2: Confirm semantic nodes in fixture parse output**

Run:

```bash
rg -n "template_definition|template_usage|wxs_inline|wxs_external|slot_element|import_statement|include_statement" /tmp/wxml-zed-parse.out
```

Expected: all listed semantic node names appear at least once.

- [ ] **Step 3: Confirm outline no longer uses generic external WXS matching**

Run:

```bash
rg -n "self_closing_tag|#eq\\? @_tag \"wxs\"" languages/wxml/outline.scm
```

Expected: no output.

- [ ] **Step 4: Confirm parser artifacts are staged or committed**

Run:

```bash
git status --short grammar/tree-sitter-wxml/src/grammar.json grammar/tree-sitter-wxml/src/node-types.json grammar/tree-sitter-wxml/src/parser.c
```

Expected: no output after the Task 2 commit.

- [ ] **Step 5: Rebuild/reinstall the Zed dev extension**

In Zed:

```text
1. Open Extensions.
2. Search for WXML.
3. Click Rebuild on the WXML v0.2.0 dev extension, or run `zed: install dev extension` and select `/Users/zs/Desktop/study/wxml-zed`.
4. Open any `.wxml` file.
```

Expected: status bar language is `WXML`, highlighting renders, and Zed log shows `compiled grammar wxml` and `finished compiling extension` after the `extension.toml` rev update.

- [ ] **Step 6: Record manual smoke result**

Append the final Zed smoke result to `docs/local-grammar-loading.md`:

```bash
printf '\nFinal semantic grammar Zed smoke check:\n\n- Rebuilt or reinstalled the dev extension after pinning the semantic grammar checkout revision.\n- Confirmed a `.wxml` file opened with status bar language `WXML`.\n- Confirmed WXML highlighting rendered after the rebuild.\n- Confirmed the Zed log reported `compiled grammar wxml` and `finished compiling extension` after the manifest revision update.\n' >> docs/local-grammar-loading.md
```

Then commit the note:

```bash
git add docs/local-grammar-loading.md
git commit -m "docs: record semantic grammar zed smoke check"
```

Expected: commit succeeds with only `docs/local-grammar-loading.md` staged.

- [ ] **Step 7: Final branch status**

Run:

```bash
git status --short --branch --ignored grammars
```

Expected: clean tracked worktree. Ignored `grammars/` may appear as `!! grammars/`.
