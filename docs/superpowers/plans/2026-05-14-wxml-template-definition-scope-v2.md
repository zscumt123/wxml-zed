# WXML Template Definition Scope v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make static WXML template go-to-definition resolve within the current file plus direct `import` / `include` dependencies instead of requiring graph-wide uniqueness.

**Architecture:** Keep the graph schema, symbol extractor, and LSP host unchanged. Add fixture coverage that puts an unrelated duplicate template into `graph.wxml`, then implement scoped template lookup inside `server/wxml-language-service.mjs` through small file-model helper functions.

**Tech Stack:** Node.js ESM scripts, existing mini program fixtures, existing dependency-free direct language-service and stdio LSP harnesses.

---

## File Structure

- Modify `fixtures/miniprogram/pages/home/home.wxml`: change the existing include target to `../../templates/secondary.wxml`.
- Modify `fixtures/miniprogram/pages/detail/detail.wxml`: import `../../templates/unrelated.wxml` so the unrelated duplicate enters the project graph through another page.
- Create `fixtures/miniprogram/templates/secondary.wxml`: direct dependency fixture without a `loadingRow` definition.
- Create `fixtures/miniprogram/templates/unrelated.wxml`: unrelated graph file with duplicate `loadingRow`.
- Modify `scripts/verify-tree-sitter.sh`: update graph assertions for secondary and unrelated WXML entries and dependencies.
- Modify `scripts/verify-wxml-language-service.mjs`: update include target, add scoped template tests, and preserve existing negative cases.
- Modify `server/wxml-language-service.mjs`: replace graph-wide template lookup with current-file plus de-duplicated direct dependency lookup.
- Modify `scripts/verify-lsp-diagnostics.mjs`: update include target and keep protocol template definition coverage green.
- Modify `README.md`: document direct-scope static template navigation and unsupported recursive/full visibility.
- No changes expected in `server/wxml-lsp.mjs`, grammar files, Tree-sitter query files, or graph schema.

## Task 0: Prepare the Implementation Branch

**Files:**
- Verify: git state
- Verify: baseline total verification

- [ ] **Step 1: Confirm main is clean**

Run:

```bash
git status --short --branch
```

Expected: current branch is `main` and there are no modified, staged, or untracked files.

- [ ] **Step 2: Create the feature branch**

Run:

```bash
git checkout -b wxml-template-definition-scope-v2
```

Expected: branch switches to `wxml-template-definition-scope-v2`.

- [ ] **Step 3: Run baseline verification**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: exit code 0 with final output:

```text
wxml-zed tree-sitter verification passed
```

## Task 1: Add Template Scope Fixtures and Graph Coverage

**Files:**
- Modify: `fixtures/miniprogram/pages/home/home.wxml`
- Modify: `fixtures/miniprogram/pages/detail/detail.wxml`
- Create: `fixtures/miniprogram/templates/secondary.wxml`
- Create: `fixtures/miniprogram/templates/unrelated.wxml`
- Modify: `scripts/verify-tree-sitter.sh`
- Test: `scripts/verify-tree-sitter.sh`

- [ ] **Step 1: Replace the home include target**

In `fixtures/miniprogram/pages/home/home.wxml`, replace:

```xml
<include src="../../shared/header.wxml" />
```

With:

```xml
<include src="../../templates/secondary.wxml" />
```

Expected surrounding block:

```xml
<import src="../../templates/common.wxml" />
<include src="../../templates/secondary.wxml" />
<wxs module="format" src="../../utils/format.wxs" />
```

Do not insert or remove lines in `home.wxml`; existing line-sensitive diagnostics and definitions must keep their current line numbers.

- [ ] **Step 2: Import unrelated template fixture from the detail page**

Replace `fixtures/miniprogram/pages/detail/detail.wxml` with:

```xml
<import src="../../templates/unrelated.wxml" />

<view class="detail">
  <text>{{title}}</text>
</view>
```

