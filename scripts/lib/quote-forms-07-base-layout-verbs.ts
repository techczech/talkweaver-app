// FROZEN COPY, for comparison in tests only. Not used by the app, and not to be edited.
// `src/shared/layout-verbs.ts` as it stood on `origin/ticket/quote-forms-07-web-form` (0364c091), the base of quote forms
// ticket 10: copied with `git show`, every line as it was, except the import paths below (they now point at this
// folder's other frozen copies, or at the modules that have not changed since).
// It reads slides with the base `feedback-accept.ts` and the base `quote-forms.mjs` beside it.
// Read by scripts/test-quote-forms-base-regression.mjs, which states what ticket 10 must not take away: a form or a
// source line the base wrote, and the compiler drew, is still written.
// =============================================================================
// Layout content verbs (ADR-0032 §3/§6 and Consequences; estate ADR-0019).
//
// Typed, headless operations over OUTLINE TEXT that the layout picker and the agent both call:
//
//   previewLayout      (outline, slide, layout, options?)      → outline text, nothing written
//   setLayout          (outline, slide, layout, options?, withStarterText?) → { outline, triggerLine }
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
import { LAYOUTS } from '../../src/shared/layout-registry/entries.ts'
import type { LayoutDef, OptionGroup } from '../../src/shared/layout-registry/entries.ts'
import { optionGroupsForSlide, registryOptionGroups } from '../../src/shared/layout-registry/options.ts'
import { winningAuthoredLayout } from '../../src/shared/layout-registry/vocabulary.ts'
import { deckCommitContext } from '../../src/shared/deck-frame.ts'
import { readOutlineSlides, type OutlineSlide, type OutlineSlides } from './quote-forms-07-base-feedback-accept.ts'
import { commitOptionSelection, isOptionTokenForGroup, logicalTriggerBlockAfterHeading, parseTriggerLine } from '../../src/shared/trigger-line.ts'
import { commitLayoutSelection, selectionFromTriggerLine, toggleLayoutSelection } from '../../src/shared/layout-selection.ts'
import { applyQuoteTitleAttribution, parseHeadingAttrs } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import { preContentWindow } from '../../compiler/scripts/lib/slide-id.mjs'
import {
  quoteFormPlan,
  parseSourceLine,
  sourceLinkSpan,
  readQuoteSlideLines,
  countQuoteBlocks,
  type QuoteFormDetectedBy,
  type QuoteFormName,
  type QuoteFormPresentation
} from './quote-forms-07-base-quote-forms.mjs'

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
  if (at.blockStart >= 0) lines.splice(at.blockStart, at.blockEnd - at.blockStart, newLine + at.eol)
  else lines.splice(at.slide.start + 1, 0, newLine + at.eol)
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

