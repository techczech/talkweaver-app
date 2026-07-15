// Real-Electron harness for TalkWeaver presenter Runs (ADR-0001 / C8).
//
// Runs the app in TEST MODE (TW_REC_TEST=1): the recorder bridge synthesises audio and
// upload short-circuits to a local mock log. This drives the real presenter preload UI.
//
// C8 coverage:
//   (a) L at the start commits a Delivery run, then finalises it with later wall-clock marks.
//   (b) reaching the last slide raises the save toast; Enter saves a Delivery.
//   (c) a short unsaved run closes without an offer and writes nothing.
//   (d) a gate-passing unsaved run gets the close modal; "Don't save" writes nothing.
//   (e) after recorded stop, the "change" demotion control persists kind=rehearsal.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-recording.mjs
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`)
}

const FIX = [
  '---', 'title: Recording Fixture', 'duration: 30min', '---', '',
  '## Talk', '',
  '### Opening', '{id=recopen}', '', 'Welcome to the recording fixture.', '',
  '### Alpha', '{id=recalpha}', '', 'The first content slide.', '',
  '### Bravo', '{id=recbravo}', '', 'The second content slide.', '',
  '### Charlie', '{id=reccharlie}', '', 'The third content slide.', '',
  '### Delta', '{id=recdelta}', '', 'The fourth content slide.', ''
].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-rec-' + String(Date.now()) + '-'))
const tempVault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const fxDir = join(tempVault, 'recording-fixture')
const slug = 'recording-fixture'
const outlinePath = join(fxDir, 'recording-fixture-outline.md')
mkdirSync(fxDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
writeFileSync(outlinePath, FIX, 'utf8')
writeFileSync(
  join(userDataDir, 'config.json'),
  JSON.stringify(
    { vaultRoot: tempVault, recordingDiscardMs: 800, recordingR2Endpoint: 'https://mock.r2.test', recordingR2Bucket: 'mock-bucket' },
    null,
    2
  ),
  'utf8'
)

const sessionsDir = join(tempVault, '_PRESENTATIONS', slug)
const recordingsDir = join(userDataDir, 'recordings')
const mockPath = join(userDataDir, 'recording-r2-mock.jsonl')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const countSessions = () => (existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).length : 0)
const listSessionFiles = () => (existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith('.json')) : [])
const listWebms = () => (existsSync(recordingsDir) ? readdirSync(recordingsDir).filter((f) => f.endsWith('.webm')) : [])
const readSessionFile = (f) => JSON.parse(readFileSync(join(sessionsDir, f), 'utf8'))
const readSessions = () => listSessionFiles().map(readSessionFile)
const sessionById = (id) => JSON.parse(readFileSync(join(sessionsDir, `${id}.json`), 'utf8'))
const countRecordedSessions = () => readSessions().filter((s) => s.audio !== null).length
const newSessionSince = (before) => listSessionFiles().find((f) => !before.has(f)) ?? null

async function waitFor(pred, timeoutMs, stepMs = 150) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await Promise.resolve(pred())) return true
    await sleep(stepMs)
  }
  return false
}

const app = await electron.launch({
  args: ['.', '--user-data-dir=' + userDataDir],
  cwd: REPO,
  env: { ...process.env, TW_REC_TEST: '1' }
})
let page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

async function appWindow() {
  if (!page.isClosed()) return page
  for (const win of app.windows()) {
    if (win.isClosed()) continue
    const isMain = await win.evaluate(() => !!window.tw?.talk && !!window.tw?.recording).catch(() => false)
    if (isMain) {
      page = win
      return page
    }
  }
  throw new Error('TalkWeaver app window is not available')
}

async function openPresenter() {
  const main = await appWindow()
  const winPromise = app.waitForEvent('window')
  const presenting = main.evaluate(
    ({ p, c }) => window.tw.talk.present(p, c, 'presenter'),
    { p: outlinePath, c: FIX }
  )
  const pres = await winPromise
  await pres.waitForLoadState('domcontentloaded')
  await presenting
  await pres.bringToFront()
  await pres.waitForSelector('#twrec-module', { timeout: 8000 })
  await pres.waitForTimeout(350)
  if (await pres.locator('#twResume:not([hidden])').count().catch(() => 0)) {
    await pres.locator('#twResumeNo').click().catch(() => {})
    await pres.waitForTimeout(200)
  }
  return pres
}

async function requestClose(pres) {
  const token = `tw-close-${Date.now()}-${Math.random()}`
  await pres.evaluate((value) => {
    window.__twRequestCloseToken = value
  }, token).catch(() => {})
  const closed = pres.waitForEvent('close', { timeout: 650 }).then(() => true).catch(() => false)
  await app.evaluate(async ({ BrowserWindow }, value) => {
    const presenters = BrowserWindow.getAllWindows().filter((win) =>
      !win.isDestroyed() && win.webContents.getURL().includes('-present.html')
    )
    for (const win of presenters) {
      const matched = await win.webContents.executeJavaScript(
        `window.__twRequestCloseToken === ${JSON.stringify(value)}`,
        true
      ).catch(() => false)
      if (matched) {
        win.close()
        return true
      }
    }
    presenters.at(-1)?.close()
    return presenters.length > 0
  }, token).catch(() => false)
  await closed
}

async function advance(pres, n = 1, ms = 260) {
  for (let i = 0; i < n; i += 1) {
    await pres.keyboard.press('ArrowRight')
    await pres.waitForTimeout(ms)
  }
}

const hashOf = (pres) => pres.evaluate(() => location.hash.replace(/^#/, ''))

async function advanceUntilHashStops(pres, ms = 260, maxSteps = 30) {
  let previous = await hashOf(pres)
  for (let i = 0; i < maxSteps; i += 1) {
    await advance(pres, 1, ms)
    const next = await hashOf(pres)
    if (next === previous) return { hash: next, steps: i + 1, stopped: true }
    previous = next
  }
  return { hash: previous, steps: maxSteps, stopped: false }
}

async function waitForToastShown(pres, buttonId, timeout = 5000) {
  return pres.waitForFunction(
    (id) => document.getElementById(id)?.closest('.twrec-toast')?.classList.contains('show') === true,
    buttonId,
    { timeout }
  ).then(() => true).catch(() => false)
}

try {
  const pres = await openPresenter()

  const injected = await pres.locator('#twrec-module').count()
  const pacingClock = await pres.locator('#twClock').count()
  record('REC module is injected and the presenter pacing clock remains', injected === 1 && pacingClock === 1, `rec=${injected} clock=${pacingClock}`)

  {
    const vis = async (id) => pres.locator('#' + id).isVisible().catch(() => false)
    const [rec, change, pau, sto, res] = await Promise.all([vis('twrec-primary'), vis('twrec-change-kind'), vis('twrec-pause'), vis('twrec-stop'), vis('twrec-resume')])
    record('idle shows Record only; obsolete Log control is gone',
      rec && !change && !pau && !res && !sto && await pres.locator('#twrec-log').count() === 0,
      `record=${rec} change=${change} pause=${pau} stop=${sto} resume=${res}`)
  }

  // Core recorded-run path, retained as a smoke test for audio capture and upload.
  const expectedIds = []
  await pres.keyboard.press('Shift+R')
  await pres.waitForTimeout(350)
  expectedIds.push(await hashOf(pres))
  const recState = await pres.locator('#twrec-module').getAttribute('data-rec')
  record('⇧R starts audio recording', recState === 'recording', `data-rec=${recState}`)
  await advance(pres, 1, 400)
  expectedIds.push(await hashOf(pres))
  await advance(pres, 1, 400)
  expectedIds.push(await hashOf(pres))
  await pres.keyboard.press('Shift+P')
  await pres.waitForTimeout(250)
  await advance(pres, 1, 500)
  const toastShown = await pres.locator('.twrec-toast.show', { hasText: 'Recording is paused' }).count()
  record('pause + slide move shows the resume toast', toastShown === 1, `toast=${toastShown}`)
  await pres.keyboard.press('Shift+P')
  await pres.waitForTimeout(300)
  await advance(pres, 1, 450)
  expectedIds.push(await hashOf(pres))

  const beforeRecorded = countSessions()
  await pres.keyboard.press('Shift+R')
  const recordedSaved = await waitFor(() => countSessions() > beforeRecorded, 6000)
  const recordedFile = listSessionFiles().sort()[listSessionFiles().length - 1]
  const recordedSession = recordedSaved ? readSessionFile(recordedFile) : null
  record('⇧R stops and saves an audio-attached session.json', recordedSaved && recordedSession?.audio !== null, `file=${recordedFile}`)
  record('audio .webm is written locally before upload', listWebms().length >= 1, `webms=${JSON.stringify(listWebms())}`)

  if (recordedSession) {
    const enters = recordedSession.slideTimeIndex.filter((m) => m.event === 'enter').map((m) => m.slideId)
    record('recorded slide-time index captures visited slides and excludes paused movement',
      JSON.stringify(enters) === JSON.stringify(expectedIds),
      `got=${JSON.stringify(enters)} expected=${JSON.stringify(expectedIds)}`)
    record('recorded runs default to kind=delivery', recordedSession.kind === 'delivery', `kind=${recordedSession.kind}`)
  }

  if (recordedSession) {
    await pres.locator('#twrec-change-kind').click()
    await pres.waitForSelector('.twrec-picker', { timeout: 3000 })
    await pres.locator('.twrec-kind[data-kind="rehearsal"]').click()
    const demoted = await waitFor(() => sessionById(recordedSession.id).kind === 'rehearsal', 5000)
    record('after recorded stop, the change control persists kind=rehearsal on disk', demoted, `kind=${sessionById(recordedSession.id).kind}`)
  }

  const uploadRes = recordedSession
    ? await page.evaluate(({ s, id }) => window.tw.recording.upload(s, id), { s: slug, id: recordedSession.id })
    : null
  const uploaded = await waitFor(() => recordedSession && sessionById(recordedSession.id)?.audio?.uploaded === true, 6000)
  const mockHasKey = recordedSession && existsSync(mockPath) && readFileSync(mockPath, 'utf8').split('\n').filter(Boolean).some((line) => {
    try {
      return JSON.parse(line).r2Key === `presentations/${slug}/${recordedSession.id}/audio.webm`
    } catch {
      return false
    }
  })
  record('on-request upload flips uploaded=true and logs the intended R2 key', !!uploadRes?.ok && uploaded && mockHasKey, `res=${JSON.stringify(uploadRes)} uploaded=${uploaded}`)

  // (a) L at start commits immediately, then later marks finalise the same run.
  {
    const p = await openPresenter()
    const before = new Set(listSessionFiles())
    await p.keyboard.press('l')
    await p.waitForSelector('.twrec-picker', { timeout: 4000 })
    await p.keyboard.press('Enter')
    const committed = await waitFor(() => listSessionFiles().some((f) => !before.has(f)), 5000)
    const file = newSessionSince(before)
    const initial = file ? readSessionFile(file) : null
    await advance(p, 2, 320)
    const finalised = await waitFor(() => {
      if (!initial) return false
      const s = sessionById(initial.id)
      return s.slideTimeIndex.filter((m) => m.event === 'enter').length >= 3 &&
        s.wallClockMs >= s.slideTimeIndex.at(-1).tMs
    }, 6000)
    await requestClose(p)
    record('L at the start saves a Delivery run and finalises later wall-clock marks',
      committed && initial?.audio === null && initial?.kind === 'delivery' && finalised,
      `committed=${committed} kind=${initial?.kind} finalised=${finalised}`)
  }

  // (b) Last-slide boundary raises the toast; Enter saves Delivery.
  {
    const p = await openPresenter()
    const before = new Set(listSessionFiles())
    const last = await advanceUntilHashStops(p, 260)
    const toast = await waitForToastShown(p, 'twrec-save-delivery')
    await p.keyboard.press('Enter')
    const saved = await waitFor(() => listSessionFiles().some((f) => !before.has(f)), 5000)
    const file = newSessionSince(before)
    const s = file ? readSessionFile(file) : null
    await requestClose(p)
    record('reaching the last slide offers Save; Enter saves a Delivery run',
      last.stopped && toast && saved && s?.kind === 'delivery' && s?.audio === null,
      `last=${last.hash} steps=${last.steps} stopped=${last.stopped} toast=${toast} saved=${saved} kind=${s?.kind}`)
  }

  // (c) Short unsaved peek closes without an offer and writes nothing.
  {
    const p = await openPresenter()
    const before = countSessions()
    const closed = p.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false)
    await requestClose(p)
    record('short unsaved run closes with no save offer and writes nothing', await closed && countSessions() === before, `before=${before} after=${countSessions()}`)
  }

  // (d) Gate-passing unsaved close shows the modal; Don't save writes nothing.
  {
    const p = await openPresenter()
    const before = countSessions()
    const last = await advanceUntilHashStops(p, 260)
    const toast = await waitForToastShown(p, 'twrec-save-delivery')
    await p.locator('#twrec-save-dismiss').click().catch(() => {})
    await requestClose(p)
    const modal = await p.waitForSelector('#twrec-close-discard', { timeout: 5000 }).then(() => true).catch(() => false)
    const closed = p.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false)
    await p.locator('#twrec-close-discard').click().catch(() => {})
    record('gate-passing unsaved close shows modal; Don’t save writes nothing',
      last.stopped && toast && modal && await closed && countSessions() === before,
      `last=${last.hash} steps=${last.steps} stopped=${last.stopped} toast=${toast} modal=${modal} before=${before} after=${countSessions()}`)
  }

  page = await appWindow()
  const listed = await page.evaluate((s) => window.tw.recording.listSessions(s), slug)
  record('tw.recording.listSessions returns saved sessions from the Vault', Array.isArray(listed) && listed.length === countSessions(), `listed=${Array.isArray(listed) ? listed.length : 'n/a'} disk=${countSessions()}`)

  // Studio is kind-blind for audio runs and excludes audio:null runs.
  const toolsPromise = app.waitForEvent('window')
  await page.evaluate(() => window.dispatchEvent(new Event('tw-open-studio')))
  const tools = await toolsPromise
  await tools.waitForLoadState('domcontentloaded').catch(() => {})
  const studioUp = await tools.waitForSelector('.twstudio', { timeout: 6000 }).then(() => true).catch(() => false)
  const cardCount = await tools.locator('.tws-scard').count()
  record('Studio opens and lists only audio-attached runs, regardless of kind', studioUp && cardCount === countRecordedSessions(), `studio=${studioUp} cards=${cardCount} recorded=${countRecordedSessions()}`)
  const closed = tools.waitForEvent('close', { timeout: 4000 }).then(() => true).catch(() => false)
  await tools.keyboard.press('Escape').catch(() => {})
  record('Esc closes the Tools window from Studio', await closed)
} catch (e) {
  record('recording harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== RECORDING SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
