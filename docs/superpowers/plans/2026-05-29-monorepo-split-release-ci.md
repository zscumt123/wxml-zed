# Monorepo split + Release CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Zed extension surface into a slim `packages/zed/` subdirectory (single repo, marketplace-ready via `path = "packages/zed"`) and add a tag-triggered GitHub Actions workflow that builds the LSP artifact and publishes it as a Release asset.

**Architecture:** Single GitHub repo `zscumt123/wxml-zed`. Repo root stays the LSP/tooling source + Release emitter (`LSP_REPO` unchanged). The extension surface (`extension.toml`, `Cargo.toml`, `src/lib.rs`, `languages/wxml/`, `snippets/`, `LICENSE`, `NOTICE`, slim `README.md`) moves to `packages/zed/` as the single source of truth — no duplication. Two verifier scripts that hardcode root-relative query/snippet paths are repointed to `packages/zed/` so the offline sweep stays green. A `.github/workflows/release.yml` builds `dist/wxml-lsp-node-v<version>.tar.gz` on a `v*` tag and attaches it to the Release, guarded by a four-way version-consistency check.

**Tech Stack:** Rust (`wasm32-wasip1`, `zed_extension_api` 0.7.0), Node ESM (LSP + build/verify scripts), GitHub Actions, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-05-29-monorepo-split-release-ci-design.md`

---

## File Structure

**Moved (via `git mv`, single source of truth — root copies cease to exist except LICENSE/NOTICE which are also kept at root):**
- `extension.toml` → `packages/zed/extension.toml`
- `Cargo.toml`, `Cargo.lock` → `packages/zed/`
- `src/lib.rs` → `packages/zed/src/lib.rs`
- `languages/wxml/` (7 query files) → `packages/zed/languages/wxml/`
- `snippets/wxml.json` → `packages/zed/snippets/wxml.json`

**Copied (root retains its own for the repo + artifact build):**
- `LICENSE` → `packages/zed/LICENSE`
- `NOTICE` → `packages/zed/NOTICE`

**Created:**
- `packages/zed/README.md` (slim, extension-facing)
- `.github/workflows/release.yml`

**Modified (root, stays at root):**
- `scripts/verify-tree-sitter.sh` — add `EXTENSION_DIR`, repoint query/snippet refs
- `scripts/verify-wxml-builtins.mjs:9` — repoint highlights path
- `README.md` — minimal move-forced staleness correction

**Untouched (deliberately at root, NOT in slim surface):** `server/`, `scripts/` (except the two above), `shared/`, `grammar/`, `fixtures/`, `docs/`, `package.json`, `package-lock.json`, root `LICENSE`/`NOTICE`/`THIRD_PARTY_NOTICES.md`, root `README.md` (body).

---

## Task 1: Restructure into `packages/zed/` + repoint verifiers (atomic, sweep green at commit)

**Files:**
- Move: `extension.toml`, `Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `languages/wxml/*`, `snippets/wxml.json` → `packages/zed/`
- Copy: `LICENSE`, `NOTICE` → `packages/zed/`
- Modify: `packages/zed/Cargo.toml` (version bump), `scripts/verify-tree-sitter.sh`, `scripts/verify-wxml-builtins.mjs`

> Rationale for atomicity: moving the queries/snippets without repointing the verifiers breaks `verify-tree-sitter.sh`. The move + verifier repoint land in ONE commit so the sweep that gates the commit is green.

- [ ] **Step 1: Create `packages/zed/` and move the extension surface**

```bash
mkdir -p packages/zed
git mv extension.toml packages/zed/extension.toml
git mv Cargo.toml packages/zed/Cargo.toml
git mv Cargo.lock packages/zed/Cargo.lock
git mv src packages/zed/src
git mv languages packages/zed/languages
git mv snippets packages/zed/snippets
```

- [ ] **Step 2: Copy LICENSE + NOTICE into the slim surface**

The root `LICENSE` text says "See NOTICE for provenance" — the slim surface must carry both or the reference dangles.

```bash
cp LICENSE packages/zed/LICENSE
cp NOTICE packages/zed/NOTICE
git add packages/zed/LICENSE packages/zed/NOTICE
```

- [ ] **Step 3: Bump `packages/zed/Cargo.toml` version 0.2.0 → 0.3.0**

