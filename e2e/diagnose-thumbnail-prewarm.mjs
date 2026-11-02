// Real-Electron diagnostic for the background thumbnail prewarm (src/main/thumbnail-prewarm.ts).
//
// The eager startup sweep this replaces natively crashed the app at ~1,400 slides (2026-07-20). This
// run builds a temporary vault of TW_PREWARM_TALKS talks × TW_PREWARM_SLIDES slides (default 15 × 100
// = 1,500), each talk carrying a few large photographs, starts the app hidden on a temporary profile
// with the prewarm switched on, opens nothing, and waits for the prewarm to finish on its own. It
// samples memory every few seconds and reports the peaks and the time per slide, then checks that
// every slide the Browser would ask for has its picture on disk and that every window stayed hidden.
// Never the owner's data: the vault and the profile are fresh temp folders.
//
//   env -u ELECTRON_RUN_AS_NODE npm run test:thumbnail-prewarm:e2e
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { createRequire } from 'module'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const require = createRequire(join(REPO, 'package.json'))
const sharp = require('sharp')
const TALKS = Number(process.env.TW_PREWARM_TALKS || 15)
const SLIDES = Number(process.env.TW_PREWARM_SLIDES || 100)
const PHOTOS = Number(process.env.TW_PREWARM_PHOTOS || 6) // per talk
const LIMIT_MS = Number(process.env.TW_PREWARM_LIMIT_MS || 40 * 60_000)
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }
const MB = (b) => Math.round(b / 1048576)

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-prewarm-')); const vault = join(root, 'v'); const ud = join(root, 'ud')
mkdirSync(ud, { recursive: true })

// Photographs: noise compresses badly, so each is a few MB, as camera pictures are.
async function photo(path, seed) {
  const w = 1600, h = 1000
  const px = Buffer.alloc(w * h * 3)
  let x = seed * 2654435761 >>> 0
  for (let i = 0; i < px.length; i += 1) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; px[i] = (x >>> 0) & 0xff }
  await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 1 }).toFile(path)
}

const outlines = []
for (let t = 0; t < TALKS; t += 1) {
  const slug = `bulk-${String(t).padStart(2, '0')}`
  const dir = join(vault, 'imported', slug)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  for (let p = 0; p < PHOTOS; p += 1) await photo(join(dir, 'assets', `p${p}.png`), t * 100 + p + 1)
  const lines = ['---', `title: Bulk ${t}`, 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '']
  for (let s = 0; s < SLIDES; s += 1) {
    lines.push(`### Talk ${t} slide ${s}`, '')
    if (s % 10 === 0) lines.push(`![](assets/p${(s / 10) % PHOTOS}.png)`, '')
    else lines.push(`- point ${s} of talk ${t}`, `- another line for slide ${s}`, '')
  }
  const outline = join(dir, `${slug}-outline.md`)
  writeFileSync(outline, lines.join('\n'))
  outlines.push({ slug, outline })
}
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))

// What the Browser will ask for: each talk's render_hash keys, from the compiler as the search index builds them.
const compiler = join(REPO, 'compiler', 'scripts', 'lib')
const { prepareSource } = await import(pathToFileURL(join(compiler, '08-source-adapters.mjs')).href)
const { buildPerSlideProjections } = await import(pathToFileURL(join(compiler, '10-projections.mjs')).href)
let expected = 0
for (const o of outlines) {
  const model = await prepareSource(o.outline, readFileSync(o.outline, 'utf8'), o.slug, statSync(o.outline), undefined, { projectionsOnly: true })
  o.keys = buildPerSlideProjections(model, o.slug).map((r) => r.render_hash || r.content_hash)
  expected += o.keys.length
}
console.log(`[fixture] ${TALKS} talks, ${expected} slides, ${PHOTOS} photographs per talk, in ${root}`)

