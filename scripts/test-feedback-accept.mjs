#!/usr/bin/env node
// Accept, Compare and markers (shared-talk ticket 06) at their seams:
//   - applyProposal (src/shared/feedback-accept.ts) on real outline fixtures — the layout sampler
//     (docs/layout-sampler-outline.md: stamped ids, comments, nested sections) and the drawn talk
//     (LOCKED-feedback-rail-and-markers.html): replace keeps notes and comments and changes only the
//     lines her diff changed; delete removes the block; insert lands right after the named slide, with
//     a section heading one depth shallower than the new slide; nothing else in the file moves; Undo's
//     splice restores the text byte for byte. The slide text it reads is exactly the share push's
//     (main/shared-talk-build slideTextsByLine), so the changed-since check compares like with like;
//     the compiled slide list after each accept is checked with the real compiler.
//   - the feedback file's accepted line (the edit rides along for Undo; back to new drops it);
//   - the renderer's accept module over the real one-writer mutator (lib/outlineMutation): the guard
//     refusal, a failed save leaving the item new, the stamped save recorded for Undo;
//   - the rail's view model for Compare, Undo and a marker-opened rail; the slide pane's marker model.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { ALREADY, applyProposal, changedSince, isEmptyEdit, readOutlineSlides, SECTION_DELETE, spliceEdit, undoEdit } from '../src/shared/feedback-accept.ts'
import { CHANGED_SINCE, feedbackRailView, foldFeedback, itemLine, parseAcceptedEdit, parseAcceptRecord, statusLine } from '../src/shared/feedback.ts'
import { slideMarkers } from '../src/shared/feedback-markers.ts'
import { loadOutlineTreeLib, slideTextsByLine } from '../src/main/shared-talk-build.ts'
import { createOutlineMutator } from '../src/renderer/src/lib/outlineMutation.ts'
import { acceptProposal, DISK_CHANGED, undoAccepted } from '../src/renderer/src/lib/feedbackAccept.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const FILE = { isDirectory: () => false }
const lib = await loadOutlineTreeLib(new URL('../compiler/scripts', import.meta.url).pathname)
const sampler = readFileSync(new URL('../docs/layout-sampler-outline.md', import.meta.url), 'utf8')
/** The compiled slides of an outline: id and level, in deck order (authored slides only). */
async function compiled(text) {
  const model = await prepareSource('/tmp/feedback-accept-probe-outline.md', text, null, FILE)
  return model.slides.filter((s) => typeof s.sourceLine === 'number').map((s) => ({ id: s.id, level: s.nodeLevel, title: s.title, line: s.sourceLine }))
}
/** The pushed text of the slide with this id (what her base revision holds). */
function pushed(text, id) {
  const byLine = slideTextsByLine(lib, text)
  const slide = readOutlineSlides(text).slides.find((s) => s.id === id)
  return byLine.get(slide.line)
}
/** The lines that differ between two texts, as { removed, added } (common prefix/suffix lines dropped). */
function lineDiff(before, after) {
  const a = before.split('\n'); const b = after.split('\n')
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1
  return { at: p + 1, removed: a.slice(p, a.length - s), added: b.slice(p, b.length - s) }
}

// ── 1. The slide text read here is the share push's, slide for slide ────────────────────────────
const drawn = [
  '---', 'title: AI and assessment workshop', 'date: 2026-10-01', '---', '', // 1-5
  '## Why assessment breaks first', '{id=why}', '- Assessment was built on text being scarce', '- A fluent page is no longer evidence of effort', '', // 6-10
  '## Three failure modes', '{id=modes}', '- Substitution: the model writes the essay', '- Scaffolding drift: help quietly becomes authorship', '', // 11-15
  '## The rubric problem', '{id=rubric}', '- Rubrics reward the features a model produces most fluently', '<!-- the example from the Trinity panel -->', '- "Critical engagement" is described in words a chatbot can imitate', // 16-20
  '- Markers read for structure first, and structure is cheapest to generate', '- Every criterion we tightened made the pattern easier to match', '', ':::notes', 'Pause here. Ask who marks with a rubric.', ':::', '', // 21-27
  '## What we tried in Trinity term', '{id=tried}', '- Oral follow-ups on two essays per student', '- Marking time rose by about a third', '', // 28-32
  '## Redesign, not detection', '{id=redesign}', '- Assess the process, not only the product', '', // 33-36
  '## Close', '{id=close}', '- One change you could make before Michaelmas', '', // 37-40
].join('\n')
for (const text of [sampler, drawn]) {
  const byLine = slideTextsByLine(lib, text)
  const read = readOutlineSlides(text)
  assert.ok(read.slides.length > 5)
  for (const slide of read.slides) assert.equal(slide.text, byLine.get(slide.line), `slide at line ${slide.line} reads as the push reads it`)
}
assert.equal(readOutlineSlides(sampler).slides.filter((s) => s.id).length, 69, 'every stamped id in the sampler is found')
assert.equal(pushed(drawn, 'rubric').includes('Pause here'), false, 'notes are not in the pushed text')
console.log('PASS slide text: read exactly as the share push reads it, on the layout sampler (226 headings) and the drawn talk')

