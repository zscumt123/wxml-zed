# Event Handler Completion v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 2 Stage B of the Event Handler Intelligence v1 trio. When the user types inside a WXML event-binding attribute value — e.g. `bind:tap="|"` or `bindchange="hand|"` — LSP `textDocument/completion` returns the list of method names defined in the sibling `.js` file's `Page({...})` / `Component({...})` factory call.

**Architecture:** Adds one new context matcher (`eventHandlerValueContext`) to `server/wxml-language-service.mjs`'s sourceText-driven completion dispatch (alongside the existing `tagNameContext` / `attributeContext` / `templateIsContext`). Detection is purely sourceText regex against the line prefix — **not** AST-based — because mid-typing positions often produce broken/recovering tree shapes where `fileModel.eventHandlers[]` does not have a usable entry. Method names come from `graph.configs[owner].script.methods[]` (already populated by Phase 1 Stage C3). Dynamic values (`bind:tap="{{name}}"`) are excluded automatically by the pre-existing `isExcludedCompletionContext` check that suppresses completions inside `{{...}}`.

**Verification:** Two layers, mirroring Stage A.
- `scripts/verify-wxml-language-service.mjs` adds `assertEventHandlerCompletion` (in-process `getCompletions` call against home → handleSelect) plus negative cases for "no sibling script" and "non-event attribute value".
- `scripts/verify-lsp-diagnostics.mjs` adds `testEventHandlerCompletion` (JSON-RPC end-to-end). Registered in `graph-smoke` and `full` suites; `verify-tree-sitter.sh` already runs `--suite graph-smoke` (per Stage A post-merge fix), so umbrella picks it up.

