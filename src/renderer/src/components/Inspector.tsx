import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'
import type { ProjectionRow, TalkInfo } from '../../../preload/index'
import type { LayoutDef, OptionGroup } from '../data/layouts'
import { LAYOUTS } from '../data/layouts'
import { extractInspectorSlideBlock, inspectorModel } from './inspectorModel'
import { OptionControl } from './CommandPalette'
import { surfacedWarnings } from './SlideStrip'
import { useLiveSlidePreview } from './useLiveSlidePreview'
import FixedDeckPreview from './FixedDeckPreview'
import { headingHasChildSlides } from '../../../shared/trigger-line'

interface Props {
  talk: TalkInfo
  compiledSlides: ProjectionRow[] | null
  outlineContent: string
  activeIndex: number
  headingLine: number | null
  onPrev: () => void
  onNext: () => void
  onEdit: () => void
  onExplain: () => void
  onCommitOption: (entry: LayoutDef | undefined, group: OptionGroup, token: string) => string | null
}

function triggerLineOf(block: string): string {
  const candidate = block.split('\n')[1] ?? ''
  return /^\s*(\{[^}]*\}\s*)+$/.test(candidate) ? candidate : ''
}

export default function Inspector({
  talk, compiledSlides, outlineContent, activeIndex, headingLine,
  onPrev, onNext, onEdit, onExplain, onCommitOption
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
  const model = useMemo(
    () => inspectorModel(compiledSlides, activeIndex, headingLevel, triggerLine, LAYOUTS, block, hasChildren),
    [compiledSlides, activeIndex, headingLevel, triggerLine, block, hasChildren]
  )
  const entry = LAYOUTS.find((candidate) => candidate.name === model.layoutName)
  const warnings = surfacedWarnings(row, 'inspector')
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

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
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
            {warnings.length > 0 && <span className="tw-inspector-warning" title={warnings.join('\n')}>⚠ {warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
            <button type="button" className="tw-inspector-explain" onClick={onExplain}>Explain</button>
          </div>
        )}
        {model.steps.count === 0 && (warnings.length > 0 || row) && (
          <div className="tw-inspector-stepbar tw-inspector-stepbar--plain">
            {warnings.length > 0 && <span className="tw-inspector-warning" title={warnings.join('\n')}>⚠ {warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
            <button type="button" className="tw-inspector-explain" onClick={onExplain}>Explain</button>
          </div>
        )}
      </div>

      <div className="tw-inspector-options">
        {model.groups.map((binding) => (
          <section className="tw-inspector-group" key={binding.group.key}>
            <span className="tw-inspector-group-label">
              {binding.source === 'entry'
                ? (binding.group.key === 'variant' ? `Layout — ${entry?.label ?? row?.layout ?? 'current'}` : `${entry?.label ?? 'Layout'} — ${binding.group.label}`)
                : binding.group.label}
            </span>
            <OptionControl
              entry={binding.source === 'entry' ? (binding.owner ?? entry) : undefined}
              binding={{ group: binding.group, selectedToken: model.selectedTokens[binding.group.key] ?? '' }}
              onSelect={(group, token) => { onCommitOption(binding.source === 'entry' ? (binding.owner ?? entry) : undefined, group, token) }}
            />
          </section>
        ))}
      </div>
    </aside>
  )
}
