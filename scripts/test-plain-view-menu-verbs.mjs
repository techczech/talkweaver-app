// test:plain-view-menu-verbs — the Plain margin menus' pure halves (spec T8, T9).
//   - levelMenuFor: which levels a heading's menu offers, which is current;
//   - setHeadingKind: Section `##`, Slide `###` (or one under a deeper section), Talk title `#`,
//     subtree keeping relative depths, hidden layout lines untouched, no-op returns the text;
//   - clearLayout: removes the layout token or list style, keeps {id=…} and options, drops an empty line.
import { strict as assert } from 'node:assert'
import { levelMenuFor, setHeadingKind } from '../src/shared/heading-kind.ts'
import { chooseLayout, clearLayout, setLayout } from '../src/shared/layout-verbs.ts'

const kinds = (items) => items.map((i) => i.kind + (i.current ? '*' : '')).join(',')

// ── levelMenuFor ────────────────────────────────────────────────────────────────────────────
const talk = `# Talk\n\n## Part\n\n### A\n{cards}{id=a1}\n- x\n\n### B\n`
assert.equal(kinds(levelMenuFor(talk, 1)), 'talk*,section,slide', 'the # line: Talk title current')
assert.equal(kinds(levelMenuFor(talk, 3)), 'section*,slide', 'a ## heading when a # line exists: no Talk title')
assert.equal(kinds(levelMenuFor(talk, 5)), 'section,slide*', 'a ### heading is a slide')
assert.equal(kinds(levelMenuFor('## Part\n\n### A\n', 3)), 'talk,section,slide*', 'no # line: Talk title offered')
assert.deepEqual(levelMenuFor(talk, 2), [], 'a blank line has no menu')
assert.equal(kinds(levelMenuFor('---\ntitle: x\n---\n\n```\n# not a heading\n```\n\n## P\n', 9)), 'talk,section*,slide', '# in fence and frontmatter does not count')
const notes = levelMenuFor(talk, 5)
assert.deepEqual(notes.map((n) => n.note), ["The talk's name, shown on the first slide", 'A divider between groups of slides', 'One slide'].slice(1))
assert.equal(levelMenuFor(talk, 1)[0].note, "The talk's name, shown on the first slide")

// ── setHeadingKind ──────────────────────────────────────────────────────────────────────────
const doc = `# Talk\n\n## Part one\n\n### A\n{iconlist}{id=a1}\n- one\n\n### B\n\n#### B child\n\n## Part two\n\n### C\n`
// Slide → Section: the heading and its subtree move up one level; hidden line and tokens untouched.
assert.equal(setHeadingKind(doc, 5, 'section'), doc.replace('### A\n', '## A\n'))
// Section with a subtree → Slide: the whole subtree moves down by one.
assert.equal(
  setHeadingKind(doc, 3, 'slide'),
  doc.replace('## Part one', '### Part one').replace('### A', '#### A').replace('### B\n', '#### B\n').replace('#### B child', '##### B child')
)
// Section → Slide when it has no section above: `###`.
assert.equal(setHeadingKind('## P\n\ntext\n', 1, 'slide'), '### P\n\ntext\n')
// No-op choices return the same text.
assert.equal(setHeadingKind(doc, 5, 'slide'), doc)
assert.equal(setHeadingKind(doc, 3, 'section'), doc)
assert.equal(setHeadingKind(doc, 1, 'talk'), doc)
// Talk title: `#`; the subtree follows.
assert.equal(setHeadingKind('## P\n### A\n', 1, 'talk'), '# P\n## A\n')
// A slide in a `###` section is one deeper than that section.
const deep = `## S\n\n### Sub\n\n#### one\n\n## Top\n\n### mid\n\n### later\n\n#### nested\n\n## T\n`
assert.equal(setHeadingKind(deep, 3, 'slide'), deep, 'Sub under ## is already ###')
const deeper = `## S\n\n### Sub\n\n#### one\n\n#### two\n`
assert.equal(setHeadingKind(deeper.replace('#### two', '## two'), 7, 'slide'), deeper.replace('#### two', '### two'), 'a ## after a ### section is outside it: ###')
const inSub = `## S\n\n### Sub\n\n#### one\n\n##### cand\n`
assert.equal(setHeadingKind(inSub, 7, 'slide'), inSub.replace('##### cand', '#### cand').replace('#### cand', '##### cand'), 'the nearest heading above (####) is its parent: ##### stays')
const sibling = `## S\n\n### Sub\n\n#### one\n\n## two\n`
assert.equal(setHeadingKind(sibling, 7, 'slide'), sibling.replace('## two', '### two'), 'a ## outside the ### section becomes ###')
assert.equal(setHeadingKind('## S\n\n### Sub\n\n###### y\n', 5, 'slide'), '## S\n\n### Sub\n\n#### y\n', 'a slide directly under a ### section is ####')
assert.equal(setHeadingKind('## S\n\n### Sub\n\n## y\n', 5, 'slide'), '## S\n\n### Sub\n\n### y\n', 'a ## sibling of S is not under Sub')
// Clamped to the depths the app allows: the subtree stops at six, relative depths kept.
const low = '## P\n### A\n#### B\n##### C\n###### D\n'
assert.equal(setHeadingKind('## P\n### A\n#### B\n##### C\n', 1, 'slide'), '### P\n#### A\n##### B\n###### C\n', 'one level down, relative depths kept')
assert.equal(setHeadingKind(low, 1, 'slide'), low, 'a subtree already at six cannot move down')
// Headings in code fences are not touched.
assert.equal(setHeadingKind('## P\n```\n## code\n```\n', 1, 'talk'), '# P\n```\n## code\n```\n')
// CRLF kept.
assert.equal(setHeadingKind('## P\r\n{cards}\r\n', 1, 'slide'), '### P\r\n{cards}\r\n')