Edit `packages/zed/Cargo.toml` line 3:
```toml
version = "0.3.0"
```
(aligns Cargo version with `extension.toml`/`package.json`; the four-way CI guard in Task 3 enforces this going forward.)

- [ ] **Step 4: Repoint `scripts/verify-wxml-builtins.mjs`**

Edit `scripts/verify-wxml-builtins.mjs:9`:
```js
const HIGHLIGHTS = path.join(ROOT, "packages/zed/languages/wxml/highlights.scm");
```
(was `path.join(ROOT, "languages/wxml/highlights.scm")`)

- [ ] **Step 5: Repoint `scripts/verify-tree-sitter.sh`**

Add an `EXTENSION_DIR` definition right after the `ROOT_DIR` line (line 4) and globally repoint the query + snippet references. Run:

```bash
# Insert EXTENSION_DIR after the ROOT_DIR= line
perl -0pi -e 's{(ROOT_DIR="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)/\.\." && pwd\)"\n)}{$1EXTENSION_DIR="\$ROOT_DIR/packages/zed"\n}' scripts/verify-tree-sitter.sh
# Repoint all query + snippet refs
perl -pi -e 's{\$ROOT_DIR/languages/wxml}{\$EXTENSION_DIR/languages/wxml}g; s{\$ROOT_DIR/snippets}{\$EXTENSION_DIR/snippets}g' scripts/verify-tree-sitter.sh
```

Then verify no `$ROOT_DIR/languages/wxml` or `$ROOT_DIR/snippets` literal remains and `EXTENSION_DIR` is defined:

```bash
grep -nE '\$ROOT_DIR/(languages/wxml|snippets)' scripts/verify-tree-sitter.sh   # expect: no output
grep -n 'EXTENSION_DIR=' scripts/verify-tree-sitter.sh                          # expect: one line near top
grep -cE '\$EXTENSION_DIR/(languages/wxml|snippets)' scripts/verify-tree-sitter.sh   # expect: >= 20
```

- [ ] **Step 6: Regression-sweep for any missed root-relative refs**

```bash
grep -rnE "languages/wxml|snippets/" scripts/ | grep -vE "EXTENSION_DIR|packages/zed"
```
Expected: **no output** (the only two files were the ones edited in Steps 4–5; per spec sweep, nothing else references these paths).

- [ ] **Step 7: Verify the moved extension compiles**

```bash
CARGO_TARGET_DIR="$PWD/target" cargo build --manifest-path packages/zed/Cargo.toml --release --target wasm32-wasip1 --offline
```
Expected: `Finished \`release\` profile` (compiles clean). If it fails with "Operation not permitted", confirm `CARGO_TARGET_DIR` is set (the machine `~/.cargo/config` points the default target dir outside the sandbox).

- [ ] **Step 8: Run the full offline verifier sweep — must be green AFTER the repoint**

```bash
bash scripts/verify-tree-sitter.sh
node scripts/verify-wxml-narrow-ranges.mjs
node scripts/verify-wasm-symbol-baselines.mjs
node scripts/verify-wxml-language-service.mjs
node scripts/verify-lsp-diagnostics.mjs --suite graph-smoke
node scripts/verify-lsp-artifact.mjs
npm run build:lsp
```
Expected: each exits 0; `verify-tree-sitter.sh` prints `wxml-zed tree-sitter verification passed`; `build:lsp` prints `built dist/wxml-lsp-node + dist/wxml-lsp-node-v0.3.0.tar.gz`. The sweep passing is the proof that the moved query/snippet paths resolve.

> Note: `verify-tree-sitter.sh` spawns `tree-sitter-cli` and may need the sandbox disabled (`dangerouslyDisableSandbox: true`) — it shells out to a binary. If it fails with a sandbox/permission error (not an assertion), re-run with the sandbox off.

- [ ] **Step 9: Handle stale root build artifact `extension.wasm`**

```bash
git ls-files extension.wasm    # is it tracked?
```
If tracked, remove it (stale; Zed/marketplace rebuilds from `src/lib.rs`):
```bash
git rm extension.wasm
```
If not tracked (gitignored), leave it.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: move extension surface into packages/zed/ (monorepo slim split) + repoint verifiers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Slim `packages/zed/README.md` + minimal root README correction

