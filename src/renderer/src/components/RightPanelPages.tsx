import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Copy, Crop, Film, GalleryHorizontal, Heading, Image, Layers, LayoutGrid, Link2, List, ListOrdered, Palette, Pin, Replace, RotateCcw, SlidersHorizontal, SmilePlus, Trash2 } from 'lucide-react'
import { GLOBAL_OPTION_GROUPS, LAYOUTS, sectionColourChoices } from '../../../shared/layout-registry/entries'
import { parseFrontmatterPairs } from '../../../shared/frontmatter-editor'
import { groupHasSelection, selectionForGroup } from '../../../shared/trigger-line'
import { registryOptionGroups } from '../../../shared/layout-registry/options'
import { readOutlineSlides } from '../../../shared/feedback-accept'
import { setLayoutOptions, type SlideRef } from '../../../shared/layout-verbs'
import { lineIconState } from '../../../shared/icon-verbs'
import PlainIconPicker, { type IconAnchor } from './PlainIconPicker'
import RightPanelPictures, { type PanelTry } from './RightPanelPictures'
import { useLiveSlidePreview } from './useLiveSlidePreview'
import FixedDeckPreview from './FixedDeckPreview'
import { isPointListLayout, option, panelEdit, tableDesigns, TITLE_GROUPS, TITLE_PLACEMENT_GROUPS, TITLE_STYLES, titlePlace, type Design, type PanelEdit, type PictureSide } from './rightPanelDesigns'
import { createVariantPictureQueue, markSettled, pictureMarkUrl, type VariantPictureMarks, type VariantPictureQueue } from '../../../shared/variant-picture-queue'
import { deckClaimStyleForOutline, defaultTitlePlacementForLayout, statementTitleHidden } from '../../../shared/deck-frame'
import { statementSelections } from '../../../shared/statement-options'

export interface PanelPage {
  id: string
  label: string
  summary: string
  action?: { label: string; accessibleLabel: string; run: () => void }
}
const ICONS = { title: Heading, points: List, icons: SmilePlus, picture: Image, video: Film, colour: Palette, own: LayoutGrid, table: LayoutGrid, steps: Layers, more: SlidersHorizontal }

export interface PanelSurface {
  path: string
  text: string
  slide: SlideRef
  layout: string
  onTry: (preview: PanelTry | null) => void
  onKeep: (choice: Design) => void
  onCopy?: (aspect: string) => void
}

export function CopyForAgent({ aspect, onCopy }: { aspect: string; onCopy?: (aspect: string) => void }) {
  return onCopy ? <button type="button" className="toolbar-btn tw-right-copy" onClick={() => onCopy(aspect)}><Copy size={14} />Copy for agent</button> : null
}

export function PageHead({ label, aspect, back, onCopy }: { label: string; aspect: string; back?: () => void; onCopy?: PanelSurface['onCopy'] }) {
  return <div className="tw-right-page-head">
    {back && <button type="button" className="toolbar-btn" onClick={back}><ChevronLeft size={15} />Back</button>}
    <h3>{label}</h3><CopyForAgent aspect={aspect} onCopy={onCopy} />
  </div>
}

export function AdjustRows({ pages, choose }: { pages: PanelPage[]; choose: (page: string) => void }) {
  return <><h3 className="tw-inspector-section-heading">Adjust one thing</h3><div className="tw-right-adjust">
    {pages.map(page => {
      const Icon = ICONS[page.id as keyof typeof ICONS] ?? LayoutGrid
      const row = <button type="button" onClick={() => choose(page.id)}><Icon size={16} />
        <span><strong>{page.label}</strong><small>{page.summary}</small></span><ChevronRight size={15} />
      </button>
      return page.action ? <div className="tw-right-adjust-direct" key={page.id}>
        {row}
        <button type="button" className="toolbar-btn" aria-label={page.action.accessibleLabel} onClick={page.action.run}>{page.action.label}</button>
      </div> : <Fragment key={page.id}>{row}</Fragment>
    })}
  </div></>
}

