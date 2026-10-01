// Gate: one slide id, everywhere (architecture ruling, 2026-09-30). A slide's id is the LAST id in its
// Trigger block (the heading's own id wins outright), and every reader and writer resolves it through
// compiler/scripts/lib/slide-id.mjs:
//   1. the slide ledger (extractIdSlides)          4. the layout verbs (setLayout / setLayoutOption)
//   2. the compiler tree parser (parseOutlineTree)  5. the editor's merge (logicalTriggerBlockAfterHeading)
//   3. readOutlineSlides / findSlide                6. the main-process merge (mergeTriggerAtLine)
// Invariant: all six agree, and a merge never changes the id the ledger resolved before it. The ids a
// merge sets aside are reported through the warning register, never dropped silently.
import { strict as assert } from 'node:assert'
import { extractIdSlides } from '../compiler/scripts/lib/13-slide-ledger.mjs'
import { parseOutlineTree } from '../compiler/scripts/lib/14-outline-tree.mjs'
import { mergeTriggerAtLine } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { formatWarning } from '../compiler/scripts/lib/warning-registry.mjs'
import { findSlide, readOutlineSlides } from '../src/shared/feedback-accept.ts'
import { setLayout, setLayoutOption } from '../src/shared/layout-verbs.ts'
import { logicalTriggerBlockAfterHeading } from '../src/shared/trigger-line.ts'

const CASES = [
  {
    name: 'two Trigger lines, {id=a1} then {id=a2}',
    outline: '---\ntitle: T\n---\n\n### Five things\n{id=a1}\n{id=a2}\n\n- one\n- two\n- three\n',
    id: 'a2',
    warning: 'duplicate-slide-id-merged:kept a2, dropped a1 (Five things)'
  },
  {
    name: 'a fresh Trigger line inserted above the original',
    outline: '### Five things\n{cards}{id=a1}\n{icons} {id=a2}\n\n- one\n- two\n- three\n',
    id: 'a2',
    warning: 'duplicate-slide-id-merged:kept a2, dropped a1 (Five things)'
  },
  {
    name: 'a heading-borne id wins outright',
    outline: '### Five things {id=h1}\n{id=a1}\n{id=a2}\n\n- one\n- two\n- three\n',
    id: 'h1',
    warning: 'duplicate-slide-id-merged:kept h1, dropped a1, a2 (Five things)'
  }
]

