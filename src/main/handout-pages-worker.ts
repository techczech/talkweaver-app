// The process a publish builds and writes its handout pages in (handout-pages.ts says why).
// One process per publish, started as an Electron utility process (prepare-talk-utility-process.ts)
// so it has a V8 heap of its own: Electron's V8 keeps the main process and all its worker threads in
// ONE shared 4 GB heap, and a media-heavy talk's pages exhausted it and ended the whole app. Here a
// build that runs out of memory ends this process only, and the publish fails.
//
// The job arrives as the one message on process.parentPort (a utility process has no workerData); the
// process answers once with { ok: true, result } or { ok: false, error }, and the main process ends it
// (handout-pages-off-process.ts). Everything it writes is written by buildHandoutPages, as before.
//
// No Electron import and erasable TypeScript only: a utility process needs nothing of Electron but
// process.parentPort, and the plain-Node tests start this file with a stand-in for it
// (scripts/lib/node-compile-child.mjs).
import { buildHandoutPages, type HandoutPagesJob } from './handout-pages.ts'
import { slimHandoutHtml } from './handout-slimming.ts'

const port = process.parentPort
port.once('message', (event: { data: HandoutPagesJob }) => {
  buildHandoutPages(event.data, slimHandoutHtml).then(
    (result) => {
      try {
        port.postMessage({ ok: true, result })
      } catch (error) {
        port.postMessage({ ok: false, error: `The handout pages could not be handed back: ${error instanceof Error ? error.message : String(error)}` })
      }
    },
    (error: unknown) => {
      // The message travels (the handlers show it as a build failure always has); the stack goes to the log.
      console.error('[handout-pages]', error)
      port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
    },
  )
})
