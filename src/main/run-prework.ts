// A planned Run's pre-work, main-process side (ADR-0032 amendment points 2–4; feedback-boards ticket 09).
//
// One pre-work object on the live Worker per Run. The app keeps it in a registry file in app data
// (mode 0600) with its owner token, which never reaches a window, the window it was pushed with, and
// how far the Run has been mirrored (`cursor`, the Worker's sequence number).
//   - publish: creates the object on first use (admin secret, once) and pushes the public form and
//     the Run's window; the handout is then built with the object's id;
//   - pull: pages every entry after the cursor and merges them onto the Run through the atomic Run
//     writer, by entry id; the cursor moves only once the Run is written. On demand from History, and
//     on a timer while any Run's pre-work is open;
//   - close: "Close pre-work now" on the Worker with the object's own token, then one last pull.
//
// Invariants: the form pushed carries no right answer (publicPreworkForm, checked again by the Worker);
// a Run is read only from its talk's own folder and written back only there (readRunForTalk /
// persistRunForTalk); a push or pull only ever goes to the Worker origin the object was created on.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { isShareId } from '../shared/share-id.ts'
import { applyPickChange, type PickChange } from '../shared/run-prework-results.ts'
import { RUN_PREWORK_MAX_SLIDE_ID } from '../shared/run-prework.ts'
import type { PreworkForm } from '../shared/run-prework.ts'
import { applyRunPrework, markRunPreworkQuestion, persistRunForTalk, readRunForTalk, setRunPreworkPick, type RunRecord } from './runs.ts'

export interface RunPreworkRow {
  key: string
  preworkId: string
  ownerToken: string
  workerBaseUrl: string
  opensAt: number
  closesAt: number
  /** The Worker's sequence number the Run has been mirrored up to. */
  cursor: number
  createdAt: number
  /** Closed early from the app. */
  closedAt?: number
  /** When the app found the object purged on the Worker (60 idle days): never asked again. */
  purgedAt?: number
}

export interface RunPreworkDeps {
  /** {userData}/run-prework-registry.json */
  registryPath: string
  /** The live Worker and its admin credential. Used to CREATE objects only. */
  endpoint(): Promise<{ baseUrl: string; adminSecret: string }>
  vaultRoot(): string | null
  fetch: typeof fetch
  now?(): number
}

/** What a window may see: never the owner token. */
export interface RunPreworkState {
  preworkId: string
  opensAt: number
  closesAt: number
  closedAt?: number
  /** Deleted on the service after 60 days without activity; History says so without asking it. */
  purgedAt?: number
}

export const PREWORK_PURGED_MESSAGE = 'Pre-work was deleted after 60 days without activity; the answers already pulled stay on the Run.'

export type RunPreworkPull =
  | { ok: true; run: RunRecord; added: number; changed: boolean }
  | { ok: false; error: string; run?: RunRecord }

interface RegistryFile { version: 1; preworks: Record<string, RunPreworkRow> }

/** How often the timer pulls while pre-work is open, and how long after closing it still pulls. */
export const PREWORK_PULL_INTERVAL_MS = 5 * 60_000
export const PREWORK_PULL_GRACE_MS = 30 * 60_000
/** Pages a single pull may read (500 entries each). */
const MAX_PAGES = 200

export function runPreworkKey(talkSlug: string, runId: string): string {
  return `${talkSlug}/${runId}`
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch { return false }
}

function validRow(value: unknown): value is RunPreworkRow {
  const row = value as RunPreworkRow
  return Boolean(row) && typeof row.key === 'string' && isShareId(row.preworkId) && typeof row.ownerToken === 'string'
    && row.ownerToken.length >= 16 && row.ownerToken.length <= 4096 && validOrigin(row.workerBaseUrl)
    && Number.isSafeInteger(row.opensAt) && Number.isSafeInteger(row.closesAt) && Number.isSafeInteger(row.cursor) && row.cursor >= 0
    && (row.closedAt === undefined || Number.isSafeInteger(row.closedAt))
    && (row.purgedAt === undefined || Number.isSafeInteger(row.purgedAt))
}

