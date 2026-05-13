# WXML LSP Language Service Boundary and Document Symbols Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract WXML feature mapping into a pure language-service module and add prototype `textDocument/documentSymbol` support through that boundary.

**Architecture:** Keep `server/wxml-lsp.mjs` as the protocol host and graph coordinator. Create `server/wxml-language-service.mjs` for pure graph-to-LSP mapping used by diagnostics, definition, and document symbols. Prove the boundary with direct service tests first, then prove stdio/LSP behavior through the existing protocol harness.

**Tech Stack:** Node.js ESM, dependency-free JSON-RPC/LSP stdio server, existing WXML project graph JSON model, shell verification via `scripts/verify-tree-sitter.sh`, Markdown docs.

---

## File Structure

- Create `server/wxml-language-service.mjs`: pure WXML language-service functions. No process IO, no JSON-RPC writes, no graph extraction, no mutation of server state.
- Create `scripts/verify-wxml-language-service.mjs`: direct service-level verification that imports the service module and calls its exports with fixture graph data.
- Modify `server/wxml-lsp.mjs`: import the service module, delegate diagnostics and definition to it, advertise and handle document symbols.
- Modify `scripts/verify-lsp-diagnostics.mjs`: add protocol-level document symbol helper and scenarios.
- Modify `scripts/verify-tree-sitter.sh`: run the direct service verification alongside existing graph and LSP checks.
- Modify `README.md`: document the language-service boundary and document symbol capability.

## Task 1: Add Direct Language Service Tests First