**Files:**
- Create: `packages/zed/README.md`
- Modify: `README.md` (root)

- [ ] **Step 1: Write the slim extension-facing README**

Create `packages/zed/README.md`:

```markdown
# WXML for Zed

WXML (WeiXin Markup Language) support for the Zed editor: syntax highlighting,
outline, snippets, and a language server providing diagnostics, go-to-definition,
hover, and completion for WeChat Mini-Program WXML projects.

## Requirements

This extension does **not** bundle the language server. It requires:

- **`node` on your `PATH`** — Zed launches the WXML language server as a Node
  process.

On first use the extension downloads the `wxml-lsp-node` artifact from this
project's GitHub Releases and caches it locally. No manual install step is needed.

## Grammar

Syntax highlighting uses the [`tree-sitter-wxml`](https://github.com/zscumt123/tree-sitter-wxml)
grammar, pinned in `extension.toml`.

## Local development

To run a locally-built language server instead of the released artifact, set
`WXML_ZED_LSP_ARTIFACT_DIR` to an unpacked `wxml-lsp-node` artifact directory
(must contain `server/wxml-lsp.mjs`). See the repository root README for building
the artifact (`npm run build:lsp`).

## License

MIT. Portions adapted from upstream WXML extension and Tree-sitter grammar
sources — see `LICENSE` and `NOTICE`.
```

- [ ] **Step 2: Correct the root README — repoint moved paths**

In `README.md`, the "When changing queries or snippets" list (around line 146-148) currently says:

```markdown
1. Edit files under `languages/wxml/` or `snippets/`.
```
Change to:
```markdown
1. Edit files under `packages/zed/languages/wxml/` or `packages/zed/snippets/`.
```

- [ ] **Step 3: Correct the root README — drop the stale `file:///private/tmp` grammar block**

In `README.md`, the block around lines 115-128 describes the dev grammar pin as `file:///private/tmp/...`. This is stale since publish #3 (grammar is now pinned to the public repo). Replace the entire block (from "For local Zed development, `extension.toml` currently points..." through "...See `docs/local-grammar-loading.md` for the observed Zed behavior.") with:

```markdown
The WXML grammar is pinned in `packages/zed/extension.toml` to the public
[`tree-sitter-wxml`](https://github.com/zscumt123/tree-sitter-wxml) repository at
a fixed revision. Zed clones and builds it at extension-install time. The vendored
copy under `grammar/tree-sitter-wxml/` remains the first-party source baseline and
is the source from which that public repository is published.
```

- [ ] **Step 4: Correct the root README — rewrite the over-cautious `## Redistribution Status` section**

In `README.md` the `## Redistribution Status` section (lines ~286-293) reads:

```markdown
## Redistribution Status

This repository includes provenance notes in `NOTICE`. The current baseline is
usable for local development, but the original public seed repositories did not
include an explicit license at the time this baseline was created. Before
publishing a marketplace extension or redistributing packaged artifacts, either
obtain upstream authorization or replace inherited source/query content with
clean-room equivalents.
```

Replace that entire section with:

```markdown
## Redistribution Status

This project is MIT-licensed (`LICENSE`) with upstream provenance recorded in
`NOTICE`. The slim extension surface under `packages/zed/` carries its own
`LICENSE` and `NOTICE`; the distributable LSP artifact bundles third-party
licenses (see `THIRD_PARTY_NOTICES.md`).
```

- [ ] **Step 5: Correct the root README — update the `## Project Layout` section for the move**

In `README.md` the `## Project Layout` list (lines ~295-311) lists `extension.toml`, `Cargo.toml and src/lib.rs`, and `languages/wxml/` as root-level. After Task 1 these live under `packages/zed/`. Replace the first three bullets:

```markdown
- `extension.toml`: Zed extension metadata, grammar registration, snippets, and
  WXML LSP registration.
- `Cargo.toml` and `src/lib.rs`: minimal Zed Rust extension glue for launching
  the Node LSP prototype.
- `languages/wxml/`: language config and Tree-sitter query files.
```

with:

```markdown
- `packages/zed/`: the slim Zed extension surface published to the marketplace —
  `extension.toml` (metadata, grammar registration, snippets, WXML LSP
  registration), `Cargo.toml` + `src/lib.rs` (Rust glue that launches the Node
  LSP), `languages/wxml/` (language config + Tree-sitter queries), `snippets/`,
  `LICENSE`, `NOTICE`, `README.md`.
```

