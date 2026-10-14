import { parseHeadingAttrs, parseTriggerLine } from "./02-triggers-layout.mjs";
import { chartObjectTokenAt } from "./03-object-token.mjs";
import { classifyContentLines } from "./14-outline-tree.mjs";
import { parseGridDims } from "./grid-dims.mjs";
import { adoptAddressUnderQuote } from "./quote-forms.mjs";
import { SIM_FENCE_LANGS, simulationLayoutForFence } from "./simulation-fences.mjs";
import { pollDirectivesFor, pollDefinitionFor } from "./poll-authoring.mjs";
import { takeRightMarkers } from "./prework.mjs";
import { isStatementDimensionKey } from "./statement-options.mjs";
import { SECTION_ONLY_TRIGGER_KEYS } from "../triggers.mjs";

// =============================================================================
// The AUTHORED half of the compiler's layout decision: which layout a slide's own tokens name,
// before any reading of its content. Pure (no file access), so the editor bundles the very
// function the compiler runs (src/shared/plain-view-compiler-facts.ts): the margin's layout label
// and the layout verbs never keep a precedence list of their own.
//
// 08-source-adapters.mjs `inferLayout` calls `authoredLayoutDecision` first and falls through to
// its content-based inference only when this returns null.
// =============================================================================

// `parseGridDims` ({blocks:RxC}: rows × cols, or null) lives in grid-dims.mjs, the one definition
// (slide-quote-reading.mjs reads it too); re-exported here for the editor.
export { parseGridDims };

// The layout the slide's attrs name, and the attr that named it: { layout, by } or null when no
// token names one (the compiler then reads the content). `attrs` is the slide's merged attrs
// (deck-wide `triggers:` defaults, heading groups, Trigger block, stray Trigger lines, later ones
// winning); `authoredAttrKeys` the keys the slide set ITSELF. `by` is the attr key that decided,
// or "statement-dimension" for a statement option written on the slide's own lines.
export function authoredLayoutDecision(attrs, authoredAttrKeys) {
  if (attrs.layout) return { layout: attrs.layout, by: "layout" };
  // Value-form statement triggers imply their layout just as {contrast=tint} implies contrast.
  if (attrs.statement != null) return { layout: "statement", by: "statement" };
  // Ticket 02: so do the per-dimension statement tokens ({statement-bg=strong}, …) — read from the
  // slide's OWN trigger line only, so a deck-wide `triggers:` default never makes every slide one.
  if ((authoredAttrKeys ?? []).some(isStatementDimensionKey)) return { layout: "statement", by: "statement-dimension" };
  // {2col}/{3col} resolve to a bare `cols` attr with no explicit layout — pin the columns
  // layout when a column count is present (a `cols=N` always means "lay these out in columns").
  if (attrs.cols != null && attrs.cols !== true) return { layout: "columns", by: "cols" };
  // {timeline=dynamic|rail|…} without a bare {timeline}: the mode attr alone means timeline
  // (the cols→columns / chart-shape pattern).
  if (attrs.timeline != null && attrs.timeline !== true) return { layout: "timeline", by: "timeline" };
  // {barchart}/{piechart}/{linechart}/{curve} resolve to a bare `chart` attr with no explicit
  // layout — any chart shape means "draw this as a chart" (the cols→columns pattern).
  if (attrs.chart != null && attrs.chart !== true) return { layout: "chart", by: "chart" };
  // {curve=sigmoid}: `curve` as a VALUE attr means the conceptual S-curve layout. (Bare {curve}
  // resolves to chart=line via the dictionary and never sets a `curve` attr, so no clash.)
  if (attrs.curve === "sigmoid") return { layout: "sigmoid", by: "curve" };
  // {contrast=cards} (the legacy pair-card device) is a `contrast` VALUE attr with no explicit
  // layout — asking for a contrast variant means the contrast layout.
  if (attrs.contrast != null && attrs.contrast !== true) return { layout: "contrast", by: "contrast" };
  if (attrs.equation != null && attrs.equation !== true) return { layout: "equation", by: "equation" };
  // {blocks:RxC} pins a grid's dimensions, so it also IMPLIES the grid layout when no explicit
  // layout is set (an author writing `{blocks:3x3}` wants a grid).
  if (parseGridDims(attrs.blocks)) return { layout: "grid", by: "blocks" };
  // {cards=stepped} sets a `cards` VALUE attr (no explicit layout); asking for a cards variant
  // means the cards layout (the cols→columns pattern). Bare {cards} sets layout=cards above.
  // ADR-0032: a NUMBER is a board's cards-per-phone setting ({cards=3}), never the cards layout.
  if (attrs.cards != null && attrs.cards !== true && !/^\d+$/.test(String(attrs.cards))) return { layout: "cards", by: "cards" };
  return null;
}

