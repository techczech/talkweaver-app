// test:list-item-icon-verb — issue #120: setListItemIcon
// (compiler/scripts/lib/outline-list-item-icon.mjs, exported by 12-outline-edit.mjs) writes into the
// person's outline. It used to find its line with a scan of its own and could write onto a list
// line in the front matter, in speaker notes or in fenced code. Each case checks that the one
// token is set, replaced or removed on the item the COMPILER reads, that every other line and
// every other character of the edited line is byte-identical, and that a refusal returns the
// outline as given.
//
// The verb answers { ok: true, text, changed } or { ok: false, text (as given), reason }. `call`
// also reads the answers of the verb as it was before the fix (the new outline as a string, or a
// throw), so that this file can be run against that verb to show each case failing without the fix.
//
// The generated run (fixed seed) assembles documents from labelled fragments and checks every
// write against the FULL compiler (adaptMarkdownOutlineV2), not against the verb's own reading.
//   node scripts/test-list-item-icon-verb.mjs [--seed=N] [--documents=N]
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { collectIconModel, setListItemIcon as rawSetListItemIcon, setParagraphIcon } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { adaptMarkdownOutlineV2 } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { renderSlideSections } from '../compiler/scripts/lib/07-assembly.mjs'
import { TRIGGER_DICTIONARY } from '../compiler/scripts/lib/trigger-dictionary.generated.mjs'

let checks = 0
const ok = (cond, label) => { assert.ok(cond, label); checks += 1 }
const eq = (a, b, label) => { assert.equal(a, b, label); checks += 1 }
const same = (a, b, label) => { assert.deepEqual(a, b, label); checks += 1 }

function call(text, ref, item, key) {
  let result
  try { result = rawSetListItemIcon(text, ref, item, key) } catch (error) { return { ok: false, text, reason: `threw: ${error.message}` } }
  return typeof result === 'string' ? { ok: true, text: result, changed: result !== text } : result
}
const set = (text, ref, item, key) => {
  const result = call(text, ref, item, key)
  assert.equal(result.ok, true, `expected the edit to be made, got ${JSON.stringify(result.reason)}`)
  assert.equal(result.changed, result.text !== text, '`changed` says whether the text differs')
  return result.text
}
const refused = (text, ref, item, key) => {
  const result = call(text, ref, item, key)
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result.text)}`)
  assert.equal(result.text, text, 'a refusal returns the outline byte-identical')
  assert.equal('changed' in result, false)
  return result.reason
}
// The 0-based indexes of the lines that differ.
const changedLines = (before, after) => {
  const a = before.split('\n')
  const b = after.split('\n')
  assert.equal(b.length, a.length, 'line count unchanged')
  return a.flatMap((line, i) => (line === b[i] ? [] : [i]))
}
const ref = (heading, occurrence) => (occurrence ? { heading, occurrence } : { heading })
const K = 'lucide:star'

// ── The oracle: the FULL compiler's model (the one the slides are rendered from) ──
const modelOf = (text) => adaptMarkdownOutlineV2(text, 'outline')
function modelDiff(a, b, path, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) modelDiff(a[key], b[key], `${path}/${key}`, out)
  } else out.push({ path, a, b })
  return out
}
// The copies of the outline's source a slide carries, and the places an item's icon is held: a
// list's `iconOverrides` (a feature list, an icon row, a list inside a card, a carousel panel or
// a title slide's body) and the `icon` of a card made of a list row.
const SOURCE_FIELDS = /^\/slides\/(\d+)\/(sourceMarkdown|sourceLines|scriptSource|scriptSourceLines|scriptSourceMarkdown)(\/|$)/
const ICON_FIELDS = /^\/slides\/(\d+)\/.*\/(iconOverrides(\/\d+)?|cards\/\d+\/icon)$/
const iconOf = (key) => (key ? `lucide:${key.replace(/^lucide:/, '')}` : '')
// The model without the copies of the source: two outlines that differ by a token the compiler
// does not draw have the same one.
const drawnModel = (text) => JSON.stringify(modelOf(text).slides.map(({ sourceMarkdown, sourceLines, scriptSource, scriptSourceLines, scriptSourceMarkdown, ...rest }) => rest))
// Every icon the model holds beside an item: `has(text)` picks the items. For each, the icon ('' for none).
function itemIcons(value, has, out = []) {
  if (!value || typeof value !== 'object') return out
  if (!Array.isArray(value)) {
    const rows = Array.isArray(value.items) ? value.items : Array.isArray(value.nodes) ? value.nodes.map((node) => node?.text) : null
    if (rows) rows.forEach((entry, i) => { if (typeof entry === 'string' && has(entry)) out.push([entry, value.iconOverrides?.[i] || '']) })
    if (typeof value.title === 'string' && Array.isArray(value.blocks) && !('sourceLine' in value) && has(value.title)) out.push([value.title, value.icon || ''])
  }
  for (const child of Object.values(value)) itemIcons(child, has, out)
  return out
}
// A write, checked against the full compiler: the models differ only in copies of the source and
// in icon places, at least one icon place differs, and the item `text` has the icon `key` wherever
// the model holds it.
function assertModelShowsWrite(beforeText, afterText, text, key, where) {
  const diff = modelDiff(modelOf(beforeText), modelOf(afterText), '', [])
  for (const entry of diff) assert.ok(SOURCE_FIELDS.test(entry.path) || ICON_FIELDS.test(entry.path), `${where}: the compiled model changed at ${entry.path}: ${JSON.stringify(entry.a)} → ${JSON.stringify(entry.b)}`)
  assert.ok(diff.some((entry) => ICON_FIELDS.test(entry.path)), `${where}: the compiled model shows the item's icon changed`)
  const held = itemIcons(modelOf(afterText), (entry) => entry === text)
  assert.ok(held.length >= 1 && held.every(([, icon]) => icon === iconOf(key)), `${where}: the compiled item ${JSON.stringify(text)} carries the icon asked for: ${JSON.stringify(held)}`)
  checks += 1
}

// ── The issue's reproduction ─────────────────────────────────────────────────
{
  const src = '---\ntitle: Talk\n### Same\n- Private\n---\n### Same\n- Visible\n'
  eq(set(src, { heading: '### Same' }, 0, K), '---\ntitle: Talk\n### Same\n- Private\n---\n### Same\n- Visible {icon=lucide:star}\n', 'issue #120: the item of the slide, not the list line in the front matter')
  // The `###` line in the front matter is not a slide: there is no second `### Same`.
  eq(refused(src, ref('### Same', 2), 0, K), 'slide-not-found', 'the front matter holds no slide')
  for (const line of [1, 2, 3, 4, 5, 6]) eq(refused(src, null, { line }, K), 'not-a-list-item', `line ${line} (front matter, heading) is not an item`)
  eq(set(src, null, { line: 7 }, K), src.replace('- Visible', '- Visible {icon=lucide:star}'), 'by line: the visible item')
}

// ── Speaker notes ────────────────────────────────────────────────────────────
{
  // A list inside `:::notes` under the same slide is not counted and never changes.
  const src = '### A\n\n:::notes\n- Private one\n- Private two\n:::\n\n- Visible one\n- Visible two\n'
  eq(set(src, ref('### A'), 0, K), src.replace('- Visible one', '- Visible one {icon=lucide:star}'), 'item 0 is the first VISIBLE item')
  eq(set(src, ref('### A'), 1, K), src.replace('- Visible two', '- Visible two {icon=lucide:star}'), 'item 1 is the second visible item')
  eq(refused(src, ref('### A'), 2, K), 'not-a-list-item', 'the slide has two items, not four')
  for (const line of [3, 4, 5, 6]) eq(refused(src, ref('### A'), { line }, K), 'not-a-list-item', `line ${line} is speaker notes`)
  // Notes between two lists, and notes that run to the next heading.
  const mid = '### A\n- one\n:::notes\n- secret\n:::\n- two\n\n### B\n\n:::notes\n- only notes\n'
  eq(set(mid, ref('### A'), 1, K), mid.replace('- two', '- two {icon=lucide:star}'), 'the notes between two rows are not a row')
  eq(refused(mid, ref('### B'), 0, K), 'not-a-list-item', 'a slide with notes only has no item')
  eq(refused(mid, null, { line: 11 }, K), 'not-a-list-item', 'unclosed notes run to the end')
  // The editor's picker counts list lines itself (notes included) and so sends the LINE: the
  // address by line is right where its own item number would be wrong.
  eq(set(src, ref('### A'), { line: 8 }, K), src.replace('- Visible one', '- Visible one {icon=lucide:star}'), 'by line, with the heading of its slide')
  eq(refused(src, ref('### Other'), { line: 8 }, K), 'slide-not-found', 'by line: the heading given is not that slide\'s')
}

