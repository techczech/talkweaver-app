import {
  logicalTriggerBlockAfterHeading,
  TRIGGER_LINE_RE
} from '../../../../shared/trigger-line.ts'
import {
  objectLayoutEntries,
  objectLayoutReadsStorage,
  type ObjectLayoutDef
} from '../../../../shared/layout-registry/entries.ts'
import {
  layoutEntryAcceptsTriggerToken,
  winningAuthoredLayout
} from '../../../../shared/layout-registry/vocabulary.ts'
import { readOutlineObjectRegions } from '../../../../shared/objects/outline-object-regions.ts'
import { compiledLayoutsAt } from '../../../../shared/quote-write-check.ts'
import {
  describeHtmlComment,
  fenceKindForInfo
} from '../../../../../compiler/scripts/lib/outline-regions.mjs'
import {
  embedLinePageUrl,
  isCaptureViewsMarker,
  readCaptureLine
} from '../../../../../compiler/scripts/lib/live-page-capture-markup.mjs'
import { isBareUrl } from '../../../../../compiler/scripts/lib/02-triggers-layout.mjs'
import {
  chartObjectTokenAt,
  parseChartFenceOpeningLine,
  parseMarkdownFenceOpeningLine
} from '../../../../../compiler/scripts/lib/03-object-token.mjs'

export type ObjectBlockKind =
  | 'gfm-table'
  | 'trigger-table'
  | 'chart'
  | 'barchart'
  | 'piechart'
  | 'linechart'
  | 'mindmap'
  | 'mermaid'
  | 'svg'
  // Fence cards (ADR-0042): every other closed fence. `chat` and `terminal` are the slide's simulation
  // session; a second session fence, or one under a non-simulation layout, is a `code` card.
  | 'code'
  | 'chat'
  | 'terminal'
  | 'trace'
  // Private and opaque regions (ADR-0042 notes/comments addendum).
  | 'notes'
  | 'comment'
  // A page, simulation or video line (`[Embed: …]`, `[Simulation: …]`, `[Video: …]`, a bare address
  // paragraph). A web page's saved-views marker and saved views belong to its card.
  | 'embed'

/** The compiler's simulation designs a session fence can carry. */
export type SimulationDesign = 'chat' | 'chat-lanes' | 'terminal' | 'terminal-agent'

export type CommentDescription = ReturnType<typeof describeHtmlComment>

export type ObjectBlock = {
  kind: ObjectBlockKind
  from: number
  to: number
  source: string
  /** Absolute editable body range for a canonical fenced object. */
  bodyFrom?: number
  bodyTo?: number
  triggerLine?: number
  triggerToken?: string
  /** A fence card: its info string as written (language for code). */
  info?: string
  /** A chat or terminal session fence: the slide's simulation design. */
  design?: SimulationDesign
  /** A chat/terminal fence the slide does not use as its session (`sim-extra-fence`), or one under another layout. */
  simNote?: 'ignored' | 'other-layout'
  /** A notes card: its position among the closed blocks of the same slide, and whether it is the talk's own. */
  notesIndex?: number
  notesCount?: number
  deckNotes?: boolean
  /** A comment card: what it is, from exact patterns only. */
  comment?: CommentDescription
  /** An embed card: what its first line names, and the saved views grouped under a web page. */
  embed?: EmbedFacts
}

export type EmbedFacts = {
  variant: 'web' | 'bare' | 'local' | 'simulation' | 'video' | 'video-web'
  /** The address or path as written. */
  src: string
  /** The host of a web address, else the file name. */
  name: string
  /** The `<!-- saved views {capture} -->` line is inside this card. */
  marker: boolean
  /** The `{capture}` lines inside this card, in order, as written (`savedView`: a capture writer's picture). */
  captures: Array<{ alt: string; src: string; savedView: boolean; line: string }>
  playOnNext?: boolean
}

/** A closed comment that shares its line with text: an atomic inline chip, never a block. */
export type InlineComment = {
  from: number
  to: number
  source: string
  comment: CommentDescription
}

/** A construct left as text with a warning (unclosed notes, an unclosed comment). */
export type RegionWarning = {
  kind: 'unclosed-notes' | 'unclosed-comment'
  /** The opener's line start and end. */
  from: number
  to: number
  /** For unclosed notes: where an explicit "Add closing :::" inserts its line (the end of the notes range). */
  closeAt?: number
}

export type OutlineObjects = {
  blocks: ObjectBlock[]
  inline: InlineComment[]
  warnings: RegionWarning[]
}

