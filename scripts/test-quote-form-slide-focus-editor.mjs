// test:quote-form-slide-focus-editor — quote forms ticket 14: the form of a typed link is written in Slide Focus.
//
// Found in the packaged app (13 October): in Slide Focus, on a quote slide whose last line is the source line, the link
// typed and the line left by Enter, Enter wrote no form, the caret came back onto the source line, and no later leaving
// wrote one either. The second Enter empties the list item the first one made; the focused slide then ends at the
// source line (focusScope.ts did not count a trailing empty line then), so the Slide Focus caret guard moved the caret
// back and rebuilt the Enter command's transaction from its changes, effects and user event. The mark that says "typed
// by a key" was an annotation, lost in that rebuild, and the link watch read the Enter as a program's change.
//
// Quote forms ticket 15, found in the packaged app the same day: at the end of a focused slide whose last line is its
// quotation, Enter, Enter put the caret on an empty line the focused editor did not draw, and what was typed next went
// in front of the slide's last line (a paragraph slide and a list slide did the same). focusScope.ts now counts an
// empty line begun at the end of the focused slide as a line of it (begunEmptyLine): it is drawn, the caret stands on
// it, and typing stays on it, as out of focus. The blank line above the next slide's title stays hidden.
// What a change that is not the user's can bring into the focused slide, and the random run, are in
// test-slide-focus-range-containment.mjs (the review round of ticket 15).
//
// The real quoteLinkFormExtension in a real CodeMirror editor in chrome-headless-shell (never the real Chrome), mounted
// as test-quote-form-typed-slide-editor.mjs mounts it, with focusScopeExtension() after the token guards as
// components/Editor.tsx has it. Focus is entered as the app enters it: the range is slideFocusModel's
// focusRangeForSlideLine for the slide's heading line, set by focusScope's setFocusRange (asserted below from the
// sources); it is left as Esc leaves it, setFocusRange(view, null). Typing is key presses, Enter the Enter key.
//
// The focused slide stands in three places: `last` (the last slide, the text ends with its last line), `middle`
// (another slide follows) and `notes` (a `:::notes` block follows the source line inside the slide: the source line is
// not the last line of the focused range).
//   K.  what the Slide Focus guard keeps of the Enter whose caret it moves (the statement ticket 14's fix stands on).
//       Since ticket 15 the second Enter under the slide's last line is no such Enter (its caret stays where it is put);
//       Enter in the title of a focused slide that has no line under its id line still is;
//   F1. the author there, the link typed after it, Enter, Enter: the form is written at the second Enter;
//   F2. the whole source line typed over the old one, Enter, Enter (the packaged app's sequence);
//   F3. a bare address or a source line typed under the quotation, lines of the slide after it: ArrowUp, Enter;
//   F4. the write itself in focus: the caret, the focused range, a slide with no id line (the layout line is made);
//   F5. leaving Slide Focus with the link typed and the caret still on its line;
//   Q.  Enter, Enter at the end of a quotation that ends the focused slide leaves it as outside focus, the caret on a
//       drawn line that takes typing (Q1 middle, Q2 last slide of the talk); with a paragraph of the slide below it, too (Q3);
//   G.  ticket 15: a line begun under the last line of the focused slide. G1 the quotation the last line: Enter,
//       Enter, a source line typed (the two reproductions: a slide in the middle, the last slide; and the last slide of
//       a file that ends with a line break), ArrowUp: the exact text, the form, one blank line above the next title,
//       the same text out of focus. G2 Shift-Enter there. G3 a paragraph slide, G4 a list slide (Enter, Enter).
//       G5 the caret cannot leave the begun line downwards and Delete there joins nothing. G6 the last line emptied;
//       the range a begun line gives when it is set from outside; a slide with two blank lines above the next title.
//       After every key (each letter typed is one) the lines drawn are the slide's own, the caret is on one of them,
//       no other slide is drawn, and the stored range is those lines, from the start of the first to the end of the last;
//   N1. a link put on the source line by a program in focus, then Enter, Enter by the user: no form;
//   N2. the link typed by the user and the two Enters' very changes made by a program (no mark), in focus: no form;
//   N3. the fourth review's reproduction (ticket 11, R10) in focus: no form;
//   M.  any edit of the user's counts (decided 13 October 2026, after the review of this ticket took a key command
//       that moves existing text for no typing). M1 the review's reproduction (Shift-Enter in the middle of a
//       quotation line), M2 the markdown Enter there, M4 Tab making `-Author <link>` an item, M7 Enter and
//       M8 Backspace on an empty marker: the form is written, drawn by the compiler, and one Cmd-Z takes the edit and
//       the form together. M3 Shift-Enter at the end of the line, M5 the list Enter in the middle of an item (a list:
//       no form), M6 Shift-Tab on a link that was there (no form). Each out of focus and in focus, with what the
//       change carries (user event, mark);
//   P.  each change of M1, M2, M4, M7, M8 made by a program (no user event, no mark), out of focus and in: no form;
//   C.  `tw-run-command` with `editor.quote-paragraph` (the command reached without a key press): what it does is
//       printed with the result.
// Every written form asserts the final text (the text as typed plus the form, nothing else), that the full compiler
// draws it with the quotation's words unchanged, and that no undo step leaves the form without its link. The cases
// that write also assert the text is the one the same keys leave out of Slide Focus.
// With ticket 14's fix taken out (the mark an annotation again) K fails. With ticket 15's taken out (focusScope.ts as
// it was) every G case fails, and so do K (the second Enter), F1 (last, middle), F2, F4 (no id line) and N2, each on
// where the caret is or on the lines drawn.
//
// QUOTE_FOCUS_REPORT=1 runs every case and lists the failures instead of stopping at the first (used to show which
// cases fail with the fix taken out). QUOTE_FOCUS_ONLY=<prefix> runs only the cases whose name starts so.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { stampMissingIds } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { WEB, compiledWords, compilerIn, drawnForm } from './lib/quote-drawn-form-slides.mjs'

const SHELL = join(homedir(), '.cache/puppeteer/chrome-headless-shell/mac_arm-146.0.7680.66/chrome-headless-shell-mac-arm64/chrome-headless-shell')
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-quote-form-slide-focus-'))
const outfile = join(dir, 'bundle.js')
const REPORT = process.env.QUOTE_FOCUS_REPORT === '1'
const ONLY = process.env.QUOTE_FOCUS_ONLY

