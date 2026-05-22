# Config-Driven Data Injectors — Design

**Status:** spec drafted, awaiting user review before plan.

**One-line summary:** Add a project-level `wxml-zed.config.json` mechanism that declares helper-class data-injection patterns (`new ClassName(literal).method(this)` shape). When the JS extractor encounters a matching call site inside an owner-context function body, the produces-template's substituted identifiers are merged into the page's `dataKeys` with `source: "injector"`. v1 is deliberately narrow: only direct `new X(string-literal).method(this)` expression shape matches (whitespace/newlines are insignificant — the matcher is AST-shape-based, not line-based).

## Background

P2 round 1 (setData walker) + P2.2-B (cross-component prop binding) brought `mp-wx-chelaile/wx` from 220 → 26 diagnostics. The 7 surviving `missing-expression-ref` warnings classified into:
- 2 helper-mediated `load_state` (this round's target)
- 4 inside `wx:if` reserved attribute (correctly NOT downgraded per design)
- 1 Taro compiled template-fragment

The 2 helper-mediated warnings are concrete shape:

```js
// pages/components/states-view/States.js
class States {
  constructor(name, states, defaultState) {
    this.stateName = name + '_state';     // computed at runtime
    this.statesName = name + '_states';
  }
  applyTo(page) {
    page.setData({ ...this.data() });     // spread of computed-key object
  }
  applyStateTo(page) { page.setData({ ...this.state() }); }
  applyStatesTo(page) { page.setData({ ...this.states() }); }
}

// pages/components/states-view/LoadStates.js (extends States)
// ... default state values inlined via super(...)

// pages/main/fav-page/index.js
this.loadStates = new LoadStates('load', LOAD_STATES.LOADING).applyTo(this);
```

```wxml
<!-- pages/main/fav-page/index.wxml -->
<states-view ... class="{{load_state === LOAD_STATES.EMPTY ? 'fav-constainer' : ''}}">
```

The page's WXML uses `{{load_state}}` (and `{{load_states}}` elsewhere) but the page's static `data: {}` block doesn't declare them; the setData walker can't follow `applyTo`'s indirection through `States.applyTo`. Result: `missing-expression-ref` warning at the `class` attribute (where the prop-binding rule's reserved-attr prefilter correctly leaves the warning intact).

This pattern is used by 8+ chelaile pages (always with `name = 'load'`) — but P2 round 1 + P2.2-B cleared most because they reference `{{load_state}}` only in contexts where the cross-component binding rule applied. The 2 surviving warnings are specifically on pages where the reference sits inside reserved attributes (`class="{{load_state === ...}}"`), where neither rule fires.

## Goal

Add a project-level config mechanism that declares helper-class data-injection patterns. After lookup matches, the page's runtime data keys are known statically (via config-declared template substitution), and the existing `expressionRefDiagnostics` finds them in scope.

The fix is config-driven, not pattern-hardcoded — so future projects with similar helper-class conventions can opt in with one config entry per class, without code changes to wxml-zed.

## Non-Goals