export function objectBlockEditableSource(block: ObjectBlock): string {
  if (
    typeof block.bodyFrom === 'number'
    && typeof block.bodyTo === 'number'
    && block.bodyFrom >= block.from
    && block.bodyTo >= block.bodyFrom
    && block.bodyTo <= block.to
  ) {
    return block.source.slice(block.bodyFrom - block.from, block.bodyTo - block.from)
  }
  if (/^\s*(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.test(block.source)) {
    return block.source
      .replace(/^\s*(`{3,}|~{3,})[^\r\n]*(?:\r?\n)?/, '')
      .replace(/(?:\r?\n)?(`{3,}|~{3,})\s*(?:\r?\n)?$/, '')
  }
  return block.source.trimEnd()
}

type SourceLine = {
  text: string
  from: number
  to: number
}

function sourceLines(doc: string): SourceLine[] {
  let offset = 0
  return doc.split('\n').map((text, index, lines) => {
    const from = offset
    const to = from + text.length + (index < lines.length - 1 ? 1 : 0)
    offset = to
    return { text, from, to }
  })
}

function objectFence(
  openingLine: string
): { kind: ObjectBlockKind; triggerToken?: string; info?: string } | null {
  const chart = parseChartFenceOpeningLine(openingLine)?.chart
  if (chart) {
    const candidates = objectLayoutEntries()
      .filter((candidate) => objectLayoutReadsStorage(candidate, 'fence'))
    const entry = candidates.find((candidate) =>
      layoutEntryAcceptsTriggerToken(candidate, chart.token)
    )
    return entry
      ? { kind: detectedObjectKind(entry), triggerToken: chart.token }
      : { kind: 'code', info: parseMarkdownFenceOpeningLine(openingLine)?.info ?? '' }
  }

  const opening = parseMarkdownFenceOpeningLine(openingLine)
  if (!opening) return null
  // The compiler's rule (03-markdown-lexer-core.mjs takeFence): the WHOLE info string, lower-cased, is
  // the language, so ```svg code and ```svg foo are code panels, never figures.
  const kind = fenceKindForInfo(opening.info)
  if (kind === 'svg' || kind === 'mermaid') {
    const entry = objectLayoutEntries().find((candidate) => {
      if (!objectLayoutReadsStorage(candidate, 'fence')) return false
      return /^```(\S+)/.exec(candidate.trigger.trim())?.[1].toLowerCase() === kind
    })
    return entry ? { kind: detectedObjectKind(entry), info: opening.info } : { kind: 'code', info: opening.info }
  }
  return { kind: kind as ObjectBlockKind, info: opening.info }
}

function detectedObjectKind(entry: ObjectLayoutDef): ObjectBlockKind {
  // The generic GFM table and the registered trigger-list table keep distinct internal kinds.
  return entry.name === 'table'
    ? 'trigger-table'
    : entry.name as ObjectBlockKind
}

function triggerObject(
  line: string
): { kind: ObjectBlockKind; triggerToken: string } | null {
  if (/^\s/.test(line)) return null
  const trimmed = line.trim()
  if (!TRIGGER_LINE_RE.test(trimmed)) return null
  const winner = winningAuthoredLayout(trimmed)
  if (!winner) return null
  const candidates = objectLayoutEntries()
    .filter((candidate) => objectLayoutReadsStorage(candidate, 'trigger-list'))
  const entry = candidates.find((candidate) =>
    layoutEntryAcceptsTriggerToken(candidate, winner.triggerToken)
  ) ?? candidates.find((candidate) => candidate.name === winner.layout)
  return entry
    ? { kind: detectedObjectKind(entry), triggerToken: winner.triggerToken }
    : null
}

/**
 * Mirrors the compiler block lexer. Chart block tokens use the compiler's shared token/adjacency
 * resolver; trigger-line charts remain a compatibility reading only when no block token competes.
 * Fences deliberately diverge for unterminated runs: unfinished source stays editable.
 */
export function detectObjectBlocks(doc: string): ObjectBlock[] {
  return detectOutlineObjects(doc).blocks
}

const SIMULATION_DESIGNS = new Set<SimulationDesign>(['chat', 'chat-lanes', 'terminal', 'terminal-agent'])

/**
 * Every object of the outline in one pass (ADR-0042): the block objects (tables, charts, mind maps,
 * diagrams, every closed fence, closed speaker-notes blocks, standalone closed comments), the inline
 * comment chips, and the warnings for constructs left as text. Opaque regions (fence bodies, notes
 * bodies, comments, front matter) are never read for other objects, as the compiler never reads them.
 */
export function detectOutlineObjects(doc: string): OutlineObjects {
  const lines = sourceLines(doc)
  const rawLines = lines.map((line) => line.text)
  const regions = readOutlineObjectRegions(doc)
  const fenced = rawLines.map((_line, index) =>
    regions.kinds[index] !== 'outline'
    || regions.inFence[index]
    || regions.inNotes[index]
  )
  const fenceExtents = new Map(
    regions.fences.filter((extent) => !extent.inNotes).map((extent) => [extent.start, extent])
  )
  const fenceScan = { extents: [...fenceExtents.values()] }
  const blocks: ObjectBlock[] = []
  const separator = /^\|[\s:|-]+\|?$/
  const listItem = /^\s*(?:[-*]\s+|\d+[.)]\s+)/
  const ownerByLine: number[] = []
  let owner = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (!fenced[index] && /^(#{2,6})\s+/.test(lines[index].text)) owner = index
    ownerByLine[index] = owner
  }
  const chartKinds = new Set<ObjectBlockKind>([
    'chart',
    'barchart',
    'piechart',
    'linechart'
  ])
  const fencedObjects = new Map<number, NonNullable<ReturnType<typeof objectFence>>>()
  const slidesWithChartFences = new Set<number>()
  for (const extent of fenceScan.extents) {
    if (!extent.closed) continue
    // The opening line as the compiler reads it: a comment on it is blanked first (review F4).
    const object = objectFence(extent.line)
    if (!object) continue
    fencedObjects.set(extent.start, object)
    if (chartKinds.has(object.kind)) slidesWithChartFences.add(ownerByLine[extent.start])
  }
  const canonicalTriggerLines = new Set<number>()
  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index] || !/^(#{2,6})\s+/.test(lines[index].text)) continue
    const triggerBlock = logicalTriggerBlockAfterHeading(rawLines, index)
    // The compiler folds only the first non-blank Trigger-only line into the heading.
    // Any later Trigger-only line remains body content and may therefore own an adjacent list.
    if (triggerBlock) canonicalTriggerLines.add(triggerBlock.start)
  }
  const chartBlocks = new Map<number, NonNullable<ReturnType<typeof chartObjectTokenAt>>>()
  const slidesWithChartBlocks = new Set<number>()
  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index] || canonicalTriggerLines.has(index)) continue
    const token = chartObjectTokenAt(rawLines, index)
    if (!token) continue
    chartBlocks.set(index, token)
    slidesWithChartBlocks.add(ownerByLine[index])
  }
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    const trimmed = line.text.trim()
    const extent = fenceExtents.get(index)
    if (extent) {
      const object = fencedObjects.get(index)
      // An unfinished hand-authored fence stays editable source. Treating it as a complete widget
      // hijacks Enter and relocates typing while the author is still writing its body.
      if (object && extent.closed) {
        const closingLine = lines[extent.bodyEnd]
        const to = lines[extent.end - 1]?.to ?? line.to
        const bodyFrom = line.to
        const beforeClosing = doc.slice(bodyFrom, closingLine.from)
        const separatorLength = beforeClosing.endsWith('\r\n')
          ? 2
          : beforeClosing.endsWith('\n')
            ? 1
            : 0
        blocks.push({
          kind: object.kind,
          from: line.from,
          to,
          source: doc.slice(line.from, to),
          bodyFrom,
          bodyTo: closingLine.from - separatorLength,
          triggerToken: object.triggerToken,
          ...(object.info !== undefined && !chartKinds.has(object.kind) ? { info: object.info } : {})
        })
      }
      // Even when incomplete, the fence body remains opaque to the rest of object detection.
      index = Math.max(extent.end, index + 1)
      continue
    }
    if (fenced[index]) {
      index += 1
      continue
    }

    const scopedChart = chartBlocks.get(index)
    if (scopedChart) {
      const trigger = triggerObject(line.text)
      let cursor = scopedChart.listStart
      let lastListLine = scopedChart.listStart
      while (cursor < lines.length && listItem.test(lines[cursor].text)) {
        lastListLine = cursor
        cursor += 1
      }
      const from = lines[scopedChart.listStart].from
      const to = lines[lastListLine].to
      if (trigger && !slidesWithChartFences.has(ownerByLine[index])) {
        blocks.push({
          kind: trigger.kind,
          from,
          to,
          source: doc.slice(from, to),
          triggerLine: index + 1,
          triggerToken: trigger.triggerToken
        })
      }
      index = cursor
      continue
    }

    const trigger = triggerObject(line.text)
    if (trigger) {
      if (
        chartKinds.has(trigger.kind)
        && (
          slidesWithChartBlocks.has(ownerByLine[index])
          || slidesWithChartFences.has(ownerByLine[index])
        )
      ) {
        index += 1
        continue
      }
      let start = index + 1
      while (start < lines.length && lines[start].text.trim() === '') start += 1
      if (start < lines.length && listItem.test(lines[start].text)) {
        let cursor = start
        let lastListLine = start
        while (cursor < lines.length) {
          if (listItem.test(lines[cursor].text)) {
            lastListLine = cursor
            cursor += 1
            continue
          }
          if (
            lines[cursor].text.trim() === ''
            && cursor + 1 < lines.length
            && listItem.test(lines[cursor + 1].text)
          ) {
            cursor += 1
            continue
          }
          break
        }
        const from = lines[start].from
        const to = lines[lastListLine].to
        blocks.push({
          kind: trigger.kind,
          from,
          to,
          source: doc.slice(from, to),
          triggerLine: index + 1,
          triggerToken: trigger.triggerToken
        })
        index = cursor
        continue
      }
    }

    if (
      trimmed.startsWith('|')
      && index + 1 < lines.length
      && separator.test(lines[index + 1].text.trim())
    ) {
      let end = index + 2
      while (end < lines.length && lines[end].text.trim().startsWith('|')) end += 1
      const to = lines[end - 1].to
      blocks.push({
        kind: 'gfm-table',
        from: line.from,
        to,
        source: doc.slice(line.from, to)
      })
      index = end
      continue
    }

    index += 1
  }

  resolveSimulationSessions(doc, blocks, lines, ownerByLine)
  const notesBlocks = notesObjects(doc, lines, regions, ownerByLine)
  const embedBlocks = embedObjects(doc, rawLines, lines, fenced, [...blocks, ...notesBlocks])
  const { commentBlocks, inline } = commentObjects(doc, rawLines, lines, regions, [...blocks, ...notesBlocks, ...embedBlocks])
  const all = [...blocks, ...notesBlocks, ...embedBlocks, ...commentBlocks].sort((a, b) => a.from - b.from)
  return { blocks: all, inline, warnings: regionWarnings(doc, lines, regions) }
}

function lineIndexAt(lines: SourceLine[], pos: number): number {
  let lo = 0
  let hi = lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lines[mid].from <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The compiler's layout for each slide that holds a chat or terminal fence, for the last text read. */
let layoutCache: { doc: string; key: string; layouts: Map<number, string | null> } | null = null

function compilerLayouts(doc: string, headingLines: number[]): Map<number, string | null> {
  const key = headingLines.join(',')
  if (layoutCache && layoutCache.doc === doc && layoutCache.key === key) return layoutCache.layouts
  const layouts = compiledLayoutsAt(doc, headingLines)
  layoutCache = { doc, key, layouts }
  return layouts
}

/**
 * The compiler's simulation session (simulation-layout.mjs annotateSimulationLayout): the slide's layout is
 * the one the compiler itself draws (quote-write-check.ts compiledLayoutsAt: authored layout, then media
 * before code, then the first code fence); under a simulation layout the FIRST chat/terminal fence is the
 * session (a terminal design reads it as a shell session, the others as labelled turns) and any later one
 * is ignored. Under any other layout (a chat fence beside a picture is a media slide) a chat or terminal
 * fence is an ordinary code panel. The compiler is asked only when the text has such a fence.
 */
function resolveSimulationSessions(
  doc: string,
  blocks: ObjectBlock[],
  lines: SourceLine[],
  ownerByLine: number[]
): void {
  const sims = blocks.filter((block) => block.kind === 'chat' || block.kind === 'terminal')
  if (!sims.length) return
  const ownerOf = (block: ObjectBlock): number => ownerByLine[lineIndexAt(lines, block.from)]
  const owners = [...new Set(sims.map(ownerOf).filter((owner) => owner >= 0))]
  const layouts = compilerLayouts(doc, owners.map((owner) => owner + 1))
  const sessionTaken = new Set<number>()
  for (const block of sims) {
    const owner = ownerOf(block)
    const lang = block.kind
    const design = (owner >= 0 ? layouts.get(owner + 1) ?? null : null) as SimulationDesign | null
    if (!design || !SIMULATION_DESIGNS.has(design)) {
      block.kind = 'code'
      block.simNote = 'other-layout'
      continue
    }
    if (sessionTaken.has(owner)) {
      block.kind = 'code'
      block.simNote = 'ignored'
      continue
    }
    sessionTaken.add(owner)
    block.design = design
    block.kind = design === 'terminal' ? 'terminal' : 'chat'
    if (lang === 'chat' && design === 'terminal') block.simNote = undefined
  }
}

const EMBED_RE = /^\[(Embed|Simulation):\s*(.+?)\]$/i
const VIDEO_RE = /^\[Video:\s*(.+?)\]\s*(\{\s*play-on-next\s*\})?$/i

function nameOf(src: string): string {
  if (/^https?:/i.test(src)) {
    try { return new URL(src).host || src } catch { return src }
  }
  return src.split(/[\\/]/).pop() || src
}

/** A line that ends the paragraph above it (blank, a heading, a Trigger line), as takeParagraph reads it. */
function paragraphBreakAbove(rawLines: string[], index: number, fenced: boolean[]): boolean {
  if (index === 0) return true
  const above = rawLines[index - 1].replace(/\r$/, '').trim()
  return above === '' || fenced[index - 1] || /^#{1,6}\s/.test(above) || TRIGGER_LINE_RE.test(above)
}

/**
 * The compiler's page, simulation and video lines (03-markdown-lexer-core.mjs: the trimmed line is the
 * whole directive; a paragraph that is only an http(s) address is an auto-embed). A web page's card runs
 * on over the lines directly under it that are its saved-views marker or its {capture} lines (blank lines
 * between them included), so deleting the page never leaves an orphaned saved view or marker.
 */
function embedObjects(
  doc: string,
  rawLines: string[],
  lines: SourceLine[],
  fenced: boolean[],
  others: ObjectBlock[]
): ObjectBlock[] {
  const out: ObjectBlock[] = []
  const occupied = (from: number, to: number): boolean => others.some((block) => from < block.to && to > block.from)
  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index]) continue
    const text = rawLines[index].replace(/\r$/, '').trim()
    if (!text) continue
    let facts: EmbedFacts | null = null
    let m: RegExpMatchArray | null
    if ((m = text.match(EMBED_RE))) {
      const src = m[2].trim()
      const web = /^https?:/i.test(src)
      facts = { variant: web ? 'web' : m[1].toLowerCase() === 'simulation' ? 'simulation' : 'local', src, name: nameOf(src), marker: false, captures: [] }
    } else if ((m = text.match(VIDEO_RE))) {
      const src = m[1].trim()
      facts = { variant: /^https?:/i.test(src) ? 'video-web' : 'video', src, name: nameOf(src), marker: false, captures: [], playOnNext: Boolean(m[2]) }
    } else if (
      isBareUrl(text)
      && paragraphBreakAbove(rawLines, index, fenced)
      && (index + 1 >= rawLines.length || rawLines[index + 1].replace(/\r$/, '').trim() === '' || fenced[index + 1])
    ) {
      facts = { variant: 'bare', src: text, name: nameOf(text), marker: false, captures: [] }
    }
    if (!facts) continue
    let last = index
    if (embedLinePageUrl(text)) {
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = rawLines[next].replace(/\r$/, '')
        // The marker is a comment (an opaque line to every other reader); it is read here exactly.
        if (fenced[next] && !isCaptureViewsMarker(line)) break
        if (!line.trim()) continue
        if (isCaptureViewsMarker(line) && !facts.marker && facts.captures.length === 0) {
          facts.marker = true
          last = next
          continue
        }
        const capture = readCaptureLine(line)
        if (!capture) break
        facts.captures.push({ ...capture, line: line.trim() })
        last = next
      }
    }
    const from = lines[index].from
    const to = lines[last].to
    if (occupied(from, to)) continue
    out.push({ kind: 'embed', from, to, source: doc.slice(from, to), embed: facts })
    index = last
  }
  return out
}

function bodyRange(doc: string, lines: SourceLine[], openLine: number, closeLine: number): { bodyFrom: number; bodyTo: number } {
  const bodyFrom = lines[openLine].to
  const closing = lines[closeLine]
  const before = doc.slice(bodyFrom, closing.from)
  const separator = before.endsWith('\r\n') ? 2 : before.endsWith('\n') ? 1 : 0
  return { bodyFrom, bodyTo: Math.max(bodyFrom, closing.from - separator) }
}

/** One card per CLOSED `:::notes … :::` block (outside fences and comments); an unclosed block stays text. */
function notesObjects(
  doc: string,
  lines: SourceLine[],
  regions: ReturnType<typeof readOutlineObjectRegions>,
  ownerByLine: number[]
): ObjectBlock[] {
  const closed = regions.notes.filter((extent) => extent.closed)
  const perOwner = new Map<number, number>()
  for (const extent of closed) {
    const owner = ownerByLine[extent.start]
    perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1)
  }
  const seen = new Map<number, number>()
  return closed.map((extent) => {
    const owner = ownerByLine[extent.start]
    const index = (seen.get(owner) ?? 0) + 1
    seen.set(owner, index)
    const from = lines[extent.start].from
    const to = lines[extent.close].to
    return {
      kind: 'notes' as const,
      from,
      to,
      source: doc.slice(from, to),
      ...bodyRange(doc, lines, extent.start, extent.close),
      notesIndex: index,
      notesCount: perOwner.get(owner) ?? 1,
      deckNotes: owner < 0
    }
  })
}

/**
 * Closed comments in ordinary outline text: a standalone comment (nothing else on its lines) is a block
 * card; a one-line comment sharing its line with text is an inline chip; a multi-line comment sharing a
 * line with text stays text. Comments inside fences, notes, the front matter or another object are the
 * container's text, never a card. The saved-views marker directly under its web page is a card that
 * says what deleting it does.
 */
function commentObjects(
  doc: string,
  rawLines: string[],
  lines: SourceLine[],
  regions: ReturnType<typeof readOutlineObjectRegions>,
  others: ObjectBlock[]
): { commentBlocks: ObjectBlock[]; inline: InlineComment[] } {
  const commentBlocks: ObjectBlock[] = []
  const inline: InlineComment[] = []
  const insideOther = (from: number, to: number): boolean =>
    others.some((block) => from < block.to && to > block.from)
  for (const extent of regions.comments) {
    if (extent.container !== 'outline') continue
    const text = doc.slice(extent.from, extent.to)
    if (extent.standalone) {
      const from = lines[extent.startLine].from
      const to = lines[extent.endLine].to
      if (insideOther(from, to)) continue
      commentBlocks.push({
        kind: 'comment',
        from,
        to,
        source: doc.slice(from, to),
        bodyFrom: extent.from,
        bodyTo: extent.to,
        comment: describeHtmlComment(text, {
          aloneOnLine: extent.startLine === extent.endLine,
          pageAbove: pageAbove(rawLines, extent.startLine, regions)
        })
      })
      continue
    }
    if (extent.startLine !== extent.endLine) continue
    // A heading line's text and tail are Plain view's; a comment on it stays text.
    if (/^#{1,6}\s/.test(rawLines[extent.startLine])) continue
    if (insideOther(extent.from, extent.to)) continue
    inline.push({ from: extent.from, to: extent.to, source: text, comment: describeHtmlComment(text) })
  }
  return { commentBlocks, inline }
}

/** The nearest non-blank line above is a web page embed (the marker's own placement rule). */
function pageAbove(rawLines: string[], line: number, regions: ReturnType<typeof readOutlineObjectRegions>): boolean {
  for (let index = line - 1; index >= 0; index -= 1) {
    const text = rawLines[index].replace(/\r$/, '').trim()
    if (!text) continue
    if (regions.kinds[index] !== 'outline') return false
    return embedLinePageUrl(text) !== null
  }
  return false
}

function regionWarnings(
  doc: string,
  lines: SourceLine[],
  regions: ReturnType<typeof readOutlineObjectRegions>
): RegionWarning[] {
  const warnings: RegionWarning[] = []
  for (const extent of regions.notes) {
    if (extent.closed) continue
    const opener = lines[extent.start]
    const last = lines[Math.max(extent.start, extent.end - 1)]
    warnings.push({
      kind: 'unclosed-notes',
      from: opener.from,
      to: opener.from + opener.text.replace(/\r$/, '').length,
      closeAt: Math.min(doc.length, last.from + last.text.replace(/\r$/, '').length)
    })
  }
  for (const stray of regions.unclosedComments) {
    if (regions.kinds[stray.line] === 'frontmatter' || regions.inFence[stray.line]) continue
    const line = lines[stray.line]
    warnings.push({ kind: 'unclosed-comment', from: stray.from, to: Math.min(line.from + line.text.replace(/\r$/, '').length, stray.from + 4) })
  }
  return warnings
}
