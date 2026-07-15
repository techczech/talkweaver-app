// TalkWeaver History — main-process services for the delivered-talks ledger (ADR-0035).
// This module only exposes the data C2 will join in the renderer: published handout URLs per
// Talk, plus a cached "is this handout still live?" check. It never throws into the renderer.

import { ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { readHandoutUrl } from './publishing-logic'
import {
  createPlannedRun,
  deletePlannedRun,
  listRuns,
  updatePlannedRun,
  type PlannedRunInput,
  type PlannedRunPatch
} from './runs'

type TalkInfo = { slug: string; title: string; outlinePath: string }
type HistoryStatus = 'live' | 'offline'
type LiveCheckResult = { status: HistoryStatus; checkedAt: string }
type LiveCache = Record<string, LiveCheckResult>

export interface HistoryDeps {
  userDataDir: () => string // app.getPath('userData')
  vaultRoot: () => string | null // getConfig('vaultRoot')
  listTalks: (vaultRoot: string) => Promise<TalkInfo[]> // persisted vault index; never a sync walk
  testMode?: () => boolean // TW_REC_TEST=1: deterministic live/offline checks, no network
}

const LIVE_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000
const LIVE_CHECK_TIMEOUT_MS = 5000

function liveCachePath(deps: HistoryDeps): string {
  return join(deps.userDataDir(), 'history-live-cache.json')
}

function readLiveCache(deps: HistoryDeps): LiveCache {
  try {
    return JSON.parse(readFileSync(liveCachePath(deps), 'utf8')) as LiveCache
  } catch {
    return {}
  }
}

function writeLiveCache(deps: HistoryDeps, cache: LiveCache): void {
  try {
    const p = liveCachePath(deps)
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    /* cache is an optimisation; failing to write it must not break History */
  }
}

function freshEnough(row: LiveCheckResult | undefined, now: number): row is LiveCheckResult {
  if (!row) return false
  const checked = Date.parse(row.checkedAt)
  return Number.isFinite(checked) && now - checked < LIVE_CACHE_MAX_AGE_MS
}

async function checkUrlLive(url: string, testMode: boolean): Promise<LiveCheckResult> {
  const checkedAt = new Date().toISOString()
  if (testMode) {
    return { status: url.includes('mock-live') ? 'live' : 'offline', checkedAt }
  }

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return { status: 'offline', checkedAt }

    const probe = async (method: 'HEAD' | 'GET'): Promise<Response> => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), LIVE_CHECK_TIMEOUT_MS)
      try {
        return await fetch(parsed.href, { method, signal: controller.signal, redirect: 'follow' })
      } finally {
        clearTimeout(timeout)
      }
    }

    let res = await probe('HEAD')
    if (res.status === 405) res = await probe('GET')
    return { status: res.status >= 200 && res.status < 400 ? 'live' : 'offline', checkedAt }
  } catch {
    return { status: 'offline', checkedAt }
  }
}

export function registerHistoryIpc(deps: HistoryDeps): void {
  // Published handout URL per Talk, read from each outline's frontmatter. {} when no vault.
  ipcMain.handle('history:talk-handouts', async () => {
    try {
      const vault = deps.vaultRoot()
      if (!vault) return {}
      const out: Record<string, { title: string; outlinePath: string; handoutUrl: string | null }> = {}
      for (const talk of await deps.listTalks(vault)) {
        let handoutUrl: string | null = null
        try {
          handoutUrl = readHandoutUrl(await readFile(talk.outlinePath, 'utf8'))
        } catch {
          handoutUrl = null
        }
        out[talk.slug] = { title: talk.title, outlinePath: talk.outlinePath, handoutUrl }
      }
      return out
    } catch {
      return {}
    }
  })

  // Cached handout liveness probe. Non-forced calls reuse a result younger than six hours;
  // TW_REC_TEST short-circuits the network so e2e can pin live/offline deterministically.
  ipcMain.handle('history:check-live', async (_event, url: string, force = false) => {
    try {
      const key = String(url || '')
      const cache = readLiveCache(deps)
      if (!force && freshEnough(cache[key], Date.now())) return cache[key]
      const result = await checkUrlLive(key, deps.testMode ? deps.testMode() : process.env.TW_REC_TEST === '1')
      cache[key] = result
      writeLiveCache(deps, cache)
      return result
    } catch {
      return { status: 'offline', checkedAt: new Date().toISOString() }
    }
  })

  ipcMain.handle('history:list-runs', (_event, talkSlug?: string) => {
    const vault = deps.vaultRoot()
    return vault ? listRuns(vault, talkSlug ? String(talkSlug) : undefined) : []
  })

  ipcMain.handle('history:create-planned-run', (_event, input: PlannedRunInput) => {
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false, error: 'no-vault' }
      return { ok: true, run: createPlannedRun(vault, input, () => `run-${randomUUID()}`) }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  })

  ipcMain.handle('history:update-planned-run', (_event, payload: { talkSlug: string; runId: string; patch: PlannedRunPatch }) => {
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false, error: 'no-vault' }
      const run = updatePlannedRun(vault, String(payload.talkSlug), String(payload.runId), payload.patch)
      return run ? { ok: true, run } : { ok: false, error: 'planned-run-not-found' }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  })

  ipcMain.handle('history:delete-planned-run', (_event, payload: { talkSlug: string; runId: string }) => {
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false, error: 'no-vault' }
      return deletePlannedRun(vault, String(payload.talkSlug), String(payload.runId))
        ? { ok: true }
        : { ok: false, error: 'planned-run-not-found' }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  })
}
