#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRAMMAR_DIR="$ROOT_DIR/grammar/tree-sitter-wxml"
FIXTURE="$ROOT_DIR/fixtures/test.wxml"
INJECTION_FIXTURE="$ROOT_DIR/fixtures/wxs-injection.wxml"
TAG_EDITING_FIXTURE="$ROOT_DIR/fixtures/tag-editing.wxml"
BRACKETS_QUERY="$ROOT_DIR/languages/wxml/brackets.scm"
REAL_WORLD_DIR="$ROOT_DIR/fixtures/real-world"
REAL_WORLD_PAGE="$REAL_WORLD_DIR/page.wxml"
REAL_WORLD_COMPONENT="$REAL_WORLD_DIR/component.wxml"
REAL_WORLD_TEMPLATES="$REAL_WORLD_DIR/templates.wxml"
REAL_WORLD_RECOVERY="$REAL_WORLD_DIR/edge-recovery.wxml"
# Session-stable workspace under TMPDIR (macOS per-user, persistent across
# /tmp wipes). Previously these were hardcoded to /private/tmp/* and broke
# whenever the OS cleaned that directory between runs. Env-var overrides
# WXML_ZED_HOME, WXML_ZED_OUT_DIR, NPM_CONFIG_CACHE still take precedence.
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
OUT_DIR="${WXML_ZED_OUT_DIR:-$TMP_BASE/wxml-zed-verify}"
CACHE_DIR="${NPM_CONFIG_CACHE:-$TMP_BASE/wxml-zed-npm-cache}"
SYMBOL_MODEL="$OUT_DIR/symbols.json"
PROJECT_GRAPH="$OUT_DIR/project-graph.json"
MINIPROGRAM_DIR="$ROOT_DIR/fixtures/miniprogram"

export HOME="${WXML_ZED_HOME:-$TMP_BASE/wxml-zed-home}"
export npm_config_cache="$CACHE_DIR"
mkdir -p "$HOME/.cache/tree-sitter/lock" "$npm_config_cache" "$OUT_DIR"

node "$ROOT_DIR/scripts/verify-wxml-builtins.mjs"

count_matches() {
  rg -c "$1" "$2" || true
}

assert_count_ge() {
  local count
  count="$(count_matches "$1" "$2")"
  test "${count:-0}" -ge "$3"
}

assert_count_eq() {
  local count
  count="$(count_matches "$1" "$2")"
  test "${count:-0}" -eq "$3"
}

npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$FIXTURE" >$OUT_DIR/parse.out
npx tree-sitter-cli test --grammar-path "$GRAMMAR_DIR" >$OUT_DIR/corpus-test.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/highlights.scm" "$FIXTURE" >$OUT_DIR/highlights-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/outline.scm" "$FIXTURE" >$OUT_DIR/outline-query.out

