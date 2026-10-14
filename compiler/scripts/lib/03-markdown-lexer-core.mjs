// The Markdown lexer itself, with ONE thing passed in: the function that turns an authored icon
// name into a renderable icon key. The compiler binds its own (05-icons.mjs
// normalizeIconOverrideKey, which reads the vendored icon sets from disk) in
// 03-markdown-lexer.mjs, and every compiler path goes through that file. This file loads nothing
// from disk, so the editor's plain view can run the SAME lexer on a slide's lines
// (src/shared/plain-view-compiler-facts.ts) with a normaliser of its own. The app's check before a
// quote write (src/shared/quote-write-check.ts), which has no catalogue, reads one slide with it
// too, and passes a normaliser that says it was asked.
//
// Source positions (plain view ticket 07, eleventh round). Each block carries, as NON-ENUMERABLE
// properties (so no JSON, spread, key walk or deep comparison of a block sees them, and nothing
// the compiler renders can change):
//   sourceLines  [first, last]: the indexes, in the `lines` passed in, of the block's first and
//                last line.
//   iconToken    paragraph only, when a trailing `{icon=NAME}` was stripped: { line, key, icon }
//                (`line`: the paragraph's last line; `key`: NAME as written; `icon`: the
//                normalised key or null).
//   iconTokens   list only: one entry per row (any depth) whose trailing token was stripped:
//                { line, key, icon, top, ordered, indentLength, markLength } (`top`: a top-level
//                row, the only kind that draws its icon; `indentLength` and `markLength`: the
//                characters of the row's indentation and of its mark with the spaces after it).
//   itemRows     list only: one entry per TOP-LEVEL row, aligned with `items`:
//                { line, indentLength, markLength } (issue #120: the outline verb that writes an
//                item's icon finds the item's source line here, outline-list-item-icon.mjs).
import { isImageBlockLine, IMAGE_SYNTAX_RE, imageSyntaxIsVideo, imageSyntaxIsAudio } from "./image-line-rules.mjs";
export { isImageBlockLine };
import { isVideoEmbedUrl, normalizeEmbedUrl, isBareUrl, timelineBlockFields, claimFromBoldParagraph, parseTrace } from "./02-triggers-layout.mjs";
import {
  chartObjectTokenAt,
  isMarkdownFenceClosingLine,
  parseMarkdownFenceOpeningLine,
  parseChartFenceBodyList,
  parseChartObjectFenceInfo
} from "./03-object-token.mjs";

const hidden = (block, name, value) => Object.defineProperty(block, name, { value, enumerable: false, writable: true, configurable: true });
import { takeQuoteBlock, takeParagraph, promoteQuotedParagraph } from "./quote-grammar.mjs";

// Playback intent for a video, from trailing curly tokens on the media line (ADR-0028):
// ![alt](clip.mp4){autoplay}{loop}{muted}{controls}. A GIF converted by TalkWeaver carries
// {autoplay}{loop}{muted} (ambient, indistinguishable from the original GIF); a bare MP4 carries
// none (manual, control-barred). {play-on-next} (0.38 ticket 05) makes the file a step of its slide:
// the press of Next that reaches it starts it (lib/media-steps.mjs). Unknown tokens are ignored.
// Returns {} when there are no tokens.
const PLAY_ON_NEXT_RE = /\{\s*play-on-next\s*\}/i;
function parseMediaFlags(raw) {
  const flags = {};
  if (!raw) return flags;
  for (const m of raw.matchAll(/\{([^}]*)\}/g)) {
    const k = m[1].trim().toLowerCase();
    if (k === "autoplay" || k === "loop" || k === "muted" || k === "controls") flags[k] = true;
    else if (k === "mute") flags.muted = true;
    else if (k === "play-on-next") flags.playOnNext = true;
  }
  return flags;
}

// =============================================================================
// 3. Markdown lexer — outline lines -> typed blocks (lists, fences, images, embeds, quotes)
// =============================================================================

