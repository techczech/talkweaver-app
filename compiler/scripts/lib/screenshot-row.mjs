// =============================================================================
// screenshot-row.mjs — a row of screenshots stays ONE row (ADR-0033 §4)
//
// Three images on an {image-grid} or a media-only figure row never pack 2+1. They sit in
// one row in one of two treatments:
//   frames  (default) — each image inside a light app window (26px title bar with three dots),
//                       cropped from its top-left at a zoom instead of shrunk to fit.
//   fanned            — prints with a white border, turned about -4.5 / +1.2 / +4.2 degrees,
//                       overlapping, captions upright beneath.
//
// The sizes are arithmetic, not per-slide constants. The stage is a fixed 1280x720 canvas, so the
// compiler knows the band the row sits in (from the title regime and the title's estimated line
// count) and each image's aspect ratio (from its pixel size). `planScreenshotRow` turns those
// into numbers stamped on the row as custom properties:
//   frames: --sr-fh (frame height, bar included) and --sr-z (zoom of the picture inside it)
//   fanned: --sr-ph (print height) and --sr-ov (overlap, a negative margin)
// The stylesheet (layouts/media.css, "SCREENSHOT ROW") only draws them.
//
// Two-step flow, because the title placement is decided after the body is rendered:
//   1. the block renderers emit the row with `data-shot-row` + `data-shot-aspects` (+ captions);
//   2. 07-assembly calls `sizeScreenshotRows(html, band)` once the title placement is known.
// =============================================================================

/** The two treatments. `frames` is the default. */
export const SCREENSHOT_STYLES = ["frames", "fanned"];

/** Slide token `{screenshots=frames|fanned}` → deck `screenshot_style:` → frames. */
export function resolveScreenshotStyle(attrs, meta) {
  const token = String(attrs?.screenshots ?? "").trim().toLowerCase();
  if (SCREENSHOT_STYLES.includes(token)) return token;
  const deck = String(meta?.screenshot_style ?? meta?.["screenshot-style"] ?? "").trim().toLowerCase();
  if (SCREENSHOT_STYLES.includes(deck)) return deck;
  return "frames";
}

// ── Stage geometry, canvas px (the stage is 1280x720; the 1920 render is 1.5x) ─────────────────
const STAGE_W = 1280;
const PAD_X = 71.7;                 // the content box's inset (--slide-pad-x, 5.6cqw)
const CONTENT_H = 648;              // stage height less the 5cqh padding above and below
const RAIL_GAP = 64;                // gap between a left title rail and the body column
const RAIL_MIN = { 30: 240, 35: 280, 40: 300, 50: 340 };
// The compact top title (ADR-0033 §2, ticket 01): 75px at 1920 = 3.9cqw = 49.9px on the stage;
// above it 4cqh (28.8), to the rule 1.1cqh (7.9) + 2px rule, under the rule 2.2cqh (15.8).
// Line height and glyph width keep the ratios of the retired 5.2cqw title (1.12em, 0.5em).
const TOP_TITLE = { above: 28.8, lineHeight: 55.9, charWidth: 25, below: 25.7 };
const BREATHING = 16;               // air kept above and below the row inside the band
const CAPTION_H = 52;               // one caption line under a frame or print, padding included
const BAR_H = 26;                   // the window title bar
const GAP = 26;                     // gap between frames
const PRINT_BORDER = 9;

// ── Rules (named numbers, so the look can be tuned in one place) ────────────────────────────────
const FRAME_ASPECT_MIN = 0.6;       // a frame is never flatter than 0.6 of its width (wide charts)
const FRAME_ASPECT_MAX = 1.0;       // nor taller than square (portrait pages are cropped)
const ZOOM_MIN = 1.25;              // the picture is drawn at least this much wider than the frame
const ZOOM_MAX = 2;
const FAN_OVERLAP_PREFERRED = 0.06; // of the mean print width
const FAN_OVERLAP_MAX = 0.18;
const FAN_FILL = 0.97;              // the fan uses at most this share of the band width
const FAN_TILT_ALLOWANCE = 0.08;    // vertical growth of a print turned 4.5 degrees, of its width

const round1 = (n) => Math.round(n * 10) / 10;

/** The area the row sits in, canvas px. `titleMode` is the compiled data-title-layout. */
export function screenshotBand({ titleMode = "top", split = "35", title = "", titleShown = true } = {}) {
  if (titleMode === "left") {
    const key = String(split) in RAIL_MIN ? String(split) : "35";
    const rail = Math.max(RAIL_MIN[key], (Number(key) / 100) * STAGE_W);
    return { w: round1(STAGE_W - PAD_X - (rail + RAIL_GAP)), h: CONTENT_H };
  }
  const w = round1(STAGE_W - 2 * PAD_X);
  if (titleMode === "hidden" || !titleShown) return { w, h: CONTENT_H };
  const perLine = Math.max(8, Math.floor(w / TOP_TITLE.charWidth));
  const lines = Math.max(1, Math.ceil(String(title).length / perLine));
  return { w, h: round1(CONTENT_H - (TOP_TITLE.above + lines * TOP_TITLE.lineHeight + TOP_TITLE.below)) };
}

