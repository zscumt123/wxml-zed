#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SYMBOL_EXTRACTOR = path.join(ROOT, "scripts/extract-wxml-symbols.mjs");
const PROFILE_ENABLED = process.env.WXML_ZED_PROFILE === "1";

function elapsedMs(start) {
  return Number((performance.now() - start).toFixed(2));
}

function profileEvent(event) {
  if (!PROFILE_ENABLED) return;
  process.stderr.write(`WXML_ZED_PROFILE ${JSON.stringify({
    source: "extract-wxml-project-graph",
    ...event,
  })}\n`);
}

function toPosix(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

function repoRelative(filePath) {
  return toPosix(path.relative(ROOT, path.resolve(filePath)));
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function withoutKnownExtension(value) {
  return value.replace(/\.(wxml|json)$/u, "");
}

function componentBasePath(projectRoot, ownerJsonPath, value) {
  if (value.startsWith("/")) {
    return path.resolve(projectRoot, withoutKnownExtension(value.slice(1)));
  }
  return path.resolve(path.dirname(ownerJsonPath), withoutKnownExtension(value));
}

function derivedPaths(projectRoot, ownerJsonPath, value) {
  const base = componentBasePath(projectRoot, ownerJsonPath, value);
  return {
    base,
    wxml: `${base}.wxml`,
    json: `${base}.json`,
  };
}

function addUniquePath(queue, queued, filePath) {
  const resolved = path.resolve(filePath);
  if (queued.has(resolved)) return;
  queued.add(resolved);
  queue.push(resolved);
}

function sortByPath(items) {
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

function runSymbolExtractor(files) {
  if (files.length === 0) {
    return { version: 1, files: [] };
  }

  const start = performance.now();
  const output = execFileSync(
    "node",
    [SYMBOL_EXTRACTOR, ...files],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  const model = JSON.parse(output);
  profileEvent({
    type: "graph-symbol-batch",
    fileCount: files.length,
    files: files.map(repoRelative),
    returnedFileCount: model.files.length,
    totalMs: elapsedMs(start),
  });
  return model;
}

function createUnresolved(kind, data) {
  return { kind, ...data };
}

function resolveUsingComponent(projectRoot, ownerJsonPath, ownerWxmlPath, tag, value) {
  if (!value.startsWith("./") && !value.startsWith("../") && !value.startsWith("/")) {
    return {
      owner: repoRelative(ownerWxmlPath),
      tag,
      value,
      resolved: false,
      reason: "unsupported",
    };
  }

  const paths = derivedPaths(projectRoot, ownerJsonPath, value);
  const entry = {
    owner: repoRelative(ownerWxmlPath),
    tag,
    value,
    target: repoRelative(paths.wxml),
    config: repoRelative(paths.json),
    resolved: true,
  };

  if (!isInside(projectRoot, paths.wxml) || !isInside(projectRoot, paths.json)) {
    return {
      ...entry,
      resolved: false,
      reason: "outside-root",
    };
  }

  if (!fs.existsSync(paths.wxml)) {
    return {
      ...entry,
      resolved: false,
      reason: "missing-file",
    };
  }

  if (!fs.existsSync(paths.json)) {
    delete entry.config;
  }

  return entry;
}

function pushConfig(configs, pathValue, kind, owner) {
  const entry = {
    path: repoRelative(pathValue),
    kind,
  };
  if (owner) entry.owner = repoRelative(owner);
  configs.push(entry);
}

function readUsingComponents(config) {
  const value = config?.usingComponents;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function validPageEntries(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function subpackageEntries(appJson) {
  return [
    ...(Array.isArray(appJson.subPackages) ? appJson.subPackages : []),
    ...(Array.isArray(appJson.subpackages) ? appJson.subpackages : []),
  ];
}

function collectPageNames(appJson) {
  const pageNames = [];
  const seen = new Set();

  function addPage(name) {
    if (seen.has(name)) return;
    seen.add(name);
    pageNames.push(name);
  }

  for (const pageName of validPageEntries(appJson.pages)) {
    addPage(pageName);
  }

  for (const item of subpackageEntries(appJson)) {
    if (!item || typeof item.root !== "string" || !Array.isArray(item.pages)) {
      continue;
    }
    const root = item.root.replace(/^\/+|\/+$/gu, "");
    if (!root) {
      continue;
    }
    for (const pageName of validPageEntries(item.pages)) {
      addPage(`${root}/${pageName.replace(/^\/+/u, "")}`);
    }
  }

  return pageNames;
}

function usingComponentDeclarations(declaringJsonPath, components) {
  return Object.entries(components).map(([tag, value]) => ({
    tag,
    value: String(value),
    declaringJsonPath,
  }));
}

function effectiveUsingComponentDeclarations(appJsonPath, appUsingComponents, ownerJsonPath, ownerUsingComponents) {
  const byTag = new Map();

  for (const declaration of usingComponentDeclarations(appJsonPath, appUsingComponents)) {
    byTag.set(declaration.tag, declaration);
  }

  for (const declaration of usingComponentDeclarations(ownerJsonPath, ownerUsingComponents)) {
    byTag.set(declaration.tag, declaration);
  }

  return [...byTag.values()];
}

function extractProject(projectRootInput) {
  const totalStart = performance.now();
  const projectRoot = path.resolve(projectRootInput);
  const appJsonPath = path.join(projectRoot, "app.json");
  const appJson = readJsonIfExists(appJsonPath);
  if (!appJson) {
    throw new Error(`Missing app.json: ${repoRelative(appJsonPath)}`);
  }
  const appUsingComponents = readUsingComponents(appJson);

  const graph = {
    version: 1,
    root: repoRelative(projectRoot),
    pages: [],
    configs: [],
    wxml: [],
    usingComponents: [],
    unresolved: [],
  };

  pushConfig(graph.configs, appJsonPath, "app");

  const componentQueue = [];
  const visitedConfigs = new Set();
  const wxmlQueue = [];
  const queuedWxml = new Set();
  const parsedWxml = new Set();
  const wxmlByPath = new Map();

  function queueConfig(jsonPath, wxmlPath, kind) {
    const resolvedJson = path.resolve(jsonPath);
    if (visitedConfigs.has(resolvedJson)) return;
    visitedConfigs.add(resolvedJson);
    componentQueue.push({ jsonPath: resolvedJson, wxmlPath: path.resolve(wxmlPath), kind });
  }

  function readOwnerConfig(jsonPath, wxmlPath, kind) {
    const config = readJsonIfExists(jsonPath);
    if (!config) return;
    pushConfig(graph.configs, jsonPath, kind, kind === "app" ? undefined : wxmlPath);

    const componentDeclarations = kind === "app"
      ? usingComponentDeclarations(jsonPath, readUsingComponents(config))
      : effectiveUsingComponentDeclarations(appJsonPath, appUsingComponents, jsonPath, readUsingComponents(config));

    for (const { tag, value, declaringJsonPath } of componentDeclarations) {
      const entry = resolveUsingComponent(projectRoot, declaringJsonPath, wxmlPath, tag, value);
      graph.usingComponents.push(entry);

      if (!entry.resolved) {
        graph.unresolved.push(createUnresolved("component", {
          owner: entry.owner,
          tag,
          value: entry.value,
          target: entry.target,
          reason: entry.reason,
        }));
        continue;
      }

      addUniquePath(wxmlQueue, queuedWxml, path.resolve(ROOT, entry.target));
      if (entry.config) {
        queueConfig(path.resolve(ROOT, entry.config), path.resolve(ROOT, entry.target), "component");
      }
    }
  }

  const pages = collectPageNames(appJson);
  for (const pageName of pages) {
    const pageBase = path.join(projectRoot, pageName);
    const pageJsonPath = `${pageBase}.json`;
    const pageWxmlPath = `${pageBase}.wxml`;
    graph.pages.push({
      name: pageName,
      json: repoRelative(pageJsonPath),
      wxml: repoRelative(pageWxmlPath),
    });

    if (!fs.existsSync(pageJsonPath) || !fs.existsSync(pageWxmlPath)) {
      graph.unresolved.push(createUnresolved("page", {
        name: pageName,
        json: repoRelative(pageJsonPath),
        wxml: repoRelative(pageWxmlPath),
        reason: "missing-file",
      }));
    }

    if (fs.existsSync(pageWxmlPath)) {
      addUniquePath(wxmlQueue, queuedWxml, pageWxmlPath);
    }
    queueConfig(pageJsonPath, pageWxmlPath, "page");
  }

  while (componentQueue.length > 0) {
    const item = componentQueue.shift();
    readOwnerConfig(item.jsonPath, item.wxmlPath, item.kind);
  }

  while (wxmlQueue.length > 0) {
    const currentBatch = wxmlQueue.splice(0).filter((filePath) => {
      if (parsedWxml.has(filePath)) return false;
      parsedWxml.add(filePath);
      return fs.existsSync(filePath);
    });

    const symbolModel = runSymbolExtractor(currentBatch);
    for (const fileModel of symbolModel.files) {
      wxmlByPath.set(fileModel.path, fileModel);
      for (const dependency of fileModel.dependencies) {
        if (!dependency.normalized || !dependency.normalized.endsWith(".wxml")) continue;

        const dependencyPath = path.resolve(ROOT, dependency.normalized);
        if (!isInside(projectRoot, dependencyPath)) {
          graph.unresolved.push(createUnresolved("wxml-dependency", {
            owner: fileModel.path,
            value: dependency.value,
            target: dependency.normalized,
            reason: "outside-root",
          }));
          continue;
        }

        if (!fs.existsSync(dependencyPath)) {
          graph.unresolved.push(createUnresolved("wxml-dependency", {
            owner: fileModel.path,
            value: dependency.value,
            target: dependency.normalized,
            reason: "missing-file",
          }));
          continue;
        }

        addUniquePath(wxmlQueue, queuedWxml, dependencyPath);
      }
    }
  }

  graph.configs = sortByPath(graph.configs);
  graph.usingComponents.sort((a, b) => (
    a.owner.localeCompare(b.owner) ||
    a.tag.localeCompare(b.tag) ||
    a.value.localeCompare(b.value)
  ));
  graph.unresolved.sort((a, b) => (
    a.kind.localeCompare(b.kind) ||
    (a.owner || "").localeCompare(b.owner || "") ||
    (a.tag || a.name || "").localeCompare(b.tag || b.name || "") ||
    (a.value || "").localeCompare(b.value || "")
  ));
  graph.wxml = sortByPath([...wxmlByPath.values()]);

  profileEvent({
    type: "graph-total",
    root: repoRelative(projectRoot),
    pageCount: graph.pages.length,
    configCount: graph.configs.length,
    wxmlCount: graph.wxml.length,
    usingComponentCount: graph.usingComponents.length,
    unresolvedCount: graph.unresolved.length,
    totalMs: elapsedMs(totalStart),
  });

  return graph;
}

const [projectRoot] = process.argv.slice(2);
if (!projectRoot) {
  console.error("Usage: node scripts/extract-wxml-project-graph.mjs <project-root>");
  process.exit(2);
}

const graph = extractProject(projectRoot);
process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