// ── Fenced code, simulations, charts, comments, timeline ─────────────────────
{
  const src = '### A\n\n```\n- in code\n### A\n- more code\n```\n\n- real\n'
  eq(set(src, ref('### A'), 0, K), src.replace('- real', '- real {icon=lucide:star}'), 'a list inside fenced code is not counted')
  for (const line of [3, 4, 5, 6, 7]) eq(refused(src, null, { line }, K), 'not-a-list-item', `line ${line} is code`)
  eq(refused(src, ref('### A', 2), 0, K), 'slide-not-found', 'a heading inside code is not a slide')
  for (const fence of ['```chat', '```terminal', '~~~', '````md', '```html', '```svg']) {
    const sim = `### A\n\n${fence}\n- in the fence\n${fence.replace(/[a-z]+$/, '')}\n\n- real\n`
    eq(set(sim, ref('### A'), 0, K), sim.replace('- real', '- real {icon=lucide:star}'), `${fence}: its lines are not items`)
    eq(refused(sim, null, { line: 4 }, K), 'not-a-list-item', `${fence}: a line inside is refused`)
  }
  // An unclosed fence runs to the end: nothing under it is an item.
  const open = '### A\n\n- real\n\n```\n- in code\n\n### B\n\n- also code\n'
  eq(set(open, ref('### A'), 0, K), open.replace('- real', '- real {icon=lucide:star}'))
  eq(refused(open, ref('### A'), 1, K), 'not-a-list-item', 'an unclosed fence: its lines are code')
  eq(refused(open, ref('### B'), 0, K), 'slide-not-found', 'an unclosed fence: the heading under it is code')
  // A chart's own rows and a timeline's rows are not list items of the slide.
  const chart = '### A\n\nText.\n\n{chart=bar}\n- Apples: 5\n- Pears: 3\n\n- real\n'
  eq(set(chart, ref('### A'), 0, K), chart.replace('- real', '- real {icon=lucide:star}'), 'a chart\'s rows are not counted')
  for (const line of [5, 6, 7]) eq(refused(chart, null, { line }, K), 'not-a-list-item', `chart line ${line} is refused`)
  const timeline = '### A\n\n**Timeline:**\n- 2020: start\n- 2021: more\n\nText.\n\n- real\n'
  eq(set(timeline, ref('### A'), 0, K), timeline.replace('- real', '- real {icon=lucide:star}'), 'a timeline\'s rows are not counted')
  eq(refused(timeline, null, { line: 4 }, K), 'not-a-list-item', 'a timeline row is refused')
  // HTML comments are blanked by the compiler: a list inside one is nothing.
  const comment = '### A\n\n<!--\n- hidden\n### A\n-->\n\n- real\n'
  eq(set(comment, ref('### A'), 0, K), comment.replace('- real', '- real {icon=lucide:star}'), 'a list inside a comment is not counted')
  eq(refused(comment, null, { line: 4 }, K), 'not-a-list-item', 'a line inside a comment is refused')
  // Before the first slide there is no slide to hold an item.
  eq(refused('# Talk\n\n- loose\n\n### A\n\n- real\n', null, { line: 3 }, K), 'not-a-list-item', 'a list before the first slide')
}