// A paragraph's trailing `{icon=NAME}` (plain view ticket 07).
//
// paragraphIconTokenAt is the ONE reading of that token: the lexer strips by it, and the outline
// verb (12-outline-edit.mjs setParagraphIcon) splices by its offsets. An authoring token is the
// brace group that ends the text (only whitespace after it) AND is preceded by whitespace or is
// the whole text. So a group written straight after a text character is text, as it was before
// the ticket: the tail of a URL (`https://example.org/{icon=x}`) and an escaped brace
// (`\{icon=x}`) stay as written. Both conditions together also keep the token outside every
// inline construct: a link destination, an autolink, a code span and an HTML tag each end in
// their own closing character (`)`, `>`, a backtick), which would follow the group, and then the
// group does not end the text.
//
// Returns null, or offsets into `text`: `from` (start of the whitespace before the token),
// `tokenFrom` (`{`), `keyFrom`/`keyTo` (NAME as written), `tokenTo` (after `}`), and `key`.
export function paragraphIconTokenAt(text) {
  const s = String(text ?? "");
  const m = s.match(/\{\s*icon\s*=\s*([^}]+?)\s*\}\s*$/i);
  if (!m) return null;
  const tokenFrom = m.index;
  if (tokenFrom > 0 && !/\s/.test(s[tokenFrom - 1])) return null;
  let from = tokenFrom;
  while (from > 0 && /\s/.test(s[from - 1])) from -= 1;
  const keyFrom = s.indexOf(m[1], s.indexOf("=", tokenFrom) + 1);
  return { from, tokenFrom, keyFrom, keyTo: keyFrom + m[1].length, tokenTo: s.indexOf("}", keyFrom + m[1].length) + 1, key: m[1] };
}

// The text without the token and the normalised icon key (null when NAME resolves to nothing), or
// the text unchanged when the paragraph does not end in an authoring token.
export function takeParagraphIconWith(text, normalizeIconKey) {
  const token = paragraphIconTokenAt(text);
  if (!token) return { text, icon: null };
  return { text: String(text).slice(0, token.from).trim(), icon: normalizeIconKey(token.key), key: token.key };
}

// A list item's trailing icon token (see takeList below for the two forms), or null: `index` (the
// start of the whitespace before `{` in `text`), `key` (NAME as written) and `icon` (normalised).
const LIST_ITEM_EXPLICIT_ICON_RE = /\s*\{\s*icon\s*=\s*([^}]+?)\s*\}\s*$/i;
const LIST_ITEM_BARE_ICON_RE = /\s*\{\s*([^}=]+?)\s*\}\s*$/;
export function listItemIconTokenAt(text, normalizeIconKey) {
  const explicit = text.match(LIST_ITEM_EXPLICIT_ICON_RE);
  if (explicit) return { index: explicit.index, key: explicit[1], icon: normalizeIconKey(explicit[1]) };
  const bare = text.match(LIST_ITEM_BARE_ICON_RE);
  if (bare) {
    const icon = normalizeIconKey(bare[1]);
    if (icon) return { index: bare.index, key: bare[1], icon };
  }
  return null;
}

// The same token with the offsets a writer splices by (outline-list-item-icon.mjs), read with
// the same two patterns: `explicit` (the `{icon=NAME}` form), `from` (listItemIconTokenAt's
// `index`), `tokenFrom` (`{`), `keyFrom`/`keyTo` (NAME as written), `tokenTo` (after `}`), `key`
// and `icon`. null exactly when listItemIconTokenAt answers null.
const withIndices = (re) => new RegExp(re.source, `${re.flags}d`);
const LIST_ITEM_EXPLICIT_ICON_SPAN_RE = withIndices(LIST_ITEM_EXPLICIT_ICON_RE);
const LIST_ITEM_BARE_ICON_SPAN_RE = withIndices(LIST_ITEM_BARE_ICON_RE);
export function listItemIconTokenSpanAt(text, normalizeIconKey) {
  const s = String(text ?? "");
  const token = listItemIconTokenAt(s, normalizeIconKey);
  if (!token) return null;
  const explicit = LIST_ITEM_EXPLICIT_ICON_SPAN_RE.exec(s);
  const m = explicit || LIST_ITEM_BARE_ICON_SPAN_RE.exec(s);
  const [keyFrom, keyTo] = m.indices[1];
  return {
    explicit: Boolean(explicit), from: m.index, tokenFrom: s.indexOf("{", m.index), keyFrom, keyTo,
    tokenTo: s.indexOf("}", keyTo) + 1, key: token.key, icon: token.icon
  };
}

/** A list row: indentation, mark, text. The text is `.+`: no carriage return, no U+2028 / U+2029. */
const LIST_ROW_RE = /^(\s*)([-*]\s+|\d+[.)]\s+)(.+)$/;
/** The same row with any character in its text (see takeList for the one case it reads). */
const LIST_ROW_WIDE_RE = /^(\s*)([-*]\s+|\d+[.)]\s+)([\s\S]+)$/;
/** The main loop's test for a line that opens a list, over the trimmed line. */
const isListRowStart = (trimmed) => /^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed);

