#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function loadGraph() {
  const output = execFileSync(process.execPath, [GRAPH_EXTRACTOR, MINIPROGRAM_ROOT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: process.env.WXML_ZED_HOME || "/private/tmp",
      npm_config_cache: process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache || "/private/tmp/npm-cache",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output);
}

function assertDeepEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `${label}: expected ${expectedJson}, got ${actualJson}`);
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

const graph = loadGraph();
assertMissingCardDiagnostic(graph);
assertShopListDiagnosticsClean(graph);
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
