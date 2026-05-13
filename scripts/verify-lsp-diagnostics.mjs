#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server/wxml-lsp.mjs");
const MINIPROGRAM_ROOT = path.join(ROOT, "fixtures/miniprogram");
const HOME_WXML = path.join(MINIPROGRAM_ROOT, "pages/home/home.wxml");
const USER_CARD_WXML = path.join(MINIPROGRAM_ROOT, "components/user-card/user-card.wxml");
const STATUS_BADGE_WXML = path.join(MINIPROGRAM_ROOT, "components/status-badge/status-badge.wxml");
const COMMON_WXML = path.join(MINIPROGRAM_ROOT, "templates/common.wxml");
const HEADER_WXML = path.join(MINIPROGRAM_ROOT, "shared/header.wxml");
const FORMAT_WXS = path.join(MINIPROGRAM_ROOT, "utils/format.wxs");
const TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 5_000;
const SETTLE_MS = 500;

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

function assertMissingCardDiagnostic(diagnostic, sourceFile) {
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

  const text = fs.readFileSync(sourceFile, "utf8");
  const start = lineCharToOffset(text, diagnostic.range.start);
  const end = lineCharToOffset(text, diagnostic.range.end);
  assert(
    text.slice(start, end) === '<missing-card reason="{{emptyReason}}" />',
    `Diagnostic is not attached to missing-card in ${sourceFile}`,
  );
}

function assertLocationTarget(result, targetPath) {
  assert(result, `Expected definition location for ${targetPath}`);
  assert(!Array.isArray(result), `Expected single Location, got array: ${JSON.stringify(result)}`);
  assert(result.uri === pathToFileURL(targetPath).href, `Unexpected definition URI: ${JSON.stringify(result)}`);
  const expectedRange = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
  assert(
    JSON.stringify(result.range) === JSON.stringify(expectedRange),
    `Unexpected definition range: ${JSON.stringify(result.range)}`,
  );
}

function assertLocation(result, targetPath, expectedRange, label) {
  assert(result, `${label}: expected definition location`);
  assert(!Array.isArray(result), `${label}: expected single Location, got array ${JSON.stringify(result)}`);
  assert(result.uri === pathToFileURL(targetPath).href, `${label}: unexpected URI ${JSON.stringify(result)}`);
  assertDeepEqual(result.range, expectedRange, `${label} range`);
}

function assertNullDefinition(result, label) {
  assert(result === null, `${label}: expected null definition, got ${JSON.stringify(result)}`);
}

function assertDeepEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${label}: expected ${expectedJson}, got ${actualJson}`);
}

function assertHomeDocumentSymbols(symbols) {
  assert(Array.isArray(symbols), `Expected document symbols array, got ${JSON.stringify(symbols)}`);
  assert(symbols.length === 3, `Expected 3 home document symbols, got ${symbols.length}: ${JSON.stringify(symbols)}`);
  assertDeepEqual(
    symbols.map((symbol) => [symbol.name, symbol.kind, symbol.detail]),
    [
      ["fixtures/miniprogram/templates/common.wxml", 1, "import"],
      ["fixtures/miniprogram/shared/header.wxml", 1, "include"],
      ["format", 2, "wxs"],
    ],
    "home document symbol identity/order",
  );
  assertDeepEqual(
    symbols.map((symbol) => symbol.range),
    [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 44 } },
      { start: { line: 1, character: 0 }, end: { line: 1, character: 42 } },
      { start: { line: 2, character: 0 }, end: { line: 2, character: 52 } },
    ],
    "home document symbol ranges",
  );
  assertDeepEqual(
    symbols.map((symbol) => symbol.selectionRange),
    symbols.map((symbol) => symbol.range),
    "home document symbol selection ranges",
  );
  assert(symbols.filter((symbol) => symbol.detail?.startsWith("wxs")).length === 1, "Expected one WXS symbol");
}

function assertTemplateDocumentSymbols(symbols) {
  assert(Array.isArray(symbols), `Expected document symbols array, got ${JSON.stringify(symbols)}`);
  assert(symbols.length === 1, `Expected one template symbol, got ${symbols.length}: ${JSON.stringify(symbols)}`);
  assertDeepEqual(
    symbols[0],
    {
      name: "loadingRow",
      kind: 12,
      detail: "template",
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
    },
    "template document symbol",
  );
}

class LspClient {
  constructor({ rootPath, env = {} }) {
    this.rootPath = rootPath;
    this.env = env;
    this.nextId = 1;
    this.stderr = "";
    this.responses = new Map();
    this.diagnostics = [];
    this.messages = [];
    this.waiters = [];
    this.exited = undefined;
  }

  start() {
    this.server = spawn("node", [SERVER], {
      cwd: ROOT,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.server.stdout.on("data", createMessageReader((message) => this.handleMessage(message)));
    this.server.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.server.on("exit", (code, signal) => {
      this.exited = { code, signal };
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(`LSP exited unexpectedly: ${JSON.stringify(this.exited)}\n${this.stderr}`));
      }
    });
  }

  handleMessage(message) {
    this.messages.push(message);
    if (Object.hasOwn(message, "id")) {
      this.responses.set(message.id, message);
    }
    if (message.method === "textDocument/publishDiagnostics") {
      this.diagnostics.push(message.params);
    }

    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      }
    }
  }

  send(method, params, id = undefined) {
    if (this.exited) {
      throw new Error(`Cannot send ${method}; LSP already exited: ${JSON.stringify(this.exited)}\n${this.stderr}`);
    }

    const message = { jsonrpc: "2.0", method, params };
    if (id !== undefined) message.id = id;
    writeMessage(this.server.stdin, message);
    return id;
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    this.send(method, params, id);
    return id;
  }

  async definition(filePath, position) {
    const id = this.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position,
    });
    const response = await this.waitForResponse(id);
    if (response.error) {
      throw new Error(`Definition request failed: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  }

  async documentSymbols(filePath) {
    const id = this.request("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL(filePath).href },
    });
    const response = await this.waitForResponse(id);
    if (response.error) {
      throw new Error(`Document symbol request failed: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  }

  waitFor(predicate, label) {
    if (this.exited) {
      return Promise.reject(new Error(`LSP exited before ${label}: ${JSON.stringify(this.exited)}\n${this.stderr}`));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item.reject !== reject);
        reject(new Error(`Timed out waiting for ${label}. stderr:\n${this.stderr}`));
      }, TIMEOUT_MS);
      this.waiters.push({ predicate, resolve, reject, timeout });
    });
  }

  waitForResponse(id) {
    const existing = this.responses.get(id);
    if (existing) return Promise.resolve(existing);
    return this.waitFor((message) => message.id === id, `response ${id}`);
  }

  waitForDiagnostics(uri, predicate, label) {
    const existing = this.diagnostics.find((params) => params.uri === uri && predicate(params.diagnostics));
    if (existing) return Promise.resolve(existing);
    return this.waitFor(
      (message) => (
        message.method === "textDocument/publishDiagnostics" &&
        message.params.uri === uri &&
        predicate(message.params.diagnostics)
      ),
      label,
    ).then((message) => message.params);
  }

  diagnosticCursor() {
    return this.diagnostics.length;
  }

  diagnosticsSince(cursor, uri) {
    return this.diagnostics.slice(cursor).filter((params) => params.uri === uri);
  }

  waitForDiagnosticsAfter(uri, cursor, predicate, label) {
    const existing = this.diagnosticsSince(cursor, uri).find((params) => predicate(params.diagnostics));
    if (existing) return Promise.resolve(existing);
    return this.waitFor(
      (message) => (
        message.method === "textDocument/publishDiagnostics" &&
        message.params.uri === uri &&
        predicate(message.params.diagnostics)
      ),
      label,
    ).then((message) => message.params);
  }

  messageIndex(predicate) {
    return this.messages.findIndex(predicate);
  }

  async initialize() {
    const rootUri = pathToFileURL(this.rootPath).href;
    const id = this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootPath) }],
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: false,
          },
        },
      },
    });
    const response = await this.waitForResponse(id);
    assert(response.result?.capabilities?.textDocumentSync?.openClose === true, "openClose sync not advertised");
    assert(response.result?.capabilities?.textDocumentSync?.save === true, "save sync not advertised");
    assert(response.result?.capabilities?.textDocumentSync?.change === 0, "incremental sync should be disabled");
    assert(response.result?.capabilities?.definitionProvider === true, "definitionProvider not advertised");
    assert(response.result?.capabilities?.documentSymbolProvider === true, "documentSymbolProvider not advertised");
    this.send("initialized", {});
  }

  openDocument(filePath, version = 1) {
    const uri = pathToFileURL(filePath).href;
    this.send("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "wxml",
        version,
        text: fs.readFileSync(filePath, "utf8"),
      },
    });
    return uri;
  }

  saveDocument(filePath) {
    const uri = pathToFileURL(filePath).href;
    this.send("textDocument/didSave", { textDocument: { uri } });
    return uri;
  }

  closeDocument(filePath) {
    const uri = pathToFileURL(filePath).href;
    this.send("textDocument/didClose", { textDocument: { uri } });
    return uri;
  }

  async shutdown() {
    if (this.exited) return;
    const id = this.request("shutdown", null);
    await this.waitForResponse(id);
    const exit = this.waitForExit();
    this.send("exit", {});
    await exit;
  }

  waitForExit(timeoutMs = EXIT_TIMEOUT_MS) {
    if (this.exited) return Promise.resolve(this.exited);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for LSP exit. stderr:\n${this.stderr}`));
      }, timeoutMs);
      this.server.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
  }
}

