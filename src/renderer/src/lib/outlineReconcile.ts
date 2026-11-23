import { mergeOutline, resolveOutlineMerge, normalizeOutlineMergeText, type OutlineMerge } from '../../../shared/outline-merge.ts'
import type { OutlineDiskResolverDeps } from './outlineDiskChange.ts'

export interface OutlineMergeReview {
  generation: number; base: string; mine: string; disk: string; hash: string; merge: OutlineMerge; recoveryPath?: string
}
export interface OutlineReconcileDeps extends OutlineDiskResolverDeps {
  readBase(outlinePath: string): string | null
  preserve(outlinePath: string, snapshot: { base: string; mine: string; disk: string; draft?: string }): Promise<string | null>
}
export type ReconcileResult =
  | { kind: 'ready' | 'conflict'; review: OutlineMergeReview }
  | { kind: 'saved' | 'reloaded' | 'retry' | 'removed' | 'ignored' }
  | { kind: 'error'; error: string; recoveryFailed?: boolean }
let reviewGeneration = 0
const error = (e: unknown): ReconcileResult => ({ kind: 'error', error: e instanceof Error ? e.message : String(e) })
const preserve = async (path: string, snapshot: { base: string; mine: string; disk: string; draft?: string }, deps: OutlineReconcileDeps): Promise<string | null> => {
  try { return await deps.preserve(path, snapshot) } catch { return null }
}
const recoveryError = (message: string): ReconcileResult => ({ kind: 'error', error: message, recoveryFailed: true })
const unchanged = (path: string, review: OutlineMergeReview, deps: OutlineReconcileDeps): boolean =>
  deps.readBuffer(path) === review.mine && deps.readBase(path) === review.base

export async function prepareOutlineMerge(path: string, deps: OutlineReconcileDeps): Promise<ReconcileResult> {
  try {
    await deps.settled(path)
    if (deps.store.get(path)?.kind === 'partial') return { kind: 'ignored' }
    const base = deps.readBase(path), mine = deps.readBuffer(path)
    if (base === null || mine === null) return { kind: 'ignored' }
    const reported = deps.store.get(path)
    const disk = await deps.diskVersion(path)
    if (!disk) return { kind: 'removed' }
    const pending = deps.store.get(path)
    // A later notification wins over this read. Otherwise the stable snapshot supersedes
    // the old watcher report without accepting it as the guarded write baseline.
    if (pending !== reported && pending?.hash !== disk.hash) return { kind: 'retry' }
    if (pending?.kind === 'changed' && pending.hash !== disk.hash) {
      deps.store.report({ outlinePath: path, kind: 'changed', hash: disk.hash, changedAt: Date.now() })
    }
    const review: OutlineMergeReview = { generation: ++reviewGeneration, base, mine, disk: disk.text, hash: disk.hash, merge: mergeOutline(base, mine, disk.text) }
    if (!unchanged(path, review, deps)) return { kind: 'retry' }
    if (mine !== base) {
      const kept = await preserve(path, review, deps)
      if (!kept) return recoveryError('Could not keep both versions in recovery. Nothing was changed; retry the merge.')
      review.recoveryPath = kept
      if (!unchanged(path, review, deps)) return { kind: 'retry' }
    }
    return { kind: review.merge.conflicts.length ? 'conflict' : 'ready', review }
  } catch (e) { return error(e) }
}

export async function applyOutlineMerge(path: string, review: OutlineMergeReview, choices: Record<string, string>, deps: OutlineReconcileDeps, decision: 'merge' | 'put-back' = 'merge'): Promise<ReconcileResult> {
  const text = decision === 'put-back' ? review.mine : resolveOutlineMerge(review.merge, choices)
  if (text === null) return error('Choose or edit each conflicting slide before applying the merge.')
  try {
    await deps.settled(path)
    if (!unchanged(path, review, deps)) return { kind: 'retry' }
    // Preserve a manually edited result too. A failed archive never advances the disk baseline.
    if (review.merge.conflicts.length || decision === 'put-back') {
      if (!await preserve(path, { ...review, draft: text }, deps)) return recoveryError('Could not keep the merge result in recovery. Nothing was changed.')
      if (!unchanged(path, review, deps)) return { kind: 'retry' }
    }
    const disk = await deps.diskVersion(path)
    if (!disk) return { kind: 'removed' }
    if (disk.hash !== review.hash) return { kind: 'retry' }
    // Adoption and acknowledgement occupy one queue turn. Adoption invalidates queued older
    // snapshots; new typing is admitted and saved with the observed disk hash.
    const adopted = await deps.queue(path, async (): Promise<ReconcileResult | null> => {
      if (!unchanged(path, review, deps)) return { kind: 'retry' }
      // Adopt synchronously before the acknowledgement. Typing after this point is based on
      // the merged document. Every ensuing write carries its observed disk hash, including
      // when acknowledgement fails because the disk reverted to the main guard's old base.
      if (!deps.replaceBuffer(path, text, { fromDisk: true, diskBase: review.disk, diskHash: review.hash })) return error('The talk is no longer ready in its editor. Retry the merge.')
      const keepPending = text !== normalizeOutlineMergeText(review.disk)
      const revision = keepPending ? undefined : deps.revision?.()
      const accepted = await deps.accept(path, review.hash, { keepPending, revision })
      if (!accepted.ok) {
        if (accepted.change) deps.store.report(accepted.change)
        if (accepted.change?.kind === 'partial') return error('A save failed halfway. The full editor text is kept; use Save again in the disk notice.')
        if (accepted.change?.kind === 'removed') return { kind: 'removed' }
        return accepted.error ? error(accepted.error) : { kind: 'retry' }
      }
      return null
    })
    if (adopted) return adopted
    if (text === normalizeOutlineMergeText(review.disk)) {
      deps.store.clear(path, review.hash)
      // A clean reload has no local changes to archive or discard. An earlier session's
      // unsaved recovery copy stays available even when its folder is currently unwritable.
      if (review.mine !== review.base) await deps.discardRecovery?.(path)
      return { kind: review.mine === review.base ? 'reloaded' : 'saved' }
    }
    if (!await deps.saveBuffer(path)) return error('The merged text is in the editor and recovery, but could not be saved. Retry after checking the disk notice.')
    deps.store.clear(path, review.hash)
    return { kind: 'saved' }
  } catch (e) { return error(e) }
}
