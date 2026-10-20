// test:save-tidy-up-undo-generated — a save's step and the undo history (issues 131 and 201), generated runs.
//
// A real CodeMirror editor in a browser (Playwright's chromium headless shell, never the real Chrome), with what the
// app's editor mounts for this (Editor.tsx): history, the app's keys (editorBaseKeymap and the registry's bindings,
// where ⌘Z and ⇧⌘Z live), the token guards, Slide Focus's extension, the Markdown or the Plain view, the save's step
// (savedTextAdoption.ts) and the state the save reads (saveTidyUp.ts). The save is the app's, in three parts:
//   1. the text to write is textForSave of the editor's text (Editor.tsx: the autosave, flushSave, the replace seam);
//   2. it is stamped as the main process stamps it (stampMissingIds, the ids on "disk" preferred) and written;
//   3. what was written is adopted from the text the save was made from (adoptSavedText).
// Undo and redo are the ⌘Z and ⇧⌘Z keys.
//
// The talks have headings that differ only in white space (`### Title {icon=…}`, `### Title  {icon=…}`), layout lines
// out of place, slides with and without ids. The changes: typing, a group pasted before a title icon, a line break put
// before one, one character deleted inside a heading's title or inside its `{icon=…}`, a heading typed.
//
// The model holds every text the history can reach and what each step was (the user's change, or a save's step); a
// change joined to the step before it is read from the undo depth. After every step:
//   1. the undo and redo depths are the model's;
//   2. after ⌘Z or redo the text is exactly the model's: a save's step goes with the user's step below it;
//   3. after ⌘Z or redo the (slide → id) pairs are a subset of the pairs the editor has held, and every heading reads
//      as it did in the model's text (none is damaged).
// Then three fixed cases: the reproductions of the three reviews of #158.
//
//   node scripts/test-save-tidy-up-undo-generated.mjs
//   GEN_STEPS=n, GEN_SEEDS=a,b, GEN_ONLY=markdown|plain|none (none: the fixed cases only), GEN_REPORT=1 lists every
//   failure, GEN_DUMP=1 prints the texts and steps of one
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { preferredIdsFromText, stampMissingIds } from '../compiler/scripts/lib/12-outline-edit.mjs'

const STEPS = Number(process.env.GEN_STEPS ?? 70)
const SEEDS = process.env.GEN_SEEDS ? process.env.GEN_SEEDS.split(',').map(Number) : [201, 131, 7, 20261018]
const REPORT = process.env.GEN_REPORT === '1'
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-save-step-'))
const outfile = join(dir, 'bundle.js')

const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Prec, Transaction } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, undoDepth, redoDepth } from '@codemirror/commands'
import { search } from '@codemirror/search'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { focusScopeExtension } from './src/renderer/src/extensions/focusScope.ts'
import { editorBaseKeymap } from './src/renderer/src/extensions/editorBaseKeymap.ts'
import { buildEditorKeyBindings } from './src/renderer/src/keymap/store.ts'
import { adoptSavedText, isSaveStep, savedTextAdoption } from './src/renderer/src/extensions/savedTextAdoption.ts'
import { saveTidyUp, textForSave } from './src/renderer/src/extensions/saveTidyUp.ts'
import { appKeyState, failOnCaughtExceptions } from './scripts/lib/plain-view-test-mount.mjs'

