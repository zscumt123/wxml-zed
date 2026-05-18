#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { extractMethods } from "../shared/js-method-extractor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS_WASM = path.join(ROOT, "grammar/tree-sitter-javascript/tree-sitter-javascript.wasm");

const CASES = [
  {
    label: "plain Page",
    source: `Page({ data: {}, onLoad() {}, custom() {} });`,
    hasDynamicMethods: false,
    methodNames: ["onLoad", "custom"],
  },
  {
    label: "plain Component",
    source: `Component({ methods: { a() {}, b() {} } });`,
    hasDynamicMethods: false,
    methodNames: ["a", "b"],
  },
  {
    label: "Component with spread in options",
    source: `Component({ ...base, methods: { custom() {} } });`,
    hasDynamicMethods: true,
    methodNames: ["custom"],
  },
  {
    label: "Component with spread in methods block",
    source: `Component({ methods: { ...common, custom() {} } });`,
    hasDynamicMethods: true,
    methodNames: ["custom"],
  },
  {
    label: "Component with non-empty behaviors array literal",
    source: `Component({ behaviors: [foo, bar], methods: { custom() {} } });`,
    hasDynamicMethods: true,
    methodNames: ["custom"],
  },
  {
    label: "Component with empty behaviors array literal",
    source: `Component({ behaviors: [], methods: { custom() {} } });`,
    hasDynamicMethods: false,
    methodNames: ["custom"],
  },
  {
    label: "Component with behaviors identifier (variable reference)",
    source: `Component({ behaviors: commonBehaviors, methods: { custom() {} } });`,
    hasDynamicMethods: true,
    methodNames: ["custom"],
  },
  {
    label: "Component with methods identifier (variable reference)",
    source: `Component({ methods: commonMethods });`,
    hasDynamicMethods: true,
    methodNames: [],
  },
  {
    label: "Component with methods: Object.assign(...)",
    source: `Component({ methods: Object.assign({}, common, { custom() {} }) });`,
    hasDynamicMethods: true,
    methodNames: [],
  },
  {
    label: "Component with Object.assign factory arg",
    source: `Component(Object.assign({}, base, { methods: { custom() {} } }));`,
    hasDynamicMethods: true,
    methodNames: [],
  },
  {
    label: "Page with spread in options",
    source: `Page({ ...base, onLoad() {} });`,
    hasDynamicMethods: true,
    methodNames: ["onLoad"],
  },
  {
    label: "no factory call",
    source: `const x = 1;`,
    hasDynamicMethods: false,
    methodNames: [],
  },
];

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`FAIL: ${message}\n`);
    process.exit(1);
  }
}

async function main() {
  process.stdout.write(`[verify-js-script-info] ${CASES.length} cases ... `);
  await Parser.init();
  const lang = await Language.load(JS_WASM);
  const parser = new Parser();
  parser.setLanguage(lang);

  for (const { label, source, hasDynamicMethods, methodNames } of CASES) {
    const result = extractMethods(parser, source);
    assert(
      typeof result === "object" && result !== null && Array.isArray(result.methods),
      `${label}: bad return shape ${JSON.stringify(result)}`,
    );
    assert(
      result.hasDynamicMethods === hasDynamicMethods,
      `${label}: hasDynamicMethods expected ${hasDynamicMethods}, got ${result.hasDynamicMethods}`,
    );
    const actualNames = result.methods.map((m) => m.name).sort();
    const expectedNames = [...methodNames].sort();
    assert(
      actualNames.length === expectedNames.length && actualNames.every((n, i) => n === expectedNames[i]),
      `${label}: methods expected [${expectedNames.join(", ")}], got [${actualNames.join(", ")}]`,
    );
  }
  process.stdout.write("PASS\n");
  process.stdout.write(`\nAll ${CASES.length} script-info cases match.\n`);
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${err?.message || err}\n`);
  process.exit(1);
});
