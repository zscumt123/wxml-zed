# Real-Time Diagnostics on Unsaved Buffer (Open-Document Overlay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `missing-event-handler` and `missing-expression-ref` diagnostics refresh while the user is typing, not only after save. Today's `textDocument/didChange` updates `openDocuments[uri].text` but doesn't recompute diagnostics; the diagnostic flow only fires through `scheduleDiagnostics` → `runGraphBuild` (subprocess that reads disk). Result: completion is live, diagnostics lag a save — a UX gap GPT confirmed in real dogfood.

**Architecture:** Per GPT's refinement, add an **open-document overlay** layer instead of mutating the persistent graph. New `openDocumentOverlays: Map<projectRoot, Map<uri, fileModel>>` holds the freshly-extracted single-file model for any dirty buffer. On didChange (debounced 150ms), parse the buffer via an in-process tree-sitter-wxml parser, run the existing `collectFile()` extractor on the parse tree, store the fileModel in the overlay, then publish diagnostics computed with that override. didSave/didClose clear the overlay; the saved graph becomes truth-of-record again. Cross-file lookups (script.dataKeys, graph.unresolved, OTHER files' fileModel.symbols) still come from the saved graph — overlay is single-file only.

**Tech Stack:** No new dependencies. `web-tree-sitter` is already loaded in two other places (`scripts/extract-wxml-symbols.mjs`, `scripts/extract-wxml-project-graph.mjs`); this plan introduces it inside the LSP server process too. The `collectFile()` extractor function moves from `scripts/extract-wxml-symbols.mjs` to a new `shared/wxml-symbol-extractor.mjs` so the server can import it without crossing the `scripts/` layer.

**Verification:** Two layers.

- `scripts/verify-wxml-language-service.mjs` adds `assertGetDiagnosticsUsesFileModelOverride` — passes a synthetic fileModel override with one extra `eventHandlers[]` entry pointing at a missing method; asserts the diagnostic fires using the override's data, NOT the graph's saved fileModel.
- `scripts/verify-lsp-diagnostics.mjs` adds **three** protocol tests, all registered in `graph-smoke` + `full`:
  - `testRealtimeDiagnosticsOnDidChange` — open → change with missing handler → assert `items.length === 1 && code === "missing-event-handler"` → revert to clean buffer → assert `items.length === 0`. Strong-form length checks (not `.some(...)`) catch interleaved saved-graph publishes that could otherwise mask false-greens.
  - `testOverlaySurvivesGraphRebuild` — overlay published, then `changeWatchedFiles` triggers graph rebuild; overlay's diagnostic must STILL stand. Regression lock for the publishPendingDiagnostics overwrite race.
  - `testOverlayBeforeInitialGraph` — open + immediate change WITHOUT awaiting initial diagnostics; overlay must be stored even during in-flight initial graph build, and the eventual diagnostic must reflect live buffer rather than disk state. Regression lock for the "graph not ready" race.
- Existing tests (28 script-info, 19 expression-helpers, 7 wasm-symbol baselines, 10+ language-service assertions, LSP graph-smoke) must remain green throughout — the overlay is additive, all existing call sites continue to work without passing the override.

