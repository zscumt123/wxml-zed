# WXML Project Graph Scope v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the WXML project graph so existing diagnostics and go-to-definition work with app-global `usingComponents` and subpackage pages.

**Architecture:** Keep `server/wxml-lsp.mjs` unchanged as the protocol host. Implement global component, root-absolute component path, subpackage page discovery, and owner-local override semantics inside `scripts/extract-wxml-project-graph.mjs`, preserving the existing owner-scoped `graph.usingComponents[]` contract consumed by `server/wxml-language-service.mjs`. Prove behavior through fixture graph assertions, direct language-service checks, and protocol-level LSP checks.

**Tech Stack:** Node.js ESM scripts, JSON fixture files, WXML fixtures, existing dependency-free LSP harness, shell verification through `scripts/verify-tree-sitter.sh`.

---

## File Structure

- Modify `fixtures/miniprogram/app.json`: add app-global `usingComponents` and `subPackages`.
- Modify `fixtures/miniprogram/pages/home/home.json`: add local override for `global-badge`.
- Modify `fixtures/miniprogram/pages/home/home.wxml`: use local override `<global-badge />` immediately after `<missing-card />`.
- Create `fixtures/miniprogram/components/global-badge/global-badge.json`.
- Create `fixtures/miniprogram/components/global-badge/global-badge.wxml`.
- Create `fixtures/miniprogram/components/local-badge/local-badge.json`.
- Create `fixtures/miniprogram/components/local-badge/local-badge.wxml`.
- Create `fixtures/miniprogram/packages/shop/pages/list/list.json`.
- Create `fixtures/miniprogram/packages/shop/pages/list/list.wxml`.
- Modify `scripts/verify-tree-sitter.sh`: add graph-level assertions for subpackage pages, global/local badge configs, WXML entries, effective `usingComponents`, and override de-duplication.
- Modify `scripts/extract-wxml-project-graph.mjs`: add subpackage page collection, root-absolute local component path resolution, and app-global plus owner-local effective component merging.
- Modify `scripts/verify-wxml-language-service.mjs`: add direct checks for subpackage clean diagnostics, global component definition, and local override definition.
- Modify `scripts/verify-lsp-diagnostics.mjs`: add protocol checks for subpackage clean diagnostics and global component definition.
- Modify `README.md`: document graph support for app-global `usingComponents`, root-absolute local component paths, and `subPackages` / `subpackages`.
- No changes expected in `server/wxml-lsp.mjs`, `server/wxml-language-service.mjs`, grammar files, or Tree-sitter query files.

## Task 0: Prepare the Implementation Branch

**Files:**
- Verify: git state
- Verify: baseline total verification

- [ ] **Step 1: Confirm main is clean**

Run:

```bash
git status --short --branch
```

Expected: current branch is `main` and there are no modified, staged, or untracked files.

- [ ] **Step 2: Create the feature branch**

Run:

```bash
git checkout -b wxml-project-graph-scope-v2
```

Expected: branch switches to `wxml-project-graph-scope-v2`.

- [ ] **Step 3: Run baseline verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 with final output:

```text
wxml-zed tree-sitter verification passed
```

## Task 1: Add Fixture and Graph Verification Coverage

