// =============================================================================
// One slide read as the compiler reads it: its layout, its blocks, and its quotation.
//
// These are the steps 08-source-adapters.mjs takes for every slide (flushSlide) and for its split
// probe (continuationSplitForNode), kept here with no file or Node access so the app can take the
// same steps on one slide of the outline being edited (src/shared/quote-write-check.ts): a verb
// that is about to write to a quote slide asks what the compiler will make of the result, and
// writes nothing when the answer is not what it meant.
//
//   sectionDividerDecision   is this heading a section divider by default
//   slideLayoutOverBlocks    the layout once the blocks are lexed (a slide of chart tokens is a chart)
//   mapQuoteSlideBlocks      what mapBlocksToLayout does for the quote layout
//   annotateQuoteSlide       the title as citation, then the quote form
//   slideReader(lex)         the steps that lex, made over a lexer (below)
//     .inferSlideLayout      the slide's layout from its attributes and content
//     .readSlidePoll         the slide's poll, and its lines without the poll's directive lines
//     .readSlideBlocks       layout + lexed blocks (the address under a quotation adopted)
//     .probeNodeSlide        all of the above for one outline-tree node, up to the mapped blocks
//     .quoteSlideReading     probeNodeSlide as the slide is drawn + annotateQuoteSlide: the quotation the compiler
//                            draws, and whether anything the compiler does afterwards puts it somewhere else
//
// What flushSlide does after these steps, and what the reading says about each (the app writes a quote form only on
// a slide whose quotation is drawn where it was read):
//   a container rebuilt from the blocks ({carousel} on any layout)   `layout` is the container's (slideContainerKind)
//   child headings folded into the slide (cards, columns, compare)    `childFold` names the fold; the reading does
//                                                                     not hold the folded content
//   a poll: the page shows the poll's frame in place of the body      `pollFrame`
//   a long quotation split over several slides                        never a quotation drawn as a form
// The fold of a slide INTO a heading above it is asked of that heading (slide-containers.mjs `childFoldOfNode`).
//
// The lexer is handed in because the compiler's (03-markdown-lexer.mjs) loads the icon catalogue from disk to read
// a `{name}` at the end of a list item. The compiler makes its reader over that lexer; the app makes one over the
// same lexer code (03-markdown-lexer-core.mjs) with a key resolver of its own.
// =============================================================================
import { parseGridDims } from "./grid-dims.mjs";
import { simulationLayoutForFence } from "./simulation-fences.mjs";
import { applyQuoteTitleAttribution } from "./02-triggers-layout.mjs";
import { parseChartItems } from "./06-chart-renderer.mjs";
import { adoptAddressUnderQuote, annotateQuoteForm } from "./quote-forms.mjs";
import { foldContentTriggerLines, slideAttrsFromNode } from "./slide-attrs.mjs";
import { pollDirectivesFor, pollDefinitionFor } from "./poll-authoring.mjs";
import { pollFrameEligible } from "./poll-frame.mjs";
import { checkContentLines, childFoldOfNode, slideContainerKind } from "./slide-containers.mjs";
import { isStatementDimensionKey } from "./statement-options.mjs";
import { SECTION_ONLY_TRIGGER_KEYS } from "../triggers.mjs";

// AUTHOR WINS (Composition ticket 1). A heading that carries child headings and an empty body is
// SHAPED like a section divider, so structure supplies the divider DEFAULT — layout `section-title`
// plus the derived section/subsection role. It is a default, never a verdict: the moment the author
// writes a token of their own on that heading the slide is theirs, and the normal `inferLayout` +
// role derivation run with the author's tokens winning. These keys are the exception — they carry
// no design decision, so a heading wearing only these is still bare:
//   • identity + provenance (the shared registry's `systemTokens`, entries.ts), stamped by the app;
//   • the section-scoped triggers, which configure the SECTION (its accent, its timer, how its
//     children are shown) and say nothing about this heading's own slide — a container section is
//     divider-shaped by definition.
const DIVIDER_NEUTRAL_ATTR_KEYS = new Set([
  "id", "tags", "from", "clonedFrom",
  ...SECTION_ONLY_TRIGGER_KEYS.map((entry) => entry.key),
  "timer"
]);

