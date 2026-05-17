#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WXML_WASM = path.join(ROOT, "grammar/tree-sitter-wxml/tree-sitter-wxml.wasm");
const JS_WASM = path.join(ROOT, "grammar/tree-sitter-javascript/tree-sitter-javascript.wasm");

const SAMPLE_JS = `
Page({
  data: { count: 0 },
  onLoad: function () {},
  onTap() {
    this.setData({ count: this.data.count + 1 });
  },
});

Component({
  methods: {
    handleSelect() {},
    handleChange: function (e) {},
  },
});
`;

async function main() {
  await Parser.init();
  const wxmlLang = await Language.load(WXML_WASM);
  const jsLang = await Language.load(JS_WASM);

  const report = {
    wxmlAbi: wxmlLang.abiVersion,
    jsAbi: jsLang.abiVersion,
    jsNodeTypeCount: jsLang.nodeTypeCount,
  };

  const parser = new Parser();
  parser.setLanguage(jsLang);
  const tree = parser.parse(SAMPLE_JS);

  if (tree.rootNode.hasError) {
    console.error("FAIL: JS parse tree has errors");
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const seen = new Map();
  const walk = (n) => {
    seen.set(n.type, (seen.get(n.type) || 0) + 1);
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
  };
  walk(tree.rootNode);

  const interesting = [
    "call_expression", "identifier", "arguments", "object", "pair",
    "property_identifier", "method_definition", "function_expression",
    "arrow_function", "string", "string_fragment",
  ];
  report.nodeTypesPresent = Object.fromEntries(
    interesting.map((t) => [t, seen.get(t) ?? 0])
  );
  report.allNodeTypes = Array.from(seen.keys()).sort();

  console.log(JSON.stringify(report, null, 2));

  const failures = [];
  if (typeof report.jsAbi !== "number") failures.push("jsAbi not numeric");
  if (typeof report.wxmlAbi !== "number") failures.push("wxmlAbi not numeric");
  if ((report.nodeTypesPresent.call_expression ?? 0) < 2) failures.push("call_expression count < 2");
  if ((report.nodeTypesPresent.method_definition ?? 0) < 2) failures.push("method_definition count < 2");
  if ((report.nodeTypesPresent.pair ?? 0) < 2) failures.push("pair count < 2");
  if ((report.nodeTypesPresent.object ?? 0) < 2) failures.push("object count < 2");

  if (failures.length) {
    console.error("FAIL:", failures.join("; "));
    process.exit(1);
  }

  if (report.wxmlAbi !== report.jsAbi) {
    console.error(`NOTE: WXML ABI ${report.wxmlAbi} != JS ABI ${report.jsAbi} (both loaded successfully — compat range covers gap)`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e?.message || e);
  process.exit(1);
});
