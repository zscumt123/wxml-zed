# WXML Project Graph Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic pre-LSP WXML project graph extractor for a fixture mini program project.

**Architecture:** Keep WXML parsing delegated to `scripts/extract-wxml-symbols.mjs`. Add a project-level script that reads `app.json`, page/component JSON files, resolves local relative `usingComponents`, traverses component configs, queues WXML `import`/`include` dependencies to closure, and emits stable JSON. Verification stays in `scripts/verify-tree-sitter.sh` with fixture-level assertions.

**Tech Stack:** Node.js standard library, existing Tree-sitter CLI-backed WXML extractor, Bash verification script, JSON fixtures.

---

## File Structure

- Create `fixtures/miniprogram/`: small mini program fixture with app config, page configs, component configs, WXML files, shared template/header files, and WXS dependency target.
- Create `scripts/extract-wxml-project-graph.mjs`: project graph extractor for one explicit project root.
- Modify `scripts/verify-tree-sitter.sh`: run project graph extraction and assert the JSON contract.
- Modify `README.md`: document the project graph script and pre-LSP boundary.
- Review only: `docs/superpowers/specs/2026-05-12-wxml-project-graph-baseline-design.md`.

---

### Task 1: Add Mini Program Fixture

**Files:**
- Create: `fixtures/miniprogram/app.json`
- Create: `fixtures/miniprogram/pages/home/home.json`
- Create: `fixtures/miniprogram/pages/home/home.wxml`
- Create: `fixtures/miniprogram/pages/detail/detail.json`
- Create: `fixtures/miniprogram/pages/detail/detail.wxml`
- Create: `fixtures/miniprogram/components/user-card/user-card.json`
- Create: `fixtures/miniprogram/components/user-card/user-card.wxml`
- Create: `fixtures/miniprogram/components/status-badge/status-badge.json`
- Create: `fixtures/miniprogram/components/status-badge/status-badge.wxml`
- Create: `fixtures/miniprogram/shared/header.wxml`
- Create: `fixtures/miniprogram/templates/common.wxml`
- Create: `fixtures/miniprogram/utils/format.wxs`

- [ ] **Step 1: Create fixture directories**

Run:

```bash
mkdir -p \
  fixtures/miniprogram/pages/home \
  fixtures/miniprogram/pages/detail \
  fixtures/miniprogram/components/user-card \
  fixtures/miniprogram/components/status-badge \
  fixtures/miniprogram/shared \
  fixtures/miniprogram/templates \
  fixtures/miniprogram/utils
```

Expected: command exits with status 0.

- [ ] **Step 2: Add `app.json`**

Create `fixtures/miniprogram/app.json`:

```json
{
  "pages": [
    "pages/home/home",
    "pages/detail/detail"
  ],
  "window": {
    "navigationBarTitleText": "WXML Fixture"
  }
}
```

- [ ] **Step 3: Add home page JSON config**

Create `fixtures/miniprogram/pages/home/home.json`:

```json
{
  "usingComponents": {
    "user-card": "../../components/user-card/user-card",
    "missing-card": "../../components/missing-card/missing-card"
  }
}
```

- [ ] **Step 4: Add home page WXML**

Create `fixtures/miniprogram/pages/home/home.wxml`:

```xml
<import src="../../templates/common.wxml" />
<include src="../../shared/header.wxml" />
<wxs module="format" src="../../utils/format.wxs" />

<view class="home {{theme}}">
  <template is="loadingRow" data="{{message: 'Loading users'}}" />

  <user-card
    wx:for="{{users}}"
    wx:key="id"
    user="{{item}}"
    bind:select="handleSelect"
  />

  <missing-card reason="{{emptyReason}}" />

  <view class="total">
    {{format.price(total)}}
  </view>
</view>
```

- [ ] **Step 5: Add detail page JSON config**

Create `fixtures/miniprogram/pages/detail/detail.json`:

```json
{
  "usingComponents": {}
}
```

- [ ] **Step 6: Add detail page WXML**

Create `fixtures/miniprogram/pages/detail/detail.wxml`:

```xml
<view class="detail">
  <text>{{title}}</text>
</view>
```

