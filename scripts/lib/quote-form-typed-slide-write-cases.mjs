// Cases of test:quote-form-typed-slide-editor (quote forms ticket 11, fix round): the form is decided on the document
// that receives it.
//
// Three defects an independent review found in the typing watch (src/renderer/src/extensions/quoteLinkForm.ts), each
// with the same root, and the edits around them:
//   W1. Enter in the middle of a typed address (a bare address, a `- Author <link>` line, a DOI): the check used to be
//       made on the text before the Enter and its write carried over the Enter, onto a slide that no longer had the link;
//   W2. the typed link deleted between the line being left and its check running: the check used to be made on the text
//       as the line was left;
//   W3. a change made by a program on another slide while a line is being typed (with and without a save's ids adopted
//       in between): it used to be read as typed on the line;
//   W4. Backspace joining the address line to the quotation;
//   W5. a line of one slide typed on, then a click into another slide (and that slide typed on in turn);
//   W6. a second caret typing on another slide at the same time;
//   W7. undo and redo across the written form.
//   G.  one line of grace: a `- Author <link>` source line left by Enter is a list slide while the empty item the Enter
//       made stands under it, so nothing is written at that Enter; the line's "before" is kept until the NEXT line is
//       left and the rule asked once more then (G1 to G4 write, G5 to G9 do not, G10 the undo steps).
// A second review found that the edits to a line were told by where they lie and not by who made them:
//   P1. a change with no user event on the line being typed (a link put there by a program) used to count as typed;
//   P2. so did one on either of the two lines of the kept "before" (a link put on, or changed on, the source line while
//       the caret is on the item under it);
//   P3. an undo and its redo (source line, Enter, undo, redo, Enter) used to lose the kept "before";
//   P4. a check queued when the editor is destroyed used to write into the destroyed editor's state.
// A third review found that an undo was read as typing whatever it took back, and that Tab was not the user's key:
//   R1 to R5. undo and redo return to a document the user reached by typing alone, or everything is given up;
//   R6 to R9. Tab and Shift-Tab on the caret's line are the user's typing; the same change by a command is not.
// A fourth review found that an undo which takes back a program's change together with the typing after it (one undo
// step) can leave a text equal to one typed on the way:
//   R10. the reproduction; S. sequences drawn at random with an oracle of whose every character is.
// The review of ticket 14 took a key command that moves existing text for no typing. Decided 13 October 2026: any edit
// of the user's counts, whether or not the user typed the address itself; only a program's change never does:
//   M1, M2, M4. Shift-Enter, Enter and Tab with text after the caret, on a document nobody typed on: the form is
//       written, drawn by the compiler, and one Cmd-Z takes the edit and the form together;
//   M7, M8, M9. an empty marker taken out by Enter or Backspace, a space typed after a hyphen: the same;
//   M3. Shift-Enter at the end of a line, a source typed; M5. Enter in the middle of a list item (a list: no form);
//   M6. Tab and Shift-Tab on the line of a link that was there: no form (the indent gives a link no new reading);
//   P.  each change of M1, M2, M4, M7, M8, M9 made by a program (no user event, no mark): no form.
// Every case asserts the final text and, where a form is written, that the full compiler draws it.
// T reports what a line left by Enter costs on an 800-slide talk (no assertion: a number for the ticket).
import { strict as assert } from 'node:assert'
import { stampMissingIds } from '../../compiler/scripts/lib/12-outline-edit.mjs'
import { DOI, compiledWords, drawnForm } from './quote-drawn-form-slides.mjs'

/** What the test page needs beside the editor of the main script (`view`, `EditorSelection` and `redo` are in its scope). */
export const WRITE_CASES_PAGE = `
// Transactions as a program makes them, one after another in the same task (nothing runs in between).
window.dispatchAll = (specs) => {
  for (const spec of specs) view.dispatch({ changes: spec.changes, selection: spec.cursor == null ? undefined : EditorSelection.cursor(spec.cursor), userEvent: spec.userEvent })
}
window.doRedo = () => redo(view)
// The transactions in one task, then the editor destroyed in that same task; what its state holds once the queued work has run.
window.destroyedAfter = (specs) => {
  window.dispatchAll(specs)
  const dead = view
  const left = dead.state.doc.toString()
  dead.destroy()
  view = null
  return new Promise((resolve) => setTimeout(() => resolve([left, dead.state.doc.toString()]), 20))
}
window.caretAt = () => view.state.selection.main.head
// Enter at the end of the caret's line, and the time until the check queued for the line left has run.
window.timeEnter = () => {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const started = performance.now()
  view.dispatch({ changes: { from: line.to, insert: '\\n' }, selection: EditorSelection.cursor(line.to + 1), userEvent: 'input.type' })
  return Promise.resolve().then(() => performance.now() - started)
}
`

const ALICE = 'https://example.org/alice'
const BOB = 'https://example.org/bob'
const QUOTE_ONE = '> Words one.'
const QUOTE_TWO = '> Words two.'

/** Two quote slides with ids; `one` and `two` are their source lines ('' for an empty line), `three` adds a list slide with no id. */
const talk = ({ one = '', two = '- Bob', three = false } = {}) => [
  '# Talk', '',
  '## Part one', '{id=p1}', '',
  '### One', '{id=s1}', '', QUOTE_ONE, '', one, '',
  '### Two', '{id=s2}', '', QUOTE_TWO, '', two, '',
  ...(three ? ['### Three', '', '- a point', '- another point', '- a third point', ''] : [])
].join('\n')

const lineOf = (text, line) => { const index = text.split('\n').indexOf(line); assert(index >= 0, `the text has the line "${line}"`); return index + 1 }
/** The offset of the end of the (first) line `line`. */
const endOf = (text, line) => text.split('\n').slice(0, lineOf(text, line)).join('\n').length
const withForm = (text, id, form) => { assert(text.includes(`{id=${id}}`), `the text has {id=${id}}`); return text.replace(`{id=${id}}`, `{id=${id}} {form=${form}}`) }
const replaceLine = (text, number, lines) => { const all = text.split('\n'); all.splice(number - 1, 1, ...lines); return all.join('\n') }

/**
 * @param h what the main script drives the editor with: page, run, check, text, type, enter, click, settle, save, compile
 * @returns the lines to print with the result (timings)
 */
