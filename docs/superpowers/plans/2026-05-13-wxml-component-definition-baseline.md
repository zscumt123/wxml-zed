# WXML Component Definition Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add prototype `textDocument/definition` support for local WXML custom component tags.

**Architecture:** Extend the existing dependency-free Node LSP server instead of adding a new language-service layer. Reuse the current mini program root resolution, graph cache, and async graph build queue; add graph waiters so request/response features can wait for a current graph without blocking JSON-RPC message processing. Keep the feature limited to resolved local `usingComponents` targets and return `null` for everything outside that boundary.

**Tech Stack:** Node.js ESM, JSON-RPC/LSP stdio framing, existing WXML project graph JSON model, shell verification through `scripts/verify-tree-sitter.sh`, Markdown docs.

---

## File Structure

- Modify `scripts/verify-lsp-diagnostics.mjs`: add definition request helpers and protocol scenarios before implementing the server feature.
- Modify `server/wxml-lsp.mjs`: advertise `definitionProvider`, add graph waiters, implement component definition resolution, and respond to `textDocument/definition`.
- Modify `README.md`: document the new prototype navigation capability and its exclusions.
- No new runtime dependencies.

## Task 1: Add Definition Protocol Tests First

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`
- Test: `scripts/verify-lsp-diagnostics.mjs`

- [ ] **Step 1: Add target constants**

Near the existing fixture constants, add component target paths:

```javascript
const STATUS_BADGE_WXML = path.join(MINIPROGRAM_ROOT, "components/status-badge/status-badge.wxml");
```

- [ ] **Step 2: Add a zero-range location assertion helper**

After `assertMissingCardDiagnostic`, add:

```javascript
function assertLocationTarget(result, targetPath) {
  assert(result, `Expected definition location for ${targetPath}`);
  assert(!Array.isArray(result), `Expected single Location, got array: ${JSON.stringify(result)}`);
  assert(result.uri === pathToFileURL(targetPath).href, `Unexpected definition URI: ${JSON.stringify(result)}`);
  const expectedRange = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
  assert(
    JSON.stringify(result.range) === JSON.stringify(expectedRange),
    `Unexpected definition range: ${JSON.stringify(result.range)}`,
  );
}

function assertNullDefinition(result, label) {
  assert(result === null, `${label}: expected null definition, got ${JSON.stringify(result)}`);
}
```

- [ ] **Step 3: Assert definition capability during initialize**

In `LspClient.initialize()`, after the existing `textDocumentSync` assertions, add:

```javascript
assert(response.result?.capabilities?.definitionProvider === true, "definitionProvider not advertised");
```

This should fail before the server implementation because the current server does not advertise definition support.

- [ ] **Step 4: Add a definition request helper to `LspClient`**

Inside `class LspClient`, add this method after `request()`:

```javascript
async definition(filePath, position) {
  const id = this.request("textDocument/definition", {
    textDocument: { uri: pathToFileURL(filePath).href },
    position,
  });
  const response = await this.waitForResponse(id);
  if (response.error) {
    throw new Error(`Definition request failed: ${JSON.stringify(response.error)}`);
  }
  return response.result;
}
```

- [ ] **Step 5: Add component definition scenarios**

Add these scenario functions before the `scenarios` array:

```javascript
async function testHomeComponentDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before definition");
    const result = await client.definition(HOME_WXML, { line: 7, character: 3 });
    assertLocationTarget(result, USER_CARD_WXML);
  });
}

async function testNestedComponentDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(USER_CARD_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 0, "user-card diagnostics before definition");
    const result = await client.definition(USER_CARD_WXML, { line: 2, character: 3 });
    assertLocationTarget(result, STATUS_BADGE_WXML);
  });
}

async function testMissingComponentDefinitionReturnsNull() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "missing-card diagnostics before definition");
    const result = await client.definition(HOME_WXML, { line: 14, character: 3 });
    assertNullDefinition(result, "missing-card definition");
  });
}

async function testNonComponentDefinitionReturnsNull() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before non-component definition");
    const result = await client.definition(HOME_WXML, { line: 3, character: 0 });
    assertNullDefinition(result, "blank line definition");
  });
}

async function testBuiltinDefinitionReturnsNull() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before builtin definition");
    const result = await client.definition(HOME_WXML, { line: 4, character: 3 });
    assertNullDefinition(result, "builtin view definition");
  });
}

async function testDefinitionBuildsGraphWithoutPriorDiagnostics() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const result = await client.definition(HOME_WXML, { line: 7, character: 3 });
    assertLocationTarget(result, USER_CARD_WXML);
  });
}

