// Capture embed… (src/main/live-page-capture-window.ts): what the inspector says about a slide's web
// pages and their saved views, and the request that opens the capture window for one of them.
// The saved views are the slide's {capture} lines (compiler/scripts/lib/live-page-capture-markup.mjs),
// read from the slide's text as it is in the editor now, so the count changes with every edit and
// with every capture the writer adds. Views recorded before the markup (alpha.14/15) are not counted
// here: the presentation still shows them for a page with no {capture} line.
import { captureMarkupOfSlideText, removeCaptureLine } from '../../../../compiler/scripts/lib/live-page-capture-markup.mjs'

export type SlideLivePage = { pageUrl: string; host: string; count: number; images: string[]; alts: string[] }

/** The slide's web pages (embed lines with an http(s) address), each with its saved views in order. */
export function slideLivePages(slideText: string | null | undefined): SlideLivePage[] {
  return captureMarkupOfSlideText(slideText).pages.map((page) => {
    const views = page.captures.filter((capture) => capture.savedView)
    let host = page.pageUrl
    try { host = new URL(page.pageUrl).host } catch { /* shown as written */ }
    return { pageUrl: page.pageUrl, host, count: views.length, images: views.map((v) => v.src), alts: views.map((v) => v.alt) }
  })
}

/** The words for a page's saved views: an explicit empty state, or how many. */
export function savedViewsLabel(count: number): string {
  return count === 0 ? 'No saved views' : count === 1 ? '1 saved view' : `${count} saved views`
}

export type CaptureEmbedDeps = {
  open(request: { outlinePath: string; slideId: string; pageUrl: string; title: string; images: string[]; alts: string[] }): Promise<{ ok: true } | { ok: false; message: string }>
  notify(message: string, kind: 'info' | 'warning'): void
}

/**
 * Opens the capture window for `page` on the slide (its compiled id, the id the deck reports), or says
 * why not. `page` absent: the slide's first web page.
 */
export async function openCaptureEmbed(
  deps: CaptureEmbedDeps,
  slide: { outlinePath: string | null; slideId: string | null; title: string; text: string | null },
  pageUrl?: string
): Promise<boolean> {
  if (!slide.outlinePath) { deps.notify('Open a talk first.', 'info'); return false }
  const pages = slideLivePages(slide.text)
  const page = pageUrl ? pages.find((p) => p.pageUrl === pageUrl) : pages[0]
  if (!page || !slide.slideId) { deps.notify('This slide shows no web page to capture. Choose a slide with an [Embed: https://…] line.', 'info'); return false }
  try {
    const result = await deps.open({ outlinePath: slide.outlinePath, slideId: slide.slideId, pageUrl: page.pageUrl, title: slide.title, images: page.images, alts: page.alts })
    if (!result.ok) { deps.notify(result.message, 'warning'); return false }
    return true
  } catch {
    deps.notify('The capture window could not be opened.', 'warning')
    return false
  }
}

type CompiledSlideRow = { slide_id?: string | null; source_markdown?: string | null }

/**
 * Remove from slide (Inspector › Web page), planned against the editor's buffer `text`. Which slide:
 * the compiled row the inspector shows (`rows[index]`), named by that compile's own id and heading
 * line (its projected source, never a line of the newer text read at the old line number); it must
 * still start at `line`, where the inspector showed it. Which embed: `embed` (the listing's own embed
 * of that address). Anything that no longer matches refuses, the text untouched (review e3b41fd1).
 * → `{ text }` to put in as one undo step, or `{ refused }` with the words to show.
 */
export function planSavedViewRemoval(input: {
  text: string; rows: readonly CompiledSlideRow[] | null; index: number; line: number | null
  pageUrl: string; image: string; embed: { index: number; of: number }
}): { text: string } | { refused: string } {
  const row = input.rows?.[input.index] ?? null
  const slideId = row?.slide_id ?? null
  if (!slideId || input.line == null) return { refused: 'This saved view was not removed: the slide is not ready yet. Try again in a moment.' }
  const headingOf = (r: CompiledSlideRow | null): string | null => {
    const first = String(r?.source_markdown ?? '').split(/\r?\n/)[0].replace(/\r$/, '').trim()
    return /^#{1,6}\s/.test(first) ? first : null
  }
  const heading = headingOf(row)
  // A heading another compiled slide also has names no slide; the id alone must then be in the text.
  const unique = heading != null && (input.rows ?? []).filter((r) => headingOf(r) === heading).length === 1
  const result = removeCaptureLine(input.text, { id: slideId, ...(unique && heading ? { heading } : {}), line: input.line }, input.pageUrl, input.image, input.embed)
  if (result.removed) return { text: result.text }
  return {
    refused: result.reason === 'capture-slide-ambiguous'
      ? 'This saved view was not removed: more than one slide has this title and none has an id of its own, so it cannot be told which one is meant.'
      : result.reason === 'capture-slide-moved' || result.reason === 'capture-embed-ambiguous'
        ? 'This saved view was not removed: the slide has changed since the inspector showed it. Try again in a moment.'
        : 'This saved view was not removed: it is no longer on this slide in the editor.'
  }
}