// ── A slide whose layout makes something else of its list rows ───────────────
//
// The review's two reproductions, then every layout token of the trigger dictionary over the same
// three rows. What decides is the full compiler's model, never the layout's name: the table below
// RECORDS, per layout the compiler gives the slide, what the model shows, and the run fails when a
// layout is not in it (a new layout has to be looked at and written down).
//   allowed   the model holds the icon beside the item: the verb writes;
//   refused   the model is the same with and without the token (the rows are the layout's own
//             parts): `icon-not-drawn-here`, for a set, a replace, a remove and "already has it".
// `drawn` records, for an allowed layout, whether the rendered slide differs once the slide's list
// style is icons (`{icons}`): on a plain list the pinned icon is held by the model and drawn when
// the list is an icon list. A carousel panel's list holds it and does not draw it.
{
  for (const [input, heading] of [
    ['### Sales {chart=bar}\n\n- Apples: 5\n- Pears: 3\n', '### Sales {chart=bar}'],
    ['### Events {timeline}\n\n- 2024: Start\n- 2025: Finish\n', '### Events {timeline}']
  ]) {
    eq(refused(input, { heading }, { line: 3 }, 'star'), 'icon-not-drawn-here', `${heading}: a row the layout draws as its own part takes no icon`)
    eq(refused(input, { heading }, 0, 'star'), 'icon-not-drawn-here', `${heading}: by item number`)
    const pinned = input.replace(/^(- .*)$/m, '$1 {icon=zap}')
    eq(drawnModel(pinned), drawnModel(input), `${heading}: the compiler draws the same with a token on the row`)
    eq(refused(pinned, { heading }, { line: 3 }, 'star'), 'icon-not-drawn-here', `${heading}: a token there is not replaced`)
    eq(refused(pinned, { heading }, { line: 3 }, null), 'icon-not-drawn-here', `${heading}: nor removed`)
    eq(refused(pinned, { heading }, { line: 3 }, 'zap'), 'icon-not-drawn-here', `${heading}: nor reported as the item's icon`)
  }

  const EXPECTED = {
    // layout the compiler gives the slide: [what the verb does, drawn when the list style is icons]
    list: ['allowed', true], 'list-visual': ['allowed', true], 'copy-visual': ['allowed', true], 'timeline-visual': ['allowed', true],
    columns: ['allowed', true], compare: ['allowed', true], cards: ['allowed', true], iconrow: ['allowed', true],
    'stmt-list': ['allowed', true], statement: ['allowed', true], quote: ['allowed', true], links: ['allowed', true],
    'image-claim': ['allowed', true], 'image-grid': ['allowed', true], 'image-quote': ['allowed', true], media: ['allowed', true],
    code: ['allowed', true], chat: ['allowed', true], 'chat-lanes': ['allowed', true], terminal: ['allowed', true], 'terminal-agent': ['allowed', true], trace: ['allowed', true],
    title: ['allowed', true], closing: ['allowed', true],
    carousel: ['allowed', false],
    chart: ['refused'], timeline: ['refused'], timetable: ['refused'], table: ['refused'], stats: ['refused'], sigmoid: ['refused'],
    pyramid: ['refused'], orgchart: ['refused'], mindmap: ['refused'], conceptmap: ['refused'], smartart: ['refused'], 'system-map': ['refused'],
    process: ['refused'], steps: ['refused'], flow: ['refused'], cycle: ['refused'], equation: ['refused'],
    contrast: ['refused'], grid: ['refused'], 'cta-screenshots': ['refused']
  }
  // The same rows under an image (round 3). Some layouts make something else of their rows only
  // when the slide has an image (`{image-claim}`: the rows are the image's callouts), so each
  // token is run a second time with one. The verdict is the table's for the layout the compiler
  // then gives the slide, but for the layouts named here; and it is checked against the full
  // compiler both ways (a refusal: the model is the same with the token; a write: the model shows it).
  const WITH_IMAGE = { 'image-claim': 'refused' }
  const rendered = (text) => renderSlideSections(modelOf(text)).map(String).join('\n')
  const seen = {}
  const seenWithImage = {}
  for (const token of ['', ...Object.keys(TRIGGER_DICTIONARY), 'chart=bar', 'chart=pie', 'cards=grid']) {
    const heading = `### Sales${token ? ` {${token}}` : ''}`
    const input = `${heading}\n\n- Apples: 5\n- Pears: 3\n- Plums: 4\n`
    const own = modelOf(input).slides.find((slide) => slide.sourceLine === 1)
    const layout = own ? own.layout : '(no slide of its own)'
    const expected = EXPECTED[layout]
    assert.ok(expected, `the layout ${JSON.stringify(layout)} ({${token}}) is not in the table: look at what its model shows and add it`)
    const row = (seen[layout] ||= { tokens: [], verdict: expected[0], drawn: expected[1] })
    row.tokens.push(token || '(none)')
    const where = `{${token}} (layout ${layout})`
    const written = `${heading}\n\n- Apples: 5 {icon=star}\n- Pears: 3\n- Plums: 4\n`
    const pinned = written.replace('star', 'zap')
    if (expected[0] === 'refused') {
      eq(drawnModel(written), drawnModel(input), `${where}: the compiler draws the same with the token`)
      eq(refused(input, { heading }, { line: 3 }, 'star'), 'icon-not-drawn-here', `${where}: set`)
      eq(refused(input, { heading }, 1, 'star'), 'icon-not-drawn-here', `${where}: set, by item number`)
      eq(refused(pinned, { heading }, { line: 3 }, 'star'), 'icon-not-drawn-here', `${where}: replace`)
      eq(refused(pinned, { heading }, { line: 3 }, null), 'icon-not-drawn-here', `${where}: remove`)
      eq(refused(pinned, { heading }, { line: 3 }, 'zap'), 'icon-not-drawn-here', `${where}: already there`)
      same(call(input, { heading }, { line: 3 }, null), { ok: true, text: input, changed: false }, `${where}: nothing to remove, nothing written`)
      // A second list on such a slide is an ordinary list: its items take an icon.
      const two = `${input}\nText.\n\n- Quinces\n- Damsons\n`
      const second = call(two, { heading }, { line: 9 }, 'star')
      if (second.ok) assertModelShowsWrite(two, second.text, 'Quinces', 'star', `${where}: the second list`)
      else eq(second.reason, 'icon-not-drawn-here', `${where}: the second list`)
      row.secondList = second.ok ? 'allowed' : 'refused'
    } else {
      eq(set(input, { heading }, { line: 3 }, 'star'), written, `${where}: set`)
      assertModelShowsWrite(input, written, 'Apples: 5', 'star', `${where}: set`)
      eq(set(written, { heading }, { line: 3 }, 'zap'), pinned, `${where}: replace`)
      assertModelShowsWrite(written, pinned, 'Apples: 5', 'zap', `${where}: replace`)
      eq(set(pinned, { heading }, { line: 3 }, null), input, `${where}: remove`)
      assertModelShowsWrite(pinned, input, 'Apples: 5', null, `${where}: remove`)
      same(call(pinned, { heading }, { line: 3 }, 'zap'), { ok: true, text: pinned, changed: false }, `${where}: already there`)
      const icons = (text) => text.replace(heading, `${heading} {icons}`)
      eq(rendered(icons(written)) !== rendered(icons(input)), expected[1], `${where}: drawn once the list style is icons`)
    }
  }
  for (const token of ['', ...Object.keys(TRIGGER_DICTIONARY), 'chart=bar', 'chart=pie', 'cards=grid']) {
    const heading = `### Sales${token ? ` {${token}}` : ''}`
    const input = `${heading}\n\n![](test.png)\n\n- Apples: 5\n- Pears: 3\n- Plums: 4\n`
    const own = modelOf(input).slides.find((slide) => slide.sourceLine === 1)
    const layout = own ? own.layout : '(no slide of its own)'
    assert.ok(EXPECTED[layout], `with an image, the layout ${JSON.stringify(layout)} ({${token}}) is not in the table`)
    ok(JSON.stringify(own).includes('test.png'), `{${token}} (layout ${layout}): the compiled slide holds the image`)
    const verdict = WITH_IMAGE[layout] || EXPECTED[layout][0]
    const row = (seenWithImage[layout] ||= { tokens: [], verdict })
    row.tokens.push(token || '(none)')
    const where = `{${token}} with an image (layout ${layout})`
    const written = input.replace('- Apples: 5', '- Apples: 5 {icon=star}')
    const pinned = written.replace('star', 'zap')
    if (verdict === 'refused') {
      eq(drawnModel(written), drawnModel(input), `${where}: the compiler draws the same with the token`)
      eq(refused(input, { heading }, { line: 5 }, 'star'), 'icon-not-drawn-here', `${where}: set`)
      eq(refused(pinned, { heading }, { line: 5 }, 'star'), 'icon-not-drawn-here', `${where}: replace`)
      eq(refused(pinned, { heading }, { line: 5 }, null), 'icon-not-drawn-here', `${where}: remove`)
      eq(refused(pinned, { heading }, { line: 5 }, 'zap'), 'icon-not-drawn-here', `${where}: already there`)
    } else {
      ok(drawnModel(written) !== drawnModel(input), `${where}: the compiler draws the token`)
      eq(set(input, { heading }, { line: 5 }, 'star'), written, `${where}: set`)
      assertModelShowsWrite(input, written, 'Apples: 5', 'star', `${where}: set`)
      eq(set(written, { heading }, { line: 5 }, 'zap'), pinned, `${where}: replace`)
      assertModelShowsWrite(written, pinned, 'Apples: 5', 'zap', `${where}: replace`)
      eq(set(pinned, { heading }, { line: 5 }, null), input, `${where}: remove`)
      assertModelShowsWrite(pinned, input, 'Apples: 5', null, `${where}: remove`)
      same(call(pinned, { heading }, { line: 5 }, 'zap'), { ok: true, text: pinned, changed: false }, `${where}: already there`)
    }
  }
  for (const layout of Object.keys(WITH_IMAGE)) ok(seenWithImage[layout], `the image table names the layout ${layout}, which no token gives a slide with an image`)
  for (const [layout, expected] of Object.entries(EXPECTED)) {
    if (expected[0] === 'allowed' && layout !== 'list') ok(seenWithImage[layout], `the allowed layout ${layout} was run with an image`)
  }
  // The review's two shapes: rows an image layout takes as its own parts (callouts of the image,
  // titles of the image cells). `{image-grid}` takes a row per image: one row and one image.
  for (const [input, heading] of [
    ['### A {image-claim}\n\n![](test.png)\n\n- Same\n- Other\n', '### A {image-claim}'],
    ['### A {image-grid}\n\n![](test.png)\n\n- Same\n', '### A {image-grid}']
  ]) {
    const pinned = input.replace('- Same', '- Same {icon=star}')
    eq(drawnModel(pinned), drawnModel(input), `${heading} with an image: the compiler draws the same with a token on the row`)
    eq(refused(input, { heading }, { line: 5 }, 'star'), 'icon-not-drawn-here', `${heading} with an image: set`)
    eq(refused(pinned, { heading }, { line: 5 }, 'zap'), 'icon-not-drawn-here', `${heading} with an image: replace`)
    eq(refused(pinned, { heading }, { line: 5 }, null), 'icon-not-drawn-here', `${heading} with an image: remove`)
    eq(refused(pinned, { heading }, { line: 5 }, 'star'), 'icon-not-drawn-here', `${heading} with an image: already there`)
  }
  for (const layout of Object.keys(EXPECTED)) ok(seen[layout], `the table names the layout ${layout}, which no token of the dictionary gives`)
  console.log('list rows by layout (the full model decides; this is the record):')
  for (const [layout, row] of Object.entries(seen)) {
    console.log(`  ${row.verdict.padEnd(8)} ${layout.padEnd(16)} ${row.verdict === 'allowed' ? `drawn with {icons}: ${row.drawn ? 'yes' : 'NO'}` : `second list: ${row.secondList}`}  {${row.tokens.slice(0, 6).join('} {')}}${row.tokens.length > 6 ? ` +${row.tokens.length - 6}` : ''}`)
  }

  console.log('the same rows under an image:')
  for (const [layout, row] of Object.entries(seenWithImage)) {
    console.log(`  ${row.verdict.padEnd(8)} ${layout.padEnd(16)} {${row.tokens.slice(0, 6).join('} {')}}${row.tokens.length > 6 ? ` +${row.tokens.length - 6}` : ''}`)
  }

  // An unclosed HTML comment is ordinary text to the compiler (html-comments.mjs), so the row
  // under it is drawn: it is an item. Recorded, not handled.
  const open = '### A\n<!--\n- private\n'
  ok(/private/.test(rendered(open)), 'the row under an unclosed comment is on the slide')
  eq(set(open, { heading: '### A' }, 0, 'star'), '### A\n<!--\n- private {icon=star}\n', 'an unclosed comment hides nothing: its row is an item')
  assertModelShowsWrite(open, '### A\n<!--\n- private {icon=star}\n', 'private', 'star', 'unclosed comment')
}

