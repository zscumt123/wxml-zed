#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAMMAR_DIR = path.join(ROOT, "grammar/tree-sitter-wxml");

const BUILTIN_TAGS = new Set([
  "view", "scroll-view", "swiper", "swiper-item", "movable-area", "movable-view",
  "cover-view", "cover-image", "match-media", "page-container", "root-portal",
  "share-element", "text", "rich-text", "icon", "progress", "button", "checkbox",
  "checkbox-group", "editor", "form", "input", "label", "picker", "picker-view",
  "picker-view-column", "radio", "radio-group", "slider", "switch", "textarea",
  "keyboard-accessory", "navigator", "functional-page-navigator", "audio", "image",
  "video", "camera", "live-player", "live-pusher", "voip-room", "map", "canvas",
  "open-data", "web-view", "ad", "ad-custom", "official-account", "open-container",
  "page-meta", "navigation-bar", "custom-wrapper",
]);

const CONTROL_TAGS = new Set(["template", "wxs", "import", "include", "slot", "block"]);

function toPosix(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

function relativePath(filePath) {
  return toPosix(path.relative(ROOT, path.resolve(filePath)));
}

function normalizeDependency(filePath, value) {
  if (!value || value.includes("{{") || !/^\.\.?\//.test(value)) {
    return undefined;
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(relativePath(filePath)), value));
}

function rangeFrom(node) {
  return {
    start: { row: node.srow, column: node.scol },
    end: { row: node.erow, column: node.ecol },
  };
}

function readSourceLines(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\n/);
}

function sliceRange(lines, node) {
  if (node.srow === node.erow) {
    return lines[node.srow].slice(node.scol, node.ecol);
  }
  const chunks = [lines[node.srow].slice(node.scol)];
  for (let row = node.srow + 1; row < node.erow; row += 1) {
    chunks.push(lines[row]);
  }
  chunks.push(lines[node.erow].slice(0, node.ecol));
  return chunks.join("\n");
}

