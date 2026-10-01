// Real-Electron harness for several vaults in the Talks panel (several-vaults ticket 03).
// Two vault folders: the second is added through the app's own "add vault" call, then a talk is
// opened from each, edited and saved in its own vault; a vault is closed and reopened.
//
//   (A) ADD     — the panel gains a section per vault; a folder inside a vault and a folder already
//                 added are refused with a message that shows no folder path.
//   (B) OPEN    — a talk from each vault opens in the editor; typing saves into that talk's own vault
//                 and touches nothing in the other; the talk builds against its own vault.
//   (B2) PRESENT / HANDOUT — the second vault's talk opens in the presenter with its own slides, and its
//                 handout is built beside that talk in its own vault from its own text.
//   (C) CLOSE   — closing a vault hides its talks everywhere (list, Recent) and greys its header;
//                 reopening brings them back. The last open vault cannot be closed.
//   (D) NO PATH — no folder path appears anywhere in the panel.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-two-vaults.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode, openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const outline = (title, slide) => ['---', `title: ${title}`, 'outline_version: 2', '---', '', '## Section', '',
  `### ${slide} {id=${slide.toLowerCase().replace(/\W+/g, '')}}`, '', 'Body one.', ''].join('\n')

// realpath: the registry stores a vault's resolved folder, and /var is a link to /private/var here
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-two-vaults-')))
const vaultA = join(tempRoot, 'Personal')
const vaultB = join(tempRoot, 'Workshops')
const userDataDir = join(tempRoot, 'userData')
const A_PATH = join(vaultA, 'alpha-talk', 'alpha-talk-outline.md')
const B_PATH = join(vaultB, 'topic', 'beta-talk', 'beta-talk-outline.md')
for (const [path, title, slide] of [[A_PATH, 'Alpha Talk', 'Alpha slide'], [B_PATH, 'Beta Talk', 'Beta slide']]) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, outline(title, slide))
}
mkdirSync(join(vaultA, 'nested-folder'), { recursive: true })
mkdirSync(userDataDir, { recursive: true })
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: vaultA }, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userDataDir], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

const headers = () => page.locator('[data-vault-header]')
const header = (name) => page.locator(`[data-vault-header][data-vault-name="${name}"]`)
const panelText = () => page.locator('aside.talk-list').innerText()
const hasTalk = async (title) => (await page.locator(`.tl-tree [data-talk-title="${title}"]`).count()) > 0
const recentNames = () => page.locator('.tl-recent-name').allInnerTexts()

