import type { ChartShape } from '../../../../compiler/scripts/lib/06-chart-renderer.mjs'
import { objectLayoutEntryForBlockKind } from '../../../shared/layout-registry/entries.ts'
import { layoutEntryAcceptsTriggerToken } from '../../../shared/layout-registry/vocabulary.ts'
import type { ObjectBlock } from '../extensions/objectBlocks/detect.ts'

const CHART_SHAPES = new Set<ChartShape>(['bar', 'pie', 'line'])

function asChartShape(value: unknown): ChartShape | null {
  return typeof value === 'string' && CHART_SHAPES.has(value as ChartShape)
    ? value as ChartShape
    : null
}

export function chartShapeForBlock(block: ObjectBlock): ChartShape | null {
  const entry = objectLayoutEntryForBlockKind(block.kind)
  const token = block.triggerToken ?? ''
  if (!entry || !layoutEntryAcceptsTriggerToken(entry, token)) return null

  const explicit = /^chart=(bar|pie|line)$/.exec(block.triggerToken ?? '')?.[1]
  const fromToken = asChartShape(explicit?.toLowerCase())
  if (fromToken) return fromToken

  const resolved = entry.resolvesTo
  return resolved?.key === 'chart'
    ? asChartShape(resolved.value) ?? 'bar'
    : 'bar'
}
