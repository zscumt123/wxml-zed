#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";

import {
  collectFile,
  relativePathFromRoot,
} from "../shared/wxml-symbol-extractor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(ROOT, "grammar/tree-sitter-wxml/tree-sitter-wxml.wasm");
const PROFILE_ENABLED = process.env.WXML_ZED_PROFILE === "1";

function elapsedMs(start) {
  return Number((performance.now() - start).toFixed(2));
}

function profileEvent(event) {
  if (!PROFILE_ENABLED) return;
  process.stderr.write(`WXML_ZED_PROFILE ${JSON.stringify({
    source: "extract-wxml-symbols",
    ...event,
  })}\n`);
}

async function extractFile(parser, filePath) {
  const totalStart = performance.now();
  const inputAbs = path.resolve(filePath);
  const inputRel = relativePathFromRoot(inputAbs);

  const readStart = performance.now();
  const source = await fs.readFile(inputAbs, "utf8");
  const readMs = elapsedMs(readStart);

  const cstStart = performance.now();
  const tree = parser.parse(source);
  const cstMs = elapsedMs(cstStart);

  const extractStart = performance.now();
  const { dependencies, symbols, references, components, eventHandlers, expressionRefs, wxForScopes, wxForBindings } = collectFile(tree, inputAbs);
  const extractMs = elapsedMs(extractStart);

  profileEvent({
    type: "symbol-file",
    path: inputRel,
    readMs,
    cstMs,
    parseMs: 0,
    extractMs,
    totalMs: elapsedMs(totalStart),
  });

  return { path: inputRel, dependencies, symbols, references, components, eventHandlers, expressionRefs, wxForScopes, wxForBindings };
}

async function main() {
  const inputFiles = process.argv.slice(2);
  if (inputFiles.length === 0) {
    process.stderr.write("Usage: node scripts/extract-wxml-symbols.mjs <file.wxml> [...file.wxml]\n");
    process.exit(2);
  }

  const totalStart = performance.now();

  await Parser.init();
  const language = await Language.load(WASM);
  const parser = new Parser();
  parser.setLanguage(language);

  const files = [];
  for (const file of inputFiles) {
    files.push(await extractFile(parser, file));
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  profileEvent({
    type: "symbol-total",
    fileCount: inputFiles.length,
    totalMs: elapsedMs(totalStart),
  });

  process.stdout.write(`${JSON.stringify({ version: 1, files }, null, 2)}\n`);
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`FAIL: ${err?.message || err}\n`);
    process.exit(1);
  });
}
