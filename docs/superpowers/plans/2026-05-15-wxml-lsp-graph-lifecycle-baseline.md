# WXML LSP Graph Lifecycle Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a narrow `workspace/didChangeWatchedFiles` graph refresh lifecycle so diagnostics, definition, and completion consume a fresh project graph after relevant JSON/WXML/WXS files change.

**Architecture:** Keep `server/wxml-lsp.mjs` as the protocol host and graph lifecycle coordinator. Add strict watched-file root resolution, graph-affecting path filtering, cache invalidation, open-document diagnostic republish, and reuse the existing per-root graph build coalescing path. Keep WXML semantics in `server/wxml-language-service.mjs` unchanged.

**Tech Stack:** Node.js ESM, dependency-free JSON-RPC/LSP stdio server, existing WXML project graph extractor, fixture-driven protocol harness, Markdown docs.

---

## File Structure

- Modify `server/wxml-lsp.mjs`
  - Add strict watched-file root resolution that does not fall back to unrelated `rootCandidates`.
  - Add graph-affecting extension filtering for `.json`, `.wxml`, and `.wxs`.
  - Add `refreshGraphForRoot(projectRoot)` to invalidate cache, mark open WXML documents pending, and reuse `runGraphBuild`.
  - Add `workspace/didChangeWatchedFiles` handling in `handleMessage`.
- Modify `scripts/verify-lsp-diagnostics.mjs`
  - Add LSP client helper for `workspace/didChangeWatchedFiles`.
  - Add diagnostics helper for arbitrary missing component tags.
  - Add protocol scenarios for JSON `usingComponents` changes, component file creation, component file deletion, refresh coalescing/responsiveness, and irrelevant changes.
- Modify `README.md`
  - Document prototype watched-file graph refresh and explicitly keep production watcher/project-wide diagnostics out of scope.

---

### Task 0: Baseline Verification

**Files:**
- Read: `docs/superpowers/specs/2026-05-15-wxml-lsp-graph-lifecycle-baseline-design.md`
- Verify: current repository state

- [ ] **Step 1: Confirm branch and clean worktree**

Run:

```bash
git branch --show-current
git status --short
```

Expected:

```text
wxml-lsp-graph-lifecycle-baseline
```

`git status --short` should print nothing.

- [ ] **Step 2: Run baseline syntax checks**

Run:

```bash
node --check server/wxml-lsp.mjs
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: both commands exit `0`.

- [ ] **Step 3: Run baseline behavior checks**

Run these sequentially:

```bash
node scripts/verify-lsp-diagnostics.mjs
scripts/verify-tree-sitter.sh
```

Expected:

- `node scripts/verify-lsp-diagnostics.mjs` exits `0`.
- `scripts/verify-tree-sitter.sh` prints `wxml-zed tree-sitter verification passed`.

---

### Task 1: Failing Protocol Tests for Watched-File Refresh

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`

- [ ] **Step 1: Add missing-component diagnostic helper**

In `scripts/verify-lsp-diagnostics.mjs`, replace the fixed message assertions inside `assertMissingCardDiagnostic(...)` with a reusable helper:

```javascript
function assertMissingComponentDiagnostic(diagnostic, sourceFile, tag, value) {
  assert(diagnostic, `Missing diagnostic for ${tag}`);
  assert(diagnostic.severity === 2, `Expected warning severity, got ${diagnostic.severity}`);
  assert(diagnostic.source === "wxml-zed", `Unexpected diagnostic source: ${diagnostic.source}`);
  assert(diagnostic.code === "missing-local-component", `Unexpected diagnostic code: ${diagnostic.code}`);
  assert(
    diagnostic.message === `Missing local component "${tag}": ${value}`,
    `Unexpected diagnostic message: ${diagnostic.message}`,
  );

  const text = fs.readFileSync(sourceFile, "utf8");
  const start = lineCharToOffset(text, diagnostic.range.start);
  const end = lineCharToOffset(text, diagnostic.range.end);
  assert(
    text.slice(start, end).includes(`<${tag}`),
    `Diagnostic is not attached to ${tag} in ${sourceFile}: ${text.slice(start, end)}`,
  );
}

function assertMissingCardDiagnostic(diagnostic, sourceFile) {
  assertMissingComponentDiagnostic(
    diagnostic,
    sourceFile,
    "missing-card",
    "../../components/missing-card/missing-card",
  );

  const expectedRange = {
    start: { line: 14, character: 2 },
    end: { line: 14, character: 43 },
  };
  assertDeepEqual(diagnostic.range, expectedRange, "missing-card diagnostic range");
}

function diagnosticByCodeAndTag(diagnostics, tag) {
  return diagnostics.find((diagnostic) => (
    diagnostic.code === "missing-local-component" &&
    diagnostic.message.includes(`"${tag}"`)
  ));
}
```