**Files:**
- Create: `scripts/verify-wxml-language-service.mjs`
- Test: `node scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Create the direct service verification script**

Create `scripts/verify-wxml-language-service.mjs`:

```javascript
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  getDefinition,
  getDiagnostics,
  getDocumentSymbols,
} from "../server/wxml-language-service.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH_EXTRACTOR = path.join(ROOT, "scripts/extract-wxml-project-graph.mjs");
const MINIPROGRAM_ROOT = path.join(ROOT, "fixtures/miniprogram");
const HOME_WXML = path.join(MINIPROGRAM_ROOT, "pages/home/home.wxml");
const USER_CARD_WXML = path.join(MINIPROGRAM_ROOT, "components/user-card/user-card.wxml");
const COMMON_WXML = path.join(MINIPROGRAM_ROOT, "templates/common.wxml");
const USER_CARD_TARGET = path.join(MINIPROGRAM_ROOT, "components/user-card/user-card.wxml");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadGraph() {
  const output = execFileSync(process.execPath, [GRAPH_EXTRACTOR, MINIPROGRAM_ROOT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: process.env.WXML_ZED_HOME || "/private/tmp",
      npm_config_cache: process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache || "/private/tmp/npm-cache",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output);
}

function assertDeepEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${label}: expected ${expectedJson}, got ${actualJson}`);
}

function assertMissingCardDiagnostic(graph) {
  const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
  assert(diagnostics.length === 1, `Expected one missing-card diagnostic, got ${diagnostics.length}`);
  assert(diagnostics[0].severity === 2, `Unexpected severity: ${JSON.stringify(diagnostics[0])}`);
  assert(diagnostics[0].source === "wxml-zed", `Unexpected source: ${JSON.stringify(diagnostics[0])}`);
  assert(diagnostics[0].code === "missing-local-component", `Unexpected code: ${JSON.stringify(diagnostics[0])}`);
  assert(
    diagnostics[0].message === 'Missing local component "missing-card": ../../components/missing-card/missing-card',
    `Unexpected message: ${diagnostics[0].message}`,
  );
  assertDeepEqual(
    diagnostics[0].range,
    { start: { line: 14, character: 2 }, end: { line: 14, character: 43 } },
    "missing-card diagnostic range",
  );
}

function assertDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 7, character: 3 },
    extensionRoot: ROOT,
  });
  assert(location, "Expected user-card definition location");
  assert(location.uri === pathToFileURL(USER_CARD_TARGET).href, `Unexpected definition URI: ${JSON.stringify(location)}`);
  assertDeepEqual(
    location.range,
    { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    "definition range",
  );
}

function assertHomeDocumentSymbols(graph) {
  const symbols = getDocumentSymbols({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
  assert(symbols.length === 3, `Expected 3 home document symbols, got ${symbols.length}: ${JSON.stringify(symbols)}`);
  assertDeepEqual(
    symbols.map((symbol) => [symbol.name, symbol.kind, symbol.detail]),
    [
      ["fixtures/miniprogram/templates/common.wxml", 1, "import"],
      ["fixtures/miniprogram/shared/header.wxml", 1, "include"],
      ["format", 2, "wxs"],
    ],
    "home document symbol identity/order",
  );
  assertDeepEqual(
    symbols.map((symbol) => symbol.range),
    [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 44 } },
      { start: { line: 1, character: 0 }, end: { line: 1, character: 42 } },
      { start: { line: 2, character: 0 }, end: { line: 2, character: 52 } },
    ],
    "home document symbol ranges",
  );
  assertDeepEqual(
    symbols.map((symbol) => symbol.selectionRange),
    symbols.map((symbol) => symbol.range),
    "home document symbol selection ranges",
  );
  assert(symbols.filter((symbol) => symbol.detail?.startsWith("wxs")).length === 1, "Expected one WXS symbol");
}

function assertTemplateDocumentSymbols(graph) {
  const symbols = getDocumentSymbols({ graph, documentPath: COMMON_WXML, extensionRoot: ROOT });
  assert(symbols.length === 1, `Expected one template symbol, got ${symbols.length}: ${JSON.stringify(symbols)}`);
  assertDeepEqual(
    symbols[0],
    {
      name: "loadingRow",
      kind: 12,
      detail: "template",
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
    },
    "template document symbol",
  );
}

function assertComponentUsageExcluded(graph) {
  const symbols = getDocumentSymbols({ graph, documentPath: USER_CARD_WXML, extensionRoot: ROOT });
  assertDeepEqual(symbols, [], "component usage symbols should be excluded");
}

const graph = loadGraph();
assertMissingCardDiagnostic(graph);
assertDefinition(graph);
assertHomeDocumentSymbols(graph);
assertTemplateDocumentSymbols(graph);
assertComponentUsageExcluded(graph);
```

- [ ] **Step 2: Run the direct service verification and confirm red failure**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: FAIL because `server/wxml-language-service.mjs` does not exist yet. A valid failure contains `Cannot find module` for `server/wxml-language-service.mjs`.

- [ ] **Step 3: Commit the failing direct service tests**

```bash
git add scripts/verify-wxml-language-service.mjs
git commit -m "test: add wxml language service verification"
```

## Task 2: Implement the Pure WXML Language Service

**Files:**
- Create: `server/wxml-language-service.mjs`
- Test: `scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Create `server/wxml-language-service.mjs`**

Create `server/wxml-language-service.mjs`:

```javascript
import path from "node:path";
import { pathToFileURL } from "node:url";

const WARNING = 2;
const DOCUMENT_SYMBOL_KIND_FILE = 1;
const DOCUMENT_SYMBOL_KIND_MODULE = 2;
const DOCUMENT_SYMBOL_KIND_FUNCTION = 12;

const ZERO_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

function toPosix(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

export function graphPathForAbsolute(filePath, extensionRoot) {
  return toPosix(path.relative(extensionRoot, path.resolve(filePath)));
}

export function absolutePathForGraphPath(graphPath, extensionRoot) {
  return path.resolve(extensionRoot, graphPath);
}

export function rangeFromSymbolRange(range) {
  return {
    start: {
      line: range.start.row,
      character: range.start.column,
    },
    end: {
      line: range.end.row,
      character: range.end.column,
    },
  };
}

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

export function containsPosition(range, position) {
  const start = symbolPointToLsp(range.start);
  const end = symbolPointToLsp(range.end);
  return isPositionAtOrAfter(position, start) && isPositionBefore(position, end);
}

function rangeKey(range) {
  return `${range.start.row}:${range.start.column}-${range.end.row}:${range.end.column}`;
}

function findWxmlFileModel(graph, documentPath, extensionRoot) {
  const documentGraphPath = graphPathForAbsolute(documentPath, extensionRoot);
  const fileModel = graph.wxml.find((entry) => entry.path === documentGraphPath);
  return { documentGraphPath, fileModel };
}

function locationForGraphPath(graphPath, extensionRoot) {
  return {
    uri: pathToFileURL(absolutePathForGraphPath(graphPath, extensionRoot)).href,
    range: ZERO_RANGE,
  };
}

export function getDiagnostics({ graph, documentPath, extensionRoot }) {
  const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) {
    return [];
  }

  const usedComponents = new Map(fileModel.components.map((component) => [component.tag, component]));
  return graph.unresolved
    .filter((entry) => (
      entry.kind === "component" &&
      entry.owner === documentGraphPath &&
      entry.reason === "missing-file" &&
      usedComponents.has(entry.tag)
    ))
    .map((entry) => {
      const component = usedComponents.get(entry.tag);
      return {
        range: rangeFromSymbolRange(component.range),
        severity: WARNING,
        source: "wxml-zed",
        code: "missing-local-component",
        message: `Missing local component "${entry.tag}": ${entry.value}`,
      };
    });
}

export function getDefinition({ graph, documentPath, position, extensionRoot }) {
  if (!position || typeof position.line !== "number" || typeof position.character !== "number") {
    return null;
  }

  const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) {
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

  return locationForGraphPath(usingComponent.target, extensionRoot);
}

function documentSymbol(name, kind, detail, range) {
  const lspRange = rangeFromSymbolRange(range);
  return {
    name,
    kind,
    detail,
    range: lspRange,
    selectionRange: lspRange,
  };
}

function symbolNameFromDependency(dependency) {
  return dependency.normalized || dependency.value;
}

export function getDocumentSymbols({ graph, documentPath, extensionRoot }) {
  const { fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) {
    return [];
  }

  const symbols = [];
  const wxsSymbolRanges = new Set();

  for (const symbol of fileModel.symbols) {
    if (symbol.kind === "template") {
      symbols.push(documentSymbol(symbol.name, DOCUMENT_SYMBOL_KIND_FUNCTION, "template", symbol.range));
    }
    if (symbol.kind === "wxs") {
      wxsSymbolRanges.add(rangeKey(symbol.range));
      symbols.push(documentSymbol(symbol.name, DOCUMENT_SYMBOL_KIND_MODULE, "wxs", symbol.range));
    }
  }

  for (const dependency of fileModel.dependencies) {
    if (dependency.kind === "import") {
      symbols.push(documentSymbol(symbolNameFromDependency(dependency), DOCUMENT_SYMBOL_KIND_FILE, "import", dependency.range));
    }
    if (dependency.kind === "include") {
      symbols.push(documentSymbol(symbolNameFromDependency(dependency), DOCUMENT_SYMBOL_KIND_FILE, "include", dependency.range));
    }
    if (dependency.kind === "wxs" && !wxsSymbolRanges.has(rangeKey(dependency.range))) {
      symbols.push(documentSymbol(dependency.module || symbolNameFromDependency(dependency), DOCUMENT_SYMBOL_KIND_MODULE, "wxs external", dependency.range));
    }
  }

  return symbols.sort((left, right) => (
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character
  ));
}
```

- [ ] **Step 2: Run direct service verification**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: PASS with exit code 0. Tree-sitter parser directory warnings may appear from the graph extractor, but the script must exit 0.

- [ ] **Step 3: Run syntax check**

Run:

```bash
node --check server/wxml-language-service.mjs
node --check scripts/verify-wxml-language-service.mjs
```

Expected: both commands exit 0.

- [ ] **Step 4: Commit the service implementation**

```bash
git add server/wxml-language-service.mjs
git commit -m "feat: add wxml language service module"
```

## Task 3: Add Protocol Document Symbol Tests First

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`
- Test: `scripts/verify-lsp-diagnostics.mjs`

- [ ] **Step 1: Add fixture constants**

Near the existing fixture constants, add:

```javascript
const COMMON_WXML = path.join(MINIPROGRAM_ROOT, "templates/common.wxml");
```

- [ ] **Step 2: Add document symbol assertion helpers**

After `assertNullDefinition`, add:

```javascript
function assertDeepEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${label}: expected ${expectedJson}, got ${actualJson}`);
}

