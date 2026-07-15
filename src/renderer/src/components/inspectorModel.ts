import type { ProjectionRow } from '../../../preload/index.ts'
import type { LayoutDef } from '../../../shared/layout-registry/entries.ts'
import type { OptionGroup } from '../../../shared/layout-registry/entries.ts'
import { groupApplies, optionGroupsForSlide, type ApplicableOptionGroup } from '../../../shared/layout-registry/options.ts'
import { commitOptionSelection, logicalTriggerBlockAfterHeading, selectionForGroup } from '../../../shared/trigger-line.ts'
import { selectionFromTriggerLine } from './layoutPickerModel.ts'

export type PaneState = 'both' | 'editor' | 'strip'

export function migratePaneState(value: unknown): PaneState {
  if (value === 'inspector') return 'strip'
  return value === 'both' || value === 'editor' || value === 'strip' ? value : 'both'
}

export function migrateInspectorMode(paneValue: unknown, modeValue: unknown): boolean {
  if (paneValue === 'inspector') return true
  return modeValue === true || modeValue === 'true'
}

export function navigateInspectorSlide(index: number, direction: -1 | 1, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(count - 1, index + direction))
}

export function resolveInspectedSlide(
  rows: readonly Pick<ProjectionRow, 'slide_id'>[] | null,
  inspectedId: string | null,
  previousIndex: number
): { id: string | null; index: number } {
  if (!rows?.length) return { id: null, index: 0 }
  if (inspectedId) {
    const index = rows.findIndex((row) => row.slide_id === inspectedId)
    if (index >= 0) return { id: inspectedId, index }
  }
  const index = Math.max(0, Math.min(rows.length - 1, previousIndex))
  return { id: rows[index]?.slide_id ?? null, index }
}

/** Follow genuine editor navigation while preserving Inspector identity during an option write. */
export function inspectedSlideIdAfterCursorChange(
  rows: readonly Partial<ProjectionRow>[] | null,
  activeIndex: number,
  currentId: string | null,
  commitInProgress: boolean
): string | null {
  if (commitInProgress) return currentId
  return rows?.[activeIndex]?.slide_id ?? currentId
}

export function headingLineForSlideId(
  content: string,
  slideId: string | null
): number | null {
  if (!slideId) return null
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(\{[^}]*\}\s*)+$/.test(lines[index])) continue
    const id = [...lines[index].matchAll(/\{id=([^}]+)\}/g)].find((match) => match[1] === slideId)
    if (!id) continue
    for (let heading = index - 1; heading >= 0; heading -= 1) {
      if (/^#{1,6}\s/.test(lines[heading])) return heading + 1
    }
  }
  return null
}

/** Live source for one rendered slide under the heading-is-slide model. */
export function extractInspectorSlideBlock(content: string, headingLine: number | null): string | null {
  if (headingLine == null) return null
  const lines = content.split('\n')
  const start = headingLine - 1
  const match = lines[start]?.match(/^(#{1,6})\s/)
  if (!match) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = lines[index].match(/^(#{1,6})\s/)
    if (next) { end = index; break }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  return lines.slice(start, end).join('\n')
}

/** Commit an Inspector option without CodeMirror while preserving all unrelated source bytes. */
export function applyInspectorOptionToOutline(
  content: string,
  headingLine: number | null,
  group: OptionGroup,
  token: string
): string | null {
  if (headingLine == null) return null
  const lines = content.split('\n')
  const headingIndex = headingLine - 1
  if (!/^(#{1,6})\s/.test(lines[headingIndex] ?? '')) return null

  const block = logicalTriggerBlockAfterHeading(lines, headingIndex)
  const committed = commitOptionSelection(block?.line ?? '', group, token)

  if (block) {
    if (committed === block.line && block.end === block.start + 1 && block.warnings.length === 0) return content
    for (const warning of block.warnings) console.warn(warning)
    const carriageReturn = lines[block.start].endsWith('\r') ? '\r' : ''
    lines.splice(block.start, block.end - block.start, committed + carriageReturn)
  } else {
    const headingHasCarriageReturn = lines[headingIndex].endsWith('\r')
    lines.splice(headingIndex + 1, 0, committed + (headingHasCarriageReturn ? '\r' : ''))
  }
  return lines.join('\n')
}

export interface InspectorStepModel {
  count: number
  mode: '' | 'reveal' | 'focus' | 'group' | 'carousel'
}

export function stepModelForSlide(row: Partial<ProjectionRow> | null | undefined): InspectorStepModel {
  if (!row) return { count: 0, mode: '' }
  const source = row.source_markdown ?? ''
  const carousel = row.layout === 'carousel' || row.triggers?.layout === 'carousel' || /\{carousel\}/.test(source)
  if (carousel) {
    const children = source.split('\n').filter((line) => /^####\s/.test(line)).length
    return { count: children, mode: children > 0 ? 'carousel' : '' }
  }
  const authored = String(row.triggers?.mode ?? '')
  const match = source.match(/\{(reveal|focus|group)\}/) || authored.match(/^(reveal|focus|group)$/)
  const mode = (match?.[1] ?? '') as InspectorStepModel['mode']
  if (!mode) return { count: 0, mode: '' }
  const bullets = Number(row.bullet_count) || source.split('\n').filter((line) => /^\s*[-*+]\s+/.test(line)).length
  return { count: bullets, mode: bullets > 0 ? mode : '' }
}

export interface InspectorModel {
  title: string
  layoutName?: string
  groups: ApplicableOptionGroup[]
  selectedTokens: Record<string, string>
  steps: InspectorStepModel
}

export function inspectorModel(
  rows: readonly Partial<ProjectionRow>[] | null,
  activeIndex: number,
  headingLevel: number,
  triggerLine: string,
  layouts: readonly LayoutDef[],
  sourceMarkdown?: string,
  hasChildren = false
): InspectorModel {
  const row = rows?.[activeIndex] ?? null
  const layoutName = selectionFromTriggerLine(triggerLine, layouts).find((entry) => entry.kind === 'layout')?.name
    ?? row?.triggers?.layout
    ?? row?.layout
  const candidates = optionGroupsForSlide({ layoutName, headingLevel, hasChildren })
  const selectedTokens = Object.fromEntries(candidates.map(({ group }) => [group.key, selectionForGroup(triggerLine, group)]))
  const groups = candidates.filter(({ group }) => groupApplies(group, { headingLevel, hasChildren, layoutName, selectedTokens }))
  return {
    title: row?.nav_title || row?.title || '(untitled)',
    layoutName,
    groups,
    selectedTokens,
    steps: stepModelForSlide(row ? { ...row, source_markdown: sourceMarkdown ?? row.source_markdown } : null)
  }
}
