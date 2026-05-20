# WXML Data Reference Definition + Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 3 Stage B. Make `{{...}}` expressions navigate like event handlers do. cmd-click on `{{theme}}` jumps to `home.js`'s `theme: "light"` line; typing `{{th|}}` shows completion candidates from the file's full template scope (data + properties + wxs modules + wx:for bindings). Definition covers data + property references (NOT wxs module names, NOT wx:for-item/index names — both deferred to Phase 3 Stage C; the data lifted by Task 1 already enables them). Completion covers all four scope sources.

**Architecture:** Mirror Phase 2 Stage A (event-handler definition) and Stage B (event-handler completion) one-for-one. New `getDefinition` branch for `fileModel.expressionRefs[]`, AUTHORITATIVE, slotted after event-handler and before component. New `getCompletions` branch detecting cursor-inside-`{{...}}`, slotted first (which requires moving the `{{...}}` clause out of `isExcludedCompletionContext`). Both paths reuse the existing scope-building logic from `expressionRefDiagnostics` — same set, same suppression rules.

**Critical data-layer prerequisite:** `extractDataKeys` currently returns `string[]`. To support Definition (jump to the .js line / column), `script.dataKeys` and `script.propertyKeys` on `graph.configs[].script` must change from `string[]` to `{name: string, nameRange: Range}[]` — mirroring the existing `script.methods[]` shape. The `js-methods-baseline.json` is NOT affected (it only serializes `.methods`). All read sites in this repo:
- `verify-js-script-info.mjs` (28 cases — each gets the new field structure)
- `expressionRefDiagnostics` scope build (`scope.add(key)` → `scope.add(key.name)`)
- `extract-wxml-project-graph.mjs::attachScripts` passes through unchanged (no structural read)

**Tech Stack:** No new dependencies. Reuses tree-sitter-javascript wasm path for key-node positions, the existing `expressionRefs[]` field on `fileModel`, the strict gate / scope helpers already in place from Stage A/B/C.

**Verification:** Unit-level + LSP protocol e2e (mirroring Stage A's `testEventHandlerDefinition` + Stage B's `testEventHandlerCompletion`).

- `scripts/verify-wxml-language-service.mjs` adds 10 assertions: 4 Definition (positive data, positive property, negative in-template-definition, negative missing-key), 6 Completion (positive data, positive property, negative member-access, negative object-literal, positive wxs-module, negative in-template-definition).
- `scripts/verify-lsp-diagnostics.mjs` adds 2 protocol tests: `testDataRefDefinition` (home.wxml `{{theme}}` → home.js position) and `testDataRefCompletion` (`{{th|}}` → includes `theme`). Both registered in `graph-smoke` + `full`.
- No new fixtures. home.wxml's six expressionRefs + user-card.wxml's three give complete positive coverage; mutation + synthetic source give the negatives.

