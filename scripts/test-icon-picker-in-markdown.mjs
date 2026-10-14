// test:icon-picker-in-markdown — Command-I and "Insert icon…" work in the Markdown tab as in Plain.
//
// The same page as test:plain-view-icon-picker (the real picker, its hook and the editor's side of
// it, bundled for chrome-headless-shell), with the editor mounted in either tab. The workspace's
// gate (WorkspaceLayout.tsx) no longer looks at the tab, so the hook is all that runs in both.
//   - the command is in the registry, offered from the Insert menu and the palette, with its key
//     bound to the one command, and the workspace's gate does not look at the tab;
//   - for a title, a paragraph and a list row, setting, replacing and removing an icon through
//     Command-I in the Markdown tab gives the same text as in Plain, in ONE change;
//   - ONE Undo gives back the text; the caret stays;
//   - a frontmatter line, a fence line, a comment and a blank line get the verbs' message in
//     Markdown and change nothing (the same message as Plain's where Plain's caret does not move).
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { lineIconState } from '../src/shared/icon-verbs.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-icon-picker-in-markdown-'))
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

window.mount = (doc, mode) => {
  document.getElementById('host').innerHTML = ''
  window.transactions.length = 0
  view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [
      history(), markdown({ base: markdownLanguage }), tokenProtectExtension(), appKeyState(),
      keymap.of([...editorBaseKeymap]), Prec.highest(keymap.of(buildEditorKeyBindings())),
      viewModeExtension(mode, { iconSvg: async () => STAR }), EditorView.lineWrapping, failOnCaughtExceptions(),
      EditorView.updateListener.of((update) => {
        for (const tr of update.transactions) if (tr.docChanged) { let n = 0; tr.changes.iterChanges(() => { n += 1 }); window.transactions.push(n) }
      })
    ]
  }) })
  view.focus()
  return window.__v = view
}
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
  '---',                                     // 0
  'title: Bike share',                       // 1
  '---',                                     // 2
  '# Bike share',                            // 3
  '',
  '### What riders ask for {reveal}',        // 5
  '- Bikes that are there when I arrive',    // 6
  '- A safe lane {icon=lucide:route}',       // 7
  '',
  'A paragraph that starts here',            // 9
  'and ends here.',                          // 10
  '',
  '<!-- a comment -->',                      // 12
  '',
  '```js',                                   // 14
  'const a = 1',                             // 15
  '```',
  '',
  '::: notes',                               // 18
  'A note.',
  ':::',
  ''
].join('\n')
const lineStart = (n) => DOC.split('\n').slice(0, n).join('\n').length + (n ? 1 : 0)