async function typeInto(lineText, marker) {
  await page.locator('.cm-content .cm-line', { hasText: lineText }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(marker)
  await page.waitForTimeout(2600) // > 1500 ms autosave debounce
}

try {
  // ── (A) ADD ──
  await page.locator('aside.talk-list .tl-tree').first().waitFor({ state: 'visible', timeout: 10000 })
  await headers().first().waitFor({ state: 'attached', timeout: 10000 })
  record('one vault at first: one section header named after the folder', await headers().count() === 1 && await header('Personal').count() === 1)

  const inside = await page.evaluate((p) => window.tw.vault.add(p), join(vaultA, 'nested-folder'))
  record('a folder inside a vault is refused with a message', inside && inside.ok === false && /inside another vault/.test(inside.message), JSON.stringify(inside))
  const dup = await page.evaluate((p) => window.tw.vault.add(p), vaultA)
  record('a folder that is already a vault is refused', dup && dup.ok === false && /already a vault/.test(dup.message), JSON.stringify(dup))
  record('refusal messages carry no folder path', ![inside, dup].some((r) => r && r.message.includes(tempRoot)))

  const added = await page.evaluate((p) => window.tw.vault.add(p), vaultB)
  record('adding a second folder returns the new vault', added && added.ok === true && added.vault.name === 'Workshops' && added.vault.service === 'Local', JSON.stringify(added && added.vault && { name: added.vault.name, service: added.vault.service }))
  await header('Workshops').waitFor({ state: 'attached', timeout: 8000 })
  record('the panel now has a section per vault', await headers().count() === 2)
  record('the second vault has a different badge colour and its initial', await page.evaluate(() => {
    const badges = [...document.querySelectorAll('[data-vault-header] .tl-vb')]
    return badges.length === 2 && badges[0].style.getPropertyValue('--vc') !== badges[1].style.getPropertyValue('--vc') && badges[1].textContent === 'W'
  }))
  record('each header names its service on the second line', (await panelText()).includes('Local'))

  // ── (B) OPEN a talk from each vault ──
  await openTalkByTitle(page, 'Alpha Talk')
  record('a talk of the first vault opens', (await page.locator('.cm-content').first().innerText()).includes('Alpha slide'))
  await typeInto('Body one.', ' ALPHA-EDIT')
  record('typing saves into the first vault', readFileSync(A_PATH, 'utf8').includes('ALPHA-EDIT'))

  await openTalkByTitle(page, 'Beta Talk')
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('Beta slide'), null, { timeout: 8000 })
  record('a talk of the second vault opens', (await page.locator('.cm-content').first().innerText()).includes('Beta slide'))
  await typeInto('Body one.', ' BETA-EDIT')
  const betaText = readFileSync(B_PATH, 'utf8')
  record('typing saves into the second vault, not the first', betaText.includes('BETA-EDIT') && !readFileSync(A_PATH, 'utf8').includes('BETA-EDIT'))
  const built = await page.evaluate(({ p, text }) => window.tw.talk.build(p, text).catch((e) => ({ success: false, error: String(e) })), { p: B_PATH, text: betaText })
  record('the second vault talk builds against its own vault', !!built && built.success !== false, JSON.stringify(built).slice(0, 160))
  // ── (B2) present and hand out the second vault's talk ──
  const winPromise = app.waitForEvent('window')
  const presenting = page.evaluate(({ p, c }) => window.tw.talk.present(p, c, 'presenter'), { p: B_PATH, c: betaText })
  const pres = await winPromise
  await pres.waitForLoadState('domcontentloaded')
  const presented = await presenting
  await pres.waitForFunction(() => document.body?.textContent?.includes('Beta slide'), null, { timeout: 10000 }).catch(() => {})
  const presText = await pres.evaluate(() => (document.body?.textContent ?? '') + ' ' + (document.body?.innerHTML ?? ''))
  record('present opens the second vault talk with its own slides', !!presented?.success && pres.url().includes(dirname(B_PATH)) && presText.includes('Beta slide') && !presText.includes('Alpha slide'), JSON.stringify({ presented, url: pres.url(), len: presText.length, alpha: presText.includes('Alpha slide') }))
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && win.webContents.getURL().includes('-present.html')) win.destroy()
  })
  const handout = await page.evaluate(({ p, c }) => window.tw.talk.exportHandout(p, c), { p: B_PATH, c: betaText })
  const handoutHtml = handout?.path && existsSync(handout.path) ? readFileSync(handout.path, 'utf8') : ''
  record('the handout is built beside the second vault talk from its own text',
    !!handout?.success && handout.path.startsWith(dirname(B_PATH)) && handoutHtml.includes('Beta slide') && !handoutHtml.includes('Alpha slide'), JSON.stringify(handout))
  await ensureTalksMode(page) // the first edit moved the sidebar to the slide outline
  await page.waitForTimeout(600)
  const names = await recentNames()
  record('Recent lists talks across both vaults, each with a vault badge', names.includes('Alpha Talk') && names.includes('Beta Talk') && await page.locator('.tl-recent-row .tl-vb').count() >= 2, JSON.stringify(names))

  // ── (D) no folder path anywhere in the panel ──
  const text = await panelText()
  record('no folder path appears in the panel', !text.includes(tempRoot) && !text.includes(vaultA) && !text.includes(vaultB))

  // ── (C) CLOSE and reopen the second vault ──
  await ensureTalksMode(page)
  await page.locator('[data-vault-header][data-vault-name="Workshops"] .tl-vmore').click()
  await page.getByRole('menuitem', { name: 'Close vault' }).click()
  await page.waitForFunction(() => document.querySelector('[data-vault-header][data-vault-name="Workshops"]')?.getAttribute('data-vault-open') === 'false', null, { timeout: 8000 })
  await page.waitForTimeout(300)
  record('closing a vault greys its header and hides its talks', !(await hasTalk('Beta Talk')) && (await panelText()).includes('Closed'))
  record('closing a vault takes its talks out of Recent', !(await recentNames()).includes('Beta Talk'))
  record('the talk that was open from that vault is put away', await page.locator('.cm-content').count() === 0 || !(await page.locator('.cm-content').first().innerText()).includes('Beta slide'))
  record('closing changed nothing in the folder', readFileSync(B_PATH, 'utf8') === betaText)
  await header('Workshops').click()
  await page.waitForFunction(() => document.querySelector('[data-vault-header][data-vault-name="Workshops"]')?.getAttribute('data-vault-open') === 'true', null, { timeout: 8000 })
  await page.waitForTimeout(600)
  const back = await page.evaluate(() => window.tw.vault.list())
  record('reopening the vault brings it back', back.length === 2 && back.every((v) => v.open))
  await openTalkByTitle(page, 'Beta Talk')
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('BETA-EDIT'), null, { timeout: 8000 }).catch(() => {})
  record('its talks open again, with the saved edit', (await page.locator('.cm-content').first().innerText()).includes('BETA-EDIT'))

  // The first vault cannot be the only open vault closed.
  await page.evaluate((id) => window.tw.vault.setOpen(id, false), back.find((v) => v.name === 'Workshops').id)
  await page.waitForTimeout(500)
  const last = await page.evaluate((id) => window.tw.vault.setOpen(id, false), back.find((v) => v.name === 'Personal').id)
  record('the last open vault cannot be closed', last && last.ok === false && last.reason === 'last-open', JSON.stringify(last))
} catch (e) {
  record('two-vaults harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== TWO-VAULTS SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length ? 1 : 0)
}