**Out of scope (v1):**
- TypeScript sibling scripts (separate plan)
- Definition for `wx:for-item` / `wx:for-index` names (low value — would jump to the directive attribute itself, which is visually adjacent anyway)
- Definition for wxs module names (lower priority — they're in `fileModel.symbols` already; doable in v2 with a tiny helper, but not blocking)
- Hover (Phase 3 Stage C candidate; the data lifted by this plan makes Hover trivial later)
- Quick-fix actions for missing-expression-ref (separate Phase)
- Cross-component property name validation (when `<user-card user="{{x}}"/>` — `x` is local, but `user` attribute name isn't validated against user-card's `properties:`)
- Computed keys in `data: { [name]: 1 }` (Phase 3 Stage A skipped this; same trade-off here)

---

## File Structure

- Modify: `shared/js-method-extractor.mjs`
  - `extractDataKeys(dataObjectNode)` return shape changes from `string[]` to `{name, nameRange}[]`. Same function serves both `data:` and `properties:` blocks. Reuses `rangeOf` for position computation. For quoted-key form, the nameRange points at the inner `string_fragment` (not the quote chars).
- Modify: `scripts/verify-js-script-info.mjs`
  - All 28 cases' `dataKeys: [...]` / `propertyKeys: [...]` fields restructured. Assertion loop compares against `result.dataKeys.map(k => k.name)` and a separate range presence check.
- Modify: `server/wxml-language-service.mjs`
  - Add `expressionRefDefinitionForPosition(...)` helper near other `*ForPosition` helpers.
  - Add data-ref branch in `getDefinition`, AUTHORITATIVE, right after the existing event-handler branch.
  - Add `interpolationCompletionContext(sourceText, position)` helper near other `*Context` helpers.
  - Add `dataRefCompletionItems(graph, documentGraphPath, fileModel, range)` helper near other `*CompletionItems`.
  - Refactor: drop `{{...}}` clause from `isExcludedCompletionContext` (it becomes the responsibility of the new data-ref branch to decide what to do inside). Comments and inline-wxs raw stay in the always-exclude function. Rename `isExcludedCompletionContext` → `isInsideRawTextOrComment` to reflect the new semantic; update the one call site.
  - Wire the new completion branch FIRST in `getCompletions` (after the basic guards).
  - Update `expressionRefDiagnostics` scope-build to use `.name`.
- Modify: `scripts/verify-wxml-language-service.mjs`
  - 10 new assertions, registered in the runner block near the other Phase 3 Stage A assertions.
- Modify: `scripts/verify-lsp-diagnostics.mjs`
  - 2 new protocol tests, registered in `scenarios` and added to `graph-smoke` suite list.
- Modify: `docs/wasm-parser-spike-notes.md`
  - Append Phase 3 Stage B section after the Stage A section, before the trailing regression-anchor block.
- Modify: This plan doc (if any inline correction is needed during execution — per saved feedback memory).

---

### Task 1: Refactor extractDataKeys to capture key positions

**Files:**
- Modify: `shared/js-method-extractor.mjs`
- Modify: `scripts/verify-js-script-info.mjs`
- Modify: `server/wxml-language-service.mjs` (one-line scope-build update)

The data-shape change is a single-purpose commit. Functional behavior unchanged — same names extracted, same dynamic flags fire. Only the shape grows from `string` to `{name, nameRange}`. All 28 script-info cases get their assertion shape updated in the same commit since the verifier IS the single consumer that locks the shape contract.

- [ ] **Step 1: Modify `extractDataKeys` to return key objects**

  Find `extractDataKeys` in `shared/js-method-extractor.mjs` (currently returns `string[]`). Replace the function body:

  ```js
  function extractDataKeys(dataObjectNode) {
    const out = [];
    for (let i = 0; i < dataObjectNode.namedChildCount; i++) {
      const child = dataObjectNode.namedChild(i);
      if (child.type === "pair") {
        const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
        if (!keyNode) continue;
        if (keyNode.type === "property_identifier") {
          out.push({ name: keyNode.text, nameRange: rangeOf(keyNode) });
        } else if (keyNode.type === "string") {
          const fragment = firstChildOfType(keyNode, "string_fragment");
          const text = fragment ? fragment.text : "";
          if (IDENTIFIER_SHAPE.test(text)) {
            // For quoted keys, point the nameRange at the inner string_fragment
            // so cmd-click lands on the actual identifier text, not the quotes.
            out.push({ name: text, nameRange: rangeOf(fragment) });
          }
        }
      } else if (child.type === "shorthand_property_identifier") {
        out.push({ name: child.text, nameRange: rangeOf(child) });
      }
    }
    return out;
  }
  ```

- [ ] **Step 2: Syntax check the JS extractor**

  Run: `node --check shared/js-method-extractor.mjs`
  Expected: exit 0.

- [ ] **Step 3: Update `verify-js-script-info.mjs` assertion loop and case schemas**

  Two changes:
  - The 28 case objects keep their `dataKeys: [...]` / `propertyKeys: [...]` fields but the entries are still bare strings in the case schema (we only assert on names — actual `nameRange` correctness is verified separately by the language-service Definition tests against real fixtures, where the positions matter end-to-end). This avoids hard-coding 28 sets of synthetic-source positions in the verifier.
  - The assertion loop compares `result.dataKeys.map(k => k.name)` against the case's `dataKeys[]`. Plus a structural assertion that every returned entry has a `nameRange` with numeric row/column.

  Update the assertion loop:

  ```js
  for (const { label, source, hasDynamicMethods, methodNames, dataKeys, propertyKeys, hasDynamicData } of CASES) {
    const result = extractMethods(parser, source);
    assert(
      typeof result === "object" && result !== null
        && Array.isArray(result.methods)
        && Array.isArray(result.dataKeys)
        && Array.isArray(result.propertyKeys),
      `${label}: bad return shape ${JSON.stringify(result)}`,
    );
    assert(
      result.hasDynamicMethods === hasDynamicMethods,
      `${label}: hasDynamicMethods expected ${hasDynamicMethods}, got ${result.hasDynamicMethods}`,
    );
    assert(
      result.hasDynamicData === hasDynamicData,
      `${label}: hasDynamicData expected ${hasDynamicData}, got ${result.hasDynamicData}`,
    );

    const actualNames = result.methods.map((m) => m.name).sort();
    const expectedNames = [...methodNames].sort();
    assert(
      actualNames.length === expectedNames.length && actualNames.every((n, i) => n === expectedNames[i]),
      `${label}: methods expected [${expectedNames.join(", ")}], got [${actualNames.join(", ")}]`,
    );

    const actualDataKeys = [...result.dataKeys.map((k) => k.name)].sort();
    const expectedDataKeys = [...dataKeys].sort();
    assert(
      actualDataKeys.length === expectedDataKeys.length && actualDataKeys.every((n, i) => n === expectedDataKeys[i]),
      `${label}: dataKeys expected [${expectedDataKeys.join(", ")}], got [${actualDataKeys.join(", ")}]`,
    );

    const actualPropertyKeys = [...result.propertyKeys.map((k) => k.name)].sort();
    const expectedPropertyKeys = [...propertyKeys].sort();
    assert(
      actualPropertyKeys.length === expectedPropertyKeys.length && actualPropertyKeys.every((n, i) => n === expectedPropertyKeys[i]),
      `${label}: propertyKeys expected [${expectedPropertyKeys.join(", ")}], got [${actualPropertyKeys.join(", ")}]`,
    );

    // Structural assertion: each returned entry has a nameRange with numeric row/column.
    for (const entry of [...result.dataKeys, ...result.propertyKeys]) {
      assert(
        entry.nameRange
          && typeof entry.nameRange.start?.row === "number"
          && typeof entry.nameRange.start?.column === "number"
          && typeof entry.nameRange.end?.row === "number"
          && typeof entry.nameRange.end?.column === "number",
        `${label}: entry "${entry.name}" missing valid nameRange ${JSON.stringify(entry.nameRange)}`,
      );
    }
  }
  ```

- [ ] **Step 4: Update `expressionRefDiagnostics` scope-build to use `.name`**

  In `server/wxml-language-service.mjs`, find the scope-build loops in `expressionRefDiagnostics`:

  ```js
  for (const key of ownerConfig.script.dataKeys ?? []) scope.add(key);
  // Component properties contribute to template scope identically to data
  // (see WeChat docs on `properties:` — values are reactive template state).
  for (const key of ownerConfig.script.propertyKeys ?? []) scope.add(key);
  ```

  Change to read `.name`:

  ```js
  for (const key of ownerConfig.script.dataKeys ?? []) scope.add(key.name);
  // Component properties contribute to template scope identically to data
  // (see WeChat docs on `properties:` — values are reactive template state).
  for (const key of ownerConfig.script.propertyKeys ?? []) scope.add(key.name);
  ```

- [ ] **Step 4b: Update Phase 3 Stage A mutation tests in verify-wxml-language-service**

  `scripts/verify-wxml-language-service.mjs` has TWO Phase 3 Stage A mutation tests that filter `dataKeys` by string equality:

  - `assertExpressionRefDiagnosticMissingInterpolation`: `original.filter((k) => k !== "theme")` (around line 336)
  - `assertExpressionRefDiagnosticMissingDirective`: `original.filter((k) => k !== "users")` (around line 358)

  After Task 1 Step 1 runs, `original` is `{name, nameRange}[]`, and string equality against a key object is permanently false — the filter would remove nothing, the diagnostic would NOT fire, and the assertion would `expect(diagnostic).toExist()` style fail. Critically: if the assertions had been "expect zero diagnostics" the false-green window would be silent.

  Update both filter predicates to compare by `.name`:

  ```js
  homeConfig.script.dataKeys = original.filter((k) => k.name !== "theme");
  ```

  and:

  ```js
  homeConfig.script.dataKeys = original.filter((k) => k.name !== "users");
  ```

  Same edit, two locations. Both inside their existing functions; preserve surrounding `try { ... } finally { ... }` shape.

- [ ] **Step 4c: Sanity-grep for any other Phase 3 Stage A dataKeys mutations**

  Run: `grep -nE "dataKeys|propertyKeys" scripts/verify-wxml-language-service.mjs`
  Expected: only the two filter sites updated in Step 4b, plus passthrough mutation patterns (assignment, length checks). If there are any other string-comparison uses of these arrays elsewhere — e.g. `dataKeys.includes("X")` — update those too with `.find((k) => k.name === "X")` or similar.

- [ ] **Step 5: Syntax check both files**

  Run: `node --check shared/js-method-extractor.mjs && node --check server/wxml-language-service.mjs && node --check scripts/verify-js-script-info.mjs`
  Expected: exit 0.

- [ ] **Step 6: Run all affected verifiers**

  Run: `node scripts/verify-js-script-info.mjs && node scripts/verify-wxml-language-service.mjs && node scripts/verify-js-method-baselines.mjs`
  Expected:
  - `[verify-js-script-info] 28 cases ... PASS`
  - `verify-wxml-language-service.mjs` exits 0 (existing Phase 3 Stage A tests should still pass — the diagnostic suppression checks now read `.name`, but the logical scope is unchanged)
  - `[verify-js-method-baselines] 3 fixtures ... PASS` (POC extractor only emits `.methods`; unaffected)

  If verify-wxml-language-service fails on `assertExpressionRefDiagnosticClean`: the scope.add change wasn't applied. Re-check `expressionRefDiagnostics`.

  If verify-js-script-info fails: the assertion loop change has a bug — read the failing case's structural error and inspect the result shape.

- [ ] **Step 7: Commit Task 1 (data-shape refactor)**

  ```bash
  git add shared/js-method-extractor.mjs \
          scripts/verify-js-script-info.mjs \
          server/wxml-language-service.mjs
  git commit -m "refactor: dataKeys/propertyKeys carry name + nameRange

  Phase 3 Stage B prep. extractDataKeys now returns
  {name, nameRange}[] instead of string[] — mirroring the existing
  methods[] shape on the same object. Required for the upcoming
  Definition feature, which needs key positions to jump to the
  .js source line / column.

  For property-identifier keys (data: { foo: 1 }), nameRange covers
  the property_identifier node. For quoted-identifier keys
  (data: { \"foo\": 1 }), nameRange covers the inner string_fragment
  (not the quote chars) — cmd-click lands on the text.

  Update sites:
   - verify-js-script-info: 28 cases keep declaring expected names
     as bare string arrays; the assertion loop reads result.X.map(k => k.name)
     and adds a structural check that every returned entry has a
     valid numeric nameRange.
   - expressionRefDiagnostics scope-build now reads .name from each
     key object. Diagnostic behavior unchanged.

  js-methods-baseline.json is NOT touched — the POC extractor only
  serializes .methods, never dataKeys/propertyKeys."
  ```

---

### Task 2: Move expression helpers from `scripts/` to `shared/`

**Files:**
- Create: `shared/wxml-expression-helpers.mjs`
- Modify: `scripts/extract-wxml-symbols.mjs` (lose local exports, import from shared)
- Modify: `scripts/verify-wxml-expression-helpers.mjs` (re-point import)

`looksLikeObjectLiteralExpression`, `stripStringLiterals`, and `topLevelIdentifiers` were originally exported from `scripts/extract-wxml-symbols.mjs` for the focused verifier. Task 5 needs them in the runtime LSP server (`server/wxml-language-service.mjs`) — but server runtime should not import from `scripts/` (layering violation, and `scripts/` may carry CLI side-effects even with the existing `isDirectRun` guard). Move to `shared/`, matching the precedent set by `shared/event-binding-patterns.mjs`. Pure relocation — no behavior change.

- [ ] **Step 1: Create `shared/wxml-expression-helpers.mjs`**

  Cut the three exported helpers from `scripts/extract-wxml-symbols.mjs` (around lines 46-105 — the ones added in Phase 3 Stage A Task 1) and paste into a new module file. Preserve the `JS_RESERVED_OR_OPERATOR` const used internally by `topLevelIdentifiers`.

  Concrete file contents for `shared/wxml-expression-helpers.mjs`:

  ```js
  // Heuristic: detect expression text shaped like an object literal
  // (`{key: ...}` or `key: ...`), as in `<template data="{{message: 'x'}}"/>`.
  // Identifiers in property-key position must not be validated against scope.
  export function looksLikeObjectLiteralExpression(text) {
    const trimmed = text.trim();
    const m = trimmed.match(/^\{?\s*[A-Za-z_$][A-Za-z0-9_$]*\s*:/u);
    if (!m) return false;
    const colonAt = trimmed.indexOf(":");
    return !trimmed.slice(0, colonAt).includes("?");
  }

  // Replaces single/double-quoted string contents with spaces of equal length
  // so identifier offsets after the string remain stable. Returns null when
  // a template literal (backtick) is encountered — those embed arbitrary
  // expressions and are conservatively bailed out at v1.
  export function stripStringLiterals(text) {
    let out = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        out += ch;
        i += 1;
        while (i < text.length && text[i] !== quote) {
          if (text[i] === "\\" && i + 1 < text.length) {
            out += "  ";
            i += 2;
            continue;
          }
          out += " ";
          i += 1;
        }
        if (i < text.length) {
          out += text[i];
          i += 1;
        }
      } else if (ch === "`") {
        return null;
      } else {
        out += ch;
        i += 1;
      }
    }
    return out;
  }

  const JS_RESERVED_OR_OPERATOR = new Set([
    "true", "false", "null", "undefined",
    "typeof", "instanceof", "in", "of",
    "void", "new", "delete", "this",
  ]);

  // Returns [{name, offset}] for each top-level identifier in `text`.
  export function topLevelIdentifiers(text) {
    if (looksLikeObjectLiteralExpression(text)) return [];
    const stripped = stripStringLiterals(text);
    if (stripped === null) return [];
    const out = [];
    const regex = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/gu;
    let match;
    while ((match = regex.exec(stripped)) !== null) {
      const name = match[1];
      const offset = match.index;
      const prev = offset > 0 ? stripped[offset - 1] : "";
      if (prev === ".") continue;
      if (JS_RESERVED_OR_OPERATOR.has(name)) continue;
      out.push({ name, offset });
    }
    return out;
  }
  ```

- [ ] **Step 2: Replace local copies in `extract-wxml-symbols.mjs` with an import**

  In `scripts/extract-wxml-symbols.mjs`:

  - Delete the three `export function ...` definitions for `looksLikeObjectLiteralExpression`, `stripStringLiterals`, `topLevelIdentifiers`, AND the `JS_RESERVED_OR_OPERATOR` const.
  - Add at the top of the imports (next to the existing imports):
    ```js
    import {
      looksLikeObjectLiteralExpression,
      stripStringLiterals,
      topLevelIdentifiers,
    } from "../shared/wxml-expression-helpers.mjs";
    ```

  These three names remain in scope of the file (now via import), so all interior call sites continue to work without changes.

- [ ] **Step 3: Re-point `verify-wxml-expression-helpers.mjs` to the shared module**

  In `scripts/verify-wxml-expression-helpers.mjs`, change the import:

  ```js
  import {
    topLevelIdentifiers,
    looksLikeObjectLiteralExpression,
    stripStringLiterals,
  } from "../shared/wxml-expression-helpers.mjs";
  ```

  (Removing the existing import from `./extract-wxml-symbols.mjs`.)

- [ ] **Step 4: Confirm the move is behaviorally identical**

  Run: `node scripts/verify-wxml-expression-helpers.mjs && node scripts/verify-wasm-symbol-baselines.mjs && node scripts/verify-wxml-language-service.mjs`
  Expected: all three exit 0. The 19 expression-helper cases still pass, all 7 baseline cases still pass (extractor output unchanged — same functions, different physical location), and the language-service tests are unaffected.

  If `verify-wxml-expression-helpers` fails with "cannot resolve module": the new file path is wrong, or the import path doesn't go through `../shared/`.

  If `verify-wasm-symbol-baselines` reports diffs: the helper bodies were modified during the cut/paste. Re-check the function bodies match the originals.

- [ ] **Step 5: Sanity-grep for leftover references**

  Run: `grep -rnE 'looksLikeObjectLiteralExpression|stripStringLiterals|topLevelIdentifiers' scripts/extract-wxml-symbols.mjs`
  Expected: only the import statement and the interior call sites — no `export function` lines.

  Run: `grep -rnE "from.*scripts.*extract-wxml-symbols" .`
  Expected: nothing. After this task, no code outside scripts/extract-wxml-symbols.mjs's own internal use should import from it.

- [ ] **Step 6: Commit the move (Task 2 standalone — separate from Task 1's data refactor)**

  Why separate from Task 1: clean bisect surface. Task 1's data-shape refactor and this helper relocation are two distinct refactors. Bundling them in one commit would make "this commit broke X" attribution harder.

  ```bash
  git add shared/wxml-expression-helpers.mjs \
          scripts/extract-wxml-symbols.mjs \
          scripts/verify-wxml-expression-helpers.mjs
  git commit -m "refactor: move wxml expression helpers from scripts/ to shared/

  Phase 3 Stage B prep: looksLikeObjectLiteralExpression,
  stripStringLiterals, and topLevelIdentifiers move from
  scripts/extract-wxml-symbols.mjs to a new shared module so the
  runtime LSP server can import them in the upcoming completion
  feature. Server runtime should not import from scripts/ (layering
  violation and potential CLI side-effects).

  Mirrors the precedent set by shared/event-binding-patterns.mjs
  during Phase 2 Stage B: pull the focused helpers out as the
  consumer set grows beyond the original single owner.

  Pure relocation: same function bodies, all 19 helper-verifier
  cases pass, all 7 wasm-symbol baselines remain byte-identical."
  ```

---

### Task 3: Add expressionRef Definition branch

**Files:**
- Modify: `server/wxml-language-service.mjs`

Definition for `{{theme}}` cmd-click. AUTHORITATIVE — once the cursor is inside an expressionRef's range, the function returns a `Location` or `null`, never falls through to component / dependency branches. Mirrors Stage A's event-handler dispatch.

- [ ] **Step 1: Add the data-ref dispatch block to `getDefinition`**

  Find the event-handler branch in `getDefinition` (around line 672-681). Insert the new branch IMMEDIATELY AFTER it:

  ```js
  // Expression reference: cursor inside a `{{theme}}` interpolation ref name.
  // AUTHORITATIVE — narrow nameRange dominates the broader component-element
  // range that follows. If the ref resolves through dataKeys/propertyKeys,
  // jump to the .js source position; otherwise return null (the
  // missing-expression-ref diagnostic will already warn separately).
  const expressionRefMatch = (fileModel.expressionRefs ?? [])
    .find((entry) => containsPosition(entry.range, position));
  if (expressionRefMatch) {
    if (expressionRefMatch.inTemplateDefinition) return null;
    const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
    if (!ownerConfig) return null;
    const dataKey = (ownerConfig.script.dataKeys ?? []).find((k) => k.name === expressionRefMatch.name);
    if (dataKey) {
      return locationForGraphPathWithRange(ownerConfig.script.path, dataKey.nameRange, extensionRoot);
    }
    const propKey = (ownerConfig.script.propertyKeys ?? []).find((k) => k.name === expressionRefMatch.name);
    if (propKey) {
      return locationForGraphPathWithRange(ownerConfig.script.path, propKey.nameRange, extensionRoot);
    }
    return null;
  }
  ```

  Order rationale: event-handler is FIRST (handler nameRange is the narrowest); data-ref SECOND (expressionRef range is also narrow — just the identifier text); component is broader (whole element range); dependencies (template/include/import/wxs) come last. Narrow-first prevents the broader branches from "winning" when the cursor is actually on a more-specific match.

- [ ] **Step 2: Syntax check**

  Run: `node --check server/wxml-language-service.mjs`
  Expected: exit 0.

- [ ] **Step 3: Sanity-run existing tests**

  Run: `node scripts/verify-wxml-language-service.mjs`
  Expected: exit 0. The new branch is additive — existing assertions should still pass.

  If existing assertions fail with surprising `null` returns: the new branch's `containsPosition(entry.range, position)` is matching when it shouldn't. Inspect by logging `expressionRefMatch` and `position` at the call site.

- [ ] **Step 4: No commit yet** — Task 4 adds the new assertions. Commit together so the feature + tests land atomically.

---

### Task 4: Definition assertions + LSP protocol test

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`
- Modify: `scripts/verify-lsp-diagnostics.mjs`