// ── 2. Replace: only her changed lines move; his notes, comments and id stay ──────────────────────
{
  const base = pushed(drawn, 'rubric')
  const hers = base
    .replace('- Rubrics reward the features a model produces most fluently', '- Rubrics reward what a model writes most fluently')
    .replace('- Markers read for structure first, and structure is cheapest to generate', '- Markers read structure first, and structure is cheapest to generate')
  const r = applyProposal(drawn, { kind: 'replace', slideId: 'rubric', text: hers }, { text: base })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.changedSince, false)
  assert.equal(r.line, 16)
  const d1 = lineDiff(drawn, r.text)
  assert.deepEqual(d1.removed, ['- Rubrics reward the features a model produces most fluently', '<!-- the example from the Trinity panel -->', '- "Critical engagement" is described in words a chatbot can imitate', '- Markers read for structure first, and structure is cheapest to generate'])
  assert.deepEqual(d1.added, ['- Rubrics reward what a model writes most fluently', '<!-- the example from the Trinity panel -->', '- "Critical engagement" is described in words a chatbot can imitate', '- Markers read structure first, and structure is cheapest to generate'])
  assert.ok(r.text.includes(':::notes\nPause here. Ask who marks with a rubric.\n:::'), 'his notes kept')
  assert.ok(r.text.includes('<!-- the example from the Trinity panel -->'), 'his comment kept')
  assert.equal(pushed(r.text, 'rubric'), hers.replace(/\n{3,}/g, '\n\n'), 'the slide now reads exactly as hers')
  // Exactly the lines the diff showed changed: the two lines, nothing else in the file.
  const changed = r.text.split('\n').filter((line, i) => line !== drawn.split('\n')[i])
  assert.deepEqual(changed, ['- Rubrics reward what a model writes most fluently', '- Markers read structure first, and structure is cheapest to generate'])
  // Undo: the splice back, byte for byte.
  const u = undoEdit(r.text, r.edit)
  assert.equal(u.ok && u.text, drawn)
  // Her text without the Trigger line (she deleted it): the id comes back on its own line.
  const noId = applyProposal(drawn, { kind: 'replace', slideId: 'rubric', text: hers.replace('{id=rubric}\n', '') }, { text: base })
  assert.equal(readOutlineSlides(noId.text).slides.find((s) => s.line === 16).id, 'rubric', 'the slide keeps its id')
  // Her text carrying another slide's id: dropped.
  const stolen = applyProposal(drawn, { kind: 'replace', slideId: 'rubric', text: hers.replace('{id=rubric}', '{id=close}') }, { text: base })
  assert.equal(readOutlineSlides(stolen.text).slides.filter((s) => s.id === 'close').length, 1)
  assert.equal(readOutlineSlides(stolen.text).slides.find((s) => s.line === 16).id, 'rubric')

  // She rewrote the lines either side of his comment (her page shows it as a blank line, which she
  // dropped): hers take his lines' places one for one, so the comment stays between them.
  const around = applyProposal(drawn, { kind: 'replace', slideId: 'rubric', text: base
    .replace('- Rubrics reward the features a model produces most fluently\n\n- "Critical engagement" is described in words a chatbot can imitate', '- Rubrics reward what a model writes\n- Critical engagement is imitable') }, { text: base })
  assert.deepEqual(lineDiff(drawn, around.text).added, ['- Rubrics reward what a model writes', '<!-- the example from the Trinity panel -->', '- Critical engagement is imitable'])
  // On the sampler: a real stamped slide; add his notes and a comment first; only her line changes.
  const id = 't28-iconlist-4'
  const own = sampler.replace('- Ship {icon=lucide:rocket}\n\n### Icon list boxes', '- Ship {icon=lucide:rocket}\n<!-- rocket reads as hype; try a box -->\n\n:::notes\nFour items: rows, not boxes.\n:::\n\n### Icon list boxes')
  assert.notEqual(own, sampler)
  const sBase = pushed(own, id)
  const sHers = sBase.replace('- Build {icon=lucide:hammer}', '- Build it {icon=lucide:hammer}')
  const s = applyProposal(own, { kind: 'replace', slideId: id, text: sHers }, { text: sBase })
  assert.equal(s.ok, true)
  assert.deepEqual(lineDiff(own, s.text), { at: lineDiff(own, s.text).at, removed: ['- Build {icon=lucide:hammer}'], added: ['- Build it {icon=lucide:hammer}'] })
  assert.deepEqual((await compiled(s.text)).map((x) => x.id), (await compiled(own)).map((x) => x.id), 'every slide still compiles, in the same order, same ids')
  assert.equal(undoEdit(s.text, s.edit).text, own)
  // CRLF talk: her lines take the talk's line ending.
  const crlf = drawn.replace(/\n/g, '\r\n')
  const c = applyProposal(crlf, { kind: 'replace', slideId: 'rubric', text: hers }, { text: base })
  assert.equal(c.ok, true)
  assert.equal(c.text.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF introduced')
  assert.equal(c.text.replace(/\r\n/g, '\n'), r.text)
}
console.log('PASS replace: only the lines her diff changed; notes, comments and id kept; Undo restores; sampler compiles the same; CRLF kept')