function planLayout(outline: string, ref: SlideRef, layout: string, options: unknown): { at: Located; newLine: string } {
  const entry = entryNamed(layout)
  const choices = optionChoices(options)
  const at = locate(outline, ref)
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

function quoteBody(at: Located): string[] {
  const from = at.blockEnd >= 0 ? at.blockEnd : at.slide.start + 1
  const lines: string[] = []
  for (let index = from; index < at.slide.end; index += 1) lines.push(at.read.notes.has(index) ? '' : (at.read.blanked[index] ?? ''))
  return lines
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

/** What the slide's quote shows and why (spec 11 `describe-quote-source`). A read: nothing is written. */
export function describeQuoteSource(outline: string, slide: SlideRef, compiledLayout?: string): QuoteSourceDescription {
  const at = locate(outline, slide)
  const title = requireQuoteSlide(at, compiledLayout)
  const body = readQuoteSlideLines(quoteBody(at))
  const token = quoteFormToken(at.oldLine)
  // A quotation with no source line takes the slide title as its citation before the form is decided, through
  // the compiler's own `applyQuoteTitleAttribution`, so the title can decide the form here as it does there.
  const quote = { type: 'quote', cite: body.cite }
  if (body.hasQuote) applyQuoteTitleAttribution([quote], title)
  const plan = quoteFormPlan({ token, cite: quote.cite, paragraphs: body.paragraphs, picture: body.picture })
  // Several quotations, or other painting content beside the one: the slide is drawn as Plain, whatever the quote would take.
  const multiple = countQuoteBlocks(quoteBody(at)) > 1
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

/** The first link of the slide's source line ('' when there is none or the slide cannot be read). */
function sourceLinkAt(outline: string, ref: SlideRef): string {
  return sourceLinkIn(readOutlineSlides(outline), ref)
}

/** `sourceLinkAt` over an outline already read. */
function sourceLinkIn(read: OutlineSlides, ref: SlideRef): string {
  try {
    const at = locateIn(read, ref)
    return parseSourceLine(readQuoteSlideLines(quoteBody(at)).cite).link?.url ?? ''
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
  try {
    at = locateIn(readAfter, slide)
    requireQuoteSlide(at, compiledLayout)
  } catch (error) {
    if (error instanceof LayoutVerbError) return unchanged
    throw error
  }
  const token = quoteFormToken(at.oldLine)
  if (token !== '' && token !== 'auto') return unchanged
  const bodyLines = quoteBody(at)
  const body = readQuoteSlideLines(bodyLines)
  if (body.otherContent || countQuoteBlocks(bodyLines) > 1) return unchanged
  const link = parseSourceLine(body.cite).link?.url ?? ''
  if (!link || link === linkBefore()) return unchanged
  const plan = quoteFormPlan({ token: '', cite: body.cite, paragraphs: body.paragraphs, picture: body.picture })
  if (plan.form !== 'plain') return unchanged
  const form = plan.webLink != null ? 'web' : plan.doiLink ? 'paper' : null
  if (!form) return unchanged
  const written = setQuoteForm(after, slide, form, compiledLayout)
  return { outline: written.outline, set: written.outline !== after, form: written.outline !== after ? form : null }
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

/**
 * `setFormOnLinkEdit` over every quote slide of an edited outline, for the editor's triggers: slides are matched
 * between `before` and `after` by `{id=…}`, or for a slide with no id yet by its heading line when the heading text is
 * the same there. `compiledLayoutAt(headingLine)` is the layout the compiler gave the slide (a quote-only slide has
 * no `{quote}` token). Slides are handled from the last up, so a written layout line never moves one still to do.
 *
 * The cost follows the edit, not the talk: each text is read once (and the text again after each form written), and a
 * pair of slides that read the same (`sameSlideLines`, on the very two slides `setFormOnLinkEdit` would locate: one in
 * the text so far, one in `before`) is passed over without asking the rule. `compiledLayoutAt` is still asked for every
 * slide the rule would be asked about, in the same order, so a stateful callback sees the same calls. That pair's answer
 * is always "nothing set": the source link is the link it had, or there is none, whatever the layout and whatever changed
 * elsewhere in the talk. A typed line on a 400-slide talk used to cost seconds here (every slide re-read the whole
 * outline, twice).
 *
 * Kept as it was, and pinned by scripts/test-quote-link-form-edits-equivalence.mjs: a slide with no id is named to
 * `setFormOnLinkEdit` by its id, '' (`slide.id ?? …` never reaches the heading line), which `locate` reads as the FIRST
 * slide with no id, while its link before is read from the slide on its own heading line. So the first unstamped quote
 * slide can be given a form because another unstamped slide's link differs from its own, even when nothing was edited.
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
  for (const slide of [...readAfter.slides].reverse()) {
    let slideBefore: SlideRef | null = null
    let was: OutlineSlide | undefined
    if (slide.id) {
      was = slidesBefore.byId.get(slide.id)
      slideBefore = was ? slide.id : null
    } else {
      const same = slidesBefore.byLine.get(slide.line)
      if (same && (readBefore.lines[same.start] ?? '').trim() === (readAfter.lines[slide.start] ?? '').trim()) {
        was = same
        slideBefore = { headingLine: slide.line }
      }
    }
    if (!slideBefore || !was) continue
    // Asked for every slide the rule is asked about, skipped or not, in this order and with this line (`slide.line` of
    // `after` as read, not shifted by a write): a callback with state sees the same calls as before the skip existed.
    const layout = compiledLayoutAt?.(slide.line)
    const ref: SlideRef = slide.id ?? { headingLine: slide.line }
    // The slide the rule would read in `text`: as `locate` resolves `ref` there.
    const now = slideIn(slidesText, ref)
    if (now && sameSlideLines(readText, now, readBefore, was)) continue
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

/** Write the slide's source line in the spec 2.4 shape (`- text link`); creates it when the slide has none
 *  (spec 11 `set-quote-source`). Either part left out keeps what the line has. */
export function setQuoteSource(outline: string, slide: SlideRef, source: QuoteSourceInput, compiledLayout?: string): QuoteSourceWrite {
  const written = writeQuoteSource(outline, slide, source, compiledLayout)
  if (written === outline) return { outline, formSet: null }
  // An Automatic quote that would be Plain and gains an ordinary web link becomes a web page, and one that gains a DOI a paper, in the same edit (spec 3.1).
  const linked = setFormOnLinkEdit(outline, written, slide, compiledLayout)
  return { outline: linked.outline, formSet: linked.form }
}

function writeQuoteSource(outline: string, slide: SlideRef, source: QuoteSourceInput, compiledLayout?: string): string {
  const at = locate(outline, slide)
  requireQuoteSlide(at, compiledLayout)
  for (const value of [source.text, source.link]) {
    if (value != null && NO_BREAK.test(value)) throw new LayoutVerbError('bad-option-token', 'a source line is one line')
  }
  const from = at.blockEnd >= 0 ? at.blockEnd : at.slide.start + 1
  const body = readQuoteSlideLines(quoteBody(at))
  const parsedCite = body.cite
  // Keep the half the caller did not name: split the old line into its link and its text.
  // The link is the span `parseSourceLine` reads as the link (a Markdown link, bare URL, `doi:` or bare DOI), kept verbatim.
  const span = sourceLinkSpan(parsedCite)
  const oldLink = span ? parsedCite.slice(span.index, span.index + span.length) : ''
  const oldText = (span ? `${parsedCite.slice(0, span.index)} ${parsedCite.slice(span.index + span.length)}` : parsedCite).replace(/\s+/g, ' ').trim()
  const text = (source.text ?? oldText).trim()
  const link = (source.link ?? oldLink).trim()
  const line = [text, link].filter(Boolean).join(' ')
  const lines = [...at.read.lines]
  const eol = at.eol
  if (body.source && body.source.kind === 'promoted-tail') {
    // A promoted quote's source follows the closing quote on the paragraph itself: replace from the lead to the
    // end of the paragraph, keeping the dash or parenthesis as written.
    const index = from + body.source.index
    const last = from + (body.source.endIndex ?? body.source.index)
    const rawLast = lines[last]
    const tail = `${body.source.prefix}${body.source.lead}${line}${body.source.suffix}`
    lines.splice(index, last - index + 1, `${tail}${rawLast.endsWith('\r') ? '\r' : ''}`)
    return lines.join('\n')
  }
  if (body.source) {
    const index = from + body.source.index
    const old = lines[index].replace(/\r$/, '')
    const lead = body.source.kind === 'quote-dash' ? body.source.prefix : body.source.kind === 'dash' ? '— ' : body.source.kind === 'bullet' ? (old.match(/^\s*[-*+]\s+/)?.[0] ?? '- ') : ''
    // A paragraph standing as the source (kind 'bare') may run over several lines; the new line replaces them all.
    const last = body.source.kind === 'bare' ? from + body.source.endIndex : index
    lines.splice(index, last - index + 1, `${lead}${line}${eol}`)
  } else if (body.hasQuote) {
    if (!line) return outline
    // A list item straight after the quotation would take a bulleted source into the list. Write the source as an
    // in-block attribution instead (`> — Source`), which the shared grammar reads as the citation and leaves the list alone.
    const next = lines[from + body.quoteEnd] ?? ''
    if (/^\s*[-*+]\s+\S/.test(next) && body.quoteEnd > 0) {
      const quoteLine = lines[from + body.quoteEnd - 1]
      const raw = quoteLine.replace(/\r$/, '')
      if (/^\s*>/.test(raw)) {
        const indent = raw.match(/^\s*>\s?/)?.[0] ?? '> '
        lines.splice(from + body.quoteEnd, 0, `${indent}— ${line}${eol}`)
      } else {
        // A promoted quote (no `>`) takes the source as a dash tail on its last line, which the grammar reads as the source.
        lines[from + body.quoteEnd - 1] = `${raw} — ${line}${quoteLine.endsWith('\r') ? '\r' : ''}`
      }
    } else {
      lines.splice(from + body.quoteEnd, 0, eol, `- ${line}${eol}`)
    }
  } else {
    if (!line) return outline
    lines.splice(at.slide.end, 0, `- ${line}${eol}`)
  }
  return lines.join('\n')
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
  const from = at.blockEnd >= 0 ? at.blockEnd : at.slide.start + 1
  const body = readQuoteSlideLines(quoteBody(at))
  const lines = [...at.read.lines]
  const eol = at.eol
  if (body.picture && body.pictureIndex >= 0) {
    const index = from + body.pictureIndex
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
  if (path == null) return { outline }
  const line = `![${cleanAlt ?? ''}](${path.trim()})${eol}`
  const content = quoteBody(at).findIndex((text) => text.trim() !== '')
  if (content >= 0) lines.splice(from + content, 0, line, eol)
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
