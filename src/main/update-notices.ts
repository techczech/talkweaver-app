// TalkWeaver ports: configuration, filtered network session, IPC and bundled notes.
import { app, ipcMain, net, session, shell, type BrowserWindow } from 'electron'
import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { downloadLinkFor, isSiteLink, parseVersion, copySource, parseWhatsNew, readUpdateState, createUpdateChecker, type CopySource, type UpdateState, type WhatsNewItem, type FeedAnswer, type UpdateChecker, type UpdateSnapshot } from '@app-patterns/updates'
import { createElectronFeedFetcher } from '@app-patterns/updates/electron'
import { UPDATE_IDENTITY, FEED_URL, FEED_REQUEST, STORE_LINK, notesLinkFor } from '../shared/update-identity.ts'
import { handOutLink } from './hand-out.ts'
import { installLocalAddressFilter } from './local-address-filter.ts'

export interface UpdateNoticesPorts {
  /** Every window that may show a notice: the editor windows, never a presenting window. */
  editorWindows(): BrowserWindow[]
  /** A presenter window, an audience window, a live session or a recording is open. */
  isPresentingNow(): boolean
  /** userData/config.json: the keys `updateNotices` (state) and `updatesCheckForNewVersions` (the setting). */
  readConfig(): { updateNotices?: unknown; updatesCheckForNewVersions?: unknown; vaults?: unknown }
  writeConfig(patch: { updateNotices?: UpdateState; updatesCheckForNewVersions?: boolean }): void
  /** A test run (TW_E2E) logs the link instead of opening it. */
  e2e: boolean
}

export const UPDATES_PARTITION = 'updates-check'
let updatesSession: Electron.Session | null = null
/** The check's own in-memory session, with the local-address filter on it before it is first used. */
function checkSession(): Electron.Session {
  if (!updatesSession) {
    updatesSession = session.fromPartition(UPDATES_PARTITION, { cache: false })
    installLocalAddressFilter(updatesSession)
  }
  return updatesSession
}

// Keep TalkWeaver's filtered, in-memory session while sharing the bounded request implementation.
const fetchReleaseFeed = createElectronFeedFetcher(UPDATE_IDENTITY, {
  net,
  session: { fromPartition: () => checkSession() },
})
export function fetchFeedOverNet(url: string = FEED_URL): Promise<FeedAnswer> {
  return url === FEED_URL ? fetchReleaseFeed() : fetchStandIn(url)
}

/** Test only (see testOverrides): the stand-in on this computer's loopback address, which the local-address filter would refuse through the session. Same limits, same answer shape. */
function fetchStandIn(url: string): Promise<FeedAnswer> {
  return new Promise((resolve) => {
    let finished = false
    let request: ReturnType<typeof httpRequest> | null = null
    const done = (answer: FeedAnswer): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (!answer.ok) { try { request?.destroy() } catch { /* already over */ } }
      resolve(answer)
    }
    const timer = setTimeout(() => done({ ok: false, reason: 'unreachable' }), FEED_REQUEST.timeoutMs)
    try {
      request = httpRequest(url, { method: FEED_REQUEST.method, headers: FEED_REQUEST.headers }, (response) => {
        // The same cap on every answer, a non-200 one too: the body is counted, never kept.
        const ok = response.statusCode === 200
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > FEED_REQUEST.maxBytes) { done({ ok: false, reason: 'too-large' }); return }
          if (ok) chunks.push(chunk)
        })
        response.on('end', () => done(ok ? { ok: true, text: Buffer.concat(chunks).toString('utf8') } : { ok: false, reason: 'unreadable' }))
        response.on('error', () => done({ ok: false, reason: 'unreachable' }))
      })
      request.on('error', () => done({ ok: false, reason: 'unreachable' }))
      request.end()
    } catch { done({ ok: false, reason: 'unreachable' }) }
  })
}

const notesDir = (): string => (app.isPackaged ? join(process.resourcesPath, 'whats-new') : join(process.cwd(), 'resources', 'whats-new'))

/** The notes shipped for a version, or null. The version is checked first, so no path can be built from it. */
function readNotes(version: string): WhatsNewItem[] | null {
  if (!parseVersion(version)) return null
  try { return parseWhatsNew(readFileSync(join(notesDir(), `${version}.md`), 'utf8')) } catch { return null }
}

/**
 * Test-only. An unpackaged app started with TW_E2E=1 may be told which kind of copy it is
 * (TW_E2E_UPDATES_SOURCE) and to read the feed from a stand-in on this computer's own loopback address
 * (TW_E2E_UPDATES_FEED); a packaged build ignores both. The links in the stand-in's feed are still
 * checked as on the real feed, and they are never fetched.
 */
