import { resolveTrigger, resolveDynamicTrigger } from "../triggers.mjs";
import { escapeHtml } from "./01-cli-utils.mjs";
import { LIST_VALUE_KEYS, TRIGGER_LINE_RE, tokenizeTriggerBody } from "./trigger-tokenizer.mjs";

// Tokenise the inside of a `{…}` attribute trailer into tokens separated by whitespace OR a
// comma, EXCEPT that a double-quoted value may contain spaces and commas: `kicker="A, B"` is one
// token. A quoted value runs from the opening `"` to the next `"`; there is NO nested-quote
// support — a `"` always closes the value (escaped quotes inside a value are not supported; keep
// values quote-free). Bare flags (`sub`) and unquoted `key=value` tokens tokenise as before.
//
// Comma is a separator so concatenated triggers `{numbered,reveal}` split exactly like the
// space form `{numbered reveal}` (ADR-0004 concatenation; both merge into one attrs set).
// =============================================================================
// 2. Trigger & heading-attribute parsing, layout decisions — curly attrs, Trigger Dictionary application, layout inference
// =============================================================================

// Keys whose VALUE is a comma-separated LIST (ADR-0037 `tags=intro,team`). For these — and only
// these — a comma after the `=` is part of the value, not a token separator, so the unquoted ADR
// storage form tokenises as one token. Every other comma keeps its ADR-0004 concatenation meaning
// (`{numbered,reveal}` still splits). Mirrored by 12-outline-edit.mjs rawTriggerTokens — keep in sync.
export { LIST_VALUE_KEYS };

// Keys that legitimately accept a value WITHOUT being a Trigger Dictionary bare word — these are
// parameterised attributes always written as `key=value` (or, for `sub`, as a bare flag handled
// by the dictionary). A bare token that is NOT in the dictionary and NOT one of these is an
// unknown trigger → `unknown-trigger:<word>` warning (never a silent ignore; ADR-0004).
// `title=show` is the one bare-ish exception kept as an explicit key=value (no bare alias).
//
// parseHeadingAttrs (ADR-0004 resolver):
//   - Collects ALL trailing `{…}` brace groups so adjacent braces concatenate:
//       `### T {numbered}{reveal}` ≡ `{numbered reveal}` ≡ `{numbered,reveal}`.
//   - Each token is either explicit `key=value` (kept verbatim), or a BARE word resolved through
//     the Trigger Dictionary to its (key,value). An unknown bare word → `unknown-trigger:<word>`.
//   - If two tokens set the SAME key to DIFFERENT values, LAST WINS and a
//     `trigger-conflict:<key>:<old>→<new>` warning is emitted.
// Returns { title, attrs, warnings } — warnings is always an array (possibly empty); callers
// fold it into the build warnings list.
export function parseHeadingAttrs(rawTitle) {
  // Peel trailing `{…}` groups off the end of the heading, right-to-left, so any number of
  // adjacent or whitespace-separated brace groups concatenate. Stop at the first non-brace
  // trailing content (that is the real title). A group may be empty (`{}` → no tokens).
  let title = rawTitle.trimEnd();
  const groups = [];
  for (;;) {
    const m = title.match(/^([\s\S]*?)\s*\{([^}]*)\}$/);
    if (!m) break;
    groups.unshift(m[2]);
    title = m[1].trimEnd();
  }
  const attrs = {};
  const warnings = [];
  const setKey = (key, value) => {
    // last-wins on conflicting layout/mode/etc.; warn only on a real value change.
    if (Object.prototype.hasOwnProperty.call(attrs, key) && attrs[key] !== value) {
      warnings.push(`trigger-conflict:${key}:${attrs[key]}→${value}`);
    }
    attrs[key] = value;
  };
  for (const group of groups) {
    for (const { raw: tok } of tokenizeTriggerBody(group)) {
      if (!tok) continue;
      const eq = tok.indexOf("=");
      if (eq > 0) {
        // Explicit `key=value` (a double-quoted value is already unwrapped by the tokeniser, so a
        // value may contain spaces). Kept verbatim — explicit form is unchanged by the resolver.
        setKey(tok.slice(0, eq), tok.slice(eq + 1));
        continue;
      }
      // Colon form `key:value` — currently the `{blocks:RxC}` grid-dimension trigger (e.g.
      // `{blocks:3x3}`, `{blocks:2x5}`). Parsed like `key=value` so a grid/tiles slide can pin its
      // rows×cols. Only fires when the part before `:` is a legal key word, so prose colons in a
      // (rare) heading token do not get mistaken for an attribute.
      const colon = tok.indexOf(":");
      if (colon > 0 && /^[\w-]+$/.test(tok.slice(0, colon))) {
        setKey(tok.slice(0, colon), tok.slice(colon + 1));
        continue;
      }
      // A legal bare token is an identifier-like word. It may LEAD with a digit (e.g. the
      // `2col`/`3col` column shortcuts) — those are valid dictionary words — so allow a leading
      // digit but still require it to be alphanumeric/`-`/`_` throughout (no punctuation soup).
      if (!/^[\w-]+$/.test(tok)) continue; // not a legal bare token
      // BARE word: resolve through the Trigger Dictionary (container-mode flags {grid-linear},
      // {grid-zoom}, {contents} live there too, mirroring {carousel}).
      const resolved = resolveTrigger(tok);
      if (resolved) {
        setKey(resolved.key, resolved.value);
        continue;
      }
      // Dynamic trigger families (parameterised bare words, e.g. {countdown-digits-30s}) —
      // resolved by the dictionary file's family regexes, so ADR-0004's "the dictionary is
      // the resolver" still holds for generated words.
      const dynamic = resolveDynamicTrigger(tok);
      if (dynamic) {
        for (const pair of dynamic) setKey(pair.key, pair.value);
      } else {
        // Unknown bare word: never a silent ignore (ADR-0004). Still record the flag so an
        // unrecognised marker is not lost downstream, but surface a warning so the dictionary
        // stays load-bearing.
        warnings.push(`unknown-trigger:${tok}`);
        attrs[tok] = true;
      }
    }
  }
  return { title: title.trim(), attrs, warnings };
}

