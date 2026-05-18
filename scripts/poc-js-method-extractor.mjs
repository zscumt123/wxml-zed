#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { Parser, Language } from "web-tree-sitter";
import { extractMethods } from "../shared/js-method-extractor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(ROOT, "grammar/tree-sitter-javascript/tree-sitter-javascript.wasm");

function toPosix(p) {
  return p.split(path.sep).join(path.posix.sep);
}

function relativePathFromRoot(filePath) {
  return toPosix(path.relative(ROOT, path.resolve(filePath)));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write("Usage: node scripts/poc-js-method-extractor.mjs <file.js> [...file.js]\n");
    process.exit(1);
  }

  await Parser.init();
  const language = await Language.load(WASM);
  const parser = new Parser();
  parser.setLanguage(language);

  const files = [];
  for (const arg of args) {
    const inputAbs = path.resolve(process.cwd(), arg);
    const inputRel = relativePathFromRoot(inputAbs);
    const source = await fs.readFile(inputAbs, "utf8");
    const { methods } = extractMethods(parser, source);
    files.push({ path: inputRel, methods });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  process.stdout.write(`${JSON.stringify({ version: 1, files }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${err?.message || err}\n`);
  process.exit(1);
});
