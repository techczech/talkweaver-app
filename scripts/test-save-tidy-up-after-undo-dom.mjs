// The save's layout-line tidy-up and the undo history (issue 131: ⌘Z could not get past the
// tidy-up, because the save after each ⌘Z made it again).
//
// The rules held here. The save's tidy-up comes back into the editor with the save's ids as one undo
// step, which ⌘Z takes back together with the user's change below it (extensions/savedTextAdoption.ts,
// issue 201). A save whose most recent document change was an undo or a redo does not tidy and is not
// adopted (extensions/saveTidyUp.ts); every other save tidies.
//
// A real CodeMirror editor in a browser (Playwright's chromium headless shell), in the Markdown
// view and in the Plain view, with the app's keys, the save's step (savedTextAdoption.ts) and the
// state the save reads (saveTidyUp()). The save is the app's: the text to write comes from
// textForSave, the function Editor.tsx's three saves call; the editor is not tidied first; the text
// is stamped as the main process stamps it (stampMissingIds, ids on "disk" preferred); what was
// written is adopted from the text the save was made from. A save is followed by the saves its own
// changes schedule, until one changes nothing. After every adopted save the file is the editor's text.
//
//   1. the issue's document (`### A`, blank, `{pyramid}`, blank, bullets), with and without ids:
//      type, save, ONE ⌘Z gives the first text; a save after it changes nothing in the editor and
//      the file keeps the slide's id; redo gives the tidied text;
//   2. a layout chosen in the picker (its write, then the autosave) and in the margin menu (the
//      replace seam, saved at once): the same;
//   3. three changes with saves between: every one is reached by ⌘Z, and redo gives the last text;
//   4. type, save, ⌘Z, save, type, save: the tidy-up runs again; a layout chosen after a redo is tidied;
//   5. a document that needs no tidy-up: the same texts and undo depths, step for step, as with a
//      save that always tidies (the save before this rule);
//   6. a save with nothing changed;
//   7. generated runs (fixed seeds): typing, layout changes, layout lines put out of place, saves,
//      undo and redo; then ⌘Z with a save after every press ends within a bound at the first text,
//      byte for byte, and redo with saves between gives the last text, byte for byte. No typed
//      marker is ever cut or doubled.
//
//   node scripts/test-save-tidy-up-after-undo-dom.mjs [--print] [--only=N]
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { preferredIdsFromText, stampMissingIds } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { normalizePositions } from '../src/shared/outline-normalize.ts'

const PRINT = process.argv.includes('--print')
// --only=3 runs one numbered group of cases (to see each group fail on its own without the rule).
const ONLY = Number(process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? 0)
const wants = (n) => !ONLY || ONLY === n
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-save-tidy-up-'))
const outfile = join(dir, 'bundle.js')

const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment, Prec } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, undoDepth, redoDepth } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { search } from '@codemirror/search'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { focusScopeExtension } from './src/renderer/src/extensions/focusScope.ts'
import { frontmatterTableExtension } from './src/renderer/src/extensions/frontmatterTable.ts'
import { editorBaseKeymap } from './src/renderer/src/extensions/editorBaseKeymap.ts'
import { buildEditorKeyBindings } from './src/renderer/src/keymap/store.ts'
import { adoptSavedText, savedTextAdoption } from './src/renderer/src/extensions/savedTextAdoption.ts'
import { saveFollowsUndoOrRedo, saveTidyUp, textForSave } from './src/renderer/src/extensions/saveTidyUp.ts'
import { applyMinimalChange } from './src/renderer/src/lib/minimalChange.ts'
import { normalizePositions } from './src/shared/outline-normalize.ts'
import { chooseLayout, setLayout } from './src/shared/layout-verbs.ts'
import { appKeyState, failOnCaughtExceptions } from './scripts/lib/plain-view-test-mount.mjs'

