// The first save of a talk whose headings have no ids, and the undo history (0.38.3-preview.10
// finding: after the first move in such a talk, ⌘Z never reached the move).
//
// A real CodeMirror editor in a browser (Playwright's chromium headless shell, never the real
// Chrome) with the extensions the app's editor uses for this: history, the id and heading guard
// (idProtect.ts), the drag's move command (outliner.ts moveBlockTo), whole-slide cut and paste
// (slideCutPaste.ts) and the adoption of saved text (savedTextAdoption.ts), with the app's undo and
// redo keys (editorBaseKeymap.ts editorHistoryKeymap). The save is the app's: the text to write comes
// from textForSave (extensions/saveTidyUp.ts), the function all three of Editor.tsx's saves call (no
// talk in this file needs the tidy-up; the ones that do are in test-save-tidy-up-after-undo-dom.mjs),
// it goes through the compiler's stampMissingIds with the ids on "disk" preferred (src/main/index.ts,
// talk:write-outline), and what comes back is adopted the way Editor.tsx adopts it, from the text the
// save was made from. The adoption is one undo step that ⌘Z takes back with the user's change below
// it (issue 201). Undo is the ⌘Z key.
//   1. a move, the save, one ⌘Z: the first text is back exactly (the ids the save stamped for the
//      move go with it), the file keeps every heading's id; redo gives the move and the ids;
//   2. the same through the save that follows each undo (the loop that made the move unreachable);
//   3. cut and paste of a whole slide, and Move to…, across the first save;
//   4. typing across the first save, a typed heading included (its id does not stay behind);
//   5. a save whose adoption has no change of the user's below it: ⌘Z takes back the ids alone;
//   6. an id the user's own undo removes stays removed (a pasted copy), and a doc that moved on
//      during the save is left alone;
//   7. savedTextChanges, directly;
//   8. seven moves in a 20-slide talk with a save after each, undone to the start and redone;
//   9. another talk loaded into the same editor (Editor.tsx's load: the whole text replaced, the
//      history dropped): nothing from the first talk reaches the second.
//  10. an old slide reused from the image drawer (shared/old-slide insertSlideAfterCaret, put in the
//      way Editor.tsx's replace seam puts any D1 change in): the save gives it a fresh id, never the
//      archive's, and one ⌘Z takes the whole slide out with that id.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { preferredIdsFromText, stampMissingIds } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { savedTextChanges } from '../src/renderer/src/lib/savedTextChanges.ts'
import { insertSlideAfterCaret, oldSlideMarkdown } from '../src/shared/old-slide.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-saved-text-adoption-'))
const outfile = join(dir, 'bundle.js')

const J = (...lines) => lines.join('\n')
// The tester's talk: two sections, four slides, no ids anywhere.
const FRESH = J(
  '---', 'title: "Undo first move check"', '---', '',
  '## Part one', '',
  '### Alpha', '', '- alpha point', '',
  '### Bravo', '{columns}', '', '- bravo point', '',
  '### Charlie', '', '- charlie point', '',
  '## Part two', '',
  '### Delta', '', '- delta point', ''
)
const headings = (t) => t.split('\n').filter((l) => /^#{1,6}\s/.test(l))
const idsOf = (t) => [...t.matchAll(/\{id=([^}]+)\}/g)].map((m) => m[1])
const lineOf = (text, line) => { const i = text.split('\n').indexOf(line); assert(i >= 0, `the text has "${line}"`); return i + 1 }
/** heading -> its id, read the way the save reads it. */
const idByHeading = (t) => Object.fromEntries([...preferredIdsFromText(t)].map(([k, v]) => [k.replace(/ \d+$/, ''), v]))
const apply = (text, changes) => { let out = ''; let at = 0; for (const c of changes) { out += text.slice(at, c.from) + c.insert; at = c.to } return out + text.slice(at) }