const headingIndex = (outline) => outline.split('\n').findIndex((line) => /^#{2,6}\s/.test(line))
const ledgerId = (outline) => extractIdSlides(outline).map((slide) => slide.id)

for (const { name, outline, id, warning } of CASES) {
  const lines = outline.split('\n')
  const heading = headingIndex(outline)

  // 1. The ledger.
  assert.deepEqual(ledgerId(outline), [id], `${name}: the ledger resolves ${id}`)
  // 2. The tree parser, and the warning register hears about the other ids.
  const tree = parseOutlineTree(outline)
  const node = tree.root.children[0].children?.[0] ?? tree.root.children[0]
  assert.equal(node.id, id, `${name}: the tree parser resolves ${id}`)
  assert.equal(node.attrs.id, id, `${name}: the tree's attrs carry the same id`)
  assert(tree.warnings.includes(warning), `${name}: the tree reports ${warning} (got ${JSON.stringify(tree.warnings)})`)
  assert(!node.contentLines.some((line) => /\{id=/.test(line)), `${name}: no Trigger line is left as content`)
  // 3. readOutlineSlides / findSlide.
  const read = readOutlineSlides(outline)
  assert.deepEqual(read.slides.map((slide) => slide.id), [id], `${name}: readOutlineSlides reads ${id}`)
  assert.equal(findSlide(read, id)?.id, id, `${name}: findSlide finds the slide by ${id}`)
  for (const other of ['a1', 'a2', 'h1'].filter((candidate) => candidate !== id)) {
    assert.equal(findSlide(read, other), null, `${name}: findSlide does not answer to the set-aside id ${other}`)
  }
  // 4. The layout verbs: keep the resolved id, never rename the slide, report the merge.
  const set = setLayout(outline, id, 'cards')
  assert.deepEqual(ledgerId(set.outline), [id], `${name}: setLayout keeps ${id}`)
  assert.deepEqual(set.warnings, [warning], `${name}: setLayout reports the merge`)
  assert.equal(setLayout(set.outline, id, 'cards').warnings.length, 0, `${name}: once merged, nothing more to report`)
  const option = setLayoutOption(outline, id, 'font-body', 'font-body=l')
  assert.deepEqual(ledgerId(option.outline), [id], `${name}: setLayoutOption keeps ${id}`)
  assert.deepEqual(option.warnings, [warning], `${name}: setLayoutOption reports the merge`)
  // 5. The editor's merge (↵, the Inspector, the picker all write its line).
  const block = logicalTriggerBlockAfterHeading(lines, heading)
  assert.deepEqual(block.warnings, [warning], `${name}: the editor's merge reports the merge`)
  const merged = [...lines]
  merged.splice(block.start, block.end - block.start, block.line)
  assert.deepEqual(ledgerId(merged.join('\n')), [id], `${name}: the editor's merge keeps ${id}`)
  // 6. The main-process merge.
  const warnings = []
  const main = mergeTriggerAtLine(outline, heading + 2, '{font-body=l}', '', { warnings })
  assert.deepEqual(ledgerId(main), [id], `${name}: mergeTriggerAtLine keeps ${id}`)
  assert.deepEqual(warnings, [warning], `${name}: mergeTriggerAtLine reports through the register, not console.warn`)
  // The register's words, never a modal.
  assert.match(formatWarning(warning), /A slide carried several ids: kept \S+, dropped .+ \(Five things\)\./)
}

// A blank line between the two Trigger lines: still one prelude, still the last id.
{
  const outline = '### S\n{id=a1}\n\n{id=a2}\n\n- x\n'
  assert.deepEqual(ledgerId(outline), ['a2'])
  assert.equal(parseOutlineTree(outline).root.children[0].id, 'a2')
  assert.deepEqual(readOutlineSlides(outline).slides.map((slide) => slide.id), ['a2'])
  const block = logicalTriggerBlockAfterHeading(outline.split('\n'), 0)
  assert.equal(block.line, '', 'the first block\'s id is not the slide\'s: it goes')
  const set = setLayout(outline, 'a2', 'cards')
  assert.deepEqual(ledgerId(set.outline), ['a2'], 'the verb keeps the slide\'s id on a blank-separated line')
  assert.deepEqual(ledgerId(mergeTriggerAtLine(outline, 2, '{cards}', '', { warnings: [] })), ['a2'])
}

// One id, nothing to report anywhere.
{
  const outline = '### S\n{cards}{id=a1}\n\n- x\n'
  assert.deepEqual(parseOutlineTree(outline).warnings, [])
  assert.deepEqual(logicalTriggerBlockAfterHeading(outline.split('\n'), 0).warnings, [])
  const warnings = []
  mergeTriggerAtLine(outline, 2, '{icons}', '', { warnings })
  assert.deepEqual(warnings, [])
}

// setSlideId's own write (an incoming id) replaces the block's ids by design and reports nothing.
{
  const warnings = []
  const out = mergeTriggerAtLine('### S\n{id=a1}\n{id=a2}\n', 2, '{id=z9}', '', { warnings })
  assert.deepEqual(ledgerId(out), ['z9'])
  assert.deepEqual(warnings, [])
}

// The tree's Trigger block ends at the first blank line, as the editor's does (review S1/S2). Past a
// blank, a `{…}` line is content — a block-scoped chart, a `{prework}` marker — never slide attrs; an
// id-only line there is still the slide's id (the ledger's window) and never content.
{
  const chart = parseOutlineTree('### Block-scoped bar chart\n{id=bc1}\n\n{chart=bar}\n\n- Alpha: 40\n- Beta: 60\n')
  const node = chart.root.children[0]
  assert.equal(node.id, 'bc1')
  assert.equal(node.attrs.chart, undefined, 'a blank-separated chart token is not folded into the slide')
  assert(node.contentLines.includes('{chart=bar}'), 'it stays content, the chart object\'s token')
  const prework = parseOutlineTree('## One\n{id=a}\n\n{prework}\n').root.children[0]
  assert.equal(prework.attrs.prework, undefined, 'a blank-separated {prework} is not the section token')
  const idAfterBlank = parseOutlineTree('### S\n{cards}{id=new1}\n\n{id=orig1}\n\n- x\n').root.children[0]
  assert.equal(idAfterBlank.id, 'orig1', 'the resolver still finds an id-only line past a blank')
  assert(!idAfterBlank.contentLines.some((line) => /\{id=/.test(line)), 'and the id-only line is not content')
  assert.deepEqual(ledgerId('### S\n{cards}{id=new1}\n\n{id=orig1}\n\n- x\n'), ['orig1'])
}

// ⌘↵ (setLayout withStarterText) puts the starter text below the whole prelude, so an id-only line past
// a blank stays the slide's id instead of turning into content under the starter text (review S3).
{
  const outline = '## Title\n{cards}{id=new1}\n\n{id=orig1}\n'
  const out = setLayout(outline, 'orig1', 'statement', [], true)
  assert.deepEqual(ledgerId(out.outline), ['orig1'], `the slide keeps orig1 (got ${JSON.stringify(out.outline)})`)
  const lines = out.outline.split('\n')
  assert(lines.indexOf('{id=orig1}') >= 0 && lines.indexOf('{id=orig1}') < lines.findIndex((line, index) => index > 1 && line.trim() && !line.startsWith('{')),
    'the id line sits above the starter body')
}

// Two ids in one group line: the resolver keeps the first, and that is the only thing the author hears
// (review S5) — no trigger-conflict for the id alongside the merge warning.
{
  const tree = parseOutlineTree('### Five things\n{id=a1}{id=a2}\n\n- x\n')
  assert.equal(tree.root.children[0].id, 'a1')
  assert(!tree.warnings.some((warning) => warning.startsWith('trigger-conflict:id:')), `no id trigger-conflict (got ${JSON.stringify(tree.warnings)})`)
  assert(tree.warnings.includes('duplicate-slide-id-merged:kept a1, dropped a2 (Five things)'))
}
// An id inside a many-token group is invisible to the resolver, so its conflict is still reported.
assert(parseOutlineTree('### S\n{id=x1 layout=statement}{id=x2}\n').warnings.includes('trigger-conflict:id:x1→x2'))

console.log('ok: one slide id across the ledger, tree parser, readOutlineSlides/findSlide, layout verbs and both merge writers')