function assertHomeDocumentSymbols(symbols) {
  assert(Array.isArray(symbols), `Expected document symbols array, got ${JSON.stringify(symbols)}`);
  assert(symbols.length === 3, `Expected 3 home document symbols, got ${symbols.length}: ${JSON.stringify(symbols)}`);
  assertDeepEqual(
    symbols.map((symbol) => [symbol.name, symbol.kind, symbol.detail]),
    [
      ["fixtures/miniprogram/templates/common.wxml", 1, "import"],
      ["fixtures/miniprogram/shared/header.wxml", 1, "include"],
      ["format", 2, "wxs"],
    ],
    "home document symbol identity/order",
  );
  assertDeepEqual(
    symbols.map((symbol) => symbol.range),
    [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 44 } },
      { start: { line: 1, character: 0 }, end: { line: 1, character: 42 } },
      { start: { line: 2, character: 0 }, end: { line: 2, character: 52 } },
    ],
    "home document symbol ranges",
  );
  assertDeepEqual(
    symbols.map((symbol) => symbol.selectionRange),
    symbols.map((symbol) => symbol.range),
    "home document symbol selection ranges",
  );
  assert(symbols.filter((symbol) => symbol.detail?.startsWith("wxs")).length === 1, "Expected one WXS symbol");
}