This release deliberately defers the following to v2 (each enumerated explicitly here so the implementer doesn't over-engineer):

- **Multi-statement instance construction**: `const x = new X('a'); x.method(this);`. Recognition requires variable flow tracking, out of scope.
- **Non-literal constructor arguments**: `new X(variableName).method(this)`, `new X(\`prefix_${x}\`).method(this)`, etc.
- **Chained method calls on existing instances**: `this.loadStates.state(X).applyStateTo(this)`. v1 only matches `new`-rooted expressions.
- **Inheritance auto-recognition**: config lists `States` but code uses `LoadStates extends States`. v1 requires both class names listed explicitly in config.
- **Import alias resolution**: `import LS from './LoadStates'; new LS(...)` — v1 matches against the local identifier `LS`, not the imported source. User must align config with the actual identifier used at the call site.
- **Parenthesized new expressions**: `(new X('a')).m(this)` — v1 requires direct AST shape, no extra parens.
- **Optional chaining**: `new X('a')?.m?.(this)` — out of scope.
- **Namespaced constructor**: `new ns.X('a').m(this)` — constructor must be a simple identifier.
- **Dedicated config watcher**: the LSP server already watches `**/*.json` via its existing `workspace/didChangeWatchedFiles` registration (see `server/wxml-lsp.mjs` `WATCH_REGISTRATION_GLOBS` + `GRAPH_AFFECTING_EXTENSIONS`). Saving `wxml-zed.config.json` triggers a project graph rebuild via the same path as `usingComponents`/component-json changes — no separate watcher is needed. This is NOT a v2 deferral; it is the intended behavior and works out of the box.

## Architecture

Two extension points:

1. **`scripts/extract-wxml-project-graph.mjs`** — new `loadProjectConfig(projectRoot)` reads and validates `wxml-zed.config.json`. Result threads through to `extractMethods` as `options.dataInjectors`.

2. **`shared/js-method-extractor.mjs`** — new `matchInjectorCall` helper detects `new X(literal-args).method(this)` shape; new `walkOwnerFunctionForInjectors` sibling walker (mirrors the existing `walkOwnerFunctionForSetData` boundary logic) traverses owner-context function bodies looking for matches. Matched calls produce identifier keys (after template substitution) which merge into the existing `dataKeys` array with `source: "injector"`.

No new LSP capabilities. No graph schema changes (just additional dataKey entries on existing scripts). LSP overlay path is unaffected since the overlay only re-parses WXML (`collectFile`), not JS.

### Lookup Direction

For `new LoadStates('load', LOAD_STATES.LOADING).applyTo(this)`:

- **Class name** comes from the `new` expression's constructor identifier (`LoadStates`).
- **Method name** comes from the chained `.method` (`applyTo`).
- **Constructor arg substitution map** comes from the first N positional args (where N = `constructorArgs.length` in config), each required to be a string literal. Subsequent args are unconstrained but ignored.

The injector matches `(className, methodName)` against config; the substitution map then drives produces-template resolution.

### Data Flow

```
extract-wxml-project-graph.mjs
  ├── loadProjectConfig(projectRoot)
  │   → { dataInjectors: [normalized entries] }
  ├── for each script file:
  │   extractMethods(parser, source, { dataInjectors })
  │     ├── existing data-block extraction (dataKeys with source:"data")
  │     ├── existing setData walker (additional source:"setData" keys)
  │     └── NEW: walkOwnerFunctionForInjectors (additional source:"injector" keys)
  └── writes graph; each script.dataKeys is the union of three sources
```

Merge order: data block first, setData walker second, injector walker third. Each step dedups by name against existing entries. Source field records the first contributor.

## Config

### File Location

`<projectRoot>/wxml-zed.config.json` — same directory as `app.json`. One per project.

If the file doesn't exist, the loader returns `{ dataInjectors: [] }` silently. No diagnostic, no warning.

### Schema

```json
{
  "dataInjectors": [
    {
      "className": "LoadStates",
      "constructorArgs": ["name"],
      "methods": {
        "applyTo": ["${name}_state", "${name}_states"],
        "applyStateTo": ["${name}_state"],
        "applyStatesTo": ["${name}_states"]
      }
    }
  ]
}
```

Field semantics:

- **`className`** (string, required) — exact identifier as it appears at the call site's `new` expression. NOT the import source path.
- **`constructorArgs`** (string[], required, MUST be non-empty for v1) — names for positional constructor args. Each must be a valid JS identifier (matches `IDENTIFIER_SHAPE`). v1 requires at least one constructor arg because the matched call's `nameRange` (used by `getDefinition`) points at the first constructor literal's range. An empty `constructorArgs` would leave no defensible `nameRange` and break the "go to definition" path; the niche use case of "inject static keys with zero constructor args" can be expressed via the page's own `data: {}` block instead. Validation: empty `constructorArgs` → `stderr` warn + skip the entry.
- **`methods`** (object, required, at least one entry) — keys are method names; values are produces-template arrays. Each template string may contain `${argName}` placeholders that reference names in `constructorArgs`.

### Validation

Performed once at config load (graph build time). Failures log to stderr and skip the offending entry, not the whole config:

| # | Condition | Action |
|---|---|---|
| C1 | File doesn't exist | Silent; return empty injectors |
| C2 | File exists but JSON parse fails | `stderr` warn; return empty injectors |
| C3 | Top-level `dataInjectors` missing | Treat as empty (not an error) |
| C4 | Entry has no `className` or it's not a string | `stderr` warn; skip entry |
| C5 | Entry has no `methods` or `methods` is empty | `stderr` warn; skip entry |
| C6 | `constructorArgs` is missing, empty (`[]`), or contains a non-identifier name | `stderr` warn; skip entry |
| C7 | `methods.<name>` value is not a string array | `stderr` warn; skip entry |
| C8 | Same `className` appears in two entries | Both entries kept; their methods merge at lookup time (additive) |

`stderr` warn format: `[wxml-zed] <reason>: <config-path>`. Example: `[wxml-zed] dataInjectors[2]: className must be a non-empty string: /path/wxml-zed.config.json`.

## Decision Matrix (Match Logic)

For each `call_expression` node inside an owner-context function body, `matchInjectorCall(callNode, dataInjectors)` returns either matched keys or `null`.

| # | Condition | Required for match |
|---|---|---|
| 1 | `callNode.type === "call_expression"` | yes |
| 2 | `callNode.function` is `member_expression` | yes |
| 3 | `member_expression.object` is `new_expression` | yes |
| 4 | `new_expression.constructor` is `identifier` | yes (rejects `new ns.X(...)`, `new X.Y(...)`) |
| 5 | `member_expression.property` is `property_identifier` | yes |
| 6 | `callNode.arguments` has exactly 1 named child, type `this` | yes |
| 7 | Some `dataInjectors` entry has `className === <ctorIdentifier text>` AND `methods` contains `<methodName>` | yes |
| 8 | `new_expression.arguments` has at least `constructorArgs.length` named children | yes |
| 9 | First N constructor args (N = `constructorArgs.length`) are ALL `string` type with extractable `string_fragment` | yes |

If all 9 hold:

- Build substitution map `{ <constructorArgs[i]>: <literal text> }` for i in [0, N).
- For each produces template in `methods[methodName]`:
  - Run `applyTemplate(template, subst)` — replaces `${argName}` with corresponding literal; returns `null` if any `${argName}` is missing from `subst`, OR if template contains an unclosed `${`.
  - If result is `null`, skip that key (no diagnostic; config-side issue).
  - If result doesn't match `IDENTIFIER_SHAPE`, skip that key (e.g., literal containing `-`).
  - Otherwise push `{ name: <result>, nameRange: <first literal's range>, source: "injector" }`.

`nameRange` points at the first constructor literal's range (e.g., the `'load'` string fragment's range inside `new LoadStates('load', ...)`). All produces keys from one match share this range — useful for future Hover/Definition.

