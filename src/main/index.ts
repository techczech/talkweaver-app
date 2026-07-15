import { app, BrowserWindow, ipcMain, dialog, Menu, net, protocol, shell, session, safeStorage, screen, type MenuItemConstructorOptions } from 'electron'
import { join, basename, dirname, extname } from 'path'

// EPIPE guard: when the packaged binary is launched with stdout/stderr piped and the pipe
// dies, any console.log (prerenderAllThumbnails logs a lot) would otherwise throw an
// uncaught EPIPE and crash the main process with a dialog. Swallow stream errors — logging
// must never kill the app.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

// Custom schemes must be registered as privileged BEFORE app ready so the renderer
// treats twasset:// and twthumb:// as standard secure schemes (CSP matching,
// no mixed-content blocking). The file handlers themselves are registered in whenReady.
protocol.registerSchemesAsPrivileged([
  { scheme: 'twasset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'twthumb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Serves read-only image files out of the old-PowerPoint archive (twarchive://<b64url>).
  { scheme: 'twarchive', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Serves local image files referenced by path in an outline (twfile://f/<b64url>), guarded
  // to the vault root. Lets the editor preview path-based images from the dev http origin too.
  { scheme: 'twfile', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // Serves a recorded Session's local audio (twrec://<sessionId>) to Studio's <audio>. `stream`
  // enables Range requests so the player can seek/scrub without downloading the whole file.
  { scheme: 'twrec', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  // Serves the compiled present HTML and sibling assets for Studio replay iframes.
  { scheme: 'twpresent', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
import { pathToFileURL } from 'url'
import { homedir, tmpdir } from 'os'
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, realpathSync, cpSync, rmSync, renameSync, createReadStream, linkSync, copyFileSync, mkdtempSync, openSync, readSync, closeSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { execFile, execFileSync } from 'child_process'
import { resolve as resolvePath, sep as pathSep, relative as relativePath } from 'path'
import { renderThumbnails } from './thumbnails'
import {
  contentHashForPrerender,
  loadPrerenderLedger,
  recordSuccessfulPrerender,
  savePrerenderLedger,
  shouldPrerenderTalk
} from './prerender-ledger'
import { createVaultListHandler } from './vault-list-handler.mjs'
import {
  createSlidePreviewStore,
  markSlidePreviewHtml,
  slidePreviewIdFromUrl,
  slidePreviewUrl,
  thumbnailDocumentCacheKey
} from '../shared/slide-preview'
import { readFile as readFileAsync, readdir as readdirAsync } from 'fs/promises'
import {
  setupRecordingPermissions,
  registerRecordingIpc,
  registerRecordingContext,
  unregisterRecordingContext,
  shouldOfferRunSave,
  sendRecordingCloseOffer,
  recordingAudioPath
} from './recording'
import { registerHistoryIpc } from './history'
import {
  DEFAULT_TRANSCRIPTION_PYTHON,
  DEFAULT_TRANSCRIPTION_SCRIPT,
  registerTranscriptionIpc
} from './transcription'
import { registeredKeyNames, openVocabularyFrontmatterKeys } from '../shared/metadata-registry'
import { editFrontmatterText } from '../shared/frontmatter-editor'
import { commandElectronAccelerator, menuCommands } from '../shared/command-registry'
import { vocabularyFromTagLists } from '../shared/tags'
import {
  createPathwayInManifest,
  deletePathwayInManifest,
  injectPathwayRuntime,
  invalidatePathwaySummary,
  readPathwayManifest,
  readPathwaySummary,
  renamePathwayInManifest,
  resolvePathways,
  setPathwaySlideIdsInManifest,
  writePathwayManifest,
  type PathwaySlideRow
} from './pathways'
import {
  clearRunHandoutUrl,
  injectRunCoverMetadata,
  persistRun,
  readRun,
  runHandoutSlug,
  setRunHandoutUrl,
  type RunRecord
} from './runs'
import {
  checkPreconditions,
  resolveBase,
  publishUrl,
  augmentedPath,
  readHandoutUrl,
  recoverIdFromUrl,
  generateShortId,
  pickShortId,
  buildRedirects,
  stampHandoutUrl
} from './publishing-logic'

const slidePreviewStore = createSlidePreviewStore(8)

// Simple JSON config — avoids ESM/CJS issues with electron-store
type Config = {
  vaultRoot?: string
  windowBounds?: { x?: number; y?: number; width: number; height: number }
  toolsWindowBounds?: { x?: number; y?: number; width: number; height: number }
  pathwayWindowBounds?: { x?: number; y?: number; width: number; height: number }
  archiveRoot?: string
  // Cloudflare Pages publishing (Settings → Publishing). NON-SECRET config only — the API token is
  // stored separately, OS-keychain-encrypted, via safeStorage ({userData}/cf-pages-token.bin),
  // NEVER in this file.
  cfAccountId?: string
  cfPagesProject?: string
  publishBaseUrl?: string // optional custom domain, e.g. https://handouts.example.com
  publishUseShortIds?: boolean // <base>/<id> links instead of <base>/<slug>/
  publishSiteDir?: string // advanced override; default {userData}/cloudflare-pages-site
  publishProdBranch?: string // advanced override; default 'main'
  // Presentation backup (a "present from anywhere" safety net): periodically write each Talk's
  // full self-contained presenter HTML to a folder the user puts inside OneDrive/Dropbox, so a
  // forgotten laptop never blocks presenting. TalkWeaver only writes files; the sync client syncs.
  backupEnabled?: boolean
  backupFolder?: string
  backupIntervalMin?: number
  // Presenter clock amber/dark-amber thresholds (Task 3 — Settings → Timer). Whole minutes before
  // the deadline; a deck's own frontmatter `warn-at:`/`urgent-at:` overrides these per-talk.
  timerWarnAtMinutes?: number
  timerUrgentAtMinutes?: number
  // Presentation recording (ADR-0035). A run shorter than this is auto-discarded as an accidental
  // open (Settings → Recording). The R2 destination is Settings-configurable; the access keys are
  // NEVER in this file — 'settings' keys are OS-keychain-encrypted via safeStorage
  // ({userData}/recording-r2-creds.bin), 'bws' resolves them from Bitwarden Secrets at upload time.
  recordingDiscardMs?: number
  recordingR2Endpoint?: string
  recordingR2Bucket?: string
  recordingR2CredsSource?: 'bws' | 'settings'
  recordingR2BwsSecretId?: string
  // Transcription engine (Settings -> Transcription). Non-secret local paths to Dominik's
  // speech-to-text skill; defaults are expanded at runtime so config.json stays portable.
  transcriptionPython?: string
  transcriptionScript?: string
  transcriptionFfmpeg?: string
}
function configPath() {
  return join(app.getPath('userData'), 'config.json')
}
function readConfig(): Config {
  try { return JSON.parse(readFileSync(configPath(), 'utf8')) } catch { return {} }
}
function writeConfig(patch: Partial<Config>) {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify({ ...readConfig(), ...patch }, null, 2), 'utf8')
}
function getConfig<K extends keyof Config>(key: K, fallback: Config[K]): Config[K] {
  return readConfig()[key] ?? fallback
}
// Window drags fire resize/move continuously, and each writeConfig is a synchronous
// read+rewrite of config.json on the main process — jank for the whole drag. Coalesce to a
// single write after the drag settles. Callers must guard against a destroyed window.
function debouncedConfigWrite(read: () => Partial<Config>): () => void {
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try { writeConfig(read()) } catch { /* window gone mid-debounce */ }
    }, 500)
  }
}
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

// ── Cloudflare publishing: secure token storage (safeStorage / OS keychain) ──────────────────
// The API token is NEVER stored in config.json. It is encrypted with the OS keychain and written
// to its own blob; only a hasToken boolean is ever exposed to the renderer.
function tokenBlobPath(): string {
  return join(app.getPath('userData'), 'cf-pages-token.bin')
}
function tokenExists(): boolean {
  return existsSync(tokenBlobPath())
}
function readToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    if (!tokenExists()) return null
    return safeStorage.decryptString(readFileSync(tokenBlobPath()))
  } catch {
    return null
  }
}

ipcMain.handle('publish:get-config', () => ({
  accountId: getConfig('cfAccountId', undefined) ?? '',
  project: getConfig('cfPagesProject', undefined) ?? '',
  baseUrl: getConfig('publishBaseUrl', undefined) ?? '',
  useShortIds: getConfig('publishUseShortIds', false) ?? false,
  hasToken: tokenExists()
}))

ipcMain.handle(
  'publish:set-config',
  (_event, cfg: { accountId?: string; project?: string; baseUrl?: string; useShortIds?: boolean }) => {
    writeConfig({
      cfAccountId: (cfg.accountId || '').trim() || undefined,
      cfPagesProject: (cfg.project || '').trim() || undefined,
      publishBaseUrl: (cfg.baseUrl || '').trim() || undefined,
      publishUseShortIds: !!cfg.useShortIds
    })
    return { success: true }
  }
)

ipcMain.handle('publish:set-token', (_event, token: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: 'OS keychain encryption unavailable; cannot store the token securely.' }
  }
  const t = (token || '').trim()
  if (!t) return { success: false, error: 'Empty token.' }
  try {
    writeFileSync(tokenBlobPath(), safeStorage.encryptString(t))
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

ipcMain.handle('publish:clear-token', () => {
  try {
    if (tokenExists()) rmSync(tokenBlobPath())
  } catch {
    /* ignore */
  }
  return { success: true }
})

// ── Recording storage (Settings → Recording) — R2 destination + access keys ──
// Mirrors the publishing-config pattern: non-secret config in config.json; the R2 access keys go
// to their own safeStorage blob and are NEVER returned to the renderer (only a hasKeys boolean).
function r2CredsBlobPath(): string {
  return join(app.getPath('userData'), 'recording-r2-creds.bin')
}
function r2KeysExist(): boolean {
  return existsSync(r2CredsBlobPath())
}
function readR2Keys(): { accessKeyId: string; secretAccessKey: string } | null {
  try {
    if (!safeStorage.isEncryptionAvailable() || !r2KeysExist()) return null
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(r2CredsBlobPath()))) as {
      accessKeyId?: string
      secretAccessKey?: string
    }
    if (parsed.accessKeyId && parsed.secretAccessKey) {
      return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey }
    }
    return null
  } catch {
    return null
  }
}

ipcMain.handle('recording:get-storage', () => ({
  endpoint: getConfig('recordingR2Endpoint', undefined) ?? '',
  bucket: getConfig('recordingR2Bucket', undefined) ?? '',
  credsSource: getConfig('recordingR2CredsSource', 'settings') ?? 'settings',
  bwsSecretId: getConfig('recordingR2BwsSecretId', undefined) ?? '',
  discardSeconds: Math.round((getConfig('recordingDiscardMs', 20000) ?? 20000) / 1000),
  hasKeys: r2KeysExist()
}))

ipcMain.handle(
  'recording:set-storage',
  (
    _event,
    cfg: {
      endpoint?: string
      bucket?: string
      credsSource?: 'bws' | 'settings'
      bwsSecretId?: string
      discardSeconds?: number
    }
  ) => {
    writeConfig({
      recordingR2Endpoint: (cfg.endpoint || '').trim() || undefined,
      recordingR2Bucket: (cfg.bucket || '').trim() || undefined,
      recordingR2CredsSource: cfg.credsSource === 'bws' ? 'bws' : 'settings',
      recordingR2BwsSecretId: (cfg.bwsSecretId || '').trim() || undefined,
      recordingDiscardMs: Number.isFinite(cfg.discardSeconds)
        ? Math.max(0, Math.round((cfg.discardSeconds as number) * 1000))
        : undefined
    })
    return { success: true }
  }
)

ipcMain.handle('recording:set-keys', (_event, keys: { accessKeyId?: string; secretAccessKey?: string }) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return { success: false, error: 'OS keychain encryption unavailable; cannot store the keys securely.' }
  }
  const accessKeyId = (keys.accessKeyId || '').trim()
  const secretAccessKey = (keys.secretAccessKey || '').trim()
  if (!accessKeyId || !secretAccessKey) return { success: false, error: 'Both an access key id and secret are required.' }
  try {
    writeFileSync(r2CredsBlobPath(), safeStorage.encryptString(JSON.stringify({ accessKeyId, secretAccessKey })))
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})

ipcMain.handle('recording:clear-keys', () => {
  try {
    if (r2KeysExist()) rmSync(r2CredsBlobPath())
  } catch {
    /* ignore */
  }
  return { success: true }
})

// ── Transcription engine (Settings → Transcription) ─────────────────────────
// Non-secret local paths only. Runtime callers receive expanded paths; Settings also receives the
// unexpanded defaults so it can show exactly what the machine convention is.
function transcriptionSettings(): { python: string; script: string; ffmpeg: string; defaultPython: string; defaultScript: string } {
  return {
    python: getConfig('transcriptionPython', undefined) ?? DEFAULT_TRANSCRIPTION_PYTHON,
    script: getConfig('transcriptionScript', undefined) ?? DEFAULT_TRANSCRIPTION_SCRIPT,
    ffmpeg: getConfig('transcriptionFfmpeg', undefined) ?? '',
    defaultPython: DEFAULT_TRANSCRIPTION_PYTHON,
    defaultScript: DEFAULT_TRANSCRIPTION_SCRIPT
  }
}

ipcMain.handle('settings:get-transcription', () => transcriptionSettings())

ipcMain.handle('settings:set-transcription', (_event, cfg: { python?: string; script?: string; ffmpeg?: string }) => {
  writeConfig({
    transcriptionPython: (cfg.python || '').trim() || undefined,
    transcriptionScript: (cfg.script || '').trim() || undefined,
    transcriptionFfmpeg: (cfg.ffmpeg || '').trim() || undefined
  })
  return transcriptionSettings()
})

function createWindow(): BrowserWindow {
  const bounds = getConfig('windowBounds', { width: 1400, height: 900 })

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f3ea',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Cascade a second/third window so it doesn't stack exactly on the first (⌘N, two talks at once).
  if (editorWindows.size > 0) {
    const [x, y] = win.getPosition()
    const step = 32 * editorWindows.size
    win.setPosition(x + step, y + step)
  }

  win.on('resize', debouncedConfigWrite(() => {
    if (win.isDestroyed()) return {}
    const [width, height] = win.getSize()
    return { windowBounds: { width, height } }
  }))

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Track every editor window + the talk it currently has active (renderer reports via
  // window:claim-talk). Deck ⌘E/⌘R target the window whose active talk matches; mainWindow is the
  // last-focused editor window, used as the fallback target and by app:activate. Capture the
  // webContents id NOW — in 'closed' the webContents is already destroyed, so reading win.webContents
  // there throws "Object has been destroyed" and aborts app quit (this crashed ⌘Q in 0.9.11).
  const wcId = win.webContents.id
  editorWindows.set(wcId, { win, outlinePath: null })
  mainWindow = win
  win.on('focus', () => { mainWindow = win })
  win.on('closed', () => {
    editorWindows.delete(wcId)
    if (mainWindow === win) mainWindow = editorWindows.size ? [...editorWindows.values()][0].win : null
  })

  return win
}

// Editor windows and the talk each currently has active (outlinePath), so a deck's ⌘E/⌘R targets the
// RIGHT window and the same-talk guard can block opening one talk in two windows. mainWindow is the
// last-focused editor window (fallback target + activate).
const editorWindows = new Map<number, { win: BrowserWindow; outlinePath: string | null }>()
let mainWindow: BrowserWindow | null = null

// The editor window currently showing `outlinePath` (a deck's ⌘E/⌘R target), else the last-focused
// editor window, else any. Never returns a destroyed window.
function targetEditorFor(outlinePath: string | null): BrowserWindow | null {
  if (outlinePath) {
    for (const { win, outlinePath: op } of editorWindows.values()) {
      if (op === outlinePath && !win.isDestroyed()) return win
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  for (const { win } of editorWindows.values()) if (!win.isDestroyed()) return win
  return null
}

function installApplicationMenu(): void {
  const customMenus = new Map<string, MenuItemConstructorOptions[]>()
  for (const command of menuCommands()) {
    const menuName = command.menu?.path[0]
    if (!menuName) continue
    const items = customMenus.get(menuName) ?? []
    items.push({
      label: command.label,
      accelerator: commandElectronAccelerator(command),
      click: () => targetEditorFor(null)?.webContents.send('app:command', command.handlerId)
    })
    customMenus.set(menuName, items)
  }
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    ...[...customMenus].map(([label, submenu]) => ({ label, submenu })),
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Live deck windows opened by talk:present, so ⌘R (refresh-in-place) can recompile the right talk
// and reload the deck at its current slide. wcId → { outlinePath, mode }.
const presentWindows = new Map<number, { outlinePath: string; mode: string; pathwayId?: string }>()

// Bumped on every deck reload and appended as a ?_r= cache-buster: reloading to the exact same
// file:// URL + #hash is a same-document no-op in Chromium (the recompiled file never re-reads), so a
// distinct URL each time forces a real navigation that picks up the fresh HTML.
let presentReloadNonce = 0

// ⌘R in a deck window: recompile from the EDITOR's live content (so an unsaved fix is included) and
// reload the deck at its current slide. Refuses while a recording is armed (a reload would drop it).
// The actual recompile+reload happens in the present:rebuild handler after the editor hands back its
// current content — this only reads the deck's state and asks the editor for it.
async function refreshDeckFromEditor(win: BrowserWindow): Promise<void> {
  const info = presentWindows.get(win.webContents.id)
  if (!info) return
  // The recorder UI stamps its state onto #twrec-module[data-rec]; read it (+ the current slide id)
  // straight from the deck's DOM — no cross-process recorder state needed.
  let state: { slideId: string; rec: string } = { slideId: '', rec: '' }
  try {
    state = await win.webContents.executeJavaScript(
      "({ slideId: location.hash.startsWith('#') ? decodeURIComponent(location.hash.slice(1)) : '', rec: ((document.getElementById('twrec-module')||{}).dataset||{}).rec || '' })"
    )
  } catch { /* fall through with empty state — refresh from the top */ }
  if (state.rec && state.rec !== 'idle' && state.rec !== 'saved' && state.rec !== 'error') {
    win.webContents.send('present:hint', 'Stop the recording before refreshing (⇧R) — a reload would drop it.')
    return
  }
  const editor = targetEditorFor(info.outlinePath)
  if (!editor || editor.isDestroyed()) {
    win.webContents.send('present:hint', 'Open TalkWeaver to refresh this deck.')
    return
  }
  editor.webContents.send('present:refresh', { outlinePath: info.outlinePath, slideId: state.slideId, deckWcId: win.webContents.id })
}

type ToolsView = 'studio' | 'history' | 'pathways'
type PathwayWindowContext = { outlinePath: string; talkSlug: string; talkTitle: string }
let toolsWindow: BrowserWindow | null = null
let pathwayWindow: BrowserWindow | null = null
let pathwayWindowContext: PathwayWindowContext | null = null

function isToolsView(view: unknown): view is Exclude<ToolsView, 'pathways'> {
  return view === 'studio' || view === 'history'
}

function loadRenderer(win: BrowserWindow, view?: ToolsView): void {
  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (view) url.searchParams.set('view', view)
    void win.loadURL(url.toString())
  } else if (view) {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { view } })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function sendToolsShow(win: BrowserWindow, view: ToolsView, sessionId?: string, pathway?: PathwayWindowContext): void {
  const payload = { view, sessionId: sessionId || undefined, pathway }
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send('tools:show', payload)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()
}

function createToolsWindow(view: ToolsView, sessionId?: string): BrowserWindow {
  const bounds = getConfig('toolsWindowBounds', { width: 1400, height: 900 })
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 1000,
    minHeight: 680,
    title: 'TalkWeaver Tools',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f3ea',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const persistBounds = debouncedConfigWrite(() =>
    win.isDestroyed() ? {} : { toolsWindowBounds: win.getBounds() }
  )
  win.on('resize', persistBounds)
  win.on('move', persistBounds)
  win.on('closed', () => {
    if (toolsWindow === win) toolsWindow = null
  })

  toolsWindow = win
  loadRenderer(win, view)
  sendToolsShow(win, view, sessionId)
  return win
}

function openToolsWindow(view: ToolsView, sessionId?: string): void {
  const existing = toolsWindow && !toolsWindow.isDestroyed() ? toolsWindow : null
  const win = existing ?? createToolsWindow(view, sessionId)
  if (win.isMinimized()) win.restore()
  win.focus()
  if (existing) sendToolsShow(win, view, sessionId)
}

ipcMain.handle('tools:open', (_event, view: unknown, sessionId?: string) => {
  if (!isToolsView(view)) return { success: false, error: 'Unknown Tools view.' }
  openToolsWindow(view, sessionId)
  return { success: true }
})

function openPathwayWindow(context: PathwayWindowContext): void {
  const existing = pathwayWindow && !pathwayWindow.isDestroyed() ? pathwayWindow : null
  const win = existing ?? new BrowserWindow({
    ...getConfig('pathwayWindowBounds', { width: 1240, height: 820 }),
    minWidth: 960,
    minHeight: 620,
    title: 'TalkWeaver Pathways',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f3ea',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (!existing) {
    const persistBounds = debouncedConfigWrite(() =>
      win.isDestroyed() ? {} : { pathwayWindowBounds: win.getBounds() }
    )
    win.on('resize', persistBounds)
    win.on('move', persistBounds)
    win.on('focus', () => {
      if (pathwayWindowContext) notifyPathwaysChanged(pathwayWindowContext.outlinePath)
    })
    win.on('closed', () => {
      if (pathwayWindow === win) {
        pathwayWindow = null
        pathwayWindowContext = null
      }
    })
    pathwayWindow = win
    loadRenderer(win, 'pathways')
  }
  pathwayWindowContext = context
  if (win.isMinimized()) win.restore()
  win.focus()
  sendToolsShow(win, 'pathways', undefined, context)
}

function notifyPathwaysChanged(outlinePath: string): void {
  if (
    !pathwayWindow ||
    pathwayWindow.isDestroyed() ||
    pathwayWindowContext?.outlinePath !== outlinePath
  ) return
  pathwayWindow.webContents.send('pathways:changed', { outlinePath })
}

function notifyTalkMetaUpdated(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('vault:talk-meta-updated') } catch { /* window closing */ }
  }
}

ipcMain.handle('tools:open-pathways', (_event, context: PathwayWindowContext) => {
  if (!context || typeof context.outlinePath !== 'string' || typeof context.talkSlug !== 'string' || typeof context.talkTitle !== 'string') {
    return { success: false, error: 'Invalid Pathway window context.' }
  }
  openPathwayWindow(context)
  return { success: true }
})

// ── Vault IPC ──────────────────────────────────────────────────────────────

ipcMain.handle('vault:get-root', () => getConfig('vaultRoot', undefined) ?? null)

ipcMain.handle('vault:set-root', (_event, path: string) => {
  writeConfig({ vaultRoot: path })
  searchCache.clear()
  invalidateTalkCache()
  setTimeout(() => { warmSearchIndex().catch(() => {}) }, 200)
})

ipcMain.handle('vault:choose-root', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Vault Root',
    message: 'Select the folder containing your Talk folders',
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths.length) return null
  const chosen = result.filePaths[0]
  writeConfig({ vaultRoot: chosen })
  searchCache.clear()
  invalidateTalkCache()
  setTimeout(() => { warmSearchIndex().catch(() => {}) }, 200)
  return chosen
})

// ── Settings IPC (folders the app reads from) ────────────────────────────────
// The Settings panel reads these to show the configured folders and let the user change them.
// archiveDefault is always null — the archive is config-only (no hardcoded fallback).
// detectArchiveRoot is declared lower in this file; these handlers run lazily (at call time,
// after the module is fully initialised) so the forward reference is safe.
ipcMain.handle('settings:get-paths', () => {
  const c = readConfig()
  return {
    vaultRoot: c.vaultRoot ?? null,
    archiveRoot: c.archiveRoot ?? null,
    archiveDefault: null,
    archiveAvailable: detectArchiveRoot() != null
  }
})

ipcMain.handle('settings:choose-archive', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Image Archive Root',
    message: 'Select the folder containing the old-PowerPoint image archive (registry/media.db)',
    properties: ['openDirectory']
  })
  if (result.canceled || !result.filePaths.length) return null
  const chosen = result.filePaths[0]
  writeConfig({ archiveRoot: chosen })
  searchCache.clear()
  invalidateTalkCache()
  return chosen
})

ipcMain.handle('settings:clear-archive', () => {
  const c = readConfig()
  delete c.archiveRoot
  writeFileSync(configPath(), JSON.stringify(c, null, 2), 'utf8')
  searchCache.clear()
  invalidateTalkCache()
  return null
})

// ── Presentation backup ──────────────────────────────────────────────────────
// Write every Talk's full self-contained presenter HTML (presenter view + speaker notes — the same
// artifact `Present` uses, NOT the presenter-stripped share export) to a user-chosen folder on a
// timer. The folder lives inside OneDrive/Dropbox, whose own client does the cloud sync — so this
// needs no logins or APIs. Files are named `<slug>-backup.html` so they can't be mistaken for
// originals, and only changed Talks are re-written (so the sync client isn't churned).
type BackupRun = { at: number; ok: boolean; exported: number; skipped: number; failed: number; folder?: string; error?: string }
let lastBackup: BackupRun | null = null
let backingUp = false
let backupTimer: ReturnType<typeof setInterval> | null = null

function backupStateFile(): string { return join(app.getPath('userData'), 'backup-state.json') }
function loadBackupState(): Record<string, string> {
  try { return JSON.parse(readFileSync(backupStateFile(), 'utf8')) } catch { return {} }
}
function saveBackupState(state: Record<string, string>): void {
  try { writeFileSync(backupStateFile(), JSON.stringify(state), 'utf8') } catch { /* ignore */ }
}
// A change signature for a Talk: the outline bytes + the newest mtime among its LOCAL assets/ files.
// Pool assets (img-/vid-) are content-addressed (immutable), so they need no tracking.
function talkBackupSignature(outlinePath: string): string {
  let sig: string
  try { sig = createHash('sha256').update(readFileSync(outlinePath)).digest('hex') } catch { return '' }
  try {
    const assetsDir = join(dirname(outlinePath), 'assets')
    let maxM = 0
    for (const f of readdirSync(assetsDir)) { try { maxM = Math.max(maxM, statSync(join(assetsDir, f)).mtimeMs) } catch { /* skip */ } }
    sig += ':' + Math.round(maxM)
  } catch { /* no local assets dir */ }
  return sig
}
// Build a Talk's full self-contained HTML from its on-disk outline (same pipeline as present/build).
async function buildTalkFullHtml(
  outlinePath: string,
  prepareSource: (...a: unknown[]) => Promise<{ [k: string]: unknown }>
): Promise<string> {
  const stat = statSync(outlinePath)
  const slug = basename(outlinePath).replace('-outline.md', '')
  const content = readFileSync(outlinePath, 'utf8')
  const vaultRoot = getConfig('vaultRoot', undefined)
  const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content
  const model = await prepareSource(outlinePath, resolved, slug, stat, timerSettings())
  return String(model.fullHtml ?? '')
}
// One sweep: export every changed Talk to <backupFolder>/<slug>-backup.html. `force` re-exports all.
async function runBackupSweep(force = false): Promise<BackupRun> {
  if (backingUp) return lastBackup ?? { at: Date.now(), ok: false, exported: 0, skipped: 0, failed: 0, error: 'busy' }
  const folder = getConfig('backupFolder', undefined)
  const vaultRoot = getConfig('vaultRoot', undefined)
  const compilerDir = getCompilerPath()
  if (!folder) return (lastBackup = { at: Date.now(), ok: false, exported: 0, skipped: 0, failed: 0, error: 'No backup folder set' })
  if (!vaultRoot || !compilerDir) return (lastBackup = { at: Date.now(), ok: false, exported: 0, skipped: 0, failed: 0, error: 'No vault/compiler' })
  backingUp = true
  let exported = 0, skipped = 0, failed = 0
  try {
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    const state = loadBackupState()
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    for (const talk of findTalks(vaultRoot)) {
      try {
        const sig = talkBackupSignature(talk.outlinePath)
        const dest = join(folder, talk.slug + '-backup.html')
        if (!force && sig && state[talk.slug] === sig && existsSync(dest)) { skipped++; continue }
        const html = await buildTalkFullHtml(talk.outlinePath, prepareSource as never)
        if (!html) { failed++; continue }
        writeFileSync(dest, html, 'utf8')
        state[talk.slug] = sig
        exported++
      } catch (e) { failed++; console.error('[backup]', talk.slug, e) }
    }
    saveBackupState(state)
    lastBackup = { at: Date.now(), ok: failed === 0, exported, skipped, failed, folder }
  } catch (e) {
    lastBackup = { at: Date.now(), ok: false, exported, skipped, failed, error: String(e), folder }
  } finally {
    backingUp = false
  }
  try { BrowserWindow.getAllWindows()[0]?.webContents.send('backup:status', lastBackup) } catch { /* ignore */ }
  return lastBackup
}
// (Re)start the timer to match current settings. Clears any existing timer first.
function startBackupScheduler(): void {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null }
  if (!getConfig('backupEnabled', false)) return
  const min = Math.max(5, Math.round(Number(getConfig('backupIntervalMin', 15)) || 15))
  backupTimer = setInterval(() => { runBackupSweep(false).catch(() => {}) }, min * 60 * 1000)
}
function backupSettings(): { enabled: boolean; folder: string | null; intervalMin: number; lastRun: BackupRun | null } {
  return {
    enabled: getConfig('backupEnabled', false) ?? false,
    folder: getConfig('backupFolder', undefined) ?? null,
    intervalMin: getConfig('backupIntervalMin', 15) ?? 15,
    lastRun: lastBackup
  }
}

