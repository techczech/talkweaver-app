// Remote authoring previews are pixels, never a remote frame in the editor's session.
// The actual interactive page remains in live-page-host's isolated view (Capture embed / Present).
import { app, BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { hardenLivePageSession, livePageWebPreferences, registerLivePageContents, type LivePageSession } from './live-page-host'
import { createEmbedPreviewQueue } from './embed-preview-queue'
import { replaceRemoteEmbedFrames } from './embed-preview-policy'
import { containCaptureSession, containCaptureContents, captureNetworkReady } from './capture-network'
import { parseLivePageUrl, testLoopbackAllowance } from './live-page-policy'
import { markHiddenRenderer } from './window-kinds'

const cache = new Map<string, { image: string | null; expires: number }>()
const enqueueCapture = createEmbedPreviewQueue(capturePreviewPage, 8)

export async function capturePreviewPage(url: string, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return null
  const allowance = testLoopbackAllowance({ isPackaged: app.isPackaged, e2e: process.env.TW_E2E === '1', value: process.env.TW_E2E_LIVE_PAGE_ALLOW })
  if (!parseLivePageUrl(url, allowance)) return null
  const isolated = session.fromPartition(`tw-embed-preview:${randomUUID()}`)
  hardenLivePageSession(isolated as unknown as LivePageSession, { allowance, userAgent: isolated.getUserAgent() })
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true,
    webPreferences: livePageWebPreferences(isolated, false) })
  markHiddenRenderer(win)
  const unregister = registerLivePageContents(win.webContents.id)
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame) event.preventDefault() })
  win.webContents.on('will-redirect', event => { if (!parseLivePageUrl(event.url, allowance)) event.preventDefault() })
  win.webContents.on('will-prevent-unload', event => event.preventDefault())
  let stop: (() => void) | undefined
  const cancelled = new Promise<null>(resolve => {
    stop = () => { if (!win.isDestroyed()) win.destroy(); resolve(null) }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let releaseProxy: (() => void) | undefined
  try {
    return await Promise.race([
      cancelled,
      (async () => {
        releaseProxy = await containCaptureSession(isolated, { testAllowance: allowance })
        if (win.isDestroyed()) { releaseProxy(); return null }
        await containCaptureContents(win.webContents)
        if (signal.aborted) return null
        await win.loadURL(url)
        await new Promise(resolve => setTimeout(resolve, 700))
        if (win.isDestroyed() || !parseLivePageUrl(win.webContents.getURL(), allowance) || !await captureNetworkReady(win.webContents)) return null
        const image = await win.webContents.capturePage()
        return image.isEmpty() ? null : image.resize({ width: 960 }).toDataURL()
      })(),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 6000) })
    ])
  } catch { return null } finally {
    if (stop) signal.removeEventListener('abort', stop)
    if (timer) clearTimeout(timer)
    unregister()
    if (!win.isDestroyed()) win.destroy()
    releaseProxy?.()
    void Promise.allSettled([isolated.clearStorageData(), isolated.clearCache()])
  }
}

async function artwork(url: string, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null
  const hit = cache.get(url)
  if (hit && hit.expires > Date.now()) return hit.image
  const captured = await enqueueCapture(url, signal)
  if (signal?.aborted) return null
  const image = captured ?? hit?.image ?? null
  cache.delete(url)
  cache.set(url, { image, expires: Date.now() + (image ? 5 * 60_000 : 30_000) })
  while (cache.size > 24) cache.delete(cache.keys().next().value!)
  return image
}

/** Remote artwork entry point shared by the focused preview and thumbnail renderer. */
export const withRemoteEmbedArtwork = (html: string, signal?: AbortSignal, shouldCancel?: () => boolean): Promise<string> =>
  replaceRemoteEmbedFrames(html, (url, captureSignal) => artwork(url, captureSignal), signal, shouldCancel)