**Out of scope:**
- Method resolution from `behaviors: [...]` / spread / `Object.assign({...}, methods)` — v2 candidates
- TS / TSX sibling files — v2
- Cross-page handlers (handler defined in another page's script) — not a real WeChat pattern
- Completion of *event names* themselves (`bind:|`) — different feature; would need a list of known event types
- Diagnostic for "handler bound but no matching method" — Phase 2 Stage C

**Tech Stack:** No new dependencies. Reuses `EVENT_PATTERNS` from `scripts/extract-wxml-symbols.mjs` (refactored into a shared module to match the pattern set by `shared/js-method-extractor.mjs`). Uses existing `findWxmlFileModel`, `currentLinePrefix`, `contextRange`, `completionItem`, `isExcludedCompletionContext` helpers.

---

## File Structure

- Create: `shared/event-binding-patterns.mjs`
  - Exports the `EVENT_PATTERNS` regex array (moved from `extract-wxml-symbols.mjs`), the existing `matchEventBinding(name)` helper, and a new **stricter** `isEventHandlerCompletionTrigger(name)` helper.
  - **Why two helpers:** the data-model path (`extract-wxml-symbols.mjs`) keeps the loose `matchEventBinding` to preserve Stage 1 baselines and capture any plausible event binding. The completion path uses the stricter `isEventHandlerCompletionTrigger`, which accepts **any** colon-form (`bind:foo` / `catch:foo` / `capture-bind:foo` / `capture-catch:foo` / `mut-bind:foo`) but accepts no-colon forms (`bindtap` / `catchchange`) only when the suffix is a WeChat built-in event name. Rationale: loose matching produces false positives on real attribute names like `binding="..."`, `bindable="..."`, `catching="..."`, which would pop up a methods menu in user-facing UI on completely unrelated attributes. The colon form is unambiguous; the no-colon form is bounded by WeChat's built-in event vocabulary.
- Modify: `scripts/extract-wxml-symbols.mjs`
  - Replace local `EVENT_PATTERNS` definition with an import from `shared/event-binding-patterns.mjs`. Pure refactor; baselines must remain byte-identical.
- Modify: `server/wxml-language-service.mjs`
  - Add `eventHandlerValueContext(sourceText, position)` — sourceText regex detection returning `{ type: "event-handler-value", typed, range }` or undefined.
  - Add `eventHandlerCompletionItems(graph, documentGraphPath, range)` — pulls method names from `graph.configs[owner].script.methods[]`.
  - Wire as the **first** content-context branch in `getCompletions()` (before tag/template/attribute) — the line-prefix patterns are mutually exclusive, but putting the most specific first matches Stage A's dispatch convention and makes the semantic visible.
- Modify: `scripts/verify-wxml-language-service.mjs`
  - Add `assertEventHandlerCompletion(graph)` — home.wxml at `bind:select="hand|leSelect"`, expect `handleSelect` in items + correct textEdit range.
  - Add `assertEventHandlerCompletionEmptyTyped(graph)` — at `bind:select="|handleSelect"`, expect items returned with `range.start === range.end` of cursor position.
  - Add `assertEventHandlerCompletionShortFormBindtap(graph)` — synthetic `<view bindtap="hand|"></view>`, **positive** case proving the no-colon-but-whitelisted path triggers.
  - Add `assertEventHandlerCompletionBindingAttrIsNotEvent(graph)` — synthetic `<view binding="hand|"></view>`, **negative** for the no-colon-but-not-whitelisted false-positive class GPT flagged (binding/bindable/bindings/catching/bindAttr).
  - Add `assertEventHandlerCompletionInDynamicExpression(graph)` — synthetic `<view bindtap="{{han|}}"></view>`, **negative** locking the dynamic-suppression regression (relies on `isExcludedCompletionContext` firing before the event-handler branch).
  - Add `assertEventHandlerCompletionNoSiblingScript(graph)` — mutate graph in-memory to drop `script` from the owner config, expect `[]`.
  - Add `assertEventHandlerCompletionInClassAttr(graph)` — cursor inside `class="..."` value, expect **no** event-handler items leaked.
  - Add `assertEventHandlerCompletionSkipsComponentLifecycle(graph)` — mutate graph in-memory to inject a `kind: "component-lifecycle"` entry into the owner config's `script.methods`, expect that name **does not** appear in completion labels.
- Modify: `scripts/verify-lsp-diagnostics.mjs`
  - Add `testEventHandlerCompletion` async function using `client.completion(HOME_WXML, {line: 11, character: 21})`.
  - Add `"event handler completion"` to `scenarios` array and to both `graph-smoke` and `full` suite lists.

---

### Task 1: Extract EVENT_PATTERNS to shared module

**Files:**
- Create: `shared/event-binding-patterns.mjs`
- Modify: `scripts/extract-wxml-symbols.mjs:19-25`

Pure refactor. The patterns are needed in two places (symbol extraction + completion context detection), and the cross-cutting placement should match the `shared/js-method-extractor.mjs` precedent from Phase 1 Stage C1.

- [ ] **Step 1: Create the shared module**

  Create `shared/event-binding-patterns.mjs` with exactly the content moved from `extract-wxml-symbols.mjs:19-25`, plus the stricter completion-trigger helper:

  ```js
  // WXML event binding attribute prefixes, ordered most-specific first.
  // Capture forms must precede plain bind/catch so that e.g. `capture-bindtap`
  // is parsed as binding=capture-bind/event=tap, not binding=bind/event=apture-bindtap.
  export const EVENT_PATTERNS = [
    { re: /^(capture-(?:bind|catch)):(.+)$/, bindingFromMatch: (m) => `${m[1]}:`, eventFromMatch: (m) => m[2] },
    { re: /^(capture-(?:bind|catch))(.+)$/,  bindingFromMatch: (m) => m[1],       eventFromMatch: (m) => m[2] },
    { re: /^mut-bind:(.+)$/,                  bindingFromMatch: () => "mut-bind:", eventFromMatch: (m) => m[1] },
    { re: /^(bind|catch):(.+)$/,              bindingFromMatch: (m) => `${m[1]}:`, eventFromMatch: (m) => m[2] },
    { re: /^(bind|catch)(.+)$/,               bindingFromMatch: (m) => m[1],       eventFromMatch: (m) => m[2] },
  ];

  // Loose matcher: used by symbol extraction (`extract-wxml-symbols.mjs`).
  // Accepts any string that fits one of the EVENT_PATTERNS, including
  // false-positives like `binding` -> {bind, "ing"}. Intentional — the
  // data model captures anything plausible; the completion path uses a
  // stricter gate below.
  export function matchEventBinding(attrName) {
    for (const p of EVENT_PATTERNS) {
      const m = attrName.match(p.re);
      if (m) return { binding: p.bindingFromMatch(m), event: p.eventFromMatch(m) };
    }
    return null;
  }

  // WeChat built-in event names that legitimately appear in the no-colon
  // shorthand form (`bindtap`, `catchchange`, `capture-bindtouchstart`).
  // Source: WeChat Mini-Program WXML event documentation. Custom-component
  // events should use the colon form (`bind:select`) and are accepted by
  // `isEventHandlerCompletionTrigger` via the colon-form branch — so this
  // list does not need to enumerate them.
  //
  // Conservative seed list. If users hit false-negatives for legitimate
  // built-in events not listed here, extend rather than relaxing to the
  // loose matcher above.
  const BUILTIN_EVENT_NAMES = new Set([
    "tap", "longpress", "longtap",
    "touchstart", "touchmove", "touchcancel", "touchend", "touchforcechange",
    "transitionend",
    "animationstart", "animationiteration", "animationend",
    "scroll", "scrolltoupper", "scrolltolower",
    "input", "change", "focus", "blur", "confirm", "submit", "reset",
    "load", "error",
  ]);

  // Strict matcher: used by completion (`server/wxml-language-service.mjs`).
  // Returns true iff the attribute name is unambiguously an event binding
  // for completion-trigger purposes. Colon forms require a non-empty event
  // suffix (so `bind:` / `catch:` alone do not trigger). No-colon forms
  // require the suffix to be a known WeChat built-in event name. Rejects:
  // `binding`, `bindable`, `bindings`, `catching`, `bindAttr`, `bind:`,
  // `catch:`, plain `bind`, plain `catch`, etc.
  export function isEventHandlerCompletionTrigger(attrName) {
    if (/^(?:capture-(?:bind|catch)|mut-bind|bind|catch):.+$/.test(attrName)) {
      return true;
    }
    const m = attrName.match(/^(?:capture-(?:bind|catch)|bind|catch)(.+)$/);
    if (!m) return false;
    return BUILTIN_EVENT_NAMES.has(m[1]);
  }
  ```

- [ ] **Step 2: Update extract-wxml-symbols.mjs to import from shared**

  In `scripts/extract-wxml-symbols.mjs`:
  - Delete the inline `EVENT_PATTERNS` array (lines 19-25) and the local `matchEventBinding` function (lines 27-33).
  - Add to the top of the file (next to other imports):
    ```js
    import { matchEventBinding } from "../shared/event-binding-patterns.mjs";
    ```
  - Verify call sites still resolve: `grep -n "matchEventBinding\|EVENT_PATTERNS" scripts/extract-wxml-symbols.mjs` should show only the import + usages, no definition.

- [ ] **Step 3: Run baseline regression to prove refactor is byte-identical**

  Run: `node scripts/verify-wasm-symbol-baselines.mjs`
  Expected: exit 0, all baselines unchanged.

  If any baseline diff appears, the refactor introduced a behavior change — revert and investigate. This is a pure import-relocation; there should be no diff.

- [ ] **Step 4: Run umbrella to confirm nothing else broke**

  Run: `node scripts/verify-wxml-language-service.mjs && node scripts/verify-js-method-baselines.mjs`
  Expected: both exit 0.

- [ ] **Step 5: Commit**

  ```bash
  git add shared/event-binding-patterns.mjs scripts/extract-wxml-symbols.mjs
  git commit -m "refactor: extract EVENT_PATTERNS to shared module

  Phase 2 Stage B prep: completion-side context detection needs the
  same prefix list as symbol extraction. Mirror shared/js-method-extractor
  precedent: a focused shared module with the pattern array and two
  helpers (matchEventBinding + isEventHandlerCompletionTrigger).
  Baseline-verified byte-identical."
  ```

---

### Task 2: Add eventHandlerValueContext detector

**Files:**
- Modify: `server/wxml-language-service.mjs`

The detector identifies "cursor sits inside the quoted value of an event-binding attribute". It uses sourceText regex (not AST), same approach as the existing `tagNameContext` / `attributeContext` / `templateIsContext` matchers in the same file.

Why regex over AST: during mid-typing, tree-sitter may not yet have a complete `attribute` node containing the cursor. The existing context matchers chose regex for the same reason. Behavior should be consistent within `getCompletions`.

- [ ] **Step 1: Add the import for isEventHandlerCompletionTrigger**

  At the top of `server/wxml-language-service.mjs`, add:
  ```js
  import { isEventHandlerCompletionTrigger } from "../shared/event-binding-patterns.mjs";
  ```

  Note: import the **strict** helper, not `matchEventBinding`. The data-model lax behavior must not leak into completion-trigger logic — see Task 1 Step 1 rationale.

- [ ] **Step 2: Add eventHandlerValueContext near the other context helpers**

  Insert this function right after `attributeContext` (around `server/wxml-language-service.mjs:305`):

  **Important**: this helper is **multi-line aware**, diverging from the existing single-line `attributeContext` matcher. WXML's idiomatic custom-component layout (`<user-card\n  wx:for=...\n  bind:select="..."`) means cursor positions sit on continuation lines where the `<` is many lines back. A line-prefix-only scan misses those. Walk back through the full source slice up to the cursor offset to find the nearest unterminated `<` (rejecting if any unquoted `>` appears in between). The `typed` portion must not span newlines, otherwise the textEdit range computation would point to a different line.

  ```js
  function eventHandlerValueContext(sourceText, position) {
    // Multi-line aware: walk back through the source slice (not just the
    // current line's prefix) to handle `<tag\n  bind:foo="..."` shapes.
    const offset = offsetAt(sourceText, position);
    if (offset === undefined) return undefined;
    const slice = sourceText.slice(0, offset);
    const openIndex = slice.lastIndexOf("<");
    if (openIndex === -1) return undefined;
    if (slice.slice(openIndex).startsWith("</")) return undefined;

    // Reject if any `>` outside an attribute-value quote appears between
    // the `<` and the cursor — the tag was already closed.
    const tagSlice = slice.slice(openIndex);
    let inQuote = null;
    for (let i = 1; i < tagSlice.length; i += 1) {
      const ch = tagSlice[i];
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === ">") {
        return undefined;
      }
    }

    // Tag-name guard: mirrors `attributeContext`'s `/^[A-Za-z][\w-]*(?:\s|$)/u`
    // check. Stray `<` in text content (`text < bindtap="..."`) must not fall
    // through.
    const tagContent = tagSlice.slice(1);
    if (!/^[A-Za-z][\w-]*(?:\s|$)/u.test(tagContent)) return undefined;

    // Find attr=value at the trailing edge of the tag content. The character
    // class `[^"'<>]` bounds `typed` to not cross quotes (past the value) or
    // angle brackets (past the tag).
    const match = tagContent.match(/\s([\w:-]+)=(["'])([^"'<>]*)$/u);
    if (!match) return undefined;

    const attrName = match[1];
    if (!isEventHandlerCompletionTrigger(attrName)) return undefined;

    const typed = match[3];
    // textEdit.range assumes `typed` lives on the cursor's line.
    if (typed.includes("\n")) return undefined;

    const startCharacter = position.character - typed.length;
    return {
      type: "event-handler-value",
      typed,
      range: contextRange(position, startCharacter),
    };
  }
  ```

  Notes:
  - Multi-line scan is a deliberate divergence from `attributeContext`. Promoting the scan into a shared helper and bringing `attributeContext` along is scope creep here.
  - Quote-state tracking in the `>` rejection loop matters: `>` inside `attr=">"` shouldn't terminate the scan.
  - The `typed.includes("\n")` guard is the safety valve against cross-line typed text producing a bogus `startCharacter`.

- [ ] **Step 3: Verify the file still parses**

  Run: `node --check server/wxml-language-service.mjs`
  Expected: exit 0.

- [ ] **Step 4: No commit yet** — Task 3 wires this up. Keeping changes uncommitted across Tasks 2–4 keeps the working tree consistent (a half-wired helper would be dead code at commit time).

---

### Task 3: Add eventHandlerCompletionItems data assembly

**Files:**
- Modify: `server/wxml-language-service.mjs`

- [ ] **Step 1: Add the items builder near the other `*CompletionItems` helpers**

  Insert after `attributeCompletionItems` (around `server/wxml-language-service.mjs:390`):

  ```js
  function eventHandlerCompletionItems(graph, documentGraphPath, range) {
    const ownerConfig = graph.configs.find((c) => (
      c.owner === documentGraphPath && c.script && Array.isArray(c.script.methods)
    ));
    if (!ownerConfig) return [];

    const seen = new Set();
    const items = [];
    for (const method of ownerConfig.script.methods) {
      if (typeof method.name !== "string" || method.name.length === 0) continue;
      // Skip Component({...}) top-level lifecycle hooks (`attached`,
      // `ready`, `detached`, `moved`, etc.). They live alongside `methods:`
      // in the same options object so the extractor records them with
      // `kind: "component-lifecycle"`, but they are not event handlers.
      // Page-method kinds (`page-method`) are *not* filtered: WeChat Page
      // lifecycle (`onLoad`, `onShow`, ...) shares the same options object
      // as custom handlers and the extractor cannot tell them apart by
      // kind alone — accept the small false-positive surface there until
      // a future kind refinement.
      if (method.kind === "component-lifecycle") continue;
      if (seen.has(method.name)) continue;
      seen.add(method.name);
      items.push(completionItem(method.name, COMPLETION_ITEM_KIND_FUNCTION, "method", range));
    }
    items.sort((a, b) => a.label.localeCompare(b.label));
    return items;
  }
  ```

  `COMPLETION_ITEM_KIND_FUNCTION` is already used by templates in this file (`visibleTemplateCompletionItems` line 366). Methods are functions; the same kind is the right LSP choice (Method kind = 2 also valid but Function = 3 matches the existing template usage and avoids inventing a new constant).

- [ ] **Step 2: Verify the file still parses**

  Run: `node --check server/wxml-language-service.mjs`
  Expected: exit 0.

---

### Task 4: Wire eventHandlerValueContext into getCompletions dispatch

**Files:**
- Modify: `server/wxml-language-service.mjs:413-443`

Insert the new branch as the **first** content-context check inside `getCompletions`. The line-prefix patterns are mutually exclusive (attribute-value detection requires the `="..."` form which the others don't match), but Stage A established a "most specific first, authoritative-on-detect" convention. Following it makes the dispatch order self-documenting.

- [ ] **Step 1: Modify getCompletions to add the event-handler branch**

  Find the existing function body:

  ```js
  export function getCompletions({ graph, documentPath, position, sourceText, extensionRoot }) {
    if (typeof sourceText !== "string") {
      return [];
    }
    const offset = offsetAt(sourceText, position);
    if (offset === undefined || isExcludedCompletionContext(sourceText, offset)) {
      return [];
    }

    const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
    if (!fileModel) {
      return [];
    }

    const templateContext = templateIsContext(sourceText, position);
    if (templateContext) {
      return visibleTemplateCompletionItems(graph, fileModel, templateContext.range);
    }
    // ... rest ...
  ```

  Insert the new branch immediately after the `findWxmlFileModel` guard and **before** `templateIsContext`:

  ```js
    const handlerValueContext = eventHandlerValueContext(sourceText, position);
    if (handlerValueContext) {
      return eventHandlerCompletionItems(graph, documentGraphPath, handlerValueContext.range);
    }
  ```

  Final getCompletions body should read:
  ```js
  export function getCompletions({ graph, documentPath, position, sourceText, extensionRoot }) {
    if (typeof sourceText !== "string") return [];
    const offset = offsetAt(sourceText, position);
    if (offset === undefined || isExcludedCompletionContext(sourceText, offset)) return [];

    const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
    if (!fileModel) return [];

    const handlerValueContext = eventHandlerValueContext(sourceText, position);
    if (handlerValueContext) {
      return eventHandlerCompletionItems(graph, documentGraphPath, handlerValueContext.range);
    }

    const templateContext = templateIsContext(sourceText, position);
    if (templateContext) return visibleTemplateCompletionItems(graph, fileModel, templateContext.range);

    const tagContext = tagNameContext(sourceText, position);
    if (tagContext) return componentCompletionItems(graph, documentGraphPath, tagContext.range);

    const attrContext = attributeContext(sourceText, position);
    if (attrContext) return attributeCompletionItems(attrContext.range);

    return [];
  }
  ```

  (Note: I collapsed the existing `if (...) {\n  return ...\n}` blocks to single-line form *only if* they fit comfortably. If they don't, leave them as-is — don't reformat unrelated code.)

- [ ] **Step 2: Verify the file still parses**

  Run: `node --check server/wxml-language-service.mjs`
  Expected: exit 0.

- [ ] **Step 3: No commit yet** — Task 5 adds the assertions that prove the wiring works. Commit after the test passes.

---

### Task 5: Add language-service assertions

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`

home.wxml line 12 is `    bind:select="handleSelect"` (4 spaces indent, then 13 chars `bind:select="`, then `handleSelect` from col 17 to col 28 inclusive, closing `"` at col 29). Source-of-truth for these offsets is `fixtures/miniprogram/pages/home/home.wxml` line 12 — re-verify if the fixture changes.

home.js was added in Phase 1 Stage C3 with `handleSelect` as a method. `script.methods` will at minimum contain `handleSelect`.

- [ ] **Step 1: Confirm imports — no changes needed**

  `getCompletions` is already in the import list at `scripts/verify-wxml-language-service.mjs:7-12` (verified at plan time). The file uses `fs.readFileSync(...)` (qualified, not destructured) — see line 64 for the existing pattern. The assertions below use that same pattern. No import changes required.

- [ ] **Step 2: Add the positive assertion**

  Add this function alongside the existing `assertEventHandlerDefinition` definitions:

  ```js
  function assertEventHandlerCompletion(graph) {
    // home.wxml line 12: `    bind:select="handleSelect"`
    //   - cols 0-3: indent
    //   - cols 4-15: `bind:select=`
    //   - col 16: opening `"`
    //   - cols 17-28: `handleSelect`
    //   - col 29: closing `"`
    // Position {line: 11, character: 21} sits after `hand` — typed = "hand".
    const sourceText = fs.readFileSync(HOME_WXML, "utf8");
    const position = { line: 11, character: 21 };

    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText,
      extensionRoot: ROOT,
    });

    assert(Array.isArray(items), `event handler completion: expected array, got ${typeof items}`);
    const labels = items.map((item) => item.label);
    assert(
      labels.includes("handleSelect"),
      `event handler completion: missing handleSelect; got ${JSON.stringify(labels)}`,
    );

    const handleSelectItem = items.find((item) => item.label === "handleSelect");
    assert(handleSelectItem.textEdit, "event handler completion: missing textEdit");
    assert(
      handleSelectItem.textEdit.range.start.line === 11 &&
      handleSelectItem.textEdit.range.start.character === 17 &&
      handleSelectItem.textEdit.range.end.line === 11 &&
      handleSelectItem.textEdit.range.end.character === 21,
      `event handler completion: bad range ${JSON.stringify(handleSelectItem.textEdit.range)}`,
    );
    assert(
      handleSelectItem.textEdit.newText === "handleSelect",
      `event handler completion: bad newText ${handleSelectItem.textEdit.newText}`,
    );
  }
  ```

- [ ] **Step 3: Add the empty-typed assertion**

  ```js
  function assertEventHandlerCompletionEmptyTyped(graph) {
    // Position {line: 11, character: 17} sits immediately after `"` — typed = "".
    const sourceText = fs.readFileSync(HOME_WXML, "utf8");
    const position = { line: 11, character: 17 };

    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText,
      extensionRoot: ROOT,
    });

    const labels = items.map((item) => item.label);
    assert(
      labels.includes("handleSelect"),
      `event handler completion (empty typed): missing handleSelect; got ${JSON.stringify(labels)}`,
    );

    const handleSelectItem = items.find((item) => item.label === "handleSelect");
    assert(
      handleSelectItem.textEdit.range.start.character === 17 &&
      handleSelectItem.textEdit.range.end.character === 17,
      `event handler completion (empty typed): expected empty range at col 17, got ${JSON.stringify(handleSelectItem.textEdit.range)}`,
    );
  }
  ```

- [ ] **Step 4: Add the no-sibling-script negative assertion**

  Important: `graph.configs[].owner` is a **repo-relative POSIX path** (e.g. `"fixtures/miniprogram/pages/home/home.wxml"`), not an absolute path. `HOME_WXML` is absolute. Use the literal string for the graph lookup — this matches the precedent set by Stage A's `assertEventHandlerDefinitionMissingMethod` at `scripts/verify-wxml-language-service.mjs:177`.

  ```js
  const HOME_WXML_GRAPH_PATH = "fixtures/miniprogram/pages/home/home.wxml";

  function assertEventHandlerCompletionNoSiblingScript(graph) {
    // Surgical in-memory mutation: drop the script from home's owner config.
    // Restore at the end to avoid bleeding into other assertions.
    const ownerConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH && c.script);
    assert(ownerConfig, "test setup: expected home owner config with script");
    const savedScript = ownerConfig.script;
    delete ownerConfig.script;

    try {
      const sourceText = fs.readFileSync(HOME_WXML, "utf8");
      const items = getCompletions({
        graph,
        documentPath: HOME_WXML,
        position: { line: 11, character: 21 },
        sourceText,
        extensionRoot: ROOT,
      });
      assert(
        Array.isArray(items) && items.length === 0,
        `event handler completion (no script): expected [], got ${JSON.stringify(items)}`,
      );
    } finally {
      ownerConfig.script = savedScript;
    }
  }
  ```

  (Place `HOME_WXML_GRAPH_PATH` near the top with the other path constants, not inside the assertion. The other assertions in this section that mutate the graph in-memory will reuse it.)

- [ ] **Step 5: Add the synthetic negative/positive assertions using `sourceWithCursor`**

  All synthetic-source assertions below use the existing `sourceWithCursor()` helper at `scripts/verify-wxml-language-service.mjs:48`. Pattern: write the WXML fragment with a `|` marker where the cursor goes; the helper returns clean source + line/character coords. This avoids hand-counting columns (and the off-by-one bugs that follow). Same pattern is already used 9 times in the file (e.g. `sourceWithCursor("<vi|")`, `sourceWithCursor('<view class="|" />')`).

  All assertions below pass `documentPath: HOME_WXML` so `getCompletions` resolves through home's owner config (with its `script.methods`). The synthetic sourceText is what drives the context-matcher path; the documentPath drives the data lookup. They don't need to agree on content — that's intentional and safe.

  ```js
  function assertEventHandlerCompletionInClassAttr(graph) {
    // class="..." must not trigger handler completion.
    const { source, position } = sourceWithCursor('<view class="my-cl|">\n');

    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });

    const labels = items.map((item) => item.label);
    assert(
      !labels.includes("handleSelect"),
      `event handler completion (class attr): leaked handleSelect into class value; got ${JSON.stringify(labels)}`,
    );
  }

  function assertEventHandlerCompletionShortFormBindtap(graph) {
    // No-colon shorthand `bindtap` — suffix `tap` is in BUILTIN_EVENT_NAMES,
    // so the strict trigger accepts it. Expect handleSelect in labels.
    const { source, position } = sourceWithCursor('<view bindtap="hand|"></view>\n');

    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });

    const labels = items.map((item) => item.label);
    assert(
      labels.includes("handleSelect"),
      `event handler completion (bindtap short form): missing handleSelect; got ${JSON.stringify(labels)}`,
    );
  }

  function assertEventHandlerCompletionBindingAttrIsNotEvent(graph) {
    // `binding="..."` — suffix `ing` is NOT in BUILTIN_EVENT_NAMES, no colon.
    // Strict trigger must reject. Also covers `bindable`, `bindings`,
    // `catching`, `bindAttr` as members of the same false-positive class
    // (one assertion is enough; the strict trigger's regex handles them
    // uniformly).
    const { source, position } = sourceWithCursor('<view binding="hand|"></view>\n');

    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });

    const labels = items.map((item) => item.label);
    assert(
      !labels.includes("handleSelect"),
      `event handler completion (binding attr): leaked handleSelect into binding="..."; got ${JSON.stringify(labels)}`,
    );
  }

  function assertEventHandlerCompletionInDynamicExpression(graph) {
    // Cursor inside {{...}} — must be suppressed by isExcludedCompletionContext
    // *before* the event-handler branch runs. Lock the regression here.
    const { source, position } = sourceWithCursor('<view bindtap="{{ha|n}}"></view>\n');

    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });

    assert(
      Array.isArray(items) && items.length === 0,
      `event handler completion (dynamic {{...}}): expected suppression to return []; got ${JSON.stringify(items)}`,
    );
  }

  function assertEventHandlerCompletionStrayLessThan(graph) {
    // Stray `<` in text content — the prefix has a `<` but what follows is
    // not a valid tag name. eventHandlerValueContext's tag-name guard must
    // reject; otherwise `text < bindtap="hand|"` would falsely trigger.
    const { source, position } = sourceWithCursor('text < bindtap="hand|"\n');

    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });

    const labels = items.map((item) => item.label);
    assert(
      !labels.includes("handleSelect"),
      `event handler completion (stray <): leaked handleSelect on non-tag context; got ${JSON.stringify(labels)}`,
    );
  }

  function assertEventHandlerCompletionEmptyEventNameColon(graph) {
    // `bind:="..."` — colon form but with empty event name. Meaningless;
    // strict trigger requires non-empty suffix after the colon. Must not
    // trigger handler completion.
    const { source, position } = sourceWithCursor('<view bind:="hand|"></view>\n');

    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });

    const labels = items.map((item) => item.label);
    assert(
      !labels.includes("handleSelect"),
      `event handler completion (empty event-name colon form): leaked handleSelect on \`bind:=\`; got ${JSON.stringify(labels)}`,
    );
  }
  ```

- [ ] **Step 5b: Add the component-lifecycle filter assertion (graph-mutation, not sourceWithCursor)**

  Mutate the graph in-memory: inject a synthetic `kind: "component-lifecycle"` entry (`__synthetic_lifecycle__`) into the home owner's `script.methods`, then verify it does **not** appear in completion labels. The name is deliberately distinctive so the assertion is unambiguous, and is removed in `finally` to keep the mutation from leaking into other assertions.

  ```js
  function assertEventHandlerCompletionSkipsComponentLifecycle(graph) {
    const ownerConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH && c.script);
    assert(ownerConfig, "test setup: expected home owner config with script");

    const synthetic = {
      name: "__synthetic_lifecycle__",
      kind: "component-lifecycle",
      // The minimum range/nameRange shape needed for downstream consumers.
      // Completion only reads .name and .kind so this is fine; if a future
      // path reads range, fill in real coords.
      range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
      nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    };
    ownerConfig.script.methods.push(synthetic);

    try {
      const sourceText = fs.readFileSync(HOME_WXML, "utf8");
      const items = getCompletions({
        graph,
        documentPath: HOME_WXML,
        position: { line: 11, character: 21 },
        sourceText,
        extensionRoot: ROOT,
      });
      const labels = items.map((item) => item.label);
      // handleSelect must still appear (page-method, not filtered);
      // __synthetic_lifecycle__ must not (filtered out by kind).
      assert(
        labels.includes("handleSelect"),
        `event handler completion (lifecycle filter): handleSelect missing — filter is over-eager; got ${JSON.stringify(labels)}`,
      );
      assert(
        !labels.includes("__synthetic_lifecycle__"),
        `event handler completion (lifecycle filter): leaked component-lifecycle method; got ${JSON.stringify(labels)}`,
      );
    } finally {
      const idx = ownerConfig.script.methods.indexOf(synthetic);
      if (idx >= 0) ownerConfig.script.methods.splice(idx, 1);
    }
  }
  ```

- [ ] **Step 6: Register all assertions in the test runner**

  Find the bottom of `scripts/verify-wxml-language-service.mjs` where existing assertions are called (e.g. `assertEventHandlerDefinition(graph)`). Add:

  ```js
  // Fixture-driven positive cases
  assertEventHandlerCompletion(graph);
  assertEventHandlerCompletionEmptyTyped(graph);

  // Synthetic sourceText cases (sourceWithCursor)
  assertEventHandlerCompletionShortFormBindtap(graph);
  assertEventHandlerCompletionInClassAttr(graph);
  assertEventHandlerCompletionBindingAttrIsNotEvent(graph);
  assertEventHandlerCompletionInDynamicExpression(graph);
  assertEventHandlerCompletionStrayLessThan(graph);
  assertEventHandlerCompletionEmptyEventNameColon(graph);

  // Graph-mutation cases
  assertEventHandlerCompletionNoSiblingScript(graph);
  assertEventHandlerCompletionSkipsComponentLifecycle(graph);
  ```

- [ ] **Step 7: Run the test**

  Run: `node scripts/verify-wxml-language-service.mjs`
  Expected: exit 0, no thrown assertion (all ten new event-handler-completion assertions plus the pre-existing Stage A assertions and earlier definition/diagnostic suites pass).

  If any assertion fails:
  - "missing handleSelect" (positive cases): context matcher not triggering. Add `console.error(eventHandlerValueContext(sourceText, position))` near the call site temporarily to inspect.
  - "bad range": the regex captured the wrong `typed` span. Re-verify against the actual line slice.
  - "leaked handleSelect into class value": the strict trigger gate isn't applied — confirm Task 2 used `isEventHandlerCompletionTrigger`, not `matchEventBinding`.
  - "leaked handleSelect into binding=\"...\"": same root cause as above — the strict-vs-loose distinction was lost.
  - "leaked handleSelect on non-tag context": the tag-name guard `/^[A-Za-z][\w-]*(?:\s|$)/u` is missing in `eventHandlerValueContext`. Add it.
  - "leaked handleSelect on `bind:=`": the colon-form regex in `isEventHandlerCompletionTrigger` is missing the `.+$` suffix that requires a non-empty event name. Compare to the documented pattern.
  - "expected suppression to return []" (dynamic): the event-handler branch was inserted *before* the `isExcludedCompletionContext` check; move it after the guard.
  - "leaked component-lifecycle method": the `kind === "component-lifecycle"` filter in `eventHandlerCompletionItems` is missing or misspelled.
  - "handleSelect missing — filter is over-eager": the kind filter is matching too broadly (`includes("lifecycle")` instead of strict `===`).
  - "test setup: expected home owner config with script": graph lookup is using the wrong path form. The graph stores POSIX repo-relative paths; confirm `HOME_WXML_GRAPH_PATH` literal matches `graph.configs[i].owner` shape.
  - Remove all debug logging before committing.

- [ ] **Step 8: Commit (Tasks 1, 2, 3, 4, 5 together)**

  ```bash
  git add shared/event-binding-patterns.mjs \
          scripts/extract-wxml-symbols.mjs \
          server/wxml-language-service.mjs \
          scripts/verify-wxml-language-service.mjs
  git commit -m "feat: completion for wxml event handler values -> js methods

  Phase 2 Stage B of Event Handler Intelligence v1. Typing inside a
  bind:tap=\"...\" value now surfaces method names from the sibling .js
  Page/Component factory's methods map. Detection uses sourceText regex
  (consistent with existing tag/attr/template completion matchers)
  because mid-typing positions don't always have a usable AST node.
  Data flows graph.configs[owner].script.methods -> completion items
  with textEdit range covering the already-typed prefix.

  Trigger gate is intentionally stricter than the symbol-extraction
  matcher: colon forms (bind:foo / catch:foo / capture-bind:foo /
  capture-catch:foo / mut-bind:foo) accept any event name; no-colon
  forms (bindtap / catchchange) accept only WeChat built-in event
  names from a conservative whitelist. This avoids false-positives
  on real attributes like binding=, bindable=, catching= that the
  loose matcher would otherwise classify as event bindings and pop
  the methods menu on.

  Method filter skips kind: \"component-lifecycle\" entries so
  Component({...}) lifecycle hooks (attached, ready, detached, moved)
  don't appear as completion candidates. Page-method kind is not
  filtered — extractor cannot distinguish page lifecycle (onLoad,
  onShow) from custom page methods today.

  Negative cases locked:
   - no sibling script -> []
   - non-event attribute value (class=) -> no leak
   - no-colon non-whitelisted (binding=, bindable=) -> no leak
   - dynamic value with {{...}} -> suppressed by pre-existing
     isExcludedCompletionContext guard
   - component-lifecycle methods -> filtered out of label set
   - stray < in text content -> tag-name guard rejects
   - empty event name in colon form (bind:=) -> strict trigger rejects"
  ```

  Wait — if Task 1's commit was separate (refactor-only), the staged list here drops `shared/event-binding-patterns.mjs` from this commit and the refactor commit stands alone. Re-check `git status` before committing; commit only the files dirtied since Task 1's commit.

---

### Task 6: Add LSP protocol end-to-end test

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`