// ADR-0015 — Trigger line. A body line consisting ONLY of `{…}` groups (whitespace-separated)
// is slide-level attributes, not content. 2026-07-08: this holds ANYWHERE in a slide's body,
// not just as the first non-blank line after the heading — cloning/moving slides can strand a
// Trigger line mid-body, and `{…}` must never render as slide text. (Fenced code lines are
// exempt — the caller's fence guard keeps them verbatim.)
// Same vocabulary as heading Triggers; parseTriggerLine returns { attrs, warnings } or null.
export function parseTriggerLine(line) {
  const t = String(line ?? "").trim();
  if (!t || !TRIGGER_LINE_RE.test(t)) return null;
  const parsed = parseHeadingAttrs(t);
  return { attrs: parsed.attrs, warnings: parsed.warnings };
}

// Resolve a slide's authored stepping mode from its heading attrs.
//   {mode=reveal} | {mode=focus}  → that mode activates on arrival;
//   {reveal=steps}                → alias for {mode=reveal} (legacy; kept for the timeline).
// Returns "reveal" | "focus" | "" (none). An unrecognised mode value is ignored.
export function resolveAuthoredMode(attrs = {}) {
  const m = attrs.mode;
  if (m === "reveal" || m === "focus") return m;
  if (attrs.reveal === "steps") return "reveal";
  return "";
}

