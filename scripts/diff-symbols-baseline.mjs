#!/usr/bin/env node
import fs from "node:fs/promises";

function sortDeterministic(value) {
  if (Array.isArray(value)) {
    const sorted = value.map(sortDeterministic);
    sorted.sort((a, b) => {
      if (typeof a?.path === "string" && typeof b?.path === "string" && a.path !== b.path) {
        return a.path.localeCompare(b.path);
      }
      const ar = a?.range?.start, br = b?.range?.start;
      if (ar && br) {
        if (ar.row !== br.row) return ar.row - br.row;
        if (ar.column !== br.column) return ar.column - br.column;
      }
      return JSON.stringify(a).localeCompare(JSON.stringify(b));
    });
    return sorted;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortDeterministic(value[k]);
    return out;
  }
  return value;
}

function firstDiff(a, b, p = "$") {
  if (typeof a !== typeof b) return `${p}: type ${typeof a} vs ${typeof b}`;
  if (a === null || typeof a !== "object") {
    if (a !== b) return `${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    return null;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: array vs object`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${p}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const child = a[i];
      const label = (typeof child?.path === "string") ? `[${child.path}]` : `[${i}]`;
      const d = firstDiff(a[i], b[i], `${p}${label}`);
      if (d) return d;
    }
    return null;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) {
    return `${p}: keys ${ak.length} vs ${bk.length} (left=${ak.join(",")} right=${bk.join(",")})`;
  }
  for (const k of ak) {
    if (!Object.hasOwn(b, k)) return `${p}: missing key ${k} on right`;
    const d = firstDiff(a[k], b[k], `${p}.${k}`);
    if (d) return d;
  }
  return null;
}

async function main() {
  const [pocPath, baselinePath] = process.argv.slice(2);
  if (!pocPath || !baselinePath) {
    console.error("Usage: node scripts/diff-symbols-baseline.mjs <poc.json> <baseline.json>");
    process.exit(1);
  }
  const poc = JSON.parse(await fs.readFile(pocPath, "utf8"));
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
  const nPoc = sortDeterministic(poc);
  const nBase = sortDeterministic(baseline);
  const diff = firstDiff(nPoc, nBase);
  if (diff) {
    console.error("DIFF:", diff);
    process.exit(1);
  }
  console.log("OK: structurally equivalent");
}

main().catch((e) => {
  console.error("FAIL:", e?.message || e);
  process.exit(1);
});
