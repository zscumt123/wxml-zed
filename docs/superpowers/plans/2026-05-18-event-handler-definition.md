# Event Handler Definition v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First user-visible feature on top of the Phase 1 data model: LSP `textDocument/definition` jumps from a WXML event-handler binding (`bind:tap="onTap"`) to the matching method in the sibling `.js` file. Lowest-risk LSP feature in the Phase 2 trio (definition / completion / diagnostic); failure mode is silent (returns null on miss) so false positives can't damage user trust.

**Architecture:** Add one branch in `server/wxml-language-service.mjs`'s `getDefinition()`. The branch sits **first** in dispatch order because `eventHandlers[].nameRange` is the most specific (handler name text only) and would otherwise be shadowed by the component-element check whose `range` covers the whole element including its attributes. Lookup walks the existing graph: `fileModel.eventHandlers[]` → owner config's `script.methods[]` → return `Location` with the method's `nameRange`. Dynamic handlers (`bind:tap="{{name}}"`, `dynamic: true` in the data model) silently return null — no static name to resolve.

**Verification:** Two layers.
- `scripts/verify-wxml-language-service.mjs` adds `assertEventHandlerDefinition` exercising the in-process language service against the home → handleSelect cross-reference. Locks the core logic.
- `scripts/verify-lsp-diagnostics.mjs` adds `testEventHandlerDefinition` exercising the JSON-RPC protocol layer end-to-end. Locks URI formatting, response shape, and ensures the wiring through `server/wxml-lsp.mjs`'s `textDocument/definition` handler still routes correctly. Registered in the suite list so smoke / graph-smoke / full all pick it up.

