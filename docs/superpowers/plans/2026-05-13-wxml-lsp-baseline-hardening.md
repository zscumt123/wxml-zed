# WXML LSP Baseline Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the WXML LSP diagnostics prototype with async graph scheduling, lifecycle cleanup, broader protocol tests, and local Zed development docs.

**Architecture:** Keep the LSP server dependency-free and centered in `server/wxml-lsp.mjs`. Add a small per-root graph scheduler with generation guards so stale graph builds cannot republish diagnostics after a newer save. Expand the existing stdio harness before implementation so lifecycle, refresh, request responsiveness, and no-concurrent-build behavior are proven by protocol tests.

**Tech Stack:** Node.js ESM, JSON-RPC/LSP stdio framing, `child_process.execFile`, local shell verification through `scripts/verify-tree-sitter.sh`, Markdown docs.

---

## File Structure

- Modify `scripts/verify-lsp-diagnostics.mjs`: turn the single-case harness into reusable protocol test helpers and add failing tests for root variants, clean files, didClose clearing, didSave refresh, unsupported requests, and async coalescing.
- Modify `server/wxml-lsp.mjs`: replace `execFileSync` with async `execFile`, add per-root graph state, generation guards, pending diagnostics tracking, didClose handling, and test-only delay/counter hooks.
- Modify `README.md`: document async graph scheduling, Zed Restricted Mode trust, reload/restart behavior, and the prototype boundary.
- No new runtime dependencies.

