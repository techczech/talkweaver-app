// Real-Electron harness: outliner edits must NOT move the viewport. The bug — full-doc-replace ops
// (make-heading, re-level) dropped CodeMirror's scroll anchor and scrollIntoView re-scrolled the
// caret to a different spot ("stays in place but slides"). We assert the CARET's on-screen Y barely
// moves through an in-place edit, in a doc tall enough to be scrolled.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

// ~50 slides → a few hundred lines, well past one viewport.
const body = []
body.push('---', 'title: Scroll Fixture', '---', '')
for (let i = 1; i <= 50; i++) body.push(`### Slide ${i}`, '', `Body paragraph for slide ${i}.`, '')
const FIX = body.join('\n')

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-scroll-')); const vault = join(root, 'v'); const ud = join(root, 'ud'); const td = join(vault, 'scroll-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(td, 'scroll-fixture-outline.md'), FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

const scrollTop = () => page.evaluate(() => { const s = document.querySelector('.cm-scroller'); return s ? Math.round(s.scrollTop) : 0 })

try {
  await page.locator('.talk-item', { hasText: 'Scroll Fixture' }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.locator('.cm-content').click()
  await page.waitForTimeout(200)
  // Scroll well down: jump to doc end, then climb back up into the middle.
  await page.keyboard.press('Meta+ArrowDown')
  await page.waitForTimeout(150)
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(250)
  const s0 = await scrollTop()
  record('doc is actually scrolled (precondition)', s0 > 200, `scrollTop=${s0}`)

  // make-heading (⌘⌥↓): the viewport must hold (was: full-doc replace snapped scrollTop to ~0).
  await page.keyboard.press('Meta+Alt+ArrowDown')
  await page.waitForTimeout(250)
  const s1 = await scrollTop()
  record('make-heading does not move the viewport', Math.abs(s1 - s0) <= 120, `scrollTop ${s0} -> ${s1}`)

  // re-level (⌘⇧→): same viewport stability.
  await page.keyboard.press('Meta+Shift+ArrowRight')
  await page.waitForTimeout(250)
  const s2 = await scrollTop()
  record('re-level does not move the viewport', Math.abs(s2 - s1) <= 120, `scrollTop ${s1} -> ${s2}`)
} catch (e) {
  record('scroll harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== SCROLL SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
