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

function testMalformedWxsProducesNoSymbol() {
  const result = extract("fixtures/wxs-injection.wxml");
  const file = result.files[0];
  const noNameWxs = file.symbols.filter((s) => s.kind === "wxs" && !s.name);
  assert(noNameWxs.length === 0,
    `S-W3: expected no nameless wxs symbol; got ${JSON.stringify(noNameWxs)}`);
}

const CASES = [
  ["S-W1: external wxs nameRange", testExternalWxsNameRange],
  ["S-W2: inline wxs nameRange", testInlineWxsNameRange],
  ["S-W3: malformed wxs produces no symbol", testMalformedWxsProducesNoSymbol],
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
