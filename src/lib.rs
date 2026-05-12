use std::path::PathBuf;

use zed_extension_api as zed;

struct WxmlExtension;

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
            .ok_or_else(|| "node must be available on PATH to run the WXML LSP prototype".to_string())?;
        let server = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("server")
            .join("wxml-lsp.mjs");

        Ok(zed::Command {
            command: node,
            args: vec![server.to_string_lossy().into_owned()],
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(WxmlExtension);
