import { buildShareHtml } from './09-output-builders.mjs'
import { collectTalkLinks } from './handout-home.mjs'

/**
 * The handout's home page (index.html beside <slug>.html), live first (design 2026-10-02, direction B).
 * It is the handout bundle itself in home mode: the same slides, styles and live client, so the poll,
 * reactions, Ask and My Notes on the home page are the slides view's own, not a second client.
 * Pre-work is not run here: the "Before the session" row opens the slides view, where the form lives.
 *
 * lazyAssets: the published page loads heavy slide media lazily (handout-lazy-assets.mjs); then
 * home.downloadHref names the self-contained file the Download button saves.
 * home: { url, qr, downloadHref?, meta?, notLive?: { today, later }, startsAt?: number | null, prework?: { label, detail } | null }
 */
export function buildHandoutHomePageHtml({ title, slides, styles, slug, license, workerBaseUrl, liveTalkSlug = slug, home = {}, lazyAssets = false }) {
  const slidesHref = `${slug}.html`
  return buildShareHtml({
    title, slides, styles, slug, license, workerBaseUrl, liveTalkSlug, includeNotes: false, lazyAssets,
    home: {
      ...home,
      slidesHref,
      links: collectTalkLinks(slides, { exclude: [home.url].filter(Boolean) }),
    },
  })
}
