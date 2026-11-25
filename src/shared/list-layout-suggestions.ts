import { LAYOUTS } from './layout-registry/entries.ts'
import { canTakeAllLayouts, listPointKinds, listStructurePlan, readSlideShape, type ListLayoutEdit, type SlideRef } from './layout-verbs.ts'
import { LIST_LAYOUT_STRUCTURES, type ListLayoutStructure } from './list-layout-structure.ts'
import { readOutlineSlides, type OutlineSlides } from './feedback-accept.ts'
import { classifyContentLines } from '../../compiler/scripts/lib/14-outline-tree.mjs'
import { lexMarkdownBlocksWith } from '../../compiler/scripts/lib/03-markdown-lexer-core.mjs'
import { parseHeadingAttrs } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import { plainInlineText } from '../../compiler/scripts/lib/00-inline-render.mjs'
import { editorIconKey } from './plain-view-compiler-facts.ts'

export type ListLayoutCandidate = ListLayoutEdit & {
  label: string
  check: LayoutPreviewCheck
  reason?: string
  whatChanges?: string
}

export interface LayoutPreviewCheck {
  layout?: string
  selector?: string
  title?: 'left' | 'top' | 'hidden'
  words: string[]
}

export interface LayoutPreviewEvidence {
  words: string[]
  overflows: boolean
  matches: boolean
}

export type ListLayoutFit =
  | { kind: 'fits-as-is' }
  | { kind: 'changes-structure'; whatChanges: string }
  | { kind: 'not-offered'; reason: string }

export function layoutWords(text: string): string[] {
  return text.normalize('NFC').match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
}

export function layoutPreviewRefusal(check: LayoutPreviewCheck, evidence: LayoutPreviewEvidence, warnings: readonly string[]): string | undefined {
  if (warnings.some(warning => warning.startsWith('iconlist-no-icons:'))) return 'No points resolve to icons'
  if (!evidence.matches || warnings.some(warning => /(?:^|[-:])fallback(?:[-:]|$)/i.test(warning))) {
    return 'This content renders in a different design'
  }
  const remaining = new Map<string, number>()
  for (const word of evidence.words) remaining.set(word, (remaining.get(word) ?? 0) + 1)
  for (const word of check.words) {
    const count = remaining.get(word) ?? 0
    if (!count) return 'This design would leave out some of the slide’s words'
    remaining.set(word, count - 1)
  }
  if (evidence.overflows) return 'This content does not fit on the slide'
}

export function classifyListLayout(
  candidate: ListLayoutCandidate, evidence?: LayoutPreviewEvidence, warnings: readonly string[] = []
): ListLayoutFit {
  const reason = candidate.reason ?? (evidence ? layoutPreviewRefusal(candidate.check, evidence, warnings) : 'Could not verify this content in the preview')
  if (reason) return { kind: 'not-offered', reason }
  return candidate.whatChanges === undefined ? { kind: 'fits-as-is' }
    : { kind: 'changes-structure', whatChanges: candidate.whatChanges }
}

type ListNode = { text: string; children?: ListNode[] }
const nestedWords = (nodes: ListNode[]): string[] => nodes.flatMap(node => [node.text, ...nestedWords(node.children ?? [])])

/** Read source words before the layout mapper can omit them. The list lexer has already removed
 * item icon attributes, and the outline reader has removed notes and comments. */
