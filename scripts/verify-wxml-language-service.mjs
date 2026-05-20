#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  getCompletions,
  getDefinition,
  getDiagnostics,
  getDocumentSymbols,
} from "../server/wxml-language-service.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAPH_EXTRACTOR = path.join(ROOT, "scripts/extract-wxml-project-graph.mjs");
const MINIPROGRAM_ROOT = path.join(ROOT, "fixtures/miniprogram");
const HOME_WXML = path.join(MINIPROGRAM_ROOT, "pages/home/home.wxml");
const USER_CARD_WXML = path.join(MINIPROGRAM_ROOT, "components/user-card/user-card.wxml");
const COMMON_WXML = path.join(MINIPROGRAM_ROOT, "templates/common.wxml");
const SECONDARY_WXML = path.join(MINIPROGRAM_ROOT, "templates/secondary.wxml");
const FORMAT_WXS = path.join(MINIPROGRAM_ROOT, "utils/format.wxs");
const SHOP_LIST_WXML = path.join(MINIPROGRAM_ROOT, "packages/shop/pages/list/list.wxml");
const GLOBAL_BADGE_WXML = path.join(MINIPROGRAM_ROOT, "components/global-badge/global-badge.wxml");
const LOCAL_BADGE_WXML = path.join(MINIPROGRAM_ROOT, "components/local-badge/local-badge.wxml");
const USER_CARD_TARGET = path.join(MINIPROGRAM_ROOT, "components/user-card/user-card.wxml");
const HOME_WXML_GRAPH_PATH = "fixtures/miniprogram/pages/home/home.wxml";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadGraph() {
  const output = execFileSync(process.execPath, [GRAPH_EXTRACTOR, MINIPROGRAM_ROOT], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output);
}

function assertDeepEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${label}: expected ${expectedJson}, got ${actualJson}`);
}

function sourceWithCursor(source) {
  const offset = source.indexOf("|");
  assert(offset !== -1, `Missing cursor marker in source: ${source}`);
  const cleanSource = source.slice(0, offset) + source.slice(offset + 1);
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return {
    source: cleanSource,
    position: {
      line: lines.length - 1,
      character: lines[lines.length - 1].length,
    },
  };
}

function homeSourceWithCursor(insert) {
  const source = fs.readFileSync(HOME_WXML, "utf8");
  return sourceWithCursor(`${source}\n${insert}`);
}

function completionLabels(items) {
  return items.map((item) => item.label);
}

function completionByLabel(items, label) {
  return items.find((item) => item.label === label);
}

function assertCompletionLabelsInclude(items, labels, label) {
  const actual = new Set(completionLabels(items));
  for (const expected of labels) {
    assert(actual.has(expected), `${label}: missing completion ${expected}; got ${JSON.stringify([...actual])}`);
  }
}

function assertNoCompletionLabel(items, forbidden, label) {
  assert(
    !completionLabels(items).includes(forbidden),
    `${label}: unexpected completion ${forbidden}; got ${JSON.stringify(completionLabels(items))}`,
  );
}

function assertCompletionTextEdit(item, range, newText, label) {
  assert(item, `${label}: missing completion item`);
  assertDeepEqual(item.textEdit, { range, newText }, `${label} textEdit`);
}

function assertMissingCardDiagnostic(graph) {
  const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
  assert(diagnostics.length === 1, `Expected one missing-card diagnostic, got ${diagnostics.length}`);
  assert(diagnostics[0].severity === 2, `Unexpected severity: ${JSON.stringify(diagnostics[0])}`);
  assert(diagnostics[0].source === "wxml-zed", `Unexpected source: ${JSON.stringify(diagnostics[0])}`);
  assert(diagnostics[0].code === "missing-local-component", `Unexpected code: ${JSON.stringify(diagnostics[0])}`);
  assert(
    diagnostics[0].message === 'Missing local component "missing-card": ../../components/missing-card/missing-card',
    `Unexpected message: ${diagnostics[0].message}`,
  );
  assertDeepEqual(
    diagnostics[0].range,
    { start: { line: 14, character: 2 }, end: { line: 14, character: 43 } },
    "missing-card diagnostic range",
  );
}

function assertShopListDiagnosticsClean(graph) {
  const diagnostics = getDiagnostics({ graph, documentPath: SHOP_LIST_WXML, extensionRoot: ROOT });
  assertDeepEqual(diagnostics, [], "shop list diagnostics");
}

// Phase 2 Stage C — Event handler diagnostic --------------------------

function assertEventHandlerDiagnosticCleanWhenHandlerExists(graph) {
  // home.wxml's bind:select="handleSelect" resolves to handleSelect in
  // home.js. No new warning. Existing assertMissingCardDiagnostic checks
  // length === 1; this double-locks by asserting no missing-event-handler.
  const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
  const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
  assert(
    handlerDiags.length === 0,
    `event handler diagnostic (clean): unexpected handler warnings ${JSON.stringify(handlerDiags)}`,
  );
}

function assertEventHandlerDiagnosticMissingHandler(graph) {
  // Mutate: drop handleSelect from home.js methods. The WXML still has
  // bind:select="handleSelect". Diagnostic must emit on the handler text.
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  assert(homeConfig && homeConfig.script, "test setup: home config must have script");
  const originalMethods = homeConfig.script.methods;
  homeConfig.script.methods = originalMethods.filter((m) => m.name !== "handleSelect");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
    assert(handlerDiags.length === 1, `expected 1 handler diagnostic, got ${handlerDiags.length}: ${JSON.stringify(handlerDiags)}`);
    const d = handlerDiags[0];
    assert(d.severity === 2, `severity: ${d.severity}`);
    assert(d.source === "wxml-zed", `source: ${d.source}`);
    assert(
      d.message === 'Event handler "handleSelect" is not defined in the page/component script.',
      `message: ${d.message}`,
    );
    assertDeepEqual(
      d.range,
      { start: { line: 11, character: 17 }, end: { line: 11, character: 29 } },
      "handler diagnostic range",
    );
  } finally {
    homeConfig.script.methods = originalMethods;
  }
}

function assertEventHandlerDiagnosticMissingHandlerNoColon(graph) {
  // Inject a synthetic non-dynamic handler with NO-colon binding form
  // (`bindtap`). Strict gate accepts via BUILTIN_EVENT_NAMES branch.
  // Locks the no-colon path of attrNameFromHandler + isEventHandlerCompletionTrigger.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  assert(homeFile && Array.isArray(homeFile.eventHandlers), "test setup: home file must have eventHandlers");
  const synthetic = {
    event: "tap",
    handler: "__missing_tap__",
    binding: "bind",
    dynamic: false,
    range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
  };
  homeFile.eventHandlers.push(synthetic);
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
    const ours = handlerDiags.find((d) => d.message.includes("__missing_tap__"));
    assert(
      ours,
      `event handler diagnostic (no-colon short form): expected emission for __missing_tap__; got ${JSON.stringify(handlerDiags)}`,
    );
    assert(ours.severity === 2, `severity: ${ours.severity}`);
    assert(ours.source === "wxml-zed", `source: ${ours.source}`);
  } finally {
    const idx = homeFile.eventHandlers.indexOf(synthetic);
    if (idx >= 0) homeFile.eventHandlers.splice(idx, 1);
  }
}

function assertEventHandlerDiagnosticSuppressedByDynamic(graph) {
  // Synthetic dynamic eventHandler pointing at a missing method —
  // dynamic:true must suppress.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  assert(homeFile && Array.isArray(homeFile.eventHandlers), "test setup: home file must have eventHandlers");
  const synthetic = {
    event: "tap",
    handler: "__missing_dynamic__",
    binding: "bind:",
    dynamic: true,
    range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
  };
  homeFile.eventHandlers.push(synthetic);
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
    assert(
      handlerDiags.every((d) => !d.message.includes("__missing_dynamic__")),
      `event handler diagnostic (dynamic suppress): leaked diagnostic ${JSON.stringify(handlerDiags)}`,
    );
  } finally {
    const idx = homeFile.eventHandlers.indexOf(synthetic);
    if (idx >= 0) homeFile.eventHandlers.splice(idx, 1);
  }
}

function assertEventHandlerDiagnosticSuppressedByDynamicMethods(graph) {
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  assert(homeConfig && homeConfig.script, "test setup: home config must have script");
  const originalMethods = homeConfig.script.methods;
  const originalFlag = homeConfig.script.hasDynamicMethods;
  homeConfig.script.methods = originalMethods.filter((m) => m.name !== "handleSelect");
  homeConfig.script.hasDynamicMethods = true;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
    assert(
      handlerDiags.length === 0,
      `event handler diagnostic (hasDynamicMethods): expected suppression, got ${JSON.stringify(handlerDiags)}`,
    );
  } finally {
    homeConfig.script.methods = originalMethods;
    homeConfig.script.hasDynamicMethods = originalFlag;
  }
}

function assertEventHandlerDiagnosticSuppressedByLooseBinding(graph) {
  // Synthetic eventHandler whose binding+event matches the loose data-model
  // regex but NOT the strict completion-trigger gate. attrName="binding"
  // (suffix "ing" not in BUILTIN_EVENT_NAMES, no colon).
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  assert(homeFile && Array.isArray(homeFile.eventHandlers), "test setup: home file must have eventHandlers");
  const synthetic = {
    event: "ing",
    handler: "__missing_loose__",
    binding: "bind",
    dynamic: false,
    range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
  };
  homeFile.eventHandlers.push(synthetic);
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
    assert(
      handlerDiags.every((d) => !d.message.includes("__missing_loose__")),
      `event handler diagnostic (loose binding suppress): leaked diagnostic ${JSON.stringify(handlerDiags)}`,
    );
  } finally {
    const idx = homeFile.eventHandlers.indexOf(synthetic);
    if (idx >= 0) homeFile.eventHandlers.splice(idx, 1);
  }
}

function assertEventHandlerDiagnosticSuppressedByBooleanIdiom(graph) {
  // `catchtouchmove="true"` is the WeChat idiom for blocking event bubble
  // without supplying a method — handler === "true" / "false" must not warn.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  assert(homeFile && Array.isArray(homeFile.eventHandlers), "test setup: home file must have eventHandlers");
  const truthy = {
    event: "touchmove",
    handler: "true",
    binding: "catch",
    dynamic: false,
    range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
  };
  const falsy = {
    event: "tap",
    handler: "false",
    binding: "bind",
    dynamic: false,
    range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
  };
  homeFile.eventHandlers.push(truthy, falsy);
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
    const leaked = handlerDiags.filter((d) => d.message.includes('"true"') || d.message.includes('"false"'));
    assert(
      leaked.length === 0,
      `event handler diagnostic (boolean idiom): leaked warnings ${JSON.stringify(leaked)}`,
    );
  } finally {
    for (const synth of [truthy, falsy]) {
      const idx = homeFile.eventHandlers.indexOf(synth);
      if (idx >= 0) homeFile.eventHandlers.splice(idx, 1);
    }
  }
}

function assertEventHandlerDiagnosticNoScriptSkips(graph) {
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  assert(homeConfig && homeConfig.script, "test setup: home config must have script");
  const savedScript = homeConfig.script;
  delete homeConfig.script;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
    assert(
      handlerDiags.length === 0,
      `event handler diagnostic (no script): expected suppression, got ${JSON.stringify(handlerDiags)}`,
    );
  } finally {
    homeConfig.script = savedScript;
  }
}

// Phase 3 Stage B — Data ref completion ---------------------------------

function assertDataRefCompletionMatchesData(graph) {
  // {{th|}} at top level of a view — should suggest data/properties/wxs/for names.
  const { source, position } = sourceWithCursor('<view>{{th|}}</view>\n');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  const labels = items.map((item) => item.label);
  assert(
    labels.includes("theme"),
    `data-ref completion (theme): missing "theme"; got ${JSON.stringify(labels)}`,
  );
}

function assertDataRefCompletionMatchesProperty(graph) {
  const { source, position } = sourceWithCursor('<view>{{u|}}</view>\n');
  const items = getCompletions({
    graph,
    documentPath: USER_CARD_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  const labels = items.map((item) => item.label);
  assert(
    labels.includes("user"),
    `data-ref completion (user): missing "user"; got ${JSON.stringify(labels)}`,
  );
}

function assertDataRefCompletionSuppressedAtMemberAccess(graph) {
  const { source, position } = sourceWithCursor('<view>{{user.na|}}</view>\n');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assert(
    Array.isArray(items) && items.length === 0,
    `data-ref completion (member access): expected [], got ${JSON.stringify(items)}`,
  );
}

function assertDataRefCompletionSuppressedInObjectLiteral(graph) {
  const { source, position } = sourceWithCursor('<view>{{key: val|}}</view>\n');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assert(
    Array.isArray(items) && items.length === 0,
    `data-ref completion (object literal): expected [], got ${JSON.stringify(items)}`,
  );
}

function assertDataRefCompletionIncludesWxsModule(graph) {
  const { source, position } = sourceWithCursor('<view>{{f|}}</view>\n');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  const labels = items.map((item) => item.label);
  assert(
    labels.includes("format"),
    `data-ref completion (wxs): missing "format"; got ${JSON.stringify(labels)}`,
  );
}

function assertDataRefCompletionSuppressedInTemplateDefinition(graph) {
  // Source-text walk in interpolationCompletionContext is the source of
  // truth for "is cursor inside <template name="X"> body?" — independent
  // of graph state. This exercises the real-world unsaved-buffer scenario:
  // user types a new template_definition that the graph doesn't know about
  // yet, but completion must still suppress owner data.
  const { source, position } = sourceWithCursor('<template name="X">{{th|}}</template>\n');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assert(
    Array.isArray(items) && items.length === 0,
    `data-ref completion (in template def): expected suppression, got ${JSON.stringify(items)}`,
  );
}

// Phase 3 Stage A — Expression reference diagnostic ------------------

// Phase 3 Stage B — Data ref definition ---------------------------------

function assertDataRefDefinitionToData(graph) {
  // home.wxml {{theme}} at line 4 col 20-25; cursor mid-name at col 22.
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 4, character: 22 },
    extensionRoot: ROOT,
  });
  assert(location, "data-ref definition (theme): expected Location, got null");
  assert(
    location.uri.endsWith("/fixtures/miniprogram/pages/home/home.js"),
    `data-ref definition (theme): uri ${location.uri}`,
  );
  assert(
    typeof location.range.start.line === "number" && typeof location.range.start.character === "number",
    `data-ref definition (theme): bad range ${JSON.stringify(location.range)}`,
  );
  assert(
    location.range.start.line >= 0 && location.range.start.line < 20,
    `data-ref definition (theme): line out of range ${location.range.start.line}`,
  );
  assert(
    location.range.end.character > location.range.start.character || location.range.end.line > location.range.start.line,
    `data-ref definition (theme): empty range ${JSON.stringify(location.range)}`,
  );
}

function assertDataRefDefinitionToProperty(graph) {
  // user-card.wxml {{user.name}} at line 1; user is the top-level ref.
  const location = getDefinition({
    graph,
    documentPath: USER_CARD_WXML,
    position: { line: 1, character: 25 },
    extensionRoot: ROOT,
  });
  assert(location, "data-ref definition (user): expected Location, got null");
  assert(
    location.uri.endsWith("/fixtures/miniprogram/components/user-card/user-card.js"),
    `data-ref definition (user): uri ${location.uri}`,
  );
  assert(
    typeof location.range.start.line === "number"
      && location.range.start.line >= 0
      && location.range.start.line < 20,
    `data-ref definition (user): line out of range ${JSON.stringify(location.range)}`,
  );
  assert(
    location.range.end.character > location.range.start.character || location.range.end.line > location.range.start.line,
    `data-ref definition (user): empty range ${JSON.stringify(location.range)}`,
  );
}

function assertDataRefDefinitionInTemplateReturnsNull(graph) {
  // Synthesize an expressionRef inside a template definition. The name
  // "theme" IS in home.js dataKeys — without inTemplateDefinition gating,
  // Definition would resolve. The gate must short-circuit and return null.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  assert(homeFile && Array.isArray(homeFile.expressionRefs), "test setup: home file must have expressionRefs");
  const originalRefs = homeFile.expressionRefs;
  const synthetic = {
    name: "theme",
    source: "interpolation",
    inTemplateDefinition: true,
    range: { start: { row: 100, column: 0 }, end: { row: 100, column: 5 } },
    expressionRange: { start: { row: 100, column: 0 }, end: { row: 100, column: 5 } },
  };
  homeFile.expressionRefs = [...originalRefs, synthetic];
  try {
    const location = getDefinition({
      graph,
      documentPath: HOME_WXML,
      position: { line: 100, character: 2 },
      extensionRoot: ROOT,
    });
    assert(
      location === null,
      `data-ref definition (in template def): expected null, got ${JSON.stringify(location)}`,
    );
  } finally {
    homeFile.expressionRefs = originalRefs;
  }
}

function assertDataRefDefinitionMissingKeyReturnsNull(graph) {
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  assert(homeConfig && homeConfig.script, "test setup: home config must have script");
  const original = homeConfig.script.dataKeys;
  homeConfig.script.dataKeys = original.filter((k) => k.name !== "theme");
  try {
    const location = getDefinition({
      graph,
      documentPath: HOME_WXML,
      position: { line: 4, character: 22 },
      extensionRoot: ROOT,
    });
    assert(
      location === null,
      `data-ref definition (missing key): expected null (authoritative miss), got ${JSON.stringify(location)}`,
    );
  } finally {
    homeConfig.script.dataKeys = original;
  }
}

function assertExpressionRefDiagnosticClean(graph) {
  const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
  const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
  assert(
    exprDiags.length === 0,
    `expression ref diagnostic (clean): unexpected warnings ${JSON.stringify(exprDiags)}`,
  );
}

function assertExpressionRefDiagnosticMissingInterpolation(graph) {
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  assert(homeConfig && homeConfig.script, "test setup: home config must have script");
  const original = homeConfig.script.dataKeys;
  homeConfig.script.dataKeys = original.filter((k) => k.name !== "theme");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
    const theme = exprDiags.find((d) => d.message.includes('"theme"'));
    assert(theme, `expected diagnostic for theme; got ${JSON.stringify(exprDiags)}`);
    assert(theme.severity === 2, `severity: ${theme.severity}`);
    assert(theme.source === "wxml-zed", `source: ${theme.source}`);
    assertDeepEqual(
      theme.range,
      { start: { line: 4, character: 20 }, end: { line: 4, character: 25 } },
      "theme diagnostic range",
    );
  } finally {
    homeConfig.script.dataKeys = original;
  }
}

function assertExpressionRefDiagnosticMissingDirective(graph) {
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  assert(homeConfig && homeConfig.script, "test setup: home config must have script");
  const original = homeConfig.script.dataKeys;
  homeConfig.script.dataKeys = original.filter((k) => k.name !== "users");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
    const users = exprDiags.find((d) => d.message.includes('"users"'));
    assert(users, `expected diagnostic for users; got ${JSON.stringify(exprDiags)}`);
    assertDeepEqual(
      users.range,
      { start: { line: 8, character: 14 }, end: { line: 8, character: 19 } },
      "users diagnostic range",
    );
  } finally {
    homeConfig.script.dataKeys = original;
  }
}

function assertExpressionRefDiagnosticSuppressedByWxsModule(graph) {
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  assert(homeConfig && homeConfig.script, "test setup: home config must have script");
  const original = homeConfig.script.dataKeys;
  homeConfig.script.dataKeys = [];
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
    const formatDiags = exprDiags.filter((d) => d.message.includes('"format"'));
    assert(
      formatDiags.length === 0,
      `expression ref diagnostic (wxs module): leaked "format" warning ${JSON.stringify(formatDiags)}`,
    );
  } finally {
    homeConfig.script.dataKeys = original;
  }
}

function assertExpressionRefDiagnosticSuppressedByWxForItem(graph) {
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  assert(homeConfig && homeConfig.script, "test setup: home config must have script");
  const originalKeys = homeConfig.script.dataKeys;
  homeConfig.script.dataKeys = [];
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
    const itemDiags = exprDiags.filter((d) => d.message.includes('"item"'));
    assert(
      itemDiags.length === 0,
      `expression ref diagnostic (wx:for default): leaked "item" warning ${JSON.stringify(itemDiags)}`,
    );
  } finally {
    homeConfig.script.dataKeys = originalKeys;
  }
}

function assertExpressionRefDiagnosticSuppressedByDynamicData(graph) {
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  assert(homeConfig && homeConfig.script, "test setup: home config must have script");
  const originalKeys = homeConfig.script.dataKeys;
  const originalFlag = homeConfig.script.hasDynamicData;
  homeConfig.script.dataKeys = [];
  homeConfig.script.hasDynamicData = true;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
    assert(
      exprDiags.length === 0,
      `expression ref diagnostic (hasDynamicData): expected suppression, got ${JSON.stringify(exprDiags)}`,
    );
  } finally {
    homeConfig.script.dataKeys = originalKeys;
    homeConfig.script.hasDynamicData = originalFlag;
  }
}

function assertExpressionRefDiagnosticNoScriptSkips(graph) {
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  assert(homeConfig && homeConfig.script, "test setup: home config must have script");
  const savedScript = homeConfig.script;
  delete homeConfig.script;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
    assert(
      exprDiags.length === 0,
      `expression ref diagnostic (no script): expected suppression, got ${JSON.stringify(exprDiags)}`,
    );
  } finally {
    homeConfig.script = savedScript;
  }
}

function assertFolderComponentResolvesViaIndex(graph) {
  // detail.json declares `usingComponents: { "folder-comp": "../../components/folder-comp" }`.
  // The path lacks a trailing /index, so resolution must fall back from
  // components/folder-comp.wxml (missing) to components/folder-comp/index.wxml.
  const entry = graph.usingComponents.find((u) => u.tag === "folder-comp");
  assert(entry, "folder-comp using-component entry missing from graph");
  assert(entry.resolved === true, `folder-comp not resolved: ${JSON.stringify(entry)}`);
  assert(
    entry.target === "fixtures/miniprogram/components/folder-comp/index.wxml",
    `folder-comp resolved to wrong target: ${entry.target}`,
  );
  assert(
    entry.config === "fixtures/miniprogram/components/folder-comp/index.json",
    `folder-comp resolved to wrong config: ${entry.config}`,
  );
}

function assertExpressionRefDiagnosticUserCardClean(graph) {
  // user-card.wxml references `user` three times ({{user.active ? 'active' : ''}},
  // {{user.name}}, status="{{user.status}}"). user-card.js declares `user` only
  // via Component({properties: {user: ...}}). Without propertyKeys in scope,
  // each of those refs false-positives — this assertion locks the fix.
  const diagnostics = getDiagnostics({ graph, documentPath: USER_CARD_WXML, extensionRoot: ROOT });
  const exprDiags = diagnostics.filter((d) => d.code === "missing-expression-ref");
  assert(
    exprDiags.length === 0,
    `expression ref diagnostic (user-card properties): unexpected warnings ${JSON.stringify(exprDiags)}`,
  );
}

function assertExpressionRefDiagnosticSuppressedInTemplateDefinition(graph) {
  // Inject a synthetic expressionRef with inTemplateDefinition=true pointing
  // at a name that's NOT in scope. Without the suppression, the diagnostic
  // would fire; with it, no warning.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  assert(homeFile, "test setup: home file must exist in graph.wxml");
  const originalRefs = homeFile.expressionRefs;
  const synthetic = {
    name: "__synthetic_template_internal__",
    source: "interpolation",
    inTemplateDefinition: true,
    range: { start: { row: 0, column: 0 }, end: { row: 0, column: 32 } },
    expressionRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 32 } },
  };
  homeFile.expressionRefs = [...originalRefs, synthetic];
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
    const leaked = diagnostics
      .filter((d) => d.code === "missing-expression-ref")
      .filter((d) => d.message.includes("__synthetic_template_internal__"));
    assert(
      leaked.length === 0,
      `expression ref diagnostic (template-definition): leaked warning ${JSON.stringify(leaked)}`,
    );
  } finally {
    homeFile.expressionRefs = originalRefs;
  }
}

function assertExpressionRefDiagnosticSyntheticForItemSuppresses(graph) {
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  assert(homeFile, "test setup: home file must exist in graph.wxml");
  assert(Array.isArray(homeFile.expressionRefs), "expressionRefs missing from home file model");
  const originalItems = homeFile.wxForBindings?.items ?? [];
  const originalRefs = homeFile.expressionRefs;
  const synthetic = {
    name: "__synthetic_for_user__",
    source: "interpolation",
    range: { start: { row: 0, column: 0 }, end: { row: 0, column: 24 } },
    expressionRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 24 } },
  };
  homeFile.expressionRefs = [...originalRefs, synthetic];
  try {
    const before = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT })
      .filter((d) => d.code === "missing-expression-ref" && d.message.includes("__synthetic_for_user__"));
    assert(before.length === 1, `pre-add: expected 1 synthetic warning, got ${before.length}`);

    homeFile.wxForBindings = {
      ...homeFile.wxForBindings,
      items: [...originalItems, "__synthetic_for_user__"],
    };
    const after = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT })
      .filter((d) => d.code === "missing-expression-ref" && d.message.includes("__synthetic_for_user__"));
    assert(after.length === 0, `post-add: expected wx:for-item suppression, got ${JSON.stringify(after)}`);
  } finally {
    homeFile.expressionRefs = originalRefs;
    if (homeFile.wxForBindings) {
      homeFile.wxForBindings = { ...homeFile.wxForBindings, items: originalItems };
    }
  }
}

function assertLocationTarget(location, targetPath, label) {
  assert(location, `${label}: expected definition location`);
  assert(location.uri === pathToFileURL(targetPath).href, `${label}: unexpected URI ${JSON.stringify(location)}`);
  assertDeepEqual(
    location.range,
    { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    `${label} range`,
  );
}

function assertLocation(location, targetPath, expectedRange, label) {
  assert(location, `${label}: expected definition location`);
  assert(location.uri === pathToFileURL(targetPath).href, `${label}: unexpected URI ${JSON.stringify(location)}`);
  assertDeepEqual(location.range, expectedRange, `${label} range`);
}

function assertNullLocation(location, label) {
  assert(location === null, `${label}: expected null, got ${JSON.stringify(location)}`);
}

function assertDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 7, character: 3 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, USER_CARD_TARGET, "user-card definition");
}

function assertEventHandlerDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 11, character: 20 },
    extensionRoot: ROOT,
  });
  assert(location, "event handler definition: expected Location, got null");
  assert(
    location.uri.endsWith("/fixtures/miniprogram/pages/home/home.js"),
    `event handler definition: expected uri to end with home.js, got ${location.uri}`,
  );
  assert(
    typeof location.range.start.line === "number" && typeof location.range.start.character === "number",
    `event handler definition: bad range shape: ${JSON.stringify(location.range)}`,
  );
  assert(
    location.range.start.line >= 0 && location.range.start.line < 20,
    `event handler definition: start line out of range (${location.range.start.line})`,
  );
  assert(
    location.range.end.character > location.range.start.character || location.range.end.line > location.range.start.line,
    `event handler definition: empty range ${JSON.stringify(location.range)}`,
  );
}

function assertEventHandlerDefinitionMissingMethod(graph) {
  // Exercise the null path when a handler name in eventHandlers[] has no
  // matching method in script.methods[]. Achieve by temporarily stripping
  // handleSelect from home's script.methods and restoring after the call.
  const homeConfig = graph.configs.find((c) => c.owner === "fixtures/miniprogram/pages/home/home.wxml");
  assert(homeConfig && homeConfig.script, "test setup: home config must have script field");
  const original = homeConfig.script.methods;
  homeConfig.script.methods = original.filter((m) => m.name !== "handleSelect");
  try {
    const result = getDefinition({
      graph,
      documentPath: HOME_WXML,
      position: { line: 11, character: 20 },
      extensionRoot: ROOT,
    });
    assert(result === null, `expected null when method missing, got ${JSON.stringify(result)}`);
  } finally {
    homeConfig.script.methods = original;
  }
}

// Phase 2 Stage B — Event handler value completion ----------------------

function assertEventHandlerCompletion(graph) {
  // home.wxml line 12: `    bind:select="handleSelect"`. Cursor at col 21
  // (after `hand`); typed = "hand"; replacement range covers `hand`.
  const sourceText = fs.readFileSync(HOME_WXML, "utf8");
  const position = { line: 11, character: 21 };

  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText,
    extensionRoot: ROOT,
  });

  assert(Array.isArray(items), `event handler completion: expected array, got ${typeof items}`);
  const labels = items.map((item) => item.label);
  assert(
    labels.includes("handleSelect"),
    `event handler completion: missing handleSelect; got ${JSON.stringify(labels)}`,
  );

  const handleSelectItem = items.find((item) => item.label === "handleSelect");
  assert(handleSelectItem.textEdit, "event handler completion: missing textEdit");
  assert(
    handleSelectItem.textEdit.range.start.line === 11 &&
    handleSelectItem.textEdit.range.start.character === 17 &&
    handleSelectItem.textEdit.range.end.line === 11 &&
    handleSelectItem.textEdit.range.end.character === 21,
    `event handler completion: bad range ${JSON.stringify(handleSelectItem.textEdit.range)}`,
  );
  assert(
    handleSelectItem.textEdit.newText === "handleSelect",
    `event handler completion: bad newText ${handleSelectItem.textEdit.newText}`,
  );
}

function assertEventHandlerCompletionEmptyTyped(graph) {
  // Cursor at col 17 — immediately after the opening quote, typed = "".
  const sourceText = fs.readFileSync(HOME_WXML, "utf8");
  const position = { line: 11, character: 17 };

  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText,
    extensionRoot: ROOT,
  });

  const labels = items.map((item) => item.label);
  assert(
    labels.includes("handleSelect"),
    `event handler completion (empty typed): missing handleSelect; got ${JSON.stringify(labels)}`,
  );

  const handleSelectItem = items.find((item) => item.label === "handleSelect");
  assert(
    handleSelectItem.textEdit.range.start.character === 17 &&
    handleSelectItem.textEdit.range.end.character === 17,
    `event handler completion (empty typed): expected empty range at col 17, got ${JSON.stringify(handleSelectItem.textEdit.range)}`,
  );
}

// Table-driven cases for the synthetic-source completion paths. Each entry
// tests one regression class. `expect` is "include" (handleSelect appears),
// "exclude" (handleSelect must not appear), or "empty" (no items at all).
const SYNTHETIC_HANDLER_COMPLETION_CASES = [
  {
    label: "bindtap short form",
    marked: '<view bindtap="hand|"></view>\n',
    expect: "include",
    // suffix `tap` is in BUILTIN_EVENT_NAMES — strict trigger accepts.
  },
  {
    label: "class attr",
    marked: '<view class="my-cl|">\n',
    expect: "exclude",
  },
  {
    label: "binding attr",
    marked: '<view binding="hand|"></view>\n',
    expect: "exclude",
    // suffix "ing" not in whitelist — strict trigger rejects.
  },
  {
    label: "dynamic {{...}}",
    marked: '<view bindtap="{{ha|n}}"></view>\n',
    expect: "exclude",
    // Pre-Stage-B (Phase 3) this returned [] because {{...}} was universally
    // excluded. Stage B legitimately fires data-ref completion inside the
    // interpolation; the test's actual intent — "don't suggest method names
    // (handleSelect) when the user is computing a dynamic handler from data"
    // — is satisfied by `exclude`, which asserts handleSelect isn't in the
    // returned labels regardless of what data refs DO appear.
  },
  {
    label: "stray <",
    marked: 'text < bindtap="hand|"\n',
    expect: "exclude",
    // tag-name guard rejects: `< b` is not a valid tag opening.
  },
  {
    label: "empty event-name colon form",
    marked: '<view bind:="hand|"></view>\n',
    expect: "exclude",
    // colon form requires `.+$` after the colon.
  },
];

function assertSyntheticHandlerCompletionCases(graph) {
  for (const { label, marked, expect } of SYNTHETIC_HANDLER_COMPLETION_CASES) {
    const { source, position } = sourceWithCursor(marked);
    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });
    if (expect === "empty") {
      assert(
        Array.isArray(items) && items.length === 0,
        `event handler completion (${label}): expected []; got ${JSON.stringify(items)}`,
      );
      continue;
    }
    const labels = items.map((item) => item.label);
    const has = labels.includes("handleSelect");
    if (expect === "include") {
      assert(has, `event handler completion (${label}): missing handleSelect; got ${JSON.stringify(labels)}`);
    } else {
      assert(!has, `event handler completion (${label}): leaked handleSelect; got ${JSON.stringify(labels)}`);
    }
  }
}

function assertEventHandlerCompletionNoSiblingScript(graph) {
  const ownerConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH && c.script);
  assert(ownerConfig, "test setup: expected home owner config with script");
  const savedScript = ownerConfig.script;
  delete ownerConfig.script;
  try {
    const sourceText = fs.readFileSync(HOME_WXML, "utf8");
    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position: { line: 11, character: 21 },
      sourceText,
      extensionRoot: ROOT,
    });
    assert(
      Array.isArray(items) && items.length === 0,
      `event handler completion (no script): expected [], got ${JSON.stringify(items)}`,
    );
  } finally {
    ownerConfig.script = savedScript;
  }
}

function assertEventHandlerCompletionSkipsComponentLifecycle(graph) {
  const ownerConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH && c.script);
  assert(ownerConfig, "test setup: expected home owner config with script");

  const synthetic = {
    name: "__synthetic_lifecycle__",
    kind: "component-lifecycle",
    range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
  };
  ownerConfig.script.methods.push(synthetic);
  try {
    const sourceText = fs.readFileSync(HOME_WXML, "utf8");
    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position: { line: 11, character: 21 },
      sourceText,
      extensionRoot: ROOT,
    });
    const labels = items.map((item) => item.label);
    assert(
      labels.includes("handleSelect"),
      `event handler completion (lifecycle filter): handleSelect missing — filter is over-eager; got ${JSON.stringify(labels)}`,
    );
    assert(
      !labels.includes("__synthetic_lifecycle__"),
      `event handler completion (lifecycle filter): leaked component-lifecycle method; got ${JSON.stringify(labels)}`,
    );
  } finally {
    const idx = ownerConfig.script.methods.indexOf(synthetic);
    if (idx >= 0) ownerConfig.script.methods.splice(idx, 1);
  }
}

function assertGlobalBadgeDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: SHOP_LIST_WXML,
    position: { line: 1, character: 3 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, GLOBAL_BADGE_WXML, "global-badge definition");
}

function assertLocalBadgeOverrideDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 15, character: 3 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, LOCAL_BADGE_WXML, "local global-badge override definition");
}

function assertImportDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 0, character: 2 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, COMMON_WXML, "import definition");
}

function assertIncludeDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 1, character: 2 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, SECONDARY_WXML, "include definition");
}

function assertExternalWxsDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 2, character: 2 },
    extensionRoot: ROOT,
  });
  assertLocationTarget(location, FORMAT_WXS, "external wxs definition");
}

function assertStaticTemplateDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 5, character: 4 },
    extensionRoot: ROOT,
  });
  assertLocation(
    location,
    COMMON_WXML,
    { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
    "static template definition",
  );
}

function assertDirectIncludeTemplateDefinition(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 21, character: 4 },
    extensionRoot: ROOT,
  });
  assertLocation(
    location,
    SECONDARY_WXML,
    { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
    "direct include template definition",
  );
}

function cloneGraph(graph) {
  return JSON.parse(JSON.stringify(graph));
}

function homeFileModel(graph) {
  return graph.wxml.find((entry) => entry.path === "fixtures/miniprogram/pages/home/home.wxml");
}

function dependencyRange(line) {
  return {
    start: { row: line, column: 0 },
    end: { row: line, column: 30 },
  };
}

function graphWithDependency(graph, dependency) {
  const nextGraph = cloneGraph(graph);
  homeFileModel(nextGraph).dependencies.push(dependency);
  return nextGraph;
}

function graphWithHomeDependency(graph, dependency) {
  const nextGraph = cloneGraph(graph);
  homeFileModel(nextGraph).dependencies.push(dependency);
  return nextGraph;
}

function graphWithTemplateReference(graph, reference) {
  const nextGraph = cloneGraph(graph);
  homeFileModel(nextGraph).references.push(reference);
  return nextGraph;
}

function graphWithTemplateSymbol(graph, filePath, symbol) {
  const nextGraph = cloneGraph(graph);
  const fileModel = nextGraph.wxml.find((entry) => entry.path === filePath);
  assert(fileModel, `Missing WXML file model for ${filePath}`);
  fileModel.symbols.push(symbol);
  return nextGraph;
}

function templateReferenceRange(line) {
  return {
    start: { row: line, column: 0 },
    end: { row: line, column: 40 },
  };
}

function templateSymbolRange(startLine, endLine) {
  return {
    start: { row: startLine, column: 2 },
    end: { row: endLine, column: 13 },
  };
}

function assertTemplateDefinitionUsesSymbolRange(graph) {
  const testGraphWithReference = graphWithTemplateReference(graph, {
    kind: "template",
    dynamic: false,
    raw: "offsetTemplate",
    name: "offsetTemplate",
    range: templateReferenceRange(60),
  });
  const testGraph = graphWithTemplateSymbol(
    testGraphWithReference,
    "fixtures/miniprogram/templates/common.wxml",
    {
      kind: "template",
      name: "offsetTemplate",
      range: templateSymbolRange(9, 12),
    },
  );
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 60, character: 2 },
    extensionRoot: ROOT,
  });
  assertLocation(
    location,
    COMMON_WXML,
    { start: { line: 9, character: 2 }, end: { line: 12, character: 13 } },
    "non-zero template definition range",
  );
}

function assertLocalTemplateDefinitionShadowsDependency(graph) {
  const testGraphWithReference = graphWithTemplateReference(graph, {
    kind: "template",
    dynamic: false,
    raw: "localShadow",
    name: "localShadow",
    range: templateReferenceRange(64),
  });
  const withDependencyDefinition = graphWithTemplateSymbol(
    testGraphWithReference,
    "fixtures/miniprogram/templates/common.wxml",
    {
      kind: "template",
      name: "localShadow",
      range: templateSymbolRange(13, 14),
    },
  );
  const testGraph = graphWithTemplateSymbol(
    withDependencyDefinition,
    "fixtures/miniprogram/pages/home/home.wxml",
    {
      kind: "template",
      name: "localShadow",
      range: templateSymbolRange(21, 24),
    },
  );
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 64, character: 2 },
    extensionRoot: ROOT,
  });
  assertLocation(
    location,
    HOME_WXML,
    { start: { line: 21, character: 2 }, end: { line: 24, character: 13 } },
    "local template definition shadows dependency",
  );
}

function assertDynamicTemplateDefinitionReturnsNull(graph) {
  const testGraph = graphWithTemplateReference(graph, {
    kind: "template",
    dynamic: true,
    raw: "{{currentTemplate}}",
    range: templateReferenceRange(61),
  });
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 61, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "dynamic template definition");
}

function assertMissingTemplateDefinitionReturnsNull(graph) {
  const testGraph = graphWithTemplateReference(graph, {
    kind: "template",
    dynamic: false,
    raw: "missingTemplate",
    name: "missingTemplate",
    range: templateReferenceRange(62),
  });
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 62, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "missing template definition");
}

function assertDuplicateLocalTemplateDefinitionsReturnNull(graph) {
  const testGraphWithReference = graphWithTemplateReference(graph, {
    kind: "template",
    dynamic: false,
    raw: "duplicateLocal",
    name: "duplicateLocal",
    range: templateReferenceRange(63),
  });
  const withFirstDefinition = graphWithTemplateSymbol(
    testGraphWithReference,
    "fixtures/miniprogram/pages/home/home.wxml",
    {
      kind: "template",
      name: "duplicateLocal",
      range: templateSymbolRange(21, 24),
    },
  );
  const testGraph = graphWithTemplateSymbol(
    withFirstDefinition,
    "fixtures/miniprogram/pages/home/home.wxml",
    {
      kind: "template",
      name: "duplicateLocal",
      range: templateSymbolRange(25, 28),
    },
  );
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 63, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "duplicate local template definitions");
}

function assertDuplicateDirectDependencyTemplateDefinitionsReturnNull(graph) {
  const testGraphWithReference = graphWithTemplateReference(graph, {
    kind: "template",
    dynamic: false,
    raw: "duplicateDependency",
    name: "duplicateDependency",
    range: templateReferenceRange(65),
  });
  const withCommonDefinition = graphWithTemplateSymbol(
    testGraphWithReference,
    "fixtures/miniprogram/templates/common.wxml",
    {
      kind: "template",
      name: "duplicateDependency",
      range: templateSymbolRange(13, 14),
    },
  );
  const testGraph = graphWithTemplateSymbol(
    withCommonDefinition,
    "fixtures/miniprogram/templates/secondary.wxml",
    {
      kind: "template",
      name: "duplicateDependency",
      range: templateSymbolRange(0, 4),
    },
  );
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 65, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "duplicate direct dependency template definitions");
}

function assertTemplateOutsideDirectDependenciesReturnsNull(graph) {
  const testGraphWithReference = graphWithTemplateReference(graph, {
    kind: "template",
    dynamic: false,
    raw: "detailOnlyTemplate",
    name: "detailOnlyTemplate",
    range: templateReferenceRange(66),
  });
  const testGraph = graphWithTemplateSymbol(
    testGraphWithReference,
    "fixtures/miniprogram/pages/detail/detail.wxml",
    {
      kind: "template",
      name: "detailOnlyTemplate",
      range: templateSymbolRange(5, 8),
    },
  );
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 66, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "template outside direct dependencies");
}

function assertDuplicateDependencyEntriesDoNotDuplicateTemplateDefinitions(graph) {
  const testGraphWithReference = graphWithTemplateReference(graph, {
    kind: "template",
    dynamic: false,
    raw: "singleViaDuplicateDependency",
    name: "singleViaDuplicateDependency",
    range: templateReferenceRange(67),
  });
  const withDefinition = graphWithTemplateSymbol(
    testGraphWithReference,
    "fixtures/miniprogram/templates/common.wxml",
    {
      kind: "template",
      name: "singleViaDuplicateDependency",
      range: templateSymbolRange(13, 14),
    },
  );
  const testGraph = graphWithHomeDependency(withDefinition, {
    kind: "include",
    value: "../../templates/common.wxml",
    normalized: "fixtures/miniprogram/templates/common.wxml",
    range: dependencyRange(68),
  });
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 67, character: 2 },
    extensionRoot: ROOT,
  });
  assertLocation(
    location,
    COMMON_WXML,
    { start: { line: 13, character: 2 }, end: { line: 14, character: 13 } },
    "duplicate dependency entries should count one template definition",
  );
}

function assertNonTemplateDefinitionReturnsNull(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 3, character: 0 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "non-template definition");
}

function assertMissingWxmlDependencyReturnsNull(graph) {
  const testGraph = graphWithDependency(graph, {
    kind: "import",
    value: "../../templates/missing.wxml",
    normalized: "fixtures/miniprogram/templates/missing.wxml",
    range: dependencyRange(50),
  });
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 50, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "missing wxml dependency definition");
}

function assertMissingWxsDependencyReturnsNull(graph) {
  const testGraph = graphWithDependency(graph, {
    kind: "wxs",
    value: "../../utils/missing.wxs",
    normalized: "fixtures/miniprogram/utils/missing.wxs",
    module: "missing",
    range: dependencyRange(51),
  });
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 51, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "missing wxs dependency definition");
}

function assertOutsideRootWxsDependencyReturnsNull(graph) {
  const testGraph = graphWithDependency(graph, {
    kind: "wxs",
    value: "../../../outside.wxs",
    normalized: "fixtures/outside.wxs",
    module: "outside",
    range: dependencyRange(52),
  });
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 52, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "outside-root wxs dependency definition");
}

function assertHomeDocumentSymbols(graph) {
  const symbols = getDocumentSymbols({ graph, documentPath: HOME_WXML, extensionRoot: ROOT });
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

function assertTemplateDocumentSymbols(graph) {
  const symbols = getDocumentSymbols({ graph, documentPath: COMMON_WXML, extensionRoot: ROOT });
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

function assertDuplicateTemplateDocumentSymbols(graph) {
  const withFirstDefinition = graphWithTemplateSymbol(
    graph,
    "fixtures/miniprogram/pages/home/home.wxml",
    {
      kind: "template",
      name: "duplicateLocalSymbol",
      range: templateSymbolRange(21, 24),
    },
  );
  const testGraph = graphWithTemplateSymbol(
    withFirstDefinition,
    "fixtures/miniprogram/pages/home/home.wxml",
    {
      kind: "template",
      name: "duplicateLocalSymbol",
      range: templateSymbolRange(25, 28),
    },
  );
  const symbols = getDocumentSymbols({ graph: testGraph, documentPath: HOME_WXML, extensionRoot: ROOT });
  const duplicateSymbols = symbols.filter((symbol) => symbol.name === "duplicateLocalSymbol");
  assertDeepEqual(
    duplicateSymbols,
    [
      {
        name: "duplicateLocalSymbol",
        kind: 12,
        detail: "template",
        range: { start: { line: 21, character: 2 }, end: { line: 24, character: 13 } },
        selectionRange: { start: { line: 21, character: 2 }, end: { line: 24, character: 13 } },
      },
      {
        name: "duplicateLocalSymbol",
        kind: 12,
        detail: "template",
        range: { start: { line: 25, character: 2 }, end: { line: 28, character: 13 } },
        selectionRange: { start: { line: 25, character: 2 }, end: { line: 28, character: 13 } },
      },
    ],
    "duplicate template document symbols",
  );
}

function assertComponentUsageExcluded(graph) {
  const symbols = getDocumentSymbols({ graph, documentPath: USER_CARD_WXML, extensionRoot: ROOT });
  assertDeepEqual(symbols, [], "component usage symbols should be excluded");
}

function assertTagCompletion(graph) {
  const { source, position } = sourceWithCursor("<user-|");
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertCompletionLabelsInclude(items, ["global-badge", "user-card", "view"], "tag completion");
  assertNoCompletionLabel(items, "missing-card", "tag completion");
  assertCompletionTextEdit(
    completionByLabel(items, "user-card"),
    { start: { line: 0, character: 1 }, end: { line: 0, character: 6 } },
    "user-card",
    "tag completion user-card",
  );
}

function assertClosingTagCompletionReturnsEmpty(graph) {
  const { source, position } = sourceWithCursor("</|");
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertDeepEqual(items, [], "closing tag completion");
}

function assertOutsideTagCompletionReturnsEmpty(graph) {
  // Cursor in plain text content — not inside any tag, attribute, template
  // usage, or `{{...}}` interpolation. None of the completion branches
  // should fire. (Pre-Stage-B this used `{{ | }}` because interpolations
  // were universally excluded; Stage B's data-ref completion now legitimately
  // fires there, so the test moved to a true outside-everything position.)
  const { source, position } = sourceWithCursor("<view>plain text|</view>");
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertDeepEqual(items, [], "outside tag completion");
}

function assertTemplateCompletion(graph) {
  const { source, position } = homeSourceWithCursor('<template is="load|" />');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertCompletionLabelsInclude(items, ["loadingRow", "secondaryRow"], "template completion");
  assertCompletionTextEdit(
    completionByLabel(items, "loadingRow"),
    { start: { line: 23, character: 14 }, end: { line: 23, character: 18 } },
    "loadingRow",
    "template completion loadingRow",
  );
}

function assertDynamicTemplateCompletionReturnsEmpty(graph) {
  // Cursor inside the `{{...}}` of `<template is="{{current|}}"/>`. Stage B
  // legitimately suggests data refs here (the interpolation IS a real
  // expression context — the user is computing the template name). What the
  // test's original intent guarded was: don't surface template NAMES at this
  // position. Verify that specifically, not that the whole result is empty.
  const { source, position } = homeSourceWithCursor('<template is="{{current|}}" />');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  const labels = items.map((item) => item.label);
  assert(
    !labels.includes("loadingRow") && !labels.includes("secondaryRow"),
    `dynamic template completion: template names leaked into interpolation context; got ${JSON.stringify(labels)}`,
  );
}

function assertAttributeCompletion(graph) {
  const { source, position } = sourceWithCursor("<user-card wx:| />");
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertCompletionLabelsInclude(items, ["wx:if", "bindtap", "capture-bind:tap"], "attribute completion");
  assertCompletionTextEdit(
    completionByLabel(items, "wx:if"),
    { start: { line: 0, character: 11 }, end: { line: 0, character: 14 } },
    "wx:if",
    "attribute completion wx:if",
  );
}

function assertAttributeValueCompletionReturnsEmpty(graph) {
  const { source, position } = sourceWithCursor('<view class="|" />');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertDeepEqual(items, [], "attribute value completion");
}

function assertExcludedContextsReturnEmpty(graph) {
  for (const [label, markedSource] of [
    ["comment tag", "<!-- <view | -->"],
    ["interpolation tag", "{{ '<view |' }}"],
    ["inline wxs tag", '<wxs module="tools">var tag = "<view |"</wxs>'],
  ]) {
    const { source, position } = sourceWithCursor(markedSource);
    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });
    assertDeepEqual(items, [], label);
  }
}

function assertCompletionAfterExternalWxs(graph) {
  const { source, position } = sourceWithCursor('<wxs module="format" src="../../utils/format.wxs" />\n<user-|');
  const items = getCompletions({
    graph,
    documentPath: HOME_WXML,
    position,
    sourceText: source,
    extensionRoot: ROOT,
  });
  assertCompletionLabelsInclude(items, ["user-card", "view"], "completion after external wxs");
}

function assertInvalidCompletionInputsReturnEmpty(graph) {
  const { source, position } = sourceWithCursor("<vi|");
  assertDeepEqual(
    getCompletions({
      graph,
      documentPath: path.join(MINIPROGRAM_ROOT, "missing.wxml"),
      position,
      sourceText: source,
      extensionRoot: ROOT,
    }),
    [],
    "missing file model completion",
  );
  assertDeepEqual(
    getCompletions({
      graph,
      documentPath: HOME_WXML,
      position: { line: 99, character: 0 },
      sourceText: source,
      extensionRoot: ROOT,
    }),
    [],
    "invalid position completion",
  );
  assertDeepEqual(
    getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: undefined,
      extensionRoot: ROOT,
    }),
    [],
    "missing sourceText completion",
  );
}

function assertHomeConfigScript(graph) {
  const homeConfig = graph.configs.find(
    (c) => c.owner === "fixtures/miniprogram/pages/home/home.wxml",
  );
  assert(homeConfig, "graph.configs missing home page config");
  assert(homeConfig.script, "home page config missing script field");
  assert(
    homeConfig.script.path === "fixtures/miniprogram/pages/home/home.js",
    `home script path: expected home.js, got ${homeConfig.script.path}`,
  );
  const methodNames = homeConfig.script.methods.map((m) => m.name);
  assert(
    methodNames.includes("handleSelect"),
    `home script methods missing handleSelect (target of bind:select in home.wxml); got [${methodNames.join(", ")}]`,
  );
  for (const m of homeConfig.script.methods) {
    assert(
      m.nameRange && typeof m.nameRange.start.row === "number",
      `home script method ${m.name} missing nameRange`,
    );
  }
}

const graph = loadGraph();
assertHomeConfigScript(graph);
assertEventHandlerDefinition(graph);
assertEventHandlerDefinitionMissingMethod(graph);
assertMissingCardDiagnostic(graph);
assertShopListDiagnosticsClean(graph);
// Phase 2 Stage C — Event handler diagnostic
assertEventHandlerDiagnosticCleanWhenHandlerExists(graph);
assertEventHandlerDiagnosticMissingHandler(graph);
assertEventHandlerDiagnosticMissingHandlerNoColon(graph);
assertEventHandlerDiagnosticSuppressedByDynamic(graph);
assertEventHandlerDiagnosticSuppressedByDynamicMethods(graph);
assertEventHandlerDiagnosticSuppressedByLooseBinding(graph);
assertEventHandlerDiagnosticSuppressedByBooleanIdiom(graph);
assertEventHandlerDiagnosticNoScriptSkips(graph);
// Phase 3 Stage A — Expression reference diagnostic
// Phase 3 Stage B — Data ref definition
assertDataRefDefinitionToData(graph);
assertDataRefDefinitionToProperty(graph);
assertDataRefDefinitionInTemplateReturnsNull(graph);
assertDataRefDefinitionMissingKeyReturnsNull(graph);
// Phase 3 Stage B — Data ref completion
assertDataRefCompletionMatchesData(graph);
assertDataRefCompletionMatchesProperty(graph);
assertDataRefCompletionSuppressedAtMemberAccess(graph);
assertDataRefCompletionSuppressedInObjectLiteral(graph);
assertDataRefCompletionIncludesWxsModule(graph);
assertDataRefCompletionSuppressedInTemplateDefinition(graph);
assertExpressionRefDiagnosticClean(graph);
assertExpressionRefDiagnosticMissingInterpolation(graph);
assertExpressionRefDiagnosticMissingDirective(graph);
assertExpressionRefDiagnosticSuppressedByWxsModule(graph);
assertExpressionRefDiagnosticSuppressedByWxForItem(graph);
assertExpressionRefDiagnosticSuppressedByDynamicData(graph);
assertExpressionRefDiagnosticNoScriptSkips(graph);
assertExpressionRefDiagnosticUserCardClean(graph);
assertExpressionRefDiagnosticSuppressedInTemplateDefinition(graph);
assertExpressionRefDiagnosticSyntheticForItemSuppresses(graph);
assertFolderComponentResolvesViaIndex(graph);
assertDefinition(graph);
assertGlobalBadgeDefinition(graph);
assertLocalBadgeOverrideDefinition(graph);
assertImportDefinition(graph);
assertIncludeDefinition(graph);
assertExternalWxsDefinition(graph);
assertStaticTemplateDefinition(graph);
assertDirectIncludeTemplateDefinition(graph);
assertTemplateDefinitionUsesSymbolRange(graph);
assertLocalTemplateDefinitionShadowsDependency(graph);
assertDynamicTemplateDefinitionReturnsNull(graph);
assertMissingTemplateDefinitionReturnsNull(graph);
assertDuplicateLocalTemplateDefinitionsReturnNull(graph);
assertDuplicateDirectDependencyTemplateDefinitionsReturnNull(graph);
assertTemplateOutsideDirectDependenciesReturnsNull(graph);
assertDuplicateDependencyEntriesDoNotDuplicateTemplateDefinitions(graph);
assertNonTemplateDefinitionReturnsNull(graph);
assertMissingWxmlDependencyReturnsNull(graph);
assertMissingWxsDependencyReturnsNull(graph);
assertOutsideRootWxsDependencyReturnsNull(graph);
assertHomeDocumentSymbols(graph);
assertTemplateDocumentSymbols(graph);
assertDuplicateTemplateDocumentSymbols(graph);
assertComponentUsageExcluded(graph);
assertTagCompletion(graph);
assertClosingTagCompletionReturnsEmpty(graph);
assertOutsideTagCompletionReturnsEmpty(graph);
assertTemplateCompletion(graph);
assertDynamicTemplateCompletionReturnsEmpty(graph);
assertAttributeCompletion(graph);
assertAttributeValueCompletionReturnsEmpty(graph);
assertExcludedContextsReturnEmpty(graph);
assertCompletionAfterExternalWxs(graph);
assertInvalidCompletionInputsReturnEmpty(graph);

// Phase 2 Stage B — Event handler value completion
assertEventHandlerCompletion(graph);
assertEventHandlerCompletionEmptyTyped(graph);
assertSyntheticHandlerCompletionCases(graph);
assertEventHandlerCompletionNoSiblingScript(graph);
assertEventHandlerCompletionSkipsComponentLifecycle(graph);
