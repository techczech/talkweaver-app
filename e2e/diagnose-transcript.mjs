// Real-Electron harness for Studio transcript-driven trims (ADR-0003 / T3).
//
// Runs the app in TEST MODE (TW_REC_TEST=1) with a temp Vault, one Talk, one audio-bearing
// Session, and a small local WebM placeholder. The transcription bridge writes a deterministic
// fixture transcript, so this does not need Python or Parakeet.
//
// Checks:
//   (a) Transcribe renders fixture segments.
//   (b) Clicking a segment seeks the audio and ] steps to the next segment.
//   (c) One tap trims the second segment and writes session.json trims.
//   (d) Playback timeupdate skips over the trim.
//   (e) One tap restores the segment and removes trims from disk/UI.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-transcript.mjs
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(pred, timeoutMs, stepMs = 150) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await Promise.resolve(pred())) return true
    await sleep(stepMs)
  }
  return false
}

const slug = 'transcript-fixture'
const sessionId = 'transcript-session'
const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-transcript-' + String(Date.now()) + '-'))
const tempVault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const recordingsDir = join(userDataDir, 'recordings')
const talkDir = join(tempVault, slug)
const outlinePath = join(talkDir, `${slug}-outline.md`)
const sessionsDir = join(tempVault, '_PRESENTATIONS', slug)
const sessionPath = join(sessionsDir, `${sessionId}.json`)

const OUTLINE = [
  '---',
  'title: Transcript Fixture',
  'duration: 1min',
  '---',
  '',
  '## Talk',
  '',
  '### Transcript fixture slide {id=transcript-slide}',
  '',
  'This slide exists so Studio can build a replay frame.'
].join('\n')

mkdirSync(talkDir, { recursive: true })
mkdirSync(sessionsDir, { recursive: true })
mkdirSync(recordingsDir, { recursive: true })
writeFileSync(outlinePath, OUTLINE, 'utf8')
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: tempVault, recordingDiscardMs: 800 }, null, 2), 'utf8')
writeFileSync(join(recordingsDir, `${sessionId}.webm`), 'mock-webm-data', 'utf8')

const startedAt = new Date().toISOString()
const session = {
  id: sessionId,
  talkSlug: slug,
  talkTitle: 'Transcript Fixture',
  kind: 'recording',
  startedAt,
  endedAt: new Date(Date.parse(startedAt) + 30000).toISOString(),
  recordingMs: 30000,
  wallClockMs: 30500,
  timerTargetMin: 1,
  context: 'Transcript harness',
  pathwayId: null,
  audio: { r2Key: `presentations/${slug}/${sessionId}/audio.webm`, bytes: 14, uploaded: false },
  transcript: null,
  slideTimeIndex: [{ event: 'enter', slideId: 'transcript-slide', tMs: 0 }]
}
writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8')

const readSession = () => JSON.parse(readFileSync(sessionPath, 'utf8'))

const app = await electron.launch({
  args: ['.', '--user-data-dir=' + userDataDir],
  cwd: REPO,
  env: { ...process.env, TW_REC_TEST: '1' }
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

async function openStudioWindow() {
  await page.bringToFront()
  const winPromise = app.waitForEvent('window')
  await page.evaluate(() => window.dispatchEvent(new Event('tw-open-studio')))
  const tools = await winPromise
  await tools.waitForLoadState('domcontentloaded')
  await tools.bringToFront()
  return tools
}

async function audioTime(tools) {
  return tools.locator('audio').evaluate((audio) => audio.currentTime).catch(() => -1)
}

async function seekAudio(tools, seconds) {
  await tools.locator('audio').evaluate((audio, t) => {
    audio.currentTime = t
    audio.dispatchEvent(new Event('timeupdate', { bubbles: true }))
  }, seconds)
  await tools.waitForTimeout(250)
}

try {
  const tools = await openStudioWindow()
  const studioUp = await tools.waitForSelector('.twstudio', { timeout: 8000 }).then(() => true).catch(() => false)
  const activeSid = await tools.locator('.tws-scard.active').getAttribute('data-sid').catch(() => null)
  record('Studio opens with the transcript fixture session active', studioUp && activeSid === sessionId, `active=${activeSid}`)

  await tools.locator('button.tws-btn.primary', { hasText: 'Transcribe' }).click({ timeout: 8000 })
  const segmentCount = await waitFor(async () => await tools.locator('.tws-ts-seg').count() === 3, 6000)
  const middleText = await tools.locator('.tws-ts-seg').nth(1).locator('.tws-ts-text').textContent().catch(() => '')
  record('Transcribe renders the deterministic fixture transcript', segmentCount && /middle segment/.test(middleText || ''), `middle=${middleText}`)

  await tools.locator('.tws-ts-seg').nth(0).click()
  const clickSeekOk = await waitFor(async () => Math.abs(await audioTime(tools) - 0) < 0.25, 2500)
  record('clicking a segment seeks the audio to that segment', clickSeekOk, `time=${await audioTime(tools)}`)

  await tools.keyboard.press(']')
  const stepOk = await waitFor(async () => Math.abs(await audioTime(tools) - 8) < 0.35, 3000)
  record('] steps to the next transcript segment', stepOk, `time=${await audioTime(tools)}`)

  await tools.locator('.tws-ts-seg').nth(1).locator('.tws-ts-trim').click()
  const trimWritten = await waitFor(() => {
    const trims = readSession().trims
    return Array.isArray(trims) && trims.length === 1 && trims[0].start === 8000 && trims[0].end === 18000
  }, 5000)
  let trimmedClass = ''
  const trimmedClassOk = await waitFor(async () => {
    trimmedClass = await tools.locator('.tws-ts-seg').nth(1).getAttribute('class').catch(() => '')
    return /\btrimmed\b/.test(trimmedClass || '')
  }, 5000)
  record('one tap trims the second segment and writes session.json', trimWritten && trimmedClassOk, `trims=${JSON.stringify(readSession().trims)} class=${trimmedClass}`)

  await seekAudio(tools, 7.95)
  await seekAudio(tools, 8.05)
  const skippedTo = await audioTime(tools)
  record('timeupdate skips playback over the trimmed region', skippedTo >= 17.9, `time=${skippedTo}`)

  await tools.locator('.tws-ts-seg').nth(1).locator('.tws-ts-trim').click()
  const trimRemoved = await waitFor(() => {
    const trims = readSession().trims ?? []
    return trims.length === 0
  }, 5000)
  let restoredClass = ''
  const restoredClassOk = await waitFor(async () => {
    restoredClass = await tools.locator('.tws-ts-seg').nth(1).getAttribute('class').catch(() => '')
    return !/\btrimmed\b/.test(restoredClass || '')
  }, 5000)
  record('one tap restores the segment and removes the trim', trimRemoved && restoredClassOk, `trims=${JSON.stringify(readSession().trims)} class=${restoredClass}`)
} catch (e) {
  record('transcript harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== TRANSCRIPT SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
