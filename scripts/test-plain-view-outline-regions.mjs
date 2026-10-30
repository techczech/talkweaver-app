// test:plain-view-outline-regions — plain view ticket 07, ninth review: Plain hides, protects and
// labels text only on lines the compiler reads as outline. Fenced code (whatever the mark and its
// length), a comment, the speaker notes and the front matter stay ordinary text.
//
// In an inline-source editor with the app’s token protection, history and key bindings, without
// replacing source regions with object cards (the separate object suites cover those cards):
//   - on every document of scripts/fixtures/plain-view-outline-regions.json, each protected
//     region, each icon item, each placeholder and each margin label is on a line the compiler
//     reads as outline (scripts/lib/plain-view-compiler-lines.mjs: its outline tree), and the
//     front matter's region is on the front matter;
//   - the review's input (four backticks holding a three-backtick block): End then X on the code
//     line gives what the Markdown tab gives, the line has no picture and no margin label, and its
//     braces show. The same in a tilde fence, in notes, in a comment, and under a fence that the
//     compiler's lexer reads as paragraph text.
// test:plain-view-outline-lines-parity holds the shared reader to the compiler in Node.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { compilerLines } from './lib/plain-view-compiler-lines.mjs'
import { compilerFacts } from '../src/shared/plain-view-compiler-facts.ts'
import { readOutlineLines } from '../src/shared/plain-view-outline-lines.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const { documents } = JSON.parse(readFileSync(new URL('./fixtures/plain-view-outline-regions.json', import.meta.url), 'utf8'))
const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-plain-view-outline-regions-'))
const outfile = join(dir, 'bundle.js')
const entry = `
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, EditorSelection, Compartment, Prec } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { history } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { search } from '@codemirror/search'
import * as guardKeys from './src/renderer/src/extensions/plainView/guardKeys.ts'
import { iconItems } from './src/renderer/src/extensions/plainView/iconPictures.ts'
import { placeholderSpots } from './src/renderer/src/extensions/plainView/placeholders.ts'
import { viewModeExtension } from './src/renderer/src/extensions/plainView/index.ts'
import { tokenProtectExtension } from './src/renderer/src/extensions/idProtect.ts'
import { focusScopeExtension } from './src/renderer/src/extensions/focusScope.ts'
import { frontmatterTableExtension } from './src/renderer/src/extensions/frontmatterTable.ts'
import { editorBaseKeymap } from './src/renderer/src/extensions/editorBaseKeymap.ts'
import { buildEditorKeyBindings } from './src/renderer/src/keymap/store.ts'
import { appKeyState, failOnCaughtExceptions } from './scripts/lib/plain-view-test-mount.mjs'

const STAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5L5.5 21l2-7.5L2 9h7z"/></svg>'
const compartment = new Compartment()
window.mount = (doc, mode = 'plain') => {
  document.getElementById('host').innerHTML = ''
  const view = new EditorView({ parent: document.getElementById('host'), state: EditorState.create({
    doc, selection: EditorSelection.cursor(0),
    extensions: [
      history(), markdown({ base: markdownLanguage, codeLanguages: languages }),
      tokenProtectExtension(), focusScopeExtension(), frontmatterTableExtension(),
      appKeyState({ sourceOnly: true }), search(),
      keymap.of([...editorBaseKeymap]),
      Prec.highest(keymap.of(buildEditorKeyBindings())),
      compartment.of(viewModeExtension(mode, { iconSvg: async () => STAR })),
      EditorView.lineWrapping,
      failOnCaughtExceptions()
    ]
  }) })
  view.focus()
  return window.__v = view
}
window.caret = (pos) => window.__v.dispatch({ selection: EditorSelection.cursor(pos), userEvent: 'select' })
window.docText = () => window.__v.state.doc.toString()
const lineOf = (pos) => window.__v.state.doc.lineAt(pos).number
const lineOfNode = (node) => lineOf(window.__v.posAtDOM(node))
// What Plain has put on the document, as 1-based line numbers.
window.read = () => {
  const v = window.__v
  const doc = v.state.doc
  const lines = (from, to) => { const out = []; for (let n = lineOf(from); n <= lineOf(to); n += 1) out.push(n); return out }
  return {
    regions: guardKeys.protectedRegionsOf(v.state).map((r) => ({ kind: r.kind, lines: [...new Set(r.parts.flatMap((p) => lines(p.from, p.to)))], zone: lines(r.zoneFrom, r.zoneTo) })),
    items: iconItems(doc).map((item) => ({ kind: item.kind, lines: lines(item.lineFrom, item.to) })),
    placeholders: placeholderSpots(doc, []).map((spot) => lineOf(spot.pos)),
    labels: [...v.dom.querySelectorAll('.cm-plain-margin-label[data-margin-line]')].map((el) => Number(el.dataset.marginLine)),
    pictures: [...v.contentDOM.querySelectorAll('.cm-plain-icon-picture')].map(lineOfNode),
    chips: [...v.contentDOM.querySelectorAll('[class*="cm-plain-icon-chip"], [class*="cm-plain-icon-token"]')].map(lineOfNode)
  }
}
window.shownLine = (n) => {
  const v = window.__v
  let node = v.domAtPos(v.state.doc.line(n).from).node
  while (node && !(node.nodeType === 1 && node.classList.contains('cm-line'))) node = node.parentNode
  return node ? node.innerText : null
}
`
await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', outfile, logLevel: 'silent' })

