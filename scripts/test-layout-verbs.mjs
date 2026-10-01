// Layout content verbs (ADR-0032; ticket 02): pure functions over outline text.
import { strict as assert } from 'node:assert'
import {
  canTakeLayout, LayoutVerbError, previewLayout, setLayout, setLayoutOption, suggestLayouts
} from '../src/shared/layout-verbs.ts'
import { LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import { deckCommitContext } from '../src/shared/deck-frame.ts'
import { logicalTriggerBlockAfterHeading } from '../src/shared/trigger-line.ts'
import { commitLayoutSelection, selectionFromTriggerLine, toggleLayoutSelection } from '../src/shared/layout-selection.ts'
import { planEditorTriggerCommit } from '../src/renderer/src/extensions/inlineTriggerCommitModel.ts'

const codex = `---
title: Intern to Toolmaker
---

# Intern to Toolmaker

## Five Things You Can Do With Codex

{id=gfks3}

### Five things you can do with Codex
{icons}{id=vi9k8}

- Catalogue and organise data
- Manage projects and keep notes
- Create tools, websites, and dissemination outputs
- Run experiments and keep records and notes
- Set up and control your computer

### What Codex cannot do yet
{id=v-empty}

`
const names = (list) => list.map((s) => s.layout)

// What the editor's ↵ writes: `commitLayoutSelection` from the canonical merged `block.line`, written
// through `planEditorTriggerCommit` (Editor.tsx applyLayout). The verbs must match it byte for byte.
function editorEnter(doc, headingLine, layout) {
  const lines = doc.split('\n')
  const block = logicalTriggerBlockAfterHeading(lines, headingLine - 1)
  const original = block?.line ?? ''
  const needsMerge = Boolean(block && (block.end > block.start + 1 || lines[block.start] !== block.line))
  const entry = LAYOUTS.find((candidate) => candidate.name === layout)
  const initial = selectionFromTriggerLine(original, [...LAYOUTS])
  const next = commitLayoutSelection(original, initial, toggleLayoutSelection(initial, entry), undefined, deckCommitContext(doc, headingLine))
  if (!next || (next === original && !needsMerge)) return doc
  const plan = planEditorTriggerCommit(doc, headingLine, () => next)
  return [...plan.changes].sort((a, b) => b.from - a.from).reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), doc)
}

// preview-layout never writes: the input is a string, the result differs, the input is intact.
const before = codex
const previewed = previewLayout(codex, 'vi9k8', 'cards')
assert.equal(codex, before)
assert.notEqual(previewed, codex)
assert(previewed.includes('{icons}{id=vi9k8} {cards}'))
// Only the Trigger line changes.
assert.equal(previewed.split('\n').filter((l, i) => l !== codex.split('\n')[i]).length, 1)

// set-layout equals what ↵ writes, and equals what a preview shows.
const set = setLayout(codex, 'vi9k8', 'cards')
assert.equal(set.triggerLine, '{icons}{id=vi9k8} {cards}')
assert.equal(set.outline, previewed)
// A heading-line address works too, and setting twice changes nothing more.
const byLine = setLayout(codex, { headingLine: 11 }, 'cards')
assert.equal(byLine.outline, set.outline)
// Setting the same layout again writes what the editor's ↵ writes for it (byte parity, below), and a
// third time changes nothing.
const again = setLayout(set.outline, 'vi9k8', 'cards')
assert.equal(again.outline, editorEnter(set.outline, 11, 'cards'))
assert.equal(setLayout(again.outline, 'vi9k8', 'cards').outline, again.outline)
// Switching layout replaces the layout token and keeps {id}.
// (From the canonical merged line, as the editor's ↵ reads it, so the space before {cards} goes.)
assert.equal(setLayout(set.outline, 'vi9k8', 'timeline').triggerLine, '{icons}{id=vi9k8}{timeline}')
assert.equal(setLayout(set.outline, 'vi9k8', 'timeline').outline, editorEnter(set.outline, 11, 'timeline'))
// A modifier is set, not toggled.
const numbered = setLayout(codex, 'vi9k8', 'numbered')
const numberedAgain = setLayout(numbered.outline, 'vi9k8', 'numbered')
assert(numberedAgain.triggerLine.includes('{numbered}'), 'setting a modifier that is on keeps it (↵ would toggle it off: reported)')
assert.equal(setLayout(numberedAgain.outline, 'vi9k8', 'numbered').outline, numberedAgain.outline)
// A slide with no Trigger line gets one straight under the heading.
const bare = '### Plain\n\n- one\n- two\n'
assert.equal(setLayout(bare, { headingLine: 1 }, 'cards').outline, '### Plain\n{cards}\n\n- one\n- two\n')
// CRLF outlines keep their endings on the rewritten line.
const crlf = codex.replace(/\n/g, '\r\n')
assert(setLayout(crlf, 'vi9k8', 'cards').outline.includes('{icons}{id=vi9k8} {cards}\r\n'))

