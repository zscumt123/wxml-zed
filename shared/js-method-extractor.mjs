const FUNCTION_VALUE_TYPES = new Set(["function_expression", "arrow_function"]);
const FACTORY_NAMES = new Set(["Page", "Component"]);

// Method `kind` field values produced by extractMethods(). Consumers
// (e.g. completion in server/wxml-language-service.mjs) compare against
// these — import the constants rather than retyping the strings.
export const METHOD_KIND_PAGE = "page-method";
export const METHOD_KIND_COMPONENT_LIFECYCLE = "component-lifecycle";
export const METHOD_KIND_COMPONENT_METHOD = "component-method";

function rangeOf(node) {
  return {
    start: { row: node.startPosition.row, column: node.startPosition.column },
    end: { row: node.endPosition.row, column: node.endPosition.column },
  };
}

function firstChildOfType(node, type) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === type) return c;
  }
  return null;
}

function fieldChild(node, fieldName) {
  return node.childForFieldName ? node.childForFieldName(fieldName) : null;
}

function isPageOrComponentCall(callNode) {
  const fn = fieldChild(callNode, "function");
  if (!fn) return null;
  // Bare `Page({...})` / `Component({...})`.
  if (fn.type === "identifier") {
    return FACTORY_NAMES.has(fn.text) ? fn.text : null;
  }
  // Project-wrapped factories: `Fw.Page({...})` / `app.Component({...})` /
  // any member-expression ending in `.Page` or `.Component`. Real WeChat
  // codebases routinely wrap the factory for logging/error handling.
  if (fn.type === "member_expression") {
    const prop = fieldChild(fn, "property");
    if (prop && prop.type === "property_identifier" && FACTORY_NAMES.has(prop.text)) {
      return prop.text;
    }
  }
  return null;
}

function optionsObject(callNode) {
  const args = fieldChild(callNode, "arguments");
  if (!args) return null;
  const first = args.namedChild(0);
  if (!first || first.type !== "object") return null;
  return first;
}

function methodEntriesFromObject(objectNode, kind) {
  const out = [];
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (child.type === "method_definition") {
      const nameNode = firstChildOfType(child, "property_identifier");
      if (!nameNode) continue;
      out.push({
        name: nameNode.text,
        kind,
        range: rangeOf(child),
        nameRange: rangeOf(nameNode),
      });
    } else if (child.type === "pair") {
      const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
      if (!keyNode || keyNode.type !== "property_identifier") continue;
      const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
      if (!valueNode || !FUNCTION_VALUE_TYPES.has(valueNode.type)) continue;
      out.push({
        name: keyNode.text,
        kind,
        range: rangeOf(child),
        nameRange: rangeOf(keyNode),
      });
    }
  }
  return out;
}

function containsSpread(objectNode) {
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    if (objectNode.namedChild(i).type === "spread_element") return true;
  }
  return false;
}

function dynamicFlagsFromProperties(objectNode) {
  let hasDynamicMethods = false;
  let hasDynamicData = false;
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (child.type !== "pair") continue;
    const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
    if (!keyNode || keyNode.type !== "property_identifier") continue;
    const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
    if (!valueNode) continue;

    if (keyNode.text === "behaviors") {
      // behaviors can inject both data and methods — set BOTH flags.
      if (valueNode.type === "array") {
        if (valueNode.namedChildCount > 0) {
          hasDynamicMethods = true;
          hasDynamicData = true;
        }
      } else {
        hasDynamicMethods = true;
        hasDynamicData = true;
      }
    } else if (keyNode.text === "methods") {
      if (valueNode.type !== "object") hasDynamicMethods = true;
    } else if (keyNode.text === "data") {
      if (valueNode.type !== "object") hasDynamicData = true;
    } else if (keyNode.text === "properties") {
      // Component properties contribute to template scope identically to data.
      // Non-object value (identifier, call, etc.) makes the property set
      // unbounded — fold into hasDynamicData.
      if (valueNode.type !== "object") hasDynamicData = true;
    }
  }
  return { hasDynamicMethods, hasDynamicData };
}

function methodsBlockOf(objectNode) {
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (child.type !== "pair") continue;
    const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
    if (!keyNode || keyNode.type !== "property_identifier" || keyNode.text !== "methods") continue;
    const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
    if (valueNode && valueNode.type === "object") return valueNode;
  }
  return null;
}

