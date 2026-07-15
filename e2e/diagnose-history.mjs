// Real-Electron harness for TalkWeaver History (ADR-0035, Plan 3 C3).
//
// Runs the app in TEST MODE (TW_REC_TEST=1): handout live checks are deterministic
// (mock-live URLs are live; everything else is offline) and recording upload short-circuits to the
// local mock log, so this exercises the real History and Studio surfaces without network.
//
// Checks:
//   (a) temp vault + userData fixture: two Talks, four recorded Sessions, one audio:null Run,
//       dummy local .webm files for the recorded Sessions only.
//   (b) History opens through the real tw-open-history event into the Tools window.
//   (c) ledger defaults to Delivery runs only; summary counts Deliveries.
//   (d) talk A rows show live handout badges; talk B shows unpublished.
//   (e) kind chips widen the ledger; tags render; Change kind persists to disk.
//   (f) Has recording filter toggles and search narrows the rows correctly.
//   (g) context edit persists back into the session.json on disk.
//   (h) a local session's Upload action flips audio.uploaded and updates the chip.
//   (i) audio:null Delivery runs render as not recorded, are excluded from Has-recording, and
//       never appear in Studio's rail.
//   (j) keyboard G cycles grouping; Esc closes the Tools window.
//   (k) Enter opens Studio with the selected History session active in the same Tools window.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-history.mjs
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`)
}

async function waitFor(pred, timeoutMs, stepMs = 150) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await Promise.resolve(pred())) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return false
}

function isoDaysAgo(days, hour = 10, minute = 0) {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-history-' + String(Date.now()) + '-'))
const tempVault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const recordingsDir = join(userDataDir, 'recordings')
const mockPath = join(userDataDir, 'recording-r2-mock.jsonl')

const talkA = {
  slug: 'history-alpha',
  title: 'History Alpha',
  dir: join(tempVault, 'history-alpha'),
  handout: 'https://mock-live.example/a'
}
const talkB = {
  slug: 'history-beta',
  title: 'History Beta',
  dir: join(tempVault, 'history-beta')
}

function outline(title, handoutUrl = null) {
  return [
    '---',
    `title: ${title}`,
    'duration: 30min',
    ...(handoutUrl ? [`handout_url: ${handoutUrl}`] : []),
    '---',
    '',
    '## Talk',
    '',
    '### Opening',
    '{id=opening}',
    '',
    `Welcome to ${title}.`,
    '',
    '### Close',
    '{id=close}',
    '',
    'Thank you.'
  ].join('\n')
}

function session({ id, talk, kind = 'delivery', startedAt, recordingMs, timerTargetMin, context, uploaded }) {
  return {
    id,
    talkSlug: talk.slug,
    talkTitle: talk.title,
    kind,
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + recordingMs).toISOString(),
    recordingMs,
    wallClockMs: recordingMs + 800,
    timerTargetMin,
    context,
    pathwayId: null,
    audio: {
      r2Key: `presentations/${talk.slug}/${id}/audio.webm`,
      bytes: 12,
      uploaded
    },
    transcript: null,
    slideTimeIndex: [
      { event: 'enter', slideId: 'opening', tMs: 0 },
      { event: 'enter', slideId: 'close', tMs: Math.max(1000, recordingMs - 1000) }
    ]
  }
}

function runSession({ id, talk, kind = 'delivery', startedAt, wallClockMs, timerTargetMin, context }) {
  return {
    id,
    talkSlug: talk.slug,
    talkTitle: talk.title,
    kind,
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + wallClockMs).toISOString(),
    recordingMs: 0,
    wallClockMs,
    timerTargetMin,
    context,
    pathwayId: null,
    audio: null,
    transcript: null,
    slideTimeIndex: [
      { event: 'enter', slideId: 'opening', tMs: 0 },
      { event: 'enter', slideId: 'close', tMs: Math.max(1000, wallClockMs - 1000) }
    ]
  }
}

mkdirSync(talkA.dir, { recursive: true })
mkdirSync(talkB.dir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
mkdirSync(recordingsDir, { recursive: true })
writeFileSync(join(talkA.dir, `${talkA.slug}-outline.md`), outline(talkA.title, talkA.handout), 'utf8')
writeFileSync(join(talkB.dir, `${talkB.slug}-outline.md`), outline(talkB.title), 'utf8')
writeFileSync(
  join(userDataDir, 'config.json'),
  JSON.stringify(
    { vaultRoot: tempVault, recordingDiscardMs: 800, recordingR2Endpoint: 'https://mock.r2.test', recordingR2Bucket: 'mock-bucket' },
    null,
    2
  ),
  'utf8'
)

const sessions = [
  session({
    id: 'hist-a-new',
    talk: talkA,
    kind: 'delivery',
    startedAt: isoDaysAgo(0, 11, 15),
    recordingMs: 31 * 60_000,
    timerTargetMin: 30,
    context: 'Morning keynote',
    uploaded: true
  }),
  session({
    id: 'hist-a-local',
    talk: talkA,
    kind: 'rehearsal',
    startedAt: isoDaysAgo(2, 14, 30),
    recordingMs: 27 * 60_000,
    timerTargetMin: 30,
    context: 'Workshop rehearsal',
    uploaded: false
  }),
  session({
    id: 'hist-b-only',
    talk: talkB,
    kind: 'delivery',
    startedAt: isoDaysAgo(12, 9, 5),
    recordingMs: 18 * 60_000,
    timerTargetMin: 20,
    context: 'Guest seminar',
    uploaded: false
  }),
  session({
    id: 'hist-a-recording',
    talk: talkA,
    kind: 'recording',
    startedAt: isoDaysAgo(4, 13, 10),
    recordingMs: 22 * 60_000,
    timerTargetMin: 25,
    context: 'Dictated handout',
    uploaded: false
  }),
  runSession({
    id: 'hist-b-log',
    talk: talkB,
    kind: 'delivery',
    startedAt: isoDaysAgo(1, 16, 45),
    wallClockMs: 16 * 60_000,
    timerTargetMin: 20,
    context: 'Delivered without recording'
  })
]

for (const s of sessions) {
  const dir = join(tempVault, '_PRESENTATIONS', s.talkSlug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${s.id}.json`), JSON.stringify(s, null, 2), 'utf8')
  if (s.audio !== null) writeFileSync(join(recordingsDir, `${s.id}.webm`), 'mock-webm-data', 'utf8')
}