- [ ] **Step 7: Add user-card component JSON config**

Create `fixtures/miniprogram/components/user-card/user-card.json`:

```json
{
  "component": true,
  "usingComponents": {
    "status-badge": "../status-badge/status-badge"
  }
}
```

- [ ] **Step 8: Add user-card component WXML**

Create `fixtures/miniprogram/components/user-card/user-card.wxml`:

```xml
<view class="user-card {{user.active ? 'active' : ''}}">
  <text class="name">{{user.name}}</text>
  <status-badge status="{{user.status}}" />
  <slot name="extra"></slot>
</view>
```

- [ ] **Step 9: Add status-badge component JSON config**

Create `fixtures/miniprogram/components/status-badge/status-badge.json`:

```json
{
  "component": true,
  "usingComponents": {}
}
```

- [ ] **Step 10: Add status-badge component WXML**

Create `fixtures/miniprogram/components/status-badge/status-badge.wxml`:

```xml
<view class="status status-{{status}}">
  <text>{{status}}</text>
</view>
```

- [ ] **Step 11: Add shared header WXML**

Create `fixtures/miniprogram/shared/header.wxml`:

```xml
<view class="header">
  <text>{{title}}</text>
</view>
```

- [ ] **Step 12: Add common template WXML**

Create `fixtures/miniprogram/templates/common.wxml`:

```xml
<template name="loadingRow">
  <view class="loading-row">
    <text>{{message}}</text>
  </view>
</template>
```

- [ ] **Step 13: Add WXS dependency file**

Create `fixtures/miniprogram/utils/format.wxs`:

```js
function price(value) {
  return "$" + value;
}

module.exports = {
  price: price
};
```

- [ ] **Step 14: Run existing WXML verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exits 0 and prints:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 15: Commit fixture**

Run:

```bash
git add fixtures/miniprogram
git commit -m "test: add mini program project graph fixture"
```

Expected: commit succeeds and includes only files under `fixtures/miniprogram/`.

---

### Task 2: Add Project Graph Extractor

**Files:**
- Create: `scripts/extract-wxml-project-graph.mjs`

- [ ] **Step 1: Create `scripts/extract-wxml-project-graph.mjs`**

Create `scripts/extract-wxml-project-graph.mjs` with this implementation:

