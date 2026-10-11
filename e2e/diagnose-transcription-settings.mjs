// Settings → Transcription in the real app (spec docs/plans/cloudflare-setup-in-app, D16; ticket 08):
// the one status row through the window a person uses, on a throwaway user-data folder and vault.
// Nothing configured → "Not set up — optional" and Transcribe says where to set it up; Set-up steps
// and Copy instructions for your agent; fixture paths typed in → Ready; a wrong ffmpeg path, or a
// bare name such as `ffmpeg`, → the one missing thing; cleared again → Ready. No Python runs and no installed app or data is touched.
//
// TW_SHOTS_DIR=<dir> saves a picture of the section in each state.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'

const root = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tw-transcription-settings-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
mkdirSync(userData, { recursive: true })
mkdirSync(join(vault, 'probe'), { recursive: true })
writeFileSync(join(vault, 'probe', 'probe-outline.md'), ['---', 'title: Probe', 'outline_version: 2', '---', '', '### One', '{id=one}', ''].join('\n'))
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }))
// A fixture environment and script: files only, nothing runs.
const venv = join(userData, 'transcription', 'venv')
const python = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
mkdirSync(join(python, '..'), { recursive: true })
writeFileSync(python, '')
writeFileSync(join(venv, 'pyvenv.cfg'), 'version = 3.12.4\n')
const script = join(scratch, 'parakeet_to_srt.py')
writeFileSync(script, '# fixture')
const shots = process.env.TW_SHOTS_DIR ? resolve(process.env.TW_SHOTS_DIR) : null
if (shots) mkdirSync(shots, { recursive: true })

const CHECKS = [
  'the app started on the throwaway folder',
  'nothing configured: the row reads "Not set up — optional" at its right-hand edge, in a bordered row',
  'Transcribe with nothing configured says where to set it up, and the window goes on working',
  'Set-up steps opens the steps; Copy instructions for your agent copies a prompt pointing at the shipped SETUP.md and the user-data folder',
  'the Python and script paths saved: the row reads Ready with the Python version, script found, ffmpeg found',
  'a wrong ffmpeg path, or a bare name such as "ffmpeg" (never looked up on PATH): "ffmpeg not found"; cleared: Ready again',
  'the Transcription section names no skill and no path from Dominik\'s machines',
]
const ledger = createCheckLedger(CHECKS)
const record = (index, ok, detail) => ledger.record(CHECKS[index], Boolean(ok), detail)

