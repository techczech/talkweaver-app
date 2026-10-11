// The worker thread the live compile runs in (prepareTalk in index.ts), off the main process's thread.
//
// prepareSource inlines every picture of a deck as base64 and builds one enormous HTML string; on a
// talk of large photographs that held the main process for 400-500 ms at a time after the talk
// opened and after every edit pause (the beachball). Here it runs in a worker instead. The main
// process keeps everything else: the prepared-talk cache, the preparation gate (single-flight.ts:
// one heavy compile at a time, so this worker is only ever given one job at a time) and the cache key.
//
// One long-lived worker, started on the first compile and ended after a quiet minute: each job is
// { id, compilerDir, outlinePath, text, slug, defaults, options }; the answer is
// { id, ok: true, model, rows, previewKey } or { id, ok: false, error }. The compiler's modules are loaded here
// from the compiler folder the job names, as the main process loaded them.
//
// A job whose options carry no allowed media folders is refused (compile-roots.ts): every compile is
// given the talk's roots, and a job posted without them fails rather than compiling with the
// compiler's own fallback.
//
// No Electron import and erasable TypeScript only: this file runs in a plain worker thread, and
// scripts/test-media-inside-vault.mjs starts it directly.
import { parentPort } from 'node:worker_threads'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { markSlidePreviewHtml } from '../shared/slide-preview.ts'
import { requireCompileOptionsWithRoots } from './compile-roots.ts'

export type PrepareTalkJob = {
  id: number
  compilerDir: string
  outlinePath: string
  /** The outline with pooled references resolved (what the main process hashed for the cache key). */
  text: string
  slug: string
  defaults?: Record<string, unknown>
  options: Record<string, unknown>
}

export type PrepareTalkReply =
  | {
      id: number
      ok: true
      model: Record<string, unknown>
      rows: Array<Record<string, unknown>> | null
      /** sha256 (hex) of the deck as the slide pictures load it (markSlidePreviewHtml of fullHtml): the
       *  thumbnails' document id and the render window's deck key, worked out here rather than on the
       *  main process's thread (each took 70-90 ms there on a deck of large photographs). */
      previewKey?: string
    }
  | { id: number; ok: false; error: string }

type Compiler = {
  prepareSource: (...args: unknown[]) => Promise<Record<string, unknown>>
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

async function prepare(job: PrepareTalkJob): Promise<PrepareTalkReply> {
  // Checked before anything is loaded or read: no roots, no compile.
  const compileOptions = requireCompileOptionsWithRoots(job.options, 'The compile')
  const { prepareSource, buildPerSlideProjections } = await compiler(job.compilerDir)
  const model = await prepareSource(job.outlinePath, job.text, job.slug, statSync(job.outlinePath), job.defaults, compileOptions)
  const rows = buildPerSlideProjections(model, job.slug) ?? null
  const previewKey = typeof model.fullHtml === 'string'
    ? createHash('sha256').update(markSlidePreviewHtml(model.fullHtml)).digest('hex')
    : undefined
  return { id: job.id, ok: true, model, rows, previewKey }
}

parentPort?.on('message', (job: PrepareTalkJob) => {
  prepare(job).then(
    (reply) => {
      try {
        parentPort?.postMessage(reply)
      } catch (error) {
        // A model that cannot be copied to the main process (a function in it) is a failed compile.
        parentPort?.postMessage({ id: job.id, ok: false, error: `The compiled talk could not be handed back: ${error instanceof Error ? error.message : String(error)}` })
      }
    },
    (error: unknown) => {
      console.error('[prepare-talk]', error)
      parentPort?.postMessage({ id: job.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    },
  )
})