```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYMBOL_EXTRACTOR = path.join(ROOT, "scripts/extract-wxml-symbols.mjs");

function toPosix(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

function repoRelative(filePath) {
  return toPosix(path.relative(ROOT, path.resolve(filePath)));
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function withoutKnownExtension(value) {
  return value.replace(/\.(wxml|json)$/u, "");
}

function derivedPaths(ownerJsonPath, value) {
  const base = path.resolve(path.dirname(ownerJsonPath), withoutKnownExtension(value));
  return {
    base,
    wxml: `${base}.wxml`,
    json: `${base}.json`,
  };
}

function addUniquePath(queue, queued, filePath) {
  const resolved = path.resolve(filePath);
  if (queued.has(resolved)) return;
  queued.add(resolved);
  queue.push(resolved);
}

function sortByPath(items) {
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

function runSymbolExtractor(files) {
  if (files.length === 0) {
    return { version: 1, files: [] };
  }

  const output = execFileSync(
    "node",
    [SYMBOL_EXTRACTOR, ...files],
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

  return JSON.parse(output);
}

function createUnresolved(kind, data) {
  return { kind, ...data };
}

function resolveUsingComponent(projectRoot, ownerJsonPath, ownerWxmlPath, tag, value) {
  if (!value.startsWith("./") && !value.startsWith("../")) {
    return {
      owner: repoRelative(ownerWxmlPath),
      tag,
      value,
      resolved: false,
      reason: "unsupported",
    };
  }

  const paths = derivedPaths(ownerJsonPath, value);
  const entry = {
    owner: repoRelative(ownerWxmlPath),
    tag,
    value,
    target: repoRelative(paths.wxml),
    config: repoRelative(paths.json),
    resolved: true,
  };

  if (!isInside(projectRoot, paths.wxml) || !isInside(projectRoot, paths.json)) {
    return {
      ...entry,
      resolved: false,
      reason: "outside-root",
    };
  }

  if (!fs.existsSync(paths.wxml)) {
    return {
      ...entry,
      resolved: false,
      reason: "missing-file",
    };
  }

  if (!fs.existsSync(paths.json)) {
    delete entry.config;
  }

  return entry;
}

function pushConfig(configs, pathValue, kind, owner) {
  const entry = {
    path: repoRelative(pathValue),
    kind,
  };
  if (owner) entry.owner = repoRelative(owner);
  configs.push(entry);
}

function readUsingComponents(config) {
  const value = config?.usingComponents;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function extractProject(projectRootInput) {
  const projectRoot = path.resolve(projectRootInput);
  const appJsonPath = path.join(projectRoot, "app.json");
  const appJson = readJsonIfExists(appJsonPath);
  if (!appJson) {
    throw new Error(`Missing app.json: ${repoRelative(appJsonPath)}`);
  }

  const graph = {
    version: 1,
    root: repoRelative(projectRoot),
    pages: [],
    configs: [],
    wxml: [],
    usingComponents: [],
    unresolved: [],
  };

  pushConfig(graph.configs, appJsonPath, "app");

  const componentQueue = [];
  const visitedConfigs = new Set();
  const wxmlQueue = [];
  const queuedWxml = new Set();
  const parsedWxml = new Set();
  const wxmlByPath = new Map();

  function queueConfig(jsonPath, wxmlPath, kind) {
    const resolvedJson = path.resolve(jsonPath);
    if (visitedConfigs.has(resolvedJson)) return;
    visitedConfigs.add(resolvedJson);
    componentQueue.push({ jsonPath: resolvedJson, wxmlPath: path.resolve(wxmlPath), kind });
  }

  function readOwnerConfig(jsonPath, wxmlPath, kind) {
    const config = readJsonIfExists(jsonPath);
    if (!config) return;
    pushConfig(graph.configs, jsonPath, kind, kind === "app" ? undefined : wxmlPath);

    for (const [tag, value] of Object.entries(readUsingComponents(config))) {
      const entry = resolveUsingComponent(projectRoot, jsonPath, wxmlPath, tag, String(value));
      graph.usingComponents.push(entry);

      if (!entry.resolved) {
        graph.unresolved.push(createUnresolved("component", {
          owner: entry.owner,
          tag,
          value: entry.value,
          target: entry.target,
          reason: entry.reason,
        }));
        continue;
      }

      addUniquePath(wxmlQueue, queuedWxml, path.resolve(ROOT, entry.target));
      if (entry.config) {
        queueConfig(path.resolve(ROOT, entry.config), path.resolve(ROOT, entry.target), "component");
      }
    }
  }

  const pages = Array.isArray(appJson.pages) ? appJson.pages : [];
  for (const pageName of pages) {
    const pageBase = path.join(projectRoot, pageName);
    const pageJsonPath = `${pageBase}.json`;
    const pageWxmlPath = `${pageBase}.wxml`;
    graph.pages.push({
      name: pageName,
      json: repoRelative(pageJsonPath),
      wxml: repoRelative(pageWxmlPath),
    });

    if (!fs.existsSync(pageJsonPath) || !fs.existsSync(pageWxmlPath)) {
      graph.unresolved.push(createUnresolved("page", {
        name: pageName,
        json: repoRelative(pageJsonPath),
        wxml: repoRelative(pageWxmlPath),
        reason: "missing-file",
      }));
    }

    if (fs.existsSync(pageWxmlPath)) {
      addUniquePath(wxmlQueue, queuedWxml, pageWxmlPath);
    }
    queueConfig(pageJsonPath, pageWxmlPath, "page");
  }

  while (componentQueue.length > 0) {
    const item = componentQueue.shift();
    readOwnerConfig(item.jsonPath, item.wxmlPath, item.kind);
  }

  while (wxmlQueue.length > 0) {
    const currentBatch = wxmlQueue.splice(0).filter((filePath) => {
      if (parsedWxml.has(filePath)) return false;
      parsedWxml.add(filePath);
      return fs.existsSync(filePath);
    });

    const symbolModel = runSymbolExtractor(currentBatch);
    for (const fileModel of symbolModel.files) {
      wxmlByPath.set(fileModel.path, fileModel);
      for (const dependency of fileModel.dependencies) {
        if (!dependency.normalized || !dependency.normalized.endsWith(".wxml")) continue;

        const dependencyPath = path.resolve(ROOT, dependency.normalized);
        if (!isInside(projectRoot, dependencyPath)) {
          graph.unresolved.push(createUnresolved("wxml-dependency", {
            owner: fileModel.path,
            value: dependency.value,
            target: dependency.normalized,
            reason: "outside-root",
          }));
          continue;
        }

        if (!fs.existsSync(dependencyPath)) {
          graph.unresolved.push(createUnresolved("wxml-dependency", {
            owner: fileModel.path,
            value: dependency.value,
            target: dependency.normalized,
            reason: "missing-file",
          }));
          continue;
        }

        addUniquePath(wxmlQueue, queuedWxml, dependencyPath);
      }
    }
  }

  graph.configs = sortByPath(graph.configs);
  graph.usingComponents.sort((a, b) => (
    a.owner.localeCompare(b.owner) ||
    a.tag.localeCompare(b.tag) ||
    a.value.localeCompare(b.value)
  ));
  graph.unresolved.sort((a, b) => (
    a.kind.localeCompare(b.kind) ||
    (a.owner || "").localeCompare(b.owner || "") ||
    (a.tag || a.name || "").localeCompare(b.tag || b.name || "") ||
    (a.value || "").localeCompare(b.value || "")
  ));
  graph.wxml = sortByPath([...wxmlByPath.values()]);

  return graph;
}

const [projectRoot] = process.argv.slice(2);
if (!projectRoot) {
  console.error("Usage: node scripts/extract-wxml-project-graph.mjs <project-root>");
  process.exit(2);
}

const graph = extractProject(projectRoot);
process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
```

