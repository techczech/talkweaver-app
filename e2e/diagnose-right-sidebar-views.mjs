// House rules R11a and R18, in the real app: one right sidebar with tabs (Inspector first, Strip second, Guide,
// Research, Images) that one toolbar button and its shortcut (⌘P) show and hide whichever tab is up; three main
// views in one segment of the one toolbar (Slides, Grid, Strip) on ⌘1, ⌘2 and ⌘3; no Pathways switch; Plain /
// Markdown inside the editor's toolbar rather than a bar of its own (R1).
// Electron runs hidden, on a throwaway vault and user-data folder.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const FIX = ['---', 'title: Sidebar Fixture', '---', '', '## Opening', '', '### Four stalls', '', 'Bread and cakes at the first stall.', '', '### Second stall', '', 'Fruit and veg.', ''].join('\n')
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-sidebar-')))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'sidebar-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(td, 'sidebar-fixture-outline.md'), FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

const tabs = page.locator('[data-right-column-tabs] [data-rc-tab]')
const tabNames = async () => (await tabs.evaluateAll((els) => els.map((e) => e.getAttribute('data-rc-tab')))).join(',')
const sidebar = page.locator('[data-right-column]')
const toggle = page.locator('[data-testid="sidebar-toggle"]')
const visible = async (selector) => (await page.locator(selector).count()) > 0 && (await page.locator(selector).first().isVisible())
const activeTab = async () => (await page.locator('[data-rc-tab].rc-tab--on').first().getAttribute('data-rc-tab'))