function assertTemplateDocumentSymbols(symbols) {
  assert(Array.isArray(symbols), `Expected document symbols array, got ${JSON.stringify(symbols)}`);
  assert(symbols.length === 1, `Expected one template symbol, got ${symbols.length}: ${JSON.stringify(symbols)}`);
  assertDeepEqual(
    symbols[0],
    {
      name: "loadingRow",
      kind: 12,
      detail: "template",
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
    },
    "template document symbol",
  );
}
```

- [ ] **Step 3: Add `documentSymbols()` to `LspClient`**

Inside `class LspClient`, after `definition(filePath, position)`, add:

```javascript
async documentSymbols(filePath) {
  const id = this.request("textDocument/documentSymbol", {
    textDocument: { uri: pathToFileURL(filePath).href },
  });
  const response = await this.waitForResponse(id);
  if (response.error) {
    throw new Error(`Document symbol request failed: ${JSON.stringify(response.error)}`);
  }
  return response.result;
}
```

- [ ] **Step 4: Assert document symbol capability**

In `LspClient.initialize()`, after the `definitionProvider` assertion, add:

```javascript
assert(response.result?.capabilities?.documentSymbolProvider === true, "documentSymbolProvider not advertised");
```

- [ ] **Step 5: Add protocol scenarios**

Add these functions before the `scenarios` array:

```javascript
async function testHomeDocumentSymbols() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before document symbols");
    const result = await client.documentSymbols(HOME_WXML);
    assertHomeDocumentSymbols(result);
  });
}

async function testTemplateDocumentSymbols() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const result = await client.documentSymbols(COMMON_WXML);
    assertTemplateDocumentSymbols(result);
  });
}

async function testComponentUsageDocumentSymbolsExcluded() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const result = await client.documentSymbols(USER_CARD_WXML);
    assertDeepEqual(result, [], "component usage document symbols");
  });
}

async function testDocumentSymbolsBuildGraphWithoutPriorDiagnostics() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const result = await client.documentSymbols(HOME_WXML);
    assertHomeDocumentSymbols(result);
  });
}

