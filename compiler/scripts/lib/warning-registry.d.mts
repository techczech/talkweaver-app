export type WarningSeverity = 'error' | 'warning' | 'hint'
export type WarningSurface = 'strip-badge' | 'inspector' | 'doctor' | 'never-ui'
export interface WarningDefinition {
  id: string
  severity: WarningSeverity
  message: string
  remedy: string
  surfaces: WarningSurface[]
}
export const WARNING_SEVERITIES: WarningSeverity[]
export const WARNING_SURFACES: WarningSurface[]
export const WARNING_REGISTRY: WarningDefinition[]
export function warningDefinition(rawWarning: string): WarningDefinition | null
export function formatWarning(rawWarning: string): string
export function warningsForSurface(rawWarnings: string[] | null | undefined, surface: WarningSurface): string[]