Mirror the `testCompletionImmediatelyAfterOpen` / `testTagCompletion` pattern. The test exercises the JSON-RPC layer so any breakage in `server/wxml-lsp.mjs:textDocument/completion` routing or URI handling will be caught here, not just in the in-process language-service unit.

- [ ] **Step 1: Add the test function**

  Insert near the other completion tests in `scripts/verify-lsp-diagnostics.mjs` (around line 800, after `testCompletionImmediatelyAfterOpen` or grouped with other completion scenarios):

  ```js
  async function testEventHandlerCompletion() {
    await withClient({ rootPath: ROOT }, async (client) => {
      const uri = client.openDocument(HOME_WXML);
      await client.waitForDiagnostics(
        uri,
        (items) => items.length === 1,
        "home diagnostics before event handler completion",
      );
      // home.wxml line 12 `    bind:select="handleSelect"` — cursor after `hand`.
      const result = await client.completion(HOME_WXML, { line: 11, character: 21 });
      assertCompletionLabelsInclude(result, ["handleSelect"], "event handler completion");
      assertCompletionTextEdit(
        result,
        "handleSelect",
        {
          range: { start: { line: 11, character: 17 }, end: { line: 11, character: 21 } },
          newText: "handleSelect",
        },
        "event handler completion",
      );
    });
  }
  ```

