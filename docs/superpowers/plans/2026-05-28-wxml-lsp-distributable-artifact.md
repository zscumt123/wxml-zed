# WXML LSP Distributable Artifact (publish-readiness #1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-repo Node LSP runnable from a self-contained artifact unpacked anywhere, proven by an offline smoke that runs it outside the repo and exercises a JS-backed feature.

**Architecture:** A packaging script copies the LSP's runtime closure (preserving repo-relative structure, so paths resolve with zero code changes) plus a vendored `web-tree-sitter` and BOTH grammar wasms into `dist/wxml-lsp-node/`, and tars it. A self-contained smoke (its own minimal stdio LSP client — no coupling to repo test infra) unpacks the tarball under `$TMPDIR`, runs `node <unpacked>/server/wxml-lsp.mjs` from a non-repo cwd, and asserts a JS-backed go-to-definition resolves (proving owner-script extraction worked) with no `JS wasm load failed` on stderr. A baked-in negative control (strip the JS wasm from a copy → definition must then fail) proves the smoke discriminates.

**Tech Stack:** Node ESM (v24), system `tar`, `web-tree-sitter`, no test framework (plain `assert`, scripts exit non-zero on failure).

**Spec:** `docs/superpowers/specs/2026-05-28-wxml-lsp-distributable-artifact-design.md`

---

## File Structure

- **Modify** `package.json` — add `"version": "0.3.0"` (the packaging script reads it for the tarball name + artifact `package.json`).
- **Modify** `.gitignore` — add `/dist` (build output, never committed).
- **Create** `scripts/build-lsp-artifact.mjs` — assembles `dist/wxml-lsp-node/` + `dist/wxml-lsp-node-v<version>.tar.gz`. [Task 1]
- **Create** `scripts/verify-lsp-artifact.mjs` — offline standalone smoke + negative control. [Task 2]

No runtime code (`server/`, `shared/`, `scripts/extract-*`) is modified — the zero-code-change premise. If the smoke reveals a path that does not resolve standalone, the fix goes in the packaging copy-set, not runtime code (and any unavoidable runtime edit is surfaced as a finding).

---

## Task 1: Packaging script that produces the artifact + tarball

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `scripts/build-lsp-artifact.mjs`

- [ ] **Step 1: Add a version to `package.json`**

Replace:
```json
{
  "name": "wxml-zed",
  "private": true,
  "type": "module",
  "dependencies": {
    "web-tree-sitter": "0.25.10"
  }
}
```
with:
```json
{
  "name": "wxml-zed",
  "version": "0.3.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "web-tree-sitter": "0.25.10"
  }
}
```

- [ ] **Step 2: Ignore `/dist`**

In `.gitignore`, add `/dist` (append a line). Result:
```
/grammars
/target
extension.wasm
/node_modules
/dist
```

- [ ] **Step 3: Write the packaging script**

