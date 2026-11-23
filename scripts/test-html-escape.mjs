#!/usr/bin/env node
// HTML escaping (upkeep ticket 11). Two parts:
//
// 1. The shared functions (compiler/scripts/lib/00-html.mjs, re-exported by src/shared/html-escape.ts):
//    escapeHtml and escapeAttr escape & < > " ' and leave every other code point 0–0x2FFF alone. The
//    worker keeps its own copy (it compiles alone under Wrangler); it must agree on every code point.
// 2. The local helpers that cannot import them: runtime scripts inlined into decks as source text
//    (compiler/assets/runtime/*.js, compiler/scripts/lib/poll-frame.mjs) and the presenter recording
//    toolbar's preload helper. Each file is parsed; every function that is named like an escaper and
//    builds "&amp;", or is a small function that builds "&amp;", is lifted out, run on its own, and
//    must escape all five characters. A future helper that misses one fails here.
// 3. Compiler passes that read escaped text: an entity is never split or counted as anything but one
//    character (bare-URL trailing punctuation, the Ocean divider's title length).
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { escapeAttr, escapeHtml } from '../compiler/scripts/lib/00-html.mjs'
import * as shared from '../src/shared/html-escape.ts'
import { escapeHtml as workerEscapeHtml } from '../worker/run-share-state.ts'
import { renderInline } from '../compiler/scripts/lib/00-inline-render.mjs'
import { shortenAddressLinks } from '../compiler/scripts/lib/quote-forms.mjs'
import { bareUrlAt } from '../compiler/scripts/lib/00-inline-protection.mjs'
import { renderScriptInline } from '../compiler/scripts/lib/slide-script-render.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const FIVE = `&<>"'`
const ENTITY = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&#x27;': "'" }
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g, (e) => ENTITY[e])
let checks = 0

function assertEscapesFive(fn, label) {
  for (const ch of FIVE) {
    const out = fn(ch)
    assert.notEqual(out, ch, `${label} leaves ${JSON.stringify(ch)} unescaped`)
    assert.equal(decode(out), ch, `${label}(${JSON.stringify(ch)}) gives ${JSON.stringify(out)}`)
  }
  const mixed = `<script>alert("x's & y")</script>`
  const out = fn(mixed)
  assert.ok(!/[<>"']/.test(out), `${label} leaves markup characters in ${JSON.stringify(out)}`)
  assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#39|#x27);)/.test(out), `${label} leaves a bare & in ${JSON.stringify(out)}`)
  assert.equal(decode(out), mixed, `${label} round trip`)
  // Already-escaped input is escaped again, never passed through as markup.
  assert.equal(decode(fn('&lt;b&gt;')), '&lt;b&gt;', `${label} must re-escape already-escaped text`)
  checks += 1
}

// ── 1. The shared functions ─────────────────────────────────────────────────────────────────
for (const [name, fn] of [['escapeHtml', escapeHtml], ['escapeAttr', escapeAttr]]) {
  assertEscapesFive(fn, name)
  assert.equal(fn("&<>\"'"), '&amp;&lt;&gt;&quot;&#39;', `${name} exact entities`)
  for (let code = 0; code <= 0x2fff; code += 1) {
    const ch = String.fromCharCode(code)
    if (FIVE.includes(ch)) continue
    assert.equal(fn(ch), ch, `${name} changes U+${code.toString(16)}`)
  }
  assert.equal(fn(null), '', `${name}(null)`)
  assert.equal(fn(undefined), '', `${name}(undefined)`)
  assert.equal(fn(42), '42', `${name}(42)`)
}
assert.equal(shared.escapeHtml, escapeHtml, 'src/shared/html-escape.ts re-exports the one escapeHtml')
assert.equal(shared.escapeAttr, escapeAttr, 'src/shared/html-escape.ts re-exports the one escapeAttr')
console.log('ok shared escapeHtml and escapeAttr: five characters, code points 0–0x2FFF, null')

assertEscapesFive(workerEscapeHtml, 'worker/run-share-state.ts escapeHtml')
for (let code = 0; code <= 0x2fff; code += 1) {
  const ch = String.fromCharCode(code)
  assert.equal(workerEscapeHtml(ch), escapeHtml(ch), `worker escapeHtml disagrees with the shared one on U+${code.toString(16)}`)
}
console.log('ok worker escapeHtml agrees with the shared one on code points 0–0x2FFF')

// ── 2. Local helpers in sources that cannot import ──────────────────────────────────────────
const runtimeDir = join(repo, 'compiler/assets/runtime')
const files = [
  ...readdirSync(runtimeDir).filter((f) => f.endsWith('.js')).sort().map((f) => join(runtimeDir, f)),
  join(repo, 'compiler/scripts/lib/poll-frame.mjs'),
  join(repo, 'src/preload/present-rec-ui.ts'),
]

const isFunctionLike = (node) => node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
const buildsAmp = (node) => {
  let found = false
  const visit = (n) => {
    if (found) return
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === '&amp;') found = true
    else ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}
const SMALL = 600 // characters: a helper, not a renderer that happens to build an &amp;

function helpersIn(file) {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
  const found = []
  const consider = (name, fnNode, wrap) => {
    if (!buildsAmp(fnNode)) return
    const nodeText = fnNode.getText(source)
    if (!/esc/i.test(name) && nodeText.length > SMALL) return
    found.push({ name, line: source.getLineAndCharacterOfPosition(fnNode.getStart(source)).line + 1, code: wrap(nodeText) })
  }
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) consider(node.name.text, node, (t) => `${t}\nreturn ${node.name.text}`)
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionLike(node.initializer)) {
      consider(node.name.text, node.initializer, (t) => `return (${t})`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const seen = []
for (const file of files) {
  for (const helper of helpersIn(file)) {
    const label = `${relative(repo, file)}:${helper.line} ${helper.name}`
    const js = ts.transpileModule(helper.code.replace(/^export\s+/, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    let fn
    try {
      fn = new Function(js)()
    } catch (error) {
      throw new Error(`${label}: an escape helper must stand alone (no outer names) so it can be checked: ${error.message}`)
    }
    assert.equal(typeof fn, 'function', `${label} is a function`)
    assertEscapesFive(fn, label)
    seen.push(label)
  }
}
// The helpers known on 21 Nov 2026; finding fewer means the scan broke, not that they went away.
const expected = [
  'compiler/assets/runtime/audience-my-notes.js', 'compiler/assets/runtime/audience-reactions.js',
  'compiler/assets/runtime/live-follow.js', 'compiler/assets/runtime/poll-display.js',
  'compiler/assets/runtime/poll-extended.js', 'compiler/assets/runtime/shared-talk-core.js',
  'compiler/scripts/lib/poll-frame.mjs', 'src/preload/present-rec-ui.ts',
]
for (const file of expected) assert.ok(seen.some((label) => label.startsWith(`${file}:`)), `no escape helper found in ${file}`)
for (const label of seen) console.log(`ok ${label}`)

// ── 3. Passes over escaped text keep entities whole ─────────────────────────────────────────
for (const line of ["Visit https://example.test/teachers'.", "Visit ==now== https://example.test/teachers'."]) {
  const html = renderInline(line)
  assert.ok(html.includes('<a href="https://example.test/teachers&#39;"'), `the link keeps the whole &#39;: ${html}`)
  assert.ok(html.endsWith('</a>.'), `only the full stop trails the link: ${html}`)
  assert.ok(!/&#39(?!;)/.test(html), `no split entity: ${html}`)
}
assert.ok(renderInline('Go https://a.test/;').endsWith('</a>;'), 'a real trailing ; still trails the link')
console.log('ok bare URL ending in an apostrophe keeps &#39; whole')