let view = null
const T = window.T = {}
T.mount = (doc, mode) => {
  if (view) view.destroy()
  T.log = []
  view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [
      history(), markdown({ base: markdownLanguage }),
      tokenProtectExtension(), focusScopeExtension(), appKeyState(), search(),
      keymap.of([...editorBaseKeymap]),
      Prec.highest(keymap.of(buildEditorKeyBindings())),
      viewModeExtension(mode),
      savedTextAdoption(), saveTidyUp(),
      // What happened, for GEN_DUMP: each change with its user event, whether it was a save's step, and the depths after it.
      EditorView.updateListener.of((u) => { for (const tr of u.transactions) if (tr.docChanged) T.log.push([tr.annotation(Transaction.userEvent) ?? '-', isSaveStep(tr) ? 'S' : '', undoDepth(tr.state), redoDepth(tr.state)].join(' ')) }),
      failOnCaughtExceptions()
    ]
  }) })
  view.focus()
}
T.doc = () => view.state.doc.toString()
T.depths = () => ({ undo: undoDepth(view.state), redo: redoDepth(view.state) })
T.refocus = () => view.focus()
// The user's own typing and pasting (input events), and a program's change (no user event: the token guards let it
// into a protected token, as they do a whole-slide paste or a rewrite).
T.type = (at, text) => view.dispatch({ changes: { from: at, insert: text }, selection: EditorSelection.cursor(at + text.length), userEvent: 'input.type' })
T.paste = (at, text) => view.dispatch({ changes: { from: at, insert: text }, selection: EditorSelection.cursor(at + text.length), userEvent: 'input.paste' })
T.remove = (from, to) => view.dispatch({ changes: { from, to }, selection: EditorSelection.cursor(from) })
// Parts 1 and 3 of the save (see the head of the file).
T.saveText = () => { const source = view.state.doc.toString(); return { source, sent: textForSave(view.state, source) } }
T.adopt = (source, saved) => adoptSavedText(view, source, saved)
T.caught = () => window.__caught
T.logTail = (n) => T.log.slice(-n)
`

const J = (...lines) => lines.join('\n')
const ICON = '{icon=lucide:star}'
const ID_LINE = /^\{id=[^}]+\}$/
const isHeading = (line) => /^#{2,6} /.test(line)
const idsOf = (t) => [...t.matchAll(/\{id=([^}]+)\}/g)].map((m) => m[1])
/** Every slide of `text`: its text with the ids out and white space collapsed, and the id it carries (on its heading
 *  or on the layout lines straight under it), or null. */
function slides(text) {
  const lines = text.split('\n')
  const out = []
  lines.forEach((line, i) => {
    if (!isHeading(line)) return
    let end = i + 1
    while (end < lines.length && !isHeading(lines[end])) end += 1
    let id = line.match(/\{id=([^}]+)\}/)?.[1] ?? null
    for (let k = i + 1; k < end && !id; k += 1) {
      if (lines[k].trim() === '') continue
      if (!/^\s*(\{[^}]*\}\s*)+$/.test(lines[k])) break
      id = lines[k].match(/\{id=([^}]+)\}/)?.[1] ?? null
    }
    const body = lines.slice(i, end).filter((l) => !ID_LINE.test(l)).join('\n').replace(/ ?\{id=[^}]+\} ?/g, ' ').replace(/\s+/g, ' ').trim()
    out.push({ body, id })
  })
  return out
}
const pairsOf = (text) => slides(text).filter((s) => s.id).map((s) => `${s.body}  →  ${s.id}`)
const headingsOf = (text) => text.split('\n').filter(isHeading).map((l) => l.replace(/ ?\{id=[^}]+\}/g, ''))

function generator(seed) {
  let s = seed
  return (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s >>> 8) % n }
}

/** A talk with look-alike headings (white space apart), layout lines out of place, and slides with and without ids. */
function talk(rnd) {
  const lines = ['---', 'title: "Generated"', '---', '', '## Part', '{id=part0}', '']
  const titles = ['Title', 'Title ', 'Title', 'Other', 'Other  ', 'Third']
  titles.forEach((title, k) => {
    const shape = rnd(6)
    if (shape === 0) lines.push(`### ${title} ${ICON}`)
    else if (shape === 1) lines.push(`### ${title} ${ICON}`, `{id=s${k}x}`)
    else if (shape === 2) lines.push(`### ${title} ${ICON}`, '', '{pyramid}')
    else if (shape === 3) lines.push(`### ${title}`, '', `{columns} {id=s${k}y}`)
    else if (shape === 4) lines.push(`### ${title} {cards}`)
    else lines.push(`### ${title}`)
    lines.push('', `- point ${k}`, '')
  })
  return lines.join('\n')
}

