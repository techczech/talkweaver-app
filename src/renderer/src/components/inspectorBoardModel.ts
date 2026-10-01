// The Inspector's Board section (ADR-0032 §2; round-3 A2–A6): what it shows, read from the slide's
// own text with the compiler's reader (board-slide.mjs), so the section and the compiled board
// never disagree. The section writes back through `applyBoardEditToOutline` (the body) and the
// ordinary option commit path (the settings on the Trigger line).
import {
  BOARD_COLUMN_RANGE, BOARD_TEXT_LIMITS, boardFindings, boardQuestionOf, boardSource, readBoardSettings,
  type BoardColumnSource, type BoardFindingCode, type BoardSettings
} from '../../../../compiler/scripts/lib/board-slide.mjs'
import { parseTriggerLine } from '../../../shared/trigger-line.ts'

export { BOARD_COLUMN_RANGE, BOARD_TEXT_LIMITS }

/** The trigger keys a board's own line shows in the Settings group (never the id or tags). */
const BOARD_TRIGGER_KEYS = new Set(['poll', 'limit', 'length', 'cards', 'names', 'closes'])

export interface InspectorBoardModel {
  question: string
  instructions: string
  /** The example card's text; null when the slide has no `>` line. */
  example: string | null
  columns: BoardColumnSource[]
  settings: BoardSettings
  /** The board's tokens as the Trigger line carries them, e.g. `{poll=board} {limit=36}`. */
  triggerText: string
  findings: Array<{ code: BoardFindingCode; detail: string }>
  /** Add is offered below the most columns a board shows. */
  canAddColumn: boolean
  /** Remove is offered above the fewest columns a board needs. */
  canRemoveColumn: boolean
}

function tokenKey(raw: string): string {
  const at = raw.search(/[=:]/)
  return at > 0 ? raw.slice(0, at) : raw
}

/**
 * The Board section's model for one slide block (its heading line, then its body) and the slide's
 * logical Trigger line.
 */
export function inspectorBoardModel(block: string, triggerLine: string): InspectorBoardModel {
  const lines = block.split('\n').map((line) => line.replace(/\r$/, ''))
  const source = boardSource(lines.slice(1))
  const tokens = parseTriggerLine(triggerLine).filter((token) => BOARD_TRIGGER_KEYS.has(tokenKey(token.raw)))
  const attrs: Record<string, unknown> = {}
  for (const token of tokens) {
    const at = token.raw.indexOf('=')
    attrs[at > 0 ? token.raw.slice(0, at) : token.raw] = at > 0 ? token.raw.slice(at + 1) : true
  }
  return {
    question: boardQuestionOf(lines[0] ?? ''),
    instructions: source.instructions,
    example: source.example,
    columns: source.columns,
    settings: readBoardSettings(attrs).settings,
    triggerText: tokens.map((token) => `{${token.raw}}`).join(' '),
    findings: boardFindings(source),
    canAddColumn: source.columns.length < BOARD_COLUMN_RANGE.max,
    canRemoveColumn: source.columns.length > BOARD_COLUMN_RANGE.min
  }
}

/** The text a field's counter reads, e.g. `4/16`, and whether it is over its limit. */
export function boardCounter(text: string, limit: number): { label: string; over: boolean } {
  return { label: `${text.length}/${limit}`, over: text.length > limit }
}

/** Move one column from `from` to `to` (both indexes into the current list). */
export function moveBoardColumn<T>(columns: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= columns.length) return [...columns]
  const next = [...columns]
  const [moved] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved)
  return next
}

/** Columns as the source should hold them: names and hints trimmed; unnamed rows are not written. */
export function writtenBoardColumns(
  rows: ReadonlyArray<{ label: string; hint: string; extra?: readonly string[]; raw?: BoardColumnSource['raw'] }>
): BoardColumnSource[] {
  return rows
    .map((row) => ({ label: row.label.trim(), hint: row.hint.trim(), extra: [...(row.extra ?? [])], ...(row.raw ? { raw: row.raw } : {}) }))
    .filter((row) => row.label)
}

/** A stable comparison key for a column list (what was written vs what the source now reads). */
export function boardColumnsKey(rows: ReadonlyArray<{ label: string; hint: string }>): string {
  return JSON.stringify(writtenBoardColumns(rows).map(({ label, hint }) => [label, hint]))
}