async function testDocumentSymbolsBuildDoesNotBlockRequestLoop() {
  await withClient({
    rootPath: ROOT,
    env: {
      WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
    },
  }, async (client) => {
    const symbolsPromise = client.documentSymbols(HOME_WXML);
    const id = client.request("workspace/symbol", { query: "format" });
    const response = await client.waitForResponse(id);
    assert(response.error?.code === -32601, `Expected responsive -32601, got ${JSON.stringify(response)}`);
    assertHomeDocumentSymbols(await symbolsPromise);
  });
}
```

- [ ] **Step 6: Register scenarios**

Add these entries near the start of `scenarios`, after the existing definition scenarios and before diagnostics scenarios:

```javascript
["home document symbols", testHomeDocumentSymbols],
["template document symbols", testTemplateDocumentSymbols],
["component usage document symbols excluded", testComponentUsageDocumentSymbolsExcluded],
["document symbols build graph without prior diagnostics", testDocumentSymbolsBuildGraphWithoutPriorDiagnostics],
["document symbols build does not block request loop", testDocumentSymbolsBuildDoesNotBlockRequestLoop],
```

- [ ] **Step 7: Run the protocol harness and confirm red failure**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: FAIL before server protocol support. A valid failure mentions `documentSymbolProvider not advertised` or `textDocument/documentSymbol` method not found.

- [ ] **Step 8: Commit the failing protocol tests**

```bash
git add scripts/verify-lsp-diagnostics.mjs
git commit -m "test: add wxml document symbol protocol harness"
```

## Task 4: Wire the LSP Server Through the Language Service

**Files:**
- Modify: `server/wxml-lsp.mjs`
- Test: `scripts/verify-lsp-diagnostics.mjs`
- Test: `scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Import language-service functions**

At the top of `server/wxml-lsp.mjs`, remove `pathToFileURL` from the `node:url` import and add:

```javascript
import {
  getDefinition,
  getDiagnostics,
  getDocumentSymbols,
} from "./wxml-language-service.mjs";
```

The URL import should become:

```javascript
import { fileURLToPath } from "node:url";
```

- [ ] **Step 2: Remove feature-mapping constants and helpers from the server**

Delete these server-local items because they now live in `server/wxml-language-service.mjs`:

```javascript
const WARNING = 2;
function toPosix(filePath)
function graphPathForAbsolute(filePath)
function rangeFromSymbolRange(range)
const ZERO_RANGE
function isPositionBefore(position, boundary)
function isPositionAtOrAfter(position, boundary)
function symbolPointToLsp(point)
function containsPosition(range, position)
function absolutePathForGraphPath(graphPath)
function locationForGraphPath(graphPath)
function diagnosticsForDocument(graph, documentPath)
function definitionForDocument(graph, documentPath, position)
```

Keep `fileUriToPath`, `publishDiagnostics`, root resolution, graph scheduling, and request handlers in `server/wxml-lsp.mjs`.

- [ ] **Step 3: Delegate diagnostics to the service**

In `runGraphBuild(projectRoot)`, replace:

```javascript
publishPendingDiagnostics(projectRoot, (_uri, documentPath) => (
  diagnosticsForDocument(graph, documentPath)
));
```

with:

```javascript
publishPendingDiagnostics(projectRoot, (_uri, documentPath) => (
  getDiagnostics({ graph, documentPath, extensionRoot: EXTENSION_ROOT })
));
```

- [ ] **Step 4: Delegate definition to the service**

In `definitionForRequest(params)`, replace:

```javascript
return definitionForDocument(graph, documentPath, params?.position);
```

with:

```javascript
return getDefinition({
  graph,
  documentPath,
  position: params?.position,
  extensionRoot: EXTENSION_ROOT,
});
```

- [ ] **Step 5: Add document symbol request helpers**

After `handleDefinitionRequest(id, params)`, add:

```javascript
async function documentSymbolsForRequest(params) {
  const documentPath = fileUriToPath(params?.textDocument?.uri);
  if (!documentPath) {
    return [];
  }

  const projectRoot = resolveMiniProgramRoot(documentPath);
  if (!projectRoot) {
    logDiagnosticError(`No app.json found for ${documentPath}`);
    return [];
  }

  const graph = await ensureGraphForRequest(projectRoot);
  if (!graph) {
    return [];
  }

  return getDocumentSymbols({
    graph,
    documentPath,
    extensionRoot: EXTENSION_ROOT,
  });
}

async function handleDocumentSymbolRequest(id, params) {
  try {
    respond(id, await documentSymbolsForRequest(params));
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    respond(id, []);
  }
}
```

- [ ] **Step 6: Advertise document symbol capability**

In `initialize(params)`, add `documentSymbolProvider: true` next to `definitionProvider: true`:

```javascript
capabilities: {
  textDocumentSync: {
    openClose: true,
    change: 0,
    save: true,
  },
  definitionProvider: true,
  documentSymbolProvider: true,
},
```

- [ ] **Step 7: Wire `textDocument/documentSymbol`**

In `handleMessage(message)`, add this case after `textDocument/definition`:

```javascript
case "textDocument/documentSymbol":
  handleDocumentSymbolRequest(message.id, message.params);
  break;
```

Do not `await` in `handleMessage`.

- [ ] **Step 8: Run focused verification**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
node scripts/verify-lsp-diagnostics.mjs
```

Expected: both commands pass. The LSP harness should pass diagnostics, definition, and document symbol scenarios.

- [ ] **Step 9: Run syntax checks**

Run:

```bash
node --check server/wxml-language-service.mjs
node --check server/wxml-lsp.mjs
node --check scripts/verify-wxml-language-service.mjs
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: all commands exit 0.

- [ ] **Step 10: Check server no longer owns feature mapping**

Run:

```bash
rg -n "function diagnosticsForDocument|function definitionForDocument|function getDocumentSymbols|DOCUMENT_SYMBOL_KIND|const WARNING|pathToFileURL" server/wxml-lsp.mjs
```

Expected: no matches. `server/wxml-lsp.mjs` should import feature mapping from `server/wxml-language-service.mjs`.

- [ ] **Step 11: Commit the LSP integration**

```bash
git add server/wxml-lsp.mjs scripts/verify-lsp-diagnostics.mjs
git commit -m "feat: add wxml document symbols through language service"
```

## Task 5: Integrate Verification Script and Documentation