async function testDefinitionBuildDoesNotBlockRequestLoop() {
  await withClient({
    rootPath: ROOT,
    env: {
      WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
    },
  }, async (client) => {
    const definitionPromise = client.definition(HOME_WXML, { line: 7, character: 3 });
    const id = client.request("workspace/symbol", { query: "user-card" });
    const response = await client.waitForResponse(id);
    assert(response.error?.code === -32601, `Expected responsive -32601, got ${JSON.stringify(response)}`);
    assertLocationTarget(await definitionPromise, USER_CARD_WXML);
  });
}
```

The positions are zero-based:

- `{ line: 7, character: 3 }` is inside `<user-card` in `home.wxml`.
- `{ line: 2, character: 3 }` is inside `<status-badge` in `user-card.wxml`.
- `{ line: 14, character: 3 }` is inside `<missing-card` in `home.wxml`.
- `{ line: 4, character: 3 }` is inside the built-in `<view` tag in `home.wxml`.
- `{ line: 3, character: 0 }` is a blank line in `home.wxml`.
- The delayed graph build scenario proves a definition-triggered graph build
  does not block unrelated request handling.

- [ ] **Step 6: Register the definition scenarios**

Add these entries near the start of the `scenarios` array, before the existing diagnostics scenarios:

```javascript
["home component definition", testHomeComponentDefinition],
["nested component definition", testNestedComponentDefinition],
["missing component definition returns null", testMissingComponentDefinitionReturnsNull],
["non-component definition returns null", testNonComponentDefinitionReturnsNull],
["builtin definition returns null", testBuiltinDefinitionReturnsNull],
["definition builds graph without prior diagnostics", testDefinitionBuildsGraphWithoutPriorDiagnostics],
["definition build does not block request loop", testDefinitionBuildDoesNotBlockRequestLoop],
```

- [ ] **Step 7: Run the harness and confirm it fails before implementation**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: FAIL before server changes. The failure should mention `definitionProvider not advertised` or a `textDocument/definition` method-not-found response.

- [ ] **Step 8: Commit the failing definition tests**

```bash
git add scripts/verify-lsp-diagnostics.mjs
git commit -m "test: add wxml component definition harness"
```

## Task 2: Implement Component Definition in the LSP Server

**Files:**
- Modify: `server/wxml-lsp.mjs`
- Test: `scripts/verify-lsp-diagnostics.mjs`

- [ ] **Step 1: Import `pathToFileURL`**

Change the URL import at the top of `server/wxml-lsp.mjs` from:

```javascript
import { fileURLToPath } from "node:url";
```

to:

```javascript
import { fileURLToPath, pathToFileURL } from "node:url";
```

- [ ] **Step 2: Add graph waiter state**

After the existing state maps:

```javascript
const pendingDiagnosticsByRoot = new Map();
```

add:

```javascript
const graphWaitersByRoot = new Map();
```

Then add these helper functions after `pendingForRoot(projectRoot)`:

```javascript
function waitersForRoot(projectRoot) {
  let waiters = graphWaitersByRoot.get(projectRoot);
  if (!waiters) {
    waiters = new Set();
    graphWaitersByRoot.set(projectRoot, waiters);
  }
  return waiters;
}

function waitForGraph(projectRoot) {
  return new Promise((resolve) => {
    waitersForRoot(projectRoot).add(resolve);
  });
}

function resolveGraphWaiters(projectRoot, graph) {
  const waiters = graphWaitersByRoot.get(projectRoot);
  if (!waiters) return;
  graphWaitersByRoot.delete(projectRoot);
  for (const resolve of waiters) {
    resolve(graph);
  }
}
```

- [ ] **Step 3: Resolve waiters from `runGraphBuild`**

In `runGraphBuild(projectRoot)`, inside the successful current-generation branch:

```javascript
if (activeGeneration === state.latestGeneration) {
  graphsByRoot.set(projectRoot, graph);
  publishPendingDiagnostics(projectRoot, (_uri, documentPath) => (
    diagnosticsForDocument(graph, documentPath)
  ));
}
```

change it to:

```javascript
if (activeGeneration === state.latestGeneration) {
  graphsByRoot.set(projectRoot, graph);
  publishPendingDiagnostics(projectRoot, (_uri, documentPath) => (
    diagnosticsForDocument(graph, documentPath)
  ));
  resolveGraphWaiters(projectRoot, graph);
}
```

In the current-generation error branch:

```javascript
if (activeGeneration === state.latestGeneration) {
  publishPendingDiagnostics(projectRoot, () => []);
}
```

change it to:

```javascript
if (activeGeneration === state.latestGeneration) {
  publishPendingDiagnostics(projectRoot, () => []);
  resolveGraphWaiters(projectRoot, undefined);
}
```

Do not resolve graph waiters in stale-generation branches.

- [ ] **Step 4: Add graph availability for request handlers**

After `runGraphBuild(projectRoot)`, add:

```javascript
function hasStableCachedGraph(projectRoot) {
  const state = stateForRoot(projectRoot);
  return graphsByRoot.has(projectRoot) && !state.running && !state.queued;
}

