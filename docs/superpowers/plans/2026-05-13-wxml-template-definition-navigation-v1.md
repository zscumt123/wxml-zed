# WXML Template Definition Navigation v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add prototype `textDocument/definition` support from static WXML template usages to unique template definitions.

**Architecture:** Keep `server/wxml-lsp.mjs` as the protocol host and graph scheduler. Implement template definition lookup in `server/wxml-language-service.mjs` after component and dependency definition lookup. Use existing graph `references[]` and `symbols[]`; do not change grammar, Tree-sitter queries, or graph extractor schema.

**Tech Stack:** Node.js ESM, dependency-free JSON-RPC/LSP stdio server, existing WXML project graph JSON model, fixture-driven verification scripts, Markdown docs.

---

## File Structure

- Modify `scripts/verify-wxml-language-service.mjs`: add direct service tests for static template definition, precise template range, synthetic non-zero range, dynamic template null, missing template null, duplicate template null, and non-template position null.
- Modify `server/wxml-language-service.mjs`: extend `getDefinition()` with template reference lookup after dependency lookup.
- Modify `scripts/verify-lsp-diagnostics.mjs`: add protocol-level `textDocument/definition` scenario for static template usage with precise target range.
- Modify `README.md`: update capability and scope wording from "template navigation planned" to "static unique template definition navigation supported; dynamic and visibility-rule navigation unsupported."
- No changes to `server/wxml-lsp.mjs`, grammar files, Tree-sitter query files, or graph extractor schema are expected.

## Task 0: Prepare the Implementation Branch

**Files:**
- Verify: working tree state
- Verify: baseline total verification

- [ ] **Step 1: Confirm the working tree is clean**

Run:

```bash
git status --short --branch
```

Expected: current branch is `main` and there are no modified, staged, or untracked files.

- [ ] **Step 2: Create the feature branch**

Run:

```bash
git checkout -b wxml-template-definition-navigation-v1
```

Expected: branch switches to `wxml-template-definition-navigation-v1`.

- [ ] **Step 3: Run baseline verification before code changes**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 with final output:

```text
wxml-zed tree-sitter verification passed
```

## Task 1: Add Direct Language Service Tests for Template Definitions

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`
- Test: `node scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Add precise location assertion helper**

In `scripts/verify-wxml-language-service.mjs`, add this helper after `assertLocationTarget()`:

```javascript
function assertLocation(location, targetPath, expectedRange, label) {
  assert(location, `${label}: expected definition location`);
  assert(location.uri === pathToFileURL(targetPath).href, `${label}: unexpected URI ${JSON.stringify(location)}`);
  assertDeepEqual(location.range, expectedRange, `${label} range`);
}
```

Keep `assertLocationTarget()` unchanged because component and dependency file jumps intentionally use the zero-range convention.

- [ ] **Step 2: Add synthetic graph helpers**

Add these helpers after `graphWithDependency()`:

```javascript
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
```

- [ ] **Step 3: Add static template success test**

Add this function after `assertExternalWxsDefinition(graph)`:

```javascript
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
```

- [ ] **Step 4: Add non-zero template range regression test**

Add this function after `assertStaticTemplateDefinition(graph)`:

```javascript
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
```

- [ ] **Step 5: Add dynamic, missing, and duplicate template negative tests**

Add these functions after `assertTemplateDefinitionUsesSymbolRange(graph)`:

```javascript
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

function assertDuplicateTemplateDefinitionReturnsNull(graph) {
  const testGraphWithReference = graphWithTemplateReference(graph, {
    kind: "template",
    dynamic: false,
    raw: "duplicateTemplate",
    name: "duplicateTemplate",
    range: templateReferenceRange(63),
  });
  const withFirstDefinition = graphWithTemplateSymbol(
    testGraphWithReference,
    "fixtures/miniprogram/templates/common.wxml",
    {
      kind: "template",
      name: "duplicateTemplate",
      range: templateSymbolRange(13, 14),
    },
  );
  const testGraph = graphWithTemplateSymbol(
    withFirstDefinition,
    "fixtures/miniprogram/pages/detail/detail.wxml",
    {
      kind: "template",
      name: "duplicateTemplate",
      range: templateSymbolRange(3, 4),
    },
  );
  const location = getDefinition({
    graph: testGraph,
    documentPath: HOME_WXML,
    position: { line: 63, character: 2 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "duplicate template definition");
}
```

