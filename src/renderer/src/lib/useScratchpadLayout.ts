// The Slide Scratchpad panel's mode, position and size, kept in localStorage and clamped to the window.
import { useCallback, useEffect, useState } from 'react'
import { DOCK_MIN_WINDOW, clampBox, collapse, dock, expand, float, parseLayout, toggle, type ScratchBox, type ScratchLayout } from '../../../shared/scratchpad-layout'

const KEY = 'tw-scratchpad-layout-v1'
const viewport = (): { w: number; h: number } => ({ w: window.innerWidth, h: window.innerHeight })

export interface ScratchpadLayoutApi {
  /** What is drawn: a window too narrow for the dock (R17) draws a docked panel as the floating one. */
  layout: ScratchLayout
  /** False in a window narrower than the dock needs; the panel then offers no "Dock to the right". */
  canDock: boolean
  toggle: () => void
  expand: () => void
  collapse: () => void
  dock: () => void
  float: () => void
  /** Moves or resizes the floating box; saved when `final`. */
  setBox: (box: ScratchBox, final: boolean) => void
}

export function useScratchpadLayout(): ScratchpadLayoutApi {
  const [windowWidth, setWindowWidth] = useState<number>(() => window.innerWidth)
  const [layout, setLayout] = useState<ScratchLayout>(() => {
    let raw: string | null = null
    try { raw = window.localStorage.getItem(KEY) } catch { /* storage off: defaults */ }
    return parseLayout(raw, viewport())
  })
  const save = useCallback((next: ScratchLayout) => {
    try { window.localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* not saved this time */ }
  }, [])
  const change = useCallback((fn: (l: ScratchLayout) => ScratchLayout) => {
    setLayout((current) => { const next = fn(current); save(next); return next })
  }, [save])
  // A smaller window pulls the floating box back inside it.
  useEffect(() => {
    const onResize = (): void => setWindowWidth(window.innerWidth)
    const onResizeBox = (): void => setLayout((current) => {
      const box = clampBox(current.box, viewport())
      return box.x === current.box.x && box.y === current.box.y && box.w === current.box.w && box.h === current.box.h ? current : { ...current, box }
    })
    window.addEventListener('resize', onResize)
    window.addEventListener('resize', onResizeBox)
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('resize', onResizeBox) }
  }, [])
  const canDock = windowWidth >= DOCK_MIN_WINDOW
  return {
    layout: !canDock && layout.mode === 'docked' ? { ...layout, mode: 'float' } : layout,
    canDock,
    toggle: useCallback(() => change(toggle), [change]),
    expand: useCallback(() => change(expand), [change]),
    collapse: useCallback(() => change(collapse), [change]),
    dock: useCallback(() => change(dock), [change]),
    float: useCallback(() => change(float), [change]),
    setBox: useCallback((box, final) => {
      const clamped = clampBox(box, viewport())
      if (final) change((l) => ({ ...l, box: clamped }))
      else setLayout((l) => ({ ...l, box: clamped }))
    }, [change])
  }
}
