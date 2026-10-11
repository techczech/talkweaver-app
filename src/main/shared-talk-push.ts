// Part of Share for comments (ticket 12 design: the header of src/main/shared-talk.ts, k3–k4). The
// push: one at a time per talk, saves collapsed into one follow-up, revision = confirmed + 1, every
// confirmed revision's slide text kept for Compare. Stop aborts it and nothing it does lands after.
import { createHash } from 'crypto'
import { ownerFetch } from './owner-tokens.ts'
import type { SharedTalkSlide } from '../shared/shared-talk.ts'
import {
  abortable, Cancelled, describe, errorMessage, HttpError, readJson, readRevisionSnapshot, revisionSnapshotPath, writeFileAtomic,
  type Attempt, type PushMode, type RevisionSnapshot, type SharedTalkRecord,
} from './shared-talk-model.ts'
import type { ShareCore } from './shared-talk-state.ts'

export function createPush(core: ShareCore): { enqueue(key: string, mode: PushMode): Promise<void> } {
  const { deps, registry, attempts, lastError, inFlight, chains, queued, running, pendingSave, live, stoppingKey, persist, emit, log, now } = core

  async function putTalk(record: SharedTalkRecord, revision: number, html: string, slides: SharedTalkSlide[], signal: AbortSignal): Promise<{ ok: true; revision: number } | { ok: false; conflictAt: number }> {
    const response = await ownerFetch(deps.fetch, `${record.workerBaseUrl}/shares/${record.shareId}/talk`, record.ownerToken, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision, html, slides }),
      signal: AbortSignal.any([AbortSignal.timeout(60_000), signal]),
    })
    const body = await readJson(response)
    if (response.ok) {
      const confirmed = Number((body as { revision?: unknown } | null)?.revision)
      return { ok: true, revision: Number.isInteger(confirmed) && confirmed > 0 ? confirmed : revision }
    }
    const current = Number((body as { revision?: unknown } | null)?.revision)
    if (response.status === 409 && Number.isInteger(current) && current >= 0) return { ok: false, conflictAt: current }
    if (response.status === 410) throw new HttpError(410, 'this share has been stopped or retired. Share again for a new link.')
    if (response.status === 401 || response.status === 403) throw new HttpError(response.status, 'the sharing service no longer accepts this talk’s owner credential.')
    throw new HttpError(response.status, errorMessage(body, `the sharing service answered ${response.status}.`))
  }

  function keepRevision(record: SharedTalkRecord, attempt: Attempt, revision: number, pushedAt: string): void {
    try {
      const snapshot: RevisionSnapshot = { shareId: record.shareId, revision, pushedAt, slides: attempt.slides, source: attempt.source }
      writeFileAtomic(revisionSnapshotPath(record.outlinePath, record.shareId, revision), JSON.stringify(snapshot, null, 2))
    } catch (error) {
      log(`[shared-talk] revision ${revision} slide text not kept: ${describe(error)}`)
    }
  }

  function confirm(record: SharedTalkRecord, attempt: Attempt, revision: number): void {
    const pushedAt = now().toISOString()
    record.revision = revision
    record.lastPushedAt = pushedAt
    record.lastPushHash = attempt.hash
    persist()
    keepRevision(record, attempt, revision, pushedAt)
  }

  async function pushOnce(key: string, mode: PushMode, saved: string | null): Promise<void> {
    const record = registry.shares[key]
    if (!record || !live(key, record)) return
    const controller = new AbortController()
    const shareId = record.shareId
    inFlight.set(shareId, controller)
    try {
      let source: string
      let payload: { html: string; slides: SharedTalkSlide[] }
      if (mode.kind === 'confirmed') {
        // Switch 1 off and switch 2 changed: their page's permissions change, the talk they see does
        // not — rebuilt from the last CONFIRMED revision as kept on disk, never the outline now.
        const snapshot = record.revision > 0 ? readRevisionSnapshot(record.outlinePath, record.shareId, record.revision) : null
        if (!snapshot || !snapshot.source) throw new Error(`revision ${record.revision} is not kept on this Mac; use Update shared copy.`)
        source = snapshot.source
        const built = await abortable(deps.build({ outlinePath: record.outlinePath, content: source, slug: record.slug, proposals: record.proposals, signal: controller.signal }), controller.signal)
        payload = { html: built.html, slides: snapshot.slides }
      } else {
        source = saved ?? await abortable(deps.readOutline(record.outlinePath), controller.signal)
        if (!live(key, record)) throw new Cancelled()
        payload = await abortable(deps.build({ outlinePath: record.outlinePath, content: source, slug: record.slug, proposals: record.proposals, signal: controller.signal }), controller.signal)
      }
      if (!live(key, record)) throw new Cancelled()
      const hash = createHash('sha256').update(payload.html).update('\0').update(JSON.stringify(payload.slides)).digest('hex')
      if (mode.kind === 'save' && hash === record.lastPushHash && record.revision > 0) return
      const prior = attempts.get(key)
      let revision = record.revision + 1
      for (let round = 0; round < 3; round += 1) {
        const attempt: Attempt = { revision, slides: payload.slides, source, hash }
        attempts.set(key, attempt)
        const result = await putTalk(record, revision, payload.html, payload.slides, controller.signal)
        if (!live(key, record)) throw new Cancelled()
        if (result.ok) {
          confirm(record, attempt, result.revision)
          attempts.delete(key)
          lastError.set(key, null)
          return
        }
        log(`[shared-talk] ${record.slug}: revision ${revision} refused; the Worker is at ${result.conflictAt}`)
        // Lost reply: an earlier attempt landed but its answer never arrived. The Worker's revision
        // IS that attempt, so keep its slides as that revision's file.
        if (prior && prior.revision === result.conflictAt && result.conflictAt > record.revision) {
          confirm(record, prior, prior.revision)
          if (prior.hash === hash) { attempts.delete(key); lastError.set(key, null); return }
        } else {
          record.revision = result.conflictAt
        }
        revision = result.conflictAt + 1
      }
      throw new Error('the shared copy kept moving on the sharing service; try Update shared copy.')
    } finally {
      if (inFlight.get(shareId) === controller) inFlight.delete(shareId)
    }
  }

  /** Queue a push behind any running one. While a save push is queued (not started) later saves
   *  ride on it, reading the newest saved text when it starts. */
  function enqueue(key: string, mode: PushMode): Promise<void> {
    if (mode.kind === 'save' && queued.has(key)) return chains.get(key) ?? Promise.resolve()
    queued.add(key)
    emit(key)
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.then(async () => {
      queued.delete(key)
      if (stoppingKey(key) || !registry.shares[key]) return
      running.add(key)
      const saved = mode.kind === 'save' ? pendingSave.get(key) ?? null : null
      if (mode.kind === 'save') pendingSave.delete(key)
      try {
        await pushOnce(key, mode, saved)
      } catch (error) {
        if (error instanceof Cancelled || stoppingKey(key)) return
        lastError.set(key, describe(error))
        log(`[shared-talk] push failed: ${describe(error)}`)
        if (mode.kind !== 'save') throw error
      } finally {
        running.delete(key)
        emit(key)
      }
    })
    const settled = next.catch(() => {})
    chains.set(key, settled)
    void settled.then(() => { if (chains.get(key) === settled && !queued.has(key) && !running.has(key)) chains.delete(key) })
    return next
  }

  return { enqueue }
}
