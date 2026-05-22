import fs from "node:fs";
import path from "node:path";

const IDENTIFIER_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function validateInjector(entry, index, configPath) {
  const warn = (reason) => {
    process.stderr.write(`[wxml-zed] dataInjectors[${index}]: ${reason}: ${configPath}\n`);
  };

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    warn("entry must be an object");
    return null;
  }

  if (typeof entry.className !== "string" || entry.className.length === 0) {
    warn("className must be a non-empty string");
    return null;
  }

  if (!Array.isArray(entry.constructorArgs) || entry.constructorArgs.length === 0) {
    warn("constructorArgs must be a non-empty array of identifier names (v1 requires >= 1)");
    return null;
  }
  for (const name of entry.constructorArgs) {
    if (typeof name !== "string" || !IDENTIFIER_SHAPE.test(name)) {
      warn(`constructorArgs entry ${JSON.stringify(name)} is not a valid identifier`);
      return null;
    }
  }

  if (!entry.methods || typeof entry.methods !== "object" || Array.isArray(entry.methods)) {
    warn("methods must be an object (method name -> produces template array)");
    return null;
  }
  const methodNames = Object.keys(entry.methods);
  if (methodNames.length === 0) {
    warn("methods must have at least one entry");
    return null;
  }
  const methods = {};
  for (const methodName of methodNames) {
    const produces = entry.methods[methodName];
    if (!Array.isArray(produces)) {
      warn(`methods[${JSON.stringify(methodName)}] must be an array of template strings`);
      return null;
    }
    for (const tmpl of produces) {
      if (typeof tmpl !== "string") {
        warn(`methods[${JSON.stringify(methodName)}] contains a non-string template`);
        return null;
      }
    }
    methods[methodName] = [...produces];
  }

  return {
    className: entry.className,
    constructorArgs: [...entry.constructorArgs],
    methods,
  };
}

function validateDataInjectors(arr, configPath) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const normalized = validateInjector(arr[i], i, configPath);
    if (normalized) out.push(normalized);
  }
  return out;
}

export function loadProjectConfig(projectRoot) {
  const configPath = path.join(projectRoot, "wxml-zed.config.json");
  if (!fs.existsSync(configPath)) {
    return { dataInjectors: [] };
  }
  let raw;
  try {
    const text = fs.readFileSync(configPath, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    process.stderr.write(`[wxml-zed] failed to parse ${configPath}: ${err?.message || err}\n`);
    return { dataInjectors: [] };
  }
  return {
    dataInjectors: validateDataInjectors(raw?.dataInjectors ?? [], configPath),
  };
}
