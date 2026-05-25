#!/usr/bin/env node
import { execFileSync } from "node:child_process";
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

const CASES = [
  ["S-W1: external wxs nameRange", testExternalWxsNameRange],
  ["S-W2: inline wxs nameRange", testInlineWxsNameRange],
  ["S-W3: malformed wxs produces no symbol", testMalformedWxsProducesNoSymbol],
  ["S-C1: component tagNameRange (start tag)", testComponentTagNameRange],
  ["S-C2: component tagNameRange (self-closing tag)", testSelfClosingComponentTagNameRange],
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
