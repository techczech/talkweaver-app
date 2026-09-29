// HTML comments in an outline (`<!-- … -->`) are author-only: notes, provenance, TODOs, a
// commented-out slide. The compiler blanks them before it recognises any structure, and every
// reader of a slide's raw source that feeds an audience surface must blank them the same way —
// hence one helper (moved out of 08-source-adapters.mjs and slide-script.mjs, 2026-09-28).
//
// The comment's characters are blanked but its NEWLINES are kept, so a line index after blanking
// is still the true source line (the per-slide sourceLine drives editor↔strip sync). A
// commented-out `## …` heading is therefore ignored: its text is gone, its line stays. An
// unclosed `<!--` is left as it is.
// Pure — no node: imports.

export function blankHtmlComments(text) {
  return String(text ?? "").replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
}
