import type { ProjectionRow } from '../../../preload'
import { LAYOUTS } from '../../../shared/layout-registry/entries'
import {
  canTakeAllLayouts, clearPointRow, previewLayout, resetLayoutOptions, setLayout, setLayoutOptions, setQuoteForm, suggestLayouts,
  type LayoutOptionChoice, type QuoteFormChoice, type SlideRef
} from '../../../shared/layout-verbs'
import type { InspectorBindingModel, InspectorModel } from './inspectorModel'
import { clearLineIcon, lineIconState } from '../../../shared/icon-verbs'
import { readOutlineSlides } from '../../../shared/feedback-accept'
import { reportTriggerMergeWarnings } from '../../../shared/trigger-line'
import { defaultTitlePlacementForLayout } from '../../../shared/deck-frame'

export type PanelEdit = { layout?: string; options?: readonly LayoutOptionChoice[]; reset?: readonly string[]; clearRow?: boolean }
export type Design = PanelEdit & { label: string; why?: string; unavailable?: string; current?: boolean; reapply?: boolean }

export const option = (group: string, token: string): LayoutOptionChoice => ({ group, token })
export type PictureSide = 'left' | 'right' | 'above'
export const isPointListLayout = (layout: string): boolean => ['list', 'list-visual', 'copy-visual'].includes(layout)
export const TITLE_PLACEMENT_GROUPS = ['title-placement', 'title-display', 'statement-sidebar']
export const TITLE_GROUPS = [...TITLE_PLACEMENT_GROUPS, 'title-look', 'title-look-tone', 'font-title', 'title-icon']
export const TITLE_STYLES = [
  ['Plain', '', ''], ['Tab', 'titlelook=tab', ''], ['Soft tab', 'titlelook=tab', 'titlelook-tone=soft'],
  ['Kicker', 'titlelook=kicker', ''], ['Label', 'titlelook=label', ''],
  ['Section strip', 'titlelook=tab-strip', ''], ['Intro only', 'titlelook=intro-then-none', '']
] as const

export function panelEdit(text: string, slide: SlideRef, edit: PanelEdit, layout: string, preview = false): string {
  if (edit.clearRow) text = clearPointRow(text, slide)
  if (edit.reset) {
    const result = resetLayoutOptions(text, slide, edit.reset).outline
    if (!edit.reset.includes('title-icon')) return result
    const at = readOutlineSlides(result).slides.find(candidate => typeof slide === 'string' ? candidate.id === slide : candidate.line === slide.headingLine)
    if (!at) return result
    const state = lineIconState(result, at.start)
    if (!state.ok || !state.key) return result
    const cleared = clearLineIcon(result, at.start)
    return cleared.ok ? cleared.text : result
  }
  const changesPlacement = edit.options?.some(choice => choice.group === 'title-display')
  const before = changesPlacement ? resetLayoutOptions(text, slide, ['title-placement', 'title-display']).outline : text
  if (edit.layout && preview) return previewLayout(before, slide, edit.layout, edit.options)
  const form = edit.options?.length === 1 && edit.options[0].group === 'quote-form' ? edit.options[0] : null
  if (form) return setQuoteForm(text, slide, (form.token.replace(/^form=/, '') || 'auto') as QuoteFormChoice, layout).outline
  const edited = edit.layout ? setLayout(before, slide, edit.layout, edit.options)
    : edit.options?.length ? setLayoutOptions(before, slide, edit.options, edit.clearRow ? 'list' : layout) : null
  if (edited && !preview) reportTriggerMergeWarnings(edited.warnings)
  return edited?.outline ?? text
}

export function titlePlace(where: 'top' | 'side' | 'hidden', layout: string): LayoutOptionChoice[] {
  if (layout === 'statement') return [
    option('title-display', where === 'hidden' ? '' : 'title=show'),
    option('title-placement', where === 'hidden' ? 'notitle' : where === 'top' ? 'titletop' : 'sidebar'),
    option('statement-sidebar', where === 'side' ? 'statement-sidebar=on' : 'statement-sidebar=off')
  ]
  return [
    option('title-display', where === 'hidden' ? '' : 'title=show'),
    option('title-placement', where === 'top' ? 'titletop' : where === 'side' ? 'sidebar' : 'notitle')
  ]
}

