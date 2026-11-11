// How the commands (palette, Actions here, shortcuts) reach the slide selection of the grid, which is the only
// surface holding one so far. The grid registers while it is mounted; a command that finds no grid says so.
export interface SlideSelectionControls {
  /** The selection's size (talk order not needed here). */
  count: () => number
  /** Whether the whole ticked selection can participate in an outline edit (no ticks: active slide rules apply). */
  canEditOutline: () => boolean
  selectSection: () => boolean
  /** Select an inserted batch only when every heading line exists in the current rows. */
  selectLines: (lines: readonly number[]) => boolean
  clear: () => void
  openMove: () => boolean
  addToPathway?: () => boolean
  setAside?: () => boolean
  remove: () => boolean
}

let controls: SlideSelectionControls | null = null

/** Called by the grid on mount; returns the undo of it. */
export function registerSlideSelection(next: SlideSelectionControls): () => void {
  controls = next
  return () => { if (controls === next) controls = null }
}

export function slideSelectionControls(): SlideSelectionControls | null {
  return controls
}
