# WXML Expression Reference Diagnostic v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 3 Stage A. When a WXML `{{...}}` interpolation or a `wx:if` / `wx:elif` / `wx:for` directive references a top-level identifier that is not defined in the sibling `.js` page/component's `data: {...}`, not introduced by an in-scope `wx:for-item` / `wx:for-index`, and not a WXS module name, emit a Warning-level LSP diagnostic pointing at the specific identifier. Catches the silent-fail-today class of typos like `wx:for="{{itemsx}}"`.

**Architecture:** Same disciplined two-side pattern as Phase 2 Stage C: extractors gather data, language-service consumes. WXML extractor adds `expressionRefs[]` (top-level identifier references with positions) and `wxForBindings` (the names introduced by any `wx:for-item` / `wx:for-index` in the file). JS extractor extends `extractMethods` to also surface `dataKeys[]` and `hasDynamicData` — `dynamicMethodsViaProperty` from Stage C refactored to return `{hasDynamicMethods, hasDynamicData}` from one pair walk. Diagnostic in `getDiagnostics()` checks each expression ref against the file's data + for-bindings + wxs module names; suppresses on `hasDynamicData`, no script, or expression-looks-like-object-literal heuristic.

**Verification:** Unit-level only.
- `scripts/verify-js-script-info.mjs` extends from 12 to **~18** cases covering the new `dataKeys` / `hasDynamicData` matrix (plain data object, spread in data, identifier as data, computed key, no data).
- `scripts/verify-wxml-language-service.mjs` adds 8 `assertExpressionRefDiagnostic*` assertions: positive-clean (home.wxml unchanged → no new diagnostics); positive emission on missing data ref; positive emission inside `wx:for` directive; suppression by wxs module name (`format`); suppression by `wx:for-item` default `item`; suppression by `hasDynamicData`; suppression by no-sibling-script; suppression on object-literal-shaped expression.
- Baselines for `fixtures/wasm-spike/*-symbols-baseline.json` regenerated to reflect the new `expressionRefs` and `wxForBindings` fields. The regen is mechanical — visually inspect the diff is internally consistent (every interpolation in the fixture produces an entry; every directive identifier appears once) and commit.
- **No new LSP protocol test.** Diagnostics share one `textDocument/publishDiagnostics` channel; same rationale as Stage C.
- **No new fixtures.** home.wxml already has rich expression coverage. Negative cases use synthetic source via existing `sourceWithCursor`-like patterns (and in-memory mutation where needed).

