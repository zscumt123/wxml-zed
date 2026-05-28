#!/usr/bin/env node
// Offline proof that the packaged LSP runs detached from the source repo.
// Builds the artifact, unpacks it under $TMPDIR (outside the repo subtree),
// copies the test mini-program project out of the repo too, runs
// `node <unpacked>/server/wxml-lsp.mjs` from a non-repo cwd, and asserts a
// JS-backed go-to-definition resolves (handleSelect -> home.js), proving
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
// The repo fixture is only the SOURCE of test input; it is copied out to a temp
// dir (see main) so the artifact, its cwd, AND the opened mini-program project
// are all outside the source repo — a full "detached from source repo" proof.
const FIXTURE_SRC = path.join(ROOT, "fixtures/miniprogram");

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
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(`LSP error response: ${JSON.stringify(msg.error)}\nstderr:\n${this.stderr}`));
        } else {
          resolve(msg);
        }
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
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.proc.kill();
  }
}

// Drive an LSP at `entry` (cwd outside repo) and return whether go-to-definition
// on `handleSelect` in homeWxml resolves into home.js. Captures stderr.
async function definitionResolvesToJs(entry, cwd, projectRoot, homeWxml) {
  const lsp = new Lsp(entry, cwd);
  try {
    await lsp.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(projectRoot).href,
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(projectRoot).href, name: "miniprogram" }],
    });
    lsp.notify("initialized", {});

    const text = fs.readFileSync(homeWxml, "utf8");
    const uri = pathToFileURL(homeWxml).href;
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
    // +2: land inside the "handleSelect" token (not on its first char), so
    // go-to-definition hits the identifier regardless of exact boundary.
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
  let resolved;
  try {
    await fsp.writeFile(probe, `process.stdout.write(import.meta.resolve("web-tree-sitter"));\n`);
    resolved = execFileSync("node", [probe], { cwd: artifact }).toString();
  } finally {
    await fsp.rm(probe, { force: true });
  }
  assert(
    resolved.includes(artifact) && !resolved.includes(path.join(ROOT, "node_modules")),
    `web-tree-sitter must resolve under the artifact, not the repo; got ${resolved}`,
  );

  // License compliance: every bundled third-party component's license text must
  // travel in the artifact (the JS grammar wasm is MIT — © Max Brunsfeld — and
  // must not ship without its notice).
  for (const rel of [
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "grammar/tree-sitter-javascript/LICENSE",
    "node_modules/web-tree-sitter/LICENSE",
  ]) {
    assert(fs.existsSync(path.join(artifact, rel)), `artifact missing required license file: ${rel}`);
  }

  // Copy the mini-program project OUT of the repo too, so the artifact, its cwd,
  // and the opened project are all outside the source repo (repo = input source).
  const projectRoot = path.join(unpackBase, "project", "miniprogram");
  await fsp.cp(FIXTURE_SRC, projectRoot, { recursive: true });
  const homeWxml = path.join(projectRoot, "pages/home/home.wxml");
  assert(fs.existsSync(homeWxml), `copied fixture missing: ${homeWxml}`);

  // 4. Positive: a JS-backed definition resolves with no JS-wasm warning.
  const good = await definitionResolvesToJs(entry, unpackBase, projectRoot, homeWxml);
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
  const broken = await definitionResolvesToJs(
    path.join(brokenArtifact, "server/wxml-lsp.mjs"),
    brokenBase,
    projectRoot,
    homeWxml,
  );
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
