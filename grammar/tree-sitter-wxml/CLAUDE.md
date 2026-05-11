# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Tree-sitter grammar for WXML (WeiXin Markup Language), the markup language used in WeChat Mini Programs. The parser supports:

- Standard HTML-like markup with WXML-specific features
- Data binding and interpolation (`{{expression}}`)
- Conditional rendering (`wx:if`, `wx:elif`, `wx:else`)
- List rendering (`wx:for`, `wx:key`)
- Event binding (`bind:tap`, `catch:tap`)
- Template imports and includes
- WXS (WeXin Script) embedded JavaScript modules
- Block elements for logical grouping
- Slot elements for component composition

## Development Commands

### Core Development

- `npm test` - Run Node.js binding tests
- `tree-sitter test` - Run tree-sitter corpus tests (requires tree-sitter CLI)
- `tree-sitter generate` - Regenerate parser from grammar.js
- `tree-sitter build --wasm` - Build WASM version for web usage
- `tree-sitter playground` - Start interactive playground for testing

### Build System

- `make` - Build C library (static and shared)
- `make test` - Run tree-sitter tests via Makefile
- `make clean` - Clean build artifacts
- `make install` - Install library system-wide

### Package Management

- `npm start` - Build WASM and start playground (combines prestart + start)
- `pnpm install` - Install dependencies (project uses pnpm)

## Code Architecture

### Grammar Definition

- `grammar.js` - Main grammar rules defining WXML syntax
- `src/scanner.c` - External scanner for complex tokenization (interpolations, raw text)
- Reserved elements: template, slot, block, import, include, wxs

### Generated Files

- `src/parser.c` - Generated parser implementation
- `src/grammar.json` - JSON representation of grammar
- `src/node-types.json` - AST node type definitions

### Language Bindings

- `bindings/node/` - Node.js/JavaScript bindings
- `bindings/python/` - Python bindings
- `bindings/rust/` - Rust bindings
- `bindings/go/` - Go bindings
- `bindings/c/` - C header files
- `bindings/swift/` - Swift bindings

### Query Files

- `queries/highlights.scm` - Syntax highlighting rules
- `queries/injections.scm` - Language injection for JavaScript in expressions and WXS
- `queries/indents.scm` - Indentation rules
- `queries/brackets.scm` - Bracket matching rules

### Testing

- `test/corpus/` - Tree-sitter test corpus with WXML examples and expected AST
- Test categories: basic elements, interpolation, conditionals, list rendering, templates, WXS modules
- `bindings/node/binding_test.js` - Basic Node.js binding smoke test

## Key WXML Features

### Data Binding & Interpolation

```wxml
<text>{{message}}</text>
<view class="{{dynamicClass}}">Content</view>
```

### Conditional Rendering

```wxml
<view wx:if="{{condition}}">Show if true</view>
<view wx:elif="{{otherCondition}}">Show if other true</view>
<view wx:else>Show otherwise</view>
```

### List Rendering

```wxml
<view wx:for="{{array}}" wx:key="id">
  {{index}}: {{item.name}}
</view>
```

### Templates

```wxml
<import src="item.wxml"/>
<template is="item" data="{{text: 'hello'}}"/>
```

### WXS Modules

```wxml
<wxs module="utils">
  function format(text) { return text.toUpperCase(); }
  module.exports = { format: format };
</wxs>
```

## Development Notes

- Grammar changes require regenerating parser with `tree-sitter generate`
- Scanner.c handles complex tokenization that can't be expressed in grammar rules
- Test corpus in `test/corpus/` follows tree-sitter test format
- The parser extends HTML parsing with WXML-specific constructs
- JavaScript injection happens in interpolation expressions and WXS content