async function withClient(options, run) {
  const client = new LspClient(options);
  client.start();
  let shouldKill = true;
  try {
    await client.initialize();
    await run(client);
    await client.shutdown();
    shouldKill = !client.exited;
  } finally {
    if (shouldKill && !client.exited) {
      client.server.kill("SIGKILL");
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function counterStats(events) {
  let active = 0;
  let maxActive = 0;
  let minActive = 0;
  let startCount = 0;
  let endCount = 0;

  for (const event of events) {
    if (event.event === "start") {
      active += 1;
      startCount += 1;
    }
    if (event.event === "end") {
      active -= 1;
      endCount += 1;
    }
    minActive = Math.min(minActive, active);
    maxActive = Math.max(maxActive, active);
  }

  return { active, endCount, maxActive, minActive, startCount };
}

function readCounterEvents(counterFile) {
  if (!counterFile || !fs.existsSync(counterFile)) return [];
  const content = fs.readFileSync(counterFile, "utf8").trim();
  if (!content) return [];
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForCounterCompletionOrSettle(counterFile, settleMs = SETTLE_MS) {
  const deadline = Date.now() + TIMEOUT_MS;
  const noStartDeadline = Date.now() + settleMs;
  let sawStart = false;

  while (Date.now() < deadline) {
    const events = readCounterEvents(counterFile);
    const stats = counterStats(events);
    sawStart ||= stats.startCount > 0;
    if (sawStart && stats.active === 0 && stats.startCount === stats.endCount) {
      await sleep(settleMs);
      return events;
    }
    if (!sawStart && Date.now() >= noStartDeadline) {
      return events;
    }
    await sleep(25);
  }

  await sleep(settleMs);
  return readCounterEvents(counterFile);
}

async function assertNoLaterNonEmptyDiagnostics(client, uri, cursor, label, options = {}) {
  if (options.counterFile) {
    await waitForCounterCompletionOrSettle(options.counterFile, options.settleMs ?? SETTLE_MS);
  } else {
    await sleep(options.settleMs ?? SETTLE_MS);
  }

  const stale = client.diagnosticsSince(cursor, uri).filter((params) => params.diagnostics.length > 0);
  assert(
    stale.length === 0,
    `${label}: received non-empty diagnostics after expected clear: ${JSON.stringify(stale)}`,
  );
}

async function testHomeComponentDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before definition");
    const result = await client.definition(HOME_WXML, { line: 7, character: 3 });
    assertLocationTarget(result, USER_CARD_WXML);
  });
}

async function testImportDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before import definition");
    const result = await client.definition(HOME_WXML, { line: 0, character: 2 });
    assertLocationTarget(result, COMMON_WXML);
  });
}

