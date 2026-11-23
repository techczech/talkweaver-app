// ADR-0045 IN1, IN2, TD1, CA1 and CA2. Hidden Electron, synthetic talk and real writer.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright'
import { scratchVault } from './lib/scratch-vault.mjs'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

using fixture = scratchVault('tw-right-panel-')
const root = resolve('.')
const vault = join(fixture.root, 'vault')
const profile = join(fixture.root, 'profile')
const talk = join(vault, 'garden')
const outline = join(talk, 'garden-outline.md')
const source = [
  '---', 'outline_version: 2', 'title: Garden meeting', 'auto_title_slide: false', 'auto_thanks_slide: false',
  'defaults:', '  title: top', '---', '',
  '## In the garden {id=g1}', '', '### Three priorities {id=p1}', '{plainlist}',
  '', '- Repair the beds', '- Share the tools', '- Welcome new growers', '',
  ':::notes', '- PRIVATE: client fee is 40k', ':::', '',
  '### Volunteer shifts {id=p2}', '{table}', '', '| Day | Volunteers |', '| --- | --- |', '| Monday | 4 |', '',
  '### Garden photographs {id=p3}', '', '- The garden at the start of the year', '', '![The beds](beds.png)', ''
].join('\n')
mkdirSync(talk, { recursive: true })
mkdirSync(profile)
writeFileSync(outline, source)
copyFileSync(join(root, 'demo-vault/layout-sampler/assets/sample-image.png'), join(talk, 'beds.png'))
writeFileSync(join(profile, 'config.json'), JSON.stringify({ vaultRoot: vault }))
const env = { TW_E2E: '1' }
for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY']) {
  if (process.env[name] !== undefined) env[name] = process.env[name]
}
const disk = () => readFileSync(outline, 'utf8')
async function until(check, message) {
  const end = Date.now() + 20000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error(message)
}
await ensureFreshBuild(root)
const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env })
try {
  const page = await app.firstWindow()
  const notices = []
  await page.exposeFunction('recordRightPanelNotice', message => { notices.push(message) })
  await page.evaluate(() => window.addEventListener('tw-toast', event => {
    void window.recordRightPanelNotice(event.detail.message)
  }))
  // Returning from an external editor rechecks the file even while this synthetic window is hidden.
  const returnToTalk = () => app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.emit('focus')
  })
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  page.setDefaultTimeout(20000)
  await app.evaluate(({ BrowserWindow, session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => reply({ cancel: true }))
    for (const win of BrowserWindow.getAllWindows()) win.setContentSize(1440, 900)
  })
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible())))
  await page.locator('[data-talk-slug="garden"]').first().dblclick()
  const inspector = page.locator('.tw-inspector')
  await inspector.waitFor()

  const sidebar = page.locator('[data-right-column]')
  const sidebarToggle = page.locator('.workspace-view-titlebar').getByTestId('sidebar-toggle')
  const slideTab = sidebar.getByRole('tab', { name: 'Slide', exact: true })
  const researchTab = sidebar.getByRole('button', { name: 'Research', exact: true })
  const imagesTab = sidebar.getByRole('button', { name: 'Images', exact: true })
  const researchPanel = page.locator('.research-panel')
  const imageDrawer = page.locator('[data-image-drawer]')
  assert.equal(await sidebar.count(), 1)
  assert.equal(await sidebarToggle.count(), 1)
  assert.equal(await slideTab.getAttribute('aria-selected'), 'true')
  await sidebarToggle.click()
  await sidebar.waitFor({ state: 'detached' })
  assert.equal(await sidebarToggle.getAttribute('aria-pressed'), 'false')
  await sidebarToggle.click()
  await inspector.waitFor()
  assert.equal(await slideTab.getAttribute('aria-selected'), 'true')

  await researchTab.click()
  await sidebar.locator('.research-panel').waitFor()
  assert.equal(await researchPanel.count(), 1, 'Research has one host in the right sidebar')
  assert.equal(await researchTab.getAttribute('aria-pressed'), 'true')
  await imagesTab.click()
  await sidebar.locator('[data-image-drawer]').waitFor()
  await researchPanel.waitFor({ state: 'detached' })
  assert.equal(await imageDrawer.count(), 1, 'Images has one host in the right sidebar')
  assert.equal(await imagesTab.getAttribute('aria-pressed'), 'true')

  await sidebarToggle.click()
  await sidebar.waitFor({ state: 'detached' })
  await imageDrawer.waitFor({ state: 'detached' })
  await page.keyboard.press('ControlOrMeta+p')
  await sidebar.locator('[data-image-drawer]').waitFor()
  assert.equal(await imagesTab.getAttribute('aria-pressed'), 'true', 'the shortcut restores the active panel')
  await page.keyboard.press('ControlOrMeta+p')
  await sidebar.waitFor({ state: 'detached' })
  await page.keyboard.press('ControlOrMeta+p')
  await sidebar.locator('[data-image-drawer]').waitFor()
  await slideTab.click()
  await inspector.waitFor()
  console.log('Right sidebar: Research and Images share one host, and the toolbar and shortcut restore the active panel.')

  await inspector.locator('.tw-right-who').getByText(/In the garden|Three priorities/).first().waitFor()
  if (!(await inspector.locator('.tw-right-who').textContent()).includes('Three priorities')) {
    await inspector.getByRole('button', { name: 'Next slide', exact: true }).click()
  }
  await inspector.locator('.tw-right-who').getByText('Three priorities', { exact: true }).waitFor()
  const designs = inspector.locator('[data-section="designs"]')
  const iconList = designs.getByRole('button', { name: /^Icon list\b/ })
  await iconList.locator('img').waitFor()
  const stage = page.locator('.workspace-slide-stage iframe')
  await stage.waitFor()
  const beforeTry = await stage.getAttribute('src')
  await iconList.hover()
  await page.locator('.workspace-slide-content').getByText(/Trying: Icon list. Not applied/).waitFor()
  await until(async () => (await stage.getAttribute('src')) !== beforeTry, 'Try must replace the main stage picture')
  assert.equal(disk(), source, 'preview leaves the outline byte for byte')
  await iconList.click()
  await until(() => /\{iconlist=list\}/.test(disk()), 'the picked design did not save')
  assert.match(disk(), /^### Three priorities\n\{id=p1\}/m, 'saving also moves legacy heading codes to their Trigger line')
  assert.doesNotMatch(disk(), /\{(?:list|title=show|titletop)\}/, 'keeping an icon design leaves the inherited title and list layout alone')
  await page.locator('.tw-right-bar').getByRole('button', { name: 'Undo', exact: true }).click()
  await until(() => disk() === source, 'the design must undo as one step')
  await inspector.locator('.tw-right-adjust').getByRole('button', { name: /^Title\b/ }).click()
  await inspector.getByRole('button', { name: 'Back', exact: true }).waitFor()
  assert.equal(await designs.count(), 0, 'pages show only the page selected')
  const panelMenu = page.getByRole('button', { name: 'Panel options', exact: true })
  await panelMenu.click()
  await page.getByRole('button', { name: 'One long list', exact: true }).click()
  await inspector.getByRole('navigation', { name: 'Jump to' }).waitFor()
  await inspector.locator('[data-section="title"]').waitFor()
  await designs.waitFor()
  await panelMenu.click()
  await page.getByRole('button', { name: 'Pages', exact: true }).click()
  await inspector.getByRole('button', { name: 'Back', exact: true }).click()
  await inspector.locator('.tw-right-adjust').getByRole('button', { name: /^Icons\b/ }).click()
  const iconsPage = inspector.locator('[data-section="icons"]')
  await iconsPage.getByRole('button', { name: 'Icons', exact: true }).click()
  await inspector.getByText('Share the tools', { exact: true }).waitFor()
  assert.equal(await inspector.getByText(/PRIVATE: client fee/).count(), 0)
  await inspector.getByRole('button', { name: 'Copy for agent', exact: true }).click()
  const copy = page.getByRole('dialog', { name: /Copy for agent/ })
  const field = copy.getByRole('textbox', { name: 'Request for agent', exact: true })
  await until(async () => (await field.inputValue()) || await copy.getByRole('alert').count(), 'Copy did not finish preparing')
  assert.match(await field.inputValue(), /Share the tools/, await copy.locator('footer [role="status"]').innerText())
  assert.match(await field.inputValue(), /id p1/, 'Copy follows a legacy ID through save tidy-up')
  assert.doesNotMatch(await field.inputValue(), /PRIVATE: client fee/)
  const saved = disk()
  assert.match(saved, /\{iconlist\}/)
  assert.match(await field.inputValue(), /Change only the named aspect. Keep the id line/)
  await copy.getByRole('textbox', { name: 'What should be better?', exact: true }).fill('Make the priorities easier to scan.')
  assert.match(await field.inputValue(), /What I want: Make the priorities easier to scan/)
  await page.evaluate(() => {
    window.copiedRequests = []
    Object.defineProperty(navigator.clipboard, 'writeText', { value: async text => { window.copiedRequests.push(text) } })
  })
  await copy.getByRole('button', { name: 'Copy', exact: true }).click()
  await copy.getByText('Copied. Paste it into your agent.', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.copiedRequests.length), 1)
  const changed = saved.replace('Share the tools', 'Share the tools {icon=lucide:wrench}')
  writeFileSync(outline, changed)
  await copy.getByRole('button', { name: 'Copy again', exact: true }).click()
  await copy.getByText('Not saved yet, so Copy is off.', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.copiedRequests.length), 1, 'a stale disk comparison blocks the clipboard')
  await copy.getByRole('button', { name: 'Close', exact: true }).click()
  await returnToTalk()
  const review = page.getByRole('dialog', { name: /Three priorities.*changed outside TalkWeaver/ })
  await review.waitFor({ timeout: 60_000 })
  assert.match(await review.locator('.tw-review-diff ins').innerText(), /icon=lucide:wrench/)
  assert.doesNotMatch(await review.locator('.tw-review-diff del').innerText(), /icon=lucide:wrench/)
  assert.equal(disk(), changed, 'reading and drawing the disk review makes no write')
  await review.getByRole('button', { name: 'Put it back', exact: true }).click()
  await until(() => disk() === saved, 'Put it back restores the reviewed slide’s prior bytes')
  writeFileSync(outline, changed)
  await returnToTalk()
  await review.waitFor({ timeout: 60_000 })
  await review.getByRole('button', { name: 'Keep the change', exact: true }).click()
  await review.waitFor({ state: 'detached' })
  await page.locator('.tw-disk-chip-btn').waitFor({ state: 'hidden' })
  assert.equal(disk(), changed)
  const currentSlide = inspector.locator('.tw-right-who strong')
  await until(async () => {
    if ((await currentSlide.innerText()) === 'Garden photographs') return true
    const next = inspector.getByRole('button', { name: 'Next slide', exact: true })
    if (await next.isEnabled()) await next.click()
    return false
  }, 'could not select the mixed media slide')
  await inspector.locator('.tw-right-adjust').getByRole('button', { name: /^Picture\b/ }).click()
  const photoOptions = inspector.locator('[data-section="picture"]')
  const side = label => photoOptions.locator('.tw-right-picture').filter({ has: page.getByText(label, { exact: true }) })
  await side('On the left').waitFor()
  assert.equal(await side('On the left').getAttribute('aria-pressed'), 'true')
  notices.length = 0
  await side('On the right').click()
  try {
    await until(() => /\{image=right\}/.test(disk()), 'the picture did not move to the right')
  } catch (error) {
    console.error('Picture placement after Keep', {
      notices,
      activeSlide: await currentSlide.textContent(),
      diskNotice: await page.locator('.tw-disk-chip-btn').count(),
      applied: await page.locator('.tw-right-bar').filter({ hasText: 'Applied:' }).allTextContents(),
      rightIsCurrent: await side('On the right').getAttribute('aria-pressed', { timeout: 1000 }).catch(() => null)
    })
    throw error
  }
  await until(async () => (await side('On the right').getAttribute('aria-pressed')) === 'true', 'the rendered right placement is not marked Current')
  assert.equal(await side('On the left').getAttribute('aria-pressed'), 'false')
  const pictureRight = disk()
  await side('On the left').click()
  await until(() => /\{image=left\}/.test(disk()), 'the picture did not move back to the left')
  await until(async () => (await side('On the left').getAttribute('aria-pressed')) === 'true', 'the rendered left placement is not marked Current')
  assert.equal(await side('On the right').getAttribute('aria-pressed'), 'false')
  await page.locator('.tw-right-bar').getByRole('button', { name: 'Undo', exact: true }).click()
  await until(() => disk() === pictureRight, 'Undo restores the saved right placement and bytes')
  await until(async () => (await side('On the right').getAttribute('aria-pressed')) === 'true', 'Undo restores the right Current tile')
  await page.getByRole('tab', { name: 'Talk', exact: true }).click()
  await page.getByRole('button', { name: 'Design', exact: true }).click()
  await page.getByRole('heading', { name: 'Titles', exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('Right panel: own slide pictures, non-writing Try, atomic Keep/Undo, pages/list, private notes excluded, saved ID in prompt, external Keep/Put back, picture right/left/Undo, Talk Design.')
} finally {
  const child = app.process()
  await Promise.race([app.close().catch(() => {}), delay(8000, undefined, { ref: false })])
  if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
}
