import path from "node:path";

import {
  findOwnerConfigWithScript,
  findWxmlFileModel,
  isInsideGraphRoot,
  rangeFromSymbolRange,
} from "./wxml-language-service.mjs";

import {
  containsPosition,
  findMatchingWxForBinding,
  findWxForDeclarationAtPosition, // findWxForDeclarationAtPosition: wired into the declaration-side hover branch in Task 4
} from "./wxml-for-scope.mjs";

// NOTE: wxml-hover.mjs ↔ wxml-language-service.mjs is a circular module
// graph (the language-service re-exports getHover from here). It's safe
// today because no imported helper is invoked at module top level — all
// usage is inside getHover's body, which only runs at request time. Do NOT
// invoke imported helpers (findOwnerConfigWithScript, findWxmlFileModel,
// isInsideGraphRoot, rangeFromSymbolRange) at module top level; doing so
// would trigger a TDZ when wxml-language-service.mjs is the entry point.

// Kind labels shown after the em-dash in hover titles. Keyspace mixes two
// conventions:
//   - `data` / `setData` / `injector` / `property` mirror producer-side
//     `dataKey.source` / `propertyKey.source` strings (lookup is direct).
//   - `pageMethod` / `componentMethod` / `customComponent` / `wxsModule` are
//     hover-internal kinds chosen at the matcher site (Tasks 5/6/7).
const HOVER_KIND_LABELS = {
  data: "data",
  setData: "setData",
  injector: "injector",
  property: "property",
  pageMethod: "page method",
  componentMethod: "component method",
  customComponent: "custom component",
  wxsModule: "wxs module",
  wxForItem: "wx:for-item",
  wxForIndex: "wx:for-index",
};

function relativeToGraphRoot(graphPath, graphRoot) {
  // Returns null when graphPath escapes graphRoot — never leak absolute paths.
  if (!isInsideGraphRoot(graphPath, graphRoot)) return null;
  const rel = path.posix.relative(graphRoot, graphPath);
  return rel === "" ? graphPath : rel;
}

/**
 * Build the two-line hover markdown body.
 *
 * Exactly one of `inlineNote` | `arrow` | `sourceLine` must be set (priority is
 * inlineNote > arrow > sourceLine). Used by:
 *   - dataKeys / propertyKeys / methods → `sourceLine` form ("Defined in `path:line`")
 *   - external wxs / custom components   → `arrow` form ("→ `path`")
 *   - inline wxs                         → `inlineNote` form ("inline wxs module in this file")
 *
 * Always returns exactly two text blocks separated by a blank line.
 */
function formatHoverMarkdown({ name, kindLabel, sourcePath, sourceLine, arrow, inlineNote }) {
  const title = `**${name}** — \`${kindLabel}\``;
  let source;
  if (inlineNote) {
    source = inlineNote;
  } else if (arrow) {
    source = `→ \`${sourcePath}\``;
  } else {
    source = `Defined in \`${sourcePath}:${sourceLine}\``;
  }
  return `${title}\n\n${source}`;
}

/**
 * Build an LSP Hover envelope. All call sites in getHover share the same
 * shape: markdown contents + a range pointing at the cursor-target token.
 * `formatArgs` is forwarded to `formatHoverMarkdown` (which enforces
 * exactly-one of inlineNote | arrow | sourceLine).
 */
function makeMarkdownHover(refRange, formatArgs) {
  return {
    contents: {
      kind: "markdown",
      value: formatHoverMarkdown(formatArgs),
    },
    range: rangeFromSymbolRange(refRange),
  };
}

function hoverFromGraphPathLocation({ name, kindLabel, scriptPath, nameRange, graphRoot, refRange }) {
  const rel = relativeToGraphRoot(scriptPath, graphRoot);
  if (!rel) return null;
  return makeMarkdownHover(refRange, {
    name,
    kindLabel,
    sourcePath: rel,
    sourceLine: nameRange.start.row + 1,
  });
}

/**
 * Render a wx:for binding hover. Same-file always — wx:for declarations
 * never cross-file by scope semantics. Source line shape:
 *   ownerTag present + explicit name → `Declared on `<tag>` at line N`
 *   ownerTag null    + explicit name → `Declared in wx:for at line N`
 *   ownerTag present + implicit name → `Declared on `<tag>` at line N` (line from wxForRange)
 *   ownerTag null    + implicit name → `Declared in wx:for at line N`
 */
