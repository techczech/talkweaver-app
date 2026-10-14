// test:plain-view-hidden-text-rules — plain editing view ticket 07, third fix round: how Plain
// protects the text it hides (heading tokens, layout lines, the front matter under Talk details).
//
// The rules, each with a case below:
//   - No Plain filter changes, cancels or extends a change to the document. A paste, a composed
//     character, a drop, a replace and Replace All produce exactly the document asked for, and the
//     dispatched transaction keeps its annotations and effects.
//   - The caret never rests between a heading's visible text and its hidden tokens, nor after
//     them: it is settled to the end of the visible text by a selection added to the transaction,
//     whoever made the transaction. Find matches and composition are not settled.
//   - Enter in a `##`–`######` heading is the app's own "Enter from a title": the caret goes to the
//     first body line and the title is not split. The harness binds the app's three Enter commands
//     in the order Editor.tsx uses, so these cases test what the app does.
//   - Backspace, Delete, Alt-Backspace, Alt-Delete and Mod-Delete do nothing when the one character
//     they would delete lies in a hidden span's guard span; elsewhere they are the ordinary keys.
//   - A selection that spans a hidden layout line takes it when deleted (as in Markdown); a notice
//     says so, and Undo restores it byte for byte.
//   - Markdown mode has none of this.
//
// The mount holds the app's own tokenProtectExtension and history(). A case that needs to show
// Plain's rule on its own (a change idProtect would refuse in both modes) mounts without it and
// says so.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-hidden-rules-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment, Prec, Transaction, StateEffect, Annotation } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, historyKeymap, defaultKeymap, undo } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { search, setSearchQuery, SearchQuery, replaceAll, searchKeymap } from '@codemirror/search'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { hiddenRegions } from './src/renderer/src/extensions/plainView/hiddenLines.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { focusScopeExtension } from './src/renderer/src/extensions/focusScope.ts'
import { frontmatterTableExtension } from './src/renderer/src/extensions/frontmatterTable.ts'
import { appEnterBindings, appKeyState, failOnCaughtExceptions } from './scripts/lib/plain-view-test-mount.mjs'

const compartment = new Compartment()
const testNote = Annotation.define()
const testMark = StateEffect.define()
window.log = []
window.toasts = []
window.addEventListener('tw-toast', (e) => window.toasts.push(e.detail))
window.mount = (doc, mode = 'plain', protect = true) => {
  document.getElementById('host').innerHTML = ''
  window.log.length = 0; window.toasts.length = 0
  const view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [
      history(), markdown({ base: markdownLanguage, codeLanguages: languages }),
      protect ? tokenProtectExtension() : [], focusScopeExtension(), frontmatterTableExtension(), appKeyState(), search(),
      // The app's own Enter chain (keymap/registry.ts), ahead of the default keymap, with the state it reads.
      Prec.highest(keymap.of(appEnterBindings())),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      compartment.of(viewModeExtension(mode)),
      failOnCaughtExceptions(),
      EditorView.updateListener.of((u) => { for (const tr of u.transactions) window.log.push({
        doc: tr.docChanged, note: tr.annotation(testNote) ?? null, remote: tr.annotation(Transaction.remote) === true,
        history: tr.annotation(Transaction.addToHistory) ?? null, event: tr.annotation(Transaction.userEvent) ?? null,
        marks: tr.effects.filter((e) => e.is(testMark)).map((e) => e.value), head: tr.newSelection.main.head
      }) })
    ]
  }) })
  view.focus()
  return window.__v = view
}
// Dispatch as other code would: { changes, selection, event, note, mark, remote, noHistory }.
window.send = (spec) => {
  window.log.length = 0
  const annotations = []
  if (spec.note) annotations.push(testNote.of(spec.note))
  if (spec.remote) annotations.push(Transaction.remote.of(true))
  if (spec.noHistory) annotations.push(Transaction.addToHistory.of(false))
  window.__v.dispatch({
    ...(spec.changes ? { changes: spec.changes } : {}),
    ...(spec.selection !== undefined ? { selection: EditorSelection.cursor(spec.selection) } : {}),
    ...(annotations.length ? { annotations } : {}),
    ...(spec.event ? { userEvent: spec.event } : {}),
    ...(spec.mark ? { effects: testMark.of(spec.mark) } : {})
  })
  return window.log.slice()
}
window.caret = (pos, head) => window.__v.dispatch({ selection: head === undefined ? EditorSelection.cursor(pos) : EditorSelection.single(pos, head), userEvent: 'select' })
window.head = () => window.__v.state.selection.main.head
window.sel = () => { const r = window.__v.state.selection.main; return [r.from, r.to] }
window.docText = () => window.__v.state.doc.toString()
window.regions = () => hiddenRegions(window.__v.state).map((r) => [r.kind, r.from, r.to])
window.undo = () => undo(window.__v)
window.replaceAll = (find, replace) => { window.__v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: find, replace })) }); return replaceAll(window.__v) }
window.coords = (pos) => { const c = window.__v.coordsAtPos(pos); return { x: c.left + 1, y: (c.top + c.bottom) / 2 } }
window.shown = () => window.__v.contentDOM.innerText
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const TAIL = '### Alpha {reveal}\nBody'
const ID_TAIL = '### Alpha {id=a1}\nBody'
const RUN = '### Alpha\n{statement}\nBody text'
const RUN_ID = '### Alpha\n{statement}\n{id=a1}\nBody'
const FM = '---\nauthor: A\n---\n# Talk\n'
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

