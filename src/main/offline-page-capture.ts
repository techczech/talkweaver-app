import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { openSync, readFileSync, fstatSync, closeSync, realpathSync, constants } from 'node:fs'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { hardenLivePageSession, livePageWebPreferences, registerLivePageContents, type LivePageSession } from './live-page-host'
import { parseLivePageUrl, type LoopbackAllowance } from './live-page-policy'
import { markHiddenRenderer } from './window-kinds'
import { offlineAuthorityCurrent, type OfflinePageAuthority } from './offline-page'
import { containCaptureSession, containCaptureContents, captureNetworkReady, captureResponseHeaders } from './capture-network'
import { readOfflinePage } from './offline-page-dom.js'
import { buildOfflinePage, isOfflineImage, OFFLINE_PAGE_MAX_BYTES, type OfflinePageResult } from './offline-page-policy'

export type OfflineSource = { kind: 'remote'; url: string } | { kind: 'local'; directory: string; name: string }
const below = (root: string, path: string): boolean => { const rel = relative(root, path); return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }

/** Source authority is the current talk's directory, never a renderer-supplied absolute file path. */
export function offlineSource(target: OfflinePageAuthority, source: unknown, allowance: LoopbackAllowance = new Set()): OfflineSource | null {
  if (!offlineAuthorityCurrent(target)) return null
  const remote = parseLivePageUrl(source, allowance)
  if (remote) return { kind: 'remote', url: remote.href }
  if (typeof source !== 'string' || !source || isAbsolute(source) || /[\0\\?#:]/.test(source) || !/\.html?$/i.test(source)) return null
  try {
    const root = target.realTalkPath
    const path = realpathSync.native(join(root, source))
    if (!below(root, path)) return null
    return { kind: 'local', directory: dirname(path), name: path.slice(dirname(path).length + 1) }
  } catch { return null }
}

/** Descriptor read refuses links at every path component on macOS, just as the existing importer does. */
function localResource(directory: string, pathname: string): Buffer {
  if (process.platform !== 'darwin') throw Error('Local page capture is available on macOS.')
  const path = realpathSync.native(join(directory, decodeURIComponent(pathname)))
  if (!below(directory, path)) throw Error('Outside source folder')
  const fd = openSync(path, constants.O_RDONLY | 0x20000000)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw Error('Resource too large')
    const bytes = readFileSync(fd)
    if (bytes.length > 4 * 1024 * 1024) throw Error('Resource too large')
    return bytes
  } finally { closeSync(fd) }
}
const mimeFor = (path: string): string => ({ html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', csv: 'text/csv' }[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream')

export async function captureOfflinePage(source: OfflineSource, allowance: LoopbackAllowance = new Set()): Promise<OfflinePageResult> {
  const isolated = session.fromPartition(`tw-offline:${randomUUID()}`)
  hardenLivePageSession(isolated as unknown as LivePageSession, { allowance, userAgent: isolated.getUserAgent() })
  const origin = 'https://offline-page.invalid'
  if (source.kind === 'local') {
    // A synthetic origin serves only descriptor-checked source-folder bytes. Chromium never opens a file.
    isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      try { callback({ cancel: new URL(details.url).origin !== origin && !/^(data|blob):/.test(details.url) }) } catch { callback({ cancel: true }) }
    })
    isolated.protocol.handle('https', request => {
      try {
        const url = new URL(request.url)
        if (url.origin !== origin) return new Response('', { status: 403 })
        const headers = new Headers({ 'Content-Type': mimeFor(url.pathname) })
        for (const [name, values] of Object.entries(captureResponseHeaders())) for (const value of values) headers.append(name, value)
        return new Response(new Uint8Array(localResource(source.directory, url.pathname)), { headers })
      } catch { return new Response('', { status: 404 }) }
    })
  }
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, useContentSize: true,
    webPreferences: livePageWebPreferences(isolated, false) })
  markHiddenRenderer(win)
  const unregister = registerLivePageContents(win.webContents.id)
  // Its own guard refuses every page navigation; remote redirect hops still pass the public URL policy.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('will-frame-navigate', event => { if (!event.isMainFrame) event.preventDefault() })
  win.webContents.on('will-redirect', event => { if (source.kind === 'local' || !parseLivePageUrl(event.url, allowance)) event.preventDefault() })
  win.webContents.on('will-prevent-unload', event => event.preventDefault())
  win.webContents.setAudioMuted(true)
  let releaseProxy: (() => void) | undefined
  let stage = 'initialise capture'
  let timer: ReturnType<typeof setTimeout> | undefined
  const data: Array<{ url: string; body: string }> = []
  const responses = new Map<string, string>()
  const reads: Promise<unknown>[] = []
  let dataBytes = 0
  try {
    const work = async (): Promise<OfflinePageResult> => {
      stage = 'prepare isolated capture'
      releaseProxy = await containCaptureSession(isolated, { denyAll: source.kind === 'local', testAllowance: allowance })
      if (win.isDestroyed()) { releaseProxy(); throw Error('Capture ended') }
      await containCaptureContents(win.webContents)
      await win.webContents.debugger.sendCommand('Network.enable')
      win.webContents.debugger.on('message', (_event, method, params) => {
        if (method === 'Network.responseReceived' && responses.size < 20 && /^(?:application|text)\/(?:[a-z.+-]*\+)?json$/i.test(params.response?.mimeType ?? '')) {
          responses.set(params.requestId, String(params.response.url).slice(0, 2048))
        }
        if (method === 'Network.loadingFinished' && params.encodedDataLength <= 2 * 1024 * 1024 && responses.has(params.requestId)) {
          const url = responses.get(params.requestId)!
          reads.push(win.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(result => {
            const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : String(result.body)
            if (body.length <= 2 * 1024 * 1024 && dataBytes + body.length <= 4 * 1024 * 1024) {
              dataBytes += body.length
              const clean = new URL(url); clean.search = ''; clean.hash = ''
              data.push({ url: clean.href, body })
            }
          }).catch(() => {}))
        }
      })

      const url = source.kind === 'remote' ? source.url : `${origin}/${encodeURIComponent(source.name)}`
      stage = 'load page'
      await win.loadURL(url)
      await new Promise(resolve => setTimeout(resolve, 900))
      if (!await captureNetworkReady(win.webContents)) throw Error('Capture network lockdown missing')
      stage = 'read rendered page'
      const raw: unknown = await win.webContents.executeJavaScriptInIsolatedWorld(1078, [{ code: `(${readOfflinePage.toString()})()` }], false)
      const page = raw as { images?: Array<{ src?: unknown }> }
      stage = 'save supporting images'
      const pictures: Array<string | null> = []
      let bytes = 0
      for (const item of (Array.isArray(page?.images) ? page.images : []).slice(0, 100)) {
        let image: string | null = null
        try {
          if (isOfflineImage(item.src)) image = item.src
          else if (typeof item.src === 'string') {
            const candidate = new URL(item.src)
            const permitted = source.kind === 'local' ? candidate.origin === origin : !!parseLivePageUrl(candidate.href, allowance)
            if (permitted) {
              const response = await isolated.fetch(candidate.href)
              const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
              if (response.ok && type && /^image\/(png|jpeg|gif|webp|avif)$/.test(type)) {
                const chunks: Uint8Array[] = []; let length = 0
                const reader = response.body?.getReader()
                if (reader) try {
                  for (;;) {
                    const { value, done } = await reader.read(); if (done) break
                    length += value.byteLength
                    if (length > 4 * 1024 * 1024 || bytes + length > 12 * 1024 * 1024) throw Error('Image budget')
                    chunks.push(value)
                  }
                  image = `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`
                } finally { await reader.cancel().catch(() => {}) }
              }
            }
          }
          if (image) { bytes += image.length; if (bytes > OFFLINE_PAGE_MAX_BYTES) image = null }
        } catch { image = null }
        pictures.push(image)
      }
      stage = 'save supporting data'
      await Promise.allSettled(reads)
      return buildOfflinePage(raw, pictures, data)
    }
    return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('The page took too long to save.')), 20_000) })])
  } catch (error) {
    console.warn(`[offline-page] Failed at ${stage}: ${error instanceof Error ? error.name : 'error'}`)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    unregister()
    if (!win.isDestroyed()) win.destroy()
    releaseProxy?.()
    if (source.kind === 'local') isolated.protocol.unhandle('https')
    // Follow live-page-host's disposal: cleanup is requested, never an unbounded condition for returning.
    void Promise.allSettled([isolated.clearStorageData(), isolated.clearCache()])
  }
}
