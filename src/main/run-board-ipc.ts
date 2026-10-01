// History's board and share-link actions (feedback-boards ticket 06): Refresh from the board, Close
// it now, Put back, Re-check live for boards left open, and the Run's read-only share link.
//
// Every handler names a Run by talk slug and run id from the renderer: the Run is read only from
// that talk's own folder (readRunForTalk) and written back only there (persistRunForTalk). Board
// changes from the worker reach the Run through the live-session manager's flush (the atomic Run
// writer); "Put back" is History's own change and goes through the same writer.
import { listRuns, persistRunForTalk, readRunForTalk, type RunRecord } from './runs.ts'
import { runBoardAwaitsRefresh, runBoardKey, runBoardView, setRunBoardCardPutBack } from '../shared/run-board.ts'
import { RUN_SHARE_LIFETIMES, type RunShareLifetime } from '../shared/run-results-share.ts'
import type { RunResultsShares } from './run-results-share.ts'

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void
}

interface BoardSessions {
  refreshBoards(talkSlug: string, runId: string): Promise<{ refreshed: number; error?: string }>
  closeBoards(talkSlug: string, runId: string): Promise<{ refreshed: number; error?: string }>
}

export interface RunBoardIpcDeps {
  ipcMain: IpcMainLike
  vaultRoot(): string | null
  sessions(): BoardSessions | null
  shares: RunResultsShares
}

type RunRef = { talkSlug: string; runId: string }

function runRef(payload: unknown): RunRef {
  const value = (payload ?? {}) as Record<string, unknown>
  return { talkSlug: String(value.talkSlug ?? ''), runId: String(value.runId ?? '') }
}

function lateCards(run: RunRecord | null): number {
  return (run?.boards ?? []).reduce((sum, board) => sum + runBoardView(board).lateCount, 0)
}

function visibleCards(run: RunRecord | null): number {
  return (run?.boards ?? []).reduce((sum, board) => sum + runBoardView(board).cardCount, 0)
}

export const LINK_NOT_UPDATED = 'The share link could not be updated; it may still show this card. Try again.'

