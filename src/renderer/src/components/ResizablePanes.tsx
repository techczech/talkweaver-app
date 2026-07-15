import React, { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  left: React.ReactNode
  right: React.ReactNode
  initialLeftPct?: number
  minLeftPct?: number
  maxLeftPct?: number
  storageKey?: string
}

const DIVIDER_WIDTH = 6

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
  storageKey
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [leftPct, setLeftPct] = useState<number>(() =>
    clamp(readStored(storageKey, initialLeftPct), minLeftPct, maxLeftPct)
  )
  const [dragging, setDragging] = useState<boolean>(false)

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
    [minLeftPct, maxLeftPct]
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
        style={{
          width: `${leftPct}%`,
          height: '100%',
          minWidth: 0,
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
        style={{
          width: `${100 - leftPct}%`,
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
