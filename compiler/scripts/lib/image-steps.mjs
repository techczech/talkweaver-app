// =============================================================================
// image-steps.mjs — "Step through images" (0.38 ticket 03, ADR-0034)
//
// The setting that makes Next walk a slide's still images in the zoomed view before moving on.
// Off by default. The compiler only resolves the setting and stamps `data-image-steps` on the
// slide's <section>; the stepping itself is the deck runtime's (assets/runtime/image-steps.js).
// =============================================================================
import { readDeckFlag } from "./deck-settings.mjs";

/**
 * Read the setting for one slide: slide token `{image-steps}` / `{no-image-steps}` → deck
 * `image_steps:` → off. `{no-image-steps}` reaches here as `image-steps=off` (a bare alias in the
 * layout registry); `{image-steps=on|off}` is read the same way. Anything unreadable falls through
 * to the next level, so a typo keeps today's behaviour (off).
 *
 * @param {Record<string, unknown>|undefined} attrs the slide's trigger attributes
 * @param {Record<string, unknown>|undefined} meta the deck frontmatter
 * @returns {boolean}
 */
export function resolveImageSteps(attrs, meta) {
  const slide = readDeckFlag(attrs?.["image-steps"]);
  if (slide.state === "on") return true;
  if (slide.state === "off") return false;
  return readDeckFlag(meta?.image_steps ?? meta?.["image-steps"]).state === "on";
}