Four unit-level assertions cover the positive + negative paths. One protocol test locks the JSON-RPC routing.

- [ ] **Step 1: Add the positive data-key assertion**

  home.wxml line 4 (`<view class="home {{theme}}">`) has `theme` at expressionRefs[].range = {start:{row:4,col:20}, end:{row:4,col:25}} (verified during the Phase 3 Stage A baseline regen). Cursor at line 4, character 22 lands inside.

  Insert this near the existing Phase 3 Stage A assertions (around the location of `assertExpressionRefDiagnosticClean`):

  ```js
  function assertDataRefDefinitionToData(graph) {
    // home.wxml {{theme}} at line 4 col 20-25; cursor mid-name at col 22.
    const location = getDefinition({
      graph,
      documentPath: HOME_WXML,
      position: { line: 4, character: 22 },
      extensionRoot: ROOT,
    });
    assert(location, "data-ref definition (theme): expected Location, got null");
    assert(
      location.uri.endsWith("/fixtures/miniprogram/pages/home/home.js"),
      `data-ref definition (theme): uri ${location.uri}`,
    );
    assert(
      typeof location.range.start.line === "number" && typeof location.range.start.character === "number",
      `data-ref definition (theme): bad range ${JSON.stringify(location.range)}`,
    );
    // The exact line depends on home.js content; assert sensible bounds and
    // non-empty range.
    assert(
      location.range.start.line >= 0 && location.range.start.line < 20,
      `data-ref definition (theme): line out of range ${location.range.start.line}`,
    );
    assert(
      location.range.end.character > location.range.start.character || location.range.end.line > location.range.start.line,
      `data-ref definition (theme): empty range ${JSON.stringify(location.range)}`,
    );
  }
  ```

