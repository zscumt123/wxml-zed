#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH_EXTRACTOR = path.join(ROOT, "scripts/extract-wxml-project-graph.mjs");
const PROFILE_PREFIX = "WXML_ZED_PROFILE ";

function parseProfileEvents(stderr) {
  const events = [];
  const passthrough = [];

  for (const line of stderr.split(/\n/)) {
    if (!line.startsWith(PROFILE_PREFIX)) {
      if (line.trim()) passthrough.push(line);
      continue;
    }

    try {
      events.push(JSON.parse(line.slice(PROFILE_PREFIX.length)));
    } catch {
      passthrough.push(line);
    }
  }

  return { events, passthrough };
}

function sum(events, key) {
  return events.reduce((total, event) => total + Number(event[key] || 0), 0);
}

function formatMs(value) {
  const ms = Number(value || 0);
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(2)}ms`;
}

function printTopFiles(fileEvents) {
  const slowest = [...fileEvents]
    .sort((a, b) => Number(b.totalMs || 0) - Number(a.totalMs || 0))
    .slice(0, 10);

  if (slowest.length === 0) {
    console.log("Slowest files: none");
    return;
  }

  console.log("Slowest files:");
  for (const event of slowest) {
    console.log(`  ${formatMs(event.totalMs)} total, ${formatMs(event.cstMs)} cst - ${event.path}`);
  }
}

function printSummary(projectRoot, elapsedMs, events) {
  const fileEvents = events.filter((event) => event.type === "symbol-file");
  const batchEvents = events.filter((event) => event.type === "graph-symbol-batch");
  const graphTotal = events.find((event) => event.type === "graph-total");
  const symbolTotalEvents = events.filter((event) => event.type === "symbol-total");

  console.log(`WXML project graph profile: ${projectRoot}`);
  console.log(`Wall time: ${formatMs(elapsedMs)}`);
  if (graphTotal) {
    console.log(`Graph total: ${formatMs(graphTotal.totalMs)}`);
    console.log(`Graph counts: ${graphTotal.pageCount} pages, ${graphTotal.configCount} configs, ${graphTotal.wxmlCount} WXML, ${graphTotal.usingComponentCount} usingComponents, ${graphTotal.unresolvedCount} unresolved`);
  }
  console.log(`Symbol child time: ${formatMs(sum(batchEvents, "totalMs"))} across ${batchEvents.length} batches`);
  console.log(`Symbol total time: ${formatMs(sum(symbolTotalEvents, "totalMs"))} across ${symbolTotalEvents.length} child processes`);
  console.log(`Tree-sitter CST time: ${formatMs(sum(fileEvents, "cstMs"))} across ${fileEvents.length} files`);
  console.log(`CST parse time: ${formatMs(sum(fileEvents, "parseMs"))}`);
  console.log(`Model extraction time: ${formatMs(sum(fileEvents, "extractMs"))}`);
  printTopFiles(fileEvents);
}

const [projectRoot] = process.argv.slice(2);
if (!projectRoot) {
  console.error("Usage: node scripts/profile-wxml-project-graph.mjs <project-root>");
  process.exit(2);
}

const start = performance.now();
const result = spawnSync(process.execPath, [GRAPH_EXTRACTOR, projectRoot], {
  cwd: ROOT,
  encoding: "utf8",
  env: {
    ...process.env,
    WXML_ZED_PROFILE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  // Same reasoning as the runtime spawn sites (e5cbce4) — large
  // real-project graphs emit multi-MB stdout / profile-event stderr;
  // the default 1MB cap silently truncates and exits non-zero.
  maxBuffer: 256 * 1024 * 1024,
});
const elapsedMs = performance.now() - start;
const { events, passthrough } = parseProfileEvents(result.stderr || "");

if (passthrough.length > 0) {
  console.error([...new Set(passthrough)].join("\n"));
}

if (result.status !== 0) {
  if (result.stdout) process.stderr.write(result.stdout);
  process.exit(result.status || 1);
}

printSummary(projectRoot, elapsedMs, events);