ipcMain.handle('settings:get-backup', () => backupSettings())

ipcMain.handle('settings:set-backup', (_event, patch: { enabled?: boolean; intervalMin?: number }) => {
  const next: Partial<Config> = {}
  if (typeof patch.enabled === 'boolean') next.backupEnabled = patch.enabled
  if (Number.isFinite(patch.intervalMin)) next.backupIntervalMin = Math.max(5, Math.round(patch.intervalMin as number))
  writeConfig(next)
  startBackupScheduler()
  // Turning it on (or already on) does a sweep shortly so the user sees files appear.
  if (getConfig('backupEnabled', false) && getConfig('backupFolder', undefined)) {
    setTimeout(() => { runBackupSweep(false).catch(() => {}) }, 400)
  }
  return backupSettings()
})

ipcMain.handle('settings:choose-backup-folder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose Backup Folder',
    message: 'Pick a folder inside your OneDrive/Dropbox — TalkWeaver saves presentable HTML backups there',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths.length) return backupSettings()
  writeConfig({ backupFolder: result.filePaths[0] })
  startBackupScheduler()
  if (getConfig('backupEnabled', false)) setTimeout(() => { runBackupSweep(false).catch(() => {}) }, 400)
  return backupSettings()
})

ipcMain.handle('settings:clear-backup-folder', () => {
  const c = readConfig()
  delete c.backupFolder
  writeFileSync(configPath(), JSON.stringify(c, null, 2), 'utf8')
  startBackupScheduler()
  return backupSettings()
})

// Presenter clock amber/dark-amber thresholds (Task 3): the Settings → Timer global default. A
// deck's frontmatter `warn-at:`/`urgent-at:` overrides this per-talk (resolved in the compiler).
function timerSettings(): { warnAtMinutes: number; urgentAtMinutes: number } {
  return {
    warnAtMinutes: getConfig('timerWarnAtMinutes', 5) ?? 5,
    urgentAtMinutes: getConfig('timerUrgentAtMinutes', 1) ?? 1
  }
}

ipcMain.handle('settings:get-timer', () => timerSettings())

ipcMain.handle('settings:set-timer', (_event, patch: { warnAtMinutes?: number; urgentAtMinutes?: number }) => {
  const next: Partial<Config> = {}
  if (Number.isFinite(patch.warnAtMinutes)) next.timerWarnAtMinutes = Math.max(1, Math.round(patch.warnAtMinutes as number))
  if (Number.isFinite(patch.urgentAtMinutes)) next.timerUrgentAtMinutes = Math.max(1, Math.round(patch.urgentAtMinutes as number))
  writeConfig(next)
  return timerSettings()
})

// ── Settings changelog (Gate-5) ──────────────────────────────────────────────
// Every settings change is recorded (old → new, when) in a per-machine userData JSON log, so
// a tweak the user forgot making is one click to find — and to undo via the per-entry Reset
// in Settings → Changes. Values only, never secrets (the renderer logs those as presence).
type SettingsChangeEntry = { at: number; key: string; label: string; from: string; to: string }
function settingsChangelogFile(): string { return join(app.getPath('userData'), 'settings-changelog.json') }
function readSettingsChangelog(): SettingsChangeEntry[] {
  try {
    const raw = JSON.parse(readFileSync(settingsChangelogFile(), 'utf8'))
    return Array.isArray(raw) ? (raw as SettingsChangeEntry[]) : []
  } catch { return [] }
}
ipcMain.handle('settings:changelog-get', () => readSettingsChangelog())
ipcMain.handle('settings:changelog-log', (_event, entry: { key: string; label: string; from: string; to: string }) => {
  if (
    typeof entry?.key !== 'string' || typeof entry?.label !== 'string' ||
    typeof entry?.from !== 'string' || typeof entry?.to !== 'string'
  ) return readSettingsChangelog()
  const list = readSettingsChangelog()
  list.unshift({ at: Date.now(), key: entry.key, label: entry.label, from: entry.from, to: entry.to })
  const trimmed = list.slice(0, 200) // a per-machine audit trail, not an archive
  try { writeFileSync(settingsChangelogFile(), JSON.stringify(trimmed, null, 2), 'utf8') } catch { /* log-only */ }
  return trimmed
})

// Manual "Back up now" — force-exports every Talk regardless of change signature.
ipcMain.handle('backup:run-now', async () => runBackupSweep(true))

// ── Talk discovery ─────────────────────────────────────────────────────────

interface TalkInfo {
  name: string
  path: string
  outlinePath: string
  title: string
  slug: string
}

// findTalks is a full synchronous vault walk (statSync per entry). It used to run per search
// keystroke, per sidebar meta refresh, and — via talkBySlug in the twpresent:// protocol
// handler — per Studio replay asset request. Cache the walk briefly; every vault-mutating IPC
// (create/clone/move/rename/delete, set-root) calls invalidateTalkCache() so the sidebar never
// sees a stale list after its own operation.
let talkCache: { root: string; at: number; talks: TalkInfo[] } | null = null
// productName is TalkWeaver, so this resolves to ~/Library/Application Support/TalkWeaver/.
const vaultIndex = createVaultListHandler({
  cachePath: join(app.getPath('userData'), 'vault-index.json'),
  log: (message: string) => console.log(message)
})
const TALK_CACHE_TTL_MS = 5_000
function invalidateTalkCache(): void {
  talkCache = null
  vaultIndex.invalidate()
  // The metadata doctor/vocabulary scans walk the same outlines — a vault mutation staleness
  // window there would show phantom unregistered keys. Declared below (ADR-0036 section);
  // only ever called at runtime, so the later `let` cache binding is initialised by then.
  invalidateMetadataCaches()
}

function findTalks(root: string): TalkInfo[] {
  if (talkCache && talkCache.root === root && Date.now() - talkCache.at < TALK_CACHE_TTL_MS) {
    return talkCache.talks
  }
  const talks = scanTalks(root)
  talkCache = { root, at: Date.now(), talks }
  return talks
}

// Sidebar-facing frontmatter fields, parsed from an outline's HEAD (first ~2KB) and cached by
// mtime — so the 5s-cached vault walk pays one small read per outline only when it changed.
// Shared by scanTalks (real titles at the root) and vault:talk-meta (subtitle/event).
type OutlineFrontmatter = { title: string | null; subtitle: string | null; event: string | null }
const frontmatterCache = new Map<string, { mtimeMs: number; fm: OutlineFrontmatter }>()
function outlineFrontmatter(outlinePath: string, mtimeMs: number): OutlineFrontmatter {
  const cached = frontmatterCache.get(outlinePath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.fm
  const fm: OutlineFrontmatter = { title: null, subtitle: null, event: null }
  try {
    const fd = openSync(outlinePath, 'r')
    const buf = Buffer.alloc(2048)
    const n = readSync(fd, buf, 0, 2048, 0)
    closeSync(fd)
    const head = buf.subarray(0, n).toString('utf8')
    if (head.startsWith('---')) {
      const end = head.indexOf('\n---', 3)
      const block = end === -1 ? head.slice(3) : head.slice(3, end)
      for (const key of ['title', 'subtitle', 'event'] as const) {
        const m = block.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))
        if (m) {
          const v = m[1].trim().replace(/^["']|["']$/g, '').trim()
          if (v) fm[key] = v
        }
      }
    }
  } catch {
    // An unreadable head falls back to the slug-derived title — never fail the scan.
  }
  frontmatterCache.set(outlinePath, { mtimeMs, fm })
  return fm
}

function scanTalks(root: string): TalkInfo[] {
  const talks: TalkInfo[] = []

  function scanDir(dir: string, depth = 0) {
    if (depth > 3) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    // Find outline files in this directory
    const outlines = entries.filter(
      (e) => e.endsWith('-outline.md') && statSync(join(dir, e)).isFile()
    )
    if (outlines.length > 0) {
      const outlineName = outlines[0]
      const outlinePath = join(dir, outlineName)
      const slug = outlineName.replace('-outline.md', '')
      // The REAL title lives in the outline's frontmatter; the slug-derived title-case form is
      // only the fallback (it capitalises every word and loses punctuation — live finding, 0.14.0).
      const fallback = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      let title = fallback
      try {
        title = outlineFrontmatter(outlinePath, statSync(outlinePath).mtimeMs).title ?? fallback
      } catch {
        // stat raced a rename/delete — the fallback title still lists the talk.
      }
      talks.push({ name: slug, path: dir, outlinePath, title, slug })
      return // don't recurse into Talk folders
    }

    // Recurse into subdirectories (`_`-prefixed = system areas: _assets, _SLIDE-VERSIONS)
    for (const entry of entries) {
      if (entry.startsWith('.') || entry.startsWith('_') || entry === 'node_modules') continue
      const full = join(dir, entry)
      try {
        if (statSync(full).isDirectory()) scanDir(full, depth + 1)
      } catch {
        // skip inaccessible
      }
    }
  }

  if (existsSync(root)) scanDir(root)
  return talks.sort((a, b) => a.title.localeCompare(b.title))
}

ipcMain.handle('vault:list-talks', async (event) => {
  const root = getConfig('vaultRoot', undefined) ?? null
  if (!root) return []
  const cached = await vaultIndex.handle(root, (batch, reset, done) => {
    if (!event.sender.isDestroyed()) event.sender.send('vault:talks-batch', { batch, reset, done })
  })
  void vaultIndex.refreshDone().then((talks) => {
    talkCache = { root, at: Date.now(), talks }
  }).catch((error) => console.error('[vault-index]', error))
  return cached
})

// Warning types an author must act on (mirrors the renderer's SURFACED_WARNINGS filter —
// hints like icon-suggested would make every talk look broken).
const SURFACED_WARNING_TYPES = new Set(['iconlist-no-icons'])
function surfacedWarningCount(rows: ProjectionRowMain[]): number {
  let n = 0
  for (const r of rows) {
    const ws = Array.isArray(r.warnings) ? (r.warnings as unknown[]) : []
    if (ws.some((w) => SURFACED_WARNING_TYPES.has(String(w).split(':')[0]))) n += 1
  }
  return n
}

ipcMain.handle('vault:talk-meta', async () => {
  try {
    const root = getConfig('vaultRoot', undefined) ?? null
    if (!root) return {}
    const persisted = await vaultIndex.metadata(root)
    const out: Record<string, {
      slideCount: number | null
      createdMs: number
      editedMs: number
      // First slide's thumb-cache key → the talk's cover (twthumb://slug/coverKey); null until indexed.
      coverKey: string | null
      // Slides with actionable compiler warnings (0 until indexed).
      warningCount: number
      // Frontmatter context lines (mtime-cached parse shared with scanTalks); null when absent.
      subtitle: string | null
      event: string | null
      pathwayCount: number
      pathwayNames: string[]
    }> = {}
    for (const talk of await vaultIndex.cached(root)) {
      const cached = searchCache.get(talk.outlinePath)
      const first = cached?.rows?.[0] as (ProjectionRowMain & { render_hash?: string }) | undefined
      const meta = persisted[talk.slug]
      const pathwaySummary = readPathwaySummary(root, talk.slug)
      out[talk.slug] = {
        slideCount: cached ? cached.rows.length : null,
        createdMs: meta?.createdMs ?? 0,
        editedMs: meta?.editedMs ?? 0,
        coverKey: first ? (first.render_hash || first.content_hash || first.slide_id || null) : null,
        warningCount: cached ? surfacedWarningCount(cached.rows) : 0,
        subtitle: meta?.subtitle ?? null,
        event: meta?.event ?? null,
        pathwayCount: pathwaySummary.count,
        pathwayNames: pathwaySummary.names
      }
    }
    return out
  } catch {
    return {}
  }
})

// ── Compiler ───────────────────────────────────────────────────────────────

// The compiler ships INSIDE the app (compiler/scripts) — rendering never depends on an external
// repo. Dev loads it from the project root; a packaged build loads the copy electron-builder placed
// in Resources/ (see build.extraResources). asar is off, so dynamic import() of these on-disk ESM
// modules works in both. The mirrored layout (compiler/scripts + sibling compiler/{reference,assets})
// keeps the compiler's scriptDir-relative asset reads and every join(compilerDir, '..', ...) valid.
function getCompilerPath(): string {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'compiler', 'scripts')
    : join(app.getAppPath(), 'compiler', 'scripts')
  if (!existsSync(join(dir, 'lib/08-source-adapters.mjs'))) {
    console.error(
      '[talk-weaver] Bundled compiler missing at ' +
        dir +
        ' — build is broken (compiler/ not vendored, or extraResources not configured).'
    )
  }
  return dir
}

// ── Slide Ledger (ADR-0032) ─────────────────────────────────────────────────
// Every ledger call is wrapped: a ledger failure must NEVER make a save return false
// or block present/export/publish.
async function ledgerLib(): Promise<any | null> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  return import(pathToFileURL(join(compilerDir, 'lib/13-slide-ledger.mjs')).href)
}

async function ledgerRecord(outlinePath: string, content: string): Promise<string[]> {
  try {
    const vaultRoot = getConfig('vaultRoot', undefined)
    const lib = await ledgerLib()
    if (!vaultRoot || !lib) return []
    return lib.recordOutlineSave(vaultRoot, outlinePath, content, { now: Date.now() }).collisions
  } catch { return [] }
}

async function ledgerSeal(outlinePath: string, content: string, reason: string): Promise<void> {
  try {
    const vaultRoot = getConfig('vaultRoot', undefined)
    const lib = await ledgerLib()
    if (vaultRoot && lib) lib.sealOutline(vaultRoot, outlinePath, content, reason, { now: Date.now() })
  } catch { /* sealing must never break present/export/publish */ }
}

// Thumbnail cache dir name that AUTO-BUSTS when the compiler/renderer/template changes. render_hash
// keys thumbnails by the slide MODEL, so a pure renderer or CSS edit (which leaves the model
// unchanged) would otherwise serve a stale image. Hashing the key compiler files into the dir name
// forces fresh thumbnails on any such change. Computed once per session.
let thumbCacheTag: string | null = null
function thumbCacheRoot(): string {
  if (thumbCacheTag) return thumbCacheTag
  const dir = getCompilerPath()
  let tag = 'base'
  if (dir) {
    try {
      // Hash EVERY compiler lib file (not a cherry-picked subset) + the template, so ANY rendering
      // change — lexer, triggers, adapters, renderers, assembly, projections — busts the cache. A
      // hand-picked list once omitted 03-markdown-lexer.mjs, so a lexer fix left stale thumbnails.
      const libDir = join(dir, 'lib')
      const files = readdirSync(libDir)
        .filter((f) => f.endsWith('.mjs'))
        .sort()
        .map((f) => join(libDir, f))
      files.push(join(dir, '..', 'assets', 'templates', 'presenter-popup-single-html.html'))
      const h = createHash('sha256')
      for (const f of files) if (existsSync(f)) h.update(readFileSync(f))
      tag = h.digest('hex').slice(0, 8)
    } catch {
      tag = 'base'
    }
  }
  // v8: bumped so imported talks (relative-path / URL-encoded image refs) re-render their strip
  // thumbnails from scratch — earlier blank captures for those slides were stale-cached.
  thumbCacheTag = 'thumb-cache-v8-' + tag
  seedThumbCacheFromPriorTag(thumbCacheTag)
  return thumbCacheTag
}

// When the compiler changes, thumbCacheRoot()'s hash changes and the cache dir name changes —
// which would otherwise force a full re-render of EVERY slide's thumbnail (thousands), leaving the
// slide picker blank until the rebuild finishes. But thumbnails are content-addressed by
// render_hash (the filename), so a thumbnail from a prior tag is still correct for any slide whose
// MODEL is unchanged. So, once per session, seed the new tag by hardlinking the most-recent prior
// tag's PNGs in: unchanged slides reuse their existing thumbnail instantly, and only slides whose
// render_hash actually changed re-render. (A pure CSS/renderer change that alters pixels WITHOUT
// changing the model is the one case this can leave a thumbnail visually stale — use the
// `talk:clear-thumb-cache` escape hatch then.)
let thumbSeedDone = false
function seedThumbCacheFromPriorTag(currentTag: string): void {
  if (thumbSeedDone) return
  thumbSeedDone = true
  try {
    const base = app.getPath('userData')
    const priors = readdirSync(base)
      .filter((d) => d.startsWith('thumb-cache-v8-') && d !== currentTag && statSync(join(base, d)).isDirectory())
      .map((d) => ({ d, m: statSync(join(base, d)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    if (priors.length === 0) return
    hardlinkPngTree(join(base, priors[0].d), join(base, currentTag))
  } catch (e) {
    console.warn('[thumb-seed] skipped:', e)
  }
}

// Recursively hardlink every *.png from srcDir into dstDir, never overwriting a file already there
// (so thumbnails re-rendered this session win). Falls back to a copy if hardlinking fails
// (e.g. cross-device). Content-addressed filenames make a reused PNG safe to serve.
function hardlinkPngTree(srcDir: string, dstDir: string): void {
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const s = join(srcDir, entry.name)
    const d = join(dstDir, entry.name)
    if (entry.isDirectory()) hardlinkPngTree(s, d)
    else if (entry.name.endsWith('.png') && !existsSync(d)) {
      try {
        linkSync(s, d)
      } catch {
        try {
          copyFileSync(s, d)
        } catch {
          /* skip a single unreadable file rather than abort the whole seed */
        }
      }
    }
  }
}

// ── Image pre-resolution (ADR-0020) ──────────────────────────────────────────
// Rewrite markdown image refs that point at a vault asset id (img-XXXXXXX) to the
// ABSOLUTE on-disk path of the matching file in {vaultRoot}/_assets. The compiler's
// inlineAndCollectAssets then base64-embeds them into compiled/presented/built output.
// Refs whose asset file does not exist are left untouched.
// Also tolerates the legacy double-prefixed id (img-img-XXXXXXX) that an earlier import bug
// wrote, normalising it to the real asset id so existing outlines still embed correctly.
// Matches both image (img-) and video (vid-) pool refs. Trailing media tokens ({loop} etc.) sit
// OUTSIDE the parens, so they survive the replacement untouched and reach the compiler's lexer.
const IMAGE_REF_RE = /!\[([^\]]*)\]\((img-(?:img-)?[0-9a-f]{7}|vid-[0-9a-f]{7})\)/g
const ASSET_EXTS = ['webp', 'png', 'jpg', 'jpeg', 'gif']
const VIDEO_ASSET_EXTS = ['mp4', 'mov', 'm4v', 'webm']
function resolveImageRefs(content: string, vaultRoot: string): string {
  if (!vaultRoot) return content
  const assetsDir = join(vaultRoot, '_assets')
  return content.replace(IMAGE_REF_RE, (whole, alt: string, rawId: string) => {
    const id = rawId.replace(/^img-img-/, 'img-')
    // vid- → the pool video file; the compiler emits <video> off the .mp4 extension and finds the
    // sibling vid-<id>.jpg poster automatically. img- → the image file as before.
    const exts = id.startsWith('vid-') ? VIDEO_ASSET_EXTS : ASSET_EXTS
    for (const ext of exts) {
      const p = join(assetsDir, id + '.' + ext)
      if (existsSync(p)) return `![${alt}](${p})`
    }
    return whole
  })
}

// Blank Layout templates (ADR-0021): the single source lives beside the Reference Deck fixtures
// in html-presentations (reference/layout-templates.mjs). The picker imports these so ⌘-Enter
// inserts a scaffold and Space previews it. Cached after first load.
let layoutTemplatesCache: { templates: Record<string, string>; aliases: Record<string, string> } | null = null
ipcMain.handle('layout:templates', async () => {
  if (layoutTemplatesCache) return layoutTemplatesCache
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const url = pathToFileURL(join(compilerDir, '..', 'reference', 'layout-templates.mjs')).href
    const mod = await import(url)
    layoutTemplatesCache = {
      templates: (mod.LAYOUT_TEMPLATES ?? {}) as Record<string, string>,
      aliases: (mod.ALIASES ?? {}) as Record<string, string>
    }
    return layoutTemplatesCache
  } catch (e) {
    console.warn('[talk-weaver] layout:templates failed', e)
    return null
  }
})

// Layout preview thumbnails (Feature #3): render ONE real compiled slide per layout from the
// engine's canonical Reference fixtures, so the "/" picker shows a true render instead of a
// hand-drawn placeholder — and the preview can never drift from the compiler. The engine owns the
// fixtures (reference/fixtures.mjs), the outline assembly (reference/reference-outline.mjs) and the
// picker-name → fixture-id map (reference/layout-fixture-map.mjs); we compile that ONE outline via
// the live pipeline (exactly like talk:compile) and render each fixture's slide through the same
// offscreen renderThumbnails path as talk:thumbnails. Cached on disk under a version derived from
// the fixtures so a fixture change invalidates stale PNGs, and in-process so the picker pays the
// render cost at most once per session. Returns { layoutName: twthumb://… } or null on error.
// The picker's layout names (mirrors renderer data/layouts.ts; the engine's layoutFixtureMap
// resolves each to its Reference fixture id, omitting any that has no fixture). Kept here so the
// main process need not import the renderer bundle.
const LAYOUT_PREVIEW_NAMES = [
  'statement', 'list', 'iconlist', 'numbered', 'quote', 'contrast-cards', 'annotated', 'sidebar',
  'media', 'contrast', 'copy-visual', 'cards', 'title', 'section', 'subsection', 'closing',
  'timeline', 'timelinevertical', 'timelinehorizontal', 'timelinespine', 'timeline-pills', 'grid',
  'system-map', 'smartart', 'flow', 'image-claim', 'cta-screenshots', 'trace', 'trace-dialogue',
  'code', 'table', 'qr', 'action', 'embed', 'auto-embed', 'logolist', 'image-quote', 'image-grid',
  'barchart', 'piechart', 'linechart', 'sigmoid', 'timetable', 'table-outline', 'columns', 'pyramid',
  'orgchart', 'mindmap', 'conceptmap', 'stats', 'process', 'steps', 'iconrow', 'cycle', 'equation',
  'reveal', 'group', 'focus', 'trigger-line', 'countdown'
]
let layoutPreviewThumbsCache: Record<string, string> | null = null
ipcMain.handle('layout:preview-thumbnails', async () => {
  if (layoutPreviewThumbsCache) return layoutPreviewThumbsCache
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const refDir = join(compilerDir, '..', 'reference')
    const { fixtures } = await import(pathToFileURL(join(refDir, 'fixtures.mjs')).href)
    const { buildReferenceOutline } = await import(pathToFileURL(join(refDir, 'reference-outline.mjs')).href)
    const { layoutFixtureMap } = await import(pathToFileURL(join(refDir, 'layout-fixture-map.mjs')).href)
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)

    const slug = 'reference-deck'
    const outline = buildReferenceOutline() as string
    // Write the outline to a real temp dir with the fixtures' assets copied alongside as assets/,
    // so the image/media fixtures' relative refs (assets/two-box.svg) inline exactly as in the
    // Reference Deck build — the renders are then true, not blank. prepareSource resolves relative
    // assets against dirname(sourcePath).
    const refWork = join(tmpdir(), `tw-layout-preview-${randomBytes(6).toString('hex')}`)
    mkdirSync(join(refWork, 'assets'), { recursive: true })
    const fixturesAssets = join(refDir, 'fixtures-assets')
    if (existsSync(fixturesAssets)) {
      cpSync(fixturesAssets, join(refWork, 'assets'), { recursive: true })
    }
    const outlinePath = join(refWork, `${slug}-outline.md`)
    writeFileSync(outlinePath, outline, 'utf8')
    const stat = statSync(outlinePath)
    const model = await prepareSource(outlinePath, outline, slug, stat)
    const rows = (buildPerSlideProjections(model, slug) ?? []) as Array<{
      slide_id?: string
      render_hash?: string
      content_hash?: string
      layout?: string
      triggers?: Record<string, string>
    }>

    // Render every slide (in deck order) keyed by render_hash, reusing the offscreen path. The
    // cache slug folds in a fixtures-derived version so editing a fixture re-renders, never serves
    // a stale picture; old version folders are simply left unused (harmless, tiny PNGs).
    const buildMap = (layoutFixtureMap as (names: string[]) => Record<string, string>)(LAYOUT_PREVIEW_NAMES)
    const version = createHash('sha256')
      .update(
        JSON.stringify(
          (fixtures as Array<{ id: string; markdown: string }>).map((f) => [f.id, f.markdown])
        )
      )
      .digest('hex')
      .slice(0, 12)
    const cacheSlug = `__layout-preview__-${version}`
    const slides = rows
      .map((r) => ({ key: r.render_hash || r.content_hash || r.slide_id || '', layout: r.triggers?.layout ?? r.layout }))
      .filter((s) => s.key)
    const cacheDir = join(app.getPath('userData'), thumbCacheRoot(), cacheSlug)
    await renderThumbnails({ fullHtml: model.fullHtml as string, slides, cacheDir })

    // fixture id → its slide's render_hash (the cache key). Structural section/subsection dividers
    // render to `<id>-title`, so accept that fallback exactly like the Reference Deck builder.
    const keyByFixtureId: Record<string, string> = {}
    for (const r of rows) {
      const id = r.slide_id || ''
      const key = r.render_hash || r.content_hash || ''
      if (id && key) keyByFixtureId[id] = key
    }
    const out: Record<string, string> = {}
    for (const [layoutName, fixtureId] of Object.entries(buildMap)) {
      const key = keyByFixtureId[fixtureId] || keyByFixtureId[`${fixtureId}-title`]
      if (key) out[layoutName] = 'twthumb://' + cacheSlug + '/' + key
    }
    layoutPreviewThumbsCache = out
    return out
  } catch (e) {
    console.error('[layout:preview-thumbnails]', e)
    return null
  }
})

// Icon vocabulary (ADR-0021 icon picker): the engine's 05-icons.mjs owns the Lucide + SVGL
// brand sets and renders glyphs deterministically. Cache the imported module so per-keystroke
// search and per-result svg() don't re-import it. Invalidated when getCompilerPath() changes.
type IconsModule = {
  searchIcons: (q: string, n?: number) => Array<{ key: string; source: string }>
  iconSvg: (key: string) => string
}
let iconsModuleCache: { dir: string; mod: IconsModule } | null = null
async function loadIconsModule(): Promise<IconsModule | null> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  if (iconsModuleCache && iconsModuleCache.dir === compilerDir) return iconsModuleCache.mod
  const url = pathToFileURL(join(compilerDir, 'lib/05-icons.mjs')).href
  const mod = (await import(url)) as IconsModule
  iconsModuleCache = { dir: compilerDir, mod }
  return mod
}

ipcMain.handle('icons:search', async (_event, query: string) => {
  try {
    const mod = await loadIconsModule()
    if (!mod) return []
    const hits = mod.searchIcons(query ?? '', 40) ?? []
    // Narrow source to the picker's union; the engine only ever emits 'lucide' | 'svgl' here.
    return hits.map((h) => ({ key: h.key, source: h.source as 'lucide' | 'svgl' }))
  } catch (e) {
    console.error('[icons:search]', e)
    return []
  }
})

ipcMain.handle('icons:svg', async (_event, key: string) => {
  try {
    const mod = await loadIconsModule()
    if (!mod) return null
    const svg = mod.iconSvg(key ?? '')
    return svg || null
  } catch (e) {
    console.error('[icons:svg]', e)
    return null
  }
})