// ── 3. Changed-since: flags a change to what she saw, not to his notes ─────────────────────────────
{
  const base = pushed(drawn, 'rubric')
  const item = { kind: 'replace', slideId: 'rubric', text: base }
  assert.equal(changedSince(readOutlineSlides(drawn), item, { text: base }), false)
  const notesOnly = drawn.replace('Pause here.', 'Pause here, longer.')
  assert.equal(changedSince(readOutlineSlides(notesOnly), item, { text: base }), false, 'his notes are not what she saw')
  const commentOnly = drawn.replace('the example from the Trinity panel', 'the Trinity example')
  assert.equal(changedSince(readOutlineSlides(commentOnly), item, { text: base }), false, 'nor his comments')
  const edited = drawn.replace('made the pattern easier to match', 'made the pattern easier to generate')
  assert.equal(changedSince(readOutlineSlides(edited), item, { text: base }), true, 'a visible line changed')
  assert.equal(changedSince(readOutlineSlides(edited), item, { text: null }), null, 'no base kept: cannot tell')
  const r = applyProposal(edited, { kind: 'replace', slideId: 'rubric', text: base.replace('- Rubrics reward the features', '- Rubrics reward mostly the features') }, { text: base })
  assert.equal(r.changedSince, true)
  // Use hers over his change: her text wins the visible lines (his notes still kept).
  assert.equal(pushed(r.text, 'rubric').includes('easier to generate'), false)
  assert.ok(r.text.includes('Pause here.'))
  // A slide no longer in the talk.
  const gone = applyProposal(drawn, { kind: 'replace', slideId: 'nope', text: base }, { text: base })
  assert.deepEqual([gone.ok, gone.code], [false, 'not-found'])
}
console.log('PASS changed-since: a visible change flags; notes or comments do not; no base = cannot tell; missing slide refused')

// ── 4. Delete: the block goes, nothing else ────────────────────────────────────────────────────────
{
  const r = applyProposal(drawn, { kind: 'delete', slideId: 'tried' }, { text: pushed(drawn, 'tried') })
  assert.equal(r.ok, true)
  assert.deepEqual(lineDiff(drawn, r.text).removed, ['## What we tried in Trinity term', '{id=tried}', '- Oral follow-ups on two essays per student', '- Marking time rose by about a third', ''])
  assert.deepEqual(lineDiff(drawn, r.text).added, [])
  assert.deepEqual((await compiled(r.text)).map((s) => s.id), ['why', 'modes', 'rubric', 'redesign', 'close'])
  assert.equal(undoEdit(r.text, r.edit).text, drawn)
  // Sampler: a slide inside a section; its section and siblings keep their places.
  const before = await compiled(sampler)
  const s = applyProposal(sampler, { kind: 'delete', slideId: 'doctor-underfill' }, { text: null })
  assert.equal(s.changedSince, null, 'no base: the rail flags it')
  const after = await compiled(s.text)
  assert.deepEqual(after.map((x) => `${x.level} ${x.id}`), before.filter((x) => x.id !== 'doctor-underfill').map((x) => `${x.level} ${x.id}`))
}
console.log('PASS delete: the block and its spacing go; every other slide compiles in place; Undo restores')

// ── 5. Insert: right after the named slide; a section one depth shallower than the slide ─────────
{
  const hers = '## Students asked for the rules in writing\n{id=stolen}\n- Most used a chatbot to start a draft\n- A one-page course policy settled most questions'
  // Frame 1's case: every slide a `##`. With a section: `## section`, `### slide`, after slide 3.
  const r = applyProposal(drawn, { kind: 'insert', afterSlideId: 'rubric', section: 'What students told us', text: hers }, { text: null })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.afterLine, 26, 'after the last line of slide 3\'s block')
  const d = lineDiff(drawn, r.text)
  assert.deepEqual(d.removed, [])
  assert.deepEqual(d.added, ['## What students told us', '', '### Students asked for the rules in writing', '- Most used a chatbot to start a draft', '- A one-page course policy settled most questions', ''])
  assert.equal(r.text.includes('{id=stolen}'), false, 'her id tokens dropped: the save mints fresh ones')
  const c = await compiled(r.text)
  assert.deepEqual(c.map((s) => `${s.level} ${s.title}`).slice(2, 6), ['2 The rubric problem', '2 What students told us', '3 Students asked for the rules in writing', '2 What we tried in Trinity term'])
  assert.equal(r.text.split('\n')[r.line - 1], '### Students asked for the rules in writing', 'line = the new slide')
  assert.equal(undoEdit(r.text, r.edit).text, drawn)
  // No section: a sibling of the named slide at its depth.
  const plain = applyProposal(drawn, { kind: 'insert', afterSlideId: 'modes', text: '### Deep heading she typed\n- point' }, { text: null })
  assert.deepEqual(lineDiff(drawn, plain.text).added, ['## Deep heading she typed', '- point', ''])
  assert.equal(plain.afterLine, 14)
  // No heading at all: a titled slide.
  const bare = applyProposal(drawn, { kind: 'insert', afterSlideId: 'close', text: '- just a point' }, { text: null })
  assert.ok(bare.text.endsWith('## Close\n{id=close}\n- One change you could make before Michaelmas\n\n## New slide\n- just a point\n'), 'at the end, the final newline stays final')
  // At the start.
  const start = applyProposal(drawn, { kind: 'insert', afterSlideId: 'start', text: '## Opening\n- hello' }, { text: null })
  assert.deepEqual((await compiled(start.text)).map((s) => s.title).slice(0, 2), ['Opening', 'Why assessment breaks first'])
  // Her unclosed fence would swallow the rest of the talk: refused, nothing changed.
  const fence = applyProposal(drawn, { kind: 'insert', afterSlideId: 'rubric', text: '## Code\n```js\nlet x = 1' }, { text: null })
  assert.deepEqual([fence.ok, fence.code], [false, 'refused'])

  // The sampler: a `###` slide mid-section. The new section is a `###` sibling, its slide a `####`;
  // every other slide keeps its level and parent order.
  const before = await compiled(sampler)
  const at = before.findIndex((s) => s.id === 't28-iconlist-3')
  const s = applyProposal(sampler, { kind: 'insert', afterSlideId: 't28-iconlist-3', section: 'From the colleague', text: hers }, { text: null })
  assert.equal(s.ok, true, s.error)
  const after = await compiled(s.text)
  assert.deepEqual(after.slice(at, at + 4).map((x) => `${x.level} ${x.title}`), [
    `${before[at].level} ${before[at].title}`, `${before[at].level} From the colleague`, `${before[at].level + 1} Students asked for the rules in writing`, `${before[at + 1].level} ${before[at + 1].title}`,
  ])
  assert.deepEqual(after.filter((x) => x.id !== undefined && before.some((b) => b.id === x.id)).map((x) => `${x.level} ${x.id}`), before.map((x) => `${x.level} ${x.id}`), 'every other slide as it was')
  // A slide with children: the new slide comes first among them, at their depth (no child re-parented).
  const parentId = 'where'
  const nested = '---\ntitle: N\n---\n\n## Where it breaks\n{id=where}\n\n### Child one\n{id=c1}\n- a\n\n### Child two\n{id=c2}\n- b\n'
  const n = applyProposal(nested, { kind: 'insert', afterSlideId: parentId, text: '## Hers\n- x' }, { text: null })
  assert.deepEqual((await compiled(n.text)).map((x) => `${x.level} ${x.title}`), ['2 Where it breaks', '3 Hers', '3 Child one', '3 Child two'])
  const named = applyProposal(nested, { kind: 'insert', afterSlideId: 'gone', text: '## Hers' }, { text: null })
  assert.deepEqual([named.ok, named.code], [false, 'not-found'])
}
console.log('PASS insert: right after the named slide; section heading one depth shallower, slide as its first child; ids dropped; structure kept; fence refused; Undo restores')

