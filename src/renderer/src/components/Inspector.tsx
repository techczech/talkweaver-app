import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'
import type { ProjectionRow, RecordingSession, TalkInfo } from '../../../preload/index'
import type { LayoutDoctorFinding } from '../../../shared/layout-doctor'
import type { LayoutDef, OptionGroup } from '../data/layouts'
import { LAYOUTS } from '../data/layouts'
import { deckListStyleForSlide, deckStatementTokenForOutline } from '../../../shared/deck-frame'
import {
  extractInspectorSlideBlock, headingLineForSlideId, inspectorCommitToken, inspectorModel, sectionIdAtScrollTop,
  type InspectorBindingModel
} from './inspectorModel'
import { OptionControl } from './CommandPalette'
import { liveShortcutLabel } from '../keymap/store'
import {
  PaneMemory, paneAnchorAt, paneScrollTarget, tabJumpScrollTop, tabTrailingSpace, type PaneNode
} from './inspectorScroll'
import { surfacedWarnings } from './SlideStrip'
import { useLiveSlidePreview } from './useLiveSlidePreview'
import FixedDeckPreview from './FixedDeckPreview'
import { headingHasChildSlides } from '../../../shared/trigger-line'
import type { SlideRef } from '../../../shared/layout-verbs'
import InspectorBoard from './InspectorBoard'
import InspectorOptionPictures from './InspectorOptionPictures'
import VaultOrigin from './VaultOrigin'
import SlideProvenance from './SlideProvenance'
import TalkActivity from './TalkActivity'
import { slideIdOf } from './slideFocusModel'
import type { BoardEdit } from '../../../../compiler/scripts/lib/board-slide.mjs'
import { preworkFromOutline } from '../../../../compiler/scripts/lib/prework.mjs'
import InspectorPrework from './InspectorPrework'
import { inspectorPreworkModel } from './inspectorPreworkModel'
import { preworkEnabled } from '../../../shared/prework-flag'
import { usePlannedRuns } from './usePlannedRuns'
import { localToday, nextPlannedRun } from '../../../shared/plan-run'

interface Props {
  talk: TalkInfo
  compiledSlides: ProjectionRow[] | null
  outlineContent: string
  triggerFindings: readonly LayoutDoctorFinding[]
  activeIndex: number
  headingLine: number | null
  onPrev: () => void
  onNext: () => void
  onEdit: () => void
  onExplain: () => void
  onOpenLayoutDoctor: () => void
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
  /** Ticket 08: writes the inspected quick check's right answer (0-based option; -1 clears). */
  onRightAnswer: (optionIndex: number) => boolean
  /** Ticket 08: open the plan sheet for a new Run (null) or to edit the given one. */
  onPlanRun: (run: RecordingSession | null) => void
  /** Ticket 08: inspect the slide with this id (a step of the pre-work form). */
  onInspectSlideId: (slideId: string) => void
}

function triggerLineOf(block: string): string {
  const candidate = block.split('\n')[1] ?? ''
  return /^\s*(\{[^}]*\}\s*)+$/.test(candidate) ? candidate : ''
}

