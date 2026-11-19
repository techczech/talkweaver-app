import type { WriteFailureBaseline } from './write-queues.ts'
// Updates (ADR-0044, superseding ADR-0041): the daily check of talkweaver.app/updates.json (release and alpha
// channels, src/shared/update-checker.ts), the one click that updates in place (update-installer.ts), and the
// `updates:*` IPC. TalkWeaver ports: configuration, the filtered network session, the busy and restart gates,
// bundled notes.
import { app, ipcMain, net, session, shell, type BrowserWindow } from 'electron'
import { request as httpRequest } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { downloadLinkFor, isSiteLink, parseVersion, parseWhatsNew, type CopySource, type WhatsNewItem, type FeedAnswer } from '@app-patterns/updates'
import { createElectronFeedFetcher } from '@app-patterns/updates/electron'
import { UPDATE_IDENTITY, FEED_URL, FEED_REQUEST, STORE_LINK, notesLinkFor } from '../shared/update-identity.ts'
import { RELEASE_ASSET_PREFIX, isOfferSeen, newerOffer, updateFileFor } from '../shared/update-channels.ts'
import { createChannelChecker, readChannelState, type ChannelChecker, type ChannelUpdateState, type CheckerSnapshot, type UpdateSnapshot } from '../shared/update-checker.ts'
import type { InPlaceRefusal, RestartBlocker } from '../shared/update-install.ts'
import { createUpdateInstaller } from './update-installer.ts'
import { handOutLink } from './hand-out.ts'
import { installLocalAddressFilter } from './local-address-filter.ts'
import { testNetworkOverride } from './test-network-startup.ts'

declare const __TW_UPDATE_TEST__: boolean


export interface UpdateNoticesPorts {
  /** Every window that may show a notice: the editor windows, never a presenting window. */
  editorWindows(): BrowserWindow[]
  /** A presenter window, an audience window, a live session or a recording is open: no request and no mark. */
  isPresentingNow(): boolean
  /** Everything a restart now would cost the person (update-install.ts restartBlockers). */
  restartBlockers(): RestartBlocker[]
  /** The restart's commit (ADR-0044): every window closed through its own close route. True only when none is left. */
  closeWindowsForRestart(): Promise<boolean>
  /** How many windows are open now (the native install is called only at zero). */
  openWindows(): number
  /** The restart's commit began and the restart will not happen: give the person a window back. */
  restartAbandoned(): void
  /** Rule C (ADR-0044 §6): every main-process write queue finished, and which are busy now. */
  drainWriteQueues(baseline: WriteFailureBaseline): Promise<boolean>
  writeQueuesBusy(): readonly string[]
  /** userData/config.json: `updateNotices` (state), `updatesCheckForNewVersions` and `updatesAlphaVersions` (the settings). */
  readConfig(): { updateNotices?: unknown; updatesCheckForNewVersions?: unknown; updatesAlphaVersions?: unknown; vaults?: unknown }
  writeConfig(patch: { updateNotices?: ChannelUpdateState; updatesCheckForNewVersions?: boolean; updatesAlphaVersions?: boolean }): void
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

/** `http://127.0.0.1:<port>/…` with nothing else, or null. */
function loopbackFeed(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? '')
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && !url.username && !url.password ? url.href : null
  } catch { return null }
}

interface TestOverrides { source: CopySource | null; feedUrl: string | null; harness: 'source' | 'update-test' | null }
/**
 * Test-only. Two harnesses may point the check at a stand-in feed on this computer's loopback address:
 *  - an unpackaged app started with TW_E2E=1 on a harness profile (test-network-guard.ts): TW_E2E_UPDATES_FEED,
 *    and TW_E2E_UPDATES_SOURCE to say which kind of copy it is. It downloads and checks an update but never
 *    installs it;
 *  - the unpublished update-test flavour (built by scripts/build-update-test.cjs with __TW_UPDATE_TEST__, which
 *    the production security gate refuses): TW_UPDATE_TEST_FEED. It installs for real, over itself.
 * A packaged production build ignores both. Update files must then live on the same stand-in.
 */
function testOverrides(): TestOverrides {
  if (__TW_UPDATE_TEST__ && app.isPackaged) {
    // Without a stand-in (for example when Squirrel.Mac reopens it after the update) it checks nothing at all.
    const feedUrl = loopbackFeed(process.env.TW_UPDATE_TEST_FEED)
    return { source: feedUrl ? 'website' : 'development', feedUrl, harness: 'update-test' }
  }
  if (app.isPackaged || process.env.TW_E2E !== '1') return { source: null, feedUrl: null, harness: null }
  const source = process.env.TW_E2E_UPDATES_SOURCE
  // Read only through the shared guard (test-network-guard.ts): a harness profile, 127.0.0.1 with a port.
  const feedUrl = loopbackFeed(testNetworkOverride('TW_E2E_UPDATES_FEED'))
  return { source: source === 'website' || source === 'store' || source === 'preview' ? source : null, feedUrl, harness: feedUrl ? 'source' : null }
}

