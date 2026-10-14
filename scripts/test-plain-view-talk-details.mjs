// test:plain-view-talk-details — plain editing view ticket 06 (spec T11, empty-slide placeholders).
//
// The real extensions (the table's own, plus the Plain view), bundled for chrome-headless-shell:
//   - Plain: the front matter is the Talk details panel, closed to one line by default ("event · date",
//     else the first two set fields, "Talk details" alone with none); no table, no `---` lines;
//   - open: Subtitle, Speaker, Event, Date as fields; a field edit rewrites its line, one undo takes it back;
//     clearing removes the line; a key with no field (title, outline_version) stays and is listed read-only;
//   - an alias spelling in the file (accent:) is edited in place; the panel keeps focus across a commit;
//   - no front matter: the closed panel reads "Talk details"; adding a field writes a block at the top;
//   - the caret cannot rest in the front matter (so typing cannot land in it); Backspace at the title's start does nothing; Escape in a field returns focus;
//   - Markdown mode shows today's table (and no panel); switching modes swaps them;
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
import { setTalkDetailsOpen } from './src/renderer/src/extensions/plainView/talkDetails.ts'
import { frontmatterTableExtension } from './src/renderer/src/extensions/frontmatterTable.ts'

const compartment = new Compartment()
window.mount = (doc, mode) => {
  setTalkDetailsOpen(false)
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
  const fill = async (key, value) => { const loc = page.locator(`[data-td-key="${key}"] .cm-td-input`); await loc.fill(value); await loc.press('Enter') }

  // Closed by default, one line, no table.
  await open(FM)
  assert.equal(await q('.cm-talk-details'), 1, 'the panel shows in Plain')
  assert.equal(await q('.cm-frontmatter-table'), 0, 'no table in Plain')
  assert.equal(await panelText('.cm-td-title'), 'Talk details:')
  assert.equal(await panelText('.cm-td-summary'), 'Regional transport forum · 14 May 2026')
  assert.equal(await visible('.cm-td-body'), false, 'closed: fields not shown')
  assert.equal(await ev(() => document.body.textContent.includes('---')), false, 'no --- lines appear')

  // Summary falls back to the first two set fields; none = "Talk details" alone.
  await open('---\nsubtitle: A\nauthor: B\ndate: C\n---\n# T\n')
  assert.equal(await panelText('.cm-td-summary'), 'A · B')
  await open('---\ntitle: T\n---\n# T\n')
  assert.equal(await panelText('.cm-td-title'), 'Talk details')
  assert.equal(await panelText('.cm-td-summary'), '')

  // Open: fields; Speaker is the author line.
  await open(FM)
  await page.locator('.cm-td-toggle').click()
  assert.equal(await visible('.cm-td-body'), true, 'opened')
  assert.equal(await panelText('.cm-td-title'), 'Talk details')
  assert.deepEqual(await ev(() => [...document.querySelectorAll('.cm-td-body > .cm-td-row')].map((r) => r.querySelector('.cm-td-label').textContent + '=' + r.querySelector('input').value)),
    ['Subtitle=What a decade of trip data shows', 'Speaker=City Transport Team', 'Event=Regional transport forum', 'Date=14 May 2026'])
  assert.equal(await visible('.cm-td-more'), false, 'More is closed')
  await page.locator('.cm-td-more-toggle').click()
  assert.equal(await ev(() => document.querySelector('[data-td-key="colour"] select').value), 'cobalt', 'the accent spelling shows as Colour')
  assert.deepEqual(await ev(() => [...document.querySelectorAll('.cm-td-other')].map((e) => e.textContent)), ['title"Ten years of public bike hire"'.replace('"Ten years of public bike hire"', 'Ten years of public bike hire'), 'outline_version2'], 'keys without a field are listed read-only')

  // Edit: one change, the line rewritten, the rest untouched; one undo reverses it.
  await fill('event', 'Annual forum')
  assert.equal(await text(), FM.replace('event: Regional transport forum', 'event: Annual forum'))
  await ev(() => window.undo())
  assert.equal(await text(), FM, 'one undo takes the edit back')
  assert.equal(await page.locator('[data-td-key="event"] input').inputValue(), 'Regional transport forum', 'the field follows the undo')
  // Alias edited in place; clearing removes the line.
  await page.locator('[data-td-key="colour"] select').selectOption('emerald')
  assert.ok((await text()).includes('\naccent: emerald\n') && !(await text()).includes('colour:'), 'accent edited in place')
  await fill('subtitle', '')
  assert.ok(!(await text()).includes('subtitle:'), 'clearing a field removes its line')
  assert.ok((await text()).includes('title: "Ten years of public bike hire"') && (await text()).includes('outline_version: 2'), 'other keys kept')
  // Tab after a commit lands in the next field (the panel is not rebuilt under focus).
  await open(FM)
  await page.locator('.cm-td-toggle').click()
  await page.locator('[data-td-key="author"] input').fill('Someone Else')
  await page.keyboard.press('Tab')
  assert.equal(await ev(() => document.activeElement?.closest('[data-td-key]')?.dataset.tdKey), 'event', 'Tab moved on to Event')
  assert.ok((await text()).includes('author: Someone Else'))
  // Escape returns focus to the editor; the panel stays open.
  await page.keyboard.press('Escape')
  assert.equal(await ev(() => window.__v.hasFocus), true, 'Escape returns focus to the editor')
  assert.equal(await visible('.cm-td-body'), true)
  // Keyboard: Enter on the summary toggles.
  await page.locator('.cm-td-toggle').focus()
  await page.keyboard.press('Enter')
  assert.equal(await visible('.cm-td-body'), false, 'Enter closes the panel')
  await page.keyboard.press('Space')
  assert.equal(await visible('.cm-td-body'), true, 'Space opens it again')

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

  // No front matter: closed panel; adding a field writes a block at the top.
  await open('# Talk\n\n## One\n')
  assert.equal(await q('.cm-talk-details'), 1)
  assert.equal(await panelText('.cm-td-title'), 'Talk details')
  await page.locator('.cm-td-toggle').click()
  await fill('event', 'Forum')
  assert.equal(await text(), '---\nevent: Forum\n---\n\n# Talk\n\n## One\n')
  assert.equal(await q('.cm-talk-details'), 1)

  // Raw toggle: the panel gives way to the text; table button flips back.
  await open(FM)
  await page.locator('.cm-td-toggle').click()
  await page.locator('.cm-td-raw').dispatchEvent('mousedown')
  assert.equal(await q('.cm-talk-details'), 0, 'raw: no panel')
  assert.equal(await ev(() => window.lineText(1)).then((t) => t.startsWith('---')), true, 'raw: the lines show')

  // Markdown mode keeps today's table; modes swap without a document change.
  await open(FM, 'markdown')
  assert.equal(await q('.cm-frontmatter-table'), 1, 'Markdown: the table')
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
