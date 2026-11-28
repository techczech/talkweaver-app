// Journey, second half: steps 4 to 6 (record, edit the recording, export, delete), in phases, each its own app
// launch. State (profile, vault, recordings) lives in TW_JOURNEY_STATE, which every phase must be given and
// which the caller removes after the last phase (run.mjs does); evidence goes to artefacts/journey/<phase>/.
//   TW_JOURNEY_STATE=<dir> TW_PHASE=record  node scripts/journeys/record-edit-export.mjs
//   phases, in order: record · edit · reopen · export · sentence · retake · second-mac · delete
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { launch, closeApp, runFolders, ledger, shooter, size, pause, hardLimit, openPresenter, winCall, writeJson, commit, recordAgainOn, REPO, FFMPEG, OUT_ROOT as OUT_ROOT_B } from './lib.mjs'
import { makeVault, TITLE, SLUG } from './talk.mjs'
import { standInTranscript, joinChange, JOIN_SLIDE } from './stand-in.mjs'
import { keptOnFrames, parseSrt, parseVtt, expectedChaptersOf, captionWordsMatch } from './video-checks.mjs'
import { savedNoteMeasured, savedNoteKnownFault, sentenceNotReached } from './could-not-allowed.mjs'
import { SECTION_OF } from './talk.mjs'
const { slideRows, editorWords, slideVisits } = await import('../../src/shared/recording-editor.ts')
const { emptyEdits } = await import('../../src/shared/recording-edits.ts')
import { openTalkByTitle } from '../../e2e/lib/talklist.mjs'

if (!process.env.TW_JOURNEY_STATE) throw new Error('Set TW_JOURNEY_STATE to a folder (kept across phases).')
const PHASE = process.env.TW_PHASE || 'record'
hardLimit(Number(process.env.TW_LIMIT_MS || 540000), 'record-edit-export-' + PHASE)
const { out, state, userData } = runFolders(PHASE)
mkdirSync(join(out, '..', 'guide'), { recursive: true })
const vault = join(state, 'vault')
if (!existsSync(vault)) makeVault(state)
const outlinePath = join(vault, SLUG, `${SLUG}-outline.md`)
mkdirSync(userData, { recursive: true })
if (!existsSync(join(userData, 'config.json'))) writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, recordingDiscardMs: 800, theme: 'light' }))
const runsDir = join(vault, '_PRESENTATIONS', SLUG)
const RECORD_AGAIN = await recordAgainOn()
const { record, harness } = ledger(out, PHASE, { recordAgain: RECORD_AGAIN })
const shot = shooter(out)
const rel = (p) => p.replace(REPO + '/', '')
// A step that throws is a harness FAIL; the checks it did not reach are then missing, which also fails the stage.
const step = async (name, fn) => { try { await fn() } catch (e) { harness(`${name}: ${String(e?.stack || e).slice(0, 900)}`) } }
const runs = () => (existsSync(runsDir) ? readdirSync(runsDir).filter((f) => /^[^.]+\.json$/.test(f) && f !== 'manifest.json').map((f) => ({ f, run: JSON.parse(readFileSync(join(runsDir, f), 'utf8')) })) : [])
const mainRun = () => runs().find((x) => x.run.capture?.layers?.camera && !x.run.takeOf)
const dumpControls = async (page, file) => writeFileSync(join(out, file), (await page.evaluate(() => [...document.querySelectorAll('button,[role=tab],[role=button],[role=menuitem],[role=radio],[role=checkbox],a,select,input')].filter((e) => e.offsetParent !== null).map((e) => `${e.tagName} ${e.getAttribute('aria-label') || ''} | ${(e.textContent || '').trim().slice(0, 50)} | ${e.className?.toString().slice(0, 50)} | ${[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.name + '=' + a.value).join(' ')}`))).join('\n'))
console.log('commit', commit(), 'phase', PHASE, 'state', state)

// What the test-mode transcription (TW_REC_TEST, src/main/transcription.ts fixtureTranscript) writes for every Run.
const FIXTURE_WORDS = 'Fixture transcript opening segment. Fixture transcript middle segment for trim tests. Fixture transcript closing segment.'
const isFixture = (tr) => !!tr && Array.isArray(tr.words) && tr.words.length > 0 && tr.words.every((w) => typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end)) && tr.words.map((w) => w.text).join(' ') === FIXTURE_WORDS
/** JSON with object keys sorted: equality that does not depend on the order a writer put the keys in. */
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x))
const same = (a, b) => canon(a) === canon(b)
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
const editsFileOf = (id) => join(runsDir, `${id}.edits.json`)
const sidecar = (id) => (existsSync(editsFileOf(id)) ? JSON.parse(readFileSync(editsFileOf(id), 'utf8')) : { cuts: [], boundaries: [], undo: [], redo: [] })
async function openStudio(runId) {
  const known = new Set(app.windows())
  await main.evaluate((id) => window.tw.tools.open('studio', id), runId)
  const tools = await newWindow(known, 30000)
  if (!tools) throw new Error('no Tools window')
  tools.on('pageerror', (e) => console.log('tools pageerror', e.message))
  await tools.setViewportSize({ width: 1440, height: 900 })
  await tools.waitForSelector('[data-recording-panel]', { timeout: 120000 })
  return tools
}
// The player is ready when both recorded layers (slides and camera) have a decoded, sized picture. Returns what
// it saw; ready=false after the bound (the caller's check fails with that evidence).
async function pictureReady(page, ms = 120000) {
  const look = () => page.evaluate(() => {
    const v = (cls) => [...document.querySelectorAll(`.twrp-frame video.${cls}`)]
    const ok = (list) => list.length >= 1 && list.every((x) => !x.seeking && x.readyState >= 2 && x.videoWidth > 0)
    return { slides: v('twrp-slides').length, camera: v('twrp-camera').length, ready: ok(v('twrp-slides')) && ok(v('twrp-camera')), states: [...document.querySelectorAll('.twrp-frame video')].map((x) => [x.className, x.readyState, x.videoWidth]) }
  })
  const t0 = Date.now()
  let seen = await look()
  while (!seen.ready && Date.now() - t0 < ms) { await pause(500); seen = await look() }
  return seen
}
async function savedEdits(tools, id) { for (let i = 0; i < 120; i++) { const rev = Number(await tools.locator('[data-recording-editor]').getAttribute('data-edits-revision').catch(() => NaN)); if (existsSync(editsFileOf(id)) && sidecar(id).revision === rev) return sidecar(id); await pause(50) } throw new Error('the edit was not saved') }
const centre = async (page, sel) => { const b = await page.locator(sel).first().boundingBox(); if (!b) throw new Error(sel + ' not on screen'); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
async function dragWords(page, a, b) { await page.locator(`[data-w="${a}"]`).scrollIntoViewIfNeeded(); const p = await centre(page, `[data-w="${a}"]`), q = await centre(page, `[data-w="${b}"]`); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 }); await page.mouse.move(q.x, q.y, { steps: 4 }); await page.mouse.up() }
// The recording's own marks, as the app checkpoints them every second while recording: raw marks (pauses still
// in their clock) and the recording clock (pauses taken out). A mark's time on the recording clock is its raw
// time less every pause that ended before it.
function checkpointedMarks() {
  const dir = join(userData, 'recordings')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.recording.json')).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) : []
  const m = files.length ? readJson(files[0]) : null
  if (!m || !Array.isArray(m.rawMarks) || !Number.isFinite(m.recordingMs)) return null
  const pauses = []; let open = null
  for (const e of m.rawMarks) { if (e.event === 'pause') open = e.tMs; else if (e.event === 'resume' && open !== null) { pauses.push([open, e.tMs]); open = null } }
  const onClock = (t) => t - pauses.filter(([, b]) => b <= t).reduce((n, [a, b]) => n + (b - a), 0)
  const enter = m.rawMarks.filter((e) => e.event === 'enter').at(-1)
  return { clock: m.recordingMs, last: enter ? { slideId: enter.slideId, at: Math.round(onClock(enter.tMs)) } : null }
}
/** Wait until the checkpointed marks show `slideId` as the slide last entered and the recording clock 5 s past it. */
async function dwellOnMarks(slideId, ms = 5000, bound = 30000) {
  const t0 = Date.now()
  let seen = null
  while (Date.now() - t0 < bound) {
    seen = checkpointedMarks()
    if (seen?.last?.slideId === slideId && seen.clock - seen.last.at >= ms) return { ...seen.last, clock: seen.clock }
    await pause(200)
  }
  throw new Error(`the recording's marks did not show ${slideId} with ${ms} ms of recording after it within ${bound / 1000} s: ${JSON.stringify(seen)}`)
}
const editedMs = async (tools) => Number(await tools.locator('.tre-len').getAttribute('data-edited-ms'))

