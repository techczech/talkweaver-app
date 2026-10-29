import { buildShareHtml } from './09-output-builders.mjs'
import { collectTalkLinks, pageLink } from './handout-home.mjs'

/**
 * The handout's home page (index.html beside <slug>.html), locked design 2026-10-07 "Handout 4b": one
 * page with three layouts (before the talk, live, handout). It is the handout bundle itself in home mode:
 * the same slides, styles and live client, so the poll, board, reactions, Ask and My Notes on the home
 * page are the slides view's own, not a second client.
 * Pre-work is not run here: "Start the pre-work" and the "Before the session" rows open the slides view,
 * where the form lives.
 *
 * lazyAssets: the published page loads heavy slide media lazily (handout-lazy-assets.mjs); then
 * home.downloadFile NAMES the self-contained file "Download slides" saves (the link to it is made
 * here, relative and encoded; home.downloadHref, a ready link, is still taken from older callers).
 * home: { url, qr, downloadFile?, downloadHref?, startsAt?: number | null, prework?, and the band's parts from
 *   handoutHomeDetails: day, date, startTime, event, author, subtitle, affiliation }
 */
export function buildHandoutHomePageHtml({ title, slides, styles, slug, license, workerBaseUrl, liveTalkSlug = slug, home = {}, lazyAssets = false }) {
  // The slides view beside this page, by name: a relative, encoded link (handout-home.mjs pageLink).
  const slidesFile = `${slug}.html`
  const slidesHref = pageLink(slidesFile)
  return buildShareHtml({
    title, slides, styles, slug, license, workerBaseUrl, liveTalkSlug, includeNotes: false, lazyAssets,
    home: {
      ...home,
      slidesHref,
      slidesFile,
      links: collectTalkLinks(slides, { slidesFile, exclude: [home.url].filter(Boolean) }),
    },
  })
}