const browser = await chromium.launch()
const errors = []
const failed = []
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<div id="host" style="width:900px;height:800px"></div>')
  await page.addScriptTag({ path: outfile })
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const open = (d, mode = 'plain', protect = true) => ev(([d, m, p]) => { window.mount(d, m, p) }, [d, mode, protect])
  const text = () => ev(() => window.docText())
  const head = () => ev(() => window.head())
  const caret = (pos) => ev((p) => window.caret(p), pos)
  const send = (spec) => ev((s) => window.send(s), spec)
  const toasts = () => ev(() => window.toasts.filter((t) => t.key === 'plain-hidden-removed'))
  const check = async (label, fn) => {
    try { await fn() } catch (e) { failed.push(`${label}: ${String(e.message).split('\n')[0]}${e.actual !== undefined ? ' | got ' + JSON.stringify(e.actual) + ' | wanted ' + JSON.stringify(e.expected) : ''}`) }
  }

  // ── Enter in a title: the app's "Enter from a title" ───────────────────────────────────────
  for (const [label, d] of [['a hidden option', TAIL], ['a hidden id', ID_TAIL], ['hidden layout lines', RUN_ID]]) {
    await check(`Enter in the middle of a title with ${label}`, async () => {
      await open(d)
      await caret(7)
      await page.keyboard.press('Enter')
      assert.equal(await text(), d, 'the document is unchanged')
      assert.equal(await head(), d.lastIndexOf('Body'), 'the caret is at the start of the body line')
    })
  }

  // ── Changes go through as given, with their annotations ───────────────────────────────────
  for (const event of ['input.paste', 'input.type.compose', 'move.drop', 'input.replace']) {
    await check(`${event} of a line break inside a title lands where it was put`, async () => {
      await open(TAIL)
      await caret(7)
      const log = await send({ changes: { from: 7, insert: '\nPASTED' }, event, note: 'kept', mark: 'm' })
      assert.equal(await text(), '### Alp\nPASTEDha {reveal}\nBody')
      const changed = log.filter((t) => t.doc)
      assert.equal(changed.length, 1, 'one transaction changed the document: ' + JSON.stringify(log))
      assert.deepEqual([changed[0].note, changed[0].event, changed[0].marks], ['kept', event, ['m']], 'its annotation, user event and effect arrive')
    })
  }
  await check('Replace All changes a hidden token and the visible word', async () => {
    await open('### Alpha {reveal}\nreveal')
    await caret(5)
    await ev(() => window.replaceAll('reveal', 'list'))
    assert.equal(await text(), '### Alpha {list}\nlist')
  })
  await check('a replacement that ends inside a hidden token is not extended (Plain\'s filters alone)', async () => {
    await open(TAIL, 'plain', false)
    await send({ changes: { from: 0, to: 13, insert: 'Replacement' }, event: 'input.replace.all' })
    assert.equal(await text(), 'Replacementveal}\nBody')
  })
  await check('the same replacement with the app\'s title protection: Plain does what Markdown does', async () => {
    const results = []
    for (const mode of ['markdown', 'plain']) {
      await open(TAIL, mode)
      await send({ changes: { from: 0, to: 13, insert: 'Replacement' }, event: 'input.replace.all' })
      results.push(await text())
    }
    assert.equal(results[1], results[0])
  })

  // ── Settling the caret ─────────────────────────────────────────────────────────────────────
  await check('a caret put inside a hidden token by code is settled to the end of the title text', async () => {
    await open(TAIL)
    await caret(2)
    const log = await send({ selection: 12, note: 'kept', mark: 'm' })
    const carried = log.filter((t) => t.note === 'kept')
    assert.equal(carried.length, 1, 'the dispatched transaction arrives once: ' + JSON.stringify(log))
    assert.deepEqual([carried[0].doc, carried[0].event, carried[0].marks], [false, null, ['m']], 'with its annotation and effect, and no change')
    assert.equal(log.some((t) => t.doc), false, 'nothing changed the document')
    assert.equal(await head(), 9, 'the caret rests at the end of "Alpha"')
    await page.keyboard.type('X')
    assert.equal(await text(), '### AlphaX {reveal}\nBody')
  })
  await check('End on a title with a hidden token, then ArrowRight', async () => {
    await open(TAIL)
    await caret(6)
    await page.keyboard.press('End')
    assert.equal(await head(), 9, 'End rests at the end of the title text')
    await page.keyboard.press('ArrowRight')
    assert.equal(await head(), TAIL.indexOf('Body'), 'ArrowRight steps to the next line')
    await page.keyboard.press('ArrowLeft')
    assert.equal(await head(), 9, 'ArrowLeft comes back to the end of the title text')
  })
  for (const [label, d, end] of [['a hidden layout line', RUN, 9], ['a hidden token and hidden layout lines', '### Alpha {reveal}\n{statement}\n{id=a1}\nBody', 9]]) {
    await check(`End, typing and the arrows on a title with ${label}`, async () => {
      await open(d)
      await caret(6)
      await page.keyboard.press('End')
      assert.equal(await head(), end, 'End rests at the end of the title text')
      await page.keyboard.press('End')
      assert.equal(await head(), end, 'End again stays there')
      await page.keyboard.type('s')
      assert.equal((await text()).split('\n')[0], d.split('\n')[0].replace('Alpha', 'Alphas'), 'typing lands at the end of the title text')
      assert.equal((await text()).split('\n').slice(1).join('\n'), d.split('\n').slice(1).join('\n'), 'the hidden lines are untouched')
      await page.keyboard.press('ArrowRight')
      assert.equal(await head(), (await text()).indexOf('Body'), 'ArrowRight steps over the hidden text to the body line')
      await page.keyboard.press('ArrowLeft')
      assert.equal(await head(), end + 1, 'ArrowLeft comes back to the end of the title text')
      assert.equal((await ev(() => window.shown())).includes('{'), false, 'nothing hidden was revealed on the way')
    })
  }
  await check('typing words at the end of a title lands before the hidden token', async () => {
    await open(TAIL)
    await caret(9)
    await page.keyboard.type(' beta gamma')
    assert.equal((await text()).split('\n')[0].replace(/ +\{/, ' {'), '### Alpha beta gamma {reveal}')
    assert.equal((await ev(() => window.shown())).includes('{reveal}'), false, 'the token is still hidden')
  })
  await check('a composed character beside a hidden token is not followed by a caret move', async () => {
    await open(TAIL)
    await caret(9)
    const log = await send({ changes: { from: 9, insert: 'あ' }, selection: 11, event: 'input.type.compose' })
    assert.equal(await text(), '### Alphaあ {reveal}\nBody')
    assert.deepEqual(log.map((t) => t.head), [11], 'one transaction, its selection as given: ' + JSON.stringify(log))
    assert.equal(await head(), 11)
    // The same change typed is settled.
    await open(TAIL)
    await caret(9)
    await send({ changes: { from: 9, insert: 'a' }, selection: 11, event: 'input.type' })
    assert.equal(await head(), 10, 'a typed character with the same selection is settled to the end of the text')
  })
  await check('a Find match inside a hidden token is not settled', async () => {
    await open(TAIL)
    await ev(() => window.__v.dispatch({ selection: { anchor: 11, head: 17 }, userEvent: 'select.search' }))
    assert.deepEqual(await ev(() => window.sel()), [11, 17])
    assert.ok((await ev(() => window.shown())).includes('{reveal}'), 'the token shows while the match is selected')
  })

  // ── Talk details: a remote change keeps its annotations ───────────────────────────────────
  for (const event of [null, 'input.type']) {
    await check(`a remote change to the front matter${event ? ' tagged ' + event : ''} is applied whole and is not undone locally`, async () => {
      await open(FM)
      await caret(FM.indexOf('Talk'))
      const log = await send({ changes: { from: 12, to: 13, insert: 'B' }, selection: 10, remote: true, noHistory: true, note: 'kept', ...(event ? { event } : {}) })
      assert.equal(await text(), FM.replace('author: A', 'author: B'))
      const changed = log.filter((t) => t.doc)
      assert.equal(changed.length, 1, JSON.stringify(log))
      assert.deepEqual([changed[0].remote, changed[0].history, changed[0].note, changed[0].event], [true, false, 'kept', event], 'remote, addToHistory(false), the annotation and the user event all arrive')
      assert.ok(await head() > FM.indexOf('---\n#') + 3, 'the caret is not left in the front matter: ' + await head())
      await ev(() => window.undo())
      assert.equal(await text(), FM.replace('author: A', 'author: B'), 'Undo does not revert the remote change')
    })
  }

  // ── Backspace and Delete beside a hidden span ─────────────────────────────────────────────
  const key = async (label, d, pos, press, want = d, protect = true) => check(label, async () => {
    await open(d, 'plain', protect)
    await caret(pos)
    assert.equal(await head(), pos, 'the caret is where the case puts it')
    await page.keyboard.press(press)
    assert.equal(await text(), want)
  })
  await key('Backspace at the start of the body under a hidden layout line: nothing', RUN, RUN.indexOf('Body'), 'Backspace')
  await key('Alt-Backspace there: nothing', RUN, RUN.indexOf('Body'), 'Alt+Backspace')
  await key('Backspace at the start of the body under a title with a hidden token: nothing', TAIL, TAIL.indexOf('Body'), 'Backspace')
  await key('Delete at the end of the title text, hidden token: nothing', TAIL, 9, 'Delete')
  await key('Alt-Delete there: nothing', TAIL, 9, 'Alt+Delete')
  await key('Mod-Delete there: nothing', TAIL, 9, `${mod}+Delete`)
  await key('Delete at the end of a title with a hidden layout line and no token: nothing', RUN, 9, 'Delete')
  await key('Backspace at the end of the title text deletes a letter', TAIL, 9, 'Backspace', '### Alph {reveal}\nBody')
  await key('Delete inside the title text deletes a letter', TAIL, 6, 'Delete', '### Alha {reveal}\nBody')
  await key('Backspace at the start of the line under Talk details: nothing', '---\nauthor: A\n---\nIntro\n# Talk\n', 18, 'Backspace')
  await key('Backspace at the start of the talk title under Talk details: nothing', FM, FM.indexOf('# Talk'), 'Backspace')
  // Without the app's own title protection, to show it is Plain's key rule that holds these.
  await key('Backspace under a hidden layout line (Plain alone): nothing', RUN, RUN.indexOf('Body'), 'Backspace', RUN, false)
  await key('Delete at the end of the title text (Plain alone): nothing', TAIL, 9, 'Delete', TAIL, false)
  await key('Backspace at the start of the talk title (Plain alone): nothing', FM, FM.indexOf('# Talk'), 'Backspace', FM, false)

  // ── A selection across a hidden layout line takes it ──────────────────────────────────────
  await check('a selection from the title to the body, Backspace: the layout line goes, a notice says so, Undo restores it', async () => {
    await open(RUN)
    await caret(6)
    await page.keyboard.press('Shift+ArrowDown')
    const [from, to] = await ev(() => window.sel())
    assert.equal(from, 6, 'the selection starts inside the title')
    assert.ok(to > RUN.indexOf('Body') && to < RUN.length, 'and ends inside the body, across the hidden layout line: ' + to)
    await page.keyboard.press('Backspace')
    assert.equal(await text(), RUN.slice(0, 6) + RUN.slice(to), 'the selection is deleted as given: the layout line with it, the title stays a title')
    const notices = await toasts()
    assert.equal(notices.length, 1, 'one notice: ' + JSON.stringify(notices))
    assert.equal(notices[0].message, 'A slide\'s layout line was removed with the selection. Undo restores it.')
    assert.equal(notices[0].level, 'warning')
    await page.keyboard.press(`${mod}+z`)
    assert.equal(await text(), RUN, 'Undo restores it byte for byte')
  })
  await check('deleting inside the body gives no notice', async () => {
    await open(RUN)
    await caret(RUN.length)
    await page.keyboard.press('Backspace')
    assert.equal((await toasts()).length, 0)
  })

  // ── Markdown mode is as it was ─────────────────────────────────────────────────────────────
  await check('Markdown mode: no hidden spans, no settling, the same Enter, no notice', async () => {
    await open(TAIL, 'markdown')
    assert.deepEqual(await ev(() => window.regions()), [])
    await send({ selection: 12 })
    assert.equal(await head(), 12, 'a caret inside the token stays where it was put')
    await caret(7)
    await page.keyboard.press('Enter')
    assert.equal(await text(), TAIL)
    assert.equal(await head(), TAIL.indexOf('Body'))
    await open(RUN, 'markdown')
    await caret(RUN.indexOf('Body'))
    await ev(() => window.__v.dispatch({ selection: { anchor: 6, head: window.docText().indexOf('Body') + 2 } }))
    await page.keyboard.press('Backspace')
    assert.equal(await text(), '### Aldy text')
    assert.equal((await toasts()).length, 0, 'the notice is Plain\'s')
  })

  assert.equal(errors.length, 0, 'no page errors: ' + errors.join(' | '))
  assert.deepEqual([...new Set(await ev(() => window.__caught))], [], 'no exception that CodeMirror caught')
  assert.deepEqual(failed, [], `${failed.length} failed:\n  ` + failed.join('\n  '))
  console.log('plain view hidden text rules: ok')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