**Files:**
- Modify: `scripts/verify-tree-sitter.sh`
- Modify: `README.md`
- Test: `scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Add service verification to `scripts/verify-tree-sitter.sh`**

Find the section that runs project graph and LSP checks. Add this command before `node "$ROOT_DIR/scripts/verify-lsp-diagnostics.mjs"`:

```bash
node "$ROOT_DIR/scripts/verify-wxml-language-service.mjs"
```

This ensures the direct service boundary check runs in the full verification path.

- [ ] **Step 2: Update README feature matrix**

In `README.md`, add these rows near the existing LSP rows:

```markdown
| Internal WXML language-service boundary for LSP features | Yes |
| Prototype LSP document symbols for WXML declarations and dependencies | Yes |
```

- [ ] **Step 3: Update README verification paragraph**

Update the development verification paragraph so it mentions both the direct service check and LSP document symbols:

```markdown
The script parses `fixtures/test.wxml`, runs the grammar corpus tests, validates
the highlight, outline, text object, injection, and bracket queries, checks the
focused WXS, tag-editing, and real-world compatibility fixtures, and asserts
baseline snippet keys plus the pre-LSP dependency, symbol, and project graph
models. It also verifies the pure WXML language-service mapping layer and starts
the prototype WXML language server over stdio to verify missing local component
diagnostics, resolved local component go-to-definition, and flat document
symbols for WXML declaration/dependency entries.
```

- [ ] **Step 4: Update README high-level scope sentence**

Replace the `Scope` section's first paragraph with:

```markdown
This baseline is syntax-level editor support plus narrow prototype LSP behavior:
missing local component diagnostics, go-to-definition for resolved local WXML
component tags, and flat document symbols for WXML declaration/dependency
entries. It intentionally does not provide symbol indexing,
template/import/include/WXS navigation, completion, hover, nested structural
document symbols, semantic tokens, code actions, formatting, file watching,
npm/plugin component resolution, `componentGenerics`, `subPackages`, or
production Node runtime packaging.
```

- [ ] **Step 5: Update README LSP paragraph**

In the `Scope` section, update the `server/wxml-lsp.mjs` paragraph to include the language-service boundary and document symbol limits:

```markdown
`server/wxml-lsp.mjs` is a minimal stdio LSP prototype and protocol host. WXML
feature mapping lives in `server/wxml-language-service.mjs`, which converts the
project graph into diagnostics, definitions, and document symbols without
owning JSON-RPC IO or graph scheduling. The LSP reports local `usingComponents`
entries that resolve to a missing file and are also used as custom component
tags in the current WXML file. It supports go-to-definition from resolved local
custom component tags to their target `.wxml` files, and returns a flat
document-symbol list for WXML declaration/dependency entries such as template
definitions, WXS modules, imports, and includes. For the baseline fixture this
reports `missing-card` in `pages/home/home.wxml`, resolves `<user-card>` to
`components/user-card/user-card.wxml`, and returns document symbols for the
`import`, `include`, and `wxs` entries in `pages/home/home.wxml`. Diagnostics
still run on open/save only; there is no file watching, incremental parsing,
nested structural document symbols, component usage symbols, JSON document
symbols, template/import/include/WXS navigation, npm/plugin component
navigation, or `componentGenerics` support.
```

- [ ] **Step 6: Add project layout entry**

In `Project Layout`, add:

```markdown
- `server/wxml-language-service.mjs`: pure graph-to-LSP feature mapping for the Node LSP prototype.
- `scripts/verify-wxml-language-service.mjs`: direct verification for the WXML language-service boundary.
```

- [ ] **Step 7: Update LSP harness project layout entry**

In `Project Layout`, replace:

```markdown
- `scripts/verify-lsp-diagnostics.mjs`: protocol-level LSP diagnostics harness.
```

with:

```markdown
- `scripts/verify-lsp-diagnostics.mjs`: protocol-level LSP harness for diagnostics, definition, and document symbols.
```

- [ ] **Step 8: Check README wording**

Run:

```bash
rg -n "language-service|document symbols|document-symbol|nested structural|component usage|verify-wxml-language-service|protocol-level LSP harness" README.md
```

Expected: matches show the new capability, boundary, verification script, harness description, and exclusions. There must be no sentence claiming document symbols are entirely unsupported.

- [ ] **Step 9: Run full verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 and final output includes:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 10: Commit docs and verification integration**

```bash
git add scripts/verify-tree-sitter.sh README.md
git commit -m "docs: document wxml language service document symbols"
```

## Task 6: Final Verification and Review

**Files:**
- Verify: `server/wxml-language-service.mjs`
- Verify: `server/wxml-lsp.mjs`
- Verify: `scripts/verify-wxml-language-service.mjs`
- Verify: `scripts/verify-lsp-diagnostics.mjs`
- Verify: `scripts/verify-tree-sitter.sh`
- Verify: `README.md`

- [ ] **Step 1: Run focused direct service verification**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: exit code 0.

- [ ] **Step 2: Run focused protocol verification**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: exit code 0 with diagnostics, definition, and document symbol scenarios.

- [ ] **Step 3: Run syntax checks**

Run:

```bash
node --check server/wxml-language-service.mjs
node --check server/wxml-lsp.mjs
node --check scripts/verify-wxml-language-service.mjs
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: all commands exit 0.

- [ ] **Step 4: Run full verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 and final output includes:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 5: Review changed file scope**

Run:

```bash
git diff --stat main..HEAD
git diff --name-only main..HEAD
```

Expected changed files only include:

```text
README.md
scripts/verify-lsp-diagnostics.mjs
scripts/verify-tree-sitter.sh
scripts/verify-wxml-language-service.mjs
server/wxml-language-service.mjs
server/wxml-lsp.mjs
```

- [ ] **Step 6: Review boundary markers**

Run:

```bash
rg -n "getDiagnostics|getDefinition|getDocumentSymbols|documentSymbolProvider|textDocument/documentSymbol|verify-wxml-language-service" server scripts README.md
rg -n "function diagnosticsForDocument|function definitionForDocument|DOCUMENT_SYMBOL_KIND|const WARNING|pathToFileURL" server/wxml-lsp.mjs
```

Expected:

- The first command prints service exports, server imports/usages, protocol wiring, and verification docs.
- The second command prints no matches.

- [ ] **Step 7: Request code review before merging**

Use `superpowers:requesting-code-review` with:

- Description: WXML LSP language-service boundary and document symbols baseline.
- Requirements: this plan plus `docs/superpowers/specs/2026-05-13-wxml-lsp-language-service-boundary-document-symbols-design.md`.
- Base SHA: the commit before Task 1.
- Head SHA: current branch head.