Create `scripts/build-lsp-artifact.mjs`:
```js
#!/usr/bin/env node
// Assembles the self-contained WXML LSP artifact (repo-runtime-subset layout)
// into dist/wxml-lsp-node/ and tars it. Preserves repo-relative paths so the
// LSP's EXTENSION_ROOT/spawn-chain/wasm paths resolve with zero code changes;
// vendors web-tree-sitter so the bare import resolves from the artifact.
// See docs/superpowers/specs/2026-05-28-wxml-lsp-distributable-artifact-design.md
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const DIST = path.join(ROOT, "dist");
const ARTIFACT_DIR = path.join(DIST, "wxml-lsp-node");

// Runtime closure, repo-relative paths preserved. shared/ is copied whole
// (6 small files) so no transitive import is missed; only the two runtime
// scripts are taken (not the verifiers/profilers); BOTH grammar wasms travel.
const FILES = [
  "server/wxml-lsp.mjs",
  "server/wxml-language-service.mjs",
  "server/wxml-hover.mjs",
  "server/wxml-for-scope.mjs",
  "shared/wxml-symbol-extractor.mjs",
  "shared/js-method-extractor.mjs",
  "shared/project-config.mjs",
  "shared/wxml-builtins.mjs",
  "shared/event-binding-patterns.mjs",
  "shared/wxml-expression-helpers.mjs",
  "scripts/extract-wxml-project-graph.mjs",
  "scripts/extract-wxml-symbols.mjs",
  "grammar/tree-sitter-wxml/tree-sitter-wxml.wasm",
  "grammar/tree-sitter-javascript/tree-sitter-javascript.wasm",
  "LICENSE",
  "NOTICE",
];

async function copyInto(rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(ARTIFACT_DIR, rel);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.cp(src, dst, { recursive: true });
}

async function main() {
  await fsp.rm(ARTIFACT_DIR, { recursive: true, force: true });
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });

  for (const rel of FILES) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      throw new Error(`build-lsp-artifact: source missing: ${rel}`);
    }
    await copyInto(rel);
  }

  // Vendor web-tree-sitter so `import "web-tree-sitter"` resolves from the
  // artifact's node_modules (and its own tree-sitter.wasm travels inside it).
  const wtsSrc = path.join(ROOT, "node_modules/web-tree-sitter");
  if (!fs.existsSync(wtsSrc)) {
    throw new Error("build-lsp-artifact: node_modules/web-tree-sitter missing — run `npm install` first");
  }
  await fsp.cp(wtsSrc, path.join(ARTIFACT_DIR, "node_modules/web-tree-sitter"), { recursive: true });

  // Minimal artifact package.json.
  const wtsVersion = JSON.parse(
    fs.readFileSync(path.join(wtsSrc, "package.json"), "utf8"),
  ).version;
  await fsp.writeFile(
    path.join(ARTIFACT_DIR, "package.json"),
    JSON.stringify(
      {
        name: "wxml-lsp-node",
        version: VERSION,
        private: true,
        type: "module",
        dependencies: { "web-tree-sitter": wtsVersion },
      },
      null,
      2,
    ) + "\n",
  );

  // Tarball (root entry is the wxml-lsp-node/ dir).
  const tarName = `wxml-lsp-node-v${VERSION}.tar.gz`;
  execFileSync("tar", ["-czf", path.join(DIST, tarName), "-C", DIST, "wxml-lsp-node"], {
    stdio: "inherit",
  });

  console.log(`built dist/wxml-lsp-node + dist/${tarName}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Run the build and assert the artifact tree**

Run:
```bash
node scripts/build-lsp-artifact.mjs
echo "--- entry + both wasms + vendored dep + metadata present? ---"
ls dist/wxml-lsp-node/server/wxml-lsp.mjs \
   dist/wxml-lsp-node/grammar/tree-sitter-wxml/tree-sitter-wxml.wasm \
   dist/wxml-lsp-node/grammar/tree-sitter-javascript/tree-sitter-javascript.wasm \
   dist/wxml-lsp-node/node_modules/web-tree-sitter/package.json \
   dist/wxml-lsp-node/package.json \
   dist/wxml-lsp-node/LICENSE dist/wxml-lsp-node/NOTICE \
   dist/wxml-lsp-node-v0.3.0.tar.gz
echo "--- web-tree-sitter core wasm travels inside vendored pkg? ---"
ls dist/wxml-lsp-node/node_modules/web-tree-sitter/tree-sitter.wasm
```
Expected: every `ls` target exists (no "No such file"). This confirms the copy-set (both grammar wasms, the vendored dep + its core wasm, metadata) and the tarball.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore scripts/build-lsp-artifact.mjs
git commit -m "build(lsp): packaging script for self-contained LSP artifact (publish-readiness #1)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Offline standalone smoke + negative control

**Files:**
- Create: `scripts/verify-lsp-artifact.mjs`

- [ ] **Step 1: Write the smoke verifier**

