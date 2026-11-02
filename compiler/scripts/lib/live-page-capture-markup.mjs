// Saved views of a live web page, as SLIDE MARKUP: the one definition the compiler's lexer, the
// editor's inspector and the capture writer's outline edit share (owner request 2026-10-27:
// "insert the screenshots in the slide with markup to show that they're capture alternatives").
//
// A saved view is an image line marked {capture}, written under the web page it is a view of:
//
//   [Embed: https://example.org]
//   ![Saved view, 27 Oct 2026 11:05](assets/live-page-captures/c6f6328818f6dec4.jpg){capture}
//   ![Entire page, 27 Oct 2026 11:07](assets/live-page-captures/1a2b3c4d5e6f7a8b.jpg){capture}
//
// It is the existing image syntax with a trailing curly token (as `{play-on-next}`, `{autoplay}`), so
// it reads, edits, moves and travels with the slide like any line. Rules:
//   - A {capture} line belongs to the NEAREST web page embed above it on the same slide (`[Embed: …]`
//     or a bare http(s) address line). Lines in order are the gallery in order; deleting a line takes
//     that view off the slide (the picture and its record stay in the talk's folder).
//   - It is never an ordinary slide image: with no web page above it on the slide it shows nothing.
//   - Only the capture writer's own pictures count: the path must be exactly
//     `assets/live-page-captures/<16 hex>.jpg` (live-page-captures.mjs); any other path on a {capture}
//     line is not a saved view (the compiler warns and shows nothing for it).
//   - The words in [ ] are for the author; the date shown under a view comes from its record.
// The first time a view is placed under a page, the same one edit also writes, directly under the
// embed, the marker line
//
//   <!-- saved views {capture} -->
//
// (an HTML comment: author-only, shown nowhere). It says that this embed's saved views are its
// {capture} lines, so deleting the last line leaves the page with none. It is in the outline, written
// in the same transaction as the lines, so it exists exactly when that edit happened: a save whose
// placement failed or was refused changes nothing (review 2026-10-27, P2/P3).
// Compatibility: an embed with no marker and no {capture} line shows the views recorded for its
// address in assets/live-page-captures/ before this markup (alpha.14/15: records without
// `slideMarkup`). The first placement under it writes their lines too, after the marker. A view saved
// for the markup (`slideMarkup: true`) shows only through a line: one never placed, or whose line was
// deleted, stays in the talk folder and shows nowhere. Nothing recorded is ever removed.
//
// Pure (no fs): safe in the renderer.
import { IMAGE_SYNTAX_RE } from "./image-line-rules.mjs";
import { isBareUrl, normalizeEmbedUrl } from "./02-triggers-layout.mjs";
import { isCaptureImagePath, normaliseCaptureUrl } from "./live-page-captures.mjs";
import { preContentWindow, resolveSlideId } from "./slide-id.mjs";
import { slideBlockEnd } from "./board-slide.mjs";
import { CAPTURE_VIEWS_MARKER, isNotesCloseLine, isNotesOpenLine } from "./outline-regions.mjs";

export const CAPTURE_TOKEN_RE = /\{\s*capture\s*\}/i;
/** The marker line: this embed's saved views are its {capture} lines (exactly this, alone on its line). */
export { CAPTURE_VIEWS_MARKER };
/** True when a line is the marker line. */
export function isCaptureViewsMarker(line) {
  return String(line ?? "").trim() === CAPTURE_VIEWS_MARKER;
}

/**
 * blankHtmlComments (html-comments.mjs), except that a comment which is exactly the marker, alone on
 * its line, is kept, so the compiler's slide reader sees it. Any other comment (one that merely
 * contains the marker's words, or spans lines) is blanked as before; newlines are kept either way.
 */