**Out of scope (v1):**
- Cross-file overlays: editing `.js` with unsaved `data:` changes still leaves `.wxml` diagnostics lagging until .js saves (today's behavior unchanged). Typical workflow saves `.js` before iterating on `.wxml` bindings, so this is accepted v1.
- Re-parsing the entire graph for cross-file scope changes — overlay is single-file only.
- TypeScript sibling support (separate plan).
- Editing `usingComponents`/template-import edges between save events — those affect graph-level data (resolution, dependencies) and need a full graph rebuild; overlay won't update them.

---

## File Structure

- Create: `shared/wxml-symbol-extractor.mjs`
  - Exports `collectFile(tree, inputAbs)` and all its file-local helpers (`innerValueRange`, `rangeOf`, `firstChildOfType`, `attributeRawValue`, `offsetToPositionWithin`, `quotedAttrTextValue`, `byPosition`, `normalizeDependency`, and the const `CONTROL_TAGS`).
  - The WASM-loading path stays inside `scripts/extract-wxml-symbols.mjs` (it's CLI-only there); the LSP server has its own lazy-init.
- Modify: `scripts/extract-wxml-symbols.mjs`
  - Drop the helpers + `collectFile`; import from `shared/wxml-symbol-extractor.mjs`. CLI behavior unchanged.
- Modify: `server/wxml-language-service.mjs`
  - `getDiagnostics({graph, documentPath, extensionRoot})` grows an optional `fileModelOverride` parameter. When present, use it instead of `findWxmlFileModel(graph, ...)`'s fileModel. `documentGraphPath` still derives the same way.
- Modify: `server/wxml-lsp.mjs`
  - Add module-scope `openDocumentOverlays: Map<root, Map<uri, fileModel>>`.
  - Add module-scope `overlayTimers: Map<uri, NodeJS.Timeout>` for per-URI debounce.
  - Add lazy `getWxmlParser()` returning `Promise<Parser | null>` (null on wasm load failure).
  - Add `clearOverlay(root, uri)` / `cancelOverlayTimer(uri)` / `getOverlayFileModel(root, uri)` / `overlaysForRoot(root)` lifecycle helpers.
  - Add `scheduleOverlayDiagnostics(uri)` (single-arg) — per-URI debounce timer that fires `runOverlayDiagnostics(uri)`; the latter reads the latest `document.text` from `openDocuments` at fire-time, so keystrokes between schedule and fire are absorbed into one parse.
  - didChange: call `scheduleOverlayDiagnostics(uri)`.
  - didOpen: derive root via `fileUriToPath(uri)` (document isn't recorded yet); `clearOverlay(root, uri)` for the belt-and-suspenders, then `scheduleDiagnostics`.
  - didSave / didClose: clear the overlay AND cancel any pending overlay timer for that uri.
  - **`publishPendingDiagnostics` becomes overlay-aware**: its callback signature gains a third `overlay` argument (the result of `getOverlayFileModel(projectRoot, uri)`), and the two callsites in `runGraphBuild` pass `fileModelOverride: overlay` through to `getDiagnostics`. Without this, every graph rebuild would overwrite in-flight overlay diagnostics with stale-disk state.
- Modify: `scripts/verify-wxml-language-service.mjs`
  - New `assertGetDiagnosticsUsesFileModelOverride` registered near other Phase 2 Stage C diagnostic assertions.
- Modify: `scripts/verify-lsp-diagnostics.mjs`
  - Three new protocol tests, all registered in scenarios + graph-smoke suite list:
    - `testRealtimeDiagnosticsOnDidChange` — basic open → change → diagnostic refresh → revert → clear.
    - `testOverlaySurvivesGraphRebuild` — overlay published, then `changeWatchedFiles` triggers graph rebuild; overlay must survive (Finding 1 race lock).
    - `testOverlayBeforeInitialGraph` — open + immediate change with NO wait for initial diagnostics; overlay is stored even while graph build is in flight, and the eventual `publishPendingDiagnostics` picks it up so the user sees the live-buffer diagnostic instead of disk state.
- Modify: `docs/wasm-parser-spike-notes.md`
  - Append "P1 Outcome: real-time diagnostics on unsaved buffer" section before the trailing regression-anchor block.

---

### Task 1: Move `collectFile` to `shared/wxml-symbol-extractor.mjs`

**Files:**
- Create: `shared/wxml-symbol-extractor.mjs`
- Modify: `scripts/extract-wxml-symbols.mjs`

Pure refactor. Same as the Phase 3 Stage B helpers-to-shared move: pull a chunk of functions out, leave a shim import behind, prove baselines unchanged. Required because the LSP server (which lives in `server/`) needs to call `collectFile` and per layering shouldn't import from `scripts/`.

- [ ] **Step 1: Identify the full transitive dependency surface**

  In `scripts/extract-wxml-symbols.mjs`, `collectFile` and its helpers transitively depend on these (line numbers approximate — re-verify with grep before editing):

  - `const CONTROL_TAGS = new Set([...])` (around line 14)
  - `function innerValueRange(quotedValueNode)` (line 22)
  - `function toPosix(p)` (line 58) — used by relativePathFromRoot
  - `function relativePathFromRoot(filePath)` (line 62) — used by normalizeDependency AND by CLI's extractFile
  - `function normalizeDependency(filePath, value)` (line 66) — calls relativePathFromRoot
  - `function rangeOf(node)` (line 75)
  - `function firstChildOfType(node, type)` (line 82)
  - `function unquote(text)` (line 90) — used by attributeRawValue
  - `function attributeRawValue(attributeNode)` (line 98) — calls unquote
  - `function findAttributeByName(parent, attributeNodeType, expectedName)` (line 105) — used by template walker inside collectFile
  - `function findAnyAttribute(parent, expectedName)` (line 115) — same
  - `function offsetToPositionWithin(text, offset)` (line 128)
  - `function quotedAttrTextValue(attrNode)` (line 144)
  - `function byPosition(a, b)` (line 163)
  - `function collectFile(tree, inputAbs)` (line 168 — this is the public export)

  Critical: `relativePathFromRoot` and `toPosix` are ALSO used by the CLI's `extractFile()` (line 348). If they move to shared but the CLI keeps using them, the CLI must import them back from shared. Same applies to `normalizeDependency` (CLI doesn't call it directly but `collectFile` does, and it's now in shared anyway).

  Plus the imports the moved chunk needs (all already present in scripts/, become shared imports too):
  - `import path from "node:path"` (for path.posix.join etc — used by normalizeDependency)
  - `import { BUILTIN_TAGS } from "./wxml-builtins.mjs"` (relative path from shared/, not ../shared/)
  - `import { matchEventBinding } from "./event-binding-patterns.mjs"`
  - `import { topLevelIdentifiers } from "./wxml-expression-helpers.mjs"`

  AND `relativePathFromRoot` references a top-level `ROOT` constant (the project root, derived via `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")`). Shared must compute its own equivalent — derive from its own `import.meta.url` (`shared/` is one level under project root, same depth as `scripts/`, so the relative path is identical):

  ```js
  import path from "node:path";
  import { fileURLToPath } from "node:url";
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  ```

  Both consumers (scripts/extract-wxml-symbols.mjs and shared/wxml-symbol-extractor.mjs) end up with the same ROOT value — the project root — even though they derive it independently.

  Run this exact grep to confirm dependency surface before editing (catches anything I missed):

  ```bash
  grep -nE "^(function|const)" scripts/extract-wxml-symbols.mjs | head -25
  ```

  If grep reveals additional internal helpers not listed above, include them in the move.

- [ ] **Step 2: Create `shared/wxml-symbol-extractor.mjs` with everything moved**

  Paste each function verbatim into the new file. The shared module gets THREE exports (the rest stay file-local):
  - `collectFile(tree, inputAbs)` — the main API; was unexported in the script
  - `relativePathFromRoot(filePath)` — also needed by CLI's `extractFile()`
  - `toPosix(p)` — same reason, peer of relativePathFromRoot

  File layout for `shared/wxml-symbol-extractor.mjs`:

  ```js
  import path from "node:path";
  import { fileURLToPath } from "node:url";

  import { BUILTIN_TAGS } from "./wxml-builtins.mjs";
  import { matchEventBinding } from "./event-binding-patterns.mjs";
  import { topLevelIdentifiers } from "./wxml-expression-helpers.mjs";

  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const CONTROL_TAGS = new Set([/* exact copy */]);

  function innerValueRange(quotedValueNode) { /* exact copy */ }

  export function toPosix(p) {
    return p.split(path.sep).join(path.posix.sep);
  }

  export function relativePathFromRoot(filePath) {
    return toPosix(path.relative(ROOT, path.resolve(filePath)));
  }

  function normalizeDependency(filePath, value) { /* exact copy — uses relativePathFromRoot */ }
  function rangeOf(node) { /* exact copy */ }
  function firstChildOfType(node, type) { /* exact copy */ }
  function unquote(text) { /* exact copy */ }
  function attributeRawValue(attributeNode) { /* exact copy — uses unquote */ }
  function findAttributeByName(parent, attributeNodeType, expectedName) { /* exact copy */ }
  function findAnyAttribute(parent, expectedName) { /* exact copy */ }
  function offsetToPositionWithin(text, offset) { /* exact copy */ }
  function quotedAttrTextValue(attrNode) { /* exact copy */ }
  function byPosition(a, b) { /* exact copy */ }

  export function collectFile(tree, inputAbs) { /* exact copy */ }
  ```

- [ ] **Step 3: Update `scripts/extract-wxml-symbols.mjs` to import from shared**

  Replace the moved chunk (CONTROL_TAGS through collectFile, ~lines 14-352 excluding profile/elapsedMs helpers and main()) with imports:

  ```js
  import {
    collectFile,
    relativePathFromRoot,
  } from "../shared/wxml-symbol-extractor.mjs";
  ```

  The CLI uses `relativePathFromRoot` directly in `extractFile()` (around line 348 — `const inputRel = relativePathFromRoot(inputAbs);`), so it MUST be imported back. `toPosix` and `normalizeDependency` etc. aren't used by the CLI directly — they were only needed by the moved `collectFile` body, which now uses them via the shared module's closure.

  Drop the imports that are now only used by the moved chunk (verify with grep AFTER the move):
  - `matchEventBinding` — only inside `collectFile`'s walker → drop from script
  - `topLevelIdentifiers` — only inside `collectFile` → drop from script
  - `BUILTIN_TAGS` — used by `collectFile` (component detection) → drop from script

  Keep in the script:
  - `Parser`, `Language` from `web-tree-sitter` — still used by CLI WASM init
  - `path`, `fileURLToPath`, `fs`, `performance` — still used by CLI argv / extractFile structure
  - `WASM` const — still used by CLI

  Leave WASM init, CLI argv handling, main(), profileEvent, elapsedMs, isDirectRun guard unchanged.

- [ ] **Step 4: Run all affected verifiers to prove byte-identical output**

  Run: `node scripts/verify-wasm-symbol-baselines.mjs`
  Expected: 7 cases PASS, no diff.

  Run: `node scripts/verify-wxml-expression-helpers.mjs`
  Expected: 19 cases PASS.

  Run: `node scripts/verify-wxml-language-service.mjs`
  Expected: exit 0.

  Run: `node scripts/verify-js-method-baselines.mjs`
  Expected: 3 fixtures PASS.

  If any baseline diff appears: the move altered the function bodies somewhere. Diff the original `collectFile` in git history against what landed in the shared module.

- [ ] **Step 5: Sanity-grep**

  Run: `grep -rnE "from.*scripts.*extract-wxml-symbols" .`
  Expected: zero matches outside the script's own internal use.

  Run: `grep -nE "function collectFile" scripts/extract-wxml-symbols.mjs`
  Expected: zero matches (only the import is in the script now).

- [ ] **Step 6: Commit**

  ```bash
  git add shared/wxml-symbol-extractor.mjs scripts/extract-wxml-symbols.mjs
  git commit -m "refactor: move collectFile to shared/wxml-symbol-extractor.mjs

  P1 prep: the upcoming open-document-overlay path in server/wxml-lsp.mjs
  needs to call collectFile() to extract a fileModel from live buffer
  text. Server runtime shouldn't import from scripts/, so the function
  (plus its file-local helpers) moves to a new shared module. Mirrors
  the Phase 3 Stage B move of expression helpers (shared/wxml-expression
  -helpers.mjs).

  Pure relocation: collectFile signature unchanged, all helpers stay
  internal to the new module, all 7 wasm-symbol baselines remain
  byte-identical."
  ```

---

### Task 2: `getDiagnostics` accepts `fileModelOverride`

**Files:**
- Modify: `server/wxml-language-service.mjs:831` (getDiagnostics function)
- Modify: `scripts/verify-wxml-language-service.mjs` (new assertion)

The signature change is additive; all existing call sites continue to work. When override is supplied, the diagnostic uses it instead of looking up via the graph's `wxml[]`.

- [ ] **Step 1: Modify `getDiagnostics` signature**

  Today (line 831):

  ```js
  export function getDiagnostics({ graph, documentPath, extensionRoot }) {
    const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
    if (!fileModel) {
      return [];
    }

    const usedComponents = new Map(fileModel.components.map((component) => [component.tag, component]));
    // ... componentDiags using fileModel ...

    const handlerDiags = eventHandlerDiagnostics(graph, documentGraphPath, fileModel);
    const expressionDiags = expressionRefDiagnostics(graph, documentGraphPath, fileModel);
    return [...componentDiags, ...handlerDiags, ...expressionDiags];
  }
  ```

  Change to:

  ```js
  export function getDiagnostics({ graph, documentPath, extensionRoot, fileModelOverride }) {
    const { documentGraphPath, fileModel: graphFileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
    // documentGraphPath always comes from the path resolution; it's the
    // cross-file lookup key, which is identical whether overlay'd or not.
    // The fileModel itself is the only thing the overlay overrides.
    const fileModel = fileModelOverride ?? graphFileModel;
    if (!fileModel) {
      return [];
    }

    const usedComponents = new Map(fileModel.components.map((component) => [component.tag, component]));
    // ... rest unchanged (componentDiags using fileModel.components, etc.) ...

    const handlerDiags = eventHandlerDiagnostics(graph, documentGraphPath, fileModel);
    const expressionDiags = expressionRefDiagnostics(graph, documentGraphPath, fileModel);
    return [...componentDiags, ...handlerDiags, ...expressionDiags];
  }
  ```

  Key invariant: `documentGraphPath` is derived from `documentPath` via path resolution (`graphPathForAbsolute`), NOT from the fileModel. So it's stable across overlay vs graph paths. The cross-file lookups inside `eventHandlerDiagnostics`/`expressionRefDiagnostics` (which use `documentGraphPath` to find `graph.configs.find((c) => c.owner === documentGraphPath)`) work identically.

- [ ] **Step 2: Syntax check + run existing diagnostic tests**

  Run: `node --check server/wxml-language-service.mjs && node scripts/verify-wxml-language-service.mjs`
  Expected: exit 0. All existing assertions still pass because override is optional and absent in every existing call site.

- [ ] **Step 3: Add `assertGetDiagnosticsUsesFileModelOverride`**

  Insert after the existing Phase 2 Stage C `assertEventHandlerDiagnostic*` block (around line 270–280 in `scripts/verify-wxml-language-service.mjs`):

  ```js
  function assertGetDiagnosticsUsesFileModelOverride(graph) {
    // Construct an override fileModel that's the same as home's BUT with
    // one extra eventHandlers entry pointing at a method that doesn't exist
    // in home.js. The diagnostic should fire using the override, not the
    // saved-graph fileModel which doesn't have that handler.
    const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
    assert(homeFile, "test setup: home file in graph");

    const synthetic = {
      event: "tap",
      handler: "__overlay_only_missing__",
      binding: "bind:",
      dynamic: false,
      range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
      nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    };
    const fileModelOverride = {
      ...homeFile,
      eventHandlers: [...homeFile.eventHandlers, synthetic],
    };

    const diagnostics = getDiagnostics({
      graph,
      documentPath: HOME_WXML,
      extensionRoot: ROOT,
      fileModelOverride,
    });
    const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
    const ours = handlerDiags.find((d) => d.message.includes("__overlay_only_missing__"));
    assert(
      ours,
      `getDiagnostics override: expected diagnostic for the override's synthetic handler; got ${JSON.stringify(handlerDiags)}`,
    );

    // Sanity: without the override, the synthetic handler doesn't exist in graph.wxml.
    const baselineDiagnostics = getDiagnostics({
      graph,
      documentPath: HOME_WXML,
      extensionRoot: ROOT,
    });
    const baselineHandlerDiags = baselineDiagnostics
      .filter((d) => d.code === "missing-event-handler")
      .filter((d) => d.message.includes("__overlay_only_missing__"));
    assert(
      baselineHandlerDiags.length === 0,
      `getDiagnostics baseline: synthetic handler shouldn't appear without override; got ${JSON.stringify(baselineHandlerDiags)}`,
    );
  }
  ```

- [ ] **Step 4: Register the assertion in the test runner**

  Find the existing block where Phase 2 Stage C diagnostic assertions are called (around `assertEventHandlerDiagnosticBoolean...`). Add:

  ```js
  assertGetDiagnosticsUsesFileModelOverride(graph);
  ```

- [ ] **Step 5: Run + commit**

  Run: `node scripts/verify-wxml-language-service.mjs`
  Expected: exit 0.

  ```bash
  git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
  git commit -m "feat: getDiagnostics accepts optional fileModelOverride

  P1 (1/4). Additive parameter: when present, the override replaces the
  fileModel that getDiagnostics would otherwise look up from graph.wxml[].
  documentGraphPath still derives from path resolution (unchanged), so
  cross-file lookups inside eventHandlerDiagnostics/expressionRefDiagnostics
  work identically. All existing call sites continue to work without
  passing the override.

  Lock: assertGetDiagnosticsUsesFileModelOverride passes a synthetic
  eventHandlers entry through the override path and asserts the
  diagnostic fires on it, while a baseline call without override does
  NOT emit it (proving the override actually replaced the saved
  fileModel, not just augmented it)."
  ```

---

### Task 3: Lazy parser + overlay state in LSP server

**Files:**
- Modify: `server/wxml-lsp.mjs`

Scaffolding only — adds the state and lifecycle hooks. Task 4 wires didChange to populate the overlay.

- [ ] **Step 1: Add module-scope imports + state**

  Near the top of `server/wxml-lsp.mjs` (after the existing imports + `openDocuments` declaration around line 26), add:

  ```js
  import { Parser, Language } from "web-tree-sitter";
  import { collectFile } from "../shared/wxml-symbol-extractor.mjs";

  const WXML_WASM = path.join(EXTENSION_ROOT, "grammar/tree-sitter-wxml/tree-sitter-wxml.wasm");

  // Lazy parser: initialized on first didChange. null on permanent failure
  // (wasm not loadable in this environment) — caller falls back to saved-
  // graph diagnostics.
  let wxmlParserPromise = null;
  let wxmlParserFailed = false;

  // openDocumentOverlays[root][uri] = freshly-extracted fileModel from the
  // current buffer text. Empty by default — populated on didChange and
  // cleared on didOpen/didSave/didClose.
  const openDocumentOverlays = new Map();

  // Per-uri debounce timers for overlay refresh.
  const overlayTimers = new Map();
  const OVERLAY_DEBOUNCE_MS = 150;
  ```

  Note: `EXTENSION_ROOT` is already defined in this file. If it isn't, derive it the same way `WXML_ZED_PROFILE` or existing path-based consts do.

- [ ] **Step 2: Add `getWxmlParser()` helper**

  Insert near the existing `publishDiagnostics` helper (around line 67):

  ```js
  async function getWxmlParser() {
    if (wxmlParserFailed) return null;
    if (wxmlParserPromise) return wxmlParserPromise;

    wxmlParserPromise = (async () => {
      try {
        await Parser.init();
        const language = await Language.load(WXML_WASM);
        const parser = new Parser();
        parser.setLanguage(language);
        return parser;
      } catch (err) {
        wxmlParserFailed = true;
        process.stderr.write(
          `WARN: WXML wasm parser load failed (${err?.message || err}); overlay diagnostics disabled, falling back to saved-graph diagnostics on save\n`,
        );
        return null;
      }
    })();

    return wxmlParserPromise;
  }
  ```

  The graceful-degradation pattern mirrors `attachScripts` in `scripts/extract-wxml-project-graph.mjs:431` where JS wasm load failures emit a warning and disable the JS-extraction path.

- [ ] **Step 3: Add `clearOverlay` / `cancelOverlayTimer` helpers**

  Insert after `closeDocument` (around line 392):

  ```js
  function overlaysForRoot(projectRoot) {
    let perRoot = openDocumentOverlays.get(projectRoot);
    if (!perRoot) {
      perRoot = new Map();
      openDocumentOverlays.set(projectRoot, perRoot);
    }
    return perRoot;
  }

  function clearOverlay(projectRoot, uri) {
    const perRoot = openDocumentOverlays.get(projectRoot);
    if (perRoot) perRoot.delete(uri);
    cancelOverlayTimer(uri);
  }

  function cancelOverlayTimer(uri) {
    const t = overlayTimers.get(uri);
    if (t) {
      clearTimeout(t);
      overlayTimers.delete(uri);
    }
  }

  function getOverlayFileModel(projectRoot, uri) {
    const perRoot = openDocumentOverlays.get(projectRoot);
    if (!perRoot) return undefined;
    return perRoot.get(uri);
  }
  ```

- [ ] **Step 3b: Make `publishPendingDiagnostics` overlay-aware (Finding 1 fix)**

  Today's `publishPendingDiagnostics` (around line 236-244) doesn't know about overlays. After a graph rebuild completes, it calls `getDiagnostics({graph, documentPath})` for every pending URI — which uses the saved-disk fileModel and OVERWRITES any overlay-published diagnostic. Race: user opens file → edits → overlay publishes correct diagnostics → ~3s later background graph build finishes → publishes saved-disk diagnostics → user sees stale state flash back.

  Two cooperating edits:

  a. Update `publishPendingDiagnostics` to look up the overlay and pass it through to the callback:

  ```js
  function publishPendingDiagnostics(projectRoot, diagnosticsForUri) {
    const pending = pendingForRoot(projectRoot);
    for (const [uri] of pending) {
      const document = openDocuments.get(uri);
      if (!document) continue;
      const overlay = getOverlayFileModel(projectRoot, uri);
      publishDiagnostics(uri, diagnosticsForUri(uri, document.path, overlay));
    }
    pending.clear();
  }
  ```

  b. Update the callback at the two call sites in `runGraphBuild` (around line 271 and line 281) to honor the new third argument:

  ```js
  publishPendingDiagnostics(projectRoot, (_uri, documentPath, overlay) => (
    getDiagnostics({ graph, documentPath, extensionRoot: EXTENSION_ROOT, fileModelOverride: overlay })
  ));
  ```

  The empty-error path (line 281, `publishPendingDiagnostics(projectRoot, () => []);`) is unchanged — it just publishes `[]` for every pending URI; overlay state doesn't matter when the graph build itself failed.

- [ ] **Step 4: Wire overlay-clear into existing lifecycle handlers**

  Find `closeDocument(uri)` (around line 386). Add an overlay clear:

  ```js
  function closeDocument(uri) {
    openDocuments.delete(uri);
    // Clear overlay for all roots — the document is gone; if it was open
    // under multiple roots (rare but possible if Zed had nested workspaces),
    // any stored overlay should drop. Scan to be safe.
    for (const root of openDocumentOverlays.keys()) {
      clearOverlay(root, uri);
    }
    for (const pending of pendingDiagnosticsByRoot.values()) {
      pending.delete(uri);
    }
    publishDiagnostics(uri, []);
  }
  ```

  Find the `case "textDocument/didSave"` handler (around line 590):

  ```js
  case "textDocument/didSave":
    {
      const uri = message.params?.textDocument?.uri;
      // Clear overlay BEFORE scheduling the graph rebuild — when the buffer
      // matches disk, the saved graph becomes truth-of-record again and
      // any pending debounced didChange shouldn't fire stale overlay.
      const document = openDocuments.get(uri);
      if (document) {
        const projectRoot = resolveMiniProgramRoot(document.path);
        if (projectRoot) clearOverlay(projectRoot, uri);
      }
      scheduleDiagnostics(uri, message.params?.text);
    }
    break;
  ```

  didOpen also clears overlay (a freshly reopened file shouldn't have stale overlay state from a prior open). At didOpen time the document isn't in `openDocuments` yet — `scheduleDiagnostics` will record it via `recordOpenDocument`. So derive the project root from the URI directly via the existing `fileUriToPath` helper:

  ```js
  case "textDocument/didOpen":
    {
      const uri = message.params?.textDocument?.uri;
      const documentPath = fileUriToPath(uri);
      if (documentPath) {
        const projectRoot = resolveMiniProgramRoot(documentPath);
        if (projectRoot) clearOverlay(projectRoot, uri);
      }
      scheduleDiagnostics(uri, message.params?.textDocument?.text);
    }
    break;
  ```

  This works at didOpen time because `fileUriToPath(uri)` is a pure transformation that doesn't depend on `openDocuments` state.

- [ ] **Step 5: Syntax check + run regression**

  Run: `node --check server/wxml-lsp.mjs && node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke 2>&1 | tail -5`
  Expected: exit 0; graph-smoke output ends normally with no new failures. No overlay path is exercised yet (didChange still does nothing), but the new state machinery shouldn't break existing flows.

- [ ] **Step 6: Commit**

  ```bash
  git add server/wxml-lsp.mjs
  git commit -m "feat: lazy WXML parser + overlay state scaffolding in LSP

  P1 (2/4). Adds the state machinery for open-document overlays:
   - getWxmlParser(): lazy-initialized web-tree-sitter parser handle.
     Graceful degradation (returns null) if wasm load fails; mirrors
     the JS-parser pattern in attachScripts.
   - openDocumentOverlays: Map<root, Map<uri, fileModel>>. Populated
     by didChange (next task), cleared on didOpen/didSave/didClose.
   - overlayTimers: Map<uri, Timeout> for per-uri debounce coalescing
     (next task wires this).
   - clearOverlay / cancelOverlayTimer / getOverlayFileModel helpers.

  Lifecycle hooks added to didOpen / didSave / didClose so overlay
  state stays correctly scoped to dirty-buffer windows. didChange
  hookup arrives in the next task.

  No behavior change yet: didChange still doesn't trigger diagnostics;
  the new state remains empty in all flows."
  ```

---

### Task 4: didChange → debounced overlay refresh + publish

**Files:**
- Modify: `server/wxml-lsp.mjs`

This wires the overlay path. didChange now schedules a debounced overlay-refresh; when the timer fires, the buffer is parsed, fileModel is extracted, stored in overlay, and diagnostics are published.

- [ ] **Step 1: Add `scheduleOverlayDiagnostics(uri)` + `runOverlayDiagnostics(uri)` helpers**

  Place near `scheduleDiagnostics` (line 340). Single-arg schedule (no `text` parameter — fire-time reads `document.text` directly from the open-document cache, absorbing any keystrokes that happened between schedule and fire):

  ```js
  function scheduleOverlayDiagnostics(uri) {
    cancelOverlayTimer(uri);
    const timer = setTimeout(() => {
      overlayTimers.delete(uri);
      runOverlayDiagnostics(uri).catch((err) => {
        logDiagnosticError(`overlay diagnostics failed for ${uri}: ${err?.message || err}`);
      });
    }, OVERLAY_DEBOUNCE_MS);
    overlayTimers.set(uri, timer);
  }

  async function runOverlayDiagnostics(uri) {
    const document = openDocuments.get(uri);
    if (!document || typeof document.text !== "string") return;
    if (path.extname(document.path) !== ".wxml") return;

    const projectRoot = resolveMiniProgramRoot(document.path);
    if (!projectRoot) return;

    const parser = await getWxmlParser();
    if (!parser) return;  // wasm load failed — user falls back to save-time diagnostics

    let fileModel;
    try {
      const tree = parser.parse(document.text);
      fileModel = collectFile(tree, document.path);
    } catch (err) {
      logDiagnosticError(`WXML parse failed for ${document.path}: ${err?.message || err}`);
      return;
    }

    // Store overlay FIRST — even if the initial graph build hasn't finished
    // yet, publishPendingDiagnostics (Task 3 Step 3b) will read this overlay
    // when the build does complete, so the user's first observed diagnostic
    // reflects the live buffer rather than disk state.
    overlaysForRoot(projectRoot).set(uri, fileModel);

    // If the saved graph IS ready, publish the overlay-augmented diagnostic
    // immediately. If not, the deferred publish via publishPendingDiagnostics
    // will handle it when the in-flight build completes.
    const graph = graphsByRoot.get(projectRoot);
    if (!graph) return;

    const diagnostics = getDiagnostics({
      graph,
      documentPath: document.path,
      extensionRoot: EXTENSION_ROOT,
      fileModelOverride: fileModel,
    });
    publishDiagnostics(uri, diagnostics);
  }
  ```

  **Critical ordering**: parse and store overlay BEFORE checking graph readiness. The pre-graph case is real — a user opening a file and immediately typing will hit this path (initial graph build takes ~3s subprocess time; debounce is 150ms). With the previous ordering (graph check first, early return if absent), the overlay would never be stored, and the eventual publishPendingDiagnostics call would publish stale disk diagnostics.

- [ ] **Step 2: Wire didChange to schedule the overlay**

  Find the existing `case "textDocument/didChange"` handler (around line 578):

  ```js
  case "textDocument/didChange":
    {
      const uri = message.params?.textDocument?.uri;
      const fullChange = Array.isArray(message.params?.contentChanges)
        ? message.params.contentChanges.find((change) => !change.range && typeof change.text === "string")
        : undefined;
      if (fullChange) {
        updateOpenDocumentText(uri, fullChange.text);
        scheduleOverlayDiagnostics(uri);
      }
    }
    break;
  ```

  The single new line is `scheduleOverlayDiagnostics(uri);` after `updateOpenDocumentText`. The text is now in `openDocuments[uri]`; the scheduled timer will read from there at fire-time.

- [ ] **Step 3: Syntax check + smoke**

  Run: `node --check server/wxml-lsp.mjs`
  Expected: exit 0.

  Run: `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke 2>&1 | tail -10`
  Expected: existing graph-smoke tests still pass (the new overlay path is dormant unless a `changeDocument` happens, and none of the existing graph-smoke tests use `changeDocument` followed by diagnostic waits).

  If a test fails because `scheduleOverlayDiagnostics` is firing in tests that don't expect it: confirm by adding `console.error` temporarily inside `runOverlayDiagnostics`. The issue is likely the test's `changeDocument` call is now triggering a publish where it wasn't before. Adjust the existing test to wait or filter (covered in Task 5's protocol test pattern).

- [ ] **Step 4: No commit yet** — Task 5 adds the LSP protocol test. Commit together so the feature + test land atomically.

---

### Task 5: LSP protocol test — diagnostics refresh on didChange

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`

The protocol-level test demonstrates the round trip: changeDocument with a buffer that introduces a missing handler → diagnostic fires → changeDocument back → diagnostic clears. This is the user-facing UX promise.

- [ ] **Step 1: Add `testRealtimeDiagnosticsOnDidChange`**

  Insert near other completion/diagnostic LSP tests (after `testEventHandlerCompletion` around line 870):

  ```js
  async function testRealtimeDiagnosticsOnDidChange() {
    await withClient({ rootPath: ROOT }, async (client) => {
      const uri = client.openDocument(HOME_WXML);
      await client.waitForDiagnostics(
        uri,
        (items) => items.length === 1,
        "home initial diagnostics (missing-card)",
      );

      // Replace home.wxml content with a synthetic that has a missing handler
      // and references no other unresolved tags. Overlay should publish
      // EXACTLY one diagnostic — the missing-event-handler we introduce.
      const withMissingHandler = '<view><button bind:tap="__notInJs__">x</button></view>\n';
      const cursor = client.diagnosticCursor();
      client.changeDocument(HOME_WXML, withMissingHandler);

      await client.waitForDiagnosticsAfter(
        uri,
        cursor,
        (items) => (
          items.length === 1
          && items[0].code === "missing-event-handler"
          && items[0].message.includes("__notInJs__")
        ),
        "realtime: missing-handler appears on didChange (length=1)",
      );

      // Now change the document to a fully clean buffer. Overlay should
      // re-parse and publish EXACTLY zero diagnostics (clean buffer has no
      // missing-handler AND no missing-component refs).
      const clean = '<view>plain</view>\n';
      const cursor2 = client.diagnosticCursor();
      client.changeDocument(HOME_WXML, clean, 3);

      await client.waitForDiagnosticsAfter(
        uri,
        cursor2,
        (items) => items.length === 0,
        "realtime: diagnostics clear to [] on clean revert",
      );
    });
  }
  ```

  Strong-form assertions: `length === 1` (with code + message check) and `length === 0`. Weaker forms like `items.some(...)` would pass if interleaved saved-graph publishes added extra entries (e.g., the missing-card from the disk-version of home.wxml). The strong form catches the race directly.

  `diagnosticCursor()` + `waitForDiagnosticsAfter()` pattern is already in the harness (used by other tests for sequential diagnostic checks).

- [ ] **Step 1b: Add `testOverlaySurvivesGraphRebuild` — Finding 1 race lock**

  Lock the Step 3b fix: an overlay published BEFORE a graph rebuild completes must NOT be overwritten by the post-rebuild publish. Use `client.changeWatchedFiles(...)` (existing harness API) on a sibling .wxml file to trigger a graph rebuild while the home.wxml overlay is in place.

  ```js
  async function testOverlaySurvivesGraphRebuild() {
    await withClient({ rootPath: ROOT }, async (client) => {
      const uri = client.openDocument(HOME_WXML);
      await client.waitForDiagnostics(
        uri,
        (items) => items.length === 1,
        "home initial diagnostics",
      );

      // Plant a missing-handler overlay on home.wxml.
      const withMissingHandler = '<view><button bind:tap="__overlay_survivor__">x</button></view>\n';
      const cursor = client.diagnosticCursor();
      client.changeDocument(HOME_WXML, withMissingHandler);
      await client.waitForDiagnosticsAfter(
        uri,
        cursor,
        (items) => (
          items.length === 1
          && items[0].code === "missing-event-handler"
          && items[0].message.includes("__overlay_survivor__")
        ),
        "race lock: overlay diagnostic published before rebuild",
      );

      // Trigger a graph rebuild on the same root via watched-files notification
      // on a sibling .wxml file. The rebuild will read disk (which still has
      // the original home.wxml content — no missing handler there) but the
      // publishPendingDiagnostics MUST honor home's overlay.
      const cursor2 = client.diagnosticCursor();
      client.changeWatchedFiles([USER_CARD_WXML]);

      await client.waitForDiagnosticsAfter(
        uri,
        cursor2,
        (items) => (
          items.length === 1
          && items[0].code === "missing-event-handler"
          && items[0].message.includes("__overlay_survivor__")
        ),
        "race lock: overlay diagnostic still present after graph rebuild",
      );
    });
  }
  ```

  Why `USER_CARD_WXML` (or any non-home .wxml): `handleWatchedFilesChanged` only triggers a rebuild if `isGraphAffectingPath` accepts the path. .wxml definitely qualifies. The user-card change is otherwise a no-op for home's diagnostics (the file content hasn't changed on disk; tree-sitter will re-parse the same bytes).

  This test will FAIL pre-fix (Finding 1): without Step 3b's change, the post-rebuild publish overwrites the overlay's diagnostic with the saved-disk-state diagnostics for home (which is the original 1-missing-card, NOT the overlay's missing-handler). With Step 3b applied, the overlay survives.

- [ ] **Step 1c: Add `testOverlayBeforeInitialGraph` — pre-graph-ready race lock**

  Exercises the path where a user opens a file and starts typing BEFORE the initial graph build finishes. Without `runOverlayDiagnostics` storing the overlay regardless of graph readiness (Step 1's "Critical ordering" note), the overlay would be skipped on the early timer firing and the deferred publishPendingDiagnostics call would publish stale-disk diagnostics.

  ```js
  async function testOverlayBeforeInitialGraph() {
    await withClient({ rootPath: ROOT }, async (client) => {
      const uri = client.openDocument(HOME_WXML);
      // Do NOT await initial diagnostics — fire didChange immediately. The
      // initial graph build is still in flight (subprocess; takes seconds).
      // The 150ms overlay debounce will fire well before the graph completes.
      const withMissingHandler = '<view><button bind:tap="__pre_graph__">x</button></view>\n';
      client.changeDocument(HOME_WXML, withMissingHandler);

      // Eventually, the user's observed diagnostic should reflect the
      // overlay (live buffer's missing handler) — not the disk's missing-
      // card. Order of publishes can be:
      //   A. Overlay timer fires first → stores overlay → graph not ready,
      //      no immediate publish → later graph completes → publishPending
      //      Diagnostics consults overlay → publishes missing-handler. ✓
      //   B. (Unlikely: graph build < 150ms) Graph completes first → no
      //      overlay yet → publishes disk missing-card. Then overlay timer
      //      fires → stores overlay → graph now ready → publishes missing-
      //      handler. Final state: missing-handler. ✓
      // Either way, the final stable state is the overlay's diagnostic.
      await client.waitForDiagnostics(
        uri,
        (items) => (
          items.length === 1
          && items[0].code === "missing-event-handler"
          && items[0].message.includes("__pre_graph__")
        ),
        "pre-graph race: overlay diagnostic surfaces (eventually) instead of disk state",
      );
    });
  }
  ```

  Without the Step 1 ordering fix, this test FAILS in scenario A (the dominant case): timer fires before graph ready → previous `if (!graph) return` short-circuits → overlay never stored → deferred publish has nothing to honor → user sees missing-card persistently.

- [ ] **Step 2: Register all three tests in scenarios + graph-smoke suite**

  Find the `scenarios` array (around line 1424). Add:

  ```js
  ["realtime diagnostics on didChange", testRealtimeDiagnosticsOnDidChange],
  ["overlay survives graph rebuild", testOverlaySurvivesGraphRebuild],
  ["overlay before initial graph", testOverlayBeforeInitialGraph],
  ```

  Find the `graph-smoke` array. Add:

  ```js
  "realtime diagnostics on didChange",
  "overlay survives graph rebuild",
  "overlay before initial graph",
  ```

- [ ] **Step 3: Run + verify**

  Run: `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke 2>&1 | tail -15`
  Expected: all three lines appear and the suite exits 0:
  - `[verify-lsp-diagnostics] realtime diagnostics on didChange`
  - `[verify-lsp-diagnostics] overlay survives graph rebuild`
  - `[verify-lsp-diagnostics] overlay before initial graph`

  Common failure modes:
  - Timer not firing: the test waits indefinitely for the diagnostic. Add `console.error("scheduled overlay for", uri)` in `scheduleOverlayDiagnostics` to confirm the schedule path is hit.
  - Diagnostic fires but with wrong message: the `__notInJs__` synthetic isn't being treated as a handler. Check `collectFile` extracted the `bind:tap` correctly (run extract-wxml-symbols.mjs against the synthetic text in a temp file to inspect output).
  - Cleared diagnostic doesn't disappear: did the second changeDocument actually publish? Verify by checking `diagnostics.length` after the second wait.
  - Test passes but graph-smoke flakes: race between the initial graph-build publish and the overlay publish. With strong-form `items.length === 1` assertions, both publishes need to converge on the same final state — `waitForDiagnosticsAfter` retries until the predicate matches, so the final stable state is what gets asserted. If flakes persist, log all publishes between cursor and assertion via `client.diagnosticsSince(cursor, uri)` to see the actual sequence.

- [ ] **Step 4: Run umbrella**

  Run: `bash scripts/verify-tree-sitter.sh 2>&1 | tail -3`
  Expected: ends with `wxml-zed tree-sitter verification passed`. Takes ~2-3 min (wasm rebuild).

  If umbrella fails on `npx tree-sitter-cli` EACCES (sandbox cache permissions), retry with sandbox disabled — environmental, not code.

- [ ] **Step 5: Commit Tasks 4 + 5 (feature + protocol test together)**

  ```bash
  git add server/wxml-lsp.mjs scripts/verify-lsp-diagnostics.mjs
  git commit -m "feat: realtime diagnostics on unsaved buffer (didChange overlay)

  P1 (3/4 + 4/4). textDocument/didChange now schedules a debounced
  (150ms per uri) overlay refresh that parses the live buffer via
  in-process tree-sitter-wxml, runs collectFile() to extract a
  fileModel, stores it in openDocumentOverlays, then publishes
  diagnostics computed with that override. Cross-file lookups
  (script.dataKeys, graph.unresolved, OTHER files) still come from
  the saved graph — overlay is single-file only.

  Lifecycle: didOpen/didSave/didClose clear the overlay; watched
  external changes (other files saved outside the editor) don't
  affect overlays. didSave additionally cancels any pending overlay
  timer for the uri so a delayed didChange can't republish stale
  state after disk-truth is back.

  Graceful degradation: if tree-sitter-wxml wasm fails to load,
  overlay path is silently disabled (single warning) and users
  fall back to save-time diagnostics — UX same as before this
  feature.

  testRealtimeDiagnosticsOnDidChange demonstrates the round trip:
  openDocument → changeDocument introducing missing handler →
  diagnostic surfaces within debounce window → changeDocument
  reverting → diagnostic clears. Registered in graph-smoke + full."
  ```

---

### Task 6: Notes + plan sync

**Files:**
- Modify: `docs/wasm-parser-spike-notes.md`
- Modify: this plan doc if anything diverged during execution

- [ ] **Step 1: Append the P1 outcome section to spike notes**

  Insert before the `**Regression anchor for parse-error case:**` block at the end. Cover:

  - Why P1 mattered: GPT dogfood found that completion was live but diagnostics save-frozen — UX split.
  - Architecture: open-document overlay, NOT graph mutation. Cross-file lookups still saved-graph; overlay is single-file only.
  - The `getDiagnostics({..., fileModelOverride})` interface — additive, all existing callers unchanged.
  - In-process tree-sitter-wxml parser in the LSP server is new — third place where the wasm gets loaded, after the two CLI extractors.
  - Graceful degradation: wasm load failure logs one warning and silently disables overlay path.
  - Debounce: 150ms per uri. Test reads buffer text at fire-time (not schedule-time) to absorb keystrokes between schedule and fire.
  - Lifecycle: didOpen/didSave/didClose clear overlay AND cancel pending timer. didSave-before-fire race specifically avoided.
  - Out of scope: cross-file overlays (.js with unsaved data: doesn't affect .wxml diagnostics).
  - Phase X carry-over: cross-file overlay; TS sibling support.

- [ ] **Step 2: Sync this plan if anything diverged**

  Re-read the plan and reconcile each code block against what shipped. Most-likely drift points: the `scheduleOverlayDiagnostics` parameter signature (kept text param vs dropped); the `withClient` test setup pattern (may have needed adjustment around `diagnosticCursor` placement).

- [ ] **Step 3: Commit**

  ```bash
  git add docs/wasm-parser-spike-notes.md docs/superpowers/plans/2026-05-20-realtime-diagnostics-overlay.md
  git commit -m "docs: record P1 (realtime diagnostics overlay) outcome in spike notes

  P1 closes the completion/diagnostic UX gap GPT dogfood surfaced:
  diagnostics now refresh while the user is typing, not just on save.
  Append section covering the open-document-overlay architecture
  (single-file overlay vs cross-file saved graph), getDiagnostics
  signature additivity, graceful wasm-load degradation, debounce
  lifecycle with explicit didSave/didChange race avoidance, and
  P1+ carry-overs (cross-file overlays, TS support)."
  ```

---

## Sequencing Notes

- Task 1 — pure refactor; baselines lock byte-identical output.
- Task 2 — `getDiagnostics` accepts override; new assertion proves it.
- Task 3 — server-side state + lifecycle scaffolding (no behavior change yet).
- Tasks 4 + 5 — didChange wiring + LSP protocol test, commit together.
- Task 6 — notes + plan sync.
- Total: 5 commits (refactor / getDiagnostics override / overlay scaffolding / overlay wiring+test / notes).

## Self-Review Checklist (run before handing off)

- [ ] All `Files:` paths resolve to real locations.
- [ ] Every step that changes code shows the actual code (no "..." or "similar to").
- [ ] Every step that runs a command shows the exact command and expected output.
- [ ] No "TBD" / "appropriate" / "similar to" placeholders.
- [ ] Type names consistent across tasks: `collectFile` (Task 1), `relativePathFromRoot` / `toPosix` (Task 1, also re-exported), `fileModelOverride` (Task 2), `getWxmlParser` / `openDocumentOverlays` / `overlayTimers` / `clearOverlay` / `cancelOverlayTimer` / `getOverlayFileModel` / `overlaysForRoot` / `scheduleOverlayDiagnostics` / `runOverlayDiagnostics` (Tasks 3–4).
- [ ] Task 1's helper list is FULL transitive closure: includes `toPosix`, `relativePathFromRoot`, `unquote`, `findAttributeByName`, `findAnyAttribute` (NOT just the obvious ones). The CLI's `extractFile()` continues to use `relativePathFromRoot` via re-import from shared.
- [ ] `getDiagnostics`'s `documentGraphPath` is computed from `documentPath` via path resolution (NOT from the fileModel), so it's stable across override vs graph paths. Verify by reading Task 2 Step 1's code.
- [ ] **`publishPendingDiagnostics` is overlay-aware (Finding 1 fix, Task 3 Step 3b).** Both call sites in `runGraphBuild` pass `fileModelOverride: overlay` through to `getDiagnostics`. Without this, every graph rebuild overwrites in-flight overlay diagnostics with stale-disk state.
- [ ] didSave clears overlay BEFORE calling `scheduleDiagnostics` so a delayed debounced didChange can't republish stale overlay state on disk-truth. Verify Task 3 Step 4.
- [ ] didOpen clears overlay via `fileUriToPath(uri)` directly (NOT via `openDocuments.get(uri)` — the document isn't recorded yet at didOpen time). Verify Task 3 Step 4.
- [ ] didChange reads `document.text` from `openDocuments` at fire-time, NOT from the closure passed at schedule-time. Verify Task 4 Step 1 — the design note explicitly calls this out.
- [ ] The new `realtime diagnostics on didChange` protocol test uses `diagnosticCursor()` + `waitForDiagnosticsAfter()`, NOT `waitForDiagnostics()` — the latter would match the initial-publish diagnostics that happened before the changeDocument.
- [ ] Protocol test assertions are length-checked (`items.length === 1 && code === "..."` for the missing-handler appears; `items.length === 0` for the clean revert), NOT `items.some(...)` — the weaker form would false-pass if interleaved saved-graph publishes added extra entries (the missing-card from disk-version of home.wxml).
- [ ] `testOverlaySurvivesGraphRebuild` uses `client.changeWatchedFiles([USER_CARD_WXML])` to deliberately trigger a graph rebuild while an overlay is in place, then asserts the overlay's diagnostic STILL stands. This test FAILS pre-Step-3b — it's the regression lock for the "publishPendingDiagnostics overwrites overlay" race.
- [ ] `testOverlayBeforeInitialGraph` fires didChange WITHOUT awaiting initial diagnostics, exercising the "user types before initial graph completes" path. With Step 1's parse-first ordering, the overlay is stored regardless of graph readiness and the deferred publishPendingDiagnostics publishes the live-buffer diagnostic. This test FAILS pre-Step-1's ordering fix — it's the regression lock for the "graph not ready" race.
- [ ] `runOverlayDiagnostics(uri)` parses and stores overlay BEFORE checking `graphsByRoot.get(projectRoot)`. The `if (!graph) return` exits AFTER the overlay store, so the deferred publishPendingDiagnostics flow can still pick it up. Reversing this order silently breaks Step 1c's test.
- [ ] All 7 wasm-symbol baselines stay byte-identical after Task 1.
- [ ] tree-sitter-wxml wasm load failure path is exercised mentally: parser is null → runOverlayDiagnostics returns early → no overlay populated → publishDiagnostics not called → users continue to see save-time-only diagnostics. No crash, no error spew per keystroke.

## Follow-Up — In-Flight Overlay Task Invalidation (Finding 2)

After ship, a second GPT review identified another race not covered by Tasks 3–5: `runOverlayDiagnostics` only re-checks state at entry. Once it crosses `await getWxmlParser()` (or any future intermediate await), nothing stops it from writing the overlay and publishing a non-empty diagnostic even after a `didClose` / `didSave` / superseding `didChange` has landed. Symptoms: stale diagnostic re-appears on a closed file; a fast burst of keystrokes can see an older buffer's diagnostic land after a newer one.

Fix shipped (single follow-up commit, not a separate plan):

- Add per-uri monotonic counter `overlayGenerationByUri` plus `bumpOverlayGeneration(uri)` / `currentOverlayGeneration(uri)`.
- Bump generation in `scheduleOverlayDiagnostics` (each didChange — bumped BEFORE arming the timer so the timer captures the freshest value) and in `clearOverlay` (didOpen / didSave / didClose).
- `runOverlayDiagnostics(uri, generation)` captures the generation at scheduling time, then re-checks `currentOverlayGeneration(uri) === generation` AND `openDocuments.has(uri)` at every gate: after the await on `getWxmlParser`, after the new test-only `WXML_ZED_LSP_OVERLAY_DELAY_MS` delay, before storing the overlay, and finally before publishing.
- Re-read `liveDoc = openDocuments.get(uri)` after the awaits — don't reuse the entry-time `document` reference (the buffer may have advanced same-generation if scheduling/bumping ordering ever changes, and a closed-then-reopened doc would have stale text otherwise).
- New regression test `overlay cancelled by didClose` in `scripts/verify-lsp-diagnostics.mjs`: spawns the LSP with `WXML_ZED_LSP_OVERLAY_DELAY_MS=400` to widen the run-window deterministically; does didChange → sleep 250ms (timer fired, task inside delay) → didClose → sleep 600ms; asserts every publish after the change cursor has `diagnostics.length === 0`. Pre-fix, the resumed task would write the overlay and republish a non-empty diagnostic — the test asserts against that.
- `WXML_ZED_LSP_OVERLAY_DELAY_MS` env var is documented in code as test-only; production never sets it, so the regression test exercises the real code path rather than a fork.

Verification: graph-smoke suite passed including the new test; `bash scripts/verify-tree-sitter.sh` umbrella green.
