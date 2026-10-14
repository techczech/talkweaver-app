// =============================================================================
// Layout content verbs (ADR-0032 §3/§6 and Consequences; estate ADR-0019).
//
// Typed, headless operations over OUTLINE TEXT that the layout picker and the agent both call:
//
//   previewLayout      (outline, slide, layout, options?)      → outline text, nothing written
//   setLayout          (outline, slide, layout, options?, withStarterText?) → { outline, triggerLine }
//   chooseLayout       (outline, slide, layout)                → { ok, text, … }   (one layout, as the margin menu sets it; verified by the compiler's reading)
//   clearLayout        (outline, slide)                        → { ok, text, … }   (back to Auto; verified the same way)
//   setLayoutOption    (outline, slide, group, value)          → { outline, triggerLine }
//   canTakeLayout      (outline, slide, layout)                → { ok: true } | { ok: false, reason }
//   suggestLayouts     (outline, slide)                        → ranked [{ layout, why }] (0–6)
//
// Pure: no I/O, no Electron, no renderer state. A "write" here returns the new text; the caller
// (the editor transaction, the agent's write path) puts it on disk, and records the undo step.
// `previewLayout` and `setLayout` share one planner, so what the picker shows for a try is byte
// for byte what ↵ writes. The Trigger-line write goes through the picker's own functions
// (selectionFromTriggerLine / toggleLayoutSelection / commitLayoutSelection / commitOptionSelection),
// which keep `{id=…}` and every foreign token and never rewrite the author's bytes elsewhere.
//
// A slide is addressed by its `{id=…}` (a string), or by its 1-based heading line for a slide the
// save has not stamped yet.
//
// The Suggested ranking rule is the one in the locked mockup's notes panel
// (docs/design/2026-09-30-layout-picker/hifi, "Suggested: the ranking rule"). It is a heuristic
// over the slide's content shape; the thresholds live in the constants below so they can be tuned
// without reopening ADR-0032.
// =============================================================================
import { LAYOUTS } from './layout-registry/entries.ts'
import type { LayoutDef, OptionGroup } from './layout-registry/entries.ts'
import { optionGroupsForSlide, registryOptionGroups } from './layout-registry/options.ts'
import { winningAuthoredLayout } from './layout-registry/vocabulary.ts'
import { deckCommitContext } from './deck-frame.ts'
import { compilerFactsOf, type CompilerFacts, type SlideLayoutFacts, type SlideToken } from './plain-view-compiler-facts.ts'
import { authoredLayoutOf, entryTriggerBody, isDrawnAs, isSettableLayout, layoutDecisionOfEntry, listStyleWithoutList, writesEntryTrigger } from './slide-authored-layout.ts'
import { readOutlineSlides, slideEffectiveAttrs, type OutlineSlide, type OutlineSlides } from './feedback-accept.ts'
import { applyLayoutSelection, commitOptionSelection, isOptionTokenForGroup, logicalTriggerBlockAfterHeading, parseTriggerLine } from './trigger-line.ts'
import { commitLayoutSelection, selectionFromTriggerLine, toggleLayoutSelection } from './layout-selection.ts'
import { applyQuoteTitleAttribution, parseHeadingAttrs } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import { preContentWindow } from '../../compiler/scripts/lib/slide-id.mjs'
import { contentTriggerLines } from '../../compiler/scripts/lib/slide-attrs.mjs'
import {
  quoteFormPlan,
  parseSourceLine,
  sourceLinkSpan,
  readQuoteSlideLines,
  countQuoteBlocks,
  type QuoteFormDetectedBy,
  type QuoteFormName,
  type QuoteFormPresentation
} from '../../compiler/scripts/lib/quote-forms.mjs'
import { compiledQuoteAt, quoteFormWriteHolds, quoteSourceWriteHolds } from './quote-write-check.ts'

/** A slide by `{id=…}`, or by 1-based heading line for a slide with no id yet. */
export type SlideRef = string | { headingLine: number }

/** One option choice of the layout being tried or set: an option group's key and the chosen token
 *  ('' = the group's default, i.e. no token). */
export interface LayoutOptionChoice { group: string; token: string }

export type CanTake = { ok: true } | { ok: false; reason: string }
export interface LayoutSuggestion { layout: string; why: string }
export interface TriggerWrite {
  outline: string
  triggerLine: string
  /** What the write repaired on the way, from the Trigger block (e.g. `duplicate-slide-id-merged:kept a2,
   *  dropped a1 (Title)`: the block held several ids and the slide's resolved id was kept). Empty when nothing. */
  warnings: string[]
}

/** Why a verb refused. `cannot-take` is the content's verdict (the picker greys the row); every other
 *  code is a bad request (an unknown name, a token outside the registry's grammar, a missing slide). */
export type LayoutVerbErrorCode =
  | 'cannot-take'
  | 'unknown-layout'
  | 'unknown-option-group'
  | 'option-not-applicable'
  | 'bad-option-token'
  | 'slide-not-found'

export class LayoutVerbError extends Error {
  readonly code: LayoutVerbErrorCode
  /** For `cannot-take`: the one-line reason (the greyed row's text). */
  readonly reason?: string
  /** The message without the module prefix: what a surface may show. */
  readonly detail: string
  constructor(code: LayoutVerbErrorCode, message: string, reason?: string) {
    super(`layout-verbs: ${message}`)
    this.name = 'LayoutVerbError'
    this.code = code
    this.reason = reason
    this.detail = message
  }
}

// ── Tunables (the ranking rule's "short", "few", "many") ─────────────────────────────────────
export const SHORT_POINT_WORDS = 10
export const FEW_POINTS = { min: 3, max: 6 }
export const MANY_POINTS = 7
export const MAX_SUGGESTIONS = 6
/** A layout the content names outright (dates, times, numbers, a quotation, an image) outranks one that
 *  only fits its size: the size-shape branches score 100, these 120. */
const SPECIFIC = 120

// ── Locating the slide and its Trigger line ──────────────────────────────────────────────────

interface Located {
  read: OutlineSlides
  slide: OutlineSlide
  blockStart: number
  blockEnd: number
  /** The slide's canonical merged Trigger line (`logicalTriggerBlockAfterHeading().line`): the line
   *  the editor's ↵ reads and commits from. '' when the slide has none. */
  oldLine: string
  /** The block is not already that one canonical line (several lines, spaces between groups, several
   *  tokens in one group): any write replaces the block with the canonical line, as the editor does. */
  needsMerge: boolean
  /** The slide's line ending ('\r' for a CRLF heading line), kept on every line a verb writes. */
  eol: string
  /** The block's merge warnings (`logicalTriggerBlockAfterHeading().warnings`). */
  warnings: string[]
}

function locate(outline: string, ref: SlideRef): Located {
  return locateIn(readOutlineSlides(outline), ref)
}

/** `locate` over an outline already read (`read` = `readOutlineSlides(outline)`), for a caller that looks at many slides of one text. */
function locateIn(read: OutlineSlides, ref: SlideRef): Located {
  const slide = typeof ref === 'string'
    ? read.slides.find((candidate) => candidate.id === ref)
    : read.slides.find((candidate) => candidate.line === ref.headingLine)
  if (!slide) throw new LayoutVerbError('slide-not-found', `slide not found (${typeof ref === 'string' ? `id=${ref}` : `line ${ref.headingLine}`})`)
  // The block's canonical line keeps the id the shared resolver reads (slide-id.mjs: the heading's own,
  // else the LAST in the block) — the same id `readOutlineSlides` addresses the slide by — so a verb
  // never renames the slide, and says which ids it set aside.
  const block = logicalTriggerBlockAfterHeading(read.lines, slide.start)
  const oldLine = block?.line ?? ''
  const warnings = [...(block?.warnings ?? [])]
  const needsMerge = Boolean(block && (block.end > block.start + 1 || read.lines[block.start].replace(/\r$/, '') !== oldLine))
  const eol = /\r$/.test(read.lines[slide.start] ?? '') ? '\r' : ''
  return { read, slide, blockStart: block?.start ?? -1, blockEnd: block?.end ?? -1, oldLine, needsMerge, eol, warnings }
}

/**
 * The outline with the slide's Trigger block replaced by `newLine` — the same write the editor's ↵
 * makes (`planEditorTriggerCommit`): nothing when the line is unchanged and already canonical,
 * otherwise the whole block becomes the one line; a slide with no block gets it under the heading.
 */
function withTriggerLine(outline: string, at: Located, newLine: string): string {
  if (at.blockStart >= 0 ? newLine === at.oldLine && !at.needsMerge : !newLine) return outline
  const lines = [...at.read.lines]
  const cr = (index: number): string => (/\r$/.test(lines[index] ?? '') ? '\r' : '')
  if (at.blockStart >= 0) {
    // The line that replaces the block ends as the block's last line ended: the document's last
    // line has no line break, and must not be given half of one (a lone carriage return).
    lines.splice(at.blockStart, at.blockEnd - at.blockStart, newLine + cr(at.blockEnd - 1))
  } else if (at.slide.start + 1 < lines.length) {
    lines.splice(at.slide.start + 1, 0, newLine + at.eol)
  } else {
    // The heading is the document's last line and has no line break: it gets the document's own
    // (CRLF when the line above it ends in one), and the new last line gets none.
    const eol = at.slide.start > 0 ? cr(at.slide.start - 1) : ''
    lines[at.slide.start] += eol
    lines.push(newLine)
  }
  return lines.join('\n')
}

function entryNamed(layout: string): LayoutDef {
  const entry = typeof layout === 'string' ? LAYOUTS.find((candidate) => candidate.name === layout) : undefined
  if (!entry) throw new LayoutVerbError('unknown-layout', `unknown layout "${String(layout).slice(0, 80)}"`)
  return entry
}

// ── Reading a slide's content shape ──────────────────────────────────────────────────────────

interface Point { text: string; words: number; subs: number }
export interface SlideShape {
  level: number
  /** Top-level list items. */
  points: Point[]
  /** Paragraph lines outside any list, quotation or fence. */
  paragraphs: string[]
  /** Quotation lines (blockquote, or a paragraph wrapped in quotation marks). */
  quotes: number
  /** Blockquotes: runs of consecutive `>` lines, each one quotation however many lines it wraps. */
  quoteBlocks: number
  images: number
  videos: number
  links: number
  code: boolean
  /** Direct child headings (####-level slides under a ### slide). */
  childHeadings: number
  /** No content at all: a heading, maybe a Trigger line. */
  headingOnly: boolean
  /** The layout the Trigger line names, if any. */
  authoredLayout: string | null
}

