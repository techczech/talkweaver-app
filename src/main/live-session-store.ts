import type { InstantSlide, PollStateMessage, SlideState } from '../../worker/protocol'
import type { RecoveredVoteRecord } from '../../worker/recovery-protocol'
import type { LiveStatus, PendingPollOperation } from './live-presenter-client'
import type { RunInstantSlide } from './runs'

export interface SessionRecoveryRecord {
  sessionId: string
  baseUrl: string
  presenterToken: string
  shortId: string
  shortUrl: string
  qrSvg: string
  talkSlug: string
  vaultRoot: string | null
  expiresAt: number
  startedAtMs: number
  status: LiveStatus
  endRequested: boolean
  pending: PendingPollOperation[]
  polls: PollStateMessage[]
  voteRecords: RecoveredVoteRecord[]
  cursor: number
  latest: SlideState | null
  instantSlide?: InstantSlide | null
  /** Every instant slide shown in this session, in the Run's form, until it is flushed onto the Run. */
  instantHistory?: RunInstantSlide[]
  /** The presenter's slide id at the moment each instant slide was shown, keyed `<kind>-<shownAt>`. */
  instantAnchors?: Record<string, string | null>
  runId?: string
  /**
   * Set when the session ends: its reactions and questions (kept in memory only, never here) may not
   * be on the Run yet. Cleared after a successful write that follows the final recovery; on restart
   * a session still pending fetches its final history from the worker again. Holds no content.
   */
  historyPending?: boolean
  /** End live's answer when a board was open: keep it open for late cards (sent on every retry). */
  keepBoardsOpen?: boolean
  /** Boards the worker kept open at End live, with when each closes by itself (ms). Never shrinks. */
  boardsLeftOpen?: Record<string, number>
  /** When the app learned that a board left open had closed (Close it now, or by itself), by pollId. */
  boardsClosedAt?: Record<string, number>
  /** Why each board left open closed, when the worker said: its time came, Close it now, or a new live session took the join link. */
  boardsClosedReason?: Record<string, 'expired' | 'closed' | 'superseded'>
  /** When End live happened (ms): the Run marks cards after it as late. */
  endedAtMs?: number
  /** The last pull from boards left open (ms). */
  boardsRefreshedAt?: number
}
/** The `live-sessions` slot of the secrets store (secrets-store.ts `secretsSlot`). */
interface RecoverySlot {
  read(): string | null
  write(text: string): void
  check(): void
}
/**
 * Live session recovery, kept in the secrets store: presenter tokens are in it. The slot's file
 * ({userData}/live-sessions.enc) and its contents are what earlier versions wrote.
 */
export function createLiveSessionStore(slot: RecoverySlot) {
  return {
    load(): SessionRecoveryRecord[] {
      const text = slot.read()
      if (text === null) return []
      let parsed: { version?: unknown; sessions?: unknown }
      // Never the parser's own message: it can quote the text it failed on.
      try { parsed = JSON.parse(text) } catch { throw new Error('Live session recovery data could not be read.') }
      if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error('Live session recovery data could not be read.')
      for (const record of parsed.sessions) {
        let protocol = ''
        try { protocol = new URL(record?.baseUrl).protocol } catch { /* invalid below */ }
        if (!record || typeof record.sessionId !== 'string' || typeof record.presenterToken !== 'string'
          || typeof record.talkSlug !== 'string' || !Number.isFinite(record.expiresAt)
          || !Array.isArray(record.pending) || !Array.isArray(record.polls) || !Array.isArray(record.voteRecords)
          || !/^https?:$/.test(protocol)) throw new Error('Live session recovery data is invalid.')
      }
      return parsed.sessions as SessionRecoveryRecord[]
    },
    save(sessions: SessionRecoveryRecord[]) {
      slot.write(JSON.stringify({ version: 1, sessions }))
    },
    check() { slot.check() },
  }
}
