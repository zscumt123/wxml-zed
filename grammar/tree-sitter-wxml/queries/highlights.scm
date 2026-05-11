; Comments
(comment) @comment

; Document structure
(document) @none

; Elements and tags
(element) @none
(start_tag) @none
(end_tag) @none
(self_closing_tag) @none

; Tag names
(tag_name) @tag

; WeChat Mini Program specific tags
((tag_name) @keyword
 (#any-of? @keyword "wxs" "template" "import" "include" "slot" "block"))

; Attributes
(attribute) @none
(attribute_name) @property
(attribute_value) @string
(quoted_attribute_value) @string

; Entity references
(entity) @string.escape

; Text content
(text) @text.literal

; Raw text (primarily for wxs JavaScript content)
(raw_text) @embedded

; Interpolation expressions
(interpolation) @punctuation.special
(expression) @embedded

; Import and include statements
(import_statement) @preproc
(include_statement) @preproc

; Template elements
(template_definition) @none
(template_usage) @none
(template_definition_start_tag) @none
(template_usage_start_tag) @none
(template_usage_self_closing_tag) @none
(template_end_tag) @none
(template_name_attribute) @none
(template_is_attribute) @none

; Slot elements
(slot_element) @none
(slot_start_tag) @none
(slot_self_closing_tag) @none
(slot_end_tag) @none

; Block elements
(block_element) @none
(block_start_tag) @none
(block_end_tag) @none

; WXS elements (JavaScript modules)
(wxs_inline) @none
(wxs_external) @none
(wxs_inline_start_tag) @none
(wxs_external_self_closing_tag) @none
(wxs_end_tag) @none
(wxs_module_attribute) @none
(wxs_src_attribute) @none

; WeChat specific directive attributes
((attribute_name) @emphasis.strong
 (#match? @emphasis.strong "^wx:"))

; Event binding attributes
((attribute_name) @emphasis.strong
 (#match? @emphasis.strong "^(bind|catch|mut-bind):?"))

; Data binding attributes
((attribute_name) @emphasis.strong
 (#match? @emphasis.strong "^(model:|data-)"))

; Special attributes
((attribute_name) @property.special
 (#any-of? @property.special "slot" "is" "module" "src"))

; Punctuation and operators
"<" @punctuation.bracket
">" @punctuation.bracket
"</" @punctuation.bracket
"/>" @punctuation.bracket
"=" @operator

; Quotes in attributes
"\"" @punctuation.delimiter
"'" @punctuation.delimiter