// Countdown duration → whole seconds (layout batch 2, 2026-06-12). Accepted: `30s`, bare
// seconds (`90`), `3min`/`3m`, `m:ss` (`1:30`). Anything else → null (the compiler warns
// `countdown-unparsed:<value>` and drops the element — never silent, never NaN in markup).
export function parseCountdownDuration(value) {
  const t = String(value ?? "").trim().toLowerCase();
  if (!t) return null;
  let m = t.match(/^(\d+)\s*s(ec(onds?)?)?$/);
  if (m) return Number(m[1]);
  m = t.match(/^(\d+)\s*m(in(utes?)?)?$/);
  if (m) return Number(m[1]) * 60;
  m = t.match(/^(\d+):([0-5]\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = t.match(/^(\d+)$/);
  if (m) return Number(m[1]);
  return null;
}

// Section accent rotation — keys every accent-driven CSS device off var(--accent), and now the
// matching per-section TINT off var(--tint) (ADR-0005 skin, 2026-07-10). Each cycle entry is
// `{ accent, tint }`: the accent drives kickers/highlights/diagram fills/progress tick, the tint
// drives title-sidebar panels and boxed backgrounds — a persistent "you are here" signal.
// DEFAULT cycle (ADR-0005): cobalt → emerald → vermilion, then repeat.
export const SECTION_ACCENTS = [
  { name: "cobalt", accent: "#0f4bd8", tint: "#e8eefc" },
  { name: "emerald", accent: "#0a7a5c", tint: "#e4f3ee" },
  { name: "vermilion", accent: "#c2410c", tint: "#fcece3" },
];

// Green alternate palette ({palette:green}, deck-level): main green leads, with cohesive
// supporting hues. Each carries its own tint so the sidebar/panel treatment stays legible.
export const SECTION_ACCENTS_GREEN = [
  { name: "forest", accent: "#166534", tint: "#e4f3ee" },
  { name: "vermilion", accent: "#c2410c", tint: "#fcece3" },
  { name: "cobalt", accent: "#0f4bd8", tint: "#e8eefc" },
  { name: "emerald", accent: "#15803d", tint: "#e6f4ec" },
];

// Slide-background choices are palette TINTS, never saturated accents. They are deliberately
// stable across deck palettes because `{bg=name}` is an explicit visual choice on one slide.
export const SLIDE_BACKGROUND_TINTS = new Map([
  ["cobalt", "#e8eefc"],
  ["emerald", "#e4f3ee"],
  ["vermilion", "#fcece3"],
  ["forest", "#e4f3ee"],
]);

export function backgroundTintForName(name) {
  return SLIDE_BACKGROUND_TINTS.get(String(name ?? "").trim().toLowerCase()) || null;
}

// Map a deck-level palette name to its section-accent cycle. Unknown / unset → default.
export function sectionAccentsForPalette(palette) {
  return palette === "green" ? SECTION_ACCENTS_GREEN : SECTION_ACCENTS;
}

export function sectionAccentMapForPalette(palette = "") {
  return new Map(sectionAccentsForPalette(palette).map((pair) => [pair.name, pair]));
}

export function accentForSectionName(name, palette = "") {
  return sectionAccentMapForPalette(palette).get(String(name ?? "").trim().toLowerCase()) || null;
}

// Returns { accent, tint } for a section index (wraps the cycle). The assembly stamps BOTH as
// inline --sec-accent/--sec-tint (plus --accent for back-compat) on the slide <section>.
export function accentForSectionIndex(index, palette = "") {
  const cycle = sectionAccentsForPalette(palette);
  return cycle[((index % cycle.length) + cycle.length) % cycle.length];
}

// === Title placement (2026-06-09 title spec) ===
// Default for CONTENT layouts is the title-LEFT rail at 35/65 (title vertically centred); WIDE
// layouts use the TOP-title treatment (small title bar, full-width content below) so the visual
// gets room. STRUCTURAL/centred layouts (title, section/subsection divider, closing) keep their
// own centred treatment and get NO data-title-layout stamp. Layouts that already manage their own
// body columns (cards, copy-visual, code, trace, list-visual) are also left untouched unless the
// author opts in via {titletop} / {split}.
//
// LEFT (35/65 rail by default): list, statement, contrast, image-claim, quote, and the vertical
//   timelines (rail/vertical/columns/compact + timeline-visual).
// TOP (full-width content): columns, media, and big diagrams (smartart, flow, conceptmap,
//   orgchart, mindmap, system-map, pyramid), plus the HORIZONTAL timeline.
export const TITLE_LEFT_LAYOUTS = new Set([
  "list", "statement", "contrast", "image-claim", "quote", "timeline", "timeline-visual",
  // Refinement 5 (2026-06-09): the central-node+satellites family (system-map, mindmap) reads as a
  // compact radial diagram, NOT a genuinely wide visual — it sits comfortably in the right 65% with
  // the title on the left. Only horizontal-flow/columns/full-bleed-media/horizontal-timeline are
  // truly wide and keep the top-title.
  "system-map", "mindmap",
  // PPT-replication batch (2026-06-11): image-quote mirrors quote (title nav-only by default;
  // {title=show} restores it into the left rail).
  "image-quote",
]);
export const TITLE_TOP_LAYOUTS = new Set([
  "columns", "media", "smartart", "flow", "conceptmap", "orgchart", "pyramid",
  // PPT-replication batch (2026-06-11): all horizontal strips/grids need the full slide width.
  "stats", "process", "steps", "iconrow", "image-grid",
  // Layout batch 2 (2026-06-12): charts/tables/cycles/equations are wide compositions.
  "chart", "table", "cycle", "equation",
  // SD-16 (Task 6, 2026-06-25): title at the top; body = statement + list side-by-side.
  "stmt-list",
]);
const VALID_SPLITS = new Set(["30", "35", "40", "50"]);

// Resolve a slide's title placement to { mode: "left"|"top"|"", split: "30"|"35"|"50" }.
//   - {titletop} forces top on any slide (overrides the layout default).
//   - {split=N} (35/50/30) tunes the left rail; it also IMPLIES the left rail on a layout that
//     would otherwise be top or unstamped (asking for a split means "I want a left rail").
//   - timelineHorizontal flips a timeline from its default left rail to top.
// Returns mode "" (no stamp) for structural/self-columned layouts with no override.
export function titlePlacementFor({ layout, attrs = {}, timelineHorizontal = false }) {
  const wantTop = attrs.titletop === true;
  const rawSplit = attrs.split != null && attrs.split !== true ? String(attrs.split).trim() : "";
  const split = VALID_SPLITS.has(rawSplit) ? rawSplit : "";
  // {split} on its own asks for a left rail even on a layout that would default to top/none.
  if (split && !wantTop) return { mode: "left", split: split || "35" };
  if (wantTop) return { mode: "top", split: "" };
  if (layout === "timeline" && timelineHorizontal) return { mode: "top", split: "" };
  if (TITLE_TOP_LAYOUTS.has(layout)) return { mode: "top", split: "" };
  if (TITLE_LEFT_LAYOUTS.has(layout)) return { mode: "left", split: split || "35" };
  return { mode: "", split: "" };
}

// ADAPTIVE TITLE DENSITY (2026-06-09 refinement 3). A slide that is "mostly a title" — a
// section/stepping divider or a near-empty content slide — should scale its title UP to fill the
// space instead of sitting small in the left rail with vast whitespace. This pure function
// decides, from the slide's rendered body, whether the title is "sparse" (→ enlarge) or not.
//
// Signal: the visible body text length (tags stripped) plus the count of real content blocks. A
// slide reads as SPARSE when it carries essentially no body — no body text beyond a short lead AND
// at most one small block. Content-rich slides (a real list, a figure, a long statement, multiple
// paragraphs) are NEVER sparse, so their titles stay at the normal scale. The threshold is
// deliberately conservative: only genuinely empty/near-empty slides scale up.
//
//   bodyText : the body's text content with HTML tags removed (caller strips), trimmed.
//   blockCount : the number of top-level content blocks rendered into the body (0 for a bare title).
//   hasVisual : true when the body carries a figure/image/svg/iframe/video — a VISUAL slide is
//               "mostly a picture/diagram", not "mostly a title", so it is never sparse even when
//               its text is short (a full-bleed media slide must NOT blow its title up).
// Returns "sparse" | "" (the value stamped as data-title-density; "" = no stamp).
const SPARSE_BODY_TEXT_MAX = 60;   // chars of visible body text below which the slide reads as bare
const SPARSE_BLOCK_MAX = 1;        // at most one small block may be present and still count as sparse
export function titleDensity({ bodyText = "", blockCount = 0, hasVisual = false } = {}) {
  if (hasVisual) return "";
  const text = String(bodyText).replace(/\s+/g, " ").trim();
  if (text.length <= SPARSE_BODY_TEXT_MAX && blockCount <= SPARSE_BLOCK_MAX) return "sparse";
  return "";
}

// Count the visible-text length and top-level block count of a rendered body fragment, for the
// density check above. Strips tags; collapses whitespace. (A tiny build-time helper — the runtime
// never needs it.)
export function bodyDensitySignal(bodyHtml) {
  const html = String(bodyHtml || "");
  const text = html.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  // Top-level blocks ≈ count of block-level opening tags at the start of element runs. We count the
  // common content containers the renderer emits (p, ul, ol, figure, blockquote, div, table, svg,
  // section-ish wrappers). This is a heuristic COUNT, not a parse — good enough for "is it bare?".
  const blockCount = (html.match(/<(?:p|ul|ol|figure|blockquote|div|table|svg|pre|video|iframe|header)\b/gi) || []).length;
  // A VISUAL slide carries an image/diagram/embed — it is mostly a picture, never "mostly a title".
  const hasVisual = /<(?:figure|img|svg|iframe|video)\b/i.test(html);
  return { bodyText: text, blockCount, hasVisual };
}

// Robustly extract a YouTube/Vimeo video id (+ optional start time) from any common URL form.
// Returns null for non-video URLs. Forms covered:
//   YouTube: watch?v=ID, youtu.be/ID, /embed/ID, /v/ID, /shorts/ID (id = 11 url-safe chars).
//   Vimeo:   vimeo.com/ID, vimeo.com/video/ID, player.vimeo.com/video/ID (numeric id).
//   Start time: YouTube t= / start= (accepts "90", "90s", "1m30s", "1h2m3s"); Vimeo #t=… .
export function parseVideoEmbed(rawSrc) {
  const src = String(rawSrc || "").trim();
  if (!src) return null;
  const yt = src.match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([\w-]{11})/i);
  if (yt) {
    const query = src.includes("?") ? src.slice(src.indexOf("?") + 1).split("#")[0] : "";
    const params = new URLSearchParams(query);
    const start = secondsFromTimeToken(params.get("start") || params.get("t") || timeFromHash(src));
    return { kind: "youtube", id: yt[1], start };
  }
  const vimeo = src.match(/(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)/i);
  if (vimeo) {
    const start = secondsFromTimeToken(timeFromHash(src));
    return { kind: "vimeo", id: vimeo[1], start };
  }
  return null;
}

function timeFromHash(src) {
  const h = src.includes("#") ? src.slice(src.indexOf("#") + 1) : "";
  const m = h.match(/(?:^|[&;])t=([^&;]+)/i);
  return m ? m[1] : "";
}

// Parse a YouTube-style time token into integer seconds. Accepts plain seconds ("90", "90s")
// and the "1h2m3s" colon-free form. Returns 0 when nothing parseable is present.
function secondsFromTimeToken(token) {
  const t = String(token || "").trim();
  if (!t) return 0;
  if (/^\d+s?$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (m && (m[1] || m[2] || m[3])) {
    return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
  }
  return 0;
}

// True when a URL is a YouTube or Vimeo video (any common form). These embed endpoints PLAY
// from file:// (the iframe loads over https; only third-party cookies are limited), so unlike an
// arbitrary site embed they must never be swapped for the offline fallback card.
export function isVideoEmbedUrl(rawSrc) {
  return parseVideoEmbed(rawSrc) !== null;
}

// Normalize remote video/embed URLs so they actually play.
// YouTube watch/short/embed forms → youtube-nocookie embed; Vimeo → player embed. Both PLAY in
// the standalone single-file HTML opened from file:// (the runtime promotes them to a live iframe
// and never shows the offline fallback for them). Non-video URLs pass through unchanged.
export function normalizeEmbedUrl(rawSrc) {
  const src = String(rawSrc || "").trim();
  if (!src) return src;
  const video = parseVideoEmbed(src);
  if (video && video.kind === "youtube") {
    const query = src.includes("?") ? src.slice(src.indexOf("?") + 1).split("#")[0] : "";
    const params = new URLSearchParams(query);
    params.delete("v");
    // E8: presenter-triggered playback drives the audience iframe through the YouTube IFrame
    // API (iframe.contentWindow.postMessage with {event:"command",func:"playVideo"...}). That
    // API only listens once the embed is loaded with enablejsapi=1, so bake it into every
    // YouTube embed URL at generation time. (The API's own origin handshake is best-effort:
    // we cannot know the serving origin at build time, so we omit `origin`; command messages
    // TO the player still work with enablejsapi alone.) Authored params (e.g. t=42s start time)
    // are preserved verbatim.
    params.set("enablejsapi", "1");
    const tail = params.toString();
    return `https://www.youtube-nocookie.com/embed/${video.id}${tail ? `?${tail}` : ""}`;
  }
  if (video && video.kind === "vimeo") {
    return `https://player.vimeo.com/video/${video.id}`;
  }
  return src;
}

// True when `text` is WHOLLY a single bare http(s) URL (no surrounding prose, no markdown link
// syntax). Used by the lexer to auto-embed a slide whose only content is a URL. A URL embedded
// in a sentence ("see https://… for more") is NOT bare and stays prose.
export function isBareUrl(text) {
  const t = String(text || "").trim();
  if (!t || /\s/.test(t)) return false; // any whitespace → not a lone token
  if (/^!?\[/.test(t)) return false; // markdown image/link syntax handled elsewhere
  return /^https?:\/\/[^\s<>"']+$/i.test(t);
}

// CONCEPT MAP relation parser ({conceptmap}). Each input line is a relation of the form
//   A -label- B
// where the LABEL is wrapped in dashes that are surrounded by whitespace (` -…- `). The spaces
// around the dashes are what distinguish the relation delimiter from hyphens inside a node name
// (so `state-of-the-art -is a- goal` parses as node "state-of-the-art", label "is a", node
// "goal"). Both `-` (hyphen) and `–`/`—` (en/em dash) are accepted as the wrapping dash.
// Returns { nodes, edges, unparsed }:
//   nodes    deduped node labels, in first-seen order (case-sensitive on the trimmed text).
//   edges    [{ from, label, to }] with from/to as node-array indices.
//   unparsed the raw lines that did not match the relation shape (caller warns on each).
const CONCEPT_RELATION_RE = /^(.+?)\s+[-–—]\s*(.+?)\s*[-–—]\s+(.+)$/;
export function parseConceptRelations(items) {
  const nodes = [];
  const index = new Map();
  const edges = [];
  const unparsed = [];
  const idOf = (name) => {
    const key = name.trim();
    if (!index.has(key)) { index.set(key, nodes.length); nodes.push(key); }
    return index.get(key);
  };
  for (const raw of Array.isArray(items) ? items : []) {
    const line = String(raw || "").trim();
    if (!line) continue;
    const m = line.match(CONCEPT_RELATION_RE);
    if (!m) { unparsed.push(line); continue; }
    const from = m[1].trim();
    const label = m[2].trim();
    const to = m[3].trim();
    if (!from || !to) { unparsed.push(line); continue; }
    edges.push({ from: idOf(from), label, to: idOf(to) });
  }
  return { nodes, edges, unparsed };
}

// Spine/pills timelines are built for legibility, not density: a single slide holds at most
// SPINE_STOPS_PER_SLIDE date stops. A longer timeline AUTO-SPLITS into continuation slides of
// ≤cap stops each (same title + a "(2/3)" marker), each a proper, generously-spaced spine. The
// split happens in flushSlide (one timeline block can emit several slides). Tuned for up to 10
// stops across the slide width: 1–6 render at full size, 7–10 progressively down-scale fonts and
// card widths via spineFontScale()/--tl-spine-scale so they stay legible without overlapping.
// Change here and the splitter, render, scale ramp and CSS all follow.
export const SPINE_STOPS_PER_SLIDE = 10;

// Density ramp for the spine/pills render. 1–6 stops sit at full size; 7–10 shrink fonts and card
// widths linearly down to ~0.76 so a denser timeline stays on one slide and still reads. Returns
// the multiplier applied as --tl-spine-scale (the CSS multiplies its font/width clamps by it).
export function spineFontScale(stopCount) {
  const n = Math.max(1, Number(stopCount) || 1);
  return n <= 6 ? 1 : Math.max(0.66, Number((1 - (n - 6) * 0.075).toFixed(3)));
}

// A timeline entry is "dated" when it opens with a year, year-range, or decade — these get
// the date-emphasis treatment (date column in accent). Mid-string years (e.g. an era label
// "AI Axial Age — 1936–1973") do NOT count: only a LEADING date marks a real dated entry.
// Recognised: 1936 · 1936–1973 / 1936-73 · 1950s · c. 1940 / ~1940.
const TIMELINE_DATE_RE = /^\s*(?:c\.?\s*|~|circa\s+)?(\d{4}s?(?:\s*[–-]\s*(?:\d{4}s?|\d{2}s?))?|\d{1,2}(?:st|nd|rd|th)\s+century)\b/i;
export function timelineDateOf(text) {
  const m = String(text).match(TIMELINE_DATE_RE);
  if (m) {
    const date = m[0].trim();
    // Strip the date and a single leading separator (—, –, -, :) so the body reads cleanly.
    const body = String(text).slice(m[0].length).replace(/^\s*[—–:-]\s*/, "").trim();
    return { date, body };
  }
  // EXPLICIT label (2026-06-12): a space-surrounded dash/middot splits `label — body` into a
  // labelled stop even when the label is not a date ("new century — Transformers",
  // "future - Chat for everyone"). The label is capped at 40 chars so a prose dash deep in a
  // sentence never turns the whole entry into a "label". Colons are NOT separators here —
  // too common in prose.
  const sep = String(text).match(/^\s*(.{1,40}?)\s+[—–·-]\s+(\S[\s\S]*)$/);
  if (sep) return { date: sep[1].trim(), body: sep[2].trim() };
  return { date: "", body: String(text).trim() };
}

// Turn raw timeline rows ({indent,text}) into groups: [{label, items:[{date,body}]}].
// Two grouping sources, in priority order:
//   1) INDENTATION — a less-indented row with indented rows beneath it is a group header;
//      the indented rows are its entries. Rows before the first header form a leading
//      ungrouped group (label "").
//   2) UNDATED-HEADER HEURISTIC (flat lists only) — when nothing is indented, an undated
//      row immediately followed by a dated row is a category header; its entries are the
//      dated rows that follow until the next undated row. Rows before the first header are
//      an ungrouped leading group. A list with NO dated rows at all stays a single
//      ungrouped group (never invents headers from undated prose).
export function groupTimelineRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const baseIndent = Math.min(...rows.map((r) => r.indent));
  const isIndented = rows.some((r) => r.indent > baseIndent);
  const entry = (text) => ({ ...timelineDateOf(text) });
  const groups = [];
  const pushGroup = (label) => { groups.push({ label, items: [] }); return groups[groups.length - 1]; };

  if (isIndented) {
    let current = null;
    for (const r of rows) {
      if (r.indent <= baseIndent) {
        // Top-level row. If the NEXT row is more indented, this is a group header; else it
        // is a standalone (ungrouped) entry.
        const idx = rows.indexOf(r);
        const next = rows[idx + 1];
        if (next && next.indent > r.indent) {
          current = pushGroup(r.text.trim());
        } else {
          if (!current || current.label !== "") current = groups.find((g) => g.label === "") || pushGroup("");
          current.items.push(entry(r.text));
        }
      } else {
        if (!current) current = pushGroup("");
        current.items.push(entry(r.text));
      }
    }
    return groups.filter((g) => g.items.length || g.label);
  }

  // Flat list. Apply the undated-header heuristic only if there is at least one dated row.
  const anyDated = rows.some((r) => Boolean(timelineDateOf(r.text).date));
  if (!anyDated) return [{ label: "", items: rows.map((r) => entry(r.text)) }];
  let current = null;
  for (let k = 0; k < rows.length; k += 1) {
    const r = rows[k];
    const dated = Boolean(timelineDateOf(r.text).date);
    const next = rows[k + 1];
    const nextDated = next && Boolean(timelineDateOf(next.text).date);
    if (!dated && nextDated) {
      current = pushGroup(r.text.trim());
    } else {
      if (!current) current = groups.find((g) => g.label === "") || pushGroup("");
      current.items.push(entry(r.text));
    }
  }
  return groups.filter((g) => g.items.length || g.label);
}

// Auto-select a presentation mode for a grouped timeline. Explicit {timeline=…} always wins
// (handled by the caller). Heuristic: a grouped timeline with 2–4 groups and many entries
// becomes columns (a tall grouped rail overflows; columns spend width instead); otherwise
// the vertical rail. Flat/ungrouped timelines stay on the rail.
export function autoTimelineMode(groups) {
  const realGroups = groups.filter((g) => g.label);
  const totalItems = groups.reduce((n, g) => n + g.items.length, 0);
  // Visual rows = entries + their headers; that height is what overflows a tall rail.
  const rows = totalItems + realGroups.length;
  if (realGroups.length >= 2 && realGroups.length <= 4 && rows > 8) return "columns";
  return "rail";
}

export function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Underscore emphasis (__bold__ / _italic_) — common in citations and pasted prose. Matched
  // only at word boundaries (open `_` not after a word char, close `_` not before one) so
  // intra-word underscores in identifiers and URLs (snake_case, /wiki/Some_Page) are left alone.
  // Runs before the link passes; the boundary guard means a `_` flanked by word chars never fires.
  out = out.replace(/(^|[^\w`])__(?=\S)([^_]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
  out = out.replace(/(^|[^\w`])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Markdown links, with an OPTIONAL title: [label](url "title"). escapeHtml ran first, so a
  // title's quotes are already &quot;…&quot; here — match that form and surface it as a tooltip.
  // Without the title arm, any link carrying a title (common in wiki/pasted Markdown) failed to
  // parse because the url matcher stops at the space and then expects ")".
  out = out.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\s*\)/g, (_, label, url, title) => {
    const safe = /^(https?|mailto):|^[#./]/i.test(url) ? url : "#";
    const titleAttr = title ? ` title="${title}"` : "";
    return `<a href="${safe}"${titleAttr} target="_blank" rel="noopener">${label}</a>`;
  });
  // Auto-link bare URLs (left alone by the markdown-link pass above — they have no
  // <…> wrapper since text was already escaped, so this never double-links). Trailing
  // sentence punctuation is kept outside the link.
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+?)([.,;:)\]]*)(?=\s|$|<)/g,
    (_, lead, url, trail) => `${lead}<a href="${url}" target="_blank" rel="noopener">${url}</a>${trail}`);
  return out;
}