- [ ] **Step 2: Register in scenarios array**

  Find the `scenarios` array (around `scripts/verify-lsp-diagnostics.mjs:1370-1382`). Add:

  ```js
  ["event handler completion", testEventHandlerCompletion],
  ```

  Place it near other completion entries for readability.

- [ ] **Step 3: Register in graph-smoke and full suite lists**

  Find `SCENARIO_SUITES` (around line 1384-1403). The `full` suite is `scenarios.map(...)` so it auto-picks up the new entry. Add to `graph-smoke`:

  ```js
  "graph-smoke": [
    "watch registration when supported",
    "watch registration skipped when unsupported",
    "home component definition",
    "event handler definition",
    "event handler completion",        // <-- new
    "completion immediately after open",
    "unsupported request behavior",
  ],
  ```

- [ ] **Step 4: Run graph-smoke suite directly to verify the new test runs and passes**

  Run: `node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke 2>&1 | tail -20`
  Expected output includes the line `[verify-lsp-diagnostics] event handler completion`, and the suite exits 0.

  If the test fails:
  - "missing handleSelect": confirm the language-service tests from Task 5 still pass (`node scripts/verify-wxml-language-service.mjs`). If those pass but the LSP test fails, the issue is in `server/wxml-lsp.mjs`'s routing or in `client.completion`'s parameter shape.
  - "bad textEdit range": the range got mangled in JSON-RPC transport. Inspect the raw response with `console.log(JSON.stringify(result, null, 2))`.

