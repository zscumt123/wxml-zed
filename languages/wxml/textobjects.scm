; Comments — vac/vic for a comment block
(comment)+ @comment.around

; Generic elements — vac/vic for the element
(element
  (start_tag)
  (_)* @class.inside
  (end_tag)) @class.around

(element
  (self_closing_tag)) @class.around

; Block / slot / template elements
(block_element
  (block_start_tag)
  (_)* @class.inside
  (block_end_tag)) @class.around

(slot_element
  (slot_start_tag)
  (_)* @class.inside
  (slot_end_tag)) @class.around

(slot_element
  (slot_self_closing_tag)) @class.around

(template_definition
  (template_definition_start_tag)
  (_)* @class.inside
  (template_end_tag)) @class.around

(template_usage
  (template_usage_start_tag)
  (_)* @class.inside
  (template_end_tag)) @class.around

(template_usage
  (template_usage_self_closing_tag)) @class.around

(template_fallback
  (template_fallback_start_tag)
  (_)* @class.inside
  (template_end_tag)) @class.around

(template_fallback
  (template_fallback_self_closing_tag)) @class.around

; <wxs> body — function-like (vaf/vif targets the JS body)
(wxs_inline
  (wxs_inline_start_tag)
  (raw_text)? @function.inside
  (wxs_end_tag)) @function.around

(wxs_external
  (wxs_external_self_closing_tag)) @function.around

(wxs_fallback
  (wxs_fallback_start_tag)
  (raw_text)? @function.inside
  (wxs_end_tag)) @function.around

(wxs_fallback
  (wxs_fallback_self_closing_tag)) @function.around
