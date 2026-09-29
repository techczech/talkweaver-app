export type StatementDimension = 'sidebar' | 'bg' | 'align' | 'bar'
export const STATEMENT_DIMENSION_KEYS: Readonly<Record<StatementDimension, string>>
export const STATEMENT_DIMENSION_VALUES: Readonly<Record<StatementDimension, readonly string[]>>
export const STATEMENT_DEFAULTS: Readonly<Record<StatementDimension, string>>
export const STATEMENT_PRESETS: Readonly<Record<string, Readonly<{ bg: string; align: string; bar: string }>>>
export function canonicalStatementValue(dimension: StatementDimension, value: unknown): string | null
export function isStatementDimensionKey(key: string): boolean
export interface StatementLook {
  sidebar: '' | 'on' | 'off'
  bg: 'halo' | 'full' | 'none'
  align: 'left' | 'centred'
  bar: 'none' | 'left' | 'top' | 'bottom'
  accent: string
  preset: string
  centredNeedsNoTitle: boolean
  explicit: Partial<Record<StatementDimension, true>>
  warnings: string[]
}
export function resolveStatementOptions(attrs?: Record<string, unknown>, options?: { deckClaimStyle?: string }): StatementLook
export function statementDimensionTokens(
  look: Partial<Record<StatementDimension, string>>,
  options?: { pinAgainstDeck?: boolean; keep?: StatementDimension | '' }
): string[]