- [ ] **Step 6: Add direct non-template position regression test**

Add this function after `assertDuplicateTemplateDefinitionReturnsNull(graph)`:

```javascript
function assertNonTemplateDefinitionReturnsNull(graph) {
  const location = getDefinition({
    graph,
    documentPath: HOME_WXML,
    position: { line: 3, character: 0 },
    extensionRoot: ROOT,
  });
  assertNullLocation(location, "non-template definition");
}
```

This keeps the direct language-service coverage aligned with the design requirement that positions outside component, dependency, and template ranges return `null`.

- [ ] **Step 7: Call the new tests**

At the bottom of `scripts/verify-wxml-language-service.mjs`, call the new assertions immediately after `assertExternalWxsDefinition(graph)`:

```javascript
assertStaticTemplateDefinition(graph);
assertTemplateDefinitionUsesSymbolRange(graph);
assertDynamicTemplateDefinitionReturnsNull(graph);
assertMissingTemplateDefinitionReturnsNull(graph);
assertDuplicateTemplateDefinitionReturnsNull(graph);
assertNonTemplateDefinitionReturnsNull(graph);
```

- [ ] **Step 8: Run the direct service verification and confirm red failure**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: FAIL. The first valid failure should be for `static template definition: expected definition location`, because `getDefinition()` does not yet inspect `fileModel.references`.

- [ ] **Step 9: Keep the failing direct service test changes uncommitted**

Do not commit the red test-only state. Leave the modified `scripts/verify-wxml-language-service.mjs` in the working tree and continue directly to Task 2 so the next commit contains both the failing tests and the implementation that makes them pass.

## Task 2: Implement Template Definition Lookup in the Language Service

**Files:**
- Modify: `server/wxml-language-service.mjs`
- Test: `node scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Add exact-range location helper**

In `server/wxml-language-service.mjs`, add this helper after `locationForGraphPath()`:

```javascript
function locationForGraphPathWithRange(graphPath, range, extensionRoot) {
  return {
    uri: pathToFileURL(absolutePathForGraphPath(graphPath, extensionRoot)).href,
    range: rangeFromSymbolRange(range),
  };
}
```

Keep `locationForGraphPath()` unchanged for component and dependency file jumps.

- [ ] **Step 2: Add template target lookup helpers**

Add these helpers after `dependencyDefinitionForPosition()`:

```javascript
function templateDefinitionsForName(graph, name) {
  const matches = [];
  for (const fileModel of graph.wxml) {
    for (const symbol of fileModel.symbols) {
      if (symbol.kind === "template" && symbol.name === name) {
        matches.push({ fileModel, symbol });
      }
    }
  }
  return matches;
}

function templateDefinitionForPosition({ graph, fileModel, position, extensionRoot }) {
  const reference = fileModel.references.find((entry) => (
    entry.kind === "template" &&
    entry.dynamic === false &&
    typeof entry.name === "string" &&
    entry.name.length > 0 &&
    containsPosition(entry.range, position)
  ));
  if (!reference) {
    return null;
  }

  const matches = templateDefinitionsForName(graph, reference.name);
  if (matches.length !== 1) {
    return null;
  }

  const match = matches[0];
  return locationForGraphPathWithRange(match.fileModel.path, match.symbol.range, extensionRoot);
}
```

- [ ] **Step 3: Call template lookup after dependency lookup**

In `getDefinition()`, replace the final return:

```javascript
  return dependencyDefinitionForPosition({
    graph,
    documentGraphPath,
    fileModel,
    position,
    extensionRoot,
  });
```

With:

```javascript
  const dependencyDefinition = dependencyDefinitionForPosition({
    graph,
    documentGraphPath,
    fileModel,
    position,
    extensionRoot,
  });
  if (dependencyDefinition) {
    return dependencyDefinition;
  }

  return templateDefinitionForPosition({
    graph,
    fileModel,
    position,
    extensionRoot,
  });