/** The most passes the lexer's main loop may make without moving past a line. */
const LEXER_MAX_PASSES_ON_ONE_LINE = 16;

export function lexMarkdownBlocksWith(lines, normalizeIconKey) {
  const blocks = [];
  let i = 0;
  // Source positions: every block pushed in one turn of the main loop spans the lines that turn consumed.
  let turn = null;
  const stampTurn = () => {
    if (turn) for (let b = turn.at; b < blocks.length; b += 1) hidden(blocks[b], "sourceLines", [turn.first, Math.max(turn.first, i - 1)]);
    turn = null;
  };
  const peek = () => (i < lines.length ? lines[i].trim() : null);
  // H1 — list reader now PRESERVES indentation so feature lists can carry nested children
  // (LearnWeaver pattern). BACKWARD COMPAT is the contract: the returned block keeps
  // `items` as the FLAT array of TOP-LEVEL strings exactly as before — every existing
  // consumer (mapBlocksToLayout contrast/tiles/system-map/image-claim, decideFeatureListStyle,
  // assignFeatureIconsV3, isNameLike, detectIconGaps, the card featurizers) reads `items` and
  // sees no change. A parallel `children` array, aligned by index to `items`, carries each
  // top-level item's nested sub-tree (`[{text, children}]`, possibly empty). ONLY feature-list
  // rendering consumes `children`. `ordered` reflects the TOP-LEVEL marker style (as before).
  function takeList() {
    // Collect raw rows with their indentation depth, then build a tree by indent.
    const rows = [];
    let ordered = false;
    while (i < lines.length) {
      const line = lines[i];
      // A row is what `LIST_ROW_RE` reads, as it always was. `.` stops at a carriage return and at
      // U+2028 / U+2029, so a line holding one of those after its mark is not read by it; when the
      // main loop takes that line for a list all the same (`isListRowStart` over the TRIMMED line),
      // the lexer stood on it for ever. Those lines, and only those, are read by the wider pattern:
      // a line the compiler read before is read exactly as before (`- \u2028` under a list is still
      // the start of a paragraph, not an empty row).
      const m = line.match(LIST_ROW_RE) || (isListRowStart(line.trim()) ? line.match(LIST_ROW_WIDE_RE) : null);
      if (!m) break;
      const indent = m[1].replace(/\t/g, "  ").length;
      const isOrdered = /\d/.test(m[2]);
      rows.push({ indent, ordered: isOrdered, text: m[3].trim(), line: i, indentLength: m[1].length, markLength: m[2].length });
      i += 1;
    }
    if (rows.length === 0) return { type: "list", ordered: false, items: [], children: [] };
    // Build a nested tree from the indent ladder. Each node: { text, ordered, children }.
    const roots = [];
    const sourceOf = new Map(); // node -> its row (source positions only)
    const iconTokens = [];
    const stack = []; // entries: { indent, node }
    for (const r of rows) {
      const node = { text: r.text, ordered: r.ordered, children: [] };
      sourceOf.set(node, r);
      while (stack.length && r.indent <= stack[stack.length - 1].indent) stack.pop();
      if (stack.length === 0) roots.push(node);
      else stack[stack.length - 1].node.children.push(node);
      stack.push({ indent: r.indent, node });
    }
    // Match the pre-H1 flat-list semantics: a list is "ordered" if any TOP-LEVEL row used a
    // numeric marker (the numbers style decision keys off this). Nested markers do not count.
    ordered = roots.some((n) => n.ordered);
    // ── Per-item icon override (Layer-2 hook + minimalist authoring) ──────────────────────────
    // A trailing brace token on a list item pins that item's glyph, winning over the algorithmic
    // pick. Two forms, BOTH stripped so they never render as literal text:
    //   {icon=NAME}  explicit — always stripped (a typo'd NAME just yields no icon; Layer 1 assigns).
    //   {NAME}       shorthand — treated as an icon ONLY when NAME resolves to a renderable glyph, so
    //                ordinary trailing braces ("- the set {a, b}") are left intact. NAME is a Lucide
    //                name ("door-closed"), a bare brand, or a prefixed key ("svgl:github"/"lucide:zap").
    // Icons render on TOP-LEVEL items only (sub-bullets are a quiet sub-list, never iconed), but the
    // token is stripped at EVERY depth so a tag mistakenly placed on a sub-bullet is removed, never
    // printed. No collision with triggers: {icons}/{group}/… live on headings or the Trigger line,
    // never trailing a `-` content row (ADR-0015 keeps slide-level attrs off content rows).
    const takeItemIcon = (text, node, top) => {
      const token = listItemIconTokenAt(text, normalizeIconKey);
      if (!token) return { text, icon: null };
      const row = sourceOf.get(node);
      iconTokens.push({ line: row.line, key: token.key, icon: token.icon, top, ordered: row.ordered, indentLength: row.indentLength, markLength: row.markLength });
      return { text: text.slice(0, token.index).trim(), icon: token.icon };
    };
    const stripDeep = (nodes) => { for (const n of nodes) { n.text = takeItemIcon(n.text, n, false).text; if (n.children) stripDeep(n.children); } };
    const iconOverrides = roots.map((n) => {
      const r = takeItemIcon(n.text, n, true);
      n.text = r.text;
      if (n.children) stripDeep(n.children);
      return r.icon;
    });
    const items = roots.map((n) => n.text);
    const children = roots.map((n) => n.children);
    const hasOverride = iconOverrides.some(Boolean);
    const list = { type: "list", ordered, items, children, ...(hasOverride ? { iconOverrides } : {}) };
    if (iconTokens.length) hidden(list, "iconTokens", iconTokens.sort((a, b) => a.line - b.line));
    hidden(list, "itemRows", roots.map((n) => {
      const row = sourceOf.get(n);
      return { line: row.line, indentLength: row.indentLength, markLength: row.markLength };
    }));
    return list;
  }
  // Timeline-only list reader: PRESERVES indentation (unlike takeList, which flattens) so
  // an outline can group dated entries under an undated parent. Returns raw rows as
  // { indent, text }. Scope is deliberately limited to timeline consumption — feature-lists
  // never relied on nesting (takeList already flattened them).
  function takeTimelineRows() {
    const rows = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        // A blank line ends the list unless the next non-blank line is still a list item
        // (tolerate a single stray blank between rows).
        const next = lines[i + 1];
        if (next && /^\s*([-*]\s+|\d+[.)]\s+)/.test(next)) { i += 1; continue; }
        break;
      }
      const m = line.match(/^(\s*)(?:[-*]\s+|\d+[.)]\s+)(.+)$/);
      if (!m) break;
      rows.push({ indent: m[1].replace(/\t/g, "  ").length, text: m[2].trim() });
      i += 1;
    }
    return rows;
  }
  // A fenced code block: ``` optionally followed by a language tag, then raw lines until the
  // closing ```. The body is preserved VERBATIM (no inline markup, no trimming of interior
  // whitespace) so code, command transcripts, and tool-call traces survive intact. `lang=trace`
  // is parsed further into role-tagged turns (see parseTrace); every other lang is a monospace
  // code panel. An unterminated fence runs to end-of-input (tolerant).
  function takeFence(opening) {
    const body = [];
    i += 1; // consume the opening fence line
    while (i < lines.length && !isMarkdownFenceClosingLine(lines[i], opening)) {
      body.push(lines[i]);
      i += 1;
    }
    if (i < lines.length) i += 1; // consume the closing fence
    const text = body.join("\n").replace(/\n+$/, "");
    const rawInfo = opening.info;
    const lang = rawInfo.toLowerCase();
    const chart = opening.marker[0] === "`"
      ? parseChartObjectFenceInfo(rawInfo)
      : null;
    // Re-enter this lexer for the fence body so fenced and block-token charts use the exact same
    // list reader, including icon-token stripping and every future list normalisation pass.
    const chartBodyBlocks = chart && parseChartFenceBodyList(body) !== null
      ? lexMarkdownBlocksWith(body, normalizeIconKey)
      : [];
    const chartList = chartBodyBlocks.length === 1 && chartBodyBlocks[0]?.type === "list"
      ? chartBodyBlocks[0]
      : null;
    if (chart && chartList) {
      return {
        type: "object-chart",
        token: chart.token,
        shape: chart.shape,
        list: chartList,
        storage: "fence"
      };
    }
    if (lang === "trace") {
      return { type: "code", lang: "trace", text, turns: parseTrace(body) };
    }
    return { type: "code", lang, text };
  }
  // Hard guard: every pass of this loop must move on. A branch that stood on one line pass after
  // pass (a list row with a lone carriage return did, before takeList read it) grew `blocks` until
  // the process ran out of memory; now it is an error the caller can catch.
  let stoodAt = -1;
  let stood = 0;
  while (i < lines.length) {
    if (i !== stoodAt) { stoodAt = i; stood = 0; }
    else if ((stood += 1) > LEXER_MAX_PASSES_ON_ONE_LINE) throw new Error(`lexer-no-progress: line ${i + 1} of the slide's content`);
    stampTurn();
    const raw = lines[i];
    const t = lines[i].trim();
    if (!t) { i += 1; continue; }
    turn = { at: blocks.length, first: i };
    let m;
    // Fenced code block must be tested before everything else: its body can contain lines that
    // otherwise look like lists, quotes, tables, or directives, and they must pass through raw.
    const fenceOpening = parseMarkdownFenceOpeningLine(t);
    if (fenceOpening) {
      blocks.push(takeFence(fenceOpening));
      continue;
    }
    const chartObject = chartObjectTokenAt(lines, i);
    if (chartObject) {
      i = chartObject.listStart;
      blocks.push({
        type: "object-chart",
        token: chartObject.token,
        shape: chartObject.shape,
        list: takeList()
      });
      continue;
    }
    if ((m = t.match(/^\[Action:\s*(.+?)\s*(?:→|->)\s*(\S+?)\]$/i))
        || (m = t.match(/^\[Action:\s*(.+?)\]\((\S+?)\)$/i))) {
      // Action button directive (own line). PRIMARY form: `[Action: label → url]` (arrow);
      // also accepts the markdown-ish `[Action: label](url)`. Consecutive action blocks group
      // into a .slide-actions row of accent buttons (handled in renderBlocks). The URL is
      // scheme-allowlisted at render time exactly like an inline markdown link.
      blocks.push({ type: "action", label: m[1].trim(), url: m[2].trim() });
      i += 1; continue;
    }
    if ((m = t.match(/^\[(Embed|Simulation):\s*(.+?)\]$/i))) {
      const rawSrc = m[2].trim();
      const src = /^https?:/i.test(rawSrc) ? normalizeEmbedUrl(rawSrc) : rawSrc;
      blocks.push({ type: "embed", variant: m[1].toLowerCase(), src });
      i += 1; continue;
    }
    // `[Video: …]` takes one trailing token, {play-on-next}: a file plays as a step; a YouTube or
    // Vimeo player cannot, and the block carries the token only so the compiler can say so.
    if ((m = t.match(/^\[Video:\s*(.+?)\]\s*(\{\s*play-on-next\s*\})?$/i))) {
      const rawSrc = m[1].trim();
      const playOnNext = Boolean(m[2]);
      // A YouTube/Vimeo link is a live PLAYER, not a media file — route it to an iframe embed
      // (which plays in the standalone HTML from file://), not an HTML5 <video> that cannot load
      // a YouTube page. Real video file URLs / local assets stay as a <video> element.
      if (isVideoEmbedUrl(rawSrc)) {
        blocks.push({ type: "embed", variant: "video", src: normalizeEmbedUrl(rawSrc), ...(playOnNext ? { playOnNext: true } : {}) });
      } else {
        blocks.push({ type: "video", src: rawSrc, ...(playOnNext ? { flags: { playOnNext: true } } : {}) });
      }
      i += 1; continue;
    }
    // QR directive (own line). `[QR: url]` or `[QR: url | Caption label]`. The url is encoded
    // into a build-time QR SVG; the caption (or, absent one, the url) renders beneath. The
    // pipe is the label separator — chosen over a trailing `(Label)` because URLs may contain
    // parentheses but never a bare ` | `. A bare `[QR:]` with no url is ignored (no block).
    if ((m = t.match(/^\[QR:\s*([^\]|]+?)\s*(?:\|\s*(.+?)\s*)?\]$/i))) {
      const url = m[1].trim();
      if (url) blocks.push({ type: "qr", url, label: (m[2] || "").trim() });
      i += 1; continue;
    }
    if ((m = t.match(IMAGE_SYNTAX_RE))) {
      // A video FILE in image syntax is a video block (2026-06-10): ![alt](assets/talk.mp4)
      // is the natural authoring form next to images; [Video:] remains equivalent. Trailing curly
      // tokens (group 4) carry playback intent for videos (ADR-0028); images ignore them.
      if (imageSyntaxIsVideo(m[2])) {
        blocks.push({ type: "video", src: m[2], alt: m[1] || "", caption: m[3] || "", flags: parseMediaFlags(m[4]) });
      } else if (imageSyntaxIsAudio(m[2])) {
        // An audio FILE in image syntax is an `audio` block: a speaker chip that sits in the slide's
        // text flow. {autoplay} and {loop} carry over from video; the alt text is the chip's title.
        blocks.push({ type: "audio", src: m[2], title: m[1] || "", flags: parseMediaFlags(m[4]) });
      } else {
        // {play-on-next} on a line that is not a video or audio file is carried only to be reported.
        blocks.push({ type: "image", alt: m[1], src: m[2], caption: m[3] || "", ...(PLAY_ON_NEXT_RE.test(m[4] || "") ? { playOnNext: true } : {}) });
      }
      i += 1; continue;
    }
    if (/^\*\*Timeline:\*\*$/i.test(t)) {
      i += 1;
      while (peek() === "") i += 1;
      const rows = takeTimelineRows();
      // Ticket 22: the block form and a plain dated list yield ONE model — `stops` (date + text +
      // detail lines); `groups`/`items` are derived views kept for older consumers.
      blocks.push({ type: "timeline", ...timelineBlockFields(rows) });
      continue;
    }
    if (t.startsWith(">")) {
      // One `>` quotation block, its in-block or folded attribution and the practice rule: quote-grammar.mjs,
      // the one definition the editing side's outline reader shares.
      const taken = takeQuoteBlock(lines, i);
      blocks.push(taken.block);
      i = taken.end;
      continue;
    }
    if (t.startsWith("|") && lines[i + 1] && /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      const header = t.split("|").slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(lines[i].trim().split("|").slice(1, -1).map((c) => c.trim()));
        i += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    if (isListRowStart(t)) {
      const listAt = i;
      const list = takeList();
      // Never stand still: a line the list reader does not take is passed over.
      if (i === listAt) i += 1; else blocks.push(list);
      continue;
    }
    if ((m = t.match(/^(#{2,4})\s+(.+)/))) {
      blocks.push({ type: "subheading", text: m[2] });
      i += 1; continue;
    }
    // A paragraph runs until a blank line or a line that opens another block. Bullet markers
    // only break the paragraph when followed by whitespace (`- `, `* `) — a line beginning
    // with inline emphasis like `*New York Times*. "…"` is prose, not a list, and must be
    // captured (it is the leading source-reference line on many slides).
    const taken = takeParagraph(lines, i);
    const para = taken.parts;
    i = taken.end;
    if (para.length) {
      const paraText = para.join(" ");
      // AUTO-EMBED: a paragraph that is WHOLLY a single bare http(s) URL becomes an embed block
      // (iframe) — no `[Embed:]` needed. YouTube (watch/youtu.be/shorts) and Vimeo links are
      // converted to their player-embed form by normalizeEmbedUrl. A slide whose only content is
      // such a URL therefore renders as a full-bleed live embed. (Multi-token prose that merely
      // contains a URL stays a paragraph.)
      if (isBareUrl(paraText)) {
        blocks.push({ type: "embed", variant: "embed", src: normalizeEmbedUrl(paraText) });
      } else {
        // G1: a paragraph that is wholly a double-quoted statement becomes a quote block (ADR-0023 §5 D1:
        // a following dash-led line folds into its cite by the same rule the `>` path uses).
        const promoted = promoteQuotedParagraph(paraText, lines, i);
        if (promoted) {
          blocks.push(promoted.block);
          i = promoted.end;
        } else {
          // ADR-0023 §4: a WHOLLY bold paragraph is a claim, not a bold paragraph. Partial bold
          // stays prose and keeps its inline `<strong>` accent highlight.
          const claim = claimFromBoldParagraph(paraText);
          if (claim) blocks.push({ type: "claim", text: claim });
          else {
            // Plain view ticket 07 (spec T14): a paragraph ENDING in `{icon=NAME}` carries that
            // icon in a column beside it. Explicit form only: the bare `{name}` shorthand of list
            // items is not read here, so a paragraph that ends in ordinary braces is untouched.
            // The token is always stripped (an unresolvable NAME yields no icon, as on a list
            // item). Quotes, claims and bare-URL embeds were decided above on the whole text, so
            // a token inside them changes nothing.
            const iconed = takeParagraphIconWith(paraText, normalizeIconKey);
            if (iconed.text) {
              const paragraph = { type: "paragraph", text: iconed.text, ...(iconed.icon ? { icon: iconed.icon } : {}) };
              if (iconed.key !== undefined) hidden(paragraph, "iconToken", { line: i - 1, key: iconed.key, icon: iconed.icon });
              blocks.push(paragraph);
            }
          }
        }
      }
    }
    else i += 1;
  }
  stampTurn();
  return blocks;
}