// Prepared-model memo: talk:compile and talk:thumbnails fire back-to-back on the SAME
// (outlinePath, content) after every edit-pause debounce, and each prepareSource pass walks and
// inlines the whole deck. The key fully identifies the preparation inputs, so a hit cannot become
// stale with time. Keep the six most-recently-used path/default/content combinations; edits mint
// new keys and evict old-content entries while buildPerSlideProjections remains shared and pure.
interface PreparedTalk {
  at: number
  slug: string
  model: { fullHtml?: unknown; [k: string]: unknown }
  rows: Array<{ [k: string]: unknown }> | null
}
const preparedTalkCache = new Map<string, PreparedTalk>()
const PREPARED_TALK_MAX_ENTRIES = 6

async function prepareTalk(
  outlinePath: string,
  content: string,
  defaults?: Record<string, unknown>
): Promise<PreparedTalk | null> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  const stat = statSync(outlinePath)
  const slug = basename(outlinePath).replace('-outline.md', '')
  const vaultRoot = getConfig('vaultRoot', undefined)
  const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content
  const key =
    outlinePath +
    ' ' +
    JSON.stringify(defaults ?? null) +
    ' ' +
    createHash('sha256').update(resolved).digest('hex')
  const hit = preparedTalkCache.get(key)
  if (hit) {
    hit.at = Date.now()
    preparedTalkCache.delete(key)
    preparedTalkCache.set(key, hit)
    return hit
  }
  if (process.env.TW_REC_TEST === '1') {
    const testGlobal = globalThis as typeof globalThis & { __twPrepareCount?: number }
    testGlobal.__twPrepareCount = (testGlobal.__twPrepareCount ?? 0) + 1
  }
  const { prepareSource } = await import(
    pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href
  )
  const { buildPerSlideProjections } = await import(
    pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href
  )
  const model = await prepareSource(outlinePath, resolved, slug, stat, defaults)
  const rows = buildPerSlideProjections(model, slug) ?? null
  const entry: PreparedTalk = { at: Date.now(), slug, model, rows }
  preparedTalkCache.delete(key)
  preparedTalkCache.set(key, entry)
  for (const cachedKey of preparedTalkCache.keys()) {
    if (preparedTalkCache.size <= PREPARED_TALK_MAX_ENTRIES) break
    preparedTalkCache.delete(cachedKey)
  }
  return entry
}

async function pathwaySnapshot(outlinePath: string, content: string) {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) throw new Error('Choose a Vault before managing pathways.')
  const prepared = await prepareTalk(outlinePath, content)
  if (!prepared?.rows) throw new Error('The outline could not be compiled.')
  const manifest = readPathwayManifest(vaultRoot, prepared.slug)
  const slides = prepared.rows as PathwaySlideRow[]
  return { slides, pathways: resolvePathways(manifest.pathways, slides), manifest }
}

ipcMain.handle('pathways:read', async (_event, outlinePath: string, content: string) => {
  try {
    const { slides, pathways } = await pathwaySnapshot(outlinePath, content)
    return { slides, pathways }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

async function mutatePathways(
  outlinePath: string,
  content: string,
  mutation: (text: string) => string
) {
  const before = await pathwaySnapshot(outlinePath, content)
  const text = mutation(before.manifest.text)
  writePathwayManifest(before.manifest.path, text)
  const vaultRoot = getConfig('vaultRoot', undefined) as string
  const talkSlug = basename(dirname(before.manifest.path))
  invalidatePathwaySummary(vaultRoot, talkSlug)
  notifyPathwaysChanged(outlinePath)
  notifyTalkMetaUpdated()
  const pathways = resolvePathways(readPathwayManifest(
    vaultRoot,
    talkSlug
  ).pathways, before.slides)
  return { slides: before.slides, pathways }
}

ipcMain.handle('pathways:create', async (_event, outlinePath: string, content: string, name: string, note?: string) => {
  try {
    const id = 'path-' + randomBytes(6).toString('hex')
    return await mutatePathways(outlinePath, content, (text) => createPathwayInManifest(text, {
      id,
      name: String(name || '').trim(),
      ...(String(note || '').trim() ? { note: String(note).trim() } : {}),
      slideIds: []
    }))
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('pathways:rename', async (_event, outlinePath: string, content: string, id: string, name: string) => {
  try {
    return await mutatePathways(outlinePath, content, (text) => renamePathwayInManifest(text, String(id), String(name)))
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('pathways:delete', async (_event, outlinePath: string, content: string, id: string) => {
  try {
    return await mutatePathways(outlinePath, content, (text) => deletePathwayInManifest(text, String(id)))
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('pathways:set-slide-ids', async (_event, outlinePath: string, content: string, id: string, slideIds: string[]) => {
  try {
    return await mutatePathways(outlinePath, content, (text) =>
      setPathwaySlideIdsInManifest(text, String(id), Array.isArray(slideIds) ? slideIds.map(String) : [])
    )
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

function previewDocument(outlinePath: string, content: string, fullHtml: string): { id: string; html: string } {
  const id = createHash('sha256').update(outlinePath).update('\0').update(content).digest('hex').slice(0, 24)
  const html = markSlidePreviewHtml(fullHtml)
  slidePreviewStore.set(id, html)
  return { id, html }
}

function thumbnailDocumentId(html: string): string {
  return createHash('sha256').update(markSlidePreviewHtml(html)).digest('hex').slice(0, 16)
}

ipcMain.handle('talk:compile', async (_event, outlinePath: string, content: string) => {
  try {
    const prepared = await prepareTalk(outlinePath, content)
    return prepared?.rows ?? null
  } catch (e) {
    console.error('[compile]', e)
    return null
  }
})

// Inspector + Slide Focus compile the SAME full live outline as Present and thumbnails. The
// content-addressed URL is stable across slide navigation; the renderer changes only its hash.
ipcMain.handle('slide:render-preview', async (_event, outlinePath: string, outlineContent: string) => {
  try {
    const prepared = await prepareTalk(outlinePath, outlineContent)
    const fullHtml = prepared?.model.fullHtml
    if (typeof fullHtml !== 'string') return null
    return slidePreviewUrl(previewDocument(outlinePath, outlineContent, fullHtml).id)
  } catch (e) {
    console.error('[slide:render-preview]', e)
    return null
  }
})

// ── Embed preflight ("Check embeds") ─────────────────────────────────────────
// Reports, per embed, whether it will actually DISPLAY when presenting — catching
// embedding-disabled YouTube videos (the "Video unavailable" case), private/deleted
// videos, and sites that refuse framing. See docs/superpowers/specs/2026-06-30-embed-preflight.
type EmbedStatusKind = 'youtube' | 'vimeo' | 'site'
type EmbedStatusState =
  | 'ok' | 'embedding-disabled' | 'not-found' | 'refuses-framing' | 'unreachable' | 'unknown'
interface EmbedStatus {
  slideId: string
  title: string
  url: string
  kind: EmbedStatusKind
  status: EmbedStatusState
  detail: string
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

// Every embed compiles to `<iframe data-src="URL" …>` inside its slide `<section data-id…>`.
// Local inlined sims use `srcdoc` (no data-src) and always work, so they are skipped here —
// this preflight is only about embeds that load over the network.
function extractDeckEmbeds(html: string): Array<{ slideId: string; title: string; url: string; isVideo: boolean }> {
  const out: Array<{ slideId: string; title: string; url: string; isVideo: boolean }> = []
  const sectionRe = /<section class="slide"([^>]*)>([\s\S]*?)<\/section>/g
  let m: RegExpExecArray | null
  while ((m = sectionRe.exec(html))) {
    const attrs = m[1]
    const slideId = (attrs.match(/data-id="([^"]*)"/) || [])[1] || ''
    const title = decodeHtmlEntities((attrs.match(/data-nav-title="([^"]*)"/) || [])[1] || slideId)
    const iframeRe = /<iframe\b([^>]*)>/g
    let f: RegExpExecArray | null
    while ((f = iframeRe.exec(m[2]))) {
      const src = (f[1].match(/data-src="([^"]*)"/) || [])[1]
      if (!src || !/^https?:/i.test(decodeHtmlEntities(src))) continue
      out.push({ slideId, title, url: decodeHtmlEntities(src), isVideo: /\bdata-embed-video\b/.test(f[1]) })
    }
  }
  return out
}

function classifyEmbed(url: string): EmbedStatusKind {
  if (/(?:^|\.)youtube(?:-nocookie)?\.com|youtu\.be/i.test(url)) return 'youtube'
  if (/(?:^|\.)vimeo\.com/i.test(url)) return 'vimeo'
  return 'site'
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function checkEmbedUrl(
  url: string,
  parseVideoEmbed: (s: string) => { id: string } | null
): Promise<{ status: EmbedStatusState; detail: string; kind: EmbedStatusKind }> {
  const kind = classifyEmbed(url)
  try {
    if (kind === 'youtube') {
      const v = parseVideoEmbed(url)
      const watch = v ? `https://www.youtube.com/watch?v=${v.id}` : url
      const res = await fetchWithTimeout(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, {}, 6000)
      if (res.ok) return { kind, status: 'ok', detail: 'Embeddable' }
      if (res.status === 401) return { kind, status: 'embedding-disabled', detail: 'Embedding disabled or video is private' }
      // YouTube oEmbed answers 404 for a deleted video and 400 for an unknown/invalid id — both
      // mean the embed will show "Video unavailable".
      if (res.status === 404 || res.status === 400) return { kind, status: 'not-found', detail: 'Video not found, deleted, or unavailable' }
      return { kind, status: 'unknown', detail: `YouTube oEmbed returned HTTP ${res.status}` }
    }
    if (kind === 'vimeo') {
      const res = await fetchWithTimeout(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`, {}, 6000)
      if (res.ok) return { kind, status: 'ok', detail: 'Embeddable' }
      if (res.status === 403) return { kind, status: 'embedding-disabled', detail: 'Embedding restricted by the owner' }
      if (res.status === 404) return { kind, status: 'not-found', detail: 'Video not found' }
      return { kind, status: 'unknown', detail: `Vimeo oEmbed returned HTTP ${res.status}` }
    }
    // Arbitrary site: predict framing from X-Frame-Options and CSP frame-ancestors.
    const res = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow' }, 6000)
    const xfo = (res.headers.get('x-frame-options') || '').toLowerCase()
    const csp = (res.headers.get('content-security-policy') || '').toLowerCase()
    const frameAncestors = (csp.match(/frame-ancestors([^;]*)/) || [])[1]?.trim() || ''
    // A frame-ancestors directive that does NOT include a wildcard will refuse our (file://-ish,
    // never-allowlisted) presentation origin. X-Frame-Options DENY/SAMEORIGIN refuses outright.
    const xfoRefuses = xfo.includes('deny') || xfo.includes('sameorigin')
    // A frame-ancestors directive with no wildcard (incl. 'none' or a specific host allowlist like
    // Canvas's) will not include our presentation origin, so framing is refused.
    const cspRefuses = frameAncestors !== '' && !frameAncestors.includes('*')
    if (xfoRefuses) return { kind, status: 'refuses-framing', detail: `X-Frame-Options: ${xfo}` }
    if (cspRefuses) return { kind, status: 'refuses-framing', detail: `CSP frame-ancestors ${frameAncestors}` }
    return { kind, status: 'ok', detail: 'Frames OK (no blocking header)' }
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError'
    return { kind, status: 'unreachable', detail: aborted ? 'Timed out' : 'Unreachable' }
  }
}

ipcMain.handle('talk:check-embeds', async (_event, outlinePath: string, content: string): Promise<EmbedStatus[]> => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return []
  try {
    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { parseVideoEmbed } = await import(pathToFileURL(join(compilerDir, 'lib/02-triggers-layout.mjs')).href)
    const vaultRoot = getConfig('vaultRoot', undefined)
    const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content
    const model = await prepareSource(outlinePath, resolved, slug, stat)
    const embeds = extractDeckEmbeds(model.fullHtml || '')
    if (!embeds.length) return []
    // Check each unique URL once, then map the result back to every slide that uses it.
    const uniqueUrls = Array.from(new Set(embeds.map((e) => e.url)))
    const results = await Promise.all(uniqueUrls.map((u) => checkEmbedUrl(u, parseVideoEmbed)))
    const byUrl = new Map(uniqueUrls.map((u, i) => [u, results[i]]))
    return embeds.map((e) => {
      const r = byUrl.get(e.url)!
      return { slideId: e.slideId, title: e.title, url: e.url, kind: r.kind, status: r.status, detail: r.detail }
    })
  } catch (e) {
    console.error('[check-embeds]', e)
    return []
  }
})

// ── Explain rendering (the per-slide decision trace, ADR-0024) ───────────────
// Reads the ACTUAL compiled decisions off the rendered <section> for one slide — not a guess.
// The engine stamps every render decision as a data-* attribute on the slide's <section>
// (data-layout / data-title-layout / data-role / data-mode / data-split),
// plus the trigger tokens the author wrote. We return those verbatim so the renderer can show
// "why did this slide look like this" on right-click. Index = the slide's position in the deck
// (same order as compile()'s projection rows).
ipcMain.handle('talk:explain-slide', async (_event, outlinePath: string, content: string, index: number) => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const vaultRoot = getConfig('vaultRoot', undefined)
    const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)
    const model = await prepareSource(outlinePath, resolved, slug, stat)
    const rows = (buildPerSlideProjections(model, slug) ?? []) as ProjectionRowMain[]
    const fullHtml = String(model.fullHtml ?? '')
    // The Nth `<section class="slide" …>` opening tag is this slide's render decisions.
    const tags = fullHtml.match(/<section class="slide"[^>]*>/g) ?? []
    if (index < 0 || index >= tags.length) return null
    const tag = tags[index]
    const attr = (name: string): string => {
      const m = tag.match(new RegExp(`data-${name}="([^"]*)"`))
      return m ? m[1] : ''
    }
    const row = rows[index] ?? ({} as ProjectionRowMain)
    // Trigger tokens the author wrote on the slide's Trigger line (the {…}-only line after the heading).
    const src = String(row.source_markdown ?? '')
    const triggerLine = src.split('\n').slice(1).find((l) => /^\s*(\{[^}]*\}\s*)+$/.test(l)) ?? ''
    const triggers = (triggerLine.match(/\{[^}]*\}/g) ?? [])
    return {
      navTitle: row.nav_title || row.title || '',
      layout: attr('layout'),
      titleLayout: attr('title-layout'), // 'left' | 'top' | '' (none/nav-only)
      role: attr('role'),
      mode: attr('mode'),
      split: attr('split'),
      triggers,
      wordCount: row.word_count ?? 0,
      bulletCount: (row as { bullet_count?: number }).bullet_count ?? 0,
      imageCount: (row as { image_count?: number }).image_count ?? 0,
      warnings: Array.isArray(row.warnings) ? row.warnings : []
    }
  } catch (e) {
    console.error('[explain-slide]', e)
    return null
  }
})

// ── Cross-talk search (cached index, ADR-0019) ───────────────────────────────
// Recompiling every talk per keystroke is wasteful. Cache compiled projection rows
// per outline keyed by mtimeMs; reuse unless the file changed since last compile.
type SearchCacheEntry = { mtimeMs: number; rows: ProjectionRowMain[]; talkTitle: string; meta?: string }

// Lowercased frontmatter keywords (title/subtitle/event/author/license/…) for the search's metadata
// filter. A single haystack string — the filter is a substring match over it.
function parseTalkMeta(content: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return ''
  const fields = new Set(['title', 'subtitle', 'event', 'author', 'license', 'license-note', 'cta', 'thanks', 'handout_url'])
  const out: string[] = []
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/)
    if (m && fields.has(m[1])) out.push(m[2].replace(/^["']|["']$/g, ''))
  }
  return out.join(' ').toLowerCase()
}
interface ProjectionRowMain {
  slide_id?: string
  nav_title?: string
  title?: string
  text_excerpt?: string
  section?: string
  source_markdown?: string
  content_hash?: string
  /** Curated slide tags (ADR-0037) — parsed from the Trigger line's `tags=` token by the
   *  compiler's projections; [] when untagged, absent only on pre-tags cached rows. */
  tags?: string[]
  [k: string]: unknown
}
const searchCache = new Map<string, SearchCacheEntry & { slug: string }>()

// Persist the compiled index to disk so search is fast on a cold app start, not just
// within one session. Keyed by outlinePath; each entry carries the mtimeMs it was built
// at, so stale entries are recompiled lazily by ensureTalkRows.
function searchIndexFile(): string {
  return join(app.getPath('userData'), 'search-index.json')
}
function loadSearchIndexFromDisk(): void {
  try {
    const raw = readFileSync(searchIndexFile(), 'utf8')
    const obj = JSON.parse(raw) as Record<string, SearchCacheEntry & { slug: string }>
    for (const [k, v] of Object.entries(obj)) {
      if (v && Array.isArray(v.rows)) searchCache.set(k, v)
    }
    console.log('[search] loaded ' + searchCache.size + ' talks from disk index')
  } catch { /* no index yet */ }
}
let persistTimer: ReturnType<typeof setTimeout> | null = null
let persisting = false
let persistAgain = false
function persistSearchIndexSoon(): void {
  if (persistTimer) clearTimeout(persistTimer)
  // The index is the full projection rows (source_markdown included) for every talk — a
  // multi-MB JSON. Serialize + write it OFF the event loop (async write, atomic rename) so a
  // mid-editing re-index never stalls IPC. Overlapping requests coalesce into one trailing write.
  persistTimer = setTimeout(async () => {
    if (persisting) { persistAgain = true; return }
    persisting = true
    try {
      const obj: Record<string, unknown> = {}
      for (const [k, v] of searchCache.entries()) obj[k] = v
      const json = JSON.stringify(obj)
      const tmp = searchIndexFile() + '.tmp'
      const { writeFile, rename } = await import('fs/promises')
      await writeFile(tmp, json, 'utf8')
      await rename(tmp, searchIndexFile())
      // The index is the source of the sidebar's slide counts; tell every window fresh
      // counts exist so a talk-meta fetched BEFORE the warmer finished stops showing "—".
      // Trailing-debounced with the write itself, so editing bursts coalesce to one ping.
      notifyTalkMetaUpdated()
    } catch (e) { console.error('[search] persist failed', e) } finally {
      persisting = false
      if (persistAgain) { persistAgain = false; persistSearchIndexSoon() }
    }
  }, 500)
}

// Compile (or reuse cached) projection rows for one talk. Shared by the live handler and
// the background warmer so they never diverge.
async function ensureTalkRows(
  talk: TalkInfo,
  vaultRoot: string,
  prepareSource: (...a: unknown[]) => Promise<{ [k: string]: unknown }>,
  buildPerSlideProjections: (...a: unknown[]) => ProjectionRowMain[] | null
): Promise<ProjectionRowMain[] | null> {
  if (!existsSync(talk.outlinePath)) return null
  const stat = statSync(talk.outlinePath)
  const entry = searchCache.get(talk.outlinePath)
  // Entries built before the tags field existed (rows lack `tags`) are treated as stale so
  // one warm pass upgrades the whole persisted index — tags:vocabulary reads it live.
  const rowsCarryTags = !entry || entry.rows.length === 0 || Array.isArray(entry.rows[0].tags)
  if (entry && entry.mtimeMs === stat.mtimeMs && rowsCarryTags) {
    // Backfill meta for entries loaded from an older on-disk index (cheap; frontmatter only).
    if (entry.meta === undefined) { try { entry.meta = parseTalkMeta(readFileSync(talk.outlinePath, 'utf8')) } catch { entry.meta = '' } }
    return entry.rows
  }
  const content = readFileSync(talk.outlinePath, 'utf8')
  const resolved = resolveImageRefs(content, vaultRoot)
  const model = await prepareSource(talk.outlinePath, resolved, talk.slug, stat)
  const rows = buildPerSlideProjections(model, talk.slug)
  if (!rows) return null
  searchCache.set(talk.outlinePath, { mtimeMs: stat.mtimeMs, rows, talkTitle: talk.title, slug: talk.slug, meta: parseTalkMeta(content) })
  persistSearchIndexSoon()
  return rows
}

// Build/refresh the whole index in the background. Runs at startup and after vault change
// so the first ⌘K is instant (warm cache ~10ms) instead of recompiling 13 talks (~5s).
let warming = false
async function warmSearchIndex(): Promise<void> {
  if (warming) return
  const vaultRoot = getConfig('vaultRoot', undefined)
  const compilerDir = getCompilerPath()
  if (!vaultRoot || !compilerDir) return
  warming = true
  try {
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)
    const talks = findTalks(vaultRoot)
    for (const talk of talks) {
      try { await ensureTalkRows(talk, vaultRoot, prepareSource, buildPerSlideProjections) } catch { /* skip */ }
    }
    console.log('[search] index warmed: ' + searchCache.size + ' talks')
  } catch (e) {
    console.error('[search] warm failed', e)
  } finally {
    warming = false
  }
}

// Pre-generate per-slide thumbnails for changed/new talks (ADR-0019: cross-Talk search is "backed
// by pre-generated thumbnails"). A persisted outline-content ledger prevents the expensive
// synchronous compiler pass from running for an unchanged talk whose cache directory still exists.
// Changed talks are staggered so input can run between main-process compiler passes.
let prerendering = false
async function prerenderAllThumbnails(): Promise<void> {
  if (prerendering) return
  const vaultRoot = getConfig('vaultRoot', undefined)
  const compilerDir = getCompilerPath()
  if (!vaultRoot || !compilerDir) return
  prerendering = true
  try {
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)
    const talks = findTalks(vaultRoot)
    const ledgerPath = join(app.getPath('userData'), 'prerender-ledger.json')
    const ledger = loadPrerenderLedger(ledgerPath)
    let done = 0
    let compiled = 0
    for (const talk of talks) {
      try {
        if (!existsSync(talk.outlinePath)) continue
        const content = readFileSync(talk.outlinePath, 'utf8')
        const contentHash = contentHashForPrerender(content)
        const cacheDir = join(app.getPath('userData'), thumbCacheRoot(), talk.slug)
        if (!shouldPrerenderTalk(ledger, talk.outlinePath, contentHash, cacheDir)) continue
        if (compiled > 0) await new Promise<void>((resolve) => setTimeout(resolve, 250))
        await new Promise<void>((resolve) => setImmediate(resolve))
        compiled += 1
        const stat = statSync(talk.outlinePath)
        const resolved = resolveImageRefs(content, vaultRoot)
        const model = await prepareSource(talk.outlinePath, resolved, talk.slug, stat)
        const rows = (buildPerSlideProjections(model, talk.slug) ?? []) as Array<{
          content_hash?: string
          render_hash?: string
          slide_id?: string
          layout?: string
          triggers?: Record<string, string>
        }>
        // SAME key precedence as the live `talk:thumbnails` handler (render_hash first) —
        // the prerender used to key on content_hash only, so any slide with a layout/trigger
        // (render_hash ≠ content_hash) missed the warm cache and re-rendered on first open.
        const fullHtml = model.fullHtml as string
        const documentId = thumbnailDocumentId(fullHtml)
        const slides = rows
          .map((r) => {
            const key = r.render_hash || r.content_hash || r.slide_id || ''
            return { key, cacheKey: thumbnailDocumentCacheKey(documentId, key), layout: r.triggers?.layout ?? r.layout }
          })
          .filter((s) => s.key)
        const rendered = slides.length
          ? await renderThumbnails({ fullHtml, slides, cacheDir })
          : (mkdirSync(cacheDir, { recursive: true }), {})
        if (!slides.every((slide) => rendered[slide.key])) continue
        recordSuccessfulPrerender(ledger, talk.outlinePath, contentHash, documentId)
        savePrerenderLedger(ledgerPath, ledger)
        done += 1
      } catch { /* skip a talk that fails to render */ }
    }
    console.log('[thumbnails] pre-generated for ' + done + ' changed talks; skipped ' + (talks.length - compiled) + ' unchanged talks')
  } catch (e) {
    console.error('[thumbnails] prerender failed', e)
  } finally {
    prerendering = false
  }
}

// ── OCR (image-text) search — native macOS Vision via the bundled `ocr` helper ───────────────────
// "Basic image text search" in TalkWeaver itself (ADR-0026 revised): OCR every vault image once,
// cache the text by file path+mtime, and fold it into the search haystack so a query word that only
// appears INSIDE a slide's image still finds the slide. SlideWell will later own a richer index;
// this is the good-enough-now version with no third-party deps (Vision is built into macOS).
const ocrCache = new Map<string, { mtimeMs: number; text: string }>()
let ocrCacheLoaded = false
let ocring = false
const slideOcrMemo = new Map<string, string>() // slideKey → lowercased OCR text (cleared on cache change)

function ocrCacheFile(): string { return join(app.getPath('userData'), 'ocr-cache.json') }
function loadOcrCache(): void {
  if (ocrCacheLoaded) return
  ocrCacheLoaded = true
  try {
    const obj = JSON.parse(readFileSync(ocrCacheFile(), 'utf8')) as Record<string, { mtimeMs: number; text: string }>
    for (const [k, v] of Object.entries(obj)) ocrCache.set(k, v)
  } catch { /* no cache yet */ }
}
let ocrPersistTimer: ReturnType<typeof setTimeout> | null = null
function persistOcrCacheSoon(): void {
  if (ocrPersistTimer) clearTimeout(ocrPersistTimer)
  ocrPersistTimer = setTimeout(() => {
    try { writeFileSync(ocrCacheFile(), JSON.stringify(Object.fromEntries(ocrCache)), 'utf8') } catch { /* ignore */ }
  }, 1500)
}
// Packaged: <Resources>/ocr; dev (electron .): repo native/ocr (out/main → ../../native/ocr).
function resolveOcrBin(): string | null {
  const candidates = [
    join(process.resourcesPath || '', 'ocr'),
    join(__dirname, '../../native/ocr'),
    join(__dirname, '../../../native/ocr')
  ]
  for (const c of candidates) { try { if (c && existsSync(c)) return c } catch { /* ignore */ } }
  return null
}
// The native media helper (ADR-0028): GIF→MP4 conversion + poster extraction. Same resolution as OCR.
function resolveMediaBin(): string | null {
  const candidates = [
    join(process.resourcesPath || '', 'media'),
    join(__dirname, '../../native/media'),
    join(__dirname, '../../../native/media')
  ]
  for (const c of candidates) { try { if (c && existsSync(c)) return c } catch { /* ignore */ } }
  return null
}
// Run the media helper and parse its single JSON result line. Never throws.
function runMediaBin(args: string[]): Promise<{ ok: boolean; [k: string]: unknown }> {
  const bin = resolveMediaBin()
  if (!bin) return Promise.resolve({ ok: false, error: 'media helper not found' })
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const line = String(stdout || '').trim().split('\n').filter(Boolean).pop() || ''
      try { resolve(JSON.parse(line)) } catch { resolve({ ok: false, error: err ? String(err.message) : 'no output' }) }
    })
  })
}
// Stream a sha256 over a file (videos can be large) → 7-hex content id, never loading it whole.
function hashFileSoon(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(p)
    s.on('error', reject)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex').slice(0, 7)))
  })
}
// OCR a batch of image paths via the helper (chunked to keep argv sane). Updates the cache.
async function ocrBatch(paths: string[]): Promise<void> {
  const bin = resolveOcrBin()
  if (!bin || paths.length === 0) return
  const CHUNK = 80
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK)
    const stdout = await new Promise<string>((resolve) => {
      execFile(bin, chunk, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (err, out) => resolve(err ? '' : String(out || '')))
    })
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line) as { p: string; t: string }
        let mtimeMs = 0
        try { mtimeMs = statSync(obj.p).mtimeMs } catch { /* file may be gone */ }
        ocrCache.set(obj.p, { mtimeMs, text: obj.t || '' })
      } catch { /* skip a bad line */ }
    }
  }
  slideOcrMemo.clear()
  persistOcrCacheSoon()
}
const IMG_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif'])
// Gather every image file under the vault pool (_assets) + each talk's assets/ dir.
function gatherVaultImages(vaultRoot: string): string[] {
  const out: string[] = []
  const scanDir = (dir: string): void => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      try { if (statSync(full).isFile() && IMG_EXTS.has(extname(name).toLowerCase())) out.push(full) } catch { /* ignore */ }
    }
  }
  scanDir(join(vaultRoot, '_assets'))
  for (const talk of findTalks(vaultRoot)) scanDir(join(dirname(talk.outlinePath), 'assets'))
  return out
}
// Background pass: OCR every vault image not already cached (or changed). Idempotent + cached.
async function ocrAllVaultImages(): Promise<void> {
  if (ocring) return
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot || !resolveOcrBin()) return
  ocring = true
  try {
    loadOcrCache()
    const all = gatherVaultImages(vaultRoot)
    const todo = all.filter((p) => {
      const c = ocrCache.get(p)
      if (!c) return true
      try { return statSync(p).mtimeMs !== c.mtimeMs } catch { return false }
    })
    if (todo.length) {
      console.log('[ocr] indexing ' + todo.length + ' image(s)…')
      await ocrBatch(todo)
      console.log('[ocr] done (' + ocrCache.size + ' images cached)')
    }
  } catch (e) { console.error('[ocr] pass failed', e) } finally { ocring = false }
}
// Resolve a slide image ref to an absolute file path (img-id → pool; relative → talk dir; decoded).
function resolveImageAbs(ref: string, talkDir: string, vaultRoot: string): string | null {
  let s = ref.trim().replace(/\s+"[^"]*"$/, '')
  if (/^(https?:|data:)/.test(s)) return null
  s = s.replace(/^img-img-([0-9a-f]{7})$/, 'img-$1')
  if (/^img-[0-9a-f]{7}$/.test(s)) {
    for (const ext of ['webp', 'png', 'jpg', 'jpeg', 'gif']) {
      const p = join(vaultRoot, '_assets', s + '.' + ext)
      if (existsSync(p)) return p
    }
    return null
  }
  try { s = decodeURIComponent(s) } catch { /* keep raw */ }
  return s.startsWith('/') ? s : join(talkDir, s)
}
// The cached OCR text for one slide's images (lowercased), memoized by a stable slide key.
function slideOcrText(row: ProjectionRowMain, talkDir: string, vaultRoot: string): string {
  const key = String(row.content_hash || row.slide_id || '')
  const memo = slideOcrMemo.get(key)
  if (memo !== undefined) return memo
  const md = String(row.source_markdown || '')
  let text = ''
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const abs = resolveImageAbs(m[1], talkDir, vaultRoot)
    if (abs) { const c = ocrCache.get(abs); if (c && c.text) text += '\n' + c.text }
  }
  text = text.toLowerCase()
  slideOcrMemo.set(key, text)
  return text
}

