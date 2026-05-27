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
  getHover,
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
const CROSS_BINDING_WXML = path.join(MINIPROGRAM_ROOT, "pages/cross-binding/cross-binding.wxml");
const CROSS_BINDING_WXML_GRAPH_PATH = "fixtures/miniprogram/pages/cross-binding/cross-binding.wxml";
const DYN_PAGE_WXML = path.join(MINIPROGRAM_ROOT, "pages/dyn-page/dyn-page.wxml");
const DYN_PAGE_WXML_GRAPH_PATH = "fixtures/miniprogram/pages/dyn-page/dyn-page.wxml";
const LOOPS_WXML = path.join(MINIPROGRAM_ROOT, "pages/loops/loops.wxml");
const LOOPS_WXML_GRAPH_PATH = "fixtures/miniprogram/pages/loops/loops.wxml";
const TPL_LOOPS_WXML = path.join(MINIPROGRAM_ROOT, "pages/tpl-loops/tpl-loops.wxml");
const SCOPE_LEAK_WXML = path.join(MINIPROGRAM_ROOT, "pages/scope-leak/scope-leak.wxml");
const LOCAL_BAR_CONFIG_PATH = "fixtures/miniprogram/components/local-bar/local-bar.json";
const DYN_CARD_CONFIG_PATH = "fixtures/miniprogram/components/dyn-card/dyn-card.json";

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

function assertGetDiagnosticsUsesFileModelOverride(graph) {
  // Construct an override fileModel that's the same as home's BUT with
  // one extra eventHandlers entry pointing at a method that doesn't exist
  // in home.js. The diagnostic should fire using the override, not the
  // saved-graph fileModel which doesn't have that handler.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  assert(homeFile, "test setup: home file in graph");

  const synthetic = {
    event: "tap",
    handler: "__overlay_only_missing__",
    binding: "bind:",
    dynamic: false,
    range: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
    nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 0 } },
  };
  const fileModelOverride = {
    ...homeFile,
    eventHandlers: [...homeFile.eventHandlers, synthetic],
  };

  const diagnostics = getDiagnostics({
    graph,
    documentPath: HOME_WXML,
    extensionRoot: ROOT,
    fileModelOverride,
  });
  const handlerDiags = diagnostics.filter((d) => d.code === "missing-event-handler");
  const ours = handlerDiags.find((d) => d.message.includes("__overlay_only_missing__"));
  assert(
    ours,
    `getDiagnostics override: expected diagnostic for the override's synthetic handler; got ${JSON.stringify(handlerDiags)}`,
  );

  // Sanity: without the override, the synthetic handler doesn't exist in graph.wxml.
  const baselineDiagnostics = getDiagnostics({
    graph,
    documentPath: HOME_WXML,
    extensionRoot: ROOT,
  });
  const baselineHandlerDiags = baselineDiagnostics
    .filter((d) => d.code === "missing-event-handler")
    .filter((d) => d.message.includes("__overlay_only_missing__"));
  assert(
    baselineHandlerDiags.length === 0,
    `getDiagnostics baseline: synthetic handler shouldn't appear without override; got ${JSON.stringify(baselineHandlerDiags)}`,
  );
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
  // Real-world unsaved-buffer scenario: user types a new template_definition
  // that the graph doesn't know about yet, but completion must still suppress
  // owner data. The source-text walk in interpolationCompletionContext handles
  // this independently of graph state.
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

function assertDataRefCompletionTemplateScannerHardenedCases(graph) {
  // Table-driven cases that exercise the state-machine scanner specifically.
  // Each line tests a scenario where naive regex counting would mis-judge:
  // comments, attribute-value quotes, self-closing template definitions.
  const cases = [
    {
      label: "comment with fake open",
      marked: '<!-- <template name="X"> --><view>{{th|}}</view>\n',
      expectIncludesTheme: true,  // outside any real template def — completion fires
    },
    {
      label: "real template, fake close in comment",
      marked: '<template name="X"><!-- </template> -->{{th|}}</template>\n',
      expectIncludesTheme: false,  // inside template body — suppress
    },
    {
      label: "attr value with fake template tag",
      marked: '<view data="<template name=fake>">{{th|}}</view>\n',
      expectIncludesTheme: true,  // fake tag is inside attribute value — completion fires
    },
    {
      label: "self-closing template def then outside",
      marked: '<template name="X"/><view>{{th|}}</view>\n',
      expectIncludesTheme: true,  // self-closing introduces no body — completion fires
    },
    {
      label: "template is= usage (not definition)",
      marked: '<template is="X">{{th|}}</template>\n',
      expectIncludesTheme: true,  // usage doesn't introduce template-scope — completion fires
    },
    {
      label: "template with data-name= attribute (suffix not real name)",
      marked: '<template data-name="X">{{th|}}</template>\n',
      expectIncludesTheme: true,  // data-name is NOT the name attribute — no suppression
    },
    {
      label: "template is= usage with data-name= sibling attribute",
      marked: '<template is="X" data-name="foo" data="{{th|}}" />\n',
      // This is a template USAGE (is=) with a data-name attribute. Even
      // with two ways the scanner could be fooled (data-name suffix, and
      // the {{...}} sitting inside an attribute value), the strict
      // attribute-boundary check must keep depth=0 and completion firing.
      // BUT: the cursor is also inside `data="{{th}}"` — an inline object
      // literal-style template data — wait, `data="{{th}}"` is a single
      // interpolation, not an object literal. interpolationCompletionContext
      // will fire normally, and dataRefCompletion should include theme.
      expectIncludesTheme: true,
    },
  ];
  for (const { label, marked, expectIncludesTheme } of cases) {
    const { source, position } = sourceWithCursor(marked);
    const items = getCompletions({
      graph,
      documentPath: HOME_WXML,
      position,
      sourceText: source,
      extensionRoot: ROOT,
    });
    const labels = items.map((item) => item.label);
    const has = labels.includes("theme");
    assert(
      has === expectIncludesTheme,
      `data-ref completion scanner (${label}): expected includes-theme=${expectIncludesTheme}, got ${has}; labels=${JSON.stringify(labels)}`,
    );
  }
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

function assertDefinitionOnWxsExpressionRefExternal(graph) {
  // home.wxml line 19 (row 18): `    {{format.price(total)}}` — `format`
  // is a wxs module. Cursor mid-name at col 8 should jump to the .wxs file.
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 18, character: 8 },
    extensionRoot: ROOT,
  });
  assert(location, "definition wxs xref external: expected Location, got null");
  assert(location.uri.endsWith("/fixtures/miniprogram/utils/format.wxs"),
    `definition wxs xref external: uri ${location.uri}`);
}

function assertDefinitionOnWxsExpressionRefInline(graph) {
  // Synthesize an inline wxs symbol + matching expressionRef on home file.
  // Definition should jump to the synthetic wxs symbol's nameRange in the
  // SAME file (no dependency entry exists for it).
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const originalSymbols = homeFile.symbols;
  const originalRefs = homeFile.expressionRefs;
  const syntheticSymbol = {
    kind: "wxs",
    name: "__def_inline_fmt__",
    range: { start: { row: 500, column: 0 }, end: { row: 502, column: 6 } },
    nameRange: { start: { row: 500, column: 13 }, end: { row: 500, column: 31 } },
  };
  const syntheticRef = {
    name: "__def_inline_fmt__",
    source: "interpolation",
    inTemplateDefinition: false,
    range: { start: { row: 505, column: 0 }, end: { row: 505, column: 18 } },
    expressionRange: { start: { row: 505, column: 0 }, end: { row: 505, column: 18 } },
  };
  homeFile.symbols = [...originalSymbols, syntheticSymbol];
  homeFile.expressionRefs = [...originalRefs, syntheticRef];
  try {
    const location = getDefinition({
      graph,
      documentPath: HOME_WXML,
      position: { line: 505, character: 8 },
      extensionRoot: ROOT,
    });
    assert(location, "definition wxs xref inline: expected Location, got null");
    assert(location.uri.endsWith("/fixtures/miniprogram/pages/home/home.wxml"),
      `definition wxs xref inline: uri must be the same WXML file; got ${location.uri}`);
    assert(location.range.start.line === 500 && location.range.start.character === 13,
      `definition wxs xref inline: expected jump to synthetic nameRange (row 500, col 13); got ${JSON.stringify(location.range)}`);
  } finally {
    homeFile.symbols = originalSymbols;
    homeFile.expressionRefs = originalRefs;
  }
}

function assertDefinitionOnWxsExpressionRefInTemplateOnlyFile(graph) {
  // Bug #1 regression for getDefinition: templates/common.wxml has no JS
  // sibling so findOwnerConfigWithScript returns null. Pre-fix, the
  // expression-ref branch would early-return null even for a wxs xref.
  // Synthesize on common.wxml; assert definition jumps to the (inline)
  // synthetic wxs decl.
  const COMMON_GRAPH_PATH = "fixtures/miniprogram/templates/common.wxml";
  const commonFile = graph.wxml.find((f) => f.path === COMMON_GRAPH_PATH);
  assert(commonFile, "definition template-only-wxs setup: common.wxml file model");
  const ownerConfig = graph.configs.find((c) => c.owner === COMMON_GRAPH_PATH && c.script);
  assert(!ownerConfig, "definition template-only-wxs setup: common.wxml must have NO script-bearing owner config");

  const originalSymbols = commonFile.symbols;
  const originalRefs = commonFile.expressionRefs;
  const syntheticSymbol = {
    kind: "wxs",
    name: "__def_template_only_fmt__",
    range: { start: { row: 600, column: 0 }, end: { row: 602, column: 6 } },
    nameRange: { start: { row: 600, column: 13 }, end: { row: 600, column: 38 } },
  };
  const syntheticRef = {
    name: "__def_template_only_fmt__",
    source: "interpolation",
    inTemplateDefinition: false,
    range: { start: { row: 605, column: 0 }, end: { row: 605, column: 25 } },
    expressionRange: { start: { row: 605, column: 0 }, end: { row: 605, column: 25 } },
  };
  commonFile.symbols = [...originalSymbols, syntheticSymbol];
  commonFile.expressionRefs = [...originalRefs, syntheticRef];
  try {
    const location = getDefinition({
      graph,
      documentPath: COMMON_WXML,
      position: { line: 605, character: 10 },
      extensionRoot: ROOT,
    });
    assert(location, "definition template-only-wxs: expected Location, got null (Bug #1 mirror regression)");
    assert(location.uri.endsWith("/fixtures/miniprogram/templates/common.wxml"),
      `definition template-only-wxs: uri must stay in same file; got ${location.uri}`);
    assert(location.range.start.line === 600 && location.range.start.character === 13,
      `definition template-only-wxs: expected jump to synthetic nameRange; got ${JSON.stringify(location.range)}`);
  } finally {
    commonFile.symbols = originalSymbols;
    commonFile.expressionRefs = originalRefs;
  }
}

// Phase 3 Stage C — Hover v1 ------------------------------------------------

function hoverContents(hover) {
  if (!hover) return null;
  return hover.contents && hover.contents.value;
}

function assertHoverOnDataRef(graph) {
  // home.wxml line 5 (row 4): `<view class="home {{theme}}">`
  // 'theme' starts at col 20; cursor mid-name at col 22.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 4, character: 22 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-1: expected Hover, got null");
  const value = hoverContents(hover);
  assert(value.startsWith("**theme** — `data`"), `H-1: bad title: ${value}`);
  // Line number deliberately unpinned: a refactor of home.js shouldn't force a hover test edit.
  assert(value.includes("Defined in `pages/home/home.js:"), `H-1: bad source line: ${value}`);
  assert(hover.contents.kind === "markdown", `H-1: kind ${hover.contents.kind}`);
  assert(hover.range, "H-1: expected range");
}

