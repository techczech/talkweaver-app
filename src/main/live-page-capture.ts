// A saved view of a live web page (the capture gallery), main's side: which talk it belongs to, the
// checks before the write, and the write's own process. The write itself is live-page-capture-core.ts
// (run in live-page-capture-worker.ts, started in the talk folder); the picture is taken in
// live-page-host.ts from the page's own view only, on the deck's Capture press.
//
// Rules this module holds:
//   - The talk is the one the deck WINDOW presents, as main recorded it when it opened that window
//     (index.ts: presentWindows / the opener's record for a child window). Nothing the deck or the
//     page says names a talk, a folder or a file.
//   - The talk's vault is resolved again for every capture (it may have been closed or gone missing);
//     nothing ever re-creates a missing vault. The outline must be a file inside it.
//   - One capture is written at a time per app (a queue); each saved view is its own new file, so
//     other writers (another TalkWeaver, a sync) never lose a view to it either.
//   - Main writes nothing: it checks, names the job (real paths and the outline's identity, now) and
//     hands it to the capture's own process.
import { randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { basename, dirname } from 'node:path'
import { pathStaysInside } from './path-containment.ts'
import { normaliseCaptureUrl } from '../../compiler/scripts/lib/live-page-captures.mjs'
import { captureMarkupLine, placeCaptureLines, slideHeadingRef } from '../../compiler/scripts/lib/live-page-capture-markup.mjs'
import { CAPTURE_TEXT, captureRefusal, isCaptureAnswer, type CaptureAnswer, type CaptureJob } from './live-page-capture-core.ts'
import type { LivePageCaptureRequest, LivePageCaptureResult } from './live-page-host.ts'

export const LIVE_PAGE_CAPTURE_TIMEOUT_MS = 30_000
/** The longest side a saved view is stored at (wider pictures are scaled down, never up). */
export const CAPTURE_MAX_WIDTH = 1920
export const CAPTURE_JPEG_QUALITY = 85

export type CaptureMainFs = Pick<typeof nodeFs, 'existsSync' | 'statSync' | 'realpathSync'>

const realNow = (fs: CaptureMainFs, path: string): string => (fs.realpathSync.native ?? fs.realpathSync)(path)

/**
 * The talk a window's captures go to. `bound`: a capture window (Capture embed…) serves ONE slide's
 * page, named by main when it opened the window; a capture reported for any other slide or page is
 * refused.
 */
export type CaptureTarget = { root: string; outlinePath: string; bound?: { slideId: string; pageUrl: string } }

/** Where a saved view went in the talk's outline: its {capture} line under the slide's page, or why not. */
export type CapturePlacement = { ok: true; changed: boolean } | { ok: false; message: string }

/** Main's checks, read-only: the job for the capture's own process, or a refusal. */
export function livePageCaptureJob(target: CaptureTarget, request: LivePageCaptureRequest, now: Date, fs: CaptureMainFs = nodeFs, newId: () => string = () => randomBytes(6).toString('hex')): { ok: true; job: CaptureJob } | { ok: false; message: string } {
  const { root, outlinePath } = target
  const pageUrl = normaliseCaptureUrl(request.pageUrl)
  if (!pageUrl) return { ok: false, message: 'This page’s address cannot have saved views.' }
  if (!outlinePath.endsWith('-outline.md') || !fs.existsSync(root)) return { ok: false, message: 'The talk’s vault is not available, so the view was not saved.' }
  if (!pathStaysInside(root, outlinePath)) return { ok: false, message: CAPTURE_TEXT['outside-vault'] }
  let outline: nodeFs.Stats
  try { outline = fs.statSync(outlinePath) } catch { return { ok: false, message: 'The talk’s outline is not there any more, so the view was not saved.' } }
  if (!outline.isFile()) return { ok: false, message: 'The talk’s outline is not there any more, so the view was not saved.' }
  let realRoot: string
  let realTalkPath: string
  try { realRoot = realNow(fs, root); realTalkPath = realNow(fs, dirname(outlinePath)) } catch { return { ok: false, message: 'The talk’s folder is not available, so the view was not saved.' } }
  if (!pathStaysInside(realRoot, realTalkPath, true)) return { ok: false, message: CAPTURE_TEXT['outside-vault'] }
  const currentUrl = request.currentUrl ? normaliseCaptureUrl(request.currentUrl) : null
  const slideId = /^[A-Za-z0-9._:-]{0,128}$/.test(request.slideId) ? request.slideId : ''
  return {
    ok: true,
    job: {
      realRoot, realTalkPath, outlineName: basename(outlinePath), outline: { dev: outline.dev, ino: outline.ino },
      pageUrl,
      capture: {
        id: `cap-${newId()}`,
        capturedAt: now.toISOString(),
        ...(currentUrl ? { currentUrl } : {}),
        slideId,
        width: request.width,
        height: request.height,
        source: request.source === 'audience' || request.source === 'presenter' ? request.source : 'window',
        viewport: { w: request.viewport.w, h: request.viewport.h, zoom: request.viewport.zoom },
        scroll: { fx: request.scroll.fx, fy: request.scroll.fy },
        ...(request.mode === 'page' ? { mode: 'page' as const, ...(request.truncated ? { truncated: true as const } : {}) } : {}),
        // Shown only through a {capture} line, never by the compatibility listing (earlierCapturesFor).
        slideMarkup: true as const
      },
      jpeg: request.jpeg
    }
  }
}

/** The capture's own process as main sees it: an Electron utility process (or, in tests, a Node child). */
export type LivePageCaptureChild = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: unknown) => void): unknown
  kill(): unknown
}
export type RunLivePageCapture = (job: CaptureJob) => Promise<CaptureAnswer>