// Manual trigger for the OCR index (command palette) — runs the same cached pass and reports counts.
ipcMain.handle('talk:ocr-index', async () => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return { success: false, error: 'No vault root' }
  if (!resolveOcrBin()) return { success: false, error: 'OCR helper not found (rebuild the app)' }
  loadOcrCache()
  const before = ocrCache.size
  await ocrAllVaultImages()
  const total = gatherVaultImages(vaultRoot).length
  return { success: true, total, cached: ocrCache.size, added: ocrCache.size - before }
})

// The structured search the renderer sends (mirrors slideBrowserModel.ParsedQuery). A bare
// string is the legacy all-fields all-words form — kept so older callers and the diagnose
// harnesses that invoke tw.search.allSlides('word') still work unchanged.
type SearchQuery = { scope: 'all' | 'title' | 'body' | 'image'; exact: boolean; text: string; terms: string[] }
function normalizeSearchQuery(q: unknown): SearchQuery {
  if (typeof q === 'string') {
    return { scope: 'all', exact: false, text: q, terms: q.toLowerCase().split(/\s+/).filter(Boolean) }
  }
  const o = (q ?? {}) as Partial<SearchQuery>
  const scope = o.scope === 'title' || o.scope === 'body' || o.scope === 'image' ? o.scope : 'all'
  const text = typeof o.text === 'string' ? o.text : ''
  const terms = Array.isArray(o.terms) ? o.terms.filter((t): t is string => typeof t === 'string' && t !== '') : []
  return { scope, exact: Boolean(o.exact), text, terms }
}
// Does a lowercased haystack satisfy the query? Exact → the phrase must appear contiguously; else
// every term must appear (order-independent). An empty phrase / empty term list matches all.
function matchHay(hayLower: string, q: SearchQuery): boolean {
  if (q.exact) return hayLower.includes(q.text.toLowerCase())
  return q.terms.every((t) => hayLower.includes(t))
}

ipcMain.handle('search:all-slides', async (_event, query: string | SearchQuery) => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return null
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  loadOcrCache()
  try {
    const talks = findTalks(vaultRoot)
    const results: Array<ProjectionRowMain & { talkSlug: string; talkTitle: string; outlinePath: string; talkMtimeMs: number; talkMeta: string; titleHit: boolean }> = []
    // Scoped, all-words (or exact-phrase) match. The four searchable fields are the slide TITLE
    // (nav_title + title), the slide BODY (full source_markdown), and the IMAGE text (cached OCR of
    // the slide's images) — Section/subsection are deliberately NOT searched (they are a UI filter;
    // matching them made search far too broad). scope picks which field(s) the query is tested
    // against; scope 'all' is today's behaviour (all four at once). Empty query → every slide.
    const q = normalizeSearchQuery(query)
    const adaptersUrl = pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href
    const projectionsUrl = pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href
    const { prepareSource } = await import(adaptersUrl)
    const { buildPerSlideProjections } = await import(projectionsUrl)

    for (const talk of talks) {
      try {
        const rows = await ensureTalkRows(talk, vaultRoot, prepareSource, buildPerSlideProjections)
        if (!rows) continue
        const cached = searchCache.get(talk.outlinePath)
        const talkMtimeMs = cached?.mtimeMs ?? 0
        const talkMeta = cached?.meta ?? ''
        const talkDir = dirname(talk.outlinePath)
        for (const row of rows) {
          const titleHay = `${row.nav_title || ''}\n${row.title || ''}`.toLowerCase()
          const bodyHay = String(row.source_markdown || '').toLowerCase()
          const imageHay = slideOcrText(row, talkDir, vaultRoot) // already lowercased
          const fieldHay =
            q.scope === 'title' ? titleHay
              : q.scope === 'body' ? bodyHay
                : q.scope === 'image' ? imageHay
                  : `${titleHay}\n${bodyHay}\n${imageHay}`
          if (matchHay(fieldHay, q)) {
            // titleHit drives the renderer's title-priority ranking: a title-scoped hit is a title
            // hit by definition; otherwise it is whether the query also matches the title field.
            const titleHit = q.scope === 'title' ? true : matchHay(titleHay, q)
            results.push({
              ...row,
              talkSlug: talk.slug,
              talkTitle: talk.title,
              outlinePath: talk.outlinePath,
              talkMtimeMs,
              talkMeta,
              titleHit
            })
          }
        }
      } catch { /* skip failed talks */ }
    }
    return results
  } catch (e) {
    console.error('[search:all-slides]', e)
    return null
  }
})

// ── Outline read/write ─────────────────────────────────────────────────────

// ── Outline v2 migration offer (heading-is-slide, Task 9) ───────────────────
// Opening a talk whose outline is not stamped `outline_version: 2` offers a ONE-TIME
// (per talk, per app run) migration to the new grammar. Decline opens unmigrated —
// the compiler still renders best-effort and emits its `legacy-outline` warning.
// Accept runs the same migrateOutline the CLI uses, writes a `.bak` of the original
// BESIDE the outline FIRST, then the migrated text — and refuses outright if the
// migrated text is structurally empty (same predicate as the talk:write-outline
// data-loss backstop: a migration must never produce an empty file).
const migrationOffered = new Set<string>()

function outlineHasV2Stamp(text: string): boolean {
  const m = text.match(/^﻿?---[^\S\n]*\n([\s\S]*?)\n---/)
  if (!m) return false
  return /^\s*outline[_-]version\s*:\s*["']?2["']?\s*$/m.test(m[1])
}

// Harness/automation guard: every e2e harness launches Electron with --user-data-dir
// (never used by real dev or packaged runs), and the recording harness sets TW_REC_TEST.
// A modal dialog would hang those runs. TW_MIGRATE_PROMPT=0 is the explicit off-switch.
function migrationPromptSuppressed(): boolean {
  return (
    process.env.TW_REC_TEST === '1' ||
    process.env.TW_MIGRATE_PROMPT === '0' ||
    app.commandLine.hasSwitch('user-data-dir')
  )
}

async function maybeOfferOutlineMigration(outlinePath: string, text: string): Promise<string> {
  if (outlineHasV2Stamp(text)) return text
  if (migrationPromptSuppressed()) return text
  if (migrationOffered.has(outlinePath)) return text
  migrationOffered.add(outlinePath) // ask once per talk per app run, whatever the answer
  const compilerDir = getCompilerPath()
  if (!compilerDir) return text
  let migrateOutline: (t: string) => { text: string; changed: boolean; report: string[] }
  try {
    const mod = await import(pathToFileURL(join(compilerDir, 'migrate-outline.mjs')).href)
    migrateOutline = mod.migrateOutline
  } catch (e) {
    console.error('[outline-migrate] cannot load migrate-outline.mjs', e)
    return text
  }
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Migrate', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Migrate this talk to the new outline format?',
    detail: 'A backup copy (.bak) will be kept beside the outline.'
  }
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts)
  if (response !== 0) return text // declined: open unmigrated
  try {
    // TOCTOU guard: the modal can sit open for minutes while another window (multi-window
    // is supported) autosaves this same outline. Migrating the bytes read BEFORE the dialog
    // would clobber those edits — and the .bak would preserve only the stale pre-dialog
    // text. So on accept: re-read the file, re-check the stamp (someone may have migrated
    // it meanwhile), and migrate the FRESH bytes; the .bak gets the fresh pre-migration text.
    let fresh = text
    try { fresh = readFileSync(outlinePath, 'utf8') } catch { /* keep the original read */ }
    // Never trust an empty re-read over a non-empty original (the 2026-07-05 emptied-outline
    // incident class): a concurrent transient truncation here would make migrateOutline('')
    // emit a stamp-only outline and put EMPTY bytes in the .bak.
    if (isStructurallyEmptyOutline(fresh) && !isStructurallyEmptyOutline(text)) fresh = text
    if (outlineHasV2Stamp(fresh)) return fresh // already migrated elsewhere — nothing to do
    const result = migrateOutline(fresh)
    if (!result || typeof result.text !== 'string' || !result.changed) return fresh
    if (isStructurallyEmptyOutline(result.text)) {
      // Never let a migration empty a file — surface it, keep the original untouched.
      console.error(`[outline-migrate] REFUSED structurally-empty migration result for ${outlinePath}`)
      dialog.showErrorBox(
        'Migration refused',
        'The migration produced an empty outline, so nothing was written. The talk opens unmigrated.'
      )
      return fresh
    }
    writeFileSync(`${outlinePath}.bak`, fresh, 'utf8') // backup FIRST, then the migrated text
    writeFileSync(outlinePath, result.text, 'utf8')
    console.log(`[outline-migrate] migrated ${outlinePath} (${result.report.length} change(s); backup: ${outlinePath}.bak)`)
    return result.text
  } catch (e) {
    console.error('[outline-migrate] migration failed; opening unmigrated', e)
    dialog.showErrorBox(
      'Migration failed',
      'The outline could not be migrated and was left untouched. The talk opens unmigrated.'
    )
    return text
  }
}

ipcMain.handle('talk:read-outline', async (_event, outlinePath: string) => {
  try {
    const text = await readFileAsync(outlinePath, 'utf8')
    return await maybeOfferOutlineMigration(outlinePath, text)
  } catch (e) {
    return null
  }
})

// Data-loss backstop (2026-07-05). A structurally-empty payload is one that is empty/whitespace-only,
// OR carries neither YAML frontmatter NOR any Markdown heading — i.e. it is not a real outline. An
// outline never legitimately becomes empty via autosave: even a deck with every slide deleted keeps
// its frontmatter. So the ONLY thing this predicate ever catches is a bug (a renderer remount/`doc:''`
// transient, a stale autosave, a botched load) about to overwrite real work — never a genuine save.
function isStructurallyEmptyOutline(content: string): boolean {
  if (typeof content !== 'string' || content.trim() === '') return true
  const trimmed = content.replace(/^﻿/, '').trimStart()
  const hasFrontmatter = /^---\s*(?:\n|$)/.test(trimmed)
  const hasHeading = /^#{1,6}[ \t]/m.test(content)
  return !hasFrontmatter && !hasHeading
}

ipcMain.handle('talk:write-outline', async (_event, outlinePath: string, content: string) => {
  // HARD BACKSTOP: refuse to write a structurally-empty payload OVER a file that still holds real
  // content. This is the last line of defence against the data-loss bug (a full 58-slide outline was
  // emptied to 0 bytes during Slide Focus testing, then auto-committed by reposync). Absent/empty
  // targets and any structurally-valid write pass straight through, so no legitimate save is blocked.
  if (isStructurallyEmptyOutline(content)) {
    let existing = ''
    try { existing = readFileSync(outlinePath, 'utf8') } catch { /* absent = nothing to protect */ }
    if (existing.trim() !== '') {
      console.warn(
        `[write-outline] REFUSED empty-over-nonempty write to ${outlinePath} — ` +
        `incoming ${content?.length ?? 0} bytes vs existing ${existing.length} bytes (data-loss backstop)`
      )
      return { ok: false as const, refused: 'empty-over-nonempty' as const }
    }
  }
  // Heading-is-slide model (Task 8): every heading gets an {id=…} before the ledger ever sees
  // it — a save is the ONLY point new headings (typed post-migration) get stamped. Stamping goes
  // through the engine's write-back channel (setSlideId/mergeTriggerAtLine in 12-outline-edit.mjs),
  // never a raw splice here, so idProtect semantics apply. Best-effort: a stamping failure must
  // never block a save — the unstamped content still writes, and ledgering simply skips those
  // heading(s) until a later save succeeds. Runs strictly AFTER the empty-over-nonempty backstop
  // above: a refused payload is never stamped, and stampMissingIds cannot manufacture content
  // (no headings in → no-op out), so the backstop's verdict is always on the caller's own bytes.
  //
  // ID CHURN GUARD (two layers, both required):
  //  1. `preferred` — ids the PREVIOUS save minted (read from the on-disk file, matched by
  //     normalised heading + occurrence) are REUSED for still-unstamped headings, so a renderer
  //     buffer that never adopted the last stamp converges on the same ids instead of re-minting
  //     new ones every save (which would fragment each slide's ledger history).
  //  2. The stamped text is returned to the caller (`content` field below) so the renderer can
  //     adopt it into the editor buffer and stop sending unstamped text at all.
  let toWrite = content
  let stampedContent: string | null = null
  try {
    const compilerDir = getCompilerPath()
    if (compilerDir) {
      const mod = await import(pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href)
      let preferred: Map<string, string> | null = null
      try { preferred = mod.preferredIdsFromText(readFileSync(outlinePath, 'utf8')) } catch { /* new file: nothing to reuse */ }
      const stamped = mod.stampMissingIds(content, undefined, { preferred })
      if (stamped?.text && stamped.stamped?.length) {
        toWrite = stamped.text
        stampedContent = stamped.text
      }
    }
  } catch { /* stamping must never block a save */ }
  try {
    writeFileSync(outlinePath, toWrite, 'utf8')
  } catch {
    return false
  }
  notifyPathwaysChanged(outlinePath)
  // Ledger records only on a REAL write (a refused write above returns before here). Records the
  // STAMPED content so newly-minted ids are ledgered in the same save that created them.
  const collisions = await ledgerRecord(outlinePath, toWrite)
  // `content` present only when stamping changed the bytes — the renderer adopts it into the
  // editor buffer (Editor.tsx) so the next save sends already-stamped text.
  return stampedContent === null
    ? { ok: true, collisions }
    : { ok: true, collisions, content: stampedContent }
})

// ── Metadata Registry surfaces (ADR-0036) ───────────────────────────────────
// The registry (src/shared/metadata-registry.ts) declares every key; here live the vault-wide
// services: the doctor (unregistered-key scan), the open-vocabulary aggregator, the per-outline
// ignore list, and the in-place frontmatter editor (the generalised retitleOutline).

// Full-frontmatter parse — top-level `key:` lines only (indented lines belong to the key above).
function frontmatterPairs(text: string): Array<{ key: string; value: string }> {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return []
  const pairs: Array<{ key: string; value: string }> = []
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/)
    if (m) pairs.push({ key: m[1], value: m[2].trim().replace(/^["']|["']$/g, '').trim() })
  }
  return pairs
}

function insideVault(outlinePath: string): boolean {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return false
  const rel = relativePath(resolvePath(vaultRoot), resolvePath(outlinePath))
  return rel !== '' && !rel.startsWith('..') && !rel.includes(`..${pathSep}`)
}

// Per-outline "Keep (ignore)" list — keys the user chose to leave undeclared. Registering a key
// is a development act (it needs an explanation and a vocabulary), so the panel's counterpart
// action records the key here and the doctor stops flagging it. userData, not the vault: the
// list is a per-machine triage note, not talk content.
type MetadataIgnore = Array<{ outline: string; key: string }>
function metadataIgnorePath(): string {
  return join(app.getPath('userData'), 'metadata-ignore.json')
}
function readMetadataIgnore(): MetadataIgnore {
  try {
    const parsed = JSON.parse(readFileSync(metadataIgnorePath(), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

// 5s-cached doctor scan (same TTL pattern as the talk cache; vault mutations invalidate both).
type DoctorReport = Array<{
  talk: string
  slug: string
  outlinePath: string
  unregistered: Array<{ key: string; value: string }>
}>
let metadataScanCache: { root: string; at: number; doctor: DoctorReport; vocabulary: Record<string, Array<{ value: string; count: number }>> } | null = null
function invalidateMetadataCaches(): void {
  metadataScanCache = null
}
function metadataScan(root: string): NonNullable<typeof metadataScanCache> {
  if (metadataScanCache && metadataScanCache.root === root && Date.now() - metadataScanCache.at < TALK_CACHE_TTL_MS) {
    return metadataScanCache
  }
  const registered = registeredKeyNames()
  const openKeys = openVocabularyFrontmatterKeys()
  const ignore = readMetadataIgnore()
  const doctor: DoctorReport = []
  const counts: Record<string, Map<string, number>> = {}
  for (const k of openKeys) counts[k] = new Map()
  for (const talk of findTalks(root)) {
    let text = ''
    try { text = readFileSync(talk.outlinePath, 'utf8') } catch { continue }
    const rel = relativePath(root, talk.outlinePath)
    const unregistered: Array<{ key: string; value: string }> = []
    for (const { key, value } of frontmatterPairs(text)) {
      if (openKeys.includes(key) && value) {
        counts[key].set(value, (counts[key].get(value) ?? 0) + 1)
      }
      if (!registered.has(key) && !ignore.some((i) => i.outline === rel && i.key === key)) {
        unregistered.push({ key, value })
      }
    }
    if (unregistered.length > 0) {
      doctor.push({ talk: talk.title, slug: talk.slug, outlinePath: talk.outlinePath, unregistered })
    }
  }
  const vocabulary: Record<string, Array<{ value: string; count: number }>> = {}
  for (const [k, m] of Object.entries(counts)) {
    vocabulary[k] = [...m.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  }
  metadataScanCache = { root, at: Date.now(), doctor, vocabulary }
  return metadataScanCache
}

// Doctor: every outline's unregistered frontmatter keys (respecting the ignore list). The panel
// filters to one talk; a future vault-health surface can show the whole report. NO auto-fixing
// here — main only reports; removal goes through metadata:edit-frontmatter on explicit request.
ipcMain.handle('metadata:doctor', () => {
  const root = getConfig('vaultRoot', undefined)
  return root ? metadataScan(root).doctor : []
})

// Open-vocabulary values observed across the vault: { event: [{ value, count }, …], … }.
ipcMain.handle('metadata:vocabulary', () => {
  const root = getConfig('vaultRoot', undefined)
  return root ? metadataScan(root).vocabulary : {}
})

// "Keep (ignore)": record an unregistered key for this outline so the doctor stops flagging it.
ipcMain.handle('metadata:ignore-key', (_event, outlinePath: string, key: string) => {
  const root = getConfig('vaultRoot', undefined)
  if (!root || !insideVault(outlinePath) || typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key)) {
    return { ok: false as const }
  }
  const rel = relativePath(resolvePath(root), resolvePath(outlinePath))
  const list = readMetadataIgnore()
  if (!list.some((i) => i.outline === rel && i.key === key)) {
    list.push({ outline: rel, key })
    try {
      writeFileSync(metadataIgnorePath(), JSON.stringify(list, null, 2), 'utf8')
    } catch (e) {
      console.error('[metadata:ignore-key]', e)
      return { ok: false as const }
    }
  }
  invalidateMetadataCaches()
  return { ok: true as const }
})

// In-place frontmatter edit — the Metadata panel's single write path. Reads the CURRENT file
// (the renderer flushes its autosave first for the active talk), applies the edits, and returns
// the full new text so the caller can adopt it into the editor buffer (the publish-handout
// adoption pattern — otherwise the next autosave would overwrite this write).
ipcMain.handle(
  'metadata:edit-frontmatter',
  (_event, outlinePath: string, edits: Array<{ key: string; value: string | null; aliases?: string[] }>) => {
    if (!insideVault(outlinePath) || !Array.isArray(edits) || edits.length === 0) {
      return { ok: false as const, error: 'bad-request' }
    }
    for (const e of edits) {
      if (typeof e?.key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(e.key)) return { ok: false as const, error: 'bad-key' }
      if (e.value !== null && typeof e.value !== 'string') return { ok: false as const, error: 'bad-value' }
    }
    let text = ''
    try { text = readFileSync(outlinePath, 'utf8') } catch { return { ok: false as const, error: 'unreadable' } }
    const next = editFrontmatterText(text, edits)
    if (next === text) return { ok: true as const, content: text, changed: false as const }
    try {
      writeFileSync(outlinePath, next, 'utf8')
    } catch (e) {
      console.error('[metadata:edit-frontmatter]', e)
      return { ok: false as const, error: 'write-failed' }
    }
    frontmatterCache.delete(outlinePath) // sidebar meta must not serve the pre-edit head
    invalidateTalkCache()
    invalidateMetadataCaches()
    return { ok: true as const, content: next, changed: true as const }
  }
)

// ── Slide tags IPC (ADR-0037) ────────────────────────────────────────────────
// Tags live on each slide's Trigger line (`tags=a,b`, per-occurrence, lowercase-kebab). The
// ADR-0010 §5: this already uses the shared-safe engine editor rather than renderer string logic.
// The write is applySlideTags — token-precise, merge-only, id-guard-safe (own-group
// rendering, other tokens verbatim). House rules follow ledger:adopt: every target outline must
// resolve inside the vault or the whole call is rejected; per-outline failures are isolated;
// the caller (renderer) flushes its autosave FIRST for the active talk and re-reads/adopts the
// rewritten text afterwards (the publish-handout adoption pattern).

type TagTarget = { outline: string; id?: string | null; heading?: string; occurrence?: number }

ipcMain.handle(
  'tags:apply',
  async (_event, targets: TagTarget[], add: string[], remove: string[]) => {
    if (!Array.isArray(targets) || targets.length === 0) return null
    if (!Array.isArray(add) || !Array.isArray(remove)) return null
    if (add.some((t) => typeof t !== 'string') || remove.some((t) => typeof t !== 'string')) return null
    const vaultRoot = getConfig('vaultRoot', undefined)
    const compilerDir = getCompilerPath()
    if (!vaultRoot || !compilerDir) return null
    try {
      const mod = await import(pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href)
      const addNorm: string[] = add.map((t) => mod.normalizeTag(t)).filter(Boolean)
      const removeNorm: string[] = remove.map((t) => mod.normalizeTag(t)).filter(Boolean)
      if (addNorm.length === 0 && removeNorm.length === 0) {
        return { ok: false as const, reason: 'no-tags' }
      }
      // Path-traversal guard over the WHOLE batch before any write (ledger:adopt rule).
      const rootAbs = resolvePath(vaultRoot)
      const byOutline = new Map<string, TagTarget[]>()
      for (const t of targets) {
        if (!t || typeof t.outline !== 'string' || !t.outline) return null
        if (t.id != null && (typeof t.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(t.id))) return null
        if (t.id == null && typeof t.heading !== 'string') return null
        const abs = resolvePath(vaultRoot, t.outline)
        if (abs !== rootAbs && !abs.startsWith(rootAbs + pathSep)) return null
        const list = byOutline.get(abs)
        if (list) list.push(t)
        else byOutline.set(abs, [t])
      }
      const applied: Array<{ outline: string; tags: string[][] }> = []
      const failed: Array<{ outline: string; error: string }> = []
      for (const [abs, outlineTargets] of byOutline) {
        try {
          const original = readFileSync(abs, 'utf8')
          let text = original
          const finalTags: string[][] = []
          for (const target of outlineTargets) {
            // Refs are recomputed against the CURRENT text each step: applySlideTags may scrub
            // a hand-authored heading tags token, which changes that heading's verbatim line.
            const refs: Array<{ heading: string; occurrence: number }> =
              target.id != null ? mod.blockRefsForId(text, target.id) : []
            if (refs.length === 0 && typeof target.heading === 'string' && target.heading) {
              refs.push({ heading: target.heading, occurrence: target.occurrence ?? 1 })
            }
            if (refs.length === 0) throw new Error(`slide not found (id=${target.id ?? '—'})`)
            const eol = mod.dominantEol(text)
            for (const ref of refs) {
              const result = mod.applySlideTags(text, ref, { add: addNorm, remove: removeNorm }, eol)
              text = result.text
              finalTags.push(result.tags)
            }
          }
          if (text !== original) {
            writeFileSync(abs, text, 'utf8')
            // Same post-write housekeeping as talk:write-outline: ledger the save (best-effort)
            // and drop the search-cache entry so the Browser reflects the new tags on next query.
            try { await ledgerRecord(abs, text) } catch { /* ledgering must never fail the write */ }
            try { searchCache.delete(abs) } catch { /* cache only */ }
          }
          applied.push({ outline: abs, tags: finalTags })
        } catch (e) {
          failed.push({ outline: abs, error: e instanceof Error ? e.message : String(e) })
        }
      }
      // Re-warm the dropped entries in the background so tags:vocabulary stays live.
      void warmSearchIndex()
      return { ok: true as const, applied, failed }
    } catch (e) {
      console.error('[tags:apply]', e)
      return null
    }
  }
)

// Every tag observed across the vault with occurrence counts — the pickers' autocomplete.
// Reads the live search index (projection rows carry `tags`); entries mid-recompile simply
// contribute on the next call. warmSearchIndex keeps it current after writes/vault changes.
ipcMain.handle('tags:vocabulary', () => {
  const rows: Array<string[] | undefined> = []
  for (const entry of searchCache.values()) {
    for (const row of entry.rows) rows.push(row.tags)
  }
  void warmSearchIndex() // ripen any stale/pre-tags entries for the next call
  return vocabularyFromTagLists(rows)
})

// ── Slide Ledger IPC (ADR-0032) ─────────────────────────────────────────────

ipcMain.handle('ledger:where-used', async (_event, id: string) => {
  // Renderer-supplied id reaches a path join under the vault; reject anything
  // that is not a plain id token (e.g. "../../..") before it can escape.
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return []
  try {
    const vaultRoot = getConfig('vaultRoot', undefined)
    const lib = await ledgerLib()
    return vaultRoot && lib ? lib.whereUsed(vaultRoot, id) : []
  } catch { return [] }
})

ipcMain.handle('ledger:versions', async (_event, id: string) => {
  // Same path-traversal guard as ledger:where-used.
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return []
  try {
    const vaultRoot = getConfig('vaultRoot', undefined)
    const lib = await ledgerLib()
    return vaultRoot && lib ? lib.listVersions(vaultRoot, id) : []
  } catch { return [] }
})

ipcMain.handle('ledger:detach', async (_event, outlinePath: string, content: string, ref: { heading: string; occurrence: number }) => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const mod = await import(pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href)
    const result = mod.detachSlideId(content, ref)
    if (!result) return null
    writeFileSync(outlinePath, result.text, 'utf8')
    const vaultRoot = getConfig('vaultRoot', undefined)
    const lib = await ledgerLib()
    if (vaultRoot && lib) {
      lib.recordOutlineSave(vaultRoot, outlinePath, result.text, {
        now: Date.now(),
        lineageHints: new Map([[result.newId, result.oldId]])
      })
    }
    return result
  } catch { return null }
})

// ── Slide propagation IPC (ADR-0032/ADR-0034) ───────────────────────────────
// Thin wrappers over the engine's 14-slide-propagation.mjs (status / diff / adopt).
// Same house rules as the other ledger handlers: id validated against the plain-token
// regex before any path work, and every failure returns null/empty — never a throw
// that could reach the renderer.
async function propagationLib(): Promise<any | null> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  return import(pathToFileURL(join(compilerDir, 'lib/14-slide-propagation.mjs')).href)
}

ipcMain.handle('ledger:status', async (_event, id: string, adoptMarkdown: string) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  try {
    const vaultRoot = getConfig('vaultRoot', undefined)
    const lib = await propagationLib()
    if (!vaultRoot || !lib) return null
    return lib.slideStatus(vaultRoot, id, String(adoptMarkdown ?? ''))
  } catch { return null }
})

ipcMain.handle('ledger:diff', async (_event, a: string, b: string) => {
  try {
    const lib = await propagationLib()
    return lib ? lib.lineDiff(String(a ?? ''), String(b ?? '')) : []
  } catch { return [] }
})

ipcMain.handle('ledger:adopt', async (_event, id: string, versionMarkdown: string, targetOutlines: string[]) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  if (!Array.isArray(targetOutlines) || targetOutlines.some((t) => typeof t !== 'string')) return null
  try {
    const vaultRoot = getConfig('vaultRoot', undefined)
    const lib = await propagationLib()
    if (!vaultRoot || !lib) return null
    // Path-traversal guard: targets are vault-relative outline paths (as whereUsed/slideStatus
    // return them); every one must resolve INSIDE the vault or the whole call is rejected —
    // adoption writes files, so no partial acceptance of a tampered batch.
    const rootAbs = resolvePath(vaultRoot)
    for (const t of targetOutlines) {
      const abs = resolvePath(vaultRoot, t)
      if (!abs.startsWith(rootAbs + pathSep)) return null
    }
    const result = lib.adoptVersion(vaultRoot, id, String(versionMarkdown ?? ''), targetOutlines)
    // Adoption rewrote those outlines on disk behind the search index's back — drop the
    // affected talks' cache entries (same invalidation vault:set-root relies on) so the
    // Browser reflects the adopted content on its next query.
    for (const r of result?.replaced ?? []) {
      try { searchCache.delete(join(vaultRoot, r.outline)) } catch { /* cache only */ }
    }
    return result
  } catch { return null }
})

// ── Duplicate merge IPC (ADR-0032) ──────────────────────────────────────────
// Thin wrapper over the engine's 15-slide-merge.mjs. Same house rules as ledger:adopt: EVERY
// target outline must resolve inside the vault (whole call rejected → null on any escape, no
// partial acceptance of a tampered batch), and every failure returns null — never a throw into
// the renderer. Targets arrive with `outline` as an absolute path or a vault-relative path (the
// Browser rows carry outlinePath); we guard, then relativise, so the engine always sees a clean
// vault-relative outline (its join(vaultRoot, outline) assumes that).
async function mergeLib(): Promise<any | null> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  return import(pathToFileURL(join(compilerDir, 'lib/15-slide-merge.mjs')).href)
}