// G1 — straight-/curly-quote promotion. Dominik styles quotes with `>`, but sometimes a
// quotation is written as a plain paragraph that simply BEGINS with a double quote. Such a
// paragraph is promoted to a real quote block (so it gets the same quote device + serif
// treatment as `>`), with the outer quotation marks STRIPPED — the styling provides them.
//
// Trigger (deliberately strict to avoid false positives):
//   • text, trimmed, must START with a straight `"` or curly opening `“` double quote, AND
//   • a matching closing double quote (`"` or `”`) must appear, AND
//   • after the closing quote only an optional short tail is allowed: trailing sentence
//     punctuation, and/or an attribution introduced by an em/en dash or a parenthetical.
//
// Does NOT trigger on: apostrophes / single quotes (`'…'`), a paragraph where the double
// quote appears only mid-string (it does not open the paragraph), or an unterminated quote
// (open `"` with no close). A bracketed editorial insertion inside the quote — e.g.
// "the least efficient image generation model [uses] around half a [smartphone] charge" —
// is fine: the close quote is still the last quote character.
//
// Returns { text, cite } on success (text has the outer quotes stripped; cite may be ""),
// or null when the paragraph is not a wholly-quoted statement.
export function quoteFromQuotedParagraph(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) return null;
  const open = text[0];
  if (open !== '"' && open !== "“") return null;
  // The closing mark is the LAST double-quote character of either flavour in the string.
  const closeIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("”"));
  if (closeIdx <= 0) return null; // no close, or close === open position
  const inner = text.slice(1, closeIdx).trim();
  if (!inner) return null;
  // The quoted span must contain real content with no further UNescaped paragraph break;
  // a stray opening-only quote that never closes is excluded by closeIdx > 0 above.
  let tail = text.slice(closeIdx + 1).trim();
  // Strip a single trailing sentence punctuation that sometimes sits outside the close quote.
  tail = tail.replace(/^[.,;:!?]+\s*/, "").trim();
  let cite = "";
  if (tail) {
    // The only tail we accept is an attribution: an em/en/hyphen dash lead, or a
    // parenthetical source. Anything else means the "quote" is only part of a larger
    // sentence (mid-paragraph quote) and must NOT be promoted.
    const dash = tail.match(/^[—–-]\s*(.+)$/);
    const paren = tail.match(/^\(([^)]+)\)\.?$/);
    if (dash) cite = dash[1].trim();
    else if (paren) cite = paren[1].trim();
    else return null;
  }
  return { text: inner, cite };
}