function ensureGraphForRequest(projectRoot) {
  if (hasStableCachedGraph(projectRoot)) {
    return Promise.resolve(graphsByRoot.get(projectRoot));
  }

  const graphPromise = waitForGraph(projectRoot);
  const state = stateForRoot(projectRoot);
  if (!state.running) {
    if (!state.queued) {
      state.latestGeneration += 1;
    }
    runGraphBuild(projectRoot);
  }
  return graphPromise;
}
```

This lets definition requests build a graph even if no diagnostics request has
opened or built one yet. The waiter is registered before `runGraphBuild()` is
called so a fast build cannot finish before the request subscribes.

- [ ] **Step 5: Add position and definition helpers**

After `rangeFromSymbolRange(range)`, add:

```javascript
const ZERO_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

function isPositionBefore(position, boundary) {
  return (
    position.line < boundary.line ||
    (position.line === boundary.line && position.character < boundary.character)
  );
}

function isPositionAtOrAfter(position, boundary) {
  return (
    position.line > boundary.line ||
    (position.line === boundary.line && position.character >= boundary.character)
  );
}

function symbolPointToLsp(point) {
  return {
    line: point.row,
    character: point.column,
  };
}

function containsPosition(range, position) {
  const start = symbolPointToLsp(range.start);
  const end = symbolPointToLsp(range.end);
  return isPositionAtOrAfter(position, start) && isPositionBefore(position, end);
}

function absolutePathForGraphPath(graphPath) {
  return path.resolve(EXTENSION_ROOT, graphPath);
}

function locationForGraphPath(graphPath) {
  return {
    uri: pathToFileURL(absolutePathForGraphPath(graphPath)).href,
    range: ZERO_RANGE,
  };
}
```

- [ ] **Step 6: Add component definition resolution**

After `diagnosticsForDocument(graph, documentPath)`, add:

```javascript
function definitionForDocument(graph, documentPath, position) {
  if (!position || typeof position.line !== "number" || typeof position.character !== "number") {
    return null;
  }

  const documentGraphPath = graphPathForAbsolute(documentPath);
  const fileModel = graph.wxml.find((entry) => entry.path === documentGraphPath);
  if (!fileModel) {
    logDiagnosticError(`No WXML graph entry for ${documentGraphPath}`);
    return null;
  }

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

  return locationForGraphPath(usingComponent.target);
}
```

- [ ] **Step 7: Add the async definition request handler**

After `scheduleDiagnostics(uri)`, add:

```javascript
async function definitionForRequest(params) {
  const documentPath = fileUriToPath(params?.textDocument?.uri);
  if (!documentPath) {
    return null;
  }

  const projectRoot = resolveMiniProgramRoot(documentPath);
  if (!projectRoot) {
    logDiagnosticError(`No app.json found for ${documentPath}`);
    return null;
  }

  const graph = await ensureGraphForRequest(projectRoot);
  if (!graph) {
    return null;
  }

  return definitionForDocument(graph, documentPath, params?.position);
}

async function handleDefinitionRequest(id, params) {
  try {
    respond(id, await definitionForRequest(params));
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    respond(id, null);
  }
}
```

- [ ] **Step 8: Advertise definition capability**

In `initialize(params)`, change the returned capabilities from:

```javascript
capabilities: {
  textDocumentSync: {
    openClose: true,
    change: 0,
    save: true,
  },
},
```

to:

```javascript
capabilities: {
  textDocumentSync: {
    openClose: true,
    change: 0,
    save: true,
  },
  definitionProvider: true,
},
```

- [ ] **Step 9: Wire `textDocument/definition`**

In `handleMessage(message)`, add this case before the default branch:

```javascript
case "textDocument/definition":
  handleDefinitionRequest(message.id, message.params);
  break;