// ── 6. The feedback file: an accepted line carries the edit; Undo (back to new) drops it ──────────
{
  const edit = spliceEdit('a\nb\n', 'a\nB\n', 2)
  const item = { itemId: 'e1', kind: 'replace', slideId: 'rubric', baseRevision: 1, text: 'x', createdAt: 1, seq: 1, status: 'new' }
  let fold = foldFeedback([itemLine(item, 1), statusLine('e1', 'accepted', 5, edit)].join('\n'))
  assert.deepEqual(fold.items[0].acceptedEdit, edit)
  assert.deepEqual(fold.unsynced, [{ itemId: 'e1', status: 'accepted' }])
  fold = foldFeedback([itemLine(item, 1), statusLine('e1', 'accepted', 5, edit), statusLine('e1', 'new', 6)].join('\n'))
  assert.equal(fold.items[0].status, 'new'); assert.equal(fold.items[0].acceptedEdit, null)
  assert.equal(JSON.parse(statusLine('e1', 'done', 1, edit)).edit, undefined, 'only an accepted line carries an edit')
  for (const bad of [null, {}, { ...edit, from: -1 }, { ...edit, inserted: 5 }, { ...edit, before: 'x'.repeat(201) }]) assert.equal(parseAcceptedEdit(bad), null)
  assert.deepEqual(parseAcceptedEdit(edit), edit)
}
console.log('PASS feedback file: accepted line carries the splice; back to new drops it; bad edits refused')

// ── 7. The renderer's accept over the one-writer mutator ──────────────────────────────────────────
{
  const PATH = '/vault/t/t-outline.md'
  const make = ({ saveOk = true, stamp = false, disk = false } = {}) => {
    const state = { buffer: drawn, writes: [], statuses: [], disk }
    const mutator = createOutlineMutator({
      bufferFor: (p) => (p === PATH ? {
        read: () => state.buffer,
        apply: (_p, next) => { state.buffer = next; return next },
        adopt: (_p, sent, saved) => { if (state.buffer === sent) state.buffer = saved },
      } : null),
      settled: async () => {},
      write: async (_p, text) => {
        state.writes.push(text)
        if (!saveOk) return false
        // The save stamps an id on the new heading, as main's writer does.
        return stamp ? { ok: true, content: text.replace('### Students asked for the rules in writing\n', '### Students asked for the rules in writing\n{id=fresh1}\n') } : { ok: true }
      },
    })
    const deps = {
      targetPath: () => PATH,
      diskChanged: () => state.disk,
      apply: (p, mutate) => mutator.apply(p, mutate),
      setStatus: async (itemId, status, edit) => { state.statuses.push({ itemId, status, edit }); return { success: true } },
    }
    return { state, deps }
  }
  const base = pushed(drawn, 'rubric')
  const replace = { kind: 'replace', slideId: 'rubric', text: base.replace('the features a model produces', 'what a model writes') }

  // The guard holds the talk: nothing applied, nothing marked.
  let t = make({ disk: true })
  let out = await acceptProposal('e1', replace, { text: base }, t.deps)
  assert.deepEqual(out, { ok: false, error: DISK_CHANGED, applied: false })
  assert.equal(t.state.buffer, drawn); assert.deepEqual(t.state.writes, []); assert.deepEqual(t.state.statuses, [])

  // A save that fails: the change is in the editor (⌘Z), the item stays new.
  t = make({ saveOk: false })
  out = await acceptProposal('e1', replace, { text: base }, t.deps)
  assert.equal(out.ok, false); assert.equal(out.applied, true); assert.deepEqual(t.state.statuses, [])

  // Accept: one save of the buffer, then accepted with the splice; Undo restores and sets it new.
  t = make()
  out = await acceptProposal('e1', replace, { text: base }, t.deps)
  assert.deepEqual(out, { ok: true, line: 16 })
  assert.equal(t.state.writes.length, 1, 'saved once, through the queue')
  assert.equal(t.state.statuses[0].status, 'accepted')
  const edit = t.state.statuses[0].edit
  t.state.buffer = t.state.buffer.replace('## Close', '## Close, typed after') // he types elsewhere afterwards
  out = await undoAccepted('e1', edit, t.deps)
  assert.equal(out.ok, true)
  assert.equal(t.state.buffer, drawn.replace('## Close', '## Close, typed after'), 'Undo takes out only her change')
  assert.deepEqual(t.state.statuses.map((s) => s.status), ['accepted', 'new'])

  // Insert with a stamping save: the recorded splice is what the file holds, so Undo restores exactly.
  t = make({ stamp: true })
  out = await acceptProposal('i1', { kind: 'insert', afterSlideId: 'rubric', section: 'What students told us', text: '## Students asked for the rules in writing\n- A policy' }, { text: null }, t.deps)
  assert.equal(out.ok, true)
  assert.ok(t.state.buffer.includes('{id=fresh1}'), 'the editor adopted the stamped id')
  assert.ok(t.state.statuses[0].edit.inserted.includes('{id=fresh1}'))
  out = await undoAccepted('i1', t.state.statuses[0].edit, t.deps)
  assert.equal(t.state.buffer, drawn)

  // Undo after her text itself was edited: refused, nothing changed.
  t = make()
  await acceptProposal('e1', replace, { text: base }, t.deps)
  t.state.buffer = t.state.buffer.replace('what a model writes', 'what models write')
  const held = t.state.buffer
  out = await undoAccepted('e1', t.state.statuses[0].edit, t.deps)
  assert.equal(out.ok, false); assert.equal(t.state.buffer, held)
}
console.log('PASS accept module: guard refusal, failed save keeps the item new, saved once then marked, stamped splice recorded, Undo exact and refused after edits')

