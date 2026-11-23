import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { writeTextAtomic } from './atomic-file.ts'

export interface PrerenderLedgerEntry {
  contentHash: string
  documentId: string
}

export type PrerenderLedger = Record<string, PrerenderLedgerEntry>

export function contentHashForPrerender(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function loadPrerenderLedger(filePath: string): PrerenderLedger {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    const ledger: PrerenderLedger = {}
    for (const [outlinePath, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as PrerenderLedgerEntry).contentHash === 'string' &&
        typeof (value as PrerenderLedgerEntry).documentId === 'string'
      ) {
        ledger[outlinePath] = value as PrerenderLedgerEntry
      }
    }
    return ledger
  } catch {
    return {}
  }
}

export function savePrerenderLedger(filePath: string, ledger: PrerenderLedger): void {
  writeTextAtomic(filePath, JSON.stringify(ledger, null, 2), { createParent: true })
}

export function shouldPrerenderTalk(
  ledger: PrerenderLedger,
  outlinePath: string,
  contentHash: string,
  cacheDir: string
): boolean {
  return ledger[outlinePath]?.contentHash !== contentHash || !existsSync(cacheDir)
}

export function recordSuccessfulPrerender(
  ledger: PrerenderLedger,
  outlinePath: string,
  contentHash: string,
  documentId: string
): void {
  ledger[outlinePath] = { contentHash, documentId }
}
