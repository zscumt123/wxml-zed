# `wxForBindings` Compat Shim Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the legacy `wxForBindings` flat compat shim (now zero runtime consumers) from the symbol-extractor output, its dead feeder code, and its verifier assertions.

**Architecture:** Two tasks, tests-first. Task 1 converts the four `wxForScopes`-also tests off the shim and deletes the W-7 byte-equal invariant — done against the still-present shim so narrow-ranges stays green (21→20). Task 2 then deletes the shim derivation + loose accumulators + the dead `else` feeder from the extractor and the CLI passthrough, regenerates the 8 wasm baselines, and proves via a normalized pre/post deepEqual that ONLY `wxForBindings` was removed (no incidental field drift).

**Tech Stack:** Node ESM, no test framework (plain `assert()` runner scripts), tree-sitter-wxml wasm extractor.

**Spec:** `docs/superpowers/specs/2026-05-27-wxforbindings-shim-retirement-design.md`

---

## File Structure

- **Modify** `scripts/verify-wxml-narrow-ranges.mjs` — convert S-F5/F6/F7/F8 (drop `wxForBindings` assertions, keep `wxForScopes` ones, fix labels); delete W-7 (`testCompatShimByteEqual` + `W7_FROZEN_WX_FOR_BINDINGS` + comment + CASES entry). [Task 1]
- **Modify** `shared/wxml-symbol-extractor.mjs` — delete the `wxForBindings` derivation, the `wxForLooseItems`/`wxForLooseIndexes` accumulators + comment, the `else` feeder branch, and de-shim the line-325 comment. [Task 2]
- **Modify** `scripts/extract-wxml-symbols.mjs` — drop `wxForBindings` from the destructure (line 43) and the returned object (line 56). [Task 2]
- **Modify** `fixtures/wasm-spike/*-symbols-baseline.json` (8 files) — regenerate without the field. [Task 2]

