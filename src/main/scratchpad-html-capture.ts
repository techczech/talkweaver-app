// The hidden window behind the Slide Scratchpad's HTML thumbnails (scratchpad-html-thumb.ts). The page is shown
// the way the panel shows it: inside an iframe with the embed sandbox (opaque origin, scripts and forms only),
// loaded from the scratchpad preview store through twpresent://preview/…. The window has no preload and no
// Node, opens nothing, shows no dialogs and is destroyed after one picture or after the time-out.
import { BrowserWindow, type WebFrameMain } from 'electron'
import { createHash } from 'node:crypto'
import { markHiddenRenderer } from './window-kinds'
import { slidePreviewUrl, type SlidePreviewStore } from '../shared/slide-preview.ts'
import { previewFrame, samePreviewAddress, type ScratchHtmlPreview } from './scratchpad-html.ts'

const WIDTH = 1280
const HEIGHT = 800
const THUMB_WIDTH = 640
const SETTLE_MS = 700

const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** The picture and the words the page rendered (document.body.innerText of the sandboxed frame, capped). */
export interface HtmlCapture { png: Buffer; text: string }
const MAX_WORDS = 20_000

export function createHtmlCapture(deps: { store: SlidePreviewStore }) {
  return async function capture(preview: ScratchHtmlPreview, timeoutMs: number): Promise<HtmlCapture | null> {
    const wrapper = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff;overflow:hidden"><iframe sandbox="${escapeAttr(preview.sandbox)}" credentialless src="${escapeAttr(preview.url)}" referrerpolicy="no-referrer" style="border:0;width:100vw;height:100vh"></iframe>`
    const id = `scratch-thumb-${createHash('sha256').update(wrapper).digest('hex').slice(0, 24)}`
    deps.store.set(id, wrapper)
    const win = new BrowserWindow({
      show: false, width: WIDTH, height: HEIGHT, useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, disableDialogs: true }
    })
    markHiddenRenderer(win)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-prevent-unload', (event) => event.preventDefault())
    win.webContents.setAudioMuted(true)
    // The page's frame goes to its own preview address and nowhere else: a page that sends its frame (or a frame it
    // adds) to twfile://, another twpresent:// page or anywhere at all is refused, so the picture and the words can
    // only ever be of this page.
    win.webContents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame) return
      if (!samePreviewAddress(event.url, preview.url)) event.preventDefault()
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const work = (async (): Promise<HtmlCapture | null> => {
        await win.loadURL(slidePreviewUrl(id))
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
        if (win.isDestroyed()) return null
        // Before the picture and before the words: the one frame must still be showing this page.
        const pageFrame = (): WebFrameMain | null => {
          if (win.isDestroyed()) return null
          const top = win.webContents.mainFrame
          return previewFrame(top.url, top.frames.map((f) => ({ frame: f, url: f.url })), preview.url)
        }
        if (!pageFrame()) return null
        const image = await win.webContents.capturePage()
        if (image.isEmpty()) return null
        const png = image.resize({ width: THUMB_WIDTH, quality: 'good' }).toPNG()
        // The page's own rendered words, read from outside: main runs one read-only expression in the sandboxed child
        // frame (opaque origin, no preload, no Node for the page), so the page gains no power and no channel.
        let text = ''
        try {
          const child = pageFrame()
          const raw: unknown = child ? await child.executeJavaScript('document.body ? document.body.innerText : ""') : ''
          text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_WORDS) : ''
        } catch { /* the picture is still good without the words */ }
        return { png, text }
      })()
      const limit = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })
      return await Promise.race([work, limit])
    } catch { return null } finally {
      if (timer) clearTimeout(timer)
      if (!win.isDestroyed()) win.destroy()
    }
  }
}
