((wxs_inline
  (raw_text) @injection.content)
  (#set! injection.language "javascript")
  (#set! injection.include-children))

((wxs_fallback
  (raw_text) @injection.content)
  (#set! injection.language "javascript")
  (#set! injection.include-children))

((expression) @injection.content
  (#set! injection.language "javascript")
  (#set! injection.include-children))
