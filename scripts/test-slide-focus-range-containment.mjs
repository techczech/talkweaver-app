// test:slide-focus-range-containment — quote forms ticket 15, review round: what a change that is not the user's can
// bring into the focused slide, and that every column Slide Focus draws can be written to.
//
// Ticket 15 made a blank line begun under the focused slide's last line a line of the slide (focusScope.ts,
// begunEmptyLine), and the stored range was taken to that line. The independent review found two faults:
//   BLOCKER. A program's insertion on or under a begun line was then inside the range, and another slide was drawn and
//     open to typing. The begun lines are a courtesy to the user's own typing: a change that is not the user's (a
//     program's, an undo, a redo) is now mapped from the end of the slide's last line with text (throughProgramChange).
//   SHOULD-FIX. A begun line of spaces was drawn to its end and the caret could stand there, but the stored range ended
//     at its start, so what was typed there was silently dropped. The range now ends at the END of the band's last line.
//
// The real focusScopeExtension in a real CodeMirror editor in chrome-headless-shell (never the real Chrome), with the
// app's Enter and Tab commands, the markdown language, history and the save's adoption as components/Editor.tsx mounts
// them. Focus is entered as the app enters it (focusRangeForSlideLine, setFocusRange). The user's keys are key presses;
// a program's change is a dispatch with no user event and no mark. A key in the same task as a program's change cannot
// be a key press (each is a task of its own): it is the keydown event the editor's key commands run from, the
// browser's own insertion of a letter at its selection (execCommand), or a paste event.
//
// After every step of every case, and after every operation of the random run, `sound()` asserts from the page:
// every line drawn is a line of the focused slide (from its title down, before the next title), the first line drawn
// is the title, the lines drawn are consecutive, the caret is on a line that is drawn, the stored range starts at the
// title, ends before the next title, and ends at the end of the last line drawn when that line is blank.
//   B0. the review's reproduction, the facts the editor before ticket 15 gave too: the inserted slide hidden, the caret
//       clamped, the X typed after it not on the inserted slide;
//   B1. the same with the stored range at each step; a key typed straight after the insertion;
//   B2. a program's insertion exactly at the end of the slide's text: shown, as before ticket 15;
//   B3. a program deletes the blank line above the next title while the caret is on a begun line;
//   B4. a program inserts text inside the slide's text: shown, the begun lines kept;
//   B5. a save's adoption that only adds the slide's id line: the begun line kept, the caret on it;
//   B6. a program inserts blank lines after the slide: only blank lines are drawn;
//   B7. undo and redo: words typed on a begun line are drawn again when redone; a redo of a program's insertion under
//       a begun line never draws the inserted slide;
//   B8. a program's line with no title on a begun line is a line of the slide and is drawn; a title there is hidden,
//       and the Enter typed next does not write on it (the caret is put back into the slide first);
//   W.  the SHOULD-FIX reproduction: a begun line of spaces takes what is typed at its end;
//   T.  the second review's BLOCKER: the caret is brought back before any key or input acts. A program's change and
//       the user's next key IN THE SAME TASK (no microtask runs between them), for each shape of change in B0 to B8
//       and a program's selection on its own slide, and for Enter, a typed letter, Tab, Backspace and a paste: the key
//       changes nothing outside the lines drawn (no other slide, no hidden line). T0 is the review's
//       reproduction: the Enter is made at the end of the focused slide's text;
//   I.  the second review's SHOULD-FIX, with a composition the browser makes (Input.imeSetComposition over the
//       DevTools protocol): a program's selection set under the caret's line while a letter is composed does not
//       move the caret, and the letter is written once; the begun lines held out of the range for the composition
//       are drawn again when it ends, with a last change and without one;
//   R.  a random run with a fixed seed: the user's keys at the end of the slide mixed with a program's insertions and
//       deletions around the end of the range. After each operation `sound()`; and a key of the user's changes nothing
//       before the focused slide's title or from the next title on.
// In the random run a program's change is followed, half the time, by the user's next key in the same task.
// The random run leaves out, as faults that were there before ticket 15 and are not this ticket's: a title made by the
// user's key inside focus (the round ends there), a program's change that makes a title inside the slide's own text, a replacement of the whole
// document, and undo (which can change another slide).
//
// SLIDE_FOCUS_REPORT=1 runs every case and lists the failures instead of stopping at the first (used to show which
// cases fail with a fix taken out). SLIDE_FOCUS_ONLY=<prefix> runs only the cases whose name starts so.
// SLIDE_FOCUS_SEED and SLIDE_FOCUS_ROUNDS change the random run.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { stampMissingIds } from '../compiler/scripts/lib/12-outline-edit.mjs'

const SHELL = join(homedir(), '.cache/puppeteer/chrome-headless-shell/mac_arm-146.0.7680.66/chrome-headless-shell-mac-arm64/chrome-headless-shell')
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-slide-focus-range-'))
const outfile = join(dir, 'bundle.js')
const REPORT = process.env.SLIDE_FOCUS_REPORT === '1'
const ONLY = process.env.SLIDE_FOCUS_ONLY
const SEED = Number(process.env.SLIDE_FOCUS_SEED ?? 20261013)
const ROUNDS = Number(process.env.SLIDE_FOCUS_ROUNDS ?? 48)
const STEPS = 70