// Each check can compile the whole talk. Wait for the selected slide and text to settle.
// Expanding Designs is an explicit request and can start the batch immediately.
const FIT_PREVIEW_SETTLE_MS = 500

function useCheckedDesignPictures(surface: PanelSurface, designs: Design[], automaticCount: number) {
  const { path, text, slide, layout } = surface
  const slideKey = typeof slide === 'string' ? slide : `line:${slide.headingLine}`
  const candidates = useMemo(() => designs.filter(design => design.check), [designs])
  const [result, setResult] = useState<{ path: string; text: string; slide: string; candidates: Design[]; marks: VariantPictureMarks }>()
  const startNow = useRef<(() => void) | undefined>(undefined)
  const showAllRef = useRef(false)
  useEffect(() => {
    if (!candidates.length || !window.tw?.talk?.layoutVariantThumbnail) return
    const batchId = crypto.randomUUID()
    const keys = candidates.map((_, index) => String(index))
    let next = 0
    let needed = automaticCount
    let expanded = false
    let queue: VariantPictureQueue<Design[]> | undefined
    // Check only as many pictures as the compact panel can show. A refusal moves on
    // to the next candidate. Expanding the panel asks for the rest in the same batch.
    const askNext = () => {
      if (needed > 0 && next < keys.length) queue?.want([keys[next++]])
    }
    const start = () => {
      window.clearTimeout(timer)
      expanded ||= showAllRef.current || automaticCount >= candidates.length
      if (queue) {
        if (expanded) queue.want(keys)
        return
      }
      if (!expanded && needed <= 0) return
      queue = createVariantPictureQueue<Design[]>(
        (key, options) => {
          const design = options[Number(key)]
          const outline = panelEdit(text, slide, design, layout, true)
          return window.tw.talk.layoutVariantThumbnail(path, outline, slide, '', undefined, `panel:check:${key}`, batchId, design.check)
        },
        (key, mark) => {
          setResult(previous => ({
            path, text, slide: slideKey, candidates, marks: markSettled(
              previous?.path === path && previous.text === text && previous.slide === slideKey && previous.candidates === candidates
                ? previous.marks : {}, candidates[Number(key)].label, mark
            )
          }))
          if (!expanded) {
            if (pictureMarkUrl(mark)) needed--
            askNext()
          }
        }
      )
      queue.reset(slideKey + text, candidates, slideKey)
      if (expanded) queue.want(keys)
      else askNext()
    }
    const timer = window.setTimeout(start, FIT_PREVIEW_SETTLE_MS)
    startNow.current = start
    return () => {
      startNow.current = undefined
      window.clearTimeout(timer)
      if (!queue) return
      queue.dispose()
      window.tw.talk.releaseLayoutVariantBatch?.(batchId)
    }
  }, [path, text, slideKey, layout, candidates, automaticCount]) // eslint-disable-line react-hooks/exhaustive-deps
  const marks = result?.path === path && result.text === text && result.slide === slideKey && result.candidates === candidates ? result.marks : {}
  return {
    marks,
    pending: candidates.filter(design => !(design.label in marks)).length,
    setExpanded: (expanded: boolean) => {
      showAllRef.current = expanded
      if (expanded) startNow.current?.()
    }
  }
}

