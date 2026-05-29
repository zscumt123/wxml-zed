# Monorepo split + Release CI — design

Date: 2026-05-29
Status: approved (brainstorming), pending spec review
Track: publish-readiness #4 (Zed marketplace)

## Goal

Make the repo publishable to the Zed marketplace and make the `src/lib.rs`
GitHub-Release download path real (the last unproven link in the publish track).
Two tightly-coupled halves shipped together in one spec/plan:

1. **Monorepo split** — move the Zed extension surface into a slim `packages/zed/`
   subdirectory so the marketplace submodule (`path = "packages/zed"`) exposes only
   the extension's required resources, while the repo root remains the LSP/tooling
   source that emits the Release.
2. **Release CI** — a GitHub Actions workflow that, on a `v*` tag, builds the LSP
   artifact and publishes it as a Release asset that `src/lib.rs` downloads.

## Context (grounded facts)

- `src/lib.rs` download branch calls `latest_github_release(LSP_REPO)`, derives the
  asset name `wxml-lsp-node-v<version>.tar.gz` from the release tag version
  (strip leading `v`), requires exactly one match, downloads + extracts as
  `GzipTar` into a work-dir-relative cache `wxml-lsp-node-<version>/`, entry =
  `wxml-lsp-node-<version>/wxml-lsp-node/server/wxml-lsp.mjs`.
- `LSP_REPO = "zscumt123/wxml-zed"` — **already points at this repo**; no backfill
  needed. The Release must live in this repo.
- `build-lsp-artifact.mjs` reads `ROOT/package.json` version (`0.3.0`), produces
  `dist/wxml-lsp-node/` and `dist/wxml-lsp-node-v<version>.tar.gz` (tar root entry
  = `wxml-lsp-node/`). Asset name + internal layout are end-to-end consistent with
  the `src/lib.rs` extract path. It operates only on `server/`/`scripts/`/`shared/`/
  `grammar/` + root license files — none of which move in the split.
- Both grammar wasms (`tree-sitter-wxml.wasm`, `tree-sitter-javascript.wasm`) are
  git-tracked → CI checkout has them, no `tree-sitter generate` needed.
- `package-lock.json` is tracked → CI can `npm ci`. Single runtime dep:
  `web-tree-sitter@0.25.10`.
- publish #2 dogfood proved wasm `is_file()` on arbitrary **absolute** paths is
  unreliable (Contingency C1 applied: local branch dropped the stat). The download
  branch still has two **work-dir-relative** `is_file()` calls (src/lib.rs:59, 71),
  never validated (no Release existed). They become validatable only after this step
  cuts a real Release.

## Topology decision

**Monorepo + slim `packages/zed/` subdirectory** (rejected: single-repo-submodule-at-root,
which drags `server/`/`scripts/`/`fixtures/`/`docs/` into the marketplace submodule and
invites a "extension must only include required resources" review objection; and dual-repo,
which forces cross-repo sync of `src/lib.rs`/version/README on every launch-logic change).

- Single GitHub repo `zscumt123/wxml-zed`: root = LSP/tooling source + Release emitter;
  `LSP_REPO` unchanged.
- Marketplace `extensions.toml` entry (deferred to step 4 PR) will use
  `submodule = "extensions/wxml-zed"` + `path = "packages/zed"` to point at the slim surface.

## §1 — Repo restructure (`git mv` into `packages/zed/`, single source of truth)

Move (NOT duplicate — two `extension.toml`s would drift) the extension surface:

```
packages/zed/
├── extension.toml        # grammar pin already → public repo fef7ea7; snippets path stays ./snippets/wxml.json
├── Cargo.toml + Cargo.lock
├── src/lib.rs
├── languages/wxml/       # config.toml, highlights.scm, injections.scm, outline.scm, brackets.scm, indents.scm, textobjects.scm
├── snippets/wxml.json
├── LICENSE               # copied from root (extension surface carries its own)
└── README.md             # new slim extension-facing README
```

Stays at root (dev/source repo + LSP artifact build inputs; deliberately NOT in the slim surface):
`server/` `scripts/` `shared/` `grammar/` `fixtures/` `docs/` `package.json` `package-lock.json`
root `LICENSE`/`NOTICE`/`THIRD_PARTY_NOTICES.md` root `README.md`.

- `build-lsp-artifact.mjs` is unaffected (reads `ROOT/package.json`; operates on root-resident
  dirs only). Verified by re-running `npm run build:lsp` + `verify-lsp-artifact.mjs` after the move.
- Build gate becomes `cargo build --manifest-path packages/zed/Cargo.toml --release
  --target wasm32-wasip1 --offline` (with `CARGO_TARGET_DIR="$PWD/target"`; avoids `cd`
  permission prompt).
- Drive-by fix: `packages/zed/Cargo.toml` version `0.2.0` → `0.3.0` to match `extension.toml`.
- Stale root build artifacts (`extension.wasm`, `target/`) handled: removed/relocated if tracked,
  otherwise already gitignored.

**Slim README** (`packages/zed/README.md`): what the extension does; **requires `node` on PATH**;
LSP is fetched from GitHub Release (not bundled); local-dev override via `WXML_ZED_LSP_ARTIFACT_DIR`.
This new slim README simply does NOT carry the over-cautious "needs upstream authorization" line;
license provenance is covered by the LICENSE/NOTICE already shipped. (Correcting that line in the
**root** README remains publish-track step 3 — out of scope this round.)