```

Do not `await` inside `handleMessage`; the request handler should resolve
asynchronously and keep the JSON-RPC read loop responsive.

- [ ] **Step 10: Run focused verification**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: PASS, including the new definition scenarios and all previous
diagnostics scenarios.

- [ ] **Step 11: Run syntax and scope checks**

Run:

```bash
node --check server/wxml-lsp.mjs
rg -n "textDocument/definition|definitionProvider|graphWaitersByRoot|ensureGraphForRequest|definitionForDocument" server/wxml-lsp.mjs
```

Expected: syntax check passes, and ripgrep prints the new definition-related
symbols.

- [ ] **Step 12: Commit the server implementation**

```bash
git add server/wxml-lsp.mjs
git commit -m "feat: add wxml component definition support"
```

## Task 3: Document Component Definition Scope

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the feature matrix**

In the Features table, replace:

```markdown
| Cross-file navigation and full component resolution | Planned |
```

with:

```markdown
| Prototype go-to-definition for local WXML components | Yes |
| Cross-file navigation beyond local components and full component resolution | Planned |
```

- [ ] **Step 2: Update the high-level scope sentence**

Replace:

```markdown
This baseline is syntax-level editor support plus one narrow prototype
diagnostic. It intentionally does not provide symbol indexing,
component/template go-to-definition, completion, hover, document symbols,
semantic tokens, code actions, formatting, file watching, npm/plugin component
resolution, `subPackages`, or production Node runtime packaging.
```

with:

```markdown
This baseline is syntax-level editor support plus narrow prototype LSP behavior:
missing local component diagnostics and go-to-definition for resolved local WXML
component tags. It intentionally does not provide symbol indexing,
template/import/include/WXS navigation, completion, hover, document symbols,
semantic tokens, code actions, formatting, file watching, npm/plugin component
resolution, `componentGenerics`, `subPackages`, or production Node runtime
packaging.
```

- [ ] **Step 3: Update the `server/wxml-lsp.mjs` paragraph**

Replace the existing `server/wxml-lsp.mjs` paragraph in `Scope` with:

```markdown
`server/wxml-lsp.mjs` is a minimal stdio LSP prototype. It reports local
`usingComponents` entries that resolve to a missing file and are also used as
custom component tags in the current WXML file. It also supports
go-to-definition from resolved local custom component tags to their target
`.wxml` files. For the baseline fixture this reports `missing-card` in
`pages/home/home.wxml` and resolves `<user-card>` to
`components/user-card/user-card.wxml`. It uses an async per-root graph build
queue and cached graph state. Diagnostics still run on open/save only; there is
no file watching, incremental parsing, template/import/include/WXS navigation,
npm/plugin component navigation, or `componentGenerics` support.
```

- [ ] **Step 4: Check README wording**

Run:

```bash
rg -n "go-to-definition|local WXML components|template/import/include|componentGenerics|missing-card|user-card" README.md
```

Expected: matches show the feature table and scope text, without claiming
unsupported navigation.

- [ ] **Step 5: Commit the README update**

```bash
git add README.md
git commit -m "docs: document wxml component definition support"
```

## Task 4: Run Full Verification and Prepare Review

**Files:**
- Verify: `scripts/verify-lsp-diagnostics.mjs`
- Verify: `scripts/verify-tree-sitter.sh`
- Verify: `server/wxml-lsp.mjs`
- Verify: `README.md`

- [ ] **Step 1: Run the focused LSP harness**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: PASS with definition and diagnostics scenarios.

- [ ] **Step 2: Run the full verification wrapper**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: PASS and final output includes:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 3: Check implementation markers**

Run:

```bash
rg -n "definitionProvider|textDocument/definition|definitionForDocument|ensureGraphForRequest|graphWaitersByRoot" server/wxml-lsp.mjs
```

Expected: matches for each definition capability marker.

- [ ] **Step 4: Inspect final branch diff**

Run:

```bash
git diff --stat main...HEAD
git status --short --branch
```

Expected: changes are limited to the harness, server, README, and the plan/spec
commits for this slice. Worktree is clean.

- [ ] **Step 5: Request review before merge**

Summarize:

```text
Implemented WXML component definition baseline:
- textDocument/definition for resolved local WXML component tags
- graph waiters so definition can trigger/wait for graph builds
- harness coverage for user-card, nested status-badge, missing component, built-in tag, non-component position, no-prior-diagnostics graph build, and definition request-loop responsiveness
- README scope update

Verification:
- node scripts/verify-lsp-diagnostics.mjs
- scripts/verify-tree-sitter.sh
```

Then request code review before merging to `main`.
