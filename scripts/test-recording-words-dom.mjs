// The recording editor's words: the marks between them never cover a word. "picture changed" (shown where a
// slide's start was moved away from the moment the picture changed) took no room of its own and sat over the
// next words. Rendered with the editor's own Words component and stylesheet at the Tools window's narrowest
// width and in narrow columns. Playwright's bundled Chromium.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..'), scratch = mkdtempSync(join(tmpdir(), 'tw-recording-words-'))
let browser, checks = 0
const test = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name) }
try {
  await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client'
import { Words } from './src/renderer/src/components/recording/RecordingEditor.tsx'
import { editorWords, slideRows } from './src/shared/recording-editor.ts'
import './src/renderer/src/styles.css'
import './src/renderer/src/components/recording/recording-editor.css'
const text = 'gate bridge mill water group leader. route meadow weather boots stile flask. bank reeds heron weir walk river. path map gate bridge mill water. group leader route meadow weather boots.'.split(' ')
const words = text.map((t, i) => ({ text: t, start: 200 + i * 400, end: 200 + i * 400 + 300 }))
const ctx = editorWords({ words }, 200 + text.length * 400 + 500)
const rows = slideRows(ctx, [{ event: 'enter', slideId: 'a', tMs: 0 }])
// The picture changed before "group" (word 4) and the slide's start was moved: the note shows there; and a plain mark before word 12.
const clickBefore = new Map([[4, { row: 0, moved: true }], [12, { row: 0, moved: false }]])
const rc = { ctx, rows, cuts: [], byWord: new Int32Array(ctx.words.length).fill(-1), slides: {}, flagsAfter: new Map(), stepsBefore: new Map(), clickBefore, sidecarCuts: [] }
function App() {
  const [width, setWidth] = React.useState(760)
  window.setWidth = setWidth
  return <div className="tre lt"><div className="tre-list" style={{ width }}><div className="tre-wcol"><Words row={rows[0]} rc={rc} selA={-1} selB={-1} drag={null} choosing={false} onRestore={() => {}} /></div></div></div>
}
createRoot(document.getElementById('root')).render(<App />)`,
      resolveDir: root, loader: 'tsx', sourcefile: 'recording-words-dom.tsx'
    },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(scratch, 'test.js'), logLevel: 'error'
  })
  writeFileSync(join(scratch, 'test.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="test.css"><div id="root"></div><script src="test.js"></script>')
  browser = await chromium.launch({ headless: true, executablePath: process.env.TW_CHROMIUM_HEADLESS_SHELL || undefined })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  page.setDefaultTimeout(6000)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(pathToFileURL(join(scratch, 'test.html')).href)
  await page.locator('.tre-picnote').waitFor()

  await test('"picture changed" never covers a word: at the Tools window\'s narrowest width and in narrow columns', async () => {
    for (const width of [760, 520, 360, 240]) {
      await page.evaluate((w) => window.setWidth(w), width)
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
      const hits = await page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect()
        const meets = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
        const words = [...document.querySelectorAll('[data-w]')]
        return [...document.querySelectorAll('.tre-picnote')].flatMap((note) => words.filter((w) => meets(box(note), box(w))).map((w) => w.textContent))
      })
      assert.deepEqual(hits, [], `at ${width}px the label covers ${JSON.stringify(hits)}`)
      assert.equal(await page.locator('.tre-picnote').count(), 1, 'one note, for the moved start only')
    }
  })

  assert.deepEqual(errors, [])
  console.log(`\n${checks} passed`)
} finally {
  await browser?.close().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