Untouched: `wxForScopes` and every other extractor field; hover/definition/completion/diagnostics; the grammar; historical docs. No `version` bump (the symbol model carries `version: 1` in `extract-wxml-symbols.mjs:86`; per spec §6 it is internal test/tool output, removal of an unread field is backward-safe, and a bump would itself perturb every baseline's `version` field and pollute the Task-2 clean-diff guard).

---

## Task 1: Convert S-F5..F8 off the shim + delete W-7 (narrow-ranges 21→20, stays green)

These edits run against the CURRENT extractor (shim still present), so the converted tests pass on their `wxForScopes` assertions and deleting W-7 just removes a passing case.

**Files:**
- Modify: `scripts/verify-wxml-narrow-ranges.mjs`

- [ ] **Step 1: Strip the shim assertions from S-F5 (`testLooseAttrCompat`)**

Replace:
```js
function testLooseAttrCompat() {
  const result = extract("fixtures/wasm-spike/wx-for-loose-attr.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(scopes.length === 0, `S-F5: loose wx:for-item without wx:for must NOT create a scope; got ${JSON.stringify(scopes)}`);
  const bindings = file.wxForBindings;
  assert(bindings, `S-F5: expected wxForBindings (compat shim)`);
  assert(bindings.items.includes("loose"), `S-F5: derived wxForBindings.items must include legacy loose name; got ${JSON.stringify(bindings.items)}`);
  assert(bindings.indexes.includes("loose_idx"), `S-F5: derived wxForBindings.indexes must include legacy loose name; got ${JSON.stringify(bindings.indexes)}`);
  assert(bindings.hasAnyWxFor === false, `S-F5: hasAnyWxFor must be false (no real wx:for present); got ${bindings.hasAnyWxFor}`);
}
```
with:
```js
function testLooseAttrCompat() {
  const result = extract("fixtures/wasm-spike/wx-for-loose-attr.wxml");
  const file = result.files[0];
  const scopes = file.wxForScopes ?? [];
  assert(scopes.length === 0, `S-F5: loose wx:for-item without wx:for must NOT create a scope; got ${JSON.stringify(scopes)}`);
}
```

- [ ] **Step 2: Strip the shim assertion from S-F6 (`testBareWxForCreatesScope`)**

Replace:
```js
  assert(s.wxForRange, `S-F6: wxForRange must exist (covers the bare wx:for attr)`);
  const bindings = file.wxForBindings;
  assert(bindings.hasAnyWxFor === true,
    `S-F6: derived hasAnyWxFor must be true (legacy parity); got ${bindings.hasAnyWxFor}`);
}
```
with:
```js
  assert(s.wxForRange, `S-F6: wxForRange must exist (covers the bare wx:for attr)`);
}
```

- [ ] **Step 3: Strip the shim assertions from S-F7 (`testInterpolatedItemNameFallsBackToImplicit`)**

Replace:
```js
  assert(s.itemName === "item" && s.itemSource === "implicit" && s.itemNameRange === null,
    `S-F7: dynamic wx:for-item="{{dyn}}" must fall back to implicit; got ${JSON.stringify(s)}`);
  const bindings = file.wxForBindings;
  assert(!bindings.items.includes("{{dyn}}"),
    `S-F7: wxForBindings.items must NOT contain the literal "{{dyn}}"; got ${JSON.stringify(bindings.items)}`);
  assert(!bindings.items.includes("dyn"),
    `S-F7: wxForBindings.items must NOT contain "dyn" either; got ${JSON.stringify(bindings.items)}`);
}
```
with:
```js
  assert(s.itemName === "item" && s.itemSource === "implicit" && s.itemNameRange === null,
    `S-F7: dynamic wx:for-item="{{dyn}}" must fall back to implicit (name not captured); got ${JSON.stringify(s)}`);
}
```

- [ ] **Step 4: Strip the shim assertions from S-F8 (`testBlockElementCreatesScope`)**

Replace:
```js
  assert(s.wxForRange, `S-F8: wxForRange must exist on the block-element scope`);
  const bindings = file.wxForBindings;
  assert(bindings.hasAnyWxFor === true,
    `S-F8: derived hasAnyWxFor must be true for <block wx:for>; got ${bindings.hasAnyWxFor}`);
  assert(bindings.items.includes("row"),
    `S-F8: wxForBindings.items must include "row" (compat with legacy attribute-level extraction); got ${JSON.stringify(bindings.items)}`);
}
```
with:
```js
  assert(s.wxForRange, `S-F8: wxForRange must exist on the block-element scope`);
}
```

- [ ] **Step 5: Delete the W-7 invariant (comment + frozen map + function)**

Delete the entire block from the `// W-7: derived wxForBindings must byte-equal the pre-change snapshot` comment through the closing `}` of `function testCompatShimByteEqual() { ... }`. This is one contiguous region: the multi-line `// W-7:` comment, the `const W7_FROZEN_WX_FOR_BINDINGS = { ... };` map, and the `function testCompatShimByteEqual() { ... }` definition (it ends with a `for (const key of Object.keys(W7_FROZEN_WX_FOR_BINDINGS)) { ... }` loop followed by its closing `}`). Remove all of it.

- [ ] **Step 6: Update the CASES labels and remove the W-7 entry**

In the `CASES` array, update the three now-inaccurate labels and delete the W-7 line.

Replace:
```js
  ["S-F5: loose attrs without wx:for preserve legacy compat", testLooseAttrCompat],
  ["S-F6: bare wx:for preserves legacy hasAnyWxFor", testBareWxForCreatesScope],
  ["S-F7: dynamic wx:for-item interpolation does not leak into items", testInterpolatedItemNameFallsBackToImplicit],
  ["S-F8: <block wx:for> creates a scope (legacy compat)", testBlockElementCreatesScope],
```
with:
```js
  ["S-F5: loose attrs without wx:for create no scope", testLooseAttrCompat],
  ["S-F6: bare wx:for produces an implicit-default scope", testBareWxForCreatesScope],
  ["S-F7: dynamic wx:for-item interpolation falls back to implicit", testInterpolatedItemNameFallsBackToImplicit],
  ["S-F8: <block wx:for> creates a scope", testBlockElementCreatesScope],
```

And delete this line from the `CASES` array:
```js
  ["W-7: wxForBindings compat shim is byte-equal across all baselines", testCompatShimByteEqual],
```

- [ ] **Step 7: Run narrow-ranges — verify green at 20**

Run: `node scripts/verify-wxml-narrow-ranges.mjs`
Expected: `Result: 20 passed, 0 failed` (was 21; W-7 removed, S-F5..F8 converted). The shim still exists in the extractor at this point — that's fine; nothing asserts its value anymore.

- [ ] **Step 8: Commit**

```bash
git add scripts/verify-wxml-narrow-ranges.mjs
git commit -m "test: convert S-F5..F8 off wxForBindings shim, delete W-7 (shim retirement prep)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Remove the shim from the extractor + CLI, regenerate baselines, prove clean diff

**Files:**
- Modify: `shared/wxml-symbol-extractor.mjs`
- Modify: `scripts/extract-wxml-symbols.mjs`
- Modify: `fixtures/wasm-spike/*-symbols-baseline.json` (8 files, regenerated)

- [ ] **Step 1: Snapshot the current baselines BEFORE any change (load-bearing for the guard)**

```bash
mkdir -p "$TMPDIR/wxforbindings-before"
cp fixtures/wasm-spike/*-symbols-baseline.json "$TMPDIR/wxforbindings-before/"
ls "$TMPDIR/wxforbindings-before/" | wc -l   # expect 8
```
These copies still contain `wxForBindings` and are the "before" side of the normalized comparison in Step 7.

- [ ] **Step 2: Delete the `wxForBindings` derivation from the extractor return**

In `shared/wxml-symbol-extractor.mjs`, replace:
```js
    expressionRefs,
    wxForScopes,
    /** @deprecated compatibility shim derived from wxForScopes plus loose-attr accumulators;
     * new code should consume wxForScopes directly.
     * Legacy compat shim. As of v2-C no runtime consumer reads this (completion
     * migrated in v2-B, diagnostics in v2-C); only verify-wxml-narrow-ranges' W-7
     * byte-equal invariant still asserts it. Retire in a dedicated later round. */
    wxForBindings: (() => {
      const explicitItems = wxForScopes
        .filter((s) => s.itemSource === "explicit")
        .map((s) => s.itemName);
      const explicitIndexes = wxForScopes
        .filter((s) => s.indexSource === "explicit")
        .map((s) => s.indexName);
      return {
        items: [...new Set([...explicitItems, ...wxForLooseItems])].sort(),
        indexes: [...new Set([...explicitIndexes, ...wxForLooseIndexes])].sort(),
        hasAnyWxFor: wxForScopes.length > 0,
      };
    })(),
  };