// ── 8. The rail's view: Compare, Undo, opened from a marker ─────────────────────────────────────────
{
  const now = new Date(2026, 8, 28, 8, 20).getTime()
  const base = pushed(drawn, 'rubric')
  const his = drawn.replace('made the pattern easier to match', 'made the pattern easier to game')
  const slides = readOutlineSlides(his).slides.map((s) => ({ slideId: s.id, title: s.text.split('\n')[0].replace(/^#+\s*/, ''), line: s.line }))
  const common = { statusAt: null, syncedStatus: 'new', syncFailed: null, acceptedEdit: null, baseTitle: null, status: 'new', baseAt: new Date(2026, 8, 27, 22, 51).toISOString() }
  const hersText = '## The rubric problem\n{id=rubric}\n- Rubrics reward what a model writes most fluently\n- Markers read structure first\n- Tightening criteria made the pattern easier to match'
  const items = [
    { ...common, itemId: 'e1', kind: 'replace', slideId: 'rubric', baseRevision: 3, baseText: base, text: hersText, createdAt: new Date(2026, 8, 27, 23, 41).getTime(), seq: 3 },
    { ...common, itemId: 'n1', kind: 'note', slideId: 'rubric', text: 'Too dense.', createdAt: new Date(2026, 8, 27, 23, 28).getTime(), seq: 1 },
    { ...common, itemId: 'n2', kind: 'note', slideId: 'redesign', text: 'Who?', createdAt: new Date(2026, 8, 27, 23, 35).getTime(), seq: 2 },
    { ...common, itemId: 'h1', kind: 'replace', slideId: 'modes', baseText: 'x', text: 'y', status: 'accepted', statusAt: new Date(2026, 8, 28, 8, 14).getTime(), acceptedEdit: spliceEdit('a', 'b', 13), createdAt: 1, seq: 0 },
  ]
  const list = { key: 'k', shareId: 'k7m2abcd', link: 'drafts.handouts.fyi/k7m2', connection: 'connected', items }
  let view = feedbackRailView({ list, slides, outline: his, filter: 'slide', activeSlideId: 'rubric', now, fromMarker: true })
  assert.equal(view.countLabel, 'Slide 3 · 2 new')
  assert.equal(view.sub, 'Opened from the marker on slide 3 · 1 more new elsewhere')
  assert.deepEqual(view.group, { number: '3', title: 'The rubric problem' })
  const e1 = view.rows.find((r) => r.itemId === 'e1')
  assert.equal(e1.flag, CHANGED_SINCE)
  assert.deepEqual(e1.actions.map((a) => a.label), ['Compare', 'Accept', 'Dismiss'], 'the flagged edit leads with Compare')
  assert.equal(e1.slideRef, null, 'the slide group heading names the slide')
  assert.deepEqual(e1.compare.yours.map((l) => [l.text, l.changed]), [
    ['- Rubrics reward the features a model produces most fluently', false], ['', false],
    ['- "Critical engagement" is described in words a chatbot can imitate', false],
    ['- Markers read for structure first, and structure is cheapest to generate', false],
    ['- Every criterion we tightened made the pattern easier to game', true],
  ], 'heading and id left out; his line changed since highlighted')
  assert.deepEqual(e1.compare.hers, ['- Rubrics reward what a model writes most fluently', '- Markers read structure first', '- Tightening criteria made the pattern easier to match'])
  assert.equal(e1.compare.hersLabel, 'Hers · written against your Sun 22:51 save')
  assert.equal(e1.compare.useHersNote, 'Using hers replaces all four of your current lines. Your notes and comments stay.')
  view = feedbackRailView({ list, slides, outline: his, filter: 'all', activeSlideId: 'rubric', now })
  const h1 = view.rows.find((r) => r.itemId === 'h1')
  assert.deepEqual(h1.stamp, { text: 'Accepted 08:14 today · in the outline, line 13', tone: 'accepted' })
  assert.equal(h1.undo, true)
  // Unchanged slide: no flag, Accept straight away.
  view = feedbackRailView({ list, slides, outline: drawn, filter: 'all', activeSlideId: null, now })
  assert.equal(view.rows.find((r) => r.itemId === 'e1').flag, null)
  // A slide no longer in the talk: Accept is disabled and says why.
  view = feedbackRailView({ list: { ...list, items: [{ ...items[0], slideId: 'gone' }] }, slides, outline: drawn, filter: 'all', activeSlideId: null, now })
  assert.deepEqual(view.rows[0].actions.map((a) => [a.label, a.disabled]), [['Accept', true], ['Dismiss', false]])
}
console.log('PASS view: flagged edit leads with Compare (yours highlighted, hers, base time), marker-opened header, Accepted stamp with line and Undo, gone slide disables Accept')

// ── 9. Markers on the slide pane ──────────────────────────────────────────────────────────────────
{
  const at = (h) => new Date(2026, 8, 27, h).getTime()
  const it = (over) => ({ itemId: over.itemId, kind: 'note', status: 'new', createdAt: at(20), seq: 1, ...over })
  const m = slideMarkers([
    it({ itemId: 'a', slideId: 'rubric' }),
    it({ itemId: 'b', kind: 'replace', slideId: 'rubric' }),
    it({ itemId: 'c', kind: 'delete', slideId: 'tried' }),
    it({ itemId: 'd', slideId: 'modes', status: 'accepted' }),
    it({ itemId: 'e', slideId: 'redesign', status: 'done' }),
    it({ itemId: 'f', slideId: 'redesign' }),
    it({ itemId: 'g', kind: 'insert', afterSlideId: 'rubric', section: 'What students told us', text: '## Students asked\n- x', createdAt: at(23) }),
    it({ itemId: 'h', kind: 'insert', afterSlideId: 'rubric', text: '- no heading', createdAt: at(22) }),
    it({ itemId: 'i', kind: 'insert', afterSlideId: 'why', status: 'accepted', text: '## Gone in' }),
    it({ itemId: 'j', kind: 'insert', afterSlideId: 'start', text: '## First' }),
    it({ itemId: 'k', slideId: 'not-in-talk' }),
    it({ itemId: 'l', kind: 'insert', afterSlideId: 'not-in-talk', text: '## Orphan' }),
  ], ['why', 'modes', 'rubric', 'tried', 'redesign', 'close'])
  assert.deepEqual(m.bySlide, {
    rubric: { count: 2, handled: false, deletion: false },
    tried: { count: 1, handled: false, deletion: true },
    modes: { count: 0, handled: true, deletion: false },
    redesign: { count: 1, handled: false, deletion: false },
  })
  assert.deepEqual(m.ghosts.map((g) => [g.itemId, g.afterNumber, g.title, g.section]), [
    ['j', 0, 'First', null], ['h', 3, 'New slide', null], ['g', 3, 'Students asked', 'What students told us'],
  ], 'unhandled inserts only, where they go, oldest first after the same slide')
}
console.log('PASS markers: counts per slide, red for a deletion, tick once handled, ghost rows for unhandled new slides in place')

// ── 10. Fix round: containers, sections, open markup, restructuring, an accept applied twice ──────
{
  // The headings Accept treats as folded into a container are exactly the headings the compiler
  // makes no slide of, on the layout sampler fixture (cards, carousel, contrast, compare, columns,
  // image grid). The private design-showcase deck is not used: it is not in the public tree.
  for (const file of ['../docs/layout-sampler-outline.md']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    const compiledLines = new Set((await compiled(text)).map((s) => s.line))
    const read = readOutlineSlides(text)
    assert.ok(read.slides.some((s) => s.folded))
    assert.deepEqual(read.slides.filter((s) => s.folded).map((s) => s.line), read.slides.filter((s) => !compiledLines.has(s.line)).map((s) => s.line), `${file}: folded = not compiled`)
  }
  const read = readOutlineSlides(sampler)
  const at = (title) => read.slides.find((s) => sampler.split('\n')[s.line - 1] === title)
  const carousel = at('### A month with agents (carousel)')
  const rows = at('### Three roles of AI (rows)')
  assert.equal(carousel.container, true); assert.equal(rows.container, true)
  const before = await compiled(sampler)

  // 2. Deleting a container takes its folded children with it: nothing attaches to the slide before.
  for (const slide of [carousel, rows]) {
    const r = applyProposal(sampler, { kind: 'delete', slideId: 'unstamped' }, { text: null, line: slide.line })
    assert.equal(r.ok, true, r.error)
    const removed = lineDiff(sampler, r.text).removed
    assert.ok(removed[0] === sampler.split('\n')[slide.line - 1] && removed.filter((l) => /^#### /.test(l)).length >= 2, 'its #### children go with it')
    const after = await compiled(r.text)
    assert.deepEqual(after.map((s) => `${s.level} ${s.title}`), before.filter((s) => s.line !== slide.line).map((s) => `${s.level} ${s.title}`), 'every other slide as it was, with its own content')
    const prevBefore = before[before.findIndex((s) => s.line === slide.line) - 1]
    const prevAfter = (await prepareSource('/tmp/p-outline.md', r.text, null, FILE)).slides.find((s) => s.title === prevBefore.title && s.sourceLine === prevBefore.line)
    assert.ok(prevAfter, 'the slide before keeps its place')
    assert.equal(undoEdit(r.text, r.edit).text, sampler)
  }
  // Replace on a container: only its own lines; the cards stay.
  const cBase = slideTextsByLine(lib, sampler).get(carousel.line) // what her page holds for it
  const cr = applyProposal(sampler, { kind: 'replace', slideId: 'unstamped', text: cBase.replace('### A month with agents (carousel)', '### A month with my agents (carousel)') }, { text: cBase, line: carousel.line })
  assert.equal(cr.ok, true, cr.error)
  assert.deepEqual(lineDiff(sampler, cr.text), { at: carousel.line, removed: ['### A month with agents (carousel)'], added: ['### A month with my agents (carousel)'] })
  // Insert after a container: after its folded children, never among them.
  const ins = applyProposal(sampler, { kind: 'insert', afterSlideId: 'unstamped', text: '### Hers after the carousel\n- x' }, { text: null, line: carousel.line })
  const ci = await compiled(ins.text)
  const k = ci.findIndex((s) => s.title === 'A month with agents (carousel)')
  assert.equal(ci[k + 1].title, 'Hers after the carousel', 'the next slide, not a card')
  assert.equal(ci.length, before.length + 1)

  // 4. A section's heading (here a section divider) is not deleted: its slides would fall under the title.
  const divider = at('## Section divider')
  assert.equal(divider.opensSection, true)
  const dr = applyProposal(sampler, { kind: 'delete', slideId: 'unstamped' }, { text: null, line: divider.line })
  assert.deepEqual([dr.ok, dr.error], [false, SECTION_DELETE])
  const slides = before.map((s) => ({ slideId: `L${s.line}`, title: s.title, line: s.line }))
  const view = feedbackRailView({
    list: { key: 'k', shareId: 'k7m2abcd', link: 'x', connection: 'connected', items: [{ itemId: 'd', kind: 'delete', slideId: `L${divider.line}`, status: 'new', statusAt: null, syncedStatus: 'new', syncFailed: null, acceptedEdit: null, baseText: null, baseTitle: null, createdAt: 1, seq: 1 }] },
    slides, outline: sampler, filter: 'all', activeSlideId: null, now: 2,
  })
  assert.equal(view.rows[0].hint, SECTION_DELETE, 'the rail says why')
  assert.deepEqual(view.rows[0].actions.map((a) => [a.label, a.disabled, a.title]), [['Accept', true, SECTION_DELETE], ['Dismiss', false, undefined]])
}
{
  const base = pushed(drawn, 'rubric')
  const replace = (text) => applyProposal(drawn, { kind: 'replace', slideId: 'rubric', text }, { text: base })
  // 1. Her unclosed comment would pair with his `-->` and hide his lines: refused. So is an open fence.
  let r = replace(base.replace('- Rubrics reward the features', '<!-- todo\n- Rubrics reward the features'))
  assert.equal(r.ok, false); assert.match(r.error, /comment \(<!--\) or a code fence open/)
  r = replace(base + '\n```js\nlet x = 1')
  assert.equal(r.ok, false); assert.match(r.error, /code fence open/)
  r = applyProposal(drawn, { kind: 'insert', afterSlideId: 'modes', text: '## Hers\n<!-- open' }, { text: null })
  assert.equal(r.ok, false); assert.match(r.error, /comment/)
  // A closed comment of hers is fine (it stays hers, hidden like his).
  assert.equal(replace(base + '\n<!-- her aside -->').ok, true)
  // 3. No restructuring: the heading's depth, an added heading, a title line.
  for (const bad of [base.replace('## The rubric problem', '### The rubric problem'), base + '\n\n## A second slide', base + '\n### A child', base + '\n# Retitled']) {
    r = replace(bad)
    assert.equal(r.ok, false, bad); assert.match(r.error, /heading level or adds a heading or a title line/)
  }
  assert.equal(replace(base.replace('## The rubric problem', '## The rubric trap')).ok, true, 'the heading text may change')
  assert.equal(replace(base.replace('## The rubric problem\n', '')).ok, false, 'dropping the heading is refused')

  // 5. Applied once already (a guard-refused save he then kept): detected only through the splice
  // that earlier Accept made, never by equal text.
  const item = { kind: 'insert', afterSlideId: 'rubric', section: 'What students told us', text: '## Students asked\n- A policy' }
  const once = applyProposal(drawn, item, { text: null })
  const stamped = once.text.replace('## What students told us\n', '## What students told us\n{id=s1x}\n').replace('### Students asked\n', '### Students asked\n{id=s2x}\n')
  const twice = applyProposal(stamped, item, { text: null, remembered: once.edit })
  assert.equal(twice.ok, true); assert.equal(twice.already, true); assert.equal(twice.text, stamped, 'nothing inserted again')
  assert.equal(undoEdit(stamped, twice.edit).text, drawn, 'its Undo takes out exactly that insert')
  const unlinked = applyProposal(stamped, item, { text: null })
  assert.equal(unlinked.already, undefined, 'equal text alone is not "already": inserted as a normal insert')
  assert.equal(unlinked.text.split('### Students asked').length, 3)
  // The reviewer's probe: a talk a, b, Grid; her insert after b is Grid's own text. It is his slide,
  // not hers: a normal insert, and Undo of it never deletes his Grid.
  const probe = ['---', 'title: P', '---', '', '## A', '{id=a}', '- one', '', '## B', '{id=b}', '- two', '', '## Grid', '{id=grid}', '{cards=grid}', '', '#### Left', '- l', '', '#### Right', '- r', ''].join('\n')
  const gridText = '## Grid\n{cards=grid}\n\n#### Left\n- l\n\n#### Right\n- r'
  const dup = applyProposal(probe, { kind: 'insert', afterSlideId: 'b', text: gridText }, { text: null })
  assert.equal(dup.ok, true); assert.equal(dup.already, undefined)
  assert.equal((await compiled(dup.text)).filter((s) => s.title === 'Grid').length, 2, 'a second Grid, hers')
  assert.equal(undoEdit(dup.text, dup.edit).text, probe, 'Undo takes out hers; his Grid stays')
  // A remembered splice that is not this block (another item's) links nothing.
  const other = applyProposal(probe, { kind: 'insert', afterSlideId: 'b', text: gridText }, { text: null, remembered: spliceEdit('x', 'x\n## Else\n', 1) })
  assert.equal(other.already, undefined)
  // The replace case: the same text again is "already" with an empty splice (no Undo), unless the
  // splice an earlier Accept made is remembered and still there.
  const rep = replace(base.replace('the features a model produces', 'what a model writes'))
  const hersText = base.replace('the features a model produces', 'what a model writes')
  const again = applyProposal(rep.text, { kind: 'replace', slideId: 'rubric', text: hersText }, { text: base })
  assert.equal(again.already, true); assert.equal(again.text, rep.text); assert.equal(isEmptyEdit(again.edit), true)
  const linked = applyProposal(rep.text, { kind: 'replace', slideId: 'rubric', text: hersText }, { text: base, remembered: rep.edit })
  assert.deepEqual(linked.edit, rep.edit)

  // Through the accept module: save refused, he keeps it (saved), Accept again marks it accepted with
  // the edit it made, and Undo puts his text back.
  const PATH = '/vault/t/t-outline.md'
  const state = { buffer: drawn, saveOk: false, statuses: [] }
  const mutator = createOutlineMutator({
    bufferFor: (p) => (p === PATH ? { read: () => state.buffer, apply: (_p, next) => { state.buffer = next; return next }, adopt: () => {} } : null),
    settled: async () => {},
    write: async () => (state.saveOk ? { ok: true } : false),
  })
  const deps = { targetPath: () => PATH, diskChanged: () => false, apply: (p, m) => mutator.apply(p, m), setStatus: async (itemId, status, edit) => { state.statuses.push({ itemId, status, edit }); return { success: true } } }
  const hers = { kind: 'replace', slideId: 'rubric', text: hersText }
  let out = await acceptProposal('p1', hers, { text: base }, deps)
  assert.equal(out.applied, true); assert.deepEqual(state.statuses, [])
  state.saveOk = true // Keep mine: the buffer (with her text) is saved
  const kept = state.buffer
  out = await acceptProposal('p1', hers, { text: base }, deps)
  assert.equal(out.ok, true)
  assert.equal(state.buffer, kept, 'not applied a second time')
  assert.equal(state.statuses[0].status, 'accepted')
  assert.ok(state.statuses[0].edit.inserted.length > 0, 'the edit it made, not an empty one')
  await undoAccepted('p1', state.statuses[0].edit, deps)
  assert.equal(state.buffer, drawn, 'Undo restores his text')
  // The same for an insert: refused save, kept, Accept again: one copy, and Undo takes it out.
  state.saveOk = false
  out = await acceptProposal('i9', item, { text: null }, deps)
  assert.equal(out.applied, true)
  state.saveOk = true
  const keptInsert = state.buffer
  out = await acceptProposal('i9', item, { text: null }, deps)
  assert.equal(out.ok, true); assert.equal(state.buffer, keptInsert, 'one copy')
  await undoAccepted('i9', state.statuses.at(-1).edit, deps)
  assert.equal(state.buffer, drawn)
  // No memory (another item, or after a restart) and text only: a replace that is already what the
  // slide says is accepted with no Undo; nothing is written.
  state.buffer = rep.text
  out = await acceptProposal('p2', hers, { text: base }, deps)
  assert.equal(out.ok, true); assert.equal(state.buffer, rep.text)
  assert.deepEqual(state.statuses.at(-1), { itemId: 'p2', status: 'accepted', edit: ALREADY })
  // The rail: "Already what the slide says", and no Undo.
  const fold = foldFeedback([itemLine({ itemId: 'p2', kind: 'replace', slideId: 'rubric', text: hersText, createdAt: 1, seq: 1, status: 'new' }, 1), statusLine('p2', 'accepted', 2, ALREADY)].join('\n'))
  assert.deepEqual([fold.items[0].acceptedAlready, fold.items[0].acceptedEdit], [true, null])
  const view = feedbackRailView({ list: { key: 'k', shareId: 'k7m2abcd', link: 'x', connection: 'connected', items: fold.items.map((i) => ({ ...i, baseText: base, baseTitle: null })) }, slides: [{ slideId: 'rubric', title: 'The rubric problem', line: 16 }], outline: rep.text, filter: 'all', activeSlideId: null, now: 3 })
  assert.match(view.rows[0].stamp.text, / · Already what the slide says$/)
  assert.equal(view.rows[0].undo, false)
  assert.equal(parseAcceptRecord(ALREADY), ALREADY); assert.equal(parseAcceptRecord('other'), null)
}
console.log('PASS fix round: folded = not compiled on the sampler fixture; a container deletes with its children and inserts go after them; a section heading is not deleted (the rail says so); open comments and fences refused; no restructuring replace; an accept applied twice is detected only through its remembered splice (equal text inserts normally; his Grid is never taken by Undo); a text-only already replace is accepted with no Undo')
