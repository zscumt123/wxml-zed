package tree_sitter_wxml_test

import (
	"testing"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"
	tree_sitter_wxml "github.com/blocklune/tree-sitter-wxml/bindings/go"
)

func TestCanLoadGrammar(t *testing.T) {
	language := tree_sitter.NewLanguage(tree_sitter_wxml.Language())
	if language == nil {
		t.Errorf("Error loading WeiXin Markup Language grammar")
	}
}
