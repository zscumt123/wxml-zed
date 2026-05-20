#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";

import {
  getCompletions,
  getDefinition,
  getDiagnostics,
  getDocumentSymbols,
} from "./wxml-language-service.mjs";
import { collectFile } from "../shared/wxml-symbol-extractor.mjs";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH_EXTRACTOR = path.join(EXTENSION_ROOT, "scripts/extract-wxml-project-graph.mjs");
const WXML_WASM = path.join(EXTENSION_ROOT, "grammar/tree-sitter-wxml/tree-sitter-wxml.wasm");
const GRAPH_AFFECTING_EXTENSIONS = new Set([".json", ".wxml", ".wxs"]);
const WATCH_REGISTRATION_ID = "wxml-zed-watch-registration";
const WATCH_REGISTRATION_METHOD = "workspace/didChangeWatchedFiles";
const WATCH_REGISTRATION_GLOBS = ["**/*.json", "**/*.wxml", "**/*.wxs"];
const OVERLAY_DEBOUNCE_MS = 150;

let buffer = Buffer.alloc(0);
let shutdownRequested = false;
let rootCandidates = [];
let supportsWatchedFileDynamicRegistration = false;
let watchedFilesRegistered = false;
const openDocuments = new Map();
const graphsByRoot = new Map();
const buildStateByRoot = new Map();
const pendingDiagnosticsByRoot = new Map();
const graphWaitersByRoot = new Map();

// Lazy parser: initialized on first didChange. null on permanent failure
// (wasm not loadable in this environment) — caller falls back to saved-
// graph diagnostics.
let wxmlParserPromise = null;
let wxmlParserFailed = false;

// openDocumentOverlays[root][uri] = freshly-extracted fileModel from the
// current buffer text. Empty by default — populated on didChange, cleared
// on didOpen/didSave/didClose.
const openDocumentOverlays = new Map();

// Per-uri debounce timers for overlay refresh.
const overlayTimers = new Map();

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

function requestClient(id, method, params) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
}

async function getWxmlParser() {
  if (wxmlParserFailed) return null;
  if (wxmlParserPromise) return wxmlParserPromise;

  wxmlParserPromise = (async () => {
    try {
      await Parser.init();
      const language = await Language.load(WXML_WASM);
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    } catch (err) {
      wxmlParserFailed = true;
      process.stderr.write(
        `WARN: WXML wasm parser load failed (${err?.message || err}); overlay diagnostics disabled, falling back to saved-graph diagnostics on save\n`,
      );
      return null;
    }
  })();

  return wxmlParserPromise;
}

function overlaysForRoot(projectRoot) {
  let perRoot = openDocumentOverlays.get(projectRoot);
  if (!perRoot) {
    perRoot = new Map();
    openDocumentOverlays.set(projectRoot, perRoot);
  }
  return perRoot;
}

function getOverlayFileModel(projectRoot, uri) {
  const perRoot = openDocumentOverlays.get(projectRoot);
  if (!perRoot) return undefined;
  return perRoot.get(uri);
}

function cancelOverlayTimer(uri) {
  const t = overlayTimers.get(uri);
  if (t) {
    clearTimeout(t);
    overlayTimers.delete(uri);
  }
}

