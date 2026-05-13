# WXML LSP Navigation v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `textDocument/definition` from local component tags to WXML import/include dependencies and external WXS file dependencies.

**Architecture:** Keep `server/wxml-lsp.mjs` as the protocol host and async graph coordinator. Implement dependency-navigation rules inside `server/wxml-language-service.mjs` by consuming the existing project graph and dependency ranges. Prove behavior first with direct service tests, then through the stdio LSP harness.

**Tech Stack:** Node.js ESM, dependency-free JSON-RPC/LSP stdio server, existing WXML project graph JSON model, fixture-driven verification scripts, Markdown docs.

---

## File Structure

- Modify `scripts/verify-wxml-language-service.mjs`: add direct tests for dependency definitions and negative WXS/WXML resolution cases.
- Modify `server/wxml-language-service.mjs`: extend `getDefinition()` with dependency lookup while keeping component lookup unchanged.
- Modify `scripts/verify-lsp-diagnostics.mjs`: add protocol-level `textDocument/definition` scenarios for import, include, and external WXS declarations.
- Modify `README.md`: update the LSP support boundary to include import/include/WXS definition navigation and keep template navigation unsupported.
- No changes to `server/wxml-lsp.mjs`, grammar files, Tree-sitter query files, or graph extractor schema are expected.

## Task 0: Prepare the Implementation Branch

**Files:**
- Verify: working tree state
- Verify: baseline total verification

- [ ] **Step 1: Confirm the working tree is clean**

Run:

```bash
git status --short --branch
```

Expected: current branch is `main` and there are no modified, staged, or untracked files.

- [ ] **Step 2: Create the feature branch**

Run:

```bash
git checkout -b wxml-lsp-navigation-v1
```

Expected: branch switches to `wxml-lsp-navigation-v1`.

- [ ] **Step 3: Run baseline verification before code changes**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 with final output:

```text
wxml-zed tree-sitter verification passed
```

## Task 1: Add Direct Language Service Tests for Navigation v1

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`
- Test: `node scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Add target path constants**

In `scripts/verify-wxml-language-service.mjs`, extend the constants near the existing fixture paths:

```javascript
const HEADER_WXML = path.join(MINIPROGRAM_ROOT, "shared/header.wxml");
const FORMAT_WXS = path.join(MINIPROGRAM_ROOT, "utils/format.wxs");
const USER_CARD_TARGET = path.join(MINIPROGRAM_ROOT, "components/user-card/user-card.wxml");
```

Keep the existing `USER_CARD_TARGET` constant if present; add only `HEADER_WXML` and `FORMAT_WXS` if `USER_CARD_TARGET` already exists.

- [ ] **Step 2: Add shared assertion helpers**

Replace the URI/range assertion inside `assertDefinition(graph)` with this helper and then call it from `assertDefinition(graph)`:

```javascript
function assertLocationTarget(location, targetPath, label) {
  assert(location, `${label}: expected definition location`);
  assert(location.uri === pathToFileURL(targetPath).href, `${label}: unexpected URI ${JSON.stringify(location)}`);
  assertDeepEqual(
    location.range,
    { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    `${label} range`,
  );
}

function assertNullLocation(location, label) {
  assert(location === null, `${label}: expected null, got ${JSON.stringify(location)}`);
}
```

Update `assertDefinition(graph)` to:

```javascript
function assertDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 7, character: 3 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, USER_CARD_TARGET, "user-card definition");
}
```

- [ ] **Step 3: Add success tests for import/include/WXS dependency definitions**

Add these functions below `assertDefinition(graph)`:

```javascript
function assertImportDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 0, character: 2 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, COMMON_WXML, "import definition");
}

function assertIncludeDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 1, character: 2 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, HEADER_WXML, "include definition");
}

function assertExternalWxsDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 2, character: 2 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, FORMAT_WXS, "external wxs definition");
}
```

- [ ] **Step 4: Add negative dependency graph helper and tests**

Add these helpers below the success tests:

```javascript
function cloneGraph(graph) {
  return JSON.parse(JSON.stringify(graph));
}

function homeFileModel(graph) {
  return graph.wxml.find((entry) => entry.path === "fixtures/miniprogram/pages/home/home.wxml");
}

function dependencyRange(line) {
  return {
    start: { row: line, column: 0 },
    end: { row: line, column: 30 },
  };
}

function graphWithDependency(graph, dependency) {
  const nextGraph = cloneGraph(graph);
  homeFileModel(nextGraph).dependencies.push(dependency);
  return nextGraph;
}

function assertMissingWxmlDependencyReturnsNull(graph) {
  const testGraph = graphWithDependency(graph, {
    kind: "import",
    value: "../../templates/missing.wxml",
    normalized: "fixtures/miniprogram/templates/missing.wxml",
    range: dependencyRange(50),
  });
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 50, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "missing wxml dependency definition");
}

function assertMissingWxsDependencyReturnsNull(graph) {
  const testGraph = graphWithDependency(graph, {
    kind: "wxs",
    value: "../../utils/missing.wxs",
    normalized: "fixtures/miniprogram/utils/missing.wxs",
    module: "missing",
    range: dependencyRange(51),
  });
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 51, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "missing wxs dependency definition");
}

function assertOutsideRootWxsDependencyReturnsNull(graph) {
  const testGraph = graphWithDependency(graph, {
    kind: "wxs",
    value: "../../../outside.wxs",
    normalized: "fixtures/outside.wxs",
    module: "outside",
    range: dependencyRange(52),
  });
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 52, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "outside-root wxs dependency definition");
}
```

- [ ] **Step 5: Call the new tests**

At the bottom of `scripts/verify-wxml-language-service.mjs`, update the assertions to include the new cases immediately after `assertDefinition(graph)`:

```javascript
const graph = loadGraph();
assertMissingCardDiagnostic(graph);
assertDefinition(graph);
assertImportDefinition(graph);
assertIncludeDefinition(graph);
assertExternalWxsDefinition(graph);
assertMissingWxmlDependencyReturnsNull(graph);
assertMissingWxsDependencyReturnsNull(graph);
assertOutsideRootWxsDependencyReturnsNull(graph);
assertHomeDocumentSymbols(graph);
assertTemplateDocumentSymbols(graph);
assertComponentUsageExcluded(graph);
```

- [ ] **Step 6: Run the direct service verification and confirm red failure**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: FAIL. The first valid failure should be for `import definition` returning `null`, because `getDefinition()` still only handles component ranges.

- [ ] **Step 7: Commit the failing direct service tests**

```bash
git add scripts/verify-wxml-language-service.mjs
git commit -m "test: add wxml dependency definition verification"
```

## Task 2: Implement Dependency Definition in the Language Service