function assertHoverOnPropertyRef(graph) {
  // user-card.wxml line 2 (row 1): expressionRef `user` → property
  const hover = getHover({
    graph,
    documentPath: USER_CARD_WXML,
    position: { line: 1, character: 25 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-2: expected Hover, got null");
  const value = hoverContents(hover);
  assert(value.startsWith("**user** — `property`"), `H-2: bad title: ${value}`);
  assert(value.includes("Defined in `components/user-card/user-card.js:"), `H-2: bad source line: ${value}`);
}

function assertHoverInTemplateDefinitionReturnsNull(graph) {
  // H-12: synthesize an expressionRef inside template_definition. Hover must
  // short-circuit and return null even though "theme" is a real data key.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.expressionRefs;
  const synthetic = {
    name: "theme",
    source: "interpolation",
    inTemplateDefinition: true,
    range: { start: { row: 100, column: 0 }, end: { row: 100, column: 5 } },
    expressionRange: { start: { row: 100, column: 0 }, end: { row: 100, column: 5 } },
  };
  homeFile.expressionRefs = [...original, synthetic];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 100, character: 2 },
      extensionRoot: ROOT,
    });
    assert(hover === null, `H-12: expected null in template_definition, got ${JSON.stringify(hover)}`);
  } finally {
    homeFile.expressionRefs = original;
  }
}

function assertHoverOnWxsExpressionRef(graph) {
  // H-10: home.wxml line 19 (row 18): `    {{format.price(total)}}`
  // 'format' starts at col 6; cursor mid-name at col 8.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 18, character: 8 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-10: expected Hover for {{format.x}}");
  const value = hoverContents(hover);
  assert(value.startsWith("**format** — `wxs module`"), `H-10: bad title: ${value}`);
  assert(value.includes("→ `utils/format.wxs`"), `H-10: bad source line: ${value}`);
}

function assertHoverOnInlineWxsExpressionRef(graph) {
  // H-10b: inline-wxs arm of step 2c. Synthesize an inline wxs symbol
  // (no matching dependency entry) plus an expressionRef pointing at it,
  // then assert hover returns the `inline wxs module in this file` form.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const originalSymbols = homeFile.symbols;
  const originalRefs = homeFile.expressionRefs;
  const syntheticSymbol = {
    kind: "wxs",
    name: "__hover_inline_format__",
    range: { start: { row: 300, column: 0 }, end: { row: 302, column: 6 } },
    nameRange: { start: { row: 300, column: 13 }, end: { row: 300, column: 36 } },
  };
  const syntheticRef = {
    name: "__hover_inline_format__",
    source: "interpolation",
    inTemplateDefinition: false,
    range: { start: { row: 305, column: 0 }, end: { row: 305, column: 23 } },
    expressionRange: { start: { row: 305, column: 0 }, end: { row: 305, column: 23 } },
  };
  homeFile.symbols = [...originalSymbols, syntheticSymbol];
  homeFile.expressionRefs = [...originalRefs, syntheticRef];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 305, character: 10 },
      extensionRoot: ROOT,
    });
    assert(hover, "H-10b: expected Hover for inline wxs expression ref");
    const value = hoverContents(hover);
    assert(value.startsWith("**__hover_inline_format__** — `wxs module`"),
      `H-10b: bad title: ${value}`);
    assert(value.includes("inline wxs module in this file"),
      `H-10b: expected inline-note body; got ${value}`);
    // Sanity: the external-arm marker must NOT appear.
    assert(!value.includes("→ `"),
      `H-10b: inline hover should not render arrow-form; got ${value}`);
  } finally {
    homeFile.symbols = originalSymbols;
    homeFile.expressionRefs = originalRefs;
  }
}

function assertHoverOnExternalWxsDeclaration(graph) {
  // H-8: home.wxml line 3 (row 2): `<wxs module="format" src="../../utils/format.wxs" />`
  // 'format' starts at col 13. Cursor mid-name at col 15.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 2, character: 15 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-8: expected Hover for external <wxs module=\"format\">");
  const value = hoverContents(hover);
  assert(value.startsWith("**format** — `wxs module`"), `H-8: bad title: ${value}`);
  assert(value.includes("→ `utils/format.wxs`"), `H-8: bad source: ${value}`);
}

function assertHoverOnInlineWxsDeclaration(graph) {
  // H-9: synthesize an inline wxs symbol (no matching dependency entry)
  // on the home file model and verify the inline-arm hover form.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.symbols;
  const syntheticSymbol = {
    kind: "wxs",
    name: "__hover_inline_wxs__",
    range: { start: { row: 300, column: 0 }, end: { row: 302, column: 6 } },
    nameRange: { start: { row: 300, column: 13 }, end: { row: 300, column: 32 } },
  };
  homeFile.symbols = [...original, syntheticSymbol];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 300, character: 20 },
      extensionRoot: ROOT,
    });
    assert(hover, "H-9: expected Hover for inline wxs");
    const value = hoverContents(hover);
    assert(value.startsWith("**__hover_inline_wxs__** — `wxs module`"), `H-9: bad title: ${value}`);
    assert(value.includes("inline wxs module in this file"), `H-9: bad source: ${value}`);
  } finally {
    homeFile.symbols = original;
  }
}

function assertHoverInsideWxsBodyReturnsNull(graph) {
  // H-16: cursor inside <wxs>...</wxs> body, NOT in module value range.
  // Synthesize a wide-range wxs symbol with narrow nameRange; cursor in the gap.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.symbols;
  const syntheticSymbol = {
    kind: "wxs",
    name: "__hover_body_wxs__",
    range: { start: { row: 310, column: 0 }, end: { row: 315, column: 6 } },
    nameRange: { start: { row: 310, column: 13 }, end: { row: 310, column: 30 } },
  };
  homeFile.symbols = [...original, syntheticSymbol];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 312, character: 4 },
      extensionRoot: ROOT,
    });
    assert(hover === null, `H-16: expected null inside wxs body, got ${JSON.stringify(hover)}`);
  } finally {
    homeFile.symbols = original;
  }
}

function assertHoverOnPageMethod(graph) {
  // home.wxml line 12 (row 11): `    bind:select="handleSelect"`
  // 'handleSelect' starts inside the quotes. Cursor mid-name at col 22.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 11, character: 22 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-5: expected Hover for page method handleSelect");
  const value = hoverContents(hover);
  assert(value.startsWith("**handleSelect** — `page method`"), `H-5: bad title: ${value}`);
  assert(value.includes("Defined in `pages/home/home.js:"), `H-5: bad source: ${value}`);
}

function assertHoverOnComponentMethod(graph) {
  // H-6: user-card.wxml has no bind*/catch* in the fixture, but user-card.js
  // declares method `onCardTap` and user-card.json sets `"component": true`.
  // Synthesize an eventHandler entry on the user-card file model whose handler
  // name matches the real method, then hover at the synthetic nameRange.
  const userCardGraphPath = path.posix.relative(ROOT, USER_CARD_WXML).split(path.sep).join("/");
  const userCardFile = graph.wxml.find((f) => f.path === userCardGraphPath);
  assert(userCardFile, "H-6 setup: user-card file model");
  const userCardConfig = graph.configs.find((c) => c.owner === userCardGraphPath);
  assert(userCardConfig && userCardConfig.kind === "component",
    `H-6 setup: user-card config must be kind=component; got ${JSON.stringify(userCardConfig?.kind)}`);
  assert(userCardConfig.script.methods.some((m) => m.name === "onCardTap"),
    `H-6 setup: user-card.js must declare onCardTap; got ${JSON.stringify(userCardConfig.script.methods.map((m) => m.name))}`);
  const original = userCardFile.eventHandlers;
  const synthetic = {
    event: "tap",
    handler: "onCardTap",
    binding: "bind:",
    dynamic: false,
    range: { start: { row: 120, column: 0 }, end: { row: 120, column: 25 } },
    nameRange: { start: { row: 120, column: 10 }, end: { row: 120, column: 19 } },
  };
  userCardFile.eventHandlers = [...original, synthetic];
  try {
    const hover = getHover({
      graph,
      documentPath: USER_CARD_WXML,
      position: { line: 120, character: 15 },
      extensionRoot: ROOT,
    });
    assert(hover, "H-6: expected Hover for component method");
    const value = hoverContents(hover);
    assert(value.startsWith("**onCardTap** — `component method`"),
      `H-6: bad title: ${value}`);
    assert(value.includes("Defined in `components/user-card/user-card.js:"),
      `H-6: bad source: ${value}`);
  } finally {
    userCardFile.eventHandlers = original;
  }
}

function assertHoverOnDynamicHandlerReturnsNull(graph) {
  // H-17: synthesize a dynamic event handler; hover must return null.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.eventHandlers;
  const synthetic = {
    event: "tap",
    handler: "{{maybeHandler}}",
    binding: "bind:",
    dynamic: true,
    range: { start: { row: 110, column: 0 }, end: { row: 110, column: 25 } },
    nameRange: { start: { row: 110, column: 5 }, end: { row: 110, column: 20 } },
  };
  homeFile.eventHandlers = [...original, synthetic];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 110, character: 10 },
      extensionRoot: ROOT,
    });
    assert(hover === null, `H-17: expected null on dynamic handler, got ${JSON.stringify(hover)}`);
  } finally {
    homeFile.eventHandlers = original;
  }
}

function assertHoverOnCustomComponent(graph) {
  // home.wxml line 8 (row 7): `  <user-card`
  // tag name starts at col 3; cursor mid-name at col 5.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 7, character: 5 },
    extensionRoot: ROOT,
  });
  assert(hover, "H-7: expected Hover for <user-card>");
  const value = hoverContents(hover);
  assert(value.startsWith("**user-card** — `custom component`"), `H-7: bad title: ${value}`);
  assert(value.includes("→ `components/user-card/user-card.wxml`"), `H-7: bad source: ${value}`);
}

function assertHoverInsideComponentChildrenReturnsNull(graph) {
  // H-18: cursor at col 4 of line 9 — inside <user-card>'s attribute area,
  // past tag_name. tagNameRange should NOT contain this position.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 8, character: 4 },
    extensionRoot: ROOT,
  });
  assert(hover === null, `H-18: expected null inside user-card start-tag attributes, got ${JSON.stringify(hover)}`);
}

function assertHoverPastTagNameRangeReturnsNull(graph) {
  // H-19: cursor on the start-tag row but past tagNameRange.end.
  // home.wxml's <user-card .../> is self-closing (no </user-card> exists),
  // so we use the start-tag row with a column known to be past
  // tagNameRange.end (col 12 in this fixture). Test fidelity: this verifies
  // tagNameRange properly excludes positions past its end-column, NOT closing
  // tag behavior.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 7, character: 20 },
    extensionRoot: ROOT,
  });
  assert(hover === null, `H-19: expected null past tagNameRange end, got ${JSON.stringify(hover)}`);
}

function assertHoverComponentLegacyGraphDegradesGracefully(graph) {
  // S-C3: legacy graph without tagNameRange — hover must return null instead
  // of falling back to the wide element range.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.components;
  homeFile.components = original.map((c) => {
    const { tagNameRange: _tnr, ...rest } = c;
    return rest;
  });
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 7, character: 5 },
      extensionRoot: ROOT,
    });
    assert(hover === null,
      `S-C3: legacy graph (no tagNameRange) must not trigger component hover; got ${JSON.stringify(hover)}`);
  } finally {
    homeFile.components = original;
  }
}

function assertHoverOnMemberChainReturnsNull(graph) {
  // H-11: cursor on `name` in `{{user.name}}`. topLevelIdentifiers skips
  // identifiers preceded by ".", so no expressionRef is produced for `name`.
  const hover = getHover({
    graph,
    documentPath: USER_CARD_WXML,
    position: { line: 1, character: 30 },
    extensionRoot: ROOT,
  });
  assert(hover === null, `H-11: expected null on member chain, got ${JSON.stringify(hover)}`);
}

function assertHoverOnMissingDataReturnsNull(graph) {
  // H-4 negative twin: temporarily remove `theme` from dataKeys, hover must return null.
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  const original = homeConfig.script.dataKeys;
  homeConfig.script.dataKeys = original.filter((k) => k.name !== "theme");
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 4, character: 22 },
      extensionRoot: ROOT,
    });
    assert(hover === null, `H-4 (missing key): expected null, got ${JSON.stringify(hover)}`);
  } finally {
    homeConfig.script.dataKeys = original;
  }
}

