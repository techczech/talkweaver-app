// e2e for Open example vault (onboarding ticket 06; locked drawing states 01 and 03). Real Electron,
// headless (TW_E2E=1). The home folder is a stand-in under the system temp folder (TW_E2E_HOME): the
// app never sees the real ~/Documents, and this script checks the real one is untouched.
//
//   (A) FIRST LAUNCH — a fresh profile shows Choose your Vault with the example card under "or look
//       around first"; Open example vault writes the five talks to <home>/Documents/TalkWeaver/
//       Example vault, lists them under the Example vault section (Example pill, "Removable · local
//       folder"), and opens the start talk, The Saturday market.
//   (B) SECOND LAUNCH — no byte or modified time changes in the example folder; the vault is still
//       listed and no setup screen shows.
//   (C) ADD VAULT… — a profile with a vault of its own: Add vault… offers the example vault; opening it
//       puts both vaults side by side and closes the sheet.
//   (D) IN THE WAY — a foreign folder at the path: one sentence on the setup screen, the folder
//       unchanged, still on the setup screen.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-example-vault.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
// Screenshots only when asked for (TW_E2E_SHOTS=<folder>), for the screenshot pass.
const SHOTS = process.env.TW_E2E_SHOTS || ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, name) }) : Promise.resolve())

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const TITLES = ['The Saturday market', 'Garden notes', 'Walking the old town', 'Lightning round', 'Harvest supper (draft)']
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-example-vault-')))
const realExample = join(homedir(), 'Documents', 'TalkWeaver', 'Example vault')
const realExampleBefore = existsSync(realExample) ? lstatSync(realExample).mtimeMs : null

function snapshot(dir) {
  const out = {}
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(p)
      if (st.isDirectory()) { out[r] = `dir:${st.mtimeMs}`; walk(p, r) } else out[r] = `${st.size}:${st.mtimeMs}:${readFileSync(p).toString('base64')}`
    }
  }
  walk(dir, '')
  return out
}

function profile(name, { vaults = [] } = {}) {
  const dir = join(tempRoot, name)
  const home = join(dir, 'home')
  const userData = join(dir, 'userData')
  mkdirSync(join(home, 'Documents'), { recursive: true })
  mkdirSync(userData, { recursive: true })
  const config = {}
  if (vaults.length) config.vaultRoot = vaults[0]
  writeFileSync(join(userData, 'config.json'), JSON.stringify(config, null, 2))
  return { home, userData, root: join(home, 'Documents', 'TalkWeaver', 'Example vault') }
}

async function launch(p) {
  const app = await electron.launch({ args: ['.', '--user-data-dir=' + p.userData], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_E2E_HOME: p.home } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })
  return { app, page }
}
const titlesListed = (page) => page.$$eval('[data-talk-title]', (els) => [...new Set(els.map((e) => e.getAttribute('data-talk-title')))])
async function waitForTitles(page, titles, timeout = 15000) {
  await page.waitForFunction((want) => {
    const have = new Set([...document.querySelectorAll('[data-talk-title]')].map((e) => e.getAttribute('data-talk-title')))
    return want.every((t) => have.has(t))
  }, titles, { timeout }).catch(() => {})
}

