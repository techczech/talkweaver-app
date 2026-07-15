// Real-Electron harness for TalkWeaver Studio replay (ADR-0002 / R2).
//
// Runs the app in TEST MODE (TW_REC_TEST=1) with a temp Vault, one Talk, one pre-written
// audio-attached Session, and no live mic. The fixture is outline-v2: a LEAF {carousel} slide
// whose top-level blocks compile to full-bleed carousel sub-slides carrying [data-fragment]
// (all but the first), so the runtime has real fragments to hide/show — 2 hidden on arrival,
// 0 when fully revealed, matching the session's reveal marks exactly as the legacy ####-cards
// fixture did. (#### headings are their own beat-slides under heading-is-slide, so in-slide
// reveal steps must come from a block carousel now.)
//
// Checks:
//   (a) Studio embeds a twpresent:// iframe with replay=1&audience=1.
//   (b) Seeking just past a reveal mark drives the iframe to the expected slide and hidden count.
//   (c) Seeking past a highlight mark applies mark.hl-mark to the expected block.
//   (d) Seeking back to 0 restores hidden fragments and clears the highlight.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-replay.mjs
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
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

const slug = 'replay-fixture'
const sessionId = 'replay-session'
const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-replay-' + String(Date.now()) + '-'))
const tempVault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const recordingsDir = join(userDataDir, 'recordings')
const talkDir = join(tempVault, slug)
const outlinePath = join(talkDir, `${slug}-outline.md`)
const sessionsDir = join(tempVault, '_PRESENTATIONS', slug)

const OUTLINE = [
  '---',
  'title: Replay Fixture',
  'duration: 10min',
  'outline_version: 2',
  '---',
  '',
  '## Replay {id=replay}',
  '',
  '### Replay cards {id=replay-cards}',
  '{carousel}',
  '',
  'Replay alpha point.',
  '',
  'Replay beta point.',
  '',
  'Replay gamma point.'
].join('\n')

mkdirSync(talkDir, { recursive: true })
mkdirSync(sessionsDir, { recursive: true })
mkdirSync(recordingsDir, { recursive: true })
writeFileSync(outlinePath, OUTLINE, 'utf8')
writeFileSync(
  join(userDataDir, 'config.json'),
  JSON.stringify({ vaultRoot: tempVault, recordingDiscardMs: 800 }, null, 2),
  'utf8'
)
writeFileSync(join(recordingsDir, `${sessionId}.webm`), 'mock-webm-data', 'utf8')

const startedAt = new Date().toISOString()
const session = {
  id: sessionId,
  talkSlug: slug,
  talkTitle: 'Replay Fixture',
  kind: 'recording',
  startedAt,
  endedAt: new Date(Date.parse(startedAt) + 5000).toISOString(),
  recordingMs: 5000,
  wallClockMs: 5200,
  timerTargetMin: 10,
  context: 'Replay harness',
  pathwayId: null,
  audio: { r2Key: `presentations/${slug}/${sessionId}/audio.webm`, bytes: 14, uploaded: false },
  transcript: null,
  slideTimeIndex: [
    { event: 'enter', slideId: 'replay-cards', tMs: 0 },
    { event: 'reveal', slideId: 'replay-cards', hidden: 2, tMs: 0 },
    { event: 'reveal', slideId: 'replay-cards', hidden: 0, tMs: 2000 },
    { event: 'highlight', slideId: 'replay-cards', marks: 1, ranges: [{ block: 0, start: 0, end: 6 }], tMs: 3200 }
  ]
}
writeFileSync(join(sessionsDir, `${sessionId}.json`), JSON.stringify(session, null, 2), 'utf8')

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

async function replayFrame(tools) {
  for (let i = 0; i < 60; i += 1) {
    const frame = tools.frames().find((f) => f.url().startsWith('twpresent://'))
    if (frame) return frame
    await tools.waitForTimeout(150)
  }
  return null
}

async function seekAudio(tools, seconds) {
  await tools.locator('audio').evaluate((audio, t) => {
    audio.currentTime = t
    audio.dispatchEvent(new Event('timeupdate', { bubbles: true }))
  }, seconds)
  await tools.waitForTimeout(350)
}

try {
  const tools = await openStudioWindow()
  const studioUp = await tools.waitForSelector('.twstudio', { timeout: 8000 }).then(() => true).catch(() => false)
  const activeSid = await tools.locator('.tws-scard.active').getAttribute('data-sid').catch(() => null)
  record('Studio opens with the replay fixture session active', studioUp && activeSid === sessionId, `active=${activeSid}`)

  const iframe = tools.locator('iframe.tws-replay-frame')
  const iframeSrc = await iframe.getAttribute('src', { timeout: 10000 }).catch(() => '')
  const urlOk = /^twpresent:\/\/replay-fixture\/replay-fixture-present\.html\?/.test(iframeSrc || '') &&
    iframeSrc.includes('replay=1') && iframeSrc.includes('audience=1')
  record('monitor iframe loads twpresent:// with replay and audience params', urlOk, iframeSrc || 'no iframe src')

  const frame = await replayFrame(tools)
  record('Playwright can access the replay iframe', !!frame, frame?.url() || '')

  if (frame) {
    await seekAudio(tools, 2.1)
    const revealOk = await waitFor(async () => {
      return frame.evaluate(() => {
        const active = document.querySelector('.slide.active')
        return {
          id: active?.getAttribute('data-id') || '',
          hidden: active?.querySelectorAll('.hidden-fragment').length ?? -1
        }
      }).then((state) => state.id === 'replay-cards' && state.hidden === 0).catch(() => false)
    }, 6000)
    const revealState = frame
      ? await frame.evaluate(() => {
        const active = document.querySelector('.slide.active')
        return `${active?.getAttribute('data-id') || ''}:${active?.querySelectorAll('.hidden-fragment').length ?? -1}`
      }).catch(() => 'n/a')
      : 'n/a'
    record('seeking past reveal mark applies slide id and hidden count inside iframe', revealOk, revealState)

    await seekAudio(tools, 3.4)
    const highlightOk = await waitFor(async () => {
      return frame.evaluate(() => {
        const block = document.querySelector('.slide.active h1,.slide.active h2,.slide.active h3,.slide.active h4,.slide.active p,.slide.active li')
        return block?.querySelector('mark.hl-mark')?.textContent === 'Replay'
      }).catch(() => false)
    }, 6000)
    const markedText = await frame.evaluate(() => document.querySelector('.slide.active mark.hl-mark')?.textContent || '').catch(() => '')
    record('seeking past highlight mark applies mark.hl-mark in the expected block', highlightOk, markedText)

    await seekAudio(tools, 0)
    const resetOk = await waitFor(async () => {
      return frame.evaluate(() => {
        const active = document.querySelector('.slide.active')
        return {
          hidden: active?.querySelectorAll('.hidden-fragment').length ?? -1,
          marks: active?.querySelectorAll('mark.hl-mark').length ?? -1
        }
      }).then((state) => state.hidden === 2 && state.marks === 0).catch(() => false)
    }, 6000)
    const resetState = await frame.evaluate(() => {
      const active = document.querySelector('.slide.active')
      return `${active?.querySelectorAll('.hidden-fragment').length ?? -1}:${active?.querySelectorAll('mark.hl-mark').length ?? -1}`
    }).catch(() => 'n/a')
    record('seeking back to 0 restores hidden fragments and clears highlight', resetOk, resetState)
  }
} catch (e) {
  record('replay harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== REPLAY SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
