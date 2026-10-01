// The picture of the author's OWN slide in another layout or option (ADR-0032 §6, "own slide over
// sample"): the picker's Suggested row and browse rows, and the Inspector's option pictures. One
// request names an outline, a slide and the layout (and options) to try; the answer says what became
// of it: a thumbnail URL of that slide rendered from the modified outline text, or why there is none.
// Nothing is written to the outline.
//
// Cost control (a variant is a full-deck compile plus a render):
//   - Jobs run one at a time here, so the shared render queue holds at most one variant, and that one
//     is marked `background` so the editor strip and the Slide Browser go ahead of it.
//   - The queue is bounded. Requests carry a `requestKey` (the asking surface); a newer request with
//     the same key for the same slide drops queued ones made from older outline text (they are stale).
//     A request for another slide of the same talk means the author left the slide: every queued job
//     for the slide she left (any surface) is dropped, so her new slide's first picture waits behind at
//     most the one job already running, never behind the old slide's queue.
//     Over a cap (per surface and slide, or overall) the NEWEST request is refused, never a job already
//     waiting its turn, so the next job to run is never thrown away. Refused and dropped callers get
//     `superseded`; the renderer's shared policy (variant-picture-queue.ts) asks again only while the
//     picture is still wanted, with backoff, and gives up after a few tries.
//   - The compile is the caller's `prepareTalk`, which main runs uncached and on the preparation gate's
//     background lane (see index.ts): a variant never displaces the live deck's prepared model, nothing
//     retains the variant's, and the live deck's compile never waits behind a variant's.
//
// Cached by content: the key hashes the modified outline text, the slide and a fingerprint of the
// local media the outline references (mtime and size), so a repeat try answers from memory without a
// compile, and a replaced image is drawn again. The PNG itself is content-addressed by the renderer.
// Everything Electron-bound is passed in, so the module and its IPC handler run headless under test.
import { createHash } from 'crypto'
import { existsSync, statSync } from 'fs'
import { dirname, isAbsolute, resolve } from 'path'
import { LayoutVerbError, previewLayout, type LayoutOptionChoice } from '../shared/layout-verbs.ts'
import type { VariantThumbnail } from '../shared/variant-thumbnail-result.ts'
import { selectedThumbnailSlide, selectedThumbnailSlideAtLine, type IndexedThumbnailSlide, type ThumbnailProjectionRow } from '../shared/slide-preview.ts'

export interface VariantThumbnailRequest {
  outlinePath: string
  outline: string
  /** The slide's `{id=…}`; for a slide with none yet, `line:<heading line>` (see `headingLine`). */
  slideId: string
  /** The slide's 1-based heading line, for a slide that has no `{id=…}` yet (new slides are unstamped until saved). */
  headingLine?: number
  layout: string
  options?: readonly LayoutOptionChoice[]
  /** The asking surface (`picker`, `inspector:<group>`): the scope a newer request supersedes in. */
  requestKey?: string
}

export type { VariantThumbnail }

export interface VariantThumbnailDeps {
  prepareTalk(outlinePath: string, content: string): Promise<{
    slug: string
    model: { fullHtml?: unknown }
    rows: Array<{ [k: string]: unknown }> | null
  } | null>
  render(opts: { fullHtml: string; slides: IndexedThumbnailSlide[]; cacheDir: string; background?: boolean }): Promise<Record<string, string>>
  cacheDirFor(outlinePath: string, slug: string): string
  urlFor(slug: string, cacheName: string, outlinePath: string): string
  /** Document identity for the cache key (the deck's compiled HTML). */
  documentId(fullHtml: string): string
  /** A fingerprint of the files the compile reads besides the text (default: `mediaFingerprint`). */
  inputsFingerprint?(outlinePath: string, outline: string): string
  fileExists?: (path: string) => boolean
}

export interface VariantQueueLimits {
  /** Queued (not yet running) jobs across every key. */
  maxPending?: number
  /** Queued jobs per requestKey and slide (a Suggested row asks for up to six at once). */
  maxPendingPerKey?: number
  /** Answers kept in memory. */
  maxMemoryEntries?: number
}

const DEFAULT_LIMITS = { maxPending: 12, maxPendingPerKey: 6, maxMemoryEntries: 300 }

export type VariantThumbnailRenderer = ((request: VariantThumbnailRequest) => Promise<VariantThumbnail>) & {
  /** Jobs queued and running (for tests and the log). */
  stats(): { pending: number; running: number; memory: number }
}

