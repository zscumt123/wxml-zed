; Outline: declarative / navigable items only
; (template definitions, wxs modules, import/include file references)

; <template name="..."> ... </template>
((template_definition
  (template_definition_start_tag
    (template_name_attribute
      [(attribute_value) (quoted_attribute_value)] @name))) @item)

; <wxs module="..."> ... </wxs>  (inline wxs)
((wxs_inline
  (wxs_inline_start_tag
    (wxs_module_attribute
      [(attribute_value) (quoted_attribute_value)] @name))) @item)

; <wxs module="..." src="..." />  (external wxs)
((wxs_external
  (wxs_external_self_closing_tag
    (wxs_module_attribute
      [(attribute_value) (quoted_attribute_value)] @name))) @item)

; <import src="..." />
((import_statement
   (attribute
     (attribute_name) @_n
     [(attribute_value) (quoted_attribute_value)] @name)) @item
 (#eq? @_n "src"))

; <include src="..." />
((include_statement
   (attribute
     (attribute_name) @_n
     [(attribute_value) (quoted_attribute_value)] @name)) @item
 (#eq? @_n "src"))

(comment) @annotation