- [ ] **Step 2: Add the positive property-key assertion**

  user-card.wxml line 1 (`  <text class="name">{{user.name}}</text>`) has `user` at expressionRefs[].range = {start:{row:1,col:23}, end:{row:1,col:27}}. Cursor at line 1, character 25 lands inside.

  ```js
  function assertDataRefDefinitionToProperty(graph) {
    // user-card.wxml {{user.name}} at line 1; user is the top-level ref.
    const location = getDefinition({
      graph,
      documentPath: USER_CARD_WXML,
      position: { line: 1, character: 25 },
      extensionRoot: ROOT,
    });
    assert(location, "data-ref definition (user): expected Location, got null");
    assert(
      location.uri.endsWith("/fixtures/miniprogram/components/user-card/user-card.js"),
      `data-ref definition (user): uri ${location.uri}`,
    );
    assert(
      typeof location.range.start.line === "number"
        && location.range.start.line >= 0
        && location.range.start.line < 20,
      `data-ref definition (user): line out of range ${JSON.stringify(location.range)}`,
    );
    assert(
      location.range.end.character > location.range.start.character || location.range.end.line > location.range.start.line,
      `data-ref definition (user): empty range ${JSON.stringify(location.range)}`,
    );
  }
  ```

- [ ] **Step 3: Add the in-template-definition null assertion**

  Inject a synthetic expressionRef marked `inTemplateDefinition: true` whose name IS in dataKeys (so without the gate it would resolve), and verify Definition returns null.

  ```js
  function assertDataRefDefinitionInTemplateReturnsNull(graph) {
    // Synthesize an expressionRef inside a template definition. The name
    // "theme" IS in home.js dataKeys — without inTemplateDefinition gating,
    // Definition would resolve. The gate must short-circuit and return null.
    const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
    assert(homeFile && Array.isArray(homeFile.expressionRefs), "test setup: home file must have expressionRefs");
    const originalRefs = homeFile.expressionRefs;
    const synthetic = {
      name: "theme",
      source: "interpolation",
      inTemplateDefinition: true,
      range: { start: { row: 100, column: 0 }, end: { row: 100, column: 5 } },
      expressionRange: { start: { row: 100, column: 0 }, end: { row: 100, column: 5 } },
    };
    homeFile.expressionRefs = [...originalRefs, synthetic];
    try {
      const location = getDefinition({
        graph,
        documentPath: HOME_WXML,
        position: { line: 100, character: 2 },
        extensionRoot: ROOT,
      });
      assert(
        location === null,
        `data-ref definition (in template def): expected null, got ${JSON.stringify(location)}`,
      );
    } finally {
      homeFile.expressionRefs = originalRefs;
    }
  }
  ```

- [ ] **Step 4: Add the missing-key null assertion**

  Mutate home's dataKeys to drop `theme`, then click `{{theme}}` — expect null (not a fall-through to component).

  ```js
  function assertDataRefDefinitionMissingKeyReturnsNull(graph) {
    const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
    assert(homeConfig && homeConfig.script, "test setup: home config must have script");
    const original = homeConfig.script.dataKeys;
    homeConfig.script.dataKeys = original.filter((k) => k.name !== "theme");
    try {
      const location = getDefinition({
        graph,
        documentPath: HOME_WXML,
        position: { line: 4, character: 22 },
        extensionRoot: ROOT,
      });
      assert(
        location === null,
        `data-ref definition (missing key): expected null (authoritative miss), got ${JSON.stringify(location)}`,
      );
    } finally {
      homeConfig.script.dataKeys = original;
    }
  }
  ```

- [ ] **Step 5: Register the four in the test runner**

  Find the existing Phase 3 Stage A registration block (`// Phase 3 Stage A — Expression reference diagnostic`). Add immediately after the last expression-ref diagnostic call:

  ```js
  // Phase 3 Stage B — Data ref definition
  assertDataRefDefinitionToData(graph);
  assertDataRefDefinitionToProperty(graph);
  assertDataRefDefinitionInTemplateReturnsNull(graph);
  assertDataRefDefinitionMissingKeyReturnsNull(graph);
  ```