function dataBlockOf(objectNode) {
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (child.type !== "pair") continue;
    const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
    if (!keyNode || keyNode.type !== "property_identifier" || keyNode.text !== "data") continue;
    const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
    if (valueNode && valueNode.type === "object") return valueNode;
  }
  return null;
}

function propertiesBlockOf(objectNode) {
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (child.type !== "pair") continue;
    const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
    if (!keyNode || keyNode.type !== "property_identifier" || keyNode.text !== "properties") continue;
    const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
    if (valueNode && valueNode.type === "object") return valueNode;
  }
  return null;
}

// Returns every top-level pair in `objectNode` whose value is a function
// expression / arrow function / method-definition shorthand. Used to find
// Page lifecycle handlers and Component legacy lifecycle handlers.
function functionValuedPairs(objectNode) {
  const out = [];
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (child.type === "method_definition") {
      out.push(child);
    } else if (child.type === "pair") {
      const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
      if (valueNode && FUNCTION_VALUE_TYPES.has(valueNode.type)) {
        out.push(valueNode);
      }
    }
  }
  return out;
}

// Returns the inner object node for a named pair (e.g. `lifetimes: { ... }`).
// Returns null if the key is missing or the value isn't an object literal.
function namedObjectBlock(objectNode, blockName) {
  for (let i = 0; i < objectNode.namedChildCount; i++) {
    const child = objectNode.namedChild(i);
    if (child.type !== "pair") continue;
    const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
    if (!keyNode || keyNode.type !== "property_identifier" || keyNode.text !== blockName) continue;
    const valueNode = fieldChild(child, "value") ?? child.namedChild(1);
    if (valueNode && valueNode.type === "object") return valueNode;
  }
  return null;
}

// Collects observer function nodes from `properties: { <name>: { observer: <fn> } }`.
function propertyObservers(propertiesBlockNode) {
  const out = [];
  for (let i = 0; i < propertiesBlockNode.namedChildCount; i++) {
    const propPair = propertiesBlockNode.namedChild(i);
    if (propPair.type !== "pair") continue;
    const descriptor = fieldChild(propPair, "value") ?? propPair.namedChild(1);
    if (!descriptor || descriptor.type !== "object") continue;
    for (let j = 0; j < descriptor.namedChildCount; j++) {
      const field = descriptor.namedChild(j);
      if (field.type === "method_definition") {
        const nameNode = firstChildOfType(field, "property_identifier");
        if (nameNode && nameNode.text === "observer") out.push(field);
      } else if (field.type === "pair") {
        const keyNode = fieldChild(field, "key") ?? firstChildOfType(field, "property_identifier");
        if (!keyNode || keyNode.type !== "property_identifier" || keyNode.text !== "observer") continue;
        const valueNode = fieldChild(field, "value") ?? field.namedChild(1);
        if (valueNode && FUNCTION_VALUE_TYPES.has(valueNode.type)) out.push(valueNode);
      }
    }
  }
  return out;
}

const IDENTIFIER_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function extractDataKeys(dataObjectNode, source) {
  const out = [];
  for (let i = 0; i < dataObjectNode.namedChildCount; i++) {
    const child = dataObjectNode.namedChild(i);
    if (child.type === "pair") {
      const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
      if (!keyNode) continue;
      if (keyNode.type === "property_identifier") {
        out.push({ name: keyNode.text, nameRange: rangeOf(keyNode), source });
      } else if (keyNode.type === "string") {
        // Quoted key (`"foo": 1` / `'foo': 1`). Extract if the inner text
        // is a valid JS identifier — invalid shapes (`"with-dash"`, `"123"`,
        // `""`) cannot be referenced from a WXML expression, so leaving them
        // out doesn't widen the false-positive surface. nameRange points at
        // the inner string_fragment (not the quote chars) so cmd-click lands
        // on the actual identifier text.
        const fragment = firstChildOfType(keyNode, "string_fragment");
        const text = fragment ? fragment.text : "";
        if (IDENTIFIER_SHAPE.test(text)) {
          out.push({ name: text, nameRange: rangeOf(fragment), source });
        }
      }
    } else if (child.type === "shorthand_property_identifier") {
      out.push({ name: child.text, nameRange: rangeOf(child), source });
    }
  }
  return out;
}

