// Title look (0.37, slide-design-round-2, ticket 04): how a TOP title is drawn. Kicker, Label and
// Tab are three corner treatments of the compact top title; `default` is the plain centred title.
// Pure. Precedence: slide {titlelook=…} > the slide's section (`sections:` map) > the deck
// (`defaults:` map, then the frontmatter `title_look:` key) > default.
//
// Named `titlelook`, never `title_style`: `title_style` is the OPENING poster variant
// (title-poster.mjs) and `data-title-style` is the retired sidebar stamp.

/** The looks a slide can carry besides the default. */
export const TITLE_LOOKS = ["kicker", "label", "tab"];
/** Kicker placement: `normal` keeps the top padding, `edge` sits the kicker near the top edge. */
export const TITLE_LOOK_PLACES = ["normal", "edge"];

const LOOK_ALIASES = { default: "default", none: "default", plain: "default", off: "default" };
const PLACE_ALIASES = { normal: "normal", edge: "edge", "top-edge": "edge", top: "edge" };

function readLook(raw) {
  if (raw == null || raw === true || raw === false) return null;
  const text = String(raw).trim().toLowerCase();
  if (TITLE_LOOKS.includes(text)) return text;
  return LOOK_ALIASES[text] ?? null;
}
function readPlace(raw) {
  if (raw == null || raw === true || raw === false) return null;
  return PLACE_ALIASES[String(raw).trim().toLowerCase()] ?? null;
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
 * @param {Record<string, unknown>} slideAttrs parsed heading/trigger attrs of the slide
 * @param {Record<string, unknown>} sectionDefaults the slide's section entry in `sections:`
 * @param {Record<string, unknown>} deckDefaults the frontmatter `defaults:` map
 * @param {Record<string, unknown>} meta the frontmatter (`title_look:`, `title_look_at:`)
 * @returns {{look: string, place: string}} look is "" (default), kicker, label or tab; place is
 *          "" (normal) or "edge" and only ever set with the kicker
 */
export function resolveTitleLook(slideAttrs = {}, sectionDefaults = {}, deckDefaults = {}, meta = {}) {
  const deckMeta = { titlelook: meta?.title_look ?? meta?.["title-look"], "titlelook-at": meta?.title_look_at ?? meta?.["title-look-at"] };
  const sources = [slideAttrs, sectionDefaults, deckDefaults, deckMeta];
  const look = pick(sources, ["titlelook"], readLook);
  const place = pick(sources, ["titlelook-at"], readPlace);
  const resolved = TITLE_LOOKS.includes(look) ? look : "";
  return { look: resolved, place: resolved === "kicker" && place === "edge" ? "edge" : "" };
}