const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Prec } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, undo, redo, undoDepth, redoDepth } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { savedTextAdoption, adoptSavedText } from './src/renderer/src/extensions/savedTextAdoption.ts'
import { focusScopeExtension, setFocusRange, currentFocusRange } from './src/renderer/src/extensions/focusScope.ts'
import { focusRangeForSlideLine } from './src/renderer/src/components/slideFocusModel.ts'
import { continueList, leaveQuotation, newQuotationParagraph, enterFromHeading, enterFromProtectedLine, indentList, outdentList } from './src/renderer/src/extensions/outliner.ts'
let view = null
const TITLE = /^#{1,6}\\s/
window.mount = (doc) => {
  if (view) view.destroy()
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
      markdown({ base: markdownLanguage }),
      focusScopeExtension(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      savedTextAdoption()
    ] })
  })
  view.focus()
}
// Slide Focus entered on the slide whose title is on line n, as WorkspaceLayout's enterFocus and Editor.tsx do it.
window.enterFocus = (n) => {
  const range = focusRangeForSlideLine(view.state.doc.toString(), n)
  if (!range) return false
  setFocusRange(view, range)
  return true
}
// A click: the caret put at an offset by the pointer.
window.pointer = (at) => { view.dispatch({ selection: EditorSelection.cursor(at), userEvent: 'select.pointer' }); view.focus() }
// A change as a program makes it: no user event, no mark. \`cursor\`: the caret it sets with the change.
window.program = (changes, cursor) => view.dispatch({ changes, selection: cursor == null ? undefined : EditorSelection.cursor(cursor) })
// The save's adoption (extensions/savedTextAdoption.ts): the text a save wrote put in place of the text sent.
window.adopt = (sent, saved) => adoptSavedText(view, sent, saved)
window.depths = () => [undoDepth(view.state), redoDepth(view.state)]
// The user's paste as the editor dispatches it, the caret after the pasted text.
window.pasted = (at, text) => view.dispatch({ changes: { from: at, insert: text }, selection: EditorSelection.cursor(at + text.length), userEvent: 'input.paste' })
window.composing = () => view.composing
window.blur = () => view.contentDOM.blur()
// The end of a composition as the editor hears of it, with no change and no other transaction.
window.endComposition = () => view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }))
// A change the editor read from a composition, as it dispatches one.
window.composed = (at, text) => view.dispatch({ changes: { from: at, insert: text }, selection: EditorSelection.cursor(at + text.length), userEvent: 'input.type.compose' })
window.refocus = () => view.focus()
// A key of the user's with no task of its own: a letter is inserted by the browser at its own selection, a paste is
// the paste event, any other key is the keydown event the key commands run from.
window.user = (key) => {
  if (key === 'paste') {
    const data = new DataTransfer()
    data.setData('text/plain', 'pasted')
    view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  } else if (key.length === 1) document.execCommand('insertText', false, key)
  else view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }))
}
// A change that is not the user's and, in the same task, a key of the user's. \`act\`: a program's changes (and the
// caret it sets), a save's adoption, or an undo or redo. Returns the text, the stored range and the end of the last
// line drawn (the range's last line: a program can have joined text onto it past the range's end) between the two. With
// \`title\`, the key is left out when the change put the caret on the focused slide's title line.
window.sameTask = (act, key, title) => {
  if (act.changes) window.program(act.changes, act.cursor)
  else if (act.adopt) adoptSavedText(view, act.adopt[0], act.adopt[1])
  else if (act.history === 'undo') undo(view)
  else redo(view)
  const range = currentFocusRange(view.state)
  const made = { text: view.state.doc.toString(), range, drawnTo: view.state.doc.lineAt(range.to).to, keyed: false }
  if (!key || (title && view.state.doc.lineAt(view.state.selection.main.head).text.startsWith(title))) return made
  window.user(key)
  made.keyed = true
  return made
}
// What the editor holds and draws, and what is wrong with it. The focused slide is read from the text alone: the line
// that starts with \`title\`, down to the line before the next title line.
window.facts = (title) => {
  const doc = view.state.doc
  const text = doc.toString()
  const lines = text.split('\\n')
  const first = lines.findIndex((line) => line.startsWith(title)) + 1
  let next = lines.findIndex((line, index) => index >= first && TITLE.test(line)) + 1
  const last = next ? next - 1 : lines.length
  let content = last
  while (content > first && lines[content - 1].trim() === '') content -= 1
  const drawnLines = [...view.contentDOM.querySelectorAll('.cm-line')].map((line) => doc.lineAt(view.posAtDOM(line, 0)).number)
  const drawn = drawnLines.map((n) => doc.line(n).text)
  const range = currentFocusRange(view.state)
  const head = view.state.selection.main.head
  const caretLine = doc.lineAt(head)
  const problems = []
  if (!first) problems.push('the focused slide has lost its title')
  if (!range) problems.push('no range is stored')
  if (first && range) {
    if (drawnLines[0] !== first) problems.push('the first line drawn is line ' + drawnLines[0] + ', the title is line ' + first)
    if (drawnLines.some((n, index) => n !== drawnLines[0] + index)) problems.push('the lines drawn are not consecutive: ' + drawnLines.join(','))
    const foreign = drawnLines.filter((n) => n < first || n > last)
    if (foreign.length) problems.push('drawn and no line of the focused slide (lines ' + first + ' to ' + last + '): ' + foreign.map((n) => n + ' ' + JSON.stringify(doc.line(n).text)).join(', '))
    if (!drawnLines.includes(caretLine.number)) problems.push('the caret is on line ' + caretLine.number + ', which is not drawn (drawn ' + drawnLines[0] + ' to ' + drawnLines.at(-1) + ')')
    if (range.from !== doc.line(first).from) problems.push('the range starts at ' + range.from + ', the title at ' + doc.line(first).from)
    if (next && range.to >= doc.line(next).from) problems.push('the range ends at ' + range.to + ', at or after the next title (' + doc.line(next).from + ')')
    const end = doc.line(drawnLines.at(-1))
    if (end.text.trim() === '' && drawnLines.length > 1 && range.to !== end.to) problems.push('the last line drawn is blank and ends at ' + end.to + ', the range at ' + range.to)
  }
  return {
    text, drawn, problems, range,
    caret: { pos: head, line: caretLine.number, column: head - caretLine.from },
    titleLine: first, titleFrom: first ? doc.line(first).from : -1, titleTo: first ? doc.line(first).to : -1,
    contentEnd: first ? doc.line(content).to : -1,
    nextFrom: next ? doc.line(next).from : -1
  }
}
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const TITLE = '### Focus'
const REMOTE = '### Remote\n{id=r}\nRemote body\n'
// The second review's insertion: two slides, the first with nothing under its id line.
const REVIEW = '### Remote\n{id=r}\n### Next\nNext body\n'
const LISTED = '### Remote\n- remote item\n'
// The review's documents. REPRO: three blank lines above the next title. ONE: one. SPACES: a line of three spaces.
const REPRO = '### Focus\n{id=f}\nParagraph\n\n\n\n### After\n{id=a}\nAfter body'
const ONE = '### Focus\n{id=f}\nParagraph\n\n### After\n{id=a}\nAfter body'
const SPACES = '### Focus\n{id=f}\nParagraph\n   \n\n### After\n{id=a}\nAfter body'
const NO_ID = '### Focus\nParagraph\n\n\n### After\n{id=a}\nAfter body'
const SLIDE = ['### Focus', '{id=f}', 'Paragraph']
const endOf = (text, line) => { const at = text.indexOf(line); assert(at >= 0, `the text has "${line}"`); return at + line.length }