// ── "It already has this icon" is said of the addressed item only ─────────────
//
// Round 3. The answer { ok: true, changed: false } for a row that carries a token for the icon
// asked for used to be given when those words and that icon stood together ANYWHERE in the
// compiled model. It is given only when the model, compiled without this row's token and with it,
// differs in exactly this item's icon. `already` and `notDrawn` also check the oracle: the model
// is, or is not, the same without the row's token.
{
  const strip = (text, line) => text.split('\n').map((row, i) => (i === line - 1 ? row.replace(/ \{[^{}]*\}$/, '') : row)).join('\n')
  const already = (text, line, key, label) => {
    ok(drawnModel(strip(text, line)) !== drawnModel(text), `${label}: the compiler draws this row's token`)
    same(call(text, null, { line }, key), { ok: true, text, changed: false }, label)
  }
  const notDrawn = (text, line, key, label) => {
    eq(drawnModel(strip(text, line)), drawnModel(text), `${label}: the compiler draws the same without this row's token`)
    eq(refused(text, null, { line }, key), 'icon-not-drawn-here', label)
  }
  const writes = (text, line, key, label) => {
    const made = set(text, null, { line }, key)
    same(changedLines(text, made), [line - 1], `${label}: that line and no other`)
    eq(made.split('\n')[line - 1], `${text.split('\n')[line - 1]} {icon=${key}}`, label)
  }
  const chart = '### Sales {chart=bar}\n\n- Apples: 5 {icon=zap}\n- Pears: 3\n\n'
  // The review's reproduction: the same words and icon in a second list of the slide.
  const twoLists = `${chart}Text.\n\n- Apples: 5 {icon=zap}\n`
  eq(refused(twoLists, { heading: '### Sales {chart=bar}' }, { line: 3 }, 'zap'), 'icon-not-drawn-here', 'the review\'s call: a chart point is not said to have the icon of a row of another list')
  notDrawn(twoLists, 3, 'zap', 'the same words and icon in another list of the slide')
  already(twoLists, 8, 'zap', 'the row of the other list does have it')
  // ...on another slide.
  const twoSlides = `${chart}### Other\n\n- Apples: 5 {icon=zap}\n- Pears: 3\n`
  notDrawn(twoSlides, 3, 'zap', 'the same words and icon on another slide')
  already(twoSlides, 8, 'zap', 'the row of the other slide does have it')
  // ...a title with the item's words that carries the icon (a slide's, a card's).
  notDrawn(`${chart}### Apples: 5 {icon=zap}\n\nText.\n`, 3, 'zap', 'a slide title with the item\'s words carries the icon')
  notDrawn(`${chart}#### Apples: 5 {icon=zap}\n\nText.\n`, 3, 'zap', 'a child heading with the item\'s words carries the icon')
  // The review's second: the item's own words are the icon's name.
  const named = '### A {pyramid}\n\n- lucide:zap {icon=zap}\n- Other\n'
  eq(refused(named, null, { line: 3 }, 'zap'), 'icon-not-drawn-here', 'the review\'s call: a pyramid level whose words are the icon\'s name')
  notDrawn(named, 3, 'zap', 'the words of the item are the name of the icon')
  already('### A\n\n- lucide:zap {icon=zap}\n- Other\n', 3, 'zap', 'an ordinary item whose words are the icon\'s name has the icon when the model shows it')
  writes('### A\n\n- lucide:zap\n- Other\n', 3, 'zap', 'words that are the icon\'s name are not an icon: the token is written')
  // Two items with the same words on one slide: each is its own item, in either order.
  already('### A\n\n- Same {icon=zap}\n- Same\n', 3, 'zap', 'two rows with the same words: the first has it')
  writes('### A\n\n- Same {icon=zap}\n- Same\n', 4, 'zap', 'two rows with the same words: the second does not, and is written')
  writes('### A\n\n- Same\n- Same {icon=zap}\n', 3, 'zap', 'two rows with the same words: the first does not, and is written')
  already('### A\n\n- Same\n- Same {icon=zap}\n', 4, 'zap', 'two rows with the same words: the second has it')
  already('### A {cards}\n\n- Same {icon=zap}\n- Same\n- Other\n', 3, 'zap', 'two cards with the same words: the first has it')
  writes('### A {cards}\n\n- Same {icon=zap}\n- Same\n- Other\n', 4, 'zap', 'two cards with the same words: the second is written')
  // ...on two slides.
  already('### A\n\n- Same {icon=zap}\n\n### B\n\n- Same\n', 3, 'zap', 'the same words on two slides: the first has it')
  writes('### A\n\n- Same {icon=zap}\n\n### B\n\n- Same\n', 7, 'zap', 'the same words on two slides: the second is written')
  // An item whose words are its slide's title, which carries the icon.
  writes('### Same {icon=zap}\n\n- Same\n- Other\n', 3, 'zap', 'the title\'s icon is not the item\'s: the token is written')
  already('### Same {icon=zap}\n\n- Same {icon=zap}\n- Other\n', 3, 'zap', 'title and item both carry it')
}

// ── Two slides with the same heading ─────────────────────────────────────────
{
  const src = '### Same {id=aa11}\n\n- first\n\n### Same {id=bb22}\n\n- second\n\n### Same\n\n- third\n\n### Same\n\n- fourth\n'
  // Heading alone, where two slides have it: refused, never the first of them.
  eq(refused(src, { heading: '### Same' }, 0, K), 'slide-ambiguous', 'the heading alone fits two slides: refused')
  eq(set(src, ref('### Same', 2), 0, K), src.replace('- fourth', '- fourth {icon=lucide:star}'), 'heading and occurrence')
  eq(set(src, { id: 'bb22' }, 0, K), src.replace('- second', '- second {icon=lucide:star}'), 'by id')
  eq(set(src, { headingLine: 9 }, 0, K), src.replace('- third', '- third {icon=lucide:star}'), 'by the heading\'s line')
  eq(set(src, { heading: '### Same', headingLine: 13 }, 0, K), src.replace('- fourth', '- fourth {icon=lucide:star}'), 'heading and its line')
  eq(set(src, { heading: '### Same' }, { line: 11 }, K), src.replace('- third', '- third {icon=lucide:star}'), 'the item\'s line says which slide')
  eq(refused(src, { id: 'zz99' }, 0, K), 'slide-not-found')
  eq(refused(src, { heading: '### Same {id=aa11}', headingLine: 5 }, 0, K), 'slide-not-found', 'heading and line that do not agree')
  eq(refused(src, { heading: '### Same', id: 'aa11' }, { line: 7 }, K), 'slide-not-found', 'the line is in another slide than the id names')
  eq(refused(src, ref('### Same', 3), 0, K), 'slide-not-found')
  eq(refused(src, ref('### Missing'), 0, K), 'slide-not-found')
}

// ── Nested rows, ordered lists, several lists ────────────────────────────────
{
  const src = '### A\n\n- one\n  - sub one\n  - sub two\n- two\n    1. deep\n\nText.\n\n1. first\n2) second\n\n* star\n'
  const at = (index) => changedLines(src, set(src, ref('### A'), index, K))
  same([0, 1, 2, 3, 4].map(at), [[2], [5], [10], [11], [13]], 'items are the top-level rows of every list of the slide, in order')
  eq(set(src, ref('### A'), 3, K).split('\n')[11], '2) second {icon=lucide:star}', 'an ordered row')
  eq(refused(src, ref('### A'), 5, K), 'not-a-list-item', 'past the last item')
  for (const line of [4, 5, 7]) eq(refused(src, null, { line }, K), 'not-a-list-item', `line ${line} is a row under another row`)
  eq(refused(src, null, { line: 9 }, K), 'not-a-list-item', 'a paragraph is not an item')
  eq(refused(src, null, { line: 8 }, K), 'not-a-list-item', 'a blank line')
  eq(refused(src, null, { line: 99 }, K), 'not-a-list-item', 'no such line')
}