**Files:**
- Modify: `fixtures/miniprogram/app.json`
- Modify: `fixtures/miniprogram/pages/home/home.json`
- Modify: `fixtures/miniprogram/pages/home/home.wxml`
- Create: `fixtures/miniprogram/components/global-badge/global-badge.json`
- Create: `fixtures/miniprogram/components/global-badge/global-badge.wxml`
- Create: `fixtures/miniprogram/components/local-badge/local-badge.json`
- Create: `fixtures/miniprogram/components/local-badge/local-badge.wxml`
- Create: `fixtures/miniprogram/packages/shop/pages/list/list.json`
- Create: `fixtures/miniprogram/packages/shop/pages/list/list.wxml`
- Modify: `scripts/verify-tree-sitter.sh`
- Test: `scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Update app fixture**

Replace `fixtures/miniprogram/app.json` with:

```json
{
  "pages": [
    "pages/home/home",
    "pages/detail/detail"
  ],
  "subPackages": [
    {
      "root": "packages/shop",
      "pages": [
        "pages/list/list"
      ]
    }
  ],
  "window": {
    "navigationBarTitleText": "WXML Fixture"
  },
  "usingComponents": {
    "global-badge": "/components/global-badge/global-badge"
  }
}
```

- [ ] **Step 2: Add local override to home page config**

Replace `fixtures/miniprogram/pages/home/home.json` with:

```json
{
  "usingComponents": {
    "user-card": "../../components/user-card/user-card",
    "missing-card": "../../components/missing-card/missing-card",
    "global-badge": "../../components/local-badge/local-badge"
  }
}
```

- [ ] **Step 3: Add local override usage without moving missing-card**

In `fixtures/miniprogram/pages/home/home.wxml`, insert this line immediately after `<missing-card reason="{{emptyReason}}" />`:

```xml
  <global-badge label="Local override" />
```

The surrounding block should become:

```xml
  <missing-card reason="{{emptyReason}}" />
  <global-badge label="Local override" />

  <view class="total">
```

This preserves the existing zero-based `missing-card` diagnostic range at line 14.

- [ ] **Step 4: Add global badge component fixture**

Create `fixtures/miniprogram/components/global-badge/global-badge.json`:

```json
{
  "component": true,
  "usingComponents": {}
}
```

Create `fixtures/miniprogram/components/global-badge/global-badge.wxml`:

```xml
<view class="global-badge">
  <text>{{label}}</text>
</view>
```

- [ ] **Step 5: Add local badge override component fixture**

Create `fixtures/miniprogram/components/local-badge/local-badge.json`:

```json
{
  "component": true,
  "usingComponents": {}
}
```

Create `fixtures/miniprogram/components/local-badge/local-badge.wxml`:

```xml
<view class="local-badge">
  <text>{{label}}</text>
</view>
```

- [ ] **Step 6: Add subpackage page fixture**

Create `fixtures/miniprogram/packages/shop/pages/list/list.json`:

```json
{
  "usingComponents": {}
}
```

Create `fixtures/miniprogram/packages/shop/pages/list/list.wxml`:

```xml
<view class="shop-list">
  <global-badge label="Shop" />
</view>
```

- [ ] **Step 7: Add graph assertion helpers**

In `scripts/verify-tree-sitter.sh`, inside the project graph `node -e` block, add these helper functions after `hasResolvedComponent()`:

```javascript
function matchingComponents(owner, tag) {
  return graph.usingComponents.filter((component) => (
    component.owner === owner &&
    component.tag === tag
  ));
}

