// The heading and id guard (src/renderer/src/extensions/idProtect.ts) against whole-slide cut:
//   - Backspace, Delete and an ordinary cut on a slide title are refused exactly as before;
//   - the whole-slide cut (user event `delete.cut.slide`, the change cutBlock works out) passes, for
//     every slide and section of a realistic talk, with and without a final newline;
//   - the exemption is that one event and only for the heading guard: the same event on a change
//     that nibbles an id is still refused, and `delete.cut` is never let through;
//   - a cut of part of a title keeps the heading; a selection widened to whole blocks passes as an
//     ordinary cut, and one that ends inside the next title is refused.
// The real CodeMirror state with the real guard; the changes are the ones the editor dispatches.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const toasts = []
globalThis.window = new EventTarget()
globalThis.window.addEventListener('tw-toast', (e) => toasts.push(e.detail.message))

const bundleDir = mkdtempSync(join(tmpdir(), 'talk-weaver-slide-cut-guard-'))
const bundleUrl = pathToFileURL(join(bundleDir, 'bundle.mjs'))
let m
try {
  await build({
    stdin: {
      contents: [
        "export { EditorState } from '@codemirror/state'",
        "export { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'",
        "export { cutBlock, widenToBlocks } from './src/renderer/src/extensions/slideBlockOps.ts'",
        "export { SLIDE_CUT_EVENT } from './src/renderer/src/extensions/slideCutPaste.ts'"
      ].join('\n'),
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'test-slide-cut-guard-entry.ts'
    },
    bundle: true, format: 'esm', platform: 'node', outfile: fileURLToPath(bundleUrl), logLevel: 'error'
  })
  m = await import(`${bundleUrl.href}?t=${Date.now()}`)
} finally {
  rmSync(bundleDir, { recursive: true, force: true })
}
const { EditorState, tokenProtectExtension, cutBlock, widenToBlocks, SLIDE_CUT_EVENT } = m

let cases = 0
const J = (...lines) => lines.join('\n')
const stateOf = (doc) => EditorState.create({ doc, extensions: [tokenProtectExtension()] })
/** The text after a user change, and whether the guard let it through. */
function apply(doc, from, to, userEvent) {
  toasts.length = 0
  const tr = stateOf(doc).update({ changes: { from, to, insert: '' }, userEvent })
  return { text: tr.newDoc.toString(), passed: tr.docChanged, warned: toasts.some((t) => t.startsWith('A slide title has to stay')) }
}
const refused = (name, doc, from, to, userEvent) => {
  cases += 1
  const r = apply(doc, from, to, userEvent)
  assert.equal(r.passed, false, `${name}: refused`)
  assert.equal(r.text, doc, `${name}: the text is unchanged`)
  return r
}
const offsetOf = (doc, line, col = 0) => doc.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col
const lineOf = (doc, heading) => doc.split('\n').indexOf(heading) + 1

const A = ['### A', '{id=a1}', 'body A', '']
const B = ['### B {reveal}', '{columns}', '{id=b1}', '', '- point', '', 'Note: say it.', '']
const C = ['### C', '{id=c1}', 'body C', '']
const TALK = J('# Talk', '', '## One', '', ...A, ...B, '## Two', '{id=sec2}', '', ...C)

assert.equal(SLIDE_CUT_EVENT, 'delete.cut.slide')

// ── Backspace / Delete / an ordinary cut on a title: refused, as before ──
{
  const h = offsetOf(TALK, lineOf(TALK, '### A'))
  assert.ok(refused('Backspace into the marker', TALK, h + 3, h + 4, 'delete.backward').warned, 'with the "has to stay" warning')
  const tight = J('### P', 'body P', '### A', 'body A')
  const t = offsetOf(tight, 3)
  refused('Backspace at the start of the title line (merging it into the text above)', tight, t - 1, t, 'delete.backward')
  refused('Delete at the end of the line above a title', tight, t - 1, t, 'delete.forward')
  refused('⌘X with no selection, as CodeMirror cuts it: the title line alone', TALK, h, h + '### A\n'.length, 'delete.cut')
  refused('an ordinary cut of the title and its id line, the body left behind', TALK, h, offsetOf(TALK, lineOf(TALK, 'body A')), 'delete.cut')
  refused('Backspace on the id line', TALK, offsetOf(TALK, lineOf(TALK, '{id=a1}')), offsetOf(TALK, lineOf(TALK, '{id=a1}')) + 7, 'delete.backward')
  // Straight after a refused edit on an id: the guard's id pattern must start afresh (it once kept its place in the
  // previous line, so this change, whose first examined line is the id line, was not checked and merged body text into the id).
  refused('Delete joining the id line to the body', TALK, offsetOf(TALK, lineOf(TALK, 'body A')) - 1, offsetOf(TALK, lineOf(TALK, 'body A')), 'delete.forward')
}

