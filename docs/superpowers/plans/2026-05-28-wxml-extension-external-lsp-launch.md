# Zed Extension — External LSP Launch (publish-readiness #2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the extension's `language_server_command` to launch the external LSP artifact (env-pointed local dir now; GitHub-Release download/cache skeleton for later), removing the Zed-forbidden in-repo direct launch.

**Architecture:** One Rust file (`src/lib.rs`). Resolution order: (1) `WXML_ZED_LSP_ARTIFACT_DIR` → `node <dir>/server/wxml-lsp.mjs`; (2) GitHub Release download/cache skeleton with a full install-status lifecycle (coded, not e2e-validated this round); (3) one actionable error. Quality gate is `cargo build` to wasm (the extension only runs inside Zed, so functional validation is manual real-Zed dogfood, listed at the end).

**Tech Stack:** Rust → `wasm32-wasip1`, `zed_extension_api` 0.7.0 (verified APIs: `worktree.shell_env()`/`which()`, `latest_github_release`, `download_file(GzipTar)`, `set_language_server_installation_status`).

**Spec:** `docs/superpowers/specs/2026-05-28-wxml-extension-external-lsp-launch-design.md`

**BUILD COMMAND (used as the gate in every task):**
```bash
CARGO_TARGET_DIR="$PWD/target" cargo build --release --target wasm32-wasip1 --offline
```
The `CARGO_TARGET_DIR` override is REQUIRED: the machine's `~/.cargo/config` points the default target dir at `/Users/zs/cargo_targe_dir`, which is outside the sandbox-writable paths and fails with `Operation not permitted`. The repo's `target/` is git-ignored and writable. `--offline` works because deps are already in the cargo cache + `Cargo.lock`.

---

## File Structure

- **Modify** `src/lib.rs` — the entire `language_server_command` logic (the only code change). [Task 1 + Task 2]
- **Modify** `README.md` — a short note documenting `WXML_ZED_LSP_ARTIFACT_DIR` + the Node prerequisite + the GUI-shell-env caveat. [Task 1]

No other file changes. The LSP code, `scripts/build-lsp-artifact.mjs`, the artifact/tarball, and `scripts/verify-lsp-artifact.mjs` are untouched.

---

## Task 1: Local-artifact launch + remove in-repo launch + clear error

**Files:**
- Modify: `src/lib.rs`
- Modify: `README.md`

- [ ] **Step 1: Rewrite `src/lib.rs`**

Replace the ENTIRE contents of `src/lib.rs` with:
```rust
use std::path::Path;

use zed_extension_api as zed;

const ARTIFACT_DIR_ENV: &str = "WXML_ZED_LSP_ARTIFACT_DIR";
const NOT_FOUND_ERROR: &str = "WXML LSP artifact not found. Set WXML_ZED_LSP_ARTIFACT_DIR to an unpacked wxml-lsp-node artifact, or publish a GitHub Release containing wxml-lsp-node-v*.tar.gz.";

struct WxmlExtension;

impl WxmlExtension {
    /// Look up a variable in the worktree's shell environment.
    fn shell_env_var(worktree: &zed::Worktree, key: &str) -> Option<String> {
        worktree
            .shell_env()
            .into_iter()
            .find(|(k, _)| k.as_str() == key)
            .map(|(_, v)| v)
    }
}

impl zed::Extension for WxmlExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        let node = worktree
            .which("node")
            .ok_or_else(|| "node must be available on PATH to run the WXML LSP".to_string())?;

        // (1) Local artifact (dev). Highest priority: the env value is the artifact
        // ROOT and must contain server/wxml-lsp.mjs. A set-but-invalid value is a
        // user mistake — surface it; do NOT fall through to download or the repo.
        if let Some(dir) = Self::shell_env_var(worktree, ARTIFACT_DIR_ENV) {
            let entry = Path::new(&dir).join("server").join("wxml-lsp.mjs");
            if entry.is_file() {
                return Ok(zed::Command {
                    command: node,
                    args: vec![entry.to_string_lossy().into_owned()],
                    env: worktree.shell_env(),
                });
            }
            return Err(format!(
                "{NOT_FOUND_ERROR}\n  cause: {ARTIFACT_DIR_ENV}={dir} has no server/wxml-lsp.mjs"
            ));
        }

        // (2) GitHub Release download/cache — added in Task 2.

        // (3) Neither available.
        Err(NOT_FOUND_ERROR.to_string())
    }
}

zed::register_extension!(WxmlExtension);
```

