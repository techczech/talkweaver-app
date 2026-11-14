// Hidden development-app journey for slice 3a (record → play → trim → undo → reopen → export), in the
// style of diagnose-presenter-layers.mjs: hidden Electron, fake devices, a throwaway profile and vault.
// Never opens the owner's profile. Needs `npm run build` first. Screenshots go to built/slice-3a/shots/.
//   node e2e/diagnose-recording-panel.mjs
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { captionCues, keptSpans, cameraRect, chaptersFor } from '../src/shared/recording-video.ts'
import { effectiveCuts } from '../src/shared/recording-edits.ts'

const repo = resolve(import.meta.dirname, '..'), shots = join(repo, 'docs/design/2026-11-10-record-and-edit-video/built/slice-3a/shots')
const root = mkdtempSync(join(repo, '.slice3a-e2e-')), vault = join(root, 'vault'), userData = join(root, 'userData'), talk = join(vault, 'fixture'), out = join(root, 'exports')
for (const dir of [talk, userData, shots, out]) mkdirSync(dir, { recursive: true })
const outline = join(talk, 'fixture-outline.md')
const content = '---\ntitle: Layered recording\n---\n\n## Opening\n\n### First slide {id=first}\n\nRecord the presenter.\n\n### Second slide {id=second}\n\nThe audience sees slides only.\n\n## Closing\n\n### Third slide {id=third}\n\nThank you.\n'
writeFileSync(outline, content)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, recordingDiscardMs: 800 }))
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const ffprobe = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'].find((p) => existsSync(p))
let app, count = 0
const pass = (name) => console.log(`PASS ${++count} ${name}`)
const runsDir = join(vault, '_PRESENTATIONS', 'fixture')
const readRuns = () => readdirSync(runsDir).filter((f) => /^[^.]+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8'))).filter((r) => r && r.id && r.audio)

// Every picture file has finished seeking and shows a decoded frame.
const settled = async (page) => { await page.waitForFunction(() => [...document.querySelectorAll('.twrp-frame video')].every((v) => !v.seeking && v.readyState >= 2), {}, { timeout: 30000 }); await page.waitForTimeout(300) }

async function record(presenter, choice, ms, firstTime) {
  await presenter.locator('#twrec-capture').selectOption(choice)
  await presenter.keyboard.press('Shift+r')
  if (firstTime) {
    await presenter.waitForSelector('.twrec-device-check')
    await presenter.waitForFunction(() => !document.querySelector('[data-continue]').disabled, {}, { timeout: 20000 })
    await presenter.locator('[data-continue]').click()
  }
  await presenter.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'recording', {}, { timeout: 20000 })
  const step = Math.floor(ms / 3)
  await presenter.waitForTimeout(step); await presenter.keyboard.press('ArrowRight')
  await presenter.waitForTimeout(step); await presenter.keyboard.press('ArrowRight')
  await presenter.waitForTimeout(step)
  await presenter.locator('#twrec-stop').click()
  await presenter.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved', {}, { timeout: 30000 })
}

// A hard stop inside the script: a hung app never outlives the slot (13 minutes; the slot allows 15).
const hardStop = setTimeout(() => { console.error('HARD TIMEOUT: the journey did not finish in 13 minutes'); try { app?.process()?.kill('SIGKILL') } catch {} process.exit(124) }, 13 * 60 * 1000)
hardStop.unref()

