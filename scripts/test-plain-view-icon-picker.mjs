// test:plain-view-icon-picker — plain editing view ticket 13: Command-I puts an icon on the line
// the caret is on.
//
// The real plainView extension with the app's keys and history, the real picker
// (PlainIconPicker.tsx), its hook (usePlainIconPicker.tsx) and the editor's side of it
// (plainView/iconTools.ts), bundled for chrome-headless-shell. The page stands in for two things
// of the app: the icon bridge (`window.tw.icons`, a small set of names) and the workspace's
// Command-I handler (WorkspaceLayout.tsx), which only calls the hook's `toggle`.
//   - Command-I opens the picker under the caret's line with the search field focused; before a
//     search it lists the whole set, each icon with its name under it;
//   - typing filters; the arrows move across and down the grid; the footer names the highlight;
//   - Enter inserts `{icon=…}` on the line, focus returns to the editor, and ONE Undo gives back
//     the exact text; the caret stays where it was;
//   - Escape closes with the text and the selection unchanged; so does a click outside;
//   - a click on an icon inserts it; the icon is then first under "Recent";
//   - a line with an icon opens with that icon shown and a "Remove icon" row, which removes it;
//   - a title takes the token before its other groups; a paragraph on its last line;
//   - the tidy-up the autosave runs leaves a title's icon on the title line (0.39.0-preview.6 moved
//     it under the title, and the icon went from the plain view and the slide), moves the title's
//     other groups down as before, and the plain view still draws the picture;
//   - a picture line gets the message, changes nothing, and the message goes by itself;
//   - no transaction of the picker's is anything but one plain change (no filter rewrote it).
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-icon-picker-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { createElement, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Prec } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, undoDepth } from '@codemirror/commands'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { plainIconTools } from './src/renderer/src/extensions/plainView/iconTools.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { editorBaseKeymap } from './src/renderer/src/extensions/editorBaseKeymap.ts'
import { buildEditorKeyBindings } from './src/renderer/src/keymap/store.ts'
import { usePlainIconPicker } from './src/renderer/src/components/usePlainIconPicker.tsx'
import { appKeyState, failOnCaughtExceptions } from './scripts/lib/plain-view-test-mount.mjs'
import { normalizePositions } from './src/shared/outline-normalize.ts'
import { minimalChange } from './src/renderer/src/lib/minimalChange.ts'

const STAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5L5.5 21l2-7.5L2 9h7z"/></svg>'
const NAMES = ['anchor', 'bike', 'star', 'star-half', 'star-off', 'stamp', 'sun', 'zap', 'route', 'lightbulb', 'map', 'map-pin', 'flag', 'heart', 'house', 'key', 'leaf', 'lock', 'mail', 'moon', 'music', 'phone'].map((n) => 'lucide:' + n)
// The app's icon bridge, over a small set.
window.tw = { icons: {
  names: async () => NAMES,
  search: async (q) => NAMES.filter((key) => key.slice(7).includes(String(q).toLowerCase())).map((key) => ({ key, source: 'lucide' })),
  svg: async () => STAR
} }
window.toasts = []
window.addEventListener('tw-toast', (e) => window.toasts.push(e.detail && e.detail.message))
window.transactions = []

let view = null
const tools = { current: plainIconTools(() => view) }
let toggle = () => false
function Host() {
  const ref = useRef(tools.current)
  const picker = usePlainIconPicker(ref)
  toggle = picker.toggle
  return picker.view
}
const reactRoot = createRoot(document.getElementById('react'))
flushSync(() => reactRoot.render(createElement(Host)))
// WorkspaceLayout's Command-I handler: capture, the editor never sees the key.
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'i' || e.key === 'I')) { e.preventDefault(); e.stopPropagation(); toggle() }
}, { capture: true })