export function DesignsBlock({ surface, designs, long, compact, section, hasSubslides }: {
  surface: PanelSurface
  designs: Design[]
  long: boolean
  compact: boolean
  section: boolean
  hasSubslides: boolean
}) {
  const [all, setAll] = useState(false)
  const count = compact ? 2 : 4
  const readyWithoutCheck = designs.filter(design => !design.unavailable && !design.check).length
  const { marks: checkedPictures, pending, setExpanded } = useCheckedDesignPictures(surface, designs,
    long ? designs.length : Math.max(0, count - readyWithoutCheck))
  const fit = designs.filter(design => !design.unavailable && (!design.check || pictureMarkUrl(checkedPictures[design.label])))
  const unavailable = designs.filter(design => design.unavailable)
  const current = fit.find(design => design.current)
  const shown = long || all ? fit : current && fit.indexOf(current) >= count
    ? [current, ...fit.slice(0, count - 1)] : fit.slice(0, count)
  return <div className="tw-right-designs">
    <PageHead label={section ? 'Slides in this section' : fit.length ? 'Designs for this slide' : 'Designs'} aspect="design" onCopy={fit.length ? surface.onCopy : undefined} />
    {!fit.length ? <p className="tw-right-origin">{hasSubslides
      ? 'This slide has two sides. Select one in the sidebar to change it.'
      : 'Designs appear here when the slide has a title and at least one point.'}</p> : <>
      <RightPanelPictures {...surface} group="design" choices={shown} columns={2}
        pendingPicture={section ? sectionModePicture : undefined} checkedPictures={checkedPictures} />
      {(all || long || fit.length <= count) && unavailable.length > 0 && <ul className="tw-right-no-fit">
        {unavailable.map(design => <li key={design.label}><strong>{design.label}</strong> · {design.unavailable}</li>)}
      </ul>}
      {!long && (all || fit.length + pending > count) && <button type="button" className="toolbar-btn" onClick={() => {
        surface.onTry(null)
        setExpanded(!all)
        setAll(!all)
      }}>
        <LayoutGrid size={14} />{all ? 'Show fewer' : pending ? 'Show all designs' : `Show all ${fit.length} designs`}
      </button>}
    </>}
  </div>
}

export function ResetOrigin({ changed, reset, talk, inherited, note }: {
  changed: boolean
  reset: () => void
  talk: () => void
  inherited?: string
  note?: string
}) {
  return <div className="tw-right-origin">
    {changed ? <Pin size={15} /> : <Link2 size={15} />}
    <span>{changed ? 'Changed on this slide only.' : note ?? (inherited ? `Follows the talk: ${inherited}.` : 'Follows the talk.')}</span>
    <button type="button" className="toolbar-btn" onClick={changed ? reset : talk}>
      {changed && <RotateCcw size={14} />}{changed ? 'Reset to talk setting' : 'Change for the talk'}
    </button>
  </div>
}

export function ChoiceRow({ label, choice, options, onChoose }: {
  label: string
  choice: string
  options: readonly (readonly [string, string])[]
  onChoose: (value: string) => void
}) {
  return <div className="tw-inspector-group"><span className="tw-inspector-group-label">{label}</span>
    <div className="tw-right-choice" role="group" aria-label={label}>
      {options.map(([value, name]) => <button key={value} type="button" className="toolbar-btn" aria-pressed={choice === value}
        onClick={() => onChoose(value)}>{name}</button>)}
    </div>
  </div>
}

export function sectionDesigns({ modes, carousel, childCount, trigger }: { modes: boolean; carousel: boolean; childCount: number; trigger: string }): Design[] {
  if (!modes || !childCount) return []
  const group = GLOBAL_OPTION_GROUPS.find(group => group.key === 'container-mode')!
  const current = selectionForGroup(trigger, group)
  const choices = [
    ['', 'One after another', 'The slides follow this one'],
    ['contents', 'Contents', 'Lists the slides in this section'],
    [current === 'grid-linear' ? 'grid-linear' : 'grid-zoom', 'Grid', 'The slides as tiles to pick from'],
    ['carousel', 'Carousel', 'One subslide at a time']
  ]
  return choices.map(([token, label, why]) => token === 'carousel' && !carousel && current !== token
    ? { label, unavailable: 'Needs slides with pictures' }
    : { label, why, options: [option(group.key, token)], current: current === token })
}

function sectionModePicture(design: Design) {
  const mode = design.options?.find(choice => choice.group === 'container-mode')?.token
  const Icon = mode === 'contents' ? List : mode === 'carousel' ? GalleryHorizontal
    : mode?.startsWith('grid-') ? LayoutGrid : ListOrdered
  return <Icon size={24} className="tw-right-picture-placeholder" />
}