- [ ] **Step 5: Run the umbrella verifier**

  Run: `bash scripts/verify-tree-sitter.sh 2>&1 | tail -5`
  Expected: ends with `wxml-zed tree-sitter verification passed`, exit 0.

  Umbrella may take 2–3 minutes due to wasm rebuild (this is normal; Phase 1 baseline established).

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/verify-lsp-diagnostics.mjs
  git commit -m "test: lsp protocol coverage for event handler completion

  End-to-end JSON-RPC test mirroring testCompletionImmediatelyAfterOpen.
  Registered in graph-smoke (so umbrella verify-tree-sitter.sh picks it
  up) and full suites."
  ```

---

### Task 7: Record outcome in spike notes

**Files:**
- Modify: `docs/wasm-parser-spike-notes.md`

Follow the pattern set by Stage A — append a `## Phase 2 Stage B Outcome (LSP Event Handler Completion v1)` section after Stage A and before the trailing "Regression anchor for parse-error case" block.

- [ ] **Step 1: Draft the section**

  Capture:
  - Architecture decision: sourceText regex (consistent with existing completion matchers) rather than AST-based detection. Reason: mid-typing positions produce broken AST shapes; the existing matchers chose regex for the same reason.
  - Why "first" in dispatch: convention-following (Stage A pattern), even though line-prefix patterns are mutually exclusive.
  - **Strict vs loose trigger** — completion path uses `isEventHandlerCompletionTrigger`, **not** the loose `matchEventBinding` that the data-model path uses. Loose was confirmed to produce false-positives on `binding=` / `bindable=` / `bindings=` / `catching=` / `bindAttr=` / `bind-foo=` real-world attributes (manual test in plan time logged). Trade-off accepted: false-negatives on no-colon custom-component events (`bindselect` for a custom-component `select` event) — recommend users adopt the colon form for those.
  - **Whitelist contents** — conservative seed: tap/longpress/touchstart family + transition/animation + scroll family + form events + load/error. Notable omissions deliberately deferred: media events (`play`/`pause`/`ended`/`timeupdate`), picker (`columnchange`/`pickstart`/`pickend`), map (`regionchange`). Extend on real false-negative reports rather than speculatively.
  - **Component-lifecycle filter** — `method.kind === "component-lifecycle"` skipped. Page-method kind kept because extractor cannot distinguish `onLoad`/`onShow` from custom page handlers. Future kind-refinement (mark known Page lifecycle names with a sub-kind like `page-lifecycle`) would let us tighten further.
  - Negative-case coverage: no script → []; non-event attribute (`class=`) → no leak; no-colon non-whitelisted (`binding=`) → no leak; dynamic `{{...}}` → suppressed by pre-existing exclusion; component-lifecycle methods → filtered out; stray `<` in text content → tag-name guard rejects; empty-event-name colon form (`bind:=`) → strict trigger rejects.
  - **Tag-name guard** — `eventHandlerValueContext` mirrors `attributeContext`'s `/^[A-Za-z][\w-]*(?:\s|$)/u` check after `lastIndexOf("<")`. Stray `<` in text content otherwise produces false positives. Same guard already existed in `attributeContext`; oversight in the v1 draft caught by review.
  - **Test infra**: synthetic assertions use the existing `sourceWithCursor()` helper at `scripts/verify-wxml-language-service.mjs:48` — never hand-compute column offsets. Off-by-one errors in column comments in the v1 plan draft were caught by review; rewriting to `sourceWithCursor` eliminates the class of bug.
  - EVENT_PATTERNS extracted to `shared/event-binding-patterns.mjs` (mirroring `shared/js-method-extractor.mjs` Phase 1 Stage C1 precedent). Two helpers exported: `matchEventBinding` (loose, used by extractor) and `isEventHandlerCompletionTrigger` (strict, used by language service).
  - Stage C carry-over: diagnostic for "handler bound, no matching method" — note the false-positive trap (behaviors, spread, Object.assign all need suppression). Also: diagnostic should likely use the same strict trigger gate as completion so we don't warn on `binding="foo"` thinking `foo` is a missing handler.

