import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'
import type { ProjectionRow, TalkInfo } from '../../../preload/index'
import type { LayoutDoctorFinding } from '../../../shared/layout-doctor'
import type { LayoutDef, OptionGroup } from '../data/layouts'
import { LAYOUTS } from '../data/layouts'
import { deckListStyleForSlide } from '../../../shared/deck-frame'
import {
  extractInspectorSlideBlock, inspectorCommitToken, inspectorModel, sectionIdAtScrollTop,
  type InspectorBindingModel
} from './inspectorModel'
import { OptionControl } from './CommandPalette'
import { surfacedWarnings } from './SlideStrip'
import { useLiveSlidePreview } from './useLiveSlidePreview'
import FixedDeckPreview from './FixedDeckPreview'
import { headingHasChildSlides } from '../../../shared/trigger-line'

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
  onCommitOption: (entry: LayoutDef | undefined, group: OptionGroup, token: string) => string | null
}

function triggerLineOf(block: string): string {
  const candidate = block.split('\n')[1] ?? ''
  return /^\s*(\{[^}]*\}\s*)+$/.test(candidate) ? candidate : ''
}

export default function Inspector({
  talk, compiledSlides, outlineContent, triggerFindings, activeIndex, headingLine,
  onPrev, onNext, onEdit, onExplain, onOpenLayoutDoctor, onCommitOption
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
  const model = useMemo(
    () => inspectorModel(
      compiledSlides, activeIndex, headingLevel, triggerLine, LAYOUTS, block, hasChildren, triggerFindings, deckListStyle
    ),
    [compiledSlides, activeIndex, headingLevel, triggerLine, block, hasChildren, triggerFindings, deckListStyle]
  )
  const entry = LAYOUTS.find((candidate) => candidate.name === model.layoutName)
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
  const { previewUrl, compiling, previewErr } = useLiveSlidePreview(talk.outlinePath, outlineContent, row?.slide_id ?? '')
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

  // T32 (Decision 2A): the jump row. The Inspector itself is the scroll area; the row is sticky
  // at its top. The lit pill is read from scroll position on every scroll event — no timers. A
  // pill click lights its section at once and keeps it lit while the smooth scroll runs (a short
  // last section can never reach the top); any user scroll input hands control back to position.
  const scrollerRef = useRef<HTMLElement | null>(null)
  const jumpRowRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const jumpTargetRef = useRef<string | null>(null)
  const sectionIds = model.sections.map((section) => section.id).join(' ')
  const [litSection, setLitSection] = useState<string | null>(null)

  const readLitSection = (): void => {
    const scroller = scrollerRef.current
    if (!scroller) return
    if (jumpTargetRef.current) { setLitSection(jumpTargetRef.current); return }
    const scrollerTop = scroller.getBoundingClientRect().top
    const tops = model.sections.map((section) => ({
      id: section.id,
      top: (sectionRefs.current.get(section.id)?.getBoundingClientRect().top ?? 0) - scrollerTop + scroller.scrollTop
    }))
    // The reading line sits just below the sticky row: a section whose heading shows directly
    // under the pills is the one being read.
    const readingLine = scroller.scrollTop + (jumpRowRef.current?.offsetHeight ?? 0) + 12
    setLitSection(sectionIdAtScrollTop(tops, readingLine))
  }
  useLayoutEffect(() => { jumpTargetRef.current = null; readLitSection() }, [sectionIds, model.unresolved])

  const releaseJump = (): void => { jumpTargetRef.current = null }
  const scrollToSection = (id: string): void => {
    const scroller = scrollerRef.current
    const section = sectionRefs.current.get(id)
    if (!scroller || !section) return
    const target = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      + scroller.scrollTop - (jumpRowRef.current?.offsetHeight ?? 0)
    jumpTargetRef.current = id
    setLitSection(id)
    scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  }

  const renderGroup = (binding: InspectorBindingModel, children: InspectorBindingModel[] = []): React.JSX.Element => (
    <div
      className={`tw-inspector-group${binding.nestedUnder ? ' tw-inspector-group--nested' : ''}`}
      key={binding.group.key}
      data-group={binding.group.key}
    >
      <span className="tw-inspector-group-label">{binding.group.sectionLabel ?? binding.group.label}</span>
      <OptionControl
        entry={binding.source === 'entry' ? (binding.owner ?? entry) : undefined}
        binding={{ group: binding.group, selectedToken: binding.selectedToken }}
        deckToken={binding.deckToken}
        onSelect={(group, token) => {
          onCommitOption(binding.source === 'entry' ? (binding.owner ?? entry) : undefined, group, inspectorCommitToken(binding, token))
        }}
      />
      {children.map((child) => renderGroup(child))}
    </div>
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    releaseJump()
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
    <aside
      className="tw-inspector" aria-label="Inspector" tabIndex={-1} onKeyDown={onKeyDown}
      ref={scrollerRef} onScroll={readLitSection} onWheel={releaseJump} onPointerDown={releaseJump} onTouchMove={releaseJump}
    >
      <div className="tw-inspector-preview-head">
        <div className="tw-inspector-nav">
          <button type="button" onClick={onPrev} disabled={activeIndex <= 0} title="Previous slide (⌥↑)" aria-label="Previous slide"><ChevronLeft /></button>
          <span className="tw-inspector-pos">{activeIndex + 1} / {compiledSlides?.length ?? 0}</span>
          <button type="button" onClick={onNext} disabled={activeIndex >= (compiledSlides?.length ?? 1) - 1} title="Next slide (⌥↓)" aria-label="Next slide"><ChevronRight /></button>
          <span className="tw-inspector-title">{model.title}</span>
        </div>
        <div className={`tw-inspector-stage ${compiling ? 'is-compiling' : ''}`} title="Double-click to jump to source">
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
        {model.steps.count > 0 && (
          <div className="tw-inspector-stepbar">
            <button type="button" onClick={() => moveStep(-1)} disabled={step <= 0} title="Step back (⌥←)">◂</button>
            <button type="button" onClick={() => moveStep(1)} disabled={step >= model.steps.count} title="Step forward (⌥→)">▸</button>
            <span>step {step} / {model.steps.count} · {model.steps.mode}</span>
            {warnings.length > 0 && <span className="tw-inspector-warning" title={warnings.map((warning) => warning.text).join('\n')}>⚠ {warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
            <button type="button" className="tw-inspector-explain" onClick={onExplain}>Explain</button>
          </div>
        )}
        {model.steps.count === 0 && (warnings.length > 0 || row) && (
          <div className="tw-inspector-stepbar tw-inspector-stepbar--plain">
            {warnings.length > 0 && <span className="tw-inspector-warning" title={warnings.map((warning) => warning.text).join('\n')}>⚠ {warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
            <button type="button" className="tw-inspector-explain" onClick={onExplain}>Explain</button>
          </div>
        )}
      </div>

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
        <div className="tw-inspector-options">
          {model.sections.length > 0 && (
            <div className="tw-inspector-jumplist" ref={jumpRowRef} role="navigation" aria-label="Option sections">
              {model.sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={litSection === section.id ? 'is-lit' : undefined}
                  aria-current={litSection === section.id ? 'true' : undefined}
                  onClick={() => scrollToSection(section.id)}
                >{section.heading}</button>
              ))}
            </div>
          )}
          {model.sections.map((section) => (
            <section
              key={section.id}
              className="tw-inspector-section"
              data-section={section.id}
              aria-label={section.heading}
              ref={(element) => { if (element) sectionRefs.current.set(section.id, element); else sectionRefs.current.delete(section.id) }}
            >
              <h3 className="tw-inspector-section-heading">{section.heading}</h3>
              {section.bindings.filter((binding) => !binding.nestedUnder).map((binding) =>
                renderGroup(binding, section.bindings.filter((child) => child.nestedUnder === binding.group.key)))}
            </section>
          ))}
        </div>
      )}
    </aside>
  )
}
