# WXML Project Graph Baseline Design

Date: 2026-05-12

## Goal

Define a small, deterministic project-level graph for WXML mini program
projects before building LSP behavior.

The current baseline can parse explicit WXML files and emit a syntax-level
dependency and symbol model. The next useful layer is a project graph that
answers:

- Which WXML pages are declared by `app.json`?
- Which page or component JSON files declare `usingComponents`?
- Which local component tags resolve to component WXML files?
- Which WXML-level template, include, import, and WXS dependencies exist after
  project discovery?
- Which local component declarations are unresolved?

This phase should create the project graph contract and fixture-level
verification harness. Later work can reuse this graph for go-to-definition,
diagnostics, completion, or an LSP process.

## Current State

Existing project capabilities:

- `scripts/extract-wxml-symbols.mjs` accepts explicit `.wxml` file paths and
  emits deterministic JSON for WXML dependencies, symbols, template references,
  and custom component candidates.
- `scripts/verify-tree-sitter.sh` verifies grammar behavior, queries, snippets,
  real-world fixtures, and the WXML symbol model.
- There is no fixture mini program project with `app.json`, page JSON files, or
  component JSON files.
- There is no project-level scanner or `usingComponents` resolver.

The missing piece is a graph that connects configuration JSON and WXML syntax
models without starting a language server.

## Scope

Included:

- Add a fixture mini program project under `fixtures/miniprogram/`.
- Define a JSON-compatible project graph model.
- Add a local script that reads a project root, parses `app.json`, page JSON,
  component JSON, and discovered WXML files, then emits deterministic JSON.
- Reuse `scripts/extract-wxml-symbols.mjs` for WXML file structure instead of
  creating a second WXML parser.
- Resolve local relative `usingComponents` paths to component WXML files when
  safe.
- Preserve unresolved local component declarations in the graph.
- Add verification assertions to `scripts/verify-tree-sitter.sh`.
- Document the project graph boundary in README.

Excluded:

- Zed LSP integration.
- Rust extension work.
- Watch mode or incremental indexing.
- Node package, plugin, or absolute mini program component resolution.
- WeChat `plugin://` components.
- `componentPlaceholder`.
- `componentGenerics`.
- `subPackages` and `packages`.
- `.wxss`, `.js`, `.ts`, `.wxs`, and `.json` semantic validation beyond the
  fields explicitly needed by the graph.
- Diagnostics UI or editor navigation.
- File existence checks outside the fixture root.
- Cross-project workspace scanning.

## Fixture Shape

Add a small project fixture:

```text
fixtures/miniprogram/
  app.json
  pages/home/home.json
  pages/home/home.wxml
  pages/detail/detail.json
  pages/detail/detail.wxml
  components/user-card/user-card.json
  components/user-card/user-card.wxml
  components/status-badge/status-badge.json
  components/status-badge/status-badge.wxml
  shared/header.wxml
  templates/common.wxml
  utils/format.wxs
```

Required fixture behavior:

- `app.json` declares `pages/home/home` and `pages/detail/detail`.
- `pages/home/home.json` declares local `usingComponents`:
  - `user-card` -> `../../components/user-card/user-card`
  - `missing-card` -> `../../components/missing-card/missing-card`
- `components/user-card/user-card.json` declares:
  - `status-badge` -> `../status-badge/status-badge`
- `pages/home/home.wxml` uses `<user-card />`, `<missing-card />`, an
  `import`, an `include`, a `template is`, and an external `wxs`.
- `components/user-card/user-card.wxml` uses `<status-badge />`.
- `pages/detail/detail.wxml` should be present to prove page discovery handles
  more than one page.

## Model Shape

The model should be JSON and deterministic:

```json
{
  "version": 1,
  "root": "fixtures/miniprogram",
  "pages": [],
  "configs": [],
  "wxml": [],
  "usingComponents": [],
  "unresolved": []
}
```

### Pages

Each `pages` entry:

```json
{
  "name": "pages/home/home",
  "json": "fixtures/miniprogram/pages/home/home.json",
  "wxml": "fixtures/miniprogram/pages/home/home.wxml"
}
```

Rules:

- Page names come from `app.json` `pages`.
- Page WXML and JSON paths are derived by appending `.wxml` and `.json`.
- Missing page files are recorded in `unresolved`; they do not stop extraction.
- Page order should follow `app.json`.

### Configs

Each `configs` entry:

```json
{
  "path": "fixtures/miniprogram/pages/home/home.json",
  "owner": "fixtures/miniprogram/pages/home/home.wxml",
  "kind": "page"
}
```

Rules:

- `kind` is `app`, `page`, or `component`.
- `owner` is omitted for `app`.
- Page configs are discovered from `app.json`.
- Component configs are discovered from resolved local `usingComponents`.

### usingComponents

Each `usingComponents` entry:

```json
{
  "owner": "fixtures/miniprogram/pages/home/home.wxml",
  "tag": "user-card",
  "value": "../../components/user-card/user-card",
  "target": "fixtures/miniprogram/components/user-card/user-card.wxml",
  "config": "fixtures/miniprogram/components/user-card/user-card.json",
  "resolved": true
}
```

Rules:

- `owner` is the page or component WXML file whose JSON config declared the
  component.
- `tag` is the `usingComponents` key.
- `value` is the literal JSON value.
- Local relative values beginning with `./` or `../` are resolved against the
  owner JSON directory and normalized to a WXML target.
- If a local relative value omits an extension, append `.wxml` and `.json` for
  target paths.
- Resolved entries include `target`, `config`, and `resolved: true`.
- If the target WXML file exists but the target JSON config is missing, the
  component entry is still resolved, omits `config`, and traversal stops there.
- Unresolved local entries include `resolved: false` and a `reason`.
- Non-local values are preserved as unresolved with `reason: "unsupported"`.
- Unresolved component declarations appear in both `usingComponents` and
  `unresolved` so consumers can inspect declarations without joining arrays.

### WXML

Each `wxml` entry embeds the existing single-file model:

```json
{
  "path": "fixtures/miniprogram/pages/home/home.wxml",
  "dependencies": [],
  "symbols": [],
  "references": [],
  "components": []
}
```

Rules:

- WXML entries should be produced by the existing symbol extractor.
- WXML files include declared pages, resolved component targets, and the
  transitive closure of WXML dependencies discovered from `import` and `include`
  when they resolve to local `.wxml` files under the fixture root.
- External `wxs` dependencies remain dependency entries on the owning WXML
  model. This phase records their paths but does not parse `.wxs` files.
- Missing WXML files should not be passed to the symbol extractor.
- The graph should sort WXML entries by path for deterministic output.

### Unresolved

Each `unresolved` entry:

```json
{
  "kind": "component",
  "owner": "fixtures/miniprogram/pages/home/home.wxml",
  "tag": "missing-card",
  "value": "../../components/missing-card/missing-card",
  "target": "fixtures/miniprogram/components/missing-card/missing-card.wxml",
  "reason": "missing-file"
}
```

Rules:

- `kind` is initially `page`, `component`, or `wxml-dependency`.
- Missing local component WXML files use `reason: "missing-file"`.
- Unsupported non-local component values use `reason: "unsupported"`.
- Missing pages use `kind: "page"`.
- Missing local WXML dependencies use `kind: "wxml-dependency"`.
- Unresolved entries are data only; this phase does not surface diagnostics.

## Extraction Approach

Recommended file:

- `scripts/extract-wxml-project-graph.mjs`

The script should:

1. Accept a project root directory:

   ```bash
   node scripts/extract-wxml-project-graph.mjs fixtures/miniprogram
   ```

2. Read `app.json` with the Node standard library.
3. Derive page JSON and WXML paths from `app.json` `pages`.
4. Read page/component JSON files when present.
5. Resolve local relative `usingComponents`.
6. Traverse resolved component configs breadth-first or depth-first, with a
   visited set to avoid cycles.
