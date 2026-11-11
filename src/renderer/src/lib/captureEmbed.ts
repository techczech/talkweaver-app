import { parseHeadingAttrs, parseTriggerLine } from '../../../../compiler/scripts/lib/02-triggers-layout.mjs'
import { preContentWindow, resolveSlideId } from '../../../../compiler/scripts/lib/slide-id.mjs'
// Capture embed… (src/main/live-page-capture-window.ts): what the inspector says about a slide's web
// pages and their saved views, and the request that opens the capture window for one of them.
// The saved views are the slide's {capture} lines (compiler/scripts/lib/live-page-capture-markup.mjs),
// read from the slide's text as it is in the editor now, so the count changes with every edit and
// with every capture the writer adds. Views recorded before the markup (alpha.14/15) are not counted
// here: the presentation still shows them for a page with no {capture} line.
import { readOutlineSlides } from '../../../shared/feedback-accept.ts'
import { captureMarkupOfSlideText, removeCaptureLine } from '../../../../compiler/scripts/lib/live-page-capture-markup.mjs'

/** Structural identity across the save's heading/trigger relocation; all authored body bytes count. */
function captureBlockIdentity(source: string): string {
  const lines = source.split(/\r?\n/)
  const heading = parseHeadingAttrs(lines[0] ?? '')
  const prelude = preContentWindow(lines, 0)
  const attrs: Record<string, unknown> = {}
  const warnings: string[] = []
  for (const line of lines.slice(1, prelude.end)) {
    const parsed = parseTriggerLine(line)
    if (!parsed) { if (line.trim()) warnings.push('unparsed:' + line); continue }
    Object.assign(attrs, parsed.attrs)
    warnings.push(...parsed.warnings)
  }
  Object.assign(attrs, heading.attrs)
  delete attrs.id
  warnings.push(...heading.warnings)
  return JSON.stringify([heading.title, Object.keys(attrs).sort().map(key => [key, attrs[key]]), warnings.sort(), lines.slice(prelude.end).join('\n').replace(/\n+$/, '')])
}

/** An explicit ID survives edits; a derived ID requires the exact current compile snapshot. */
export function captureSourceBlock(text: string, row: { slide_id?: string; source_markdown?: string } | null, compiledSource: string | null = null): string | null {
  if (!row) return null
  const read = readOutlineSlides(text)
  const block = (slide: (typeof read.slides)[number]) => read.lines.slice(slide.start, slide.blockEnd).join('\n')
  let matches = read.slides.filter(slide => slide.id && slide.id === row.slide_id)
  if (!matches.length) {
    // A matching block after an edit may be a copy whose original was deleted. Only a fresh
    // compile can name an unstamped slide; stable explicit IDs remain valid across edits.
    if (text !== compiledSource) return null
    const source = row.source_markdown ?? ''
    if (!source || !compiledSource || resolveSlideId(source.split(/\r?\n/), 0)) return null
    const identity = captureBlockIdentity(source)
    const original = readOutlineSlides(compiledSource)
    const raw = (value: string) => value.replace(/\r\n/g, '\n').replace(/\n+$/, '')
    if (original.slides.filter(slide => raw(original.lines.slice(slide.start, slide.blockEnd).join('\n')) === raw(source)).length !== 1) return null
    const originalMatches = original.slides.filter(slide => captureBlockIdentity(original.lines.slice(slide.start, slide.blockEnd).join('\n')) === identity)
    if (originalMatches.length !== 1) return null
    matches = read.slides.filter(slide => captureBlockIdentity(block(slide)) === identity)
  }
  return matches.length === 1 ? block(matches[0]) : null
}

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
  const lines = (slide.text ?? '').split(/\r?\n/)
  const slideId = lines.length ? resolveSlideId(lines, 0)?.id ?? slide.slideId : slide.slideId
  if (!page || !slideId) { deps.notify('This slide shows no web page to capture. Choose a slide with an [Embed: https://…] line.', 'info'); return false }
  try {
    const result = await deps.open({ outlinePath: slide.outlinePath, slideId, pageUrl: page.pageUrl, title: slide.title, images: page.images, alts: page.alts })
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
