# Local Grammar Loading

Date: 2026-05-11

Zed dev-extension loading requires the local `file://` grammar repository to be a git checkout that contains the configured `rev`.

For the baseline, keep the grammar source vendored in this repository without a nested `.git` directory. Local Zed grammar loading should use a separately cloned grammar checkout until this project has a controlled public grammar repository.

Manual verification:

- `file://` pointing at `grammar/tree-sitter-wxml` without nested git metadata failed.
- `file://` pointing at `/private/tmp/wxml-zed-tree-sitter-wxml-dev-git-20260511` was tested.
- Zed compiled grammar `wxml` and finished compiling the dev extension.
- Zed log showed no WXML grammar loading error after the separate local git checkout was used.