7. Maintain a WXML work queue initialized with existing page WXML files and
   resolved component target WXML files.
8. Call `scripts/extract-wxml-symbols.mjs` for queued WXML files, merge the
   resulting file models into the project graph, then inspect their `import` and
   `include` dependencies.
9. Add existing local `.wxml` dependencies whose normalized paths stay inside
   the project root back into the WXML queue until no new WXML file remains.
10. Record missing local WXML dependencies in `unresolved` with
    `kind: "wxml-dependency"`.
11. Emit sorted, stable JSON.

The script may shell out to the existing extractor in this phase. A later
refactor can share JavaScript functions directly if the scripts start to grow
too much duplication.

## Path Rules

- All graph paths are relative to the repository root and use POSIX separators.
- The `root` value is also relative to the repository root.
- Local resolution never escapes the project root. Paths that would escape the
  root are `unresolved` with `reason: "outside-root"`.
- Local component values must start with `./` or `../`.
- Values with explicit `.wxml` or `.json` extensions are normalized by replacing
  the extension as needed for target/config paths.
- Values without an extension derive both `.wxml` and `.json` paths.

## Verification Contract

Extend `scripts/verify-tree-sitter.sh` to run:

```bash
node "$ROOT_DIR/scripts/extract-wxml-project-graph.mjs" "$ROOT_DIR/fixtures/miniprogram" >/tmp/wxml-zed-project-graph.json
```

Assertions should verify:

- `version === 1`.
- `root === "fixtures/miniprogram"`.
- Pages include `pages/home/home` and `pages/detail/detail`.
- Configs include `app.json` with `kind: "app"`.
- Configs include home and detail page JSON files with `kind: "page"`.
- Configs include user card and status badge JSON files with
  `kind: "component"`.
- Home page `usingComponents` resolves `user-card` to
  `fixtures/miniprogram/components/user-card/user-card.wxml`.
- User card `usingComponents` resolves `status-badge` to
  `fixtures/miniprogram/components/status-badge/status-badge.wxml`.
- `missing-card` appears in `unresolved` with `reason: "missing-file"`.
- WXML models include home page, detail page, user card, status badge, shared
  header, and common template files.
- The home page WXML model includes an external `wxs` dependency pointing to
  `fixtures/miniprogram/utils/format.wxs`.
- Home page WXML model includes a `template` reference and `user-card` component
  candidate.
- Built-in tags do not appear as component candidates.

Run the full script after implementation:

```bash
scripts/verify-tree-sitter.sh
```

## README Contract

README should document:

- The project graph script.
- The fact that it is a pre-LSP static model.
- Supported inputs: `app.json`, page/component JSON, local relative
  `usingComponents`, existing WXML symbol extraction.
- Explicit exclusions: npm/plugin components, `subPackages`, diagnostics,
  watch mode, LSP, and editor navigation.

## Risks and Constraints

- The project graph depends on the CST-based WXML symbol extractor. If the
  Tree-sitter CLI output format changes, both scripts can be affected.
- The model intentionally treats unresolved entries as data rather than errors.
  Verification must assert unresolved entries so this behavior remains stable.
- Component discovery can create cycles. The implementation must track visited
  config or WXML paths.
- Fixture paths must stay small and explicit. This phase should not become a
  general mini program project analyzer.

## Acceptance Criteria

- `fixtures/miniprogram/` contains a representative mini program fixture.
- `scripts/extract-wxml-project-graph.mjs fixtures/miniprogram` emits valid,
  deterministic JSON.
- The graph includes pages, configs, resolved `usingComponents`, WXML file
  models, and unresolved local components.
- `scripts/verify-tree-sitter.sh` asserts the project graph contract.
- README describes the project graph boundary.
- No LSP, diagnostics UI, watch mode, package component resolution, or
  marketplace publishing changes are introduced.
