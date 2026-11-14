// Hidden development-app journey for the recording editor's sentence starts (0.44.5): a row shows where
// stored sentences begin, and the slide-start handle snaps to a sentence start and says so. Built like
// diagnose-recording-follow-ups.mjs: hidden Electron, fake devices (--use-fake-device-for-media-stream,
// TW_REC_TEST), a throwaway profile and vault with a generated talk (neutral words, no real speech); never
// the owner's. Needs `npm run build`. Pictures go to
// docs/design/2026-11-10-record-and-edit-video/built/0.44.5/shots/sentence-*.png.
//   node e2e/diagnose-recording-sentences.mjs
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { boundaryTargets, editorWords, slideRows } from '../src/shared/recording-editor.ts'
import { makeEditorFixture } from '../scripts/fixtures/recording-editor-fixture.mjs'

const repo = resolve(import.meta.dirname, '..'), shots = join(repo, 'docs/design/2026-11-10-record-and-edit-video/built/0.44.5/shots')
const root = mkdtempSync(join(repo, '.sentences-e2e-')), vault = join(root, 'vault'), userData = join(root, 'userData'), talk = join(vault, 'fixture')
for (const dir of [talk, userData, shots]) mkdirSync(dir, { recursive: true })
const TITLES = ['A single strong claim', 'A plain list, with icons', 'A process, left to right', 'Statement beside a list', 'Big numbers', 'Steps that build']
const outline = join(talk, 'fixture-outline.md')
const content = `---\ntitle: TalkWeaver Layout Showcase\n---\n\n## Talk\n\n${TITLES.map((t, i) => `### ${t} {id=s${i + 1}}\n\nPoint ${i + 1}.\n`).join('\n')}`
writeFileSync(outline, content)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, recordingDiscardMs: 800 }))
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const gen = (args) => { const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args], { timeout: 600_000 }); assert.equal(r.status, 0, r.stderr?.toString()) }
const runsDir = join(vault, '_PRESENTATIONS', 'fixture')
let app, count = 0
const pass = (name) => console.log(`PASS ${++count} ${name}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A hard stop inside the script: a hung app never outlives the slot (10 minutes).
const hardStop = setTimeout(() => { console.error('HARD TIMEOUT: the journey did not finish in 10 minutes'); try { app?.process()?.kill('SIGKILL') } catch {} process.exit(124) }, 10 * 60 * 1000)
hardStop.unref()

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
  const transcriptFile = join(runsDir, `${run.id}.transcript.json`)
  for (let i = 0; i < 80 && !existsSync(transcriptFile); i++) await sleep(250)
  await sleep(500)

  // The generated talk with stored sentences, and its layers (test patterns and a tone).
  const fx = makeEditorFixture({ slides: 6, wordsPerSlide: 30, seed: 5, sentences: true })
  const D = fx.durationMs, sec = String(D / 1000)
  const rec = join(userData, 'recordings', run.id), voice = join(userData, 'recordings', run.audio.segments[0].file)
  gen(['-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=30:d=${sec}`, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-f', 'webm', join(rec, 'slides.webm')])
  gen(['-f', 'lavfi', '-i', `testsrc=s=320x240:r=30:d=${sec}`, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '60k', '-f', 'webm', join(rec, 'camera.webm')])
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
  const sidecar = () => (existsSync(editsFile) ? JSON.parse(readFileSync(editsFile, 'utf8')) : { boundaries: [] })
  const ctx = editorWords(fx.transcript, D)
  const rows = slideRows(ctx, fx.marks)
  assert.ok(ctx.sentences)
  pass(`a layered Run with a generated talk and stored sentences: ${ctx.words.length} words, ${rows.length} slides, ${ctx.gaps.filter((g) => g.sentence).length} sentence starts`)

  const toolsOpened = app.waitForEvent('window')
  await main.evaluate((id) => window.tw.tools.open('studio', id), run.id)
  const tools = await toolsOpened
  tools.on('pageerror', (error) => console.error('tools error:', error.message))
  await tools.setViewportSize({ width: 1440, height: 900 })
  await tools.waitForSelector('[data-recording-panel]', { timeout: 120000 })
  await tools.locator('[data-edit-video]').click()
  await tools.waitForSelector('[data-recording-editor] [data-row]', { timeout: 30000 })
  const editsRevision = async () => Number(await tools.locator('[data-recording-editor]').getAttribute('data-edits-revision'))
  const saved = async () => { for (let i = 0; i < 100; i++) { if (existsSync(editsFile) && sidecar().revision === (await editsRevision())) return sidecar(); await sleep(50) } throw Error('the edit was not saved') }
  const center = async (selector) => { const b = await tools.locator(selector).first().boundingBox(); assert.ok(b, `${selector} is on screen`); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
  const shot = async (name) => { await tools.waitForTimeout(250); await tools.screenshot({ path: join(shots, `${name}.png`) }) }
  assert.equal(await tools.locator('.tw-tools-bar').count(), 1, 'one bar above the content')

  // ---- Sentence marks in the words --------------------------------------------------------------------
  // Row 1: every sentence start inside it (not its first word, not at a pause chip) has a thin mark just before the word.
  const r = 1
  await tools.locator(`[data-row="${r}"]`).scrollIntoViewIfNeeded()
  const marks = await tools.evaluate((r) => [...document.querySelectorAll(`[data-row="${r}"] .tre-sb`)].map((el) => {
    let next = el.nextElementSibling
    return { at: Number(el.dataset.sentence), next: next ? Number(next.dataset.w) : null, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }
  }), r)
  const expected = []
  for (let i = rows[r].firstWord + 1; i < rows[r].endWord; i++) if (ctx.gaps[i].sentence && !(ctx.gaps[i].pause && ctx.gaps[i].pauseMs >= 1000)) expected.push(i)
  assert.ok(expected.length >= 1, 'the fixture has sentence starts inside row 1')
  assert.deepEqual(marks.map((m) => m.at), expected, 'a mark at every sentence start in the row')
  assert.ok(marks.every((m) => m.next === m.at), 'each mark sits just before the first word of its sentence')
  assert.ok(marks.every((m) => m.width <= 6 && m.height > 8), 'thin and quiet')
  await tools.locator(`[data-row="${r}"] .tre-sb`).first().scrollIntoViewIfNeeded()
  await shot('sentence-marks')
  pass(`row ${r + 1} marks ${marks.length} sentence starts, each just before its first word`)

  // ---- The slide-start handle snaps to a sentence start -------------------------------------------------
  let k = -1, target = null
  for (let i = 1; i < rows.length && k < 0; i++) {
    const t = boundaryTargets(ctx, rows, i, false).filter((x) => x.kind === 'sentence' && x.word < rows[i].firstWord).at(-1)
    if (t) { k = i; target = t }
  }
  assert.ok(target, 'a sentence start to move a slide start to')
  await tools.locator(`[data-row="${k - 1}"]`).scrollIntoViewIfNeeded()
  await tools.locator(`[data-row="${k}"] .tre-stitle`).hover()
  await tools.waitForFunction((k) => getComputedStyle(document.querySelector(`[data-row="${k}"] .tre-marker`)).opacity === '1', k, { timeout: 3000 })
  assert.match(await tools.locator(`[data-row="${k}"] .tre-handle`).getAttribute('title'), /snaps to clear pauses and sentence starts/)
  const h = await center(`[data-row="${k}"] .tre-handle`)
  await tools.mouse.move(h.x, h.y); await tools.mouse.down()
  const t = await center(`[data-w="${target.word}"]`)
  await tools.mouse.move(t.x, t.y, { steps: 8 })
  await tools.waitForSelector(`.tre-snap.hit[data-snap="${target.word}"][data-snap-kind="sentence"]`, { timeout: 5000 })
  const ghost = await tools.locator('.tre-ghost .tre-gsub').textContent()
  assert.match(ghost, /^at a sentence start/, `the drag label says what the place is (${ghost})`)
  if (target.quality === 'close') assert.match(ghost, /needs a listen/)
  assert.ok(await tools.locator('.tre-snap[data-snap-kind="pause"]').count() >= 1, 'clear pauses are still offered')
  await shot('sentence-handle')
  await tools.mouse.up()
  let s = await saved()
  assert.deepEqual(s.boundaries, [{ change: rows[k].change, at: target.at }], 'stored as a move to a place, not any word')
  assert.equal(await tools.locator(`[data-row="${k}"] [data-w="${target.word}"]`).count(), 1, 'the words moved to the slide')
  await tools.keyboard.press('Meta+z')
  s = await saved()
  assert.deepEqual(s.boundaries, [], 'undo puts the start back')
  pass(`the handle of slide ${k + 1} snaps to the sentence start before word ${target.word} ("${ghost.trim()}"), saves the move, and undo puts it back`)

  console.log(`\n${count} passed`)
} finally {
  await app?.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
