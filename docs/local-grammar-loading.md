# Local Grammar Loading

Date: 2026-05-11

Zed dev-extension loading requires the local `file://` grammar repository to be a git checkout that contains the configured `rev`.

For the baseline, keep the grammar source vendored in this repository without a nested `.git` directory. Local Zed grammar loading should use a separately cloned grammar checkout until this project has a controlled public grammar repository.

Manual verification:

- `file://` pointing at `grammar/tree-sitter-wxml` without nested git metadata failed.
- `file://` pointing at `/private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511` was tested.
- Zed compiled grammar `wxml` and finished compiling the dev extension.
- Zed log showed no WXML grammar loading error after the separate local git checkout was used.

Final smoke check:

- Reinstalled the dev extension from `/Users/zs/Desktop/study/wxml-zed`.
- Zed log at `2026-05-11T17:45:50+08:00` reported `compiled grammar wxml` and `finished compiling extension`.
- An open `.wxml` file switched from `Unknown` to `WXML` in the Zed status bar, and WXML highlighting rendered in the editor.
- Zed generated `grammars/wxml/` as a local build checkout; the repository already ignores `/grammars`.

Semantic grammar baseline smoke setup:

- Synced `grammar/tree-sitter-wxml/` into `/private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511`.
- Committed the local grammar checkout at `00e5168d456b8960d31533b9587802d73e7a0989`.
- Updated `extension.toml` to pin `[grammars.wxml].rev` to that commit before rebuilding the dev extension.

Semantic grammar baseline smoke check:

- Rebuilt WXML v0.2.0 from Zed's Extensions panel.
- Zed log at `2026-05-11T18:46:54+08:00` reported `compiled grammar wxml` and `finished compiling extension`.
- The open `.wxml` file remained recognized as `WXML` in the status bar after the rebuild.

Recovery fix smoke setup:

- Synced the recovery grammar changes into `/private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511`.
- Committed the local grammar checkout at `fa31bef18059aacecc00a580463a6422c8a70fea`.
- Updated `extension.toml` to pin `[grammars.wxml].rev` to that recovery commit before rebuilding the dev extension.

Recovery fix smoke check:

- Rebuilt WXML v0.2.0 from Zed's Extensions panel.
- Zed log at `2026-05-11T19:07:43+08:00` reported `compiled grammar wxml` and `finished compiling extension`.
- The open `.wxml` file remained recognized as `WXML` in the status bar after the rebuild.
- `languages/wxml/outline.scm` query output included `./item.wxml`, `../common/header.wxml`, `userCard`, `utils`, and `inline`.
- `languages/wxml/highlights.scm` query executed successfully against `fixtures/test.wxml`.