// ── clearLayout ─────────────────────────────────────────────────────────────────────────────
const sl = (trigger, extra = '') => `# T\n\n## S\n\n### Slide\n${trigger}${extra}\n- a\n- b\n- c\n`
const at = { headingLine: 5 }
let r = clearLayout(sl('{cards}{id=a1}'), at)
assert.equal(r.outline, sl('{id=a1}'), 'layout token removed, id kept')
assert.equal(r.triggerLine, '{id=a1}')
r = clearLayout(sl('{cards}'), at)
assert.equal(r.outline, '# T\n\n## S\n\n### Slide\n- a\n- b\n- c\n', 'nothing left: the line goes')
assert.equal(r.triggerLine, '')
r = clearLayout(sl('{iconlist}{id=a1}'), at)
assert.equal(r.outline, sl('{id=a1}'), '{iconlist} cleared')
r = clearLayout(sl('{id=a1}'), at)
assert.equal(r.outline, sl('{id=a1}'), 'no layout written: unchanged')
r = clearLayout('# T\n\n## S\n\n### Slide\n- a\n', at)
assert.equal(r.outline, '# T\n\n## S\n\n### Slide\n- a\n', 'no trigger line: unchanged')
r = clearLayout(sl('{id=a1}{numbered}'), at)
assert.equal(r.outline, sl('{id=a1}'), '{numbered} after the id')
r = clearLayout(sl('{list}{iconlist}{id=a1}'), at)
assert.equal(r.outline, sl('{id=a1}'), 'list plus list style both go')
// An option token on the line stays when the layout goes.
r = clearLayout(sl('{cards}{id=a1}{contrast=rows}'), at)
assert.ok(r.outline.includes('{id=a1}') && !r.outline.includes('{cards}'), r.outline)
// Round trip with setLayout: set then clear returns the original.
const base = sl('{id=a1}')
assert.equal(clearLayout(setLayout(base, at, 'cards').outline, at).outline, base, 'setLayout then clearLayout is a round trip')
assert.equal(clearLayout(setLayout(base, at, 'iconlist').outline, at).outline, base, 'icon list round trip')
// ── chooseLayout: one layout at a time ──────────────────────────────────────────────────────
r = chooseLayout(sl('{iconlist}{id=a1}'), at, 'cards')
assert.ok(r.outline.includes('{cards}') && r.outline.includes('{id=a1}') && !r.outline.includes('{iconlist}'), 'Cards replaces Icon list: ' + r.outline)
r = chooseLayout(sl('{numbered}{id=a1}'), at, 'iconlist')
assert.ok(r.outline.includes('{iconlist}') && !r.outline.includes('{numbered}') && r.outline.includes('{id=a1}'), 'Icon list replaces Numbered list: ' + r.outline)
r = chooseLayout(sl('{iconlist}{id=a1}'), at, 'list')
assert.ok(!r.outline.includes('{iconlist}') && r.outline.includes('{list}'), 'List replaces Icon list: ' + r.outline)
r = chooseLayout(sl('{iconlist}{id=a1}'), at, 'iconlist')
assert.equal(r.outline, sl('{iconlist}{id=a1}'), 'choosing the current list style changes nothing')
r = chooseLayout(sl('{cards}{id=a1}'), at, 'list')
assert.equal(r.outline, setLayout(sl('{cards}{id=a1}'), at, 'list').outline, 'a plain layout is swapped as the picker swaps it')

// ── Ticket 11: a layout line that is not directly under the heading ─────────────────────────
// The margin's menu changes the EXISTING line where it is: one layout token on the slide after
// it, and the compiled slide is the chosen layout. (The compiler folds a layout line into its
// slide wherever the line stands.)
const { adaptMarkdownOutlineV2 } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
const { LAYOUTS } = await import('../src/shared/layout-registry/entries.ts')
const { parseTriggerLine } = await import('../src/shared/trigger-line.ts')
const { selectionFromTriggerLine } = await import('../src/shared/layout-selection.ts')
/** Every layout token (a layout, or a list style acting as one) written on a `{…}`-only line of the slide. */
const layoutTokens = (outline, title) => {
  const lines = outline.split('\n')
  const from = lines.findIndex((line) => line.startsWith(`### ${title}`))
  const out = []
  for (let i = from + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i += 1) {
    if (!/^\s*(\{[^}]*\}\s*)+$/.test(lines[i])) continue
    for (const item of selectionFromTriggerLine(lines[i].trim(), [...LAYOUTS])) {
      if (item.kind === 'layout' || (item.kind === 'modifier' && item.resolvesTo?.key === 'liststyle')) out.push({ line: i + 1, tokens: parseTriggerLine(item.trigger).map((t) => t.raw).join(',') })
    }
  }
  return out
}
const compiledLayout = (outline, title) => adaptMarkdownOutlineV2(outline, 'Fallback', {}).slides.find((slide) => slide.title === title)?.layout
const legacy = (line) => ['# T', '', '## S', '', '### Effort spent on building pyramids', '', line, '', '- Pyramid', '- Food for workers', '- Tools', '', '### Next', 'Body', ''].join('\n')
const P = 'Effort spent on building pyramids'
assert.equal(compiledLayout(legacy('{pyramid}'), P), 'pyramid', 'the legacy shape compiles to a pyramid')

// The legacy shape: heading, blank line, layout line. Statement is chosen: the line is changed in its place.
r = chooseLayout(legacy('{pyramid}'), at, 'statement')
assert.equal(r.outline, legacy('{statement}'), 'the legacy layout line is changed where it is')
assert.deepEqual(layoutTokens(r.outline, P), [{ line: 7, tokens: 'statement' }], 'exactly one layout token, on the same line')
assert.equal(compiledLayout(r.outline, P), 'statement', 'the compiled slide is a statement')
r = chooseLayout(legacy('{pyramid}{id=p1}'), at, 'statement')
assert.equal(r.outline, legacy('{statement}{id=p1}'), 'the id stays')
r = clearLayout(legacy('{pyramid}{id=p1}'), at)
assert.equal(r.outline, legacy('{id=p1}'), 'Auto on the legacy shape: the token goes, the id and the line stay')
r = clearLayout(legacy('{pyramid}'), at)
assert.deepEqual(layoutTokens(r.outline, P), [], 'Auto: no layout token is left')
assert.ok(!r.outline.includes('{pyramid}') && r.outline.includes('- Pyramid'), r.outline)

// A layout line in the middle of the body (not the Trigger block: other text stands above it).
const middle = (line, block = '') => ['# T', '', '## S', '', '### Body slide', ...(block ? [block] : []), 'Intro text', line, '- One', '- Two', '- Three', '', '### Next', 'Body', ''].join('\n')
assert.equal(compiledLayout(middle('{cards}'), 'Body slide'), 'cards', 'the compiler folds a layout line among the body into the slide')
r = chooseLayout(middle('{cards}'), at, 'pyramid')
assert.equal(r.outline, middle('{pyramid}'), 'a layout line among the body is changed where it is')
assert.deepEqual(layoutTokens(r.outline, 'Body slide'), [{ line: 7, tokens: 'pyramid' }], 'exactly one layout token, not a second line under the heading')
assert.equal(compiledLayout(r.outline, 'Body slide'), 'pyramid', 'the compiled slide is the chosen layout')
r = chooseLayout(middle('{iconlist}{reveal}'), at, 'cards')
assert.equal(r.outline, middle('{cards}{reveal}'), 'a list style among the body is replaced where it is; the other token stays')
r = chooseLayout(middle('{cards}', '{id=b1}'), at, 'pyramid')
assert.equal(r.outline, middle('{pyramid}', '{id=b1}'), 'an id-only Trigger block stays; the layout is changed on its own line')
r = clearLayout(middle('{cards}'), at)
assert.equal(r.outline, ['# T', '', '## S', '', '### Body slide', 'Intro text', '- One', '- Two', '- Three', '', '### Next', 'Body', ''].join('\n'), 'Auto: the line goes when nothing is left on it')
r = clearLayout(middle('{cards}{reveal}'), at)
assert.equal(r.outline, middle('{reveal}'), 'Auto: the other token stays on its line')
// Two layouts written, one in the Trigger block and one below: one layout after the choice, in the block.
r = chooseLayout(middle('{cards}', '{iconlist}'), at, 'pyramid')
assert.deepEqual(layoutTokens(r.outline, 'Body slide').map((t) => t.tokens), ['pyramid'], 'two layouts written: one after the choice: ' + r.outline)
assert.equal(compiledLayout(r.outline, 'Body slide'), 'pyramid')
r = clearLayout(middle('{cards}', '{iconlist}'), at)
assert.deepEqual(layoutTokens(r.outline, 'Body slide'), [], 'Auto clears both')
// Another slide's layout line is never touched.
const two = middle('{cards}').replace('### Next\nBody', '### Next\nBody\n{statement}')
r = chooseLayout(two, at, 'pyramid')
assert.ok(r.outline.includes('### Next\nBody\n{statement}') && r.outline.includes('{pyramid}'), 'the next slide keeps its own layout line')