Create `scripts/verify-lsp-artifact.mjs`:
```js
#!/usr/bin/env node
// Offline proof that the packaged LSP runs detached from the source repo.
// Builds the artifact, unpacks it under $TMPDIR (outside the repo subtree),
// runs `node <unpacked>/server/wxml-lsp.mjs` from a non-repo cwd, and asserts
// a JS-backed go-to-definition resolves (handleSelect -> home.js), proving
// owner-script extraction worked (tree-sitter-javascript.wasm loaded) with no
// "JS wasm load failed" on stderr. A negative control strips the JS wasm from a
// copy and asserts the same definition then FAILS, proving the smoke
// discriminates. Uses its own minimal stdio LSP client — no repo test infra.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMPBASE = process.env.TMPDIR || os.tmpdir();
const HOME_WXML = path.join(ROOT, "fixtures/miniprogram/pages/home/home.wxml");
const PROJECT_ROOT = path.join(ROOT, "fixtures/miniprogram");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

class Lsp {
  constructor(serverEntry, cwd) {
    this.proc = spawn("node", [serverEntry], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.stderr = "";
    this.seq = 0;
    this.diagWaiters = [];
    this.diagSeen = new Map();
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => {
      this.stderr += d.toString();
    });
  }
  _send(msg) {
    const s = JSON.stringify(msg);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  }
  request(method, params) {
    const id = ++this.seq;
    this._send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}\nstderr:\n${this.stderr}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }
  waitForDiagnostics(uri) {
    if (this.diagSeen.has(uri)) return Promise.resolve(this.diagSeen.get(uri));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for diagnostics: ${uri}\nstderr:\n${this.stderr}`)),
        30000,
      );
      this.diagWaiters.push({ uri, resolve, timer });
    });
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const m = /Content-Length: (\d+)/i.exec(this.buf.slice(0, headerEnd).toString());
      if (!m) {
        this.buf = this.buf.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) break;
      const body = this.buf.slice(start, start + len).toString();
      this.buf = this.buf.slice(start + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        resolve(msg);
      } else if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
        const u = msg.params.uri;
        this.diagSeen.set(u, msg.params);
        this.diagWaiters = this.diagWaiters.filter((w) => {
          if (w.uri === u) {
            clearTimeout(w.timer);
            w.resolve(msg.params);
            return false;
          }
          return true;
        });
      }
    }
  }
  close() {
    this.proc.kill();
  }
}

// Drive an LSP at `entry` (cwd outside repo) and return whether go-to-definition
// on `handleSelect` in home.wxml resolves into home.js. Captures stderr.
async function definitionResolvesToJs(entry, cwd) {
  const lsp = new Lsp(entry, cwd);
  try {
    await lsp.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(PROJECT_ROOT).href,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(PROJECT_ROOT).href, name: "miniprogram" }],
    });
    lsp.notify("initialized", {});

    const text = fs.readFileSync(HOME_WXML, "utf8");
    const uri = pathToFileURL(HOME_WXML).href;
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "wxml", version: 1, text },
    });

    // Wait until the LSP has built the project graph (it publishes diagnostics
    // for the doc once ready — home.wxml always has at least the missing-card
    // diagnostic, in both the good and JS-wasm-stripped cases, since that is a
    // WXML/graph-side diagnostic independent of JS owner-script extraction).
    await lsp.waitForDiagnostics(uri);

    const lines = text.split("\n");
    const lineIdx = lines.findIndex((l) => l.includes("handleSelect"));
    assert(lineIdx >= 0, "smoke setup: handleSelect not found in home.wxml");
    const character = lines[lineIdx].indexOf("handleSelect") + 2;

    const resp = await lsp.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: lineIdx, character },
    });
    const result = resp.result;
    const loc = Array.isArray(result) ? result[0] : result;
    const resolvedToJs = Boolean(loc && typeof loc.uri === "string" && loc.uri.endsWith("/home.js"));
    return { resolvedToJs, stderr: lsp.stderr };
  } finally {
    lsp.close();
  }
}