## Walker Implementation (sibling pattern)

The new `walkOwnerFunctionForInjectors(funcNode, sink, dataInjectors)` mirrors the existing `walkOwnerFunctionForSetData`:

- Visits each `call_expression` descendant of `funcNode`.
- Stops at nested function-rebinding boundaries: `function_expression`, `function_declaration`, `method_definition`, `generator_function`, `generator_function_declaration`.
- Descends into `arrow_function` (lexical this).
- For each visited call expression, runs `matchInjectorCall`. If match, push keys into the shared `sink.keys` array.

Sink shape: `{ keys: [...] }`. No `dynamic` flag (v1 never escalates to `hasDynamicData = true` — see below).

`hasDynamicData` is NOT affected by injector logic. The merge step dedups by name; if injector tries to add a name already in dataKeys (from data block or setData walker), the injector entry is silently dropped.

## Wiring into `extractMethods`

Modify the existing function to accept an `options` parameter:

```js
export function extractMethods(parser, source, options = {}) {
  const dataInjectors = options.dataInjectors ?? [];

  // ... existing extraction (sets `methods`, `hasDynamicMethods`, `dataKeys`,
  //     `propertyKeys`, `hasDynamicData`)

  // After the existing setData walker block has populated dataKeys:
  if (dataInjectors.length > 0) {
    // Reuse the EXISTING setData walker's enumeration of owner-context
    // functions — same helpers (`functionValuedPairs`, `methodsBlockOf`,
    // `namedObjectBlock`, `propertyObservers`), same coverage:
    //   Page: every top-level function-valued pair
    //   Component: top-level legacy lifecycle + methods + lifetimes +
    //              pageLifetimes + observers + properties.<X>.observer
    // The injector walker runs the same per-function iteration in parallel
    // (same outer loop already established by the setData walker block).
    const injectorSink = { keys: [] };
    for (const fn of <owner-context functions, identical iteration to setData walker>) {
      walkOwnerFunctionForInjectors(fn, injectorSink, dataInjectors);
    }
    // Single dedup-merge against existing dataKeys (data block + setData):
    const existingNames = new Set(dataKeys.map((k) => k.name));
    for (const key of injectorSink.keys) {
      if (!existingNames.has(key.name)) {
        existingNames.add(key.name);
        dataKeys.push(key);
      }
    }
  }

  return { methods, hasDynamicMethods, dataKeys, propertyKeys, hasDynamicData };
}
```

