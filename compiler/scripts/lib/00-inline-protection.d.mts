export type InlineTextSegment = {
  kind: 'text'
  from: number
  to: number
  source: string
}

export type InlineCodeSegment = {
  kind: 'code'
  from: number
  to: number
  source: string
  content: string
}

export type InlineLinkSegment = {
  kind: 'link'
  from: number
  to: number
  source: string
  label: string
  url: string
  title?: string
}

export type InlineUrlSegment = {
  kind: 'url'
  from: number
  to: number
  source: string
  url: string
}

export type InlineSegment =
  | InlineTextSegment
  | InlineCodeSegment
  | InlineLinkSegment
  | InlineUrlSegment

export function segmentInlineSource(source: string): InlineSegment[]
export function replaceMarkSyntax(
  text: string,
  replacement: (inner: string) => string
): string
export type InlineMarkKind = 'highlight' | 'strike' | 'underline'
export const UNDERLINE_SOURCE: string
export function replaceInlineMarks(
  text: string,
  render?: (inner: string, kind: InlineMarkKind) => string
): string
export function protectInlineSegments(
  source: string,
  renderSegment?: (segment: Exclude<InlineSegment, InlineTextSegment>) => string
): { masked: string; restore: (text: string) => string }
export function transformInlineMarks(
  source: string,
  replacement: (inner: string, kind: InlineMarkKind) => string
): string
export function inlineMarkRanges(source: string): Array<{ from: number; to: number; kind: InlineMarkKind }>
