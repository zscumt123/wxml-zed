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
const SECONDARY_WXML = path.join(MINIPROGRAM_ROOT, "templates/secondary.wxml");
const FORMAT_WXS = path.join(MINIPROGRAM_ROOT, "utils/format.wxs");
const SHOP_LIST_WXML = path.join(MINIPROGRAM_ROOT, "packages/shop/pages/list/list.wxml");
const GLOBAL_BADGE_WXML = path.join(MINIPROGRAM_ROOT, "components/global-badge/global-badge.wxml");
// Some coalescing scenarios intentionally wait for two serial graph extractor
// runs; local Tree-sitter extraction can take multiple minutes per run.
const TIMEOUT_MS = 600_000;
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

function assertMissingComponentDiagnostic(diagnostic, sourceFile, tag, value) {
  assert(diagnostic, `Missing diagnostic for ${tag}`);
  assert(diagnostic.severity === 2, `Expected warning severity, got ${diagnostic.severity}`);
  assert(diagnostic.source === "wxml-zed", `Unexpected diagnostic source: ${diagnostic.source}`);
  assert(diagnostic.code === "missing-local-component", `Unexpected diagnostic code: ${diagnostic.code}`);
  assert(
    diagnostic.message === `Missing local component "${tag}": ${value}`,
    `Unexpected diagnostic message: ${diagnostic.message}`,
  );

  const text = fs.readFileSync(sourceFile, "utf8");
  const start = lineCharToOffset(text, diagnostic.range.start);
  const end = lineCharToOffset(text, diagnostic.range.end);
  assert(
    text.slice(start, end).includes(`<${tag}`),
    `Diagnostic is not attached to ${tag} in ${sourceFile}: ${text.slice(start, end)}`,
  );
}

function assertMissingCardDiagnostic(diagnostic, sourceFile) {
  assertMissingComponentDiagnostic(
    diagnostic,
    sourceFile,
    "missing-card",
    "../../components/missing-card/missing-card",
  );

  const expectedRange = {
    start: { line: 14, character: 2 },
    end: { line: 14, character: 43 },
  };
  assertDeepEqual(diagnostic.range, expectedRange, "missing-card diagnostic range");
}

function diagnosticByCodeAndTag(diagnostics, tag) {
  return diagnostics.find((diagnostic) => (
    diagnostic.code === "missing-local-component" &&
    diagnostic.message.includes(`"${tag}"`)
  ));
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
      ["fixtures/miniprogram/templates/secondary.wxml", 1, "include"],
      ["format", 2, "wxs"],
    ],
    "home document symbol identity/order",
  );
  assertDeepEqual(
    symbols.map((symbol) => symbol.range),
    [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 44 } },
      { start: { line: 1, character: 0 }, end: { line: 1, character: 48 } },
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

function completionLabels(items) {
  assert(Array.isArray(items), `Expected completion items array, got ${JSON.stringify(items)}`);
  return items.map((item) => item.label);
}

function assertCompletionLabelsInclude(items, expectedLabels, label) {
  const labels = completionLabels(items);
  for (const expectedLabel of expectedLabels) {
    assert(labels.includes(expectedLabel), `${label}: missing completion ${expectedLabel}; got ${JSON.stringify(labels)}`);
  }
}

function assertCompletionTextEdit(items, itemLabel, expectedTextEdit, label) {
  const item = items.find((candidate) => candidate.label === itemLabel);
  assert(item, `${label}: missing completion ${itemLabel}; got ${JSON.stringify(items)}`);
  assertDeepEqual(item.textEdit, expectedTextEdit, `${label} ${itemLabel} textEdit`);
}

