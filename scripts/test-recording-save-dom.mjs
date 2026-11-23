import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { makeEditorFixture } from './fixtures/recording-editor-fixture.mjs'

const fixture = makeEditorFixture({ slides: 16, wordsPerSlide: 24, seed: 5 })
const { outputFiles } = await build({
  stdin: {
    contents: `
import { createRoot } from 'react-dom/client'
import { createRef } from 'react'
import { RecordingEditor } from './src/renderer/src/components/recording/RecordingEditor.tsx'
import { RecordingPanel } from './src/renderer/src/components/recording/RecordingPanel.tsx'
import { hasUnsavedRecordingEdits } from './src/renderer/src/components/recording/RecordingSaveNotice.tsx'
import { applyEditOp, emptyEdits } from './src/shared/recording-edits.ts'
const fx = ${JSON.stringify(fixture)}
const duration = fx.durationMs
const run = { id:'run', talkSlug:'fixture', talkTitle:'Fixture', startedAt:'2026-11-01T10:00:00', recordingMs:duration, slideTimeIndex:fx.marks }
const slides = Object.fromEntries(fx.marks.map((m,i) => [m.slideId,{title:m.slideId,n:i+1}]))
let saved = emptyEdits()
let fail = () => false
let release
const calls = []
const snapshot = () => ({ edits:saved, problem:null, digest:String(saved.revision) })
const props = { run, slides, transcript:fx.transcript }
const root = createRoot(document.getElementById('root'))
const panel = createRef()
window.tw = {
  recordingVideo:{
    open:async () => ({ ok:true, durationMs:duration, hasPicture:true, hasCamera:true, slides:[{}], camera:[], missing:[], runTrims:[], edits:snapshot() }),
    prepare:async () => ({ ok:true, voice:null, slides:[], camera:[], unreadable:[] }),
    onExportProgress:() => () => {},
    edit:async (ref,op,revision,digest) => {
      calls.push({kind:op.kind,revision,digest})
      if (fail(op)) return await new Promise(resolve => {
        release = () => resolve({ ok:false, error:'Another TalkWeaver window is saving these edits. Try again in a moment.' })
      })
      if (revision !== saved.revision || digest !== String(saved.revision)) throw Error('Wrong revision')
      saved = applyEditOp(saved,op,duration)
      return { ok:true, edits:snapshot() }
    },
    export:async () => { throw Error('Export reached IPC while an edit was unsaved') },
  },
}
window.fixture = {
  mount(mode) {
    calls.length = 0
    saved = emptyEdits()
    fail = op => mode === 'editor' || op.kind === 'trim-start'
    root.render(mode === 'editor'
      ? <RecordingEditor {...props} writing={{busy:false,note:null,error:null}} parakeetReady={false}
          onWriteOut={() => {}} onStopWriting={() => {}} onBack={() => {}} onHelp={() => {}} onSettings={() => {}} />
      : <RecordingPanel {...props} ref={panel} onTime={() => {}} onPlaying={() => {}} />)
  },
  calls, saved:() => saved,
  canLeave:() => !hasUnsavedRecordingEdits(),
  tryPanelKeys() { panel.current.trimStart(); panel.current.trimEnd(); panel.current.undo(); panel.current.redo() },
  refuse() { const fn = release; release = undefined; fn() },
  allow() { fail = () => false },
  block() { fail = () => true },
  externalEdit() {
    saved = applyEditOp(saved, { kind:'trim-start', at:650 }, duration)
    saved = applyEditOp(saved, { kind:'trim-end', at:duration-650 }, duration)
  },
  waiting:() => !!release,
}
`,
    sourcefile: 'recording-save-fixture.tsx', loader: 'tsx', resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: 'recording-save-fixture.js',
})

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1150, height: 660 } })
  page.setDefaultTimeout(10_000)
  page.on('pageerror', error => console.error(error))
  await page.setContent('<meta charset="utf-8"><style>body{margin:0}#root{display:flex;height:100vh}</style><div id="root"></div>')
  await page.addStyleTag({ content: outputFiles.find(f => f.path.endsWith('.css')).text })
  await page.addScriptTag({ content: outputFiles.find(f => f.path.endsWith('.js')).text })
  await page.evaluate(() => window.fixture.mount('editor'))
  const last = await page.locator('[data-w]').last().getAttribute('data-w')
  const word = page.locator(`[data-w="${Number(last) - 1}"]`)
  await word.click()
  await word.click({ modifiers: ['Shift'] })
  await page.keyboard.press('Backspace')
  await page.waitForFunction(() => window.fixture.waiting())
  assert.equal(await word.evaluate(el => el.classList.contains('tre-cut')), true, 'optimistic cut while the first save is pending')
  await page.evaluate(() => window.fixture.refuse())
  const editorBanner = page.getByRole('alert').filter({ hasText: /unsaved/i })
  await editorBanner.waitFor()
  assert.equal(await page.evaluate(() => window.fixture.calls.length), 1, 'one IPC call waits in main')
  const withinViewport = await editorBanner.evaluate(el => {
    const box = el.getBoundingClientRect()
    return box.top >= 0 && box.bottom <= innerHeight && !el.closest('.tre-list')
      && document.querySelector('.tre-list').scrollTop > 0
  })
  assert.ok(withinViewport, 'the unsaved banner is pinned outside the scrolled transcript')
  assert.equal(await word.evaluate(el => el.classList.contains('tre-cut')), true, 'the refused cut stays visible')
  assert.deepEqual(await page.evaluate(() => window.fixture.saved().cuts), [])
  assert.equal(await page.evaluate(() => window.fixture.canLeave()), false)
  assert.equal(await page.getByRole('button', { name: 'Export…' }).isEnabled(), false)
  await page.evaluate(() => window.fixture.allow())
  await editorBanner.getByRole('button', { name: 'Retry', exact: true }).click()
  await editorBanner.waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => window.fixture.saved().cuts.length), 1)
  assert.equal(await page.evaluate(() => window.fixture.canLeave()), true)
  assert.equal(await page.getByRole('button', { name: 'Export…' }).isEnabled(), true)
  console.log('Editor retains a refused cut; pinned Retry saves it')

  await page.evaluate(() => window.fixture.block())
  const anotherWord = page.locator(`[data-w="${Number(last) - 6}"]`)
  await anotherWord.click()
  await anotherWord.click({ modifiers: ['Shift'] })
  await page.keyboard.press('Backspace')
  await page.waitForFunction(() => window.fixture.waiting())
  await page.evaluate(() => { window.fixture.refuse(); window.fixture.externalEdit() })
  await editorBanner.getByRole('button', { name: 'Discard unsaved edits' }).click()
  await page.waitForSelector('[data-recording-editor][data-edits-revision="3"]')
  assert.equal(await anotherWord.evaluate(el => el.classList.contains('tre-cut')), false)
  console.log('Discard reloads the newer saved edits')

  await page.evaluate(() => window.fixture.mount('panel'))
  const scrub = page.getByTestId('recording-scrub')
  const start = scrub.locator('[data-trim-handle="start"], .twrp-handle.start').first()
  const end = scrub.locator('[data-trim-handle="end"], .twrp-handle.end').first()
  const box = await scrub.boundingBox()
  const drag = async (handle, ratio) => {
    const h = await handle.boundingBox()
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * ratio, h.y + h.height / 2)
    await page.mouse.up()
  }
  await drag(start, 0.15)
  await page.waitForFunction(() => window.fixture.waiting())
  await drag(end, 0.8)
  await page.evaluate(() => window.fixture.refuse())
  const panelBanner = page.getByRole('alert').filter({ hasText: /unsaved/i })
  await panelBanner.waitFor()
  const exportButton = page.getByRole('button', { name: 'Export video…' })
  assert.equal(await page.evaluate(() => window.fixture.saved().revision), 0, 'a queued trim cannot overtake the refused trim')
  assert.match(await panelBanner.innerText(), /2 unsaved recording edits/)
  assert.equal(await page.getByRole('button', { name: 'Trim end here' }).isEnabled(), false)
  assert.equal(await page.getByRole('switch', { name: 'Camera' }).isEnabled(), false)
  assert.equal(await end.getAttribute('aria-disabled'), 'true')
  await drag(end, 0.65)
  await page.evaluate(() => window.fixture.tryPanelKeys())
  assert.equal(await page.evaluate(() => window.fixture.calls.length), 1, 'no refused-state control sends or adds an edit')
  assert.equal(await exportButton.isEnabled(), false, 'a refused trim blocks export')
  assert.equal(await page.evaluate(() => window.fixture.canLeave()), false, 'navigation cannot drop the refused trim')
  await page.evaluate(() => window.fixture.allow())
  await panelBanner.getByRole('button', { name: 'Retry', exact: true }).click()
  await panelBanner.waitFor({ state: 'hidden' })
  assert.equal(await exportButton.isEnabled(), true, 'saving both trims unlocks export')
  assert.equal(await page.evaluate(() => window.fixture.canLeave()), true)
  const calls = await page.evaluate(() => window.fixture.calls)
  assert.deepEqual(calls, [
    { kind: 'trim-start', revision: 0, digest: '0' },
    { kind: 'trim-start', revision: 0, digest: '0' },
    { kind: 'trim-end', revision: 1, digest: '1' },
  ], 'Retry preserves the base and plays the queue in order')
  assert.equal(await page.evaluate(() => window.fixture.saved().cuts.length), 2)
  console.log('A later trim is blocked while one is refused; Retry applies the queue in order')
} finally {
  await browser.close()
}