async function errorText(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } }
    return body?.error?.message || fallback
  } catch { return fallback }
}

export function createRunPrework(deps: RunPreworkDeps) {
  const now = deps.now ?? Date.now

  function read(): RegistryFile {
    const registry: RegistryFile = { version: 1, preworks: {} }
    try {
      const parsed = JSON.parse(readFileSync(deps.registryPath, 'utf8')) as { preworks?: Record<string, unknown> }
      for (const [key, row] of Object.entries(parsed?.preworks ?? {})) if (validRow(row) && row.key === key) registry.preworks[key] = row
    } catch { /* no registry yet */ }
    return registry
  }

  function write(registry: RegistryFile): void {
    mkdirSync(dirname(deps.registryPath), { recursive: true })
    const temp = `${deps.registryPath}.${process.pid}.${now().toString(36)}.tmp`
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, deps.registryPath)
    try { chmodSync(deps.registryPath, 0o600) } catch { /* best effort */ }
  }

  function save(row: RunPreworkRow): void {
    const registry = read()
    registry.preworks[row.key] = row
    write(registry)
  }

  function state(row: RunPreworkRow): RunPreworkState {
    return { preworkId: row.preworkId, opensAt: row.opensAt, closesAt: row.closesAt, ...(row.closedAt !== undefined ? { closedAt: row.closedAt } : {}),
      ...(row.purgedAt !== undefined ? { purgedAt: row.purgedAt } : {}) }
  }

  const owner = (row: RunPreworkRow) => ({ authorization: `Bearer ${row.ownerToken}` })

  async function pull(talkSlug: string, runId: string): Promise<RunPreworkPull> {
    const vaultRoot = deps.vaultRoot()
    const before = vaultRoot ? readRunForTalk(vaultRoot, talkSlug, runId) : null
    if (!vaultRoot || !before) return { ok: false, error: 'This Run is no longer in the vault.' }
    const row = read().preworks[runPreworkKey(talkSlug, runId)]
    if (!row) return { ok: false, error: 'This Run has no pre-work on the handout yet.', run: before }
    if (row.purgedAt !== undefined) return { ok: false, error: PREWORK_PURGED_MESSAGE, run: before }
    // A Run that lost its copy (edited by hand) is mirrored again from the start.
    let after = before.prework ? row.cursor : 0
    const entries: unknown[] = []
    let meta: { people?: number; lastActivityAt?: number; seq?: number } = {}
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let response: Response
      try {
        response = await deps.fetch(`${row.workerBaseUrl}/prework/${row.preworkId}/results?after=${after}`, { headers: owner(row), signal: AbortSignal.timeout(15_000) })
      } catch {
        return { ok: false, error: 'The pre-work service could not be reached. Try again.', run: before }
      }
      if (response.status === 410) {
        save({ ...read().preworks[row.key] ?? row, purgedAt: now() })
        return { ok: false, error: PREWORK_PURGED_MESSAGE, run: before }
      }
      if (!response.ok) return { ok: false, error: await errorText(response, `The answers could not be read (HTTP ${response.status}).`), run: before }
      const body = await response.json() as { entries?: unknown; more?: unknown; seq?: unknown; people?: unknown; lastActivityAt?: unknown }
      if (!Array.isArray(body.entries)) return { ok: false, error: 'The pre-work service answered with something unreadable.', run: before }
      let last = after
      for (const entry of body.entries) {
        const seq = (entry as { seq?: unknown } | null)?.seq
        if (Number.isSafeInteger(seq) && Number(seq) > last) last = Number(seq)
        entries.push(entry)
      }
      meta = {
        ...(Number.isSafeInteger(body.people) ? { people: Number(body.people) } : {}),
        ...(Number.isSafeInteger(body.lastActivityAt) ? { lastActivityAt: Number(body.lastActivityAt) } : {}),
        ...(Number.isSafeInteger(body.seq) ? { seq: Number(body.seq) } : {}),
      }
      if (body.more !== true || last === after) { after = last; break }
      after = last
    }
    // Read, merge and write with nothing awaited in between: the atomic Run writer, from a fresh read.
    const current = readRunForTalk(vaultRoot, talkSlug, runId)
    if (!current) return { ok: false, error: 'This Run is no longer in the vault.' }
    const merged = applyRunPrework(current, entries, { people: meta.people, lastActivityAt: meta.lastActivityAt, closedAt: row.closedAt })
    const saved = merged === current ? current : persistRunForTalk(vaultRoot, talkSlug, runId, merged)
    if (after !== row.cursor) save({ ...read().preworks[row.key] ?? row, cursor: after })
    const count = (run: RunRecord) => run.prework?.entries.length ?? 0
    return { ok: true, run: saved, added: Math.max(0, count(saved) - count(before)), changed: merged !== current }
  }

  return {
    /** The Run's pre-work object, or null when it has none. */
    status(talkSlug: string, runId: string): RunPreworkState | null {
      const row = read().preworks[runPreworkKey(talkSlug, runId)]
      return row ? state(row) : null
    },

    /**
     * Push the form and window for a planned Run, creating its object on first use. Returns what the
     * handout needs to ask about it (`open: false` when the object is gone: the handout carries no
     * form) and a warning when it stays closed. The Run's existing object is always reused: a
     * republish never starts a new one. Throws with a readable message on failure (publishing stops).
     */
    async publish(talkSlug: string, runId: string, form: PreworkForm, window: { opensAt: number; closesAt: number }):
      Promise<{ preworkId: string; workerBaseUrl: string; open: boolean; warning?: string }> {
      const key = runPreworkKey(talkSlug, runId)
      const create = async (): Promise<RunPreworkRow> => {
        const endpoint = await deps.endpoint()
        const origin = new URL(endpoint.baseUrl).origin
        const response = await deps.fetch(`${origin}/prework`, {
          method: 'POST', headers: { authorization: `Bearer ${endpoint.adminSecret}`, 'content-type': 'application/json' },
          body: '{}', signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) throw new Error(await errorText(response, `Pre-work could not be set up (HTTP ${response.status}).`))
        const created = await response.json() as { preworkId?: unknown; ownerToken?: unknown }
        const candidate = { key, preworkId: created.preworkId, ownerToken: created.ownerToken, workerBaseUrl: origin,
          opensAt: window.opensAt, closesAt: window.closesAt, cursor: 0, createdAt: now() }
        if (!validRow(candidate)) throw new Error('The pre-work service returned an incomplete answer.')
        save(candidate)
        return candidate
      }
      const push = (row: RunPreworkRow) => deps.fetch(`${row.workerBaseUrl}/prework/${row.preworkId}/form`, {
        method: 'PUT', headers: { ...owner(row), 'content-type': 'application/json' },
        body: JSON.stringify({ opensAt: window.opensAt, closesAt: window.closesAt, form }), signal: AbortSignal.timeout(15_000),
      })
      const existing = read().preworks[key]
      // Known to be purged: say so without asking the Worker again.
      if (existing?.purgedAt !== undefined) return { preworkId: existing.preworkId, workerBaseUrl: existing.workerBaseUrl, open: false, warning: PREWORK_PURGED_MESSAGE }
      const row = existing ?? await create()
      const response = await push(row)
      // Purged on the Worker (60 idle days after it closed) or gone from it: nothing is reopened
      // unasked. The handout goes out without the form; what the Run holds stays on the Run.
      if (existing && (response.status === 404 || response.status === 410)) {
        save({ ...read().preworks[key] ?? row, purgedAt: row.purgedAt ?? now() })
        return { preworkId: row.preworkId, workerBaseUrl: row.workerBaseUrl, open: false, warning: PREWORK_PURGED_MESSAGE }
      }
      if (!response.ok) throw new Error(await errorText(response, `The pre-work form could not be sent (HTTP ${response.status}).`))
      save({ ...read().preworks[key] ?? row, opensAt: window.opensAt, closesAt: window.closesAt })
      // Closed early ("Close pre-work now") is for good: the form is updated, it stays closed.
      if (row.closedAt !== undefined) {
        return { preworkId: row.preworkId, workerBaseUrl: row.workerBaseUrl, open: true, warning: 'Pre-work was closed; it stays closed.' }
      }
      return { preworkId: row.preworkId, workerBaseUrl: row.workerBaseUrl, open: true }
    },

    pull,

    /** "Close pre-work now": the Worker stops taking answers; then the last answers are pulled. */
    async close(talkSlug: string, runId: string): Promise<RunPreworkPull> {
      const key = runPreworkKey(talkSlug, runId)
      const row = read().preworks[key]
      if (!row) return { ok: false, error: 'This Run has no pre-work on the handout.' }
      let response: Response
      try {
        response = await deps.fetch(`${row.workerBaseUrl}/prework/${row.preworkId}/close`, { method: 'POST', headers: owner(row), signal: AbortSignal.timeout(10_000) })
      } catch {
        return { ok: false, error: 'The pre-work service could not be reached, so pre-work is still open. Try again.' }
      }
      if (!response.ok && response.status !== 410) return { ok: false, error: await errorText(response, 'The pre-work service did not close pre-work. Try again.') }
      const body = await response.json().catch(() => ({})) as { closedAt?: unknown }
      const closedAt = Number.isSafeInteger(body.closedAt) ? Number(body.closedAt) : now()
      save({ ...read().preworks[key] ?? row, closedAt })
      return pull(talkSlug, runId)
    },

    /**
     * The Run page's own marks, written through the atomic Run writer from a fresh read (nothing
     * awaited between): which answers a step's board opens with, and History's marks on a question.
     * Returns the Run as written, or an error in words.
     */
    changePick(talkSlug: string, runId: string, stepId: string, change: unknown): { ok: true; run: RunRecord } | { ok: false; error: string } {
      const vaultRoot = deps.vaultRoot()
      const run = vaultRoot ? readRunForTalk(vaultRoot, talkSlug, runId) : null
      if (!vaultRoot || !run) return { ok: false, error: 'This Run is no longer in the vault.' }
      if (!stepId || stepId.length > 200) return { ok: false, error: 'That step is not on this Run.' }
      const value = (change ?? {}) as { type?: unknown; id?: unknown; by?: unknown; mode?: unknown }
      const parsed: PickChange | null = value.type === 'toggle' && typeof value.id === 'string' && value.id ? { type: 'toggle', id: value.id }
        : value.type === 'move' && typeof value.id === 'string' && (value.by === -1 || value.by === 1) ? { type: 'move', id: value.id, by: value.by }
        : value.type === 'mode' && (value.mode === 'picked' || value.mode === 'all') ? { type: 'mode', mode: value.mode }
        : null
      if (!parsed) return { ok: false, error: 'That choice could not be read.' }
      try {
        // One change, applied to the Run as it is now: two quick clicks are two changes and neither is lost.
        const next = setRunPreworkPick(run, stepId, applyPickChange(run.prework, stepId, parsed))
        return { ok: true, run: persistRunForTalk(vaultRoot, talkSlug, runId, next) }
      } catch (error) { return { ok: false, error: error instanceof Error && error.message === 'prework-not-found' ? 'This Run has no pre-work answers yet.' : 'The Run could not be saved.' } }
    },

    markQuestion(talkSlug: string, runId: string, entryId: string, patch: unknown): { ok: true; run: RunRecord } | { ok: false; error: string } {
      const vaultRoot = deps.vaultRoot()
      const run = vaultRoot ? readRunForTalk(vaultRoot, talkSlug, runId) : null
      if (!vaultRoot || !run) return { ok: false, error: 'This Run is no longer in the vault.' }
      const value = (patch ?? {}) as { answered?: unknown; inTalk?: unknown }
      const inTalk = value.inTalk === null ? null
        : value.inTalk && typeof value.inTalk === 'object' && (typeof (value.inTalk as { slideId?: unknown }).slideId === 'string' || (value.inTalk as { slideId?: unknown }).slideId === null)
          ? { slideId: (value.inTalk as { slideId: string | null }).slideId } : undefined
      if ((value.answered !== undefined && typeof value.answered !== 'boolean') || (value.inTalk !== undefined && inTalk === undefined)) return { ok: false, error: 'That mark could not be read.' }
      if (inTalk && inTalk.slideId !== null && (!inTalk.slideId || inTalk.slideId.length > RUN_PREWORK_MAX_SLIDE_ID)) return { ok: false, error: 'That slide id is too long.' }
      try {
        return { ok: true, run: persistRunForTalk(vaultRoot, talkSlug, runId, markRunPreworkQuestion(run, entryId, {
          ...(value.answered !== undefined ? { answered: value.answered as boolean } : {}), ...(inTalk !== undefined ? { inTalk } : {}) })) }
      } catch { return { ok: false, error: 'That question is not on this Run.' } }
    },

    /** Runs whose pre-work is open now (or closed within the grace period): what the timer pulls. */
    due(): Array<{ talkSlug: string; runId: string }> {
      const at = now()
      return Object.values(read().preworks).flatMap((row) => {
        const closes = row.closedAt !== undefined ? Math.min(row.closedAt, row.closesAt) : row.closesAt
        if (row.purgedAt !== undefined || at < row.opensAt || at > closes + PREWORK_PULL_GRACE_MS) return []
        const slash = row.key.indexOf('/')
        return slash > 0 ? [{ talkSlug: row.key.slice(0, slash), runId: row.key.slice(slash + 1) }] : []
      })
    },

    /** Pull every Run whose pre-work is open. Never throws; returns the Runs that changed. */
    async pullDue(): Promise<RunRecord[]> {
      const changed: RunRecord[] = []
      for (const ref of this.due()) {
        try {
          const result = await pull(ref.talkSlug, ref.runId)
          if (result.ok && result.changed) changed.push(result.run)
        } catch (error) { console.warn('[prework] pull failed', error) }
      }
      return changed
    },
  }
}