export function blankHtmlCommentsKeepingCaptureMarkers(text) {
  const source = String(text ?? "");
  return source.replace(/<!--[\s\S]*?-->/g, (m, at) => {
    if (m === CAPTURE_VIEWS_MARKER) {
      const start = source.lastIndexOf("\n", at - 1) + 1;
      const nl = source.indexOf("\n", at);
      const line = source.slice(start, nl < 0 ? source.length : nl);
      if (line.replace(/\r$/, "").trim() === CAPTURE_VIEWS_MARKER) return m;
    }
    return m.replace(/[^\n]/g, "");
  });
}
const EMBED_LINE_RE = /^\[(?:Embed):\s*(.+?)\]$/i;
const FENCE_RE = /^(`{3,}|~{3,})/;

/** True when an image line's trailing tokens (IMAGE_SYNTAX_RE group 4) carry {capture}. */
export function hasCaptureToken(tokens) {
  return CAPTURE_TOKEN_RE.test(String(tokens || ""));
}

/** One line read as a {capture} line: `{ alt, src, savedView }` (savedView: the path is a capture writer's picture), else null. */
export function readCaptureLine(line) {
  const m = String(line ?? "").trim().match(IMAGE_SYNTAX_RE);
  if (!m || !hasCaptureToken(m[4])) return null;
  return { alt: m[1] || "", src: m[2], savedView: isCaptureImagePath(m[2]) };
}

/** The web page address a line embeds (normalised as the gallery keys it), else null. */
export function embedLinePageUrl(line) {
  const t = String(line ?? "").trim();
  const m = t.match(EMBED_LINE_RE);
  const raw = m ? m[1].trim() : (isBareUrl(t) ? t : null);
  if (!raw || !/^https?:/i.test(raw)) return null;
  return normaliseCaptureUrl(normalizeEmbedUrl(raw));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The words a new {capture} line is written with: what it is and when (UTC, from the record's ISO time). */
export function captureLineAlt(capturedAt, mode) {
  const d = new Date(String(capturedAt));
  const when = Number.isNaN(d.getTime()) ? "" : ` ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${mode === "page" ? "Entire page" : "Saved view"},${when}`.replace(/,$/, "");
}

/** The {capture} line for a saved picture. Throws `capture-invalid` for a path that is not a capture writer's picture. */
export function captureMarkupLine(image, capturedAt, mode) {
  if (!isCaptureImagePath(image)) throw new Error("capture-invalid");
  return `![${captureLineAlt(capturedAt, mode).replace(/[[\]]/g, "")}](${image}){capture}`;
}

/**
 * The web pages of a slide's lines and their {capture} lines, in order. `lines` are the slide's own
 * lines (heading first); lines inside code fences and `:::notes` blocks are never read.
 * → `{ pages: [{ pageUrl, line, managed, marker, captures: [{ alt, src, savedView, line }] }], orphans: [{ src, line }] }`
 * (`managed`: the marker line is under this embed, at line `marker`).
 */
export function slideCaptureMarkup(lines) {
  // Use the compiler's comment visibility rules; blanking preserves line indices for placement.
  lines = blankHtmlCommentsKeepingCaptureMarkers(lines.join("\n")).split("\n");
  const pages = [];
  const orphans = [];
  let fence = null;
  let notes = false;
  for (let i = 0; i < lines.length; i += 1) {
    const t = String(lines[i] ?? "").replace(/\r$/, "").trim();
    if (fence) { if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(t)) fence = null; continue; }
    const open = t.match(FENCE_RE);
    if (open) { fence = open[1]; continue; }
    // The compiler's notes rule (outline-regions.mjs): exactly `:::notes`; `::: notes` is text.
    if (isNotesOpenLine(t)) { notes = true; continue; }
    if (notes) { if (isNotesCloseLine(t)) notes = false; continue; }
    const pageUrl = embedLinePageUrl(t);
    if (pageUrl) { pages.push({ pageUrl, line: i, managed: false, marker: null, captures: [] }); continue; }
    if (isCaptureViewsMarker(t)) {
      const page = pages[pages.length - 1];
      if (page && !page.managed) { page.managed = true; page.marker = i; }
      continue;
    }
    const capture = readCaptureLine(t);
    if (!capture) continue;
    if (pages.length) pages[pages.length - 1].captures.push({ ...capture, line: i });
    else orphans.push({ src: capture.src, line: i });
  }
  return { pages, orphans };
}

/**
 * The id the compiled deck gives the slide (the id a capture is reported for): the shared resolver's
 * (slide-id.mjs, an `{id=…}` group), else the last `id=` token in a many-token group of the heading or
 * its Trigger lines (`{layout=media id=page}`), as the heading's attributes read it.
 */
function deckSlideId(lines, start, end) {
  const resolved = resolveSlideId(lines, start, end);
  if (resolved) return resolved.id;
  const { end: prelude } = preContentWindow(lines, start, end);
  let id = null;
  for (let line = start; line < prelude; line += 1) {
    for (const group of String(lines[line]).matchAll(/\{([^}]*)\}/g)) {
      for (const m of group[1].matchAll(/(?:^|\s)id=([A-Za-z0-9_-]+)(?=\s|$)/g)) id = m[1];
    }
  }
  return id;
}

/** Heading line indices of every slide (outside code fences), with each slide's end and resolved id. */
function slidesOf(lines) {
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const t = String(lines[i]).replace(/\r$/, "");
    if (fence) { if (new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(t)) fence = null; continue; }
    const open = t.trim().match(FENCE_RE);
    if (open) { fence = open[1]; continue; }
    if (!/^#{1,6}\s/.test(t)) continue;
    const end = slideBlockEnd(lines, i);
    out.push({ start: i, end, id: deckSlideId(lines, i, end) });
  }
  return out;
}

const headingKey = (line) => String(line ?? "").replace(/\r$/, "").trim();

/**
 * Which heading a compiled slide came from, said so that it can be found again in a later text: the
 * heading line's words. `sourceLine` is the compiler's 1-based line of the slide (its projection's
 * `sourceLine`). Null when that line is no heading, or when another slide has the same heading line:
 * a slide without an id of its own is identified by a heading no other slide has, never by its place
 * among identical ones (review 2026-10-27, P2: inserting an identical heading moves which slide an
 * occurrence names, and the deck's derived id belongs to the text it was compiled from).
 */
export function slideHeadingRef(text, sourceLine) {
  const lines = String(text ?? "").split(/\r?\n/);
  const at = Number(sourceLine) - 1;
  if (!Number.isSafeInteger(at) || at < 0 || at >= lines.length || !/^#{1,6}\s/.test(lines[at])) return null;
  const heading = headingKey(lines[at]);
  return slidesOf(lines).filter((s) => headingKey(lines[s.start]) === heading).length === 1 ? { heading } : null;
}

/**
 * A saved view's {capture} line put under its slide's web page: the whole outline edit, planned
 * against `text` (the current editor buffer or file) and applied in full or not at all. Pure.
 *
 * `slide`: the deck's slide id, or `{ id, heading }`. A slide whose text carries the id is that slide
 * (the id on two slides: refused). A slide with no id of its own (the compiler derives one from its
 * heading) is the ONE slide whose heading line is `heading` (slideHeadingRef) and that carries no
 * other id; two or more such headings in the text changed: refused (`capture-slide-ambiguous`), never
 * a guess at one of them. The page is the first embed of `pageUrl` on that slide.
 *
 * The edit, all under that one embed, nothing anywhere else:
 *   - embed with the marker: the new line after its last {capture} line (or after the marker);
 *   - embed without it: the marker directly under the embed, then (only if it had no {capture} line
 *     yet) the `earlier` lines, the views recorded before the markup, then any lines it had, then
 *     the new line last.
 * The same picture already under it: unchanged. The embed line's indentation and the text's line
 * ending are kept.
 *
 * → `{ text, onSlide, reason }`. Refused (`onSlide` false; `reason` `capture-slide-missing` (no such
 * slide, or its id on several), `capture-slide-ambiguous` or `capture-embed-missing`): `text` is
 * `text`, byte for byte. Throws `capture-invalid`.
 */
export function placeCaptureLines(text, slide, pageUrl, line, earlier = []) {
  const page = normaliseCaptureUrl(pageUrl);
  const capture = readCaptureLine(line);
  if (!page || !capture || !capture.savedView) throw new Error("capture-invalid");
  const before = [];
  for (const l of Array.isArray(earlier) ? earlier : []) {
    const t = String(l).trim();
    const c = readCaptureLine(t);
    if (c?.savedView && c.src !== capture.src && !before.some((b) => readCaptureLine(b).src === c.src)) before.push(t);
  }
  const ref = typeof slide === "string" ? { id: slide } : (slide && typeof slide === "object" ? slide : {});
  const slideId = typeof ref.id === "string" ? ref.id : "";
  const source = String(text);
  const refused = (reason) => ({ text: source, onSlide: false, reason });
  if (!slideId) return refused("capture-slide-missing");
  const eol = /\r\n/.test(source) ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const found = captureTargetSlide(lines, ref, slideId);
  if (found.reason) return refused(found.reason);
  const target = found.target;
  const visibleLines = blankHtmlCommentsKeepingCaptureMarkers(source).split(/\r?\n/);
  const p = slideCaptureMarkup(visibleLines.slice(target.start, target.end)).pages.find((x) => x.pageUrl === page);
  if (!p) return refused("capture-embed-missing");
  if (p.captures.some((c) => c.src === capture.src)) return { text: source, onSlide: true };
  const at = (n) => target.start + n;
  const indent = (lines[at(p.line)].match(/^\s*/) || [""])[0];
  const put = (afterLine, added) => lines.splice(afterLine + 1, 0, ...added.map((l) => `${indent}${l}`));
  const last = p.captures.length ? p.captures[p.captures.length - 1].line : null;
  const anchors = p.managed ? [Math.max(p.marker, last ?? p.marker)] : [last ?? p.line, p.line];
  // An inserted marker must never close an author comment that starts on its anchor line.
  if (anchors.some((n) => lines[at(n)] !== visibleLines[at(n)])) return refused("capture-embed-missing");
  if (p.managed) {
    put(at(Math.max(p.marker, last ?? p.marker)), [line.trim()]);
  } else {
    // Bottom first, so the upper index stays right.
    put(at(last ?? p.line), [line.trim()]);
    put(at(p.line), [CAPTURE_VIEWS_MARKER, ...(p.captures.length ? [] : before)]);
  }
  return { text: lines.join(eol), onSlide: true };
}

/** The slide a saved view's line is for (placeCaptureLines's rule): `{ target }` or `{ reason }`. */
function captureTargetSlide(lines, ref, slideId) {
  const all = slidesOf(lines);
  const explicit = all.filter((s) => s.id === slideId);
  if (explicit.length === 1) return { target: explicit[0] };
  if (!explicit.length && typeof ref.heading === "string" && ref.heading) {
    const named = all.filter((s) => headingKey(lines[s.start]) === ref.heading);
    if (named.length > 1) return { reason: "capture-slide-ambiguous" };
    if (named.length === 1 && (named[0].id === null || named[0].id === slideId)) return { target: named[0] };
  }
  return { reason: "capture-slide-missing" };
}

/**
 * A saved view taken off its slide: every {capture} line for `image` under ONE embed of `pageUrl` on
 * the slide removed, and nothing else; the picture and its record stay in the talk folder.
 *
 * Who says which slide and which embed (review e3b41fd1, P2 x2): `slide` is `{ id, heading?, line? }`.
 * `id` and `heading` must come from the same compiled revision (the compile that produced the slide
 * the caller shows: its id, and the heading line that compile read, never a line of a newer text read
 * at the old line number); the slide is then found in `text` as placeCaptureLines finds it. `line`
 * (1-based) is where the caller showed that slide's heading: when given, the slide found must start
 * there in `text`, else the caller was showing another slide and nothing is removed; a slide found
 * by its heading alone (no id of its own in `text`) needs `line`. `embed` is
 * `{ index, of }`: the caller showed `of` embeds of this address on the slide and the view was listed
 * under the `index`-th (0-based); the slide must still have exactly `of`, and only that one is
 * changed. Without `embed`, a slide with the address embedded more than once is refused.
 *
 * An embed without the marker gets it in the same edit, so the views recorded before the markup do
 * not come back when its last line goes. Planned against `text` (the current editor buffer) and
 * applied in full or not at all.
 * → `{ text, removed, reason }`: refused (`removed` false, `text` byte for byte) with `reason`
 * `capture-slide-missing`, `capture-slide-ambiguous`, `capture-slide-moved`, `capture-embed-missing`,
 * `capture-embed-ambiguous` or `capture-view-missing` (no such line there now). Pure.
 */
export function removeCaptureLine(text, slide, pageUrl, image, embed) {
  const page = normaliseCaptureUrl(pageUrl);
  const source = String(text);
  const refused = (reason) => ({ text: source, removed: false, reason });
  if (!page || !isCaptureImagePath(image)) return refused("capture-view-missing");
  const ref = typeof slide === "string" ? { id: slide } : (slide && typeof slide === "object" ? slide : {});
  const slideId = typeof ref.id === "string" ? ref.id : "";
  if (!slideId) return refused("capture-slide-missing");
  const eol = /\r\n/.test(source) ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const found = captureTargetSlide(lines, ref, slideId);
  if (found.reason) return refused(found.reason);
  const target = found.target;
  // A slide found by its heading (no id of its own in the text) is confirmed only by where it was shown.
  if (target.id !== slideId && ref.line == null) return refused("capture-slide-moved");
  if (ref.line != null && ref.line !== target.start + 1) return refused("capture-slide-moved");
  const visibleLines = blankHtmlCommentsKeepingCaptureMarkers(source).split(/\r?\n/);
  const same = slideCaptureMarkup(visibleLines.slice(target.start, target.end)).pages.filter((x) => x.pageUrl === page);
  if (!same.length) return refused("capture-embed-missing");
  let p;
  if (embed && typeof embed === "object") {
    if (!Number.isInteger(embed.index) || !Number.isInteger(embed.of) || embed.of !== same.length || embed.index < 0 || embed.index >= same.length) return refused("capture-embed-ambiguous");
    p = same[embed.index];
  } else {
    if (same.length > 1) return refused("capture-embed-ambiguous");
    p = same[0];
  }
  const at = (n) => target.start + n;
  const gone = p.captures.filter((c) => c.src === image).map((c) => at(c.line));
  if (!gone.length || gone.some((n) => lines[n] !== visibleLines[n])) return refused("capture-view-missing");
  for (const n of [...gone].sort((a, b) => b - a)) lines.splice(n, 1);
  if (!p.managed) {
    if (lines[at(p.line)] !== visibleLines[at(p.line)]) return refused("capture-embed-missing");
    const indent = (lines[at(p.line)].match(/^\s*/) || [""])[0];
    lines.splice(at(p.line) + 1, 0, `${indent}${CAPTURE_VIEWS_MARKER}`);
  }
  return { text: lines.join(eol), removed: true };
}

/**
 * The saved views a slide shows for its page, read from the outline text as it is now (every surface's
 * one source: the inspector, the capture window, the presenter and audience decks). `slide` is found
 * as placeCaptureLines finds it (its id, or a heading no other slide has).
 * → `{ managed: true, views: [{ image, alt }] }` when the embed is in the markup (its marker or a
 * {capture} line), `{ managed: false, views: [] }` for an embed still on the compatibility listing
 * (the compiled deck says what it shows), or `{ reason }` when the slide or page is not found.
 */
export function slideSavedViewLines(text, slide, pageUrl) {
  const page = normaliseCaptureUrl(pageUrl);
  const ref = typeof slide === "string" ? { id: slide } : (slide && typeof slide === "object" ? slide : {});
  const slideId = typeof ref.id === "string" ? ref.id : "";
  if (!page || !slideId) return { reason: "capture-slide-missing" };
  const lines = String(text ?? "").split(/\r?\n/);
  const found = captureTargetSlide(lines, ref, slideId);
  if (found.reason) return { reason: found.reason };
  const same = slideCaptureMarkup(lines.slice(found.target.start, found.target.end)).pages.filter((x) => x.pageUrl === page);
  if (!same.length) return { reason: "capture-embed-missing" };
  // The address embedded more than once: the deck shows the views of all of them, each picture once.
  // Any of them still on the compatibility listing: the compiled deck decides for the slide.
  if (same.some((p) => !p.managed && !p.captures.length)) return { managed: false, views: [] };
  const seen = new Set();
  const views = [];
  for (const p of same) for (const c of p.captures) {
    if (!c.savedView || seen.has(c.src)) continue;
    seen.add(c.src);
    views.push({ image: c.src, alt: c.alt });
  }
  return { managed: true, views };
}

/**
 * placeCaptureLines for one saved view with no earlier views: the outline with its line added, or
 * unchanged when the slide already shows that picture. Throws `capture-slide-missing`,
 * `capture-slide-ambiguous`, `capture-embed-missing` or `capture-invalid`: the caller then leaves the
 * outline alone.
 */
export function withCaptureLine(text, slide, pageUrl, line) {
  const placed = placeCaptureLines(text, slide, pageUrl, line);
  if (!placed.onSlide) throw new Error(placed.reason);
  return placed.text;
}

/** The slide's web pages and their {capture} lines, read from a slide's text (the inspector's block). */
export function captureMarkupOfSlideText(slideText) {
  return slideCaptureMarkup(String(slideText ?? "").split(/\r?\n/));
}
