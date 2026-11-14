// Work-files-and-sessions ticket 01: the Tools window's one rail, in the real app.
// Hidden-window Electron runs against a fresh, isolated temp userData (a new vault, nothing else); no network.
// Pre-work is on for everyone (ticket 32): no environment switch is set.
//   (a) the rail shows Studio, Runs, Importer, Published pages, Work files (History and Sessions are one Runs view; the old names open it);
//       each opens its view; the three new views show their drawn empty states;
//   (b) the Tools window can be asked to open Sessions on a Run (talk slug + Run id);
//   (c) an unknown view and a malformed Run are refused;
//   (d) a Tools window opened straight on Studio carries the same rail, and Sessions, Published pages and
//       Work files open through the one Tools route.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

let failures = 0
const rec = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
await ensureFreshBuild(process.cwd())

async function launch() {
  const root = mkdtempSync(join(tmpdir(), 'tw-tools-rail-e2e-'))
  const vault = join(root, 'vault')
  const ud = join(root, 'userData')
  mkdirSync(vault, { recursive: true })
  mkdirSync(ud, { recursive: true })
  writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
  const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env, timeout: 60_000 }) }
    catch (error) {
      if (attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 15_000))
    }
  }
}

async function openTools(app, page, view, ...rest) {
  const known = app.windows().length
  const pending = app.windows().length > 1 ? null : app.waitForEvent('window')
  const result = await page.evaluate(([v, r]) => window.tw.tools.open(v, undefined, ...r), [view, rest])
  const tools = pending ? await pending : app.windows().find((w) => w !== page)
  await tools.waitForLoadState('domcontentloaded')
  return { tools, result, known }
}

// ---- (a)–(c), opened on History
{
  const app = await launch()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)
    const { tools, result } = await openTools(app, page, 'history') /* the old name: it opens the Runs view */
    rec('Tools opens on the Runs view when asked for History', result.success)
    tools.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
    await tools.waitForSelector('[data-tools-rail]', { timeout: 10_000 }).catch(() => {})
    const labels = async () => (await tools.locator('[data-tools-rail]').allTextContents()).map((t) => t.trim())
    const want = ['Studio', 'Runs', 'Importer', 'Published pages', 'Work files']
    const got = await labels()
    rec('rail shows five items in order', JSON.stringify(got) === JSON.stringify(want), got.join(' | '))
    rec('Work files uses the files icon', (await tools.locator('[data-tools-rail="workfiles"] svg').getAttribute('class') ?? '').includes('lucide-files'))
    rec('Runs is the current item', await tools.locator('[data-tools-rail="runs"][aria-current="page"]').count() === 1)

    await tools.locator('[data-tools-rail="studio"]').click()
    await tools.waitForSelector('.twstudio', { timeout: 8000 })
    rec('Studio item opens Studio', await tools.locator('[data-tools-rail="studio"][aria-current="page"]').count() === 1)
    await tools.locator('[data-tools-rail="runs"]').click()
    await tools.waitForSelector('[data-tools-view="runs"]', { timeout: 8000 })
    rec('Runs item opens the Runs view', true)
    await tools.locator('[data-tools-rail="importer"]').click()
    await tools.waitForSelector('.twi', { timeout: 8000 })
    rec('Importer item opens the Importer inside the rail', await tools.locator('[data-tools-rail="importer"][aria-current="page"]').count() === 1 && await tools.locator('[data-tools-rail]').count() === 5)

    const empty = {
      runs: ['No Runs yet', 'No Run selected'],
      published: ['Nothing is published', 'No page selected'],
      workfiles: ['No work files', 'A work file holds the steps of a pre-work or a post-work.', 'No work file selected']
    }
    for (const [view, texts] of Object.entries(empty)) {
      await tools.locator(`[data-tools-rail="${view}"]`).click()
      await tools.waitForSelector(`[data-tools-view="${view}"]`, { timeout: 5000 }).catch(() => {})
      // Runs, Work files and Published pages ask main for their lists first; the empty state shows once the answer is in.
      await tools.waitForSelector(`[data-tools-view="${view}"] .tw-tools-empty`, { timeout: 5000 }).catch(() => {})
      const body = (await tools.locator(`[data-tools-view="${view}"]`).textContent().catch(() => '')) ?? ''
      if (shotsDir) await tools.screenshot({ path: join(shotsDir, `${view}.png`) }).catch(() => {})
      rec(`${view} shows its empty state`, texts.every((t) => body.includes(t)), body.trim().slice(0, 100))
    }

    // (b) a Run, by talk and Run id, through the one open call
    const asked = await page.evaluate(() => window.tw.tools.openRun('agents-now', '2026-10-21-said'))
    await tools.waitForSelector('[data-tools-view="runs"][data-run="agents-now/2026-10-21-said"]', { timeout: 5000 }).catch(() => {})
    rec('asking for a Run opens Sessions on it', asked.success && await tools.locator('[data-tools-view="runs"][data-run="agents-now/2026-10-21-said"]').count() === 1)

    // (c) refusals
    const unknown = await page.evaluate(() => window.tw.tools.open('settings'))
    rec('an unknown view is refused (preload)', unknown.success === false)
    const rawUnknown = await page.evaluate(() => window.tw.tools.open('constructor'))
    rec('another unknown view is refused', rawUnknown.success === false)
    const badRun = await page.evaluate(() => window.tw.tools.openRun('../x', 'r'))
    rec('a malformed Run is refused', badRun.success === false)
    const pathways = await page.evaluate(() => window.tw.tools.open('pathways'))
    rec('Pathways is not opened by the generic call', pathways.success === false)
  } finally { await app.close().catch(() => {}) }
}

// ---- (d) a fresh install opened on Studio
{
  const app = await launch()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)
    const { tools, result } = await openTools(app, page, 'studio')
    rec('Tools opens on Studio', result.success)
    await tools.waitForSelector('.twstudio', { timeout: 10_000 }).catch(() => {})
    await tools.waitForSelector('[data-tools-rail]', { timeout: 10_000 }).catch(() => {})
    const got = (await tools.locator('[data-tools-rail]').allTextContents()).map((t) => t.trim())
    rec('the rail on Studio shows every Tools view', JSON.stringify(got) === JSON.stringify(['Studio', 'Runs', 'Importer', 'Published pages', 'Work files']), got.join(' | '))
    for (const [asked, view] of [['sessions', 'runs'], ['history', 'runs'], ['runs', 'runs'], ['published', 'published'], ['workfiles', 'workfiles']]) {
      const opened = await page.evaluate((v) => window.tw.tools.open(v), asked)
      await tools.waitForSelector(`[data-tools-view="${view}"]`, { timeout: 5000 }).catch(() => {})
      rec(`${asked} opens through the Tools route${asked !== view ? ' (an old name for the Runs view)' : ''}`, opened.success && await tools.locator(`[data-tools-view="${view}"]`).count() === 1)
    }
    rec('the bridge has no pre-work question left', await page.evaluate(() => !(('prework' + 'Enabled') in window.tw.tools)))
  } finally { await app.close().catch(() => {}) }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
