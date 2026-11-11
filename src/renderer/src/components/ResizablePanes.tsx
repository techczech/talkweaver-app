import React, { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  left: React.ReactNode
  right: React.ReactNode
  initialLeftPct?: number
  minLeftPct?: number
  maxLeftPct?: number
  storageKey?: string
  /** The right pane keeps at least this many pixels; the left pane gives way (the docked layout picker, ADR-0032 §8). */
  minRightPx?: number
  /** The right pane has its own width in px (the right sidebar, R11a): the left pane takes the rest, so the editor
   *  keeps its share however wide the window is. Stored under this key; dragged between RIGHT_MIN_PX and 60%. */
  rightPx?: { storageKey: string; initial: number }
}

const DIVIDER_WIDTH = 6
const RIGHT_MIN_PX = 280

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function readStored(storageKey: string | undefined, fallback: number): number {
  if (!storageKey) return fallback
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw === null) return fallback
    const parsed = parseFloat(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

export default function ResizablePanes({
  left,
  right,
  initialLeftPct = 55,
  minLeftPct = 25,
  maxLeftPct = 80,
  storageKey,
  minRightPx,
  rightPx: rightPxConfig
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [leftPct, setLeftPct] = useState<number>(() =>
    clamp(readStored(storageKey, initialLeftPct), minLeftPct, maxLeftPct)
  )
  const [dragging, setDragging] = useState<boolean>(false)
  const [rightWidth, setRightWidth] = useState<number>(() => (rightPxConfig ? Math.max(RIGHT_MIN_PX, readStored(rightPxConfig.storageKey, rightPxConfig.initial)) : 0))
  useEffect(() => {
    if (!rightPxConfig) return
    try { window.localStorage.setItem(rightPxConfig.storageKey, String(rightWidth)) } catch { /* ignore persistence failures */ }
  }, [rightWidth, rightPxConfig])

  useEffect(() => {
    if (!storageKey) return
    try {
      window.localStorage.setItem(storageKey, String(leftPct))
    } catch {
      // ignore persistence failures (private mode, quota)
    }
  }, [leftPct, storageKey])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setDragging(true)

      const onMove = (ev: MouseEvent): void => {
        const container = containerRef.current
        if (!container) return
        const rect = container.getBoundingClientRect()
        if (rect.width <= 0) return
        if (rightPxConfig) {
          setRightWidth(Math.round(clamp(rect.right - ev.clientX - DIVIDER_WIDTH / 2, RIGHT_MIN_PX, rect.width * 0.6)))
          return
        }
        const pct = ((ev.clientX - rect.left) / rect.width) * 100
        setLeftPct(clamp(pct, minLeftPct, maxLeftPct))
      }

      const onUp = (): void => {
        setDragging(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [minLeftPct, maxLeftPct, rightPxConfig]
  )

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'row',
        height: '100%',
        width: '100%',
        overflow: 'hidden'
      }}
    >
      <div
        style={rightPxConfig ? { flex: '1 1 0', height: '100%', minWidth: 0, overflow: 'hidden' } : {
          width: minRightPx ? `max(0px, min(${leftPct}%, calc(100% - ${DIVIDER_WIDTH}px - ${minRightPx}px)))` : `${leftPct}%`,
          height: '100%',
          minWidth: 0,
          flex: minRightPx ? 'none' : undefined,
          overflow: 'hidden'
        }}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={onMouseDown}
        style={{
          flex: `0 0 ${DIVIDER_WIDTH}px`,
          width: DIVIDER_WIDTH,
          height: '100%',
          cursor: 'col-resize',
          background: dragging ? 'var(--oxford)' : 'var(--line)',
          userSelect: 'none',
          transition: dragging ? 'none' : 'background 120ms ease'
        }}
        onMouseEnter={(e) => {
          if (!dragging) e.currentTarget.style.background = 'var(--oxford)'
        }}
        onMouseLeave={(e) => {
          if (!dragging) e.currentTarget.style.background = 'var(--line)'
        }}
      />
      <div
        style={rightPxConfig ? {
          flex: '0 0 auto',
          width: `min(${Math.max(rightWidth, minRightPx ?? 0)}px, 60%)`,
          height: '100%',
          minWidth: 0,
          overflow: 'hidden'
        } : {
          width: minRightPx ? undefined : `${100 - leftPct}%`,
          flex: minRightPx ? '1 1 0' : undefined,
          height: '100%',
          minWidth: 0,
          overflow: 'hidden'
        }}
      >
        {right}
      </div>
    </div>
  )
}
