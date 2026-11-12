// Hidden development-app journey (PR 347 review, item 6): the opening slide's moving content is kept.
// A finite animation runs on the opening slide from the moment the slides surface exists. The slides
// layer must start at the voice's origin (not after the page settles) and record the animation moving.
// Hidden Electron, fake devices, throwaway profile. Needs `npm run build`.
//   node e2e/diagnose-recording-opening.mjs
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const root = mkdtempSync(join(repo, '.slice3a-opening-')), vault = join(root, 'vault'), userData = join(root, 'userData'), talk = join(vault, 'fixture')
mkdirSync(talk, { recursive: true }); mkdirSync(userData, { recursive: true })
const outline = join(talk, 'fixture-outline.md'), content = '---\ntitle: Opening motion\n---\n\n## Talk\n\n### Moving {id=moving}\n\nSomething moves here.\n'
writeFileSync(outline, content)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, recordingDiscardMs: 800 }))
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
let app, count = 0
const pass = (name) => console.log(`PASS ${++count} ${name}`)
try {
  app = await electron.launch({ timeout: 30000, cwd: repo, args: ['.', '--user-data-dir=' + userData, '--use-fake-device-for-media-stream'], env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' } })
  const main = await app.firstWindow(); await main.waitForLoadState('domcontentloaded')
  const opened = app.waitForEvent('window')
  await main.evaluate(({ outline, content }) => window.tw.talk.present(outline, content, 'presenter'), { outline, content })
  const presenter = await opened
  await presenter.waitForSelector('#twrec-primary')
  await presenter.locator('#twrec-capture').selectOption('voice')
  await presenter.keyboard.press('Shift+r')
  await presenter.waitForSelector('.twrec-device-check')
  await presenter.waitForFunction(() => !document.querySelector('[data-continue]').disabled, {}, { timeout: 20000 })
  // The opening slide carries a 6 s animation from the moment its page is ready (as authored content would),
  // added in main as soon as the hidden slides surface reaches dom-ready.
  await app.evaluate(({ app: electronApp }) => {
    globalThis.__twAnimated = 0
    electronApp.on('browser-window-created', (_event, w) => {
      w.webContents.once('dom-ready', () => {
        if (!w.webContents.isOffscreen() || !w.webContents.getURL().includes('audience=1')) return
        void w.webContents.executeJavaScript(`(() => { const el = document.createElement('div'); el.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:400px;z-index:2147483647;background:rgb(255,0,0)'; document.documentElement.append(el); el.animate([{ background: 'rgb(255,0,0)' }, { background: 'rgb(0,0,255)' }], { duration: 6000, fill: 'forwards' }); return true })()`).then(() => { globalThis.__twAnimated++ })
      })
    })
  })
  await presenter.locator('[data-continue]').click()
  await presenter.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'recording', {}, { timeout: 20000 })
  assert.ok(await app.evaluate(() => globalThis.__twAnimated) > 0, 'the animation was started on the slides surface')
  await presenter.waitForTimeout(3000)
  await presenter.locator('#twrec-stop').click()
  await presenter.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved', {}, { timeout: 30000 })
  const runsDir = join(vault, '_PRESENTATIONS', 'fixture')
  const run = readdirSync(runsDir).filter((f) => /^[^.]+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8'))).find((r) => r.capture?.layers?.slides)
  const startMs = run.capture.layers.slides.startMs
  console.log('slides layer starts at', startMs, 'ms on the recording clock')
  assert.ok(startMs < 800, `the slides layer starts with the voice, not after the page settles: ${startMs} ms`)
  pass('the slides surface is ready when the voice starts')
  const file = join(userData, 'recordings', run.id, 'slides.webm')
  const at = (t) => [...spawnSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=200:200:100:100,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 30000 }).stdout]
  const early = at(0.1), later = at(1.5)
  console.log('animated corner at 0.1 s', early, 'at 1.5 s', later)
  assert.ok(early[0] > early[2], 'the first frames already show the animation, still mostly red')
  assert.ok(early.reduce((n, v, i) => n + Math.abs(v - later[i]), 0) > 30, 'the opening slide’s animation is recorded moving')
  pass('the opening slide’s moving content is recorded from the start')
} finally {
  await app?.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
