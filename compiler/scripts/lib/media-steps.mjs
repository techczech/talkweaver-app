// =============================================================================
// media-steps.mjs — "Play as a step" (0.38 ticket 05)
//
// `![alt](clip.mp4){play-on-next}` / `![Title](clip.mp3){play-on-next}`: the file is one step of
// its slide, and the press of Next that reaches it starts it. The compiler's part is to decide
// where the option stands and to mark the file; the stepping and the playback are the runtimes'
// (assets/runtime/emphasis-steps.js for the order, assets/runtime/media-steps.js for playback).
//
// The lexer records the token as `flags.playOnNext` on a video or audio block, and as a bare
// `playOnNext` on a block that cannot take it (an image, a YouTube / Vimeo player).
// resolvePlayOnNext() settles one slide:
//   {nostep} on the slide        the option is dropped; the file is a file without it
//   with {autoplay} on the file  {play-on-next} wins, {autoplay} is dropped, with a warning
//   on an image or an embed      ignored, with a warning
// The renderer then writes `data-play-on-next` on the video's <figure> or the audio chip, and
// 07-assembly stamps `data-media-steps` on the <section> of a slide that carries one.
// =============================================================================

function fileName(src) {
  const text = String(src ?? "");
  if (text.startsWith("data:")) return "file";
  return text.split(/[?#]/)[0].split("/").pop() || "file";
}

function visit(node, noStep, slideId, warn, seen) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) { node.forEach((entry) => visit(entry, noStep, slideId, warn, seen)); return; }
  if (node.type === "video" || node.type === "audio") {
    const flags = node.flags;
    if (flags && flags.playOnNext) {
      if (noStep) delete flags.playOnNext;
      else if (flags.autoplay) {
        delete flags.autoplay;
        warn(`play-on-next-autoplay:${slideId}:${fileName(node.src)}`);
      }
    }
  } else if (node.playOnNext) {
    delete node.playOnNext;
    if (!noStep) warn(`play-on-next-ignored:${slideId}:${node.type === "embed" ? "an embedded player" : fileName(node.src)}`);
  }
  // `flags` is the file's own record, settled above: not a block to look into.
  for (const [key, value] of Object.entries(node)) if (key !== "flags") visit(value, noStep, slideId, warn, seen);
}

/**
 * Settle {play-on-next} on every block of one slide, in place. Idempotent.
 * @param {unknown} blocks the slide's blocks, and anything that nests blocks (cards, carousel sub-slides)
 * @param {{ noStep?: boolean, slideId?: string }} slide
 * @param {(warning: string) => void} warn
 */
export function resolvePlayOnNext(blocks, slide, warn) {
  visit(blocks, slide?.noStep === true, slide?.slideId ?? "", typeof warn === "function" ? warn : () => {}, new Set());
}

const MARKED_FILE = /<(?:figure class="slide-figure slide-video"|div class="slide-audio" data-audio-state="ready") data-play-on-next[\s>]/;

/** Whether a slide's rendered content carries a file that plays as a step. */
export function hasMediaSteps(html) {
  return MARKED_FILE.test(String(html ?? ""));
}