function makeWxForHover(scope, kind, refRange) {
  const isItem = kind === "item";
  const name = isItem ? scope.itemName : scope.indexName;
  const kindLabel = isItem ? HOVER_KIND_LABELS.wxForItem : HOVER_KIND_LABELS.wxForIndex;
  const explicitNameRange = isItem ? scope.itemNameRange : scope.indexNameRange;
  const lineRange = explicitNameRange ?? scope.wxForRange;
  const lineNo = lineRange.start.row + 1;
  const sourceLine = scope.ownerTag
    ? `Declared on \`<${scope.ownerTag}>\` at line ${lineNo}`
    : `Declared in wx:for at line ${lineNo}`;
  return {
    contents: {
      kind: "markdown",
      value: `**${name}** — \`${kindLabel}\`\n\n${sourceLine}`,
    },
    range: rangeFromSymbolRange(refRange),
  };
}

/**
 * Resolve hover content for a cursor position inside a .wxml file.
 *
 * Pipeline (executed in order; first matching branch returns):
 *   1. Event handler         — AUTHORITATIVE (page/component method).
 *   2. Expression ref        — AUTHORITATIVE (data / setData / injector / property / wxs xref).
 *   3. Component tag         — FALL-THROUGH (custom component path).
 *   4. Wxs module declaration— FALL-THROUGH (external path / inline note).
 *
 * AUTHORITATIVE means: when the cursor IS inside the matcher's narrow range
 * but resolution fails (dynamic handler, missing key, etc.), the branch
 * returns null and does NOT fall through to later branches. This prevents
 * a cursor on a known handler from showing a component-card just because
 * the handler name is unresolved.
 *
 * FALL-THROUGH means: when the cursor is not inside the matcher's narrow
 * range, control flows down to the next branch. When the cursor IS inside
 * and resolution fails, the branch still returns null but the fall-through
 * couldn't reach later branches anyway (no other matcher would fire on the
 * same position).
 *
 * Returns LSP Hover { contents: { kind: "markdown", value }, range } or null.
 */