ipcMain.handle(
  'ledger:merge-duplicates',
  async (_event, targets: Array<{ outline: string; heading: string; occurrence: number }>) => {
    if (!Array.isArray(targets) || targets.length === 0) return null
    if (targets.some((t) => !t || typeof t.outline !== 'string' || typeof t.heading !== 'string')) return null
    try {
      const vaultRoot = getConfig('vaultRoot', undefined)
      const lib = await mergeLib()
      if (!vaultRoot || !lib) return null
      const rootAbs = resolvePath(vaultRoot)
      // Guard every target inside the vault, then normalise `outline` to vault-relative.
      const safeTargets: Array<{ outline: string; heading: string; occurrence: number }> = []
      for (const t of targets) {
        const abs = resolvePath(vaultRoot, t.outline)
        if (abs !== rootAbs && !abs.startsWith(rootAbs + pathSep)) return null
        safeTargets.push({
          outline: relativePath(vaultRoot, abs),
          heading: t.heading,
          occurrence: Number.isFinite(t.occurrence) ? t.occurrence : 1
        })
      }
      const result = lib.mergeDuplicateSlides(vaultRoot, safeTargets, { now: Date.now() })
      // Merge rewrote those outlines behind the search index's back — drop the affected talks'
      // cache entries (same invalidation ledger:adopt relies on) so the Browser reflects the shared
      // id on its next query. Applies to every touched outline, merged or failed-after-write.
      const touched = new Set<string>()
      for (const r of result?.merged ?? []) touched.add(r.outline)
      for (const r of result?.failed ?? []) touched.add(r.outline)
      for (const rel of touched) {
        try { searchCache.delete(join(vaultRoot, rel)) } catch { /* cache only */ }
      }
      return result
    } catch { return null }
  }
)

// Version thumbnails for one slide id: a real compiled render of EVERY recorded version,
// following the layout:preview-thumbnails pattern — synthetic outline → prepareSource →
// buildPerSlideProjections → renderThumbnails. All versions ride in ONE synthetic outline
// (newest first, listVersions order), so the whole id renders in a single hidden-window
// pass; navigateToSlide toggles .active by INDEX, so versions sharing the same {id=…}
// cannot mis-navigate. Content-addressed under cacheSlug '__ledger__' by
// sha1(version.file + version.markdown) — re-opening a version history is cache-free.
ipcMain.handle('ledger:version-thumbnails', async (_event, id: string) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const vaultRoot = getConfig('vaultRoot', undefined)
    const lib = await ledgerLib()
    if (!vaultRoot || !lib) return null
    const versions = (lib.listVersions(vaultRoot, id) ?? []) as Array<{ file: string; markdown: string }>
    if (!versions.length) return {}

    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const { buildPerSlideProjections } = await import(pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href)

    const keyFor = (v: { file: string; markdown: string }): string =>
      createHash('sha1').update(v.file + v.markdown).digest('hex').slice(0, 16)
    const cacheSlug = '__ledger__'
    const cacheDir = join(app.getPath('userData'), thumbCacheRoot(), cacheSlug)

    const outline =
      '---\ntitle: version preview\n---\n\n' + versions.map((v) => v.markdown).join('\n\n') + '\n'
    // Pool refs (img-/vid-) resolve against the vault so version renders show their images;
    // relative assets/ refs cannot resolve from a temp dir and render as-is (acceptable: the
    // version store keeps markdown only, exactly like the diff view).
    const resolved = resolveImageRefs(outline, vaultRoot)
    const work = join(tmpdir(), `tw-version-thumbs-${randomBytes(6).toString('hex')}`)
    mkdirSync(work, { recursive: true })
    const outlinePath = join(work, `${cacheSlug}-outline.md`)
    writeFileSync(outlinePath, resolved, 'utf8')
    const stat = statSync(outlinePath)
    const model = await prepareSource(outlinePath, resolved, cacheSlug, stat)
    const rows = (buildPerSlideProjections(model, cacheSlug) ?? []) as Array<{
      source_line?: number | null
      render_hash?: string
      content_hash?: string
    }>

    // renderThumbnails addresses slides by deck INDEX, so pass every row in order; authored
    // rows (source_line set) map 1:1, in order, onto the versions that produced them —
    // synthesized cover/closing rows keep their own render_hash key and are simply unused.
    const authoredIndexes = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.source_line != null)
      .map(({ i }) => i)
    const keyByRowIndex = new Map<number, string>()
    authoredIndexes.forEach((rowIndex, vi) => {
      if (vi < versions.length) keyByRowIndex.set(rowIndex, keyFor(versions[vi]))
    })
    const slides = rows.map((r, i) => ({
      key: keyByRowIndex.get(i) ?? r.render_hash ?? r.content_hash ?? `row-${i}`
    }))
    const rendered = await renderThumbnails({ fullHtml: model.fullHtml as string, slides, cacheDir })

    const out: Record<string, string> = {}
    versions.forEach((v, vi) => {
      if (vi >= authoredIndexes.length) return
      const key = keyFor(v)
      if (rendered[key]) out[v.file] = 'twthumb://' + cacheSlug + '/' + key
    })
    try { rmSync(work, { recursive: true, force: true }) } catch { /* temp only */ }
    return out
  } catch (e) {
    console.error('[ledger:version-thumbnails]', e)
    return null
  }
})

// ── Present ────────────────────────────────────────────────────────────────

type PresentBuild = { slug: string; title: string; html: string; presentPath: string }

async function compileTalkForPresent(outlinePath: string, content: string): Promise<Omit<PresentBuild, 'presentPath'>> {
  // Goes through the shared prepared-model memo: F5 right after an edit pause (same content the
  // strip just compiled with different defaults) still recompiles, but repeated F5s don't.
  const prepared = await prepareTalk(outlinePath, content, timerSettings())
  if (!prepared) throw new Error('Compiler not found')
  return {
    slug: prepared.slug,
    title: String((prepared.model.title as string) ?? prepared.slug),
    html: String(prepared.model.fullHtml ?? '')
  }
}

function writeTalkPresentHtml(outlinePath: string, slug: string, html: string, allowTmpFallback: boolean, pathwayId?: string): string {
  const talkDir = dirname(outlinePath)
  const pathwaySuffix = pathwayId ? '-pathway-' + pathwayId.replace(/[^a-zA-Z0-9_-]/g, '-') : ''
  let presentPath = join(talkDir, slug + pathwaySuffix + '-present.html')
  try {
    writeFileSync(presentPath, html, 'utf8')
  } catch (writeErr) {
    if (!allowTmpFallback) throw writeErr
    console.warn('[present] talk dir not writable, using tmpdir (iframes may 404):', writeErr)
    presentPath = join(tmpdir(), slug + pathwaySuffix + '-present.html')
    writeFileSync(presentPath, html, 'utf8')
  }
  return presentPath
}

async function buildTalkPresentFile(outlinePath: string, content: string, allowTmpFallback: boolean, pathwayId?: string): Promise<PresentBuild> {
  let compiled = await compileTalkForPresent(outlinePath, content)
  if (pathwayId) {
    const vaultRoot = getConfig('vaultRoot', undefined)
    if (!vaultRoot) throw new Error('Choose a Vault before presenting a pathway.')
    const prepared = await prepareTalk(outlinePath, content, timerSettings())
    const manifest = readPathwayManifest(vaultRoot, compiled.slug)
    const resolved = resolvePathways(manifest.pathways, (prepared?.rows ?? []) as PathwaySlideRow[])
      .find((pathway) => pathway.id === pathwayId)
    if (!resolved) throw new Error('That pathway no longer exists.')
    compiled = {
      ...compiled,
      html: injectPathwayRuntime(compiled.html, resolved.present.map((row) => row.slide_id), pathwayId)
    }
  }
  const presentPath = writeTalkPresentHtml(outlinePath, compiled.slug, compiled.html, allowTmpFallback, pathwayId)
  return { ...compiled, presentPath }
}

function talkBySlug(slug: string): TalkInfo | null {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return null
  return findTalks(vaultRoot).find((talk) => talk.slug === slug) ?? null
}

ipcMain.handle('talk:present', async (_event, outlinePath: string, content: string, mode?: string, startSlideId?: string, pathwayId?: string, plannedRunId?: string) => {
  try {
    const { slug, title, presentPath } = await buildTalkPresentFile(outlinePath, content, true, pathwayId)
    // Window title by role + talk (e.g. "TalkWeaver Presenter — AI 2026 Agents") so ⌘` / Mission
    // Control / the Window menu name each deck by what's in it. Kept via page-title-updated below.
    const roleLabel = mode === 'presenter' ? 'Presenter' : mode === 'audience' ? 'Audience' : 'Presentation'
    const winTitle = `TalkWeaver ${roleLabel} — ${title}`

    // Reuse an existing deck window for this talk+mode instead of spawning a duplicate: focus it and
    // refresh it in place with the freshly-compiled file. ⇧F5 (startSlideId set) jumps it to that
    // slide; plain F5 keeps its current slide. If a recording is armed, DON'T reload (that would drop
    // it) — just focus and hint. Menu-launched audience windows dedupe the same way (repeated clicks
    // used to multiply them); the runtime-launched audience (F5 inside the presenter) is a child
    // window that never comes through this handler.
    if (mode === 'presenter' || mode === 'window' || mode === 'audience') {
      for (const [wcId, info] of presentWindows) {
        if (info.outlinePath !== outlinePath || info.mode !== mode || info.pathwayId !== pathwayId) continue
        const existing = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === wcId)
        if (!existing) continue
        let hash = startSlideId || ''
        let rec = ''
        try {
          const s = await existing.webContents.executeJavaScript(
            "({ h: location.hash.startsWith('#') ? decodeURIComponent(location.hash.slice(1)) : '', r: ((document.getElementById('twrec-module')||{}).dataset||{}).rec || '' })"
          )
          if (!hash) hash = s.h
          rec = s.r
        } catch { /* fall through: refresh from the top */ }
        if (existing.isMinimized()) existing.restore()
        existing.setTitle(winTitle)
        existing.focus()
        const recordingArmed = rec && rec !== 'idle' && rec !== 'saved' && rec !== 'error'
        if (recordingArmed) {
          existing.webContents.send('present:hint', 'Already presenting — stop the recording (⇧R) to refresh this deck.')
        } else {
          // Cache-bust (_r) so the reused window truly reloads the freshly-compiled file.
          const reuseQuery: Record<string, string> =
            mode === 'presenter' ? { presenter: '1' } : mode === 'audience' ? { audience: '1' } : {}
          reuseQuery._r = String(++presentReloadNonce)
          const reuseOpts: { query: Record<string, string>; hash?: string } = { query: reuseQuery }
          if (hash) reuseOpts.hash = hash
          existing.loadFile(presentPath, reuseOpts)
          existing.webContents.once('did-finish-load', () => {
            if (!existing.isDestroyed()) existing.webContents.send('present:hint', '✓ Refreshed with your latest edits')
          })
          void ledgerSeal(outlinePath, content, 'present')
        }
        return { success: true }
      }
    }
    // Recording lives in the presenter view only: attach the opt-in recorder bridge preload there
    // (sandbox off so it can hand the audio buffer back). The recorder bridge ALSO mounts the ⌘E
    // "edit this slide" bridge. A plain presentation window gets the edit-only bridge; the audience
    // view stays preload-less + portable. (These windows are opened BY TalkWeaver, so a preload here
    // never touches the exported portable artifact.)
    const recording = mode === 'presenter'
    const bridgePreload =
      mode === 'presenter' ? join(__dirname, '../preload/presentRecorder.js')
      : mode === 'audience' ? null
      : join(__dirname, '../preload/presentEdit.js')
    const win = new BrowserWindow({
      width: 1440, height: 900, fullscreen: false,
      title: winTitle,
      backgroundColor: '#f7f3ea',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        ...(bridgePreload ? { preload: bridgePreload, sandbox: false } : {})
      }
    })
    // Keep our role+talk title — the deck HTML sets its own <title>, which would otherwise replace it.
    win.on('page-title-updated', (e) => e.preventDefault())
    win.setTitle(winTitle)
    if (recording) {
      // Grant the mic (bridge getUserMedia) and register this window's context so the bridge's
      // recording:context call returns the right talk. Clean up when the window closes.
      setupRecordingPermissions(win)
      const wcId = win.webContents.id
      // timerTargetMin: pacing reference (the presenter clock's warn threshold today; the real
      // talk-length target is refined when Studio surfaces it — Plans 2–3). Not load-bearing here.
      registerRecordingContext(wcId, {
        talkSlug: slug,
        talkTitle: title,
        timerTargetMin: timerSettings().warnAtMinutes,
        pathwayId: pathwayId ?? null,
        preferredPlannedRunId: plannedRunId ?? null
      })
      win.on('close', (event) => {
        if (!shouldOfferRunSave(wcId)) return
        event.preventDefault()
        sendRecordingCloseOffer(win)
      })
      win.on('closed', () => unregisterRecordingContext(wcId))
    }
    // mode: 'presenter' → presenter view (notes + controls); 'audience' → chromeless audience view;
    // anything else → the plain presentation window. The deck runtime reads ?presenter=1 / ?audience=1.
    const query = mode === 'presenter' ? { presenter: '1' } : mode === 'audience' ? { audience: '1' } : undefined
    // ⇧F5 present-from-here: the runtime reads location.hash on init and starts on the slide whose
    // dataset.id matches the id (09-output-builders.mjs). An unknown/empty id falls back to slide 0.
    const loadOpts: { query?: Record<string, string>; hash?: string } = {}
    if (query) loadOpts.query = query
    if (startSlideId) loadOpts.hash = startSlideId
    win.loadFile(presentPath, Object.keys(loadOpts).length ? loadOpts : undefined)
    // Track this deck for ⌘R refresh-in-place, and OWN ⌘R here: before-input-event preempts the
    // default menu's Reload accelerator (which would reload to slide 0 without recompiling).
    const deckWcId = win.webContents.id
    presentWindows.set(deckWcId, { outlinePath, mode: mode ?? 'window', pathwayId })
    win.on('closed', () => presentWindows.delete(deckWcId))
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      // 2026-07-08: F5 / ⇧F5 in a deck window REFRESH the deck in place (same as ⌘R), matching
      // the editor's F5 semantics — instead of falling through to the runtime's F5 binding,
      // which launches ANOTHER window (the audience view; still available via its button).
      if (input.key === 'F5' && !input.meta && !input.control && !input.alt) {
        event.preventDefault()
        void refreshDeckFromEditor(win)
        return
      }
      if (input.shift || input.alt) return
      if (!(input.meta || input.control) || input.key.toLowerCase() !== 'r') return
      event.preventDefault()
      void refreshDeckFromEditor(win)
    })
    // F5 in the presenter opens the audience view via window.open(?audience=1). Send it FULL-SCREEN
    // to a second display if one exists; otherwise leave it as a normal window on this screen.
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))
    win.webContents.on('did-create-window', (child, details) => {
      if (!details?.url || !details.url.includes('audience=1')) return
      // The presenter-spawned audience window gets its own role title too.
      child.on('page-title-updated', (e) => e.preventDefault())
      child.setTitle(`TalkWeaver Audience — ${title}`)
      try {
        const here = screen.getDisplayNearestPoint({ x: win.getBounds().x, y: win.getBounds().y })
        const external = screen.getAllDisplays().find((d) => d.id !== here.id)
        if (external) {
          child.setBounds(external.bounds)
          setTimeout(() => { try { child.setFullScreen(true) } catch { /* ignore */ } }, 120)
        }
      } catch (e) { console.warn('[present] audience display placement failed:', e) }
    })
    void ledgerSeal(outlinePath, content, 'present')
    return { success: true }
  } catch (e) {
    console.error('[present]', e)
    return { success: false, error: String(e) }
  }
})

// ⌘E in a live deck window (presenter / presentation window): bring the editor window to the front
// and jump it to this slide. The bridge sends the deck's current slide — its ledger id AND compiled
// index — and the renderer resolves whichever it can. The deck window is left open (recording, if
// any, keeps running); the user closes it themselves. No-op if the editor window is gone.
ipcMain.handle('present:edit-slide', (event, payload: { slideId?: string; index?: number }) => {
  // Target the editor window that has this deck's talk active (or the last-focused one as fallback).
  const deckInfo = presentWindows.get(event.sender.id)
  const win = targetEditorFor(deckInfo?.outlinePath ?? null)
  if (!win || win.isDestroyed()) return { ok: false }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('present:edit-slide', payload)
  return { ok: true }
})

// New editor window (⌘N) — for working on two presentations at once. A given talk can only be active
// in one window (window:claim-talk enforces it), so two windows always hold two different talks.
ipcMain.handle('window:new', () => { createWindow(); return { ok: true } })

// Same-talk guard (block-and-focus). The renderer calls this before switching a window to `outlinePath`.
// If ANOTHER editor window already has that talk active, focus it and refuse (the renderer keeps its
// current talk); otherwise record it as this window's active talk. null releases (window has no talk).
ipcMain.handle('window:claim-talk', (event, outlinePath: string | null) => {
  const entry = editorWindows.get(event.sender.id)
  if (outlinePath) {
    for (const [wcId, e] of editorWindows) {
      if (wcId !== event.sender.id && e.outlinePath === outlinePath && !e.win.isDestroyed()) {
        if (e.win.isMinimized()) e.win.restore()
        e.win.show()
        e.win.focus()
        return { ok: false, reason: 'open-elsewhere' }
      }
    }
  }
  if (entry) entry.outlinePath = outlinePath
  return { ok: true }
})

// Refresh-in-place (⌘R): the editor hands back the talk's current content; recompile it and reload
// the deck window at the slide it was on. Reuses the present-from-here hash so the reload lands in
// place. The preload persists across loadFile, so the ⌘E/⌘R bridges re-mount automatically.
ipcMain.handle('present:rebuild', async (_event, deckWcId: number, outlinePath: string, content: string, slideId?: string) => {
  try {
    const deck = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === deckWcId)
    if (!deck) return { ok: false }
    const info = presentWindows.get(deckWcId)
    const { presentPath } = await buildTalkPresentFile(outlinePath, content, true, info?.pathwayId)
    const mode = info?.mode
    // Cache-bust (_r) so this is a REAL navigation, not a same-URL no-op that skips the fresh file.
    const query: Record<string, string> = mode === 'presenter' ? { presenter: '1' } : mode === 'audience' ? { audience: '1' } : {}
    query._r = String(++presentReloadNonce)
    const loadOpts: { query: Record<string, string>; hash?: string } = { query }
    if (slideId) loadOpts.hash = slideId
    deck.loadFile(presentPath, loadOpts)
    // Confirm once the fresh page has loaded (the bridge re-mounts + registers its hint listener by then).
    deck.webContents.once('did-finish-load', () => {
      if (!deck.isDestroyed()) deck.webContents.send('present:hint', '✓ Refreshed with your latest edits')
    })
    return { ok: true }
  } catch (e) {
    console.error('[present:rebuild]', e)
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('replay:build', async (_event, talkSlug: string): Promise<{ success: boolean; url?: string; error?: string }> => {
  try {
    const slug = String(talkSlug || '').trim()
    if (!slug) return { success: false, error: 'Missing Talk slug' }
    const talk = talkBySlug(slug)
    if (!talk) return { success: false, error: 'Talk not found' }
    const content = readFileSync(talk.outlinePath, 'utf8')
    const built = await buildTalkPresentFile(talk.outlinePath, content, false)
    return {
      success: true,
      url: `twpresent://${encodeURIComponent(built.slug)}/${encodeURIComponent(basename(built.presentPath))}?replay=1&audience=1`
    }
  } catch (e) {
    console.error('[replay:build]', e)
    return { success: false, error: String(e) }
  }
})

// Presentation recording IPC (recording:context + recording:save). Registered once; the
// deps are read lazily per call, so this is safe at module scope (app not yet ready).
registerRecordingIpc({
  compilerDir: () => getCompilerPath(),
  userDataDir: () => app.getPath('userData'),
  vaultRoot: () => getConfig('vaultRoot', undefined) ?? null,
  discardThresholdMs: () => Math.max(0, Number(getConfig('recordingDiscardMs', 20000)) || 20000),
  r2Config: () => ({
    endpoint: getConfig('recordingR2Endpoint', undefined) ?? '',
    bucket: getConfig('recordingR2Bucket', undefined) ?? '',
    credsSource: getConfig('recordingR2CredsSource', 'settings') ?? 'settings',
    bwsSecretId: getConfig('recordingR2BwsSecretId', undefined) ?? ''
  }),
  readSafeKeys: () => readR2Keys(),
  testMode: () => process.env.TW_REC_TEST === '1'
})

// TalkWeaver History IPC (handout URLs + cached live checks). Registered once; deps are lazy.
registerHistoryIpc({
  userDataDir: () => app.getPath('userData'),
  vaultRoot: () => getConfig('vaultRoot', undefined) ?? null,
  listTalks: (root) => vaultIndex.cached(root),
  testMode: () => process.env.TW_REC_TEST === '1'
})

// Transcription IPC (Parakeet bridge + transcript store). Registered once; deps are lazy.
registerTranscriptionIpc({
  userDataDir: () => app.getPath('userData'),
  vaultRoot: () => getConfig('vaultRoot', undefined) ?? null,
  config: () => {
    const cfg = transcriptionSettings()
    return {
      python: expandHomePath(cfg.python),
      script: expandHomePath(cfg.script)
    }
  },
  testMode: () => process.env.TW_REC_TEST === '1'
})

// ── Build ──────────────────────────────────────────────────────────────────

ipcMain.handle('talk:build', async (_event, outlinePath: string, content: string) => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return { success: false, error: 'Compiler not found' }
  try {
    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const talkDir = dirname(outlinePath)
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const vaultRoot = getConfig('vaultRoot', undefined)
    const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content
    const model = await prepareSource(outlinePath, resolved, slug, stat, timerSettings())
    const html = model.fullHtml as string
    const distDir = join(talkDir, 'dist')
    if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })
    const outPath = join(distDir, slug + '.html')
    writeFileSync(outPath, html, 'utf8')
    return { success: true, outPath }
  } catch (e) {
    console.error('[build]', e)
    return { success: false, error: String(e) }
  }
})

// ── Build variants (ADR-0012): full + share-notes + share-no-notes + projections JSONL ──
ipcMain.handle('talk:build-variants', async (_event, outlinePath: string, content: string) => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return { success: false, error: 'Compiler not found' }
  try {
    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const talkDir = dirname(outlinePath)
    const vaultRoot = getConfig('vaultRoot', undefined)
    const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content

    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const model = await prepareSource(outlinePath, resolved, slug, stat, timerSettings())

    const distDir = join(talkDir, 'dist')
    if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })

    const title = (model.title as string) ?? slug
    const fullHtml = model.fullHtml as string
    const outPaths: string[] = []

    const fullPath = join(distDir, slug + '-full.html')
    writeFileSync(fullPath, fullHtml, 'utf8')
    outPaths.push(fullPath)

    // Prefer the real lib builders so share variants match the CLI exactly.
    try {
      const { extractStyles, extractSlides } = await import(
        pathToFileURL(join(compilerDir, 'lib/04-html-extraction.mjs')).href
      )
      const { buildShareHtml } = await import(
        pathToFileURL(join(compilerDir, 'lib/09-output-builders.mjs')).href
      )
      const styles = extractStyles(fullHtml)
      const slides = extractSlides(fullHtml)
      const license = (model as { license?: unknown }).license
      const shareNotes = buildShareHtml({ title, slides, styles, includeNotes: true, slug, license })
      const shareNoNotes = buildShareHtml({ title, slides, styles, includeNotes: false, slug, license })
      const notesPath = join(distDir, slug + '-share-notes.html')
      const noNotesPath = join(distDir, slug + '-share-no-notes.html')
      writeFileSync(notesPath, shareNotes, 'utf8')
      writeFileSync(noNotesPath, shareNoNotes, 'utf8')
      outPaths.push(notesPath, noNotesPath)
    } catch (builderErr) {
      // Fallback: full as both, notes crudely stripped. Logged loudly per spec.
      console.warn('[build-variants] real share builders unavailable, using FALLBACK:', builderErr)
      const stripped = fullHtml.replace(
        /<aside\b[^>]*class=["'][^"']*\bnotes\b[^"']*["'][^>]*>[\s\S]*?<\/aside>/gi,
        ''
      )
      const notesPath = join(distDir, slug + '-share-notes.html')
      const noNotesPath = join(distDir, slug + '-share-no-notes.html')
      writeFileSync(notesPath, fullHtml, 'utf8')
      writeFileSync(noNotesPath, stripped, 'utf8')
      outPaths.push(notesPath, noNotesPath)
    }

    // Per-slide projections JSONL alongside the variants.
    try {
      const { buildPerSlideProjections } = await import(
        pathToFileURL(join(compilerDir, 'lib/10-projections.mjs')).href
      )
      const rows = buildPerSlideProjections(model, slug)
      if (rows && rows.length) {
        const jsonl = rows.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n'
        const jsonlPath = join(distDir, slug + '-projections.jsonl')
        writeFileSync(jsonlPath, jsonl, 'utf8')
        outPaths.push(jsonlPath)
      }
    } catch (projErr) {
      console.warn('[build-variants] projections not written:', projErr)
    }

    return { success: true, outPaths }
  } catch (e) {
    console.error('[build-variants]', e)
    return { success: false, error: String(e) }
  }
})