function assertSingleResolvedComponent(owner, tag, value, target) {
  const matches = matchingComponents(owner, tag);
  assert(matches.length === 1, `Expected one ${tag} component for ${owner}, got ${matches.length}: ${JSON.stringify(matches)}`);
  const [component] = matches;
  assert(component.value === value, `${owner} ${tag} value mismatch: ${component.value}`);
  assert(component.target === target, `${owner} ${tag} target mismatch: ${component.target}`);
  assert(component.resolved === true, `${owner} ${tag} should be resolved: ${JSON.stringify(component)}`);
}
```

- [ ] **Step 8: Add graph assertions**

In the same `node -e` block, add these assertions after the existing `assert(hasPage("pages/detail/detail"), "Missing detail page");` line:

```javascript
assert(hasPage("packages/shop/pages/list/list"), "Missing shop list subpackage page");
```

Add these config assertions after the existing status-badge config assertion:

```javascript
assert(hasConfig("fixtures/miniprogram/packages/shop/pages/list/list.json", "page"), "Missing shop list page config");
assert(hasConfig("fixtures/miniprogram/components/global-badge/global-badge.json", "component"), "Missing global-badge config");
assert(hasConfig("fixtures/miniprogram/components/local-badge/local-badge.json", "component"), "Missing local-badge config");
```

Add these effective component assertions after the existing `missing-card` unresolved assertion:

```javascript
assertSingleResolvedComponent(
  "fixtures/miniprogram/packages/shop/pages/list/list.wxml",
  "global-badge",
  "/components/global-badge/global-badge",
  "fixtures/miniprogram/components/global-badge/global-badge.wxml",
);
assertSingleResolvedComponent(
  "fixtures/miniprogram/pages/home/home.wxml",
  "global-badge",
  "../../components/local-badge/local-badge",
  "fixtures/miniprogram/components/local-badge/local-badge.wxml",
);
```

Add these WXML entry assertions after `wxml("fixtures/miniprogram/components/status-badge/status-badge.wxml");`:

```javascript
wxml("fixtures/miniprogram/components/global-badge/global-badge.wxml");
wxml("fixtures/miniprogram/components/local-badge/local-badge.wxml");
wxml("fixtures/miniprogram/packages/shop/pages/list/list.wxml");
```

Add this component candidate assertion after `assert(home.components.some((component) => component.tag === "user-card"), "Missing user-card component candidate");`:

```javascript
assert(home.components.some((component) => component.tag === "global-badge"), "Missing home global-badge component candidate");
```

- [ ] **Step 9: Run total verification and confirm graph failure**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: FAIL in the project graph assertion block. The first valid failure should mention a missing subpackage page, missing global/local badge config, or missing effective `global-badge` component. Do not commit this red state.

## Task 2: Implement Project Graph Scope v2

**Files:**
- Modify: `scripts/extract-wxml-project-graph.mjs`
- Test: `scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Replace component path derivation helpers**

In `scripts/extract-wxml-project-graph.mjs`, replace the existing `derivedPaths(ownerJsonPath, value)` function with:

```javascript
function componentBasePath(projectRoot, ownerJsonPath, value) {
  if (value.startsWith("/")) {
    return path.resolve(projectRoot, withoutKnownExtension(value.slice(1)));
  }
  return path.resolve(path.dirname(ownerJsonPath), withoutKnownExtension(value));
}

function derivedPaths(projectRoot, ownerJsonPath, value) {
  const base = componentBasePath(projectRoot, ownerJsonPath, value);
  return {
    base,
    wxml: `${base}.wxml`,
    json: `${base}.json`,
  };
}
```

- [ ] **Step 2: Update local component support check**

In `resolveUsingComponent(projectRoot, ownerJsonPath, ownerWxmlPath, tag, value)`, replace:

```javascript
  if (!value.startsWith("./") && !value.startsWith("../")) {
```

With:

```javascript
  if (!value.startsWith("./") && !value.startsWith("../") && !value.startsWith("/")) {
```

Then replace:

```javascript
  const paths = derivedPaths(ownerJsonPath, value);
```

With:

```javascript
  const paths = derivedPaths(projectRoot, ownerJsonPath, value);
```

- [ ] **Step 3: Add page collection helpers**

Add these helpers after `readUsingComponents(config)`:

```javascript
function validPageEntries(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function subpackageEntries(appJson) {
  return [
    ...(Array.isArray(appJson.subPackages) ? appJson.subPackages : []),
    ...(Array.isArray(appJson.subpackages) ? appJson.subpackages : []),
  ];
}

function collectPageNames(appJson) {
  const pageNames = [];
  const seen = new Set();

  function addPage(name) {
    if (seen.has(name)) return;
    seen.add(name);
    pageNames.push(name);
  }

  for (const pageName of validPageEntries(appJson.pages)) {
    addPage(pageName);
  }

  for (const item of subpackageEntries(appJson)) {
    if (!item || typeof item.root !== "string" || !Array.isArray(item.pages)) {
      continue;
    }
    const root = item.root.replace(/^\/+|\/+$/gu, "");
    if (!root) {
      continue;
    }
    for (const pageName of validPageEntries(item.pages)) {
      addPage(`${root}/${pageName.replace(/^\/+/u, "")}`);
    }
  }

  return pageNames;
}
```

- [ ] **Step 4: Add effective component merge helper**

Add this helper after `collectPageNames(appJson)`:

```javascript
function effectiveUsingComponents(appUsingComponents, ownerUsingComponents) {
  return {
    ...appUsingComponents,
    ...ownerUsingComponents,
  };
}
```

- [ ] **Step 5: Read app global components once**

Inside `extractProject(projectRootInput)`, after `const appJson = readJsonIfExists(appJsonPath);` and the missing-app guard, add:

```javascript
  const appUsingComponents = readUsingComponents(appJson);
```

- [ ] **Step 6: Merge app global and owner local components**

In `readOwnerConfig(jsonPath, wxmlPath, kind)`, replace the component loop:

```javascript
    for (const [tag, value] of Object.entries(readUsingComponents(config))) {
```

With:

```javascript
    const ownerUsingComponents = kind === "app"
      ? readUsingComponents(config)
      : effectiveUsingComponents(appUsingComponents, readUsingComponents(config));

    for (const [tag, value] of Object.entries(ownerUsingComponents)) {
```

This keeps app-global entries available for page/component owners and avoids duplicating app entries on the app config itself.

- [ ] **Step 7: Use collected page names**

Replace:

```javascript
  const pages = Array.isArray(appJson.pages) ? appJson.pages : [];
```

With:

```javascript
  const pages = collectPageNames(appJson);
```

- [ ] **Step 8: Run graph extraction for manual inspection**

Run:

```bash
node scripts/extract-wxml-project-graph.mjs fixtures/miniprogram >/tmp/wxml-zed-project-graph-v2.json
node -e 'const fs=require("fs"); const graph=JSON.parse(fs.readFileSync("/tmp/wxml-zed-project-graph-v2.json","utf8")); console.log(graph.pages.map((p)=>p.name).join("\n")); console.log(graph.usingComponents.filter((c)=>c.tag==="global-badge").map((c)=>`${c.owner} -> ${c.value} -> ${c.target}`).join("\n"));'
```

Expected output includes:

```text
packages/shop/pages/list/list
fixtures/miniprogram/pages/home/home.wxml -> ../../components/local-badge/local-badge -> fixtures/miniprogram/components/local-badge/local-badge.wxml
fixtures/miniprogram/packages/shop/pages/list/list.wxml -> /components/global-badge/global-badge -> fixtures/miniprogram/components/global-badge/global-badge.wxml
```

- [ ] **Step 9: Run total verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 with final output:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 10: Run syntax check**

Run:

```bash
node --check scripts/extract-wxml-project-graph.mjs
```

Expected: exit code 0.

- [ ] **Step 11: Commit extractor and graph fixture work**

```bash
git add fixtures/miniprogram scripts/extract-wxml-project-graph.mjs scripts/verify-tree-sitter.sh
git commit -m "feat: support app global components and subpackages"
```

## Task 3: Add Direct Language-Service Coverage

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`
- Test: `node scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Add fixture constants**

In `scripts/verify-wxml-language-service.mjs`, add these constants after `const FORMAT_WXS = ...`:

```javascript
const SHOP_LIST_WXML = path.join(MINIPROGRAM_ROOT, "packages/shop/pages/list/list.wxml");
const GLOBAL_BADGE_WXML = path.join(MINIPROGRAM_ROOT, "components/global-badge/global-badge.wxml");
const LOCAL_BADGE_WXML = path.join(MINIPROGRAM_ROOT, "components/local-badge/local-badge.wxml");
```

- [ ] **Step 2: Add subpackage diagnostics assertion**

Add this function after `assertMissingCardDiagnostic(graph)`:

```javascript
function assertShopListDiagnosticsClean(graph) {
  const diagnostics = getDiagnostics({ graph, documentPath: SHOP_LIST_WXML, extensionRoot: ROOT });
  assertDeepEqual(diagnostics, [], "shop list diagnostics");
}
```

- [ ] **Step 3: Add global component definition assertion**

Add this function after `assertDefinition(graph)`:

```javascript
function assertGlobalBadgeDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: SHOP_LIST_WXML,
    position: { line: 1, character: 3 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, GLOBAL_BADGE_WXML, "global-badge definition");
}
```

