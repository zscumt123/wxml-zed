# Graph Extractor Profile Design

## Goal

Measure why WXML project graph extraction is slow before changing parser or LSP
architecture.

The current graph path is:

```text
extract-wxml-project-graph.mjs
  -> extract-wxml-symbols.mjs
    -> npx tree-sitter-cli parse --cst per WXML file
```

The likely bottleneck is per-file `npx tree-sitter-cli`, but this slice should
prove that with timings instead of guessing.

## Scope

Add opt-in profiling to the existing extractors:

- `WXML_ZED_PROFILE=1 node scripts/extract-wxml-project-graph.mjs <root>`
- profile events go to stderr as one JSON object per line;
- stdout remains the existing graph or symbol JSON;
- normal runtime behavior remains unchanged when profiling is disabled.

Add a wrapper command:

```bash
node scripts/profile-wxml-project-graph.mjs fixtures/miniprogram
```

The wrapper should run the existing project graph extractor with profiling
enabled, discard the graph JSON, parse profile events from stderr, and print a
small human-readable timing report.

## Non-Goals

- Do not optimize the extractor in this slice.
- Do not change LSP scheduling or cache behavior.
- Do not change the graph JSON schema.
- Do not add external dependencies.

## Acceptance Criteria

- Profiling can show total graph time, symbol extractor child time, per-batch
  symbol time, and per-file Tree-sitter CST time.
- Existing extractor stdout remains parseable JSON.
- Existing verification scripts continue to pass.
- The profile wrapper reports enough evidence to decide the next optimization
  slice.
