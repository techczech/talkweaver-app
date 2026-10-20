// Slide-markup identity guards (tests that hash compiled slide sections against a reference recorded
// from an older compiler) compare everything except what later tickets deliberately added to every
// slide. One place lists those additions, so each guard keeps its own intent.
//
// 0.41 ticket 01 (ADR-0039): beside the section accent, every slide's inline stamp carries the next two
// hues of the deck palette and their tints (`--sec-hue-2`, `--sec-hue-2-tint`, `--sec-hue-3`,
// `--sec-hue-3-tint`; 07-assembly.mjs). A reference recorded before that ticket has none of them.
const SECTION_HUE_STAMP = /; --sec-hue-[23](?:-tint)?: #[0-9a-f]{6}/g
// 0.41 ticket 02 (ADR-0039 "Title look"): a talk with no `title_look:` draws its top titles as the
// index tab, so every top-title slide of such a talk carries `data-title-look="tab"`. A reference
// recorded before that ticket drew the plain title there and has no stamp. Only such a talk's tab
// stamps are the new default: in a talk that names a look anywhere (frontmatter, `defaults:`,
// `sections:` or a slide token) a tab stamp may be authored, and dropping it would hide a regression
// where an explicit tab disappears. So callers say which talk this is (talkNamesTitleLook below).
const DEFAULT_TITLE_LOOK_STAMP = / data-title-look="tab"/g

/** Whether the outline text names a title look anywhere: `title_look:` / `title-look:` in the
 *  frontmatter, `titlelook:` in `defaults:` or `sections:`, or a slide's `{titlelook=…}`. */
export function talkNamesTitleLook(outlineText) {
  return /\btitle[_-]?look\s*[:=]/i.test(String(outlineText ?? ''))
}

/**
 * The slide markup without the stamps a later ticket added to every slide.
 * @param {string} html one or more compiled slide sections
 * @param {{talkNamesTitleLook: boolean}} talk whether the compiled talk names a title look
 *   (talkNamesTitleLook above); the default tab stamp is dropped only when it does not.
 */
export function withoutLaterSlideStamps(html, talk) {
  if (typeof talk?.talkNamesTitleLook !== 'boolean') {
    throw new TypeError('withoutLaterSlideStamps: say whether the talk names a title look ({ talkNamesTitleLook })')
  }
  const out = String(html).replace(SECTION_HUE_STAMP, '')
  return talk.talkNamesTitleLook ? out : out.replace(DEFAULT_TITLE_LOOK_STAMP, '')
}
