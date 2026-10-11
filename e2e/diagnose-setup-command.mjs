// `TalkWeaver setup …` run as the built app's own executable (spec docs/plans/cloudflare-setup-in-app,
// D14; ticket 07): every command of the D14 table against the fake Cloudflare API and an S3 stand-in,
// with no window and TalkWeaver closed; a TalkWeaver launched while a command runs quits and opens no
// window; then TalkWeaver open on the same user-data folder, where its Settings screen shows the
// states setup printed and every setup command is refused (Owner, 10 Oct): exit 1, the fixed
// sentence, nothing read from standard input, nothing written. Ends with the gate: the made-up token
// and keys, given on standard input only, are in no process's arguments, no output, no window and no
// file of the user-data folder (the secrets store holds them encrypted).
//
// The app is the built one (out/) run by this checkout's Electron, unpackaged and with TW_E2E=1, so
// that the test-only override can point it at the fake API on loopback (a packaged build ignores it).
// A throwaway user-data folder and vault, made-up secrets. Nothing here contacts Cloudflare, the
// installed app or its data.
import { _electron as electron } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { REPLY_TEXT_MARK, startCloudflareApiStub } from '../scripts/lib/cloudflare-api-stub.mjs'
import { S3_REPLY_TEXT_MARK, startS3Stub } from '../scripts/lib/s3-stub.mjs'

const root = process.cwd()
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const scratch = mkdtempSync(join(tmpdir(), 'tw-setup-command-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
const slug = 'setup-probe'
mkdirSync(userData, { recursive: true })
mkdirSync(join(vault, slug), { recursive: true })
writeFileSync(join(vault, slug, `${slug}-outline.md`), ['---', 'title: Setup probe', 'outline_version: 2', '---', '', '### One', '{id=one}', '', '- A point', ''].join('\n'))
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }))
// A transcription set-up as an agent makes it: an environment that records its Python, the script, an ffmpeg.
const venv = join(scratch, 'transcription', 'venv')
mkdirSync(join(venv, 'bin'), { recursive: true })
writeFileSync(join(venv, 'bin', 'python'), '#!/bin/sh\nexit 0\n')
writeFileSync(join(venv, 'pyvenv.cfg'), 'home = /usr/bin\nversion = 3.11.7\n')
writeFileSync(join(scratch, 'transcription', 'parakeet_to_srt.py'), '# script\n')
writeFileSync(join(scratch, 'transcription', 'ffmpeg'), '#!/bin/sh\nexit 0\n')
chmodSync(join(scratch, 'transcription', 'ffmpeg'), 0o755)

// Made up, and built so that no source file holds a whole value.
const fake = (name) => ['test', 'token', 'setup', 'command', name, '0123456789abcdef'].join('-')
const TOKEN = fake('cloudflare')
const KEYS = { id: fake('recording-keyid'), secret: fake('recording-secret') }
const SECRET_VALUES = [TOKEN, KEYS.id, KEYS.secret]
const ADA = { id: 'acc-ada-0001', name: 'Ada Lovelace' }
const SHARE_HOST = 'drafts.handouts.example'
const APP_OPEN = 'TalkWeaver is open. Quit it and run this again, or use Settings → Cloudflare.'
const REFUSED_WITHIN_MS = 15_000
const RUN_LIMIT_MS = 60_000

