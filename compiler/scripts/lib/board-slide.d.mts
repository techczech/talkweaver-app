export const BOARD_TEXT_LIMITS: Readonly<{ name: number; hint: number; instructions: number; example: number }>
export const BOARD_COLUMN_RANGE: Readonly<{ min: number; max: number }>
export interface BoardSettingDeclaration { key: 'limit' | 'length' | 'cards' | 'names' | 'closes'; values: string[]; fallback: string; field: keyof BoardSettings; read: (value: string) => number | null | boolean }
export const BOARD_SETTINGS: readonly BoardSettingDeclaration[]
export interface BoardSettings {
  /** Cards on the big screen; null = all. */
  limit: number | null
  cardChars: number
  cardsPerPhone: number
  /** Names optional (a card may carry a name only the presenter sees). */
  names: boolean
  closesAfterDays: number
}
export const BOARD_DEFAULTS: Readonly<BoardSettings>
export const BOARD_LIVE_LIMITS: Readonly<{ instructions: number; example: number; hint: number }>
export const BOARD_STARTER: Readonly<{ question: string; instructions: string; columns: Array<{ label: string; hint: string }> }>
export function boardStarterLines(level?: number, id?: string): string[]
export function readBoardSettings(attrs?: Record<string, unknown>): { settings: BoardSettings; issues: string[] }
/** A column as written: `raw` holds its item and hint lines' bytes for the writer (absent on a new column). */
export interface BoardColumnSource { label: string; hint: string; extra: string[]; raw?: { item: string; hint: string | null } }
export interface BoardBodyRead {
  instructions: { text: string; start: number; end: number } | null
  example: { text: string; start: number; end: number } | null
  list: { start: number; end: number; marker: string; hintIndent: string; columns: BoardColumnSource[] } | null
}
export function readBoardBody(lines?: readonly string[]): BoardBodyRead
export interface BoardSource { instructions: string; example: string | null; columns: BoardColumnSource[] }
export function boardSource(lines?: readonly string[]): BoardSource
export type BoardFindingCode =
  | 'board-columns-few' | 'board-columns-many' | 'board-column-name-long' | 'board-column-hint-long'
  | 'board-instructions-long' | 'board-example-long' | 'board-live-limit'
export function boardFindings(source: { instructions?: string; example?: string | null; columns?: ReadonlyArray<{ label: string; hint: string }> }): Array<{ code: BoardFindingCode; detail: string }>
export function boardQuestionOf(heading: string): string
export type BoardEdit =
  | { kind: 'question'; text: string }
  | { kind: 'instructions'; text: string }
  | { kind: 'example'; text: string | null }
  | { kind: 'columns'; columns: ReadonlyArray<{ label: string; hint?: string; extra?: readonly string[]; raw?: { item: string; hint: string | null } }> }
export function applyBoardEdit(slideLines: readonly string[], edit: BoardEdit): string[]
export function applyBoardEditToOutline(content: string, headingLine: number, edit: BoardEdit): string
export function boardStarterInsertion(text: string, caret: number, id?: string): { at: number; insert: string; questionFrom: number; questionTo: number }
export function mintBoardSlideId(text: string, rng?: () => number): string
export function slideBlockEnd(lines: readonly string[], headingIndex: number): number
