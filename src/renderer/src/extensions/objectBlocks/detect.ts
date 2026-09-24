import {
  logicalTriggerBlockAfterHeading,
  TRIGGER_LINE_RE
} from '../../../../shared/trigger-line.ts'
import {
  objectLayoutEntries,
  objectLayoutReadsStorage,
  type ObjectLayoutDef
} from '../../../../shared/layout-registry/entries.ts'
import {
  layoutEntryAcceptsTriggerToken,
  winningAuthoredLayout
} from '../../../../shared/layout-registry/vocabulary.ts'
import { scanFencedLines } from '../../../../shared/outline-normalize.ts'
import {
  chartObjectTokenAt,
  parseChartFenceOpeningLine,
  parseMarkdownFenceOpeningLine
} from '../../../../../compiler/scripts/lib/03-object-token.mjs'

export type ObjectBlockKind =
  | 'gfm-table'
  | 'trigger-table'
  | 'chart'
  | 'barchart'
  | 'piechart'
  | 'linechart'
  | 'mindmap'
  | 'mermaid'
  | 'svg'

export type ObjectBlock = {
  kind: ObjectBlockKind
  from: number
  to: number
  source: string
  /** Absolute editable body range for a canonical fenced object. */
  bodyFrom?: number
  bodyTo?: number
  triggerLine?: number
  triggerToken?: string
}

