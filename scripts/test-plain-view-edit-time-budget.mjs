// test:plain-view-edit-time-budget — a long talk is read once per document version, and the cost of
// an edit grows with the talk's length, not with its square.
//
// On generated talks (scripts/lib/plain-view-large-talk.mjs: sections, nested sections, lists, long
// paragraphs, pictures with long addresses and a data URI, carousel and cards slides with `####`
// items, quotes, tables, fenced code, notes, layout lines, title icons, `{id=…}` stamps):
//
//   COUNTS (deterministic; the real extensions bundled for chrome-headless-shell, 200 slides).
//   The three whole-document readings (compilerFacts, plainViewFacts, readOutlineLines) are counted
//   by wrapping them in this test's bundle only; the app's code carries no counter. A reading of a
//   short text (the layout registry's probe documents) is not counted.
//     - mounting the editor reads the document once;
//     - a transaction that changes the document (a typed character, Enter) reads it at most once;
//     - a selection-only transaction (arrow keys, a caret put far away) and scrolling read nothing;
//     - the margin's labels for the text the editor holds read nothing more;
//     - choosing a layout from the margin menu and putting the result in the editor reads one new
//       text (the result): the text before is the editor's, and the result is not read again when
//       it becomes the document. The same for setting a line's icon.
//
//   TIME (generous; a quadratic pass fails it, a slow machine does not). Each pure pass, and a
//   typed character in the mounted editor, is timed at 200 and at 800 slides (median of several
//   runs). Four times the slides may take up to eight times as long, plus slack (a linear pass
//   takes four times, a quadratic one sixteen); and the 200-slide time has a ceiling far above what
//   is measured.
//
//   node scripts/test-plain-view-edit-time-budget.mjs [--print]
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { largeTalk } from './lib/plain-view-large-talk.mjs'
import { plainViewFacts } from '../src/shared/plain-view-icon-items.ts'
import { marginLabels } from '../src/shared/plain-view-margin.ts'
import { normalizePositions } from '../src/shared/outline-normalize.ts'
import { chooseLayout, clearLayout } from '../src/shared/layout-verbs.ts'
import { setLineIcon } from '../src/shared/icon-verbs.ts'

const print = process.argv.includes('--print')
const root = fileURLToPath(new URL('..', import.meta.url))
const SMALL = 200
const LARGE = 800
/** LARGE is four times SMALL: a linear pass takes 4 times as long, a quadratic one 16 times. */
const MAX_GROWTH = 8
const SLACK_MS = 25
/** No pass is near this at 200 slides (the slowest measured is under 50 ms). */
const CEILING_MS = 1000

const median = (times) => [...times].sort((a, b) => a - b)[times.length >> 1]
function timed(run, runs = 7) {
  const times = []
  for (let i = 0; i < runs; i += 1) { const start = performance.now(); run(i); times.push(performance.now() - start) }
  return median(times)
}
function growth(name, small, large) {
  if (print) console.log(`  ${name.padEnd(34)} ${small.toFixed(1).padStart(8)} ms at ${SMALL}  ${large.toFixed(1).padStart(8)} ms at ${LARGE}  x${(large / Math.max(small, 0.01)).toFixed(1)}`)
  assert.ok(small < CEILING_MS, `${name}: ${small.toFixed(0)} ms at ${SMALL} slides (ceiling ${CEILING_MS} ms)`)
  assert.ok(large < MAX_GROWTH * small + SLACK_MS, `${name}: ${large.toFixed(0)} ms at ${LARGE} slides against ${small.toFixed(0)} ms at ${SMALL}: more than ${MAX_GROWTH} times (+${SLACK_MS} ms) for 4 times the slides`)
}

// ── The pure passes ─────────────────────────────────────────────────────────────────────────────

function purePasses(slides) {
  const talk = largeTalk(slides, 1)
  const lines = talk.text.split('\n')
  const middle = talk.headings[talk.headings.length >> 1]
  // A text no pass has seen: one more word on a heading in the middle, as a keystroke leaves it.
  let serial = 0
  const fresh = () => { const next = [...lines]; next[middle] += ` w${slides}x${serial += 1}`; return next.join('\n') }
  const rows = talk.headings.map((line) => ({ source_line: line + 1, source_markdown: lines[line], role: 'content' }))
  const list = { headingLine: talk.listHeadingLine + 1 }
  const withCards = chooseLayout(talk.text, list, 'cards')
  assert.ok(withCards.ok, 'the generated list slide takes Cards')
  assert.ok(clearLayout(withCards.text, list).ok, 'and goes back to Auto')
  // One Cards document per timed run, each differing in a harmless word, built before the timer starts,
  // so every run of "back to Auto" reads a text no pass has seen (not a warm cache hit).
  const cardsTexts = Array.from({ length: 7 }, (_, i) => {
    const next = [...lines]
    next[middle] += ` b${slides}x${i}`
    const write = chooseLayout(next.join('\n'), list, 'cards')
    assert.ok(write.ok, 'a fresh Cards document for the back-to-Auto timing')
    return write.text
  })
  const row = talk.listHeadingLine + 3
  assert.match(lines[row], /^- /, 'the generated list slide has a row where the test expects it')
  assert.ok(setLineIcon(talk.text, row, 'lucide:brain', () => true).ok, 'the row takes an icon')
  return {
    'facts of a new text': timed(() => plainViewFacts(fresh())),
    'margin labels of a new text': timed(() => marginLabels(rows, fresh())),
    'autosave tidy-up': timed(() => normalizePositions(fresh())),
    'choose Cards (new text)': timed(() => assert.ok(chooseLayout(fresh(), list, 'cards').ok)),
    'back to Auto': timed((i) => assert.ok(clearLayout(cardsTexts[i], list).ok)),
    'set a row\'s icon (new text)': timed(() => assert.ok(setLineIcon(fresh(), row, 'lucide:brain', () => true).ok))
  }
}
if (print) console.log('pure passes')
const pureSmall = purePasses(SMALL)
const pureLarge = purePasses(LARGE)
for (const name of Object.keys(pureSmall)) growth(name, pureSmall[name], pureLarge[name])