const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { defaultKeymap, history, undoDepth, redoDepth } from '@codemirror/commands'
import { editorHistoryKeymap } from './src/renderer/src/extensions/editorBaseKeymap.ts'
import { Compartment } from '@codemirror/state'
import { rememberSlideClip } from './src/renderer/src/extensions/slideBlockOps.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { moveBlockTo } from './src/renderer/src/extensions/outliner.ts'
import { cutSlideAt, moveSlideTo, pasteSlidesAfter, slideCutCopyExtension } from './src/renderer/src/extensions/slideCutPaste.ts'
import { adoptSavedText, savedTextAdoption } from './src/renderer/src/extensions/savedTextAdoption.ts'
import { saveTidyUp, textForSave } from './src/renderer/src/extensions/saveTidyUp.ts'
import { applyMinimalChange } from './src/renderer/src/lib/minimalChange.ts'

const historyCompartment = new Compartment()

window.toasts = []
window.addEventListener('tw-toast', (e) => window.toasts.push(e.detail.message))
let view = null
window.mount = (doc) => {
  if (view) view.destroy()
  window.seen = []
  view = new EditorView({
    parent: document.getElementById('cm'),
    state: EditorState.create({ doc, extensions: [
      historyCompartment.of(history()),
      tokenProtectExtension(),
      slideCutCopyExtension(),
      keymap.of([...defaultKeymap, ...editorHistoryKeymap]),
      // As Editor.tsx: the listener that reads the text for the autosave comes first.
      EditorView.updateListener.of((u) => { if (u.docChanged) window.seen.push(u.state.doc.toString()) }),
      savedTextAdoption(),
      saveTidyUp()
    ] })
  })
  view.focus()
}
window.docText = () => view.state.doc.toString()
window.depths = () => ({ undo: undoDepth(view.state), redo: redoDepth(view.state) })
window.caretLineText = () => view.state.doc.lineAt(view.state.selection.main.head).text
window.setCaret = (lineText, col) => {
  const n = view.state.doc.toString().split('\\n').indexOf(lineText) + 1
  const line = view.state.doc.line(n)
  view.dispatch({ selection: EditorSelection.cursor(col == null ? line.to : line.from + col) })
  view.focus()
}
window.drag = (fromLine, toLine) => moveBlockTo(view, fromLine, toLine)
window.cut = (line) => cutSlideAt(view, line)
window.paste = (clip, afterLine) => pasteSlidesAfter(view, clip, afterLine)
window.moveTo = (fromLine, target) => moveSlideTo(view, fromLine, target)
window.adopt = (source, saved) => adoptSavedText(view, source, saved)
// The text the save writes, and the editor's text it is made from (Editor.tsx: the editor is not tidied first).
window.textForSave = () => {
  const source = view.state.doc.toString()
  return { source, sent: textForSave(view.state, source) }
}
// A slide the app copied (what a whole-slide copy records): only such text is pasted as a slide.
window.copied = (clip) => rememberSlideClip(clip)
// Another talk into the same editor, as Editor.tsx loads one: the whole text replaced, then the
// history detached and attached again.
window.loadTalk = (doc) => {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } })
  view.dispatch({ effects: historyCompartment.reconfigure([]) })
  view.dispatch({ effects: historyCompartment.reconfigure(history()) })
}
// A D1 change, as Editor.tsx's replace seam (registerReplaceDoc) puts it in: one minimal change, no userEvent.
window.replaceDoc = (next) => { const c = applyMinimalChange(view.state.doc.toString(), next); if (c) view.dispatch({ changes: c }); return view.state.doc.toString() }
window.caret = () => view.state.selection.main.head
window.typeAtEnd = (text) => view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' })
`

let browser
let passed = 0
const pass = (message) => { passed += 1; console.log(`PASS ${message}`) }
try {
  // ── 7. The pure parts ──
  {
    const saved = stampMissingIds(FRESH).text
    const changes = savedTextChanges(FRESH, saved)
    assert.ok(changes, 'the stamped text reads as a list of changes')
    assert.equal(apply(FRESH, changes), saved, 'which give exactly the stamped text')
    assert.equal(changes.length, 6, 'one change per heading (six headings)')
    assert.ok(changes.every((c) => c.from === c.to), 'every one a pure insertion: nothing of the sent text is replaced')
    assert.ok(changes.every((c) => /^[\n ]?\{id=[a-z0-9]+\}[\n ]?$/.test(c.insert)), `each inserts one id and nothing else: ${JSON.stringify(changes.map((c) => c.insert))}`)
    assert.deepEqual(savedTextChanges(saved, saved), [], 'the same text: no changes')
    // An id put on the heading line itself, at the very end of a text with no final newline, and CRLF-free edges.
    for (const [a, b] of [
      ['### A', '### A\n{id=x1}'], ['### A\nbody', '### A\n{id=x1}\nbody'], ['### A\n{columns}\nbody', '### A\n{id=x1} {columns}\nbody'],
      ['### A\n{columns}\nbody', '### A\n{columns} {id=x1}\nbody'], ['{id=gone}\n### A', '### A'], ['a\nb\nc', 'a\nc'], ['a\nb', 'a\nB\nb\nz']
    ]) {
      const cs = savedTextChanges(a, b)
      assert.ok(cs, `changes for ${JSON.stringify([a, b])}`)
      assert.equal(apply(a, cs), b, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`)
    }
    pass('the saved text reads as one insertion per id (savedTextChanges)')
  }

  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'saved-text-adoption-entry.ts', loader: 'ts' },
    bundle: true, format: 'iife', platform: 'browser', outfile, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<!doctype html><html><body><div id="cm" style="width:600px;height:500px;overflow:auto"></div></body></html>')
  await page.addScriptTag({ content: readFileSync(outfile, 'utf8') })

  const doc = () => page.evaluate(() => window.docText())
  const depths = () => page.evaluate(() => window.depths())
  const undoKey = () => page.keyboard.press('Meta+z')
  const redoKey = () => page.keyboard.press('Meta+Shift+z')
  /** The app's save: tidy as the app's save decides, stamp that text (ids on disk preferred), write it, adopt what was written. */
  let disk = ''
  const save = async () => {
    const { source, sent } = await page.evaluate(() => window.textForSave())
    assert.equal(sent, source, 'no talk here needs the tidy-up: the text sent is the text the editor holds')
    let preferred = null
    try { preferred = preferredIdsFromText(disk) } catch { /* nothing on disk yet */ }
    const stamped = stampMissingIds(sent, undefined, { preferred })
    disk = stamped.text
    if (stamped.stamped.length > 0) await page.evaluate(([a, b]) => window.adopt(a, b), [source, stamped.text])
    return stamped.stamped.length
  }
  /** The file keeps every heading's id: after a save that followed ⌘Z, the ids the main process reused. */
  const fileKeeps = (ids, message) => assert.deepEqual(idByHeading(disk), ids, `${message}: the file carries every heading's id as before`)
  const open = async (text) => { disk = text; await page.evaluate((t) => window.mount(t), text) }
  const everyHeadingHasItsId = (text, ids, message) => {
    const now = idByHeading(text)
    for (const h of headings(text).filter((x) => /^#{2,6}\s/.test(x))) assert.equal(now[h], ids[h], `${message}: ${h} carries ${ids[h]}`)
    assert.equal(new Set(idsOf(text)).size, idsOf(text).length, `${message}: no id twice`)
  }
  const withoutIdLines = (t) => t.split('\n').filter((l) => !/^\{id=[^}]+\}$/.test(l)).join('\n').replace(/ ?\{id=[^}]+\} ?/g, '')

  // ── 1. The tester's case: drag Charlie before Alpha, the first save, one ⌘Z ──
  await open(FRESH)
  assert.equal(await page.evaluate(([from, to]) => window.drag(from, to), [lineOf(FRESH, '### Charlie'), lineOf(FRESH, '### Alpha')]), true, 'the drag moved the slide')
  const movedNoIds = await doc()
  assert.deepEqual(headings(movedNoIds), ['## Part one', '### Charlie', '### Alpha', '### Bravo', '## Part two', '### Delta'])
  assert.equal(await save(), 6, 'the first save stamps the six headings')
  const moved = await doc()
  assert.equal(moved, disk, 'the editor holds what the save wrote')
  assert.equal(withoutIdLines(moved), movedNoIds, 'which is the moved text plus the ids')
  const ids = idByHeading(moved)
  assert.equal(Object.keys(ids).length, 6)
  assert.deepEqual(await depths(), { undo: 2, redo: 0 }, 'two undo steps: the move, and the save\'s ids above it')
  await undoKey()
  const undone = await doc()
  assert.deepEqual(headings(undone), headings(FRESH), 'ONE ⌘Z after the first save: the slides are back in their first order')
  assert.equal(undone, FRESH, 'and the text is the first text exactly: the ids stamped for the move went with it')
  const seenAfterUndo = await page.evaluate(() => window.seen.at(-1))
  assert.equal(seenAfterUndo, undone, 'the listener that feeds the autosave saw the text the ⌘Z ends at')
  assert.equal(await save(), 6, 'the save after the undo stamps the file again')
  assert.equal(await doc(), undone, 'and is not adopted (an undo step there would end the redo)')
  fileKeeps(ids, 'after the undo and its save')
  assert.deepEqual(await depths(), { undo: 0, redo: 2 })
  await undoKey()
  assert.equal(await doc(), undone, 'a further ⌘Z does nothing')
  await redoKey()
  assert.equal(await doc(), moved, 'redo: exactly the moved text with the ids')
  await undoKey()
  assert.equal(await doc(), undone, 'and undo again')
  pass('the first move in a talk without ids is undone by one ⌘Z after the first save, with the ids stamped for it; the file keeps every heading\'s id; redo works')

  // ── 2. With a save after every step (the 1.5 s autosave between the tester's key presses) ──
  await open(FRESH)
  await page.evaluate(([from, to]) => window.drag(from, to), [lineOf(FRESH, '### Delta'), lineOf(FRESH, '### Bravo')])
  await save()
  const ids2 = idByHeading(await doc())
  const moved2 = await doc()
  await page.evaluate(([from, to]) => window.drag(from, to), [lineOf(moved2, '### Alpha'), lineOf(moved2, '## Part two')])
  await save()
  const movedTwice = await doc()
  await undoKey(); await save()
  assert.equal(await doc(), moved2, 'after two moves: the first ⌘Z undoes the second move')
  await undoKey(); await save()
  assert.equal(await doc(), FRESH, 'the second ⌘Z undoes the first move, and the ids stamped for it')
  fileKeeps(ids2, 'after both undos')
  await undoKey(); await save()
  assert.equal(withoutIdLines(await doc()), FRESH, 'a third ⌘Z changes nothing')
  await redoKey(); await save(); await redoKey(); await save()
  assert.equal(await doc(), movedTwice, 'redo twice: both moves again, ids as they were')
  pass('with a save after every key press, each ⌘Z undoes one move and the file\'s ids never change')

  // ── 3. Cut and paste of a whole slide, and Move to…, across the first save ──
  await open(FRESH)
  const clip = await page.evaluate((line) => window.cut(line), lineOf(FRESH, '### Bravo'))
  assert.ok(clip, 'Bravo was cut')
  await page.evaluate(([c, after]) => window.paste(c, after), [clip, lineOf(await doc(), '### Delta')])
  const pastedNoIds = await doc()
  assert.deepEqual(headings(pastedNoIds), ['## Part one', '### Alpha', '### Charlie', '## Part two', '### Delta', '### Bravo'])
  await save()
  const ids3 = idByHeading(await doc())
  await undoKey()
  assert.deepEqual(headings(await doc()), ['## Part one', '### Alpha', '### Charlie', '## Part two', '### Delta'], 'one ⌘Z after the save: the paste is undone')
  await save()
  await undoKey()
  assert.equal(withoutIdLines(await doc()), FRESH, 'the next ⌘Z: the cut is undone, Bravo back in its place with its {columns} line')
  await save()
  // Bravo was not in the file for one save (the save after the first ⌘Z): the main process, which reuses
  // only the ids the file has, gives it a new one there. Reported with issue 201 (point 6), not asserted.
  const { '### Bravo': bravoNow, ...othersNow } = idByHeading(disk)
  const { '### Bravo': bravoBefore, ...othersBefore } = ids3
  assert.deepEqual(othersNow, othersBefore, 'after undoing paste and cut: the file carries every other heading\'s id as before')
  if (bravoNow !== bravoBefore) console.log(`NOTE the file gave Bravo a new id after it was away for one save: ${bravoNow}, not ${bravoBefore}`)
  const base3 = await doc()
  const landed = await page.evaluate(([from, after]) => window.moveTo(from, { kind: 'after', line: after }), [lineOf(base3, '### Alpha'), lineOf(base3, '### Delta')])
  assert.ok(landed, 'Move slide to… moved Alpha')
  await save()
  await undoKey()
  assert.equal(await doc(), base3, 'Move to… is undone by one ⌘Z')
  pass('cut, paste and Move to… across the first save: each is one ⌘Z, and the file keeps the ids of the slides that stayed')

  // ── 4. Typing across the first save ──
  await open(FRESH)
  await page.evaluate(() => window.setCaret('- alpha point'))
  await page.keyboard.type(' and more')
  await save()
  const ids4 = idByHeading(await doc())
  assert.ok((await doc()).includes('- alpha point and more'))
  await undoKey()
  assert.equal(await doc(), FRESH, 'typing, the first save, one ⌘Z: the typing is undone, and the ids stamped for it')
  await save()
  fileKeeps(ids4, 'after undoing the typing')
  assert.deepEqual(await depths(), { undo: 0, redo: 2 })
  // A typed heading: the save gives it an id; undoing the typing takes the id line with it.
  await page.evaluate(() => window.setCaret('- charlie point'))
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter')
  await page.keyboard.type('### Typed slide')
  await save()
  const typedId = idByHeading(await doc())['### Typed slide']
  assert.ok(typedId, 'the typed heading got an id')
  // (The caret goes to the end of the id line first, as after a click there: Enter at the end of the
  // title itself would put the point between the title and its id line, in this build and before.)
  await page.evaluate((id) => window.setCaret('{id=' + id + '}'), typedId)
  await page.keyboard.press('Enter')
  await page.keyboard.type('- typed point')
  await save()
  assert.equal(await page.evaluate(() => window.caretLineText()), '- typed point')
  let presses = 0
  while ((await depths()).undo > 0 && presses < 30) { await undoKey(); presses += 1; await save() }
  assert.ok(presses < 30, 'the undo history runs out')
  assert.equal(withoutIdLines(await doc()), FRESH, `after ${presses} ⌘Z the talk is the first text again`)
  assert.ok(!(await doc()).includes(typedId), 'the typed heading\'s id line did not stay behind')
  assert.deepEqual(Object.fromEntries(Object.entries(idByHeading(disk)).filter(([h]) => h !== '### Typed slide')), ids4, 'the file keeps every other heading\'s id')
  // Redo to the end: the typed slide is back, with the id it had.
  for (let k = 0; k < presses; k += 1) { await redoKey() }
  assert.ok((await doc()).includes('### Typed slide\n{id=' + typedId + '}\n- typed point'), 'redo: the typed slide is back with its own id')
  everyHeadingHasItsId(await doc(), { ...ids4, '### Typed slide': typedId }, 'after redoing the typed slide')
  pass(`typing across the first save is undone (a typed slide and its id: ${presses} ⌘Z); the other ids stay`)

  // ── 5. A save with no change of the user's below it ──
  await open(FRESH)
  await save()
  const stampedOnly = await doc()
  assert.equal(idsOf(stampedOnly).length, 6)
  assert.deepEqual(await depths(), { undo: 1, redo: 0 }, 'the save\'s ids are one undo step')
  await undoKey()
  assert.equal(await doc(), FRESH, '⌘Z takes back that step alone')
  await redoKey()
  assert.equal(await doc(), stampedOnly, 'and redo puts it back')
  pass('a save\'s ids with no change of the user\'s below them are one undo step, undone and redone exactly')

  // ── 6. The user's own undo still removes an id; a doc that moved on is left alone ──
  await open(stampedOnly)
  const copy = J('### Bravo', '{id=copy1}', '', '- bravo point', '')
  await page.evaluate((c) => window.copied(c), copy)
  await page.evaluate(([c, after]) => window.paste(c, after), [copy, lineOf(stampedOnly, '### Delta')])
  const pastedIds = idsOf(await doc())
  assert.equal(pastedIds.length, 7, 'the pasted copy has an id of its own')
  await undoKey()
  assert.equal(await doc(), stampedOnly, 'undoing the paste removes the copy and its id; nothing is put back')
  await open(FRESH)
  const sentEarlier = await doc()
  await page.evaluate(() => window.setCaret('- delta point'))
  await page.keyboard.type('!')
  const typedOn = await doc()
  assert.equal(await page.evaluate(([a, b]) => window.adopt(a, b), [sentEarlier, stampMissingIds(sentEarlier).text]), false, 'a save that returns after more typing is not adopted')
  assert.equal(await doc(), typedOn)
  pass('an id the user\'s own change brought is undone with it; text typed during a save is never overwritten')

  // ── 8. A run of moves with a save after each, undone to the start and redone to the end ──
  {
    // Every slide has a different title, so heading -> id says whether an id stayed with its slide.
    const big = ['# Talk', '']
    for (let sct = 0; sct < 4; sct += 1) {
      big.push(`## Section ${sct}`, '')
      for (let i = 0; i < 5; i += 1) big.push(`### Slide ${sct}.${i}`, ...(i === 2 ? ['{columns}'] : []), '', `- point ${sct}.${i}`, i % 2 ? '' : `- second point ${sct}.${i}`, '')
    }
    const BIG = big.join('\n')
    let seed = 20261012
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    await open(BIG)
    const snapshots = [BIG]
    let idsBig = null
    for (let step = 0; step < 7; step += 1) {
      const text = await doc()
      const slides = headings(text).filter((h) => h.startsWith('### '))
      const all = headings(text).filter((h) => /^#{2,3}\s/.test(h))
      let moved = false
      for (let tries = 0; tries < 20 && !moved; tries += 1) {
        const from = slides[rnd(slides.length)]
        const to = all[rnd(all.length)]
        if (from === to) continue
        moved = await page.evaluate(([f, t]) => window.drag(f, t), [lineOf(text, from), lineOf(text, to)])
      }
      assert.ok(moved, `step ${step}: a slide moved`)
      await save()
      idsBig ??= idByHeading(await doc())
      everyHeadingHasItsId(await doc(), idsBig, `after move ${step}`)
      snapshots.push(withoutIdLines(await doc()))
      await page.waitForTimeout(560) // past CodeMirror's 500 ms grouping, as two drags by hand are
    }
    assert.equal(Object.keys(idsBig).length, 24, 'the first save stamped the 4 sections and 20 slides')
    for (let k = snapshots.length - 2; k >= 0; k -= 1) {
      await undoKey(); await save()
      assert.equal(withoutIdLines(await doc()), snapshots[k], `⌘Z ${snapshots.length - 1 - k}: the text before move ${k}`)
      // The first move's ⌘Z takes the first save's ids with it; the file keeps them.
      if (k === 0) { assert.equal(await doc(), BIG, 'the first text exactly'); fileKeeps(idsBig, 'after undoing the first move') }
      else everyHeadingHasItsId(await doc(), idsBig, `after undoing move ${k}`)
    }
    assert.equal((await depths()).undo, 0, 'the history is used up at the first text')
    for (let k = 1; k < snapshots.length; k += 1) {
      await redoKey(); await save()
      assert.equal(withoutIdLines(await doc()), snapshots[k], `redo ${k}: the text after move ${k - 1}`)
      everyHeadingHasItsId(await doc(), idsBig, `after redoing move ${k - 1}`)
    }
    assert.ok(!/\{id=[^}]+\}[^\n]*\{id=/.test(await doc()) && (await doc()).split('\n').every((l) => !l.includes('{id=') || /^(\{[^}]*\} ?)+$/.test(l)), 'no id ever landed inside a line of text')
    pass('seven moves in a 20-slide talk without ids, a save after each: undone step by step to the first text and redone to the last, every id on its own slide throughout')
  }

  // ── 9. Another talk in the same editor: nothing adopted in the first talk reaches it ──
  {
    const TALK_A = J('## Part', '{id=part1}', '', '### Kept', '{id=kept1}', '', '- kept point', '')
    const TALK_B = J('## Other part', '', '### First', '', '- first point', '', '### New slide', '')
    // In talk A: type a heading, save (its id is adopted), ⌘Z (the heading goes with its id).
    const parkOneInA = async () => {
      await open(TALK_A)
      await page.evaluate(() => window.typeAtEnd('\n### New slide\n'))
      assert.equal(await save(), 1, 'the save stamps the typed heading')
      await undoKey()
      assert.equal(await doc(), TALK_A, 'the undo removes the typed heading and its id')
    }
    // In talk B: one edit of its own, one ⌘Z.
    const editAndUndoInB = async () => {
      await page.evaluate(() => window.setCaret('- first point'))
      await page.keyboard.type('!')
      await undoKey()
      return doc()
    }
    await parkOneInA()
    await page.evaluate((t) => window.loadTalk(t), TALK_B)
    assert.equal(await doc(), TALK_B)
    assert.deepEqual(await depths(), { undo: 0, redo: 0 }, 'the load leaves no undo step')
    await undoKey()
    assert.equal(await doc(), TALK_B, '⌘Z in the freshly loaded talk does nothing')
    const afterB = await editAndUndoInB()
    assert.equal(afterB, TALK_B, 'an undo in the second talk undoes its own edit and nothing else: no id from the first talk under "### New slide"')
    assert.deepEqual(idsOf(afterB), [])
    const editorSource = readFileSync(join(root, 'src/renderer/src/components/Editor.tsx'), 'utf8')
    assert.equal(editorSource.match(/historyCompartment\.reconfigure\(\[\]\)/g).length, 1, 'the history is dropped in one place only')
    // The save simulated in this file decides on the tidy-up with the function every save of Editor.tsx calls.
    assert.equal((editorSource.match(/textForSave\(/g) ?? []).length, 3, 'the autosave, flushSave and the replace seam each ask textForSave')
    assert.ok(!editorSource.includes('normalizePositions('), 'and none of them calls the tidy-up directly')
    pass('a talk loaded into the same editor starts clean: an undo there undoes its own edit and brings nothing of the talk before')
  }

  // ── 10. An old slide from the image drawer, after the current slide: a fresh id, one ⌘Z removes it ──
  {
    await open(FRESH)
    await save()
    const stamped = await doc()
    const before = idByHeading(stamped)
    // The archive's text carries an id of its own, on the title and on a line: it must never reach the talk.
    const record = { title: 'Reused plan {id=archive1}', paragraphs: ['{id=archive2}', 'A point from the old deck'], notes: 'Say it {id=archive3}', images: [], slideNumber: 3 }
    const slide = oldSlideMarkdown(record, {})
    await page.evaluate(([line, col]) => window.setCaret(line, col), ['- alpha point', 3])
    const caret = await page.evaluate(() => window.caret())
    const r = insertSlideAfterCaret({ text: stamped, caret, slide })
    assert.ok(r.ok, `the slide goes in (${r.ok ? '' : r.error})`)
    await page.evaluate((t) => window.replaceDoc(t), r.text)
    assert.equal(await save(), 1, 'the save stamps the one new heading')
    const withSlide = await doc()
    assert.equal(withSlide, disk, 'the editor holds what the save wrote')
    const after = idByHeading(withSlide)
    const added = Object.keys(after).find((h) => h.startsWith('### Reused plan'))
    assert.ok(added, `the new slide is there: ${JSON.stringify(Object.keys(after))}`)
    assert.ok(after[added] && !/archive/.test(after[added]), `it carries a fresh id (${after[added]}), not the archive's`)
    assert.ok(!Object.values(before).includes(after[added]), 'an id no other slide has')
    for (const [h, id] of Object.entries(before)) assert.equal(after[h], id, `${h} keeps its id`)
    // The archive's text is still there as visible text (literalised: `\\{id=archive1\\}\\`), never as an id token.
    assert.ok(!/\{id=archive[A-Za-z0-9_-]*\}/.test(withSlide), 'no archive id token anywhere in the talk')
    assert.ok(![...preferredIdsFromText(withSlide).values()].some((id) => /archive/.test(id)), 'and none the save reads as an id')
    assert.deepEqual(headings(withSlide).map((h) => h.replace(/ \{id=[^}]+\}/, '')).slice(0, 4), ['## Part one', '### Alpha', added, '### Bravo'], 'after the current slide, before the next')
    await undoKey()
    assert.equal(await doc(), stamped, 'ONE ⌘Z: the whole new slide is gone, with the id the save gave it')
    await redoKey()
    assert.equal(await doc(), withSlide, 'redo: the slide and its id again')
    pass('an old slide reused from the drawer gets a fresh id on save, never the archive\'s, and one ⌘Z removes the whole slide')
  }

  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`)
  console.log(`\nsaved-text adoption: ${passed} checks passed`)
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
