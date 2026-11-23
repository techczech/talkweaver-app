import { useLayoutEffect, useRef, useState, type Ref } from 'react'
import { FIXED_DECK_HEIGHT, FIXED_DECK_SANDBOX, FIXED_DECK_WIDTH, fixedDeckScale } from './fixedDeckPreviewModel'

interface Props {
  src?: string
  title: string
  className?: string
  iframeRef?: Ref<HTMLIFrameElement>
  readOnly?: boolean
}

/** A physical 16:9 stage containing one fixed 1280×720 logical deck viewport. */
export default function FixedDeckPreview({ src, title, className = '', iframeRef, readOnly = false }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(0)

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
          ref={iframeRef}
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
    </div>
  )
}
