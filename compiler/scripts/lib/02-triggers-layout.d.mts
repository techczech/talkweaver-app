// Only the pure trigger parsers the app shares (T32, src/shared/deck-frame.ts).
export function parseHeadingAttrs(rawTitle: string): { title: string; attrs: Record<string, unknown>; warnings: string[] }
export function parseTriggerLine(line: string): { attrs: Record<string, unknown>; warnings: string[] } | null
export function applyQuoteTitleAttribution(blocks: unknown, title: unknown): number
/** The trailing `{…}` groups of a heading as parseHeadingAttrs peels them, with their positions in `raw`. */
export function headingBraceGroups(raw: string): Array<{ start: number; end: number; inner: string; authored: boolean }>
export function isBareUrl(text: unknown): boolean
export const PARAGRAPH_STOP_RE: RegExp
/** A heading's own icon: the authored groups that hold an `icon=` token, and the value of the last one (null: none or empty). */
export function headingIconGroups(raw: string): { key: string | null; groups: Array<{ start: number; end: number }> }
export function normalizeEmbedUrl(rawSrc: unknown): string
