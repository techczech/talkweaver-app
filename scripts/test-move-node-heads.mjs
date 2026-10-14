// test:move-node-heads — "Move slide or item up/down" keeps a slide's head whole (issue 121).
//
// A slide's HEAD is its heading line and the lines directly under it that belong to it: its
// `{id=…}` line and its layout lines, as logicalTriggerBlockAfterHeading (src/shared/trigger-line.ts)
// reads them. Before the fix, Move up on the body line under a layout line gave
// `### Alpha\nBody text\n{statement}`: the slide lost its layout.
//
// The command under test is the real one (outliner.ts moveNode), bundled, run on a real
// EditorState with CodeMirror's history. No browser: moveNode reads `view.state` and calls
// `view.dispatch`, nothing else of the view.
//
// What is held:
//   1. A body line, list item or block is never put inside a head; head lines are never parted
//      from each other or reordered.
//   2. At a slide boundary a body unit does under a head with extra lines what it does under a
//      heading with none (a paragraph crosses into the neighbouring slide; a list item stays).
//   3. The caret on any head line moves the whole slide, as the caret on the heading does.
//   4. Every move is a reordering of whole lines; one Undo straight after an isolated move (a fresh
//      history, nothing else in it) restores the text before that move. Not claimed: that one Undo
//      takes back only the last of several moves made quickly one after another (CodeMirror's history
//      joins them, before the fix as after).
//   5. Where no head with extra lines is in reach, the result is what the command gave before
//      (literal expected texts recorded from the command before the fix).
//   Slide Focus: a move that would change a line outside the focused band, its first line, or put
//   a line above it, is declined.
//   The move's dispatch carries no typing mark and no user event.
//   Time: a move through a long text costs time in proportion to its length (two fixed budgets).
//   The same result as the command at commit 00a87b8a (the fix before its selection loop was made
//   one pass), for every move this test makes and 16,000 more: text, selection and answer.
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The reference for "the same result as before": outliner.ts as committed at 00a87b8a, kept outside the
// repo and bundled beside the command under test (its imports resolve from the extensions folder, so the
// two copies share every other module). Written once from git when it is not there; where the commit
// cannot be read either, the comparison is not run and the last line says so.
const REFERENCE_COMMIT = '00a87b8a'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const referencePath = join(homedir(), 'Library', 'Caches', 'talkweaver-smoke', 'fix121b-head', `outliner-at-${REFERENCE_COMMIT}.ts`)
let referenceSource = null
try {
  if (!existsSync(referencePath)) {
    const text = execFileSync('git', ['show', `${REFERENCE_COMMIT}:src/renderer/src/extensions/outliner.ts`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] })
    mkdirSync(join(referencePath, '..'), { recursive: true })
    writeFileSync(referencePath, text, { flag: 'wx' })
  }
  referenceSource = readFileSync(referencePath, 'utf8')
} catch { referenceSource = null }
const referencePlugin = {
  name: 'outliner-at-reference-commit',
  setup(b) {
    b.onResolve({ filter: /^tw-outliner-at-reference$/ }, () => ({ path: referencePath, namespace: 'tw-reference' }))
    b.onLoad({ filter: /.*/, namespace: 'tw-reference' }, () => ({ contents: referenceSource, loader: 'ts', resolveDir: join(repoRoot, 'src', 'renderer', 'src', 'extensions') }))
  }
}

const bundleDir = mkdtempSync(join(tmpdir(), 'talk-weaver-move-node-heads-'))
const bundleUrl = pathToFileURL(join(bundleDir, 'bundle.mjs'))
let runtime
try {
  await build({
    stdin: {
      contents: [
        "export { EditorState, EditorSelection, Transaction } from '@codemirror/state'",
        "export { history, undo, undoDepth } from '@codemirror/commands'",
        "export { moveNode, moveHeadingBlock, isKeyTyped } from './src/renderer/src/extensions/outliner.ts'",
        "export { focusScopeExtension, currentFocusRange } from './src/renderer/src/extensions/focusScope.ts'",
        "export { focusRangeForSlideLine } from './src/renderer/src/components/slideFocusModel.ts'",
        "export { logicalTriggerBlockAfterHeading } from './src/shared/trigger-line.ts'",
        "export { fencedLineFlags } from './src/shared/outline-normalize.ts'",
        ...(referenceSource ? ["export { moveNode as moveNodeAtReference } from 'tw-outliner-at-reference'"] : [])
      ].join('\n'),
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'test-move-node-heads-entry.ts'
    },
    bundle: true,
    plugins: [referencePlugin],
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    outfile: fileURLToPath(bundleUrl)
  })
  runtime = await import(`${bundleUrl.href}?t=${Date.now()}`)
} finally {
  rmSync(bundleDir, { recursive: true, force: true })
}
const {
  EditorState, EditorSelection, Transaction, history, undo, undoDepth,
  moveNode, moveHeadingBlock, isKeyTyped,
  focusScopeExtension, currentFocusRange, focusRangeForSlideLine,
  logicalTriggerBlockAfterHeading, fencedLineFlags, moveNodeAtReference = null
} = runtime

const failed = []
let checks = 0
const check = (label, fn) => {
  checks += 1
  try { fn() } catch (e) {
    failed.push(`${label}: ${String(e.message).split('\n')[0]}${e.actual !== undefined ? ' | got ' + JSON.stringify(e.actual) + ' | wanted ' + JSON.stringify(e.expected) : ''}`)
  }
}