await ensureFreshBuild(REPO)
let exitCode = 0
try {
  // ── (A) first launch ──
  const a = profile('first')
  let { app, page } = await launch(a)
  try {
    const card = page.locator('[data-example-card]')
    await card.waitFor({ state: 'visible', timeout: 10000 })
    const setupText = await page.locator('.vault-setup-card').innerText()
    record('first launch shows Choose Vault Folder and, under “or look around first”, the example card',
      setupText.includes('Choose Vault Folder') && /or look around first/i.test(setupText) && setupText.includes('Open the example vault') && setupText.includes('~/Documents/TalkWeaver/Example vault · 5 talks'))
    await shot(page, '06-first-launch.png')
    await page.locator('[data-open-example]').click()
    await page.locator('[data-vault-header][data-vault-example="true"]').waitFor({ state: 'visible', timeout: 15000 })
    await ensureTalksMode(page)
    await waitForTitles(page, TITLES)
    const listed = await titlesListed(page)
    record('the five talks are listed', TITLES.every((t) => listed.includes(t)), JSON.stringify(listed))
    const headerText = await page.locator('[data-vault-header][data-vault-example="true"]').innerText()
    record('the vault header reads Example vault, with the Example pill and “Removable · local folder”',
      headerText.includes('Example vault') && headerText.includes('Example') && headerText.includes('Removable · local folder'), JSON.stringify(headerText))
    await page.waitForFunction(() => document.title.includes('The Saturday market'), null, { timeout: 15000 }).catch(() => {})
    record('the start talk, The Saturday market, is open', (await page.title()).includes('The Saturday market'), await page.title())
    const files = existsSync(a.root) ? readdirSync(a.root).sort() : []
    record('the folder is written in the stand-in home', files.includes('the-saturday-market') && files.includes('.talkweaver') && files.length === readdirSync(join(REPO, 'resources', 'example-vault')).filter((n) => n !== '.DS_Store').length + 1, JSON.stringify(files))
    const homeTop = readdirSync(a.home).sort()
    const docs = readdirSync(join(a.home, 'Documents')).sort()
    record('nothing else in the stand-in home', JSON.stringify(homeTop) === '["Documents"]' && JSON.stringify(docs) === '["TalkWeaver"]' && JSON.stringify(readdirSync(join(a.home, 'Documents', 'TalkWeaver'))) === '["Example vault"]')
    const vaults = await page.evaluate(() => window.tw.vault.list())
    record('the list holds one vault, flagged as the example', vaults.length === 1 && vaults[0].example === true && vaults[0].name === 'Example vault' && vaults[0].color === '#0f766e')
    await shot(page, '06-example-vault-open.png')
  } finally {
    await app.close()
  }

  // ── (B) second launch ──
  const before = snapshot(a.root)
  ;({ app, page } = await launch(a))
  try {
    await page.locator('[data-vault-header][data-vault-example="true"]').waitFor({ state: 'visible', timeout: 15000 })
    record('second launch: no setup screen, the example vault is listed', await page.locator('[data-example-card]').count() === 0)
    await page.waitForTimeout(2500)
  } finally {
    await app.close()
  }
  const after = snapshot(a.root)
  const diff = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k])
  record('second launch changes no byte or modified time in the example folder', diff.length === 0, diff.join(', '))

  // ── (C) Add vault… with a vault of one's own ──
  const personal = join(tempRoot, 'own', 'Personal')
  mkdirSync(join(personal, 'alpha-talk'), { recursive: true })
  writeFileSync(join(personal, 'alpha-talk', 'alpha-talk-outline.md'), '---\ntitle: Alpha Talk\noutline_version: 2\n---\n\n## Section\n\n### Alpha slide {id=a1}\n\nBody.\n')
  const c = profile('own', { vaults: [personal] })
  ;({ app, page } = await launch(c))
  try {
    await ensureTalksMode(page)
    await waitForTitles(page, ['Alpha Talk'])
    await page.locator('[data-add-vault]').click()
    const sheet = page.locator('[data-vault-sheet="add"]')
    await sheet.waitFor({ state: 'visible', timeout: 8000 })
    record('Add vault… offers a folder and the example vault', (await sheet.locator('[data-choose-folder]').count()) === 1 && (await sheet.locator('[data-open-example]').count()) === 1)
    await shot(page, '06-add-vault-sheet.png')
    await sheet.locator('[data-open-example]').click()
    await page.locator('[data-vault-header][data-vault-example="true"]').waitFor({ state: 'visible', timeout: 15000 })
    await waitForTitles(page, [...TITLES, 'Alpha Talk'])
    const listed = await titlesListed(page)
    record('both vaults side by side: Personal and the example vault', listed.includes('Alpha Talk') && TITLES.every((t) => listed.includes(t)), JSON.stringify(listed))
    record('the sheet closed', await page.locator('[data-vault-sheet="add"]').count() === 0)
    const vaults = await page.evaluate(() => window.tw.vault.list())
    record('Personal is still the first vault; the example is added after it', vaults.length === 2 && vaults[0].root === realpathSync(personal) && vaults[1].example === true)
    await shot(page, '06-two-vaults.png')
    // Add vault… again: the example is listed, so the picker opens at once (cancelled here).
    await app.evaluate(({ dialog }) => { const original = dialog.showOpenDialog; dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: true, filePaths: [] } } })
    await page.locator('[data-add-vault]').click()
    await page.waitForTimeout(600)
    record('with the example listed, Add vault… goes straight to the folder picker', await page.locator('[data-vault-sheet="add"]').count() === 0)
  } finally {
    await app.close()
  }

  // ── (D) a foreign folder in the way ──
  const d = profile('foreign')
  mkdirSync(d.root, { recursive: true })
  writeFileSync(join(d.root, 'my-notes.md'), 'mine')
  const foreignBefore = snapshot(join(d.home, 'Documents'))
  ;({ app, page } = await launch(d))
  try {
    await page.locator('[data-open-example]').waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('[data-open-example]').click()
    const msg = page.locator('[data-example-message]')
    await msg.waitFor({ state: 'visible', timeout: 8000 })
    record('a folder in the way: one sentence, still on the setup screen', (await msg.innerText()).includes('is already in Documents › TalkWeaver') && await page.locator('[data-example-card]').count() === 1)
    await shot(page, '06-in-the-way.png')
  } finally {
    await app.close()
  }
  const foreignAfter = snapshot(join(d.home, 'Documents'))
  record('the folder in the way is unchanged', JSON.stringify(foreignBefore) === JSON.stringify(foreignAfter))

  const realExampleAfter = existsSync(realExample) ? lstatSync(realExample).mtimeMs : null
  record('the real ~/Documents/TalkWeaver/Example vault is untouched', realExampleBefore === realExampleAfter)
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length || exitCode ? 1 : 0)