This makes `templates/unrelated.wxml` part of `graph.wxml` without making it a direct dependency of `pages/home/home.wxml`.

- [ ] **Step 3: Add secondary template fixture**

Create `fixtures/miniprogram/templates/secondary.wxml`:

```xml
<template name="secondaryRow">
  <view class="secondary-row">
    <text>{{label}}</text>
  </view>
</template>
```

This file is a direct include dependency of `home.wxml` but deliberately does not define `loadingRow`.

- [ ] **Step 4: Add unrelated duplicate template fixture**

Create `fixtures/miniprogram/templates/unrelated.wxml`:

```xml
<template name="loadingRow">
  <view class="unrelated-loading-row">
    <text>{{message}}</text>
  </view>
</template>
```

This file intentionally duplicates `loadingRow` outside `home.wxml` direct visibility.

- [ ] **Step 5: Update graph WXML assertions**

In `scripts/verify-tree-sitter.sh`, inside the project graph `node -e` block, replace:

```javascript
wxml("fixtures/miniprogram/shared/header.wxml");
wxml("fixtures/miniprogram/templates/common.wxml");
```

With:

```javascript
wxml("fixtures/miniprogram/templates/common.wxml");
wxml("fixtures/miniprogram/templates/secondary.wxml");
wxml("fixtures/miniprogram/templates/unrelated.wxml");
```

- [ ] **Step 6: Update graph dependency assertions**

In the same `node -e` block, after:

```javascript
const home = wxml("fixtures/miniprogram/pages/home/home.wxml");
```

Add:

```javascript
const detail = wxml("fixtures/miniprogram/pages/detail/detail.wxml");
```

Then replace:

```javascript
assert(hasDependency(home, "include", "fixtures/miniprogram/shared/header.wxml"), "Missing shared header include dependency");
```

With:

```javascript
assert(hasDependency(home, "include", "fixtures/miniprogram/templates/secondary.wxml"), "Missing secondary template include dependency");
assert(hasDependency(detail, "import", "fixtures/miniprogram/templates/unrelated.wxml"), "Missing unrelated template import dependency");
```

- [ ] **Step 7: Run total verification and confirm template-definition failure**

Run:

```bash
scripts/verify-tree-sitter.sh
```

Expected: FAIL during direct language-service or protocol-level static template definition verification. A valid failure mentions `static template definition` returning `null`, because v1 graph-wide lookup now sees both `templates/common.wxml` and `templates/unrelated.wxml` defining `loadingRow`.

Do not commit this red state.

## Task 2: Add Direct Language-Service Scope Tests

**Files:**
- Modify: `scripts/verify-wxml-language-service.mjs`
- Test: `node scripts/verify-wxml-language-service.mjs`

- [ ] **Step 1: Replace the include target constant**

In `scripts/verify-wxml-language-service.mjs`, replace:

```javascript
const HEADER_WXML = path.join(MINIPROGRAM_ROOT, "shared/header.wxml");
```

With:

```javascript
const SECONDARY_WXML = path.join(MINIPROGRAM_ROOT, "templates/secondary.wxml");
```

- [ ] **Step 2: Update include definition expectation**

In `assertIncludeDefinition(graph)`, replace:

```javascript
  assertLocationTarget(location, HEADER_WXML, "include definition");
```

With:

```javascript
  assertLocationTarget(location, SECONDARY_WXML, "include definition");
```

- [ ] **Step 3: Update direct document-symbol expectation**

In `assertHomeDocumentSymbols(graph)`, replace:

```javascript
      ["fixtures/miniprogram/shared/header.wxml", 1, "include"],
```

With:

```javascript
      ["fixtures/miniprogram/templates/secondary.wxml", 1, "include"],
```

Then replace the include symbol range:

```javascript
      { start: { line: 1, character: 0 }, end: { line: 1, character: 42 } },
```

With:

```javascript
      { start: { line: 1, character: 0 }, end: { line: 1, character: 48 } },
```

- [ ] **Step 4: Add a helper for appending duplicate dependencies**

After `function graphWithDependency(graph, dependency) { ... }`, add:

```javascript
function graphWithHomeDependency(graph, dependency) {
  const nextGraph = cloneGraph(graph);
  homeFileModel(nextGraph).dependencies.push(dependency);
  return nextGraph;
}
```

This helper is intentionally separate from `graphWithDependency()` so later tests read as template-visibility cases, not dependency-definition cases.

- [ ] **Step 5: Add local shadowing test**

After `assertTemplateDefinitionUsesSymbolRange(graph)`, add:

```javascript
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
```

- [ ] **Step 6: Replace duplicate-template negative test**

Replace the existing `assertDuplicateTemplateDefinitionReturnsNull(graph)` function with:

```javascript
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
```

- [ ] **Step 7: Add direct dependency duplicate test**

After `assertDuplicateLocalTemplateDefinitionsReturnNull(graph)`, add:

```javascript
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
```

- [ ] **Step 8: Add outside-visible-scope test**

After `assertDuplicateDirectDependencyTemplateDefinitionsReturnNull(graph)`, add:

```javascript
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
```

- [ ] **Step 9: Add dependency de-duplication test**

After `assertTemplateOutsideDirectDependenciesReturnsNull(graph)`, add:

```javascript
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
```

- [ ] **Step 10: Update direct test calls**

At the bottom of `scripts/verify-wxml-language-service.mjs`, replace:

```javascript
assertDuplicateTemplateDefinitionReturnsNull(graph);
```

With:

```javascript
assertLocalTemplateDefinitionShadowsDependency(graph);
assertDuplicateLocalTemplateDefinitionsReturnNull(graph);
assertDuplicateDirectDependencyTemplateDefinitionsReturnNull(graph);
assertTemplateOutsideDirectDependenciesReturnsNull(graph);
assertDuplicateDependencyEntriesDoNotDuplicateTemplateDefinitions(graph);
```

- [ ] **Step 11: Run direct service verification and confirm template-scope failures**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: FAIL before implementation. Valid first failures include:

- `static template definition` returning `null` because `loadingRow` is no longer graph-wide unique;
- `local template definition shadows dependency` returning `null`;
- `template outside direct dependencies` returning a non-null location.

Do not commit this red state. The synthetic duplicate dependency range must stay
off line 67 so this test exercises template visibility de-duplication instead
of dependency-definition precedence.

## Task 3: Implement Scoped Template Definition Lookup

**Files:**
- Modify: `server/wxml-language-service.mjs`
- Test: `node scripts/verify-wxml-language-service.mjs`
- Test: `node --check server/wxml-language-service.mjs`

- [ ] **Step 1: Replace graph-wide template lookup helper**

In `server/wxml-language-service.mjs`, replace the existing `templateDefinitionsForName(graph, name)` function with:

```javascript
function templateDefinitionsInFile(fileModel, name) {
  return fileModel.symbols
    .filter((symbol) => symbol.kind === "template" && symbol.name === name)
    .map((symbol) => ({ fileModel, symbol }));
}

function directTemplateDependencyFiles(graph, fileModel) {
  const filesByPath = new Map(graph.wxml.map((entry) => [entry.path, entry]));
  const seen = new Set();
  const files = [];

  for (const dependency of fileModel.dependencies) {
    if (dependency.kind !== "import" && dependency.kind !== "include") continue;
    if (typeof dependency.normalized !== "string") continue;
    if (seen.has(dependency.normalized)) continue;

    const dependencyFile = filesByPath.get(dependency.normalized);
    if (!dependencyFile) continue;

    seen.add(dependency.normalized);
    files.push(dependencyFile);
  }

  return files;
}

function visibleTemplateDefinitions(graph, fileModel, name) {
  const localMatches = templateDefinitionsInFile(fileModel, name);
  if (localMatches.length > 0) {
    return localMatches;
  }

  return directTemplateDependencyFiles(graph, fileModel)
    .flatMap((dependencyFile) => templateDefinitionsInFile(dependencyFile, name));
}
```

