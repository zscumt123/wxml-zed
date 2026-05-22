# Cross-Component Prop Binding Diagnostic — Design

**Status:** spec drafted, awaiting user review before plan.

**One-line summary:** Add a new diagnostic code `dead-component-binding` (LSP severity Information) that downgrades cross-component prop pass-through cases — where the parent's WXML binds a child component's declared property to an undeclared parent identifier — from the current `missing-expression-ref` warning. The warning is preserved for the cases where the binding is truly dead (parent has no var AND child has no matching property API).

## Background

After P2 round 1 (setData walker, see `docs/superpowers/plans/2026-05-21-setdata-key-extraction.md` Outcome section), `mp-wx-chelaile/wx` dropped from 220 to 26 diagnostics. Of the 19 surviving `missing-expression-ref` entries, a 10-sample classification surfaced three sub-buckets, the cleanest of which is **cross-component prop pass-through** (3/10 sampled). Concrete shape:

```wxml
<!-- parent: pages/main/fav-page/index.wxml -->
<local-bar referer="fav" locationError="{{locationError}}"></local-bar>
```

```js
// parent: pages/main/fav-page/index.js
Page({
  data: { /* ... no `locationError` ... */ },
  // ... no setData of `locationError` either
});
```

```js
// child: pages/components/local-bar/index.js
Component({
  properties: {
    locationError: { type: Boolean, value: false },  // child DOES declare it
  },
});
```

The current expressionRefDiagnostics rule is parent-scope-only — it sees `{{locationError}}` in the parent's WXML, finds `locationError` undeclared in the parent's data/properties/wxs/wx:for-scope, and emits `missing-expression-ref` warning. But the semantic intent here is ambiguous between two interpretations:

- **Real bug**: parent forgot to declare `locationError` in its data. The binding silently resolves to undefined at runtime and child falls back to its default (`value: false`), which may not be what the parent intended.
- **Intentional**: parent explicitly does NOT want to pass a value. Child's declared default is the desired behavior.

Both interpretations are plausible. The current warning lumps them together and over-fires on intentional cases — which is the dogfood noise we're addressing.

## Goal

Replace the parent-scope-only check with a two-stage check at component-binding sites:

1. **First stage (unchanged)**: is the identifier in parent scope (data, properties, setData-keys after round 1, wxs symbols, wx:for bindings)? If yes, no diagnostic.
2. **New second stage** (only triggered when first stage fails): if the failing identifier appears inside a component-tag's custom attribute, look up the child component's declared properties. If child declares the attribute name as a property, emit `dead-component-binding` (Information). Otherwise, fall back to the existing `missing-expression-ref` (Warning).

The diagnostic SHAPE (range, message, ability to suppress) for the new code is consistent with the existing diagnostic infrastructure — no new LSP capability negotiation, no client-side changes required.

## Non-Goals

- Following helper-class injection patterns (e.g., `States.applyTo(this)` where keys are constructed via string concat in a helper class). This is the OTHER bucket from the round-1 surviving classification and remains deferred to P2.2-A.
- Tracking properties contributed by `behaviors:` mixin chains. When `hasDynamicData = true` on the child (which the extractor sets for any non-empty `behaviors:` array), the new rule falls back to the current warning. Following behavior chains is multi-file analysis and out of scope.
- Quick-fix code actions ("add this key to parent's data block"). The diagnostic data field is structured to make this feasible later, but the action itself is deferred.
- TypeScript siblings — needs `tree-sitter-typescript.wasm`, separate plan.
- Distinguishing the diagnostic locus between the expression range, attribute name range, and attribute-value range. The range stays on the expression (matching `missing-expression-ref`) for code-path symmetry and minimum baseline disruption.

## Architecture

All logic lives in:

- `shared/wxml-symbol-extractor.mjs` — WXML parser additions to surface containing-tag and containing-attribute context on each `expressionRef`.
- `server/wxml-language-service.mjs` — diagnostic logic extension to `expressionRefDiagnostics`.

No new modules, no new LSP capabilities, no new graph schema entries. The existing `graph.usingComponents` + `graph.configs` chain already exposes everything the cross-component lookup needs.

