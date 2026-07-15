// Real-Electron harness for the global toast/error messaging (so failures are VISIBLE).
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-toast-')); const vault = join(root, 'v'); const ud = join(root, 'ud'); const td = join(vault, 'toast-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(td, 'toast-fixture-outline.md'), ['---', 'title: Toast Fixture', '---', '', '### A slide', '', 'Body.'].join('\n'))
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

try {
  await page.locator('.talk-item').first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })

  // An error toast shows and PERSISTS (errors don't auto-dismiss).
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tw-toast', { detail: { message: 'Build failed: boom', level: 'error' } })))
  await page.waitForTimeout(300)
  let shown = await page.locator('[role="status"]').innerText().catch(() => '')
  record('error toast appears', /Build failed: boom/.test(shown), `text=${JSON.stringify(shown.slice(0, 40))}`)
  await page.waitForTimeout(1500)
  shown = await page.locator('[role="status"]').innerText().catch(() => '')
  record('error toast persists (no auto-dismiss)', /Build failed: boom/.test(shown), '')

  // A keyed toast REPLACES rather than stacks (no spam).
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('tw-toast', { detail: { message: 'compile A', level: 'error', key: 'compile-fail' } }))
    window.dispatchEvent(new CustomEvent('tw-toast', { detail: { message: 'compile B', level: 'error', key: 'compile-fail' } }))
  })
  await page.waitForTimeout(300)
  const compileCount = await page.evaluate(() => Array.from(document.querySelectorAll('[role="status"] > div')).filter((d) => /compile [AB]/.test(d.textContent || '')).length)
  record('keyed toast de-dupes (replaces, not stacks)', compileCount === 1, `count=${compileCount}`)

  // info toast auto-dismisses.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tw-toast', { detail: { message: 'just fyi', level: 'info' } })))
  await page.waitForTimeout(300)
  const infoUp = await page.locator('[role="status"]').innerText().catch(() => '')
  record('info toast appears', /just fyi/.test(infoUp), '')
  await page.waitForTimeout(4500)
  const infoGone = await page.locator('[role="status"]').innerText().catch(() => '')
  record('info toast auto-dismisses', !/just fyi/.test(infoGone), '')
} catch (e) {
  record('toast harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== TOASTS SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