// Detects `this.setData(<arg>, ...)` shape and returns the call's first-arg
// node if matched. Returns null otherwise. Note: bare `setData(...)` without
// `this.` is intentionally NOT matched — there's no way to know what
// `setData` refers to without scope tracking, and false positives there
// would expand template scope on unrelated helpers.
function setDataCallArgNode(callNode) {
  const fn = fieldChild(callNode, "function");
  if (!fn || fn.type !== "member_expression") return null;
  const object = fieldChild(fn, "object");
  const property = fieldChild(fn, "property");
  if (!object || object.type !== "this") return null;
  if (!property || property.type !== "property_identifier") return null;
  if (property.text !== "setData") return null;
  const args = fieldChild(callNode, "arguments");
  if (!args || args.namedChildCount === 0) return null;
  return args.namedChild(0);
}

// Given a single `this.setData(<arg>, ...)` call, return { keys, dynamic }.
//   keys     — array of { name, nameRange, source: "setData" } extracted from
//              static identifier/shorthand/quoted-identifier properties.
//   dynamic  — true if any computed key, spread element, or non-object first
//              arg appeared. Tells the caller to force hasDynamicData = true
//              for the whole script (even if we did extract some keys).
function extractSetDataKeysFromCall(callNode) {
  const arg = setDataCallArgNode(callNode);
  if (!arg) return { keys: [], dynamic: false };
  if (arg.type !== "object") {
    // setData(payload) / setData(callExpr()) / setData(arrayLiteral) —
    // first arg is not statically analyzable. Mark dynamic; no keys.
    return { keys: [], dynamic: true };
  }
  const keys = [];
  let dynamic = false;
  for (let i = 0; i < arg.namedChildCount; i++) {
    const child = arg.namedChild(i);
    if (child.type === "spread_element") {
      dynamic = true;
      continue;
    }
    if (child.type === "pair") {
      const keyNode = fieldChild(child, "key") ?? firstChildOfType(child, "property_identifier");
      if (!keyNode) {
        dynamic = true;
        continue;
      }
      if (keyNode.type === "computed_property_name") {
        // setData({ [expr]: value }) — key is computed at runtime.
        dynamic = true;
        continue;
      }
      if (keyNode.type === "property_identifier") {
        keys.push({ name: keyNode.text, nameRange: rangeOf(keyNode), source: "setData" });
      } else if (keyNode.type === "string") {
        const fragment = firstChildOfType(keyNode, "string_fragment");
        const text = fragment ? fragment.text : "";
        if (IDENTIFIER_SHAPE.test(text)) {
          keys.push({ name: text, nameRange: rangeOf(fragment), source: "setData" });
        }
        // Quoted key with non-identifier shape (e.g., "with-dash") is silently
        // skipped: it cannot be referenced from a WXML expression anyway.
      } else {
        // Number-literal key (`{ 0: ... }`) etc. — not template-referenceable.
      }
    } else if (child.type === "shorthand_property_identifier") {
      keys.push({ name: child.text, nameRange: rangeOf(child), source: "setData" });
    }
    // Object methods (`{ foo() {} }`) are intentionally ignored — those don't
    // happen in real setData calls and would just be noise.
  }
  return { keys, dynamic };
}

