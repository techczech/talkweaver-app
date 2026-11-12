// Slice 3a measurement, not a test tier: a long layered Run (default 30 minutes) in the recording panel:
// time from opening it to the first play, peak memory of the app's processes, and the export time. A short Run is recorded
// with fake devices (so the Run and its capture manifest are the app's own), then its three layer files
// are replaced by ten-minute generated ones. Hidden Electron, throwaway profile. Needs `npm run build`.
//   node e2e/measure-recording-panel-long.mjs [minutes]
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const minutes = Number(process.argv[2] ?? 30), lengthMs = Math.round(minutes * 60_000)
const repo = resolve(import.meta.dirname, '..'), report = join(repo, 'docs/design/2026-11-10-record-and-edit-video/built/slice-3a/long-recording.json')
const root = mkdtempSync(join(repo, '.slice3a-long-')), vault = join(root, 'vault'), userData = join(root, 'userData'), talk = join(vault, 'fixture')
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

  const metrics = async () => app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ type: m.type, kb: m.memory.workingSetSize, peakKb: m.memory.peakWorkingSetSize })))
  let peak = { totalMb: 0, byType: {} }
  const sample = async () => {
    const rows = await metrics()
    const total = rows.reduce((n, r) => n + r.kb, 0) / 1024
    if (total > peak.totalMb) peak = { totalMb: Math.round(total), byType: Object.fromEntries(rows.map((r) => [r.type, Math.round(r.kb / 1024)])) }
  }
  const sampler = setInterval(() => { void sample().catch(() => {}) }, 500)
  const t0 = Date.now()
  const toolsOpened = app.waitForEvent('window')
  await main.evaluate((id) => window.tw.tools.open('studio', id), run.id)
  const tools = await toolsOpened
  await tools.setViewportSize({ width: 1280, height: 800 })
  await tools.waitForSelector('[data-recording-panel]', { timeout: 120000 })
  const panelMs = Date.now() - t0
  await tools.waitForFunction(() => [...document.querySelectorAll('.twrp-frame video')].length === 2 && [...document.querySelectorAll('.twrp-frame video')].every((v) => v.readyState >= 2), {}, { timeout: 900000 })
  const readyMs = Date.now() - t0
  await tools.getByRole('button', { name: 'Play', exact: true }).click()
  await tools.waitForFunction(() => Number(document.querySelector('.twrp-player').dataset.runMs) > 500, {}, { timeout: 60000 })
  const firstPlayMs = Date.now() - t0
  // A seek near the end and play there.
  await tools.getByRole('button', { name: 'Pause', exact: true }).click()
  const box = await tools.getByTestId('recording-scrub').boundingBox()
  const s0 = Date.now()
  await tools.mouse.click(box.x + box.width * 0.95, box.y + 4)
  await tools.waitForFunction(() => [...document.querySelectorAll('.twrp-frame video')].every((v) => !v.seeking && v.readyState >= 2), {}, { timeout: 60000 })
  const lateSeekMs = Date.now() - s0
  // Reopen: the playback copies are reused.
  await tools.close()
  const r0 = Date.now()
  const again = app.waitForEvent('window')
  await main.evaluate((id) => window.tw.tools.open('studio', id), run.id)
  const tools2 = await again
  await tools2.waitForFunction(() => [...document.querySelectorAll('.twrp-frame video')].length === 2 && [...document.querySelectorAll('.twrp-frame video')].every((v) => v.readyState >= 2), {}, { timeout: 300000 })
  const reopenMs = Date.now() - r0
  // Export the whole recording, with captions and sound only.
  const out = join(root, 'out'); mkdirSync(out)
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, join(out, 'long.mp4'))
  await tools2.getByRole('button', { name: 'Export video…' }).click()
  const e0 = Date.now()
  await tools2.getByRole('button', { name: 'Export…' }).click()
  await tools2.getByText(/Saved: long\.mp4/).waitFor({ timeout: 3600000 })
  const exportMs = Date.now() - e0
  clearInterval(sampler); await sample()
  const bytes = statSync(join(out, 'long.mp4')).size
  const result = { measuredAt: new Date().toISOString(), lengthMs, panelMs, readyMs, firstPlayMs, lateSeekMs, reopenMs, exportMs, exportRealTimeFactor: Math.round((lengthMs / exportMs) * 10) / 10, exportBytes: bytes, peakMemory: peak, playbackCopyBytes: readdirSync(join(userData, 'recording-playback', run.id)).flatMap((d) => readdirSync(join(userData, 'recording-playback', run.id, d)).map((f) => statSync(join(userData, 'recording-playback', run.id, d, f)).size)).reduce((a, b) => a + b, 0) }
  writeFileSync(report, JSON.stringify(result, null, 1) + '\n')
  console.log(JSON.stringify(result, null, 1))
} finally {
  await app?.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