export type RunPreworkService = ReturnType<typeof createRunPrework>

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void
}

function runRef(payload: unknown): { talkSlug: string; runId: string } {
  const value = (payload ?? {}) as Record<string, unknown>
  return { talkSlug: String(value.talkSlug ?? ''), runId: String(value.runId ?? '') }
}

/**
 * History's pre-work actions: pull now, close now, and whether the Run has pre-work on its handout.
 * Every handler names a Run by talk slug and run id; the service reads and writes it only in that
 * talk's own folder.
 */
export function registerRunPreworkIpc(ipcMain: IpcMainLike, service: RunPreworkService, hooks: { onQuestionMarked?(talkSlug: string, runId: string): void } = {}): void {
  ipcMain.handle('history:prework-status', (_event, payload) => {
    const ref = runRef(payload)
    return service.status(ref.talkSlug, ref.runId)
  })
  ipcMain.handle('history:prework-refresh', (_event, payload) => {
    const ref = runRef(payload)
    return service.pull(ref.talkSlug, ref.runId)
  })
  ipcMain.handle('history:prework-pick', (_event, payload) => {
    const ref = runRef(payload)
    const value = (payload ?? {}) as Record<string, unknown>
    return service.changePick(ref.talkSlug, ref.runId, String(value.stepId ?? ''), value.change)
  })
  ipcMain.handle('history:prework-question', (_event, payload) => {
    const ref = runRef(payload)
    const value = (payload ?? {}) as Record<string, unknown>
    const result = service.markQuestion(ref.talkSlug, ref.runId, String(value.entryId ?? ''), value.patch)
    // A presenter window on this Run is told, so a question just put in the talk's questions is in its tray.
    if (result.ok) { try { hooks.onQuestionMarked?.(ref.talkSlug, ref.runId) } catch { /* best effort */ } }
    return result
  })
  ipcMain.handle('history:prework-close', (_event, payload) => {
    const ref = runRef(payload)
    return service.close(ref.talkSlug, ref.runId)
  })
}

/** Pull open pre-work every few minutes; returns a stop function. `onChanged` hears of Runs that changed. */
export function startRunPreworkTimer(service: RunPreworkService, onChanged: (runs: RunRecord[]) => void, intervalMs = PREWORK_PULL_INTERVAL_MS): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const changed = await service.pullDue()
      if (changed.length) onChanged(changed)
    } finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()
  void tick()
  return () => clearInterval(timer)
}