class LspClient {
  constructor({ rootPath, env = {}, watchDynamicRegistration = false }) {
    this.rootPath = rootPath;
    this.env = env;
    this.watchDynamicRegistration = watchDynamicRegistration;
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

  respondToServerRequest(id, result) {
    writeMessage(this.server.stdin, { jsonrpc: "2.0", id, result });
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

  async completion(filePath, position) {
    const id = this.request("textDocument/completion", {
      textDocument: { uri: pathToFileURL(filePath).href },
      position,
    });
    const response = await this.waitForResponse(id);
    if (response.error) {
      throw new Error(`Completion request failed: ${JSON.stringify(response.error)}`);
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

  waitForServerRequest(method, label) {
    const existing = this.messages.find((message) => message.method === method && Object.hasOwn(message, "id"));
    if (existing) return Promise.resolve(existing);
    return this.waitFor(
      (message) => message.method === method && Object.hasOwn(message, "id"),
      label,
    );
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
        workspace: {
          didChangeWatchedFiles: {
            dynamicRegistration: this.watchDynamicRegistration,
          },
        },
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
    assert(response.result?.capabilities?.textDocumentSync?.change === 1, "full text sync not advertised");
    assert(response.result?.capabilities?.definitionProvider === true, "definitionProvider not advertised");
    assert(response.result?.capabilities?.documentSymbolProvider === true, "documentSymbolProvider not advertised");
    assert(response.result?.capabilities?.completionProvider, "completionProvider not advertised");
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

  changeDocument(filePath, text, version = 2) {
    const uri = pathToFileURL(filePath).href;
    this.send("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    return uri;
  }

  changeWatchedFiles(filePaths, type = 2) {
    this.send("workspace/didChangeWatchedFiles", {
      changes: filePaths.map((filePath) => ({
        uri: pathToFileURL(filePath).href,
        type,
      })),
    });
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

function copyMiniProgramFixture(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(MINIPROGRAM_ROOT, tempRoot, { recursive: true });
  return tempRoot;
}

function homeWxmlIn(root) {
  return path.join(root, "pages/home/home.wxml");
}

function homeJsonIn(root) {
  return path.join(root, "pages/home/home.json");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertNoConcurrentExtractorWithMax(events, maxStartCount, label) {
  const stats = counterStats(events);
  assert(stats.minActive >= 0, `${label}: extractor counter ended before start: ${JSON.stringify(events)}`);
  assert(stats.active === 0, `${label}: extractor counter did not settle to zero: ${JSON.stringify(events)}`);
  assert(stats.startCount === stats.endCount, `${label}: extractor counter start/end mismatch: ${JSON.stringify(events)}`);
  assert(
    stats.startCount <= maxStartCount,
    `${label}: expected at most ${maxStartCount} graph extractor starts, saw ${stats.startCount}: ${JSON.stringify(events)}`,
  );
  assert(stats.maxActive <= 1, `${label}: expected no concurrent graph extractors, saw ${stats.maxActive}: ${JSON.stringify(events)}`);
}

async function waitForCounterEventsAfter(counterFile, previousEventCount, label, settleMs = SETTLE_MS) {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const events = readCounterEvents(counterFile);
    const nextEvents = events.slice(previousEventCount);
    const stats = counterStats(nextEvents);
    if (stats.startCount > 0 && stats.active === 0 && stats.startCount === stats.endCount) {
      await sleep(settleMs);
      return readCounterEvents(counterFile);
    }
    await sleep(25);
  }

  const events = readCounterEvents(counterFile);
  assert(false, `${label}: expected graph build after event ${previousEventCount}, got ${JSON.stringify(events)}`);
}

async function testHomeComponentDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before definition");
    const result = await client.definition(HOME_WXML, { line: 7, character: 3 });
    assertLocationTarget(result, USER_CARD_WXML);
  });
}

async function testEventHandlerDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before event handler definition");
    // home.wxml line 11: `    bind:select="handleSelect"` — cursor on `handleSelect` text.
    const result = await client.definition(HOME_WXML, { line: 11, character: 20 });
    assert(result, "expected Location from event handler definition, got null");
    assert(
      result.uri.endsWith("/fixtures/miniprogram/pages/home/home.js"),
      `event handler definition uri: expected home.js, got ${result.uri}`,
    );
    assert(
      typeof result.range.start.line === "number",
      `event handler definition range shape bad: ${JSON.stringify(result.range)}`,
    );
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
    assertLocationTarget(result, SECONDARY_WXML);
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

async function testDirectIncludeTemplateDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before direct include template definition");
    const result = await client.definition(HOME_WXML, { line: 21, character: 4 });
    assertLocation(
      result,
      SECONDARY_WXML,
      { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
      "direct include template definition",
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

async function testCompletionImmediatelyAfterOpen() {
  await withClient({ rootPath: ROOT }, async (client) => {
    client.openDocument(HOME_WXML);
    const result = await client.completion(HOME_WXML, { line: 7, character: 6 });
    assertCompletionLabelsInclude(result, ["global-badge", "user-card", "view"], "completion immediately after open");
  });
}

async function testTagCompletion() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before tag completion");
    const result = await client.completion(HOME_WXML, { line: 7, character: 6 });
    assertCompletionLabelsInclude(result, ["global-badge", "user-card", "view"], "tag completion");
    assertCompletionTextEdit(
      result,
      "user-card",
      {
        range: { start: { line: 7, character: 3 }, end: { line: 7, character: 6 } },
        newText: "user-card",
      },
      "tag completion",
    );
  });
}

async function testEventHandlerCompletion() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(
      uri,
      (items) => items.length === 1,
      "home diagnostics before event handler completion",
    );
    // home.wxml line 12 `    bind:select="handleSelect"` — cursor after `hand`.
    const result = await client.completion(HOME_WXML, { line: 11, character: 21 });
    assertCompletionLabelsInclude(result, ["handleSelect"], "event handler completion");
    assertCompletionTextEdit(
      result,
      "handleSelect",
      {
        range: { start: { line: 11, character: 17 }, end: { line: 11, character: 21 } },
        newText: "handleSelect",
      },
      "event handler completion",
    );
  });
}

async function testTemplateCompletion() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before template completion");
    const result = await client.completion(HOME_WXML, { line: 5, character: 20 });
    assertCompletionLabelsInclude(result, ["loadingRow", "secondaryRow"], "template completion");
    assertCompletionTextEdit(
      result,
      "loadingRow",
      {
        range: { start: { line: 5, character: 16 }, end: { line: 5, character: 20 } },
        newText: "loadingRow",
      },
      "template completion",
    );
  });
}

