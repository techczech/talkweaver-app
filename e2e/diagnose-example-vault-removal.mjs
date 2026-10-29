// e2e for removing the example vault and bringing it back (onboarding 0.38.1 ticket 12; locked drawing
// states 15, 16, 16b and 17). Real Electron, headless (TW_E2E=1). The home folder is a stand-in under
// the system temp folder (TW_E2E_HOME) and so is the Bin (TW_E2E_BIN): the app never sees the real
// ~/Documents or the real Bin, and this script checks the real example folder is untouched.
//
//   (A) REMOVE — a vault of one's own open in window 1, The Saturday market open in window 2. Removal
//       never closes a window: ⋯ on the Example vault header › Remove example vault… says "Close the
//       example talks first: The Saturday market." and Remove is not live. Window 2 closed by the person:
//       the confirmation shows the real folder and "5 talks". A window opened on Lightning round between
//       that look and Remove: Remove does nothing and says so, the folder stays. That window closed too:
//       Remove moves the folder (with a change made on disk) to the stand-in Bin, and window 1 shows the
//       flash, no Example section and no example talk in Recent. Progress in app config is unchanged.
//   (B) AFTER — Settings → Get started says the example vault was removed, with Show the example vault
//       again and Open the Guide; the palette's "get started" lists the three drawn rows.
//   (C) RESTORE — Show the example vault again: the five talks are back, the Guide opens, and the
//       chapters show the earlier counts.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-example-vault-removal.mjs
import { _electron as electron } from 'playwright'
import { openSettingsWindow, closeSettingsWindow } from './lib/settings-window.mjs'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode, openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = process.env.TW_E2E_SHOTS || ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, name) }) : Promise.resolve())

const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const TITLES = ['The Saturday market', 'Garden notes', 'Walking the old town', 'Lightning round', 'Harvest supper (draft)']
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-example-removal-')))
const realExample = join(homedir(), 'Documents', 'TalkWeaver', 'Example vault')
const realExampleBefore = existsSync(realExample) ? lstatSync(realExample).mtimeMs : null
const LEARN = { version: 1, ran: ['promote-heading', 'demote-heading'], opened: ['Write the outline'], finished: {}, read: [] }

function profile(name) {
  const dir = join(tempRoot, name)
  const home = join(dir, 'home')
  const userData = join(dir, 'userData')
  const bin = join(dir, 'Bin')
  const personal = join(dir, 'own', 'Personal')
  mkdirSync(join(home, 'Documents'), { recursive: true })
  writeFileSync(join(home, 'Documents', 'Letter.txt'), 'mine')
  mkdirSync(userData, { recursive: true })
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(personal, 'alpha-talk'), { recursive: true })
  writeFileSync(join(personal, 'alpha-talk', 'alpha-talk-outline.md'), '---\ntitle: Alpha Talk\noutline_version: 2\n---\n\n## Section\n\n### Alpha slide {id=a1}\n\nBody.\n')
  writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: personal, guideLearn: LEARN, guideProgress: { exampleTalkOpened: true } }, null, 2))
  return { home, userData, bin, root: join(home, 'Documents', 'TalkWeaver', 'Example vault') }
}
const config = (p) => JSON.parse(readFileSync(join(p.userData, 'config.json'), 'utf8'))