**Tech Stack:** No new dependencies. Uses existing tree-sitter-wxml `interpolation` / `expression` nodes (free win: tree gives us pre-tokenized expressions), the strict gate from Stage B (reused as-is for event handlers; this feature doesn't gate on it), and the `findOwnerConfigWithScript` helper from Stage B's simplify pass.

**Out of scope (v1):**
- Per-element `wx:for` scope analysis. Use file-level coarse scope: any `wx:for-item="X"` anywhere in the file adds `X` to scope for the whole file. False-negatives accepted; false-positives are zero.
- WXS-internal identifier validation (`{{format.unknownFn(x)}}` doesn't warn on `unknownFn`).
- Method resolution from `behaviors: [...]` cross-file (Stage C already suppresses on behaviors via `hasDynamicMethods` — for data we extend to `hasDynamicData` and apply the same logic).
- TS/TSX sibling files.
- Quick-fix code action ("create stub data key").
- Computed property keys (`data: { [x]: 1 }`) — uncommon; the affected key isn't extracted, so refs to it would false-positive. Accepted v1 trade-off — `hasDynamicData` doesn't fire on computed keys today; v2 candidate.
- Template `data="{{x: y}}"` inline-object refs — the whole expression is filtered by the object-literal-shape heuristic. False-negative (`y` should be checked but isn't), accepted v1.

---

## File Structure

- Modify: `scripts/extract-wxml-symbols.mjs`
  - Export `looksLikeObjectLiteralExpression(text)` — `^\s*\{?\s*ident\s*:` shape with no `?` before the colon.
  - Export `stripStringLiterals(text)` — replaces single/double-quote string CONTENT with equal-length spaces (offsets stable); returns `null` for template literals (caller bails).
  - Export `topLevelIdentifiers(text)` — string-stripped scan; skips member-access tails, JS literals (true/false/null/undefined), JS operator keywords (typeof, instanceof, in, of, void, new, delete, this).
  - Extend `collectFile` walker to populate `expressionRefs[]` and `wxForBindings: {items, indexes, hasAnyWxFor}`.
  - Add new fields to the file output object and to the serialized JSON. Baseline files regenerate as part of Task 2.
- Create: `scripts/verify-wxml-expression-helpers.mjs`
  - Focused 19-case verifier locking the helper behavior independently of the extractor's tree walk. Covers identifier extraction, member-access tails, JS literals, operator keywords, string-literal contents (single/double quote, escapes), template-literal bailout, object-literal shapes, ternary distinguishing.
  - Wired into `scripts/verify-tree-sitter.sh` immediately after `verify-js-script-info.mjs`.
- Modify: `shared/js-method-extractor.mjs`
  - Refactor `dynamicMethodsViaProperty(objectNode)` to `dynamicFlagsFromProperties(objectNode)` returning `{hasDynamicMethods, hasDynamicData}`. Add `data` key detection (non-object value → `hasDynamicData=true`).
  - Add `containsSpread(dataBlock)` check in `extractMethods` when a data block is present — spread in data block sets `hasDynamicData=true`.
  - Add `extractDataKeys(dataObjectNode)` helper that walks `pair` children with `property_identifier` keys and returns `string[]`.
  - Change `extractMethods` return shape from `{methods, hasDynamicMethods}` to `{methods, hasDynamicMethods, dataKeys, hasDynamicData}`.
- Modify: `scripts/extract-wxml-project-graph.mjs`
  - Update the script-attachment block to pass through `dataKeys` and `hasDynamicData` on `config.script`.
- Modify: `scripts/poc-js-method-extractor.mjs`
  - Already unpacks `.methods` — no change. Baseline byte-identical.
- Modify: `scripts/verify-js-script-info.mjs`
  - Extend the cases list with 6 new entries covering `data` matrix; assert against `dataKeys` and `hasDynamicData` in addition to existing fields.
- Modify: `server/wxml-language-service.mjs`
  - Add `expressionRefDiagnostics(graph, documentGraphPath, fileModel)` helper.
  - `getDiagnostics` returns `[...componentDiags, ...eventHandlerDiags, ...expressionRefDiags]`.
- Modify: `scripts/verify-wxml-language-service.mjs`
  - 8 new `assertExpressionRefDiagnostic*` assertions registered near the existing diagnostic asserts.
- Modify: `fixtures/wasm-spike/*-symbols-baseline.json` (6 files)
  - Regenerated after Task 2.
- Modify: `docs/wasm-parser-spike-notes.md`
  - Append Phase 3 Stage A section.

---

### Task 1: Add expression helpers (with verifier) before any extractor integration

**Files:**
- Modify: `scripts/extract-wxml-symbols.mjs`
- Create: `scripts/verify-wxml-expression-helpers.mjs`
- Modify: `scripts/verify-tree-sitter.sh`

TDD ordering: define and lock the helpers' behavior on synthetic strings (where edge cases are easy to enumerate) BEFORE they get wired into the extractor walker. The helpers cover three concerns:

1. **Identifier extraction** from raw expression text, with a string-literal pre-strip so `{{status === 'ready'}}` does not produce a `ready` ref.
2. **JS-keyword filtering** so `typeof`, `instanceof`, `in`, `of`, `void`, `new`, `delete`, `this` are not treated as identifier references.
3. **Object-literal shape detection** so `{{message: 'x'}}` (template data) skips identifier extraction entirely.

The recon already proved Finding 1's false-positive surface: `status === 'ready'` → catches `ready`; `typeof total === 'number'` → catches `typeof` and `number`; `item.type === 'vip'` → catches `vip`. These shapes appear in real WeChat code constantly.

- [ ] **Step 1: Add and export `looksLikeObjectLiteralExpression(text)`**

  Place near the top of `scripts/extract-wxml-symbols.mjs` after the existing helpers (around line 35, near `innerValueRange`). Export so the verifier can call it:

  ```js
  // Heuristic: detect expression text shaped like an object literal
  // (`{key: ...}` or `key: ...`), as in `<template data="{{message: 'x'}}"/>`.
  // Identifiers in property-key position must not be validated against scope.
  // False-negatives accepted: values in the literal go unchecked (v1 trade-off).
  export function looksLikeObjectLiteralExpression(text) {
    const trimmed = text.trim();
    const m = trimmed.match(/^\{?\s*[A-Za-z_$][A-Za-z0-9_$]*\s*:/u);
    if (!m) return false;
    // Distinguish ternary `cond ? a : b` from object literal `a : b`.
    const colonAt = trimmed.indexOf(":");
    return !trimmed.slice(0, colonAt).includes("?");
  }
  ```

- [ ] **Step 2: Add and export `stripStringLiterals(text)`**

  Returns the text with string-literal CONTENT replaced by spaces (preserving offsets so subsequent identifier-match indices stay correct). Returns `null` if a template literal is encountered — caller treats that as "bail on this expression". Place immediately after `looksLikeObjectLiteralExpression`:

  ```js
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
  ```

- [ ] **Step 3: Add and export `topLevelIdentifiers(text)`**

  Place immediately after `stripStringLiterals`:

  ```js
  // JS keyword set — these tokens are syntactically identifier-shaped but
  // are not references that the user code introduces. `typeof`, `in`,
  // `instanceof`, etc. appear in real WeChat WXML expressions like
  // `wx:if="{{typeof total === 'number'}}"`. `this` is added because it
  // would never resolve through data/wxs/wx:for scope.
  const JS_RESERVED_OR_OPERATOR = new Set([
    "true", "false", "null", "undefined",
    "typeof", "instanceof", "in", "of",
    "void", "new", "delete", "this",
  ]);

  // Returns [{name, offset}] for each top-level identifier in `text`.
  // "Top-level" means not preceded by `.` (member access). String-literal
  // contents are pre-stripped. Object-literal-shaped expressions are
  // skipped entirely. Template literals cause an empty return (conservative).
  // The returned `offset` is the character offset within the original (pre-
  // strip) text — the caller adds the expression node's start position to
  // derive file-level coordinates.
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

- [ ] **Step 4: Wrap `main()` in a direct-run guard so importing the module is safe**

  `scripts/extract-wxml-symbols.mjs` currently ends with an unconditional `main().catch(...)` call (around line 293). It also exits with code 2 when `process.argv.slice(2)` is empty (the Usage path, around line 265). As soon as the verifier in Step 5 imports the exported helpers from this file, ESM module loading triggers `main()` as a side effect — `process.argv` doesn't include any `.wxml` paths in the verifier process, so the Usage exit fires and the verifier dies before its own code runs.

  This file has no existing imports today (verified — `grep -rn "from.*extract-wxml-symbols" scripts/ server/ shared/` returns nothing), so wrapping the entry-point guard is a pure no-op for the CLI path while unblocking imports.

  At the top of the file (next to other Node imports — `path`, `fileURLToPath`), ensure `fileURLToPath` is imported (it already is per the existing header). At the very bottom, replace:

  ```js
  main().catch((err) => {
    process.stderr.write(`FAIL: ${err?.message || err}\n`);
    process.exit(1);
  });
  ```

  with:

  ```js
  const isDirectRun = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

  if (isDirectRun) {
    main().catch((err) => {
      process.stderr.write(`FAIL: ${err?.message || err}\n`);
      process.exit(1);
    });
  }
  ```

  Smoke that the CLI path still works:

  ```bash
  node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml | head -3
  ```
  Expected: a JSON object with `version` and `files` keys (same as today). Exit 0.

  And that importing the module no longer runs `main()`:
  ```bash
  node --input-type=module -e 'import "./scripts/extract-wxml-symbols.mjs"; console.log("imported without exiting");'
  ```
  Expected: `imported without exiting`, exit 0. If you see "Usage:" or the process exits 2, the guard isn't wired.

- [ ] **Step 5: Create the focused verifier**

  Create `scripts/verify-wxml-expression-helpers.mjs`:

  ```js
  #!/usr/bin/env node
  import { topLevelIdentifiers, looksLikeObjectLiteralExpression, stripStringLiterals } from "./extract-wxml-symbols.mjs";

  const IDENT_CASES = [
    { label: "plain identifier", input: "theme", expected: ["theme"] },
    { label: "member access tail", input: "item.name", expected: ["item"] },
    { label: "multi-member chain", input: "a.b.c + x", expected: ["a", "x"] },
    { label: "JS literal keywords", input: "true && false && null && undefined", expected: [] },
    { label: "typeof operator", input: "typeof total === 'number'", expected: ["total"] },
    { label: "instanceof operator", input: "x instanceof Y", expected: ["x", "Y"] },
    { label: "in operator", input: "key in obj", expected: ["key", "obj"] },
    { label: "string literal content (single-quote)", input: "status === 'ready'", expected: ["status"] },
    { label: "string literal content (double-quote)", input: 'mode === "active"', expected: ["mode"] },
    { label: "ternary with string branches", input: "cond ? 'a' : 'b'", expected: ["cond"] },
    { label: "member + string literal mix", input: "item.type === 'vip'", expected: ["item"] },
    { label: "this keyword", input: "this.x + y", expected: ["y"] },
    { label: "void operator", input: "void 0 || fallback", expected: ["fallback"] },
    { label: "escape inside string", input: "label === 'it\\'s'", expected: ["label"] },
    { label: "template literal bails", input: "`hello ${name}`", expected: [] },
    { label: "object literal shape", input: "message: 'Loading users'", expected: [] },
    { label: "object literal with brace", input: "{count: 0, theme: 'light'}", expected: [] },
    { label: "ternary not confused for object", input: "cond ? a : b", expected: ["cond", "a", "b"] },
    { label: "multiple top-level identifiers in call", input: "format.price(item.total)", expected: ["format", "item"] },
  ];

  function assert(cond, msg) {
    if (!cond) {
      process.stderr.write(`FAIL: ${msg}\n`);
      process.exit(1);
    }
  }

  function main() {
    process.stdout.write(`[verify-wxml-expression-helpers] ${IDENT_CASES.length} cases ... `);
    for (const { label, input, expected } of IDENT_CASES) {
      const actual = topLevelIdentifiers(input).map((r) => r.name);
      const expectedSorted = [...expected].sort();
      const actualSorted = [...actual].sort();
      assert(
        actualSorted.length === expectedSorted.length && actualSorted.every((n, i) => n === expectedSorted[i]),
        `${label}: expected [${expectedSorted.join(", ")}], got [${actualSorted.join(", ")}] from ${JSON.stringify(input)}`,
      );
    }

    // looksLikeObjectLiteralExpression spot-checks
    assert(looksLikeObjectLiteralExpression("message: 'x'") === true, "object: bare key");
    assert(looksLikeObjectLiteralExpression("{count: 0}") === true, "object: braced");
    assert(looksLikeObjectLiteralExpression("cond ? a : b") === false, "object: ternary not flagged");
    assert(looksLikeObjectLiteralExpression("plain.ref") === false, "object: plain ref not flagged");

    // stripStringLiterals spot-checks
    assert(stripStringLiterals("a + 'foo' + b") === "a + '   ' + b", "strip: single quote preserves length");
    assert(stripStringLiterals("a + `foo`") === null, "strip: template literal bails to null");

    process.stdout.write("PASS\n");
    process.stdout.write(`\nAll ${IDENT_CASES.length} expression-helper cases match.\n`);
  }

  main();
  ```

- [ ] **Step 6: Make executable, wire into umbrella, run**

  ```bash
  chmod +x scripts/verify-wxml-expression-helpers.mjs
  ```

  In `scripts/verify-tree-sitter.sh`, find the existing `verify-js-script-info.mjs` line (inserted in Stage C) and add the new verifier immediately AFTER it:

  ```bash
  node "$ROOT_DIR/scripts/verify-wxml-expression-helpers.mjs"
  ```

  Run: `node scripts/verify-wxml-expression-helpers.mjs`
  Expected:
  ```
  [verify-wxml-expression-helpers] 19 cases ... PASS

  All 19 expression-helper cases match.
  ```

  Common failure modes:
  - `string literal content (single-quote): expected [status], got [status, ready]`: `stripStringLiterals` isn't being called or isn't blanking the string contents. Inspect with `console.error(stripStringLiterals("status === 'ready'"))` temporarily.
  - `instanceof operator: expected [x, Y], got [x, instanceof, Y]`: keyword set missing `instanceof`. Re-check Step 3.
  - `template literal bails: expected [], got [hello, name]`: `stripStringLiterals` should return `null` on backtick; `topLevelIdentifiers` should treat null as "skip the expression entirely". Re-check Step 3.

- [ ] **Step 7: Commit helpers + verifier + direct-run guard (Task 1 only)**

  ```bash
  git add scripts/extract-wxml-symbols.mjs scripts/verify-wxml-expression-helpers.mjs scripts/verify-tree-sitter.sh
  git commit -m "feat: wxml expression helpers (topLevelIdentifiers + object-literal heuristic)

  Phase 3 Stage A prep. Three exported helpers in extract-wxml-symbols.mjs:

   - looksLikeObjectLiteralExpression(text): true for shapes like
     'message: x' or '{count: 0, theme: ...}'. Distinguishes ternary
     'cond ? a : b' by checking for '?' before the first ':'.
   - stripStringLiterals(text): replaces single/double-quoted string
     CONTENT with spaces of equal length (offsets stable). Template
     literals return null — caller bails on the whole expression.
   - topLevelIdentifiers(text): regex scan after stripping strings;
     skips member-access tails, JS literals (true/false/null/undefined),
     and operator keywords (typeof, instanceof, in, of, void, new,
     delete, this). Object-literal-shaped expressions short-circuit
     to [].

  Required side-step: extract-wxml-symbols.mjs's entry point is now
  guarded by an import.meta.url check so importing the module from
  the new verifier doesn't trigger the CLI's Usage exit. The CLI
  invocation behavior is unchanged.

  Focused verifier at scripts/verify-wxml-expression-helpers.mjs locks
  19 cases including the false-positive surfaces that triggered this
  design (wx:if='{{status === \"ready\"}}', wx:if='{{typeof total ===
  \"number\"}}', wx:if='{{item.type === \"vip\"}}', etc.). Wired into
  the umbrella verify-tree-sitter.sh.

  Helpers are exported but not yet imported by the walker — next task
  hooks them into collectFile's interpolation visitor.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 2: Wire helpers into the WXML extractor walker; regenerate baselines

**Files:**
- Modify: `scripts/extract-wxml-symbols.mjs`
- Modify: `fixtures/wasm-spike/*-symbols-baseline.json` (6 files, after regeneration)

The helpers from Task 1 now get integrated. Add the two new file-level outputs (`expressionRefs`, `wxForBindings`) and regenerate baselines.

- [ ] **Step 1: Add `offsetToPositionWithin(text, offset)` helper**

  Multi-line expression handling: given expression text and a character offset into it, compute `{rowDelta, columnOfRow}` so the caller can derive file-level row/column. Place near other position helpers.

  ```js
  function offsetToPositionWithin(text, offset) {
    let row = 0;
    let lastNewline = -1;
    for (let i = 0; i < offset; i++) {
      if (text.charCodeAt(i) === 0x0a) {
        row += 1;
        lastNewline = i;
      }
    }
    return { rowDelta: row, columnOfRow: offset - lastNewline - 1 };
  }
  ```

- [ ] **Step 2: Add expressionRefs and wxForBindings to `collectFile`**

  Find `collectFile` (around line 119, returns `{dependencies, symbols, references, components, eventHandlers}`). Add two new collectors and weave them into the walker.

  Locate the function header and the existing collector arrays (around line 122–127):

  ```js
  const symbols = [];
  const references = [];
  const components = [];
  const eventHandlers = [];
  ```

  Add directly after:

  ```js
  const expressionRefs = [];
  const wxForItems = new Set();
  const wxForIndexes = new Set();
  let hasAnyWxFor = false;
  ```

  Inside the `walk(node)` function, add three new node-type branches. The interpolation handler is the most involved — it visits `interpolation` (not `expression` directly) so that we have access to the full `{{...}}` start position to compute child expression positions; pull the `expression` child via `firstChildOfType`.

  Place this branch immediately before the existing wxs / import / include / event-handler dispatch:

  ```js
  if (node.type === "interpolation") {
    const exprNode = firstChildOfType(node, "expression");
    if (exprNode) {
      const exprText = exprNode.text;
      const exprStartRow = exprNode.startPosition.row;
      const exprStartCol = exprNode.startPosition.column;
      const exprRange = rangeOf(exprNode);
      for (const { name, offset } of topLevelIdentifiers(exprText)) {
        const { rowDelta, columnOfRow } = offsetToPositionWithin(exprText, offset);
        const startRow = exprStartRow + rowDelta;
        const startCol = rowDelta === 0 ? exprStartCol + columnOfRow : columnOfRow;
        expressionRefs.push({
          name,
          source: "interpolation",
          range: {
            start: { row: startRow, column: startCol },
            end: { row: startRow, column: startCol + name.length },
          },
          expressionRange: exprRange,
        });
      }
    }
  }
  ```

  For the attribute-level branches — `wx:if`, `wx:elif`, `wx:for` (the directives that take an expression value), AND `wx:for-item` / `wx:for-index` (which take a plain string value) — extend the existing `if (node.type === "attribute")` block. Just before the existing event-binding regex check (around line 130–148), insert:

  ```js
  if (node.type === "attribute") {
    const nameNode = firstChildOfType(node, "attribute_name");
    if (nameNode) {
      const attrName = nameNode.text;
      // Directives that contain a single interpolated expression are also
      // surfaced via the `interpolation` walker above (their value node is
      // an `interpolation`). So we don't need to re-emit expressionRefs
      // here. Just capture wx:for-item / wx:for-index plain-string values.
      if (attrName === "wx:for") {
        hasAnyWxFor = true;
      } else if (attrName === "wx:for-item") {
        const valueText = quotedAttrTextValue(node);
        if (typeof valueText === "string" && valueText.length > 0) wxForItems.add(valueText);
      } else if (attrName === "wx:for-index") {
        const valueText = quotedAttrTextValue(node);
        if (typeof valueText === "string" && valueText.length > 0) wxForIndexes.add(valueText);
      }
      // ... existing event-binding regex check continues unchanged ...
    }
  }
  ```

  Define a small helper `quotedAttrTextValue(attrNode)` that returns the inner string of a `quoted_attribute_value` if the child is a string literal (NOT an interpolation):

  ```js
  function quotedAttrTextValue(attrNode) {
    const v = firstChildOfType(attrNode, "quoted_attribute_value");
    if (!v) return null;
    // Reject if the value contains an interpolation child (we only want
    // plain `"name"` form, not `"{{name}}"`).
    for (let i = 0; i < v.namedChildCount; i++) {
      if (v.namedChild(i).type === "interpolation") return null;
    }
    const text = v.text;
    if (text.length >= 2 && (text[0] === '"' || text[0] === "'")) {
      return text.slice(1, -1);
    }
    return text;
  }
  ```

  Place `quotedAttrTextValue` near the existing `innerValueRange` helper.

- [ ] **Step 3: Sort and emit the new fields**

  At the end of `collectFile`, before the existing return:

  ```js
  expressionRefs.sort(byPosition);
  ```

  Update the return statement:

  ```js
  return {
    dependencies,
    symbols,
    references,
    components,
    eventHandlers,
    expressionRefs,
    wxForBindings: {
      items: [...wxForItems].sort(),
      indexes: [...wxForIndexes].sort(),
      hasAnyWxFor,
    },
  };
  ```

  Update the outer destructure / re-pack at the file's main path (around line 247) to include both new fields:

  ```js
  const { dependencies, symbols, references, components, eventHandlers, expressionRefs, wxForBindings } = collectFile(tree, inputAbs);
  ```

  And the per-file output:

  ```js
  return { path: inputRel, dependencies, symbols, references, components, eventHandlers, expressionRefs, wxForBindings };
  ```

- [ ] **Step 4: Syntax check and smoke run against home.wxml**

  Run: `node --check scripts/extract-wxml-symbols.mjs`
  Expected: exit 0.

  Then smoke:
  ```bash
  node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml | python3 -c '
  import sys, json
  data = json.load(sys.stdin)
  f = data["files"][0]
  print("expressionRefs:", [r["name"] for r in f["expressionRefs"]])
  print("wxForBindings:", f["wxForBindings"])
  '
  ```

  Expected output:
  ```
  expressionRefs: ['theme', 'users', 'item', 'emptyReason', 'format', 'total']
  wxForBindings: {'items': [], 'indexes': [], 'hasAnyWxFor': True}
  ```

  Note: `message` and `label` (from the two `data="{{message: 'X'}}"` template attributes on lines 6 and 22) are filtered by `looksLikeObjectLiteralExpression`. If they appear in the output, the heuristic regex is off — re-check.

  If the smoke output is wrong, common causes:
  - `expressionRefs` missing items → walker did not reach `interpolation` (check that the `if (node.type === "interpolation")` branch is BEFORE the recursive `for` loop at the bottom of `walk`)
  - `wxForBindings.hasAnyWxFor` is `false` → `wx:for` attribute branch is misspelled
  - Object-literal values leaking through → `looksLikeObjectLiteralExpression` returned false; inspect with `console.error(text, looksLikeObjectLiteralExpression(text))` temporarily

- [ ] **Step 5: Regenerate baselines**

  Six baseline files need refresh. The simplest regen is to use the extractor's own output:

  ```bash
  node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > fixtures/wasm-spike/home-symbols-baseline.json
  node scripts/extract-wxml-symbols.mjs fixtures/test.wxml > fixtures/wasm-spike/test-wxml-symbols-baseline.json
  node scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/non-ascii.wxml > fixtures/wasm-spike/non-ascii-symbols-baseline.json
  node scripts/extract-wxml-symbols.mjs fixtures/real-world/edge-recovery.wxml > fixtures/wasm-spike/edge-recovery-symbols-baseline.json

  # real-world is multi-file:
  node scripts/extract-wxml-symbols.mjs \
    fixtures/real-world/component.wxml \
    fixtures/real-world/page.wxml \
    fixtures/real-world/templates.wxml > fixtures/wasm-spike/real-world-symbols-baseline.json

  # miniprogram is a glob — handled by the verifier; replicate its file list:
  node -e '
  import fs from "node:fs/promises";
  import path from "node:path";
  async function listWxml(dir) {
    const out = [];
    const walk = async (d) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (p.endsWith(".wxml")) out.push(p);
      }
    };
    await walk(dir);
    return out.sort();
  }
  const files = await listWxml("fixtures/miniprogram");
  process.stdout.write(files.map(f => `"${f}"`).join(" "));
  ' --input-type=module
  ```

  (The last command prints the file list; use it to feed `extract-wxml-symbols.mjs`. Alternatively, write a one-off shell line that pipes the list. The point is to match the file order the verifier uses; running the verifier in a `--update` mode would be cleaner, but the existing verifier has no such flag — verify the baseline diff visually.)

- [ ] **Step 6: Inspect the baseline diffs**

  Run: `git diff fixtures/wasm-spike/*.json | head -100`
  Expected: each file gains `expressionRefs` (sorted by position) and `wxForBindings`. No existing field changes. The `expressionRefs` content should match what you'd hand-compute from each fixture's `{{...}}` interpolations.

  Important sanity checks:
  - `home-symbols-baseline.json`: expressionRefs include `theme`, `users`, `item`, `emptyReason`, `format`, `total` (exactly these names, exactly once each — interpolations like `{{format.price(total)}}` produce two refs).
  - `non-ascii-symbols-baseline.json`: any interpolations inside should produce refs with correct UTF-16 column units (the existing fixture exercises non-ASCII surroundings; positions should remain UTF-16-correct).
  - `edge-recovery-symbols-baseline.json`: parse-error fixtures may produce zero refs (no usable expression nodes) — that's fine, just ensure no crash.

- [ ] **Step 7: Run baseline verifier**

  Run: `node scripts/verify-wasm-symbol-baselines.mjs`
  Expected: all 6 cases PASS.

- [ ] **Step 8: Commit**

  ```bash
  git add scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/*-symbols-baseline.json
  git commit -m "feat: wxml extractor emits expressionRefs and wxForBindings

  Phase 3 Stage A prep. Adds two new fields to fileModel:

   - expressionRefs[]: each top-level identifier inside a {{...}}
     interpolation (or wx:if/wx:elif/wx:for directive value, since
     those wrap the expression in an interpolation node). Member-
     access tails (\`item.name\` -> only 'item'), language literals
     (true/false/null/undefined), and object-literal-shaped
     expressions like {{message: 'x'}} are excluded.

   - wxForBindings: file-level set of names introduced by
     wx:for-item=\"X\" / wx:for-index=\"Y\" attributes, plus a
     hasAnyWxFor flag for the implicit 'item'/'index' defaults.
     Coarse scope (file, not element subtree) — zero false-positive
     risk; false-negatives accepted as a v1 trade-off.

   Six wasm-spike baselines regenerated with the new fields.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 3: Extend JS extractor with dataKeys and hasDynamicData

**Files:**
- Modify: `shared/js-method-extractor.mjs`
- Modify: `scripts/extract-wxml-project-graph.mjs`

The Stage C `dynamicMethodsViaProperty(opts)` helper walks options object pairs once looking at `behaviors` and `methods` properties. Extend it to also look at `data` — the `key` matrix gets one more entry, the return becomes `{hasDynamicMethods, hasDynamicData}`.

- [ ] **Step 1: Refactor `dynamicMethodsViaProperty` into `dynamicFlagsFromProperties`**

  Find the current `dynamicMethodsViaProperty` in `shared/js-method-extractor.mjs` (lines vary post-Stage C; grep `dynamicMethodsViaProperty` to locate). Replace with:

  **Important — behaviors propagates to BOTH flags**: WeChat Component `behaviors: [...]` can declare `data` AND `methods` AND `properties` (which are reactive-data-like). The Stage C version only set `hasDynamicMethods`; we extend it to also set `hasDynamicData` for the same reason. This is the source of truth — Task 4's case table downstream depends on this behavior.

  ```js
  function dynamicFlagsFromProperties(objectNode) {
    let hasDynamicMethods = false;
    let hasDynamicData = false;
    for (let i = 0; i < objectNode.namedChildCount; i++) {
      const child = objectNode.namedChild(i);
      if (child.type !== "pair") continue;
      const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
      if (!keyNode || keyNode.type !== "property_identifier") continue;
      const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
      if (!valueNode) continue;

      if (keyNode.text === "behaviors") {
        // behaviors can inject both data and methods — set BOTH flags.
        if (valueNode.type === "array") {
          if (valueNode.namedChildCount > 0) {
            hasDynamicMethods = true;
            hasDynamicData = true;
          }
        } else {
          hasDynamicMethods = true;
          hasDynamicData = true;
        }
      } else if (keyNode.text === "methods") {
        if (valueNode.type !== "object") hasDynamicMethods = true;
      } else if (keyNode.text === "data") {
        if (valueNode.type !== "object") hasDynamicData = true;
      }
    }
    return { hasDynamicMethods, hasDynamicData };
  }
  ```

- [ ] **Step 2: Add `extractDataKeys(dataObjectNode)` helper**

  Place near `methodEntriesFromObject`:

  ```js
  function extractDataKeys(dataObjectNode) {
    const out = [];
    for (let i = 0; i < dataObjectNode.namedChildCount; i++) {
      const child = dataObjectNode.namedChild(i);
      if (child.type === "pair") {
        const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
        if (keyNode && keyNode.type === "property_identifier") {
          out.push(keyNode.text);
        }
        // Computed-key pair (`[x]: ...`) and string-key pair (`"foo": ...`)
        // are intentionally skipped at v1.
      } else if (child.type === "shorthand_property_identifier") {
        out.push(child.text);
      }
    }
    return out;
  }
  ```

- [ ] **Step 3: Add `dataBlockOf(objectNode)` helper, parallel to `methodsBlockOf`**

  Place immediately after `methodsBlockOf`:

  ```js
  function dataBlockOf(objectNode) {
    for (let i = 0; i < objectNode.namedChildCount; i++) {
      const child = objectNode.namedChild(i);
      if (child.type !== "pair") continue;
      const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
      if (!keyNode || keyNode.type !== "property_identifier" || keyNode.text !== "data") continue;
      const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
      if (valueNode && valueNode.type === "object") return valueNode;
    }
    return null;
  }
  ```

- [ ] **Step 4: Rewire `extractMethods` to use the new helpers and return shape**

  Current Stage C signature returns `{methods, hasDynamicMethods}`. Add `dataKeys` and `hasDynamicData` to both the local variables and the return.

  Replace the existing function body. Note three key changes from Stage C:
  - `dynamicMethodsViaProperty(opts)` → `dynamicFlagsFromProperties(opts)` (destructured into two locals)
  - Non-object factory arg sets BOTH flags
  - New `dataBlock` walk handles spread within `data: {...}` and contributes to `dataKeys[]`

  ```js
  export function extractMethods(parser, source) {
    const tree = parser.parse(source);
    const methods = [];
    const dataKeys = [];
    let hasDynamicMethods = false;
    let hasDynamicData = false;
    const visit = (node) => {
      if (node.type === "call_expression") {
        const factory = isPageOrComponentCall(node);
        if (factory) {
          const args = fieldChild(node, "arguments");
          const firstArg = args ? args.namedChild(0) : null;
          if (firstArg && firstArg.type !== "object") {
            hasDynamicMethods = true;
            hasDynamicData = true;
          } else if (firstArg) {
            const opts = firstArg;
            if (containsSpread(opts)) {
              hasDynamicMethods = true;
              hasDynamicData = true;
            }
            const flags = dynamicFlagsFromProperties(opts);
            if (flags.hasDynamicMethods) hasDynamicMethods = true;
            if (flags.hasDynamicData) hasDynamicData = true;

            if (factory === "Page") {
              methods.push(...methodEntriesFromObject(opts, METHOD_KIND_PAGE));
            } else {
              methods.push(...methodEntriesFromObject(opts, METHOD_KIND_COMPONENT_LIFECYCLE));
              const methodsBlock = methodsBlockOf(opts);
              if (methodsBlock) {
                if (containsSpread(methodsBlock)) hasDynamicMethods = true;
                methods.push(...methodEntriesFromObject(methodsBlock, METHOD_KIND_COMPONENT_METHOD));
              }
            }

            const dataBlock = dataBlockOf(opts);
            if (dataBlock) {
              if (containsSpread(dataBlock)) hasDynamicData = true;
              dataKeys.push(...extractDataKeys(dataBlock));
            }
          }
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
    };
    visit(tree.rootNode);
    methods.sort((a, b) => {
      const ar = a.range.start, br = b.range.start;
      return (ar.row - br.row) || (ar.column - br.column);
    });
    return { methods, hasDynamicMethods, dataKeys, hasDynamicData };
  }
  ```

- [ ] **Step 5: Update graph extractor to pass the new fields**

  In `scripts/extract-wxml-project-graph.mjs`, locate the `info = extractMethods(parser, source)` block (added in Stage C). Update the `config.script` assignment:

  ```js
  config.script = {
    path: toPosixPath(path.relative(ROOT, jsAbs)),
    methods: info.methods,
    hasDynamicMethods: info.hasDynamicMethods,
    dataKeys: info.dataKeys,
    hasDynamicData: info.hasDynamicData,
  };
  ```

- [ ] **Step 6: Syntax check + baseline regression**

  Run: `node --check shared/js-method-extractor.mjs && node --check scripts/extract-wxml-project-graph.mjs`
  Expected: exit 0.

  Run: `node scripts/verify-js-method-baselines.mjs`
  Expected: `[verify-js-method-baselines] 3 fixtures ... PASS`. The POC extractor still unpacks only `.methods` for serialization — baseline byte-identical.

- [ ] **Step 7: No commit yet** — Task 4 extends `verify-js-script-info.mjs` and validates the new fields. Commit together.

---

### Task 4: Extend script-info verifier with data cases

**Files:**
- Modify: `scripts/verify-js-script-info.mjs`

Add 6 cases covering the `data` matrix. Existing 12 cases asserted `methodNames` and `hasDynamicMethods`; the cases now also assert `dataKeys` (in sorted order, deduplicated) and `hasDynamicData`. Existing cases need their expected outputs amended to declare the data side (all zero / false unless the source contains a `data:` block).

- [ ] **Step 1: Amend the existing 12 cases to declare `dataKeys` and `hasDynamicData`**

  Open `scripts/verify-js-script-info.mjs`. For each existing case, add the two new expectation fields. Most existing cases have no `data:` block, so the defaults are `dataKeys: []` and `hasDynamicData: false` — except cases where the spread / Object.assign also covers data (those propagate `hasDynamicData: true`).

  The amendment table — apply in place to each existing case object literal:

  | Case label | dataKeys | hasDynamicData |
  |---|---|---|
  | plain Page | `[]` | `false` (no data: block) |
  | plain Component | `[]` | `false` |
  | Component with spread in options | `[]` | `true` (options spread affects both) |
  | Component with spread in methods block | `[]` | `false` (methods-block spread is methods-only) |
  | Component with non-empty behaviors array literal | `[]` | `true` (behaviors injects either data or methods) |
  | Component with empty behaviors array literal | `[]` | `false` |
  | Component with behaviors identifier (variable reference) | `[]` | `true` |
  | Component with methods identifier (variable reference) | `[]` | `false` (methods-only) |
  | Component with methods: Object.assign(...) | `[]` | `false` (methods-only) |
  | Component with Object.assign factory arg | `[]` | `true` (non-object factory arg) |
  | Page with spread in options | `[]` | `true` (options spread affects both) |
  | no factory call | `[]` | `false` |

  Wait — re-derive the `behaviors` propagation carefully. The Stage C plan said behaviors triggers `hasDynamicMethods`. Should it also trigger `hasDynamicData`? Component `behaviors` can declare `data` and `properties` — yes, this affects data too. The reflection of this in `dynamicFlagsFromProperties`:

  The behaviors-both-flags propagation is the single source of truth in Task 3 Step 1's `dynamicFlagsFromProperties` body — re-reading that block confirms it sets BOTH `hasDynamicMethods=true` AND `hasDynamicData=true` for any behaviors trigger. The case table above relies on that.

- [ ] **Step 2: Add 6 new cases**

  Append to the `CASES` array:

  ```js
  {
    label: "Page with plain data block",
    source: `Page({ data: { count: 0, theme: "light", users: [] } });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["count", "theme", "users"],
    hasDynamicData: false,
  },
  {
    label: "Component with plain data block",
    source: `Component({ data: { a: 1 }, methods: { custom() {} } });`,
    hasDynamicMethods: false,
    methodNames: ["custom"],
    dataKeys: ["a"],
    hasDynamicData: false,
  },
  {
    label: "Page with spread in data block",
    source: `Page({ data: { ...defaults, count: 0 } });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["count"],
    hasDynamicData: true,
  },
  {
    label: "Page with data identifier (variable reference)",
    source: `Page({ data: pageData });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: [],
    hasDynamicData: true,
  },
  {
    label: "Page with data: Object.assign(...)",
    source: `Page({ data: Object.assign({}, base, { count: 0 }) });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: [],
    hasDynamicData: true,
  },
  {
    label: "Page with computed-key in data (v1: skipped, dynamic flag NOT set)",
    source: `Page({ data: { [name]: 1, count: 0 } });`,
    hasDynamicMethods: false,
    methodNames: [],
    dataKeys: ["count"],
    hasDynamicData: false,
    // Documented v1 limitation: computed keys produce false-positives on
    // refs to the computed name. Future enhancement: extend the detector
    // to flag any computed_property_name child.
  },
  ```

- [ ] **Step 3: Update assertions in the verifier loop**

  Find the `for (const { label, source, hasDynamicMethods, methodNames } ...` loop. Update the destructure to include the new fields and add assertions:

  ```js
  for (const { label, source, hasDynamicMethods, methodNames, dataKeys, hasDynamicData } of CASES) {
    const result = extractMethods(parser, source);
    assert(
      typeof result === "object" && result !== null && Array.isArray(result.methods) && Array.isArray(result.dataKeys),
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

    const actualDataKeys = [...result.dataKeys].sort();
    const expectedDataKeys = [...dataKeys].sort();
    assert(
      actualDataKeys.length === expectedDataKeys.length && actualDataKeys.every((n, i) => n === expectedDataKeys[i]),
      `${label}: dataKeys expected [${expectedDataKeys.join(", ")}], got [${actualDataKeys.join(", ")}]`,
    );
  }
  ```

  Also bump the case count in the user-facing line:

  ```js
  process.stdout.write(`[verify-js-script-info] ${CASES.length} cases ... `);
  // ... and at the end:
  process.stdout.write(`\nAll ${CASES.length} script-info cases match.\n`);
  ```

  (These two lines already use `CASES.length` from the Stage C plan — no manual count required.)

- [ ] **Step 4: Run the verifier**

  Run: `chmod +x scripts/verify-js-script-info.mjs && node scripts/verify-js-script-info.mjs`
  Expected:
  ```
  [verify-js-script-info] 18 cases ... PASS

  All 18 script-info cases match.
  ```

  Common failure modes:
  - `hasDynamicData expected true, got false` on a behaviors case: the propagation of behaviors → both flags wasn't applied in `dynamicFlagsFromProperties` (Step 1 of Task 3). Re-check.
  - `dataKeys expected ["count"], got []` on the data-spread case: spread in data block wasn't followed by the `extractDataKeys` walk over the same block. Both happen — spread flag + remaining literal keys.
  - On the computed-key case: confirm the assertion expects `["count"]` only (the computed pair is silently skipped); `dataKeys: ["count"]` is the documented limitation.

- [ ] **Step 5: Commit Phase 1 (extractor + verifier together)**

  ```bash
  git add shared/js-method-extractor.mjs \
          scripts/extract-wxml-project-graph.mjs \
          scripts/verify-js-script-info.mjs
  git commit -m "feat: js-method-extractor surfaces dataKeys and hasDynamicData

  Phase 3 Stage A prep, mirroring the Stage C hasDynamicMethods
  pattern for the data side. extractMethods now returns:

   - dataKeys[]: top-level identifier keys from data: { ... } block,
     in source order. Computed keys (\`[x]:\`) skipped at v1.
   - hasDynamicData: true when data: <non-object>, spread in data
     block, behaviors property, or non-object factory arg. Inherits
     options-level dynamics (spread in options sets both flags).

  Refactor: dynamicMethodsViaProperty -> dynamicFlagsFromProperties
  returning {hasDynamicMethods, hasDynamicData} from one pair walk.

  Verifier grows from 12 to 18 cases covering the new data matrix:
  plain data; spread in data; data identifier; data Object.assign();
  computed key in data (v1 limitation documented). Existing 12 cases
  amended to assert the new dataKeys/hasDynamicData fields.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 5: Add expressionRefDiagnostics in language-service

**Files:**
- Modify: `server/wxml-language-service.mjs`

`getDiagnostics()` now concatenates THREE branches: missing-local-component (existing), event-handler (Stage C), and expression-ref (new). Order stays: components, handlers, expressions — so the existing `assertMissingCardDiagnostic` (which inspects `diagnostics[0]`) stays stable.

- [ ] **Step 1: Add `expressionRefDiagnostics` helper near `eventHandlerDiagnostics`**

  ```js
  function expressionRefDiagnostics(graph, documentGraphPath, fileModel) {
    const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
    if (!ownerConfig) return [];
    if (ownerConfig.script.hasDynamicData) return [];

    // Build the in-scope identifier set from four sources:
    //  1. data keys from the script
    //  2. wxs module names (from fileModel.symbols where kind === "wxs")
    //  3. wx:for-item bindings (defaulting to "item" if any wx:for exists)
    //  4. wx:for-index bindings (defaulting to "index" if any wx:for exists)
    const scope = new Set();
    for (const key of ownerConfig.script.dataKeys ?? []) scope.add(key);
    for (const sym of fileModel.symbols ?? []) {
      if (sym.kind === "wxs" && typeof sym.name === "string") scope.add(sym.name);
    }
    const bindings = fileModel.wxForBindings;
    if (bindings) {
      if (bindings.hasAnyWxFor) {
        scope.add("item");
        scope.add("index");
      }
      for (const name of bindings.items ?? []) scope.add(name);
      for (const name of bindings.indexes ?? []) scope.add(name);
    }

    const refs = fileModel.expressionRefs ?? [];
    const out = [];
    for (const ref of refs) {
      if (scope.has(ref.name)) continue;
      out.push({
        range: rangeFromSymbolRange(ref.range),
        severity: WARNING,
        source: "wxml-zed",
        code: "missing-expression-ref",
        message: `"${ref.name}" is not defined in the page/component data, wx:for scope, or any <wxs> module.`,
      });
    }
    return out;
  }
  ```

- [ ] **Step 2: Wire it into `getDiagnostics`**

  Append the third concat:

  ```js
  const handlerDiags = eventHandlerDiagnostics(graph, documentGraphPath, fileModel);
  const expressionDiags = expressionRefDiagnostics(graph, documentGraphPath, fileModel);
  return [...componentDiags, ...handlerDiags, ...expressionDiags];
  ```

- [ ] **Step 3: Syntax check**

  Run: `node --check server/wxml-language-service.mjs`
  Expected: exit 0.

- [ ] **Step 4: Run existing language-service tests**

  Run: `node scripts/verify-wxml-language-service.mjs; echo "exit=$?"`
  Expected: `exit=0`. Critical: existing tests still pass, especially `assertMissingCardDiagnostic` (length === 1) — confirm home.wxml emits NO new expression-ref diagnostics. All home.wxml refs (`theme`, `users`, `item`, `emptyReason`, `format`, `total`) must resolve through the scope sources.

  If `assertMissingCardDiagnostic` now fails with `length === 2+`: an identifier in home.wxml is leaking past the scope. Likely culprits:
  - `format` not in scope: check that the wxs symbol walk works (`fileModel.symbols.filter(s => s.kind === "wxs")`).
  - `item` not in scope: `bindings.hasAnyWxFor` is false; check Task 2 Step 2 marked the `wx:for` branch correctly.
  - `total` not in scope: this MUST be defined in home.js's `data:` block. If it isn't, this is a real bug exposed (home.wxml line 19 references `total` but it's not in home.js's current data — verify the assumption holds; if it doesn't, either expand home.js data to include `total` OR document it as a known false-positive on the fixture and add it to the scope test exceptions).

  **Pre-emptive check**: home.js currently has `data: { users: [], total: 0, theme: "light", emptyReason: "" }`. So `total` IS in data. Good. All home.wxml refs should resolve. Proceed.

- [ ] **Step 5: No commit yet** — Task 6 adds the new assertions. Commit together.

---

### Task 6: Add language-service assertions

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`

Eight new `assertExpressionRefDiagnostic*` assertions covering the positive path, two emission shapes (interpolation + directive), and five suppression paths. All use in-memory graph mutation, matching the Stage A/C pattern.

- [ ] **Step 1: Add the positive-clean assertion**

  Insert near the other diagnostic assertions (after Stage C's `assertEventHandlerDiagnosticNoScriptSkips`):

  ```js
  function assertExpressionRefDiagnosticClean(graph) {
    // home.wxml's refs all resolve: theme/users/emptyReason/total via data,
    // format via wxs, item via wx:for default scope. No new warnings.
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
    assert(
      exprDiags.length === 0,
      `expression ref diagnostic (clean): unexpected warnings ${JSON.stringify(exprDiags)}`,
    );
  }
  ```

- [ ] **Step 2: Add the interpolation-emission assertion**

  ```js
  function assertExpressionRefDiagnosticMissingInterpolation(graph) {
    // Mutate: drop "theme" from home.js dataKeys. home.wxml line 5 `<view
    // class="home {{theme}}">` still references it. Diagnostic must emit.
    const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
    assert(homeConfig && homeConfig.script, "test setup: home config must have script");
    const original = homeConfig.script.dataKeys;
    homeConfig.script.dataKeys = original.filter((k) => k !== "theme");
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
      const theme = exprDiags.find((d) => d.message.includes('"theme"'));
      assert(theme, `expected diagnostic for theme; got ${JSON.stringify(exprDiags)}`);
      assert(theme.severity === 2, `severity: ${theme.severity}`);
      assert(theme.source === "wxml-zed", `source: ${theme.source}`);
      // home.wxml line 5 `<view class="home {{theme}}">` — `theme` text starts
      // at column 20 and runs 5 chars.
      assertDeepEqual(
        theme.range,
        { start: { line: 4, character: 20 }, end: { line: 4, character: 25 } },
        "theme diagnostic range",
      );
    } finally {
      homeConfig.script.dataKeys = original;
    }
  }
  ```

- [ ] **Step 3: Add the directive-emission assertion (wx:for value)**

  ```js
  function assertExpressionRefDiagnosticMissingDirective(graph) {
    // Mutate: drop "users" from home.js dataKeys. home.wxml line 9
    // `wx:for="{{users}}"` still references it.
    const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
    assert(homeConfig && homeConfig.script, "test setup: home config must have script");
    const original = homeConfig.script.dataKeys;
    homeConfig.script.dataKeys = original.filter((k) => k !== "users");
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
      const users = exprDiags.find((d) => d.message.includes('"users"'));
      assert(users, `expected diagnostic for users; got ${JSON.stringify(exprDiags)}`);
      // home.wxml line 9 `    wx:for="{{users}}"` — `users` text starts
      // at column 14 and runs 5 chars.
      assertDeepEqual(
        users.range,
        { start: { line: 8, character: 14 }, end: { line: 8, character: 19 } },
        "users diagnostic range",
      );
    } finally {
      homeConfig.script.dataKeys = original;
    }
  }
  ```

- [ ] **Step 4: Add the wxs-module-name suppression assertion**

  ```js
  function assertExpressionRefDiagnosticSuppressedByWxsModule(graph) {
    // home.wxml line 19 `{{format.price(total)}}` references `format` —
    // which is a wxs module name (line 3 `<wxs module="format" ...>`).
    // Even with NO dataKeys at all, `format` must not warn.
    const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
    assert(homeConfig && homeConfig.script, "test setup: home config must have script");
    const original = homeConfig.script.dataKeys;
    homeConfig.script.dataKeys = [];  // strip all data
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
      const formatDiags = exprDiags.filter((d) => d.message.includes('"format"'));
      assert(
        formatDiags.length === 0,
        `expression ref diagnostic (wxs module): leaked "format" warning ${JSON.stringify(formatDiags)}`,
      );
    } finally {
      homeConfig.script.dataKeys = original;
    }
  }
  ```

- [ ] **Step 5: Add the wx:for default-name suppression assertion**

  ```js
  function assertExpressionRefDiagnosticSuppressedByWxForItem(graph) {
    // home.wxml line 11 `user="{{item}}"` references `item` — default
    // wx:for-item name because line 9 has `wx:for=...`. With zero data
    // and zero explicit item bindings, `item` must still resolve.
    const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
    assert(homeConfig && homeConfig.script, "test setup: home config must have script");
    const originalKeys = homeConfig.script.dataKeys;
    homeConfig.script.dataKeys = [];
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
      const itemDiags = exprDiags.filter((d) => d.message.includes('"item"'));
      assert(
        itemDiags.length === 0,
        `expression ref diagnostic (wx:for default): leaked "item" warning ${JSON.stringify(itemDiags)}`,
      );
    } finally {
      homeConfig.script.dataKeys = originalKeys;
    }
  }
  ```

- [ ] **Step 6: Add the hasDynamicData suppression assertion**

  ```js
  function assertExpressionRefDiagnosticSuppressedByDynamicData(graph) {
    // Strip all dataKeys AND set hasDynamicData=true. Even with refs in
    // home.wxml that would otherwise warn, hasDynamicData suppresses ALL.
    const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
    assert(homeConfig && homeConfig.script, "test setup: home config must have script");
    const originalKeys = homeConfig.script.dataKeys;
    const originalFlag = homeConfig.script.hasDynamicData;
    homeConfig.script.dataKeys = [];
    homeConfig.script.hasDynamicData = true;
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
      assert(
        exprDiags.length === 0,
        `expression ref diagnostic (hasDynamicData): expected suppression, got ${JSON.stringify(exprDiags)}`,
      );
    } finally {
      homeConfig.script.dataKeys = originalKeys;
      homeConfig.script.hasDynamicData = originalFlag;
    }
  }
  ```

- [ ] **Step 7: Add the no-script suppression assertion**

  ```js
  function assertExpressionRefDiagnosticNoScriptSkips(graph) {
    const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
    assert(homeConfig && homeConfig.script, "test setup: home config must have script");
    const savedScript = homeConfig.script;
    delete homeConfig.script;
    try {
      const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
      const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
      assert(
        exprDiags.length === 0,
        `expression ref diagnostic (no script): expected suppression, got ${JSON.stringify(exprDiags)}`,
      );
    } finally {
      homeConfig.script = savedScript;
    }
  }
  ```

- [ ] **Step 8: Add the synthetic-ref suppression assertion via expressionRefs mutation**

  Cover the case where a ref names something dynamic. Inject a synthetic ref pointing at a non-existent name; verify diagnostic emits. Then inject one whose name IS in scope via a synthetic wxForBindings entry; verify suppression.

  ```js
  function assertExpressionRefDiagnosticSyntheticForItemSuppresses(graph) {
    const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
    assert(homeFile, "test setup: home file must exist in graph.wxml");
    assert(Array.isArray(homeFile.expressionRefs), "expressionRefs missing from home file model");
    const originalItems = homeFile.wxForBindings?.items ?? [];
    const originalRefs = homeFile.expressionRefs;
    // Add a synthetic ref to a name that ISN'T in scope.
    const synthetic = {
      name: "__synthetic_for_user__",
      source: "interpolation",
      range: { start: { row: 0, column: 0 }, end: { row: 0, column: 24 } },
      expressionRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 24 } },
    };
    homeFile.expressionRefs = [...originalRefs, synthetic];
    try {
      // Baseline: without the binding, expect a warning.
      const before = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT })
        .filter((d) => d.code === "missing-expression-ref" && d.message.includes("__synthetic_for_user__"));
      assert(before.length === 1, `pre-add: expected 1 synthetic warning, got ${before.length}`);

      // Add the name via wxForBindings.items. Now it must resolve.
      homeFile.wxForBindings = {
        ...homeFile.wxForBindings,
        items: [...originalItems, "__synthetic_for_user__"],
      };
      const after = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT })
        .filter((d) => d.code === "missing-expression-ref" && d.message.includes("__synthetic_for_user__"));
      assert(after.length === 0, `post-add: expected wx:for-item suppression, got ${JSON.stringify(after)}`);
    } finally {
      homeFile.expressionRefs = originalRefs;
      if (homeFile.wxForBindings) {
        homeFile.wxForBindings = { ...homeFile.wxForBindings, items: originalItems };
      }
    }
  }
  ```

- [ ] **Step 9: Register all 8 in the runner**

  Find the existing Stage C registration block (`// Phase 2 Stage C — Event handler diagnostic`) and add immediately after:

  ```js
  // Phase 3 Stage A — Expression reference diagnostic
  assertExpressionRefDiagnosticClean(graph);
  assertExpressionRefDiagnosticMissingInterpolation(graph);
  assertExpressionRefDiagnosticMissingDirective(graph);
  assertExpressionRefDiagnosticSuppressedByWxsModule(graph);
  assertExpressionRefDiagnosticSuppressedByWxForItem(graph);
  assertExpressionRefDiagnosticSuppressedByDynamicData(graph);
  assertExpressionRefDiagnosticNoScriptSkips(graph);
  assertExpressionRefDiagnosticSyntheticForItemSuppresses(graph);
  ```

