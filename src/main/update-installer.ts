import type { WriteFailureBaseline } from './write-queues.ts'
// Updating in place (ADR-0044): Electron's side of the one click. The engine and its design (one function may call
// the native install, after re-reading the blockers; attempts with identities; electron-updater's own install path
// closed) are in update-engine.ts; read its header first. This file supplies what the engine asks for:
// electron-updater's MacUpdater configured as a download engine with our own provider (it makes no request: it
// hands over the one version our checker already chose from the validated feed), the deferred hand-over to
// Squirrel.Mac (Electron's autoUpdater) at restart time only, the file checks, the clean-up of downloads, and the
// checked withdrawal of a preparation that must not install.
// Windows constructs nothing: no in-place install there in this release (ADR-0044 §5).
// The developer identity is checked by TalkWeaver itself (ADR-0044 §7, update-signature.ts): the running process must
// meet the requirement compiled into it, and the new app must pass codesign and Gatekeeper before the hand-over; the
// private copy that was checked is the file Squirrel.Mac is served, re-hashed immediately before.
import { app, session } from 'electron'
import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { MacUpdater, type AppUpdater, type UpdateInfo } from 'electron-updater'
import { getAppCacheDir } from 'electron-updater/out/AppAdapter'
import type { ChannelEntry, UpdateFile } from '../shared/update-channels.ts'
import { inPlaceRefusal, type InPlaceFacts, type InPlaceRefusal, type InstallPhase, type RestartBlocker } from '../shared/update-install.ts'
import {
  OfferProvider, closeDependencyInstallPath, createUpdateEngine, dependencyDownload, launchdJobPresence, pathPresence, verifyMacDownload,
  type NativeUpdater, type Offer, type Presence, type Withdrawal,
} from './update-engine.ts'
import { installUpdaterRequestFilter, updateDownloadAllowed } from './update-hosts.ts'
import { checkRunningCopy, privateCopy, runTool, sha512Matches, validSigner, verifyUpdateZip, type RunningCopy } from './update-signature.ts'

declare const __TW_UPDATE_TEST__: boolean
/** The bundle identifier and Developer ID team this build is signed with (electron.vite.config.ts, UPDATE_SIGNER). */
declare const __TW_UPDATE_SIGNER__: { bundleId: string; team: string }
const SIGNER = validSigner(typeof __TW_UPDATE_SIGNER__ === 'undefined' ? null : __TW_UPDATE_SIGNER__)

/** electron-updater's own network partition (electronHttpExecutor.ts NET_SESSION_NAME). */
const UPDATER_PARTITION = 'electron-updater'

export interface InstallerDeps {
  /** false in a test harness run from source: everything up to handing the file to Squirrel.Mac, then a log line. */
  install: boolean
  /** The download cache folder's name under the computer's cache folder. */
  cacheDirName: string
  /** Test harness only: put the cache here instead of the computer's cache folder. */
  cacheBase?: string
  /** Where electron-updater's small configuration file is written (the user-data folder). */
  configDir: string
  /** Production: the updater's session may reach only GitHub's release hosts over HTTPS, redirects included, and never
   *  a local address (update-hosts.ts). Off only in the test harnesses, whose stand-in feed is on 127.0.0.1. */
  filterLocalAddresses: boolean
  /** website, store, preview or development (copySource): a Store copy or a development run never updates itself. */
  source: string
  /** A protected task (presenter or audience window, live session, recording): no update starts. */
  isProtected(): boolean
  blockers(): RestartBlocker[]
  /** The restart's commit: every window closed through its own close route. True only when every window has closed
   *  (update-engine.ts, commit). */
  closeWindows(): Promise<boolean>
  /** How many windows are open now (every BrowserWindow, hidden ones too). */
  openWindows(): number
  /** Every main-process write queue finished (write-queues.ts drainWriteQueues). */
  drainWriteQueues(baseline: WriteFailureBaseline): Promise<boolean>
  writeQueuesBusy(): readonly string[]
  /** The restart's commit began and the restart will not happen: give the person a window back. */
  commitAbandoned(): void
  changed(): void
  log(message: string): void
}

/** CFBundleIdentifier of the running Mac app, or null. */
function readBundleId(bundle: string): string | null {
  try {
    const out = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 5000 }).trim()
    return out || null
  } catch { return null }
}

const runningBundle = (): string => resolve(process.execPath, '..', '..', '..')

/** The facts inPlaceRefusal decides on, read from this computer now. `developerSigned`: the running copy's own
 *  signature check (asked once per run by the installer), absent when not checked. */
