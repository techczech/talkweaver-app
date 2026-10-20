// Plan a run, change a planned Run and take one away (history:create-planned-run, history:update-planned-run,
// history:delete-planned-run). A planned Run lives in the vault of its talk (multi-vault architecture: "runs …
// take a root; pass the talk's vault root"):
//   - a request that names a vault (`vaultId`: the plan sheet sends its talk's) is written into that vault only,
//     while it is open and its folder is there; a closed, unknown or missing vault is refused and nothing is
//     written anywhere: never the first writable vault in its place. A new plan is refused too when its talk is
//     not in that vault, so a Run is never planned into a vault that does not hold its talk;
//   - a request with no `vaultId` (History, older callers) acts in the current vault, as before; except that, while
//     more than one vault is open, a new plan for a talk the current vault does not hold is refused (issue 256): the
//     Run is never written into the first vault merely because it is first.
// Pure of Electron: history.ts registers these on ipcMain; the tests call them with two vault folders.
import { randomUUID } from 'node:crypto'
import { changeDeliveredRunWork, createPlannedRun, deletePlannedRun, updatePlannedRun, type PlannedRunInput, type PlannedRunPatch, type RunRecord } from './runs.ts'

export interface PlannedRunsDeps {
  /** The current vault's root for a write (the first open vault, only while its folder is there), or null. */
  vaultRoot(): string | null
  /**
   * The vault a request names (index.ts runVaultFor, run-page.ts runVaultRoot): that open vault's root while
   * it can be written, or the refusal in words. Without it, a request that names a vault is refused.
   */
  runVault?(vaultId: unknown): { root: string | undefined } | { error: string }
  /** Whether the talk is in that vault (findTalks). Without it a new plan is not checked against its talk. */
  hasTalk?(vaultRoot: string, talkSlug: string): boolean
  /** How many vaults are open. Without it, one (a new plan naming no vault goes to the current vault, as before). */
  openVaults?(): number
  /** A plan was saved with a change, in this vault (history.ts HistoryDeps.onPlannedRunUpdated). */
  onPlannedRunUpdated?(talkSlug: string, runId: string, vaultRoot: string): void
  /** Ids of new Runs (tests pass a fixed one). */
  mintId?(): string
}

export type PlannedRunReply = { ok: true; run: RunRecord } | { ok: false; error: string }

/** Said when the plan names a vault that does not hold the talk. */
export const TALK_NOT_IN_VAULT = 'That talk is not in this vault, so the run was not planned.'
/** Said when a new plan names no vault, more than one vault is open and the current vault does not hold the talk. */
export const NAME_THE_VAULT = 'More than one vault is open and this plan does not say which vault its talk is in, so the run was not planned. Plan it from the talk itself.'
const VAULT_NOT_OPEN = 'That Run\'s vault is not open on this computer, so nothing was changed.'

/**
 * The vault this request writes to: the one it names, else (no `vaultId` key at all) the current vault; or the
 * refusal. As runVaultRoot: null, '' or a value that is not text is refused, never read as "no vault named".
 */
export function plannedRunVault(deps: PlannedRunsDeps, vaultId: unknown): { root: string } | { error: string } {
  if (vaultId === undefined) {
    const root = deps.vaultRoot()
    return root ? { root } : { error: 'no-vault' }
  }
  if (typeof vaultId !== 'string' || !vaultId) return { error: VAULT_NOT_OPEN }
  const picked = deps.runVault ? deps.runVault(vaultId) : { error: VAULT_NOT_OPEN }
  if ('error' in picked) return picked
  return picked.root ? { root: picked.root } : { error: VAULT_NOT_OPEN }
}

/** The vault a read names (history:list-runs, history:talk-handouts): none (undefined: the current vault), that
 *  open vault, or null for one that is not open and for null, '' or a value that is not text. */
export function readRoot(deps: { vaultRoot(): string | null; readVault?(vaultId: string): string | undefined }, vaultId: unknown): string | null {
  if (vaultId === undefined) return deps.vaultRoot()
  return typeof vaultId === 'string' && vaultId ? deps.readVault?.(vaultId) ?? null : null
}

const failed = (cause: unknown): { ok: false; error: string } => ({ ok: false, error: cause instanceof Error ? cause.message : String(cause) })

/** `history:create-planned-run`: the plan (and "Plan the next run like this", which sends a new plan) with an optional `vaultId`. */
export function createPlannedRunIn(deps: PlannedRunsDeps, payload: unknown): PlannedRunReply {
  try {
    const { vaultId, ...input } = (payload && typeof payload === 'object' ? payload : {}) as PlannedRunInput & { vaultId?: unknown }
    const vault = plannedRunVault(deps, vaultId)
    if ('error' in vault) return { ok: false, error: vault.error }
    if (vaultId !== undefined && deps.hasTalk && !deps.hasTalk(vault.root, String(input.talkSlug ?? ''))) return { ok: false, error: TALK_NOT_IN_VAULT }
    // No vault named while several are open: the current vault only when it holds the talk (History plans its own vault's talks).
    if (vaultId === undefined && (deps.openVaults?.() ?? 1) > 1 && !deps.hasTalk?.(vault.root, String(input.talkSlug ?? ''))) return { ok: false, error: NAME_THE_VAULT }
    return { ok: true, run: createPlannedRun(vault.root, input as PlannedRunInput, deps.mintId ?? (() => `run-${randomUUID()}`), { refuseNewSectionPrework: true }) }
  } catch (cause) {
    return failed(cause)
  }
}

/** `history:update-planned-run` ({ talkSlug, runId, patch, vaultId? }): a planned Run's plan, or a delivered Run's work times. */
export function updatePlannedRunIn(deps: PlannedRunsDeps, payload: unknown): PlannedRunReply {
  try {
    const { talkSlug, runId, patch, vaultId } = (payload ?? {}) as { talkSlug?: unknown; runId?: unknown; patch?: PlannedRunPatch; vaultId?: unknown }
    const vault = plannedRunVault(deps, vaultId)
    if ('error' in vault) return { ok: false, error: vault.error }
    // A delivered Run's Change time (ticket 19): only its work times change, and a later closing time
    // reopens the phase on the service (onPlannedRunUpdated pushes it), and post-work changed to open when the
    // session ends opens now.
    const run = updatePlannedRun(vault.root, String(talkSlug), String(runId), patch as PlannedRunPatch, { refuseNewSectionPrework: true })
      ?? changeDeliveredRunWork(vault.root, String(talkSlug), String(runId), patch as PlannedRunPatch)
    if (run) { try { deps.onPlannedRunUpdated?.(run.talkSlug, run.id, vault.root) } catch { /* best effort: the plan is saved */ } }
    return run ? { ok: true, run } : { ok: false, error: 'planned-run-not-found' }
  } catch (cause) {
    return failed(cause)
  }
}

/** `history:delete-planned-run` ({ talkSlug, runId, vaultId? }). */
export function deletePlannedRunIn(deps: PlannedRunsDeps, payload: unknown): { ok: true } | { ok: false; error: string } {
  try {
    const { talkSlug, runId, vaultId } = (payload ?? {}) as { talkSlug?: unknown; runId?: unknown; vaultId?: unknown }
    const vault = plannedRunVault(deps, vaultId)
    if ('error' in vault) return { ok: false, error: vault.error }
    return deletePlannedRun(vault.root, String(talkSlug), String(runId)) ? { ok: true } : { ok: false, error: 'planned-run-not-found' }
  } catch (cause) {
    return failed(cause)
  }
}
