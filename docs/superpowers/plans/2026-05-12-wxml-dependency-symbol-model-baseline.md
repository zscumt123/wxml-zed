# WXML Dependency and Symbol Model Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic pre-LSP WXML dependency and symbol extractor, then verify its JSON output against the real-world fixtures.

**Architecture:** Implement a local Node script that shells out to `tree-sitter-cli parse --cst`, builds a lightweight CST tree from Tree-sitter's output, and slices source text by node ranges to recover attribute values. Keep the model fixture-oriented and syntax-level: no LSP process, no project scan, no `usingComponents` lookup, no diagnostics. Wire the extractor into `scripts/verify-tree-sitter.sh` with parsed JSON assertions.

**Tech Stack:** Node.js standard library, Tree-sitter CLI, Bash verification script, existing WXML grammar, existing real-world fixtures.

---

## File Structure

- Create `scripts/extract-wxml-symbols.mjs`: deterministic JSON extractor for explicit WXML file paths.
- Modify `scripts/verify-tree-sitter.sh`: run the extractor over real-world fixtures and assert the JSON model with Node.
- Modify `README.md`: document the pre-LSP static model and script.
- Review only: `docs/superpowers/specs/2026-05-12-wxml-dependency-symbol-model-baseline-design.md`.

---

### Task 1: Add the Extractor Script

**Files:**
- Create: `scripts/extract-wxml-symbols.mjs`

- [ ] **Step 1: Create `scripts/extract-wxml-symbols.mjs`**

Create `scripts/extract-wxml-symbols.mjs` with this content:

```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
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
  return execFileSync(
    "npx",
    ["tree-sitter-cli", "parse", "--grammar-path", GRAMMAR_DIR, "--cst", filePath],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: process.env.WXML_ZED_HOME || "/private/tmp",
        npm_config_cache: process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache || "/private/tmp/npm-cache",
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
}

function parseCst(cstOutput) {
  const root = { type: "root", children: [], indent: -1 };
  const stack = [root];

  for (const line of cstOutput.split(/\n/)) {
    const match = line.match(/^(\d+):(\d+)\s+-\s+(\d+):(\d+)\s+(\s*)(.+)$/);
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
  for (const child of tagNode.children || []) {
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

function pushDependency(fileModel, filePath, node, lines, kind, value, moduleName) {
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

function pushTemplateReference(fileModel, node, lines, value) {
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
    pushDependency(fileModel, resolved, node, lines, "import", attrs.get("src"));
  }

  for (const node of findAll(tree, "include_statement")) {
    const attrs = attributesFrom(node, lines);
    pushDependency(fileModel, resolved, node, lines, "include", attrs.get("src"));
  }

  for (const node of findAll(tree, "wxs_external")) {
    const tag = findFirst(node, "wxs_external_self_closing_tag");
    const attrs = attributesFrom(tag, lines);
    const moduleName = attrs.get("module");
    pushDependency(fileModel, resolved, node, lines, "wxs", attrs.get("src"), moduleName);
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
    pushTemplateReference(fileModel, node, lines, attrs.get("is"));
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
```

- [ ] **Step 2: Make the script executable**

Run:

```bash
chmod +x scripts/extract-wxml-symbols.mjs
```

Expected: command exits 0.

- [ ] **Step 3: Run the extractor directly**

Run:

```bash
node scripts/extract-wxml-symbols.mjs fixtures/real-world/page.wxml fixtures/real-world/component.wxml fixtures/real-world/templates.wxml >/tmp/wxml-zed-symbols.json
node -e 'JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-symbols.json", "utf8")); console.log("valid json")'
```

Expected: second command prints `valid json`.

- [ ] **Step 4: Inspect key model entries**

Run:

```bash
node -e '
const model = JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-symbols.json", "utf8"));
for (const file of model.files) {
  console.log(file.path);
  console.log("deps", file.dependencies.map((d) => `${d.kind}:${d.module || ""}:${d.value}`).join(","));
  console.log("symbols", file.symbols.map((s) => `${s.kind}:${s.name}`).join(","));
  console.log("refs", file.references.map((r) => `${r.dynamic ? "dynamic" : "static"}:${r.name || r.raw}`).join(","));
  console.log("components", file.components.map((c) => c.tag).join(","));
}
'
```

Expected output includes:

- `import::./templates.wxml`
- `include::./shared/header.wxml`
- `wxs:format:./utils/format.wxs`
- `template:loadingRow`
- `template:compactFooter`
- `template:fullFooter`
- `static:loadingRow`
- one `dynamic:{{useCompact ? 'compactFooter' : 'fullFooter'}}` or equivalent raw dynamic value
- `user-card`, `price-row`, `empty-state`, `loading-spinner`, and `status-badge`

- [ ] **Step 5: Commit extractor**

Run:

```bash
git add scripts/extract-wxml-symbols.mjs
git commit -m "feat: add wxml dependency symbol extractor"
```

Expected: commit succeeds with only `scripts/extract-wxml-symbols.mjs`.

---

### Task 2: Verify Extractor Output in the Main Script

**Files:**
- Modify: `scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Add extractor invocation**

In `scripts/verify-tree-sitter.sh`, after the real-world bracket assertions and before the snippet JSON assertion block, add:

```bash
node "$ROOT_DIR/scripts/extract-wxml-symbols.mjs" "$REAL_WORLD_PAGE" "$REAL_WORLD_COMPONENT" "$REAL_WORLD_TEMPLATES" >/tmp/wxml-zed-symbols.json
```

- [ ] **Step 2: Add parsed JSON assertions**

Immediately after the extractor invocation, add:

```bash
node -e '
const fs = require("fs");
const model = JSON.parse(fs.readFileSync("/tmp/wxml-zed-symbols.json", "utf8"));
if (model.version !== 1) throw new Error(`Unexpected model version: ${model.version}`);

const byPath = new Map(model.files.map((file) => [file.path, file]));
const page = byPath.get("fixtures/real-world/page.wxml");
const component = byPath.get("fixtures/real-world/component.wxml");
const templates = byPath.get("fixtures/real-world/templates.wxml");
if (!page) throw new Error("Missing page.wxml model");
if (!component) throw new Error("Missing component.wxml model");
if (!templates) throw new Error("Missing templates.wxml model");

function hasDependency(file, kind, value, extra = {}) {
  return file.dependencies.some((dep) =>
    dep.kind === kind &&
    dep.value === value &&
    Object.entries(extra).every(([key, expected]) => dep[key] === expected)
  );
}

function hasSymbol(file, kind, name) {
  return file.symbols.some((symbol) => symbol.kind === kind && symbol.name === name);
}

function hasStaticTemplateRef(file, name) {
  return file.references.some((ref) => ref.kind === "template" && ref.dynamic === false && ref.name === name);
}

function hasDynamicTemplateRef(file, text) {
  return file.references.some((ref) => ref.kind === "template" && ref.dynamic === true && ref.raw.includes(text));
}

function componentTags(...files) {
  return new Set(files.flatMap((file) => file.components.map((component) => component.tag)));
}

if (!hasDependency(page, "import", "./templates.wxml", { normalized: "fixtures/real-world/templates.wxml" })) {
  throw new Error("Missing page import dependency");
}
if (!hasDependency(page, "include", "./shared/header.wxml", { normalized: "fixtures/real-world/shared/header.wxml" })) {
  throw new Error("Missing page include dependency");
}
if (!hasDependency(page, "wxs", "./utils/format.wxs", { module: "format", normalized: "fixtures/real-world/utils/format.wxs" })) {
  throw new Error("Missing page wxs dependency");
}

for (const name of ["loadingRow", "compactFooter", "fullFooter"]) {
  if (!hasSymbol(templates, "template", name)) {
    throw new Error(`Missing template symbol: ${name}`);
  }
}

if (!hasStaticTemplateRef(page, "loadingRow")) {
  throw new Error("Missing static loadingRow template reference");
}
if (!hasDynamicTemplateRef(page, "useCompact ?")) {
  throw new Error("Missing dynamic page template reference");
}