export function readInPlaceFacts(file: UpdateFile | null, source: string, developerSigned?: boolean): InPlaceFacts {
  const platform = process.platform
  const appPath = platform === 'darwin' ? runningBundle() : dirname(process.execPath)
  let writable = false
  let writeError: string | null = null
  try {
    accessSync(appPath, constants.W_OK)
    accessSync(dirname(appPath), constants.W_OK)
    writable = true
  } catch (error) { writeError = (error as NodeJS.ErrnoException)?.code ?? 'EACCES' }
  return {
    platform, arch: process.arch, source, file, appPath, writable, writeError, bundleId: platform === 'darwin' ? readBundleId(appPath) : null,
    ...(developerSigned !== undefined ? { developerSigned } : {}),
  }
}

/** A run from source stands in for Squirrel.Mac: it "prepares" at once and logs instead of installing. */
function sourceRunNative(log: (message: string) => void, version: () => string): NativeUpdater {
  const events = new EventEmitter()
  return {
    on: (event, listener) => events.on(event, listener),
    checkForUpdates: () => { setImmediate(() => events.emit('update-downloaded')) },
    quitAndInstall: () => log(`restart into ${version()} (test run from source): not installed`),
  }
}

export function createUpdateInstaller(deps: InstallerDeps) {
  const cacheDir = join(deps.cacheBase ?? getAppCacheDir(), deps.cacheDirName)
  let updater: AppUpdater | null = null
  let chosen: UpdateInfo | null = null
  let downloader: ReturnType<typeof dependencyDownload> | null = null
  let stand: NativeUpdater | null = null
  let handOver: ((file: string, serve?: string) => Promise<void>) | null = null
  /** The verified private copy of each verified download (ADR-0044 §7): what is checked is what is served. */
  const verified = new Map<string, { copy: string; sha512: string }>()
  const unverified = (message: string): Error => Object.assign(new Error(message), { code: 'ERR_TW_UNVERIFIED' })

  // A download a crash or an earlier version left behind is never used: the cache starts empty each run.
  try { rmSync(cacheDir, { recursive: true, force: true }) } catch { /* nothing there */ }

  // Whether the running process itself meets the developer-identity requirement, on a Mac copy that installs (a test
  // run from source installs nothing and is not asked). Asked off the main thread at start; a definite answer is
  // kept for the run, 'unknown' (a tool that could not answer) is asked again, at most once a minute, and at the click.
  const identityApplies = deps.install && process.platform === 'darwin'
  let running: RunningCopy | 'unchecked' = 'unchecked'
  let asking: Promise<void> | null = null
  let askedAt = 0
  const askRunningCopy = (): Promise<void> => {
    if (!identityApplies || running === 'signed' || running === 'mismatch') return Promise.resolve()
    return (asking ??= (async () => {
      askedAt = Date.now()
      const r = await checkRunningCopy(process.pid, SIGNER, runTool).catch((error) => ({ result: 'unknown' as const, detail: String((error as Error)?.message ?? error) }))
      const before = running
      running = r.result
      deps.log(`this copy ${r.result === 'signed' ? 'meets' : r.result === 'mismatch' ? 'does NOT meet' : 'could not be checked against'} the developer-identity requirement${SIGNER ? ` (${SIGNER.bundleId}, team ${SIGNER.team})` : ''}: ${r.detail}`)
      if (running !== before) deps.changed()
    })().finally(() => { asking = null }))
  }
  /** For the notice: true or false only on a definite answer; otherwise undefined (not refused) and asked again. */
  const developerSigned = (): boolean | undefined => {
    if (!identityApplies) return undefined
    if (running === 'signed') return true
    if (running === 'mismatch') return false
    if (!asking && Date.now() - askedAt >= 60_000) void askRunningCopy()
    return undefined
  }
  if (identityApplies) void askRunningCopy()

  function create(): AppUpdater {
    if (process.platform !== 'darwin') throw new Error('no in-place update on this platform')
    const configPath = join(deps.configDir, 'app-update.yml')
    mkdirSync(deps.configDir, { recursive: true })
    // electron-updater reads only the cache folder's name from here: the feed is the provider below.
    writeFileSync(configPath, `updaterCacheDirName: ${deps.cacheDirName}\n`)
    if (deps.filterLocalAddresses) installUpdaterRequestFilter(session.fromPartition(UPDATER_PARTITION, { cache: false }), (m) => deps.log(m))
    const u: AppUpdater = new MacUpdater()
    u.logger = {
      info: (m: unknown) => deps.log(String(m)),
      warn: (m: unknown) => deps.log(`warning: ${String(m)}`),
      error: (m: unknown) => deps.log(`error: ${String(m)}`),
      debug: () => {},
    }
    handOver = closeDependencyInstallPath(u, deps.log).handOver
    u.forceDevUpdateConfig = !app.isPackaged
    u.requestHeaders = { 'User-Agent': 'TalkWeaver' }
    u.updateConfigPath = configPath
    if (deps.cacheBase) {
      const cacheBase = deps.cacheBase
      const adapter = (u as unknown as { app: object }).app
      Object.defineProperty(u, 'app', { value: Object.create(adapter, { baseCachePath: { get: () => cacheBase } }) })
    }
    u.setFeedURL({ provider: 'custom', updateProvider: OfferProvider, offer: () => chosen } as unknown as Parameters<AppUpdater['setFeedURL']>[0])
    return u
  }
  const theUpdater = (): AppUpdater => (updater ??= create())

  /**
   * Squirrel.Mac keeps a prepared update as an install request (ShipItState.plist in its cache folder) and a launchd
   * job (ShipIt) that installs it when the app's process ends. Remove both, then CHECK that both are gone.
   */
  async function withdrawNative(): Promise<Withdrawal> {
    if (!deps.install || process.platform !== 'darwin') return { found: false, gone: true, after: 'absent' }
    const bundleId = readBundleId(runningBundle())
    if (!bundleId) { deps.log('the withdrawal could not name ShipIt (no bundle identifier): not confirmed'); return { found: true, gone: false, after: 'unknown' } }
    const label = `${bundleId}.ShipIt`
    const folder = join(homedir(), 'Library', 'Caches', label)
    const request = join(folder, 'ShipItState.plist')
    // Each check gives a definite answer or 'unknown' (a timeout, an error, an unexpected exit code, a path that
    // cannot be read). Only two definite 'absent' answers count as withdrawn; 'unknown' is never read as gone.
    const job = (): Presence => launchdJobPresence(spawnSync('/bin/launchctl', ['list', label], { stdio: 'ignore', timeout: 5000 }))
    const requestThere = (): Presence => pathPresence(() => lstatSync(request))
    const before = { job: job(), request: requestThere() }
    const found = before.job !== 'absent' || before.request !== 'absent'
    deps.log(`withdrawing: before, ShipIt job ${before.job}, install request ${before.request}`)
    let last = before
    for (let round = 0; round < 8; round++) {
      if (last.job !== 'absent') {
        const r = spawnSync('/bin/launchctl', ['remove', label], { stdio: 'ignore', timeout: 5000 })
        if (r.status !== 0) deps.log(`launchctl remove ${label} exited ${r.status ?? r.error?.message}`)
      }
      try { rmSync(folder, { recursive: true, force: true }) } catch (error) { deps.log(`could not remove ${folder}: ${(error as Error)?.message ?? error}`) }
      await new Promise((r) => setTimeout(r, 250))
      last = { job: job(), request: requestThere() }
      if (last.job === 'absent' && last.request === 'absent') {
        deps.log(found ? 'a prepared update was withdrawn and checked: no ShipIt job, no install request' : 'checked: nothing was prepared')
        return { found, gone: true, after: 'absent' }
      }
    }
    // 'present' only when both are definitely there: then the update WILL install at the next quit.
    const after: Presence = last.job === 'present' && last.request === 'present' ? 'present' : 'unknown'
    deps.log(`the withdrawal is NOT confirmed: ShipIt job ${last.job}, install request ${last.request} (afterwards: ${after})`)
    return { found: true, gone: false, after }
  }

  const engine = createUpdateEngine({
    platform: process.platform,
    gate: (offer) => {
      if (deps.isProtected()) return 'a protected task is active (presenting, an audience window, a live session or a recording)'
      if (deps.filterLocalAddresses && !updateDownloadAllowed(offer.url)) return 'the update file is not on GitHub'
      const refusalNow = () => inPlaceRefusal(readInPlaceFacts({ url: offer.url, sha512: offer.sha512, size: offer.size, ...(offer.bundleId !== undefined ? { bundleId: offer.bundleId } : {}) }, deps.source, developerSigned()))
      const first = refusalNow()
      if (first !== null || !identityApplies || running === 'signed') return first
      // Not answered yet, or the last answer was not definite: ask now, then decide. Never installs on 'unknown'.
      return askRunningCopy().then(() => running === 'unknown' || running === 'unchecked'
        ? { failed: 'unverified' as const, why: 'the running copy\'s developer identity could not be checked' }
        : refusalNow())
    },
    blockers: deps.blockers,
    // A run from source installs nothing, so it closes nothing either: its stand-in Squirrel.Mac only logs.
    closeWindows: () => {
      if (deps.install) return deps.closeWindows()
      deps.log('every window would close now (test run from source): left open')
      return Promise.resolve(true)
    },
    openWindows: () => (deps.install ? deps.openWindows() : 0),
    // A run from source waits for the write queues too (nothing closes, so this only waits and logs).
    drainWriteQueues: deps.drainWriteQueues,
    writeQueuesBusy: deps.writeQueuesBusy,
    commitAbandoned: () => { if (deps.install) deps.commitAbandoned() },
    downloader: () => (downloader ??= dependencyDownload(theUpdater(), (info) => { chosen = info })),
    verify: async (file, offer, token) => {
      // Cancel stops the copy and the tools; their folders are removed as they stop.
      const stop = new AbortController()
      if (token?.cancelled) stop.abort()
      else token?.once('cancel', () => stop.abort())
      const copied = await privateCopy(file, offer.sha512, cacheDir, stop.signal)
      if (copied.reason !== null || copied.copy === null) { deps.log(`${offer.version}: no private copy (${copied.reason}): ${copied.detail}`); return copied.reason ?? 'unverified' }
      const problem = await verifyMacDownload(copied.copy, offer, app.getVersion())
      if (problem) return problem
      // A run from source hands nothing to Squirrel.Mac and its stand-in file is not a signed app.
      if (!deps.install) { deps.log('the developer-identity check is skipped (test run from source): nothing is installed'); verified.set(file, { copy: copied.copy, sha512: offer.sha512 }); return null }
      deps.log(`checking ${offer.version}'s developer identity (codesign and Gatekeeper)`)
      const verdict = await verifyUpdateZip(copied.copy, cacheDir, SIGNER, { gatekeeper: __TW_UPDATE_TEST__ ? 'logged' : 'required', signal: stop.signal })
      deps.log(`${offer.version}: ${verdict.reason === null ? 'verified' : `NOT verified (${verdict.reason})`}: ${verdict.detail}`)
      if (verdict.reason === null) verified.set(file, { copy: copied.copy, sha512: offer.sha512 })
      return verdict.reason
    },
    // The verified private copy is read again in full immediately before it is served; any change refuses. A run from
    // source hands nothing over: its stand-in Squirrel.Mac only logs.
    handOver: async (file) => {
      if (!deps.install) return
      if (!handOver) throw new Error('the updater was not created')
      const v = verified.get(file)
      if (!v) throw unverified('no verified copy of this download')
      if (!(await sha512Matches(v.copy, v.sha512))) throw unverified('the verified copy changed before it was handed over')
      deps.log('the verified copy still has its SHA-512: Squirrel.Mac is served that copy')
      await handOver(file, v.copy)
    },
    native: () => deps.install
      ? (theUpdater() as unknown as { nativeUpdater: NativeUpdater }).nativeUpdater
      : (stand ??= sourceRunNative(deps.log, () => engine.state().phase === 'idle' ? '' : (engine.state() as { version: string }).version)),
    withdrawNative,
    releaseFiles: () => {
      try { (updater as unknown as { closeServerIfExists?: () => void } | null)?.closeServerIfExists?.() } catch { /* already closed */ }
      try { rmSync(cacheDir, { recursive: true, force: true }) } catch { /* nothing there */ }
      verified.clear()
    },
    changed: deps.changed,
    log: deps.log,
  })

  return {
    state: (): InstallPhase => engine.state(),
    /** The click: download the entry's file for this computer, check it, then restart or wait. */
    start(entry: ChannelEntry, file: UpdateFile): Promise<InstallPhase> {
      const offer: Offer = { version: entry.version, released: entry.released, url: file.url, sha512: file.sha512, size: file.size, ...(file.bundleId !== undefined ? { bundleId: file.bundleId } : {}) }
      return engine.start(offer)
    },
    cancel: (): InstallPhase => engine.cancel(),
    /** Restart to finish updating: only when nothing holds it back. */
    restart: (): InstallPhase => engine.restart(),
    /** The offer changed: a failed attempt starts again from Update. */
    reset: (): void => engine.reset(),
    refusal(file: UpdateFile | null, source: string): InPlaceRefusal | null {
      return inPlaceRefusal(readInPlaceFacts(file, source, file ? developerSigned() : undefined))
    },
    /** The running copy's identity answer so far (a key for cached refusals: it changes once a check answers). */
    identity: (): string => running,
  }
}
export type UpdateInstaller = ReturnType<typeof createUpdateInstaller>
