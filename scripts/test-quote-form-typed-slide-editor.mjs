// test:quote-form-typed-slide-editor — quote forms ticket 11: a quote slide typed top to bottom takes its form.
//
// Found in the packaged app with real key presses (13 October): a new quote slide typed in one go, heading first and the
// web address last, stayed a plain quote. The rule (setFormOnLinkEdits) was right; the editor handed it, as "before", the
// outline from before the whole run of typing, which did not hold the slide at all. Every earlier test handed the rule
// two texts; none typed the slide. This one types it.
//
// The real quoteLinkFormExtension in a real CodeMirror editor in chrome-headless-shell (never the real Chrome), with what
// components/Editor.tsx mounts beside it: the markdown language and its keymap, history, the token guards, the adoption of
// saved text, and the app's own Enter commands in the order of keymap/registry.ts (title-continue, protected-line-continue,
// list-continue, which also leaves a quotation on its empty marker line). Typing is key presses (page.keyboard), Enter is the Enter key, the caret leaves a line by ArrowUp or a
// click's selection event. A paste and a cut are the transactions CodeMirror makes for them (`input.paste`, `delete.cut`).
// The save is the app's: the editor's text goes through the compiler's stampMissingIds and comes back through the real
// adoptSavedText, as Editor.tsx's adoptStampedContent does it (asserted below from its source). No clock is involved: a
// pause long enough for the autosave is the call `save()` at that point of the typing.
// The compiled layouts the editor's host supplies are those of its last compile: here the compiler's own reading
// (quote-write-check's compiledQuoteAt) of every slide of the text as it stood at `compiled()`, which the test calls
// where the host's compile would have finished (the typing has stopped on the link's line; before a paste). The layout
// the rule was handed for the typed slide is checked against the full compiler for every form written.
// That is the host with its compile up to date. The editor's compile waits 900 ms for a pause in the typing
// (WorkspaceLayout.tsx), so a slide typed fast and left at once meets one of two other hosts, both run here too:
//   `none`   no layout for any line (nothing compiled yet);
//   `stale`  the layouts of the compile made before the slide was typed, by the heading lines of that text. The host
//            looks a layout up by line (WorkspaceLayout.tsx compiledLayoutAtLine: the compiled rows' `source_line`,
//            shared/slide-lines.ts), so the typed heading gets no answer, or the layout of whichever slide stood on
//            that line before (asserted below: in the middle of the talk it is the next slide's).
//
//   A. the whole slide typed in one run, no save in between;
//   B. a save (the ids stamped and adopted) at each point before the address line is begun: after the heading, after the
//      Enter under it, after the quotation, on the empty address line;
//   C. a save in the middle of typing the address, and in the middle of typing the source line's author;
//   D. A, B and C at the end of the talk, in the middle of it and as the first slide of a new section, in a talk whose
//      slides have ids and in one where none has;
//   E. the address pasted on a new empty line of a slide typed a moment ago, with and without a save before the paste.
//   Each with a `>` quotation and the address on its own line, and with a `- Author <link>` source line; web and DOI;
//   the line left by ArrowUp, by a click elsewhere, by leaving the editor, and (the bare address) by Enter.
//   A source line left by Enter takes its form one line later (see "Nothing is written at the Enter" below).
//   Every one asserts the final text (the text as typed, with `form=web` or `form=paper` on the slide's layout line and
//   nothing else changed) and that the full compiler draws that form for the slide.
//   F. A, B, C and E again with the `none` host and with the `stale` host (a quotation with an address, and a list
//      slide, standing where the heading is typed).
//   Nothing is written: for a typed slide that is a list with a link, one with `{cards}`, and a quotation with other
//   content and a link, with any of the three hosts; when the slide above a same-titled slide with no id is deleted; when a whole slide with its
//   address is pasted in one paste; when a slide is cut and pasted elsewhere; when another slide is typed on; when the
//   typed address is undone; and when the save's id lands against the typing itself (no form for that line, none guessed).
//
//   The form is decided on the document that receives it (the fix round after review): Enter in the middle of an
//   address, the link deleted before the check runs, a program's change on another slide while a line is typed, a
//   Backspace that joins lines, a click into another slide, a second caret, undo and redo across the write. Those cases
//   are in lib/quote-form-typed-slide-write-cases.mjs (W1 to W7, and T: the cost on an 800-slide talk).
//   Whose a change is (the second review): only the user's own edits count as typed on a line. A change with no user
//   event on the line, or on the two lines of the kept "before", gives the "before" up; an undo taken back by its redo
//   loses nothing; a destroyed editor is written to no more. Cases P1 to P4 of the lib.
//   Undo and redo are never read as typing (the third review): they return to a document the user reached by typing
//   alone, or everything is given up. Tab and Shift-Tab on the caret's line are the user's typing. Cases R1 to R10.
//   Sequences drawn at random from a fixed seed, with an oracle that tracks whose every character is (the fourth
//   review): case S, its page half in lib/quote-form-typed-slide-random-page.mjs.
//   Nothing is written at the Enter that leaves a `- Author <link>` source line: the app's Enter continues the list, the
//   text it leaves has an empty second item under the source line, and the compiler reads that slide as a list (asserted
//   with the full compiler). The rule is asked about that text, the one the write would go to, and writes nothing. The
//   line's "before" is kept for one more line: the second Enter takes the empty item out, and the form is written at
//   that second Enter (the line under the source line is empty again). Cases G of the lib.
//
// QUOTE_TYPED_REPORT=1 runs every case and lists the failures instead of stopping at the first (used to show which cases
// fail on the extension as it was before the fix). QUOTE_TYPED_ONLY=<prefix> runs only the cases whose name starts so.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { stampMissingIds } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { DOI, WEB, compiledWords, compilerIn, drawnForm } from './lib/quote-drawn-form-slides.mjs'
import { WRITE_CASES_PAGE, writeCases } from './lib/quote-form-typed-slide-write-cases.mjs'