// The review's input, with a real title icon after it (so that pictures are known to be drawn).
const TAILPIECE = ['', '### Real {icon=lucide:star}', 'Body']
const SCENES = [
  { name: 'the review\'s input (four backticks holding three)', code: [6],
    lines: ['# T', '', '## Markdown example', '````markdown', '```', '### Demo {icon=lucide:bike}', '```', '````'] },
  { name: 'a tilde fence', code: [4, 5, 6],
    lines: ['# T', '', '## Example', '~~~', '### Demo {icon=lucide:bike}', '- item {icon=lucide:bike}', 'Text {icon=lucide:bike}', '~~~'] },
  { name: 'five backticks holding four and three', code: [6],
    lines: ['# T', '', '## Example', '`````', '````', '### Demo {icon=lucide:bike}', '```', '`````'] },
  { name: 'a notes block', code: [5, 6, 7],
    lines: ['# T', '', '## Example', 'Body', ':::notes', '{reveal}', 'Say this {icon=lucide:bike}', '- remember {icon=lucide:bike}', ':::'] },
  { name: 'a comment over several lines', code: [5, 6, 7],
    lines: ['# T', '', '## Example', 'Body', '<!--', '### Demo {icon=lucide:bike}', '{cards}', 'Old text {icon=lucide:bike}', '-->'] },
  { name: 'a comment on one line', code: [5, 6],
    lines: ['# T', '', '## Example', 'Body', '<!-- ### Demo {icon=lucide:bike} -->', 'Text <!-- old --> {icon=lucide:bike}'] },
  { name: 'the front matter', code: [2, 3],
    lines: ['---', 'author: A', '---', '# T', '', '## Example', 'Body'], frontmatter: true },
  { name: 'a fence straight under a paragraph line, and the text after it', code: [6, 7, 9],
    lines: ['# T', '', '## Example', 'Body', '```', '### Demo {icon=lucide:bike}', '', '```', 'After {icon=lucide:bike}'] }
]

