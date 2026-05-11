/**
 * @file WXML (WeiXin Markup Language) external scanner
 * @author BlockLune <39331194+BlockLune@users.noreply.github.com>
 * @license MIT
 *
 * This scanner handles complex tokenization that can't be expressed in grammar rules.
 * It is intentionally stateless, which is simpler and sufficient for WXML's needs.
 * This approach is different from more complex scanners like in tree-sitter-html, which
 * require a state machine (e.g., a tag stack) to handle multiple types of raw text elements
 * (like <script>, <style>, etc.). WXML only has <wxs>, simplifying the problem.
 */

#include "tree_sitter/parser.h"
#include <wctype.h>
#include <string.h>
#include <stdbool.h>
#include <stdlib.h>

enum TokenType {
  START_TAG_NAME,
  END_TAG_NAME,
  SELF_CLOSING_TAG_DELIMITER,
  RAW_TEXT,
  COMMENT,
  INTERPOLATION_START,
  INTERPOLATION_END,
};

// No state is needed for this scanner, so lifecycle functions are minimal.
void *tree_sitter_wxml_external_scanner_create() {
  return NULL;
}

void tree_sitter_wxml_external_scanner_destroy(void *payload) {
  // No state to destroy
}

void tree_sitter_wxml_external_scanner_reset(void *payload) {
  // No state to reset
}

unsigned tree_sitter_wxml_external_scanner_serialize(void *payload, char *buffer) {
  return 0;
}

void tree_sitter_wxml_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  // No state to deserialize
}

/**
 * WXML reserved element names that require special handling
 * These elements have specific parsing rules in the grammar
 */
static bool is_reserved_word(const char *word, size_t len) {
  static const char *reserved[] = {"template", "slot", "block", "import", "include", "wxs"};
  const size_t count = sizeof(reserved) / sizeof(reserved[0]);
  for (size_t i = 0; i < count; i++) {
    if (strlen(reserved[i]) == len && strncmp(reserved[i], word, len) == 0) {
      return true;
    }
  }
  return false;
}

/**
 * Scan and validate a tag name
 * Returns true if it's a valid non-reserved tag name
 * Reserved words like 'wxs', 'template' are handled by the grammar directly
 */
static bool scan_tag_name(TSLexer *lexer, char *name_buffer, size_t buffer_size) {
  if (!(iswalpha(lexer->lookahead) || lexer->lookahead == '_')) {
    return false;
  }

  size_t len = 0;
  while (iswalnum(lexer->lookahead) || lexer->lookahead == '_' ||
         lexer->lookahead == '-' || lexer->lookahead == ':') {
    if (len < buffer_size - 1) {
      name_buffer[len++] = (char)lexer->lookahead;
    }
    lexer->advance(lexer, false);
  }
  name_buffer[len] = '\0';

  // Reserved words are handled by grammar rules, not the scanner
  if (is_reserved_word(name_buffer, len)) {
    return false;
  }

  return len > 0;
}

/**
 * Scan HTML-style comments: <!-- ... -->
 * Starts from '<' character
 */
static bool scan_comment(TSLexer *lexer) {
  // Expect '<!--' sequence
  if (lexer->lookahead != '<') return false;
  lexer->advance(lexer, false);
  if (lexer->lookahead != '!') return false;
  lexer->advance(lexer, false);
  if (lexer->lookahead != '-') return false;
  lexer->advance(lexer, false);
  if (lexer->lookahead != '-') return false;
  lexer->advance(lexer, false);

  // Scan until we find '-->'
  unsigned dashes = 0;
  while (lexer->lookahead) {
    if (lexer->lookahead == '-') {
      dashes++;
    } else if (lexer->lookahead == '>' && dashes >= 2) {
      lexer->advance(lexer, false);
      return true;
    } else {
      dashes = 0;
    }
    lexer->advance(lexer, false);
  }
  return false;
}