export function registerRunBoardIpc(deps: RunBoardIpcDeps): void {
  const read = ({ talkSlug, runId }: RunRef): RunRecord | null => {
    const vaultRoot = deps.vaultRoot()
    return vaultRoot ? readRunForTalk(vaultRoot, talkSlug, runId) : null
  }

  // After the Run changed, the link (when there is one) is pushed again so it shows the same board.
  // A failed push is returned as a warning: the link may still show the old board.
  const keepLinkInStep = async (ref: RunRef, run: RunRecord | null): Promise<string | undefined> => {
    if (!run) return undefined
    const pushed = await deps.shares.refresh(ref.talkSlug, ref.runId, run)
    return pushed.ok ? undefined : LINK_NOT_UPDATED
  }

  const pull = async (ref: RunRef, action: 'refresh' | 'close') => {
    const before = read(ref)
    if (!before) return { ok: false as const, error: 'This Run is no longer in the vault.' }
    const sessions = deps.sessions()
    if (!sessions) return { ok: false as const, error: 'Live sessions are unavailable. Restart TalkWeaver to retry.' }
    const result = action === 'close' ? await sessions.closeBoards(ref.talkSlug, ref.runId) : await sessions.refreshBoards(ref.talkSlug, ref.runId)
    const after = read(ref)
    if (result.error && !result.refreshed) return { ok: false as const, error: result.error, ...(after ? { run: after } : {}) }
    const linkWarning = await keepLinkInStep(ref, after)
    const warning = [result.error, linkWarning].filter(Boolean).join(' ')
    return { ok: true as const, run: after ?? before, added: Math.max(0, visibleCards(after) - visibleCards(before)),
      late: lateCards(after), ...(warning ? { warning } : {}) }
  }

  deps.ipcMain.handle('history:board-refresh', (_event, payload) => pull(runRef(payload), 'refresh'))
  deps.ipcMain.handle('history:board-close', (_event, payload) => pull(runRef(payload), 'close'))

  // Re-check live: every Run with a board left open (or one that may have closed by itself since)
  // pulls its boards. Returns the Runs that changed.
  deps.ipcMain.handle('history:recheck-boards', async () => {
    const vaultRoot = deps.vaultRoot()
    const sessions = deps.sessions()
    if (!vaultRoot || !sessions) return { runs: [], late: 0 }
    let warning: string | undefined
    const waiting = listRuns(vaultRoot).filter((run) => (run.boards ?? []).some(runBoardAwaitsRefresh))
    const runs: RunRecord[] = []
    let late = 0
    for (const run of waiting) {
      const ref = { talkSlug: run.talkSlug, runId: run.id }
      const result = await sessions.refreshBoards(ref.talkSlug, ref.runId)
      const after = read(ref)
      if (!result.refreshed || !after) continue
      if (JSON.stringify(after) !== JSON.stringify(run)) {
        runs.push(after)
        warning = await keepLinkInStep(ref, after) ?? warning
      }
      late += lateCards(after)
    }
    return { runs, late, ...(warning ? { warning } : {}) }
  })

  // R8: Put back a hidden card (or hide it again) — in the Run and on its share link; the live board is not changed.
  deps.ipcMain.handle('history:board-put-back', async (_event, payload) => {
    const ref = runRef(payload)
    const value = (payload ?? {}) as Record<string, unknown>
    const vaultRoot = deps.vaultRoot()
    const run = read(ref)
    if (!vaultRoot || !run) return { ok: false, error: 'This Run is no longer in the vault.' }
    // A board is named by its poll AND its live session: the same board shown in two sessions of one
    // Run is two boards, and Put back changes only the one named.
    const boardId = String(value.boardId ?? ''), cardId = String(value.cardId ?? '')
    const sessionId = typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : undefined
    const key = runBoardKey({ id: boardId, sessionId })
    const board = run.boards?.find((candidate) => runBoardKey(candidate) === key)
    if (!board) return { ok: false, error: 'This board is no longer on the Run.' }
    let next: RunRecord
    try {
      next = { ...run, boards: run.boards!.map((candidate) => runBoardKey(candidate) === key ? setRunBoardCardPutBack(candidate, cardId, value.putBack !== false) : candidate) }
    } catch {
      return { ok: false, error: 'That card is not a hidden card on this board.' }
    }
    const saved = persistRunForTalk(vaultRoot, ref.talkSlug, ref.runId, next)
    const warning = await keepLinkInStep(ref, saved)
    return { ok: true, run: saved, ...(warning ? { warning } : {}) }
  })

  deps.ipcMain.handle('history:results-share-status', (_event, payload) => {
    const ref = runRef(payload)
    return read(ref) ? deps.shares.status(ref.talkSlug, ref.runId) : null
  })

  deps.ipcMain.handle('history:results-share', async (_event, payload) => {
    const ref = runRef(payload)
    const value = (payload ?? {}) as Record<string, unknown>
    const run = read(ref)
    if (!run) return { ok: false, error: 'This Run is no longer in the vault.' }
    const lifetime = RUN_SHARE_LIFETIMES.includes(value.lifetime as RunShareLifetime) ? value.lifetime as RunShareLifetime : null
    if (!lifetime) return { ok: false, error: 'Choose how long the link stays open.' }
    const include = (value.include ?? {}) as Record<string, unknown>
    try {
      const title = typeof value.title === 'string' ? value.title : undefined
      const state = await deps.shares.share(ref.talkSlug, ref.runId, run, { lifetime, title, include: { board: include.board === true, polls: include.polls === true } })
      return { ok: true, share: state }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : 'The link could not be shared.' }
    }
  })

  deps.ipcMain.handle('history:results-share-stop', async (_event, payload) => {
    const ref = runRef(payload)
    return deps.shares.stop(ref.talkSlug, ref.runId)
  })
}