const IMAGE_RE = /!\[[^\]]*\]\(([^)]*)\)/g
const VIDEO_REF_RE = /^vid-[0-9a-f]{7}$|\.(mp4|mov|webm|m4v)(\?.*)?$/i
const LIST_RE = /^(\s*)(?:[-*]\s+|\d+[.)]\s+)(.*)$/
const TRIGGER_ONLY_RE = /^\s*(?:\{[^}]*\}\s*)+$/
const QUOTE_WRAP_RE = /^["“‘'«].+["”’'»]$/

function cleanPoint(text: string): string {
  return text
    .replace(/\s*(?:\{[^}]*\}\s*)+$/, '')
    .replace(/[*_`]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
}

export function readSlideShape(outline: string, ref: SlideRef): SlideShape {
  const at = locate(outline, ref)
  return shapeOf(at)
}

function shapeOf(at: Located): SlideShape {
  const { read, slide } = at
  const from = at.blockEnd >= 0 ? at.blockEnd : slide.start + 1
  const points: Point[] = []
  const paragraphs: string[] = []
  let quotes = 0
  let quoteBlocks = 0
  let inQuote = false
  let images = 0
  let videos = 0
  let links = 0
  let code = false
  let fence = ''
  let last: Point | null = null
  for (let index = from; index < slide.end; index += 1) {
    if (read.notes.has(index)) continue
    const line = (read.blanked[index] ?? '').replace(/\r$/, '')
    const trimmed = line.trim()
    if (fence) {
      if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(trimmed)) fence = ''
      continue
    }
    const open = trimmed.match(/^(`{3,}|~{3,})/)
    if (open) { fence = open[1]; code = true; continue }
    if (!trimmed || TRIGGER_ONLY_RE.test(trimmed)) { inQuote = false; continue }
    if (/^#{1,6}\s/.test(trimmed)) continue
    if (!/^>/.test(trimmed)) inQuote = false
    for (const match of line.matchAll(IMAGE_RE)) {
      if (VIDEO_REF_RE.test(match[1].trim())) videos += 1
      else images += 1
    }
    const withoutImages = line.replace(IMAGE_RE, '').trim()
    links += (withoutImages.match(/\[[^\]]+\]\((?:https?:|mailto:)[^)]*\)|(?<![(\]])https?:\/\/\S+/g) ?? []).length
    const list = line.match(LIST_RE)
    if (list) {
      if (list[1].length === 0) {
        const text = cleanPoint(list[2])
        last = { text, words: text.split(/\s+/).filter(Boolean).length, subs: 0 }
        points.push(last)
      } else if (last) {
        last.subs += 1
      }
      continue
    }
    if (!withoutImages) continue
    if (/^>/.test(withoutImages)) {
      quotes += 1
      if (!inQuote) quoteBlocks += 1
      inQuote = true
      continue
    }
    if (QUOTE_WRAP_RE.test(withoutImages)) quotes += 1
    paragraphs.push(withoutImages)
    last = null
  }
  const level = slide.level
  // Direct children: the slides after this one, deeper than it, at the shallowest depth found.
  const descendants: OutlineSlide[] = []
  for (const next of read.slides) {
    if (next.start < slide.end) continue
    if (next.level <= level) break
    descendants.push(next)
  }
  const shallowest = descendants.length ? Math.min(...descendants.map((next) => next.level)) : 0
  const childHeadings = descendants.filter((next) => next.level === shallowest).length
  const hasBody = points.length > 0 || paragraphs.length > 0 || images + videos + links > 0 || code || quotes > 0
  const authored = winningAuthoredLayout(at.oldLine)?.layout ?? null
  return {
    level, points, paragraphs, quotes, quoteBlocks, images, videos, links, code, childHeadings,
    headingOnly: !hasBody && childHeadings === 0,
    authoredLayout: authored
  }
}

// ── Recognisers (heuristics; thresholds and word lists are tunable) ───────────────────────────

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const YEAR_OR_DATE_RE = new RegExp(
  `^\\(?(?:(?:1[5-9]|20)\\d{2}\\)?(?![\\d,.]*\\s*(?:%|million|billion|thousand))|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b|(?:${MONTHS})\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?(?:1[5-9]|20)\\d{2}\\b)`,
  'i'
)
/** A bare four-digit lead then a lower-case word, spaced or written on: a year ("1969 moon landing",
 *  "1960s"), a count ("1500 students") or a measurement ("1500 grams", "1500g"). Such a point needs more
 *  evidence before it counts as a date (see `allStartWithDates`). Group 2 is the space, if any. */
const BARE_NUMBER_LEAD_RE = /^\(?(\d{4})\)?(\s*)([a-z][a-z'-]*)/
/** Nouns that make a leading number a count, not a year. A heuristic list: extend it as needed. */
const COUNT_NOUNS = new Set((
  'students pupils people persons users members staff employees workers participants respondents visitors '
  + 'customers clients patients children adults teachers researchers academics authors readers attendees '
  + 'delegates copies downloads views words pages books papers articles items units cases responses '
  + 'votes signatures miles km kilometres kilometers metres meters feet hours minutes seconds days weeks '
  + 'months years times points dollars pounds euros tonnes tons litres liters calories steps rows lines'
  // Units and measurements (a weight, a volume, a distance, a power) are never years.
  + ' grams gram kilograms kilogram kg mg milligrams ml millilitres milliliters cl centilitres gallons pints'
  + ' ounces oz lb lbs stone mm cm centimetres centimeters millimetres millimeters inches yards metre meter'
  + ' mph kph rpm watts kw kwh mw volts amps degrees calorie kcal bytes kb mb gb tb hz khz mhz ghz pixels px'
).split(/\s+/))
function leadsWithDate(text: string): boolean {
  return YEAR_OR_DATE_RE.test(text)
}
/**
 * Every point starts with a year or a date. A point that leads with a bare four-digit number and a
 * lower-case word ("1969 moon landing" or "1500 students") counts only when that word is not a count
 * noun and these years are several, distinct and in order, either way (a chronology), so "- 1969 moon landing /
 * - 1989 fall of the Berlin Wall" is a Timeline and "- 1500 students" is not.
 */
function allStartWithDates(texts: readonly string[]): boolean {
  if (!texts.length || !texts.every(leadsWithDate)) return false
  const bareYears: number[] = []
  for (const text of texts) {
    const bare = text.match(BARE_NUMBER_LEAD_RE)
    if (!bare) continue
    const [, digits, space, word] = bare
    if (COUNT_NOUNS.has(word)) return false
    // Written straight on, only a decade ("1960s") still reads as a year; "1500g", "2000m" are units.
    if (!space && word !== 's') return false
    bareYears.push(Number(digits))
  }
  if (!bareYears.length) return true
  if (bareYears.length < 2) return false
  const rising = bareYears.every((year, index) => index === 0 || year > bareYears[index - 1])
  const falling = bareYears.every((year, index) => index === 0 || year < bareYears[index - 1])
  return rising || falling
}
const TIME_RE = /^\d{1,2}[:.]\d{2}\b/
const NUMBER_TOKEN = String.raw`[+-]?[£$€]?\d[\d,.]*`

/** `number: what it counts` — a short numeric lead (a number, maybe with a unit word) before the colon. */
function isNumberLabel(text: string): boolean {
  const colon = text.indexOf(':')
  if (colon <= 0) return false
  const lead = text.slice(0, colon).trim()
  return new RegExp(`^${NUMBER_TOKEN}\\s*(?:%|[A-Za-z]+)?$`).test(lead) && text.slice(colon + 1).trim().length > 0
}

/** `label: number` — the value after the last colon is a bare number (or a percentage). */
function labelNumber(text: string): number | null {
  const colon = text.lastIndexOf(':')
  if (colon <= 0) return null
  const value = text.slice(colon + 1).trim().replace(/[£$€,]/g, '').replace(/%$/, '')
  return /^[+-]?\d+(?:\.\d+)?$/.test(value) ? Number(value) : null
}

/** Base-form verbs an outline point commonly opens with. A heuristic (the mockup's rule says only
 *  "start with a verb"); extend the list rather than reach for a language model. */
const LEADING_VERBS = new Set((
  'add analyse analyze answer ask assess automate avoid book build buy calculate catalogue catalog change check choose clean '
  + 'close collect combine compare compile connect control convert copy count create cut decide define delete deliver describe '
  + 'design detect develop discover discuss draft draw drive edit email enable ensure establish estimate evaluate examine '
  + 'explain explore export extract fetch file find fix follow forecast format generate get give handle help identify import '
  + 'improve include install integrate inspect invite keep launch learn let link list load locate log look maintain make manage '
  + 'map measure merge monitor move name note offer open optimise optimize order organise organize outline pick plan post '
  + 'prepare present prioritise prioritize process produce publish pull push put query rank read record reduce refine remove '
  + 'rename repeat replace reply report request research reserve resolve review revise run save scan schedule search select '
  + 'send set share show sign simplify solve sort split start stop store submit summarise summarize support switch take talk '
  + 'teach test think track train transcribe transform translate trigger try tune turn type understand update upload use '
  + 'validate verify view visit watch write'
).split(/\s+/))

function startsWithVerb(text: string): boolean {
  const first = text.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? ''
  return LEADING_VERBS.has(first)
}

const KNOWN_SPEAKERS = new Set(['user', 'you', 'me', 'i', 'assistant', 'agent', 'ai', 'model', 'claude', 'chatgpt', 'gpt', 'codex', 'gemini', 'human', 'system', 'q', 'a'])

/** `Speaker: words` lines: a short name before a colon and words after it, the same name (or two
 *  known conversation roles) appearing more than once. */
function speakerLines(lines: string[]): boolean {
  const labels: string[] = []
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][\w'.-]*(?:\s[\w'.-]+)?):\s+(\S.*)$/)
    if (!match || labelNumber(line) !== null) return false
    labels.push(match[1].toLowerCase())
  }
  if (labels.length < 2) return false
  return new Set(labels).size < labels.length || labels.filter((label) => KNOWN_SPEAKERS.has(label)).length >= 2
}

const CHART_LAYOUTS = new Set(['chart', 'barchart', 'piechart', 'linechart', 'bar', 'pie', 'line'])
const DIAGRAM_LAYOUTS = new Set([
  'columns', 'pyramid', 'orgchart', 'mindmap', 'conceptmap', 'process', 'steps', 'iconrow', 'cycle', 'equation',
  'system-map', 'smartart', 'flow'
])

// ── can-take-layout ──────────────────────────────────────────────────────────────────────────

function pointLines(shape: SlideShape): string[] { return shape.points.map((point) => point.text) }

/** Why a layout cannot take a slide, in one line; null when it can. The needs are the ones the
 *  registry's when-it-fits copy states (hifi/when-it-fits.md, "Cannot take" column). */
function reasonWhyNot(entry: LayoutDef, shape: SlideShape): string | null {
  if (entry.sectionOnly && shape.level !== 2) return 'Needs a ## section heading'
  // A slide with no body yet takes any layout: the starter text (⌘↵) supplies the content it needs.
  if (shape.headingOnly) return null
  const points = pointLines(shape)
  const anyPicture = shape.images + shape.videos > 0
  switch (entry.name) {
    case 'quote':
      return shape.paragraphs.length + shape.quotes > 0 ? null : 'Needs a quotation written as a paragraph'
    case 'annotated':
      return shape.points.length > 0 && shape.points.every((point) => point.subs > 0) ? null : 'Needs a sub-point under each item'
    case 'media':
      return anyPicture || shape.links > 0 ? null : 'Needs an image, a video or a link'
    case 'compare':
      return shape.childHeadings >= 2 ? null : 'Needs two halves as #### headings'
    case 'columns':
      return shape.childHeadings >= 2 ? null : 'Needs #### group headings'
    case 'copy-visual':
    case 'image-claim':
      return shape.images > 0 ? null : 'Needs an image'
    case 'list-visual':
      return anyPicture ? null : 'Needs an image or a video'
    case 'cta-screenshots':
      return shape.images > 0 ? null : 'Needs screenshots'
    case 'image-grid':
      return shape.images > 0 ? null : 'Needs images'
    case 'image-quote':
      return shape.images > 0 && shape.paragraphs.length + shape.quotes > 0 ? null : 'Needs an image and a quotation'
    case 'conceptmap':
      return points.length > 0 && points.every((text) => /\s-+>?\s*\S|->|-[^-]+-/.test(text)) ? null : 'Needs links written as A -> B'
    case 'stats':
      return points.length > 0 && points.every(isNumberLabel) ? null : 'Needs points that start with a number'
    case 'timeline-visual':
      return points.length > 0 && shape.paragraphs.length > 0 ? null : 'Needs a comment paragraph after the list'
    case 'trace':
    case 'trace-dialogue':
      return speakerLines([...points, ...shape.paragraphs]) ? null : 'Needs lines written as Speaker: words'
    case 'chart':
    case 'barchart':
    case 'piechart':
    case 'linechart':
      return points.length > 0 && points.every((text) => labelNumber(text) !== null) ? null : 'Needs values written as label: number'
    case 'timetable':
      return points.length > 0 && points.every((text) => TIME_RE.test(text)) ? null : 'Needs times, written as 09:00 Welcome'
    case 'links':
      return shape.links > 0 ? null : 'Needs links'
    case 'novalues':
      return shape.authoredLayout && CHART_LAYOUTS.has(shape.authoredLayout) ? null : 'Only for charts'
    case 'multicolour':
      return shape.authoredLayout && DIAGRAM_LAYOUTS.has(shape.authoredLayout) ? null : 'Only for diagrams'
    default:
      // Not judged: the registry declares no content requirement for it (logolist's "product or
      // company names" is a reading of meaning, not a shape — left to the author).
      return null
  }
}

