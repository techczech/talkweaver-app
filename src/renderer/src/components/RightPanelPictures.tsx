import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ImageOff } from 'lucide-react'
import RevealPreviewBadge from './RevealPreviewBadge'
import { createVariantPictureQueue, isRevealPicture, markSettled, pictureMarkUrl, type VariantPictureMarks } from '../../../shared/variant-picture-queue'
import { LayoutVerbError, type SlideRef } from '../../../shared/layout-verbs'
import { panelEdit, type Design } from './rightPanelDesigns'

export interface PanelTry { text: string; label: string; whatChanges?: string }

export default function RightPanelPictures({ path, text, slide, layout, group, choices, columns = 3, onTry, onKeep, previewChoice, pendingPicture, checkedPictures, trying, currentLabel = 'Current' }: {
  path: string
  text: string
  slide: SlideRef
  layout: string
  group: string
  choices: Design[]
  columns?: number | 'auto'
  onTry: (preview: PanelTry | null) => void
  onKeep: (design: Design) => void
  previewChoice?: (design: Design) => string
  pendingPicture?: (design: Design) => ReactNode
  checkedPictures?: VariantPictureMarks
  trying?: string
  currentLabel?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const showDesignTooltip = group === 'design' || group.startsWith('gallery-')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [visible, setVisible] = useState(false)
  const [marks, setMarks] = useState<VariantPictureMarks>({})
  const slideKey = typeof slide === 'string' ? slide : `line:${slide.headingLine}`
  const choicesKey = JSON.stringify(choices)
  const candidates = useMemo(() => choices.map(design => {
    if (design.unavailable) return { outline: null, reason: design.unavailable }
    try {
      const unchanged = design.current && !design.reapply
      return { outline: unchanged ? text : previewChoice ? previewChoice(design) : panelEdit(text, slide, design, layout, true) }
    } catch (error) {
      return { outline: null, reason: error instanceof LayoutVerbError ? error.reason ?? 'Unavailable for this slide' : 'Unavailable for this slide' }
    }
  }), [choicesKey, text, slideKey, layout]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const element = root.current
    if (!element || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '120px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible || !window.tw?.talk?.layoutVariantThumbnail) return
    const batchId = crypto.randomUUID()
    const queue = createVariantPictureQueue<typeof candidates>(
      (key, options) => {
        const variant = options[Number(key)].outline
        return variant == null ? Promise.resolve(null)
          : window.tw.talk.layoutVariantThumbnail(path, variant, slide, '', undefined, `panel:${group}:${key}`, batchId)
      },
      (key, mark) => setMarks(current => markSettled(current, key, mark))
    )
    setMarks({})
    queue.reset(slideKey + text, candidates, slideKey)
    queue.want(candidates.flatMap((candidate, index) => candidate.outline === null || choices[index].check ? [] : [String(index)]))
    // Release the old batch when candidates or the slide change, as well as when the panel closes.
    return () => {
      queue.dispose()
      window.tw.talk.releaseLayoutVariantBatch?.(batchId)
    }
  }, [visible, path, candidates, slideKey, group]) // eslint-disable-line react-hooks/exhaustive-deps

  const stop = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    onTry(null)
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [text, slideKey])
  return <div ref={root} className="tw-right-pictures"
    style={columns === 'auto' ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
    {choices.map((design, index) => {
      const { outline: candidate, reason } = candidates[index]
      const mark = design.check ? checkedPictures?.[design.label] : marks[String(index)]
      const url = pictureMarkUrl(mark)
      const reveal = isRevealPicture(mark) ? mark : undefined
      const tryIt = (): void => {
        stop()
        if (!design.current && candidate != null && candidate !== text) {
          timer.current = setTimeout(() => onTry({ text: candidate, label: design.label, whatChanges: design.structure ? design.why : undefined }), 250)
        }
      }
      return <button type="button" key={design.label} aria-pressed={!!design.current} disabled={candidate == null}
        aria-disabled={design.ariaDisabled || undefined}
        className="tw-right-picture" data-trying={trying === design.label || undefined}
        title={showDesignTooltip ? [design.label, design.why ?? reason].filter(Boolean).join(' · ') : undefined}
        onPointerEnter={tryIt} onPointerLeave={stop} onFocus={tryIt} onBlur={stop}
        onClick={() => { stop(); if (!design.current || design.reapply) onKeep(design) }}>
        {design.current && <span className="tw-right-current">{currentLabel}</span>}
        <span className="tw-right-picture-frame" aria-hidden={reveal ? undefined : true}>
          {url ? <img src={url} alt="" draggable={false} /> : mark === null ? <ImageOff size={16} /> : pendingPicture?.(design)}
          {reveal && <RevealPreviewBadge count={reveal.revealSteps} />}
        </span>
        <strong>{design.label}</strong>
        {(!design.ariaDisabled && (reason || mark === null || design.why)) && <small>{reason ?? (mark === null ? 'Preview unavailable' : design.why)}</small>}
      </button>
    })}
  </div>
}
