# Zed Extension — External LSP Launch (publish-readiness #2) Design

## Goal

Rewrite the Zed extension's `language_server_command` (`src/lib.rs`) so it launches
the **external** LSP artifact instead of the in-repo `server/wxml-lsp.mjs`. This is
the step that aligns the extension with Zed's rule that a language server must not
ship inside the extension. This round proves the **local-artifact launch path** in
real Zed (the dev mechanism) and writes the **GitHub-Release download/cache path as
a skeleton** (not validated end-to-end yet — there is no public repo/release to
pull from). The non-compliant in-repo direct launch is removed.

## Why this shape (context)

publish-readiness #1 produced a self-contained artifact (`dist/wxml-lsp-node/`,
proven to run detached from the repo). What's missing for marketplace is the
extension side: download/detect the artifact and launch it. The biggest engineering
risk worth retiring now — without any outward-facing ops (no public repo, no
release, no push) — is simply: *can the Zed extension launch an external unpacked
artifact at all?* So this round makes the local-artifact path the dogfood-validated
mechanism and codes the download path's structure behind it.

The in-repo launch (`CARGO_MANIFEST_DIR/server/wxml-lsp.mjs`) is removed, not kept
as a fallback: it is precisely the Zed-forbidden "bundled language server" path,
and keeping it would let dogfood look green while actually exercising the
non-publishable path — polluting the very validation this round exists to do.

`zed_extension_api` 0.7.0 provides everything needed (verified against the vendored
crate's WIT): `worktree.shell_env()`, `worktree.which()`, `latest_github_release`,
`download_file(url, dir, DownloadedFileType::GzipTar)` (downloads AND extracts),
and `set_language_server_installation_status`.

## Launch resolution order (`language_server_command`)

1. **Local artifact (dev; highest priority).** If `WXML_ZED_LSP_ARTIFACT_DIR` is
   present in `worktree.shell_env()`, treat its value as the artifact **root** and
   require `$WXML_ZED_LSP_ARTIFACT_DIR/server/wxml-lsp.mjs` to exist. If it exists,
   launch `node <dir>/server/wxml-lsp.mjs`. If the env var is set but the entry is
   missing, fail with the error below (do NOT silently fall through to download) —
   a set-but-wrong env is a user mistake worth surfacing.
   - **Artifact-root only this round.** The value must satisfy
     `$DIR/server/wxml-lsp.mjs` directly; no outer-dir auto-detection (kept
     unambiguous for dogfood + docs).
2. **GitHub Release download/cache (skeleton; not validated end-to-end).** With no
   env var: `latest_github_release("<owner>/<repo>", { require_assets: true,
   pre_release: false })` → from `release.assets` pick the one whose `name` matches
   `wxml-lsp-node-v*.tar.gz` → if the version's cache dir does not already exist,
   `set_language_server_installation_status(Downloading)` and
   `download_file(asset.download_url, "wxml-lsp-node-<version>", GzipTar)` (extracts
   into a work-dir-relative versioned cache dir; existing dir = cache hit, skip) →
   launch `node <cache>/wxml-lsp-node/server/wxml-lsp.mjs`. `<owner>/<repo>` is a
   placeholder constant (e.g. `zscumt123/wxml-zed`), adjusted when the real public
   repo is decided. This path is allowed to fail cleanly when no release exists; it
   is not dogfood-validated this round.
3. **Neither available → clear error** (return `Err`):
   ```
   WXML LSP artifact not found. Set WXML_ZED_LSP_ARTIFACT_DIR to an unpacked wxml-lsp-node artifact, or publish a GitHub Release containing wxml-lsp-node-v*.tar.gz.
   ```

`node` is still required: resolve it via `worktree.which("node")` (keep the
existing "node must be available on PATH" error if absent). The launched `Command`
keeps `env: worktree.shell_env()` as today.

## Cache layout (no change to the artifact/tarball)

The publish-#1 tarball root stays `wxml-lsp-node/` (its smoke depends on that — do
not change it). The download path extracts into a glue-owned **versioned** dir
`wxml-lsp-node-<version>/`, so the launched entry is
`wxml-lsp-node-<version>/wxml-lsp-node/server/wxml-lsp.mjs`. The version in the dir
name is the cache key: a present dir means "already downloaded this version", so
the glue skips re-download. The extra nesting (`<versioned>/wxml-lsp-node/…`) is the
deliberate consequence of not repackaging the tarball this round.