async function launch(p) {
  const app = await electron.launch({ args: ['.', '--user-data-dir=' + p.userData], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_E2E_HOME: p.home, TW_E2E_BIN: p.bin } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })
  return { app, page }
}
// Thumbnail capture also creates BrowserWindows. Only a renderer editor window can be
// the requested talk; retain the existing deadline and all subsequent content checks.
function nextTalkWindow(app) {
  return app.waitForEvent('window', {
    timeout: 15000,
    predicate: async (candidate) => {
      try {
        await candidate.waitForURL(/\/renderer\/index\.html(?:[?#]|$)/, { timeout: 15000 })
        return true
      } catch { return false }
    },
  })
}
const exampleHeader = (page) => page.locator('[data-vault-header][data-vault-example="true"]')
async function waitFor(page, fn, arg, timeout = 15000) {
  return page.waitForFunction(fn, arg, { timeout }).then(() => true).catch(() => false)
}

/** Window 1 on Alpha Talk with the example listed; window 2 on The Saturday market. */
async function setUp(p) {
  const { app, page } = await launch(p)
  await ensureTalksMode(page)
  await openTalkByTitle(page, 'Alpha Talk')
  const opened = await page.evaluate(() => window.tw.vault.openExample())
  if (!opened.ok) throw new Error(`open example: ${opened.message}`)
  await exampleHeader(page).waitFor({ state: 'visible', timeout: 15000 })
  await waitFor(page, (want) => want.every((t) => document.querySelector(`[data-talk-title="${CSS.escape(t)}"]`)), TITLES)
  const outline = join(realpathSync(p.root), 'the-saturday-market', 'the-saturday-market-outline.md')
  const second = nextTalkWindow(app)
  await page.evaluate((outlinePath) => window.tw.windows.openInNewWindow({ kind: 'talk', outlinePath }), outline)
  const win2 = await second
  await win2.waitForLoadState('domcontentloaded')
  await win2.waitForSelector('.cm-content', { timeout: 15000 }).catch(async (error) => { console.error('new-window diagnostic', JSON.stringify({ received: win2.url(), windows: app.windows().map((w) => w.url()) })); throw error })
  await waitFor(win2, () => document.title.includes('The Saturday market'))
  return { app, page, win2, outline }
}
/** Open an example talk in a window of its own; returns its page. */
async function openExampleWindow(app, page, root, slug, title) {
  const outlinePath = join(realpathSync(root), slug, `${slug}-outline.md`)
  const next = nextTalkWindow(app)
  await page.evaluate((path) => window.tw.windows.openInNewWindow({ kind: 'talk', outlinePath: path }), outlinePath)
  const win = await next
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('.cm-content', { timeout: 15000 })
  await waitFor(win, (t) => document.title.includes(t), title)
  return win
}
/** Close a window the way the person would (its own close route); nothing typed, so it closes at once. */
async function closeWindow(app, win, title) {
  const closed = new Promise((done) => win.once('close', () => done(true)))
  await app.evaluate(({ BrowserWindow }, t) => { for (const w of BrowserWindow.getAllWindows()) if (w.getTitle().includes(t)) w.close() }, title)
  return Promise.race([closed, new Promise((done) => setTimeout(() => done(false), 15000))])
}
async function openConfirmFromMenu(page, { ready = true } = {}) {
  await exampleHeader(page).locator('.tl-vmore').click()
  const item = page.getByRole('menuitem', { name: /Remove example vault…/ })
  if (await item.count()) await item.first().click()
  else await page.locator('text=Remove example vault…').first().click()
  await page.locator('[data-remove-example]').waitFor({ state: 'visible', timeout: 5000 })
  if (ready) await page.waitForSelector('[data-rx-confirm]:not([disabled])', { timeout: 8000 })
  else await page.waitForSelector('[data-rx-error]', { timeout: 8000 })
}
async function cancelConfirm(page) {
  await page.locator('[data-rx-cancel]').click()
  await page.locator('[data-remove-example]').waitFor({ state: 'detached', timeout: 5000 })
}

await ensureFreshBuild(REPO)
let exitCode = 0
try {
  // ── (A) remove from the ⋯ menu ──
  const a = profile('remove')
  const { app, page, win2, outline } = await setUp(a)
  try {
    await page.locator('[data-guide-button]').click().catch(() => {})
    await page.waitForSelector('[data-guide-chapters]', { timeout: 8000 }).catch(() => {})
    const statusBefore = await page.locator('[data-chapter-status]').allInnerTexts()
    await shot(page, '12-state-17-before.png')

    // An example talk is open in window 2: no token, one sentence, Remove not live; nothing closes.
    await openConfirmFromMenu(page, { ready: false })
    const refusedText = await page.locator('[data-rx-error]').innerText()
    record('an example window open: the confirmation says to close it first, naming it', refusedText.trim() === 'Close the example talks first: The Saturday market.', JSON.stringify(refusedText))
    record('…and Remove is not live', await page.locator('[data-rx-confirm]').isDisabled())
    await shot(page, '12-open-window-refused.png')
    await cancelConfirm(page)
    record('…and removal closed no window', !win2.isClosed() && existsSync(a.root))
    record('the person closes window 2', await closeWindow(app, win2, 'The Saturday market'))

    await openConfirmFromMenu(page)
    const sheet = await page.locator('[data-remove-example]').innerText()
    record('⋯ › Remove example vault… opens the confirmation with the real folder and count',
      sheet.includes('Remove the example vault?') && sheet.includes('~/Documents/TalkWeaver/Example vault') && sheet.includes('5 talks, with any change you made to them'), JSON.stringify(sheet.slice(0, 160)))
    record('the confirmation promises no closing', sheet.includes('Nothing is closed for you: close any window showing an example talk first') && !sheet.includes('closes first'))
    const groups = await page.locator('[data-rx-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-rx-group')))
    record('three bounded lists: Moved to the Bin, Taken off the Talks panel, Kept', groups.join(',') === 'bin,off,kept')
    await shot(page, '12-state-15-confirm.png')

    // A window opened on an example talk after that look and before Remove: Remove does nothing.
    const win3 = await openExampleWindow(app, page, a.root, 'lightning-round', 'Lightning round')
    await page.bringToFront()
    await page.locator('[data-rx-confirm]').click()
    const aborted = await waitFor(page, () => document.querySelector('[data-rx-error]')?.textContent?.trim() === 'Close the example talks first: Lightning round.', null, 8000)
    record('a window opened between the look and Remove: Remove says to close it first', aborted)
    record('…nothing binned, still listed, the window still open', existsSync(a.root) && readdirSync(a.bin).length === 0 && (await exampleHeader(page).count()) === 1 && config(a).exampleVaultRemoved !== true && !win3.isClosed())
    await cancelConfirm(page)
    record('the person closes that window too', await closeWindow(app, win3, 'Lightning round'))

    // A change made to an example talk (on disk, no window open) goes to the Bin with the folder.
    writeFileSync(outline, readFileSync(outline, 'utf8') + '\nChanged before removal.\n')
    await openConfirmFromMenu(page)
    await page.locator('[data-rx-confirm]').click()
    const gone = await waitFor(page, () => !document.querySelector('[data-vault-header][data-vault-example="true"]'))
    record('the Example vault section leaves the Talks panel', gone)
    const flash = await waitFor(page, () => document.body.innerText.includes('Example vault moved to the Bin. Settings → Get started brings it back.'), null, 6000)
    record('window 1 shows the flash', flash)
    await shot(page, '12-state-16-flash.png')
    const recent = await page.locator('.tl-recent-row').allInnerTexts()
    record('no example talk in Recent', !recent.some((t) => TITLES.some((title) => t.includes(title))), JSON.stringify(recent))
    record('the folder left Documents › TalkWeaver for the stand-in Bin', !existsSync(a.root) && readdirSync(a.bin).length === 1)
    const binned = join(a.bin, readdirSync(a.bin)[0] ?? 'x', 'the-saturday-market', 'the-saturday-market-outline.md')
    record('the change made to an example talk went to the Bin with the folder', existsSync(binned) && readFileSync(binned, 'utf8').includes('Changed before removal.'))
    const windowsAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => `${w.getTitle()}|${w.webContents.getURL().split('?')[0].split('/').pop()}`))
    record('the editor windows are as before the removal (it opened none)', windowsAfter.filter((w) => w.endsWith('|index.html')).length === 1, JSON.stringify(windowsAfter))
    const c = config(a)
    record('app config: the example is off the list, the record is set, progress is as it was',
      !(c.vaults ?? []).some((v) => v.example) && c.exampleVaultRemoved === true && JSON.stringify(c.guideLearn) === JSON.stringify(LEARN) && c.guideProgress?.exampleTalkOpened === true)
    record('the person’s own vault and file are untouched', (c.vaults ?? []).length === 1 && readFileSync(join(a.home, 'Documents', 'Letter.txt'), 'utf8') === 'mine')
    record('the Guide’s Remove link is gone', (await page.locator('[data-guide-remove-example]').count()) === 0)

    // ── (B) Settings and the palette ──
    let settings = await openSettingsWindow(app, page, 'get-started')
    await settings.waitForSelector('[data-setting="get-started"]', { timeout: 5000 })
    const row = await settings.locator('[data-setting="get-started"]').innerText()
    record('Settings → Get started: “The example vault was removed.”, Show the example vault again, Open the Guide',
      row.includes('The example vault was removed.') && row.indexOf('Show the example vault again') >= 0 && row.indexOf('Show the example vault again') < row.indexOf('Open the Guide'), JSON.stringify(row))
    await shot(settings, '12-state-16-settings.png')
    await closeSettingsWindow(app)
    await page.waitForTimeout(300)
    await page.locator('.cm-content').first().click()
    await page.keyboard.press('Meta+Shift+P')
    await page.waitForTimeout(250)
    await page.keyboard.type('get started')
    await page.waitForTimeout(400)
    const rows = await page.locator('[data-command-menu] .command-menu-item .command-menu-title').allInnerTexts()
    record('the palette’s “get started” rows are the three drawn, in order',
      JSON.stringify(rows) === JSON.stringify(['Get started: show the example vault again', 'Get started: open the Guide', 'Get started: show the Guide button']), JSON.stringify(rows))
    await shot(page, '12-state-16b-palette.png')
    await page.keyboard.press('Escape')

    // ── (C) restore from Settings ──
    // The counts as they stand now (running the palette above ticks a Set up TalkWeaver row).
    await page.evaluate(() => window.dispatchEvent(new Event('tw-guide-open')))
    await page.waitForSelector('[data-guide-chapters]', { timeout: 8000 }).catch(() => {})
    const statusBeforeRestore = await page.locator('[data-chapter-status]').allInnerTexts()
    const learnBeforeRestore = JSON.stringify(config(a).guideLearn)
    record('progress survived removal (the chapters read as before it, plus what was run since)', statusBefore.length === 10 && statusBeforeRestore[0] === statusBefore[0], `${statusBefore[0]} → ${statusBeforeRestore[0]}`)
    await ensureTalksMode(page)
    settings = await openSettingsWindow(app, page, 'get-started')
    await settings.locator('[data-restore-example]').click()
    await closeSettingsWindow(app)
    const listedAgain = await exampleHeader(page).waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)
    if (!listedAgain) {
      const toasts = await page.locator('.toast, [role="status"], [role="alert"]').allInnerTexts().catch(() => [])
      throw new Error(`restore did not list the example again; on screen: ${JSON.stringify(toasts)}; folder ${existsSync(a.root)}`)
    }
    const back = await waitFor(page, (want) => want.every((t) => document.querySelector(`[data-talk-title="${CSS.escape(t)}"]`)), TITLES)
    record('Show the example vault again: the five talks are back as the example vault', back && existsSync(join(a.root, '.talkweaver', 'vault.json')))
    record('a fresh copy: the changed line is not in it', !readFileSync(join(a.root, 'the-saturday-market', 'the-saturday-market-outline.md'), 'utf8').includes('Changed before removal.'))
    await page.waitForSelector('[data-guide-chapters]', { timeout: 8000 }).catch(() => {})
    const statusAfter = await page.locator('[data-chapter-status]').allInnerTexts()
    record('the Guide opens with the earlier counts', statusAfter.length === 10 && JSON.stringify(statusAfter) === JSON.stringify(statusBeforeRestore), `${JSON.stringify(statusBeforeRestore)} → ${JSON.stringify(statusAfter)}`)
    record('app config: the record is cleared, progress as it was', config(a).exampleVaultRemoved === false && JSON.stringify(config(a).guideLearn) === learnBeforeRestore)
    await shot(page, '12-restored.png')
  } finally {
    await app.close()
  }

  const realAfter = existsSync(realExample) ? lstatSync(realExample).mtimeMs : null
  record('the real ~/Documents example folder is untouched', realAfter === realExampleBefore)
} catch (e) {
  record('removal harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) exitCode = 1
  rmSync(tempRoot, { recursive: true, force: true })
}
process.exit(exitCode)