- [ ] **Step 4: Add local override definition assertion**

Add this function after `assertGlobalBadgeDefinition(graph)`:

```javascript
function assertLocalBadgeOverrideDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 15, character: 3 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, LOCAL_BADGE_WXML, "local global-badge override definition");
}
```

- [ ] **Step 5: Call new assertions**

At the bottom, after `assertMissingCardDiagnostic(graph);`, add:

```javascript
assertShopListDiagnosticsClean(graph);
```

After `assertDefinition(graph);`, add:

```javascript
assertGlobalBadgeDefinition(graph);
assertLocalBadgeOverrideDefinition(graph);
```

- [ ] **Step 6: Run direct service verification**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: exit code 0. Tree-sitter parser-directory warnings are acceptable if the process exits 0.

- [ ] **Step 7: Run syntax check**

Run:

```bash
node --check scripts/verify-wxml-language-service.mjs
```

Expected: exit code 0.

- [ ] **Step 8: Commit direct language-service coverage**

```bash
git add scripts/verify-wxml-language-service.mjs
git commit -m "test: cover global component graph definitions"
```

## Task 4: Add Protocol-Level LSP Coverage

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`
- Test: `node scripts/verify-lsp-diagnostics.mjs`

- [ ] **Step 1: Add fixture constants**

In `scripts/verify-lsp-diagnostics.mjs`, add these constants after `const FORMAT_WXS = ...`:

```javascript
const SHOP_LIST_WXML = path.join(MINIPROGRAM_ROOT, "packages/shop/pages/list/list.wxml");
const GLOBAL_BADGE_WXML = path.join(MINIPROGRAM_ROOT, "components/global-badge/global-badge.wxml");
```

- [ ] **Step 2: Add clean subpackage diagnostics scenario**

Add this function after `testMiniProgramRootInitialization()`:

```javascript
async function testSubpackageGlobalComponentDiagnosticsClean() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(SHOP_LIST_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 0, "shop list diagnostics");
  });
}
```

- [ ] **Step 3: Add subpackage global component definition scenario**

Add this function after `testSubpackageGlobalComponentDiagnosticsClean()`:

```javascript
async function testSubpackageGlobalComponentDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(SHOP_LIST_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 0, "shop list diagnostics before definition");
    const result = await client.definition(SHOP_LIST_WXML, { line: 1, character: 3 });
    assertLocationTarget(result, GLOBAL_BADGE_WXML);
  });
}
```

- [ ] **Step 4: Add scenarios to runner**

In the `scenarios` array, add these entries immediately after `["mini program root initialization", testMiniProgramRootInitialization],`:

```javascript
["subpackage global component diagnostics clean", testSubpackageGlobalComponentDiagnosticsClean],
["subpackage global component definition", testSubpackageGlobalComponentDefinition],
```

- [ ] **Step 5: Run protocol verification**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: exit code 0 and stderr includes:

```text
[verify-lsp-diagnostics] subpackage global component diagnostics clean
[verify-lsp-diagnostics] subpackage global component definition
```

- [ ] **Step 6: Run syntax check**

Run:

```bash
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: exit code 0.

- [ ] **Step 7: Commit protocol coverage**

```bash
git add scripts/verify-lsp-diagnostics.mjs
git commit -m "test: cover subpackage global component lsp behavior"
```

## Task 5: Update README Scope

**Files:**
- Modify: `README.md`
- Test: README wording checks

- [ ] **Step 1: Update feature matrix wording**

In `README.md`, replace:

```markdown
| Pre-LSP project graph extractor for local mini program fixtures | Yes |
```

With:

```markdown
| Pre-LSP project graph extractor for pages, subpackages, local components, and app-global components | Yes |
```

- [ ] **Step 2: Update project graph scope paragraph**

Replace this paragraph:

```markdown
`scripts/extract-wxml-project-graph.mjs` emits a deterministic JSON graph for a
single mini program project root. It reads `app.json`, page and component JSON
files, local relative `usingComponents`, and the existing WXML symbol model. It
does not resolve npm components, plugin components, `subPackages`, watch mode,
or editor navigation.
```