```
with:
```js
    expressionRefs,
    wxForScopes,
  };
```

- [ ] **Step 3: Delete the loose-accumulator declarations + comment**

In `shared/wxml-symbol-extractor.mjs`, replace:
```js
  // Loose accumulators preserve the legacy quirk where wx:for-item /
  // wx:for-index without wx:for still leaks into wxForBindings.items /
  // .indexes. Not surfaced in the public schema; only used to derive the
  // compat shim. Will be removed when wxForBindings itself is retired.
  const wxForLooseItems = new Set();
  const wxForLooseIndexes = new Set();
```
with nothing (remove all six lines).

- [ ] **Step 4: Delete the dead `else` feeder branch**

In `shared/wxml-symbol-extractor.mjs`, replace:
```js
        } else {
          // Loose wx:for-item / wx:for-index (no wx:for on this element).
          // Preserve legacy behavior verbatim: same quotedAttrTextValue
          // helper (interpolation values return null and don't leak)
          // and same `length > 0` gate. Feed into loose accumulators
          // for the compat shim only; do NOT create a scope.
          if (wxForItemAttr) {
            const v = quotedAttrTextValue(wxForItemAttr);
            if (typeof v === "string" && v.length > 0) wxForLooseItems.add(v);
          }
          if (wxForIndexAttr) {
            const v = quotedAttrTextValue(wxForIndexAttr);
            if (typeof v === "string" && v.length > 0) wxForLooseIndexes.add(v);
          }
        }
```
with:
```js
        }