// ── The whole-slide cut passes: every heading of the talk, in four endings of the file ──
for (const [ending, doc] of [
  ['one final newline', TALK],
  ['no final newline', TALK.replace(/\n+$/, '')],
  ['several blank lines at the end', TALK + '\n\n'],
  ['tight, no blank lines', J('### A', '{id=a1}', '### B', '{id=b1}', 'b', '### C', '{id=c1}')]
]) {
  const headings = doc.split('\n').map((l, i) => [l, i + 1]).filter(([l]) => /^#{2,6}\s/.test(l))
  for (const [heading, line] of headings) {
    cases += 1
    const cut = cutBlock(doc, line)
    const r = apply(doc, cut.from, cut.to, SLIDE_CUT_EVENT)
    assert.equal(r.passed, true, `${ending}: whole-slide cut of ${heading} passes the guard`)
    assert.equal(r.text, cut.text, `${ending}: ${heading}: the editor's text is what cutBlock worked out`)
    assert.equal(r.warned, false)
  }
}

// ── The exemption is narrow ──
{
  // Why the cut needs its own event: the last slide's cut leaves the blank lines that end the file, and the
  // heading guard reads that as "not the whole slide" for any ordinary cut.
  cases += 1
  const doc = TALK + '\n\n'
  const cut = cutBlock(doc, lineOf(doc, '### C'))
  assert.equal(apply(doc, cut.from, cut.to, SLIDE_CUT_EVENT).text, cut.text)
  assert.equal(apply(doc, cut.from, cut.to, 'delete.cut').passed, false, 'delete.cut is not let through: only the slide-cut event is')

  const idLine = offsetOf(TALK, lineOf(TALK, '{id=a1}'))
  refused('the slide-cut event on a change that nibbles an id', TALK, idLine + 2, idLine + 5, SLIDE_CUT_EVENT)
  refused('the slide-cut event on an id line alone', TALK, idLine, idLine + '{id=a1}\n'.length, SLIDE_CUT_EVENT)
  const h = offsetOf(TALK, lineOf(TALK, '### A'))
  // What the exemption does cover, stated so a widening of it shows here: the title line alone under the slide-cut
  // event would pass the heading guard, so the id guard is what must still hold the id line below it.
  refused('the slide-cut event on a title and half of its id line', TALK, h, idLine + 3, SLIDE_CUT_EVENT)
}

// ── A cut of part of a title keeps the heading ──
{
  cases += 1
  const h = offsetOf(TALK, lineOf(TALK, '### B {reveal}'))
  const r = apply(TALK, h + 4, h + 5, 'delete.cut')
  assert.equal(r.passed, true, 'the letter goes')
  assert.equal(r.text.split('\n')[lineOf(TALK, '### B {reveal}') - 1], '###  {reveal}', 'the marker and the heading line stay')
}

// ── A selection holding a whole title, widened to the slide's block ──
{
  cases += 2
  const from = offsetOf(TALK, lineOf(TALK, 'body A'), 2)
  const to = offsetOf(TALK, lineOf(TALK, '{columns}'))
  refused('the selection as made (title in, body left behind)', TALK, from, to, 'delete.cut')
  const wide = widenToBlocks(TALK, from, to)
  const r = apply(TALK, wide.from, wide.to, 'delete.cut')
  assert.equal(r.passed, true, 'widened to the whole slide it passes as an ordinary cut')
  assert.ok(!r.text.includes('### B') && !r.text.includes('{id=b1}') && r.text.includes('{id=a1}') && r.text.includes('## Two'))
  // Ending inside the NEXT title: that title would be cut in half; still refused.
  const intoNext = offsetOf(TALK, lineOf(TALK, '## Two'), 4)
  const wide2 = widenToBlocks(TALK, offsetOf(TALK, lineOf(TALK, '### B {reveal}')), intoNext)
  assert.equal(wide2.to, intoNext, 'only B is wholly selected: the range still ends inside "## Two"')
  refused('a selection ending inside the next title', TALK, wide2.from, wide2.to, 'delete.cut')
}

console.log(`slide cut guard: ${cases} cases passed`)
