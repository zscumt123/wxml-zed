# WXML Project Graph Scope v2 Design

## Goal

Extend the WXML project graph so the current LSP features work with two common
mini program project structures:

- global `app.json` `usingComponents`;
- `app.json` `subPackages` / `subpackages` pages.

This is a graph-scope slice. It should not add a new LSP capability type.
Instead, existing diagnostics and go-to-definition should become correct for
pages discovered through subpackages and components declared globally in
`app.json`.

## Non-Goals

- Do not resolve npm package components.
- Do not resolve `plugin://` components.
- Do not implement `componentGenerics`.
- Do not implement independent-subpackage component isolation rules.
- Do not add completion, hover, references, rename, semantic tokens, code
  actions, formatting, or file watching.
- Do not change the WXML grammar or Tree-sitter query files.
- Do not move feature logic into `server/wxml-lsp.mjs`.

## Current Baseline

`scripts/extract-wxml-project-graph.mjs` currently:

- reads `app.json`;
- discovers pages from the top-level `pages` array;
- reads page and component JSON files;
- resolves local relative `usingComponents` declared directly by each page or
  component JSON file;
- traverses resolved component configs and WXML import/include dependencies;
- emits repo-relative graph paths consumed by `server/wxml-language-service.mjs`.

The current graph does not:

- read `app.json.usingComponents`;
- apply global components to page or component owners;
- discover pages from `subPackages` or `subpackages`.

Because diagnostics and component go-to-definition use `graph.usingComponents`
by `owner`, missing global components are invisible to current LSP behavior.

## Scope

Included:

- Add fixture coverage for a global component declared in `app.json`.
- Add fixture coverage for at least one subpackage page.
- Support local root-absolute component paths that start with `/`, resolving
  them relative to the mini program project root.
- Expand global `app.json` components into effective per-owner
  `usingComponents` entries so existing language-service lookup can keep using
  the current `owner + tag` contract.
- Preserve owner-local override behavior: a page or component JSON
  `usingComponents` entry with the same tag overrides the app-global entry for
  that owner.
- Discover subpackage page WXML and JSON files and include them in
  `graph.pages`, `graph.configs`, `graph.wxml`, and verification.
- Prove current diagnostics and component go-to-definition work for a
  subpackage page that uses an app-global component.

Excluded:

- New graph schema version.
- A separate global-components array.
- Runtime interpretation of `independent: true`.
- Full WeChat component visibility semantics for plugins, npm packages, or
  generics.

## Fixture Shape

Extend `fixtures/miniprogram/` with:

```text
fixtures/miniprogram/
  app.json
  components/global-badge/global-badge.json
  components/global-badge/global-badge.wxml
  components/local-badge/local-badge.json
  components/local-badge/local-badge.wxml
  packages/shop/pages/list/list.json
  packages/shop/pages/list/list.wxml
```

Required fixture behavior:

- `app.json` declares global `usingComponents`:
  - `global-badge` -> `/components/global-badge/global-badge`
- `app.json` declares a subpackage:
  - `root`: `packages/shop`
  - `pages`: `[ "pages/list/list" ]`
- `packages/shop/pages/list/list.wxml` uses `<global-badge />`.
- `packages/shop/pages/list/list.json` can be empty or declare
  `usingComponents: {}`.
- `pages/home/home.json` declares a local `usingComponents` override:
  - `global-badge` -> `../../components/local-badge/local-badge`
- `pages/home/home.wxml` uses `<global-badge />` immediately after
  `<missing-card reason="{{emptyReason}}" />` so tests can prove local config
  overrides the app-global component for that owner without changing the
  existing `missing-card` diagnostic range.

## Graph Semantics

### Page Discovery

`graph.pages[]` continues to use:

```json
{
  "name": "pages/home/home",
  "json": "fixtures/miniprogram/pages/home/home.json",
  "wxml": "fixtures/miniprogram/pages/home/home.wxml"
}
```

For top-level pages, `name` remains the raw entry from `app.json.pages`.

For subpackage pages, `name` should be the root-prefixed page path:

```json
{
  "name": "packages/shop/pages/list/list",
  "json": "fixtures/miniprogram/packages/shop/pages/list/list.json",
  "wxml": "fixtures/miniprogram/packages/shop/pages/list/list.wxml"
}
```

Rules:

- Accept both `subPackages` and `subpackages`.
- Ignore malformed subpackage entries whose `root` is not a string or whose
  `pages` is not an array.
- For each valid subpackage entry, join `root` and each string page entry with
  POSIX-style `/`.
- Collect pages in this order: top-level `pages`, `subPackages`, then
  `subpackages`.
- De-duplicate by root-prefixed page `name`; the first occurrence wins.
- Missing subpackage page WXML or JSON files should be recorded as existing
  page unresolved entries using the same `kind: "page"` and
  `reason: "missing-file"` convention.

