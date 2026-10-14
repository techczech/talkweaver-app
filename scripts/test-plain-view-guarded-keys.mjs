// test:plain-view-guarded-keys — plain editing view ticket 07, fourth fix round: no single key
// press deletes or exposes text that Plain hides, whichever key it is.
//
// The key list is not written here. It is read from what the editor binds: the base keymap
// (extensions/editorBaseKeymap.ts: CodeMirror's default keymap with its macOS Emacs-style keys,
// folding, Find; undo and redo left out) and the app's own commands (keymap/store.ts). Every one
// of those keys, with Shift where the binding has a Shift form, is pressed at each of four carets
// beside hidden text, and the hidden text must still be there, still hidden:
//   - the start of the body line under a hidden layout line;
//   - the end of a title's visible text, before its hidden option;
//   - the start of the first line under the Talk details panel;
//   - the start of the body line under a title whose only hidden group is an icon.
// And the other way round: where no hidden text is in reach, every one of those keys does in
// Plain exactly what it does in Markdown.
//
// Also held here (review Standards 1 and 3): a title's icon group is part of the title's one
// hidden tail. End and typing stay before every group; the caret still steps into the icon's chip
// to edit its name.
//
// Fifth fix round (the review's Spec 1, Standards 1 and 2):
//   - What is protected is read from the document, not from what is drawn. A paragraph's and a
//     list item's icon token is protected while its chip shows (the caret at the end of the
//     text): Delete and Ctrl-D there do nothing, End stays before the token.
//   - No key puts the caret on protected text it was not on: Backspace on the empty line under a
//     layout line is held. After every key of the table that is let through, the caret is not on
//     protected text, and one more Backspace and one more Delete leave the protected text whole.
//   - The dry run has no effect of its own: every bound key does in Plain what it does in
//     Markdown to Tab focus mode, the Find panel, the folds, the focus and the scroll position,
//     and the dry run called alone changes none of them.
//
// The mount is the app's: its token protection, history, the object blocks' state its commands
// read, and its own key bindings (its Enter chain among them) at the highest precedence, the base
// keymap below them. An exception CodeMirror catches fails the file (sixth fix round).
//
// Seventh fix round (the review's Spec 1 and 2):
//   - Enter then Undo leaves the caret at the end of the visible text, never after the tokens: the
//     Enter rule moves no caret of its own, and the caret is settled after every transaction, the
//     ones that pass no filter (Undo, Redo) among them (plainView/settleCaret.ts).
//   - A heading is a heading whatever whitespace follows its marks: the Enter matrix is run with
//     a space, a tab and two spaces, and the plain view's one reader of heading lines
//     (shared/plain-view-heading-line.ts) is held against the compiler's outline parser.
//
// Eighth review (Spec 1): which trailing groups of a heading are its hidden tail is the compiler's
// answer (parseHeadingAttrs peels every trailing group off the title, glued or escaped as well as
// spaced, icon or not), read through the shared port of its reader. Held here: on every heading
// line of scripts/fixtures/plain-view-icon-token-lines.json the ranges Plain protects are the
// ranges the compiler consumes; nothing Plain protects on such a line is shown; a paragraph's
// escaped or glued braces are text in Plain as in the compiler (End, a mouse click, Backspace and
// Delete do there what they do in Markdown); and every line of the literal-braces fixture is
// edited at its end as the compiler reads it.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-guarded-keys-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment, Prec } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, undoDepth, redoDepth } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { search, searchPanelOpen } from '@codemirror/search'
import { foldedRanges } from '@codemirror/language'
import * as guardKeys from './src/renderer/src/extensions/plainView/guardKeys.ts'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { focusScopeExtension } from './src/renderer/src/extensions/focusScope.ts'
import { frontmatterTableExtension } from './src/renderer/src/extensions/frontmatterTable.ts'
import { editorBaseKeymap, editorHistoryKeymap } from './src/renderer/src/extensions/editorBaseKeymap.ts'
import { buildEditorKeyBindings } from './src/renderer/src/keymap/store.ts'
import { appKeyState, failOnCaughtExceptions } from './scripts/lib/plain-view-test-mount.mjs'
import * as settleCaret from './src/renderer/src/extensions/plainView/settleCaret.ts'
import { headingLine } from './src/shared/plain-view-heading-line.ts'

const STAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5L5.5 21l2-7.5L2 9h7z"/></svg>'
const compartment = new Compartment()
const mac = /Mac/.test(navigator.platform)
window.mount = (doc, mode = 'plain') => {
  document.getElementById('host').innerHTML = ''
  const view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [
      history(), markdown({ base: markdownLanguage, codeLanguages: languages }),
      tokenProtectExtension(), focusScopeExtension(), frontmatterTableExtension(),
      // The state the app's bound commands read (the object blocks' fields).
      appKeyState(), search(),
      keymap.of([...editorBaseKeymap]),
      // The app's own keys, as Editor.tsx installs them.
      Prec.highest(keymap.of(buildEditorKeyBindings())),
      compartment.of(viewModeExtension(mode, { iconSvg: async () => STAR })),
      EditorView.lineWrapping,
      failOnCaughtExceptions()
    ]
  }) })
  view.focus()
  return window.__v = view
}
// The keys the editor binds on this platform: [name, has a Shift form, where it is bound].
window.keys = () => {
  const out = []
  const seen = new Set()
  const add = (b, source) => {
    const name = (mac ? b.mac : /Win/.test(navigator.platform) ? b.win : b.linux) ?? b.key
    if (!name || name.includes(' ')) return
    if (b.scope && !b.scope.split(' ').includes('editor')) return
    for (const shift of b.shift ? [false, true] : [false]) {
      const id = name + '|' + shift
      if (seen.has(id)) continue
      seen.add(id)
      out.push([name, shift, source])
    }
  }
  for (const b of editorBaseKeymap) if (!editorHistoryKeymap.includes(b)) add(b, 'base')
  for (const b of buildEditorKeyBindings()) add(b, 'app')
  return out
}
window.caret = (pos) => window.__v.dispatch({ selection: EditorSelection.cursor(pos), userEvent: 'select' })
window.head = () => window.__v.state.selection.main.head
window.empty = () => window.__v.state.selection.main.empty
window.caretLine = () => window.__v.state.doc.lineAt(window.__v.state.selection.main.head).text
window.docText = () => window.__v.state.doc.toString()
window.shown = () => window.__v.contentDOM.innerText
// Whether the editor's keymaps handled the last key (else the browser moved the caret itself).
window.handled = null
document.addEventListener('keydown', (e) => { window.handled = e.defaultPrevented })
// Everything a key press can change, beyond the text.
window.snap = () => {
  const v = window.__v
  const folds = []
  foldedRanges(v.state).between(0, v.state.doc.length, (from, to) => { folds.push([from, to]) })
  const active = document.activeElement
  return {
    doc: v.state.doc.toString(),
    sel: v.state.selection.ranges.map((r) => [r.anchor, r.head]),
    tabFocus: v.inputState.tabFocusMode === 0 ? 'on' : v.inputState.tabFocusMode > 0 ? 'for a moment' : 'off',
    findOpen: searchPanelOpen(v.state),
    folds,
    focus: active === v.contentDOM ? 'editor' : active ? active.tagName + '.' + active.className : 'none',
    scroll: Math.round(v.scrollDOM.scrollTop)
  }
}
// The protected regions the caret is on: [kind, the caret is editing a part of it by hand].
window.zones = () => {
  const v = window.__v
  const head = v.state.selection.main.head
  return (guardKeys.protectedRegionsOf?.(v.state) ?? [])
    .filter((r) => head >= r.zoneFrom && head <= r.zoneTo)
    .map((r) => [r.kind, r.parts.some((p) => p.walk && head >= p.from && head <= p.to)])
}
// The dry run of every command the guard stands in front of, called alone: which changed anything.
window.dryAll = () => {
  const v = window.__v
  const changed = []
  let ran = 0
  for (const b of editorBaseKeymap) {
    if (editorHistoryKeymap.includes(b)) continue
    for (const [form, command] of [['', b.run], ['Shift-', b.shift]]) {
      if (!command) continue
      const before = window.snap()
      guardKeys.dryRun(v, command)
      ran += 1
      const after = window.snap()
      for (const what of Object.keys(before)) {
        if (JSON.stringify(after[what]) === JSON.stringify(before[what])) continue
        changed.push(form + (b.key ?? b.mac) + ' (' + (command.name || '?') + ') ' + what + (what === 'doc' ? '' : ': ' + JSON.stringify(before[what]) + ' -> ' + JSON.stringify(after[what])))
      }
    }
  }
  return { ran, changed, threw: guardKeys.dryRunThrew ?? null }
}
// What the guard costs on one key press: the Backspace binding's own test, which makes the dry run.
window.cost = (samples, each) => {
  const v = window.__v
  const run = guardKeys.guardBindings().find((b) => b.key === 'Backspace').run
  const times = []
  let held = 0
  for (let i = 0; i < samples; i += 1) {
    const t0 = performance.now()
    for (let j = 0; j < each; j += 1) if (run(v)) held += 1
    times.push((performance.now() - t0) / each)
  }
  times.sort((a, b) => a - b)
  return { median: times[Math.floor(times.length / 2)], worst: times[times.length - 1], held, regions: guardKeys.protectedRegionsOf(v.state).length, lines: v.state.doc.lines }
}
window.pictures = () => window.__v.contentDOM.querySelectorAll('.cm-plain-icon-picture').length
// Every protected part of the document as text: of the mounted editor, and of any text read as Plain reads it.
const partsOf = (state) => guardKeys.protectedRegionsOf(state).flatMap((r) => r.parts.map((p) => p.text)).sort()
window.inventory = () => partsOf(window.__v.state)
window.inventoryFor = (doc) => partsOf(EditorState.create({ doc, extensions: [viewModeExtension('plain')] }))
window.undoDepth = () => undoDepth(window.__v.state)
window.redoDepth = () => redoDepth(window.__v.state)
// How many times the settling listener has dispatched since the page loaded.
window.settles = () => settleCaret.settleDispatches.count
window.headingLine = (text) => headingLine(text)
// A transaction as code makes it (a plain spec: changes, selection, userEvent, filter).
window.raw = (spec) => window.__v.dispatch(spec)
// The ranges of a heading's hidden tail groups in any text, read as Plain reads it: [from, to, the title's icon].
window.tailRanges = (doc) => {
  const state = EditorState.create({ doc, extensions: [viewModeExtension('plain')] })
  return guardKeys.protectedRegionsOf(state).filter((r) => r.kind === 'tail').flatMap((r) => r.parts.map((p) => [p.from, p.to, p.walk]))
}
// What is drawn of the line the position is on.
window.shownLine = (pos) => {
  const v = window.__v
  let node = v.domAtPos(pos).node
  while (node && !(node.nodeType === 1 && node.classList.contains('cm-line'))) node = node.parentNode
  return node ? node.innerText : null
}
// The middle of the character after a position, on screen.
window.charPoint = (pos) => {
  const v = window.__v
  const a = v.coordsAtPos(pos, 1), b = v.coordsAtPos(pos + 1, -1)
  return a && b ? { x: (a.left + b.right) / 2, y: (a.top + a.bottom) / 2, left: a.left, right: b.right } : null
}
window.lineBox = (pos) => {
  const v = window.__v
  let node = v.domAtPos(pos).node
  while (node && !(node.nodeType === 1 && node.classList.contains('cm-line'))) node = node.parentNode
  const r = node.getBoundingClientRect()
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
}
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

