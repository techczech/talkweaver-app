// Release 0.44.5 review item 5: the recording editor's Look and sound and face-position sheets are modal for
// the keyboard. Tab stays inside, the window behind is inert, Escape closes, the layout and size choices are
// radios that move with the arrow keys, and every control shows focus. Playwright's bundled Chromium.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..'), scratch = mkdtempSync(join(tmpdir(), 'tw-recording-sheets-'))
let browser, checks = 0
const test = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name) }
try {
  await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client'
import { LookAndSoundSheet } from './src/renderer/src/components/recording/LookAndSound.tsx'
import { FacePositionSheet } from './src/renderer/src/components/recording/FacePosition.tsx'
import './src/renderer/src/styles.css'
import './src/renderer/src/components/recording/recording-editor.css'
window.calls = []
function App() {
  const [sheet, setSheet] = React.useState(null)
  const [finish, setFinish] = React.useState({ camera: true, evenVolume: true, smoothJoins: true })
  const [faces, setFaces] = React.useState({ all: { layout: 'corner', corner: 'bottom-right', size: 'medium' }, slides: [] })
  window.open = (s) => setSheet(s)
  const rows = [{ index: 0, change: 0, n: 1 }, { index: 1, change: 4000, n: 2 }, { index: 2, change: 8000, n: 3 }]
  return <div className="tre lt">
    <button id="behind">Behind the sheet</button>
    <button id="open-look" onClick={() => setSheet('look')}>Look and sound…</button>
    <button id="open-face" onClick={() => setSheet('face')}>Face: corner</button>
    {sheet === 'look' ? <LookAndSoundSheet finish={finish} hasVoice evening={false} evenError={null} disabled={false} onChange={(f) => { window.calls.push(['finish', f]); setFinish({ ...finish, ...f }) }} onClose={() => { window.calls.push(['close']); setSheet(null) }} /> : null}
    {sheet === 'face' ? <FacePositionSheet row={rows[1]} rows={rows} faces={faces} hasCamera cameraOn disabled={false}
      onApply={(changes, face) => { window.calls.push(['face', changes, face]); setFaces({ all: faces.all, slides: [{ change: 4000, face }] }) }} onClose={() => { window.calls.push(['close']); setSheet(null) }} /> : null}
  </div>
}
createRoot(document.getElementById('root')).render(<App />)`,
      resolveDir: root, loader: 'tsx', sourcefile: 'recording-sheets-dom.tsx'
    },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(scratch, 'test.js'), logLevel: 'error'
  })
  writeFileSync(join(scratch, 'test.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="test.css"><div id="root"></div><script src="test.js"></script>')
  browser = await chromium.launch({ headless: true, executablePath: process.env.TW_CHROMIUM_HEADLESS_SHELL || undefined })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  page.setDefaultTimeout(6000)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(pathToFileURL(join(scratch, 'test.html')).href)
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('dialog[open]'))
  const focused = () => page.evaluate(() => { const a = document.activeElement; return `${a?.tagName}:${a?.getAttribute('type') ?? ''}:${a?.closest('label')?.textContent?.trim() ?? a?.textContent?.trim() ?? ''}` })
  const outlineOf = () => page.evaluate(() => { const a = document.activeElement; const el = a?.closest('.tre-face-tile, .tre-seg-opt') ?? a; return getComputedStyle(el).outlineStyle })

  for (const [name, title, count] of [['look', 'Look and sound', 4], ['face', 'Slide 2: where your face appears', 10]]) {
    await test(`${title}: modal, focus inside, Tab cycles within, the window behind is inert`, async () => {
      await page.evaluate((s) => window.open(s), name)
      const dialog = page.getByRole('dialog', { name: title })
      await dialog.waitFor()
      assert.equal(await dialog.evaluate((d) => d.matches(':modal')), true, 'a modal dialog')
      assert.equal(await inside(), true, 'focus starts inside')
      for (let i = 0; i < count * 2; i++) { await page.keyboard.press('Tab'); assert.equal(await inside(), true, `Tab ${i + 1} stays inside (${await focused()})`) }
      for (let i = 0; i < count; i++) { await page.keyboard.press('Shift+Tab'); assert.equal(await inside(), true, 'Shift+Tab stays inside') }
      await page.mouse.click(5, 5)
      assert.equal(await page.evaluate(() => window.calls.at(-1)?.[0]), 'close', 'a click outside closes it')
      await dialog.waitFor({ state: 'detached' })
      await page.evaluate((s) => window.open(s), name)
      await dialog.waitFor()
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => window.calls.at(-1)?.[0]), 'close', 'Escape closes it')
    })
  }

  await test('face sheet: layouts and sizes are radios that move with the arrow keys and show focus', async () => {
    await page.evaluate(() => { window.calls = []; window.open('face') })
    const dialog = page.getByRole('dialog', { name: 'Slide 2: where your face appears' })
    await dialog.waitFor()
    const corner = dialog.getByRole('radio', { name: 'In the corner' })
    await corner.focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await dialog.getByRole('radio', { name: 'Side by side' }).isChecked(), true, 'Arrow right chooses Side by side')
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['face', [4000], { layout: 'side', corner: 'bottom-right', size: 'medium' }])
    await page.keyboard.press('ArrowLeft')
    assert.equal(await corner.isChecked(), true, 'Arrow left goes back to In the corner')
    assert.equal(await outlineOf(), 'solid', 'the focused layout shows focus')
    const medium = dialog.getByRole('radio', { name: 'Medium' })
    await medium.focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await dialog.getByRole('radio', { name: 'Large' }).isChecked(), true, 'Arrow right chooses Large')
    assert.equal(await outlineOf(), 'solid', 'the focused size shows focus')
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['face', [4000], { layout: 'corner', corner: 'bottom-right', size: 'large' }])
    await dialog.getByRole('button', { name: 'Done' }).click()
    await dialog.waitFor({ state: 'detached' })
  })

  await test('focus goes back to the button that opened the sheet (Escape, Done, a click outside)', async () => {
    for (const [opener, title, close] of [['#open-look', 'Look and sound', 'Escape'], ['#open-face', 'Slide 2: where your face appears', 'Done'], ['#open-look', 'Look and sound', 'outside']]) {
      await page.locator(opener).focus(); await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: title })
      await dialog.waitFor()
      assert.equal(await inside(), true)
      if (close === 'Escape') await page.keyboard.press('Escape')
      else if (close === 'Done') await dialog.getByRole('button', { name: 'Done' }).click()
      else await page.mouse.click(5, 5)
      // The sheet is gone and a frame has been drawn: focus has settled (the click's own focus change included).
      await dialog.waitFor({ state: 'detached' })
      const at = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => { const a = document.activeElement; done(a?.id ? '#' + a.id : a?.tagName ?? 'none') })))
      assert.equal(at, opener, `after ${close}, focus is on ${opener}`)
    }
  })

  await test('a press and its release must both be outside the sheet to close it (mouse and touch)', async () => {
    for (const [name, title] of [['look', 'Look and sound'], ['face', 'Slide 2: where your face appears']]) {
      await page.evaluate((s) => window.open(s), name)
      const dialog = page.getByRole('dialog', { name: title })
      await dialog.waitFor()
      const done = await dialog.getByRole('button', { name: 'Done' }).boundingBox()
      const mid = { x: done.x + done.width / 2, y: done.y + done.height / 2 }
      const closes = () => page.evaluate(() => window.calls.filter((c) => c[0] === 'close').length)
      const before = await closes()
      // Pressed outside, released on a control inside: not a click outside.
      await page.mouse.move(5, 5); await page.mouse.down(); await page.mouse.move(mid.x, mid.y, { steps: 4 }); await page.mouse.up()
      assert.equal(await closes(), before, `${title}: pressed outside, released inside, stays open`)
      assert.equal(await dialog.isVisible(), true)
      // Pressed on a control inside, released outside.
      await page.mouse.move(mid.x, mid.y); await page.mouse.down(); await page.mouse.move(5, 5, { steps: 4 }); await page.mouse.up()
      assert.equal(await closes(), before, `${title}: pressed inside, released outside, stays open`)
      // The same press outside and release inside by touch (the pointer captured where it went down).
      await dialog.evaluate((d, at) => {
        const box = d.getBoundingClientRect()
        const ev = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y })
        d.dispatchEvent(ev('pointerdown', 5, 5)); d.dispatchEvent(ev('pointerup', at.x, at.y))
        d.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }))
        void box
      }, mid)
      assert.equal(await closes(), before, `${title}: a touch pressed outside and lifted inside stays open`)
      // A real click outside still closes it.
      await page.mouse.click(5, 5)
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await closes(), before + 1, `${title}: a click outside closes it`)
    }
  })

  await test('Look and sound: the choices are tick boxes reached by Tab and changed with Space', async () => {
    await page.evaluate(() => { window.calls = []; window.open('look') })
    const dialog = page.getByRole('dialog', { name: 'Look and sound' })
    await dialog.waitFor()
    // Focus starts on the first tick box; Tab reaches the next.
    assert.match(await focused(), /Smooth each join/)
    await page.keyboard.press('Tab')
    assert.match(await focused(), /Even out the volume/)
    await page.keyboard.press('Space')
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['finish', { evenVolume: false }])
    assert.equal(await outlineOf(), 'solid')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
  })

  assert.deepEqual(errors, [])
  console.log(`\n${checks} passed`)
} finally {
  await browser?.close().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
