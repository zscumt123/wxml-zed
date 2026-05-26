// Pure, dependency-free resolvers over wxForScopes[] + an LSP position.
// Leaf module: imports NOTHING from sibling server/wxml-*.mjs, so both
// wxml-hover.mjs and wxml-language-service.mjs can import from it without
// forming a circular module graph. (containsPosition moved here from
// wxml-language-service.mjs; findMatchingWxForBinding moved here from
// wxml-hover.mjs; findWxForDeclarationAtPosition is new;
// findEnclosingTemplateRange + scopesDeclaredWithin support wx:for resolution
// inside <template name> bodies.
// See docs/superpowers/plans/2026-05-26-wxml-for-definition-parity.md.)

function symbolPointToLsp(point) {
  return { line: point.row, character: point.column };
}

function isPositionAtOrAfter(position, boundary) {
  return (
    position.line > boundary.line ||
    (position.line === boundary.line && position.character >= boundary.character)
  );
}

function isPositionBefore(position, boundary) {
  return (
    position.line < boundary.line ||
    (position.line === boundary.line && position.character < boundary.character)
  );
}

// Half-open containment: [start, end). Range is in symbol-extractor point form
// ({ row, column }); position is in LSP form ({ line, character }).
export function containsPosition(range, position) {
  const start = symbolPointToLsp(range.start);
  const end = symbolPointToLsp(range.end);
  return isPositionAtOrAfter(position, start) && isPositionBefore(position, end);
}

/**
 * Scan wxForScopes in reverse extraction order (innermost-first AND
 * later-source-first for ties) and return the first scope whose itemName
 * or indexName matches the requested name at this cursor position.
 *
 * A scope is "active" when the cursor is inside its scopeRange AND NOT
 * inside its own wxForRange (the iterable-exclusion rule: in
 * <view wx:for="{{item}}" wx:for-item="item">, cursor inside the wx:for
 * value evaluates in the outer scope).
 */
export function findMatchingWxForBinding(scopes, position, name) {
  for (let i = (scopes ?? []).length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!containsPosition(scope.scopeRange, position)) continue;
    if (containsPosition(scope.wxForRange, position)) continue;
    if (name === scope.itemName) return { scope, kind: "item" };
    if (name === scope.indexName) return { scope, kind: "index" };
  }
  return null;
}

// a strictly after b in (row, column) order
function startsAfter(a, b) {
  return a.row > b.row || (a.row === b.row && a.column > b.column);
}

/**
 * Innermost template-definition range containing the position, or null.
 * templateRanges: symbol-extractor ranges ({ start:{row,column}, end:{row,column} }).
 * Template definitions never partially overlap, so the innermost containing one
 * is simply the range whose start point is latest (and two templates can't share
 * a start point). Entries with a missing range are skipped defensively (legacy /
 * hand-built graphs), mirroring the range-presence guards elsewhere.
 */
export function findEnclosingTemplateRange(templateRanges, position) {
  let best = null;
  for (const range of templateRanges ?? []) {
    if (!range || !containsPosition(range, position)) continue;
    if (best === null || startsAfter(range.start, best.start)) best = range;
  }
  return best;
}

/**
 * Scopes whose wx:for DECLARATION (wxForRange start) falls within boundaryRange.
 * Keeps only loops declared inside the enclosing template, so an outer loop that
 * merely encloses the template definition (Case 2) is excluded. Scopes missing
 * wxForRange are skipped defensively (legacy / hand-built graphs).
 */
export function scopesDeclaredWithin(scopes, boundaryRange) {
  return (scopes ?? []).filter((scope) => scope.wxForRange && containsPosition(boundaryRange, {
    line: scope.wxForRange.start.row,
    character: scope.wxForRange.start.column,
  }));
}

/**
 * Declaration-side lookup: return { scope, kind } when the cursor is inside an
 * EXPLICIT wx:for-item / wx:for-index attribute value (itemNameRange /
 * indexNameRange). Implicit bindings have null name ranges, so they never match
 * here — there is no declaration text to put a cursor on.
 */
export function findWxForDeclarationAtPosition(scopes, position) {
  for (let i = (scopes ?? []).length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (scope.itemNameRange && containsPosition(scope.itemNameRange, position)) {
      return { scope, kind: "item" };
    }
    if (scope.indexNameRange && containsPosition(scope.indexNameRange, position)) {
      return { scope, kind: "index" };
    }
  }
  return null;
}
