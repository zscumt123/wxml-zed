# Grammar Public Repo + `extension.toml` Repin (publish-readiness #3) Design

## Goal

Publish the WXML tree-sitter grammar to a real public git repository and repin
`extension.toml`'s `[grammars.wxml]` off the local `file:///private/tmp/...` path.
This removes the last hard *configuration* blocker for the grammar side of
publishing: Zed requires `[grammars.wxml].repository` to be a real git repo
(`file://` is explicitly dev-only), and the current `/private/tmp/...` pointer is
both unpublishable and locally fragile (cleared on reboot).

## Context (grounded in the repo)

- `grammar/tree-sitter-wxml/` is already a **complete, buildable tree-sitter
  grammar repo** (vendored, not a submodule): `grammar.js`, `src/parser.c` +
  `src/grammar.json` + `src/scanner.c` + `src/tree_sitter/`, `tree-sitter.json`,
  `queries/`, `bindings/`, build files. Because `src/parser.c` is committed, Zed
  builds the grammar from a repo rev **without running `tree-sitter generate`**.
- Its `.gitignore` excludes only build artifacts (`target/`, `build/`, `*.wasm`)
  with an explicit `!tree-sitter-wxml.wasm` exception; `git check-ignore` confirms
  no buildable source (`parser.c`/`grammar.json`/`scanner.c`/`grammar.js`/
  `tree-sitter.json`) is ignored — they all travel on a push.
- It has **no `LICENSE` file**. `package.json` declares `license: MIT`, `author:
  BlockLune`, `repository: github.com/blocklune/tree-sitter-wxml`. So the grammar
  is BlockLune's MIT work (modified here); publishing it must carry an MIT LICENSE
  preserving BlockLune's copyright.
- Zed's syntax-highlight **queries live in the extension** (`languages/wxml/*.scm`),
  not consumed from the grammar repo. The grammar repo's own `queries/` are for
  other tree-sitter consumers; the extension's queries are untouched.
- The committed `tree-sitter-wxml.wasm` has two independent lives: wxml-zed's copy
  feeds the **LSP artifact** (publish #1) and is untouched here; Zed's native
  grammar rebuilds its own wasm from `src/parser.c` at the pinned rev.

## Design

### §1 — Public repo `zscumt123/tree-sitter-wxml`

A faithful copy of the current `grammar/tree-sitter-wxml/` contents (no structural
change — it is already a valid grammar repo), plus a new **MIT `LICENSE`** that
preserves BlockLune's copyright and adds the wxml-zed modifications:

```
MIT License

Copyright (c) BlockLune (original tree-sitter-wxml)
Copyright (c) 2026 zscumt123 and wxml-zed contributors (modifications)

Permission is hereby granted, free of charge, to any person obtaining a copy
... [standard MIT body] ...
```

Buildable by Zed as-is (`src/parser.c` present). The committed `tree-sitter-wxml.wasm`
may travel along (harmless; Zed rebuilds its own).

### §2 — In-repo changes (the agent-executable part)

In `grammar/tree-sitter-wxml/` (the source-of-truth that gets pushed):
- **Add `LICENSE`** (the MIT text above). This is the load-bearing legal artifact
  for republishing; it also closes the missing-license gap on this vendored grammar.
- **Add a short `NOTICE`** (provenance): "Adapted from BlockLune/tree-sitter-wxml
  (MIT); maintained as part of wxml-zed."
- **Update `package.json` `repository`** to `https://github.com/zscumt123/tree-sitter-wxml`
  (so the published repo's metadata self-references correctly); keep `author:
  BlockLune` (accurate original author — fork attribution lives in LICENSE/NOTICE).

In the wxml-zed root:
- **Repin `extension.toml`** `[grammars.wxml]` to:
  ```toml
  [grammars.wxml]
  repository = "https://github.com/zscumt123/tree-sitter-wxml"
  rev = "<sha>"
  ```
  where `<sha>` is the commit the user pushes. **This step is GATED** on the public
  repo existing — it cannot be finalized until the user provides the pushed sha.

### §3 — Conservative maintenance model (this round)

wxml-zed **keeps** its vendored `grammar/tree-sitter-wxml/` as the source-of-truth;
the public repo is published *from* it. We do **NOT** convert it to a git submodule,
do **NOT** delete wxml-zed's grammar source, and do **NOT** touch the LSP's
`tree-sitter-wxml.wasm` path. De-duplication (submodule, or making the public repo
the sole source) is a deliberately deferred later decision — this round only
unblocks the `file://` pointer with minimal change. (Accepted tradeoff: the
vendored copy and the public repo can drift until that later decision; for now the
vendored copy is canonical and re-pushed when it changes.)

### §4 — Ops handoff (execution splits; some steps are the user's)

The grammar source/LICENSE prep and the repin edit are agent-executable in-repo.
Creating the public GitHub repo and pushing are **outward-facing ops the user
performs** (NEVER push to BlockLune `origin`; never push without explicit request):

1. **Agent (in-repo):** add `LICENSE` + `NOTICE` to `grammar/tree-sitter-wxml/`,
   update its `package.json` `repository`; commit. Verify the grammar dir is a
   complete buildable set (sources present, not gitignored).
2. **PAUSE → User (ops):** create `zscumt123/tree-sitter-wxml` (public), push the
   grammar dir's contents to it, capture the commit sha. (The exact command
   checklist is produced in the plan, not guessed here.)
