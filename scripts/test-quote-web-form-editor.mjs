// test:quote-web-form-editor — quote forms ticket 07 and the 2026-10-12 paper check: the web and paper forms are set by an edit in the app (spec 3.1).
//
// The real quoteLinkFormExtension (with CodeMirror's history, the token guards and the markdown language, as
// components/Editor.tsx mounts them) is bundled for chrome-headless-shell (never the real Chrome) over a fixture outline:
//   - typing an ordinary web link into a quote slide's source line, then leaving the line: `form=web` joins the layout line;
//     one undo restores the outline as it was before the typing, one redo brings both back
//   - pasting a web link into the source line: `form=web` is in the paste's own transaction; one undo restores the outline
//   - leaving the editor (blur) after typing does the same
//   - the same for a DOI: `form=paper` is written by typing, paste and blur, in one undo step
//   - nothing is set: for an X or YouTube link, or (for Web) a DOI; for `form=plain`; for a book reference; for a link that was already there
//     when only the words were edited; on opening (no edit); for a slide that is not a quote
//   - a link typed on one slide does not touch another
//   - a quote-only slide with no `{quote}` token is set when the compiler's layout for it is quote
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const SHELL = join(homedir(), '.cache/puppeteer/chrome-headless-shell/mac_arm-146.0.7680.66/chrome-headless-shell-mac-arm64/chrome-headless-shell')
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-quote-web-form-editor-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { history, undo, redo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { quoteLinkFormExtension } from './src/renderer/src/extensions/quoteLinkForm.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
window.mount = (doc, layouts) => {
  document.getElementById('host').innerHTML = ''
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(0),
    extensions: [markdown({ base: markdownLanguage }), history(), tokenProtectExtension(), quoteLinkFormExtension(() => (line) => layouts?.[line])]
  })
  window.__view = new EditorView({ parent: document.getElementById('host'), state })
}
window.docText = () => window.__view.state.doc.toString()
// Put the caret at the end of a line (1-based), as a click would: a user selection event.
window.caretToEnd = (lineNumber) => {
  const v = window.__view
  v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(lineNumber).to), userEvent: 'select.pointer' })
}
// Type a string at the caret the way the keyboard does (each character one input.type transaction).
window.typeText = (text) => {
  const v = window.__view
  for (const ch of text) {
    const head = v.state.selection.main.head
    v.dispatch({ changes: { from: head, insert: ch }, selection: EditorSelection.cursor(head + 1), userEvent: 'input.type' })
  }
}
window.pasteText = (text) => {
  const v = window.__view
  const { from, to } = v.state.selection.main
  v.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length), userEvent: 'input.paste' })
}
window.doUndo = () => undo(window.__view)
window.doRedo = () => redo(window.__view)
window.blurEditor = () => { window.__view.contentDOM.dispatchEvent(new FocusEvent('blur')) }
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const WEB = 'https://www.samplesite.example/posts/a-sample-post'
const slide = (trigger, body) => `# T\n\n## S\n\n### Quote {id=q1}\n${trigger}\n\n${body}\n\n### Other {id=q2}\n{quote}\n\n> Other words.\n\n- Other Name ${WEB}\n`
const SOURCE_LINE = 10  // the source line of the first slide in `slide()`

