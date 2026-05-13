#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH_EXTRACTOR = path.join(EXTENSION_ROOT, "scripts/extract-wxml-project-graph.mjs");
const WARNING = 2;

let buffer = Buffer.alloc(0);
let shutdownRequested = false;
let rootCandidates = [];
const openDocuments = new Map();
const graphsByRoot = new Map();
const buildStateByRoot = new Map();
const pendingDiagnosticsByRoot = new Map();

function toPosix(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

function graphPathForAbsolute(filePath) {
  return toPosix(path.relative(EXTENSION_ROOT, path.resolve(filePath)));
}

function fileUriToPath(uri) {
  if (!uri || !uri.startsWith("file://")) return undefined;
  return fileURLToPath(uri);
}

function writeMessage(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function respond(id, result) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function respondError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function publishDiagnostics(uri, diagnostics) {
  writeMessage({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics,
    },
  });
}

function logDiagnosticError(message) {
  process.stderr.write(`[wxml-lsp] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function appendCounterEvent(projectRoot, event) {
  const counterFile = process.env.WXML_ZED_LSP_GRAPH_COUNTER_FILE;
  if (!counterFile) return;

  const line = `${JSON.stringify({
    event,
    projectRoot,
    time: new Date().toISOString(),
    pid: process.pid,
  })}\n`;

  try {
    fs.appendFileSync(counterFile, line, "utf8");
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
  }
}

function graphExtractorEnv() {
  return {
    ...process.env,
    HOME: process.env.WXML_ZED_HOME || "/private/tmp",
    npm_config_cache: process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache || "/private/tmp/npm-cache",
  };
}

function stateForRoot(projectRoot) {
  let state = buildStateByRoot.get(projectRoot);
  if (!state) {
    state = {
      running: false,
      queued: false,
      activeGeneration: 0,
      latestGeneration: 0,
    };
    buildStateByRoot.set(projectRoot, state);
  }
  return state;
}

function pendingForRoot(projectRoot) {
  let pending = pendingDiagnosticsByRoot.get(projectRoot);
  if (!pending) {
    pending = new Map();
    pendingDiagnosticsByRoot.set(projectRoot, pending);
  }
  return pending;
}

function parentDirs(startDir) {
  const dirs = [];
  let current = path.resolve(startDir);

  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

function containsAppJson(dir) {
  return fs.existsSync(path.join(dir, "app.json"));
}

function resolveMiniProgramRoot(documentPath) {
  for (const dir of parentDirs(path.dirname(documentPath))) {
    if (containsAppJson(dir)) return dir;
  }

  for (const root of rootCandidates) {
    if (root && containsAppJson(root)) return root;
  }

  return undefined;
}

async function buildProjectGraph(projectRoot) {
  const delayMs = Number(process.env.WXML_ZED_LSP_GRAPH_DELAY_MS || 0);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    await sleep(delayMs);
  }

  appendCounterEvent(projectRoot, "start");
  try {
    const output = await new Promise((resolve, reject) => {
      execFile(process.execPath, [GRAPH_EXTRACTOR, projectRoot], {
        cwd: EXTENSION_ROOT,
        encoding: "utf8",
        env: graphExtractorEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }, (error, stdout, stderr) => {
        if (error) {
          error.message = stderr ? `${error.message}\n${stderr}` : error.message;
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });
    return JSON.parse(output);
  } finally {
    appendCounterEvent(projectRoot, "end");
  }
}

function rangeFromSymbolRange(range) {
  return {
    start: {
      line: range.start.row,
      character: range.start.column,
    },
    end: {
      line: range.end.row,
      character: range.end.column,
    },
  };
}

function diagnosticsForDocument(graph, documentPath) {
  const documentGraphPath = graphPathForAbsolute(documentPath);
  const fileModel = graph.wxml.find((entry) => entry.path === documentGraphPath);
  if (!fileModel) {
    logDiagnosticError(`No WXML graph entry for ${documentGraphPath}`);
    return [];
  }

  const usedComponents = new Map(fileModel.components.map((component) => [component.tag, component]));
  return graph.unresolved
    .filter((entry) => (
      entry.kind === "component" &&
      entry.owner === documentGraphPath &&
      entry.reason === "missing-file" &&
      usedComponents.has(entry.tag)
    ))
    .map((entry) => {
      const component = usedComponents.get(entry.tag);
      return {
        range: rangeFromSymbolRange(component.range),
        severity: WARNING,
        source: "wxml-zed",
        code: "missing-local-component",
        message: `Missing local component "${entry.tag}": ${entry.value}`,
      };
    });
}

function publishPendingDiagnostics(projectRoot, diagnosticsForUri) {
  const pending = pendingForRoot(projectRoot);
  for (const [uri] of pending) {
    const document = openDocuments.get(uri);
    if (!document) continue;
    publishDiagnostics(uri, diagnosticsForUri(uri, document.path));
  }
  pending.clear();
}

async function runGraphBuild(projectRoot) {
  const state = stateForRoot(projectRoot);
  if (state.running) {
    state.queued = true;
    return;
  }

  state.running = true;
  state.queued = false;
  state.activeGeneration = state.latestGeneration;
  const activeGeneration = state.activeGeneration;

  try {
    const graph = await buildProjectGraph(projectRoot);
    if (activeGeneration === state.latestGeneration) {
      graphsByRoot.set(projectRoot, graph);
      publishPendingDiagnostics(projectRoot, (_uri, documentPath) => (
        diagnosticsForDocument(graph, documentPath)
      ));
    } else {
      state.queued = true;
    }
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    if (activeGeneration === state.latestGeneration) {
      publishPendingDiagnostics(projectRoot, () => []);
    } else {
      state.queued = true;
    }
  } finally {
    state.running = false;
    state.activeGeneration = 0;
    if (state.queued) {
      queueMicrotask(() => {
        runGraphBuild(projectRoot);
      });
    }
  }
}

function scheduleDiagnostics(uri) {
  const documentPath = fileUriToPath(uri);
  if (!documentPath) {
    return;
  }

  openDocuments.set(uri, { path: documentPath });

  const projectRoot = resolveMiniProgramRoot(documentPath);
  if (!projectRoot) {
    logDiagnosticError(`No app.json found for ${documentPath}`);
    publishDiagnostics(uri, []);
    return;
  }

  const state = stateForRoot(projectRoot);
  state.latestGeneration += 1;
  pendingForRoot(projectRoot).set(uri, state.latestGeneration);
  runGraphBuild(projectRoot);
}

function closeDocument(uri) {
  openDocuments.delete(uri);
  for (const pending of pendingDiagnosticsByRoot.values()) {
    pending.delete(uri);
  }
  publishDiagnostics(uri, []);
}

function initialize(params) {
  rootCandidates = [
    fileUriToPath(params?.rootUri),
    ...(Array.isArray(params?.workspaceFolders)
      ? params.workspaceFolders.map((folder) => fileUriToPath(folder.uri))
      : []),
    process.cwd(),
  ].filter(Boolean);

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: 0,
        save: true,
      },
    },
  };
}

function handleMessage(message) {
  switch (message.method) {
    case "initialize":
      respond(message.id, initialize(message.params));
      break;

    case "initialized":
      break;

    case "shutdown":
      shutdownRequested = true;
      respond(message.id, null);
      break;

    case "exit":
      process.exit(shutdownRequested ? 0 : 1);
      break;

    case "textDocument/didOpen":
      scheduleDiagnostics(message.params?.textDocument?.uri);
      break;

    case "textDocument/didSave":
      scheduleDiagnostics(message.params?.textDocument?.uri);
      break;

    case "textDocument/didClose":
      closeDocument(message.params?.textDocument?.uri);
      break;

    default:
      if (Object.hasOwn(message, "id")) {
        respondError(message.id, -32601, `Method not found: ${message.method}`);
      }
      break;
  }
}

function readMessages(chunk) {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length: (\d+)/iu);
    if (!match) {
      throw new Error(`Missing Content-Length header: ${header}`);
    }

    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;

    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    handleMessage(JSON.parse(body));
  }
}

process.stdin.on("data", (chunk) => {
  try {
    readMessages(chunk);
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
  }
});

process.stdin.on("end", () => {
  process.exit(shutdownRequested ? 0 : 1);
});
