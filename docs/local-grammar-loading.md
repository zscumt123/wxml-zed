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
