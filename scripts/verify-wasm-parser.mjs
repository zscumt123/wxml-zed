import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import * as TreeSitter from "web-tree-sitter";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WASM = path.join(ROOT, "grammar/tree-sitter-wxml/tree-sitter-wxml.wasm");
const FIXTURE = path.join(ROOT, "fixtures/miniprogram/pages/home/home.wxml");

function pickNumeric(obj, names) {
  if (!obj) return null;
  for (const name of names) {
    const value = obj[name];
    if (typeof value === "number") return { name, value };
  }
  return null;
}

async function main() {
  const Parser = TreeSitter.Parser ?? TreeSitter.default;
  const Language = TreeSitter.Language ?? Parser?.Language;
  if (!Parser || !Language) {
    throw new Error(`web-tree-sitter API surface unrecognized; exports: ${Object.keys(TreeSitter).join(", ")}`);
  }

  await Parser.init();
  const language = await Language.load(WASM);
  const parser = new Parser();
  parser.setLanguage(language);

  const source = await fs.readFile(FIXTURE, "utf8");
  const tree = parser.parse(source);

  const moduleExports = Object.keys(TreeSitter);
  const languageKeys = Object.keys(language);
  const abiOnLanguage = pickNumeric(language, ["abiVersion", "version", "languageVersion"]);
  const runtimeAbi = pickNumeric(TreeSitter, ["LANGUAGE_VERSION"]);
  const minCompat = pickNumeric(TreeSitter, ["MIN_COMPATIBLE_VERSION", "MIN_COMPATIBLE_LANGUAGE_VERSION"]);

  const report = {
    moduleExports,
    languageKeys,
    abiOnLanguage,
    runtimeAbi,
    minCompat,
    rootType: tree.rootNode.type,
    rootNamedChildCount: tree.rootNode.namedChildCount,
    rootHasError: tree.rootNode.hasError,
    sourceBytes: Buffer.byteLength(source, "utf8"),
  };

  console.log(JSON.stringify(report, null, 2));

  const failures = [];
  if (tree.rootNode.hasError) failures.push("rootNode.hasError = true");
  if (!abiOnLanguage) failures.push("no numeric ABI/version field on language");
  if (runtimeAbi && abiOnLanguage && abiOnLanguage.value > runtimeAbi.value) {
    failures.push(`wasm ABI ${abiOnLanguage.value} exceeds runtime LANGUAGE_VERSION ${runtimeAbi.value}`);
  }
  if (minCompat && abiOnLanguage && abiOnLanguage.value < minCompat.value) {
    failures.push(`wasm ABI ${abiOnLanguage.value} below runtime MIN_COMPATIBLE ${minCompat.value}`);
  }
  if (failures.length) {
    console.error("FAIL:", failures.join("; "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAIL:", err?.message || err);
  process.exit(1);
});