// ── The mounted editor ──────────────────────────────────────────────────────────────────────────

// The readings counted, by file. Wrapped in the bundle: `name` becomes `name__real`, and a counting
// `name` takes its place, so calls from inside the module are counted too.
const COUNTED = {
  'src/shared/plain-view-compiler-facts.ts': 'compilerFacts',
  'src/shared/plain-view-icon-items.ts': 'plainViewFacts',
  'src/shared/plain-view-outline-lines.ts': 'readOutlineLines'
}
const counting = {
  name: 'count-readings',
  setup(b) {
    b.onLoad({ filter: /plain-view-(compiler-facts|icon-items|outline-lines)\.ts$/ }, (args) => {
      const name = COUNTED[relative(root, args.path).split('\\').join('/')]
      if (!name) return null
      const source = readFileSync(args.path, 'utf8')
      const declared = new RegExp(`export function ${name}\\(`)
      assert.match(source, declared, `${name} is declared in ${args.path}`)
      return {
        loader: 'ts',
        contents: `${source.replace(declared, `function ${name}__real(`)}
export function ${name}(...args) {
  // A whole document, not one of the layout registry's probe texts.
  if (String(args[0] ?? '').length > 2000) { const counts = (globalThis.__readings ??= {}); counts.${name} = (counts.${name} ?? 0) + 1 }
  return ${name}__real(...args)
}
`
      }
    })
  }
}

const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-edit-time-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history, historyKeymap, defaultKeymap, cursorLineDown, cursorCharRight, insertNewlineAndIndent } from '@codemirror/commands'
import { codeFolding, foldGutter } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { plainTypeExtension } from './src/renderer/src/extensions/plainView/theme.ts'
import { setMarginLabels } from './src/renderer/src/extensions/plainView/margin.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { slideNumberGutterExtension } from './src/renderer/src/extensions/slideNumberGutter.ts'
import { outlineFoldService, imageParagraphNoFold } from './src/renderer/src/extensions/outlineFold.ts'
import { focusScopeExtension } from './src/renderer/src/extensions/focusScope.ts'
import { inlineMarkExtension } from './src/renderer/src/extensions/inlineMark.ts'
import { frontmatterTableExtension } from './src/renderer/src/extensions/frontmatterTable.ts'
import { marginLabels } from './src/shared/plain-view-margin.ts'
import { chooseLayout } from './src/shared/layout-verbs.ts'
import { setLineIcon } from './src/shared/icon-verbs.ts'
import { minimalChange } from './src/renderer/src/lib/minimalChange.ts'
import { appKeyState, failOnCaughtExceptions } from './scripts/lib/plain-view-test-mount.mjs'

// The editor's extensions that scan or decorate the document, as Editor.tsx lists them, with Plain.
window.mount = (doc, host) => window.view = new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [
  slideNumberGutterExtension, history(), highlightActiveLine(),
  markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [imageParagraphNoFold] }),
  codeFolding(), foldGutter(), outlineFoldService, tokenProtectExtension(() => null), focusScopeExtension(),
  frontmatterTableExtension(), inlineMarkExtension, ...appKeyState(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  viewModeExtension('plain', {}), plainTypeExtension({ font: 'sans', size: 16 }),
  failOnCaughtExceptions(), EditorView.lineWrapping
] }) })
window.api = { cursorLineDown, cursorCharRight, insertNewlineAndIndent, setMarginLabels, marginLabels, chooseLayout, setLineIcon, minimalChange }
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', outfile, logLevel: 'silent', plugins: [counting] })