const sourceLink = shortenAddressLinks(renderInline("https://example.test/teachers'"))
assert.ok(sourceLink.includes('href="https://example.test/teachers&#39;"'), 'shortening preserves the original link')
assert.ok(sourceLink.includes('title="https://example.test/teachers&#39;"'), 'the source-link tooltip keeps the apostrophe')
assert.ok(sourceLink.includes('aria-label="https://example.test/teachers&#39;"'), 'the source-link label keeps the apostrophe')
assert.ok(sourceLink.endsWith('>example.test/teachers&#39;</a>'), 'the short caption keeps the apostrophe')

// Raw source (the phone text view, the editor's mark ranges) keeps the plain rule: a trailing ; is punctuation, so
// `&exact;` is not read as an entity and the query key stays `exact`. Escaped renderers see `&amp;exact;` and agree.
const RAW_QUERY = 'Read https://example.test/search?q=art&exact; then continue.'
assert.equal(bareUrlAt(RAW_QUERY, RAW_QUERY.indexOf('https')).url, 'https://example.test/search?q=art&exact', 'raw bare URL drops the trailing ;')
assert.equal(bareUrlAt("x https://e.test/a&#39;.", 2, { escaped: true }).url, 'https://e.test/a&#39;', 'escaped bare URL keeps the entity')
for (const [label, html] of [['phone text view', renderScriptInline(RAW_QUERY)], ['inline', renderInline(RAW_QUERY)], ['inline, marked line', renderInline(`==Read== ${RAW_QUERY.slice(5)}`)]]) {
  assert.ok(html.includes('href="https://example.test/search?q=art&amp;exact"'), `${label}: the href's query key stays exact: ${html}`)
  assert.ok(html.includes('</a>; then continue.'), `${label}: the ; trails the link: ${html}`)
}
console.log('ok raw &exact; URL keeps main\'s trailing-punctuation rule')

const work = mkdtempSync(join(tmpdir(), 'tw-html-escape-'))
try {
  const divider = async (title) => {
    const md = ['---', 'title: T', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', `## ${title}`, '', '### A', '', 'x', ''].join('\n')
    const path = join(work, 'divider-outline.md')
    writeFileSync(path, md)
    const html = await buildDeckHtmlFromModel(await prepareSource(path, md, null, statSync(path), undefined, { allowedAssetRoots: [work] }))
    return (html.match(/class="slide-content layout-section-title"([^>]*)>/) || [])[1] ?? ''
  }
  const title = "The gardeners and their neighbours'"
  assert.equal(title.length, 35)
  assert.match(await divider(title), /data-oc-title="long"/, 'a 35-character divider title ending in an apostrophe is long')
  assert.doesNotMatch(await divider(title.slice(0, 34)), /data-oc-title=/, 'a 34-character divider title is not')
  console.log('ok Ocean divider counts an escaped apostrophe as one character')
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(`test-html-escape: ${checks} helpers escape all five characters`)