let app, main
const newWindow = async (known, ms) => { for (let i = 0; i < ms / 250; i++) { const w = app.windows().find((x) => !known.has(x) && !x.isClosed()); if (w) return w; await pause(250) } return null }
try {
  // Two Macs (0.45): this profile is "First Mac"; the second-mac phase starts a second profile as "Second Mac".
  if (PHASE === 'second-mac') { const cfg = readJson(join(userData, 'config.json')) ?? {}; writeFileSync(join(userData, 'config.json'), JSON.stringify({ ...cfg, computerName: 'First Mac' })) }
  ;({ app, main } = await launch(userData))
  await size(main); await pause(2500)
  await openTalkByTitle(main, TITLE); await pause(1500)

  // ── 4. Record ──────────────────────────────────────────────────────────────────────────────────
  if (PHASE === 'record') await step('4 record', async () => {
    const presenter = await openPresenter(app, main, 40000)
    if (!presenter) throw new Error('no presenter window')
    await presenter.waitForSelector('#twrec-primary', { timeout: 30000 })
    await size(presenter)
    if (await presenter.locator('#twResume:not([hidden])').count().catch(() => 0)) await presenter.locator('#twResumeNo').click().catch(() => {})
    await presenter.locator('#twrec-capture').selectOption('camera')
    await dumpControls(presenter, 'presenter-controls.txt')
    const capture = await presenter.locator('#twrec-capture').inputValue()
    const recordShown = await presenter.locator('#twrec-primary').isVisible()
    record('record.offers-camera', capture === 'camera' && recordShown, `capture=${capture}; Record visible=${recordShown}`, await shot(presenter, 'presenter-ready'))
    await presenter.locator('#twrec-primary').click()
    await presenter.waitForSelector('.twrec-device-check', { timeout: 20000 })
    await presenter.waitForFunction(() => !document.querySelector('[data-continue]')?.disabled, {}, { timeout: 20000 })
    const cam = await presenter.waitForFunction(() => { const v = document.querySelector('.twrec-device-check video'); return v && v.readyState >= 2 && v.videoWidth > 0 ? { readyState: v.readyState, width: v.videoWidth, height: v.videoHeight } : null }, {}, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => null)
    const continueOn = await presenter.locator('[data-continue]').isEnabled()
    record('record.device-check', !!cam && continueOn, `camera picture ${cam ? JSON.stringify(cam) : 'not ready in 20 s'}; Continue enabled=${continueOn}`, await shot(presenter, 'device-check'), { cam, continueOn })
    await presenter.locator('[data-continue]').click()
    await presenter.waitForSelector('#twrec-countdown', { timeout: 10000 })
    const cd = await presenter.locator('#twrec-countdown').innerText().catch(() => '')
    const cdShot = await shot(presenter, 'countdown')
    await presenter.waitForFunction(() => document.querySelector('#twrec-module')?.dataset.rec === 'recording', {}, { timeout: 20000 })
    await pause(600)
    const cdGone = !(await presenter.locator('#twrec-countdown').isVisible().catch(() => false))
    record('record.countdown', /\d/.test(cd) && cdGone, `countdown text "${cd.trim()}"; gone after start=${cdGone}`, cdShot)
    const t0 = Date.now()
    const ids = []
    const press = async (n) => { for (let i = 0; i < n; i++) { await presenter.keyboard.press('ArrowRight'); await pause(1500); ids.push(await presenter.evaluate(() => location.hash.slice(1))) } }
    await press(12)
    // At 1280×800 while recording the status bar still shows Pause and Stop (and the audience counts when live).
    await winCall(app, 'presenter=1', 'w.setBounds({ x: 0, y: 0, width: 1280, height: 800 }); return w.getBounds()'); await size(presenter, 1280, 800); await pause(1200)
    const bar1280 = await presenter.evaluate(() => {
      const seen = (sel) => { const el = document.querySelector(sel); if (!el) return 'absent'; const r = el.getBoundingClientRect(), c = getComputedStyle(el); return r.width > 4 && r.height > 4 && r.right <= innerWidth + 1 && c.visibility !== 'hidden' && c.display !== 'none' ? 'shown' : 'hidden' }
      const counts = [...document.querySelectorAll('.tw-st')].filter((e) => /reaction|question/i.test(e.className + ' ' + (e.dataset.tip || '') + ' ' + e.textContent)).map((e) => ({ t: (e.dataset.tip || e.textContent).trim().slice(0, 30), w: Math.round(e.getBoundingClientRect().width) }))
      return { pause: seen('#twrec-pause'), stop: seen('#twrec-stop'), counts, live: (document.body.innerText.match(/Not live|Live/) || [''])[0] }
    })
    const s1280 = await shot(presenter, 'recording-1280')
    record('record.status-1280-pause-stop', bar1280.pause === 'shown' && bar1280.stop === 'shown', `Pause ${bar1280.pause}, Stop ${bar1280.stop}`, s1280)
    const countsShown = bar1280.counts.some((c) => c.w > 0)
    record('record.audience-counts-1280', countsShown ? true : null, `${countsShown ? 'shown' : `not shown; not live in this journey (${bar1280.live}), so reactions and questions are not counted`}: ${JSON.stringify(bar1280.counts).slice(0, 200)}`, s1280, { live: bar1280.live, counts: bar1280.counts })
    await winCall(app, 'presenter=1', 'w.setBounds({ x: 0, y: 0, width: 1440, height: 900 }); return w.getBounds()'); await size(presenter, 1440, 900); await pause(600)
    await presenter.locator('#twrec-pause').click(); await pause(400)
    const paused = await presenter.locator('#twrec-module').getAttribute('data-rec')
    const pShot = await shot(presenter, 'paused')
    await pause(3000)
    await presenter.locator('#twrec-resume').click(); await pause(400)
    const resumed = await presenter.locator('#twrec-module').getAttribute('data-rec')
    record('record.pause-resume', paused === 'paused' && resumed === 'recording', `after pause data-rec=${paused}; after resume ${resumed}`, pShot)
    // One slide change with at least 5 s of recording on each side, as the recording's own marks show it: the
    // stand-in transcript (standInTranscript) speaks across the change into JOIN_SLIDE and needs 4 s on both sides. The
    // app checkpoints the marks and the recording clock every second (<userData>/recordings/<session>.recording.json);
    // the dwell waits on those, not on a sleep.
    const before = await dwellOnMarks(ids.at(-1))
    await presenter.evaluate((id) => { location.hash = id }, JOIN_SLIDE)
    const after = await dwellOnMarks(JOIN_SLIDE)
    ids.push(await presenter.evaluate(() => location.hash.slice(1)))
    console.log(`dwell: ${before.slideId} entered at ${before.at} ms, ${JOIN_SLIDE} at ${after.at} ms, clock ${after.clock} ms (recording clock)`)
    await press(12)
    // The slide video, played while recording (known fault being fixed: each play is saved twice).
    await presenter.evaluate(() => { location.hash = 'video' }); await pause(1500)
    // As a presenter plays a slide video: M (play media) in the presenter.
    await presenter.keyboard.press('m'); await pause(3000)
    const played = await presenter.evaluate(() => { const v = document.querySelector('#currentPreview iframe')?.contentDocument?.querySelector('.slide.active video'); return v ? `M pressed; preview video paused=${v.paused} at ${v.currentTime.toFixed(1)} s` : 'M pressed; no video in the preview' })
    await presenter.keyboard.press('ArrowRight'); await pause(1500)
    record('record.six-slides', new Set(ids).size >= 6, `${((Date.now() - t0) / 1000).toFixed(0)} s; slides ${[...new Set(ids)].join(' ')}`, await shot(presenter, 'recording-late'))
    // "Start again" while recording, on the last slide before Stop (an icon button named by its label): a button
    // with its name, drawn as a button (a fill or a border) or as text. Waited for up to 3 s. (On a slide with the
    // Reveal-mode chip the 1440 px bar sheds it, as it sheds the microphone; that is not judged here.)
    await presenter.waitForFunction(() => { const b = document.querySelector('#twrec-again'); return b && b.getBoundingClientRect().width > 0 }, {}, { timeout: 3000 }).catch(() => {})
    const startAgain = await presenter.evaluate(() => {
      const b = document.querySelector('#twrec-again'); if (!b) return null
      const r = b.getBoundingClientRect(), c = getComputedStyle(b)
      const alpha = (col) => { if (!col || col === 'transparent') return 0; const m = col.match(/rgba?\(([^)]+)\)/); if (!m) return 1; const p = m[1].split(/[\s,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1 }
      return { tag: b.tagName, text: (b.getAttribute('aria-label') || b.title || b.textContent).trim(), visible: !b.hidden && c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 && r.height > 0, w: Math.round(r.width), h: Math.round(r.height), buttonLike: alpha(c.backgroundColor) > 0.05 || parseFloat(c.borderTopWidth) > 0 || parseFloat(c.borderBottomWidth) > 0 }
    })
    await presenter.locator('#twrec-stop').click()
    await presenter.waitForFunction(() => document.querySelector('#twrec-module')?.dataset.rec === 'saved', {}, { timeout: 60000 })
    await pause(1500)
    await dumpControls(presenter, 'presenter-saved-controls.txt')
    const savedShot = await shot(presenter, 'saved')
    const savedNote = await presenter.evaluate(() => { const el = document.querySelector('#twrec-saved-text'); if (!el) return null; const lh = parseFloat(getComputedStyle(el).lineHeight) || 16; return { text: el.textContent.trim(), lines: Math.round(el.getBoundingClientRect().height / lh) } })
    // Passes on a one-line note and a drawn button; the tracked fault (a second line, "Start again" drawn as text)
    // is a COULD-NOT only inside could-not-allowed.mjs's bounds; anything else fails.
    const noteData = { savedNote, startAgain }
    const noteClean = savedNoteMeasured(noteData) && savedNote.lines === 1 && startAgain.buttonLike === true
    record('record.saved-note', noteClean ? true : savedNoteKnownFault(noteData) ? null : false, `saved note ${JSON.stringify(savedNote)}; "Start again" while recording ${JSON.stringify(startAgain)}`, savedShot, noteData)
    const r = mainRun()
    const clips = (r?.run.slideTimeIndex || []).filter((m) => m.event === 'clip')
    record('record.clip-once', clips.length === 1, `${clips.length} clip marks: ${JSON.stringify(clips.map((c) => [Math.round(c.tMs), c.slideId, c.clip?.atS]))}; ${played}`)
    const layers = r?.run.capture?.layers || {}
    record('record.run-saved', !!r && ['slides', 'camera'].every((k) => layers[k]?.outcome === 'complete' && layers[k]?.bytes > 0) && r.run.recordingMs > 0, r ? `run ${r.run.id}: recordingMs=${r.run.recordingMs} layers=${Object.keys(r.run.capture?.layers || {}).join(',')} marks=${r.run.slideTimeIndex?.length}` : `files: ${existsSync(runsDir) ? readdirSync(runsDir).join(',') : 'none'}`, savedShot)
    // The words the test-mode transcription writes: its fixed fixture, complete and well formed. Missing or
    // malformed fails here; nothing later may stand in for it unless this passed.
    const tf = r && join(runsDir, `${r.run.id}.transcript.json`)
    let tr = null
    for (let i = 0; i < 120 && tf && !isFixture(tr); i++) { tr = existsSync(tf) ? readJson(tf) : null; if (!isFixture(tr)) await pause(500) }
    writeJson(join(out, 'run.json'), r?.run ?? null)
    record('record.transcript-fixture', isFixture(tr), !tf ? 'no Run' : !tr ? 'no transcript file (or unreadable) after 60 s' : `${tr.words?.length ?? 0} words: "${(tr.words || []).map((w) => w.text).join(' ').slice(0, 160)}"${isFixture(tr) ? '' : ` — expected "${FIXTURE_WORDS}"`}`)
    if (tr) writeJson(join(out, 'transcript.json'), tr)
    // The Run appears: in the main window (Talk's runs) and in the Tools window's Runs view.
    await presenter.close().catch(() => {})
    await pause(1500)
    const body = await main.locator('body').innerText()
    const known2 = new Set(app.windows())
    await main.locator('.workspace-view-titlebar').getByRole('button', { name: 'Tools', exact: true }).click()
    const sessions = main.getByRole('menuitem', { name: /^Sessions with an audience\b/ })
    await sessions.waitFor()
    await dumpControls(main, 'tools-menu.txt')
    await shot(main, 'tools-menu')
    await sessions.click()
    const toolsWin = await newWindow(known2, 30000)
    if (toolsWin) {
      await size(toolsWin)
      const runs = toolsWin.locator('[data-tools-view="runs"]')
      const found = !!r && await runs.locator(`[data-sessions-row="${SLUG}/${r.run.id}"]`)
        .waitFor({ timeout: 10000 }).then(() => true, () => false)
      const count = await runs.locator('[data-runs-count]').innerText({ timeout: 1000 }).catch(() => '?')
      record('record.runs-view', found && count === '1', `Runs shows ${count}; talk row visible: ${found}`, await shot(toolsWin, 'runs-view'))
      await dumpControls(toolsWin, 'runs-view-controls.txt')
    } else record('record.runs-view', false, 'no Tools window opened')
    record('record.delivered-today', /Delivered today/.test(body), body.match(/[^\n]*Delivered today[^\n]*/)?.[0] ?? 'no "Delivered today"')
  })

  // ── 5. Edit the recording ───────────────────────────────────────────────────────────────────────
  if (PHASE === 'edit') await step('5 edit', async () => {
    const r = mainRun(); if (!r) throw new Error('no Run: run the record phase first')
    const id = r.run.id
    const tf = join(runsDir, `${id}.transcript.json`)
    const tr = existsSync(tf) ? readJson(tf) : null
    const D = r.run.recordingMs
    // The test-mode transcriber (TW_REC_TEST) writes a fixed fixture, not words recognised from the fake audio;
    // the record stage checked it. Only that exact fixture may be replaced by a richer stand-in over the real
    // recording's clock (phrases, sentences, precise timing). Anything else is not repaired: the stage fails.
    const fixture = isFixture(tr)
    record('edit.transcript-is-fixture', fixture, fixture ? `the test-mode fixture (${tr.words.length} words); a stand-in over the recording's ${D} ms clock replaces it` : `transcript ${tr ? `is not the fixture: "${(tr.words || []).map((w) => w.text).join(' ').slice(0, 120)}"` : 'missing or unreadable'}; nothing written`)
    if (!fixture) throw new Error('the Run has no test-mode transcript to build on')
    writeFileSync(tf, JSON.stringify(standInTranscript(D, r.run.slideTimeIndex || [], JOIN_SLIDE)))
    // Everything the editor can change, before the first edit (the Run panel's trims are edits too): the sidecar
    // if there is one, else the app's own empty edits (an unedited Run). Undo all must come back to exactly this.
    const EDITABLE = ['cuts', 'boundaries', 'leftOut', 'restoredTrims', 'finish', 'faces', 'takes']
    const editable = (x) => Object.fromEntries(EDITABLE.map((k) => [k, x?.[k]]))
    const baseline = editable(existsSync(editsFileOf(id)) ? sidecar(id) : emptyEdits())
    // Rows by identity: row k is the Run's k-th slide visit (its slide id and its change, the key edits use).
    const visits = slideVisits(r.run.slideTimeIndex || [])
    const rowAt = async (k) => ({ row: k, slide: await tools.locator(`[data-recording-editor] [data-row="${k}"]`).first().getAttribute('data-slide').catch(() => null), visit: visits[k]?.slideId ?? null, change: visits[k]?.change ?? null })
    const others = (list, change) => (list || []).filter((x) => x.change !== change)
    // The gap a slide start snaps to before word w, on the editor's own word times (src/shared/recording-editor.ts).
    const gapBefore = (w) => { const ws = editorWords(readJson(tf), D).words; return { lo: Math.round((ws[w - 1]?.end ?? 0) - 1), hi: Math.round((ws[w]?.start ?? D) + 1) } }
    let tools = await openStudio(id)
    const ready0 = await pictureReady(tools)
    await dumpControls(tools, 'run-panel-controls.txt')
    record('edit.run-opens', ready0.ready, JSON.stringify(ready0).slice(0, 300), await shot(tools, 'run-panel'), ready0)
    // Where the recording is (0.45): judged by its files, so on the Mac that recorded it the card says "on this Mac".
    const place = await tools.evaluate((sid) => { const el = document.querySelector(`.tws-scard[data-sid="${sid}"] .tws-sc-up`); return el ? { text: el.textContent.trim(), state: el.getAttribute('data-media-place') } : null }, id)
    const recordedOn = readJson(join(runsDir, `${id}.json`))?.recordedOn ?? null
    record('edit.studio-place', place?.text === 'on this Mac' && place?.state === 'here' && typeof recordedOn?.computer === 'string' && recordedOn.computer.length > 0,
      `card label ${JSON.stringify(place)}; the Run's recordedOn ${JSON.stringify(recordedOn)}`, await shot(tools, 'studio-place'))
    // Play in the Run panel.
    const playBtn = tools.getByRole('button', { name: 'Play', exact: true }).first()
    await playBtn.click(); await pause(2000)
    const ms1 = await tools.evaluate(() => Number(document.querySelector('.twrp-player')?.dataset.runMs || -1))
    await tools.getByRole('button', { name: 'Pause', exact: true }).first().click().catch(() => {})
    record('edit.play', ms1 > 300, `playhead at ${ms1} ms after 2 s`, await shot(tools, 'played'))
    // Trim start and end here (in the Run panel): read the start and end it shows.
    const ends = async () => tools.evaluate(() => [...document.querySelectorAll('.twrp-trim-side b')].map((b) => b.textContent.trim()))
    const e0 = await ends()
    await tools.getByRole('button', { name: 'Trim start here', exact: true }).click(); await pause(800)
    const e1 = await ends()
    record('edit.trim-start', e1[0] !== e0[0] && await tools.getByText('Use the whole recording').count() > 0, `start ${e0[0]} → ${e1[0]} (playhead ${ms1} ms); end ${e1[1]}`, await shot(tools, 'trim-start'))
    // Seek near the end by clicking the strip under the picture, then Trim end here.
    // The strip with the slide numbers sits just under the picture, as wide as it.
    const strip = await tools.evaluate(() => { const f = document.querySelector('.twrp-frame'); const t = document.querySelector('.twrp-trim-side'); if (!f || !t) return null; const r = f.getBoundingClientRect(), tr = t.getBoundingClientRect(); return { x: r.x + r.width * 0.96, y: (r.bottom + tr.top) / 2 } })
    if (strip) { await tools.mouse.click(strip.x, strip.y); await pause(800) }
    const at = await tools.evaluate(() => Number(document.querySelector('.twrp-player')?.dataset.runMs || -1))
    await tools.getByRole('button', { name: 'Trim end here', exact: true }).click(); await pause(800)
    const e2 = await ends()
    record('edit.trim-end', e2[1] !== e1[1], `end ${e1[1]} → ${e2[1]} (playhead ${at} ms after clicking the strip at ${JSON.stringify(strip)})`, await shot(tools, 'trim-end'))
    // The editor.
    await tools.locator('[data-edit-video]').click()
    await tools.waitForSelector('[data-recording-editor] [data-row]', { timeout: 30000 })
    const ready1 = await pictureReady(tools)
    const nWords = await tools.locator('[data-w]').count(), nRows = await tools.locator('[data-recording-editor] [data-row]').count()
    const standInWords = readJson(tf)?.words?.length ?? -1
    await dumpControls(tools, 'editor-controls.txt')
    record('edit.editor-opens', ready1.ready && nRows >= 6 && nWords === standInWords, `${nRows} slide rows, ${nWords} words shown of ${standInWords} in the transcript, length ${await tools.locator('.tre-len').innerText()}; pictures ${JSON.stringify(ready1).slice(0, 200)}`, await shot(tools, 'editor'), { ready: ready1.ready, nRows, nWords, standInWords })
    const rowFirst = async (k) => Number(await tools.locator(`[data-row="${k}"] [data-w]:not(.tre-cut)`).first().getAttribute('data-w'))
    // Rows with words (a slide with none, or one the trim took, has nothing to select).
    const R = await tools.evaluate(() => [...document.querySelectorAll('[data-recording-editor] [data-row]')].filter((r) => r.querySelectorAll('[data-w]:not(.tre-cut)').length >= 4).map((r) => Number(r.dataset.row)))
    if (R.length < 3) throw new Error('fewer than three slides with words: ' + JSON.stringify(R))
    // Cut a selection.
    const a = (await rowFirst(R[0])) + 1
    await dragWords(tools, a, a + 2); await tools.waitForSelector('.tre-pop', { timeout: 5000 })
    await tools.keyboard.press('Backspace')
    let e = await savedEdits(tools, id)
    // The cut covers the three words: from the first one's start to the third one's end (the transcript's times).
    const tw = readJson(tf).words
    const mid = (w) => (w ? ((w.alignment?.start ?? w.start) + (w.alignment?.end ?? w.end)) / 2 : null)
    const cutsAfter = e.cuts.filter((c) => c.start <= mid(tw[a]) && c.end >= mid(tw[a + 2]) && (a === 0 || c.start > mid(tw[a - 1])) && (!tw[a + 3] || c.end < mid(tw[a + 3])))
    const struck = await tools.locator(`[data-w="${a}"].tre-cut, [data-w="${a + 1}"].tre-cut, [data-w="${a + 2}"].tre-cut`).count()
    record('edit.cut', cutsAfter.length === 1 && struck === 3, `words ${a}–${a + 2} (${tw[a].start}–${tw[a + 2].end} ms); cuts=${JSON.stringify(e.cuts)}; struck on screen=${struck}`, await shot(tools, 'cut'))
    // Leave a slide out and put it back.
    await tools.locator(`[data-row="${R[2]}"]`).scrollIntoViewIfNeeded(); await tools.locator(`[data-row="${R[2]}"]`).hover()
    await tools.locator(`[data-row="${R[2]}"]`).getByRole('button', { name: 'Leave this slide out' }).click()
    e = await savedEdits(tools, id)
    const loShot = await shot(tools, 'left-out')
    const lo = e.leftOut?.length === 1
    await tools.getByRole('button', { name: 'Put this slide back' }).click()
    e = await savedEdits(tools, id)
    record('edit.leave-out', lo && (e.leftOut || []).length === 0, `after put back leftOut=${JSON.stringify(e.leftOut)}`, loShot)
    // Move a slide's start by dragging its handle to a snap target in the slide before: exactly that slide's
    // start moves, to the gap before the target word; no other slide start changes.
    let moved = false, detail = '', moveData = null
    for (const k of R.slice(1)) {
      try {
        const id0 = await rowAt(k), b0 = (await savedEdits(tools, id)).boundaries || []
        await tools.locator(`[data-row="${k - 1}"]`).scrollIntoViewIfNeeded(); await tools.locator(`[data-row="${k}"] .tre-stitle`).hover()
        await tools.waitForFunction((k) => getComputedStyle(document.querySelector(`[data-row="${k}"] .tre-marker`)).opacity === '1', k, { timeout: 3000 })
        const h = await centre(tools, `[data-row="${k}"] .tre-handle`)
        await tools.mouse.move(h.x, h.y); await tools.mouse.down(); await tools.waitForSelector('.tre-ghost', { timeout: 3000 })
        const snaps = await tools.evaluate((k) => [...document.querySelectorAll(`[data-row="${k - 1}"] .tre-snap`)].map((s) => Number(s.dataset.snap)), k)
        const target = snaps.at(-1)
        if (target == null) { await tools.mouse.up(); detail += `row ${k}: no snap target; `; continue }
        const t = await centre(tools, `[data-w="${target}"]`)
        await tools.mouse.move(t.x, t.y, { steps: 8 }); await pause(200)
        await tools.mouse.up()
        e = await savedEdits(tools, id)
        const mine = (e.boundaries || []).filter((b) => b.change === id0.change), gap = gapBefore(target)
        moveData = { row: id0, target, gap, before: b0, after: e.boundaries }
        moved = id0.slide === id0.visit && id0.change !== null && mine.length === 1 && mine[0].at >= gap.lo && mine[0].at <= gap.hi && same(others(e.boundaries, id0.change), others(b0, id0.change))
        detail += `row ${k} (slide ${id0.slide}, visit ${id0.visit}, change ${id0.change}): target word ${target}, gap ${gap.lo}–${gap.hi} ms; boundaries ${JSON.stringify(b0)} → ${JSON.stringify(e.boundaries)}`
        if ((e.boundaries || []).length !== b0.length || mine.length) break
      } catch (err) { detail += `row ${k}: ${String(err).slice(0, 120)}; `; await tools.mouse.up().catch(() => {}) }
    }
    record('edit.move-start', moved, detail, await shot(tools, 'moved-start'), moveData)
    // Start at the sentence. Which rows offer it is decided from the transcript and the Run's slide marks with the
    // editor's own row rule (slideRows: no clear pause within two seconds, a stored sentence start near the change
    // that is not already the slide's first word), not from the screen; the screen must then agree.
    {
      const bnow = (await savedEdits(tools, id)).boundaries || []
      const transcript = readJson(tf)
      const model = slideRows(editorWords(transcript, D), r.run.slideTimeIndex || [], bnow)
      const eligible = model.filter((x) => x.noClearPause && x.sentenceNear !== null && x.sentenceNear !== x.firstWord)
      const ui = await tools.evaluate(() => ({
        rows: [...document.querySelectorAll('[data-recording-editor] [data-row]')].map((el) => el.dataset.slide ?? null),
        buttons: [...document.querySelectorAll('[data-start-at-sentence]')].map((b) => Number(b.closest('[data-row]')?.dataset.row)),
        elsewhere: [...document.querySelectorAll('.tre-inrow:not([data-take-missing])')].filter((n) => /A sentence starts at/.test(n.textContent)).length,
      }))
      const rows = model.map((x) => ({ index: x.index, slideId: x.slideId, change: x.change, noClearPause: x.noClearPause, sentenceNear: x.sentenceNear, firstWord: x.firstWord }))
      if (eligible.length || ui.buttons.length) {
        const want = eligible.map((x) => x.index)
        let ok = same([...ui.buttons].sort((a, b) => a - b), want), after = null, gap = null
        const row = eligible[0]
        if (ok && row) {
          const btn = tools.locator(`[data-recording-editor] [data-row="${row.index}"] [data-start-at-sentence]`).first()
          await btn.scrollIntoViewIfNeeded(); await btn.click(); e = await savedEdits(tools, id)
          after = e.boundaries || []; gap = gapBefore(row.sentenceNear)
          const mine = after.filter((b) => b.change === row.change)
          ok = mine.length === 1 && mine[0].at >= gap.lo && mine[0].at <= gap.hi && same(others(after, row.change), others(bnow, row.change))
        }
        record('edit.start-at-sentence', ok, `offered on rows ${JSON.stringify(ui.buttons)}, expected ${JSON.stringify(want)} (from the transcript); row ${row?.index} (change ${row?.change}) to the gap before word ${row?.sentenceNear} ${JSON.stringify(gap)}: boundaries ${JSON.stringify(bnow)} → ${JSON.stringify(after)}`, await shot(tools, 'sentence-start'), { rows, eligible: want, buttons: ui.buttons })
      } else {
        // Nothing to offer: no row qualifies by the transcript and the marks, and the screen shows no button and
        // no "A sentence starts at" note. Allowed as COULD-NOT only with that evidence (could-not-allowed.mjs).
        const data = { buttons: 0, rows, uiRows: ui.rows.length, uiSlides: ui.rows, eligible: [], uiSentenceElsewhere: ui.elsewhere, sentences: Array.isArray(transcript?.sentences) ? transcript.sentences.length : 0 }
        record('edit.start-at-sentence', sentenceNotReached(data) ? null : false, `no row qualifies by the transcript and the slide marks (${rows.filter((x) => x.noClearPause).map((x) => `row ${x.index}: no clear pause, sentence ${x.sentenceNear === null ? 'none near' : x.sentenceNear === x.firstWord ? 'already its start' : x.sentenceNear}`).join('; ') || 'every change has a clear pause'}); on screen ${ui.rows.length} rows, ${ui.elsewhere} "A sentence starts at" notes, no button`, await shot(tools, 'no-sentence-button'), data)
      }
    }
    // Face position: one slide, a run of slides, the whole video.
    const faceFor = async (k) => { await tools.locator(`[data-row="${k}"]`).scrollIntoViewIfNeeded(); await tools.locator(`[data-row="${k}"] .tre-stitle`).hover(); await tools.locator(`[data-row="${k}"] [data-face-control]`).click(); const sheet = tools.getByRole('dialog', { name: /where your face appears/ }); await sheet.waitFor(); return sheet }
    // One slide: exactly that slide's entry, side by side (corner and size as they were); nothing else changes.
    const f0 = (await savedEdits(tools, id)).faces, one = await rowAt(R[0])
    let sheet = await faceFor(R[0])
    await sheet.getByRole('radio', { name: 'Side by side' }).click(); e = await savedEdits(tools, id)
    const f1 = e.faces
    const fShot = await shot(tools, 'face-one-slide')
    await sheet.getByRole('button', { name: 'Done' }).click(); await sheet.waitFor({ state: 'detached' })
    const oneEntry = (f1?.slides || []).filter((x) => x.change === one.change)
    record('edit.face-one', one.slide === one.visit && one.change !== null && oneEntry.length === 1 && same(oneEntry[0].face, { ...f0.all, layout: 'side' }) && same(f1.all, f0.all) && same(others(f1.slides, one.change), others(f0.slides, one.change)), `row ${R[0]} (slide ${one.slide}, change ${one.change}): ${JSON.stringify(f0)} → ${JSON.stringify(f1)}`, fShot, { row: one, before: f0, after: f1 })
    // A run of slides: the three slides from row R[1] on, corner and large; the one-slide choice and the whole
    // video's stay as they were; no other slide gets an entry.
    const range = await Promise.all([R[1], R[1] + 1, R[1] + 2].map((k) => rowAt(k)))
    sheet = await faceFor(R[1])
    await sheet.getByRole('radio', { name: 'In the corner' }).click(); await savedEdits(tools, id)
    await sheet.getByRole('radio', { name: 'Large' }).click(); await savedEdits(tools, id)
    await sheet.getByRole('radio', { name: /^Slides \d+ to/ }).click(); await savedEdits(tools, id)
    await sheet.getByLabel('Last slide').selectOption({ index: 1 }); e = await savedEdits(tools, id)
    const rangeShot = await shot(tools, 'face-range')
    const f2 = e.faces, rangeChanges = range.map((x) => x.change)
    const rangeOk = range.every((x) => x.slide === x.visit && x.change !== null) && (e.leftOut || []).length === 0
      && rangeChanges.every((c) => { const m = (f2?.slides || []).filter((x) => x.change === c); return m.length === 1 && same(m[0].face, { ...f1.all, layout: 'corner', size: 'large' }) })
      && same(f2.all, f1.all) && same((f2.slides || []).filter((x) => !rangeChanges.includes(x.change)), (f1.slides || []).filter((x) => !rangeChanges.includes(x.change)))
    record('edit.face-range', rangeOk, `rows ${R[1]}–${R[1] + 2} (slides ${range.map((x) => x.slide).join(', ')}; changes ${rangeChanges.join(', ')}): ${JSON.stringify(f1)} → ${JSON.stringify(f2)}`, rangeShot, { rows: range, before: f1, after: f2 })
    // Close this sheet with a click outside.
    await tools.mouse.click(8, 450); await pause(500)
    const closedOutside = await tools.getByRole('dialog', { name: /where your face appears/ }).count() === 0
    record('edit.sheet-click-outside', closedOutside, '', await shot(tools, 'face-click-outside'))
    if (!closedOutside) await tools.keyboard.press('Escape')
    // The whole video: corner and large (the default is corner, medium, so "large" shows the choice landed),
    // and the per-slide choices made above give way to it.
    const allBefore = JSON.stringify(e.faces?.all)
    sheet = await faceFor(0)
    await sheet.getByRole('radio', { name: 'The whole video' }).click(); await savedEdits(tools, id)
    await sheet.getByRole('radio', { name: 'In the corner' }).click(); await savedEdits(tools, id)
    await sheet.getByRole('radio', { name: 'Large' }).click(); e = await savedEdits(tools, id)
    record('edit.face-whole', e.faces?.all?.layout === 'corner' && e.faces?.all?.size === 'large' && (e.faces?.slides || []).length === 0, `before ${allBefore}; after ${JSON.stringify(e.faces)}`, await shot(tools, 'face-whole'))
    await tools.keyboard.press('Escape'); await pause(400)
    const openDialogs = async () => tools.evaluate(() => [...document.querySelectorAll('dialog[open], [role=dialog]')].filter((d) => d.getBoundingClientRect().width > 0 && !d.classList.contains('twstudio')).map((d) => d.getAttribute('aria-labelledby') ? document.getElementById(d.getAttribute('aria-labelledby'))?.textContent : d.className))
    const afterEsc = await openDialogs()
    record('edit.sheet-escape', afterEsc.length === 0, `open after Escape: ${JSON.stringify(afterEsc)}`, await shot(tools, 'after-escape'))
    if (afterEsc.length) { await tools.getByRole('button', { name: 'Done' }).first().click().catch(() => {}); await pause(400) }
    // Look and sound: even volume and smooth joins off, then on.
    await tools.locator('.tre-bar').getByRole('button', { name: 'Look and sound…' }).click()
    const ls = tools.getByRole('dialog', { name: 'Look and sound' }); await ls.waitFor()
    const even = ls.getByRole('checkbox', { name: 'Even out the volume' }), smooth = ls.getByRole('checkbox', { name: /Smooth each join/ })
    const d0 = [await even.isChecked(), await smooth.isChecked()]
    await even.uncheck(); await savedEdits(tools, id); await smooth.uncheck(); e = await savedEdits(tools, id)
    const off = JSON.stringify(e.finish)
    const lsShot = await shot(tools, 'look-sound-off')
    await even.check(); await savedEdits(tools, id); await smooth.check(); e = await savedEdits(tools, id)
    const offState = JSON.parse(off || '{}')
    record('edit.look-sound', d0.every(Boolean) && offState?.evenVolume === false && offState?.smoothJoins === false && e.finish?.evenVolume === true && e.finish?.smoothJoins === true, `default=${d0} off=${off} on=${JSON.stringify(e.finish)}`, lsShot)
    await ls.getByRole('button', { name: 'Done' }).click(); await pause(500)
    const afterDone = await openDialogs()
    record('edit.sheet-done', afterDone.length === 0, `open after Done: ${JSON.stringify(afterDone)}`, await shot(tools, 'after-done'))
    // Undo all, redo all.
    const full = sidecar(id), steps = full.undo.length
    await tools.locator('.tre-what').click().catch(() => {})
    for (let i = 0; i < steps; i++) { await tools.keyboard.press('Meta+z'); await pause(60) }
    // Waited for, then judged by the screen and the file below (a timeout here is not a pass).
    await tools.waitForFunction(() => document.querySelector('.tre-bar button[aria-label="Undo"], button[aria-label="Undo"]')?.disabled === true, {}, { timeout: 10000 }).catch(() => {})
    await pause(800); e = await savedEdits(tools, id)
    // Judged by the screen: the full length, nothing struck or moved, Undo greyed out.
    const screenAfterUndo = { len: await tools.locator('.tre-len').innerText(), cut: await tools.locator('.tre-cut, .tre-cutchip').count(), moved: await tools.locator('.tre-moved').count(), undoOff: await tools.locator('button[aria-label="Undo"]').first().isDisabled() }
    // Judged by the file too: every editable field back to the baseline taken before the first edit.
    const afterUndo = editable(e)
    const differs = EDITABLE.filter((k) => !same(afterUndo[k], baseline[k]))
    const allUndone = screenAfterUndo.cut === 0 && screenAfterUndo.moved === 0 && screenAfterUndo.undoOff && differs.length === 0
    const undoShot = await shot(tools, 'undone-all')
    for (let i = 0; i < steps; i++) { await tools.keyboard.press('Meta+Shift+z'); await pause(60) }
    await tools.waitForFunction(() => document.querySelector('button[aria-label="Redo"]')?.disabled === true, {}, { timeout: 10000 }).catch(() => {})
    await pause(800); e = await savedEdits(tools, id)
    const redone = same(editable(e), editable(full))
    record('edit.undo-redo', steps > 0 && allUndone && redone, `${steps} steps; after undo: screen ${JSON.stringify(screenAfterUndo)}; fields not back to the baseline: ${differs.map((k) => `${k} ${JSON.stringify(afterUndo[k])} ≠ ${JSON.stringify(baseline[k])}`).join('; ') || 'none'}; redo restores every field=${redone}`, undoShot, { baseline, afterUndo, differs })
    // The editor's revision is on disk before the app closes (savedEdits waits for the file to match it).
    const atClose = await savedEdits(tools, id).then((x) => x, () => null)
    writeJson(join(out, 'edits-at-close.json'), sidecar(id))
    writeJson(join(out, 'shown-at-close.json'), { len: await tools.locator('.tre-len').innerText(), editedMs: await editedMs(tools), cut: await tools.locator('.tre-cut').count(), moved: await tools.locator('.tre-moved').count(), faces: (await tools.locator('[data-face-control]').allInnerTexts()).map((x) => x.trim()) })
    record('edit.saved-before-close', !!atClose && JSON.stringify([atClose.cuts, atClose.boundaries, atClose.faces, atClose.finish]) === JSON.stringify([full.cuts, full.boundaries, full.faces, full.finish]), atClose ? `revision ${atClose.revision} on disk` : 'the editor\'s revision never reached the file', await shot(tools, 'before-close'))
  })
  // ── 5. After a restart: the edits are as left ──────────────────────────────────────────────────
  if (PHASE === 'reopen') await step('5 edit', async () => {
    const r = mainRun(); const id = r.run.id
    const was = JSON.parse(readFileSync(join(OUT_ROOT_B, 'edit', 'shown-at-close.json'), 'utf8'))
    const wasEdits = JSON.parse(readFileSync(join(OUT_ROOT_B, 'edit', 'edits-at-close.json'), 'utf8'))
    const tools = await openStudio(id)
    await tools.locator('[data-edit-video]').click(); await tools.waitForSelector('[data-recording-editor] [data-row]', { timeout: 30000 })
    await pause(1500)
    const now = { len: await tools.locator('.tre-len').innerText(), editedMs: await editedMs(tools), cut: await tools.locator('.tre-cut').count(), moved: await tools.locator('.tre-moved').count(), faces: (await tools.locator('[data-face-control]').allInnerTexts()).map((x) => x.trim()) }
    const e = sidecar(id)
    const same = JSON.stringify(now) === JSON.stringify(was) && JSON.stringify([e.cuts, e.boundaries, e.faces, e.finish]) === JSON.stringify([wasEdits.cuts, wasEdits.boundaries, wasEdits.faces, wasEdits.finish])
    record('reopen.edits-kept', same && was.cut > 0, `before=${JSON.stringify(was).slice(0, 300)} after=${JSON.stringify(now).slice(0, 300)}; undo kept=${await tools.getByRole('button', { name: 'Undo' }).isEnabled().catch(() => 'n/a')}`, await shot(tools, 'reopened'))
  })

  // ── 6. Export ──────────────────────────────────────────────────────────────────────────────────
  // The save dialog is macOS's own (not drivable): dialog.showSaveDialog is answered in the main process
  // with a file in the evidence folder, as the repo's editor e2e does. Everything else is the app's UI.
  if (PHASE === 'export') await step('6 export', async () => {
    const r = mainRun(); const id = r.run.id
    const tools = await openStudio(id)
    await tools.locator('[data-edit-video]').click(); await tools.waitForSelector('[data-recording-editor] [data-row]', { timeout: 30000 })
    const ready = await pictureReady(tools)
    record('export.editor-ready', ready.ready, JSON.stringify(ready).slice(0, 300), '', ready)
    const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,duration,width,height', '-show_chapters', '-of', 'json', f], { encoding: 'utf8' }))
    const exportOnce = async (name) => {
      const file = join(out, name + '.mp4')
      await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, file)
      const shown = await editedMs(tools)
      await tools.locator('.tre-bar').getByRole('button', { name: /^Export…$/ }).click()
      await tools.waitForSelector('.twrp-sheet')
      const sheetText = await tools.locator('.twrp-sheet').innerText()
      const sheetShot = await shot(tools, name + '-sheet')
      await tools.locator('.twrp-sheet').getByRole('button', { name: 'Export…' }).click()
      const t0 = Date.now()
      await tools.getByText(new RegExp(`Saved: ${name}\\.mp4`)).waitFor({ timeout: 420000 })
      const tookS = ((Date.now() - t0) / 1000).toFixed(0)
      const doneShot = await shot(tools, name + '-done')
      await tools.getByRole('button', { name: 'Done' }).click().catch(() => {})
      const p = probe(file)
      const v = p.streams.find((x) => x.codec_type === 'video'), a = p.streams.find((x) => x.codec_type === 'audio')
      const videoMs = Math.round(Number(v?.duration) * 1000), formatMs = Math.round(Number(p.format.duration) * 1000)
      const dec = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', timeout: 300000 })
      const extras = readdirSync(out).filter((f) => f.startsWith(name + '.') && !f.endsWith('.mp4'))
      return { file, shown, videoMs, formatMs, v, a, chapters: p.chapters?.length ?? 0, decodeErr: (dec.stderr || '').trim().slice(0, 400), decodeStatus: dec.status, extras, sheetText, sheetShot, doneShot, tookS }
    }
    const x1 = await exportOnce('export-1')
    writeJson(join(out, 'export-1-probe.json'), x1)
    record('export.saves', existsSync(x1.file) && statSync(x1.file).size > 0, `${x1.tookS} s; sheet: ${x1.sheetText.replace(/\s+/g, ' ').slice(0, 200)}`, x1.doneShot)
    record('export.streams', !!x1.v && !!x1.a, `video=${x1.v?.codec_name} ${x1.v?.width}x${x1.v?.height}; audio=${x1.a?.codec_name}`)
    record('export.length', x1.shown > 0 && Math.abs(x1.videoMs - x1.shown) <= 34, `editor ${x1.shown} ms; video stream ${x1.videoMs} ms; container ${x1.formatMs} ms`)
    record('export.decodes', x1.decodeStatus === 0 && !x1.decodeErr, x1.decodeErr || 'ffmpeg -v error: no errors')
    // What the kept video holds, worked out here from the Run, its edits and the fixture (not from the app's
    // export code): kept spans on the 30 fps frame grid the export cuts on, the slides on screen in them (the Run's
    // slide marks, a moved slide start at its new place), and the words kept.
    const ed = sidecar(id), D = r.run.recordingMs
    if ((ed.leftOut || []).length || (ed.takes || []).length) throw new Error(`export expects no left-out slides or takes here: ${JSON.stringify({ leftOut: ed.leftOut, takes: ed.takes })}`)
    const kept = keptOnFrames(ed.cuts || [], D)
    // Chapters: one per section shown in the kept video, in order (talk.mjs SECTION_OF; cards belong to their slide's section).
    const { chapters: expectedChapters, unknown } = expectedChaptersOf({ visits: slideVisits(r.run.slideTimeIndex || []), boundaries: ed.boundaries || [], kept, sectionOf: SECTION_OF })
    const chapterLines = existsSync(join(out, 'export-1 chapters.txt')) ? readFileSync(join(out, 'export-1 chapters.txt'), 'utf8').trim().split('\n') : []
    const titles = chapterLines.map((l) => l.replace(/^\d+:\d+(:\d+)?\s+/, '').trim())
    const mp4 = (probe(x1.file).chapters || []).map((c) => ({ title: c.tags?.title, at: Math.round(Number(c.start_time) * 1000) }))
    const want = expectedChapters.map((c) => c.title)
    const late = mp4.filter((c, i) => expectedChapters[i] && Math.abs(c.at - expectedChapters[i].at) > 1000)
    record('export.chapters', unknown.length === 0 && want.length > 0 && same(titles, want) && same(mp4.map((c) => c.title), want) && late.length === 0,
      `expected ${JSON.stringify(expectedChapters.map((c) => `${(c.at / 1000).toFixed(1)} ${c.title}`))}; chapter list ${JSON.stringify(titles)}; in the MP4 ${JSON.stringify(mp4.map((c) => `${(c.at / 1000).toFixed(1)} ${c.title}`))}${unknown.length ? `; slides not in the fixture: ${unknown.join(', ')}` : ''}${late.length ? `; more than 1 s from the expected start: ${JSON.stringify(late)}` : ''}`,
      '', { expected: expectedChapters, list: titles, mp4 })
    // Captions: the .srt and the .vtt parse, hold the same timed cues, each non-empty and inside the video, and
    // their words are the kept words in order (a word straddling a cut edge may be in or out).
    const videoEnd = Math.max(x1.videoMs, x1.formatMs) + 1
    const srtFile = join(out, 'export-1.srt'), vttFile = join(out, 'export-1.vtt')
    const srt = existsSync(srtFile) ? parseSrt(readFileSync(srtFile, 'utf8')) : { cues: [], problems: ['no .srt beside the video'] }
    const vtt = existsSync(vttFile) ? parseVtt(readFileSync(vttFile, 'utf8')) : { cues: [], problems: ['no .vtt beside the video'] }
    const capProblems = [...srt.problems.map((p) => `srt: ${p}`), ...vtt.problems.map((p) => `vtt: ${p}`)]
    for (const [name, list] of [['srt', srt.cues], ['vtt', vtt.cues]]) {
      if (!list.length) capProblems.push(`${name}: no cues`)
      list.forEach((c, i) => {
        if (!(c.start >= 0 && c.end > c.start && c.end <= videoEnd)) capProblems.push(`${name} cue ${i + 1}: ${c.start}–${c.end} ms is not inside the ${videoEnd - 1} ms video`)
        if (i && c.start < list[i - 1].end) capProblems.push(`${name} cue ${i + 1} starts before cue ${i} ends`)
        if (!c.text.trim()) capProblems.push(`${name} cue ${i + 1} is empty`)
      })
    }
    if (!same(srt.cues.map((c) => [c.start, c.end, c.text]), vtt.cues.map((c) => [c.start, c.end, c.text]))) capProblems.push('the .srt and the .vtt cues differ')
    const words = editorWords(readJson(join(runsDir, `${id}.transcript.json`)), D).words
    const { problem: wordProblem, stream, kept: nKept } = captionWordsMatch(words, kept, srt.cues)
    if (wordProblem) capProblems.push(wordProblem)
    if (!nKept) capProblems.push('no kept words to look for')
    record('export.captions', capProblems.length === 0, capProblems.length ? capProblems.slice(0, 6).join('; ') : `${srt.cues.length} cues in each file, inside ${videoEnd - 1} ms; ${stream.length} caption words = the ${nKept} kept words${stream.length > nKept ? ` and ${stream.length - nKept} at a cut edge` : ''}`, '', { cues: srt.cues.length, captionWords: stream.length, keptWords: nKept, problems: capProblems.slice(0, 20) })
    // One more edit, then export again.
    const before = await editedMs(tools)
    const R6 = await tools.evaluate(() => [...document.querySelectorAll('[data-recording-editor] [data-row]')].filter((r) => r.querySelectorAll('[data-w]:not(.tre-cut)').length >= 6).map((r) => Number(r.dataset.row)))
    const w = Number(await tools.locator(`[data-row="${R6.at(-1)}"] [data-w]:not(.tre-cut)`).nth(2).getAttribute('data-w'))
    await dragWords(tools, w, w + 3); await tools.waitForSelector('.tre-pop'); await tools.keyboard.press('Backspace'); await savedEdits(tools, id)
    await pause(500)
    const x2 = await exportOnce('export-2')
    writeJson(join(out, 'export-2-probe.json'), x2)
    record('export.second', x2.shown < before && Math.abs(x2.videoMs - x2.shown) <= 34 && x2.decodeStatus === 0 && !x2.decodeErr, `editor before ${before} → ${x2.shown} ms; video ${x2.videoMs} ms; decode ${x2.decodeErr || 'clean'}`, x2.doneShot)
    await tools.close()
  })

  // ── 5y. Two Macs, one edits file (0.45, second Mac) ───────────────────────────────────────────────
  // A second app instance on a second profile ("Second Mac", the same vault, no recordings of its own) saves a
  // change to the edits through its own Tools window while this one has the editor open and idle. This one then
  // saves its own change: it is saved as shown, the second's version is kept as a copy, and the editor says so,
  // naming the other Mac and version. The kept copy is listed, opens read only, and is restored. Nothing waits on
  // timing: the second instance's save has finished (its file read back) before this one saves. At 1000 px.
  if (PHASE === 'second-mac') await step('5y second Mac', async () => {
    const r = mainRun(); const id = r.run.id
    const tools = await openStudio(id)
    await tools.setViewportSize({ width: 1000, height: 760 })
    await tools.locator('[data-edit-video]').click(); await tools.waitForSelector('[data-recording-editor] [data-row]', { timeout: 30000 })
    await pause(1500)
    const copies = () => readdirSync(runsDir).filter((f) => f.startsWith(`${id}.edits.`) && f !== `${id}.edits.json` && !f.startsWith('.'))
    // An ordinary save on this Mac (one change in Look and sound) leaves no copy beside the edits (R1a): the save
    // it replaces is this Mac's previous save, kept in its app data.
    const copiesBefore = copies(), fileBefore = readFileSync(editsFileOf(id), 'utf8')
    await tools.locator('.tre-bar').getByRole('button', { name: 'Look and sound…' }).click()
    const ls0 = tools.getByRole('dialog', { name: 'Look and sound' }); await ls0.waitFor()
    await ls0.getByRole('checkbox', { name: /Smooth each join/ }).click(); await ls0.getByRole('button', { name: 'Done' }).click(); await ls0.waitFor({ state: 'detached' })
    for (let i = 0; i < 40 && readFileSync(editsFileOf(id), 'utf8') === fileBefore; i++) await pause(250)
    const ordinary = await tools.evaluate(async (ref) => { const r = await window.tw.recordingVideo.keptList(ref); return r.ok ? r.kept.map((k) => k.reason) : [r.error] }, { talkSlug: SLUG, runId: id })
    record('second-mac.ordinary-no-copy', readFileSync(editsFileOf(id), 'utf8') !== fileBefore && JSON.stringify(copies()) === JSON.stringify(copiesBefore) && ordinary.includes('previous-save'),
      `file saved ${readFileSync(editsFileOf(id), 'utf8') !== fileBefore}; copies beside the edits before ${copiesBefore.length}, after ${copies().length}; Kept edits rows ${JSON.stringify(ordinary)}`)
    const before = readFileSync(editsFileOf(id), 'utf8')
    const lenBefore = await editedMs(tools)
    // The second Mac: its own profile and name, the same vault; it changes the edits through the app's own bridge.
    const userData2 = join(state, 'userData-second-mac')
    mkdirSync(userData2, { recursive: true })
    writeFileSync(join(userData2, 'config.json'), JSON.stringify({ vaultRoot: vault, recordingDiscardMs: 800, theme: 'light', computerName: 'Second Mac' }))
    const second = await launch(userData2)
    const ms = Math.round(Number(r.run.recordingMs))
    const cutX = { start: Math.round(ms * 0.55), end: Math.round(ms * 0.55) + 900 }
    let saved2 = null
    try {
      await size(second.main); await pause(2000)
      await openTalkByTitle(second.main, TITLE); await pause(1000)
      const known2 = new Set(second.app.windows())
      await second.main.evaluate((rid) => window.tw.tools.open('studio', rid), id)
      let tools2 = null
      for (let i = 0; i < 120 && !tools2; i++) { tools2 = second.app.windows().find((w) => !known2.has(w) && !w.isClosed()) ?? null; if (!tools2) await pause(250) }
      if (!tools2) throw new Error('the second instance opened no Tools window')
      await tools2.waitForLoadState('domcontentloaded'); await pause(1500)
      saved2 = await tools2.evaluate(async ({ ref, cut }) => {
        const o = await window.tw.recordingVideo.open(ref)
        if (!o.ok) return { error: o.error }
        const e = await window.tw.recordingVideo.edit(ref, { kind: 'cut', ranges: [cut] }, o.edits.edits.revision, o.edits.digest)
        return e.ok ? { revision: e.edits.edits.revision, savedBy: e.edits.savedBy } : { error: e.error }
      }, { ref: { talkSlug: SLUG, runId: id }, cut: cutX })
    } finally { await closeApp(second.app) }
    const text2 = readFileSync(editsFileOf(id), 'utf8'), file2 = JSON.parse(text2)
    record('second-mac.second-saves', !saved2?.error && text2 !== before && file2.savedBy?.mac === 'Second Mac' && file2.cuts.some((c) => c.start <= cutX.start && c.end >= cutX.end),
      `second instance: ${JSON.stringify(saved2).slice(0, 300)}; file savedBy ${JSON.stringify(file2.savedBy)}; has its cut ${file2.cuts.some((c) => c.start <= cutX.start && c.end >= cutX.end)}`)

    // This instance, still open on the edits it read before: one change in Look and sound.
    await tools.locator('.tre-bar').getByRole('button', { name: 'Look and sound…' }).click()
    const ls = tools.getByRole('dialog', { name: 'Look and sound' }); await ls.waitFor()
    const smooth = ls.getByRole('checkbox', { name: /Smooth each join/ })
    const want = !(await smooth.isChecked())
    await smooth.click(); await ls.getByRole('button', { name: 'Done' }).click(); await ls.waitFor({ state: 'detached' })
    const mine = await savedEdits(tools, id)
    // The save moves whatever is at the edits file aside (`before-`): here, the second instance's bytes.
    const changedCopy = copies().find((f) => f.startsWith(`${id}.edits.before-`) && readFileSync(join(runsDir, f), 'utf8') === text2)
    record('second-mac.first-saves-own', mine.finish?.smoothJoins === want && mine.savedBy?.mac === 'First Mac' && !mine.cuts.some((c) => c.start <= cutX.start && c.end >= cutX.end),
      `file now: smoothJoins=${mine.finish?.smoothJoins} (wanted ${want}), savedBy ${JSON.stringify(mine.savedBy)}, revision ${mine.revision} (second's ${file2.revision})`)
    record('second-mac.other-kept', !!changedCopy, `copies beside the edits: ${JSON.stringify(copies())}; the second instance's bytes kept as ${changedCopy ?? 'nothing'}`)
    const note = tools.locator('[data-edits-notice="changed"]')
    const noteText = await note.innerText().catch(() => '')
    record('second-mac.notice', /changed elsewhere while you had them open \(Edited on Second Mac with TalkWeaver \d+\.\d+\.\d+/.test(noteText), noteText.replace(/\s+/g, ' ').slice(0, 300), await shot(tools, 'notice-1000'))

    // The bar at 1000 px: one row, the Kept edits button in it, nothing overlapping.
    const bar = await tools.evaluate(() => {
      const b = document.querySelector('.tre-bar'), r = b.getBoundingClientRect()
      const kids = [...b.children].filter((e) => e.getBoundingClientRect().width > 0).map((e) => ({ name: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 20) || e.className, r: e.getBoundingClientRect() }))
      const over = []
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) { const a = kids[i].r, c = kids[j].r; if (a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5) over.push(`${kids[i].name} / ${kids[j].name}`) }
      const out = kids.filter((k) => k.r.right > innerWidth + 0.5 || k.r.left < 0).map((k) => k.name)
      return { height: Math.round(r.height), over, out, kept: !!b.querySelector('[data-kept-edits]'), bars: document.querySelectorAll('.tre > header, .tre-bar').length }
    })
    record('second-mac.header-1000', bar.kept && bar.over.length === 0 && bar.out.length === 0 && bar.height <= 64 && bar.bars === 1, JSON.stringify(bar), await shot(tools, 'bar-1000', { clip: { x: 0, y: 0, width: 1000, height: 120 } }))

    // Kept edits: the copy is listed with when, which Mac and which TalkWeaver.
    await note.getByRole('button', { name: 'Kept edits…' }).click()
    const sheet = tools.getByRole('dialog', { name: 'Kept edits' }); await sheet.waitFor()
    const row = tools.locator(`[data-kept-id="${changedCopy}"]`)
    await row.waitFor({ timeout: 10000 }).catch(() => {})
    const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ')
    const sheetBox = await sheet.boundingBox()
    record('second-mac.kept-listed', /· Second Mac · TalkWeaver \d+\.\d+\.\d+/.test(rowText) && /before a save/.test(rowText) && !!sheetBox && sheetBox.x >= 0 && sheetBox.x + sheetBox.width <= 1000, `${rowText.slice(0, 300)}; sheet ${JSON.stringify(sheetBox)}`, await shot(tools, 'kept-edits-1000'))

    // Open it: shown read only (its cut is in the plan, editing and export are off).
    const beforeOpen = readFileSync(editsFileOf(id), 'utf8')
    await row.getByRole('button', { name: 'Open' }).click(); await sheet.waitFor({ state: 'detached' })
    await tools.waitForSelector('[data-viewing-kept]', { timeout: 10000 })
    await pause(800)
    const lenViewed = await editedMs(tools)
    const undoOff = await tools.getByRole('button', { name: 'Undo' }).isDisabled(), exportOff = await tools.locator('.tre-bar').getByRole('button', { name: /^Export…$/ }).isDisabled()
    const banner = (await tools.locator('[data-viewing-kept]').innerText()).replace(/\s+/g, ' ')
    record('second-mac.opens-read-only', /Showing kept edits from .*Second Mac.*Nothing can be changed here/.test(banner) && undoOff && exportOff && lenViewed < lenBefore - 500 && readFileSync(editsFileOf(id), 'utf8') === beforeOpen,
      `banner "${banner.slice(0, 200)}"; undo off ${undoOff}; export off ${exportOff}; edited length ${lenBefore} before, ${lenViewed} shown (its cut of ${cutX.end - cutX.start} ms)`, await shot(tools, 'viewing-kept-1000'))

    // Restore it: it is the edits now, and the edits it replaced are kept in turn.
    const replaced = readFileSync(editsFileOf(id), 'utf8')
    await tools.locator('[data-restore-viewed]').click()
    await tools.waitForSelector('[data-edits-notice="restored"]', { timeout: 10000 })
    const now = JSON.parse(readFileSync(editsFileOf(id), 'utf8'))
    const keptReplaced = copies().find((f) => f.startsWith(`${id}.edits.kept-`) && readFileSync(join(runsDir, f), 'utf8') === replaced)
    const viewingGone = (await tools.locator('[data-viewing-kept]').count()) === 0
    record('second-mac.restores', now.cuts.some((c) => c.start <= cutX.start && c.end >= cutX.end) && now.finish?.smoothJoins === file2.finish?.smoothJoins && !!keptReplaced && !!changedCopy && copies().includes(changedCopy) && viewingGone,
      `file now has the second's cut ${now.cuts.some((c) => c.start <= cutX.start && c.end >= cutX.end)}, smoothJoins ${now.finish?.smoothJoins}; replaced edits kept as ${keptReplaced ?? 'nothing'}; the restored copy still there ${copies().includes(changedCopy)}`, await shot(tools, 'restored-1000'))
    await tools.close()
  })
  // ── 6. Delete the Run ──────────────────────────────────────────────────────────────────────────
  if (PHASE === 'delete') await step('6 export', async () => {
    const r = mainRun(); const id = r.run.id
    // The Run's recordings: <userData>/recordings/<id>/ (camera and slides) and <id>.webm and segments (voice).
    const recFiles = () => { try { return readdirSync(join(userData, 'recordings')).filter((n) => n === id || n.startsWith(id + '.')) } catch { return [] } }
    const recBefore = recFiles()
    const known = new Set(app.windows())
    await main.evaluate(() => window.tw.tools.open('runs'))
    const tools = await newWindow(known, 30000); await size(tools); await pause(2500)
    await shot(tools, 'runs-before-delete')
    const row = tools.getByText(/river walk/i).first(); await row.click(); await pause(1200)
    const del = tools.getByRole('button', { name: /Delete this Run/ }).first()
    await del.click(); await pause(800)
    const confirmShot = await shot(tools, 'delete-confirm')
    // Asks first: after "Delete this Run" the Run is still on disk until the confirmation is clicked.
    const stillThere = runs().filter((x) => x.run.id === id).length === 1
    const confirm = tools.getByRole('button', { name: /^Delete/ }).last()
    await confirm.click(); await pause(2500)
    const left = runs().filter((x) => x.run.id === id).length
    const recLeft = recFiles()
    const tb = await tools.locator('body').innerText()
    record('delete.removes', stillThere && left === 0 && recBefore.length > 0 && recLeft.length === 0, `kept until confirmed=${stillThere}; run file left=${left}; recordings before ${JSON.stringify(recBefore)}, after ${JSON.stringify(recLeft)}; exported files kept=${existsSync(join(OUT_ROOT_B, 'export', 'export-1.mp4'))}`, confirmShot)
    const flat = tb.replace(/\s+/g, ' ')
    record('delete.none-shown', /Runs 0\b/.test(flat) && /No Runs yet/.test(flat), flat.slice(0, 200), await shot(tools, 'runs-after-delete'))
  })
  // ── 5 (last, separate). Record one slide again ─────────────────────────────────────────────────
  // Bound to the feature's switch (TW_RECORD_AGAIN=1 in a development build, src/shared/recording-takes.ts):
  // off, it must not be offered; on, it must be offered and the takes are walked (absence then fails).
  if (PHASE === 'retake') await step('5x retake', async () => {
    const r = mainRun(); const id = r.run.id
    const tools = await openStudio(id)
    await tools.locator('[data-edit-video]').click(); await tools.waitForSelector('[data-recording-editor] [data-row]', { timeout: 30000 })
    const ready = await pictureReady(tools)
    record('retake.editor-ready', ready.ready, JSON.stringify(ready).slice(0, 300), '', ready)
    const RR = await tools.evaluate(() => [...document.querySelectorAll('[data-recording-editor] [data-row]')].filter((r) => r.querySelectorAll('[data-w]:not(.tre-cut)').length >= 6).map((r) => Number(r.dataset.row)))
    const k = RR.find((x) => RR.includes(x + 1) && RR.includes(x - 1)) ?? RR[1]
    await tools.locator(`[data-row="${k}"]`).scrollIntoViewIfNeeded(); await tools.locator(`[data-row="${k}"] .tre-stitle`).hover()
    const n = (await tools.locator(`[data-row="${k}"] .tre-n`).textContent()).trim()
    const offered = await tools.locator('[data-record-again]').count()
    if (!RECORD_AGAIN) { record('retake.not-offered', offered === 0, `switch off; ${offered} [data-record-again] buttons`, await shot(tools, 'retake-off')); return }
    if (!offered) throw new Error('"Record this slide again" is switched on (TW_RECORD_AGAIN=1) but no row offers it')
    const known = new Set(app.windows())
    await tools.locator(`[data-row="${k}"] [data-record-again]`).click()
    const retake = await newWindow(known, 40000); if (!retake) throw new Error('no presenter for the retake')
    await retake.waitForSelector('#twrec-retake-banner', { timeout: 30000 }); await retake.setViewportSize({ width: 1440, height: 900 })
    const banner = await retake.locator('#twrec-retake-banner').innerText()
    record('retake.banner', /again/i.test(banner), banner.replace(/\s+/g, ' '), await shot(retake, 'retake-ready'))
    // A "Resume from slide N?" prompt left from an earlier presenting session covers Record: answer Start fresh.
    await pause(800)
    const resume = retake.locator('#twResume:not([hidden])')
    if (await resume.count()) {
      const q = await resume.innerText().catch(() => '')
      record('retake.no-resume-prompt', false, `prompt shown: "${q.replace(/\s+/g, ' ').slice(0, 80)}" — it covers Record; Resume would leave slide ${n}`, await shot(retake, 'retake-resume-prompt'))
      await retake.locator('#twResumeNo').click(); await pause(600)
    } else record('retake.no-resume-prompt', true, '')
    const onSlide = await retake.locator('#slideCount, .tw-slide-count').first().innerText().catch(() => '')
    record('retake.on-slide', new RegExp(`\\b${n}\\b`).test(onSlide), `counter "${onSlide.replace(/\s+/g, ' ')}" hash ${await retake.evaluate(() => location.hash)}`, await shot(retake, 'retake-after-fresh'))
    await retake.locator('#twrec-primary').click()
    if (await retake.locator('.twrec-device-check').count()) { await retake.waitForFunction(() => !document.querySelector('[data-continue]')?.disabled, {}, { timeout: 20000 }).catch(() => {}); await retake.locator('[data-continue]').click().catch(() => {}) }
    await retake.waitForFunction(() => document.querySelector('#twrec-module')?.dataset.rec === 'recording', {}, { timeout: 30000 })
    await pause(4000)
    await retake.locator('#twrec-stop').click()
    await retake.waitForFunction(() => document.querySelector('#twrec-module')?.dataset.rec === 'saved', {}, { timeout: 30000 })
    const savedText = await retake.locator('#twrec-saved-text').innerText().catch(() => '')
    const takeSaved = runs().some((x) => x.run.takeOf?.runId === id)
    record('retake.saves', /saved/i.test(savedText) && takeSaved, savedText, await shot(retake, 'retake-saved'))
    await retake.close().catch(() => {})
    await tools.bringToFront(); await tools.evaluate(() => window.dispatchEvent(new Event('focus')))
    const takeRun = runs().find((x) => x.run.takeOf?.runId === id)?.run
    await tools.waitForSelector(`[data-row="${k}"] .tre-takes`, { timeout: 20000 })
    await tools.locator(`[data-row="${k}"] .tre-takes`).scrollIntoViewIfNeeded()
    await shot(tools, 'takes-listed')
    const len0 = await editedMs(tools)
    await tools.locator(`[data-row="${k}"] [data-take="${takeRun.id}"]`).getByRole('button', { name: 'Use this take' }).click()
    let e = await savedEdits(tools, id)
    await tools.waitForSelector(`[data-row="${k}"] .tre-replaced`, { timeout: 10000 }).catch(() => {})
    const len1 = await editedMs(tools)
    record('retake.choose', JSON.stringify(e.takes || []).includes(takeRun.id) && len1 !== len0, `takes=${JSON.stringify(e.takes)}; length ${len0} → ${len1} ms`, await shot(tools, 'take-chosen'))
    // Play across it.
    await tools.locator(`[data-row="${k - 1}"] [data-w]`).last().click()
    const playMs = () => tools.evaluate(() => Number(document.querySelector('.tre-player .twrp-player')?.dataset.runMs || -1))
    const runMs0 = await playMs()
    await tools.locator('.tre-playbtn').click(); await pause(5000)
    const runMs = await playMs()
    await tools.locator('.tre-playbtn').click().catch(() => {})
    record('retake.play-across', runMs0 >= 0 && runMs > runMs0, `playhead ${runMs0} → ${runMs} ms after 5 s from the slide before`, await shot(tools, 'take-played'))
    // Trim after it: a cut in the slide after the take.
    // The first row after the take with words left to cut (the take can shorten the rows that follow).
    const after = await tools.evaluate((k) => [...document.querySelectorAll('[data-recording-editor] [data-row]')].map((r) => ({ k: Number(r.dataset.row), w: [...r.querySelectorAll('[data-w]:not(.tre-cut)')].map((e) => Number(e.dataset.w)) })).find((r) => r.k > k && r.w.length >= 4 && r.w[3] === r.w[1] + 2), k)
    if (!after) throw new Error('no row after the take with three words in a row left to cut')
    const w = after.w[1]
    await dragWords(tools, w, w + 2); await tools.waitForSelector('.tre-pop'); await tools.keyboard.press('Backspace'); e = await savedEdits(tools, id)
    const tw = readJson(join(runsDir, `${id}.transcript.json`))?.words || []
    const wMid = (x) => (x ? ((x.alignment?.start ?? x.start) + (x.alignment?.end ?? x.end)) / 2 : NaN)
    const w2s = wMid(tw[w]), w2e = wMid(tw[w + 2])
    record('retake.cut-after', e.cuts.some((c) => c.start <= w2s && c.end >= w2e), `cuts=${e.cuts.length}`, await shot(tools, 'take-trim-after'))
    // Use the first take again.
    await tools.locator(`[data-row="${k}"]`).scrollIntoViewIfNeeded()
    await tools.locator(`[data-row="${k}"]`).getByRole('button', { name: 'Use the first take' }).first().click()
    e = await savedEdits(tools, id)
    record('retake.first-take', !(e.takes || []).length, `takes=${JSON.stringify(e.takes)}; length ${await editedMs(tools)} ms`, await shot(tools, 'first-take'))
    // Undo and redo across the take choices.
    const steps = e.undo.length
    await tools.keyboard.press('Meta+z')
    const mid = await savedEdits(tools, id)
    await tools.keyboard.press('Meta+Shift+z')
    const back = await savedEdits(tools, id)
    record('retake.undo-redo', JSON.stringify(mid.takes || []).includes(takeRun.id) && !(back.takes || []).length, `after one undo takes=${JSON.stringify(mid.takes)}; after one redo takes=${JSON.stringify(back.takes)} (history ${steps})`)
  })

  // ── 5. Sentence starts: with a transcript whose speech runs through a slide change, the editor places
  // that slide's start at the sentence spoken across it and says so in the row.
  // The slide is found by identity (stand-in.mjs JOIN_SLIDE: its entry in the Run's marks, its row by that
  // visit), and every precondition is checked and named before anything is judged: the Run, the slide's one
  // visit with room on both sides (joinChange), its row on screen, and no moved slide start left over from the
  // edit stage (a moved start replaces the default one, so the note is not shown, by design).
  if (PHASE === 'sentence') await step('5 edit', async () => {
    const r = mainRun(); if (!r) throw new Error('precondition: no Run (run the record stage first)')
    const id = r.run.id, D = r.run.recordingMs, marks = r.run.slideTimeIndex || []
    // Without precise word timing (as before the timing download), a sentence start inside speech is a close
    // join, which the drag label calls "at a sentence start · needs a listen".
    const plain = standInTranscript(D, marks, JOIN_SLIDE)
    plain.words = plain.words.map(({ alignment, ...w }) => w); delete plain.alignment
    writeFileSync(join(runsDir, `${id}.transcript.json`), JSON.stringify(plain))
    const change = Math.max(0, Math.round(joinChange(D, marks, JOIN_SLIDE)))
    const k = slideVisits(marks).findIndex((v) => v.slideId === JOIN_SLIDE && v.change === change)
    if (k < 1) throw new Error(`precondition: no slide visit for ${JOIN_SLIDE} at change ${change} (visits ${JSON.stringify(slideVisits(marks).map((v) => [v.slideId, v.change]))})`)
    const tools = await openStudio(id)
    await tools.locator('[data-edit-video]').click(); await tools.waitForSelector('[data-recording-editor] [data-row]', { timeout: 30000 })
    // Put back every moved slide start, one at a time, each waited for on disk (savedEdits) and on screen.
    const putBack = tools.getByRole('button', { name: 'Put back', exact: true })
    for (let i = 0, n = (sidecar(id).boundaries || []).length + 2; i < n && await putBack.count(); i++) {
      const left = await putBack.count()
      await putBack.first().click(); await savedEdits(tools, id)
      await tools.waitForFunction((left) => [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Put back').length < left, left, { timeout: 10000 })
    }
    const still = { boundaries: sidecar(id).boundaries || [], putBack: await putBack.count(), moved: await tools.locator('.tre-moved').count() }
    if (still.boundaries.length || still.putBack || still.moved) throw new Error(`precondition: moved slide starts not put back: ${JSON.stringify(still)}`)
    const row = tools.locator(`[data-recording-editor] .tre-row[data-row="${k}"]`)
    const shownSlide = await row.getAttribute('data-slide', { timeout: 10000 }).catch(() => null)
    if (shownSlide !== JOIN_SLIDE) throw new Error(`precondition: row ${k} shows slide ${shownSlide}, not ${JOIN_SLIDE}`)
    // What the editor's own row rule says for that row (src/shared/recording-editor.ts), for the evidence.
    const model = slideRows(editorWords(plain, D), marks, [])[k]
    const why = `row ${k} (slide ${JOIN_SLIDE}, change ${change}): the row rule gives no clear pause=${model?.noClearPause}, sentence near word ${model?.sentenceNear}, first word ${model?.firstWord}`
    const note = row.locator('.tre-inrow', { hasText: /sentence start/ }).first()
    const has = await note.waitFor({ timeout: 10000 }).then(() => 1, () => 0)
    if (has) await note.scrollIntoViewIfNeeded()
    const text = has ? await note.innerText() : (await row.locator('.tre-inrow').allInnerTexts()).join(' | ') || 'no note in the row'
    const btn = await tools.locator('[data-start-at-sentence]').count()
    // For the guide: the drag label over a sentence start inside speech ("at a sentence start · needs a listen").
    let dragLabel = ''
    try {
      await tools.locator(`[data-row="${k - 1}"]`).scrollIntoViewIfNeeded(); await tools.locator(`[data-row="${k}"] .tre-stitle`).hover()
      await tools.waitForFunction((k) => getComputedStyle(document.querySelector(`[data-row="${k}"] .tre-marker`)).opacity === '1', k, { timeout: 3000 })
      const h = await centre(tools, `[data-row="${k}"] .tre-handle`)
      await tools.mouse.move(h.x, h.y); await tools.mouse.down(); await tools.waitForSelector('.tre-ghost', { timeout: 3000 })
      await tools.mouse.move(h.x + 30, h.y + 20, { steps: 4 }); await pause(300)
      const snaps = await tools.evaluate(() => [...document.querySelectorAll('.tre-snap[data-snap-kind="sentence"]')].map((e) => Number(e.dataset.snap)))
      for (const w of snaps) {
        const t = await centre(tools, `[data-w="${w}"]`); await tools.mouse.move(t.x - 2, t.y, { steps: 8 }); await pause(400)
        dragLabel = await tools.locator('.tre-gsub').innerText().catch(() => '')
        if (/needs a listen/.test(dragLabel)) { const g = await tools.locator('.tre-ghost').boundingBox(); await tools.screenshot({ path: join(OUT_ROOT_B, 'guide', 'drag-sentence-needs-a-listen.png') }); if (g) await tools.screenshot({ path: join(OUT_ROOT_B, 'guide', 'drag-sentence-needs-a-listen-crop.png'), clip: { x: Math.max(0, g.x - 260), y: Math.max(0, g.y - 60), width: Math.min(900, 1440 - Math.max(0, g.x - 260)), height: 180 } }); break }
      }
      await tools.mouse.move(h.x, h.y, { steps: 6 }); await tools.keyboard.press('Escape'); await tools.mouse.up(); await pause(500)
      dragLabel = dragLabel || `no sentence snap target under the drag (targets ${JSON.stringify(snaps)})`
    } catch (e) { dragLabel = 'drag failed: ' + String(e).slice(0, 160); await tools.mouse.up().catch(() => {}) }
    record('sentence.drag-label', /at a sentence start · needs a listen/.test(dragLabel), `row ${k} (slide ${JOIN_SLIDE}): ${dragLabel}`, /needs a listen/.test(dragLabel) ? rel(join(OUT_ROOT_B, 'guide', 'drag-sentence-needs-a-listen.png')) : '')
    record('sentence.row-note', has > 0 && /starts at a sentence start/.test(text), `${text.replace(/\s+/g, ' ')}; ${why}; "Start at the sentence" buttons: ${btn}`, await shot(tools, 'sentence-start'))
  })
} catch (e) {
  harness(String(e?.stack || e).slice(0, 900))
} finally {
  await closeApp(app)
  console.log('STATE', state)
}