// ── Ticket 11, second round: the verbs read the slide through the compiler and verify the result ──
// Every answer is { ok, text }. ok:true only for a result read back through the compiler; ok:false
// leaves the text as it was. The oracle here is the real compiler (adaptMarkdownOutlineV2).
const { compilerFacts } = await import('../src/shared/plain-view-compiler-facts.ts')
const { authoredLayoutOf, entryTriggerBody, isSettableLayout, layoutDecisionOfEntry } = await import('../src/shared/slide-authored-layout.ts')
const { marginLabels, MARGIN_LAYOUT_NAMES } = await import('../src/shared/plain-view-margin.ts')
const labelAt = (outline, line) => marginLabels(null, outline).find((l) => l.line === line)?.layoutLabel
const factsAt = (outline, line) => compilerFacts(outline).slideLayouts.get(line - 1)
const writing = (outline, line) => factsAt(outline, line).tokens.filter((t) => t.writesLayout).map((t) => t.source)
const entryOf = (name) => LAYOUTS.find((e) => e.name === name)
const refusedUnchanged = (w, text, reason, what) => {
  assert.equal(w.ok, false, `${what}: refused`)
  assert.equal(w.reason, reason, `${what}: reason`)
  assert.equal(w.text, text, `${what}: the text is returned unchanged`)
  assert.equal(w.outline, text, `${what}: the outline is returned unchanged`)
  assert.ok(w.detail && !/[{}]/.test(w.detail), `${what}: a notice the menu can show: ${w.detail}`)
}

// Review finding 1: the explicit {layout=…} form, sharing its line with {id=…} and {reveal}, among the body.
const review1 = '# T\n\n## S\n\n### Comparison\nIntro\n{layout=compare}{id=cmp}{reveal}\n- A\n- B\n'
assert.equal(compiledLayout(review1, 'Comparison'), 'compare')
assert.equal(labelAt(review1, 5), 'Compare', 'review 1: the margin names the explicit form')
r = chooseLayout(review1, at, 'list')
assert.ok(r.ok, 'review 1, List')
assert.equal(r.text, review1.replace('{layout=compare}', '{list}'), 'review 1, List: replaced in place, id and reveal kept')
assert.equal(compiledLayout(r.text, 'Comparison'), 'list')
assert.equal(labelAt(r.text, 5), 'List')
r = chooseLayout(review1, at, 'statement')
assert.equal(r.text, review1.replace('{layout=compare}', '{statement}'), 'review 1, Statement')
assert.equal(compiledLayout(r.text, 'Comparison'), 'statement')
r = clearLayout(review1, at)
assert.equal(r.text, review1.replace('{layout=compare}', ''), 'review 1, Auto: the explicit token goes, id and reveal stay')
assert.equal(labelAt(r.text, 5), 'Auto')
assert.deepEqual(writing(r.text, 5), [])

// Review finding 2: two layout lines; the compiler's winner is the later one.
const review2 = '# T\n\n## S\n\n### Slide\n{cards}\nIntro\n{pyramid}\n- A\n- B\n- C\n'
assert.equal(compiledLayout(review2, 'Slide'), 'pyramid')
assert.equal(labelAt(review2, 5), 'Pyramid', 'review 2: the margin names the compiler\'s winner, not the registry\'s first')
r = chooseLayout(review2, at, 'list')
assert.equal(r.text, '# T\n\n## S\n\n### Slide\nIntro\n{list}\n- A\n- B\n- C\n', 'review 2, List: the winner is replaced where it is, the other layout line goes with its line break')
assert.equal(compiledLayout(r.text, 'Slide'), 'list')
r = chooseLayout(review2, at, 'statement')
assert.equal(r.text, '# T\n\n## S\n\n### Slide\nIntro\n{statement}\n- A\n- B\n- C\n', 'review 2, Statement')
assert.equal(compiledLayout(r.text, 'Slide'), 'statement')
r = clearLayout(review2, at)
assert.equal(r.text, '# T\n\n## S\n\n### Slide\nIntro\n- A\n- B\n- C\n', 'review 2, Auto: both layout lines go')
assert.equal(labelAt(r.text, 5), 'Auto')

// Every registered layout, in every form the compiler accepts.
// A layout the menu's verb can set: the compiler resolves its trigger to a layout (or a list style) and the registry names it back.
const choosable = LAYOUTS.filter(isSettableLayout)
// The others are refused by name before anything is edited; none of them is a layout to the real compiler.
for (const entry of LAYOUTS.filter((e) => !isSettableLayout(e))) {
  refusedUnchanged(chooseLayout(review2, at, entry.name), review2, 'layout-not-applied', `${entry.name} is not a layout`)
}
assert.ok(choosable.length >= 40, `the registry's layouts are reached: ${choosable.length}`)
for (const name of MARGIN_LAYOUT_NAMES) assert.ok(choosable.some((e) => e.name === name), `the menu's ${name} is a layout the verb can set`)
const formsOf = (entry) => {
  const forms = new Set([entryTriggerBody(entry), ...entry.aliases.map((a) => a.replace(/^\{|\}$/g, '')), ...entry.triggerWords, ...(entry.bareAliases ?? []).map((a) => a.word)])
  const decision = layoutDecisionOfEntry(entry)
  if (decision?.by === 'layout') forms.add(`layout=${decision.layout}`)
  if (entry.resolvesTo) forms.add(`${entry.resolvesTo.key}=${entry.resolvesTo.value}`)
  for (const group of entry.options ?? []) for (const value of group.values) if (value.token) forms.add(value.token)
  // Kept: the forms that, alone on a slide, the compiler reads as writing a layout.
  return [...forms].filter((form) => form && factsAt(`## S\n\n### A\n{${form}}\n`, 3)?.authored)
}
const body3 = '- a\n- b\n- c\n'
const shape = (form) => `# T\n\n## S\n\n### Slide\n{${form}}{id=a1}{reveal}\n${body3}\n### Next {cards}\n{id=n1}\nBody\n`
const tally = { forms: 0, chosen: 0, cleared: 0, cannotTake: 0, explicit: 0, alias: 0 }
choosable.forEach((entry, index) => {
  const targets = new Set([...MARGIN_LAYOUT_NAMES, 'statement', choosable[(index + 1) % choosable.length].name, choosable[(index + 7) % choosable.length].name])
  for (const form of formsOf(entry)) {
    tally.forms += 1
    if (form.startsWith('layout=')) tally.explicit += 1
    else if (form !== entryTriggerBody(entry)) tally.alias += 1
    const text = shape(form)
    assert.notEqual(labelAt(text, 5), 'Auto', `{${form}}: the margin names a layout`)
    for (const name of targets) {
      const target = entryOf(name)
      const w = chooseLayout(text, at, name)
      const what = `{${form}} → ${name}`
      if (!w.ok) { refusedUnchanged(w, text, 'cannot-take', what); tally.cannotTake += 1; continue }
      tally.chosen += 1
      const now = factsAt(w.text, 5)
      assert.equal(now.tokens.filter((t) => t.writesLayout).length, 1, `${what}: exactly one layout-writing token: ${JSON.stringify(w.text)}`)
      assert.equal(authoredLayoutOf(now)?.entry, target, `${what}: the slide's layout is the chosen one`)
      assert.deepEqual(now.tokens.filter((t) => !t.writesLayout).map((t) => t.source), ['id=a1', 'reveal'], `${what}: id and reveal kept`)
      assert.ok(w.text.endsWith(`${body3}\n### Next {cards}\n{id=n1}\nBody\n`) && w.text.startsWith('# T\n\n## S\n\n### Slide\n'), `${what}: nothing else is touched`)
      // The real compiler: the slide compiles as a slide that writes only the chosen layout's own trigger.
      assert.equal(compiledLayout(w.text, 'Slide'), compiledLayout(shape(entryTriggerBody(target)), 'Slide'), `${what}: compiled layout`)
      assert.equal(labelAt(w.text, 5), target.label, `${what}: margin label`)
    }
    const c = clearLayout(text, at)
    assert.ok(c.ok, `{${form}} → Auto`)
    tally.cleared += 1
    assert.equal(c.text, text.replace(`{${form}}`, ''), `{${form}} → Auto: only the layout token goes`)
    assert.equal(labelAt(c.text, 5), 'Auto')
    assert.equal(compiledLayout(c.text, 'Slide'), 'list', `{${form}} → Auto: the compiler reads the content`)
  }
})
assert.ok(tally.explicit >= 30 && tally.alias >= 10 && tally.chosen > 500, JSON.stringify(tally))