### Effective usingComponents

The graph should continue to emit `usingComponents[]` entries that are scoped to
one concrete WXML owner:

```json
{
  "owner": "fixtures/miniprogram/packages/shop/pages/list/list.wxml",
  "tag": "global-badge",
  "value": "/components/global-badge/global-badge",
  "target": "fixtures/miniprogram/components/global-badge/global-badge.wxml",
  "config": "fixtures/miniprogram/components/global-badge/global-badge.json",
  "resolved": true
}
```

Rules:

- Read app-global component declarations from `app.json.usingComponents`.
- For every page or component config owner that is read, merge:
  1. app-global `usingComponents`;
  2. owner-local `usingComponents`.
- Owner-local declarations override app-global declarations with the same tag.
- Resolve each effective entry against the config file that declared it:
  - app-global entries resolve relative to `app.json`;
  - owner-local entries resolve relative to the owner JSON file.
- Local relative values beginning with `./` or `../` continue to resolve
  relative to the declaring JSON file.
- Local root-absolute values beginning with `/` resolve relative to the mini
  program project root.
- Emit only the effective entry for each `owner + tag`.
- Preserve the existing unresolved behavior:
  - unsupported non-local values produce `resolved: false` and
    `reason: "unsupported"`;
  - missing local targets produce `reason: "missing-file"`;
  - outside-root local targets produce `reason: "outside-root"`;
  - unresolved component declarations are also present in `graph.unresolved`.

This owner-expanded model is intentionally chosen so
`server/wxml-language-service.mjs` does not need to understand global component
scope. It can continue matching component definitions by `owner` and `tag`.

### Traversal

Resolved effective component targets should be queued exactly like existing
owner-local components:

- resolved component WXML files appear in `graph.wxml`;
- resolved component JSON configs appear in `graph.configs`;
- nested component configs are read and receive the same app-global merge
  behavior;
- WXML import/include dependency traversal remains unchanged.

The graph should stay deterministic:

- `graph.configs` sorted by path;
- `graph.usingComponents` sorted by owner, tag, and value;
- `graph.unresolved` sorted by existing rules;
- `graph.wxml` sorted by path.

## LSP Behavior

No new LSP methods are required.

Existing `textDocument/definition` should work for:

- a subpackage page using an app-global component;
- a main-package owner using a local component declaration that overrides an
  app-global declaration with the same tag.

Existing diagnostics should work for:

- components used in subpackage pages;
- unresolved effective components after app-global and owner-local merge.

For this fixture, opening `packages/shop/pages/list/list.wxml` should publish an
empty diagnostics array because its only custom component usage resolves through
the app-global declaration. The existing `missing-card` diagnostic in
`pages/home/home.wxml` should remain unchanged.

The LSP host remains responsible only for protocol IO, graph scheduling, and
delegation. Global component and subpackage semantics belong in
`scripts/extract-wxml-project-graph.mjs` and are consumed through the existing
language-service boundary.

## Testing

Project graph verification in `scripts/verify-tree-sitter.sh` must cover:

- `graph.pages` includes `packages/shop/pages/list/list`;
- `graph.configs` includes the subpackage page JSON;
- `graph.configs` includes global and local badge component JSON files;
- `graph.wxml` includes the subpackage page WXML;
- `graph.wxml` includes global and local badge component WXML files;
- `graph.usingComponents` contains the app-global `global-badge` effective
  entry for the subpackage page owner;
- `graph.usingComponents` contains the local override `global-badge` entry for
  the chosen main-package owner;
- the override owner does not also emit the app-global `global-badge` entry.

Direct language-service verification must cover:

- `getDefinition()` on `<global-badge>` inside the subpackage page resolves to
  `fixtures/miniprogram/components/global-badge/global-badge.wxml`;
- `getDefinition()` on `<global-badge>` inside `pages/home/home.wxml` resolves to
  `fixtures/miniprogram/components/local-badge/local-badge.wxml`;
- `getDiagnostics()` on the subpackage page returns no diagnostics;
- existing home-page diagnostics and definition tests remain green.

Protocol-level LSP verification must cover:

- opening the subpackage page builds the graph and publishes zero diagnostics;
- `textDocument/definition` from the subpackage page `<global-badge>` resolves
  to the global badge component;
- existing root initialization and component definition scenarios remain green.

The total verification script must continue to pass:

```sh
scripts/verify-tree-sitter.sh
```

## Documentation

After implementation, update `README.md` to state that the project graph
supports:

- top-level `app.json.pages`;
- `app.json.subPackages` / `subpackages`;
- local relative page/component `usingComponents`;
- app-global `usingComponents` expanded into page/component owner scope.

The README must continue to mark npm components, plugin components,
`componentGenerics`, file watching, completion, hover, references, rename, and
production packaging as unsupported.
