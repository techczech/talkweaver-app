// Publishing a heavy handout must not freeze the app (Dominik, 0.38.2-preview.1: "publishing handout
// ties up TalkWeaver with a beachball but works"). A throwaway user-data folder and vault, a talk of
// large photographs (so the Download handout is over Cloudflare Pages' 25 MiB file limit and is
// slimmed, and the lazy pages move every picture into slide-assets/), a made-up token and the fake
// Cloudflare API on this computer's loopback address. The bundled publishing tool really runs
// `pages deploy` against that fake. Nothing here contacts Cloudflare.
//
// While the publish runs, a heartbeat in the MAIN process (a 10 ms timer) records how late each tick
// fires: a late tick is the main process blocked, which is what macOS shows as the beachball. The
// check is the longest stall during the publish, against TW_STALL_LIMIT_MS (200 ms by default).
// TW_STALL_REPORT=1 prints every stall over 50 ms, with the time since the publish began.
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { startCloudflareApiStub } from '../scripts/lib/cloudflare-api-stub.mjs'

const root = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tw-publish-responsive-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
const slug = 'heavy-probe'
const talkDir = join(vault, slug)
const outlinePath = join(talkDir, `${slug}-outline.md`)
const site = join(userData, 'cloudflare-pages-site')
const LIMIT_MS = Number(process.env.TW_STALL_LIMIT_MS ?? 200)
const PICTURES = Number(process.env.TW_STALL_PICTURES ?? 14)
mkdirSync(userData, { recursive: true })
mkdirSync(join(talkDir, 'assets'), { recursive: true })

// Photographs as a camera would give them: 2400 x 1600 JPEG of fine detail (noise over a gradient),
// about 2-3 MB each. Each one differs, so none is encoded once for two.
const W = 2400
const H = 1600
for (let n = 0; n < PICTURES; n += 1) {
  const raw = Buffer.alloc(W * H * 3)
  let seed = 1234567 + n * 7919
  for (let i = 0; i < raw.length; i += 3) {
    seed = (seed * 1103515245 + 12345) >>> 0
    const px = (i / 3) % W
    raw[i] = (px * 255 / W + (seed & 63)) & 255
    raw[i + 1] = ((seed >> 8) & 127) + n * 9
    raw[i + 2] = (seed >> 16) & 255
  }
  await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toFile(join(talkDir, 'assets', `photo-${n}.jpg`))
}
const pictureBytes = readdirSync(join(talkDir, 'assets')).reduce((sum, name) => sum + statSync(join(talkDir, 'assets', name)).size, 0)
const slides = Array.from({ length: PICTURES }, (_, n) => [`### Photo ${n + 1}`, `{id=photo-${n}}`, '', `![Photo ${n + 1}](assets/photo-${n}.jpg)`, ''].join('\n'))
writeFileSync(outlinePath, ['---', 'title: Heavy probe', 'outline_version: 2', '---', '', ...slides].join('\n'))
mkdirSync(join(vault, '_PRESENTATIONS', slug), { recursive: true })
writeFileSync(join(vault, '_PRESENTATIONS', slug, 'run-probe.json'), JSON.stringify({
  id: 'run-probe', talkSlug: slug, talkTitle: 'Heavy probe', kind: 'delivery', status: 'delivered', eventTitle: 'Probe event',
  slideSet: { kind: 'full' }, startedAt: '2026-10-01T09:00:00.000Z', endedAt: '2026-10-01T10:00:00.000Z',
}))
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }))

const fake = (name) => ['test', 'token', 'responsive', 'handout', name, '0123456789abcdef'].join('-')
const TOKEN = fake('pagesonly')
const ADA = { id: 'acc-ada-0001', name: 'Ada Lovelace' }
const SITE = 'talkweaver-handouts'

const CHECKS = [
  'the app started on the throwaway folder, pointed at the fake API, and nothing can be opened outside it',
  'the heavy handout published (the Download page was slimmed under the file limit and the site went up)',
  `the main process never stalled for ${LIMIT_MS} ms or more while the handout was published`,
  'the heavy handout of a Run published',
  `the main process never stalled for ${LIMIT_MS} ms or more while the Run's handout was published`,
  `the main process never stalled for ${LIMIT_MS} ms or more while the talk opened and its slide pictures were made`,
  `the main process never stalled for ${LIMIT_MS} ms or more after an edit, until its slide pictures were made again`,
]
const ledger = createCheckLedger(CHECKS)
const record = (index, ok, detail) => ledger.record(CHECKS[index], Boolean(ok), detail)