**Out of scope:**
- Completion at `bindtap="|"` cursor — Phase 2 Stage B
- Diagnostic for "handler bound in WXML but missing in JS" — Phase 2 Stage C
- Behavior method resolution / spread / Object.assign — v2 candidates list in notes
- TS/TSX — JS only
- Cross-page handler resolution (handler defined in another page's script) — not a real WeChat pattern; skip

**Tech Stack:** No new dependencies. Uses existing `containsPosition`, `findWxmlFileModel`, `locationForGraphPathWithRange` helpers in language-service. LSP protocol test mirrors `testHomeComponentDefinition` pattern.

---

## File Structure

- Modify: `server/wxml-language-service.mjs`
  - Add `eventHandlerDefinitionForPosition({graph, documentGraphPath, fileModel, position, extensionRoot})` helper
  - Wire as the first branch in `getDefinition()` (before component check)
- Modify: `scripts/verify-wxml-language-service.mjs`
  - Add `assertEventHandlerDefinition(graph)` covering home.wxml's `bind:select="handleSelect"` → home.js `handleSelect`
  - Add a negative case: `assertEventHandlerDefinitionMissingMethod(graph)` (cursor on a handler whose name isn't in script.methods → null)
  - Add a negative case: `assertEventHandlerDefinitionDynamicReturnsNull(graph)` — but only if a fixture has a dynamic-is binding. Currently no miniprogram fixture has one; skip this assertion or synthesize a minimal fixture. Plan deciding: **skip** (carrying the same "no synthetic fixtures for cases the data model has but tests don't need yet" precedent set in Stage B/C).
- Modify: `scripts/verify-lsp-diagnostics.mjs`
  - Add `testEventHandlerDefinition` using `client.definition(HOME_WXML, {line: 11, character: 20})`
  - Register in test list (where existing `testHomeComponentDefinition` is registered)

---

### Task 1: Implement Event Handler Branch in getDefinition()

**Files:**
- Modify: `server/wxml-language-service.mjs`

The new branch goes first in `getDefinition()` because nameRange is more specific than the component element's range. If a cursor inside `<user-card bind:select="handleSelect"/>` hits both (handler nameRange + component range), the handler must win.

- [ ] Add the helper function near the other `*ForPosition` helpers in `server/wxml-language-service.mjs`:

  ```js
  function eventHandlerDefinitionForPosition({ graph, documentGraphPath, fileModel, position, extensionRoot }) {
    const handlers = fileModel.eventHandlers ?? [];
    const match = handlers.find((entry) => containsPosition(entry.nameRange, position));
    if (!match) return null;
    if (match.dynamic) return null;

    const ownerConfig = graph.configs.find((c) => c.owner === documentGraphPath && c.script);
    if (!ownerConfig) return null;

    const method = ownerConfig.script.methods.find((m) => m.name === match.handler);
    if (!method) return null;

    return locationForGraphPathWithRange(ownerConfig.script.path, method.nameRange, extensionRoot);
  }
  ```

- [ ] In `getDefinition()`, insert the event handler check **before** the existing component check:

  ```js
  export function getDefinition({ graph, documentPath, position, extensionRoot }) {
    if (!position || typeof position.line !== "number" || typeof position.character !== "number") {
      return null;
    }

    const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
    if (!fileModel) {
      return null;
    }

    const eventHandlerDefinition = eventHandlerDefinitionForPosition({
      graph,
      documentGraphPath,
      fileModel,
      position,
      extensionRoot,
    });
    if (eventHandlerDefinition) {
      return eventHandlerDefinition;
    }

    const component = fileModel.components.find((entry) => containsPosition(entry.range, position));
    // ... rest unchanged ...
  }
  ```

- [ ] Verify: `node --check server/wxml-language-service.mjs` → exit 0.

### Task 2: Add Language-Service Assertion

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`

- [ ] Add the assertion function. The home.wxml `bind:select="handleSelect"` nameRange is rows/columns 11:17-11:29 per the baseline (`fixtures/wasm-spike/home-symbols-baseline.json`). Cursor at `{line: 11, character: 20}` is inside.

  home.js `handleSelect` is at row 9 (per the home.js fixture's structure). The method's nameRange points at the `handleSelect` property_identifier token. The assertion uses the helper `loadGraph()` already in the file and re-uses the LSP-position-style `{line, character}` shape.

  ```js
  function assertEventHandlerDefinition(graph) {
    const position = { line: 11, character: 20 };
    const result = getDefinition({
      graph,
      documentPath: HOME_WXML,
      position,
      extensionRoot: ROOT,
    });
    assert(result, "event handler definition: expected Location, got null");
    assert(
      result.uri.endsWith("/fixtures/miniprogram/pages/home/home.js"),
      `event handler definition: expected uri to end with home.js, got ${result.uri}`,
    );
    assert(
      typeof result.range.start.line === "number" && typeof result.range.start.character === "number",
      `event handler definition: bad range shape: ${JSON.stringify(result.range)}`,
    );
    // The exact line/character depends on home.js content; assert the line is
    // within reasonable bounds and the range is non-empty.
    assert(
      result.range.start.line >= 0 && result.range.start.line < 20,
      `event handler definition: start line out of range (${result.range.start.line})`,
    );
    assert(
      result.range.end.character > result.range.start.character || result.range.end.line > result.range.start.line,
      `event handler definition: empty range ${JSON.stringify(result.range)}`,
    );
  }

  function assertEventHandlerDefinitionMissingMethod(graph) {
    // Position inside home.wxml's bind:select handler name range, but
    // we'll target a fabricated lookup: this assertion exercises the
    // "handler exists in eventHandlers, name not in script.methods" path
    // by checking that getDefinition behaves correctly when there's no
    // matching method. We can't trigger this on real home.wxml because
    // handleSelect IS in home.js, so we test the negative branch via
    // mutating the graph in-memory: temporarily strip handleSelect from
    // home's script.methods and re-run.
    const homeConfig = graph.configs.find((c) => c.owner === "fixtures/miniprogram/pages/home/home.wxml");
    const original = homeConfig.script.methods;
    homeConfig.script.methods = original.filter((m) => m.name !== "handleSelect");
    try {
      const result = getDefinition({
        graph,
        documentPath: HOME_WXML,
        position: { line: 11, character: 20 },
        extensionRoot: ROOT,
      });
      assert(result === null, `expected null when method missing, got ${JSON.stringify(result)}`);
    } finally {
      homeConfig.script.methods = original;
    }
  }
  ```

  Note: `getDefinition` is already imported from the language-service module by this file (it's used by existing definition tests).

- [ ] Register both assertions in the bottom-of-file invocation block, right after the existing `assertDefinition(graph)` line:

  ```js
  assertEventHandlerDefinition(graph);
  assertEventHandlerDefinitionMissingMethod(graph);
  ```

- [ ] Verify: `node --check scripts/verify-wxml-language-service.mjs` → exit 0.
- [ ] Standalone run: `node scripts/verify-wxml-language-service.mjs` → exit 0.

### Task 3: Add LSP Protocol Test

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`

Mirror `testHomeComponentDefinition` pattern but target the event handler binding.

- [ ] Add `testEventHandlerDefinition` near the other definition tests (search for `async function testHomeComponentDefinition` to find the area):

  ```js
  async function testEventHandlerDefinition() {
    await withClient({ rootPath: ROOT }, async (client) => {
      const uri = client.openDocument(HOME_WXML);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before event handler definition");
      const result = await client.definition(HOME_WXML, { line: 11, character: 20 });
      assert(result, "expected Location from event handler definition, got null");
      assert(
        result.uri.endsWith("/fixtures/miniprogram/pages/home/home.js"),
        `event handler definition uri: expected home.js, got ${result.uri}`,
      );
      assert(
        typeof result.range.start.line === "number",
        `event handler definition range shape bad: ${JSON.stringify(result.range)}`,
      );
    });
  }
  ```

- [ ] Register `testEventHandlerDefinition` in the test list. Search for `"home component definition"` to find the registration block — the pattern is `["test label", testFunction]` entries. Add new entry right after `testHomeComponentDefinition`:

  ```js
  ["event handler definition", testEventHandlerDefinition],
  ```

- [ ] **Also add to the graph-smoke suite list** so the test runs under `--suite graph-smoke` not just `--suite full`. Search for "graph-smoke" usage in the file to find the suite-membership logic and add accordingly. If there's no opt-in, the test will run under `full` only; that's acceptable for v1 — note this in the outcome doc.

- [ ] Verify: `node --check scripts/verify-lsp-diagnostics.mjs` → exit 0.
- [ ] Standalone smoke run: `node scripts/verify-lsp-diagnostics.mjs --suite full 2>&1 | tail -20`. Look for `[verify-lsp-diagnostics] event handler definition` line. Exit 0 required.

### Task 4: Run Umbrella

**Files:** none (verification only)

- [ ] `bash scripts/verify-tree-sitter.sh 2>&1 | tail -15`. Must end with `wxml-zed tree-sitter verification passed`.

### Task 5: Single Commit

- [ ] Inspect:
  ```bash
  git status
  ```
  Expected modified:
  - `M server/wxml-language-service.mjs`
  - `M scripts/verify-wxml-language-service.mjs`
  - `M scripts/verify-lsp-diagnostics.mjs`
  
  Expected new:
  - `?? docs/superpowers/plans/2026-05-18-event-handler-definition.md`

- [ ] Stage:
  ```bash
  git add server/wxml-language-service.mjs \
          scripts/verify-wxml-language-service.mjs \
          scripts/verify-lsp-diagnostics.mjs \
          docs/superpowers/plans/2026-05-18-event-handler-definition.md
  ```
- [ ] Commit:
  ```bash
  git commit -m "$(cat <<'EOF'
  feat: lsp definition for wxml event handlers -> js methods

  Phase 2 Stage A of Event Handler Intelligence v1. First user-visible
  LSP feature built on the Stage C data model: textDocument/definition
  at the cursor inside a WXML bindtap="onTap" handler name jumps to
  the matching method in the owner's sibling .js file.

  Logic in server/wxml-language-service.mjs's getDefinition() walks
  the existing graph: fileModel.eventHandlers[].nameRange match by
  cursor position -> owner config's script.methods[] lookup by handler
  name -> Location with method's nameRange. Dynamic handlers
  (bind:tap="{{name}}", dynamic: true in data model) silently return
  null. The new branch dispatches BEFORE the component check because
  the nameRange (handler text only) is more specific than the
  component element's range (whole element).

  Verified at two layers:
  - verify-wxml-language-service.mjs: assertEventHandlerDefinition
    locks the home.wxml bind:select="handleSelect" -> home.js
    handleSelect cross-reference; plus assertEventHandlerDefinitionMissingMethod
    locks the null path when a script.methods lookup misses.
  - verify-lsp-diagnostics.mjs: testEventHandlerDefinition exercises
    the JSON-RPC protocol layer end to end.

  No completion or diagnostic yet — those are Stage B and C of Phase 2.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```
- [ ] `git status` → clean.

---

## Self-Review

**Spec coverage:**
- Event handler definition branch in getDefinition() → Task 1 ✅
- Dispatch order corrected (event handler before component) → Task 1 ✅
- Dynamic handler → null → Task 1 (explicit check) ✅
- Language-service assertion locking happy path + negative → Task 2 ✅
- LSP protocol test → Task 3 ✅
- Umbrella stays passing → Task 4 ✅
- Single commit → Task 5 ✅

**Placeholders:** Task 2's `assertEventHandlerDefinitionMissingMethod` uses in-memory graph mutation to exercise the null path — concrete code, not vague. Task 3's "add to graph-smoke suite list" is conditional on the file's structure; explicit fallback documented (just `full` works for v1).

**Type consistency:**
- `Location` shape `{uri, range: {start: {line, character}, end: {line, character}}}` used identically in language-service helper and protocol test.
- `nameRange` flows from extractor (row/column) through `locationForGraphPathWithRange` (which converts via `rangeFromSymbolRange`) into LSP range (line/character).

**Plan-doc-sync check** (per memory `sync-plan-after-inline-fixes`):
- File Structure lists all three modified files + plan doc ✅
- Task 5 expected status + git add list mirrors File Structure ✅
- If execution surfaces a needed change (e.g. dispatch order needs adjustment, or the LSP protocol test needs an extra setup step), update THIS plan before committing.

**Known fragility:**
- The `assertEventHandlerDefinitionMissingMethod` mutates and restores graph in-memory. If the assertion throws between mutate and restore, the restore happens in `finally`. Other downstream assertions on the same `graph` object see the restored state. Safe.
- Cursor position `{line: 11, character: 20}` is keyed to current home.wxml content. If anyone edits home.wxml to shift line numbers, this assertion will silently break (cursor lands in different content). Mitigation: the assertion message includes "expected uri to end with home.js" — a clear failure message tells the maintainer to update the position. Long-term: derive cursor position dynamically from the baseline data; defer.
- LSP protocol test requires the LSP server's graph build path to find home.js. If anything in graph extraction regresses to omit script fields, this test will fail with a null result — which is desired (it would catch a real regression).