export function createVariantThumbnailRenderer(deps: VariantThumbnailDeps, limits: VariantQueueLimits = {}): VariantThumbnailRenderer {
  const { maxPending, maxPendingPerKey, maxMemoryEntries } = { ...DEFAULT_LIMITS, ...limits }
  const fileExists = deps.fileExists ?? existsSync
  const fingerprint = deps.inputsFingerprint ?? ((outlinePath: string, outline: string) => mediaFingerprint(outlinePath, outline))
  // content hash → { url, png }: least recently used out.
  const served = new Map<string, { url: string; png: string }>()

  interface Job {
    hash: string
    scope: string
    source: string
    request: VariantThumbnailRequest
    modified: string
    promise: Promise<VariantThumbnail>
    settle: (result: VariantThumbnail) => void
  }
  const queued: Job[] = []
  const byHash = new Map<string, Job>()
  let running: Job | null = null

  const drop = (job: Job): void => {
    const at = queued.indexOf(job)
    if (at >= 0) queued.splice(at, 1)
    byHash.delete(job.hash)
    job.settle({ status: 'superseded', slideId: job.request.slideId })
  }

  const pump = (): void => {
    if (running) return
    const job = queued.shift()
    if (!job) return
    running = job
    renderVariant(job)
      .catch((): VariantThumbnail => ({ status: 'failed', slideId: job.request.slideId }))
      .then((result) => {
        byHash.delete(job.hash)
        running = null
        job.settle(result)
        pump()
      })
  }

  const ask = async (request: VariantThumbnailRequest): Promise<VariantThumbnail> => {
    const slideId = request.slideId
    let modified: string
    try {
      modified = previewLayout(request.outline, request.headingLine != null ? { headingLine: request.headingLine } : slideId, request.layout, request.options ?? [])
    } catch (error) {
      if (error instanceof LayoutVerbError && error.code === 'cannot-take') {
        return { status: 'cannot-take', slideId, reason: error.reason ?? error.message }
      }
      return { status: 'invalid', slideId, reason: error instanceof LayoutVerbError ? error.detail : 'invalid request' }
    }
    const hash = createHash('sha256')
      .update(request.outlinePath).update('\0').update(modified).update('\0').update(slideId)
      .update('\0').update(fingerprint(request.outlinePath, modified))
      .digest('hex')
    const hit = served.get(hash)
    if (hit && fileExists(hit.png)) {
      served.delete(hash)
      served.set(hash, hit)
      return { status: 'ok', slideId, url: hit.url, cached: true }
    }
    // The same try asked twice at once (a row and its neighbour) shares one job.
    const same = byHash.get(hash)
    if (same) return same.promise

    const scope = `${request.requestKey ?? ''}\0${request.outlinePath}\0${slideId}`
    // A newer request from the same surface for the same slide: jobs queued from older text are stale.
    for (const old of queued.filter((job) => job.scope === scope && job.source !== request.outline)) drop(old)
    // A surface's request for another slide of the same talk: the author left the slide those were for.
    if (request.requestKey) {
      for (const old of queued.filter((job) => job.request.requestKey && job.request.outlinePath === request.outlinePath && job.request.slideId !== slideId)) drop(old)
    }
    // Bounded: over a cap the newest request is refused; the jobs already waiting keep their turn.
    if (queued.length >= maxPending || queued.filter((candidate) => candidate.scope === scope).length >= maxPendingPerKey) {
      return { status: 'superseded', slideId }
    }
    let settle!: (result: VariantThumbnail) => void
    const promise = new Promise<VariantThumbnail>((resolveJob) => { settle = resolveJob })
    const job: Job = { hash, scope, source: request.outline, request, modified, promise, settle }
    queued.push(job)
    byHash.set(hash, job)
    pump()
    return promise
  }

  async function renderVariant(job: Job): Promise<VariantThumbnail> {
    const { request, modified, hash } = job
    const failed: VariantThumbnail = { status: 'failed', slideId: request.slideId }
    const prepared = await deps.prepareTalk(request.outlinePath, modified)
    const fullHtml = prepared?.model.fullHtml
    if (!prepared || typeof fullHtml !== 'string' || !prepared.rows) return failed
    const rows = prepared.rows as ThumbnailProjectionRow[]
    const selected = request.headingLine != null
      ? selectedThumbnailSlideAtLine(rows, request.headingLine, deps.documentId(fullHtml))
      : selectedThumbnailSlide(rows, request.slideId, deps.documentId(fullHtml))
    if (!selected) return failed
    const cacheDir = deps.cacheDirFor(request.outlinePath, prepared.slug)
    const rendered = await deps.render({ fullHtml, slides: [selected], cacheDir, background: true })
    const png = rendered[selected.key]
    if (!png) return failed
    const url = deps.urlFor(prepared.slug, pngName(png), request.outlinePath)
    served.set(hash, { url, png })
    while (served.size > maxMemoryEntries) {
      const oldest = served.keys().next().value
      if (oldest === undefined) break
      served.delete(oldest)
    }
    return { status: 'ok', slideId: request.slideId, url, cached: false }
  }

  return Object.assign(ask, {
    stats: () => ({ pending: queued.length, running: running ? 1 : 0, memory: served.size })
  })
}