export default function Inspector({
  talk, compiledSlides, outlineContent, triggerFindings, activeIndex, headingLine,
  onPrev, onNext, onEdit, onExplain, onOpenLayoutDoctor, onOpenLayoutPicker, onCommitOption, onBoardEdit, picker = null, onChangeLayout,
  onRightAnswer, onPlanRun, onInspectSlideId
}: Props) {
  const row = compiledSlides?.[activeIndex] ?? null
  const block = useMemo(
    () => extractInspectorSlideBlock(outlineContent, headingLine) ?? '',
    [outlineContent, headingLine]
  )
  const triggerLine = triggerLineOf(block)
  const headingLevel = block.match(/^(#{1,6})\s/)?.[1].length ?? 3
  const hasChildren = headingLine == null
    ? false
    : headingHasChildSlides(outlineContent.split('\n'), headingLine - 1)
  const deckListStyle = useMemo(() => deckListStyleForSlide(outlineContent, headingLine), [outlineContent, headingLine])
  const deckStatementToken = useMemo(() => deckStatementTokenForOutline(outlineContent), [outlineContent])
  // Ticket 08: the talk's pre-work form, read with the compiler's own reader, and this slide's place in it.
  const preworkDefinition = useMemo(() => preworkFromOutline(outlineContent), [outlineContent])
  const prework = useMemo(
    // Pre-work is hidden for 0.37: no card, no chip, no pre-work option rows.
    () => (preworkEnabled() ? inspectorPreworkModel(outlineContent, headingLine, triggerLine, preworkDefinition) : null),
    [outlineContent, headingLine, triggerLine, preworkDefinition]
  )
  const plannedRuns = usePlannedRuns(talk.slug)
  const nextRun = prework ? nextPlannedRun(plannedRuns, talk.slug, localToday(new Date())) : null
  const model = useMemo(
    () => inspectorModel(
      compiledSlides, activeIndex, headingLevel, triggerLine, LAYOUTS, block, hasChildren, triggerFindings, deckListStyle, deckStatementToken, prework
    ),
    [compiledSlides, activeIndex, headingLevel, triggerLine, block, hasChildren, triggerFindings, deckListStyle, deckStatementToken, prework]
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
  const { previewUrl, compiling, previewErr } = useLiveSlidePreview(talk.outlinePath, picker?.tryOutline ?? outlineContent, row?.slide_id ?? '')
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [step, setStep] = useState(0)
  useEffect(() => { setStep(0) }, [activeIndex, model.steps.count, model.steps.mode])

  const moveStep = (direction: -1 | 1): void => {
    const next = Math.max(0, Math.min(model.steps.count, step + direction))
    if (next === step) return
    const key = direction > 0 ? 'ArrowRight' : 'ArrowLeft'
    iframeRef.current?.contentWindow?.postMessage({ type: 'tw-step', key }, '*')
    setStep(next)
  }

  // The options pane works as tabs (Dominik's preview.11 check, 29 Sep): the preview head and the
  // chip row stay pinned; only the options scroll. A chip puts its section's heading at the top of
  // the pane (trailing space lets the last one get there); the lit chip is the section at the top,
  // read from scroll position. The pane's place is held as an anchor per slide (inspectorScroll.ts)
  // and put back after every render, so an option change never moves what the user is looking at.
  const paneRef = useRef<HTMLDivElement | null>(null)
  const tailRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const paneMemory = useRef(new PaneMemory())
  const paneSlideRef = useRef<string | null>(null)
  const slideKey = row?.slide_id || `index:${activeIndex}`
  const slideKeyRef = useRef(slideKey)
  slideKeyRef.current = slideKey
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
      <span className="tw-inspector-group-label">{binding.group.sectionLabel ?? binding.group.label}</span>
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
      {children.map((child) => renderGroup(child))}
    </div>
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (!event.altKey) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      event.key === 'ArrowUp' ? onPrev() : onNext()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      event.stopPropagation()
      moveStep(event.key === 'ArrowLeft' ? -1 : 1)
    }
  }

  return (
    <aside className="tw-inspector" aria-label="Inspector" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="tw-inspector-preview-head">
        <div className="tw-inspector-nav">
          <button type="button" onClick={onPrev} disabled={activeIndex <= 0} title="Previous slide (⌥↑)" aria-label="Previous slide"><ChevronLeft /></button>
          <span className="tw-inspector-pos">{activeIndex + 1} / {compiledSlides?.length ?? 0}</span>
          <button type="button" onClick={onNext} disabled={activeIndex >= (compiledSlides?.length ?? 1) - 1} title="Next slide (⌥↓)" aria-label="Next slide"><ChevronRight /></button>
          <span className="tw-inspector-title">{model.title}</span>
          {picker?.tryLabel && <span className="tw-inspector-trying" role="status">Trying {picker.tryLabel}</span>}
        </div>
        <div className={`tw-inspector-stage ${compiling ? 'is-compiling' : ''}${picker?.tryOutline ? ' is-trying' : ''}`} title="Double-click to jump to source">
          {previewErr && previewUrl == null ? (
            <div className="tw-inspector-preview-error">
              {block ? <><AlertTriangle /> Preview unavailable</> : <span className="tw-inspector-preview-quiet">Auto-generated slide — no source to inspect</span>}
            </div>
          ) : (
            /* twpresent gives trusted app-generated output its own origin; a sandbox would only
               disable capabilities the deck runtime legitimately needs. */
            <FixedDeckPreview iframeRef={iframeRef} title="Inspector live preview" src={previewUrl ?? undefined} />
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
        </div>
        {!picker && model.steps.count > 0 && (
          <div className="tw-inspector-stepbar">
            <button type="button" onClick={() => moveStep(-1)} disabled={step <= 0} title="Step back (⌥←)">◂</button>
            <button type="button" onClick={() => moveStep(1)} disabled={step >= model.steps.count} title="Step forward (⌥→)">▸</button>
            <span>step {step} / {model.steps.count} · {model.steps.mode}</span>
            {warnings.length > 0 && <span className="tw-inspector-warning" title={warnings.map((warning) => warning.text).join('\n')}>⚠ {warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
            <button type="button" className="tw-inspector-explain" onClick={onExplain}>Explain</button>
          </div>
        )}
        {!picker && model.steps.count === 0 && (warnings.length > 0 || row) && (
          <div className="tw-inspector-stepbar tw-inspector-stepbar--plain">
            {warnings.length > 0 && <span className="tw-inspector-warning" title={warnings.map((warning) => warning.text).join('\n')}>⚠ {warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
            <button type="button" className="tw-inspector-explain" onClick={onExplain}>Explain</button>
          </div>
        )}
      </div>

      {picker?.column}

      {!picker && !model.unresolved && model.sections.length > 0 && (
        <div className="tw-inspector-jumplist" role="navigation" aria-label="Option sections">
          {model.sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={litSection === section.id ? 'is-lit' : undefined}
              aria-current={litSection === section.id ? 'true' : undefined}
              onClick={() => scrollToSection(section.id)}
            >{section.chip ?? section.heading}</button>
          ))}
        </div>
      )}

      {!picker && <div
        className={`tw-inspector-pane${model.unresolved ? '' : ' tw-inspector-options'}`}
        ref={paneRef}
        onScroll={onPaneScroll}
      >
        {model.unresolved ? (
          <div className="tw-inspector-unresolved" role="alert">
            <div className="tw-inspector-unresolved-title"><AlertTriangle /> Unresolved trigger</div>
            <div className="tw-inspector-unresolved-list">
              {unresolvedTokens.map((warning, index) => (
                <div className="tw-inspector-unresolved-row" key={`${warning.token}:${index}`}>
                  <code>{warning.token}</code>
                  <span>{warning.text}</span>
                </div>
              ))}
            </div>
            <button type="button" onClick={onOpenLayoutDoctor}>Open Layout Doctor</button>
          </div>
        ) : (
          <>
            {model.sections.map((section) => (
              <section
                key={section.id}
                className="tw-inspector-section"
                data-section={section.id}
                aria-label={section.heading}
                ref={(element) => { if (element) sectionRefs.current.set(section.id, element); else sectionRefs.current.delete(section.id) }}
              >
                <h3 className="tw-inspector-section-heading">
                  {section.heading}
                  {section.id === 'layout' && (onChangeLayout ?? onOpenLayoutPicker) && (
                    <button type="button" className="tw-inspector-change" onClick={onChangeLayout ?? onOpenLayoutPicker} data-open-picker title={`Change layout (${liveShortcutLabel('app.layout-picker')})`}>
                      Change <kbd>{liveShortcutLabel('app.layout-picker')}</kbd>
                    </button>
                  )}
                </h3>
                {model.board && section.id === 'poll' ? (
                  // ADR-0032 (round-3 A2–A6): the board's own editor, its settings rows, then the
                  // poll type (so the slide can stop being a board).
                  <>
                    <InspectorBoard
                      board={model.board}
                      slideKey={slideKey}
                      onEdit={onBoardEdit}
                      settings={section.bindings
                        .filter((binding) => binding.group.key.startsWith('board-'))
                        .map((binding) => renderGroup({ ...binding, nestedUnder: undefined }))}
                    />
                    {section.bindings
                      .filter((binding) => !binding.group.key.startsWith('board-') && !binding.nestedUnder)
                      .map((binding) => renderGroup(binding, section.bindings.filter((child) =>
                        child.nestedUnder === binding.group.key && !child.group.key.startsWith('board-'))))}
                  </>
                ) : model.prework && section.id === 'prework' ? (
                  // Ticket 08 (round-2 E1–E4, round-3 P5): the step's own section, its registry rows
                  // (Participants, Time it takes, Questions about it) rendered in its body.
                  <InspectorPrework
                    model={model.prework}
                    nextRun={nextRun}
                    settings={section.bindings.filter((binding) => !binding.nestedUnder).map((binding) => renderGroup(binding))}
                    onPlanRun={(runId) => onPlanRun(runId ? plannedRuns.find((run) => run.id === runId) ?? null : null)}
                    onRightAnswer={(index) => { onRightAnswer(index) }}
                    onResults={(token) => { if (model.prework?.results) onCommitOption(undefined, model.prework.results.group, token) }}
                    onInspectStep={onInspectSlideId}
                  />
                ) : section.bindings.filter((binding) => !binding.nestedUnder).map((binding) =>
                  renderGroup(binding, section.bindings.filter((child) => child.nestedUnder === binding.group.key)))}
              </section>
            ))}
            {activeIndex === 0 && <VaultOrigin outlinePath={talk.outlinePath} outlineContent={outlineContent} />}
            <SlideProvenance outlinePath={talk.outlinePath} slideId={slideIdOf(block)} />
            <TalkActivity outlinePath={talk.outlinePath} />
            <div className="tw-inspector-tail" ref={tailRef} aria-hidden="true" />
          </>
        )}
      </div>}
    </aside>
  )
}
