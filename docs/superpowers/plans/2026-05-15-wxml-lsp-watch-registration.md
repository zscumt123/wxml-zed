# WXML LSP Watch Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Zed deliver real watched-file notifications by dynamically registering WXML graph-affecting file watchers from the Node LSP server.

**Architecture:** Keep `server/wxml-lsp.mjs` as the protocol host. Capture client watcher dynamic-registration capability during `initialize`, send one `client/registerCapability` request after `initialized`, and ignore client responses by id. Keep graph refresh and WXML language-service semantics unchanged.

**Tech Stack:** Node.js ESM, dependency-free JSON-RPC/LSP stdio server, fixture-driven protocol harness, Markdown docs.

---

## File Structure

- Modify `server/wxml-lsp.mjs`
  - Add watcher registration constants.
  - Store client support for `workspace.didChangeWatchedFiles.dynamicRegistration`.
  - Send `client/registerCapability` after `initialized` when supported.
  - Treat JSON-RPC responses from the client as responses, not unknown methods.
- Modify `scripts/verify-lsp-diagnostics.mjs`
  - Let the test client optionally advertise watched-file dynamic registration.
  - Add helpers for waiting for server requests and responding to them.
  - Add scenarios for registration supported and unsupported clients.
- Modify `README.md`
  - Document that the LSP dynamically registers file watchers with capable clients.

---

### Task 1: Failing Protocol Tests

**Files:**
- Modify: `scripts/verify-lsp-diagnostics.mjs`

- [ ] Add client-side request capture helpers to `LspClient`.
- [ ] Add optional `watchDynamicRegistration` capability to `initialize`.
- [ ] Add `testWatchRegistrationWhenSupported`.
- [ ] Add `testWatchRegistrationSkippedWhenUnsupported`.
- [ ] Run `node --check scripts/verify-lsp-diagnostics.mjs`.
- [ ] Run `node scripts/verify-lsp-diagnostics.mjs` and confirm the supported registration test fails before implementation.
- [ ] Commit with `test: cover watched file registration`.

### Task 2: Server Watch Registration

**Files:**
- Modify: `server/wxml-lsp.mjs`

- [ ] Add `WATCH_REGISTRATION_ID`, `WATCH_REGISTRATION_METHOD`, and watched file glob constants.
- [ ] Add `requestClient(...)`.
- [ ] Store `supportsWatchedFileDynamicRegistration` during `initialize`.
- [ ] Add `registerWatchedFilesIfSupported()`.
- [ ] Ignore incoming JSON-RPC responses before the method switch.
- [ ] Call registration helper on `initialized`.
- [ ] Run `node --check server/wxml-lsp.mjs`.
- [ ] Run `node scripts/verify-lsp-diagnostics.mjs`.
- [ ] Commit with `feat: register watched files with zed`.

### Task 3: README Update

**Files:**
- Modify: `README.md`

- [ ] Document dynamic watcher registration in the LSP development section.
- [ ] Keep unsupported boundaries: no Node watcher and no project-wide diagnostics.
- [ ] Run `rg -n 'dynamic|didChangeWatchedFiles|watcher|project-wide diagnostics' README.md`.
- [ ] Run `git diff --check README.md`.
- [ ] Commit with `docs: document watched file registration`.

### Task 4: Final Verification

**Files:**
- Verify: full changed set

- [ ] Run `node --check server/wxml-lsp.mjs`.
- [ ] Run `node --check scripts/verify-lsp-diagnostics.mjs`.
- [ ] Run `node scripts/verify-lsp-diagnostics.mjs`.
- [ ] Run `scripts/verify-tree-sitter.sh`.
- [ ] Run `git diff --check main..HEAD`.
- [ ] Review focused diffs for server/test/docs scope.