await ensureFreshBuild(REPO)
const t0 = Date.now()
const app = await electron.launch({
  args: ['.', '--user-data-dir=' + ud], cwd: REPO,
  env: { ...process.env, TW_E2E: '1', TW_E2E_PREWARM: '1', TW_E2E_PREWARM_DELAY_MS: '3000', TW_E2E_PREWARM_QUIET_MS: '2000',
    // A shared test machine may be busy; the load gate is covered by the unit tests. Set to measure it.
    TW_E2E_PREWARM_MAX_LOAD: process.env.TW_PREWARM_MAX_LOAD || '1000' }
})
if (process.env.TW_E2E_LOG) {
  app.process().stdout.on('data', (d) => process.stdout.write('[main] ' + d))
  app.process().stderr.on('data', (d) => process.stdout.write('[main:err] ' + d))
}
let crashed = false
let closing = false
app.process().on('exit', (code, signal) => { if (!closing) { crashed = true; console.log(`[main] exited code=${code} signal=${signal}`) } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

// For the first seconds after launch (while the search index warms, before the prewarm does anything)
// Playwright's handle on the main process's context is replaced repeatedly ("Execution context was
// destroyed"); measured 2026-10-20, it settles within ~10 s. A reading is simply taken again.
async function sample() {
  for (let attempt = 1; ; attempt += 1) {
    try { return await sampleOnce() } catch (e) {
      if (attempt >= 120 || crashed || !/Execution context was destroyed/.test(String(e?.message))) throw e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}
const sampleOnce = () => app.evaluate(({ app: a }) => {
  const prewarm = globalThis.__twPrewarm
  const usage = process.memoryUsage()
  let appBytes = 0
  const byType = {}
  for (const m of a.getAppMetrics()) {
    const bytes = (m.memory?.workingSetSize ?? 0) * 1024
    appBytes += bytes
    const type = String(m.type).toLowerCase(); byType[type] = Math.max(byType[type] ?? 0, bytes)
  }
  return { status: prewarm ? prewarm.status() : null, heapUsed: usage.heapUsed, rss: usage.rss, appBytes, largestByType: byType }
})

const peak = { heapUsed: 0, rss: 0, appBytes: 0, renderer: 0 }
let last = null
let firstRenderAt = null
try {
  record('the prewarm is on in this run', Boolean((await sample()).status))
  while (Date.now() - t0 < LIMIT_MS && !crashed) {
    await page.waitForTimeout(3000)
    const s = await sample()
    last = s
    peak.heapUsed = Math.max(peak.heapUsed, s.heapUsed)
    peak.rss = Math.max(peak.rss, s.rss)
    peak.appBytes = Math.max(peak.appBytes, s.appBytes)
    peak.renderer = Math.max(peak.renderer, s.largestByType.renderer ?? 0, s.largestByType.tab ?? 0)
    if (!firstRenderAt && s.status.slidesRendered > 0) firstRenderAt = Date.now()
    const st = s.status
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${st.state}${st.reason ? ' (' + st.reason + ')' : ''} talk=${st.currentTalk ?? '-'} ` +
      `slides=${st.slidesRendered} talks=${st.talksWarmed} recycles=${st.recycles} heap=${MB(s.heapUsed)}MB rss=${MB(s.rss)}MB app=${MB(s.appBytes)}MB`)
    if (st.state === 'idle' && st.talksWarmed >= TALKS) break
  }
  const elapsed = Date.now() - t0
  record('the app did not crash', !crashed)
  const st = last?.status
  record(`the prewarm finished every talk on its own (${TALKS})`, st?.state === 'idle' && st.talksWarmed >= TALKS, JSON.stringify(st && { state: st.state, talksWarmed: st.talksWarmed, slides: st.slidesRendered }))

  // Every key the Browser asks for resolves to a PNG in the talk's vault folder.
  const ns = readdirSync(ud).find((n) => /^thumb-cache-v\d+-/.test(n))
  const vaultsDir = ns ? join(ud, ns, '@vaults') : null
  const vaultDir = vaultsDir && existsSync(vaultsDir) ? join(vaultsDir, readdirSync(vaultsDir)[0]) : null
  let present = 0
  for (const o of outlines) {
    const dir = vaultDir ? join(vaultDir, o.slug) : null
    const names = dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')) : []
    const bare = new Set(names.map((f) => f.slice(0, -4).replace(/^[0-9a-f]{16}-/, '')))
    present += o.keys.filter((k) => bare.has(k)).length
  }
  record('every slide the Browser will ask for has its picture on disk', present === expected, `${present} of ${expected}`)

  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))
  record('every window stayed hidden (TW_E2E)', windows.every((v) => !v), JSON.stringify(windows))

  const renderMs = firstRenderAt ? elapsed - (firstRenderAt - t0) : elapsed
  const report = {
    talks: TALKS, slides: expected, photosPerTalk: PHOTOS,
    totalSeconds: Math.round(elapsed / 1000),
    machineLoad1m: Number((await import('os')).loadavg()[0].toFixed(1)), cores: (await import('os')).cpus().length,
    msPerSlide: st?.slidesRendered ? Math.round(renderMs / st.slidesRendered) : null,
    peakMainHeapMB: MB(peak.heapUsed), peakMainRssMB: MB(peak.rss), peakAppMB: MB(peak.appBytes), peakRendererMB: MB(peak.renderer),
    prewarmPeak: st && { mainHeapMB: MB(st.peak.mainHeapBytes), mainRssMB: MB(st.peak.mainRssBytes), rendererMB: MB(st.peak.rendererBytes), appMB: MB(st.peak.appBytes) },
    recycles: st?.recycles
  }
  console.log('[report] ' + JSON.stringify(report))
  const log = join(ud, 'tw-thumbnails.log')
  if (existsSync(log)) {
    const lines = readFileSync(log, 'utf8').split('\n').filter((l) => /prewarm/.test(l))
    console.log(`[thumbnails log] ${lines.length} prewarm lines; last few:\n` + lines.slice(-6).join('\n'))
  }
} catch (e) {
  record('harness completed without an exception', false, e?.stack || String(e))
} finally {
  closing = true
  await app.close().catch(() => {})
  // The photographs make the fixture about half a gigabyte: removed unless asked to keep it.
  if (!process.env.TW_PREWARM_KEEP) rmSync(root, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.p)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
