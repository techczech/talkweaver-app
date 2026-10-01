export type ConflictService = 'onedrive' | 'dropbox' | 'gdrive' | 'git'
export type ConflictState = 'identical' | 'differs' | 'git-markers'
export type ConflictCopy = { name: string; service: ConflictService; source: string | null; state: ConflictState }
export type ConflictActivity = {
  at: string
  kind: 'identical-copy-removed'
  copyName: string
  service: ConflictService
  title: string
  detail: string
}

export type MachineOptions = { knownMachines?: string[]; loose?: boolean }
export function machineSlug(name: string): string
export function isMachineName(token: string, options?: MachineOptions): boolean
export function conflictServiceOf(name: string, canonicalName: string, options?: MachineOptions): { service: Exclude<ConflictService, 'git'>; source: string | null } | null
export function conflictCandidateNames(names: string[], canonicalName: string, options?: MachineOptions): string[]
export function hasGitConflictMarkers(text: string): boolean
export function classifyConflict(
  listing: Array<{ name: string; bytes?: Uint8Array | string | null }>,
  canonicalOutline: { name: string; bytes: Uint8Array | string },
  options?: MachineOptions
): ConflictCopy[]
export function sourceLabel(source: string | null): string | null
export function identicalCopyActivity(copy: ConflictCopy, at: string): ConflictActivity

export function createConflictScanner(deps: {
  trashItem: (path: string) => Promise<void>
  staysInside: (root: string, candidate: string) => string | null
  activity: { append(vaultId: string, slug: string, entry: ConflictActivity): unknown }
  canTouch?: (vaultId: string) => boolean
  withLock?: <T>(path: string, work: () => Promise<T>) => Promise<T>
  knownMachines?: (vaultId: string) => string[] | Promise<string[]>
  rememberMachines?: (vaultId: string, names: string[]) => unknown
  fs?: Record<string, unknown>
  now?: () => string
  log?: (message: string) => void
}): {
  scanFolder(input: { vaultId: string; folder: string; outlineName: string; slug: string; names?: string[] }): Promise<{ conflicts: number; copies: ConflictCopy[]; trashed: string[] } | null>
}
export function resolveByRealRoot<V extends { root: string }>(vaults: V[], path: string, realpath: (p: string) => string): { vault: V; rel: string } | null