// Shapes.
const one = (lines) => ['# T', '', '## S', '', ...lines, '', '### Next', 'Body', ''].join('\n')
// The layout line after a blank line; a token on the heading line; a layout line among the body: one layout after the choice.
const three = one(['### Slide {cards}', '', '{pyramid}{id=a1}', 'Intro', '{numbered}{reveal}', '- A', '- B', '- C'])
assert.equal(labelAt(three, 5), 'Pyramid', 'heading token, block token and a list style below: the compiler\'s layout')
r = chooseLayout(three, at, 'image-grid')
assert.ok(!r.ok && r.reason === 'cannot-take' && r.text === three, 'a layout the content cannot take: nothing written')
r = chooseLayout(three, at, 'list')
assert.equal(r.text, one(['### Slide', '', '{list}{id=a1}', 'Intro', '{reveal}', '- A', '- B', '- C']), 'the winner is replaced; the heading\'s and the list style\'s tokens go')
assert.equal(compiledLayout(r.text, 'Slide'), 'list')
r = clearLayout(three, at)
assert.equal(r.text, one(['### Slide', '', '{id=a1}', 'Intro', '{reveal}', '- A', '- B', '- C']), 'Auto on three layout tokens')
// Tokens in one group, separated by a comma or a space.
r = chooseLayout(one(['### Slide', '{reveal,cards id=a1}', '- A', '- B', '- C']), at, 'iconlist')
assert.equal(r.text, one(['### Slide', '{reveal,iconlist id=a1}', '- A', '- B', '- C']))
r = clearLayout(one(['### Slide', '{reveal,cards id=a1}', '- A', '- B', '- C']), at)
assert.equal(r.text, one(['### Slide', '{reveal,id=a1}', '- A', '- B', '- C']))
// CRLF kept.
const crlf = one(['### Slide', '{cards}', 'Intro', '{pyramid}{reveal}', '- A', '- B', '- C']).replace(/\n/g, '\r\n')
r = chooseLayout(crlf, at, 'list')
assert.equal(r.text, one(['### Slide', 'Intro', '{list}{reveal}', '- A', '- B', '- C']).replace(/\n/g, '\r\n'), 'CRLF kept')
// A chart token that owns the list under it is content for the compiler, not the slide's layout line: never edited.
const owned = one(['### Slide', 'Intro', '', '{chart=bar}', '- A: 1', '- B: 2'])
assert.ok(!compilerFacts(owned).layoutLines.has(7), 'the compiler keeps the owning chart token as content')
assert.equal(labelAt(owned, 5), 'Auto', 'an owning chart token is not a written layout')
r = clearLayout(owned, at)
assert.ok(r.ok && r.text === owned, 'Auto leaves an owning chart token alone')
r = chooseLayout(owned, at, 'list')
assert.ok(r.ok && r.text.includes('\n{chart=bar}\n- A: 1') && writing(r.text, 5).join() === 'list', 'List is written as the slide\'s layout; the chart token stays: ' + JSON.stringify(r.text))
assert.equal(compiledLayout(r.text, 'Slide'), compiledLayout(owned.replace('### Slide\n', '### Slide\n{list}\n'), 'Slide'))
// The same token as the heading's Trigger line is the slide's layout (the compiler folds it): edited.
const chartLine = one(['### Slide', '{chart=bar}{id=c1}', 'Intro', '- A: 1', '- B: 2'])
assert.equal(labelAt(chartLine, 5), LAYOUTS.find((e) => e.name === authoredLayoutOf(factsAt(chartLine, 5)).name).label)
r = clearLayout(chartLine, at)
assert.equal(r.text, one(['### Slide', '{id=c1}', 'Intro', '- A: 1', '- B: 2']))
// A talk-wide default in the front matter: never touched; it does not make a slide's layout "written".
const deck = (lines) => `---\ntitle: T\ntriggers: iconlist reveal\n---\n${one(lines)}`
const deckAt = { headingLine: 9 }
const plain = deck(['### Slide', '- A', '- B', '- C'])
assert.equal(labelAt(plain, 9), 'Auto', 'a talk-wide default is not the slide\'s written layout')
r = clearLayout(plain, deckAt)
assert.ok(r.ok && r.text === plain, 'Auto with a talk-wide default: nothing to remove, front matter untouched')
r = chooseLayout(plain, deckAt, 'iconlist')
assert.equal(r.text, deck(['### Slide', '{iconlist}', '- A', '- B', '- C']), 'the talk-wide default may be chosen explicitly')
r = clearLayout(deck(['### Slide', '{cards}', '- A', '- B', '- C']), deckAt)
assert.equal(r.text, plain, 'Auto removes the slide\'s token only')
// A talk-wide default that outranks the chosen layout in the compiler: the slide would not compile to it, so nothing is written.
// (One slide under the section: with two, the default `cols=2` makes the SECTION take both as its
// columns and neither is a slide of its own; that case follows.)
const cols = `---\ntriggers: cols=2\n---\n${['# T', '', '## S', '', '### Slide', '- A: 1', '- B: 2', ''].join('\n')}`
{
  const taken = `---\ntriggers: cols=2\n---\n${one(['### Slide', '- A: 1', '- B: 2'])}`
  const { adaptMarkdownOutlineV2: realCompile } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
  assert.equal(realCompile(taken, 'T', {}).slides.some((slide) => slide.sourceLine === 8), false, 'the real compiler makes no slide of a heading the section takes as a column')
  assert.equal(factsAt(taken, 8).final, null)
  refusedUnchanged(chooseLayout(taken, { headingLine: 8 }, 'list'), taken, 'layout-not-applied', 'a heading that is no slide of its own is given no layout')
}
r = chooseLayout(cols, { headingLine: 8 }, 'barchart')
refusedUnchanged(r, cols, 'layout-not-applied', 'a talk-wide default outranks the chosen layout')
r = chooseLayout(cols, { headingLine: 8 }, 'list')
assert.ok(r.ok && writing(r.text, 8).join() === 'list', 'an explicit layout outranks the talk-wide default')