async function testIncludeDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before include definition");
    const result = await client.definition(HOME_WXML, { line: 1, character: 2 });
    assertLocationTarget(result, HEADER_WXML);
  });
}

async function testExternalWxsDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before wxs definition");
    const result = await client.definition(HOME_WXML, { line: 2, character: 2 });
    assertLocationTarget(result, FORMAT_WXS);
  });
}

async function testStaticTemplateDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before template definition");
    const result = await client.definition(HOME_WXML, { line: 5, character: 4 });
    assertLocation(
      result,
      COMMON_WXML,
      { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
      "static template definition",
    );
  });
}

async function testNestedComponentDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(USER_CARD_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 0, "user-card diagnostics before definition");
    const result = await client.definition(USER_CARD_WXML, { line: 2, character: 3 });
    assertLocationTarget(result, STATUS_BADGE_WXML);
  });
}

async function testMissingComponentDefinitionReturnsNull() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "missing-card diagnostics before definition");
    const result = await client.definition(HOME_WXML, { line: 14, character: 3 });
    assertNullDefinition(result, "missing-card definition");
  });
}

async function testNonComponentDefinitionReturnsNull() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before non-component definition");
    const result = await client.definition(HOME_WXML, { line: 3, character: 0 });
    assertNullDefinition(result, "blank line definition");
  });
}

async function testBuiltinDefinitionReturnsNull() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before builtin definition");
    const result = await client.definition(HOME_WXML, { line: 4, character: 3 });
    assertNullDefinition(result, "builtin view definition");
  });
}

async function testDefinitionBuildsGraphWithoutPriorDiagnostics() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const result = await client.definition(HOME_WXML, { line: 7, character: 3 });
    assertLocationTarget(result, USER_CARD_WXML);
  });
}

async function testDefinitionBuildDoesNotBlockRequestLoop() {
  await withClient({
    rootPath: ROOT,
    env: {
      WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
    },
  }, async (client) => {
    const definitionPromise = client.definition(HOME_WXML, { line: 7, character: 3 });
    const id = client.request("workspace/symbol", { query: "user-card" });
    const response = await client.waitForResponse(id);
    assert(response.error?.code === -32601, `Expected responsive -32601, got ${JSON.stringify(response)}`);
    assertLocationTarget(await definitionPromise, USER_CARD_WXML);
  });
}

async function testHomeDocumentSymbols() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before document symbols");
    const result = await client.documentSymbols(HOME_WXML);
    assertHomeDocumentSymbols(result);
  });
}

async function testTemplateDocumentSymbols() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const result = await client.documentSymbols(COMMON_WXML);
    assertTemplateDocumentSymbols(result);
  });
}

async function testComponentUsageDocumentSymbolsExcluded() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const result = await client.documentSymbols(USER_CARD_WXML);
    assertDeepEqual(result, [], "component usage document symbols");
  });
}

async function testDocumentSymbolsBuildGraphWithoutPriorDiagnostics() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const result = await client.documentSymbols(HOME_WXML);
    assertHomeDocumentSymbols(result);
  });
}