function stripQuoted(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function runTreeSitterCst(filePath) {
  const toolHome = process.env.WXML_ZED_HOME || "/private/tmp";
  const npmCache = process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache || "/private/tmp/npm-cache";
  fs.mkdirSync(path.join(toolHome, ".cache/tree-sitter/lock"), { recursive: true });
  fs.mkdirSync(npmCache, { recursive: true });

  return execFileSync(
    "npx",
    ["tree-sitter-cli", "parse", "--grammar-path", GRAMMAR_DIR, "--cst", filePath],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: toolHome,
        npm_config_cache: npmCache,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
}

function parseCst(cstOutput) {
  const root = { type: "root", children: [], indent: -1 };
  const stack = [root];

  for (const line of cstOutput.split(/\n/)) {
    const match = line.match(/^(\d+):(\d+)\s+-\s+(\d+):(\d+)(\s+)(.+)$/);
    if (!match) continue;

    const [, srow, scol, erow, ecol, spaces, rest] = match;
    const typeMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!typeMatch) continue;

    const textMatch = rest.match(/`([^`]*)`$/);
    const node = {
      type: typeMatch[1],
      text: textMatch ? textMatch[1] : undefined,
      srow: Number(srow),
      scol: Number(scol),
      erow: Number(erow),
      ecol: Number(ecol),
      indent: spaces.length,
      children: [],
    };

    while (stack[stack.length - 1].indent >= node.indent) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  return root.children[0];
}

function findAll(node, type, results = []) {
  if (!node) return results;
  if (node.type === type) results.push(node);
  for (const child of node.children || []) {
    findAll(child, type, results);
  }
  return results;
}

function findFirst(node, type) {
  if (!node) return undefined;
  if (node.type === type) return node;
  for (const child of node.children || []) {
    const found = findFirst(child, type);
    if (found) return found;
  }
  return undefined;
}

function directChild(node, type) {
  return (node.children || []).find((child) => child.type === type);
}

function attributeName(node) {
  return findFirst(node, "attribute_name")?.text;
}

function attributeValue(node, lines) {
  const valueNode = findFirst(node, "quoted_attribute_value") || findFirst(node, "attribute_value");
  if (!valueNode) return undefined;
  return stripQuoted(sliceRange(lines, valueNode));
}

function attributesFrom(tagNode, lines) {
  const attrs = new Map();
  for (const child of tagNode?.children || []) {
    if (
      child.type === "attribute" ||
      child.type === "template_name_attribute" ||
      child.type === "template_is_attribute" ||
      child.type === "wxs_module_attribute" ||
      child.type === "wxs_src_attribute"
    ) {
      const name = attributeName(child);
      if (name) attrs.set(name, attributeValue(child, lines));
    }
  }
  return attrs;
}

function tagNameFrom(tagNode) {
  return findFirst(tagNode, "tag_name")?.text;
}

function pushDependency(fileModel, filePath, node, kind, value, moduleName) {
  if (!value) return;
  const entry = {
    kind,
    value,
    range: rangeFrom(node),
  };
  const normalized = normalizeDependency(filePath, value);
  if (normalized) entry.normalized = normalized;
  if (moduleName) entry.module = moduleName;
  fileModel.dependencies.push(entry);
}

function pushSymbol(fileModel, node, kind, name) {
  if (!name) return;
  fileModel.symbols.push({
    kind,
    name,
    range: rangeFrom(node),
  });
}

function pushTemplateReference(fileModel, node, value) {
  if (!value) return;
  const dynamic = value.includes("{{");
  const entry = {
    kind: "template",
    dynamic,
    raw: value,
    range: rangeFrom(node),
  };
  if (!dynamic) entry.name = value;
  fileModel.references.push(entry);
}

function pushComponentCandidate(fileModel, node) {
  const tagNode = findFirst(node, "tag_name");
  const tag = tagNode?.text;
  if (!tag) return;
  if (!tag.includes("-")) return;
  if (BUILTIN_TAGS.has(tag) || CONTROL_TAGS.has(tag)) return;
  fileModel.components.push({
    tag,
    range: rangeFrom(node),
  });
}

function extractFile(filePath) {
  const resolved = path.resolve(filePath);
  const lines = readSourceLines(resolved);
  const tree = parseCst(runTreeSitterCst(resolved));
  const fileModel = {
    path: relativePath(resolved),
    dependencies: [],
    symbols: [],
    references: [],
    components: [],
  };

  for (const node of findAll(tree, "import_statement")) {
    const attrs = attributesFrom(node, lines);
    pushDependency(fileModel, resolved, node, "import", attrs.get("src"));
  }

  for (const node of findAll(tree, "include_statement")) {
    const attrs = attributesFrom(node, lines);
    pushDependency(fileModel, resolved, node, "include", attrs.get("src"));
  }

  for (const node of findAll(tree, "wxs_external")) {
    const tag = findFirst(node, "wxs_external_self_closing_tag");
    const attrs = attributesFrom(tag, lines);
    const moduleName = attrs.get("module");
    pushDependency(fileModel, resolved, node, "wxs", attrs.get("src"), moduleName);
    pushSymbol(fileModel, node, "wxs", moduleName);
  }

  for (const node of findAll(tree, "wxs_inline")) {
    const tag = findFirst(node, "wxs_inline_start_tag");
    const attrs = attributesFrom(tag, lines);
    pushSymbol(fileModel, node, "wxs", attrs.get("module"));
  }

  for (const node of findAll(tree, "template_definition")) {
    const tag = findFirst(node, "template_definition_start_tag");
    const attrs = attributesFrom(tag, lines);
    pushSymbol(fileModel, node, "template", attrs.get("name"));
  }

  for (const node of findAll(tree, "template_usage")) {
    const tag = findFirst(node, "template_usage_start_tag") || findFirst(node, "template_usage_self_closing_tag");
    const attrs = attributesFrom(tag, lines);
    pushTemplateReference(fileModel, node, attrs.get("is"));
  }

  for (const node of findAll(tree, "element")) {
    const tag = directChild(node, "start_tag") || directChild(node, "self_closing_tag");
    if (tagNameFrom(tag)) pushComponentCandidate(fileModel, node);
  }

  return fileModel;
}

function sortModel(model) {
  for (const file of model.files) {
    file.dependencies.sort((a, b) => a.range.start.row - b.range.start.row || a.range.start.column - b.range.start.column);
    file.symbols.sort((a, b) => a.range.start.row - b.range.start.row || a.range.start.column - b.range.start.column);
    file.references.sort((a, b) => a.range.start.row - b.range.start.row || a.range.start.column - b.range.start.column);
    file.components.sort((a, b) => a.range.start.row - b.range.start.row || a.range.start.column - b.range.start.column);
  }
  model.files.sort((a, b) => a.path.localeCompare(b.path));
  return model;
}

const inputFiles = process.argv.slice(2);
if (inputFiles.length === 0) {
  console.error("Usage: node scripts/extract-wxml-symbols.mjs <file.wxml> [...file.wxml]");
  process.exit(2);
}

const model = sortModel({
  version: 1,
  files: inputFiles.map(extractFile),
});

process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