**Files:**
- Modify: `server/wxml-language-service.mjs`
- Test: `node scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Import `fs` for WXS existence checks**

At the top of `server/wxml-language-service.mjs`, add:

```javascript
import fs from "node:fs";
```

Keep the existing `path` and `pathToFileURL` imports.

- [ ] **Step 2: Add project-root and dependency validation helpers**

Add these helpers after `locationForGraphPath()`:

```javascript
function isInsideGraphRoot(graphPath, graphRoot) {
  const relative = path.posix.relative(graphRoot, graphPath);
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

function hasUnresolvedWxmlDependency(graph, owner, dependency) {
  return graph.unresolved.some((entry) => (
    entry.kind === "wxml-dependency" &&
    entry.owner === owner &&
    entry.target === dependency.normalized
  ));
}

function isKnownWxmlTarget(graph, target) {
  return graph.wxml.some((entry) => entry.path === target);
}

function isExistingWxsTarget(target, extensionRoot) {
  return fs.existsSync(absolutePathForGraphPath(target, extensionRoot));
}

function dependencyTargetForDefinition(graph, owner, dependency, extensionRoot) {
  if (!dependency.normalized) {
    return undefined;
  }
  if (!isInsideGraphRoot(dependency.normalized, graph.root)) {
    return undefined;
  }

  if ((dependency.kind === "import" || dependency.kind === "include") && dependency.normalized.endsWith(".wxml")) {
    if (hasUnresolvedWxmlDependency(graph, owner, dependency)) {
      return undefined;
    }
    return isKnownWxmlTarget(graph, dependency.normalized) ? dependency.normalized : undefined;
  }

  if (dependency.kind === "wxs" && dependency.normalized.endsWith(".wxs")) {
    return isExistingWxsTarget(dependency.normalized, extensionRoot) ? dependency.normalized : undefined;
  }

  return undefined;
}

function dependencyDefinitionForPosition({ graph, documentGraphPath, fileModel, position, extensionRoot }) {
  const dependency = fileModel.dependencies.find((entry) => containsPosition(entry.range, position));
  if (!dependency) {
    return null;
  }

  const target = dependencyTargetForDefinition(graph, documentGraphPath, dependency, extensionRoot);
  if (!target) {
    return null;
  }

  return locationForGraphPath(target, extensionRoot);
}
```

- [ ] **Step 3: Preserve component lookup and fall through to dependencies**

In `getDefinition()`, replace this block:

```javascript
  const component = fileModel.components.find((entry) => containsPosition(entry.range, position));
  if (!component) {
    return null;
  }

  const usingComponent = graph.usingComponents.find((entry) => (
    entry.owner === documentGraphPath &&
    entry.tag === component.tag &&
    entry.resolved === true &&
    entry.target
  ));
  if (!usingComponent) {
    return null;
  }

  return locationForGraphPath(usingComponent.target, extensionRoot);
```

With:

```javascript
  const component = fileModel.components.find((entry) => containsPosition(entry.range, position));
  if (component) {
    const usingComponent = graph.usingComponents.find((entry) => (
      entry.owner === documentGraphPath &&
      entry.tag === component.tag &&
      entry.resolved === true &&
      entry.target
    ));
    if (usingComponent) {
      return locationForGraphPath(usingComponent.target, extensionRoot);
    }
  }

  return dependencyDefinitionForPosition({
    graph,
    documentGraphPath,
    fileModel,
    position,
    extensionRoot,
  });
```

- [ ] **Step 4: Run the direct service verification and confirm green**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: PASS with exit code 0. Tree-sitter parser-directory warnings are acceptable if the process exits 0.

- [ ] **Step 5: Run syntax check**

Run:

```bash
node --check server/wxml-language-service.mjs
node --check scripts/verify-wxml-language-service.mjs
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the language service implementation**

```bash
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat: add wxml dependency definitions"
```

## Task 3: Add Protocol-Level Definition Coverage

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`
- Test: `node scripts/verify-lsp-diagnostics.mjs`

- [ ] **Step 1: Add target path constants**

Near the existing fixture constants in `scripts/verify-lsp-diagnostics.mjs`, add:

```javascript
const HEADER_WXML = path.join(MINIPROGRAM_ROOT, "shared/header.wxml");
const FORMAT_WXS = path.join(MINIPROGRAM_ROOT, "utils/format.wxs");
```

- [ ] **Step 2: Add protocol success scenarios**

Add these functions after `testHomeComponentDefinition()`:

```javascript
async function testImportDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before import definition");
    const result = await client.definition(HOME_WXML, { line: 0, character: 2 });
    assertLocationTarget(result, COMMON_WXML);
  });
}

async function testIncludeDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before include definition");
    const result = await client.definition(HOME_WXML, { line: 1, character: 2 });
    assertLocationTarget(result, HEADER_WXML);
  });
}

async function testExternalWxsDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before wxs definition");
    const result = await client.definition(HOME_WXML, { line: 2, character: 2 });
    assertLocationTarget(result, FORMAT_WXS);
  });
}
```

- [ ] **Step 3: Add protocol scenarios to the runner list**

At the bottom of `scripts/verify-lsp-diagnostics.mjs`, add these entries immediately after `testHomeComponentDefinition` in the scenarios list:

```javascript
["import definition", testImportDefinition],
["include definition", testIncludeDefinition],
["external wxs definition", testExternalWxsDefinition],
```

Keep the existing component, diagnostics, document symbol, and async graph scenarios in place.

- [ ] **Step 4: Run the protocol harness**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: PASS with exit code 0 and log lines for:

```text
[verify-lsp-diagnostics] import definition
[verify-lsp-diagnostics] include definition
[verify-lsp-diagnostics] external wxs definition
```

- [ ] **Step 5: Run syntax check**

Run:

```bash
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: exit code 0.