// A slide whose every block is a chart object is drawn as a chart whatever layout its tokens name
// (08-source-adapters.mjs flushSlide applies this after the authored decision).
export function isChartOnlySlide(rawBlocks) {
  return rawBlocks.length > 0 && rawBlocks.every((block) => block?.type === "object-chart");
}

// ADR-0015 — frontmatter `triggers:` is the deck-wide DEFAULTS level: the same vocabulary
// (bare words / key=value, space-separated, no braces needed), applied to every slide and
// overridden by anything the slide sets itself. Per-slide-only keys make no sense deck-wide and
// are barred with a warning: layout (and its bare-word shorthands) and id.
// Returns { defaults, warnings } (the resolver's warnings first, then one per barred key).
export function deckTriggerDefaultsFrom(triggers) {
  const defaults = {};
  const warnings = [];
  if (typeof triggers === "string" && triggers.trim()) {
    const parsed = parseHeadingAttrs(`{${triggers.replace(/[{}]/g, " ").trim()}}`);
    for (const w of parsed.warnings || []) warnings.push(w);
    for (const [key, value] of Object.entries(parsed.attrs)) {
      if (key === "layout" || key === "id") {
        warnings.push(`frontmatter-trigger-ignored:${key}=${value}`);
        continue;
      }
      defaults[key] = value;
    }
  }
  return { defaults, warnings };
}

// =============================================================================
// The section-divider default. Moved verbatim from 08-source-adapters.mjs (which re-exports it).
// =============================================================================

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

// Whether a heading takes its child headings INTO its own slide, and how — the decision
// 08-source-adapters.mjs foldChildLayoutNodes acts on, in its order of precedence:
//   "carousel"  {carousel} with any child: one DOM slide, the children as its cards;
//   "cards"     the static containers: {cards=grid|rows} or {image-grid} with any child, {contrast}
//               with 2–3 (the static compare renderer accepts only 2–3 groups);
//   "columns"   {columns}/{2col}/{3col} (a `cols=N`) with 2+: the children become its columns;
//   "compare"   {compare} with 2+: the first two children are its halves.
// null: the children stay slides of their own, and a heading with an empty body is then shaped
// like a section divider (sectionDividerDecision). `attrs` are the node's resolved attrs (deck
// defaults, its own tokens, its stray Trigger lines).
export function childFoldKind(attrs, childCount) {
  if (!childCount) return null;
  if (attrs.carousel === true) return "carousel";
  if (attrs.cards === "grid" || attrs.cards === "rows") return "cards";
  if (attrs.layout === "image-grid") return "cards";
  if (attrs.layout === "contrast" && childCount >= 2 && childCount <= 3) return "cards";
  if ((attrs.layout === "columns" || (attrs.cols != null && attrs.cols !== true)) && childCount >= 2) return "columns";
  if (attrs.layout === "compare" && childCount >= 2) return "compare";
  return null;
}

// =============================================================================
// The FINAL layout: what a slide is drawn in. Every function below is the compiler's own
// (08-source-adapters.mjs calls each of them) and pure, so the editor runs the same code:
//   foldChildLayoutNodes     which headings take their child headings into their slide;
//   slideLayoutInput         what a slide is made of (attrs, content lines, cards, section or not);
//   slideLayoutPlan          tokens, then content, then the divider default, then chart-only;
//   cardsLayoutDecision      the card treatments, which can change the layout once more;
//   finalSlideLayout         the two together: the `layout` of the compiled slide.
// =============================================================================