Leave the remaining bullets (`grammar/`, `fixtures/`, `server/`, `scripts/`, `docs/`) unchanged — they stay at root.

- [ ] **Step 6: Sanity-check the root README has no remaining stale refs**

```bash
grep -nE "file:///private/tmp|upstream authorization|clean-room" README.md
```
Expected: **no output**. Also confirm the corrections landed:
```bash
grep -n "packages/zed/languages/wxml" README.md       # expect: >= 1 (Step 2 query-edit instructions)
grep -n "the slim Zed extension surface" README.md    # expect: 1 (Project Layout bullet)
```

- [ ] **Step 7: Commit**

```bash
git add packages/zed/README.md README.md
git commit -m "docs: slim packages/zed README + correct root README for monorepo move

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Release CI workflow with four-way version guard

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release LSP artifact

on:
  push:
    tags:
      - 'v*.*.*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm ci

      - name: Assert four-way version consistency
        run: |
          set -euo pipefail
          PKG="$(node -p "require('./package.json').version")"
          EXT="$(sed -nE 's/^version = "([^"]+)"/\1/p' packages/zed/extension.toml | head -n1)"
          CARGO="$(sed -nE 's/^version = "([^"]+)"/\1/p' packages/zed/Cargo.toml | head -n1)"
          TAG="${GITHUB_REF_NAME#v}"
          echo "package.json=$PKG extension.toml=$EXT Cargo.toml=$CARGO tag=$TAG"
          for v in "$EXT" "$CARGO" "$TAG"; do
            if [ "$v" != "$PKG" ]; then
              echo "::error::version mismatch: package.json=$PKG but found $v"
              exit 1
            fi
          done

      - name: Verify LSP artifact (build + detached smoke + negative control + license)
        run: node scripts/verify-lsp-artifact.mjs

      - name: Build LSP artifact for upload
        run: npm run build:lsp

      - name: Create release and upload artifact
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          gh release create "$GITHUB_REF_NAME" \
            "dist/wxml-lsp-node-${GITHUB_REF_NAME}.tar.gz" \
            --title "$GITHUB_REF_NAME" \
            --generate-notes
```

> Design notes (do not paste into the file): `package.json` version is the artifact SoT; `build-lsp-artifact.mjs` derives the asset name `wxml-lsp-node-v<version>.tar.gz` from it, which is exactly what `src/lib.rs`'s `latest_github_release` reconstructs. The guard prevents both an asset-name/tag mismatch and silent extension-vs-artifact drift. **The `verify-lsp-artifact.mjs` step is the real gate** — it rebuilds, unpacks outside the repo, asserts a JS-backed go-to-definition resolves, runs a negative control, and checks bundled licenses; a `set -e` failure there stops the job before any build/upload, so a broken LSP tarball is never published. The subsequent `build:lsp` re-emits `dist/` immediately before upload (robust regardless of how `verify-lsp-artifact.mjs` treats its own temp/`dist`). `gh` is built into GitHub runners; `GITHUB_TOKEN` is auto-provided.

- [ ] **Step 2: Lint the workflow YAML**

```bash
if command -v actionlint >/dev/null 2>&1; then
  actionlint .github/workflows/release.yml
else
  echo "actionlint not installed; falling back to yaml syntax check"
fi
node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/release.yml','utf8');console.log(s.includes('jobs:')&&s.includes('release:')?'structure OK':'STRUCTURE MISSING')"
```
Expected: if `actionlint` is installed it must exit 0 (a real lint error fails this step — it is NOT swallowed into the fallback); otherwise `structure OK`.

- [ ] **Step 3: Locally prove the four-way guard logic (positive case)**

Simulate the guard with the real repo files and a matching tag:

```bash
GITHUB_REF_NAME="v0.3.0" bash -c '
set -euo pipefail
PKG="$(node -p "require(\"./package.json\").version")"
EXT="$(sed -nE "s/^version = \"([^\"]+)\"/\1/p" packages/zed/extension.toml | head -n1)"
CARGO="$(sed -nE "s/^version = \"([^\"]+)\"/\1/p" packages/zed/Cargo.toml | head -n1)"
TAG="${GITHUB_REF_NAME#v}"
echo "package.json=$PKG extension.toml=$EXT Cargo.toml=$CARGO tag=$TAG"
for v in "$EXT" "$CARGO" "$TAG"; do [ "$v" = "$PKG" ] || { echo "MISMATCH $v"; exit 1; }; done
echo "GUARD PASS"
'
```
Expected: prints all four = `0.3.0` and `GUARD PASS`. This proves the `sed`/`node -p` extraction expressions actually parse the current files (the part that can't be tested in CI without pushing).

- [ ] **Step 4: Locally prove the guard rejects a mismatch (negative case)**

```bash
GITHUB_REF_NAME="v0.4.0" bash -c '
PKG="$(node -p "require(\"./package.json\").version")"
TAG="${GITHUB_REF_NAME#v}"
[ "$TAG" = "$PKG" ] && echo "UNEXPECTED PASS" || echo "GUARD correctly rejects tag mismatch"
'
```
Expected: `GUARD correctly rejects tag mismatch`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add tag-triggered Release workflow with four-way version guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Standby contingencies (NOT tasks — apply only during the user's download-path dogfood)

The download branch in `packages/zed/src/lib.rs` still has two work-dir-relative `is_file()` calls (the lines formerly src/lib.rs:59 and 71). publish #2 proved wasm `is_file()` is unreliable on **absolute** paths (C1). Relative WASI-preopen paths are a different class and likely OK, so they are NOT changed in this plan. If the download-path dogfood (handed-to-user ops, below) reproduces a misfire, apply the matching patch:

**C2-a — cache-hit line (`if !entry.is_file()` guarding the download):** if it misfires, the artifact re-downloads every launch (non-fatal). Fix: judge cache presence by directory existence instead of the entry file:
```rust
// Replace the entry-file is_file() cache gate with a dir-existence probe:
let cache_present = std::fs::read_dir(&cache_dir).is_ok();
if !cache_present {
    // ... existing download/extract block ...
}
```

**C2-b — post-extract verify line (`if !entry.is_file() { return Err(... "artifact entry missing" ...) }`):** FATAL if it misfires — extract succeeds but the stat reports false → never launches. Fix: drop the post-extract stat entirely and trust `download_file`'s `Ok` (same reasoning as C1; Node reports its own launch failure):
```rust
// Delete the post-extract `if !entry.is_file() { return Err(...) }` block.
// download_file returned Ok — proceed to return the entry path.
```

---

## Handed-to-user ops (agent cannot push repo / cut Release — harness push block)

After all three tasks are committed:

1. **dogfood A (restructure):** remove the old root-installed dev extension in Zed, then `zed: install dev extension` pointing at `packages/zed/`. Confirm highlight + outline still work on a `.wxml` file (grammar still public-repo `fef7ea7`; LSP still via `WXML_ZED_LSP_ARTIFACT_DIR` env or the expected 404). This validates only that the moved surface isn't broken.
2. **cut a test Release:** `git tag v0.3.0 && git push origin v0.3.0` → the workflow runs → confirm a Release `v0.3.0` exists carrying `wxml-lsp-node-v0.3.0.tar.gz`.
3. **dogfood B (download path):** unset `WXML_ZED_LSP_ARTIFACT_DIR`, restart Zed, confirm the extension downloads the artifact from the Release and launches the LSP (F12 go-to-definition works). **Watch the two relative `is_file()` lines** — if download silently fails or re-downloads every launch, apply C2-a/C2-b above.

---

## Self-Review

- **Spec coverage:** §1 restructure → Task 1 (move + LICENSE/NOTICE + Cargo bump). §1 verifier path updates → Task 1 Steps 4-6. §1 slim README + minimal root README → Task 2. §2 Release CI + four-way guard → Task 3. §3 C2-a/C2-b → Standby section. §4 in-repo vs ops split → Tasks 1-3 (agent) + Handed-to-user ops section. Verification gates → Task 1 Step 8.
- **Placeholders:** none — every edit shows exact path + content or exact command.
- **Type/name consistency:** `EXTENSION_DIR`, asset name `wxml-lsp-node-v0.3.0.tar.gz`, `WXML_ZED_LSP_ARTIFACT_DIR`, and version `0.3.0` used consistently across tasks.