function IntroPicture({ surface }: { surface: PanelSurface }) {
  const picture = useMemo(() => {
    const { slides } = readOutlineSlides(surface.text)
    const ref = surface.slide
    const at = slides.findIndex(slide => typeof ref === 'string' ? slide.id === ref : slide.line === ref.headingLine)
    if (at < 0 || !slides[at].id) return null
    const current = slides[at]
    const section = slides.slice(0, at).findLast(slide => slide.level === 2)
    const candidate = slides.slice(at + 1).find(slide => !slide.folded && slide.level <= current.level)
    const next = candidate && candidate.level > 2 ? candidate : undefined
    let text = surface.text
    if (next?.id && section) {
      try { text = setLayoutOptions(text, next.id, [option('title-look', 'titlelook=intro-then-none')]).outline }
      catch { /* The next slide can have its own title treatment. */ }
    }
    return { text, current, section, next }
  }, [surface.slide, surface.text])
  const { previewUrl } = useLiveSlidePreview(surface.path, picture?.text ?? '', picture?.current.id ?? '', 'intro-example')
  const base = previewUrl?.split('#')[0]
  return <><div className="tw-intro-sequence">
    {([
      [picture?.section?.id, 'The section slide names it'],
      [picture?.current.id, 'This slide follows it'],
      [picture?.next?.id, 'The next slide follows it']
    ] as const).map(([id, caption]) => id && <figure key={id}>
      <div className="tw-review-picture"><FixedDeckPreview title={caption} src={base ? base + '#' + encodeURIComponent(id) : undefined} /></div>
      <figcaption>{caption}</figcaption>
    </figure>)}
  </div><p>Every slide in this section follows the section slide without a title of its own. A slide before the section keeps a plain title.</p></>
}