```
(An element carrying `wx:for-item`/`-index` without a `wx:for` now produces no scope and no binding — the correct WeChat semantic; the `else` only existed to feed the retired shim.)

- [ ] **Step 5: De-shim the dynamic-name comment**

In `shared/wxml-symbol-extractor.mjs`, replace:
```js
          // IMPORTANT: read item/index names with quotedAttrTextValue (NOT
          // attributeRawValue). The legacy helper returns null when the
          // quoted value contains an `interpolation` child — this is the
          // gate that keeps dynamic names like wx:for-item="{{dyn}}" out
          // of the explicit-binding path. Using attributeRawValue would
          // leak the literal "{{dyn}}" into wxForBindings.items and
          // break W-7 byte-equal. Locked by S-F7.
```
with:
```js
          // IMPORTANT: read item/index names with quotedAttrTextValue (NOT
          // attributeRawValue). The legacy helper returns null when the
          // quoted value contains an `interpolation` child — this is the
          // gate that keeps dynamic names like wx:for-item="{{dyn}}" out
          // of the explicit-binding path, so the scope falls back to an
          // implicit itemName instead of capturing "{{dyn}}". Locked by S-F7.
```

- [ ] **Step 6: Remove the CLI passthrough**

In `scripts/extract-wxml-symbols.mjs`, replace:
```js
  const { dependencies, symbols, references, components, eventHandlers, expressionRefs, wxForScopes, wxForBindings } = collectFile(tree, inputAbs);
```
with:
```js
  const { dependencies, symbols, references, components, eventHandlers, expressionRefs, wxForScopes } = collectFile(tree, inputAbs);
```
And replace:
```js
  return { path: inputRel, dependencies, symbols, references, components, eventHandlers, expressionRefs, wxForScopes, wxForBindings };
```
with:
```js
  return { path: inputRel, dependencies, symbols, references, components, eventHandlers, expressionRefs, wxForScopes };
```

- [ ] **Step 7: Verify no runtime/test code still reads the field**

Run:
```bash
grep -rn "wxForBindings" server/ shared/ scripts/
```
Expected: ONLY comment matches remain (e.g. `server/wxml-language-service.mjs:854` and `scripts/verify-wxml-language-service.mjs:2032`). There must be NO code that reads/writes `.wxForBindings` and NO remaining reference in `scripts/verify-wxml-narrow-ranges.mjs` (Task 1 removed those). If any non-comment hit appears, fix before continuing.

- [ ] **Step 8: Regenerate the 8 wasm baselines**

Each baseline is the extractor output for that case's file list (the diff is order-independent). Run all eight:
```bash
node scripts/extract-wxml-symbols.mjs fixtures/miniprogram/pages/home/home.wxml > fixtures/wasm-spike/home-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs $(find fixtures/miniprogram -name '*.wxml' | sort) > fixtures/wasm-spike/miniprogram-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/test.wxml > fixtures/wasm-spike/test-wxml-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/real-world/component.wxml fixtures/real-world/page.wxml fixtures/real-world/templates.wxml > fixtures/wasm-spike/real-world-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/real-world/edge-recovery.wxml > fixtures/wasm-spike/edge-recovery-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/non-ascii.wxml > fixtures/wasm-spike/non-ascii-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/wx-for-unquoted.wxml > fixtures/wasm-spike/wx-for-unquoted-symbols-baseline.json
node scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/wx-for-block.wxml > fixtures/wasm-spike/wx-for-block-symbols-baseline.json
```

- [ ] **Step 9: Normalized pre/post deepEqual guard — prove ONLY wxForBindings was removed**

Run this throwaway script (it strips every `wxForBindings` key from both the before-snapshot and the regenerated baseline, then `deepStrictEqual`s them per file):
```bash
node -e '
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert");
const before = path.join(process.env.TMPDIR, "wxforbindings-before");
const after = "fixtures/wasm-spike";
const strip = (x) => Array.isArray(x) ? x.map(strip)
  : (x && typeof x === "object")
    ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "wxForBindings").map(([k, v]) => [k, strip(v)]))
    : x;