function assertHoverSourceLabelsDataKind(graph) {
  // H-3: a key whose source is "setData" gets `setData` kind, not `data`.
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  const originalKeys = homeConfig.script.dataKeys;
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const originalRefs = homeFile.expressionRefs;
  const syntheticKey = {
    name: "__hover_test_setData__",
    nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 5 } },
    source: "setData",
  };
  const syntheticRef = {
    name: "__hover_test_setData__",
    source: "interpolation",
    inTemplateDefinition: false,
    range: { start: { row: 200, column: 0 }, end: { row: 200, column: 5 } },
    expressionRange: { start: { row: 200, column: 0 }, end: { row: 200, column: 5 } },
  };
  homeConfig.script.dataKeys = [...originalKeys, syntheticKey];
  homeFile.expressionRefs = [...originalRefs, syntheticRef];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 200, character: 2 },
      extensionRoot: ROOT,
    });
    assert(hover, "H-3 (setData): expected Hover");
    const value = hoverContents(hover);
    assert(value.startsWith("**__hover_test_setData__** — `setData`"), `H-3: bad kind label: ${value}`);
  } finally {
    homeConfig.script.dataKeys = originalKeys;
    homeFile.expressionRefs = originalRefs;
  }
}

function assertHoverSourceLabelsInjectorKind(graph) {
  // H-4: a key whose source is "injector" gets `injector` kind.
  const homeConfig = graph.configs.find((c) => c.owner === HOME_WXML_GRAPH_PATH);
  const originalKeys = homeConfig.script.dataKeys;
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const originalRefs = homeFile.expressionRefs;
  const syntheticKey = {
    name: "__hover_test_injector__",
    nameRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 5 } },
    source: "injector",
  };
  const syntheticRef = {
    name: "__hover_test_injector__",
    source: "interpolation",
    inTemplateDefinition: false,
    range: { start: { row: 201, column: 0 }, end: { row: 201, column: 5 } },
    expressionRange: { start: { row: 201, column: 0 }, end: { row: 201, column: 5 } },
  };
  homeConfig.script.dataKeys = [...originalKeys, syntheticKey];
  homeFile.expressionRefs = [...originalRefs, syntheticRef];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 201, character: 2 },
      extensionRoot: ROOT,
    });
    assert(hover, "H-4 (injector): expected Hover");
    const value = hoverContents(hover);
    assert(value.startsWith("**__hover_test_injector__** — `injector`"), `H-4: bad kind label: ${value}`);
  } finally {
    homeConfig.script.dataKeys = originalKeys;
    homeFile.expressionRefs = originalRefs;
  }
}

// H-13 (object-literal interpolation returns null) is intentionally NOT
// asserted in this verifier. The mechanism is `topLevelIdentifiers()`
// short-circuiting via `looksLikeObjectLiteralExpression()`, which is already
// covered by:
//   - scripts/verify-wxml-expression-helpers.mjs: "object literal shape"
//     and the looksLikeObjectLiteralExpression direct assertions.
// A hover-side test would either duplicate that coverage with a tautological
// position assertion, or require a new WXML fixture containing `{{ {a: 1} }}`.
// Hover's contract for "no expressionRef at position -> null" is covered by
// H-14 (whitespace) and H-15 (inside <import>). Keeping H-13 here would risk
// going green even if the helper regressed, so it is deliberately omitted.

function assertHoverInWhitespaceReturnsNull(graph) {
  // H-14: blank line 4 (row 3) in home.wxml.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 3, character: 0 },
    extensionRoot: ROOT,
  });
  assert(hover === null, `H-14: expected null in whitespace, got ${JSON.stringify(hover)}`);
}

function assertHoverInsideImportReturnsNull(graph) {
  // H-15: cursor inside <import src="..."> — dependency hover is out of scope.
  const hover = getHover({
    graph,
    documentPath: HOME_WXML,
    position: { line: 0, character: 10 },
    extensionRoot: ROOT,
  });
  assert(hover === null, `H-15: expected null inside <import>, got ${JSON.stringify(hover)}`);
}

function assertHoverWxsLegacyGraphDegradesGracefully(graph) {
  // S-W4: legacy graph without nameRange on wxs symbols — hover must return
  // null instead of falling back to the wide element range.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const original = homeFile.symbols;
  homeFile.symbols = original.map((s) => {
    if (s.kind !== "wxs") return s;
    const { nameRange: _nr, ...rest } = s;
    return rest;
  });
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 2, character: 15 },
      extensionRoot: ROOT,
    });
    assert(hover === null,
      `S-W4: legacy graph (no wxs nameRange) must not trigger wxs hover; got ${JSON.stringify(hover)}`);
  } finally {
    homeFile.symbols = original;
  }
}

function assertHoverOnWxsExpressionRefInTemplateOnlyFile(graph) {
  // Bug-fix #1 regression: `templates/common.wxml` has no JS sibling, so
  // findOwnerConfigWithScript returns null. Pre-fix this caused getHover to
  // early-return null for ALL expression-refs in template files, including
  // wxs xrefs. We synthesize an in-file wxs symbol + matching expressionRef
  // on common.wxml and assert hover still resolves through step 2c.
  const COMMON_GRAPH_PATH = "fixtures/miniprogram/templates/common.wxml";
  const commonFile = graph.wxml.find((f) => f.path === COMMON_GRAPH_PATH);
  assert(commonFile, "template-only-wxs setup: common.wxml file model");
  // Confirm the precondition: no owner config with script (would invalidate the test).
  const ownerConfig = graph.configs.find((c) => c.owner === COMMON_GRAPH_PATH && c.script);
  assert(!ownerConfig, "template-only-wxs setup: common.wxml must have NO script-bearing owner config");

  const originalSymbols = commonFile.symbols;
  const originalRefs = commonFile.expressionRefs;
  const syntheticSymbol = {
    kind: "wxs",
    name: "__hover_template_only_fmt__",
    range: { start: { row: 400, column: 0 }, end: { row: 402, column: 6 } },
    nameRange: { start: { row: 400, column: 13 }, end: { row: 400, column: 38 } },
  };
  const syntheticRef = {
    name: "__hover_template_only_fmt__",
    source: "interpolation",
    inTemplateDefinition: false,
    range: { start: { row: 405, column: 0 }, end: { row: 405, column: 25 } },
    expressionRange: { start: { row: 405, column: 0 }, end: { row: 405, column: 25 } },
  };
  commonFile.symbols = [...originalSymbols, syntheticSymbol];
  commonFile.expressionRefs = [...originalRefs, syntheticRef];
  try {
    const hover = getHover({
      graph,
      documentPath: COMMON_WXML,
      position: { line: 405, character: 10 },
      extensionRoot: ROOT,
    });
    assert(hover, "template-only-wxs: expected Hover, got null (Bug #1 regression)");
    const value = hoverContents(hover);
    assert(value.startsWith("**__hover_template_only_fmt__** — `wxs module`"),
      `template-only-wxs: bad title: ${value}`);
    assert(value.includes("inline wxs module in this file"),
      `template-only-wxs: expected inline note (no matching dep); got ${value}`);
  } finally {
    commonFile.symbols = originalSymbols;
    commonFile.expressionRefs = originalRefs;
  }
}

function assertHoverOnUnresolvedExternalWxsDeclReturnsNull(graph) {
  // Bug-fix #2 regression: an external <wxs module="abs" src="/utils/abs.wxs"/>
  // produces a wxs symbol AND a dependency entry, but the dep has no `normalized`
  // (absolute paths don't normalize). Pre-fix, the find with `&& d.normalized`
  // missed the dep and fell into the inline arm, mislabeling as inline. The
  // fix should return null for unresolved external instead.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const originalSymbols = homeFile.symbols;
  const originalDeps = homeFile.dependencies;
  const syntheticSymbol = {
    kind: "wxs",
    name: "__hover_unresolved_abs__",
    range: { start: { row: 410, column: 0 }, end: { row: 410, column: 50 } },
    nameRange: { start: { row: 410, column: 13 }, end: { row: 410, column: 35 } },
  };
  // dep entry exists (so this IS external) but no `normalized` (unresolvable).
  const syntheticDep = {
    kind: "wxs",
    value: "/utils/abs.wxs",
    range: { start: { row: 410, column: 0 }, end: { row: 410, column: 50 } },
    module: "__hover_unresolved_abs__",
  };
  homeFile.symbols = [...originalSymbols, syntheticSymbol];
  homeFile.dependencies = [...originalDeps, syntheticDep];
  try {
    // Cursor on the synthetic wxs decl's nameRange.
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 410, character: 20 },
      extensionRoot: ROOT,
    });
    assert(hover === null,
      `unresolved-external-wxs-decl: expected null, got ${JSON.stringify(hover)} (Bug #2 regression — would have mislabeled as inline pre-fix)`);
  } finally {
    homeFile.symbols = originalSymbols;
    homeFile.dependencies = originalDeps;
  }
}

function assertHoverOnUnresolvedExternalWxsExprRefReturnsNull(graph) {
  // Bug-fix #2 regression — interpolation-side counterpart of the previous test.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  const originalSymbols = homeFile.symbols;
  const originalDeps = homeFile.dependencies;
  const originalRefs = homeFile.expressionRefs;
  const syntheticSymbol = {
    kind: "wxs",
    name: "__hover_unresolved_abs_ref__",
    range: { start: { row: 420, column: 0 }, end: { row: 420, column: 50 } },
    nameRange: { start: { row: 420, column: 13 }, end: { row: 420, column: 40 } },
  };
  const syntheticDep = {
    kind: "wxs",
    value: "/utils/abs.wxs",
    range: { start: { row: 420, column: 0 }, end: { row: 420, column: 50 } },
    module: "__hover_unresolved_abs_ref__",
  };
  const syntheticRef = {
    name: "__hover_unresolved_abs_ref__",
    source: "interpolation",
    inTemplateDefinition: false,
    range: { start: { row: 425, column: 0 }, end: { row: 425, column: 27 } },
    expressionRange: { start: { row: 425, column: 0 }, end: { row: 425, column: 27 } },
  };
  homeFile.symbols = [...originalSymbols, syntheticSymbol];
  homeFile.dependencies = [...originalDeps, syntheticDep];
  homeFile.expressionRefs = [...originalRefs, syntheticRef];
  try {
    const hover = getHover({
      graph,
      documentPath: HOME_WXML,
      position: { line: 425, character: 10 },
      extensionRoot: ROOT,
    });
    assert(hover === null,
      `unresolved-external-wxs-expr-ref: expected null, got ${JSON.stringify(hover)} (Bug #2 regression — would have mislabeled as inline pre-fix)`);
  } finally {
    homeFile.symbols = originalSymbols;
    homeFile.dependencies = originalDeps;
    homeFile.expressionRefs = originalRefs;
  }
}

function assertHoverOnWxForDefaultItem(graph) {
  // W-1: loops.wxml line 3 has `<view class="row" wx:for="{{users}}" wx:key="id">`
  // and line 4 has `{{item.name}} ({{index}})`. Cursor on `item` in {{item.name}}.
  // Find the exact column at runtime to avoid brittleness.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("{{item.name}}"));
  assert(lineIdx >= 0, "W-1 setup: expected line with `{{item.name}}` in loops.wxml");
  const charIdx = lines[lineIdx].indexOf("item");

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },  // mid-name
    extensionRoot: ROOT,
  });
  assert(hover, "W-1: expected Hover for default wx:for item, got null");
  const value = hoverContents(hover);
  assert(value.startsWith("**item** — `wx:for-item`"), `W-1: bad title: ${value}`);
  assert(value.includes("Declared on `<view>` at line "), `W-1: bad source line: ${value}`);
}

function assertHoverOnReferenceOutsideLoopReturnsNull(graph) {
  // W-5: loops.wxml has `<view class="outside-loop">{{item}}</view>` at the
  // bottom — outside every wx:for body. Hover on `item` must NOT resolve
  // to a wx:for binding. (It WILL resolve to data.item via 2b dataKey,
  // because loops.js declares data.item. That's correct — W-5 specifically
  // checks the wx:for step DOESN'T fire here. We assert by checking the
  // kind label is `data`, not `wx:for-item`.)
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("outside-loop") && l.includes("{{item}}"));
  assert(lineIdx >= 0, "W-5 setup: expected line with outside-loop {{item}}");
  const charIdx = lines[lineIdx].indexOf("{{item}}") + 2;  // inside the {{

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-5: expected Hover for outside-loop {{item}} (resolves to data); got null");
  const value = hoverContents(hover);
  assert(!value.includes("wx:for-item"), `W-5: outside-loop hover MUST NOT be wx:for-item; got ${value}`);
  assert(value.includes("`data`"), `W-5: expected data kind label; got ${value}`);
}

