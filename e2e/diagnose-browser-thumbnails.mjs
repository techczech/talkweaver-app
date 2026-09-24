// Real-Electron gate for Slide Browser thumbnails across a compiler upgrade (2026-09-15).
//
// The bug: search-index.json rows were reused on outline mtime alone, so after a compiler change
// the Browser addressed thumbnails by STALE render_hash keys that no build would ever write —
// every card but the untouched title slide fell back to its schematic. This harness seeds the
// profile exactly as an upgraded one looks (correct mtime, no compilerTag, render_hash values
// from "another compiler"), opens the Browser on a six-slide talk and demands a real, distinct
// picture on every card within a bounded time; a second opening must be served from the cache.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }
const SHOTS = process.env.TW_SHOT_DIR || ''

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-browser-thumbs-')); const vault = join(root, 'v'); const ud = join(root, 'ud')
const scratch = join(vault, 'misc', 'scratch-talk'); const six = join(vault, 'topic', 'six-talk')
mkdirSync(scratch, { recursive: true }); mkdirSync(six, { recursive: true }); mkdirSync(ud, { recursive: true })
// The talk being edited is never on the Browser's table, so a second talk is opened in the editor.
writeFileSync(join(scratch, 'scratch-talk-outline.md'), ['---', 'title: Scratch Talk', '---', '', '### Only slide', '', 'Placeholder.', ''].join('\n'))
const sixOutline = join(six, 'six-talk-outline.md')
writeFileSync(sixOutline, [
  '---', 'title: Six Talk', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '### First light', '{statement}', '', 'One sentence about beginnings.', '',
  '### Second thoughts', '', '- alpha', '- beta', '- gamma', '',
  '### Third way', '{quote}', '', '> A path between two others.', '',
  '### Fourth wall', '', 'Text that speaks to the reader directly.', '',
  '### Fifth column', '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
  '### Sixth sense', '', '```js', 'const seen = true', '```', ''
].join('\n'))
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))

// Seed the profile as an upgraded one: rows from the real compiler, mtime correct, NO compilerTag,
// and every render_hash rewritten so it names a picture no compiler produces.
const compiler = join(REPO, 'compiler', 'scripts', 'lib')
const { prepareSource } = await import(pathToFileURL(join(compiler, '08-source-adapters.mjs')).href)
const { buildPerSlideProjections } = await import(pathToFileURL(join(compiler, '10-projections.mjs')).href)
const sixSource = readFileSync(sixOutline, 'utf8')
const model = await prepareSource(sixOutline, sixSource, 'six-talk', statSync(sixOutline), undefined, { projectionsOnly: true })
const freshRows = buildPerSlideProjections(model, 'six-talk')
const staleHash = (h) => 'sha256-' + h.slice(7).split('').reverse().join('')
const staleRows = freshRows.map((r) => ({ ...r, render_hash: staleHash(r.render_hash) }))
writeFileSync(join(ud, 'search-index.json'), JSON.stringify({
  [sixOutline]: { mtimeMs: statSync(sixOutline).mtimeMs, rows: staleRows, talkTitle: 'Six Talk', slug: 'six-talk', meta: '' }
}))
const expected = freshRows.length
console.log(`[fixture] six-talk compiles to ${expected} slides; index seeded with ${staleRows.length} stale rows`)

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
if (process.env.TW_E2E_LOG) {
  app.process().stdout.on('data', (d) => process.stdout.write('[main] ' + d))
  app.process().stderr.on('data', (d) => process.stdout.write('[main:err] ' + d))
}
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

