// Hidden development-app journey for slice 3 (the recording editor), in the style of
// diagnose-recording-panel.mjs: hidden Electron, fake devices, a throwaway profile and vault; never the
// owner's. A short Run is recorded so the Run and its capture manifest are the app's own; then its layer
// files are replaced by generated ones as long as a generated talk (scripts/fixtures/
// recording-editor-fixture.mjs) whose transcript, with words, measured pauses and precise word timing, is
// written beside it. Needs `npm run build` first.
//   node e2e/diagnose-recording-editor.mjs            # the journey, screenshots in built/slice-3b/shots/
//   node e2e/diagnose-recording-editor.mjs --long     # also measure an hour-long Run (80 slides)
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { boundaryTargets, cutWordsOp, editorWords, resolveRecording, slideRows } from '../src/shared/recording-editor.ts'
import { makeEditorFixture } from '../scripts/fixtures/recording-editor-fixture.mjs'

const LONG = process.argv.includes('--long')
const repo = resolve(import.meta.dirname, '..'), built = join(repo, 'docs/design/2026-11-10-record-and-edit-video/built/slice-3b'), shots = join(built, 'shots')
const root = mkdtempSync(join(repo, '.slice3b-e2e-')), vault = join(root, 'vault'), userData = join(root, 'userData'), talk = join(vault, 'fixture'), out = join(root, 'exports')
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

