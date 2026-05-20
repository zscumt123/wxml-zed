#!/usr/bin/env node
import {
  topLevelIdentifiers,
  looksLikeObjectLiteralExpression,
  stripStringLiterals,
} from "../shared/wxml-expression-helpers.mjs";

const IDENT_CASES = [
  { label: "plain identifier", input: "theme", expected: ["theme"] },
  { label: "member access tail", input: "item.name", expected: ["item"] },
  { label: "multi-member chain", input: "a.b.c + x", expected: ["a", "x"] },
  { label: "JS literal keywords", input: "true && false && null && undefined", expected: [] },
  { label: "typeof operator", input: "typeof total === 'number'", expected: ["total"] },
  { label: "instanceof operator", input: "x instanceof Y", expected: ["x", "Y"] },
  { label: "in operator", input: "key in obj", expected: ["key", "obj"] },
  { label: "string literal content (single-quote)", input: "status === 'ready'", expected: ["status"] },
  { label: "string literal content (double-quote)", input: 'mode === "active"', expected: ["mode"] },
  { label: "ternary with string branches", input: "cond ? 'a' : 'b'", expected: ["cond"] },
  { label: "member + string literal mix", input: "item.type === 'vip'", expected: ["item"] },
  { label: "this keyword", input: "this.x + y", expected: ["y"] },
  { label: "void operator", input: "void 0 || fallback", expected: ["fallback"] },
  { label: "escape inside string", input: "label === 'it\\'s'", expected: ["label"] },
  { label: "template literal bails", input: "`hello ${name}`", expected: [] },
  { label: "object literal shape", input: "message: 'Loading users'", expected: [] },
  { label: "object literal with brace", input: "{count: 0, theme: 'light'}", expected: [] },
  { label: "ternary not confused for object", input: "cond ? a : b", expected: ["cond", "a", "b"] },
  { label: "multiple top-level identifiers in call", input: "format.price(item.total)", expected: ["format", "item"] },
];

function assert(cond, msg) {
  if (!cond) {
    process.stderr.write(`FAIL: ${msg}\n`);
    process.exit(1);
  }
}

function main() {
  process.stdout.write(`[verify-wxml-expression-helpers] ${IDENT_CASES.length} cases ... `);
  for (const { label, input, expected } of IDENT_CASES) {
    const actual = topLevelIdentifiers(input).map((r) => r.name);
    const expectedSorted = [...expected].sort();
    const actualSorted = [...actual].sort();
    assert(
      actualSorted.length === expectedSorted.length && actualSorted.every((n, i) => n === expectedSorted[i]),
      `${label}: expected [${expectedSorted.join(", ")}], got [${actualSorted.join(", ")}] from ${JSON.stringify(input)}`,
    );
  }

  assert(looksLikeObjectLiteralExpression("message: 'x'") === true, "object: bare key");
  assert(looksLikeObjectLiteralExpression("{count: 0}") === true, "object: braced");
  assert(looksLikeObjectLiteralExpression("cond ? a : b") === false, "object: ternary not flagged");
  assert(looksLikeObjectLiteralExpression("plain.ref") === false, "object: plain ref not flagged");

  assert(stripStringLiterals("a + 'foo' + b") === "a + '   ' + b", "strip: single quote preserves length");
  assert(stripStringLiterals("a + `foo`") === null, "strip: template literal bails to null");

  process.stdout.write("PASS\n");
  process.stdout.write(`\nAll ${IDENT_CASES.length} expression-helper cases match.\n`);
}

main();