let app
let exitCode = 1
try {
  await ensureFreshBuild(root)
  const env = { TW_E2E: '1' }
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'PATHEXT', 'ComSpec']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env })
  if (process.env.TW_E2E_SHOW !== '1') {
    await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const hide = (win) => { win.setPosition(-20000, -20000); win.hide() }
      BrowserWindow.getAllWindows().forEach(hide)
      electronApp.on('browser-window-created', (_event, win) => hide(win))
    })
  }
  const page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.tw?.settings?.transcriptionStatus))
  const where = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const onThrowaway = realpathSync(where) === realpathSync(userData)
  record(0, onThrowaway)
  if (!onThrowaway) throw new Error('not on the throwaway user-data folder')

  const SETTINGS = '[aria-label="Settings"]'
  if (await page.locator(SETTINGS).count() === 0) await page.keyboard.press('ControlOrMeta+,')
  const settings = page.locator(SETTINGS).first()
  const part = (name) => settings.locator(`[data-transcription="${name}"]`)
  await part('status').waitFor({ state: 'visible' })
  await part('status').scrollIntoViewIfNeeded()
  const stateIs = (state) => page.waitForFunction((wanted) => document.querySelector('[data-transcription="status"]')?.getAttribute('data-state') === wanted, state, { timeout: 20_000 })
  const shot = async (name) => { if (shots) await settings.locator('[data-settings-section="transcription"]').screenshot({ path: join(shots, `${name}.png`) }).catch(() => {}) }
  const label = async () => (await part('label').innerText()).trim()

  await stateIs('not-set-up')
  const border = await part('features').evaluate((el) => getComputedStyle(el).borderTopStyle)
  record(1, (await label()) === 'Not set up — optional' && border === 'solid', `label=${await label()} border=${border}`)
  await shot('01-not-set-up')

  const refused = await page.evaluate(() => window.tw.transcript.run('probe', 'run-0001'))
  const stillWorks = await page.evaluate(() => window.tw.settings.getTranscription().then(() => true))
  record(2, !refused.ok && refused.error === 'Transcription is not set up. It is optional: Settings → Transcription has the set-up steps.' && stillWorks, refused.error)

  await part('steps-toggle').click()
  await part('steps').waitFor({ state: 'visible' })
  await shot('02-set-up-steps')
  const prompt = await page.evaluate(() => window.tw.settings.transcriptionAgentPrompt())
  await page.bringToFront().catch(() => {})
  await part('copy-prompt').click()
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => '')
  const stepsShown = (await part('steps').innerText()).includes('Copy instructions for your agent')
  record(3, stepsShown && prompt.includes(join('resources', 'agent-setup', 'transcription', 'SETUP.md')) && [userData, realpathSync(userData)].some((folder) => prompt.includes(join(folder, 'transcription', 'venv'))),
    `copied to the clipboard: ${copied === prompt ? 'yes' : 'not readable here (hidden window)'}`)

  const fieldAfter = (text) => settings.locator('div', { hasText: new RegExp(`^${text}`) }).locator('input').first()
  await fieldAfter('Python').fill(python)
  await fieldAfter('Transcription script').fill(script)
  await settings.getByRole('button', { name: 'Save transcription settings' }).click()
  await page.waitForFunction(() => ['ready', 'ffmpeg-not-found'].includes(document.querySelector('[data-transcription="status"]')?.getAttribute('data-state') ?? ''), null, { timeout: 20_000 })
  const readyState = await part('status').getAttribute('data-state')
  const readyDetail = (await part('detail').innerText()).trim()
  // With no ffmpeg in this checkout's node_modules nor on the system, the honest row is "ffmpeg not found".
  record(4, readyState === 'ready' ? (await label()) === 'Ready' && /^Python 3\.12, script found, ffmpeg found/.test(readyDetail) : (await label()) === 'ffmpeg not found',
    `${readyState}: ${readyDetail}`)
  await shot('03-ready')

  await fieldAfter('ffmpeg').fill(join(scratch, 'no-ffmpeg-here'))
  await settings.getByRole('button', { name: 'Save transcription settings' }).click()
  await stateIs('ffmpeg-not-found')
  const wrong = await label()
  await shot('04-ffmpeg-not-found')
  const clearFfmpeg = async () => {
    await fieldAfter('ffmpeg').fill('')
    await settings.getByRole('button', { name: 'Save transcription settings' }).click()
    await page.waitForFunction((was) => document.querySelector('[data-transcription="status"]')?.getAttribute('data-state') === was && !/There is no file at the ffmpeg path/.test(document.querySelector('[data-transcription="detail"]')?.textContent ?? ''), readyState, { timeout: 20_000 })
  }
  await clearFfmpeg()
  // A bare name: spawning it would find whatever `ffmpeg` is first on PATH, so it is not accepted,
  // whether or not one is on this computer's PATH.
  await fieldAfter('ffmpeg').fill('ffmpeg')
  await settings.getByRole('button', { name: 'Save transcription settings' }).click()
  await page.waitForFunction(() => /There is no file at the ffmpeg path/.test(document.querySelector('[data-transcription="detail"]')?.textContent ?? ''), null, { timeout: 20_000 })
  const bare = await label()
  await clearFfmpeg()
  record(5, wrong === 'ffmpeg not found' && bare === 'ffmpeg not found', `wrong path: ${wrong}; bare name: ${bare}; cleared: ${await part('status').getAttribute('data-state')}`)

  const sectionText = await settings.locator('[data-settings-section="transcription"]').innerText()
  record(6, !/skill|gitrepos|speech-to-text|\/Users\/[^/]*\/gitrepos|dominik/i.test(sectionText), sectionText.slice(0, 200))
  exitCode = ledger.summary('TRANSCRIPTION SETTINGS').exitCode
} catch (error) {
  console.error(error)
  ledger.summary('TRANSCRIPTION SETTINGS')
} finally {
  await app?.close().catch(() => {})
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
  process.exit(exitCode)
}