function assertHoverOnWxForMemberChainReturnsNull(graph) {
  // W-6: cursor on `.name` part of {{item.name}} — member chain, not
  // top-level identifier, so no expressionRef is produced. Hover null.
  // (Mirrors existing H-11 logic.)
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("{{item.name}}"));
  assert(lineIdx >= 0, "W-6 setup: line with {{item.name}}");
  const charIdx = lines[lineIdx].indexOf("{{item.name}}") + "{{item.".length;  // on `n` of name

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover === null, `W-6: expected null on member chain, got ${JSON.stringify(hover)}`);
}

function assertHoverOnExplicitWxForItem(graph) {
  // W-2: <view wx:for="{{products}}" wx:for-item="prod" ...>{{prod.title}}</view>
  // Cursor on `prod` in {{prod.title}}.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("{{prod.title}}"));
  assert(lineIdx >= 0, "W-2 setup: line with {{prod.title}}");
  const charIdx = lines[lineIdx].indexOf("{{prod.title}}") + 2;  // on `p` of prod

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-2: expected Hover for explicit wx:for-item 'prod'");
  const value = hoverContents(hover);
  assert(value.startsWith("**prod** — `wx:for-item`"), `W-2: bad title: ${value}`);
}

function assertHoverOnExplicitWxForIndex(graph) {
  // W-3: same line — cursor on `idx` in #{{idx}}.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("#{{idx}}"));
  assert(lineIdx >= 0, "W-3 setup: line with #{{idx}}");
  const charIdx = lines[lineIdx].indexOf("#{{idx}}") + 3;  // on `i` of idx

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-3: expected Hover for explicit wx:for-index 'idx'");
  const value = hoverContents(hover);
  assert(value.startsWith("**idx** — `wx:for-index`"), `W-3: bad title: ${value}`);
}

function assertHoverNestedShadowing(graph) {
  // W-4: nested loops. The fixture has:
  //   <view wx:for="{{groups}}" wx:for-item="outer">
  //     <view wx:for="{{outer.entries}}" wx:for-item="inner">
  //       {{outer.label}} :: {{inner.value}}
  //     </view>
  //   </view>
  // Inside the inner subtree, hover `outer` → outer scope (inner only
  // shadows `inner`); hover `inner` → inner scope.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("{{outer.label}} :: {{inner.value}}"));
  assert(lineIdx >= 0, "W-4 setup: line with `{{outer.label}} :: {{inner.value}}`");
  const text = lines[lineIdx];

  // Cursor on `outer` in {{outer.label}} (inside inner subtree).
  const outerChar = text.indexOf("{{outer.label}}") + 2;
  const hoverOuter = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: outerChar + 1 },
    extensionRoot: ROOT,
  });
  assert(hoverOuter, "W-4: expected Hover for `outer` inside inner subtree");
  const outerValue = hoverContents(hoverOuter);
  assert(outerValue.startsWith("**outer** — `wx:for-item`"),
    `W-4: outer hover should be wx:for-item; got ${outerValue}`);

  // Cursor on `inner` in {{inner.value}} (inside inner subtree).
  const innerChar = text.indexOf("{{inner.value}}") + 2;
  const hoverInner = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: innerChar + 1 },
    extensionRoot: ROOT,
  });
  assert(hoverInner, "W-4: expected Hover for `inner`");
  const innerValue = hoverContents(hoverInner);
  assert(innerValue.startsWith("**inner** — `wx:for-item`"),
    `W-4: inner hover should be wx:for-item; got ${innerValue}`);
}

function assertHoverIterableExclusion(graph) {
  // W-9: <view wx:for="{{item}}" wx:for-item="item" ...>
  // The fixture has this exact pattern. Cursor on `item` INSIDE the
  // wx:for="{{item}}" attribute value MUST resolve to outer scope
  // (data.item from loops.js), NOT to this loop's own itemName.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) =>
    l.includes(`wx:for="{{item}}"`)
    && l.includes(`wx:for-item="item"`)
    && !l.trimStart().startsWith("<!--"));
  assert(lineIdx >= 0, "W-9 setup: line with `wx:for=\"{{item}}\" wx:for-item=\"item\"`");
  const charIdx = lines[lineIdx].indexOf(`wx:for="{{item}}"`) + `wx:for="{{`.length;  // on `i` of `item` inside {{

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-9: expected Hover for iterable-side `item` (resolves to data)");
  const value = hoverContents(hover);
  assert(!value.includes("wx:for-item"),
    `W-9: iterable-side hover MUST NOT bind to the loop's own wx:for-item; got ${value}`);
  assert(value.includes("`data`"),
    `W-9: expected data kind label (loops.js declares data.item); got ${value}`);
}

function assertHoverWxForShadowsData(graph) {
  // W-8: loops.js has data.item. The fourth loop in loops.wxml is
  // <view wx:for="{{item}}" wx:for-item="item">{{item.label}}</view>.
  // Cursor on `item` inside {{item.label}} (loop body) MUST resolve to
  // wx:for-item, NOT data.item.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("{{item.label}}"));
  assert(lineIdx >= 0, "W-8 setup: line with {{item.label}} (collision-loop body)");
  const charIdx = lines[lineIdx].indexOf("{{item.label}}") + 2;  // on `i` of item

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-8: expected Hover for item inside collision loop body");
  const value = hoverContents(hover);
  assert(value.startsWith("**item** — `wx:for-item`"),
    `W-8: loop body hover MUST be wx:for-item (shadows data.item); got ${value}`);
}

function assertHoverDataOutsideLoopBody(graph) {
  // W-10: explicit positive arm — outside the collision loop body,
  // {{item}} resolves to data.item. (Already covered by W-5; kept
  // separately to lock the contract symmetrically with W-8.)
  // Reuses W-5's outside-loop position; the assertion is identical.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("outside-loop") && l.includes("{{item}}"));
  assert(lineIdx >= 0, "W-10 setup: line with outside-loop {{item}}");
  const charIdx = lines[lineIdx].indexOf("{{item}}") + 2;

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-10: expected Hover");
  const value = hoverContents(hover);
  assert(value.includes("`data`"),
    `W-10: outside-loop hover MUST be data, not wx:for-item; got ${value}`);
}

function assertHoverOnBlockWxForItem(graph) {
  // W-11: hover on `grp` inside <block wx:for="{{groups}}" wx:for-item="grp">.
  // Pre-fix this returned null because block_element scopes weren't extracted.
  const fileText = fs.readFileSync(LOOPS_WXML, "utf8");
  const lines = fileText.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("{{grp.label}}"));
  assert(lineIdx >= 0, "W-11 setup: line with {{grp.label}}");
  const charIdx = lines[lineIdx].indexOf("{{grp.label}}") + 2;  // on `g` of grp

  const hover = getHover({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character: charIdx + 1 },
    extensionRoot: ROOT,
  });
  assert(hover, "W-11: expected Hover for `grp` inside <block wx:for> body");
  const value = hoverContents(hover);
  assert(value.startsWith("**grp** — `wx:for-item`"),
    `W-11: bad title; got ${value}`);
  assert(value.includes("Declared on `<block>` at line "),
    `W-11: expected source line to mention <block> as ownerTag; got ${value}`);
}

// Phase 3 Task 4 — Declaration-side hover (HD-1..HD-3) --------------------

function assertHoverOnWxForItemDeclaration(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(`wx:for-item="prod"`));
  assert(i >= 0, "HD-1 setup: line with wx:for-item=\"prod\"");
  const ch = lines[i].indexOf(`wx:for-item="prod"`) + `wx:for-item="`.length; // on `p`
  const hover = getHover({ graph, documentPath: LOOPS_WXML, position: { line: i, character: ch + 1 }, extensionRoot: ROOT });
  assert(hover, "HD-1: expected Hover on wx:for-item declaration");
  const value = hoverContents(hover);
  assert(value.startsWith("**prod** — `wx:for-item`"), `HD-1: bad title; got ${value}`);
}

function assertHoverOnWxForIndexDeclaration(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(`wx:for-index="idx"`));
  assert(i >= 0, "HD-2 setup: line with wx:for-index=\"idx\"");
  const ch = lines[i].indexOf(`wx:for-index="idx"`) + `wx:for-index="`.length; // on `i`
  const hover = getHover({ graph, documentPath: LOOPS_WXML, position: { line: i, character: ch + 1 }, extensionRoot: ROOT });
  assert(hover, "HD-2: expected Hover on wx:for-index declaration");
  const value = hoverContents(hover);
  assert(value.startsWith("**idx** — `wx:for-index`"), `HD-2: bad title; got ${value}`);
}

function assertHoverOnIterableValueResolvesData(graph) {
  // The `users` inside wx:for="{{users}}" is the iterable, NOT a declaration.
  // The declaration-side branch must NOT fire: `{{users}}` lives in wxForRange
  // (not in any itemNameRange/indexNameRange), so findWxForDeclarationAtPosition
  // cannot match it by construction; `users` resolves via the expression-ref/data
  // path instead.
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(`wx:for="{{users}}"`));
  assert(i >= 0, "HD-3 setup: line with wx:for=\"{{users}}\"");
  const ch = lines[i].indexOf(`wx:for="{{users}}"`) + `wx:for="{{`.length; // on `u`
  const hover = getHover({ graph, documentPath: LOOPS_WXML, position: { line: i, character: ch + 1 }, extensionRoot: ROOT });
  assert(hover, "HD-3: expected Hover for `users` on the iterable value");
  const value = hoverContents(hover);
  assert(value.includes("`data`"), `HD-3: iterable value must resolve as data, not a wx:for card; got ${value}`);
}

// Phase 3 Stage E — wx:for binding definition (D-1..D-10) ----------------

// Returns the single-line text covered by an LSP range, for asserting a
// definition Location points at the expected declaration token.
// Returns null for cross-line ranges; callers assert string equality, so null safely fails the assertion.
function lspRangeText(lines, range) {
  if (range.start.line !== range.end.line) return null;
  return lines[range.start.line].slice(range.start.character, range.end.character);
}

function loopsLines() {
  return fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
}

function defAt(graph, lineIdx, character) {
  return getDefinition({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character },
    extensionRoot: ROOT,
  });
}

