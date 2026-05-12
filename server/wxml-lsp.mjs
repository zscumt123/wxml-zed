#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH_EXTRACTOR = path.join(EXTENSION_ROOT, "scripts/extract-wxml-project-graph.mjs");
const WARNING = 2;

let buffer = Buffer.alloc(0);
let shutdownRequested = false;
let rootCandidates = [];

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

function buildProjectGraph(projectRoot) {
  const output = execFileSync(process.execPath, [GRAPH_EXTRACTOR, projectRoot], {
    cwd: EXTENSION_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: process.env.WXML_ZED_HOME || "/private/tmp",
      npm_config_cache: process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache || "/private/tmp/npm-cache",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
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

function runDiagnostics(uri) {
  const documentPath = fileUriToPath(uri);
  if (!documentPath) {
    return;
  }

  try {
    const projectRoot = resolveMiniProgramRoot(documentPath);
    if (!projectRoot) {
      logDiagnosticError(`No app.json found for ${documentPath}`);
      publishDiagnostics(uri, []);
      return;
    }

    const graph = buildProjectGraph(projectRoot);
    publishDiagnostics(uri, diagnosticsForDocument(graph, documentPath));
  } catch (error) {
    logDiagnosticError(error instanceof Error ? error.message : String(error));
    publishDiagnostics(uri, []);
  }
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
      runDiagnostics(message.params?.textDocument?.uri);
      break;

    case "textDocument/didSave":
      runDiagnostics(message.params?.textDocument?.uri);
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