// ── Fix round after the adversarial review ──────────────────────────────────────────────────────
{
  const list = (trigger) => `---\ntitle: T\n---\n\n### S\n${trigger}\n\n- one\n- two\n- three\n`
  const isCode = (code) => (error) => error instanceof LayoutVerbError && error.code === code

  // 1. An option token never writes anything outside its own `{…}`: no new line, no new heading, no
  //    second group. Refused at the verb boundary with a typed error, for every verb that takes options.
  const icons = list('{icons}{id=a1}')
  for (const bad of ['reactions=a\n## Injected', 'reactions=a\r\n## Injected', 'reactions=a}{cards', 'reactions={x}', 'reactions=a b']) {
    assert.throws(() => setLayoutOption(icons, 'a1', 'reactions', bad), isCode('bad-option-token'), JSON.stringify(bad))
    assert.throws(() => setLayout(icons, 'a1', 'cards', [{ group: 'reactions', token: bad }]), isCode('bad-option-token'), JSON.stringify(bad))
    assert.throws(() => previewLayout(icons, 'a1', 'cards', [{ group: 'reactions', token: bad }]), isCode('bad-option-token'), JSON.stringify(bad))
  }
  assert.throws(() => setLayoutOption(icons, 'a1', 'number-style', 'number-style=zz'), isCode('bad-option-token'))
  assert.throws(() => previewLayout(icons, 'a1', 'cards', [{ group: 'form', token: 42 }]), isCode('bad-option-token'))
  assert.throws(() => previewLayout(icons, 'a1', 'cards', 'form'), isCode('bad-option-token'))
  assert.throws(() => setLayout(icons, 'a1', 'cards\n## X'), isCode('unknown-layout'))
  assert.equal(canTakeLayout(icons, 'a1', 'cards\n## X').ok, false)
  assert(!canTakeLayout(icons, 'a1', 'cards\n## X').reason.includes('\n'))
  // A well-formed reactions value still writes, on the one Trigger line.
  const reacted = setLayoutOption(icons, 'a1', 'reactions', 'reactions="Too fast","Just right"')
  assert.equal(reacted.outline.split('\n').length, icons.split('\n').length)
  assert(reacted.triggerLine.includes('{reactions="Too fast","Just right"}'))

  // 2. An option group that does not apply to the slide's layout is refused (a Cards form on an Icons
  //    slide would write a second layout token).
  assert.throws(() => setLayoutOption(icons, 'a1', 'form', 'cards=grid'), isCode('option-not-applicable'))
  assert.throws(() => previewLayout(icons, 'a1', 'timeline', [{ group: 'form', token: 'cards=grid' }]), isCode('option-not-applicable'))
  assert.throws(() => setLayoutOption(icons, 'a1', 'no-such-group', 'x'), isCode('unknown-option-group'))
  assert.throws(() => setLayout(icons, 'a1', 'grid-zoom'), isCode('cannot-take'))

  // 3. Byte parity with the editor's ↵, non-canonical Trigger lines included; preview equals set.
  for (const trigger of ['{icons}{id=a1}', '{icons} {id=a1}', '{icons id=a1}', '{id=a1}', '  {icons}{id=a1}  ', '{icons}\n{id=a1}']) {
    const doc = list(trigger)
    for (const layout of ['cards', 'timeline', 'numbered', 'grid']) {
      const expected = editorEnter(doc, 5, layout)
      const written = setLayout(doc, { headingLine: 5 }, layout).outline
      assert.equal(written, expected, `${JSON.stringify(trigger)} + ${layout}`)
      assert.equal(previewLayout(doc, { headingLine: 5 }, layout), written, `preview = set for ${JSON.stringify(trigger)} + ${layout}`)
    }
  }
  assert.equal(setLayout(codex, 'vi9k8', 'cards').outline, editorEnter(codex, 11, 'cards'))

  // 9. CRLF: the starter text keeps the file's line endings.
  const crlfEmpty = codex.replace(/\n/g, '\r\n')
  const startedCrlf = setLayout(crlfEmpty, 'v-empty', 'cards', [], true).outline
  assert(!/[^\r]\n/.test(startedCrlf), 'every line ends CRLF')
  assert(startedCrlf.includes('{id=v-empty} {cards}\r\n\r\n- Oracle\r\n'))

  // 10. Suggestions: a blockquote alone is a quotation; counts are not years.
  const slide10 = (body) => `### S\n{id=s1}\n\n${body}\n`
  assert.equal(names(suggestLayouts(slide10('> Capability is not judgement.'), 's1'))[0], 'quote')
  assert.equal(names(suggestLayouts(slide10('> Capability is not judgement,\n> and never was.'), 's1'))[0], 'quote')
  const counts = names(suggestLayouts(slide10('- 1500 students\n- 2000 staff\n- 1800 visitors'), 's1'))
  assert.notEqual(counts[0], 'timeline')
  assert(!counts.includes('timeline'))
  assert.equal(names(suggestLayouts(slide10('- 1969 Moon landing\n- 1972 Last crew\n- 2019 Fifty years'), 's1'))[0], 'timeline')
  assert.equal(names(suggestLayouts(slide10('- 2022: launch\n- 2026: agents'), 's1'))[0], 'timeline')
  // 4. Layering: nothing in src/shared or src/main imports from the renderer.
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx|mts|mjs)$/.test(name) ? [path] : []
  })
  const { fileURLToPath } = await import('node:url')
  const srcRoot = fileURLToPath(new URL('../src/', import.meta.url))
  const offenders = [...walk(join(srcRoot, 'shared')), ...walk(join(srcRoot, 'main'))].filter((file) =>
    /(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"][^'"]*\/renderer\//.test(readFileSync(file, 'utf8')))
  assert.deepEqual(offenders, [], 'src/shared and src/main never import from src/renderer')
  console.log('ok: fix round (tokens, applicability, ↵ parity, CRLF starter text, suggestions, layering)')
}