// The WELL-KNOWN speakers a `trace` fenced block recognises, each mapped to a CSS class and a
// default label. A trace is a role-tagged transcript of ANY turn-taking exchange — an agentic
// loop (user speaks, harness assembles a prompt, model reasons and emits tool calls, tools
// return results, the model replies), an interview, a two-person dialogue, a debate. The known
// AI-loop roles below get their established colours so agent traces stay legible at a glance;
// `assistant` is an alias for `model` (shared line colour) so generic chat transcripts read
// naturally too. ANY OTHER speaker label is allowed and is auto-assigned a stable distinct
// colour per name within the slide (see autoSpeakerClass). The set is exported so the renderer
// and tests can ask "is this a special-styled role?".
export const TRACE_ROLES = {
  user: { cls: "user", label: "USER" },
  harness: { cls: "harness", label: "HARNESS" },
  model: { cls: "model", label: "MODEL" },
  assistant: { cls: "model", label: "ASSISTANT" },
  reasoning: { cls: "reasoning", label: "MODEL · reasoning" },
  tool: { cls: "tool", label: "TOOL RESULT" }
};

// Number of auto-colour buckets for arbitrary (non-well-known) speakers. Each distinct speaker
// name seen in a slide maps to one of these via a deterministic hash, so the same name always
// gets the same colour within (and across) decks, and distinct names spread across the palette.
// The matching `.trace .role.speaker-0`…`speaker-N` CSS lives in the popup template.
export const TRACE_SPEAKER_BUCKETS = 8;

