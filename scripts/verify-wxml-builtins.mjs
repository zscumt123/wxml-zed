#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_TAG_NAMES } from "../shared/wxml-builtins.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HIGHLIGHTS = path.join(ROOT, "languages/wxml/highlights.scm");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function highlightBuiltinTags(source) {
  const anyOfStart = source.indexOf("(#any-of? @tag.builtin");
  assert(anyOfStart !== -1, "Missing @tag.builtin #any-of? predicate");

  const tail = source.slice(anyOfStart);
  const end = tail.indexOf(")");
  assert(end !== -1, "Unterminated @tag.builtin #any-of? predicate");

  const predicate = tail.slice(0, end);
  return [...predicate.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

const source = fs.readFileSync(HIGHLIGHTS, "utf8");
const highlightTags = highlightBuiltinTags(source);

const expected = [...BUILTIN_TAG_NAMES].sort();
const actual = [...highlightTags].sort();

assert(
  JSON.stringify(actual) === JSON.stringify(expected),
  `Built-in tag drift between shared JS list and highlights.scm\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`,
);