let browser
let passed = 0
const pass = (message) => { passed += 1; console.log(`PASS ${message}`) }
try {
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: 'save-step-entry.ts', loader: 'ts' },
    bundle: true, format: 'iife', platform: 'browser', outfile, logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<!doctype html><html><body><div id="host" style="width:700px;height:800px;overflow:auto"></div></body></html>')
  await page.addScriptTag({ content: readFileSync(outfile, 'utf8') })
  const call = (name, ...args) => page.evaluate(([n, a]) => window.T[n](...a), [name, args])
  const doc = () => call('doc')
  const depths = () => call('depths')
  const undoKey = async () => { await call('refocus'); await page.keyboard.press('Meta+z') }
  const redoKey = async () => { await call('refocus'); await page.keyboard.press('Meta+Shift+z') }

  /** One editor, its "disk", and the model of its history. */
  const session = async (start, mode) => {
    await call('mount', start, mode)
    const m = { disk: start, states: [start], kinds: [null], at: 0, ever: new Set(pairsOf(start)), saves: 0, adopted: 0, undos: 0 }
    const check = async (what) => {
      assert.deepEqual(await depths(), { undo: m.at, redo: m.states.length - 1 - m.at }, `${what}: the undo and redo depths are the model's (1)`)
      const text = await doc()
      assert.equal(new Set(idsOf(text)).size, idsOf(text).length, `${what}: no id twice`)
      for (const p of pairsOf(text)) m.ever.add(p)
    }
    /** A change of the user's (or a program's): one new step, or joined to the user's step before it. */
    const change = async (what, make) => {
      const before = await doc()
      const depth = (await depths()).undo
      await make(before)
      const after = await doc()
      if (after === before) return false
      const now = (await depths()).undo
      m.states.length = m.at + 1
      m.kinds.length = m.at + 1
      if (now === depth + 1) { m.states.push(after); m.kinds.push('user'); m.at += 1 } else {
        assert.equal(now, depth, `${what}: a change is one undo step or joins the one before (${depth} -> ${now})`)
        assert.equal(m.kinds[m.at], 'user', `${what}: a change joins only a step of the user's, never a save's`)
        m.states[m.at] = after
      }
      await check(what)
      return true
    }
    /** The app's save (the head of the file). Returns whether the editor adopted what was written. */
    const save = async (what = 'save') => {
      const { source, sent } = await call('saveText')
      let preferred = null
      try { preferred = preferredIdsFromText(m.disk) } catch { /* nothing on disk */ }
      m.disk = stampMissingIds(sent, undefined, { preferred }).text
      const depth = (await depths()).undo
      const adopted = await call('adopt', source, m.disk)
      m.saves += 1
      const now = await doc()
      if (adopted) {
        m.adopted += 1
        assert.equal(now, m.disk, `${what}: the editor holds what the save wrote`)
        assert.equal((await depths()).undo, depth + 1, `${what}: the adoption is one undo step`)
        m.states.length = m.at + 1
        m.kinds.length = m.at + 1
        m.states.push(now); m.kinds.push('save'); m.at += 1
      } else {
        assert.equal(now, source, `${what}: a save that is not adopted leaves the editor's text alone`)
      }
      await check(what)
      return adopted
    }
    const afterHistory = async (what, expected) => {
      const now = await doc()
      const pairsBefore = new Set(m.ever)
      assert.equal(now, expected, `${what}: the text is exactly the model's (2)`)
      for (const p of pairsOf(now)) assert.ok(pairsBefore.has(p), `${what}: the pair ${JSON.stringify(p)} was never held before (3)`)
      assert.deepEqual(headingsOf(now), headingsOf(expected), `${what}: every heading reads as it did (3)`)
      await check(what)
    }
    const undo = async (what = '⌘Z') => {
      const before = await doc()
      await undoKey()
      if (m.at === 0) { assert.equal(await doc(), before, `${what}: nothing to undo, nothing changes`); return await check(what) }
      let kind
      do { kind = m.kinds[m.at]; m.at -= 1 } while (kind === 'save' && m.at > 0)
      m.undos += 1
      await afterHistory(what, m.states[m.at])
    }
    const redo = async (what = 'redo') => {
      const before = await doc()
      await redoKey()
      if (m.at === m.states.length - 1) { assert.equal(await doc(), before, `${what}: nothing to redo, nothing changes`); return await check(what) }
      m.at += 1
      while (m.at < m.states.length - 1 && m.kinds[m.at + 1] === 'save') m.at += 1
      await afterHistory(what, m.states[m.at])
    }
    return { m, change, save, undo, redo }
  }

  const offsetOfLine = (text, n) => text.split('\n').slice(0, n).join('\n').length + (n > 0 ? 1 : 0)

  // ── The generated runs ──
  const failures = []
  let current = null
  for (const mode of ['markdown', 'plain']) {
    if (process.env.GEN_ONLY && process.env.GEN_ONLY !== mode) continue
    for (const seed of SEEDS) {
      const name = `${mode === 'plain' ? 'Plain view' : 'Markdown editor'}, seed ${seed}`
      const trace = []
      try {
        const rnd = generator(seed)
        const s = await session(talk(rnd), mode)
        current = s
        let counter = 0
        for (let n = 1; n <= STEPS; n += 1) {
          const text = await doc()
          const lines = text.split('\n')
          const headings = lines.map((l, i) => [l, i]).filter(([l]) => isHeading(l) && !l.startsWith('## '))
          const [hLine, hIndex] = headings[rnd(headings.length)]
          const hFrom = offsetOfLine(text, hIndex)
          const roll = rnd(100)
          let what
          if (roll < 14) {
            const bullets = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith('- '))
            const [line, i] = bullets[rnd(bullets.length)]
            what = `type after "${line}"`
            await s.change(what, () => call('type', offsetOfLine(text, i) + line.length, ` w${(counter += 1)}`))
          } else if (roll < 26) {
            // One character out of the heading's title (the text between the hashes and its first group).
            const title = hLine.replace(/^#+ /, '').replace(/\s*\{.*$/, '')
            if (title.length === 0) continue
            const at = hLine.indexOf(' ') + 1 + rnd(title.length)
            what = `delete "${hLine[at]}" in "${hLine}"`
            await s.change(what, () => call('remove', hFrom + at, hFrom + at + 1))
          } else if (roll < 34) {
            const icon = hLine.indexOf('{icon=')
            if (icon < 0) continue
            const at = icon + rnd(ICON.length)
            what = `delete "${hLine[at]}" in the icon of "${hLine}"`
            await s.change(what, () => call('remove', hFrom + at, hFrom + at + 1))
          } else if (roll < 40) {
            const icon = hLine.indexOf(ICON)
            if (icon < 0) continue
            const group = rnd(2) ? `{wide} ` : `{t${(counter += 1)}} `
            what = `paste "${group}" before the icon of "${hLine}"`
            await s.change(what, () => call('paste', hFrom + icon, group))
          } else if (roll < 44) {
            const icon = hLine.indexOf(ICON)
            if (icon < 0) continue
            what = `a line break before the icon of "${hLine}"`
            await s.change(what, () => call('type', hFrom + icon, '\n'))
          } else if (roll < 50) {
            what = 'type a heading'
            const at = offsetOfLine(text, hIndex)
            await s.change(what, () => call('type', at, `### Typed ${(counter += 1)}\n\n- typed point\n\n`))
          } else if (roll < 68) {
            what = 'save'
            await s.save(`step ${n}, save`)
          } else if (roll < 88) {
            what = '⌘Z'
            await s.undo(`step ${n}, ⌘Z`)
          } else {
            what = 'redo'
            await s.redo(`step ${n}, redo`)
          }
          trace.push(`${n}. ${what}`)
          if (rnd(5) === 0) await page.waitForTimeout(560) // past CodeMirror's grouping delay now and then
        }
        // Back to the first text and forward to the last, a save after some presses.
        while (s.m.at > 0) { trace.push('back ⌘Z'); await s.undo('walking back'); if (rnd(3) === 0) { trace.push('back save'); await s.save('a save while walking back') } }
        assert.equal(await doc(), s.m.states[0], 'walked back to the first text')
        while (s.m.at < s.m.states.length - 1) await s.redo('walking forward')
        assert.ok(s.m.saves >= 5 && s.m.adopted >= 2 && s.m.undos >= 5, `${name}: the run saved, adopted and undid (${JSON.stringify({ saves: s.m.saves, adopted: s.m.adopted, undos: s.m.undos })})`)
        pass(`${name}: ${STEPS} steps (${s.m.saves} saves, ${s.m.adopted} adopted, ${s.m.undos} ⌘Z), then back to the first text and forward to the last`)
      } catch (error) {
        console.log(`FAIL ${name}\n     ${String(error.message).split('\n').slice(0, 6).join('\n     ')}\n     the last steps: ${trace.slice(-8).join(' | ')}`)
        if (process.env.GEN_DUMP === '1') console.log('DUMP', JSON.stringify({ actual: error.actual, expected: error.expected, trace, kinds: current?.m.kinds, at: current?.m.at, log: await call('logTail', 60) }))
        failures.push(name)
        if (!REPORT) throw error
      }
    }
  }

  // ── The three reviews of #158, as fixed cases (Markdown and Plain) ──
  for (const mode of ['markdown', 'plain']) {
    const where = mode === 'plain' ? 'Plain view' : 'Markdown editor'
    // Round 1, first finding: two groups pasted before a title icon as two steps; a save; one ⌘Z keeps the first.
    {
      const start = J('### Title {icon=lucide:star}', '{id=keep1}', '', '- body', '')
      const s = await session(start, mode)
      await s.change('paste {wide}', () => call('paste', start.indexOf(ICON), '{wide} '))
      const withWide = await doc()
      await page.waitForTimeout(560)
      await s.change('paste {columns}', () => call('paste', withWide.indexOf(ICON), '{columns} '))
      assert.deepEqual(await depths(), { undo: 2, redo: 0 })
      assert.equal(await s.save(), true, 'the save tidies the groups under the heading')
      await s.undo()
      assert.equal(await doc(), withWide, 'one ⌘Z after the save: {columns} is gone, {wide} stays')
      await s.undo()
      assert.equal(await doc(), start)
      await s.redo(); await s.redo()
      pass(`${where}, review 1: a save never takes a user's step away; ⌘Z after it undoes the last group only`)
    }
    // Round 1, second finding: a group before the icon of a slide with no id; the save stamps one; ⌘Z.
    {
      const start = J('### Title {icon=lucide:star}', '', '- body', '')
      const s = await session(start, mode)
      await s.change('insert {wide}', () => call('paste', start.indexOf(ICON), '{wide} '))
      assert.equal(await s.save(), true)
      const stamped = await doc()
      assert.equal(idsOf(stamped).length, 1, 'the save stamped the slide')
      await s.undo()
      assert.equal(await doc(), start, 'one ⌘Z: the first text exactly, the heading intact')
      assert.equal(await s.save(), false, 'the save after the ⌘Z is not adopted')
      await s.redo()
      assert.equal(await doc(), stamped, 'redo: the group and the id it was stamped with')
      pass(`${where}, review 1: ⌘Z takes back the group and the id stamped for it; the heading is never damaged`)
    }
    // Round 2: a line break before the icon; the save stamps the icon's new layout line; ⌘Z; save; redo.
    {
      const start = J('### Title {icon=lucide:star}', '', '- body', '')
      const s = await session(start, mode)
      await s.change('a line break before the icon', () => call('type', start.indexOf(ICON), '\n'))
      await s.save()
      const stamped = await doc()
      const [id] = idsOf(stamped)
      assert.ok(id, 'the save stamped the slide')
      await s.undo()
      assert.equal(await doc(), start, '⌘Z: the first text exactly')
      await s.save()
      // The file between the ⌘Z and the redo: the main process reuses ids by heading text (src/main/index.ts, preferred),
      // and the heading reads differently with its icon back on it. Reported, not asserted (issue 201, point 6).
      if (mode === 'markdown') console.log(`NOTE review 2, the file after ⌘Z and a save: ${idsOf(s.m.disk)[0] === id ? 'the slide keeps its id' : `the slide has id ${idsOf(s.m.disk)[0]}, not ${id}, until the redo's save`}`)
      await s.redo()
      assert.equal(await doc(), stamped, 'redo: the id the slide was stamped with, not another')
      await s.save()
      assert.equal(idsOf(s.m.disk)[0], id, 'and the file carries that id after the next save')
      pass(`${where}, review 2: ⌘Z, a save and redo leave the slide its one id`)
    }
    // Round 3: two headings that differ in white space only; `itle ` deleted from the first; save; ⌘Z.
    {
      const start = J('### Title {icon=lucide:star}', '', '- one', '', '### Title  {icon=lucide:star}', '', '- two', '')
      const s = await session(start, mode)
      await s.change('delete "itle "', () => call('remove', 5, 10))
      assert.ok((await doc()).startsWith('### T{icon=lucide:star}'))
      await s.save()
      const stamped = await doc()
      const pairs = pairsOf(stamped)
      assert.equal(pairs.length, 2, 'the save stamped both slides')
      await s.undo()
      assert.equal(await doc(), start, '⌘Z: the first text exactly; no id moved to the other slide')
      assert.deepEqual(await depths(), { undo: 0, redo: 2 }, 'the redo steps are kept')
      await s.save()
      // As in review 2, reported, not asserted: the file between the ⌘Z and the redo.
      if (mode === 'markdown') console.log(`NOTE review 3, the file after ⌘Z and a save (ids reused by heading text): ${pairsOf(s.m.disk).join(' ; ')} (stamped before: ${pairs.join(' ; ')})`)
      await s.redo()
      assert.equal(await doc(), stamped, 'redo: each slide with its own id')
      await s.save()
      assert.deepEqual(pairsOf(s.m.disk), pairs, 'and the file has them again after the next save')
      pass(`${where}, review 3: look-alike headings keep their own ids through ⌘Z and redo`)
    }
    // Round 3, second finding: one slide, `itle ` deleted, save, ⌘Z: redo still works.
    {
      const start = J('### Title {icon=lucide:star}', '', '- body', '')
      const s = await session(start, mode)
      await s.change('delete "itle "', () => call('remove', 5, 10))
      await s.save()
      const stamped = await doc()
      await s.undo()
      assert.equal(await doc(), start, '⌘Z: the title back exactly')
      assert.equal((await depths()).redo, 2, 'the redo steps are still there')
      await s.redo()
      assert.equal(await doc(), stamped, 'redo gives the stamped text back')
      pass(`${where}, review 3: ⌘Z after the save never empties the redo step`)
    }
  }

  assert.deepEqual(await call('caught'), [], 'no exception was caught by the editor')
  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`)
  if (failures.length > 0) throw new Error(`${failures.length} run(s) failed:\n  ${failures.join('\n  ')}`)
  console.log(`\nsave step, generated: ${passed} checks passed`)
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