async function testDocumentSymbolsBuildDoesNotBlockRequestLoop() {
  await withClient({
    rootPath: ROOT,
    env: {
      WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
    },
  }, async (client) => {
    const symbolsPromise = client.documentSymbols(HOME_WXML);
    const id = client.request("workspace/symbol", { query: "format" });
    const response = await client.waitForResponse(id);
    assert(response.error?.code === -32601, `Expected responsive -32601, got ${JSON.stringify(response)}`);
    assertHomeDocumentSymbols(await symbolsPromise);
  });
}

async function testRepositoryRootInitialization() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    const params = await client.waitForDiagnostics(uri, (items) => items.length === 1, "repo-root diagnostics");
    assertMissingCardDiagnostic(params.diagnostics[0], HOME_WXML);
  });
}

async function testMiniProgramRootInitialization() {
  await withClient({ rootPath: MINIPROGRAM_ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    const params = await client.waitForDiagnostics(uri, (items) => items.length === 1, "miniprogram-root diagnostics");
    assertMissingCardDiagnostic(params.diagnostics[0], HOME_WXML);
  });
}

async function testCleanComponentFile() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(USER_CARD_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 0, "clean component diagnostics");
  });
}

async function testDidCloseClearsDiagnostics() {
  const counterFile = path.join(os.tmpdir(), `wxml-zed-lsp-close-counter-${process.pid}.jsonl`);
  fs.rmSync(counterFile, { force: true });

  try {
    await withClient({
      rootPath: ROOT,
      env: {
        WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
        WXML_ZED_LSP_GRAPH_COUNTER_FILE: counterFile,
      },
    }, async (client) => {
      const uri = client.openDocument(HOME_WXML);
      const closeCursor = client.diagnosticCursor();
      client.closeDocument(HOME_WXML);
      await client.waitForDiagnosticsAfter(uri, closeCursor, (items) => items.length === 0, "didClose empty diagnostics");
      await assertNoLaterNonEmptyDiagnostics(client, uri, closeCursor, "didClose post-clear diagnostics", {
        counterFile,
      });
    });
  } finally {
    fs.rmSync(counterFile, { force: true });
  }
}

async function testDidSaveRefreshClearsFixedComponent() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wxml-zed-lsp-refresh-"));
  try {
    fs.cpSync(MINIPROGRAM_ROOT, tempRoot, { recursive: true });
    const tempHome = path.join(tempRoot, "pages/home/home.wxml");
    await withClient({ rootPath: tempRoot }, async (client) => {
      const uri = client.openDocument(tempHome);
      const first = await client.waitForDiagnostics(uri, (items) => items.length === 1, "temp missing-card diagnostics");
      assertMissingCardDiagnostic(first.diagnostics[0], tempHome);

      const missingDir = path.join(tempRoot, "components/missing-card");
      fs.mkdirSync(missingDir, { recursive: true });
      fs.writeFileSync(path.join(missingDir, "missing-card.wxml"), "<view />\n");
      fs.writeFileSync(path.join(missingDir, "missing-card.json"), "{\"component\":true}\n");

      const saveCursor = client.diagnosticCursor();
      client.saveDocument(tempHome);
      await client.waitForDiagnosticsAfter(uri, saveCursor, (items) => items.length === 0, "didSave refresh diagnostics");
      await assertNoLaterNonEmptyDiagnostics(client, uri, saveCursor, "didSave post-clear diagnostics");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testUnsupportedRequest() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const id = client.request("workspace/symbol", { query: "missing-card" });
    const response = await client.waitForResponse(id);
    assert(response.error?.code === -32601, `Expected -32601, got ${JSON.stringify(response)}`);
  });
}