// ── Replace and remove; other braces; trailing spaces ────────────────────────
{
  const src = '### A {icons}\n\n- one {icon=lucide:zap}\n- two {star}\n- the set {a, b}\n- four   \n- five {icon=lucide:zap}  \n- six  {icon = zap }\n'
  const line = (text, i) => text.split('\n')[i]
  eq(line(set(src, ref('### A {icons}'), 0, K), 2), '- one {icon=lucide:star}', 'an existing icon is replaced: only the key changes')
  eq(line(set(src, ref('### A {icons}'), 0, null), 2), '- one', 'removed, with the one space before it')
  same(call(src, ref('### A {icons}'), 0, 'lucide:zap'), { ok: true, text: src, changed: false }, 'the icon it already has: nothing to change')
  same(call(src, ref('### A {icons}'), 0, 'zap'), { ok: true, text: src, changed: false }, 'the same icon under its short name: nothing is rewritten')
  same(call(src, ref('### A {icons}'), 1, K), { ok: true, text: src, changed: false }, 'the short form that already draws the icon asked for is left as written')
  eq(line(set(src, ref('### A {icons}'), 1, 'lucide:zap'), 3), '- two {icon=lucide:zap}', 'the short form becomes the written form inside its braces')
  eq(line(set(src, ref('### A {icons}'), 1, null), 3), '- two', 'the short form is removed')
  eq(line(set(src, ref('### A {icons}'), 2, K), 4), '- the set {a, b} {icon=lucide:star}', 'braces that are text stay; the token goes after them')
  same(call(src, ref('### A {icons}'), 2, null), { ok: true, text: src, changed: false }, 'braces that are text are not an icon to remove')
  eq(line(set(src, ref('### A {icons}'), 3, K), 5), '- four {icon=lucide:star}   ', 'trailing spaces stay after the token')
  eq(line(set(src, ref('### A {icons}'), 4, K), 6), '- five {icon=lucide:star}  ', 'replace keeps the trailing spaces')
  eq(line(set(src, ref('### A {icons}'), 4, null), 6), '- five  ', 'remove keeps the trailing spaces')
  eq(line(set(src, ref('### A {icons}'), 5, K), 7), '- six  {icon = lucide:star }', 'a token written with spaces: only its key changes')
  eq(line(set(src, ref('### A {icons}'), 5, null), 7), '- six ', 'removed with ONE space before it')
  for (let i = 0; i < 6; i += 1) for (const key of [K, null, 'star']) same(changedLines(src, call(src, ref('### A {icons}'), i, key).text).filter((n) => n !== i + 2), [], 'only the item\'s line changes')
  // set then remove gives back the outline byte for byte.
  const plain = '# Talk\n\n### A\n\n- one\n- two\n'
  eq(set(set(plain, ref('### A'), 1, K), ref('### A'), 1, null), plain, 'set then remove is exact')
  same(call(plain, ref('### A'), 1, null), { ok: true, text: plain, changed: false }, 'removing where there is none is not a refusal')
  // A key the compiler resolves is written as given.
  eq(set(plain, ref('### A'), 0, 'star'), plain.replace('- one', '- one {icon=star}'), 'a bare name')
  eq(refused(plain, ref('### A'), 0, 'no-such-icon-name-anywhere'), 'unknown-icon', 'a key that draws nothing is refused')
  // Removing a token that stands after braces the compiler would then read as an icon: refused.
  const stacked = '### A\n\n- one {star} {icon=lucide:zap}\n'
  ok(['icon-set-elsewhere', 'cannot-place-here'].includes(refused(stacked, ref('### A'), 0, null)), 'a remove that would leave another icon is refused')
  // A row that is only its token cannot lose it (the row would stop being a row).
  eq(refused('### A\n\n- {icon=lucide:zap}\n- two\n', ref('### A'), 0, null), 'cannot-place-here', 'a row made of its token only')
  // A row that carries an HTML comment: no new token beside it; an existing one is still edited.
  eq(refused('### A\n\n- one <!-- note -->\n', ref('### A'), 0, K), 'cannot-place-here', 'no new token on a line with a comment')
  eq(set('### A\n\n- one <!-- n --> {icon=lucide:zap}\n', ref('### A'), 0, K), '### A\n\n- one <!-- n --> {icon=lucide:star}\n', 'a token after a comment is replaced in place')
}

// ── Trailing layout tokens, Trigger lines, child slides ──────────────────────
{
  // Tokens after the text that are not an icon stay where they are, byte for byte.
  const src = '### A {iconlist}\n{id=ab12} {reveal}\n\n- one {reveal}\n- two {.wide} {step=2}\n- three{glued}\n\n{reveal}\n\n- four\n'
  const heading = '### A {iconlist}'
  eq(set(src, ref(heading), 0, K).split('\n')[3], '- one {reveal} {icon=lucide:star}', 'a trailing token that is no icon is kept')
  eq(set(src, ref(heading), 1, K).split('\n')[4], '- two {.wide} {step=2} {icon=lucide:star}')
  eq(set(src, ref(heading), 2, K).split('\n')[5], '- three{glued} {icon=lucide:star}')
  eq(set(src, ref(heading), 3, K).split('\n')[9], '- four {icon=lucide:star}', 'a list after a stray Trigger line')
  for (let i = 0; i < 4; i += 1) eq(set(set(src, ref(heading), i, K), ref(heading), i, null), src, `item ${i}: set then remove is exact`)
  for (const line of [1, 2, 8]) eq(refused(src, null, { line }, K), 'not-a-list-item', `line ${line} (heading, Trigger line) is not an item`)
  // A `####` under a slide is a slide of its own, with its own items.
  const cards = '# Deck\n## S\n### sub {cards=grid}\n- s1\n#### card\n- c1\n- c2\n##### deep\n### tail\n'
  eq(set(cards, ref('#### card'), 1, 'star'), cards.replace('- c2', '- c2 {icon=star}'), 'the second item of a child heading')
  eq(set(cards, ref('### sub {cards=grid}'), 0, K), cards.replace('- s1', '- s1 {icon=lucide:star}'), 'the parent\'s own item')
  eq(refused(cards, ref('### sub {cards=grid}'), 1, K), 'not-a-list-item', 'the child\'s items are not the parent\'s')
}

// ── CRLF ─────────────────────────────────────────────────────────────────────
{
  const src = '---\r\ntitle: T\r\n- fm\r\n---\r\n### A\r\n\r\n:::notes\r\n- n\r\n:::\r\n- one\r\n- two {icon=lucide:zap}  \r\n'
  const made = set(src, ref('### A'), 0, K)
  eq(made, src.replace('- one\r\n', '- one {icon=lucide:star}\r\n'), 'CRLF: the token goes before the \\r')
  ok(!/[^\r]\n/.test(made), 'no line lost its \\r')
  eq(set(made, ref('### A'), 0, null), src, 'CRLF: set then remove is exact')
  eq(set(src, ref('### A'), 1, K), src.replace('lucide:zap', 'lucide:star'), 'CRLF: replace')
  eq(set(src, ref('### A'), 1, null), src.replace('- two {icon=lucide:zap}  \r\n', '- two  \r\n'), 'CRLF: remove')
  eq(set(src, ref('### A'), { line: 10 }, K), made, 'CRLF: by line')
  for (const line of [3, 8]) eq(refused(src, null, { line }, K), 'not-a-list-item', `CRLF: line ${line} is front matter or notes`)
}

// ── Arguments of the wrong type throw before any text is read ────────────────
for (const [r, item, key] of [
  [ref('### A'), 0, 'not a key'], [ref('### A'), 0, '{x}'], [ref('### A'), 0, 'a\nb'],
  [ref('### A'), -1, K], [ref('### A'), 1.5, K], [ref('### A'), '0', K], [ref('### A'), { line: '3' }, K], [ref('### A'), null, K],
  [{}, 0, K], [null, 0, K], ['### A', 0, K], [{ heading: '### A', occurrence: 0 }, 0, K], [{ headingLine: '1' }, 0, K]
]) {
  assert.throws(() => rawSetListItemIcon('### A\n\n- one\n', r, item, key), /outline-edit:/, JSON.stringify([r, item, key])); checks += 1
}

// ── The read side lists the items the verb addresses ─────────────────────────
{
  const src = '---\ntitle: T\n### A {icons}\n- fm\n---\n### A {icons}\n\n:::notes\n- note\n:::\n```\n- code\n```\n- one {star}\n  - sub\n- two\n\n### B\n\n- not an icon slide\n'
  const model = collectIconModel(src)
  same(model.map((slide) => [slide.heading, slide.occurrence, slide.items.map((entry) => [entry.index, entry.text, entry.current])]),
    [['### A {icons}', 1, [[0, 'one', 'lucide:star'], [1, 'two', null]]]], 'collectIconModel: the compiler\'s slides and items only')
  const [slide] = model
  eq(set(src, { heading: slide.heading, occurrence: slide.occurrence }, slide.items[1].index, K), src.replace('- two', '- two {icon=lucide:star}'), 'its indexes are the verb\'s')
}

