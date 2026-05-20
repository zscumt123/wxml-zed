// Heuristic: detect expression text shaped like an object literal
// (`{key: ...}` or `key: ...`), as in `<template data="{{message: 'x'}}"/>`.
// Identifiers in property-key position must not be validated against scope.
// False-negatives accepted: values in the literal go unchecked (v1 trade-off).
export function looksLikeObjectLiteralExpression(text) {
  const trimmed = text.trim();
  const m = trimmed.match(/^\{?\s*[A-Za-z_$][A-Za-z0-9_$]*\s*:/u);
  if (!m) return false;
  const colonAt = trimmed.indexOf(":");
  return !trimmed.slice(0, colonAt).includes("?");
}

// Replaces single/double-quoted string contents with spaces of equal length
// so identifier offsets after the string remain stable. Returns null when
// a template literal (backtick) is encountered — those embed arbitrary
// expressions and are conservatively bailed out at v1.
export function stripStringLiterals(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < text.length) {
          out += "  ";
          i += 2;
          continue;
        }
        out += " ";
        i += 1;
      }
      if (i < text.length) {
        out += text[i];
        i += 1;
      }
    } else if (ch === "`") {
      return null;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

const JS_RESERVED_OR_OPERATOR = new Set([
  "true", "false", "null", "undefined",
  "typeof", "instanceof", "in", "of",
  "void", "new", "delete", "this",
]);

// Returns [{name, offset}] for each top-level identifier in `text`.
// "Top-level" means not preceded by `.` (member access). String-literal
// contents are pre-stripped. Object-literal-shaped expressions are
// skipped entirely. Template literals cause an empty return.
export function topLevelIdentifiers(text) {
  if (looksLikeObjectLiteralExpression(text)) return [];
  const stripped = stripStringLiterals(text);
  if (stripped === null) return [];
  const out = [];
  const regex = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/gu;
  let match;
  while ((match = regex.exec(stripped)) !== null) {
    const name = match[1];
    const offset = match.index;
    const prev = offset > 0 ? stripped[offset - 1] : "";
    if (prev === ".") continue;
    if (JS_RESERVED_OR_OPERATOR.has(name)) continue;
    out.push({ name, offset });
  }
  return out;
}
