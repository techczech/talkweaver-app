// =============================================================================
// TITLE POSTER — the ONE emitter for a deck's bookend posters.
//
// ADR-0015 locked the 30/70 sidebar Poster as the title slide's default rendering
// (docs/design/2026-07-18-title-slide/corrected-poster.html). ADR-0023 §6 extends it: an
// AUTHORED `{title}` or `{closing}` slide renders through the SAME poster as the synthesised
// deck-title and deck-thanks, so the two can never drift apart.
//
// Every `title-poster` block in the model is built here — the auto bookends in 08-source-adapters
// (E7) and the authored conversion below both call `posterBlockFor`. `06-block-renderers`
// (`renderBlock`, block.type === "title-poster") stays the single renderer.
//
// THE SLOTS (identical for auto and authored):
//   heading   the slide's title            → h2.tp-title
//   subtitle  first body paragraph, or the deck's own subtitle/cta for the auto slides
//                                          → p.tp-sub (p.tp-cta on a closing)
//   byline    frontmatter author/affiliation/web/date/series/event/logo/accent + handout QR
//   body      EVERY further authored block → div.tp-body under the byline (nothing is dropped)
//
// The auto slides carry no `body`, so their emitted HTML is byte-identical to the pre-§6 build.
// =============================================================================

/** Poster variants `title_style` may select for an opening (ADR-0015). */
export const TITLE_STYLES = ["poster", "split", "banner"];

/** Model layouts that render as a poster, and the bookend role each one plays. */
export const POSTER_LAYOUT_ROLES = new Map([["title", "opening"], ["closing", "ending"]]);

/**
 * The poster variant for a bookend. An ending always uses the `closing` variant — the auto
 * closing has never taken `title_style`, and ADR-0023 §6 keeps authored and auto closings on the
 * same variant. An opening takes frontmatter `title_style`, defaulting to the locked Poster.
 */
export function posterVariantFor(meta, role) {
  if (role === "ending") return "closing";
  const named = String(meta?.title_style || "").toLowerCase();
  return TITLE_STYLES.includes(named) ? named : "poster";
}

/** The deck accent a poster is painted in: `colour` wins, `accent` is the alias. */
export function posterAccentFor(meta) {
  return String(meta?.colour || meta?.accent || "").trim();
}

/**
 * Build the `title-poster` block for one bookend.
 *
 * @param {{meta?: object, title?: string, subtitle?: string, body?: Array<object>}} source
 *        `meta` is the deck frontmatter; `title`/`subtitle` fill the two headline slots;
 *        `body` is every further authored block (omitted entirely when empty).
 * @param {{role?: 'opening'|'ending'}} options which bookend this is — picks the variant.
 * @returns {{type: 'title-poster', variant: string, data: object}}
 */
export function posterBlockFor(source, { role } = {}) {
  const meta = source?.meta || {};
  const block = {
    type: "title-poster",
    variant: posterVariantFor(meta, role),
    data: {
      title: source?.title ?? "",
      subtitle: source?.subtitle ?? "",
      series: meta.series || "",
      event: meta.event || "",
      date: meta.date || "",
      author: meta.author || "",
      affiliation: meta.affiliation || "",
      web: meta.web || "",
      logo: meta.logo || "",
      accent: posterAccentFor(meta)
    }
  };
  const body = Array.isArray(source?.body) ? source.body.filter(Boolean) : [];
  if (body.length) block.data.body = body;
  return block;
}

/**
 * The deck's OWN subtitle for a bookend — what the auto slide puts in the subtitle slot when the
 * slide has no paragraph of its own. An opening takes frontmatter `subtitle`; an ending takes
 * `cta` (the auto closing has never read `subtitle`, so an authored closing must not either).
 */
export function deckSubtitleFor(meta, role) {
  if (role === "ending") return typeof meta?.cta === "string" ? meta.cta.trim() : "";
  return meta?.subtitle || "";
}

/**
 * Block types that can fill the poster's subtitle slot — a leading paragraph, and a leading
 * CLAIM, which is what a wholly-bold paragraph lexes to since ADR-0023 §4 (`claimFromBoldParagraph`
 * in 02-triggers-layout). `**Thank you**` under an authored `{closing}` is the commonest thing an
 * author actually writes there, and it must reach the subtitle slot, not the body. The claim's
 * text already has its markers consumed, so the slot takes it verbatim.
 */
const SUBTITLE_BLOCK_TYPES = new Set(["paragraph", "claim"]);

/**
 * Split one authored bookend slide's blocks into the poster's subtitle slot and its body.
 * The FIRST block fills the subtitle slot when (and only when) it is a paragraph or a claim.
 * Everything else is body, in authored order — a claim further down renders there as an ordinary
 * paragraph (it never reaches `withRenderedClaims`, which walks a slide's own block containers,
 * not a poster's body), which is the intended treatment: the poster body is small print under the
 * byline, and a size-or-bar claim treatment has no meaning at that scale.
 */
export function posterSlotsForBlocks(blocks) {
  const present = (blocks || []).filter(Boolean);
  const lead = present[0];
  if (lead && SUBTITLE_BLOCK_TYPES.has(lead.type)) {
    return { subtitle: String(lead.text ?? ""), body: present.slice(1) };
  }
  return { subtitle: "", body: present };
}

/**
 * ADR-0023 §6 — convert every AUTHORED `{title}` / `{closing}` slide in place so it renders
 * through the poster. Slides that already carry a poster block (the auto bookends) and slides
 * whose body is raw HTML or a carousel are left alone. Returns the ids converted.
 *
 * A slide with no leading paragraph falls back to the deck's own subtitle for that bookend
 * (Dominik, 2026-09-12), so an authored bookend is never barer than the auto one it replaces.
 */
export function applyAuthoredPosters(slides, meta) {
  const converted = [];
  for (const slide of slides || []) {
    if (!slide) continue;
    const role = POSTER_LAYOUT_ROLES.get(slide.layout);
    if (!role) continue;
    if (slide.html) continue;
    if (Array.isArray(slide.carousel) && slide.carousel.length) continue;
    const blocks = (slide.blocks || []).filter(Boolean);
    if (blocks.some((block) => block.type === "title-poster")) continue;
    const { subtitle, body } = posterSlotsForBlocks(blocks);
    slide.blocks = [posterBlockFor({
      meta,
      title: slide.title ?? "",
      subtitle: subtitle || deckSubtitleFor(meta, role),
      body
    }, { role })];
    converted.push(slide.id);
  }
  return converted;
}