3. **Agent (in-repo):** set `extension.toml` `repository` + `rev = <sha>`; commit.
4. **User (dogfood):** reinstall the dev extension in Zed; confirm the grammar
   builds from the public repo rev (no longer `file:///tmp`) and highlight/outline
   work on a real `.wxml`.

## Validation

- **In-repo sanity (agent, automatable):** `LICENSE` + `NOTICE` exist in
  `grammar/tree-sitter-wxml/`; `git check-ignore src/parser.c src/grammar.json
  src/scanner.c grammar.js tree-sitter.json` reports none ignored (all publishable);
  `extension.toml` no longer contains `file://` after the repin (step 3).
- **The wider verifier suite stays green** — this round touches only grammar-dir
  metadata + extension.toml; no LSP/extension Rust/script change. Run
  narrow-ranges (20/20), wasm baselines (8/8), language-service (exit 0),
  graph-smoke, and `verify-lsp-artifact.mjs` to confirm no collateral damage.
- **Manual Zed dogfood (user, the real proof):** after repin, Zed clones+builds the
  grammar from the public repo at the pinned rev; WXML highlighting and outline
  render; no `file://` reference remains. (Requires the public repo to be reachable.)

## Non-Goals

- No git submodule; no removal of wxml-zed's vendored grammar source; no change to
  the LSP `tree-sitter-wxml.wasm` path or the publish-#1 artifact.
- No `tree-sitter generate` / grammar logic change — the published grammar is a
  byte-faithful copy plus license/metadata files.
- No GitHub Release / LSP-download work (that's the separate LSP track).
- No marketplace PR, no repo split for the *extension* itself.
- No README typo fixes or unrelated grammar cleanup.

## Acceptance Criteria

1. `grammar/tree-sitter-wxml/` gains a correct MIT `LICENSE` (BlockLune original +
   zscumt123 modifications) and a short `NOTICE`; `package.json` `repository`
   points at the new public repo; `author` (BlockLune) preserved.
2. The grammar dir is confirmed a complete, buildable, publishable set (no
   buildable source gitignored).
3. After the user publishes and provides the sha, `extension.toml`
   `[grammars.wxml]` is `repository = "https://github.com/zscumt123/tree-sitter-wxml"`
   + `rev = "<sha>"`, with **no `file://`** remaining.
4. The full offline verifier suite (narrow-ranges, wasm, language-service,
   graph-smoke, lsp-artifact) stays green — no collateral change.
5. Manual Zed dogfood confirms the grammar builds from the public repo rev and
   highlighting/outline work; recorded in spike-notes.
6. Non-goals honored: no submodule, no vendored-source removal, no LSP/wasm change,
   no Release/marketplace work.
