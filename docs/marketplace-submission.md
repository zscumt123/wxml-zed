# Zed marketplace submission — `weixin-wxml`

Final, verified plan for submitting this extension to `zed-industries/extensions`
as a **new, independent** entry `weixin-wxml` (not a takeover of the existing
`wxml` slot). Verified against the live registry on 2026-05-30:
`extensions.toml`, `.gitmodules`, `package.json` scripts, and `CONTRIBUTING.md`.

> Submodule pins this repo at the `main` HEAD at submission time. The PR opened
> 2026-05-30 pinned `9d478c95501fb9f34f805796bc59ce2bbf0d172e` (packages/zed/
> content identical to `e359f9c`; later commits only touched docs/).
>
> **Status (2026-05-30):** branch `add-weixin-wxml` prepared + pushed to the
> fork; `pnpm build` + `pnpm test` (111/111) green; PR ready to open via the
> cross-fork compare URL. `package-extensions` was skipped locally (heavy;
> zed-industries CI runs the real extension build on the PR).

## 0. One-time fork setup (on GitHub + locally)

1. Fork `https://github.com/zed-industries/extensions` to your account.
2. Clone your fork and wire the upstream:
   ```bash
   git clone https://github.com/zscumt123/extensions.git
   cd extensions
   git remote add upstream https://github.com/zed-industries/extensions.git
   ```

## 1. Branch + add the submodule

```bash
git fetch upstream
git checkout -b add-weixin-wxml upstream/main

git submodule add https://github.com/zscumt123/wxml-zed.git extensions/weixin-wxml
git -C extensions/weixin-wxml checkout main
git -C extensions/weixin-wxml pull --ff-only origin main
git -C extensions/weixin-wxml rev-parse HEAD
# MUST print: e359f9c7d0dc13e71b5232831c30e2b80c66f650
```

`git submodule add` auto-writes this `.gitmodules` block (verified format —
tab-indented):

```
[submodule "extensions/weixin-wxml"]
	path = extensions/weixin-wxml
	url = https://github.com/zscumt123/wxml-zed.git
```

## 2. Add the `extensions.toml` entry

Insert this block (alphabetical slot: after `[webidl]`, before `[wgsl]`). The
sort script normalizes placement, so exact position on paste does not matter:

```toml
[weixin-wxml]
submodule = "extensions/weixin-wxml"
path = "packages/zed"
version = "0.3.0"
```

- `path = "packages/zed"` points the registry at the slim extension surface
  (verified supported — e.g. `[metal] path = "editors/zed"`, `[dependi] path = "dependi-zed"`).
- `version` must equal `packages/zed/extension.toml` version (`0.3.0`).
- The license requirement is satisfied: `packages/zed/LICENSE` + `packages/zed/NOTICE` exist.

## 3. Validate with the official scripts

Package manager: **confirm by lockfile** — if the repo root has `pnpm-lock.yaml`
use `pnpm`; if `package-lock.json`, use `npm run`. (zed-industries uses pnpm;
these script names are verified to exist in `package.json`: `sort-extensions`,
`build`, `test`, `package-extensions`.)

```bash
pnpm install
pnpm sort-extensions      # node src/sort-extensions.js — normalizes extensions.toml + .gitmodules order
pnpm build                # tsc -p .
pnpm test                 # vitest run
pnpm package-extensions   # node src/package-extensions.js — builds our Rust wasm + fetches the public grammar (needs network + wasm32 toolchain)
```

## 4. Commit + push + open PR

```bash
git add .gitmodules extensions.toml extensions/weixin-wxml
git commit -m "Add Weixin WXML extension"
git push origin add-weixin-wxml
```

Open the PR from `your-fork:add-weixin-wxml` → `zed-industries/extensions:main`.

## PR title

```
Add Weixin WXML extension
```

## PR body

```markdown
Adds `weixin-wxml`, a WXML extension for WeChat Mini Program development.

This provides a fuller language experience than the existing syntax-only `wxml`
extension:

- Tree-sitter WXML highlighting, outline, snippets, and textobjects
- WXML project-graph–backed diagnostics (missing local components, undefined
  event handlers / expression refs, dead component bindings; live overlay on
  unsaved edits)
- Go to definition: components, import/include, external WXS modules, event
  handlers, data/property refs, WXS cross-references, and `wx:for` bindings
- Hover: data/property refs, WXS modules, event handlers, components, and
  `wx:for` bindings (use-site and declaration)
- Completion: built-in tags, resolved components, static templates, common
  attributes, event handlers, expression refs, and cursor-scoped `wx:for` bindings
- The language server is distributed as an external Node artifact downloaded
  from this project's GitHub Releases (pinned to the extension version and cached
  locally; works offline after first fetch) — it is **not** bundled in the
  extension.

The extension code lives under `packages/zed`, so this registry entry uses
`path = "packages/zed"`, where the extension `LICENSE` and `NOTICE` are present.

**Why a separate extension rather than contributing to `wxml`:** the existing
`wxml` extension is syntax-only and built on a different architecture (vendored
grammar, no language server). This extension adds a full Node-based LSP stack;
folding that into `wxml` would be a ground-up rewrite of another author's
published extension. We publish separately to avoid an unconsented maintainer
takeover, while preserving the original MIT attribution (see `NOTICE`, which
credits the upstream WXML grammar/extension baseline). We're glad to coordinate
with the `wxml` maintainer or reconsider consolidation if the Zed team prefers.

Tested locally as a dev extension in Zed against a real WeChat Mini Program
project: the language server downloads and starts from the release artifact, and
go-to-definition navigates from WXML (`bindsubmit="onSubmit"`) to the backing JS
method.
```

## Risks / reviewer notes

- **Primary risk (documented policy, not just taste):** `CONTRIBUTING.md` says —
  "if your extension provides functionality already provided by another
  extension, you should consider contributing fixes in the existing extension for
  all users first before opening a pull request for a new extension here." The PR
  body's "Why a separate extension" section is written to preempt this; a reviewer
  may still ask us to contribute to `wxml` or coordinate with its maintainer.
- Package manager (`pnpm` vs `npm`) — confirm by lockfile before running step 3.
- `package-extensions` builds our Rust extension + clones the public
  `tree-sitter-wxml` grammar; ensure network + the `wasm32-wasip1` Rust target are
  available in the environment you run it.
