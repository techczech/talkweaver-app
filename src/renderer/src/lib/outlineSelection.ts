// The row selected (or highlighted with the arrow keys) in the Slides outline, held outside React so a
// command run from the palette can act on it: "Move slide to…" acts on the slide selected in the
// focused panel, and the outline lives in the sidebar, outside the workspace that runs commands.
// A source line (1-based), or null when nothing is selected. Nothing here touches the talk's text.
let selectedLine: number | null = null

export function setOutlineSelection(line: number | null): void {
  selectedLine = line
}

export function getOutlineSelection(): number | null {
  return selectedLine
}

/**
 * Called when a slide panel (the outline, the grid) takes the keyboard. The browser sends ⌘X, ⌘C and
 * ⌘V to wherever the document's text selection is, and that selection stays in the editor when a
 * panel row is clicked, so the editor would cut its own selection instead of the selected slide. The
 * selection is released here; the editor keeps its own record and puts it back when it is focused again.
 */
export function releaseSelectionOutside(panel: HTMLElement): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || panel.contains(sel.anchorNode)) return
  sel.removeAllRanges()
}