- [ ] **Step 2: Insert before the trailing regression-anchor block**

  Find the line `**Regression anchor for parse-error case:**` and insert the new Stage B section directly above it (preserve the `---` separator structure).

- [ ] **Step 3: Commit**

  ```bash
  git add docs/wasm-parser-spike-notes.md
  git commit -m "docs: record Phase 2 Stage B outcome in spike notes

  Append Stage B section covering: sourceText-regex detection vs.
  AST-based (and why); negative-case matrix; EVENT_PATTERNS shared-
  module refactor following Stage C1 precedent; Stage C carry-over
  with false-positive controls noted."
  ```

---

## Sequencing Notes

- Tasks 1, 2, 3, 4, 5 produce a working feature in two commits: refactor (Task 1) + feature (Tasks 2–5 together at Task 5 Step 8). Splitting Tasks 2–5 into separate commits would leave intermediate states with dead helpers / unwired branches in the history.
- Task 6 (protocol e2e) gets its own commit so a future bisect can distinguish "feature broken" from "protocol-wiring broken".
- Task 7 (notes) goes last per the `feedback_sync_plan_after_inline_fixes.md` discipline — but with a twist: also re-check this plan doc itself before the notes commit. If any inline correction was made during implementation (different fixture position, different regex, etc.), sync the plan doc in the same commit as the notes.

