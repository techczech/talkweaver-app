export type ChartObjectToken = {
  token: string
  shape: 'bar' | 'pie' | 'line'
}

export type ChartObjectTokenAt = ChartObjectToken & {
  listStart: number
}

export type MarkdownFenceOpening = {
  marker: string
  info: string
}

export type MarkdownFenceExtent = {
  opening: MarkdownFenceOpening
  start: number
  bodyEnd: number
  end: number
  closed: boolean
}

export type MarkdownFenceLineScanOptions = {
  resetAtLine?: (line: string, index: number) => boolean
}

export type ChartFenceOpening = MarkdownFenceOpening & {
  chart: ChartObjectToken | null
  chartLike: boolean
}

export type ChartFenceListNode = {
  text: string
  ordered: boolean
  children: ChartFenceListNode[]
}

export type ChartFenceBodyList = {
  type: 'list'
  ordered: boolean
  items: string[]
  children: ChartFenceListNode[][]
}

export const CHART_FENCE_ALIASES: ReadonlySet<string>
export function parseChartObjectTokenLine(line: unknown): ChartObjectToken | null
export function parseChartObjectFenceInfo(info: unknown): ChartObjectToken | null
export function parseChartFenceBodyList(
  lines: readonly unknown[]
): ChartFenceBodyList | null
export function parseMarkdownFenceOpeningLine(line: unknown): MarkdownFenceOpening | null
export function isMarkdownFenceClosingLine(
  line: unknown,
  opening: MarkdownFenceOpening | null
): boolean
export function scanFencedLines(
  lines: readonly string[],
  options?: MarkdownFenceLineScanOptions
): { flags: boolean[]; extents: MarkdownFenceExtent[] }
export function parseChartFenceOpeningLine(line: unknown): ChartFenceOpening | null
export function chartObjectTokenAt(
  lines: readonly unknown[],
  index: number
): ChartObjectTokenAt | null