- [ ] **Step 2: Make the script executable**

Run:

```bash
chmod +x scripts/extract-wxml-project-graph.mjs
```

Expected: command exits with status 0.

- [ ] **Step 3: Run project graph extraction**

Run:

```bash
node scripts/extract-wxml-project-graph.mjs fixtures/miniprogram >/tmp/wxml-zed-project-graph.json
```

Expected: exits 0. Tree-sitter warnings may appear on stderr; `/tmp/wxml-zed-project-graph.json` contains only JSON.

- [ ] **Step 4: Verify JSON parses and has core counts**

Run:

```bash
node -e 'const graph = JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-project-graph.json", "utf8")); console.log(`${graph.pages.length}/${graph.configs.length}/${graph.usingComponents.length}/${graph.wxml.length}/${graph.unresolved.length}`)'
```

Expected output:

```text
2/5/3/6/1
```

- [ ] **Step 5: Verify graph paths**

Run:

```bash
node -e 'const graph = JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-project-graph.json", "utf8")); console.log(graph.wxml.map((entry) => entry.path).join("\n"))'
```

Expected output includes these lines:

```text
fixtures/miniprogram/components/status-badge/status-badge.wxml
fixtures/miniprogram/components/user-card/user-card.wxml
fixtures/miniprogram/pages/detail/detail.wxml
fixtures/miniprogram/pages/home/home.wxml
fixtures/miniprogram/shared/header.wxml
fixtures/miniprogram/templates/common.wxml
```

- [ ] **Step 6: Commit extractor**

Run:

```bash
git add scripts/extract-wxml-project-graph.mjs
git commit -m "feat: add wxml project graph extractor"
```

Expected: commit succeeds and includes only `scripts/extract-wxml-project-graph.mjs`.

---

### Task 3: Add Verification Assertions

**Files:**
- Modify: `scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Add project graph temp path**

In `scripts/verify-tree-sitter.sh`, add this variable next to `SYMBOL_MODEL`:

```bash
PROJECT_GRAPH="/tmp/wxml-zed-project-graph.json"
MINIPROGRAM_DIR="$ROOT_DIR/fixtures/miniprogram"
```

- [ ] **Step 2: Add project graph extraction and assertions**

Insert this block after the existing symbol model assertion block and before the snippet assertion block:

```bash
node "$ROOT_DIR/scripts/extract-wxml-project-graph.mjs" "$MINIPROGRAM_DIR" >"$PROJECT_GRAPH"
node -e '
const fs = require("fs");
const graph = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hasPage(name) {
  return graph.pages.some((page) => page.name === name);
}