## Self-Review Checklist (run before handing off)

- [ ] All `Files:` paths resolve to real locations in the current tree.
- [ ] Every step that changes code shows the actual code.
- [ ] Every step that runs a command shows the exact command and expected output.
- [ ] No "TBD" / "appropriate" / "similar to" placeholders.
- [ ] Type names consistent across tasks: `eventHandlerValueContext`, `eventHandlerCompletionItems`, `isEventHandlerCompletionTrigger`, `matchEventBinding`, `BUILTIN_EVENT_NAMES`, `HOME_WXML_GRAPH_PATH`.
- [ ] home.wxml fixture-driven assertions (`assertEventHandlerCompletion`, `assertEventHandlerCompletionEmptyTyped`, `assertEventHandlerCompletionSkipsComponentLifecycle`) use line/character coordinates 11:17 / 11:21 / 11:29 against `fixtures/miniprogram/pages/home/home.wxml` line 12. Re-verify if the fixture is edited.
- [ ] Synthetic-source assertions use `sourceWithCursor()` — no hand-computed column offsets. The `|` marker is the source of truth.
- [ ] `eventHandlerValueContext` includes the tag-name guard `/^[A-Za-z][\w-]*(?:\s|$)/u` mirroring `attributeContext`.
- [ ] `isEventHandlerCompletionTrigger`'s colon-form pattern ends with `.+$` (non-empty event name).