function assertNoConcurrentExtractor(events) {
  const stats = counterStats(events);
  assert(stats.minActive >= 0, `Extractor counter ended before start: ${JSON.stringify(events)}`);
  assert(stats.active === 0, `Extractor counter did not settle to zero: ${JSON.stringify(events)}`);
  assert(stats.startCount === stats.endCount, `Extractor counter start/end mismatch: ${JSON.stringify(events)}`);
  assert(
    stats.startCount <= 2,
    `Expected at most two graph extractor starts, saw ${stats.startCount}: ${JSON.stringify(events)}`,
  );
  assert(stats.maxActive <= 1, `Expected no concurrent graph extractors, saw ${stats.maxActive}: ${JSON.stringify(events)}`);
}

async function testAsyncCoalescingAndResponsiveness() {
  const counterFile = path.join(os.tmpdir(), `wxml-zed-lsp-counter-${process.pid}.jsonl`);
  fs.rmSync(counterFile, { force: true });

  try {
    await withClient({
      rootPath: ROOT,
      env: {
        WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
        WXML_ZED_LSP_GRAPH_COUNTER_FILE: counterFile,
      },
    }, async (client) => {
      const uri = client.openDocument(HOME_WXML);
      client.saveDocument(HOME_WXML);
      client.saveDocument(HOME_WXML);

      const id = client.request("workspace/symbol", { query: "missing-card" });
      const response = await client.waitForResponse(id);
      assert(response.error?.code === -32601, `Expected responsive -32601, got ${JSON.stringify(response)}`);

      const responseIndex = client.messageIndex((message) => message.id === id);
      const diagnosticIndex = client.messageIndex((message) => (
        message.method === "textDocument/publishDiagnostics" &&
        message.params.uri === uri
      ));
      assert(responseIndex !== -1, "Missing workspace/symbol response in message log");
      assert(diagnosticIndex === -1 || responseIndex < diagnosticIndex, "workspace/symbol response arrived after diagnostics");

      await client.waitForDiagnostics(uri, (items) => items.length === 1, "coalesced diagnostics");
      assertNoConcurrentExtractor(readCounterEvents(counterFile));
    });
  } finally {
    fs.rmSync(counterFile, { force: true });
  }
}

const scenarios = [
  ["home component definition", testHomeComponentDefinition],
  ["import definition", testImportDefinition],
  ["include definition", testIncludeDefinition],
  ["external wxs definition", testExternalWxsDefinition],
  ["static template definition", testStaticTemplateDefinition],
  ["nested component definition", testNestedComponentDefinition],
  ["missing component definition returns null", testMissingComponentDefinitionReturnsNull],
  ["non-component definition returns null", testNonComponentDefinitionReturnsNull],
  ["builtin definition returns null", testBuiltinDefinitionReturnsNull],
  ["definition builds graph without prior diagnostics", testDefinitionBuildsGraphWithoutPriorDiagnostics],
  ["definition build does not block request loop", testDefinitionBuildDoesNotBlockRequestLoop],
  ["home document symbols", testHomeDocumentSymbols],
  ["template document symbols", testTemplateDocumentSymbols],
  ["component usage document symbols excluded", testComponentUsageDocumentSymbolsExcluded],
  ["document symbols build graph without prior diagnostics", testDocumentSymbolsBuildGraphWithoutPriorDiagnostics],
  ["document symbols build does not block request loop", testDocumentSymbolsBuildDoesNotBlockRequestLoop],
  ["repository root initialization", testRepositoryRootInitialization],
  ["mini program root initialization", testMiniProgramRootInitialization],
  ["clean component file", testCleanComponentFile],
  ["didClose clears diagnostics", testDidCloseClearsDiagnostics],
  ["didSave refresh clears fixed component", testDidSaveRefreshClearsFixedComponent],
  ["unsupported request behavior", testUnsupportedRequest],
  ["coalesced async build behavior", testAsyncCoalescingAndResponsiveness],
];

async function main() {
  for (const [name, scenario] of scenarios) {
    process.stderr.write(`[verify-lsp-diagnostics] ${name}\n`);
    try {
      await scenario();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${name}: ${message}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
