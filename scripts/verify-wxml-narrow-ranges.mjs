#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTRACTOR = path.join(ROOT, "scripts/extract-wxml-symbols.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extract(file) {
  const out = execFileSync(process.execPath, [EXTRACTOR, file], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out);
}

function testExternalWxsNameRange() {
  const result = extract("fixtures/miniprogram/pages/home/home.wxml");
  const file = result.files[0];
  const wxs = file.symbols.find((s) => s.kind === "wxs" && s.name === "format");
  assert(wxs, `S-W1: expected wxs symbol named 'format'; got ${JSON.stringify(file.symbols)}`);
  assert(wxs.nameRange, `S-W1: expected nameRange on wxs symbol; got ${JSON.stringify(wxs)}`);
  assert(wxs.nameRange.start.row === 2, `S-W1: row ${wxs.nameRange.start.row}`);
  assert(wxs.nameRange.start.column === 13, `S-W1: start col ${wxs.nameRange.start.column}`);
  assert(wxs.nameRange.end.row === 2, `S-W1: end row ${wxs.nameRange.end.row}`);
  assert(wxs.nameRange.end.column === 19, `S-W1: end col ${wxs.nameRange.end.column}`);
}

function testInlineWxsNameRange() {
  const result = extract("fixtures/test.wxml");
  const file = result.files[0];
  const wxs = file.symbols.find((s) => s.kind === "wxs" && s.name === "inline");
  assert(wxs, `S-W2: expected wxs symbol named 'inline'; got ${JSON.stringify(file.symbols)}`);
  assert(wxs.nameRange, `S-W2: expected nameRange on inline wxs symbol; got ${JSON.stringify(wxs)}`);
  assert(wxs.nameRange.start.row === wxs.nameRange.end.row,
    `S-W2: nameRange spans rows ${wxs.nameRange.start.row}->${wxs.nameRange.end.row}`);
  assert(wxs.nameRange.end.column - wxs.nameRange.start.column === 6,
    `S-W2: expected 6-char-wide nameRange, got ${wxs.nameRange.end.column - wxs.nameRange.start.column}`);
}

// S-W3: a <wxs ... /> without a `module` attribute produces no symbol entry;
// the well-formed <wxs module="math"> in the same file does produce one,
// and (per the new nameRange schema) carries nameRange.
function testMalformedWxsProducesNoSymbol() {
  const result = extract("fixtures/wxs-injection.wxml");
  const file = result.files[0];
  const wxsSymbols = file.symbols.filter((s) => s.kind === "wxs");
  assert(wxsSymbols.length === 1,
    `S-W3: expected exactly one wxs symbol (math); got ${JSON.stringify(wxsSymbols)}`);
  assert(wxsSymbols[0].name === "math",
    `S-W3: expected the surviving wxs symbol to be 'math'; got ${wxsSymbols[0].name}`);
  assert(wxsSymbols[0].nameRange,
    `S-W3: expected nameRange on the surviving wxs symbol; got ${JSON.stringify(wxsSymbols[0])}`);
}

function testComponentTagNameRange() {
  const result = extract("fixtures/miniprogram/pages/home/home.wxml");
  const file = result.files[0];
  const comp = file.components.find((c) => c.tag === "user-card");
  assert(comp, `S-C1: expected component 'user-card'; got ${JSON.stringify(file.components)}`);
  assert(comp.tagNameRange, `S-C1: expected tagNameRange; got ${JSON.stringify(comp)}`);
  assert(comp.tagNameRange.start.row === 7, `S-C1: start row ${comp.tagNameRange.start.row}`);
  assert(comp.tagNameRange.start.column === 3, `S-C1: start col ${comp.tagNameRange.start.column}`);
  assert(comp.tagNameRange.end.column - comp.tagNameRange.start.column === "user-card".length,
    `S-C1: width ${comp.tagNameRange.end.column - comp.tagNameRange.start.column}`);
}

