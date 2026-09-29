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
//   (l) ticket 07 (L6): a Run's instant slides list inside the selected card; "Add to talk" inserts
//       exactly one slide after its anchor (byte diff on disk), refuses a vanished anchor without
//       writing, reads "Added after slide N" and still does after History is reopened; with the talk
//       open in the editor holding an unsaved edit, the slide goes in through the editor buffer and
//       both survive the save.
//   (m) review fixes, editor route: an insertion while an autosave is still in flight waits for it
//       and lands after it (the stale write can never overwrite the slide); a save that fails leaves
//       the entry un-added with a human error, the slide undoable in the editor, and "Add to talk"
//       offered again (which then succeeds).
//   (n) third review: in the slides-only view (⌘3) an Inspector option is changed and "Add to talk"
//       is pressed at once, inside the Inspector's autosave delay. The real WorkspaceLayout commit and
//       the Editor's external-edit route run together: the option AND the slide are both on disk, and
//       the editor buffer agrees with the file.
//   (o) one writer for talk files (spec test 5): a slide reorder in the strip, then "Add to talk" at
//       once. The reorder goes into the editor buffer (no remount, no re-read of the file) and is
//       saved through the talk's queue; the slide goes in through the same buffer. Both are on disk
//       and the editor buffer equals the file.
//   (p) one writer: a slide inserted from the Slide Browser at the caret is saved AT ONCE through the
//       talk's queue — it is on disk well inside the editor's 1.5 s autosave delay (so the insert did
//       not wait for the autosave), and the file equals the editor buffer.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-history.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
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
const shownAt = Date.parse(isoDaysAgo(1, 16, 50))
sessions[4].instantSlides = [
  { id: `text-${shownAt}`, kind: 'text', shownAt, afterSlideId: 'opening', text: 'Try it now: ask the person next to you.' },
  { id: `countdown-${shownAt + 60_000}`, kind: 'countdown', shownAt: shownAt + 60_000, afterSlideId: 'vanished', durationMs: 300_000, label: 'Discussion' }
]
sessions[0].instantSlides = [
  { id: `link-${shownAt}`, kind: 'link', shownAt, afterSlideId: 'opening', url: 'https://example.org/resource' },
  // Review fixes: added while an autosave is in flight, and added while the save fails.
  { id: `text-${shownAt + 1000}`, kind: 'text', shownAt: shownAt + 1000, afterSlideId: 'close', text: 'In flight slide text' },
  { id: `text-${shownAt + 2000}`, kind: 'text', shownAt: shownAt + 2000, afterSlideId: 'opening', text: 'Failed save slide text' },
  // Third review: added straight after an Inspector option change made in the slides-only view.
  { id: `text-${shownAt + 3000}`, kind: 'text', shownAt: shownAt + 3000, afterSlideId: 'close', text: 'Inspector race slide text' },
  // One writer (spec test 5): added straight after a slide reorder in the strip.
  { id: `text-${shownAt + 4000}`, kind: 'text', shownAt: shownAt + 4000, afterSlideId: 'opening', text: 'Reorder race slide text' }
]

