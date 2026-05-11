/**
 * @file WXML (WeiXin Markup Language) grammar for tree-sitter
 * @author BlockLune <39331194+BlockLune@users.noreply.github.com>
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: "wxml",

  extras: ($) => [$.comment, /\s+/],

  externals: ($) => [
    $._start_tag_name,
    $._end_tag_name,
    "/>",
    $.raw_text,
    $.comment,
    $._interpolation_start,
    $._interpolation_end,
  ],

  rules: {
    document: ($) => repeat($._node),

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

    element: ($) =>
      choice(
        seq($.start_tag, repeat($._node), $.end_tag),
        $.self_closing_tag,
      ),

    start_tag: ($) =>
      seq(
        "<",
        alias($._start_tag_name, $.tag_name),
        repeat($.attribute),
        ">"
      ),

    self_closing_tag: ($) =>
      seq(
        "<",
        alias($._start_tag_name, $.tag_name),
        repeat($.attribute),
        "/>"
      ),

    end_tag: ($) =>
      seq("</", alias(choice($._end_tag_name, token("wxs")), $.tag_name), ">"),

    attribute: ($) =>
      seq(
        $.attribute_name,
        optional(seq("=", choice($.attribute_value, $.quoted_attribute_value))),
      ),

    attribute_name: (_) => /[a-zA-Z_][a-zA-Z0-9\-_:.]*/,

    attribute_value: (_) => /[^<>"'=\s]+/,

    entity: (_) =>
      /&(#([xX][0-9a-fA-F]{1,6}|[0-9]{1,5})|[A-Za-z][A-Za-z0-9]{0,29});?/,

    quoted_attribute_value: ($) =>
      choice(
        seq("'", optional(repeat(choice(/[^'{{&]+/, $.interpolation, $.entity))), "'"),
        seq('"', optional(repeat(choice(/[^"{{&]+/, $.interpolation, $.entity))), '"'),
      ),

    text: (_) => /[^<>&{}\s]([^<>&{}]*[^<>&{}\s])?/,

    interpolation: ($) =>
      seq(
        $._interpolation_start,
        optional(alias($._interpolation_text, $.expression)),
        $._interpolation_end,
      ),

    _interpolation_text: ($) =>
      repeat1(choice(
        token.immediate(prec(1, /[^{}]+/)),
        $.interpolation,
        $._js_brace_expression
      )),

    _js_brace_expression: ($) =>
      seq(
        token.immediate('{'),
        optional($._interpolation_text),
        token.immediate('}')
      ),

    import_statement: ($) =>
      prec(2, seq("<", alias(token("import"), $.tag_name), repeat($.attribute), "/>")),

    include_statement: ($) =>
      prec(2, seq("<", alias(token("include"), $.tag_name), repeat($.attribute), "/>")),

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

    block_element: ($) =>
      prec(2, seq(
        $.block_start_tag,
        repeat($._node),
        $.block_end_tag,
      )),

    wxs_inline: ($) =>
      prec(3, seq(
        $.wxs_inline_start_tag,
        optional($.raw_text),
        $.wxs_end_tag,
      )),

    wxs_external: ($) =>
      prec(3, $.wxs_external_self_closing_tag),

    block_start_tag: ($) =>
      seq("<", alias(token("block"), $.tag_name), repeat($.attribute), ">"),

    block_end_tag: ($) => seq("</", alias(token("block"), $.tag_name), ">"),

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
      choice(
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
        seq(
          "<",
          alias(token("wxs"), $.tag_name),
          repeat($.attribute),
          $.wxs_src_attribute,
          repeat($.attribute),
          $.wxs_module_attribute,
          repeat($.attribute),
          "/>"
        )
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
  },
});