/**
 * Scan raw text content inside WXS elements.
 *
 * This function uses a simple, direct approach with nested `if` statements to look for the
 * `</wxs>` end delimiter. While this may seem less elegant than a state machine or a loop-based
 * string comparison, it is highly efficient and completely avoids heap allocations or complex state.
 *
 * Since WXML only has one raw-text element (`wxs`), this specialized approach is sufficient
 * and avoids the complexity of a stateful tag stack like the one in tree-sitter-html.
 */
static bool scan_raw_text(TSLexer *lexer) {
  // Raw text is only requested when we're in a context that needs it (like WXS elements)
  // The grammar will only ask for raw_text when it's expecting it

  bool has_content = false;

  while (lexer->lookahead) {
    if (lexer->lookahead == '<') {
      // Mark the end before checking if it's a closing tag
      lexer->mark_end(lexer);
      lexer->advance(lexer, false);

      if (lexer->lookahead == '/') {
        lexer->advance(lexer, false);

        // Check for \"wxs\" case-insensitively
        if (towupper(lexer->lookahead) == 'W') {
          lexer->advance(lexer, false);
          if (towupper(lexer->lookahead) == 'X') {
            lexer->advance(lexer, false);
            if (towupper(lexer->lookahead) == 'S') {
              lexer->advance(lexer, false);
              if (lexer->lookahead == '>') {
                // This is the closing tag, so we are done
                lexer->result_symbol = RAW_TEXT;
                return has_content;
              }
            }
          }
        }
      }
      // Not a closing tag, continue scanning
      has_content = true;
    } else {
      lexer->advance(lexer, false);
      has_content = true;
    }
  }

  // Reached end of file
  lexer->result_symbol = RAW_TEXT;
  return has_content;
}

/**
 * The main external scanner function.
 * Called by tree-sitter when the parser needs to scan external tokens
 * Note: The `payload` is unused because the scanner is stateless.
 */
bool tree_sitter_wxml_external_scanner_scan(void *payload, TSLexer *lexer,
                                            const bool *valid_symbols) {
  // No scanner state is used.

  // Skip whitespace
  while (iswspace(lexer->lookahead)) {
    lexer->advance(lexer, true);
  }

  // Handle WXML interpolation start: {{
  if (valid_symbols[INTERPOLATION_START] && lexer->lookahead == '{') {
    lexer->advance(lexer, false);
    if (lexer->lookahead == '{') {
      lexer->advance(lexer, false);
      lexer->result_symbol = INTERPOLATION_START;
      return true;
    }
  }

  // Handle WXML interpolation end: }}
  if (valid_symbols[INTERPOLATION_END] && lexer->lookahead == '}') {
    lexer->advance(lexer, false);
    if (lexer->lookahead == '}') {
      lexer->advance(lexer, false);
      lexer->result_symbol = INTERPOLATION_END;
      return true;
    }
  }

  // Handle HTML-style comments
  if (valid_symbols[COMMENT] && lexer->lookahead == '<') {
    if (scan_comment(lexer)) {
      lexer->result_symbol = COMMENT;
      return true;
    }
  }

  // Handle raw text scanning for WXS elements (JavaScript content)
  if (valid_symbols[RAW_TEXT]) {
    return scan_raw_text(lexer);
  }

  // Handle tag name scanning
  if (valid_symbols[START_TAG_NAME] || valid_symbols[END_TAG_NAME]) {
    char tag_name[64];
    if (scan_tag_name(lexer, tag_name, sizeof(tag_name))) {
      lexer->result_symbol = valid_symbols[START_TAG_NAME] ? START_TAG_NAME : END_TAG_NAME;
      return true;
    }
  }

  // Handle self-closing tag delimiter: />
  if (valid_symbols[SELF_CLOSING_TAG_DELIMITER] && lexer->lookahead == '/') {
    lexer->advance(lexer, false);
    if (lexer->lookahead == '>') {
      lexer->advance(lexer, false);
      lexer->result_symbol = SELF_CLOSING_TAG_DELIMITER;
      return true;
    }
  }

  return false;
}