export function getHover({ graph, documentPath, position, extensionRoot }) {
  if (!position || typeof position.line !== "number" || typeof position.character !== "number") {
    return null;
  }
  const { documentGraphPath, fileModel } = findWxmlFileModel(graph, documentPath, extensionRoot);
  if (!fileModel) return null;

  // eventHandlers[i].nameRange is always populated by shared/wxml-symbol-extractor.mjs:220
  // (no truthy guard needed, unlike branches 3/4).
  const eventHandlerMatch = (fileModel.eventHandlers ?? [])
    .find((entry) => containsPosition(entry.nameRange, position));
  if (eventHandlerMatch) {
    if (eventHandlerMatch.dynamic) return null;
    const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);
    if (!ownerConfig) return null;
    const method = ownerConfig.script.methods.find((m) => m.name === eventHandlerMatch.handler);
    if (!method) return null;
    const kindLabel = ownerConfig.kind === "component"
      ? HOVER_KIND_LABELS.componentMethod
      : HOVER_KIND_LABELS.pageMethod;
    return hoverFromGraphPathLocation({
      name: method.name,
      kindLabel,
      scriptPath: ownerConfig.script.path,
      nameRange: method.nameRange,
      graphRoot: graph.root,
      refRange: eventHandlerMatch.nameRange,
    });
  }

  // 2. Expression ref match — AUTHORITATIVE.
  // expressionRefs[i].range is always populated by shared/wxml-symbol-extractor.mjs:193
  // (no truthy guard needed, unlike branches 3/4).
  const expressionRefMatch = (fileModel.expressionRefs ?? [])
    .find((entry) => containsPosition(entry.range, position));
  if (expressionRefMatch) {
    if (expressionRefMatch.inTemplateDefinition) return null;

    // 2a. wx:for binding lookup — opportunistic, no ownerConfig needed.
    // Per WXML lexical scope semantics, wx:for-item / wx:for-index shadow
    // data / property / wxs of the same name inside the loop body.
    const wxForBinding = findMatchingWxForBinding(
      fileModel.wxForScopes,
      position,
      expressionRefMatch.name,
    );
    if (wxForBinding) {
      return makeWxForHover(wxForBinding.scope, wxForBinding.kind, expressionRefMatch.range);
    }

    // ownerConfig is needed by 2b/2c only — 2d (in-file wxs symbol lookup) reads
    // from fileModel and works even for template-only WXML files (no JS sibling).
    const ownerConfig = findOwnerConfigWithScript(graph, documentGraphPath);

    // 2b. dataKeys lookup → kind label per dataKey.source (requires ownerConfig)
    if (ownerConfig) {
      const dataKey = (ownerConfig.script.dataKeys ?? []).find((k) => k.name === expressionRefMatch.name);
      if (dataKey) {
        // `?? HOVER_KIND_LABELS.data` is a forward-source guard: today dataKey.source ∈
        // {"data","setData","injector"} which are all in HOVER_KIND_LABELS, but a future
        // source added to shared/js-method-extractor.mjs without updating the label table
        // would otherwise render `undefined`. Keep until those two locations are unified.
        const kindLabel = HOVER_KIND_LABELS[dataKey.source] ?? HOVER_KIND_LABELS.data;
        return hoverFromGraphPathLocation({
          name: dataKey.name,
          kindLabel,
          scriptPath: ownerConfig.script.path,
          nameRange: dataKey.nameRange,
          graphRoot: graph.root,
          refRange: expressionRefMatch.range,
        });
      }

      // 2c. propertyKeys lookup → kind label "property" (requires ownerConfig)
      const propKey = (ownerConfig.script.propertyKeys ?? []).find((k) => k.name === expressionRefMatch.name);
      if (propKey) {
        return hoverFromGraphPathLocation({
          name: propKey.name,
          kindLabel: HOVER_KIND_LABELS.property,
          scriptPath: ownerConfig.script.path,
          nameRange: propKey.nameRange,
          graphRoot: graph.root,
          refRange: expressionRefMatch.range,
        });
      }
    }

    // 2d. In-file wxs symbol names → kind label "wxs module" (works without ownerConfig).
    const wxsSymbol = (fileModel.symbols ?? [])
      .find((s) => s.kind === "wxs" && s.name === expressionRefMatch.name);
    if (wxsSymbol) {
      // Distinguish external vs inline by *presence* of a matching dep, NOT by whether
      // it normalizes. A dep with kind+module but no `normalized` is an external wxs
      // we couldn't resolve (e.g. absolute path) — render no hover rather than
      // mislabeling it as inline.
      const wxsDep = (fileModel.dependencies ?? [])
        .find((d) => d.kind === "wxs" && d.module === expressionRefMatch.name);
      if (wxsDep) {
        if (!wxsDep.normalized) return null;
        const rel = relativeToGraphRoot(wxsDep.normalized, graph.root);
        if (!rel) return null;
        return makeMarkdownHover(expressionRefMatch.range, {
          name: expressionRefMatch.name,
          kindLabel: HOVER_KIND_LABELS.wxsModule,
          sourcePath: rel,
          arrow: true,
        });
      }
      // Truly inline wxs: no dependency entry exists for this module name.
      return makeMarkdownHover(expressionRefMatch.range, {
        name: expressionRefMatch.name,
        kindLabel: HOVER_KIND_LABELS.wxsModule,
        inlineNote: "inline wxs module in this file",
      });
    }

    return null;
  }

  // 3. Component tag match — resolve via graph.usingComponents.
  const componentMatch = (fileModel.components ?? [])
    .find((entry) => entry.tagNameRange && containsPosition(entry.tagNameRange, position));
  if (componentMatch) {
    const usingComponent = graph.usingComponents.find((entry) => (
      entry.owner === documentGraphPath &&
      entry.tag === componentMatch.tag &&
      entry.resolved === true &&
      entry.target
    ));
    if (!usingComponent) return null;
    const rel = relativeToGraphRoot(usingComponent.target, graph.root);
    if (!rel) return null;
    return makeMarkdownHover(componentMatch.tagNameRange, {
      name: componentMatch.tag,
      kindLabel: HOVER_KIND_LABELS.customComponent,
      sourcePath: rel,
      arrow: true,
    });
  }

  // 4. Wxs module declaration match.
  const wxsDeclMatch = (fileModel.symbols ?? [])
    .find((s) => s.kind === "wxs" && s.nameRange && containsPosition(s.nameRange, position));
  if (wxsDeclMatch) {
    // Same external-vs-inline discrimination as step 2d: presence of dep ⇒ external;
    // dep without normalized ⇒ unresolvable external ⇒ no hover (don't mislabel inline).
    const wxsDep = (fileModel.dependencies ?? [])
      .find((d) => d.kind === "wxs" && d.module === wxsDeclMatch.name);
    if (wxsDep) {
      if (!wxsDep.normalized) return null;
      const rel = relativeToGraphRoot(wxsDep.normalized, graph.root);
      if (!rel) return null;
      return makeMarkdownHover(wxsDeclMatch.nameRange, {
        name: wxsDeclMatch.name,
        kindLabel: HOVER_KIND_LABELS.wxsModule,
        sourcePath: rel,
        arrow: true,
      });
    }
    return makeMarkdownHover(wxsDeclMatch.nameRange, {
      name: wxsDeclMatch.name,
      kindLabel: HOVER_KIND_LABELS.wxsModule,
      inlineNote: "inline wxs module in this file",
    });
  }

  return null;
}
