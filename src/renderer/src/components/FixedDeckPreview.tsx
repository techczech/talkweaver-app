import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { FIXED_DECK_HEIGHT, FIXED_DECK_SANDBOX, FIXED_DECK_WIDTH, fixedDeckScale } from './fixedDeckPreviewModel'

import RevealPreviewBadge from './RevealPreviewBadge'

export interface RevealPreviewStep {
  src: string
  count: number
  step: number
}

interface Props {
  src?: string
  title: string
  className?: string
  iframeRef?: RefObject<HTMLIFrameElement>
  onOpenReveal?: () => void
  onRevealStep?: (step: RevealPreviewStep) => void
  readOnly?: boolean
}

/** A physical 16:9 stage containing one fixed 1280×720 logical deck viewport. */
export default function FixedDeckPreview({ src, title, className = '', iframeRef, onRevealStep, onOpenReveal, readOnly = false }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const localFrame = useRef<HTMLIFrameElement>(null)
  const frame = iframeRef ?? localFrame
  const [scale, setScale] = useState(0)
  const [reveal, setReveal] = useState<RevealPreviewStep>()

  useLayoutEffect(() => {
    if (!src) return
    const expected = new URL(src, location.href)
    const receive = (event: MessageEvent): void => {
      const data = event.data
      if (event.source !== frame.current?.contentWindow || data?.type !== 'tw-preview-reveal' ||
          typeof data.url !== 'string' || typeof data.slideId !== 'string' ||
          data.url.split('#')[0] !== expected.href.split('#')[0] ||
          (expected.hash && expected.hash !== '#' + encodeURIComponent(data.slideId))) return
      if (data.enabled === true && Number.isSafeInteger(data.count) && data.count >= 0 &&
          Number.isSafeInteger(data.step) && data.step >= 0 && data.step <= data.count) {
        const status = { src, count: data.count, step: data.step }
        setReveal(status)
        onRevealStep?.(status)
      } else setReveal(undefined)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [frame, src, onRevealStep])

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const update = (): void => setScale(fixedDeckScale(stage.clientWidth))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={stageRef}
      className={`tw-fixed-deck-preview ${className}`.trim()}
      style={{ ['--tw-fixed-deck-scale' as string]: scale }}
    >
      <div
        className="tw-fixed-deck-preview__canvas"
        style={{ width: FIXED_DECK_WIDTH, height: FIXED_DECK_HEIGHT }}
      >
        <iframe
          ref={frame}
          title={title}
          src={src}
          // The deck is served from twpresent:, already a different origin from the editor, so
          // allow-same-origin gives it only its own origin (storage, module scripts, and embedded
          // videos and sites inside it keep working). What the sandbox takes away is navigating
          // the editor window itself (it holds window.tw), modal dialogs and downloads. Pop-ups stay
          // allowed: the editor's window-open handler still decides, and opens links outside.
          sandbox={FIXED_DECK_SANDBOX}
          tabIndex={readOnly ? -1 : undefined}
          style={readOnly ? { pointerEvents: 'none' } : undefined}
          width={FIXED_DECK_WIDTH}
          height={FIXED_DECK_HEIGHT}
        />
      </div>
      {reveal && reveal.src === src && <RevealPreviewBadge count={onOpenReveal ? reveal.count : undefined} onOpen={onOpenReveal} />}
    </div>
  )
}