- [ ] **Step 2: Use visible template definitions**

In `templateDefinitionForPosition({ graph, fileModel, position, extensionRoot })`, replace:

```javascript
  const matches = templateDefinitionsForName(graph, reference.name);
```

With:

```javascript
  const matches = visibleTemplateDefinitions(graph, fileModel, reference.name);
```

- [ ] **Step 3: Run direct service verification**

Run:

```bash
node scripts/verify-wxml-language-service.mjs
```

Expected: exit code 0. Tree-sitter parser-directory warnings are acceptable if the process exits 0.

- [ ] **Step 4: Run syntax check**

Run:

```bash
node --check server/wxml-language-service.mjs
```

Expected: exit code 0.

- [ ] **Step 5: Commit scoped lookup and direct tests**

This is a direct-service checkpoint commit. It is not expected to pass full
`scripts/verify-tree-sitter.sh` until Task 4 updates protocol-level fixture
expectations for the same include-target change. The branch tip must pass full
verification before review or merge.

Run:

```bash
git add fixtures/miniprogram scripts/verify-tree-sitter.sh scripts/verify-wxml-language-service.mjs server/wxml-language-service.mjs
git commit -m "feat: scope template definitions to visible files"
```

## Task 4: Update Protocol Coverage and README

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`
- Modify: `README.md`
- Test: `node scripts/verify-lsp-diagnostics.mjs`
- Test: README wording checks

- [ ] **Step 1: Replace the protocol include target constant**

In `scripts/verify-lsp-diagnostics.mjs`, replace:

```javascript
const HEADER_WXML = path.join(MINIPROGRAM_ROOT, "shared/header.wxml");
```

With:

```javascript
const SECONDARY_WXML = path.join(MINIPROGRAM_ROOT, "templates/secondary.wxml");
```

- [ ] **Step 2: Update protocol include definition expectation**

In `testIncludeDefinition()`, replace:

```javascript
    assertLocationTarget(result, HEADER_WXML);
```

With:

```javascript
    assertLocationTarget(result, SECONDARY_WXML);
```

- [ ] **Step 3: Update protocol document-symbol expectation**

In `assertHomeDocumentSymbols(symbols)`, replace:

```javascript
      ["fixtures/miniprogram/shared/header.wxml", 1, "include"],
```

With:

```javascript
      ["fixtures/miniprogram/templates/secondary.wxml", 1, "include"],
```

Then replace the include symbol range:

```javascript
      { start: { line: 1, character: 0 }, end: { line: 1, character: 42 } },
```

With:

```javascript
      { start: { line: 1, character: 0 }, end: { line: 1, character: 48 } },