function testOverrides(): { source: CopySource | null; feedUrl: string | null } {
  if (app.isPackaged || process.env.TW_E2E !== '1') return { source: null, feedUrl: null }
  const source = process.env.TW_E2E_UPDATES_SOURCE
  let feedUrl: string | null = null
  try {
    const url = new URL(process.env.TW_E2E_UPDATES_FEED ?? '')
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') feedUrl = url.href
  } catch { /* no stand-in */ }
  return { source: source === 'website' || source === 'store' || source === 'preview' ? source : null, feedUrl }
}

export function installUpdateNotices(ports: UpdateNoticesPorts): UpdateChecker {
  const running = app.getVersion()
  const store = process.platform === 'win32' && (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true
  const test = testOverrides()
  const tellWindows = (channel: string, snapshot: UpdateSnapshot): void => {
    for (const win of ports.editorWindows()) {
      try { if (!win.isDestroyed()) win.webContents.send(channel, snapshot) } catch { /* closing */ }
    }
  }
  const checker = createUpdateChecker({
    identity: UPDATE_IDENTITY,
    arch: process.arch,
    running,
    platform: process.platform,
    source: test.source ?? copySource({ packaged: app.isPackaged, store, running }),
    fetchFeed: () => fetchFeedOverNet(test.feedUrl ?? FEED_REQUEST.url),
    readState: () => readUpdateState(ports.readConfig().updateNotices, FEED_URL),
    writeState: (state) => ports.writeConfig({ updateNotices: state }),
    enabled: () => ports.readConfig().updatesCheckForNewVersions !== false,
    isBusy: ports.isPresentingNow,
    hasNotes: (version) => readNotes(version) !== null,
    hadConfiguration: () => { const v = ports.readConfig().vaults; return Array.isArray(v) ? v.length > 0 : typeof v === 'object' && v !== null && Object.keys(v).length > 0 },
    now: () => Date.now(),
    changed: (snapshot) => tellWindows('updates:changed', snapshot),
    answered: (snapshot) => tellWindows('updates:answered', snapshot),
  })

  /** Hand a link to the browser: only one that passes the site rule (or the Store constant). */
  const open = async (link: string, allowed: (l: string) => boolean): Promise<boolean> => {
    if (!allowed(link)) return false
    const handed = handOutLink(link)
    if (!handed || handed.kind !== 'web') return false
    try {
      if (ports.e2e) console.log('[update-notices] external (E2E):', handed.href)
      else await shell.openExternal(handed.href)
      return true
    } catch { return false }
  }

  ipcMain.handle('updates:get', (): UpdateSnapshot => checker.snapshot())
  ipcMain.handle('updates:check', (): Promise<UpdateSnapshot> => checker.checkNow())
  ipcMain.handle('updates:skip', (_e, version: unknown): UpdateSnapshot => (typeof version === 'string' && parseVersion(version) ? checker.skip(version) : checker.snapshot()))
  ipcMain.handle('updates:stop-skipping', (): UpdateSnapshot => checker.stopSkipping())
  ipcMain.handle('updates:not-now', (): UpdateSnapshot => checker.notNow())
  ipcMain.handle('updates:set-enabled', (_e, on: unknown): UpdateSnapshot => {
    ports.writeConfig({ updatesCheckForNewVersions: on === true })
    return checker.settingChanged()
  })
  // Download takes no address: the link is the one the last validated feed gave for this computer.
  ipcMain.handle('updates:download', (): Promise<boolean> => {
    const latest = checker.snapshot().state.latest
    return latest ? open(downloadLinkFor(latest, process.platform, FEED_URL), (l) => isSiteLink(l, FEED_URL)) : Promise.resolve(false)
  })
  ipcMain.handle('updates:open-notes', (_e, version: unknown): Promise<boolean> => {
    if (typeof version !== 'string' || !parseVersion(version)) return Promise.resolve(false)
    const link = notesLinkFor(checker.snapshot().state.latest, version)
    return link ? open(link, (l) => isSiteLink(l, FEED_URL)) : Promise.resolve(false)
  })
  ipcMain.handle('updates:open-store', (): Promise<boolean> => open(STORE_LINK, (l) => l === STORE_LINK))
  ipcMain.handle('updates:whats-new', () => {
    const items = readNotes(running)
    const from = checker.snapshot().state.whatsNew?.from ?? null
    return items ? { version: running, from, items } : null
  })
  ipcMain.handle('updates:dismiss-whats-new', (): UpdateSnapshot => checker.dismissWhatsNew())

  checker.start()
  return checker
}