/** Where this copy came from. Any packaged copy outside the Store checks, an alpha too (ADR-0044: alphas are public). */
function copySourceOf(store: boolean): CopySource {
  if (store) return 'store'
  return app.isPackaged ? 'website' : 'development'
}

export function installUpdateNotices(ports: UpdateNoticesPorts): ChannelChecker {
  const running = app.getVersion()
  const store = process.platform === 'win32' && (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true
  const test = testOverrides()
  const source = test.source ?? copySourceOf(store)
  const assetPrefix = test.feedUrl ? new URL('/releases/download/', test.feedUrl).href : RELEASE_ASSET_PREFIX
  const readState = (): ChannelUpdateState => readChannelState(ports.readConfig().updateNotices, FEED_URL, assetPrefix)
  const alphaOn = (): boolean => ports.readConfig().updatesAlphaVersions === true

  /**
   * Test-only, the unpublished update-test flavour alone (test.harness 'update-test' needs __TW_UPDATE_TEST__ and a
   * packaged build): while the file TW_UPDATE_TEST_HOLD_FILE names exists, the restart is held as a publish in
   * flight would hold it. The packaged proof (scripts/prove-in-place-update.mjs) uses it as its blocker (that build
   * cannot open a presenter window). Every other build reads nothing.
   */
  const testHold = (): RestartBlocker[] => {
    if (test.harness !== 'update-test') return []
    const file = process.env.TW_UPDATE_TEST_HOLD_FILE
    return file && isAbsolute(file) && existsSync(file) ? ['publishing'] : []
  }
  const blockersNow = (): RestartBlocker[] => { const b = [...ports.restartBlockers(), ...testHold()]; return b.filter((x, i) => b.indexOf(x) === i) }

  let checker: ChannelChecker
  const refusals = new Map<string, InPlaceRefusal | null>()
  const installer = createUpdateInstaller({
    install: test.harness !== 'source',
    cacheDirName: test.harness === 'update-test' ? 'talkweaver-update-test-updater' : 'talkweaver-updater',
    ...(test.harness === 'source' ? { cacheBase: join(app.getPath('userData'), 'updater-cache') } : {}),
    configDir: join(app.getPath('userData'), 'updater'),
    filterLocalAddresses: test.harness === null,
    source,
    isProtected: ports.isPresentingNow,
    blockers: blockersNow,
    closeWindows: ports.closeWindowsForRestart,
    openWindows: ports.openWindows,
    commitAbandoned: ports.restartAbandoned,
    drainWriteQueues: ports.drainWriteQueues,
    writeQueuesBusy: ports.writeQueuesBusy,
    changed: () => { try { checker?.tell() } catch { /* starting */ } },
    log: (message) => console.log(`[updates] ${message}`),
  })

  /** The check's snapshot with the click's state, the file for this computer and whether it can be used here. */
  const withInstall = (s: CheckerSnapshot): UpdateSnapshot => {
    const offer = newerOffer(s.state.channels, s.alpha, running)
    const file = updateFileFor(offer, process.platform, process.arch)
    const key = `${offer?.version ?? ''} ${file?.url ?? ''} ${file?.bundleId ?? ''}`
    if (!refusals.has(key)) refusals.set(key, installer.refusal(file, s.source))
    const install = installer.state()
    // While working on an update the mark stays (unless presenting), whatever the offer says.
    const working = install.phase !== 'idle'
    return { ...s, install, file, refusal: refusals.get(key) ?? null, blockers: working ? blockersNow() : [] }
  }
  const tellWindows = (channel: string, snapshot: UpdateSnapshot): void => {
    for (const win of ports.editorWindows()) {
      try { if (!win.isDestroyed()) win.webContents.send(channel, snapshot) } catch { /* closing */ }
    }
  }
  let lastOffer: string | null = null
  checker = createChannelChecker({
    identity: UPDATE_IDENTITY,
    arch: process.arch,
    running,
    platform: process.platform,
    source,
    assetPrefix,
    fetchFeed: () => fetchFeedOverNet(test.feedUrl ?? FEED_REQUEST.url),
    readState,
    writeState: (state) => ports.writeConfig({ updateNotices: state }),
    enabled: () => ports.readConfig().updatesCheckForNewVersions !== false,
    alpha: alphaOn,
    isBusy: ports.isPresentingNow,
    hasNotes: (version) => readNotes(version) !== null,
    hadConfiguration: () => { const v = ports.readConfig().vaults; return Array.isArray(v) ? v.length > 0 : typeof v === 'object' && v !== null && Object.keys(v).length > 0 },
    now: () => Date.now(),
    changed: (snapshot) => {
      const offer = newerOffer(snapshot.state.channels, snapshot.alpha, running)?.version ?? null
      if (offer !== lastOffer) { lastOffer = offer; installer.reset() }
      tellWindows('updates:changed', withInstall(snapshot))
    },
    answered: (snapshot) => tellWindows('updates:answered', withInstall(snapshot)),
  })
  const snap = (): UpdateSnapshot => withInstall(checker.snapshot())

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

  ipcMain.handle('updates:get', (): UpdateSnapshot => snap())
  ipcMain.handle('updates:check', async (): Promise<UpdateSnapshot> => withInstall(await checker.checkNow()))
  ipcMain.handle('updates:skip', (_e, version: unknown): UpdateSnapshot => withInstall(typeof version === 'string' && parseVersion(version) ? checker.skip(version) : checker.snapshot()))
  ipcMain.handle('updates:stop-skipping', (): UpdateSnapshot => withInstall(checker.stopSkipping()))
  ipcMain.handle('updates:not-now', (): UpdateSnapshot => withInstall(checker.notNow()))
  ipcMain.handle('updates:set-enabled', (_e, on: unknown): UpdateSnapshot => {
    ports.writeConfig({ updatesCheckForNewVersions: on === true })
    return withInstall(checker.settingChanged())
  })
  ipcMain.handle('updates:set-alpha', (_e, on: unknown): UpdateSnapshot => {
    ports.writeConfig({ updatesAlphaVersions: on === true })
    return withInstall(checker.settingChanged())
  })
  // Update takes no address: it is the newer offer the last validated feed gave for this computer, and only when that
  // is the version the person saw (the renderer names it; it is compared, never used to build anything). When the
  // offer has changed since, nothing starts and the windows are told again, so they show the offer as it is now.
  ipcMain.handle('updates:update', async (_e, seen: unknown): Promise<UpdateSnapshot> => {
    const s = checker.snapshot()
    const offer = newerOffer(s.state.channels, s.alpha, running)
    if (!isOfferSeen(seen, offer)) {
      console.log('[updates] Update refused: the version offered is not the one shown; the windows are told again')
      checker.tell()
      return snap()
    }
    const file = updateFileFor(offer, process.platform, process.arch)
    if (!offer || !file || s.busy || installer.refusal(file, s.source) !== null) return snap()
    void installer.start(offer, file)
    return snap()
  })
  ipcMain.handle('updates:cancel', (): UpdateSnapshot => { installer.cancel(); return snap() })
  ipcMain.handle('updates:restart', (): UpdateSnapshot => { installer.restart(); return snap() })
  // Download takes no address: the link is the one the last validated feed gave for this computer.
  ipcMain.handle('updates:download', (): Promise<boolean> => {
    const s = checker.snapshot()
    const latest = newerOffer(s.state.channels, s.alpha, running) ?? s.state.channels?.release
    return latest ? open(downloadLinkFor(latest, process.platform, FEED_URL), (l) => isSiteLink(l, FEED_URL)) : Promise.resolve(false)
  })
  ipcMain.handle('updates:open-notes', (_e, version: unknown): Promise<boolean> => {
    if (typeof version !== 'string' || !parseVersion(version)) return Promise.resolve(false)
    const s = checker.snapshot()
    const latest = newerOffer(s.state.channels, s.alpha, running) ?? s.state.channels?.release
    const link = notesLinkFor(latest, version)
    return link ? open(link, (l) => isSiteLink(l, FEED_URL)) : Promise.resolve(false)
  })
  ipcMain.handle('updates:open-store', (): Promise<boolean> => open(STORE_LINK, (l) => l === STORE_LINK))
  ipcMain.handle('updates:whats-new', () => {
    const items = readNotes(running)
    const from = checker.snapshot().state.whatsNew?.from ?? null
    return items ? { version: running, from, items } : null
  })
  ipcMain.handle('updates:dismiss-whats-new', (): UpdateSnapshot => withInstall(checker.dismissWhatsNew()))

  checker.start()
  return checker
}
