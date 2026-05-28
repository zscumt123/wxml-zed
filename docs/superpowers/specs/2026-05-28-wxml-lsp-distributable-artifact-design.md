# WXML LSP Distributable Artifact (publish-readiness #1) Design

## Goal

Turn the in-repo Node LSP into a **self-contained artifact that runs from any
unpacked directory, detached from the source repo** — the foundational
de-risking step of the Zed-marketplace publish track. Concretely: a packaging
script assembles the LSP's runtime closure (plus a vendored `web-tree-sitter`)
into `dist/wxml-lsp-node/`, tars it, and an offline smoke test proves
`node <unpacked>/server/wxml-lsp.mjs` serves the LSP correctly with **no
dependency on the repo's `node_modules` or repo-root layout**.

This is publish-readiness step #1 of a larger track. It deliberately does NOT
build the Zed extension side (download/cache/launch), split repos, automate
releases, or touch the grammar. Those follow once the artifact is proven to run
standalone — the single biggest unknown on the publish route.

## Why this shape (context)

Zed's publishing rules (verified against the official docs) state a language
server **"must not ship the language server as part of the extension"** — the
extension must download or detect it. So the LSP has to become an externally
distributable artifact. Before building any download glue, the gating unknown is
simply: *can this Node LSP run outside its repo at all?*

Investigation of the runtime found the LSP is a **three-entry, two-hop spawn
chain**, all relative-self-resolving:

```
server/wxml-lsp.mjs
  → spawns scripts/extract-wxml-project-graph.mjs   (execFile "node")
      → spawns scripts/extract-wxml-symbols.mjs      (execFileSync "node")
```

- `wxml-lsp.mjs` anchors paths on `EXTENSION_ROOT = dirname(server)/..` →
  `EXTENSION_ROOT/scripts/extract-wxml-project-graph.mjs` and
  `EXTENSION_ROOT/grammar/tree-sitter-wxml/tree-sitter-wxml.wasm`.
- The two spawned scripts resolve their siblings (`shared/*`, the next script)
  relative to their own `import.meta.url`.
- All three do `import { Parser } from "web-tree-sitter"` (a bare specifier), and
  `web-tree-sitter` loads its own core `tree-sitter.wasm` from inside its package.

Therefore, if the artifact **preserves the repo's relative structure**
(`server/`, `shared/`, `scripts/`, `grammar/tree-sitter-wxml/…wasm`) and vendors
`web-tree-sitter` under `node_modules/`, every path resolves **with zero code
changes**: `EXTENSION_ROOT` still lands on the artifact root, the wasm is at the
same relative path, the spawn chain self-resolves, and the bare import resolves
via the artifact's `node_modules`. The only thing missing today is that
`node_modules` is git-ignored and never travels.

A tidier `bin/` + `lib/wasm` layout would force simultaneous changes to the entry
path, wasm-locate, and spawn paths — more change, more risk. That cleanup (and
esbuild bundling, in-process extractor) is explicitly deferred; the
**repo-runtime-subset layout** is the low-risk first artifact.

## Artifact v1 layout (repo-runtime-subset)

```
wxml-lsp-node/
  server/
    wxml-lsp.mjs              # entry point
    wxml-language-service.mjs
    wxml-hover.mjs
    wxml-for-scope.mjs
  shared/                     # whole dir (small; avoids missing a transitive import)
    wxml-symbol-extractor.mjs
    js-method-extractor.mjs
    project-config.mjs
    wxml-builtins.mjs
    event-binding-patterns.mjs
    wxml-expression-helpers.mjs
  scripts/
    extract-wxml-project-graph.mjs
    extract-wxml-symbols.mjs
  grammar/
    tree-sitter-wxml/
      tree-sitter-wxml.wasm
  node_modules/
    web-tree-sitter/          # vendored package (incl. its tree-sitter.wasm + LICENSE)
  package.json                # minimal: name, version, "type":"module", web-tree-sitter dep
  LICENSE
  NOTICE
```

Entry point: `server/wxml-lsp.mjs`. The packaging script copies exactly the
runtime closure: the four `server/` modules, the whole `shared/` dir, ONLY the
two runtime `scripts/` (not the verifiers/profilers), the single grammar wasm,
and the `web-tree-sitter` package. The whole-`shared/` copy is a deliberate
simplicity-over-precision choice (6 small files) so no transitive import is
missed; the smoke test is the completeness guarantee regardless.

`dist/` is build output — git-ignored, never committed. The tarball
(`dist/wxml-lsp-node-v<version>.tar.gz`) is a release asset produced on demand.
Version is read from the root `package.json` `version` field (add `"0.3.0"`).

## The three deliverables (first round)

### 1. Packaging script — `scripts/build-lsp-artifact.mjs`

- Reads version from root `package.json`.
- Cleans/creates `dist/wxml-lsp-node/`.
- Copies the runtime closure listed above, preserving relative structure.
- Vendors `web-tree-sitter`: copy `node_modules/web-tree-sitter/` into the
  artifact's `node_modules/` (the package, with its `tree-sitter.wasm`,
  `package.json`, and `LICENSE`).
