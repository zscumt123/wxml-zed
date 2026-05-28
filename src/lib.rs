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
