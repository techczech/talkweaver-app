// Capture embed… (owner request 2026-10-27: "build a separate capture web embeds ui so that I can do it
// for just the one embed prior to presenting"): a window of its own for ONE slide's web page, opened
// from the inspector, in which the person scrolls the live page, captures the visible view or the
// entire page, and sees the views already on the slide.
//
// No new authority. The window's page is the app's own (src/renderer/capture-embed.html, no preload,
// no IPC); it implements the same slot contract a presenter deck does (`__twLivePageSlot` and the
// state / captured callbacks), so the live page is shown, guarded and captured by the same host
// (live-page-host.ts, role 'presenter') and saved by the same writer and talk-writer path as a Capture
// press in the presenter. What this module adds is main's side of opening it:
//   - checkCaptureEmbedRequest: the editor's request, every field checked; the talk must be inside a
//     writable vault, the address a web page the live view may open, the slide id an id;
//   - readCaptureEmbedViews: the pictures of the views already on the slide, for the list. Only the
//     capture writer's own picture paths, read from the talk's own folder by ONE open that the kernel
//     refuses if any component of the path is a link (macOS O_NOFOLLOW_ANY; review 2026-10-27, P2: a
//     path checked first and opened after could be redirected by swapping a folder in between), as
//     regular files under the picture size limit, JPEG only; on other systems no picture is read;
//     bounded in number and total bytes (more are listed without a picture);
//   - captureEmbedInitScript: the one fixed call main makes into the page, with JSON only.
// The window is bound in main to { talk, slide, page } (index.ts, CaptureTarget.bound): a report for
// any other slide or page is refused by the saver before anything is written.
import * as nodeFs from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isCaptureImagePath, MAX_CAPTURE_IMAGE_BYTES, normaliseCaptureUrl } from '../../compiler/scripts/lib/live-page-captures.mjs'
import { parseLivePageUrl, type LoopbackAllowance } from './live-page-policy.ts'
import { O_NOFOLLOW_ANY } from './live-page-capture-core.ts'
import { htmlPageImportSupportedOn } from './html-page-import-core.ts'

export const CAPTURE_EMBED_MAX_VIEWS = 60
/** At most this many pictures are sent to the window, and at most this many bytes in all. */
export const CAPTURE_EMBED_MAX_PICTURES = 24
export const CAPTURE_EMBED_MAX_PICTURE_BYTES = 48 * 1024 * 1024
const SLIDE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export type CaptureEmbedRequest = { outlinePath: string; root: string; slideId: string; pageUrl: string; title: string; images: string[] }
export type CaptureEmbedView = { image: string; src: string | null; alt: string }

export const CAPTURE_EMBED_TEXT = {
  noTalk: 'This talk is not in an open vault TalkWeaver can write to, so its embed cannot be captured.',
  noSlide: 'Choose a slide that shows a web page, then Capture embed.',
  notWebPage: 'TalkWeaver captures only web pages on the internet (not this computer, the local network or other kinds of address).',
  noEditor: 'Capture embed opens from an editor window.'
} as const

const clean = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''

/** The editor's request, checked. `writableTalkRoot`: the open vault root a talk may be written in, or undefined. */
export function checkCaptureEmbedRequest(
  raw: unknown,
  deps: { writableTalkRoot(outlinePath: string): string | undefined; allowance?: LoopbackAllowance }
): { ok: true; request: CaptureEmbedRequest } | { ok: false; message: string } {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const outlinePath = typeof r.outlinePath === 'string' && r.outlinePath && !r.outlinePath.includes('\0') && r.outlinePath.endsWith('-outline.md') ? r.outlinePath : ''
  const root = outlinePath ? deps.writableTalkRoot(outlinePath) : undefined
  if (!outlinePath || !root) return { ok: false, message: CAPTURE_EMBED_TEXT.noTalk }
  const slideId = typeof r.slideId === 'string' && SLIDE_ID_RE.test(r.slideId) ? r.slideId : ''
  if (!slideId) return { ok: false, message: CAPTURE_EMBED_TEXT.noSlide }
  const url = parseLivePageUrl(r.pageUrl, deps.allowance)
  const pageUrl = url ? normaliseCaptureUrl(url.href) : null
  if (!pageUrl) return { ok: false, message: CAPTURE_EMBED_TEXT.notWebPage }
  const images = Array.isArray(r.images) ? r.images.filter((v): v is string => isCaptureImagePath(v)).slice(0, CAPTURE_EMBED_MAX_VIEWS) : []
  return { ok: true, request: { outlinePath, root, slideId, pageUrl, title: clean(r.title, 200), images: [...new Set(images)] } }
}

