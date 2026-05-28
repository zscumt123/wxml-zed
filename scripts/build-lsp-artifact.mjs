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
  if (typeof wtsVersion !== "string" || wtsVersion.length === 0) {
    throw new Error("build-lsp-artifact: could not read web-tree-sitter version from its package.json");
  }
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
