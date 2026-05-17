#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTRACTOR = path.join(ROOT, "scripts/poc-js-method-extractor.mjs");
const DIFF = path.join(ROOT, "scripts/diff-symbols-baseline.mjs");
const BASELINE = path.join(ROOT, "fixtures/wasm-spike/js-methods-baseline.json");

const FIXTURES = [
  "fixtures/wasm-spike/sample-page.js",
  "fixtures/wasm-spike/sample-component.js",
  "fixtures/wasm-spike/broken-page.js",
];

function runNode(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath, ...args], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  process.stdout.write(`[verify-js-method-baselines] ${FIXTURES.length} fixtures ... `);
  const extractor = await runNode(EXTRACTOR, FIXTURES);
  if (extractor.code !== 0) {
    process.stdout.write("FAIL\n");
    process.stderr.write(`  extractor exit ${extractor.code}\n  stderr: ${extractor.stderr.trim()}\n`);
    process.exit(1);
  }
  const tmpPath = path.join(process.env.TMPDIR || "/tmp", "js-methods-actual.json");
  await fs.writeFile(tmpPath, extractor.stdout);

  const diff = await runNode(DIFF, [tmpPath, BASELINE]);
  if (diff.code !== 0) {
    process.stdout.write("FAIL\n");
    process.stderr.write(`  ${diff.stderr.trim()}\n  ${diff.stdout.trim()}\n`);
    process.exit(1);
  }
  process.stdout.write("PASS\n");
  process.stdout.write("\nAll JS method baselines match.\n");
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${err?.message || err}\n`);
  process.exit(1);
});