## Validation model (this round is dogfood-gated, not verifier-gated)

`src/lib.rs` compiles to `extension.wasm` and only runs inside Zed via
`zed_extension_api`, so there is no offline Node verifier for it. Quality gates:

1. **`cargo build --release --target wasm32-* ` (or the project's normal extension
   build) compiles cleanly** — the Rust + the new API calls type-check.
2. **Manual real-Zed dogfood checklist** (recorded in spike-notes after):
   - `node scripts/build-lsp-artifact.mjs` → unpack the tarball to a local dir, e.g.
     `/tmp/wxml-lsp-node` (so `/tmp/wxml-lsp-node/server/wxml-lsp.mjs` exists).
   - `export WXML_ZED_LSP_ARTIFACT_DIR=/tmp/wxml-lsp-node` in the shell **Zed will
     inherit** (launch Zed from that terminal, or set it where `worktree.shell_env()`
     picks it up — see caveat).
   - Install/reload the dev extension in Zed; open a real mini-program WXML file.
   - Confirm the LSP starts and a JS-backed feature works (diagnostics / go-to-
     definition), and **confirm via the launched command / Zed logs that the entry
     is the artifact path, NOT the in-repo `server/wxml-lsp.mjs`.**
   - Unset the env → confirm the clear error (or the download-skeleton attempt with a
     graceful failure since no release exists), NOT a silent in-repo launch.

**Dogfood caveat (worth documenting):** `worktree.shell_env()` reflects the shell
environment Zed was launched with. GUI-launched Zed on macOS may not inherit a var
set only in an interactive shell — launch Zed from the terminal that has the export,
or put it in a login profile, so the var is visible.

## Scope / Non-Goals

- **Touch only `src/lib.rs`** (the launch logic) plus a short README/notes addition
  documenting `WXML_ZED_LSP_ARTIFACT_DIR` and the Node prerequisite.
- Do NOT modify the LSP code, `scripts/build-lsp-artifact.mjs`, the artifact
  layout/tarball, or `scripts/verify-lsp-artifact.mjs`.
- Do NOT split repos, automate GitHub Releases, or validate the download path
  end-to-end (deferred until a real public repo + release exist).
- Do NOT change `extension.toml`'s grammar pointer (separate publish step).
- No de-Node / binary-ization. Node stays a documented prerequisite.

## Acceptance Criteria

1. `src/lib.rs` resolves the LSP command in the order: (1) `WXML_ZED_LSP_ARTIFACT_DIR`
   (artifact-root; requires `$DIR/server/wxml-lsp.mjs`), (2) GitHub Release
   download/cache skeleton, (3) the exact error message above. The in-repo
   `CARGO_MANIFEST_DIR/server/wxml-lsp.mjs` launch is removed.
2. A set-but-invalid `WXML_ZED_LSP_ARTIFACT_DIR` (no `server/wxml-lsp.mjs` under it)
   produces the clear error, not a fall-through and not an in-repo launch.
3. The download path uses `latest_github_release` + `download_file(..., GzipTar)`
   into a versioned cache dir with a cache-hit skip and an installation-status
   progress call; it may fail cleanly when no release exists (not validated e2e).
4. `node` is still resolved via `worktree.which("node")` with the existing
   absent-node error; the launched command keeps `worktree.shell_env()`.
5. The extension compiles. Real-Zed dogfood confirms the local-artifact path
   launches the **external** artifact (not the in-repo server) and a JS-backed
   feature works; the negative (no env) does not silently launch the in-repo server.
6. Only `src/lib.rs` (+ README/notes) changed; LSP/build/smoke/artifact untouched;
   no repo split or release automation.