const tags = componentTags(page, component, templates);
for (const tag of ["user-card", "price-row", "empty-state", "loading-spinner", "status-badge"]) {
  if (!tags.has(tag)) {
    throw new Error(`Missing component candidate: ${tag}`);
  }
}
for (const builtin of ["view", "text", "button", "image", "scroll-view", "input"]) {
  if (tags.has(builtin)) {
    throw new Error(`Built-in tag leaked into component candidates: ${builtin}`);
  }
}
'
```

- [ ] **Step 3: Run full verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected:

- Script exits 0.
- Output ends with `wxml-zed tree-sitter verification passed`.

- [ ] **Step 4: Commit verification integration**

Run:

```bash
git add scripts/verify-tree-sitter.sh
git commit -m "test: assert wxml dependency symbol model"
```

Expected: commit succeeds with only `scripts/verify-tree-sitter.sh`.

---

### Task 3: Document the Pre-LSP Static Model

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the features table**

In `README.md`, add this row after `Tree-sitter parse/query verification script`:

```md
| Pre-LSP dependency and symbol model extractor | Yes |
```

- [ ] **Step 2: Update the verification paragraph**

In `README.md`, replace:

```md
the highlight, outline, text object, injection, and bracket queries, checks the
focused WXS, tag-editing, and real-world compatibility fixtures, and asserts
baseline snippet keys.
```

with:

```md
the highlight, outline, text object, injection, and bracket queries, checks the
focused WXS, tag-editing, and real-world compatibility fixtures, validates the
pre-LSP dependency/symbol model, and asserts baseline snippet keys.
```

- [ ] **Step 3: Add model scope paragraph**

In the `Scope` section, after the `fixtures/real-world/` paragraph, add:

```md
`scripts/extract-wxml-symbols.mjs` emits a deterministic JSON model for static
WXML dependencies, template symbols, template references, WXS modules, and
custom component candidates. It does not validate file existence, read
`usingComponents`, resolve dynamic template expressions, or provide LSP
behavior.
```

- [ ] **Step 4: Update project layout**

In `Project Layout`, add:

```md
- `scripts/extract-wxml-symbols.mjs`: pre-LSP static dependency/symbol extractor.
```

- [ ] **Step 5: Run README wording check**

Run:

```bash
rg -n 'dependency|symbol|extract-wxml-symbols|pre-LSP|usingComponents|LSP' README.md
```

Expected: output includes the features row, verification paragraph, scope paragraph, and project layout row.

- [ ] **Step 6: Commit README update**

Run:

```bash
git add README.md
git commit -m "docs: document wxml dependency symbol model"
```

Expected: commit succeeds with only `README.md`.

---

### Task 4: Final Verification and Review Gate

**Files:**
- Review: all files changed since `main`

- [ ] **Step 1: Run focused extractor verification**

Run:

```bash
node scripts/extract-wxml-symbols.mjs fixtures/real-world/page.wxml fixtures/real-world/component.wxml fixtures/real-world/templates.wxml >/tmp/wxml-zed-symbols.json
node -e 'const model = JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-symbols.json", "utf8")); console.log(model.files.length)'
```

Expected: second command prints `3`.

- [ ] **Step 2: Run full project verification**

Run:

```bash
scripts/verify-tree-sitter.sh
git diff --check main..HEAD
git status --short --branch
```

Expected:

- Verification exits 0 and prints `wxml-zed tree-sitter verification passed`.
- `git diff --check main..HEAD` exits 0.
- `git status --short --branch` shows a clean worktree on `dependency-symbol-baseline-design`.

- [ ] **Step 3: Inspect branch diff**

Run:

```bash
git diff --stat main..HEAD
git diff --name-only main..HEAD
```

Expected changed files:

- `docs/superpowers/plans/2026-05-12-wxml-dependency-symbol-model-baseline.md`
- `docs/superpowers/specs/2026-05-12-wxml-dependency-symbol-model-baseline-design.md`
- `scripts/extract-wxml-symbols.mjs`
- `scripts/verify-tree-sitter.sh`
- `README.md`

- [ ] **Step 4: Request review**

Ask for review with this summary:

```text
Review request: WXML dependency and symbol model baseline.

Requirements:
- Adds scripts/extract-wxml-symbols.mjs as a deterministic pre-LSP JSON extractor.
- Extracts import/include/WXS dependencies, template and WXS symbols, template references, and custom component candidates.
- Uses Tree-sitter CLI output and existing fixtures; no LSP, no usingComponents resolution, no diagnostics.
- Integrates parsed JSON assertions into scripts/verify-tree-sitter.sh.
- Updates README boundaries.

Verification:
- node scripts/extract-wxml-symbols.mjs fixtures/real-world/page.wxml fixtures/real-world/component.wxml fixtures/real-world/templates.wxml
- scripts/verify-tree-sitter.sh
- git diff --check main..HEAD
```

- [ ] **Step 5: Fix review findings before merge**

For each review finding:

1. Confirm it is technically valid against the current code.
2. Make the smallest scoped fix.
3. Run `scripts/verify-tree-sitter.sh`.
4. Commit the fix with a specific message.

Expected: no known Important or Critical review findings remain before merge.
