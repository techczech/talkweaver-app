// Real-Electron harness: "Optimize images to WebP" converts a talk's relative PNG/JPG images to
// WebP, rewrites the outline refs, and moves originals to the Trash (recoverable).
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-opt-')); const vault = join(root, 'v'); const ud = join(root, 'ud'); const td = join(vault, 'opt-fixture')
mkdirSync(join(td, 'assets'), { recursive: true }); mkdirSync(ud, { recursive: true })
// A valid PNG (1x1) — the APP's sharp (correct Electron ABI) does the real conversion; the harness
// can't load native sharp in plain node. The mechanics (convert + trash + rewrite) don't depend on
// size, so we don't assert byte savings here (verified against the real vault separately).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const spacedName = 'Pasted image 1.png' // real spaces → exercises the decode path too
writeFileSync(join(td, 'assets', spacedName), Buffer.from(PNG_B64, 'base64'))
const fxPath = join(td, 'opt-fixture-outline.md')
const ref = 'assets/Pasted%20image%201.png'
writeFileSync(fxPath, ['---', 'title: Opt Fixture', '---', '', '### A slide', '', `![shot](${ref})`, ''].join('\n'))
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

try {
  await page.locator('.talk-item').first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })

  const content = readFileSync(fxPath, 'utf8')
  const res = await page.evaluate(({ p, c }) => window.tw.talk.optimizeImages(p, c), { p: fxPath, c: content })
  record('optimize succeeds + converts 1 image', !!(res && res.success && res.converted === 1), `res=${JSON.stringify(res && { ok: res.success, n: res.converted, saved: res.savedBytes })}`)
  record('a .webp file was created', existsSync(join(td, 'assets', 'Pasted image 1.webp')), '')
  record('the original PNG was removed (to Trash)', !existsSync(join(td, 'assets', spacedName)), '')
  record('the outline ref was rewritten to .webp', /assets\/Pasted%20image%201\.webp/.test(res?.newContent || readFileSync(fxPath, 'utf8')), '')
  record('the new outline was written to disk', /\.webp/.test(readFileSync(fxPath, 'utf8')) && !/\.png/.test(readFileSync(fxPath, 'utf8')), '')
  record('savedBytes is reported (>= 0)', typeof res?.savedBytes === 'number' && res.savedBytes >= 0, `saved=${res?.savedBytes}`)

  // A talk with no convertible images reports 0 (and doesn't error).
  const res2 = await page.evaluate(({ p }) => window.tw.talk.optimizeImages(p, '---\ntitle: T\n---\n\n### S\n\ntext only'), { p: fxPath })
  record('no-image talk reports 0 converted', !!(res2 && res2.success && res2.converted === 0), `res2=${JSON.stringify(res2 && { ok: res2.success, n: res2.converted })}`)
} catch (e) {
  record('optimize harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== OPTIMIZE-IMAGES SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