const browser = await chromium.launch({ executablePath: SHELL, headless: true })
try {
  const page = await browser.newPage()
  await page.setContent('<div id="host"></div>')
  await page.addScriptTag({ path: outfile })
  const run = (fn, ...args) => page.evaluate(fn, ...args)
  const settle = () => run(() => new Promise((resolve) => setTimeout(resolve, 20)))
  const mount = (doc, layouts) => run(([d, l]) => window.mount(d, l), [doc, layouts])
  const text = () => run(() => window.docText())

  // 1. Typing a link, then leaving the line: one undo step takes the link and the token back together.
  {
    const first = slide('{quote}', '> Words.\n\n- Sample Author ')
    await mount(first)
    await run((line) => window.caretToEnd(line), SOURCE_LINE)
    await run((link) => window.typeText(link), WEB)
    await settle()
    assert.equal((await text()).includes('{form=web}'), false, 'while the caret is on the line nothing is set')
    await run(() => window.caretToEnd(1))
    await settle()
    const typed = await text()
    assert(typed.includes('### Quote {id=q1}\n{quote}{form=web}\n') && typed.includes(`- Sample Author ${WEB}\n`), 'leaving the line sets form=web')
    assert(typed.includes('### Other {id=q2}\n{quote}\n'), 'the other slide is untouched')
    await run(() => window.doUndo())
    assert.equal(await text(), first, 'one undo restores the outline as it was before the typing: the link and the token go together')
    await run(() => window.doRedo())
    assert.equal(await text(), typed, 'one redo brings both back')
  }
  // 2. Pasting a link: the token is in the paste's own transaction.
  {
    const first = slide('{quote}', '> Words.\n\n- Sample Author ')
    await mount(first)
    await run((line) => window.caretToEnd(line), SOURCE_LINE)
    await run((link) => window.pasteText(link), WEB)
    await settle()
    const pasted = await text()
    assert(pasted.includes('{quote}{form=web}') && pasted.includes(`- Sample Author ${WEB}\n`), 'a pasted link sets form=web at once')
    await run(() => window.doUndo())
    assert.equal(await text(), first, 'one undo restores the outline as it was before the paste')
  }
  // 3. Blur settles a typed link.
  {
    const first = slide('{quote}', '> Words.\n\n- Sample Author ')
    await mount(first)
    await run((line) => window.caretToEnd(line), SOURCE_LINE)
    await run((link) => window.typeText(link), WEB)
    await run(() => window.blurEditor())
    await settle()
    assert((await text()).includes('{quote}{form=web}'), 'leaving the editor settles the typed link')
    await run(() => window.doUndo())
    assert.equal(await text(), first, 'and one undo takes both back')
  }
  // 4. Nothing is set when the rule does not hold.
  const typedNothing = async (trigger, body, add) => {
    const first = slide(trigger, body)
    await mount(first)
    await run((line) => window.caretToEnd(line), SOURCE_LINE)
    await run((link) => window.typeText(link), add)
    await run(() => window.caretToEnd(1))
    await settle()
    return { first, now: await text() }
  }
  for (const [what, trigger, body, add] of [
    ['an X link', '{quote}', '> Words.\n\n- Name ', 'https://x.com/techczech/status/1234567890123456789'],
    ['a YouTube link', '{quote}', '> Words.\n\n- Name ', 'https://youtu.be/XXXXXXXXXXX'],
    ['form=plain', '{quote}{form=plain}', '> Words.\n\n- Name ', WEB],
    ['form=tweet', '{quote}{form=tweet}', '> Words.\n\n- Name ', WEB],
    ['a book reference', '{quote}', '> Words.\n\n- A One, *Title*, Press, 1980, p. 5 ', WEB]
  ]) {
    const { now } = await typedNothing(trigger, body, add)
    assert.equal(now.includes('form=web'), false, `${what}: no form=web`)
  }
  // A DOI is a paper, never a web page; the author's own choice is never overridden.
  const DOI = 'https://doi.org/10.1000/xyz'
  {
    const { now } = await typedNothing('{quote}', '> Words.\n\n- Name ', DOI)
    assert(now.includes('{quote}{form=paper}') && !now.includes('form=web'), 'typing a DOI sets form=paper, not form=web')
  }
  for (const [what, trigger, body, add] of [
    ['form=plain', '{quote}{form=plain}', '> Words.\n\n- Name ', DOI],
    ['form=web', '{quote}{form=web}', '> Words.\n\n- Name ', DOI],
    ['form=tweet', '{quote}{form=tweet}', '> Words.\n\n- Name ', DOI],
    ['a book reference', '{quote}', '> Words.\n\n- A One, *Title*, Press, 1980, p. 5 ', DOI]
  ]) {
    const { now } = await typedNothing(trigger, body, add)
    assert.equal(/form=paper/.test(now.replace(trigger, '')), false, `${what}: no form=paper`)
  }
  // A DOI typed as doi: and pasted; one undo takes the DOI and the token back together.
  {
    const first = slide('{quote}', '> Words.\n\n- Sample Author ')
    await mount(first)
    await run((line) => window.caretToEnd(line), SOURCE_LINE)
    await run((link) => window.typeText(link), 'doi:10.1000/xyz')
    await run(() => window.caretToEnd(1))
    await settle()
    const typed = await text()
    assert(typed.includes('### Quote {id=q1}\n{quote}{form=paper}\n') && typed.includes('- Sample Author doi:10.1000/xyz\n'), 'a typed doi: reference sets form=paper when the line is left')
    await run(() => window.doUndo())
    assert.equal(await text(), first, 'one undo restores the outline as it was before the typing: the DOI and the token go together')
    await mount(first)
    await run((line) => window.caretToEnd(line), SOURCE_LINE)
    await run((link) => window.pasteText(link), DOI)
    await settle()
    const pasted = await text()
    assert(pasted.includes('{quote}{form=paper}') && pasted.includes(`- Sample Author ${DOI}\n`), 'a pasted DOI sets form=paper at once')
    await run(() => window.doUndo())
    assert.equal(await text(), first, 'one undo restores the outline as it was before the paste')
    await mount(first)
    await run((line) => window.caretToEnd(line), SOURCE_LINE)
    await run((link) => window.typeText(link), '10.1000/xyz')
    await run(() => window.blurEditor())
    await settle()
    assert((await text()).includes('{quote}{form=paper}'), 'leaving the editor settles a typed DOI')
  }
  // Editing the words of a slide that already has a link sets nothing.
  {
    const first = slide('{quote}', `> Words.\n\n- Sample Author ${WEB}`)
    await mount(first)
    await run(() => window.caretToEnd(8))
    await run(() => window.typeText(' More words.'))
    await run(() => window.caretToEnd(1))
    await settle()
    assert.equal((await text()).includes('form=web'), false, 'editing the words of a slide that already has a link sets nothing')
  }
  // Opening a talk sets nothing (no edit, no trigger).
  {
    await mount(slide('{quote}', `> Words.\n\n- Sample Author ${WEB}`))
    await run(() => window.caretToEnd(1))
    await run(() => window.blurEditor())
    await settle()
    assert.equal((await text()).includes('form=web'), false, 'opening and moving around sets nothing')
  }
  // A quote-only slide with no {quote} token: set when the compiler's layout for it is quote.
  {
    // A quotation and its source line: the shape the compiler infers as a quote slide. (A slide that is only `- link`
    // with no {quote} token compiles as a list slide, so the rule's check by compiling writes nothing there.)
    const bare = (link) => `# T\n\n## S\n\n### A quotation {id=q1}\n\n> Words.\n\n${link}\n`
    // Ticket 11: the host's layout is its last compile's answer for that line. When it does not make the slide a quote
    // slide (none yet, or the layout of a slide that stood on that line before), the compiler's own reading decides.
    for (const layout of ['quote', 'list', undefined]) {
      await mount(bare('- Sample Author '), { 5: layout })
      await run(() => window.caretToEnd(9))
      await run((link) => window.typeText(link), WEB)
      await run(() => window.caretToEnd(1))
      await settle()
      assert.equal((await text()).includes('form=web'), true, `a quote-only slide, the host's layout for its line ${layout}: set`)
      // A slide the compiler reads as a list is left alone whatever the host says.
      await mount(`# T\n\n## S\n\n### Points {id=q1}\n\n- one point\n\n- another point \n`, { 5: layout })
      await run(() => window.caretToEnd(9))
      await run((link) => window.typeText(link), WEB)
      await run(() => window.caretToEnd(1))
      await settle()
      assert.equal((await text()).includes('form='), false, `a list slide, the host's layout for its line ${layout}: left alone`)
    }
  }
  console.log('quote web form editor ok: typing, paste and blur set form=web (a DOI: form=paper) in one undo step; nothing else is set')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