function clearOverlay(projectRoot, uri) {
  const perRoot = openDocumentOverlays.get(projectRoot);
  if (perRoot) perRoot.delete(uri);
  cancelOverlayTimer(uri);
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

function waitersForRoot(projectRoot) {
  let waiters = graphWaitersByRoot.get(projectRoot);
  if (!waiters) {
    waiters = new Set();
    graphWaitersByRoot.set(projectRoot, waiters);
  }
  return waiters;
}

function waitForGraph(projectRoot) {
  return new Promise((resolve) => {
    waitersForRoot(projectRoot).add(resolve);
  });
}

function resolveGraphWaiters(projectRoot, graph) {
  const waiters = graphWaitersByRoot.get(projectRoot);
  if (!waiters) return;
  graphWaitersByRoot.delete(projectRoot);
  for (const resolve of waiters) {
    resolve(graph);
  }
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

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

function resolveMiniProgramRootForWatchedPath(filePath) {
  for (const dir of parentDirs(path.dirname(filePath))) {
    if (containsAppJson(dir)) return dir;
  }

  for (const root of rootCandidates) {
    if (root && containsAppJson(root) && isInside(root, filePath)) {
      return root;
    }
  }

  return undefined;
}

function isGraphAffectingPath(filePath) {
  return GRAPH_AFFECTING_EXTENSIONS.has(path.extname(filePath));
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
        stdio: ["ignore", "pipe", "pipe"],
        // Same reasoning as runSymbolExtractor: large real-project graphs
        // (200+ .wxml) emit multi-MB JSON; the default 1MB cap would fail
        // the LSP init silently.
        maxBuffer: 256 * 1024 * 1024,
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

function publishPendingDiagnostics(projectRoot, diagnosticsForUri) {
  const pending = pendingForRoot(projectRoot);
  for (const [uri] of pending) {
    const document = openDocuments.get(uri);
    if (!document) continue;
    // Overlay-aware: if the buffer has been edited since last save, the
    // overlay holds the freshly-extracted fileModel. Pass it through so
    // the publish reflects live buffer state, not stale disk state.
    const overlay = getOverlayFileModel(projectRoot, uri);
    publishDiagnostics(uri, diagnosticsForUri(uri, document.path, overlay));
  }
  pending.clear();
}

function markOpenDocumentsPending(projectRoot, generation) {
  const pending = pendingForRoot(projectRoot);
  for (const [uri, document] of openDocuments) {
    if (path.extname(document.path) !== ".wxml") continue;
    if (!isInside(projectRoot, document.path)) continue;
    pending.set(uri, generation);
  }
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
      publishPendingDiagnostics(projectRoot, (_uri, documentPath, overlay) => (
        getDiagnostics({ graph, documentPath, extensionRoot: EXTENSION_ROOT, fileModelOverride: overlay })
      ));
      resolveGraphWaiters(projectRoot, graph);
    } else {
      state.queued = true;
    }
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    if (activeGeneration === state.latestGeneration) {
      publishPendingDiagnostics(projectRoot, () => []);
      resolveGraphWaiters(projectRoot, undefined);
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

function hasStableCachedGraph(projectRoot) {
  const state = stateForRoot(projectRoot);
  return graphsByRoot.has(projectRoot) && !state.running && !state.queued;
}

function ensureGraphForRequest(projectRoot) {
  if (hasStableCachedGraph(projectRoot)) {
    return Promise.resolve(graphsByRoot.get(projectRoot));
  }

  const graphPromise = waitForGraph(projectRoot);
  const state = stateForRoot(projectRoot);
  if (!state.running) {
    if (!state.queued) {
      state.latestGeneration += 1;
    }
    runGraphBuild(projectRoot);
  }
  return graphPromise;
}

function recordOpenDocument(uri, text = undefined) {
  const documentPath = fileUriToPath(uri);
  if (!documentPath) {
    return undefined;
  }

  const existing = openDocuments.get(uri);
  const document = {
    path: documentPath,
    text: typeof text === "string" ? text : existing?.text,
  };
  openDocuments.set(uri, document);
  return document;
}

function updateOpenDocumentText(uri, text) {
  if (typeof text !== "string") {
    return recordOpenDocument(uri);
  }
  return recordOpenDocument(uri, text);
}

function scheduleOverlayDiagnostics(uri) {
  cancelOverlayTimer(uri);
  const timer = setTimeout(() => {
    overlayTimers.delete(uri);
    runOverlayDiagnostics(uri).catch((err) => {
      logDiagnosticError(`overlay diagnostics failed for ${uri}: ${err?.message || err}`);
    });
  }, OVERLAY_DEBOUNCE_MS);
  overlayTimers.set(uri, timer);
}

async function runOverlayDiagnostics(uri) {
  const document = openDocuments.get(uri);
  if (!document || typeof document.text !== "string") return;
  if (path.extname(document.path) !== ".wxml") return;

  const projectRoot = resolveMiniProgramRoot(document.path);
  if (!projectRoot) return;

  const parser = await getWxmlParser();
  if (!parser) return;  // wasm load failed — user falls back to save-time diagnostics

  let fileModel;
  try {
    const tree = parser.parse(document.text);
    fileModel = collectFile(tree, document.path);
  } catch (err) {
    logDiagnosticError(`WXML parse failed for ${document.path}: ${err?.message || err}`);
    return;
  }

  // Store overlay FIRST — even if the initial graph build hasn't finished
  // yet, publishPendingDiagnostics will read this overlay when the build
  // does complete, so the user's first observed diagnostic reflects the
  // live buffer rather than disk state.
  overlaysForRoot(projectRoot).set(uri, fileModel);

  // If the saved graph IS ready, publish the overlay-augmented diagnostic
  // immediately. If not, the deferred publish via publishPendingDiagnostics
  // will handle it when the in-flight build completes.
  const graph = graphsByRoot.get(projectRoot);
  if (!graph) return;

  const diagnostics = getDiagnostics({
    graph,
    documentPath: document.path,
    extensionRoot: EXTENSION_ROOT,
    fileModelOverride: fileModel,
  });
  publishDiagnostics(uri, diagnostics);
}

function scheduleDiagnostics(uri, text = undefined) {
  const document = recordOpenDocument(uri, text);
  if (!document) {
    return;
  }

  const projectRoot = resolveMiniProgramRoot(document.path);
  if (!projectRoot) {
    logDiagnosticError(`No app.json found for ${document.path}`);
    publishDiagnostics(uri, []);
    return;
  }

  const state = stateForRoot(projectRoot);
  state.latestGeneration += 1;
  pendingForRoot(projectRoot).set(uri, state.latestGeneration);
  runGraphBuild(projectRoot);
}

function refreshGraphForRoot(projectRoot) {
  graphsByRoot.delete(projectRoot);
  const state = stateForRoot(projectRoot);
  state.latestGeneration += 1;
  markOpenDocumentsPending(projectRoot, state.latestGeneration);
  runGraphBuild(projectRoot);
}

function handleWatchedFilesChanged(params) {
  const roots = new Set();
  const changes = Array.isArray(params?.changes) ? params.changes : [];

  for (const change of changes) {
    const filePath = fileUriToPath(change?.uri);
    if (!filePath || !isGraphAffectingPath(filePath)) continue;

    const projectRoot = resolveMiniProgramRootForWatchedPath(filePath);
    if (!projectRoot) continue;

    roots.add(projectRoot);
  }

  for (const projectRoot of roots) {
    refreshGraphForRoot(projectRoot);
  }
}

function closeDocument(uri) {
  openDocuments.delete(uri);
  // Clear overlay for all roots — the document is gone; if it was open
  // under multiple roots (rare but possible if Zed had nested workspaces),
  // any stored overlay should drop. Scan to be safe.
  for (const root of openDocumentOverlays.keys()) {
    clearOverlay(root, uri);
  }
  for (const pending of pendingDiagnosticsByRoot.values()) {
    pending.delete(uri);
  }
  publishDiagnostics(uri, []);
}

async function definitionForRequest(params) {
  const documentPath = fileUriToPath(params?.textDocument?.uri);
  if (!documentPath) {
    return null;
  }

  const projectRoot = resolveMiniProgramRoot(documentPath);
  if (!projectRoot) {
    logDiagnosticError(`No app.json found for ${documentPath}`);
    return null;
  }

  const graph = await ensureGraphForRequest(projectRoot);
  if (!graph) {
    return null;
  }

  return getDefinition({
    graph,
    documentPath,
    position: params?.position,
    extensionRoot: EXTENSION_ROOT,
  });
}

async function handleDefinitionRequest(id, params) {
  try {
    respond(id, await definitionForRequest(params));
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    respond(id, null);
  }
}

async function documentSymbolsForRequest(params) {
  const documentPath = fileUriToPath(params?.textDocument?.uri);
  if (!documentPath) {
    return [];
  }

  const projectRoot = resolveMiniProgramRoot(documentPath);
  if (!projectRoot) {
    logDiagnosticError(`No app.json found for ${documentPath}`);
    return [];
  }

  const graph = await ensureGraphForRequest(projectRoot);
  if (!graph) {
    return [];
  }

  return getDocumentSymbols({
    graph,
    documentPath,
    extensionRoot: EXTENSION_ROOT,
  });
}

async function handleDocumentSymbolRequest(id, params) {
  try {
    respond(id, await documentSymbolsForRequest(params));
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    respond(id, []);
  }
}

async function completionsForRequest(params) {
  const uri = params?.textDocument?.uri;
  const documentPath = fileUriToPath(uri);
  if (!documentPath) {
    return [];
  }

  const document = openDocuments.get(uri);
  if (!document || typeof document.text !== "string") {
    return [];
  }

  const projectRoot = resolveMiniProgramRoot(documentPath);
  if (!projectRoot) {
    logDiagnosticError(`No app.json found for ${documentPath}`);
    return [];
  }

  const graph = await ensureGraphForRequest(projectRoot);
  if (!graph) {
    return [];
  }

  return getCompletions({
    graph,
    documentPath,
    position: params?.position,
    sourceText: document.text,
    extensionRoot: EXTENSION_ROOT,
  });
}

async function handleCompletionRequest(id, params) {
  try {
    respond(id, await completionsForRequest(params));
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    respond(id, []);
  }
}

function initialize(params) {
  supportsWatchedFileDynamicRegistration = (
    params?.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true
  );
  watchedFilesRegistered = false;
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
        change: 1,
        save: true,
      },
      definitionProvider: true,
      documentSymbolProvider: true,
      completionProvider: {
        triggerCharacters: ["<", " ", ":", "\"", "'"],
      },
    },
  };
}

function registerWatchedFilesIfSupported() {
  if (!supportsWatchedFileDynamicRegistration || watchedFilesRegistered) {
    return;
  }

  watchedFilesRegistered = true;
  requestClient(WATCH_REGISTRATION_ID, "client/registerCapability", {
    registrations: [{
      id: "wxml-zed-watched-files",
      method: WATCH_REGISTRATION_METHOD,
      registerOptions: {
        watchers: WATCH_REGISTRATION_GLOBS.map((globPattern) => ({ globPattern })),
      },
    }],
  });
}

function handleMessage(message) {
  if (!message.method) {
    return;
  }

  switch (message.method) {
    case "initialize":
      respond(message.id, initialize(message.params));
      break;

    case "initialized":
      registerWatchedFilesIfSupported();
      break;

    case "shutdown":
      shutdownRequested = true;
      respond(message.id, null);
      break;

    case "exit":
      process.exit(shutdownRequested ? 0 : 1);
      break;

    case "textDocument/didOpen":
      {
        const uri = message.params?.textDocument?.uri;
        const documentPath = fileUriToPath(uri);
        if (documentPath) {
          const projectRoot = resolveMiniProgramRoot(documentPath);
          if (projectRoot) clearOverlay(projectRoot, uri);
        }
        scheduleDiagnostics(uri, message.params?.textDocument?.text);
      }
      break;

    case "textDocument/didChange":
      {
        const uri = message.params?.textDocument?.uri;
        const fullChange = Array.isArray(message.params?.contentChanges)
          ? message.params.contentChanges.find((change) => !change.range && typeof change.text === "string")
          : undefined;
        if (fullChange) {
          updateOpenDocumentText(uri, fullChange.text);
          scheduleOverlayDiagnostics(uri);
        }
      }
      break;

    case "textDocument/didSave":
      {
        const uri = message.params?.textDocument?.uri;
        // Clear overlay BEFORE scheduling the graph rebuild — when the buffer
        // matches disk, the saved graph becomes truth-of-record again and
        // any pending debounced didChange shouldn't fire stale overlay.
        const document = openDocuments.get(uri);
        if (document) {
          const projectRoot = resolveMiniProgramRoot(document.path);
          if (projectRoot) clearOverlay(projectRoot, uri);
        }
        scheduleDiagnostics(uri, message.params?.text);
      }
      break;

    case "workspace/didChangeWatchedFiles":
      handleWatchedFilesChanged(message.params);
      break;

    case "textDocument/didClose":
      closeDocument(message.params?.textDocument?.uri);
      break;

    case "textDocument/definition":
      handleDefinitionRequest(message.id, message.params);
      break;

    case "textDocument/documentSymbol":
      handleDocumentSymbolRequest(message.id, message.params);
      break;

    case "textDocument/completion":
      handleCompletionRequest(message.id, message.params);
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