export function objectBlockEditableSource(block: ObjectBlock): string {
  if (
    typeof block.bodyFrom === 'number'
    && typeof block.bodyTo === 'number'
    && block.bodyFrom >= block.from
    && block.bodyTo >= block.bodyFrom
    && block.bodyTo <= block.to
  ) {
    return block.source.slice(block.bodyFrom - block.from, block.bodyTo - block.from)
  }
  if (/^\s*(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.test(block.source)) {
    return block.source
      .replace(/^\s*(`{3,}|~{3,})[^\r\n]*(?:\r?\n)?/, '')
      .replace(/(?:\r?\n)?(`{3,}|~{3,})\s*(?:\r?\n)?$/, '')
  }
  return block.source.trimEnd()
}

type SourceLine = {
  text: string
  from: number
  to: number
}

function sourceLines(doc: string): SourceLine[] {
  let offset = 0
  return doc.split('\n').map((text, index, lines) => {
    const from = offset
    const to = from + text.length + (index < lines.length - 1 ? 1 : 0)
    offset = to
    return { text, from, to }
  })
}

function objectFence(
  openingLine: string
): { kind: ObjectBlockKind; triggerToken?: string } | null {
  const chart = parseChartFenceOpeningLine(openingLine)?.chart
  if (chart) {
    const candidates = objectLayoutEntries()
      .filter((candidate) => objectLayoutReadsStorage(candidate, 'fence'))
    const entry = candidates.find((candidate) =>
      layoutEntryAcceptsTriggerToken(candidate, chart.token)
    )
    return entry
      ? { kind: detectedObjectKind(entry), triggerToken: chart.token }
      : null
  }

  const opening = parseMarkdownFenceOpeningLine(openingLine)
  if (!opening) return null
  const [tag = '', mode = ''] = opening.info.trim().toLowerCase().split(/\s+/)
  if (mode === 'code') return null
  const entry = objectLayoutEntries().find((candidate) => {
    if (!objectLayoutReadsStorage(candidate, 'fence')) return false
    return /^```(\S+)/.exec(candidate.trigger.trim())?.[1].toLowerCase() === tag
  })
  return entry ? { kind: detectedObjectKind(entry) } : null
}

function detectedObjectKind(entry: ObjectLayoutDef): ObjectBlockKind {
  // The generic GFM table and the registered trigger-list table keep distinct internal kinds.
  return entry.name === 'table'
    ? 'trigger-table'
    : entry.name as ObjectBlockKind
}

function triggerObject(
  line: string
): { kind: ObjectBlockKind; triggerToken: string } | null {
  if (/^\s/.test(line)) return null
  const trimmed = line.trim()
  if (!TRIGGER_LINE_RE.test(trimmed)) return null
  const winner = winningAuthoredLayout(trimmed)
  if (!winner) return null
  const candidates = objectLayoutEntries()
    .filter((candidate) => objectLayoutReadsStorage(candidate, 'trigger-list'))
  const entry = candidates.find((candidate) =>
    layoutEntryAcceptsTriggerToken(candidate, winner.triggerToken)
  ) ?? candidates.find((candidate) => candidate.name === winner.layout)
  return entry
    ? { kind: detectedObjectKind(entry), triggerToken: winner.triggerToken }
    : null
}

/**
 * Mirrors the compiler block lexer. Chart block tokens use the compiler's shared token/adjacency
 * resolver; trigger-line charts remain a compatibility reading only when no block token competes.
 * Fences deliberately diverge for unterminated runs: unfinished source stays editable.
 */
export function detectObjectBlocks(doc: string): ObjectBlock[] {
  const lines = sourceLines(doc)
  const rawLines = lines.map((line) => line.text)
  const fenceScan = scanFencedLines(rawLines)
  const fenced = fenceScan.flags
  const fenceExtents = new Map(fenceScan.extents.map((extent) => [extent.start, extent]))
  const blocks: ObjectBlock[] = []
  const separator = /^\|[\s:|-]+\|?$/
  const listItem = /^\s*(?:[-*]\s+|\d+[.)]\s+)/
  const ownerByLine: number[] = []
  let owner = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (!fenced[index] && /^(#{2,6})\s+/.test(lines[index].text)) owner = index
    ownerByLine[index] = owner
  }
  const chartKinds = new Set<ObjectBlockKind>([
    'chart',
    'barchart',
    'piechart',
    'linechart'
  ])
  const fencedObjects = new Map<number, NonNullable<ReturnType<typeof objectFence>>>()
  const slidesWithChartFences = new Set<number>()
  for (const extent of fenceScan.extents) {
    if (!extent.closed) continue
    const object = objectFence(lines[extent.start].text)
    if (!object) continue
    fencedObjects.set(extent.start, object)
    if (chartKinds.has(object.kind)) slidesWithChartFences.add(ownerByLine[extent.start])
  }
  const canonicalTriggerLines = new Set<number>()
  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index] || !/^(#{2,6})\s+/.test(lines[index].text)) continue
    const triggerBlock = logicalTriggerBlockAfterHeading(rawLines, index)
    // The compiler folds only the first non-blank Trigger-only line into the heading.
    // Any later Trigger-only line remains body content and may therefore own an adjacent list.
    if (triggerBlock) canonicalTriggerLines.add(triggerBlock.start)
  }
  const chartBlocks = new Map<number, NonNullable<ReturnType<typeof chartObjectTokenAt>>>()
  const slidesWithChartBlocks = new Set<number>()
  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index] || canonicalTriggerLines.has(index)) continue
    const token = chartObjectTokenAt(rawLines, index)
    if (!token) continue
    chartBlocks.set(index, token)
    slidesWithChartBlocks.add(ownerByLine[index])
  }
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    const trimmed = line.text.trim()
    const extent = fenceExtents.get(index)
    if (extent) {
      const object = fencedObjects.get(index)
      // An unfinished hand-authored fence stays editable source. Treating it as a complete widget
      // hijacks Enter and relocates typing while the author is still writing its body.
      if (object && extent.closed) {
        const closingLine = lines[extent.bodyEnd]
        const to = lines[extent.end - 1]?.to ?? line.to
        const bodyFrom = line.to
        const beforeClosing = doc.slice(bodyFrom, closingLine.from)
        const separatorLength = beforeClosing.endsWith('\r\n')
          ? 2
          : beforeClosing.endsWith('\n')
            ? 1
            : 0
        blocks.push({
          kind: object.kind,
          from: line.from,
          to,
          source: doc.slice(line.from, to),
          bodyFrom,
          bodyTo: closingLine.from - separatorLength,
          triggerToken: object.triggerToken
        })
      }
      // Even when incomplete, the fence body remains opaque to the rest of object detection.
      index = Math.max(extent.end, index + 1)
      continue
    }
    if (fenced[index]) {
      index += 1
      continue
    }

    const scopedChart = chartBlocks.get(index)
    if (scopedChart) {
      const trigger = triggerObject(line.text)
      let cursor = scopedChart.listStart
      let lastListLine = scopedChart.listStart
      while (cursor < lines.length && listItem.test(lines[cursor].text)) {
        lastListLine = cursor
        cursor += 1
      }
      const from = lines[scopedChart.listStart].from
      const to = lines[lastListLine].to
      if (trigger && !slidesWithChartFences.has(ownerByLine[index])) {
        blocks.push({
          kind: trigger.kind,
          from,
          to,
          source: doc.slice(from, to),
          triggerLine: index + 1,
          triggerToken: trigger.triggerToken
        })
      }
      index = cursor
      continue
    }

    const trigger = triggerObject(line.text)
    if (trigger) {
      if (
        chartKinds.has(trigger.kind)
        && (
          slidesWithChartBlocks.has(ownerByLine[index])
          || slidesWithChartFences.has(ownerByLine[index])
        )
      ) {
        index += 1
        continue
      }
      let start = index + 1
      while (start < lines.length && lines[start].text.trim() === '') start += 1
      if (start < lines.length && listItem.test(lines[start].text)) {
        let cursor = start
        let lastListLine = start
        while (cursor < lines.length) {
          if (listItem.test(lines[cursor].text)) {
            lastListLine = cursor
            cursor += 1
            continue
          }
          if (
            lines[cursor].text.trim() === ''
            && cursor + 1 < lines.length
            && listItem.test(lines[cursor + 1].text)
          ) {
            cursor += 1
            continue
          }
          break
        }
        const from = lines[start].from
        const to = lines[lastListLine].to
        blocks.push({
          kind: trigger.kind,
          from,
          to,
          source: doc.slice(from, to),
          triggerLine: index + 1,
          triggerToken: trigger.triggerToken
        })
        index = cursor
        continue
      }
    }

    if (
      trimmed.startsWith('|')
      && index + 1 < lines.length
      && separator.test(lines[index + 1].text.trim())
    ) {
      let end = index + 2
      while (end < lines.length && lines[end].text.trim().startsWith('|')) end += 1
      const to = lines[end - 1].to
      blocks.push({
        kind: 'gfm-table',
        from: line.from,
        to,
        source: doc.slice(line.from, to)
      })
      index = end
      continue
    }

    index += 1
  }

  return blocks
}