function hasConfig(path, kind) {
  return graph.configs.some((config) => config.path === path && config.kind === kind);
}

function hasResolvedComponent(owner, tag, target) {
  return graph.usingComponents.some((component) => (
    component.owner === owner &&
    component.tag === tag &&
    component.target === target &&
    component.resolved === true
  ));
}

function hasUnresolvedComponent(owner, tag, reason) {
  return graph.unresolved.some((entry) => (
    entry.kind === "component" &&
    entry.owner === owner &&
    entry.tag === tag &&
    entry.reason === reason
  ));
}

function wxml(path) {
  const entry = graph.wxml.find((file) => file.path === path);
  assert(entry, `Missing WXML graph entry: ${path}`);
  return entry;
}

function hasDependency(file, kind, normalized) {
  return file.dependencies.some((dependency) => dependency.kind === kind && dependency.normalized === normalized);
}

assert(graph.version === 1, "Unexpected project graph version");
assert(graph.root === "fixtures/miniprogram", "Unexpected project graph root");
assert(hasPage("pages/home/home"), "Missing home page");
assert(hasPage("pages/detail/detail"), "Missing detail page");

assert(hasConfig("fixtures/miniprogram/app.json", "app"), "Missing app config");
assert(hasConfig("fixtures/miniprogram/pages/home/home.json", "page"), "Missing home page config");
assert(hasConfig("fixtures/miniprogram/pages/detail/detail.json", "page"), "Missing detail page config");
assert(hasConfig("fixtures/miniprogram/components/user-card/user-card.json", "component"), "Missing user-card config");
assert(hasConfig("fixtures/miniprogram/components/status-badge/status-badge.json", "component"), "Missing status-badge config");

assert(hasResolvedComponent(
  "fixtures/miniprogram/pages/home/home.wxml",
  "user-card",
  "fixtures/miniprogram/components/user-card/user-card.wxml",
), "Missing resolved user-card component");
assert(hasResolvedComponent(
  "fixtures/miniprogram/components/user-card/user-card.wxml",
  "status-badge",
  "fixtures/miniprogram/components/status-badge/status-badge.wxml",
), "Missing resolved status-badge component");
assert(hasUnresolvedComponent(
  "fixtures/miniprogram/pages/home/home.wxml",
  "missing-card",
  "missing-file",
), "Missing unresolved missing-card component");

const home = wxml("fixtures/miniprogram/pages/home/home.wxml");
wxml("fixtures/miniprogram/pages/detail/detail.wxml");
wxml("fixtures/miniprogram/components/user-card/user-card.wxml");
wxml("fixtures/miniprogram/components/status-badge/status-badge.wxml");
wxml("fixtures/miniprogram/shared/header.wxml");
wxml("fixtures/miniprogram/templates/common.wxml");

