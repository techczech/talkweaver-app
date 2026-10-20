// Title look (0.37, slide-design-round-2, ticket 04): how a TOP title is drawn. Kicker, Label and
// Tab are three corner treatments of the compact top title; `default` (alias `full`) is the plain
// top title. Pure. Precedence: slide {titlelook=…} > the slide's section (`sections:` map) > the deck
// (`defaults:` map, then the frontmatter `title_look:` key) > the index tab.
//
// 0.41 (ADR-0039 "Title look"): a deck that names no look gets the index tab (`tab`), not the plain
// title; an unknown value falls through to it as well. `intro-then-none` is a look of the section:
// the section card introduces the topic and the slides after it in that section carry no top title.
// The resolver only names it; which slides follow a card is decided over the whole deck
// (followsSectionCard below, applied in 08-source-adapters.mjs).
//
// 0.41 ticket 03 (ADR-0039): `tab-strip` is a row of pills naming the section's slide titles, the
// current one filled. Like intro-then-none it reads the slide order, so its pills are worked out over
// the whole deck (sectionStrip below, applied in 08-source-adapters.mjs) and 07-assembly draws them.
//
// Named `titlelook`, never `title_style`: `title_style` is the OPENING poster variant
// (title-poster.mjs) and `data-title-style` is the retired sidebar stamp.

/** The looks a slide can carry besides the default. */
export const TITLE_LOOKS = ["kicker", "label", "tab", "tab-strip", "intro-then-none"];
/** The look a slide takes when nothing names one (0.41, ADR-0039). */
export const DEFAULT_TITLE_LOOK = "tab";
/** Every spelling of the plain top title. */
export const PLAIN_TITLE_LOOKS = ["default", "full", "none", "plain", "off"];
/** Tab tone: `strong` is the full section colour with white text (the default), `soft` a deeper light shade with ink text. */
export const TITLE_LOOK_TONES = ["strong", "soft"];

const LOOK_ALIASES = Object.fromEntries(PLAIN_TITLE_LOOKS.map((alias) => [alias, "default"]));

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
 * @returns {{look: string, tone: string}} look is "" (the plain title), kicker, label, tab (also when
 *          nothing names a look), tab-strip or intro-then-none; tone is "soft" only for a Tab set to soft,
 *          otherwise "" (strong stamps nothing)
 */
export function resolveTitleLook(slideAttrs = {}, sectionDefaults = {}, deckDefaults = {}, meta = {}) {
  const deckMeta = { titlelook: meta?.title_look ?? meta?.["title-look"], "titlelook-tone": meta?.title_look_tone ?? meta?.["title-look-tone"] };
  const sources = [slideAttrs, sectionDefaults, deckDefaults, deckMeta];
  const look = pick(sources, ["titlelook"], readLook);
  const tone = pick(sources, ["titlelook-tone"], readTone);
  const resolved = look == null ? DEFAULT_TITLE_LOOK : TITLE_LOOKS.includes(look) ? look : "";
  return { look: resolved, tone: resolved === "tab" && tone === "soft" ? "soft" : "" };
}

/**
 * Whether a section or subsection card paints its title, mirroring the hide rules of 07-assembly
 * (renderSlideContent): {notitle} or `title: off` (slide, section or deck frame) hide it unless
 * {title=show}; {title=side} or an explicit {title=top} beat {notitle}. A card with no title text
 * paints none either.
 * @param {{title?: string, noTitle?: boolean, titleMode?: string, frame?: {title?: string}, frameTitleExplicit?: boolean}} card
 */
export function cardShowsTitle(card) {
  if (!card || String(card.title ?? "").trim() === "") return false;
  if (card.titleMode === "show") return true;
  const frameTitle = card.frame?.title ?? "top";
  if (frameTitle === "off") return false;
  const authorForcesTitle = frameTitle === "side" || (card.frameTitleExplicit === true && frameTitle === "top");
  return !(card.noTitle === true && !authorForcesTitle);
}

/**
 * intro-then-none, over the whole deck: whether a slide resolved to it follows a card that
 * introduced its topic. A section card introduces every later slide of its section; a subsection
 * card only the slides inside that subsection (a sibling heading after the subsection is not
 * introduced by it). Only a card that paints its title introduces anything (cardShowsTitle): a
 * hidden heading has told the audience nothing. A slide before any such card keeps the plain top
 * title: nothing has introduced the topic yet.
 * @param {Array<{section?: string, subsection?: string, role?: string}>} slides the deck's slides in order
 * @param {number} index the slide asked about
 */
export function followsSectionCard(slides, index) {
  const slide = slides[index];
  const section = slide?.section;
  if (!section) return false;
  for (let i = index - 1; i >= 0; i -= 1) {
    const prior = slides[i];
    if (prior?.section !== section) continue;
    if (prior.role === "section-title" && cardShowsTitle(prior)) return true;
    if (prior.role === "subsection-title" && prior.subsection && prior.subsection === slide.subsection && cardShowsTitle(prior)) return true;
  }
  return false;
}

/** The most pills a strip shows: the current one and its neighbours (0.41 ticket 03). */
export const TAB_STRIP_MAX_PILLS = 5;
const CARD_ROLES = new Set(["section-title", "subsection-title"]);
const isCard = (s) => CARD_ROLES.has(s?.role) || s?.layout === "title";

/**
 * tab-strip, over the whole deck: the pills of a slide's strip. The pills name the slides of the
 * slide's own section in order, leaving out the section's cards (and any title poster); every
 * slide gets its own pill, even when two authored slides share a title (no title-equality merge:
 * a compiler-split continuation carries no marker on the slide object, so none is merged). A long section is cut to the `max` pills around the current one, so the strip never wraps;
 * a slide in no section shows its own pill alone. `plain` runs beside `titles` only when a pill's slide is a
 * Run's extra slide (work-files ticket 25, runExtra): true there, whose title is plain text as typed and is
 * never read as inline markdown; a strip with no such pill has no `plain` field.
 * @param {Array<{section?: string, role?: string, layout?: string, title?: string, navTitle?: string, runExtra?: boolean}>} slides the deck's slides in order
 * @param {number} index the slide asked about
 * @param {number} [max] the most pills shown
 * @returns {{titles: string[], plain?: boolean[], current: number, cutBefore: boolean, cutAfter: boolean}}
 */
export function sectionStrip(slides, index, max = TAB_STRIP_MAX_PILLS) {
  const self = slides[index];
  const titleOf = (s) => String(s?.title || s?.navTitle || "");
  const section = self?.section;
  const members = section
    ? slides.map((s, i) => ({ s, i })).filter(({ s, i }) => i === index || (s?.section === section && !isCard(s)))
    : [{ s: self, i: index }];
  const titles = [];
  const plain = [];
  let current = 0;
  for (const { s, i } of members) {
    titles.push(titleOf(s));
    plain.push(s?.runExtra === true);
    if (i === index) current = titles.length - 1;
  }
  const limit = Math.max(1, Math.floor(max));
  const withPlain = (cut, shown) => (shown.includes(true) ? { ...cut, plain: shown } : cut);
  if (titles.length <= limit) return withPlain({ titles, current, cutBefore: false, cutAfter: false }, plain);
  const start = Math.min(Math.max(0, current - Math.floor((limit - 1) / 2)), titles.length - limit);
  return withPlain({ titles: titles.slice(start, start + limit), current: current - start, cutBefore: start > 0, cutAfter: start + limit < titles.length }, plain.slice(start, start + limit));
}