const sessionPath = (s) => join(tempVault, '_PRESENTATIONS', s.talkSlug, `${s.id}.json`)
const row = (page, id) => page.locator(`[data-history-sid="${id}"]`)

const app = await electron.launch({
  args: ['.', '--user-data-dir=' + userDataDir],
  cwd: REPO,
  env: { ...process.env, TW_REC_TEST: '1' }
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

async function openHistoryWindow() {
  await page.bringToFront()
  const winPromise = app.waitForEvent('window')
  await page.evaluate(() => window.dispatchEvent(new Event('tw-open-history')))
  const tools = await winPromise
  await tools.waitForLoadState('domcontentloaded')
  await tools.bringToFront()
  return tools
}

try {
  let tools = await openHistoryWindow()
  const opened = await tools.waitForSelector('.twhistory', { timeout: 6000 }).then(() => true).catch(() => false)
  record('History opens via tw-open-history', opened)

  const rowsReady = await tools.waitForSelector('[data-history-sid]', { timeout: 6000 }).then(() => true).catch(() => false)
  const rowCount = await tools.locator('[data-history-sid]').count()
  record('History defaults to Delivery runs only', rowsReady && rowCount === 3, `rows=${rowCount}`)

  const dateActive = await tools.locator('.twh-segwrap', { hasText: 'Group' }).locator('button.active').textContent().catch(() => '')
  const groupCount = await tools.locator('.twh-group').count()
  record('default grouping is Date and rows are grouped', dateActive?.trim() === 'Date' && groupCount >= 2, `active=${dateActive?.trim()} groups=${groupCount}`)

  const summary = ((await tools.locator('.twh-summary').textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
  const summaryOk = summary.includes('2 talks delivered') && summary.includes('2 recorded') && await waitFor(async () => {
    const t = ((await tools.locator('.twh-summary').textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
    return t.includes('1 still live')
  }, 6000)
  const summaryAfterLive = ((await tools.locator('.twh-summary').textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
  record('summary counts Delivery talks, recordings, and live handouts only', summaryOk, summaryOk ? summaryAfterLive : summary)

  const badgesReady = await waitFor(async () => {
    const aLive = await tools.locator(`[data-history-sid="${sessions[0].id}"] .live-badge.live`).count()
    const bUnpub = await tools.locator(`[data-history-sid="${sessions[2].id}"] .live-badge.unpub`).count()
    const logUnpub = await tools.locator(`[data-history-sid="${sessions[4].id}"] .live-badge.unpub`).count()
    return aLive === 1 && bUnpub === 1 && logUnpub === 1
  }, 6000)
  record('Delivery rows show live/unpublished handout badges correctly', badgesReady)

  const deliveryChip = await tools.locator('.twh-chip.kind.delivery.on').count()
  const rehearsalHidden = await row(tools, sessions[1].id).count()
  const recordingHidden = await row(tools, sessions[3].id).count()
  record('Delivery kind chip is active by default; Rehearsal/Recording rows are hidden',
    deliveryChip === 1 && rehearsalHidden === 0 && recordingHidden === 0,
    `deliveryChip=${deliveryChip} rehearsalRows=${rehearsalHidden} recordingRows=${recordingHidden}`)

  await tools.locator('.twh-chip.kind.rehearsal').click()
  await tools.locator('.twh-chip.kind.recording').click()
  await tools.waitForTimeout(300)
  const widenedRows = await tools.locator('[data-history-sid]').count()
  const rehearsalTag = await row(tools, sessions[1].id).locator('.twh-kind-tag.rehearsal', { hasText: 'Rehearsal' }).count()
  const recordingTag = await row(tools, sessions[3].id).locator('.twh-kind-tag.recording', { hasText: 'Recording' }).count()
  const deliveryTags = await tools.locator('.twh-kind-tag.delivery', { hasText: 'Delivery' }).count()
  record('kind chips widen the ledger and row kind tags render', widenedRows === 5 && rehearsalTag === 1 && recordingTag === 1 && deliveryTags >= 3, `rows=${widenedRows} rehearsalTag=${rehearsalTag} recordingTag=${recordingTag} deliveryTags=${deliveryTags}`)

  await row(tools, sessions[1].id).locator('.twh-kebab').click()
  await tools.locator('.twh-menu button', { hasText: 'Change kind' }).click()
  await tools.locator('.twh-kind-choice button', { hasText: 'Delivery' }).click()
  const kindSaved = await waitFor(() => {
    const onDisk = JSON.parse(readFileSync(sessionPath(sessions[1]), 'utf8'))
    return onDisk.kind === 'delivery'
  }, 5000)
  const changedTag = await waitFor(async () => (await row(tools, sessions[1].id).locator('.twh-kind-tag.delivery', { hasText: 'Delivery' }).count()) === 1, 6000).then((ok) => ok ? 1 : 0)
  record('Change kind in the kebab persists to disk and updates the row tag', kindSaved && changedTag === 1, `disk=${kindSaved} tag=${changedTag}`)

  const logRecText = ((await row(tools, sessions[4].id).locator('.twh-rec').textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
  const logMuted = await row(tools, sessions[4].id).locator('.wave.muted').count()
  const logStudioLinks = await row(tools, sessions[4].id).locator('.studio-link').count()
  const logUploadControls = await row(tools, sessions[4].id).locator('.upl').count()
  record('audio:null Delivery run renders as not recorded with delivered duration and no Studio/Upload action',
    /not recorded/i.test(logRecText) && /16m delivered/i.test(logRecText) && logMuted === 1 && logStudioLinks === 0 && logUploadControls === 0,
    `text=${logRecText} muted=${logMuted} studioLinks=${logStudioLinks} upload=${logUploadControls}`)

  await tools.locator('.twh-chip', { hasText: 'Has recording' }).click()
  await tools.waitForTimeout(250)
  const filteredCount = await tools.locator('[data-history-sid]').count()
  const chipOn = await tools.locator('.twh-chip.on', { hasText: 'Has recording' }).count()
  const logStillVisible = await row(tools, sessions[4].id).count()
  record('Has recording filter toggles on, keeps audio runs across kinds, and excludes audio:null runs',
    chipOn === 1 && filteredCount === 4 && logStillVisible === 0,
    `chipOn=${chipOn} rows=${filteredCount} logRows=${logStillVisible}`)

  await tools.locator('.twh-searchfield input').fill('guest seminar')
  await tools.waitForTimeout(300)
  const searchRows = await tools.locator('[data-history-sid]').count()
  const searchSid = await tools.locator('[data-history-sid]').first().getAttribute('data-history-sid').catch(() => null)
  record('search narrows History to the matching session', searchRows === 1 && searchSid === sessions[2].id, `rows=${searchRows} sid=${searchSid}`)

  await tools.locator('.twh-chip.clear').click()
  await tools.waitForTimeout(300)

  await row(tools, sessions[1].id).locator('.twh-stamp').click()
  await tools.keyboard.press('E')
  const editInput = row(tools, sessions[1].id).locator('.ctx-input')
  await editInput.fill('Edited after audience questions')
  await tools.keyboard.press('Enter')
  const contextSaved = await waitFor(() => {
    const onDisk = JSON.parse(readFileSync(sessionPath(sessions[1]), 'utf8'))
    return onDisk.context === 'Edited after audience questions'
  }, 5000)
  const contextText = await row(tools, sessions[1].id).locator('.ctx-text').textContent().catch(() => '')
  record('context edit persists to the session.json on disk', contextSaved && contextText === 'Edited after audience questions', `disk=${contextSaved} ui=${contextText}`)

  await row(tools, sessions[1].id).locator('.upl.local button', { hasText: 'Upload' }).click()
  const uploadSaved = await waitFor(() => {
    const onDisk = JSON.parse(readFileSync(sessionPath(sessions[1]), 'utf8'))
    return onDisk.audio?.uploaded === true
  }, 6000)
  const uploadChip = ((await row(tools, sessions[1].id).locator('.upl.r2').textContent().catch(() => '')) || '').trim()
  const mockHasKey = existsSync(mockPath) && readFileSync(mockPath, 'utf8').split('\n').filter(Boolean).some((line) => {
    try {
      return JSON.parse(line).r2Key === `presentations/${sessions[1].talkSlug}/${sessions[1].id}/audio.webm`
    } catch {
      return false
    }
  })
  record('local Upload action flips uploaded=true and updates the chip', uploadSaved && /in R2/i.test(uploadChip) && mockHasKey, `uploaded=${uploadSaved} chip=${uploadChip} mockKey=${mockHasKey}`)

  const beforeGroup = await tools.locator('.twh-segwrap', { hasText: 'Group' }).locator('button.active').textContent().catch(() => '')
  await tools.keyboard.press('G')
  await tools.waitForTimeout(250)
  const afterGroup = await tools.locator('.twh-segwrap', { hasText: 'Group' }).locator('button.active').textContent().catch(() => '')
  record('keyboard G cycles grouping', beforeGroup?.trim() === 'Date' && afterGroup?.trim() === 'Month', `before=${beforeGroup?.trim()} after=${afterGroup?.trim()}`)

  const closed = tools.waitForEvent('close', { timeout: 4000 }).then(() => true).catch(() => false)
  await tools.keyboard.press('Escape').catch(() => {})
  record('Esc closes the Tools window from History', await closed)

  tools = await openHistoryWindow()
  await tools.waitForSelector('.twhistory', { timeout: 6000 })
  await row(tools, sessions[2].id).locator('.twh-stamp').click()
  await tools.keyboard.press('Enter')
  const studioUp = await tools.waitForSelector('.twstudio', { timeout: 6000 }).then(() => true).catch(() => false)
  const activeSid = await tools.locator('.tws-scard.active').getAttribute('data-sid').catch(() => null)
  const logStudioCard = await tools.locator(`.tws-scard[data-sid="${sessions[4].id}"]`).count()
  const recordingKindCard = await tools.locator(`.tws-scard[data-sid="${sessions[3].id}"]`).count()
  record('Enter opens Studio with that session active; Studio includes audio runs of any kind and excludes audio:null runs',
    studioUp && activeSid === sessions[2].id && logStudioCard === 0 && recordingKindCard === 1,
    `studio=${studioUp} active=${activeSid} logCards=${logStudioCard} recordingKindCards=${recordingKindCard}`)
} catch (e) {
  record('history harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== HISTORY SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