// ── The app's route: the editor sends the item's line ────────────────────────
{
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const handler = main.slice(main.indexOf("'outline:set-item-icon'"), main.indexOf("'outline:set-heading-icon'"))
  ok(/^,\s*async \(\s*_event,\s*content: string,\s*slideHeading: unknown,\s*iconKey: string \| null,\s*itemLine: unknown\s*\) => \{\s*if \(typeof itemLine !== 'number' \|\| !Number\.isInteger\(itemLine\) \|\| typeof slideHeading !== 'string'\) return null\n/.test(handler.slice("'outline:set-item-icon'".length)), 'main answers null, before anything else, without a whole-number line and a heading line')
  ok(handler.includes('const result = setListItemIcon(content, { heading: slideHeading }, { line: itemLine }, iconKey)'), 'main addresses the item by the line the editor sent, under the heading it sent')
  eq((handler.match(/setListItemIcon\(/g) || []).length, 1, 'main calls the verb in one way only')
  ok(!/itemIndex|slideOccurrence|occurrence/.test(handler.replace(/^\s*\/\/.*$/gm, '')), 'main takes no item number and no occurrence')
  ok(/if \(!result\.ok\) \{[\s\S]{0,120}?return null/.test(handler), 'main answers a refusal as null: the renderer writes nothing')
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  ok(preload.includes("ipcRenderer.invoke('outline:set-item-icon', content, slideHeading, iconKey, itemLine)"), 'preload passes the heading line and the line, and no item number')
  const workspace = readFileSync(new URL('../src/renderer/src/components/WorkspaceLayout.tsx', import.meta.url), 'utf8')
  ok(workspace.includes('setItemIcon(text, ctx.slideHeading, iconKey, ctx.itemLine)'), 'the icon picker sends the caret item\'s line')
  ok(!/\bitemIndex\b/.test(readFileSync(new URL('../src/renderer/src/extensions/outliner.ts', import.meta.url), 'utf8')), 'the caret reader counts no item number')
  ok(/if \(next == null\) throw new Error\(NO_ITEM\)[\s\S]{0,400}?result\.error === NO_ITEM\) \{\s*notify\('Couldn’t pin the icon to that item — the outline was left unchanged\.'/.test(workspace), 'a refusal (null from main) is shown as "the outline was left unchanged"')
  ok(/const ctx = iconContextRef\.current\?\.\(\) \?\? null\s*if \(!ctx\) \{\s*notify\('Place the caret in a top-level list item first/.test(workspace), 'no context: a hint, and main is not called')

  // The route itself, with the REAL caret reader (outliner.ts, bundled) and main's own mapping of
  // its arguments (asserted above against main's text): caret → context → verb → what the renderer
  // gets back. null from main is the refusal the picker shows as "the outline was left unchanged".
  const bundleDir = mkdtempSync(join(tmpdir(), 'talk-weaver-list-item-icon-'))
  const bundleUrl = pathToFileURL(join(bundleDir, 'bundle.mjs'))
  let runtime
  try {
    await build({
      stdin: {
        contents: [
          "export { EditorState } from '@codemirror/state'",
          "export { getCursorListItemContext } from './src/renderer/src/extensions/outliner.ts'"
        ].join('\n'),
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
        sourcefile: 'test-list-item-icon-verb-entry.ts'
      },
      bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', outfile: fileURLToPath(bundleUrl)
    })
    runtime = await import(bundleUrl.href)
  } finally {
    rmSync(bundleDir, { recursive: true, force: true })
  }
  const { EditorState, getCursorListItemContext } = runtime
  // main/index.ts 'outline:set-item-icon', as asserted above.
  const mainHandler = (content, slideHeading, iconKey, itemLine) => {
    if (typeof itemLine !== 'number' || !Number.isInteger(itemLine) || typeof slideHeading !== 'string') return null
    try {
      const result = rawSetListItemIcon(content, { heading: slideHeading }, { line: itemLine }, iconKey)
      return result.ok ? result.text : null
    } catch { return null }
  }
  // 'hint' (no context: nothing is sent), 'refused' (main answers null), or the new outline.
  const pick = (input, caretAt, key = 'star') => {
    const anchor = typeof caretAt === 'number' ? caretAt : input.indexOf(caretAt)
    assert.ok(anchor >= 0, `fixture holds ${JSON.stringify(caretAt)}`)
    const state = EditorState.create({ doc: input, selection: { anchor } })
    const ctx = getCursorListItemContext({ state })
    const caretLine = state.doc.lineAt(anchor).number
    if (!ctx) return 'hint'
    // The context is the caret's own line and the heading line above it, and nothing else: no
    // item number, no occurrence.
    assert.deepEqual(Object.keys(ctx).sort(), ['itemLine', 'slideHeading'], 'the context holds a heading line and a line only')
    assert.equal(ctx.itemLine, caretLine, `the context addresses the caret's own line (${caretLine}), never another`)
    const next = mainHandler(input, ctx.slideHeading, key, ctx.itemLine)
    // Without the line there is no address: nothing is written.
    for (const line of [undefined, null, '4', 4.5, NaN]) assert.equal(mainHandler(input, ctx.slideHeading, key, line), null, `no whole-number line (${String(line)}): null`)
    assert.equal(mainHandler(input, undefined, key, ctx.itemLine), null, 'no heading line: null')
    checks += 1
    return next === null ? 'refused' : next
  }
  // The review's reproduction (round 3): the caret on a list-shaped line the compiler does not
  // read as an item, with a real item after it. By the editor's item number that later row was
  // named ("- Later" took the icon); the line names the caret's row, which is refused.
  for (const [open, close] of [['```', '```'], [':::notes', ':::'], ['<!--', '-->']]) {
    const hidden = `### A\n- Visible\n${open}\n- Hidden\n${close}\n- Later\n`
    const state = EditorState.create({ doc: hidden, selection: { anchor: hidden.indexOf('Hidden') } })
    same(getCursorListItemContext({ state }), { slideHeading: '### A', itemLine: 4 }, `${open}: the context of a hidden row is its own line`)
    eq(pick(hidden, 'Hidden'), 'refused', `${open}: the caret on a hidden list-shaped row: refused, "- Later" is not written`)
    eq(pick(hidden, 'Later'), hidden.replace('- Later', '- Later {icon=star}'), `${open}: the caret on the later row writes it`)
  }
  // The review's three reproductions: the caret in code, in notes and on a nested row, each
  // under a visible bullet that used to take the icon.
  const inCode = '### A\n- Visible\n```\nconst x = 1\n- in code\n```\n'
  eq(pick(inCode, 'const'), 'hint', 'caret in code, on a line of code: no context, nothing written')
  eq(pick(inCode, 'in code'), 'refused', 'caret in code, on a list-shaped line: refused, the outline unchanged')
  eq(pick(inCode, '```'), 'hint', 'caret on the fence')
  const inNotes = '### A\n- Visible\n:::notes\nPrivate prose\n- private point\n:::\n'
  eq(pick(inNotes, 'Private'), 'hint', 'caret in notes, on prose: no context, nothing written')
  eq(pick(inNotes, 'private point'), 'refused', 'caret in notes, on a list-shaped line: refused')
  eq(pick(inNotes, ':::notes'), 'hint', 'caret on the notes fence')
  const nested = '### A\n- Parent\n  - Child\n    1. Deep\n'
  eq(pick(nested, 'Child'), 'refused', 'caret on a nested row: refused, the parent is not written')
  eq(pick(nested, 'Deep'), 'refused', 'caret on a deeper row: refused')
  eq(pick(nested, 'Parent'), '### A\n- Parent {icon=star}\n  - Child\n    1. Deep\n', 'caret on the parent: the parent')
  // A line of text under a bullet is not the bullet; a chart row and a timeline row are refused.
  eq(pick('### A\n- Visible\ncontinued here\n', 'continued'), 'hint', 'a line under a bullet does not address the bullet')
  eq(pick('### A\n- Visible\n\nText.\n', 'Text'), 'hint', 'a paragraph')
  eq(pick('- loose\n\n### A\n- Visible\n', 'loose'), 'hint', 'a list before the first heading')
  eq(pick('### Sales {chart=bar}\n\n- Apples: 5\n- Pears: 3\n', 'Apples'), 'refused', 'caret on a chart row: refused')
  eq(pick('### Events {timeline}\n\n- 2024: Start\n- 2025: Finish\n', 'Finish'), 'refused', 'caret on a timeline row: refused')
  eq(pick('---\ntitle: T\n### A\n- fm\n---\n### A\n- Visible\n', '- fm'), 'hint', 'caret in the front matter: under no heading, nothing written')
  // The caret anywhere on a real item writes that item's line.
  const two = '### A\n\n- one\n- two\n\n### A\n\n- three\n'
  eq(pick(two, 'two'), two.replace('- two', '- two {icon=star}'), 'the second bullet')
  eq(pick(two, two.indexOf('- two')), two.replace('- two', '- two {icon=star}'), 'the caret at the start of the row')
  eq(pick(two, 'three'), two.replace('- three', '- three {icon=star}'), 'the bullet of the second slide with that heading')
  eq(pick(two.replace('- one', '- one {icon=zap}'), 'one', 'star'), two.replace('- one', '- one {icon=star}'), 'replace through the route')
}

// ── The paragraph verb (#119) on the same ground: notes, front matter, code ──
{
  const src = '---\ntitle: T\nPrivate para\n---\n### A\nOne\n:::notes\nSecret\n\nSecret two\n:::\nTwo.\n\n```\ncode para\n```\n\n```chat\nuser: hi\n```\n'
  const lines = src.split('\n')
  for (let line = 1; line <= lines.length; line += 1) {
    const result = setParagraphIcon(src, line, K)
    if (line === 6 || line === 12) same(result, { ok: true, text: src.replace('Two.', 'Two. {icon=lucide:star}'), changed: true }, `line ${line}: the visible paragraph, written on its last visible line`)
    else same(result, { ok: false, text: src, reason: 'not-a-paragraph' }, `line ${line} (${JSON.stringify(lines[line - 1])}) is not a visible paragraph`)
  }
}

// ── Generated documents ──────────────────────────────────────────────────────
//
// Each line of a generated document is labelled by the generator with what it is: `item` (a
// top-level list row of slide s, the n-th of that slide), or something that is NOT one (front
// matter, notes, code, simulation, chart, timeline, comment, nested row, paragraph, heading,
// Trigger line, blank, loose list before the first slide). For every call:
//   - a refusal returns the outline unchanged;
//   - a write changes exactly one line, and that line is labelled `item` of the addressed slide
//     at the addressed position;
//   - the FULL compiler's model of the result differs from the model before only in copies of
//     the source and in icon places, an icon place does differ, the item of that line (every
//     generated item has a word of its own) has the icon asked for wherever the model holds it,
//     and every other item has the icons it had;
//   - a call that addresses a labelled item of a slide with no layout is not refused, and one that
//     addresses any other line is;
//   - a third of the headings carry a layout (a chart, a timeline, a pyramid, cards, …). Under one,
//     and under a heading that such a slide folds into itself, a labelled item may be refused, with
//     `icon-not-drawn-here` only, and each such refusal is checked against the full compiler: the
//     outline with the token put in (or changed, or taken out) by this file compiles to the same
//     model. So no write is missed and no refusal is taken on trust.
const arg = (name) => process.argv.find((entry) => entry.startsWith(`--${name}=`))?.split('=')[1]
const SEED = Number(arg('seed') ?? 20261013) >>> 0
const DOCUMENTS = Number(arg('documents') ?? 3000)

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(SEED)
const int = (n) => Math.floor(random() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => random() < p

const PLAIN_HEADINGS = ['### Same', '### Same', '### Other', '## Part', '#### Card', '### Same {icons}', '### List {iconlist}']
// Headings whose layout makes something of the slide's rows (or of its first list): what the verb
// may do under one is decided by the full compiler, call by call (see `run`).
const LAYOUT_HEADINGS = ['### Sales {chart=bar}', '### Events {timeline}', '### Levels {pyramid}', '### Stairs {steps}', '### Cells {table}',
  '### Numbers {stats}', '### Tiles {grid}', '### Way {process}', '### Pairs {contrast}', '### Org {orgchart}', '### Loop {cycle}',
  '### Cards {cards}', '### Row {iconrow}', '### Turn {carousel}', '### Said {quote}', '### Cols {columns}', '### Cmp {compare}']
const HEADINGS = [...PLAIN_HEADINGS, ...PLAIN_HEADINGS, ...LAYOUT_HEADINGS]
const underLayout = (heading) => LAYOUT_HEADINGS.some((entry) => heading.startsWith(entry))
const TAILS = ['', '', '', ' {icon=lucide:zap}', ' {star}', ' {a, b}', '   ', ' {icon=lucide:zap}  ', ' {reveal}', '\t']
const MARKS = ['- ', '- ', '* ', '1. ', '2) ']
const KEYS = [K, 'star', 'lucide:zap', null, null]

function generate() {
  const lines = [] // { text, kind, slide?, item? }
  const slides = [] // { line (0-based), heading, id, items: [lineIndex] }
  let serial = 0
  const word = () => `w${(serial += 1)}x`
  const push = (text, kind, extra = {}) => { lines.push({ text, kind, ...extra }); return lines.length - 1 }
  const listLike = (kind) => { for (let n = 1 + int(3); n > 0; n -= 1) push(`${pick(MARKS)}${word()}${pick(TAILS)}`, kind) }

  if (chance(0.6)) {
    push('---', 'frontmatter')
    push(`title: ${word()}`, 'frontmatter')
    if (chance(0.7)) push(pick(HEADINGS), 'frontmatter')
    listLike('frontmatter')
    if (chance(0.3)) { push(':::notes', 'frontmatter'); listLike('frontmatter') }
    if (chance(0.3)) { push('```', 'frontmatter'); listLike('frontmatter') }
    push('---', 'frontmatter')
  }
  if (chance(0.5)) { push(`# ${word()}`, 'title'); push('', 'blank') }
  if (chance(0.2)) { listLike('loose'); push('', 'blank') }

  for (let s = 0, count = 2 + int(4); s < count; s += 1) {
    const id = chance(0.4) ? `id${s}${word()}` : ''
    const onHeading = id && chance(0.5)
    const heading = `${pick(HEADINGS)}${onHeading ? ` {id=${id}}` : ''}`
    const slide = { line: push(heading, 'heading'), heading, id, items: [] }
    slides.push(slide)
    if (id && !onHeading) push(`{id=${id}}${chance(0.3) ? ' {reveal}' : ''}`, 'trigger')
    else if (chance(0.2)) push('{reveal}', 'trigger')
    push('', 'blank')
    const fragments = 1 + int(5)
    for (let f = 0; f < fragments; f += 1) {
      const last = f === fragments - 1
      const kind = pick(['list', 'list', 'list', 'paragraph', 'notes', 'code', 'sim', 'chart', 'timeline', 'comment'])
      if (kind === 'list') {
        const mark = pick(MARKS)
        for (let n = 1 + int(4); n > 0; n -= 1) {
          slide.items.push(push(`${mark}${word()}${pick(TAILS)}`, 'item', { slide: s, item: slide.items.length }))
          if (chance(0.25)) push(`  - ${word()}${pick(TAILS)}`, 'nested')
          if (chance(0.1)) push(`      1. ${word()}`, 'nested')
        }
      } else if (kind === 'paragraph') {
        push(`${word()} ${word()}.`, 'paragraph')
      } else if (kind === 'notes') {
        push(':::notes', 'notes')
        listLike('notes')
        if (chance(0.3)) { push('```', 'notes'); listLike('notes'); push(':::', 'notes'); push('```', 'notes') }
        if (chance(0.3)) { push('', 'notes'); listLike('notes') }
        // Unclosed notes run to the next heading: only as the slide's last fragment.
        if (!(last && chance(0.4))) push(':::', 'notes')
        else { push('', 'notes'); continue }
      } else if (kind === 'code' || kind === 'sim') {
        const fence = kind === 'sim' ? pick(['```chat', '```terminal']) : pick(['```', '~~~', '````js', '```html'])
        push(fence, kind)
        listLike(kind)
        if (chance(0.4)) push(pick(HEADINGS), kind)
        if (chance(0.3)) { push(':::notes', kind); listLike(kind); push(':::', kind) }
        push(fence.replace(/[a-z]+$/, ''), kind)
      } else if (kind === 'chart') {
        // Straight under the heading a `{chart=bar}` line is the slide's Trigger line, so text first.
        push(`${word()}.`, 'paragraph')
        push('', 'blank')
        push('{chart=bar}', 'chart')
        for (let n = 2 + int(2); n > 0; n -= 1) push(`- ${word()}: ${1 + int(9)}`, 'chart')
      } else if (kind === 'timeline') {
        push('**Timeline:**', 'timeline')
        for (let n = 2 + int(2); n > 0; n -= 1) push(`- 20${10 + int(15)}: ${word()}`, 'timeline')
        push('', 'blank')
        push(`${word()}.`, 'paragraph')
      } else {
        push('<!--', 'comment')
        listLike('comment')
        if (chance(0.4)) push(pick(HEADINGS), 'comment')
        push('-->', 'comment')
      }
      push('', 'blank')
    }
  }
  const eol = chance(0.25) ? '\r\n' : '\n'
  return { lines, slides, eol, text: lines.map((entry) => entry.text).join(eol) + (chance(0.8) ? eol : '') }
}

const tally = { calls: 0, writes: 0, unchanged: 0, refusals: 0, byIndex: 0, byLine: 0, ambiguous: 0, reasons: {}, paragraphWrites: 0, paragraphRefusals: 0, layoutWrites: 0, notDrawn: 0, notDrawnChecked: 0 }
const WORD = /w\d+x/
// word → the icons the model holds beside the item with that word.
function iconsByWord(model) {
  const out = new Map()
  for (const [entry, icon] of itemIcons(model, (text) => WORD.test(text))) {
    const word = WORD.exec(entry)[0]
    out.set(word, [...(out.get(word) || []), icon])
  }
  return out
}
// This file's own splice of a generated row, for checking a refusal: the token put in after the
// text, its key changed, or the token taken out. (Generated rows end in one of TAILS.)
const TOKEN = /\{(?:icon=lucide:zap|star)\}/
function ownSplice(line, key) {
  if (TOKEN.test(line)) return key ? line.replace(TOKEN, `{icon=${key}}`) : line.replace(new RegExp(` ${TOKEN.source}`), '')
  return key ? line.replace(/(\s*)$/, ` {icon=${key}}$1`) : line
}

function checkDocument(doc) {
  const { text, lines, slides, eol } = doc
  let before = null
  let beforeModel = null
  let beforeIcons = null
  const headingOf = (slide) => slide.heading
  const occurrenceOf = (slide) => slides.filter((other) => other.line <= slide.line && other.heading === slide.heading).length
  const unique = (slide) => slides.filter((other) => other.heading === slide.heading).length === 1

  const run = (label, ref0, item, key, expect) => {
    tally.calls += 1
    const result = call(text, ref0, item, key)
    const where = `${label} ref=${JSON.stringify(ref0)} item=${JSON.stringify(item)} key=${key}`
    if (!result.ok) {
      assert.equal(result.text, text, `${where}: a refusal returns the outline unchanged`)
      assert.ok(!String(result.reason).startsWith('threw'), `${where}: ${result.reason}`)
      tally.refusals += 1
      tally.reasons[result.reason] = (tally.reasons[result.reason] || 0) + 1
      assert.ok(expect === null || expect.mayRefuse, `${where}: refused (${result.reason}) though it addresses the item on line ${expect?.line + 1}`)
      if (expect === null) return
      // An item under a layout is refused only because the compiler draws the same either way.
      assert.equal(result.reason, 'icon-not-drawn-here', where)
      tally.notDrawn += 1
      const a = text.split(eol)
      const row = a[expect.line]
      // "Already has that icon" was asked: the compiler draws the same without the token.
      const already = TOKEN.test(row) && key && iconOf(key) === iconOf(TOKEN.exec(row)[0].replace(/[{}]|icon=/g, ''))
      a[expect.line] = ownSplice(row, already ? null : key)
      before ??= drawnModel(text)
      assert.equal(drawnModel(a.join(eol)), before, `${where}: refused as not drawn, but the compiler draws line ${expect.line + 1} differently with the token ${already ? 'taken out' : 'changed'}`)
      tally.notDrawnChecked += 1
      return
    }
    assert.ok(expect !== null, `${where}: wrote though no item is addressed:\n${result.text}`)
    const a = text.split(eol)
    const b = result.text.split(eol)
    assert.equal(b.length, a.length, `${where}: line count`)
    const changed = a.flatMap((line, i) => (line === b[i] ? [] : [i]))
    if (!result.changed) { assert.equal(result.text, text, where); tally.unchanged += 1; return }
    tally.writes += 1
    if (expect.mayRefuse) tally.layoutWrites += 1
    assert.deepEqual(changed, [expect.line], `${where}: exactly the addressed item's line changed`)
    assert.equal(lines[expect.line].kind, 'item', `${where}: the line is a list item of a slide`)
    // The full compiler: only copies of the source and icon places differ, and one icon place does.
    beforeModel ??= modelOf(text)
    const after = modelOf(result.text)
    const diff = modelDiff(beforeModel, after, '', [])
    for (const entry of diff) {
      assert.ok(SOURCE_FIELDS.test(entry.path) || ICON_FIELDS.test(entry.path), `${where}: the compiled model changed at ${entry.path}: ${JSON.stringify(entry.a)} → ${JSON.stringify(entry.b)}`)
    }
    assert.ok(diff.some((entry) => ICON_FIELDS.test(entry.path)), `${where}: the compiled model shows the item's icon changed`)
    const word = WORD.exec(lines[expect.line].text)[0]
    beforeIcons ??= iconsByWord(beforeModel)
    const afterIcons = iconsByWord(after)
    const held = afterIcons.get(word) || []
    assert.ok(held.length >= 1 && held.every((icon) => icon === iconOf(key)), `${where}: the compiled item ${word} carries exactly the icon asked for: ${JSON.stringify(held)}`)
    // Every other item of the document carries the icons it had.
    assert.deepEqual([...afterIcons].filter(([w]) => w !== word), [...beforeIcons].filter(([w]) => w !== word), `${where}: every other item kept its icon`)
  }

  // No generated item is one the verb may refuse for what its row holds (a row of its token only,
  // braces before a token, a comment on the row): an addressed item is always written, unless its
  // slide has a layout or is folded into the slide before it that has one (a `####` under cards,
  // columns, a carousel or a comparison is drawn by its parent).
  const layoutAbove = (slide) => {
    if (underLayout(slide.heading)) return true
    if (!slide.heading.startsWith('####')) return false
    const parent = slides.filter((other) => other.line < slide.line && !other.heading.startsWith('####')).pop()
    return !!parent && underLayout(parent.heading)
  }
  const itemAt = (slide, n) => ({ line: slide.items[n], mayRefuse: layoutAbove(slide) })

  for (let trial = 0; trial < 6; trial += 1) {
    const slide = pick(slides)
    const key = pick(KEYS)
    const n = int(slide.items.length + 1) // one past the end: no such item
    const expect = n < slide.items.length ? itemAt(slide, n) : null
    const mode = int(5)
    tally.byIndex += 1
    if (mode === 0) run('heading+occurrence', { heading: headingOf(slide), occurrence: occurrenceOf(slide) }, n, key, expect)
    else if (mode === 1) {
      if (unique(slide)) run('heading', { heading: headingOf(slide) }, n, key, expect)
      else {
        const result = call(text, { heading: headingOf(slide) }, n, key)
        assert.deepEqual(result, { ok: false, text, reason: 'slide-ambiguous' }, 'a heading two slides have is refused')
        tally.calls += 1; tally.refusals += 1; tally.ambiguous += 1
      }
    } else if (mode === 2 && slide.id) run('id', { id: slide.id }, n, key, expect)
    else if (mode === 3) run('headingLine', { headingLine: slide.line + 1 }, n, key, expect)
    else run('heading+headingLine', { heading: headingOf(slide), headingLine: slide.line + 1 }, n, key, expect)
  }
  // By line: every kind of line. A labelled item is written; any other line is refused.
  for (let trial = 0; trial < 10; trial += 1) {
    const at = int(lines.length)
    const entry = lines[at]
    const key = pick(KEYS)
    tally.byLine += 1
    const expect = entry.kind === 'item' ? { line: at, mayRefuse: layoutAbove(slides[entry.slide]) } : null
    const withHeading = entry.kind === 'item' && chance(0.5) ? { heading: slides[entry.slide].heading } : null
    run(`line(${entry.kind})`, withHeading, { line: at + 1 }, key, expect)
  }
  // Every line that is not an item, once, with a set: refused, and nothing changes.
  lines.forEach((entry, at) => {
    if (entry.kind === 'item') return
    const result = call(text, null, { line: at + 1 }, K)
    assert.deepEqual(result, { ok: false, text, reason: 'not-a-list-item' }, `line ${at + 1} (${entry.kind}) is not an item`)
    tally.calls += 1; tally.refusals += 1
  })
  // The paragraph verb (#119) on the same documents: it writes only on a line labelled paragraph.
  for (let trial = 0; trial < 4; trial += 1) {
    const at = int(lines.length)
    const result = setParagraphIcon(text, at + 1, K)
    if (!result.ok) { assert.equal(result.text, text); tally.paragraphRefusals += 1; continue }
    const a = text.split(eol)
    const changed = result.text.split(eol).flatMap((line, i) => (line === a[i] ? [] : [i]))
    assert.equal(changed.length, 1, 'setParagraphIcon: one line')
    assert.equal(lines[changed[0]].kind, 'paragraph', `setParagraphIcon wrote on a ${lines[changed[0]].kind} line (asked for line ${at + 1}, ${lines[at].kind})`)
    tally.paragraphWrites += 1
  }
}

for (let n = 0; n < DOCUMENTS; n += 1) {
  const doc = generate()
  try {
    checkDocument(doc)
  } catch (error) {
    console.error(`\nFAILED on document ${n + 1} of seed ${SEED} (reproduce: --seed=${SEED} --documents=${n + 1})\n${error.message}\n\n${JSON.stringify(doc.text)}\n`)
    process.exit(1)
  }
}
ok(tally.writes > DOCUMENTS && tally.refusals > DOCUMENTS && tally.ambiguous > DOCUMENTS / 50, `the generated run both wrote (${tally.writes}) and refused (${tally.refusals}; ${tally.ambiguous} for a heading two slides have)`)
if (DOCUMENTS >= 500) ok(tally.layoutWrites > DOCUMENTS / 10 && tally.notDrawnChecked > DOCUMENTS / 10 && tally.notDrawnChecked === tally.notDrawn, `under a layout the run both wrote (${tally.layoutWrites}) and refused as not drawn (${tally.notDrawn}), each refusal checked against the full compiler`)
checks += tally.calls
console.log(`generated: seed ${SEED}, ${DOCUMENTS} documents, ${tally.calls} calls (${tally.byIndex} by item number, ${tally.byLine} by line, the rest one per non-item line): ${tally.writes} writes, ${tally.unchanged} with nothing to change, ${tally.refusals} refusals ${JSON.stringify(tally.reasons)}; under a layout ${tally.layoutWrites} writes and ${tally.notDrawn} refusals as not drawn (${tally.notDrawnChecked} checked against the full compiler); setParagraphIcon ${tally.paragraphWrites} writes, ${tally.paragraphRefusals} refusals`)

console.log(`test:list-item-icon-verb — ${checks} checks passed`)