try {
  app = await electron.launch({ timeout: 30000, cwd: repo, args: ['.', '--user-data-dir=' + userData, '--use-fake-device-for-media-stream'], env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' } })
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

  // ---- Run view entry ------------------------------------------------------------------------------
  let tools = await openTools()
  await pictureReady(tools)
  if (LONG) {
    // An hour-long Run: copies prepared on the first open; measure a reopen.
    await tools.close()
    tools = await openTools()
    await pictureReady(tools)
    const t0 = Date.now()
    await openEditor(tools)
    await tools.waitForFunction((n) => document.querySelectorAll('[data-recording-editor] [data-row]').length === n && document.querySelector('[data-recording-editor] [data-w]'), rows.length, { timeout: 60000 })
    measured.openEditorMs = Date.now() - t0
    // Scroll the whole list in steps and record the frame times.
    measured.scroll = await tools.evaluate(async () => {
      const list = document.querySelector('.tre-list'), gaps = []
      let last = performance.now()
      await new Promise((done) => {
        const step = () => { const now = performance.now(); gaps.push(now - last); last = now; list.scrollTop += 120; if (list.scrollTop + list.clientHeight < list.scrollHeight - 2 && gaps.length < 2000) requestAnimationFrame(step); else done() }
        requestAnimationFrame(step)
      })
      gaps.shift(); gaps.sort((a, b) => a - b)
      return { frames: gaps.length, medianMs: +gaps[gaps.length >> 1].toFixed(1), p95Ms: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1), maxMs: +gaps.at(-1).toFixed(1), scrollHeight: list.scrollHeight }
    })
    await tools.evaluate(() => { document.querySelector('.tre-list').scrollTop = 0 })
    const cuts = []
    for (const r of [rows[10], rows[40], rows[70]]) {
      const w = r.firstWord + 3
      await tools.locator(`[data-w="${w}"]`).scrollIntoViewIfNeeded()
      await dragWords(tools, w, w + 2)
      await tools.keyboard.press('Backspace')
      cuts.push(await lastEditMs(tools))
      await saved(tools)
    }
    measured.cutShownMs = cuts
    measured.words = ctx.words.length; measured.slides = rows.length; measured.minutes = +(D / 60000).toFixed(1)
    console.log(`MEASURE ${JSON.stringify(measured)}`)
    writeFileSync(join(built, 'long-run.json'), JSON.stringify({ measuredAt: new Date().toISOString(), ...measured }, null, 1) + '\n')
    assert.ok(measured.openEditorMs < 3000, `the editor opened in ${measured.openEditorMs} ms`)
    assert.ok(cuts.every((ms) => ms < 100), `cuts showed in ${cuts.join(', ')} ms`)
    pass(`an hour-long Run (${ctx.words.length} words, ${rows.length} slides): editor open ${measured.openEditorMs} ms; scroll frames median ${measured.scroll.medianMs} ms, p95 ${measured.scroll.p95Ms} ms; cuts shown in ${cuts.join(', ')} ms`)
  } else {
    assert.equal(await tools.locator('[data-edit-video]').count(), 1, 'the recording panel has Edit video')
    await shot(tools, 'run-entry')
    pass('the recording panel offers Edit video beside Export video…')

    await openEditor(tools)
    await tools.waitForFunction((n) => document.querySelectorAll('[data-recording-editor] [data-row]').length === n, rows.length)
    await tools.waitForSelector('.tre-player .twrp-frame video', { state: 'attached', timeout: 300000 })
    await pictureReady(tools)
    assert.equal(await tools.locator('.tw-tools-bar').count(), 1, 'one bar above the content')
    for (const gone of ['Look and sound…', 'Face: corner', 'Record this slide again']) assert.equal(await tools.getByText(gone).count(), 0, `${gone} belongs to a later slice`)
    assert.equal(await tools.locator('[data-w]').count(), ctx.words.length, 'every word is shown')
    assert.equal(await tools.locator('.tre-len').textContent(), new Date(D).toISOString().slice(15, 19).replace(/^0/, ''))
    await shot(tools, 'ready')
    pass('Edit video opens the editor: one bar, the talk slide by slide with every word')

    // ---- Select words and cut; the plan skips them ------------------------------------------------
    const a = rows[1].firstWord + 2, b = a + 4
    await dragWords(tools, a, b)
    await tools.waitForSelector('.tre-pop')
    assert.equal(await tools.locator('.tre-sel').count(), 5)
    await shot(tools, 'selected')
    await tools.keyboard.press('Backspace')
    let s = await saved(tools)
    const cutRange = cutWordsOp(ctx, a, b).range
    assert.deepEqual(s.cuts, [cutRange], 'the cut runs on the frame grid between the word before and the word after')
    await tools.waitForTimeout(400)
    assert.equal(await tools.locator('.tre-playbtn').getAttribute('aria-label'), 'Play', 'a clean cut plays nothing')
    assert.equal(await tools.locator('.tre-cut').count(), 5, 'the cut words are struck through')
    const firstCutMs = await lastEditMs(tools)
    pass(`selecting five words by drag and pressing ⌫ cuts them (shown in ${firstCutMs} ms) and saves the cut`)

    // Hear nothing: play across the cut and watch the player's Run-time playhead.
    const seen = await tools.evaluate(async ({ from, until }) => {
      const player = document.querySelector('.tre-player .twrp-player'), times = []
      return await new Promise((done) => {
        const obs = new MutationObserver(() => times.push(Number(player.dataset.runMs)))
        obs.observe(player, { attributes: true, attributeFilter: ['data-run-ms'] })
        const word = document.querySelector(`[data-w="${from}"]`)
        word.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }))
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        setTimeout(() => { document.querySelector('.tre-playbtn').click(); setTimeout(() => { document.querySelector('.tre-playbtn').click(); obs.disconnect(); done(times) }, until) }, 300)
      })
    }, { from: a - 2, until: 2600 })
    const inside = seen.filter((t) => t > cutRange.start + 40 && t < cutRange.end - 40)
    assert.ok(seen.some((t) => t >= cutRange.end), `the playhead passed the cut (${seen.length} readings)`)
    assert.deepEqual(inside, [], 'nothing inside the cut was played')
    pass(`playing across the cut never plays inside it (${seen.length} playhead readings, none inside)`)

    // Restore from the cut's popover.
    await tools.locator(`[data-w="${a}"]`).click()
    await tools.getByRole('button', { name: 'Put the words back' }).click()
    s = await saved(tools)
    assert.deepEqual(s.cuts, []); assert.equal(await tools.locator('.tre-cut').count(), 0)
    pass('Put the words back restores them')

    // ---- A clean cut, a folded cut and a close cut moved to the nearest pause ----------------------
    await dragWords(tools, rows[0].firstWord + 3, rows[0].firstWord + 5); await tools.keyboard.press('Delete'); await saved(tools)
    const fold = rows[2].firstWord + 1
    await dragWords(tools, fold, fold + 11); await tools.keyboard.press('Backspace'); s = await saved(tools)
    assert.equal(await tools.locator('.tre-cutchip').filter({ hasText: '12 words cut' }).count(), 1, 'a long cut folds into one chip with Restore')
    // A close cut: two words ending where no clean pause or confident midpoint is (a short pause between phrases).
    let w = -1
    for (let i = rows[1].firstWord + 2; i < rows[1].endWord - 1; i++) if (ctx.gaps[i + 1].quality === 'close' && ctx.gaps[i - 1].quality === 'clean') { w = i; break }
    assert.ok(w > 0, 'the fixture has a short pause between phrases')
    const closeBefore = await tools.locator('.tre-close').count()
    await dragWords(tools, w - 1, w); await tools.keyboard.press('Backspace'); s = await saved(tools)
    // A close cut plays a second either side of its join, then stops.
    await tools.waitForFunction(() => document.querySelector('.tre-playbtn')?.getAttribute('aria-label') === 'Pause', {}, { timeout: 3000 })
    const heard = await tools.evaluate(() => Number(document.querySelector('.tre-player .twrp-player').dataset.runMs))
    await tools.waitForFunction(() => document.querySelector('.tre-playbtn')?.getAttribute('aria-label') === 'Play', {}, { timeout: 8000 })
    const madeClose = s.cuts.find((c) => c.start <= ctx.words[w - 1].mid && c.end > ctx.words[w].mid)
    assert.ok(madeClose && heard >= madeClose.start - 1200 && heard <= madeClose.end + 1200, `the preview played around the join (${heard} ms near ${JSON.stringify(madeClose)})`)
    assert.equal(await tools.locator('.tre-close').count(), closeBefore + 1, 'the close cut is marked')
    assert.equal(await tools.locator('.tre-check.close').count(), closeBefore + 1, 'To check lists it')
    const mine = tools.locator('[data-row="1"] .tre-close').last()
    await mine.scrollIntoViewIfNeeded(); await mine.click()
    await tools.waitForSelector('.tre-pop')
    assert.ok(await tools.getByText('This cut is close to a spoken word and may clip it.').count())
    await shot(tools, 'cuts')
    const before = s.cuts.length
    await tools.getByRole('button', { name: 'Outward' }).click()
    s = await saved(tools)
    assert.equal(await tools.locator('.tre-close').count(), closeBefore, 'moved outward to a pause, the cut is clean')
    assert.equal(s.cuts.length, before)
    pass('cuts are struck or folded with Restore; a close cut plays its join, is marked, listed and moved outward to the nearest pause')

    // ---- Leave a slide out and put it back -------------------------------------------------------------
    const lo = rows[3]
    await tools.locator(`[data-row="3"]`).scrollIntoViewIfNeeded(); await tools.locator(`[data-row="3"]`).hover()
    await tools.locator(`[data-row="3"]`).getByRole('button', { name: 'Leave this slide out' }).click()
    s = await saved(tools)
    assert.deepEqual(s.leftOut, [lo.change], 'leaving a slide out is saved as its own fact')
    assert.ok(!s.cuts.some((c) => c.start <= Math.round(lo.start) && c.end >= Math.round(lo.end)), 'not as a merged cut')
    await tools.waitForSelector('.tre-leftout')
    await tools.locator('.tre-leftout').scrollIntoViewIfNeeded()
    await shot(tools, 'left-out')
    await tools.getByRole('button', { name: 'Put this slide back' }).click()
    s = await saved(tools)
    assert.equal(await tools.locator('.tre-leftout').count(), 0)
    assert.deepEqual(s.leftOut, [])
    pass('Leave this slide out folds the row and is saved as its own fact; Put this slide back removes it')

    // ---- Keys wait while the export sheet is open; Escape closes it first; focus comes back --------------
    await dragWords(tools, rows[4].firstWord + 1, rows[4].firstWord + 2)
    await tools.waitForSelector('.tre-pop')
    const revBefore = sidecar().revision
    const exportButton = tools.locator('.tre-bar').getByRole('button', { name: /^Export…$/ })
    await exportButton.click()
    await tools.waitForSelector('.twrp-sheet')
    for (const key of ['Backspace', 'Delete', 'Meta+z', 'i', 'o', 'ArrowRight']) await tools.keyboard.press(key)
    await tools.waitForTimeout(300)
    assert.equal(sidecar().revision, revBefore, 'no editor key acted behind the sheet')
    assert.equal(await tools.locator('.tre-sel').count(), 2, 'the selection is untouched')
    await tools.keyboard.press('Escape')
    assert.equal(await tools.locator('.twrp-sheet').count(), 0, 'Escape closes the sheet first')
    assert.equal(await tools.locator('[data-recording-editor]').count(), 1, 'and not the editor')
    await tools.waitForFunction(() => document.activeElement?.textContent?.includes('Export…'), {}, { timeout: 2000 })
    await exportButton.click()
    await tools.waitForSelector('.twrp-sheet')
    await tools.waitForFunction(() => document.activeElement?.closest('.twrp-sheet'), {}, { timeout: 2000 })
    await tools.keyboard.press('Space')
    await tools.waitForTimeout(300)
    assert.equal(await tools.locator('.twrp-sheet').count(), 0, 'Space pressed the focused button (Cancel)')
    assert.equal(await tools.locator('.tre-playbtn').getAttribute('aria-label'), 'Play', 'and did not play the video')
    await tools.keyboard.press('Escape')
    pass('while the export sheet is open no editor key acts; Escape closes it, not the editor; Space presses its button; focus returns')

    // ---- Move a slide's start -----------------------------------------------------------------------
    const k = 2
    const target = boundaryTargets(ctx, rows, k, false).filter((t) => t.word < rows[k].firstWord).at(-1)
    assert.ok(target, 'a clean pause in the slide before')
    await tools.locator(`[data-row="${k - 1}"]`).scrollIntoViewIfNeeded()
    // The handle appears over the row's top edge on hover.
    await tools.locator(`[data-row="${k}"] .tre-stitle`).hover()
    const h = await center(tools, `[data-row="${k}"] .tre-handle`)
    await tools.waitForFunction((k) => getComputedStyle(document.querySelector(`[data-row="${k}"] .tre-marker`)).opacity === '1', k, { timeout: 3000 })
    await tools.mouse.move(h.x, h.y); await tools.mouse.down()
    const t = await center(tools, `[data-w="${target.word}"]`)
    await tools.mouse.move(t.x, t.y, { steps: 8 })
    await tools.waitForSelector('.tre-snap.hit')
    await shot(tools, 'boundary-drag')
    await tools.mouse.up()
    s = await saved(tools)
    assert.equal(s.boundaries.length, 1); assert.equal(s.boundaries[0].change, rows[k].change); assert.equal(s.boundaries[0].at, target.at)
    assert.equal(await tools.locator(`[data-row="${k}"] .tre-moved`).count(), 1)
    assert.equal(await tools.locator(`[data-row="${k}"] [data-w="${target.word}"]`).count(), 1, 'the words moved to the slide')
    await tools.locator(`[data-row="${k}"]`).scrollIntoViewIfNeeded()
    await shot(tools, 'boundary')
    pass('dragging a slide start snaps to a clear pause, is saved as an edit boundary and moves the words')

    // ---- Timeline: select a range there; mirrored in the words -------------------------------------------
    await tools.getByRole('button', { name: 'Timeline' }).click()
    await tools.waitForSelector('[data-testid="editor-timeline"]')
    const voice = await tools.locator('.tre-trk.voice').boundingBox()
    const at = (ms) => voice.x + (voice.width * ms) / D
    const pick = rows[4]
    await tools.mouse.move(at(pick.start + 1200), voice.y + 20); await tools.mouse.down(); await tools.mouse.move(at(pick.start + 4200), voice.y + 20, { steps: 6 }); await tools.mouse.up()
    const selCount = await tools.locator('.tre-sel').count()
    assert.ok(selCount > 2, `the range selected in the timeline is selected in the words (${selCount} words)`)
    assert.equal(await tools.locator('.tre-tlsel').count(), 1)
    await tools.locator('.tre-sel').first().scrollIntoViewIfNeeded()
    await shot(tools, 'timeline')
    // And the other way: words selected in the text show on the timeline.
    await tools.keyboard.press('Escape')
    assert.equal(await tools.locator('.tre-tlsel').count(), 0)
    await dragWords(tools, rows[5].firstWord, rows[5].firstWord + 2)
    assert.equal(await tools.locator('.tre-tlsel').count(), 1, 'words selected in the text show on the timeline')
    await tools.keyboard.press('Escape'); await tools.keyboard.press('Escape')
    await tools.getByRole('button', { name: 'Close' }).click()
    pass('the timeline opens from the strip; a range selected there is the words’ selection and back')

    // ---- Tidy up -------------------------------------------------------------------------------------------
    const cutsBefore = sidecar().cuts.length
    await tools.getByRole('button', { name: 'Tidy up…' }).click()
    await tools.waitForSelector('.tre-sheet')
    const applyLabel = await tools.getByRole('button', { name: /^Cut the \d+ ticked$/ }).textContent()
    const ticked = Number(applyLabel.match(/\d+/)[0])
    assert.ok(ticked > 0)
    assert.equal(await tools.locator('[data-group="fillers"] .tre-cb').isDisabled(), true, 'um and er is empty and says why')
    assert.ok(await tools.getByText(/does not mark um and er/).count())
    for (const box of await tools.locator('[data-listen] .tre-cb').all()) assert.equal(await box.getAttribute('aria-checked'), 'false', 'Needs a listen is never ticked')
    await shot(tools, 'tidy')
    await tools.getByRole('button', { name: /^Cut the \d+ ticked$/ }).click()
    s = await saved(tools)
    assert.ok(s.cuts.length > cutsBefore, 'the ticked proposals were cut')
    pass(`Tidy up proposes; cutting the ${ticked} ticked is one step`)

    // ---- Undo everything, redo, reopen and find the edits --------------------------------------------------
    const full = sidecar()
    const steps = full.undo.length
    await tools.locator('.tre-what').click()
    for (let i = 0; i < steps; i++) await tools.keyboard.press('Meta+z')
    s = await saved(tools)
    assert.deepEqual(s.cuts, []); assert.deepEqual(s.boundaries, []); assert.deepEqual(s.leftOut, []); assert.equal(s.undo.length, 0)
    assert.equal(await tools.locator('.tre-cut, .tre-cutchip, .tre-moved').count(), 0)
    for (let i = 0; i < steps; i++) await tools.keyboard.press('Meta+Shift+z')
    s = await saved(tools)
    assert.deepEqual(s.cuts, full.cuts); assert.deepEqual(s.boundaries, full.boundaries)
    pass(`⌘Z undoes all ${steps} steps (cuts and the moved slide start); ⇧⌘Z redoes them`)
    const shownLen = await tools.locator('.tre-len b').textContent()
    const struck = await tools.locator('.tre-cut').count()
    await tools.close()
    tools = await openTools()
    await openEditor(tools)
    assert.equal(await tools.locator('.tre-len b').textContent(), shownLen)
    assert.equal(await tools.locator('.tre-cut').count(), struck)
    assert.equal(await tools.locator('.tre-moved').count(), 1)
    assert.equal(await tools.getByRole('button', { name: 'Undo' }).isEnabled(), true, 'the history is kept')
    pass('reopened, the editor shows the same edits and keeps the history')

    // ---- A save that fails, then Export: nothing is exported and the reason is given --------------------------
    const p1 = await freePair(tools, rows[4].firstWord)
    await dragWords(tools, p1, p1 + 1); await tools.keyboard.press('Backspace'); await saved(tools)
    const onDisk = sidecar()
    const struckSaved = await tools.locator('.tre-cut').count()
    chmodSync(runsDir, 0o555)
    try {
      const p2 = await freePair(tools, p1 + 3)
      await dragWords(tools, p2, p2 + 1); await tools.keyboard.press('Backspace')
      await tools.locator('.tre-bar').getByRole('button', { name: /^Export…$/ }).click()
      await tools.getByText(/An edit could not be saved, so nothing was exported/).waitFor({ timeout: 10000 })
      assert.deepEqual(sidecar().cuts, onDisk.cuts, 'the disk holds only the first cut')
      assert.equal(await tools.locator('.twrp-sheet').getByRole('button', { name: 'Choose another place…' }).count(), 0)
      await tools.locator('.twrp-sheet').getByRole('button', { name: 'Close' }).click()
    } finally { chmodSync(runsDir, 0o755) }
    assert.equal(await tools.locator('.tre-cut').count(), struckSaved, 'the screen shows what is saved')
    await tools.locator('.tre-note [aria-label="Dismiss"]').click()
    s = sidecar()
    pass('a queued save that fails, then Export: nothing is exported, the sheet says an edit failed, the screen goes back to what is saved')

    // ---- Export: the exported length is the edited length ---------------------------------------------------
    const editedShown = Number(await tools.locator('.tre-len').getAttribute('data-edited-ms'))
    const resolvedNow = resolveRecording({ durationMs: D, ctx, edits: s, runTrims: run.trims, marks: fx.marks })
    assert.equal(editedShown, Math.round(resolvedNow.editedMs))
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, join(out, 'edited.mp4'))
    await tools.getByRole('button', { name: /^Export…$/ }).first().click()
    await tools.locator('.twrp-sheet').getByRole('button', { name: 'Export…' }).click()
    await tools.getByText(/Saved: edited\.mp4/).waitFor({ timeout: 600000 })
    if (ffprobe) {
      const probe = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration', '-of', 'json', join(out, 'edited.mp4')]).stdout.toString())
      const durationMs = Math.round(Number(probe.format.duration) * 1000)
      const video = probe.streams.find((x) => x.codec_type === 'video')
      const videoMs = Math.round(Number(video.duration) * 1000)
      measured.export = { editedMs: editedShown, formatMs: durationMs, videoMs }
      assert.ok(Math.abs(videoMs - editedShown) <= 34 + 50, `exported video ${videoMs} ms, edited length ${editedShown} ms`)
      pass(`exported: ffprobe video ${videoMs} ms for an edited length of ${editedShown} ms (recording ${D} ms)`)
    } else console.log('SKIP ffprobe not found')
    await tools.getByRole('button', { name: 'Done' }).click()
    measured.firstCutShownMs = firstCutMs

    // ---- Words that change while the editor is open: selection, popovers and drags from the old words go ----
    const tell = (note) => app.evaluate(({ BrowserWindow }, { id, note }) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('transcript:progress', { sessionId: id, note }) }, { id: run.id, note })
    const revWords = sidecar().revision
    const q1 = await freePair(tools, rows[1].firstWord)
    await dragWords(tools, q1, q1 + 1)
    await tools.waitForSelector('.tre-pop')
    // A slide-start drag in progress when the words change.
    await tools.locator('[data-row="2"]').scrollIntoViewIfNeeded()
    await tools.locator('[data-row="2"] .tre-stitle').hover()
    await tools.waitForFunction(() => getComputedStyle(document.querySelector('[data-row="2"] .tre-marker')).opacity === '1', {}, { timeout: 3000 })
    const hh = await center(tools, '[data-row="2"] .tre-handle')
    await tools.mouse.move(hh.x, hh.y); await tools.mouse.down(); await tools.mouse.move(hh.x + 40, hh.y - 60, { steps: 4 })
    await tools.waitForSelector('.tre-ghost')
    const shifted = { ...fx.transcript, words: fx.transcript.words.map((x) => ({ ...x, alignment: { ...x.alignment, start: x.alignment.start + 40, end: x.alignment.end + 40 } })) }
    shifted.alignment = { ...fx.transcript.alignment, alignedAt: '2026-11-11T12:00:00Z', midpoints: shifted.words.slice(0, -1).map((x, i) => (x.alignment.end + shifted.words[i + 1].alignment.start) / 2) }
    writeFileSync(transcriptFile, JSON.stringify(shifted))
    await tell('Words are ready.')
    await tools.waitForSelector('.tre-words-note', { timeout: 10000 })
    assert.equal(await tools.locator('.tre-ghost').count(), 0, 'the drag stopped'); assert.equal(await tools.locator('.tre-sel').count(), 0, 'the selection was cleared'); assert.equal(await tools.locator('.tre-pop').count(), 0, 'the popover closed')
    await tools.mouse.move(hh.x + 40, hh.y - 120, { steps: 3 }); await tools.mouse.up()
    await tools.waitForTimeout(400)
    assert.equal(sidecar().revision, revWords, 'releasing the old drag saved nothing')
    pass('words that change while the editor is open: the note shows, the selection and popover clear, a slide-start drag in progress stops and saves nothing')

    // ---- Words that cannot be read: refused, then "Export without captions" shows and exports the plan without words ----
    writeFileSync(transcriptFile, '{ not json')
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, join(out, 'without-words.mp4'))
    await tools.locator('.tre-bar').getByRole('button', { name: /^Export…$/ }).click()
    await tools.locator('.twrp-sheet').getByRole('button', { name: 'Export…' }).click()
    await tools.getByText(/could not be read, so TalkWeaver cannot check the cuts/).waitFor({ timeout: 20000 })
    assert.ok(await tools.locator('[data-w]').count() > 0, 'the loaded words are not swapped for none')
    await tools.locator('.twrp-sheet').getByRole('button', { name: 'Export without captions' }).click()
    await tools.getByText(/Shown without words, as it will be exported/).waitFor()
    assert.equal(await tools.locator('[data-w]').count(), 0, 'the editor shows the plan without words')
    const wordless = Number(await tools.locator('.tre-len').getAttribute('data-edited-ms'))
    await tools.locator('.twrp-sheet').getByRole('button', { name: 'Export…' }).click()
    await tools.getByText(/Saved: without-words\.mp4/).waitFor({ timeout: 600000 })
    if (ffprobe) {
      const probe = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', join(out, 'without-words.mp4')]).stdout.toString())
      const videoMs = Math.round(Number(probe.streams.find((x) => x.codec_type === 'video').duration) * 1000)
      assert.ok(Math.abs(videoMs - wordless) <= 34 + 50, `exported ${videoMs} ms, shown ${wordless} ms`)
    }
    assert.equal(existsSync(join(out, 'without-words.srt')), false, 'no captions')
    await tools.getByRole('button', { name: 'Done' }).click()
    await tools.waitForFunction(() => document.querySelectorAll('[data-w]').length > 0, {}, { timeout: 5000 })
    pass('words that cannot be read: Export says so and offers Export without captions, which shows the plan without words and exports exactly that')

    // ---- States: without precise word timing, no words, writing, preparing the model ------------------------
    const plain = { ...fx.transcript, words: fx.transcript.words.map(({ alignment, ...w }) => w) }
    delete plain.alignment
    writeFileSync(transcriptFile, JSON.stringify(plain))
    unlinkSync(editsFile)
    await tools.close(); tools = await openTools(); await openEditor(tools)
    await pictureReady(tools)
    let cw = -1
    for (let i = rows[1].firstWord + 3; i < rows[1].endWord - 2; i++) if (editorWords(plain, D).gaps[i].quality === 'close') { cw = i; break }
    await dragWords(tools, cw, cw + 3)
    await tools.waitForSelector('.tre-pop')
    assert.ok(await tools.getByText(/may clip a word/).count(), 'the selection says the cut may clip a word')
    await shot(tools, 'no-timing')
    pass(`without precise word timing a mid-phrase selection says it may clip a word${await tools.locator('.tre-check.timing').count() ? ', and To check offers the download' : ' (no download offered: no English model row on this machine)'}`)
    await tools.keyboard.press('Escape')

    writeFileSync(transcriptFile, JSON.stringify({ ...fx.transcript, words: [], alignment: undefined }))
    await tools.close(); tools = await openTools(); await openEditor(tools)
    await tools.waitForSelector('[data-recording-editor][data-state="nowords"]')
    assert.ok(await tools.getByText('No words for this slide.').count())
    assert.ok(await tools.getByRole('button', { name: 'Try again' }).count())
    assert.equal(await tools.getByRole('button', { name: 'Tidy up…' }).isDisabled(), true)
    await pictureReady(tools)
    await shot(tools, 'nowords')
    assert.equal(await tools.getByRole('button', { name: 'Leave this slide out' }).first().isEnabled(), true)
    pass('no words: says so with Try again; slides can still be left out and the video exported')

    unlinkSync(transcriptFile)
    await tools.close(); tools = await openTools(); await openEditor(tools)
    await pictureReady(tools)
    const say = (note) => app.evaluate(({ BrowserWindow }, { id, note }) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('transcript:progress', { sessionId: id, note }) }, { id: run.id, note })
    await say("Preparing this Mac's speech model: 62%")
    await tools.waitForSelector('[data-recording-editor][data-state="writing-model"]')
    await shot(tools, 'writing-model')
    await say('Words are being written out on this Mac.')
    await tools.waitForSelector('[data-recording-editor][data-state="writing"]')
    await shot(tools, 'writing')
    pass('while words are written (and while macOS prepares its speech model) the rows wait and slide actions work')
  }
  if (!LONG) writeFileSync(join(built, 'journey-result.json'), JSON.stringify({ at: new Date().toISOString(), passed: count, measured }, null, 1) + '\n')
  console.log(`\n${count} passed`)
} finally {
  await app?.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