// ok:false: nothing is written.
const partly = one(['### Slide', '{cards} <!-- why -->', '- A', '- B', '- C'])
assert.equal(compiledLayout(partly, 'Slide'), 'cards', 'the compiler reads a partly commented layout line')
refusedUnchanged(chooseLayout(partly, at, 'list'), partly, 'cannot-place-here', 'a partly commented layout line, choose')
refusedUnchanged(clearLayout(partly, at), partly, 'cannot-place-here', 'a partly commented layout line, Auto')
const partlyOther = one(['### Slide', '{reveal} <!-- why -->', '- A', '- B', '- C'])
r = chooseLayout(partlyOther, at, 'cards')
assert.ok(r.ok ? compiledLayout(r.text, 'Slide') === 'cards' && r.text.includes('{reveal} <!-- why -->') : r.text === partlyOther, 'a commented line with no layout on it is never edited inside')
refusedUnchanged(chooseLayout(review1, { headingLine: 2 }, 'list'), review1, 'slide-not-found', 'no slide on that line')
refusedUnchanged(clearLayout(review1, 'no-such-id'), review1, 'slide-not-found', 'no slide with that id')
refusedUnchanged(chooseLayout(review1, at, 'no-such-layout'), review1, 'unknown-layout', 'an unknown layout')
// An entry the compiler does not read as a layout (a modifier) is not something the layout menu can set.
refusedUnchanged(chooseLayout(review2, at, 'reveal'), review2, 'layout-not-applied', 'a modifier is not a layout')

// ── Ticket 11, third round ──────────────────────────────────────────────────────────────────
const { lexMarkdownBlocksWith } = await import('../compiler/scripts/lib/03-markdown-lexer-core.mjs')
const { TRIGGER_DICTIONARY, VALUE_TRIGGER_DICTIONARY, OPEN_PATTERN_TOKENS, DYNAMIC_PATTERNS } = await import('../compiler/scripts/lib/trigger-dictionary.generated.mjs')
const loneCr = (text) => /\r(?!\n)/.test(text)
const bareLf = (text) => /(^|[^\r])\n/.test(text)

// NAMED CASE: the last layout line of a CRLF document with no final line break (generated seed 22).
// Auto on the last slide removed `{layout=chat, curve}`, the document's last line, and left the
// `\r` of the line break before it: the text ended `- C\r`. The compiler's lexer read `- C\r` as a
// list (it tests the trimmed line) that its list reader did not take (`.` stops at `\r`), stood on
// the line for ever and filled the heap. Both ends are held here.
const SEED22 = [
  "---",
  "title: Generated",
  "triggers: \"{numbered} {reveal}\"",
  "---",
  "# Talk",
  "",
  "## Part one",
  "",
  "### After",
  "",
  "A paragraph.",
  "{icon=lucide:star}{equation=circle, blocks:2x3, layout=table}{layout=stats}",
  ":::notes",
  "{cards}",
  ":::",
  "",
  "### After {layout=image-grid,piechart,nostep}",
  "{system-map}{id=a1, list}",
  "{steps}{icon=lucide:star,id=a1}{cards=stepped equation cards=stepped}",
  "A paragraph.",
  "{cols=3 unknownword}{table cols=3}{layout=mindmap}",
  "",
  "### Text with `code`",
  "{note=\"a, b\"} {layout=contrast, blocks:2x3}",
  "  {layout=contrast,layout=timetable}{layout=columns}  ",
  "",
  "",
  "### After",
  "{statement-bg=full}",
  "{cols=3,terminal,layout=stats} {layout=cards cols=3 note=\"a, b\"} {cols=3, stmt-list, nostep}",
  ":::notes",
  "{cards}",
  ":::",
  "",
  "## Text with `code`",
  "{cols=3,nostep,id=a1} {blocks:2x3, layout=iconrow} {equation,layout=stmt-list,statement}",
  "- A",
  "- B",
  "- C",
  "{layout=chat, curve}"
]
const lastLineCrlf = SEED22.join('\r\n')
assert.ok(!lastLineCrlf.endsWith('\n') && !bareLf(lastLineCrlf), 'the reproduction is CRLF with no final line break')
r = clearLayout(lastLineCrlf, { headingLine: 35 })
assert.ok(r.ok, 'seed 22: Auto on the last slide of a CRLF document')
assert.equal(r.text, [...SEED22.slice(0, 35), '{nostep,id=a1}', '- A', '- B', '- C'].join('\r\n'), 'seed 22: the last line goes with the whole line break before it')
assert.ok(!loneCr(r.text) && !bareLf(r.text), 'seed 22: no lone carriage return, no bare line feed')
assert.equal(compiledLayout(r.text, 'Text with `code`') !== undefined, true, 'seed 22: the result compiles')
// Every heading of that document, every layout the menu's verb can set, and Auto: each call answers, and writes CRLF only.
{
  const headings = [...compilerFacts(lastLineCrlf).slideLayouts.keys()]
  let answered = 0
  for (const h of headings) {
    for (const entry of [...choosable, null]) {
      const w = entry ? chooseLayout(lastLineCrlf, { headingLine: h + 1 }, entry.name) : clearLayout(lastLineCrlf, { headingLine: h + 1 })
      answered += 1
      if (!w.ok) { assert.equal(w.text, lastLineCrlf, `seed 22 line ${h + 1} ${entry?.name ?? 'Auto'}: refused, unchanged`); continue }
      assert.ok(!loneCr(w.text) && !bareLf(w.text), `seed 22 line ${h + 1} ${entry?.name ?? 'Auto'}: line endings kept`)
    }
  }
  assert.equal(answered, headings.length * (choosable.length + 1))
}
// The lexer itself: a list row with a lone carriage return, at the end or inside, is a list row; the lexer moves on.
assert.deepEqual(lexMarkdownBlocksWith(['- A', '- C\r'], () => null).map((b) => [b.type, b.items]), [['list', ['A', 'C']]], 'a list row ending in a lone carriage return')
assert.equal(lexMarkdownBlocksWith(['- A\rB', 'After'], () => null).length, 2, 'a list row with a lone carriage return inside it')
assert.equal(adaptMarkdownOutlineV2('# T\n\n## S\n\n### A\n- B\n- C\r', 'Fallback', {}).slides.find((slide) => slide.title === 'A')?.layout, 'list', 'the compiler reads a document ending in a lone carriage return')