for (const s of sessions) {
  const dir = join(tempVault, '_PRESENTATIONS', s.talkSlug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${s.id}.json`), JSON.stringify(s, null, 2), 'utf8')
  if (s.audio !== null) writeFileSync(join(recordingsDir, `${s.id}.webm`), 'mock-webm-data', 'utf8')
}

const sessionPath = (s) => join(tempVault, '_PRESENTATIONS', s.talkSlug, `${s.id}.json`)
const row = (page, id) => page.locator(`[data-history-sid="${id}"]`)

await ensureFreshBuild(REPO)
const app = await electron.launch({
  args: ['.', '--user-data-dir=' + userDataDir],
  cwd: REPO,
  env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
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

  // (l) Instant slides after the talk — file route (talk B is not open in any editor).
  const outlineB = join(talkB.dir, `${talkB.slug}-outline.md`)
  const outlineA = join(talkA.dir, `${talkA.slug}-outline.md`)
  tools = await openHistoryWindow()
  await tools.waitForSelector('.twhistory', { timeout: 6000 })
  await row(tools, sessions[4].id).locator('.twh-stamp').click()
  const isl = row(tools, sessions[4].id).locator('.isl')
  const islRows = await isl.locator('.isl-row').count().catch(() => 0)
  const islHead = ((await isl.locator('.isl-h').textContent().catch(() => '')) || '').replace(/\s+/g, ' ')
  const textRow = isl.locator('.isl-row').nth(0)
  const goneRow = isl.locator('.isl-row').nth(1)
  const anchorShown = await waitFor(async () => /after slide 3\s*Opening/.test(((await textRow.locator('.isl-when').textContent().catch(() => '')) || '')), 6000)
  const goneShown = /no longer in the talk/.test(((await goneRow.locator('.isl-when').textContent().catch(() => '')) || ''))
  const kinds = [((await textRow.locator('.isl-kind').textContent()) || '').trim(), ((await goneRow.locator('.isl-kind').textContent()) || '').trim()]
  record('selected Run card lists its instant slides with kind, time and the slide each followed (L6)',
    islRows === 2 && /Instant slides shown · 2/.test(islHead) && anchorShown && goneShown && kinds[0] === 'Text' && /Countdown · 5 min/.test(kinds[1]),
    `rows=${islRows} head=${islHead} anchor=${anchorShown} gone=${goneShown} kinds=${kinds.join('|')}`)

  const beforeB = readFileSync(outlineB, 'utf8')
  await textRow.locator('button.isl-add').click()
  const addedLabel = await waitFor(async () => /Added after slide 3/.test(((await textRow.locator('.isl-add.done').textContent().catch(() => '')) || '')), 8000)
  const afterB = readFileSync(outlineB, 'utf8')
  // Byte diff: old = prefix + suffix and new = prefix + one slide + suffix, split at the anchor's end.
  const splitAt = beforeB.indexOf('### Close')
  const inserted = afterB.slice(splitAt, afterB.length - (beforeB.length - splitAt))
  const byteDiffOk = splitAt > 0 && afterB.length > beforeB.length
    && Buffer.from(afterB.slice(0, splitAt)).equals(Buffer.from(beforeB.slice(0, splitAt)))
    && Buffer.from(afterB.slice(splitAt + inserted.length)).equals(Buffer.from(beforeB.slice(splitAt)))
    && inserted.startsWith('### Try it now: ask the person next to you.\n{statement} {id=')
    && (inserted.match(/^#{1,6} /gm) || []).length === 1
  const runB = JSON.parse(readFileSync(sessionPath(sessions[4]), 'utf8'))
  record('Add to talk inserts exactly one slide after its anchor, and the button reads Added after slide N',
    addedLabel && byteDiffOk && runB.instantSlides?.[0]?.added?.afterSlideNumber === 3,
    `label=${addedLabel} byteDiff=${byteDiffOk} added=${JSON.stringify(runB.instantSlides?.[0]?.added)}`)

  await goneRow.locator('button.isl-add').click()
  const refusal = await waitFor(async () => /no longer in the talk/i.test(((await goneRow.locator('.isl-err').textContent().catch(() => '')) || '')), 8000)
  record('a vanished anchor refuses with a human message and writes nothing',
    refusal && readFileSync(outlineB, 'utf8') === afterB && !JSON.parse(readFileSync(sessionPath(sessions[4]), 'utf8')).instantSlides?.[1]?.added,
    `refusal=${refusal}`)

  let closedAgain = tools.waitForEvent('close', { timeout: 4000 }).then(() => true).catch(() => false)
  await tools.keyboard.press('Escape').catch(() => {})
  await closedAgain
  tools = await openHistoryWindow()
  await tools.waitForSelector('.twhistory', { timeout: 6000 })
  await row(tools, sessions[4].id).locator('.twh-stamp').click()
  const survives = await waitFor(async () => /Added after slide 3/.test(((await row(tools, sessions[4].id).locator('.isl-row').nth(0).locator('.isl-add.done').textContent().catch(() => '')) || '')), 6000)
  record('Added after slide N survives reopening History', survives)

  // Editor route: talk A open in the main window with an UNSAVED edit; the slide goes in through the
  // editor buffer, so neither the edit nor the slide is lost to the other's write.
  await page.bringToFront()
  await openTalkByTitle(page, talkA.title)
  await page.locator('.cm-content .cm-line', { hasText: 'Welcome to History Alpha.' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' UNSAVEDMARK')
  const unsavedOnDisk = readFileSync(outlineA, 'utf8').includes('UNSAVEDMARK')
  await tools.bringToFront()
  await row(tools, sessions[0].id).locator('.twh-stamp').click()
  const linkRow = row(tools, sessions[0].id).locator('.isl-row').nth(0)
  await linkRow.locator('button.isl-add').click()
  const editorAdded = await waitFor(async () => /Added after slide 3/.test(((await linkRow.locator('.isl-add.done').textContent().catch(() => '')) || '')), 10000)
  const bufferHasBoth = await waitFor(async () => {
    const text = (await page.locator('.cm-content').first().textContent().catch(() => '')) || ''
    return text.includes('UNSAVEDMARK') && text.includes('### example.org')
  }, 6000)
  await page.waitForTimeout(2500) // past the editor's 1.5s autosave debounce
  const diskA = readFileSync(outlineA, 'utf8')
  const slideAt = diskA.indexOf('### example.org')
  record('with the talk open and unsaved, Add to talk goes through the editor: the edit and the slide both survive',
    editorAdded && bufferHasBoth && diskA.includes('Welcome to History Alpha. UNSAVEDMARK') && slideAt > diskA.indexOf('UNSAVEDMARK') && slideAt < diskA.indexOf('### Close'),
    `unsavedBefore=${unsavedOnDisk} added=${editorAdded} buffer=${bufferHasBoth} slideAt=${slideAt}`)

  // (m1) An autosave still in flight when "Add to talk" arrives. The main process holds the NEXT
  // talk:write-outline for 3 s (wrapping the real handler from the harness — no product seam), so
  // the autosave of the edit is in flight while the insertion runs. The insertion must wait for it
  // and save after it: the slide is on disk once both writes have landed.
  const hookInstalled = await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers?.get('talk:write-outline')
    if (!original) return false
    globalThis.__twHoldNextWrite = false
    handlers.set('talk:write-outline', async (...args) => {
      if (globalThis.__twHoldNextWrite) {
        globalThis.__twHoldNextWrite = false
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
      return original(...args)
    })
    return true
  })
  await app.evaluate(() => { globalThis.__twHoldNextWrite = true })
  await page.bringToFront()
  await page.locator('.cm-content .cm-line', { hasText: 'Thank you.' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' INFLIGHTMARK')
  await page.waitForTimeout(1900) // the 1.5 s autosave has fired and is now held in flight
  const heldInFlight = await app.evaluate(() => globalThis.__twHoldNextWrite === false)
  await tools.bringToFront()
  const inflightRow = row(tools, sessions[0].id).locator('.isl-row').nth(1)
  await inflightRow.locator('button.isl-add').click()
  const inflightAdded = await waitFor(async () => /Added after slide \d+/.test(((await inflightRow.locator('.isl-add.done').textContent().catch(() => '')) || '')), 12000)
  await page.waitForTimeout(3500) // any stale write would have landed by now
  const diskInflight = readFileSync(outlineA, 'utf8')
  const runInflight = JSON.parse(readFileSync(sessionPath(sessions[0]), 'utf8')).instantSlides?.[1]?.added
  record('editor route: Add to talk while an autosave is in flight waits for it; the edit and the slide are both on disk afterwards',
    hookInstalled && heldInFlight && inflightAdded && !!runInflight && diskInflight.includes('Thank you. INFLIGHTMARK')
      && diskInflight.includes(`{id=${runInflight?.slideId}}`) && (diskInflight.match(/^### In flight slide text$/gm) || []).length === 1,
    `hook=${hookInstalled} held=${heldInFlight} added=${inflightAdded} run=${JSON.stringify(runInflight)} mark=${diskInflight.includes('INFLIGHTMARK')} slide=${diskInflight.includes('In flight slide text')}`)

  // (m2) The save fails (outline made read-only): the entry stays un-added, History shows why and
  // offers "Add to talk" again, the file is untouched, and the slide is in the editor, undoable.
  const beforeFail = readFileSync(outlineA)
  chmodSync(outlineA, 0o444)
  const failRow = row(tools, sessions[0].id).locator('.isl-row').nth(2)
  await failRow.locator('button.isl-add').click()
  const failMessage = await waitFor(async () => /could not be saved to disk, so it is not marked as added/i.test(((await failRow.locator('.isl-err').textContent().catch(() => '')) || '')), 12000)
  const failRun = JSON.parse(readFileSync(sessionPath(sessions[0]), 'utf8')).instantSlides?.[2]?.added
  const offeredAgain = (await failRow.locator('button.isl-add:not([disabled])').count()) === 1 && (await failRow.locator('.isl-add.done').count()) === 0
  const fileUntouched = readFileSync(outlineA).equals(beforeFail)
  const bufferHasFailed = ((await page.locator('.cm-content').first().textContent().catch(() => '')) || '').includes('Failed save slide text')
  chmodSync(outlineA, 0o644)
  await page.bringToFront()
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Meta+z')
  const undone = await waitFor(async () => !(((await page.locator('.cm-content').first().textContent().catch(() => '')) || '').includes('Failed save slide text')), 4000)
  record('editor route: a failed save leaves the entry un-added with a human error, the file untouched, the slide undoable, and Add offered again',
    failMessage && !failRun && offeredAgain && fileUntouched && bufferHasFailed && undone,
    `message=${failMessage} added=${JSON.stringify(failRun)} again=${offeredAgain} untouched=${fileUntouched} buffer=${bufferHasFailed} undone=${undone}`)
  await tools.bringToFront()
  await failRow.locator('button.isl-add').click()
  const retried = await waitFor(async () => /Added after slide \d+/.test(((await failRow.locator('.isl-add.done').textContent().catch(() => '')) || '')), 12000)
  const diskRetry = readFileSync(outlineA, 'utf8')
  record('editor route: after the failure, Add to talk again succeeds and the slide is on disk once',
    retried && (diskRetry.match(/^### Failed save slide text$/gm) || []).length === 1,
    `retried=${retried} count=${(diskRetry.match(/^### Failed save slide text$/gm) || []).length}`)

  // (n) Slides-only view: change an Inspector option, then Add at once (well inside the 1.5 s
  // autosave delay). Before the fix the option lived only in the workspace's copy of the outline; the
  // insertion planned against the editor's older buffer and its save erased the option from disk.
  await page.bringToFront()
  await page.waitForTimeout(2000) // let the retry's follow-up saves settle
  await page.keyboard.press('Meta+2')
  await page.waitForTimeout(500)
  if (await page.locator('.tw-inspector').count() === 0) await page.keyboard.press('Meta+p')
  await page.waitForTimeout(800)
  await page.locator('.cm-content .cm-line', { hasText: 'Thank you.' }).first().click()
  await page.waitForTimeout(600)
  await page.keyboard.press('Meta+3')
  await page.waitForTimeout(800)
  const stripOnly = await page.locator('.tw-inspector').count() === 1 && !(await page.locator('.cm-content').first().isVisible().catch(() => false))
  const inspectedTitle = ((await page.locator('.tw-inspector-title').first().textContent().catch(() => '')) || '').trim()
  const sizeL = page.locator('.tw-inspector-group[data-group="font-body"] button', { hasText: /^L$/ }).first()
  const optionOffered = await sizeL.count() === 1
  const diskBeforeOption = readFileSync(outlineA, 'utf8')
  await sizeL.click().catch(() => {})
  const clickedAt = Date.now()
  await tools.bringToFront()
  const raceRow = row(tools, sessions[0].id).locator('.isl-row').nth(3)
  await raceRow.locator('button.isl-add').click()
  const addPressedAfterMs = Date.now() - clickedAt
  const raceAdded = await waitFor(async () => /Added after slide \d+/.test(((await raceRow.locator('.isl-add.done').textContent().catch(() => '')) || '')), 12000)
  await page.waitForTimeout(2500) // past every autosave delay: any stale save would have landed
  const diskRace = readFileSync(outlineA, 'utf8')
  const closeBlock = diskRace.slice(diskRace.indexOf('### Close'))
  const closeTrigger = closeBlock.split('\n')[1] ?? ''
  const raceRun = JSON.parse(readFileSync(sessionPath(sessions[0]), 'utf8')).instantSlides?.[3]?.added
  // The editor buffer must hold exactly what is on disk (read with the editor back on screen: the
  // slides-only view detaches it from the page).
  await page.bringToFront()
  await page.keyboard.press('Meta+2')
  await page.waitForTimeout(600)
  const bufferText = await page.evaluate(() => {
    const el = document.querySelector('.cm-content')
    // CodeMirror's own EditorView.findFromDOM lookup: the content element's tile root holds the view.
    const tile = el && el.cmTile
    const view = tile && tile.root && tile.root.view
    return view ? view.state.doc.toString() : null
  })
  record('slides-only view: an Inspector option then Add at once keeps both the option and the slide on disk, and the editor agrees',
    stripOnly && optionOffered && addPressedAfterMs < 1500 && raceAdded && !diskBeforeOption.includes('font-body=l')
      && /\{font-body=l\}/.test(closeTrigger) && (diskRace.match(/^### Inspector race slide text$/gm) || []).length === 1
      && !!raceRun && diskRace.includes(`{id=${raceRun?.slideId}}`) && bufferText === diskRace,
    `strip=${stripOnly} inspected=${inspectedTitle} offered=${optionOffered} addAfter=${addPressedAfterMs}ms added=${raceAdded} closeTrigger=${closeTrigger} slide=${diskRace.includes('Inspector race slide text')} buffer=${bufferText === null ? 'n/a' : bufferText === diskRace}`)

  // (o) Reorder, then Add to talk at once (one-writer spec test 5). The strip's drag-reorder runs
  // through WorkspaceLayout.handleReorder → the D1 seam; "Add to talk" goes through main's one writer
  // to the same buffer. Neither may undo the other on disk or in the buffer.
  await page.bringToFront()
  // (n) left the Inspector in the strip's place: put the strip back (⌘P toggles it).
  if (await page.locator('.tw-inspector').count() > 0) await page.keyboard.press('Meta+p')
  await waitFor(async () => (await page.locator('.tw-slide-card').count()) > 0, 8000)
  await page.waitForTimeout(2500) // earlier saves settle; the strip has cards for every slide
  const headingsOf = (text) => text.split('\n').filter((l) => /^#{1,6} /.test(l))
  const diskBeforeReorder = readFileSync(outlineA, 'utf8')
  const headsBefore = headingsOf(diskBeforeReorder)
  const dragStarted = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.tw-slide-card'))
    const byTitle = (t) => cards.find((c) => (c.textContent || '').includes(t))
    const src = byTitle('Close'); const dst = byTitle('Opening')
    if (!src || !dst) return { ok: false, cards: cards.length, src: !!src, dst: !!dst }
    const dt = new DataTransfer()
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    fire(src, 'dragstart'); fire(dst, 'dragenter'); fire(dst, 'dragover'); fire(dst, 'drop'); fire(src, 'dragend')
    return { ok: true, cards: cards.length }
  })
  const droppedAt = Date.now()
  await tools.bringToFront()
  const reorderRow = row(tools, sessions[0].id).locator('.isl-row').nth(4)
  await reorderRow.locator('button.isl-add').click()
  const addAfterMs = Date.now() - droppedAt
  const reorderAdded = await waitFor(async () => /Added after slide \d+/.test(((await reorderRow.locator('.isl-add.done').textContent().catch(() => '')) || '')), 12000)
  const reorderErr = ((await reorderRow.locator('.isl-err').textContent().catch(() => '')) || '').trim()
  await page.waitForTimeout(2500) // past the autosave delay: a stale save would have landed by now
  const diskReorder = readFileSync(outlineA, 'utf8')
  const headsAfter = headingsOf(diskReorder)
  const closeFirst = diskReorder.indexOf('### Close') < diskReorder.indexOf('### Opening')
  const reorderRun = JSON.parse(readFileSync(sessionPath(sessions[0]), 'utf8')).instantSlides?.[4]?.added
  const reorderSlideCount = (diskReorder.match(/^### Reorder race slide text$/gm) || []).length
  const othersKept = headsBefore.every((h) => headsAfter.includes(h)) && headsAfter.length === headsBefore.length + 1
  const bufferReorder = await page.evaluate(() => {
    const el = document.querySelector('.cm-content')
    const tile = el && el.cmTile
    const view = tile && tile.root && tile.root.view
    return view ? view.state.doc.toString() : null
  })
  record('one writer: a strip reorder then Add to talk at once — the reorder and the slide are both on disk, and the editor agrees',
    dragStarted.ok && !diskBeforeReorder.slice(0, diskBeforeReorder.indexOf('### Opening')).includes('### Close') && closeFirst
      && reorderAdded && reorderSlideCount === 1 && !!reorderRun && diskReorder.includes(`{id=${reorderRun?.slideId}}`)
      && othersKept && bufferReorder === diskReorder,
    `drag=${JSON.stringify(dragStarted)} addAfter=${addAfterMs}ms added=${reorderAdded} err=${reorderErr || '-'} closeFirst=${closeFirst} slide=${reorderSlideCount} kept=${othersKept} heads=${headsBefore.length}→${headsAfter.length} buffer=${bufferReorder === null ? 'n/a' : bufferReorder === diskReorder}`)

  // (p) Slide Browser insert at the caret, read back inside the autosave delay. The caret goes to the
  // end of "Thank you."; the Browser (⌘S) finds talk B's Opening slide and ⌘↵ inserts it. The file
  // must hold the inserted block — and equal the buffer — within 1.1 s of the key press, before the
  // 1.5 s autosave could have written it.
  await page.bringToFront()
  await page.waitForTimeout(2000) // (o)'s saves settle
  await page.locator('.cm-content .cm-line', { hasText: 'Thank you.' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Meta+s')
  const browserUp = await page.waitForSelector('.lt-browser-root', { timeout: 6000 }).then(() => true).catch(() => false)
  await page.locator('.lt-searchfield input').fill('Welcome to History Beta')
  const betaCard = await waitFor(async () => (await page.locator('.lt-card:not(.skeleton)').count()) > 0, 8000)
  await page.locator('.lt-card:not(.skeleton)').first().click()
  await page.waitForTimeout(150)
  const diskBeforeInsert = readFileSync(outlineA, 'utf8')
  const pressedAt = Date.now()
  await page.keyboard.press('Meta+Enter')
  const readBuffer = () => page.evaluate(() => {
    const el = document.querySelector('.cm-content')
    const tile = el && el.cmTile
    const view = tile && tile.root && tile.root.view
    return view ? view.state.doc.toString() : null
  })
  let onDiskAtMs = null, bufferMatched = false
  while (Date.now() - pressedAt < 1100) {
    const disk = readFileSync(outlineA, 'utf8')
    if (disk.includes('Welcome to History Beta.')) {
      onDiskAtMs ??= Date.now() - pressedAt
      if (disk === await readBuffer()) { bufferMatched = true; break }
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  const insertedAfterThankYou = (() => {
    const disk = readFileSync(outlineA, 'utf8')
    const at = disk.indexOf('Thank you. INFLIGHTMARK')
    return at >= 0 && disk.indexOf('Welcome to History Beta.') > at
  })()
  record('one writer: a Slide Browser insert at the caret is on disk at once (inside the autosave delay) and the file equals the buffer',
    browserUp && betaCard && !diskBeforeInsert.includes('Welcome to History Beta.') && onDiskAtMs !== null && bufferMatched && insertedAfterThankYou,
    `browser=${browserUp} card=${betaCard} onDiskAt=${onDiskAtMs ?? 'never'}ms bufferMatched=${bufferMatched} afterCaret=${insertedAfterThankYou}`)
  await page.waitForTimeout(2000) // let the follow-up saves settle before the next case

  closedAgain = tools.waitForEvent('close', { timeout: 4000 }).then(() => true).catch(() => false)
  await tools.bringToFront()
  await tools.keyboard.press('Escape').catch(() => {})
  await closedAgain

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
