// test:plain-view-talk-details — plain editing view ticket 06 (spec T11, empty-slide placeholders), changed by house rule R11.
//
// The real extensions (the table's own, plus the Plain view), bundled for chrome-headless-shell:
//   - Plain: the front matter is the Talk details LINE, one line ("event · date", else the first two set fields, "Talk details"
//     alone with none) that links to the Talk tab of the right sidebar, where a talk's details are edited; it holds no field and
//     writes nothing; no table, no `---` lines; the link sends the event the Talk menu's Metadata… sends;
//   - the caret cannot rest in the front matter (so typing cannot land in it); Backspace at the title's start does nothing; Escape in the line returns focus;
//   - the raw button shows the front matter as text; the table button flips back;
//   - Markdown mode shows the table (with its "Edit in the Talk tab" action) and no line; switching modes swaps them;
//   - placeholders: "Slide title" after an empty heading; the body hint on the slide's empty body; they vanish
//     with the first character, are never text, and do not exist in Markdown mode.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-details-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, historyKeymap, defaultKeymap, undo } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { frontmatterTableExtension } from './src/renderer/src/extensions/frontmatterTable.ts'

const compartment = new Compartment()
window.mount = (doc, mode) => {
  document.getElementById('host').innerHTML = ''
  return window.__v = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [EditorView.lineWrapping, history(), markdown({ base: markdownLanguage, codeLanguages: languages }), keymap.of(historyKeymap), keymap.of(defaultKeymap),
      frontmatterTableExtension(), compartment.of(viewModeExtension(mode, {}))]
  }) })
}
window.setMode = (mode) => window.__v.dispatch({ effects: compartment.reconfigure(viewModeExtension(mode, {})) })
window.docText = () => window.__v.state.doc.toString()
window.caret = (pos, event) => window.__v.dispatch({ selection: EditorSelection.cursor(pos), ...(event ? { userEvent: event } : {}) })
window.head = () => window.__v.state.selection.main.head
window.undo = () => undo(window.__v)
window.type = (text) => window.__v.dispatch({ ...window.__v.state.replaceSelection(text), userEvent: 'input.type' })
window.lineText = (n) => { const v = window.__v; const { node } = v.domAtPos(v.state.doc.line(n).from); return (node.nodeType === 1 ? node : node.parentElement).closest('.cm-line')?.textContent }
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const FM = [
  '---',
  'title: "Ten years of public bike hire"',
  'subtitle: "What a decade of trip data shows"',
  'event: Regional transport forum',
  'author: City Transport Team',
  'date: 14 May 2026',
  'accent: cobalt',
  'outline_version: 2',
  '---',
  '# Ten years of public bike hire',
  '',
  '## The decade in numbers',
  ''
].join('\n')

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.setContent('<div id="host" style="width:800px;height:700px"></div>')
  await page.addScriptTag({ path: outfile })
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const open = (d, mode = 'plain') => ev(([d, m]) => { window.mount(d, m) }, [d, mode])
  const text = () => ev(() => window.docText())
  const q = (sel) => ev((s) => document.querySelectorAll(s).length, sel)
  const panelText = (sel) => ev((s) => document.querySelector(s)?.textContent ?? null, sel)
  const visible = (sel) => ev((s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 }, sel)
  // One line, a link, no fields, no table.
  await open(FM)
  assert.equal(await q('.cm-talk-details'), 1, 'the line shows in Plain')
  assert.equal(await q('.cm-frontmatter-table'), 0, 'no table in Plain')
  assert.equal(await panelText('.cm-td-title'), 'Talk details:')
  assert.equal(await panelText('.cm-td-summary'), 'Regional transport forum · 14 May 2026')
  assert.equal(await q('.cm-talk-details input, .cm-talk-details select, .cm-td-body'), 0, 'no field in the line')
  assert.equal(await ev(() => document.body.textContent.includes('---')), false, 'no --- lines appear')
  assert.equal(await panelText('.cm-td-go'), 'Edit in the Talk tab ›')

  // Summary falls back to the first two set fields; none = "Talk details" alone.
  await open('---\nsubtitle: A\nauthor: B\ndate: C\n---\n# T\n')
  assert.equal(await panelText('.cm-td-summary'), 'A · B')
  await open('---\ntitle: T\n---\n# T\n')
  assert.equal(await panelText('.cm-td-title'), 'Talk details')
  assert.equal(await panelText('.cm-td-summary'), '')

  // The link opens the Talk tab: it sends tw-open-metadata (what the Talk menu's Metadata… sends) and changes no text.
  await open(FM)
  await ev(() => { window.__opened = 0; window.addEventListener('tw-open-metadata', () => { window.__opened += 1 }) })
  await page.locator('[data-talk-details-link]').click()
  assert.equal(await ev(() => window.__opened), 1, 'the link sends the open-the-Talk-tab event once')
  assert.equal(await text(), FM, 'the line writes nothing')
  // The summary follows the text under it.
  await ev(([from, to]) => window.__v.dispatch({ changes: { from, to, insert: 'Annual forum' } }), [FM.indexOf('Regional'), FM.indexOf('Regional') + 'Regional transport forum'.length])
  assert.equal(await panelText('.cm-td-summary'), 'Annual forum · 14 May 2026')
  // Escape returns focus to the editor.
  await page.locator('[data-talk-details-link]').focus()
  await page.keyboard.press('Escape')
  assert.equal(await ev(() => window.__v.hasFocus), true, 'Escape returns focus to the editor')

  // Caret and Backspace keep out of the front matter.
  await open(FM)
  await ev(() => window.caret(5))
  assert.ok((await ev(() => window.head())) >= FM.indexOf('# Ten'), 'a caret set inside the front matter moves to the title line')
  await ev((p) => window.caret(p), FM.indexOf('# Ten'))
  await ev(() => window.__v.focus())
  await page.keyboard.press('Backspace') // a real key press: the rule is the key rule in guardKeys.ts
  assert.equal(await text(), FM, 'Backspace at the title start does nothing')
  await ev(() => window.caret(0))
  await ev(() => window.type('x'))
  assert.equal(await text(), FM.replace('# Ten', 'x# Ten'), 'a caret set at the top rests after the front matter, so typing lands there and the front matter is untouched')
  await ev(() => window.undo())
  assert.equal(await text(), FM)

  // No front matter: the line says "Talk details".
  await open('# Talk\n\n## One\n')
  assert.equal(await q('.cm-talk-details'), 1)
  assert.equal(await panelText('.cm-td-title'), 'Talk details')
  assert.equal(await text(), '# Talk\n\n## One\n', 'the line writes nothing, with or without front matter')

  // Raw toggle: the panel gives way to the text; table button flips back.
  await open(FM)
  await page.locator('.cm-td-raw').dispatchEvent('mousedown')
  assert.equal(await q('.cm-talk-details'), 0, 'raw: no panel')
  assert.equal(await ev(() => window.lineText(1)).then((t) => t.startsWith('---')), true, 'raw: the lines show')

  // Markdown mode keeps the table (and gives it the Edit action); modes swap without a document change.
  await open(FM, 'markdown')
  assert.equal(await q('.cm-frontmatter-table'), 1, 'Markdown: the table')
  assert.equal(await q('[data-fm-edit-in-tab]'), 1, 'Markdown: the table\'s Edit in the Talk tab action')
  assert.equal(await q('.cm-talk-details'), 0, 'Markdown: no panel')
  await ev(() => window.setMode('plain'))
  assert.equal(await q('.cm-talk-details'), 1)
  assert.equal(await q('.cm-frontmatter-table'), 0)
  await ev(() => window.setMode('markdown'))
  assert.equal(await q('.cm-frontmatter-table'), 1)
  assert.equal(await text(), FM)

  // Placeholders.
  const slides = '# Talk\n\n## One\nbody\n\n## \n'
  await open(slides)
  await ev(() => window.caret(0))
  assert.equal(await q('.cm-plain-placeholder'), 2, 'an empty slide: both hints')
  assert.deepEqual(await ev(() => [...document.querySelectorAll('.cm-plain-placeholder')].map((e) => e.textContent)), ['Slide title', 'Write, or press / to insert'])
  assert.equal(await text(), slides, 'never text in the file')
  assert.equal(await ev(() => getComputedStyle(document.querySelector('.cm-plain-placeholder')).userSelect), 'none')
  await ev(() => { const v = window.__v; window.caret(v.state.doc.length - 1); window.type('Next') })
  assert.equal(await q('.cm-plain-placeholder-title'), 0, 'the title hint goes with the first character')
  assert.deepEqual(await ev(() => [...document.querySelectorAll('.cm-plain-placeholder')].map((e) => e.textContent)), [], 'a titled slide with the caret elsewhere: quiet')
  await ev(() => window.caret(window.__v.state.doc.length - 1)) // end of "## Next"
  await ev(() => { window.type('\n') })
  assert.deepEqual(await ev(() => [...document.querySelectorAll('.cm-plain-placeholder')].map((e) => e.textContent)), ['Write, or press / to insert'], 'Enter after the title: the body hint under the caret')
  await ev(() => window.type('x'))
  assert.equal(await q('.cm-plain-placeholder'), 0, 'the body hint goes with the first character')
  // A section with a blank line under it, and a heading in a fence, are quiet.
  await open('# T\n\n## S\n{cards}\n\n### A\ntext\n\n```\n## \n```\n')
  await ev(() => window.caret(0))
  assert.equal(await q('.cm-plain-placeholder'), 0)
  // Markdown mode: none.
  await open(slides, 'markdown')
  assert.equal(await q('.cm-plain-placeholder'), 0, 'Markdown: no placeholders')

  console.log('plain view talk details and placeholders: ok')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