```

- [ ] **Step 4: Run protocol verification**

Run:

```bash
node scripts/verify-lsp-diagnostics.mjs
```

Expected: exit code 0 and stderr includes:

```text
[verify-lsp-diagnostics] static template definition
```

This proves the unrelated graph-wide `loadingRow` duplicate does not break protocol-level template definition.

- [ ] **Step 5: Update README feature table scope**

In `README.md`, replace:

```markdown
| Prototype go-to-definition for local WXML components, import/include dependencies, external WXS files, and static templates | Yes |
```

With:

```markdown
| Prototype go-to-definition for local WXML components, import/include dependencies, external WXS files, and direct-scope static templates | Yes |
```

Then replace:

```markdown
| Dynamic template, template visibility-rule, npm/plugin component, and full component resolution navigation | Planned |
```

With:

```markdown
| Dynamic template, recursive/full template visibility, npm/plugin component, and full component resolution navigation | Planned |
```

- [ ] **Step 6: Update README scope paragraph**

In `README.md`, replace:

```markdown
dependencies, go-to-definition for static template usages with unique matching
definitions, and flat document symbols for WXML declaration/dependency entries.
```

With:

```markdown
dependencies, go-to-definition for static template usages within the current
file and direct `import` / `include` dependencies, and flat document symbols for
WXML declaration/dependency entries.
```

Then replace the unsupported scope wording:

```markdown
template visibility-rule navigation,
completion, hover, nested structural document symbols, semantic tokens, code
```

With:

```markdown
recursive/full template visibility,
completion, hover, nested structural document symbols, semantic tokens, code
```

- [ ] **Step 7: Update README LSP behavior paragraph**

In the paragraph beginning `` `server/wxml-lsp.mjs` is a minimal stdio LSP prototype ``, replace:

```markdown
WXS declarations to their target `.wxs` files, and from static template usages
to unique matching template definitions. It also returns a flat document-symbol
list for WXML declaration/dependency entries such as template definitions, WXS
```

With:

```markdown
WXS declarations to their target `.wxs` files, and from static template usages
to matching template definitions in the current file or direct `import` /
`include` dependencies. It also returns a flat document-symbol list for WXML
declaration/dependency entries such as template definitions, WXS
```

- [ ] **Step 8: Update README unsupported wording**

In the final unsupported list of the LSP paragraph, replace:

```markdown
dynamic template navigation, template visibility-rule navigation, npm/plugin
component navigation, or `componentGenerics`
```

With:

```markdown
dynamic template navigation, recursive/full template visibility, npm/plugin
component navigation, or `componentGenerics`
```

- [ ] **Step 9: Check README wording**

Run:

```bash
rg -n 'direct-scope static templates|static template usages within the current|direct `import` / `include`|recursive/full template visibility' README.md
rg -n 'unique matching template definitions|template visibility-rule|visibility-rule navigation' README.md
```

Expected:

- First command finds the new supported and unsupported wording.
- Second command exits 1 with no matches.

- [ ] **Step 10: Run syntax check**

Run:

```bash
node --check scripts/verify-lsp-diagnostics.mjs
```

Expected: exit code 0.

- [ ] **Step 11: Commit protocol and README updates**

Run:

```bash
git add scripts/verify-lsp-diagnostics.mjs README.md
git commit -m "docs: document scoped template definitions"
```

## Task 5: Final Verification and Review

**Files:**
- Verify: all changed files
- Verify: `server/wxml-lsp.mjs`

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
node --check scripts/verify-wxml-language-service.mjs
node --check scripts/verify-lsp-diagnostics.mjs
node --check server/wxml-lsp.mjs
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

- [ ] **Step 5: Check LSP host boundary**

Run:

```bash
rg -n "templateDefinitionsInFile|directTemplateDependencyFiles|visibleTemplateDefinitions|secondaryRow|unrelated-loading-row|recursive template visibility" server/wxml-lsp.mjs
```

Expected: exit code 1 with no matches. Template visibility semantics must stay out of the LSP host.

- [ ] **Step 6: Review branch diff**

Run:

```bash
git diff --stat main..HEAD
git diff --check main..HEAD
```

Expected: implementation diff is limited to planned fixture, language-service, verification, and README files. `git diff --check` emits no whitespace errors.

- [ ] **Step 7: Request code review before merge**

Use `superpowers:requesting-code-review` before merging.

Review context:

```text
Description: Scoped static WXML template go-to-definition to the current file plus direct import/include dependencies.
Requirements: Keep graph schema unchanged; keep server/wxml-lsp.mjs as protocol host only; current file definitions shadow direct dependencies; duplicate local definitions return null; duplicate direct dependency definitions return null; de-duplicate direct dependency files by normalized graph path; unrelated graph-wide duplicates must not block direct visible definitions; dynamic template usages remain unsupported.
Base: main at the start of the implementation branch.
Head: current feature branch.
```

Fix any Critical or Important findings before merge.