try {
  await openTalkByTitle(page, 'Sidebar Fixture')
  await page.waitForSelector('.cm-content', { timeout: 8000 })

  // ── R11a: one sidebar, tabs, one toggle ──
  record('the right sidebar shows by default, with its tabs in order: Inspector, Strip, Talk, Research, Images', (await sidebar.count()) === 1 && (await tabNames()) === 'inspector,slides,talk,research,images', await tabNames())
  record('the Inspector is the default tab and shows', (await activeTab()) === 'inspector' && (await visible('.tw-inspector')))
  record('there is exactly one sidebar toggle in the toolbar', (await page.locator('.workspace-toolbar [data-testid="sidebar-toggle"]').count()) === 1)

  await toggle.click()
  record('the toggle hides the whole sidebar (tabs and body)', (await sidebar.count()) === 0 && (await tabs.count()) === 0 && (await toggle.getAttribute('aria-pressed')) === 'false')
  await toggle.click()
  record('the toggle shows it again on the same tab', (await sidebar.count()) === 1 && (await activeTab()) === 'inspector')

  await page.locator('[data-rc-tab="slides"] button').click()
  record('the Strip tab shows the slide strip inside the sidebar', (await visible('[data-right-column] .pane--strip')) && (await activeTab()) === 'slides')

  await page.locator('[data-rc-tab="research"] button').click()
  await page.waitForSelector('[data-right-column] .research-panel', { timeout: 4000 })
  record('the Research tab holds the research panel (not a column or overlay of its own)', (await page.locator('.workspace-row > .research-panel').count()) === 0 && (await activeTab()) === 'research')

  await page.locator('[data-rc-tab="images"] button').click()
  await page.waitForSelector('[data-right-column] [data-image-drawer]', { timeout: 4000 })
  record('the Images tab holds the image drawer, and the research panel is gone from view', (await page.locator('.research-panel').count()) === 0 && (await activeTab()) === 'images')

  await toggle.click()
  record('with Images up, the same toggle hides the whole sidebar (the drawer has no other way to close the sidebar)', (await sidebar.count()) === 0 && (await page.locator('[data-image-drawer]').count()) === 0)
  await page.keyboard.press('Meta+p')
  await page.waitForSelector('[data-right-column]', { timeout: 3000 })
  record('⌘P (its shortcut) shows it again, on the Images tab', (await activeTab()) === 'images')
  await page.keyboard.press('Meta+p')
  record('⌘P hides it', (await sidebar.count()) === 0)
  await page.keyboard.press('Meta+p')
  await page.waitForSelector('[data-right-column]', { timeout: 3000 })
  await page.locator('[data-rc-tab="inspector"] button').click()
  record('back on the Inspector tab', (await activeTab()) === 'inspector' && (await visible('.tw-inspector')))

  // ── R18: three main views in one segment ──
  const labels = await page.locator('[data-view-segment] button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  record('the view segment holds Slides, Grid and Strip, in that order', labels.join(',') === 'Slides,Grid,Strip', labels.join(','))
  record('Pathways is not a view-switch button', (await page.locator('[data-testid="pathways-toggle"]').count()) === 0)
  record('Plain and Markdown sit in the editor toolbar, not in a bar of their own', (await page.locator('.tw-action-bar .tw-editor-tabs').count()) === 1 && (await page.locator('.editor-column > .tw-editor-tabs').count()) === 0)
  const bars = await page.evaluate(() => {
    const editor = document.querySelector('.cm-editor'); const top = editor.getBoundingClientRect().top
    return [...document.querySelectorAll('.workspace > div, .workspace-main > div')].filter((el) => { const r = el.getBoundingClientRect(); return r.bottom <= top + 2 && r.height > 10 && r.width > 600 }).length
  })
  record('at most two bars sit above the editor text (R1)', bars <= 2, String(bars))
  await page.locator('.tw-editor-tab', { hasText: 'Plain' }).click()
  record('Plain / Markdown still switch the editor', (await page.locator('.tw-editor-tab.is-selected').innerText()) === 'Plain')
  await page.locator('.tw-editor-tab', { hasText: 'Markdown' }).click()

  await page.locator('[data-testid="grid-toggle"]').click()
  record('Grid: the slide grid fills the window and the sidebar is not there', (await visible('.pane--grid')) && (await sidebar.count()) === 0 && !(await visible('.cm-content')))
  await toggle.click()
  record('the sidebar button from Grid brings the editor back with the sidebar on', (await visible('.cm-content')) && (await sidebar.count()) === 1)

  await page.locator('[data-testid="strip-toggle"]').click()
  record('Strip: the strip at full width, no editor, no sidebar tabs', (await visible('.pane--strip')) && !(await visible('.cm-content')) && (await tabs.count()) === 0)
  await page.locator('[data-testid="slides-toggle"]').click()
  record('Slides: back to the editor with the sidebar as it was (on)', (await visible('.cm-content')) && (await sidebar.count()) === 1)

  await toggle.click()
  record('Slides with the sidebar off: editor only', (await visible('.cm-content')) && (await sidebar.count()) === 0)
  await page.locator('[data-testid="strip-toggle"]').click()
  await page.locator('[data-testid="slides-toggle"]').click()
  record('Strip and back keeps the sidebar off', (await sidebar.count()) === 0 && (await visible('.cm-content')))

  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+2')
  record('⌘2 is Grid', await visible('.pane--grid'))
  await page.keyboard.press('Meta+3')
  record('⌘3 is Strip', (await visible('.pane--strip')) && !(await visible('.cm-content')))
  await page.keyboard.press('Meta+1')
  record('⌘1 is Slides', await visible('.cm-content'))

  // ── R17: the automatic collapse in a narrow window never overwrites the saved choice ──
  const size = (w, h) => app.evaluate(({ BrowserWindow }, s) => { for (const win of BrowserWindow.getAllWindows()) { win.setMinimumSize(0, 0); win.setBounds({ x: -20000, y: -20000, width: s.w, height: s.h }); win.setContentSize(s.w, s.h) } }, { w, h })
  const savedPane = () => page.evaluate(() => localStorage.getItem('tw-pane-state'))
  await page.locator('[data-testid="slides-toggle"]').click()
  if ((await sidebar.count()) === 0) await toggle.click()
  await page.waitForSelector('[data-right-column]')
  record('before: the saved pane state is "both" (sidebar on)', (await savedPane()) === 'both')
  await size(1000, 631)
  await page.waitForTimeout(800)
  const expand = page.locator('[data-sidebar-expand]')
  if (await expand.count()) await expand.click()
  await page.waitForTimeout(800)
  record('narrow window, Talks sidebar opened: the right sidebar collapses by itself', (await sidebar.count()) === 0, `innerWidth=${await page.evaluate(() => innerWidth)} expand=${await expand.count()}`)
  record('...and the saved choice is still "both"', (await savedPane()) === 'both')
  await size(1400, 900)
  await page.waitForTimeout(800)
  record('wider again: the right sidebar is back as the person had it', (await sidebar.count()) === 1 && (await savedPane()) === 'both')
  await toggle.click()
  await page.waitForTimeout(300)
  record('only an explicit toggle writes the choice ("editor")', (await savedPane()) === 'editor')

  // ── S2: inside the narrow range the person's last choice stands; a height-only resize changes nothing ──
  await size(1000, 631)
  await page.waitForTimeout(800)
  const expand2 = page.locator('[data-sidebar-expand]')
  if (await expand2.count()) await expand2.click()
  await page.waitForSelector('.sidebar-wrap', { timeout: 3000 })
  await size(1000, 520)
  await page.waitForTimeout(800)
  record('narrow window: Talks opened by the person stays open through a height-only resize', (await page.locator('.sidebar-wrap').count()) === 1)

  // ── S1: the Grid with Talks open at 1000 px still fits the toolbar (Present is on screen, nothing overflows) ──
  await size(1000, 631)
  await page.locator('[data-testid="grid-toggle"]').click()
  await page.waitForTimeout(800)
  const fit = await page.evaluate(() => {
    const bar = document.querySelector('.workspace-toolbar'); const present = [...bar.querySelectorAll('.toolbar-btn--primary')][0]
    const r = present.getBoundingClientRect(); const title = bar.querySelector('.workspace-title')
    return { presentRight: Math.round(r.right), vw: innerWidth, overflow: bar.scrollWidth - bar.clientWidth, titleFits: title.scrollWidth <= title.clientWidth + 1 || title.clientWidth >= 190 }
  })
  record('Grid with Talks open at 1000 px: Present is on screen, the toolbar does not overflow, the title keeps its room', fit.presentRight <= fit.vw && fit.overflow <= 1 && fit.titleFits, JSON.stringify(fit))
  await page.locator('[data-testid="slides-toggle"]').click()
} catch (error) {
  record('the run completed', false, String(error?.stack ?? error).slice(0, 400))
} finally {
  await app.close().catch(() => {})
  rmSync(tempRoot, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length} of ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
