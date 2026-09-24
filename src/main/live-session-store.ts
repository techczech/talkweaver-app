import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { PollStateMessage, SlideState } from '../../worker/protocol'
import type { RecoveredVoteRecord } from '../../worker/recovery-protocol'
import type { LiveStatus, PendingPollOperation } from './live-presenter-client'

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
  runId?: string
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
