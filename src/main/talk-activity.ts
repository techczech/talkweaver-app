// Per-talk Activity list (several-vaults ticket 09; architecture.md, "Decisions after the locked
// mockups": conflict and merge lines go to a per-talk Activity list in the Inspector, stored locally
// in `userData/talk-activity/<vaultId>/<slug>.jsonl`; nothing is written into the vault).
//
// Contract:
//   - `append(vaultId, slug, entry)` adds one JSON line to that talk's file (the folder is made on
//     first use). Only the app-data folder given as `dir` is ever written.
//   - `list(vaultId, slug)` answers the talk's lines newest first (at most `limit`); a missing or
//     partly unreadable file gives what can be read, never throws.
//   - A vault id or slug that is not a plain file name is hashed, so no id or slug can name a file
//     outside `dir/<vault>/`.
//   - `onAppend(cb)` is told (vaultId, slug) after each append (the Inspector refreshes).

import { createHash } from 'crypto'
import { appendFile, mkdir, readFile } from 'fs/promises'
import { join } from 'path'

export type ActivityEntry = {
  /** ISO time. */
  at: string
  kind: string
  title: string
  detail?: string
  [key: string]: unknown
}

export interface TalkActivity {
  append(vaultId: string, slug: string, entry: ActivityEntry): Promise<void>
  list(vaultId: string, slug: string, limit?: number): Promise<ActivityEntry[]>
  fileFor(vaultId: string, slug: string): string
  onAppend(cb: (vaultId: string, slug: string) => void): () => void
}

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9 _.,()'’-]{0,120}$/
export function activityFileName(part: string): string {
  const s = String(part)
  return PLAIN.test(s) && !s.includes('..') ? s : 'x-' + createHash('sha256').update(s).digest('hex').slice(0, 32)
}

function isEntry(v: unknown): v is ActivityEntry {
  const e = v as ActivityEntry
  return !!e && typeof e === 'object' && typeof e.at === 'string' && typeof e.kind === 'string' && typeof e.title === 'string'
}

export function createTalkActivity({ dir }: { dir: string }): TalkActivity {
  const listeners = new Set<(vaultId: string, slug: string) => void>()
  const fileFor = (vaultId: string, slug: string): string =>
    join(dir, activityFileName(vaultId), `${activityFileName(slug)}.jsonl`)

  async function append(vaultId: string, slug: string, entry: ActivityEntry): Promise<void> {
    if (!vaultId || !slug || !isEntry(entry)) throw new Error('activity: vault id, slug and entry are required')
    const file = fileFor(vaultId, slug)
    await mkdir(join(dir, activityFileName(vaultId)), { recursive: true })
    await appendFile(file, JSON.stringify(entry) + '\n', 'utf8')
    for (const cb of listeners) { try { cb(vaultId, slug) } catch { /* a listener never stops an append */ } }
  }

  async function list(vaultId: string, slug: string, limit = 50): Promise<ActivityEntry[]> {
    if (!vaultId || !slug) return []
    let text: string
    try { text = await readFile(fileFor(vaultId, slug), 'utf8') } catch { return [] }
    const out: ActivityEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { const v = JSON.parse(line); if (isEntry(v)) out.push(v) } catch { /* a torn line is skipped */ }
    }
    return out.reverse().slice(0, Math.max(0, limit))
  }

  function onAppend(cb: (vaultId: string, slug: string) => void): () => void {
    listeners.add(cb)
    return () => { listeners.delete(cb) }
  }

  return { append, list, fileFor, onAppend }
}
