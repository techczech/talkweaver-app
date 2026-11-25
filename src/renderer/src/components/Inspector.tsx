import { markerCountLabel } from '../../../shared/video-marker-edits'
import { VideoMarkerPage, type VideoMarkerPanel } from './VideoMarkerPage'
import { offlinePageCandidates, type OfflinePageSelection } from '../lib/offlinePage'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronUp, Undo2 } from 'lucide-react'
import type { ProjectionRow, TalkInfo } from '../../../preload/index'
import type { LayoutDoctorFinding } from '../../../shared/layout-doctor'
import type { LayoutDef, OptionGroup } from '../data/layouts'
import { LAYOUTS } from '../data/layouts'
import { deckListStyleForSlide, deckStatementTokenForOutline, inheritedTitleLookForSlide, inheritedTitleToneForSlide, pictureSideForSlide } from '../../../shared/deck-frame'
import { plainInlineText } from '../../../../compiler/scripts/lib/00-inline-render.mjs'
import { readableSectionLabel } from './slideFocusModel'
import {
  extractInspectorSlideBlock, headingLineForSlideId, inspectorCommitToken, inspectorModel, sectionIdAtScrollTop,
  type InspectorBindingModel
} from './inspectorModel'
import { OptionControl } from './CommandPalette'
import {
  PaneMemory, paneAnchorAt, paneScrollTarget, tabJumpScrollTop, tabTrailingSpace, type PaneNode
} from './inspectorScroll'
import { surfacedWarnings } from './SlideStrip'
import { useLiveSlidePreview } from './useLiveSlidePreview'
import FixedDeckPreview, { type RevealPreviewStep } from './FixedDeckPreview'
import { headingHasChildSlides, logicalTriggerBlockAfterHeading, parseTriggerLine } from '../../../shared/trigger-line'
import type { SlideRef } from '../../../shared/layout-verbs'
import InspectorBoard from './InspectorBoard'
import QuoteFormNotes from './QuoteFormNotes'
import InspectorOptionPictures from './InspectorOptionPictures'
import VaultOrigin from './VaultOrigin'
import SlideProvenance from './SlideProvenance'
import TalkActivity from './TalkActivity'
import { DESIGN_PAGES, designsFor, option, OWN_LABELS, pageForBinding, type Design } from './rightPanelDesigns'
import { AdjustRows, ColourPage, DesignsBlock, IconRows, IconsPage, PageHead, PicturePage, PointsPage, sectionDesigns, TablePage, TitlePage, type PanelPage, type PanelSurface } from './RightPanelPages'
import RightPanelPictures, { type PanelTry } from './RightPanelPictures'
import './rightPanel.css'
import { editInlinePicture, pooledImageOnLine } from '../../../shared/image-edit'
import { readOutlineSlides, slidePointLines } from '../../../shared/feedback-accept'
import { slideIdOf } from './slideFocusModel'
import type { BoardEdit } from '../../../../compiler/scripts/lib/board-slide.mjs'
import InspectorPrework from './InspectorPrework'
import { inspectorPreworkModel } from './inspectorPreworkModel'
import { commandRan } from '../commands/command-ran'
import { savedViewsLabel, slideLivePages } from '../lib/captureEmbed'

interface Props {
  talk: TalkInfo
  compiledSlides: ProjectionRow[] | null
  outlineContent: string
  triggerFindings: readonly LayoutDoctorFinding[]
  activeIndex: number
  headingLine: number | null
  onPrev: () => void
  onNext: () => void
  navigationShortcuts?: { previous: string; next: string }
  onEdit: () => void
  onExplain: () => void
  onOpenLayoutDoctor: () => void
  /** Capture embed…: the capture window for one of the slide's web pages. */
  onCaptureEmbed?: (pageUrl: string) => void
  onSaveOffline?: (selection: OfflinePageSelection) => void
  offlineSaving?: boolean
  /** Remove from slide: takes one saved view's {capture} line out of the slide (the picture stays in the
   *  talk folder). `embed`: which embed of that address on the slide it is listed under (index of `of`). */
  videoMarkers?: VideoMarkerPanel
  onRemoveSavedView?: (pageUrl: string, image: string, embed: { index: number; of: number }) => void
  /** The layout section's "Change ⌘L": opens the layout picker (what ⌘L runs). */
  onOpenLayoutPicker?: () => void
  onCommitOption: (entry: LayoutDef | undefined, group: OptionGroup, token: string) => string | null
  /** ADR-0032: writes a Board section edit into the inspected slide's text; false when refused. */
  onBoardEdit: (edit: BoardEdit) => boolean
  /** ADR-0032 §2: while set, the column under the pinned preview is the layout picker (`column`), and the
   *  preview shows `tryOutline` (the outline as it would read with the layout being tried; nothing written). */
  picker?: { column: React.ReactNode; tryOutline: string | null; tryLabel: string | null } | null
  /** The layout section's Change button: opens the picker on this slide. */
  onChangeLayout?: () => void
  long?: boolean
  centrePreview?: boolean
  multiCount?: number
  preview?: PanelTry | null
  applied?: string | null
  onTry: (preview: PanelTry | null) => void
  onKeep: (slide: SlideRef, layout: string, design: Design) => void
  onUndo: () => void
  onTalk: (page: 'details' | 'design') => void
  onCopy?: (aspect: string) => void
  page: string
  onPageChange: (page: string) => void
  onIcon: (line: number, icon: string | null, base: string) => void
  onCropPicture: (line: number, id: string) => void
  onReplacePicture: (line: number) => void
  onRemovePicture: (line: number) => void
  onMarkdown: () => void
  structure?: { section: boolean; childCount: number; carousel: boolean; panes?: { title: string; select: () => void }[]; addSubslide: () => void; inheritedColour?: { value: string; selectSection: () => void } }

}