// preview with options, and set-layout-option.
const boxed = setLayoutOption(codex, 'vi9k8', 'iconlist-variant', 'iconlist=boxes')
assert.equal(boxed.triggerLine, '{icons}{id=vi9k8} {iconlist=boxes}')
assert.equal(previewLayout(codex, 'vi9k8', 'cards', [{ group: 'form', token: 'cards=grid' }]).includes('{cards=grid}'), true)
assert.throws(() => setLayoutOption(codex, 'vi9k8', 'no-such-group', 'x'), /no option group/)

// A layout the slide cannot take is refused by the writers, with the reason.
assert.throws(() => setLayout(codex, 'vi9k8', 'grid-zoom'), /Needs a ## section heading/)
assert.throws(() => previewLayout(codex, 'nope', 'cards'), /slide not found/)
assert.throws(() => previewLayout(codex, 'vi9k8', 'no-such-layout'), /unknown layout/)

// can-take-layout: yes, or a one-line reason.
assert.deepEqual(canTakeLayout(codex, 'vi9k8', 'cards'), { ok: true })
assert.deepEqual(canTakeLayout(codex, 'vi9k8', 'grid-zoom'), { ok: false, reason: 'Needs a ## section heading' })
assert.deepEqual(canTakeLayout(codex, 'gfks3', 'grid-zoom'), { ok: true })
for (const [layout, reason] of [
  ['quote', 'Needs a quotation written as a paragraph'],
  ['annotated', 'Needs a sub-point under each item'],
  ['media', 'Needs an image, a video or a link'],
  ['compare', 'Needs two halves as #### headings'],
  ['columns', 'Needs #### group headings'],
  ['copy-visual', 'Needs an image'],
  ['conceptmap', 'Needs links written as A -> B'],
  ['stats', 'Needs points that start with a number'],
  ['trace', 'Needs lines written as Speaker: words'],
  ['barchart', 'Needs values written as label: number'],
  ['timetable', 'Needs times, written as 09:00 Welcome'],
  ['accent', 'Needs a ## section heading']
]) assert.deepEqual(canTakeLayout(codex, 'vi9k8', layout), { ok: false, reason }, layout)
assert.equal(canTakeLayout(codex, 'vi9k8', 'no-such').ok, false)
// A slide with no body takes anything (starter text supplies the content), except section-only entries.
assert.deepEqual(canTakeLayout(codex, 'v-empty', 'stats'), { ok: true })
assert.equal(canTakeLayout(codex, 'v-empty', 'grid-zoom').ok, false)
// Content that does satisfy the needs.
const rich = `### Rich\n{id=r1}\n\n![a](x.png)\n\n> "Capability is not judgement"\n\n- A: 60\n- B: 40\n`
assert.equal(canTakeLayout(rich, 'r1', 'copy-visual').ok, true)
assert.equal(canTakeLayout(rich, 'r1', 'image-quote').ok, true)
assert.equal(canTakeLayout(rich, 'r1', 'barchart').ok, true)

// with starter text: only a slide with no body gets it.
const started = setLayout(codex, 'v-empty', 'cards', [], true)
assert.equal(started.triggerLine, '{id=v-empty} {cards}')
assert(started.outline.includes('{id=v-empty} {cards}\n\n- Oracle\n- Tool maker\n- Tool user'))
assert.equal(setLayout(codex, 'vi9k8', 'cards', [], true).outline, set.outline, 'a slide with a body keeps its text')

// suggest-layouts: the mockup's five, in order, for the Codex slide.
assert.deepEqual(names(suggestLayouts(codex, 'vi9k8')), ['cards', 'iconrow', 'numbered', 'grid', 'process'])
assert(suggestLayouts(codex, 'vi9k8').every((s) => s.why.length > 0 && !s.why.includes('\n')))
// A heading-only slide gets none.
assert.deepEqual(suggestLayouts(codex, 'v-empty'), [])
// The slide's own layout is left out.
assert(!names(suggestLayouts(set.outline, 'vi9k8')).includes('cards'))

const slide = (body, trigger = '{id=s1}') => `### S\n${trigger}\n\n${body}\n`
const suggest = (body, trigger) => names(suggestLayouts(slide(body, trigger), 's1'))
// Not short, no verbs: no process; long points are not "short" so the few-points branch drops out.
assert.deepEqual(suggest('- The first point is quite a bit longer than ten words in total, honestly\n- Second\n- Third'), [])
// 7+ points.
assert.deepEqual(suggest('- a\n- b\n- c\n- d\n- e\n- f\n- g'), ['2col', 'grid'])
// Years.
assert(suggest('- 2022\n  - Launch\n- 2026\n  - Agents').includes('timeline'))
assert(suggest('- 2022\n  - Launch\n- 2026\n  - Agents').includes('mindmap'))
assert(!suggest('- 2022\n  - Launch\n- 2026\n  - Agents').includes('columns'), 'columns cannot take a slide with no #### groups')
assert.equal(suggest('- 09:00 Welcome\n- 10:30 Break\n- 11:00 Workshop')[0], 'timetable')
// number: label, label: number, pie when the numbers add to 100.
assert.equal(suggest('- 40%: of students\n- 5 days: to a million')[0], 'stats')
assert.deepEqual(suggest('- Yes: 60\n- No: 40').slice(0, 2), ['piechart', 'barchart'])
assert(!suggest('- Yes: 60\n- No: 30').includes('piechart'))
// Paragraphs, quotes, pictures, speakers.
assert.deepEqual(suggest('One sentence the room should remember.'), ['statement'])
assert.deepEqual(suggest('"Capability is not judgement."'), ['quote'])
assert.deepEqual(suggest('![a](x.png)'), ['media', 'image-grid'])
assert.deepEqual(suggest('![a](x.png)\n\n- One\n- Two'), ['list-visual', 'image-claim'])
assert.deepEqual(suggest('![a](x.png)\n\n> Words\n\n- Source'), ['image-quote'])
assert.equal(suggest('- User: What is a layout?\n- Agent: A named slide geometry.\n- User: And a modifier?')[0], 'trace')
// Ties break by how often this talk already uses the layout: with seven points that each carry a
// sub-point, Grid (7+ branch) and Icon row (sub-point branch) both score 90.
const seven = Array.from({ length: 7 }, (_, i) => `- p${i}\n  - s${i}`).join('\n')
const target = `### T\n{id=t1}\n\n${seven}\n`
const tied = names(suggestLayouts(target, 't1'))
assert(tied.indexOf('grid') < tied.indexOf('iconrow'), 'no usage: rule order')
const usesIconrow = `${target}\n### U1\n{id=u1}{iconrow}\n\n- a\n- b\n- c\n\n### U2\n{id=u2}{iconrow}\n\n- a\n- b\n- c\n`
const tiedByUse = names(suggestLayouts(usesIconrow, 't1'))
assert(tiedByUse.indexOf('iconrow') < tiedByUse.indexOf('grid'), 'the layout the talk already uses wins the tie')
// Never more than six.
assert(suggestLayouts(codex, 'vi9k8').length <= 6)

console.log('layout verbs: all checks passed')

// Picker support (ticket 03): every layout's verdict at once, and the talk's own layouts.
{
  const { canTakeAllLayouts, recentLayouts } = await import('../src/shared/layout-verbs.ts')
  const all = canTakeAllLayouts(codex, 'vi9k8')
  assert.equal(all.get('cards').ok, true, 'canTakeAllLayouts: cards takes a list slide')
  assert.deepEqual(all.get('grid-zoom'), canTakeLayout(codex, 'vi9k8', 'grid-zoom'), 'canTakeAllLayouts agrees with canTakeLayout')
  assert.ok(recentLayouts(codex).every((name) => typeof name === 'string'), 'recentLayouts lists layout names')
  console.log('ok: canTakeAllLayouts and recentLayouts')
}

// Second review of the fix round (2026-09-30).
{
  const isCode = (code) => (error) => error instanceof LayoutVerbError && error.code === code
  // 3. A Trigger block with two ids: the slide's id is the LAST (the shared resolver, slide-id.mjs; the
  //    ruling of 30 Sep), the one readOutlineSlides reads and the ledger keys history to. The verbs keep
  //    it, never rename the slide, and say what they set aside.
  const twoIds = '---\ntitle: T\n---\n\n### S\n{id=a1}\n{id=a2}\n'
  assert.throws(() => setLayout(twoIds, 'a1', 'cards'), isCode('slide-not-found'), 'the set-aside id no longer names the slide')
  const set = setLayout(twoIds, 'a2', 'cards')
  assert.equal(set.triggerLine, '{id=a2} {cards}', 'the slide keeps its resolved id')
  assert(!set.outline.includes('a1'), 'the first id is merged away, not the last')
  assert.deepEqual(set.warnings, ['duplicate-slide-id-merged:kept a2, dropped a1 (S)'], 'the merge is reported, not discarded')
  const started = setLayout(twoIds, 'a2', 'cards', [], true)
  assert(started.outline.includes('{id=a2} {cards}\n\n- '), 'starter text lands under the kept id (no slide-not-found)')
  assert.equal(setLayout(set.outline, 'a2', 'cards').triggerLine.includes('{id=a2}'), true, 'the written slide is still found by its id')
  const cardsTwoIds = '### S\n{cards}{id=a1}\n{id=a2}\n\n- one\n- two\n- three\n'
  const option = setLayoutOption(cardsTwoIds, 'a2', 'form', 'cards=rows')
  assert(option.triggerLine.includes('{id=a2}') && !option.triggerLine.includes('a1'))
  assert.deepEqual(option.warnings, ['duplicate-slide-id-merged:kept a2, dropped a1 (S)'])
  assert(previewLayout(twoIds, 'a2', 'cards').includes('{id=a2} {cards}'), 'a try shows what ↵ writes')
  assert.deepEqual(setLayout('### S\n{id=a1}\n\n- x\n', 'a1', 'cards').warnings, [], 'nothing repaired, nothing reported')

  // 4. A chronology of bare years is a Timeline; counts are not.
  const slide = (body) => `### S\n{id=s1}\n\n${body}\n`
  const top = (body) => suggestLayouts(slide(body), 's1').map((s) => s.layout)
  assert.equal(top('- 1969 moon landing\n- 1989 fall of the Berlin Wall')[0], 'timeline')
  assert.equal(top('- 2019 fifty years on\n- 1969 moon landing')[0], 'timeline', 'a chronology read backwards')
  assert(!top('- 1500 students').includes('timeline'), 'one count is not a year')
  assert(!top('- 1500 students\n- 1600 staff').includes('timeline'), 'counts in order are still counts')
  assert(!top('- 1969 apples\n- 1969 pears').includes('timeline'), 'the same number twice is no chronology')
  // Fix round 4: units and measurements are not years, spaced or written on.
  assert(!top('- 1500 grams\n- 2000 grams').includes('timeline'), 'weights in order are not a chronology')
  assert(!top('- 1500g of flour\n- 2000g of sugar').includes('timeline'), 'a unit written on the number is not a year')
  assert(!top('- 1500 kg\n- 1800 kg\n- 2000 kg').includes('timeline'))
  assert(!top('- 1600 ml water\n- 1900 ml milk').includes('timeline'))
  assert.equal(top('- 1969 moon landing\n- 1989 fall of the Berlin Wall\n- 2001 first Wikipedia edit')[0], 'timeline', 'years stay a Timeline')
  assert.equal(top('- 1960s space race\n- 1980s home computers')[0], 'timeline', 'decades stay a Timeline')

  // 7. A token never carries a line separator or an open quote.
  const icons = '### S\n{icons}{id=a1}\n\n- one\n- two\n- three\n'
  for (const bad of ['reactions=a\u0085## X', 'reactions=a\u2028## X', 'reactions=a\u2029## X', 'reactions=a\u000B## X', 'reactions=a\u000C## X', 'reactions="Too fast', 'reactions="a","b']) {
    assert.throws(() => setLayoutOption(icons, 'a1', 'reactions', bad), isCode('bad-option-token'), JSON.stringify(bad))
    assert.throws(() => previewLayout(icons, 'a1', 'cards', [{ group: 'reactions', token: bad }]), isCode('bad-option-token'), JSON.stringify(bad))
  }
  assert(setLayoutOption(icons, 'a1', 'reactions', 'reactions="Too fast","Just right"').triggerLine.includes('"Just right"'))
  console.log('ok: second review (kept id and warnings, chronologies, line separators and quotes)')
}

// Fix round 4 (2026-09-30): the picker's ↵ reports what the merge set aside where the editor's ↵ does,
// and shows a refusal in the verb's own words.
{
  const { reportTriggerMergeWarnings } = await import('../src/shared/trigger-line.ts')
  const { readFileSync } = await import('node:fs')
  const heard = []
  const write = setLayout('### S\n{id=a1}\n{id=a2}\n', 'a2', 'cards')
  reportTriggerMergeWarnings(write.warnings, (message) => heard.push(message))
  assert.deepEqual(heard, ['[trigger-merge] A slide carried several ids: kept a2, dropped a1 (S). The kept id is the one the slide’s history and recordings use; delete the other {id=…} if it is still there.'])
  const workspace = readFileSync(new URL('../src/renderer/src/components/WorkspaceLayout.tsx', import.meta.url), 'utf8')
  const keep = workspace.slice(workspace.indexOf('function keepPickedLayout('), workspace.indexOf('const pickerSlide = useMemo('))
  assert(/const write = setLayout\(/.test(keep) && keep.includes('reportTriggerMergeWarnings(write.warnings)'), 'the picker\'s ↵ reports the merge warnings, not only .outline')
  assert(keep.includes('error instanceof LayoutVerbError ? error.detail'), 'a refusal is shown in LayoutVerbError.detail')
  assert(!keep.includes('.replace(/^[\\w-]+: /'), 'no prefix-stripping of the message')
  const editor = readFileSync(new URL('../src/renderer/src/components/Editor.tsx', import.meta.url), 'utf8')
  assert(!/console\.warn\(warning\)/.test(editor) && editor.includes('reportTriggerMergeWarnings(plan.warnings)'), 'the editor\'s ↵ reports through the same function')
  console.log('ok: merge warnings from the picker reach the editor\'s warning surface')
}

// Fix round 5 (probe R5-A, 2026-09-30): a chart token that owns the list below it is a content object,
// not part of the Trigger block — the compiler tree ends the block there (chartObjectTokenAt), and every
// editor merge must too. Before the fix the pie block was folded into the Trigger line and lost.
{
  const { GLOBAL_OPTION_GROUPS } = await import('../src/shared/layout-registry/entries.ts')
  const { applyInspectorOptionToOutline } = await import('../src/renderer/src/components/inspectorModel.ts')
  const pie = '### T\n{id=x}{chart=bar}\n{piechart}\n- A: 1\n- B: 2\n'
  const kept = '\n{piechart}\n- A: 1\n- B: 2\n'
  const block = logicalTriggerBlockAfterHeading(pie.split('\n'), 0)
  assert.equal(block.end, 2, 'the Trigger block ends before the chart token that owns the list')
  const set = setLayout(pie, 'x', 'statement')
  assert.equal(set.outline, `### T\n${set.triggerLine}${kept}`, 'set-layout keeps the pie block below the Trigger line')
  assert(!set.triggerLine.includes('piechart'))
  assert(previewLayout(pie, 'x', 'statement').endsWith(kept), 'a try keeps the pie block')
  const option = setLayoutOption(pie, 'x', 'reactions', 'reactions=off')
  assert(option.outline.endsWith(kept) && !option.triggerLine.includes('piechart'), 'an option verb keeps the pie block')
  const entered = editorEnter(pie, 1, 'statement')
  assert(entered.endsWith(kept), 'the editor\'s ↵ keeps the pie block')
  assert.equal(entered, set.outline, 'the verb and ↵ still write the same bytes')
  const reactions = GLOBAL_OPTION_GROUPS.find((group) => group.key === 'reactions')
  const inspected = applyInspectorOptionToOutline(pie, 1, reactions, 'reactions=off')
  assert.equal(inspected, `### T\n{id=x}{chart=bar} {reactions=off}${kept}`, 'an Inspector option keeps the pie block')
  // A chart token with no list below it is still a Trigger line.
  assert.equal(logicalTriggerBlockAfterHeading('### T\n{id=x}\n{piechart}\n\nBody'.split('\n'), 0).end, 3)
  console.log('ok: a chart token that owns its list ends the Trigger block in every editor merge')
}

// 0.37 preview.4: on a Cards slide, ⌘L's Icon list and Numbered list pictures came out identical
// ({cards}{numbered} drew cards with no numbers). The list styles now take the slide to List.
{
  const { prepareSource } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
  const { statSync, writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cardsSlide = '---\ntitle: T\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n## S\n\n### Three things\n{id=ab1}{cards}\n\n- Speed matters\n- Judgement counts\n- Craft wins\n'
  const dir = mkdtempSync(join(tmpdir(), 'tw-list-style-pic-'))
  const slideHtml = async (outline) => {
    const path = join(dir, 'o.md'); writeFileSync(path, outline)
    const html = (await prepareSource(path, outline, 'o', statSync(path))).fullHtml
    const at = html.indexOf('data-id="ab1"')
    return html.slice(at, html.indexOf('</section>', at))
  }
  const icon = previewLayout(cardsSlide, 'ab1', 'iconlist')
  const numbered = previewLayout(cardsSlide, 'ab1', 'numbered')
  assert(/\{list\}/.test(icon) && !/\{cards\}/.test(icon), 'Icon list on a Cards slide swaps Cards for List')
  assert(/\{list\}/.test(numbered) && !/\{cards\}/.test(numbered), 'Numbered list on a Cards slide swaps Cards for List')
  const iconHtml = await slideHtml(icon)
  const numberedHtml = await slideHtml(numbered)
  assert(/fl-svg/.test(iconHtml) && !/fl-num/.test(iconHtml), 'the Icon list picture shows an icon per item, no numbers')
  assert(/fl-numbered/.test(numberedHtml) && (numberedHtml.match(/fl-num">/g) ?? []).length === 3 && !/fl-svg/.test(numberedHtml), 'the Numbered list picture shows 1, 2, 3 in the icon box')
  // A slide already a list keeps its List token; a repeat is idempotent.
  const listSlide = cardsSlide.replace('{cards}', '{list}')
  const squash = (text) => text.replace(/ /g, '')
  assert.equal(squash(previewLayout(listSlide, 'ab1', 'numbered')), squash(previewLayout(previewLayout(listSlide, 'ab1', 'numbered'), 'ab1', 'numbered')))
  console.log('ok: Icon list and Numbered list differ on a Cards slide (the list styles take it to List)')
}
