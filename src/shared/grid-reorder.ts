// The grid's block reorder, as a pure text function (the body of the `outline:reorder` IPC handler
// in src/main/index.ts, moved here unchanged so it can be tested; scripts/test-grid-reorder.mjs).
//
// RULING (Task 9, deliberate stopgap — do not extend): the depth-3 filter below exists ONLY to
// mirror GridView/SlideStrip's ###-only block counters (isOutlineBlock), so the renderer's numeric
// block indices land on the same blocks here. Under heading-is-slide every ##–###### heading is a
// slide, so the model-consistent fix is identity-addressed moves ({heading, occurrence} read from
// the row's source_markdown, not a counter) plus a subtree-aware reorderSlide with per-depth
// legality rules. That identity-addressed, subtree-aware move is the follow-up this module does not yet implement.
import { headingMarkLevel } from './heading-lines.ts'
import { landsBeforeTitle } from './talk-title.ts'

/** A block as compiler/scripts/lib/12-outline-edit.mjs listSlideBlocks returns it ([start, end) lines). */
export interface OutlineSlideBlock { heading: string; start: number; end: number }
export type GridReorderPlacement = 'before' | 'after'

/**
 * `text` with grid block `fromIndex` moved next to grid block `toIndex`, or null when that is not
 * a possible move. Grid blocks are the depth-3 (`###`) headings, each with its whole subtree (its
 * ####–###### children travel with it). Without `placement` the drag direction decides the side:
 * dragging down lands AFTER the target subtree, dragging up BEFORE it. With it the caller names
 * the side (a drop on a section header or after the last cell is always "after"). A move that would
 * put the block before the talk's level-1 title is not a possible move (talk-title.ts).
 */
export function reorderGridBlocks(
  text: string,
  blocks: readonly OutlineSlideBlock[],
  fromIndex: number,
  toIndex: number,
  placement?: GridReorderPlacement
): string | null {
  // `heading` is a heading line the compiler's listSlideBlocks already read as structure (outside
  // code fences and comments), so its marker alone gives the depth.
  const depthOf = headingMarkLevel
  // Depth-3 blocks, each spanning through its deeper-heading children ([start, end) lines).
  const gridBlocks: Array<{ start: number; end: number }> = []
  for (let i = 0; i < blocks.length; i += 1) {
    if (depthOf(blocks[i].heading) !== 3) continue
    let end = blocks[i].end
    for (let j = i + 1; j < blocks.length && depthOf(blocks[j].heading) > 3; j += 1) end = blocks[j].end
    gridBlocks.push({ start: blocks[i].start, end })
  }
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= gridBlocks.length ||
    toIndex >= gridBlocks.length ||
    fromIndex === toIndex
  ) {
    return null
  }
  const from = gridBlocks[fromIndex]
  const target = gridBlocks[toIndex]
  const lines = text.split('\n')
  const after = placement === 'after' ? true : placement === 'before' ? false : toIndex > fromIndex
  let at = after ? target.end : target.start
  if (landsBeforeTitle(lines, from.start, from.end, at)) return null
  const moved = lines.splice(from.start, from.end - from.start)
  if (from.start < at) at -= moved.length // indices shifted by the removal above
  lines.splice(at, 0, ...moved)
  return lines.join('\n')
}