(Note the in-repo `env!("CARGO_MANIFEST_DIR").join("server")...` launch is gone — that was the Zed-forbidden bundled-server path.)

- [ ] **Step 2: Build to wasm — verify it compiles**

Run:
```bash
CARGO_TARGET_DIR="$PWD/target" cargo build --release --target wasm32-wasip1 --offline
```
Expected: `Finished \`release\` profile`, exit 0. If a `zed_extension_api` name mismatches (e.g. `shell_env` signature), fix per the compiler error — the vendored crate at `~/.cargo/registry/src/*/zed_extension_api-0.7.0/` is the source of truth.

- [ ] **Step 3: Document the env var + prerequisites in README**

In `README.md`, add a short subsection (place it near the existing Develop/Project-Layout material — find a sensible spot with `grep -n "## " README.md`). Add:
```markdown
### Running the LSP (development)

The WXML language server is distributed as a separate artifact (`wxml-lsp-node`),
not bundled in the extension. For local development, point the extension at an
unpacked artifact:

1. Build it: `node scripts/build-lsp-artifact.mjs`, then unpack
   `dist/wxml-lsp-node-v<version>.tar.gz` somewhere, e.g. `/tmp/wxml-lsp-node`.
2. Set `WXML_ZED_LSP_ARTIFACT_DIR` to the unpacked artifact **root** (the directory
   that directly contains `server/wxml-lsp.mjs`):
   `export WXML_ZED_LSP_ARTIFACT_DIR=/tmp/wxml-lsp-node`.
3. Launch Zed from that shell (so the extension's `worktree.shell_env()` sees the
   variable — a GUI-launched Zed may not inherit a var set only in an interactive
   shell), then reload the dev extension.

Requirements: `node` must be on `PATH`. Without the env var set, the extension
falls back to downloading the artifact from a GitHub Release (not yet published),
and errors clearly if neither is available.
```

- [ ] **Step 4: Commit**

```bash
git add src/lib.rs README.md
git commit -m "feat(extension): launch external LSP artifact via WXML_ZED_LSP_ARTIFACT_DIR; remove in-repo launch

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: GitHub Release download/cache skeleton + install-status lifecycle

**Files:**
- Modify: `src/lib.rs`

- [ ] **Step 1: Add the download/cache resolver + wire it into the resolution order**

Replace the ENTIRE contents of `src/lib.rs` with (this is Task 1's file plus the release resolver and the status lifecycle; the local-artifact branch and error are unchanged):
```rust
use std::path::Path;

use zed_extension_api as zed;

const ARTIFACT_DIR_ENV: &str = "WXML_ZED_LSP_ARTIFACT_DIR";
const NOT_FOUND_ERROR: &str = "WXML LSP artifact not found. Set WXML_ZED_LSP_ARTIFACT_DIR to an unpacked wxml-lsp-node artifact, or publish a GitHub Release containing wxml-lsp-node-v*.tar.gz.";
// Placeholder until the real public LSP/tooling repo is decided. The download
// path is NOT validated end-to-end this round (no release exists yet).
const LSP_REPO: &str = "zscumt123/wxml-zed";

struct WxmlExtension;

impl WxmlExtension {
    /// Look up a variable in the worktree's shell environment.
    fn shell_env_var(worktree: &zed::Worktree, key: &str) -> Option<String> {
        worktree
            .shell_env()
            .into_iter()
            .find(|(k, _)| k.as_str() == key)
            .map(|(_, v)| v)
    }

