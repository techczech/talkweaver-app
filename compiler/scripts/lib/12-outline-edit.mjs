// =============================================================================
// 12. Outline editing — whole-slide-block text operations for the tier-1 grid editor
// =============================================================================
//
// The grid editor (P1.5) edits the CANONICAL Outline by moving/copying/deleting whole slide
// blocks and writing single Triggers to a slide's Trigger line (ADR-0015). Everything here is
// a pure text→text function so the safety contract is checkable in unit tests:
//
//   - a slide block is OPAQUE: its lines move byte-for-byte, never parsed-and-regenerated;
//   - everything outside the touched region is byte-identical;
//   - the only line this module ever REWRITES is a slide's Trigger line (the machine-writable
//     surface — {#id} write-back will target the same line), and only token-precisely;
//   - headings are never modified (codes on headings are the author's, ADR-0015 precedence
//     means a Trigger-line write silently wins without touching them).
//
// The bundle's local server resolves this module at runtime from the html-presentations repo
// (the bundle itself stays path-free) and exposes it as the /editor/* API; the Raycast layer
// or agents can import it directly.

import { resolveTrigger } from "../triggers.mjs";
import { LIST_VALUE_KEYS } from "./02-triggers-layout.mjs";
import { iconCandidatesV3, normalizeIconOverrideKey } from "./05-icons.mjs";
import {
  mintId, ID_TOKEN_RE, idLineIndex, lineHasUnclosedBrace, preContentWindow, triggerLineBlock
} from "./13-slide-ledger.mjs";
import { parseOutlineTree } from "./14-outline-tree.mjs";

// ── Outline scanning ─────────────────────────────────────────────────────────
//
// Mirrors the adapter's structural scan (fence guard is LENGTH-AWARE, HTML comments hide
// headings) but never strips anything: it only locates boundaries, the text stays whole.
// Heading-is-slide model: a "slide block" is ANY `##`–`######` heading line through the line
// before the next structural heading (any depth, outside fences and comments) or EOF — each
// heading is its own block; children are separate blocks. The deck title (`#`) is a boundary
// but never a block. `:::notes`, Trigger lines and blank lines live inside their slide's block.

function scanLines(text) {
  return text.split("\n");
}