export function TitlePage({ surface, where: compiledWhere, trigger, inheritedLook, inheritedTone, onTalk, children, section = false, icon, pictureAbove, tokens, pointCount }: {
  surface: PanelSurface
  trigger: string
  where: string
  inheritedLook: string
  inheritedTone: string
  onTalk: () => void
  children: ReactNode
  section?: boolean
  icon?: ReactNode
  pictureAbove: boolean
  tokens: Readonly<Record<string, string>>
  pointCount: number
}) {
  const look = GLOBAL_OPTION_GROUPS.find(group => group.key === 'title-look')!
  const tone = GLOBAL_OPTION_GROUPS.find(group => group.key === 'title-look-tone')!
  const current = groupHasSelection(trigger, look) ? selectionForGroup(trigger, look) : inheritedLook ? `titlelook=${inheritedLook}` : ''
  const currentTone = groupHasSelection(trigger, tone) ? selectionForGroup(trigger, tone) : inheritedTone ? 'titlelook-tone=soft' : ''
  const heading = typeof surface.slide === 'string'
    ? readOutlineSlides(surface.text).slides.find(slide => slide.id === surface.slide)?.start
    : surface.slide.headingLine - 1
  const explicitGroups = registryOptionGroups().filter(group => TITLE_GROUPS.includes(group.key) && groupHasSelection(trigger, group))
  const changed = explicitGroups.length > 0 ||
    (heading != null && !!iconKeyOnLine(surface.text, heading))
  const style = TITLE_STYLES.find(([, token, strength]) => current === token && (token !== 'titlelook=tab' || strength === currentTone))
  const inherited = TITLE_STYLES.find(([, token, strength]) => token === (inheritedLook ? `titlelook=${inheritedLook}` : '') &&
    (token !== 'titlelook=tab' || (strength !== '') === (inheritedTone === 'soft')))
  if (section) return <>{children}<p>A section slide shows its name. Its colour is under Colour.</p></>
  const headingLine = heading == null ? null : heading + 1
  const defaultPlacement = defaultTitlePlacementForLayout(surface.text, headingLine, surface.layout)
  const inheritedPlacement = pictureAbove && defaultPlacement === 'left' ? 'top' : defaultPlacement
  const explicitPlacement = explicitGroups.some(group => TITLE_PLACEMENT_GROUPS.includes(group.key))
  const statementSidebar = surface.layout === 'statement'
    ? statementSelections(trigger, { deckClaimStyle: deckClaimStyleForOutline(surface.text) })['statement-sidebar'] : ''
  const where = statementSidebar === 'statement-sidebar=on' && statementTitleHidden(surface.text, headingLine)
    ? 'hidden' : compiledWhere
  const listStyle = tokens['list-style']
  const boxedPoints = surface.layout === 'list' && (listStyle === 'iconlist' || listStyle === 'logolist') &&
    (tokens['iconlist-variant'] || (pointCount > 3 ? 'iconlist=list' : 'iconlist=boxes')) === 'iconlist=boxes'
  const sideReason = pictureAbove ? 'The picture needs the full width above the points'
    : statementSidebar === 'statement-sidebar=off' ? 'This statement’s design has no sidebar'
      : surface.layout === 'cycle' ? 'The title would take room from the cycle and its labels'
        : surface.layout === 'iconrow' || boxedPoints ? 'The points need the full width to keep their arrangement' : ''
  const placement = [['top', 'On top'], ['left', 'At the side'], ['hidden', 'Not shown']] as const
  return <>
    <ResetOrigin changed={changed} reset={() => surface.onKeep({ label: 'Talk title settings', reset: TITLE_GROUPS })} talk={onTalk}
      note={defaultPlacement === 'left' && pictureAbove && where === 'top'
        ? 'On top while the picture is above the points. The talk puts titles at the side.'
        : undefined}
      inherited={where === 'left' ? 'at the side' : where === 'hidden' ? 'title hidden' : `on top, ${inherited?.[0] ?? 'Plain'}`} />
    <h4>Where</h4>
    <RightPanelPictures {...surface} group="title-placement" choices={placement.map(([value, label]) => {
      const unavailable = value === where ? '' : value === 'left' ? sideReason
        : value === 'top' && statementSidebar === 'statement-sidebar=on' ? 'This statement’s design keeps its sidebar' : ''
      return {
        label,
        current: value === where,
        reapply: value === inheritedPlacement && explicitPlacement,
        ...(unavailable ? { unavailable }
          : value === inheritedPlacement ? { reset: TITLE_PLACEMENT_GROUPS }
            : { options: titlePlace(value === 'left' ? 'side' : value) })
      }
    })} />
    {where === 'left' && <ChoiceRow label="Panel width" choice={selectionForGroup(trigger, GLOBAL_OPTION_GROUPS.find(group => group.key === 'title-placement')!) || 'sidebar'}
      options={([30, 35, 40, 50] as const).map(n => [`split=${n}`, `${n}%`])} onChoose={token => surface.onKeep({label: 'Panel width', options: [option('title-placement', token)]})} />}
    {where === 'hidden' && <p>The title still names the slide in the slide list, in your notes and in links.</p>}
    <h4>Style</h4>
    {where === 'top' ? <RightPanelPictures {...surface} group="title-style" choices={TITLE_STYLES.map(([label, token, strength]) => ({
      label, current: style?.[0] === label,
      ...(label === inherited?.[0] ? { reset: ['title-look', 'title-look-tone'] } : {}),
      options: [option('title-look', token), ...(token === 'titlelook=tab' ? [option('title-look-tone', strength)] : [])]
    }))} /> : <p>Styles apply when the title is on top.</p>}
    {style?.[0] === 'Section strip' && <p>Shows the slides of this section, with this one marked.</p>}
    {style?.[0] === 'Intro only' && <IntroPicture surface={surface} />}
    {children}
    {icon}
  </>
}