The "owner-context function" enumeration matches the existing setData walker: Page top-level functions; Component top-level lifecycle, methods block, lifetimes/pageLifetimes/observers blocks, properties.<X>.observer.

## Schema Addition

`dataKey` entries gain `"injector"` as a valid `source` value. Existing valid values: `"data"`, `"setData"`. After this release: `"data"`, `"setData"`, `"injector"`. `propertyKey.source` is unchanged (`"property"` only).

Verify-js-script-info's structural assertion must update its valid-source set:

```js
assert(
  entry.source === "data" || entry.source === "setData" || entry.source === "injector",
  ...
);
```

## Edge Cases

### Walker-level

| # | Scenario | Behavior |
|---|---|---|
| W1 | Multiple matches in same function (different first args) | All keys union; no dedup within injector results (dedup happens at merge into dataKeys) |
| W2 | Same match repeated in same function (same first arg, same method) | Dedup by name during merge into dataKeys (first occurrence wins) |
| W3 | Match inside nested arrow callback (e.g., `setTimeout(() => new X('a').m(this))`) | Match (arrow inherits `this` lexically) |
| W4 | Match inside nested regular function (e.g., `setTimeout(function () { new X('a').m(this); })`) | Skip (boundary check rejects, same as setData walker) |
| W5 | Match inside generator function | Skip (boundary check) |
| W6 | `new X('a').m(this).chain()` (chained call after match) | Inner match still detected when walker visits the inner `call_expression` node; outer chain's receiver isn't `this` so outer doesn't match. Net effect: inner keys injected correctly. |

### AST-level (non-matches)

| # | Form | Reason |
|---|---|---|
| A1 | `(new X('a')).m(this)` | Extra parens change AST shape |
| A2 | `new X?.('a')?.m?.(this)` | Optional chaining |
| A3 | `new X.Y('a').m(this)` | Namespaced constructor |
| ~~A4~~ | ~~spread in args~~ | (removed — `...rest` in position ≥ N is irrelevant per the "first N args are checked, subsequent ignored" rule; spread in position < N naturally fails the "must be `string` type" check at that position) |
| A5 | `new X(variable).m(this)` | First arg not a string literal |
| A6 | `new X(\`tmpl_${x}\`).m(this)` | Template literal, not a plain string literal |
| A7 | `new X('a').m()` | Wrong arg count (receiver requirement fails) |
| A8 | `new X('a').m(notThis)` | Receiver not `this` |
| A9 | `new X('a').m(this, other)` | Receiver arg count fails (must be exactly 1) |

### Config-level

| # | Scenario | Behavior |
|---|---|---|
| F1 | Config file missing | Silent; behaves like P2.2-B's existing behavior |
| F2 | `produces` template references unknown `${unknown}` | Template returns null; that key skipped; other keys in same `produces` array still emit |
| F3 | `produces` template result fails IDENTIFIER_SHAPE (e.g., `"with-dash"`) | Skip that key; other produces unaffected |
| F4 | `methods` has empty produces array `[]` | Match succeeds; injects zero keys (effectively a no-op for that method; useful for sentinels) |
| F5 | Two entries with same `className` | Both apply; methods accumulate |

### Interaction with three-source dedup

| # | Scenario | Result |
|---|---|---|
| D1 | Static `data: { load_state: null }` + injector produces `load_state` | `load_state` enters via data block (source: "data"); injector dropped |
| D2 | `this.setData({ load_state: 'x' })` in a method + injector produces `load_state` | setData walker enters first (source: "setData"); injector dropped |
| D3 | Both data block AND setData walker miss; injector produces `load_state` | Enters via injector (source: "injector") |

## Test Plan

### Level 1: Synthetic unit tests (`scripts/verify-js-script-info.mjs`)

Add ~12 cases exercising the matcher and walker through synthetic source strings. Each case includes explicit `dataKeySources` map for exact source-tag validation.