- [ ] **Step 6: Add the LSP protocol test**

  In `scripts/verify-lsp-diagnostics.mjs`, find `testEventHandlerDefinition` (Stage A's protocol test). Insert this immediately after:

  ```js
  async function testDataRefDefinition() {
    await withClient({ rootPath: ROOT }, async (client) => {
      const uri = client.openDocument(HOME_WXML);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before data-ref definition");
      // home.wxml line 4 `<view class="home {{theme}}">` — cursor inside `theme`.
      const result = await client.definition(HOME_WXML, { line: 4, character: 22 });
      assert(result, "data-ref definition: expected Location response");
      assert(
        result.uri.endsWith("/fixtures/miniprogram/pages/home/home.js"),
        `data-ref definition: uri ${result.uri}`,
      );
      assert(
        typeof result.range.start.line === "number" && typeof result.range.start.character === "number",
        `data-ref definition: bad range ${JSON.stringify(result.range)}`,
      );
    });
  }
  ```

  Register in the `scenarios` array:

  ```js
  ["data ref definition", testDataRefDefinition],
  ```

  And add to the `graph-smoke` suite list (alongside `event handler definition`):

  ```js
  "data ref definition",
  ```

- [ ] **Step 7: Run all tests**

  Run: `node scripts/verify-wxml-language-service.mjs && node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke 2>&1 | tail -10`
  Expected: both exit 0; graph-smoke output includes `[verify-lsp-diagnostics] data ref definition`.

  Common failures:
  - `data-ref definition (theme): expected Location, got null`: the new branch isn't matching — either `expressionRefs` is empty (unlikely, baseline-locked) or the position math is off. Log `expressionRefMatch` to inspect.
  - `data-ref definition (in template def): expected null, got Location`: the `inTemplateDefinition` gate isn't fired in the new branch. Re-check Task 3 Step 1.
  - LSP protocol test times out: client.definition method missing. Check the existing testEventHandlerDefinition for the client method usage pattern.

- [ ] **Step 8: Commit Tasks 3 + 4 (definition + tests together)**

  ```bash
  git add server/wxml-language-service.mjs \
          scripts/verify-wxml-language-service.mjs \
          scripts/verify-lsp-diagnostics.mjs
  git commit -m "feat: lsp definition for wxml data references

  Phase 3 Stage B (1/2). cmd-click on a {{...}} expression
  reference now navigates to the corresponding data/properties key
  in the sibling .js page/component. Mirrors the Stage A event-
  handler definition shape: AUTHORITATIVE branch (no fall-through
  on miss), positioned after event-handler and before component
  in dispatch order (narrow-first).

  Resolution order:
   - skip refs with inTemplateDefinition=true (their scope is the
     caller's data, not this file's owner script)
   - script.dataKeys first (page/component data) — match by name,
     return Location at nameRange
   - script.propertyKeys second (component properties)
   - on miss, return null (the missing-expression-ref diagnostic
     warns separately; no surprise fall-through to component
     definition)

  Four assertions: positive data (home.wxml {{theme}} -> home.js
  theme key), positive property (user-card.wxml {{user.name}} ->
  user-card.js properties.user), negative in-template-definition,
  negative missing-key. One LSP protocol test mirrors
  testEventHandlerDefinition, registered in graph-smoke + full."
  ```

---

### Task 5: Add interpolation completion context + items

**Files:**
- Modify: `server/wxml-language-service.mjs`

Completion for `{{th|}}`. The existing `isExcludedCompletionContext` currently bails on `{{...}}` early — that early-bail must be lifted so the new branch can fire there. The new branch handles three cases inside `{{...}}`:
- Valid identifier position → return candidates
- Member access (preceded by `.`) → return `[]` (no candidates from local scope)
- Object literal shape → return `[]`

The branch also returns `[]` (not undefined) when inside `{{...}}` but at a non-identifier position, so the dispatch doesn't fall through to template/tag/attr branches (which would be wrong inside an interpolation).

- [ ] **Step 1: Import the expression helpers from `shared/`**

  At the top of `server/wxml-language-service.mjs`, add:

  ```js
  import {
    looksLikeObjectLiteralExpression,
    stripStringLiterals,
  } from "../shared/wxml-expression-helpers.mjs";
  ```

  (`topLevelIdentifiers` isn't used by the server — only the two helpers above are referenced from `interpolationCompletionContext`.) Task 2 already promoted these to `shared/` so this import is safe and doesn't pull in scripts/ code.

- [ ] **Step 2: Rename `isExcludedCompletionContext` and remove `{{...}}` from it**

  Find the function (around line 248):

  ```js
  function isExcludedCompletionContext(sourceText, offset) {
    return (
      isInsideDelimitedRange(sourceText, offset, "<!--", "-->") ||
      isInsideDelimitedRange(sourceText, offset, "{{", "}}") ||
      isInsideInlineWxsRawText(sourceText, offset)
    );
  }
  ```

  Replace with:

  ```js
  function isInsideRawTextOrComment(sourceText, offset) {
    // Comments and inline <wxs> raw text never accept completions.
    // The {{...}} interpolation case used to be excluded here too, but
    // moved out — data-ref completion now handles inside-{{...}} positions.
    return (
      isInsideDelimitedRange(sourceText, offset, "<!--", "-->") ||
      isInsideInlineWxsRawText(sourceText, offset)
    );
  }
  ```

  Update the one call site in `getCompletions` (around line 507):

  ```js
  if (offset === undefined || isInsideRawTextOrComment(sourceText, offset)) {
    return [];
  }
  ```

- [ ] **Step 3: Add `interpolationCompletionContext(sourceText, position, fileModel)`**

  The helper takes `fileModel` (in addition to sourceText/position) so it can consult `fileModel.symbols[]` to detect "cursor inside a `<template name="X">` body" — same semantic as the Phase 3 Stage A diagnostic suppression. Without this gate, typing `{{u|}}` inside a template definition would suggest the owner script's data even though template-body refs resolve against the CALLER's data scope (passed via `<template is="X" data="{{...}}"/>`), not the local script.

  Place near the other `*Context` helpers (after `eventHandlerValueContext`):

  ```js
  function interpolationCompletionContext(sourceText, position, fileModel) {
    const offset = offsetAt(sourceText, position);
    if (offset === undefined) return undefined;
    if (!isInsideDelimitedRange(sourceText, offset, "{{", "}}")) return undefined;

    // Find the most recent `{{` start before cursor — the interpolation we're in.
    const before = sourceText.slice(0, offset);
    const startIdx = before.lastIndexOf("{{");
    if (startIdx === -1) return undefined;

    // Cursor inside `<template name="X">...</template>` body? Symmetric to
    // expressionRefDiagnostics' inTemplateDefinition gate — template-body
    // refs resolve against caller scope, not this file's owner script.
    if (isPositionInsideTemplateDefinition(fileModel, position)) {
      return { typed: "", suppress: true };
    }

    // Inspect the full enclosing expression (start to matching }}) for
    // object-literal shape, which suppresses identifier completion across
    // the whole expression.
    const endIdx = sourceText.indexOf("}}", offset);
    const fullExpr = endIdx !== -1 ? sourceText.slice(startIdx + 2, endIdx) : sourceText.slice(startIdx + 2);
    if (looksLikeObjectLiteralExpression(fullExpr)) return { typed: "", suppress: true };

    // Prefix from `{{` to cursor; partial identifier at the end.
    const exprPrefix = sourceText.slice(startIdx + 2, offset);
    const stripped = stripStringLiterals(exprPrefix);
    if (stripped === null) return { typed: "", suppress: true };

    // Cursor inside an unclosed string literal? `{{ '<view |' }}`-style
    // tokens shouldn't surface identifier candidates. Walk the prefix
    // tracking quote state with escape handling; if we end still inside
    // a quote, suppress. (Caught at execution time when an existing Phase 1
    // test for `assertExcludedContextsReturnEmpty` "interpolation tag" case
    // false-positived without this gate.)
    let inQuote = null;
    for (let i = 0; i < exprPrefix.length; i += 1) {
      const ch = exprPrefix[i];
      if (inQuote) {
        if (ch === "\\" && i + 1 < exprPrefix.length) { i += 1; continue; }
        if (ch === inQuote) inQuote = null;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      }
    }
    if (inQuote !== null) return { typed: "", suppress: true };

    const m = stripped.match(/([A-Za-z_$][A-Za-z0-9_$]*)$/u);
    const typed = m ? m[1] : "";

    // Member access: if the char just before typed is `.`, suppress.
    const prevIdx = stripped.length - typed.length - 1;
    if (prevIdx >= 0 && stripped[prevIdx] === ".") {
      return { typed: "", suppress: true };
    }

    // Cross-line typed isn't supported — the textEdit range assumes typed
    // lives on the cursor's line.
    if (typed.includes("\n")) return { typed: "", suppress: true };

    const startCharacter = position.character - typed.length;
    return {
      typed,
      suppress: false,
      range: {
        start: { line: position.line, character: startCharacter },
        end: { line: position.line, character: position.character },
      },
    };
  }

  function isPositionInsideTemplateDefinition(fileModel, position) {
    // fileModel.symbols[kind: "template"] has `range` covering the full
    // <template name="X">...</template> block (per the WXML extractor's
    // `template_definition` case). Cursor in any such range means we're
    // in template body — completion candidates from owner data are wrong.
    for (const sym of fileModel.symbols ?? []) {
      if (sym.kind === "template" && containsPosition(sym.range, position)) {
        return true;
      }
    }
    return false;
  }
  ```

  Return shape:
  - `undefined`: cursor not inside `{{...}}` — caller falls through to other completion branches
  - `{suppress: true}`: cursor inside `{{...}}` but not a valid identifier-completion position (template body / member tail / object literal / template literal / unclosed string literal / cross-line) — caller returns `[]`
  - `{suppress: false, typed, range}`: valid completion position — caller produces candidates

- [ ] **Step 4: Add `dataRefCompletionItems(graph, documentGraphPath, fileModel, range)`**

  Place near the other `*CompletionItems` helpers (after `eventHandlerCompletionItems`):

  ```js
  function dataRefCompletionItems(graph, documentGraphPath, fileModel, range) {
    const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
    const seen = new Set();
    const items = [];

    const pushName = (name, detail) => {
      if (typeof name !== "string" || name.length === 0) return;
      if (seen.has(name)) return;
      seen.add(name);
      items.push(completionItem(name, COMPLETION_ITEM_KIND_PROPERTY, detail, range));
    };

    if (ownerConfig && !ownerConfig.script.hasDynamicData) {
      for (const key of ownerConfig.script.dataKeys ?? []) pushName(key.name, "data");
      for (const key of ownerConfig.script.propertyKeys ?? []) pushName(key.name, "property");
    }

    // wxs module symbols
    for (const sym of fileModel.symbols ?? []) {
      if (sym.kind === "wxs") pushName(sym.name, "wxs module");
    }

    // wx:for-item / wx:for-index — file-level coarse scope
    const bindings = fileModel.wxForBindings;
    if (bindings) {
      if (bindings.hasAnyWxFor) {
        pushName("item", "wx:for item");
        pushName("index", "wx:for index");
      }
      for (const name of bindings.items ?? []) pushName(name, "wx:for item");
      for (const name of bindings.indexes ?? []) pushName(name, "wx:for index");
    }

    items.sort((a, b) => a.label.localeCompare(b.label));
    return items;
  }
  ```

  `COMPLETION_ITEM_KIND_PROPERTY` is already defined in the file (used for attribute completion). Data refs aren't function-shaped, so reusing the property kind matches their nature.

- [ ] **Step 5: Wire as the first content-context branch in `getCompletions`**

  After the existing exclusion guard and fileModel guard, insert the new branch BEFORE the existing `eventHandlerValueContext` check:

  ```js
  export function getCompletions({ graph, documentPath, position, sourceText, extensionRoot }) {
    if (typeof sourceText !== "string") {
      return [];
    }
    const offset = offsetAt(sourceText, position);
    if (offset === undefined || isInsideRawTextOrComment(sourceText, offset)) {
      return [];
    }

    const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
    if (!fileModel) {
      return [];
    }

    const interpolationContext = interpolationCompletionContext(sourceText, position, fileModel);
    if (interpolationContext) {
      if (interpolationContext.suppress) return [];
      return dataRefCompletionItems(graph, documentGraphPath, fileModel, interpolationContext.range);
    }

    const handlerValueContext = eventHandlerValueContext(sourceText, position);
    if (handlerValueContext) {
      return eventHandlerCompletionItems(graph, documentGraphPath, handlerValueContext.range);
    }

    // ... rest of the function unchanged ...
  }
  ```

  Order rationale: interpolation-completion FIRST because it's the only branch active inside `{{...}}`; the other branches all assume cursor is in element/attribute syntax outside any expression.

- [ ] **Step 6: Syntax check**

  Run: `node --check server/wxml-language-service.mjs`
  Expected: exit 0.

- [ ] **Step 7: Sanity-run existing tests; update any pre-Stage-B tests that depend on the old "all `{{...}}` excluded" semantic**

  Run: `node scripts/verify-wxml-language-service.mjs`

  Three existing tests are expected to need updating — they were written under the assumption that ANY cursor inside `{{...}}` returns `[]`. Stage B legitimately fires data-ref completion inside interpolations, so these tests' assertions need to narrow from "items is empty" to "the SPECIFIC thing we don't want to leak isn't in labels":

  | Test (file) | Old semantic | New semantic |
  |---|---|---|
  | `assertOutsideTagCompletionReturnsEmpty` (Phase 1) | cursor at `{{ \| }}` → `[]` | move synthetic source to `<view>plain text\|</view>` — a true outside-everything position |
  | `assertDynamicTemplateCompletionReturnsEmpty` (Phase 1) | cursor at `<template is="{{...|}}"/>` → `[]` | assert `loadingRow` and `secondaryRow` NOT in labels (data refs may appear; template-name suggestions must not) |
  | `SYNTHETIC_HANDLER_COMPLETION_CASES "dynamic {{...}}"` (Phase 2 Stage B) | `expect: empty` | `expect: exclude` (assert `handleSelect` not in labels; data refs may appear) |

  These aren't bugs in the old tests — they were over-specifying. Updating to the narrower property each was actually checking preserves their intent without papering over the new Stage B behavior.

  Common new-code failures (not test updates):
  - "completion immediately after open": the new branch is firing in unexpected places. Trace `interpolationCompletionContext` returns.
  - "tag completion": the exclusion rename broke tag-completion at non-interpolation positions. Re-check Step 2.
  - "interpolation tag" sub-case of `assertExcludedContextsReturnEmpty`: cursor inside `{{ '<view |' }}` — needs the unclosed-string-literal walk in `interpolationCompletionContext` to suppress.

- [ ] **Step 8: No commit yet** — Task 6 adds the new assertions. Commit together.

---

### Task 6: Completion assertions + LSP protocol test

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`
- Modify: `scripts/verify-lsp-diagnostics.mjs`

Six unit assertions: positive data + positive property + negative member-access + negative object-literal + positive wxs-module + negative in-template-definition. One protocol test.

- [ ] **Step 1: Add the positive data-key completion assertion**

  Synthetic source via `sourceWithCursor()` (the helper Stage B uses):

  ```js
  function assertDataRefCompletionMatchesData(graph) {
    // {{th|}} at top level of a view — should suggest data/properties/wxs/for names.
    // home.js has data: {users, total, theme, emptyReason} — expect theme to appear.
    const { source, position } = sourceWithCursor('<view>{{th|}}</view>\n');
    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });
    const labels = items.map((item) => item.label);
    assert(
      labels.includes("theme"),
      `data-ref completion (theme): missing "theme"; got ${JSON.stringify(labels)}`,
    );
  }
  ```

- [ ] **Step 2: Add the positive property-key completion assertion**

  ```js
  function assertDataRefCompletionMatchesProperty(graph) {
    // user-card.js has properties: { user: {...} } — expect user to appear.
    const { source, position } = sourceWithCursor('<view>{{u|}}</view>\n');
    const items = getCompletions({
      graph,
      documentPath: USER_CARD_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });
    const labels = items.map((item) => item.label);
    assert(
      labels.includes("user"),
      `data-ref completion (user): missing "user"; got ${JSON.stringify(labels)}`,
    );
  }
  ```

- [ ] **Step 3: Add the member-access negative assertion**

  ```js
  function assertDataRefCompletionSuppressedAtMemberAccess(graph) {
    // `{{user.na|}}` — after the `.`, no candidates from local scope.
    const { source, position } = sourceWithCursor('<view>{{user.na|}}</view>\n');
    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });
    assert(
      Array.isArray(items) && items.length === 0,
      `data-ref completion (member access): expected [], got ${JSON.stringify(items)}`,
    );
  }
  ```

- [ ] **Step 4: Add the object-literal negative assertion**

  ```js
  function assertDataRefCompletionSuppressedInObjectLiteral(graph) {
    // `{{key: val|}}` — object literal shape, no identifier candidates anywhere.
    const { source, position } = sourceWithCursor('<view>{{key: val|}}</view>\n');
    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });
    assert(
      Array.isArray(items) && items.length === 0,
      `data-ref completion (object literal): expected [], got ${JSON.stringify(items)}`,
    );
  }
  ```

- [ ] **Step 5: Add the wxs module name positive assertion**

  Important to verify the scope union includes wxs names — home.wxml has `<wxs module="format">`, so `{{f|}}` should include `format`.

  ```js
  function assertDataRefCompletionIncludesWxsModule(graph) {
    const { source, position } = sourceWithCursor('<view>{{f|}}</view>\n');
    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });
    const labels = items.map((item) => item.label);
    assert(
      labels.includes("format"),
      `data-ref completion (wxs): missing "format"; got ${JSON.stringify(labels)}`,
    );
  }
  ```

- [ ] **Step 5b: Add the in-template-definition negative assertion**

  Lock the suppression added in Task 5 Step 3 / `isPositionInsideTemplateDefinition`. The check reads `fileModel.symbols` for `kind: "template"` ranges. home.wxml itself uses templates only as call sites (`<template is="...">`), so `home`'s real fileModel has zero template-definition symbols — meaning a synthetic source like `<template name="X">{{th|}}</template>` against `HOME_WXML` would NOT trigger the suppression naturally (the gate sees no template symbols and falls through to a positive completion result).

  Two ways to fix this: (a) inject a synthetic template-definition symbol into `homeFile.symbols` for the cursor's line range, or (b) point `documentPath` at a fixture that genuinely contains `<template name="...">` and arrange synthetic-text. (a) is the simpler mutation pattern that matches Stage A's precedent.

  ```js
  function assertDataRefCompletionSuppressedInTemplateDefinition(graph) {
    // Synthetic source on a single line — cursor inside `<template name="X">` body.
    // `theme` exists in home.js data; without suppression, completion would suggest
    // it. Symbol mutation injects a template-definition range covering the cursor
    // so `isPositionInsideTemplateDefinition` actually fires.
    const { source, position } = sourceWithCursor('<template name="X">{{th|}}</template>\n');
    const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
    assert(homeFile && Array.isArray(homeFile.symbols), "test setup: home file must have symbols");
    const originalSymbols = homeFile.symbols;
    const synthetic = {
      kind: "template",
      name: "X",
      // Cover the whole synthetic line — cursor at `{line: 0, character: ...}`
      // is guaranteed to fall inside this range.
      range: {
        start: { row: position.line, column: 0 },
        end: { row: position.line, column: source.length },
      },
    };
    homeFile.symbols = [...originalSymbols, synthetic];
    try {
      const items = getCompletions({
        graph,
        documentPath: HOME_WXML,
        position,
        sourceText: source,
        extensionRoot: ROOT,
      });
      assert(
        Array.isArray(items) && items.length === 0,
        `data-ref completion (in template def): expected suppression, got ${JSON.stringify(items)}`,
      );
    } finally {
      homeFile.symbols = originalSymbols;
    }
  }
  ```

  Why suppression is `[]` rather than "candidates from a caller-passed scope": at completion time we don't know which call sites will instantiate this template, so showing candidates from any single call site would be misleading. Symmetric to the diagnostic suppression decision in Phase 3 Stage A.

- [ ] **Step 6: Register all six in the runner**

  After the Task 4 registration block (`// Phase 3 Stage B — Data ref definition`):

  ```js
  // Phase 3 Stage B — Data ref completion
  assertDataRefCompletionMatchesData(graph);
  assertDataRefCompletionMatchesProperty(graph);
  assertDataRefCompletionSuppressedAtMemberAccess(graph);
  assertDataRefCompletionSuppressedInObjectLiteral(graph);
  assertDataRefCompletionIncludesWxsModule(graph);
  assertDataRefCompletionSuppressedInTemplateDefinition(graph);
  ```

