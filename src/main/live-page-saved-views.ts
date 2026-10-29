// The saved views one slide shows for one web page, as every open window should show them now: read
// from the talk's CURRENT text (an open editor's buffer, else the file), never from a compiled deck.
// The presenter and audience decks and the Capture embed window are told the list whenever the text
// changes (a save, a placed view, a view removed) and when a deck moves to another slide's page
// (live-page-host.ts refreshSavedViews), so a view saved or removed in one surface shows in all of
// them without a rebuild. An embed still on the compatibility listing (no marker, no {capture} line:
// views recorded before alpha.16) is left to the compiled deck, as before.
import { slideHeadingRef, slideSavedViewLines } from '../../compiler/scripts/lib/live-page-capture-markup.mjs'
import type { CaptureEmbedView } from './live-page-capture-window'

export type LivePageSavedView = { src: string | null; alt: string; capturedAt: string; mode: 'view' | 'page' }
/** `key` changes exactly when the list of lines changes; `views()` reads the pictures (null: the compiled deck decides). */
export type LivePageSavedViews = { key: string; views(): LivePageSavedView[] | null }

export type LivePageSavedViewsDeps = {
  read(outlinePath: string): Promise<string>
  compiledSlides(outlinePath: string, text: string): Promise<Array<{ id: string; sourceLine: number | null }>>
  pictures(outlinePath: string, items: Array<{ image: string; alt: string }>): CaptureEmbedView[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** What a {capture} line's words say (captureLineAlt): which kind of view, and when (UTC). */
export function captureAltWhen(alt: string): { capturedAt: string; mode: 'view' | 'page' } {
  const m = String(alt).match(/^\s*(Saved view|Entire page)(?:,\s*(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}))?\s*$/)
  if (!m) return { capturedAt: '', mode: 'view' }
  const mode = m[1] === 'Entire page' ? 'page' : 'view'
  const month = m[3] ? MONTHS.indexOf(m[3]) : -1
  if (!m[2] || month < 0) return { capturedAt: '', mode }
  const at = new Date(Date.UTC(Number(m[4]), month, Number(m[2]), Number(m[5]), Number(m[6])))
  return { capturedAt: Number.isNaN(at.getTime()) ? '' : at.toISOString(), mode }
}

/**
 * The slide's saved views of `pageUrl`, or null when the slide or page cannot be found in the text now
 * (being typed, deleted, a heading two slides share): the windows then keep what they show.
 */
export async function slideSavedViews(deps: LivePageSavedViewsDeps, outlinePath: string, slideId: string, pageUrl: string, text?: string): Promise<LivePageSavedViews | null> {
  const now = text ?? await deps.read(outlinePath)
  let found = slideSavedViewLines(now, { id: slideId }, pageUrl)
  if (found.reason === 'capture-slide-missing') {
    // An id the compiler derives from the heading: a compile of this text says which heading.
    try {
      const rows = (await deps.compiledSlides(outlinePath, now)).filter((s) => s.id === slideId)
      const ref = rows.length === 1 && rows[0].sourceLine !== null ? slideHeadingRef(now, rows[0].sourceLine) : null
      if (ref) found = slideSavedViewLines(now, { id: slideId, ...ref }, pageUrl)
    } catch { /* not found */ }
  }
  if (found.reason) return null
  if (!found.managed) return { key: 'compiled', views: () => null }
  const lines = found.views
  return {
    key: `lines\n${lines.map((v) => `${v.image}\u0000${v.alt}`).join('\n')}`,
    views: () => deps.pictures(outlinePath, lines).map((v) => ({ src: v.src, alt: v.alt, ...captureAltWhen(v.alt) }))
  }
}