export function PointsPage({ surface, tokens, onTalk, children, trigger, deckStyle, hasSubpoints, pointCount }: {
  surface: PanelSurface
  tokens: Readonly<Record<string, string>>
  onTalk: () => void
  children: ReactNode
  trigger: string
  deckStyle: string
  hasSubpoints: boolean
  pointCount: number
}) {
  const style = tokens['list-style'] ?? ''
  const variant = tokens['iconlist-variant'] || (pointCount > 3 ? 'iconlist=list' : 'iconlist=boxes')
  const marked = style === 'logolist' ? 'logolist' : 'iconlist'
  const listGroup = LAYOUTS.find(entry => entry.name === 'list')!.options![0]
  const isList = isPointListLayout(surface.layout)
  const isRow = surface.layout === 'iconrow'
  const arrange = (label: string, listStyle: string, treatment = ''): Design => {
    const matchesStyle = style === (listStyle === 'plainlist' ? '' : listStyle)
    return {
      label, ...(!isList && !isRow ? { layout: 'list' } : {}), clearRow: isRow,
      options: [option('list-style', listStyle), ...(treatment ? [option('iconlist-variant', treatment)] : [])],
      current: isList && matchesStyle && (!treatment || variant === treatment)
    }
  }
  const choices = [
    arrange('Bullets', 'plainlist'), arrange('Numbers', 'numbered'),
    arrange('Boxes', marked, 'iconlist=boxes'), { label: 'Row', layout: 'iconrow', current: isRow },
    ...(hasSubpoints ? [arrange('Notes under each', 'annotated')] : [])
  ]
  return <>
    <ResetOrigin changed={isRow || groupHasSelection(trigger, listGroup) || GLOBAL_OPTION_GROUPS.some(group =>
      ['font-body', 'iconlist-variant', 'number-style'].includes(group.key) && groupHasSelection(trigger, group))}
      inherited={deckStyle ? 'icons' : 'bullets'} talk={onTalk}
      reset={() => surface.onKeep({ label: 'Talk point settings', clearRow: isRow, reset: ['list-style', 'iconlist-variant', 'number-style', 'font-body'] })} />
    <h4>Arrangement</h4><RightPanelPictures {...surface} group="points" choices={choices} />
    {style === 'numbered' && <ChoiceRow label="Number style" choice={tokens['number-style'] ?? ''}
      options={[['', 'Coloured'], ['numbered=plain', 'Plain'], ['numbered=styled', 'Large']]}
      onChoose={token => surface.onKeep({ label: 'Number style', options: [option('number-style', token)] })} />}
    {children}<p>Arrangements that change the whole slide, such as a timeline or columns, are under Designs.</p>
  </>
}

export function TablePage({ surface, tokens, children }: { surface: PanelSurface; tokens: Readonly<Record<string, string>>; children: ReactNode }) {
  return <><h4>Style</h4><RightPanelPictures {...surface} group="table" choices={tableDesigns(tokens)} columns={2} />
    {children}<p>Edit the cells in the slide text.</p></>
}

export function PicturePage({ surface, side, children, actions }: {
  surface: PanelSurface; side: PictureSide | null; children: ReactNode
  actions?: { crop?: () => void; replace: () => void; remove: () => void }
}) {
  const choices = ([['right', 'On the right'], ['left', 'On the left'], ['above', 'Above']] as const).map(([value, label]) => ({
    label, current: value === side, options: [option('media-placement', `image=${value}`)]
  }))
  return <><h4>Where</h4><RightPanelPictures {...surface} group="picture" choices={choices} />{children}
    {actions && <><h4>This picture</h4><div className="tw-right-choice">
      {actions.crop && <button type="button" className="toolbar-btn" onClick={actions.crop}><Crop size={14} />Crop or mark up</button>}
      <button type="button" className="toolbar-btn" onClick={actions.replace}><Replace size={14} />Replace</button>
      <button type="button" className="toolbar-btn" onClick={actions.remove}><Trash2 size={14} />Remove from slide</button>
    </div><p>The original file stays in the talk’s folder. Cropping saves a separate copy.</p></>}
  </>
}