const CHECKS = [
  'setup status --json on a fresh folder: exit 1, "Not connected", and every row present, the transcription and Importer rows among them',
  'a token as an argument (bare, or --token=) is refused with exit 2: nothing is saved and the value is not printed back',
  'setup cloudflare connect, the token on standard input: exit 0, "Connected · Ada Lovelace"; the token is in the secrets store and in no process\'s arguments',
  'setup cloudflare create-site: exit 0, Publishing handouts Ready; the site was made at the fake API',
  'setup cloudflare live: progress lines, then exit 0 and Going live and sharing Ready; the live service was uploaded',
  'setup recording, the keys on standard input: exit 0, Recording storage Ready (one list of the bucket)',
  'setup transcription: exit 0, Transcription Ready; setup status --json then exits 0 and reports the transcription and Importer rows',
  'usage errors exit 2 (an unknown command, an option with no value, two tokens on standard input, an endpoint that is not R2\'s, keys with a space) and change nothing',
  'no setup command that ran opened a window: every one reported none',
  'the open Settings screen shows the states setup printed: the connection header and the Publishing handouts, Going live, Share-link domain and Recording storage rows',
  'setup cloudflare share-domain, TalkWeaver closed: exit 0, Share-link domain Attached',
  'TalkWeaver launched while setup waits for its input: the launch quits at once (it lost the lock) and the setup process opens no window, then finishes (exit 0)',
  `TalkWeaver open on the same folder: setup status --json, cloudflare connect (standard input left open), cloudflare disconnect and recording each exit 1 within ${REFUSED_WITHIN_MS / 1000} s with "${APP_OPEN}" (--json: state app-open), read nothing and write nothing; the app's window does not come forward`,
  'setup cloudflare disconnect, TalkWeaver closed again: exit 0, Not connected, and the token file is gone',
  'no made-up secret in any argument, any output of setup or of the app, the window, or any file of the user-data folder; the token reached the fake API',
]
const ledger = createCheckLedger(CHECKS)
const record = (index, ok, detail) => ledger.record(CHECKS[index], Boolean(ok), detail)

function findIn(dir, values) {
  const hits = []
  const needles = values.flatMap((value) => [Buffer.from(value, 'utf8'), Buffer.from(value, 'utf16le')])
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && needles.some((needle) => readFileSync(path).includes(needle))) hits.push(relative(dir, path))
    }
  }
  walk(dir)
  return hits
}

