import { transformInlineMarks } from '../../compiler/scripts/lib/00-inline-protection.mjs'

/**
 * An image on a slide, given to the rewrite agent as content — never a rendered picture. `alt` is the
 * authored alt text; `ocrText` is the text TalkWeaver already extracts from the image for search.
 */
export interface TalkTextImage {
  src: string
  alt?: string
  ocrText?: string
}

export interface TalkTextRow {
  slideId: string
  title: string
  navTitle?: string
  thumbKey?: string
  /**
   * The slide's full heading ancestry, root-first (e.g. ["Part I", "A topic", "A sub-topic"]).
   * This is what makes the outline UNBOUNDED in depth — the Parcel-C adapter reconstructs it from
   * the outline (a depth-stack walk), so this module never caps nesting at section/subsection.
   * Empty array = a slide sitting at the document root.
   */
  headingPath?: string[]
  /** The slide's authored Markdown source (includes image references + alt). Given to the agent. */
  markdown?: string
  /** Images on the slide, with the text extracted from them for search. Given to the agent. */
  images?: TalkTextImage[]
  layout?: string
}

export interface TalkTextSegment {
  start: number
  end: number
  text: string
}

export interface TalkTextTrim {
  start: number
  end: number
}

export interface TalkTextMark {
  event: string
  slideId?: string
  tMs: number
}

export interface TalkTextMeta {
  talkSlug: string
  talkTitle: string
  speaker?: string
  event?: string
  date?: string
  recordedMs: number
  rawMs?: number
  trimmedMs?: number
}

export interface TalkTextNode {
  title: string
  depth: number
  slideNumber?: number
  children: TalkTextNode[]
}

export interface TalkTextSlide {
  slideNumber: number
  slideId: string
  title: string
  thumbKey?: string
  sectionPath: string[]
  startMs: number
  endMs: number
  segments: TalkTextSegment[]
  /** The slide's authored Markdown (image refs + alt included); '' when unknown. */
  markdown: string
  /** Images on the slide with their extracted search text; [] when none/unknown. */
  images: TalkTextImage[]
}

export interface TalkTextModel {
  meta: TalkTextMeta
  outline: TalkTextNode[]
  slides: TalkTextSlide[]
}

type Heading = { title: string; depth: number }
type SlideWindow = {
  encounter: number
  slideNumber: number
  slideId: string
  startMs: number
  endMs: number
  segments: TalkTextSegment[]
}

function text(value: string | undefined): string {
  return value?.trim() ?? ''
}

// Each slide's ancestry comes straight from its headingPath, so nesting is unbounded: a heading at
// position i sits at depth i+1, and the slide leaf hangs one level below the deepest heading. Blank
// titles are dropped and depths re-derived, so a sparse path never leaves gaps in the tree.
function rowHeadingPath(rows: TalkTextRow[]): Map<string, Heading[]> {
  const paths = new Map<string, Heading[]>()
  for (const row of rows) {
    if (paths.has(row.slideId)) continue
    const headings = (row.headingPath ?? [])
      .map((entry) => text(entry))
      .filter(Boolean)
      .map((title, index) => ({ title, depth: index + 1 }))
    paths.set(row.slideId, headings)
  }
  return paths
}

function fullyInsideTrim(segment: TalkTextSegment, trims: TalkTextTrim[]): boolean {
  return trims.some((trim) => segment.start >= trim.start && segment.end <= trim.end)
}

function addSlideToOutline(outline: TalkTextNode[], path: Heading[], slide: TalkTextSlide): void {
  let children = outline
  for (const heading of path) {
    let node = children.find((candidate) => (
      candidate.slideNumber === undefined &&
      candidate.title === heading.title &&
      candidate.depth === heading.depth
    ))
    if (!node) {
      node = { title: heading.title, depth: heading.depth, children: [] }
      children.push(node)
    }
    children = node.children
  }

  const parentDepth = path.at(-1)?.depth ?? 0
  children.push({
    title: slide.title,
    depth: Math.max(1, parentDepth + 1),
    slideNumber: slide.slideNumber,
    children: []
  })
}