const browser = await chromium.launch()
const errors = []
const caught = []
const failed = []
let checks = 0
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent('<div id="host" style="width:900px;height:800px"></div>')
  await page.addScriptTag({ path: outfile })
  const ev = (fn, arg) => page.evaluate(fn, arg)
  const open = (d, mode = 'plain') => ev(([d, m]) => { window.mount(d, m) }, [d, mode])
  const check = async (label, fn) => {
    try { await fn() } catch (e) { failed.push(`${label}: ${String(e.message).split('\n')[0]}`) }
  }
  /** Mount in Plain and wait until every icon that will be drawn is drawn. */
  const openPlain = async (text) => {
    await open(text)
    await page.waitForFunction(() => {
      const r = window.read()
      return r.pictures.length >= r.items.length
    }, null, { timeout: 5000 }).catch(() => {})
    return ev(() => window.read())
  }

  // ── Every fixture document: what Plain puts on it is on outline lines only ───────────────────
  let regions = 0
  let labels = 0
  for (const { name, lines } of documents) {
    await check(name, async () => {
      const text = lines.join('\n')
      const compiler = compilerLines(text)
      const helper = readOutlineLines(text)
      const outline = (n) => !compiler.skipped[n - 1] && !helper.partial[n - 1]
      const at = (n) => `line ${n} ${JSON.stringify(lines[n - 1])}`
      const got = await openPlain(text)
      for (const region of got.regions) {
        for (const n of [...region.lines, ...region.zone]) {
          if (region.kind === 'frontmatter') assert.ok(n <= helper.frontmatterLines && compiler.skipped[n - 1], `the front matter's region is on the front matter: ${at(n)}`)
          else assert.ok(outline(n), `a protected region (${region.kind}) is on a line the compiler skips: ${at(n)}`)
        }
        regions += 1
      }
      // A paragraph's first line and its token's line (the compiler joins a paragraph across notes and stray Trigger lines: the lines between are not the item's).
      for (const item of got.items) for (const n of [item.lines[0], item.lines[item.lines.length - 1]]) assert.ok(!compiler.skipped[n - 1], `an icon (${item.kind}) is read on a line the compiler skips: ${at(n)}`)
      for (const n of got.pictures) assert.ok(outline(n), `a picture is drawn on a line the compiler skips: ${at(n)}`)
      for (const n of got.placeholders) assert.ok(outline(n), `a placeholder is on a line the compiler skips: ${at(n)}`)
      for (const n of got.labels) assert.ok(!compiler.skipped[n - 1], `a margin label is on a line the compiler skips: ${at(n)}`)
      for (const i of compiler.headings) assert.ok(got.labels.includes(i + 1), `the compiler's heading has its margin label: ${at(i + 1)}`)
      labels += got.labels.length
      checks += 1
    })
  }
  await check('the fixture exercises the rules', async () => {
    assert.ok(documents.length >= 30 && regions >= 30 && labels >= 50, `${documents.length} documents, ${regions} protected regions, ${labels} margin labels`)
  })

  // ── The review's input and its kin: the skipped lines are ordinary text ──────────────────────
  for (const scene of SCENES) {
    const lines = [...scene.lines, ...TAILPIECE]
    const text = lines.join('\n')
    const real = scene.lines.length + 2
    await check(`${scene.name}: nothing of Plain is on the skipped lines`, async () => {
      const got = await openPlain(text)
      assert.deepEqual(got.pictures, [real], 'one picture: the real title\'s')
      assert.ok(got.labels.includes(real), 'the real title has its margin label')
      for (const n of scene.code) {
        assert.ok(!got.labels.includes(n), `no margin label on line ${n}`)
        assert.ok(!got.regions.some((r) => r.kind !== 'frontmatter' && (r.lines.includes(n) || r.zone.includes(n))), `nothing is protected on line ${n}`)
        if (scene.frontmatter) continue
        const shown = await ev((k) => window.shownLine(k), n)
        const braces = lines[n - 1].match(/\{[^}]*\}/g) || []
        for (const group of braces) assert.ok(shown.includes(group), `line ${n} shows ${group}: ${JSON.stringify(shown)}`)
      }
      checks += 1
    })
    if (scene.frontmatter) continue
    for (const n of scene.code) {
      await check(`${scene.name}: End then X on line ${n} is the Markdown tab's`, async () => {
        const from = lines.slice(0, n - 1).join('\n').length + (n > 1 ? 1 : 0)
        const typed = []
        for (const mode of ['plain', 'markdown']) {
          if (mode === 'plain') await openPlain(text)
          else await open(text, mode)
          await ev((p) => window.caret(p), from)
          await page.keyboard.press('End')
          await page.keyboard.type('X')
          typed.push(await ev(() => window.docText()))
        }
        const want = [...lines.slice(0, n - 1), lines[n - 1] + 'X', ...lines.slice(n)].join('\n')
        assert.equal(typed[1], want, 'the Markdown tab puts the letter at the end of the line')
        assert.equal(typed[0], typed[1], `Plain gives ${JSON.stringify(typed[0].split('\n')[n - 1])}`)
        checks += 1
      })
    }
  }
  // And the real title, in the same documents, is still a title with a hidden icon token.
  await check('the title after the code keeps its hidden token', async () => {
    const lines = [...SCENES[0].lines, ...TAILPIECE]
    const real = SCENES[0].lines.length + 2
    await openPlain(lines.join('\n'))
    await ev((p) => window.caret(p), lines.slice(0, real - 1).join('\n').length + 1)
    await page.keyboard.press('End')
    await page.keyboard.type('X')
    assert.equal((await ev(() => window.docText())).split('\n')[real - 1], '### RealX {icon=lucide:star}')
    checks += 1
  })
  // A comment earlier in a title leaves its tail as the compiler reads it: still hidden, still kept.
  await check('a title with a comment before its hidden option keeps the option hidden', async () => {
    const text = '### Alpha <!-- n --> beta {reveal}\nBody'
    const got = await openPlain(text)
    assert.ok(got.regions.some((r) => r.kind === 'tail' && r.lines.includes(1)), 'the option is protected')
    assert.ok(!(await ev(() => window.shownLine(1))).includes('{reveal}'), 'and not shown')
    await ev(() => window.caret(4))
    await page.keyboard.press('End')
    await page.keyboard.type('X')
    assert.equal(await ev(() => window.docText()), '### Alpha <!-- n --> betaX {reveal}\nBody')
    // After the option, the comment cuts what the compiler reads: nothing is hidden.
    const after = await openPlain('### Alpha {reveal} <!-- n -->\nBody')
    assert.ok(!after.regions.some((r) => r.kind === 'tail'), 'a comment after the option: nothing is protected')
    checks += 1
  })
  // The tenth review's two inputs. What a slide's content is comes from the compiler's own lexer
  // (shared/plain-view-compiler-facts.ts), so the paragraph keeps its icon item in both.
  const REVIEW_TEN = [
    { name: 'a QR directive straight above a fence', lines: ['# T', '', '### Demo {id=demo}', '[QR: https://example.org]', '```text', 'Example', '```', '', 'After {icon=lucide:star}'] },
    { name: 'a quotation\'s attribution line straight above a fence', lines: ['# T', '', '### Demo {id=demo}', '> Said', '— Jane Doe', '```text', 'Example', '```', '', 'After {icon=lucide:star}'] },
    { name: 'a Trigger line that carries a comment, under the paragraph', lines: ['# T', '', '### Demo {id=demo}', 'After {icon=lucide:star}', '{reveal} <!-- reveal items -->'] }
  ]
  for (const scene of REVIEW_TEN) {
    await check(`${scene.name}: Ctrl-E then X goes before the hidden icon token`, async () => {
      const n = scene.lines.indexOf('After {icon=lucide:star}') + 1
      const got = await openPlain(scene.lines.join('\n'))
      assert.ok(got.items.some((item) => item.kind === 'paragraph' && item.lines.includes(n)), 'the paragraph has its icon item')
      await ev((p) => window.caret(p), scene.lines.slice(0, n - 1).join('\n').length + 1)
      await page.waitForFunction(() => document.querySelectorAll('.cm-plain-icon-picture').length > 0, null, { timeout: 5000 })
      assert.ok(!(await ev((k) => window.shownLine(k), n)).includes('{icon='), 'the token is hidden')
      await page.keyboard.press('Control+e')
      await page.keyboard.type('X')
      assert.equal((await ev(() => window.docText())).split('\n')[n - 1], 'AfterX {icon=lucide:star}')
      assert.ok(await ev(() => document.querySelectorAll('.cm-plain-icon-picture').length > 0), 'the picture is drawn')
      checks += 1
    })
  }
  // ── Twelfth round: a layout line is hidden only if the compiler removes it ───────────────────
  // The compiler decides (plain-view-compiler-facts.ts layoutLines); `hidden` is checked against it
  // here, so a change of the compiler's reading fails this test, not the app. Lines are 1-based.
  const LAYOUT_SHAPES = [
    { name: 'a {…} line under the talk title, before the first slide: the compiler removes nothing there, it is shown',
      lines: ['# Alpha', '{statement}', 'Body'], hidden: [], shown: [2] },
    { name: 'a {…} line under the talk title, with front matter above',
      lines: ['---', 'outline_version: 2', '---', '# Alpha', '{statement}', 'Body'], hidden: [], shown: [5] },
    { name: 'a chart token that owns the list under it ends the hidden run',
      lines: ['# T', '', '## Sales', '{reveal}', '{chart=bar}', '- North: 3', '- South: 5'], hidden: [4], shown: [5] },
    { name: 'a chart token that owns a list past a blank line ends the hidden run',
      lines: ['# T', '', '#### Sales', '{reveal}', '{chart=bar}', '', '1. North'], hidden: [4], shown: [5] },
    { name: 'two chart tokens, the second owning the list: the first is a layout line, the second is content',
      lines: ['# T', '', '### Sales', '{chart=bar}', '{chart=pie}', '- North: 3', '- South: 5'], hidden: [4], shown: [5] },
    { name: 'a {…} line under a second # line, inside a slide: the compiler takes it out of that slide, it is hidden',
      lines: ['# T', '', '## Part', 'Body', '# Alpha', '{statement}', 'More'], hidden: [6], shown: [] },
    { name: 'a layout line under a slide title is hidden as ever',
      lines: ['# T', '', '### Alpha', '{statement}', '{id=a1}', 'Body'], hidden: [4, 5], shown: [] }
  ]
  for (const scene of LAYOUT_SHAPES) {
    await check(scene.name, async () => {
      const text = scene.lines.join('\n')
      const removed = compilerFacts(text).layoutLines
      for (const n of scene.hidden) assert.ok(removed.has(n - 1), `the compiler removes line ${n}`)
      for (const n of scene.shown) assert.ok(!removed.has(n - 1), `the compiler keeps line ${n} as content`)
      const got = await openPlain(text)
      const run = got.regions.filter((r) => r.kind === 'run').flatMap((r) => r.lines)
      assert.deepEqual(run, scene.hidden, 'the protected layout lines')
      const drawn = await ev(() => window.__v.contentDOM.innerText)
      for (const n of scene.shown) assert.ok(drawn.includes(scene.lines[n - 1]), `line ${n} is shown as text`)
      for (const n of scene.hidden) assert.ok(!drawn.includes(scene.lines[n - 1]), `line ${n} is hidden`)
      // A shown line is ordinary text: the caret goes onto it and a key types there.
      for (const n of scene.shown) {
        const at = scene.lines.slice(0, n).join('\n').length
        await ev((p) => window.caret(p), at)
        await page.keyboard.type('X')
        assert.equal((await ev(() => window.docText())).split('\n')[n - 1], scene.lines[n - 1] + 'X', `typing at the end of line ${n}`)
      }
      checks += 1
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
  console.error(`test:plain-view-outline-regions: ${failed.length} failed`)
  for (const f of failed) console.error('  - ' + f)
  process.exit(1)
}
console.log(`test:plain-view-outline-regions: passed (${checks} checks)`)