// Every six-talk card on the table with the state of its picture.
const cardState = () => page.evaluate(() => {
  const cards = [...document.querySelectorAll('.lt-card:not(.skeleton)')]
  return cards.map((c) => {
    const img = c.querySelector('.lt-thumb img')
    return {
      src: img?.getAttribute('src') || null,
      ok: Boolean(img && img.complete && img.naturalWidth > 0),
      fallback: Boolean(c.querySelector('.lt-thumb-fallback'))
    }
  })
})
async function waitForAllPictures(limitMs) {
  const t0 = Date.now()
  let last = []
  while (Date.now() - t0 < limitMs) {
    last = await cardState()
    if (last.length >= expected && last.every((c) => c.ok)) break
    await page.waitForTimeout(250)
  }
  return { cards: last, elapsedMs: Date.now() - t0 }
}
const sixCacheDir = () => {
  const ns = readdirSync(ud).filter((n) => n.startsWith('thumb-cache-v8-'))
  for (const n of ns) { const d = join(ud, n, 'six-talk'); if (existsSync(d)) return d }
  return null
}
const pngStamps = (dir) => (dir ? readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`) : [])

try {
  await openTalkByTitle(page, 'Scratch Talk')
  await page.waitForSelector('.cm-content', { timeout: 8000 }); await page.waitForTimeout(400)

  // ── first opening: stale index → rebuilt → every card gets a real, distinct picture ──
  await page.keyboard.press('Meta+s')
  await page.waitForSelector('.lt-browser-root', { timeout: 5000 })
  const first = await waitForAllPictures(20_000)
  record(`Browser lays out the six-talk cards`, first.cards.length === expected, `cards=${first.cards.length} expected=${expected}`)
  record('every card shows a rendered thumbnail within 20s (img.naturalWidth > 0)',
    first.cards.length === expected && first.cards.every((c) => c.ok), `ok=${first.cards.filter((c) => c.ok).length} fallback=${first.cards.filter((c) => c.fallback).length} in ${first.elapsedMs}ms`)
  record('no card is on the schematic title fallback', first.cards.every((c) => !c.fallback))
  const srcs = new Set(first.cards.map((c) => c.src).filter(Boolean))
  record('thumbnails are distinct per slide', srcs.size === expected, `distinct=${srcs.size}`)
  record('card keys are the fresh render_hash values, not the seeded stale ones',
    first.cards.every((c) => c.src && freshRows.some((r) => c.src.endsWith('/' + r.render_hash))) &&
    first.cards.every((c) => !staleRows.some((r) => c.src?.endsWith('/' + r.render_hash))))
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'gate-first-open.png') }) }

  // ── persisted index carries the compiler tag ──
  await page.waitForTimeout(900) // persist is trailing-debounced at 500ms
  const persisted = JSON.parse(readFileSync(join(ud, 'search-index.json'), 'utf8'))
  const entry = persisted[sixOutline]
  record('search-index.json entry now carries the compiler tag', typeof entry?.compilerTag === 'string' && entry.compilerTag.startsWith('thumb-cache-v8-'), String(entry?.compilerTag))
  record('persisted rows carry the fresh render_hash values', Boolean(entry) && entry.rows.every((r, i) => r.render_hash === freshRows[i].render_hash))

  // ── second opening is served from the cache: no PNG rewritten, pictures immediate ──
  const dir = sixCacheDir()
  const before = pngStamps(dir)
  record('six-talk has a thumbnail cache directory with one PNG per slide', Boolean(dir) && before.length === expected, `dir=${dir} pngs=${before.length}`)
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  if (await page.locator('.lt-browser-root').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
  record('Browser closes', (await page.locator('.lt-browser-root').count()) === 0)
  await page.keyboard.press('Meta+s')
  await page.waitForSelector('.lt-browser-root', { timeout: 5000 })
  const second = await waitForAllPictures(4000)
  record('second opening shows every thumbnail within 4s', second.cards.length === expected && second.cards.every((c) => c.ok), `ok=${second.cards.filter((c) => c.ok).length} in ${second.elapsedMs}ms`)
  await page.waitForTimeout(800)
  const after = pngStamps(dir)
  record('second opening did not re-render (PNG set and mtimes unchanged)', JSON.stringify(after) === JSON.stringify(before), `${before.length} → ${after.length}`)
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'gate-second-open.png') })

  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))
  record('every window stayed hidden (TW_E2E)', windows.every((v) => !v), JSON.stringify(windows))
} catch (e) {
  record('harness completed without an exception', false, e?.stack || String(e))
} finally {
  await app.close().catch(() => {})
}
const failed = results.filter((r) => !r.p)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