const browser = await chromium.launch()
try {
  const mounted = async (slides) => {
    const talk = largeTalk(slides, 1)
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.setContent('<style>.cm-editor{height:700px}.cm-scroller{overflow:auto}</style><div id="host" style="width:900px;height:700px"></div>')
    await page.addScriptTag({ path: outfile })
    const result = await page.evaluate(async ({ text, talk }) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
      const { cursorLineDown, cursorCharRight, insertNewlineAndIndent, setMarginLabels, marginLabels, chooseLayout, setLineIcon, minimalChange } = window.api
      const out = { counts: {}, typeMs: 0 }
      const readings = () => ({ compilerFacts: 0, plainViewFacts: 0, readOutlineLines: 0, ...globalThis.__readings })
      // The readings one action makes, the frame after it included (the gutters and the view plugins draw then).
      const counted = async (name, times, action) => {
        globalThis.__readings = {}
        for (let i = 0; i < times; i += 1) { await action(i); await frame() }
        out.counts[name] = readings()
      }
      globalThis.__readings = {}
      window.mount(text, document.getElementById('host'))
      const view = window.view
      await frame(); await frame()
      out.counts.mount = readings()
      const rowLine = talk.listHeadingLine + 4
      view.dispatch({ selection: { anchor: view.state.doc.line(rowLine).to }, scrollIntoView: true })
      view.focus()
      await frame()
      const type = () => view.dispatch(view.state.replaceSelection('x'), { userEvent: 'input.type' })
      await counted('type', 10, type)
      await counted('arrowRight', 10, () => cursorCharRight(view))
      await counted('arrowDown', 10, () => cursorLineDown(view))
      await counted('farCaret', 5, (i) => view.dispatch({ selection: { anchor: view.state.doc.line(40 + i * 300).from }, scrollIntoView: true }))
      await counted('scroll', 10, () => { view.scrollDOM.scrollTop += 600 })
      view.dispatch({ selection: { anchor: view.state.doc.line(rowLine).to }, scrollIntoView: true })
      await frame()
      await counted('enter', 5, () => insertNewlineAndIndent(view))
      // The margin's labels, as WorkspaceLayout asks for them: from its own string of the same text.
      const lines = text.split('\n')
      const rows = talk.headings.map((line) => ({ source_line: line + 1, source_markdown: lines[line], role: 'content' }))
      await counted('marginLabels', 1, () => setMarginLabels(view, marginLabels(rows, view.state.doc.toString())))
      const put = (next) => { const now = view.state.doc.toString(); const change = minimalChange(now, next); view.dispatch({ changes: { from: change.from, to: change.to, insert: change.insert } }) }
      await counted('chooseLayout', 1, () => {
        const write = chooseLayout(view.state.doc.toString(), { headingLine: talk.listHeadingLine + 1 }, 'cards')
        if (!write.ok) throw new Error('Cards refused: ' + write.reason)
        put(write.text)
      })
      await counted('setLineIcon', 1, () => {
        const write = setLineIcon(view.state.doc.toString(), talk.listHeadingLine + 3, 'lucide:brain', () => true)
        if (!write.ok) throw new Error('icon refused: ' + write.reason)
        put(write.text)
      })
      // One typed character: the dispatch and the layout it leaves to do.
      view.dispatch({ selection: { anchor: view.state.doc.line(rowLine).to }, scrollIntoView: true })
      await frame()
      const times = []
      for (let i = 0; i < 15; i += 1) { const start = performance.now(); type(); void view.dom.offsetHeight; times.push(performance.now() - start); await frame() }
      out.typeMs = [...times].sort((a, b) => a - b)[times.length >> 1]
      out.caught = window.__caught
      return out
    }, { text: talk.text, talk })
    await page.close()
    assert.deepEqual(errors, [], 'no page error')
    assert.deepEqual(result.caught, [], 'no exception caught by CodeMirror')
    return result
  }

  const small = await mounted(SMALL)
  const c = small.counts
  if (print) { console.log('readings per action, 200 slides'); for (const [name, counts] of Object.entries(c)) console.log(`  ${name.padEnd(14)} ${JSON.stringify(counts)}`) }
  const once = { compilerFacts: 1, plainViewFacts: 1, readOutlineLines: 1 }
  const none = { compilerFacts: 0, plainViewFacts: 0, readOutlineLines: 0 }
  const perTransaction = (n) => ({ compilerFacts: n, plainViewFacts: n, readOutlineLines: n })
  assert.deepEqual(c.mount, once, 'mounting reads the document once')
  assert.deepEqual(c.type, perTransaction(10), 'ten typed characters: one reading each')
  assert.deepEqual(c.enter, perTransaction(5), 'five Enters: one reading each')
  assert.deepEqual(c.arrowRight, none, 'ArrowRight (selection only) reads nothing')
  assert.deepEqual(c.arrowDown, none, 'ArrowDown (selection only) reads nothing')
  assert.deepEqual(c.farCaret, none, 'a caret put far away (selection and scroll) reads nothing')
  assert.deepEqual(c.scroll, none, 'scrolling reads nothing')
  assert.deepEqual(c.marginLabels, none, 'the margin\'s labels use the reading the editor has for the same text')
  assert.deepEqual(c.chooseLayout, once, 'choosing a layout and putting it in the editor reads one new text, once')
  // A list row's icon is tried on the row first (the lexer says where the row's text starts), and
  // that text is the result: one new text.
  assert.deepEqual(c.setLineIcon, once, 'setting a row\'s icon and putting it in the editor reads one new text, once')

  const large = await mounted(LARGE)
  if (print) console.log('mounted editor')
  growth('a typed character, mounted', small.typeMs, large.typeMs)
  console.log('plain view edit time budget: ok')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