const TABLE_GROUPS = ['table-header', 'table-columns', 'table-first-column']
export const TABLE_STYLES = [
  ['Header row', 'Column names stand out', [true, true, true]],
  ['Rows only', 'Lighter, for reading across', [false, false, false]],
  ['First column leads', 'When each row is a thing', [false, true, true]],
  ['Row bands', 'One band per row', [true, false, true]],
  ['Plain grid', 'As pasted', [false, true, false]]
] as const

export function tableDesigns(tokens: Readonly<Record<string, string>>): Design[] {
  return TABLE_STYLES.map(([label, why, switches]) => {
    const options = [...TABLE_GROUPS.map((key, index) => option(key, switches[index] ? '' : key + '=off')),
      option('table-bands', label === 'Row bands' ? 'table-bands=on' : '')]
    return { label, why, options, current: options.every(choice => choice.token === (tokens[choice.group] ?? '')) }
  })
}

export const DESIGN_PAGES: Readonly<Record<string, string>> = {
  quote: 'Quote', contrast: 'Contrast', cards: 'Cards', timeline: 'Timeline', flow: 'Flow',
  chart: 'Chart', barchart: 'Chart', piechart: 'Chart', linechart: 'Chart', equation: 'Equation',
  'system-map': 'System map', chat: 'Chat simulation', 'chat-lanes': 'Chat simulation',
  terminal: 'Terminal simulation', 'terminal-agent': 'Terminal simulation', carousel: 'Subslides'
}

export const OWN_LABELS: Readonly<Record<string, string>> = {
  'quote-form': 'Quote form', variant: 'Variant', form: 'Form', 'cards-icons': 'Icons on the cards',
  'timeline-mode': 'Shape', direction: 'Direction', 'chart-shape': 'Chart shape',
  'chart-values': 'Values', shape: 'Shape', palette: 'Colours',
  'sim-open': 'The assistant’s working', 'sim-reveal': 'Messages appear', 'sim-size': 'Text size',
  'poll-type': 'Type', 'poll-results': 'Results', 'poll-skip': 'People who skip a row'
}

