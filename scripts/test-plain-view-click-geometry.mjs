// test:plain-view-click-geometry — plain editing view ticket 07, fourth fix round: a click lands
// on the text under the pointer.
//
// Two defects are held here, both seen in the app with real mouse clicks:
//   - The Talk details panel had outer vertical margins. CodeMirror measures a block widget by its
//     box, so every row under the panel was drawn 16 px below where the editor believed it was, and
//     a click in the lower part of a row put the caret on the next line. No block widget in Plain
//     may have an outer vertical margin: the spacing is padding inside the measured box.
//   - The faint heading mark (`### `) shown on the caret's heading pushed the title to the right,
//     so the second click of a double-click hit a different word. The mark hangs to the left of the
//     title and takes no width.
//
// The mount loads the app's real stylesheet, has line wrapping on and the panel present. Clicks are
// real pointer input (Playwright's mouse), not posAtCoords alone.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-click-geometry-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, BlockType, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { focusScopeExtension } from './src/renderer/src/extensions/focusScope.ts'
import { frontmatterTableExtension } from './src/renderer/src/extensions/frontmatterTable.ts'

const compartment = new Compartment()
window.mount = (doc, mode = 'plain') => {
  document.getElementById('host').innerHTML = ''
  const view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(doc.length),
    extensions: [
      history(), markdown({ base: markdownLanguage, codeLanguages: languages }),
      tokenProtectExtension(), focusScopeExtension(), frontmatterTableExtension(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      compartment.of(viewModeExtension(mode)),
      EditorView.lineWrapping
    ]
  }) })
  view.focus()
  return window.__v = view
}
window.caret = (pos) => window.__v.dispatch({ selection: EditorSelection.cursor(pos) })
window.head = () => window.__v.state.selection.main.head
window.sel = () => { const r = window.__v.state.selection.main; return window.__v.state.sliceDoc(r.from, r.to) }
// The row (the .cm-line) that holds a position, and a point a quarter of the way into the character at it.
window.rowOf = (pos) => {
  const v = window.__v
  const at = v.domAtPos(pos).node
  const el = (at.nodeType === 1 ? at : at.parentElement).closest('.cm-line')
  const r = el.getBoundingClientRect()
  const a = v.coordsAtPos(pos, 1), b = v.coordsAtPos(pos + 1, -1)
  return { top: r.top, height: r.height, x: a.left + (b.left - a.left) * 0.25, charLeft: a.left }
}
window.at = (x, y) => window.__v.posAtCoords({ x, y })
// Every line on screen: where CodeMirror believes it is, and where it is drawn.
window.blocks = () => {
  const v = window.__v
  return [...v.contentDOM.querySelectorAll('.cm-line')].map((el) => {
    const pos = v.posAtDOM(el)
    // A line with a block widget above it (the panel in a talk with no front matter) is one block of
    // several parts: the text's part is the line.
    const block = v.lineBlockAt(pos)
    const text = Array.isArray(block.type) ? block.type.find((b) => b.type === BlockType.Text) : block
    return { text: v.state.doc.lineAt(pos).text.slice(0, 24), model: text.top + v.documentTop, drawn: el.getBoundingClientRect().top }
  })
}
// Where the mark's first character stands (its top and bottom on screen).
window.markText = () => {
  const m = window.__v.contentDOM.querySelector('.cm-plain-hmark')
  const walker = document.createTreeWalker(m, NodeFilter.SHOW_TEXT)
  const node = walker.nextNode()
  const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 1)
  const r = range.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom }
}
window.markBox = () => {
  const m = window.__v.contentDOM.querySelector('.cm-plain-hmark')
  if (!m) return null
  const r = m.getBoundingClientRect()
  const g = window.__v.dom.querySelector('.cm-gutters')?.getBoundingClientRect()
  const c = window.__v.contentDOM.getBoundingClientRect()
  return { left: r.left, right: r.right, width: r.width, gutterRight: g ? g.right : c.left, contentLeft: c.left }
}
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const TALK = [
  '---', 'author: A', 'event: Regional transport forum', 'date: 12 March 2026', '---',
  '# Ten years of public bike hire', '',
  '## The decade in numbers', '{id=decade}', '',
  '### Trips have grown every year since 2016', '{statement}', '{id=growth}', '',
  'Steepest rises: 2018, the station opens; 2022, e-bikes arrive.', '',
  '### Who rides', '',
  'Commuters, students and visitors.', ''
].join('\n')
const ROWS = [
  ['the talk title', 'years'],
  ['a title with a hidden layout line and id', 'grown'],
  ['a title with no hidden line', 'rides'],
  ['a body line', 'station']
]
const FRACTIONS = [0.1, 0.25, 0.5, 0.75, 0.9]