if [ -f "$ROOT_DIR/languages/wxml/textobjects.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/textobjects.scm" "$FIXTURE" >$OUT_DIR/textobjects-query.out
fi
if [ -f "$ROOT_DIR/languages/wxml/injections.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/injections.scm" "$FIXTURE" >$OUT_DIR/injections-query.out
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/injections.scm" "$INJECTION_FIXTURE" >$OUT_DIR/wxs-injections-query.out
  npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$INJECTION_FIXTURE" >$OUT_DIR/wxs-injection-parse.out

  test "$(rg -c 'capture: .*injection\.content' $OUT_DIR/wxs-injections-query.out)" -ge 4
  rg -n 'text: ` user\.name \|\| "Guest" `' $OUT_DIR/wxs-injections-query.out >/dev/null
  rg -n 'text: ` math\.double\(count\) `' $OUT_DIR/wxs-injections-query.out >/dev/null
  rg -n 'capture: injection\.content, start: \(3, 2\), end: \(7, 0\)' $OUT_DIR/wxs-injections-query.out >/dev/null
  rg -n 'capture: injection\.content, start: \(12, 2\), end: \(13, 0\)' $OUT_DIR/wxs-injections-query.out >/dev/null
  rg -n '\(wxs_inline' $OUT_DIR/wxs-injection-parse.out >/dev/null
  rg -n '\(wxs_fallback' $OUT_DIR/wxs-injection-parse.out >/dev/null
  test "$(rg -c '\(raw_text' $OUT_DIR/wxs-injection-parse.out)" -ge 2
  test "$(rg -c '\(expression' $OUT_DIR/wxs-injection-parse.out)" -ge 2
fi
if [ -f "$ROOT_DIR/languages/wxml/indents.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/indents.scm" "$FIXTURE" >$OUT_DIR/indents-query.out
fi
if [ ! -f "$BRACKETS_QUERY" ]; then
  echo "Missing required WXML bracket query: $BRACKETS_QUERY" >&2
  exit 1
fi
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$BRACKETS_QUERY" "$FIXTURE" >$OUT_DIR/brackets-query.out
npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$TAG_EDITING_FIXTURE" >$OUT_DIR/tag-editing-parse.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$BRACKETS_QUERY" "$TAG_EDITING_FIXTURE" >$OUT_DIR/tag-editing-brackets-query.out

rg -n '\(element' $OUT_DIR/tag-editing-parse.out >/dev/null
rg -n '\(block_element' $OUT_DIR/tag-editing-parse.out >/dev/null
rg -n '\(slot_element' $OUT_DIR/tag-editing-parse.out >/dev/null
rg -n '\(template_definition' $OUT_DIR/tag-editing-parse.out >/dev/null
rg -n '\(template_usage' $OUT_DIR/tag-editing-parse.out >/dev/null
rg -n '\(template_fallback' $OUT_DIR/tag-editing-parse.out >/dev/null
rg -n '\(wxs_inline' $OUT_DIR/tag-editing-parse.out >/dev/null
rg -n '\(wxs_fallback' $OUT_DIR/tag-editing-parse.out >/dev/null
rg -n '\(comment' $OUT_DIR/tag-editing-parse.out >/dev/null
test "$(rg -c '\(interpolation' $OUT_DIR/tag-editing-parse.out)" -ge 4

rg -n 'text: `<view class="card \{\{state\}\}">`' $OUT_DIR/tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<block wx:if="\{\{visible\}\}">`' $OUT_DIR/tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<slot name="header">`' $OUT_DIR/tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<template name="itemCard">`' $OUT_DIR/tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<template is="itemCard" data="\{\{item\}\}">`' $OUT_DIR/tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<template>`' $OUT_DIR/tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<wxs module="tools">`' $OUT_DIR/tag-editing-brackets-query.out >/dev/null
rg -n 'text: `<wxs src="./legacy\.wxs">`' $OUT_DIR/tag-editing-brackets-query.out >/dev/null
test "$(rg -c 'capture: [0-9]+ - open' $OUT_DIR/tag-editing-brackets-query.out)" -ge 12
test "$(rg -c 'capture: [0-9]+ - close' $OUT_DIR/tag-editing-brackets-query.out)" -ge 12

for real_world_fixture in "$REAL_WORLD_PAGE" "$REAL_WORLD_COMPONENT" "$REAL_WORLD_TEMPLATES"; do
  npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$real_world_fixture" >$OUT_DIR/real-world-$(basename "$real_world_fixture" .wxml)-parse.out
done
npx tree-sitter-cli parse --grammar-path "$GRAMMAR_DIR" "$REAL_WORLD_RECOVERY" >$OUT_DIR/real-world-recovery-parse.out || true

npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/highlights.scm" "$REAL_WORLD_PAGE" >$OUT_DIR/real-world-page-highlights-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/outline.scm" "$REAL_WORLD_PAGE" >$OUT_DIR/real-world-page-outline-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/outline.scm" "$REAL_WORLD_COMPONENT" >$OUT_DIR/real-world-component-outline-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/outline.scm" "$REAL_WORLD_TEMPLATES" >$OUT_DIR/real-world-templates-outline-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/injections.scm" "$REAL_WORLD_PAGE" >$OUT_DIR/real-world-page-injections-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/injections.scm" "$REAL_WORLD_RECOVERY" >$OUT_DIR/real-world-recovery-injections-query.out
npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$BRACKETS_QUERY" "$REAL_WORLD_COMPONENT" >$OUT_DIR/real-world-component-brackets-query.out
if [ -f "$ROOT_DIR/languages/wxml/indents.scm" ]; then
  npx tree-sitter-cli query --grammar-path "$GRAMMAR_DIR" "$ROOT_DIR/languages/wxml/indents.scm" "$REAL_WORLD_PAGE" >$OUT_DIR/real-world-page-indents-query.out
fi

rg -n '\(import_statement' $OUT_DIR/real-world-page-parse.out >/dev/null
rg -n '\(include_statement' $OUT_DIR/real-world-page-parse.out >/dev/null
rg -n '\(wxs_external' $OUT_DIR/real-world-page-parse.out >/dev/null
rg -n '\(block_element' $OUT_DIR/real-world-page-parse.out >/dev/null
rg -n '\(template_usage' $OUT_DIR/real-world-page-parse.out >/dev/null
rg -n '\(entity' $OUT_DIR/real-world-page-parse.out >/dev/null
assert_count_ge '\(interpolation' $OUT_DIR/real-world-page-parse.out 10
assert_count_ge '\(element' $OUT_DIR/real-world-page-parse.out 8
assert_count_eq '\(ERROR' $OUT_DIR/real-world-page-parse.out 0

rg -n '\(slot_element' $OUT_DIR/real-world-component-parse.out >/dev/null
rg -n '\(block_element' $OUT_DIR/real-world-component-parse.out >/dev/null
assert_count_ge '\(element' $OUT_DIR/real-world-component-parse.out 8
assert_count_ge '\(interpolation' $OUT_DIR/real-world-component-parse.out 8
assert_count_eq '\(ERROR' $OUT_DIR/real-world-component-parse.out 0

assert_count_ge '\(template_definition' $OUT_DIR/real-world-templates-parse.out 3
rg -n '\(template_usage' $OUT_DIR/real-world-templates-parse.out >/dev/null
rg -n '\(template_fallback' $OUT_DIR/real-world-templates-parse.out >/dev/null
assert_count_eq '\(ERROR' $OUT_DIR/real-world-templates-parse.out 0

rg -n '\(wxs_fallback' $OUT_DIR/real-world-recovery-parse.out >/dev/null
rg -n '\(raw_text' $OUT_DIR/real-world-recovery-parse.out >/dev/null
rg -n '\(interpolation' $OUT_DIR/real-world-recovery-parse.out >/dev/null
assert_count_ge '\(ERROR' $OUT_DIR/real-world-recovery-parse.out 1

rg -n 'text: `scroll-view`' $OUT_DIR/real-world-page-highlights-query.out >/dev/null
rg -n 'text: `user-card`' $OUT_DIR/real-world-page-highlights-query.out >/dev/null
rg -n 'text: `wx:for`' $OUT_DIR/real-world-page-highlights-query.out >/dev/null
rg -n 'text: `capture-bind:touchstart`' $OUT_DIR/real-world-page-highlights-query.out >/dev/null
rg -n 'text: `mut-bind:expanded`' $OUT_DIR/real-world-page-highlights-query.out >/dev/null
rg -n 'text: `generic:Badge`' $OUT_DIR/real-world-page-highlights-query.out >/dev/null
rg -n 'text: `&amp;`' $OUT_DIR/real-world-page-highlights-query.out >/dev/null

rg -n 'text: `"./templates.wxml"`' $OUT_DIR/real-world-page-outline-query.out >/dev/null
rg -n 'text: `"./shared/header.wxml"`' $OUT_DIR/real-world-page-outline-query.out >/dev/null
rg -n 'text: `"format"`' $OUT_DIR/real-world-page-outline-query.out >/dev/null
rg -n 'text: `"loadingRow"`' $OUT_DIR/real-world-templates-outline-query.out >/dev/null
rg -n 'text: `"compactFooter"`' $OUT_DIR/real-world-templates-outline-query.out >/dev/null
rg -n 'text: `"fullFooter"`' $OUT_DIR/real-world-templates-outline-query.out >/dev/null
if rg -n 'capture: [0-9]+ - item.*text: `<template is=' $OUT_DIR/real-world-page-outline-query.out >/dev/null; then
  echo "Template usage leaked into page outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `"loadingRow"`' $OUT_DIR/real-world-page-outline-query.out >/dev/null; then
  echo "Template usage name leaked into page outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `<user-card' $OUT_DIR/real-world-page-outline-query.out >/dev/null; then
  echo "Component usage leaked into page outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `user-card`' $OUT_DIR/real-world-page-outline-query.out >/dev/null; then
  echo "Component usage name leaked into page outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `<block' $OUT_DIR/real-world-component-outline-query.out >/dev/null; then
  echo "Block element leaked into component outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `<slot' $OUT_DIR/real-world-component-outline-query.out >/dev/null; then
  echo "Slot element leaked into component outline items" >&2
  exit 1
fi
if rg -n 'capture: [0-9]+ - item.*text: `"header"`' $OUT_DIR/real-world-component-outline-query.out >/dev/null; then
  echo "Slot name leaked into component outline items" >&2
  exit 1
fi

rg -n 'text: `theme`' $OUT_DIR/real-world-page-injections-query.out >/dev/null
rg -n 'text: `loading \? .is-loading. : ..`' $OUT_DIR/real-world-page-injections-query.out >/dev/null
rg -n 'text: `format\.price\(user\.price\)`' $OUT_DIR/real-world-page-injections-query.out >/dev/null
rg -n 'text: `useCompact \? .compactFooter. : .fullFooter.`' $OUT_DIR/real-world-page-injections-query.out >/dev/null
rg -n 'capture: injection\.content' $OUT_DIR/real-world-recovery-injections-query.out >/dev/null
assert_count_ge 'capture: injection\.content' $OUT_DIR/real-world-recovery-injections-query.out 1

rg -n 'text: `<view class="profile-card \{\{state\}\}" data-component-id="\{\{id\}\}">`' $OUT_DIR/real-world-component-brackets-query.out >/dev/null
rg -n 'text: `<slot name="header">`' $OUT_DIR/real-world-component-brackets-query.out >/dev/null
rg -n 'text: `<block wx:if="\{\{loading\}\}">`' $OUT_DIR/real-world-component-brackets-query.out >/dev/null
assert_count_ge 'capture: [0-9]+ - open' $OUT_DIR/real-world-component-brackets-query.out 8
assert_count_ge 'capture: [0-9]+ - close' $OUT_DIR/real-world-component-brackets-query.out 8

node "$ROOT_DIR/scripts/extract-wxml-symbols.mjs" "$REAL_WORLD_PAGE" "$REAL_WORLD_COMPONENT" "$REAL_WORLD_TEMPLATES" >"$SYMBOL_MODEL"
node -e '
const fs = require("fs");
const model = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function file(relativePath) {
  const found = model.files.find((entry) => entry.path === relativePath);
  assert(found, `Missing model file: ${relativePath}`);
  return found;
}

function hasDependency(fileModel, kind, value, normalized, moduleName) {
  return fileModel.dependencies.some((dependency) => (
    dependency.kind === kind &&
    dependency.value === value &&
    dependency.normalized === normalized &&
    (moduleName === undefined || dependency.module === moduleName)
  ));
}

function hasSymbol(fileModel, kind, name) {
  return fileModel.symbols.some((symbol) => symbol.kind === kind && symbol.name === name);
}

function hasStaticReference(fileModel, name) {
  return fileModel.references.some((reference) => !reference.dynamic && reference.name === name);
}

function hasDynamicReference(fileModel, text) {
  return fileModel.references.some((reference) => reference.dynamic && reference.raw.includes(text));
}

assert(model.version === 1, "Unexpected WXML symbol model version");

const page = file("fixtures/real-world/page.wxml");
const component = file("fixtures/real-world/component.wxml");
const templates = file("fixtures/real-world/templates.wxml");

assert(hasDependency(page, "import", "./templates.wxml", "fixtures/real-world/templates.wxml"), "Missing page import dependency");
assert(hasDependency(page, "include", "./shared/header.wxml", "fixtures/real-world/shared/header.wxml"), "Missing page include dependency");
assert(hasDependency(page, "wxs", "./utils/format.wxs", "fixtures/real-world/utils/format.wxs", "format"), "Missing page wxs dependency");
assert(hasSymbol(page, "wxs", "format"), "Missing external wxs module symbol");

for (const name of ["loadingRow", "compactFooter", "fullFooter"]) {
  assert(hasSymbol(templates, "template", name), `Missing template symbol: ${name}`);
}

assert(hasStaticReference(page, "loadingRow"), "Missing static template reference");
assert(hasDynamicReference(page, "useCompact ?"), "Missing dynamic template reference");
assert(hasStaticReference(templates, "compactFooter"), "Missing nested static template reference");
assert(hasDynamicReference(templates, "expanded ?"), "Missing nested dynamic template reference");

const componentCandidates = new Set([...page.components, ...component.components, ...templates.components].map((entry) => entry.tag));
for (const tag of ["user-card", "price-row", "empty-state", "loading-spinner", "status-badge"]) {
  assert(componentCandidates.has(tag), `Missing component candidate: ${tag}`);
}
for (const tag of ["view", "text", "button", "image", "scroll-view", "input"]) {
  assert(!componentCandidates.has(tag), `Builtin tag leaked into component candidates: ${tag}`);
}
' "$SYMBOL_MODEL"

node "$ROOT_DIR/scripts/extract-wxml-project-graph.mjs" "$MINIPROGRAM_DIR" >"$PROJECT_GRAPH"
node -e '
const fs = require("fs");
const graph = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hasPage(name) {
  return graph.pages.some((page) => page.name === name);
}

function hasConfig(path, kind) {
  return graph.configs.some((config) => config.path === path && config.kind === kind);
}

function hasResolvedComponent(owner, tag, target) {
  return graph.usingComponents.some((component) => (
    component.owner === owner &&
    component.tag === tag &&
    component.target === target &&
    component.resolved === true
  ));
}

function matchingComponents(owner, tag) {
  return graph.usingComponents.filter((component) => (
    component.owner === owner &&
    component.tag === tag
  ));
}

function pageCount(name) {
  return graph.pages.filter((page) => page.name === name).length;
}

function assertSingleResolvedComponent(owner, tag, value, target) {
  const matches = matchingComponents(owner, tag);
  assert(matches.length === 1, `Expected one ${tag} component for ${owner}, got ${matches.length}: ${JSON.stringify(matches)}`);
  const [component] = matches;
  assert(component.value === value, `${owner} ${tag} value mismatch: ${component.value}`);
  assert(component.target === target, `${owner} ${tag} target mismatch: ${component.target}`);
  assert(component.resolved === true, `${owner} ${tag} should be resolved: ${JSON.stringify(component)}`);
}

function hasUnresolvedComponent(owner, tag, reason) {
  return graph.unresolved.some((entry) => (
    entry.kind === "component" &&
    entry.owner === owner &&
    entry.tag === tag &&
    entry.reason === reason
  ));
}

function wxml(path) {
  const entry = graph.wxml.find((file) => file.path === path);
  assert(entry, `Missing WXML graph entry: ${path}`);
  return entry;
}

function hasDependency(file, kind, normalized) {
  return file.dependencies.some((dependency) => dependency.kind === kind && dependency.normalized === normalized);
}

assert(graph.version === 1, "Unexpected project graph version");
assert(graph.root === "fixtures/miniprogram", "Unexpected project graph root");
assert(hasPage("pages/home/home"), "Missing home page");
assert(hasPage("pages/detail/detail"), "Missing detail page");
assert(hasPage("packages/shop/pages/list/list"), "Missing shop list subpackage page");
assert(pageCount("packages/shop/pages/list/list") === 1, "Shop list subpackage page should be de-duplicated");

assert(hasConfig("fixtures/miniprogram/app.json", "app"), "Missing app config");
assert(hasConfig("fixtures/miniprogram/pages/home/home.json", "page"), "Missing home page config");
assert(hasConfig("fixtures/miniprogram/pages/detail/detail.json", "page"), "Missing detail page config");
assert(hasConfig("fixtures/miniprogram/components/user-card/user-card.json", "component"), "Missing user-card config");
assert(hasConfig("fixtures/miniprogram/components/status-badge/status-badge.json", "component"), "Missing status-badge config");
assert(hasConfig("fixtures/miniprogram/packages/shop/pages/list/list.json", "page"), "Missing shop list page config");
assert(hasConfig("fixtures/miniprogram/components/global-badge/global-badge.json", "component"), "Missing global-badge config");
assert(hasConfig("fixtures/miniprogram/components/local-badge/local-badge.json", "component"), "Missing local-badge config");

assert(hasResolvedComponent(
  "fixtures/miniprogram/pages/home/home.wxml",
  "user-card",
  "fixtures/miniprogram/components/user-card/user-card.wxml",
), "Missing resolved user-card component");
assert(hasResolvedComponent(
  "fixtures/miniprogram/components/user-card/user-card.wxml",
  "status-badge",
  "fixtures/miniprogram/components/status-badge/status-badge.wxml",
), "Missing resolved status-badge component");
assert(hasUnresolvedComponent(
  "fixtures/miniprogram/pages/home/home.wxml",
  "missing-card",
  "missing-file",
), "Missing unresolved missing-card component");
assertSingleResolvedComponent(
  "fixtures/miniprogram/packages/shop/pages/list/list.wxml",
  "global-badge",
  "/components/global-badge/global-badge",
  "fixtures/miniprogram/components/global-badge/global-badge.wxml",
);
assertSingleResolvedComponent(
  "fixtures/miniprogram/packages/shop/pages/list/list.wxml",
  "relative-badge",
  "./components/global-badge/global-badge",
  "fixtures/miniprogram/components/global-badge/global-badge.wxml",
);
assertSingleResolvedComponent(
  "fixtures/miniprogram/pages/home/home.wxml",
  "global-badge",
  "../../components/local-badge/local-badge",
  "fixtures/miniprogram/components/local-badge/local-badge.wxml",
);

const home = wxml("fixtures/miniprogram/pages/home/home.wxml");
const detail = wxml("fixtures/miniprogram/pages/detail/detail.wxml");
wxml("fixtures/miniprogram/components/user-card/user-card.wxml");
wxml("fixtures/miniprogram/components/status-badge/status-badge.wxml");
wxml("fixtures/miniprogram/components/global-badge/global-badge.wxml");
wxml("fixtures/miniprogram/components/local-badge/local-badge.wxml");
wxml("fixtures/miniprogram/packages/shop/pages/list/list.wxml");
wxml("fixtures/miniprogram/templates/common.wxml");
wxml("fixtures/miniprogram/templates/secondary.wxml");
wxml("fixtures/miniprogram/templates/unrelated.wxml");

assert(hasDependency(home, "import", "fixtures/miniprogram/templates/common.wxml"), "Missing common template import dependency");
assert(hasDependency(home, "include", "fixtures/miniprogram/templates/secondary.wxml"), "Missing secondary template include dependency");
assert(hasDependency(home, "wxs", "fixtures/miniprogram/utils/format.wxs"), "Missing format wxs dependency");
assert(hasDependency(detail, "import", "fixtures/miniprogram/templates/unrelated.wxml"), "Missing unrelated template import dependency");
assert(home.references.some((reference) => reference.kind === "template" && reference.name === "loadingRow"), "Missing loadingRow template reference");
assert(home.references.some((reference) => reference.kind === "template" && reference.name === "secondaryRow"), "Missing secondaryRow template reference");
assert(home.components.some((component) => component.tag === "user-card"), "Missing user-card component candidate");
assert(home.components.some((component) => component.tag === "global-badge"), "Missing home global-badge component candidate");
for (const tag of ["view", "text"]) {
  assert(!home.components.some((component) => component.tag === tag), `Builtin tag leaked into project graph component candidates: ${tag}`);
}
' "$PROJECT_GRAPH"

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

node "$ROOT_DIR/scripts/verify-wxml-language-service.mjs"
node "$ROOT_DIR/scripts/verify-wasm-symbol-baselines.mjs"
node "$ROOT_DIR/scripts/verify-js-wasm-parser.mjs"
node "$ROOT_DIR/scripts/verify-js-method-baselines.mjs"
node "$ROOT_DIR/scripts/verify-js-script-info.mjs"
node "$ROOT_DIR/scripts/verify-wxml-expression-helpers.mjs"
node "$ROOT_DIR/scripts/verify-lsp-diagnostics.mjs" --suite graph-smoke

echo "wxml-zed tree-sitter verification passed"
