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
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "plain Component",
    source: `Component({ methods: { a() {}, b() {} } });`,
    hasDynamicMethods: false,
    methodNames: ["a", "b"],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Component with spread in options",
    source: `Component({ ...base, methods: { custom() {} } });`,
    hasDynamicMethods: true,
    methodNames: ["custom"],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: true,
  },
  {
    label: "Component with spread in methods block",
    source: `Component({ methods: { ...common, custom() {} } });`,
    hasDynamicMethods: true,
    methodNames: ["custom"],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Component with non-empty behaviors array literal",
    source: `Component({ behaviors: [foo, bar], methods: { custom() {} } });`,
    hasDynamicMethods: true,
    methodNames: ["custom"],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: true,
  },
  {
    label: "Component with empty behaviors array literal",
    source: `Component({ behaviors: [], methods: { custom() {} } });`,
    hasDynamicMethods: false,
    methodNames: ["custom"],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Component with behaviors identifier (variable reference)",
    source: `Component({ behaviors: commonBehaviors, methods: { custom() {} } });`,
    hasDynamicMethods: true,
    methodNames: ["custom"],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: true,
  },
  {
    label: "Component with methods identifier (variable reference)",
    source: `Component({ methods: commonMethods });`,
    hasDynamicMethods: true,
    methodNames: [],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Component with methods: Object.assign(...)",
    source: `Component({ methods: Object.assign({}, common, { custom() {} }) });`,
    hasDynamicMethods: true,
    methodNames: [],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Component with Object.assign factory arg",
    source: `Component(Object.assign({}, base, { methods: { custom() {} } }));`,
    hasDynamicMethods: true,
    methodNames: [],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: true,
  },
  {
    label: "Page with spread in options",
    source: `Page({ ...base, onLoad() {} });`,
    hasDynamicMethods: true,
    methodNames: ["onLoad"],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: true,
  },
  {
    label: "no factory call",
    source: `const x = 1;`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Page with plain data block",
    source: `Page({ data: { count: 0, theme: "light", users: [] } });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["count", "theme", "users"],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Component with plain data block",
    source: `Component({ data: { a: 1 }, methods: { custom() {} } });`,
    hasDynamicMethods: false,
    methodNames: ["custom"],
    dataKeys: ["a"],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Page with spread in data block",
    source: `Page({ data: { ...defaults, count: 0 } });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["count"],
    propertyKeys: [],
    hasDynamicData: true,
  },
  {
    label: "Page with data identifier (variable reference)",
    source: `Page({ data: pageData });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: true,
  },
  {
    label: "Page with data: Object.assign(...)",
    source: `Page({ data: Object.assign({}, base, { count: 0 }) });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: true,
  },
  {
    label: "Page with computed-key in data (v1: skipped, dynamic flag NOT set)",
    source: `Page({ data: { [name]: 1, count: 0 } });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["count"],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Component with plain properties block",
    source: `Component({ properties: { user: { type: Object, value: {} }, label: String }, methods: { onTap() {} } });`,
    hasDynamicMethods: false,
    methodNames: ["onTap"],
    dataKeys: [],
    propertyKeys: ["user", "label"],
    hasDynamicData: false,
  },
  {
    label: "Component with properties identifier (variable reference)",
    source: `Component({ properties: sharedProps });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: true,
  },
  {
    label: "Component with spread in properties block",
    source: `Component({ properties: { ...basicProps, custom: String } });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: [],
    propertyKeys: ["custom"],
    hasDynamicData: true,
  },
  {
    label: "Page with quoted-identifier keys in data",
    source: `Page({ data: { "foo": 1, 'bar': 2, baz: 3 } });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["foo", "bar", "baz"],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Page with non-identifier-shape string keys in data (skipped)",
    source: `Page({ data: { "hello-world": 1, "123": 2, "": 3, valid: 4 } });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["valid"],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Component with quoted-identifier keys in properties",
    source: `Component({ properties: { "user": { type: Object }, "label": String } });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: [],
    propertyKeys: ["user", "label"],
    hasDynamicData: false,
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

  for (const { label, source, hasDynamicMethods, methodNames, dataKeys, propertyKeys, hasDynamicData } of CASES) {
    const result = extractMethods(parser, source);
    assert(
      typeof result === "object" && result !== null
        && Array.isArray(result.methods)
        && Array.isArray(result.dataKeys)
        && Array.isArray(result.propertyKeys),
      `${label}: bad return shape ${JSON.stringify(result)}`,
    );
    assert(
      result.hasDynamicMethods === hasDynamicMethods,
      `${label}: hasDynamicMethods expected ${hasDynamicMethods}, got ${result.hasDynamicMethods}`,
    );
    assert(
      result.hasDynamicData === hasDynamicData,
      `${label}: hasDynamicData expected ${hasDynamicData}, got ${result.hasDynamicData}`,
    );

    const actualNames = result.methods.map((m) => m.name).sort();
    const expectedNames = [...methodNames].sort();
    assert(
      actualNames.length === expectedNames.length && actualNames.every((n, i) => n === expectedNames[i]),
      `${label}: methods expected [${expectedNames.join(", ")}], got [${actualNames.join(", ")}]`,
    );

    const actualDataKeys = [...result.dataKeys].sort();
    const expectedDataKeys = [...dataKeys].sort();
    assert(
      actualDataKeys.length === expectedDataKeys.length && actualDataKeys.every((n, i) => n === expectedDataKeys[i]),
      `${label}: dataKeys expected [${expectedDataKeys.join(", ")}], got [${actualDataKeys.join(", ")}]`,
    );

    const actualPropertyKeys = [...result.propertyKeys].sort();
    const expectedPropertyKeys = [...propertyKeys].sort();
    assert(
      actualPropertyKeys.length === expectedPropertyKeys.length && actualPropertyKeys.every((n, i) => n === expectedPropertyKeys[i]),
      `${label}: propertyKeys expected [${expectedPropertyKeys.join(", ")}], got [${actualPropertyKeys.join(", ")}]`,
    );
  }
  process.stdout.write("PASS\n");
  process.stdout.write(`\nAll ${CASES.length} script-info cases match.\n`);
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${err?.message || err}\n`);
  process.exit(1);
});