type ReadFs = Pick<typeof nodeFs, 'realpathSync' | 'openSync' | 'fstatSync' | 'readSync' | 'closeSync' | 'constants'>

/**
 * One saved picture of the talk, read safely; null when it is missing, behind a link, too large or not
 * a JPEG. `realTalkDir` is the talk folder's real path. The picture is opened ONCE with
 * O_NOFOLLOW_ANY, so the kernel refuses the open if any folder on the path (the talk's, `assets`,
 * `live-page-captures` or one above) is a link at that moment: no check-then-open gap. Every read is
 * from that descriptor. Where that flag does not exist, nothing is read (fail closed).
 */
function readPicture(realTalkDir: string, image: string, fs: ReadFs, platformSupported: boolean): Uint8Array | null {
  if (!platformSupported || !isCaptureImagePath(image)) return null
  let fd: number | null = null
  try {
    fd = fs.openSync(join(realTalkDir, image), fs.constants.O_RDONLY | O_NOFOLLOW_ANY)
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size < 4 || st.size > MAX_CAPTURE_IMAGE_BYTES) return null
    const bytes = new Uint8Array(st.size)
    let at = 0
    while (at < bytes.length) {
      const n = fs.readSync(fd, bytes, at, bytes.length - at, at)
      if (n <= 0) break
      at += n
    }
    if (at !== bytes.length || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null
    return bytes
  } catch {
    return null
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* closed */ } }
  }
}

/** The views on the slide as the window lists them: pictures as JPEG data: addresses, bounded. */
export function readCaptureEmbedViews(outlinePath: string, images: Array<{ image: string; alt?: string }>, fs: ReadFs = nodeFs, platformSupported = htmlPageImportSupportedOn(process.platform)): CaptureEmbedView[] {
  let realTalkDir = ''
  try { realTalkDir = fs.realpathSync.native(dirname(outlinePath)) } catch { realTalkDir = '' }
  let sent = 0
  let bytes = 0
  return images.slice(0, CAPTURE_EMBED_MAX_VIEWS).map(({ image, alt }) => {
    let src: string | null = null
    if (realTalkDir && sent < CAPTURE_EMBED_MAX_PICTURES) {
      const picture = readPicture(realTalkDir, image, fs, platformSupported)
      if (picture && bytes + picture.length <= CAPTURE_EMBED_MAX_PICTURE_BYTES) {
        src = `data:image/jpeg;base64,${Buffer.from(picture).toString('base64')}`
        sent++
        bytes += picture.length
      }
    }
    return { image, src, alt: clean(alt, 200) }
  })
}

/** main → the window's page: the one fixed call, its argument JSON (escaped as deckCallScript does). */
export function captureEmbedInitScript(init: { slideId: string; pageUrl: string; title: string; host: string; views: CaptureEmbedView[] }): string {
  const json = JSON.stringify(JSON.stringify(init)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `window.__twCaptureEmbedInit && window.__twCaptureEmbedInit(${json})`
}

/** The window's page: the dev server in development, else the bundled file. */
export function captureEmbedPageUrl(rendererDevUrl: string | undefined, mainDir: string): string {
  if (rendererDevUrl) return `${rendererDevUrl}/capture-embed.html`
  return pathToFileURL(join(mainDir, '../renderer/capture-embed.html')).href
}
