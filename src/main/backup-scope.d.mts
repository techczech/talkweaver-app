export const AUTO_ENROL_LIMIT: number
export const STALE_DAYS: number
export const SAVE_DEBOUNCE_MS: number

export type BackupTalkRecord = {
  title: string
  outlinePath: string
  appOpenedAt: number
  appEditedAt: number
  lastBackupAt: number
  enrolled: boolean
  decidedAt: number
}

export type BackupScopeState = {
  version: 2
  signatures: Record<string, string>
  talks: Record<string, BackupTalkRecord>
}

export type BackupCandidate = { slug: string; title: string; lastAppEditAt: number; enrolled?: boolean }

export type EnrolmentDecision =
  | { kind: 'auto'; enrol: string[] }
  | { kind: 'ask'; candidates: Array<{ slug: string; title: string; lastAppEditAt: number }>; defaults: string[] }

export function loadScope(raw: unknown): BackupScopeState
export function recordAppEdit(state: BackupScopeState, input: { slug: string; title?: string; outlinePath?: string; atMs: number }): BackupScopeState
export function recordAppOpen(state: BackupScopeState, input: { slug: string; title?: string; outlinePath?: string; atMs: number }): BackupScopeState
export function recordBackup(state: BackupScopeState, slug: string, atMs: number): BackupScopeState
export function setEnrolled(state: BackupScopeState, slug: string, enrolled: boolean, atMs?: number): BackupScopeState
export function enrolledSlugs(state: BackupScopeState): string[]
export function appEditedTalks(state: BackupScopeState): BackupCandidate[]
export function expireStale(state: BackupScopeState, nowMs: number, staleDays?: number): string[]
export function enrolmentDecision(candidates: BackupCandidate[], enrolled: string[], options?: { limit?: number }): EnrolmentDecision
export function applyEnrolmentChoice(state: BackupScopeState, chosenSlugs: string[], atMs?: number): BackupScopeState
export function talksNeedingLaunchBackup(state: BackupScopeState): Array<{ slug: string; outlinePath: string; title: string }>