const { COMMAND_REGISTRY, toolbarCommands, paletteCommands } = await import(new URL('../src/shared/command-registry.ts', import.meta.url))
const { SHORTCUT_REGISTRY } = await import(new URL('../src/shared/shortcut-registry.ts', import.meta.url))
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const browser = await chromium.launch()
const errors = []
const failed = []
let caught = []
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  page.on('pageerror', (e) => errors.push(String(e)))
  const html = `<!doctype html><style>${readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')}</style><div id="host" style="width:900px;height:500px"></div><div id="react"></div>`
  await page.route('http://talkweaver.test/', (route) => route.fulfill({ contentType: 'text/html', body: html }))
  await page.goto('http://talkweaver.test/')
  await page.addScriptTag({ path: outfile })
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const picker = page.locator('[data-plain-icon-picker]')
  const search = page.locator('[data-plain-icon-search]')
  const check = async (label, fn) => {
    try { await fn() } catch (e) { failed.push(`${label}: ${String(e.message).split('\n')[0]}${e.actual !== undefined ? ' | got ' + JSON.stringify(e.actual) + ' | wanted ' + JSON.stringify(e.expected) : ''}`) }
  }
  /** Command-I at the start of `line`, in `mode`; what the text, the transactions, the toasts and the Undo give. */
  const run = async (mode, line, finish) => {
    if (await picker.count()) { await search.press('Escape'); await picker.waitFor({ state: 'detached' }) }
    await ev(([d, m]) => { window.toasts.length = 0; window.mount(d, m) }, [DOC, mode])
    await ev((p) => window.caret(p), lineStart(line))
    await page.keyboard.press(`${mod}+i`)
    const opened = await Promise.race([
      picker.waitFor({ timeout: 8000 }).then(() => true),
      page.waitForFunction(() => document.querySelector('[data-plain-icon-note]'), null, { timeout: 8000 }).then(() => false)
    ])
    const out = { opened, message: null, text: DOC, transactions: [], afterUndo: null, caret: null }
    if (opened) {
      await page.waitForFunction(() => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length > 0)
      await finish()
      await picker.waitFor({ state: 'detached' })
      out.text = await ev(() => window.docText())
      out.transactions = await ev(() => window.transactions.slice())
      out.caret = await ev(() => window.sel())
      await page.keyboard.press(`${mod}+z`)
      out.afterUndo = await ev(() => window.docText())
    } else {
      out.message = await ev(() => document.querySelector('[data-plain-icon-note]').textContent)
      out.text = await ev(() => window.docText())
    }
    return out
  }
  await ev(() => window.localStorage.clear())
  const pick = (name) => async () => { await search.fill(name); await page.waitForFunction((n) => document.querySelectorAll('[data-plain-icon-picker] [data-icon-key]').length === 1, name); await page.keyboard.press('Enter') }
  const remove = async () => { await page.locator('[data-plain-icon-remove]').click() }

  await check('the command is in the registry, the Insert menu and the palette, with its key', async () => {
    const command = COMMAND_REGISTRY.find((c) => c.id === 'icon-picker')
    assert.equal(command.label, 'Insert icon…')
    assert.equal(command.scope, 'app', 'an app command: no tab gates it')
    assert.ok(toolbarCommands('insert').some((c) => c.id === 'icon-picker'), 'in the Insert menu')
    assert.ok(paletteCommands().some((c) => c.id === 'icon-picker'), 'in the palette')
    const key = SHORTCUT_REGISTRY.find((k) => k.id === 'app.icon-picker')
    assert.equal(key.keys, '⌘I', 'Command-I is the one command’s key')
  })
  await check('the workspace does not gate the command on the tab', async () => {
    const source = readFileSync(join(root, 'src/renderer/src/components/WorkspaceLayout.tsx'), 'utf8')
    const gate = source.split('\n').find((l) => l.includes('plainIcon.toggle()'))
    assert.ok(gate && !gate.includes('editorViewMode'), gate)
  })

  const cases = [
    ['title: set', 5, pick('zap'), 'zap'],
    ['paragraph: set', 9, pick('zap'), 'zap'],
    ['list row: set', 6, pick('zap'), 'zap'],
    ['list row: replace', 7, pick('zap'), 'zap'],
    ['list row: remove', 7, remove, null]
  ]
  for (const [label, line, finish, icon] of cases) {
    await check(`${label}: Markdown gives Plain's text, in one change, and one Undo restores it`, async () => {
      const plain = await run('plain', line, finish)
      const md = await run('markdown', line, finish)
      assert.equal(md.opened, true, 'the picker opens in Markdown')
      assert.notEqual(md.text, DOC, 'the text changed')
      assert.equal(md.text, plain.text, 'the same text as in Plain')
      assert.deepEqual(md.transactions, [1], 'one change')
      assert.deepEqual(md.caret, plain.caret, 'the caret is where Plain leaves it')
      assert.equal(md.afterUndo, DOC, 'one Undo restores the text')
      // A paragraph takes its token on its last line.
      if (icon) assert.ok(md.text.includes(`{icon=lucide:${icon}}`), 'the token is in the text')
      else assert.ok(!md.text.split('\n')[line].includes('{icon='), 'the token is gone')
    })
  }
  // The Plain tab moves a caret out of hidden lines (the frontmatter) before Command-I is read, so
  // the refusal is compared with the verbs' own words, not with Plain's.
  for (const [label, line] of [['frontmatter', 1], ['fence', 15], ['comment', 12], ['blank line', 4]]) {
    await check(`${label}: Markdown refuses with the verbs' message and changes nothing`, async () => {
      const state = lineIconState(DOC, line)
      assert.equal(state.ok, false)
      const md = await run('markdown', line, async () => {})
      assert.equal(md.opened, false, 'Markdown refuses')
      assert.ok(md.message.startsWith('Icons go on titles, paragraphs and list items.'), 'the message')
      assert.ok(md.message.includes(state.detail), 'the verbs’ detail is in the message')
      assert.equal(md.text, DOC, 'nothing changed')
    })
  }
  await check('the same refusal in both tabs where Plain does not move the caret', async () => {
    const plain = await run('plain', 12, async () => {})
    const md = await run('markdown', 12, async () => {})
    assert.equal(plain.opened, false)
    assert.equal(md.message, plain.message, 'the same message')
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
  console.error(`test:icon-picker-in-markdown: ${failed.length} failed`)
  for (const f of failed) console.error('  - ' + f)
  process.exit(1)
}
console.log('test:icon-picker-in-markdown: passed')
