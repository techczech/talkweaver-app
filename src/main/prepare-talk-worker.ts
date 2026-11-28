import { galleryAcquiredAssets } from './vault-gallery-assets.ts'
// The process the live compile (prepareTalk in index.ts) runs in, apart from the main process.
//
// prepareSource inlines every picture of a deck as base64 and builds one enormous HTML string; on a
// talk of large photographs that held the main process for 400-500 ms at a time after the talk
// opened and after every edit pause (the beachball). Here it runs in a child process instead. The main
// process keeps everything else: the prepared-talk cache, the preparation gate (single-flight.ts:
// one heavy compile at a time, so this process is only ever given one job at a time) and the cache key.
//
// A process, not a worker thread (2026-10-22): Electron's V8 keeps the main process and all its worker
// threads in ONE shared 4 GB heap, so a compile that needed 2.8 GB in a worker thread, while the main
// process held its own share, ended the whole app out of memory. A utility process (Electron's
// utilityProcess, started by prepare-talk-utility-process.ts) has a heap of its own: a compile that
// runs out of memory ends this process only, and its job fails.
//
// One long-lived process, started on the first compile and ended after a quiet minute: each job is
// { id, compilerDir, outlinePath, text, slug, defaults, options }; the answer is
// { id, ok: true, model, rows, previewKey, pendingPreview } or { id, ok: false, error }. When a
// preview is pending, its descriptor follows in a second reply after the atomic write. A rowsOnly
// job (the search index) is answered with its rows and an empty model. Jobs arrive and answers leave
// through process.parentPort. The compiler's modules are loaded here from the compiler folder the job
// names, as the main process loaded them.
//
// A job whose options carry no allowed media folders is refused (compile-roots.ts): every compile is
// given the talk's roots, and a job posted without them fails rather than compiling with the
// compiler's own fallback.
//
// No Electron import and erasable TypeScript only: a utility process needs nothing of Electron but
// process.parentPort, and scripts/test-media-inside-vault.mjs starts this file directly (under plain
// Node, with a stand-in for process.parentPort: scripts/lib/node-compile-child.mjs).
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { markSlidePreviewHtml, type AuthoringSlideTarget } from '../shared/slide-preview.ts'
import { requireCompileOptionsWithRoots } from './compile-roots.ts'
import { hasRemoteEmbedFrames, replaceRemoteEmbedFrames } from './embed-preview-policy.ts'
import { writePreviewVariant, type PreviewVariant, type VariantFolder } from './preview-variant.ts'

export type MarkPreviewRequest = { outlinePath: string; content: string; fullHtml: string }
type MarkPreviewJob = MarkPreviewRequest & { kind: 'mark-preview'; id: number }
type ArtworkAnswer = { kind: 'artwork-answer'; id: number; image: string | null }
type CancelPreview = { kind: 'cancel-preview'; id: number }

export type PrepareTalkJob = {
  kind?: never
  id: number
  compilerDir: string
  outlinePath: string
  /** The outline with pooled references resolved (what the main process hashed for the cache key). */
  text: string
  slug: string
  defaults?: Record<string, unknown>
  options: Record<string, unknown>
  /** Only the per-slide rows are wanted (the search index, with options.projectionsOnly): the reply's
   *  model is empty and no preview is made, so nothing of the deck crosses to the main process. */
  rowsOnly?: boolean
  authoringSlide?: AuthoringSlideTarget
  /** Write the preview variant (preview-variant.ts) of the deck into this folder: asked for by the
   *  compiles whose deck the Inspector preview or the thumbnails load; a presenter or export compile
   *  does without it. Only the variant's descriptor comes back, never its bytes. */
  previewDir?: VariantFolder
}

type CompileReply =
  | {
      id: number
      ok: true
      model: Record<string, unknown>
      rows: Array<Record<string, unknown>> | null
      /** sha256 (hex) of the deck as the slide pictures load it (markSlidePreviewHtml of fullHtml): the
       *  thumbnails' document id and the render window's deck key, worked out here rather than on the
       *  main process's thread (each took 70-90 ms there on a deck of large photographs). */
      previewKey?: string
      pendingPreview?: true
    }
  | { id: number; ok: false; error: string }

export type MarkedPreview = { key: string; html: string }
export type PrepareTalkMessage = PrepareTalkJob | MarkPreviewJob | ArtworkAnswer | CancelPreview
export type PrepareTalkReply =
  | (CompileReply & { kind?: never })
  | { kind: 'variant'; id: number; preview?: PreviewVariant }
  | { kind: 'artwork'; id: number; url: string }
  | { kind: 'marked-preview'; id: number; document: MarkedPreview }

type Compiler = {
  prepareSource: (...args: unknown[]) => Promise<Record<string, unknown> | null>
  buildPerSlideProjections: (model: unknown, slug: string) => Array<Record<string, unknown>> | null
}
const loaded = new Map<string, Promise<Compiler>>()
function compiler(dir: string): Promise<Compiler> {
  let found = loaded.get(dir)
  if (!found) {
    found = Promise.all([
      import(pathToFileURL(join(dir, 'lib/08-source-adapters.mjs')).href),
      import(pathToFileURL(join(dir, 'lib/10-projections.mjs')).href),
    ]).then(([adapters, projections]) => ({ prepareSource: adapters.prepareSource, buildPerSlideProjections: projections.buildPerSlideProjections }))
    // A failed load is not kept: the next job tries again.
    found.catch(() => loaded.delete(dir))
    loaded.set(dir, found)
  }
  return found
}

