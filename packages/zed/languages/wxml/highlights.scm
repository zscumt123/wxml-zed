; Comments
(comment) @comment

; ============================================================
; Tag names
; ============================================================

; default: any tag is a tag
(tag_name) @tag

; built-in WXML / WeChat components
((tag_name) @tag.builtin
  (#any-of? @tag.builtin
    ; view containers
    "view" "scroll-view" "swiper" "swiper-item" "movable-area" "movable-view"
    "cover-view" "cover-image" "match-media" "page-container" "root-portal"
    "share-element"
    ; base content
    "text" "rich-text" "icon" "progress"
    ; form
    "button" "checkbox" "checkbox-group" "editor" "form" "input" "label"
    "picker" "picker-view" "picker-view-column" "radio" "radio-group"
    "slider" "switch" "textarea" "keyboard-accessory"
    ; navigation
    "navigator" "functional-page-navigator"
    ; media
    "audio" "image" "video" "camera" "live-player" "live-pusher" "voip-room"
    ; map / canvas
    "map" "canvas"
    ; open / page
    "open-data" "web-view" "ad" "ad-custom" "official-account" "open-container"
    "page-meta" "navigation-bar" "custom-wrapper"))

; control / structural elements (highest priority)
((tag_name) @keyword
  (#any-of? @keyword "wxs" "template" "import" "include" "slot" "block"))

; ============================================================
; Attributes
; ============================================================

(attribute_name) @attribute
(attribute_value) @string
(quoted_attribute_value) @string

; wx:* directives (wx:if, wx:for, wx:key, wx:for-item, ...)
((attribute_name) @keyword
  (#match? @keyword "^wx:"))

; Event bindings: bind, catch, mut-bind, capture-bind, capture-catch
; optional colon — supports both bindtap and bind:tap
((attribute_name) @keyword
  (#match? @keyword "^(capture-bind|capture-catch|mut-bind|bind|catch):?"))

; Two-way bindings, generic slots, dataset
((attribute_name) @keyword
  (#match? @keyword "^(model:|generic:|data-)"))

; Special attribute names on declaration elements only
(template_name_attribute (attribute_name) @property)
(template_is_attribute (attribute_name) @property)
(wxs_module_attribute (attribute_name) @property)
(wxs_src_attribute (attribute_name) @property)

; <import src="..." /> → src as property
((import_statement (attribute (attribute_name) @property)
  (#eq? @property "src")))

; <include src="..." /> → src as property
((include_statement (attribute (attribute_name) @property)
  (#eq? @property "src")))

; ============================================================
; Interpolation, entities, wxs raw text
; ============================================================

(entity) @string.escape

; <wxs> body
(raw_text) @embedded

; {{ ... }} — outer braces vs inner expression
(interpolation) @emphasis.strong
(expression) @embedded

; ============================================================
; Statement keywords (the <import>/<include> tag names already
; get @keyword above; these capture the whole statement nodes
; for theme rules that target them)
; ============================================================

(import_statement) @keyword
(include_statement) @keyword

; ============================================================
; Punctuation & operators
; ============================================================

[
  "<"
  ">"
  "</"
  "/>"
] @punctuation.bracket

[
  "\""
  "'"
] @punctuation.delimiter

"=" @operator