type RunHandoutArtifact = {
  path: string
  html: string
  title: string
  slug: string
  slideIds: string[]
  missing: string[]
}

async function buildRunHandoutArtifact(talk: TalkInfo, run: RunRecord, outputSlug?: string): Promise<RunHandoutArtifact> {
  const compilerDir = getCompilerPath()
  if (!compilerDir) throw new Error('Compiler not found')
  const content = readFileSync(talk.outlinePath, 'utf8')
  let compiled = await compileTalkForPresent(talk.outlinePath, content)
  let slideIds: string[] = []
  let missing: string[] = []
  if (run.slideSet.kind === 'pathway') {
    const pathwayId = run.slideSet.pathwayId
    const vaultRoot = getConfig('vaultRoot', undefined)
    if (!vaultRoot) throw new Error('Choose a Vault before building a Run handout.')
    const prepared = await prepareTalk(talk.outlinePath, content, timerSettings())
    const manifest = readPathwayManifest(vaultRoot, talk.slug)
    const resolved = resolvePathways(manifest.pathways, (prepared?.rows ?? []) as PathwaySlideRow[])
      .find((pathway) => pathway.id === pathwayId)
    if (!resolved) throw new Error('The Run pathway no longer exists.')
    slideIds = resolved.present.map((row) => row.slide_id)
    missing = resolved.missing
    compiled = { ...compiled, html: injectPathwayRuntime(compiled.html, slideIds, pathwayId) }
  } else {
    const prepared = await prepareTalk(talk.outlinePath, content, timerSettings())
    slideIds = ((prepared?.rows ?? []) as PathwaySlideRow[]).map((row) => row.slide_id)
  }

  const datedHtml = injectRunCoverMetadata(compiled.html, run.eventTitle ?? run.talkTitle, run.plannedDate ?? run.startedAt.slice(0, 10))
  const { extractStyles, extractSlides } = await import(pathToFileURL(join(compilerDir, 'lib/04-html-extraction.mjs')).href)
  const { buildShareHtml } = await import(pathToFileURL(join(compilerDir, 'lib/09-output-builders.mjs')).href)
  const styles = extractStyles(datedHtml)
  const slides = extractSlides(datedHtml)
  const slug = outputSlug ?? runHandoutSlug(talk.slug, run.eventTitle ?? 'run', run.plannedDate ?? run.startedAt.slice(0, 10), [])
  const html = buildShareHtml({ title: compiled.title, slides, styles, includeNotes: false, slug }) as string
  const distDir = join(dirname(talk.outlinePath), 'dist')
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })
  const path = join(distDir, `${slug}-handout.html`)
  writeFileSync(path, html, 'utf8')
  return { path, html, title: compiled.title, slug, slideIds, missing }
}

// ── Export handout (Phase 1) — the audience-facing reading HTML (ADR-0012 share-no-notes). One
// focused artefact written to dist/{slug}-handout.html, NOT the whole variant set. Matches the CLI
// exactly via the real buildShareHtml(includeNotes:false) — the same content the compiler's launcher
// treats as the handout. Phase 2 (Cloudflare Pages publish) builds on this.
ipcMain.handle('talk:export-handout', async (_event, outlinePath: string, content: string) => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return { success: false, error: 'Compiler not found' }
  try {
    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const talkDir = dirname(outlinePath)
    const vaultRoot = getConfig('vaultRoot', undefined)
    const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content

    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const model = await prepareSource(outlinePath, resolved, slug, stat)
    const title = (model.title as string) ?? slug
    const fullHtml = model.fullHtml as string

    const { extractStyles, extractSlides } = await import(
      pathToFileURL(join(compilerDir, 'lib/04-html-extraction.mjs')).href
    )
    const { buildShareHtml } = await import(pathToFileURL(join(compilerDir, 'lib/09-output-builders.mjs')).href)
    const styles = extractStyles(fullHtml)
    const slides = extractSlides(fullHtml)
    const license = (model as { license?: unknown }).license
    const handoutHtml = buildShareHtml({ title, slides, styles, includeNotes: false, slug, license })

    const distDir = join(talkDir, 'dist')
    if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })
    const handoutPath = join(distDir, slug + '-handout.html')
    writeFileSync(handoutPath, handoutHtml, 'utf8')
    void ledgerSeal(outlinePath, content, 'export')
    return { success: true, path: handoutPath }
  } catch (e) {
    console.error('[export-handout]', e)
    return { success: false, error: String(e) }
  }
})

// ── Publish handout — in-app, config-driven Cloudflare Pages publishing (no external repo) ──────
// Build the share-no-notes handout in-process (same path as talk:export-handout), write it into a
// local accumulating "site" dir, then deploy the WHOLE dir via wrangler with the user's own
// credentials. Optionally (publishUseShortIds) assign a stable short id and regenerate _redirects so
// the link is <base>/<id>. The API token is read from the OS keychain (safeStorage); the user's
// account/project/domain come from config.json (Settings → Publishing). Nothing private is bundled.

function publishSiteDir(): string {
  return getConfig('publishSiteDir', undefined) ?? join(app.getPath('userData'), 'cloudflare-pages-site')
}
function handoutRegistryPath(): string {
  return join(app.getPath('userData'), 'handout-registry.json')
}
function readHandoutRegistry(): Record<string, string> {
  try {
    const r = JSON.parse(readFileSync(handoutRegistryPath(), 'utf8'))
    return r && typeof r === 'object' ? (r as Record<string, string>) : {}
  } catch {
    return {}
  }
}
function writeHandoutRegistry(reg: Record<string, string>): void {
  writeFileSync(handoutRegistryPath(), JSON.stringify(reg, null, 2), 'utf8')
}
// True if a `wrangler` executable exists in any dir of the augmented PATH.
function wranglerFoundOn(pathStr: string): boolean {
  for (const dir of pathStr.split(':')) {
    if (dir && existsSync(join(dir, 'wrangler'))) return true
  }
  return false
}