let app
let api
let s3
let appOutput = ''
let setupOutput = ''
const argvSeen = []
const processArgs = []
let exitCode = 1
try {
  await ensureFreshBuild(root)
  api = await startCloudflareApiStub({
    sites: [],
    accounts: [ADA],
    zones: [{ id: 'zone-ada-0001', name: 'handouts.example', account: ADA.id }],
    tokens: { [TOKEN]: { accounts: [ADA.id] } },
  })
  s3 = await startS3Stub({ buckets: ['talks'], keys: [KEYS.id] })
  // Only what the app needs from this shell: no credential of the person running the test goes in.
  // The S3 stand-in's loopback address is not an R2 endpoint: the unpackaged test app accepts this one
  // exact address as well (TW_E2E_RECORDING_ENDPOINT), as it accepts the fake Cloudflare API.
  const env = { TW_E2E: '1', TW_E2E_CLOUDFLARE_API_BASE_URL: api.baseUrl, TW_E2E_RECORDING_ENDPOINT: s3.endpoint }
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'PATHEXT', 'ComSpec']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }

  /** Run `setup …` as the app's executable. `stdin`: what is piped in (null: nothing, closed at once).
   *  `holdStdin`: standard input is left open with nothing written until the command exits. */
  const setup = (args, { stdin = null, beforeInput, refusedOnPurpose = false, holdStdin = false } = {}) => new Promise((resolve) => {
    // The keychain stand-in Playwright gives the open app (its Electron loader adds the same switch), so
    // both read one key and neither touches this computer's login keychain. `setup` comes straight
    // after the app's path; Electron's switches go after the command.
    const argv = ['.', 'setup', ...args, `--user-data-dir=${userData}`, '--use-mock-keychain']
    // The two runs that put a token in an argument on purpose (check 1) are left out of the gate's argument search.
    if (!refusedOnPurpose) argvSeen.push(argv.join(' '))
    const child = spawn(electronPath, argv, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdin.on('error', () => {})
    const started = Date.now()
    // A command that never ends (one waiting on standard input it should not read) fails, not hangs.
    let timedOut = false
    const limit = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch { /* gone */ } }, RUN_LIMIT_MS)
    child.on('exit', (exited) => {
      clearTimeout(limit)
      const code = timedOut ? `killed after ${RUN_LIMIT_MS / 1000} s` : exited
      setupOutput += `${stdout}\n${stderr}\n`
      let json = null
      try { json = JSON.parse(stdout) } catch { /* not --json, or not JSON */ }
      resolve({ code, stdout, stderr, json, ms: Date.now() - started, windows: /\[setup\] windows=(\d+)/.exec(stderr)?.[1] ?? null, endedAt: Date.now() })
    })
    void (async () => {
      if (beforeInput) await beforeInput(child)
      if (holdStdin) return
      if (stdin !== null) child.stdin.write(stdin)
      child.stdin.end()
    })()
  })
  /** The bytes of every file a setup command writes: config.json, the secrets store's slot files
   *  (`*.bin`) and any temp file beside them. (The open app writes files of its own, such as its search index.) */
  const topFiles = () => Object.fromEntries(readdirSync(userData, { withFileTypes: true }).filter((entry) => entry.isFile() && /^config\.json|\.bin$|\.tmp$/.test(entry.name))
    .map((entry) => [entry.name, createHash('sha256').update(readFileSync(join(userData, entry.name))).digest('hex')]))
  /** Every process's arguments, as `ps` shows them, while `child` waits for its input. */
  const argumentsOfEveryProcess = () => {
    const listed = spawnSync('ps', ['-axww', '-o', 'args='], { encoding: 'utf8' })
    return listed.status === 0 ? listed.stdout : ''
  }
  const noWindow = (run) => run.windows === '0'
  const describe = (run) => `exit ${run.code}${run.json ? ` · ${run.json.cloudflare.connection.label}` : ''}${run.json?.error ? ` · ${run.json.error}` : ''}`

  // 0. A fresh folder.
  const fresh = await setup(['status', '--json'])
  const rows = fresh.json?.rows ?? {}
  record(0, fresh.code === 1 && fresh.json?.cloudflare.connection.label === 'Not connected' && noWindow(fresh)
    && ['publishing', 'goingLive', 'shareLink', 'recording', 'transcription', 'importer'].every((key) => typeof rows[key]?.state === 'string')
    && rows.transcription.label === 'Not set up — optional' && ['ready', 'not-available', 'unknown'].includes(rows.importer.state), describe(fresh))

  // 1. A token as an argument.
  const asArgument = await setup(['cloudflare', 'connect', TOKEN], { refusedOnPurpose: true })
  const asFlag = await setup(['cloudflare', 'connect', `--token=${TOKEN}`, '--json'], { refusedOnPurpose: true })
  const leaked = [asArgument, asFlag].some((run) => run.stdout.includes(TOKEN) || run.stderr.includes(TOKEN))
  record(1, asArgument.code === 2 && asFlag.code === 2 && asFlag.json?.usage === true && !leaked
    && !readdirSync(userData).includes('cf-pages-token.bin'), `${asArgument.code} / ${asFlag.code}`)

  // 2. Connect, the token on standard input. While the command waits for it, every process's arguments are read.
  const connect = await setup(['cloudflare', 'connect', '--json'], {
    stdin: `${TOKEN}\n`,
    beforeInput: async () => { await new Promise((done) => setTimeout(done, 1500)); processArgs.push(argumentsOfEveryProcess()) },
  })
  record(2, connect.code === 0 && connect.json?.cloudflare.connection.label === 'Connected · Ada Lovelace' && readdirSync(userData).includes('cf-pages-token.bin')
    && processArgs[0]?.includes('setup cloudflare connect --json') && !processArgs[0]?.includes(TOKEN) && noWindow(connect), describe(connect))

  // 3. The site.
  const site = await setup(['cloudflare', 'create-site', '--json'])
  const made = api.requests.filter((request) => request.method === 'POST' && request.path === `/accounts/${ADA.id}/pages/projects`).length
  record(3, site.code === 0 && site.json?.rows.publishing.label === 'Ready' && site.json?.rows.publishing.project === 'talkweaver-handouts' && made === 1 && noWindow(site),
    `${describe(site)} · ${site.json?.rows.publishing.label}`)

  // 4. Going live.
  const live = await setup(['cloudflare', 'live'])
  const uploaded = api.requests.filter((request) => request.method === 'PUT' && /\/workers\/scripts\/talkweaver-live-sessions$/.test(request.path)).length
  record(4, live.code === 0 && /Setting up… Uploading the live service/.test(live.stdout) && /^Going live and sharing: Ready/m.test(live.stdout) && uploaded >= 1 && noWindow(live),
    live.stdout.split('\n').filter((line) => line.startsWith('Setting up') || line.startsWith('Going live')).join(' | '))

  // 5. Recording storage.
  const recording = await setup(['recording', '--endpoint', s3.endpoint, '--bucket', 'talks', '--json'], { stdin: `${KEYS.id}\n${KEYS.secret}\n` })
  record(5, recording.code === 0 && recording.json?.rows.recording.label === 'Ready' && noWindow(recording), `${describe(recording)} · ${recording.json?.rows.recording.label} ${recording.json?.rows.recording.detail}`)

  // 6. Transcription, and the whole status.
  const transcription = await setup(['transcription', '--python', join(venv, 'bin', 'python'), '--script', join(scratch, 'transcription', 'parakeet_to_srt.py'), '--ffmpeg', join(scratch, 'transcription', 'ffmpeg'), '--json'])
  const all = await setup(['status', '--json'])
  record(6, transcription.code === 0 && transcription.json?.rows.transcription.state === 'ready' && all.code === 0 && all.json?.ready === true
    && all.json?.rows.transcription.label === 'Ready (Python 3.11, script found, ffmpeg found)' && typeof all.json?.rows.importer.state === 'string',
  `${describe(transcription)} · ${transcription.json?.rows.transcription.label} · status ${all.code} · importer ${all.json?.rows.importer.state}`)

  // 7. Usage errors.
  const configBefore = readFileSync(join(userData, 'config.json'), 'utf8')
  const usage = [
    await setup(['cloudflare', 'connnect']), await setup(['recording', '--endpoint']), await setup(['cloudflare', 'connect'], { stdin: `${TOKEN}\n${TOKEN}\n` }),
    // An endpoint outside R2's format, and keys with a space: refused before anything is saved.
    await setup(['recording', '--endpoint', 'https://e.example', '--bucket', 'talks']),
    await setup(['recording', '--endpoint', s3.endpoint, '--bucket', 'other-bucket'], { stdin: `${KEYS.id} x\n${KEYS.secret}\n` }),
  ]
  record(7, usage.every((run) => run.code === 2) && readFileSync(join(userData, 'config.json'), 'utf8') === configBefore, usage.map((run) => run.code).join(' '))

  // 10. The share-link address, TalkWeaver closed.
  const share = await setup(['cloudflare', 'share-domain', SHARE_HOST, '--json'])
  record(10, share.code === 0 && share.json?.rows.shareLink.label === 'Attached' && share.json?.rows.shareLink.host === SHARE_HOST && noWindow(share),
    `${describe(share)} · ${share.json?.rows.shareLink.label}`)

  // 11. TalkWeaver launched while setup holds the lock (waiting for its token): the launch loses the
  // lock and quits; its hand-over goes to the setup process, which opens nothing.
  let launched = null
  const during = await setup(['cloudflare', 'connect', '--json'], {
    stdin: `${TOKEN}\n`,
    beforeInput: async () => {
      await new Promise((done) => setTimeout(done, 1500))
      launched = await new Promise((done) => {
        const started = Date.now()
        const second = spawn(electronPath, ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''
        second.stdout.on('data', (chunk) => { output += chunk })
        second.stderr.on('data', (chunk) => { output += chunk })
        const timer = setTimeout(() => { try { second.kill('SIGKILL') } catch { /* gone */ } done({ code: 'still running', ms: Date.now() - started, output }) }, 20_000)
        second.on('exit', (code) => { clearTimeout(timer); appOutput += output; done({ code, ms: Date.now() - started, output }) })
      })
      // A moment for any hand-over to reach the setup process before it is given its input.
      await new Promise((done) => setTimeout(done, 1000))
    },
  })
  record(11, launched?.code === 0 && during.code === 0 && noWindow(during) && during.json?.cloudflare.connection.label === 'Connected · Ada Lovelace',
    `launch: exit ${launched?.code} after ${launched?.ms} ms · setup: ${describe(during)} · windows ${during.windows}`)

  // ── TalkWeaver open on the same folder ─────────────────────────────────────────────────────────
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env })
  app.process().stdout.on('data', (chunk) => { appOutput += chunk })
  app.process().stderr.on('data', (chunk) => { appOutput += chunk })
  const hidden = process.env.TW_E2E_SHOW !== '1'
  if (hidden) {
    await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const hide = (win) => { win.setPosition(-20000, -20000); win.hide() }
      BrowserWindow.getAllWindows().forEach(hide)
      electronApp.on('browser-window-created', (_event, win) => hide(win))
    })
  }
  const page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.tw?.cloudflare?.status))
  const where = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  if (realpathSync(where) !== realpathSync(userData)) throw new Error('not on the throwaway user-data folder')
  const windowState = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => win.isVisible()))

  const SETTINGS = '[aria-label="Settings"]'
  const settings = page.locator(SETTINGS).first()
  const part = (name) => settings.locator(`[data-cloudflare="${name}"]`)
  if (await page.locator(SETTINGS).count() === 0) await page.keyboard.press('ControlOrMeta+,')
  await part('connection').waitFor({ state: 'visible' })
  const text = async (name) => (await part(name).innerText()).replace(/\s+/g, ' ').trim()
  const connectedInWindow = await page.waitForFunction(() => document.querySelector('[data-cloudflare="connection-label"]')?.textContent === 'Connected · Ada Lovelace', null, { timeout: 40_000 }).then(() => true, () => false)
  if (!connectedInWindow) {
    const seen = await page.evaluate(async () => ({ label: document.querySelector('[data-cloudflare="connection-label"]')?.textContent, status: await window.tw.cloudflare.status() }))
    throw new Error(`the open app did not show the connection: ${JSON.stringify(seen)}`)
  }
  await page.waitForFunction(() => /Ready/.test(document.querySelector('[data-cloudflare="publishing"]')?.textContent ?? '') && /Ready/.test(document.querySelector('[data-cloudflare="live-service"]')?.textContent ?? '')
    && /Attached/.test(document.querySelector('[data-cloudflare="share-link"]')?.textContent ?? ''), null, { timeout: 40_000 }).catch(() => {})
  // The Recording storage row is checked by the open app too (in memory only): Check, as a person would.
  await part('recording-storage-check').click().catch(() => {})
  await page.waitForFunction(() => /Ready/.test(document.querySelector('[data-cloudflare="recording-storage"]')?.textContent ?? ''), null, { timeout: 20_000 }).catch(() => {})
  const shown = { header: await page.locator('[data-cloudflare="connection-label"]').innerText(), publishing: await text('publishing'), live: await text('live-service'), share: await text('share-link'), recording: await text('recording-storage') }
  const printed = all.json.rows
  const same = shown.header === all.json.cloudflare.connection.label
    && shown.publishing.includes(printed.publishing.label) && shown.publishing.includes(printed.publishing.detail)
    && shown.live.includes(printed.goingLive.label) && shown.live.includes(printed.goingLive.detail)
    && shown.share.includes(share.json.rows.shareLink.label)
    && shown.recording.includes(printed.recording.label)
  record(9, same, `window: ${JSON.stringify(shown)} · printed: ${printed.publishing.label} / ${printed.goingLive.label} / ${share.json?.rows.shareLink.label} / ${printed.recording.label}`)

  // 12. Every setup command refused while the app is open.
  const windowsBefore = await windowState()
  const filesBefore = topFiles()
  const refused = [
    await setup(['status', '--json']),
    // Standard input left open: a command that read it would wait here until the time limit.
    await setup(['cloudflare', 'connect'], { holdStdin: true }),
    await setup(['cloudflare', 'disconnect', '--json']),
    await setup(['recording', '--endpoint', s3.endpoint, '--bucket', 'talks'], { stdin: `${KEYS.id}\n${KEYS.secret}\n` }),
  ]
  await new Promise((done) => setTimeout(done, 1000))
  const windowsAfter = await windowState()
  const filesAfter = topFiles()
  const changedFiles = [...new Set([...Object.keys(filesBefore), ...Object.keys(filesAfter)])].filter((name) => filesBefore[name] !== filesAfter[name])
  const saysAppOpen = (run, json) => (json
    ? run.json?.state === 'app-open' && run.json?.error === APP_OPEN && run.json?.ready === false
    : run.stdout === `${APP_OPEN}\n`)
  const refusedOk = refused.every((run, index) => run.code === 1 && run.ms <= REFUSED_WITHIN_MS && saysAppOpen(run, index === 0 || index === 2) && !/\[setup\] windows=/.test(run.stderr))
  const windowsOk = windowsBefore.length === windowsAfter.length && (!hidden || windowsAfter.every((visible) => visible === false))
  record(12, refusedOk && changedFiles.length === 0 && windowsOk && readdirSync(userData).includes('cf-pages-token.bin'),
    `${refused.map((run) => `exit ${run.code} in ${run.ms} ms`).join(' · ')} · changed files: ${changedFiles.join(', ') || 'none'} · app windows visible ${JSON.stringify(windowsBefore)} → ${JSON.stringify(windowsAfter)}`)

  const windowText = await page.evaluate(() => document.documentElement.outerHTML)
  await app.close()
  app = null

  // 13. Disconnect, TalkWeaver closed again.
  const gone = await setup(['cloudflare', 'disconnect', '--json'])
  record(13, gone.code === 0 && gone.json?.cloudflare.connection.label === 'Not connected' && !readdirSync(userData).includes('cf-pages-token.bin') && noWindow(gone), describe(gone))

  // 8. No window: every run that ran its command reported none.
  const runs = [fresh, asArgument, asFlag, connect, site, live, recording, transcription, all, ...usage, share, during, gone]
  record(8, runs.every(noWindow), `${runs.filter(noWindow).length} of ${runs.length} runs reported no window`)

  // 14. The gate.
  const searched = [...SECRET_VALUES, REPLY_TEXT_MARK, S3_REPLY_TEXT_MARK]
  const where2 = {
    argv: SECRET_VALUES.filter((value) => argvSeen.some((line) => line.includes(value))).length,
    processes: SECRET_VALUES.filter((value) => processArgs.some((listing) => listing.includes(value))).length,
    setupOutput: searched.filter((value) => setupOutput.includes(value)).length,
    appOutput: searched.filter((value) => appOutput.includes(value)).length,
    window: searched.filter((value) => windowText.includes(value)).length,
    files: findIn(userData, SECRET_VALUES),
  }
  record(14, where2.argv === 0 && where2.processes === 0 && where2.setupOutput === 0 && where2.appOutput === 0 && where2.window === 0 && where2.files.length === 0
    && api.requests.some((request) => request.authorization === `Bearer ${TOKEN}`),
  where2.files.length ? `found in: ${where2.files.join(', ')}` : `arguments ${where2.argv}, processes ${where2.processes}, setup output ${where2.setupOutput}, app output ${where2.appOutput}, window ${where2.window}`)

  exitCode = ledger.summary('SETUP COMMAND').exitCode
} catch (error) {
  let text = String(error?.stack ?? error)
  for (const value of SECRET_VALUES) text = text.split(value).join('[made-up secret]')
  console.log(`FAIL  the journey could not run: ${text}`)
  try { ledger.summary('SETUP COMMAND') } catch { /* summary already printed */ }
  exitCode = 1
} finally {
  const pid = app?.process().pid
  try { await app?.close() } catch { /* already closed */ }
  if (pid) { try { process.kill(pid) } catch { /* gone, as it should be */ } }
  await api?.close()
  await s3?.close()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}
process.exit(exitCode)
