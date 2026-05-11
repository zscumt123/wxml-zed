; Outline: declarative / navigable items only
; (template definitions, wxs modules, import/include file references)

; <template name="..."> ... </template>
((template_element
  (template_start_tag
    (attribute
      (attribute_name) @_n
      [(attribute_value) (quoted_attribute_value)] @name))) @item
 (#eq? @_n "name"))

; <wxs module="..."> ... </wxs>  (inline wxs)
((wxs_element
  (wxs_start_tag
    (attribute
      (attribute_name) @_n
      [(attribute_value) (quoted_attribute_value)] @name))) @item
 (#eq? @_n "module"))

; <wxs module="..." src="..." />  (external wxs, parses as self-closing element)
((element
   (self_closing_tag
     (tag_name) @_tag
     (attribute
       (attribute_name) @_n
       [(attribute_value) (quoted_attribute_value)] @name))) @item
 (#eq? @_tag "wxs")
 (#eq? @_n "module"))

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
