// test:quotation-enter — Enter twice leaves a quotation; Shift-Enter starts a new paragraph inside one.
//
// The app's own editor keymap (keymap/store.ts buildEditorKeyBindings, so the order of keymap/registry.ts) in a real
// CodeMirror editor (with the object blocks field its Enter commands read) beside the markdown language and history, in chrome-headless-shell (never the real Chrome). Keys are
// key presses. Before the rule, Enter on a quotation's empty marker line left `>` and opened another `> `: three Enters
// left. `before` mounts the app's chain without the two quotation commands (the editor as it was) and `bare` mounts no
// app keymap at all; the "unchanged" cases compare the editor with the rule to those. The Plain view has no editing
// handler of its own in this build (no extension in src/renderer/src/extensions binds Enter for it), so none is tested.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const SHELL = join(homedir(), '.cache/puppeteer/chrome-headless-shell/mac_arm-146.0.7680.66/chrome-headless-shell-mac-arm64/chrome-headless-shell')
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-quotation-enter-'))
const outfile = join(dir, 'bundle.js')

const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Prec } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, undo, undoDepth } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { buildEditorKeyBindings } from './src/renderer/src/keymap/store.ts'
// These are literal source quotation/list cases; closed-card Enter is covered by test:object-block-field.
import { continueList, enterFromHeading, enterFromProtectedLine } from './src/renderer/src/extensions/outliner.ts'
let view = null
// \`|\` in the text marks the caret. mode: 'app' (the app's keymap), 'before' (its Enter chain without the quotation
// commands), 'bare' (no app keymap).
window.mount = (marked, mode = 'app') => {
  if (view) view.destroy()
  const at = marked.indexOf('|')
  const doc = marked.replace('|', '')
  const app = mode === 'app' ? buildEditorKeyBindings()
    : mode === 'before' ? [{ key: 'Enter', run: (v) => enterFromHeading(v) || enterFromProtectedLine(v) || continueList(v) }]
    : []
  view = new EditorView({
    parent: document.getElementById('host'),
    state: EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions: [
      Prec.highest(keymap.of(app)),
      history(),
      markdown({ base: markdownLanguage }),
      keymap.of([...defaultKeymap, ...historyKeymap])
    ] })
  })
  view.focus()
}
window.shown = () => { const { head } = view.state.selection.main; const t = view.state.doc.toString(); return t.slice(0, head) + '|' + t.slice(head) }
window.depth = () => undoDepth(view.state)
window.undoOnce = () => undo(view)
window.bindsShiftEnter = () => buildEditorKeyBindings().filter((b) => b.key === 'Shift-Enter').length
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const browser = await chromium.launch({ executablePath: SHELL, headless: true })
let ran = 0
try {
  const page = await browser.newPage()
  await page.setContent('<div id="host"></div>')
  await page.addScriptTag({ path: outfile })
  const mount = (marked, mode) => page.evaluate(([m, x]) => window.mount(m, x), [marked, mode])
  const shown = () => page.evaluate(() => window.shown())
  // The history groups changes closer than 500 ms; the pause keeps each key press its own step.
  const press = async (key) => { await page.waitForTimeout(600); await page.keyboard.press(key) }
  /** Mount `marked`, press the keys, return the text with the caret shown as `|`. */
  const after = async (marked, keys, mode = 'app') => { await mount(marked, mode); for (const key of keys) await press(key); return shown() }
  const check = async (name, body) => {
    ran += 1
    try { await body() } catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }) }
  }

  await check('the app binds Shift-Enter once', async () => {
    assert.equal(await page.evaluate(() => window.bindsShiftEnter()), 1)
  })

  // ── Enter ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  await check('first Enter continues the quotation', async () => {
    assert.equal(await after('> Words that someone said.|', ['Enter']), '> Words that someone said.\n> |')
  })
  await check('second Enter leaves it: an empty line, one blank, the caret on a new empty line', async () => {
    assert.equal(await after('> Words that someone said.|', ['Enter', 'Enter']), '> Words that someone said.\n\n|')
  })
  await check('a third Enter is an ordinary Enter (one more blank line)', async () => {
    assert.equal(await after('> Words that someone said.|', ['Enter', 'Enter', 'Enter']), '> Words that someone said.\n\n\n|')
  })
  await check('Enter in the middle of a line splits it and the new line begins with a marker', async () => {
    const text = await after('> Words| that someone said.', ['Enter'])
    const lines = text.split('\n')
    assert.equal(lines.length, 2, text)
    assert.equal(lines[0], '> Words')
    assert(/^> \|\s*that someone said\.$/.test(lines[1]), text)
  })
  await check('nested: Enter on the empty innermost marker leaves the whole quotation', async () => {
    assert.equal(await after('> > Inner words.|', ['Enter']), '> > Inner words.\n> > |')
    assert.equal(await after('> > Inner words.|', ['Enter', 'Enter']), '> > Inner words.\n\n|')
  })
  await check('a marker-only line with trailing spaces', async () => {
    assert.equal(await after('> Words.\n>   |', ['Enter']), '> Words.\n\n|')
    assert.equal(await after('> Words.\n>|', ['Enter']), '> Words.\n\n|')
    assert.equal(await after('> Words.\n> > |', ['Enter']), '> Words.\n\n|')
  })
  await check('a blank line below with a title right after it: the caret line gets a blank above and a blank below', async () => {
    // Before the rule the blank below was reused and the caret sat directly above the title.
    assert.equal(await after('> Words.\n> |\n\n### Next slide', ['Enter']), '> Words.\n\n|\n\n### Next slide')
    assert.equal(await after('> Words.\n> |\n\nNext.', ['Enter']), '> Words.\n\n|\n\nNext.')
  })
  await check('a blank line already below is the caret line when another blank follows it; more blank lines are left alone', async () => {
    assert.equal(await after('> Words.\n> |\n\n\n\nNext.', ['Enter']), '> Words.\n\n|\n\n\nNext.')
    assert.equal(await after('> Words.\n> |\n\n\n### Next slide', ['Enter']), '> Words.\n\n|\n\n### Next slide')
  })
  await check('a blank line below that is the last line of the document is the caret line', async () => {
    assert.equal(await after('> Words.\n> |\n', ['Enter']), '> Words.\n\n|')
  })
  await check('a line of text directly below the marker: the ordinary Enter, as it was', async () => {
    assert.equal(await after('> Words.\n> |\nNext.', ['Enter']), '> Words.\n\n|\nNext.')
  })
  await check('inside a fenced code block Enter is as it was', async () => {
    const doc = '```\n> |\n```'
    const was = await after(doc, ['Enter'], 'before')
    assert.equal(await after(doc, ['Enter']), was)
    assert.notEqual(was, '```\n\n|\n```', 'the leave shape is not what the block gets')
  })
  await check('list items are as they were', async () => {
    assert.equal(await after('- a|', ['Enter']), '- a\n- |')
    assert.equal(await after('- a|', ['Enter', 'Enter']), '- a\n|')
    for (const doc of ['- a\n  > |', '- a\n\n  > b\n  > |', '- > |', '1. a\n   > |']) {
      assert.equal(await after(doc, ['Enter']), await after(doc, ['Enter'], 'before'), doc)
    }
  })
  await check('undo: each Enter is one step', async () => {
    await mount('> Words.|', 'app')
    assert.equal(await page.evaluate(() => window.depth()), 0)
    await press('Enter')
    assert.equal(await page.evaluate(() => window.depth()), 1)
    assert.equal(await shown(), '> Words.\n> |')
    await press('Enter')
    assert.equal(await page.evaluate(() => window.depth()), 2, 'the second Enter is a step of its own')
    assert.equal(await shown(), '> Words.\n\n|')
    await page.evaluate(() => window.undoOnce())
    assert.equal(await shown(), '> Words.\n> |', 'one undo takes back the second Enter only')
    await page.evaluate(() => window.undoOnce())
    assert.equal(await shown(), '> Words.|')
  })

  // ── Shift-Enter ────────────────────────────────────────────────────────────────────────────────────────────────────
  await check('Shift-Enter at the end of a quotation line: a bare marker line, then a new marker line', async () => {
    assert.equal(await after('> First paragraph.|', ['Shift+Enter']), '> First paragraph.\n>\n> |')
  })
  await check('Shift-Enter in the middle: the tail goes after the new marker', async () => {
    assert.equal(await after('> First| second.', ['Shift+Enter']), '> First\n>\n> |second.')
    assert.equal(await after('> First |second.', ['Shift+Enter']), '> First\n>\n> |second.')
  })
  await check('Shift-Enter on a marker-only line: Enter, Shift-Enter ends in the same shape', async () => {
    assert.equal(await after('> First paragraph.|', ['Enter', 'Shift+Enter']), '> First paragraph.\n>\n> |')
    assert.equal(await after('> First paragraph.\n> |', ['Shift+Enter']), '> First paragraph.\n>\n> |')
  })
  await check('Shift-Enter in a nested quotation keeps the depth', async () => {
    assert.equal(await after('> > Inner.|', ['Shift+Enter']), '> > Inner.\n> >\n> > |')
  })
  await check('a second paragraph with text: Enter, Enter leaves the quotation with one blank line', async () => {
    assert.equal(await after('> One.|', ['Shift+Enter']), '> One.\n>\n> |')
    assert.equal(await after('> One.\n>\n> Two.|', ['Enter', 'Enter']), '> One.\n>\n> Two.\n\n|')
    assert.equal(await after('> One.|', ['Shift+Enter', 'Enter']), '> One.\n>\n\n|', 'Enter on the empty new paragraph leaves')
  })
  await check('Shift-Enter outside a quotation, in a code block and in a list item is as it was', async () => {
    for (const doc of ['Plain text|', '```\n> x|\n```', '- a|', '1. a|', '- a\n  > b|', '# Heading|']) {
      assert.equal(await after(doc, ['Shift+Enter']), await after(doc, ['Shift+Enter'], 'bare'), doc)
    }
  })
  await check('undo: Shift-Enter is one step', async () => {
    await mount('> First paragraph.|', 'app')
    await press('Shift+Enter')
    assert.equal(await page.evaluate(() => window.depth()), 1)
    await page.evaluate(() => window.undoOnce())
    assert.equal(await shown(), '> First paragraph.|')
  })
  console.log(`quotation enter ok: ${ran} cases; two Enters leave a quotation with one blank line, Shift-Enter starts a paragraph in it, and lists, code blocks and other lines are as they were`)
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