/** Whether `layout` can take the slide: yes, or a one-line reason (the greyed row's text). */
export function canTakeLayout(outline: string, slide: SlideRef, layout: string): CanTake {
  const entry = typeof layout === 'string' ? LAYOUTS.find((candidate) => candidate.name === layout) : undefined
  if (!entry) return { ok: false, reason: `No layout called "${String(layout).replace(/[\r\n{}]/g, ' ').slice(0, 80)}"` }
  const reason = reasonWhyNot(entry, shapeOf(locate(outline, slide)))
  return reason ? { ok: false, reason } : { ok: true }
}

/** `canTakeLayout` for every layout at once: the slide is read once (the picker greys rows from this). */
export function canTakeAllLayouts(outline: string, slide: SlideRef): Map<string, CanTake> {
  const shape = shapeOf(locate(outline, slide))
  const result = new Map<string, CanTake>()
  for (const entry of LAYOUTS) {
    const reason = reasonWhyNot(entry, shape)
    result.set(entry.name, reason ? { ok: false, reason } : { ok: true })
  }
  return result
}

// ── preview-layout / set-layout / set-layout-option ──────────────────────────────────────────

/** The most option choices one call may carry. */
const MAX_OPTION_CHOICES = 16

/** Validate an `options` argument's shape before anything reads it (it may come over IPC). */
function optionChoices(options: unknown): LayoutOptionChoice[] {
  if (options == null) return []
  if (!Array.isArray(options) || options.length > MAX_OPTION_CHOICES) {
    throw new LayoutVerbError('bad-option-token', 'options must be a short list of { group, token }')
  }
  return options.map((choice) => {
    const { group, token } = (choice ?? {}) as { group?: unknown; token?: unknown }
    if (typeof group !== 'string' || typeof token !== 'string') {
      throw new LayoutVerbError('bad-option-token', 'each option is { group: string, token: string }')
    }
    return { group, token }
  })
}

function applyOptionChoices(line: string, at: Located, outline: string, choices: readonly LayoutOptionChoice[], layoutName?: string): string {
  if (!choices.length) return line
  const context = deckCommitContext(outline, at.slide.line)
  let result = line
  for (const choice of choices) {
    const group = optionGroupNamed(choice.group, result, at, layoutName)
    // The token is checked against the registry's grammar for its group BEFORE it reaches the line:
    // a registry value, or a raw value the group owns that stays inside one `{…}` on one line.
    if (!isOptionTokenForGroup(choice.token, group) || !isOneTriggerToken(choice.token)) {
      throw new LayoutVerbError('bad-option-token', `"${choice.token.replace(/[\r\n]/g, '⏎').slice(0, 80)}" is not a value of ${group.key}`)
    }
    result = commitOptionSelection(result, group, choice.token, context)
  }
  return result
}

/** Characters no token may hold: control characters (CR, LF, VT, FF, tab …) and the Unicode line
 *  and paragraph separators (NEL U+0085, U+2028, U+2029), any of which an editor or a later reader
 *  may take as a line break, putting part of the token outside its Trigger line. */
const TOKEN_BREAK_RE = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/

/** A non-empty token must read back as exactly itself: one `{…}` group holding one token, with no
 *  line separator in it and its straight quotes balanced (an open quote would swallow what follows). */