const files = fs.readdirSync(after).filter((f) => f.endsWith("-symbols-baseline.json"));
assert(files.length === 8, `expected 8 baselines, got ${files.length}`);
for (const f of files) {
  const b = strip(JSON.parse(fs.readFileSync(path.join(before, f), "utf8")));
  const a = strip(JSON.parse(fs.readFileSync(path.join(after, f), "utf8")));
  assert.deepStrictEqual(a, b, `DRIFT in ${f}: a non-wxForBindings field changed`);
}
console.log("OK: every baseline differs only by the removed wxForBindings key");
'
```
Expected: `OK: every baseline differs only by the removed wxForBindings key`. If it throws a DRIFT assertion, STOP — a field other than `wxForBindings` changed; investigate before committing.

Then explicitly lock the deletion target itself — the deepEqual above strips `wxForBindings` from BOTH sides, so it proves "no other field drifted" but NOT that the field is actually gone. Confirm absence directly:
```bash
grep -rn '"wxForBindings"' fixtures/wasm-spike && echo "FAIL: field still present" || echo "OK: no wxForBindings key remains in any baseline"
```
Expected: `OK: no wxForBindings key remains in any baseline` (grep finds nothing, so the `||` branch fires).

As a human cross-check: `git diff fixtures/wasm-spike` should show only removed `wxForBindings` objects (plus comma/brace adjustments), nothing else.

- [ ] **Step 10: Run the full verifier suite — confirm green**

```bash
node scripts/verify-wxml-narrow-ranges.mjs
node scripts/verify-wasm-symbol-baselines.mjs
node scripts/verify-wxml-language-service.mjs; echo "ls exit=$?"
node scripts/verify-lsp-diagnostics.mjs --suite=graph-smoke > "$TMPDIR/gs.txt" 2>&1; echo "gs exit=$?"
```
Expected: narrow-ranges `20 passed, 0 failed`; wasm `All 8 wasm symbol baselines match.`; `ls exit=0`; `gs exit=0`.

- [ ] **Step 11: Run the umbrella verifier**

```bash
bash scripts/verify-tree-sitter.sh
```
Expected: exits 0. SANDBOX NOTE: this spawns the npx tree-sitter-cli binary, which fails with `EACCES` under a command sandbox — a known environment constraint, not a code issue. If you see EACCES / operation-not-permitted, rerun the SAME command outside the sandbox via your runner's approved sandbox-escalation mechanism (e.g. Claude Code's Bash `dangerouslyDisableSandbox: true`, or the equivalent "run outside sandbox / approved escalation" option in your environment). Report which mode succeeded.

- [ ] **Step 12: Commit**

```bash
git add shared/wxml-symbol-extractor.mjs scripts/extract-wxml-symbols.mjs fixtures/wasm-spike/
git commit -m "refactor(extractor): retire wxForBindings compat shim

No runtime consumer reads it (completion migrated v2-B, diagnostics v2-C).
Remove the derivation, the loose-attr accumulators and their dead else feeder,
and the CLI passthrough; regenerate the 8 wasm baselines. wxForScopes and every
other field are byte-identical (verified by a normalized strip-and-deepEqual of
the baselines). No version bump (internal tool output; unread-field removal is
backward-safe).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-review checklist (run by plan author)

- **Spec coverage:** §1 extractor delete → Task 2 Steps 2-5; §2 CLI → Task 2 Step 6; §3 baseline regen → Task 2 Step 8; §4 convert S-F5..F8 + delete W-7 → Task 1; §6 version check → File Structure note + Task 2 Step 7 grep; Testing §1 normalized guard → Task 2 Steps 1+9; comment refs → left as-is (Task 2 Step 5 only de-shims the one extractor comment whose claim ("break W-7") became false).
- **Placeholder scan:** every step has exact old/new text or exact commands.
- **Ordering:** tests-first (Task 1) so no step is ever red; the before-snapshot (Task 2 Step 1) is taken before the extractor change; the deepEqual guard (Step 9) precedes the suite run and commit.
- **Type/name consistency:** `wxForScopes` retained everywhere; removed symbols (`wxForLooseItems`, `wxForLooseIndexes`, `wxForBindings`, `W7_FROZEN_WX_FOR_BINDINGS`, `testCompatShimByteEqual`) are all deleted together (extractor + CLI in Task 2, verifier in Task 1) with no dangling reference.