## Task 1: Expand the LSP Protocol Harness First

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`
- Test: `scripts/verify-lsp-diagnostics.mjs`

- [ ] **Step 1: Replace the single-case harness with reusable protocol helpers and the full scenario list**

Replace `scripts/verify-lsp-diagnostics.mjs` with this structure. Keep the existing exact `missing-card` assertions, but parameterize the fixture path so temp projects can reuse the same range check.

```javascript
#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server/wxml-lsp.mjs");
const MINIPROGRAM_ROOT = path.join(ROOT, "fixtures/miniprogram");
const HOME_WXML = path.join(MINIPROGRAM_ROOT, "pages/home/home.wxml");
const USER_CARD_WXML = path.join(MINIPROGRAM_ROOT, "components/user-card/user-card.wxml");
const TIMEOUT_MS = 30_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createMessageReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/Content-Length: (\d+)/iu);
      assert(match, `Missing Content-Length header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) return;
      const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.subarray(bodyEnd);
      onMessage(JSON.parse(body));
    }
  };
}

function writeMessage(stream, message) {
  const body = JSON.stringify(message);
  stream.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function lineCharToOffset(text, position) {
  const lines = text.split("\n");
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    offset += lines[line].length + 1;
  }
  return offset + position.character;
}

function assertMissingCardDiagnostic(diagnostic, sourceFile) {
  assert(diagnostic, "Missing diagnostic");
  assert(diagnostic.severity === 2, `Expected warning severity, got ${diagnostic.severity}`);
  assert(diagnostic.source === "wxml-zed", `Unexpected diagnostic source: ${diagnostic.source}`);
  assert(diagnostic.code === "missing-local-component", `Unexpected diagnostic code: ${diagnostic.code}`);
  assert(
    diagnostic.message === 'Missing local component "missing-card": ../../components/missing-card/missing-card',
    `Unexpected diagnostic message: ${diagnostic.message}`,
  );
  const expectedRange = {
    start: { line: 14, character: 2 },
    end: { line: 14, character: 43 },
  };
  assert(
    JSON.stringify(diagnostic.range) === JSON.stringify(expectedRange),
    `Unexpected diagnostic range: ${JSON.stringify(diagnostic.range)}`,
  );
  const text = fs.readFileSync(sourceFile, "utf8");
  const start = lineCharToOffset(text, diagnostic.range.start);
  const end = lineCharToOffset(text, diagnostic.range.end);
  assert(
    text.slice(start, end) === '<missing-card reason="{{emptyReason}}" />',
    `Diagnostic is not attached to missing-card in ${sourceFile}`,
  );
}
```

- [ ] **Step 2: Add an `LspClient` helper**

Append this helper to the same file. It owns server lifecycle, response waiting, diagnostics waiting, and clean shutdown for each scenario.

```javascript
class LspClient {
  constructor({ rootPath, env = {} }) {
    this.rootPath = rootPath;
    this.env = env;
    this.nextId = 1;
    this.stderr = "";
    this.responses = new Map();
    this.diagnostics = [];
    this.waiters = [];
  }

  start() {
    this.server = spawn("node", [SERVER], {
      cwd: ROOT,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.server.stdout.on("data", createMessageReader((message) => this.handleMessage(message)));
    this.server.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.server.on("exit", (code, signal) => {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error(`LSP exited unexpectedly: ${JSON.stringify({ code, signal })}\n${this.stderr}`));
      }
    });
  }

  handleMessage(message) {
    if (Object.hasOwn(message, "id")) {
      this.responses.set(message.id, message);
    }
    if (message.method === "textDocument/publishDiagnostics") {
      this.diagnostics.push(message.params);
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      }
    }
  }

  send(method, params, id = undefined) {
    const message = { jsonrpc: "2.0", method, params };
    if (id !== undefined) message.id = id;
    writeMessage(this.server.stdin, message);
    return id;
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    this.send(method, params, id);
    return id;
  }

  waitFor(predicate, label) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item.reject !== reject);
        reject(new Error(`Timed out waiting for ${label}. stderr:\n${this.stderr}`));
      }, TIMEOUT_MS);
      this.waiters.push({ predicate, resolve, reject, timeout });
    });
  }

  waitForResponse(id) {
    const existing = this.responses.get(id);
    if (existing) return Promise.resolve(existing);
    return this.waitFor((message) => message.id === id, `response ${id}`);
  }

  waitForDiagnostics(uri, predicate, label) {
    const existing = this.diagnostics.find((params) => params.uri === uri && predicate(params.diagnostics));
    if (existing) return Promise.resolve(existing);
    return this.waitFor(
      (message) => (
        message.method === "textDocument/publishDiagnostics" &&
        message.params.uri === uri &&
        predicate(message.params.diagnostics)
      ),
      label,
    ).then((message) => message.params);
  }

  async initialize() {
    const rootUri = pathToFileURL(this.rootPath).href;
    const id = this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootPath) }],
      capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } } },
    });
    const response = await this.waitForResponse(id);
    assert(response.result?.capabilities?.textDocumentSync?.openClose === true, "openClose sync not advertised");
    assert(response.result?.capabilities?.textDocumentSync?.save === true, "save sync not advertised");
    assert(response.result?.capabilities?.textDocumentSync?.change === 0, "incremental sync should be disabled");
    this.send("initialized", {});
  }

  openDocument(filePath, version = 1) {
    const uri = pathToFileURL(filePath).href;
    this.send("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "wxml",
        version,
        text: fs.readFileSync(filePath, "utf8"),
      },
    });
    return uri;
  }

  saveDocument(filePath) {
    const uri = pathToFileURL(filePath).href;
    this.send("textDocument/didSave", { textDocument: { uri } });
    return uri;
  }

  closeDocument(filePath) {
    const uri = pathToFileURL(filePath).href;
    this.send("textDocument/didClose", { textDocument: { uri } });
    return uri;
  }

  async shutdown() {
    const id = this.request("shutdown", null);
    await this.waitForResponse(id);
    this.send("exit", {});
  }
}
```

- [ ] **Step 3: Add the failing test scenarios**

Append scenario functions and `main()`. These should fail against the current server because `didClose` is unsupported, async behavior is not implemented, and the harness expects more cases.

```javascript
async function withClient(options, run) {
  const client = new LspClient(options);
  client.start();
  try {
    await client.initialize();
    await run(client);
    await client.shutdown();
  } finally {
    if (!client.server.killed) {
      client.server.kill("SIGKILL");
    }
  }
}

async function testRepositoryRootInitialization() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    const params = await client.waitForDiagnostics(uri, (items) => items.length === 1, "repo-root diagnostics");
    assertMissingCardDiagnostic(params.diagnostics[0], HOME_WXML);
  });
}

async function testMiniProgramRootInitialization() {
  await withClient({ rootPath: MINIPROGRAM_ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    const params = await client.waitForDiagnostics(uri, (items) => items.length === 1, "miniprogram-root diagnostics");
    assertMissingCardDiagnostic(params.diagnostics[0], HOME_WXML);
  });
}

async function testCleanComponentFile() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(USER_CARD_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 0, "clean component diagnostics");
  });
}

async function testDidCloseClearsDiagnostics() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "open diagnostics before close");
    client.closeDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 0, "didClose empty diagnostics");
  });
}

async function testDidSaveRefreshClearsFixedComponent() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wxml-zed-lsp-refresh-"));
  try {
    fs.cpSync(MINIPROGRAM_ROOT, tempRoot, { recursive: true });
    const tempHome = path.join(tempRoot, "pages/home/home.wxml");
    await withClient({ rootPath: tempRoot }, async (client) => {
      const uri = client.openDocument(tempHome);
      const first = await client.waitForDiagnostics(uri, (items) => items.length === 1, "temp missing-card diagnostics");
      assertMissingCardDiagnostic(first.diagnostics[0], tempHome);

      const missingDir = path.join(tempRoot, "components/missing-card");
      fs.mkdirSync(missingDir, { recursive: true });
      fs.writeFileSync(path.join(missingDir, "missing-card.wxml"), "<view />\n");
      fs.writeFileSync(path.join(missingDir, "missing-card.json"), "{\"component\":true}\n");

      client.saveDocument(tempHome);
      await client.waitForDiagnostics(uri, (items) => items.length === 0, "didSave refresh diagnostics");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testUnsupportedRequest() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const id = client.request("workspace/symbol", { query: "missing-card" });
    const response = await client.waitForResponse(id);
    assert(response.error?.code === -32601, `Expected -32601, got ${JSON.stringify(response)}`);
  });
}

function parseCounterEvents(counterFile) {
  return fs.readFileSync(counterFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertNoConcurrentExtractor(events) {
  let active = 0;
  let maxActive = 0;
  for (const event of events) {
    if (event.event === "start") active += 1;
    if (event.event === "end") active -= 1;
    maxActive = Math.max(maxActive, active);
  }
  assert(maxActive <= 1, `Expected no concurrent graph extractors, saw ${maxActive}: ${JSON.stringify(events)}`);
}

async function testAsyncCoalescingAndResponsiveness() {
  const counterFile = path.join(os.tmpdir(), `wxml-zed-lsp-counter-${process.pid}.jsonl`);
  fs.rmSync(counterFile, { force: true });
  await withClient({
    rootPath: ROOT,
    env: {
      WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
      WXML_ZED_LSP_GRAPH_COUNTER_FILE: counterFile,
    },
  }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    client.saveDocument(HOME_WXML);
    client.saveDocument(HOME_WXML);

    const id = client.request("workspace/symbol", { query: "missing-card" });
    const response = await client.waitForResponse(id);
    assert(response.error?.code === -32601, `Expected responsive -32601, got ${JSON.stringify(response)}`);

    await client.waitForDiagnostics(uri, (items) => items.length === 1, "coalesced diagnostics");
    assertNoConcurrentExtractor(parseCounterEvents(counterFile));
  });
  fs.rmSync(counterFile, { force: true });
}

async function main() {
  await testRepositoryRootInitialization();
  await testMiniProgramRootInitialization();
  await testCleanComponentFile();
  await testDidCloseClearsDiagnostics();
  await testDidSaveRefreshClearsFixedComponent();
  await testUnsupportedRequest();
  await testAsyncCoalescingAndResponsiveness();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
```

- [ ] **Step 4: Run the harness and confirm it fails for the expected reasons**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: FAIL before server changes. The failure may be a timeout on `didClose` clearing or async coalescing. This proves the new harness protects behavior the current server does not implement.

- [ ] **Step 5: Commit the failing harness**

```bash
git add scripts/verify-lsp-diagnostics.mjs
git commit -m "test: expand wxml lsp diagnostics harness"
```

## Task 2: Implement Async Graph Scheduling and LSP Close Handling

**Files:**
- Modify: `server/wxml-lsp.mjs`
- Test: `scripts/verify-lsp-diagnostics.mjs`

- [ ] **Step 1: Replace the child_process import and add async helpers**

Change the top of `server/wxml-lsp.mjs` from:

```javascript
import { execFileSync } from "node:child_process";
```

to:

```javascript
import { execFile } from "node:child_process";
```

Add these helpers after the constants:

```javascript
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendCounterEvent(projectRoot, event) {
  const counterFile = process.env.WXML_ZED_LSP_GRAPH_COUNTER_FILE;
  if (!counterFile) return;
  fs.appendFileSync(
    counterFile,
    `${JSON.stringify({ event, projectRoot, time: Date.now(), pid: process.pid })}\n`,
  );
}

function graphExtractorEnv() {
  return {
    ...process.env,
    HOME: process.env.WXML_ZED_HOME || "/private/tmp",
    npm_config_cache: process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache || "/private/tmp/npm-cache",
  };
}
```

- [ ] **Step 2: Add server state maps**

Replace:

```javascript
let rootCandidates = [];
```

with:

```javascript
let rootCandidates = [];
const openDocuments = new Map();
const graphsByRoot = new Map();
const buildStateByRoot = new Map();
const pendingDiagnosticsByRoot = new Map();
```

Add these helpers near the state:

```javascript
function stateForRoot(projectRoot) {
  let state = buildStateByRoot.get(projectRoot);
  if (!state) {
    state = {
      running: false,
      queued: false,
      activeGeneration: 0,
      latestGeneration: 0,
    };
    buildStateByRoot.set(projectRoot, state);
  }
  return state;
}

function pendingForRoot(projectRoot) {
  let pending = pendingDiagnosticsByRoot.get(projectRoot);
  if (!pending) {
    pending = new Map();
    pendingDiagnosticsByRoot.set(projectRoot, pending);
  }
  return pending;
}
```

- [ ] **Step 3: Replace synchronous graph extraction with async extraction**

Delete `buildProjectGraph(projectRoot)` and replace it with:

```javascript
async function buildProjectGraph(projectRoot) {
  const delayMs = Number(process.env.WXML_ZED_LSP_GRAPH_DELAY_MS || 0);
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  appendCounterEvent(projectRoot, "start");
  try {
    const output = await new Promise((resolve, reject) => {
      execFile(process.execPath, [GRAPH_EXTRACTOR, projectRoot], {
        cwd: EXTENSION_ROOT,
        encoding: "utf8",
        env: graphExtractorEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, (error, stdout, stderr) => {
        if (error) {
          error.message = stderr ? `${error.message}\n${stderr}` : error.message;
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });
    return JSON.parse(output);
  } finally {
    appendCounterEvent(projectRoot, "end");
  }
}
```

- [ ] **Step 4: Add pending diagnostics publishing helpers**

Add these functions after `diagnosticsForDocument`:

```javascript
function publishDiagnosticsForRoot(projectRoot, graph, generation) {
  const pending = pendingDiagnosticsByRoot.get(projectRoot);
  if (!pending) return;

  for (const [uri, requestedGeneration] of [...pending.entries()]) {
    if (requestedGeneration > generation) continue;
    const document = openDocuments.get(uri);
    pending.delete(uri);
    if (!document) continue;
    publishDiagnostics(uri, diagnosticsForDocument(graph, document.path));
  }
}

function publishEmptyDiagnosticsForRoot(projectRoot, generation) {
  const pending = pendingDiagnosticsByRoot.get(projectRoot);
  if (!pending) return;

  for (const [uri, requestedGeneration] of [...pending.entries()]) {
    if (requestedGeneration > generation) continue;
    pending.delete(uri);
    if (openDocuments.has(uri)) {
      publishDiagnostics(uri, []);
    }
  }
}

function removePendingUri(uri) {
  for (const pending of pendingDiagnosticsByRoot.values()) {
    pending.delete(uri);
  }
}
```

- [ ] **Step 5: Add the per-root build pump**

Add this async function after the publishing helpers:

```javascript
async function runGraphBuild(projectRoot) {
  const state = stateForRoot(projectRoot);
  if (state.running) {
    state.queued = true;
    return;
  }

  state.running = true;
  state.queued = false;
  state.activeGeneration = state.latestGeneration;
  const generation = state.activeGeneration;

  try {
    const graph = await buildProjectGraph(projectRoot);
    if (generation === state.latestGeneration) {
      graphsByRoot.set(projectRoot, graph);
      publishDiagnosticsForRoot(projectRoot, graph, generation);
    } else {
      state.queued = true;
    }
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    if (generation === state.latestGeneration) {
      publishEmptyDiagnosticsForRoot(projectRoot, generation);
    } else {
      state.queued = true;
    }
  } finally {
    state.running = false;
    if (state.queued) {
      queueMicrotask(() => {
        runGraphBuild(projectRoot).catch((error) => {
          logDiagnosticError(error instanceof Error ? error.message : String(error));
        });
      });
    }
  }
}
```

- [ ] **Step 6: Replace direct diagnostics with a scheduler**

Delete `runDiagnostics(uri)` and replace it with:

```javascript
function scheduleDiagnostics(uri) {
  const documentPath = fileUriToPath(uri);
  if (!documentPath) return;

  openDocuments.set(uri, { path: documentPath });

  const projectRoot = resolveMiniProgramRoot(documentPath);
  if (!projectRoot) {
    logDiagnosticError(`No app.json found for ${documentPath}`);
    publishDiagnostics(uri, []);
    return;
  }

  const state = stateForRoot(projectRoot);
  state.latestGeneration += 1;
  pendingForRoot(projectRoot).set(uri, state.latestGeneration);

  runGraphBuild(projectRoot).catch((error) => {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    publishDiagnostics(uri, []);
  });
}

function closeDocument(uri) {
  if (!uri) return;
  openDocuments.delete(uri);
  removePendingUri(uri);
  publishDiagnostics(uri, []);
}
```

- [ ] **Step 7: Wire didOpen, didSave, and didClose**

In `handleMessage`, replace the `didOpen` and `didSave` cases with:

```javascript
case "textDocument/didOpen":
  scheduleDiagnostics(message.params?.textDocument?.uri);
  break;

case "textDocument/didSave":
  scheduleDiagnostics(message.params?.textDocument?.uri);
  break;

case "textDocument/didClose":
  closeDocument(message.params?.textDocument?.uri);
  break;
```

- [ ] **Step 8: Run the LSP harness**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: PASS.

- [ ] **Step 9: Confirm synchronous extraction is gone**

Run:

```bash
rg -n "execFileSync|runDiagnostics\\(" server/wxml-lsp.mjs
```

Expected: no matches.

- [ ] **Step 10: Commit the server implementation**

```bash
git add server/wxml-lsp.mjs
git commit -m "feat: harden wxml lsp graph scheduling"
```

## Task 3: Document the Hardened Prototype Boundary

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the LSP description in README**

In the `Develop` section, replace the paragraph beginning with `The prototype LSP requires` with:

```markdown
The prototype LSP requires `node` on `PATH`. The Zed extension glue launches the
Node stdio server through `language_server_command`; it does not package a Node
runtime. The server builds the mini program project graph asynchronously on
open/save, caches the latest graph by mini program root, and coalesces repeated
same-root diagnostic requests so graph extraction does not block the LSP message
loop.
```

- [ ] **Step 2: Add Zed trust and reload notes**

After the local grammar checkout paragraph, add:

```markdown
For local LSP development in Zed:

- If the worktree opens in Restricted Mode, trust the worktree before expecting
  `wxml-lsp` diagnostics. Zed will not start the language server for an
  untrusted worktree.
- If changes to `server/wxml-lsp.mjs` do not appear immediately, run
  `zed: reload extensions`; if the old server process is still active, restart
  Zed.
- LSP diagnostics currently run on open/save only. There is no file watcher and
  no per-keystroke graph rebuild.
```

- [ ] **Step 3: Update the scope note for `server/wxml-lsp.mjs`**

Replace the `server/wxml-lsp.mjs` paragraph in `Scope` with:

```markdown
`server/wxml-lsp.mjs` is a minimal stdio LSP prototype. Its only diagnostic rule
reports local `usingComponents` entries that resolve to a missing file and are
also used as custom component tags in the current WXML file. For the baseline
fixture this reports `missing-card` in `pages/home/home.wxml`. It uses an async
per-root graph build queue and cached graph state, but diagnostics still run on
open/save only. It does not provide file watching or incremental parsing.
```

- [ ] **Step 4: Check the README wording**

Run:

```bash
rg -n "async|Restricted Mode|reload extensions|open/save|file watcher|wxml-lsp" README.md
```

Expected: matches include the new async graph queue, Restricted Mode, reload/restart, and open/save-only notes.

- [ ] **Step 5: Commit the README update**

```bash
git add README.md
git commit -m "docs: document wxml lsp hardening behavior"
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

Expected: PASS with no timeout.

- [ ] **Step 2: Run the full verification wrapper**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: PASS and final output includes:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 3: Check for forbidden synchronous server path**

Run:

```bash
rg -n "execFileSync|runDiagnostics\\(" server/wxml-lsp.mjs
```

Expected: no matches.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --stat HEAD~3..HEAD
git status --short
```

Expected: commits include the harness, server implementation, and README update. Worktree is clean.

- [ ] **Step 5: Request review before merging or moving to the next feature**

Summarize:

```text
Implemented WXML LSP baseline hardening:
- async per-root graph scheduler with generation guard
- didClose diagnostic clearing
- expanded LSP harness for lifecycle, refresh, root variants, unsupported request, and no-concurrent-build behavior
- README local Zed LSP notes

Verification:
- node scripts/verify-lsp-diagnostics.mjs
- scripts/verify-tree-sitter.sh
```

Then request code review before merging or starting navigation/documentSymbol work.