// The divider roles, and the tokens that ASK for a divider. `{sub}` is the registered
// subsection-divider trigger and `{role=section-title}` / `{role=subsection-title}` name the
// divider outright: an author writing one of those wants the divider, so it can never suppress it.
const DIVIDER_ROLES = new Set(["section-title", "subsection-title"]);
const asksForDivider = (key, attrs) => key === "sub"
  || ((key === "role" || key === "layout") && DIVIDER_ROLES.has(attrs?.[key]));

// The ABSORBING layout families: each one pulls its `####` children INTO the parent slide
// (foldChildLayoutNodes). A fold leaves the parent holding cards and no children, so a heading that
// still has BOTH its children and an empty body was REFUSED the fold — wrong child count: contrast
// wants 2–3, compare and columns want 2+. Their slide would render with nothing in it, so the
// divider stands. A divider beats a blank slide, and the refusal is already reported on its own
// terms (contrast-groups-count).
const ABSORBING_LAYOUTS = new Set(["contrast", "compare", "columns", "cards", "image-grid", "carousel"]);

/**
 * The ONE decision both the slide emitter and the sequencer's spine probe ask: is this heading a
 * section divider by default, and if its shape says yes, did the author's own tokens override it?
 *
 * @param {{isSection?: boolean, lines?: string[], cards?: unknown[]}} slide — the slide (or probe).
 * @param {Iterable<string>} authoredKeys — attribute keys THIS heading set itself (its trigger
 *   group plus any stray trigger line in its body). Deck-wide `triggers:` defaults are deliberately
 *   excluded: they are not a decision about this slide.
 * @param {string} [authoredLayout] — the layout `inferLayout` reads off the author's tokens. Only
 *   used to spot an absorbing family whose fold was refused.
 * @returns {{divider: boolean, structural: boolean, foldRefused: boolean, authorTokens: string[]}}
 *   `structural` = the shape qualifies; `divider` = the divider default actually applies;
 *   `foldRefused` = the divider stands because the author's absorbing layout has nothing to show;
 *   `authorTokens` = the sorted author keys that overrode it (empty unless `structural && !divider`).
 */
export function sectionDividerDecision(slide, authoredKeys, authoredLayout) {
  const structural = Boolean(slide?.isSection)
    && !(slide?.lines || []).some((line) => String(line).trim())
    && (slide?.cards || []).length === 0;
  if (!structural) return { divider: false, structural: false, foldRefused: false, authorTokens: [] };
  if (ABSORBING_LAYOUTS.has(authoredLayout)) {
    return { divider: true, structural: true, foldRefused: true, authorTokens: [] };
  }
  const attrs = slide?.attrs || {};
  const authorTokens = [...new Set(authoredKeys || [])]
    .filter((key) => !DIVIDER_NEUTRAL_ATTR_KEYS.has(key) && !asksForDivider(key, attrs))
    .sort();
  return { divider: authorTokens.length === 0, structural: true, foldRefused: false, authorTokens };
}

/** The layout once the blocks are lexed: a slide that is only chart object tokens is a chart, whatever it was read as. */
export function slideLayoutOverBlocks(layout, rawBlocks) {
  return rawBlocks.length > 0 && rawBlocks.every((block) => block?.type === "object-chart") ? "chart" : layout;
}

/** A chart object token with its list becomes the chart block (the first step of mapBlocksToLayout, every layout). */
export function chartsFromObjectTokens(blocks) {
  return blocks.map((block) => {
    if (block?.type !== "object-chart" || !block.list) return block;
    const { points, unparsed } = parseChartItems(block.list.items, block.list.children);
    return {
      type: "chart",
      points,
      unparsed,
      shape: block.shape,
      objectToken: block.token
    };
  });
}

/** Every list a layout did not take becomes a feature list (the last step of mapBlocksToLayout, every layout). */
export function featurizeRemainingLists(blocks) {
  return blocks.map((b) => (b && b.type === "list" && Array.isArray(b.items)
    ? { ...b, type: "feature-list" }
    : b));
}

/** mapBlocksToLayout for the quote layout, which takes no block for itself: the two steps every layout shares. */
export function mapQuoteSlideBlocks(blocks) {
  return featurizeRemainingLists(chartsFromObjectTokens(blocks));
}

/**
 * The quotation of a slide's mapped blocks as it is drawn. ADR-0023 section 5 rule 2: a quote with no attribution is
 * attributed to the slide's own title (`citeFromTitle`). Then the form is decided (`block.quoteForm`): a quote that
 * draws as a form is never split, and a form that refuses stays the Plain quote it is. Mutates `blocks` (and
 * `attrs.title`, see annotateQuoteForm).
 */