// ── The mount ────────────────────────────────────────────────────────────────────────────────
// `|` marks the caret; `^` (optional) the other end of a selection.
function parse(marked) {
  const a = marked.indexOf('^')
  const noAnchor = marked.replace('^', '')
  const head = noAnchor.indexOf('|')
  assert.ok(head >= 0, 'the marked text has a caret')
  const doc = noAnchor.replace('|', '')
  let anchor = head
  if (a >= 0) anchor = a < marked.indexOf('|') ? a : a - 1
  return { doc, head, anchor }
}
function mount(doc, anchor, head, focus = null) {
  const view = {
    trs: [],
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [history(), ...(focus ? [focusScopeExtension(() => focus)] : [])]
    }),
    dispatch: (...specs) => {
      const tr = view.state.update(...specs)
      view.trs.push(tr)
      view.state = tr.state
    }
  }
  return view
}
/** What a command did to a fresh mount: the text, the whole selection, its answer, how many dispatches. */
function outcome(command, doc, anchor, head, dir, focus) {
  const view = mount(doc, anchor, head, focus)
  const ret = command(view, dir)
  return { text: view.state.doc.toString(), selection: view.state.selection.toJSON(), ret, dispatches: view.trs.length }
}
let compared = 0
/** The command gives what the command at the reference commit gives (nothing when the reference is not there). */
function sameAsReference(doc, anchor, head, dir, focus = null) {
  if (!moveNodeAtReference) return
  compared += 1
  assert.deepEqual(outcome(moveNode, doc, anchor, head, dir, focus), outcome(moveNodeAtReference, doc, anchor, head, dir, focus), `the same text, selection and answer as at ${REFERENCE_COMMIT}`)
}
/** Run one move. Answers the text, the caret's line (its text), what the command returned, and checks what every move owes. */
function move(doc, anchor, head, dir, focus = null) {
  sameAsReference(doc, anchor, head, dir, focus)
  const view = mount(doc, anchor, head, focus)
  const before = view.state.doc.toString()
  const ret = moveNode(view, dir)
  const text = view.state.doc.toString()
  const changed = text !== before
  // One dispatch at most; no typing mark; no user event (so no guard reads it as the person's typing).
  assert.ok(view.trs.length <= 1, `at most one dispatch (${view.trs.length})`)
  for (const tr of view.trs) {
    assert.equal(isKeyTyped(tr), false, 'the move carries no typing mark')
    assert.equal(tr.annotation(Transaction.userEvent), undefined, 'the move carries no user event')
  }
  if (!ret) assert.equal(text, before, 'a declined move changes nothing')
  if (!ret) assert.equal(view.trs.length, 0, 'a declined move dispatches nothing')
  // A pure reordering of whole lines (a heading that changes container changes its number of #).
  const bag = (t) => t.split('\n').map((l) => l.replace(/^#{1,6}(?=\s)/, '#')).sort()
  assert.deepEqual(bag(text), bag(before), 'the same lines, reordered')
  const caretLine = view.state.doc.lineAt(view.state.selection.main.head).text
  const caretPos = view.state.selection.main.head
  const range = focus ? currentFocusRange(view.state) : null
  // One Undo straight after this one move (the mount's history holds nothing else) restores the text before it.
  if (changed) {
    assert.equal(undoDepth(view.state), 1, 'one undo step')
    undo(view)
    assert.equal(view.state.doc.toString(), before, 'one Undo after an isolated move restores the text before it')
  }
  return { text, caretLine, caretPos, ret, changed, range }
}
const run = (marked, dir, focus = null) => {
  const { doc, head, anchor } = parse(marked)
  return { doc, ...move(doc, anchor, head, dir, focus) }
}
/** Expect the exact text and the caret's line. `wanted === null`: nothing moves. */
const expectMove = (label, marked, dir, wanted, caretLine) => check(label, () => {
  const r = run(marked, dir)
  assert.equal(r.text, wanted ?? r.doc)
  if (wanted === null) assert.equal(r.ret, false, 'the command declines')
  if (caretLine !== undefined) assert.equal(r.caretLine, caretLine, 'the caret follows the moved line')
})

// ── The app's recogniser, and a simple model beside it ───────────────────────────────────────
/** Every head of the text by the app's reading: [{ heading, lines: [text…] }] (the lines under the heading that are its head). */
function headsByApp(text) {
  const lines = text.split('\n')
  const fenced = fencedLineFlags(lines)
  let bs = 0
  if ((lines[0] ?? '').trim() === '---') { const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---'); if (end > 0) bs = end + 1 }
  const out = []
  for (let i = bs; i < lines.length; i += 1) {
    if (fenced[i] || !/^#{1,6}\s/.test(lines[i])) continue
    const block = logicalTriggerBlockAfterHeading(lines, i)
    out.push({ heading: lines[i], lines: block ? lines.slice(i + 1, block.end) : [] })
  }
  return out
}
/**
 * The simple model: front matter is the lines between a first `---` and the next; a fence runs from
 * a line starting ``` to the next line that is ``` alone; a heading is `#`…`######` and a space outside both; its
 * head is the run of lines made only of `{…}` groups under it, with the blank lines before that run.
 */
function headsByModel(text) {
  const lines = text.split('\n')
  const out = []
  let i = 0
  if (lines[0] === '---') { i = 1; while (i < lines.length && lines[i] !== '---') i += 1; i += 1 }
  let inFence = false
  const groupsOnly = (l) => /^\s*(\{[^{}]*\}\s*)+$/.test(l)
  for (; i < lines.length; i += 1) {
    if (inFence) { if (lines[i].trim() === '```') inFence = false; continue }
    if (lines[i].startsWith('```')) { inFence = true; continue }
    if (inFence || !/^#{1,6} /.test(lines[i])) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j += 1
    if (j >= lines.length || !groupsOnly(lines[j])) { out.push({ heading: lines[i], lines: [] }); continue }
    while (j < lines.length && groupsOnly(lines[j])) j += 1
    out.push({ heading: lines[i], lines: lines.slice(i + 1, j) })
  }
  return out
}
const title = (heading) => heading.replace(/^#{1,6}\s+/, '')
/** Heads keyed by the heading's text without its marks (titles are unique in every test document). */
const keyed = (heads) => Object.fromEntries(heads.map((h) => [title(h.heading), h.lines]))
/** The lines the app reads as code or comment (fencedLineFlags), sorted: a move that changes this list moved a fence's own line. */
const fencedTexts = (text) => { const lines = text.split('\n'); const flags = fencedLineFlags(lines); return lines.filter((_, i) => flags[i]).sort() }

// ── 1. The fault, and the same boundary for every arrangement of a head ───────────────────────
expectMove('issue 121: Move up on the body line under a layout line puts it above the heading',
  'Intro\n### Alpha\n{statement}\n|Body text\nMore', 'up', 'Intro\nBody text\n### Alpha\n{statement}\nMore', 'Body text')
expectMove('issue 121: the same with the slide first in the text',
  '### Alpha\n{statement}\nBody| text', 'up', 'Body text\n### Alpha\n{statement}', 'Body text')
expectMove('a heading whose only code is an icon: as any heading with no line under it (unchanged)',
  'Intro\n### Alpha {icon=lucide:star}\n|Body text', 'up', 'Intro\nBody text\n### Alpha {icon=lucide:star}', 'Body text')
expectMove('a heading with an icon and a layout line under it',
  'Intro\n### Alpha {icon=lucide:star}\n{statement}\n|Body text', 'up', 'Intro\nBody text\n### Alpha {icon=lucide:star}\n{statement}', 'Body text')

// Every arrangement of the lines under a heading. `bare` is the same slide with no line under its heading.
const ARRANGEMENTS = [
  ['a layout line', ['{statement}']],
  ['an id line', ['{id=a1}']],
  ['a layout line then an id line', ['{statement}', '{id=a1}']],
  ['an id line then a layout line', ['{id=a1}', '{statement}{title=side}']],
  ['id and layout on one line', ['{id=a1}{statement}']],
  ['three lines', ['{id=a1}', '{statement}', '{title=side}']],
  ['a blank line then a layout line', ['', '{statement}']],
  ['a blank line, an id line and a layout line', ['', '{id=a1}', '{cards}']]
]
// Body units, each with the caret (and selection) it is moved by. `@` is where the head lines go.
const UNITS = [
  ['a paragraph', 'P1\n### Zero\nZ1\nZ2\n### Alpha@\n|Body one\nBody two\n### Beta\nB1'],
  ['a paragraph, caret in its middle', 'P1\n### Zero\nZ1\n### Alpha@\nBody| one\nBody two\n### Beta\nB1'],
  ['the only body line', '### Zero\nZ1\n### Alpha@\n|Only\n### Beta\nB1'],
  ['an empty line', '### Zero\nZ1\n### Alpha@\n|\nBody\n### Beta\nB1'],
  ['the first list item', '### Zero\nZ1\n### Alpha@\n- |One\n- Two\n- Three\n### Beta\nB1'],
  ['the first list item, with items under it', '### Zero\nZ1\n### Alpha@\n- |One\n  - Sub a\n  - Sub b\n- Two\n### Beta\nB1'],
  ['a numbered item', '### Zero\nZ1\n### Alpha@\n1. |One\n2. Two\n### Beta\nB1'],
  ['the first line of a fenced block', '### Zero\nZ1\n### Alpha@\n|```js\n# not a heading\n{not-a-layout}\n```\nAfter\n### Beta\nB1'],
  ['a whole fenced block selected', '### Zero\nZ1\n### Alpha@\n^```js\n# not a heading\n{not-a-layout}\n``|`\nAfter\n### Beta\nB1'],
  ['the first line of a notes block', '### Zero\nZ1\n### Alpha@\n|:::notes\nSay this.\n:::\nAfter\n### Beta\nB1'],
  ['a whole notes block selected', '### Zero\nZ1\n### Alpha@\n^:::notes\nSay this.\n::|:\nAfter\n### Beta\nB1'],
  ['two paragraphs selected', '### Zero\nZ1\n### Alpha@\n^Body one\nBody| two\nBody three\n### Beta\nB1'],
  ['two paragraphs selected backwards', '### Zero\nZ1\n### Alpha@\n|Body one\nBody^ two\nBody three\n### Beta\nB1'],
  ['a picture line', '### Zero\nZ1\n### Alpha@\n|![Alt](pic.png)\nAfter\n### Beta\nB1'],
  ['a quotation line', '### Zero\nZ1\n### Alpha@\n|> Quoted\nAfter\n### Beta\nB1'],
  // Moving down from the last position of the slide ABOVE the head.
  ['the last paragraph of the slide above', '### Zero\nZ1\n|Z2\n### Alpha@\nBody one\n### Beta\nB1'],
  ['the last list item of the slide above', '### Zero\n- Z1\n- |Z2\n### Alpha@\nBody one\n### Beta\nB1'],
  ['two last paragraphs of the slide above, selected', '### Zero\n^Z1\nZ|2\n### Alpha@\nBody one\n### Beta\nB1'],
  ['a line before the first heading', '|Intro\n### Alpha@\nBody one\n### Beta\nB1'],
  // The first and the last slide of the text.
  ['a paragraph of the first slide', '### Alpha@\n|Body one\nBody two\n### Beta\nB1'],
  ['the last line of the last slide', '### Zero\nZ1\n### Alpha@\nBody one\n|Body two'],
  ['the only line of the last slide', '### Zero\nZ1\n### Alpha@\n|Only'],
  ['a paragraph under a section heading', '## Part\nP\n## Alpha@\n|Body one\n### Beta\nB1'],
  ['a paragraph under the talk title', '---\ntitle: T\n---\n# Alpha@\n|Body one\n## Beta\nB1']
]
// A head line is a line made only of {…} groups; the test documents hold no other such line outside a fence, so
// taking them out (with the blank line the two "blank line" arrangements put before them) gives the bare slide.
const withHead = (template, lines) => template.replace('@', lines.map((l) => '\n' + l).join(''))
const stripHead = (text, lines) => {
  const block = lines.map((l) => '\n' + l).join('')
  assert.equal(text.split(block).length, 2, `the head lines stand together, once, in ${JSON.stringify(text)}`)
  return text.replace(block, '')
}
for (const [unit, template] of UNITS) {
  for (const dir of ['up', 'down']) {
    let bare = null
    check(`${unit}, ${dir}, under a heading with no line under it`, () => { bare = run(withHead(template, []), dir) })
    if (!bare) continue
    for (const [name, lines] of ARRANGEMENTS) {
      check(`${unit}, ${dir}, under ${name}: as under a heading with no line under it, the head whole`, () => {
        const r = run(withHead(template, lines), dir)
        // The head lines are still together, in order, directly under the heading.
        assert.ok(r.text.includes('Alpha' + lines.map((l) => '\n' + l).join('') + '\n') || r.text.endsWith('Alpha' + lines.map((l) => '\n' + l).join('')), `the head is whole: ${JSON.stringify(r.text)}`)
        assert.equal(stripHead(r.text, lines), bare.text, 'the same move as with no line under the heading')
        assert.equal(r.caretLine, bare.caretLine, 'the caret on the same line')
        assert.equal(r.ret, bare.ret, 'the same answer')
        // (The opening line of a fence moved alone, as the command moves any one line, changes what is code: the
        // headings the app reads then differ, with or without lines under the heading.)
        if (!template.includes('|```')) assert.deepEqual(keyed(headsByApp(r.text)), keyed(headsByApp(r.doc)), 'every head as the app read it before')
      })
    }
  }
}

// What the boundary is, said once in full (the bare heading: recorded from the command before the fix).
expectMove('boundary, bare heading: a paragraph moved up from the first body line goes above the heading',
  '### Zero\nZ1\n### Alpha\n|Body\nMore', 'up', '### Zero\nZ1\nBody\n### Alpha\nMore', 'Body')
expectMove('boundary, bare heading: a paragraph moved down from the last line goes under the next heading',
  '### Alpha\n|Body\n### Beta\nB1', 'down', '### Alpha\n### Beta\nBody\nB1', 'Body')
expectMove('boundary, bare heading: the first list item moved up stays', '### Alpha\n- |One\n- Two', 'up', null)
expectMove('boundary, bare heading: the last list item moved down stays', '### Alpha\n- One\n- |Two\n### Beta', 'down', null)
expectMove('boundary, head: a paragraph moved down lands under the next heading\'s layout and id lines',
  '### Alpha\n|Body\n### Beta\n{id=b1}\n{statement}\nB1', 'down', '### Alpha\n### Beta\n{id=b1}\n{statement}\nBody\nB1', 'Body')
expectMove('boundary, head: the first list item under a layout line stays (before: it went between heading and layout line)',
  '### Alpha\n{statement}\n- |One\n- Two', 'up', null)
expectMove('boundary, head: the first list item under a blank line under a layout line stays',
  '### Alpha\n{statement}\n\n- |One\n- Two', 'up', null)
expectMove('a list item under a paragraph under a head moves past the paragraph only',
  '### Alpha\n{id=a1}\n{statement}\nPara one\nPara two\n- |One', 'up', '### Alpha\n{id=a1}\n{statement}\n- One\nPara one\nPara two', '- One')
expectMove('a chart token that owns its list is body: the item moves past it, not past the id line over it',
  '### Alpha\n{id=a1}\n{barchart}\n- |A: 1', 'up', '### Alpha\n{id=a1}\n- A: 1\n{barchart}', '- A: 1')

// A line of groups that a move put directly under a head is part of that head from then on.
expectMove('a body line moved down past a stray layout line: the layout line joins the head',
  '### A\n{id=a}\n|Body\n{cards}\nTail\n### B\nB', 'down', '### A\n{id=a}\n{cards}\nBody\nTail\n### B\nB', 'Body')
expectMove('the caret on a layout line that joined the head: the whole slide moves',
  '### A\n{id=a}\n|{cards}\nBody\nTail\n### B\nB', 'down', '### B\nB\n### A\n{id=a}\n{cards}\nBody\nTail', '{cards}')

// ── 2. The caret on a head line moves the slide ──────────────────────────────────────────────
const SLIDES = '### Zero\nZ1\n### Alpha\n{id=a1}\n{statement}\nBody\n### Beta\n{id=b1}\nB1'
for (const [where, marked, caretLine] of [
  ['the heading', '### Zero\nZ1\n### Al|pha\n{id=a1}\n{statement}\nBody\n### Beta\n{id=b1}\nB1', '### Alpha'],
  ['the id line', '### Zero\nZ1\n### Alpha\n{id=|a1}\n{statement}\nBody\n### Beta\n{id=b1}\nB1', '{id=a1}'],
  ['the layout line', '### Zero\nZ1\n### Alpha\n{id=a1}\n|{statement}\nBody\n### Beta\n{id=b1}\nB1', '{statement}'],
  ['the end of the layout line', '### Zero\nZ1\n### Alpha\n{id=a1}\n{statement}|\nBody\n### Beta\n{id=b1}\nB1', '{statement}']
]) {
  expectMove(`caret on ${where}, up: the whole slide moves`, marked, 'up', '### Alpha\n{id=a1}\n{statement}\nBody\n### Zero\nZ1\n### Beta\n{id=b1}\nB1', caretLine)
  expectMove(`caret on ${where}, down: the whole slide moves`, marked, 'down', '### Zero\nZ1\n### Beta\n{id=b1}\nB1\n### Alpha\n{id=a1}\n{statement}\nBody', caretLine)
}
expectMove('caret on the blank line between a heading and its layout line: the whole slide moves',
  '### Zero\nZ1\n### Alpha\n|\n{statement}\nBody', 'up', '### Alpha\n\n{statement}\nBody\n### Zero\nZ1', '')
expectMove('caret on the layout line of the first slide, up: nothing moves', '### Alpha\n|{statement}\nBody\n### Beta\nB1', 'up', null)
expectMove('caret on the id line of the last slide, down: nothing moves', '### Alpha\nBody\n### Beta\n{id=|b1}\nB1', 'down', null)
expectMove('caret on the layout line under the talk title: nothing moves', '# Talk\n|{theme=dark}\nIntro\n## One\nO1', 'up', null)
expectMove('a selection from the heading into the body, caret on the layout line: the slide moves',
  '### Zero\nZ1\n^### Alpha\n{state|ment}\nBody', 'up', '### Alpha\n{statement}\nBody\n### Zero\nZ1', '{statement}')
// A slide that leaves its section goes in under the receiving heading's whole head.
expectMove('a slide moved down into the next section lands under that section\'s id and layout lines',
  '## A\n### |s1\n{id=s1}\nS\n## B\n{id=b}\n{section}\n### s2', 'down', '## A\n## B\n{id=b}\n{section}\n### s1\n{id=s1}\nS\n### s2', '### s1')
expectMove('the same with the caret on the moved slide\'s id line',
  '## A\n### s1\n{id=|s1}\nS\n## B\n{id=b}\n{section}\n### s2', 'down', '## A\n## B\n{id=b}\n{section}\n### s1\n{id=s1}\nS\n### s2', '{id=s1}')
expectMove('a slide moved down into a section with a blank line before its layout line',
  '## A\n### |s1\nS\n## B\n\n{section}\n### s2', 'down', '## A\n## B\n\n{section}\n### s1\nS\n### s2', '### s1')
expectMove('a slide moved up out of its section, caret on its layout line',
  '## A\n{id=a}\n### a1\n## B\n{id=b}\n### b1\n|{statement}\nBody', 'up', '## A\n{id=a}\n### a1\n### b1\n{statement}\nBody\n## B\n{id=b}', '{statement}')
check('moveHeadingBlock: one layout line under the receiving heading, as before the fix', () => {
  assert.deepEqual(moveHeadingBlock('## A\n### s1\n## B\n{section}\n### s2'.split('\n'), 1, 'down', 0),
    { lines: '## A\n## B\n{section}\n### s1\n### s2'.split('\n'), caret: 3 })
  assert.deepEqual(moveHeadingBlock('## A\n### s1\n## B\n### s2'.split('\n'), 1, 'down', 0),
    { lines: '## A\n## B\n### s1\n### s2'.split('\n'), caret: 2 })
})

// ── 3. A selection that takes in a head line, with the caret in the body ─────────────────────
for (const dir of ['up', 'down']) {
  expectMove(`a selection from the layout line into the body, caret in the body, ${dir}: nothing moves`,
    '### Zero\nZ1\n### Alpha\n^{statement}\nBody| one\nBody two\n### Beta\nB1', dir, null)
  expectMove(`a selection from the heading into the body, caret in the body, ${dir}: nothing moves`,
    '### Zero\nZ1\n^### Alpha\n{statement}\nBody| one\nBody two\n### Beta\nB1', dir, null)
  expectMove(`a selection from a body line into the next slide's heading, caret in the body above, ${dir}: nothing moves`,
    '### Zero\nZ1\n### Alpha\n{statement}\n|Body one\nBody two\n### Be^ta\n{id=b1}\nB1', dir, null)
  expectMove(`a selection from the body down to the next slide's id line, ${dir}: the slide of the caret's head line moves or stays whole`,
    '### Zero\nZ1\n### Alpha\n{statement}\n^Body one\nBody two\n### Beta\n{id=|b1}\nB1', dir,
    dir === 'up' ? '### Zero\nZ1\n### Beta\n{id=b1}\nB1\n### Alpha\n{statement}\nBody one\nBody two' : null)
}

// ── 4. Where no head with extra lines is in reach: what the command gave before the fix ──────
// Every expected text here was recorded from the command before the fix.
for (const [label, marked, dir, wanted] of [
  ['two body lines swap', '### A\nOne\n|Two\nThree', 'up', '### A\nTwo\nOne\nThree'],
  ['two body lines swap, down', '### A\nOne\n|Two\nThree', 'down', '### A\nOne\nThree\nTwo'],
  ['a body line and an empty line swap', '### A\nOne\n\n|Two', 'up', '### A\nOne\nTwo\n'],
  ['list items swap', '### A\n- One\n- |Two\n- Three', 'up', '### A\n- Two\n- One\n- Three'],
  ['an item moves with the items under it', '### A\n- |One\n  - Sub\n- Two', 'down', '### A\n- Two\n- One\n  - Sub'],
  ['the first item moves past the prose above it', '### A\nProse one\nProse two\n\n- |One\n- Two', 'up', '### A\n- One\n\nProse one\nProse two\n- Two'],
  ['the last item moves past the prose under it', '### A\n- One\n- |Two\n\nProse one\nProse two', 'down', '### A\n- One\nProse one\nProse two\n\n- Two'],
  ['sibling slides swap', '### A\na\n### |B\nb', 'up', '### B\nb\n### A\na'],
  ['sibling slides swap, down', '### |A\na\n### B\nb', 'down', '### B\nb\n### A\na'],
  ['slides with layout lines swap', '### A\n{statement}\na\n### |B\n{id=b}\nb', 'up', '### B\n{id=b}\nb\n### A\n{statement}\na'],
  ['a slide leaves its section, down', '## P\n### subA\n#### a1\n#### |a2\n### subB\n#### b1', 'down', '## P\n### subA\n#### a1\n### subB\n#### a2\n#### b1'],
  ['a slide leaves its section, up', '## P\n### subB\n#### |b1\n#### b2', 'up', '## P\n### b1\n### subB\n#### b2'],
  ['a selection of two body lines moves as one', '### A\nOne\n^Two\nTh|ree\nFour', 'down', '### A\nOne\nFour\nTwo\nThree'],
  ['a line in a fenced block moves as a line', '### A\n```\none\n|two\n```', 'up', '### A\n```\ntwo\none\n```'],
  ['a layout line that is not under its heading is a body line', '### A\nBody\n|{statement}\nMore', 'down', '### A\nBody\nMore\n{statement}'],
  ['a body line moved under a bare heading over a stray layout line', '### A\n|Body\n{statement}', 'down', '### A\n{statement}\nBody'],
  ['a paragraph past a bare heading, up', 'Intro\n### A\n|Body', 'up', 'Intro\nBody\n### A'],
  ['the first slide, up: nothing', '### |A\na\n### B\nb', 'up', null],
  ['the last slide, down: nothing', '### A\na\n### |B\nb', 'down', null],
  ['the last line of the text, down: nothing', '### A\na\n|b', 'down', null],
  ['the caret in the front matter: nothing', '---\ntit|le: T\n---\n# Talk\nBody', 'down', undefined]
]) {
  check(`unchanged: ${label}`, () => {
    const r = run(marked, dir)
    assert.equal(r.text, wanted ?? r.doc)
    if (wanted === null) assert.equal(r.ret, false)
    if (wanted === undefined) assert.equal(r.ret, true, 'the front matter consumes the key')
  })
}

// ── 5. Slide Focus ───────────────────────────────────────────────────────────────────────────
// The band is the one the app sets (slideFocusModel.ts focusRangeForSlideLine): the slide's heading
// line to its last line with text. A move that would change a line outside it, its first line, or
// put a line above it, is declined; the band is then exactly what it was.
const FOCUS_DOC = '### One\n{id=o1}\nO1\nO2\n\n### Two\n{id=t1}\n{statement}\nT1\nT2\nT3\n\n### Three\nH1\nH2'
const focusLines = { first: 1, middle: 6, last: 13 }
const inFocus = (label, which, find, dir, wanted) => check(`Slide Focus, ${which} slide: ${label}`, () => {
  const range = focusRangeForSlideLine(FOCUS_DOC, focusLines[which])
  assert.ok(range, 'the slide has a band')
  const at = FOCUS_DOC.indexOf(find)
  assert.ok(at >= range.from && at <= range.to, 'the caret is in the band')
  const r = move(FOCUS_DOC, at, at, dir, range)
  assert.equal(r.text, wanted ?? FOCUS_DOC)
  if (wanted === null) {
    assert.equal(r.ret, false, 'the command declines')
    assert.deepEqual(r.range, range, 'the band is what it was')
  } else {
    // The band still starts at the slide's heading and holds the same lines.
    assert.equal(r.range.from, range.from)
    assert.equal(r.text.slice(r.range.from, r.range.to).split('\n').length, FOCUS_DOC.slice(range.from, range.to).split('\n').length)
    assert.equal(r.text.slice(0, range.from), FOCUS_DOC.slice(0, range.from), 'nothing above the band changed')
    assert.equal(r.text.slice(r.range.to), FOCUS_DOC.slice(range.to), 'nothing under the band changed')
  }
})
for (const [which, firstBody, lastBody, heading, headLine] of [
  ['first', 'O1', 'O2', '### One', '{id=o1}'], ['middle', 'T1', 'T3', '### Two', '{statement}'], ['last', 'H1', 'H2', '### Three', null]
]) {
  inFocus('the first body line, up: declined (it would leave the slide)', which, firstBody, 'up', null)
  inFocus('the last body line, down: declined', which, lastBody, 'down', null)
  inFocus('the heading, up: declined', which, heading, 'up', null)
  inFocus('the heading, down: declined', which, heading, 'down', null)
  if (headLine) inFocus('a head line, up: declined', which, headLine, 'up', null)
  if (headLine) inFocus('a head line, down: declined', which, headLine, 'down', null)
}
inFocus('the first body line, down: moves inside the band', 'middle', 'T1', 'down', FOCUS_DOC.replace('T1\nT2', 'T2\nT1'))
inFocus('the last body line, up: moves inside the band', 'middle', 'T3', 'up', FOCUS_DOC.replace('T2\nT3', 'T3\nT2'))
inFocus('the first body line, down: moves inside the band', 'first', 'O1', 'down', FOCUS_DOC.replace('O1\nO2', 'O2\nO1'))
inFocus('the last body line, up: moves inside the band', 'last', 'H2', 'up', FOCUS_DOC.replace('H1\nH2', 'H2\nH1'))

// ── 6. The generated run ─────────────────────────────────────────────────────────────────────
// A fixed seed. Every line of a generated document is unique, so "the same lines directly under the
// same heading" is a comparison of texts. STRICT documents hold no line of {…} groups in a slide's
// body: every head must be read after the move exactly as before, by the app's recogniser and by the
// model. LOOSE documents also hold stray layout lines and chart tokens in the body; one of those
// moved to stand directly under a head joins it by the app's reading (as it does when typed there)
// and is part of it from then on: there each head AS THE APP READ IT BEFORE THE MOVE (the generated
// lines and every line that has joined since) must still be the first lines under its heading, in
// order, and each head as generated too.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function generate(rand, loose) {
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))
  const lines = []
  /** title -> its head lines, as generated. */
  const heads = new Map()
  let n = 0
  const uid = () => (n += 1)
  if (rand() < 0.4) lines.push('---', `title: T${uid()}`, `author: A${uid()}`, '---')
  if (rand() < 0.3) lines.push(`Loose line ${uid()}`)
  const headLines = () => {
    const k = uid()
    const layout = `{${pick(['statement', 'cards', 'compare', 'list', 'quote'])}}{kicker="k${k}"}`
    const id = `{id=s${k}}`
    return pick([
      [], [], [layout], [id], [id, layout], [layout, id], [`${id}${layout}`], [id, layout, `{title=side}{note="n${k}"}`],
      ['', layout], ['', id, layout]
    ])
  }
  const body = () => {
    const out = []
    for (let u = int(0, 4); u > 0; u -= 1) {
      const kind = pick(['para', 'para', 'blank', 'list', 'list', 'fence', 'notes', 'paras', ...(loose ? ['stray', 'chart', 'stray'] : [])])
      if (kind === 'para') out.push(`Paragraph ${uid()}`)
      else if (kind === 'paras') out.push(`Paragraph ${uid()}`, `Paragraph ${uid()}`, `Paragraph ${uid()}`)
      else if (kind === 'blank') { if (out.length) out.push('') }
      else if (kind === 'list') {
        const marker = pick(['- ', '* ', '1. '])
        for (let k = int(1, 4); k > 0; k -= 1) {
          out.push(`${marker}Item ${uid()}`)
          if (rand() < 0.3) out.push(`  - Sub ${uid()}`)
          if (rand() < 0.1) out.push(`  continued ${uid()}`)
        }
      } else if (kind === 'fence') out.push('```js', `# fenced ${uid()}`, `{fenced${uid()}}`, `code ${uid()}`, '```')
      else if (kind === 'notes') out.push(':::notes', `Note ${uid()}`, ':::')
      else if (kind === 'stray') out.push(`{${pick(['statement', 'cards', 'reveal'])}}{kicker="stray${uid()}"}`)
      else if (kind === 'chart') out.push('{barchart}', `- A${uid()}: 1`, `- B${uid()}: 2`)
    }
    // In a strict document the first body line is never blank followed by nothing head-like; a blank first line is fine.
    return out
  }
  if (rand() < 0.5) {
    const t = `Talk ${uid()}`
    const h = rand() < 0.4 ? [`{theme=t${uid()}}`] : []
    heads.set(t, h)
    lines.push(`# ${t}`, ...h, ...body())
  }
  let level = 2
  for (let s = int(1, 7); s > 0; s -= 1) {
    level = Math.max(2, Math.min(5, level + pick([-1, 0, 0, 1])))
    const t = `Slide ${uid()}${rand() < 0.2 ? ` {icon=lucide:i${uid()}}` : ''}`
    const h = headLines()
    heads.set(t, h)
    lines.push(`${'#'.repeat(level)} ${t}`, ...h, ...body())
  }
  // A strict document: a body never starts with a blank line (a blank line under a bare heading, with a body line of
  // groups after it, is not made here, but keep the rule simple: no body of a strict document holds a groups-only line).
  return { text: lines.join('\n'), heads }
}
function checkHeads(before, after, heads, loose, chartTally = null) {
  const lines = after.split('\n')
  // The model's own reading of the generated heads: physically, each is still directly under its heading, in order.
  for (const [t, h] of heads) {
    const at = lines.findIndex((l) => /^#{1,6} /.test(l) && title(l) === t)
    assert.ok(at >= 0, `the heading ${t} is there`)
    assert.deepEqual(lines.slice(at + 1, at + 1 + h.length), h, `the head of "${t}" is whole and directly under it`)
  }
  const app = keyed(headsByApp(after))
  const model = keyed(headsByModel(after))
  const appBefore = keyed(headsByApp(before))
  assert.deepEqual(Object.keys(app).sort(), Object.keys(appBefore).sort(), 'the same headings')
  if (!loose) {
    assert.deepEqual(app, appBefore, 'every head as the app read it before')
    assert.deepEqual(model, keyed(headsByModel(before)), 'every head as the model read it before')
    assert.deepEqual(app, model, 'the app and the model read the same heads')
    for (const [t, h] of heads) assert.deepEqual(app[t], h, `the head of "${t}" as generated`)
  } else {
    // What was generated as a head line is still one by the app's reading, in order, first under its heading. (A
    // stray line of groups moved to stand next to a head joins it at its end.)
    for (const [t, gen] of heads) assert.deepEqual(app[t].slice(0, gen.length), gen, `the head of "${t}" starts with its generated lines`)
    // And every line the app read as part of a head before this move (a stray line that joined it in an earlier
    // move among them) is still part of it, in order: a head grows at its end, never loses or reorders a line.
    // One way a line stops being read as a head line without being moved: a chart token with no list under it is a
    // head line, and with a list item moved to stand under it it is a chart (body) and ends the head. The lines are
    // then still where they were, directly under the heading, in order.
    for (const [t, was] of Object.entries(appBefore)) {
      const at = lines.findIndex((l) => /^#{1,6} /.test(l) && title(l) === t)
      assert.deepEqual(lines.slice(at + 1, at + 1 + was.length), was, `the lines the app read as the head of "${t}" before the move are still directly under it, in order`)
      if (app[t].length >= was.length) continue
      assert.ok(/^\{barchart\}$/.test(was[app[t].length]) && /^\s*([-*]|\d+\.) /.test(lines[at + 2 + app[t].length] ?? ''), `the head of "${t}" is shorter only by a chart token that now has a list under it`)
      if (chartTally) chartTally.count += 1
    }
  }
}
const totals = { strict: { moves: 0, changed: 0, fences: 0, grew: 0 }, loose: { moves: 0, changed: 0, fences: 0, grew: 0 }, focus: { moves: 0, changed: 0, declinedAtEdge: 0 } }
for (const loose of [false, true]) {
  const rand = rng(loose ? 121002 : 121001)
  const tally = totals[loose ? 'loose' : 'strict']
  let firstFailure = null
  const chartTally = { count: 0 }
  for (let d = 0; d < 400 && !firstFailure; d += 1) {
    const { text: start, heads } = generate(rand, loose)
    let text = start
    for (let step = 0; step < 25; step += 1) {
      const head = Math.floor(rand() * (text.length + 1))
      let anchor = rand() < 0.3 ? Math.max(0, Math.min(text.length, head + Math.floor((rand() - 0.5) * 80))) : head
      // (Not made here: a selection that starts in the front matter with the caret under it. The command moves the
      // selected front matter lines with the rest, before the fix as after; reported with issue 121.)
      const bodyFrom = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) + 5 : 0
      if (head >= bodyFrom && anchor < bodyFrom) anchor = head
      const dir = rand() < 0.5 ? 'up' : 'down'
      try {
        const r = move(text, anchor, head, dir)
        tally.moves += 1
        if (r.changed) {
          tally.changed += 1
          // The caret is on the line it was on (a heading that changed container has other marks).
          const was = text.split('\n')[text.slice(0, head).split('\n').length - 1]
          assert.equal(r.caretLine.replace(/^#{1,6}(?=\s)/, '#'), was.replace(/^#{1,6}(?=\s)/, '#'), 'the caret stays on its line')
          // (Not held here: the first line under the front matter, moved up, changes places with the closing `---`.
          // The command did that before the fix, no head is in reach, and it is reported with issue 121.)
        }
        // A line of a fence moved alone (as the command moves any one line, before the fix as after) changes what
        // is code and what is a heading: the lines and the Undo were checked, and the move is not kept.
        if (JSON.stringify(fencedTexts(r.text)) !== JSON.stringify(fencedTexts(text))) { tally.fences += 1; continue }
        checkHeads(text, r.text, heads, loose, chartTally)
        const total = (t) => headsByApp(t).reduce((n, h) => n + h.lines.length, 0)
        if (total(r.text) > total(text)) tally.grew += 1
        text = r.text
      } catch (e) {
        firstFailure = `${String(e.message).split('\n')[0]} | document ${d} step ${step} ${dir} anchor ${anchor} head ${head} | ${JSON.stringify(text)}`
        break
      }
    }
  }
  check(`generated run, ${loose ? 'loose' : 'strict'} documents (seed ${loose ? 121002 : 121001}): heads whole, lines kept, one Undo after each isolated move`, () => {
    assert.equal(firstFailure, null)
    assert.ok(tally.changed > 1500, `enough moves changed the text (${tally.changed} of ${tally.moves})`)
    // The loose run does make heads grow (a stray line joins one), so "still part of it from then on" is exercised.
    if (loose) assert.ok(tally.grew > 20, `enough moves made a head grow (${tally.grew})`)
    else assert.equal(tally.grew, 0, 'no head of a strict document changes')
    tally.charts = chartTally.count
  })
}
// Slide Focus, generated: the caret anywhere in the focused band.
{
  const rand = rng(121003)
  const tally = totals.focus
  let firstFailure = null
  for (let d = 0; d < 300 && !firstFailure; d += 1) {
    const { text, heads } = generate(rand, false)
    const lines = text.split('\n')
    const fenced = fencedLineFlags(lines)
    const headingLines = lines.map((l, i) => (!fenced[i] && /^#{1,6} /.test(l) && i >= (text.startsWith('---\n') ? 4 : 0) ? i + 1 : 0)).filter(Boolean)
    for (let step = 0; step < 12; step += 1) {
      const line = headingLines[Math.floor(rand() * headingLines.length)]
      const range = focusRangeForSlideLine(text, line)
      if (!range) continue
      const head = range.from + Math.floor(rand() * (range.to - range.from + 1))
      const dir = rand() < 0.5 ? 'up' : 'down'
      try {
        const r = move(text, head, head, dir, range)
        tally.moves += 1
        if (r.changed) {
          tally.changed += 1
          assert.equal(r.range.from, range.from, 'the band starts where it did')
          assert.equal(r.text.slice(0, range.from), text.slice(0, range.from), 'nothing above the band changed')
          assert.equal(r.text.slice(r.range.to), text.slice(range.to), 'nothing under the band changed')
          assert.equal(r.text.split('\n')[line - 1], lines[line - 1], 'the band\'s first line is the slide\'s heading')
          assert.deepEqual(r.range, focusRangeForSlideLine(r.text, line) && { from: range.from, to: r.range.to }, 'a band')
          assert.ok(r.caretPos >= r.range.from && r.caretPos <= r.range.to, 'the caret is in the band')
        } else {
          tally.declinedAtEdge += 1
          assert.deepEqual(r.range, range, 'the band is what it was')
        }
        if (JSON.stringify(fencedTexts(r.text)) === JSON.stringify(fencedTexts(text))) checkHeads(text, r.text, heads, false)
      } catch (e) {
        firstFailure = `${String(e.message).split('\n')[0]} | document ${d} step ${step} ${dir} line ${line} head ${head} | ${JSON.stringify(text)}`
        break
      }
    }
  }
  check('generated run, Slide Focus (seed 121003): nothing outside the focused band changes, its heading stays first', () => {
    assert.equal(firstFailure, null)
    assert.ok(tally.changed > 200, `enough moves changed the text (${tally.changed} of ${tally.moves})`)
  })
}

// ── 7. The same result as the command at the reference commit, multi-line selections ─────────
// 2,000 more generated documents (1,000 strict, 1,000 loose), each with four random selections that
// span more than one line (any two offsets, the front matter included), moved up and down.
const equivalence = { documents: 0, inputs: 0, changed: 0, declined: 0 }
if (moveNodeAtReference) {
  const rand = rng(121004)
  let firstFailure = null
  for (let d = 0; d < 2000 && !firstFailure; d += 1) {
    const { text } = generate(rand, d % 2 === 1)
    equivalence.documents += 1
    for (let k = 0; k < 4 && !firstFailure; k += 1) {
      let anchor = 0
      let head = 0
      for (let tries = 0; tries < 50; tries += 1) {
        head = Math.floor(rand() * (text.length + 1))
        // Half reach a few lines, half reach anywhere in the text.
        anchor = rand() < 0.5 ? Math.floor(rand() * (text.length + 1)) : Math.max(0, Math.min(text.length, head + Math.floor((rand() - 0.5) * 160)))
        if (text.slice(Math.min(anchor, head), Math.max(anchor, head)).includes('\n')) break
      }
      for (const dir of ['up', 'down']) {
        try {
          sameAsReference(text, anchor, head, dir)
          const o = outcome(moveNode, text, anchor, head, dir, null)
          equivalence.inputs += 1
          if (o.text !== text) equivalence.changed += 1
          if (!o.ret) equivalence.declined += 1
        } catch (e) {
          firstFailure = `${String(e.message).split('\n')[0]} | document ${d} ${dir} anchor ${anchor} head ${head} | ${JSON.stringify(text)}`
        }
      }
    }
  }
  check(`the same result as the command at ${REFERENCE_COMMIT}: 2,000 documents, multi-line selections (seed 121004)`, () => {
    assert.equal(firstFailure, null)
    assert.equal(equivalence.inputs, 16000)
    assert.ok(equivalence.changed > 1000 && equivalence.declined > 1000, `moves that changed the text and moves declined are both there (${equivalence.changed}, ${equivalence.declined})`)
  })
}

// ── 8. Time ──────────────────────────────────────────────────────────────────────────────────
// The selection loop asked, for each selected line, which head holds it, and each answer scanned back
// to a heading: 30,000 selected lines took seconds. One pass now. Each budget is many times what the
// command takes here and well under what the reference commit took where it was slow (measured times
// in the summary line; TW_MOVE_TIMES=1 lists every one, the reference commit's beside it).
const times = []
function timed(label, doc, anchor, head, dir, budgetMs, wanted) {
  const one = (command) => {
    let best = Infinity
    let result = null
    for (let k = 0; k < 3; k += 1) {
      const view = mount(doc, anchor, head)
      const t0 = performance.now()
      const ret = command(view, dir)
      best = Math.min(best, performance.now() - t0)
      result = { text: view.state.doc.toString(), selection: view.state.selection.toJSON(), ret }
    }
    return { ms: best, result }
  }
  const now = one(moveNode)
  const reference = moveNodeAtReference ? one(moveNodeAtReference) : null
  times.push({ label, ms: now.ms, referenceMs: reference ? reference.ms : null, budgetMs })
  check(`time: ${label} within ${budgetMs} ms`, () => {
    wanted(now.result)
    if (reference) assert.ok(now.result.text === reference.result.text && JSON.stringify(now.result.selection) === JSON.stringify(reference.result.selection) && now.result.ret === reference.result.ret, `the same result as at ${REFERENCE_COMMIT}`)
    assert.ok(now.ms < budgetMs, `${now.ms.toFixed(1)} ms, budget ${budgetMs} ms`)
  })
}
{
  // The review's reproduction: 30,000 body lines, no heading; lines 2 to 29,999 selected; down.
  const body = Array.from({ length: 30000 }, (_, i) => `Body ${i}`)
  const doc = body.join('\n')
  timed('30,000 body lines, all but the first and last selected, down', doc, 7, doc.lastIndexOf('\n') - 1, 'down', 400, (r) => {
    assert.equal(r.ret, true)
    assert.ok(r.text === [body[0], body[29999], ...body.slice(1, 29999)].join('\n'), 'the selected lines went under the last line')
  })
  timed('30,000 body lines, the same selection, up', doc, 7, doc.lastIndexOf('\n') - 1, 'up', 400, (r) => {
    assert.ok(r.text === [...body.slice(1, 29999), body[0], body[29999]].join('\n'), 'the selected lines went above the first line')
  })
  // A list item under 30,000 lines of prose moves past the prose (the other place a head was asked for line by line).
  const prose = [...body, '- Item'].join('\n')
  timed('a list item under 30,000 lines of prose, up', prose, prose.length, prose.length, 'up', 400, (r) => {
    assert.ok(r.text === ['- Item', ...body].join('\n'), 'the item went above the prose')
  })
  // A talk of 3,000 slides, each with a layout line and an id line.
  const slide = (k) => [`### Slide ${k}`, '{statement}', `{id=s${k}}`, `Body ${k} a`, `Body ${k} b`]
  const slides = Array.from({ length: 3000 }, (_, k) => slide(k))
  const talk = slides.flat().join('\n')
  const at = (needle) => talk.indexOf(needle)
  timed('3,000 slides: the caret on a body line in the middle, down', talk, at('Body 1500 a'), at('Body 1500 a'), 'down', 400, (r) => {
    assert.ok(r.text === talk.replace('Body 1500 a\nBody 1500 b', 'Body 1500 b\nBody 1500 a'), 'the two body lines changed places')
  })
  timed('3,000 slides: the caret on a layout line in the middle, down (the slide moves)', talk, at('{id=s1500}') - 2, at('{id=s1500}') - 2, 'down', 400, (r) => {
    assert.ok(r.text === [...slides.slice(0, 1500), slides[1501], slides[1500], ...slides.slice(1502)].flat().join('\n'), 'slides 1500 and 1501 changed places')
  })
  timed('3,000 slides: the whole talk selected, the caret at its end, down (nothing moves)', talk, 0, talk.length, 'down', 400, (r) => {
    assert.equal(r.ret, false)
    assert.ok(r.text === talk, 'nothing moved')
  })
  timed('3,000 slides: the whole talk selected, the caret at its start, down (the first slide moves)', talk, talk.length, 0, 'down', 400, (r) => {
    assert.ok(r.text === [slides[1], slides[0], ...slides.slice(2)].flat().join('\n'), 'the first two slides changed places')
  })
  // The body of one slide selected in a talk whose slides are long: 3,000 slides, the last with 20,000 body lines.
  const long = [...slides.flat(), '### Long', '{statement}', '{id=long}', ...body.slice(0, 20000)]
  const longText = long.join('\n')
  timed('3,000 slides and one of 20,000 body lines: all its body but the last line selected, down', longText, longText.indexOf('Body 0\n'), longText.lastIndexOf('\n') - 1, 'down', 400, (r) => {
    assert.ok(r.text === [...long.slice(0, 15003), body[19999], ...body.slice(0, 19999)].join('\n'), 'the selected lines went under the last line')
  })
}
if (process.env.TW_MOVE_TIMES) for (const t of times) console.log(`time: ${t.ms.toFixed(1)} ms${t.referenceMs === null ? '' : ` (at ${REFERENCE_COMMIT}: ${t.referenceMs.toFixed(1)} ms)`}, budget ${t.budgetMs} ms: ${t.label}`)

if (failed.length) {
  // TW_ALL_FAILS=1 lists every failed check; otherwise the first 60.
  const shown = process.env.TW_ALL_FAILS ? failed.length : 60
  for (const line of failed.slice(0, shown)) console.error('FAIL:', line)
  if (failed.length > shown) console.error(`… and ${failed.length - shown} more`)
  console.error(`\nmove-node-heads: ${failed.length} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`move-node-heads: all ${checks} checks passed (generated: strict ${totals.strict.changed}/${totals.strict.moves} moves changed the text, loose ${totals.loose.changed}/${totals.loose.moves}, ${totals.strict.fences + totals.loose.fences} moves of a fence's own line not kept, Slide Focus ${totals.focus.changed}/${totals.focus.moves}; ${totals.loose.grew} loose moves made a head grow, ${totals.loose.charts} made a chart token under a head a chart; ${moveNodeAtReference ? `same result as at ${REFERENCE_COMMIT} over ${compared} moves` : `comparison with ${REFERENCE_COMMIT} NOT RUN (no reference copy and the commit cannot be read)`}; slowest long-text move ${Math.max(...times.map((t) => t.ms)).toFixed(0)} ms of ${times[0].budgetMs})`)
