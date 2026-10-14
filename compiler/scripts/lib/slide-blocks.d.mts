export interface SlideBlock {
  /** The heading line as written. */
  heading: string
  /** 1-based among identical heading lines. */
  occurrence: number
  title: string
  /** [start, end) lines of the block. */
  start: number
  end: number
}
export function scanLines(text: string): string[]
export function listSlideBlocks(text: string): SlideBlock[]
export function lineHasUnclosedBrace(line: string): boolean
export function headingIdKey(heading: string): string
/** The headings stampMissingIds (12-outline-edit.mjs) will stamp on a save of `text`. */
export function headingsMissingIds(text: string): Array<{ heading: string; occurrence: number; prefKey: string }>