window.mount = (doc) => {
  document.getElementById('host').innerHTML = ''
  window.transactions.length = 0
  view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [
      history(), markdown({ base: markdownLanguage }), tokenProtectExtension(), appKeyState(),
      keymap.of([...editorBaseKeymap]), Prec.highest(keymap.of(buildEditorKeyBindings())),
      viewModeExtension('plain', { iconSvg: async () => STAR }), EditorView.lineWrapping, failOnCaughtExceptions(),
      EditorView.updateListener.of((update) => {
        for (const tr of update.transactions) if (tr.docChanged) { let n = 0; tr.changes.iterChanges(() => { n += 1 }); window.transactions.push(n) }
      })
    ]
  }) })
  view.focus()
  return window.__v = view
}
// The tidy-up the editor runs at every autosave (Editor.tsx scheduleAutosave, flushSave and the
// whole-buffer save): normalizePositions on the text, applied as one minimal change.
window.saveTidy = () => {
  const content = view.state.doc.toString()
  const normalized = normalizePositions(content)
  if (normalized === content) return false
  const ch = minimalChange(content, normalized)
  view.dispatch({ changes: { from: ch.from, to: ch.to, insert: ch.insert } })
  return true
}
window.titlePictures = (title) => [...document.querySelectorAll('.cm-line')].filter((line) => line.textContent.includes(title)).map((line) => line.querySelectorAll('.cm-plain-icon-picture').length)
window.caret = (pos) => view.dispatch({ selection: EditorSelection.cursor(pos), userEvent: 'select' })
window.select = (anchor, head) => view.dispatch({ selection: EditorSelection.range(anchor, head), userEvent: 'select' })
window.sel = () => { const r = view.state.selection.main; return [r.anchor, r.head] }
window.docText = () => view.state.doc.toString()
window.undoDepth = () => undoDepth(view.state)
window.editorFocused = () => view.hasFocus
window.lineRect = () => { const c = view.coordsAtPos(view.state.selection.main.head); return { top: c.top, bottom: c.bottom } }
`
await build({
  stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, format: 'iife', outfile, logLevel: 'silent',
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }
})

const DOC = [
  '# Bike share',                            // 0
  '',
  '## How it works',                         // 2
  '',
  '### What riders ask for {reveal}',        // 4
  '- Bikes that are there when I arrive',    // 5
  '- A safe lane {icon=lucide:route}',       // 6
  '',
  'A paragraph that starts here',            // 8
  'and ends here.',                          // 9
  '',
  '![picture](a.png)',                       // 11
  ''
].join('\n')
const at = (needle, offset = 0) => DOC.indexOf(needle) + offset
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

const browser = await chromium.launch()
const errors = []
const failed = []
let caught = []
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  page.on('pageerror', (e) => errors.push(String(e)))
  // A page with an origin, so that localStorage (the recently used icons) is there as in the app.
  const html = `<!doctype html><style>${readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')}</style><div id="host" style="width:900px;height:500px"></div><div id="react"></div>`
  await page.route('http://talkweaver.test/', (route) => route.fulfill({ contentType: 'text/html', body: html }))
  await page.goto('http://talkweaver.test/')
  await page.addScriptTag({ path: outfile })
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const text = () => ev(() => window.docText())
  const sel = () => ev(() => window.sel())
  const picker = page.locator('[data-plain-icon-picker]')
  const search = page.locator('[data-plain-icon-search]')
  const cells = () => ev(() => [...document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]')].map((c) => c.dataset.iconKey))
  const active = () => ev(() => document.querySelector('[data-plain-icon-picker] [data-active="true"]')?.dataset.iconKey ?? (document.querySelector('[data-plain-icon-remove][data-active="true"]') ? 'REMOVE' : null))
  const footer = () => ev(() => document.querySelector('[data-plain-icon-footer]').textContent)
  const labels = () => ev(() => [...document.querySelectorAll('.pv-icon-label')].map((l) => l.textContent))
  /** A picker a check left open is closed first (Command-I on an open picker closes it). */
  const fresh = async () => {
    if (await picker.count()) { await search.press('Escape'); await picker.waitFor({ state: 'detached' }) }
    await ev((d) => { window.mount(d) }, DOC)
  }
  const open = async (pos) => {
    await fresh()
    await ev((p) => window.caret(p), pos)
    await page.keyboard.press(`${mod}+i`)
  }
  const check = async (label, fn) => {
    try { await fn() } catch (e) { failed.push(`${label}: ${String(e.message).split('\n')[0]}${e.actual !== undefined ? ' | got ' + JSON.stringify(e.actual) + ' | wanted ' + JSON.stringify(e.expected) : ''}`) }
  }
  await ev(() => window.localStorage.clear())

  await check('Command-I opens the picker under the caret line, search focused, the set listed with names', async () => {
    await open(at('- Bikes', 8))
    await picker.waitFor()
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length > 0)
    assert.equal(await ev(() => document.activeElement === document.querySelector('[data-plain-icon-search]')), true, 'the search field has the focus')
    assert.deepEqual(await labels(), ['All icons'])
    const list = await cells()
    assert.deepEqual(list.slice(0, 3), ['lucide:anchor', 'lucide:bike', 'lucide:star'])
    assert.equal(await ev(() => document.querySelector('[data-icon-key="lucide:star-half"] .pv-icon-name').textContent), 'star-half', 'each icon has its name under it')
    const name = await ev(() => { const n = document.querySelector('[data-icon-key="lucide:lightbulb"] .pv-icon-name'); const s = getComputedStyle(n); return [s.textOverflow, s.overflow, s.whiteSpace] })
    assert.deepEqual(name, ['ellipsis', 'hidden', 'nowrap'], 'a long name is cut with an ellipsis')
    const box = await picker.boundingBox()
    const line = await ev(() => window.lineRect())
    assert.ok(box.y >= line.bottom && box.y - line.bottom < 12, `the panel is just under the caret's line (${box.y} against ${line.bottom})`)
    const columns = await ev(() => new Set([...document.querySelectorAll('[data-icon-key][data-row="1"]')].map((c) => Math.round(c.getBoundingClientRect().left))).size)
    assert.equal(columns, 5, 'five icons to a row')
    assert.equal(await active(), 'lucide:anchor')
    assert.match(await footer(), /^anchor\s+Lucide$/)
  })

  await check('typing filters, the arrows move in two dimensions, Enter inserts, one Undo restores', async () => {
    await open(at('- Bikes', 8))
    await picker.waitFor()
    const before = await sel()
    await page.keyboard.type('sta')
    await page.waitForFunction(() => document.querySelector('.pv-icon-label')?.textContent.includes('match “sta”'))
    assert.deepEqual(await cells(), ['lucide:star', 'lucide:star-half', 'lucide:star-off', 'lucide:stamp'])
    assert.deepEqual(await labels(), ['4 icons match “sta”'])
    assert.equal(await active(), 'lucide:star')
    await page.keyboard.press('ArrowRight')
    assert.equal(await active(), 'lucide:star-half')
    assert.match(await footer(), /^star-half/)
    await page.keyboard.press('ArrowLeft')
    assert.equal(await active(), 'lucide:star')
    // Two rows: clear the search and move down a row, and back up.
    await search.fill('')
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length > 10)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    assert.equal(await active(), 'lucide:sun', 'down: the same column of the next row')
    await page.keyboard.press('ArrowUp')
    assert.equal(await active(), 'lucide:bike')
    assert.equal(await text(), DOC, 'nothing is written while the picker is open')
    await page.keyboard.type('sta')
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length === 4)
    await page.keyboard.press('Enter')
    await picker.waitFor({ state: 'detached' })
    assert.equal(await text(), DOC.replace('- Bikes that are there when I arrive', '- Bikes that are there when I arrive {icon=lucide:star}'))
    assert.equal(await ev(() => window.editorFocused()), true, 'focus is back in the editor')
    assert.deepEqual(await sel(), before, 'the caret is where it was')
    assert.deepEqual(await ev(() => window.transactions), [1], 'one transaction, one change')
    assert.equal(await ev(() => window.undoDepth()), 1)
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await text(), DOC, 'one Undo gives back the exact text')
    assert.equal(await ev(() => window.undoDepth()), 0)
  })

  await check('a caret at the end of the text stays before the new token', async () => {
    const end = at('- Bikes that are there when I arrive') + '- Bikes that are there when I arrive'.length
    await open(end)
    await picker.waitFor()
    await page.keyboard.type('zap')
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length === 1)
    await page.keyboard.press('Enter')
    await picker.waitFor({ state: 'detached' })
    assert.equal((await text()).split('\n')[5], '- Bikes that are there when I arrive {icon=lucide:zap}')
    assert.deepEqual(await sel(), [end, end])
  })

  await check('Escape and a click outside close with the text and the selection unchanged', async () => {
    await fresh()
    await ev(([a, h]) => window.select(a, h), [at('- Bikes', 2), at('- Bikes', 7)])
    await page.keyboard.press(`${mod}+i`)
    await picker.waitFor()
    await page.keyboard.type('su')
    await page.keyboard.press('Escape')
    await picker.waitFor({ state: 'detached' })
    assert.equal(await text(), DOC)
    assert.deepEqual(await sel(), [at('- Bikes', 2), at('- Bikes', 7)])
    assert.equal(await ev(() => window.editorFocused()), true)
    assert.equal(await ev(() => window.undoDepth()), 0)
    await page.keyboard.press(`${mod}+i`)
    await picker.waitFor()
    // The click that closes is one made after the panel is up (it arms on the next task, so the
    // click that opened it, from a menu, is not taken for a click outside).
    await page.waitForTimeout(50)
    await page.mouse.click(950, 880)
    await picker.waitFor({ state: 'detached' })
    assert.equal(await text(), DOC)
    // Command-I again closes it too.
    await ev((p) => { window.__v.focus(); window.caret(p) }, at('- Bikes', 3))
    await page.keyboard.press(`${mod}+i`)
    await picker.waitFor()
    await page.keyboard.press(`${mod}+i`)
    await picker.waitFor({ state: 'detached' })
    assert.equal(await text(), DOC)
  })

  await check('a click inserts; the icon is then first under Recent', async () => {
    await open(at('- Bikes', 4))
    await picker.waitFor()
    await page.locator('[data-icon-key="lucide:heart"]').first().click()
    await picker.waitFor({ state: 'detached' })
    assert.equal((await text()).split('\n')[5], '- Bikes that are there when I arrive {icon=lucide:heart}')
    assert.equal(await ev(() => window.editorFocused()), true)
    await open(at('- Bikes', 4))
    await picker.waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('.pv-icon-label')].some((l) => l.textContent === 'Recent'))
    assert.deepEqual((await labels()).slice(0, 2), ['Recent', 'All icons'])
    assert.equal((await cells())[0], 'lucide:heart', 'most recent first')
    assert.equal(await active(), 'lucide:heart')
  })

  await check('a line with an icon: shown, marked, replaced in place, and removed by the Remove row', async () => {
    await open(at('- A safe lane', 4))
    await picker.waitFor()
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length > 0)
    assert.equal((await labels())[0], 'On this list item')
    assert.match(await ev(() => document.querySelector('.pv-icon-current-name').textContent), /^route.*selected$/)
    assert.equal(await ev(() => document.querySelector('[data-icon-key="lucide:route"]').classList.contains('pv-icon-cell--current')), true, 'the line\'s icon is marked in the grid')
    assert.notEqual(await active(), 'REMOVE', 'Enter does not remove by default')
    await page.keyboard.type('sun')
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length === 1)
    await page.keyboard.press('Enter')
    await picker.waitFor({ state: 'detached' })
    assert.equal(await text(), DOC.replace('{icon=lucide:route}', '{icon=lucide:sun}'), 'replaced in place')
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await text(), DOC)
    await page.keyboard.press(`${mod}+i`)
    await picker.waitFor()
    for (let k = 0; k < 6 && await active() !== 'REMOVE'; k += 1) await page.keyboard.press('ArrowUp')
    assert.equal(await active(), 'REMOVE')
    assert.equal(await footer(), 'Remove icon')
    await page.keyboard.press('Enter')
    await picker.waitFor({ state: 'detached' })
    assert.equal(await text(), DOC.replace('- A safe lane {icon=lucide:route}', '- A safe lane'), 'the token and its space are gone')
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await text(), DOC, 'one Undo puts it back')
  })

  await check('a title and a paragraph', async () => {
    await open(at('### What riders', 8))
    await picker.waitFor()
    await page.keyboard.type('lightb')
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length === 1)
    await page.keyboard.press('Enter')
    await picker.waitFor({ state: 'detached' })
    assert.equal((await text()).split('\n')[4], '### What riders ask for {icon=lucide:lightbulb} {reveal}')
    await open(at('A paragraph that', 3))
    await picker.waitFor()
    await page.keyboard.type('moon')
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length === 1)
    await page.keyboard.press('Enter')
    await picker.waitFor({ state: 'detached' })
    assert.equal(await text(), DOC.replace('and ends here.', 'and ends here. {icon=lucide:moon}'), 'the token ends the paragraph')
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await text(), DOC)
  })

  await check('the autosave tidy-up leaves a title icon on the title line', async () => {
    const title = '### What riders ask for {icon=lucide:lightbulb}'
    // Picked with the picker, on a title that has another group: the icon stays, the group moves.
    await open(at('### What riders', 8))
    await picker.waitFor()
    await page.keyboard.type('lightb')
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length === 1)
    await page.keyboard.press('Enter')
    await picker.waitFor({ state: 'detached' })
    await page.waitForFunction(() => window.titlePictures('What riders ask for')[0] === 1)
    assert.equal(await ev(() => window.saveTidy()), true, 'the tidy-up has the {reveal} group to move')
    assert.deepEqual((await text()).split('\n').slice(4, 6), [title, '{reveal}'], 'the icon is still on the title line; {reveal} is under it')
    assert.equal(await ev(() => window.saveTidy()), false, 'a second save changes nothing')
    await page.waitForFunction(() => window.titlePictures('What riders ask for')[0] === 1)
    // In the file from the start, nothing else on the title: the first save leaves the text alone.
    const written = DOC.replace('### What riders ask for {reveal}', title)
    await ev((d) => { window.mount(d) }, written)
    await page.waitForFunction(() => window.titlePictures('What riders ask for')[0] === 1)
    assert.equal(await ev(() => window.saveTidy()), false, 'nothing to tidy')
    assert.equal(await text(), written)
    // With an id line already under the title, and a group after the icon.
    const withId = DOC.replace('### What riders ask for {reveal}', title + ' {reveal}\n{id=t4itm}')
    await ev((d) => { window.mount(d) }, withId)
    assert.equal(await ev(() => window.saveTidy()), true)
    assert.deepEqual((await text()).split('\n').slice(4, 6), [title, '{reveal}{id=t4itm}'])
    await page.waitForFunction(() => window.titlePictures('What riders ask for')[0] === 1)
  })

  await check('a line that takes no icon: the message, nothing changed, and it goes by itself', async () => {
    await open(at('![picture]', 3))
    const note = page.locator('[data-plain-icon-note]')
    await note.waitFor()
    assert.match(await note.textContent(), /^Icons go on titles, paragraphs and list items\./)
    assert.equal(await picker.count(), 0)
    assert.equal(await text(), DOC)
    assert.equal(await ev(() => window.editorFocused()), true, 'the editor keeps the focus')
    const box = await note.boundingBox()
    const line = await ev(() => window.lineRect())
    assert.ok(box.y >= line.bottom && box.y - line.bottom < 16, 'the message is just under the caret\'s line')
    await page.waitForTimeout(1500)
    assert.equal(await note.count(), 1, 'still there after a second and a half')
    await note.waitFor({ state: 'detached', timeout: 2500 })
    assert.equal(await text(), DOC)
    assert.equal(await ev(() => window.undoDepth()), 0)
    // A section title: the same message, with its own reason.
    await open(at('## How it works', 5))
    await note.waitFor()
    assert.match(await note.textContent(), /section title/)
    assert.equal(await text(), DOC)
  })

  await check('an icon put on right after typing is its own Undo step', async () => {
    // Typed at the end of the line and the icon inserted at once, so the two changes are adjacent
    // and within CodeMirror's group delay: the icon write is the one that would join the typing.
    const end = at('- Bikes that are there when I arrive') + '- Bikes that are there when I arrive'.length
    await fresh()
    await ev((p) => window.caret(p), end)
    await page.keyboard.type('Q')
    await page.keyboard.press(`${mod}+i`)
    await picker.waitFor()
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length > 0)
    const icon = await active()
    assert.ok(icon && icon.startsWith('lucide:'), 'the picker highlights an icon')
    await page.keyboard.press('Enter')
    await picker.waitFor({ state: 'detached' })
    const typed = DOC.replace('- Bikes that are there when I arrive', '- Bikes that are there when I arriveQ')
    assert.equal(await text(), typed.replace('arriveQ', `arriveQ {icon=${icon}}`))
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await text(), typed, 'one Undo takes the icon and keeps the typed character')
    assert.equal(await ev(() => window.undoDepth()), 1)
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await text(), DOC, 'the second Undo takes the typed character')
    assert.equal(await ev(() => window.undoDepth()), 0)
  })

  await check('after the query changes, Enter cannot choose an icon from the earlier search', async () => {
    await open(at('- Bikes', 4))
    await picker.waitFor()
    await page.keyboard.type('sta')
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length === 4)
    await search.fill('sun')
    await page.keyboard.press('Enter')
    assert.equal(await text(), DOC, 'Enter on the results of “sta” inserts nothing while “sun” is searched')
    assert.equal(await picker.count(), 1, 'the panel stays open')
    await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length === 1)
    assert.deepEqual(await cells(), ['lucide:sun'])
    await page.keyboard.press('Enter')
    await picker.waitFor({ state: 'detached' })
    assert.equal(await text(), DOC.replace('- Bikes that are there when I arrive', '- Bikes that are there when I arrive {icon=lucide:sun}'))
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await text(), DOC)
  })

  assert.deepEqual(await ev(() => window.toasts), [], 'no warning was raised')
  caught = await ev(() => window.__caught)
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

assert.deepEqual(errors, [], 'no page errors')
assert.deepEqual(caught, [], 'no exception that CodeMirror caught')
if (failed.length) {
  console.error(`test:plain-view-icon-picker: ${failed.length} failed`)
  for (const f of failed) console.error('  - ' + f)
  process.exit(1)
}
console.log('test:plain-view-icon-picker: passed')