/**
 * The numbers for one row.
 *   aspects:  width/height of each image (2 or 3)
 *   captions: whether captions sit under the frames or prints
 *   band:     { w, h } canvas px
 */
export function planScreenshotRow({ style = "frames", aspects, captions = false, band }) {
  const n = aspects.length;
  const avail = Math.max(120, band.h - 2 * BREATHING - (captions ? CAPTION_H : 0));
  if (style === "fanned") return planFan(aspects, avail, band.w);
  const meanAspect = aspects.reduce((a, b) => a + b, 0) / n;
  const frameW = (band.w - (n - 1) * GAP) / n;
  const wanted = Math.min(FRAME_ASPECT_MAX * frameW, Math.max(FRAME_ASPECT_MIN * frameW, frameW / meanAspect));
  const contentH = Math.min(avail - BAR_H, wanted);
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (contentH * meanAspect) / frameW));
  return { style: "frames", fh: round1(contentH + BAR_H), z: Math.round(zoom * 100) / 100 };
}

function planFan(aspects, avail, bandW) {
  const n = aspects.length;
  const sum = aspects.reduce((a, b) => a + b, 0);
  const borders = 2 * PRINT_BORDER;
  // Height first: as tall as the band allows once the turns and borders are taken out.
  let ph = (avail - borders - 12) / (1 + FAN_TILT_ALLOWANCE * Math.max(...aspects));
  const totalWidth = (h) => sum * h + n * borders;
  const budget = FAN_FILL * bandW;
  let overlap = FAN_OVERLAP_PREFERRED * (totalWidth(ph) / n);
  const needed = (totalWidth(ph) - budget) / (n - 1);
  if (needed > overlap) overlap = needed;
  if (overlap > FAN_OVERLAP_MAX * (totalWidth(ph) / n)) {
    // The overlap is at its limit: shrink the prints until the whole fan fits the band.
    // Fan width = total * (1 - (n-1)*max/n) = budget.
    const k = 1 - ((n - 1) * FAN_OVERLAP_MAX) / n;
    ph = (budget / k - n * borders) / sum;
    overlap = FAN_OVERLAP_MAX * (totalWidth(ph) / n);
  }
  return { style: "fanned", ph: round1(ph), ov: round1(-overlap) };
}

/**
 * Mark the blocks a slide's screenshot treatment applies to: image-grid blocks and images (the
 * media-only figure row is built later from consecutive images and reads the mark from them).
 */
export function withScreenshotStyle(blocks, style) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (block && typeof block === "object" && (block.type === "image-grid" || block.type === "image")) {
      return { ...block, shotStyle: style };
    }
    return block;
  });
}

/** Aspect ratio (w/h) of an image block; 4:3 when its pixel size is unknown. */
export function imageAspect(block) {
  const w = Number(block?.width), h = Number(block?.height);
  return w > 0 && h > 0 ? w / h : 4 / 3;
}

/**
 * Whether a row of `count` images takes the treatment. Exactly three, as drawn: two images already
 * sit in one row (an equal pair on a grid, an aspect-weighted pair on a media slide) and are left as
 * they were; only three used to pack 2+1.
 */
export const takesScreenshotRow = (count) => count === 3;

/** One image and nothing else (a corner QR is pinned chrome, not content): the lone screenshot. */
export function isLoneScreenshot(blocks) {
  if (!Array.isArray(blocks)) return false;
  const body = blocks.filter((block) => block && block.type !== "qr");
  return body.length === 1 && body[0].type === "image";
}

const ROW_OPEN = /<div class="((?:image-grid|figure-row)[^"]*)" data-shot-row="(frames|fanned)" data-shot-aspects="([^"]*)" data-shot-captions="([01])"([^>]*?) style="([^"]*)">/g;

/** Step 2: read each marked row, plan it for this slide's band, append the custom properties. */
export function sizeScreenshotRows(html, band) {
  if (typeof html !== "string" || !html.includes("data-shot-row=")) return html;
  return html.replace(ROW_OPEN, (whole, cls, style, aspects, captions, rest, css) => {
    const list = aspects.split(",").map(Number).filter((a) => a > 0);
    if (list.length < 2) return whole;
    const plan = planScreenshotRow({ style, aspects: list, captions: captions === "1", band });
    const vars = style === "fanned"
      ? `--sr-ph:${plan.ph}px;--sr-ov:${plan.ov}px`
      : `--sr-fh:${plan.fh}px;--sr-z:${plan.z}`;
    return `<div class="${cls}" data-shot-row="${style}" data-shot-aspects="${aspects}" data-shot-captions="${captions}"${rest} style="${css};${vars}">`;
  });
}