// Stable hash of a speaker name → bucket index in [0, TRACE_SPEAKER_BUCKETS). Deterministic
// (build-to-build, deck-to-deck) so colours never drift. Case/space-insensitive so "John" and
// "john " collide on purpose (same person).
export function speakerBucket(name) {
  const key = String(name || "").trim().toLowerCase();
  let h = 0;
  for (let k = 0; k < key.length; k += 1) h = (h * 31 + key.charCodeAt(k)) >>> 0;
  return h % TRACE_SPEAKER_BUCKETS;
}

// CSS class for an arbitrary speaker label: `speaker-<bucket>`. Well-known roles use their own
// class (TRACE_ROLES[...].cls) and never reach this.
export function autoSpeakerClass(name) {
  return `speaker-${speakerBucket(name)}`;
}

// The speaker-label rule (resolves the colon ambiguity precisely):
//   A turn HEADER is a line that begins (after optional indent) with a LABEL followed by `:`.
//   A LABEL is a short token of label-safe characters only — letters, digits, spaces, and
//   `.`, `-`, `_` — with NO sentence/terminal punctuation and NO brackets/quotes/symbols. It is
//   bounded: at most 32 characters and at most 4 whitespace-separated words. So `John:`,
//   `Interviewer:`, `Dr. Smith:`, `user:`, `harness: HARNESS → MODEL` all open turns, while
//   `[system: tools]` (leading `[`), `I think: maybe` (label too long / not at clear boundary →
//   in practice "I think" is 2 words but the colon test still fires; guarded below by the
//   label-safe charset which `I think` passes — so we additionally require the whole pre-colon
//   run to be the label and treat any line WITHOUT a leading label-colon as a continuation).
// Returns the matched { rawLabel, after } or null. `after` is the text after the first colon
// (may be empty). Only the FIRST `:` splits; later colons in `after` are never re-split.
const LABEL_SAFE = /^[A-Za-z0-9 ._-]+$/;
// A label on its OWN line (colon ends the line) is unambiguously a turn header in a trace, so it
// may be a descriptive role with a parenthetical — "System Prompt (human-written):",
// "Model Completion (machine-written, 10 tries):". Looser charset + bounds, but still guarded.
const LABEL_SAFE_HEADING = /^[A-Za-z0-9 .,_()/→-]+$/;
function matchSpeakerHeader(line) {
  const colon = line.indexOf(":");
  if (colon === -1) return null;
  // Everything before the first colon, with surrounding whitespace removed for the label test.
  const rawLabel = line.slice(0, colon).trim();
  if (!rawLabel) return null; // a leading bare `:` is not a header
  const after = line.slice(colon + 1).trim();
  if (after === "") {
    // Colon-terminated label line. Permit a longer, parenthetical descriptive label, but only
    // when it reads like a LABEL not prose: starts with a capital/digit OR is a known role, and
    // stays bounded. This admits "Model Completion (machine-written, 10 tries):" while rejecting a
    // lowercase body line that merely ends in a colon ("and then it said:").
    const looksLikeLabel = /^[A-Z0-9]/.test(rawLabel)
      || Object.prototype.hasOwnProperty.call(TRACE_ROLES, rawLabel.toLowerCase());
    if (looksLikeLabel && rawLabel.length <= 64 && rawLabel.split(/\s+/).length <= 8 && LABEL_SAFE_HEADING.test(rawLabel)) {
      return { rawLabel, after: "" };
    }
    return null;
  }
  // Inline `Label: body` — keep the strict short-label rule so a sentence with a mid-line colon
  // is never mistaken for a turn header.
  if (rawLabel.length > 32) return null; // too long to be a speaker name → continuation/body
  if (rawLabel.split(/\s+/).length > 4) return null; // more than 4 words → a sentence, not a label
  if (!LABEL_SAFE.test(rawLabel)) return null; // brackets/quotes/punctuation → not a label
  return { rawLabel, after };
}