const isMac = process.platform === 'darwin'
/** A CodeMirror key name as a Playwright chord. */
function chord(name, shift) {
  let key = name
  const mods = []
  for (;;) {
    const m = key.match(/^(Mod|Cmd|Meta|Ctrl|Control|Alt|Shift)-(.+)$/)
    if (!m) break
    mods.push(m[1] === 'Mod' ? (isMac ? 'Meta' : 'Control') : m[1] === 'Cmd' ? 'Meta' : m[1] === 'Ctrl' ? 'Control' : m[1])
    key = m[2]
  }
  if (shift && !mods.includes('Shift')) mods.push('Shift')
  return [...mods, key].join('+')
}

const RUN = '### Alpha\n{statement}\nBody text'
const TAIL = '### Alpha {reveal}\nBody'
const FM = '---\nauthor: A\n---\n# Talk\nBody'
const ICON = '### Alpha {icon=lucide:star}\nBody'
const PARA = 'Intro\n\nAlpha {icon=lucide:star}\n\nNext'
const LIST = '- Alpha {icon=lucide:star}\n- Two\n'
const EMPTY = '### Alpha\n{statement}\n\n### Beta\nB'
// Where the caret is put, and what must still be true of the document after any one key.
const CARETS = [
  { label: 'the start of the body line under a hidden layout line', doc: RUN, at: RUN.indexOf('Body'), intact: (d) => /^#{1,6} [^\n{}]*\n\{statement\}(\n|$)/m.test(d), bare: true },
  { label: 'the end of a title\'s text before a hidden option', doc: TAIL, at: 9, intact: (d) => /^#{1,6} [^\n{}]* \{reveal\}\n/m.test(d), bare: true },
  { label: 'the start of the first line under the Talk details panel', doc: FM, at: FM.indexOf('# Talk'), intact: (d) => d.startsWith('---\nauthor: A\n---\n'), bare: true },
  { label: 'the start of the body line under a title whose only hidden group is an icon', doc: ICON, at: ICON.indexOf('Body'), intact: (d) => /^#{1,6} [^\n{}]*\S \{icon=lucide:star\}(\n|$)/m.test(d), bare: false, icon: true },
  // Fifth fix round: the chip shows at these two carets, and the token is protected all the same.
  { label: 'the end of the text of a paragraph that ends in an icon', doc: PARA, at: PARA.indexOf(' {icon'), intact: (d) => /^[^\n{}]* \{icon=lucide:star\}$/m.test(d), bare: false, icon: true },
  { label: 'the end of the text of a list item that ends in an icon', doc: LIST, at: LIST.indexOf(' {icon'), intact: (d) => /^[^\n{}]* \{icon=lucide:star\}$/m.test(d), bare: false, icon: true },
  { label: 'the empty line under a hidden layout line', doc: EMPTY, at: EMPTY.indexOf('\n\n') + 1, intact: (d) => /^#{1,6} [^\n{}]*\n\{statement\}(\n|$)/m.test(d), bare: true }
]

const browser = await chromium.launch()
const errors = []
const caught = []
const failed = []
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<div id="host" style="width:900px;height:800px"></div>')
  await page.addScriptTag({ path: outfile })
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const open = (d, mode = 'plain') => ev(([d, m]) => { window.mount(d, m) }, [d, mode])
  const text = () => ev(() => window.docText())
  const head = () => ev(() => window.head())
  const caret = (pos) => ev((p) => window.caret(p), pos)
  const check = async (label, fn) => {
    try { await fn() } catch (e) { failed.push(`${label}: ${String(e.message).split('\n')[0]}${e.actual !== undefined ? ' | got ' + JSON.stringify(e.actual) + ' | wanted ' + JSON.stringify(e.expected) : ''}`) }
  }
  const picture = async () => { await page.waitForFunction(() => window.pictures() > 0) }
  /** Mount, put the caret, press one chord, answer the document. */
  const press = async (doc, at, key, mode = 'plain', withIcon = false) => {
    await open(doc, mode)
    if (withIcon && mode === 'plain') await picture()
    await caret(at)
    await page.keyboard.press(key)
    return text()
  }

  const keys = await ev(() => window.keys())
  const chords = keys.map(([name, shift, source]) => ({ name: (shift ? 'Shift-' : '') + name, key: chord(name, shift), source }))
  await check('the key list is the editor\'s own', async () => {
    assert.ok(chords.length > 60, `${chords.length} keys were read from the keymaps`)
    assert.ok(chords.some((c) => c.name === 'Backspace') && chords.some((c) => c.name === 'Delete'), 'Backspace and Delete are among them')
    assert.ok(chords.some((c) => c.source === 'app'), 'and the app\'s own keys')
    // (CodeMirror 6.43 binds no Alt-D; were one added to the base keymap it would be read here.)
    if (isMac) for (const k of ['Ctrl-h', 'Ctrl-d', 'Ctrl-k', 'Ctrl-Alt-h', 'Ctrl-o', 'Ctrl-t', 'Mod-Delete', 'Mod-Backspace', 'Alt-Backspace', 'Alt-Delete']) assert.ok(chords.some((c) => c.name === k), `${k} is among them`)
  })

  // ── Every bound key, at every caret beside hidden text ─────────────────────────────────────
  const MOVE_UP = chord('Mod-Shift-ArrowUp', false)
  const MOVE_DOWN = chord('Mod-Shift-ArrowDown', false)
  for (const spot of CARETS) {
    const broke = []
    for (const c of chords) {
      const after = await press(spot.doc, spot.at, c.key, 'plain', !!spot.icon)
      // "Delete this slide" takes the heading and its hidden text together: that is the one way.
      const slideGone = !/Alpha|Talk/.test(after)
      if (!spot.intact(after) && !slideGone) {
        broke.push(`${c.name} left ${JSON.stringify(after)}`); continue
      }
      if (slideGone) continue
      // Nothing hidden shows. (A selection reveals what it covers.)
      if (spot.bare && await ev(() => window.empty()) && (await ev(() => window.shown())).includes('{')) broke.push(`${c.name} shows hidden text: ${JSON.stringify(await ev(() => window.shown()))}`)
      // The caret is not on protected text. One way in is kept: a key that changes nothing and
      // steps into an icon token's chip (ArrowRight from the end of the text), to edit its name.
      const zones = await ev(() => window.zones())
      const walking = zones.length > 0 && zones.every(([, walk]) => walk) && after === spot.doc
      if (zones.length && !walking) { broke.push(`${c.name} left the caret on protected text (${zones.map(([kind]) => kind).join(', ')}): ${JSON.stringify(after)} at ${await head()}`); continue }
      // (A selection is the person's to delete with what it spans, as in Markdown.)
      if (walking || !(await ev(() => window.empty()))) continue
      // The second press: one more Backspace, then one more Delete, and the protected text is whole.
      for (const second of ['Backspace', 'Delete']) {
        await page.keyboard.press(second)
        const then = await text()
        if (!spot.intact(then) && /Alpha|Talk/.test(then)) { broke.push(`${c.name} then ${second} left ${JSON.stringify(then)}`); break }
      }
    }
    await check(`no key deletes or exposes hidden text at ${spot.label} (${chords.length} keys)`, async () => {
      assert.deepEqual(broke, [])
    })
  }

  // ── "Move slide or item up/down" beside hidden layout and id lines (issue 121) ────────────
  // The app's own command (keymap/registry.ts move-up, move-down; outliner.ts moveNode) runs above
  // every Plain key rule. A body line moves past a heading and its hidden lines together, so no
  // hidden line is parted from its heading, none is shown, and the caret stays on the moved line.
  const HEADS = [['a layout line', '{statement}'], ['an id line', '{id=a1}'], ['an id line and a layout line', '{id=a1}\n{statement}']]
  for (const [name, under] of HEADS) {
    const settled = async (label, doc, at, key, wanted, line) => {
      await check(label, async () => {
        assert.equal(await press(doc, at, key), wanted)
        assert.ok(!(await ev(() => window.shown())).includes('{'), 'no hidden line is shown')
        assert.deepEqual(await ev(() => window.zones()), [], 'the caret is not on protected text')
        assert.equal(await ev(() => window.caretLine()), line, 'the caret is on the moved line')
        await page.keyboard.press(isMac ? 'Meta+z' : 'Control+z')
        assert.equal(await text(), doc, 'one Undo restores the text')
      })
    }
    const up = `Intro\n### Alpha\n${under}\nBody text\nMore\n### Beta\nB`
    await settled(`Move up from the body line under ${name} puts the line above the heading`, up, up.indexOf('Body'), MOVE_UP,
      `Intro\nBody text\n### Alpha\n${under}\nMore\n### Beta\nB`, 'Body text')
    const down = `Intro\n### Alpha\n${under}\nBody text`
    await settled(`Move down from the line above a heading with ${name} puts the line under the hidden lines`, down, 0, MOVE_DOWN,
      `### Alpha\n${under}\nIntro\nBody text`, 'Intro')
    const item = `### Alpha\n${under}\n- One\n- Two`
    await check(`Move up on the first list item under ${name} does nothing`, async () => {
      assert.equal(await press(item, item.indexOf('- One') + 2, MOVE_UP), item)
      assert.ok(!(await ev(() => window.shown())).includes('{'), 'no hidden line is shown')
    })
    const title = `### Zero\nZ\n### Alpha\n${under}\nBody text`
    await settled(`Move up on a title with ${name} moves the slide with its hidden lines`, title, title.indexOf('Alpha'), MOVE_UP,
      `### Alpha\n${under}\nBody text\n### Zero\nZ`, '### Alpha')
  }

  // ── The review's inputs, by name ────────────────────────────────────────────────────────
  if (isMac) {
    await check('Ctrl-H at the start of the body under a hidden layout line does nothing', async () => {
      assert.equal(await press(RUN, RUN.indexOf('Body'), 'Control+h'), RUN)
      assert.equal(await head(), RUN.indexOf('Body'), 'the caret stays')
    })
    await check('Ctrl-D at the end of a title before its hidden option does nothing', async () => {
      assert.equal(await press(TAIL, 9, 'Control+d'), TAIL)
    })
    for (const [name, key] of [['Ctrl-K', 'Control+k'], ['Cmd-Delete', 'Meta+Delete']]) {
      await check(`${name} in the middle of a title deletes the visible text to its end and keeps the hidden option`, async () => {
        assert.equal(await press(TAIL, 6, key), '### Al {reveal}\nBody')
        assert.equal(await head(), 6)
        assert.ok(!(await ev(() => window.shown())).includes('{'), 'the option is still hidden')
        await page.keyboard.press('Meta+z')
        assert.equal(await text(), TAIL, 'one Undo restores the title')
      })
      await check(`${name} at the end of a title's text does nothing`, async () => {
        assert.equal(await press(TAIL, 9, key), TAIL)
      })
      await check(`${name} in the middle of a list item with an icon deletes its text and keeps the icon`, async () => {
        const d = '- Alpha beta {icon=lucide:star}\n- Two\n'
        assert.equal(await press(d, 5, key, 'plain', true), '- Alp {icon=lucide:star}\n- Two\n')
      })
    }
    await check('Ctrl-O in a title with a hidden option leaves the title whole', async () => {
      assert.equal(await press(TAIL, 9, 'Control+o'), TAIL, 'at the end of the text')
      assert.equal(await press(TAIL, 6, 'Control+o'), TAIL, 'in the middle')
    })
    await check('Ctrl-O at the end of a title with a hidden layout line under it does not part them', async () => {
      assert.equal(await press(RUN, 9, 'Control+o'), RUN)
    })
    await check('Ctrl-T, Ctrl-Alt-H and Alt-Delete beside hidden text', async () => {
      assert.equal(await press(RUN, RUN.indexOf('Body'), 'Control+t'), RUN, 'Ctrl-T at the start of the body')
      assert.equal(await press(RUN, RUN.indexOf('Body'), 'Control+Alt+h'), RUN, 'Ctrl-Alt-H at the start of the body')
      assert.equal(await press(TAIL, 9, 'Alt+Delete'), TAIL, 'Alt-Delete at the end of the title text')
      assert.equal(await press(TAIL, 7, 'Alt+Delete'), '### Alp {reveal}\nBody', 'Alt-Delete in the title deletes to the end of the word')
    })
    await check('in Markdown the same keys are the ordinary keys', async () => {
      assert.equal(await press(RUN, RUN.indexOf('Body'), 'Control+h', 'markdown'), '### Alpha\n{statement}Body text')
    })
  }

  // ── Fifth fix round, item 1: a paragraph's and a list item's icon token ──────────────────
  for (const [what, d, typed] of [
    ['a paragraph', PARA, 'Intro\n\nAlphaX {icon=lucide:star}\n\nNext'],
    ['a list item', LIST, '- AlphaX {icon=lucide:star}\n- Two\n'],
    ['a paragraph of several lines, the token on its last', 'First line\nsecond Alpha {icon=lucide:star}\n\nNext', 'First line\nsecond AlphaX {icon=lucide:star}\n\nNext']
  ]) {
    const at = d.indexOf(' {icon')
    for (const key of isMac ? ['Delete', 'Control+d'] : ['Delete']) {
      await check(`${key} at the end of the text of ${what} that ends in an icon does nothing`, async () => {
        assert.equal(await press(d, at, key, 'plain', true), d)
        assert.equal(await head(), at, 'the caret stays')
      })
    }
    await check(`End then typing at the end of the text of ${what} lands before the icon token`, async () => {
      await open(d)
      await picture()
      await caret(at)
      await page.keyboard.press('End')
      assert.equal(await head(), at, 'End stays at the end of the visible text')
      await page.keyboard.type('X')
      assert.equal(await text(), typed)
      await open(d)
      await picture()
      await caret(at - 3)
      await page.keyboard.press('End')
      assert.equal(await head(), at, 'End from inside the text goes to the end of the visible text')
    })
    await check(`the icon name of ${what} is edited by walking into its chip`, async () => {
      await open(d)
      await picture()
      await caret(at)
      await page.keyboard.press('ArrowRight')
      assert.equal(await head(), at + 1, 'ArrowRight steps to the chip')
      await page.keyboard.press('Backspace')
      assert.equal(await text(), d, 'Backspace before the chip does not take the space')
      for (let i = 0; i < '{icon=lucide:star'.length; i += 1) await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Backspace')
      await page.keyboard.type('y')
      assert.equal(await text(), d.replace('lucide:star', 'lucide:stay'), 'inside the chip the name is edited as text')
    })
  }
  await check('Backspace at the start of the line after a paragraph that ends in an icon does not join them', async () => {
    const d = 'Alpha {icon=lucide:star}\nNext'
    // (Two lines of one paragraph: the token is prose here, nothing is protected, they join.)
    assert.equal(await press(d, d.indexOf('Next'), 'Backspace', 'plain'), 'Alpha {icon=lucide:star}Next')
    const two = '- Alpha {icon=lucide:star}\n- Two\n'
    assert.equal(await press(two, two.indexOf('- Two'), 'Backspace', 'plain', true), two, 'a list item is not joined to the icon before it')
  })

  // ── Fifth fix round, item 2: no key puts the caret on protected text ──────────────────────
  for (const [what, d] of [
    ['', '### Alpha\n{statement}\n'],
    [', with front matter', '---\noutline_version: 2\n---\n# Talk\n\n### Alpha\n{statement}\n'],
    [', with another slide following', '### Alpha\n{statement}\n\n### Beta\nB']
  ]) {
    await check(`Backspace on the empty line under a hidden layout line does nothing${what}`, async () => {
      const at = d.indexOf('{statement}\n') + '{statement}\n'.length
      assert.equal(await press(d, at, 'Backspace'), d, 'the document')
      assert.equal(await head(), at, 'the caret')
      await page.keyboard.press('Backspace')
      assert.equal(await text(), d, 'a second Backspace')
      assert.ok(!(await ev(() => window.shown())).includes('{'), 'the layout line is still hidden')
    })
  }
  await check('the empty line under a hidden layout line cannot be removed with Backspace in Plain; it can in Markdown', async () => {
    const d = '### Alpha\n{statement}\n\nBody'
    const at = d.indexOf('\n\n') + 1
    assert.equal(await press(d, at, 'Backspace', 'plain'), d, 'Plain')
    assert.equal(await press(d, at, 'Backspace', 'markdown'), '### Alpha\n{statement}\nBody', 'Markdown')
    assert.equal(await press(d, at, 'Delete', 'plain'), '### Alpha\n{statement}\nBody', 'Delete on it joins the next line up, in Plain too')
  })
  await check('"Delete line" on the last body line under a hidden layout line does not leave the caret on the layout line', async () => {
    const key = chord('Shift-Mod-k', false)
    const after = await press(RUN, RUN.length - 2, key)
    assert.ok(after.startsWith('### Alpha\n{statement}'), `the layout line is whole: ${JSON.stringify(after)}`)
    assert.deepEqual(await ev(() => window.zones()), [], 'the caret is not on protected text')
    assert.ok(!(await ev(() => window.shown())).includes('{'), 'and the layout line is still hidden')
    const two = RUN + '\nMore'
    assert.equal(await press(two, two.indexOf('Body') + 2, key), '### Alpha\n{statement}\nMore', 'with a line after it, the line is deleted')
    assert.deepEqual(await ev(() => window.zones()), [])
  })

  // ── Fifth fix round, item 3: the dry run has no effect of its own ─────────────────────────
  if (isMac) {
    await check('Shift-Alt-M toggles Tab focus mode once, in Plain as in Markdown', async () => {
      const result = []
      for (const mode of ['markdown', 'plain']) {
        await open(TAIL, mode)
        await caret(6)
        await page.keyboard.press('Shift+Alt+m')
        result.push((await ev(() => window.snap())).tabFocus)
      }
      assert.deepEqual(result, ['on', 'on'])
    })
  }
  {
    // Protected text is in the document (so the guard makes its dry run) and out of the caret's reach.
    const FREE = '# Talk\n\nOne paragraph here.\n\nTwo paragraph here now.\n\nThree paragraph here.\n\nFour.\n\nFive.\n\n### Slide {reveal}\n{statement}\nBody\n'
    for (const [label, at] of [['a paragraph', FREE.indexOf('paragraph here now') + 4], ['the talk\'s title', 4]]) {
      const differs = []
      for (const c of chords) {
        const snaps = []
        for (const mode of ['plain', 'markdown']) {
          await open(FREE, mode)
          await caret(at)
          await page.keyboard.press(c.key)
          snaps.push({ ...(await ev(() => window.snap())), handled: await ev(() => window.handled) })
        }
        // A key no binding handles in either mode is the browser's own caret move (Option-ArrowUp
        // on the first line): it lands by what is drawn, which differs between the modes, and
        // arrives late. Whether it was handled is compared; where it put the caret is not.
        const browsers = snaps[0].handled === false && snaps[1].handled === false
        for (const what of ['handled', 'doc', ...(browsers ? [] : ['sel']), 'tabFocus', 'findOpen', 'folds', 'focus', 'scroll']) {
          if (JSON.stringify(snaps[0][what]) !== JSON.stringify(snaps[1][what])) differs.push(`${c.name} ${what}: Plain ${JSON.stringify(snaps[0][what])}, Markdown ${JSON.stringify(snaps[1][what])}`)
        }
      }
      await check(`every key in ${label}, away from protected text, leaves the text, the selection, Tab focus mode, the Find panel, the folds, the focus and the scroll position as it does in Markdown (${chords.length} keys)`, async () => {
        assert.deepEqual(differs, [])
      })
    }
    await check('the dry run alone changes nothing: text, selection, Tab focus mode, the Find panel, folds, focus, scroll position', async () => {
      const long = FREE + Array.from({ length: 80 }, (_, i) => `\nParagraph ${i} of the long talk.\n`).join('')
      for (const findOpen of [false, true]) {
        await open(long)
        if (findOpen) await page.keyboard.press(`${isMac ? 'Meta' : 'Control'}+f`)
        await ev((pos) => { window.caret(pos); window.__v.scrollDOM.scrollTop = 600 }, long.indexOf('Paragraph 40'))
        if (!findOpen) await ev(() => window.__v.focus())
        // Let the editor finish measuring the scrolled page before it is compared with itself.
        await ev(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 150)))))
        const result = await ev(() => window.dryAll())
        assert.ok(result.ran > 60, `${result.ran} commands were run dry`)
        assert.deepEqual(result.changed, [], findOpen ? 'with the Find panel open' : 'with the editor focused')
        console.log(`  dry run, ${findOpen ? 'Find panel open' : 'editor focused'}: ${result.ran} commands; threw on the stand-in: ${result.threw && result.threw.length ? result.threw.join(', ') : 'none'}`)
      }
    })
  }
  if (process.env.PLAIN_GUARD_SAMPLE) {
    const sample = readFileSync(process.env.PLAIN_GUARD_SAMPLE, 'utf8')
    await open(sample)
    await caret(sample.indexOf('\n', Math.floor(sample.length / 2)) - 3)
    await ev(() => window.cost(20, 10)) // warm
    const cost = await ev(() => window.cost(200, 10))
    console.log(`  guard cost on the sample talk (${cost.lines} lines, ${cost.regions} protected regions; Backspace in a body line, held ${cost.held} times): median ${cost.median.toFixed(3)} ms, worst ${cost.worst.toFixed(3)} ms per key press (200 runs of 10)`)
  }

  // ── Sixth fix round, item 1: Enter ─────────────────────────────────────────────────────────
  const shownText = () => ev(() => window.shown())
  // The compiler decides which `{…}` lines are layout lines. Under the talk's `#` title it removes one
  // only inside a slide (as a stray Trigger line of that slide), so these titles stand under a slide.
  // At the top of the document the line is content for the compiler and is shown (the check after).
  for (const [withFm, fm0] of [['', ''], [', with front matter', '---\nauthor: A\n---\n']]) {
    const fm = `${fm0}## Lead\nIntro\n`
    for (const [what, run] of [['a hidden layout line', '{statement}'], ['a hidden layout line and an id line', '{statement}\n{id=a1}'], ['a layout line that holds an id', '{statement id=a1}']]) {
      for (const [where, off] of [['the end', 7], ['the middle', 4]]) {
        await check(`Enter at ${where} of a level-1 title above ${what}${withFm} puts the caret on the body and changes nothing`, async () => {
          const d = `${fm}# Alpha\n${run}\nBody`
          assert.equal(await press(d, fm.length + off, 'Enter'), d, 'the document')
          assert.equal(await head(), d.indexOf('Body'), 'the caret is at the start of the body line')
          assert.ok(!(await shownText()).includes('{'), 'the layout line is still hidden')
          await page.keyboard.type('X')
          assert.equal(await text(), d.replace('Body', 'XBody'), 'typing goes into the body')
        })
      }
    }
    await check(`Enter on a level-1 title above a hidden layout line makes a body line only when there is none${withFm}`, async () => {
      const last = `${fm}# Alpha\n{statement}`
      assert.equal(await press(last, fm.length + 7, 'Enter'), last + '\n', 'at the document\'s end a line is added')
      assert.equal(await head(), last.length + 1)
      assert.ok(!(await shownText()).includes('{'), 'the layout line is still hidden')
      const next = `${fm}# Alpha\n{statement}\n## Next\nB`
      assert.equal(await press(next, fm.length + 4, 'Enter'), `${fm}# Alpha\n{statement}\n\n## Next\nB`, 'before the next heading a line is added')
      assert.equal(await head(), next.indexOf('## Next'))
      const blank = `${fm}# Alpha\n{statement}\n\nBody`
      assert.equal(await press(blank, fm.length + 7, 'Enter'), blank, 'an empty body line is used as it is')
      assert.equal(await head(), blank.indexOf('\n\n') + 1)
    })
  }
  await check('Enter on a level-1 title with nothing hidden under it splits it as ever', async () => {
    assert.equal(await press('# Alpha\nBody', 4, 'Enter'), '# Al\npha\nBody')
    // Changed in the merge with the quote-forms line: Enter at the END of a `#` title now puts the new line under the `{…}` lines below it (headingEndInsert.ts), in both modes.
    assert.equal(await press('# Alpha\n\n{statement}\nBody', 7, 'Enter'), '# Alpha\n\n{statement}\n\nBody', 'a layout line that is not directly under the title is not hidden')
  })
  // The compiler decides: before the first slide it removes no `{…}` line, so Plain hides none.
  await check('a {…} line under the talk title at the top of the document is content: it is shown, and Enter splits the title as ever', async () => {
    for (const fm of ['', '---\nauthor: A\n---\n']) {
      const d = `${fm}# Alpha\n{statement}\nBody`
      await open(d)
      await caret(d.indexOf('Body'))
      assert.ok((await shownText()).includes('{statement}'), 'the line is shown')
      // Changed in the merge with the quote-forms line: Enter at the END of a `#` title now puts the new line under the `{…}` lines below it (headingEndInsert.ts), in both modes.
      assert.equal(await press(d, fm.length + 7, 'Enter'), `${fm}# Alpha\n{statement}\n\nBody`, 'Enter at the end of the title, as in the Markdown tab')
      assert.equal(await press(d, fm.length + 7, 'Enter', 'markdown'), `${fm}# Alpha\n{statement}\n\nBody`, 'the Markdown tab')
      assert.equal(await press(d, fm.length + 4, 'Enter'), `${fm}# Al\npha\n{statement}\nBody`, 'Enter in its middle')
      const at = d.indexOf('}')
      const plain = await press(d, at + 1, 'Backspace')
      assert.ok(plain !== d, 'Backspace at its end is not held')
      assert.equal(plain, await press(d, at + 1, 'Backspace', 'markdown'), 'and does what it does in the Markdown tab')
    }
  })
  await check('in Markdown, Enter on a level-1 title is as it was: the title is split, also above a layout line', async () => {
    // Changed in the merge with the quote-forms line: Enter at the END of a `#` title now puts the new line under the `{…}` lines below it (headingEndInsert.ts), in both modes.
    assert.equal(await press('# Alpha\n{statement}\nBody', 7, 'Enter', 'markdown'), '# Alpha\n{statement}\n\nBody', 'at its end')
    assert.equal(await press('# Alpha\n{statement}\nBody', 4, 'Enter', 'markdown'), '# Al\npha\n{statement}\nBody', 'in its middle')
    assert.equal(await press('## Alpha\n{statement}\nBody', 5, 'Enter', 'markdown'), '## Alpha\n{statement}\nBody', 'a level-2 title is not split, as ever')
  })
  for (const [what, tail, icon] of [['a hidden option', '{reveal}', false], ['a hidden id', '{id=a1}', false], ['an icon', '{icon=lucide:star}', true]]) {
    await check(`Enter on a level-1 title with ${what} and no layout line goes to the body, as on the other levels`, async () => {
      const d = `# Alpha ${tail}\nBody`
      for (const at of [4, 7]) {
        assert.equal(await press(d, at, 'Enter', 'plain', icon), d, `caret at ${at}: the title is not split and nothing is added`)
        assert.equal(await head(), d.indexOf('Body'), `caret at ${at}: the caret is on the body line`)
        assert.ok(!(await shownText()).includes('{'), 'the tail is hidden')
      }
      const last = `# Alpha ${tail}`
      assert.equal(await press(last, 4, 'Enter', 'plain', icon), last + '\n', 'a body line is made when there is none')
      assert.equal(await head(), last.length + 1)
      const next = `# Alpha ${tail}\n## Next\nB`
      assert.equal(await press(next, 4, 'Enter', 'plain', icon), `# Alpha ${tail}\n\n## Next\nB`, 'and before the next heading')
    })
  }
  await check('Shift+Enter in the middle of a level-1 title with a hidden option is held, as on the other levels', async () => {
    for (const d of ['# Alpha {reveal}\nBody', '### Alpha {reveal}\nBody']) {
      const at = d.indexOf('pha')
      assert.equal(await press(d, at, 'Shift+Enter'), d, 'the title is not split from its option')
      assert.equal(await head(), at, 'the caret stays')
    }
  })
  {
    const KINDS = [
      ['a hidden option', (h) => `${h} Alpha beta {reveal}\nBody`, false],
      ['a hidden layout line', (h) => `${h} Alpha beta\n{statement}\nBody`, false],
      ['a hidden option and a hidden layout line', (h) => `${h} Alpha beta {reveal}\n{statement}\nBody`, false],
      ['an icon only', (h) => `${h} Alpha beta {icon=lucide:star}\nBody`, true],
      ['nothing hidden', (h) => `${h} Alpha beta\nBody`, false]
    ]
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    // Seventh fix round: the same matrix for every way the marks are followed by whitespace.
    for (const [sepName, sep] of [['a space', ' '], ['a tab', '\t'], ['two spaces', '  ']]) {
      const broke = []
      let compared = 0, cases = 0
      for (let level = 1; level <= 6; level += 1) {
        const marks = '#'.repeat(level)
        const h = marks + sep
        const textFrom = h.length
        for (const [kind, make, icon] of KINDS) {
          // (KINDS writes `${h} Alpha…`: the marks, then one space; here the separator stands for that space.)
          // The compiler decides which `{…}` lines are layout lines: under the talk's `#` title one
          // is only inside a slide (it is taken out of that slide), so level 1 stands under a slide.
          const lead = level === 1 ? '### Lead\nIntro\n' : ''
          const d = lead + make('\u0000').replace('\u0000 ', h)
          const before = await ev((t) => window.inventoryFor(t), d)
          for (const [where, at] of [['the start of the text', lead.length + textFrom], ['the middle', lead.length + textFrom + 5], ['the visible end', lead.length + textFrom + 10]]) {
            const label = `${marks} then ${sepName}, with ${kind}, caret at ${where}`
            cases += 1
            const plain = await press(d, at, 'Enter', 'plain', icon)
            const plainHead = await head()
            // No protected region of the original document has changed...
            if (!same(await ev(() => window.inventory()), before)) broke.push(`${label}: protected text changed: ${JSON.stringify(plain)}`)
            // ...or become visible. (An icon's chip shows while the caret rests on its own title.)
            const onTitle = (await ev(() => window.caretLine())).startsWith(h)
            if ((await shownText()).includes('{') && !(icon && onTitle)) broke.push(`${label}: hidden text shows: ${JSON.stringify(await shownText())}`)
            const zones = await ev(() => window.zones())
            if (zones.length && !(plain === d && plainHead === at)) broke.push(`${label}: the caret is on protected text (${zones.map(([k]) => k).join(', ')}) at ${plainHead}`)
            // A title with anything hidden, at every level: it is not split, and the caret is on the body.
            if (kind !== 'nothing hidden' && !(plain === d && plainHead === d.indexOf('Body'))) broke.push(`${label}: Plain ${JSON.stringify(plain)} at ${plainHead}, wanted the caret on the body and no change`)
            // Where the Markdown tab's Enter exposes nothing, Plain's Enter is the same Enter.
            const markdown = await press(d, at, 'Enter', 'markdown')
            const markdownHead = await head()
            if (!same(await ev((t) => window.inventoryFor(t), markdown), before)) continue
            // Ticket 11: a layout line stays hidden wherever it stands, so the Markdown tab's Enter that
            // parts a title from its layout line no longer "exposes" it. On such a title Plain's own
            // rule decides (asserted above: no change, the caret on the body), not the Markdown tab's.
            if (kind.includes('layout line') && markdown !== d) continue
            compared += 1
            if (plain !== markdown || plainHead !== markdownHead) broke.push(`${label}: Plain ${JSON.stringify(plain)} at ${plainHead}, Markdown ${JSON.stringify(markdown)} at ${markdownHead}`)
          }
        }
      }
      await check(`Enter in a title written with ${sepName} after its marks, every level, with a hidden option, layout line, icon or nothing, at the start, middle and visible end of its text (${cases} cases)`, async () => {
        assert.deepEqual(broke, [])
        assert.equal(cases, 90)
        // (With a tab the Markdown tab's own title rule does not apply, so fewer of its Enters expose nothing.)
        if (sep === ' ') assert.ok(compared >= 60, `${compared} of them are the Markdown tab's Enter`)
        else assert.ok(compared >= 18, `${compared} of them are the Markdown tab's Enter`)
      })
    }
  }
  await check('Enter away from hidden text is the ordinary Enter', async () => {
    assert.equal(await press(RUN, RUN.length, 'Enter'), RUN + '\n', 'at the end of a body paragraph')
    assert.equal(await head(), RUN.length + 1)
    assert.equal(await press(RUN, RUN.indexOf('Body'), 'Enter'), '### Alpha\n{statement}\n\nBody text', 'at the start of the body line under a hidden layout line')
    assert.ok(!(await shownText()).includes('{'), 'the layout line is still hidden')
    assert.equal(await press('- One\n- Two\n', 5, 'Enter'), '- One\n- \n- Two\n', 'in a list the list goes on')
    assert.equal(await press(LIST, LIST.indexOf(' {icon'), 'Enter', 'plain', true), '- Alpha {icon=lucide:star}\n- \n- Two\n', 'at the end of the text of a list item with an icon')
    assert.equal(await press(PARA, PARA.indexOf('pha {icon'), 'Enter', 'plain', true), 'Intro\n\nAl\npha {icon=lucide:star}\n\nNext', 'in the middle of a paragraph with an icon')
    assert.equal(await press(PARA, PARA.indexOf(' {icon'), 'Enter', 'plain', true), 'Intro\n\nAlpha {icon=lucide:star}\n\n\nNext', 'at the end of the text of a paragraph with an icon')
    assert.equal(await press(FM, FM.indexOf('# Talk'), 'Enter'), '---\nauthor: A\n---\n\n# Talk\nBody', 'at the start of the first line under the Talk details panel')
  })

  // ── The other side: visible text is edited as ever ─────────────────────────────────────────
  await check('Backspace at the start of a paragraph that follows a visible paragraph joins them', async () => {
    const d = '### Alpha\n{statement}\nOne\nTwo'
    assert.equal(await press(d, d.indexOf('Two'), 'Backspace'), '### Alpha\n{statement}\nOneTwo')
  })
  {
    const PLAINDOC = '### Alpha beta gamma\n{statement}\nBody text here now\nMore text\n'
    const spots = [['the middle of a body line', PLAINDOC.indexOf('text here') + 2], ['the middle of a title over a hidden layout line', PLAINDOC.indexOf('beta') + 2]]
    for (const [label, at] of spots) {
      const differs = []
      let edits = 0
      for (const c of chords) {
        const plain = await press(PLAINDOC, at, c.key, 'plain')
        const markdown = await press(PLAINDOC, at, c.key, 'markdown')
        // A key that in Markdown parts the layout line from its heading is held in Plain.
        const held = plain === PLAINDOC && !/^#{1,6} [^\n{}]*\n\{statement\}\n/m.test(markdown)
        if (plain !== markdown && !held) differs.push(`${c.name}: Plain ${JSON.stringify(plain)}, Markdown ${JSON.stringify(markdown)}`)
        if (plain !== PLAINDOC) edits += 1
      }
      await check(`every key does in ${label} what it does in Markdown, or is held where Markdown would part the layout line from its heading`, async () => {
        assert.deepEqual(differs, [])
        assert.ok(edits >= 8, `${edits} of the keys changed the text there`)
      })
    }
    // A title with a hidden option: the keys that delete to the line's end stop at the option
    // (above); every other key is the ordinary key.
    const TITLED = '### Alpha beta {reveal}\nBody'
    const cut = '### Alpha b {reveal}\nBody'
    const differs = []
    for (const c of chords) {
      const plain = await press(TITLED, 11, c.key, 'plain')
      const markdown = await press(TITLED, 11, c.key, 'markdown')
      const held = plain === TITLED && !/^#{1,6} [^\n{}]* \{reveal\}\n/m.test(markdown)
      if (plain !== markdown && plain !== cut && !held) differs.push(`${c.name}: Plain ${JSON.stringify(plain)}, Markdown ${JSON.stringify(markdown)}`)
    }
    await check('every key in the middle of a title with a hidden option is the ordinary key, or stops at the option', async () => {
      assert.deepEqual(differs, [])
    })
    const deleting = isMac
      ? ['Backspace', 'Delete', 'Control+h', 'Control+d', 'Alt+Backspace', 'Alt+Delete', 'Control+k', 'Meta+Backspace', 'Meta+Delete', 'Control+Alt+h']
      : ['Backspace', 'Delete', 'Control+Backspace', 'Control+Delete']
    for (const key of deleting) {
      await check(`${key} still deletes in the middle of a body line and of a title`, async () => {
        const body = await press(PLAINDOC, spots[0][1], key)
        assert.ok(body.length < PLAINDOC.length && body.includes('{statement}'), `body: ${JSON.stringify(body)}`)
        const title = await press(TITLED, 11, key)
        assert.ok(title.length < TITLED.length && title.includes(' {reveal}\n'), `title: ${JSON.stringify(title)}`)
      })
    }
  }

  // ── A title's icon group is part of its one hidden tail ────────────────────────────────────
  await check('Backspace at the start of the body under a title whose only hidden group is an icon does nothing', async () => {
    assert.equal(await press(ICON, ICON.indexOf('Body'), 'Backspace', 'plain', true), ICON)
  })
  for (const [label, tail] of [
    ['an icon then an option', '{icon=lucide:star} {reveal}'], ['an icon then an id', '{icon=lucide:star} {id=a1}'],
    ['an option then an icon', '{reveal} {icon=lucide:star}'], ['an id then an icon', '{id=a1} {icon=lucide:star}'],
    ['an icon alone', '{icon=lucide:star}']
  ]) {
    const d = `### Alpha ${tail}\nBody`
    await check(`End then typing stays before the hidden groups (${label})`, async () => {
      await open(d)
      await picture()
      await caret(9)
      await page.keyboard.press('End')
      assert.equal(await head(), 9, 'End stays at the end of the visible text')
      await page.keyboard.type('X')
      assert.equal(await text(), `### AlphaX ${tail}\nBody`)
    })
    await check(`End from the middle of the title, and Delete at its end (${label})`, async () => {
      await open(d)
      await picture()
      await caret(6)
      await page.keyboard.press('End')
      assert.equal(await head(), 9)
      await page.keyboard.press('Delete')
      assert.equal(await text(), d, 'Delete at the end of the text takes neither the space nor a token')
    })
    // The app's token protection makes a title's `{…}` group one unit for the caret (in Markdown
    // too): it is stepped over whole and one Backspace after it removes it whole.
    await check(`the caret steps to the icon's chip, and Backspace after the chip removes the icon (${label})`, async () => {
      await open(d)
      await picture()
      await caret(9)
      await page.keyboard.press('ArrowRight')
      const chip = d.indexOf('{icon=')
      assert.equal(await head(), chip, 'ArrowRight from the end of the text goes to the chip')
      assert.ok((await ev(() => window.shown())).includes('{icon=lucide:star}'), 'the chip shows')
      await page.keyboard.press('Backspace')
      assert.equal(await text(), d, 'Backspace before the chip takes neither the space nor the group before it')
      await page.keyboard.press('ArrowRight')
      assert.equal(await head(), chip + '{icon=lucide:star}'.length, 'the next step is the end of the chip')
      await page.keyboard.press('Delete')
      assert.equal(await text(), d, 'Delete after the chip takes nothing that follows it')
      await page.keyboard.press('Backspace')
      const rest = tail.replace('{icon=lucide:star}', '').trim()
      const after = await text()
      assert.ok(!after.includes('icon=') && after.startsWith('### Alpha') && after.replace(/ +\n/, '\n').endsWith(`${rest}\nBody`), `the icon token is gone and the rest stays: ${JSON.stringify(after)}`)
      await page.keyboard.press('End')
      await page.keyboard.type('X')
      // (One space stays with the title when two were left before the next group.)
      assert.ok(/^### Alpha ?X( \{|\n)/.test(await text()), `typing after End is in the title: ${JSON.stringify(await text())}`)
    })
    await check(`ArrowRight from the end of the chip goes on to the next line (${label})`, async () => {
      await open(d)
      await picture()
      await caret(9)
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      assert.equal(await head(), d.indexOf('Body'))
      await page.keyboard.type('X')
      assert.equal(await text(), d.replace('Body', 'XBody'))
    })
  }
  // ── Sixth fix round, item 2: an icon belongs to its text ───────────────────────────────────
  {
    const STAR_TOKEN = '{icon=lucide:star}'
    const UNDO = chord('Mod-z', false)
    const hidden = async () => !(await shownText()).includes('{')
    /** Mount, wait for the picture, put the caret, press the keys in turn. */
    const keysAt = async (doc, at, ...keys) => {
      await open(doc)
      await picture()
      await caret(at)
      for (const key of keys) await page.keyboard.press(key)
      return text()
    }
    await check('Backspace after the one character of a paragraph that ends in an icon takes the character, the space and the icon (the review\'s input)', async () => {
      const d = `### Slide\n\nA ${STAR_TOKEN}`
      await open(d)
      await picture()
      await caret(d.indexOf('A'))
      await page.keyboard.press('End')
      assert.equal(await head(), d.indexOf('A') + 1, 'End is the end of the visible text')
      await page.keyboard.press('Backspace')
      assert.equal(await text(), '### Slide\n\n', 'the paragraph is empty')
      assert.equal(await head(), '### Slide\n\n'.length, 'the caret is where the text was')
      assert.ok(await hidden(), 'no token shows')
      await page.keyboard.press(UNDO)
      assert.equal(await text(), d, 'one Undo restores the text and the token')
      assert.equal(await ev(() => window.undoDepth()), 0, 'it was one step')
    })
    await check('the same in a list item: the list mark stays', async () => {
      assert.equal(await keysAt(`- A ${STAR_TOKEN}\n- Two\n`, 3, 'Backspace'), '- \n- Two\n')
      assert.equal(await head(), 2, 'the caret is after the mark')
      await page.keyboard.press(UNDO)
      assert.equal(await text(), `- A ${STAR_TOKEN}\n- Two\n`, 'one Undo restores the text and the token')
      assert.equal(await keysAt(`1. A ${STAR_TOKEN}\n2. Two\n`, 4, 'Backspace'), '1. \n2. Two\n', 'a numbered item')
      // (A nested item's token is drawn as a chip, with no picture to wait for.)
      assert.equal(await press(`Intro\n\n- One\n  - A ${STAR_TOKEN}\n`, `Intro\n\n- One\n  - A`.length, 'Backspace'), 'Intro\n\n- One\n  - \n', 'a nested item')
    })
    await check('Delete at the start of a one-character text takes the text, the space and the icon', async () => {
      assert.equal(await keysAt(`Intro\n\nA ${STAR_TOKEN}\n\nNext`, 7, 'Delete'), 'Intro\n\n\n\nNext', 'a paragraph')
      assert.equal(await head(), 7)
      await page.keyboard.press(UNDO)
      assert.equal(await text(), `Intro\n\nA ${STAR_TOKEN}\n\nNext`, 'one Undo restores the text and the token')
      assert.equal(await keysAt(`- A ${STAR_TOKEN}\n- Two\n`, 2, 'Delete'), '- \n- Two\n', 'a list item')
      assert.equal(await head(), 2)
    })
    await check('a text of two characters loses one and keeps its icon; the second press takes the rest, and each press is one Undo', async () => {
      const d = `Intro\n\nGo ${STAR_TOKEN}\n\nNext`
      assert.equal(await keysAt(d, 9, 'Backspace'), `Intro\n\nG ${STAR_TOKEN}\n\nNext`, 'the first Backspace')
      assert.ok(await ev(() => window.pictures()) > 0, 'the picture is still drawn')
      await page.keyboard.press('Backspace')
      assert.equal(await text(), 'Intro\n\n\n\nNext', 'the second Backspace')
      await page.keyboard.press(UNDO)
      assert.equal(await text(), `Intro\n\nG ${STAR_TOKEN}\n\nNext`, 'the first Undo restores the last character and the token')
      await page.keyboard.press(UNDO)
      assert.equal(await text(), d, 'the second Undo restores the other character')
      assert.equal(await keysAt(d, 7, 'Delete'), `Intro\n\no ${STAR_TOKEN}\n\nNext`, 'Delete from the start')
      assert.equal(await keysAt(`- Go ${STAR_TOKEN}\n`, 4, 'Backspace'), `- G ${STAR_TOKEN}\n`, 'a list item')
    })
    await check('a paragraph of several lines: the rule is for the whole paragraph\'s text', async () => {
      const first = `Intro\n\nA\nTwo ${STAR_TOKEN}\n\nNext`
      assert.equal(await keysAt(first, 8, 'Backspace'), `Intro\n\n\nTwo ${STAR_TOKEN}\n\nNext`, 'the one character of its first line goes; the icon stays with the rest')
      assert.ok(await hidden(), 'the token is still hidden')
    })
    // The one character of a paragraph's LAST line, when the paragraph has other text: the line
    // break goes with it, and the token joins the line above with one space before it.
    const lexer = await import('../compiler/scripts/lib/03-markdown-lexer.mjs')
    const iconOf = (doc, textOfParagraph) => lexer.lexMarkdownBlocks(doc.split('\n')).find((b) => b.type === 'paragraph' && b.text === textOfParagraph)?.icon ?? null
    for (const [what, above, joined, compiled] of [
      ['a paragraph of two lines', 'One', 'One', 'One'],
      ['a paragraph of three lines', 'One\nTwo', 'One\nTwo', 'One Two'],
      ['a line above that ends in spaces', 'One   ', 'One', 'One']
    ]) {
      for (const [key, off] of [['Backspace', 1], ['Delete', 0]]) {
        await check(`${key} on the one character of the last line of ${what} joins the icon to the line above`, async () => {
          const d = `Intro\n\n${above}\nA ${STAR_TOKEN}\n\nNext`
          const want = `Intro\n\n${joined} ${STAR_TOKEN}\n\nNext`
          assert.equal(await keysAt(d, d.indexOf('\nA ') + 1 + off, key), want, 'the character and the line break are gone; one space before the token')
          assert.equal(await head(), `Intro\n\n${joined}`.length, 'the caret is at the end of the text above')
          assert.equal(iconOf(want, compiled), 'lucide:star', 'the compiled paragraph still carries the icon')
          assert.deepEqual(await ev(() => window.inventory()), await ev((t) => window.inventoryFor(t), d), 'the token is protected as it was')
          await page.keyboard.press(UNDO)
          assert.equal(await text(), d, 'one Undo restores it byte for byte')
          assert.equal(await ev(() => window.undoDepth()), 0, 'it was one step')
        })
      }
    }
    await check('a last line of two characters loses one and stays a line; a list item\'s indented line that ends in an icon is a paragraph of its own', async () => {
      const two = `Intro\n\nOne\nAB ${STAR_TOKEN}\n\nNext`
      assert.equal(await keysAt(two, two.indexOf('AB ') + 2, 'Backspace'), `Intro\n\nOne\nA ${STAR_TOKEN}\n\nNext`)
      // (List items do not span lines for the icon reader: the indented line is read alone.)
      const item = `- One\n  A ${STAR_TOKEN}\n- Two\n`
      assert.equal(await keysAt(item, item.indexOf('A ') + 1, 'Backspace'), '- One\n  \n- Two\n')
    })
    await check('the icon is not taken while visible text is left', async () => {
      assert.equal(await keysAt(`AB ${STAR_TOKEN}`, 1, 'Delete'), `A ${STAR_TOKEN}`)
      assert.equal(await keysAt(`A B ${STAR_TOKEN}`, 3, 'Backspace'), `A  ${STAR_TOKEN}`, 'a space before the last character is not all that is left')
    })
    // Titles are different: the tokens stay when the text is emptied.
    for (let level = 1; level <= 6; level += 1) {
      const h = '#'.repeat(level)
      for (const [what, tail, icon] of [['a hidden option', '{reveal}', false], ['an icon', STAR_TOKEN, true], ['an icon and an id', `${STAR_TOKEN} {id=a}`, true]]) {
        for (const [key, off] of [['Backspace', 1], ['Delete', 0]]) {
          await check(`${key} empties the text of a ${h} title with ${what}: the tokens stay hidden, and typing is the title's text`, async () => {
            const d = `${h} A ${tail}\nBody`
            await open(d)
            if (icon) await picture()
            await caret(level + 1 + off)
            await page.keyboard.press(key)
            const emptied = await text()
            assert.ok(emptied.endsWith(` ${tail}\nBody`) && !emptied.includes('A'), `the text is gone and the tokens stay: ${JSON.stringify(emptied)}`)
            assert.equal(await head(), level + 1, 'the caret is where the text was')
            // (An icon's chip shows while the caret rests at the end of its title's text, as on any title.)
            const shows = async () => (await shownText()).replace(STAR_TOKEN, '')
            assert.ok(!(await shows()).includes('{'), `nothing shows but the icon's chip: ${JSON.stringify(await shownText())}`)
            assert.deepEqual(await ev(() => window.inventory()), await ev((t) => window.inventoryFor(t), d), 'every token is protected as it was')
            await page.keyboard.type('X')
            assert.equal(await text(), `${h} X ${tail}\nBody`, 'typing puts the character before the separating space')
            assert.ok(!(await shows()).includes('{'), 'and nothing shows after it')
            await caret((await text()).indexOf('Body'))
            assert.ok(await hidden(), `with the caret away nothing shows at all: ${JSON.stringify(await shownText())}`)
          })
        }
      }
    }
  }
  // ── Seventh fix round, item 2: one reader of heading lines ─────────────────────────────────
  await check('the review\'s input: Enter at the end of a title written with a tab, above a hidden layout line, goes to the body', async () => {
    // (The compiler decides: the layout line is one inside a slide, so the title stands under a slide.)
    const lead = '## Lead\nIntro\n'
    const d = `${lead}#\tAlpha\n{statement}\nBody`
    await open(d)
    await caret(lead.length + 4)
    await page.keyboard.press('End')
    assert.equal(await head(), lead.length + 7, 'End is the end of the title')
    await page.keyboard.press('Enter')
    assert.equal(await text(), d, 'the document is unchanged')
    assert.equal(await head(), d.indexOf('Body'), 'the caret is on the body line')
    assert.ok(!(await shownText()).includes('{'), 'the layout line is still hidden')
  })
  await check('a line the compiler does not read as a heading is not one in Plain: leading spaces, marks alone', async () => {
    for (const first of ['   ## Alpha', ' # Alpha', '#', '##']) {
      const d = `${first}\n{statement}\nBody`
      const markdown = await press(d, first.length, 'Enter', 'markdown')
      const markdownHead = await head()
      assert.ok(markdown !== d && markdown.endsWith('\n{statement}\nBody'), `${JSON.stringify(first)}: the Markdown tab's Enter makes a line: ${JSON.stringify(markdown)}`)
      assert.equal(await press(d, first.length, 'Enter'), markdown, `${JSON.stringify(first)}: Enter is the ordinary Enter, as in the Markdown tab`)
      assert.equal(await head(), markdownHead)
      await open(d)
      await caret(d.indexOf('Body'))
      assert.ok((await shownText()).includes('{statement}'), `${JSON.stringify(first)}: the line under it is not a hidden layout line`)
    }
  })
  await check('marks and a space with no text yet (a title being typed) are a heading: its layout line is hidden and Enter goes to the body', async () => {
    // The compiler decides: it reads no heading on such a line, so the `{…}` line under it is a layout
    // line where the compiler takes it out of the slide above, and content (shown) before the first slide.
    const lead = '### Lead\nIntro\n'
    for (const first of ['# ', '## ', '###\t']) {
      const top = `${first}\n{statement}\nBody`
      await open(top)
      await caret(top.indexOf('Body'))
      assert.ok((await shownText()).includes('{statement}'), `${JSON.stringify(first)}: before the first slide the line is shown`)
      const d = lead + top
      assert.equal(await press(d, lead.length + first.length, 'Enter'), d, `${JSON.stringify(first)}: the document is unchanged`)
      assert.equal(await head(), d.indexOf('Body'), `${JSON.stringify(first)}: the caret is on the body line`)
      assert.ok(!(await shownText()).includes('{'), 'the layout line is hidden')
    }
  })
  {
    // The plain view's reader of heading lines against the compiler's outline parser.
    const { parseOutlineTree } = await import('../compiler/scripts/lib/14-outline-tree.mjs')
    const LINES = [
      '# Alpha', '#\tAlpha', '#  Alpha', '#\t \tAlpha', ' # Alpha', '   # Alpha', '#', '#Alpha', '# Alpha #', '# Alpha',
      '## Beta', '##\tBeta', '##   Beta', ' ## Beta', '   ## Beta', '\t## Beta', '##', '##Beta', '## Beta ##', '## #', '## Beta',
      '### C', '####\tD', '##### E', '######\tF', '###### F', '####### G', '#######\tG', '##  ', '##\t\t', '#  '
    ]
    // Marks and ONE whitespace character with nothing after: a title being typed. The editor reads
    // a heading (empty), the compiler does not (the one difference, stated in the reader's file).
    const TYPED = ['# ', '## ', '###\t', '###### ']
    await check(`the plain view reads a heading line as the compiler does (${LINES.length} lines)`, async () => {
      for (const line of LINES) {
        const got = await ev((t) => window.headingLine(t), line)
        const tree = parseOutlineTree(`---\ntitle: T\n---\n${line}\nBody\n`)
        const node = tree.root.children[0] ?? null
        // The talk title makes no node; the parser's own test for it is the one in its source.
        const title = /^#\s+(.+)/.test(line) && !line.startsWith('##')
        const want = node ? node.level : title ? 1 : 0
        assert.equal(got ? got.level : 0, want, `${JSON.stringify(line)}: level`)
        if (!got) continue
        assert.equal(got.textFrom, line.match(/^#{1,6}\s+/)[0].length, `${JSON.stringify(line)}: where the text starts`)
        if (node) assert.equal(line.slice(got.textFrom).trim(), node.title, `${JSON.stringify(line)}: the text`)
      }
      for (const line of TYPED) {
        const got = await ev((t) => window.headingLine(t), line)
        assert.ok(got && got.empty, `${JSON.stringify(line)} is an empty heading in the editor`)
        assert.equal(parseOutlineTree(`${line}\nBody\n`).root.children.length, 0, `${JSON.stringify(line)} makes no slide`)
      }
    })
  }

  // ── Seventh fix round, item 1: the caret after Undo, and after anything that passes no filter ──
  {
    const UNDO = chord('Mod-z', false)
    const REDO = chord('Mod-Shift-z', false)
    const TOKEN = '{icon=lucide:star}'
    const settles = () => ev(() => window.settles())
    /** One key press or other action; the settling listener may dispatch once for it, never more. */
    const act = async (label, fn) => {
      const n = await settles()
      await fn()
      const made = (await settles()) - n
      assert.ok(made <= 1, `${label}: the listener dispatched ${made} times for one action`)
      return made
    }
    const key = (k) => act(k, () => page.keyboard.press(k))
    // [what, the document, the end of the visible text, has a picture]
    const INPUTS = [
      ['a level-1 title with a hidden option on the document\'s last line (the review\'s input)', '# Alpha {reveal}', 7, false],
      ['a level-3 title with a hidden option, on the last line', '### Alpha {reveal}', 9, false],
      ['a level-3 title with a hidden option, before another title', '### Alpha {reveal}\n### Beta\nB', 9, false],
      ['a level-3 title with an icon, on the last line', `### Alpha ${TOKEN}`, 9, true],
      ['a paragraph that ends in an icon', `Alpha ${TOKEN}`, 5, true],
      ['a paragraph that ends in an icon, with text after it', `Intro\n\nAlpha ${TOKEN}\n\nNext`, 12, true],
      ['a list item that ends in an icon', `- Alpha ${TOKEN}\n- Two\n`, 7, true]
    ]
    for (const [what, d, textEnd, icon] of INPUTS) {
      await check(`Enter then Undo on ${what}: the caret is at the end of the visible text, and typing lands before the token`, async () => {
        await open(d)
        if (icon) await picture()
        const inventory = await ev(() => window.inventory())
        await caret(textEnd - 2)
        await key('End')
        assert.equal(await head(), textEnd, 'End is the end of the visible text')
        await key('Enter')
        const entered = await text()
        const enteredHead = await head()
        assert.notEqual(entered, d, 'Enter changed the document')
        assert.ok(entered.includes(d.split('\n').find((l) => l.includes('{'))), 'the line with the token is whole')
        assert.equal(await ev(() => window.undoDepth()), 1, 'Enter is one step of history (no caret move of its own before it)')
        const settledForUndo = await key(UNDO)
        assert.equal(await text(), d, 'Undo restores the document')
        assert.equal(await head(), textEnd, 'and the caret is at the end of the visible text')
        assert.equal(settledForUndo, 0, 'which is the caret history kept: nothing had to put it back')
        await key(REDO)
        assert.equal(await text(), entered, 'Redo makes the line again')
        // (History keeps no caret for Redo: it maps the caret the change started from through the
        // change, and that caret, the end of the visible text, is before the new line.)
        assert.ok([enteredHead, textEnd].includes(await head()), `with the caret on it or at the end of the visible text: ${await head()}`)
        assert.deepEqual(await ev(() => window.zones()), [], 'and not on protected text')
        await key(UNDO)
        assert.equal(await text(), d, 'Undo again restores the document')
        assert.equal(await head(), textEnd, 'and the caret is at the end of the visible text again')
        await act('typing', () => page.keyboard.type('X'))
        assert.equal(await text(), d.slice(0, textEnd) + 'X' + d.slice(textEnd), 'X lands before the separating space')
        await key('Backspace')
        assert.equal(await text(), d, 'Backspace takes the X and nothing of the token')
        assert.deepEqual(await ev(() => window.inventory()), inventory, 'the token is protected as it was')
        await key('Delete')
        assert.equal(await text(), d, 'Delete there is held')
      })
    }
    await check('Undo after a paste at the end of a title\'s text: the caret is back at the end of the text', async () => {
      const d = '### Alpha {reveal}\nBody'
      await open(d)
      await caret(9)
      await act('paste', () => ev(() => window.raw({ changes: { from: 9, insert: ' and\nmore' }, selection: { anchor: 18 }, userEvent: 'input.paste' })))
      assert.equal(await text(), '### Alpha and\nmore {reveal}\nBody')
      await key(UNDO)
      assert.equal(await text(), d)
      assert.equal(await head(), 9)
      await act('typing', () => page.keyboard.type('X'))
      assert.equal(await text(), '### AlphaX {reveal}\nBody')
    })
    for (const [what, d, textEnd] of [
      ['a title\'s icon', `### Alpha ${TOKEN}\nBody`, 9],
      ['a paragraph\'s icon', `Alpha ${TOKEN}\n\nNext`, 5],
      ['a list item\'s icon', `- Alpha ${TOKEN}\n- Two\n`, 7]
    ]) {
      await check(`Undo of a change made by code while the caret was inside ${what}: the caret is put at the end of the visible text`, async () => {
        await open(d)
        await picture()
        await caret(textEnd)
        // The person steps into the chip: that caret is theirs and stays.
        assert.equal(await key('ArrowRight'), 0, 'stepping into the chip is not settled')
        assert.equal(await key('ArrowRight'), 0)
        const inside = await head()
        assert.ok(inside > textEnd + 1 && (await ev(() => window.zones())).some(([, byHand]) => byHand), `the caret is in the chip, at ${inside}`)
        // The app's own code changes the document elsewhere; the caret is where it was.
        assert.equal(await act('a change by code', () => ev(() => window.raw({ changes: { from: window.__v.state.doc.length, insert: '\nMore' } }))), 0)
        assert.equal(await head(), inside, 'a change elsewhere leaves the caret in the chip')
        await caret((await text()).indexOf('More'))
        // Undo restores the selection that change started from, with no filter: inside the token.
        assert.equal(await key(UNDO), 1, 'the listener put the caret back, once')
        assert.equal(await text(), d)
        assert.equal(await head(), textEnd, 'the caret is at the end of the visible text, not in the token')
        await act('typing', () => page.keyboard.type('X'))
        assert.equal(await text(), d.slice(0, textEnd) + 'X' + d.slice(textEnd), 'X lands before the separating space')
        await key('Backspace')
        await key('Delete')
        assert.equal(await text(), d, 'Backspace takes the X, Delete is held: the token is whole')
      })
    }
    await check('a transaction that passes no filter and leaves the caret in hidden text is followed by one that settles it', async () => {
      for (const [what, d, at, rest, icon] of [
        ['inside a title\'s hidden option', '### Alpha {reveal}\nBody', 13, 9, false],
        ['after a title\'s hidden option', '### Alpha {reveal}\nBody', 18, 9, false],
        ['between a title\'s text and its option', '### Alpha {reveal}\nBody', 10, 9, false],
        ['inside a paragraph\'s icon token', `Alpha ${TOKEN}\n\nNext`, 10, 5, true],
        ['inside a list item\'s icon token', `- Alpha ${TOKEN}\n- Two\n`, 12, 7, true],
        ['in the front matter under the Talk details panel', FM, 6, FM.indexOf('# Talk'), false]
      ]) {
        await open(d)
        if (icon) await picture()
        await caret(d.length)
        const depth = await ev(() => window.undoDepth())
        assert.equal(await act(what, () => ev((p) => window.raw({ selection: { anchor: p }, filter: false }), at)), 1, `${what}: settled once`)
        assert.equal(await head(), rest, `${what}: the caret is at the settle point`)
        assert.equal(await ev(() => window.undoDepth()), depth, `${what}: nothing was added to history`)
        // With a change in the same transaction, as Undo's are.
        await caret(0)
        assert.equal(await act(what, () => ev((p) => window.raw({ changes: { from: window.__v.state.doc.length, insert: '\nZ' }, selection: { anchor: p }, filter: false }), at)), 1, `${what}, with a change: settled once`)
        assert.equal(await head(), rest, `${what}, with a change: the caret is at the settle point`)
      }
    })
    await check('what the listener leaves alone: composition, a caret already at the settle point, a layout line typed by hand, a token typed by hand', async () => {
      await open('### Alpha {reveal}\nBody')
      assert.equal(await act('composition', () => ev(() => window.raw({ selection: { anchor: 13 }, userEvent: 'input.type.compose', filter: false }))), 0, 'a composing transaction is not followed by another')
      assert.equal(await head(), 13)
      await open('### Alpha {reveal}\nBody')
      assert.equal(await act('at rest', () => ev(() => window.raw({ selection: { anchor: 9 }, filter: false }))), 0, 'the end of the visible text is no zone')
      assert.equal(await head(), 9)
      // A layout line typed by hand under a title stays the caret's.
      const d = '### Alpha\n\nBody'
      await open(d)
      await caret(10)
      const before = await settles()
      await page.keyboard.type('{statement}')
      assert.equal(await text(), '### Alpha\n{statement}\nBody')
      assert.equal(await head(), 21, 'the caret is at the end of the line it typed')
      assert.equal(await settles(), before, 'and the listener did not dispatch')
      // An icon token typed by hand at the end of a paragraph: the caret stays after its `}`.
      await open('Alpha\n\nNext')
      await caret(5)
      const n = await settles()
      await page.keyboard.type(` ${TOKEN}`)
      assert.equal(await text(), `Alpha ${TOKEN}\n\nNext`)
      assert.equal(await head(), 6 + TOKEN.length, 'the caret is after the token it typed')
      assert.equal(await settles(), n, 'and the listener did not dispatch')
    })
  }
  // ── Eighth review, Spec 1: a heading's hidden tail is what the compiler takes off the title ──
  {
    const { parseHeadingAttrs, headingBraceGroups: compilerGroups } = await import('../compiler/scripts/lib/02-triggers-layout.mjs')
    const { lexMarkdownBlocks, paragraphIconTokenAt } = await import('../compiler/scripts/lib/03-markdown-lexer.mjs')
    const { parseOutlineTree } = await import('../compiler/scripts/lib/14-outline-tree.mjs')
    const fixtureLines = JSON.parse(readFileSync(join(root, 'scripts/fixtures/plain-view-icon-token-lines.json'), 'utf8'))
    /** What the compiler makes of a heading line: its title, its options, and the ranges (in the line) of the groups it takes off. */
    const compiled = (line) => {
      const offset = line.match(/^#{1,6}\s+/)[0].length
      const raw = line.slice(offset)
      const parsed = parseHeadingAttrs(raw)
      const groups = compilerGroups(raw).map((g) => [g.start + offset, g.end + offset])
      return { title: parsed.title, attrs: parsed.attrs, groups, offset }
    }
    const typeAtEnd = async (d, at, mode) => {
      await open(d, mode)
      await caret(at)
      await page.keyboard.press('End')
      await page.keyboard.type('X')
      return text()
    }
    const unspaced = (t) => t.replace(/\s+/g, '')

    await check(`on every heading line of the parity fixture, Plain protects the ranges the compiler consumes and shows none of them (${fixtureLines.headings.length} lines)`, async () => {
      let withGroups = 0, unauthored = 0
      for (const line of fixtureLines.headings) {
        const want = compiled(line)
        // The compiler's group reader is what its title parser peels: the line without those ranges is the title.
        let rest = line
        for (const [from, to] of [...want.groups].reverse()) rest = rest.slice(0, from) + rest.slice(to)
        assert.equal(rest.slice(want.offset).trim(), want.title, `${JSON.stringify(line)}: the compiler's groups are what it takes off the title`)
        const d = `${line}\nBody`
        const got = await ev((t) => window.tailRanges(t), d)
        assert.deepEqual(got.map(([from, to]) => [from, to]), want.groups, `${JSON.stringify(line)}: the protected ranges`)
        if (!want.groups.length) continue
        withGroups += 1
        // Drawn with the caret elsewhere: no protected group shows as text. (One kept exception: an
        // authored icon group with no name, {icon=}, the state a name is retyped from; it is the
        // title's icon group, and the caret steps into it.)
        const tree = parseOutlineTree(line.startsWith('# ') ? `${line}\n\n## S\n` : `# T\n\n${line}\n\nBody.\n`)
        const icon = line.startsWith('# ') ? tree.deckTitleIcon?.icon : tree.root.children[0]?.titleIcon
        await open(d)
        await caret(d.length)
        const shown = await ev(() => window.shownLine(0))
        for (const [from, to, titleIcon] of got) {
          if (titleIcon && !icon) continue
          if (!titleIcon && /icon\s*=/.test(line.slice(from, to))) unauthored += 1
          assert.ok(!shown.includes(line.slice(from, to)), `${JSON.stringify(line)}: ${line.slice(from, to)} is hidden; shown: ${JSON.stringify(shown)}`)
        }
        // End, then a letter: the letter joins the title the compiler reads, and the options are as
        // they were. (Where several spaces come before the groups, all but one stay with the text.)
        const typed = (await typeAtEnd(d, 0, 'plain')).split('\n')[0]
        const after = compiled(typed)
        assert.equal(unspaced(after.title), unspaced(want.title + 'X'), `${JSON.stringify(line)}: a letter typed at End is the end of the compiled title; the line is ${JSON.stringify(typed)}`)
        assert.deepEqual(after.attrs, want.attrs, `${JSON.stringify(line)}: and the options are unchanged`)
      }
      assert.ok(withGroups >= 25 && unauthored >= 4, `${withGroups} lines with groups, ${unauthored} icon groups that are not the title's icon`)
    })

    // The review's input. The compiler takes the escaped group off the title (the slide's title is
    // "Use literal \" and its options hold icon=lucide:bike); it is no title icon. Plain hides it,
    // as it hides {reveal}, and as it did before icons on titles.
    const REVIEW = '### Use literal \\{icon=lucide:bike}\nBody'
    const reviewEnd = REVIEW.indexOf('{')
    await check('the review\'s input: an escaped icon group on a heading is hidden, not shown as text the caret is kept out of', async () => {
      const want = compiled(REVIEW.split('\n')[0])
      assert.equal(want.title, 'Use literal \\')
      assert.equal(want.attrs.icon, 'lucide:bike')
      assert.equal(parseOutlineTree(`# T\n\n${REVIEW}\n`).root.children[0].titleIcon, undefined, 'the compiler draws no icon in that title')
      await open(REVIEW)
      await caret(REVIEW.length)
      await page.waitForTimeout(50)
      const shown = await ev(() => window.shownLine(0))
      assert.ok(!/[{}]|bike/.test(shown), `nothing of the group shows: ${JSON.stringify(shown)}`)
      assert.ok(shown.includes('Use literal \\'), `the title's text shows: ${JSON.stringify(shown)}`)
      assert.equal(await ev(() => window.pictures()), 0, 'and no picture is drawn')
      await caret(6)
      await page.keyboard.press('End')
      assert.equal(await head(), reviewEnd, 'End is the end of the visible text')
      assert.deepEqual(await ev(() => window.zones()), [])
      await page.keyboard.type('X')
      assert.equal(await text(), '### Use literal \\X{icon=lucide:bike}\nBody', 'a letter lands at the end of the text that shows')
      await page.keyboard.press('Backspace')
      assert.equal(await text(), REVIEW, 'Backspace takes it')
      await page.keyboard.press('Delete')
      assert.equal(await text(), REVIEW, 'Delete at the end of the text is held, as before any hidden option')
      await page.keyboard.press('ArrowRight')
      assert.equal(await head(), REVIEW.indexOf('Body'), 'ArrowRight steps over the hidden group to the next line (it is no chip to step into)')
      // Markdown shows the group, and End is the line's end there.
      assert.equal(await typeAtEnd(REVIEW, 6, 'markdown'), '### Use literal \\{icon=lucide:bike}X\nBody')
    })
    await check('the review\'s input: a click on the title\'s last character, and one to the right of the title, leave the caret in the visible text', async () => {
      await open(REVIEW)
      await caret(REVIEW.length)
      const last = await ev((p) => window.charPoint(p), reviewEnd - 1)
      await page.mouse.click(last.x, last.y)
      assert.ok([reviewEnd - 1, reviewEnd].includes(await head()), `the caret is beside the character clicked: ${await head()}`)
      assert.deepEqual(await ev(() => window.zones()), [])
      const box = await ev(() => window.lineBox(0))
      await page.mouse.click(box.right - 40, (box.top + box.bottom) / 2)
      assert.equal(await head(), reviewEnd, 'a click past the text is the end of the text')
      assert.ok(await ev(() => window.empty()), 'and selects nothing')
      const shown = await ev(() => window.shownLine(0))
      assert.ok(!/[{}]/.test(shown), `the group is still hidden: ${JSON.stringify(shown)}`)
    })

    // (c) and the non-icon kinds: [line, the ranges of the groups Plain protects, the end of the visible text or null].
    const TAIL_KINDS = [
      ['### A \\{reveal}', [[7, 15]], 7],
      ['### A{reveal}', [[5, 13]], 5],
      ['### A {id=a1}x', [], null],
      ['### A \\{x} {reveal}', [[7, 10], [11, 19]], 7],
      ['### A {reveal} more', [], null],
      ['### A{icon=lucide:bike}', [[5, 23]], 5],
      ['### A \\{icon=lucide:bike} {reveal}', [[7, 25], [26, 34]], 7],
      // The compiler peels from the right and stops at the backslash: {reveal} stays in the title.
      ['### A {reveal} \\{icon=lucide:bike}', [[16, 34]], 16]
    ]
    for (const [line, ranges, textEnd] of TAIL_KINDS) {
      await check(`${JSON.stringify(line)}: ${ranges.length ? 'the compiler takes ' + ranges.length + ' group(s) off the title, and Plain hides them' : 'the compiler reads the braces as title text, and so does Plain'}`, async () => {
        const want = compiled(line)
        assert.deepEqual(want.groups, ranges, 'what the compiler consumes')
        const d = `${line}\nBody`
        assert.deepEqual((await ev((t) => window.tailRanges(t), d)).map(([from, to]) => [from, to]), ranges, 'what Plain protects')
        await open(d)
        await caret(d.length)
        const shown = await ev(() => window.shownLine(0))
        const plain = await typeAtEnd(d, 0, 'plain')
        const md = await typeAtEnd(d, 0, 'markdown')
        if (!ranges.length) {
          assert.ok(shown.includes(line.slice(4)), `the whole title shows: ${JSON.stringify(shown)}`)
          assert.equal(plain, md, 'End then a letter is what it is in Markdown')
          assert.equal(plain, `${line}X\nBody`)
          // Backspace and Delete inside the braces edit them. (An {id=…} is the app's own protected
          // token wherever it is written: extensions/idProtect.ts, not asked here.)
          const inside = line.indexOf('{') + 2
          for (const k of line.includes('{id=') ? [] : ['Backspace', 'Delete']) {
            assert.equal(await press(d, inside, k), await press(d, inside, k, 'markdown'), `${k} inside the braces`)
            assert.notEqual(await text(), d, `${k} changed the text`)
          }
          return
        }
        for (const [from, to] of ranges) assert.ok(!shown.includes(line.slice(from, to)), `${line.slice(from, to)} is hidden: ${JSON.stringify(shown)}`)
        assert.ok(shown.includes(line.slice(4, textEnd)), `the title's text shows: ${JSON.stringify(shown)}`)
        assert.equal(plain, `${line.slice(0, textEnd)}X${line.slice(textEnd)}\nBody`, 'a letter typed at End lands at the end of the visible text')
        assert.equal(compiled(plain.split('\n')[0]).title, want.title + 'X', 'which is the end of the compiled title')
        assert.deepEqual(compiled(plain.split('\n')[0]).attrs, want.attrs, 'with the options unchanged')
      })
    }

    // (b) A paragraph: the compiler reads an escaped or glued group as text, and so does Plain.
    for (const tail of ['Use literal \\{icon=lucide:bike}', 'Glued{icon=lucide:bike}', 'See https://example.org/{icon=lucide:bike}']) {
      await check(`a paragraph that ends ${JSON.stringify(tail)}: the braces are text, shown and edited as in Markdown`, async () => {
        const d = `Intro\n\n${tail}\n\nNext`
        const at = d.indexOf(tail)
        assert.equal(paragraphIconTokenAt(tail), null, 'the compiler reads no token')
        assert.equal(lexMarkdownBlocks([tail])[0].text, tail, 'and keeps the text whole')
        assert.deepEqual(await ev((t) => window.inventoryFor(t), d), [], 'Plain protects nothing')
        await open(d)
        await caret(0)
        await page.waitForTimeout(50)
        assert.ok((await ev((p) => window.shownLine(p), at)).includes('{icon=lucide:bike}'), 'the braces show')
        assert.equal(await ev(() => window.pictures()), 0, 'no picture is drawn')
        const md = await typeAtEnd(d, at, 'markdown')
        assert.equal(md, d.replace(tail, tail + 'X'))
        assert.equal(await typeAtEnd(d, at, 'plain'), md, 'End then a letter')
        // A click in the visible "bike" leaves the caret there.
        await open(d)
        await caret(0)
        const bike = d.indexOf('bike') + 1
        const point = await ev((p) => window.charPoint(p), bike)
        await page.mouse.click(point.x, point.y)
        await page.waitForTimeout(50)
        assert.ok([bike, bike + 1].includes(await head()), `the caret is where the click was: ${await head()}, wanted ${bike} or ${bike + 1}`)
        assert.deepEqual(await ev(() => window.zones()), [], 'and on no protected text')
        for (const k of ['Backspace', 'Delete']) {
          const got = await press(d, bike, k)
          assert.equal(got, await press(d, bike, k, 'markdown'), `${k} inside the braces`)
          assert.notEqual(got, d, `${k} changed the text`)
        }
      })
    }
    await check('a list item: the compiler takes a glued or escaped icon group as the item\'s icon, and Plain protects it', async () => {
      for (const item of ['- Glued{icon=lucide:bike}', '- Use \\{icon=lucide:bike}']) {
        const block = lexMarkdownBlocks([item, '- Two'])[0]
        assert.ok(!JSON.stringify(block).includes('{icon='), `${item}: the compiler strips the group: ${JSON.stringify(block).slice(0, 200)}`)
        assert.deepEqual(await ev((t) => window.inventoryFor(t), `${item}\n- Two\n`), ['icon {icon=lucide:bike}'], `${item}: Plain protects it`)
      }
    })

    await check('the literal-braces fixture in Plain: every line is edited at its end as the compiler reads it', async () => {
      const fixture = readFileSync(join(root, 'scripts/fixtures/icons-on-titles/braces-that-are-not-icons-outline.md'), 'utf8')
      let at = 0, asText = 0, braces = 0, consumed = 0, concealed = 0
      const seen = []
      fixture.split('\n').forEach((line, n) => {
        const from = at
        at += line.length + 1
        if (n >= 3 && line.trim()) seen.push([line, from]) // after the front matter
      })
      for (const [line, from] of seen) {
        const heading = /^#{1,6}\s/.test(line)
        const want = heading ? compiled(line) : null
        // The compiler reads the line's trailing braces as text: nothing is taken off the line.
        const isText = heading ? want.groups.length === 0 : /^[-*+]\s/.test(line) ? !/\}\s*$/.test(line) : lexMarkdownBlocks([line])[0].text === line.trim()
        const plain = await typeAtEnd(fixture, from, 'plain')
        if (isText) {
          asText += 1
          if (/\}\s*$/.test(line)) braces += 1
          const atLineEnd = fixture.slice(0, from) + line + 'X' + fixture.slice(from + line.length)
          assert.equal(await typeAtEnd(fixture, from, 'markdown'), atLineEnd, `${JSON.stringify(line)}: in Markdown the letter is at the line's end`)
          const marksOf = (t) => /\]\([^)]*\)$/.test(t) ? t.length - t.lastIndexOf('](') : /`$/.test(t) ? 1 : 0
          if (marksOf(line)) {
            // A line that ends in a link or in a code span: Plain hides the link's address and the
            // closing backtick (plainView/conceal.ts), and End is the end of what shows. That is
            // those marks' rule, with braces before them or without: the same line with the braces
            // taken out behaves the same.
            concealed += 1
            const put = (doc, t) => doc.slice(0, from + t.length - marksOf(t)) + 'X' + doc.slice(from + t.length - marksOf(t))
            assert.equal(plain, put(fixture, line), `${JSON.stringify(line)}: the letter is at the end of the text that shows`)
            const without = line.replace(/ ?\{icon=lucide:bike\}/, '')
            const bare = fixture.replace(line, without)
            assert.equal(await typeAtEnd(bare, from, 'plain'), put(bare, without), `${JSON.stringify(line)}: as on the same line without braces`)
            continue
          }
          assert.equal(plain, atLineEnd, `${JSON.stringify(line)}: End then a letter is what it is in Markdown`)
        } else {
          consumed += 1
          assert.ok(heading, `${JSON.stringify(line)}: only a heading's braces are consumed in this fixture`)
          const typed = plain.slice(from).split('\n')[0]
          assert.equal(compiled(typed).title, want.title + 'X', `${JSON.stringify(line)}: the letter is the end of the compiled title; the line is ${JSON.stringify(typed)}`)
          assert.deepEqual(compiled(typed).attrs, want.attrs, `${JSON.stringify(line)}: and the options are unchanged`)
          await open(fixture)
          await caret(0)
          const shown = await ev((p) => window.shownLine(p), from)
          assert.ok(!/[{}]/.test(shown), `${JSON.stringify(line)}: no group shows: ${JSON.stringify(shown)}`)
        }
      }
      assert.ok(braces >= 4 && consumed === 5 && concealed === 2, `${asText} text lines (${braces} ending in braces), ${consumed} headings with consumed groups, ${concealed} ending in a mark Plain hides`)
    })
  }
  caught.push(...new Set(await ev(() => window.__caught)))
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

assert.deepEqual(errors, [], 'no page errors')
assert.deepEqual(caught, [], 'no exception that CodeMirror caught')
if (failed.length) {
  console.error(`test:plain-view-guarded-keys: ${failed.length} failed`)
  for (const f of failed) console.error('  - ' + f)
  process.exit(1)
}
console.log('test:plain-view-guarded-keys: passed')
