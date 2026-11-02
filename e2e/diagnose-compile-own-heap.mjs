// The live compile has a heap of its own (src/main/prepare-talk-off-thread.ts, 2026-10-22): a compile
// that needs a lot of memory, or more than there is, can never end the app. Starts Electron on
// e2e/compile-heap-host (no window) with a stand-in compiler that only allocates memory, waits for it
// and reports its PASS lines. What it proves is listed in e2e/compile-heap-host/main.mjs; the job
// bookkeeping under plain Node is scripts/test-prepare-talk-off-thread.mjs.
//
// Needs the build (npm run build): it runs out/main/prepare-talk-worker.js, the file the app ships.
// Peak memory is about 2 GB in the main process plus up to 4 GB in the compile's child, briefly.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const electron = createRequire(import.meta.url)('electron') // the path of the pinned Electron binary
const child = join(repo, 'out', 'main', 'prepare-talk-worker.js')
const EXPECTED = 6
if (!existsSync(child)) {
  console.log(`FAILED: ${child} is not built; run npm run build first`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'tw-compile-heap-'))
const userData = join(scratch, 'userData')
mkdirSync(userData, { recursive: true })
mkdirSync(join(scratch, 'compiler', 'lib'), { recursive: true })
mkdirSync(join(scratch, 'talk'), { recursive: true })
writeFileSync(join(scratch, 'talk', 'heavy-outline.md'), '# Heavy\n')
// The stand-in compiler: prepareSource allocates options.allocateMb as large flat strings (32 MB each,
// held until it answers), as the real compiler's inlined-media HTML is; the projections are one row.
// Large strings matter: with the compile in a worker thread they exhausted the heap the main process
// shares with it and aborted the whole app (the 2026-10-22 crash), where small arrays only ended the
// worker.
writeFileSync(join(scratch, 'compiler', 'lib', '08-source-adapters.mjs'), `
export async function prepareSource(outlinePath, text, slug, stat, defaults, options) {
  const want = Number(options.allocateMb ?? 0)
  const held = []
  for (let i = 0; i < want / 32; i++) held.push(String.fromCharCode(97 + (i % 26)).repeat(32 * 1048576) + i)
  for (const piece of held) piece.charCodeAt(5)
  let fullHtml = '<section>' + slug + '</section>'
  const model = { allocatedMb: held.length * 32 }
  if (options.bigReplyChars) {
    // A deck's size reply: one flat one-byte string, with its digest taken here to compare in main.
    const body = 'abcdefghij'.repeat(Math.ceil(options.bigReplyChars / 10)).slice(0, options.bigReplyChars - 19)
    fullHtml = '<section>' + body + '</section>'
    model.digest = (await import('node:crypto')).createHash('sha256').update(fullHtml).digest('hex')
  }
  model.fullHtml = fullHtml
  if (options.withFunction) model.hook = () => 1 // a model that cannot be copied back
  return model
}
`)
writeFileSync(join(scratch, 'compiler', 'lib', '10-projections.mjs'), `
export function buildPerSlideProjections(model, slug) { return [{ slug }] }
`)

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '0', TW_COMPILE_HEAP_REPO: repo, TW_COMPILE_HEAP_SCRATCH: scratch, TW_COMPILE_HEAP_CHILD: child }
delete env.ELECTRON_RUN_AS_NODE
const started = Date.now()
const host = spawn(electron, [join(repo, 'e2e', 'compile-heap-host'), `--user-data-dir=${userData}`], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
let err = ''
host.stdout.on('data', (chunk) => { out += chunk })
host.stderr.on('data', (chunk) => { err += chunk })
const timer = setTimeout(() => { try { process.kill(host.pid) } catch { /* already gone */ } }, 240_000)
const code = await new Promise((done) => host.on('exit', (status, signal) => done(signal ? `signal ${signal}` : status)))
clearTimeout(timer)
rmSync(scratch, { recursive: true, force: true })

const lines = out.split(/\r?\n/).filter((line) => /^(PASS|FAILED|COMPILE-HEAP)/.test(line))
for (const line of lines) console.log(line)
const passed = lines.filter((line) => line.startsWith('PASS ')).length
const ok = code === 0 && passed === EXPECTED && lines.includes(`COMPILE-HEAP OK ${EXPECTED}`)
if (!ok) {
  console.log(`FAILED: the Electron host ended with ${code} after ${((Date.now() - started) / 1000).toFixed(1)}s`)
  const tail = (text) => text.split(/\r?\n/).filter(Boolean).slice(-12).map((line) => `  ${line.slice(0, 240)}`).join('\n')
  if (err.trim()) console.log(`host stderr (last lines):\n${tail(err)}`)
}
console.log(`\n=== COMPILE OWN HEAP (Electron utility process) SUMMARY: ${passed}/${EXPECTED} passed in ${((Date.now() - started) / 1000).toFixed(1)}s ===`)
process.exit(ok ? 0 : 1)
