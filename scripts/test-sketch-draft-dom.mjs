import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { MAX_SKETCH_BYTES } from '../src/shared/scratchpad.ts'

const sketchCss = readFileSync(new URL('../src/renderer/src/sketch.css', import.meta.url), 'utf8')

const { outputFiles: [bundle] } = await build({
  stdin: {
    contents: `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import SketchView from './src/renderer/src/components/SketchView.tsx'
import { useSketch } from './src/renderer/src/lib/useSketch.ts'
import { MAX_SKETCH_BYTES } from './src/shared/scratchpad.ts'

const before = '/vault/before/talk-outline.md'
const after = '/vault/after/talk-outline.md'
let path = before
let serial = 0
const files = new Map()
window.sketchFixture = { writes: [], before, after }
const fixture = window.sketchFixture
fixture.exported = null
fixture.reportedDirty = false
const write = (expected, name, text) => {
  fixture.writes.push({ expected, name })
  if (expected !== path) return { ok: false, error: 'The open talk changed.' }
  if (new TextEncoder().encode(text).length > MAX_SKETCH_BYTES) return { ok: false, error: 'The sketch is too large.' }
  const sketch = { name, text, revision: String(++serial) }
  files.set(expected + '/' + name, sketch)
  return { ok: true, sketch }
}
window.tw = { scratchpad: {
  reportSketchDirty: dirty => { fixture.reportedDirty = dirty },
  createSketch: async (expected, text) => write(expected, 'Sketch-' + (serial + 1) + '.md', text),
  saveSketch: async (expected, name, revision, text) => write(expected, name, text),
  exportSketch: async (text) => { fixture.exported = text; return { ok: true, saved: true } },
} }
function App() {
  const [opened, setOpened] = useState(before)
  const sketch = useSketch(opened)
  fixture.move = () => { path = after; setOpened(after) }
  fixture.getFiles = () => Array.from(files)
  fixture.flush = sketch.flush
  fixture.close = sketch.close
  fixture.pending = sketch.hasPending
  if (!sketch.current) return <button onClick={() => void sketch.open()}>Open blank</button>
  const draft = sketch.current
  return <SketchView talkTitle="Test talk" name={draft.saved?.name ?? ''} text={draft.text} error={draft.error}
    sketches={[]} onChange={sketch.change} onOpen={() => void sketch.open()}
    onCopyDraft={() => void sketch.saveAsNew?.()} onDiscard={sketch.discard} onSaveElsewhere={() => void sketch.saveElsewhere()} onBack={() => void sketch.close()} />
}
createRoot(document.getElementById('root')).render(<App />)
`,
    loader: 'tsx', resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true, write: false, jsx: 'automatic', loader: { '.css': 'empty' },
})
const browser = await chromium.launch()
async function withSketch(run) {
  const page = await browser.newPage()
  try {
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle.text })
    await page.getByRole('button', { name: 'Open blank' }).click()
    const editor = page.getByRole('textbox', { name: 'Sketch text' })
    await editor.waitFor()
    await run(page, editor)
  } finally { await page.close() }
}
try {
  await withSketch(async (page, editor) => {
    assert.deepEqual(await page.evaluate(() => window.sketchFixture.writes), [])
    await page.getByRole('button', { name: /^Sketches for this talk/ }).click()
    await page.getByRole('menuitem', { name: 'New sketch', exact: true }).click()
    assert.equal(await page.evaluate(() => window.sketchFixture.close()), true)
    assert.deepEqual(await page.evaluate(() => window.sketchFixture.writes), [])
    await page.getByRole('button', { name: 'Open blank' }).click()
    await editor.fill('First non-empty save')
    await page.waitForFunction(() => window.sketchFixture.getFiles().length === 1)
    assert.equal(await editor.inputValue(), 'First non-empty save')
  })
  console.log('PASS abandoned blank sketches never create files')
  await withSketch(async (page, editor) => {
    await page.addStyleTag({ content: ':root { --font-ui: system-ui; } * { box-sizing: border-box; }\n' + sketchCss })
    for (const title of ['This year', 'Members’ meeting sketch']) {
      await editor.fill(title)
      const heading = page.getByRole('button', { name: `Sketches for this talk, ${title}` })
      const widths = await heading.locator('span').evaluate(label => ({
        available: label.clientWidth, actual: label.scrollWidth,
      }))
      assert.ok(widths.available >= widths.actual, `${title}: only ${widths.available}px for ${widths.actual}px of text`)
    }
  })
  console.log('PASS sketch names fit their headings when there is room')
  await withSketch(async (page, editor) => {
    await editor.fill('Existing sketch')
    assert.equal(await page.evaluate(() => window.sketchFixture.flush()), true)
    await editor.fill('Unsaved words at the old path')
    await page.evaluate(() => window.sketchFixture.move())
    await page.getByRole('alert').waitFor()
    assert.equal(await editor.inputValue(), 'Unsaved words at the old path')
    assert.equal(await page.evaluate(() => window.sketchFixture.pending()), true)
    assert.equal(await page.evaluate(() => window.sketchFixture.reportedDirty), true)
    await page.getByRole('button', { name: 'Save as a new sketch' }).click()
    await page.waitForFunction(() => window.sketchFixture.getFiles().length === 2)
    assert.deepEqual(await page.evaluate(() => window.sketchFixture.getFiles().map(([file, sketch]) => [file.split('/')[2], sketch.text])),
      [['before', 'Existing sketch'], ['after', 'Unsaved words at the old path']])
    assert.equal(await page.evaluate(() => window.sketchFixture.reportedDirty), false)
  })
  console.log('PASS a path change retains pending text and Save as new preserves the original')
  await withSketch(async (page, editor) => {
    await editor.fill('a'.repeat(MAX_SKETCH_BYTES + 1))
    assert.equal(await page.evaluate(() => window.sketchFixture.close()), false)
    const discard = page.getByRole('button', { name: 'Discard sketch changes' })
    page.once('dialog', dialog => dialog.dismiss())
    await discard.click()
    assert.equal(await page.evaluate(() => window.sketchFixture.pending()), true)
    page.once('dialog', dialog => dialog.accept())
    await discard.click()
    assert.equal(await page.evaluate(() => window.sketchFixture.pending()), false)
    assert.equal(await page.evaluate(() => window.sketchFixture.close()), true)
    assert.deepEqual(await page.evaluate(() => window.sketchFixture.getFiles()), [])
  })
  console.log('PASS an oversized sketch can be discarded with confirmation, then close succeeds')
  await withSketch(async (page, editor) => {
    const size = MAX_SKETCH_BYTES + 1
    await editor.fill('c'.repeat(size))
    assert.equal(await page.evaluate(() => window.sketchFixture.close()), false)
    await page.getByRole('button', { name: 'Save a copy elsewhere…' }).click()
    await page.getByRole('button', { name: 'Open blank' }).waitFor()
    assert.equal(await page.evaluate(() => window.sketchFixture.exported.length), size)
    assert.equal(await page.evaluate(() => window.sketchFixture.pending()), false)
  })
  console.log('PASS saving an oversized sketch elsewhere clears the guard after export')
} finally {
  await browser.close()
}