With:

```markdown
`scripts/extract-wxml-project-graph.mjs` emits a deterministic JSON graph for a
single mini program project root. It reads top-level `app.json.pages`,
`app.json.subPackages` / `subpackages`, app-global and owner-local
`usingComponents`, local relative component paths, local root-absolute component
paths, and the existing WXML symbol model. It does not resolve npm components,
plugin components, `componentGenerics`, watch mode, or editor navigation.
```

- [ ] **Step 3: Update unsupported scope wording**

In the Scope section, replace:

```markdown
actions, formatting, file watching, npm/plugin component resolution,
`componentGenerics`, `subPackages`, or production Node runtime packaging.
```

With:

```markdown
actions, formatting, file watching, npm/plugin component resolution,
`componentGenerics`, independent-subpackage component isolation rules, or
production Node runtime packaging.
```

- [ ] **Step 4: Update LSP fixture paragraph**

In the paragraph beginning `reports missing-card`, replace:

```markdown
`include`, and external `wxs` declarations to their target files, resolves the
static `loadingRow` template usage to `templates/common.wxml`, and returns
document symbols for those dependency entries.
```

With:

```markdown
`include`, and external `wxs` declarations to their target files, resolves the
static `loadingRow` template usage to `templates/common.wxml`, resolves the
subpackage `<global-badge>` usage through app-global `usingComponents`, resolves
the home page `<global-badge>` usage through the owner-local override, and
returns document symbols for those dependency entries.
```

- [ ] **Step 5: Check README wording**

Run:

```bash
rg -n 'subPackages|subpackages|app-global|root-absolute|independent-subpackage|Pre-LSP project graph extractor' README.md
rg -n 'does not resolve npm components, plugin components, `subPackages`' README.md
```

Expected: first command finds the new supported and unsupported wording. Second command exits 1 with no matches.

- [ ] **Step 6: Commit README update**

```bash
git add README.md
git commit -m "docs: document project graph scope v2"
```

## Task 6: Final Verification and Review

**Files:**
- Verify: all changed files
- Verify: `server/wxml-lsp.mjs`
- Verify: `server/wxml-language-service.mjs`

- [ ] **Step 1: Run direct service verification**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: exit code 0.

- [ ] **Step 2: Run protocol verification**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: exit code 0.

- [ ] **Step 3: Run syntax checks**

Run:

```bash
node --check scripts/extract-wxml-project-graph.mjs
node --check scripts/verify-wxml-language-service.mjs
node --check scripts/verify-lsp-diagnostics.mjs
node --check server/wxml-lsp.mjs
node --check server/wxml-language-service.mjs
```

Expected: all commands exit 0.

- [ ] **Step 4: Run total verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 with final output:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 5: Check LSP host boundary**

Run:

```bash
rg -n "subPackages|subpackages|global-badge|usingComponents|root-absolute|componentBasePath|collectPageNames" server/wxml-lsp.mjs
```

Expected: exit code 1 with no matches. Project graph semantics must stay out of the LSP host.

- [ ] **Step 6: Review branch diff**

Run:

```bash
git diff --stat main..HEAD
git diff --check main..HEAD
```

Expected: implementation diff is limited to planned fixture, extractor, verification, and README files. `git diff --check` emits no whitespace errors.

- [ ] **Step 7: Request code review before merge**

Use `superpowers:requesting-code-review` before merging.

Review context:

```text
Description: Added project graph support for app-global usingComponents, root-absolute local component paths, and subpackage page discovery.
Requirements: Keep graph schema version unchanged; expand app-global components into owner-scoped usingComponents; owner-local declarations override app-global declarations; discover subPackages/subpackages pages with first-occurrence page de-duplication; keep graph semantics out of server/wxml-lsp.mjs; existing diagnostics and definitions must remain green.
Base: main at the start of the implementation branch.
Head: current feature branch.
```

Fix any Critical or Important findings before merge.
