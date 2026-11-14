// Pictures of the Guide's How it works topics 11 to 15 and the two Features rows added for 0.44, at the main
// window's smallest size (800 × 600) and a large one (1440 × 900). A throwaway profile with one fixture talk
// opens the example vault, then the Guide. No camera, microphone or recording is used.
// Writes to evidence/guide-044-topics/ (or TW_E2E_SHOTS). Hard limit: 240 seconds; the app closes in finally.
// Run: cd talk-weaver && node e2e/capture-guide-044-topics.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode, openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = process.env.TW_E2E_SHOTS || join(REPO, 'evidence', 'guide-044-topics')
mkdirSync(SHOTS, { recursive: true })
const LIMIT_MS = 240_000
const killer = setTimeout(() => { console.error(`capture: over ${LIMIT_MS / 1000} s, stopping`); process.exit(2) }, LIMIT_MS)

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-guide-044-')))
const home = join(tempRoot, 'home')
const userData = join(tempRoot, 'userData')
const personal = join(tempRoot, 'Personal')
mkdirSync(join(home, 'Documents'), { recursive: true })
mkdirSync(join(personal, 'alpha-talk'), { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(join(personal, 'alpha-talk', 'alpha-talk-outline.md'), '---\ntitle: Alpha Talk\noutline_version: 2\n---\n\n## Section\n\n### First slide {id=a1}\n\nBody one.\n')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: personal }, null, 2))

const MACHINE = {
  cloudflare: { connection: { state: 'none' }, publishing: { state: 'unknown', project: 'talkweaver-handouts', permission: null, customDomain: 'none', stale: false }, liveService: { state: 'unknown', permission: null, stale: false }, shareLink: { state: 'none', host: '', permission: null, stale: false }, busy: false, checkedAt: null, notice: null, details: null },
  tools: { libreoffice: false, poppler: false, agents: [] },
  vaults: [{ name: 'Personal', service: null, git: false }],
  slidewell: false
}

const report = []
let app
let exitCode = 0
try {
  await ensureFreshBuild(REPO)
  app = await electron.launch({ timeout: 30000, args: ['.', '--user-data-dir=' + userData], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_E2E_HOME: home, TW_E2E_MACHINE: JSON.stringify(MACHINE) } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const size = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, s) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(s.width, s.height) }, { width, height })
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(400)
  }
  await size(1440, 900)
  await ensureTalksMode(page)
  await openTalkByTitle(page, 'Alpha Talk')
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await ensureTalksMode(page)
  await page.locator('[data-add-vault]').click()
  const sheet = page.locator('[data-vault-sheet="add"]')
  await sheet.waitFor({ state: 'visible', timeout: 8000 })
  await sheet.locator('[data-open-example]').click()
  await page.locator('[data-vault-header][data-vault-example="true"]').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForSelector('[data-guide]', { timeout: 10000 })

  // What the pane shows: whether a list is longer than its pane, and whether the pane can scroll to its end.
  const measure = (selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    let pane = el.parentElement
    while (pane && !(pane.scrollHeight > pane.clientHeight && /(auto|scroll)/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement
    const box = el.getBoundingClientRect()
    const clipped = [...el.querySelectorAll('*')].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 1) }).length
    return { height: Math.round(box.height), paneScrolls: !!pane, paneHeight: pane ? pane.clientHeight : null, overflowRight: clipped }
  }, selector)
  const scrollEnd = (selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel)
    let pane = el?.parentElement
    while (pane && !(pane.scrollHeight > pane.clientHeight && /(auto|scroll)/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement
    if (!pane) return false
    pane.scrollTop = pane.scrollHeight
    return Math.abs(pane.scrollTop + pane.clientHeight - pane.scrollHeight) < 2
  }, selector)

  for (const [width, height, tag] of [[1440, 900, 'large'], [800, 600, 'small']]) {
    await size(width, height)
    await page.locator('[data-guide-segment="how"]').click()
    await page.waitForSelector('[data-guide-how]', { timeout: 4000 })
    report.push({ shot: `how-list-${tag}`, ...(await measure('[data-guide-how]')) })
    await page.screenshot({ path: join(SHOTS, `how-list-${tag}.png`) })
    report.push({ shot: `how-list-${tag}-end`, scrolledToEnd: await scrollEnd('[data-guide-how]') })
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(SHOTS, `how-list-${tag}-end.png`) })
    for (const n of [11, 12, 13, 14, 15]) {
      await page.locator(`[data-topic-row="how.${n}"]`).click()
      await page.waitForSelector(`[data-topic-detail="how.${n}"]`, { timeout: 4000 })
      report.push({ shot: `how-${n}-${tag}`, ...(await measure(`[data-topic-detail="how.${n}"]`)) })
      await page.screenshot({ path: join(SHOTS, `how-${n}-${tag}.png`) })
      if (tag === 'small') {
        report.push({ shot: `how-${n}-${tag}-end`, scrolledToEnd: await scrollEnd(`[data-topic-detail="how.${n}"]`) })
        await page.waitForTimeout(200)
        await page.screenshot({ path: join(SHOTS, `how-${n}-${tag}-end.png`) })
      }
      await page.locator('[data-topic-back]').click()
      await page.waitForSelector('[data-guide-how]', { timeout: 4000 })
    }
    await page.locator('[data-guide-segment="features"]').click()
    await page.waitForSelector('[data-feature-row="feature.18"]', { timeout: 6000 })
    await page.locator('[data-feature-row="feature.18"]').scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    report.push({ shot: `features-${tag}`, ...(await measure('[data-guide-features]')) })
    await page.screenshot({ path: join(SHOTS, `features-${tag}.png`) })
  }
  for (const line of report) console.log(JSON.stringify(line))
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  await app?.close().catch(() => {})
  rmSync(tempRoot, { recursive: true, force: true })
  clearTimeout(killer)
}
process.exit(exitCode)