export async function writeCases(h) {
  const { page, run, check, text, type, enter, click, settle, save, compile } = h
  const mount = (doc) => run((d) => window.mount(d), doc)
  const compiled = () => run(() => window.compiled())
  const press = async (key, times = 1) => { for (let n = 0; n < times; n += 1) await page.keyboard.press(key) }
  // The quotation's words of each slide as the compiler gives them for the talk nothing was typed on: a written form
  // must leave them as they are.
  let words = null
  const drawn = async (outline, id, form, link) => {
    words ??= Object.fromEntries((await compile(talk())).slides.map((slide) => [slide.id, compiledWords(slide)]))
    assert(words[id]?.length > 0, `slide ${id} has a quotation before anything is typed`)
    const model = await compile(stampMissingIds(outline).text)
    assert.equal(drawnForm(model, id, form, { wordsBefore: words[id], link }), '', `the full compiler draws form=${form} for slide ${id}, citing ${link}, the quotation's words unchanged`)
  }
  /** Leave the line every other way too: nothing more is written. */
  const leaveEveryWay = async (expected, what) => {
    await press('ArrowUp'); await settle()
    await click(1)
    await run(() => window.blurEditor()); await settle()
    assert.equal(await text(), expected, `${what}: the caret moved, a click elsewhere, the editor left`)
  }
  const sourceLineOfOne = async () => lineOf(await text(), QUOTE_ONE) + 2

  // ── W1. Enter in the middle of the typed address ──
  const SPLITS = {
    'a bare address': { keys: ALICE, back: '.org/alice'.length, lines: ['https://examplex', '.org/alice'] },
    'a source line': { keys: `- Author ${ALICE}`, back: '.org/alice'.length, lines: ['- Author https://examplex', '- .org/alice'] },
    'a bare DOI': { keys: DOI, back: '00/xyz123'.length, lines: [`${DOI.slice(0, -9)}x`, '00/xyz123'] },
    'a source line with a DOI': { keys: `- Author ${DOI}`, back: '00/xyz123'.length, lines: [`- Author ${DOI.slice(0, -9)}x`, '- 00/xyz123'] }
  }
  for (const [shape, split] of Object.entries(SPLITS)) await check(`W1. Enter in the middle of the typed address: ${shape}`, async () => {
    const start = talk()
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await type(split.keys)
    await press('ArrowLeft', split.back)
    await type('x')
    await compiled()
    await enter(); await settle()
    const expected = replaceLine(start, line, split.lines)
    assert.equal(await text(), expected, 'the address is cut in two by the Enter and no form is written: the slide the Enter leaves has no such link')
    await compiled()
    await leaveEveryWay(expected, 'the second half left')
  })
  // The same keys with the Enter at the end of the address: the form is written, on the text the Enter leaves.
  for (const [shape, link, form] of [['a bare address', ALICE, 'web'], ['a bare DOI', DOI, 'paper']]) {
    await check(`W1. Enter at the end of the typed address: ${shape}`, async () => {
      const start = talk()
      await mount(start)
      const line = lineOf(start, QUOTE_ONE) + 2
      await click(line)
      await type(link)
      await compiled()
      await enter(); await settle()
      const expected = withForm(replaceLine(start, line, [link, '']), 's1', form)
      assert.equal(await text(), expected, `form=${form} on the slide's layout line, the address whole, the new line under it`)
      await drawn(expected, 's1', form, link)
      await compiled()
      await leaveEveryWay(expected, 'the new line left')
    })
  }
  // At the end of a `- Author <link>` line the app's Enter continues the list: the text it leaves is a list slide for the
  // compiler (asserted on a typed slide in the main script), so nothing is written.
  await check('W1. Enter at the end of the typed address: a source line', async () => {
    const start = talk()
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await type(`- Author ${ALICE}`)
    await compiled()
    await enter(); await settle()
    const expected = replaceLine(start, line, [`- Author ${ALICE}`, '- '])
    assert.equal(await text(), expected, 'the list is continued under the source line and no form is written')
    assert.equal((await compile(expected)).slides.find((slide) => slide.id === 's1')?.layout, 'list', 'the full compiler reads that slide as a list')
    await compiled()
    await leaveEveryWay(expected, 'the new item left')
  })

  // ── W2. The typed link is deleted before the check of the line left has run ──
  for (const userEvent of ['delete.backward', undefined]) await check(`W2. the link deleted between the line being left and its check (${userEvent ?? 'no user event'})`, async () => {
    const start = talk({ one: '- Alice' })
    await mount(start)
    const at = endOf(start, '- Alice')
    const link = ` ${ALICE}`
    // In one task: the caret on the line, the link typed, the caret moved to another line (the check is queued), the link deleted.
    const queued = await run(([specs]) => { window.dispatchAll(specs.slice(0, 3)); const between = window.docText(); window.dispatchAll(specs.slice(3)); return between }, [[
      { cursor: at, userEvent: 'select.pointer' },
      { changes: [{ from: at, insert: link }], cursor: at + link.length, userEvent: 'input.type' },
      { cursor: 0, userEvent: 'select.pointer' },
      { changes: [{ from: at, to: at + link.length, insert: '' }], userEvent }
    ]])
    assert.equal(queued, replaceLine(start, lineOf(start, '- Alice'), [`- Alice${link}`]), 'the link was typed and the line left with no form yet')
    await settle()
    assert.equal(await text(), start, 'the text is as it was: no form for a link that is not there')
    await compiled()
    await click(lineOf(start, '- Alice'))
    await leaveEveryWay(start, 'the line visited again')
  })
  await check('W2. a program puts a link on another slide between the line being left and its check', async () => {
    const start = talk({ one: '- Alice' })
    await mount(start)
    const at = endOf(start, '- Alice')
    await run((specs) => window.dispatchAll(specs), [
      { cursor: at, userEvent: 'select.pointer' },
      { changes: [{ from: at, insert: ' Smith' }], cursor: at + 6, userEvent: 'input.type' },
      { cursor: 0, userEvent: 'select.pointer' },
      { changes: [{ from: endOf(start, '- Bob') + 6, insert: ` ${BOB}` }] }
    ])
    await settle()
    const expected = replaceLine(replaceLine(start, lineOf(start, '- Alice'), ['- Alice Smith']), lineOf(start, '- Bob'), [`- Bob ${BOB}`])
    assert.equal(await text(), expected, 'the check is not made on a document other than the one the line was left in: no form')
    await compiled()
    await leaveEveryWay(expected, 'the user typed no link')
  })
  await check('W2. the link typed and the line left, nothing in between: the form is written', async () => {
    const start = talk({ one: '- Alice' })
    await mount(start)
    const at = endOf(start, '- Alice')
    const link = ` ${ALICE}`
    await run((specs) => window.dispatchAll(specs), [
      { cursor: at, userEvent: 'select.pointer' },
      { changes: [{ from: at, insert: link }], cursor: at + link.length, userEvent: 'input.type' },
      { cursor: 0, userEvent: 'select.pointer' }
    ])
    await settle()
    const expected = withForm(replaceLine(start, lineOf(start, '- Alice'), [`- Alice${link}`]), 's1', 'web')
    assert.equal(await text(), expected, 'form=web on the slide whose link was typed')
    await drawn(expected, 's1', 'web', ALICE)
  })

  // ── W3. A program changes another slide while a line is being typed ──
  const ADOPTIONS = ['no save', 'a save before the program\'s change', 'a save after the program\'s change']
  for (const adoption of ADOPTIONS) for (const userEvent of [undefined, 'input.type']) {
    await check(`W3. a link put on another slide by a program while a line is typed (${adoption}; ${userEvent ?? 'no user event'})`, async () => {
      const start = talk({ one: '- Alice', three: adoption !== 'no save' })
      await mount(start)
      await click(lineOf(start, '- Alice'))
      await type(' Smith')
      if (adoption === ADOPTIONS[1]) assert.equal(await save(), true, 'the save stamps the slide with no id')
      const before = await text()
      await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: endOf(before, '- Bob'), insert: ` ${BOB}` }], userEvent }])
      if (adoption === ADOPTIONS[2]) assert.equal(await save(), true, 'the save stamps the slide with no id')
      await settle()
      const expected = replaceLine(await text(), 1, ['# Talk'])
      assert(expected.includes('- Alice Smith\n') && expected.includes(`- Bob ${BOB}\n`) && !/form=/.test(expected), 'the words were typed, the program put its link, no form yet')
      await compiled()
      await leaveEveryWay(expected, 'the user typed no link: no form on either slide')
    })
  }
  await check('W3. the line typed on after a program\'s change elsewhere takes no form; the next line begun does', async () => {
    const start = talk({ one: '- Alice' })
    await mount(start)
    await click(lineOf(start, '- Alice'))
    await type(' Smith')
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: endOf(await text(), '- Bob'), insert: ' Jones' }] }])
    await type(` ${ALICE}`)
    await compiled()
    const typed = await text()
    await leaveEveryWay(typed, 'what "before" was can no longer be told for this line: nothing is written')
    // Another line is begun: the other slide's link is typed and takes its form.
    await click(lineOf(typed, '- Bob Jones'))
    await type(` ${BOB}`)
    await compiled()
    await press('ArrowUp'); await settle()
    const expected = withForm(replaceLine(typed, lineOf(typed, '- Bob Jones'), [`- Bob Jones ${BOB}`]), 's2', 'web')
    assert.equal(await text(), expected, 'form=web on the slide whose link was typed next')
    await drawn(expected, 's2', 'web', BOB)
  })

  // ── W4. Backspace joins the address line to the quotation ──
  await check('W4. Backspace joining the typed address to the quotation line', async () => {
    const start = talk()
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await type(ALICE)
    await press('Home')
    await press('Backspace', 2)
    await settle()
    const expected = replaceLine(replaceLine(start, line, []), line - 1, []).replace(QUOTE_ONE, `${QUOTE_ONE}${ALICE}`)
    assert.equal(await text(), expected, 'the address stands at the end of the quotation line and no form is written')
    await compiled()
    await leaveEveryWay(expected, 'the joined line left')
  })

  // ── W5. A line of slide One typed on, then a click into slide Two ──
  await check('W5. the address typed on slide One, a click into slide Two, its link typed, a click back', async () => {
    const start = talk()
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await type(ALICE)
    await compiled()
    await click(lineOf(start, '- Bob'))
    const first = withForm(replaceLine(start, line, [ALICE]), 's1', 'web')
    assert.equal(await text(), first, 'form=web on slide One alone')
    await drawn(first, 's1', 'web', ALICE)
    await type(` ${BOB}`)
    await compiled()
    await click(lineOf(first, QUOTE_ONE))
    const second = withForm(replaceLine(first, lineOf(first, '- Bob'), [`- Bob ${BOB}`]), 's2', 'web')
    assert.equal(await text(), second, 'then form=web on slide Two: the form written on slide One is not read as typed')
    await drawn(second, 's1', 'web', ALICE)
    await drawn(second, 's2', 'web', BOB)
    await compiled()
    await leaveEveryWay(second, 'both lines left')
  })

  // ── W6. A second caret types on another slide at the same time ──
  await check('W6. a second caret typing on another slide while the link is typed', async () => {
    const start = talk({ one: '- Alice' })
    await mount(start)
    await click(lineOf(start, '- Alice'))
    const link = ` ${ALICE}`
    await type(link.slice(0, -1))
    // The last letter goes in at both carets in one transaction, as CodeMirror types with two selection ranges.
    const now = await text()
    const caret = await run(() => window.caretAt())
    assert.equal(caret, endOf(now, `- Alice${link.slice(0, -1)}`), 'the caret is at the end of the link being typed')
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: caret, insert: link.slice(-1) }, { from: endOf(now, '- Bob'), insert: link.slice(-1) }], cursor: caret + 1, userEvent: 'input.type' }])
    await compiled()
    const expected = replaceLine(replaceLine(start, lineOf(start, '- Alice'), [`- Alice${link}`]), lineOf(start, '- Bob'), [`- Bob${link.slice(-1)}`])
    assert.equal(await text(), expected, 'both carets typed')
    await leaveEveryWay(expected, 'an edit that is not to one line: nothing is written')
  })

  // ── W7. Undo and redo across the written form ──
  const steps = {}
  for (const leave of ['ArrowUp', 'Enter']) await check(`W7. undo and redo across the form written when the line is left by ${leave}`, async () => {
    const start = talk()
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    // Longer than the history's grouping delay, so the address is an undo step of its own.
    await page.waitForTimeout(700)
    await type(ALICE)
    await compiled()
    if (leave === 'Enter') await enter(); else await press('ArrowUp')
    await settle()
    const written = withForm(replaceLine(start, line, leave === 'Enter' ? [ALICE, ''] : [ALICE]), 's1', 'web')
    assert.equal(await text(), written, 'the form was written')
    await drawn(written, 's1', 'web', ALICE)
    let undone = 0
    let formGone = 0
    while ((await text()).includes(ALICE)) {
      assert(undone < 10, 'the address is taken back within a few undo steps')
      await press('ControlOrMeta+z'); await settle()
      undone += 1
      const now = await text()
      if (!formGone && !/form=/.test(now)) formGone = undone
      assert(!(/form=/.test(now) && !now.includes(ALICE)), `undo step ${undone}: the form never stands without its address`)
    }
    assert.equal(await text(), start, 'the text is as it was before the address was typed')
    steps[leave] = { form: formGone, address: undone }
    await compiled()
    await leaveEveryWay(start, 'the address and the form undone')
    for (let n = 0; n < undone; n += 1) { await press('ControlOrMeta+Shift+z'); await settle() }
    assert.equal(await text(), written, 'redo puts the address and the form back, the form once')
    await compiled()
    await leaveEveryWay(written, 'the address and the form put back')
    await drawn(written, 's1', 'web', ALICE)
  })
  // The address and its form go back in one step when the line was left without a change; when Enter left it, the first
  // step takes the Enter and the form, the second the address.
  await check('W7. how many undo steps take back the form and the address', async () => {
    assert.deepEqual(steps, { ArrowUp: { form: 1, address: 1 }, Enter: { form: 1, address: 2 } })
  })

  // ── G. One line of grace ──
  const LEAVES = {
    'ArrowUp': async () => { await press('ArrowUp'); await settle() },
    'a click elsewhere': async () => { await click(1) },
    'leaving the editor': async () => { await run(() => window.blurEditor()); await settle() },
    'Enter': async () => { await enter(); await settle() }
  }
  /** The source line typed on slide One's empty line and left by Enter: the list is continued, nothing is written yet. */
  const sourceThenEnter = async (start, source) => {
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await type(source)
    await compiled()
    await enter(); await settle()
    assert.equal(await text(), replaceLine(start, line, [source, '- ']), 'Enter continues the list under the source line: no form yet')
    return line
  }
  for (const [what, link, form] of [['a web link', ALICE, 'web'], ['a DOI', DOI, 'paper']]) for (const leave of Object.keys(LEAVES)) {
    await check(`G1. a source line with ${what}, Enter, Enter, then the line left by ${leave}`, async () => {
      const start = talk()
      const source = `- Author ${link}`
      const line = await sourceThenEnter(start, source)
      await enter(); await settle()
      const emptied = withForm(replaceLine(start, line, [source, '']), 's1', form)
      assert.equal(await text(), emptied, `the second Enter takes the empty item out, and form=${form} is written at that Enter`)
      await drawn(emptied, 's1', form, link)
      await LEAVES[leave]()
      const expected = leave === 'Enter' ? replaceLine(emptied, line + 1, ['', '']) : emptied
      assert.equal(await text(), expected, 'the line left: nothing more is written')
      await compiled()
      await leaveEveryWay(expected, 'left again')
    })
  }
  await check('G2. a source line, Enter, a letter typed in the new item and deleted, Enter, the line left', async () => {
    const start = talk()
    const source = `- Author ${ALICE}`
    const line = await sourceThenEnter(start, source)
    await type('x')
    await press('Backspace')
    assert.equal(/form=/.test(await text()), false, 'the item is empty but still there: no form yet')
    await enter(); await settle()
    const expected = withForm(replaceLine(start, line, [source, '']), 's1', 'web')
    assert.equal(await text(), expected, 'every edit was on the two lines: form=web when the empty item is taken out')
    await drawn(expected, 's1', 'web', ALICE)
    await compiled()
    await leaveEveryWay(expected, 'the line left')
  })
  await check('G2. a source line, Enter, words typed in the new item and deleted with its marker by hand', async () => {
    const start = talk()
    const source = `- Author ${ALICE}`
    const line = await sourceThenEnter(start, source)
    await type('xy')
    const now = await text()
    const end = endOf(now, '- xy')
    // The item's text and marker selected and deleted, the caret staying on the line.
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: end - 4, to: end, insert: '' }], cursor: end - 4, userEvent: 'delete.selection' }])
    await settle()
    const expected = withForm(replaceLine(start, line, [source, '']), 's1', 'web')
    assert.equal(await text(), expected, 'the line under the source line is empty again: form=web')
    await drawn(expected, 's1', 'web', ALICE)
  })
  await check('G3. a source line, Enter, a save, Enter, the line left', async () => {
    const start = talk({ three: true })
    const source = `- Author ${ALICE}`
    await sourceThenEnter(start, source)
    assert.equal(await save(), true, 'the save stamps the slide with no id')
    const saved = await text()
    await enter(); await settle()
    const expected = withForm(replaceLine(saved, lineOf(saved, '- '), ['']), 's1', 'web')
    assert.equal(await text(), expected, 'the ids the save stamped are in the kept "before" too: form=web at the second Enter')
    await drawn(expected, 's1', 'web', ALICE)
    await compiled()
    await leaveEveryWay(expected, 'the line left')
  })
  await check('G4. a source line begun with a dash (— Author <link>), left by Enter', async () => {
    // No list: Enter makes an empty line, the slide is a quotation with its source at once.
    const start = talk()
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await type(`— Author ${ALICE}`)
    await compiled()
    await enter(); await settle()
    const expected = withForm(replaceLine(start, line, [`— Author ${ALICE}`, '']), 's1', 'web')
    assert.equal(await text(), expected, 'form=web at the Enter')
    await drawn(expected, 's1', 'web', ALICE)
    await compiled()
    await leaveEveryWay(expected, 'the new line left')
  })
  await check('G5. a source line, Enter, words typed in the new item, the line left: a list, nothing written', async () => {
    const start = talk()
    const source = `- Author ${ALICE}`
    const line = await sourceThenEnter(start, source)
    await type('more words')
    await compiled()
    const expected = replaceLine(start, line, [source, '- more words'])
    assert.equal((await compile(expected)).slides.find((slide) => slide.id === 's1')?.layout, 'list', 'the full compiler reads a quotation with two items under it as a list')
    await leaveEveryWay(expected, 'two items under the quotation')
  })
  await check('G6. a source line, Enter, then the link deleted on the line above', async () => {
    const start = talk()
    const source = `- Author ${ALICE}`
    const line = await sourceThenEnter(start, source)
    await press('ArrowUp'); await press('End')
    await press('Backspace', ALICE.length + 1)
    await settle()
    const expected = replaceLine(start, line, ['- Author', '- '])
    assert.equal(await text(), expected, 'the link is gone, no form')
    await compiled()
    await leaveEveryWay(expected, 'the link deleted')
    // The same with the caret staying on the new item (a change within the two lines that is not typed at the caret).
    await sourceThenEnter(start, source)
    const now = await text()
    const end = endOf(now, source)
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: end - ALICE.length - 1, to: end, insert: '' }], userEvent: 'delete.selection' }])
    await enter(); await settle()
    await compiled()
    await leaveEveryWay(replaceLine(start, line, ['- Author', '']), 'the link deleted from the new item\'s line')
  })
  for (const userEvent of [undefined, 'input.type']) await check(`G7. a source line, Enter, a program's change on another slide (${userEvent ?? 'no user event'}), Enter, the line left`, async () => {
    const start = talk()
    const source = `- Author ${ALICE}`
    const line = await sourceThenEnter(start, source)
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: endOf(await text(), '- Bob'), insert: ' Jones' }], userEvent }])
    await enter(); await settle()
    await compiled()
    const expected = replaceLine(replaceLine(start, lineOf(start, '- Bob'), ['- Bob Jones']), line, [source, ''])
    await leaveEveryWay(expected, 'a change outside the two lines: the kept "before" is discarded, nothing is written')
  })
  await check('G8. two lines on: a source line, Enter, an item typed, Enter, Enter, then that item deleted', async () => {
    const start = talk()
    const source = `- Author ${ALICE}`
    const line = await sourceThenEnter(start, source)
    await type('x')
    await enter(); await settle()
    await enter(); await settle()
    assert.equal(await text(), replaceLine(start, line, [source, '- x', '']), 'a list of two items and an empty line; no form (a list)')
    // The item is deleted from the line under it: the slide is a quotation with its source again, but the line whose
    // link was typed was left two lines ago.
    const now = await text()
    const from = endOf(now, source)
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from, to: from + '\n- x'.length, insert: '' }], userEvent: 'delete.selection' }])
    await compiled()
    const expected = replaceLine(start, line, [source, ''])
    assert.equal(await text(), expected, 'the item is gone')
    await leaveEveryWay(expected, 'one line of grace, no more: nothing is written')
  })
  await check('G9. a source line, Enter in the middle of its link, Enter, the line left', async () => {
    const start = talk()
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await type(`- Author ${ALICE}`)
    await press('ArrowLeft', '.org/alice'.length)
    await type('x')
    await compiled()
    await enter(); await settle()
    await press('Home'); await enter(); await settle()
    await compiled()
    const cut = await text()
    assert(cut.includes('- Author https://examplex\n') && !cut.includes(`${ALICE}`) && !/form=/.test(cut), 'the link is cut in two, no form')
    await leaveEveryWay(cut, 'the link cut in two')
  })
  // The next slide's heading typed on the emptied line and left by Enter: the form is written at that Enter.
  await check('G1. a source line, Enter, Enter, the next slide\'s heading typed, Enter', async () => {
    const start = talk()
    const source = `- Author ${ALICE}`
    const line = await sourceThenEnter(start, source)
    await enter(); await settle()
    await type('### Next')
    await enter(); await settle()
    const expected = withForm(replaceLine(start, line, [source, '### Next']), 's1', 'web')
    assert.equal(await text(), expected, 'form=web on the slide above, written once, at the second Enter')
    await drawn(expected, 's1', 'web', ALICE)
  })
  const graceSteps = {}
  await check('G10. undo and redo across the form written for a source line left by Enter', async () => {
    const start = talk()
    const source = `- Author ${ALICE}`
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await page.waitForTimeout(700)
    await type(source)
    await compiled()
    await enter(); await enter(); await settle()
    const written = withForm(replaceLine(start, line, [source, '']), 's1', 'web')
    assert.equal(await text(), written, 'the form was written')
    let undone = 0
    while ((await text()).includes(ALICE)) {
      assert(undone < 10, 'the link is taken back within a few undo steps')
      await press('ControlOrMeta+z'); await settle()
      undone += 1
      const now = await text()
      if (!graceSteps.form && !/form=/.test(now)) graceSteps.form = undone
      assert(!(/form=/.test(now) && !now.includes(ALICE)), `undo step ${undone}: the form never stands without its link`)
    }
    graceSteps.link = undone
    assert.equal(await text(), start, 'the text is as it was before the source line was typed')
    await compiled()
    await leaveEveryWay(start, 'everything undone')
    for (let n = 0; n < undone; n += 1) { await press('ControlOrMeta+Shift+z'); await settle() }
    assert.equal(await text(), written, 'redo puts the source line and the form back, the form once')
    await compiled()
    await leaveEveryWay(written, 'put back')
    await drawn(written, 's1', 'web', ALICE)
    // The source line, the two Enters and the form are one undo step (the app's list Enter joins the typing before it).
    assert.deepEqual({ form: graceSteps.form, link: graceSteps.link }, { form: 1, link: 1 })
  })

  // ── P1. A change that is not the user's on the line being typed ──
  for (const userEvent of [undefined, 'input.type']) await check(`P1. a link put on the line being typed (${userEvent ?? 'no user event: a program'})`, async () => {
    const start = talk({ one: '- Alice' })
    await mount(start)
    const line = lineOf(start, '- Alice')
    await click(line)
    await type(' Smith')
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: endOf(await text(), '- Alice Smith'), insert: ` ${ALICE}` }], userEvent }])
    const typed = replaceLine(start, line, [`- Alice Smith ${ALICE}`])
    assert.equal(await text(), typed, 'the words were typed and the link put after them, no form yet')
    await compiled()
    await press('ArrowUp'); await settle()
    if (userEvent) {
      const expected = withForm(typed, 's1', 'web')
      assert.equal(await text(), expected, 'the same change as the user\'s typing: form=web')
      await drawn(expected, 's1', 'web', ALICE)
    } else {
      assert.equal(await text(), typed, 'the user typed no link: no form')
      await compiled()
      await click(line)
      await leaveEveryWay(typed, 'the line visited again')
    }
  })
  await check('P1. a program changes the line being typed (no link), then the user types a link on it: no form for that line; the next line begun takes its own', async () => {
    const start = talk({ one: '- Alice' })
    await mount(start)
    const line = lineOf(start, '- Alice')
    await click(line)
    await type(' Smith')
    const from = endOf(await text(), '- Alice Smith') - 'Alice Smith'.length
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from, to: from + 5, insert: 'Alicia' }] }])
    await type(` ${ALICE}`)
    const typed = replaceLine(start, line, [`- Alicia Smith ${ALICE}`])
    assert.equal(await text(), typed, 'the program\'s change and then the link typed after it')
    await compiled()
    await leaveEveryWay(typed, 'what "before" was can no longer be told for this line: nothing is written')
    await click(lineOf(typed, '- Bob'))
    await type(` ${BOB}`)
    await compiled()
    await press('ArrowUp'); await settle()
    const expected = withForm(replaceLine(typed, lineOf(typed, '- Bob'), [`- Bob ${BOB}`]), 's2', 'web')
    assert.equal(await text(), expected, 'form=web on the slide whose link was typed next, and on that one alone')
    await drawn(expected, 's2', 'web', BOB)
  })
  await check('P1. a program changes a line nobody is typing on, then the user types a link on it: the form is written', async () => {
    const start = talk({ one: '- Alice' })
    await mount(start)
    const line = lineOf(start, '- Alice')
    const from = endOf(start, '- Alice') - 5
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from, to: from + 5, insert: 'Alicia' }] }])
    await click(line)
    await type(` ${ALICE}`)
    await compiled()
    await press('ArrowUp'); await settle()
    const expected = withForm(replaceLine(start, line, [`- Alicia ${ALICE}`]), 's1', 'web')
    assert.equal(await text(), expected, 'the line was begun after the program\'s change: the link is the user\'s, form=web')
    await drawn(expected, 's1', 'web', ALICE)
  })

  // ── P2. A change that is not the user's on the two lines of the kept "before" ──
  for (const userEvent of [undefined, 'input.type']) await check(`P2. a source line with no link, Enter, a link put on it (${userEvent ?? 'no user event: a program'}), Enter`, async () => {
    const start = talk()
    const line = await sourceThenEnter(start, '- Author')
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: endOf(await text(), '- Author'), insert: ` ${ALICE}` }], userEvent }])
    assert.equal(await text(), replaceLine(start, line, [`- Author ${ALICE}`, '- ']), 'the link is on the source line, the caret on the item under it')
    await compiled()
    await enter(); await settle()
    const emptied = replaceLine(start, line, [`- Author ${ALICE}`, ''])
    if (userEvent) {
      const expected = withForm(emptied, 's1', 'web')
      assert.equal(await text(), expected, 'the same change as the user\'s typing: form=web at the second Enter')
      await drawn(expected, 's1', 'web', ALICE)
    } else {
      assert.equal(await text(), emptied, 'the user typed no link: no form')
      await compiled()
      await leaveEveryWay(emptied, 'the line left')
    }
  })
  const SOURCE = `- Author ${ALICE}`
  const PROGRAMS = {
    // On the first of the two lines (the source line).
    'the typed link replaced by another address': { change: (end) => ({ from: end - ALICE.length, to: end, insert: BOB }), lines: [`- Author ${BOB}`, ''] },
    'words put on the source line, the typed link left as it is': { change: (end) => ({ from: end - ALICE.length - 1, insert: ' Jr' }), lines: [`- Author Jr ${ALICE}`, ''] },
    // On the second (the item under it).
    'a letter put in the item under it, deleted by the user': { change: (end) => ({ from: end + 3, insert: 'x' }), keys: async () => { await press('End'); await press('Backspace') }, lines: [SOURCE, ''] },
    'the item under it emptied': { change: (end) => ({ from: end + 1, to: end + 3, insert: '' }), noEnter: true, lines: [SOURCE, ''] }
  }
  for (const [what, program] of Object.entries(PROGRAMS)) await check(`P2. a source line, Enter, a program's change on the two lines (${what}), Enter`, async () => {
    const start = talk()
    const line = await sourceThenEnter(start, SOURCE)
    await run((specs) => window.dispatchAll(specs), [{ changes: [program.change(endOf(await text(), SOURCE))] }])
    await settle()
    assert.equal(/form=/.test(await text()), false, 'the program\'s change writes no form')
    await program.keys?.()
    await compiled()
    if (!program.noEnter) { await enter(); await settle() }
    const expected = replaceLine(start, line, program.lines)
    assert.equal(await text(), expected, 'the kept "before" was discarded: no form')
    await compiled()
    await leaveEveryWay(expected, 'the line left')
  })

  // ── P3. Undo and redo with a "before" kept ──
  for (const rounds of [1, 2]) await check(`P3. a source line, Enter, undo and redo (${rounds === 1 ? 'once' : 'twice'}), Enter, ArrowUp`, async () => {
    const start = talk()
    const line = await sourceThenEnter(start, SOURCE)
    const continued = await text()
    for (let round = 0; round < rounds; round += 1) {
      await press('ControlOrMeta+z'); await settle()
      const undone = await text()
      assert(undone !== continued && !/form=/.test(undone), 'the undo took typing back and wrote nothing')
      await press('ControlOrMeta+Shift+z'); await settle()
      assert.equal(await text(), continued, 'the redo put it again: the source line and the empty item under it, no form yet')
    }
    await compiled()
    await enter(); await settle()
    const expected = withForm(replaceLine(start, line, [SOURCE, '']), 's1', 'web')
    assert.equal(await text(), expected, 'form=web at the Enter that takes the empty item out, as with no undo in between')
    await drawn(expected, 's1', 'web', ALICE)
    await press('ArrowUp'); await settle()
    assert.equal(await text(), expected, 'the line left: the complete source line, an empty line under it, the form once')
    await compiled()
    await leaveEveryWay(expected, 'left again')
    // Undone step by step: the form never stands without its link.
    let steps = 0
    while ((await text()).includes(ALICE)) {
      assert(steps < 10, 'the link is taken back within a few undo steps')
      await press('ControlOrMeta+z'); await settle()
      steps += 1
      const now = await text()
      assert(!(/form=/.test(now) && !now.includes(ALICE)), `undo step ${steps}: the form never stands without its link`)
    }
    assert.equal(await text(), start, 'the text is as it was before the source line was typed')
  })
  await check('P3. a source line, Enter, undo, other words typed, the line left: nothing for the undone link', async () => {
    const start = talk()
    const line = await sourceThenEnter(start, SOURCE)
    await press('ControlOrMeta+z'); await settle()
    assert.equal(await text(), start, 'the undo took the source line and the Enter back')
    await type('- Someone else')
    await compiled()
    const typed = replaceLine(start, line, ['- Someone else'])
    await press('ArrowUp'); await settle()
    assert.equal(await text(), typed, 'the link was undone: no form')
    await click(line)
    await enter(); await settle(); await enter(); await settle()
    const expected = replaceLine(start, line, ['- Someone else', ''])
    assert.equal(await text(), expected, 'Enter, Enter under the other words: no form')
    await compiled()
    await leaveEveryWay(expected, 'left again')
  })
  await check('P3. an address typed, undone, other words typed, the line left: nothing for the undone link', async () => {
    const start = talk()
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await type(ALICE)
    await press('ControlOrMeta+z'); await settle()
    assert.equal(await text(), start, 'the undo took the address back')
    await type('Other words.')
    await compiled()
    const typed = replaceLine(start, line, ['Other words.'])
    await leaveEveryWay(typed, 'the address was undone')
  })
  await check('P3. a source line typed, more words typed and undone, the line left: the link that is still there takes its form', async () => {
    const start = talk()
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await type(SOURCE)
    // Longer than the history's grouping delay: the undo below takes back the words typed after it and no more.
    await page.waitForTimeout(700)
    await type('x')
    await page.waitForTimeout(700)
    await type('yz')
    await press('ControlOrMeta+z'); await settle()
    assert.equal(await text(), replaceLine(start, line, [`${SOURCE}x`]), 'the undo took back the last words only')
    await press('Backspace')
    await compiled()
    await press('ArrowUp'); await settle()
    const expected = withForm(replaceLine(start, line, [SOURCE]), 's1', 'web')
    assert.equal(await text(), expected, 'an undo within the line is no leaving and loses nothing: form=web when the line is left')
    await drawn(expected, 's1', 'web', ALICE)
  })

  // ── P4. The editor destroyed with a check queued ──
  await check('P4. a link typed, the line left and the editor destroyed in the same task: nothing is written into its state', async () => {
    const start = talk({ one: '- Alice' })
    await mount(start)
    const at = endOf(start, '- Alice')
    const link = ` ${ALICE}`
    const [left, after] = await run((specs) => window.destroyedAfter(specs), [
      { cursor: at, userEvent: 'select.pointer' },
      { changes: [{ from: at, insert: link }], cursor: at + link.length, userEvent: 'input.type' },
      { cursor: 0, userEvent: 'select.pointer' }
    ])
    const typed = replaceLine(start, lineOf(start, '- Alice'), [`- Alice${link}`])
    assert.equal(left, typed, 'the link was typed and the line left (its check queued) when the editor was destroyed')
    assert.equal(after, typed, 'the destroyed editor\'s state holds the text as it was left: no form written into it')
  })

  // ── R. Undo and redo are never read as typing; Tab and Shift-Tab on the caret's line are ──
  // The watch runs inside the editor's update: an error there is logged by CodeMirror and the watch switched off, which
  // every "nothing is written" below would pass. Each R case asserts that nothing was logged.
  const logged = []
  page.on('console', (message) => { if (message.type() === 'error') logged.push(message.text()) })
  page.on('pageerror', (error) => logged.push(String(error)))
  const rcheck = (name, body) => check(name, async () => {
    logged.length = 0
    await body()
    assert.deepEqual(logged, [], 'nothing went wrong in the editor')
  })
  const undo = async () => { await press('ControlOrMeta+z'); await settle() }
  const redo = async () => { await press('ControlOrMeta+Shift+z'); await settle() }
  // Longer than the history's grouping delay: what is typed after it is an undo step of its own.
  const pause = () => page.waitForTimeout(700)
  const WITH_LINK = `- Author ${ALICE}`
  // R1. The link was on the slide all along. A change that is not the user's takes it away (or puts another in its
  // place), the user types a word, and two undos take the word back and then that change: the link is there again,
  // and nobody typed it.
  const NOT_THE_USERS = {
    'a program deletes the link': { now: '- Author', change: async (start) => run((specs) => window.dispatchAll(specs), [{ changes: [{ from: endOf(start, WITH_LINK) - ALICE.length - 1, to: endOf(start, WITH_LINK), insert: '' }] }]) },
    'a program puts another link in its place': { now: `- Author ${BOB}`, change: async (start) => run((specs) => window.dispatchAll(specs), [{ changes: [{ from: endOf(start, WITH_LINK) - ALICE.length, to: endOf(start, WITH_LINK), insert: BOB }] }]) },
    // A saved text that is not the sent one with ids put in: adoptSavedText makes one ordinary, undoable replacement.
    'a save\'s adoption (the undoable replacement) takes the link out': { now: '- Author', change: async (start) => assert.equal(await run(([a, b]) => window.adopt(a, b), [start, start.replace(` ${ALICE}`, '')]), true, 'the saved text is adopted') }
  }
  for (const [what, other] of Object.entries(NOT_THE_USERS)) await rcheck(`R1. the link there all along, ${what}, a word typed, undo, undo, the line left: no form`, async () => {
    const start = talk({ one: WITH_LINK })
    await mount(start)
    const line = lineOf(start, WITH_LINK)
    await click(line)
    await other.change(start)
    const changed = replaceLine(start, line, [other.now])
    assert.equal(await text(), changed, 'the change that is not the user\'s')
    await pause()
    await type(' Smith')
    assert.equal(await text(), replaceLine(start, line, [`${other.now} Smith`]), 'the user\'s word after it')
    await undo()
    assert.equal(await text(), changed, 'the first undo takes the word back')
    await undo()
    assert.equal(await text(), start, 'the second undo takes back the change that was not the user\'s: the link is there again')
    await compiled()
    await press('ArrowUp'); await settle()
    assert.equal(await text(), start, 'the user typed no link: no form')
    await click(line)
    await leaveEveryWay(start, 'the line visited again')
  })
  await rcheck('R1. the link typed by the user, a program deletes it, a word typed, undo, undo, the line left: no form', async () => {
    // The document the second undo leaves is one the user did reach by typing, before the program's change. Nothing
    // from before a change that is not the user's is kept: what was held then is not held again.
    const start = talk({ one: '- Author' })
    await mount(start)
    const line = lineOf(start, '- Author')
    await click(line)
    await type(` ${ALICE}`)
    const typed = replaceLine(start, line, [WITH_LINK])
    // Within the grouping delay the history would join the program's deletion to the typing it undoes.
    await pause()
    await NOT_THE_USERS['a program deletes the link'].change(typed)
    assert.equal(await text(), start, 'the program took the typed link out')
    await pause()
    await type(' Smith')
    await undo()
    assert.equal(await text(), start, 'the first undo takes the word back')
    await undo()
    assert.equal(await text(), typed, 'the second undo takes the program\'s deletion back')
    await compiled()
    await leaveEveryWay(typed, 'the link came back by undoing a program\'s change')
  })
  await rcheck('R2. a program deletes the link, the user types the very same link, undo, undo, the line left: no form', async () => {
    // The document the second undo leaves equals one the user reached by typing; it was reached by undoing the
    // program's change, which lies before everything in the list.
    const start = talk({ one: WITH_LINK })
    await mount(start)
    const line = lineOf(start, WITH_LINK)
    await click(line)
    await NOT_THE_USERS['a program deletes the link'].change(start)
    await pause()
    await type(` ${ALICE}`)
    assert.equal(await text(), start, 'the user typed the link again')
    await undo()
    assert.equal(await text(), replaceLine(start, line, ['- Author']), 'the first undo takes the typed link back')
    await undo()
    assert.equal(await text(), start, 'the second undo takes the program\'s deletion back')
    await compiled()
    await press('ArrowUp'); await settle()
    assert.equal(await text(), start, 'the link that is there is the one that was there: no form')
    // Redone twice: the first redo puts the program's deletion again, which no document in the list follows.
    await click(line)
    await redo(); await redo()
    assert.equal(await text(), start, 'both redone: the link the user typed')
    await compiled()
    await leaveEveryWay(start, 'the redo of a program\'s change is not followed either')
  })
  await rcheck('R3. a program puts a link on the line, the user types elsewhere on it, undo, redo, the line left: no form', async () => {
    const start = talk({ one: '- Author' })
    await mount(start)
    const line = lineOf(start, '- Author')
    await click(line)
    const end = endOf(start, '- Author')
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: end, insert: ` ${ALICE}` }], cursor: end + ALICE.length + 1 }])
    await pause()
    await type(' and more')
    const typed = replaceLine(start, line, [`${WITH_LINK} and more`])
    assert.equal(await text(), typed, 'the program\'s link and the user\'s words after it')
    await undo()
    assert.equal(await text(), replaceLine(start, line, [WITH_LINK]), 'the undo takes the words back')
    await redo()
    assert.equal(await text(), typed, 'the redo puts them again')
    await compiled()
    await leaveEveryWay(typed, 'the user typed no link')
  })
  await rcheck('R4. a source line typed, more words typed, undone and redone, the line left: the link takes its form', async () => {
    const start = talk()
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await type('- Author')
    await pause()
    await type(` ${ALICE}`)
    await undo()
    assert.equal(await text(), replaceLine(start, line, ['- Author']), 'the undo takes the link back')
    await redo()
    const typed = replaceLine(start, line, [WITH_LINK])
    assert.equal(await text(), typed, 'the redo puts it again')
    await compiled()
    await press('ArrowUp'); await settle()
    const expected = withForm(typed, 's1', 'web')
    assert.equal(await text(), expected, 'undo and redo within the line lose nothing: form=web when the line is left')
    await drawn(expected, 's1', 'web', ALICE)
  })
  await rcheck('R5. more characters typed after the link than documents are kept, undone, the line left: nothing written, nothing wrong', async () => {
    const start = talk()
    await mount(start)
    const line = lineOf(start, QUOTE_ONE) + 2
    await click(line)
    await type(WITH_LINK)
    await pause()
    await type('x'.repeat(300))
    assert.equal(await text(), replaceLine(start, line, [WITH_LINK + 'x'.repeat(300)]), '300 characters after the link')
    await undo()
    const typed = replaceLine(start, line, [WITH_LINK])
    assert.equal(await text(), typed, 'one undo takes the 300 characters back')
    await compiled()
    // The document with the link alone is older than the list reaches: what was held cannot be told, so nothing is.
    // (With fewer characters the form is written: P3, "more words typed and undone".)
    await leaveEveryWay(typed, 'undone back past what is kept')
    await click(line)
    await type(' Jr')
    await compiled()
    await leaveEveryWay(replaceLine(start, line, [`${WITH_LINK} Jr`]), 'the line typed on again: still held, no form')
  })
  // R6 to R9. Tab and Shift-Tab.
  await rcheck('R6. a link typed on the source line, Tab, Shift-Tab, the line left: the link takes its form', async () => {
    const start = talk({ one: '- Author' })
    await mount(start)
    const line = lineOf(start, '- Author')
    await click(line)
    await type(` ${ALICE}`)
    await press('Tab')
    assert.equal(await text(), replaceLine(start, line, [`  ${WITH_LINK}`]), 'Tab indents the item')
    await press('Shift+Tab')
    const typed = replaceLine(start, line, [WITH_LINK])
    assert.equal(await text(), typed, 'Shift-Tab takes the indent out again')
    await compiled()
    await press('ArrowUp'); await settle()
    const expected = withForm(typed, 's1', 'web')
    assert.equal(await text(), expected, 'Tab and Shift-Tab are the user\'s keys on the line: form=web')
    await drawn(expected, 's1', 'web', ALICE)
  })
  await rcheck('R7. a link typed on the source line, Tab, the line left indented', async () => {
    const start = talk({ one: '- Author' })
    await mount(start)
    const line = lineOf(start, '- Author')
    await click(line)
    await type(` ${ALICE}`)
    await press('Tab')
    const typed = replaceLine(start, line, [`  ${WITH_LINK}`])
    assert.equal(await text(), typed, 'Tab indents the item')
    await compiled()
    await press('ArrowUp'); await settle()
    // The rule decides on the text as it is left: an indented item under a quotation is still its source line for the
    // compiler, which draws the form.
    const expected = withForm(typed, 's1', 'web')
    assert.equal(await text(), expected, 'form=web, the item left indented')
    await drawn(expected, 's1', 'web', ALICE)
    await compiled()
    await leaveEveryWay(expected, 'left again')
  })
  await rcheck('R8. a link typed on the source line, the promote and demote commands (no typing key) on it, the line left: no form', async () => {
    const start = talk({ one: '- Author' })
    await mount(start)
    const line = lineOf(start, '- Author')
    await click(line)
    await type(` ${ALICE}`)
    assert.equal(await run(() => window.reLevelBy(1)), true, 'the command indents the item')
    assert.equal(await text(), replaceLine(start, line, [`  ${WITH_LINK}`]), 'the item is indented')
    assert.equal(await run(() => window.reLevelBy(-1)), true, 'and takes the indent out again')
    const typed = replaceLine(start, line, [WITH_LINK])
    assert.equal(await text(), typed, 'the line is as it was typed')
    await compiled()
    await leaveEveryWay(typed, 'a change that is not the user\'s on the line: its "before" is given up')
  })
  await rcheck('R9. a link typed on the source line, Tab and Shift-Tab moving the line under it too, the line left: no form', async () => {
    const base = talk({ one: '- Author' })
    const line = lineOf(base, '- Author')
    const start = replaceLine(base, line, ['- Author', '  of a book'])
    await mount(start)
    await click(line)
    await type(` ${ALICE}`)
    await press('Tab')
    assert.equal(await text(), replaceLine(base, line, [`  ${WITH_LINK}`, '    of a book']), 'Tab moves the item and the line under it')
    await press('Shift+Tab')
    const typed = replaceLine(base, line, [WITH_LINK, '  of a book'])
    assert.equal(await text(), typed, 'Shift-Tab moves both back')
    await compiled()
    await leaveEveryWay(typed, 'a Tab that changes more than the caret\'s line is no typing on the line')
  })

  await rcheck('R10. a program deletes the link and the user types on at once (one undo step), one undo, the line left: no form', async () => {
    // The fourth review's reproduction. Inside the history's grouping delay the typing joins the undo step of the
    // program's deletion, so one undo takes back both. The text it leaves equals one typed on the way (the link whole,
    // before the x), which is no proof of anything: that text was reached with one undo step, this one with none.
    const start = talk({ one: WITH_LINK })
    await mount(start)
    const line = lineOf(start, WITH_LINK)
    await click(line)
    const end = endOf(start, WITH_LINK)
    await run((specs) => window.dispatchAll(specs), [{ changes: [{ from: end - ALICE.length - 1, to: end, insert: '' }], cursor: end - ALICE.length - 1 }])
    await type(` ${ALICE}x`)
    await press('Backspace')
    assert.equal(await text(), start, 'the program\'s deletion, then the same link typed (with an x, taken out again)')
    await undo()
    assert.equal(await text(), start, 'one undo: the text is the original again')
    assert.equal(await run(() => window.undoDepth()), 0, 'and nothing is left to undo: the deletion and all the typing went in one step')
    await compiled()
    await press('ArrowUp'); await settle()
    assert.equal(await text(), start, 'the link that is there is the one that was there: no form')
    await click(line)
    await leaveEveryWay(start, 'the line visited again')
  })

  // ── M. Any edit of the user's counts (decided 13 October 2026); P. the same change made by a program does not ──
  // The link was there all along and no character of it is typed: the document is there, the caret is put, the user
  // presses a key and leaves the line. Where that edit leaves the slide a quotation with a source link under it, the
  // form is written, the compiler draws it with the quotation's words unchanged, and Cmd-Z never leaves the form
  // without the edit that justifies it. P makes each of those changes as a program does (no user event, no mark), with
  // the caret where the key leaves it: nothing is written.
  const MOVED = 'https://example.org/schemas-and-propositions'
  /** The review's document, with `lines` as the focused slide's content (the review's: the words and the source on one quotation line). */
  const moved = (lines) => ['# Talk', '', '### Focused quote', '{id=fq}', '', ...lines, '', ':::notes', 'Notes.', ':::', ''].join('\n')
  /** The document mounted, the caret on its line `line`, `back` characters before the line's end. */
  const caretIn = async (doc, line, back) => { await mount(doc); await click(lineOf(doc, line)); await press('ArrowLeft', back); await compiled() }
  /** The one replacement that makes `from` into `to`, as a program would dispatch it. */
  const between = (from, to) => {
    let start = 0
    while (start < from.length && start < to.length && from[start] === to[start]) start += 1
    let end = 0
    while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end += 1
    return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) }
  }
  /** `written` is `edited` with the form and nothing else; the compiler draws it, citing `link`, with the quotation's words as it reads them in `edited`. */
  const drawnAfter = async (edited, written, link, form = 'web') => {
    assert.equal(written, withForm(edited, 'fq', form), 'the text is the one the user\'s edit left with the form on the slide\'s layout line: nothing else changed')
    const before = compiledWords((await compile(edited)).slides.find((slide) => slide.id === 'fq'))
    assert(before.length > 0, 'the slide has a quotation before the form is written')
    assert.equal(drawnForm(await compile(written), 'fq', form, { wordsBefore: before, link }), '', `the full compiler draws form=${form}, citing ${link}, the quotation's words unchanged`)
  }
  /** Cmd-Z, step by step, to the start: every text on the way. A text with a form in it is `written` itself: the form never stands without the edit that justifies it. */
  const undoWalk = async (written) => {
    const walk = []
    while (await run(() => window.undoDepth()) > 0) {
      await undo()
      const now = await text()
      assert(!now.includes('form=') || now === written, `undo step ${walk.length + 1}: the form stands without the user's edit: ${JSON.stringify(now)}`)
      walk.push(now)
      assert(walk.length < 50, 'the undo history ends')
    }
    return walk
  }
  const THERE = `- Author ${MOVED}`
  const ONE = `> Words. ${THERE}`
  const DASHED = `> Words. — Author ${MOVED}`
  const ITEM = `- Someone ${THERE}`
  const CUT = MOVED.slice(0, -'-and-propositions'.length)
  // name: the slide's lines, the caret's line and how far before its end, the keys, the lines they leave; `link`: the
  // link cited (the slide's own, unless the edit cut it short). In each the form is written when the caret leaves the
  // line, not by the key.
  const EDITS = {
    'M1. Shift-Enter in the middle of a quotation line, the source after the caret (a hyphen, the caret after the words)': { before: [ONE], on: ONE, back: ONE.length - '> Words.'.length, keys: ['Shift+Enter'], after: ['> Words.', '>', `> ${THERE}`] },
    'M1. Shift-Enter in the middle of a quotation line, the source after the caret (a hyphen, the caret after the space)': { before: [ONE], on: ONE, back: ONE.length - '> Words. '.length, keys: ['Shift+Enter'], after: ['> Words.', '>', `> ${THERE}`] },
    'M1. Shift-Enter in the middle of a quotation line, the source after the caret (a dash, the caret after the space)': { before: [DASHED], on: DASHED, back: DASHED.length - '> Words. '.length, keys: ['Shift+Enter'], after: ['> Words.', '>', `> — Author ${MOVED}`] },
    // The same key of CodeMirror's own (a user event of input): with the caret after the space it leaves the very
    // source line; with it before the space the line has two spaces after its marker and is no source line.
    'M2. Enter in the middle of a quotation line, the source after the caret (a hyphen, the caret after the space)': { before: [ONE], on: ONE, back: ONE.length - '> Words. '.length, keys: ['Enter'], after: ['> Words.', `> ${THERE}`] },
    'M2. Enter in the middle of a quotation line, the source after the caret (a dash, the caret after the space)': { before: [DASHED], on: DASHED, back: DASHED.length - '> Words. '.length, keys: ['Enter'], after: ['> Words.', `> — Author ${MOVED}`] },
    // Tab on a line that is no list item puts its two spaces at the caret.
    'M4. Tab after the hyphen of -Author <link> (the line becomes an item)': { before: ['> Words.', '', `-Author ${MOVED}`], on: `-Author ${MOVED}`, back: `Author ${MOVED}`.length, keys: ['Tab'], after: ['> Words.', '', `-  Author ${MOVED}`] },
    'M4. Tab in the middle of the link of a source line begun with a dash (the link is cut short)': { before: ['> Words.', '', `— Author ${MOVED}`], on: `— Author ${MOVED}`, back: '-and-propositions'.length, keys: ['Tab'], after: ['> Words.', '', `— Author ${CUT}  -and-propositions`], link: CUT },
    // An empty marker taken out by the user: no text moves, and the slide is a quotation with its source again.
    'M7. Enter on an empty item under an address': { before: ['> Words.', '', MOVED, '- '], on: '- ', back: 0, keys: ['Enter'], after: ['> Words.', '', MOVED, ''] },
    'M7. Enter on an empty item above a source line': { before: ['> Words.', '', '- ', THERE], on: '- ', back: 0, keys: ['Enter'], after: ['> Words.', '', '', THERE] },
    'M7. Enter on a marker-only quotation line under an address': { before: ['> Words.', '', MOVED, '> '], on: '> ', back: 0, keys: ['Enter'], after: ['> Words.', '', MOVED, '', ''] },
    'M7. Enter on a marker-only quotation line above a source line': { before: ['> Words.', '', '> ', THERE], on: '> ', back: 0, keys: ['Enter'], after: ['> Words.', '', '', '', THERE] },
    'M8. Backspace, Backspace over an empty item under an address': { before: ['> Words.', '', MOVED, '- '], on: '- ', back: 0, keys: ['Backspace', 'Backspace'], after: ['> Words.', '', MOVED, ''] },
    'M8. Backspace over an empty item above a source line': { before: ['> Words.', '', '- ', THERE], on: '- ', back: 0, keys: ['Backspace'], after: ['> Words.', '', '', THERE] },
    'M8. Backspace over a marker-only quotation line under an address': { before: ['> Words.', '', MOVED, '> '], on: '> ', back: 0, keys: ['Backspace'], after: ['> Words.', '', MOVED, ''] },
    'M9. a space typed after the hyphen of -Author <link> (the line becomes an item)': { before: ['> Words.', '', `-Author ${MOVED}`], on: `-Author ${MOVED}`, back: `Author ${MOVED}`.length, keys: ['Space'], after: ['> Words.', '', THERE] }
  }
  for (const [name, edit] of Object.entries(EDITS)) {
    const start = moved(edit.before)
    const edited = moved(edit.after)
    const written = withForm(edited, 'fq', 'web')
    await rcheck(`${name}: the form is written`, async () => {
      await caretIn(start, edit.on, edit.back)
      for (const key of edit.keys) await press(key)
      await settle()
      assert.equal(await text(), edited, 'the key does what it did before, and nothing is written yet')
      await compiled()
      await press('ArrowUp'); await settle()
      assert.equal(await text(), written, 'the user\'s own edit left the slide a quotation with a source link under it: the form is written, whoever typed the link')
      await drawnAfter(edited, written, edit.link ?? MOVED)
      await leaveEveryWay(written, 'nothing more is written')
      // One undo step takes the user's edit and the form together: the form goes in the same step as what justifies it.
      assert.deepEqual(await undoWalk(written), [start], 'one Cmd-Z takes the edit and the form together')
    })
    await rcheck(`P. ${name.replace(/^M/, '')}, the same change made by a program: no form`, async () => {
      await caretIn(start, edit.on, edit.back)
      const change = between(start, edited)
      await run((specs) => window.dispatchAll(specs), [{ changes: [change], cursor: change.from + change.insert.length }])
      await settle()
      assert.equal(await text(), edited, 'the program made the very change the key makes, with no user event and no mark')
      await compiled()
      await leaveEveryWay(edited, 'the line left')
    })
  }
  await rcheck('M7. Enter on a marker-only quotation line under a source line that was the slide\'s source already: no form', async () => {
    // The outline reads `- Author <link>` as the quotation's source with the empty marker under it too: taking the
    // marker out makes no link newly the source, so there is nothing to write.
    await caretIn(moved(['> Words.', '', THERE, '', '> ']), '> ', 0)
    await enter(); await settle()
    const expected = moved(['> Words.', '', THERE, '', '', ''])
    assert.equal(await text(), expected, 'the marker is taken out and an empty line added, as before')
    await compiled()
    await leaveEveryWay(expected, 'the line left')
  })
  await rcheck('M2. Enter in the middle of a quotation line, then a letter typed and deleted on the line it made: the form is written', async () => {
    const start = moved([ONE])
    await caretIn(start, ONE, ONE.length - '> Words. '.length)
    await enter(); await settle()
    await type('x'); await press('Backspace')
    const edited = moved(['> Words.', `> ${THERE}`])
    await compiled()
    await press('ArrowUp'); await settle()
    const written = withForm(edited, 'fq', 'web')
    assert.equal(await text(), written, 'the letter is gone again, and the form is written')
    await drawnAfter(edited, written, MOVED)
    await leaveEveryWay(written, 'nothing more is written')
    await undoWalk(written)
    assert.equal(await text(), start, 'undone to the start, the form never without the Enter')
  })
  await rcheck('M3. Shift-Enter at the end of a quotation line, a source typed in the new paragraph: the form is written', async () => {
    const start = moved(['> Words.'])
    await mount(start)
    await click(lineOf(start, '> Words.'))
    await press('Shift+Enter')
    await type(THERE)
    await compiled()
    const typed = moved(['> Words.', '>', `> ${THERE}`])
    assert.equal(await text(), typed, 'the source is typed as a paragraph of the quotation')
    await press('ArrowUp'); await settle()
    assert.equal(await text(), withForm(typed, 'fq', 'web'), 'Shift-Enter is the user\'s edit, and the link typed after it takes its form')
  })
  await rcheck('M5. Enter in the middle of a list item, the source after the caret: a list of two, no form', async () => {
    await caretIn(moved(['> Words.', '', ITEM]), ITEM, ITEM.length - '- Someone '.length)
    await enter(); await settle()
    const expected = moved(['> Words.', '', '- Someone ', `- ${THERE}`])
    assert.equal(await text(), expected, 'the rest of the item is the next item (a list of two for the compiler, no source line); no form')
    await compiled()
    await leaveEveryWay(expected, 'the line left')
  })
  // Indenting alone gives no link a new reading: the outline's source line is read whatever its indent, so the link
  // is no newly recognised one and no form is written (what Tab and Shift-Tab do to a source line that was there).
  const LEVELS = {
    'Shift-Tab twice on a source line indented by four spaces': [[`    - Author ${MOVED}`], 0, ['Shift+Tab', 'Shift+Tab'], [`- Author ${MOVED}`]],
    'Shift-Tab twice on an address indented by four spaces': [[`    ${MOVED}`], 0, ['Shift+Tab', 'Shift+Tab'], [MOVED]],
    'Shift-Tab twice on a source line begun with a dash, indented by four spaces': [[`    — Author ${MOVED}`], 0, ['Shift+Tab', 'Shift+Tab'], [`— Author ${MOVED}`]],
    'Shift-Tab on a source line nested under another item': [['- intro', `  - Author ${MOVED}`], 1, ['Shift+Tab'], ['- intro', `- Author ${MOVED}`]],
    'Tab on a source line': [[`- Author ${MOVED}`], 0, ['Tab'], [`  - Author ${MOVED}`]],
    'Tab on a source line under another item': [['- intro', `- Author ${MOVED}`], 1, ['Tab'], ['- intro', `  - Author ${MOVED}`]]
  }
  for (const [shape, [under, on, keys, after]] of Object.entries(LEVELS)) await rcheck(`M6. a link that was there, ${shape}, the line left: no form`, async () => {
    await caretIn(moved(['> Words.', '', ...under]), under[on], 0)
    for (const key of keys) await press(key)
    await settle()
    const expected = moved(['> Words.', '', ...after])
    assert.equal(await text(), expected, 'the indent changes; no form')
    await compiled()
    await leaveEveryWay(expected, 'the line left')
  })

  // ── S. Sequences drawn at random (fixed seeds), with an oracle of whose every character is ──
  // The page half (lib/quote-form-typed-slide-random-page.mjs) says what is drawn and what is asserted.
  const RANDOM = [
    { name: 'the app\'s history depth', seed: 20261013, ops: 60000, episodeOps: 30, least: 100 },
    { name: 'a history that keeps two steps (its oldest steps dropped all the time)', seed: 11, ops: 60000, episodeOps: 400, minDepth: 2, least: 10 }
  ]
  const randomRuns = []
  for (const random of RANDOM) await rcheck(`S. ${random.ops} operations drawn at random, ${random.name}`, async () => {
    const result = await run((options) => window.randomRun(options), random)
    assert.equal(result.failure, null, `seed ${random.seed}: ${JSON.stringify(result.failure, null, 1)}`)
    assert.equal(result.ops, random.ops, 'every operation was run')
    assert(result.judged >= random.least, `forms were written on the way and judged by the oracle (${result.judged} of ${result.forms}): the sequences do reach the rule`)
    if (random.minDepth) assert(result.dropped >= 10, `the history dropped its oldest steps on the way (it lost steps ${result.dropped} times)`)
    randomRuns.push(`random sequences, ${random.name}: ${result.ops} operations in ${result.episodes} episodes, ${result.forms} forms written (${result.judged} judged by the oracle, each for a link it gives the user; all undone step by step: ${result.undone} undo steps), deepest undo history ${result.deepest}, steps lost by the history ${result.dropped} times`)
  })

  // ── T. What a line left by Enter costs on an 800-slide talk ──
  const big = ['# Talk', '', ...Array.from({ length: 800 }, (_, n) => [`### Slide ${n + 1}`, `{id=t${n + 1}}`, '', `> Words of slide ${n + 1}.`, '', `- Author ${n + 1}`, '']).flat()].join('\n')
  const timings = []
  await check('T. a line left by Enter on an 800-slide talk', async () => {
    const median = (times) => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]
    const plain = []
    const second = []
    const linked = []
    for (let round = 0; round < 5; round += 1) {
      await mount(big)
      await click(lineOf(big, '> Words of slide 400.'))
      await type(' More words.')
      plain.push(await run(() => window.timeEnter()))
      // The next line in turn: the rule is asked twice (this line's "before", then the one kept from the line above).
      await type('Words again.')
      second.push(await run(() => window.timeEnter()))
      assert.equal(/form=/.test(await text()), false, 'no link typed: no form')
      await mount(big)
      await click(lineOf(big, '- Author 400'))
      await type(` ${ALICE}`)
      linked.push(await run(() => window.timeEnter()))
      assert((await text()).includes('{id=t400} {form=web}'), 'the link typed: its form')
    }
    timings.push(`a line left by Enter on an 800-slide talk: ${median(plain).toFixed(1)} ms with no link typed (${median(second).toFixed(1)} ms for the line after it, asked twice), ${median(linked).toFixed(1)} ms with a link typed and its form written (medians of 5)`)
  })
  return [...timings, ...randomRuns]
}
