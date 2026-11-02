// Runs INSIDE Electron (started by e2e/diagnose-compile-own-heap.mjs): the live compile's off-thread
// module (src/main/prepare-talk-off-thread.ts) with the app's own way of starting its child
// (src/main/prepare-talk-utility-process.ts) and the BUILT child script the packaged app runs
// (out/main/prepare-talk-worker.js), against a stand-in compiler that only allocates memory. No
// window is opened.
//
// Electron's V8 keeps the main process and its worker threads in one shared 4 GB heap: with the
// compile in a worker thread, a main process holding ~2 GB and a compile needing ~2.5 GB ended the
// whole app (OOM abort, 2026-10-22). It proves:
//   1. a compile that needs ~2.5 GB (as large strings, like a deck's inlined media) while the main
//      process holds ~2 GB completes, and the main process answers the next small compile;
//   1b. a compile that answers a 175,000,000-character deck arrives whole (length, content digest,
//      and the preview key the child computes), then a small compile succeeds;
//   2. a compile that needs more than any one heap can give (~5 GB) fails with the compile's own
//      error, the main process stays up with its memory intact, and the next compile runs in a fresh
//      child;
//   3. a model that cannot be copied back fails that compile only.
import { app } from 'electron'
import v8 from 'node:v8'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

app.dock?.hide()
const repo = process.env.TW_COMPILE_HEAP_REPO
const scratch = process.env.TW_COMPILE_HEAP_SCRATCH
const childPath = process.env.TW_COMPILE_HEAP_CHILD
const MAIN_MB = Number(process.env.TW_COMPILE_HEAP_MAIN_MB ?? 2000)
const COMPILE_MB = Number(process.env.TW_COMPILE_HEAP_COMPILE_MB ?? 2500)
const TOO_MUCH_MB = Number(process.env.TW_COMPILE_HEAP_TOO_MUCH_MB ?? 5000)

const load = (path) => import(pathToFileURL(join(repo, path)).href)
const mb = (bytes) => Math.round(bytes / 1048576)
const heap = () => mb(v8.getHeapStatistics().used_heap_size)
const pass = (line) => console.log(`PASS ${line}`)
function check(condition, what) {
  if (!condition) throw new Error(`FAILED: ${what}`)
}

async function main() {
  await app.whenReady()
  const { createPrepareTalkOffThread } = await load('src/main/prepare-talk-off-thread.ts')
  const { forkCompileChild } = await load('src/main/prepare-talk-utility-process.ts')
  let children = 0
  const spawn = (path) => { children += 1; return forkCompileChild(path) }
  const compile = createPrepareTalkOffThread(childPath, spawn, 60_000)
  const job = (allocateMb) => ({
    compilerDir: join(scratch, 'compiler'),
    outlinePath: join(scratch, 'talk', 'heavy-outline.md'),
    text: '# Heavy\n',
    slug: 'heavy',
    options: { allowedAssetRoots: [scratch], allocateMb },
  })

  // The main process's own share: ~2 GB of live arrays (1 MB of doubles each), held to the end.
  const held = []
  for (let i = 0; i < MAIN_MB; i++) held.push(new Array(131072).fill(i + 0.5))
  console.log(`COMPILE-HEAP main heap ${heap()} MB held, limit ${mb(v8.getHeapStatistics().heap_size_limit)} MB`)

  // 1. A heavy compile beside a heavy main process.
  const heavy = await compile(job(COMPILE_MB))
  check(heavy.model.allocatedMb >= COMPILE_MB, 'the heavy compile ran to the end')
  check(Array.isArray(heavy.rows) && typeof heavy.previewKey === 'string', 'the heavy compile answered rows and a preview key')
  pass(`a compile allocating ${COMPILE_MB} MB completed while the main process held ${MAIN_MB} MB`)
  const small = await compile(job(0))
  check(small.model.allocatedMb === 0 && children === 1, 'the next small compile ran in the same child')
  pass('the main process answered the next small compile')

  // 1b. A very large reply comes back whole: length, content digest and preview key all match.
  const { markSlidePreviewHtml } = await load('src/shared/slide-preview.ts')
  const BIG = 175_000_000
  const big = await compile({ ...job(0), options: { ...job(0).options, bigReplyChars: BIG } })
  check(typeof big.model.fullHtml === 'string' && big.model.fullHtml.length === BIG, `the large reply arrived whole (${big.model.fullHtml?.length} characters)`)
  check(createHash('sha256').update(big.model.fullHtml).digest('hex') === big.model.digest, 'the large reply has the content digest the compiler computed')
  check(big.previewKey === createHash('sha256').update(markSlidePreviewHtml(big.model.fullHtml)).digest('hex'), 'the preview key is the sha256 of the slide-preview-marked deck')
  const afterBig = await compile(job(0))
  check(afterBig.model.allocatedMb === 0 && children === 1, 'a small compile succeeded after the large reply')
  pass(`a ${BIG}-character reply arrived whole (length, sha256, preview key) and the next small compile succeeded`)

  // 2. A compile that no heap can hold.
  let failure = null
  try { await compile(job(TOO_MUCH_MB)) } catch (error) { failure = error }
  check(failure instanceof Error && /The talk could not be compiled/.test(failure.message), 'the compile that ran out of memory failed with the compile error')
  console.log(`COMPILE-HEAP the over-large compile failed: ${failure.message}`)
  check(held.length === MAIN_MB && held[MAIN_MB - 1][0] === MAIN_MB - 0.5, 'the main process kept its memory')
  pass(`a compile allocating ${TOO_MUCH_MB} MB failed with "The talk could not be compiled"; the main process stayed up`)
  const after = await compile(job(0))
  check(after.model.allocatedMb === 0 && children === 2, 'the next compile ran in a fresh child')
  pass('the next compile ran in a fresh child and succeeded')

  // 3. A model that cannot be copied back to the main process is a failed compile, not a hang.
  let unsendable = null
  try { await compile({ ...job(0), options: { ...job(0).options, withFunction: true } }) } catch (error) { unsendable = error }
  check(unsendable instanceof Error && /could not be handed back/.test(unsendable.message), 'a model that cannot be copied back failed the compile')
  const last = await compile(job(0))
  check(last.model.allocatedMb === 0 && children === 2, 'the same child took the next compile')
  pass('a model that cannot be copied back fails that compile only; the child stays')

  console.log('COMPILE-HEAP OK 6')
  app.exit(0)
}

main().catch((error) => {
  console.log(String(error?.message ?? error).startsWith('FAILED') ? error.message : `FAILED: ${error?.stack ?? error}`)
  app.exit(1)
})