export function buildTalkTextModel(input: {
  rows: TalkTextRow[]
  slideTimeIndex: TalkTextMark[]
  segments: TalkTextSegment[]
  trims?: TalkTextTrim[]
  meta: TalkTextMeta
}): TalkTextModel | null {
  const usableSlideIds = new Set(input.rows.map((row) => row.slideId))
  const enters = input.slideTimeIndex.filter((mark): mark is TalkTextMark & { slideId: string } => (
    mark.event === 'enter' && typeof mark.slideId === 'string' && usableSlideIds.has(mark.slideId)
  ))
  if (enters.length === 0) return null
  const firstNumbers = new Map<string, number>()
  for (const mark of enters) {
    if (!firstNumbers.has(mark.slideId)) firstNumbers.set(mark.slideId, firstNumbers.size + 1)
  }

  const windows: SlideWindow[] = enters.map((mark, encounter) => ({
    encounter,
    slideNumber: firstNumbers.get(mark.slideId)!,
    slideId: mark.slideId,
    startMs: mark.tMs,
    endMs: enters[encounter + 1]?.tMs ?? input.meta.recordedMs,
    segments: []
  }))

  // Re-entered slides keep their first-appearance number but retain separate windows. A segment
  // belongs to the earliest clock-ordered window containing its start, which keeps overlaps and
  // out-of-order marks deterministic without trying to union recording intervals.
  const windowsByTime = [...windows].sort((a, b) => a.startMs - b.startMs || a.encounter - b.encounter)
  const trims = input.trims ?? []
  for (const segment of input.segments) {
    if (fullyInsideTrim(segment, trims)) continue
    const window = windowsByTime.find((candidate) => (
      segment.start >= candidate.startMs && segment.start < candidate.endMs
    ))
    if (window) window.segments.push(segment)
  }

  const rowsById = new Map<string, TalkTextRow>()
  for (const row of input.rows) {
    if (!rowsById.has(row.slideId)) rowsById.set(row.slideId, row)
  }
  const pathsById = rowHeadingPath(input.rows)
  const slides = windows.map((window): TalkTextSlide => {
    const row = rowsById.get(window.slideId)
    return {
      slideNumber: window.slideNumber,
      slideId: window.slideId,
      title: text(row?.navTitle) || text(row?.title) || window.slideId,
      // Only include thumbKey when present: structure.json IS the model, and JSON drops undefined keys,
      // so an explicit `thumbKey: undefined` would break the model⇄JSON round-trip (test-rewritepack).
      ...(row?.thumbKey ? { thumbKey: row.thumbKey } : {}),
      sectionPath: (pathsById.get(window.slideId) ?? []).map((heading) => heading.title),
      startMs: window.startMs,
      endMs: window.endMs,
      segments: [...window.segments],
      markdown: text(row?.markdown),
      images: (row?.images ?? []).map((image) => ({ ...image }))
    }
  })

  const outline: TalkTextNode[] = []
  const attached = new Set<number>()
  for (const row of input.rows) {
    windows.forEach((window, index) => {
      if (attached.has(index) || window.slideId !== row.slideId) return
      addSlideToOutline(outline, pathsById.get(row.slideId) ?? [], slides[index])
      attached.add(index)
    })
  }
  windows.forEach((_window, index) => {
    if (!attached.has(index)) addSlideToOutline(outline, [], slides[index])
  })

  return { meta: { ...input.meta }, outline, slides }
}

export function formatTimecode(ms: number): string {
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${String(totalMinutes).padStart(2, '0')}:${ss}`
}

export function renderScriptMarkdown(
  model: TalkTextModel,
  opts: { cleanedBySlide?: Map<number, string> | Record<number, string>; timecodes?: boolean } = {}
): string {
  const byNumber = new Map<number, TalkTextSlide[]>()
  for (const slide of model.slides) {
    const matches = byNumber.get(slide.slideNumber) ?? []
    matches.push(slide)
    byNumber.set(slide.slideNumber, matches)
  }
  const used = new Map<number, number>()
  const blocks: string[] = []

  const visit = (node: TalkTextNode): void => {
    const hashes = '#'.repeat(Math.max(1, node.depth))
    if (node.slideNumber === undefined) {
      blocks.push(`${hashes} ${node.title}`)
    } else {
      const occurrence = used.get(node.slideNumber) ?? 0
      const slide = byNumber.get(node.slideNumber)?.[occurrence]
      used.set(node.slideNumber, occurrence + 1)
      if (slide) {
        const lines = [`${hashes} Slide ${slide.slideNumber} — ${slide.title}`]
        if (opts.timecodes) lines.push(`${formatTimecode(slide.startMs)}–${formatTimecode(slide.endMs)}`)
        const override = opts.cleanedBySlide instanceof Map
          ? opts.cleanedBySlide.get(slide.slideNumber)
          : opts.cleanedBySlide?.[slide.slideNumber]
        const transcript = override ?? slide.segments.map((segment) => segment.text).filter(Boolean).join('\n')
        if (transcript) lines.push(transcript)
        blocks.push(lines.join('\n\n'))
      }
    }
    for (const child of node.children) visit(child)
  }

  for (const node of model.outline) visit(node)
  return blocks.join('\n\n').trim()
}

export function renderNotesMarkdown(
  _model: TalkTextModel,
  approvedParts: Array<{ slug: string; order: number; markdown: string }>,
  opts: { references?: boolean } = {}
): string {
  const markdown = [...approvedParts]
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
    .map((part) => part.markdown.trim())
    .filter(Boolean)
    .join('\n\n')
  if (opts.references ?? true) return markdown
  return markdown.replace(
    /\[(slides?\s+\d+(?:\s*[-–]\s*\d+)?)\]\(\/slides\/\d+\)/gi,
    '$1'
  )
}

function plainMarkdown(markdown: string): string {
  const plain = markdown
    .replace(/\r\n/g, '\n')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '- ')
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, '- ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/(^|[^_])_([^_]+)_/g, '$1$2')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
  return transformInlineMarks(plain, (inner) => inner)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineHtml(value: string): string {
  return transformInlineMarks(escapeHtml(value), (inner) => `<mark class="ink-marker">${inner}</mark>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
}

function richMarkdown(markdown: string): string {
  const blocks: string[] = []
  let paragraph: string[] = []
  let list: string[] = []
  const flushParagraph = (): void => {
    if (paragraph.length) blocks.push(`<p>${inlineHtml(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const flushList = (): void => {
    if (list.length) blocks.push(`<ul>${list.map((item) => `<li>${inlineHtml(item)}</li>`).join('')}</ul>`)
    list = []
  }

  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      blocks.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`)
    } else if (item) {
      flushParagraph()
      list.push(item[1])
    } else if (!line.trim()) {
      flushParagraph()
      flushList()
    } else {
      flushList()
      paragraph.push(line.trim())
    }
  }
  flushParagraph()
  flushList()
  return blocks.join('\n')
}

export function exportText(markdown: string, format: 'markdown' | 'plain' | 'rich'): string {
  if (format === 'markdown') return markdown
  return format === 'plain' ? plainMarkdown(markdown) : richMarkdown(markdown)
}