// Slim the PUBLISHED handout so each file stays under Cloudflare Pages' 25 MiB/file cap (the local
// build stays pristine — this operates on the in-memory copy only). Ported from the proven
// The handout builder: (1) drops the data of large inlined videos to a "plays live" note;
// (2) recompress big inlined PNGs to near-lossless WebP (cwebp), falling back to sips JPEG, never
// growing a file. Best-effort: if cwebp/sips are missing it returns the html unchanged.
function slimHandoutHtml(html: string): string {
  const HANDOUT_VIDEO_LIMIT = 8 * 1024 * 1024
  html = html.replace(/<figure class="slide-figure slide-video"[^>]*>[\s\S]*?<\/figure>/g, (fig) => {
    if (/video-placeholder/.test(fig)) return fig
    const data = fig.match(/src="data:video\/[^;]+;base64,([A-Za-z0-9+/=]+)"/)
    const bytes = data ? Math.floor(data[1].length * 0.75) : Infinity
    if (bytes <= HANDOUT_VIDEO_LIMIT) return fig
    return '<figure class="slide-figure slide-video video-placeholder"><div class="video-placeholder-note"><span class="vp-glyph" aria-hidden="true">▶</span><span>Video plays in the live presentation</span></div></figure>'
  })
  const CWEBP = existsSync('/opt/homebrew/bin/cwebp') ? '/opt/homebrew/bin/cwebp' : 'cwebp'
  const MAX_DIM = 2400
  const BUDGET = 2 * 1024 * 1024
  let tmp: string
  try { tmp = mkdtempSync(join(tmpdir(), 'handout-slim-')) } catch { return html }
  let idx = 0
  try {
    html = html.replace(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g, (match, b64) => {
      if (b64.length < 300 * 1024 * 1.34) return match // skip small images
      const i = idx++
      const pngPath = join(tmp, `i${i}.png`)
      writeFileSync(pngPath, Buffer.from(b64, 'base64'))
      const origBytes = Buffer.byteLength(b64, 'base64')
      let resize: string[] = []
      try {
        const g = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', pngPath], { encoding: 'utf8' })
        const w = Number((g.match(/pixelWidth:\s*(\d+)/) || [])[1]) || 0
        const h = Number((g.match(/pixelHeight:\s*(\d+)/) || [])[1]) || 0
        if (Math.max(w, h) > MAX_DIM) resize = w >= h ? ['-resize', String(MAX_DIM), '0'] : ['-resize', '0', String(MAX_DIM)]
      } catch { /* dims unknown → encode at native size */ }
      const webpPath = join(tmp, `i${i}.webp`)
      try {
        execFileSync(CWEBP, ['-quiet', '-near_lossless', '60', ...resize, pngPath, '-o', webpPath], { stdio: 'ignore' })
        let out = readFileSync(webpPath)
        if (out.length > BUDGET) {
          execFileSync(CWEBP, ['-quiet', '-q', '80', ...resize, pngPath, '-o', webpPath], { stdio: 'ignore' })
          out = readFileSync(webpPath)
        }
        if (out.length >= origBytes) return match // never grow a file
        return 'data:image/webp;base64,' + out.toString('base64')
      } catch {
        try {
          const jpgPath = join(tmp, `i${i}.jpg`)
          execFileSync('sips', ['-Z', String(MAX_DIM), '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', pngPath, '--out', jpgPath], { stdio: 'ignore' })
          return 'data:image/jpeg;base64,' + readFileSync(jpgPath).toString('base64')
        } catch { return match }
      }
    })
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  return html
}

// The handout's landing/viewer page (Open + Download + QR + short link) — the same page the old
// the handout builder produced. The Open/Download buttons point at the sibling handout file.
function viewerPageHtml(opts: { title: string; handoutFile: string; url: string; qr: string }): string {
  const display = opts.url.replace(/^https?:\/\//, '')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlAttr(opts.title)} — handout</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #f7f3ea; color: #17202a; margin: 0; display: grid; place-items: center; min-height: 96vh; }
  main { text-align: center; padding: 28px; max-width: 640px; }
  h1 { font-family: Georgia, serif; font-weight: 500; font-size: clamp(26px, 5vw, 40px); margin: 0 0 6px; }
  p.sub { color: #5b6470; margin: 0 0 26px; }
  .actions { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin-bottom: 30px; }
  a.btn { display: inline-block; padding: 13px 26px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 17px; }
  a.open { background: #0b3a6b; color: #fff; }
  a.dl { border: 2px solid #0b3a6b; color: #0b3a6b; }
  .qr { width: 150px; margin: 0 auto; opacity: 0.9; }
  .qr svg { width: 100%; height: auto; }
  p.tiny { color: #8a93a0; font-size: 13px; }
</style></head>
<body><main>
  <h1>${escapeHtmlAttr(opts.title)}</h1>
  <p class="sub">Slides handout — browse online or keep a copy. It is one self-contained file; everything works offline.</p>
  <div class="actions">
    <a class="btn open" href="${opts.handoutFile}">Open the slides</a>
    <a class="btn dl" href="${opts.handoutFile}" download="${opts.handoutFile}">Download</a>
  </div>
  <div class="qr">${opts.qr}</div>
  <p class="tiny">${escapeHtmlAttr(display)}</p>
</main></body></html>
`
}
function escapeHtmlAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

ipcMain.handle('talk:publish-handout', async (_event, outlinePath: string, content: string) => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return { success: false, error: 'Compiler not found' }

  const accountId = getConfig('cfAccountId', undefined)
  const project = getConfig('cfPagesProject', undefined)
  const baseUrl = getConfig('publishBaseUrl', undefined)
  const useShortIds = getConfig('publishUseShortIds', false) ?? false
  const prodBranch = getConfig('publishProdBranch', undefined) ?? 'main'
  const token = readToken()

  const PATH = augmentedPath(process.env.PATH)
  const wranglerFound = wranglerFoundOn(PATH)

  const pre = checkPreconditions({
    accountId: accountId as string | undefined,
    project: project as string | undefined,
    hasToken: !!token,
    wranglerFound
  })
  if (!pre.ok) return { success: false, error: pre.error }

  try {
    // Flush the latest editor text to disk first (we may stamp handout_url back into it below).
    try { writeFileSync(outlinePath, content, 'utf8') } catch { /* fall through */ }

    const stat = statSync(outlinePath)
    const slug = basename(outlinePath).replace('-outline.md', '')
    const vaultRoot = getConfig('vaultRoot', undefined)
    const resolved = vaultRoot ? resolveImageRefs(content, vaultRoot) : content

    // Build the handout HTML exactly like talk:export-handout (share-no-notes).
    const { prepareSource } = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
    const model = await prepareSource(outlinePath, resolved, slug, stat)
    // Title for the handout <title> + viewer page: prefer the outline's frontmatter `title:`
    // (the canonical deck title), like the old publisher did — model.title falls back to the slug
    // for plain-markdown decks the v1 adapter routes, which would show the slug instead of the title.
    const fmTitle = (content.match(/^title:\s*["']?(.+?)["']?\s*$/m) || [])[1]
    const title = (fmTitle && fmTitle.trim()) || (model.title as string) || slug
    const fullHtml = model.fullHtml as string
    const { extractStyles, extractSlides } = await import(
      pathToFileURL(join(compilerDir, 'lib/04-html-extraction.mjs')).href
    )
    const { buildShareHtml } = await import(pathToFileURL(join(compilerDir, 'lib/09-output-builders.mjs')).href)
    const styles = extractStyles(fullHtml)
    const slides = extractSlides(fullHtml)
    const license = (model as { license?: unknown }).license
    const handoutHtml = buildShareHtml({ title, slides, styles, includeNotes: false, slug, license })

    // Publish output: each handout
    // folder gets the slimmed handout as <slug>.html PLUS a viewer/landing index.html (Open +
    // Download + QR + short link). The whole accumulating site dir is deployed so prior talks survive.
    const siteDir = publishSiteDir()
    const talkOutDir = join(siteDir, slug)
    if (!existsSync(talkOutDir)) mkdirSync(talkOutDir, { recursive: true })

    const base = resolveBase({ baseUrl: baseUrl as string | undefined, project: project as string })

    // Stable short id assigned BEFORE the URL/QR so the viewer page + _redirects carry the final link.
    let id: string | undefined
    if (useShortIds) {
      const registry = readHandoutRegistry()
      const recoveredId = recoverIdFromUrl(readHandoutUrl(content), base)
      const gen = (): string => generateShortId((n) => Uint8Array.from(randomBytes(n)))
      const picked = pickShortId({ registry, slug, recoveredId, gen })
      id = picked.id
      writeHandoutRegistry(picked.registry)
    }
    const url = publishUrl({ base, slug, id, useShortIds })

    // The handout file (slimmed for the 25 MiB/file Pages cap) + the viewer/landing page that links to it.
    const handoutFile = `${slug}.html`
    writeFileSync(join(talkOutDir, handoutFile), slimHandoutHtml(handoutHtml), 'utf8')
    const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
    const qr = (makeQrSvg(url) as string) || ''
    writeFileSync(join(talkOutDir, 'index.html'), viewerPageHtml({ title, handoutFile, url, qr }), 'utf8')

    // _redirects regenerated AFTER the viewer index.html exists (the scan keys off each folder's index.html).
    if (useShortIds) {
      const registry = readHandoutRegistry()
      const existingSlugs = readdirSync(siteDir).filter((n) => existsSync(join(siteDir, n, 'index.html')))
      writeFileSync(join(siteDir, '_redirects'), buildRedirects(registry, existingSlugs), 'utf8')
    }

    // Deploy the whole site dir via wrangler with the user's credentials. execFile resolves the
    // `wrangler` command using the PATH in env (homebrew/usr/local cover global npm installs).
    const env = {
      ...process.env,
      PATH,
      CLOUDFLARE_API_TOKEN: token as string,
      CLOUDFLARE_ACCOUNT_ID: accountId as string
    }
    // cwd MUST be a writable dir: a packaged .app launched from Finder/`open` inherits CWD `/`, so
    // wrangler can't create its `./.wrangler/tmp` scratch (fails with "Missing file or directory:
    // /.wrangler/tmp"). Use userData — writable, app-owned, and the PARENT of siteDir so the scratch
    // dir is never inside (and thus never deployed with) the published folder.
    const wranglerCwd = app.getPath('userData')
    const deploy = await new Promise<{ ok: boolean; err?: string }>((resolveP) => {
      execFile(
        'wrangler',
        ['pages', 'deploy', siteDir, '--project-name', project as string, '--branch', prodBranch, '--commit-dirty=true'],
        { cwd: wranglerCwd, env, timeout: 180000, maxBuffer: 64 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) resolveP({ ok: false, err: String(stderr || error.message).slice(-600) })
          else resolveP({ ok: true })
        }
      )
    })
    if (!deploy.ok) return { success: false, error: `wrangler deploy failed: ${deploy.err}` }

    // Best-effort: stamp handout_url into the outline frontmatter so the renderer adopts it (and the
    // short id is recoverable later). No frontmatter → left unchanged.
    const updatedOutline = stampHandoutUrl(content, url)
    if (updatedOutline !== content) {
      try { writeFileSync(outlinePath, updatedOutline, 'utf8') } catch { /* keep going */ }
    }
    void ledgerSeal(outlinePath, content, 'publish')
    return { success: true, url, display: url, updatedOutline }
  } catch (e) {
    console.error('[publish-handout]', e)
    return { success: false, error: String(e) }
  }
})

async function deployPublishedSite(siteDir: string): Promise<{ ok: boolean; error?: string }> {
  if (process.env.TW_REC_TEST === '1') return { ok: true }
  const accountId = getConfig('cfAccountId', undefined)
  const project = getConfig('cfPagesProject', undefined)
  const prodBranch = getConfig('publishProdBranch', undefined) ?? 'main'
  const token = readToken()
  const PATH = augmentedPath(process.env.PATH)
  const pre = checkPreconditions({
    accountId: accountId as string | undefined,
    project: project as string | undefined,
    hasToken: !!token,
    wranglerFound: wranglerFoundOn(PATH)
  })
  if (!pre.ok) return { ok: false, error: pre.error }
  const env = { ...process.env, PATH, CLOUDFLARE_API_TOKEN: token as string, CLOUDFLARE_ACCOUNT_ID: accountId as string }
  return new Promise((resolveP) => {
    execFile('wrangler', ['pages', 'deploy', siteDir, '--project-name', project as string, '--branch', prodBranch, '--commit-dirty=true'], {
      cwd: app.getPath('userData'), env, timeout: 180000, maxBuffer: 64 * 1024 * 1024
    }, (error, _stdout, stderr) => {
      resolveP(error ? { ok: false, error: `wrangler deploy failed: ${String(stderr || error.message).slice(-600)}` } : { ok: true })
    })
  })
}

ipcMain.handle('run:build-handout', async (_event, payload: { talkSlug: string; runId: string }) => {
  try {
    const vault = getConfig('vaultRoot', undefined)
    if (!vault) return { success: false, error: 'no-vault' }
    const run = readRun(vault, String(payload.talkSlug), String(payload.runId))
    const talk = talkBySlug(String(payload.talkSlug))
    if (!run || !talk) return { success: false, error: 'run-or-talk-not-found' }
    const artifact = await buildRunHandoutArtifact(talk, run)
    return { success: true, path: artifact.path, slideIds: artifact.slideIds, missing: artifact.missing }
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
})

ipcMain.handle('run:publish-handout', async (_event, payload: { talkSlug: string; runId: string }) => {
  try {
    const vault = getConfig('vaultRoot', undefined)
    if (!vault) return { success: false, error: 'no-vault' }
    const run = readRun(vault, String(payload.talkSlug), String(payload.runId))
    const talk = talkBySlug(String(payload.talkSlug))
    if (!run || !talk || run.status !== 'delivered') return { success: false, error: 'delivered-run-not-found' }
    const project = getConfig('cfPagesProject', undefined) ?? (process.env.TW_REC_TEST === '1' ? 'talkweaver-test' : undefined)
    if (!project) return { success: false, error: 'Configure Cloudflare publishing in Settings → Publishing (see docs/PUBLISHING.md)' }
    const siteDir = publishSiteDir()
    if (!existsSync(siteDir)) mkdirSync(siteDir, { recursive: true })
    const existing = readdirSync(siteDir).filter((name) => existsSync(join(siteDir, name, 'index.html')))
    let stableSlug: string | undefined
    if (run.handoutUrl) {
      try {
        const pathPart = new URL(run.handoutUrl).pathname.split('/').filter(Boolean)[0]
        if (pathPart && existing.includes(pathPart)) stableSlug = pathPart
        if (!stableSlug) stableSlug = Object.entries(readHandoutRegistry()).find(([, id]) => id === pathPart)?.[0]
      } catch { /* derive a fresh collision-safe slug below */ }
    }
    const slug = stableSlug ?? runHandoutSlug(talk.slug, run.eventTitle ?? 'run', run.plannedDate ?? run.startedAt.slice(0, 10), existing)
    const artifact = await buildRunHandoutArtifact(talk, run, slug)
    const talkOutDir = join(siteDir, slug)
    if (!existsSync(talkOutDir)) mkdirSync(talkOutDir, { recursive: true })
    const handoutFile = `${slug}.html`
    writeFileSync(join(talkOutDir, handoutFile), slimHandoutHtml(artifact.html), 'utf8')

    const base = resolveBase({ baseUrl: getConfig('publishBaseUrl', undefined) ?? (process.env.TW_REC_TEST === '1' ? 'https://mock-run-handouts.test' : undefined), project })
    const useShortIds = getConfig('publishUseShortIds', false) ?? false
    let id: string | undefined
    if (useShortIds) {
      const registry = readHandoutRegistry()
      const picked = pickShortId({
        registry,
        slug,
        recoveredId: recoverIdFromUrl(run.handoutUrl, base),
        gen: () => generateShortId((n) => Uint8Array.from(randomBytes(n)))
      })
      id = picked.id
      writeHandoutRegistry(picked.registry)
    }
    const url = publishUrl({ base, slug, id, useShortIds })
    const compilerDir = getCompilerPath()
    if (!compilerDir) return { success: false, error: 'Compiler not found' }
    const { makeQrSvg } = await import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)
    writeFileSync(join(talkOutDir, 'index.html'), viewerPageHtml({ title: `${artifact.title} — ${run.eventTitle ?? 'Run'}`, handoutFile, url, qr: (makeQrSvg(url) as string) || '' }), 'utf8')
    if (useShortIds) {
      const registry = readHandoutRegistry()
      const slugs = readdirSync(siteDir).filter((name) => existsSync(join(siteDir, name, 'index.html')))
      writeFileSync(join(siteDir, '_redirects'), buildRedirects(registry, slugs), 'utf8')
    }
    const deployed = await deployPublishedSite(siteDir)
    if (!deployed.ok) return { success: false, error: deployed.error }
    persistRun(vault, setRunHandoutUrl(run, url))
    return { success: true, url, path: artifact.path, slideIds: artifact.slideIds, missing: artifact.missing }
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
})

ipcMain.handle('run:unpublish-handout', async (_event, payload: { talkSlug: string; runId: string }) => {
  try {
    const vault = getConfig('vaultRoot', undefined)
    if (!vault) return { success: false, error: 'no-vault' }
    const run = readRun(vault, String(payload.talkSlug), String(payload.runId))
    if (!run) return { success: false, error: 'run-not-found' }
    const siteDir = publishSiteDir()
    if (run.handoutUrl && existsSync(siteDir)) {
      const pathPart = new URL(run.handoutUrl).pathname.split('/').filter(Boolean)[0]
      const registry = readHandoutRegistry()
      const slug = existsSync(join(siteDir, pathPart)) ? pathPart : Object.entries(registry).find(([, id]) => id === pathPart)?.[0]
      if (slug) rmSync(join(siteDir, slug), { recursive: true, force: true })
      if (slug && registry[slug]) {
        delete registry[slug]
        writeHandoutRegistry(registry)
      }
      const slugs = readdirSync(siteDir).filter((name) => existsSync(join(siteDir, name, 'index.html')))
      writeFileSync(join(siteDir, '_redirects'), buildRedirects(registry, slugs), 'utf8')
      const deployed = await deployPublishedSite(siteDir)
      if (!deployed.ok) return { success: false, error: deployed.error }
    }
    persistRun(vault, clearRunHandoutUrl(run))
    return { success: true }
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
})

// ── Thumbnails (rendered per-slide PNG previews) ─────────────────────────────
// Optimize a talk's IMAGES to WebP: imported (Obsidian-era) talks carry large relative-path PNG/JPG
// images in their own assets/ folder — big files that make previews slow to render (and handouts
// fat). This converts each to WebP (q82, downscaled to a generous 2560px long side), rewrites the
// outline refs, and moves the originals to the OS Trash (recoverable). Vault-pool images
// (`img-XXXXXXX`, already WebP from paste), http/data URLs, and non-image refs are left alone.
// Returns the rewritten outline so the renderer can adopt it in place (avoiding an autosave clobber).
ipcMain.handle('talk:optimize-images', async (_event, outlinePath: string, content: string) => {
  try {
    const sharp = require('sharp')
    const talkDir = dirname(outlinePath)
    // Unique convertible refs: relative path ending .png/.jpg/.jpeg (not img- ids, urls, data:).
    const refs = new Set<string>()
    const re = /!\[[^\]]*\]\(([^)]+)\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const raw = m[1].trim().replace(/\s+"[^"]*"$/, '') // drop optional "title"
      if (/^(https?:|data:|img-)/.test(raw)) continue
      if (!/\.(png|jpe?g)$/i.test(raw)) continue
      refs.add(raw)
    }
    let newContent = content
    let converted = 0
    let savedBytes = 0
    const failed: string[] = []
    for (const ref of refs) {
      let rel = ref
      try { rel = decodeURIComponent(ref) } catch { rel = ref }
      const abs = rel.startsWith('/') ? rel : join(talkDir, rel)
      if (!existsSync(abs)) { failed.push(ref); continue }
      const webpRef = ref.replace(/\.(png|jpe?g)$/i, '.webp') // keep the ref's encoding form
      const webpRel = rel.replace(/\.(png|jpe?g)$/i, '.webp')
      const webpAbs = webpRel.startsWith('/') ? webpRel : join(talkDir, webpRel)
      try {
        const before = statSync(abs).size
        await sharp(abs)
          .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toFile(webpAbs)
        const after = statSync(webpAbs).size
        newContent = newContent.split(ref).join(webpRef)
        savedBytes += Math.max(0, before - after)
        converted += 1
        if (resolvePath(webpAbs) !== resolvePath(abs)) {
          try { await shell.trashItem(abs) } catch { /* leave the original if trashing fails */ }
        }
      } catch (convErr) {
        console.warn('[optimize-images] failed for', ref, convErr)
        failed.push(ref)
      }
    }
    if (converted > 0) {
      writeFileSync(outlinePath, newContent, 'utf8')
      searchCache.clear()
      invalidateTalkCache()
    }
    return { success: true, converted, savedBytes, failed: failed.length, newContent }
  } catch (e) {
    console.error('[optimize-images]', e)
    return { success: false, error: String(e) }
  }
})

// Cross-talk reuse (ADR-0003/0020): when a slide is inserted from ANOTHER talk, its relative-path
// images (`assets/foo.png`, relative to the SOURCE talk) would break in the destination talk (no
// such file beside it → grey placeholder). Materialize each into the VAULT POOL — content-addressed
// `_assets/img-<hash>.<ext>` (WebP-normalised like paste), which resolves from ANY talk — and rewrite
// the slide markdown's refs to `img-<hash>`. Pool ids / http / data refs are left alone. Returns the
// rewritten markdown (the renderer inserts THAT). `sourceOutlinePath` locates the source assets.
ipcMain.handle('talk:materialize-slide-assets', async (_event, sourceOutlinePath: string, markdown: string) => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return { success: false, error: 'No vault root', markdown }
  try {
    const srcDir = dirname(sourceOutlinePath)
    const assetsDir = join(vaultRoot, '_assets')
    if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true })
    const refs = new Set<string>()
    const re = /!\[[^\]]*\]\(([^)]+)\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(markdown)) !== null) {
      const raw = m[1].trim().replace(/\s+"[^"]*"$/, '')
      if (/^(https?:|data:|img-)/.test(raw)) continue
      if (!/\.(png|jpe?g|gif|webp)$/i.test(raw)) continue
      refs.add(raw)
    }
    let out = markdown
    let materialized = 0
    for (const ref of refs) {
      let rel = ref
      try { rel = decodeURIComponent(ref) } catch { rel = ref }
      const abs = rel.startsWith('/') ? rel : join(srcDir, rel)
      if (!existsSync(abs)) continue
      try {
        const origBuf = readFileSync(abs)
        const originalFormat = extname(abs).slice(1).toLowerCase() || 'png'
        let storeBuf: Buffer = origBuf
        let storeExt = originalFormat
        try {
          const webp = await normaliseToWebp(origBuf)
          if (webp.length > 0 && webp.length <= origBuf.length) { storeBuf = webp; storeExt = 'webp' }
        } catch { /* keep original format */ }
        const hash = createHash('sha256').update(storeBuf).digest('hex').slice(0, 7)
        const id = 'img-' + hash
        const assetPath = join(assetsDir, id + '.' + storeExt)
        if (!existsSync(assetPath)) {
          writeFileSync(assetPath, storeBuf)
          const sidecarPath = join(assetsDir, id + '.yml')
          if (!existsSync(sidecarPath)) {
            writeFileSync(sidecarPath, [
              'id: ' + id,
              'created: ' + new Date().toISOString().slice(0, 10),
              'original_format: ' + originalFormat,
              'note: "materialized from cross-talk reuse"',
              'alt: ""', 'caption: ""', 'source: ""', 'tags: []'
            ].join('\n') + '\n', 'utf8')
          }
        }
        out = out.split(ref).join(id) // ![alt](assets/foo.png) → ![alt](img-hash)
        materialized += 1
      } catch (e) { console.warn('[materialize-slide-assets] failed for', ref, e) }
    }
    return { success: true, markdown: out, materialized }
  } catch (e) {
    console.error('[materialize-slide-assets]', e)
    return { success: false, error: String(e), markdown }
  }
})

// Vault-wide asset index (basename → absolute path), built lazily and cached. Used to heal relative
// image refs in PASTED slide markdown, which — unlike picker insert — carries no source path, so we
// locate `assets/<name>` by FILENAME anywhere in the vault.
let vaultAssetIndex: Map<string, string> | null = null
function buildVaultAssetIndex(vaultRoot: string): Map<string, string> {
  const idx = new Map<string, string>()
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: ReturnType<typeof readdirSync>
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'dist' && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p, depth + 1)
      } else if (/\.(png|jpe?g|gif|webp)$/i.test(e.name) && !idx.has(e.name)) {
        idx.set(e.name, p)
      }
    }
  }
  walk(vaultRoot, 0)
  return idx
}

// Cross-talk reuse via TEXT PASTE: the picker materialises a slide's relative images using its
// source path, but pasted markdown has none. Resolve each relative `assets/<name>` ref by FILENAME
// across the vault, copy it into the content-addressed pool (img-<hash>, WebP-normalised), and
// rewrite the ref — so a pasted sequence's images resolve from any talk. Pool/http/data refs and
// names not found anywhere are left untouched. Returns the rewritten markdown.
ipcMain.handle('talk:materialize-pasted-assets', async (_event, markdown: string) => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return { success: false, error: 'No vault root', markdown }
  try {
    const assetsDir = join(vaultRoot, '_assets')
    if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true })
    const refs = new Set<string>()
    const re = /!\[[^\]]*\]\(([^)]+)\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(markdown)) !== null) {
      const raw = m[1].trim().replace(/\s+"[^"]*"$/, '')
      if (/^(https?:|data:|img-|vid-)/.test(raw)) continue
      if (!/\.(png|jpe?g|gif|webp)$/i.test(raw)) continue
      refs.add(raw)
    }
    if (refs.size === 0) return { success: true, markdown, materialized: 0 }
    if (!vaultAssetIndex) vaultAssetIndex = buildVaultAssetIndex(vaultRoot)
    let out = markdown
    let materialized = 0
    for (const ref of refs) {
      let rel = ref
      try { rel = decodeURIComponent(ref) } catch { rel = ref }
      const base = rel.split('/').pop() || rel
      let abs = vaultAssetIndex.get(base)
      if (!abs || !existsSync(abs)) {
        // Rebuild once in case the asset was added since the index was cached.
        vaultAssetIndex = buildVaultAssetIndex(vaultRoot)
        abs = vaultAssetIndex.get(base)
      }
      if (!abs || !existsSync(abs)) continue
      try {
        const origBuf = readFileSync(abs)
        const originalFormat = extname(abs).slice(1).toLowerCase() || 'png'
        let storeBuf: Buffer = origBuf
        let storeExt = originalFormat
        try {
          const webp = await normaliseToWebp(origBuf)
          if (webp.length > 0 && webp.length <= origBuf.length) { storeBuf = webp; storeExt = 'webp' }
        } catch { /* keep original format */ }
        const hash = createHash('sha256').update(storeBuf).digest('hex').slice(0, 7)
        const id = 'img-' + hash
        const assetPath = join(assetsDir, id + '.' + storeExt)
        if (!existsSync(assetPath)) {
          writeFileSync(assetPath, storeBuf)
          const sidecarPath = join(assetsDir, id + '.yml')
          if (!existsSync(sidecarPath)) {
            writeFileSync(sidecarPath, [
              'id: ' + id, 'created: ' + new Date().toISOString().slice(0, 10),
              'original_format: ' + originalFormat, 'note: "materialized from pasted cross-talk slide"',
              'alt: ""', 'caption: ""', 'source: ""', 'tags: []'
            ].join('\n') + '\n', 'utf8')
          }
        }
        out = out.split(ref).join(id)
        materialized += 1
      } catch (e) { console.warn('[materialize-pasted-assets] failed for', ref, e) }
    }
    return { success: true, markdown: out, materialized }
  } catch (e) {
    console.error('[materialize-pasted-assets]', e)
    return { success: false, error: String(e), markdown }
  }
})

// Manual rebuild escape hatch: wipe a talk's thumbnail cache so the next thumbnails() call
// re-renders every slide from scratch. The renderer follows this with a fresh compile + thumbnails.
ipcMain.handle('talk:clear-thumb-cache', (_event, slug: string) => {
  try {
    const dir = join(app.getPath('userData'), thumbCacheRoot(), slug)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    return true
  } catch (e) {
    console.error('[clear-thumb-cache]', e)
    return false
  }
})

ipcMain.handle('talk:thumbnails', async (_event, outlinePath: string, content: string) => {
  try {
    const prepared = await prepareTalk(outlinePath, content)
    if (!prepared) return null
    const { slug, model } = prepared
    const rows = (prepared.rows ?? []) as Array<{
      content_hash?: string
      render_hash?: string
      slide_id?: string
      layout?: string
      triggers?: Record<string, string>
    }>
    // Key on render_hash (layout + block model), NOT content_hash: a layout/trigger change keeps
    // the same content_hash, so keying on it served a STALE thumbnail after every layout edit.
    const fullHtml = model.fullHtml as string
    const documentId = thumbnailDocumentId(fullHtml)
    const slides = rows
      .map((r) => {
        const key = r.render_hash || r.content_hash || r.slide_id || ''
        return { key, cacheKey: thumbnailDocumentCacheKey(documentId, key), layout: r.triggers?.layout ?? r.layout }
      })
      .filter((s) => s.key)
    const cacheDir = join(app.getPath('userData'), thumbCacheRoot(), slug)
    const rendered = await renderThumbnails({ fullHtml, slides, cacheDir })
    // renderThumbnails returns key -> absolute png path; expose as twthumb:// URLs the
    // protocol handler resolves back to {userData}/thumb-cache/{slug}/{key}.png.
    const map: Record<string, string> = {}
    for (const key of Object.keys(rendered)) {
      map[key] = 'twthumb://' + slug + '/' + basename(rendered[key], '.png')
    }
    return map
  } catch (e) {
    console.error('[thumbnails]', e)
    return null
  }
})

// ── Asset sidecar metadata (ADR-0020) ────────────────────────────────────────
// Flat `key: value` YAML, tags as `[a, b]` or a block list. Hand-parsed, no yaml dep.
type AssetSidecar = { id: string; alt: string; caption: string; source: string; tags: string[] }
function parseSidecar(text: string, id: string): AssetSidecar & { created?: string } {
  const out: AssetSidecar & { created?: string } = { id, alt: '', caption: '', source: '', tags: [] }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const m = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2]
    const unquote = (s: string): string => s.replace(/^["']|["']$/g, '')
    if (key === 'tags') {
      const inline = val.trim()
      if (inline.startsWith('[')) {
        out.tags = inline
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((t) => unquote(t.trim()))
          .filter(Boolean)
      } else if (inline === '' || inline === '|') {
        // block list: subsequent `- item` lines
        const tags: string[] = []
        for (let j = i + 1; j < lines.length; j += 1) {
          const item = lines[j].match(/^\s*-\s+(.*)$/)
          if (!item) break
          tags.push(unquote(item[1].trim()))
        }
        out.tags = tags
      }
      continue
    }
    val = unquote(val.trim())
    if (key === 'alt') out.alt = val
    else if (key === 'caption') out.caption = val
    else if (key === 'source') out.source = val
    else if (key === 'id') out.id = val || id
    else if (key === 'created') out.created = val
  }
  return out
}
function serializeSidecar(prev: { id: string; created?: string }, meta: { alt: string; caption: string; source: string; tags: string[] }): string {
  const q = (s: string): string => '"' + String(s).replace(/"/g, '\\"') + '"'
  const lines = ['id: ' + prev.id]
  if (prev.created) lines.push('created: ' + prev.created)
  lines.push('alt: ' + q(meta.alt || ''))
  lines.push('caption: ' + q(meta.caption || ''))
  lines.push('source: ' + q(meta.source || ''))
  const tags = (meta.tags || []).filter(Boolean)
  lines.push('tags: [' + tags.map((t) => q(t)).join(', ') + ']')
  return lines.join('\n') + '\n'
}

ipcMain.handle('asset:read-sidecar', (_event, id: string): AssetSidecar | null => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return null
  const path = join(vaultRoot, '_assets', id + '.yml')
  if (!existsSync(path)) return null
  try {
    const parsed = parseSidecar(readFileSync(path, 'utf8'), id)
    return { id: parsed.id, alt: parsed.alt, caption: parsed.caption, source: parsed.source, tags: parsed.tags }
  } catch (e) {
    console.error('[asset:read-sidecar]', e)
    return null
  }
})

ipcMain.handle(
  'asset:write-sidecar',
  (_event, id: string, meta: { alt: string; caption: string; source: string; tags: string[] }): boolean => {
    const vaultRoot = getConfig('vaultRoot', undefined)
    if (!vaultRoot) return false
    try {
      const assetsDir = join(vaultRoot, '_assets')
      if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true })
      const path = join(assetsDir, id + '.yml')
      let prev: { id: string; created?: string } = { id }
      if (existsSync(path)) {
        const existing = parseSidecar(readFileSync(path, 'utf8'), id)
        prev = { id: existing.id, created: existing.created }
      }
      writeFileSync(path, serializeSidecar(prev, meta), 'utf8')
      return true
    } catch (e) {
      console.error('[asset:write-sidecar]', e)
      return false
    }
  }
)

// ── Abstract read/write (ADR-0009) ───────────────────────────────────────────
ipcMain.handle('abstract:read', (_event, talkPath: string) => {
  const path = join(talkPath, 'abstract.md')
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    const frontmatter: Record<string, unknown> = {}
    let body = raw
    if (fm) {
      body = fm[2]
      for (const line of fm[1].split('\n')) {
        const m = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/)
        if (m) frontmatter[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
    return { raw, frontmatter, body }
  } catch (e) {
    console.error('[abstract:read]', e)
    return null
  }
})

ipcMain.handle('abstract:write', (_event, talkPath: string, raw: string): boolean => {
  try {
    if (!existsSync(talkPath)) mkdirSync(talkPath, { recursive: true })
    writeFileSync(join(talkPath, 'abstract.md'), raw, 'utf8')
    return true
  } catch (e) {
    console.error('[abstract:write]', e)
    return false
  }
})

// ── Outline reorder (ADR-0005/0019 strip↔file sync) ──────────────────────────
// The renderer's block indices count ONLY `### `-headed rows (GridView/SlideStrip
// isOutlineBlock), but outline-v2 listSlideBlocks lists EVERY heading ##–###### as its
// own block — indexing those directly moved the WRONG block (e.g. the `## Section` line)
// and could park a section below its own subsection. Map grid indices to depth-3 heading
// blocks and move each with its WHOLE SUBTREE (its ####–###### children travel with it),
// which is the only structurally sound move under heading-is-slide. Returns new text;
// does NOT write the file (renderer sets editor content which autosaves).
ipcMain.handle('outline:reorder', async (_event, outlinePath: string, fromIndex: number, toIndex: number) => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const text = readFileSync(outlinePath, 'utf8')
    const { listSlideBlocks } = await import(
      pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href
    )
    const blocks = listSlideBlocks(text) as Array<{ heading: string; start: number; end: number }>
    const depthOf = (heading: string): number => (heading.match(/^(#{1,6})\s/) ?? ['', ''])[1].length
    // RULING (Task 9, deliberate stopgap — do not extend): the depth-3 filter below exists
    // ONLY to mirror GridView/SlideStrip's ###-only block counters (isOutlineBlock), so the
    // renderer's numeric block indices land on the same blocks here. Under heading-is-slide
    // every ##–###### heading is a slide, so the model-consistent fix is identity-addressed
    // moves ({heading, occurrence} read from the row's source_markdown, not a counter) plus
    // a subtree-aware reorderSlide with per-depth legality rules. See
    // .superpowers/sdd/task-9-report.md for the full spec of that follow-up.
    // Depth-3 blocks, each spanning through its deeper-heading children ([start, end) lines).
    const gridBlocks: Array<{ start: number; end: number }> = []
    for (let i = 0; i < blocks.length; i += 1) {
      if (depthOf(blocks[i].heading) !== 3) continue
      let end = blocks[i].end
      for (let j = i + 1; j < blocks.length && depthOf(blocks[j].heading) > 3; j += 1) end = blocks[j].end
      gridBlocks.push({ start: blocks[i].start, end })
    }
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= gridBlocks.length ||
      toIndex >= gridBlocks.length ||
      fromIndex === toIndex
    ) {
      return null
    }
    const from = gridBlocks[fromIndex]
    const target = gridBlocks[toIndex]
    // Dragging down: land AFTER the target subtree; dragging up: land BEFORE it.
    const lines = text.split('\n')
    const moved = lines.splice(from.start, from.end - from.start)
    let at = toIndex > fromIndex ? target.end : target.start
    if (from.start < at) at -= moved.length // indices shifted by the removal above
    lines.splice(at, 0, ...moved)
    return lines.join('\n')
  } catch (e) {
    console.error('[outline:reorder]', e)
    return null
  }
})

// ── Per-item icon override (ADR-0021 icon picker) ────────────────────────────
// Pin (or clear, iconKey=null) the icon on ONE top-level list item of a slide, by writing the
// canonical `{icon=KEY}` token at the end of that bullet's line. Operates on the renderer's LIVE
// in-memory `content` (not the on-disk file, which lags behind a debounced autosave) and returns
// the rewritten text; the renderer then drives onContentChange → autosave so the file syncs. Item
// is addressed by {heading, occurrence} + 0-based item index, exactly as setListItemIcon expects.
ipcMain.handle(
  'outline:set-item-icon',
  async (
    _event,
    content: string,
    slideHeading: string,
    slideOccurrence: number,
    itemIndex: number,
    iconKey: string | null
  ) => {
    const compilerDir = getCompilerPath()
    if (!compilerDir) return null
    try {
      const { setListItemIcon } = await import(
        pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href
      )
      const ref = { heading: slideHeading, occurrence: slideOccurrence || 1 }
      return setListItemIcon(content, ref, itemIndex, iconKey)
    } catch (e) {
      console.error('[outline:set-item-icon]', e)
      return null
    }
  }
)

// ── Trigger merge (⌘L layout picker) ─────────────────────────────────────────
// Merge the chosen trigger onto the slide under `lineNumber` (1-based caret line) in the
// renderer's LIVE content: same-key tokens replaced via the Trigger Dictionary, everything
// else — {id=…} above all — kept verbatim (ADR-0032 id-loss fix). Returns rewritten text
// or null; the renderer must no-op on null, never fall back to replacing the line.
ipcMain.handle('outline:merge-trigger', async (_event, content: string, lineNumber: number, trigger: string) => {
  const compilerDir = getCompilerPath()
  if (!compilerDir) return null
  try {
    const { mergeTriggerAtLine } = await import(
      pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href
    )
    return mergeTriggerAtLine(content, lineNumber, trigger)
  } catch (e) {
    console.error('[outline:merge-trigger]', e)
    return null
  }
})

// ── Asset paste ────────────────────────────────────────────────────────────

// ADR-0020: normalise clipboard images to WebP via sharp, then content-address the
// POST-CONVERSION bytes. sharp is a native module loaded lazily so a missing/broken
// build never breaks app startup; if conversion throws we fall back to the original
// bytes/ext so paste NEVER fails. The twasset:// handler tries webp first, so converted
// assets display without renderer changes.
async function normaliseToWebp(buf: Buffer): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require('sharp')
  return sharp(buf).webp({ quality: 82 }).toBuffer()
}

ipcMain.handle('asset:paste-image', async (_event, bytes: ArrayBuffer | Uint8Array, ext: string = 'png') => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return null
  try {
    // The renderer sends an ArrayBuffer over IPC; crypto/fs need a Buffer/TypedArray.
    const origBuf = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    const originalFormat = ext

    // Try WebP normalisation; on ANY failure keep the original bytes/ext (non-regressing).
    let storeBuf = origBuf
    let storeExt = ext
    let note = 'stored as-is (no conversion)'
    try {
      const webp = await normaliseToWebp(origBuf)
      // Keep the smaller file; if WebP is larger (rare for already-compressed inputs)
      // fall back to the original per ADR-0020 ("If conversion produces a larger file
      // or fails, the original format is kept").
      if (webp.length > 0 && webp.length <= origBuf.length) {
        storeBuf = webp
        storeExt = 'webp'
        note = 'converted to webp via sharp (quality 82)'
      } else {
        note = 'webp larger than original; kept ' + originalFormat
      }
    } catch (convErr) {
      console.warn('[asset:paste-image] sharp webp conversion unavailable, falling back to original:', convErr)
      note = 'webp conversion failed; kept ' + originalFormat
    }

    // Hash the STORED (post-conversion) bytes for the id per ADR-0020.
    const hash = createHash('sha256').update(storeBuf).digest('hex').slice(0, 7)
    const id = 'img-' + hash
    const assetsDir = join(vaultRoot, '_assets')
    if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true })
    const assetPath = join(assetsDir, id + '.' + storeExt)
    if (!existsSync(assetPath)) {
      writeFileSync(assetPath, storeBuf)
      // Write minimal sidecar yml recording the original format and a conversion note.
      const sidecarPath = join(assetsDir, id + '.yml')
      if (!existsSync(sidecarPath)) {
        writeFileSync(sidecarPath, [
          'id: ' + id,
          'created: ' + new Date().toISOString().slice(0, 10),
          'original_format: ' + originalFormat,
          'note: ' + JSON.stringify(note),
          'alt: ""',
          'caption: ""',
          'source: ""',
          'tags: []',
        ].join('\n') + '\n', 'utf8')
      }
    }
    return { id, ext: storeExt, path: assetPath }
  } catch (e) {
    console.error('[asset:paste-image]', e)
    return null
  }
})

// Store an image buffer under the img- namespace (used as the GIF fallback path). Returns the id.
function storeBufAsImage(assetsDir: string, buf: Buffer, ext: string, note: string): string {
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 7)
  const id = 'img-' + hash
  const p = join(assetsDir, id + '.' + ext)
  if (!existsSync(p)) {
    writeFileSync(p, buf)
    const sc = join(assetsDir, id + '.yml')
    if (!existsSync(sc)) {
      writeFileSync(sc, [
        'id: ' + id,
        'created: ' + new Date().toISOString().slice(0, 10),
        'original_format: ' + ext,
        'note: ' + JSON.stringify(note),
        'alt: ""', 'caption: ""', 'source: ""', 'tags: []'
      ].join('\n') + '\n', 'utf8')
    }
  }
  return id
}

const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm']

// Idempotently write a clip's poster + sidecar beside vid-<id>.<ext> (best effort for the poster).
async function ensureVideoSidecars(assetsDir: string, id: string, videoPath: string, originalFormat: string, durationMs: number): Promise<void> {
  const posterPath = join(assetsDir, id + '.jpg')
  if (!existsSync(posterPath)) await runMediaBin(['poster', videoPath, posterPath])
  const sidecarPath = join(assetsDir, id + '.yml')
  if (!existsSync(sidecarPath)) {
    writeFileSync(sidecarPath, [
      'id: ' + id,
      'kind: video',
      'created: ' + new Date().toISOString().slice(0, 10),
      'original_format: ' + originalFormat,
      'duration_ms: ' + durationMs,
      'alt: ""', 'caption: ""', 'source: ""', 'tags: []'
    ].join('\n') + '\n', 'utf8')
  }
}

// Ingest a video or animated GIF into the Vault Asset Pool (ADR-0028). Accepts either a file
// `path` (drag-drop — avoids piping big bytes over IPC) or `bytes` (paste). Animated GIFs are
// converted to silent MP4; static GIFs and conversion failures fall back to the img- image path.
// Stores `vid-<7hex>.<ext>` + a generated poster `vid-<id>.jpg` + a `vid-<id>.yml` sidecar.
// The id hashes the SOURCE bytes, not the converted output — the GIF→MP4 encode is not byte-
// deterministic, so hashing the MP4 would mint a fresh id on every re-import (defeating ADR-0020).
ipcMain.handle('asset:add-video', async (_event, input: { path?: string; bytes?: ArrayBuffer | Uint8Array; ext?: string }) => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return { success: false, error: 'No vault root' }
  if (!resolveMediaBin()) return { success: false, error: 'Media helper not found (rebuild the app)' }
  const tmp: string[] = []
  try {
    let ext = (input.ext || '').toLowerCase().replace('jpeg', 'jpg')
    // 1. Resolve a concrete source file on disk.
    let srcPath: string
    if (input.path && existsSync(input.path)) {
      srcPath = input.path
      if (!ext) ext = (input.path.split('.').pop() || '').toLowerCase()
    } else if (input.bytes) {
      const buf = Buffer.from(input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes))
      srcPath = join(tmpdir(), 'tw-ingest-' + randomBytes(6).toString('hex') + '.' + (ext || 'bin'))
      writeFileSync(srcPath, buf); tmp.push(srcPath)
    } else {
      return { success: false, error: 'No file path or bytes' }
    }

    const assetsDir = join(vaultRoot, '_assets')
    if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true })

    // Content identity from the SOURCE bytes — stable across the non-deterministic GIF→MP4 encode.
    const srcHash = await hashFileSoon(srcPath)

    // 2. GIF → MP4. Static (single-frame) GIFs and conversion failures degrade to an image.
    if (ext === 'gif') {
      const id = 'vid-' + srcHash
      const finalPath = join(assetsDir, id + '.mp4')
      if (existsSync(finalPath)) { // already imported — idempotent, skip re-conversion
        await ensureVideoSidecars(assetsDir, id, finalPath, 'gif', 0)
        return { success: true, id, ext: 'mp4', origin: 'gif' as const }
      }
      if (existsSync(join(assetsDir, 'img-' + srcHash + '.gif'))) { // previously fell back to image
        return { success: true, id: 'img-' + srcHash, ext: 'gif', origin: 'image' as const }
      }
      const tmpMp4 = join(tmpdir(), 'tw-conv-' + randomBytes(6).toString('hex') + '.mp4'); tmp.push(tmpMp4)
      const res = await runMediaBin(['convert-gif', srcPath, tmpMp4])
      if (!res.ok || res.static) {
        const sid = storeBufAsImage(assetsDir, readFileSync(srcPath), 'gif',
          res.static ? 'static gif kept as image' : 'gif->mp4 failed; kept as image: ' + (res.error || ''))
        return { success: true, id: sid, ext: 'gif', origin: 'image' as const, ...(res.static ? {} : { warning: 'GIF could not be converted; stored as image' }) }
      }
      cpSync(tmpMp4, finalPath)
      await ensureVideoSidecars(assetsDir, id, finalPath, 'gif', Number(res.durationMs || 0))
      return { success: true, id, ext: 'mp4', origin: 'gif' as const }
    }

    if (!VIDEO_EXTS.includes(ext)) return { success: false, error: 'Unsupported media type: .' + ext }

    // 3. MP4/MOV/… stored as-is; id is the hash of its own bytes (source == stored here).
    const id = 'vid-' + srcHash
    const finalPath = join(assetsDir, id + '.' + ext)
    if (!existsSync(finalPath)) cpSync(srcPath, finalPath)
    await ensureVideoSidecars(assetsDir, id, finalPath, ext, 0)
    return { success: true, id, ext, origin: 'video' as const }
  } catch (e) {
    console.error('[asset:add-video]', e)
    return { success: false, error: String(e) }
  } finally {
    for (const f of tmp) { try { rmSync(f, { force: true }) } catch { /* ignore */ } }
  }
})

// ── Create talk ────────────────────────────────────────────────────────────

ipcMain.handle('vault:create-talk', async (_event, opts: { title: string; slug: string; topicFolder?: string }) => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return null
  try {
    const { title, slug, topicFolder } = opts
    const parentDir = topicFolder ? join(vaultRoot, topicFolder) : vaultRoot
    const talkDir = join(parentDir, slug)
    if (!existsSync(talkDir)) mkdirSync(talkDir, { recursive: true })
    const outlinePath = join(talkDir, slug + '-outline.md')
    if (!existsSync(outlinePath)) {
      const initialContent = [
        '---',
        'title: ' + title,
        // Stamp new talks as outline-v2 at birth — without this, every freshly created
        // talk fails outlineHasV2Stamp and gets the migration prompt + a pointless .bak
        // on first open.
        'outline_version: 2',
        '---',
        '',
        '## Introduction',
        '',
        '### Opening slide',
        '',
        'Your content here.',
        '',
      ].join('\n')
      writeFileSync(outlinePath, initialContent, 'utf8')
    }
    invalidateTalkCache()
    return { name: slug, path: talkDir, outlinePath, title, slug } satisfies TalkInfo
  } catch (e) {
    console.error('[vault:create-talk]', e)
    return null
  }
})