const SHELL = join(homedir(), '.cache/puppeteer/chrome-headless-shell/mac_arm-146.0.7680.66/chrome-headless-shell-mac-arm64/chrome-headless-shell')
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-quote-form-typed-slide-'))
const outfile = join(dir, 'bundle.js')
const REPORT = process.env.QUOTE_TYPED_REPORT === '1'
const ONLY = process.env.QUOTE_TYPED_ONLY

// The save's adoption is the dispatch this test makes: Editor.tsx hands the stamped text to adoptSavedText, nothing else.
{
  const editor = readFileSync(join(root, 'src/renderer/src/components/Editor.tsx'), 'utf8')
  const adopt = editor.slice(editor.indexOf('const adoptStampedContent = useCallback('), editor.indexOf('// Writes `text` to `outlinePath` through the save queue'))
  assert(/adoptSavedText\(view, sourceText, savedText\)/.test(adopt), 'Editor.tsx adoptStampedContent adopts the saved text through adoptSavedText')
  assert.equal((adopt.match(/\.dispatch\(/g) ?? []).length, 0, 'and dispatches nothing of its own')
  const adoption = readFileSync(join(root, 'src/renderer/src/extensions/savedTextAdoption.ts'), 'utf8')
  const transaction = adoption.slice(adoption.indexOf('export function adoptionTransaction('), adoption.indexOf('export function adoptSavedText('))
  assert.equal((transaction.match(/savedTextAdopted\.of\(true\)/g) ?? []).length, 1, 'the adoption transaction (one shape: the save\'s undo step) carries the savedTextAdopted mark the link watch reads')
}

const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Prec } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, redo, undo, undoDepth } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { quoteLinkFormExtension } from './src/renderer/src/extensions/quoteLinkForm.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { adoptSavedText, savedTextAdoption } from './src/renderer/src/extensions/savedTextAdoption.ts'
import { continueList, leaveQuotation, newQuotationParagraph, enterFromHeading, enterFromProtectedLine, indentList, outdentList, reLevel } from './src/renderer/src/extensions/outliner.ts'
import { compiledQuoteAt } from './src/shared/quote-write-check.ts'
import './scripts/lib/quote-form-typed-slide-random-page.mjs'
let view = null
// historyConfig and extra (more extensions) are for case S alone: every other case mounts the editor as the app does.
window.mount = (doc, host = 'fresh', historyConfig = {}, extra = []) => {
  if (view) view.destroy()
  // This editor's own log: an editor destroyed by the next mount settles its last line into its own.
  const asked = window.asked = []
  let layouts = {}
  // The host's compile: the layout of the slide on every heading line of the text as it stands now.
  window.compiled = (first = false) => {
    if (host !== 'fresh' && !first) return
    const text = view.state.doc.toString()
    layouts = {}
    text.split('\\n').forEach((line, index) => { if (/^#{1,6}\\s/.test(line)) layouts[index + 1] = compiledQuoteAt(text, index + 1)?.layout })
  }
  // The host's compiledLayoutAt: what that compile gave the slide on the heading line.
  const layoutAt = (line) => {
    const layout = host === 'none' ? undefined : layouts[line]
    asked.push([line, layout])
    return layout
  }
  view = new EditorView({
    parent: document.getElementById('host'),
    state: EditorState.create({ doc, selection: EditorSelection.cursor(doc.length), extensions: [
      Prec.highest(keymap.of([
        { key: 'Enter', run: (v) => enterFromHeading(v) || enterFromProtectedLine(v) || continueList(v) || leaveQuotation(v) },
        // The app's Shift-Enter in a quotation (quote-paragraph); anywhere else it falls through to the default keymap.
        { key: 'Shift-Enter', run: newQuotationParagraph },
        // The app's Tab and Shift-Tab (keymap/registry.ts: list-indent, list-outdent).
        { key: 'Tab', run: indentList },
        { key: 'Shift-Tab', run: outdentList }
      ])),
      history(historyConfig),
      quoteLinkFormExtension(() => layoutAt),
      markdown({ base: markdownLanguage }),
      tokenProtectExtension(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      savedTextAdoption(),
      ...extra
    ] })
  })
  view.focus()
  window.compiled(true)
}
window.docText = () => view.state.doc.toString()
window.viewNow = () => view
window.caretLine = () => view.state.doc.lineAt(view.state.selection.main.head).number
// A click on a line: the caret at its end, a user selection event.
window.clickLine = (n) => { view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(n).to), userEvent: 'select.pointer' }); view.focus() }
window.pasteText = (text) => {
  const { from, to } = view.state.selection.main
  view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length), userEvent: 'input.paste' })
}
// Cut or delete whole lines first..last (1-based), with the line break that ends them (the last line of the text: the one before).
window.removeLines = (first, last, userEvent) => {
  const doc = view.state.doc
  const end = last < doc.lines ? doc.line(last + 1).from : doc.length
  const from = last < doc.lines ? doc.line(first).from : Math.max(0, doc.line(first).from - 1)
  const cut = doc.sliceString(from, end)
  view.dispatch({ changes: { from, to: end }, selection: EditorSelection.cursor(from), userEvent })
  return cut
}
window.adopt = (sent, saved) => adoptSavedText(view, sent, saved)
window.doUndo = () => undo(view)
// The promote and demote commands (menu, action bar, their own shortcuts): the same change as Tab's, by no typing key.
window.reLevelBy = (delta) => reLevel(view, delta, true)
window.undoDepth = () => undoDepth(view.state)
window.blurEditor = () => { view.contentDOM.dispatchEvent(new FocusEvent('blur')) }
${WRITE_CASES_PAGE}`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const QUOTATION = '> Schemas are the building blocks of cognition.'
const TITLE = 'Typed quote'
const OTHER = 'https://example.org/another-page'
// A talk whose slides have ids, and the same talk before its first save. Its last slide is a quote with an address
// under it and no form: an untouched slide that must stay as it is whatever is typed elsewhere.
const talk = (ids, second = 'quote') => [
  '# Talk', '',
  '## Part one', ...(ids ? ['{id=p1}'] : []), '',
  '### First', ...(ids ? ['{id=s1}'] : []), '', 'A paragraph of the first slide.', '',
  '### Second', ...(ids ? ['{id=s2}'] : []), '', ...(second === 'list' ? ['- one point', '- another point', '- a third point'] : ['> Words that were there.', '', OTHER]), ''
].join('\n')
const lineNumber = (text, line) => { const index = text.split('\n').indexOf(line); assert(index >= 0, `the text has the line "${line}"`); return index + 1 }

const compile = compilerIn(dir)
const browser = await chromium.launch({ executablePath: SHELL, headless: true })
const failures = []
let ran = 0
try {
  const page = await browser.newPage()
  await page.setContent('<div id="host"></div>')
  await page.addScriptTag({ path: outfile })
  const run = (fn, ...args) => page.evaluate(fn, ...args)
  const settle = () => run(() => new Promise((resolve) => setTimeout(resolve, 20)))
  const text = () => run(() => window.docText())
  const type = (words) => page.keyboard.type(words)
  const enter = () => page.keyboard.press('Enter')
  const click = async (line) => { await run((n) => window.clickLine(n), line); await settle() }
  /** The autosave: the text goes through the compiler's id stamp and what it wrote is adopted. True when ids were stamped. */
  const save = async () => {
    const sent = await text()
    const saved = stampMissingIds(sent).text
    if (saved === sent) return false
    assert.equal(await run(([a, b]) => window.adopt(a, b), [sent, saved]), true, 'the stamped text is adopted')
    assert.equal(await text(), saved, 'the editor holds the saved text')
    return true
  }
  const check = async (name, body) => {
    if (ONLY && !name.startsWith(ONLY)) return
    ran += 1
    try {
      await body()
    } catch (error) {
      if (!REPORT) throw new Error(`${name}: ${error.message}`, { cause: error })
      failures.push(`${name}: ${String(error.message).split('\n')[0]}`)
    }
  }

  // Where the slide is typed: the caret is put there and the line the heading goes on is made.
  const PLACES = {
    'at the end of the talk': async () => {
      await click((await text()).split('\n').length)
      await enter()
    },
    'in the middle of the talk': async () => {
      await click(lineNumber(await text(), 'A paragraph of the first slide.'))
      await enter(); await enter()
    },
    'as the first slide of a new section': async () => {
      await click((await text()).split('\n').length)
      await enter()
      await type('## Part two'); await enter(); await enter()
    }
  }
  // The slide's two shapes: the keys that type the link's line, in two halves (a save can come between them).
  const SHAPES = {
    'a bare address': (link) => [link.slice(0, 14), link.slice(14)],
    'a source line': (link) => ['- Jane Aut', `hor ${link}`]
  }
  const LEAVES = {
    'ArrowUp': async () => { await page.keyboard.press('ArrowUp'); await settle() },
    'a click elsewhere': async () => { await click(1) },
    'leaving the editor': async () => { await run(() => window.blurEditor()); await settle() },
    'Enter': async () => { await enter(); await settle() }
  }

  /** The slide's heading line (0-based index) in a text, and its form token ('' for none). */
  const typedSlide = (outline) => {
    const lines = outline.split('\n')
    const heading = lines.findIndex((line) => line.startsWith(`### ${TITLE}`))
    assert(heading >= 0, 'the typed slide is in the text')
    let end = heading + 1
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end += 1
    const block = lines.slice(heading, end).join('\n')
    return { heading, form: block.match(/\bform=([a-z]+)/)?.[1] ?? '', id: block.match(/\{id=([A-Za-z0-9_-]+)/)?.[1] ?? '' }
  }
  /** `written` is `typed` with the form token on the typed slide's layout line and nothing else changed. */
  const assertOnlyTheForm = (typed, written, form) => {
    const at = typedSlide(written)
    assert.equal(at.form, form, `the typed slide carries form=${form}`)
    const lines = written.split('\n')
    const line = lines.findIndex((candidate, index) => index > at.heading && candidate.includes(`form=${form}`))
    assert(line === at.heading + 1, 'the form is on the line under the heading (the layout line)')
    const without = lines[line].replace(new RegExp(`\\{form=${form}\\}`), '').replace(new RegExp(` form=${form}\\b`), '').trim()
    const back = [...lines.slice(0, line), ...(without ? [without] : []), ...lines.slice(line + 1)].join('\n')
    assert.equal(back, typed, 'taking the form token out gives the text as it was typed: nothing else changed')
  }
  // The typed quotation's words as the compiler gives them for a slide that is only the quotation: a written form
  // must leave them as they are.
  const typedWords = compiledWords((await compile(`# Talk\n\n### ${TITLE}\n{id=words}\n\n${QUOTATION}\n`)).slides.find((slide) => slide.id === 'words'))
  assert(typedWords.length > 0, 'the typed quotation has words')
  /** The full compiler draws `form` for the typed slide of `outline` (saved first: a slide is compiled by its id). */
  const assertDrawn = async (outline, form, link, compiledText, host = 'fresh') => {
    const saved = stampMissingIds(outline).text
    const id = typedSlide(saved).id
    assert(id, 'the typed slide has an id once saved')
    const model = await compile(saved)
    assert.equal(drawnForm(model, id, form, { wordsBefore: typedWords, link }), '', 'the full compiler draws the written form, citing the typed link, the quotation\'s words unchanged')
    if (host !== 'fresh') return
    // What the test told the rule the compiled layout was is what the full compiler says of the slide without the form.
    const plainText = stampMissingIds(compiledText).text
    const plain = await compile(plainText)
    const compiled = plain.slides.find((slide) => slide.id === typedSlide(plainText).id)?.layout
    const headingLine = typedSlide(compiledText).heading + 1
    const layoutAsked = (await run(() => window.asked)).findLast(([line]) => line === headingLine)?.[1]
    assert(compiled, 'the full compiler has the typed slide')
    assert.equal(layoutAsked, compiled, `the layout handed to the rule (${layoutAsked}) is the full compiler's for that slide (${compiled})`)
  }

  /**
   * Type the slide and leave the link's line. `saves` names the points at which the autosave runs:
   * 'heading' (the caret still on it), 'under-heading', 'quotation', 'empty-line' (the link's line, not begun), 'mid-link'.
   */
  const typeSlide = async ({ ids, place, shape, link, saves = [], leave = 'ArrowUp', paste = false, host = 'fresh', second = 'quote' }) => {
    await run(([doc, mode]) => window.mount(doc, mode), [talk(ids, second), host])
    let stamped = 0
    const at = async (point) => { if (saves.includes(point) && await save()) stamped += 1 }
    await PLACES[place]()
    await type(`### ${TITLE}`)
    await at('heading')
    await enter()
    await at('under-heading')
    await enter()
    await type(QUOTATION)
    await at('quotation')
    // Enter after a quotation continues it (`> `); Enter on that empty marker leaves it with one blank line (leaveQuotation).
    await enter(); await enter()
    await at('empty-line')
    const [first, rest] = SHAPES[shape](link)
    let compiledText = await text()
    const emptyLine = await run(() => window.caretLine())
    if (paste) {
      // The host's compile is of the text before the paste; the form is written in the paste itself.
      await run(() => window.compiled())
      await run((pasted) => window.pasteText(pasted), first + rest)
    } else {
      await type(first)
      await at('mid-link')
      await type(rest)
    }
    await settle()
    if (saves.length) assert(stamped > 0, 'a save stamped the typed slide\'s id')
    const now = await text()
    const linkLine = first + rest
    assert.equal(now.split('\n')[await run(() => window.caretLine()) - 1], linkLine, 'the caret is on the link\'s line, typed as meant')
    const slideLines = now.split('\n').slice(typedSlide(now).heading).filter((line) => line !== '' && !/^(\{[^}]*\}\s*)+$/.test(line))
    assert.deepEqual(slideLines.slice(0, 3), [`### ${TITLE}`, QUOTATION, linkLine], `the slide is its heading, its quotation and the link's line: ${JSON.stringify(now.slice(-220))}`)
    if (paste) {
      // The text as typed: the text before the paste with the link on the empty line the caret was on.
      const lines = compiledText.split('\n')
      assert.equal(lines[emptyLine - 1], '', 'the paste went onto an empty line')
      lines[emptyLine - 1] = linkLine
      return { typed: lines.join('\n'), written: now, compiledText }
    }
    assert.equal(typedSlide(now).form, '', 'while the caret is on the line nothing is set')
    // The typing has stopped: the host's compile is of the text as typed.
    await run(() => window.compiled())
    compiledText = now
    await LEAVES[leave]()
    return { typed: now, written: await text(), compiledText }
  }

  const describe = (c) => `${c.host && c.host !== 'fresh' ? `host ${c.host}${c.second === 'list' ? ' (a list slide stood there)' : ''}, ` : ''}${c.shape}, ${c.link === DOI ? 'a DOI' : 'a web link'}, ${c.place}, ${c.ids ? 'slides with ids' : 'no slide with an id'}${c.saves?.length ? `, saved at: ${c.saves.join(' + ')}` : ', no save'}${c.paste ? ', pasted' : `, left by ${c.leave ?? 'ArrowUp'}`}${c.then ? ', then the next heading typed' : ''}`
  /**
   * A `- Author <link>` source line left by Enter: the app's Enter continues the list, so the text the Enter leaves has
   * an empty second item, which the compiler reads as a list slide, form or no form. Nothing is written at that Enter
   * (the write is decided on the text it would go to). The second Enter takes the empty item out and the form is
   * written at it (one line of grace). Then the line is left by ArrowUp or, `then: 'heading'`, the next slide's heading
   * is typed on it and left by Enter.
   */
  const sourceLineLeftByEnter = async (c) => {
    const { typed, written, compiledText } = await typeSlide(c)
    const lines = typed.split('\n')
    const linkLine = lines.findIndex((line) => line === SHAPES[c.shape](c.link).join(''))
    assert(linkLine >= 0, 'the source line is in the text')
    const afterEnter = [...lines.slice(0, linkLine + 1), '- ', ...lines.slice(linkLine + 1)].join('\n')
    assert.equal(written, afterEnter, 'Enter continues the list under the source line, and no form is written')
    // That text is a list slide for the compiler, and would be with the form on it.
    const saved = stampMissingIds(afterEnter).text
    const id = typedSlide(saved).id
    assert.equal((await compile(saved)).slides.find((slide) => slide.id === id)?.layout, 'list', 'the full compiler reads the slide the Enter leaves as a list')
    const formed = saved.replace(`{id=${id}}`, `{id=${id} form=${c.link === DOI ? 'paper' : 'web'}}`)
    assert.notEqual(formed, saved, 'the form is put on the saved text for the comparison')
    assert.notEqual(drawnForm(await compile(formed), id, c.link === DOI ? 'paper' : 'web', { link: c.link }), '', 'and would draw no form for it had one been written')
    // Enter again takes the empty item out: the slide is a quotation with its source again, and the form is written at
    // this second Enter (asked with the "before" kept from the source line), the caret still on the emptied line.
    await enter(); await settle()
    const form = c.link === DOI ? 'paper' : 'web'
    const emptied = [...lines.slice(0, linkLine + 1), '', ...lines.slice(linkLine + 1)].join('\n')
    const atSecondEnter = await text()
    assertOnlyTheForm(emptied, atSecondEnter, form)
    await assertDrawn(atSecondEnter, form, c.link, compiledText, c.host)
    // Then the line is left, or the next slide's heading is typed on it and left by Enter: nothing more is written.
    if (c.then === 'heading') { await type('### Next'); await enter() } else await page.keyboard.press('ArrowUp')
    await settle()
    const now = await text()
    if (c.then === 'heading') {
      const typedLines = atSecondEnter.split('\n')
      const sourceAt = typedLines.indexOf(lines[linkLine])
      const above = [...typedLines.slice(0, sourceAt + 1), '### Next'].join('\n')
      assert(now.startsWith(`${above}\n`), 'the heading is under the source line, the form above as it was written')
      assert.equal(now.slice(above.length).replace(/^\n+/, ''), typedLines.slice(sourceAt + 2).join('\n').replace(/^\n+/, ''), 'and the text after it is as it was')
      assert.equal(now.match(/form=/g)?.length, 1, 'the form is there once')
      await assertDrawn(now, form, c.link, compiledText, c.host)
    } else {
      assert.equal(now, atSecondEnter, 'the line left: nothing more is written')
    }
    await click(1)
    await run(() => window.blurEditor()); await settle()
    assert.equal(await text(), now, 'left again: nothing more is written')
  }
  const writes = async (letter, c) => check(`${letter}. ${describe(c)}`, async () => {
    if (c.leave === 'Enter' && c.shape === 'a source line') return sourceLineLeftByEnter(c)
    const form = c.link === DOI ? 'paper' : 'web'
    const { typed, written, compiledText } = await typeSlide(c)
    // Leaving by Enter adds the Enter's own text after the link's line; the form is compared on the text before it.
    if (c.leave === 'Enter') {
      assert.equal(typedSlide(written).form, form, `the typed slide carries form=${form}: ${JSON.stringify(written.slice(-160))}`)
      const lines = written.split('\n')
      const tokenLine = typedSlide(written).heading + 1
      assert(lines[tokenLine].includes(`form=${form}`), 'the form is on the line under the heading (the layout line)')
      assert(written.includes(`\n${SHAPES[c.shape](c.link).join('')}\n`), 'the link\'s line is as typed')
    } else {
      assertOnlyTheForm(typed, written, form)
    }
    await assertDrawn(written, form, c.link, compiledText, c.host)
    // What the host answered for the typed heading: nothing, or (stale) what stood on that line before.
    const headingLine = typedSlide(compiledText).heading + 1
    const answers = (await run(() => window.asked)).filter(([line]) => line === headingLine).map(([, layout]) => layout ?? null)
    if (c.host === 'none') assert(answers.length > 0 && answers.every((layout) => layout === null), `the host had no layout for the typed slide (line ${headingLine}, asked ${JSON.stringify(await run(() => window.asked))})`)
    if (c.expectStale) assert(answers.includes(c.expectStale), `the stale host answered ${c.expectStale} for the typed heading's line (it answered ${JSON.stringify(answers)})`)
  })

  const shapes = Object.keys(SHAPES)
  const places = Object.keys(PLACES)
  // A. One run, no save.
  for (const shape of shapes) for (const link of [WEB, DOI]) for (const place of places) for (const ids of [true, false]) await writes('A', { ids, place, shape, link })
  for (const shape of shapes) for (const leave of ['a click elsewhere', 'leaving the editor']) await writes('A', { ids: false, place: places[0], shape, link: WEB, leave })
  await writes('A', { ids: false, place: places[0], shape: 'a source line', link: WEB, leave: 'Enter' })
  await writes('A', { ids: true, place: places[1], shape: 'a source line', link: DOI, leave: 'Enter' })
  for (const link of [WEB, DOI]) for (const place of places) for (const ids of [true, false]) await writes('A', { ids, place, shape: 'a bare address', link, leave: 'Enter' })
  // A source line left by Enter: with a DOI and a web link, everywhere; and with the next slide's heading typed after it.
  for (const link of [WEB, DOI]) for (const place of places) for (const ids of [true, false]) await writes('A', { ids, place, shape: 'a source line', link, leave: 'Enter', then: (link === WEB) === ids ? 'heading' : undefined })
  // B. The save comes before the link's line is begun.
  for (const shape of shapes) for (const point of ['under-heading', 'quotation', 'empty-line']) for (const place of places) for (const ids of [true, false]) {
    await writes('B', { ids, place, shape, link: place === places[1] ? DOI : WEB, saves: [point] })
  }
  for (const shape of shapes) await writes('B', { ids: false, place: places[0], shape, link: WEB, saves: ['heading'] })
  for (const shape of shapes) await writes('B', { ids: false, place: places[2], shape, link: DOI, saves: ['heading', 'quotation'] })
  for (const point of ['under-heading', 'quotation', 'empty-line']) for (const ids of [true, false]) await writes('B', { ids, place: places[ids ? 1 : 0], shape: 'a source line', link: ids ? DOI : WEB, saves: [point], leave: 'Enter', then: point === 'quotation' ? 'heading' : undefined })
  // C. The save comes while the link's line is being typed.
  for (const shape of shapes) for (const link of [WEB, DOI]) for (const place of places) for (const ids of [true, false]) await writes('C', { ids, place, shape, link, saves: ['mid-link'] })
  for (const shape of shapes) for (const leave of ['a click elsewhere', 'leaving the editor']) await writes('C', { ids: false, place: places[1], shape, link: WEB, saves: ['mid-link'], leave })
  await writes('C', { ids: false, place: places[0], shape: 'a source line', link: WEB, saves: ['mid-link'], leave: 'Enter' })
  for (const place of places) await writes('C', { ids: false, place, shape: 'a bare address', link: WEB, saves: ['mid-link'], leave: 'Enter' })
  // E. The address pasted on the new empty line.
  for (const shape of shapes) for (const link of [WEB, DOI]) for (const saves of [[], ['quotation'], ['empty-line']]) for (const ids of [true, false]) {
    await writes('E', { ids, place: places[ids ? 1 : 0], shape, link, saves, paste: true })
  }

  // F. The host's compile has not seen the slide.
  for (const host of ['none', 'stale']) {
    for (const shape of shapes) for (const link of [WEB, DOI]) for (const place of places) for (const ids of [true, false]) await writes('F', { host, ids, place, shape, link })
    for (const shape of shapes) for (const point of ['quotation', 'empty-line', 'mid-link']) for (const ids of [true, false]) await writes('F', { host, ids, place: places[ids ? 1 : 0], shape, link: point === 'quotation' ? DOI : WEB, saves: [point] })
    for (const shape of shapes) for (const leave of ['a click elsewhere', 'leaving the editor']) await writes('F', { host, ids: false, place: places[0], shape, link: WEB, leave })
    await writes('F', { host, ids: true, place: places[1], shape: 'a source line', link: WEB, leave: 'Enter' })
    for (const ids of [true, false]) await writes('F', { host, ids, place: places[ids ? 1 : 0], shape: 'a bare address', link: ids ? WEB : DOI, leave: 'Enter' })
    for (const ids of [true, false]) await writes('F', { host, ids, place: places[ids ? 0 : 2], shape: 'a source line', link: ids ? DOI : WEB, leave: 'Enter', then: ids ? undefined : 'heading' })
    for (const shape of shapes) for (const link of [WEB, DOI]) for (const ids of [true, false]) await writes('F', { host, ids, place: places[ids ? 1 : 0], shape, link, paste: true })
  }
  // The stale host's answer for the typed heading is another slide's: in the middle of a talk with ids the heading is
  // typed on the line the next slide's heading stood on (a quotation with an address: copy-visual; a list slide: list).
  for (const shape of shapes) for (const link of [WEB, DOI]) {
    await writes('F', { host: 'stale', ids: true, place: places[1], shape, link, expectStale: 'copy-visual' })
    await writes('F', { host: 'stale', ids: true, place: places[1], shape, link, second: 'list', expectStale: 'list' })
    await writes('F', { host: 'stale', ids: true, place: places[1], shape, link, second: 'list', saves: ['mid-link'] })
  }

  // ── Nothing is written ──
  const unformed = async (what) => assert.equal(/form=/.test(await text()), false, `${what}: no form is written`)
  const twoAlike = (ids) => ['# Talk', '', '## Part one', ...(ids ? ['{id=p1}'] : []), '', '### Same title', '', '> First words.', '', '### Same title', '', '> Second words.', '', WEB, ''].join('\n')
  // A typed slide that is no quote slide, or a quotation with other content: whatever the host knows of it.
  const NOT_QUOTES = {
    'a list with a link': async () => { await enter(); await type('- one point'); await enter(); await type(`another point ${WEB}`) },
    'a slide with {cards}': async () => { await type('{cards}'); await enter(); await enter(); await type(QUOTATION); await enter(); await enter(); await type(WEB) },
    'a quotation, a paragraph and an address': async () => { await enter(); await type(QUOTATION); await enter(); await enter(); await type('Words that are no quotation.'); await enter(); await enter(); await type(WEB) },
    'a quotation, a list and a source line': async () => { await enter(); await type(QUOTATION); await enter(); await enter(); await type('- one point'); await enter(); await type('another point'); await enter(); await type(`Jane Author ${WEB}`) }
  }
  for (const [what, keys] of Object.entries(NOT_QUOTES)) await check(`N0. a typed slide that is ${what}`, async () => {
    for (const host of ['fresh', 'none', 'stale']) for (const place of [places[0], places[1]]) {
      await run(([doc, mode]) => window.mount(doc, mode), [talk(true), host])
      await PLACES[place]()
      await type(`### ${TITLE}`); await enter()
      await keys()
      await settle()
      const typed = await text()
      assert(typed.includes(WEB) && typed.includes(`### ${TITLE}`), 'the slide and its link were typed')
      await run(() => window.compiled())
      await page.keyboard.press('ArrowUp'); await settle()
      await click(1)
      await run(() => window.blurEditor()); await settle()
      assert.equal(await text(), typed, `host ${host}, ${place}: nothing is written`)
    }
  })
  await check('N1. the slide above a same-titled slide with no id is deleted', async () => {
    for (const userEvent of ['delete.selection', 'delete.cut']) for (const ids of [true, false]) {
      await run((doc) => window.mount(doc), twoAlike(ids))
      const first = lineNumber(await text(), '### Same title')
      await click(first)
      await run(([a, b, event]) => window.removeLines(a, b, event), [first, first + 3, userEvent])
      await settle()
      await run(() => window.compiled())
      await click(1)
      await unformed(`${userEvent}, then the caret moved`)
      await run(() => window.blurEditor()); await settle()
      await unformed(`${userEvent}, then the editor left`)
      assert.equal((await text()).match(/### Same title/g)?.length, 1, 'one of the two slides is left')
    }
  })
  await check('N2. a whole slide with its address pasted in one paste', async () => {
    const slide = `### Brought in\n\n${QUOTATION}\n\n${WEB}\n`
    for (const ids of [true, false]) for (const where of ['end', 'middle']) {
      await run((doc) => window.mount(doc), talk(ids))
      if (where === 'end') { await click((await text()).split('\n').length); await enter() }
      else { await click(lineNumber(await text(), 'A paragraph of the first slide.')); await enter(); await enter() }
      await run((pasted) => window.pasteText(pasted), slide)
      await settle()
      await unformed('the paste')
      await run(() => window.compiled())
      await page.keyboard.press('ArrowUp'); await settle()
      await click(1)
      await run(() => window.blurEditor()); await settle()
      await unformed('the paste, the caret moved and the editor left')
      assert((await text()).includes(slide), 'the pasted slide is in the text')
    }
  })
  await check('N3. a slide is cut and pasted elsewhere', async () => {
    for (const ids of [true, false]) {
      const start = talk(ids)
      await run((doc) => window.mount(doc), start)
      const first = lineNumber(start, '### Second')
      const cut = await run(([a, b]) => window.removeLines(a, b, 'delete.cut'), [first, start.split('\n').length])
      await settle()
      await click(lineNumber(await text(), '### First'))
      await run(([pasted, line]) => { window.clickLine(line - 1); window.pasteText(pasted.replace(/^\n/, '') + '\n') }, [cut, lineNumber(await text(), '### First')])
      await settle()
      await run(() => window.compiled())
      await click(1)
      await run(() => window.blurEditor()); await settle()
      await unformed('cut and pasted above another slide')
      const now = await text()
      assert(now.indexOf('### Second') < now.indexOf('### First') && now.includes(OTHER), 'the slide was moved, address and all')
    }
  })
  await check('N4. another slide is typed on', async () => {
    for (const ids of [true, false]) {
      await run((doc) => window.mount(doc), talk(ids))
      await click(lineNumber(await text(), 'A paragraph of the first slide.'))
      await type(' More words.')
      await enter(); await enter()
      await type('Another paragraph.')
      if (!ids) await save()
      await run(() => window.compiled())
      await page.keyboard.press('ArrowUp'); await settle()
      await click(1)
      await unformed('typing on the first slide')
      // The quotation of the slide that has the address: its words are edited, its link is not.
      await click(lineNumber(await text(), '> Words that were there.'))
      await type(' And more.')
      await run(() => window.compiled())
      await page.keyboard.press('ArrowUp'); await settle()
      await run(() => window.blurEditor()); await settle()
      await unformed('typing in the quotation of a slide that already has its address')
    }
  })
  await check('N5. the typed address is undone', async () => {
    await run((doc) => window.mount(doc), talk(true))
    await click((await text()).split('\n').length)
    await enter()
    await type(`### ${TITLE}`); await enter(); await enter()
    await type(QUOTATION)
    // Longer than the history's grouping delay: the undo below takes back the address and the Enters before it and no
    // more, so the caret goes back to the quotation's line with the heading and the quotation still there.
    await page.waitForTimeout(700)
    await enter(); await enter()
    await type(WEB)
    await settle()
    await run(() => window.compiled())
    await run(() => window.doUndo())
    await settle()
    const undone = await text()
    assert(undone.includes(`### ${TITLE}`) && undone.includes(QUOTATION) && !undone.includes(WEB), 'one undo takes the address back and leaves the heading and the quotation')
    await unformed('the address undone')
    await click(1)
    await run(() => window.blurEditor()); await settle()
    await unformed('the address undone, then the caret moved')
    assert.equal((await text()).includes(WEB), false, 'the address is gone')
  })
  await check('N6. undoing a written form: it never stands without its link', async () => {
    // Cmd-Z, step by step, until nothing is left to undo: at which step the form goes, and at which the link.
    const gone = {}
    for (const [shape, leave] of [['a source line', 'ArrowUp'], ['a bare address', 'ArrowUp'], ['a bare address', 'Enter'], ['a source line', 'Enter']]) {
      let { written } = await typeSlide({ ids: true, place: places[0], shape, link: WEB, leave })
      // A source line left by Enter: the second Enter takes the empty item out, and the form is written at it.
      if (shape === 'a source line' && leave === 'Enter') { await enter(); await settle(); written = await text() }
      assert(/form=web/.test(written), 'the form was written')
      let steps = 0
      let form = 0
      let link = 0
      while (await run(() => window.undoDepth()) > 0) {
        await page.keyboard.press('ControlOrMeta+z'); await settle()
        steps += 1
        const now = await text()
        assert(!(now.includes('form=web') && !now.includes(WEB)), `${shape}, left by ${leave}, undo step ${steps}: the form never stands without its link`)
        if (!form && !now.includes('form=web')) form = steps
        if (!link && !now.includes(WEB)) link = steps
      }
      assert(form > 0 && link > 0, 'the form and the link were both undone')
      await unformed(`${shape}, left by ${leave}, everything undone`)
      // How many more steps the link takes than the form (the slide is typed in one run, so the steps before are its own).
      gone[`${shape}, ${leave}`] = link - form
    }
    // Left with no change, the form is in the undo step of the link's typing: both go in one step. A bare address left
    // by Enter: the form is in the Enter's step; that step takes the Enter and the form, the next one the link. A source
    // line left by Enter, Enter: the app's list Enter joins the step of the typing, so one step takes the link, both
    // Enters and the form.
    assert.deepEqual(gone, { 'a source line, ArrowUp': 0, 'a bare address, ArrowUp': 0, 'a bare address, Enter': 1, 'a source line, Enter': 0 })
  })
  await check('N7. the save\'s id lands against the typing itself: no form for that line, none guessed', async () => {
    // A heading typed above a quotation and its address that were already there, then saved while the caret is still on
    // it: the id goes in at the end of what was typed. The slide's link was never typed, so nothing may be written.
    await run((doc) => window.mount(doc), talk(true).replace('### Second\n{id=s2}\n\n', ''))
    await click(lineNumber(await text(), '> Words that were there.') - 1)
    await type(`### ${TITLE}`)
    assert.equal(await save(), true, 'the save stamps the typed heading')
    await run(() => window.compiled())
    await page.keyboard.press('ArrowUp'); await settle()
    await click(1)
    await run(() => window.blurEditor()); await settle()
    await unformed('a heading typed above a quotation with its address, saved, the caret moved')
  })

  // Q. Two Enters leave the quotation (leaveQuotation): the text is the quotation, one blank line, the address.
  const typedTwoEnters = async (tail, leave) => {
    await run((doc) => window.mount(doc), talk(true))
    await click((await text()).split('\n').length)
    await enter()
    await type(`### ${TITLE}`); await enter(); await enter()
    await type(QUOTATION)
    await enter(); await enter()
    await type(tail)
    await run(() => window.compiled())
    return leave
  }
  const quotationStays = (now) => assert(now.includes(`\n${QUOTATION}\n\n`), `the quotation, one blank line, then the next line: ${JSON.stringify(now.slice(-160))}`)
  for (const [name, tail, leave] of [
    ['a bare address, ArrowUp', WEB, 'ArrowUp'],
    ['a bare address, Enter', WEB, 'Enter'],
    ['a source line, Enter, Enter', `- Jane Author ${WEB}`, 'Enter Enter']
  ]) {
    await check(`Q1. two Enters after the quotation, ${name}: the form is written and drawn`, async () => {
      await typedTwoEnters(tail, leave)
      const before = await text()
      assert(before.endsWith(`${QUOTATION}\n\n${tail}`), `exactly one blank line between the quotation and the address: ${JSON.stringify(before.slice(-160))}`)
      if (leave === 'ArrowUp') await page.keyboard.press('ArrowUp')
      else { await enter(); if (leave === 'Enter Enter') await enter() }
      await settle()
      const written = await text()
      quotationStays(written)
      assert.equal(typedSlide(written).form, 'web', `form=web is written: ${JSON.stringify(written.slice(-200))}`)
      await assertDrawn(written, 'web', WEB, before)
      // Cmd-Z, step by step: the form never stands without its link.
      while (await run(() => window.undoDepth()) > 0) {
        await page.keyboard.press('ControlOrMeta+z'); await settle()
        const now = await text()
        assert(!(now.includes('form=web') && !now.includes(WEB)), 'undo: the form never stands without its link')
      }
    })
  }
  // Q2. Shift-Enter makes a second paragraph of the quotation; the form is written and the compiler draws it with both
  // paragraphs as the quotation words (or this case reports what the compiler reads).
  await check('Q2. Shift-Enter, a second paragraph, Enter, Enter, an address: the form is written and drawn with both paragraphs', async () => {
    await run((doc) => window.mount(doc), talk(true))
    await click((await text()).split('\n').length)
    await enter()
    await type(`### ${TITLE}`); await enter(); await enter()
    await type(QUOTATION)
    await page.keyboard.press('Shift+Enter')
    await type('A second paragraph of the words.')
    await enter(); await enter()
    await type(WEB)
    await run(() => window.compiled())
    const before = await text()
    assert(before.endsWith(`${QUOTATION}\n>\n> A second paragraph of the words.\n\n${WEB}`), `both paragraphs, one blank line, the address: ${JSON.stringify(before.slice(-200))}`)
    await page.keyboard.press('ArrowUp'); await settle()
    const written = await text()
    assert.equal(typedSlide(written).form, 'web', `form=web is written: ${JSON.stringify(written.slice(-220))}`)
    const saved = stampMissingIds(written).text
    const id = typedSlide(saved).id
    // The words the compiler reads for the slide without the form: both paragraphs, as one quotation.
    const plainText = saved.replace(/ form=web\b/, '')
    const plain = await compile(plainText)
    const words = compiledWords(plain.slides.find((slide) => slide.id === id))
    assert.equal(words.length, 2, `the compiler reads the two paragraphs as one quotation of two paragraphs: ${JSON.stringify(words)}`)
    assert(/Schemas are the building blocks/.test(words[0]) && /A second paragraph/.test(words[1]), `with the words of both: ${JSON.stringify(words)}`)
    assert.equal(drawnForm(await compile(saved), id, 'web', { wordsBefore: words, link: WEB }), '', 'the full compiler draws the web form with both paragraphs as the quotation words')
  })

  const timings = await writeCases({ page, run, check, text, type, enter, click, settle, save, compile })

  if (REPORT) {
    console.log(`${ran} cases run, ${failures.length} failed`)
    for (const failure of failures) console.log(`FAIL ${failure}`)
  } else {
    console.log(`quote form typed slide editor ok: ${ran} cases; a quote slide typed top to bottom takes its form (one run, a save before or during the link's line, pasted), every form is decided on the text it is written to, and nothing else is written`)
    for (const timing of timings) console.log(timing)
  }
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
