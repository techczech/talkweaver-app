// =============================================================================
// slot-composition.mjs — THE media slot (ADR-0023 §3, Dominik's pick B2)
//
// "Text with media = always beside, stacked."
//
// Before this module, a slide that mixed copy with media was composed at FIVE sites inside
// 07-assembly (cardsMediaSplit, listVisual, copyVisual, timelineVisual, mediaSplit), each with
// its own trigger, its own wrapper grammar and its own stylesheet block. Identical authored
// content therefore landed in different regimes depending on which branch happened to fire first.
//
// There is now ONE decision (slotCompositionFor) and ONE grammar (renderSlotComposition):
//
//   <div class="slot" data-slot-side="left|right" data-slot-media-count="N">
//     <div class="slot-copy">…every non-media block…</div>
//     <div class="slot-media">…every media block, one per row, equal heights…</div>
//   </div>
//
// Copy is always FIRST in the DOM (reading and tab order follow the prose); the side attribute
// decides which grid column the media column occupies, so `{image=left}` / `{image=right}` is a
// pure presentation flip. Geometry, type floor and both-axis centring live in ONE stylesheet
// block (compiler/assets/styles/layouts/media.css, `.slot`) — no layout owns slot geometry.
//
// WHAT COUNTS AS "a slide that mixes copy with media" is deliberately the UNION of the five old
// triggers, not a wider net (ADR-0023 §3: "their triggers survive as aliases"). Widening
// eligibility to every layout would recompose slides the ADR did not ask about; that is a
// separate decision with its own corpus gate.
// =============================================================================

// The block types that occupy a media slot. Objects (mermaid/svg/table) join this set when
// ADR-0019 Scope C's object work lands — the seam is `isSlotMedia` and nothing else.
export const SLOT_MEDIA_BLOCK_TYPES = new Set(["image", "embed", "video"]);

// Layouts whose inference ALREADY means "media beside copy" (08-source-adapters inferLayout).
// They stay registry entries and resolve here to the one `beside` composition.
const BESIDE_LAYOUTS = new Set(["list-visual", "copy-visual", "media", "timeline-visual"]);

// A QR is pinned chrome, not copy: 07-assembly lifts a `.slide-qr-corner` figure OUT of the body
// after rendering, so a QR alone can never make a slide "copy beside media" (it would leave an
// empty copy column). It still travels inside the copy column when the slide qualifies on real
// copy, exactly as it did in the old cv-copy / lv-list columns.
const SLOT_CHROME_BLOCK_TYPES = new Set(["qr"]);

// On `timeline-visual` the TIMELINE is the graphical block that occupies the slot (Fix 1: a
// timeline beside a comment). Everywhere else a timeline is ordinary full-band structure, so the
// test is layout-scoped rather than a second global media set.
function isSlotMedia(block, layoutSlug) {
  if (!block || typeof block !== "object") return false;
  if (SLOT_MEDIA_BLOCK_TYPES.has(block.type)) return true;
  return block.type === "timeline" && layoutSlug === "timeline-visual";
}

const NO_SLOT = Object.freeze({ kind: "none", side: "left", align: "center", media: [], copy: [] });

/**
 * The ONE composition decision for a slide body.
 *
 * @param {object} slide        the slide record (frame, frameImageExplicit, html)
 * @param {Array}  bodyBlocks   the blocks about to be rendered as the slide body
 * @param {string} layoutSlug   the resolved layout slug
 * @returns {{ kind: 'none'|'beside', side: 'left'|'right', align: 'center'|'top',
 *            media: object[], copy: object[] }}
 *
 * `kind: 'none'` means "render the body exactly as it renders today" — copy-only and media-only
 * slides are untouched, and so is every slide outside the alias set.
 */
