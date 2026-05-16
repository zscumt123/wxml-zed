#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTRACTOR = path.join(ROOT, "scripts/extract-wxml-symbols.mjs");
const DIFF = path.join(ROOT, "scripts/diff-symbols-baseline.mjs");
const BASELINE_DIR = path.join(ROOT, "fixtures/wasm-spike");

const CASES = [
  {
    name: "home.wxml",
    files: ["fixtures/miniprogram/pages/home/home.wxml"],
    baseline: "home-symbols-baseline.json",
    expectExit: 0,
  },
  {
    name: "miniprogram (11 fixtures)",
    files: null,
    glob: "fixtures/miniprogram",
    baseline: "miniprogram-symbols-baseline.json",
    expectExit: 0,
  },
  {
    name: "test.wxml",
    files: ["fixtures/test.wxml"],
    baseline: "test-wxml-symbols-baseline.json",
    expectExit: 0,
  },
  {
    name: "real-world (3 fixtures, edge-recovery excluded)",
    files: [
      "fixtures/real-world/component.wxml",
      "fixtures/real-world/page.wxml",
      "fixtures/real-world/templates.wxml",
    ],
    baseline: "real-world-symbols-baseline.json",
    expectExit: 0,
  },
  {
    name: "edge-recovery.wxml (parse-error recovery)",
    files: ["fixtures/real-world/edge-recovery.wxml"],
    baseline: "edge-recovery-symbols-baseline.json",
    expectExit: 0,
  },
];

async function collectGlobFiles(dir) {
  const out = [];
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".wxml")) out.push(path.relative(ROOT, full));
    }
  };
  await walk(path.resolve(ROOT, dir));
  out.sort();
  return out;
}

function runNode(scriptPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath, ...args], { cwd: ROOT, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runCase(c) {
  const files = c.files ?? (await collectGlobFiles(c.glob));
  const extractor = await runNode(EXTRACTOR, files);
  if (extractor.code !== c.expectExit) {
    return {
      ok: false,
      reason: `extractor exit ${extractor.code} !== expected ${c.expectExit}\nstderr: ${extractor.stderr.trim()}`,
    };
  }

  const tmpPath = path.join(process.env.TMPDIR || "/tmp", `wasm-baseline-${path.basename(c.baseline)}`);
  await fs.writeFile(tmpPath, extractor.stdout);

  const baselinePath = path.join(BASELINE_DIR, c.baseline);
  const diff = await runNode(DIFF, [tmpPath, baselinePath]);
  if (diff.code !== 0) {
    return {
      ok: false,
      reason: `diff exited ${diff.code}\n${diff.stderr.trim()}\n${diff.stdout.trim()}`,
    };
  }

  return { ok: true };
}

async function main() {
  let failed = 0;
  for (const c of CASES) {
    process.stdout.write(`[verify-wasm-symbol-baselines] ${c.name} ... `);
    try {
      const result = await runCase(c);
      if (result.ok) {
        process.stdout.write("PASS\n");
      } else {
        process.stdout.write("FAIL\n");
        process.stderr.write(`  ${result.reason}\n`);
        failed++;
      }
    } catch (err) {
      process.stdout.write("FAIL\n");
      process.stderr.write(`  threw: ${err?.message || err}\n`);
      failed++;
    }
  }
  if (failed > 0) {
    process.stderr.write(`\n${failed} of ${CASES.length} baseline cases failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\nAll ${CASES.length} wasm symbol baselines match.\n`);
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${err?.message || err}\n`);
  process.exit(1);
});
