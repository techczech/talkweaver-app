import { isVideoEmbedUrl, normalizeEmbedUrl, isBareUrl, groupTimelineRows, quoteFromQuotedParagraph, parseTrace } from "./02-triggers-layout.mjs";
import { normalizeIconOverrideKey } from "./05-icons.mjs";

// Playback intent for a video, from trailing curly tokens on the media line (ADR-0028):
// ![alt](clip.mp4){autoplay}{loop}{muted}{controls}. A GIF converted by TalkWeaver carries
// {autoplay}{loop}{muted} (ambient, indistinguishable from the original GIF); a bare MP4 carries
// none (manual, control-barred). Unknown tokens are ignored. Returns {} when there are no tokens.
function parseMediaFlags(raw) {
  const flags = {};
  if (!raw) return flags;
  for (const m of raw.matchAll(/\{([^}]*)\}/g)) {
    const k = m[1].trim().toLowerCase();
    if (k === "autoplay" || k === "loop" || k === "muted" || k === "controls") flags[k] = true;
    else if (k === "mute") flags.muted = true;
  }
  return flags;
}

// =============================================================================
// 3. Markdown lexer — outline lines -> typed blocks (lists, fences, images, embeds, quotes)
// =============================================================================

export function lexMarkdownBlocks(lines) {
  const blocks = [];
  let i = 0;
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
      const m = line.match(/^(\s*)([-*]\s+|\d+[.)]\s+)(.+)$/);
      if (!m) break;
      const indent = m[1].replace(/\t/g, "  ").length;
      const isOrdered = /\d/.test(m[2]);
      rows.push({ indent, ordered: isOrdered, text: m[3].trim() });
      i += 1;
    }
    if (rows.length === 0) return { type: "list", ordered: false, items: [], children: [] };
    // Build a nested tree from the indent ladder. Each node: { text, ordered, children }.
    const roots = [];
    const stack = []; // entries: { indent, node }
    for (const r of rows) {
      const node = { text: r.text, ordered: r.ordered, children: [] };
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
    const takeItemIcon = (text) => {
      const explicit = text.match(/\s*\{\s*icon\s*=\s*([^}]+?)\s*\}\s*$/i);
      if (explicit) return { text: text.slice(0, explicit.index).trim(), icon: normalizeIconOverrideKey(explicit[1]) };
      const bare = text.match(/\s*\{\s*([^}=]+?)\s*\}\s*$/);
      if (bare) {
        const key = normalizeIconOverrideKey(bare[1]);
        if (key) return { text: text.slice(0, bare.index).trim(), icon: key };
      }
      return { text, icon: null };
    };
    const stripDeep = (nodes) => { for (const n of nodes) { n.text = takeItemIcon(n.text).text; if (n.children) stripDeep(n.children); } };
    const iconOverrides = roots.map((n) => {
      const r = takeItemIcon(n.text);
      n.text = r.text;
      if (n.children) stripDeep(n.children);
      return r.icon;
    });
    const items = roots.map((n) => n.text);
    const children = roots.map((n) => n.children);
    const hasOverride = iconOverrides.some(Boolean);
    return { type: "list", ordered, items, children, ...(hasOverride ? { iconOverrides } : {}) };
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
  function takeFence(lang) {
    const body = [];
    i += 1; // consume the opening fence line
    while (i < lines.length && lines[i].trim() !== "```") {
      body.push(lines[i]);
      i += 1;
    }
    if (i < lines.length) i += 1; // consume the closing fence
    const text = body.join("\n").replace(/\n+$/, "");
    if (lang === "trace") {
      return { type: "code", lang: "trace", text, turns: parseTrace(body) };
    }
    return { type: "code", lang, text };
  }
  while (i < lines.length) {
    const raw = lines[i];
    const t = lines[i].trim();
    if (!t) { i += 1; continue; }
    let m;
    // Fenced code block must be tested before everything else: its body can contain lines that
    // otherwise look like lists, quotes, tables, or directives, and they must pass through raw.
    if ((m = t.match(/^```(.*)$/))) {
      blocks.push(takeFence(m[1].trim().toLowerCase()));
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
    if ((m = t.match(/^\[Video:\s*(.+?)\]$/i))) {
      const rawSrc = m[1].trim();
      // A YouTube/Vimeo link is a live PLAYER, not a media file — route it to an iframe embed
      // (which plays in the standalone HTML from file://), not an HTML5 <video> that cannot load
      // a YouTube page. Real video file URLs / local assets stay as a <video> element.
      if (isVideoEmbedUrl(rawSrc)) {
        blocks.push({ type: "embed", variant: "video", src: normalizeEmbedUrl(rawSrc) });
      } else {
        blocks.push({ type: "video", src: rawSrc });
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
    if ((m = t.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*((?:\{[^}]*\}\s*)*)$/))) {
      // A video FILE in image syntax is a video block (2026-06-10): ![alt](assets/talk.mp4)
      // is the natural authoring form next to images; [Video:] remains equivalent. Trailing curly
      // tokens (group 4) carry playback intent for videos (ADR-0028); images ignore them.
      if (/\.(mp4|webm|mov|m4v)$/i.test(m[2].split(/[?#]/)[0]) && !isVideoEmbedUrl(m[2])) {
        blocks.push({ type: "video", src: m[2], alt: m[1] || "", caption: m[3] || "", flags: parseMediaFlags(m[4]) });
      } else {
        blocks.push({ type: "image", alt: m[1], src: m[2], caption: m[3] || "" });
      }
      i += 1; continue;
    }
    if (/^\*\*Timeline:\*\*$/i.test(t)) {
      i += 1;
      while (peek() === "") i += 1;
      const rows = takeTimelineRows();
      const groups = groupTimelineRows(rows);
      // `items` retained for back-compat (flattened entry bodies); `groups` carries the
      // structured shape. Consumers prefer `groups`.
      const items = groups.flatMap((g) => g.items.map((it) => (it.date ? `${it.date} — ${it.body}` : it.body)));
      blocks.push({ type: "timeline", groups, items });
      continue;
    }
    if (t.startsWith(">")) {
      // Collect one quote block from a contiguous run of `>` lines. A blank `>` line
      // (`>` with nothing after it) is a paragraph break WITHIN the quote, so a single
      // multi-paragraph quote keeps its structure. A plain blank line (no `>`) ends the
      // quote — so two `>` groups separated by a blank line stay two distinct quotes, each
      // keeping its own cite. The final `— …` line of a block becomes its cite.
      const quoteLines = [];
      const breakAfter = new Set(); // indices into quoteLines after which a paragraph break falls
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        const inner = lines[i].trim().replace(/^>\s?/, "");
        if (inner.trim() === "") {
          // blank `>` line → paragraph break after the line collected so far
          if (quoteLines.length) breakAfter.add(quoteLines.length - 1);
        } else {
          quoteLines.push(inner);
        }
        i += 1;
      }
      // The final non-empty `>` line, if it starts with an em/en dash, is the citation.
      let cite = "";
      const lastLine = quoteLines[quoteLines.length - 1] || "";
      if (/^[—–-]\s*/.test(lastLine)) {
        cite = lastLine.replace(/^[—–-]\s*/, "");
        breakAfter.delete(quoteLines.length - 1);
        quoteLines.pop();
      } else {
        // The attribution often follows the `>` block on its OWN line (not `>`-prefixed):
        //   > A quote.
        //   — Project manager, 2025
        // When the next non-blank line is a dash-led attribution, fold it into this quote's cite
        // (so the quote is self-contained and a quote-only slide stays quote-only). Skip blanks.
        let j = i;
        while (j < lines.length && lines[j].trim() === "") j += 1;
        if (j < lines.length && /^[—–]\s+\S/.test(lines[j].trim())) {
          cite = lines[j].trim().replace(/^[—–]\s*/, "");
          i = j + 1;
        } else if (
          j < lines.length &&
          /^[-*+]\s+\S/.test(lines[j].trim()) &&
          !(j + 1 < lines.length && /^[-*+]\s+\S/.test(lines[j + 1].trim()))
        ) {
          // A LONE bullet right after a quote is its ATTRIBUTION, not a list:
          //   > A quote.
          //   - Senior researcher
          // Fold it into the cite (renders as <cite> below the quote in every layout). Guarded to
          // a SINGLE bullet — the next content line must NOT also be a bullet — so a real 2+ item
          // list following a quote stays a list. (Em/en dash attributions are handled above; a
          // hyphen would otherwise collide with the `- item` bullet syntax, which is why a lone
          // bullet is the only safe hyphen case to fold.)
          cite = lines[j].trim().replace(/^[-*+]\s*/, "");
          i = j + 1;
        }
      }
      // Group remaining lines into paragraphs honouring the blank-`>` breaks.
      const paras = [];
      let current = [];
      quoteLines.forEach((ln, idx) => {
        current.push(ln);
        if (breakAfter.has(idx)) { paras.push(current.join(" ").trim()); current = []; }
      });
      if (current.length) paras.push(current.join(" ").trim());
      const paragraphs = paras.filter(Boolean);
      // Back-compat: `text` is the whole quote joined; `paragraphs` preserves the breaks.
      blocks.push({ type: "quote", text: paragraphs.join(" ").trim(), paragraphs, cite });
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
    if (/^[-*]\s+/.test(t) || /^\d+[.)]\s+/.test(t)) { blocks.push(takeList()); continue; }
    if ((m = t.match(/^(#{2,4})\s+(.+)/))) {
      blocks.push({ type: "subheading", text: m[2] });
      i += 1; continue;
    }
    // A paragraph runs until a blank line or a line that opens another block. Bullet markers
    // only break the paragraph when followed by whitespace (`- `, `* `) — a line beginning
    // with inline emphasis like `*New York Times*. "…"` is prose, not a list, and must be
    // captured (it is the leading source-reference line on many slides).
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^([>|!#]|[-*]\s|\d+[.)]\s|\[(Embed|Simulation|Video):|\*\*Timeline)/i.test(lines[i].trim())) {
      para.push(lines[i].trim());
      i += 1;
    }
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
        // G1: a paragraph that is wholly a double-quoted statement becomes a quote block.
        const promoted = quoteFromQuotedParagraph(paraText);
        if (promoted) {
          blocks.push({ type: "quote", text: promoted.text, paragraphs: [promoted.text], cite: promoted.cite });
        } else {
          blocks.push({ type: "paragraph", text: paraText });
        }
      }
    }
    else i += 1;
  }
  return blocks;
}

