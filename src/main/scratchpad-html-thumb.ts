// Thumbnails for an agent's HTML page in the Slide Scratchpad. The page is captured once in a hidden window
// (scratchpad-html-capture.ts, the same sandboxed preview path as scratchpad-html.ts) and the PNG is kept in the
// app's own cache folder, keyed by file path + mtime + size, so an edited page is captured again and nothing is
// ever written into the talk's scratch folder. The same capture also reads the words the page rendered (a widget that
// builds its text from script data has none in its source); they are kept beside the PNG under the same key and feed
// the panel's search. One capture at a time; a page that does not finish in time gets no thumbnail (the panel keeps
// its placeholder) and is not retried until it changes.
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchSnapshotIdentity } from './scratchpad-disk.ts'
import type { ScratchHtmlPreview } from './scratchpad-html.ts'

export const HTML_THUMB_TIMEOUT_MS = 8000
export const MAX_RENDERED_TEXT = 20_000
const MAX_THUMB_BYTES = 4 * 1024 * 1024

/** The cache key: the same file at the same size and modification time is the same picture. */
export function htmlThumbKey(path: string, mtimeMs: number, size: number): string {
  const snapshot = scratchSnapshotIdentity(path)
  return createHash('sha256').update(snapshot ? `snapshot\0${snapshot}` : `${path}\0${Math.round(mtimeMs)}\0${size}`).digest('hex').slice(0, 40)
}

export interface HtmlThumbDeps {
  cacheDir: string
  preview: (path: string) => Promise<ScratchHtmlPreview | { error: string }>
  /** Loads the preview in a hidden window and returns a PNG (plus the text the page rendered), or null when it could
   *  not (including time-out). A bare Buffer is a picture with no text. */
  capture: (preview: ScratchHtmlPreview, timeoutMs: number) => Promise<Buffer | { png: Buffer; text: string } | null>
  timeoutMs?: number
}

export type HtmlThumbnailer = ((path: string) => Promise<string | null>) & {
  /** The words the page rendered, from the cache (same key as the picture); '' until a capture has made them. */
  textFor: (path: string) => string
}

export function createHtmlThumbnailer(deps: HtmlThumbDeps): HtmlThumbnailer {
  const timeoutMs = deps.timeoutMs ?? HTML_THUMB_TIMEOUT_MS
  const inFlight = new Map<string, Promise<string | null>>()
  const failed = new Set<string>()
  const texts = new Map<string, string>()
  let tail: Promise<unknown> = Promise.resolve()
  const dataUrl = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`
  const textFile = (id: string): string => join(deps.cacheDir, `${id}.txt`)
  const idOf = (path: string): string | null => {
    try { const info = lstatSync(path); return info.isFile() ? htmlThumbKey(path, info.mtimeMs, info.size) : null } catch { return null }
  }

  const render = async (path: string, id: string, file: string): Promise<string | null> => {
    const preview = await deps.preview(path)
    if ('error' in preview) return null
    const got = await deps.capture(preview, timeoutMs).catch(() => null)
    const png = got === null ? null : Buffer.isBuffer(got) ? got : got.png
    const words = got === null || Buffer.isBuffer(got) ? '' : got.text.slice(0, MAX_RENDERED_TEXT)
    if (!png || png.length === 0 || png.length > MAX_THUMB_BYTES) { failed.add(id); return null }
    try {
      mkdirSync(deps.cacheDir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, png)
      renameSync(tmp, file)
      const wordsTmp = `${textFile(id)}.${process.pid}.tmp`
      writeFileSync(wordsTmp, words)
      renameSync(wordsTmp, textFile(id))
    } catch { /* an unwritable cache only costs a re-capture */ }
    texts.set(id, words)
    return dataUrl(png)
  }

  async function thumbFor(path: string): Promise<string | null> {
    const id = idOf(path)
    if (id === null) return null
    const file = join(deps.cacheDir, `${id}.png`)
    // A picture cached before the words were kept has no .txt beside it: it is captured once more to get them.
    try { const png = readFileSync(file); readFileSync(textFile(id)); return dataUrl(png) } catch { /* not cached yet */ }
    if (failed.has(id)) return null
    let pending = inFlight.get(id)
    if (!pending) {
      const run = tail.then(() => render(path, id, file), () => render(path, id, file))
      tail = run.catch(() => undefined) // concurrency 1: the next capture starts when this one ends
      pending = run.finally(() => { inFlight.delete(id) })
      inFlight.set(id, pending)
    }
    return pending
  }

  function textFor(path: string): string {
    const id = idOf(path)
    if (id === null) return ''
    const hit = texts.get(id)
    if (hit !== undefined) return hit
    try { const words = readFileSync(textFile(id), 'utf8'); texts.set(id, words); return words } catch { return '' }
  }
  return Object.assign(thumbFor, { textFor })
}