    /// Resolve the LSP entry from the latest GitHub Release, downloading +
    /// extracting into a version-keyed cache dir if not already present. Returns
    /// the absolute-ish entry path string, or a raw cause on failure.
    fn entry_from_release(language_server_id: &zed::LanguageServerId) -> Result<String, String> {
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let release = zed::latest_github_release(
            LSP_REPO,
            zed::GithubReleaseOptions {
                require_assets: true,
                pre_release: false,
            },
        )?;

        // Exact asset name from the release version (strip a leading `v`, the build
        // script names the tarball `wxml-lsp-node-v<semver>.tar.gz`). Require exactly
        // one match — never glob (future releases may carry checksum/debug assets).
        let version = release.version.trim_start_matches('v');
        let asset_name = format!("wxml-lsp-node-v{version}.tar.gz");
        let mut matches = release.assets.iter().filter(|a| a.name == asset_name);
        let asset = matches
            .next()
            .ok_or_else(|| format!("no release asset named {asset_name}"))?;
        if matches.next().is_some() {
            return Err(format!("multiple release assets named {asset_name}"));
        }

        // Cache key is the ENTRY FILE, not the dir: a partial/failed extract must
        // not count as a hit. The cache dir is work-dir-relative.
        let cache_dir = format!("wxml-lsp-node-{version}");
        let entry = Path::new(&cache_dir)
            .join("wxml-lsp-node")
            .join("server")
            .join("wxml-lsp.mjs");
        if !entry.is_file() {
            let _ = std::fs::remove_dir_all(&cache_dir);
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            zed::download_file(
                &asset.download_url,
                &cache_dir,
                zed::DownloadedFileType::GzipTar,
            )
            .map_err(|e| format!("download/extract failed: {e}"))?;
            if !entry.is_file() {
                return Err(format!(
                    "artifact entry missing after extract: {}",
                    entry.display()
                ));
            }
        }
        Ok(entry.to_string_lossy().into_owned())
    }
}

impl zed::Extension for WxmlExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        let node = worktree
            .which("node")
            .ok_or_else(|| "node must be available on PATH to run the WXML LSP".to_string())?;

        // (1) Local artifact (dev). Highest priority: the env value is the artifact
        // ROOT and must contain server/wxml-lsp.mjs. A set-but-invalid value is a
        // user mistake — surface it; do NOT fall through to download or the repo.
        if let Some(dir) = Self::shell_env_var(worktree, ARTIFACT_DIR_ENV) {
            let entry = Path::new(&dir).join("server").join("wxml-lsp.mjs");
            if entry.is_file() {
                return Ok(zed::Command {
                    command: node,
                    args: vec![entry.to_string_lossy().into_owned()],
                    env: worktree.shell_env(),
                });
            }
            return Err(format!(
                "{NOT_FOUND_ERROR}\n  cause: {ARTIFACT_DIR_ENV}={dir} has no server/wxml-lsp.mjs"
            ));
        }

        // (2) GitHub Release download/cache (skeleton; not validated e2e this round).
        match Self::entry_from_release(language_server_id) {
            Ok(entry) => {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::None,
                );
                return Ok(zed::Command {
                    command: node,
                    args: vec![entry],
                    env: worktree.shell_env(),
                });
            }
            Err(cause) => {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::Failed(cause.clone()),
                );
                // (3) Wrap the raw cause in the actionable error — never leak it alone.
                return Err(format!("{NOT_FOUND_ERROR}\n  cause: {cause}"));
            }
        }
    }
}

zed::register_extension!(WxmlExtension);
```

(`_language_server_id` became `language_server_id` — it is now used for the status calls.)

- [ ] **Step 2: Build to wasm — verify it compiles**

Run:
```bash
CARGO_TARGET_DIR="$PWD/target" cargo build --release --target wasm32-wasip1 --offline
```
Expected: `Finished \`release\` profile`, exit 0. If any `zed_extension_api` symbol name/shape mismatches (`GithubReleaseOptions` fields, `LanguageServerInstallationStatus` variants, `download_file`/`DownloadedFileType::GzipTar`, `latest_github_release` signature), fix per the compiler against the vendored crate WIT at `~/.cargo/registry/src/*/zed_extension_api-0.7.0/wit/since_v0.6.0/`.