// Parse the raw lines of a ```trace block into speaker-tagged turns.
//
// A turn HEADER is either:
//   1. `Speaker: content` — any label-safe speaker name (see matchSpeakerHeader) followed by `:`.
//      For an ARBITRARY speaker the content after the colon is the turn BODY (so a one-line
//      `John: I like this movie.` is a complete turn). For a WELL-KNOWN role the content after
//      the colon is a custom DISPLAY LABEL, not body — `harness: HARNESS → MODEL` keeps the
//      author's arrow label; the body comes from the following lines. This preserves the
//      established `role: DISPLAY` syntax exactly while letting plain dialogue read naturally.
//   2. A bare WELL-KNOWN role on its own line (`user`, `reasoning`, …), optionally with a custom
//      label after `|` (`model | MODEL → USER`). Falls back to the role's default label.
//
// Any line that is NOT a header CONTINUES the current turn's body, preserved verbatim (interior
// whitespace kept; mid-sentence colons are never re-split because only line-leading label-colons
// open turns). Lines before the first header are ignored.
//
// Returns `[{ role, cls, label, body, known }]` where `known` flags a well-known role and `cls`
// is the role's class (well-known) or `speaker-<bucket>` (arbitrary, auto-coloured per name).
export function parseTrace(lines) {
  const turns = [];
  let current = null;
  for (const line of lines) {
    // Bare well-known role on its own line, optionally `role | Custom Label` (no colon form).
    const bare = line.match(/^\s*([A-Za-z]+)\s*(?:\|\s*(.*?))?\s*$/);
    const bareRole = bare ? bare[1].toLowerCase() : null;
    const header = matchSpeakerHeader(line);
    if (bareRole && Object.prototype.hasOwnProperty.call(TRACE_ROLES, bareRole) && line.indexOf(":") === -1) {
      const def = TRACE_ROLES[bareRole];
      const label = (bare[2] && bare[2].trim()) || def.label;
      current = { role: bareRole, cls: def.cls, label, known: true, bodyLines: [] };
      turns.push(current);
    } else if (header) {
      const roleKey = header.rawLabel.toLowerCase();
      const known = Object.prototype.hasOwnProperty.call(TRACE_ROLES, roleKey);
      if (known) {
        // Established `role: X` — X is a custom LABEL only when it reads like one (short,
        // no sentence shape). `user: Summarise unread email.` is a MESSAGE, not a label —
        // treating it as a label silently swallowed the body (Gate-4, 2026-07-11).
        const def = TRACE_ROLES[roleKey];
        const after = header.after || "";
        const looksLikeBody = after && (after.length > 32 || /[.!?]$/.test(after) || after.split(/\s+/).length > 4);
        const label = !looksLikeBody && after ? after : def.label;
        current = { role: roleKey, cls: def.cls, label, known: true, bodyLines: looksLikeBody ? [after] : [] };
        turns.push(current);
      } else {
        // Arbitrary speaker — the label IS the speaker name; content after colon starts the body.
        current = {
          role: header.rawLabel,
          cls: autoSpeakerClass(header.rawLabel),
          label: header.rawLabel,
          known: false,
          bodyLines: header.after ? [header.after] : []
        };
        turns.push(current);
      }
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  return turns.map((t) => ({
    role: t.role,
    cls: t.cls,
    label: t.label,
    known: t.known,
    body: t.bodyLines.join("\n").replace(/^\n+|\n+$/g, "")
  }));
}