function assertDefinitionExplicitWxForItem(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{prod.title}}"));
  assert(i >= 0, "D-1 setup: line with {{prod.title}}");
  const ch = lines[i].indexOf("{{prod.title}}") + 2; // on `p` of prod
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-1: expected Location for explicit wx:for-item `prod`");
  assert(loc.uri.endsWith("/fixtures/miniprogram/pages/loops/loops.wxml"), `D-1: same-file uri; got ${loc.uri}`);
  assert(lspRangeText(lines, loc.range) === "prod", `D-1: range must cover 'prod'; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionExplicitWxForIndex(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("#{{idx}}"));
  assert(i >= 0, "D-2 setup: line with #{{idx}}");
  const ch = lines[i].indexOf("#{{idx}}") + 3; // on `i` of idx (skip `#{{`)
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-2: expected Location for explicit wx:for-index `idx`");
  assert(lspRangeText(lines, loc.range) === "idx", `D-2: range must cover 'idx'; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionDefaultWxForItem(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{item.name}}"));
  assert(i >= 0, "D-3 setup: line with {{item.name}}");
  const ch = lines[i].indexOf("{{item.name}}") + 2; // on `i` of item
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-3: expected Location for default item");
  assert(loc.uri.endsWith("/fixtures/miniprogram/pages/loops/loops.wxml"), `D-3: same-file uri; got ${loc.uri}`);
  assert(lspRangeText(lines, loc.range) === "wx:for", `D-3: default item must jump to the wx:for token; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionDefaultWxForIndex(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("({{index}})"));
  assert(i >= 0, "D-4 setup: line with ({{index}})");
  const ch = lines[i].indexOf("({{index}})") + 3; // on `i` of index (skip `({{`)
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-4: expected Location for default index");
  assert(lspRangeText(lines, loc.range) === "wx:for", `D-4: default index must jump to the wx:for token; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionNestedShadowing(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{outer.label}} :: {{inner.value}}"));
  assert(i >= 0, "D-5 setup: line with {{outer.label}} :: {{inner.value}}");
  const innerCh = lines[i].indexOf("{{inner.value}}") + 2;
  const innerLoc = defAt(graph, i, innerCh + 1);
  assert(innerLoc, "D-5: expected Location for inner ref");
  assert(lspRangeText(lines, innerLoc.range) === "inner", `D-5: inner ref must jump to wx:for-item="inner"; got '${lspRangeText(lines, innerLoc.range)}'`);
  const outerCh = lines[i].indexOf("{{outer.label}}") + 2;
  const outerLoc = defAt(graph, i, outerCh + 1);
  assert(outerLoc, "D-5: expected Location for outer ref");
  assert(lspRangeText(lines, outerLoc.range) === "outer", `D-5: outer ref must jump to wx:for-item="outer"; got '${lspRangeText(lines, outerLoc.range)}'`);
}

function assertDefinitionWxForShadowsData(graph) {
  // Collision loop body: {{item.label}} resolves to wx:for-item="item" (in-file),
  // NOT data.item in loops.js.
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{item.label}}"));
  assert(i >= 0, "D-6 setup: line with {{item.label}}");
  const ch = lines[i].indexOf("{{item.label}}") + 2;
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-6: expected Location for shadowing item");
  assert(loc.uri.endsWith("/fixtures/miniprogram/pages/loops/loops.wxml"), `D-6: wx:for must win over data (stay in-file); got ${loc.uri}`);
  assert(lspRangeText(lines, loc.range) === "item", `D-6: must jump to wx:for-item="item"; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionOutsideLoopFallsThroughToData(graph) {
  // Outside any loop, {{item}} is NOT a binding; the wx:for branch finds no
  // scope and control falls through to the data lookup → loops.js.
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("outside-loop") && l.includes("{{item}}"));
  assert(i >= 0, "D-7 setup: line with outside-loop marker and {{item}}");
  const ch = lines[i].indexOf("{{item}}") + 2;
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-7: expected fall-through Location to data.item");
  assert(loc.uri.endsWith("/fixtures/miniprogram/pages/loops/loops.js"), `D-7: outside loop must fall through to data (loops.js); got ${loc.uri}`);
}

function assertDefinitionBlockWxForItem(graph) {
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{grp.label}}"));
  assert(i >= 0, "D-8 setup: line with {{grp.label}}");
  const ch = lines[i].indexOf("{{grp.label}}") + 2;
  const loc = defAt(graph, i, ch + 1);
  assert(loc, "D-8: expected Location for <block wx:for> item `grp`");
  assert(loc.uri.endsWith("/fixtures/miniprogram/pages/loops/loops.wxml"), `D-8: same-file uri; got ${loc.uri}`);
  assert(lspRangeText(lines, loc.range) === "grp", `D-8: must jump to wx:for-item="grp"; got '${lspRangeText(lines, loc.range)}'`);
}

function assertDefinitionWxForLegacyGraphDegrades(graph) {
  // Simulate a graph built before wxForKeywordRange existed (no version bump):
  // strip the field, then request definition on the default index, which has no
  // data fallback. The wx:for branch must degrade to a clean null WITHOUT
  // throwing in rangeFromSymbolRange.
  const cloned = JSON.parse(JSON.stringify(graph));
  const loopsFile = cloned.wxml.find((f) => f.path === LOOPS_WXML_GRAPH_PATH);
  assert(loopsFile, "D-9 setup: loops file in cloned graph");
  let stripped = 0;
  for (const s of loopsFile.wxForScopes ?? []) {
    if ("wxForKeywordRange" in s) { delete s.wxForKeywordRange; stripped += 1; }
  }
  assert(stripped > 0, "D-9 setup: expected at least one wxForKeywordRange to strip");
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("({{index}})"));
  const ch = lines[i].indexOf("({{index}})") + 3;
  let loc;
  try {
    loc = getDefinition({
      graph: cloned,
      documentPath: LOOPS_WXML,
      position: { line: i, character: ch + 1 },
      extensionRoot: ROOT,
    });
  } catch (err) {
    throw new Error(`D-9: getDefinition threw on a graph missing wxForKeywordRange: ${err.message}`);
  }
  assert(loc === null, `D-9: degraded implicit-index definition must be null; got ${JSON.stringify(loc)}`);
}

function assertDefinitionWxForExplicitLegacyDegrades(graph) {
  // Source-based selection guard: an EXPLICIT binding whose nameRange is missing
  // on a legacy graph must NOT fall back to wxForKeywordRange (would jump to the
  // wx:for token, wrong per spec). It must degrade — here `prod` has no data
  // fallback, so the result is a clean null without throwing.
  const cloned = JSON.parse(JSON.stringify(graph));
  const loopsFile = cloned.wxml.find((f) => f.path === LOOPS_WXML_GRAPH_PATH);
  assert(loopsFile, "D-10 setup: loops file in cloned graph");
  const prodScope = (loopsFile.wxForScopes ?? []).find((s) => s.itemName === "prod");
  assert(prodScope && prodScope.itemSource === "explicit", "D-10 setup: expected explicit prod scope");
  delete prodScope.itemNameRange; // simulate pre-field legacy graph
  const lines = loopsLines();
  const i = lines.findIndex((l) => l.includes("{{prod.title}}"));
  const ch = lines[i].indexOf("{{prod.title}}") + 2;
  let loc;
  try {
    loc = getDefinition({
      graph: cloned,
      documentPath: LOOPS_WXML,
      position: { line: i, character: ch + 1 },
      extensionRoot: ROOT,
    });
  } catch (err) {
    throw new Error(`D-10: getDefinition threw on explicit scope missing itemNameRange: ${err.message}`);
  }
  assert(loc === null, `D-10: explicit binding missing nameRange must degrade to null (not jump to wx:for); got ${JSON.stringify(loc)}`);
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
  // v2-C: diagnostics use per-ref activeWxForBindingsAt(wxForScopes, position)
  // rather than the flat wxForBindings shim. A synthetic expressionRef at row 0
  // col 0 (before any wx:for block in home.wxml, so outside every scope) warns when no
  // active scope covers it, and is suppressed when a synthetic wxForScope does.
  const homeFile = graph.wxml.find((f) => f.path === HOME_WXML_GRAPH_PATH);
  assert(homeFile, "test setup: home file must exist in graph.wxml");
  assert(Array.isArray(homeFile.expressionRefs), "expressionRefs missing from home file model");
  const originalScopes = homeFile.wxForScopes ?? [];
  const originalRefs = homeFile.expressionRefs;
  // Place the synthetic ref OUTSIDE any existing wx:for scope (row 0 col 0).
  const synthetic = {
    name: "__synthetic_for_user__",
    source: "interpolation",
    containingTag: null,
    containingAttribute: null,
    range: { start: { row: 0, column: 0 }, end: { row: 0, column: 24 } },
    expressionRange: { start: { row: 0, column: 0 }, end: { row: 0, column: 24 } },
  };
  homeFile.expressionRefs = [...originalRefs, synthetic];
  try {
    const before = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT })
      .filter((d) => d.code === "missing-expression-ref" && d.message.includes("__synthetic_for_user__"));
    assert(before.length === 1, `pre-add: expected 1 synthetic warning (outside any wx:for scope), got ${before.length}`);

    // Add a synthetic wxForScope that covers row 0 col 0 and declares the name.
    // activeWxForBindingsAt checks scopeRange (not bodyRange) and requires
    // position inside scopeRange but NOT inside wxForRange.
    const syntheticScope = {
      itemName: "__synthetic_for_user__",
      itemSource: "explicit",
      indexName: "__synthetic_idx__",
      indexSource: "implicit",
      // scopeRange covers the ref position (row 0 col 0)
      scopeRange: { start: { row: 0, column: 0 }, end: { row: 1, column: 0 } },
      // wxForRange must NOT cover the position (so iterable-exclusion doesn't block it)
      wxForRange: { start: { row: 1, column: 0 }, end: { row: 1, column: 10 } },
    };
    homeFile.wxForScopes = [...originalScopes, syntheticScope];
    const after = getDiagnostics({ graph, documentPath: HOME_WXML, extensionRoot: ROOT })
      .filter((d) => d.code === "missing-expression-ref" && d.message.includes("__synthetic_for_user__"));
    assert(after.length === 0, `post-add: expected wx:for-item suppression via wxForScopes, got ${JSON.stringify(after)}`);
  } finally {
    homeFile.expressionRefs = originalRefs;
    homeFile.wxForScopes = originalScopes;
  }
}

function assertCrossBindingT5DeclaredProp(graph) {
  // T5 (happy path): parent's <local-bar locationError="{{locationError}}">
  // on lines 2 and 6 of cross-binding.wxml. With locationError removed from
  // the page's dataKeys, both refs become unresolved against parent scope.
  // local-bar declares locationError as a property → exactly 2
  // dead-component-binding Information diagnostics for locationError,
  // and ZERO missing-expression-ref for locationError.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T5 setup: cross-binding config must have script");
  const originalDataKeys = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = originalDataKeys.filter((k) => k.name !== "locationError");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const allDead = diagnostics.filter((d) => d.code === "dead-component-binding");
    const locationErrorDead = allDead.filter((d) => d.message.includes('"locationError"'));
    const locationErrorWarn = diagnostics.filter((d) => (
      d.code === "missing-expression-ref" && d.message.includes('"locationError"')
    ));
    assert(
      locationErrorDead.length === 2,
      `T5: expected exactly 2 dead-component-binding for locationError; got ${locationErrorDead.length}. All: ${JSON.stringify(allDead)}`,
    );
    assert(
      locationErrorWarn.length === 0,
      `T5: locationError must NOT also be a warning; got ${locationErrorWarn.length}: ${JSON.stringify(locationErrorWarn)}`,
    );
    for (const d of locationErrorDead) {
      assert(d.severity === 3, `T5: severity ${d.severity} !== 3 for ${JSON.stringify(d)}`);
      assert(d.source === "wxml-zed", `T5: source ${d.source}`);
      assert(
        d.message.includes("receive undefined and use its property default if one exists"),
        `T5: message mismatch: ${d.message}`,
      );
    }
    // Also assert there are no UNEXPECTED diagnostics on this file.
    const otherDiags = diagnostics.filter((d) => !d.message.includes('"locationError"'));
    assert(
      otherDiags.length === 0,
      `T5: unexpected non-locationError diagnostics: ${JSON.stringify(otherDiags)}`,
    );
  } finally {
    pageConfig.script.dataKeys = originalDataKeys;
  }
}

function assertCrossBindingT1BuiltinTag(graph) {
  // T1: remove `theme` from data → line 1's <view class="container {{theme}}">
  // produces exactly 1 missing-expression-ref. No dead-component-binding
  // (view is a built-in tag; class is a reserved attribute regardless).
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T1 setup: cross-binding config must have script");
  const originalDataKeys = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = originalDataKeys.filter((k) => k.name !== "theme");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"theme"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"theme"'));
    assert(warn.length === 1, `T1: expected exactly 1 missing-expression-ref for theme; got ${warn.length}`);
    assert(dead.length === 0, `T1: theme must NOT be dead-component-binding; got ${dead.length}`);
    const others = diagnostics.filter((d) => !d.message.includes('"theme"'));
    assert(others.length === 0, `T1: unexpected non-theme diagnostics: ${JSON.stringify(others)}`);
  } finally {
    pageConfig.script.dataKeys = originalDataKeys;
  }
}