/** One process per capture, started in the talk folder; it answers once and is ended. */
export function createLivePageCaptureRunner(workerPath: string, fork: (path: string, cwd: string) => LivePageCaptureChild, timeoutMs = LIVE_PAGE_CAPTURE_TIMEOUT_MS): RunLivePageCapture {
  return (job) => new Promise<CaptureAnswer>((resolve) => {
    let done = false
    let child: LivePageCaptureChild | null = null
    const finish = (answer: CaptureAnswer): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child?.kill() } catch { /* already gone */ }
      resolve(answer)
    }
    const failed = (): void => finish(captureRefusal('write-failed'))
    const timer = setTimeout(failed, timeoutMs)
    try {
      child = fork(workerPath, job.realTalkPath)
      child.on('message', (message) => finish(isCaptureAnswer(message) ? message : captureRefusal('write-failed')))
      child.on('exit', failed)
      child.postMessage(job)
    } catch { failed() }
  })
}

/** A saved view to put on its slide; `earlier`: the page's views saved before {capture} lines. */
export type SavedViewToPlace = {
  slideId: string; pageUrl: string; image: string; capturedAt: string; mode: 'view' | 'page'
  earlier?: Array<{ image: string; capturedAt: string; mode?: 'page' }>
}

export type PlaceSavedViewDeps = {
  /** The talk's current text (the open editor's buffer, else the file). */
  read(outlinePath: string): Promise<string>
  /** The compiled slides of exactly that text: ids and 1-based source lines. */
  compiledSlides(outlinePath: string, text: string): Promise<Array<{ id: string; sourceLine: number | null }>>
  /** The one talk writer: `next` transforms the CURRENT text (it may be called again on a moved buffer; a throw leaves the text alone). */
  write(outlinePath: string, next: (current: string) => string): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }>
}

const PLACE_REFUSED: Record<string, string> = {
  'capture-embed-missing': 'the slide no longer shows this page',
  'capture-slide-ambiguous': 'more than one slide has this title and none has an id of its own, so it cannot be told which one it was for',
  'capture-slide-missing': 'the slide is no longer in the talk, or more than one slide has its id'
}

/**
 * A saved view's {capture} line, with the page's earlier views' lines, put into the talk through the
 * talk writer, as a transformation of whatever text is current when it applies. Its slide is the one
 * whose text carries the deck's id, or (an id the compiler derives from the heading; a compile of the
 * current text says which heading) the one slide with that heading line in the text changed; any
 * doubt refuses (live-page-capture-markup.mjs placeCaptureLines). One edit or none: the marker, the
 * earlier lines and this line together, so the outline says the embed is in the markup exactly when
 * its lines went in. The picture and its record are already saved either way, so a refusal loses
 * nothing, and the page goes on showing what it showed.
 */
