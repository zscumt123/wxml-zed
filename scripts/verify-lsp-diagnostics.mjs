#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server/wxml-lsp.mjs");
const HOME_WXML = path.join(ROOT, "fixtures/miniprogram/pages/home/home.wxml");
const TIMEOUT_MS = 30_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createMessageReader(onMessage) {
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/Content-Length: (\d+)/iu);
      assert(match, `Missing Content-Length header: ${header}`);

      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) return;

      const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.subarray(bodyEnd);
      onMessage(JSON.parse(body));
    }
  };
}

function writeMessage(stream, message) {
  const body = JSON.stringify(message);
  stream.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function lineCharToOffset(text, position) {
  const lines = text.split("\n");
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    offset += lines[line].length + 1;
  }
  return offset + position.character;
}

function assertDiagnostic(diagnostic, uri) {
  assert(diagnostic, "Missing diagnostic");
  assert(diagnostic.severity === 2, `Expected warning severity, got ${diagnostic.severity}`);
  assert(diagnostic.source === "wxml-zed", `Unexpected diagnostic source: ${diagnostic.source}`);
  assert(diagnostic.code === "missing-local-component", `Unexpected diagnostic code: ${diagnostic.code}`);
  assert(
    diagnostic.message === 'Missing local component "missing-card": ../../components/missing-card/missing-card',
    `Unexpected diagnostic message: ${diagnostic.message}`,
  );

  const expectedRange = {
    start: { line: 14, character: 2 },
    end: { line: 14, character: 43 },
  };
  assert(
    JSON.stringify(diagnostic.range) === JSON.stringify(expectedRange),
    `Unexpected diagnostic range: ${JSON.stringify(diagnostic.range)}`,
  );

  const text = fs.readFileSync(HOME_WXML, "utf8");
  const start = lineCharToOffset(text, diagnostic.range.start);
  const end = lineCharToOffset(text, diagnostic.range.end);
  assert(
    text.slice(start, end) === '<missing-card reason="{{emptyReason}}" />',
    `Diagnostic for ${uri} is not attached to missing-card`,
  );
}

async function main() {
  const server = spawn("node", [SERVER], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  let initialized = false;
  let diagnostics;
  let stderr = "";
  let unexpectedExit;

  const waitForDiagnostics = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for diagnostics. stderr:\n${stderr}`));
    }, TIMEOUT_MS);

    const readServerMessage = createMessageReader((message) => {
      if (message.id === 1) {
        assert(
          message.result?.capabilities?.textDocumentSync?.openClose === true,
          "initialize result did not advertise openClose sync",
        );
        assert(
          message.result?.capabilities?.textDocumentSync?.save === true,
          "initialize result did not advertise save sync",
        );
        assert(
          message.result?.capabilities?.textDocumentSync?.change === 0,
          "initialize result did not disable incremental text sync",
        );
        initialized = true;
      }

      if (message.method === "textDocument/publishDiagnostics") {
        diagnostics = message.params;
        clearTimeout(timeout);
        resolve();
      }
    });

    server.stdout.on("data", readServerMessage);

    server.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    server.on("exit", (code, signal) => {
      if (!diagnostics) {
        unexpectedExit = { code, signal };
        clearTimeout(timeout);
        reject(new Error(`LSP process exited before diagnostics: ${JSON.stringify(unexpectedExit)}\n${stderr}`));
      }
    });
  });

  writeMessage(server.stdin, {
    jsonrpc: "2.0",
    id: nextId,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri: pathToFileURL(ROOT).href,
      workspaceFolders: [{ uri: pathToFileURL(ROOT).href, name: "wxml-zed" }],
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: false,
          },
        },
      },
    },
  });
  nextId += 1;

  writeMessage(server.stdin, {
    jsonrpc: "2.0",
    method: "initialized",
    params: {},
  });

  const homeUri = pathToFileURL(HOME_WXML).href;
  writeMessage(server.stdin, {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: homeUri,
        languageId: "wxml",
        version: 1,
        text: fs.readFileSync(HOME_WXML, "utf8"),
      },
    },
  });

  await waitForDiagnostics;

  assert(initialized, "Server published diagnostics before initialize response was processed");
  assert(diagnostics.uri === homeUri, `Unexpected diagnostics URI: ${diagnostics.uri}`);
  assert(Array.isArray(diagnostics.diagnostics), "Diagnostics payload is not an array");
  assert(diagnostics.diagnostics.length === 1, `Expected one diagnostic, got ${diagnostics.diagnostics.length}`);
  assertDiagnostic(diagnostics.diagnostics[0], diagnostics.uri);

  writeMessage(server.stdin, {
    jsonrpc: "2.0",
    id: nextId,
    method: "shutdown",
    params: null,
  });
  writeMessage(server.stdin, {
    jsonrpc: "2.0",
    method: "exit",
    params: {},
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