- [ ] **Step 7: Add the LSP protocol test**

  In `scripts/verify-lsp-diagnostics.mjs`, place after `testEventHandlerCompletion` (Stage B's protocol test):

  Per the LSP-harness pattern (Stage B used `changeDocument` for `assertCompletionTextEdit` checks — see e.g. `scripts/verify-lsp-diagnostics.mjs:870-883`), replace home.wxml's content with a synthetic source that has `{{th|}}` at a known position, then assert BOTH label inclusion AND the exact textEdit range. Without the range assertion, a regression that produced `textEdit.range` covering just `th` instead of the full `th` replacement region would accept-into-text as `themeeme` and the test would still pass.

  ```js
  async function testDataRefCompletion() {
    await withClient({ rootPath: ROOT }, async (client) => {
      const uri = client.openDocument(HOME_WXML);
      await client.waitForDiagnostics(
        uri,
        (items) => items.length === 1,
        "home diagnostics before data-ref completion",
      );

      // Replace home.wxml with a synthetic body: `<view>{{th}}</view>`.
      // Cursor at line 0, character 10 lands right after `th` and before `}`.
      // typed = "th", range start = col 10 - 2 = 8, range end = col 10.
      const synthetic = '<view>{{th}}</view>\n';
      client.changeDocument(HOME_WXML, synthetic, 2);

      const result = await client.completion(HOME_WXML, { line: 0, character: 10 });
      assertCompletionLabelsInclude(result, ["theme"], "data ref completion");
      assertCompletionTextEdit(
        result,
        "theme",
        {
          range: { start: { line: 0, character: 8 }, end: { line: 0, character: 10 } },
          newText: "theme",
        },
        "data ref completion",
      );
    });
  }
  ```

  Column math justification: `<view>{{th}}</view>` — col 0-5 is `<view>`, col 6-7 is `{{`, col 8-9 is `th`, col 10 is `}`. Cursor at character 10 sits between the second `h` and the closing `}`. interpolationCompletionContext finds `{{` at col 6, computes typed = "th" (length 2), startCharacter = 10 - 2 = 8. So textEdit.range = `{start: col 8, end: col 10}` and newText = "theme". Accepting the suggestion replaces "th" with "theme", producing `<view>{{theme}}</view>`.

  Register in scenarios + graph-smoke list:

  ```js
  ["data ref completion", testDataRefCompletion],
  ```

  graph-smoke:
  ```js
  "data ref completion",
  ```

