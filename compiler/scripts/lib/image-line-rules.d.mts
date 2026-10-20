export function audienceImageLineNumbers(lines: readonly string[]): number[]
export function isImageBlockLine(trimmedLine: string): boolean
/** A YouTube or Vimeo address read into its kind, id and start second; null for any other address. */
export function parseVideoEmbed(rawSrc: unknown): { kind: 'youtube' | 'vimeo'; id: string; start: number | null } | null
