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
  {
    label: "wrapped factory Fw.Page",
    source: `Fw.Page({ data: { count: 0 }, onLoad() {}, custom() {} });`,
    hasDynamicMethods: false,
    methodNames: ["onLoad", "custom"],
    dataKeys: ["count"],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "wrapped factory app.Component",
    source: `app.Component({ properties: { user: Object }, methods: { tap() {} } });`,
    hasDynamicMethods: false,
    methodNames: ["tap"],
    dataKeys: [],
    propertyKeys: ["user"],
    hasDynamicData: false,
  },
  {
    label: "wrapped factory globalThis.Page",
    source: `globalThis.Page({ data: { x: 1 }, onShow() {} });`,
    hasDynamicMethods: false,
    methodNames: ["onShow"],
    dataKeys: ["x"],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "member-expression NOT matching Page/Component",
    source: `Fw.somethingElse({ data: { x: 1 }, onTap() {} });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: [],
    propertyKeys: [],
    hasDynamicData: false,
  },
  {
    label: "Page with static setData in lifecycle",
    source: `Page({
      data: { count: 0 },
      onLoad() {
        this.setData({ message: "hi", visible: true });
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["onLoad"],
    dataKeys: ["count", "message", "visible"],
    dataKeySources: { count: "data", message: "setData", visible: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Page setData with shorthand property",
    source: `Page({
      data: {},
      onShow() {
        const userName = "x";
        this.setData({ userName });
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["onShow"],
    dataKeys: ["userName"],
    dataKeySources: { userName: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Page setData with quoted identifier-shape key",
    source: `Page({
      data: {},
      custom() {
        this.setData({ "foo": 1, "with-dash": 2, "bar": 3 });
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["custom"],
    dataKeys: ["foo", "bar"],
    dataKeySources: { foo: "setData", bar: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Page setData with computed key triggers dynamic",
    source: `Page({
      data: {},
      onLoad() {
        this.setData({ [dynName]: 1, staticName: 2 });
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["onLoad"],
    dataKeys: ["staticName"],
    dataKeySources: { staticName: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: true,
  },
  {
    label: "Component setData inside methods block",
    source: `Component({
      data: { visible: false },
      methods: {
        reload() { this.setData({ describe: "x", count: 1 }); },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["reload"],
    dataKeys: ["visible", "describe", "count"],
    dataKeySources: { visible: "data", describe: "setData", count: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Component setData inside lifetimes",
    source: `Component({
      data: {},
      lifetimes: {
        attached() { this.setData({ ready: true }); },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["ready"],
    dataKeySources: { ready: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Component setData inside pageLifetimes",
    source: `Component({
      data: {},
      pageLifetimes: {
        show() { this.setData({ active: true }); },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["active"],
    dataKeySources: { active: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Component setData inside observers",
    source: `Component({
      data: {},
      observers: {
        "field"() { this.setData({ derived: 1 }); },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["derived"],
    dataKeySources: { derived: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Component setData inside property observer",
    source: `Component({
      data: {},
      properties: {
        value: { type: String, observer() { this.setData({ derived: 1 }); } },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["derived"],
    dataKeySources: { derived: "setData" },
    propertyKeys: ["value"],
    propertyKeySources: { value: "property" },
    hasDynamicData: false,
  },
  {
    label: "Component setData inside legacy top-level lifecycle",
    source: `Component({
      data: {},
      attached() { this.setData({ ready: true }); },
    });`,
    hasDynamicMethods: false,
    methodNames: ["attached"],
    dataKeys: ["ready"],
    dataKeySources: { ready: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Component setData inside nested arrow (setTimeout) is extracted",
    source: `Component({
      data: {},
      methods: {
        kick() { setTimeout(() => this.setData({ later: 1 }), 100); },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["kick"],
    dataKeys: ["later"],
    dataKeySources: { later: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Component nested regular function this.setData is ignored",
    source: `Component({
      data: { foo: 1 },
      methods: {
        run() {
          setTimeout(function () { this.setData({ ignored: 1 }); }, 0);
        },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["run"],
    dataKeys: ["foo"],
    dataKeySources: { foo: "data" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Component nested generator function this.setData is ignored",
    source: `Component({
    data: { foo: 1 },
    methods: {
      run() {
        const it = (function* () { this.setData({ ignored: 1 }); })();
        it.next();
      },
    },
  });`,
    hasDynamicMethods: false,
    methodNames: ["run"],
    dataKeys: ["foo"],
    dataKeySources: { foo: "data" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Component setData spread triggers dynamic but still keeps static keys",
    source: `Component({
      data: {},
      methods: {
        reload() { this.setData({ ...payload, keep: 1 }); },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["reload"],
    dataKeys: ["keep"],
    dataKeySources: { keep: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: true,
  },
  {
    label: "Component setData non-object arg triggers dynamic",
    source: `Component({
      data: { foo: 1 },
      methods: {
        apply() { this.setData(payload); },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["apply"],
    dataKeys: ["foo"],
    dataKeySources: { foo: "data" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: true,
  },
  {
    label: "Component setData empty args is a no-op",
    source: `Component({
      data: { foo: 1 },
      methods: {
        apply() { this.setData(); },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["apply"],
    dataKeys: ["foo"],
    dataKeySources: { foo: "data" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "Component setData dedup: data block wins on collision",
    source: `Component({
      data: { visible: false },
      methods: {
        toggle() { this.setData({ visible: true, derived: 1 }); },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["toggle"],
    dataKeys: ["visible", "derived"],
    dataKeySources: { visible: "data", derived: "setData" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "bare setData(...) without this. is ignored",
    source: `Component({
      data: { foo: 1 },
      methods: {
        apply() { setData({ should_not_appear: 1 }); },
      },
    });`,
    hasDynamicMethods: false,
    methodNames: ["apply"],
    dataKeys: ["foo"],
    dataKeySources: { foo: "data" },
    propertyKeys: [],
    propertyKeySources: {},
    hasDynamicData: false,
  },
  {
    label: "setData in module-level helper is ignored",
    source: `function helper() { this.setData({ nope: 1 }); }
      Component({
        data: { foo: 1 },
        methods: { run() { helper(); } },
      });`,
    hasDynamicMethods: false,
    methodNames: ["run"],
    dataKeys: ["foo"],
    dataKeySources: { foo: "data" },
    propertyKeys: [],
    propertyKeySources: {},
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

  for (const { label, source, hasDynamicMethods, methodNames, dataKeys, propertyKeys, hasDynamicData, dataKeySources, propertyKeySources } of CASES) {
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

    const actualDataKeys = [...result.dataKeys.map((k) => k.name)].sort();
    const expectedDataKeys = [...dataKeys].sort();
    assert(
      actualDataKeys.length === expectedDataKeys.length && actualDataKeys.every((n, i) => n === expectedDataKeys[i]),
      `${label}: dataKeys expected [${expectedDataKeys.join(", ")}], got [${actualDataKeys.join(", ")}]`,
    );

    const actualPropertyKeys = [...result.propertyKeys.map((k) => k.name)].sort();
    const expectedPropertyKeys = [...propertyKeys].sort();
    assert(
      actualPropertyKeys.length === expectedPropertyKeys.length && actualPropertyKeys.every((n, i) => n === expectedPropertyKeys[i]),
      `${label}: propertyKeys expected [${expectedPropertyKeys.join(", ")}], got [${actualPropertyKeys.join(", ")}]`,
    );

    // Structural assertion: each returned entry has a nameRange with numeric row/column
    // and a source discriminator.
    for (const entry of result.dataKeys) {
      assert(
        entry.nameRange
          && typeof entry.nameRange.start?.row === "number"
          && typeof entry.nameRange.start?.column === "number"
          && typeof entry.nameRange.end?.row === "number"
          && typeof entry.nameRange.end?.column === "number",
        `${label}: dataKey "${entry.name}" missing valid nameRange ${JSON.stringify(entry.nameRange)}`,
      );
      assert(
        entry.source === "data" || entry.source === "setData",
        `${label}: dataKey "${entry.name}" has invalid source ${JSON.stringify(entry.source)}`,
      );
    }
    for (const entry of result.propertyKeys) {
      assert(
        entry.nameRange
          && typeof entry.nameRange.start?.row === "number"
          && typeof entry.nameRange.start?.column === "number"
          && typeof entry.nameRange.end?.row === "number"
          && typeof entry.nameRange.end?.column === "number",
        `${label}: propertyKey "${entry.name}" missing valid nameRange ${JSON.stringify(entry.nameRange)}`,
      );
      assert(
        entry.source === "property",
        `${label}: propertyKey "${entry.name}" has invalid source ${JSON.stringify(entry.source)}`,
      );
    }

    // Per-case explicit source map. Optional: if the case omits dataKeySources,
    // skip this check (older cases that pre-date the source discriminator).
    // When present, the assertion is exact-match — every dataKey name MUST
    // appear in the expected map, and no extras allowed. This catches both
    // "missed an entry" and "tagged with the wrong source" wiring bugs.
    if (dataKeySources) {
      const actual = Object.fromEntries(result.dataKeys.map((k) => [k.name, k.source]));
      const expected = dataKeySources;
      const actualKeys = Object.keys(actual).sort();
      const expectedKeys = Object.keys(expected).sort();
      assert(
        actualKeys.length === expectedKeys.length && actualKeys.every((k, i) => k === expectedKeys[i]),
        `${label}: dataKeySources key set expected [${expectedKeys.join(", ")}], got [${actualKeys.join(", ")}]`,
      );
      for (const name of actualKeys) {
        assert(
          actual[name] === expected[name],
          `${label}: dataKey "${name}" expected source ${JSON.stringify(expected[name])}, got ${JSON.stringify(actual[name])}`,
        );
      }
    }
    if (propertyKeySources) {
      const actual = Object.fromEntries(result.propertyKeys.map((k) => [k.name, k.source]));
      const expected = propertyKeySources;
      const actualKeys = Object.keys(actual).sort();
      const expectedKeys = Object.keys(expected).sort();
      assert(
        actualKeys.length === expectedKeys.length && actualKeys.every((k, i) => k === expectedKeys[i]),
        `${label}: propertyKeySources key set expected [${expectedKeys.join(", ")}], got [${actualKeys.join(", ")}]`,
      );
      for (const name of actualKeys) {
        assert(
          actual[name] === expected[name],
          `${label}: propertyKey "${name}" expected source ${JSON.stringify(expected[name])}, got ${JSON.stringify(actual[name])}`,
        );
      }
    }
  }
  process.stdout.write("PASS\n");
  process.stdout.write(`\nAll ${CASES.length} script-info cases match.\n`);
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${err?.message || err}\n`);
  process.exit(1);
});
