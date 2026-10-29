// Runs INSIDE Electron (started by e2e/diagnose-handout-own-heap.mjs): a publish's pages build
// (src/main/handout-pages-off-process.ts) with the app's own way of starting its child
// (src/main/prepare-talk-utility-process.ts) and the BUILT child script the packaged app runs
// (out/main/handout-pages-worker.js), against a stand-in compiler that only allocates memory and
// writes tiny pages. No window is opened. The job is a real 'talk' job; how much the build allocates
// is read from the outline text of the stand-in (ALLOCATE_MB=n, HANG=1).
//
// Electron's V8 keeps the main process and its worker threads in one shared 4 GB heap: with the
// pages built in a worker thread, a main process holding ~2 GB and a build needing ~2.5 GB ended the
// whole app (OOM abort). It proves:
//   1. a publish whose build needs ~2.5 GB (as large strings, like a deck's inlined media) while the
//      main process holds ~2 GB completes, its pages are written where the job says, and the main
//      process answers the next small publish; one child per publish, each gone after its answer;
//   2. a build that needs more than any one heap can give (~5 GB) fails that publish with the build
//      error, the main process stays up with its memory intact, and the next publish runs;
//   3. a build that never answers is killed at the deadline and fails with a message that says so;
//   4. a build that fails with its own error passes that message on, and the child is gone.
import { app } from 'electron'
import v8 from 'node:v8'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

app.dock?.hide()
const repo = process.env.TW_HANDOUT_HEAP_REPO
const scratch = process.env.TW_HANDOUT_HEAP_SCRATCH
const childPath = process.env.TW_HANDOUT_HEAP_CHILD
const MAIN_MB = Number(process.env.TW_HANDOUT_HEAP_MAIN_MB ?? 2000)
const BUILD_MB = Number(process.env.TW_HANDOUT_HEAP_BUILD_MB ?? 2500)
const TOO_MUCH_MB = Number(process.env.TW_HANDOUT_HEAP_TOO_MUCH_MB ?? 5000)

const load = (path) => import(pathToFileURL(join(repo, path)).href)
const mb = (bytes) => Math.round(bytes / 1048576)
const heap = () => mb(v8.getHeapStatistics().used_heap_size)
const pass = (line) => console.log(`PASS ${line}`)
function check(condition, what) {
  if (!condition) throw new Error(`FAILED: ${what}`)
}

async function main() {
  await app.whenReady()
  const { createHandoutPagesOffProcess } = await load('src/main/handout-pages-off-process.ts')
  const { forkUtilityChild } = await load('src/main/prepare-talk-utility-process.ts')
  let children = 0
  let ended = 0
  const spawn = (path) => {
    children += 1
    const child = forkUtilityChild(path, 'TalkWeaver handout pages')
    child.on('exit', () => { ended += 1 })
    return child
  }
  const publish = createHandoutPagesOffProcess(childPath, spawn, 8_000)

  let n = 0
  const job = (text) => {
    n += 1
    const talkOutDir = join(scratch, 'site', `talk${n}`)
    return {
      kind: 'talk', compilerDir: join(scratch, 'compiler'), talkOutDir, siteDir: join(scratch, 'site'), slug: `talk${n}`,
      live: '', url: `https://example.test/talk${n}/`, qr: '', downloadFile: `talk${n}-download.html`, handoutFile: `talk${n}.html`,
      outlinePath: join(scratch, 'talk', 'heavy-outline.md'), text, outline: '---\ntitle: Heavy\n---\n',
      assetRoots: [scratch], homeDetails: {},
    }
  }

  // The main process's own share: ~2 GB of live arrays (1 MB of doubles each), held to the end.
  const held = []
  for (let i = 0; i < MAIN_MB; i++) held.push(new Array(131072).fill(i + 0.5))
  console.log(`HANDOUT-HEAP main heap ${heap()} MB held, limit ${mb(v8.getHeapStatistics().heap_size_limit)} MB`)

  // 1. A heavy publish beside a heavy main process.
  const heavyJob = job(`ALLOCATE_MB=${BUILD_MB}`)
  const heavy = await publish(heavyJob)
  check(Array.isArray(heavy.warnings), 'the heavy publish answered')
  check(existsSync(join(heavyJob.talkOutDir, heavyJob.downloadFile)) && existsSync(join(heavyJob.talkOutDir, 'index.html')), 'the pages are written in the handout folder')
  check(existsSync(join(heavyJob.talkOutDir, 'p', 'index.html')) && existsSync(join(scratch, 'site', '404.html')), 'the venue page and the 404 page are written')
  check(Number(/allocated (\d+)/.exec(readFileSync(join(heavyJob.talkOutDir, heavyJob.downloadFile), 'utf8'))?.[1]) >= BUILD_MB, 'the pages are the ones the build made')
  pass(`a publish whose build allocated ${BUILD_MB} MB completed while the main process held ${MAIN_MB} MB`)
  const small = await publish(job('ALLOCATE_MB=0'))
  check(small.warnings.length === 0, 'the next small publish ran')
  pass('the main process answered the next small publish')
  await new Promise((done) => setTimeout(done, 500))
  check(children === 2 && ended === 2, `one child per publish, each gone after its answer (${children} started, ${ended} ended)`)
  pass('one child per publish, each ended after its answer')

  // 2. A build that no heap can hold.
  let failure = null
  try { await publish(job(`ALLOCATE_MB=${TOO_MUCH_MB}`)) } catch (error) { failure = error }
  check(failure instanceof Error && /The handout could not be built \(the build stopped with code \d+\)/.test(failure.message) && !/took longer than/.test(failure.message), 'the publish that ran out of memory failed with the build crash message (stopped with an exit code, not the deadline)')
  console.log(`HANDOUT-HEAP the over-large build failed: ${failure.message}`)
  check(held.length === MAIN_MB && held[MAIN_MB - 1][0] === MAIN_MB - 0.5, 'the main process kept its memory')
  pass(`a build allocating ${TOO_MUCH_MB} MB failed that publish with "The handout could not be built"; the main process stayed up`)
  const after = await publish(job('ALLOCATE_MB=0'))
  check(after.warnings.length === 0, 'the next publish ran')
  pass('the next publish ran and succeeded')

  // 3. A build that never answers is stopped at the deadline (8 seconds here, 10 minutes in the app).
  await new Promise((done) => setTimeout(done, 1000)) // the previous child's exit has arrived
  const endedBefore = ended
  const started = Date.now()
  let late = null
  try { await publish(job('HANG=1')) } catch (error) { late = error }
  check(late instanceof Error && /took longer than 8 seconds/.test(late.message), `the hung build failed with the deadline message (${late?.message})`)
  check(Date.now() - started < 20_000, 'the deadline fired in time')
  await new Promise((done) => setTimeout(done, 1000))
  check(ended === endedBefore + 1, 'the hung child was killed')
  pass('a build that never answers is killed at the deadline and fails with a message that says so')

  // 4. A build's own error is passed on.
  let own = null
  try { await publish(job('FAIL=1')) } catch (error) { own = error }
  check(own instanceof Error && own.message === 'The stand-in build failed.', `the build's own error arrived (${own?.message})`)
  pass("a build's own error is passed on as it is")

  console.log('HANDOUT-HEAP OK 7')
  app.exit(0)
}

main().catch((error) => {
  console.log(String(error?.message ?? error).startsWith('FAILED') ? error.message : `FAILED: ${error?.stack ?? error}`)
  app.exit(1)
})
