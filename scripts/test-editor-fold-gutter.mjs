// The editor gutter gives each foldable slide heading (or list item) exactly one collapse control and
// leaves image lines without one. The real extensions (slide-number gutter, fold gutter, outline fold
// service, markdown parser with its fold override, image widget with placement chips) are bundled for
// Chromium; fold markers are matched to document lines by position in the rendered DOM.
// SCREENSHOT=<path> saves a picture of the gutter.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-fold-gutter-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { codeFolding, foldGutter } from '@codemirror/language'
import { imageWidgetExtension } from './src/renderer/src/extensions/imageWidget.ts'
import { imageParagraphNoFold, outlineFoldService } from './src/renderer/src/extensions/outlineFold.ts'
import { setSlideNumberLines, slideNumberGutterExtension } from './src/renderer/src/extensions/slideNumberGutter.ts'
// The same extension order as components/Editor.tsx.
window.mountEditor = (doc, slideLines) => {
  const view = new EditorView({
    parent: document.getElementById('host'),
    state: EditorState.create({
      doc,
      extensions: [
        slideNumberGutterExtension,
        markdown({ base: markdownLanguage, extensions: [imageParagraphNoFold] }),
        codeFolding(),
        foldGutter(),
        outlineFoldService,
        imageWidgetExtension({ vaultRoot: null, talkDir: null, placementForLine: () => ({ kind: 'row', index: 1, count: 2 }) }),
        EditorView.lineWrapping
      ]
    })
  })
  setSlideNumberLines(view, slideLines)
  window.__view = view
}
// Fold markers by 1-based document line: the gutter element whose top is the line block's top.
window.foldMarkerLines = () => {
  const view = window.__view
  const marks = [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')].filter((el) => el.textContent.trim() !== '')
  const out = []
  for (const el of marks) {
    const top = el.getBoundingClientRect().top
    for (let n = 1; n <= view.state.doc.lines; n += 1) {
      const block = view.lineBlockAt(view.state.doc.line(n).from)
      if (Math.abs(block.top + view.documentTop - top) < 3) { out.push(n); break }
    }
  }
  return out
}
`
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAIAAABM5OhcAAAAFklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAO8GECAAAZf3V9cAAAAASUVORK5CYII='
const outline = `# Talk

## Part

### Full
![full](${PNG})

### Row
![r1](${PNG})
![r2](${PNG})

### Grid
{image-grid}
![g1](${PNG})
![g2](${PNG})

### Beside
![beside](${PNG})

Some words beside the picture
and a second line of prose.

### Indented
  ![i1](${PNG})
   ![i2](${PNG})

### Thumbs
- one
  - nested
- two
![t1](${PNG})

### Empty
`
const lines = outline.split('\n')
const lineOf = (text) => lines.findIndex((l) => l.startsWith(text)) + 1
const headings = lines.map((l, i) => (/^#{1,6}\s/.test(l) ? i + 1 : 0)).filter(Boolean)
let browser
try {
  await build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'fold-gutter-entry.ts' }, bundle: true, format: 'iife', platform: 'browser', outfile })
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 } })
  await page.setContent('<!doctype html><body style="margin:0"><div id="host" style="width:880px"></div></body>')
  await page.addScriptTag({ content: readFileSync(outfile, 'utf8') })
  await page.evaluate(([d, h]) => window.mountEditor(d, h), [outline, headings])
  await page.waitForSelector('.cm-foldGutter .cm-gutterElement', { state: 'attached' })
  await page.waitForTimeout(300)
  const marked = await page.evaluate(() => window.foldMarkerLines())
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT, clip: { x: 0, y: 0, width: 520, height: 900 } })

  assert.equal(await page.locator('.cm-foldGutter').count(), 1, 'one fold gutter column')
  assert.equal(new Set(marked).size, marked.length, `no line carries two fold markers (${marked})`)
  // Every heading with content below it has exactly one collapse control; the empty one has none.
  for (const text of ['# Talk', '## Part', '### Full', '### Row', '### Grid', '### Beside', '### Indented', '### Thumbs']) {
    assert.equal(marked.filter((n) => n === lineOf(text)).length, 1, `${text} has one collapse control`)
  }
  // Image lines, and the trigger line sitting over them, have none.
  for (let n = 1; n <= lines.length; n += 1) {
    if (/^\s*!\[/.test(lines[n - 1]) || lines[n - 1] === '{image-grid}') assert.ok(!marked.includes(n), `line ${n} (${lines[n - 1].slice(0, 12)}) has no collapse control`)
  }
  // Prose and list folds are unchanged: a two-line paragraph and a list item with children still fold.
  assert.ok(marked.includes(lineOf('Some words')), 'a prose paragraph keeps markdown\'s fold')
  assert.ok(marked.includes(lineOf('- one')), 'a list item with children keeps its fold')
  // Nothing else: every marker sits on a heading, the prose paragraph or a list item.
  const allowed = new Set([...headings, lineOf('Some words'), lineOf('- one'), lineOf('  - nested'), lineOf('- two')])
  assert.deepEqual(marked.filter((n) => !allowed.has(n)), [], 'no collapse control on any other line')
  console.log(`editor fold gutter: ok (${marked.length} markers: lines ${marked.join(', ')})`)
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