// Walks call_expression descendants of `funcNode` (a function or method
// definition node), running extractSetDataKeysFromCall on each.
//
// Critical: stops at nested function boundaries that REBIND `this` —
// regular function_expression / function_declaration / method_definition /
// generator_function / generator_function_declaration each get their own
// `this`, so a `this.setData(...)` inside them is NOT a call on the
// component instance and must be ignored. arrow_function
// continues to be walked because arrows inherit `this` lexically; that
// covers the common Promise.then(res => this.setData(...)) /
// setTimeout(() => this.setData(...)) patterns.
//
// Sink is a mutable { keys, dynamic } accumulator passed by the caller —
// we merge into it rather than allocating per-function.
function walkOwnerFunctionForSetData(funcNode, sink) {
  const visit = (node) => {
    // Don't descend into nested non-arrow function bodies. The root
    // funcNode itself is exempt: we always want to enter its body.
    if (node !== funcNode && (
      node.type === "function_expression" ||
      node.type === "function_declaration" ||
      node.type === "method_definition" ||
      node.type === "generator_function" ||
      node.type === "generator_function_declaration"
    )) {
      return;
    }
    if (node.type === "call_expression") {
      const result = extractSetDataKeysFromCall(node);
      if (result.dynamic) sink.dynamic = true;
      for (const key of result.keys) sink.keys.push(key);
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
  };
  visit(funcNode);
}

export function extractMethods(parser, source) {
  const tree = parser.parse(source);
  const methods = [];
  const dataKeys = [];
  const propertyKeys = [];
  let hasDynamicMethods = false;
  let hasDynamicData = false;
  const visit = (node) => {
    if (node.type === "call_expression") {
      const factory = isPageOrComponentCall(node);
      if (factory) {
        const args = fieldChild(node, "arguments");
        const firstArg = args ? args.namedChild(0) : null;
        if (firstArg && firstArg.type !== "object") {
          hasDynamicMethods = true;
          hasDynamicData = true;
        } else if (firstArg) {
          const opts = firstArg;
          if (containsSpread(opts)) {
            hasDynamicMethods = true;
            hasDynamicData = true;
          }
          const flags = dynamicFlagsFromProperties(opts);
          if (flags.hasDynamicMethods) hasDynamicMethods = true;
          if (flags.hasDynamicData) hasDynamicData = true;

          if (factory === "Page") {
            methods.push(...methodEntriesFromObject(opts, METHOD_KIND_PAGE));
          } else {
            methods.push(...methodEntriesFromObject(opts, METHOD_KIND_COMPONENT_LIFECYCLE));
            const methodsBlock = methodsBlockOf(opts);
            if (methodsBlock) {
              if (containsSpread(methodsBlock)) hasDynamicMethods = true;
              methods.push(...methodEntriesFromObject(methodsBlock, METHOD_KIND_COMPONENT_METHOD));
            }
          }

          const dataBlock = dataBlockOf(opts);
          if (dataBlock) {
            if (containsSpread(dataBlock)) hasDynamicData = true;
            dataKeys.push(...extractDataKeys(dataBlock, "data"));
          }

          const propertiesBlock = propertiesBlockOf(opts);
          if (propertiesBlock) {
            if (containsSpread(propertiesBlock)) hasDynamicData = true;
            propertyKeys.push(...extractDataKeys(propertiesBlock, "property"));
          }

          // setData key collection. Sink accumulates across every owner-
          // context function body; merged into dataKeys after the visit.
          const setDataSink = { keys: [], dynamic: false };

          if (factory === "Page") {
            // Page: every top-level function-valued pair is an owner-
            // context function (lifecycle + user-defined methods both live
            // here; there's no separate methods block).
            for (const fn of functionValuedPairs(opts)) {
              walkOwnerFunctionForSetData(fn, setDataSink);
            }
          } else {
            // Component: walk legacy top-level lifecycle + the methods,
            // lifetimes, pageLifetimes, observers blocks + observer functions
            // inside properties descriptors.
            for (const fn of functionValuedPairs(opts)) {
              walkOwnerFunctionForSetData(fn, setDataSink);
            }
            const methodsBlock = methodsBlockOf(opts);
            if (methodsBlock) {
              for (const fn of functionValuedPairs(methodsBlock)) {
                walkOwnerFunctionForSetData(fn, setDataSink);
              }
            }
            for (const blockName of ["lifetimes", "pageLifetimes", "observers"]) {
              const block = namedObjectBlock(opts, blockName);
              if (block) {
                for (const fn of functionValuedPairs(block)) {
                  walkOwnerFunctionForSetData(fn, setDataSink);
                }
              }
            }
            const propertiesBlockForObservers = propertiesBlockOf(opts);
            if (propertiesBlockForObservers) {
              for (const obs of propertyObservers(propertiesBlockForObservers)) {
                walkOwnerFunctionForSetData(obs, setDataSink);
              }
            }
          }

          if (setDataSink.dynamic) hasDynamicData = true;

          // Dedup setData keys against the data block: data-block declaration
          // is more authoritative (has a static default value), so keep it
          // and silently drop the setData copy. Preserves natural reading
          // order: data block first, then setData additions.
          const existingDataNames = new Set(dataKeys.map((k) => k.name));
          for (const key of setDataSink.keys) {
            if (existingDataNames.has(key.name)) continue;
            existingDataNames.add(key.name);
            dataKeys.push(key);
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
  };
  visit(tree.rootNode);
  methods.sort((a, b) => {
    const ar = a.range.start, br = b.range.start;
    return (ar.row - br.row) || (ar.column - br.column);
  });
  return { methods, hasDynamicMethods, dataKeys, propertyKeys, hasDynamicData };
}
