import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
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
interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(bytes: Buffer): string
}
export function createLiveSessionStore(path: string, cipher: Cipher) {
  function requireCipher() {
    if (!cipher.isEncryptionAvailable()) throw new Error('Secure storage is unavailable; live session recovery cannot be saved.')
  }
  return {
    load(): SessionRecoveryRecord[] {
      if (!existsSync(path)) return []
      requireCipher()
      const parsed = JSON.parse(cipher.decryptString(readFileSync(path)))
      if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error('Live session recovery data could not be read.')
      for (const record of parsed.sessions) {
        if (!record || typeof record.sessionId !== 'string' || typeof record.presenterToken !== 'string'
          || typeof record.talkSlug !== 'string' || !Number.isFinite(record.expiresAt)
          || !Array.isArray(record.pending) || !Array.isArray(record.polls) || !Array.isArray(record.voteRecords)
          || !/^https?:$/.test(new URL(record.baseUrl).protocol)) throw new Error('Live session recovery data is invalid.')
      }
      return parsed.sessions
    },
    save(sessions: SessionRecoveryRecord[]) {
      requireCipher()
      const bytes = cipher.encryptString(JSON.stringify({ version: 1, sessions }))
      mkdirSync(dirname(path), { recursive: true })
      const temporary = path + '.tmp'
      writeFileSync(temporary, bytes, { mode: 0o600 })
      renameSync(temporary, path)
    },
    check() { requireCipher() },
  }
}