function assertCrossBindingT2ReservedWxIf(graph) {
  // T2: remove `shouldShow` from data → line 6's <local-bar wx:if="{{shouldShow}}" ...>
  // produces missing-expression-ref. wx:if is reserved; even though local-bar
  // is a component, the attr is reserved → no dead-component-binding.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T2 setup");
  const original = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = original.filter((k) => k.name !== "shouldShow");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"shouldShow"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"shouldShow"'));
    assert(warn.length === 1, `T2: expected 1 missing-expression-ref for shouldShow; got ${warn.length}`);
    assert(dead.length === 0, `T2: shouldShow must NOT be dead-component-binding (wx:if reserved); got ${dead.length}`);
    const others = diagnostics.filter((d) => !d.message.includes('"shouldShow"'));
    assert(others.length === 0, `T2: unexpected others: ${JSON.stringify(others)}`);
  } finally {
    pageConfig.script.dataKeys = original;
  }
}

function assertCrossBindingT3ReservedDataPrefix(graph) {
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T3 setup");
  const original = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = original.filter((k) => k.name !== "customId");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"customId"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"customId"'));
    assert(warn.length === 1, `T3: expected 1 missing-expression-ref for customId; got ${warn.length}`);
    assert(dead.length === 0, `T3: customId must NOT be dead-component-binding (data- reserved); got ${dead.length}`);
    const others = diagnostics.filter((d) => !d.message.includes('"customId"'));
    assert(others.length === 0, `T3: unexpected others: ${JSON.stringify(others)}`);
  } finally {
    pageConfig.script.dataKeys = original;
  }
}

function assertCrossBindingT4ReservedGenericPrefix(graph) {
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T4 setup");
  const original = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = original.filter((k) => k.name !== "customGeneric");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"customGeneric"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"customGeneric"'));
    assert(warn.length === 1, `T4: expected 1 missing-expression-ref for customGeneric; got ${warn.length}`);
    assert(dead.length === 0, `T4: customGeneric must NOT be dead-component-binding (generic: reserved); got ${dead.length}`);
    const others = diagnostics.filter((d) => !d.message.includes('"customGeneric"'));
    assert(others.length === 0, `T4: unexpected others: ${JSON.stringify(others)}`);
  } finally {
    pageConfig.script.dataKeys = original;
  }
}

function assertCrossBindingT6ChildLacksProp(graph) {
  // T6: remove `locationError` from page data AND from local-bar propertyKeys.
  // Lines 2 + 6 reference {{locationError}} on local-bar's `locationError`
  // attribute. local-bar no longer declares it. Expect 2 missing-expression-ref
  // and 0 dead-component-binding.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const childConfig = graph.configs.find((c) => c.path === LOCAL_BAR_CONFIG_PATH);
  assert(pageConfig?.script && childConfig?.script, "T6 setup");
  const origPage = pageConfig.script.dataKeys;
  const origChild = childConfig.script.propertyKeys;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "locationError");
  childConfig.script.propertyKeys = origChild.filter((k) => k.name !== "locationError");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"locationError"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"locationError"'));
    assert(warn.length === 2, `T6: expected 2 missing-expression-ref for locationError; got ${warn.length}`);
    assert(dead.length === 0, `T6: locationError must NOT be dead-component-binding (child lacks prop); got ${dead.length}`);
    for (const d of warn) assert(d.severity === 2, `T6: severity ${d.severity} !== 2`);
  } finally {
    pageConfig.script.dataKeys = origPage;
    childConfig.script.propertyKeys = origChild;
  }
}

function assertCrossBindingT7ChildNoScript(graph) {
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const childConfig = graph.configs.find((c) => c.path === LOCAL_BAR_CONFIG_PATH);
  assert(pageConfig?.script && childConfig?.script, "T7 setup");
  const origPage = pageConfig.script.dataKeys;
  const origChildScript = childConfig.script;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "locationError");
  delete childConfig.script;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"locationError"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"locationError"'));
    assert(warn.length === 2, `T7: expected 2 missing-expression-ref for locationError; got ${warn.length}`);
    assert(dead.length === 0, `T7: must NOT be dead-component-binding (child has no script); got ${dead.length}`);
  } finally {
    pageConfig.script.dataKeys = origPage;
    childConfig.script = origChildScript;
  }
}

function assertCrossBindingT8aStaticHitWinsOverDynamic(graph) {
  // T8a (regression lock for lookup ordering): dyn-card has behaviors
  // (hasDynamicData=true) AND statically declares knownProp. Remove dynValue
  // from page data. Line 9's <dyn-card knownProp="{{dynValue}}"> must
  // downgrade to dead-component-binding because the static propertyKeys
  // hit precedes the hasDynamicData fallback.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const dynCardConfig = graph.configs.find((c) => c.path === DYN_CARD_CONFIG_PATH);
  assert(pageConfig?.script && dynCardConfig?.script, "T8a setup");
  assert(dynCardConfig.script.hasDynamicData === true, "T8a setup: dyn-card must have hasDynamicData=true");
  assert(dynCardConfig.script.propertyKeys.some((k) => k.name === "knownProp"), "T8a setup: dyn-card must declare knownProp");
  const origPage = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "dynValue");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"dynValue"'));
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"dynValue"'));
    assert(dead.length === 1, `T8a: expected 1 dead-component-binding for dynValue (static hit wins); got ${dead.length}`);
    assert(warn.length === 0, `T8a: dynValue must NOT be a warning; got ${warn.length}`);
    assert(dead[0].severity === 3, `T8a: severity ${dead[0].severity} !== 3`);
  } finally {
    pageConfig.script.dataKeys = origPage;
  }
}

function assertCrossBindingT8bDynamicChildLacksProp(graph) {
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const dynCardConfig = graph.configs.find((c) => c.path === DYN_CARD_CONFIG_PATH);
  assert(pageConfig?.script && dynCardConfig?.script, "T8b setup");
  const origPage = pageConfig.script.dataKeys;
  const origChild = dynCardConfig.script.propertyKeys;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "dynValue");
  dynCardConfig.script.propertyKeys = origChild.filter((k) => k.name !== "knownProp");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"dynValue"'));
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"dynValue"'));
    assert(warn.length === 1, `T8b: expected 1 missing-expression-ref; got ${warn.length}`);
    assert(dead.length === 0, `T8b: must NOT be dead-component-binding (no static hit + hasDynamicData → unresolvable); got ${dead.length}`);
  } finally {
    pageConfig.script.dataKeys = origPage;
    dynCardConfig.script.propertyKeys = origChild;
  }
}

function assertCrossBindingT8cDataSpreadStaticHit(graph) {
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const childConfig = graph.configs.find((c) => c.path === LOCAL_BAR_CONFIG_PATH);
  assert(pageConfig?.script && childConfig?.script, "T8c setup");
  const origPage = pageConfig.script.dataKeys;
  const origHasDynamic = childConfig.script.hasDynamicData;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "locationError");
  childConfig.script.hasDynamicData = true;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"locationError"'));
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"locationError"'));
    assert(dead.length === 2, `T8c: expected 2 dead-component-binding for locationError; got ${dead.length}`);
    assert(warn.length === 0, `T8c: locationError must NOT be a warning; got ${warn.length}`);
  } finally {
    pageConfig.script.dataKeys = origPage;
    childConfig.script.hasDynamicData = origHasDynamic;
  }
}

function assertCrossBindingT9InTemplateDefSkipped(graph) {
  // T9: mutate ONE specific locationError ref's inTemplateDefinition flag to
  // true. Then remove locationError from page data. The flagged ref must be
  // suppressed entirely; the other (unflagged) ref still emits.
  // Expect 1 dead-component-binding (NOT 2 — one was suppressed).
  const wxmlEntry = graph.wxml.find((w) => w.path === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(wxmlEntry, "T9 setup: cross-binding wxml entry");
  const targets = wxmlEntry.expressionRefs.filter((r) => (
    r.name === "locationError" &&
    r.containingTag === "local-bar" &&
    r.containingAttribute === "locationError"
  ));
  assert(targets.length === 2, `T9 setup: expected 2 locationError refs on local-bar.locationError; got ${targets.length}`);
  const ref = targets[0];
  const originalFlag = ref.inTemplateDefinition;
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  const origPage = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = origPage.filter((k) => k.name !== "locationError");
  ref.inTemplateDefinition = true;
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"locationError"'));
    assert(dead.length === 1, `T9: expected exactly 1 dead-component-binding (other was suppressed by inTemplateDefinition); got ${dead.length}`);
  } finally {
    pageConfig.script.dataKeys = origPage;
    ref.inTemplateDefinition = originalFlag;
  }
}

function assertCrossBindingT10LookupByAttributeName(graph) {
  // T10 (regression lock): line 3 has <local-bar locationError="{{missingVar}}"/>.
  // Remove missingVar from page data. The identifier 'missingVar' is NOT a
  // property of local-bar — but the attribute 'locationError' IS. Lookup must
  // key on attribute name → 1 dead-component-binding for missingVar.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T10 setup");
  const original = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = original.filter((k) => k.name !== "missingVar");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const dead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"missingVar"'));
    const warn = diagnostics.filter((d) => d.code === "missing-expression-ref" && d.message.includes('"missingVar"'));
    assert(dead.length === 1, `T10: expected 1 dead-component-binding for missingVar (lookup by attribute name); got ${dead.length}`);
    assert(warn.length === 0, `T10: missingVar must NOT be a warning; got ${warn.length}`);
    assert(
      dead[0].message.includes('"locationError"'),
      `T10: message must mention the attribute name "locationError"; got ${dead[0].message}`,
    );
  } finally {
    pageConfig.script.dataKeys = original;
  }
}

function assertCrossBindingT11MultiAttrIndependent(graph) {
  // T11: line 4 has <local-bar locationError="{{a}}" referer="{{b}}"/>. Remove
  // BOTH 'a' and 'b' from page data. local-bar declares BOTH locationError
  // AND referer. Expect 2 dead-component-binding total — one for each attr.
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T11 setup");
  const original = pageConfig.script.dataKeys;
  pageConfig.script.dataKeys = original.filter((k) => k.name !== "a" && k.name !== "b");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const aDead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"a"'));
    const bDead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes('"b"'));
    assert(aDead.length === 1, `T11: expected 1 dead-component-binding for 'a'; got ${aDead.length}`);
    assert(bDead.length === 1, `T11: expected 1 dead-component-binding for 'b'; got ${bDead.length}`);
    assert(aDead[0].message.includes('"locationError"'), `T11: 'a' must mention locationError attr`);
    assert(bDead[0].message.includes('"referer"'), `T11: 'b' must mention referer attr`);
    const totalNonAB = diagnostics.filter((d) => !d.message.includes('"a"') && !d.message.includes('"b"'));
    assert(totalNonAB.length === 0, `T11: unexpected others: ${JSON.stringify(totalNonAB)}`);
  } finally {
    pageConfig.script.dataKeys = original;
  }
}

function assertCrossBindingT12EventBindingNotAffected(graph) {
  // T12: line 5 has <local-bar bind:tap="onLocalBarTap"/>. Remove
  // onLocalBarTap from the page's methods. The existing missing-event-handler
  // rule must fire (1 diagnostic); the new dead-component-binding rule must
  // NOT fire (bind: is reserved).
  const pageConfig = graph.configs.find((c) => c.owner === CROSS_BINDING_WXML_GRAPH_PATH);
  assert(pageConfig?.script, "T12 setup");
  const original = pageConfig.script.methods;
  pageConfig.script.methods = original.filter((m) => m.name !== "onLocalBarTap");
  try {
    const diagnostics = getDiagnostics({ graph, documentPath: CROSS_BINDING_WXML, extensionRoot: ROOT });
    const handlerMiss = diagnostics.filter((d) => d.code === "missing-event-handler" && d.message.includes("onLocalBarTap"));
    const handlerDead = diagnostics.filter((d) => d.code === "dead-component-binding" && d.message.includes("onLocalBarTap"));
    assert(handlerMiss.length === 1, `T12: expected 1 missing-event-handler for onLocalBarTap; got ${handlerMiss.length}`);
    assert(handlerDead.length === 0, `T12: onLocalBarTap must NOT be dead-component-binding (bind: reserved); got ${handlerDead.length}`);
  } finally {
    pageConfig.script.methods = original;
  }
}

