#!/usr/bin/env node
// Audit tool: run wxml-zed diagnostics over an entire mini-program project
// and dump a JSONL stream + a human-readable summary. Used to drive noise-
// reduction work (categorize false positives, then fix extractor/scope/
// suppression based on real-project distribution).
//
// Usage:
//   node scripts/dump-project-diagnostics.mjs <projectRoot> [--out <dir>] [--snippet-context N]
//
// Outputs (under --out, default /tmp/wxml-zed-diagnostics/):
//   <basename>.jsonl         — one diagnostic per line, sorted by (file, line, character)
//   <basename>.summary.txt   — human-readable distribution + top-N by code + by missing name
//   <basename>.summary.json  — machine-readable {counts, byCode, byName} for run-over-run diff
//
// Output files are NEVER written into the repo. Pass --out or accept the
// /tmp default; both keep audit data out of git history.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDiagnostics } from "../server/wxml-language-service.mjs";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH_EXTRACTOR = path.join(EXTENSION_ROOT, "scripts/extract-wxml-project-graph.mjs");
const DEFAULT_OUT_DIR = path.join(os.tmpdir(), "wxml-zed-diagnostics");

const MESSAGE_NAME_PATTERNS = {
  "missing-event-handler": /^Event handler "(.+?)" is not defined/,
  "missing-expression-ref": /^"(.+?)" is not defined in the page\/component/,
  "missing-local-component": /^Missing local component "(.+?)":/,
};

function extractName(diag) {
  const pattern = MESSAGE_NAME_PATTERNS[diag.code];
  if (!pattern) return null;
  const match = pattern.exec(diag.message || "");
  return match ? match[1] : null;
}

function parseArgs(argv) {
  const args = { projectRoot: undefined, outDir: DEFAULT_OUT_DIR, snippetContext: 3 };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--out-dir") {
      args.outDir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--out=")) {
      args.outDir = arg.slice("--out=".length);
    } else if (arg === "--snippet-context") {
      args.snippetContext = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--snippet-context=")) {
      args.snippetContext = Number(arg.slice("--snippet-context=".length));
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      positional.push(arg);
    }
  }
  args.projectRoot = positional[0];
  return args;
}

function usageAndExit(code = 1) {
  const msg = [
    "Usage: node scripts/dump-project-diagnostics.mjs <projectRoot> [--out <dir>] [--snippet-context N]",
    "",
    "  <projectRoot>         absolute or relative path to a mini-program root (containing app.json)",
    "  --out <dir>           output directory (default: /tmp/wxml-zed-diagnostics/)",
    "  --snippet-context N   lines of WXML context above/below each diagnostic (default: 3)",
  ].join("\n");
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function runGraphExtractor(projectRoot) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [GRAPH_EXTRACTOR, projectRoot], {
      cwd: EXTENSION_ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        err.message = stderr ? `${err.message}\n${stderr}` : err.message;
        reject(err);
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function captureProjectMeta(projectRoot) {
  const head = await runGit(["rev-parse", "HEAD"], projectRoot);
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], projectRoot);
  const dirty = await runGit(["status", "--porcelain"], projectRoot);
  return {
    head: head || null,
    branch: branch || null,
    dirtyCount: dirty ? dirty.split("\n").filter(Boolean).length : 0,
  };
}

function readSnippet(absolutePath, line, context) {
  let text;
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, line - context);
  const end = Math.min(lines.length, line + context + 1);
  return lines.slice(start, end).map((source, idx) => ({
    line: start + idx,
    marker: start + idx === line ? ">" : " ",
    source,
  }));
}

