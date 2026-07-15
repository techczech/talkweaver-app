import { useLayoutEffect, useRef, useState, type Ref } from 'react'
import { FIXED_DECK_HEIGHT, FIXED_DECK_WIDTH, fixedDeckScale } from './fixedDeckPreviewModel'

interface Props {
  src?: string
  title: string
  className?: string
  iframeRef?: Ref<HTMLIFrameElement>
}

/** A physical 16:9 stage containing one fixed 1280×720 logical deck viewport. */
export default function FixedDeckPreview({ src, title, className = '', iframeRef }: Props) {
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
          width={FIXED_DECK_WIDTH}
          height={FIXED_DECK_HEIGHT}
        />
      </div>
    </div>
  )
}