- [ ] **Step 10: Run the test**

  Run: `node scripts/verify-wxml-language-service.mjs; echo "exit=$?"`
  Expected: `exit=0`. Total assertions grow by 8.

  Failure-mode common cases:
  - `expected diagnostic for theme; got []`: dataKeys mutation didn't take, or scope build doesn't include data. Check that `homeConfig.script.dataKeys = original.filter(...)` actually strips theme (`original.indexOf("theme") >= 0` before the filter).
  - `theme diagnostic range bad`: identifier position math is off. Most likely the `expressionRefs[].range` was emitted with wrong UTF-16 / byte units, or `offsetToPositionWithin` mis-calculates. Inspect by extracting home.wxml and printing the ref's range.
  - `leaked "format" warning`: wxs module name walk didn't include `format`. Check `fileModel.symbols.find(s => s.kind === "wxs" && s.name === "format")` exists.

- [ ] **Step 11: Run umbrella**

  Run: `bash scripts/verify-tree-sitter.sh 2>&1 | tail -3`
  Expected: `wxml-zed tree-sitter verification passed`, exit 0. May take ~3 min (wasm rebuild).

  If umbrella fails on the `npx tree-sitter-cli` EACCES (sandbox-cache permission issue seen earlier in this session): re-run with `dangerouslyDisableSandbox: true` — the failure is environmental, not code.