async function prepare(job: PrepareTalkJob, signal?: AbortSignal): Promise<CompileReply> {
  // Checked before anything is loaded or read: no roots, no compile.
  const compileOptions = requireCompileOptionsWithRoots(job.options, 'The compile')
  const { prepareSource, buildPerSlideProjections } = await compiler(job.compilerDir)
  signal?.throwIfAborted()
  const authority = job.authoringSlide ? undefined : job.options.galleryReadAuthority as Parameters<typeof galleryAcquiredAssets>[0] | undefined
  const acquired = authority ? galleryAcquiredAssets(authority) : undefined
  let model: Record<string, unknown> | null
  try {
    const sourceStat = authority
      ? { mtimeMs: 0, size: Buffer.byteLength(job.text), isDirectory: () => false, isFile: () => true }
      : statSync(job.outlinePath)
    model = await prepareSource(job.outlinePath, job.text, job.slug, sourceStat, job.defaults, {
      ...compileOptions,
      ...(acquired ? { galleryAcquiredAssets: acquired } : {}),
      ...(job.authoringSlide ? { authoringSlide: job.authoringSlide, authoringSignal: signal } : {}),
    })
  } finally {
    await acquired?.close()
  }
  if (job.authoringSlide) {
    signal?.throwIfAborted()
    // Remote frames go through the full preview's artwork replacement policy.
    if (!model || typeof model.fullHtml !== 'string' || hasRemoteEmbedFrames(model.fullHtml)) {
      return { id: job.id, ok: true, model: {}, rows: null }
    }
    const fullHtml = markSlidePreviewHtml(model.fullHtml, { localPages: true })
    const previewKey = createHash('sha256').update(fullHtml).digest('hex').slice(0, 24)
    return { id: job.id, ok: true, model: { fullHtml, slideId: model.slideId }, rows: null, previewKey }
  }
  if (!model) throw new Error('The compiler returned no deck')
  const rows = buildPerSlideProjections(model, job.slug) ?? null
  if (job.rowsOnly) return { id: job.id, ok: true, model: {}, rows }
  const fullHtml = typeof model.fullHtml === 'string' ? model.fullHtml : undefined
  const previewKey = fullHtml !== undefined
    ? createHash('sha256').update(markSlidePreviewHtml(fullHtml)).digest('hex')
    : undefined
  return { id: job.id, ok: true, model, rows, previewKey,
    ...(fullHtml && job.previewDir && !hasRemoteEmbedFrames(fullHtml) ? { pendingPreview: true } : {}) }
}

// A utility process's port (process.parentPort): jobs arrive as message events carrying the job as
// their data; answers are posted back the same way.
const port = process.parentPort

// Frame discovery, replacement, marking and hashing stay in this process. The existing replacement
// policy requests artwork sequentially, so each job can have at most one request waiting on main.
type Marking = { controller: AbortController; artwork?: (image: string | null) => void }
const marking = new Map<number, Marking>()
const authoring = new Map<number, AbortController>()
async function markPreview(job: MarkPreviewJob): Promise<MarkedPreview> {
  const slot: Marking = { controller: new AbortController() }
  marking.set(job.id, slot)
  try {
    const withArt = await replaceRemoteEmbedFrames(job.fullHtml, (url, signal) => new Promise((resolve) => {
      if (signal?.aborted) { resolve(null); return }
      const cancelled = (): void => slot.artwork?.(null)
      slot.artwork = (image) => {
        signal?.removeEventListener('abort', cancelled)
        slot.artwork = undefined
        resolve(image)
      }
      signal?.addEventListener('abort', cancelled, { once: true })
      port.postMessage({ id: job.id, kind: 'artwork', url })
    }), slot.controller.signal)
    slot.controller.signal.throwIfAborted()
    const html = markSlidePreviewHtml(withArt, { localPages: true })
    const key = createHash('sha256').update(job.outlinePath).update('\0').update(job.content).update('\0').update(html).digest('hex').slice(0, 24)
    return { key, html }
  } finally {
    marking.delete(job.id)
  }
}

function reportError(id: number, error: unknown): void {
  port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
}

port.on('message', (event: { data: PrepareTalkMessage }) => {
  const job = event.data
  if (job.kind === 'artwork-answer') {
    marking.get(job.id)?.artwork?.(job.image)
  } else if (job.kind === 'cancel-preview') {
    marking.get(job.id)?.controller.abort()
    authoring.get(job.id)?.abort()
  } else if (job.kind === 'mark-preview') {
    void markPreview(job).then(
      (document) => port.postMessage({ id: job.id, kind: 'marked-preview', document }),
      (error) => reportError(job.id, error)
    )
  } else {
    const controller = job.authoringSlide ? new AbortController() : undefined
    if (controller) authoring.set(job.id, controller)
    void prepare(job, controller?.signal).then(async (reply) => {
      if (controller?.signal.aborted) return
      try {
        port.postMessage(reply)
      } catch (error) {
        reportError(job.id, `The compiled talk could not be handed back: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (reply.ok && reply.pendingPreview && job.previewDir) {
        const preview = await writePreviewVariant(reply.model.fullHtml as string, job.previewDir).catch(() => undefined)
        port.postMessage({ id: job.id, kind: 'variant', preview })
      }
    }, (error: unknown) => {
      if (controller?.signal.aborted) return
      console.error('[prepare-talk]', error)
      reportError(job.id, error)
    }).finally(() => {
      if (controller) authoring.delete(job.id)
    })
  }
})