try {
  app = await electron.launch({ timeout: 30000, cwd: repo, args: ['.', '--user-data-dir=' + userData, '--use-fake-device-for-media-stream'], env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' } })
  const main = await app.firstWindow(); await main.waitForLoadState('domcontentloaded')
  const opened = app.waitForEvent('window')
  await main.evaluate(({ outline, content }) => window.tw.talk.present(outline, content, 'presenter'), { outline, content })
  const presenter = await opened
  presenter.on('pageerror', (error) => console.error('presenter error:', error.message))
  await presenter.waitForSelector('#twrec-primary')

  // A short layered Run with camera, then one without.
  await record(presenter, 'camera', 9000, true)
  const withCamera = readRuns().find((r) => r.capture?.layers?.camera)
  assert.ok(withCamera, 'a Run with a camera layer was saved'); assert.ok(withCamera.capture.layers.slides.bytes > 0)
  await presenter.waitForTimeout(500)
  pass('recorded a layered Run with slides picture, camera and voice')

  const toolsOpened = app.waitForEvent('window')
  await presenter.locator('#twrec-edit-video').click()
  let tools = await toolsOpened
  tools.on('pageerror', (error) => console.error('tools error:', error.message))
  await tools.setViewportSize({ width: 1280, height: 800 })
  await tools.waitForSelector('[data-recording-panel]', { timeout: 30000 })
  await tools.waitForFunction(() => { const v = document.querySelector('.twrp-slides'); return v && v.readyState >= 2 }, {}, { timeout: 60000 }).catch(async (error) => {
    console.error('picture state:', await tools.evaluate(() => [...document.querySelectorAll('.twrp-frame video')].map((v) => ({ cls: v.className, ready: v.readyState, seeking: v.seeking, t: v.currentTime, d: v.duration, err: v.error?.message, src: v.currentSrc.slice(0, 120) }))))
    throw error
  })
  await tools.waitForFunction(() => { const v = document.querySelector('.twrp-camera'); return v && v.readyState >= 2 }, {}, { timeout: 30000 })
  assert.equal(await tools.locator('.tws-scard.active').getAttribute('data-sid'), withCamera.id)
  assert.equal(await tools.locator('.tws-console .tws-transport').count(), 0, 'one transport: the panel’s')
  assert.equal(await tools.getByText(/coming soon|arrives in a later version/i).count(), 0)
  await tools.waitForTimeout(400)
  await settled(tools)
  await tools.screenshot({ path: join(shots, 'panel-camera.png') })
  pass('Edit video opens the Run in Studio with the recording panel; no placeholder')

  // D: the slides layer starts with a painted slide, not the page while it settles.
  {
    const run = readRuns().find((r) => r.id === withCamera.id), file = join(userData, 'recordings', run.id, 'slides.webm')
    const at = (t) => [...spawnSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=96:20:1800:1040,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 30000 }).stdout]
    spawnSync(ffmpeg, ['-v', 'error', '-y', '-ss', '0', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-1', join(shots, '..', 'slides-first-frame.png')])
    const first = at(0), settledFrame = at(0.8)
    console.log('slides layer first frame', first, 'at 0.8 s', settledFrame)
    // Where the deck's own toolbar (its blue Open Presenter View button) showed before the page switched to its audience view.
    assert.ok(first.reduce((n, v, i) => n + Math.abs(v - settledFrame[i]), 0) < 30, 'the first recorded frame is the audience view, not the deck’s own page')
  }
  pass('the slides layer’s first frame is the painted first slide')

  // A and B: labelled trim buttons, a camera switch, the scrub bar directly under the picture with a clear playhead.
  {
    const frame = await tools.locator('.twrp-frame').boundingBox(), track = await tools.getByTestId('recording-scrub').boundingBox(), knob = await tools.locator('.twrp-head-knob').boundingBox()
    assert.ok(track.y - (frame.y + frame.height) < 24 && track.y >= frame.y + frame.height - 1, `scrub bar under the picture: gap ${track.y - (frame.y + frame.height)} px`)
    assert.ok(Math.abs(track.width - frame.width) < 2, 'the scrub bar is as wide as the picture')
    assert.ok(knob.width >= 10 && knob.height >= 10, 'the playhead has a handle')
    for (const name of ['Trim start here', 'Trim end here']) assert.ok(await tools.getByRole('button', { name }).isVisible(), `${name} is a labelled button`)
    const camera = tools.getByRole('switch', { name: 'Camera' })
    assert.equal(await camera.getAttribute('aria-checked'), 'true'); assert.match(await camera.textContent(), /Camera\s*On/)
  }
  pass('trim buttons have words, the camera is a labelled switch, and the scrub bar sits under the picture with a playhead handle')

  const player = tools.locator('.twrp-player')
  await tools.locator('.tws-sidebar-title-row h2').click()
  await tools.keyboard.press('Space')
  await tools.waitForTimeout(2500)
  const playedTo = Number(await player.getAttribute('data-run-ms'))
  assert.ok(playedTo > 1500, `the playhead moves: ${playedTo}`)
  const drift = { max: Number(await player.getAttribute('data-drift-max-ms')), mean: Number(await player.getAttribute('data-drift-mean-ms')), samples: Number(await player.getAttribute('data-drift-samples')) }
  await tools.keyboard.press('Space')
  await tools.getByRole('button', { name: 'Play', exact: true }).waitFor()
  console.log('drift during a short play:', JSON.stringify(drift))
  pass('Space plays the layers together and pauses them')

  // Trim both ends at the playhead, by the scrub bar.
  const scrub = tools.getByTestId('recording-scrub'), box = await scrub.boundingBox()
  const duration = Math.round(withCamera.recordingMs)
  // C: I and O set the trims at the playhead.
  await tools.mouse.click(box.x + box.width * 0.2, box.y + 4)
  await tools.keyboard.press('i')
  await tools.mouse.click(box.x + box.width * 0.85, box.y + 4)
  await tools.keyboard.press('o')
  await tools.getByText('Use the whole recording').waitFor({ timeout: 15000 }).catch(async (error) => { console.error('panel says:', await tools.locator('.twrp-trims').textContent(), 'at', await tools.locator('.twrp-player').getAttribute('data-run-ms')); throw error })
  await settled(tools)
  const shown = await tools.evaluate(() => { const v = document.querySelector('.twrp-slides'); return { t: v.currentTime, run: Number(document.querySelector('.twrp-player').dataset.runMs) } })
  assert.ok(Math.abs(shown.t * 1000 - (shown.run - withCamera.capture.layers.slides.startMs)) < 100, `the paused picture is at the playhead: ${JSON.stringify(shown)}`)
  const editsFile = join(runsDir, `${withCamera.id}.edits.json`)
  let sidecar = JSON.parse(readFileSync(editsFile, 'utf8'))
  assert.equal(sidecar.cuts.length, 2); assert.equal(sidecar.cuts[0].start, 0); assert.equal(sidecar.cuts[1].end, duration)
  assert.ok(Math.abs(sidecar.cuts[0].end - duration * 0.2) < duration * 0.03 && Math.abs(sidecar.cuts[1].start - duration * 0.85) < duration * 0.03, JSON.stringify(sidecar.cuts))
  const trimmed = sidecar.cuts
  await tools.screenshot({ path: join(shots, 'panel-trimmed.png') })
  await tools.keyboard.press('Meta+z')
  await tools.waitForFunction(() => document.querySelectorAll('.twrp-cut').length === 1)
  sidecar = JSON.parse(readFileSync(editsFile, 'utf8'))
  assert.equal(sidecar.cuts.length, 1); assert.equal(sidecar.redo.length, 1)
  // The keys are listed in Studio's shortcut sheet.
  await tools.keyboard.press('?')
  for (const label of ['Trim start here', 'Trim end here', 'Undo a trim or edit', 'Redo a trim or edit']) await tools.getByText(label, { exact: true }).first().waitFor()
  await tools.screenshot({ path: join(shots, 'shortcut-sheet.png') })
  await tools.keyboard.press('Escape')
  pass('I and O trim at the playhead and are saved; ⌘Z takes the end trim back; the keys are in the shortcut sheet')

  // Reopen: the Tools window closes and comes back; the trims and the history are still there.
  await tools.close()
  const reopened = app.waitForEvent('window')
  await main.evaluate((id) => window.tw.tools.open('studio', id), withCamera.id)
  tools = await reopened
  await tools.setViewportSize({ width: 1280, height: 800 })
  await tools.waitForSelector('[data-recording-panel]', { timeout: 30000 })
  await tools.waitForFunction(() => document.querySelectorAll('.twrp-cut').length === 1)
  assert.equal(await tools.getByRole('button', { name: 'Redo', exact: true }).isEnabled(), true)
  await tools.locator('.tws-sidebar-title-row h2').click()
  await tools.keyboard.press('Meta+Shift+z')
  await tools.waitForFunction(() => document.querySelectorAll('.twrp-cut').length === 2)
  assert.deepEqual(JSON.parse(readFileSync(editsFile, 'utf8')).cuts, trimmed)
  await tools.waitForFunction(() => { const v = document.querySelector('.twrp-slides'); return v && v.readyState >= 2 }, {}, { timeout: 60000 })
  pass('after reopening, the start trim is there and Redo brings back the end trim')

  // Export: the save panel is answered with a throwaway path.
  const destination = join(out, 'layered.mp4')
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, destination)
  await tools.getByRole('button', { name: 'Export video…' }).click()
  await tools.getByRole('dialog', { name: 'Export' }).waitFor()
  await tools.getByLabel('Sound only (M4A)').check()
  await tools.screenshot({ path: join(shots, 'export-choose.png') })
  const started = Date.now()
  await tools.getByRole('button', { name: 'Export…' }).click()
  await tools.getByText(/Making your video/).waitFor({ timeout: 15000 }).then(() => tools.screenshot({ path: join(shots, 'exporting.png') })).catch(() => {})
  await tools.getByText(/Saved: layered\.mp4/).waitFor({ timeout: 180000 })
  const exportMs = Date.now() - started
  await tools.screenshot({ path: join(shots, 'export-done.png') })
  const expectedMs = keptSpans(effectiveCuts(trimmed, withCamera.trims, duration), duration).at(-1).editedEndMs
  const files = readdirSync(out).sort()
  assert.deepEqual(files, ['layered chapters.txt', 'layered.m4a', 'layered.mp4', 'layered.srt', 'layered.vtt'])
  pass(`Export video… writes the chosen MP4 and the extras in ${exportMs} ms`)

  assert.ok(ffprobe, 'ffprobe is needed to check the export')
  const probe = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', join(out, 'layered.mp4')], { encoding: 'utf8' }).stdout)
  const video = probe.streams.find((s) => s.codec_type === 'video'), audio = probe.streams.find((s) => s.codec_type === 'audio')
  assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.equal(video.r_frame_rate, '30/1')
  assert.equal(audio.codec_name, 'aac')
  const videoMs = Number(video.duration) * 1000
  assert.ok(Math.abs(videoMs - expectedMs) <= 1000 / 30 + 0.5, `video ${videoMs} ms against edited ${expectedMs} ms`)
  const run = readRuns().find((r) => r.id === withCamera.id)
  const slides = { first: { title: 'First slide', section: 'Opening' }, second: { title: 'Second slide', section: 'Opening' }, third: { title: 'Third slide', section: 'Closing' } }
  const spans = keptSpans(effectiveCuts(trimmed, run.trims, duration), duration)
  const chapters = chaptersFor(run.slideTimeIndex.filter((m) => m.event === 'enter'), slides, spans)
  assert.equal(probe.chapters.length, chapters.length, `chapters ${probe.chapters.length} against ${chapters.length}`)
  // The transcript as the app reads it (word times that fall outside the recorded voice are not used).
  const transcript = (await tools.evaluate(([slug, id]) => window.tw.transcript.get(slug, id), ['fixture', run.id])) ?? { words: [], segments: [] }
  const expectedCaptions = captionCues(transcript.words ?? [], spans, transcript.segments ?? []), expectedCues = expectedCaptions.cues.length
  const srtCues = readFileSync(join(out, 'layered.srt'), 'utf8').split(/\n\n+/).filter((b) => b.trim()).length
  if (srtCues !== expectedCues) console.error('captions differ:', JSON.stringify({ srt: readFileSync(join(out, 'layered.srt'), 'utf8'), transcript: JSON.stringify(transcript).slice(0, 1500), spans, expectedCaptions }))
  assert.equal(srtCues, expectedCues); assert.equal((readFileSync(join(out, 'layered.vtt'), 'utf8').match(/-->/g) ?? []).length, expectedCues)
  // Without word timings, caption lines a trim cuts through are left out, and the finished sheet says how many.
  if (expectedCaptions.leftOut) assert.match(await tools.getByRole('dialog', { name: 'Export' }).textContent(), new RegExp(`${expectedCaptions.leftOut} caption line`))
  pass(`ffprobe: H.264 1920×1080 30 fps + AAC, ${Math.round(videoMs)} ms (edited ${Math.round(expectedMs)} ms), ${probe.chapters.length} chapters, ${srtCues} caption cues`)

  // The camera rectangle holds the camera picture: it differs from the slides file there, and only there.
  const rect = cameraRect(), atEdited = 1.0, atRun = spans[0].startMs / 1000 + atEdited
  const pixel = (file, seek, x, y) => [...spawnSync(ffmpeg, ['-v', 'error', '-ss', String(seek), '-i', file, '-frames:v', '1', '-vf', `scale=1920:1080,crop=16:16:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 30000 }).stdout]
  const slidesFile = join(userData, 'recordings', run.id, 'slides.webm'), slideStart = run.capture.layers.slides.startMs / 1000
  const inCam = pixel(join(out, 'layered.mp4'), atEdited, rect.x + rect.width / 2, rect.y + rect.height / 2), slideThere = pixel(slidesFile, atRun - slideStart, rect.x + rect.width / 2, rect.y + rect.height / 2)
  const outside = pixel(join(out, 'layered.mp4'), atEdited, 200, 200), slideOutside = pixel(slidesFile, atRun - slideStart, 200, 200)
  const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0)
  console.log('camera rectangle', inCam, 'slides there', slideThere, 'outside', outside, slideOutside)
  assert.ok(diff(inCam, slideThere) > 60, 'the camera covers its rectangle')
  assert.ok(diff(outside, slideOutside) < 40, 'the slides picture is unchanged outside it')
  pass('a decoded frame shows the camera in its rectangle and the slides elsewhere')

  await tools.getByRole('button', { name: 'Done', exact: true }).click()
  // A failed export: a folder that does not exist.
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, join(root, 'no-such-folder', 'x.mp4'))
  await tools.getByRole('button', { name: 'Export video…' }).click()
  await tools.getByRole('button', { name: 'Export…' }).click()
  await tools.getByText(/recording and your edits are safe/).waitFor({ timeout: 60000 })
  await tools.screenshot({ path: join(shots, 'export-failed.png') })
  assert.equal(existsSync(join(root, 'no-such-folder')), false)
  await tools.getByRole('button', { name: 'Close', exact: true }).click()
  pass('a failed export says why and leaves nothing behind')

  await tools.getByRole('switch', { name: 'Camera' }).click()
  await tools.waitForFunction(() => document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'false')
  assert.equal(JSON.parse(readFileSync(editsFile, 'utf8')).finish.camera, false)
  assert.equal(await tools.locator('.twrp-player').getAttribute('data-camera'), 'off')
  await settled(tools)
  await tools.screenshot({ path: join(shots, 'panel-camera-off.png') })
  await tools.emulateMedia({ colorScheme: 'dark' })
  await tools.screenshot({ path: join(shots, 'panel-dark.png') })
  await tools.emulateMedia({ colorScheme: 'light' })
  pass('camera off is saved with the edits and hides the inset in the player')

  // A Run without camera.
  await record(presenter, 'voice', 4500, false)
  const noCamera = readRuns().find((r) => r.id !== withCamera.id && r.capture?.layers?.slides && !r.capture.layers.camera)
  assert.ok(noCamera)
  await tools.close()
  const third = app.waitForEvent('window')
  await main.evaluate((id) => window.tw.tools.open('studio', id), noCamera.id)
  tools = await third
  await tools.setViewportSize({ width: 1280, height: 800 })
  await tools.waitForSelector('[data-recording-panel]', { timeout: 30000 })
  await tools.waitForFunction(() => { const v = document.querySelector('.twrp-slides'); return v && v.readyState >= 2 }, {}, { timeout: 60000 })
  assert.equal(await tools.locator('.twrp-camera').count(), 0)
  assert.equal(await tools.getByRole('switch', { name: 'Camera' }).count(), 0)
  // The labelled buttons trim too.
  {
    const box3 = await tools.getByTestId('recording-scrub').boundingBox()
    await tools.mouse.click(box3.x + box3.width * 0.3, box3.y + 4)
    await tools.getByRole('button', { name: 'Trim start here' }).click()
    await tools.mouse.click(box3.x + box3.width * 0.7, box3.y + 4)
    await tools.getByRole('button', { name: 'Trim end here' }).click()
    await tools.waitForFunction(() => document.querySelectorAll('.twrp-cut').length === 2)
    assert.equal(JSON.parse(readFileSync(join(runsDir, `${noCamera.id}.edits.json`), 'utf8')).cuts.length, 2)
  }
  await settled(tools)
  await tools.screenshot({ path: join(shots, 'panel-no-camera.png') })
  await tools.emulateMedia({ colorScheme: 'dark' })
  await tools.screenshot({ path: join(shots, 'panel-no-camera-dark.png') })
  pass('a Run without camera plays slides and voice and offers no camera choice')

  writeFileSync(join(shots, '..', 'journey-result.json'), JSON.stringify({ passed: count, exportMs, expectedMs, videoMs, chapters: probe.chapters.length, cues: srtCues, shortPlayDrift: drift, recordedMs: duration }, null, 1) + '\n')
} finally {
  await app?.close().catch(() => {})
  if (process.env.TW_KEEP_E2E !== '1') rmSync(root, { recursive: true, force: true })
}
