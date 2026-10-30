// TalkWeaver History — main-process services for the delivered-talks ledger (ADR-0035).
// This module only exposes the data C2 will join in the renderer: published handout URLs per
// Talk, plus a cached "is this handout still live?" check. It never throws into the renderer.

import { ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { readHandoutUrl } from './publishing-logic'
import { listRuns } from './runs'
import { listKeptRuns } from './recording-paths'
import { createPlannedRunIn, deletePlannedRunIn, readRoot, updatePlannedRunIn, type PlannedRunsDeps } from './planned-runs-ipc'

type TalkInfo = { slug: string; title: string; outlinePath: string }
type HistoryStatus = 'live' | 'offline'
type LiveCheckResult = { status: HistoryStatus; checkedAt: string }
type LiveCache = Record<string, LiveCheckResult>

export interface HistoryDeps {
  userDataDir: () => string // app.getPath('userData')
  vaultRoot: () => string | null // the current vault's root (vault registry)
  listTalks: (vaultRoot: string) => Promise<TalkInfo[]> // persisted vault index; never a sync walk
  testMode?: () => boolean // TW_REC_TEST=1: deterministic live/offline checks, no network
  /**
   * A planned Run was saved with a changed plan, or a delivered Run's work times changed, in this vault: work
   * already sent is given its new times (work-files ticket 13), and post-work owed now is opened (ticket 19).
   */
  onPlannedRunUpdated?: (talkSlug: string, runId: string, vaultRoot: string) => void
  /** The vault a planned-Run request names by vaultId: that open, writable vault, or the refusal (planned-runs-ipc.ts). */
  runVault?: PlannedRunsDeps['runVault']
  /** Whether a talk is in a vault: a new plan is written only into the vault that holds its talk. */
  hasTalk?: PlannedRunsDeps['hasTalk']
  openVaults?: PlannedRunsDeps['openVaults']
  /** Root of the open vault of this id whose folder is there (reads only), or undefined. */
  readVault?: (vaultId: string) => string | undefined
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
  // With a vault id (the Sessions view, for the selected Run's own talk): that open vault's talks; none: the current vault's.
  ipcMain.handle('history:talk-handouts', async (_event, vaultId?: unknown) => {
    try {
      const vault = readRoot(deps, vaultId)
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

  // With a vault id (the Sessions view's Edit plan and Plan like this): that open vault's Runs; none: the current vault's, as History lists them.
  ipcMain.handle('history:list-runs', (_event, talkSlug?: string, vaultId?: unknown) => {
    const vault = readRoot(deps, vaultId)
    const slug = talkSlug === undefined ? undefined : String(talkSlug)
    // An explicitly named unavailable vault is still refused; no fallback to another vault.
    if (vaultId !== undefined && !vault) return []
    return [...(vault ? listRuns(vault, slug).map((run) => ({ ...run, home: vault })) : []), ...listKeptRuns(deps.userDataDir(), slug)]
  })

  // Planned Runs live in their talk's vault (planned-runs-ipc.ts): a request naming a vault writes there only.
  ipcMain.handle('history:create-planned-run', (_event, input: unknown) => createPlannedRunIn(plannedRunDeps(deps), input))
  ipcMain.handle('history:update-planned-run', (_event, payload: unknown) => updatePlannedRunIn(plannedRunDeps(deps), payload))
  ipcMain.handle('history:delete-planned-run', (_event, payload: unknown) => deletePlannedRunIn(plannedRunDeps(deps), payload))
}

function plannedRunDeps(deps: HistoryDeps): PlannedRunsDeps {
  return {
    vaultRoot: deps.vaultRoot,
    ...(deps.runVault ? { runVault: deps.runVault } : {}),
    ...(deps.hasTalk ? { hasTalk: deps.hasTalk } : {}),
    ...(deps.openVaults ? { openVaults: deps.openVaults } : {}),
    ...(deps.onPlannedRunUpdated ? { onPlannedRunUpdated: deps.onPlannedRunUpdated } : {}),
  }
}