## §2 — Release CI (`.github/workflows/release.yml`)

Trigger on `push` of tags matching `v*.*.*`. `ubuntu-latest`, `permissions: contents: write`.

Steps:
1. `actions/checkout@v4`
2. `actions/setup-node@v4` with `node-version: '20'` (CI node only runs the copy+tar build;
   runtime node is the user's — version-insensitive here)
3. `npm ci`
4. **Tag-vs-version guard**: `PKG="v$(node -p "require('./package.json').version")"`;
   fail unless `GITHUB_REF_NAME == $PKG`. Prevents shipping a Release whose asset name
   `src/lib.rs`'s `latest_github_release` can never match.
5. `npm run build:lsp`
6. `gh release create "$GITHUB_REF_NAME" "dist/wxml-lsp-node-$GITHUB_REF_NAME.tar.gz"
   --title "$GITHUB_REF_NAME" --generate-notes` with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

Design points:
- `package.json` version is the single source of truth for the artifact version; tag =
  `v<version>`; asset name auto-derived by the build script. Three forced consistent via the guard.
- `gh release create` (runner built-in, zero extra third-party action / supply-chain surface).
- `GITHUB_TOKEN` is Actions built-in; no secret to configure.
- extension.toml version is mechanically independent of artifact version (extension always
  pulls `latest` release). Kept in lockstep by convention, not coupling.

## §3 — Download-branch `is_file()` pre-written contingency

Relative `is_file()` (WASI preopen) likely OK — different class from the absolute-path failure that
triggered C1 — so do NOT change it this round; keep the skeleton. Pre-write the patches into the plan
so the download dogfood applies them without improvising (the C1 process win):

- **C2-a (line 59 cache-hit misjudge)**: if relative entry `is_file()` also misfires → re-downloads
  every launch. Non-fatal (feature still works, just uncached). Fix: judge cache-hit by `cache_dir`
  directory existence (`read_dir` probe) or accept always-redownload.
- **C2-b (line 71 post-extract verify false-negative)**: **fatal** — extract succeeds but `is_file()`
  reports false → returns "artifact entry missing" → never launches. Fix: drop the post-extract stat
  (trust `download_file`'s Ok, same as C1; node reports its own launch failure).

Both are standby patches applied only if the download dogfood reproduces the misfire on these lines.

## §4 — In-repo work (this session) vs handed-to-user ops

**Agent does (commit to main):**
1. `git mv` restructure into `packages/zed/` + new slim README + Cargo version bump.
2. `.github/workflows/release.yml`.
3. Verify moved extension compiles: `cargo build --manifest-path packages/zed/Cargo.toml --release
   --target wasm32-wasip1 --offline` (with `CARGO_TARGET_DIR="$PWD/target"`).
4. Full offline verifier sweep (narrow-ranges, wasm-baselines, language-service, lsp-artifact,
   `npm run build:lsp`) to confirm the restructure didn't break the LSP source.
5. Plan carries the C2-a/C2-b standby contingencies.

**Handed to user (agent cannot push repo / cut Release — harness push block):**
1. **dogfood A (restructure)**: remove the old root-installed dev extension → reinstall from
   `packages/zed/` → confirm highlight/outline still work (grammar still public-repo fef7ea7;
   LSP still via `WXML_ZED_LSP_ARTIFACT_DIR` env or the expected 404). Validates only that the
   moved surface isn't broken.
2. **cut a test Release**: `git tag v0.3.0 && git push origin v0.3.0` → CI runs → confirm Release
   carries `wxml-lsp-node-v0.3.0.tar.gz`.
3. **dogfood B (download path)**: unset `WXML_ZED_LSP_ARTIFACT_DIR` → restart Zed → confirm the
   extension **downloads** the artifact from the Release and launches the LSP (F12 go-to-definition)
   → **watch src/lib.rs:59/71**; apply C2-a/C2-b if they misfire.

Marketplace PR (step 4) stays deferred; this structure is `path = "packages/zed"`-ready.

## Verification (agent-side automatic gates)

- `cargo build --manifest-path packages/zed/Cargo.toml --release --target wasm32-wasip1 --offline` → compiles.
- `bash scripts/verify-tree-sitter.sh` umbrella + `verify-wxml-narrow-ranges.mjs` (20),
  `verify-wasm-symbol-baselines.mjs` (8), `verify-wxml-language-service.mjs`,
  `verify-lsp-diagnostics.mjs --suite=graph-smoke` (21), `verify-lsp-artifact.mjs`, `npm run build:lsp` → all green.
- Workflow yaml lint via `actionlint` if available (else manual review).
- CI real run + download path are user-ops-validated (not agent-automatable).

## Out of scope / deferred

- marketplace PR to zed-industries/extensions (step 4).
- Multi-platform / Node-binary-free LSP distribution (large follow-up).
- Other grammar ecosystem coords (Cargo/pyproject/CMake/Make/go.mod) still → BlockLune.
- download-path hardening beyond C2 (cache_dir path-traversal guard, to_str vs to_string_lossy).
- Breadth axis: npm/plugin component support, TS sibling support.