- [ ] **Step 2: Add watched-file client helper**

Inside `class LspClient`, after `changeDocument(...)`, add:

```javascript
  changeWatchedFiles(filePaths, type = 2) {
    this.send("workspace/didChangeWatchedFiles", {
      changes: filePaths.map((filePath) => ({
        uri: pathToFileURL(filePath).href,
        type,
      })),
    });
  }
```

- [ ] **Step 3: Add temp project helpers**

After `assertNoLaterNonEmptyDiagnostics(...)`, add:

```javascript
function copyMiniProgramFixture(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(MINIPROGRAM_ROOT, tempRoot, { recursive: true });
  return tempRoot;
}

function homeWxmlIn(root) {
  return path.join(root, "pages/home/home.wxml");
}

function homeJsonIn(root) {
  return path.join(root, "pages/home/home.json");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertNoConcurrentExtractorWithMax(events, maxStartCount, label) {
  const stats = counterStats(events);
  assert(stats.minActive >= 0, `${label}: extractor counter ended before start: ${JSON.stringify(events)}`);
  assert(stats.active === 0, `${label}: extractor counter did not settle to zero: ${JSON.stringify(events)}`);
  assert(stats.startCount === stats.endCount, `${label}: extractor counter start/end mismatch: ${JSON.stringify(events)}`);
  assert(
    stats.startCount <= maxStartCount,
    `${label}: expected at most ${maxStartCount} graph extractor starts, saw ${stats.startCount}: ${JSON.stringify(events)}`,
  );
  assert(stats.maxActive <= 1, `${label}: expected no concurrent graph extractors, saw ${stats.maxActive}: ${JSON.stringify(events)}`);
}

async function waitForCounterEventsAfter(counterFile, previousEventCount, label, settleMs = SETTLE_MS) {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const events = readCounterEvents(counterFile);
    const nextEvents = events.slice(previousEventCount);
    const stats = counterStats(nextEvents);
    if (stats.startCount > 0 && stats.active === 0 && stats.startCount === stats.endCount) {
      await sleep(settleMs);
      return readCounterEvents(counterFile);
    }
    await sleep(25);
  }

  const events = readCounterEvents(counterFile);
  assert(false, `${label}: expected graph build after event ${previousEventCount}, got ${JSON.stringify(events)}`);
}
```

- [ ] **Step 4: Add JSON `usingComponents` refresh test**

After `testCompletionBuildDoesNotBlockRequestLoop()`, add:

```javascript
async function testWatchedJsonUsingComponentsRefresh() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-json-");
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const tempHomeJson = homeJsonIn(tempRoot);
    await withClient({ rootPath: tempRoot }, async (client) => {
      const uri = client.openDocument(tempHome);
      const first = await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched json initial diagnostics");
      assertMissingCardDiagnostic(first.diagnostics[0], tempHome);

      const config = JSON.parse(fs.readFileSync(tempHomeJson, "utf8"));
      config.usingComponents["missing-card"] = "../../components/user-card/user-card";
      writeJson(tempHomeJson, config);

      const cursor = client.diagnosticCursor();
      client.changeWatchedFiles([tempHomeJson]);
      await client.waitForDiagnosticsAfter(uri, cursor, (items) => items.length === 0, "watched json clears diagnostics");

      const completions = await client.completion(tempHome, { line: 14, character: 10 });
      assertCompletionLabelsInclude(completions, ["missing-card"], "watched json completion refresh");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 5: Add component file creation refresh test**

After `testWatchedJsonUsingComponentsRefresh()`, add:

```javascript
async function testWatchedComponentCreationRefresh() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-create-");
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const missingDir = path.join(tempRoot, "components/missing-card");
    const missingWxml = path.join(missingDir, "missing-card.wxml");
    const missingJson = path.join(missingDir, "missing-card.json");
    await withClient({ rootPath: tempRoot }, async (client) => {
      const uri = client.openDocument(tempHome);
      const first = await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched create initial diagnostics");
      assertMissingCardDiagnostic(first.diagnostics[0], tempHome);

      fs.mkdirSync(missingDir, { recursive: true });
      fs.writeFileSync(missingWxml, "<view />\n");
      fs.writeFileSync(missingJson, "{\"component\":true}\n");

      const cursor = client.diagnosticCursor();
      client.changeWatchedFiles([missingWxml, missingJson], 1);
      await client.waitForDiagnosticsAfter(uri, cursor, (items) => items.length === 0, "watched create clears diagnostics");

      const completions = await client.completion(tempHome, { line: 14, character: 10 });
      assertCompletionLabelsInclude(completions, ["missing-card"], "watched create completion refresh");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 6: Add component deletion refresh test**

After `testWatchedComponentCreationRefresh()`, add:

```javascript
async function testWatchedComponentDeletionRefresh() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-delete-");
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const userCardWxml = path.join(tempRoot, "components/user-card/user-card.wxml");
    await withClient({ rootPath: tempRoot }, async (client) => {
      const uri = client.openDocument(tempHome);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched delete initial diagnostics");

      fs.rmSync(userCardWxml, { force: true });

      const cursor = client.diagnosticCursor();
      client.changeWatchedFiles([userCardWxml], 3);
      const refreshed = await client.waitForDiagnosticsAfter(
        uri,
        cursor,
        (items) => Boolean(diagnosticByCodeAndTag(items, "user-card")),
        "watched delete user-card diagnostics",
      );
      assertMissingComponentDiagnostic(
        diagnosticByCodeAndTag(refreshed.diagnostics, "user-card"),
        tempHome,
        "user-card",
        "../../components/user-card/user-card",
      );

      const definition = await client.definition(tempHome, { line: 7, character: 3 });
      assertNullDefinition(definition, "watched delete user-card definition");

      const completions = await client.completion(tempHome, { line: 7, character: 6 });
      assert(!completionLabels(completions).includes("user-card"), "watched delete should remove user-card completion");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 7: Add refresh coalescing and responsiveness test**

After `testWatchedComponentDeletionRefresh()`, add:

```javascript
async function testWatchedRefreshCoalescesAndStaysResponsive() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-coalesce-");
  const counterFile = path.join(os.tmpdir(), `wxml-zed-lsp-watch-counter-${process.pid}.jsonl`);
  fs.rmSync(counterFile, { force: true });
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const tempHomeJson = homeJsonIn(tempRoot);
    const tempAppJson = path.join(tempRoot, "app.json");
    await withClient({
      rootPath: tempRoot,
      env: {
        WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
        WXML_ZED_LSP_GRAPH_COUNTER_FILE: counterFile,
      },
    }, async (client) => {
      const uri = client.openDocument(tempHome);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched coalesce initial diagnostics");
      fs.writeFileSync(tempHomeJson, fs.readFileSync(tempHomeJson, "utf8"));
      fs.writeFileSync(tempAppJson, fs.readFileSync(tempAppJson, "utf8"));

      client.changeWatchedFiles([tempHomeJson]);
      client.changeWatchedFiles([tempAppJson]);
      client.changeWatchedFiles([tempHomeJson, tempAppJson]);

      const id = client.request("workspace/symbol", { query: "user-card" });
      const response = await client.waitForResponse(id);
      assert(response.error?.code === -32601, `Expected responsive -32601, got ${JSON.stringify(response)}`);

      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched coalesce diagnostics settle");
      const events = await waitForCounterCompletionOrSettle(counterFile);
      assertNoConcurrentExtractorWithMax(events, 3, "watched coalesce");
    });
  } finally {
    fs.rmSync(counterFile, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 8: Add request waits for refreshed graph test**

After `testWatchedRefreshCoalescesAndStaysResponsive()`, add:

```javascript
async function testWatchedRefreshRequestsWaitForFreshGraph() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-request-");
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const tempHomeJson = homeJsonIn(tempRoot);
    await withClient({
      rootPath: tempRoot,
      env: {
        WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
      },
    }, async (client) => {
      const uri = client.openDocument(tempHome);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched request initial diagnostics");

      const config = JSON.parse(fs.readFileSync(tempHomeJson, "utf8"));
      config.usingComponents["missing-card"] = "../../components/user-card/user-card";
      writeJson(tempHomeJson, config);

      const cursor = client.diagnosticCursor();
      client.changeWatchedFiles([tempHomeJson]);
      const completionPromise = client.completion(tempHome, { line: 14, character: 10 });

      await client.waitForDiagnosticsAfter(uri, cursor, (items) => items.length === 0, "watched request diagnostics refresh");
      const completions = await completionPromise;
      assertCompletionLabelsInclude(completions, ["missing-card"], "watched request completion waits for fresh graph");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 9: Add closed document refresh test**

After `testWatchedRefreshRequestsWaitForFreshGraph()`, add:

```javascript
async function testWatchedRefreshDoesNotPublishClosedDocumentDiagnostics() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-closed-");
  const counterFile = path.join(os.tmpdir(), `wxml-zed-lsp-watch-closed-${process.pid}.jsonl`);
  fs.rmSync(counterFile, { force: true });
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const tempHomeJson = homeJsonIn(tempRoot);
    await withClient({
      rootPath: tempRoot,
      env: {
        WXML_ZED_LSP_GRAPH_COUNTER_FILE: counterFile,
      },
    }, async (client) => {
      const uri = client.openDocument(tempHome);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched closed initial diagnostics");

      const closeCursor = client.diagnosticCursor();
      client.closeDocument(tempHome);
      await client.waitForDiagnosticsAfter(uri, closeCursor, (items) => items.length === 0, "watched closed didClose diagnostics");

      const eventCount = readCounterEvents(counterFile).length;
      fs.writeFileSync(tempHomeJson, fs.readFileSync(tempHomeJson, "utf8"));
      client.changeWatchedFiles([tempHomeJson]);
      await waitForCounterEventsAfter(counterFile, eventCount, "watched closed refresh");

      const later = client.diagnosticsSince(closeCursor, uri);
      assert(
        later.length === 1 && later[0].diagnostics.length === 0,
        `closed document should only receive didClose diagnostics: ${JSON.stringify(later)}`,
      );
    });
  } finally {
    fs.rmSync(counterFile, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 10: Add irrelevant changes test**

After `testWatchedRefreshDoesNotPublishClosedDocumentDiagnostics()`, add:

```javascript
async function testWatchedIrrelevantChangesIgnored() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-ignore-");
  const counterFile = path.join(os.tmpdir(), `wxml-zed-lsp-watch-ignore-${process.pid}.jsonl`);
  const outsideFile = path.join(os.tmpdir(), `wxml-zed-outside-${process.pid}.json`);
  fs.rmSync(counterFile, { force: true });
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const ignoredPng = path.join(tempRoot, "assets/ignored.png");
    fs.mkdirSync(path.dirname(ignoredPng), { recursive: true });
    fs.writeFileSync(ignoredPng, "");
    fs.writeFileSync(outsideFile, "{}\n");

    await withClient({
      rootPath: tempRoot,
      env: {
        WXML_ZED_LSP_GRAPH_COUNTER_FILE: counterFile,
      },
    }, async (client) => {
      const uri = client.openDocument(tempHome);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched ignore initial diagnostics");
      const eventCount = readCounterEvents(counterFile).length;
      const cursor = client.diagnosticCursor();

      client.changeWatchedFiles([ignoredPng, outsideFile]);
      await sleep(SETTLE_MS);

      assert(readCounterEvents(counterFile).length === eventCount, "irrelevant changes should not start graph build");
      assert(
        client.diagnosticsSince(cursor, uri).length === 0,
        `irrelevant changes should not publish diagnostics: ${JSON.stringify(client.diagnosticsSince(cursor, uri))}`,
      );
    });
  } finally {
    fs.rmSync(counterFile, { force: true });
    fs.rmSync(outsideFile, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 11: Register new scenarios**

In the `scenarios` array, after `["completion build does not block request loop", testCompletionBuildDoesNotBlockRequestLoop],` add:

```javascript
  ["watched json usingComponents refresh", testWatchedJsonUsingComponentsRefresh],
  ["watched component creation refresh", testWatchedComponentCreationRefresh],
  ["watched component deletion refresh", testWatchedComponentDeletionRefresh],
  ["watched refresh coalesces and stays responsive", testWatchedRefreshCoalescesAndStaysResponsive],
  ["watched refresh requests wait for fresh graph", testWatchedRefreshRequestsWaitForFreshGraph],
  ["watched refresh does not publish closed document diagnostics", testWatchedRefreshDoesNotPublishClosedDocumentDiagnostics],
  ["watched irrelevant changes ignored", testWatchedIrrelevantChangesIgnored],
```

- [ ] **Step 12: Run syntax check**

Run:

```bash
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: exits `0`.

- [ ] **Step 13: Run protocol tests and confirm failure**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: exits non-zero at the first watched-file scenario because `server/wxml-lsp.mjs` does not yet handle `workspace/didChangeWatchedFiles`.

- [ ] **Step 14: Commit failing tests**

Run:

```bash
git add scripts/verify-lsp-diagnostics.mjs
git commit -m "test: cover watched file graph refresh"
```

---

### Task 2: Watched-File Graph Refresh Implementation

**Files:**
- Modify: `server/wxml-lsp.mjs`

- [ ] **Step 1: Add graph-affecting extension set**

Near the top of `server/wxml-lsp.mjs`, after `const GRAPH_EXTRACTOR = ...`, add:

```javascript
const GRAPH_AFFECTING_EXTENSIONS = new Set([".json", ".wxml", ".wxs"]);
```

- [ ] **Step 2: Add path containment helper**

After `containsAppJson(...)`, add:

```javascript
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
```

- [ ] **Step 3: Add strict watched-file root resolver**

After `resolveMiniProgramRoot(...)`, add:

```javascript
function resolveMiniProgramRootForWatchedPath(filePath) {
  for (const dir of parentDirs(path.dirname(filePath))) {
    if (containsAppJson(dir)) return dir;
  }

  for (const root of rootCandidates) {
    if (root && containsAppJson(root) && isInside(root, filePath)) {
      return root;
    }
  }

  return undefined;
}
```

- [ ] **Step 4: Add graph-affecting path filter**

After `resolveMiniProgramRootForWatchedPath(...)`, add:

```javascript
function isGraphAffectingPath(filePath) {
  return GRAPH_AFFECTING_EXTENSIONS.has(path.extname(filePath));
}
```

- [ ] **Step 5: Add open-document pending marker**

After `pendingForRoot(...)`, add:

```javascript
function markOpenDocumentsPending(projectRoot, generation) {
  const pending = pendingForRoot(projectRoot);
  for (const [uri, document] of openDocuments) {
    if (path.extname(document.path) !== ".wxml") continue;
    if (!isInside(projectRoot, document.path)) continue;
    pending.set(uri, generation);
  }
}
```

- [ ] **Step 6: Add refresh helper**

After `scheduleDiagnostics(...)`, add:

```javascript
function refreshGraphForRoot(projectRoot) {
  graphsByRoot.delete(projectRoot);
  const state = stateForRoot(projectRoot);
  state.latestGeneration += 1;
  markOpenDocumentsPending(projectRoot, state.latestGeneration);
  runGraphBuild(projectRoot);
}
```

- [ ] **Step 7: Add watched-file notification handler**

After `refreshGraphForRoot(...)`, add:

```javascript
function handleWatchedFilesChanged(params) {
  const roots = new Set();
  const changes = Array.isArray(params?.changes) ? params.changes : [];

  for (const change of changes) {
    const filePath = fileUriToPath(change?.uri);
    if (!filePath || !isGraphAffectingPath(filePath)) continue;

    const projectRoot = resolveMiniProgramRootForWatchedPath(filePath);
    if (!projectRoot) continue;

    roots.add(projectRoot);
  }

  for (const projectRoot of roots) {
    refreshGraphForRoot(projectRoot);
  }
}
```

- [ ] **Step 8: Wire handler into `handleMessage`**

In `handleMessage(message)`, after the `textDocument/didSave` case and before `textDocument/didClose`, add:

```javascript
    case "workspace/didChangeWatchedFiles":
      handleWatchedFilesChanged(message.params);
      break;
```

- [ ] **Step 9: Run syntax check**

Run:

```bash
node --check server/wxml-lsp.mjs
```

Expected: exits `0`.

- [ ] **Step 10: Run protocol tests**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: exits `0`.

- [ ] **Step 11: Commit implementation**

Run:

```bash
git add server/wxml-lsp.mjs
git commit -m "feat: refresh wxml graph from watched files"
```

---

### Task 3: README Scope Update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update feature matrix**

In `README.md`, add this row after the completion row:

```markdown
| Prototype watched-file graph refresh for open-document diagnostics, definition, and completion | Yes |
```

- [ ] **Step 2: Update LSP development description**

In the `Develop` section, update the LSP verification paragraph so it includes this sentence:

```markdown
The protocol harness also verifies watched-file graph refresh for JSON component registration changes and component file creation/deletion.
```

- [ ] **Step 3: Update local LSP development bullets**

Replace the existing diagnostics-only limitation:

```markdown
- LSP diagnostics currently run on open/save only. There is no file watcher and
  no per-keystroke graph rebuild.
```

with:

```markdown
- LSP diagnostics run for open WXML documents on open/save and on relevant
  `workspace/didChangeWatchedFiles` refreshes. There is still no Node-side file
  watcher, no project-wide diagnostics publication, and no per-keystroke graph
  rebuild.
```

- [ ] **Step 4: Update Scope section**

In the `Scope` section, add watched-file refresh to the baseline behavior paragraph:

```markdown
The LSP host can also refresh the cached project graph from
`workspace/didChangeWatchedFiles` notifications for relevant `.json`, `.wxml`,
and `.wxs` files, then republish diagnostics for already-open WXML documents.
```

Keep these unsupported boundaries in the same section:

```markdown
There is still no Node-side production file watcher, project-wide diagnostics,
npm/plugin component navigation, or `componentGenerics` support.
```

- [ ] **Step 5: Verify README changes**

Run:

```bash
rg -n 'watched-file|didChangeWatchedFiles|project-wide diagnostics|Node-side file watcher|graph refresh' README.md
git diff --check README.md
```

Expected:

- `rg` prints the new README references.
- `git diff --check README.md` exits `0`.

- [ ] **Step 6: Commit docs**

Run:

```bash
git add README.md
git commit -m "docs: document wxml graph lifecycle refresh"
```

---

### Task 4: Final Verification and Review

**Files:**
- Verify: full changed set

- [ ] **Step 1: Run syntax checks**

Run:

```bash
node --check server/wxml-lsp.mjs
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: both commands exit `0`.

- [ ] **Step 2: Run behavior checks**

Run these sequentially:

```bash
node scripts/verify-lsp-diagnostics.mjs
scripts/verify-tree-sitter.sh
```

Expected:

- `node scripts/verify-lsp-diagnostics.mjs` exits `0`.
- `scripts/verify-tree-sitter.sh` prints `wxml-zed tree-sitter verification passed`.

- [ ] **Step 3: Run diff checks**

Run:

```bash
git diff --check main..HEAD
git diff --stat main..HEAD
rg -n 'didChangeWatchedFiles|refreshGraphForRoot|resolveMiniProgramRootForWatchedPath|markOpenDocumentsPending|watched component|watched json' server scripts README.md
```

Expected:

- `git diff --check main..HEAD` exits `0`.
- `git diff --stat main..HEAD` shows only the spec, plan, server, protocol harness, and README changes.
- `rg` prints implementation and test references for watched-file refresh.

- [ ] **Step 4: Review focused diffs**

Run:

```bash
git diff main..HEAD -- server/wxml-lsp.mjs
git diff main..HEAD -- scripts/verify-lsp-diagnostics.mjs
git diff main..HEAD -- README.md
git diff main..HEAD -- docs/superpowers/specs/2026-05-15-wxml-lsp-graph-lifecycle-baseline-design.md
git diff main..HEAD -- docs/superpowers/plans/2026-05-15-wxml-lsp-graph-lifecycle-baseline.md
```

Check:

- watched-file root resolution cannot refresh a root for outside files;
- `.png` and other irrelevant extensions do not start graph builds;
- refresh deletes stale cached graphs before requests can reuse them;
- requests during refresh wait for the new graph;
- diagnostics publish only for open WXML documents;
- language service files are unchanged.

- [ ] **Step 5: Request code review**

Use `superpowers:requesting-code-review` before merge.

- [ ] **Step 6: Finish branch**

After review issues are fixed and verification still passes, use `superpowers:finishing-a-development-branch`.
