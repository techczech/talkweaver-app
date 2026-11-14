// Hidden development-app journey for release 0.44.5, the recording editor's follow-ups: Look and sound
// (even volume, smooth joins), where your face appears per slide, and Record this slide again. Built like
// diagnose-recording-editor.mjs: hidden Electron, fake devices (--use-fake-device-for-media-stream,
// TW_REC_TEST), a throwaway profile and vault with a generated talk; never the owner's. Needs `npm run build`.
// Screenshots go to docs/design/2026-11-10-record-and-edit-video/built/0.44.5/shots/.
//   node e2e/diagnose-recording-follow-ups.mjs
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
// Record one slide again is off in 0.44.5 release builds; this journey runs it with the development override.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { editorWords, slideRows } from '../src/shared/recording-editor.ts'
import { makeEditorFixture } from '../scripts/fixtures/recording-editor-fixture.mjs'

const LONG = false
const repo = resolve(import.meta.dirname, '..'), built = join(repo, 'docs/design/2026-11-10-record-and-edit-video/built/0.44.5'), shots = join(built, 'shots')
const root = mkdtempSync(join(repo, '.follow-ups-e2e-')), vault = join(root, 'vault'), userData = join(root, 'userData'), talk = join(vault, 'fixture'), out = join(root, 'exports')
for (const dir of [talk, userData, shots, out]) mkdirSync(dir, { recursive: true })
const TITLES = ['A single strong claim', 'A plain list, with icons', 'A process, left to right', 'Statement beside a list', 'Big numbers', 'Steps that build', 'Before and after', 'A quote']
const slideCount = LONG ? 80 : 6
const outline = join(talk, 'fixture-outline.md')
const content = `---\ntitle: TalkWeaver Layout Showcase\n---\n\n## Talk\n\n${Array.from({ length: slideCount }, (_, i) => `### ${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` ${i + 1}` : ''} {id=s${i + 1}}\n\nPoint ${i + 1}.\n`).join('\n')}`
writeFileSync(outline, content)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, recordingDiscardMs: 800 }))
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const ffprobe = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'].find((p) => existsSync(p))
const gen = (args) => { const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args], { timeout: 1_800_000 }); assert.equal(r.status, 0, r.stderr?.toString()) }
const runsDir = join(vault, '_PRESENTATIONS', 'fixture')
let app, count = 0
const pass = (name) => console.log(`PASS ${++count} ${name}`)
const measured = {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A hard stop inside the script: a hung app never outlives the slot (13 minutes; the slot allows 15).
const hardStop = setTimeout(() => { console.error('HARD TIMEOUT: the journey did not finish in 13 minutes'); try { app?.process()?.kill('SIGKILL') } catch {} process.exit(124) }, 13 * 60 * 1000)
hardStop.unref()

try {
  app = await electron.launch({ timeout: 30000, cwd: repo, args: ['.', '--user-data-dir=' + userData, '--use-fake-device-for-media-stream'], env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1', TW_RECORD_AGAIN: '1' } })
  const main = await app.firstWindow(); await main.waitForLoadState('domcontentloaded')
  const opened = app.waitForEvent('window')
  await main.evaluate(({ outline, content }) => window.tw.talk.present(outline, content, 'presenter'), { outline, content })
  const presenter = await opened
  await presenter.waitForSelector('#twrec-primary')
  await presenter.locator('#twrec-capture').selectOption('camera')
  await presenter.keyboard.press('Shift+r')
  await presenter.waitForSelector('.twrec-device-check'); await presenter.waitForFunction(() => !document.querySelector('[data-continue]').disabled, {}, { timeout: 20000 }); await presenter.locator('[data-continue]').click()
  await presenter.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'recording', {}, { timeout: 20000 })
  await presenter.waitForTimeout(2500)
  await presenter.locator('#twrec-stop').click()
  await presenter.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved', {}, { timeout: 30000 })
  const runFile = readdirSync(runsDir).find((f) => /^[^.]+\.json$/.test(f) && JSON.parse(readFileSync(join(runsDir, f), 'utf8')).capture?.layers?.camera)
  const run = JSON.parse(readFileSync(join(runsDir, runFile), 'utf8'))
  // The automatic transcription (a fixture in test mode) finishes before the generated transcript goes in.
  const transcriptFile = join(runsDir, `${run.id}.transcript.json`)
  for (let i = 0; i < 80 && !existsSync(transcriptFile); i++) await sleep(250)
  await sleep(500)

  // The generated talk and its layers.
  const fx = makeEditorFixture(LONG ? { slides: 80, wordsPerSlide: 113, seed: 11 } : { slides: 6, wordsPerSlide: 30, seed: 5 })
  const D = fx.durationMs
  const rec = join(userData, 'recordings', run.id), voice = join(userData, 'recordings', run.audio.segments[0].file)
  const sec = String(D / 1000)
  const size = LONG ? '320x180' : '1280x720', fps = LONG ? '5' : '30'
  gen(['-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${fps}:d=${sec}`, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', LONG ? '60k' : '300k', '-f', 'webm', join(rec, 'slides.webm')])
  gen(['-f', 'lavfi', '-i', `testsrc=s=320x240:r=${fps}:d=${sec}`, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '60k', '-f', 'webm', join(rec, 'camera.webm')])
  gen(['-f', 'lavfi', '-i', `sine=frequency=330:duration=${sec}`, '-c:a', 'libopus', '-b:a', '24k', '-f', 'webm', voice])
  for (const f of readdirSync(runsDir)) if (f.startsWith(run.id + '.') && f !== runFile) unlinkSync(join(runsDir, f))
  Object.assign(run, { recordingMs: D, wallClockMs: D })
  run.audio.segments = [{ ...run.audio.segments[0], bytes: statSync(voice).size, startMs: 0, endMs: D }]; run.audio.bytes = statSync(voice).size; run.audio.audioMs = D; run.audio.gaps = []
  run.capture.durationMs = D
  for (const layer of ['slides', 'camera']) {
    const meta = run.capture.layers[layer]
    Object.assign(meta, { file: `${layer}.webm`, bytes: statSync(join(rec, `${layer}.webm`)).size, startMs: 0, outcome: 'complete' }); delete meta.segments; delete meta.lostAtMs; delete meta.endMs
  }
  run.slideTimeIndex = fx.marks
  delete run.trims
  writeFileSync(join(runsDir, runFile), JSON.stringify(run))
  writeFileSync(transcriptFile, JSON.stringify(fx.transcript))
  const editsFile = join(runsDir, `${run.id}.edits.json`)
  const sidecar = () => (existsSync(editsFile) ? JSON.parse(readFileSync(editsFile, 'utf8')) : { cuts: [], boundaries: [], undo: [], redo: [] })
  const ctx = editorWords(fx.transcript, D)
  const rows = slideRows(ctx, fx.marks)
  pass(`a layered Run with a generated talk: ${ctx.words.length} words, ${rows.length} slides, ${(D / 1000).toFixed(0)} s, precise word timing`)

  const openTools = async () => {
    const toolsOpened = app.waitForEvent('window')
    await main.evaluate((id) => window.tw.tools.open('studio', id), run.id)
    const tools = await toolsOpened
    tools.on('pageerror', (error) => console.error('tools error:', error.message))
    tools.on('console', (m) => { if (m.type() === 'error') console.error('tools console:', m.text().slice(0, 400)) })
    await tools.setViewportSize({ width: 1440, height: 900 })
    await tools.waitForSelector('[data-recording-panel]', { timeout: 120000 })
    return tools
  }
  const pictureReady = (page) => page.waitForFunction(() => [...document.querySelectorAll('.twrp-frame video')].length >= 1 && [...document.querySelectorAll('.twrp-frame video')].every((v) => !v.seeking && v.readyState >= 2), {}, { timeout: 600000 })
  const openEditor = async (tools) => {
    await tools.locator('[data-edit-video]').click()
    await tools.waitForSelector('[data-recording-editor] [data-row]', { timeout: 30000 })
  }
  const editsRevision = async (tools) => Number(await tools.locator('[data-recording-editor]').getAttribute('data-edits-revision'))
  /** Wait until main has written what the editor shows (its revision equals the file's). */
  const saved = async (tools) => { await tools.waitForFunction(() => true); for (let i = 0; i < 100; i++) { if (existsSync(editsFile) && sidecar().revision === (await editsRevision(tools))) return sidecar(); await sleep(50) } throw Error('the edit was not saved') }
  const lastEditMs = async (tools) => { await tools.waitForTimeout(80); return Number(await tools.locator('[data-recording-editor]').getAttribute('data-last-edit-ms')) }
  const center = async (page, selector) => { const b = await page.locator(selector).first().boundingBox(); assert.ok(b, `${selector} is on screen`); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
  const dragWords = async (page, a, b) => {
    await page.locator(`[data-w="${a}"]`).scrollIntoViewIfNeeded()
    const p = await center(page, `[data-w="${a}"]`), q = await center(page, `[data-w="${b}"]`)
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 }); await page.mouse.move(q.x, q.y, { steps: 4 }); await page.mouse.up()
  }
  /** Two neighbouring words shown and not cut, from `from` on (indexes into the words). */
  const freePair = (page, from, skip = 0) => page.evaluate(({ from, skip }) => {
    const shown = new Set([...document.querySelectorAll('[data-w]:not(.tre-cut)')].map((el) => Number(el.dataset.w)))
    let found = -1, seen = 0
    for (let i = from; i < from + 400; i++) if (shown.has(i) && shown.has(i + 1)) { if (seen++ === skip) { found = i; break } }
    return found
  }, { from, skip })
  const shot = async (page, name) => { await page.waitForTimeout(250); await page.screenshot({ path: join(shots, `${name}.png`) }) }


  let tools = await openTools()
  await pictureReady(tools)
  await openEditor(tools)
  await tools.waitForSelector('.tre-player .twrp-frame video', { state: 'attached', timeout: 300000 })
  await pictureReady(tools)
  assert.equal(await tools.locator('.tw-tools-bar').count(), 1, 'still one bar above the content')

  // ---- Look and sound: even volume and smooth joins, each one undoable edit ---------------------------
  const look = tools.locator('.tre-bar').getByRole('button', { name: 'Look and sound…' })
  await look.click()
  const sheet = tools.getByRole('dialog', { name: 'Look and sound' })
  await sheet.waitFor()
  const even = sheet.getByRole('checkbox', { name: 'Even out the volume' }), smooth = sheet.getByRole('checkbox', { name: /Smooth each join/ })
  assert.equal(await even.isChecked(), true); assert.equal(await smooth.isChecked(), true)
  assert.equal(await tools.evaluate(() => document.activeElement?.getAttribute('type')), 'checkbox', 'focus moves into the sheet')
  // The evened voice is made for the player on first use.
  await tools.waitForFunction(() => [...document.querySelectorAll('.twrp-player audio')].some((a) => a.src.includes('voice-even')), {}, { timeout: 120000 })
  await shot(tools, 'look-and-sound')
  await even.uncheck()
  let s = await saved(tools)
  assert.equal(s.finish.evenVolume, false); assert.equal(s.version, 5)
  await tools.waitForFunction(() => [...document.querySelectorAll('.twrp-player audio')].every((a) => !a.src.includes('voice-even')))
  await smooth.uncheck()
  s = await saved(tools)
  assert.equal(s.finish.smoothJoins, false)
  await shot(tools, 'look-and-sound-off')
  await tools.keyboard.press('Escape')
  await sheet.waitFor({ state: 'detached' })
  await tools.keyboard.press('Meta+z'); await tools.keyboard.press('Meta+z')
  s = await saved(tools)
  assert.equal(s.finish.evenVolume, true, 'undo turns even volume back on'); assert.equal(s.finish.smoothJoins, true)
  pass('Look and sound: Even out the volume and Smooth each join, on by default, each an undoable edit; the player switches to the evened voice')

  // ---- Where your face appears ------------------------------------------------------------------------
  await tools.locator('[data-row="1"]').scrollIntoViewIfNeeded()
  await tools.locator('[data-row="1"] .tre-stitle').hover()
  const faceButton = tools.locator('[data-row="1"] [data-face-control]')
  assert.equal(await faceButton.textContent(), ' Face: corner')
  await faceButton.click()
  const n1 = (await tools.locator('[data-row="1"] .tre-n').textContent()).trim()
  const faceSheet = tools.getByRole('dialog', { name: `Slide ${n1}: where your face appears` })
  await faceSheet.waitFor()
  await shot(tools, 'face-sheet')
  await faceSheet.getByRole('radio', { name: 'Side by side' }).click()
  s = await saved(tools)
  assert.deepEqual(s.faces.slides.map((x) => x.face.layout), ['side'])
  await shot(tools, 'face-side-sheet')
  await faceSheet.getByRole('radio', { name: 'In the corner' }).click()
  await faceSheet.getByLabel('Corner', { exact: true }).selectOption('bottom-left')
  await faceSheet.getByRole('radio', { name: 'Large' }).click()
  s = await saved(tools)
  assert.deepEqual(s.faces.slides[0].face, { layout: 'corner', corner: 'bottom-left', size: 'large' })
  await faceSheet.getByRole('radio', { name: 'Side by side' }).click()
  await saved(tools)
  await faceSheet.getByRole('button', { name: 'Done' }).click()
  // The player shows it when the playhead is on that slide.
  await tools.evaluate((t) => { const el = document.querySelector('[data-row="1"]'); el?.scrollIntoView() }, 0)
  const rowStart = rows[1].start
  await tools.locator('[data-row="1"] [data-w]').first().click()
  await tools.waitForFunction(() => document.querySelector('.twrp-player')?.getAttribute('data-face') === 'side', {}, { timeout: 10000 })
  await pictureReady(tools)
  await shot(tools, 'face-side-player')
  assert.equal(await tools.locator('[data-row="1"] [data-face-control]').textContent(), ' Face: side by side')
  await tools.locator('[data-row="0"] [data-w]').first().click()
  await tools.waitForFunction(() => (document.querySelector('.twrp-player')?.getAttribute('data-face') ?? '').startsWith('corner:bottom-right'), {}, { timeout: 10000 })
  pass(`where your face appears: the sheet, Side by side on slide ${n1} only, corner and size; the player follows the slide (slide 2 starts at ${Math.round(rowStart)} ms)`)

  // ---- Record this slide again ------------------------------------------------------------------------
  await tools.locator('[data-row="2"]').scrollIntoViewIfNeeded()
  await tools.locator('[data-row="2"] .tre-stitle').hover()
  const n2 = (await tools.locator('[data-row="2"] .tre-n').textContent()).trim()
  const presenterOpened = app.waitForEvent('window')
  await tools.locator('[data-row="2"] [data-record-again]').click()
  const retake = await presenterOpened
  await retake.waitForSelector('#twrec-retake-banner', { timeout: 30000 })
  await retake.setViewportSize({ width: 1440, height: 900 })
  assert.match(await retake.locator('#twrec-retake-banner').textContent(), new RegExp(`Recording slide ${n2} again\\. The rest of your video is kept as it is\\.`))
  assert.match(await retake.locator('#twrec-primary').textContent(), new RegExp(`Record slide ${n2}`))
  assert.equal(await retake.locator('#twrec-capture').isHidden(), true, 'the layers are the Run\'s')
  await shot(retake, 'retake-ready')
  await retake.locator('#twrec-primary').click()
  const check = retake.locator('.twrec-device-check')
  if (await check.count()) { await retake.waitForFunction(() => !document.querySelector('[data-continue]')?.disabled, {}, { timeout: 20000 }).catch(() => {}); await retake.locator('[data-continue]').click().catch(() => {}) }
  await retake.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'recording', {}, { timeout: 30000 })
  await retake.waitForTimeout(1200)
  assert.match(await retake.locator('#twrec-label').textContent(), new RegExp(`Recording slide ${n2}`))
  await shot(retake, 'retake-recording')
  await retake.waitForTimeout(1300)
  await retake.locator('#twrec-stop').click()
  await retake.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved', {}, { timeout: 30000 })
  await retake.waitForSelector('#twrec-saved-text', { timeout: 10000 })
  assert.match(await retake.locator('#twrec-saved-text').textContent(), new RegExp(`New take of slide ${n2} saved`))
  await shot(retake, 'retake-saved')
  const takeFile = readdirSync(runsDir).find((f) => /^[^.]+\.json$/.test(f) && JSON.parse(readFileSync(join(runsDir, f), 'utf8')).takeOf?.runId === run.id)
  assert.ok(takeFile, 'the take is saved as a Run naming this one')
  const takeRun = JSON.parse(readFileSync(join(runsDir, takeFile), 'utf8'))
  assert.equal(takeRun.takeOf.change, rows[2].change)
  assert.ok(takeRun.capture?.layers?.camera, 'the take has the Run\'s camera layer')
  const listed = await main.evaluate((slug) => window.tw.recording.listSessions(slug), 'fixture')
  assert.equal(listed.some((x) => x.id === takeRun.id), false, 'the take is not listed as a recording of its own')
  await retake.close()
  pass(`Record this slide again: a presenter view at slide ${n2} with the second bar, Record slide ${n2}, the Run's layers; the take is saved as a take of this Run and not listed on its own`)

  // Back in the editor: the takes of slide 3, and the choice.
  await tools.bringToFront(); await tools.evaluate(() => window.dispatchEvent(new Event('focus')))
  await tools.waitForSelector('[data-row="2"] .tre-takes', { timeout: 15000 })
  await tools.locator('[data-row="2"] .tre-takes').scrollIntoViewIfNeeded()
  await shot(tools, 'takes')
  const before = Number(await tools.locator('.tre-len').getAttribute('data-edited-ms'))
  await tools.locator('[data-row="2"] [data-take="' + takeRun.id + '"]').getByRole('button', { name: 'Use this take' }).click()
  s = await saved(tools)
  assert.deepEqual(s.takes, [{ change: rows[2].change, run: takeRun.id }])
  await tools.waitForSelector('[data-row="2"] .tre-replaced')
  await tools.waitForFunction((b) => Number(document.querySelector('.tre-len')?.getAttribute('data-edited-ms')) !== b, before)
  const after = Number(await tools.locator('.tre-len').getAttribute('data-edited-ms'))
  await tools.locator('[data-row="2"] .tre-takes').scrollIntoViewIfNeeded()
  await shot(tools, 'take-used')
  // Export with the new take.
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, join(out, 'with-take.mp4'))
  await tools.locator('.tre-bar').getByRole('button', { name: /^Export…$/ }).click()
  await tools.locator('.twrp-sheet').getByRole('button', { name: 'Export…' }).click()
  await tools.getByText(/Saved: with-take\.mp4/).waitFor({ timeout: 600000 })
  if (ffprobe) {
    const probe = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', join(out, 'with-take.mp4')]).stdout.toString())
    const videoMs = Math.round(Number(probe.streams.find((x) => x.codec_type === 'video').duration) * 1000)
    assert.ok(Math.abs(videoMs - after) <= 84, `exported ${videoMs} ms for an edited length of ${after} ms`)
    console.log(`  with the new take: edited ${after} ms (was ${before} ms), exported ${videoMs} ms`)
  }
  await tools.getByRole('button', { name: 'Done' }).click()
  // The take's Run disappears (moved away by hand): said on the row, and export is refused, never silent.
  const takePath = join(runsDir, takeFile), aside = join(root, 'take-aside.json')
  renameSync(takePath, aside)
  await tools.evaluate(() => window.dispatchEvent(new Event('focus')))
  await tools.waitForSelector('[data-row="2"] [data-take-missing]', { timeout: 15000 })
  assert.match(await tools.locator('[data-row="2"] [data-take-missing]').textContent(), /cannot be found/)
  assert.match(await tools.locator('.tre-player .twrp-notice').textContent(), /player plays the first take there/, 'the player says it plays the first take')
  await shot(tools, 'take-missing')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, join(out, 'refused.mp4'))
  await tools.locator('.tre-bar').getByRole('button', { name: /^Export…$/ }).click()
  await tools.locator('.twrp-sheet').getByRole('button', { name: 'Export…' }).click()
  await tools.locator('.twrp-sheet').getByText(/cannot be found, or some of its files are missing, so nothing was exported/).waitFor({ timeout: 30000 })
  assert.equal(existsSync(join(out, 'refused.mp4')), false)
  await tools.locator('.twrp-sheet').getByRole('button', { name: 'Close' }).click()
  renameSync(aside, takePath)
  await tools.evaluate(() => window.dispatchEvent(new Event('focus')))
  await tools.waitForSelector('[data-row="2"] .tre-takes', { timeout: 15000 })
  pass('a chosen take whose Run is gone: the slide says so with Use the first take, and export is refused; it comes back with its file')
  await tools.locator('[data-row="2"]').getByRole('button', { name: 'Use the first take' }).click()
  s = await saved(tools)
  assert.deepEqual(s.takes, [], 'Use the first take restores the recording as it was')
  await tools.waitForFunction((b) => Number(document.querySelector('.tre-len')?.getAttribute('data-edited-ms')) === b, before)
  assert.ok(existsSync(join(runsDir, takeFile)), 'the new take is kept')
  pass(`the new take: listed under slide ${n2}, Use this take replaces the slide in the editor and the export (${before} → ${after} ms), Use the first take restores it; both takes are kept`)

  writeFileSync(join(built, 'journey-result.json'), JSON.stringify({ at: new Date().toISOString(), passed: count }, null, 1) + '\n')
  console.log(`\n${count} passed`)
} finally {
  await app?.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