export function listSlideWords(outline: string, ref: SlideRef, read: OutlineSlides = readOutlineSlides(outline)) {
  const slide = read.slides.find(item => typeof ref === 'string' ? item.id === ref : item.line === ref.headingLine)
  if (!slide || slide.folded || slide.opensSection || slide.container) return null
  const heading = read.blanked[slide.start].replace(/^#+\s+/, '')
  const body = read.blanked.slice(slide.start + 1, slide.end).filter((_, index) => !read.notes.has(slide.start + 1 + index))
  const blocks = lexMarkdownBlocksWith(classifyContentLines(body).filter(line => !line.stray).map(line => line.line.replace(/\r$/, '')), editorIconKey)
  if (!blocks.some(block => block.type === 'list')) return null
  const text: string[] = []
  for (const block of blocks) {
    if (block.type === 'list') {
      text.push(...block.items as string[], ...(block.children as ListNode[][]).flatMap(nestedWords))
    } else if (block.type === 'table') {
      text.push(...block.header as string[], ...(block.rows as string[][]).flat())
    } else if (block.type === 'code') {
      text.push(String(block.code ?? block.text ?? ''))
    } else if (typeof block.text === 'string') {
      text.push(block.text)
    } else {
      for (const field of [block.caption, block.label, block.title]) if (typeof field === 'string') text.push(field)
    }
  }
  return {
    title: layoutWords(plainInlineText(parseHeadingAttrs(heading).title)),
    body: text.flatMap(line => layoutWords(plainInlineText(line)))
  }
}

// The registry supplies names and capability checks. These are the entries whose drawing is
// driven by list rows, their indentation, or a date/value/media field on the same slide.
const FLAT = new Set(['list', 'plainlist', 'numbered', 'iconlist', 'logolist', 'stmt-list',
  '2col', '3col', 'cards', 'contrast', 'grid', 'process', 'steps', 'pyramid', 'cycle', 'flow', 'orgchart', 'mindmap'])
const GROUPED = new Set(['annotated', 'columns', 'smartart', 'table-outline', 'system-map'])
const DATED = new Set(['timeline', 'timeline-visual', 'timetable'])
const NUMERIC = new Set(['chart', 'barchart', 'piechart', 'linechart', 'stats', 'sigmoid'])
const MEDIA = new Set(['list-visual', 'image-claim', 'copy-visual', 'cta-screenshots'])
const EXTRA = new Set(['trace', 'trace-dialogue', 'conceptmap', 'equation', 'table', 'compare', 'iconrow'])

const LIST_DESIGNS: Readonly<Record<string, { label?: string; layout?: string; selector?: string }>> = {
  list: { label: 'Title and points', selector: '.feature-list,.slide-body ul,.slide-body ol' },
  plainlist: { label: 'Plain list', layout: 'list', selector: '.fl-plain:not(.fl-annotated)' },
  numbered: { label: 'Numbered', layout: 'list', selector: '.fl-numbered' },
  iconlist: { label: 'Icon boxes', layout: 'list', selector: '.fl-cards:not(.fl-numbered)' },
  logolist: { label: 'Logo list', layout: 'list', selector: '.feature-list:not(.fl-plain)' },
  iconrow: { label: 'Row of icons', selector: '.icon-row,.iconrow' },
  annotated: { label: 'Name beside points', layout: 'list', selector: '.fl-annotated' },
  compare: { label: 'Compare halves', selector: '.compare-grid' },
  columns: { selector: '.columns-grid' },
  cards: { selector: '.card-gallery.card-grid' },
  grid: { selector: '.tile-grid' },
  orgchart: { label: 'Tree', selector: '.orgchart' },
  smartart: { label: 'Headed columns', selector: '.smartart-grid' },
  pyramid: { selector: '.pyramid' },
  process: { label: 'Process strip', selector: '.process-strip' },
  steps: { selector: '.steps-diagram' },
  cycle: { selector: '.cycle-diagram' },
  flow: { selector: '.flow' },
  timeline: { selector: '.timeline' },
  'timeline-visual': { selector: '.timeline' },
  'system-map': { selector: '.system-map' },
  table: { selector: 'table' },
  'table-outline': { layout: 'table', selector: 'table' },
  chart: { selector: '.chart-cols,.chart-pie,.chart-line' },
  barchart: { layout: 'chart', selector: '.chart-cols' },
  piechart: { layout: 'chart', selector: '.chart-pie' },
  linechart: { layout: 'chart', selector: '.chart-line' },
  stats: { selector: '.stats-row' },
  sigmoid: { selector: '.sigmoid-curve' },
  timetable: { selector: '.timetable' },
  '2col': { layout: 'list', selector: '.columns-grid.columns-2' },
  '3col': { layout: 'list', selector: '.columns-grid.columns-3' }
}

const VARIANTS = [
  ['Contrast, paired rows', 'rows'], ['Contrast, tinted', 'tint'], ['Contrast, crossed out', 'ledger']
] as const

export function listLayoutCandidates(outline: string, ref: SlideRef, hasLogos = false, read?: OutlineSlides): ListLayoutCandidate[] | null {
  const words = listSlideWords(outline, ref, read)
  if (!words) return null
  const shape = readSlideShape(outline, ref)
  const fits = canTakeAllLayouts(outline, ref)
  const grouped = shape.points.some(point => point.subs > 0)
  const kinds = listPointKinds(shape.points.map(point => point.text))
  const contrast = shape.points.length === 2 || (!grouped && shape.points.length > 0 &&
    shape.points.every(point => /\s\/\s/.test(point.text)))
  const refusal = (layout: string): string | undefined => {
    if (layout === 'mindmap') return 'The points would overlap in this mind map'
    if (layout === 'grid' && grouped) return 'Grid would leave out the sub-points'
    if (['2col', '3col', 'columns'].includes(layout) && grouped) return 'The grouped points do not fit in these columns'
    if (layout === 'contrast' && !contrast) return 'Needs two sides or points written as left / right'
    if (layout === 'logolist' && !hasLogos) return 'No names with a known logo'
    if (layout === 'annotated' && !grouped) return 'Needs a sub-point under each item'
    if (GROUPED.has(layout) && layout !== 'columns' && !grouped) return 'Needs groups with sub-points'
    if (layout === 'compare' && shape.childHeadings < 2) return 'Needs two halves as #### headings'
    if (layout === 'table' && !shape.paragraphs.some(line => line.includes('|'))) return 'Needs rows and columns'
    if (layout === 'timetable' && !kinds.times) return 'Needs times in the points'
    if (DATED.has(layout) && layout !== 'timetable' && !kinds.dates) return 'Needs dates in the points'
    if (NUMERIC.has(layout) && !(layout === 'stats' ? kinds.stats : kinds.values)) return 'Needs numbers in the points'
    const fit = fits.get(layout)
    if (fit?.ok === false) return fit.reason
  }
  const allWords = [...words.title, ...words.body]
  const check = (layout: string): LayoutPreviewCheck => ({
    layout: LIST_DESIGNS[layout]?.layout ?? layout,
    selector: LIST_DESIGNS[layout]?.selector,
    words: allWords
  })
  const out = LAYOUTS.filter(({ name, status }) => status === 'stable' &&
    [FLAT, GROUPED, DATED, NUMERIC, MEDIA, EXTRA].some(group => group.has(name)))
    .map(({ name, label }): ListLayoutCandidate => ({
      label: LIST_DESIGNS[name]?.label ?? label, layout: name, check: check(name), reason: refusal(name)
    }))
  for (const [label, value] of VARIANTS) out.push({
    label, layout: 'contrast', options: [{ group: 'variant', token: `contrast=${value}` }],
    reason: refusal('contrast'), check: { ...check('contrast'), selector: `.contrast-${value}` }
  })
  out.push({
    label: 'Icon list', layout: 'iconlist', options: [{ group: 'iconlist-variant', token: 'iconlist=list' }],
    check: { ...check('iconlist'), selector: '.fl-iconlist-list' }
  }, {
    label: 'Title at the side', layout: 'list',
    options: [{ group: 'title-display', token: 'title=show' }, { group: 'title-placement', token: 'sidebar' }],
    check: { ...check('list'), title: 'left' }
  }, {
    label: 'Card rows', layout: 'cards', options: [{ group: 'form', token: 'cards=rows' }],
    check: { ...check('cards'), selector: '.cards-rows' }
  })
  const boxes = out.find(candidate => candidate.label === 'Icon boxes')
  if (boxes) boxes.options = [{ group: 'iconlist-variant', token: 'iconlist=boxes' }]
  const contrastDefault = out.find(candidate => candidate.layout === 'contrast')
  if (contrastDefault) {
    contrastDefault.options = [{ group: 'variant', token: '' }]
    contrastDefault.check.selector = '.contrast-vs'
  }
  for (const [structure, layout] of Object.entries(LIST_LAYOUT_STRUCTURES) as Array<[ListLayoutStructure, string]>) {
    if (grouped !== (structure === 'groups-to-headings' || structure === 'nested-to-table')) continue
    const plan = listStructurePlan(outline, ref, structure)
    const hidesTitle = layout === 'compare'
    const resultCheck = structure === 'add-note-lines' ? check('annotated') : check(layout)
    out.push({
      layout, structure, label: structure === 'add-note-lines' ? 'Add notes to points'
        : structure === 'nested-to-table' ? 'Pair points in a table'
        : structure === 'split-into-groups' ? 'Split into two sides' : 'Compare groups as headings',
      check: hidesTitle ? { ...resultCheck, title: 'hidden', words: words.body } : resultCheck,
      ...('reason' in plan ? { reason: plan.reason } : { whatChanges: plan.whatChanges })
    })
  }
  return out
}
