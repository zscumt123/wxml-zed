#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRAMMAR_DIR="$ROOT_DIR/grammar/tree-sitter-wxml"
FIXTURE="$ROOT_DIR/fixtures/test.wxml"
INJECTION_FIXTURE="$ROOT_DIR/fixtures/wxs-injection.wxml"
TAG_EDITING_FIXTURE="$ROOT_DIR/fixtures/tag-editing.wxml"
BRACKETS_QUERY="$ROOT_DIR/languages/wxml/brackets.scm"
CACHE_DIR="${NPM_CONFIG_CACHE:-/private/tmp/npm-cache}"

export HOME="${WXML_ZED_HOME:-/private/tmp}"
export npm_config_cache="$CACHE_DIR"

npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$FIXTURE" >/tmp/wxml-zed-parse.out
npx tree-sitter-cli test --grammar-path "$GRAMMAR_DIR" >/tmp/wxml-zed-corpus-test.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/highlights.scm" "$FIXTURE" >/tmp/wxml-zed-highlights-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/outline.scm" "$FIXTURE" >/tmp/wxml-zed-outline-query.out

if [ -f "$ROOT_DIR/languages/wxml/textobjects.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/textobjects.scm" "$FIXTURE" >/tmp/wxml-zed-textobjects-query.out
fi
if [ -f "$ROOT_DIR/languages/wxml/injections.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/injections.scm" "$FIXTURE" >/tmp/wxml-zed-injections-query.out
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/injections.scm" "$INJECTION_FIXTURE" >/tmp/wxml-zed-wxs-injections-query.out
  npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$INJECTION_FIXTURE" >/tmp/wxml-zed-wxs-injection-parse.out

  test "$(rg -c 'capture: .*injection\.content' /tmp/wxml-zed-wxs-injections-query.out)" -ge 4
  rg -n 'text: ` user\.name \|\| "Guest" `' /tmp/wxml-zed-wxs-injections-query.out >/dev/null
  rg -n 'text: ` math\.double\(count\) `' /tmp/wxml-zed-wxs-injections-query.out >/dev/null
  rg -n 'capture: injection\.content, start: \(3, 2\), end: \(7, 0\)' /tmp/wxml-zed-wxs-injections-query.out >/dev/null
  rg -n 'capture: injection\.content, start: \(12, 2\), end: \(13, 0\)' /tmp/wxml-zed-wxs-injections-query.out >/dev/null
  rg -n '\(wxs_inline' /tmp/wxml-zed-wxs-injection-parse.out >/dev/null
  rg -n '\(wxs_fallback' /tmp/wxml-zed-wxs-injection-parse.out >/dev/null
  test "$(rg -c '\(raw_text' /tmp/wxml-zed-wxs-injection-parse.out)" -ge 2
  test "$(rg -c '\(expression' /tmp/wxml-zed-wxs-injection-parse.out)" -ge 2
fi
if [ -f "$ROOT_DIR/languages/wxml/indents.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/indents.scm" "$FIXTURE" >/tmp/wxml-zed-indents-query.out
fi
if [ ! -f "$BRACKETS_QUERY" ]; then
  echo "Missing required WXML bracket query: $BRACKETS_QUERY" >&2
  exit 1
fi
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$BRACKETS_QUERY" "$FIXTURE" >/tmp/wxml-zed-brackets-query.out
npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$TAG_EDITING_FIXTURE" >/tmp/wxml-zed-tag-editing-parse.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$BRACKETS_QUERY" "$TAG_EDITING_FIXTURE" >/tmp/wxml-zed-tag-editing-brackets-query.out

rg -n '\(element' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
rg -n '\(block_element' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
rg -n '\(slot_element' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
rg -n '\(template_definition' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
rg -n '\(template_usage' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
rg -n '\(template_fallback' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
rg -n '\(wxs_inline' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
rg -n '\(wxs_fallback' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
rg -n '\(comment' /tmp/wxml-zed-tag-editing-parse.out >/dev/null
test "$(rg -c '\(interpolation' /tmp/wxml-zed-tag-editing-parse.out)" -ge 4

rg -n 'text: `<view class="card \{\{state\}\}">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<block wx:if="\{\{visible\}\}">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<slot name="header">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<template name="itemCard">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<template is="itemCard" data="\{\{item\}\}">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<template>`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<wxs module="tools">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<wxs src="./legacy\.wxs">`' /tmp/wxml-zed-tag-editing-brackets-query.out >/dev/null
test "$(rg -c 'capture: [0-9]+ - open' /tmp/wxml-zed-tag-editing-brackets-query.out)" -ge 12
test "$(rg -c 'capture: [0-9]+ - close' /tmp/wxml-zed-tag-editing-brackets-query.out)" -ge 12

node -e '
const fs = require("fs");
const snippets = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const required = {
  "view": "view",
  "text": "text",
  "button": "button",
  "wx:if": "wxif",
  "wx:for": "wxfor",
  "block": "block",
  "template definition": "templatedef",
  "wxs inline": "wxsinline",
  "image": "image",
  "input": "input",
  "template use": "templateuse",
  "wxs external": "wxsext",
  "import": "import",
  "include": "include",
};
for (const [key, prefix] of Object.entries(required)) {
  const snippet = snippets[key];
  if (!snippet) {
    throw new Error(`Missing WXML snippet: ${key}`);
  }
  if (snippet.prefix !== prefix) {
    throw new Error(`WXML snippet ${key} prefix ${snippet.prefix} !== ${prefix}`);
  }
}
' "$ROOT_DIR/snippets/wxml.json"

echo "wxml-zed tree-sitter verification passed"
