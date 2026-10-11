// The worker thread a publish builds and writes its handout pages in (handout-pages.ts says why).
// One worker per publish: it is handed the job as its workerData, answers once with
// { ok: true, result } or { ok: false, error }, and is ended by the main process.
import { parentPort, workerData } from 'node:worker_threads'
import { buildHandoutPages, type HandoutPagesJob } from './handout-pages'
import { slimHandoutHtml } from './handout-slimming'

buildHandoutPages(workerData as HandoutPagesJob, slimHandoutHtml).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (error: unknown) => {
    // The message travels (the handlers show it as a build failure always has); the stack goes to the log.
    console.error('[handout-pages]', error)
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  },
)