/** A random number generator with a seed (mulberry32). */
const seeded = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const browser = await chromium.launch({ executablePath: SHELL, headless: true })
const failures = []
let ran = 0
let summary = ''
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.setContent('<div id="host"></div>')
  await page.addScriptTag({ path: outfile })
  const run = (fn, ...args) => page.evaluate(fn, ...args)
  const settle = () => run(() => new Promise((resolve) => setTimeout(resolve, 15)))
  const facts = () => run((title) => window.facts(title), TITLE)
  const press = async (key) => { await page.keyboard.press(key); await settle() }
  /** Typed key by key. */
  const type = async (words) => { for (const letter of words) { await page.keyboard.type(letter); await settle(); await sound(`after ${JSON.stringify(letter)}`) } }
  const pointer = async (at) => { await run((n) => window.pointer(n), at); await settle() }
  const program = async (changes, cursor) => { await run(([c, at]) => window.program(c, at), [changes, cursor ?? null]); await settle() }
  /** The facts, with nothing wrong in them. */
  const sound = async (what) => {
    const now = await facts()
    assert.deepEqual(now.problems, [], `${what}: ${now.problems.join('; ')} in ${JSON.stringify(now.text)}`)
    return now
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
      failures.push(`${name}: ${String(error.message).split('\n')[0].slice(0, 400)}`)
    }
  }
  /** The document mounted, its first `### Focus` slide focused, the caret at the end of `on`, then the keys. */
  const begin = async (doc, on, keys = []) => {
    await run((d) => window.mount(d), doc)
    const title = doc.split('\n').indexOf(TITLE) + 1
    assert.equal(await run((n) => window.enterFocus(n), title), true, 'the slide is focused')
    await pointer(endOf(doc, on))
    for (const key of keys) { await press(key); await sound(`after ${key}`) }
    return sound('focus entered')
  }
  /** What is drawn, the stored range and the caret's offset, asserted together. */
  const stands = async (what, drawn, range, caret) => {
    const now = await sound(what)
    assert.deepEqual(now.drawn, drawn, `${what}: the lines drawn`)
    assert.deepEqual(now.range, range, `${what}: the stored range`)
    if (caret != null) assert.equal(now.caret.pos, caret, `${what}: the caret`)
    return now
  }

  // ── B. A change that is not the user's ──
  await check('B0. the review\'s reproduction: the inserted slide is hidden, the caret clamped, the X not typed on it (as before ticket 15)', async () => {
    await begin(REPRO, 'Paragraph', ['Enter'])
    await program([{ from: 28, insert: REMOTE }])
    const inserted = (await facts()).text
    assert.equal(inserted, `### Focus\n{id=f}\nParagraph\n\n${REMOTE}\n\n\n### After\n{id=a}\nAfter body`, 'the program\'s slide is in the text, at the start of line 5')
    assert.deepEqual((await facts()).drawn, SLIDE, 'the inserted slide is not drawn')
    await pointer(endOf(inserted, 'Remote body'))
    const clamped = await facts()
    assert.deepEqual(clamped.caret, { pos: 26, line: 3, column: 9 }, 'the caret put after `Remote body` is clamped back to the end of the slide')
    await page.keyboard.type('X'); await settle()
    const typed = await facts()
    assert.equal(typed.text, inserted.replace('Paragraph', 'ParagraphX'), 'the X is typed at the end of the focused slide; the inserted slide is unchanged')
    assert.deepEqual(typed.drawn, ['### Focus', '{id=f}', 'ParagraphX'], 'and only the focused slide is drawn')
  })
  await check('B1. the review\'s reproduction: the stored range at each step; a key typed straight after the insertion', async () => {
    await begin(REPRO, 'Paragraph')
    await stands('focus entered', SLIDE, { from: 0, to: 26 }, 26)
    await press('Enter')
    await stands('Enter at the end of the slide', [...SLIDE, '', '', ''], { from: 0, to: 29 }, 27)
    await program([{ from: 28, insert: REMOTE }])
    // The caret was on the begun line 4, which is now the one blank line above a title: it is put back into the slide.
    await stands('the program\'s slide inserted on a begun line', SLIDE, { from: 0, to: 26 }, 26)
    const inserted = (await facts()).text
    await page.keyboard.type('X'); await settle()
    await stands('X typed', ['### Focus', '{id=f}', 'ParagraphX'], { from: 0, to: 27 }, 27)
    assert.equal((await facts()).text, inserted.replace('Paragraph', 'ParagraphX'), 'the X is on the slide\'s last line; nothing else changed')
    await press('Enter')
    await stands('Enter again', ['### Focus', '{id=f}', 'ParagraphX', ''], { from: 0, to: 28 }, 28)
    await type('y')
    assert.equal((await facts()).text, inserted.replace('Paragraph\n', 'ParagraphX\ny\n'), 'a line begun again takes what is typed')
  })
  await check('B2. a program\'s insertion exactly at the end of the slide\'s text is inside the slide and drawn, as before ticket 15', async () => {
    await begin(REPRO, 'Paragraph')
    await program([{ from: 26, insert: '\nMore words' }])
    await stands('no line begun', [...SLIDE, 'More words'], { from: 0, to: 37 }, 26)
    await begin(REPRO, 'Paragraph', ['Enter'])
    await program([{ from: 26, insert: '\nMore words' }])
    await stands('a line begun', [...SLIDE, 'More words', '', '', ''], { from: 0, to: 40 }, 38)
    await type('X')
    assert.equal((await facts()).text, '### Focus\n{id=f}\nParagraph\nMore words\nX\n\n\n\n### After\n{id=a}\nAfter body', 'the caret stayed on its begun line and the X is typed there')
  })
  await check('B3. a program deletes the blank line above the next title, the caret on a begun line: the caret is put back into the slide', async () => {
    await begin(ONE, 'Paragraph', ['Enter'])
    await stands('Enter at the end of the slide', [...SLIDE, ''], { from: 0, to: 27 }, 27)
    await program([{ from: 28, to: 29 }])
    assert.equal((await facts()).text, '### Focus\n{id=f}\nParagraph\n\n### After\n{id=a}\nAfter body', 'one blank line is left above the next title')
    // The begun line is now the one blank line above the next title: it is hidden, as when focus is entered.
    await stands('the blank line deleted', SLIDE, { from: 0, to: 26 }, 26)
    await page.keyboard.type('X'); await settle()
    await stands('X typed', ['### Focus', '{id=f}', 'ParagraphX'], { from: 0, to: 27 }, 27)
    assert.equal((await facts()).text, '### Focus\n{id=f}\nParagraphX\n\n### After\n{id=a}\nAfter body', 'the X is at the end of the slide\'s last line; the next slide is unchanged')
  })
  await check('B4. a program inserts text inside the slide\'s text: it is drawn, the begun lines stay, the caret stays on its line', async () => {
    await begin(REPRO, 'Paragraph', ['Enter'])
    await program([{ from: 20, insert: ' more ' }])
    await stands('text inserted inside', ['### Focus', '{id=f}', 'Par more agraph', '', '', ''], { from: 0, to: 35 }, 33)
    await type('X')
    assert.equal((await facts()).text, '### Focus\n{id=f}\nPar more agraph\nX\n\n\n\n### After\n{id=a}\nAfter body', 'the X is typed on the begun line')
  })
  await check('B5. a save\'s adoption that only adds the slide\'s id line: the begun line stays, the caret on it', async () => {
    await begin(NO_ID, 'Paragraph', ['Enter'])
    const sent = (await facts()).text
    assert.equal(sent, '### Focus\nParagraph\n\n\n\n### After\n{id=a}\nAfter body', 'a line is begun under the paragraph')
    const saved = stampMissingIds(sent).text
    const id = saved.split('\n')[1]
    assert(/^\{id=[A-Za-z0-9_-]+\}$/.test(id), `the save writes an id line under the title: ${JSON.stringify(id)}`)
    assert.equal(saved, sent.replace('### Focus\n', `### Focus\n${id}\n`), 'and nothing else')
    assert.equal(await run(([a, b]) => window.adopt(a, b), [sent, saved]), true, 'the adoption changed the text')
    await settle()
    const adopted = await stands('the id line adopted', ['### Focus', id, 'Paragraph', '', ''], { from: 0, to: saved.indexOf('Paragraph') + 'Paragraph'.length + 2 })
    assert.deepEqual([adopted.caret.line, adopted.caret.column], [4, 0], 'the caret is on the begun line')
    await type('X')
    assert.equal((await facts()).text, saved.replace('Paragraph\n', 'Paragraph\nX'), 'the X is typed on the begun line')
  })
  await check('B6. a program inserts blank lines after the slide: only blank lines are drawn, nothing of the next slide', async () => {
    for (const [where, at] of [['at the end of the last begun line', 29], ['above the next title', 31]]) {
      await begin(REPRO, 'Paragraph', ['Enter'])
      await program([{ from: at, insert: '\n\n' }])
      // Six blank lines stand above the next title now; all but the last are under a begun line.
      await stands(`two blank lines ${where}`, [...SLIDE, '', '', '', '', ''], { from: 0, to: 31 }, 27)
      await type('X')
      assert.equal((await facts()).text, '### Focus\n{id=f}\nParagraph\nX\n\n\n\n\n\n### After\n{id=a}\nAfter body', 'the X is typed on the caret\'s begun line')
    }
  })
  await check('B7. undo and redo are not the user\'s typing: words typed on a begun line are drawn again when redone; a redone program\'s slide is never drawn', async () => {
    // The caret moved before the words are typed: they are an undo step of their own, redone at the start of a begun line.
    await begin(REPRO, 'Paragraph', ['Enter', 'ArrowDown'])
    await type('abc')
    const typed = await stands('abc typed on the second begun line', [...SLIDE, '', 'abc', ''], { from: 0, to: 32 }, 31)
    await press('ControlOrMeta+z')
    await stands('the words undone', [...SLIDE, '', '', ''], { from: 0, to: 29 }, 28)
    await press('ControlOrMeta+Shift+z')
    await stands('the words redone', [...SLIDE, '', 'abc', ''], { from: 0, to: 32 }, 31)
    let steps = 0
    while ((await run(() => window.depths()))[0] > 0) { await press('ControlOrMeta+z'); await sound(`undo ${steps += 1}`); assert(steps < 50, 'the undo history ends') }
    assert.equal((await facts()).text, REPRO, 'all undone')
    while ((await run(() => window.depths()))[1] > 0) { await press('ControlOrMeta+Shift+z'); await sound(`redo ${steps += 1}`); assert(steps < 100, 'the redo history ends') }
    const redone = await stands('all redone', [...SLIDE, '', 'abc', ''], { from: 0, to: 32 })
    assert.equal(redone.text, typed.text, 'the text is the typed one')
    assert.equal(redone.caret.line, 5, 'and the caret is on the line of the words')
    // A program's slide under a begun line, undone and redone: at no step is it drawn.
    await begin(REPRO, 'Paragraph', ['Enter'])
    await program([{ from: 28, insert: REMOTE }])
    const inserted = (await facts()).text
    const hidden = async (what) => assert.equal((await sound(what)).drawn.some((line) => /Remote/.test(line)), false, `${what}: nothing of the program's slide is drawn`)
    await hidden('inserted')
    steps = 0
    while ((await run(() => window.depths()))[0] > 0) { await press('ControlOrMeta+z'); await hidden(`undo ${steps += 1}`); assert(steps < 50, 'the undo history ends') }
    assert.equal((await facts()).text, REPRO, 'all undone')
    while ((await run(() => window.depths()))[1] > 0) { await press('ControlOrMeta+Shift+z'); await hidden(`redo ${steps += 1}`); assert(steps < 100, 'the redo history ends') }
    assert.equal((await facts()).text, inserted, 'all redone: the program\'s slide is in the text again')
    assert.deepEqual((await facts()).drawn, SLIDE, 'and the focused slide alone is drawn')
  })
  await check('B8. a program\'s line on a begun line: with no title it is a line of the slide and drawn; a title is hidden and the next Enter does not write on it', async () => {
    await begin(REPRO, 'Paragraph', ['Enter', 'ArrowDown'])
    await program([{ from: 28, insert: 'Program words' }])
    await stands('words with no title on the second begun line', [...SLIDE, '', 'Program words', ''], { from: 0, to: 42 }, 28)
    // A title at the very start of the first begun line, the caret there: before ticket 15 the range ended at that
    // offset and took the insertion in; it is outside now.
    await begin(REPRO, 'Paragraph', ['Enter'])
    await program([{ from: 27, insert: REMOTE }])
    const inserted = (await facts()).text
    assert.equal(inserted, `### Focus\n{id=f}\nParagraph\n${REMOTE}\n\n\n\n### After\n{id=a}\nAfter body`, 'the program\'s slide stands directly under the paragraph')
    await stands('a slide inserted at the start of the first begun line', SLIDE, { from: 0, to: 26 }, 26)
    // The app's Enter on a title carries no user event and is not held back by the range guard: the caret must not be
    // on the hidden title when it is pressed.
    await press('Enter')
    const entered = await sound('Enter')
    assert.equal(entered.text, inserted.replace('Paragraph\n', 'Paragraph\n\n'), 'the Enter makes a line under the paragraph; the program\'s slide is unchanged')
    assert.deepEqual(entered.drawn, [...SLIDE, ''], 'the new line is the only blank line above the program\'s title and the user begun it: it is drawn, with the caret on it (it is not a separator that was there before)')
  })

  // ── W. Every column drawn can be written to ──
  await check('W. a begun line of spaces: Enter, ArrowDown, End, X: the X is typed after the spaces, and the range ends where the line ends', async () => {
    await begin(SPACES, 'Paragraph')
    await press('Enter')
    await stands('Enter at the end of the slide', [...SLIDE, '', '   '], { from: 0, to: 31 }, 27)
    await press('ArrowDown')
    await press('End')
    await stands('ArrowDown, End', [...SLIDE, '', '   '], { from: 0, to: 31 }, 31)
    await type('X')
    await stands('X typed', [...SLIDE, '', '   X'], { from: 0, to: 32 }, 32)
    assert.equal((await facts()).text, '### Focus\n{id=f}\nParagraph\n\n   X\n\n### After\n{id=a}\nAfter body', 'the X is after the three spaces; the blank line above the next title is the one that was there')
    // A space typed on an empty begun line: the range follows to the end of the line.
    await begin(REPRO, 'Paragraph', ['Enter'])
    await type('  ')
    await stands('two spaces typed on the begun line', [...SLIDE, '  ', '', ''], { from: 0, to: 31 }, 29)
    await press('ArrowDown'); await press('ArrowDown'); await press('ArrowDown')
    await type('X')
    assert.equal((await facts()).text, '### Focus\n{id=f}\nParagraph\n  \n\nX\n\n### After\n{id=a}\nAfter body', 'the caret goes down to the last begun line and no further; the X is typed there')
  })

  // ── T. The caret is brought back before any key or input acts ──
  /** True when `text` differs from `made.text` only on the lines drawn when `made` was read. */
  const confined = (made, text) => {
    const tail = made.text.slice(made.drawnTo)
    return text.startsWith(made.text.slice(0, made.range.from)) && text.endsWith(tail) && text.length - tail.length >= made.range.from
  }
  const sameTask = (act, key) => run(([a, k]) => window.sameTask(a, k), [act, key])
  await check('T0. the second review\'s reproduction: a program\'s slides on the caret\'s begun line and Enter in the same task: the Enter is made at the end of the focused slide', async () => {
    await begin(REPRO, 'Paragraph', ['Enter', 'ArrowDown'])
    await stands('the caret on the second begun line', [...SLIDE, '', '', ''], { from: 0, to: 29 }, 28)
    const made = await sameTask({ changes: [{ from: 28, insert: REVIEW }] }, 'Enter')
    await settle()
    assert.equal(made.text, `### Focus\n{id=f}\nParagraph\n\n${REVIEW}\n\n\n### After\n{id=a}\nAfter body`, 'the program\'s slides are in the text')
    assert.deepEqual(made.range, { from: 0, to: 26 }, 'the stored range between the change and the key')
    const entered = await sound('Enter in the same task')
    assert.equal(entered.text, made.text.replace('Paragraph\n', 'Paragraph\n\n'), 'the Enter makes a line under the paragraph; the program\'s slides are unchanged')
    assert.deepEqual(entered.drawn, [...SLIDE, ''], 'the line it made is drawn, and nothing of the program\'s slides')
    assert.equal(entered.caret.pos, 27, 'the caret is on that line')
  })
  // Each shape of change in B0 to B8, and a program's selection on its own slide. [name, document, keys before, the
  // change]; a function is given the facts before the change and returns it.
  const SHAPES = [
    ['B0 a slide on the caret\'s begun line', REPRO, ['Enter', 'ArrowDown'], { changes: [{ from: 28, insert: REMOTE }] }],
    ['B1 a slide under the caret\'s begun line', REPRO, ['Enter'], { changes: [{ from: 28, insert: REMOTE }] }],
    ['B2 text at the end of the slide\'s text', REPRO, ['Enter'], { changes: [{ from: 26, insert: '\nMore words' }] }],
    ['B3 the blank line above the next title deleted', ONE, ['Enter'], { changes: [{ from: 28, to: 29 }] }],
    ['B4 text inside the slide\'s text', REPRO, ['Enter'], { changes: [{ from: 20, insert: ' more ' }] }],
    ['B5 a save\'s adoption of the id line', NO_ID, ['Enter'], (now) => ({ adopt: [now.text, stampMissingIds(now.text).text] })],
    ['B6 blank lines at the end of the last begun line', REPRO, ['Enter'], { changes: [{ from: 29, insert: '\n\n' }] }],
    ['B6 blank lines above the next title', REPRO, ['Enter'], { changes: [{ from: 31, insert: '\n\n' }] }],
    ['B7 the words typed on a begun line undone', REPRO, ['Enter', 'ArrowDown', 'a', 'b'], { history: 'undo' }],
    ['B7 the words typed on a begun line redone', REPRO, ['Enter', 'ArrowDown', 'a', 'b', 'ControlOrMeta+z'], { history: 'redo' }],
    ['B7 a program\'s slide undone', REPRO, ['Enter', 'ArrowDown', { changes: [{ from: 28, insert: REMOTE }] }], { history: 'undo' }],
    ['B7 a program\'s slide redone', REPRO, ['Enter', 'ArrowDown', { changes: [{ from: 28, insert: REMOTE }] }, 'ControlOrMeta+z'], { history: 'redo' }],
    ['B8 words with no title on a begun line', REPRO, ['Enter', 'ArrowDown'], { changes: [{ from: 28, insert: 'Program words' }] }],
    ['B8 a title at the start of the first begun line', REPRO, ['Enter'], { changes: [{ from: 27, insert: REMOTE }] }],
    ['a program\'s selection on a title of its own slide', REPRO, ['Enter'], { changes: [{ from: 28, insert: REVIEW }], cursor: 38 }],
    ['a program\'s selection on a list item of its own slide', REPRO, ['Enter', 'ArrowDown'], { changes: [{ from: 28, insert: LISTED }], cursor: 28 + LISTED.length - 1 }]
  ]
  for (const key of ['Enter', 'x', 'Tab', 'Backspace', 'paste']) {
    await check(`T. a change that is not the user's and ${key === 'x' ? 'a typed letter' : key === 'paste' ? 'a paste' : key} in the same task: nothing changes outside the lines drawn`, async () => {
      for (const [name, doc, keys, change] of SHAPES) {
        await begin(doc, 'Paragraph')
        for (const step of keys) {
          if (typeof step !== 'string') await program(step.changes)
          else if (step.length === 1) await page.keyboard.type(step)
          else await press(step)
        }
        const before = await sound(`${name}: before the change`)
        const made = await sameTask(typeof change === 'function' ? change(before) : change, key)
        await settle()
        const what = `${name}, then ${key}`
        assert.notEqual(made.text, before.text, `${what}: the change was made`)
        const after = await sound(what)
        assert(confined(made, after.text), `${what}: the key changed the text outside the lines drawn after the change (${made.range.from} to ${made.drawnTo}): ${JSON.stringify(made.text)} became ${JSON.stringify(after.text)}`)
      }
    })
  }

  // ── I. A letter being composed ──
  const cdp = await page.context().newCDPSession(page)
  const compose = async (text) => { await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }); await settle() }
  await check('I1. the second review\'s reproduction: a program\'s selection under the caret\'s line while a letter is composed: the caret stays and the letter is written once', async () => {
    await begin(REPRO, 'Paragraph')
    await run(() => window.pasted(26, '\n ')); await settle()
    await stands('a line of one space pasted', [...SLIDE, ' ', '', ''], { from: 0, to: 30 }, 28)
    await compose('ž')
    assert.equal(await run(() => window.composing()), true, 'the browser is composing')
    assert.equal((await sound('ž being composed')).caret.pos, 29, 'the caret is after the ž')
    await program([{ from: 30, insert: REVIEW }], 40)
    const under = await sound('a program\'s slides under the line, its selection on their first title')
    assert.equal(under.caret.pos, 29, 'the caret has not moved')
    assert.deepEqual(under.drawn, [...SLIDE, ' ž'], 'nothing of the program\'s slides is drawn')
    assert.equal(await run(() => window.composing()), true, 'the composition goes on')
    await compose('žlu')
    assert.equal((await sound('žlu being composed')).text, `### Focus\n{id=f}\nParagraph\n žlu\n${REVIEW}\n\n\n### After\n{id=a}\nAfter body`, 'the letters composed stand once')
    await cdp.send('Input.insertText', { text: 'žluť' }); await settle()
    const done = await stands('žluť written', [...SLIDE, ' žluť'], { from: 0, to: 32 }, 32)
    assert.equal(done.text, `### Focus\n{id=f}\nParagraph\n žluť\n${REVIEW}\n\n\n### After\n{id=a}\nAfter body`, 'the word is written once, on the caret\'s line; the program\'s slides are unchanged')
    assert.equal(await run(() => window.composing()), false, 'the composition has ended')
  })
  await check('I2. the begun lines under a letter being composed are held out of the range and drawn again when the composition ends', async () => {
    // Ended by its last change.
    await begin(REPRO, 'Paragraph', ['Enter'])
    await stands('a line begun', [...SLIDE, '', '', ''], { from: 0, to: 29 }, 27)
    await compose('ž')
    await stands('ž being composed on the begun line', [...SLIDE, 'ž'], { from: 0, to: 28 }, 28)
    await cdp.send('Input.insertText', { text: 'žl' }); await settle()
    await stands('žl written', [...SLIDE, 'žl', '', ''], { from: 0, to: 31 }, 29)
    await press('ArrowDown'); await press('ArrowDown'); await press('ArrowDown')
    await type('X')
    assert.equal((await facts()).text, '### Focus\n{id=f}\nParagraph\nžl\n\nX\n\n### After\n{id=a}\nAfter body', 'the caret goes down to the last begun line again and the X is typed there')
    // Ended with no further change: the editor loses the keyboard while the letter is composed.
    await begin(REPRO, 'Paragraph', ['Enter'])
    await compose('ž')
    await stands('ž being composed on the begun line', [...SLIDE, 'ž'], { from: 0, to: 28 }, 28)
    await run(() => window.blur()); await settle()
    assert.equal(await run(() => window.composing()), false, 'the composition has ended')
    await run(() => window.refocus()); await settle()
    await stands('the composition ended with the ž as it was', [...SLIDE, 'ž', '', ''], { from: 0, to: 30 })
    // Ended with no further change and no other transaction: the composition's own end event.
    await begin(REPRO, 'Paragraph', ['Enter'])
    await compose('ž')
    await stands('ž being composed on the begun line', [...SLIDE, 'ž'], { from: 0, to: 28 }, 28)
    await run(() => window.endComposition()); await settle()
    assert.equal(await run(() => window.composing()), false, 'the composition has ended')
    await stands('the composition ended by its event alone', [...SLIDE, 'ž', '', ''], { from: 0, to: 30 }, 28)
    // A change of the composition read after it has ended (the editor still marks it as composed).
    await begin(REPRO, 'Paragraph', ['Enter'])
    await compose('ž')
    await run(() => window.endComposition()); await settle()
    await run(() => window.composed(28, 'l')); await settle()
    await stands('a letter of the composition read late', [...SLIDE, 'žl', '', ''], { from: 0, to: 31 }, 29)
    // The caret's line blank: nothing is held.
    await begin(REPRO, 'Paragraph', ['Enter'])
    await compose('ž')
    await compose('')
    await sound('the composed letter taken back')
  })

  // ── R. The random run ──
  await check('R. random: the user\'s keys at the end of the slide and a program\'s changes around the end of the range', async () => {
    const random = seeded(SEED)
    const below = (n) => Math.floor(random() * n)
    const pick = (list) => list[below(list.length)]
    const weighted = (pairs) => pick(pairs.flatMap(([value, weight]) => Array(weight).fill(value)))
    const DOCS = [
      REPRO, ONE, SPACES,
      '### Before\n{id=b}\nBefore body\n\n### Focus\n{id=f}\nParagraph',
      '### Before\n{id=b}\nBefore body\n\n### Focus\n{id=f}\nParagraph\n',
      '### Before\n{id=b}\n- before item\n\n### Focus\n{id=f}\n- one\n- two\n\n\n### After\n{id=a}\n- after item\n\n### Last\nLast body\n',
      '# Talk\n\n### Focus\n{id=f}\n\n> Quoted words.\n\n### After\n- after item\n- another',
      '### Focus\n### After\n{id=a}\nAfter body'
    ]
    const KEYS = [['Enter', 6], ['x', 5], [' ', 2], ['-', 1], ['>', 1], ['Backspace', 4], ['Delete', 2], ['ArrowDown', 3], ['ArrowUp', 1], ['ArrowLeft', 1], ['ArrowRight', 1], ['End', 1], ['Home', 1], ['Tab', 1]]
    const TEXTS = [['y', 2], ['\n', 3], ['\n\n', 1], ['  ', 1], ['prog words\n', 2], ['\nprog words', 1], ['- prog item\n', 1]]
    const SLIDES = ['### Prog\n{id=p}\nprog body\n', '\n### Prog\nprog body', '## Part\n\n### Prog\n- prog item\n']
    const titles = (text) => text.split('\n').filter((line) => /^#{1,6}\s/.test(line)).length
    const counts = { keys: 0, kept: 0, insertions: 0, slides: 0, deletions: 0, skipped: 0, titled: 0, same: 0 }
    /** Where the focused slide's title and the next title start in a text. */
    const bounds = (text) => {
      const titleFrom = text.startsWith(TITLE) ? 0 : text.indexOf(`\n${TITLE}`) + 1
      const next = text.slice(titleFrom + 1).search(/\n#{1,6}\s/)
      return { titleFrom, nextFrom: next < 0 ? -1 : titleFrom + next + 2 }
    }
    /** What a key of the user's may not do to the text it was pressed in. True when the key made a title. */
    const keyed = (key, was, after) => {
      if (after.text.slice(0, after.titleFrom) !== was.text.slice(0, was.titleFrom)) fail(`the key ${key} changed the text before the focused slide: ${JSON.stringify(after.text)}`)
      const rest = was.nextFrom < 0 ? '' : was.text.slice(was.nextFrom)
      if (!after.text.endsWith(rest)) fail(`the key ${key} changed the text from the next title on: ${JSON.stringify(after.text)}`)
      // No title is lost to a key: the line break in front of the next title is not the focused slide's to delete.
      if (titles(after.text) < titles(was.text)) fail(`the key ${key} took a title out: ${JSON.stringify(after.text)}`)
      return titles(after.text) > titles(was.text)
    }
    let fail = null
    let operations = 0
    for (let round = 0; round < ROUNDS; round += 1) {
      const doc = DOCS[round % DOCS.length]
      await run((d) => window.mount(d), doc)
      assert.equal(await run((n) => window.enterFocus(n), doc.split('\n').indexOf(TITLE) + 1), true, 'the slide is focused')
      await run((at) => window.pointer(at), (await facts()).contentEnd)
      const log = []
      let before = await facts()
      fail = (message) => { throw new Error(`seed ${SEED}, round ${round}, operation ${log.length}: ${message}\nthe last operations: ${log.slice(-10).join(' | ')}\nthe text before: ${JSON.stringify(before.text)}`) }
      if (before.problems.length) fail(before.problems.join('; '))
      for (let step = 0; step < STEPS; step += 1) {
        let after
        if (random() < 0.55) {
          // A key of the user's. On the title line the caret is put at the end of the slide's text first (the title is
          // how this test finds the slide; a key that cuts it is no part of what is tested).
          let key = weighted(KEYS)
          if (before.caret.line === before.titleLine) {
            await run((at) => window.pointer(at), before.contentEnd)
            if ((await facts()).caret.line === before.titleLine && key !== 'x' && key !== 'Enter') key = 'x'
          }
          log.push(`key ${JSON.stringify(key)}`)
          if (key.length === 1) await page.keyboard.type(key); else await page.keyboard.press(key)
          after = await facts()
          counts.keys += 1
          if (after.text === before.text) counts.kept += 1
          // Left out: the key made a title inside the focused slide (Enter in front of `## …` on one of its lines,
          // the indent in front of it deleted). Slide Focus does not take the range in for it: a fault from before
          // ticket 15. The round ends there.
          if (keyed(key, before, after)) { counts.titled += 1; operations += 1; break }
        } else {
          // A program's change around the end of the slide: from a few characters before the end of its text to a few
          // characters into the next slide, never in the title line.
          const lo = Math.max(before.titleTo, before.contentEnd - 4)
          const hi = Math.min(before.text.length, before.nextFrom < 0 ? before.text.length : before.nextFrom + 8)
          const kind = weighted([['text', 5], ['slide', 3], ['delete', 4], ['inside', 1]])
          let change = null
          if (kind === 'text') change = { from: lo + below(hi - lo + 1), insert: weighted(TEXTS) }
          else if (kind === 'slide' && hi > before.contentEnd) change = { from: before.contentEnd + 1 + below(hi - before.contentEnd), insert: pick(SLIDES) }
          else if (kind === 'delete' && hi > lo) { const from = lo + below(hi - lo); change = { from, to: Math.min(hi, from + 1 + below(7)) } }
          else if (kind === 'inside' && before.titleTo < before.text.length) change = { from: before.titleTo + 1, insert: 'note\n' }
          const result = change && before.text.slice(0, change.from) + (change.insert ?? '') + before.text.slice(change.to ?? change.from)
          // Left out: a change that makes a title where there was none, other than a whole slide put after the
          // slide's text (a title made inside the range by a change inside it is a fault from before ticket 15).
          if (!change || (kind !== 'slide' && titles(result) > titles(before.text))) { counts.skipped += 1; continue }
          // Half the time the user's next key is pressed in the same task as the change: nothing has run between
          // them, and the key must find the caret in the slide all the same.
          // And a third of the insertions set the caret on what they insert, as a program's change can.
          const key = random() < 0.5 ? weighted(KEYS) : null
          const cursor = change.insert && random() < 0.34 ? change.from + below(change.insert.length + 1) : null
          log.push(`program ${JSON.stringify(change)}${cursor == null ? '' : `, its caret at ${cursor}`}${key ? `, in the same task the key ${JSON.stringify(key)}` : ''}`)
          const made = await run(([c, at, k, title]) => window.sameTask({ changes: [c], cursor: at }, k, title), [change, cursor, key, TITLE])
          if (made.text !== result) fail(`the program's change was not made as given: ${JSON.stringify(made.text)}`)
          counts[kind === 'delete' ? 'deletions' : kind === 'slide' ? 'slides' : 'insertions'] += 1
          if (made.keyed) await settle()
          after = await facts()
          if (made.keyed) {
            counts.same += 1
            counts.keys += 1
            operations += 1
            if (after.text === made.text) counts.kept += 1
            if (!confined(made, after.text)) fail(`the key ${key}, in the same task as the program's change, changed the text outside the lines drawn after the change (${made.range.from} to ${made.drawnTo}): ${JSON.stringify(made.text)} became ${JSON.stringify(after.text)}`)
            if (keyed(key, { text: made.text, ...bounds(made.text) }, after)) { counts.titled += 1; operations += 1; break }
          }
        }
        operations += 1
        if (after.problems.length) fail(`${after.problems.join('; ')}\nthe text after: ${JSON.stringify(after.text)}`)
        before = after
      }
    }
    assert(operations >= 2000 || ROUNDS < 48, `a few thousand operations are run (${operations})`)
    summary = `random run, seed ${SEED}: ${operations} operations in ${ROUNDS} rounds (${counts.keys} keys of the user's, ${counts.kept} of them changing nothing; a program's ${counts.insertions} insertions of text, ${counts.slides} of a slide, ${counts.deletions} deletions, ${counts.same} of them with the user's next key in the same task; ${counts.skipped} left out; ${counts.titled} rounds ended at a title made by a key)`
  })

  if (REPORT) {
    console.log(`${ran} cases run, ${failures.length} failed`)
    for (const failure of failures) console.log(`FAIL ${failure}`)
    if (summary) console.log(summary)
  } else {
    if (summary) console.log(summary)
    console.log(`slide focus range containment ok: ${ran} cases; a change that is not the user's brings no other slide into the focused slide, a caret it leaves outside is put back before any key acts, a letter being composed is written once, and every column drawn can be written to`)
  }
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