// NAMED CASES: CRLF and mixed line endings. Outside the slide the text is the same byte for byte;
// inside it every line keeps the ending it had.
const crlfDoc = (lines, last = true) => ['# T', '', '## S', '', '### Before', '{cards}{id=b1}', '- x', '', ...lines, '', '### Next', '{numbered}', 'Body'].join('\r\n') + (last ? '\r\n' : '')
const crlfAt = { headingLine: 9 }
const outside = (text, from, to) => { const l = text.split('\n'); return [l.slice(0, from).join('\n'), l.slice(to).join('\n')] }
for (const last of [true, false]) {
  const text = crlfDoc(['### Slide {cards}', '', '{pyramid}{id=a1}', 'Intro', '{numbered}{reveal}', '- A', '- B', '- C'], last)
  const end = 8 + 8
  // choose, CRLF
  r = chooseLayout(text, crlfAt, 'list')
  assert.ok(r.ok, 'CRLF, choose')
  assert.equal(r.text, crlfDoc(['### Slide', '', '{list}{id=a1}', 'Intro', '{reveal}', '- A', '- B', '- C'], last), 'CRLF, choose: the edit, every line ending kept')
  assert.deepEqual(outside(r.text, 8, end), outside(text, 8, end), 'CRLF, choose: the text outside the slide is the same byte for byte')
  assert.ok(!loneCr(r.text) && !bareLf(r.text), 'CRLF, choose: CRLF only')
  assert.equal(compiledLayout(r.text, 'Slide'), 'list')
  // clear, CRLF
  r = clearLayout(text, crlfAt)
  assert.ok(r.ok, 'CRLF, clear')
  assert.equal(r.text, crlfDoc(['### Slide', '', '{id=a1}', 'Intro', '{reveal}', '- A', '- B', '- C'], last), 'CRLF, clear: the edit, every line ending kept')
  assert.deepEqual(outside(r.text, 8, end), outside(text, 8, end), 'CRLF, clear: the text outside the slide is the same byte for byte')
  assert.ok(!loneCr(r.text) && !bareLf(r.text), 'CRLF, clear: CRLF only')
  // a whole layout line removed, CRLF
  const lineGone = crlfDoc(['### Slide', '{cards}', '- A', '- B', '- C'], last)
  r = clearLayout(lineGone, crlfAt)
  assert.equal(r.text, crlfDoc(['### Slide', '- A', '- B', '- C'], last), 'CRLF, clear: a layout line goes with its own line break')
  // a slide that writes no layout: the Trigger line is written with the document's line ending
  r = chooseLayout(crlfDoc(['### Slide', '- A', '- B', '- C'], last), crlfAt, 'cards')
  assert.equal(r.text, lineGone, 'CRLF, choose on a slide with no layout: the new line ends in CRLF')
}
// The slide is the end of a CRLF document that has no final line break.
const tail = (lines) => ['# T', '', '## S', '', ...lines].join('\r\n')
r = clearLayout(tail(['### Slide', '- A', '{cards}']), at)
assert.equal(r.text, tail(['### Slide', '- A']), 'CRLF, the layout line is the last line: removed with the line break before it')
r = chooseLayout(tail(['### Slide', '- A', '{cards}']), at, 'list')
assert.equal(r.text, tail(['### Slide', '- A', '{list}']), 'CRLF, the layout line is the last line: replaced in place')
r = chooseLayout(tail(['### Slide', '{id=a1}']), at, 'cards')
assert.ok(r.ok && !loneCr(r.text) && !bareLf(r.text) && writing(r.text, 5).join() === 'cards', 'CRLF, an id line as the last line: the layout is written with no lone carriage return: ' + JSON.stringify(r.text))
r = chooseLayout(tail(['### Slide']), at, 'cards')
assert.equal(r.text, tail(['### Slide', '{cards}']), 'CRLF, the heading is the last line: it gets the document\'s line break, the new last line none')
r = chooseLayout('## S\n\n### A\n- x\n\n### Slide', { headingLine: 6 }, 'cards')
assert.equal(r.text, '## S\n\n### A\n- x\n\n### Slide\n{cards}', 'LF, the heading is the last line')
// Mixed: a CRLF slide in an LF document, and an LF slide in a CRLF document.
const mixedA = '# T\n\n## S\n\n### Slide\r\n{cards}{id=a1}\r\nIntro\r\n{pyramid}\r\n- A\r\n- B\r\n- C\r\n\n### Next\n{numbered}\nBody\n'
r = chooseLayout(mixedA, at, 'list')
assert.equal(r.text, '# T\n\n## S\n\n### Slide\r\n{id=a1}\r\nIntro\r\n{list}\r\n- A\r\n- B\r\n- C\r\n\n### Next\n{numbered}\nBody\n', 'mixed, choose: each line keeps its own ending')
r = clearLayout(mixedA, at)
assert.equal(r.text, '# T\n\n## S\n\n### Slide\r\n{id=a1}\r\nIntro\r\n- A\r\n- B\r\n- C\r\n\n### Next\n{numbered}\nBody\n', 'mixed, clear: each line keeps its own ending')
const mixedB = '# T\r\n\r\n## S\r\n\r\n### Slide\n{cards}{id=a1}\n- A\n- B\n- C\n\r\n### Next\r\n{numbered}\r\nBody\r\n'
r = chooseLayout(mixedB, at, 'iconlist')
assert.equal(r.text, mixedB.replace('{cards}', '{iconlist}'), 'mixed, an LF slide in a CRLF document')
r = clearLayout(mixedB, at)
assert.equal(r.text, mixedB.replace('{cards}', ''), 'mixed, clear on an LF slide in a CRLF document')

// NAMED CASE: a heading the compiler keeps as a section divider. A layout that takes child headings
// and is refused them (Cards with child headings; Compare with one) leaves the divider standing:
// the verb answers ok:false and writes nothing, and the margin gives the heading no layout name.
const kept = '# T\n\n## S\n\n### Group\n\n#### One\n- a\n\n#### Two\n- b\n'
assert.equal(compiledLayout(kept, 'Group'), 'section-title')
assert.equal(factsAt(kept, 5).divider, true, 'a heading with child headings and no body is a divider')
assert.equal(marginLabels(null, kept).find((l) => l.line === 5).kind, 'section', 'a divider is a Section in the margin before it is compiled')
refusedUnchanged(chooseLayout(kept, at, 'cards'), kept, 'layout-not-applied', 'Cards on a divider heading: the compiler keeps the divider')
assert.equal(compiledLayout(kept.replace('### Group\n', '### Group\n{cards}\n'), 'Group'), 'section-title', 'the compiler: {cards} written there is still a divider')
const keptCards = kept.replace('### Group\n', '### Group\n{cards}\n')
assert.equal(factsAt(keptCards, 5).divider, true)
assert.equal(labelAt(keptCards, 5), undefined, 'a divider that writes {cards} is not labelled Cards')
assert.equal(marginLabels(adaptMarkdownOutlineV2(keptCards, 'Fallback', {}).slides, keptCards).find((l) => l.line === 5).kind, 'section', 'compiled: a Section')
r = clearLayout(keptCards, at)
assert.equal(r.text, kept, 'Auto on a divider that writes a layout removes the token')
// A layout that takes the children is applied (the compiler folds them); so is one that does not need them.
r = chooseLayout(kept, at, 'compare')
assert.ok(r.ok && compiledLayout(r.text, 'Group') === 'compare', 'Compare takes two child headings')
r = chooseLayout(kept, at, 'list')
assert.ok(r.ok && compiledLayout(r.text, 'Group') === 'list', 'List on a heading with child headings: the author\'s token wins over the divider')
const oneChild = '# T\n\n## S\n\n### Group\nIntro\n\n#### One\n- a\n'
assert.equal(factsAt(oneChild, 5).divider, false, 'a heading with a body is not a divider')
const emptyOneChild = oneChild.replace('Intro\n', '')
for (const name of ['contrast', 'columns']) {
  const w = chooseLayout(emptyOneChild, at, name)
  if (w.ok) assert.equal(compiledLayout(w.text, 'Group'), layoutDecisionOfEntry(entryOf(name)).layout, `${name} with one child heading: ok only when the compiler agrees`)
  else assert.equal(w.text, emptyOneChild)
}

