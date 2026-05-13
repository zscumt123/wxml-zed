import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WARNING = 2;
const DOCUMENT_SYMBOL_KIND_FILE = 1;
const DOCUMENT_SYMBOL_KIND_MODULE = 2;
const DOCUMENT_SYMBOL_KIND_FUNCTION = 12;

const ZERO_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

function toPosix(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

export function graphPathForAbsolute(filePath, extensionRoot) {
  return toPosix(path.relative(extensionRoot, path.resolve(filePath)));
}

export function absolutePathForGraphPath(graphPath, extensionRoot) {
  return path.resolve(extensionRoot, graphPath);
}

export function rangeFromSymbolRange(range) {
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

function isPositionBefore(position, boundary) {
  return (
    position.line < boundary.line ||
    (position.line === boundary.line && position.character < boundary.character)
  );
}

function isPositionAtOrAfter(position, boundary) {
  return (
    position.line > boundary.line ||
    (position.line === boundary.line && position.character >= boundary.character)
  );
}

function symbolPointToLsp(point) {
  return {
    line: point.row,
    character: point.column,
  };
}

export function containsPosition(range, position) {
  const start = symbolPointToLsp(range.start);
  const end = symbolPointToLsp(range.end);
  return isPositionAtOrAfter(position, start) && isPositionBefore(position, end);
}

function rangeKey(range) {
  return `${range.start.row}:${range.start.column}-${range.end.row}:${range.end.column}`;
}

function findWxmlFileModel(graph, documentPath, extensionRoot) {
  const documentGraphPath = graphPathForAbsolute(documentPath, extensionRoot);
  const fileModel = graph.wxml.find((entry) => entry.path === documentGraphPath);
  return { documentGraphPath, fileModel };
}

function locationForGraphPath(graphPath, extensionRoot) {
  return {
    uri: pathToFileURL(absolutePathForGraphPath(graphPath, extensionRoot)).href,
    range: ZERO_RANGE,
  };
}

function isInsideGraphRoot(graphPath, graphRoot) {
  const relative = path.posix.relative(graphRoot, graphPath);
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

function hasUnresolvedWxmlDependency(graph, owner, dependency) {
  return graph.unresolved.some((entry) => (
    entry.kind === "wxml-dependency" &&
    entry.owner === owner &&
    entry.target === dependency.normalized
  ));
}

function isKnownWxmlTarget(graph, target) {
  return graph.wxml.some((entry) => entry.path === target);
}

function isExistingWxsTarget(target, extensionRoot) {
  return fs.existsSync(absolutePathForGraphPath(target, extensionRoot));
}

function dependencyTargetForDefinition(graph, owner, dependency, extensionRoot) {
  if (!dependency.normalized) {
    return undefined;
  }
  if (!isInsideGraphRoot(dependency.normalized, graph.root)) {
    return undefined;
  }

  if ((dependency.kind === "import" || dependency.kind === "include") && dependency.normalized.endsWith(".wxml")) {
    if (hasUnresolvedWxmlDependency(graph, owner, dependency)) {
      return undefined;
    }
    return isKnownWxmlTarget(graph, dependency.normalized) ? dependency.normalized : undefined;
  }

  if (dependency.kind === "wxs" && dependency.normalized.endsWith(".wxs")) {
    return isExistingWxsTarget(dependency.normalized, extensionRoot) ? dependency.normalized : undefined;
  }

  return undefined;
}

function dependencyDefinitionForPosition({ graph, documentGraphPath, fileModel, position, extensionRoot }) {
  const dependency = fileModel.dependencies.find((entry) => containsPosition(entry.range, position));
  if (!dependency) {
    return null;
  }

  const target = dependencyTargetForDefinition(graph, documentGraphPath, dependency, extensionRoot);
  if (!target) {
    return null;
  }

  return locationForGraphPath(target, extensionRoot);
}

export function getDiagnostics({ graph, documentPath, extensionRoot }) {
  const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) {
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

export function getDefinition({ graph, documentPath, position, extensionRoot }) {
  if (!position || typeof position.line !== "number" || typeof position.character !== "number") {
    return null;
  }

  const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) {
    return null;
  }

  const component = fileModel.components.find((entry) => containsPosition(entry.range, position));
  if (component) {
    const usingComponent = graph.usingComponents.find((entry) => (
      entry.owner === documentGraphPath &&
      entry.tag === component.tag &&
      entry.resolved === true &&
      entry.target
    ));
    if (usingComponent) {
      return locationForGraphPath(usingComponent.target, extensionRoot);
    }
  }

  return dependencyDefinitionForPosition({
    graph,
    documentGraphPath,
    fileModel,
    position,
    extensionRoot,
  });
}

function documentSymbol(name, kind, detail, range) {
  const lspRange = rangeFromSymbolRange(range);
  return {
    name,
    kind,
    detail,
    range: lspRange,
    selectionRange: lspRange,
  };
}

function symbolNameFromDependency(dependency) {
  return dependency.normalized || dependency.value;
}

export function getDocumentSymbols({ graph, documentPath, extensionRoot }) {
  const { fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) {
    return [];
  }

  const symbols = [];
  const wxsSymbolRanges = new Set();

  for (const symbol of fileModel.symbols) {
    if (symbol.kind === "template") {
      symbols.push(documentSymbol(symbol.name, DOCUMENT_SYMBOL_KIND_FUNCTION, "template", symbol.range));
    }
    if (symbol.kind === "wxs") {
      wxsSymbolRanges.add(rangeKey(symbol.range));
      symbols.push(documentSymbol(symbol.name, DOCUMENT_SYMBOL_KIND_MODULE, "wxs", symbol.range));
    }
  }

  for (const dependency of fileModel.dependencies) {
    if (dependency.kind === "import") {
      symbols.push(documentSymbol(symbolNameFromDependency(dependency), DOCUMENT_SYMBOL_KIND_FILE, "import", dependency.range));
    }
    if (dependency.kind === "include") {
      symbols.push(documentSymbol(symbolNameFromDependency(dependency), DOCUMENT_SYMBOL_KIND_FILE, "include", dependency.range));
    }
    if (dependency.kind === "wxs" && !wxsSymbolRanges.has(rangeKey(dependency.range))) {
      symbols.push(documentSymbol(dependency.module || symbolNameFromDependency(dependency), DOCUMENT_SYMBOL_KIND_MODULE, "wxs external", dependency.range));
    }
  }

  return symbols.sort((left, right) => (
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character
  ));
}