- [ ] **Step 3: Confirm scope — only src/lib.rs changed this task**

Run: `git status --short`
Expected: only `src/lib.rs` modified (README was committed in Task 1). No LSP/build/artifact files touched.

- [ ] **Step 4: Commit**

```bash
git add src/lib.rs
git commit -m "feat(extension): GitHub Release download/cache skeleton + install-status lifecycle

Codes the download path (latest_github_release -> exact asset -> download_file GzipTar
into a version-keyed cache dir, entry-file cache check) and the full
CheckingForUpdate/Downloading/None/Failed status lifecycle. Not validated
end-to-end this round (no release exists yet); fails cleanly into the actionable error.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Post-implementation validation (manual, real Zed — NOT an automated task)

The extension only runs inside Zed, so functional proof is manual dogfood (do this after both tasks; record results in spike-notes):

1. `node scripts/build-lsp-artifact.mjs`; unpack `dist/wxml-lsp-node-v<version>.tar.gz` to `/tmp/wxml-lsp-node` (so `/tmp/wxml-lsp-node/server/wxml-lsp.mjs` exists).
2. `export WXML_ZED_LSP_ARTIFACT_DIR=/tmp/wxml-lsp-node`; launch Zed from that terminal; reload the dev extension.
3. Open a real mini-program `.wxml`; confirm the LSP starts and a JS-backed feature works (diagnostics / go-to-definition), and confirm via the launched command / Zed logs that the entry is the **artifact** path, not an in-repo `server/wxml-lsp.mjs`.
4. Unset the env var → confirm you get the actionable error (the download path fails cleanly, no release yet), NOT a silent in-repo launch.
5. (Optional) Set `WXML_ZED_LSP_ARTIFACT_DIR` to a wrong dir → confirm the `cause: ... has no server/wxml-lsp.mjs` error.

**Known risk to watch in dogfood (step 2/5):** the local-artifact branch calls
`entry.is_file()` on the **arbitrary absolute** env path from inside the wasm
sandbox. The download path's `is_file()` is work-dir-relative (the standard Zed
pattern, reliable), but a wasm extension's filesystem visibility of arbitrary
absolute paths is not guaranteed. If step 2 shows a *valid* env dir failing to
launch (the `is_file()` guard wrongly reporting missing), the contingency is a
one-line change: drop the `is_file()` guard in branch (1) and launch
`node <dir>/server/wxml-lsp.mjs` unconditionally, letting node surface a wrong path
(this sacrifices the friendly invalid-env error — AC#2 — but guarantees the core
launch works). Decide based on what dogfood shows.

---

## Self-review checklist (run by plan author)

- **Spec coverage:** resolution order (1/2/3) → Task 1 (local + error) + Task 2 (download); remove in-repo launch → Task 1 Step 1; exact asset + exactly-one → Task 2 `entry_from_release`; entry-file cache check → Task 2; install-status CheckingForUpdate/Downloading/None/Failed → Task 2; wrapped error + cause → Task 2 (and Task 1's invalid-env branch); `worktree.which("node")` + `shell_env()` env → both tasks; env artifact-root-only → Task 1 branch (1); README/env doc → Task 1 Step 3; non-goals (LSP/build/artifact/repo-split/release-automation untouched) → only src/lib.rs + README change.
- **Placeholder scan:** full Rust in both tasks; exact build command; `LSP_REPO` is a flagged-adjustable constant, not a placeholder gap.
- **Type/name consistency:** `ARTIFACT_DIR_ENV`, `NOT_FOUND_ERROR`, `LSP_REPO`, `shell_env_var`, `entry_from_release` consistent across tasks; Task 2's file is a strict superset of Task 1's (same local branch + error text). `_language_server_id`→`language_server_id` rename noted. API names (`GithubReleaseOptions{require_assets,pre_release}`, `LanguageServerInstallationStatus::{CheckingForUpdate,Downloading,None,Failed}`, `download_file`, `DownloadedFileType::GzipTar`, `latest_github_release`) taken from the vendored 0.7.0 WIT; the `cargo build` gate in each task is the verification.
