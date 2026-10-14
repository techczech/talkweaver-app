// Title look (0.37, slide-design-round-2, ticket 04): how a TOP title is drawn. Kicker, Label and
// Tab are three corner treatments of the compact top title; `default` is the plain centred title.
// Pure. Precedence: slide {titlelook=…} > the slide's section (`sections:` map) > the deck
// (`defaults:` map, then the frontmatter `title_look:` key) > default.
//
// Named `titlelook`, never `title_style`: `title_style` is the OPENING poster variant
// (title-poster.mjs) and `data-title-style` is the retired sidebar stamp.

/** The looks a slide can carry besides the default. */
export const TITLE_LOOKS = ["kicker", "label", "tab"];
/** Tab tone: `strong` is the full section colour with white text (the default), `soft` a deeper light shade with ink text. */
export const TITLE_LOOK_TONES = ["strong", "soft"];

const LOOK_ALIASES = { default: "default", none: "default", plain: "default", off: "default" };

function readLook(raw) {
  if (raw == null || raw === true || raw === false) return null;
  const text = String(raw).trim().toLowerCase();
  if (TITLE_LOOKS.includes(text)) return text;
  return LOOK_ALIASES[text] ?? null;
}
function readTone(raw) {
  if (raw == null || raw === true || raw === false) return null;
  const text = String(raw).trim().toLowerCase();
  return TITLE_LOOK_TONES.includes(text) ? text : null;
}
function pick(sources, keys, read) {
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const key of keys) {
      const value = read(src[key]);
      if (value != null) return value;
    }
  }
  return null;
}

/**
 * `titlelook-at` (where a Kicker sits) is accepted and ignored: every look now sits at the slide edge.
 * @param {Record<string, unknown>} slideAttrs parsed heading/trigger attrs of the slide
 * @param {Record<string, unknown>} sectionDefaults the slide's section entry in `sections:`
 * @param {Record<string, unknown>} deckDefaults the frontmatter `defaults:` map
 * @param {Record<string, unknown>} meta the frontmatter (`title_look:`, `title_look_tone:`)
 * @returns {{look: string, tone: string}} look is "" (default), kicker, label or tab; tone is "soft"
 *          only for a Tab set to soft, otherwise "" (strong stamps nothing)
 */
export function resolveTitleLook(slideAttrs = {}, sectionDefaults = {}, deckDefaults = {}, meta = {}) {
  const deckMeta = { titlelook: meta?.title_look ?? meta?.["title-look"], "titlelook-tone": meta?.title_look_tone ?? meta?.["title-look-tone"] };
  const sources = [slideAttrs, sectionDefaults, deckDefaults, deckMeta];
  const look = pick(sources, ["titlelook"], readLook);
  const tone = pick(sources, ["titlelook-tone"], readTone);
  const resolved = TITLE_LOOKS.includes(look) ? look : "";
  return { look: resolved, tone: resolved === "tab" && tone === "soft" ? "soft" : "" };
}