function iconKeyOnLine(text: string, line: number): string | null {
  const state = lineIconState(text, line)
  return state.ok ? state.key : null
}

export function IconRows({ text, lines, onIcon, onEscape, title = false }: {
  text: string
  lines: { line: number; name: string }[]
  onIcon: (line: number, icon: string | null, base: string) => void
  onEscape: () => void
  title?: boolean
}) {
  const [picker, setPicker] = useState<{ line: number; anchor: IconAnchor; text: string; button: HTMLButtonElement } | null>(null)
  const open = (event: MouseEvent<HTMLButtonElement>, line: number): void => {
    const button = event.currentTarget
    const { left, top, bottom } = button.getBoundingClientRect()
    setPicker({ line, anchor: { left, top, bottom }, text, button })
  }
  const close = (): void => { picker?.button.focus(); setPicker(null) }
  const choose = (icon: string | null): void => { if (picker) onIcon(picker.line, icon, picker.text); close() }
  return <>
    {lines.map(({ line, name }) => {
      const key = iconKeyOnLine(text, line)
      return <div className="tw-right-icon-row" key={line}>
        <button type="button" className="toolbar-btn" onClick={event => open(event, line)} aria-label={title ? undefined : `Choose an icon for ${name}`}>
          <SmilePlus size={16} />{title && (key ? 'Change icon' : 'Choose an icon')}
        </button>
        {!title && <span>{name}</span>}
        {key ? <><small>{key}</small><button type="button" className="toolbar-btn" onClick={() => onIcon(line, null, text)}>
          <RotateCcw size={14} />{title ? 'Remove' : 'Back to automatic'}</button></> : !title && <small>Automatic</small>}
      </div>
    })}
    {picker && <div onKeyDownCapture={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      event.preventDefault()
      event.stopPropagation()
      setPicker(null)
      onEscape()
    }}>
      <PlainIconPicker anchor={picker.anchor} place={title ? 'title' : 'list item'}
        current={iconKeyOnLine(picker.text, picker.line)} onPick={choose} onRemove={() => choose(null)} onClose={close} />
    </div>}
  </>
}

export function IconsPage({ surface, hasLogos, tokens, children }: {
  surface: PanelSurface
  hasLogos: boolean
  tokens: Readonly<Record<string, string>>
  children: ReactNode
}) {
  const style = tokens['list-style'] ?? ''
  const choices = [['plainlist', 'None'], ['iconlist', 'Icons'], ['logolist', 'Logos']].map(([token, label]) => ({
    label, current: (token === 'plainlist' ? '' : token) === style,
    options: [option('list-style', token)], ...(token === 'logolist' && !hasLogos ? { unavailable: 'No names with a known logo' } : {})
  }))
  return <><h4>Marks beside the points</h4><RightPanelPictures {...surface} group="icons" choices={choices} />
    <h4>Each point</h4>{style === 'iconlist' || style === 'logolist' ? children
      : <p>{style === 'numbered' ? 'Numbers are showing. Choose Icons to replace them.' : 'Choose Icons or Logos to pick a mark for each point.'}</p>}
  </>
}

export function ColourPage({ surface, trigger }: { surface: PanelSurface; trigger: string }) {
  const group = LAYOUTS.find(entry => entry.name === 'section-colour')!.options![0]
  const palette = parseFrontmatterPairs(surface.text).find(pair => pair.key === 'palette')?.value
  const selected = selectionForGroup(trigger, group)
  return <><h4>Section colour</h4><RightPanelPictures {...surface} group="section-colour" choices={sectionColourChoices(palette).map(value => ({
    label: value.label, current: value.token === selected, options: [option(group.key, value.token)]
  }))} /><p>Rotation gives each section the next colour of the talk’s design.</p></>
}

export function applyChoice(surface: PanelSurface, label: string, edit: PanelEdit): void {
  surface.onKeep({ label, ...edit })
}