```

- [ ] **Step 4: Run direct service verification**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: PASS with exit code 0. Tree-sitter parser-directory warnings are acceptable if the process exits 0.

- [ ] **Step 5: Run syntax checks**

Run:

```bash
node --check server/wxml-language-service.mjs
node --check scripts/verify-wxml-language-service.mjs
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the implementation and direct service tests**

```bash
git add server/wxml-language-service.mjs scripts/verify-wxml-language-service.mjs
git commit -m "feat: add wxml template definition navigation"
```

## Task 3: Add Protocol-Level Template Definition Coverage

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`
- Test: `node scripts/verify-lsp-diagnostics.mjs`

- [ ] **Step 1: Add precise definition assertion helper**

In `scripts/verify-lsp-diagnostics.mjs`, add this helper after `assertLocationTarget(result, targetPath)`:

```javascript
function assertLocation(result, targetPath, expectedRange, label) {
  assert(result, `${label}: expected definition location`);
  assert(!Array.isArray(result), `${label}: expected single Location, got array ${JSON.stringify(result)}`);
  assert(result.uri === pathToFileURL(targetPath).href, `${label}: unexpected URI ${JSON.stringify(result)}`);
  assertDeepEqual(result.range, expectedRange, `${label} range`);
}
```

Keep `assertLocationTarget()` unchanged for zero-range file jumps.

- [ ] **Step 2: Add protocol scenario**

Add this function after `testExternalWxsDefinition()`:

```javascript
async function testStaticTemplateDefinition() {
  await withClient({ rootPath: ROOT }, async (client) => {
    const uri = client.openDocument(HOME_WXML);
    await client.waitForDiagnostics(uri, (items) => items.length === 1, "home diagnostics before template definition");
    const result = await client.definition(HOME_WXML, { line: 5, character: 4 });
    assertLocation(
      result,
      COMMON_WXML,
      { start: { line: 0, character: 0 }, end: { line: 4, character: 11 } },
      "static template definition",
    );
  });
}
```

- [ ] **Step 3: Add protocol scenario to runner list**

In the `scenarios` array, add this entry immediately after `["external wxs definition", testExternalWxsDefinition]`:

```javascript
["static template definition", testStaticTemplateDefinition],
```

- [ ] **Step 4: Run protocol verification**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: PASS with exit code 0 and a log line:

```text
[verify-lsp-diagnostics] static template definition
```

- [ ] **Step 5: Run syntax check**

Run:

```bash
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: exit code 0.

- [ ] **Step 6: Commit protocol coverage**

```bash
git add scripts/verify-lsp-diagnostics.mjs
git commit -m "test: cover wxml template definitions over lsp"
```

## Task 4: Update README Scope

**Files:**
- Modify: `README.md`
- Test: README wording checks

- [ ] **Step 1: Update feature matrix**

In `README.md`, replace this feature row:

```markdown
| Prototype go-to-definition for local WXML components, import/include dependencies, and external WXS files | Yes |
```

With:

```markdown
| Prototype go-to-definition for local WXML components, import/include dependencies, external WXS files, and static templates | Yes |
```

Then replace this planned row:

```markdown
| Template, npm/plugin component, and full component resolution navigation | Planned |
```

With:

```markdown
| Dynamic template, template visibility-rule, npm/plugin component, and full component resolution navigation | Planned |
```

- [ ] **Step 2: Update verification script description**

In the paragraph describing `scripts/verify-tree-sitter.sh`, replace:

```markdown
diagnostics, go-to-definition for resolved local components plus WXML
import/include and external WXS dependencies, and flat document symbols for WXML
declaration/dependency entries.
```

With:

```markdown
diagnostics, go-to-definition for resolved local components, WXML
import/include dependencies, external WXS dependencies, and static template
definitions, plus flat document symbols for WXML declaration/dependency entries.
```

- [ ] **Step 3: Update Scope section**

In the Scope section, replace:

```markdown
component tags, go-to-definition for WXML import/include and external WXS file
dependencies, and flat document symbols for WXML declaration/dependency entries.
It intentionally does not provide symbol indexing, template navigation,
```