function assertDynPageT13ParentDynamicBlocksAll(graph) {
  const dynConfig = graph.configs.find((c) => c.owner === DYN_PAGE_WXML_GRAPH_PATH);
  assert(dynConfig?.script, "T13 setup: dyn-page config");
  assert(dynConfig.script.hasDynamicData === true, "T13 setup: dyn-page must have hasDynamicData=true");
  const diagnostics = getDiagnostics({ graph, documentPath: DYN_PAGE_WXML, extensionRoot: ROOT });
  const exprDiags = diagnostics.filter((d) => (
    d.code === "missing-expression-ref" || d.code === "dead-component-binding"
  ));
  assert(
    exprDiags.length === 0,
    `T13: parent hasDynamicData=true must suppress ALL expression diagnostics; got ${exprDiags.length}: ${JSON.stringify(exprDiags)}`,
  );
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

// Phase 3 Task 2 — Template-body wx:for definition (T-1..T-11) ----------------

function tplLines() {
  return fs.readFileSync(TPL_LOOPS_WXML, "utf8").split("\n");
}
function tplRow(lines, needle, label) {
  const i = lines.findIndex((l) => l.includes(needle));
  assert(i >= 0, `${label} setup: line containing ${JSON.stringify(needle)}`);
  return i;
}
function tplDefAt(graph, line, character) {
  return getDefinition({ graph, documentPath: TPL_LOOPS_WXML, position: { line, character }, extensionRoot: ROOT });
}
const TPL_URI_TAIL = "/fixtures/miniprogram/pages/tpl-loops/tpl-loops.wxml";

function assertTplDefExplicitItem(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{row.label}}", "T-1");
  const ch = lines[i].indexOf("{{row.label}}") + 2; // on `r` of row
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc, "T-1: expected Location for explicit item `row`");
  assert(loc.uri.endsWith(TPL_URI_TAIL), `T-1: same-file uri; got ${loc.uri}`);
  assert(lspRangeText(lines, loc.range) === "row", `T-1: range must cover 'row'; got '${lspRangeText(lines, loc.range)}'`);
}

function assertTplDefExplicitIndex(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "#{{idx}}", "T-3");
  const ch = lines[i].indexOf("#{{idx}}") + 3; // on `i` of idx (skip `#{{`)
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc, "T-3: expected Location for explicit index `idx`");
  assert(lspRangeText(lines, loc.range) === "idx", `T-3: range must cover 'idx'; got '${lspRangeText(lines, loc.range)}'`);
}

function assertTplDefImplicitItem(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{item}} {{index}}", "T-5"); // tpl-implicit line
  const ch = lines[i].indexOf("{{item}} {{index}}") + 2; // on `i` of item
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc, "T-5: expected Location for implicit item");
  assert(lspRangeText(lines, loc.range) === "wx:for", `T-5: implicit item must jump to the wx:for token; got '${lspRangeText(lines, loc.range)}'`);
}

function assertTplDefImplicitIndex(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{item}} {{index}}", "T-7");
  const ch = lines[i].indexOf("{{index}}") + 2; // on `i` of index
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc, "T-7: expected Location for implicit index");
  assert(lspRangeText(lines, loc.range) === "wx:for", `T-7: implicit index must jump to the wx:for token; got '${lspRangeText(lines, loc.range)}'`);
}

function assertTplDefDataRefSuppressed(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "({{theme}})", "T-9");
  const ch = lines[i].indexOf("{{theme}}") + 2; // on `t` of theme
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc === null, `T-9: data ref inside template must stay suppressed (null); got ${JSON.stringify(loc)}`);
}

function assertTplDefCase2NoLeak(graph) {
  const lines = tplLines();
  const i = tplRow(lines, 'name="tpl-inner"', "T-11"); // the tpl-inner line carries {{item}}
  const ch = lines[i].indexOf("{{item}}") + 2;
  const loc = tplDefAt(graph, i, ch + 1);
  assert(loc === null, `T-11: outer loop must NOT leak into template body; got ${JSON.stringify(loc)}`);
}

// Phase 3 Task 3 — Template-body wx:for hover (T-2, T-4, T-6, T-8, T-10, T-12, T-13, T-14) --------

function tplHoverAt(graph, line, character) {
  return getHover({ graph, documentPath: TPL_LOOPS_WXML, position: { line, character }, extensionRoot: ROOT });
}

function assertTplHoverExplicitItem(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{row.label}}", "T-2");
  const ch = lines[i].indexOf("{{row.label}}") + 2;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-2: expected Hover for explicit item `row`");
  assert(hoverContents(hov).startsWith("**row** — `wx:for-item`"), `T-2: bad title; got ${hoverContents(hov)}`);
}

function assertTplHoverExplicitIndex(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "#{{idx}}", "T-4");
  const ch = lines[i].indexOf("#{{idx}}") + 3;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-4: expected Hover for explicit index `idx`");
  assert(hoverContents(hov).startsWith("**idx** — `wx:for-index`"), `T-4: bad title; got ${hoverContents(hov)}`);
}

function assertTplHoverImplicitItem(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{item}} {{index}}", "T-6");
  const ch = lines[i].indexOf("{{item}} {{index}}") + 2;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-6: expected Hover for implicit item");
  assert(hoverContents(hov).startsWith("**item** — `wx:for-item`"), `T-6: bad title; got ${hoverContents(hov)}`);
}

function assertTplHoverImplicitIndex(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{item}} {{index}}", "T-8");
  const ch = lines[i].indexOf("{{index}}") + 2;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-8: expected Hover for implicit index");
  assert(hoverContents(hov).startsWith("**index** — `wx:for-index`"), `T-8: bad title; got ${hoverContents(hov)}`);
}

function assertTplHoverDataRefSuppressed(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "({{theme}})", "T-10");
  const ch = lines[i].indexOf("{{theme}}") + 2;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov === null, `T-10: data ref hover inside template must stay suppressed (null); got ${JSON.stringify(hov)}`);
}

function assertTplHoverCase2NoLeak(graph) {
  const lines = tplLines();
  const i = tplRow(lines, 'name="tpl-inner"', "T-12");
  const ch = lines[i].indexOf("{{item}}") + 2;
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov === null, `T-12: outer loop must NOT leak into template body hover; got ${JSON.stringify(hov)}`);
}

function assertTplHoverDeclItem(graph) {
  const lines = tplLines();
  const i = tplRow(lines, 'wx:for-item="row"', "T-13");
  const ch = lines[i].indexOf('wx:for-item="row"') + 'wx:for-item="'.length; // on `r`
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-13: expected declaration-side Hover for `row`");
  assert(hoverContents(hov).startsWith("**row** — `wx:for-item`"), `T-13: bad title; got ${hoverContents(hov)}`);
}

function assertTplHoverDeclIndex(graph) {
  const lines = tplLines();
  const i = tplRow(lines, 'wx:for-index="idx"', "T-14");
  const ch = lines[i].indexOf('wx:for-index="idx"') + 'wx:for-index="'.length; // on `i`
  const hov = tplHoverAt(graph, i, ch + 1);
  assert(hov, "T-14: expected declaration-side Hover for `idx`");
  assert(hoverContents(hov).startsWith("**idx** — `wx:for-index`"), `T-14: bad title; got ${hoverContents(hov)}`);
}

// T-15: defensive degrade — a template symbol missing its `range`, or a scope
// missing `wxForRange` (legacy / hand-built graph), must degrade to null in the
// template-body branch WITHOUT throwing, matching how the sibling step-2a block
// guards name-ranges. Probe the explicit-item ref under both mutations.
function assertTplTemplateBodyDegradesGracefully(graph) {
  const lines = tplLines();
  const i = tplRow(lines, "{{row.label}}", "T-15");
  const ch = lines[i].indexOf("{{row.label}}") + 2;
  const pos = { line: i, character: ch + 1 };
  const findTpl = (g) => g.wxml.find((f) => f.path.endsWith("pages/tpl-loops/tpl-loops.wxml"));

  // (a) template symbols with no range → no enclosing boundary → null, no throw.
  const a = JSON.parse(JSON.stringify(graph));
  const fileA = findTpl(a);
  assert(fileA, "T-15 setup: tpl-loops file in graph");
  let strippedT = 0;
  for (const s of fileA.symbols ?? []) { if (s.kind === "template") { delete s.range; strippedT += 1; } }
  assert(strippedT > 0, "T-15 setup: expected template symbols to strip");
  let locA, hovA;
  try {
    locA = getDefinition({ graph: a, documentPath: TPL_LOOPS_WXML, position: pos, extensionRoot: ROOT });
    hovA = getHover({ graph: a, documentPath: TPL_LOOPS_WXML, position: pos, extensionRoot: ROOT });
  } catch (err) {
    throw new Error(`T-15a: threw on template symbol missing range: ${err.message}`);
  }
  assert(locA === null, `T-15a: expected null definition; got ${JSON.stringify(locA)}`);
  assert(hovA === null, `T-15a: expected null hover; got ${JSON.stringify(hovA)}`);

  // (b) scopes with no wxForRange → filtered out → null, no throw.
  const b = JSON.parse(JSON.stringify(graph));
  const fileB = findTpl(b);
  let strippedS = 0;
  for (const sc of fileB.wxForScopes ?? []) { if ("wxForRange" in sc) { delete sc.wxForRange; strippedS += 1; } }
  assert(strippedS > 0, "T-15 setup: expected scopes to strip");
  let locB, hovB;
  try {
    locB = getDefinition({ graph: b, documentPath: TPL_LOOPS_WXML, position: pos, extensionRoot: ROOT });
    hovB = getHover({ graph: b, documentPath: TPL_LOOPS_WXML, position: pos, extensionRoot: ROOT });
  } catch (err) {
    throw new Error(`T-15b: threw on scope missing wxForRange: ${err.message}`);
  }
  assert(locB === null, `T-15b: expected null definition; got ${JSON.stringify(locB)}`);
  assert(hovB === null, `T-15b: expected null hover; got ${JSON.stringify(hovB)}`);
}

// Phase 3 v2-B — cursor-scoped wx:for completion ----------------------------

function loopsCompletion(graph, lineIdx, character) {
  return getCompletions({
    graph,
    documentPath: LOOPS_WXML,
    position: { line: lineIdx, character },
    sourceText: fs.readFileSync(LOOPS_WXML, "utf8"),
    extensionRoot: ROOT,
  });
}

function rootCharOf(lines, lineIdx, needle) {
  const idx = lines[lineIdx].indexOf(needle);
  assert(idx >= 0, `completion setup: ${JSON.stringify(needle)} not found on line ${lineIdx + 1}`);
  return idx + 2; // first char after `{{`
}

function assertCompletionOutsideLoop(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes("outside-loop") && l.includes("{{item}}"));
  assert(i >= 0, "B-1 setup: outside-loop {{item}} line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{item}}"));
  const labels = items.map((x) => x.label);
  const item = items.find((x) => x.label === "item");
  assert(item && item.detail === "data", `B-1: item must be 'data' outside any loop; got ${item && item.detail}`);
  assert(!items.some((x) => x.detail === "wx:for index"), `B-1: no wx:for index outside loop; got ${JSON.stringify(labels)}`);
  for (const n of ["prod", "idx", "outer", "inner", "grp"]) {
    assert(!labels.includes(n), `B-1: explicit loop name '${n}' must be absent outside loops; got ${JSON.stringify(labels)}`);
  }
}

function assertCompletionDefaultLoopShadowsData(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes("{{item.name}}"));
  assert(i >= 0, "B-2 setup: {{item.name}} line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{item.name}}"));
  const item = items.find((x) => x.label === "item");
  assert(item && item.detail === "wx:for item", `B-2: in-scope item must shadow data.item (wx:for item); got ${item && item.detail}`);
  const index = items.find((x) => x.label === "index");
  assert(index && index.detail === "wx:for index", `B-2: index present as wx:for index; got ${index && index.detail}`);
  const labels = items.map((x) => x.label);
  for (const n of ["prod", "idx", "outer", "inner", "grp"]) {
    assert(!labels.includes(n), `B-2: '${n}' absent in default loop; got ${JSON.stringify(labels)}`);
  }
}

