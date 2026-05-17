#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { Parser, Language } from "web-tree-sitter";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(ROOT, "grammar/tree-sitter-javascript/tree-sitter-javascript.wasm");

const FUNCTION_VALUE_TYPES = new Set(["function_expression", "arrow_function"]);
const FACTORY_NAMES = new Set(["Page", "Component"]);

function toPosix(p) {
  return p.split(path.sep).join(path.posix.sep);
}

function relativePathFromRoot(filePath) {
  return toPosix(path.relative(ROOT, path.resolve(filePath)));
}

function rangeOf(node) {
  return {
    start: { row: node.startPosition.row, column: node.startPosition.column },
    end: { row: node.endPosition.row, column: node.endPosition.column },
  };
}

function firstChildOfType(node, type) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === type) return c;
  }
  return null;
}

function fieldChild(node, fieldName) {
  return node.childForFieldName ? node.childForFieldName(fieldName) : null;
}

function isPageOrComponentCall(callNode) {
  const fn = fieldChild(callNode, "function");
  if (!fn || fn.type !== "identifier") return null;
  if (!FACTORY_NAMES.has(fn.text)) return null;
  return fn.text;
}

function optionsObject(callNode) {
  const args = fieldChild(callNode, "arguments");
  if (!args) return null;
  const first = args.namedChild(0);
  if (!first || first.type !== "object") return null;
  return first;
}

function methodEntriesFromObject(objectNode, kind) {
  const out = [];
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (child.type === "method_definition") {
      const nameNode = firstChildOfType(child, "property_identifier");
      if (!nameNode) continue;
      out.push({ name: nameNode.text, kind, range: rangeOf(child) });
    } else if (child.type === "pair") {
      const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
      if (!keyNode || keyNode.type !== "property_identifier") continue;
      const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
      if (!valueNode || !FUNCTION_VALUE_TYPES.has(valueNode.type)) continue;
      out.push({ name: keyNode.text, kind, range: rangeOf(child) });
    }
  }
  return out;
}

function methodsBlockOf(objectNode) {
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (child.type !== "pair") continue;
    const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
    if (!keyNode || keyNode.type !== "property_identifier" || keyNode.text !== "methods") continue;
    const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
    if (valueNode && valueNode.type === "object") return valueNode;
  }
  return null;
}

function collectFile(tree) {
  const out = [];
  const visit = (node) => {
    if (node.type === "call_expression") {
      const factory = isPageOrComponentCall(node);
      if (factory) {
        const opts = optionsObject(node);
        if (opts) {
          if (factory === "Page") {
            out.push(...methodEntriesFromObject(opts, "page-method"));
          } else {
            out.push(...methodEntriesFromObject(opts, "component-lifecycle"));
            const methodsBlock = methodsBlockOf(opts);
            if (methodsBlock) {
              out.push(...methodEntriesFromObject(methodsBlock, "component-method"));
            }
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
  };
  visit(tree.rootNode);
  out.sort((a, b) => {
    const ar = a.range.start, br = b.range.start;
    return (ar.row - br.row) || (ar.column - br.column);
  });
  return out;
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
    const tree = parser.parse(source);
    const methods = collectFile(tree);
    files.push({ path: inputRel, methods });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  process.stdout.write(`${JSON.stringify({ version: 1, files }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${err?.message || err}\n`);
  process.exit(1);
});
