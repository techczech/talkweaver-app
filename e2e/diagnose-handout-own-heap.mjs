// A publish's handout pages have a heap of their own (src/main/handout-pages-off-process.ts,
// 2026-10-22): a build that needs a lot of memory, or more than there is, can never end the app.
// Starts Electron on e2e/handout-heap-host (no window) with a stand-in compiler that only allocates
// memory and writes tiny pages, and reports its PASS lines. What it proves is listed in
// e2e/handout-heap-host/main.mjs; the job bookkeeping under plain Node is
// scripts/test-handout-pages-off-process.mjs.
//
// The stand-in compiler is the only injection point: the job names its compiler folder (as the app's
// jobs do), so no code of the app is changed for the test. The stand-in reads ALLOCATE_MB, HANG and
// FAIL from the outline text it is given.
//
// Needs the build (npm run build): it runs out/main/handout-pages-worker.js, the file the app ships.
// Peak memory is about 2 GB in the main process plus up to 4 GB in the build's child, briefly.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const electron = createRequire(import.meta.url)('electron') // the path of the pinned Electron binary
const child = join(repo, 'out', 'main', 'handout-pages-worker.js')
const EXPECTED = Number(process.env.TW_HANDOUT_HEAP_EXPECTED ?? 7)
if (!existsSync(child)) {
  console.log(`FAILED: ${child} is not built; run npm run build first`)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'tw-handout-heap-'))
const userData = join(scratch, 'userData')
const lib = join(scratch, 'compiler', 'lib')
mkdirSync(userData, { recursive: true })
mkdirSync(lib, { recursive: true })
mkdirSync(join(scratch, 'talk'), { recursive: true })
mkdirSync(join(scratch, 'site'), { recursive: true })
writeFileSync(join(scratch, 'talk', 'heavy-outline.md'), '# Heavy\n')
// The stand-in compiler. prepareSource holds ALLOCATE_MB as large flat strings (32 MB each) until the
// process ends, as the real compile's inlined-media HTML is; HANG never answers; FAIL throws.
writeFileSync(join(lib, '08-source-adapters.mjs'), `
const held = []
export async function prepareSource(outlinePath, text) {
  const want = Number(/ALLOCATE_MB=(\\d+)/.exec(text)?.[1] ?? 0)
  if (/HANG=1/.test(text)) await new Promise(() => {})
  if (/FAIL=1/.test(text)) throw new Error('The stand-in build failed.')
  for (let i = 0; i < want / 32; i++) held.push(String.fromCharCode(97 + (i % 26)).repeat(32 * 1048576) + i)
  for (const piece of held) piece.charCodeAt(5)
  return { title: 'Heavy', fullHtml: '<section>allocated ' + held.length * 32 + '</section>' }
}
`)
writeFileSync(join(lib, '04-html-extraction.mjs'), `
export const extractStyles = () => ''
export const extractSlides = (html) => [{ id: 's1', html, notes: '' }]
`)
writeFileSync(join(lib, '09-output-builders.mjs'), `
export const buildShareHtml = (args) => '<html>' + args.slides[0].html + '</html>'
`)
writeFileSync(join(lib, 'handout-home-page.mjs'), `
export const buildHandoutHomePageHtml = () => '<html>home</html>'
`)
writeFileSync(join(lib, 'venue-page.mjs'), `
export const buildVenuePageHtml = () => '<html>venue</html>'
export const buildUnavailableVenuePageHtml = () => '<html>unavailable</html>'
`)
writeFileSync(join(lib, 'handout-lazy-assets.mjs'), `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
export async function publishLazyHandoutPagesAsync(dir, pages) {
  for (const page of pages) writeFileSync(join(dir, page.fileName), page.html, 'utf8')
  return { warnings: [] }
}
`)

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '0', TW_HANDOUT_HEAP_REPO: repo, TW_HANDOUT_HEAP_SCRATCH: scratch, TW_HANDOUT_HEAP_CHILD: child }
delete env.ELECTRON_RUN_AS_NODE
const started = Date.now()
const host = spawn(electron, [join(repo, 'e2e', 'handout-heap-host'), `--user-data-dir=${userData}`, '--use-mock-keychain'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
let err = ''
host.stdout.on('data', (chunk) => { out += chunk })
host.stderr.on('data', (chunk) => { err += chunk })
const timer = setTimeout(() => { try { process.kill(host.pid) } catch { /* already gone */ } }, 300_000)
const code = await new Promise((done) => host.on('exit', (status, signal) => done(signal ? `signal ${signal}` : status)))
clearTimeout(timer)
rmSync(scratch, { recursive: true, force: true })

const lines = out.split(/\r?\n/).filter((line) => /^(PASS|FAILED|HANDOUT-HEAP)/.test(line))
for (const line of lines) console.log(line)
const passed = lines.filter((line) => line.startsWith('PASS ')).length
const ok = code === 0 && passed === EXPECTED && lines.includes(`HANDOUT-HEAP OK ${EXPECTED}`)
if (!ok) {
  console.log(`FAILED: the Electron host ended with ${code} after ${((Date.now() - started) / 1000).toFixed(1)}s`)
  const tail = (text) => text.split(/\r?\n/).filter(Boolean).slice(-12).map((line) => `  ${line.slice(0, 240)}`).join('\n')
  if (err.trim()) console.log(`host stderr (last lines):\n${tail(err)}`)
}
console.log(`\n=== HANDOUT OWN HEAP (Electron utility process) SUMMARY: ${passed}/${EXPECTED} passed in ${((Date.now() - started) / 1000).toFixed(1)}s ===`)
process.exit(ok ? 0 : 1)