- Writes the minimal artifact `package.json` (name `wxml-lsp-node`, the version,
  `"type": "module"`, `dependencies: { "web-tree-sitter": "<pinned>" }`) and
  copies `LICENSE` + `NOTICE`.
- Produces `dist/wxml-lsp-node-v<version>.tar.gz` (the tar root is the
  `wxml-lsp-node/` dir).
- No code edits to `server/`, `shared/`, or `scripts/` (zero-change goal). If the
  smoke (deliverable 2) reveals a path that does NOT resolve standalone, the fix
  is preferred in the packaging script (include more files) rather than editing
  runtime code; any unavoidable runtime edit is flagged as a finding.

### 2. Offline standalone smoke — `scripts/verify-lsp-artifact.mjs`

Proves the artifact runs detached from the repo:

- Build the artifact (invoke deliverable 1, or assume `dist/` is fresh).
- Unpack the tarball into a fresh dir **under `$TMPDIR` (outside the repo
  subtree)** — this is the structural guarantee that no repo `node_modules` is
  reachable up the directory tree.
- Spawn `node <unpacked>/server/wxml-lsp.mjs` as a stdio LSP server **with cwd
  set outside the repo** (e.g. the unpacked dir or `$TMPDIR`).
- Drive a minimal LSP session over stdio JSON-RPC: `initialize` →
  `initialized` → open a WXML document (a small inline fixture or a copied
  sample) → assert a `textDocument/publishDiagnostics` (or a
  diagnostics/graph-smoke-level response) comes back correctly, proving the
  parser wasm loaded and the spawn chain ran. Reuse the existing stdio
  LSP-protocol harness from `scripts/verify-lsp-diagnostics.mjs` where practical,
  but pointed at the **unpacked artifact path** and a non-repo cwd.
- Exit non-zero with a clear message on any failure (no test framework; plain
  `assert`).

### 3. Repo-`node_modules` isolation guard

Confirm the running LSP resolved `web-tree-sitter` from the **artifact**, not the
repo:

- Primary guarantee: unpacking under `$TMPDIR` (deliverable 2) means there is no
  repo `node_modules` anywhere up the tree, so a successful run necessarily used
  the vendored copy.
- Belt-and-suspenders assertion: in the smoke, have the spawned server (or a tiny
  probe run from the unpacked entry) report `import.meta.resolve("web-tree-sitter")`
  and assert the resolved path is **under the unpacked dir**, not under the repo.
  (If `import.meta.resolve` is awkward to surface from the live server, an
  acceptable alternative is a one-line probe script placed beside the entry that
  prints the resolved path, run from the unpacked dir.)

## Non-Goals (explicitly deferred)

- esbuild bundling / single-file LSP.
- `bin/wxml-lsp` tidy layout, wasm relocation to `lib/`.
- In-process refactor of the extractor (removing the subprocess hops).
- `src/lib.rs` changes / Zed download-cache-launch glue.
- GitHub Release automation / CI.
- Separate slim extension repo / grammar public repo / marketplace PR.
- De-Node / self-contained binary.
- README/license-caveat fixes (a later publish-readiness step).

## Testing

- `node scripts/build-lsp-artifact.mjs` produces `dist/wxml-lsp-node/` + the
  tarball without error.
- `node scripts/verify-lsp-artifact.mjs` is green: unpacks under `$TMPDIR`, runs
  the LSP from the unpacked entry with a non-repo cwd, completes an
  initialize+diagnostics exchange, and asserts `web-tree-sitter` resolved under
  the unpacked dir.
- The existing full verifier suite (narrow-ranges, wasm baselines,
  language-service, graph-smoke, umbrella) stays green — this round adds files
  (a build script + a verifier + `dist/` gitignore + a `version` in
  package.json) and does not modify runtime code.
- `.gitignore` gains `/dist`.

## Acceptance Criteria

1. A packaging script produces `dist/wxml-lsp-node/` in the repo-runtime-subset
   layout above plus `dist/wxml-lsp-node-v<version>.tar.gz`, with no edits to
   `server/`/`shared/`/`scripts/` runtime code.
2. The artifact contains the full runtime closure + vendored `web-tree-sitter`
   (with its `tree-sitter.wasm`) + the grammar wasm + minimal `package.json` +
   `LICENSE`/`NOTICE`.
3. The offline smoke runs `node <unpacked>/server/wxml-lsp.mjs` from a `$TMPDIR`
   location outside the repo, with a non-repo cwd, and completes an
   `initialize` + diagnostics exchange successfully.
4. The smoke asserts the running LSP resolves `web-tree-sitter` from the unpacked
   artifact, not the repo `node_modules`.
5. `dist/` is git-ignored; the existing verifier suite stays green; no runtime
   code changed (or any unavoidable change is explicitly surfaced).
6. None of the deferred items (esbuild, bin/lib, in-process extractor,
   `src/lib.rs`, Release automation, repo split, grammar repo) are touched.