const browser = await chromium.launch()
const errors = []
const failed = []
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<div id="host" style="width:820px;height:800px"></div>')
  // The app's own stylesheet: its rules reach the editor's lines and widgets.
  await page.addStyleTag({ content: readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8') })
  await page.addScriptTag({ path: outfile })
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const open = (d, mode = 'plain') => ev(([d, m]) => { window.mount(d, m) }, [d, mode])
  const check = async (label, fn) => {
    try { await fn() } catch (e) { failed.push(`${label}: ${String(e.message).split('\n')[0]}${e.actual !== undefined ? ' | got ' + JSON.stringify(e.actual) + ' | wanted ' + JSON.stringify(e.expected) : ''}`) }
  }
  const settle = () => page.waitForTimeout(60)

  // ── Rows are where the editor believes they are ────────────────────────────────────────────
  await check('every line is drawn where CodeMirror measures it (panel present)', async () => {
    await open(TALK)
    await settle()
    assert.ok(await ev(() => !!document.querySelector('[data-talk-details]')), 'the Talk details panel is in the editor')
    const blocks = await ev(() => window.blocks())
    assert.ok(blocks.length >= 6, 'the lines are on screen')
    for (const b of blocks) assert.ok(Math.abs(b.model - b.drawn) <= 1, `"${b.text}" is drawn at ${b.drawn}, measured at ${b.model}`)
  })
  await check('the same with the panel open', async () => {
    await open(TALK)
    await page.click('.cm-td-toggle')
    await settle()
    const blocks = await ev(() => window.blocks())
    for (const b of blocks) assert.ok(Math.abs(b.model - b.drawn) <= 1, `"${b.text}" is drawn at ${b.drawn}, measured at ${b.model}`)
    await page.click('.cm-td-more-toggle')
    await settle()
    for (const b of await ev(() => window.blocks())) assert.ok(Math.abs(b.model - b.drawn) <= 1, `with More open, "${b.text}" is drawn at ${b.drawn}, measured at ${b.model}`)
    const offset = TALK.indexOf('station') + 2
    const row = await ev((p) => window.rowOf(p), offset)
    await page.mouse.click(row.x, row.top + row.height * 0.75)
    assert.equal(await ev(() => window.head()), offset, 'a click on the body line with the panel open')
  })
  await ev(() => document.querySelector('.cm-td-toggle').click())
  await check('the same in a talk with no front matter (the panel above the first line)', async () => {
    await open(TALK.slice(TALK.indexOf('# Ten')))
    await settle()
    assert.ok(await ev(() => !!document.querySelector('[data-talk-details]')), 'the panel shows')
    for (const b of await ev(() => window.blocks())) assert.ok(Math.abs(b.model - b.drawn) <= 1, `"${b.text}" is drawn at ${b.drawn}, measured at ${b.model}`)
  })
  await check('the panel keeps its gaps: 2 px above its border, 14 px below', async () => {
    await open(TALK)
    await settle()
    const gaps = await ev(() => {
      const box = document.querySelector('.cm-talk-details').getBoundingClientRect()
      const first = window.__v.contentDOM.querySelector('.cm-line').getBoundingClientRect()
      const content = window.__v.contentDOM.getBoundingClientRect()
      const padTop = parseFloat(getComputedStyle(window.__v.contentDOM).paddingTop)
      return { above: box.top - (content.top + padTop), below: first.top - box.bottom }
    })
    assert.ok(Math.abs(gaps.above - 2) <= 0.5, `gap above is ${gaps.above}`)
    assert.ok(Math.abs(gaps.below - 14) <= 0.5, `gap below is ${gaps.below}`)
  })

  // ── A click anywhere in a row's height lands on the text under it ───────────────────────────
  for (const [label, word] of ROWS) {
    const offset = TALK.indexOf(word) + 2
    for (const f of FRACTIONS) {
      await check(`${label}: a click at ${f * 100}% of the row's height lands mid-word`, async () => {
        await open(TALK)
        await settle()
        const row = await ev((p) => window.rowOf(p), offset)
        const y = row.top + row.height * f
        assert.equal(await ev(([x, y]) => window.at(x, y), [row.x, y]), offset, 'posAtCoords')
        await page.mouse.click(row.x, y)
        assert.equal(await ev(() => window.head()), offset, 'the caret after a real click')
      })
    }
  }

  // ── The heading mark takes no width ───────────────────────────────────────────────────────
  for (const marks of ['#', '##', '###', '####']) {
    const d = `# Talk\n\n${marks} Trips have grown\n\nBody line.\n`
    const first = d.indexOf('Trips')
    await check(`${marks}: the title does not move when the caret comes onto its line`, async () => {
      await open(d)
      await ev((p) => window.caret(p), d.indexOf('Body'))
      await settle()
      const off = await ev((p) => window.rowOf(p).charLeft, first)
      await ev((p) => window.caret(p), first + 3)
      await settle()
      const on = await ev((p) => window.rowOf(p).charLeft, first)
      const mark = await ev(() => window.markBox())
      assert.ok(mark, 'the mark shows on the caret\'s heading')
      assert.ok(Math.abs(on - off) < 0.01, `the title starts at ${off} without the caret and ${on} with it`)
      assert.ok(mark.right <= on + 0.5, 'the mark ends where the title starts')
      assert.ok(mark.left >= mark.gutterRight, `the mark (from ${mark.left}) does not run under the margin (to ${mark.gutterRight})`)
      // It stands on the title's baseline: the same height as when it is set in the line.
      const hung = await ev(() => window.markText())
      const inLine = await page.addStyleTag({ content: '.cm-line .cm-plain-hmark{position:static!important;transform:none!important}' })
      const flowed = await ev(() => window.markText())
      await inLine.evaluate((el) => el.remove())
      assert.ok(Math.abs(hung.top - flowed.top) <= 1 && Math.abs(hung.bottom - flowed.bottom) <= 1, `the mark stands at ${hung.top} hanging and ${flowed.top} in the line`)
    })
    await check(`${marks}: a double-click on the first word of the title selects that word`, async () => {
      await open(d)
      await ev((p) => window.caret(p), d.indexOf('Body'))
      await settle()
      const row = await ev((p) => window.rowOf(p), first + 2)
      await page.mouse.dblclick(row.x, row.top + row.height * 0.5)
      assert.equal(await ev(() => window.sel()), 'Trips')
    })
    await check(`${marks}: the mark is still text the caret walks into`, async () => {
      await open(d)
      await ev((p) => window.caret(p), first)
      await page.keyboard.press('ArrowLeft')
      assert.equal(await ev(() => window.head()), first - 1, 'ArrowLeft from the start of the title goes into the mark')
    })
  }
  for (const marks of ['#####', '######']) {
    const d = `# Talk\n\n${marks} Trips have grown\n\nBody line.\n`
    await check(`${marks}: the mark fits between the margin and the title`, async () => {
      await open(d)
      await ev((p) => window.caret(p), d.indexOf('Trips') + 3)
      await settle()
      const mark = await ev(() => window.markBox())
      assert.ok(mark.left >= mark.gutterRight, `the mark (from ${mark.left}) does not run under the margin (to ${mark.gutterRight})`)
    })
  }
  await check('a double-click on a later word of a title selects that word', async () => {
    await open(TALK)
    await settle()
    const row = await ev((p) => window.rowOf(p), TALK.indexOf('rides') + 2)
    await page.mouse.dblclick(row.x, row.top + row.height * 0.5)
    assert.equal(await ev(() => window.sel()), 'rides')
  })
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

assert.deepEqual(errors, [], 'no page errors')
if (failed.length) {
  console.error(`test:plain-view-click-geometry: ${failed.length} failed`)
  for (const f of failed) console.error('  - ' + f)
  process.exit(1)
}
console.log('test:plain-view-click-geometry: passed')
