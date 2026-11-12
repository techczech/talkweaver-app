// Slice 3a measurement, not a test tier: play a ten-minute layered Run in the recording panel at 1×
// and record how far the slides and camera videos drift from the voice clock. A short Run is recorded
// with fake devices (so the Run and its capture manifest are the app's own), then its three layer files
// are replaced by ten-minute generated ones. Hidden Electron, throwaway profile. Needs `npm run build`.
//   node e2e/measure-recording-panel-drift.mjs [minutes]
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const minutes = Number(process.argv[2] ?? 10), lengthMs = Math.round(minutes * 60_000)
const repo = resolve(import.meta.dirname, '..'), report = join(repo, 'docs/design/2026-11-10-record-and-edit-video/built/slice-3a/drift.json')
const root = mkdtempSync(join(repo, '.slice3a-drift-')), vault = join(root, 'vault'), userData = join(root, 'userData'), talk = join(vault, 'fixture')
mkdirSync(talk, { recursive: true }); mkdirSync(userData, { recursive: true })
const outline = join(talk, 'fixture-outline.md'), content = '---\ntitle: Drift\n---\n\n## Talk\n\n### One {id=one}\n\nOne.\n\n### Two {id=two}\n\nTwo.\n'
writeFileSync(outline, content)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, recordingDiscardMs: 800 }))
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const gen = (args) => { const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args], { timeout: 1_800_000 }); assert.equal(r.status, 0, r.stderr?.toString()) }
let app
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
  await presenter.waitForTimeout(3000)
  await presenter.locator('#twrec-stop').click()
  await presenter.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved', {}, { timeout: 30000 })
  const runsDir = join(vault, '_PRESENTATIONS', 'fixture')
  const runFile = readdirSync(runsDir).find((f) => /^[^.]+\.json$/.test(f) && JSON.parse(readFileSync(join(runsDir, f), 'utf8')).capture?.layers?.camera)
  const run = JSON.parse(readFileSync(join(runsDir, runFile), 'utf8'))
  const rec = join(userData, 'recordings', run.id), voice = join(userData, 'recordings', run.audio.segments[0].file)
  const sec = String(lengthMs / 1000)
  console.log(`generating ${minutes}-minute layers…`)
  // Slides: the frame number burnt in large, so a frame can be identified; camera: a moving test card.
  gen(['-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=${sec}`, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '400k', '-f', 'webm', join(rec, 'slides.webm')])
  gen(['-f', 'lavfi', '-i', `testsrc=s=640x480:r=30:d=${sec}`, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '150k', '-f', 'webm', join(rec, 'camera.webm')])
  gen(['-f', 'lavfi', '-i', `sine=frequency=330:duration=${sec}`, '-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', voice])
  for (const f of readdirSync(runsDir)) if (f.startsWith(run.id + '.') && f !== runFile) unlinkSync(join(runsDir, f))
  run.recordingMs = lengthMs; run.wallClockMs = lengthMs
  run.audio.segments = [{ ...run.audio.segments[0], bytes: statSync(voice).size, startMs: 0, endMs: lengthMs }]; run.audio.bytes = statSync(voice).size; run.audio.audioMs = lengthMs; run.audio.gaps = []
  run.capture.durationMs = lengthMs
  for (const layer of ['slides', 'camera']) {
    const meta = run.capture.layers[layer]
    Object.assign(meta, { file: `${layer}.webm`, bytes: statSync(join(rec, `${layer}.webm`)).size, startMs: 0, outcome: 'complete' }); delete meta.segments; delete meta.lostAtMs; delete meta.endMs
  }
  run.slideTimeIndex = [{ event: 'enter', slideId: 'one', tMs: 0 }, { event: 'enter', slideId: 'two', tMs: Math.round(lengthMs / 2) }]
  writeFileSync(join(runsDir, runFile), JSON.stringify(run))

  const toolsOpened = app.waitForEvent('window')
  await main.evaluate((id) => window.tw.tools.open('studio', id), run.id)
  const tools = await toolsOpened
  await tools.setViewportSize({ width: 1280, height: 800 })
  await tools.waitForSelector('[data-recording-panel]', { timeout: 60000 })
  await tools.waitForFunction(() => [...document.querySelectorAll('.twrp-frame video')].every((v) => v.readyState >= 2), {}, { timeout: 300000 })
  await tools.getByRole('button', { name: 'Play', exact: true }).click()
  const samples = []
  const t0 = Date.now()
  while (Date.now() - t0 < lengthMs - 3000) {
    await tools.waitForTimeout(5000)
    const s = await tools.evaluate(() => {
      const p = document.querySelector('.twrp-player'), [slides, camera] = document.querySelectorAll('.twrp-frame video'), audio = document.querySelector('.twrp-player audio')
      return { at: Number(p.dataset.runMs), max: Number(p.dataset.driftMaxMs), mean: Number(p.dataset.driftMeanMs), n: Number(p.dataset.driftSamples),
        // Instantaneous offsets against the voice clock, read in one task.
        slides: Math.round((slides.currentTime - audio.currentTime) * 1000), camera: Math.round((camera.currentTime - audio.currentTime) * 1000) }
    })
    samples.push({ wallMs: Date.now() - t0, ...s })
  }
  const playedMs = samples.at(-1).at
  const instant = samples.flatMap((s) => [Math.abs(s.slides), Math.abs(s.camera)])
  const result = {
    measuredAt: new Date().toISOString(), lengthMs, playedMs, wallMs: Date.now() - t0,
    clockRate: playedMs / (samples.at(-1).wallMs),
    followLoop: { maxMs: samples.at(-1).max, meanMs: samples.at(-1).mean, samples: samples.at(-1).n },
    instantaneous: { maxMs: Math.max(...instant), p95Ms: instant.sort((a, b) => a - b)[Math.floor(instant.length * 0.95)], readings: instant.length },
    targetMs: 40, samples
  }
  writeFileSync(report, JSON.stringify(result, null, 1) + '\n')
  console.log(JSON.stringify({ ...result, samples: undefined }, null, 1))
} finally {
  await app?.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