export function slotCompositionFor(slide, bodyBlocks, layoutSlug) {
  if (!slide || typeof slide !== "object") return NO_SLOT;
  if (slide.html) return NO_SLOT; // an HTML body is opaque; never recomposed
  if (!Array.isArray(bodyBlocks)) return NO_SLOT;
  const blocks = bodyBlocks.filter(Boolean);
  if (!blocks.length) return NO_SLOT;

  const media = blocks.filter((block) => isSlotMedia(block, layoutSlug));
  const copy = blocks.filter((block) => !isSlotMedia(block, layoutSlug));
  // Copy-only and media-only slides are NOT a mix: they render unchanged.
  if (!media.length) return NO_SLOT;
  if (!copy.some((block) => !SLOT_CHROME_BLOCK_TYPES.has(block.type))) return NO_SLOT;

  // The alias set: the five old triggers, unified.
  //   • the inferred visual layouts (list-visual / copy-visual / media / timeline-visual)
  //   • a cards gallery carrying leading media (the old cardsMediaSplit)
  //   • an authored {image=left|right} on ANY layout (the old mediaSplit)
  const eligible =
    BESIDE_LAYOUTS.has(layoutSlug)
    || (layoutSlug === "cards" && copy.some((block) => block.type === "cards"))
    || slide.frameImageExplicit === true;
  if (!eligible) return NO_SLOT;

  // An explicit {cols=N} / {2col} / {3col} is ITSELF an authored composition (ADR-0023 §1:
  // structure never overrides an author token), so it keeps the columns grid — unless the slot
  // was authored too ({image=left|right}), which is the precedence 07-assembly had before this
  // module existed (the old mediaSplit branch ran ahead of the columns branch; the other four
  // ran after it).
  const colsExplicit = slide.colsCount != null && String(slide.colsCount).trim() !== "";
  if (colsExplicit && slide.frameImageExplicit !== true) return NO_SLOT;

  // Side: the media-placement option group ({image=left|right} → frame.image). frame.image
  // resolves to the builtin "left" when unset, which is the side the old mediaSplit defaulted to.
  const side = slide.frame?.image === "right" ? "right" : "left";
  // Both columns centre in the content band (ADR-0005 both-axis balance). {align=top} is the one
  // authored escape hatch and survives from the old .split.align-top.
  const align = slide.frame?.align === "top" ? "top" : "center";
  return { kind: "beside", side, align, media, copy };
}

// 5+ media blocks stacked as 5+ rows leaves each one a letterbox strip, so the media column
// switches to a 2-column grid at that point (2 → two rows, 3 → three rows, 4 → four rows,
// 5+ → a 2-column grid). The decision is made here, once, and stamped for the stylesheet.
const MEDIA_GRID_THRESHOLD = 5;

/**
 * Render a composition as the one wrapper grammar.
 *
 * @param {object}   comp         the result of slotCompositionFor
 * @param {Function} renderBlock  (block, deckUsed, frameIcons) => html — the block renderer
 * @param {object}   ctx          { deckUsed, frameIcons, renderBlocks }
 * @returns {string} the `.slot` wrapper html, or "" when comp.kind is not "beside"
 *
 * Media blocks are rendered ONE PER ROW — never grouped into an .img-row / .figure-row, which is
 * what made two images on a copy-visual slide sit side by side inside the media column instead of
 * stacking (ADR-0023 §3: "every media block in the other column stacked at equal heights").
 */
export function renderSlotComposition(comp, renderBlock, ctx = {}) {
  if (!comp || comp.kind !== "beside") return "";
  const { deckUsed = null, frameIcons = "off", renderBlocks } = ctx;
  const copyInner = typeof renderBlocks === "function"
    ? renderBlocks(comp.copy, "", deckUsed, frameIcons)
    : comp.copy.map((block) => renderBlock(block, deckUsed, frameIcons)).filter(Boolean).join("\n");
  const mediaInner = comp.media
    .map((block) => renderBlock(block, deckUsed, frameIcons))
    .filter(Boolean)
    .join("\n");
  const attrs = [
    `class="slot"`,
    `data-slot-side="${comp.side}"`,
    `data-slot-media-count="${comp.media.length}"`
  ];
  if (comp.media.length >= MEDIA_GRID_THRESHOLD) attrs.push(`data-slot-media-grid="2col"`);
  if (comp.align === "top") attrs.push(`data-slot-align="top"`);
  return `<div ${attrs.join(" ")}><div class="slot-copy">${copyInner}</div><div class="slot-media">${mediaInner}</div></div>`;
}