// NAMED CASE: option tokens. A token is "layout-writing" when, alone on a slide, it makes the
// compiler's authored decision (or sets the list style); those go when another layout is chosen or
// the layout is cleared. Every other token is never removed. The registry is walked whole.
const registered = new Map()
for (const word of Object.keys(TRIGGER_DICTIONARY)) registered.set(word, 'word')
for (const [key, values] of Object.entries(VALUE_TRIGGER_DICTIONARY)) for (const value of values) registered.set(`${key}=${value}`, 'value')
// One example of every open-pattern key and every dynamic pattern (their values are free text or numbers).
const OPEN_EXAMPLES = {
  pollselections: 'pollselections=2', pollsubmissions: 'pollsubmissions=unlimited', id: 'id=a1', tags: 'tags=one,two', reactions: 'reactions=off',
  from: 'from=abc', clonedFrom: 'clonedFrom=abc', model: 'model=Opus', 'window-title': 'window-title=Terminal', icon: 'icon=lucide:star',
  kicker: 'kicker=Hello', remind: 'remind=5', 'remind-at': 'remind-at=10', 'remind-in': 'remind-in=5', countdown: 'countdown=5m', timer: 'timer=10',
  'countdown-style': 'countdown-style=bar', blocks: 'blocks:2x3', polltop: 'polltop=3', cols: 'cols=3', palette: 'palette=warm', centre: 'centre=x',
  center: 'center=x', curve: 'curve=sigmoid', titlestyle: 'titlestyle=plain', results: 'results=abc'
}
for (const open of OPEN_PATTERN_TOKENS) {
  assert.ok(OPEN_EXAMPLES[open.key], `an example for the open-pattern token ${open.key} (add one above)`)
  registered.set(OPEN_EXAMPLES[open.key], 'open')
}
assert.equal(DYNAMIC_PATTERNS.length, 3, 'an example for every dynamic pattern (add one below)')
for (const token of ['countdown-digits-5m', 'sidebar-30', 'page-60']) registered.set(token, 'dynamic')
// Not in the registry at all: kept as written too.
for (const token of ['title-icon=lucide:star', 'note="a, b"', 'notes', 'unknownword', 'x=1']) registered.set(token, 'unregistered')
const aloneWrites = (token) => factsAt(`## S\n\n### A\n{${token}}\n- a\n`, 3).tokens.some((t) => t.writesLayout)
const layoutKeys = new Set()
const nonLayout = []
for (const token of registered.keys()) {
  if (!aloneWrites(token)) { nonLayout.push(token); continue }
  for (const key of Object.keys(factsAt(`## S\n\n### A\n{${token}}\n- a\n`, 3).tokens[0].attrs)) layoutKeys.add(key)
}
// The attr keys through which a registered token writes a layout: the compiler's authored decision
// (authored-layout.mjs) and the list style. A new one here is a new kind of token the verbs remove: look before adding it.
assert.deepEqual([...layoutKeys].sort(), ['blocks', 'cards', 'chart', 'cols', 'contrast', 'curve', 'equation', 'layout', 'liststyle', 'statement', 'statement-align', 'statement-bar', 'statement-bg', 'statement-sidebar', 'timeline'])
// The brief's four: option tokens that decide a layout alone are layout-writing …
for (const token of ['cols=3', 'cards=stepped', 'statement-bg=full', 'contrast=rows']) assert.ok(aloneWrites(token), `{${token}} writes a layout`)
// … and a number of cards per phone ({cards=3}) is not the cards layout.
assert.ok(!aloneWrites('cards=3'))
r = chooseLayout(one(['### Slide', '{cols=3}{cards=stepped}{statement-bg=full}{contrast=rows}{id=a1}', '- A', '- B', '- C']), at, 'list')
assert.equal(r.text, one(['### Slide', '{list}{id=a1}', '- A', '- B', '- C']), 'the option tokens that decide a layout go when another layout is chosen')
r = clearLayout(one(['### Slide', '{cols=3}{cards=stepped}{statement-bg=full}{contrast=rows}{id=a1}', '- A', '- B', '- C']), at)
assert.equal(r.text, one(['### Slide', '{id=a1}', '- A', '- B', '- C']), '… and when the layout is cleared')
// Tokens that must come through every time, by name.
const MUST_KEEP = ['id=a1', 'reveal', 'icon=lucide:star', 'title-icon=lucide:star', 'title-icon=above', 'note="a, b"', 'notes', 'timer=10', 'countdown=5m', 'remind-in=5', 'minutes=10', 'nostep', 'accent=cobalt', 'tags=one,two', 'kicker=Hello', 'unknownword', 'cards=3']
for (const token of MUST_KEEP) assert.ok(nonLayout.includes(token), `{${token}} is not a layout-writing token`)
const keptTally = { tokens: nonLayout.length, writes: 0, refused: [] }
for (const token of nonLayout) {
  // Three places: its own group after the layout, the layout's own group, the heading line.
  const places = [
    [['### Slide', `{cards}{${token}}`], (put) => ['### Slide', `${put ? `{${put}}` : ''}{${token}}`]],
    [['### Slide', `{cards ${token}}`], (put) => ['### Slide', `{${put ? `${put} ` : ''}${token}}`]],
    [[`### Slide {${token}}`, '{cards}'], (put) => [`### Slide {${token}}`, ...(put ? [`{${put}}`] : [])]]
  ]
  for (const [lines, expected] of places) {
    const text = one([...lines, '- A', '- B', '- C'])
    for (const name of ['list', 'iconlist', null]) {
      const w = name ? chooseLayout(text, at, name) : clearLayout(text, at)
      const what = `{${token}} beside {cards}, ${name ?? 'Auto'}, ${JSON.stringify(lines)}`
      if (!w.ok) {
        assert.equal(w.text, text, `${what}: refused, unchanged`)
        assert.ok(!MUST_KEEP.includes(token), `${what}: refused (${w.reason})`)
        keptTally.refused.push(`${token} → ${name ?? 'Auto'}: ${w.reason}`)
        continue
      }
      keptTally.writes += 1
      assert.equal(w.text, one([...expected(name ?? ''), '- A', '- B', '- C']), `${what}: the token is kept as written, only the layout token changes`)
    }
  }
}
assert.ok(keptTally.tokens >= 150 && keptTally.writes >= keptTally.tokens * 8, `non-layout tokens kept: ${JSON.stringify({ ...keptTally, refused: keptTally.refused.length })}`)

