// =============================================================================
// image-placement.mjs — where each image of a compiled slide lands on the slide
//
// The editor labels every image preview with its placement ("Full screen", "Beside text", ...).
// That label must be the COMPILER'S decision, not a second guess made from triggers in the
// renderer, so it is derived here from the same inputs assembly uses: the resolved layout and
// slotCompositionFor (the one media-slot decision, ADR-0023 §3).
//
// imagePlacementsForSlide(slide) → one entry per image, in outline order (the order the image
// lines appear under the slide's heading):
//   { kind, index, count }
// kind: "full" | "beside" | "thumbnail" | "row" | "gallery" | "image-quote" | "statement" | "carousel"
// index/count: this image's 1-based position among the `count` images of its row / gallery / carousel
// (1 of 1 for a lone image). A layout that puts an image somewhere this module has no name for
// yields no entry kind ("other") rather than a guess.
// =============================================================================
import { slotCompositionFor } from "./slot-composition.mjs";
export { audienceImageLineNumbers } from "./image-line-rules.mjs";

const isImage = (block) => block && block.type === "image";

function collectImages(blocks, out = []) {
  for (const block of blocks || []) {
    if (!block || typeof block !== "object") continue;
    if (isImage(block)) out.push(block);
    else if (block.type === "image-row") out.push(...(block.images || []).filter(isImage));
    else if (block.type === "image-quote") { if (isImage(block.image)) out.push(block.image); }
    else if (block.type === "image-grid") for (const cell of block.cells || []) collectImages(cell.blocks, out);
  }
  return out;
}

export function imagePlacementsForSlide(slide) {
  if (!slide || typeof slide !== "object") return [];
  const layout = String(slide.layout || "");
  const blocks = Array.isArray(slide.blocks) ? slide.blocks : [];

  if (layout === "carousel") {
    const images = (Array.isArray(slide.carousel) ? slide.carousel : []).flatMap((sub) => collectImages(sub.blocks));
    return images.map((_, i) => ({ kind: "carousel", index: i + 1, count: images.length }));
  }

  let images = collectImages(blocks);
  const quotePair = blocks.find((b) => b?.type === "image-quote");
  if (quotePair && isImage(quotePair.image)) images = [quotePair.image, ...images.filter((b) => b !== quotePair.image)];
  if (!images.length) return [];
  const count = images.length;
  const each = (kind) => images.map((_, i) => ({ kind, index: i + 1, count }));

  // {image-quote}: only the FIRST image is paired with the quote (mapBlocksToLayout); the rest
  // render as ordinary figures, placed ahead of the pair in block order but after it in the
  // outline. Outline order = the paired image, then the others.
  const pair = blocks.find((b) => b?.type === "image-quote");
  if (pair) {
    const others = images.length - 1;
    const otherKind = others >= 2 ? "row" : "other";
    return images.map((_, i) => (i === 0
      ? { kind: "image-quote", index: 1, count: 1 }
      : { kind: otherKind, index: i, count: others }));
  }
  if (blocks.some((b) => b?.type === "image-grid")) return each("gallery");

  const slot = slotCompositionFor(slide, blocks, layout);
  if (slot.kind === "beside") {
    const mediaCount = slot.media.filter(isImage).length;
    const kind = slot.arrange === "beside" ? "thumbnail" : slot.arrange === "stacked" ? "row" : "beside";
    return images.map((_, i) => ({ kind, index: i + 1, count: kind === "beside" ? mediaCount : count }));
  }
  if (layout === "statement") return each("statement");
  if (layout === "media") return each(count === 1 ? "full" : count <= 3 ? "row" : "gallery");
  return each("other");
}
