use std::path::{Path, PathBuf};

use zed_extension_api as zed;

const ARTIFACT_DIR_ENV: &str = "WXML_ZED_LSP_ARTIFACT_DIR";
const NOT_FOUND_ERROR: &str = "WXML LSP artifact not found. Set WXML_ZED_LSP_ARTIFACT_DIR to an unpacked wxml-lsp-node artifact, or publish a GitHub Release containing wxml-lsp-node-v*.tar.gz.";
// Public repo that publishes the LSP artifact as a GitHub Release. The download
// path is validated end-to-end (Release v0.3.0 + real-Zed download dogfood).
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

    fn absolute_entry(entry: &Path) -> Result<String, String> {
        // `download_file` and cache checks are relative to the extension work
        // directory, but Zed starts the language server with the user's project
        // as the process cwd. Return an absolute entry path so Node does not
        // resolve it relative to the opened workspace.
        let work_dir = std::env::current_dir()
            .map_err(|e| format!("failed to resolve extension work dir: {e}"))?;
        Ok(work_dir.join(entry).to_string_lossy().into_owned())
    }

    fn cached_entry(version: &str) -> (String, PathBuf) {
        let cache_dir = format!("wxml-lsp-node-{version}");
        let entry = Path::new(&cache_dir)
            .join("wxml-lsp-node")
            .join("server")
            .join("wxml-lsp.mjs");
        (cache_dir, entry)
    }

    /// Resolve the LSP entry for this extension version, downloading +
    /// extracting into a version-keyed cache dir if not already present. Returns
    /// the entry path string, or a raw cause on failure.
    fn entry_from_release(language_server_id: &zed::LanguageServerId) -> Result<String, String> {
        let version = env!("CARGO_PKG_VERSION");
        let (cache_dir, entry) = Self::cached_entry(version);
        if entry.is_file() {
            return Self::absolute_entry(&entry);
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let release = zed::github_release_by_tag_name(LSP_REPO, &format!("v{version}"))?;

        // Exact asset name from the extension version. The build
        // script names the tarball wxml-lsp-node-v<semver>.tar.gz). Require exactly
        // one match — never glob (future releases may carry checksum/debug assets).
        let asset_name = format!("wxml-lsp-node-v{version}.tar.gz");
        let mut matches = release.assets.iter().filter(|a| a.name == asset_name);
        let asset = matches
            .next()
            .ok_or_else(|| format!("no release asset named {asset_name}"))?;
        if matches.next().is_some() {
            return Err(format!("multiple release assets named {asset_name}"));
        }

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
        Self::absolute_entry(&entry)
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
        // ROOT and must contain server/wxml-lsp.mjs. Do not stat this arbitrary
        // absolute path from the extension wasm: Zed's extension filesystem may not
        // expose it even though the spawned Node process can execute it.
        if let Some(dir) = Self::shell_env_var(worktree, ARTIFACT_DIR_ENV) {
            let entry = Path::new(&dir).join("server").join("wxml-lsp.mjs");
            return Ok(zed::Command {
                command: node,
                args: vec![entry.to_string_lossy().into_owned()],
                env: worktree.shell_env(),
            });
        }

        // (2) GitHub Release download/cache.
        match Self::entry_from_release(language_server_id) {
            Ok(entry) => {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::None,
                );
                Ok(zed::Command {
                    command: node,
                    args: vec![entry],
                    env: worktree.shell_env(),
                })
            }
            Err(cause) => {
                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::Failed(cause.clone()),
                );
                // (3) Wrap the raw cause in the actionable error — never leak it alone.
                Err(format!("{NOT_FOUND_ERROR}\n  cause: {cause}"))
            }
        }
    }
}

zed::register_extension!(WxmlExtension);
