// =============================================================================
// Slide blocks — the outline's structural scan, and which headings a save stamps
// =============================================================================
//
// Split out of 12-outline-edit.mjs (and lineHasUnclosedBrace out of 13-slide-ledger.mjs) so that
// code with no Node access can ask the questions the save path asks. 12-outline-edit.mjs reaches
// node:fs through the ledger; this module imports only pure text modules.
//
//   listSlideBlocks(text)     → every ##–###### heading's block
//   headingsMissingIds(text)  → the headings stampMissingIds (12-outline-edit.mjs) will stamp
//
// stampMissingIds takes its targets from headingsMissingIds, so "would a save stamp this text?"
// has one answer: headingsMissingIds(text).length > 0.

import { isMarkdownFenceClosingLine, parseMarkdownFenceOpeningLine } from "./03-object-token.mjs";
import { ID_TOKEN_RE, idLineIndex, preContentWindow } from "./slide-id.mjs";

// ── Outline scanning ─────────────────────────────────────────────────────────
//
// Mirrors the adapter's structural scan (fence guard is LENGTH-AWARE, HTML comments hide
// headings) but never strips anything: it only locates boundaries, the text stays whole.
// Heading-is-slide model: a "slide block" is ANY `##`–`######` heading line through the line
// before the next structural heading (any depth, outside fences and comments) or EOF — each
// heading is its own block; children are separate blocks. The deck title (`#`) is a boundary
// but never a block. `:::notes`, Trigger lines and blank lines live inside their slide's block.

export function scanLines(text) {
  return text.split("\n");
}

// Per-line structural state: fences and HTML comments (the adapter strips comments before
// scanning; here a heading inside a comment must simply not count as a boundary). Fences follow
// the compiler's outline tree exactly (14-outline-tree.mjs, via 03-object-token.mjs): backtick
// AND tilde openers, and a close must use the opener's character and be at least as long.
// Comment tracking is sequential per line: a line is "visible" only when it starts outside an
// open comment.
function structuralHeadings(lines) {
  const headings = []; // {index, depth, text}
  let fenceOpening = null;
  let inComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const visibleAtStart = !inComment;
    // advance comment state through this line (comments may open/close mid-line, span lines)
    if (!fenceOpening) {
      let pos = 0;
      for (;;) {
        if (inComment) {
          const close = line.indexOf("-->", pos);
          if (close === -1) break;
          inComment = false;
          pos = close + 3;
        } else {
          const open = line.indexOf("<!--", pos);
          if (open === -1) break;
          inComment = true;
          pos = open + 4;
        }
      }
    }
    if (!visibleAtStart) continue;
    if (fenceOpening) {
      if (isMarkdownFenceClosingLine(line, fenceOpening)) fenceOpening = null;
      continue;
    }
    const open = parseMarkdownFenceOpeningLine(line);
    if (open) { fenceOpening = open; continue; }
    const m = line.match(/^(#{1,6})\s+\S/);
    if (m) headings.push({ index: i, depth: m[1].length, text: line });
  }
  return headings;
}

// List the outline's slide blocks. Each block: { heading (verbatim heading line, any depth
// ##–######), occurrence (1-based among identical heading lines), title, start, end } —
// [start, end) line range, trailing blank lines included (they travel with the slide so spacing
// survives a move). Occurrence counts on the VERBATIM line — the `#`-prefix is part of it, so
// headings at different depths never collide — which keeps {heading, occurrence} addressing
// byte-compatible with the editor's getCursorListItemContext (outliner.ts). The deck title (`#`)
// is a boundary only, never an addressable block.
export function listSlideBlocks(text) {
  const lines = scanLines(text);
  const headings = structuralHeadings(lines);
  const blocks = [];
  const seen = new Map();
  for (let h = 0; h < headings.length; h += 1) {
    const { index, depth, text: headingText } = headings[h];
    if (depth < 2) continue;
    const end = h + 1 < headings.length ? headings[h + 1].index : lines.length;
    const occurrence = (seen.get(headingText) || 0) + 1;
    seen.set(headingText, occurrence);
    blocks.push({
      heading: headingText,
      occurrence,
      title: headingText.replace(/^#{1,6}\s+/, "").trim(),
      start: index,
      end,
    });
  }
  return blocks;
}

export function lineHasUnclosedBrace(line) {
  let depth = 0;
  for (const char of String(line)) {
    if (char === "{") depth += 1;
    else if (char === "}" && depth > 0) depth -= 1;
  }
  return depth > 0;
}

// Normalised heading key for cross-document id matching: the verbatim heading line with any
// {id=…} token removed and whitespace collapsed — so "### Foo" in an unstamped buffer matches
// "### Foo {id=x}" in the previously-stamped disk copy of the same slide.
export const headingIdKey = (heading) =>
  String(heading).replace(new RegExp(ID_TOKEN_RE.source, "g"), "").replace(/\s+/g, " ").trimEnd();

// The headings a save stamps: every block with no {id=…} whose prelude is not mid-typing (an
// unclosed brace). Each: { heading, occurrence, prefKey } — prefKey is the normalised heading and
// its occurrence, the key preferredIdsFromText (12-outline-edit.mjs) reuses ids by.
export function headingsMissingIds(text) {
  const lines = scanLines(text);
  const normCounts = new Map();
  const targets = [];
  for (const block of listSlideBlocks(text)) {
    const key = headingIdKey(block.heading);
    const occ = (normCounts.get(key) || 0) + 1;
    normCounts.set(key, occ);
    const hasId = idLineIndex(lines, block.start, block.end) >= 0;
    const window = preContentWindow(lines, block.start, block.end);
    const isMidTyping = lines.slice(window.start, window.end).some(lineHasUnclosedBrace);
    if (!hasId && !isMidTyping) {
      targets.push({ heading: block.heading, occurrence: block.occurrence, prefKey: `${key} ${occ}` });
    }
  }
  return targets;
}
