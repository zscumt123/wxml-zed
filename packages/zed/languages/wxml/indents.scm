(start_tag ">" @end) @indent
(self_closing_tag "/>" @end) @indent

(element
  (start_tag) @start
  (end_tag)? @end) @indent

(block_element
  (block_start_tag) @start
  (block_end_tag)? @end) @indent

(slot_element
  (slot_start_tag) @start
  (slot_end_tag)? @end) @indent

(slot_self_closing_tag "/>" @end) @indent

(template_definition
  (template_definition_start_tag) @start
  (template_end_tag)? @end) @indent

(template_usage
  (template_usage_start_tag) @start
  (template_end_tag)? @end) @indent

(template_usage_self_closing_tag "/>" @end) @indent

(template_fallback
  (template_fallback_start_tag) @start
  (template_end_tag)? @end) @indent

(template_fallback_self_closing_tag "/>" @end) @indent

(wxs_inline
  (wxs_inline_start_tag) @start
  (wxs_end_tag)? @end) @indent

(wxs_external_self_closing_tag "/>" @end) @indent

(wxs_fallback
  (wxs_fallback_start_tag) @start
  (wxs_end_tag)? @end) @indent

(wxs_fallback_self_closing_tag "/>" @end) @indent