assert(hasDependency(home, "import", "fixtures/miniprogram/templates/common.wxml"), "Missing common template import dependency");
assert(hasDependency(home, "include", "fixtures/miniprogram/shared/header.wxml"), "Missing shared header include dependency");
assert(hasDependency(home, "wxs", "fixtures/miniprogram/utils/format.wxs"), "Missing format wxs dependency");
assert(home.references.some((reference) => reference.kind === "template" && reference.name === "loadingRow"), "Missing loadingRow template reference");
assert(home.components.some((component) => component.tag === "user-card"), "Missing user-card component candidate");
for (const tag of ["view", "text"]) {
  assert(!home.components.some((component) => component.tag === tag), `Builtin tag leaked into project graph component candidates: ${tag}`);
}
' "$PROJECT_GRAPH"
```

- [ ] **Step 3: Run full verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exits 0 and prints:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 4: Commit verification**

Run:

```bash
git add scripts/verify-tree-sitter.sh
git commit -m "test: assert wxml project graph model"
```

Expected: commit succeeds and includes only `scripts/verify-tree-sitter.sh`.

---

### Task 4: Document Project Graph Boundary

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update feature matrix**

In `README.md`, add this row after `Pre-LSP dependency and symbol model extractor`:

```md
| Pre-LSP project graph extractor for local mini program fixtures | Yes |
```

- [ ] **Step 2: Update verification description**

Update the verification paragraph so it says the script asserts the project graph model:

```md
The script parses `fixtures/test.wxml`, runs the grammar corpus tests, validates
the highlight, outline, text object, injection, and bracket queries, checks the
focused WXS, tag-editing, and real-world compatibility fixtures, and asserts
baseline snippet keys plus the pre-LSP dependency, symbol, and project graph
models.
```

- [ ] **Step 3: Add project graph scope paragraph**

Add this paragraph after the existing `scripts/extract-wxml-symbols.mjs` scope paragraph:

```md
`scripts/extract-wxml-project-graph.mjs` emits a deterministic JSON graph for a
single mini program project root. It reads `app.json`, page and component JSON
files, local relative `usingComponents`, and the existing WXML symbol model. It
does not resolve npm components, plugin components, `subPackages`, diagnostics,
watch mode, LSP behavior, or editor navigation.
```

- [ ] **Step 4: Update project layout**

Add this bullet next to the existing script bullets:

```md
- `scripts/extract-wxml-project-graph.mjs`: pre-LSP mini program project graph extractor.
```

- [ ] **Step 5: Check README references**

Run:

```bash
rg -n 'project graph|extract-wxml-project-graph|pre-LSP|usingComponents|subPackages|LSP' README.md
```

Expected output includes references to the feature matrix, verification paragraph, scope paragraph, and project layout bullet.

- [ ] **Step 6: Commit README**

Run:

```bash
git add README.md
git commit -m "docs: document wxml project graph model"
```

Expected: commit succeeds and includes only `README.md`.

---

### Task 5: Final Verification and Review Gate

**Files:**
- Review: all files changed by this plan.

- [ ] **Step 1: Run focused project graph extraction**

Run:

```bash
node scripts/extract-wxml-project-graph.mjs fixtures/miniprogram >/tmp/wxml-zed-project-graph.json
node -e 'const graph = JSON.parse(require("fs").readFileSync("/tmp/wxml-zed-project-graph.json", "utf8")); console.log(`${graph.pages.length}/${graph.configs.length}/${graph.usingComponents.length}/${graph.wxml.length}/${graph.unresolved.length}`)'
```

Expected output:

```text
2/5/3/6/1
```

- [ ] **Step 2: Run full verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exits 0 and prints:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 3: Check whitespace and branch status**

Run:

```bash
git diff --check main..HEAD
git status --short --branch
```

Expected:

```text
## project-graph-baseline-design
```

- [ ] **Step 4: Inspect branch diff**

Run:

```bash
git diff --stat main..HEAD
git diff --name-only main..HEAD
```

Expected changed paths:

```text
README.md
docs/superpowers/plans/2026-05-12-wxml-project-graph-baseline.md
docs/superpowers/specs/2026-05-12-wxml-project-graph-baseline-design.md
fixtures/miniprogram/app.json
fixtures/miniprogram/pages/home/home.json
fixtures/miniprogram/pages/home/home.wxml
fixtures/miniprogram/pages/detail/detail.json
fixtures/miniprogram/pages/detail/detail.wxml
fixtures/miniprogram/components/user-card/user-card.json
fixtures/miniprogram/components/user-card/user-card.wxml
fixtures/miniprogram/components/status-badge/status-badge.json
fixtures/miniprogram/components/status-badge/status-badge.wxml
fixtures/miniprogram/shared/header.wxml
fixtures/miniprogram/templates/common.wxml
fixtures/miniprogram/utils/format.wxs
scripts/extract-wxml-project-graph.mjs
scripts/verify-tree-sitter.sh
```

- [ ] **Step 5: Request review before merge**

Use `superpowers:requesting-code-review` or perform an equivalent local review if subagents are not authorized. Fix Critical and Important issues before merging.