// ── The IPC handler ────────────────────────────────────────────────────────────────────────────

const REQUEST_KEY_RE = /^[A-Za-z0-9:_-]{1,64}$/

/**
 * `layout:variant-thumbnail`'s handler, built from its gate and its renderer so it runs under test
 * exactly as main registers it. The gate refuses an outline outside the vault: the compile reads the
 * media beside it and the PNG is written to that talk's thumbnail cache. Arguments come from the
 * renderer, so each is checked here; option tokens are checked again by the layout verbs.
 */
export function createVariantThumbnailHandler(
  refuse: (outlinePath: unknown) => string | null,
  renderVariant: (request: VariantThumbnailRequest) => Promise<VariantThumbnail>,
  log: (error: unknown) => void = (error) => console.error('[layout:variant-thumbnail]', error)
) {
  return async (
    _event: unknown,
    outlinePath: unknown,
    outline: unknown,
    slide: unknown,
    layout: unknown,
    options?: unknown,
    requestKey?: unknown
  ): Promise<VariantThumbnail> => {
    // A slide is named by its `{id=…}` (a string) or, while it has none, by its heading line (`{ headingLine }`).
    const line = slide && typeof slide === 'object' && Number.isInteger((slide as { headingLine?: unknown }).headingLine) && (slide as { headingLine: number }).headingLine > 0
      ? (slide as { headingLine: number }).headingLine
      : null
    const id = typeof slide === 'string' ? slide : line != null ? `line:${line}` : ''
    const refusal = refuse(outlinePath)
    if (refusal) return { status: 'invalid', slideId: id, reason: refusal }
    if (typeof outline !== 'string' || !id || typeof layout !== 'string') {
      return { status: 'invalid', slideId: id, reason: 'outline, slide and layout are required' }
    }
    try {
      return await renderVariant({
        outlinePath: outlinePath as string,
        outline,
        slideId: id,
        ...(line != null ? { headingLine: line } : {}),
        layout,
        options: options as readonly LayoutOptionChoice[] | undefined,
        requestKey: typeof requestKey === 'string' && REQUEST_KEY_RE.test(requestKey) ? requestKey : undefined
      })
    } catch (error) {
      log(error)
      return { status: 'failed', slideId: id }
    }
  }
}

// ── Inputs besides the text ───────────────────────────────────────────────────────────────────

const LINK_TARGET_RE = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const TOKEN_FILE_RE = /[{\s,=]([^{}\s",=]+\.(?:png|jpe?g|webp|gif|svg|avif|mp4|mov|m4v|webm|html?))(?=[}\s,"])/gi

/**
 * A fingerprint of the local files an outline references (images, videos, embedded pages): each
 * path with its mtime and size, or `missing`. Relative paths resolve beside the outline, as the
 * compiler resolves them; URLs are skipped. Pooled refs (`img-…`) should be resolved by the caller
 * first (main passes the text through resolveImageRefs). The deck's theme and brand live in the text
 * (frontmatter) and the bundled compiler, whose version already names the thumbnail cache.
 */
export function mediaFingerprint(
  outlinePath: string,
  outline: string,
  stat: (path: string) => { mtimeMs: number; size: number } | null = statOrNull
): string {
  const targets = new Set<string>()
  for (const match of outline.matchAll(LINK_TARGET_RE)) targets.add(match[1])
  for (const match of outline.matchAll(TOKEN_FILE_RE)) targets.add(match[1])
  const base = dirname(outlinePath)
  const parts: string[] = []
  for (const target of [...targets].sort()) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
    let path = isAbsolute(target) ? target : resolve(base, target)
    let info = stat(path)
    if (!info) {
      try {
        const decoded = decodeURIComponent(target)
        if (decoded !== target) {
          const decodedPath = isAbsolute(decoded) ? decoded : resolve(base, decoded)
          const decodedInfo = stat(decodedPath)
          if (decodedInfo) { path = decodedPath; info = decodedInfo }
        }
      } catch { /* not percent-encoded */ }
    }
    parts.push(info ? `${path}\0${info.mtimeMs}\0${info.size}` : `${path}\0missing`)
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

function statOrNull(path: string): { mtimeMs: number; size: number } | null {
  try {
    const info = statSync(path)
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null
  } catch {
    return null
  }
}

function pngName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.png$/, '')
}
