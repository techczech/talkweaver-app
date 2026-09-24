export type ChartShape = 'bar' | 'pie' | 'line'

export type ChartPoint = {
  value: number
  valueText: string
  label: string
}

export type ParsedChartList = {
  points: ChartPoint[]
  unparsed: string[]
  invalidLines: string[]
}

export function renderChartBlock(block: {
  type?: 'chart'
  shape: ChartShape
  points: ChartPoint[]
}): string

export function parseChartItems(
  items: string[],
  childTrees?: Array<Array<{ text: string }>>
): Omit<ParsedChartList, 'invalidLines'>

export function parseChartListSource(source: string): ParsedChartList
