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
