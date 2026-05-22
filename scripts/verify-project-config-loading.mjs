#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadProjectConfig } from "../shared/project-config.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mkTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wxml-zed-config-test-"));
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured.join("");
}

function testCL1MissingFile() {
  const root = mkTmpProject();
  try {
    let result;
    const stderr = captureStderr(() => {
      result = loadProjectConfig(root);
    });
    assert(result.dataInjectors.length === 0, `C-L1: expected empty injectors; got ${JSON.stringify(result)}`);
    assert(stderr === "", `C-L1: expected no stderr; got ${JSON.stringify(stderr)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCL2MalformedJson() {
  const root = mkTmpProject();
  try {
    fs.writeFileSync(path.join(root, "wxml-zed.config.json"), "{ not valid json", "utf8");
    let result;
    const stderr = captureStderr(() => {
      result = loadProjectConfig(root);
    });
    assert(result.dataInjectors.length === 0, `C-L2: expected empty injectors; got ${JSON.stringify(result)}`);
    assert(stderr.includes("failed to parse"), `C-L2: expected stderr to mention failed parse; got ${JSON.stringify(stderr)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCL3ValidFullConfig() {
  const root = mkTmpProject();
  try {
    const config = {
      dataInjectors: [
        {
          className: "LoadStates",
          constructorArgs: ["name"],
          methods: {
            applyTo: ["${name}_state", "${name}_states"],
            applyStateTo: ["${name}_state"],
          },
        },
      ],
    };
    fs.writeFileSync(path.join(root, "wxml-zed.config.json"), JSON.stringify(config), "utf8");
    let result;
    const stderr = captureStderr(() => {
      result = loadProjectConfig(root);
    });
    assert(stderr === "", `C-L3: expected no stderr; got ${JSON.stringify(stderr)}`);
    assert(result.dataInjectors.length === 1, `C-L3: expected 1 injector; got ${result.dataInjectors.length}`);
    const entry = result.dataInjectors[0];
    assert(entry.className === "LoadStates", `C-L3: className ${entry.className}`);
    assert(entry.constructorArgs.length === 1 && entry.constructorArgs[0] === "name", `C-L3: constructorArgs ${JSON.stringify(entry.constructorArgs)}`);
    assert(Object.keys(entry.methods).length === 2, `C-L3: methods count ${Object.keys(entry.methods).length}`);
    assert(entry.methods.applyTo.length === 2, `C-L3: applyTo produces count ${entry.methods.applyTo.length}`);
    assert(entry.methods.applyStateTo.length === 1, `C-L3: applyStateTo produces count ${entry.methods.applyStateTo.length}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCL4MixedValidInvalid() {
  const root = mkTmpProject();
  try {
    const config = {
      dataInjectors: [
        {
          className: "LoadStates",
          constructorArgs: ["name"],
          methods: { applyTo: ["${name}_state"] },
        },
        {
          constructorArgs: ["name"],
          methods: { applyTo: ["${name}_state"] },
        },
        {
          className: "X",
          constructorArgs: [],
          methods: { applyTo: ["static_x"] },
        },
        {
          className: "States",
          constructorArgs: ["name"],
          methods: { applyTo: ["${name}_state"] },
        },
      ],
    };
    fs.writeFileSync(path.join(root, "wxml-zed.config.json"), JSON.stringify(config), "utf8");
    let result;
    const stderr = captureStderr(() => {
      result = loadProjectConfig(root);
    });
    assert(result.dataInjectors.length === 2, `C-L4: expected 2 valid injectors; got ${result.dataInjectors.length}`);
    assert(result.dataInjectors[0].className === "LoadStates", "C-L4: first valid is LoadStates");
    assert(result.dataInjectors[1].className === "States", "C-L4: second valid is States");
    assert(stderr.includes("dataInjectors[1]"), `C-L4: expected stderr to mention index 1; got ${JSON.stringify(stderr)}`);
    assert(stderr.includes("dataInjectors[2]"), `C-L4: expected stderr to mention index 2; got ${JSON.stringify(stderr)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCL5EmptyConstructorArgs() {
  const root = mkTmpProject();
  try {
    const config = {
      dataInjectors: [
        {
          className: "X",
          constructorArgs: [],
          methods: { applyTo: ["static_x"] },
        },
      ],
    };
    fs.writeFileSync(path.join(root, "wxml-zed.config.json"), JSON.stringify(config), "utf8");
    let result;
    const stderr = captureStderr(() => {
      result = loadProjectConfig(root);
    });
    assert(result.dataInjectors.length === 0, `C-L5: expected 0 injectors; got ${result.dataInjectors.length}`);
    assert(stderr.includes("constructorArgs must be a non-empty array"), `C-L5: expected stderr to mention empty constructorArgs; got ${JSON.stringify(stderr)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const CASES = [
  ["C-L1: missing file returns empty", testCL1MissingFile],
  ["C-L2: malformed JSON returns empty with stderr warn", testCL2MalformedJson],
  ["C-L3: valid config returns normalized injectors", testCL3ValidFullConfig],
  ["C-L4: mixed valid+invalid entries - valid kept, invalid warn+skip", testCL4MixedValidInvalid],
  ["C-L5: empty constructorArgs explicitly rejected", testCL5EmptyConstructorArgs],
];

let passed = 0;
let failed = 0;
for (const [label, fn] of CASES) {
  try {
    fn();
    process.stdout.write(`PASS ${label}\n`);
    passed += 1;
  } catch (err) {
    process.stdout.write(`FAIL ${label}\n  ${err.message}\n`);
    failed += 1;
  }
}
process.stdout.write(`\nResult: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