console.log(`plain-view-menu-verbs: ok (${choosable.length} layouts in ${tally.forms} written forms, ${tally.explicit} of them layout=…, ${tally.alias} aliases and option forms; ${tally.chosen} choices and ${tally.cleared} clears verified against the compiler; ${tally.cannotTake} refused as cannot-take; ${keptTally.tokens} registered non-layout tokens kept through ${keptTally.writes} writes, ${keptTally.refused.length} refused unchanged)`)

// ── The layout a slide is DRAWN in (third review round) ───────────────────────────────────────
// The truth is the real compiler's final layout. The verbs answer ok only when the compiled slide
// is the chosen layout; the margin names the layout the slide is drawn in.
{
  const { adaptMarkdownOutlineV2: realCompile } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
  const { lexMarkdownBlocksWith: lexCore } = await import('../compiler/scripts/lib/03-markdown-lexer-core.mjs')
  const verbs = await import('../src/shared/layout-verbs.ts')
  const naming = await import('../src/shared/slide-authored-layout.ts')
  const { marginLabels: labelsOf } = await import('../src/shared/plain-view-margin.ts')
  const { LAYOUTS: ALL } = await import('../src/shared/layout-registry/entries.ts')
  const compiledAt = (text, line) => realCompile(text, 'T', {}).slides.find((slide) => slide.sourceLine === line)
  const labelOn = (text, line) => labelsOf(null, text).find((label) => label.line === line)?.layoutLabel
  const listStyle = (entry) => entry.resolvesTo?.key === 'liststyle'
  const drawnAs = (row, entry) => Boolean(row) && (listStyle(entry)
    ? row.layout === 'list' && row.blocks.some((block) => block.type === 'feature-list' && block.liststyle === String(entry.resolvesTo.value))
    : row.layout === naming.layoutDecisionOfEntry(entry)?.layout)
  const HEAD = '# T\n\n## S\n\n### A\n'
  const KINDS = {
    'paragraph only': HEAD + 'A paragraph.\n',
    list: HEAD + '- one\n- two\n',
    'image only': HEAD + '![x](a.png)\n',
    'chart only': HEAD + '{chart=bar}\n- A: 1\n- B: 2\n',
    'heading with child headings': HEAD + '\n#### One\n- a\n\n#### Two\n- b\n'
  }
  // Review finding 1: a list style on a slide with no list is refused, nothing written.
  for (const [kind, layout] of [['paragraph only', 'iconlist'], ['paragraph only', 'numbered'], ['image only', 'iconlist'], ['image only', 'numbered']]) {
    const before = KINDS[kind]
    const w = verbs.chooseLayout(before, { headingLine: 5 }, layout)
    assert.equal(w.ok, false, `${layout} on a slide with ${kind}: refused`)
    assert.equal(w.reason, 'cannot-take', `${layout} on ${kind}: the content cannot take it`)
    assert.equal(w.text, before, `${layout} on ${kind}: nothing written`)
    assert.equal(labelOn(before, 5), 'Auto')
    // Written by hand, the margin names what the slide is drawn in, not the list style.
    const byHand = before.replace('### A\n', `### A\n{${layout}}\n`)
    assert.equal(labelOn(byHand, 5), kind === 'paragraph only' ? 'Statement' : 'Image', `{${layout}} over ${kind}: the margin names the drawn layout`)
    assert.equal(compiledAt(byHand, 5).layout, kind === 'paragraph only' ? 'statement' : 'media')
  }
  // Review finding 2: {cards} over charts only is drawn, and named, as a chart.
  const cardsOverChart = HEAD + '{cards}\n\n{chart=bar}\n- A: 1\n- B: 2\n'
  assert.equal(compiledAt(cardsOverChart, 5).layout, 'chart')
  assert.equal(labelOn(cardsOverChart, 5), 'Chart', 'a slide of charts only is named Chart under {cards}')
  assert.equal(labelsOf(realCompile(cardsOverChart, 'T', {}).slides, cardsOverChart).find((label) => label.line === 5)?.layoutLabel, 'Chart', 'and the same on a compiled row')
  // Every settable layout on every kind of content: ok exactly when the real compiler draws it.
  let pairs = 0, oks = 0
  for (const entry of ALL.filter(naming.isSettableLayout)) {
    for (const [kind, before] of Object.entries(KINDS)) {
      const w = verbs.chooseLayout(before, { headingLine: 5 }, entry.name)
      pairs += 1
      if (!w.ok) {
        assert.equal(w.text, before, `${entry.name} on ${kind}: refused, nothing written`)
        // Refused: writing the entry's trigger as the picker does would not have been drawn as it either
        // (or the content cannot take it, which the picker says too).
        let would = null
        try { would = verbs.setLayout(before, { headingLine: 5 }, entry.name).outline } catch { /* cannot-take */ }
        if (would !== null) assert.equal(drawnAs(compiledAt(would, 5), entry), false, `${entry.name} on ${kind}: refused although the compiler would draw it`)
        continue
      }
      oks += 1
      assert.ok(drawnAs(compiledAt(w.text, 5), entry), `${entry.name} on ${kind}: ok, and the compiled slide is ${compiledAt(w.text, 5)?.layout}`)
      assert.equal(labelOn(w.text, 5), entry.label, `${entry.name} on ${kind}: the margin names it`)
    }
  }
  assert.ok(oks > 50 && pairs - oks > 50, `layouts × kinds: ${oks} ok of ${pairs}`)
  // The lexer's list rows (review finding 3). A bullet holding only U+2028 / U+2029 under a list is
  // the start of a paragraph, as it was at 1cacbd25; a row with a carriage return in it, which hung
  // that compiler, is a row.
  const lexed = (rows) => JSON.parse(JSON.stringify(lexCore(rows, () => null)))
  for (const separator of [' ', ' ']) {
    assert.deepEqual(lexed(['- A', `- ${separator}`, 'Following text']), [
      { type: 'list', ordered: false, items: ['A'], children: [[]] }, { type: 'paragraph', text: '- Following text' }
    ], 'a separator-only bullet under a list starts a paragraph (as before)')
    assert.deepEqual(lexed([`- ${separator}`, 'Following text']), [{ type: 'paragraph', text: '- Following text' }], 'and alone too (as before)')
  }
  assert.deepEqual(lexed(['- A', '- \r', 'Following text']), [
    { type: 'list', ordered: false, items: ['A'], children: [[]] }, { type: 'paragraph', text: '- Following text' }
  ], 'a carriage-return-only bullet under a list starts a paragraph (as before)')
  assert.deepEqual(lexed(['- A\r', '- B']), [{ type: 'list', ordered: false, items: ['A', 'B'], children: [[], []] }], 'a row ending in a lone carriage return is a row (the old compiler hung)')
  assert.deepEqual(lexed(['- A B', 'next']), [{ type: 'list', ordered: false, items: ['A B'], children: [[]] }, { type: 'paragraph', text: 'next' }], 'a row with a line separator inside is a row (the old compiler hung)')
  console.log(`  the layout a slide is drawn in: ${oks} ok of ${pairs} layout × content pairs, each checked against the real compiler; lexer rows`)
}
if (process.argv.includes('--refused')) console.log([...new Set(keptTally.refused)].join('\n'))
