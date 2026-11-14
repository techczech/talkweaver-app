import { mayCheckDevices } from '../shared/recording-devices'
import { readdirSync, lstatSync } from 'node:fs'
import { BrowserWindow, ipcMain, systemPreferences, shell } from 'electron'
import { join } from 'node:path'
import { createLayerStore, type Layer } from './recording-layers'
import type { RecordingStreams } from './recording-stream'
import { markHiddenRenderer } from './window-kinds'
import { createWarmSources } from './recording-warm'

/** Longest wait for the audience page to settle before the slides layer's first frame. */
export const FIRST_FRAME_SETTLE_MS = 2000
/**
 * Wait until the deck page has switched to its audience view (it first renders its ordinary view, with
 * its own toolbar), has its fonts, its finite animations (the first slide's entrance) have finished and
 * two frames have been drawn, or FIRST_FRAME_SETTLE_MS has passed. Infinite animations are not waited
 * for. Errors are ignored: the capture never fails because of this wait.
 */
export async function settleBeforeFirstFrame(contents: Pick<Electron.WebContents, 'executeJavaScript' | 'isDestroyed'>, ms = FIRST_FRAME_SETTLE_MS): Promise<void> {
  const script = `new Promise((done) => {
    const finite = () => (document.getAnimations ? document.getAnimations() : []).filter((a) => { try { return Number.isFinite(a.effect && a.effect.getComputedTiming().endTime) } catch { return false } })
    const frames = () => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))
    const settle = () => Promise.all([document.fonts ? document.fonts.ready : null, ...finite().map((a) => a.finished.catch(() => null))]).then(frames, frames)
    const audience = () => document.body && document.body.classList.contains('audience-mode') ? settle() : requestAnimationFrame(audience)
    audience()
  })`
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (contents.isDestroyed()) return
    await Promise.race([contents.executeJavaScript(script, true), new Promise((resolve) => { timer = setTimeout(resolve, ms) })])
  } catch { /* a page that cannot run it is captured as before */ } finally { clearTimeout(timer) }
}