async function testAttributeCompletion() {
  const source = `${fs.readFileSync(HOME_WXML, "utf8")}\n<view wx: />\n`;
  await withClient({ rootPath: ROOT }, async (client) => {
    client.openDocument(HOME_WXML);
    client.changeDocument(HOME_WXML, source);
    const result = await client.completion(HOME_WXML, { line: 23, character: 9 });
    assertCompletionLabelsInclude(result, ["wx:if", "bindtap", "capture-bind:tap"], "attribute completion");
  });
}

async function testDidChangeUpdatesCompletionSource() {
  const source = `${fs.readFileSync(HOME_WXML, "utf8")}\n<template is="sec" />\n`;
  await withClient({ rootPath: ROOT }, async (client) => {
    client.openDocument(HOME_WXML);
    client.changeDocument(HOME_WXML, source);
    const result = await client.completion(HOME_WXML, { line: 23, character: 17 });
    assertCompletionLabelsInclude(result, ["secondaryRow"], "didChange completion source");
    assertCompletionTextEdit(
      result,
      "secondaryRow",
      {
        range: { start: { line: 23, character: 14 }, end: { line: 23, character: 17 } },
        newText: "secondaryRow",
      },
      "didChange completion source",
    );
  });
}

async function testDidSavePreservesCompletionSource() {
  const source = `${fs.readFileSync(HOME_WXML, "utf8")}\n<template is="sec" />\n`;
  await withClient({ rootPath: ROOT }, async (client) => {
    client.openDocument(HOME_WXML);
    client.changeDocument(HOME_WXML, source);
    client.saveDocument(HOME_WXML);
    const result = await client.completion(HOME_WXML, { line: 23, character: 17 });
    assertCompletionLabelsInclude(result, ["secondaryRow"], "didSave completion source");
    assertCompletionTextEdit(
      result,
      "secondaryRow",
      {
        range: { start: { line: 23, character: 14 }, end: { line: 23, character: 17 } },
        newText: "secondaryRow",
      },
      "didSave completion source",
    );
  });
}