export function designsFor(text: string, slide: SlideRef, row: ProjectionRow, model: InspectorModel, block: string,
  hasLogos: boolean, pictureSide: PictureSide | null): Design[] {
  const layout = row.has_table && !model.layoutName ? 'table' : model.layoutName ?? 'list'
  const tokens = model.selectedTokens
  const targetTitles = new Map<string, string>()
  const inheritedTitle = (target: string): string => {
    const title = targetTitles.get(target) ?? defaultTitlePlacementForLayout(text, row.source_line ?? null, target)
    targetTitles.set(target, title)
    return title
  }
  const placement = (where: 'top' | 'side', target: string): LayoutOptionChoice[] => {
    const requested = where === 'side' ? 'left' : 'top'
    if (inheritedTitle(target) === requested) return [option('title-display', ''), option('title-placement', '')]
    return target === layout && row.title_layout === requested ? [] : titlePlace(where, target)
  }
  if (layout === 'table' || layout === 'table-outline') {
    const tables = tableDesigns(tokens)
    return [...tables.map(design => ({ ...design, options: [...design.options!, ...placement('top', layout)],
      current: design.current && row.title_layout === 'top' })), {
      label: 'Title at the side', why: 'More room for rows',
      current: row.title_layout === 'left',
      options: [...tables[1].options!, ...(inheritedTitle(layout) === 'left'
        ? placement('side', layout)
        : [...titlePlace('side', layout), option('title-placement', 'split=30')])]
    }]
  }
  const own = model.board ? 'Board' : tokens['poll-type']?.startsWith('poll=') ? 'Poll' : DESIGN_PAGES[layout]
  if (own && layout !== 'carousel') return [
    { label: own, why: 'What this slide is now', current: true },
    { label: 'Title and points', unavailable: 'Would lose what makes this a ' + own.toLowerCase() }
  ]
  if (layout === 'carousel') return [
    { label: 'Carousel', why: 'One subslide at a time', current: row.title_layout !== 'left' },
    { label: 'Title at the side', why: 'A coloured panel for the title', options: titlePlace('side', layout), current: row.title_layout === 'left' }
  ]
  if (!block.split('\n').slice(1).some(line => line.trim() && !/^\s*\{/.test(line))) return []

  const fits = canTakeAllLayouts(text, slide)
  const suggested = suggestLayouts(text, slide)
  const hasPicture = row.image_count > 0
  const pictureAbove: Design = {
    label: 'Picture above', why: 'A wide picture, points in a row',
    ...(layout === 'iconrow' ? {} : { layout: 'iconrow' }),
    options: [...placement('top', 'iconrow'), option('media-placement', 'image=above')],
    current: layout === 'iconrow' && pictureSide === 'above' && row.title_layout === 'top'
  }
  const listStyle = tokens['list-style'] ?? ''
  const form = tokens['iconlist-variant'] || (row.bullet_count > 3 ? 'iconlist=list' : 'iconlist=boxes')
  const unpinnedListStyle = (style: string): string => (style === 'plainlist' ? '' : style) === model.deckListStyle ? '' : style
  const points = (style: string, variant = '', where: 'top' | 'side' = 'top', side = 'image=right'): PanelEdit => ({
    ...(layout !== 'list' ? { layout: 'list' } : {}),
    options: [...placement(where, 'list'), option('list-style', unpinnedListStyle(style)), option('iconlist-variant', variant),
      ...(hasPicture ? [option('media-placement', side)] : [])]
  })
  const list = (label: string, why: string, style: string, variant = '', where: 'top' | 'side' = 'top', side = 'image=right'): Design => ({
    label, why, ...points(style, variant, where, side),
    current: isPointListLayout(layout) &&
      (where === 'side' ? row.title_layout === 'left' : row.title_layout === 'top') &&
      listStyle === (style === 'plainlist' ? '' : style) && (!variant || form === variant) &&
      (!hasPicture || (pictureSide !== null && `image=${pictureSide}` === side))
  })
  const designs: Design[] = [
    list('Title and points', 'The plain start', 'plainlist'),
    ...(hasLogos ? [
      list('Logo list', 'These names have logos', 'logolist', 'iconlist=list'),
      list('Logo boxes', 'One box per name', 'logolist', 'iconlist=boxes')
    ] : []),
    list(hasPicture ? 'Icon bands, picture right' : 'Icon boxes', 'One box per point', 'iconlist', 'iconlist=boxes'),
    list('Icon list', 'An icon beside each point', 'iconlist', 'iconlist=list'),
    ...(hasPicture ? [
      list('Picture on the left', 'Picture first, then points', 'iconlist', 'iconlist=list', 'top', 'image=left'),
      ...(row.bullet_count > 0 || layout === 'iconrow' ? [pictureAbove] : [])
    ] : []),
    list('Numbered', 'When the order matters', 'numbered'),
    ...(!hasPicture ? [{ label: 'Row of icons', why: 'Light, no boxes', layout: 'iconrow', current: layout === 'iconrow' }] : []),
    list('Title at the side', 'A coloured panel for the title', 'plainlist', '', 'side')
  ]
  const represented = new Set(['list', 'numbered', 'iconlist', 'iconrow', 'logolist'])
  for (const candidate of suggested) {
    if (represented.has(candidate.layout)) continue
    const entry = LAYOUTS.find(item => item.name === candidate.layout)
    if (entry) designs.push({ label: DESIGN_PAGES[entry.name] ?? entry.label, why: candidate.why, layout: entry.name })
  }
  if (!designs.some(design => design.current)) {
    const entry = LAYOUTS.find(item => item.name === layout)
    if (entry) designs.unshift({ label: DESIGN_PAGES[entry.name] ?? entry.label, why: 'What this slide is now', current: true })
  }
  for (const [name, label, reason] of [['timeline', 'Timeline', 'Needs dates in the points'], ['table', 'Table', 'Needs rows and columns']]) {
    if (!designs.some(design => design.label === label)) {
      const fit = fits.get(name)
      designs.push({ label, unavailable: fit?.ok === false ? fit.reason : reason })
    }
  }
  if (!hasLogos) designs.push({ label: 'Logo list', unavailable: 'No names with a known logo' })
  return designs
}

export function pageForBinding(binding: InspectorBindingModel, own: string | undefined, table: boolean): string {
  const key = binding.group.key
  if (TITLE_GROUPS.includes(key)) return 'title'
  if (key === 'section-colour') return 'colour'
  if (key === 'media-placement' || key === 'media-title') return 'picture'
  if (key === 'font-body') return table ? 'table' : 'points'
  if (key.startsWith('table-')) return 'table'
  if (['list-style', 'number-style', 'iconlist-variant'].includes(key)) return 'points'
  if (key === 'icon-level') return 'icons'
  if (own && (binding.source === 'entry' || key === 'poll-type' || key.startsWith('poll-') || key.startsWith('board-'))) return 'own'
  return 'more'
}
