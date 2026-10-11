// Onboarding 0.38.1 ticket 07, in the real app: the Guide button at the foot of the left sidebar opens the
// Guide as the first tab of the right-hand column (and a second click closes it); the Settings switch
// removes the button and the tab; the palette command opens the Guide with the button off; the other
// commands and tabs still work. Progress survives the switch.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
// Screenshots only when asked for (TW_E2E_SHOTS=<folder>), for the screenshot pass.
const SHOTS = process.env.TW_E2E_SHOTS || ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, name) }) : Promise.resolve())

const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const FIX = ['---', 'title: Guide Fixture', '---', '', '## Opening', '', '### Four stalls', '', 'Bread and cakes at the first stall.', ''].join('\n')
const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-guide-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'guide-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(td, 'guide-fixture-outline.md'), FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

const button = page.locator('[data-guide-button]')
const tabs = page.locator('[data-right-column-tabs] [data-rc-tab]')
const tabNames = async () => (await tabs.evaluateAll((els) => els.map((e) => e.getAttribute('data-rc-tab')))).join(',')
async function gone(selector, timeout = 3000) {
  try { await page.waitForSelector(selector, { state: 'detached', timeout }); return true } catch { return false }
}

try {
  await openTalkByTitle(page, 'Guide Fixture')
  await page.waitForSelector('.cm-content', { timeout: 8000 })

  await button.waitFor({ timeout: 5000 })
  record('the sidebar foot has Add vault… and a Guide button (closed)', (await page.locator('[data-add-vault]').count()) === 1 && /^Guide$/.test((await button.innerText()).trim()) && (await page.locator('[data-right-column-tabs]').count()) === 0)

  await button.click()
  await page.waitForSelector('[data-guide]', { timeout: 4000 })
  record('click the button: the Guide is the first tab of the right column (Guide, Slides, Inspector)', (await tabNames()) === 'guide,slides,inspector' && (await page.locator('[data-rc-tab="guide"].rc-tab--on').count()) === 1, await tabNames())
  record('the button reads "Guide open" while the tab is up', /Guide\s*open/.test((await button.innerText()).replace(/\s+/g, ' ')))
  const steps = await page.locator('[data-guide-step]').evaluateAll((els) => els.map((e) => e.getAttribute('data-guide-step') + ':' + e.getAttribute('data-done')))
  record('First steps shows three steps, a talk exists but only in the one vault, so step 1 is ticked and step 2 too', steps.join(',') === 'own-vault:true,first-talk:true,example-talk:false', steps.join(','))

  await page.locator('[data-rc-tab="slides"] button').click()
  record('Slides tab: the strip shows again, the Guide stays up', (await page.locator('[data-guide]').count()) === 0 && (await page.locator('.pane--strip').count()) === 1 && (await page.locator('[data-rc-tab="guide"]').count()) === 1)
  await page.locator('[data-rc-tab="inspector"] button').click()
  record('Inspector tab: the Inspector shows', (await page.locator('.tw-inspector').count()) === 1)
  await page.locator('[data-rc-tab="guide"] button').first().click()
  record('Guide tab again: the Guide shows', (await page.locator('[data-guide]').count()) === 1)

  await page.locator('[data-guide-segment="how"]').click()
  record('the segments switch (How it works selected)', (await page.locator('[data-guide-slot="how-it-works"]').count()) === 1)

  await button.click()
  record('click the button again: the Guide closes and the column is as before (no tab row)', await gone('[data-guide]') && (await page.locator('[data-right-column-tabs]').count()) === 0 && !/open/.test(await button.innerText()))

  // Settings → Get started: the switch.
  await page.evaluate(() => window.dispatchEvent(new Event('tw-open-settings')))
  await page.waitForSelector('[data-setting="guide-button"] [role="switch"]', { timeout: 4000 })
  const switchEl = page.locator('[data-setting="guide-button"] [role="switch"]')
  const first = await page.evaluate(() => document.querySelector('[data-settings-section]')?.getAttribute('data-settings-section'))
  record('Settings: Get started is the first section; the switch is on by default', first === 'get-started' && (await switchEl.getAttribute('aria-checked')) === 'true')
  await switchEl.click()
  await page.waitForSelector('[data-setting="guide-button"] [role="switch"][aria-checked="false"]', { timeout: 3000 })
  const flash = await page.waitForFunction(() => document.body.innerText.includes('Guide button removed from the sidebar. Settings → Get started, or the palette, brings it back.'), null, { timeout: 4000 }).then(() => true).catch(() => false)
  record('switch off: the flash says the button was removed and how it comes back', flash)
  await page.keyboard.press('Escape')
  record('switch off: the sidebar has no Guide button and the config keeps the choice', await gone('[data-guide-button]') && JSON.parse(readFileSync(join(ud, 'config.json'), 'utf8')).guideButtonVisible === false)

  // The palette opens it anyway, for this session.
  await page.evaluate(() => window.dispatchEvent(new Event('tw-guide-open')))
  await page.waitForSelector('[data-guide]', { timeout: 3000 }).catch(() => {})
  record('"Get started: open the Guide" opens the tab with the button off (still no button)', (await page.locator('[data-guide]').count()) === 1 && (await page.locator('[data-guide-button]').count()) === 0)

  // And the other one brings the button back.
  await page.evaluate(() => window.dispatchEvent(new Event('tw-guide-show-button')))
  await page.waitForSelector('[data-guide-button]', { timeout: 3000 }).catch(() => {})
  record('"Get started: show the Guide button" brings the button back (reading "Guide open", the tab being up)', (await page.locator('[data-guide-button]').count()) === 1 && /open/.test(await button.innerText()))

  // First launch, "Open example vault": the Guide opens once, with the third step ticked. With the
  // button switched off beforehand, the Guide does not open. Homes are temporary (TW_E2E_HOME).
  for (const buttonOn of [true, false]) {
    const dir = realpathSync(mkdtempSync(join(tempRoot, 'first-')))
    const home = join(dir, 'home'); const userData = join(dir, 'userData')
    mkdirSync(join(home, 'Documents'), { recursive: true }); mkdirSync(userData, { recursive: true })
    writeFileSync(join(userData, 'config.json'), JSON.stringify(buttonOn ? {} : { guideButtonVisible: false }, null, 2))
    const second = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_E2E_HOME: home } })
    try {
      const p2 = await second.firstWindow()
      await p2.waitForLoadState('domcontentloaded')
      await second.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })
      await p2.waitForSelector('[data-open-example]', { timeout: 10000 })
      await p2.locator('[data-open-example]').click()
      await p2.waitForSelector('[data-talk-title="The Saturday market"]', { timeout: 15000 })
      if (buttonOn) {
        await p2.waitForSelector('[data-guide]', { timeout: 8000 })
        const names = (await p2.locator('[data-right-column-tabs] [data-rc-tab]').evaluateAll((els) => els.map((e) => e.getAttribute('data-rc-tab')))).join(',')
        await p2.waitForSelector('[data-guide-step="example-talk"][data-done="true"]', { timeout: 8000 }).catch(() => {})
        const done = await p2.locator('[data-guide-step]').evaluateAll((els) => els.map((e) => e.getAttribute('data-done')))
        record('Open example vault: the Guide opens, first of the right column, with only the example talk step ticked', names === 'guide,slides,inspector' && done.join(',') === 'false,false,true', `${names} ${done}`)
        await shot(p2, 'guide-example-open.png')
        record('the progress is kept in app config, outside the vault', JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8')).guideProgress?.exampleTalkOpened === true)
      } else {
        await p2.waitForTimeout(1500)
        record('Open example vault with the Guide button switched off: no Guide tab, no button', (await p2.locator('[data-guide]').count()) === 0 && (await p2.locator('[data-guide-button]').count()) === 0)
      }
    } finally {
      await second.close()
    }
  }
} catch (e) {
  record('guide harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== GUIDE SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}