async function testCompletionBuildDoesNotBlockRequestLoop() {
  await withClient({
    rootPath: ROOT,
    env: {
      WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
    },
  }, async (client) => {
    client.openDocument(HOME_WXML);
    const completionPromise = client.completion(HOME_WXML, { line: 7, character: 6 });
    const id = client.request("workspace/symbol", { query: "user-card" });
    const response = await client.waitForResponse(id);
    assert(response.error?.code === -32601, `Expected responsive -32601, got ${JSON.stringify(response)}`);
    assertCompletionLabelsInclude(await completionPromise, ["user-card", "view"], "completion responsive build");
  });
}

async function testWatchedJsonUsingComponentsRefresh() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-json-");
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const tempHomeJson = homeJsonIn(tempRoot);
    await withClient({ rootPath: tempRoot }, async (client) => {
      const uri = client.openDocument(tempHome);
      const first = await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched json initial diagnostics");
      assertMissingCardDiagnostic(first.diagnostics[0], tempHome);

      const config = JSON.parse(fs.readFileSync(tempHomeJson, "utf8"));
      config.usingComponents["missing-card"] = "../../components/user-card/user-card";
      writeJson(tempHomeJson, config);

      const cursor = client.diagnosticCursor();
      client.changeWatchedFiles([tempHomeJson]);
      await client.waitForDiagnosticsAfter(uri, cursor, (items) => items.length === 0, "watched json clears diagnostics");

      const completions = await client.completion(tempHome, { line: 14, character: 10 });
      assertCompletionLabelsInclude(completions, ["missing-card"], "watched json completion refresh");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testWatchedComponentCreationRefresh() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-create-");
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const missingDir = path.join(tempRoot, "components/missing-card");
    const missingWxml = path.join(missingDir, "missing-card.wxml");
    const missingJson = path.join(missingDir, "missing-card.json");
    await withClient({ rootPath: tempRoot }, async (client) => {
      const uri = client.openDocument(tempHome);
      const first = await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched create initial diagnostics");
      assertMissingCardDiagnostic(first.diagnostics[0], tempHome);

      fs.mkdirSync(missingDir, { recursive: true });
      fs.writeFileSync(missingWxml, "<view />\n");
      fs.writeFileSync(missingJson, "{\"component\":true}\n");

      const cursor = client.diagnosticCursor();
      client.changeWatchedFiles([missingWxml, missingJson], 1);
      await client.waitForDiagnosticsAfter(uri, cursor, (items) => items.length === 0, "watched create clears diagnostics");

      const completions = await client.completion(tempHome, { line: 14, character: 10 });
      assertCompletionLabelsInclude(completions, ["missing-card"], "watched create completion refresh");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testWatchedComponentDeletionRefresh() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-delete-");
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const userCardWxml = path.join(tempRoot, "components/user-card/user-card.wxml");
    await withClient({ rootPath: tempRoot }, async (client) => {
      const uri = client.openDocument(tempHome);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched delete initial diagnostics");

      fs.rmSync(userCardWxml, { force: true });

      const cursor = client.diagnosticCursor();
      client.changeWatchedFiles([userCardWxml], 3);
      const refreshed = await client.waitForDiagnosticsAfter(
        uri,
        cursor,
        (items) => Boolean(diagnosticByCodeAndTag(items, "user-card")),
        "watched delete user-card diagnostics",
      );
      assertMissingComponentDiagnostic(
        diagnosticByCodeAndTag(refreshed.diagnostics, "user-card"),
        tempHome,
        "user-card",
        "../../components/user-card/user-card",
      );

      const definition = await client.definition(tempHome, { line: 7, character: 3 });
      assertNullDefinition(definition, "watched delete user-card definition");

      const completions = await client.completion(tempHome, { line: 7, character: 6 });
      assert(!completionLabels(completions).includes("user-card"), "watched delete should remove user-card completion");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testWatchedRefreshCoalescesAndStaysResponsive() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-coalesce-");
  const counterFile = path.join(os.tmpdir(), `wxml-zed-lsp-watch-counter-${process.pid}.jsonl`);
  fs.rmSync(counterFile, { force: true });
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const tempHomeJson = homeJsonIn(tempRoot);
    const tempAppJson = path.join(tempRoot, "app.json");
    await withClient({
      rootPath: tempRoot,
      env: {
        WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
        WXML_ZED_LSP_GRAPH_COUNTER_FILE: counterFile,
      },
    }, async (client) => {
      const uri = client.openDocument(tempHome);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched coalesce initial diagnostics");
      fs.writeFileSync(tempHomeJson, fs.readFileSync(tempHomeJson, "utf8"));
      fs.writeFileSync(tempAppJson, fs.readFileSync(tempAppJson, "utf8"));

      client.changeWatchedFiles([tempHomeJson]);
      client.changeWatchedFiles([tempAppJson]);
      client.changeWatchedFiles([tempHomeJson, tempAppJson]);

      const id = client.request("workspace/symbol", { query: "user-card" });
      const response = await client.waitForResponse(id);
      assert(response.error?.code === -32601, `Expected responsive -32601, got ${JSON.stringify(response)}`);

      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched coalesce diagnostics settle");
      const events = await waitForCounterCompletionOrSettle(counterFile);
      assertNoConcurrentExtractorWithMax(events, 3, "watched coalesce");
    });
  } finally {
    fs.rmSync(counterFile, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testWatchedRefreshRequestsWaitForFreshGraph() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-request-");
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const tempHomeJson = homeJsonIn(tempRoot);
    await withClient({
      rootPath: tempRoot,
      env: {
        WXML_ZED_LSP_GRAPH_DELAY_MS: "250",
      },
    }, async (client) => {
      const uri = client.openDocument(tempHome);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched request initial diagnostics");

      const config = JSON.parse(fs.readFileSync(tempHomeJson, "utf8"));
      config.usingComponents["missing-card"] = "../../components/user-card/user-card";
      writeJson(tempHomeJson, config);

      const cursor = client.diagnosticCursor();
      client.changeWatchedFiles([tempHomeJson]);
      const completionPromise = client.completion(tempHome, { line: 14, character: 10 });

      await client.waitForDiagnosticsAfter(uri, cursor, (items) => items.length === 0, "watched request diagnostics refresh");
      const completions = await completionPromise;
      assertCompletionLabelsInclude(completions, ["missing-card"], "watched request completion waits for fresh graph");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testWatchedRefreshDoesNotPublishClosedDocumentDiagnostics() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-closed-");
  const counterFile = path.join(os.tmpdir(), `wxml-zed-lsp-watch-closed-${process.pid}.jsonl`);
  fs.rmSync(counterFile, { force: true });
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const tempHomeJson = homeJsonIn(tempRoot);
    await withClient({
      rootPath: tempRoot,
      env: {
        WXML_ZED_LSP_GRAPH_COUNTER_FILE: counterFile,
      },
    }, async (client) => {
      const uri = client.openDocument(tempHome);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched closed initial diagnostics");

      const closeCursor = client.diagnosticCursor();
      client.closeDocument(tempHome);
      await client.waitForDiagnosticsAfter(uri, closeCursor, (items) => items.length === 0, "watched closed didClose diagnostics");

      const eventCount = readCounterEvents(counterFile).length;
      fs.writeFileSync(tempHomeJson, fs.readFileSync(tempHomeJson, "utf8"));
      client.changeWatchedFiles([tempHomeJson]);
      await waitForCounterEventsAfter(counterFile, eventCount, "watched closed refresh");

      const later = client.diagnosticsSince(closeCursor, uri);
      assert(
        later.length === 1 && later[0].diagnostics.length === 0,
        `closed document should only receive didClose diagnostics: ${JSON.stringify(later)}`,
      );
    });
  } finally {
    fs.rmSync(counterFile, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testWatchedIrrelevantChangesIgnored() {
  const tempRoot = copyMiniProgramFixture("wxml-zed-lsp-watch-ignore-");
  const counterFile = path.join(os.tmpdir(), `wxml-zed-lsp-watch-ignore-${process.pid}.jsonl`);
  const outsideFile = path.join(os.tmpdir(), `wxml-zed-outside-${process.pid}.json`);
  fs.rmSync(counterFile, { force: true });
  try {
    const tempHome = homeWxmlIn(tempRoot);
    const ignoredPng = path.join(tempRoot, "assets/ignored.png");
    fs.mkdirSync(path.dirname(ignoredPng), { recursive: true });
    fs.writeFileSync(ignoredPng, "");
    fs.writeFileSync(outsideFile, "{}\n");

    await withClient({
      rootPath: tempRoot,
      env: {
        WXML_ZED_LSP_GRAPH_COUNTER_FILE: counterFile,
      },
    }, async (client) => {
      const uri = client.openDocument(tempHome);
      await client.waitForDiagnostics(uri, (items) => items.length === 1, "watched ignore initial diagnostics");
      const eventCount = readCounterEvents(counterFile).length;
      const cursor = client.diagnosticCursor();

      client.changeWatchedFiles([ignoredPng, outsideFile]);
      await sleep(SETTLE_MS);

      assert(readCounterEvents(counterFile).length === eventCount, "irrelevant changes should not start graph build");
      assert(
        client.diagnosticsSince(cursor, uri).length === 0,
        `irrelevant changes should not publish diagnostics: ${JSON.stringify(client.diagnosticsSince(cursor, uri))}`,
      );
    });
  } finally {
    fs.rmSync(counterFile, { force: true });
    fs.rmSync(outsideFile, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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

async function testSubpackageGlobalComponentDiagnosticsClean() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(SHOP_LIST_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 0, "shop list diagnostics");
  });
}

async function testSubpackageGlobalComponentDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(SHOP_LIST_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 0, "shop list diagnostics before definition");
    const result = await client.definition(SHOP_LIST_WXML, { line: 1, character: 3 });
    assertLocationTarget(result, GLOBAL_BADGE_WXML);
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

async function testWatchRegistrationWhenSupported() {
  await withClient({
    rootPath: ROOT,
    watchDynamicRegistration: true,
  }, async (client) => {
    const request = await client.waitForServerRequest("client/registerCapability", "watch registration request");
    assert(request.id === "wxml-zed-watch-registration", `Unexpected watch registration id: ${JSON.stringify(request.id)}`);
    assert(Array.isArray(request.params?.registrations), `Missing registrations: ${JSON.stringify(request.params)}`);
    assert(request.params.registrations.length === 1, `Expected one registration: ${JSON.stringify(request.params.registrations)}`);

    const [registration] = request.params.registrations;
    assert(registration.id === "wxml-zed-watched-files", `Unexpected registration id: ${registration.id}`);
    assert(
      registration.method === "workspace/didChangeWatchedFiles",
      `Unexpected registration method: ${registration.method}`,
    );
    const watchers = registration.registerOptions?.watchers;
    assert(Array.isArray(watchers), `Missing watchers: ${JSON.stringify(registration)}`);
    assertDeepEqual(
      watchers.map((watcher) => watcher.globPattern),
      ["**/*.json", "**/*.wxml", "**/*.wxs"],
      "watch registration glob patterns",
    );

    client.respondToServerRequest(request.id, null);
    await sleep(SETTLE_MS);
    const errors = client.messages.filter((message) => (
      Object.hasOwn(message, "id") &&
      message.error?.code === -32601 &&
      String(message.error?.message || "").includes("client/registerCapability")
    ));
    assert(errors.length === 0, `watch registration response should not produce errors: ${JSON.stringify(errors)}`);
  });
}

async function testWatchRegistrationSkippedWhenUnsupported() {
  await withClient({
    rootPath: ROOT,
    watchDynamicRegistration: false,
  }, async (client) => {
    await sleep(SETTLE_MS);
    const registrations = client.messages.filter((message) => message.method === "client/registerCapability");
    assert(
      registrations.length === 0,
      `watch registration should not be sent without dynamicRegistration support: ${JSON.stringify(registrations)}`,
    );
  });
}

const scenarios = [
  ["watch registration when supported", testWatchRegistrationWhenSupported],
  ["watch registration skipped when unsupported", testWatchRegistrationSkippedWhenUnsupported],
  ["home component definition", testHomeComponentDefinition],
  ["event handler definition", testEventHandlerDefinition],
  ["import definition", testImportDefinition],
  ["include definition", testIncludeDefinition],
  ["external wxs definition", testExternalWxsDefinition],
  ["static template definition", testStaticTemplateDefinition],
  ["direct include template definition", testDirectIncludeTemplateDefinition],
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
  ["completion immediately after open", testCompletionImmediatelyAfterOpen],
  ["tag completion", testTagCompletion],
  ["template completion", testTemplateCompletion],
  ["attribute completion", testAttributeCompletion],
  ["didChange updates completion source", testDidChangeUpdatesCompletionSource],
  ["didSave preserves completion source", testDidSavePreservesCompletionSource],
  ["completion build does not block request loop", testCompletionBuildDoesNotBlockRequestLoop],
  ["watched json usingComponents refresh", testWatchedJsonUsingComponentsRefresh],
  ["watched component creation refresh", testWatchedComponentCreationRefresh],
  ["watched component deletion refresh", testWatchedComponentDeletionRefresh],
  ["watched refresh coalesces and stays responsive", testWatchedRefreshCoalescesAndStaysResponsive],
  ["watched refresh requests wait for fresh graph", testWatchedRefreshRequestsWaitForFreshGraph],
  ["watched refresh does not publish closed document diagnostics", testWatchedRefreshDoesNotPublishClosedDocumentDiagnostics],
  ["watched irrelevant changes ignored", testWatchedIrrelevantChangesIgnored],
  ["repository root initialization", testRepositoryRootInitialization],
  ["mini program root initialization", testMiniProgramRootInitialization],
  ["subpackage global component diagnostics clean", testSubpackageGlobalComponentDiagnosticsClean],
  ["subpackage global component definition", testSubpackageGlobalComponentDefinition],
  ["clean component file", testCleanComponentFile],
  ["didClose clears diagnostics", testDidCloseClearsDiagnostics],
  ["didSave refresh clears fixed component", testDidSaveRefreshClearsFixedComponent],
  ["unsupported request behavior", testUnsupportedRequest],
  ["coalesced async build behavior", testAsyncCoalescingAndResponsiveness],
  ["event handler completion", testEventHandlerCompletion],
];

const SCENARIO_SUITES = {
  fast: [
    "watch registration when supported",
    "watch registration skipped when unsupported",
  ],
  smoke: [
    "watch registration when supported",
    "watch registration skipped when unsupported",
    "unsupported request behavior",
  ],
  "graph-smoke": [
    "watch registration when supported",
    "watch registration skipped when unsupported",
    "home component definition",
    "event handler definition",
    "completion immediately after open",
    "event handler completion",
    "unsupported request behavior",
  ],
  full: scenarios.map(([name]) => name),
};

function parseArgs(args) {
  const filters = [];
  let suite = "full";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--suite") {
      const value = args[index + 1];
      assert(value, `--suite requires one of: ${Object.keys(SCENARIO_SUITES).join(", ")}`);
      suite = value.toLowerCase();
      index += 1;
      continue;
    }

    if (arg.startsWith("--suite=")) {
      suite = arg.slice("--suite=".length).toLowerCase();
      continue;
    }

    filters.push(arg.toLowerCase());
  }

  assert(
    Object.hasOwn(SCENARIO_SUITES, suite),
    `Unknown suite "${suite}". Expected one of: ${Object.keys(SCENARIO_SUITES).join(", ")}`,
  );

  return { filters, suite };
}

async function main() {
  const { filters, suite } = parseArgs(process.argv.slice(2));
  const suiteNames = new Set(SCENARIO_SUITES[suite]);
  const suiteScenarios = scenarios.filter(([name]) => suiteNames.has(name));
  const selectedScenarios = filters.length === 0
    ? suiteScenarios
    : suiteScenarios.filter(([name]) => filters.some((filter) => name.toLowerCase().includes(filter)));
  assert(
    selectedScenarios.length > 0,
    `No scenarios matched suite "${suite}" and filters: ${JSON.stringify(filters)}`,
  );

  for (const [name, scenario] of selectedScenarios) {
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
