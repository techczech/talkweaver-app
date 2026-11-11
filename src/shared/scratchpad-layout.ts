// Where the Slide Scratchpad panel sits: floating (a box the user drags and resizes), docked to the right,
// or collapsed to a pill. Pure: the renderer persists the JSON and clamps it to the window it opens in.

export type ScratchMode = 'float' | 'docked' | 'collapsed'
export interface ScratchBox { x: number; y: number; w: number; h: number }
export interface ScratchLayout {
  mode: ScratchMode
  /** The mode the pill expands back to (float or docked). */
  restore: 'float' | 'docked'
  box: ScratchBox
}

export const DOCK_WIDTH = 560
/** The narrowest window that can dock the panel and still leave the editor its share (R17): below it the panel floats. */
export const DOCK_MIN_WINDOW = 1700
export const MIN_BOX = { w: 420, h: 320 } as const
/** The panel's header stays below the window's own title bar. */
export const TOP_INSET = 28

/** What the right sidebar takes of the window (its default width and the divider): the floating panel opens beside it, not over it. */
export const SIDEBAR_RESERVE = 340
/** The floating panel opens below the window's two bars (title and editor toolbar), so it covers no toolbar button. */
export const FLOAT_TOP = 112

export function defaultLayout(viewport: { w: number; h: number }): ScratchLayout {
  const w = Math.min(700, Math.max(MIN_BOX.w, viewport.w - SIDEBAR_RESERVE - 80))
  const h = Math.min(800, Math.max(MIN_BOX.h, viewport.h - FLOAT_TOP - 50))
  return { mode: 'collapsed', restore: 'float', box: clampBox({ x: viewport.w - SIDEBAR_RESERVE - w - 20, y: FLOAT_TOP, w, h }, viewport) }
}

/** Keeps the box inside the window: at least the minimum size, no larger than the window, header reachable. */
export function clampBox(box: ScratchBox, viewport: { w: number; h: number }): ScratchBox {
  const w = Math.round(Math.min(Math.max(box.w, MIN_BOX.w), Math.max(MIN_BOX.w, viewport.w)))
  const h = Math.round(Math.min(Math.max(box.h, MIN_BOX.h), Math.max(MIN_BOX.h, viewport.h - TOP_INSET)))
  const x = Math.round(Math.min(Math.max(box.x, 0), Math.max(0, viewport.w - w)))
  const y = Math.round(Math.min(Math.max(box.y, TOP_INSET), Math.max(TOP_INSET, viewport.h - 60)))
  return { x, y, w, h }
}

/** Reads what was stored; anything odd falls back to the default for this window. */
export function parseLayout(raw: string | null, viewport: { w: number; h: number }): ScratchLayout {
  const fallback = defaultLayout(viewport)
  if (!raw) return fallback
  try {
    const value = JSON.parse(raw) as Partial<ScratchLayout> | null
    if (!value || typeof value !== 'object') return fallback
    const mode: ScratchMode = value.mode === 'float' || value.mode === 'docked' || value.mode === 'collapsed' ? value.mode : fallback.mode
    const restore = value.restore === 'docked' ? 'docked' : 'float'
    const b = value.box
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
    const box = b && finite(b.x) && finite(b.y) && finite(b.w) && finite(b.h) ? clampBox(b, viewport) : fallback.box
    return { mode, restore, box }
  } catch { return fallback }
}

/** Collapse remembers where to come back to; expanding returns there. */
export function collapse(layout: ScratchLayout): ScratchLayout {
  return layout.mode === 'collapsed' ? layout : { ...layout, mode: 'collapsed', restore: layout.mode }
}
export function expand(layout: ScratchLayout): ScratchLayout {
  return layout.mode === 'collapsed' ? { ...layout, mode: layout.restore } : layout
}
/** The toolbar toggle: pill ⇄ the last open mode. */
export function toggle(layout: ScratchLayout): ScratchLayout {
  return layout.mode === 'collapsed' ? expand(layout) : collapse(layout)
}
export function dock(layout: ScratchLayout): ScratchLayout { return { ...layout, mode: 'docked', restore: 'docked' } }
export function float(layout: ScratchLayout): ScratchLayout { return { ...layout, mode: 'float', restore: 'float' } }