function triggerLineOf(outline: string, headingLine: number | null): string {
  if (headingLine == null) return ''
  const lines = outline.split('\n')
  const index = headingLine - 1
  const heading = parseTriggerLine(lines[index] ?? '').map(item => `{${item.source}}`).join('')
  return heading + (logicalTriggerBlockAfterHeading(lines, index)?.line ?? '')
}

export default function Inspector({
  talk, compiledSlides, outlineContent, triggerFindings, activeIndex, headingLine,
  onPrev, onNext, navigationShortcuts, onEdit, onExplain, onOpenLayoutDoctor, onCaptureEmbed, onSaveOffline, offlineSaving, onRemoveSavedView, videoMarkers, onCommitOption, onBoardEdit, picker = null,
  long = false, centrePreview = false, multiCount = 0, preview, applied, onTry, onKeep, onUndo, onTalk, onCopy, onIcon, onMarkdown, structure,
  onCropPicture, onReplacePicture, onRemovePicture, page, onPageChange
}: Props) {
  const row = compiledSlides?.[activeIndex] ?? null
  const block = useMemo(
    () => extractInspectorSlideBlock(outlineContent, headingLine) ?? '',
    [outlineContent, headingLine]
  )
  const read = useMemo(() => readOutlineSlides(outlineContent), [outlineContent])
  const points = useMemo(() => {
    const slide = read.slides.find(candidate => candidate.line === headingLine)
    return slide ? slidePointLines(read, slide) : []
  }, [read, headingLine])
  const triggerLine = useMemo(() => triggerLineOf(outlineContent, headingLine), [outlineContent, headingLine])
  // Capture embed…: the slide's web pages and their saved views ({capture} lines), from its text now.
  const livePages = useMemo(() => slideLivePages(block), [block])
  const headingLevel = block.match(/^(#{1,6})\s/)?.[1].length ?? 3
  const hasChildren = headingLine == null
    ? false
    : headingHasChildSlides(outlineContent.split('\n'), headingLine - 1)
  const deckListStyle = useMemo(() => deckListStyleForSlide(outlineContent, headingLine), [outlineContent, headingLine])
  const inheritedTitleTone = useMemo(() => inheritedTitleToneForSlide(outlineContent, headingLine), [outlineContent, headingLine])
  const inheritedTitleLook = useMemo(() => inheritedTitleLookForSlide(outlineContent, headingLine), [outlineContent, headingLine])
  const deckStatementToken = useMemo(() => deckStatementTokenForOutline(outlineContent), [outlineContent])
  // Ticket 27: a `{results=…}` slide's Results section.
  const prework = useMemo(
    () => inspectorPreworkModel(headingLine, triggerLine),
    [headingLine, triggerLine]
  )
  const model = useMemo(
    () => inspectorModel(
      compiledSlides, activeIndex, headingLevel, triggerLine, LAYOUTS, block, hasChildren, triggerFindings, deckListStyle, deckStatementToken, prework, inheritedTitleTone, inheritedTitleLook
    ),
    [compiledSlides, activeIndex, headingLevel, triggerLine, block, hasChildren, triggerFindings, deckListStyle, deckStatementToken, prework, inheritedTitleTone, inheritedTitleLook]
  )
  const entry = LAYOUTS.find((candidate) => candidate.name === model.layoutName)
  const slideId = row?.slide_id ?? ''
  // Own-slide pictures name the slide by its `{id=…}`, or by its heading line while the text has no id for it yet
  // (the compiler's derived id names no line of the outline).
  const pictureSlide: SlideRef | null = !row ? null
    : slideId && headingLineForSlideId(outlineContent, slideId) != null ? slideId
    : headingLine != null ? { headingLine } : null
  const warnings = surfacedWarnings(row, 'inspector', triggerFindings)
  const unresolvedWarnings = warnings.filter((warning) =>
    warning.id === 'unresolved-trigger' || warning.id === 'unknown-trigger'
  )
  const unresolvedTokens = model.unresolvedFindings
    .map((finding, index) => ({
      token: finding.token,
      text: unresolvedWarnings[index]?.text ?? finding.detail ?? finding.token
    }))
  // Trigger-line changes are option commits: bypass the ordinary typing debounce so every
  // selection recompiles the stage immediately, as locked in ADR-0011.
  const { previewUrl, compiling, previewErr } = useLiveSlidePreview(talk.outlinePath, centrePreview && !picker ? '' : picker?.tryOutline ?? preview?.text ?? outlineContent, row?.slide_id ?? '')
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [fallbackStep, setFallbackStep] = useState(0)
  const [revealed, setRevealed] = useState<RevealPreviewStep>()
  const liveReveal = revealed && revealed.src === previewUrl ? revealed : undefined
  const stepMode = liveReveal ? 'reveal' : model.steps.mode
  const stepCount = liveReveal?.count ?? (row?.reveal_enabled ? 0 : model.steps.count)
  const step = liveReveal?.step ?? fallbackStep
  useEffect(() => { setFallbackStep(0) }, [activeIndex, previewUrl, stepCount, stepMode])

  const moveStep = (direction: -1 | 1): void => {
    const next = Math.max(0, Math.min(stepCount, step + direction))
    if (next === step) return
    const key = direction > 0 ? 'ArrowRight' : 'ArrowLeft'
    iframeRef.current?.contentWindow?.postMessage({ type: 'tw-step', key }, '*')
    if (!liveReveal) setFallbackStep(next)
  }

  // The options pane works as tabs (Dominik's preview.11 check, 29 Sep): the preview head and the
  // chip row stay pinned; only the options scroll. A chip puts its section's heading at the top of
  // the pane (trailing space lets the last one get there); the lit chip is the section at the top,
  // read from scroll position. The pane's place is held as an anchor per slide (inspectorScroll.ts)
  // and put back after every render, so an option change never moves what the user is looking at.
  const inspectorRef = useRef<HTMLElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const tailRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const paneMemory = useRef(new PaneMemory())
  const paneSlideRef = useRef<string | null>(null)
  const slideKey = row?.slide_id || `index:${activeIndex}`
  const slideKeyRef = useRef(slideKey)
  slideKeyRef.current = slideKey
  const changePage = (id: string): void => {
    onTry(null)
    onPageChange(id)
    if (paneRef.current) paneRef.current.scrollTop = 0
    // The button that opened the page is gone as soon as the page renders.
    inspectorRef.current?.focus({ preventScroll: true })
  }
  const [litSection, setLitSection] = useState<string | null>(null)

  const paneNodes = (pane: HTMLElement): PaneNode[] => {
    const origin = pane.getBoundingClientRect().top - pane.scrollTop
    return [...pane.querySelectorAll<HTMLElement>('.tw-inspector-section, .tw-inspector-group')].map((element) => ({
      key: element.dataset.section ? `section:${element.dataset.section}` : `group:${element.dataset.group ?? ''}`,
      top: element.getBoundingClientRect().top - origin
    }))
  }
  const sectionTops = (nodes: readonly PaneNode[]): { id: string; top: number }[] => nodes
    .filter((node) => node.key.startsWith('section:'))
    .map((node) => ({ id: node.key.slice('section:'.length), top: node.top }))
  const readLitSection = (pane: HTMLElement, nodes: readonly PaneNode[]): void => {
    setLitSection(sectionIdAtScrollTop(sectionTops(nodes), pane.scrollTop + 2))
  }
  const sizeTail = (pane: HTMLElement): void => {
    const tail = tailRef.current
    const last = [...pane.querySelectorAll<HTMLElement>('.tw-inspector-section')].at(-1)
    if (!tail) return
    if (!last) { tail.style.height = '0px'; return }
    const origin = pane.getBoundingClientRect().top - pane.scrollTop
    const rect = last.getBoundingClientRect()
    const contentEnd = rect.bottom - origin + (parseFloat(getComputedStyle(pane).paddingBottom) || 0)
    tail.style.height = `${tabTrailingSpace(pane.clientHeight, rect.top - origin, contentEnd)}px`
  }
  // After every render (and whenever the pane or its content changes size): size the trailing
  // space, then put the pane back at this slide's anchor.
  const settlePane = (): void => {
    const pane = paneRef.current
    if (!pane) return
    // Read before re-sizing the trailing space: a pane the render cut short shows as pulled back.
    const current = pane.scrollTop
    const maxScrollTop = pane.scrollHeight - pane.clientHeight
    sizeTail(pane)
    const nodes = paneNodes(pane)
    const key = slideKeyRef.current
    const target = paneScrollTarget(paneMemory.current, key, paneSlideRef.current, nodes, current, maxScrollTop)
    paneSlideRef.current = key
    if (Math.abs(pane.scrollTop - target) > 1) pane.scrollTop = target
    if (nodes.length > 0) paneMemory.current.remember(key, paneAnchorAt(nodes, pane.scrollTop))
    readLitSection(pane, nodes)
  }
  const settleRef = useRef(settlePane)
  settleRef.current = settlePane
  useLayoutEffect(() => { settlePane() })
  useLayoutEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const observer = new ResizeObserver(() => settleRef.current())
    observer.observe(pane)
    return () => observer.disconnect()
  }, [model.unresolved, picker != null])

  const onPaneScroll = (): void => {
    const pane = paneRef.current
    if (!pane) return
    const nodes = paneNodes(pane)
    // A pane emptied for a moment (a recompile) must not overwrite the slide's place.
    if (nodes.length > 0) paneMemory.current.remember(slideKeyRef.current, paneAnchorAt(nodes, pane.scrollTop))
    readLitSection(pane, nodes)
  }
  const scrollToSection = (id: string): void => {
    const pane = paneRef.current
    const section = sectionRefs.current.get(id)
    if (!pane || !section) return
    sizeTail(pane)
    const top = section.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop
    pane.scrollTop = tabJumpScrollTop(top, pane.scrollHeight - pane.clientHeight)
    const nodes = paneNodes(pane)
    paneMemory.current.remember(slideKeyRef.current, paneAnchorAt(nodes, pane.scrollTop))
    setLitSection(id)
  }

  const renderGroup = (binding: InspectorBindingModel, children: InspectorBindingModel[] = []): React.JSX.Element => (
    <div
      className={`tw-inspector-group${binding.nestedUnder ? ' tw-inspector-group--nested' : ''}`}
      // The Reactions group holds a mode opened but not yet written (ticket 04); a new slide or a
      // new token starts it afresh.
      key={binding.group.reactionsKey ? `${binding.group.key}:${slideKey}:${binding.selectedToken}` : binding.group.key}
      data-group={binding.group.key}
    >
      <span className="tw-inspector-group-label">{OWN_LABELS[binding.group.key] ?? binding.group.sectionLabel ?? binding.group.label}</span>
      {binding.pictures && pictureSlide ? (
        <>
          <InspectorOptionPictures
            outlinePath={talk.outlinePath}
            outline={outlineContent}
            slide={pictureSlide}
            groupKey={binding.group.key}
            groupLabel={binding.group.label}
            set={binding.pictures}
            selectedToken={binding.selectedToken}
            commitToken={(value) => inspectorCommitToken(binding, value.token)}
            onSelect={(value) => {
              onCommitOption(binding.source === 'entry' ? (binding.owner ?? entry) : undefined, binding.group, inspectorCommitToken(binding, value.token))
            }}
          />
          {binding.pictures.rest.length > 0 && (binding.selectedToken === 'sidebar' || binding.pictures.rest.some((value) => value.token === binding.selectedToken)) && (
            <div className="tw-inspector-group tw-inspector-group--nested">
              <span className="tw-inspector-group-label">Width</span>
              <OptionControl
                entry={undefined}
                binding={{ group: binding.group, selectedToken: binding.selectedToken }}
                values={[{ token: 'sidebar', label: 'Auto' }, ...binding.pictures.rest]}
                onSelect={(group, token) => { onCommitOption(undefined, group, token) }}
              />
            </div>
          )}
        </>
      ) : (
        <OptionControl
          entry={binding.source === 'entry' ? (binding.owner ?? entry) : undefined}
          binding={{ group: binding.group, selectedToken: binding.selectedToken }}
          values={binding.values}
          deckToken={binding.deckToken}
          onSelect={(group, token) => {
            onCommitOption(binding.source === 'entry' ? (binding.owner ?? entry) : undefined, group, inspectorCommitToken(binding, token))
          }}
        />
      )}
      {binding.group.key === 'quote-form' && pictureSlide && <QuoteFormNotes outline={outlineContent} slide={pictureSlide} compiledLayout={typeof row?.layout === 'string' ? row.layout : undefined} />}
      {children.map((child) => renderGroup(child))}
    </div>
  )

  const returnHome = (): void => changePage('home')
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing &&
        !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !picker && !long && pageInfo) {
      event.preventDefault()
      event.stopPropagation()
      returnHome()
      return
    }
    if (!event.altKey) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      event.key === 'ArrowUp' ? onPrev() : onNext()
      commandRan('app.inspector-slides')
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      event.stopPropagation()
      moveStep(event.key === 'ArrowLeft' ? -1 : 1)
      commandRan('app.inspector-steps')
    }
  }

  const layout = row?.has_table && ['list', undefined].includes(model.layoutName) ? 'table' : model.layoutName ?? 'list'
  const table = row?.has_table || layout === 'table' || layout === 'table-outline'
  const section = structure?.section ?? false
  const own = structure?.panes ? 'Subslides' : model.board ? 'Board' : livePages.length ? 'Web page'
    : model.selectedTokens['poll-type']?.startsWith('poll=') ? 'Poll' : DESIGN_PAGES[layout]
  const titleSlide = row?.role === 'opening' && row.layout === 'title' && row.source_line == null && !row.source_markdown
  const hasBesidePicture = row?.image_placements?.some(placement => placement.kind === 'beside') ?? false
  const hasAbovePicture = row?.image_placements?.some(placement => placement.kind === 'above') ?? false
  const pictureSide = useMemo(() => hasAbovePicture ? 'above' : hasBesidePicture ? pictureSideForSlide(outlineContent, headingLine) : null,
    [hasAbovePicture, hasBesidePicture, headingLine, outlineContent])
  const bindings = model.sections.flatMap(item => item.bindings)
  const arrival = bindings.find(binding => binding.group.key === 'arrival-mode')
  const legacyReveal = !arrival?.selectedToken && parseTriggerLine(triggerLine).some(token => token.source === 'reveal=steps')
  const revealSelected = arrival?.selectedToken === 'reveal' || legacyReveal
  const revealOn = revealSelected && model.selectedTokens.stepping !== 'nostep'
  const toggleReveal = (): void => {
    if (!arrival) return
    // The compiler still accepts {reveal=steps}. Treat it as an alias when clearing Steps.
    const group = legacyReveal ? {
      ...arrival.group,
      values: arrival.group.values.map(value => value.token === 'reveal'
        ? { ...value, altTokens: [...(value.altTokens ?? []), 'reveal=steps'] }
        : value)
    } : arrival.group
    onCommitOption(undefined, group, inspectorCommitToken(arrival, revealSelected ? '' : 'reveal'))
  }
  const revealAction = revealOn
    ? { label: 'Turn off', accessibleLabel: 'Turn reveal off' }
    : revealSelected
      ? { label: 'Remove reveal', accessibleLabel: 'Remove reveal setting' }
      : { label: 'Turn on', accessibleLabel: 'Turn reveal on' }
  const revealSummary = `Reveal one by one · ${revealOn ? 'on' : 'off'}`
  const stepsControl = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (page === 'steps' && stepsControl.current) {
      stepsControl.current.closest('.tw-inspector-pane')?.scrollTo({ top: 0 })
      stepsControl.current.focus({ preventScroll: true })
    }
  }, [page, arrival != null])
  const pages: PanelPage[] = [
    ...(section ? [{ id: 'colour', label: 'Colour', summary: 'Section colour' }] : []),
    { id: 'title', label: 'Title', summary: section ? 'Section name, large' : row?.title_layout === 'left' ? 'At the side' : row?.title_layout === 'hidden' ? 'Not shown' : 'On top' },
    ...(table ? [{ id: 'table', label: 'Table', summary: 'Style and text size' }] : own ? [{ id: 'own', label: own, summary: structure?.panes ? `${structure.panes.length} subslides` : 'Options for this design' }] : !section ? [
      { id: 'points', label: 'Points', summary: model.selectedTokens['list-style'] === 'numbered' ? 'Numbers' : 'Arrangement and size' },
      { id: 'icons', label: 'Icons', summary: 'Marks beside the points' }
    ] : []),
    ...(!section && !!row?.image_count ? [{ id: 'picture', label: 'Picture', summary: pictureSide === 'left' ? 'On the left'
      : pictureSide === 'right' ? 'On the right' : pictureSide === 'above' ? 'Above the points' : 'Placement and editing' }] : []),
    ...(videoMarkers ? [{ id: 'video', label: 'Video', summary: markerCountLabel(videoMarkers.selected.markers.length) }] : []),
    ...(arrival && (revealSelected || page === 'steps') ? [{
      id: 'steps', label: 'Steps', summary: revealSummary,
      action: { ...revealAction, run: toggleReveal }
    }] : []),
    { id: 'more', label: 'More', summary: section ? 'Steps, reactions, about this slide' : 'Steps, background, poll, reactions' }
  ]
  const pageInfo = pages.find(candidate => candidate.id === page)
  const subsection = row?.subsection && compiledSlides?.find(candidate => candidate.role === 'subsection-title' && candidate.subsection === row.subsection)
  const slidePlace = [readableSectionLabel(compiledSlides, activeIndex), subsection ? plainInlineText(subsection.nav_title || subsection.title) : ''].filter(Boolean).join(' › ')
  const showPage = (id: string): boolean => long || (pageInfo ? id === page : false)
  const surface: PanelSurface | null = pictureSlide ? {
    path: talk.outlinePath, text: outlineContent, slide: pictureSlide, layout, onTry,
    onKeep: design => onKeep(pictureSlide, layout, design), onCopy
  } : null
  const [brands, setBrands] = useState<{ block: string; found: boolean } | null>(null)
  useEffect(() => {
    if (!window.tw?.icons?.hasBrandPoints) return
    if (!points.length) return
    let current = true
    const labels = points.slice(0, 150).map(point => point.text.slice(0, 1024))
    void window.tw.icons.hasBrandPoints(labels).then(found => { if (current) setBrands({ block, found }) }).catch(() => {})
    return () => { current = false }
  }, [block, points])
  const hasBrands = brands?.block === block && brands.found
  const designs = useMemo((): Design[] => {
    if (!pictureSlide || !row || model.unresolved || titleSlide) return []
    try {
      return section && structure ? sectionDesigns({ modes: true, carousel: structure.carousel, childCount: structure.childCount, trigger: triggerLine })
        : designsFor(outlineContent, pictureSlide, row, {...model, layoutName: layout}, block, hasBrands, pictureSide)
    } catch { return [] }
  }, [outlineContent, slideKey, row, model, block, section, structure?.carousel, structure?.childCount, titleSlide, triggerLine, hasBrands, layout, pictureSide]) // eslint-disable-line react-hooks/exhaustive-deps
  const pageGroups = (id: string, omit: readonly string[] = []): React.ReactNode =>
    bindings.filter(binding => pageForBinding(binding, own, table) === id && !omit.includes(binding.group.key))
      .map(binding => {
        const { group } = binding
        if (!surface || id !== 'own' || !['thumbs'].includes(group.preview ?? '') &&
          !['quote-form', 'palette', 'direction'].includes(group.key)) return renderGroup({ ...binding, nestedUnder: undefined })
        return <div className="tw-inspector-group" data-group={group.key} key={group.key}>
          <h4>{OWN_LABELS[group.key] ?? group.label}</h4>
          <RightPanelPictures {...surface} group={group.key} choices={binding.values
            .filter(value => !(group.key === 'variant' && value.token === 'contrast=cards'))
            .map(value => ({
              label: value.label === 'Tweet' ? 'Post' : value.label === 'Web' ? 'Web page' : value.label,
              current: value.token === binding.selectedToken, options: [option(group.key, value.token)]
            }))} />
          {group.key === 'quote-form' && pictureSlide && <QuoteFormNotes outline={outlineContent} slide={pictureSlide} compiledLayout={layout} />}
        </div>
      })
  const titleIcon = headingLine == null ? null : <>
    <h4>Icon in the title</h4><IconRows key={slideKey} text={outlineContent} lines={[{ line: headingLine - 1, name: model.title }]} onIcon={onIcon} onEscape={returnHome} title />
    {bindings.filter(binding => binding.group.key === 'title-icon').map(binding => renderGroup(binding))}
  </>
  const linePoints = points.map(point => ({ line: point.line, name: point.text.replace(/\s*\{icon=[^}]+\}\s*$/, '') }))
  const pictureLine = useMemo(() => {
    if (headingLine == null || row?.image_count !== 1) return null
    const { notes, blanked } = read
    const matches = block.split('\n').flatMap((line, index) => {
      const at = headingLine + index - 1
      return !notes.has(at) && line.includes('![') && blanked[at]?.includes('![') &&
        editInlinePicture(outlineContent, at, null) != null ? [at] : []
    })
    return matches.length === 1 ? matches[0] : null
  }, [block, headingLine, row?.image_count, outlineContent, read])
  const pictureId = pictureLine == null ? null : pooledImageOnLine(outlineContent.split('\n')[pictureLine], outlineContent, pictureLine)

  const inspectorTitle = multiCount > 1 ? `${multiCount} slides selected` : model.title

  return (
    <aside ref={inspectorRef} className="tw-inspector" aria-label="Inspector" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="tw-inspector-preview-head">
        <div className="tw-right-who">
          <div><strong title={inspectorTitle}>{inspectorTitle}</strong>
            <small>{multiCount > 1 ? 'Choose one slide to see its designs' : `${section ? 'Section · slide' : 'Slide'} ${activeIndex + 1} of ${compiledSlides?.length ?? 0}${slidePlace ? ' · ' + slidePlace : ''}`}</small></div>
          {multiCount <= 1 && <>
            <button type="button" className="toolbar-btn" onClick={onPrev} disabled={activeIndex <= 0} aria-label="Previous slide"
              title={navigationShortcuts && `Previous slide (${navigationShortcuts.previous})`}><ChevronUp size={16} /></button>
            <button type="button" className="toolbar-btn" onClick={onNext} disabled={activeIndex >= (compiledSlides?.length ?? 1) - 1} aria-label="Next slide"
              title={navigationShortcuts && `Next slide (${navigationShortcuts.next})`}><ChevronDown size={16} /></button>
          </>}
        </div>
        {(!centrePreview || picker) && multiCount <= 1 && <>
        <div className={`tw-inspector-stage ${compiling ? 'is-compiling' : ''}${picker?.tryOutline ? ' is-trying' : ''}`} data-panel-trying={!picker && !!preview || undefined} title="Double-click to jump to source">
          {previewErr && previewUrl == null ? (
            <div className="tw-inspector-preview-error">
              {block ? <><AlertTriangle /> Preview unavailable</> : <span className="tw-inspector-preview-quiet">Auto-generated slide — no source to inspect</span>}
            </div>
          ) : (
            /* twpresent gives trusted app-generated output its own origin; a sandbox would only
               disable capabilities the deck runtime legitimately needs. */
            <FixedDeckPreview iframeRef={iframeRef} onRevealStep={setRevealed} title="Inspector live preview" src={previewUrl ?? undefined} />
          )}
          <div
            className="tw-inspector-stage-hit"
            role="button"
            tabIndex={0}
            aria-label="Jump to this slide in the outline"
            title="Double-click to jump to source"
            onDoubleClick={onEdit}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEdit() } }}
          />
          {!picker && preview && <div className="tw-right-bar is-trying tw-try-chip" role="status">Trying: {preview.label}. Not applied.</div>}
        </div>
        {!picker && stepCount > 0 && (
          <div className="tw-inspector-stepbar">
            <button type="button" onClick={() => moveStep(-1)} disabled={step <= 0} title="Step back (⌥←)">◂</button>
            <button type="button" onClick={() => moveStep(1)} disabled={step >= stepCount} title="Step forward (⌥→)">▸</button>
            <span>step {step} / {stepCount} · {stepMode}</span>
            {warnings.length > 0 && <span className="tw-inspector-warning" title={warnings.map((warning) => warning.text).join('\n')}>⚠ {warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
            <button type="button" className="tw-inspector-explain" onClick={onExplain} title="Authoring markup, examples and rendering decisions">Explain &amp; markup</button>
          </div>
        )}
        </>}
        {!centrePreview && !picker && applied && <div className="tw-right-bar" role="status"><Check size={15} />Applied: {applied}<button type="button" className="toolbar-btn" onClick={onUndo}><Undo2 size={14} />Undo</button></div>}
      </div>

      {picker?.column}

      {!picker && long && !titleSlide && !model.unresolved && multiCount <= 1 && <div className="tw-inspector-jumplist" role="navigation" aria-label="Jump to">
        {[{id: 'designs', label: 'Designs'}, ...pages].map(chip => <button key={chip.id} type="button"
          className={litSection === chip.id ? 'is-lit' : undefined} aria-current={litSection === chip.id ? 'true' : undefined}
          onClick={() => scrollToSection(chip.id)}>{chip.label}</button>)}
      </div>}

      {!picker && multiCount <= 1 && <div
        className={`tw-inspector-pane${model.unresolved ? '' : ' tw-inspector-options'}`}
        ref={paneRef}
        onScroll={onPaneScroll}
      >
        {model.unresolved ? (
          <div className="tw-inspector-unresolved" role="alert">
            <div className="tw-inspector-unresolved-title"><AlertTriangle /> Needs a look</div>
            <div className="tw-inspector-unresolved-list">
              {unresolvedTokens.map((warning, index) => (
                <div className="tw-inspector-unresolved-row" key={`${warning.token}:${index}`}>
                  <code>{warning.token}</code>
                  <span>{warning.text}</span>
                </div>
              ))}
            </div>
            <button type="button" onClick={onOpenLayoutDoctor}>Fix it</button><button type="button" onClick={onMarkdown}>Show it in Markdown</button>
          </div>
        ) : titleSlide ? <>
          <h3>This slide</h3><p>Made from the talk’s details: its title, subtitle and your name.</p>
          <button type="button" className="toolbar-btn" onClick={() => onTalk('details')}>Edit talk details</button><button type="button" className="toolbar-btn" onClick={() => onTalk('design')}>Talk design</button>
          <VaultOrigin key={talk.outlinePath} outlinePath={talk.outlinePath} outlineContent={outlineContent} />
        </> : surface && <>
          {(long || !pageInfo) && <section className="tw-inspector-section" data-section="designs"
            ref={element => { if (element) sectionRefs.current.set('designs', element); else sectionRefs.current.delete('designs') }}>
            <DesignsBlock key={slideKey} surface={surface} designs={designs} long={long} compact={!centrePreview} section={section} />
          </section>}
          {!long && !pageInfo && <AdjustRows pages={pages} choose={changePage} />}
          {pages.filter(item => showPage(item.id)).map(item => <section key={item.id} data-section={item.id}
            ref={element => { if (element) sectionRefs.current.set(item.id, element); else sectionRefs.current.delete(item.id) }}
            className="tw-inspector-section tw-right-page" aria-label={item.label}>
            <PageHead label={item.label} aspect={item.id === 'own' ? item.label : item.id} back={long ? undefined : () => changePage('home')} onCopy={onCopy} />
            {item.id === 'title' && <TitlePage surface={surface} where={row?.title_layout ?? 'top'} trigger={triggerLine} pictureAbove={hasAbovePicture}
              tokens={model.selectedTokens} pointCount={points.length}
              inheritedLook={inheritedTitleLook} inheritedTone={inheritedTitleTone} onTalk={() => onTalk('design')} section={section} icon={titleIcon}>
              {bindings.filter(binding => binding.group.key === 'font-title').map(binding => renderGroup(binding))}
            </TitlePage>}
            {item.id === 'points' && <PointsPage surface={surface} tokens={model.selectedTokens} trigger={triggerLine}
              onTalk={() => onTalk('design')} deckStyle={deckListStyle} hasSubpoints={/^ {2,}[-*+] /m.test(block)} pointCount={points.length}>
              {bindings.filter(binding => binding.group.key === 'font-body').map(binding => renderGroup(binding))}
            </PointsPage>}
            {item.id === 'icons' && <IconsPage surface={surface} hasLogos={hasBrands} tokens={model.selectedTokens}>
              <IconRows key={slideKey} text={outlineContent} lines={linePoints} onIcon={onIcon} onEscape={returnHome} />
              {/^ {2,}[-*+] /m.test(block) && pageGroups('icons')}
            </IconsPage>}
            {item.id === 'picture' && <PicturePage surface={surface} side={pictureSide}
              actions={pictureLine == null ? undefined : {
                crop: pictureId ? () => onCropPicture(pictureLine, pictureId) : undefined,
                replace: () => onReplacePicture(pictureLine), remove: () => onRemovePicture(pictureLine)
              }}>
              {pageGroups('picture', ['media-placement'])}
            </PicturePage>}
            {item.id === 'video' && videoMarkers && <VideoMarkerPage key={slideKey} panel={videoMarkers} />}
            {item.id === 'table' && <TablePage surface={surface} tokens={model.selectedTokens}>
              {bindings.filter(binding => binding.group.key === 'font-body').map(binding => renderGroup(binding))}
            </TablePage>}
            {item.id === 'colour' && (structure?.inheritedColour ? <div className="tw-right-origin">
              <span>Follows its section.</span><button type="button" className="toolbar-btn" onClick={structure.inheritedColour.selectSection}>Change colour on its section</button>
            </div> : <ColourPage surface={surface} trigger={triggerLine} />)}
            {item.id === 'own' && <>
              {structure?.panes && <><h4>Subslides of this slide</h4><div className="tw-right-adjust">
                {structure.panes.map((child, index) => <button type="button" key={index} onClick={child.select}>{index + 1}<strong>{child.title}</strong></button>)}
              </div><button type="button" className="toolbar-btn" onClick={structure.addSubslide}>New subslide</button></>}
              {onSaveOffline && offlinePageCandidates(outlineContent, headingLine).map(candidate => <div key={candidate.line}>
                <p>{candidate.source}</p><button type="button" className="toolbar-btn" disabled={offlineSaving}
                  onClick={() => onSaveOffline({ line: candidate.line, text: candidate.text })}>{offlineSaving ? 'Saving…' : 'Save offline copy'}</button>
              </div>)}
              {model.board && <InspectorBoard board={model.board} slideKey={slideKey} onEdit={onBoardEdit}
                settings={bindings.filter(binding => binding.group.key.startsWith('board-')).map(binding => renderGroup(binding))} />}
              {pageGroups('own', model.board ? bindings.filter(binding => binding.group.key.startsWith('board-')).map(binding => binding.group.key) : [])}
            </>}
            {item.id === 'steps' && <div className="tw-right-reveal-setting">
              <span>{revealSummary}</span>
              <button type="button" ref={stepsControl} className="toolbar-btn" onClick={toggleReveal}
                aria-label={revealAction.accessibleLabel}>{revealAction.label}</button>
            </div>}
            {item.id === 'more' && <>
              {pageGroups('more')}
              {model.prework && <InspectorPrework model={model.prework} onResults={token => { if (model.prework) onCommitOption(undefined, model.prework.results.group, token) }} />}
              <h4>About this slide</h4><button type="button" className="toolbar-btn" onClick={onExplain}>Explain how this slide was made</button>
              {warnings.length > 0 && <p>{warnings.map(warning => warning.text).join(' · ')}</p>}
              {activeIndex === 0 && <VaultOrigin outlinePath={talk.outlinePath} outlineContent={outlineContent} />}
              <SlideProvenance outlinePath={talk.outlinePath} slideId={slideIdOf(block)} />
              <TalkActivity outlinePath={talk.outlinePath} />
            </>}
          </section>)}
            {showPage('own') && livePages.length > 0 && (
              <section
                className="tw-inspector-section tw-inspector-web-pages"
                data-section="web-page"
                aria-label="Web page"
                ref={(element) => { if (element) sectionRefs.current.set('web-page', element); else sectionRefs.current.delete('web-page') }}
              >
                <h3 className="tw-inspector-section-heading">Web page</h3>
                {livePages.map((page, n) => {
                  // The same address can be embedded more than once: each listing names its own embed.
                  const embed = { index: livePages.slice(0, n).filter((p) => p.pageUrl === page.pageUrl).length, of: livePages.filter((p) => p.pageUrl === page.pageUrl).length }
                  return (
                  <div className="tw-inspector-web-page-group" key={`${page.pageUrl}#${embed.index}`} data-page-url={page.pageUrl}>
                    <div className="tw-inspector-web-page">
                      <div className="tw-inspector-web-page-what">
                        <a
                          className="tw-inspector-web-page-host"
                          href={page.pageUrl}
                          title={`Open ${page.pageUrl} in your browser`}
                          data-open-page
                          onClick={(event) => { event.preventDefault(); void window.tw.shell.openExternal(page.pageUrl) }}
                        >Open {page.host} ↗</a>
                        <span className="tw-inspector-web-page-count" data-count={page.count}>{savedViewsLabel(page.count)}</span>
                      </div>
                      {onCaptureEmbed && (
                        <button type="button" className="tw-inspector-change" data-capture-embed onClick={() => onCaptureEmbed(page.pageUrl)}>
                          Capture embed…
                        </button>
                      )}
                    </div>
                    {onRemoveSavedView && page.images.map((image, n) => (
                      <div className="tw-inspector-saved-view" key={`${image}#${n}`} data-saved-view={image}>
                        <span className="tw-inspector-saved-view-name" title={image}>{page.alts[n] || image}</span>
                        <button
                          type="button"
                          className="tw-inspector-change"
                          data-remove-saved-view
                          title="Take this saved view off the slide. The picture stays in the talk folder; Undo puts it back."
                          onClick={() => onRemoveSavedView(page.pageUrl, image, embed)}
                        >Remove from slide</button>
                      </div>
                    ))}
                  </div>
                  )
                })}
              </section>
            )}
            {long && <div className="tw-inspector-tail" ref={tailRef} aria-hidden="true" />}
          </>}
      </div>}
    </aside>
  )
}