async function main() {
  // 1. Build a fresh artifact.
  execFileSync("node", [path.join(ROOT, "scripts/build-lsp-artifact.mjs")], { stdio: "inherit" });
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const tarball = path.join(ROOT, "dist", `wxml-lsp-node-v${version}.tar.gz`);
  assert(fs.existsSync(tarball), `tarball not built: ${tarball}`);

  // 2. Unpack OUTSIDE the repo subtree (structural guarantee: no repo
  //    node_modules is reachable up the directory tree from here).
  const unpackBase = await fsp.mkdtemp(path.join(TMPBASE, "wxml-lsp-smoke-"));
  execFileSync("tar", ["-xzf", tarball, "-C", unpackBase], { stdio: "inherit" });
  const artifact = path.join(unpackBase, "wxml-lsp-node");
  const entry = path.join(artifact, "server/wxml-lsp.mjs");
  assert(fs.existsSync(entry), `artifact entry missing: ${entry}`);
  assert(!artifact.startsWith(ROOT + path.sep), `artifact must be outside the repo; got ${artifact}`);

  // 3. Dependency-resolution guard: web-tree-sitter must resolve from the
  //    artifact, not the repo. Probe from a file beside the entry.
  const probe = path.join(artifact, "__resolve_probe.mjs");
  await fsp.writeFile(probe, `process.stdout.write(import.meta.resolve("web-tree-sitter"));\n`);
  const resolved = execFileSync("node", [probe], { cwd: artifact }).toString();
  await fsp.rm(probe, { force: true });
  assert(
    resolved.includes(artifact) && !resolved.includes(path.join(ROOT, "node_modules")),
    `web-tree-sitter must resolve under the artifact, not the repo; got ${resolved}`,
  );

  // 4. Positive: a JS-backed definition resolves with no JS-wasm warning.
  const good = await definitionResolvesToJs(entry, unpackBase);
  assert(
    good.resolvedToJs,
    `JS-backed go-to-definition (handleSelect -> home.js) failed against the artifact; stderr:\n${good.stderr}`,
  );
  assert(
    !/JS wasm load failed/.test(good.stderr),
    `artifact emitted a JS-wasm load failure; stderr:\n${good.stderr}`,
  );

  // 5. Negative control: strip the JS wasm from a copy; the same definition
  //    must now FAIL — proving the positive check actually discriminates.
  const brokenBase = await fsp.mkdtemp(path.join(TMPBASE, "wxml-lsp-smoke-broken-"));
  await fsp.cp(artifact, path.join(brokenBase, "wxml-lsp-node"), { recursive: true });
  const brokenArtifact = path.join(brokenBase, "wxml-lsp-node");
  await fsp.rm(path.join(brokenArtifact, "grammar/tree-sitter-javascript/tree-sitter-javascript.wasm"), {
    force: true,
  });
  const broken = await definitionResolvesToJs(path.join(brokenArtifact, "server/wxml-lsp.mjs"), brokenBase);
  assert(
    !broken.resolvedToJs,
    `negative control failed: definition still resolved with the JS wasm removed — the smoke is not discriminating`,
  );

  console.log("OK: artifact runs standalone; JS-backed feature works; negative control confirms discrimination");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the smoke — expect green**

Run: `node scripts/verify-lsp-artifact.mjs; echo "exit=$?"`
Expected: prints `OK: artifact runs standalone; JS-backed feature works; negative control confirms discrimination` and `exit=0`.

This proves: (a) the unpacked artifact runs `node server/wxml-lsp.mjs` from outside the repo; (b) `web-tree-sitter` resolves from the artifact; (c) a JS-backed go-to-definition works (so `tree-sitter-javascript.wasm` loaded and `configs[].script` populated) with no JS-wasm warning; (d) removing the JS wasm makes that definition fail — the smoke is non-vacuous.

- [ ] **Step 3: Confirm the rest of the suite is unaffected**

Run:
```bash
node scripts/verify-wxml-narrow-ranges.mjs
node scripts/verify-wasm-symbol-baselines.mjs
node scripts/verify-wxml-language-service.mjs; echo "ls exit=$?"
git status --short
```
Expected: narrow-ranges `20 passed, 0 failed`; wasm `All 8 ... match.`; `ls exit=0`; `git status` shows only the new untracked `scripts/verify-lsp-artifact.mjs` (and NOT `dist/`, which is git-ignored). No runtime code changed.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-lsp-artifact.mjs
git commit -m "test(lsp): offline standalone artifact smoke + JS-wasm negative control (publish-readiness #1)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-review checklist (run by plan author)

- **Spec coverage:** layout (incl both wasms + vendored dep) → Task 1 Step 3 FILES + vendor copy; `dist/` gitignore + version → Task 1 Steps 1-2; packaging script → Task 1; offline smoke unpacking under `$TMPDIR` outside repo + non-repo cwd → Task 2 Step 1 (`unpackBase` under TMPBASE, `assert !artifact.startsWith(ROOT)`); JS-backed scenario + no-`JS wasm load failed` assertion → Task 2 `definitionResolvesToJs` + stderr assert; repo-`node_modules` resolution guard → Task 2 probe; negative control (the finding-#2 spirit) → Task 2 Step 1 part 5. Deferred items (esbuild, bin/lib, in-process extractor, src/lib.rs, Release automation, repo split, grammar repo) → untouched.
- **Placeholder scan:** every step has full code or exact commands; no TBD/TODO.
- **Type/name consistency:** `dist/wxml-lsp-node/`, tar root `wxml-lsp-node`, entry `server/wxml-lsp.mjs`, version `0.3.0`, tarball `wxml-lsp-node-v0.3.0.tar.gz` consistent across Task 1 build script, Task 1 Step 4 assertions, and Task 2 smoke. `definitionResolvesToJs(entry, cwd)` signature used consistently for both positive and negative-control calls.