With:

```markdown
component tags, go-to-definition for WXML import/include and external WXS file
dependencies, go-to-definition for static template usages with unique matching
definitions, and flat document symbols for WXML declaration/dependency entries.
It intentionally does not provide symbol indexing, dynamic template navigation,
template visibility-rule navigation,
```

- [ ] **Step 4: Update LSP host paragraph**

In the paragraph beginning with `` `server/wxml-lsp.mjs` is a minimal stdio LSP prototype``, replace:

```markdown
WXS declarations to their target `.wxs` files. It also returns a flat
document-symbol list for WXML declaration/dependency entries such as template
definitions, WXS modules, imports, and includes.
```

With:

```markdown
WXS declarations to their target `.wxs` files, and from static template usages
to unique matching template definitions. It also returns a flat document-symbol
list for WXML declaration/dependency entries such as template definitions, WXS
modules, imports, and includes.
```

Then replace:

```markdown
`include`, and external `wxs` declarations to their target files, and returns
document symbols for those dependency entries.
```

With:

```markdown
`include`, and external `wxs` declarations to their target files, resolves the
static `loadingRow` template usage to `templates/common.wxml`, and returns
document symbols for those dependency entries.
```

Finally replace:

```markdown
template navigation, npm/plugin component navigation, or `componentGenerics`
```

With:

```markdown
dynamic template navigation, template visibility-rule navigation, npm/plugin
component navigation, or `componentGenerics`
```

- [ ] **Step 5: Check README wording**

Run:

```bash
rg -n 'static template|dynamic template|template visibility-rule|Prototype go-to-definition' README.md
rg -n 'Template, npm/plugin component|template navigation, npm/plugin component' README.md
```

Expected: the first command finds the new supported and unsupported wording. The second command exits 1 with no matches, proving the stale broad template wording was removed.

- [ ] **Step 6: Commit README update**

```bash
git add README.md
git commit -m "docs: document wxml template definitions"
```

## Task 5: Final Verification and Review

**Files:**
- Verify: `server/wxml-language-service.mjs`
- Verify: `server/wxml-lsp.mjs`
- Verify: `scripts/verify-wxml-language-service.mjs`
- Verify: `scripts/verify-lsp-diagnostics.mjs`
- Verify: `README.md`

- [ ] **Step 1: Run direct service verification**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: exit code 0.

- [ ] **Step 2: Run protocol verification**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: exit code 0.

- [ ] **Step 3: Run syntax checks**

Run:

```bash
node --check server/wxml-language-service.mjs
node --check server/wxml-lsp.mjs
node --check scripts/verify-wxml-language-service.mjs
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: all commands exit 0.

- [ ] **Step 4: Run total verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 with final output:

```text
wxml-zed tree-sitter verification passed
```

- [ ] **Step 5: Check boundary discipline**

Run:

```bash
rg -n "templateDefinitionForPosition|templateDefinitionsForName|locationForGraphPathWithRange" server/wxml-language-service.mjs
rg -n "templateDefinitionForPosition|templateDefinitionsForName|locationForGraphPathWithRange" server/wxml-lsp.mjs
```

Expected: first command finds the template navigation helpers in `server/wxml-language-service.mjs`; second command exits 1 with no matches because the LSP host must not contain template navigation business logic.

- [ ] **Step 6: Review branch diff**

Run:

```bash
git diff --stat main..HEAD
git diff --check main..HEAD
```

Expected: implementation diff is limited to the planned files, and `git diff --check` emits no whitespace errors.

- [ ] **Step 7: Request code review before merge**

Use `superpowers:requesting-code-review` before merging implementation back to `main`.

Review context:

```text
Description: Added static WXML template usage go-to-definition through the existing language-service boundary.
Requirements: Preserve component and dependency definition behavior; keep template logic out of server/wxml-lsp.mjs; dynamic template references return null; missing and duplicate template definitions return null; returned template definition range must use the template symbol range, not zero range.
Base: main at the start of the implementation branch.
Head: current feature branch.
```

Fix any Critical or Important findings before merge.
