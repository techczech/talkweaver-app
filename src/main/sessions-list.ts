// What the Sessions view reads (work-files-and-sessions ticket 09): every planned and delivered Run
// of every open vault, as plain data for src/shared/sessions-list.ts. Read-only: nothing is written.
// The renderer asks with no argument and gets no path; a Run is named by its talk and Run id.
import { listRuns, type RunRecord } from './runs.ts'
import { startedCount } from '../shared/run-prework-results.ts'
import { newResponseCount } from '../shared/run-answers.ts'
import { isSessionRun, sessionLiveKey, type SessionSource } from '../shared/sessions-list.ts'
import type { Phase } from '../shared/run-work.ts'

/** THE sent set of a Run of the vault at `root` (run-unpublish.ts sentPhases over the work service), handed in by main. */
export type SentPhasesOf = (run: RunRecord, root: string) => Phase[]

/** A Run with a live session running now, and the vault the session recorded (null: none). */
export type LiveRunRef = { talkSlug: string; runId: string; vaultRoot: string | null }

export interface SessionsListIpcDeps {
  ipcMain: { handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void }
  /** The open vaults whose folders are there. */
  vaults(): Array<{ id: string; root: string }>
  /** Runs with a live session running now, each with the vault its session recorded. */
  liveRuns(): LiveRunRef[]
  /** The phases Unpublish would withdraw for a Run (the confirmation names their pages). */
  sentPhases?: SentPhasesOf
  /** Responses waiting on the live service for a Run of the vault at `root` (the timer's count; nothing is pulled). */
  waitingOf?: WaitingOf
}

/** Responses waiting on the live service for a Run (both phases), as the work service last counted them. */
export type WaitingOf = (run: RunRecord, root: string) => number

export function sessionSource(vaultId: string, run: RunRecord, sent: readonly Phase[] = [], waiting = 0): SessionSource {
  const pre = run.prework ? startedCount(run.prework) : undefined
  const post = run.postwork ? startedCount(run.postwork) : undefined
  // New to the presenter: waiting on the service, plus pulled onto the Run and not seen yet.
  const responses = Math.max(0, waiting) + newResponseCount(run.prework) + newResponseCount(run.postwork)
  return {
    vaultId, talkSlug: run.talkSlug, runId: run.id, talkTitle: run.talkTitle, kind: run.kind,
    status: run.status, startedAt: run.startedAt || undefined,
    ...(run.eventTitle ? { eventTitle: run.eventTitle } : {}),
    ...(run.plannedDate ? { plannedDate: run.plannedDate } : {}),
    ...(run.startTime ? { startTime: run.startTime } : {}),
    ...(run.expectedPeople ? { expectedPeople: run.expectedPeople } : {}),
    ...(run.timeZone ? { timeZone: run.timeZone } : {}),
    ...(run.handoutUrl ? { handoutUrl: run.handoutUrl } : {}),
    ...(run.handoutUrl && run.unpublishedAt ? { unpublishedAt: run.unpublishedAt } : {}),
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    ...(run.work ? { work: run.work } : {}),
    ...(run.extras ? { extras: run.extras } : {}),
    ...(sent.length ? { sent: [...sent] } : {}),
    ...(responses > 0 ? { responses } : {}),
    ...(pre !== undefined || post !== undefined ? { answers: { ...(pre !== undefined ? { pre } : {}), ...(post !== undefined ? { post } : {}) } } : {})
  }
}

/**
 * Every Run of every open vault, and the Runs live now as `sessionLiveKey` (vault id, talk and Run id): a live session
 * marks only the Run of the vault it recorded (issue 256), never the same talk and Run id in another vault. A session
 * whose vault is not open, or that recorded none, marks nothing.
 */
export function collectSessions(vaults: Array<{ id: string; root: string }>, liveRuns: LiveRunRef[] = [], sentPhases?: SentPhasesOf, waitingOf?: WaitingOf): { runs: SessionSource[]; live: string[] } {
  const runs: SessionSource[] = []
  for (const vault of vaults) {
    let found: RunRecord[] = []
    try { found = listRuns(vault.root) } catch { /* one unreadable vault must not blank the list */ }
    for (const run of found) {
      if (!isSessionRun(run)) continue
      let sent: Phase[] = []
      try { sent = sentPhases?.(run, vault.root) ?? [] } catch { /* the list still shows the Run */ }
      let waiting = 0
      try { waiting = waitingOf?.(run, vault.root) ?? 0 } catch { /* the list still shows the Run */ }
      runs.push(sessionSource(vault.id, run, sent, waiting))
    }
  }
  const live = liveRuns.flatMap((ref) => {
    const vault = ref.vaultRoot ? vaults.find((candidate) => candidate.root === ref.vaultRoot) : undefined
    return vault ? [sessionLiveKey(vault.id, ref)] : []
  })
  return { runs, live }
}

export function registerSessionsListIpc(deps: SessionsListIpcDeps): void {
  deps.ipcMain.handle('sessions:list', () => collectSessions(deps.vaults(), deps.liveRuns(), deps.sentPhases, deps.waitingOf))
}
