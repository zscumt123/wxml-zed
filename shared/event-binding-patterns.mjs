// WXML event binding attribute prefixes, ordered most-specific first.
// Capture forms must precede plain bind/catch so that e.g. `capture-bindtap`
// is parsed as binding=capture-bind/event=tap, not binding=bind/event=apture-bindtap.
export const EVENT_PATTERNS = [
  { re: /^(capture-(?:bind|catch)):(.+)$/, bindingFromMatch: (m) => `${m[1]}:`, eventFromMatch: (m) => m[2] },
  { re: /^(capture-(?:bind|catch))(.+)$/,  bindingFromMatch: (m) => m[1],       eventFromMatch: (m) => m[2] },
  { re: /^mut-bind:(.+)$/,                  bindingFromMatch: () => "mut-bind:", eventFromMatch: (m) => m[1] },
  { re: /^(bind|catch):(.+)$/,              bindingFromMatch: (m) => `${m[1]}:`, eventFromMatch: (m) => m[2] },
  { re: /^(bind|catch)(.+)$/,               bindingFromMatch: (m) => m[1],       eventFromMatch: (m) => m[2] },
];

// Loose matcher: used by symbol extraction (`extract-wxml-symbols.mjs`).
// Accepts any string that fits one of the EVENT_PATTERNS, including
// false-positives like `binding` -> {bind, "ing"}. Intentional — the
// data model captures anything plausible; the completion path uses a
// stricter gate below.
export function matchEventBinding(attrName) {
  for (const p of EVENT_PATTERNS) {
    const m = attrName.match(p.re);
    if (m) return { binding: p.bindingFromMatch(m), event: p.eventFromMatch(m) };
  }
  return null;
}

// WeChat built-in event names that legitimately appear in the no-colon
// shorthand form (`bindtap`, `catchchange`, `capture-bindtouchstart`).
// Custom-component events should use the colon form (`bind:select`) and
// are accepted by `isEventHandlerCompletionTrigger` via the colon-form
// branch — so this list does not need to enumerate them.
//
// Conservative seed list. If users hit false-negatives for legitimate
// built-in events not listed here, extend rather than relaxing to the
// loose matcher above.
const BUILTIN_EVENT_NAMES = new Set([
  "tap", "longpress", "longtap",
  "touchstart", "touchmove", "touchcancel", "touchend", "touchforcechange",
  "transitionend",
  "animationstart", "animationiteration", "animationend",
  "scroll", "scrolltoupper", "scrolltolower",
  "input", "change", "focus", "blur", "confirm", "submit", "reset",
  "load", "error",
]);

// Strict matcher: used by completion (`server/wxml-language-service.mjs`).
// Returns true iff the attribute name is unambiguously an event binding
// for completion-trigger purposes. Colon forms require a non-empty event
// suffix. No-colon forms require the suffix to be a known WeChat built-in
// event name. Rejects `binding`, `bindable`, `catching`, `bindAttr`,
// `bind:`, plain `bind`, etc.
export function isEventHandlerCompletionTrigger(attrName) {
  if (/^(?:capture-(?:bind|catch)|mut-bind|bind|catch):.+$/.test(attrName)) {
    return true;
  }
  const m = attrName.match(/^(?:capture-(?:bind|catch)|bind|catch)(.+)$/);
  if (!m) return false;
  return BUILTIN_EVENT_NAMES.has(m[1]);
}