- [ ] **Step 6: Commit the protocol coverage**

```bash
git add scripts/verify-lsp-diagnostics.mjs
git commit -m "test: cover wxml dependency definitions over lsp"
```

## Task 4: Update README Scope

**Files:**
- Modify: `README.md`
- Test: README wording checks

- [ ] **Step 1: Update the LSP capability paragraph**

In `README.md`, find the paragraph beginning with:

```markdown
`server/wxml-lsp.mjs` is a minimal stdio LSP prototype and protocol host.
```

Replace the middle capability sentences with:

```markdown
The LSP reports local `usingComponents` entries that resolve to a missing file
and are also used as custom component tags in the current WXML file. It supports
go-to-definition from resolved local custom component tags to their target
`.wxml` files, from WXML `import`/`include` declarations to their target
`.wxml` files, and from external WXS declarations to their target `.wxs` files.
It also returns a flat document-symbol list for WXML declaration/dependency
entries such as template definitions, WXS modules, imports, and includes.
```

- [ ] **Step 2: Update the baseline fixture example**

In the same paragraph, replace the sentence beginning with:

```markdown
For the baseline fixture this reports `missing-card`
```

With:

```markdown
For the baseline fixture this reports `missing-card` in
`pages/home/home.wxml`, resolves `<user-card>` to
`components/user-card/user-card.wxml`, resolves the top-level `import`,
`include`, and external `wxs` declarations to their target files, and returns
document symbols for those dependency entries.
```

- [ ] **Step 3: Narrow the unsupported navigation sentence**

In the unsupported list sentence, replace:

```markdown
template/import/include/WXS navigation
```

With:

```markdown
template navigation
```

The unsupported sentence must still include npm/plugin component navigation and `componentGenerics` support.

- [ ] **Step 4: Check README wording**

Run:

```bash
rg -n "go-to-definition|import`/`include|external WXS|template navigation" README.md
rg -n "template/import/include/WXS navigation" README.md
```

Expected: the first command finds the new supported wording. The second command exits 1 with no matches, proving the old unsupported wording was removed.

- [ ] **Step 5: Commit the README update**

```bash
git add README.md
git commit -m "docs: document wxml dependency navigation"
```

## Task 5: Final Verification and Review

**Files:**
- Verify: `server/wxml-language-service.mjs`
- Verify: `server/wxml-lsp.mjs`
- Verify: `scripts/verify-wxml-language-service.mjs`
- Verify: `scripts/verify-lsp-diagnostics.mjs`
- Verify: `README.md`

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
node --check server/wxml-language-service.mjs
node --check server/wxml-lsp.mjs
node --check scripts/verify-wxml-language-service.mjs
node --check scripts/verify-lsp-diagnostics.mjs
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

- [ ] **Step 5: Check boundary discipline**

Run:

```bash
rg -n "dependencyTargetForDefinition|dependencyDefinitionForPosition|isInsideGraphRoot|fs.existsSync" server/wxml-language-service.mjs
rg -n "dependencyTargetForDefinition|dependencyDefinitionForPosition|isInsideGraphRoot|fs.existsSync" server/wxml-lsp.mjs
```

Expected: first command finds the dependency navigation helpers in `server/wxml-language-service.mjs`; second command has no matches because the LSP host must not contain dependency navigation business logic.

- [ ] **Step 6: Review branch diff**

Run:

```bash
git diff --stat main..HEAD
git diff --check main..HEAD
```

Expected: implementation diff is limited to the planned files, and `git diff --check` emits no whitespace errors.

- [ ] **Step 7: Request code review before merge**

Use `superpowers:requesting-code-review` before merging implementation back to `main`.

Review context:

```text
Description: Added WXML import/include/external-WXS go-to-definition through the existing language-service boundary.
Requirements: Preserve component definition behavior; keep dependency logic out of server/wxml-lsp.mjs; WXS targets must stay inside graph.root and exist on disk; missing WXML/WXS dependencies return null.
Base: main at the start of the implementation branch.
Head: current feature branch.
```

Fix any Critical or Important findings before merge.
