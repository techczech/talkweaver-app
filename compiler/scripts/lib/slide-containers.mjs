// =============================================================================
// Where a slide's content ends up when it is not drawn as the slide's own blocks: the decisions 08-source-adapters.mjs
// takes before and after it reads a slide, kept here with no file or Node access so the app's check before a quote
// write (src/shared/quote-write-check.ts, through slide-quote-reading.mjs) takes the same ones.
//
//   nodeContainerAttrs      the attributes the fold decision reads off a heading (foldChildLayoutNodes)
//   childFoldOfNode         does this heading take its child headings into its own slide, and how
//   slideContainerKind      does flushSlide rebuild the slide's blocks as a container (compare, image grid, contrast,
//                           carousel, cards), whatever layout the slide was read as
//   checkContentLines       a quick check's lines without their `{right}` markers
//
// Every function is a decision only: the compiler does the folding and the rebuilding itself.
// =============================================================================
import { parseTriggerLine } from "./02-triggers-layout.mjs";
import { chartObjectTokenAt } from "./03-object-token.mjs";
import { takeRightMarkers } from "./prework.mjs";

/**
 * A heading's attributes as the fold decision reads them: the deck's defaults, the heading and its Trigger line, then
 * every Trigger-shaped line of its content. Deliberately scans raw contentLines, including trigger-shaped text in
 * code fences: this is the established container-fold contract, distinct from the fence-aware content lexer
 * (slide-attrs.mjs `foldContentTriggerLines`, which a slide's own attributes are read with).
 */
export function nodeContainerAttrs(node, deckTriggerDefaults) {
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

/**
 * How a heading takes its child headings into its own slide (foldChildLayoutNodes), '' when it does not:
 *   "carousel"  {carousel} with any child: each child is a sub-slide;
 *   "cards"     {cards=grid|rows} or {image-grid} with any child, {contrast} with two or three: the children are cards;
 *   "columns"   {columns} / {cols=N} with two or more: the children join the heading's own content lines;
 *   "compare"   {compare} with two or more: the first two are the halves.
 * A folded child is not a slide of its own, and nor is anything under it. Carousel stays first so a node carrying both
 * {carousel} and {cards=grid} keeps its established behaviour.
 */
export function childFoldOfNode(node, deckTriggerDefaults) {
  const count = (node.children || []).length;
  if (!count) return "";
  const attrs = nodeContainerAttrs(node, deckTriggerDefaults);
  if (attrs.carousel === true) return "carousel";
  const staticCards = attrs.cards === "grid" || attrs.cards === "rows";
  const imageGrid = attrs.layout === "image-grid";
  const contrast = attrs.layout === "contrast";
  if (staticCards || imageGrid || (contrast && count >= 2 && count <= 3)) return "cards";
  if ((attrs.layout === "columns" || (attrs.cols != null && attrs.cols !== true)) && count >= 2) return "columns";
  if (attrs.layout === "compare" && count >= 2) return "compare";
  return "";
}

/**
 * The container flushSlide rebuilds a slide's blocks as, '' when the slide keeps the blocks it was read with.
 * `layout` is the layout the slide was read as, `attrs` its attributes in effect, `cardCount` how many child headings
 * were folded into it as cards (childFoldOfNode). In flushSlide's own order:
 *   "compare"     {compare} over two or more folded groups: two halves;
 *   "image-grid"  {image-grid} over folded groups: the groups are the grid's cells;
 *   "contrast"    {contrast} over two or three folded groups: a static side-by-side comparison;
 *   "carousel"    folded groups on a cards-layout slide (unless {cards=grid|rows}), {carousel} on ANY layout, or
 *                 {cards=stepped} over a flat list: every group or top-level block is a sub-slide, and the slide's
 *                 layout is `carousel`;
 *   "cards"       {cards=grid|rows} over folded groups on any layout, or a cards-layout slide over a flat list: a
 *                 static grid (the slide's layout is `cards` when there is a group or a list to show).
 */
export function slideContainerKind(layout, attrs, cardCount) {
  const fromHashCards = cardCount > 0;
  if (layout === "compare" && fromHashCards && cardCount >= 2) return "compare";
  if (fromHashCards && layout === "image-grid") return "image-grid";
  if (fromHashCards && layout === "contrast" && cardCount >= 2 && cardCount <= 3) return "contrast";
  const cardsGridForced = attrs.cards === "grid" || attrs.cards === "rows";
  // A #### carousel only when the slide's layout is the cards DEFAULT (bare #### or {cards}). An explicit non-cards
  // layout ({columns}, {smartart}, …) uses #### for ITS OWN structure, not a carousel.
  const hashCarousel = fromHashCards && layout === "cards" && !cardsGridForced;
  // {cards=stepped} over a FLAT list is the legacy "step these cards" intent: a carousel too.
  const flatStepped = !fromHashCards && layout === "cards" && attrs.cards === "stepped";
  if (hashCarousel || attrs.carousel === true || flatStepped) return "carousel";
  // STATIC cards GRID (ADR-0021): an adaptive flat-list {cards} (no ####, not stepped) OR {cards=grid} on #### cards.
  if ((fromHashCards && cardsGridForced) || (!fromHashCards && layout === "cards" && attrs.cards !== "stepped")) return "cards";
  return "";
}

/**
 * A quick check's content lines as the slide is read: ticket 08 (ADR-0032 amendment point 5), a quick check's right
 * option ends with `{right}`, and the marker leaves the slide's content before anything else reads it. Any other
 * slide's lines are returned as they are.
 */
export function checkContentLines(attrs, lines) {
  return attrs.check === true ? takeRightMarkers(lines).lines : lines;
}
