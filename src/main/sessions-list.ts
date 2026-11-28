// What the Sessions view reads (work-files-and-sessions ticket 09): every planned and delivered Run
// of every open vault, as plain data for src/shared/sessions-list.ts. Read-only: nothing is written.
// The renderer asks with no argument and gets no path; a Run is named by its talk and Run id. A Run file
// that holds Git conflict markers (0.45) is named by its vault and its path inside the vault, and only
// main turns that back into a file to show in Finder (`sessions:show-conflict`).
import { join, relative, sep } from 'node:path'
import { listRunsWithConflicts, type RunRecord } from './runs.ts'
import { runGitConflict } from '../shared/git-conflict.ts'
import { startedCount } from '../shared/run-prework-results.ts'
import { newResponseCount } from '../shared/run-answers.ts'
import { isSessionRun, sessionLiveKey, type SessionSource } from '../shared/sessions-list.ts'
import { runBoardView } from '../shared/run-board.ts'
import type { Phase } from '../shared/run-work.ts'

/** THE sent set of a Run of the vault at `root` (run-unpublish.ts sentPhases over the work service), handed in by main. */
export type SentPhasesOf = (run: RunRecord, root: string) => Phase[]

/** A Run with a live session running now, and the vault the session recorded (null: none). */
export type LiveRunRef = { talkSlug: string; runId: string; vaultRoot: string | null }

export interface SessionsListIpcDeps {
  ipcMain: { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void }
  /** The open vaults whose folders are there. */
  vaults(): Array<{ id: string; root: string }>
  /** Runs with a live session running now, each with the vault its session recorded. */
  liveRuns(): LiveRunRef[]
  /** Resolve the title for older Runs whose saved title is just the slug. */
  listTalks?(root: string): Promise<Array<{ slug: string; title: string }>>
  /** The phases Unpublish would withdraw for a Run (the confirmation names their pages). */
  sentPhases?: SentPhasesOf
  /** Responses waiting on the live service for a Run of the vault at `root` (the timer's count; nothing is pulled). */
  waitingOf?: WaitingOf
  /** Select a file in Finder (shell.showItemInFolder). */
  reveal?: (path: string) => void
}

/** Responses waiting on the live service for a Run (both phases), as the work service last counted them. */
export type WaitingOf = (run: RunRecord, root: string) => number

/** How long a Run was delivered: its audio less the skipped spans, else the wall clock. */
function deliveredMs(run: RunRecord): number {
  if (!run.audio) return Math.max(0, run.wallClockMs || 0)
  const trimmed = (run.trims ?? []).reduce((sum, trim) => {
    const start = Math.max(0, Math.min(run.recordingMs, trim.start)); const end = Math.max(0, Math.min(run.recordingMs, trim.end))
    return end > start ? sum + end - start : sum
  }, 0)
  return Math.max(0, run.recordingMs - trimmed)
}

export function sessionSource(vaultId: string, run: RunRecord, sent: readonly Phase[] = [], waiting = 0): SessionSource {
  const pre = run.prework ? startedCount(run.prework) : undefined
  const post = run.postwork ? startedCount(run.postwork) : undefined
  // New to the presenter: waiting on the service, plus pulled onto the Run and not seen yet.
  const responses = Math.max(0, waiting) + newResponseCount(run.prework) + newResponseCount(run.postwork)
  return {
    ...(run.sourceOutline ? {sourceOutline:run.sourceOutline} : {}),
    vaultId, talkSlug: run.talkSlug, runId: run.id, talkTitle: run.talkTitle, kind: run.kind,
    status: run.status, startedAt: run.startedAt || undefined,
    ...(run.eventTitle ? { eventTitle: run.eventTitle } : {}),
    ...(run.audience ? { audience: run.audience } : {}),
    ...(run.context ? { context: run.context } : {}),
    ...(run.audio ? { recorded: true } : {}),
    ...(run.boards?.length ? { boards: run.boards.map((board) => ({ ...(board.openUntil !== undefined ? { openUntil: board.openUntil } : {}), ...(board.closedAt !== undefined ? { closedAt: board.closedAt } : {}), ...(board.liveEndedAt !== undefined ? { liveEndedAt: board.liveEndedAt } : {}), late: runBoardView(board).lateCount })) } : {}),
    ...(run.status !== 'planned' && deliveredMs(run) > 0 ? { lengthMs: deliveredMs(run) } : {}),
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
/** A Run file the list cannot show because it holds Git conflict markers (0.45): its vault, its path inside the vault, the words. */
export type RunFileConflict = { vaultId: string; name: string; message: string }

export function collectSessions(vaults: Array<{ id: string; root: string }>, liveRuns: LiveRunRef[] = [], sentPhases?: SentPhasesOf, waitingOf?: WaitingOf, includeAllKinds = false): { runs: SessionSource[]; live: string[]; conflicts: RunFileConflict[] } {
  const runs: SessionSource[] = []
  const conflicts: RunFileConflict[] = []
  for (const vault of vaults) {
    let found: RunRecord[] = []
    try {
      const read = listRunsWithConflicts(vault.root)
      found = read.runs
      for (const file of read.conflicts) {
        const name = relative(vault.root, file).split(sep).join('/')
        conflicts.push({ vaultId: vault.id, name, message: runGitConflict(name) })
      }
    } catch { /* one unreadable vault must not blank the list */ }
    for (const run of found) {
      if (!includeAllKinds && !isSessionRun(run)) continue
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
  return { runs, live, conflicts }
}

export function registerSessionsListIpc(deps: SessionsListIpcDeps): void {
  // `{ allKinds: true }`: the Runs view also lists rehearsals and recordings (its Kind filter); the status bar chip and the
  // rail badge ask with no argument and still see planned and delivered Runs only.
  deps.ipcMain.handle('sessions:list', async (_event, options?: unknown) => {
    const vaults = deps.vaults()
    const result = collectSessions(vaults, deps.liveRuns(), deps.sentPhases, deps.waitingOf, (options as { allKinds?: unknown } | undefined)?.allKinds === true)
    const listTalks = deps.listTalks
    if (!listTalks) return result
    await Promise.all(vaults.map(async ({ id, root }) => {
      const unnamed = result.runs.filter(run => run.vaultId === id && (!run.talkTitle.trim() || run.talkTitle === run.talkSlug))
      if (!unnamed.length) return
      const talks = await listTalks(root).catch(() => [])
      const titles = new Map(talks.map(talk => [talk.slug, talk.title]))
      for (const run of unnamed) run.talkTitle = titles.get(run.talkSlug)?.trim() || run.talkTitle
    }))
    return result
  })
  // Show a conflicted Run file in Finder: only one this vault's list names as conflicted now, never a path from the renderer.
  deps.ipcMain.handle('sessions:show-conflict', (_event, payload?: unknown) => showRunConflict(deps, payload))
}

/** Reveal the Run file `payload` names ({ vaultId, name }) when it is one of that vault's conflicted Run files now. */
export function showRunConflict(deps: Pick<SessionsListIpcDeps, 'vaults' | 'reveal'>, payload: unknown): boolean {
  const { vaultId, name } = (payload ?? {}) as { vaultId?: unknown; name?: unknown }
  const vault = deps.vaults().find((v) => v.id === vaultId)
  if (!vault || typeof name !== 'string' || !deps.reveal) return false
  let conflicts: string[] = []
  try { conflicts = listRunsWithConflicts(vault.root).conflicts } catch { return false }
  const file = conflicts.find((path) => path === join(vault.root, ...name.split('/')))
  if (!file) return false
  deps.reveal(file)
  return true
}