function testSelfClosingComponentTagNameRange() {
  const result = extract("fixtures/miniprogram/pages/home/home.wxml");
  const file = result.files[0];
  const comp = file.components.find((c) => c.tag === "global-badge");
  assert(comp, `S-C2: expected component 'global-badge'; got ${JSON.stringify(file.components)}`);
  assert(comp.tagNameRange, `S-C2: expected tagNameRange on self-closing; got ${JSON.stringify(comp)}`);
  assert(comp.tagNameRange.start.row === 15, `S-C2: start row ${comp.tagNameRange.start.row}`);
  assert(comp.tagNameRange.start.column === 3, `S-C2: start col ${comp.tagNameRange.start.column}`);
  assert(comp.tagNameRange.end.column - comp.tagNameRange.start.column === "global-badge".length,
    `S-C2: width ${comp.tagNameRange.end.column - comp.tagNameRange.start.column}`);
}

// S-F1: explicit wx:for-item / wx:for-index produce one scope with
// explicit source + narrow nameRange.
function testExplicitScopeShape() {
  const result = extract("fixtures/miniprogram/pages/loops/loops.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(Array.isArray(scopes), `S-F1: wxForScopes must be an array; got ${typeof scopes}`);
  const prodScope = scopes.find((s) => s.itemName === "prod");
  assert(prodScope, `S-F1: expected scope with itemName 'prod'; got ${JSON.stringify(scopes.map((s) => s.itemName))}`);
  assert(prodScope.itemSource === "explicit", `S-F1: itemSource ${prodScope.itemSource}`);
  assert(prodScope.itemNameRange, `S-F1: explicit itemName must carry nameRange`);
  assert(prodScope.indexName === "idx", `S-F1: indexName ${prodScope.indexName}`);
  assert(prodScope.indexSource === "explicit", `S-F1: indexSource ${prodScope.indexSource}`);
  assert(prodScope.indexNameRange, `S-F1: explicit indexName must carry nameRange`);
  assert(prodScope.ownerTag === "view", `S-F1: ownerTag ${prodScope.ownerTag}`);
  assert(prodScope.scopeRange, `S-F1: scopeRange must be present`);
  assert(prodScope.wxForRange, `S-F1: wxForRange must be present`);
}

function testImplicitScopeShape() {
  const result = extract("fixtures/miniprogram/pages/loops/loops.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  const usersScope = scopes.find((s) => s.itemName === "item" && s.itemSource === "implicit");
  assert(usersScope, `S-F2: expected implicit scope with itemName 'item' (default); got ${JSON.stringify(scopes.map((s) => ({ i: s.itemName, src: s.itemSource })))}`);
  assert(usersScope.itemNameRange === null, `S-F2: implicit itemNameRange must be null`);
  assert(usersScope.indexName === "index", `S-F2: implicit indexName`);
  assert(usersScope.indexSource === "implicit", `S-F2: implicit indexSource`);
  assert(usersScope.indexNameRange === null, `S-F2: implicit indexNameRange must be null`);
}

function testNestedScopes() {
  const result = extract("fixtures/miniprogram/pages/loops/loops.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  const outer = scopes.find((s) => s.itemName === "outer");
  const inner = scopes.find((s) => s.itemName === "inner");
  assert(outer, `S-F3: outer scope missing`);
  assert(inner, `S-F3: inner scope missing`);
  assert(outer.scopeRange.start.row <= inner.scopeRange.start.row, `S-F3: outer must start at or above inner`);
  assert(outer.scopeRange.end.row >= inner.scopeRange.end.row, `S-F3: outer must end at or below inner`);
  const outerArea = (outer.scopeRange.end.row - outer.scopeRange.start.row) * 1000
    + (outer.scopeRange.end.column - outer.scopeRange.start.column);
  const innerArea = (inner.scopeRange.end.row - inner.scopeRange.start.row) * 1000
    + (inner.scopeRange.end.column - inner.scopeRange.start.column);
  assert(innerArea < outerArea, `S-F3: inner scope must be strictly smaller than outer (outer=${outerArea}, inner=${innerArea})`);
}

function testEmptyAttrFallsBackToImplicit() {
  const result = extract("fixtures/wasm-spike/wx-for-empty-attr.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(scopes.length === 1, `S-F4: expected exactly one scope; got ${scopes.length}`);
  const s = scopes[0];
  assert(s.itemName === "item" && s.itemSource === "implicit" && s.itemNameRange === null,
    `S-F4: empty wx:for-item should fall back to implicit; got ${JSON.stringify(s)}`);
  assert(s.indexName === "index" && s.indexSource === "implicit" && s.indexNameRange === null,
    `S-F4: empty wx:for-index should fall back to implicit; got ${JSON.stringify(s)}`);
}

function testLooseAttrCompat() {
  const result = extract("fixtures/wasm-spike/wx-for-loose-attr.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(scopes.length === 0, `S-F5: loose wx:for-item without wx:for must NOT create a scope; got ${JSON.stringify(scopes)}`);
  const bindings = file.wxForBindings;
  assert(bindings, `S-F5: expected wxForBindings (compat shim)`);
  assert(bindings.items.includes("loose"), `S-F5: derived wxForBindings.items must include legacy loose name; got ${JSON.stringify(bindings.items)}`);
  assert(bindings.indexes.includes("loose_idx"), `S-F5: derived wxForBindings.indexes must include legacy loose name; got ${JSON.stringify(bindings.indexes)}`);
  assert(bindings.hasAnyWxFor === false, `S-F5: hasAnyWxFor must be false (no real wx:for present); got ${bindings.hasAnyWxFor}`);
}

function testBareWxForCreatesScope() {
  const result = extract("fixtures/wasm-spike/wx-for-bare.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(scopes.length === 1, `S-F6: bare wx:for must create exactly one scope; got ${scopes.length}`);
  const s = scopes[0];
  assert(s.itemName === "item" && s.itemSource === "implicit",
    `S-F6: bare wx:for scope should have implicit defaults; got ${JSON.stringify(s)}`);
  assert(s.indexName === "index" && s.indexSource === "implicit",
    `S-F6: same for index; got ${JSON.stringify(s)}`);
  assert(s.wxForRange, `S-F6: wxForRange must exist (covers the bare wx:for attr)`);
  const bindings = file.wxForBindings;
  assert(bindings.hasAnyWxFor === true,
    `S-F6: derived hasAnyWxFor must be true (legacy parity); got ${bindings.hasAnyWxFor}`);
}

function testInterpolatedItemNameFallsBackToImplicit() {
  const result = extract("fixtures/wasm-spike/wx-for-interp-item.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(scopes.length === 1, `S-F7: expected exactly one scope; got ${scopes.length}`);
  const s = scopes[0];
  assert(s.itemName === "item" && s.itemSource === "implicit" && s.itemNameRange === null,
    `S-F7: dynamic wx:for-item="{{dyn}}" must fall back to implicit; got ${JSON.stringify(s)}`);
  const bindings = file.wxForBindings;
  assert(!bindings.items.includes("{{dyn}}"),
    `S-F7: wxForBindings.items must NOT contain the literal "{{dyn}}"; got ${JSON.stringify(bindings.items)}`);
  assert(!bindings.items.includes("dyn"),
    `S-F7: wxForBindings.items must NOT contain "dyn" either; got ${JSON.stringify(bindings.items)}`);
}

// W-7: derived wxForBindings must byte-equal the pre-change snapshot
// for every file in every baseline. The snapshot is the literal
// wxForBindings that the legacy extractor produced before this change.
// Captured pre-Task-2; inlined here as a closed reference set.
const W7_FROZEN_WX_FOR_BINDINGS = {
  "edge-recovery-symbols-baseline.json::fixtures/real-world/edge-recovery.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "home-symbols-baseline.json::fixtures/miniprogram/pages/home/home.wxml": {"items":[],"indexes":[],"hasAnyWxFor":true},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/components/dyn-card/dyn-card.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/components/folder-comp/index.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/components/global-badge/global-badge.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/components/local-badge/local-badge.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/components/local-bar/local-bar.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/components/status-badge/status-badge.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/components/user-card/user-card.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/packages/shop/pages/list/list.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/pages/cross-binding/cross-binding.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/pages/detail/detail.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/pages/dyn-page/dyn-page.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/pages/home/home.wxml": {"items":[],"indexes":[],"hasAnyWxFor":true},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/pages/loops/loops.wxml": {"items":["inner","item","outer","prod"],"indexes":["idx"],"hasAnyWxFor":true},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/shared/header.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/templates/common.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/templates/secondary.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "miniprogram-symbols-baseline.json::fixtures/miniprogram/templates/unrelated.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "non-ascii-symbols-baseline.json::fixtures/wasm-spike/non-ascii.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "real-world-symbols-baseline.json::fixtures/real-world/component.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "real-world-symbols-baseline.json::fixtures/real-world/page.wxml": {"items":["user"],"indexes":["idx"],"hasAnyWxFor":true},
  "real-world-symbols-baseline.json::fixtures/real-world/templates.wxml": {"items":[],"indexes":[],"hasAnyWxFor":false},
  "test-wxml-symbols-baseline.json::fixtures/test.wxml": {"items":["row"],"indexes":["idx"],"hasAnyWxFor":true},
  "wx-for-unquoted-symbols-baseline.json::fixtures/wasm-spike/wx-for-unquoted.wxml": {"items":["user"],"indexes":["i"],"hasAnyWxFor":true},
};

function testCompatShimByteEqual() {
  const baselineDir = path.join(ROOT, "fixtures/wasm-spike");
  const files = fs.readdirSync(baselineDir).filter((f) => f.endsWith("-symbols-baseline.json"));
  const actualKeys = new Set();
  for (const baselineName of files) {
    const baselinePath = path.join(baselineDir, baselineName);
    const data = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const fileModels = Array.isArray(data) ? data : data.files;
    for (const fileModel of fileModels) {
      const key = `${baselineName}::${fileModel.path}`;
      actualKeys.add(key);
      const expected = W7_FROZEN_WX_FOR_BINDINGS[key];
      assert(
        expected !== undefined,
        `W-7: missing frozen snapshot for ${key}. Paste the literal from Step 1's command output into W7_FROZEN_WX_FOR_BINDINGS.`,
      );
      const actual = fileModel.wxForBindings;
      assert(
        JSON.stringify(actual) === JSON.stringify(expected),
        `W-7: wxForBindings byte-equal failed for ${key}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`,
      );
    }
  }
  for (const key of Object.keys(W7_FROZEN_WX_FOR_BINDINGS)) {
    assert(
      actualKeys.has(key),
      `W-7: stale snapshot for ${key} — no matching fileModel found. Remove from W7_FROZEN_WX_FOR_BINDINGS.`,
    );
  }
}

const CASES = [
  ["S-W1: external wxs nameRange", testExternalWxsNameRange],
  ["S-W2: inline wxs nameRange", testInlineWxsNameRange],
  ["S-W3: malformed wxs produces no symbol", testMalformedWxsProducesNoSymbol],
  ["S-C1: component tagNameRange (start tag)", testComponentTagNameRange],
  ["S-C2: component tagNameRange (self-closing tag)", testSelfClosingComponentTagNameRange],
  ["S-F1: explicit wx:for-item / wx:for-index", testExplicitScopeShape],
  ["S-F2: default wx:for produces implicit scope", testImplicitScopeShape],
  ["S-F3: nested loops produce nested scopes", testNestedScopes],
  ["S-F4: empty explicit attrs fall back to implicit", testEmptyAttrFallsBackToImplicit],
  ["S-F5: loose attrs without wx:for preserve legacy compat", testLooseAttrCompat],
  ["S-F6: bare wx:for preserves legacy hasAnyWxFor", testBareWxForCreatesScope],
  ["S-F7: dynamic wx:for-item interpolation does not leak into items", testInterpolatedItemNameFallsBackToImplicit],
  ["W-7: wxForBindings compat shim is byte-equal across all baselines", testCompatShimByteEqual],
];

let passed = 0, failed = 0;
for (const [label, fn] of CASES) {
  try {
    fn();
    process.stdout.write(`PASS ${label}\n`);
    passed += 1;
  } catch (err) {
    process.stdout.write(`FAIL ${label}\n  ${err.message}\n`);
    failed += 1;
  }
}
process.stdout.write(`\nResult: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