// Per-line structural state: fences (length-aware, as in the adapter) and HTML comments
// (the adapter strips comments before scanning; here a heading inside a comment must simply
// not count as a boundary). Comment tracking is sequential per line: a line is "visible"
// only when it starts outside an open comment.
function structuralHeadings(lines) {
  const headings = []; // {index, depth, text}
  let inFence = false;
  let fenceMark = "";
  let inComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    const visibleAtStart = !inComment;
    // advance comment state through this line (comments may open/close mid-line, span lines)
    if (!inFence) {
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
    if (inFence) {
      const close = t.match(/^(`{3,})\s*$/);
      if (close && close[1].length >= fenceMark.length) { inFence = false; fenceMark = ""; }
      continue;
    }
    const open = t.match(/^(`{3,})/);
    if (open) { inFence = true; fenceMark = open[1]; continue; }
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

function findBlock(blocks, ref) {
  const occurrence = ref.occurrence || 1;
  const found = blocks.find((b) => b.heading === ref.heading && b.occurrence === occurrence);
  if (!found) {
    throw new Error(`outline-edit: slide block not found (heading=${JSON.stringify(ref.heading)} occurrence=${occurrence})`);
  }
  return found;
}

function joinPreservingTrailing(lines) {
  return lines.join("\n");
}

// ── Operations ───────────────────────────────────────────────────────────────
// Every op takes and returns the WHOLE outline text. refs are { heading, occurrence } with
// heading the verbatim `###` line (the grid client reads it from the slide's projected
// source_markdown first line). All ops throw on a missing/ambiguous ref — the server turns
// that into a 409 alongside its hash guard.

// Move a slide block before/after another block. Cross-section moves are just linear moves:
// the block lands in whatever section precedes its new position; section intro material
// (the ## line, its Trigger line, any preamble prose) never moves.
export function reorderSlide(text, fromRef, targetRef, position = "after") {
  const lines = scanLines(text);
  let blocks = listSlideBlocks(text);
  const from = findBlock(blocks, fromRef);
  const moved = lines.splice(from.start, from.end - from.start);
  // Re-scan after removal: indices shifted; the target ref's occurrence may also have
  // changed when from and target share a heading line — refuse that pathological case.
  if (fromRef.heading === targetRef.heading) {
    throw new Error("outline-edit: cannot reorder relative to a slide with the identical heading line");
  }
  const remaining = joinPreservingTrailing(lines);
  blocks = listSlideBlocks(remaining);
  const target = findBlock(blocks, targetRef);
  const at = position === "before" ? target.start : target.end;
  lines.splice(at, 0, ...moved);
  return joinPreservingTrailing(lines);
}

// Duplicate a slide block in place (the copy lands immediately after the original).
// ADR-0032: a duplicate is a divergence-in-waiting, so the copy gets a FRESH {id=…}
// (same-id copies silently shadow each other in projections and the Slide Ledger).
// The caller that can reach the ledger records minted.fromId as lineage.
export function duplicateSlideWithLineage(text, ref, rng = Math.random) {
  const lines = scanLines(text);
  const block = findBlock(listSlideBlocks(text), ref);
  let copy = lines.slice(block.start, block.end);
  let minted = null;
  const taken = new Set([...text.matchAll(new RegExp(ID_TOKEN_RE.source, "g"))].map((m) => m[1]));
  copy = copy.map((line) => {
    const m = line.match(ID_TOKEN_RE);
    if (!m || minted) return line;
    const newId = mintId(rng, taken);
    minted = { newId, fromId: m[1] };
    return line.replace(ID_TOKEN_RE, `{id=${newId}}`);
  });
  if (copy.length && copy[copy.length - 1].trim() !== "" && block.end === lines.length) {
    copy.unshift("");
  }
  lines.splice(block.end, 0, ...copy);
  return { text: joinPreservingTrailing(lines), minted };
}

export function duplicateSlide(text, ref, rng = Math.random) {
  return duplicateSlideWithLineage(text, ref, rng).text;
}

// Fork: give the referenced slide a NEW identity in place (ADR-0032 detach).
export function detachSlideId(text, ref, rng = Math.random) {
  const lines = scanLines(text);
  const block = findBlock(listSlideBlocks(text), ref);
  const taken = new Set([...text.matchAll(new RegExp(ID_TOKEN_RE.source, "g"))].map((m) => m[1]));
  for (let i = block.start; i < block.end; i += 1) {
    const m = lines[i].match(ID_TOKEN_RE);
    if (m) {
      const newId = mintId(rng, taken);
      lines[i] = lines[i].replace(ID_TOKEN_RE, `{id=${newId}}`);
      return { text: joinPreservingTrailing(lines), oldId: m[1], newId };
    }
  }
  return null;
}

// Set a slide block's id to a SUPPLIED value (ADR-0032 duplicate merge/unify). Unlike
// detachSlideId (which MINTS a fresh id), this stamps the id the caller chose. If the block already
// carries an {id=…} on its HEADING or the line directly below it (the Trigger line) — the ONLY two
// positions the ledger readers extractIdSlides / blockIdOf recognise, ADR-0015 — replace THAT token
// in place, leaving every other byte untouched. Otherwise write the id onto the Trigger line as its
// OWN {id=…} group via mergeTriggerAtLine — NOT setSlideTrigger, whose single-group rendering would
// fold the id into a shared `{layout id=…}` group where extractIdSlides' `{id=…}` match cannot see
// it (the ADR-0032 id-loss trap; verified 2026-07-04). mergeTriggerAtLine creates the Trigger line
// when absent, scrubs a same-key heading token, and keeps any other trigger tokens verbatim.
//
// The scan is BOUNDED to those two lines on purpose (unlike detachSlideId :174 and
// duplicateSlideWithLineage :149, which scan the whole block but only ever MINT fresh ids on a
// user-selected already-stamped slide). setSlideId is on the merge WRITE path: a literal {id=…}
// deeper in the body is prose (e.g. a slide ABOUT the {id=…} syntax) — rewriting it would be silent
// content loss, and it does NOT make the slide "already stamped". Pure text→text.
// `eol` (default "" = LF) is the trailing character to give a BRAND-NEW Trigger line, so a
// stamp onto a CRLF document doesn't leave one lone LF-only line (dominantEol below). It is never
// consulted when an id already sits on a line (that line's own bytes, including its own trailing
// \r, are preserved untouched).
export function setSlideId(text, ref, id, eol = "") {
  const lines = scanLines(text);
  const block = findBlock(listSlideBlocks(text), ref);
  // Shared read rule: the id lives on the heading OR on its (possibly blank-separated) Trigger line.
  // Replacing it IN PLACE — never minting a fresh line above a blank-separated one — is what keeps the
  // blank-line form byte-stable across saves (id-churn hotfix, 2026-07-10).
  const idLine = idLineIndex(lines, block.start, block.end);
  if (idLine >= 0) {
    lines[idLine] = lines[idLine].replace(ID_TOKEN_RE, `{id=${id}}`);
    return joinPreservingTrailing(lines);
  }
  // No id on the heading/Trigger line — merge {id=…} onto the Trigger line (own group), addressing
  // the block by the 1-based line of its heading. mergeTriggerAtLine only returns null when the line
  // sits under no heading, which cannot happen here (block.start IS a heading), so the ?? is defensive.
  return mergeTriggerAtLine(text, block.start + 1, `{id=${id}}`, eol) ?? text;
}

// Dominant line ending (same detection as migrate-outline.mjs's eol pattern): a document whose
// non-final lines are MOSTLY `\r`-terminated (CRLF, since split is on "\n" only) reports "\r";
// otherwise "" (LF). Used so any BRAND-NEW line this module creates (a minted Trigger line) never
// leaves a lone mixed-ending line in an otherwise-consistent file.
export function dominantEol(text) {
  const lines = String(text).split("\n");
  const nlCount = lines.length - 1;
  const crCount = lines.slice(0, Math.max(0, nlCount)).filter((l) => l.endsWith("\r")).length;
  return nlCount > 0 && crCount > nlCount / 2 ? "\r" : "";
}

// Normalised heading key for cross-document id matching: the verbatim heading line with any
// {id=…} token removed and whitespace collapsed — so "### Foo" in an unstamped buffer matches
// "### Foo {id=x}" in the previously-stamped disk copy of the same slide.
const headingIdKey = (heading) =>
  String(heading).replace(new RegExp(ID_TOKEN_RE.source, "g"), "").replace(/\s+/g, " ").trimEnd();

// Map `normalisedHeading occurrence` → existing {id=…} (heading- or Trigger-line-carried) for
// every stamped block in `text`. Occurrences count on the NORMALISED heading, so a stamped and an
// unstamped rendering of the same heading line up. Feed this (built from the ON-DISK file) into
// stampMissingIds as `preferred` so a save of a stale, never-adopted buffer REUSES the ids the
// previous save already minted for the same headings instead of minting fresh ones — without this,
// every save of an unadopted buffer would re-mint, churning ids and fragmenting each slide's
// ledger version history.
export function preferredIdsFromText(text) {
  const lines = scanLines(text);
  const map = new Map();
  const counts = new Map();
  for (const block of listSlideBlocks(text)) {
    const key = headingIdKey(block.heading);
    const occ = (counts.get(key) || 0) + 1;
    counts.set(key, occ);
    const idLine = idLineIndex(lines, block.start, block.end);
    if (idLine >= 0) map.set(`${key} ${occ}`, lines[idLine].match(ID_TOKEN_RE)[1]);
  }
  return map;
}

// Stamp every ##–###### heading that carries no {id=…} (heading-is-slide model, Task 8: the
// Slide Ledger walks EVERY level now, so every level must be identifiable). Minted ids are written
// through setSlideId — the SAME write-back channel the merge/duplicate ops use — never a raw
// splice, so idProtect semantics (own {id=…} group, body tokens left alone, heading-vs-Trigger-line
// precedence) apply here exactly as they do to a manual stamp. Blocks are addressed by
// {heading, occurrence} taken from a FRESH listSlideBlocks(text) each iteration: stamping only ever
// inserts/edits a Trigger line, never a heading, so headings/occurrences computed up front stay
// valid across the whole loop. `preferred` (see preferredIdsFromText) supplies id REUSE by
// normalised heading + occurrence — a preferred id is used verbatim unless it already appears
// elsewhere in this document (then a fresh id is minted, never a duplicate). Returns
// { text, stamped: [{heading, occurrence, id}] } — stamped is [] (text unchanged, same reference)
// when every heading is already id-ed.
export function stampMissingIds(text, rng = Math.random, { preferred = null } = {}) {
  const eol = dominantEol(text);
  const taken = new Set([...String(text).matchAll(new RegExp(ID_TOKEN_RE.source, "g"))].map((m) => m[1]));
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

  let out = text;
  const stamped = [];
  for (const ref of targets) {
    const pref = preferred?.get(ref.prefKey);
    const id = pref && !taken.has(pref) ? pref : mintId(rng, taken);
    taken.add(id);
    out = setSlideId(out, { heading: ref.heading, occurrence: ref.occurrence }, id, eol);
    stamped.push({ heading: ref.heading, occurrence: ref.occurrence, id });
  }
  return { text: out, stamped };
}

export function deleteSlide(text, ref) {
  const lines = scanLines(text);
  const block = findBlock(listSlideBlocks(text), ref);
  lines.splice(block.start, block.end - block.start);
  return joinPreservingTrailing(lines);
}

// Re-level a markdown block (possibly a subtree with nested headings, any depth 1-6) so its ROOT
// heading sits at `targetDepth` — every OTHER heading inside shifts by the SAME delta (uniform
// subtree shift), so the block's internal nesting survives the move. Fence-aware (a `#`-looking
// line inside a code fence is content, never re-depthed) — deliberately NOT comment-aware, unlike
// 13-slide-ledger's fencedLineFlags: this scans a freshly-supplied block, not a parsed document, so
// there is no pre-existing HTML-comment state to track. Depth is clamped to [2, 6] — 2 because a
// re-levelled block is always a slide, never the deck title; `clamped` is true only when the target
// (BEFORE clamping) would deepen past 6, so callers can warn rather than silently corrupt nesting.
export function relevelBlock(markdown, targetDepth) {
  const lines = String(markdown).split("\n");
  const fenced = new Array(lines.length).fill(false);
  let inFence = false;
  let fenceMark = "";
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (inFence) {
      fenced[i] = true;
      const close = t.match(/^(`{3,})\s*$/);
      if (close && close[1].length >= fenceMark.length) { inFence = false; fenceMark = ""; }
      continue;
    }
    const open = t.match(/^(`{3,})/);
    if (open) { inFence = true; fenceMark = open[1]; fenced[i] = true; }
  }
  const HEADING_ANY_RE = /^(#{1,6})\s/;
  const root = fenced[0] ? null : lines[0]?.match(HEADING_ANY_RE);
  if (!root) return { text: markdown, clamped: false };
  const delta = targetDepth - root[1].length;
  let clamped = false;
  const relevelled = lines.map((l, i) => {
    if (fenced[i]) return l;
    const h = l.match(HEADING_ANY_RE);
    if (!h) return l;
    const raw = h[1].length + delta;
    if (raw > 6) clamped = true;
    const depth = Math.min(6, Math.max(2, raw));
    return "#".repeat(depth) + l.slice(h[1].length);
  });
  return { text: relevelled.join("\n"), clamped };
}

// Insert a NEW slide block: after the referenced block, or appended at the end of the outline
// when ref is null. Two modes:
//   - LEGACY stub (opts.markdown absent, matches every call site before Task 8): a fixed minimal
//     "### <stubTitle>" stub, unconditionally — the author immediately edits it in the slide
//     editor. Returns a plain string, exactly as before (existing callers depend on this shape).
//   - Re-levelling insert (opts.markdown given — e.g. a slide block pulled in from search):
//     the supplied block's heading levels are rewritten relative to the insertion point's PARENT
//     — inserting AFTER ref makes the block ref's LAST CHILD (targetDepth = ref's own depth + 1,
//     subtree shifts uniformly); inserting with no ref lands it at top level (depth 2). Deepening
//     past level 6 clamps (never corrupts) AND surfaces a warning — never silent. Returns
//     { text, warning? } so a clamp is never lost.
export function insertSlide(text, ref = null, stubTitle = "New slide", opts = {}) {
  const { markdown = null } = opts;
  const lines = scanLines(text);

  if (markdown == null) {
    const stub = ["### " + String(stubTitle).replace(/\n/g, " "), "", "- ", ""];
    if (ref) {
      const block = findBlock(listSlideBlocks(text), ref);
      lines.splice(block.end, 0, ...stub);
      return joinPreservingTrailing(lines);
    }
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(...stub);
    return joinPreservingTrailing(lines);
  }

  let insertAt;
  let targetDepth = 2;
  if (ref) {
    const block = findBlock(listSlideBlocks(text), ref);
    const refDepth = (block.heading.match(/^(#{1,6})\s/) || [, ""])[1].length;
    targetDepth = refDepth + 1;
    insertAt = block.end;
  } else {
    insertAt = lines.length;
  }
  const { text: releveled, clamped } = relevelBlock(String(markdown), targetDepth);
  const stubLines = releveled.split("\n");
  if (ref) {
    lines.splice(insertAt, 0, ...stubLines);
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(...stubLines);
  }
  const result = { text: joinPreservingTrailing(lines) };
  if (clamped) {
    result.warning = `insertSlide: target depth ${targetDepth} exceeds max heading depth (6) — clamped, nesting may be flattened`;
  }
  return result;
}

// ── Trigger-line write (the layout try-on op) ────────────────────────────────
//
// Writes `key=value` onto the slide's Trigger line (ADR-0015): creates the line right under
// the heading when missing; otherwise replaces any existing token that resolves to the same
// key (bare word via the Trigger Dictionary, explicit `key=…`, or colon `key:…`) and keeps
// every other token's text verbatim. The heading is NEVER touched — if it carries a same-key
// code, the Trigger line silently wins (documented precedence). Emits the bare-word shorthand
// when the dictionary has one for (key,value), else explicit `key=value`. value=null removes
// the key (and the whole line when it empties).

const TRIGGER_LINE_RE = /^\{[^}]*\}(\s*\{[^}]*\})*$/;

function tokenKey(token) {
  const eq = token.indexOf("=");
  if (eq > 0) return token.slice(0, eq);
  const colon = token.indexOf(":");
  if (colon > 0 && /^[\w-]+$/.test(token.slice(0, colon))) return token.slice(0, colon);
  if (/^[\w-]+$/.test(token)) {
    const resolved = resolveTrigger(token);
    if (resolved) return resolved.key;
  }
  return token; // unknown bare word: its own key (matches the resolver's attrs[tok]=true)
}

function shorthandFor(key, value) {
  // Prefer the dictionary bare word when one maps exactly to (key,value).
  if (typeof value === "string" && /^[\w-]+$/.test(value)) {
    const resolved = resolveTrigger(value);
    if (resolved && resolved.key === key && String(resolved.value) === value) return value;
  }
  return `${key}=${String(value).includes(" ") ? `"${value}"` : value}`;
}

// Raw tokens of a trigger line, text-preserving (quoted values keep their quotes).
// List-valued keys (tags=intro,team — LIST_VALUE_KEYS in 02-triggers-layout.mjs) keep their
// commas inside the token, mirroring tokenizeHeadingAttrs, so a tags token is never split.
function rawTriggerTokens(line) {
  const tokens = [];
  for (const m of line.matchAll(/\{([^}]*)\}/g)) {
    let current = "";
    let inQuote = false;
    for (const ch of m[1]) {
      if (ch === '"') { inQuote = !inQuote; current += ch; continue; }
      if (!inQuote && (/\s/.test(ch) || ch === ",")) {
        if (ch === "," && LIST_VALUE_KEYS.has(tokenKey(current))) { current += ch; continue; }
        if (current) tokens.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    if (current) tokens.push(current);
  }
  return tokens;
}

export function setSlideTrigger(text, ref, key, value) {
  const lines = scanLines(text);
  const block = findBlock(listSlideBlocks(text), ref);
  // Editor semantics (2026-06-12): a layout action means "make this slide's layout X" — a
  // same-key code left on the HEADING would silently lose to the Trigger line (correct by
  // ADR-0015 precedence) but READS as a confusing duplicate, and clearing the line would
  // resurrect it. So the op also scrubs same-key tokens from the heading's trailing groups.
  // This is a user-initiated edit of their own draft, not machine write-back — ADR-0015's
  // "{#id} never stamps headings" rule is untouched. Other heading tokens stay verbatim.
  {
    const headingLine = lines[block.start];
    const m = headingLine.match(/^([\s\S]*?)((?:\s*\{[^}]*\})+)\s*$/);
    if (m) {
      const keep = rawTriggerTokens(m[2]).filter((tok) => tokenKey(tok) !== key);
      const had = rawTriggerTokens(m[2]).length;
      if (keep.length !== had) {
        lines[block.start] = keep.length ? `${m[1].trimEnd()} {${keep.join(" ")}}` : m[1].trimEnd();
      }
    }
  }
  // Locate an existing Trigger line: first non-blank line after the heading, inside the block.
  let lineIdx = -1;
  for (let i = block.start + 1; i < block.end; i += 1) {
    if (!lines[i].trim()) continue;
    if (TRIGGER_LINE_RE.test(lines[i].trim())) lineIdx = i;
    break;
  }
  const keep = lineIdx >= 0
    ? rawTriggerTokens(lines[lineIdx]).filter((tok) => tokenKey(tok) !== key)
    : [];
  if (value != null) keep.push(shorthandFor(key, value));
  if (keep.length === 0) {
    if (lineIdx >= 0) lines.splice(lineIdx, 1);
    return joinPreservingTrailing(lines);
  }
  const rendered = `{${keep.join(" ")}}`;
  if (lineIdx >= 0) lines[lineIdx] = rendered;
  else lines.splice(block.start + 1, 0, rendered);
  return joinPreservingTrailing(lines);
}

// ── Trigger merge for the layout pickers (⌘L) ────────────────────────────────
//
// The renderer pickers used to REPLACE the whole Trigger line with the chosen
// layout token, wiping {id=…} and every other trigger on it (the id-loss bug,
// 2026-07-03 / ADR-0032). This is the safe path: incoming tokens replace only
// same-key existing ones (bare words resolved via the Trigger Dictionary, same
// rule as setSlideTrigger); every other token is kept verbatim. Each token is
// rendered in its OWN {…} group so the editor's `{id=…}` chip/protection regex
// keeps matching. Targets the nearest heading at/above a 1-based line (the
// caret), any depth — the picker's own slide addressing. Returns rewritten
// text, or null when the line sits under no heading (caller must no-op, never
// fall back to line replacement).
export function mergeTriggerAtLine(text, lineNumber, triggerString, eol = "") {
  const lines = scanLines(text);
  const idx0 = Math.min(Math.max(1, lineNumber), lines.length) - 1;
  let headingIdx = -1;
  for (let i = idx0; i >= 0; i -= 1) {
    if (/^#{1,6}\s/.test(lines[i])) { headingIdx = i; break; }
  }
  if (headingIdx < 0) return null;
  const incoming = rawTriggerTokens(triggerString);
  if (incoming.length === 0) return null;
  const incomingKeys = new Set(incoming.map((tok) => tokenKey(tok)));
  // Scrub same-key tokens from the heading's trailing groups (setSlideTrigger semantics);
  // unrelated heading tokens stay, re-rendered one group per token.
  {
    const m = lines[headingIdx].match(/^([\s\S]*?)((?:\s*\{[^}]*\})+)\s*$/);
    if (m) {
      const toks = rawTriggerTokens(m[2]);
      const keep = toks.filter((tok) => !incomingKeys.has(tokenKey(tok)));
      if (keep.length !== toks.length) {
        lines[headingIdx] = keep.length
          ? `${m[1].trimEnd()} ${keep.map((t) => `{${t}}`).join(" ")}`
          : m[1].trimEnd();
      }
    }
  }
  // Existing logical Trigger line: merge every consecutive Trigger-only line after the heading.
  const block = triggerLineBlock(lines, headingIdx);
  const lineIdx = block?.start ?? -1;
  const existing = block
    ? lines.slice(block.start, block.end).flatMap(rawTriggerTokens)
    : [];
  const ids = existing.filter((tok) => tokenKey(tok) === "id");
  const keptId = ids.at(-1);
  if (ids.length > 1 && keptId) console.warn(`duplicate-slide-id-merged:${keptId.slice(3)}`);
  const kept = lineIdx >= 0
    ? existing.filter((tok) => !incomingKeys.has(tokenKey(tok)))
      .filter((tok) => tokenKey(tok) !== "id" || tok === keptId)
    : [];
  const rendered = [...kept, ...incoming].map((t) => `{${t}}`).join(" ");
  if (lineIdx >= 0) {
    // Rebuilt from token content only — carry the REPLACED line's own trailing \r (if any, in a
    // CRLF document lines keep it embedded since scanLines splits on "\n" only) so an edited
    // Trigger line never becomes the one mixed-ending line in an otherwise-consistent file.
    const trailing = lines[lineIdx].endsWith("\r") ? "\r" : "";
    lines.splice(lineIdx, block.end - block.start, rendered + trailing);
  } else {
    // A BRAND-NEW line: no prior bytes to inherit from, so use the caller-supplied dominant eol.
    lines.splice(headingIdx + 1, 0, rendered + eol);
  }
  return joinPreservingTrailing(lines);
}

// ── Per-item icon override (the "Edit icons" op) ──────────────────────────────
//
// Pins (or clears) the icon on ONE top-level list item of a slide, by writing the canonical
// `{icon=KEY}` token at the end of that item's line. The "Edit icons" UI addresses an item by
// its position among the slide block's TOP-LEVEL (indentation-0) list-item lines, in document
// order across every list/card in the block — the same lines the lexer turns into iconable
// items (sub-bullets are indented and never carry icons). itemIndex is 0-based.
//
// Token-precise: only that one line changes. Any existing trailing icon token — explicit
// `{icon=…}` or the bare `{name}` shorthand (a single icon-shaped token) — is replaced;
// ordinary trailing braces like `{a, b}` (spaces/commas) are left alone. iconKey=null clears.
// The op trusts the key shape; the server validates it against the icon set before calling.

// A top-level (indent-0) list-item line — mirrors the lexer's takeList row match at depth 0.
const TOP_LEVEL_ITEM_RE = /^(?:[-*]\s+|\d+[.)]\s+)\S/;
// A trailing icon token: `{icon=name}` or a bare single icon-shaped `{name}` (no spaces/commas).
const TRAILING_ICON_TOKEN_RE = /\s*\{\s*(?:icon\s*=\s*)?[A-Za-z0-9:._-]+\s*\}\s*$/;

export function setListItemIcon(text, ref, itemIndex, iconKey) {
  const lines = scanLines(text);
  const block = findBlock(listSlideBlocks(text), ref);
  let count = -1;
  for (let i = block.start; i < block.end; i += 1) {
    if (!TOP_LEVEL_ITEM_RE.test(lines[i])) continue;
    count += 1;
    if (count !== itemIndex) continue;
    const base = lines[i].replace(TRAILING_ICON_TOKEN_RE, "");
    lines[i] = iconKey ? `${base} {icon=${iconKey}}` : base;
    return joinPreservingTrailing(lines);
  }
  throw new Error(`outline-edit: top-level list item ${itemIndex} not found under ${JSON.stringify(ref.heading)} (occurrence ${ref.occurrence || 1})`);
}

// ── Icon model (the "Edit icons" read side) ───────────────────────────────────
//
// Text → the data the Edit-icons UI needs, derived from the SAME line scan setListItemIcon uses
// so item indices line up exactly. For every ICON-BEARING slide (its heading / Trigger line
// carries an icon trigger), each top-level list item becomes { index, text, current, candidates }:
//   index      0-based position among the block's top-level item lines (the op's address)
//   text       the bullet text with any trailing icon token stripped
//   current    the pinned icon key (normalised) if the bullet already has {icon=…}/{name}, else null
//   candidates ranked auto-match keys [{key, source}] (top 8) — empty array = a gap to fill
// Returns one entry per icon-bearing slide: { title, heading, occurrence, items: [...] }. The
// UI renders glyphs from these keys and writes a choice back with setListItemIcon(ref, index, key).

const ICON_TRIGGER_WORDS = new Set(["icons", "iconlist", "iconrow", "logolist"]);

function blockTriggerWords(lines, block) {
  const groups = [];
  const headingMatch = lines[block.start].match(/((?:\s*\{[^}]*\})+)\s*$/);
  if (headingMatch) groups.push(headingMatch[1]);
  for (let i = block.start + 1; i < block.end; i += 1) {
    if (!lines[i].trim()) continue;
    if (TRIGGER_LINE_RE.test(lines[i].trim())) groups.push(lines[i]);
    break; // first non-blank line only — a Trigger line must sit directly under the heading
  }
  const words = new Set();
  for (const g of groups) for (const tok of rawTriggerTokens(g)) words.add(tok.toLowerCase());
  return words;
}

export function collectIconModel(text) {
  const lines = scanLines(text);
  const out = [];
  for (const block of listSlideBlocks(text)) {
    const words = blockTriggerWords(lines, block);
    if (![...words].some((w) => ICON_TRIGGER_WORDS.has(w))) continue; // not an icon slide
    const items = [];
    let index = -1;
    for (let i = block.start; i < block.end; i += 1) {
      if (!TOP_LEVEL_ITEM_RE.test(lines[i])) continue;
      index += 1;
      const body = lines[i].replace(/^(?:[-*]\s+|\d+[.)]\s+)/, "");
      const tokenMatch = body.match(TRAILING_ICON_TOKEN_RE);
      const clean = body.replace(TRAILING_ICON_TOKEN_RE, "").trim();
      let current = null;
      if (tokenMatch) current = normalizeIconOverrideKey(tokenMatch[0].replace(/[\s{}]/g, "").replace(/^icon=/i, ""));
      const candidates = iconCandidatesV3(clean).slice(0, 8).map(({ key, source }) => ({ key, source }));
      items.push({ index, text: clean, current, candidates });
    }
    if (items.length) out.push({ title: block.title, heading: block.heading, occurrence: block.occurrence, items });
  }
  return out;
}

// ── Slide tags (ADR-0037) ─────────────────────────────────────────────────────
//
// A slide's tags live as ONE `tags=a,b` token on its Trigger line (per-occurrence storage;
// lowercase-kebab; the unquoted comma form is the canonical spelling — the tokenisers above
// treat commas after `tags=` as part of the value). Writes are token-precise and merge-only:
// other tokens (including {id=…}) are kept verbatim, each in its OWN group (the same id-guard
// rule as mergeTriggerAtLine); the token is created when absent and removed cleanly when the
// last tag goes (the whole line goes too when it empties).

// Canonical lowercase-kebab tag form (mirrors the picker's create-row hint and the boundary
// normalisation in src/shared/tags.ts — keep the three in sync): lowercase, whitespace → '-',
// anything outside [a-z0-9-] dropped, runs of '-' collapsed, edge '-' trimmed.
export function normalizeTag(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Parse a raw `tags=` token VALUE ("Intro, Team" / "intro,team" / quoted) into the normalised,
// deduped tag list (order preserved). Empty / absent → [].
export function parseTagsValue(value) {
  const out = [];
  for (const part of String(value ?? "").replace(/^"|"$/g, "").split(",")) {
    const tag = normalizeTag(part);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// The tags a slide block currently carries: the union of `tags=` tokens on its heading's
// trailing groups and its Trigger line (heading-carried tags are read so a write can absorb
// them onto the Trigger line — the same scrub-the-heading move setSlideTrigger makes).
function blockTagTokens(lines, block) {
  const groups = [];
  const headingMatch = lines[block.start].match(/((?:\s*\{[^}]*\})+)\s*$/);
  if (headingMatch) groups.push(headingMatch[1]);
  const tl = blockTriggerLineIndex(lines, block);
  if (tl >= 0) groups.push(lines[tl]);
  const tags = [];
  for (const g of groups) {
    for (const tok of rawTriggerTokens(g)) {
      if (tokenKey(tok) !== "tags") continue;
      const eq = tok.indexOf("=");
      for (const t of parseTagsValue(eq > 0 ? tok.slice(eq + 1) : "")) {
        if (!tags.includes(t)) tags.push(t);
      }
    }
  }
  return tags;
}

// The block's Trigger line index (tolerant shared read rule: first non-blank line after the
// heading, iff it is a `{…}`-only line — blank lines tolerated, same as 13-slide-ledger's
// triggerLineIndex), or -1.
function blockTriggerLineIndex(lines, block) {
  for (let i = block.start + 1; i < block.end; i += 1) {
    if (!lines[i].trim()) continue;
    return TRIGGER_LINE_RE.test(lines[i].trim()) ? i : -1;
  }
  return -1;
}

export function readSlideTags(text, ref) {
  const lines = scanLines(text);
  const block = findBlock(listSlideBlocks(text), ref);
  return blockTagTokens(lines, block);
}

// Merge tags onto ONE slide block: final set = (existing ∪ add) ∖ remove, all normalised.
// Pure text→text; returns { text, tags } (tags = the block's final tag list). Everything
// outside the touched line(s) is byte-identical; a no-op write returns the SAME text reference.
// `eol` is the trailing character for a BRAND-NEW Trigger line (dominantEol), never applied to
// an existing line (its own trailing \r is preserved, as in mergeTriggerAtLine).
export function applySlideTags(text, ref, { add = [], remove = [] } = {}, eol = "") {
  const addNorm = add.map(normalizeTag).filter(Boolean);
  const removeNorm = new Set(remove.map(normalizeTag).filter(Boolean));
  const lines = scanLines(text);
  const block = findBlock(listSlideBlocks(text), ref);
  const existing = blockTagTokens(lines, block);
  const merged = [];
  for (const t of [...existing, ...addNorm]) {
    if (!removeNorm.has(t) && !merged.includes(t)) merged.push(t);
  }
  const sameAsExisting =
    merged.length === existing.length && merged.every((t, i) => t === existing[i]);

  // Scrub any heading-carried tags token (they are absorbed into the Trigger line, or dropped
  // when the final set is empty) — other heading tokens stay, re-rendered one group per token.
  let headingHadTags = false;
  {
    const m = lines[block.start].match(/^([\s\S]*?)((?:\s*\{[^}]*\})+)\s*$/);
    if (m) {
      const toks = rawTriggerTokens(m[2]);
      const keep = toks.filter((tok) => tokenKey(tok) !== "tags");
      if (keep.length !== toks.length) {
        headingHadTags = true;
        lines[block.start] = keep.length
          ? `${m[1].trimEnd()} ${keep.map((t) => `{${t}}`).join(" ")}`
          : m[1].trimEnd();
      }
    }
  }
  const tl = blockTriggerLineIndex(lines, block);
  const kept = tl >= 0 ? rawTriggerTokens(lines[tl]).filter((tok) => tokenKey(tok) !== "tags") : [];
  const hadTagsToken = tl >= 0 && rawTriggerTokens(lines[tl]).length !== kept.length;
  // True no-op (same tag set, canonical token already in place, nothing on the heading):
  // hand back the SAME text so callers can skip the write entirely.
  if (sameAsExisting && !headingHadTags) {
    const canonical = merged.length ? `tags=${merged.join(",")}` : null;
    const current = tl >= 0
      ? rawTriggerTokens(lines[tl]).find((tok) => tokenKey(tok) === "tags") ?? null
      : null;
    if (current === canonical) return { text, tags: merged };
  }
  const tokens = merged.length ? [...kept, `tags=${merged.join(",")}`] : kept;
  if (tl >= 0) {
    if (tokens.length === 0) {
      lines.splice(tl, 1); // the tags token was the line's last — the line goes with it
    } else {
      const trailing = lines[tl].endsWith("\r") ? "\r" : "";
      lines[tl] = tokens.map((t) => `{${t}}`).join(" ") + trailing;
    }
  } else if (merged.length) {
    // No Trigger line yet — mint one directly under the heading, own-group rendering.
    lines.splice(block.start + 1, 0, tokens.map((t) => `{${t}}`).join(" ") + eol);
  } else if (!headingHadTags && !hadTagsToken) {
    return { text, tags: merged }; // nothing carried tags and nothing to write
  }
  return { text: joinPreservingTrailing(lines), tags: merged };
}

// Every block in `text` carrying `{id=…}` equal to `id` (heading or Trigger line — the shared
// idLineIndex read rule), as {heading, occurrence} refs for applySlideTags. Normally one block;
// a same-outline id collision returns all of them (tagging every copy of one identity is
// harmless — ADR-0037 aggregates by identity anyway).
export function blockRefsForId(text, id) {
  const lines = scanLines(text);
  const refs = [];
  for (const block of listSlideBlocks(text)) {
    const idLine = idLineIndex(lines, block.start, block.end);
    if (idLine >= 0 && lines[idLine].match(ID_TOKEN_RE)?.[1] === id) {
      refs.push({ heading: block.heading, occurrence: block.occurrence });
    }
  }
  return refs;
}