function assertCompletionExplicitLoop(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes("{{prod.title}}"));
  assert(i >= 0, "B-3 setup: {{prod.title}} line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{prod.title}}"));
  const labels = items.map((x) => x.label);
  const prod = items.find((x) => x.label === "prod");
  const idx = items.find((x) => x.label === "idx");
  assert(prod && prod.detail === "wx:for item", `B-3: prod as wx:for item; got ${prod && prod.detail}`);
  assert(idx && idx.detail === "wx:for index", `B-3: idx as wx:for index; got ${idx && idx.detail}`);
  assert(!labels.includes("index"), `B-3: default 'index' not in explicit loop; got ${JSON.stringify(labels)}`);
  for (const n of ["outer", "inner", "grp"]) {
    assert(!labels.includes(n), `B-3: other loop name '${n}' absent; got ${JSON.stringify(labels)}`);
  }
}

function assertCompletionNestedUnion(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes("{{outer.label}} :: {{inner.value}}"));
  assert(i >= 0, "B-4 setup: nested loop body line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{inner.value}}"));
  const labels = items.map((x) => x.label);
  assert(labels.includes("outer") && labels.includes("inner"), `B-4: nested scope offers both outer+inner; got ${JSON.stringify(labels)}`);
  for (const n of ["prod", "idx", "grp"]) {
    assert(!labels.includes(n), `B-4: unrelated loop name '${n}' absent; got ${JSON.stringify(labels)}`);
  }
}

function assertCompletionIterableExclusion(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes('wx:for="{{outer.entries}}"'));
  assert(i >= 0, "B-5 setup: inner loop iterable line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{outer.entries}}"));
  const labels = items.map((x) => x.label);
  assert(labels.includes("outer"), `B-5: enclosing 'outer' still offered inside inner iterable; got ${JSON.stringify(labels)}`);
  assert(!labels.includes("inner"), `B-5: 'inner' excluded inside its own iterable; got ${JSON.stringify(labels)}`);
}

function assertCompletionBlockLoop(graph) {
  const lines = fs.readFileSync(LOOPS_WXML, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes("{{grp.label}}"));
  assert(i >= 0, "B-6 setup: {{grp.label}} line");
  const items = loopsCompletion(graph, i, rootCharOf(lines, i, "{{grp.label}}"));
  const labels = items.map((x) => x.label);
  const grp = items.find((x) => x.label === "grp");
  assert(grp && grp.detail === "wx:for item", `B-6: grp as wx:for item in <block wx:for>; got ${grp && grp.detail}`);
  for (const n of ["prod", "idx", "outer", "inner"]) {
    assert(!labels.includes(n), `B-6: other loop name '${n}' absent; got ${JSON.stringify(labels)}`);
  }
}

function assertCompletionTemplateBodySuppressed(graph) {
  const source = fs.readFileSync(TPL_LOOPS_WXML, "utf8");
  const lines = source.split("\n");
  const i = lines.findIndex((l) => l.includes("{{row.label}}"));
  assert(i >= 0, "B-7 setup: tpl-loops {{row.label}} line");
  const ch = lines[i].indexOf("{{row.label}}") + 2;
  const items = getCompletions({ graph, documentPath: TPL_LOOPS_WXML, position: { line: i, character: ch }, sourceText: source, extensionRoot: ROOT });
  assert(items.length === 0, `B-7: completion inside <template name> body must stay suppressed; got ${items.length} items`);
}

// Phase 3 v2-C — cursor-scope wx:for diagnostics ---------------------------

function scopeLeakWarnings(graph) {
  const diagnostics = getDiagnostics({ graph, documentPath: SCOPE_LEAK_WXML, extensionRoot: ROOT });
  return diagnostics.filter((d) => d.code === "missing-expression-ref");
}

// E-1..E-6: exactly the three out-of-loop references warn; in-loop, nested,
// iterable-exclusion, and block-loop references stay clean.
function assertScopeLeakWarnsOnlyOutOfLoop(graph) {
  const warns = scopeLeakWarnings(graph);
  const byLine = warns.map((d) => d.range.start.line).sort((a, b) => a - b);
  assertDeepEqual(byLine, [1, 7, 10], "v2-C: missing-expression-ref only on out-of-loop refs (lines 1,7,10)");
  for (const d of warns) {
    assert(d.severity === 2, `v2-C: out-of-loop ref must be Warning(2); got ${d.severity} @${d.range.start.line}`);
    assert(d.source === "wxml-zed", `v2-C: source wxml-zed; got ${d.source}`);
  }
  // Lock which identifier warns on each line (E-2 row, E-4 z, E-6 grp).
  const nameAt = (line) => {
    const d = warns.find((w) => w.range.start.line === line);
    return d ? d.message.match(/^"([^"]+)"/)?.[1] : null;
  };
  assert(nameAt(1) === "row", `E-2: line 1 must warn on 'row'; got ${nameAt(1)}`);
  assert(nameAt(7) === "z", `E-4: line 7 must warn on 'z'; got ${nameAt(7)}`);
  assert(nameAt(10) === "grp", `E-6: line 10 must warn on 'grp'; got ${nameAt(10)}`);
}

// E-1/E-3/E-5/E-6: no warning on any in-scope line (in-loop, nested body,
// inner iterable resolving the outer binding, block-loop body).
// (E-6 has two halves; the block-loop *warns* half is in assertScopeLeakWarnsOnlyOutOfLoop)
function assertScopeLeakCleanInScope(graph) {
  const warns = scopeLeakWarnings(graph);
  for (const line of [0, 4, 9]) {
    const hit = warns.find((d) => d.range.start.line === line);
    assert(!hit, `v2-C: in-scope line ${line} must NOT warn; got ${JSON.stringify(hit)}`);
  }
}

// E-7 (message): the reworded constant names the position.
function assertScopeLeakMessageWording(graph) {
  const warns = scopeLeakWarnings(graph);
  assert(warns.length > 0, "E-7: expected at least one warning to check message");
  assert(
    warns[0].message.includes("the wx:for scope at this position"),
    `E-7: message must name the position; got ${warns[0].message}`,
  );
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
assertGetDiagnosticsUsesFileModelOverride(graph);
// Phase 3 Stage A — Expression reference diagnostic
// Phase 3 Stage B — Data ref definition
assertDataRefDefinitionToData(graph);
assertDataRefDefinitionToProperty(graph);
assertDataRefDefinitionInTemplateReturnsNull(graph);
assertDataRefDefinitionMissingKeyReturnsNull(graph);
assertDefinitionOnWxsExpressionRefExternal(graph);
assertDefinitionOnWxsExpressionRefInline(graph);
assertDefinitionOnWxsExpressionRefInTemplateOnlyFile(graph);
// Phase 3 Stage C — Hover v1
assertHoverOnDataRef(graph);
assertHoverOnPropertyRef(graph);
assertHoverSourceLabelsDataKind(graph);
assertHoverSourceLabelsInjectorKind(graph);
assertHoverOnMissingDataReturnsNull(graph);
assertHoverOnMemberChainReturnsNull(graph);
assertHoverInTemplateDefinitionReturnsNull(graph);
assertHoverOnWxsExpressionRef(graph);
assertHoverOnInlineWxsExpressionRef(graph);
assertHoverOnExternalWxsDeclaration(graph);
assertHoverOnInlineWxsDeclaration(graph);
assertHoverInsideWxsBodyReturnsNull(graph);
assertHoverOnPageMethod(graph);
assertHoverOnComponentMethod(graph);
assertHoverOnDynamicHandlerReturnsNull(graph);
assertHoverOnCustomComponent(graph);
assertHoverInsideComponentChildrenReturnsNull(graph);
assertHoverPastTagNameRangeReturnsNull(graph);
assertHoverComponentLegacyGraphDegradesGracefully(graph);
assertHoverInWhitespaceReturnsNull(graph);
assertHoverInsideImportReturnsNull(graph);
assertHoverWxsLegacyGraphDegradesGracefully(graph);
assertHoverOnWxsExpressionRefInTemplateOnlyFile(graph);
assertHoverOnUnresolvedExternalWxsDeclReturnsNull(graph);
assertHoverOnUnresolvedExternalWxsExprRefReturnsNull(graph);
// Phase 3 Stage B — Data ref completion
assertDataRefCompletionMatchesData(graph);
assertDataRefCompletionMatchesProperty(graph);
assertDataRefCompletionSuppressedAtMemberAccess(graph);
assertDataRefCompletionSuppressedInObjectLiteral(graph);
assertDataRefCompletionIncludesWxsModule(graph);
assertDataRefCompletionSuppressedInTemplateDefinition(graph);
assertDataRefCompletionTemplateScannerHardenedCases(graph);
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
assertCrossBindingT1BuiltinTag(graph);
assertCrossBindingT2ReservedWxIf(graph);
assertCrossBindingT3ReservedDataPrefix(graph);
assertCrossBindingT4ReservedGenericPrefix(graph);
assertCrossBindingT5DeclaredProp(graph);
assertCrossBindingT6ChildLacksProp(graph);
assertCrossBindingT7ChildNoScript(graph);
assertCrossBindingT8aStaticHitWinsOverDynamic(graph);
assertCrossBindingT8bDynamicChildLacksProp(graph);
assertCrossBindingT8cDataSpreadStaticHit(graph);
assertCrossBindingT9InTemplateDefSkipped(graph);
assertCrossBindingT10LookupByAttributeName(graph);
assertCrossBindingT11MultiAttrIndependent(graph);
assertCrossBindingT12EventBindingNotAffected(graph);
assertDynPageT13ParentDynamicBlocksAll(graph);
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

// Phase 3 Stage D — wx:for scope hover
assertHoverOnWxForDefaultItem(graph);
assertHoverOnReferenceOutsideLoopReturnsNull(graph);
assertHoverOnWxForMemberChainReturnsNull(graph);
assertHoverOnExplicitWxForItem(graph);
assertHoverOnExplicitWxForIndex(graph);
assertHoverNestedShadowing(graph);
assertHoverIterableExclusion(graph);
assertHoverWxForShadowsData(graph);
assertHoverDataOutsideLoopBody(graph);
assertHoverOnBlockWxForItem(graph);

// Phase 3 Stage E — wx:for binding definition
assertDefinitionExplicitWxForItem(graph);
assertDefinitionExplicitWxForIndex(graph);
assertDefinitionDefaultWxForItem(graph);
assertDefinitionDefaultWxForIndex(graph);
assertDefinitionNestedShadowing(graph);
assertDefinitionWxForShadowsData(graph);
assertDefinitionOutsideLoopFallsThroughToData(graph);
assertDefinitionBlockWxForItem(graph);
assertDefinitionWxForLegacyGraphDegrades(graph);
assertDefinitionWxForExplicitLegacyDegrades(graph);

// Phase 3 Task 4 — Declaration-side hover (HD-1..HD-3)
assertHoverOnWxForItemDeclaration(graph);
assertHoverOnWxForIndexDeclaration(graph);
assertHoverOnIterableValueResolvesData(graph);

// Phase 3 Task 2 — Template-body wx:for definition (T-1..T-11)
assertTplDefExplicitItem(graph);
assertTplDefExplicitIndex(graph);
assertTplDefImplicitItem(graph);
assertTplDefImplicitIndex(graph);
assertTplDefDataRefSuppressed(graph);
assertTplDefCase2NoLeak(graph);

// Phase 3 Task 3 — Template-body wx:for hover (T-2, T-4, T-6, T-8, T-10, T-12, T-13, T-14)
assertTplHoverExplicitItem(graph);
assertTplHoverExplicitIndex(graph);
assertTplHoverImplicitItem(graph);
assertTplHoverImplicitIndex(graph);
assertTplHoverDataRefSuppressed(graph);
assertTplHoverCase2NoLeak(graph);
assertTplHoverDeclItem(graph);
assertTplHoverDeclIndex(graph);
assertTplTemplateBodyDegradesGracefully(graph);

// Phase 3 v2-B — cursor-scoped wx:for completion
assertCompletionOutsideLoop(graph);
assertCompletionDefaultLoopShadowsData(graph);
assertCompletionExplicitLoop(graph);
assertCompletionNestedUnion(graph);
assertCompletionIterableExclusion(graph);
assertCompletionBlockLoop(graph);
assertCompletionTemplateBodySuppressed(graph);

// Phase 3 v2-C — cursor-scoped wx:for diagnostics
assertScopeLeakWarnsOnlyOutOfLoop(graph);
assertScopeLeakCleanInScope(graph);
assertScopeLeakMessageWording(graph);