// ── Clone + folder management (ported from the Raycast extension's rename.ts) ────────────────
// slugify must match the compiler's slugify so a cloned talk's files line up with its outline.
function slugifyTalk(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
// Rename every `{oldSlug}-…` / `{oldSlug}.…` file in dir to use newSlug (the outline + siblings).
function renameSlugFiles(dir: string, oldSlug: string, newSlug: string): void {
  if (oldSlug === newSlug) return
  for (const file of readdirSync(dir)) {
    let renamed: string | null = null
    if (file.startsWith(`${oldSlug}-`)) renamed = `${newSlug}-${file.slice(oldSlug.length + 1)}`
    else if (file.startsWith(`${oldSlug}.`)) renamed = `${newSlug}${file.slice(oldSlug.length)}`
    if (renamed) renameSync(join(dir, file), join(dir, renamed))
  }
}
function retitleOutline(outlinePath: string, newTitle: string): void {
  if (!existsSync(outlinePath)) return
  const text = readFileSync(outlinePath, 'utf8')
  const line = `title: "${newTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  let next: string
  if (fm && /^\s*title:/m.test(fm[1])) {
    next = text.slice(0, fm.index! + fm[0].length).replace(/^\s*title:.*$/m, line) + text.slice(fm.index! + fm[0].length)
  } else if (fm) {
    next = text.replace(/^---\r?\n/, `---\n${line}\n`)
  } else {
    next = `---\n${line}\n---\n\n${text}`
  }
  writeFileSync(outlinePath, next)
}
// A clone is NOT published — drop handout_url so it doesn't inherit the original's live link.
function stripPublishedFields(outlinePath: string): void {
  if (!existsSync(outlinePath)) return
  const text = readFileSync(outlinePath, 'utf8')
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return
  const lines = fm[1].split(/\r?\n/)
  const kept = lines.filter((l) => !/^\s*handout_url\s*:/.test(l))
  if (kept.length === lines.length) return
  writeFileSync(outlinePath, text.slice(0, fm.index!) + `---\n${kept.join('\n')}\n---` + text.slice(fm.index! + fm[0].length))
}
function findOutlineIn(dir: string): string | null {
  try {
    const hit = readdirSync(dir).find((f) => f.endsWith('-outline.md'))
    return hit ? join(dir, hit) : null
  } catch { return null }
}
function talkInfoFor(talkDir: string): TalkInfo | null {
  const outlinePath = findOutlineIn(talkDir)
  if (!outlinePath) return null
  const slug = basename(outlinePath).replace('-outline.md', '')
  let title = slug
  try {
    const m = readFileSync(outlinePath, 'utf8').match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (m) title = m[1]
  } catch { /* keep slug as title */ }
  return { name: slug, path: talkDir, outlinePath, title, slug }
}

// Clone a talk: copy its whole folder (skip bundle/ + logs), rename slug files, retitle, strip the
// published handout_url. Lands as a sibling (same parent folder), exactly like Raycast's Duplicate.
ipcMain.handle('vault:clone-talk', async (_event, outlinePath: string, newTitle: string) => {
  try {
    const srcDir = dirname(outlinePath)
    const oldSlug = basename(outlinePath).replace('-outline.md', '')
    let newSlug = slugifyTalk(newTitle) || `${oldSlug}-copy`
    let target = join(dirname(srcDir), newSlug)
    // Never clobber: suffix -2, -3, … until the folder name is free.
    let n = 2
    while (existsSync(target)) { newSlug = `${slugifyTalk(newTitle) || oldSlug}-${n}`; target = join(dirname(srcDir), newSlug); n += 1 }
    const skip = new Set([join(srcDir, 'bundle'), join(srcDir, 'dist'), join(srcDir, '.deck-server.log')])
    cpSync(srcDir, target, {
      recursive: true,
      filter: (s) => !skip.has(s) && ![...skip].some((p) => s.startsWith(p + pathSep))
    })
    renameSlugFiles(target, oldSlug, newSlug)
    const newOutline = findOutlineIn(target)
    if (newOutline) { retitleOutline(newOutline, newTitle); stripPublishedFields(newOutline) }
    searchCache.clear()
    invalidateTalkCache()
    return talkInfoFor(target)
  } catch (e) {
    console.error('[vault:clone-talk]', e)
    return null
  }
})

// Rename a talk IN PLACE: retitle the frontmatter and, when the new title yields a new slug,
// rename the talk folder + every slug-prefixed file in it (same mechanics as clone). The
// published handout_url is kept — renaming a talk does not unpublish it. Refuses (returns
// null) if the target folder name is already taken, rather than guessing a suffix: unlike a
// clone, a rename must land exactly where the author pointed it.
ipcMain.handle('vault:rename-talk', async (event, outlinePath: string, newTitle: string) => {
  try {
    const title = String(newTitle || '').trim()
    if (!title) return null
    // Refuse while ANOTHER window holds this talk open: its autosave would recreate the old
    // path after the move and the two files would drift apart (same hazard class as the
    // 2026-07-05 empty-write incident). The requesting window is expected to flush + re-select.
    for (const [wcId, e] of editorWindows) {
      if (wcId !== event.sender.id && e.outlinePath === outlinePath && !e.win.isDestroyed()) {
        return { error: 'open-elsewhere' }
      }
    }
    const srcDir = dirname(outlinePath)
    const oldSlug = basename(outlinePath).replace('-outline.md', '')
    const newSlug = slugifyTalk(title) || oldSlug
    let dir = srcDir
    if (newSlug !== oldSlug) {
      const target = join(dirname(srcDir), newSlug)
      if (existsSync(target)) return { error: 'target-exists' }
      renameSync(srcDir, target)
      renameSlugFiles(target, oldSlug, newSlug)
      dir = target
    }
    const newOutline = findOutlineIn(dir)
    if (newOutline) retitleOutline(newOutline, title)
    searchCache.clear()
    invalidateTalkCache()
    return talkInfoFor(dir)
  } catch (e) {
    console.error('[vault:rename-talk]', e)
    return null
  }
})

// Vault-relative path of an absolute path (forward-slashed), or '' when it is the root itself.
function vaultRel(abs: string): string {
  const root = getConfig('vaultRoot', undefined)
  if (!root) return ''
  let rel = abs.startsWith(root) ? abs.slice(root.length) : abs
  return rel.replace(/^[/\\]+/, '').split(pathSep).join('/')
}

// Create a folder under the vault (optionally nested under parentRel). Returns its vault-rel path.
ipcMain.handle('vault:create-folder', (_event, name: string, parentRel?: string) => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return null
  try {
    const clean = String(name || '').trim().replace(/[/\\]/g, '-')
    if (!clean) return null
    const dir = join(vaultRoot, parentRel || '', clean)
    if (existsSync(dir)) return vaultRel(dir) // already there — idempotent
    mkdirSync(dir, { recursive: true })
    invalidateTalkCache()
    return vaultRel(dir)
  } catch (e) {
    console.error('[vault:create-folder]', e)
    return null
  }
})

// Rename a folder (by its vault-rel path). Returns the new vault-rel path.
ipcMain.handle('vault:rename-folder', (_event, folderRel: string, newName: string) => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot || !folderRel) return null
  try {
    const clean = String(newName || '').trim().replace(/[/\\]/g, '-')
    if (!clean) return null
    const src = join(vaultRoot, folderRel)
    const dest = join(dirname(src), clean)
    if (!existsSync(src) || existsSync(dest)) return null
    renameSync(src, dest)
    searchCache.clear()
    invalidateTalkCache()
    return vaultRel(dest)
  } catch (e) {
    console.error('[vault:rename-folder]', e)
    return null
  }
})

// Move a talk's whole folder into destFolderRel ('' = vault root). Returns the moved TalkInfo.
ipcMain.handle('vault:move-talk', (_event, outlinePath: string, destFolderRel: string) => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return null
  try {
    const srcDir = dirname(outlinePath)
    const destParent = join(vaultRoot, destFolderRel || '')
    if (!existsSync(destParent)) mkdirSync(destParent, { recursive: true })
    const dest = join(destParent, basename(srcDir))
    if (resolvePath(dest) === resolvePath(srcDir)) return talkInfoFor(srcDir) // no-op (same folder)
    if (existsSync(dest)) return null // a talk of that name already lives there
    renameSync(srcDir, dest)
    searchCache.clear()
    invalidateTalkCache()
    return talkInfoFor(dest)
  } catch (e) {
    console.error('[vault:move-talk]', e)
    return null
  }
})

// List CATEGORY folders under the vault (vault-rel paths), INCLUDING empty ones — so a folder you
// just created is visible in the sidebar even before any talk lives in it. A "category folder" is a
// directory that is NOT itself a talk folder (a talk folder directly contains a *-outline.md).
ipcMain.handle('vault:list-folders', async () => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot) return []
  const SKIP = new Set(['bundle', 'dist', 'node_modules', '.git'])
  const isTalkDir = async (dir: string): Promise<boolean> => {
    try { return (await readdirAsync(dir)).some((f) => f.endsWith('-outline.md')) } catch { return false }
  }
  const out: string[] = []
  const scan = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return
    let entries
    try { entries = await readdirAsync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const name = entry.name
      // `_`-prefixed dirs are system areas (_assets, _SLIDE-VERSIONS), never category folders.
      if (name.startsWith('.') || name.startsWith('_') || SKIP.has(name)) continue
      if (!entry.isDirectory()) continue
      const full = join(dir, name)
      if (await isTalkDir(full)) continue // a talk, not a category folder
      out.push(vaultRel(full))
      await scan(full, depth + 1)
    }
  }
  await scan(vaultRoot, 0)
  return out
})

// Delete a talk — moved to the OS Trash (recoverable), not hard-deleted, so an accidental
// create/clone can be undone from Finder.
ipcMain.handle('vault:delete-talk', async (_event, outlinePath: string) => {
  try {
    await shell.trashItem(dirname(outlinePath))
    searchCache.clear()
    invalidateTalkCache()
    return true
  } catch (e) {
    console.error('[vault:delete-talk]', e)
    return false
  }
})

// Delete a category folder (and anything inside it) — also to the OS Trash (recoverable).
ipcMain.handle('vault:delete-folder', async (_event, folderRel: string) => {
  const vaultRoot = getConfig('vaultRoot', undefined)
  if (!vaultRoot || !folderRel) return false
  try {
    await shell.trashItem(join(vaultRoot, folderRel))
    searchCache.clear()
    invalidateTalkCache()
    return true
  } catch (e) {
    console.error('[vault:delete-folder]', e)
    return false
  }
})

// Open a built artifact (file or folder) in the OS file manager / browser.
ipcMain.handle('shell:open-path', async (_event, path: string): Promise<boolean> => {
  try {
    const err = await shell.openPath(path)
    return err === ''
  } catch (e) {
    console.error('[shell:open-path]', e)
    return false
  }
})

// Reveal a file in Finder (select it in its folder) — for "I want to copy the file, not view it".
ipcMain.handle('shell:show-item-in-folder', async (_event, path: string): Promise<boolean> => {
  try {
    shell.showItemInFolder(path)
    return true
  } catch (e) {
    console.error('[shell:show-item-in-folder]', e)
    return false
  }
})

// Open an external URL (e.g. the published handout link) in the default browser.
ipcMain.handle('shell:open-external', async (_event, url: string): Promise<boolean> => {
  try {
    if (!/^https?:\/\//i.test(url)) return false
    await shell.openExternal(url)
    return true
  } catch (e) {
    console.error('[shell:open-external]', e)
    return false
  }
})

// ── Old-PowerPoint archive image search + import (read-only, ADR-0019) ────────
// The archive is a content-addressed store of slides extracted from old decks, with
// SQLite registries at {archiveRoot}/registry/{slides,media,images}.db. We never bundle a
// native SQLite module — instead we shell out to the system sqlite3 binary READ-ONLY, porting
// the proven query + path-resolution logic from raycast-slide-search (do not import it).
//
// The on-disk image files served back to the renderer go through the twarchive:// scheme
// (registered below in whenReady) with a path-traversal guard, so only files inside the
// archive root can be read. Importing an image copies its bytes into the CURRENT vault's
// _assets, content-addressed exactly like asset:paste-image, with a ppt-archive provenance
// sidecar.

const SQLITE3_CANDIDATES = ['/usr/bin/sqlite3', 'sqlite3', '/opt/homebrew/bin/sqlite3', '/opt/anaconda3/bin/sqlite3']

let cachedSqlite3: string | null | undefined
function detectSqlite3(): string | null {
  if (cachedSqlite3 !== undefined) return cachedSqlite3
  // Bare 'sqlite3' resolves on PATH at exec time; for the others verify the file exists.
  for (const cand of SQLITE3_CANDIDATES) {
    if (cand === 'sqlite3') {
      cachedSqlite3 = cand
      return cand
    }
    if (existsSync(cand)) {
      cachedSqlite3 = cand
      return cand
    }
  }
  cachedSqlite3 = null
  return null
}

function detectArchiveRoot(): string | null {
  const root = getConfig('archiveRoot', undefined) ?? null
  if (!root) return null
  return existsSync(join(root, 'registry', 'media.db')) ? root : null
}

class SqliteError extends Error {}

// Run sqlite3 with the SQL script on stdin, no shell. Mirrors raycast runSqlite3.
function runSqlite3(binary: string, args: string[], script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new SqliteError((stderr || '').toString().trim() || err.message))
          return
        }
        resolve((stdout || '').toString())
      }
    )
    child.stdin?.end(script)
  })
}

function shellQuoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
function toParamLiteral(value: string | number | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SqliteError('Non-finite numeric param: ' + value)
    return String(value)
  }
  return shellQuoteSqlString(value)
}

// Parameterised read-only query. The sqlite3 CLI cannot take out-of-band bind values, so each
// ? is replaced by a hardened SQL literal (numbers verified finite; strings single-quote
// escaped by doubling every quote → user input is always data, never syntax).
async function sqliteQuery<T = Record<string, string>>(opts: {
  binary: string
  dbPath: string
  sql: string
  params?: Array<string | number | null>
  attach?: Record<string, string>
  timeoutMs?: number
}): Promise<T[]> {
  const params = opts.params ?? []
  let i = 0
  const inlined = opts.sql.replace(/\?/g, () => {
    if (i >= params.length) throw new SqliteError('More ? placeholders than params')
    return toParamLiteral(params[i++])
  })
  if (i !== params.length) throw new SqliteError(`Placeholder count (${i}) != params length (${params.length})`)

  const lines: string[] = []
  for (const [schema, path] of Object.entries(opts.attach ?? {})) {
    lines.push(`ATTACH DATABASE ${shellQuoteSqlString('file:' + path + '?mode=ro')} AS ${schema};`)
  }
  lines.push(inlined.trim().endsWith(';') ? inlined : inlined + ';')
  const script = lines.join('\n')

  const dbUri = 'file:' + opts.dbPath + '?mode=ro'
  const stdout = await runSqlite3(opts.binary, ['-json', '-readonly', dbUri], script, opts.timeoutMs ?? 8000)
  const trimmed = stdout.trim()
  if (!trimmed) return []
  try {
    return JSON.parse(trimmed) as T[]
  } catch {
    throw new SqliteError('sqlite3 returned non-JSON output: ' + trimmed.slice(0, 200))
  }
}

// ── archive image file path resolution (ported from raycast paths.ts) ─────────
// Prefer a content-addressed media-store entry (survives source pruning); fall back to the
// per-deck extracted copy. Returns an absolute path or null when nothing is on disk.
const MEDIA_STORE_DIRS = ['media-store', 'media_store']
function archiveImagePath(archiveRoot: string, presentationId: string, relPath: string, sha256: string): string | null {
  const ext = (relPath.split('.').pop() || '').toLowerCase()
  for (const storeName of MEDIA_STORE_DIRS) {
    if (!ext) break
    const flat = join(archiveRoot, storeName, sha256 + '.' + ext)
    if (existsSync(flat)) return flat
    const sharded = join(archiveRoot, storeName, sha256.slice(0, 2), sha256 + '.' + ext)
    if (existsSync(sharded)) return sharded
  }
  const perDeck = join(archiveRoot, 'extracted', presentationId, relPath)
  if (existsSync(perDeck)) return perDeck
  return null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The registry has no separate human title column; presentation_id IS the deck name for
// readable decks ("01 MondAI Roundup - 11 Nov 24") and a UUID for the rest. Surface the
// readable ones as deckTitle; leave UUID-only decks without one.
function deckTitleFor(presentationId: string): string | undefined {
  if (!presentationId || UUID_RE.test(presentationId)) return undefined
  return presentationId
}

// base64url helpers for the twarchive:// scheme (RFC 4648 §5, no padding).
function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf8')
}

// twarchive:// is registered as a STANDARD scheme, so Chromium canonicalises the URL host to
// lowercase — which would corrupt the case-sensitive base64url payload. Keep the payload in the
// URL PATH (case-preserved) behind a fixed throwaway host. The thumbUrl value still carries the
// base64url of the absolute file path, per contract; decoding tolerates both shapes.
const TWARCHIVE_HOST = 'f'
function twarchiveUrl(absPath: string): string {
  return 'twarchive://' + TWARCHIVE_HOST + '/' + toBase64Url(absPath)
}
// Pull the base64url payload out of any twarchive:// URL shape (path-first, or legacy host).
function twarchivePayload(url: string): string {
  const rest = url.slice('twarchive://'.length)
  const slash = rest.indexOf('/')
  // Path form twarchive://<host>/<payload>: take everything after the first slash.
  if (slash >= 0) return rest.slice(slash + 1).replace(/\/+$/, '')
  // Bare form twarchive://<payload> (legacy / raw): the whole remainder.
  return rest.replace(/\/+$/, '')
}

// Guard: resolve symlinks where possible and require the path to sit inside the archive root.
function isInsideArchive(absPath: string, archiveRoot: string): boolean {
  let resolvedRoot: string
  let resolvedPath: string
  try {
    resolvedRoot = realpathSync(archiveRoot)
  } catch {
    resolvedRoot = resolvePath(archiveRoot)
  }
  try {
    resolvedPath = realpathSync(absPath)
  } catch {
    resolvedPath = resolvePath(absPath)
  }
  const rootWithSep = resolvedRoot.endsWith(pathSep) ? resolvedRoot : resolvedRoot + pathSep
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(rootWithSep)
}

ipcMain.handle('archive:available', async (): Promise<boolean> => {
  return detectArchiveRoot() !== null && detectSqlite3() !== null
})

interface ArchiveImageHit {
  assetKey: string
  presentationId: string
  relPath: string
  sha256?: string
  ocrText: string
  thumbUrl: string
  deckTitle?: string
}

interface OcrAssetRow {
  asset_key: string
  presentation_id: string | null
  rel_path: string | null
  text: string | null
}

ipcMain.handle('archive:search-images', async (_event, query: string): Promise<ArchiveImageHit[] | null> => {
  const archiveRoot = detectArchiveRoot()
  const sqlite3Path = detectSqlite3()
  if (!archiveRoot || !sqlite3Path) return null
  try {
    // media.db has no FTS; ocr_assets.text holds the OCR. LIKE on each bare token (escaped to a
    // literal), AND across tokens — mirrors raycast searchImages.
    const tokens = (query || '')
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/[%_]/g, (m) => '\\' + m))
      .filter(Boolean)
    if (tokens.length === 0) return []

    const whereLikes = tokens.map(() => `o.text LIKE ? ESCAPE '\\'`).join(' AND ')
    const params: Array<string | number> = tokens.map((t) => '%' + t + '%')
    params.push(60)

    const rows = await sqliteQuery<OcrAssetRow>({
      binary: sqlite3Path,
      dbPath: join(archiveRoot, 'registry', 'media.db'),
      sql: `SELECT o.asset_key, o.presentation_id, o.rel_path, o.text
            FROM ocr_assets o
            WHERE o.kind = 'image'
              AND o.text IS NOT NULL
              AND ${whereLikes}
            ORDER BY length(o.text) DESC
            LIMIT ?`,
      params
    })

    const hits: ArchiveImageHit[] = []
    for (const r of rows) {
      const sha = r.asset_key
      const pid = r.presentation_id || ''
      const relPath = r.rel_path || ''
      const filePath = archiveImagePath(archiveRoot, pid, relPath, sha)
      if (!filePath) continue // skip hits with no file on disk
      hits.push({
        assetKey: sha,
        presentationId: pid,
        relPath,
        sha256: sha,
        ocrText: r.text || '',
        thumbUrl: twarchiveUrl(filePath),
        deckTitle: deckTitleFor(pid)
      })
    }
    return hits
  } catch (e) {
    console.error('[archive:search-images]', e)
    return null
  }
})

ipcMain.handle(
  'archive:import-image',
  async (_event, thumbUrlOrPath: string): Promise<{ id: string; ext: string; path: string } | null> => {
    const vaultRoot = getConfig('vaultRoot', undefined)
    const archiveRoot = detectArchiveRoot()
    if (!vaultRoot || !archiveRoot) return null
    try {
      // Decode the source path: either a twarchive:// URL (b64url of an absolute path, carried in
      // the URL path so its case survives Chromium canonicalisation) or a raw absolute path.
      let absPath: string
      if (thumbUrlOrPath.startsWith('twarchive://')) {
        absPath = fromBase64Url(twarchivePayload(thumbUrlOrPath))
      } else {
        absPath = thumbUrlOrPath
      }
      absPath = resolvePath(absPath)

      // Verify the file is inside the read-only archive before reading it.
      if (!isInsideArchive(absPath, archiveRoot)) {
        console.warn('[archive:import-image] refused path outside archive:', absPath)
        return null
      }
      if (!existsSync(absPath)) return null

      const origBuf = readFileSync(absPath)
      const ext = (absPath.split('.').pop() || 'png').toLowerCase()

      // Content-address the bytes exactly like asset:paste-image (img-{7hex sha256}.{ext}).
      const hash = createHash('sha256').update(origBuf).digest('hex').slice(0, 7)
      const id = 'img-' + hash
      const assetsDir = join(vaultRoot, '_assets')
      if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true })
      const assetPath = join(assetsDir, id + '.' + ext)
      if (!existsSync(assetPath)) {
        writeFileSync(assetPath, origBuf)
        const sidecarPath = join(assetsDir, id + '.yml')
        if (!existsSync(sidecarPath)) {
          // Provenance: source ppt-archive, with the originating archive path noted.
          const note = 'imported from ppt-archive: ' + absPath
          writeFileSync(
            sidecarPath,
            [
              'id: ' + id,
              'created: ' + new Date().toISOString().slice(0, 10),
              'original_format: ' + ext,
              'note: ' + JSON.stringify(note),
              'alt: ""',
              'caption: ""',
              'source: "ppt-archive"',
              'tags: []'
            ].join('\n') + '\n',
            'utf8'
          )
        }
      }
      return { id, ext, path: assetPath }
    } catch (e) {
      console.error('[archive:import-image]', e)
      return null
    }
  }
)

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  installApplicationMenu()
  // Let embedded iframes load sites that would otherwise refuse framing (X-Frame-Options /
  // CSP frame-ancestors). Scoped to SUB-FRAMES only, so app/editor chrome and top-level loads
  // are untouched. App-only — a shared HTML file in a browser can't do this (hence the compile-
  // time "Open ↗" caption beside remote embeds).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'subFrame') {
      callback({})
      return
    }
    const headers = details.responseHeaders ?? {}
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase()
      if (lower === 'x-frame-options') {
        delete headers[key]
      } else if (lower === 'content-security-policy') {
        headers[key] = (headers[key] as string[]).map((v) =>
          v.replace(/frame-ancestors[^;]*;?/gi, '').trim()
        )
      }
    }
    callback({ responseHeaders: headers })
  })

  // 2026-07-08: YouTube's embedded player refuses to configure without an HTTP Referer
  // ("Error 153 — video player configuration error"). Decks load from file:// / twpresent://,
  // which send none, so inject a stable https referer on player requests. Vimeo's player has
  // the same domain-check behaviour. App-only — an exported deck opened from file:// in a
  // plain browser still needs "Watch on YouTube" (the player's own fallback link).
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://player.vimeo.com/*'] },
    (details, callback) => {
      const headers = details.requestHeaders ?? {}
      if (!headers['Referer'] && !headers['referer']) headers['Referer'] = 'https://talkweaver.app/'
      callback({ requestHeaders: headers })
    }
  )

  // Register twasset:// to serve vault asset files safely
  protocol.registerFileProtocol('twasset', (request, callback) => {
    const vaultRoot = getConfig('vaultRoot', undefined)
    if (!vaultRoot) { callback({ error: -2 }); return }
    // twasset://img-a3f9b2 ; tolerate the legacy double prefix (img-img-…) from the old import bug.
    const id = new URL(request.url).hostname.replace(/^img-img-/, 'img-')
    const assetsDir = join(vaultRoot, '_assets')
    // A clip (vid-…) serves its POSTER image — authoring previews never play (ADR-0028).
    if (/^vid-[0-9a-f]{7}$/.test(id)) {
      const poster = join(assetsDir, id + '.jpg')
      if (existsSync(poster)) { callback({ path: poster }); return }
      callback({ error: -2 }); return
    }
    // Try common image extensions in order
    for (const ext of ['webp', 'png', 'jpg', 'jpeg', 'gif']) {
      const p = join(assetsDir, id + '.' + ext)
      if (existsSync(p)) { callback({ path: p }); return }
    }
    callback({ error: -2 })
  })
  // Serve rendered slide thumbnails: twthumb://<slug>/<key> -> {userData}/thumb-cache/<slug>/<key>.png
  protocol.registerFileProtocol('twthumb', (request, callback) => {
    try {
      const url = new URL(request.url)
      const slug = url.hostname
      const key = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!slug || !key) { callback({ error: -2 }); return }
      const p = join(app.getPath('userData'), thumbCacheRoot(), slug, key + '.png')
      if (existsSync(p)) { callback({ path: p }); return }
    } catch { /* fall through */ }
    callback({ error: -2 })
  })
  // Serve a recorded Session's local audio: twrec://<sessionId> -> {userData}/recordings/<id>.webm.
  // The session id is a controlled `sess-<utc>-<rand>` token (no user path input), so serving the
  // file directly is safe; Range requests (seeking) work via the stream-privileged scheme.
  protocol.registerFileProtocol('twrec', (request, callback) => {
    try {
      const sessionId = new URL(request.url).hostname
      if (!sessionId) { callback({ error: -2 }); return }
      const p = recordingAudioPath(app.getPath('userData'), sessionId)
      if (existsSync(p)) { callback({ path: p }); return }
    } catch { /* fall through */ }
    callback({ error: -2 })
  })
  // Serve in-memory live previews from the dedicated preview host, and Talk build files to
  // Studio replay everywhere else. Talk paths keep the existing containment guards.
  protocol.handle('twpresent', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname === 'preview') {
        const previewId = slidePreviewIdFromUrl(request.url)
        const html = previewId == null ? undefined : slidePreviewStore.get(previewId)
        return html == null
          ? new Response('Preview not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
          : new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      const slug = decodeURIComponent(url.hostname)
      const talk = talkBySlug(slug)
      if (!talk) return new Response('Not found', { status: 404 })
      const rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || `${slug}-present.html`
      const absPath = resolvePath(talk.path, rel)
      if (!isInsideArchive(absPath, talk.path)) return new Response('Not found', { status: 404 })
      if (existsSync(absPath) && statSync(absPath).isFile()) return net.fetch(pathToFileURL(absPath).href)
    } catch { /* fall through */ }
    return new Response('Not found', { status: 404 })
  })
  // Serve read-only old-PowerPoint archive image files: twarchive://<b64url> where b64url is
  // the base64url of an absolute file path. Decode, then serve ONLY if the resolved real path
  // sits inside the archive root (path-traversal guard via realpath/resolve + startsWith).
  protocol.registerFileProtocol('twarchive', (request, callback) => {
    try {
      const archiveRoot = detectArchiveRoot()
      if (!archiveRoot) { callback({ error: -2 }); return }
      // Payload is the case-preserved base64url in the URL path (twarchive://f/<b64url>).
      const b64 = decodeURIComponent(twarchivePayload(request.url))
      const decoded = fromBase64Url(b64)
      const absPath = resolvePath(decoded)
      if (!isInsideArchive(absPath, archiveRoot)) { callback({ error: -2 }); return }
      if (existsSync(absPath)) { callback({ path: absPath }); return }
    } catch { /* fall through */ }
    callback({ error: -2 })
  })
  // Serve local image files referenced by path in an outline: twfile://f/<b64url> where b64url
  // is the base64url of an absolute path. Served ONLY if the resolved real path sits inside the
  // vault root (path-traversal guard) — the editor uses this to preview path-based images.
  protocol.registerFileProtocol('twfile', (request, callback) => {
    try {
      const vaultRoot = getConfig('vaultRoot', undefined)
      if (!vaultRoot) { callback({ error: -2 }); return }
      const rest = request.url.slice('twfile://'.length)
      const slash = rest.indexOf('/')
      const payload = slash >= 0 ? rest.slice(slash + 1) : rest
      const decoded = fromBase64Url(decodeURIComponent(payload.replace(/\/+$/, '')))
      const absPath = resolvePath(decoded)
      if (!isInsideArchive(absPath, vaultRoot)) { callback({ error: -2 }); return }
      if (existsSync(absPath)) { callback({ path: absPath }); return }
    } catch { /* fall through */ }
    callback({ error: -2 })
  })
  createWindow()

  // Recording uploads are ON REQUEST ONLY (never automatic) — no launch drain, no retry loop.
  // A recording uploads only when the user clicks Upload in Studio (recording:upload).

  // Load any persisted search index, then warm stale entries in the background so the first ⌘K
  // is instant. Once the text index is warm, prerender only changed/new talks (or talks whose
  // thumbnail directory is missing); the persisted prerender ledger skips compilation entirely
  // for unchanged talks while keeping cross-Talk search backed by rendered slides (ADR-0019).
  loadSearchIndexFromDisk()
  loadOcrCache()
  setTimeout(() => {
    warmSearchIndex()
      .catch(() => {})
      .finally(() => {
        // Thumbnails first (visible payoff), then OCR-index the vault images for image-text search.
        setTimeout(() => {
          prerenderAllThumbnails()
            .catch(() => {})
            .finally(() => { setTimeout(() => { ocrAllVaultImages().catch(() => {}) }, 1500) })
        }, 1200)
      })
  }, 800)
  // Presentation backup: start the timer, and (if enabled) do one sweep a bit after launch so the
  // OneDrive/Dropbox folder is fresh from the first run, not only after the first interval elapses.
  startBackupScheduler()
  if (getConfig('backupEnabled', false) && getConfig('backupFolder', undefined)) {
    setTimeout(() => { runBackupSweep(false).catch(() => {}) }, 8000)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