| # | source (abbrev) | injectors config | expected dataKeys |
|---|---|---|---|
| J1 | `Page({ data: {}, onLoad() { new LoadStates('load').applyTo(this); } })` | LoadStates ⇒ applyTo ⇒ ["${name}_state","${name}_states"] | `["load_state","load_states"]` (both source:"injector") |
| J2 | Same source as J1 | `[]` (no injectors) | `[]` |
| J3 | `new LoadStates('foo').applyTo(this); new LoadStates('bar').applyTo(this)` in one method | LoadStates injector | `["foo_state","foo_states","bar_state","bar_states"]` |
| J4 | `new LoadStates(name).applyTo(this)` (variable arg) | LoadStates injector | `[]` |
| J5 | `new LoadStates('load').applyTo(otherPage)` (receiver not this) | LoadStates injector | `[]` |
| J6 | `new LoadStates('load').otherMethod(this)` | LoadStates injector (no otherMethod in methods) | `[]` |
| J7 | `new OtherClass('load').applyTo(this)` | LoadStates injector | `[]` |
| J8 | `data: { load_state: null }` + `new LoadStates('load').applyTo(this)` | LoadStates injector | `["load_state","load_states"]` (load_state source:"data", load_states source:"injector") |
| J9 | `methods: { reload() { setTimeout(() => new LoadStates('load').applyTo(this), 0); } }` | LoadStates injector | `["load_state","load_states"]` (arrow inherits this) |
| J10 | `methods: { reload() { setTimeout(function () { new LoadStates('load').applyTo(this); }); } }` | LoadStates injector | `[]` (regular function boundary blocks) |
| J11 | `new X('a').m(this)` | X ⇒ m ⇒ ["${unknown}_x","${name}_ok"] (unknown undeclared) | `["a_ok"]` (only the valid template result) |

### Level 2: Config loader unit test

Either extend `scripts/verify-wxml-language-service.mjs` or create a tiny `scripts/verify-project-config-loading.mjs`. Verify:

- C-L1: Missing file → returns `{ dataInjectors: [] }` without error
- C-L2: Malformed JSON → returns empty, writes stderr warn
- C-L3: Valid full config → returns normalized injectors with all fields preserved
- C-L4: Mixed valid + invalid entries → invalid entries skipped (with stderr warn), valid entries returned
- C-L5: Entry with empty `constructorArgs: []` → skipped with stderr warn (v1 requires non-empty constructorArgs)

### Level 3: Real-project dogfood

Add (temporarily, NOT committed to chelaile) `wxml-zed.config.json` to `/Users/zs/Desktop/zs_work/mp-wx-chelaile/wx/`:

```json
{
  "dataInjectors": [
    {
      "className": "LoadStates",
      "constructorArgs": ["name"],
      "methods": {
        "applyTo": ["${name}_state", "${name}_states"],
        "applyStateTo": ["${name}_state"],
        "applyStatesTo": ["${name}_states"]
      }
    },
    {
      "className": "States",
      "constructorArgs": ["name"],
      "methods": {
        "applyTo": ["${name}_state", "${name}_states"],
        "applyStateTo": ["${name}_state"],
        "applyStatesTo": ["${name}_states"]
      }
    }
  ]
}
```

Then dump → expected acceptance gates:

- Total: 26 → 24 (clears the 2 surviving `load_state` warnings)
- `missing-event-handler`: 7 → 7 unchanged
- `missing-expression-ref`: 7 → 5
- `dead-component-binding`: 12 → 12 (unchanged; no impact on cross-component path)

Remove config file after the dogfood capture (it's not part of our project; just for verification).

## Acceptance Criteria

1. All existing tests pass (`bash scripts/verify-tree-sitter.sh` → `wxml-zed tree-sitter verification passed`).
2. 11 new synthetic cases (J1–J11) pass in `verify-js-script-info.mjs` with exact dataKey + dataKeySources matching.
3. Config loader unit tests pass (5 cases C-L1 to C-L5).
4. The 47+11 = 58 total cases in verify-js-script-info pass; structural source-validity assertion now accepts `"injector"` as a valid value.
5. Real-project dogfood on chelaile (with the temporary config above):
   - total count: 26 → 24
   - `missing-event-handler` unchanged at 7
   - 2 surviving `load_state` warnings clear (verified by re-sampling the survivor list)
6. Documentation: this spec committed; Outcome section added to plan after implementation; spike-notes follow-up added.

## Out of Scope (deferred to future plans / vNext)

Listed earlier in **Non-Goals**. Specifically:

- Multi-statement instance construction (variable flow)
- Non-literal constructor arguments
- Chained method calls on existing instances
- Inheritance auto-recognition
- Import alias resolution
- Parenthesized new expressions
- Optional chaining in match path
- Namespaced constructors
- (Config file watching is handled by the existing JSON watcher — see Non-Goals; not an explicit v2 candidate.)

Each is a clear v2 candidate but not required to meaningfully eliminate the helper-class noise pattern observed in real chelaile use.