- [ ] **Step 8: Run all tests**

  Run:
  ```bash
  node scripts/verify-wxml-language-service.mjs && node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke 2>&1 | tail -12
  ```
  Expected: both exit 0; graph-smoke output includes both `[verify-lsp-diagnostics] data ref definition` and `[verify-lsp-diagnostics] data ref completion`.

- [ ] **Step 9: Run umbrella**

  Run: `bash scripts/verify-tree-sitter.sh 2>&1 | tail -5`
  Expected: ends with `wxml-zed tree-sitter verification passed`. ~3 min (wasm rebuild). If `npx tree-sitter-cli` EACCES fires (we've seen this), retry with sandbox disabled.

- [ ] **Step 10: Commit Tasks 5 + 6 (completion + tests together)**

  ```bash
  git add server/wxml-language-service.mjs \
          scripts/verify-wxml-language-service.mjs \
          scripts/verify-lsp-diagnostics.mjs
  git commit -m "feat: lsp completion for wxml data references

  Phase 3 Stage B (2/2). Typing inside a {{...}} expression now
  surfaces data keys, component properties, wxs module names, and
  wx:for-item/index names from the file's scope. Mirrors the Stage
  B event-handler completion architecture.

  Implementation changes:

   - isExcludedCompletionContext renamed to isInsideRawTextOrComment
     and no longer excludes inside {{...}} — that case is handled
     by the new interpolationCompletionContext detector.
   - interpolationCompletionContext returns {typed, range, suppress}.
     suppress fires on object-literal shape (whole-expression check),
     member-access tail (cursor after `.`), template literals (we
     bail per stripStringLiterals contract), or cross-line typed.
   - dataRefCompletionItems builds the candidate set: dataKeys +
     propertyKeys (when not hasDynamicData) + wxs symbols + wx:for
     bindings (item/index defaults + custom names). Uses
     COMPLETION_ITEM_KIND_PROPERTY since data refs aren't function-
     shaped.
   - Branch wired FIRST in getCompletions dispatch — interpolation
     is the only place these candidates make sense.

  Six assertions cover positive data, positive property, negative
  member access, negative object literal, and the wxs-module name
  inclusion. One LSP protocol test mirrors testEventHandlerCompletion,
  registered in graph-smoke + full."
  ```

---

### Task 7: Notes + plan sync

**Files:**
- Modify: `docs/wasm-parser-spike-notes.md`
- Modify: this plan doc if anything diverged during execution

- [ ] **Step 1: Draft the notes section**

  Insert after the Phase 3 Stage A "Post-merge fixes" subsection and before the trailing `**Regression anchor for parse-error case:**` block. Be precise about what shipped vs what's still out of scope — Definition only covers data + property refs (NOT wxs module names, NOT wx:for-item/index names). Completion covers all four scope sources but doesn't validate cross-component prop names. Cover:
  - **What shipped**: cmd-click on a `{{name}}` reference jumps to its `data:` or `properties:` key in the sibling .js. Typing inside `{{...}}` lists candidates from dataKeys + propertyKeys + wxs module names + wx:for-item/index names (default + custom).
  - **What's intentionally NOT shipped**: Definition for wxs module names (data is in `fileModel.symbols`, follow-up is trivial but didn't make v1); Definition for wx:for-item/index names (would jump to the directive attribute itself, marginal value over editor's built-in word-jump).
  - Data-shape refactor: `dataKeys` / `propertyKeys` went from `string[]` to `{name, nameRange}[]`. Same pattern as `methods[]` already had. Required because Definition needs the source position to navigate to. Side-effect: Phase 3 Stage A's two diagnostic mutation tests needed their string-equality filter predicates rewritten to `.name` comparisons — a class of false-green hazard noted before the refactor shipped.
  - Definition is AUTHORITATIVE narrow-first (slotted between event-handler and component dispatch). Skip on `inTemplateDefinition` mirrors Phase 3 Stage A's diagnostic gate.
  - Completion required restructuring `isExcludedCompletionContext` — `{{...}}` moved out (it's now actively handled, not silently dropped). Renamed `isInsideRawTextOrComment` keeps comment + wxs exclusion semantics intact.
  - Completion's four suppression paths: object literal (whole-expression check), member access (after `.`), template literal (backtick → bail), AND `<template name="X">` body (via fileModel.symbols range check — same semantic as the Phase 3 Stage A diagnostic gate).
  - Test infra reuse: assertions follow the Stage A graph-mutation pattern; protocol tests mirror Stage A/B precedent (using `changeDocument` + `assertCompletionTextEdit` for full range coverage rather than label-only checks); no new fixtures.
  - Phase 3 Stage C carry-over (all unblocked by Task 1's data lift): wxs module Definition (cursor on `format` in `{{format.price(total)}}` → jump to `<wxs module="format">` line); Quick-fix code action ("add data key to .js" for missing-expression-ref); Hover (`{{user.name}}` hover → "user: property from this Component").

- [ ] **Step 2: Sync this plan doc**

  Re-read the plan and reconcile each code block against what was shipped. Most-likely drift points: the dispatch insertion positions (Task 3 Step 1 for Definition, Task 5 Step 5 for Completion wire), the case schema in Task 1 Step 3 if any extra assertions were needed, and the synthetic symbol-mutation pattern in Task 6 Step 5b if the gate's signature drifted.

- [ ] **Step 3: Commit**

  ```bash
  git add docs/wasm-parser-spike-notes.md docs/superpowers/plans/2026-05-20-data-ref-definition-completion.md
  git commit -m "docs: record Phase 3 Stage B outcome in spike notes

  Phase 3 Stage B adds Definition + Completion for data/property
  references inside {{...}} expressions. Specifically:

   - Definition: cmd-click on {{name}} jumps to data:/properties:
     key in sibling .js. (NOT shipped: Definition for wxs module
     names or wx:for-item/index names — both deferred to Phase 3
     Stage C; data is already lifted to enable them.)
   - Completion: typing inside {{...}} suggests names from
     dataKeys + propertyKeys + wxs module names + wx:for-item/index
     bindings. Four suppression paths: object literal, member
     access, template literal, and <template name=\"X\"> body.

  Append section covering the data-shape refactor (dataKeys /
  propertyKeys gain nameRange — string[] -> {name, nameRange}[]
  to support source-position navigation), authoritative narrow-
  first dispatch ordering for Definition, the isExcludedCompletion
  Context restructure for Completion, the false-green hazard caught
  before refactor merged (Phase 3 Stage A mutation tests using
  string-equality filters on the keys array would have silently
  stopped working), and Phase 3 Stage C carry-overs (wxs
  Definition, Hover, Quick-fix code actions) that this plan
  unblocked but didn't ship."
  ```

---

## Sequencing Notes

- Task 1 is the data-shape refactor — single commit, both producer (extractMethods) and consumers (verifier + scope build) updated atomically.
- Task 2 is the helpers relocation to `shared/` — single commit, pure refactor with no behavior change. Separate from Task 1 to keep bisect attribution clean (data-shape change vs file-relocation are independent refactors).
- Tasks 3+4 form the Definition feature (one commit, feature + tests + protocol coverage).
- Tasks 5+6 form the Completion feature (one commit, feature + tests + protocol coverage).
- Task 7 closes with notes + plan sync per the saved feedback discipline.
- Total: 5 commits (data refactor / helpers move / definition / completion / notes).

## Self-Review Checklist (run before handing off)

- [ ] All `Files:` paths resolve to real locations in the current tree.
- [ ] Every step that changes code shows the actual code.
- [ ] Every step that runs a command shows the exact command and expected output.
- [ ] No "TBD" / "appropriate" / "similar to" placeholders.
- [ ] Type names consistent across tasks: `extractDataKeys` (new return shape `{name, nameRange}[]`), `expressionRefMatch` (Task 3), `interpolationCompletionContext` (Task 5), `dataRefCompletionItems` (Task 5), `isPositionInsideTemplateDefinition` (Task 5), `isInsideRawTextOrComment` (Task 5 rename).
- [ ] The Definition `code` field is implicit (Location response, no code field). The Completion responses use `COMPLETION_ITEM_KIND_PROPERTY`.
- [ ] All 10 new assertion names match between definition and registration. Specifically: 4 Definition + 6 Completion.
- [ ] `interpolationCompletionContext` takes `fileModel` as a third argument and checks `isPositionInsideTemplateDefinition` BEFORE the object-literal / member-access / template-literal gates. Without this, completion inside `<template name="X">` body leaks owner data into candidates — symmetric breakage to what Phase 3 Stage A's diagnostic gate prevents.
- [ ] Task 1 Step 4b's mutation-filter rewrite is applied; `original.filter((k) => k !== "...")` becomes `original.filter((k) => k.name !== "...")` at both call sites. A grep AFTER Task 1 commits should return ZERO matches for `(k) => k !==` patterns referencing dataKeys/propertyKeys.
- [ ] Task 6 Step 7's LSP protocol test uses `changeDocument` to inject synthetic source AND asserts `assertCompletionTextEdit` with explicit range/newText, not just label inclusion.
- [ ] Task 6 Step 5b's in-template-definition assertion injects a synthetic `kind: "template"` symbol covering the cursor line; without this, the gate sees zero template symbols (home.wxml's real fileModel has none) and the suppression doesn't fire.
- [ ] Hand-computed home.wxml column offsets (line 4 col 22 inside theme; line 1 col 25 inside user) verified against fixtures — re-confirm against the actual files if anything seems off.
- [ ] The dispatch order is narrow-first: event-handler → data-ref → component → dependency. Verify Task 3 Step 1 puts the new branch BETWEEN event-handler (line 681-ish) and component (line 683-ish).
- [ ] `isInsideRawTextOrComment` still excludes comments and inline wxs raw text. Verify Task 5 Step 2 didn't accidentally drop those clauses too.
- [ ] `server/wxml-language-service.mjs` imports `looksLikeObjectLiteralExpression` and `stripStringLiterals` from `../shared/wxml-expression-helpers.mjs` (NOT from `scripts/extract-wxml-symbols.mjs`). Layering: runtime server only imports from `shared/`.
- [ ] Completion branch returns `[]` (not undefined) when inside `{{...}}` but at a suppress-position — otherwise dispatch falls through to event-handler / template / tag / attr branches, which is wrong.
