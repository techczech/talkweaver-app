// Only the pure trigger parsers the app shares (T32, src/shared/deck-frame.ts).
export function parseHeadingAttrs(rawTitle: string): { title: string; attrs: Record<string, unknown>; warnings: string[] }
export function parseTriggerLine(line: string): { attrs: Record<string, unknown>; warnings: string[] } | null