let view = null
window.mount = (doc, mode) => {
  if (view) view.destroy()
  document.getElementById('host').innerHTML = ''
  view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [
      history(), markdown({ base: markdownLanguage, codeLanguages: languages }),
      tokenProtectExtension(), focusScopeExtension(), frontmatterTableExtension(), appKeyState(), search(),
      keymap.of([...editorBaseKeymap]),
      Prec.highest(keymap.of(buildEditorKeyBindings())),
      new Compartment().of(viewModeExtension(mode)),
      EditorView.lineWrapping,
      // As Editor.tsx: the id adoption, then the state the save's tidy-up decision reads.
      savedTextAdoption(),
      saveTidyUp(),
      failOnCaughtExceptions()
    ]
  }) })
  view.focus()
}
const text = () => view.state.doc.toString()
window.docText = text
window.depths = () => ({ undo: undoDepth(view.state), redo: redoDepth(view.state) })
window.adopt = (source, saved) => adoptSavedText(view, source, saved)
window.followsUndo = () => saveFollowsUndoOrRedo(view.state)
window.refocus = () => view.focus()
// The save's text, as Editor.tsx's saves make it: the text the save writes, and the editor's text it is
// made from (the editor is not tidied first). \`always\`: a save that tidies every time, after an undo too.
const tidy = (always) => {
  const source = text()
  return { source, sent: always ? normalizePositions(source) : textForSave(view.state, source) }
}
window.textForSave = (always) => tidy(always)
const lineNumberOf = (lineText) => text().split('\\n').indexOf(lineText) + 1
window.setCaret = (lineText) => {
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(lineNumberOf(lineText)).to) })
  view.focus()
}
// Typing at the end of a line, and a line break typed after a line (the generated runs).
window.typeAtLineEnd = (n, insert) => view.dispatch({ changes: { from: view.state.doc.line(n).to, insert }, userEvent: 'input.type' })
// The Inspector picker's write: the new Trigger line as one ordinary change; the autosave follows.
window.pickerWrite = (headingLine, layout) => {
  let next
  try { next = setLayout(text(), { headingLine }, layout).outline } catch { return false }
  const change = applyMinimalChange(text(), next)
  if (!change) return false
  view.dispatch({ changes: change })
  return true
}
// The margin menu's write, through Editor.tsx's replace seam with \`save: true\`: the new text as one
// change, then the save's text at once. The texts of the save, or null when the menu wrote nothing.
window.menuWrite = (headingLine, layout, always) => {
  const write = chooseLayout(text(), { headingLine }, layout)
  if (!write.ok) return null
  const change = applyMinimalChange(text(), write.text)
  if (change) view.dispatch({ changes: change })
  return tidy(always)
}
`

const J = (...lines) => lines.join('\n')
// The issue's document, and the same after saves have stamped it.
const ISSUE = J('### A', '', '{pyramid}', '', '- one', '- two', '- three', '')
const ISSUE_IDS = J('### A', '', '{pyramid} {id=aaaa1}', '', '- one', '- two', '- three', '')
const TIDY = J('### A', '{pyramid} {id=aaaa1}', '', '- one', '- two', '- three', '')
// Several slides with layout lines out of place: after a blank line, after two, and on the heading.
const MANY = (ids) => J(
  '# Talk', '',
  '## Part one', ...(ids ? ['{id=part1}'] : []), '',
  '### Alpha', '', ids ? '{pyramid} {id=alph1}' : '{pyramid}', '', '- alpha one', '- alpha two', '- alpha three', '',
  '### Bravo', ...(ids ? ['{id=brav1}'] : []), '', '- bravo one', '- bravo two', '- bravo three', '',
  ids ? '### Charlie {cards}' : '### Charlie {cards}', ...(ids ? ['{id=char1}'] : []), '', '- charlie one', '- charlie two', '- charlie three', '',
  '## Part two', ...(ids ? ['{id=part2}'] : []), '',
  '### Delta', '', '', ids ? '{id=delt1} {timeline}' : '{timeline}', '- delta one', '- delta two', '- delta three', ''
)
// A text without the ids saves stamped, and without the space an id went in with. That space can stay
// on the layout line when the id leaves it: a save stamps \`{pyramid}\` as \`{pyramid} {id=x}\`, the
// picker's write of another layout replaces \`pyramid} \` (the space with it), and ⌘Z of that write
// puts \`{pyramid} \` back while the id is settled onto a line of its own (savedTextAdoption.ts). Not
// this file's subject, and so in a tidy talk too; reported with issue 131. The same space can be left
// alone on a blank line when ⌘Z takes back a tidy-up that ran before the ids were stamped (the
// tidy-up is one replacement that spans every slide it moved a line in; the ids went in inside it).
const withoutIds = (t) => t.split('\n').filter((l) => !/^\{id=[^}]+\}$/.test(l)).join('\n').replace(/ ?\{id=[^}]+\} ?/g, '').replace(/^((?:\{[^}\n]*\})+) +$/gm, '$1').replace(/^ +$/gm, '')
/** heading -> its id, read the way the save reads it. */
const idByHeading = (t) => Object.fromEntries([...preferredIdsFromText(t)])
// The same text with every id on the slide it was on. Where on the slide's first lines an id stands
// after an undo or a redo is the id adoption's to decide (on the layout line, or a line of its own
// under the heading: savedTextAdoption.ts settle), and is not compared. \`exact\`: byte for byte.
const sameText = (actual, expected, message, exact = false) => {
  if (exact) return assert.equal(actual, expected, message)
  assert.equal(withoutIds(actual), withoutIds(expected), message)
  assert.deepEqual(idByHeading(actual), idByHeading(expected), `${message}: every id on its own slide`)
  assert.equal(new Set(idsOf(actual)).size, idsOf(actual).length, `${message}: no id twice`)
}
const idsOf = (t) => [...t.matchAll(/\{id=([^}]+)\}/g)].map((m) => m[1])
const MODES = ['markdown', 'plain']
const GROUPING = 560 // past CodeMirror's 500 ms grouping; the autosave runs 1.5 s after a change

let browser
let passed = 0
const pass = (message) => { passed += 1; console.log(`PASS ${message}`) }
try {
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'save-tidy-up-entry.ts', loader: 'ts' },
    bundle: true, format: 'iife', platform: 'browser', outfile, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<!doctype html><html><body><div id="host" style="width:700px;height:600px;overflow:auto"></div></body></html>')
  await page.addScriptTag({ content: readFileSync(outfile, 'utf8') })

  const doc = () => page.evaluate(() => window.docText())
  const depths = () => page.evaluate(() => window.depths())
  const undoKey = async () => { await page.evaluate(() => window.refocus()); await page.keyboard.press('Meta+z') }
  const redoKey = async () => { await page.evaluate(() => window.refocus()); await page.keyboard.press('Meta+Shift+z') }
  const pause = () => page.waitForTimeout(GROUPING)

  let disk = ''
  /** Every save always tidies: the save as it was before issue 131's rule (case 5's reference). */
  let alwaysTidy = false
  /** The main process's part: stamp (ids on disk preferred), write, and the editor adopts what was written. */
  const write = async ({ source, sent }) => {
    assert.equal(await doc(), source, 'the save is made from the text the editor holds')
    const followsUndo = await page.evaluate(() => window.followsUndo())
    let preferred = null
    try { preferred = preferredIdsFromText(disk) } catch { /* nothing readable on disk */ }
    const stamped = stampMissingIds(sent, undefined, { preferred })
    disk = stamped.text
    await page.evaluate(([a, b]) => window.adopt(a, b), [source, stamped.text])
    if (followsUndo) assert.equal(await doc(), source, 'a save straight after an undo or a redo is not adopted')
    else assert.equal(await doc(), disk, 'after the save the file is exactly the editor\'s text')
  }
  /** The saves one change leads to: each change a save makes to the text schedules the next, until one makes none. */
  const settleSaves = async (first) => {
    let before = first
    let stepsAfterFirst = null
    for (let round = 0; round < 4; round += 1) {
      if (round > 0) await write(await page.evaluate((always) => window.textForSave(always), alwaysTidy))
      const now = await doc()
      if (round > 0 && now === before) {
        assert.deepEqual(await depths(), stepsAfterFirst, 'the saves that follow a save add no undo step')
        return
      }
      if (round === 0) stepsAfterFirst = await depths()
      else stepsAfterFirst = stepsAfterFirst && round === 1 ? await depths() : stepsAfterFirst
      before = now
    }
    assert.fail('the saves do not come to rest: each one changes the text again')
  }
  /** The autosave (or flushSave). */
  const save = async () => {
    await write(await page.evaluate((always) => window.textForSave(always), alwaysTidy))
    await settleSaves(await doc())
  }
  /** The margin menu: the write and its save at once (the replace seam). False when the menu wrote nothing. */
  const menuWrite = async (headingLine, layout) => {
    const texts = await page.evaluate(([l, name, always]) => window.menuWrite(l, name, always), [headingLine, layout, alwaysTidy])
    if (texts == null) return false
    await write(texts)
    await settleSaves(await doc())
    return true
  }
  const open = async (text, mode) => { disk = text; await page.evaluate(([t, m]) => window.mount(t, m), [text, mode]) }
  const typeAfter = async (lineText, typed) => { await page.evaluate((l) => window.setCaret(l), lineText); await page.keyboard.type(typed) }
  const lineNumber = (text, line) => { const i = text.split('\n').indexOf(line); assert(i >= 0, `the text has "${line}"`); return i + 1 }
  /** ⌘Z with a save after every press until no undo step is left: the texts seen after each press. */
  const undoAll = async (bound) => {
    const seen = []
    let presses = 0
    while ((await depths()).undo > 0) {
      assert.ok(presses < bound, `⌘Z with a save after each press ends within ${bound} presses`)
      const depthBefore = (await depths()).undo
      await undoKey(); presses += 1
      seen.push(await doc())
      await save()
      assert.equal(await doc(), seen.at(-1), 'the save after a ⌘Z leaves the text as the ⌘Z left it')
      assert.ok((await depths()).undo < depthBefore, 'and each ⌘Z takes a step off the history (a save\'s step with the change below it)')
    }
    return seen
  }
  const redoAll = async (bound) => {
    const seen = []
    let presses = 0
    while ((await depths()).redo > 0) {
      assert.ok(presses < bound, `redo with a save after each press ends within ${bound} presses`)
      const depthBefore = (await depths()).redo
      await redoKey(); presses += 1
      seen.push(await doc())
      await save()
      assert.equal(await doc(), seen.at(-1), 'the save after a redo leaves the text as the redo left it')
      assert.ok((await depths()).redo < depthBefore, 'and each redo takes a step (the change with the save\'s step above it)')
    }
    return seen
  }

  for (const mode of MODES) {
    // ── 1. The issue: type, save, ⌘Z, save, ⌘Z ──
    if (wants(1)) for (const [name, first] of [['no ids yet', ISSUE], ['ids stamped', ISSUE_IDS]]) {
      await open(first, mode)
      await typeAfter('- one', ' more')
      const typed = await doc()
      assert.equal(withoutIds(typed), withoutIds(first).replace('- one', '- one more'), 'the typing is in the text')
      await pause()
      await save()
      const tidied = await doc()
      assert.equal(withoutIds(tidied), J('### A', '{pyramid}', '', '- one more', '- two', '- three', ''), 'the save tidies: the layout line is under its heading')
      assert.equal(idsOf(tidied).length, 1, 'and the slide has its id')
      const id = idsOf(tidied)[0]
      assert.equal((await depths()).undo, 2, 'two undo steps: the typing, and the save\'s tidy-up and ids')
      await undoKey()
      assert.equal(await doc(), first, 'ONE ⌘Z undoes the typing and the save\'s step: the first text exactly')
      const back = await doc()
      await save()
      assert.equal(await doc(), back, 'the save after the ⌘Z leaves it so')
      assert.deepEqual(await depths(), { undo: 0, redo: 2 })
      assert.deepEqual(idsOf(disk), [id], 'the file keeps the id the save stamped, once')
      await undoKey(); await save()
      assert.equal(await doc(), back, 'a further ⌘Z does nothing')
      await redoKey(); await save()
      assert.equal(await doc(), tidied, 'redo: exactly the tidied text the first save left')
      assert.deepEqual(await depths(), { undo: 2, redo: 0 })
      pass(`${mode}, ${name}: type, save (tidies), one ⌘Z gives the first text; redo gives the tidied text`)
    }

    // ── 2. A layout chosen: the picker's write and the margin menu's ──
    if (wants(2)) for (const [name, first] of [['no ids yet', ISSUE], ['ids stamped', ISSUE_IDS]]) {
      for (const how of ['picker', 'menu']) {
        await open(first, mode)
        if (how === 'picker') {
          assert.equal(await page.evaluate(() => window.pickerWrite(1, 'cards')), true, 'the picker wrote the layout')
          await pause()
          await save()
        } else {
          assert.equal(await menuWrite(1, 'cards'), true, 'the menu wrote the layout')
        }
        const tidied = await doc()
        assert.equal(withoutIds(tidied), J('### A', '{cards}', '', '- one', '- two', '- three', ''), 'the layout is changed and its line tidied')
        const seen = await undoAll(4)
        assert.equal(seen.length, 1, 'the change and the save\'s step are undone by one ⌘Z')
        assert.equal(await doc(), first, 'after it the first text is back exactly: {pyramid}, where it was')
        assert.deepEqual(idsOf(disk), idsOf(tidied), 'the file keeps the slide\'s id')
        await redoAll(4)
        sameText(await doc(), tidied, 'redo gives the tidied text with the new layout', true)
        assert.equal(normalizePositions(await doc()), await doc(), 'which is tidy')
        pass(`${mode}, ${name}: a layout chosen in the ${how} is undone by ⌘Z across the saves (${seen.length} press${seen.length > 1 ? 'es' : ''}), and redone`)
      }
    }

    // ── 3. Three changes with saves between ──
    if (wants(3)) for (const [name, first] of [['no ids yet', ISSUE], ['ids stamped', ISSUE_IDS]]) {
      await open(first, mode)
      const after = []
      await typeAfter('- one', ' first'); await pause(); await save(); after.push(await doc()); await pause()
      assert.equal(await page.evaluate(() => window.pickerWrite(1, 'timeline')), true); await pause(); await save(); after.push(await doc()); await pause()
      await typeAfter('- three', ' third'); await pause(); await save(); after.push(await doc())
      assert.ok(after[0].includes('- one first') && !after[0].includes('{timeline}'))
      assert.ok(after[1].includes('{timeline}') && !after[1].includes('- three third'))
      assert.ok(after[2].includes('- three third'))
      for (const text of after) assert.equal(normalizePositions(text), text, 'each save left a tidied text')
      const seen = await undoAll(10)
      // Each change is reached: the text before it shows up on the way back, in order.
      const shapes = seen.map((t) => normalizePositions(withoutIds(t)))
      const at = [after[1], after[0], first].map((t) => shapes.indexOf(normalizePositions(withoutIds(t))))
      assert.ok(at.every((i) => i >= 0), `every change is undone on the way back: ${JSON.stringify(at)}`)
      assert.ok(at[0] < at[1] && at[1] < at[2], `in order, the last change first: ${JSON.stringify(at)}`)
      assert.equal(withoutIds(await doc()), withoutIds(first), 'at the end the first text')
      const forward = await redoAll(10)
      assert.equal(forward.length, seen.length, 'redo walks the same number of steps forward')
      sameText(await doc(), after[2], 'and ends at the last tidied text', true)
      assert.equal(normalizePositions(await doc()), await doc(), 'which is tidy')
      pass(`${mode}, ${name}: three changes with saves between are each undone (${seen.length} ⌘Z), then redone to the last text`)
    }

    // ── 4. undo, save, type, save: the tidy-up runs again ──
    if (wants(4)) {
      await open(ISSUE_IDS, mode)
      await typeAfter('- one', ' more'); await pause(); await save()
      await undoKey(); await save()
      assert.equal(await doc(), ISSUE_IDS, 'after ⌘Z and its save: the typing and its tidy-up are gone, the layout line where it was')
      assert.equal(disk, ISSUE_IDS, 'the file too: the save after the ⌘Z does not tidy')
      await pause()
      await typeAfter('- two', ' too')
      await pause(); await save()
      const tidiedToo = TIDY.replace('- two', '- two too')
      assert.equal(await doc(), tidiedToo, 'the save after new typing tidies again')
      await undoKey(); await save()
      assert.equal(await doc(), ISSUE_IDS, 'and the tidy-up and that typing are undone by one ⌘Z')
      // A redo is not typing either: the save after it writes the text as the redo left it. A layout choice after it is tidied.
      await redoKey(); await save()
      assert.equal(await doc(), tidiedToo, 'redo gives the typing with its tidy-up')
      await undoKey(); await save()
      assert.equal(await menuWrite(1, 'cards'), true)
      assert.equal(await doc(), TIDY.replace('{pyramid}', '{cards}'), 'a layout chosen after a ⌘Z is saved tidied')
      pass(`${mode}: after undo and its save, the next save after typing (or a layout choice) tidies again`)
    }

    // ── 5. A document that needs no tidy-up: step for step as before the rule ──
    if (wants(5)) {
      const run = async (always) => {
        alwaysTidy = always
        const trace = []
        const note = async (what) => trace.push([what, await doc(), await depths(), disk])
        await open(TIDY, mode); await note('open')
        await save(); await note('save')
        await typeAfter('- one', ' more'); await note('type'); await pause()
        await save(); await note('save')
        await undoKey(); await note('undo'); await save(); await note('save')
        await undoKey(); await note('undo'); await save(); await note('save')
        await redoKey(); await note('redo'); await save(); await note('save')
        await pause()
        assert.equal(await page.evaluate(() => window.pickerWrite(1, 'cards')), true); await note('picker'); await pause()
        await save(); await note('save')
        await typeAfter('- three', '!'); await note('type'); await pause(); await save(); await note('save')
        assert.equal(await menuWrite(1, 'timeline'), true); await note('menu')
        for (let k = 0; k < 5; k += 1) { await undoKey(); await note('undo'); await save(); await note('save') }
        for (let k = 0; k < 5; k += 1) { await redoKey(); await note('redo'); await save(); await note('save') }
        alwaysTidy = false
        return trace
      }
      const before = await run(true)
      const now = await run(false)
      assert.deepEqual(now, before, 'the same text, undo depths and file after every step as with a save that always tidies')
      assert.ok(before.every(([, text]) => normalizePositions(text) === text), 'and no text on the way needed the tidy-up')
      assert.equal(withoutIds(before.at(-1)[1]), withoutIds(TIDY.replace('- one', '- one more').replace('- three', '- three!').replace('{pyramid}', '{timeline}')), 'the run ends at the text with every change in it')
      pass(`${mode}: a document that needs no tidy-up behaves as before in ${before.length} steps of typing, layout choices, saves, undo and redo`)
    }

    // ── 6. A save with nothing changed ──
    if (wants(6)) {
      await open(TIDY, mode)
      await save()
      assert.equal(await doc(), TIDY); assert.deepEqual(await depths(), { undo: 0, redo: 0 }, 'a tidy text: the save changes nothing and leaves no step')
      // flushSave on a talk nobody touched (a talk switch): it tidies, as before; one undoable step.
      await open(ISSUE_IDS, mode)
      await save()
      assert.equal(await doc(), TIDY, 'a save of an untouched talk tidies it')
      assert.deepEqual(await depths(), { undo: 1, redo: 0 })
      await save()
      assert.equal(await doc(), TIDY); assert.deepEqual(await depths(), { undo: 1, redo: 0 }, 'a second save changes nothing')
      await undoKey(); await save(); await save()
      assert.equal(await doc(), ISSUE_IDS, '⌘Z takes the tidy-up back, and saves leave it so')
      assert.deepEqual(await depths(), { undo: 0, redo: 1 })
      await undoKey(); await save()
      assert.equal(await doc(), ISSUE_IDS, 'a further ⌘Z does nothing')
      pass(`${mode}: a save with nothing changed tidies an untouched talk once, and not again after ⌘Z`)
    }
  }

  // ── 7. Generated runs ──
  if (wants(7)) {
    const OPS = 36
    const LAYOUTS = ['cards', 'timeline', 'pyramid', 'statement', 'steps']
    const runs = []
    for (const mode of MODES) for (const ids of [false, true]) for (const seed of (ids ? [20261014, 131, 7, 42] : [20261014, 131])) runs.push({ mode, ids, seed })
    let totalUndo = 0
    let totalTidy = 0
    for (const { mode, ids, seed } of runs) {
      let s = seed + (ids ? 7 : 0) + (mode === 'plain' ? 13 : 0)
      const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return (s >>> 8) % n }
      const first = MANY(ids)
      await open(first, mode)
      const markers = []
      const log = []
      /** Every marker typed so far is in the text whole and once, or not at all. */
      const checkMarkers = async (when) => {
        const full = await doc()
        const text = full.replace(/\{id=[^}]+\}/g, '{id}') // a minted id can hold a marker's letters
        let wholes = 0
        for (const m of markers) {
          const whole = text.split(m).length - 1
          const stem = text.split(m.slice(0, 3)).length - 1
          assert.ok(whole <= 1, `${when}: "${m}" is in the text ${whole} times [${log.join(' ')}]`)
          assert.equal(stem, whole, `${when}: a part of "${m}" is in the text without the rest [${log.join(' ')}]`)
          wholes += whole
        }
        assert.equal(text.split('zq').length - 1, wholes, `${when}: the end of a marker is in the text without its start [${log.join(' ')}]`)
        return full
      }
      const type = async () => {
        const lines = (await doc()).split('\n')
        const bullets = lines.map((l, i) => (l.startsWith('- ') ? i + 1 : 0)).filter(Boolean)
        const marker = `m${String(markers.length).padStart(2, '0')}zq`
        markers.push(marker)
        await page.evaluate(([n, m]) => window.typeAtLineEnd(n, ' ' + m), [bullets[rnd(bullets.length)], marker])
        log.push('type')
      }
      for (let op = 0; op < OPS; op += 1) {
        const text = await doc()
        const headings = text.split('\n').map((l, i) => (/^### /.test(l) ? i + 1 : 0)).filter(Boolean)
        const pick = rnd(100)
        if (pick < 24) await type()
        else if (pick < 34) { const ok = await page.evaluate(([l, name]) => window.pickerWrite(l, name), [headings[rnd(headings.length)], LAYOUTS[rnd(LAYOUTS.length)]]); log.push(ok ? 'picker' : 'picker-') }
        else if (pick < 42) { const ok = await menuWrite(headings[rnd(headings.length)], LAYOUTS[rnd(LAYOUTS.length)]); log.push(ok ? 'menu' : 'menu-') }
        else if (pick < 50) { await page.evaluate((n) => window.typeAtLineEnd(n, '\n'), headings[rnd(headings.length)]); log.push('gap') } // a blank line typed under a heading: its layout line is out of place
        else if (pick < 70) { const before = (await depths()).undo; await save(); totalTidy += (await depths()).undo - before; log.push('save') }
        else if (pick < 88) { await undoKey(); log.push('undo') }
        else { await redoKey(); log.push('redo') }
        await checkMarkers(`run ${mode}/${ids}/${seed} op ${op}`)
        if (rnd(3) === 0) await pause()
      }
      // The run ends on the user's own change and a save, so there is one last text to redo to.
      await pause(); await type(); await pause(); await save()
      const last = await checkMarkers('at the end of the run')
      assert.equal(normalizePositions(last), last, 'the last save tidied')
      const bound = 3 * (OPS + 2)
      const back = []
      {
        let presses = 0
        while ((await depths()).undo > 0) {
          assert.ok(presses < bound, `run ${mode}/${ids}/${seed}: ⌘Z with a save after each press ends within ${bound} presses [${log.join(' ')}]`)
          const depthBefore = (await depths()).undo
          await undoKey(); presses += 1
          const text = await checkMarkers(`undoing, press ${presses}`)
          back.push(text)
          await save()
          // (An id the ⌘Z took off its heading is stamped again by this save: ids aside.)
          assert.equal(withoutIds(await doc()), withoutIds(text), `run ${mode}/${ids}/${seed}: the save after ⌘Z ${presses} leaves the text alone [${log.join(' ')}]`)
          // (One, or more: a step whose whole change an undo before it took back is dropped by CodeMirror.)
          assert.ok((await depths()).undo < depthBefore, 'each ⌘Z takes a step off the history')
        }
      }
      const atStart = await doc()
      for (const m of markers) assert.ok(!atStart.includes(m.slice(0, 3)), `run ${mode}/${ids}/${seed}: ⌘Z to the end leaves nothing typed in the text [${log.join(' ')}]`)
      // The first text, byte for byte (in a talk opened without ids, the ids the run's saves stamped went with the changes).
      assert.equal(atStart, first, `run ${mode}/${ids}/${seed}: ⌘Z to the end gives the first text [${log.join(' ')}]`)
      // Forward, with a save after each press.
      const forward = []
      {
        let presses = 0
        while ((await depths()).redo > 0) {
          assert.ok(presses < bound, `run ${mode}/${ids}/${seed}: redo with a save after each press ends within ${bound} presses`)
          await redoKey(); presses += 1
          const text = await checkMarkers(`redoing, press ${presses}`)
          forward.push(text)
          await save()
          assert.equal(withoutIds(await doc()), withoutIds(text), `run ${mode}/${ids}/${seed}: the save after redo ${presses} leaves the text alone [${log.join(' ')}]`)
        }
      }
      const atEnd = await doc()
      // The last text, and on the way the texts ⌘Z went through, in the other order.
      sameText(atEnd, last, `run ${mode}/${ids}/${seed}: redo to the end gives the last text [${log.join(' ')}]`, true)
      assert.deepEqual(forward.slice(0, -1), back.slice(0, -1).reverse(), `run ${mode}/${ids}/${seed}: redo goes back through the texts ⌘Z went through [${log.join(' ')}]`)
      totalUndo += back.length
      if (PRINT) console.log(`  ${mode} ids=${ids} seed=${seed}: ${back.length} ⌘Z · ${log.join(' ')}`)
    }
    assert.ok(totalTidy >= runs.length, `the runs made tidy-up steps (${totalTidy})`)
    pass(`${runs.length} generated runs of ${OPS} steps (typing, layout choices, layout lines put out of place, saves, undo, redo; ${totalTidy} save steps, ${totalUndo} ⌘Z): with a save after every press ⌘Z always ends, each press takes a step, no save after one changes the text, no typed marker is cut or doubled; ⌘Z to the end gives the first text and redo exactly the last, with and without ids at the start`)
  }

  const caught = await page.evaluate(() => window.__caught)
  assert.deepEqual(caught, [], `no exception caught by the editor: ${caught.join(' | ')}`)
  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`)
  console.log(`\nsave tidy-up after undo: ${passed} checks passed`)
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