export async function placeSavedView(deps: PlaceSavedViewDeps, outlinePath: string, view: SavedViewToPlace): Promise<CapturePlacement> {
  const line = captureMarkupLine(view.image, view.capturedAt, view.mode)
  const earlier = (view.earlier ?? []).map((e) => captureMarkupLine(e.image, e.capturedAt, e.mode === 'page' ? 'page' : 'view'))
  const kept = 'It is saved with the talk (in assets/live-page-captures) but not added to the slide'
  let slide: { id: string; heading?: string } = { id: view.slideId }
  let sharedTitle = false
  try {
    const text = await deps.read(outlinePath)
    const matches = (await deps.compiledSlides(outlinePath, text)).filter((s) => s.id === view.slideId)
    const ref = matches.length === 1 && matches[0].sourceLine !== null ? slideHeadingRef(text, matches[0].sourceLine) : null
    if (ref) slide = { id: view.slideId, ...ref }
    // A heading another slide also has: no identity to place by (said as such, not as "gone").
    else if (matches.length === 1 && matches[0].sourceLine !== null && /^#{1,6}\s/.test(text.split(/\r?\n/)[matches[0].sourceLine - 1] ?? '')) sharedTitle = true
  } catch { /* by its id only */ }
  let reason: string | undefined
  const result = await deps.write(outlinePath, (current) => {
    const placed = placeCaptureLines(current, slide, view.pageUrl, line, earlier)
    reason = placed.reason
    return placed.text
  })
  if (!result.ok) return { ok: false, message: `${kept}: the talk could not be changed just now.` }
  if (!reason) return { ok: true, changed: result.changed }
  const why = reason === 'capture-slide-missing' && sharedTitle ? 'capture-slide-ambiguous' : reason
  return { ok: false, message: `${kept}: ${PLACE_REFUSED[why] ?? PLACE_REFUSED['capture-slide-missing']}.` }
}

export type LivePageCaptureSaverDeps = {
  /** The talk the deck window presents: its outline and the writable root of its open vault, now; null when none. */
  talkOf(deckId: number): CaptureTarget | null
  run: RunLivePageCapture
  /** After a saved view: the talk's compiled decks are stale (index.ts drops its prepared copies). */
  saved?(outlinePath: string): void
  /**
   * After a saved view: its {capture} line goes under the slide's page in the talk's outline, through
   * the one talk writer (index.ts: writeTalkOutline, a transformation of the CURRENT text: the open
   * editor's buffer as one change, or the closed file in place). Absent: the view stays recorded only.
   */
  place?(outlinePath: string, view: SavedViewToPlace): Promise<CapturePlacement>
  now?: () => Date
  fs?: CaptureMainFs
}

/** The save step the host calls, for one deck window: talk from main's record, one capture at a time. */
export function createLivePageCaptureSaver(deps: LivePageCaptureSaverDeps): (deckId: number, request: LivePageCaptureRequest) => Promise<LivePageCaptureResult> {
  let queue: Promise<unknown> = Promise.resolve()
  return (deckId, request) => {
    const step = queue.then(async (): Promise<LivePageCaptureResult> => {
      const target = deps.talkOf(deckId)
      if (!target) return { ok: false, message: 'This window’s talk is not open in TalkWeaver any more, so the view was not saved.' }
      if (target.bound && (target.bound.slideId !== request.slideId || target.bound.pageUrl !== normaliseCaptureUrl(request.pageUrl))) {
        return { ok: false, message: 'This window captures one slide’s page; that view was for another, so it was not saved.' }
      }
      const prepared = livePageCaptureJob(target, request, (deps.now ?? (() => new Date()))(), deps.fs ?? nodeFs)
      if (!prepared.ok) return prepared
      // The press waited in the queue: the page, slide and source view must still be the press's.
      if (request.isCurrent && !request.isCurrent()) return { ok: false, message: 'The slide or page changed while capturing, so that view was not saved.' }
      const answer = await deps.run(prepared.job)
      if (!answer.ok) return { ok: false, message: answer.message }
      try { deps.saved?.(target.outlinePath) } catch { /* the next compile picks it up */ }
      let placed: CapturePlacement = { ok: false, message: 'It is saved with the talk but not on the slide.' }
      if (deps.place && answer.capture.slideId) {
        try {
          placed = await deps.place(target.outlinePath, { slideId: answer.capture.slideId, pageUrl: prepared.job.pageUrl, image: answer.image, capturedAt: answer.capture.capturedAt, mode: answer.capture.mode === 'page' ? 'page' : 'view', earlier: answer.earlier })
        } catch { placed = { ok: false, message: 'It is saved with the talk but could not be added to the slide.' } }
      }
      if (placed.ok) { try { deps.saved?.(target.outlinePath) } catch { /* as above */ } }
      return { ok: true, capturedAt: answer.capture.capturedAt, count: answer.count, how: answer.how, image: answer.image, mode: answer.capture.mode === 'page' ? 'page' : 'view', onSlide: placed.ok, ...(placed.ok ? {} : { note: placed.message }) }
    })
    queue = step.catch(() => {})
    return step.catch(() => ({ ok: false as const, message: CAPTURE_TEXT['write-failed'] }))
  }
}

/** A NativeImage-like picture as a JPEG of at most CAPTURE_MAX_WIDTH wide; null when empty. */
export type NativeImageLike = {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; quality?: 'good' | 'better' | 'best' }): NativeImageLike
  toJPEG(quality: number): Uint8Array
}
export function encodeCapture(image: unknown): { jpeg: Uint8Array; width: number; height: number } | null {
  const img = image as NativeImageLike | null
  if (!img || typeof img.isEmpty !== 'function' || img.isEmpty()) return null
  let size = img.getSize()
  if (!(size.width > 0 && size.height > 0)) return null
  let out = img
  if (size.width > CAPTURE_MAX_WIDTH) { out = img.resize({ width: CAPTURE_MAX_WIDTH, quality: 'best' }); size = out.getSize() }
  const jpeg = out.toJPEG(CAPTURE_JPEG_QUALITY)
  if (!jpeg || jpeg.length < 4) return null
  return { jpeg: new Uint8Array(jpeg), width: Math.round(size.width), height: Math.round(size.height) }
}
