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
import { LAYOUTS } from './layout-registry/entries.ts'
import type { LayoutDef, OptionGroup } from './layout-registry/entries.ts'
import { optionGroupsForSlide, registryOptionGroups } from './layout-registry/options.ts'
import { winningAuthoredLayout } from './layout-registry/vocabulary.ts'
import { deckCommitContext } from './deck-frame.ts'
import { readOutlineSlides, type OutlineSlide, type OutlineSlides } from './feedback-accept.ts'
import { commitOptionSelection, isOptionTokenForGroup, logicalTriggerBlockAfterHeading, parseTriggerLine } from './trigger-line.ts'
import { commitLayoutSelection, selectionFromTriggerLine, toggleLayoutSelection } from './layout-selection.ts'
import { preContentWindow } from '../../compiler/scripts/lib/slide-id.mjs'

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
  const read = readOutlineSlides(outline)
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

function applyOptionChoices(line: string, at: Located, outline: string, choices: readonly LayoutOptionChoice[]): string {
  if (!choices.length) return line
  const context = deckCommitContext(outline, at.slide.line)
  let result = line
  for (const choice of choices) {
    const group = optionGroupNamed(choice.group, result, at)
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
function optionGroupNamed(key: string, line: string, at: Located): OptionGroup {
  const layoutName = winningAuthoredLayout(line)?.layout
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
