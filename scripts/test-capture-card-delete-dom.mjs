// A saved view's card in the editor (extensions/imageWidget.ts) deletes as a whole line. The owner's
// alpha.16 talk showed what happened before: Backspace beside a card removed the hidden `}` of
// `{capture}` (then `ure}`), the card stayed because any image line draws one, and the slide had
// quietly lost the view (inspector and presenter 2, editor 4 cards). Real CodeMirror and the real
// image extension, bundled for headless Chromium; nothing on screen. One Undo restores the line.
// TW_HEADLESS_SHELL=<path> uses that headless shell when the pinned one is missing.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-capture-card-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { history, historyKeymap, defaultKeymap, deleteCharBackward, deleteCharForward, undo } from '@codemirror/commands'
import { imageWidgetExtension, captureAtomicRanges, imageAtomicRanges } from './src/renderer/src/extensions/imageWidget.ts'
window.mountEditor = (doc) => {
  window.__view?.destroy()
  window.__view = new EditorView({
    parent: document.getElementById('host'),
    state: EditorState.create({ doc, extensions: [history(), keymap.of([...defaultKeymap, ...historyKeymap]), imageWidgetExtension({ vaultRoot: null, talkDir: null }), EditorView.lineWrapping] })
  })
}
window.caretAt = (pos) => { window.__view.dispatch({ selection: { anchor: pos } }); window.__view.focus() }
window.run = (name) => ({ deleteCharBackward, deleteCharForward, undo })[name](window.__view)
window.doc = () => window.__view.state.doc.toString()
window.atomic = () => captureAtomicRanges(window.__view)
window.imageAtomic = () => imageAtomicRanges(window.__view)
window.cards = () => document.querySelectorAll('.cm-content img, .cm-content .cm-image-widget, .cm-content [class*="image"]').length
`
const SITE = 'https://example.com/page'
const A = '![Saved view, 27 Oct 2026 22:22](assets/live-page-captures/aaaaaaaaaaaaaaaa.jpg){capture}'
const B = '![Saved view, 27 Oct 2026 22:23](assets/live-page-captures/bbbbbbbbbbbbbbbb.jpg){capture}'
const PLAIN = '![photo](assets/photo.jpg)'
const DOC = `### Page {id=p}\n[Embed: ${SITE}]\n<!-- saved views {capture} -->\n${A}\n${B}\n\n${PLAIN}\nafter\n`
let passed = 0
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { console.error(`  FAIL ${name}`); throw e } }
let browser
try {
  await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const page = await browser.newPage()
  await page.setContent('<!doctype html><div id="host" style="width:600px"></div>')
  await page.addScriptTag({ content: readFileSync(outfile, 'utf8') })
  console.log('capture card delete (editor, headless)')
  const at = (needle, end) => DOC.indexOf(needle) + (end ? needle.length : 0)

  await test('Backspace after a saved-view card removes the whole line (never `{captu`); one Undo restores it', async () => {
    await page.evaluate((d) => window.mountEditor(d), DOC)
    assert.deepEqual(await page.evaluate(() => window.atomic().length), 2, 'both saved-view lines are atomic')
    await page.evaluate((p) => window.caretAt(p), at(B, true))
    await page.evaluate(() => window.run('deleteCharBackward'))
    const after = await page.evaluate(() => window.doc())
    assert.equal(after, DOC.replace(B, ''), 'the line text gone whole')
    assert.doesNotMatch(after, /\{captu(?!re\})|\{cap\n/, 'no broken token left behind')
    await page.evaluate(() => window.run('undo'))
    assert.equal(await page.evaluate(() => window.doc()), DOC, 'one Undo')
  })

  await test('Delete before a saved-view card removes it whole; an ordinary picture is one object too (ADR-0042)', async () => {
    await page.evaluate((d) => window.mountEditor(d), DOC)
    await page.evaluate((p) => window.caretAt(p), at(A))
    await page.evaluate(() => window.run('deleteCharForward'))
    assert.equal(await page.evaluate(() => window.doc()), DOC.replace(A, ''))
    // ADR-0042: an ordinary picture card is atomic as well: Backspace at its end removes the whole line
    // text, never its hidden `)`; one Undo restores it.
    await page.evaluate((d) => window.mountEditor(d), DOC)
    await page.evaluate((p) => window.caretAt(p), at(PLAIN, true))
    await page.evaluate(() => window.run('deleteCharBackward'))
    assert.equal(await page.evaluate(() => window.doc()), DOC.replace(PLAIN, ''))
    await page.evaluate(() => window.run('undo'))
    assert.equal(await page.evaluate(() => window.doc()), DOC)
    // A line whose token is already broken (the owner's talk) is not a saved view, but its card is still
    // one object: it can be deleted whole, never nibbled further.
    const broken = DOC.replace(B, B.slice(0, -1))
    await page.evaluate((d) => window.mountEditor(d), broken)
    assert.equal(await page.evaluate(() => window.atomic().length), 1)
    assert.equal(await page.evaluate(() => window.imageAtomic().length), 3)
  })
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
console.log(`capture card delete: ${passed} passed`)
