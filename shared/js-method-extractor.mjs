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
  if (!fn || fn.type !== "identifier") return null;
  if (!FACTORY_NAMES.has(fn.text)) return null;
  return fn.text;
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

export function extractMethods(parser, source) {
  const tree = parser.parse(source);
  const out = [];
  const visit = (node) => {
    if (node.type === "call_expression") {
      const factory = isPageOrComponentCall(node);
      if (factory) {
        const opts = optionsObject(node);
        if (opts) {
          if (factory === "Page") {
            out.push(...methodEntriesFromObject(opts, METHOD_KIND_PAGE));
          } else {
            out.push(...methodEntriesFromObject(opts, METHOD_KIND_COMPONENT_LIFECYCLE));
            const methodsBlock = methodsBlockOf(opts);
            if (methodsBlock) {
              out.push(...methodEntriesFromObject(methodsBlock, METHOD_KIND_COMPONENT_METHOD));
            }
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
  };
  visit(tree.rootNode);
  out.sort((a, b) => {
    const ar = a.range.start, br = b.range.start;
    return (ar.row - br.row) || (ar.column - br.column);
  });
  return out;
}
