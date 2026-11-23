// The one HTML escape for generated pages: the compiler, the main process (through
// src/shared/html-escape.ts), src/shared/ and the worker all import it. 01-cli-utils.mjs
// re-exports escapeHtml so every existing compiler caller keeps one truth. Browser-safe.
//
// Both functions escape all five of & < > " ' so their output is safe as element text and inside
// a single- or double-quoted attribute value alike. null and undefined become the empty string.
// Runtime scripts inlined into decks as source text (compiler/assets/runtime/, poll-frame.mjs)
// cannot import this; scripts/test-html-escape.mjs checks each of their local helpers escapes the
// same five characters.

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for an HTML element's content. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Escapes text for an HTML attribute value (quoted with " or '). */
export function escapeAttr(value) {
  return escapeHtml(value);
}