- [ ] **Step 12: Commit Phase 2 (diagnostic + tests together)**

  ```bash
  git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
  git commit -m "feat: lsp diagnostic for missing wxml expression refs

  Phase 3 Stage A. Warning-level diagnostic emitted at the specific
  identifier position when an expression in {{...}}, wx:if, wx:elif,
  or wx:for references a name that is not:
   - a data key in the sibling page/component .js
   - a <wxs module=\"...\"> name
   - an in-scope wx:for-item / wx:for-index name (file-level coarse
     scope; defaults to 'item' / 'index' if any wx:for exists)

  Disciplined suppression matches the Stage C pattern:
   - hasDynamicData (spread in data, behaviors, data identifier,
     Object.assign(), non-object factory arg) -> skip
   - no sibling script -> skip
   - expression looks like object literal (\`{key: value}\`) -> skip
     identifier extraction entirely at the extractor level

  Eight new assertions cover positive-clean (home.wxml unchanged ->
  no new warnings), two emission shapes (interpolation in text vs.
  directive value), five suppression paths (wxs module, wx:for
  default name, hasDynamicData, no script, explicit wxForBindings
  item entry). All use in-memory graph mutation following the
  Stage A/C precedent — no new fixtures, no protocol-layer test.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 7: Record outcome in spike notes and sync plan

**Files:**
- Modify: `docs/wasm-parser-spike-notes.md`
- Modify: this plan doc if any inline correction was made during execution

- [ ] **Step 1: Draft the notes section**

  Insert after the Phase 2 Stage C section, before the trailing `**Regression anchor for parse-error case:**` block. Cover:
  - Opening Phase 3 with the first non-event-handler intelligence feature.
  - Why we picked this next: silent typo (`wx:for="{{itemsx}}"`) is high-impact, low-cost given existing data flow.
  - Architecture: same two-side pattern as Stage C (extractor signal + language-service consumer). New data: `expressionRefs[]` and `wxForBindings` on WXML side; `dataKeys[]` and `hasDynamicData` on JS side.
  - Three deliberate simplifications and their trade-offs: regex-only identifier extraction (not real JS parsing); file-level wx:for scope (not per-element); object-literal-shape heuristic (skips ALL refs inside `{{key: value}}`).
  - Suppression matrix table: data dynamic, no script, object literal, member-access tail, JS keywords.
  - Test infra reuse: same graph-mutation pattern; six wasm-spike baselines regenerated mechanically (visual-inspect step in plan).
  - Phase 3 carry-over: per-element wx:for scope; WXS-internal validation; computed-key support; quick-fix code action; TS/TSX support.

- [ ] **Step 2: Sync this plan doc**

  Re-read the plan and reconcile code blocks against what was actually shipped. Most likely-to-drift sections: the helpers in Task 1 if any keyword set was extended; the walker logic in Task 2 Step 2 (insertion order in `collectFile`); the `dynamicFlagsFromProperties` body in Task 3 Step 1 if behaviors propagation was changed during implementation; the `expressionRefDiagnostics` scope build in Task 5.

- [ ] **Step 3: Commit**

  ```bash
  git add docs/wasm-parser-spike-notes.md docs/superpowers/plans/2026-05-18-expression-ref-diagnostic.md
  git commit -m "docs: record Phase 3 Stage A outcome in spike notes

  Opens Phase 3: first non-event-handler intelligence feature.
  Append section covering: two-side architecture (extractor signal +
  language-service consumer); three deliberate v1 simplifications
  and trade-offs (regex-only identifiers; file-level wx:for scope;
  object-literal-shape heuristic); five-entry suppression matrix;
  test infra reuse (graph mutation, no new fixtures, no protocol
  test); Phase 3 carry-over (per-element scope; WXS-internal
  validation; computed keys; quick-fix; TS/TSX).

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