function compareEntries(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.character !== b.character) return a.character - b.character;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return 0;
}

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function buildSummary(entries, meta, projectRoot) {
  const byCode = new Map();
  const byCodeName = new Map(); // code -> Map(name -> count)
  for (const entry of entries) {
    byCode.set(entry.code, (byCode.get(entry.code) || 0) + 1);
    if (entry.name) {
      const codeNames = byCodeName.get(entry.code) || new Map();
      codeNames.set(entry.name, (codeNames.get(entry.name) || 0) + 1);
      byCodeName.set(entry.code, codeNames);
    }
  }

  const text = [];
  text.push(`wxml-zed diagnostics dump`);
  text.push(`==========================`);
  text.push(`project root : ${projectRoot}`);
  text.push(`git branch   : ${meta.branch ?? "(not a git repo)"}`);
  text.push(`git HEAD     : ${meta.head ?? "(not a git repo)"}`);
  text.push(`dirty files  : ${meta.dirtyCount}`);
  if (meta.dirtyCount > 0) {
    text.push(`             ^ WARNING: working-tree dump, NOT a clean release baseline`);
  }
  text.push(`total        : ${entries.length}`);
  text.push("");

  text.push(`By code`);
  text.push(`-------`);
  for (const [code, count] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / Math.max(entries.length, 1)) * 100).toFixed(1);
    text.push(`  ${count.toString().padStart(5)}  ${pct.padStart(5)}%   ${code}`);
  }
  text.push("");

  for (const [code, names] of byCodeName) {
    text.push(`Top names for ${code} (showing top 20 / ${names.size} distinct)`);
    text.push(`${"-".repeat(40)}`);
    for (const [name, count] of topN(names, 20)) {
      text.push(`  ${count.toString().padStart(5)}   ${name}`);
    }
    text.push("");
  }

  const json = {
    projectRoot,
    meta,
    total: entries.length,
    byCode: Object.fromEntries(byCode),
    byName: Object.fromEntries(
      [...byCodeName.entries()].map(([code, names]) => [code, Object.fromEntries(names)]),
    ),
  };

  return { text: text.join("\n") + "\n", json };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.projectRoot) {
    usageAndExit(args.help ? 0 : 1);
  }

  const projectRoot = path.resolve(args.projectRoot);
  if (!fs.existsSync(path.join(projectRoot, "app.json"))) {
    process.stderr.write(`error: no app.json at ${projectRoot}\n`);
    process.exit(2);
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const basename = path.basename(projectRoot);
  const jsonlPath = path.join(args.outDir, `${basename}.jsonl`);
  const summaryTxtPath = path.join(args.outDir, `${basename}.summary.txt`);
  const summaryJsonPath = path.join(args.outDir, `${basename}.summary.json`);

  process.stderr.write(`[dump] building project graph for ${projectRoot} ...\n`);
  const graph = await runGraphExtractor(projectRoot);
  process.stderr.write(`[dump] graph built: ${graph.wxml.length} .wxml files\n`);

  const meta = await captureProjectMeta(projectRoot);

  const entries = [];
  for (const wxmlEntry of graph.wxml) {
    const absolutePath = path.resolve(EXTENSION_ROOT, wxmlEntry.path);
    let diags;
    try {
      diags = getDiagnostics({
        graph,
        documentPath: absolutePath,
        extensionRoot: EXTENSION_ROOT,
      });
    } catch (err) {
      process.stderr.write(`[dump] getDiagnostics failed for ${absolutePath}: ${err?.message || err}\n`);
      continue;
    }
    if (!Array.isArray(diags) || diags.length === 0) continue;

    const projectRelative = path.relative(projectRoot, absolutePath);
    for (const diag of diags) {
      const line = diag.range?.start?.line ?? 0;
      const character = diag.range?.start?.character ?? 0;
      entries.push({
        file: projectRelative,
        line,
        character,
        code: diag.code,
        message: diag.message,
        name: extractName(diag),
        snippet: readSnippet(absolutePath, line, args.snippetContext),
      });
    }
  }

  entries.sort(compareEntries);

  const jsonlStream = fs.createWriteStream(jsonlPath);
  for (const entry of entries) {
    jsonlStream.write(`${JSON.stringify(entry)}\n`);
  }
  await new Promise((resolve, reject) => {
    jsonlStream.end((err) => (err ? reject(err) : resolve()));
  });

  const { text, json } = buildSummary(entries, meta, projectRoot);
  fs.writeFileSync(summaryTxtPath, text, "utf8");
  fs.writeFileSync(summaryJsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");

  process.stdout.write(text);
  process.stderr.write(`\n[dump] wrote:\n  ${jsonlPath}\n  ${summaryTxtPath}\n  ${summaryJsonPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`[dump] fatal: ${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