export function registerPresenterLayers(deps: {
  userData: () => string
  /** Ids of Runs that are new takes of a slide (isTakeRun): not counted as recordings in the library. */
  takeIds?: () => Set<string>
  streams: RecordingStreams
  allowed: (id: number) => boolean
  settingsAllowed: (id: number) => boolean
  grantDevices: (id: number, camera: boolean, preview: boolean) => void
  getSettings: () => unknown
  setSettings: (value: unknown) => void
}) {
  const store = createLayerStore(join(deps.userData(), 'recordings'))
  // Ported from PR 316 tutorial-audience.ts: a fixed 1080p offscreen audience, no preload or media grant.
  function createAudienceSource(): BrowserWindow {
    const source = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1920, height: 1080, useContentSize: true,
      webPreferences: { offscreen: { useSharedTexture: false, deviceScaleFactor: 1 }, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true } })
    source.webContents.on('will-prevent-unload', event => event.preventDefault())
    markHiddenRenderer(source)
    source.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    source.webContents.on('will-navigate', e => e.preventDefault())
    source.webContents.on('will-redirect', e => e.preventDefault())
    return source
  }
  // The countdown warms the surface (recording:layers-warm) so it is painting the settled audience view
  // when the voice starts; a surface nobody takes within 30 s is closed.
  const warmSources = createWarmSources<BrowserWindow>({
    create: createAudienceSource,
    load: async (source, url) => { await source.loadURL(url); source.webContents.setFrameRate(30); source.webContents.startPainting() },
    settle: (source) => settleBeforeFirstFrame(source.webContents),
    idleMs: 30_000
  })
  function audienceUrl(sender: Electron.WebContents): URL {
    const url = new URL(sender.getURL())
    if (url.protocol !== 'file:') throw Error('Compiled deck required')
    url.searchParams.delete('presenter'); url.searchParams.delete('livepage'); url.searchParams.set('audience', '1')
    return url
  }
  const sources = new Map<number, BrowserWindow>()
  const sourceRuns = new WeakMap<BrowserWindow, string>()
  const stoppedSources = new WeakSet<BrowserWindow>()
  function stopSource(owner: number, id: string) {
    const source = sources.get(owner)
    if (!source || sourceRuns.get(source) !== id) return
    stoppedSources.add(source)
    if (!source.isDestroyed()) source.destroy()
    if (sources.get(owner) === source) sources.delete(owner)
  }
  const watching = new Set<number>()
  function watch(contents: Electron.WebContents) {
    const id = contents.id
    if (watching.has(id)) return
    watching.add(id)
    const release = () => {
      warmSources.close(id)
      sources.get(id)?.destroy(); sources.delete(id)
      store.closeOwner(id); deps.grantDevices(id, false, false)
    }
    contents.on('render-process-gone', release)
    contents.once('destroyed', () => { release(); watching.delete(id) })
  }
  const authorise = (event: Electron.IpcMainInvokeEvent) => {
    if (event.senderFrame !== event.sender.mainFrame || !deps.allowed(event.sender.id)) throw Error('Presenter required')
  }
  ipcMain.handle('recording:device-library', async (event, reveal: boolean) => {
    if (event.senderFrame !== event.sender.mainFrame || !deps.settingsAllowed(event.sender.id)) throw Error('Settings required')
    const root = join(deps.userData(), 'recordings')
    let bytes = 0
    const runs = new Set<string>()
    try {
      if (lstatSync(root).isSymbolicLink()) throw Error('Unsafe recordings folder')
      for (const name of readdirSync(root)) {
        const path = join(root, name), stat = lstatSync(path)
        if (stat.isSymbolicLink()) continue
        if (stat.isFile() && name.endsWith('.webm')) { runs.add(name.replace(/(?:\.seg-\d+(?:\.r\d+)?)?\.webm$/, '')); bytes += stat.size }
        if (stat.isDirectory()) {
          const capture = store.read(name)
          if (capture) { runs.add(name); bytes += Object.values(capture.layers).reduce((n, layer) => n + layer.bytes, 0) }
        }
      }
      if (reveal === true) await shell.openPath(root)
    } catch { /* A Mac with no recordings has an empty library. */ }
    // New takes of a slide are part of their Run, not recordings of their own (their bytes still count).
    const takes = (() => { try { return deps.takeIds?.() ?? new Set<string>() } catch { return new Set<string>() } })()
    return { count: [...runs].filter((id) => !takes.has(id)).length, bytes }
  })
  ipcMain.handle('recording:device-preview', (event, camera: boolean, preview: boolean) => {
    if (!mayCheckDevices(event.senderFrame === event.sender.mainFrame, deps.allowed(event.sender.id), deps.settingsAllowed(event.sender.id))) throw Error('Device settings window required')
    deps.grantDevices(event.sender.id, camera === true, preview === true)
    watch(event.sender)
  })
  ipcMain.handle('recording:devices', (event, value?: unknown) => {
    if (!mayCheckDevices(event.senderFrame === event.sender.mainFrame, deps.allowed(event.sender.id), deps.settingsAllowed(event.sender.id))) throw Error('Device settings window required')
    if (value !== undefined) {
      const v = value as { version?: unknown; microphone?: unknown; camera?: unknown; checkedAt?: unknown; micPermission?: unknown; cameraPermission?: unknown; cameraDeviceId?: unknown }
      if (!v || v.version !== 1 || ![v.microphone, v.camera, v.checkedAt, v.micPermission, v.cameraPermission].every(x => typeof x === 'string' && x.length <= 1000)) throw Error('Invalid device check')
      if (v.cameraDeviceId !== undefined && (typeof v.cameraDeviceId !== 'string' || v.cameraDeviceId.length > 1000)) throw Error('Invalid camera identity')
      deps.setSettings(value)
    }
    const permission = (kind: 'microphone' | 'camera') => process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus(kind) : 'granted'
    return { settings: deps.getSettings(), microphone: permission('microphone'), camera: permission('camera') }
  })
  ipcMain.handle('recording:device-settings', (event, kind: unknown) => {
    if (!mayCheckDevices(event.senderFrame === event.sender.mainFrame, deps.allowed(event.sender.id), deps.settingsAllowed(event.sender.id))) throw Error('Device settings window required')
    if (kind !== 'microphone' && kind !== 'camera') throw Error('Unknown device')
    if (kind === 'camera') return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera')
    return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
  })
  // During the countdown: make the slides surface ready before the recording's origin. Never fails the start.
  ipcMain.handle('recording:layers-warm', (event) => {
    authorise(event)
    try { warmSources.warm(event.sender.id, audienceUrl(event.sender).href); watch(event.sender); return true } catch { return false }
  })
  // Once the picture's start has settled either way (taken, failed or abandoned), a surface still warm is closed.
  ipcMain.handle('recording:layers-cool', (event) => {
    authorise(event)
    warmSources.close(event.sender.id)
  })
  ipcMain.handle('recording:layers-open', async (event, id: string, camera: boolean, restoring = false, at = 0) => {
    authorise(event)
    const owner = event.sender.id
    if (!deps.streams.tailProgress(owner, id)) throw Error('Run owner required')
    if (sources.has(owner)) throw Error('A capture is already open')
    const url = audienceUrl(event.sender)
    if (restoring) store.resume(owner, id, at, camera === true)
    else store.open(owner, id, camera === true)
    watch(event.sender)
    // The surface the countdown warmed, handed over without waiting for it to settle; otherwise a new one.
    const warmed = restoring ? null : warmSources.take(owner, url.href)
    if (restoring) warmSources.close(owner)
    const source = warmed?.source ?? createAudienceSource()
    sources.set(owner, source); sourceRuns.set(source, id)
    source.webContents.on('render-process-gone', () => { if (!event.sender.isDestroyed()) event.sender.send('recording:layer-source-lost', id) })
    const frameSource = source.webContents.id, ackChannel = `recording:frame-ready-${frameSource}-${id}`
    let pending = false, dirty = false, lastFrameAt = 0
    let repaint: ReturnType<typeof setTimeout> | undefined
    const redraw = () => {
      if (!dirty || pending || repaint || source.isDestroyed()) return
      repaint = setTimeout(() => {
        repaint = undefined
        if (dirty && !pending && !source.isDestroyed()) source.webContents.invalidate()
      }, Math.max(0, 100 - (Date.now() - lastFrameAt)))
    }
    // Every frame after the recording's origin is kept, settled or not.
    source.webContents.on('paint', (_e, _rect, frame) => {
      if (event.sender.isDestroyed()) return
      if (pending || Date.now() - lastFrameAt < 100) { dirty = true; redraw(); return }
      dirty = false
      pending = true; lastFrameAt = Date.now()
      event.sender.send('recording:layer-frame', frame.toBitmap(), frameSource, id, frame.getSize())
    })
    const ack = (ackEvent: Electron.IpcMainEvent) => { if (ackEvent.sender.id === owner && ackEvent.senderFrame === event.sender.mainFrame) { pending = false; redraw() } }
    ipcMain.on(ackChannel, ack)
    const cleanup = () => {
      ipcMain.removeListener(ackChannel, ack)
      if (!source.isDestroyed()) source.destroy()
      if (sources.get(owner) === source) sources.delete(owner)
    }
    watch(event.sender)
    source.once('closed', () => { clearTimeout(repaint); ipcMain.removeListener(ackChannel, ack); if (sources.get(owner) === source) sources.delete(owner) })
    try {
      if (warmed) await warmed.loaded
      else await source.loadURL(url.href)
      authorise(event)
      if (sources.get(owner) !== source || !deps.streams.tailProgress(owner, id)) throw Error('Capture was replaced'); source.webContents.setFrameRate(30); source.webContents.startPainting(); source.webContents.invalidate()
    }
    catch (e) {
      const current = sources.get(owner)
      cleanup()
      if (!stoppedSources.has(source) && (!current || current === source)) store.interrupt(owner, id)
      throw e
    }
    return { owner: owner }
  })
  ipcMain.handle('recording:layers-handover', (event, id: string, at: number) => {
    authorise(event); store.handover(event.sender.id, id, at)
  })
  ipcMain.handle('recording:layers-started', (event, id: string, layer: Layer, at: number) => {
    authorise(event); store.started(event.sender.id, id, layer, at)
  })
  ipcMain.handle('recording:layers-append', (event, id: string, layer: Layer, sequence: number, bytes: Uint8Array) => {
    authorise(event); store.append(event.sender.id, id, layer, sequence, bytes); return true
  })
  ipcMain.handle('recording:layers-checkpoint', (event, id: string, duration: number, lost?: Layer) => {
    authorise(event); store.checkpoint(event.sender.id, id, duration, lost)
  })
  ipcMain.handle('recording:layers-stop-source', (event, id: string) => {
    authorise(event)
    if (!deps.streams.tailProgress(event.sender.id, id)) throw Error('Run owner required')
    stopSource(event.sender.id, id)
  })
  ipcMain.handle('recording:layers-discard', async (event, id: string) => {
    authorise(event)
    if (!deps.streams.tailProgress(event.sender.id, id)) throw Error('Run owner required')
    const folder = store.discard(event.sender.id, id)
    stopSource(event.sender.id, id)
    if (folder) await shell.trashItem(folder)
  })
  ipcMain.handle('recording:layers-finish', (event, id: string) => {
    authorise(event)
    if (!deps.streams.tailProgress(event.sender.id, id)) throw Error('Run owner required')
    let manifest
    try { manifest = store.finish(event.sender.id, id) } catch {
      store.interrupt(event.sender.id, id)
      manifest = store.snapshot(event.sender.id, id) ?? store.read(id)
    }
    stopSource(event.sender.id, id)
    return manifest
  })
  return {
    ...store,
    interrupt(owner: number, id: string) {
      try { store.interrupt(owner, id) } finally { stopSource(owner, id) }
    }
  }
}