export function annotateQuoteSlide(blocks, layout, attrs, title, slideId, warn) {
  applyQuoteTitleAttribution(blocks, title);
  annotateQuoteForm(blocks, layout, attrs, slideId, warn);
}

/**
 * The steps that read a slide's lines, over `lexMarkdownBlocks(lines)`: the compiler's lexer, or the same lexer code
 * with another icon-key resolver (see the head of this file). Returns the four functions below.
 */
export function slideReader(lexMarkdownBlocks) {
  /** The slide's layout: what its attributes name or imply, else what its content is. `s` as for readSlideBlocks. */
  function inferSlideLayout(s) {
    if (s.attrs.layout) return s.attrs.layout;
    // Value-form statement triggers imply their layout just as {contrast=tint} implies contrast.
    if (s.attrs.statement != null) return "statement";
    // Ticket 02: so do the per-dimension statement tokens ({statement-bg=full}, …) — read from the
    // slide's OWN trigger line only, so a deck-wide `triggers:` default never makes every slide one.
    if ((s.authoredAttrKeys ?? []).some(isStatementDimensionKey)) return "statement";
    // {2col}/{3col} resolve to a bare `cols` attr with no explicit layout — pin the columns
    // layout when a column count is present (a `cols=N` always means "lay these out in columns").
    if (s.attrs.cols != null && s.attrs.cols !== true) return "columns";
    // {timeline=dynamic|rail|…} without a bare {timeline}: the mode attr alone means timeline
    // (the cols→columns / chart-shape pattern).
    if (s.attrs.timeline != null && s.attrs.timeline !== true) return "timeline";
    // {barchart}/{piechart}/{linechart}/{curve} resolve to a bare `chart` attr with no explicit
    // layout — any chart shape means "draw this as a chart" (the cols→columns pattern).
    if (s.attrs.chart != null && s.attrs.chart !== true) return "chart";
    // {curve=sigmoid}: `curve` as a VALUE attr means the conceptual S-curve layout. (Bare {curve}
    // resolves to chart=line via the dictionary and never sets a `curve` attr, so no clash.)
    if (s.attrs.curve === "sigmoid") return "sigmoid";
    // {contrast=cards} (the legacy pair-card device) is a `contrast` VALUE attr with no explicit
    // layout — asking for a contrast variant means the contrast layout.
    if (s.attrs.contrast != null && s.attrs.contrast !== true) return "contrast";
    if (s.attrs.equation != null && s.attrs.equation !== true) return "equation";
    // {blocks:RxC} pins a grid's dimensions, so it also IMPLIES the grid layout when no explicit
    // layout is set (an author writing `{blocks:3x3}` wants a grid).
    if (parseGridDims(s.attrs.blocks)) return "grid";
    // {cards=stepped} sets a `cards` VALUE attr (no explicit layout); asking for a cards variant
    // means the cards layout (the cols→columns pattern). Bare {cards} sets layout=cards above.
    // ADR-0032: a NUMBER is a board's cards-per-phone setting ({cards=3}), never the cards layout.
    if (s.attrs.cards != null && s.attrs.cards !== true && !/^\d+$/.test(String(s.attrs.cards))) return "cards";
    if (s.cards.length) return "cards";
    // Quote forms, ticket 10: on a slide whose form is set, the address on its own line under the one quotation is
    // the quote's source line, not media, so the slide is the quote-only slide it would be with `- https://…`.
    const blocks = adoptAddressUnderQuote(lexMarkdownBlocks(s.lines), s.lines, s.attrs);
    const hasMedia = blocks.some((b) => ["image", "embed", "video"].includes(b.type));
    const hasList = blocks.some((b) => b.type === "list");
    // ADR-0023 §4: a claim is a wholly bold PARAGRAPH — it occupies the same slot, so layout
    // inference must not see a slide differently because its prose happens to be a claim.
    const hasParagraph = blocks.some((b) => b.type === "paragraph" || b.type === "claim");
    const hasQuote = blocks.some((b) => b.type === "quote");
    const hasText = hasList || hasParagraph || hasQuote;
    // A slide carrying a fenced code/trace block (and no media) is a code slide: a `trace` block
    // gets the trace layout, any other code gets the generic code layout. The big title rides
    // above the panel. Media + code still falls through to copy-visual/media below.
    const codeBlock = blocks.find((b) => b.type === "code");
    if (codeBlock && !hasMedia) return simulationLayoutForFence(codeBlock.lang) || (codeBlock.lang === "trace" ? "trace" : "code");
    // A timeline is a graphical element (like media). When it is paired with a COMMENT — a
    // standalone paragraph or quote, no other media — lay the two side by side (timeline one
    // column, comment beside, centred as a unit) instead of stacking the comment under the
    // rail. This reuses the copy-/list-visual column grammar (Fix 1). A timeline with a list
    // (not a comment), or a bare timeline, keeps the single-column `timeline` layout.
    if (blocks.some((b) => b.type === "timeline")) {
      const hasComment = (hasParagraph || hasQuote) && !hasMedia && !hasList;
      return hasComment ? "timeline-visual" : "timeline";
    }
    // F1: media + list only (no paragraphs, no quotes) → list-visual two-column layout.
    // The big title is kept; the feature-list fills one column, the media the other.
    if (hasMedia && hasList && !hasParagraph && !hasQuote) return "list-visual";
    // A table counts as text-like content here (2026-06-09): table + screenshot slides were
    // falling through to the stacked full-width media layout; they read far better as the
    // copy-visual pair (image left, table right).
    if (hasMedia && (hasText || blocks.some((b) => b.type === "table"))) return "copy-visual";
    if (hasMedia) return "media";
    // Quote-only slide: the slide's whole content is one (or more) `>` quote block(s) and
    // nothing else structural — no list, no media, no paragraph, no timeline/table/code. The
    // quote IS the slide, full-bleed; the heading is NAV-ONLY by default (not drawn — see the
    // titleMode default for `quote`). Re-show the heading with `{title=show}`.
    // A practice quotation (ticket 05: a `>` line carrying a key cap) is an instruction on an
    // ordinary slide, never a quote-only slide: its title stays and it is not split.
    if (hasQuote && !hasList && !hasParagraph
        && blocks.some((b) => b.type === "quote" && !b.practice)
        && !blocks.some((b) => ["timeline", "table", "code"].includes(b.type))) {
      return "quote";
    }
    // Prose-only slide: at least one paragraph and nothing else structural (no list,
    // media, timeline, table, quote). The paragraph IS the point — render it as a
    // statement (large, beside the title), not as an empty list.
    const hasStructural = blocks.some((b) =>
      ["list", "timeline", "table", "quote"].includes(b.type));
    if (hasParagraph && !hasStructural) return "statement";
    // A bare leaf heading states itself. Every token that implies a different layout or role has
    // already returned above, so presentation and stepping tokens must not veto this fallthrough.
    if (blocks.length === 0 && !s.isSection) return "statement";
    return "list";
  }

  /**
   * The slide's poll (null when it has none, or one that is not valid) and its content lines: with a poll, the lines
   * without the poll's `[scale: …]` / `[categories: …]` directive lines. `slide` is `{ attrs, title, lines, treeNode }`;
   * the poll's findings are pushed to `warnings`.
   */
  function readSlidePoll(slide, slideId, warnings) {
    const authored = pollDirectivesFor(slide.lines);
    const poll = pollDefinitionFor(slide, lexMarkdownBlocks(authored.contentLines), slideId, authored, warnings);
    return { poll, lines: poll ? authored.contentLines : slide.lines };
  }

  /**
   * A slide's layout and lexed blocks. `s` is `{ attrs, lines, cards, isSection, authoredAttrKeys }`: the lines are the
   * content lines with Trigger lines folded into `attrs` (foldContentTriggerLines). The address under the one quotation
   * of a quote slide whose form is set is adopted as its source line (quote forms, ticket 10): the same reading
   * inferSlideLayout made.
   */
  function readSlideBlocks(s) {
    const authoredLayout = inferSlideLayout(s);
    // Structure proposes the divider, the author disposes (see sectionDividerDecision).
    const dividerDecision = sectionDividerDecision(s, s.authoredAttrKeys, authoredLayout);
    const layout = dividerDecision.divider ? "section-title" : authoredLayout;
    const rawBlocks = lexMarkdownBlocks(s.lines);
    if (layout === "quote") adoptAddressUnderQuote(rawBlocks, s.lines, s.attrs);
    return { authoredLayout, dividerDecision, layout, rawBlocks };
  }

  /**
   * One outline-tree node read up to its mapped blocks: the deck's defaults under its own attributes, Trigger lines
   * among its content folded in, its layout, its blocks lexed and mapped by `mapBlocks(layout, rawBlocks)` (the
   * compiler passes mapBlocksToLayout). Folded child cards are not read (`cards: []`).
   * As the compiler's split probe calls it (no `asDrawn`), no warnings are raised and the lines are the node's own.
   * With `asDrawn: { warnings }` the steps flushSlide takes before it reads the blocks are taken too: a quick check's
   * `{right}` markers leave the lines, a poll's directive lines leave them (`poll` is its definition, its findings
   * go to `warnings`), and a slide that is only chart object tokens is a chart.
   */
  function probeNodeSlide(node, deckTriggerDefaults, mapBlocks, asDrawn = null) {
    const attrs = slideAttrsFromNode(node, deckTriggerDefaults);
    const authoredKeys = new Set(Object.keys(node.attrs || {}));
    let lines = foldContentTriggerLines(node, attrs, { onWarning: null, authoredKeys });
    let poll = null;
    if (asDrawn) {
      lines = checkContentLines(attrs, lines);
      ({ poll, lines } = readSlidePoll({ attrs, title: node.title, lines, treeNode: node }, node.id || "", asDrawn.warnings));
    }
    const probe = {
      attrs,
      lines,
      cards: [],
      isSection: (node.children || []).length > 0,
      authoredAttrKeys: [...authoredKeys]
    };
    const read = readSlideBlocks(probe);
    const rawBlocks = read.rawBlocks;
    const layout = asDrawn ? slideLayoutOverBlocks(read.layout, rawBlocks) : read.layout;
    for (const b of rawBlocks) {
      if (b && b.type === "timeline" && attrs.timeline) b.mode = attrs.timeline;
    }
    return { attrs, lines, layout, blocks: mapBlocks(layout, rawBlocks), poll };
  }

  /**
   * The quotation the compiler draws for one outline-tree node, for the app's check before a write. Returns
   * `{ layout, attrs, lines, blocks, warnings, quote, poll, pollFrame, childFold }`:
   *   - `layout` is the layout the compiled slide has: the layout its content was read as, or `carousel` when
   *     {carousel} makes every block a sub-slide (slideContainerKind: the blocks are then no longer the slide's own);
   *   - `quote` is the slide's one quotation block (its `text`, `paragraphs`, `cite`, `citeFromTitle`, `quoteForm`)
   *     when the layout is `quote` and there is exactly one, else null; `blocks` are mapped only for the quote layout
   *     (mapQuoteSlideBlocks: no other layout is asked about);
   *   - `warnings` are annotateQuoteForm's and the poll's, with the node's id;
   *   - `pollFrame`: the slide has a poll whose frame the page shows in place of the slide's body (07-assembly.mjs),
   *     so nothing read here is drawn;
   *   - `childFold`: the fold that takes the node's child headings into its slide ('' for none). Their content is
   *     not in this reading, so with a fold the reading is not the slide the compiler draws.
   */
  function quoteSlideReading(node, deckTriggerDefaults) {
    const warnings = [];
    const probe = probeNodeSlide(node, deckTriggerDefaults, (layout, rawBlocks) => (layout === "quote" ? mapQuoteSlideBlocks(rawBlocks) : rawBlocks), { warnings });
    const drawn = {
      pollFrame: pollFrameEligible({ poll: probe.poll }),
      childFold: childFoldOfNode(node, deckTriggerDefaults)
    };
    const layout = slideContainerKind(probe.layout, probe.attrs, 0) === "carousel" ? "carousel" : probe.layout;
    if (layout !== "quote") return { ...probe, layout, warnings, quote: null, ...drawn };
    annotateQuoteSlide(probe.blocks, probe.layout, probe.attrs, node.title, node.id || "", (warning) => warnings.push(warning));
    const quotes = probe.blocks.filter((block) => block && block.type === "quote" && !block.practice);
    return { ...probe, warnings, quote: quotes.length === 1 ? quotes[0] : null, ...drawn };
  }

  return { inferSlideLayout, readSlidePoll, readSlideBlocks, probeNodeSlide, quoteSlideReading };
}