let app
let api
let output = ''
let exitCode = 1
try {
  await ensureFreshBuild(root)
  api = await startCloudflareApiStub({ sites: [], accounts: [ADA], accountSites: { [ADA.id]: [SITE] }, tokens: { [TOKEN]: { accounts: [ADA.id], workers: false } } })
  const env = { TW_E2E: '1', TW_E2E_CLOUDFLARE_API_BASE_URL: api.baseUrl }
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'PATHEXT', 'ComSpec']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env })
  app.process().stdout.on('data', (chunk) => { output += chunk })
  app.process().stderr.on('data', (chunk) => { output += chunk })
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {}
    shell.showItemInFolder = () => {}
    shell.openPath = async () => ''
  })
  if (process.env.TW_E2E_SHOW !== '1') {
    await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const hide = (win) => { win.setPosition(-20000, -20000); win.hide() }
      BrowserWindow.getAllWindows().forEach(hide)
      electronApp.on('browser-window-created', (_event, win) => hide(win))
    })
  }
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const where = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const onThrowaway = realpathSync(where) === realpathSync(userData)
  record(0, onThrowaway)
  if (!onThrowaway) throw new Error('not on the throwaway user-data folder: stopping before any token is saved')
  // The heartbeat, in the main process.
  const startBeat = () => app.evaluate(() => {
    const beat = { last: performance.now(), max: 0, stalls: [], started: performance.now(), timer: null }
    beat.timer = setInterval(() => {
      const now = performance.now()
      const late = now - beat.last - 10
      if (late > beat.max) beat.max = late
      if (late > 50) beat.stalls.push({ at: Math.round(beat.last - beat.started), ms: Math.round(late) })
      beat.last = now
    }, 10)
    globalThis.__beat = beat
  })
  const stopBeat = () => app.evaluate(() => { clearInterval(globalThis.__beat.timer); const { max, stalls } = globalThis.__beat; return { max, stalls } })
  const describe = (beat, took) => {
    const worst = [...beat.stalls].sort((a, b) => b.ms - a.ms).slice(0, 6).map((stall) => `${stall.ms} ms at ${(stall.at / 1000).toFixed(1)} s`).join(', ')
    return `publish took ${(took / 1000).toFixed(1)} s; longest stall ${Math.round(beat.max)} ms; ${beat.stalls.length} stalls over 50 ms${worst ? ` (worst: ${worst})` : ''}`
  }
  // Opening the talk and editing it: the live compile and the slide pictures (thumbnails) that follow
  // both used to run in the main process. Each window runs from the action until the pictures are on
  // disk (PNG files under the user-data folder and the vault) and then 3 s more, for trailing work.
  const pngCount = () => {
    let count = 0
    const walk = (dir) => {
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.isDirectory()) walk(join(dir, entry.name))
        else if (entry.name.endsWith('.png')) count += 1
      }
    }
    walk(userData)
    walk(vault)
    return count
  }
  const untilPictures = async (target) => {
    const end = Date.now() + 120_000
    while (pngCount() < target && Date.now() < end) await page.waitForTimeout(250)
    await page.waitForTimeout(3000)
    return pngCount()
  }
  const describeWindow = (beat, took, pictures) => {
    const worst = [...beat.stalls].sort((a, b) => b.ms - a.ms).slice(0, 6).map((stall) => `${stall.ms} ms at ${(stall.at / 1000).toFixed(1)} s`).join(', ')
    return `${pictures} slide pictures; window ${(took / 1000).toFixed(1)} s; longest stall ${Math.round(beat.max)} ms; ${beat.stalls.length} stalls over 50 ms${worst ? ` (worst: ${worst})` : ''}`
  }
  const picturesBefore = pngCount()
  await startBeat()
  const openStarted = Date.now()
  await openTalkByTitle(page, 'Heavy probe')
  const openPictures = await untilPictures(picturesBefore + PICTURES)
  const openTook = Date.now() - openStarted
  const openBeat = await stopBeat()
  record(5, openPictures >= picturesBefore + PICTURES && openBeat.max < LIMIT_MS, describeWindow(openBeat, openTook, openPictures - picturesBefore))

  // An edit to the last slide: the editor's own typing, its compile on the pause and the new picture.
  await page.locator('.cm-content').waitFor()
  await page.locator('.cm-content').click()
  const picturesBeforeEdit = pngCount()
  await startBeat()
  const editStarted = Date.now()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.insertText('\nThe last photograph, edited.\n')
  const editPictures = await untilPictures(picturesBeforeEdit + 1)
  const editTook = Date.now() - editStarted
  const editBeat = await stopBeat()
  record(6, editPictures > picturesBeforeEdit && editBeat.max < LIMIT_MS, describeWindow(editBeat, editTook, editPictures - picturesBeforeEdit))
  if (process.env.TW_STALL_REPORT === '1') console.log(JSON.stringify({ open: openBeat.stalls, edit: editBeat.stalls }))

  // Connect, as a person does, in Settings.
  const settings = page.locator('[aria-label="Settings"]').first()
  const part = (name) => settings.locator(`[data-cloudflare="${name}"]`)
  await page.keyboard.press('ControlOrMeta+,')
  await part('connection').waitFor({ state: 'visible' })
  await part('token').locator('input').fill(TOKEN)
  await part('token').getByRole('button', { name: 'Save token' }).click()
  await page.waitForFunction(() => document.querySelector('[data-cloudflare="connection-label"]')?.textContent === 'Connected · Ada Lovelace', null, { timeout: 40_000 })
  await page.waitForFunction(() => document.querySelector('[data-cloudflare="connection"]')?.getAttribute('data-busy') === 'no', null, { timeout: 40_000 })
  await page.keyboard.press('Escape')
  await page.locator('[aria-label="Settings"]').waitFor({ state: 'detached' })

  // The app's own work after a talk opens or changes (its compile, its slide pictures) also runs in
  // the main process. A publish is measured from a quiet app: the heartbeat runs in 2 s windows until
  // one is quiet (no stall over 50 ms), at most 2 minutes. What was seen before that is reported.
  const quiet = async (label) => {
    const seen = []
    const end = Date.now() + 120_000
    for (;;) {
      await startBeat()
      await page.waitForTimeout(2000)
      const window = await stopBeat()
      if (window.max < 50 || Date.now() > end) break
      seen.push(Math.round(window.max))
    }
    background.push(`${label}: ${seen.length ? `${seen.length * 2} s of background work first, longest stall ${Math.max(...seen)} ms` : 'quiet at once'}`)
  }
  const background = []
  await quiet('before the talk\'s publish')
  await startBeat()
  const started = Date.now()
  const result = await page.evaluate(({ path }) => window.tw.talk.publishHandout(path, ''), { path: outlinePath })
  const took = Date.now() - started
  const beat = await stopBeat()

  const downloadPath = join(site, slug, `${slug}-download.html`)
  const download = existsSync(downloadPath) ? statSync(downloadPath).size : 0
  const deployments = api.reached().filter((line) => line === `POST /accounts/${ADA.id}/pages/projects/${SITE}/deployments`).length
  record(1, result?.success === true && download > 0 && download < 25 * 1024 * 1024 && deployments === 1,
    `${PICTURES} photographs, ${(pictureBytes / 1048576).toFixed(1)} MB on disk; Download page ${(download / 1048576).toFixed(1)} MB; ${deployments} upload; ${result?.success ? 'published' : `not published: ${String(result?.error).slice(0, 200)}`}`)
  record(2, result?.success === true && beat.max < LIMIT_MS, describe(beat, took))

  // A Run's handout: its pages are built from the talk's prepared model, then written the same way.
  await quiet('before the Run\'s publish')
  await startBeat()
  const runStarted = Date.now()
  const runResult = await page.evaluate(({ talk }) => window.tw.history.publishRunHandout(talk, 'run-probe'), { talk: slug })
  const runTook = Date.now() - runStarted
  const runBeat = await stopBeat()
  record(3, runResult?.success === true && api.reached().filter((line) => line === `POST /accounts/${ADA.id}/pages/projects/${SITE}/deployments`).length === 2,
    runResult?.success ? runResult.url : `not published: ${String(runResult?.error).slice(0, 200)}`)
  record(4, runResult?.success === true && runBeat.max < LIMIT_MS, describe(runBeat, runTook))
  console.log(`      (not counted: ${background.join('; ')})`)
  if (process.env.TW_STALL_REPORT === '1') console.log(JSON.stringify({ talk: beat.stalls, run: runBeat.stalls }))

  exitCode = ledger.summary('PUBLISH RESPONSIVENESS').exitCode
} catch (error) {
  const text = String(error?.stack ?? error).split(TOKEN).join('[made-up token]')
  console.log(`FAIL  the journey could not run: ${text}\n      the app's last output: ${output.slice(-1500).split(TOKEN).join('[made-up token]').replace(/\s+/g, ' ')}`)
  try { ledger.summary('PUBLISH RESPONSIVENESS') } catch { /* summary already printed */ }
  exitCode = 1
} finally {
  const pid = app?.process().pid
  try { await app?.close() } catch { /* already closed */ }
  if (pid) { try { process.kill(pid) } catch { /* gone */ } }
  await api?.close()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}
process.exit(exitCode)