function isOneTriggerToken(token: string): boolean {
  if (token === '') return true
  if (TOKEN_BREAK_RE.test(token)) return false
  if ((token.match(/"/g) ?? []).length % 2 !== 0) return false
  const parsed = parseTriggerLine(`{${token}}`)
  return parsed.length === 1 && parsed[0].source === token
}

/** The option group `key` as it applies to the layout on `line` for this slide. A group that exists
 *  but does not apply there (a Cards form on an Icons slide) is refused: writing it would put a
 *  second layout's token on the line. */
function optionGroupNamed(key: string, line: string, at: Located, inferredLayout?: string): OptionGroup {
  const layoutName = winningAuthoredLayout(line)?.layout ?? inferredLayout
  const applicable = optionGroupsForSlide({
    layoutName,
    headingLevel: at.slide.level,
    hasChildren: at.slide.opensSection || at.slide.container
  }).find(({ group }) => group.key === key)?.group
  if (applicable) return applicable
  if (registryOptionGroups().some((candidate) => candidate.key === key)) {
    throw new LayoutVerbError('option-not-applicable', `option group "${key}" does not apply to ${layoutName ? `the ${layoutName} layout` : 'this slide'}`)
  }
  throw new LayoutVerbError('unknown-option-group', `no option group "${String(key).slice(0, 80)}"`)
}

function planLayout(outline: string, ref: SlideRef, layout: string, options: unknown, given?: Located): { at: Located; newLine: string } {
  const entry = entryNamed(layout)
  const choices = optionChoices(options)
  const at = given ?? locate(outline, ref)
  const refusal = reasonWhyNot(entry, shapeOf(at))
  if (refusal) throw new LayoutVerbError('cannot-take', `${entry.label} cannot take this slide: ${refusal}`, refusal)
  // Read from the canonical merged line, exactly as the editor's ↵ does (`planEditorTriggerCommit`
  // over `commitLayoutSelection`), so `{icons} {id=a1}` and `{icons id=a1}` write what ↵ writes.
  const initial = selectionFromTriggerLine(at.oldLine, [...LAYOUTS])
  // Setting is idempotent: a modifier already on the line stays, where the picker's toggle would clear it.
  // Icon list and Numbered list are list styles: picked on a slide whose layout is something else (a
  // Cards slide), the layout token is swapped for List. `{cards}{numbered}` drew cards with no numbers,
  // so ⌘L's Icon list and Numbered list pictures came out the same.
  const listLayout = entry.kind === 'modifier' && entry.resolvesTo?.key === 'liststyle'
    ? initial.find((item) => item.kind === 'layout' && item.name !== 'list') && LAYOUTS.find((item) => item.name === 'list')
    : undefined
  const base = listLayout ? [listLayout, ...initial.filter((item) => item.kind !== 'layout')] : initial
  const selected = entry.kind !== 'layout' && base.some((item) => item.name === entry.name)
    ? base
    : toggleLayoutSelection(base, entry)
  const context = deckCommitContext(outline, at.slide.line)
  const chosen = commitLayoutSelection(at.oldLine, initial, selected, undefined, context)
  return { at, newLine: applyOptionChoices(chosen, at, outline, choices) }
}

/** The outline as it would read with `layout` (and `options`) on the slide. Writes nothing. */
export function previewLayout(outline: string, slide: SlideRef, layout: string, options: readonly LayoutOptionChoice[] = []): string {
  const { at, newLine } = planLayout(outline, slide, layout, options)
  return withTriggerLine(outline, at, newLine)
}

/** The starter text of a layout: the body of the first slide of its registry sample (ADR-0021 template). */
function starterBody(entry: LayoutDef): string[] {
  const sample = readOutlineSlides(entry.sample)
  const first = sample.slides[0]
  if (!first) return []
  const block = logicalTriggerBlockAfterHeading(sample.lines, first.start)
  const from = block ? block.end : first.start + 1
  return sample.lines.slice(from, first.end).join('\n').replace(/^\n+|\n+$/g, '').split('\n')
}

/** Set the layout: the new outline and the slide's new Trigger line. With `withStarterText`, a slide
 *  with no body also gets the layout's starter text (⌘↵ in the picker). */
export function setLayout(
  outline: string,
  slide: SlideRef,
  layout: string,
  options: readonly LayoutOptionChoice[] = [],
  withStarterText = false
): TriggerWrite {
  const { at, newLine } = planLayout(outline, slide, layout, options)
  let text = withTriggerLine(outline, at, newLine)
  if (withStarterText && shapeOf(at).headingOnly) {
    const body = starterBody(entryNamed(layout))
    if (body.length) {
      // Found again by its heading line, which the Trigger-line write does not move (the block sits
      // below the heading); an id could have been merged away, or be shared with another slide.
      const again = locate(text, { headingLine: at.slide.line })
      // Below the whole prelude the resolver reads (slide-id.mjs), not just the editor's Trigger block:
      // an id-only line past a blank is still the slide's id, and must not end up under the starter
      // text as content. Trailing blank lines of the prelude stay below the starter text.
      const prelude = preContentWindow(again.read.lines, again.slide.start, again.slide.end)
      let insertAt = Math.max(again.blockEnd, prelude.end, again.slide.start + 1)
      while (insertAt > again.slide.start + 1 && again.read.lines[insertAt - 1].replace(/\r$/, '').trim() === '') insertAt -= 1
      const lines = [...again.read.lines]
      // The starter lines take the slide's own line ending (a CRLF outline stays CRLF).
      lines.splice(insertAt, 0, ...['', ...body].map((line) => line + again.eol))
      text = lines.join('\n')
    }
  }
  return { outline: text, triggerLine: newLine, warnings: at.warnings }
}

// ── The margin menu's two verbs: choose one layout, back to Auto ─────────────────────────────
//
// Both read the slide through the compiler (plain-view-compiler-facts.ts `slideLayouts`): which
// tokens of the slide write a layout, in every form the compiler accepts, and which of them
// decides. They edit those tokens where they stand and then READ THE RESULT BACK THE SAME WAY
// before answering ok, as setHeadingIcon / setParagraphIcon do (12-outline-edit.mjs). A result
// that does not verify is not returned: the answer is ok:false with the text as it was.

/** Why the menu's verb wrote nothing. `layout-not-applied`: the edit was made but the slide would
 *  not compile to the chosen layout (a `triggers:` default of the talk decides it), so it is not written. */
export type LayoutMenuRefusal = LayoutVerbErrorCode | 'cannot-place-here' | 'layout-not-applied'

export type LayoutMenuWrite =
  | (TriggerWrite & { ok: true; /** The new outline (the same as `outline`). */ text: string })
  | { ok: false; /** The outline as it was given: nothing is written. */ text: string; outline: string; triggerLine: ''; warnings: string[]; reason: LayoutMenuRefusal; /** What a surface may show. */ detail: string }

const REFUSAL_DETAIL: Record<'cannot-place-here' | 'layout-not-applied', string> = {
  'cannot-place-here': 'The layout could not be changed here. Edit the layout line in Markdown.',
  'layout-not-applied': 'The slide would not get that layout: its content or this talk’s settings give it another.'
}

function refused(outline: string, reason: LayoutMenuRefusal, detail?: string): LayoutMenuWrite {
  return { ok: false, text: outline, outline, triggerLine: '', warnings: [], reason, detail: detail ?? REFUSAL_DETAIL[reason as 'cannot-place-here'] ?? REFUSAL_DETAIL['cannot-place-here'] }
}

interface TokenEdit { from: number; to: number; insert: string }

/** The edits that take `gone` off one line (and put `put` in place of `swap`), in the line's own characters. */
function lineEdits(onLine: readonly SlideToken[], gone: ReadonlySet<SlideToken>, swap: SlideToken | null, put: string, line: string): TokenEdit[] {
  const edits: TokenEdit[] = []
  const groups = new Map<number, SlideToken[]>()
  for (const token of onLine) {
    const list = groups.get(token.groupFrom)
    if (list) list.push(token); else groups.set(token.groupFrom, [token])
  }
  for (const [groupFrom, tokens] of groups) {
    const kept = tokens.filter((token) => !gone.has(token))
    if (!kept.length) {
      // The whole group goes, with the space that set it apart: after it when it opens the line, before it otherwise.
      let from = groupFrom
      let to = tokens[0].groupTo
      if (line.slice(0, from).trim() === '') { while (to < line.length && /[ \t]/.test(line[to])) to += 1 } else { while (from > 0 && /[ \t]/.test(line[from - 1])) from -= 1 }
      edits.push({ from, to, insert: '' })
      continue
    }
    tokens.forEach((token, index) => {
      if (token === swap) { edits.push({ from: token.from, to: token.to, insert: put }); return }
      if (!gone.has(token)) return
      // A token goes with the separator after it; the last of its group, with the one before it.
      const next = tokens[index + 1]
      if (next) edits.push({ from: token.from, to: next.from, insert: '' })
      else edits.push({ from: tokens[index - 1].to, to: token.to, insert: '' })
    })
  }
  // Removing two neighbours makes ranges that touch or overlap: joined, right to left.
  edits.sort((a, b) => a.from - b.from)
  const joined: TokenEdit[] = []
  for (const edit of edits) {
    const prev = joined[joined.length - 1]
    if (prev && edit.from < prev.to) { prev.to = Math.max(prev.to, edit.to); prev.insert += edit.insert } else joined.push({ ...edit })
  }
  return joined
}

/**
 * The outline with the slide's layout-writing tokens edited in place: every one of them removed,
 * except `swap`, which becomes `put`. A layout line left with no token is removed with its line
 * break; nothing else of the text is touched.
 */
function editLayoutTokens(outline: string, slide: SlideLayoutFacts, swap: SlideToken | null, put: string): string {
  const lines = outline.split('\n')
  const gone = new Set(slide.tokens.filter((token) => token.writesLayout && token !== swap))
  const byLine = new Map<number, SlideToken[]>()
  for (const token of slide.tokens) {
    const list = byLine.get(token.line)
    if (list) list.push(token); else byLine.set(token.line, [token])
  }
  const dropped: number[] = []
  for (const [index, tokens] of byLine) {
    if (!tokens.some((token) => gone.has(token) || token === swap)) continue
    const written = lines[index]
    const cr = written.endsWith('\r') ? '\r' : ''
    let body = cr ? written.slice(0, -1) : written
    for (const edit of lineEdits(tokens, gone, swap, put, body).reverse()) body = body.slice(0, edit.from) + edit.insert + body.slice(edit.to)
    // A layout line (never the heading) with no token left on it goes.
    if (!tokens[0].onHeading && !tokens.some((token) => !gone.has(token)) && body.replace(/\{\s*\}/g, '').trim() === '') dropped.push(index)
    else lines[index] = (tokens[0].onHeading ? body.trimEnd() : body) + cr
  }
  // A removed line goes with its own line break. The document's last line has none, so it goes with
  // the one before it: all of it, a CRLF's carriage return too. (Left behind, that `\r` ended the
  // text as a lone carriage return, a line ending the document never had.)
  const lastGone = dropped.includes(lines.length - 1)
  for (const index of dropped.sort((a, b) => b - a)) lines.splice(index, 1)
  if (lastGone && lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/\r$/, '')
  return lines.join('\n')
}

const tokenSources = (slide: SlideLayoutFacts): string => JSON.stringify(slide.tokens.filter((token) => !token.writesLayout).map((token) => token.source).sort())

/**
 * The check both verbs pass before they answer ok: the result read back through the compiler.
 *   - the slide is still there, on the same heading line, and reads token by token as the compiler reads it;
 *   - `entry` chosen: it holds exactly one layout-writing token, and the layout the compiler draws
 *     the slide in (tokens, content, the divider default, chart-only, cards, the talk's defaults:
 *     `final`) is the entry's; for a list style, a list the slide holds, drawn in that style.
 *     Auto: it holds none;
 *   - every other token of its heading and layout lines is still there, as written;
 *   - its title, content lines and notes are the same;
 *   - every other slide, the talk title and the front matter read the same, and the text outside
 *     the slide's own lines is the same byte for byte.
 * Returns the reason it fails, or null.
 */
function verifyLayoutWrite(before: string, beforeFacts: CompilerFacts, was: SlideLayoutFacts, after: string, entry: LayoutDef | null): LayoutMenuRefusal | null {
  let facts: CompilerFacts
  // (Kept by its text: the editor reads the same facts when the result becomes its document.)
  try { facts = compilerFactsOf(after) } catch { return 'cannot-place-here' }
  const now = facts.slideLayouts.get(was.headingLine)
  if (!now || !now.consistent || facts.slideLayouts.size !== beforeFacts.slideLayouts.size) return 'cannot-place-here'
  const writing = now.tokens.filter((token) => token.writesLayout)
  if (writing.length !== (entry ? 1 : 0)) return 'cannot-place-here'
  if (tokenSources(now) !== tokenSources(was)) return 'cannot-place-here'
  if (facts.slideContent(was.headingLine) !== beforeFacts.slideContent(was.headingLine)) return 'cannot-place-here'
  if (facts.outsideSlide(was.headingLine) !== beforeFacts.outsideSlide(was.headingLine)) return 'cannot-place-here'
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.slice(0, was.headingLine).join('\n') !== b.slice(0, now.headingLine).join('\n')) return 'cannot-place-here'
  if (a.slice(was.endLine).join('\n') !== b.slice(now.endLine).join('\n')) return 'cannot-place-here'
  if (entry) {
    const written = authoredLayoutOf(now)
    const wanted = layoutDecisionOfEntry(entry)
    const same = (wanted?.layout ?? null) === (now.decision?.layout ?? null)
      // A list style leaves the layout to the list itself: an explicit {list} beside it is the same slide.
      || (wanted === null && now.decision?.layout === 'list')
    if (written?.entry !== entry || !same || !writesEntryTrigger(entry, writing)) return 'layout-not-applied'
    // A slide made only of chart objects is drawn as a chart whatever its tokens name (authored-layout.mjs isChartOnlySlide).
    if (now.chartOnly && now.decision?.layout !== 'chart') return 'layout-not-applied'
    // A heading the compiler keeps as a section divider is drawn as one whatever its tokens name
    // (authored-layout.mjs sectionDividerDecision: child headings the layout was refused, an empty body).
    if (now.divider && now.decision?.layout !== 'section-title') return 'layout-not-applied'
    // The tokens are right. What counts is the layout the compiler DRAWS the slide in (`final`,
    // the compiler's own functions over the edited text): it is the chosen one, or nothing is written.
    if (!isDrawnAs(now, entry)) return listStyleWithoutList(now, entry) ? 'cannot-take' : 'layout-not-applied'
  } else if (now.authored) return 'cannot-place-here'
  return null
}

/**
 * The guard round both verbs: whatever goes wrong while reading or checking (the compiler's reading
 * throws, as its lexer does rather than stand on one line for ever), the answer is ok:false with the
 * text as it was. No verb loops on its own: each makes one edit and one check.
 */
function menuWrite(outline: string, ref: SlideRef, entry: LayoutDef | null): LayoutMenuWrite {
  try { return menuWriteChecked(outline, ref, entry) } catch { return refused(outline, 'cannot-place-here') }
}

function menuWriteChecked(outline: string, ref: SlideRef, entry: LayoutDef | null): LayoutMenuWrite {
  let at: Located
  let facts: CompilerFacts
  try { at = locate(outline, ref) } catch (error) {
    if (error instanceof LayoutVerbError) return refused(outline, error.code, error.detail)
    throw error
  }
  // The facts of the text as it is: the ones the editor and the margin already have for it (memo-by-text.ts).
  try { facts = compilerFactsOf(outline) } catch { return refused(outline, 'cannot-place-here') }
  const slide = facts.slideLayouts.get(at.slide.start)
  if (!slide) return refused(outline, 'slide-not-found', `slide not found (line ${at.slide.line})`)
  if (entry) {
    const refusal = reasonWhyNot(entry, shapeOf(at))
    if (refusal) return refused(outline, 'cannot-take', `${entry.label} cannot take this slide: ${refusal}`)
  }
  if (!slide.consistent) return refused(outline, 'cannot-place-here')
  const writing = slide.tokens.filter((token) => token.writesLayout)
  // A layout written on a line partly inside a comment is not edited: the compiler reads other characters than are written.
  if (writing.some((token) => !token.readWhole)) return refused(outline, 'cannot-place-here', 'The layout is written on a line that is partly inside a comment. Edit it in Markdown.')
  let text: string
  let warnings: string[] = []
  if (!writing.length) {
    if (!entry) return { ok: true, text: outline, outline, triggerLine: at.oldLine, warnings: at.warnings }
    // No layout written: the Trigger line is written as the picker writes it.
    try {
      const write = setLayout(outline, { headingLine: at.slide.line }, entry.name)
      text = write.outline
      warnings = write.warnings
    } catch (error) {
      if (error instanceof LayoutVerbError) return refused(outline, error.code, error.detail)
      throw error
    }
  } else if (entry && writing.length === 1 && authoredLayoutOf(slide)?.entry === entry && writesEntryTrigger(entry, writing)) {
    // Already that layout, written once in a form that means the entry's own trigger: nothing to
    // change (the author's alias stays). A variant of it ({cards=stepped}) is replaced like any other.
    text = outline
  } else {
    // The token that decides is replaced where it is; the slide's other layout-writing tokens go.
    const swap = entry ? slide.winner ?? writing[0] : null
    text = editLayoutTokens(outline, slide, swap, entry ? entryTriggerBody(entry) : '')
  }
  const failure = verifyLayoutWrite(outline, facts, slide, text, entry)
  if (failure === 'cannot-take' && entry) return refused(outline, failure, `${entry.label} cannot take this slide: Needs a list`)
  if (failure) return refused(outline, failure)
  let triggerLine = ''
  try { triggerLine = locate(text, { headingLine: at.slide.line }).oldLine } catch { /* the line is only reported */ }
  return { ok: true, text, outline: text, triggerLine, warnings }
}

/**
 * Back to Auto: every token of the slide that writes a layout is removed where it stands (a layout
 * token in any form the compiler accepts, a list style acting as the layout); `{id=…}` and every
 * other token stay. A layout line left with nothing on it is removed. The front matter is never
 * touched. Verified by reading the result back through the compiler; ok:false writes nothing.
 */
export function clearLayout(outline: string, slide: SlideRef): LayoutMenuWrite {
  return menuWrite(outline, slide, null)
}

/**
 * A single choice among layouts, as the margin's layout menu makes it: the slide ends up with the
 * one layout, written once. The token that decides the slide's layout today is replaced where it
 * is (the heading line, the Trigger block, a layout line further down the slide); the slide's other
 * layout-writing tokens are removed; a slide that writes none gets its Trigger line as the picker
 * writes it. Verified by reading the result back through the compiler; ok:false writes nothing.
 */
export function chooseLayout(outline: string, slide: SlideRef, layout: string): LayoutMenuWrite {
  const entry = typeof layout === 'string' ? LAYOUTS.find((candidate) => candidate.name === layout) : undefined
  if (!entry) return refused(outline, 'unknown-layout', `unknown layout "${String(layout).replace(/[\r\n{}]/g, ' ').slice(0, 80)}"`)
  // A modifier, a container or a component is not a layout: the compiler would not read its trigger as one.
  if (!isSettableLayout(entry)) return refused(outline, 'layout-not-applied', `${entry.label} is not a layout a slide can be given from this menu.`)
  return menuWrite(outline, slide, entry)
}

/** Set one option of the slide's layout (an Inspector option picture, a picker chip). */
export function setLayoutOption(outline: string, slide: SlideRef, group: string, value: string): TriggerWrite {
  const [choice] = optionChoices([{ group, token: value }])
  const at = locate(outline, slide)
  const newLine = applyOptionChoices(at.oldLine, at, outline, [choice])
  const text = withTriggerLine(outline, at, newLine)
  return { outline: text, triggerLine: newLine, warnings: at.warnings }
}

// ── Quote forms (docs/design/2026-10-11-source-styled-quote-slides, spec 11) ─────────────────

export type QuoteFormChoice = 'auto' | QuoteFormName

/** What `describe-quote-source` says about one quote slide: the form it shows, whether the author chose
 *  it, what found it, and what the source line yielded. The Inspector's notes are this result. */
export interface QuoteSourceDescription {
  form: QuoteFormName
  chosen: boolean
  detectedBy: QuoteFormDetectedBy
  /** The site of an ordinary web link in the source line, whatever the form; null when there is none. */
  webLink: string | null
  /** The source line holds a DOI, whatever the form. */
  doiLink: boolean
  picture: boolean
  /** How the slide is drawn: a form's presentation, or `plain` (Plain, an unbuilt form, a refused form). */
  presentation: QuoteFormPresentation
  fields: Record<string, unknown>
  missing: string[]
  fits: boolean
  // Beyond the spec's table, for the notes the Inspector draws:
  /** The `form=` value as written: '' for none (Automatic), else `auto`, `plain`, `tweet`… */
  token: string
  /** The form has no renderer yet, so the slide is drawn as Plain (spec "until tickets 02–04 and 07 land"). */
  unbuilt: boolean
  /** The slide has no quoted words yet. */
  awaitingWords: boolean
  /** The form refused: its words do not fit the smallest step, so the slide is drawn as Plain. */
  refused: boolean
  /** The slide holds more than one quotation, so no form is applied and it is drawn as Plain. */
  several: boolean
  /** Something else paints on the slide beside the quotation (a list, paragraph, table...), so it is drawn as Plain. */
  otherContent: boolean
}

const QUOTE_FORM_TOKEN: Record<QuoteFormChoice, string> = {
  auto: '',
  plain: 'form=plain',
  tweet: 'form=tweet',
  video: 'form=video',
  book: 'form=book',
  paper: 'form=paper',
  web: 'form=web'
}

/**
 * A quote slide's body as the compiler reads it: the slide's lines after its Trigger block (comments blank), less
 *   - every speaker-notes line (`:::notes` to `:::`, the markers included): the compiler's tree parse routes those
 *     away from the slide's content (`read.notes` is that parse's own list, 14-outline-tree.mjs), so they are dropped
 *     here, not blanked: the lines either side of a notes block stand next to each other, as they do there, and a
 *     notes block is never the blank line that ends a paragraph;
 *   - every line the compiler folds into the slide's attributes as a Trigger line (a `{form=web}` or `{reveal}` line
 *     among the content), decided by the compiler's own `contentTriggerLines` on the lines the notes left.
 * `at[i]` is the outline line `lines[i]` stands on, so a write lands on the line as written and never on a notes
 * line or a folded one.
 */
interface QuoteBody {
  lines: string[]
  /** The outline line index of each of `lines`. */
  at: number[]
  /** The outline line just past `lines[i - 1]` (the first body line for 0): where a line written after it goes. */
  after: (i: number) => number
  /** What the folded lines set, later lines over earlier: these win over the slide's layout line in the compiler. */
  folded: Record<string, unknown>
}

function quoteBody(at: Located): QuoteBody {
  const from = at.blockEnd >= 0 ? at.blockEnd : at.slide.start + 1
  const content: number[] = []
  for (let index = from; index < at.slide.end; index += 1) if (!at.read.notes.has(index)) content.push(index)
  const all = content.map((index) => at.read.blanked[index] ?? '')
  const folded = contentTriggerLines(all.map((line) => line.replace(/\r$/, '')))
  const lines: string[] = []
  const where: number[] = []
  const attrs: Record<string, unknown> = {}
  for (let index = 0; index < all.length; index += 1) {
    const stray = folded[index]
    if (stray) {
      Object.assign(attrs, stray.attrs)
      continue
    }
    lines.push(all[index])
    where.push(content[index])
  }
  return { lines, at: where, after: (i) => (i > 0 ? where[i - 1] + 1 : from), folded: attrs }
}

/**
 * Refuses a slide the compiler does not draw with the quote layout; otherwise returns its cleaned title.
 * The layout is the authored one (a `{quote}` token, or any other layout token, which wins) or, when the Trigger
 * line names none, `compiledLayout`: the layout the compiler gave the compiled slide (its `inferLayout`, which
 * makes a quote-only slide a quote slide). The compiler's inference reads the icon catalogue and the markdown
 * lexer and cannot run in the editor, so the caller that has the compiled slide (a projection row's `layout`) passes it.
 */
function requireQuoteSlide(at: Located, compiledLayout?: string): string {
  const layout = winningAuthoredLayout(at.oldLine)?.layout ?? compiledLayout ?? null
  if (layout !== 'quote') throw new LayoutVerbError('option-not-applicable', 'the slide is not a quote slide')
  // The slide title as the compiler reads it: the heading less its `{…}` tokens.
  return parseHeadingAttrs((at.read.lines[at.slide.start] ?? '').replace(/\r$/, '').replace(/^#{1,6}\s+/, '')).title
}

/** Is the slide at this heading a quote slide (an authored `quote` layout, or none authored and the compiled slide is `compiledLayout` quote)? False for any slide that cannot be found. */
export function isQuoteSlide(outline: string, slide: SlideRef, compiledLayout?: string): boolean {
  try {
    requireQuoteSlide(locate(outline, slide), compiledLayout)
    return true
  } catch {
    return false
  }
}

/** The `form=` value on the slide's Trigger line, lower-cased; '' when there is none. */
function quoteFormToken(oldLine: string): string {
  const token = parseTriggerLine(oldLine).find((candidate) => /^form=/i.test(candidate.raw))
  return token ? token.raw.slice('form='.length).trim().toLowerCase() : ''
}

/**
 * The slide's `form=` value as the compiler resolves it, lower-cased ('' when there is none): the slide's own token,
 * else the one the talk's frontmatter `triggers:` gives every slide. Resolved by the compiler's own code
 * (`slideEffectiveAttrs`), so whatever a verb decides from "the form is set" is what the compiler draws: a slide that
 * inherits `form=web` reads the address under its quotation as the source line, as one with its own token does.
 */
function effectiveQuoteForm(at: Located): string {
  return String(slideEffectiveAttrs(at.read, at.slide).form ?? '').trim().toLowerCase()
}

/** What the slide's quote shows and why (spec 11 `describe-quote-source`). A read: nothing is written. `token` is the
 *  slide's own; the form, its fields and the reading of the slide's lines follow the form in effect (an inherited one included). */
export function describeQuoteSource(outline: string, slide: SlideRef, compiledLayout?: string): QuoteSourceDescription {
  const at = locate(outline, slide)
  const title = requireQuoteSlide(at, compiledLayout)
  const token = quoteFormToken(at.oldLine)
  const inEffect = effectiveQuoteForm(at)
  // With a form set, the address on its own line under the quotation is the source line (ticket 10), as the compiler reads it.
  const bodyLines = quoteBody(at).lines
  const body = readQuoteSlideLines(bodyLines, inEffect)
  // A quotation with no source line takes the slide title as its citation before the form is decided, through
  // the compiler's own `applyQuoteTitleAttribution`, so the title can decide the form here as it does there.
  const quote = { type: 'quote', cite: body.cite }
  if (body.hasQuote) applyQuoteTitleAttribution([quote], title)
  const plan = quoteFormPlan({ token: inEffect, cite: quote.cite, paragraphs: body.paragraphs, picture: body.picture })
  // Several quotations, or other painting content beside the one: the slide is drawn as Plain, whatever the quote would take.
  const multiple = countQuoteBlocks(bodyLines) > 1
  return {
    form: plan.form,
    chosen: plan.chosen,
    detectedBy: plan.detectedBy,
    webLink: plan.webLink,
    doiLink: plan.doiLink,
    picture: plan.picture,
    presentation: multiple || body.otherContent ? 'plain' : plan.presentation,
    fields: plan.fields,
    missing: plan.fields.missing,
    fits: plan.fits,
    token,
    unbuilt: plan.form !== 'plain' && !plan.built,
    awaitingWords: plan.awaiting,
    refused: plan.refused,
    several: multiple,
    otherContent: body.otherContent
  }
}

/** Set the quote form (spec 11 `set-quote-form`): a thin name over `set-layout-option(slide, 'quote-form', token)`.
 *  `auto` removes the token. It never sets a form by itself. `compiledLayout` is the layout the compiled slide has
 *  (see `requireQuoteSlide`); it admits a quote-only slide that has no `{quote}` token. */
export function setQuoteForm(outline: string, slide: SlideRef, form: QuoteFormChoice, compiledLayout?: string): TriggerWrite {
  if (!(form in QUOTE_FORM_TOKEN)) throw new LayoutVerbError('bad-option-token', `unknown quote form "${String(form).slice(0, 40)}"`)
  const at = locate(outline, slide)
  if (winningAuthoredLayout(at.oldLine)) return setLayoutOption(outline, slide, 'quote-form', QUOTE_FORM_TOKEN[form])
  // No layout token: the slide is a quote slide because its content says so (a quotation and nothing else). A lone
  // `{form=…}` leaves that inference alone (a `form` attribute implies no layout), so it is all the line needs, and
  // Automatic removes it again; a line left empty goes with its block, so the outline returns byte for byte.
  requireQuoteSlide(at, compiledLayout)
  const [choice] = optionChoices([{ group: 'quote-form', token: QUOTE_FORM_TOKEN[form] }])
  const newLine = applyOptionChoices(at.oldLine, at, outline, [choice], 'quote')
  if (newLine === '' && at.blockStart >= 0) {
    const lines = [...at.read.lines]
    lines.splice(at.blockStart, at.blockEnd - at.blockStart)
    return { outline: lines.join('\n'), triggerLine: newLine, warnings: at.warnings }
  }
  return { outline: withTriggerLine(outline, at, newLine), triggerLine: newLine, warnings: at.warnings }
}

// ── The web and paper forms on a link edit (spec 3.1, 12; tickets 07 and the 2026-10-12 paper check) ──

export interface LinkFormWrite {
  /** The outline after the edit, with `form=web` or `form=paper` written when the rule held. */
  outline: string
  /** A form token was written by this call. */
  set: boolean
  /** Which one: `web` for an ordinary web link, `paper` for a DOI; null when nothing was written. */
  form: 'web' | 'paper' | null
}

/** The first link of the slide's source line, or the address on its own line under the quotation when that stands in
 *  its place ('' when there is neither or the slide cannot be read). */
function sourceLinkAt(outline: string, ref: SlideRef): string {
  return sourceLinkIn(readOutlineSlides(outline), ref)
}

/** `sourceLinkAt` over an outline already read. */
function sourceLinkIn(read: OutlineSlides, ref: SlideRef): string {
  try {
    const at = locateIn(read, ref)
    const body = readQuoteSlideLines(quoteBody(at).lines)
    return parseSourceLine(body.address?.url ?? body.cite).link?.url ?? ''
  } catch (error) {
    if (error instanceof LayoutVerbError) return ''
    throw error
  }
}

/**
 * The one rule that makes a quote a web page or a paper (spec 3.1): a pure function over the outline before and after an
 * edit. When the edit added or changed the link in the source line of a quote slide, and the slide's form is Automatic
 * (no `form=` token, or `form=auto`) and would otherwise show as Plain (a tweet, a video or a book keeps its form; several
 * quotations or other content beside the quote keep the slide plain), the form follows the link: an ordinary web link
 * (not X or YouTube) writes `form=web`, a DOI writes `form=paper`, into the layout line of `after` (replacing `form=auto`).
 * Editing anything else on a slide that already has a link sets nothing, and a form the author chose is never overridden.
 * A web address on a line of its own directly under the one quotation, on a slide with no source line and nothing else
 * beside the quotation, counts as that link (ticket 10): the same token is written and the address line is left as typed.
 * No network and no setting is involved. The editor calls it at the paste and caret-leave triggers inside the same
 * transaction as the link edit, so one undo takes both back; `set-quote-source` calls it with the outline it is about to return.
 * `slideBefore` names the slide in `before` when it is addressed differently there (a heading line).
 */
export function setFormOnLinkEdit(before: string, after: string, slide: SlideRef, compiledLayout?: string, slideBefore: SlideRef = slide): LinkFormWrite {
  return formOnLinkEdit(after, readOutlineSlides(after), slide, compiledLayout, () => sourceLinkAt(before, slideBefore))
}

/**
 * `setFormOnLinkEdit` with its two readings handed in: `readAfter` is `readOutlineSlides(after)`, and `linkBefore()` is the
 * slide's source link before the edit (asked only once the slide is an Automatic quote with a link). `setFormOnLinkEdits`
 * reads each text once for all its slides through this.
 */
function formOnLinkEdit(after: string, readAfter: OutlineSlides, slide: SlideRef, compiledLayout: string | undefined, linkBefore: () => string): LinkFormWrite {
  const unchanged: LinkFormWrite = { outline: after, set: false, form: null }
  let at: Located
  let body: ReturnType<typeof readQuoteSlideLines>
  let bodyLines: string[]
  let read: QuoteBody
  // The layout the slide has once the form is written. A quotation with an address under it and no layout token is
  // compiled as `copy-visual` (the address is an embed card beside the quote) until it has a form, and as a quote
  // slide from then on (the compiler reads the address as the source line), so that reading counts as a quote slide here.
  // Only when the quotation and the address are all the slide holds: with a picture the `copy-visual` may be the
  // picture's, and a video or an audio file in image syntax is other content, so there is no address to read
  // (`readQuoteSlideLines` classifies those lines by the lexer's own rule, as the compiler does).
  let layout = compiledLayout
  // The slide names no layout and the caller's compiled layout does not make it a quote slide: not decided yet (below).
  let undecided = false
  try {
    at = locateIn(readAfter, slide)
    // The body as the compiler reads it: a Trigger line among the content is folded away, so an address under the
    // quotation with only such a line between is directly under it, there and here. What a folded line sets wins over
    // the layout line, where the form is written: a folded `form=` (`form=auto` too) would undo the token, and a folded
    // layout other than `quote` makes the slide that layout whatever is written, so nothing is written for either.
    read = quoteBody(at)
    if ('form' in read.folded || (read.folded.layout != null && read.folded.layout !== 'quote')) return unchanged
    bodyLines = read.lines
    body = readQuoteSlideLines(bodyLines)
    if (compiledLayout === 'copy-visual' && body.address && !body.picture) layout = 'quote'
    undecided = layout !== 'quote' && winningAuthoredLayout(at.oldLine) == null
    if (!undecided) requireQuoteSlide(at, layout)
  } catch (error) {
    if (error instanceof LayoutVerbError) return unchanged
    throw error
  }
  // Automatic only: no form on the slide, and none in effect from the talk's `triggers:` either. A slide that inherits
  // a form is already drawn in it, so a token written here would repeat it or override it; nothing is written.
  const token = quoteFormToken(at.oldLine)
  const inEffect = effectiveQuoteForm(at)
  if ((token !== '' && token !== 'auto') || (inEffect !== '' && inEffect !== 'auto')) return unchanged
  // The address under the quotation stands as the source line; anything else beside the quotation keeps the slide plain.
  if ((body.otherContent && !body.address) || countQuoteBlocks(bodyLines) > 1) return unchanged
  const cite = body.address?.url ?? body.cite
  const link = parseSourceLine(cite).link?.url ?? ''
  if (!link || link === linkBefore()) return unchanged
  const plan = quoteFormPlan({ token: '', cite, paragraphs: body.paragraphs, picture: body.picture })
  if (plan.form !== 'plain') return unchanged
  const form = plan.webLink != null ? 'web' : plan.doiLink ? 'paper' : null
  if (!form) return unchanged
  // The outline with the link's line taken out: what the slide says without the link.
  const withoutLink = withoutSourceLink(at, read, body, cite)
  if (withoutLink == null) return unchanged
  // The caller's compiled layout is the last compile's, looked up by heading line: for a slide typed a moment ago it
  // is not there yet (undefined), or is the layout of the slide that stood on that line before (the editor's compile
  // waits for a pause in the typing). So where it does not make this a quote slide, the compiler is asked directly:
  // its own reading of this slide in `after` (quote-write-check.ts) gives the layout, taken exactly as a compiled
  // layout is above. Asked only here, once the slide's link is known to have changed, never for an edit that changed
  // no link. A slide that cannot be read is not written. A caller's layout that does make it a quote slide is used
  // as it is; the check by compiling below stops a wrong one either way.
  if (undecided) {
    const inferred = compiledQuoteAt(after, at.slide.line)?.layout
    layout = inferred === 'copy-visual' && body.address && !body.picture ? 'quote' : inferred
    if (layout !== 'quote') return unchanged
  }
  // A slide with no quotation is its source line alone. When it reads as a quotation once the link's line is gone,
  // the link was typed against a quoted paragraph (no blank line between, as the compiler reads them: one paragraph),
  // so there is no quotation with its source here and no source line alone either: nothing is written.
  if (!body.hasQuote && readQuoteSlideLines(withoutLink.body).hasQuote) return unchanged
  const written = setQuoteForm(after, slide, form, layout)
  if (written.outline === after) return unchanged
  // The final check, by compiling (quote-write-check.ts): whatever was read above, the form is not written when the
  // compiler, read on this slide, does not draw it here, cite this link and keep the quotation's words (a slide folded
  // into another, a carousel and a poll's frame draw no form). Where the compiler's reading cannot be made at all,
  // the decision above stands. It asks no layout callback.
  if (!quoteFormWriteHolds({ headingLine: at.slide.line, written: written.outline, withoutToken: after, withoutLink: withoutLink.outline, form, link, quotation: body.hasQuote })) return unchanged
  return { outline: written.outline, set: true, form }
}

/**
 * The outline with the slide's source link taken out, line for line as written: the address line under the
 * quotation, the source line (a bullet, a dash line, the `> - ` line of the block), each line of a source paragraph
 * that holds the link, or, for a source that follows a quoted paragraph on its own line, that line cut back to the
 * words. `body` is the slide's body lines (`read.lines`) with the same lines taken out. Null when the link stands on
 * no line that can be named (nothing is written then).
 */
function withoutSourceLink(at: Located, read: QuoteBody, body: ReturnType<typeof readQuoteSlideLines>, cite: string): { outline: string; body: string[] } | null {
  const lines = [...at.read.lines]
  const bodyLines = [...read.lines]
  const drop = (indexes: number[]): { outline: string; body: string[] } => {
    for (const index of [...indexes].sort((a, b) => b - a)) {
      lines.splice(read.at[index], 1)
      bodyLines.splice(index, 1)
    }
    return { outline: lines.join('\n'), body: bodyLines }
  }
  if (body.address) return drop([body.address.index])
  const source = body.source
  if (!source) return null
  if (source.kind === 'promoted-tail') {
    const raw = lines[read.at[source.index]]
    const words = source.prefix.trimEnd()
    const rest: number[] = []
    for (let index = source.index + 1; index <= source.endIndex; index += 1) rest.push(index)
    if (!words) return drop([source.index, ...rest])
    lines[read.at[source.index]] = `${words}${raw.endsWith('\r') ? '\r' : ''}`
    bodyLines[source.index] = words
    return drop(rest)
  }
  if (source.kind !== 'bare') return drop([source.index])
  const span = sourceLinkSpan(cite)
  const link = span ? cite.slice(span.index, span.index + span.length) : ''
  const holding: number[] = []
  for (let index = source.index; index <= source.endIndex; index += 1) if (link && read.lines[index].includes(link)) holding.push(index)
  return holding.length ? drop(holding) : null
}

/** The slides of a read outline as `locate` finds them: the first with an id ('' included: the first slide with none), the
 *  first on a heading line. */
interface SlideLookup {
  byId: Map<string, OutlineSlide>
  byLine: Map<number, OutlineSlide>
}

function slideLookup(read: OutlineSlides): SlideLookup {
  const byId = new Map<string, OutlineSlide>()
  const byLine = new Map<number, OutlineSlide>()
  for (const slide of read.slides) {
    if (!byId.has(slide.id)) byId.set(slide.id, slide)
    if (!byLine.has(slide.line)) byLine.set(slide.line, slide)
  }
  return { byId, byLine }
}

/** The slide `locate` would find for `ref` in the outline the lookup was made from. */
function slideIn(lookup: SlideLookup, ref: SlideRef): OutlineSlide | undefined {
  return typeof ref === 'string' ? lookup.byId.get(ref) : lookup.byLine.get(ref.headingLine)
}

/**
 * Do two located slides read the same, line for line: the text, the text as the compiler reads it (frontmatter and
 * comments blanked) and which lines are speaker notes, over the slide's own block and the one line that ends it (the
 * next heading, or the end of the text: the furthest a Trigger-block reader looks ahead)? Everything `setFormOnLinkEdit`
 * reads of a located slide is in those lines, so two slides that pass have the same layout line, form token, quotation
 * and source link.
 */
function sameSlideLines(a: OutlineSlides, slideA: OutlineSlide, b: OutlineSlides, slideB: OutlineSlide): boolean {
  const length = slideA.end - slideA.start
  if (length !== slideB.end - slideB.start) return false
  for (let offset = 0; offset <= length; offset += 1) {
    const i = slideA.start + offset
    const j = slideB.start + offset
    if (a.lines[i] !== b.lines[j] || a.blanked[i] !== b.blanked[j] || a.notes.has(i) !== b.notes.has(j)) return false
  }
  return true
}

/** The offset of each line's first character in a text read as `text.split('\n')`, and the text's length last. */
function lineOffsets(lines: string[]): number[] {
  const offsets = new Array<number>(lines.length + 1)
  let at = 0
  for (let index = 0; index < lines.length; index += 1) {
    offsets[index] = at
    at += lines[index].length + 1
  }
  offsets[lines.length] = at - 1
  return offsets
}

/** How many characters two texts share from the start, and from the end (each counted over the whole of the shorter
 *  text, so the two may overlap when one text repeats itself). One pass each. */
function sharedEnds(a: string, b: string): { prefix: number; suffix: number } {
  const most = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < most && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix += 1
  let suffix = 0
  while (suffix < most && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix += 1
  return { prefix, suffix }
}

/**
 * `setFormOnLinkEdit` over every quote slide of an edited outline, for the editor's triggers: slides are matched
 * between `before` and `after` by `{id=…}`; a slide with no id yet is matched only when the edit changed nothing
 * outside it (below). `compiledLayoutAt(headingLine)` is the layout the compiler gave the slide (a quote-only slide
 * has no `{quote}` token). Slides are handled from the last up, so a written layout line never moves one still to do.
 *
 * The cost follows the edit, not the talk: each text is read once (and the text again after each form written), and a
 * pair of slides that read the same (`sameSlideLines`, on the very two slides `setFormOnLinkEdit` would locate: one in
 * the text so far, one in `before`) is passed over without asking the rule. `compiledLayoutAt` is still asked for every
 * slide the rule would be asked about, in the same order, so a stateful callback sees the same calls. That pair's answer
 * is always "nothing set": the source link is the link it had, or there is none, whatever the layout and whatever changed
 * elsewhere in the talk. A typed line on a 400-slide talk used to cost seconds here (every slide re-read the whole
 * outline, twice).
 *
 * A slide with no id yet (its id reads '') is named by its heading line, so a quote slide typed and not yet saved takes
 * its form like any other (issue 139). Nothing in it says which slide of `before` it was: not its position, not the
 * number of slides, not its heading (a slide moved, or two that changed places, read as an edited link by any of
 * those). So it is paired by one rule, and gets no write otherwise: THE EDIT CHANGED NOTHING OUTSIDE THAT ONE SLIDE.
 * With the slide at `[s, e)` in `after` (the start of its heading line to the end of its last line):
 *   - every character before `s` and every character from `e` on is the same in both texts
 *     (`before.slice(0, s) === after.slice(0, s)`, and `after.slice(e)` ends `before` without reaching back over `s`);
 *     asked of the two shared lengths (`sharedEnds`, computed once), never by slicing per slide;
 *   - and what `before` holds between them, `[s, before.length - (after.length - e))`, is exactly one slide (one
 *     heading, on its first line) that has no id either: that slide is its `before`.
 * The heading line itself may be edited; an id gained in the same edit makes the slide one with an id (not found in
 * `before`, not written), and one lost in the same edit fails the last clause. A slide added, removed, moved or
 * duplicated changes text outside every other slide, so no slide with no id is written in that edit.
 * One case reads as an edit to one slide and is not one: a slide replaced, where it stands, by a copy of another
 * (the last slide deleted and another duplicated at the end). So a paired slide whose own lines (the blank lines that
 * end it aside) are, byte for byte, the lines of a slide with no id in `before` is not written either: nobody edited
 * its link. This only ever withholds a write.
 * `compiledLayoutAt` for slides with no id: asked once for each one that is paired, in the same last-to-first order as
 * the slides with ids and with its heading line in `after`; never asked for one that is not paired. An edit pairs at
 * most the one slide it lies in (with `before === after` every slide is paired with itself, asked, and passed over).
 * (The copied-slide check and the unchanged-lines skip come after the question, as the skip does for a slide with an id.)
 */
export function setFormOnLinkEdits(before: string, after: string, compiledLayoutAt?: (headingLine: number) => string | undefined): LinkFormWrite {
  const readAfter = readOutlineSlides(after)
  const readBefore = before === after ? readAfter : readOutlineSlides(before)
  const slidesBefore = slideLookup(readBefore)
  let text = after
  // `text` as read, and its slides: `after` until a form is written, then read again (a written line can move slides).
  let readText = readAfter
  let slidesText = slideLookup(readAfter)
  let formSet: 'web' | 'paper' | null = null
  // What the two texts share at each end, and where their lines start: read once, and only when a slide has no id.
  let outside: { prefix: number; suffix: number; after: number[]; before: number[] } | null = null
  // The lines of every slide of `before` that has no id, joined: read once, and only when a slide with no id was edited.
  let unstampedBefore: Set<string> | null = null
  // Without the blank lines that end it: a slide copied to or from the end of the text keeps its own lines.
  const ownLines = (read: OutlineSlides, slide: OutlineSlide): string => read.lines.slice(slide.start, slide.end).join('\n').replace(/[\r\n]+$/, '')
  for (let position = readAfter.slides.length - 1; position >= 0; position -= 1) {
    const slide = readAfter.slides[position]
    let slideBefore: SlideRef | null = null
    let was: OutlineSlide | undefined
    if (slide.id) {
      was = slidesBefore.byId.get(slide.id)
      slideBefore = was ? slide.id : null
    } else {
      outside ??= { ...sharedEnds(before, after), after: lineOffsets(readAfter.lines), before: lineOffsets(readBefore.lines) }
      const start = outside.after[slide.start]
      const tail = after.length - outside.after[slide.end]
      if (outside.prefix >= start && outside.suffix >= tail && start + tail <= before.length) {
        // The text before the slide is the same, so its heading stands on the same line in `before`. `byLine` finds a
        // slide by its heading line as `locate` does; it must begin and end where the unchanged text does, with no id.
        const same = slidesBefore.byLine.get(slide.line)
        if (same && !same.id && same.start === slide.start && outside.before[same.start] === start && before.length - outside.before[same.end] === tail) {
          was = same
          slideBefore = { headingLine: same.line }
        }
      }
    }
    if (!slideBefore || !was) continue
    // Asked for every slide the rule is asked about, skipped or not, in this order and with this line (`slide.line` of
    // `after` as read, not shifted by a write): a callback with state sees the same calls as before the skip existed.
    const layout = compiledLayoutAt?.(slide.line)
    const ref: SlideRef = slide.id || { headingLine: slide.line }
    // The slide the rule would read in `text`: as `locate` resolves `ref` there.
    const now = slideIn(slidesText, ref)
    if (now && sameSlideLines(readText, now, readBefore, was)) continue
    if (!slide.id) {
      unstampedBefore ??= new Set(readBefore.slides.filter((candidate) => !candidate.id).map((candidate) => ownLines(readBefore, candidate)))
      if (unstampedBefore.has(ownLines(readAfter, slide))) continue
    }
    const refBefore = slideBefore
    const written = formOnLinkEdit(text, readText, ref, layout, () => sourceLinkIn(readBefore, refBefore))
    if (written.set) {
      text = written.outline
      formSet = written.form
      readText = readOutlineSlides(text)
      slidesText = slideLookup(readText)
    }
  }
  return { outline: text, set: formSet != null, form: formSet }
}

export interface QuoteSourceInput {
  /** The text of the source line, without its link. */
  text?: string
  /** The link: written after the text, as the shape of spec 2.4 has it. */
  link?: string
}

export interface QuoteSourceWrite {
  outline: string
  /** `web` or `paper` when the write also set that form (spec 3.1): the call added or changed an ordinary web link, or a DOI, on an Automatic quote that would otherwise be Plain. */
  formSet: 'web' | 'paper' | null
}

const NO_BREAK = /[\r\n]/
/** A line that is wholly one web address, as the compiler's lexer reads it (`isBareUrl`). */
const BARE_ADDRESS = /^https?:\/\/[^\s<>"']+$/i

/** Write the slide's source line in the spec 2.4 shape (`- text link`); creates it when the slide has none
 *  (spec 11 `set-quote-source`). Either part left out keeps what the line has. */
export function setQuoteSource(outline: string, slide: SlideRef, source: QuoteSourceInput, compiledLayout?: string): QuoteSourceWrite {
  const { outline: written, text, link, headingLine } = writeQuoteSource(outline, slide, source, compiledLayout)
  if (written === outline) return { outline, formSet: null }
  // The final check, by compiling (quote-write-check.ts): the source line is written only when the compiler reads
  // the slide's displayed words (every quotation's, and everything beside them) as it did before the write, and the
  // source that was written on one quotation. With no quotation to the compiler, or where its reading cannot be
  // made, nothing is written. The verb has no result that says "could not": the outline comes back unchanged, as it
  // does when there is nothing to write.
  if (!quoteSourceWriteHolds({ headingLine, before: outline, written, text, link })) return { outline, formSet: null }
  // An Automatic quote that would be Plain and gains an ordinary web link becomes a web page, and one that gains a DOI a paper, in the same edit (spec 3.1).
  const linked = setFormOnLinkEdit(outline, written, slide, compiledLayout)
  return { outline: linked.outline, formSet: linked.form }
}

/** The outline with the source line written, with what the line holds and where the slide is (for the check that follows). */
function writeQuoteSource(outline: string, slide: SlideRef, source: QuoteSourceInput, compiledLayout?: string): { outline: string; text: string; link: string; headingLine: number } {
  const at = locate(outline, slide)
  requireQuoteSlide(at, compiledLayout)
  for (const value of [source.text, source.link]) {
    if (value != null && NO_BREAK.test(value)) throw new LayoutVerbError('bad-option-token', 'a source line is one line')
  }
  // The form in effect (the slide's own or an inherited one, a Trigger line among the content included) says whether
  // the address under the quotation is the source line. The body is read as the compiler reads it (`quoteBody`): every
  // index below is into those lines, and `read.at` / `read.after` give the outline line, so a Trigger line among the
  // content is never moved, removed or rewritten.
  const read = quoteBody(at)
  const body = readQuoteSlideLines(read.lines, effectiveQuoteForm(at))
  // Lines `first` to `last` of the body become the one line `text`: the first is rewritten where it stands and the
  // others are removed, each by its own outline line, so a folded Trigger line standing among them stays.
  const replaceBodyLines = (first: number, last: number, text: string): void => {
    for (let index = last; index > first; index -= 1) lines.splice(read.at[index], 1)
    lines[read.at[first]] = text
  }
  const parsedCite = body.cite
  // Keep the half the caller did not name: split the old line into its link and its text.
  // The link is the span `parseSourceLine` reads as the link (a Markdown link, bare URL, `doi:` or bare DOI), kept verbatim.
  const span = sourceLinkSpan(parsedCite)
  const oldLink = span ? parsedCite.slice(span.index, span.index + span.length) : ''
  const oldText = (span ? `${parsedCite.slice(0, span.index)} ${parsedCite.slice(span.index + span.length)}` : parsedCite).replace(/\s+/g, ' ').trim()
  const text = (source.text ?? oldText).trim()
  const link = (source.link ?? oldLink).trim()
  const line = [text, link].filter(Boolean).join(' ')
  const done = (result: string): { outline: string; text: string; link: string; headingLine: number } => ({ outline: result, text, link, headingLine: at.slide.line })
  const lines = [...at.read.lines]
  const eol = at.eol
  if (body.source && body.source.kind === 'promoted-tail') {
    // A promoted quote's source follows the closing quote on the paragraph itself: replace from the lead to the
    // end of the paragraph, keeping the dash or parenthesis as written.
    const last = body.source.endIndex ?? body.source.index
    const rawLast = lines[read.at[last]]
    const tail = `${body.source.prefix}${body.source.lead}${line}${body.source.suffix}`
    replaceBodyLines(body.source.index, last, `${tail}${rawLast.endsWith('\r') ? '\r' : ''}`)
    return done(lines.join('\n'))
  }
  if (body.source) {
    const old = lines[read.at[body.source.index]].replace(/\r$/, '')
    // An address standing under the quotation as the source (kind 'address') stays a line of its own while it is only
    // an address; once it has text it is written as a source line.
    const lead = body.source.kind === 'quote-dash' ? body.source.prefix : body.source.kind === 'dash' ? '— ' : body.source.kind === 'bullet' ? (old.match(/^\s*[-*+]\s+/)?.[0] ?? '- ') : body.source.kind === 'address' && line && !BARE_ADDRESS.test(line) ? '- ' : ''
    // A paragraph standing as the source (kind 'bare') may run over several lines; the new line replaces them all.
    replaceBodyLines(body.source.index, body.source.kind === 'bare' ? body.source.endIndex : body.source.index, `${lead}${line}${eol}`)
  } else if (body.hasQuote) {
    if (!line) return done(outline)
    // A list item straight after the quotation would take a bulleted source into the list. Write the source as an
    // in-block attribution instead (`> — Source`), which the shared grammar reads as the citation and leaves the list alone.
    // The source goes directly after the quotation's last line as written (`after`), above any Trigger line that
    // follows it; the line that follows the quotation is the next one the compiler reads.
    const after = read.after(body.quoteEnd)
    const next = body.quoteEnd < read.at.length ? lines[read.at[body.quoteEnd]] : ''
    if (/^\s*[-*+]\s+\S/.test(next) && body.quoteEnd > 0) {
      const quoteLine = lines[after - 1]
      const raw = quoteLine.replace(/\r$/, '')
      if (/^\s*>/.test(raw)) {
        const indent = raw.match(/^\s*>\s?/)?.[0] ?? '> '
        lines.splice(after, 0, `${indent}— ${line}${eol}`)
      } else {
        // A promoted quote (no `>`) takes the source as a dash tail on its last line, which the grammar reads as the source.
        lines[after - 1] = `${raw} — ${line}${quoteLine.endsWith('\r') ? '\r' : ''}`
      }
    } else {
      lines.splice(after, 0, eol, `- ${line}${eol}`)
    }
  } else {
    if (!line) return done(outline)
    lines.splice(at.slide.end, 0, `- ${line}${eol}`)
  }
  return done(lines.join('\n'))
}

export interface QuotePictureWrite {
  outline: string
}

const IMAGE_MARKUP = /!\[[^\]]*\]\([^)]*\)/

/** Write the quote slide's picture line (spec 11 `set-quote-picture`): `path` adds the line before the
 *  quotation, or replaces the path of the first image line (its alt text is kept unless `alt` is given);
 *  `null` removes the picture. The picture decides between the player and the left panel (spec 2.5). */
export function setQuotePicture(outline: string, slide: SlideRef, path: string | null, alt?: string, compiledLayout?: string): QuotePictureWrite {
  const at = locate(outline, slide)
  requireQuoteSlide(at, compiledLayout)
  for (const value of [path, alt]) {
    if (value != null && NO_BREAK.test(value)) throw new LayoutVerbError('bad-option-token', 'a picture line is one line')
  }
  if (path != null && (!path.trim() || path.includes(')'))) throw new LayoutVerbError('bad-option-token', 'a picture path is not empty and has no ")"')
  const cleanAlt = alt == null ? null : alt.replace(/[\[\]]/g, '').trim()
  // The body as the compiler reads it (`quoteBody`): a Trigger line among the content is folded into the slide, so
  // image syntax inside one (`{reveal ![x](a.png)}`) is no picture and that line is never written to; speaker notes
  // are not content either. The picture is the first image line of what is left, and `read.at` gives its outline line.
  const read = quoteBody(at)
  const body = readQuoteSlideLines(read.lines)
  const lines = [...at.read.lines]
  const eol = at.eol
  if (body.picture && body.pictureIndex >= 0) {
    const index = read.at[body.pictureIndex]
    const old = lines[index].replace(/\r$/, '')
    const existing = IMAGE_MARKUP.exec(old)?.[0] ?? ''
    if (path == null) {
      const rest = old.replace(IMAGE_MARKUP, '').trim()
      if (rest) lines[index] = `${rest}${eol}`
      else {
        lines.splice(index, 1)
        // The blank line that separated the picture from what follows goes with it.
        if (index < lines.length && lines[index].trim() === '' && (index === 0 || lines[index - 1].trim() === '')) lines.splice(index, 1)
      }
    } else {
      const keptAlt = cleanAlt ?? (/^!\[([^\]]*)\]/.exec(existing)?.[1] ?? '')
      lines[index] = `${old.replace(IMAGE_MARKUP, `![${keptAlt}](${path.trim()})`)}${eol}`
    }
    return { outline: lines.join('\n') }
  }
  // No picture (image syntax inside a folded Trigger line is none): removing changes nothing, and setting adds the
  // picture line before the first line of content, as on any slide with no picture.
  if (path == null) return { outline }
  const line = `![${cleanAlt ?? ''}](${path.trim()})${eol}`
  const content = read.lines.findIndex((text) => text.trim() !== '')
  if (content >= 0) lines.splice(read.at[content], 0, line, eol)
  else lines.splice(at.slide.end, 0, line)
  return { outline: lines.join('\n') }
}

// ── suggest-layouts ──────────────────────────────────────────────────────────────────────────

interface Candidate { layout: string; score: number; order: number; why: string }

/** How often the talk already uses each entry, for the tie-break. */
function usageCounts(outline: string): Map<string, number> {
  const counts = new Map<string, number>()
  const read = readOutlineSlides(outline)
  const entryTokens = LAYOUTS.map((entry) => ({ name: entry.name, token: parseTriggerLine(entry.trigger)[0]?.raw }))
  for (const slide of read.slides) {
    const block = logicalTriggerBlockAfterHeading(read.lines, slide.start)
    if (!block) continue
    const raws = new Set(parseTriggerLine(block.line).map((token) => token.raw))
    for (const entry of entryTokens) if (entry.token && raws.has(entry.token)) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1)
  }
  return counts
}

/** The layouts this talk uses, most used first (the picker's Recent group, before its own session order). */
export function recentLayouts(outline: string): string[] {
  const counts = usageCounts(outline)
  return [...counts.entries()]
    .filter(([name]) => entryNamed(name).kind !== 'modifier')
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
}

/** Entries the slide already has on its Trigger line (never suggested back to it). */
function alreadyHas(line: string, shape: SlideShape): Set<string> {
  const have = new Set<string>()
  const raws = new Set(parseTriggerLine(line).map((token) => token.raw))
  for (const entry of LAYOUTS) {
    const token = parseTriggerLine(entry.trigger)[0]?.raw
    if (token && raws.has(token)) have.add(entry.name)
  }
  // A list slide with no layout word is already the List layout.
  if (!shape.authoredLayout && shape.points.length > 0) have.add('list')
  return have
}

/**
 * Up to six layouts for the slide, best first, each with a one-line reason. The rule (mockup notes,
 * "Suggested: the ranking rule"): read the content shape; match it to layouts, each branch listing
 * layouts in the order of closeness; drop the slide's own layout and any layout that cannot take
 * the content; order by closeness, breaking ties by how often this talk uses the layout; show
 * fewer rather than pad, and none when the slide has no body.
 */
export function suggestLayouts(outline: string, slide: SlideRef): LayoutSuggestion[] {
  const at = locate(outline, slide)
  const shape = shapeOf(at)
  if (shape.headingOnly) return []

  const candidates = new Map<string, Candidate>()
  let order = 0
  // Each branch scores its layouts base, base-10, base-20 … by position; a layout named by several branches
  // keeps its best score (its first reason).
  const branch = (layouts: string[], why: string, base = 100): void => {
    layouts.forEach((layout, position) => {
      const score = base - position * 10
      const existing = candidates.get(layout)
      if (!existing || score > existing.score) candidates.set(layout, { layout, score, order: existing?.order ?? order, why })
      order += 1
    })
  }

  const points = shape.points
  const texts = pointLines(shape)
  const n = points.length
  const short = n > 0 && points.every((point) => point.words <= SHORT_POINT_WORDS)
  const noSubs = points.every((point) => point.subs === 0)
  const anyPicture = shape.images + shape.videos > 0
  const pluralPoints = (count: number): string => `${count} ${count === 1 ? 'point' : 'points'}`

  if (n >= FEW_POINTS.min && n <= FEW_POINTS.max && short && noSubs) {
    branch(['cards', 'iconrow', 'numbered', 'grid'], `${pluralPoints(n)}, each short, no sub-points`)
    if (points.every((point) => startsWithVerb(point.text))) {
      branch(['process'], `${pluralPoints(n)}, each starting with a verb: steps in order`, 60)
    }
  }
  if (n >= MANY_POINTS) branch(['2col', 'grid', 'list'], `${pluralPoints(n)}: too many for one column`)
  if (n > 0 && points.some((point) => point.subs > 0)) {
    branch(['columns', 'iconrow', 'table', 'orgchart', 'mindmap', 'annotated'], 'Points with sub-points under them')
  }
  if (allStartWithDates(texts)) branch(['timeline'], 'Every point starts with a year or a date', SPECIFIC)
  if (n > 0 && texts.every((text) => TIME_RE.test(text))) branch(['timetable'], 'Every point starts with a time', SPECIFIC)
  if (n > 0 && texts.every(isNumberLabel)) branch(['stats'], 'Every point is number: what it counts', SPECIFIC)
  if (n > 0 && texts.every((text) => labelNumber(text) !== null)) {
    const total = texts.reduce((sum, text) => sum + (labelNumber(text) ?? 0), 0)
    branch(['barchart'], 'Every point is label: number', SPECIFIC)
    if (Math.abs(total - 100) < 0.5) branch(['piechart'], 'The numbers add up to 100', SPECIFIC + 5)
  }
  if (n === 0 && !anyPicture) {
    // One blockquote and nothing else is a quotation as surely as a paragraph in quotation marks.
    if (shape.paragraphs.length === 0 && shape.quoteBlocks === 1) branch(['quote'], 'One quotation and nothing else', SPECIFIC)
    else if (shape.paragraphs.length === 1 && shape.quoteBlocks === 0) {
      if (shape.quotes > 0) branch(['quote'], 'One paragraph in quotation marks', SPECIFIC)
      else branch(['statement'], 'One paragraph and no list', SPECIFIC)
    }
  }
  if (anyPicture) {
    if (shape.quotes > 0) branch(['image-quote'], 'An image with a quotation', SPECIFIC)
    else if (n > 0) branch(['list-visual', 'image-claim'], 'An image beside a list', SPECIFIC)
    else if (shape.paragraphs.length === 0) branch(shape.images > 1 ? ['image-grid', 'media'] : ['media', 'image-grid'], 'Images and nothing else', SPECIFIC)
  }
  if (n >= 2 && speakerLines(texts)) branch(['trace'], 'Lines written as Speaker: words', SPECIFIC)

  const have = alreadyHas(at.oldLine, shape)
  const usage = usageCounts(outline)
  return [...candidates.values()]
    .filter((candidate) => !have.has(candidate.layout) && reasonWhyNot(entryNamed(candidate.layout), shape) === null)
    .sort((a, b) => b.score - a.score || (usage.get(b.layout) ?? 0) - (usage.get(a.layout) ?? 0) || a.order - b.order)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ layout, why }) => ({ layout, why }))
}