// How the app enters and leaves Slide Focus is what this test does.
{
  const source = (path) => readFileSync(join(root, path), 'utf8')
  const layout = source('src/renderer/src/components/WorkspaceLayout.tsx')
  const enterFocus = layout.slice(layout.indexOf('const enterFocus = useCallback('), layout.indexOf('const enterFocusRef'))
  assert(/const range = focusRangeForSlideLine\(outlineContentRef\.current, lines\[idx\]\)/.test(enterFocus) && /setFocusRange\(range\)/.test(enterFocus), 'WorkspaceLayout enters focus with focusRangeForSlideLine of the slide\'s heading line')
  const exitFocus = layout.slice(layout.indexOf('const exitFocus = useCallback('), layout.indexOf('// Re-sync the scoped band after a compile'))
  assert(/setFocusRange\(null\)/.test(exitFocus), 'and leaves it by setting the range to null')
  // The route of a command run without a key press, which the page has a copy of (case C).
  const listed = layout.slice(layout.indexOf('const runListedCommand = useCallback('), layout.indexOf('const [paneState, setPaneState]'))
  assert(/shortcutById\(command\.shortcutId\)\.codes\[0\]/.test(listed) && /dispatchEvent\(new KeyboardEvent\('keydown', chordEventInit\(keys\)\)\)/.test(listed), 'WorkspaceLayout runs a listed command that has no handler by sending its key to the editor')
  assert(/window\.addEventListener\('tw-run-command', onRun\)/.test(layout), 'and tw-run-command runs a listed command')
  const editor = source('src/renderer/src/components/Editor.tsx')
  assert(/if \(v\) setFocusRange\(v, focusRange \?\? null\)/.test(editor), 'Editor.tsx hands the range to focusScope\'s setFocusRange')
  const mounted = editor.slice(editor.indexOf('historyCompartment.of(history())'), editor.indexOf('savedTextAdoption(),'))
  const order = ['quoteLinkFormExtension(', 'tokenProtectExtension(', 'focusScopeExtension()'].map((name) => mounted.indexOf(name))
  assert(order.every((at) => at >= 0) && order[0] < order[1] && order[1] < order[2], 'Editor.tsx mounts history, the link watch, the token guards, Slide Focus and the adoption in that order')
  // The fix adds or changes no transaction filter: there are three in the editor's extensions, as before.
  const filters = ['focusScope.ts', 'quoteLinkForm.ts', 'outliner.ts', 'quoteLinkFormSnapshots.ts', 'keyTypedMark.ts'].map((name) => (source(`src/renderer/src/extensions/${name}`).match(/EditorState\.(transactionFilter|changeFilter|transactionExtender)\.of\(/g) ?? []).length)
  // The mark has a file of its own (Slide Focus reads it too). Only outliner.ts's key commands attach it: no other file
  // of the app names `typedByKey`, and the effect type is not exported.
  const naming = readdirSync(join(root, 'src'), { recursive: true }).map(String).filter((path) => /\.(ts|tsx|mjs|js)$/.test(path) && source(join('src', path)).includes('typedByKey')).sort()
  assert.deepEqual(naming, ['renderer/src/extensions/keyTypedMark.ts', 'renderer/src/extensions/outliner.ts'], 'typedByKey is named in keyTypedMark.ts and outliner.ts alone')
  assert(!/export\s+(const|let|var)\s+keyTyped\b/.test(source('src/renderer/src/extensions/keyTypedMark.ts')), 'the effect type is not exported')
  assert.deepEqual(filters, [1, 1, 0, 0, 0], 'one filter in focusScope.ts, the paste filter in quoteLinkForm.ts, none in outliner.ts, the snapshots or the mark')
}

const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Prec, Transaction } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, undoDepth } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { quoteLinkFormExtension } from './src/renderer/src/extensions/quoteLinkForm.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { savedTextAdoption } from './src/renderer/src/extensions/savedTextAdoption.ts'
import { focusScopeExtension, setFocusRange, currentFocusRange } from './src/renderer/src/extensions/focusScope.ts'
import { focusRangeForSlideLine } from './src/renderer/src/components/slideFocusModel.ts'
import { continueList, leaveQuotation, newQuotationParagraph, enterFromHeading, enterFromProtectedLine, indentList, outdentList } from './src/renderer/src/extensions/outliner.ts'
import * as mark from './src/renderer/src/extensions/keyTypedMark.ts'
// The mark of the app's key commands as the link watch reads it (with the fix taken out: the annotation it was).
const isKeyTyped = mark.isKeyTyped ?? ((tr) => tr.annotation(mark.keyTyped) === true)
import { compiledQuoteAt } from './src/shared/quote-write-check.ts'
import { COMMAND_REGISTRY } from './src/shared/command-registry.ts'
import { shortcutById } from './src/shared/shortcut-registry.ts'
import { chordEventInit } from './src/shared/chord-event.ts'
let view = null
// WorkspaceLayout's tw-run-command listener and its runListedCommand, for a command with no handler of its own: the
// command is found in the registry and its key is sent to the editor as a keydown (the registry's key, no user's keymap).
window.addEventListener('tw-run-command', (event) => {
  const command = COMMAND_REGISTRY.find((candidate) => candidate.id === event.detail)
  if (!command) { window.ranCommand = 'no such command in the registry'; return }
  if (!command.shortcutId) { window.ranCommand = 'the command has no key'; return }
  const code = shortcutById(command.shortcutId).codes[0]
  if (!code) { window.ranCommand = 'the command has no key'; return }
  window.setTimeout(() => {
    const target = document.querySelector('.cm-content')
    target?.focus()
    ;(target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', chordEventInit(code)))
    window.ranCommand = 'the key ' + code + ' sent to the editor as a keydown'
  }, 0)
})
window.mount = (doc) => {
  if (view) view.destroy()
  let layouts = {}
  // The host's compile: the layout of the slide on every heading line of the text as it stands now.
  window.compiled = () => {
    const text = view.state.doc.toString()
    layouts = {}
    text.split('\\n').forEach((line, index) => { if (/^#{1,6}\\s/.test(line)) layouts[index + 1] = compiledQuoteAt(text, index + 1)?.layout })
  }
  // Every transaction with a change, as the editor took it (after the filters): what it carries.
  const seen = window.seen = []
  view = new EditorView({
    parent: document.getElementById('host'),
    state: EditorState.create({ doc, selection: EditorSelection.cursor(0), extensions: [
      Prec.highest(keymap.of([
        { key: 'Enter', run: (v) => enterFromHeading(v) || enterFromProtectedLine(v) || continueList(v) || leaveQuotation(v) },
        { key: 'Shift-Enter', run: newQuotationParagraph },
        { key: 'Tab', run: indentList },
        { key: 'Shift-Tab', run: outdentList }
      ])),
      history(),
      quoteLinkFormExtension(() => (line) => layouts[line]),
      markdown({ base: markdownLanguage }),
      tokenProtectExtension(),
      focusScopeExtension(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      savedTextAdoption(),
      EditorView.updateListener.of((update) => {
        for (const tr of update.transactions) if (tr.docChanged) seen.push({
          userEvent: tr.annotation(Transaction.userEvent) ?? null,
          keyTyped: isKeyTyped(tr),
          caretLine: tr.state.doc.lineAt(tr.state.selection.main.head).number
        })
      })
    ] })
  })
  view.focus()
  window.compiled()
}
window.docText = () => view.state.doc.toString()
window.caret = () => { const head = view.state.selection.main.head; const line = view.state.doc.lineAt(head); return { line: line.number, column: head - line.from } }
window.clickLine = (n) => { view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(n).to), userEvent: 'select.pointer' }); view.focus() }
// Slide Focus entered on the slide whose heading is on line n, as WorkspaceLayout's enterFocus and Editor.tsx do it.
window.enterFocus = (n) => {
  const range = focusRangeForSlideLine(view.state.doc.toString(), n)
  if (!range) return false
  setFocusRange(view, range)
  return true
}
// Esc: WorkspaceLayout's exitFocus.
window.leaveFocus = () => setFocusRange(view, null)
// What the editor draws: the first and the last line shown, and the lines of the text. Read from the rows alone (the
// document line each drawn row starts on), never from the stored range.
window.focused = () => {
  const rows = [...view.contentDOM.querySelectorAll('.cm-line')].map((row) => view.state.doc.lineAt(view.posAtDOM(row, 0)).number)
  return { first: rows[0], last: rows.at(-1), consecutive: rows.every((n, index) => n === rows[0] + index), lines: view.state.doc.lines }
}
// The stored range (the Slide Focus field, read through currentFocusRange): the lines it starts and ends on, and
// whether it starts at the start of the first and ends at the end of the last. null out of focus.
window.stored = () => {
  const range = currentFocusRange(view.state)
  if (!range) return null
  const [from, to] = [view.state.doc.lineAt(range.from), view.state.doc.lineAt(range.to)]
  return { first: from.number, last: to.number, fromStart: range.from === from.from, toEnd: range.to === to.to }
}
// The text of every line the editor draws.
window.drawn = () => [...view.contentDOM.querySelectorAll('.cm-line')].map((line) => line.textContent)
// Focus set on a range given in offsets (the e2e seam and the workspace's re-sync set one this way).
window.setRange = (range) => setFocusRange(view, range)
window.range = () => currentFocusRange(view.state)
// Transactions as a program makes them (no user event, no mark), one after another in the same task.
window.dispatchAll = (specs) => {
  for (const spec of specs) view.dispatch({ changes: spec.changes, selection: spec.cursor == null ? undefined : EditorSelection.cursor(spec.cursor) })
}
window.undoDepth = () => undoDepth(view.state)
window.blurEditor = () => { view.contentDOM.dispatchEvent(new FocusEvent('blur')) }
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const QUOTATION = '> Schemas are the building blocks of cognition.'
const TITLE = 'Focused quote'
const AUTHOR = '- Jane Author'
const NOTES = [':::notes', 'words for the speaker', ':::']
const PLACES = ['last', 'middle', 'notes']
/** The talk with the focused slide in `place`; `under` are the lines under its quotation (after one blank line); `id`: its id line. */
const talk = (place, under = [], id = true) => [
  '# Talk', '',
  '## Part one', '{id=p1}', '',
  '### First', '{id=s1}', '', '> Words that were there.', '', '- Someone https://example.org/there-all-along', '',
  `### ${TITLE}`, ...(id ? ['{id=fq}'] : []), '', QUOTATION, ...(under.length || place === 'notes' ? [''] : []), ...under, ...(place === 'notes' ? [...(under.length ? [''] : []), ...NOTES] : []),
  ...(place === 'last' ? [] : ['', '### After', '{id=s3}', '', 'A paragraph of the slide after.', ''])
].join('\n')
const lineOf = (text, line) => { const index = text.split('\n').indexOf(line); assert(index >= 0, `the text has the line "${line}"`); return index + 1 }
const endOf = (text, line) => text.split('\n').slice(0, lineOf(text, line)).join('\n').length
const withForm = (text, form = 'web') => { assert(text.includes('{id=fq}'), 'the text has {id=fq}'); return text.replace('{id=fq}', `{id=fq} {form=${form}}`) }

const compile = compilerIn(dir)
const browser = await chromium.launch({ executablePath: SHELL, headless: true })
const failures = []
/** What is recorded without being asserted (case C): printed with the result. */
const observed = []
let ran = 0
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.setContent('<div id="host"></div>')
  await page.addScriptTag({ path: outfile })
  const run = (fn, ...args) => page.evaluate(fn, ...args)
  const settle = () => run(() => new Promise((resolve) => setTimeout(resolve, 20)))
  const text = () => run(() => window.docText())
  const type = (words) => page.keyboard.type(words)
  const press = async (key, times = 1) => { for (let n = 0; n < times; n += 1) await page.keyboard.press(key) }
  const enter = async () => { await press('Enter'); await settle() }
  const click = async (line) => { await run((n) => window.clickLine(n), line); await settle() }
  const caret = () => run(() => window.caret())
  const compiled = () => run(() => window.compiled())
  /** The focused slide as drawn (first and last line), null out of focus; the stored range is asserted to be those lines, from the start of the first to the end of the last. */
  const shown = async () => {
    const [rows, stored] = [await run(() => window.focused()), await run(() => window.stored())]
    assert.equal(rows.consecutive, true, 'the lines drawn are consecutive')
    if (!stored) { assert.deepEqual([rows.first, rows.last], [1, rows.lines], 'out of focus no range is stored and all of the text is drawn'); return null }
    assert.deepEqual(stored, { first: rows.first, last: rows.last, fromStart: true, toEnd: true }, `the stored range is the lines drawn (${rows.first} to ${rows.last}), from the start of the first to the end of the last`)
    return { first: rows.first, last: rows.last }
  }
  const check = async (name, body) => {
    if (ONLY && !name.startsWith(ONLY)) return
    ran += 1
    errors.length = 0
    try {
      await body()
      assert.deepEqual(errors, [], 'the editor logged no error')
    } catch (error) {
      if (!REPORT) throw new Error(`${name}: ${error.message}`, { cause: error })
      failures.push(`${name}: ${String(error.message).split('\n')[0]}`)
    }
  }
  /** Mount the talk and focus the slide (`focus: false`: the same keys out of focus). The slide's lines are the focused range. */
  const begin = async (doc, focus = true) => {
    await run((d) => window.mount(d), doc)
    if (!focus) return
    const heading = lineOf(doc, `### ${TITLE}`)
    assert.equal(await run((n) => window.enterFocus(n), heading), true, 'the slide is focused')
    const lines = doc.split('\n')
    let last = lines.findIndex((line, index) => index > heading && /^#{1,6}\s/.test(line))
    last = last < 0 ? lines.length : last
    while (lines[last - 1].trim() === '') last -= 1
    assert.deepEqual(await shown(), { first: heading, last }, 'the focused range is the slide, to its last line that is not empty')
  }
  const typedWords = compiledWords((await compile(talk('middle'))).slides.find((slide) => slide.id === 'fq'))
  assert(typedWords.length > 0, 'the focused slide has a quotation')
  /** `written` is `typed` with the form on the focused slide's layout line, nothing else changed; the full compiler draws it. */
  const assertWritten = async (typed, written, link = WEB) => {
    assert.equal(written, withForm(typed), 'the text is the text as typed with the form on the slide\'s layout line: nothing else changed')
    assert.equal(drawnForm(await compile(written), 'fq', 'web', { wordsBefore: typedWords, link }), '', 'the full compiler draws the written form, citing the typed link, the quotation\'s words unchanged')
  }
  const assertNoForm = async (what) => assert.equal((await text()).match(/form=/g), null, `${what}: no form is written`)
  /** Cmd-Z, step by step, to the start: the form never stands without its link. */
  const undoAll = async (link = WEB) => {
    let steps = 0
    while (await run(() => window.undoDepth()) > 0) {
      await press('ControlOrMeta+z'); await settle()
      const now = await text()
      const slide = now.slice(now.indexOf(`### ${TITLE}`)).split(/\n#{1,6}\s/)[0]
      assert(!(slide.includes('form=') && !slide.includes(link)), `undo step ${steps + 1}: the form never stands without its link: ${JSON.stringify(slide)}`)
      steps += 1
      assert(steps < 200, 'the undo history ends')
    }
    return steps
  }
  /** Leave the line every other way too: nothing more is written. */
  const leaveEveryWay = async (expected, what) => {
    await press('ArrowUp'); await settle()
    await click(lineOf(await text(), QUOTATION))
    await run(() => window.blurEditor()); await settle()
    assert.equal(await text(), expected, `${what}: the caret moved, a click elsewhere, the editor left`)
  }

  const sourceLine = `${AUTHOR} ${WEB}`
  const insertAfter = (outline, line, added) => { const lines = outline.split('\n'); lines.splice(lineOf(outline, line), 0, added); return lines.join('\n') }
  /** The author's line is there; the link is typed after it and the line left by Enter, Enter. What the keys leave. */
  const linkEnterEnter = async (place, focus) => {
    const doc = talk(place, [AUTHOR])
    await begin(doc, focus)
    await click(lineOf(doc, AUTHOR))
    await type(` ${WEB}`)
    await compiled()
    const typed = await text()
    assert.equal(typed, talk(place, [sourceLine]), 'the link is typed after the author')
    await enter()
    assert.equal(await text(), insertAfter(typed, sourceLine, '- '), 'the first Enter continues the list under the source line, and no form is written')
    const seenAtFirst = await run(() => window.seen.length)
    await enter()
    return { doc, typed, written: await text(), caret: await caret(), focused: await shown(), second: (await run(() => window.seen))[seenAtFirst] }
  }

  // ── K. What the Slide Focus guard keeps of the Enter whose caret it moves ──
  await check('K. an Enter whose caret Slide Focus moves back keeps its mark (Enter in the title of a slide with no line under its id line)', async () => {
    // The new empty line is made above the next slide's title, outside the focused slide: the caret is moved back.
    const doc = ['# Talk', '', `### ${TITLE}`, '{id=fq}', '### After', '{id=s3}', '', 'A paragraph of the slide after.', ''].join('\n')
    const heading = lineOf(doc, `### ${TITLE}`)
    const keys = async (focus) => {
      await begin(doc, focus)
      await click(heading)
      const from = await run(() => window.seen.length)
      await enter()
      assert.equal(await text(), doc.replace('### After', '\n### After'), 'the Enter makes an empty line above the next slide\'s title')
      return (await run(() => window.seen))[from]
    }
    const plain = await keys(false)
    assert.deepEqual([plain.userEvent, plain.keyTyped, plain.caretLine], [null, true, heading + 2], 'out of focus: the app\'s Enter has no user event, is marked typed by a key, and leaves the caret on the new line')
    const focused = await keys(true)
    assert.equal(focused.caretLine, heading + 1, 'in focus the caret is moved back onto the id line: Slide Focus rebuilt the Enter\'s transaction')
    assert.equal(focused.userEvent, null, 'the rebuilt transaction has no user event, as the Enter had none')
    assert.equal(focused.keyTyped, true, 'and it still says it was typed by a key (the mark is an effect; the rebuild keeps the changes and the effects)')
    assert.deepEqual(await run(() => window.drawn()), [`### ${TITLE}`, '{id=fq}'], 'the focused slide is drawn as it was')
  })
  await check('K. the second Enter under a source line that ends the focused slide is taken as it is made: the mark, the caret on the emptied line', async () => {
    const plain = await linkEnterEnter('last', false)
    const focused = await linkEnterEnter('last', true)
    const source = lineOf(plain.typed, sourceLine)
    for (const second of [plain.second, focused.second]) assert.deepEqual([second.userEvent, second.keyTyped, second.caretLine], [null, true, source + 1], 'the app\'s Enter has no user event, is marked typed by a key, and leaves the caret on the emptied line')
  })

  // ── F1. The author there, the link typed after it, Enter, Enter ──
  for (const place of PLACES) await check(`F1. focus, the slide ${place}: the link typed after the author, Enter, Enter: the form is written at the second Enter`, async () => {
    const plain = await linkEnterEnter(place, false)
    const { doc, typed, written, caret: at, focused } = await linkEnterEnter(place, true)
    const emptied = insertAfter(typed, sourceLine, '')
    await assertWritten(emptied, written)
    assert.equal(written, plain.written, 'the text is the one the same keys leave out of Slide Focus')
    const source = lineOf(written, sourceLine)
    // The emptied line under the source line is a line of the focused slide, at its end too (ticket 15).
    assert.deepEqual(at, { line: source + 1, column: 0 }, 'the caret is on the emptied line, as out of focus')
    assert.deepEqual(at, plain.caret, 'where the same keys leave it out of focus')
    assert.deepEqual(focused, { first: lineOf(written, `### ${TITLE}`), last: place === 'notes' ? lineOf(written, NOTES[2]) : source + 1 }, 'the focused slide is drawn to its last line (the emptied line when it ends the slide), the written layout line in it')
    await leaveEveryWay(written, 'the line left again')
    assert(await undoAll() > 0, 'there were steps to undo')
    assert.equal(await text(), doc, 'all undone: the text is as it was')
  })

  // ── F2. The whole source line typed over the author's line, as in the packaged app ──
  await check('F2. focus, the slide last: the whole source line typed over the old one, Enter, Enter: the form is written', async () => {
    const link = 'https://example.org/x'
    const doc = talk('last', [AUTHOR])
    await begin(doc)
    await click(lineOf(doc, AUTHOR))
    await press('Shift+Home')
    await type(`- Focus Author ${link}`)
    await compiled()
    const typed = await text()
    assert.equal(typed, talk('last', [`- Focus Author ${link}`]), 'the source line is typed over the old one')
    await enter(); await enter()
    const written = await text()
    await assertWritten(`${typed}\n`, written, link)
    assert.deepEqual(await caret(), { line: lineOf(written, `- Focus Author ${link}`) + 1, column: 0 }, 'the caret is on the emptied line under the source line')
    await leaveEveryWay(written, 'the line left again')
    await undoAll(link)
    assert.equal(await text(), doc, 'all undone: the text is as it was')
  })

  // ── F3. A line typed under the quotation (two Enters out of the quotation), lines of the slide after it ──
  for (const [name, tail, leave] of [
    ['a bare address, ArrowUp', WEB, 'ArrowUp'],
    ['a bare address, Enter', WEB, 'Enter'],
    ['a source line, ArrowUp', sourceLine, 'ArrowUp'],
    ['a source line, Enter, Enter', sourceLine, 'Enter Enter']
  ]) await check(`F3. focus, lines of the slide after the link's line: ${name}: the form is written`, async () => {
    const doc = talk('notes')
    const keys = async (focus) => {
      await begin(doc, focus)
      await click(lineOf(doc, QUOTATION))
      await enter(); await enter()
      await type(tail)
      await compiled()
      const typed = await text()
      assert.equal(typed, talk('notes', [tail]), 'the line is typed on a line of its own, one blank line under the quotation')
      if (leave === 'ArrowUp') { await press('ArrowUp'); await settle() } else { await enter(); if (leave === 'Enter Enter') await enter() }
      return { typed, written: await text(), caret: await caret() }
    }
    const plain = await keys(false)
    const { typed, written, caret: at } = await keys(true)
    await assertWritten(leave === 'ArrowUp' ? typed : insertAfter(typed, tail, ''), written)
    assert.equal(written, plain.written, 'the text is the one the same keys leave out of Slide Focus')
    assert.deepEqual(at, plain.caret, 'and so is the caret')
    await leaveEveryWay(written, 'the line left again')
    await undoAll()
    assert.equal(await text(), doc, 'all undone: the text is as it was')
  })

  // ── F4. The write itself in focus: the caret, the focused range, a slide with no id line ──
  for (const place of PLACES) await check(`F4. focus, the slide ${place}: the link typed after the author, ArrowUp: the form is written, the caret and the focused range as out of focus`, async () => {
    const keys = async (focus) => {
      const doc = talk(place, [AUTHOR])
      await begin(doc, focus)
      await click(lineOf(doc, AUTHOR))
      await type(` ${WEB}`)
      await compiled()
      const typed = await text()
      await press('ArrowUp'); await settle()
      return { typed, written: await text(), caret: await caret(), focused: await shown() }
    }
    const plain = await keys(false)
    const { typed, written, caret: at, focused } = await keys(true)
    await assertWritten(typed, written)
    assert.deepEqual(at, plain.caret, 'the caret is where ArrowUp leaves it out of focus: the write does not move it')
    assert.deepEqual(at.line, lineOf(written, sourceLine) - 1, 'one line up')
    assert.deepEqual(focused, { first: lineOf(written, `### ${TITLE}`), last: place === 'notes' ? lineOf(written, NOTES[2]) : lineOf(written, sourceLine) }, 'the focused range is the slide')
    await undoAll()
  })
  await check('F4. focus, a slide with no id line: the layout line is made under the heading, inside the focused slide', async () => {
    const keys = async (focus) => {
      const doc = talk('last', [AUTHOR], false)
      await begin(doc, focus)
      await click(lineOf(doc, AUTHOR))
      await type(` ${WEB}`)
      await compiled()
      const typed = await text()
      await enter(); await enter()
      return { typed, written: await text(), focused: await shown() }
    }
    const plain = await keys(false)
    const { typed, written, focused } = await keys(true)
    assert.equal(written, `${typed}\n`.replace(`### ${TITLE}\n`, `### ${TITLE}\n{form=web}\n`), 'the text as typed with a layout line holding the form under the heading: nothing else changed')
    assert.equal(written, plain.written, 'the text is the one the same keys leave out of Slide Focus')
    assert.deepEqual(focused, { first: lineOf(written, `### ${TITLE}`), last: lineOf(written, sourceLine) + 1 }, 'the focused slide is drawn to the emptied line under the source line, the new layout line in it')
    const saved = stampMissingIds(written).text
    const id = saved.slice(saved.indexOf(`### ${TITLE}`)).match(/\{id=([A-Za-z0-9_-]+)/)?.[1]
    assert(id, 'the slide has an id once saved')
    assert.equal(drawnForm(await compile(saved), id, 'web', { wordsBefore: typedWords, link: WEB }), '', 'the full compiler draws the written form')
    await undoAll()
  })

  // ── F5. Leaving Slide Focus (Esc) with the link typed and the caret still on its line ──
  await check('F5. the link typed in focus, focus left: nothing is written by leaving focus; the form is written when the line is left', async () => {
    for (const leave of ['ArrowUp', 'leaving the editor', 'Enter, Enter']) {
      const doc = talk('middle', [AUTHOR])
      await begin(doc)
      await click(lineOf(doc, AUTHOR))
      await type(` ${WEB}`)
      await compiled()
      const typed = await text()
      const before = await caret()
      await run(() => window.leaveFocus()); await settle()
      assert.equal(await shown(), null, 'focus is left')
      assert.equal(await text(), typed, 'leaving focus is no leaving of the line: the caret has not moved, nothing is written')
      assert.deepEqual(await caret(), before, 'the caret is where it was')
      if (leave === 'ArrowUp') { await press('ArrowUp'); await settle() } else if (leave === 'leaving the editor') { await run(() => window.blurEditor()); await settle() } else { await enter(); await enter() }
      await assertWritten(leave === 'Enter, Enter' ? insertAfter(typed, sourceLine, '') : typed, await text())
      await undoAll()
    }
  })
  await check('F5. the link typed in focus, Enter, focus left, Enter: the form is written at the second Enter', async () => {
    const doc = talk('middle', [AUTHOR])
    await begin(doc)
    await click(lineOf(doc, AUTHOR))
    await type(` ${WEB}`)
    await compiled()
    const typed = await text()
    await enter()
    await run(() => window.leaveFocus()); await settle()
    await assertNoForm('the first Enter, focus left')
    await enter()
    const written = await text()
    await assertWritten(insertAfter(typed, sourceLine, ''), written)
    assert.deepEqual(await caret(), { line: lineOf(written, sourceLine) + 1, column: 0 }, 'out of focus the caret is on the emptied line')
    await undoAll()
  })

  // ── G. A line begun under the last line of the focused slide (ticket 15) ──
  // focusScope.ts counts an empty line begun at the end of the focused slide as a line of it. Each case types with
  // real key presses in focus and out of it and asserts the exact text; in focus, after every key, the lines drawn are
  // the slide's own from its title down, the caret is on one of them, and the next slide's title is not among them.
  const FOCUS_LINK = 'https://example.org/x'
  const FOCUS_SOURCE = `- Focus Author ${FOCUS_LINK}`
  const AFTER = ['### After', '{id=s3}', '', 'A paragraph of the slide after.', '']
  /** The talk with `body` the lines of the focused slide under its id line; `end`: 'middle' (a slide follows), 'last', or 'last, the file ending with a line break'. */
  const ending = (body, end) => ['# Talk', '', '### First', '{id=s1}', '', 'Words of the first slide.', '', `### ${TITLE}`, '{id=fq}', '', ...body, ...(end === 'middle' ? ['', ...AFTER] : end === 'last' ? [] : [''])].join('\n')
  const ENDS = ['middle', 'last', 'last, the file ending with a line break']
  /** In focus: the editor draws the slide's lines from its title down and nothing else, and the caret is on one of them. */
  const assertDrawn = async (what) => {
    const now = (await text()).split('\n')
    const drawn = await run(() => window.drawn())
    const first = now.indexOf(`### ${TITLE}`)
    assert.deepEqual(drawn, now.slice(first, first + drawn.length), `${what}: the lines drawn are the slide's, from its title`)
    assert.equal(drawn.slice(1).some((line) => /^#{1,6}\s/.test(line)), false, `${what}: no other slide's title is drawn`)
    const at = await caret()
    assert(at.line - 1 >= first && at.line - 1 < first + drawn.length, `${what}: the caret is on a line the editor draws (line ${at.line}; drawn ${first + 1} to ${first + drawn.length})`)
    assert.deepEqual(await shown(), { first: first + 1, last: first + drawn.length }, `${what}: the rows drawn and the stored range are those lines`)
    return drawn
  }
  /** The keys at the end of `on` (a line of `doc`), in focus or out of it: `T:` types the words. The text with the caret as `|`. */
  const keysAtEnd = async (doc, on, keys, focus) => {
    await begin(doc, focus)
    await click(lineOf(doc, on))
    // Each letter of typed words is a key of its own, asserted after like any other.
    for (const key of keys.flatMap((key) => (key.startsWith('T:') ? [...key.slice(2)].map((letter) => `T:${letter}`) : [key]))) {
      if (key.startsWith('T:')) await type(key.slice(2)); else await press(key)
      await settle()
      if (focus) await assertDrawn(`after ${key}`)
    }
    await compiled()
    const [now, at] = [await text(), await caret()]
    const lines = now.split('\n')
    lines[at.line - 1] = `${lines[at.line - 1].slice(0, at.column)}|${lines[at.line - 1].slice(at.column)}`
    return lines.join('\n')
  }
  /** The keys leave `expected` (the caret as `|`) in focus, and the same out of focus. */
  const sameInFocus = async (doc, on, keys, expected) => {
    assert.equal(await keysAtEnd(doc, on, keys, false), expected, 'out of focus: the text and the caret')
    assert.equal(await keysAtEnd(doc, on, keys, true), expected, 'in focus: the text and the caret the same keys leave out of focus')
  }
  /** ArrowUp: `typed` takes its form and nothing else; the compiler draws it; one blank line stands above the next title; out of focus the text is the same. */
  const formWrittenInFocus = async (typed, end) => {
    await press('ArrowUp'); await settle()
    const written = await text()
    assert.equal(written, withForm(typed), 'the line left: the text as typed with form=web on the slide\'s layout line, nothing else changed')
    const before = compiledWords((await compile(typed)).slides.find((slide) => slide.id === 'fq'))
    assert(before.length > 0, 'the slide has a quotation before the form is written')
    assert.equal(drawnForm(await compile(written), 'fq', 'web', { wordsBefore: before, link: FOCUS_LINK }), '', 'the full compiler draws the written form, citing the typed link, the quotation\'s words unchanged')
    const lines = written.split('\n')
    const source = lines.indexOf(FOCUS_SOURCE)
    assert(source > 0 && lines[source - 1] === '', 'the source is on a line of its own, one blank line above it')
    if (end === 'middle') assert.deepEqual(lines.slice(source + 1, source + 3), ['', '### After'], 'exactly one blank line stands between the source and the next slide\'s title')
    else assert.deepEqual(lines.slice(source + 1), [], 'the source is the last line of the text')
    const drawn = await assertDrawn('after ArrowUp')
    assert.equal(drawn.at(-1), FOCUS_SOURCE, 'the source line is the last line drawn')
    await run(() => window.leaveFocus()); await settle()
    assert.equal(await shown(), null, 'focus is left')
    assert.equal(await text(), written, 'out of focus the text is the same')
    assert.equal((await run(() => window.drawn())).join('\n'), written, 'and the editor draws all of it')
    await undoAll(FOCUS_LINK)
  }

  for (const end of ENDS) await check(`G1. focus, the slide ${end}, the quotation its last line: Enter, Enter, a source line typed, ArrowUp: the source on its own line under the quotation, the form written`, async () => {
    const doc = ending([QUOTATION], end)
    const typed = ending([QUOTATION, '', FOCUS_SOURCE], end === 'middle' ? 'middle' : 'last')
    await sameInFocus(doc, QUOTATION, ['Enter', 'Enter'], ending([QUOTATION, '', '|'], end === 'middle' ? 'middle' : 'last'))
    await sameInFocus(doc, QUOTATION, ['Enter', 'Enter', `T:${FOCUS_SOURCE}`], typed.replace(FOCUS_SOURCE, `${FOCUS_SOURCE}|`))
    await formWrittenInFocus(typed, end)
    assert.equal(await text(), doc, 'all undone: the text is as it was')
  })
  for (const end of ENDS) await check(`G2. focus, the slide ${end}, the quotation its last line: Shift-Enter, a second paragraph; Enter, Enter, a source line, ArrowUp: the form written`, async () => {
    const doc = ending([QUOTATION], end)
    const rest = end === 'middle' ? 'middle' : 'last'
    await sameInFocus(doc, QUOTATION, ['Shift+Enter', 'T:A second paragraph.'], ending([QUOTATION, '>', '> A second paragraph.|'], end))
    // Shift-Enter, then Enter on the marker line it made: the quotation is left, its bare marker line stays.
    await sameInFocus(doc, QUOTATION, ['Shift+Enter', 'Enter', 'T:Words under.'], ending([QUOTATION, '>', '', 'Words under.|'], rest))
    // Enter, then Shift-Enter on the marker line: a second paragraph, still in the quotation.
    await sameInFocus(doc, QUOTATION, ['Enter', 'Shift+Enter', 'T:A second paragraph.'], ending([QUOTATION, '>', '> A second paragraph.|'], end))
    const typed = ending([QUOTATION, '>', '> A second paragraph.', '', FOCUS_SOURCE], rest)
    await sameInFocus(doc, QUOTATION, ['Shift+Enter', 'T:A second paragraph.', 'Enter', 'Enter', `T:${FOCUS_SOURCE}`], typed.replace(FOCUS_SOURCE, `${FOCUS_SOURCE}|`))
    await formWrittenInFocus(typed, end)
  })
  for (const end of ENDS) await check(`G3. focus, the slide ${end}, a paragraph its last line: Enter, Enter, words typed: they are on a line of their own under the paragraph`, async () => {
    const doc = ending(['A paragraph.'], end)
    // A line break that ends the file stays where it is: these Enters make their own lines.
    const rest = end
    await sameInFocus(doc, 'A paragraph.', ['Enter', 'T:Next line.'], ending(['A paragraph.', 'Next line.|'], rest))
    await sameInFocus(doc, 'A paragraph.', ['Enter', 'Enter', `T:${FOCUS_SOURCE}`], ending(['A paragraph.', '', `${FOCUS_SOURCE}|`], rest))
    await assertNoForm('a paragraph and a link under it')
  })
  for (const [kind, last] of [['paragraph', 'A paragraph.'], ['quotation', QUOTATION]]) await check(`G7. focus, a ${kind} slide whose last line is directly followed by the next heading: Enter, abc typed: abc is on the new line and the line before is unchanged`, async () => {
    const doc = ['# Talk', '', '### First', '{id=s1}', '', 'Words of the first slide.', '', `### ${TITLE}`, '{id=fq}', '', last, '### After', '{id=s3}', '', 'A paragraph of the slide after.', ''].join('\n')
    const keys = async (focus) => {
      await begin(doc, focus)
      await click(lineOf(doc, last))
      await enter()
      await type('abc')
      return { text: await text(), caret: await caret() }
    }
    const plain = await keys(false)
    const focused = await keys(true)
    assert.deepEqual(focused, plain, 'the same text and caret as outside Slide Focus')
    const lines = focused.text.split('\n')
    const at = lines.indexOf(last)
    assert(at >= 0, 'the last line of the slide is unchanged')
    assert(lines[at + 1].includes('abc') && !lines[at].includes('abc'), 'abc is on the line begun under it')
    assert.equal(lines.filter((line) => line.includes('abc')).length, 1, 'abc is written once')
  })
  for (const end of ENDS) await check(`G4. focus, the slide ${end}, a list its last lines: Enter, Enter at its end leaves the list, words typed are on the line under it`, async () => {
    const doc = ending(['- one', '- two'], end)
    const rest = end
    await sameInFocus(doc, '- two', ['Enter', 'Enter'], ending(['- one', '- two', '|'], rest))
    await sameInFocus(doc, '- two', ['Enter', 'Enter', 'T:Words under.'], ending(['- one', '- two', 'Words under.|'], rest))
    await sameInFocus(doc, '- two', ['Enter', 'T:three', 'Enter', 'Enter', 'Enter', 'T:Words under.'], ending(['- one', '- two', '- three', '', 'Words under.|'], rest))
  })
  await check('G5. focus, a line begun under the slide\'s last line: ArrowDown and Delete there reach nothing of the next slide', async () => {
    const doc = ending([QUOTATION], 'middle')
    const begun = ending([QUOTATION, '', '|'], 'middle')
    assert.equal(await keysAtEnd(doc, QUOTATION, ['Enter', 'Enter', 'ArrowDown', 'ArrowDown', 'ArrowRight', 'Delete', 'Delete', 'ControlOrMeta+ArrowDown'], true), begun, 'the caret stays on the begun line and nothing is deleted')
    assert.equal(await keysAtEnd(doc, QUOTATION, ['Enter', 'Enter', 'ArrowDown', 'Delete', 'T:x', 'ArrowDown', 'Delete', 'T:y'], true), begun.replace('|', 'xy|'), 'what is typed then stays on the begun line')
    // The begun line taken back: the slide ends at its quotation again, and the blank line above the next title is the one that was there.
    assert.equal(await keysAtEnd(doc, QUOTATION, ['Enter', 'Enter', 'Backspace', 'Backspace'], true), doc.replace(QUOTATION, `${QUOTATION}|`), 'Backspace, Backspace: the text is as it was')
    assert.deepEqual(await run(() => window.drawn()), [`### ${TITLE}`, '{id=fq}', '', QUOTATION], 'and the slide is drawn to its quotation')
  })
  await check('G6. focus: the last line emptied is still a line of the slide; a range set on a begun line; two blank lines above the next title', async () => {
    // The last line's words deleted: the empty line stays drawn with the caret on it.
    const doc = ending([QUOTATION, '', 'Words.'], 'middle')
    assert.equal(await keysAtEnd(doc, 'Words.', ['Shift+Home', 'Backspace', 'T:Other words.'], true), ending([QUOTATION, '', 'Other words.|'], 'middle'), 'the words typed after are on that line')
    // Two blank lines above the next title: the first is a line of the slide once a line is begun, the second stays hidden.
    const two = ending([QUOTATION], 'middle').replace('\n\n### After', '\n\n\n### After')
    const left = await keysAtEnd(two, QUOTATION, ['Enter', 'Enter', `T:${FOCUS_SOURCE}`], true)
    assert.equal(left, await keysAtEnd(two, QUOTATION, ['Enter', 'Enter', `T:${FOCUS_SOURCE}`], false), 'the same text and caret as out of focus')
    assert.equal(left, two.replace(`${QUOTATION}\n`, `${QUOTATION}\n\n${FOCUS_SOURCE}|`), 'the blank line that was there is the source\'s line; one blank line is left above the next title')
    // A range that ends at the start of the blank line above the next title (set from outside) shows the slide to its last line with words, as before.
    const plain = ending(['A paragraph.'], 'middle')
    await begin(plain)
    const edge = endOf(plain, 'A paragraph.') + 1
    await run((range) => window.setRange(range), { from: endOf(plain, `### ${TITLE}`) - `### ${TITLE}`.length, to: edge })
    assert.deepEqual(await run(() => window.drawn()), [`### ${TITLE}`, '{id=fq}', '', 'A paragraph.'], 'the blank line above the next title is not drawn')
    assert.equal((await run(() => window.range())).to, edge, 'and the range is kept as it was set')
  })

  // ── Q. Enter, Enter at the end of a quotation that ends the focused slide ──
  // The band takes a blank line begun under the slide's last line (focusScope.ts), so leaveQuotation no longer declines in
  // Slide Focus: two Enters leave the quotation exactly as outside focus, and the caret is on a drawn line of the band.
  const quoteLines = (doc) => doc.split('\n')
  for (const place of ['middle', 'last']) await check(`Q${place === 'middle' ? '1' : '2'}. focus, the slide ${place}, the quotation its last line: Enter, Enter leaves the quotation as outside focus; the caret is on a drawn line; abc typed lands there`, async () => {
    const doc = talk(place)
    const first = lineOf(doc, QUOTATION)
    const keys = async (focus) => {
      await begin(doc, focus)
      await click(first)
      await enter(); await enter()
      return { text: await text(), caret: await caret() }
    }
    const plain = await keys(false)
    await run(() => window.leaveFocus()).catch(() => {})
    const focused = await keys(true)
    assert.deepEqual(focused, plain, 'the same text and caret as outside Slide Focus')
    assert.equal(quoteLines(focused.text)[first], '', 'the marker-only line is emptied: the quotation is left')
    const band = await run(() => window.focused())
    assert(focused.caret.line >= band.first && focused.caret.line <= band.last, `the caret line ${focused.caret.line} is a line of the focused band ${band.first}-${band.last}`)
    await type('abc')
    assert(quoteLines(await text())[focused.caret.line - 1].startsWith('abc'), 'abc is written on the caret line, not in front of the quotation')
    assert.equal(quoteLines(await text())[first - 1], QUOTATION, 'the quotation line is unchanged')
  })
  await check('Q3. focus, the quotation followed by another paragraph of the slide: Enter, Enter leaves the quotation as outside focus', async () => {
    const doc = talk('middle', ['A paragraph under the quotation.'])
    const first = lineOf(doc, QUOTATION)
    const keys = async (focus) => {
      await begin(doc, focus)
      await click(first)
      await enter(); await enter()
      return { text: await text(), caret: await caret() }
    }
    const plain = await keys(false)
    const focused = await keys(true)
    assert.deepEqual(focused, plain, 'the same text and caret as outside Slide Focus')
    assert.equal(quoteLines(focused.text)[first], '', 'the marker-only line is emptied: the quotation is left')
    assert.equal(focused.caret.line, first + 2, 'the caret is on the blank line below the emptied one (the reused blank), as outside focus')
  })

  // ── Nothing is written ──
  await check('N1. focus: a link put on the source line by a program, Enter, Enter by the user: no form', async () => {
    for (const place of PLACES) {
      const doc = talk(place, [AUTHOR])
      await begin(doc)
      await click(lineOf(doc, AUTHOR))
      const end = endOf(doc, AUTHOR)
      await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: end, insert: ` ${WEB}` }], cursor: end + WEB.length + 1 }])
      await compiled()
      assert.equal(await text(), talk(place, [sourceLine]), 'the program put the link after the author')
      await enter(); await enter()
      const now = await text()
      assert.equal(now, insertAfter(talk(place, [sourceLine]), sourceLine, ''), `the slide ${place}: the two Enters, and no form`)
      await leaveEveryWay(now, `the slide ${place}, the line left`)
      await run(() => window.leaveFocus()); await settle()
      await leaveEveryWay(now, `the slide ${place}, focus left`)
    }
  })
  await check('N2. focus: the link typed by the user, the two Enters\' changes made by a program: no form', async () => {
    // The very changes and carets of the app's two Enters, dispatched with no mark: Slide Focus takes them exactly as
    // it takes the Enters'. Nothing but the mark tells the two apart.
    for (const place of ['last', 'middle']) {
      const doc = talk(place, [AUTHOR])
      await begin(doc)
      await click(lineOf(doc, AUTHOR))
      await type(` ${WEB}`)
      await compiled()
      const typed = await text()
      const end = endOf(typed, sourceLine)
      await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: end, insert: '\n- ' }], cursor: end + 3 }])
      await settle()
      await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: end + 1, to: end + 3, insert: '' }], cursor: end + 1 }])
      await settle()
      const now = await text()
      assert.equal(now, insertAfter(typed, sourceLine, ''), `the slide ${place}: the text the two Enters leave, and no form`)
      assert.deepEqual(await caret(), { line: lineOf(now, sourceLine) + 1, column: 0 }, 'the caret is on the emptied line, as for the Enter')
      const last = (await run(() => window.seen)).at(-1)
      assert.deepEqual([last.userEvent, last.keyTyped], [null, false], 'the change has no user event and no mark')
      await leaveEveryWay(now, `the slide ${place}, the line left`)
      await run(() => window.leaveFocus()); await settle()
      await leaveEveryWay(now, `the slide ${place}, focus left`)
    }
  })
  await check('N3. focus: a program deletes the link and the user types it again at once with an x, Backspace, one undo, the line left: no form', async () => {
    // The fourth review's reproduction (ticket 11, R10), in focus, the source line the last line of the focused slide.
    for (const leave of ['ArrowUp', 'Enter, Enter']) {
      const start = talk('last', [sourceLine])
      await begin(start)
      await click(lineOf(start, sourceLine))
      const end = endOf(start, sourceLine)
      await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: end - WEB.length - 1, to: end, insert: '' }], cursor: end - WEB.length - 1 }])
      await type(` ${WEB}x`)
      await press('Backspace')
      assert.equal(await text(), start, 'the program\'s deletion, then the same link typed (with an x, taken out again)')
      await press('ControlOrMeta+z'); await settle()
      assert.equal(await text(), start, 'one undo: the text is the original again')
      assert.equal(await run(() => window.undoDepth()), 0, 'and nothing is left to undo')
      await compiled()
      if (leave === 'ArrowUp') { await press('ArrowUp'); await settle() } else { await enter(); await enter() }
      await assertNoForm(`left by ${leave}`)
      const now = await text()
      await leaveEveryWay(now, 'the line left again')
      await run(() => window.leaveFocus()); await settle()
      await leaveEveryWay(now, 'focus left')
    }
  })

  // ── M. Any edit of the user's counts (decided 13 October 2026); P. the same change made by a program does not ──
  // The review's document: the words and the source on one quotation line, a notes block after it. No character of the
  // link is typed in any of these. Each case runs out of focus and in focus, and the two must leave the same text and
  // caret. Where the user's key leaves the slide a quotation with a source link under it, the form is written when the
  // line is left, the compiler draws it with the quotation's words unchanged, and Cmd-Z never leaves the form without
  // the edit that justifies it.
  const MOVED = 'https://example.org/schemas-and-propositions'
  const moved = (lines) => ['# Talk', '', `### ${TITLE}`, '{id=fq}', '', ...lines, '', ':::notes', 'Notes.', ':::', ''].join('\n')
  const THERE = `- Author ${MOVED}`
  const ONE = `> Words. ${THERE}`
  /** The document mounted (focused or not), the caret on `line`, `back` characters before its end. */
  const caretOn = async (focus, doc, line, back) => {
    await begin(doc, focus)
    await click(lineOf(doc, line))
    await press('ArrowLeft', back)
    await compiled()
  }
  /** `caretOn`, then the keys. What they leave, and the changes the editor took for them. */
  const keysOn = async (focus, doc, line, back, keys) => {
    await caretOn(focus, doc, line, back)
    const from = await run(() => window.seen.length)
    for (const key of keys) { await press(key); await settle() }
    return { text: await text(), caret: await caret(), seen: (await run(() => window.seen)).slice(from) }
  }
  /** Each change's user event (its first part) and whether it carries the key commands' mark. */
  const carried = (seen) => seen.map((tr) => [tr.userEvent?.split('.')[0] ?? null, tr.keyTyped])
  /** Leave the line every way, and focus: the text stays `expected`. */
  const leaveAll = async (expected, what) => {
    await compiled()
    await press('ArrowUp'); await settle()
    assert.equal(await text(), expected, `${what}: ArrowUp`)
    await click(lineOf(expected, 'Notes.'))
    await run(() => window.blurEditor()); await settle()
    await run(() => window.leaveFocus()); await settle()
    await press('ArrowUp'); await settle()
    assert.equal(await text(), expected, `${what}: a click elsewhere, the editor left, focus left`)
  }
  /** The same keys out of focus and in focus: the same text and caret; `then` is run on each. */
  const both = async (doc, line, back, keys, then) => {
    const left = []
    for (const focus of [false, true]) {
      const now = await keysOn(focus, doc, line, back, keys)
      await then(now, focus ? 'in focus' : 'out of focus')
      left.push([now.text, now.caret])
    }
    assert.deepEqual(left[1], left[0], 'in focus the keys leave the text and the caret they leave out of focus')
  }
  /** The one replacement that makes `from` into `to`, as a program would dispatch it. */
  const between = (from, to) => {
    let start = 0
    while (start < from.length && start < to.length && from[start] === to[start]) start += 1
    let end = 0
    while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end += 1
    return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) }
  }
  /** The line is left (ArrowUp): `edited` takes its form and nothing else; the compiler draws it; nothing more is written; one Cmd-Z takes the edit and the form together, back to `start`. */
  const formWrittenAndUndone = async (start, edited, where) => {
    await compiled()
    await press('ArrowUp'); await settle()
    const written = withForm(edited)
    assert.equal(await text(), written, `${where}: the user's own edit left the slide a quotation with a source link under it: the form is written, whoever typed the link, and nothing else changed`)
    const before = compiledWords((await compile(edited)).slides.find((slide) => slide.id === 'fq'))
    assert(before.length > 0, 'the slide has a quotation before the form is written')
    assert.equal(drawnForm(await compile(written), 'fq', 'web', { wordsBefore: before, link: MOVED }), '', `${where}: the full compiler draws the written form, citing the link, the quotation's words unchanged`)
    await click(lineOf(written, 'Notes.'))
    await run(() => window.blurEditor()); await settle()
    assert.equal(await text(), written, `${where}: a click elsewhere, the editor left: nothing more is written`)
    const walk = []
    while (await run(() => window.undoDepth()) > 0) {
      await press('ControlOrMeta+z'); await settle()
      const now = await text()
      assert(!now.includes('form=') || now === written, `${where}, undo step ${walk.length + 1}: the form stands without the user's edit: ${JSON.stringify(now)}`)
      walk.push(now)
      assert(walk.length < 50, 'the undo history ends')
    }
    assert.deepEqual(walk, [start], `${where}: one Cmd-Z takes the user's edit and the form together`)
  }
  // name: the slide's lines, the caret's line and how far before its end, the keys, the lines they leave, and what
  // each change carries (the first part of its user event, the mark).
  const EDITS = {
    'M1. the review\'s reproduction: Shift-Enter after the words of a quotation line that has its source after them (the caret before the space)': { before: [ONE], on: ONE, back: ONE.length - '> Words.'.length, keys: ['Shift+Enter'], after: ['> Words.', '>', `> ${THERE}`], carries: [[null, true]] },
    'M1. the review\'s reproduction: Shift-Enter after the words of a quotation line that has its source after them (the caret after the space)': { before: [ONE], on: ONE, back: ONE.length - '> Words. '.length, keys: ['Shift+Enter'], after: ['> Words.', '>', `> ${THERE}`], carries: [[null, true]] },
    'M2. Enter (the markdown language\'s own) after the words and their space': { before: [ONE], on: ONE, back: ONE.length - '> Words. '.length, keys: ['Enter'], after: ['> Words.', `> ${THERE}`], carries: [['input', false]] },
    'M4. Tab after the hyphen of -Author <link> (the line becomes an item)': { before: ['> Words.', '', `-Author ${MOVED}`], on: `-Author ${MOVED}`, back: `Author ${MOVED}`.length, keys: ['Tab'], after: ['> Words.', '', `-  Author ${MOVED}`], carries: [[null, true]] },
    'M7. Enter on an empty item under an address': { before: ['> Words.', '', MOVED, '- '], on: '- ', back: 0, keys: ['Enter'], after: ['> Words.', '', MOVED, ''], carries: [[null, true]] },
    'M7. Enter on an empty item above a source line': { before: ['> Words.', '', '- ', THERE], on: '- ', back: 0, keys: ['Enter'], after: ['> Words.', '', '', THERE], carries: [[null, true]] },
    'M7. Enter on a marker-only quotation line above a source line': { before: ['> Words.', '', '> ', THERE], on: '> ', back: 0, keys: ['Enter'], after: ['> Words.', '', '', '', THERE], carries: [[null, true]] },
    'M8. Backspace over an empty item above a source line': { before: ['> Words.', '', '- ', THERE], on: '- ', back: 0, keys: ['Backspace'], after: ['> Words.', '', '', THERE], carries: [['delete', false]] },
    'M8. Backspace over a marker-only quotation line above a source line': { before: ['> Words.', '', '> ', THERE], on: '> ', back: 0, keys: ['Backspace'], after: ['> Words.', '', '', THERE], carries: [['delete', false]] }
  }
  for (const [name, edit] of Object.entries(EDITS)) {
    const start = moved(edit.before)
    const edited = moved(edit.after)
    await check(`${name}, the line left: the form is written`, async () => {
      await both(start, edit.on, edit.back, edit.keys, async (now, where) => {
        assert.equal(now.text, edited, `${where}: the key does what it did before, and nothing is written yet`)
        assert.deepEqual(carried(now.seen), edit.carries, `${where}: the change says it is the user's (a user event of typing or deleting, or the key commands' mark)`)
        await formWrittenAndUndone(start, edited, where)
      })
    })
    await check(`P. ${name.replace(/^M/, '')}, the same change made by a program: no form`, async () => {
      for (const focus of [false, true]) {
        const where = focus ? 'in focus' : 'out of focus'
        await caretOn(focus, start, edit.on, edit.back)
        const change = between(start, edited)
        const from = await run(() => window.seen.length)
        await run((specs) => window.dispatchAll(specs), [{ changes: [change], cursor: change.from + change.insert.length }])
        await settle()
        assert.equal(await text(), edited, `${where}: the program made the very change the key makes`)
        assert.deepEqual(carried((await run(() => window.seen)).slice(from)), [[null, false]], `${where}: one change, with no user event and no mark`)
        await leaveAll(edited, where)
      }
    })
  }
  await check('M3. Shift-Enter at the end of the quotation line: a second paragraph, Enter, Enter, an address typed, ArrowUp: the form is written', async () => {
    const start = moved(['> Words.'])
    const typed = moved(['> Words.', '>', '> A second paragraph.', '', MOVED])
    await both(start, '> Words.', 0, ['Shift+Enter'], async (now, where) => {
      assert.deepEqual(carried(now.seen), [[null, true]], `${where}: the Shift-Enter carries the mark`)
      await type('A second paragraph.')
      await enter(); await enter()
      await type(MOVED)
      await compiled()
      assert.equal(await text(), typed, `${where}: both paragraphs, one blank line, the address`)
      await press('ArrowUp'); await settle()
      assert.equal(await text(), withForm(typed), `${where}: the typed address takes its form`)
      now.text = await text()
      now.caret = await caret()
    })
  })
  await check('M4. Tab on a line that is no list item carries the mark wherever the caret is', async () => {
    await both(moved(['> Words.', '', 'Words under']), 'Words under', 0, ['Tab'], async (now, where) => {
      assert.equal(now.text, moved(['> Words.', '', 'Words under  ']), `${where}: two spaces at the end of the line`)
      assert.deepEqual(carried(now.seen), [[null, true]], `${where}: the mark`)
    })
    await both(moved(['> Words.', '', 'Words under']), 'Words under', ' under'.length, ['Tab'], async (now, where) => {
      assert.equal(now.text, moved(['> Words.', '', 'Words   under']), `${where}: two spaces at the caret`)
      assert.deepEqual(carried(now.seen), [[null, true]], `${where}: the mark, with text after the caret too`)
      await leaveAll(now.text, where)
    })
  })
  await check('M5. Enter on a list item carries the mark at its end and in its middle; the rest of an item made the next item is a list of two: no form', async () => {
    const line = `- Someone ${THERE}`
    const expected = moved(['> Words.', '', '- Someone ', `- ${THERE}`])
    await both(moved(['> Words.', '', line]), line, line.length - '- Someone '.length, ['Enter'], async (now, where) => {
      assert.equal(now.text, expected, `${where}: the rest of the item is the next item, as before`)
      assert.deepEqual(carried(now.seen), [[null, true]], `${where}: the mark, with text after the caret too`)
      await leaveAll(expected, where)
    })
    await both(moved(['> Words.', '', line]), line, 0, ['Enter'], async (now, where) => {
      assert.equal(now.text, moved(['> Words.', '', line, '- ']), `${where}: an empty item under it`)
      assert.deepEqual(carried(now.seen), [[null, true]], `${where}: the mark`)
    })
  })
  await check('M6. a source line that was there, indented by four spaces: Shift-Tab, Shift-Tab, the line left: no form (the indent gives the link no new reading)', async () => {
    const line = `    ${THERE}`
    const expected = moved(['> Words.', '', THERE])
    await both(moved(['> Words.', '', line]), line, 0, ['Shift+Tab', 'Shift+Tab'], async (now, where) => {
      assert.equal(now.text, expected, `${where}: the indent is taken out`)
      assert.deepEqual(carried(now.seen), [[null, true], [null, true]], `${where}: Shift-Tab on the caret's line alone carries the mark`)
      await leaveAll(expected, where)
    })
  })

  // ── C. The command run without a key press ──
  // `tw-run-command` with `editor.quote-paragraph` (the Talks panel's Actions here sends it; WorkspaceLayout.tsx
  // listens). WorkspaceLayout is not mounted here: the page has its listener's steps for a command with no handler of
  // its own (the command found in the registry, its key sent to the editor as a keydown the program makes).
  await check('C. tw-run-command editor.quote-paragraph on the review\'s document: what the route does', async () => {
    const start = moved([ONE])
    const edited = moved(['> Words.', '>', `> ${THERE}`])
    for (const focus of [false, true]) {
      const where = focus ? 'in focus' : 'out of focus'
      await caretOn(focus, start, ONE, ONE.length - '> Words.'.length)
      const from = await run(() => window.seen.length)
      const route = await run(() => { window.ranCommand = null; window.dispatchEvent(new CustomEvent('tw-run-command', { detail: 'editor.quote-paragraph' })); return new Promise((resolve) => setTimeout(() => resolve(window.ranCommand), 40)) })
      const after = await text()
      const seen = carried((await run(() => window.seen)).slice(from))
      await compiled()
      await press('ArrowUp'); await settle()
      const left = await text()
      observed.push(`tw-run-command editor.quote-paragraph, ${where}: ${route}; ${after === edited ? 'the split is made' : after === start ? 'the text is unchanged' : 'another text'}, changes ${JSON.stringify(seen)}; the line left: ${left === withForm(edited) ? 'form=web written' : left.includes('form=') ? 'a form written on another text' : 'no form'}`)
    }
  })

  if (REPORT) {
    console.log(`${ran} cases run, ${failures.length} failed`)
    for (const failure of failures) console.log(`FAIL ${failure}`)
    for (const line of observed) console.log(line)
  } else {
    for (const line of observed) console.log(line)
    console.log(`quote form slide focus editor ok: ${ran} cases; in Slide Focus the form of a typed link is written as out of it (a source line left by Enter, Enter at the end of the focused slide too), a line begun under the focused slide's last line is a line of the slide, any edit of the user's that leaves a quotation with a source link writes the form, and nothing is written for a change a program made`)
  }
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