// AI chat / terminal simulations: the fence languages that are a layout of their own
// (simulation-layout.mjs reads the same set).
// The set and the function live in simulation-fences.mjs, the one definition; re-exported here.
export { SIM_FENCE_LANGS, simulationLayoutForFence };

// Which layout a slide gets from its tokens, its folded cards and its content. `s` is
// { attrs, authoredAttrKeys, cards, lines, isSection }; `lex` the Markdown lexer over `s.lines`.
export function inferSlideLayout(s, lex) {
  const authored = authoredLayoutDecision(s.attrs, s.authoredAttrKeys);
  if (authored) return authored.layout;
  if (s.cards.length) return "cards";
  // Quote forms, ticket 10: on a slide whose form is set, the address on its own line under the one quotation is
  // the quote's source line, not media, so the slide is the quote-only slide it would be with `- https://…`
  // (the same reading slide-quote-reading.mjs inferSlideLayout makes for the app's check before a quote write).
  const blocks = adoptAddressUnderQuote(lex(s.lines), s.lines, s.attrs);
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

// The slide's layout before its cards are looked at, as flushSlide decides it: the inferred layout,
// replaced by `section-title` when the divider default applies, then by `chart` when every block
// is a chart object. `rawBlocks` are the lexer's blocks of the slide's lines.
export function slideLayoutPlan(slide, lex) {
  const authoredLayout = inferSlideLayout(slide, lex);
  const dividerDecision = sectionDividerDecision(slide, slide.authoredAttrKeys, authoredLayout);
  let layout = dividerDecision.divider ? "section-title" : authoredLayout;
  const rawBlocks = lex(slide.lines);
  // Quote forms, ticket 10: the address under the one quotation of a quote slide whose form is set is adopted as
  // its source line, the same reading inferSlideLayout made (slide-quote-reading.mjs readSlideBlocks does the same).
  if (layout === "quote") adoptAddressUnderQuote(rawBlocks, slide.lines, slide.attrs);
  const chartOnly = isChartOnlySlide(rawBlocks);
  if (chartOnly) layout = "chart";
  return { authoredLayout, dividerDecision, rawBlocks, chartOnly, layout };
}

// The card treatment a slide gets and the layout it is then drawn in. `layout` is slideLayoutPlan's,
// `cardCount` the number of child headings folded into the slide (0: none). `kind` null: no card
// treatment, the layout stands. Moved from flushSlide, conditions and order unchanged.
export function cardsLayoutDecision({ layout, attrs, cardCount }) {
  const fromHashCards = cardCount > 0;
  const wantCarouselTrigger = attrs.carousel === true;
  const isCompare = layout === "compare" && fromHashCards && cardCount >= 2;
  const isImageGridHash = fromHashCards && layout === "image-grid";
  const isStaticCompare = fromHashCards && layout === "contrast" && cardCount >= 2 && cardCount <= 3;
  const isCardsGridForced = attrs.cards === "grid" || attrs.cards === "rows";
  // A #### carousel only when the slide's layout is the cards DEFAULT (bare #### or {cards}). An
  // explicit non-cards layout ({columns}, {smartart}, …) uses #### for ITS OWN structure.
  const hashCarousel = fromHashCards && layout === "cards" && !isCardsGridForced;
  // {cards=stepped} over a FLAT list is the legacy "step these cards" intent: a carousel too.
  const flatStepped = !fromHashCards && layout === "cards" && attrs.cards === "stepped";
  // STATIC cards GRID (ADR-0021): an adaptive flat-list {cards} (no ####, not stepped) OR
  // {cards=grid} on #### cards.
  const flatStaticCards = !fromHashCards && layout === "cards" && attrs.cards !== "stepped";
  const hashStaticCards = fromHashCards && isCardsGridForced;
  if (isCompare) return { kind: "compare", layout: "compare" };
  if (isImageGridHash) return { kind: "image-grid", layout };
  if (isStaticCompare) return { kind: "static-compare", layout: "contrast" };
  if (hashCarousel || wantCarouselTrigger || flatStepped) return { kind: "carousel", layout: "carousel" };
  // An adaptive flat-list {cards} with no list to make cards of keeps its layout, which is "cards".
  if (hashStaticCards || flatStaticCards) return { kind: "static-cards", layout: "cards" };
  return { kind: null, layout };
}

// The list styles a slide's lists can be drawn in ({liststyle=…} and its bare words).
export const LIST_STYLES = new Set(["numbers", "icons", "logos", "plain"]);

// The slide's `liststyle` once the value forms are read: {iconlist=…}, then {numbered=…}, is
// still an icon / a numbered list when the author wrote no list style; a written one wins.
export function impliedListStyle(attrs) {
  const unset = attrs.liststyle == null || attrs.liststyle === true;
  if (unset && attrs.iconlist != null) return "icons";
  if (unset && attrs.numbered != null) return "numbers";
  return attrs.liststyle;
}

// The layout of the compiled slide, with what decided it:
//   layout      the compiled slide's `layout`;
//   divider     the divider default applied (the heading is kept as a section divider);
//   chartOnly   every block is a chart object;
//   cardsKind   the card treatment (cardsLayoutDecision), or null;
//   listStyle   the style stamped on the slide's lists ("" when none, or an unknown one);
//   hasList     the slide's content holds a list (for the `list` layout: the list that is drawn).
export function finalSlideLayout(slide, lex) {
  const plan = slideLayoutPlan(slide, lex);
  const cards = cardsLayoutDecision({ layout: plan.layout, attrs: slide.attrs, cardCount: (slide.cards || []).length });
  const style = impliedListStyle(slide.attrs);
  return {
    layout: cards.layout,
    divider: plan.dividerDecision.divider,
    chartOnly: plan.chartOnly,
    cardsKind: cards.kind,
    listStyle: typeof style === "string" && LIST_STYLES.has(style) ? style : "",
    hasList: plan.rawBlocks.some((block) => block?.type === "list")
  };
}

// A node's content lines with its stray Trigger lines taken out and folded into `attrs` (mutated).
// `authoredKeys`, when supplied, collects every attribute key this node set ITSELF via a stray
// trigger line: the caller seeds it with the heading's own trigger group. It is how the divider
// decision tells an author's token from a deck-wide `triggers:` default (both land in `attrs`).
// `warnings`, when supplied, takes the stray lines' warnings.
export function nodeContentLinesAndAttrs(node, attrs, { warnings = null, authoredKeys = null } = {}) {
  const linesOut = [];
  // classifyContentLines (14-outline-tree.mjs) is the one reading of which lines are content.
  for (const { line, stray } of classifyContentLines(node.contentLines || [])) {
    if (stray) {
      if (warnings) {
        for (const w of stray.warnings || []) warnings.push(w);
      }
      Object.assign(attrs, stray.attrs);
      if (authoredKeys) for (const key of Object.keys(stray.attrs || {})) authoredKeys.add(key);
    } else {
      linesOut.push(line);
    }
  }
  return linesOut;
}

// What a slide is made of, for a tree node AFTER foldChildLayoutNodes, as emitNodeSlides builds it:
// the deck defaults under the node's attrs under its stray Trigger lines, the content lines, the
// folded cards, and whether child headings are left under it. The poll and quick-check passes that
// flushSlide runs on the lines before it reads the layout are run here the same way (`lex` reads
// the poll's options).
export function slideLayoutInput(node, deckTriggerDefaults, lex) {
  const attrs = { ...deckTriggerDefaults, ...(node.attrs || {}) };
  const authoredKeys = new Set(Object.keys(node.attrs || {}));
  let lines = nodeContentLinesAndAttrs(node, attrs, { authoredKeys });
  const cards = Array.isArray(node._foldedCards)
    ? node._foldedCards
    : Array.isArray(node._compareHalves) ? node._compareHalves : [];
  const slide = { id: node.id, title: node.title, attrs, lines, cards, isSection: (node.children || []).length > 0, authoredAttrKeys: [...authoredKeys], treeNode: node };
  if (attrs.check === true) slide.lines = lines = takeRightMarkers(lines).lines;
  const authored = pollDirectivesFor(lines);
  // Without a directive line the poll pass leaves the lines as they are, whatever it decides.
  if (authored.directives.length && pollDefinitionFor(slide, lex(authored.contentLines), attrs.id || node.id, authored, [])) {
    slide.lines = authored.contentLines;
  }
  return slide;
}

// Whether a heading takes its child headings: its attrs as the fold reads them. Deliberately scans
// raw contentLines, including trigger-shaped text in code fences: this is the established
// container-fold contract, distinct from the fence-aware content lexer.
export function resolvedNodeAttrs(node, deckTriggerDefaults) {
  const attrs = { ...deckTriggerDefaults, ...(node.attrs || {}) };
  const contentLines = node.contentLines || [];
  const chartBlockLines = new Set();
  let inFence = false;
  let fenceMark = "";
  for (let index = 0; index < contentLines.length; index += 1) {
    const t = String(contentLines[index]).trim();
    if (inFence) {
      const close = t.match(/^(`{3,})\s*$/);
      if (close && close[1].length >= fenceMark.length) { inFence = false; fenceMark = ""; }
      continue;
    }
    const open = t.match(/^(`{3,})/);
    if (open) { inFence = true; fenceMark = open[1]; continue; }
    if (chartObjectTokenAt(contentLines, index)) chartBlockLines.add(index);
  }
  for (let index = 0; index < contentLines.length; index += 1) {
    const line = contentLines[index];
    if (chartBlockLines.has(index)) continue;
    const stray = parseTriggerLine(line);
    if (stray) Object.assign(attrs, stray.attrs);
  }
  return attrs;
}

// Folds every heading that takes its child headings into its own slide (childFoldKind), in place:
// the node gets `_foldedCards` / `_compareHalves` / longer `contentLines`, the children's notes, and
// no children. Moved from 08-source-adapters.mjs; the editor runs it on a copy of the tree to know
// which headings are slides and what each slide holds. `warnings` is pushed to;
// `nodeSourceEndLines` maps a node to the last source line of its own block.
export function foldChildLayoutNodes(rootNodes, { deckTriggerDefaults = {}, warnings = [], nodeSourceEndLines = new Map() } = {}) {

  // Which nodes take their child headings (compare, columns, carousel, the static card containers)
  // is decided by childFoldKind (authored-layout.mjs) over these attrs.
  // A fold keeps each child's visible lines; it must keep the rest of what the child authored
  // too (notes-in-folded-layouts, 2026-09-28). Before this, a folded child's `:::notes` reached
  // no output, not even the presenter, and the slide's source slice (the phone text view's input,
  // slide-script.mjs) stopped at the first child. absorbFoldedChildren runs on every fold path:
  //   - notes: each consumed child's notes (and any deeper unfolded descendant's) are appended to
  //     the parent's notesLines in source order, each group led by a bold paragraph naming its
  //     child (`**Child title**`, plain Markdown the notes renderer already draws). A child with
  //     no notes adds nothing. The parent's own notes come first, as they do in the source.
  //   - source ranges: `_scriptSourceRanges` lists the source line ranges of what the slide DRAWS
  //     -- the parent's own block, then each rendered child's content ranges (`visibleCount`:
  //     compare renders only its first two groups) -- read by buildFoldedScriptSourceLines so the
  //     phone text view and the Links slide show exactly the children the slide shows. A child's
  //     content is its own block only (heading to its first descendant): a fold draws a child's
  //     contentLines, so a `#####` under it is not drawn, nor are the children of a fold container
  //     nested in it (cards, compare and the rest keep those apart as `_foldedCards` /
  //     `_compareHalves`). {columns} is the exception: it merges its children into its own
  //     contentLines, so a columns node's content ranges include its drawn children's.
  const hasText = (lines) => (lines || []).some((line) => String(line).trim());
  const trimBlankEdges = (lines) => {
    let start = 0;
    let end = lines.length;
    while (start < end && !String(lines[start]).trim()) start += 1;
    while (end > start && !String(lines[end - 1]).trim()) end -= 1;
    return lines.slice(start, end);
  };
  // The source line ranges ([first, last], 1-based, inclusive) that hold a node's contentLines.
  const contentSourceRanges = (node) => {
    if (Array.isArray(node._contentSourceRanges)) return node._contentSourceRanges;
    if (!node.sourceLine) return [];
    return [[node.sourceLine, nodeSourceEndLines.get(node) || node.sourceLine]];
  };
  const absorbFoldedChildren = (node, children, visibleCount = children.length) => {
    const notes = [...(node.notesLines || [])];
    const visit = (child) => {
      if (hasText(child.notesLines)) {
        if (hasText(notes)) notes.push("");
        notes.push(`**${child.title}**`, "", ...trimBlankEdges(child.notesLines));
      }
      for (const grandchild of child.children || []) visit(grandchild);
    };
    for (const child of children) visit(child);
    node.notesLines = notes;
    if (node.sourceLine) {
      node._scriptSourceRanges = [
        ...contentSourceRanges(node),
        ...children.slice(0, visibleCount).flatMap(contentSourceRanges)
      ];
    }
  };
  const foldChildrenToCards = (node, children) => {
    node._foldedCards = children.map((child) => {
      const childAttrs = { ...deckTriggerDefaults, ...(child.attrs || {}) };
      const childLines = nodeContentLinesAndAttrs(child, childAttrs);
      return { title: child.title, lines: childLines };
    });
    absorbFoldedChildren(node, children);
    node.children = [];
  };
  const fold = (nodes) => {
    for (const node of nodes || []) {
      fold(node.children || []);
      const children = node.children || [];
      // Whether and how this node takes its child headings into its own slide: the ONE decision
      // (authored-layout.mjs childFoldKind), which the editor asks too.
      const kind = childFoldKind(resolvedNodeAttrs(node, deckTriggerDefaults), children.length);
      if (kind === "carousel") {
        // Preserve the leaf identities for sequencing before folding their content into the
        // parent's single DOM slide. The sequencer attaches carousel index/count context.
        node._sequenceCarouselChildren = children.map((child) => ({
          id: child.id,
          title: child.title,
          attrs: { ...(child.attrs || {}) },
          children: []
        }));
        foldChildrenToCards(node, children);
        continue;
      }
      // ADR-0021 static containers absorb #### groups into one all-visible slide. Carousel stays
      // first so a node carrying both {carousel} and {cards=grid} keeps its established behaviour.
      const attrs = resolvedNodeAttrs(node, deckTriggerDefaults);
      const contrast = attrs.layout === "contrast";
      if (kind === "cards") {
        foldChildrenToCards(node, children);
        continue;
      }
      // The static compare renderer accepts only 2–3 groups; folding any other non-empty count
      // would consume child slides without a renderable representation.
      if (contrast && children.length && (children.length === 1 || children.length >= 4)) {
        warnings.push(`contrast-groups-count:${node.id}`);
      }
      if (kind === "columns") {
        for (const child of children) {
          const childAttrs = { ...deckTriggerDefaults, ...(child.attrs || {}) };
          const childLines = nodeContentLinesAndAttrs(child, childAttrs);
          node.contentLines = [...(node.contentLines || []), "", `#### ${child.title}`, "", ...childLines];
        }
        absorbFoldedChildren(node, children);
        // The children are now part of this node's contentLines: a parent that folds this node
        // draws them too, so its script source takes them with this node's own block.
        if (node._scriptSourceRanges) node._contentSourceRanges = node._scriptSourceRanges;
        node.children = [];
        continue;
      }
      if (kind === "compare") {
        node._compareHalves = children.slice(0, 2).map((child) => {
          const childAttrs = { ...deckTriggerDefaults, ...(child.attrs || {}) };
          const childLines = nodeContentLinesAndAttrs(child, childAttrs);
          return { title: child.title, lines: childLines };
        });
        if (children.length > 2) warnings.push(`compare-extra-groups:${node.title}`);
        // Extra groups are not drawn (warned above), but their notes are the author's and still
        // reach the presenter; the phone shows only the two drawn halves.
        absorbFoldedChildren(node, children, 2);
        node.children = [];
      }
    }
  };
  fold(rootNodes);
}