## Sequencing Notes

- Tasks 1–4 form the extractor side. Four commits: helpers + verifier (Task 1); WXML extractor integration + baseline regen (Task 2); JS extractor + script-info verifier extension (Tasks 3+4 combined, since Task 3 ships an API change with no consumer locking yet — Task 4's amended cases lock it).
- Tasks 5+6 form the language-service side. One feature+tests commit.
- Task 7 closes with notes + plan sync per the saved feedback discipline.

## Self-Review Checklist (run before handing off)

- [ ] All `Files:` paths resolve to real locations in the current tree.
- [ ] Every step that changes code shows the actual code (no "..." or "similar to").
- [ ] Every step that runs a command shows the exact command and expected output.
- [ ] No "TBD" / "appropriate" / "similar to" placeholders.
- [ ] Type names consistent across tasks: `extractMethods` (return now `{methods, hasDynamicMethods, dataKeys, hasDynamicData}`), `dynamicFlagsFromProperties` (replaces `dynamicMethodsViaProperty` from Stage C), `containsSpread` (reused), `dataBlockOf`, `extractDataKeys`, `expressionRefDiagnostics`, `looksLikeObjectLiteralExpression`, `topLevelIdentifiers`, `offsetToPositionWithin`, `quotedAttrTextValue`.
- [ ] All eight new diagnostic assertion names match the registration list in Task 6 Step 9.
- [ ] The diagnostic `code` field is consistently `"missing-expression-ref"` in both Task 5's emit and Task 6's filter (NOT `"missing-event-handler"` or any Stage-C-flavored code).
- [ ] Hand-computed home.wxml column offsets for `theme` (line 4 cols 20–25) and `users` (line 8 cols 14–19) verified against the actual fixture file (re-confirm with `awk 'NR==5 {print}' fixtures/miniprogram/pages/home/home.wxml` and similar).
- [ ] The six wasm-spike baseline files regenerated in Task 2 Step 5 are inspected for sensibility (every interpolation in each fixture produces an entry; no spurious entries from object-literal expressions); the regen step is mechanical but the diff review is not.
- [ ] Behaviors → both flags propagation is consistent: `dynamicFlagsFromProperties` (Task 3 Step 1) sets BOTH `hasDynamicMethods` and `hasDynamicData` when behaviors is present. The Task 4 amendment table reflects this; the Stage C-only suppression behavior is intentionally extended.
- [ ] `topLevelIdentifiers` covers the false-positive surfaces GPT flagged: `wx:if="{{status === 'ready'}}"` produces only `status`, NOT `ready`; `wx:if="{{typeof total === 'number'}}"` produces only `total`. These are locked in Task 1's `verify-wxml-expression-helpers.mjs` verifier.
- [ ] `scripts/extract-wxml-symbols.mjs` has its CLI entry point gated by an `import.meta.url`-based `isDirectRun` check (Task 1 Step 4). Without it the new verifier's import would trigger `main()` and exit on the Usage path before running its own assertions.