### Lookup Direction

For `<local-bar locationError="{{userIsLost}}">`, when `userIsLost` is not in the parent scope:

- **The identifier (`userIsLost`)** is the parent's variable namespace — already checked against the parent's data/properties/setData/wxs/wx:for-scope by stage 1.
- **The attribute name (`locationError`)** is the child's property API namespace — the new stage looks up `locationError` against the child's `propertyKeys`.

The attribute name and the identifier may differ. In the chelaile dogfood samples they happen to coincide (`locationError="{{locationError}}"`, `popupLevel="{{popupLevel}}"`), but the rule must look up by attribute name, not identifier name, to be logically correct on the general case.

### Lookup Chain

```
parent WXML graph path (documentGraphPath)
  → graph.usingComponents.find(c => c.owner === documentGraphPath && c.tag === containingTag && c.resolved)
     [find the child component declaration matching the tag]
  → graph.configs.find(c => c.owner === <child target wxml path> && c.script)
     [find the child's config + JS script]
  → child.script.propertyKeys.some(k => k.name === containingAttribute)
     [does child declare this attribute as a property?]
```

All four jumps use existing graph fields. The `c.resolved === true` filter and `c.script.hasDynamicData === true` check correctly handle unresolvable / dynamic-properties cases by collapsing them to "unresolvable" — which falls back to the existing warning per the user's "no silent miss" rule.

### Data Shape Changes

**New fields on each `expressionRef`** (in `shared/wxml-symbol-extractor.mjs`):

| Field | Type | Meaning |
|---|---|---|
| `containingTag` | `string \| null` | Tag name housing the expression (e.g., `"local-bar"`); `null` if the expression is in a text node (`<view>{{x}}</view>`). |
| `containingAttribute` | `string \| null` | Attribute name housing the expression (e.g., `"locationError"`); `null` if in a text node or in an attribute on a structurally-special node like template. |

Both fields are derived during tree-sitter-wxml AST walks: from each `interpolation` node, walk up to find either an enclosing `attribute` → `element` chain (sets both fields) or just an enclosing `element` (text node — both fields stay `null`).

**No new fields on `fileModel`, no new fields on `graph.*`.**

## Decision Matrix

For each `expressionRef`, the diagnostic path follows:

| Case | id in parent scope | tag is child component | child resolved | child declares attr as property | Result |
|---|---|---|---|---|---|
| C1 | ✓ | — | — | — | **No diagnostic** (existing behavior) |
| C2 | ✗ | ✗ (built-in/unknown tag, OR text node, OR reserved attribute) | — | — | `missing-expression-ref` Warning (preserved) |
| C3 | ✗ | ✓ | ✗ (no using-components entry resolved, no JS, or `hasDynamicData=true`) | — | `missing-expression-ref` Warning (preserved — no silent miss) |
| C4 | ✗ | ✓ | ✓ | ✗ | `missing-expression-ref` Warning (preserved — truly dead, neither side has it) |
| C5 | ✗ | ✓ | ✓ | ✓ | **`dead-component-binding` Information** (new) |

The `inTemplateDefinition` short-circuit (refs inside `<template name="X">...</template>` are skipped because their scope resolves at the use site) takes precedence over the entire matrix. Template-fragment refs are unaffected by this change.

### Prefilter: which attributes count as "custom"

A `containingAttribute` is treated as a custom prop binding ONLY when:

- `containingTag !== null` (not a text node)
- `containingAttribute !== null`
- `containingTag` appears in `fileModel.components` (i.e., is a non-builtin tag declared in this file's WXML)
- `containingAttribute` is NOT in the reserved set OR reserved prefixes:
  - **Reserved set**: `wx:if`, `wx:elif`, `wx:else`, `wx:for`, `wx:for-item`, `wx:for-index`, `wx:key`, `class`, `style`, `id`, `slot`, `hidden`
  - **Reserved prefixes**: `bind:`, `catch:`, `mut-bind:`, `capture-bind:`, `capture-catch:`, `data-`, `generic:`

Everything else (text nodes, built-in tags, control-flow attrs on component tags, event attrs on component tags) falls through to the existing `missing-expression-ref` path unchanged.

## Severity Choice

LSP severity codes: 1=Error, 2=Warning, 3=Information, 4=Hint. `dead-component-binding` gets **3 (Information)**.

Rationale:
- 2 (Warning) would not differentiate this from `missing-expression-ref` — defeats the downgrade purpose.
- 4 (Hint) is typically rendered as subtle styling (different underline color) and often omitted from the Problems panel by clients. Too quiet for a category the developer should glance at and confirm.
- 3 (Information) shows in the Problems panel with its own section, has a distinct inline visual treatment in mainstream LSP clients (including Zed), and doesn't compete with Warning for visual urgency.

## Diagnostic Message

```
"X" is not defined in this file, but <local-bar> declares "locationError" as a property — the child will fall back to its default value. If you intended to pass a value, declare it in this page/component's data, properties, or setData.
```

Substitutions:
- `X` = the parent's expression identifier (`ref.name`)
- `<local-bar>` = the containing tag (`ref.containingTag`)
- `"locationError"` = the containing attribute name (`ref.containingAttribute`)

The message explicitly names both namespaces (parent identifier + child prop API) and the runtime behavior (default value fallback), so the developer can decide between "intended fallback" and "forgot to declare" without re-reading the WXML.

## Implementation Sketch

The existing `server/wxml-language-service.mjs` only declares `const WARNING = 2;` at the module top. The new diagnostic needs `const INFORMATION = 3;` added alongside it.

```js
// shared/wxml-symbol-extractor.mjs — inside the existing expression-ref emit loop:
// After computing { name, range, inTemplateDefinition }, walk the tree-sitter
// ancestor chain from the `interpolation` node to find the nearest enclosing
// attribute (sets containingTag + containingAttribute) or element (text node:
// both null).

// server/wxml-language-service.mjs — inside expressionRefDiagnostics:
const RESERVED_ATTRIBUTES = new Set([
  "wx:if", "wx:elif", "wx:else", "wx:for", "wx:for-item", "wx:for-index", "wx:key",
  "class", "style", "id", "slot", "hidden",
]);
const RESERVED_ATTRIBUTE_PREFIXES = [
  "bind:", "catch:", "mut-bind:", "capture-bind:", "capture-catch:", "data-", "generic:",
];

function isReservedAttribute(name) {
  if (RESERVED_ATTRIBUTES.has(name)) return true;
  return RESERVED_ATTRIBUTE_PREFIXES.some(prefix => name.startsWith(prefix));
}

function findChildProperty(graph, ownerWxmlGraphPath, childTag, attributeName) {
  const using = graph.usingComponents.find(
    c => c.owner === ownerWxmlGraphPath && c.tag === childTag && c.resolved
  );
  if (!using) return 'unresolvable';

  const childConfig = graph.configs.find(
    c => c.owner === using.target && c.script
  );
  if (!childConfig) return 'unresolvable';
  if (childConfig.script.hasDynamicData) return 'unresolvable';

  const declared = (childConfig.script.propertyKeys ?? [])
    .some(k => k.name === attributeName);
  return declared ? 'declared' : 'not-declared';
}

// Main loop modification (only the failure branch — success/short-circuit unchanged):
for (const ref of refs) {
  if (ref.inTemplateDefinition) continue;
  if (scope.has(ref.name)) continue;

  const isCrossComponentBinding =
    ref.containingTag !== null &&
    ref.containingAttribute !== null &&
    fileModel.components.some(c => c.tag === ref.containingTag) &&
    !isReservedAttribute(ref.containingAttribute);

  if (isCrossComponentBinding) {
    const status = findChildProperty(
      graph, documentGraphPath, ref.containingTag, ref.containingAttribute,
    );
    if (status === 'declared') {
      out.push({
        range: rangeFromSymbolRange(ref.range),
        severity: INFORMATION,
        source: "wxml-zed",
        code: "dead-component-binding",
        message: `"${ref.name}" is not defined in this file, but <${ref.containingTag}> declares "${ref.containingAttribute}" as a property — the child will fall back to its default value. If you intended to pass a value, declare it in this page/component's data, properties, or setData.`,
      });
      continue;
    }
    // status === 'not-declared' or 'unresolvable' → fall through
  }

  out.push({
    range: rangeFromSymbolRange(ref.range),
    severity: WARNING,
    source: "wxml-zed",
    code: "missing-expression-ref",
    message: `"${ref.name}" is not defined in the page/component data, wx:for scope, or any <wxs> module.`,
  });
}
```

## Edge Cases

| # | Scenario | Behavior |
|---|---|---|
| E1 | `<local-bar locationError="{{a}}-{{b}}">` (two refs in one attribute value) | Each ref evaluated independently. Both share `containingAttribute="locationError"`. Each falls C5 / C4 / C3 / C2 per matrix; diagnostics are emitted independently. |
| E2 | `<local-bar locationError="{{user.error}}">` | extractor takes root identifier `user`; lookup against attribute name `locationError`. C5 applies if `user` not in parent scope AND child declares `locationError`. |
| E3 | `<local-bar locationError="static-value">` | No interpolation, no expressionRef, no diagnostic. |
| E4 | `<local-bar generic:Item="MyItem">` | `generic:` prefix is reserved. Even if `MyItem` were a `{{...}}` expression and unresolved, prefilter falls through to existing rule. |
| E5 | `<local-bar wx:if="{{undef}}">` | `wx:if` is reserved. Existing `missing-expression-ref` warning. |
| E6 | `<local-bar bind:tap="handler">` | `bind:` prefix reserved AND this is event-handler territory anyway. New rule does not interfere. |
| E7 | Child uses `behaviors: [foo]` | `hasDynamicData = true` on child script. `findChildProperty` returns `'unresolvable'`. Falls C3 → warning. |
| E8 | Child uses wrapper factory `Fw.Component({...})` | Existing extractor unwraps. Lookup chain unchanged. |
| E9 | Child config exists but JS file missing | `script` is undefined. `findChildProperty` returns `'unresolvable'`. C3 → warning. |
| E10 | Child declares the name via setData, not via `properties:` | Lookup only inspects `propertyKeys`, not `dataKeys`. setData-injected keys are runtime data, not part of the child's public prop API. C4 → warning. Correct. |
| E11 | Child component not in usingComponents (typo'd tag or unregistered) | `using` lookup returns undefined. `findChildProperty` returns `'unresolvable'`. C3 → warning. The existing `missing-local-component` diagnostic on the component declaration also fires; both signals coexist. |
| E12 | Overriding a built-in tag in `usingComponents` (e.g., `view`) | `fileModel.components` does not include built-in tag names per current extractor. Prefilter fails. Falls to existing rule. Acceptable; this is rare and the worst outcome is "no downgrade, just current warning". |
| E13 | Identifier inside `<template name="X">...</template>` body | `inTemplateDefinition === true` short-circuits before the new logic runs. No diagnostic at all. |

## Test Plan

### Synthetic unit tests (`scripts/verify-wxml-language-service.mjs`)

Append to the existing synthetic-project test set. Each test sets up a parent + child WXML/JS pair and asserts the resulting diagnostics shape (codes, severities, messages).

| Test | Setup | Expected |
|---|---|---|
| T1 | parent: `<view class="{{undef}}">` | 1 × `missing-expression-ref` (C2) |
| T2 | parent: `<local-bar wx:if="{{undef}}">`, child registered | 1 × `missing-expression-ref` (C2 via reserved attr) |
| T3 | parent: `<local-bar data-foo="{{undef}}">`, child registered | 1 × `missing-expression-ref` (C2 via reserved prefix) |
| T4 | parent: `<local-bar generic:Item="{{undef}}">`, child registered | 1 × `missing-expression-ref` (C2 via reserved prefix) |
| T5 | parent: `<local-bar locationError="{{undef}}">`, child declares `locationError` property | 1 × `dead-component-binding` Information (C5 — happy path) |
| T6 | parent: `<local-bar locationError="{{undef}}">`, child does NOT declare `locationError` | 1 × `missing-expression-ref` (C4) |
| T7 | parent: `<local-bar locationError="{{undef}}">`, child config has no JS file | 1 × `missing-expression-ref` (C3 — child unresolvable) |
| T8 | parent: `<local-bar locationError="{{undef}}">`, child uses `behaviors: [foo]` so `hasDynamicData=true` | 1 × `missing-expression-ref` (C3) |
| T9 | parent: `<template name="x"><local-bar locationError="{{undef}}"/></template>`, child declares the prop | **No diagnostic** (inTemplateDefinition short-circuit precedence) |
| T10 | parent: `<local-bar locationError="{{userIsLost}}">`, child declares `locationError`, parent has neither `userIsLost` nor `locationError` | 1 × `dead-component-binding` (lookup by attribute name, NOT by identifier name — regression lock) |
| T11 | parent: `<local-bar locationError="{{a}}" otherProp="{{b}}">`, child declares only `locationError` | 1 × `dead-component-binding` (for `a`) + 1 × `missing-expression-ref` (for `b`) — same-tag independence |
| T12 | parent: `<local-bar bind:tap="handler">`, parent does not declare `handler` method | 1 × `missing-event-handler` warning — existing rule, not touched by this change |

### Extractor unit tests

Extend the wxml-symbol extraction tests (existing in `verify-wasm-symbol-baselines.mjs` infrastructure) to cover `containingTag` / `containingAttribute`:

- `<view>{{x}}</view>` → `containingTag=null, containingAttribute=null`
- `<view class="{{x}}">` → `containingTag="view", containingAttribute="class"`
- `<view><local-bar prop="{{x}}"/></view>` → `containingTag="local-bar", containingAttribute="prop"` (innermost wins)
- Self-closing `<local-bar prop="{{x}}"/>` → same as above

### Baseline regeneration

All `fixtures/wasm-spike/*-symbols-baseline.json` snapshots that include `expressionRefs` need regeneration. Each ref gains `containingTag` + `containingAttribute` (possibly null). Purely additive — no existing fields change.

### Real-project dogfood (`scripts/dump-project-diagnostics.mjs`)

Re-run on `mp-wx-chelaile/wx` after the implementation lands. Expected outcome:

- Total diagnostics: ≤ 26 (no new entries — the new code is a downgrade of existing entries, not an additional emission).
- `byCode["dead-component-binding"]`: 0 → N, where N ≤ 3 — depends on whether each of the 3 known cross-component samples has its child declaring the corresponding prop.
- `byCode["missing-expression-ref"]`: 19 → (19 − N).
- `byCode["missing-event-handler"]`: 7 → 7 (precision regression lock).

Hard gates for the dogfood verification: event-handler unchanged, total count not increased, dead-component-binding count > 0 OR a documented reason why all 3 fell to C4/C3.

## Acceptance Criteria

1. All existing tests pass (umbrella `bash scripts/verify-tree-sitter.sh`).
2. All 12 new synthetic cases (T1–T12) pass — each asserts exact code/severity/count.
3. Extractor tests confirm `containingTag` / `containingAttribute` populate correctly per the four shapes above.
4. `dump-project-diagnostics.mjs` on `mp-wx-chelaile/wx` shows:
   - `missing-event-handler` count unchanged from 7.
   - Total diagnostic count not increased.
   - `dead-component-binding` count ≥ 1 (i.e., at least one of the 3 known samples successfully downgrades).
5. The baseline regeneration diff is purely additive (no existing fields/values modified).

## Out of Scope (deferred to future plans)

- **Library-mediated setData** (P2.2-A): keys constructed via helper class indirection. Separate brainstorm.
- **Cross-component prop type checking**: child declares `locationError: { type: Boolean }`, parent passes `{{ "string" }}` — out of scope.
- **Required-property warnings**: child declares property without a default — should `<local-bar />` (no prop bound) warn? Out of scope (this is a different diagnostic).
- **Hover / Definition on child prop attributes**: jumping from `<local-bar locationError="...">` to child's `properties.locationError` declaration. The data needed is now available (lookup chain), but the LSP request handlers are not part of this round.
- **Quick-fix code action** "add to parent's data": diagnostic message hints at the fix in prose; structured action is deferred.
- **TypeScript siblings**: needs `tree-sitter-typescript.wasm`, separate plan.
