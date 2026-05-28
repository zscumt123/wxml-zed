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
   env var, run this lifecycle (with the installation-status transitions of §"Install
   status" below):
   - `latest_github_release("<owner>/<repo>", { require_assets: true,
     pre_release: false })`. `<owner>/<repo>` is a placeholder constant (e.g.
     `zscumt123/wxml-zed`), adjusted when the real public repo is decided.
   - **Exact asset selection.** Compute the expected name from the release version
     using the build script's convention — `format!("wxml-lsp-node-v{}.tar.gz", ver)`
     where `ver` is `release.version` with any leading `v` stripped (so a tag of
     `0.3.0` or `v0.3.0` both yield `wxml-lsp-node-v0.3.0.tar.gz`). Select assets
     whose `name` **equals** that string; require **exactly one** match. Zero or
     multiple matches → the actionable error (below). (A glob like
     `wxml-lsp-node-v*.tar.gz` is rejected: future releases may carry checksums /
     debug / older assets and a glob could pick the wrong one.)
   - **Cache key is the entry file, not the dir.** The cache dir is
     `wxml-lsp-node-<ver>/` (work-dir-relative). It is a **cache hit only if
     `wxml-lsp-node-<ver>/wxml-lsp-node/server/wxml-lsp.mjs` exists** — a bare/partial
     dir (half-finished download or failed extract) is NOT a hit. On a miss, remove
     any stale dir and `download_file(asset.download_url, "wxml-lsp-node-<ver>",
     GzipTar)` (downloads + extracts).
   - Launch `node <cache>/wxml-lsp-node/server/wxml-lsp.mjs`.
   This path is allowed to fail cleanly when no release exists; it is not
   dogfood-validated this round.
3. **Neither available / any download-path failure → one actionable error**
   (return `Err`). Never leak a raw `zed_extension_api` error string to the user as
   the whole message; wrap it as the actionable instruction with the original cause
   appended:
   ```
   WXML LSP artifact not found. Set WXML_ZED_LSP_ARTIFACT_DIR to an unpacked wxml-lsp-node artifact, or publish a GitHub Release containing wxml-lsp-node-v*.tar.gz.
   ```
   When the failure has an underlying cause (no release, asset not found / not
   unique, download or extract failed), append `\n  cause: <raw error>` so the
   actionable line stays first and the diagnostic detail is preserved.

`node` is still required: resolve it via `worktree.which("node")` (keep the
existing "node must be available on PATH" error if absent). The launched `Command`
keeps `env: worktree.shell_env()` as today.

## Install status (full lifecycle, download path only)

Drive `set_language_server_installation_status` through a complete cycle so Zed's
UI never sticks on a stale "downloading". The 0.7.0 WIT exposes `none`,
`checking-for-update`, `downloading`, and `failed(string)`:

- Before querying the release: `CheckingForUpdate`.
- On a cache miss, before `download_file`: `Downloading`.
- On success (cache hit OR after a successful download), before returning the
  command: `None`.
- On any failure in this path: `Failed(<cause>)` immediately before returning the
  `Err` (so the UI shows the failure, not a frozen "downloading").

The local-artifact path (resolution order #1) does no network work and needs no
status transitions.

## Cache layout (no change to the artifact/tarball)

The publish-#1 tarball root stays `wxml-lsp-node/` (its smoke depends on that — do
not change it). The download path extracts into a glue-owned **versioned** dir
`wxml-lsp-node-<version>/`, so the launched entry is
`wxml-lsp-node-<version>/wxml-lsp-node/server/wxml-lsp.mjs`. The cache key is **that
entry file's existence**, not merely the dir's — a present-but-incomplete dir (half
download / failed extract) is treated as a miss, the stale dir is removed, and the
download re-runs. The extra nesting (`<versioned>/wxml-lsp-node/…`) is the deliberate
consequence of not repackaging the tarball this round.

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
3. The download path: `latest_github_release` → select **exactly one** asset named
   exactly `wxml-lsp-node-v<ver>.tar.gz` (no glob) → `download_file(..., GzipTar)`
   into a versioned cache dir, where **cache-hit is gated on the entry file
   `…/wxml-lsp-node/server/wxml-lsp.mjs` existing** (stale/partial dir = miss, re-download)
   → drive `set_language_server_installation_status` CheckingForUpdate → Downloading
   → None, with `Failed(<cause>)` on error. Any failure surfaces the actionable
   error (raw cause appended, not leaked as the whole message). Allowed to fail
   cleanly when no release exists (not validated e2e this round).
4. `node` is still resolved via `worktree.which("node")` with the existing
   absent-node error; the launched command keeps `worktree.shell_env()`.
5. The extension compiles. Real-Zed dogfood confirms the local-artifact path
   launches the **external** artifact (not the in-repo server) and a JS-backed
   feature works; the negative (no env) does not silently launch the in-repo server.
6. Only `src/lib.rs` (+ README/notes) changed; LSP/build/smoke/artifact untouched;
   no repo split or release automation.
