import { strict as assert } from 'node:assert'
import {
  applyLayoutSelection, caretLineAfterTriggerBlock, commitOptionSelection, groupHasSelection, headingHasChildSlides,
  logicalTriggerBlockAfterHeading, meaningForToken, parseTriggerGroups, selectionForGroup
} from '../src/shared/trigger-line.ts'
import { GLOBAL_OPTION_GROUPS, LAYOUTS } from '../src/shared/layout-registry/entries.ts'

const source = '### Example {statement} {id=abc-123 tags="alpha, beta"} {from=source clonedFrom=original mystery=x}'
assert.equal(parseTriggerGroups(source).map((token) => token.raw).join('|'), 'statement|id=abc-123|tags=alpha, beta|from=source|clonedFrom=original|mystery=x')
assert.equal(
  applyLayoutSelection(source, { layout: 'quote', modifiers: ['reveal'], removeModifiers: ['statement'] }),
  '### Example {quote} {id=abc-123 tags="alpha, beta"} {from=source clonedFrom=original mystery=x} {reveal}'
)

assert.deepEqual(
  logicalTriggerBlockAfterHeading([
    '### Not all Agents are Agents',
    '{sidebar} {id=hnwcx}',
    '{layout=media} {id=3plcu}',
    '',
    'Body'
  ], 0),
  {
    start: 1,
    end: 3,
    line: '{sidebar}{layout=media}{id=3plcu}',
    warnings: ['duplicate-slide-id-merged:3plcu']
  },
  'consecutive Trigger-only lines form one ordered block and keep the final id'
)

assert.equal(headingHasChildSlides([
  '### Parent', '```md', '#### Example only', '```', '### Next'
], 0), false, 'fenced heading-shaped content is not a child slide')
assert.equal(headingHasChildSlides([
  '### Parent', '<!--', '#### Hidden child', '-->', '### Next'
], 0), false, 'comment-hidden headings are not child slides')
assert.equal(headingHasChildSlides([
  '### Parent', '', '#### Real child', '', '### Next'
], 0), true, 'a structural deeper heading is a child slide')

assert.deepEqual(
  logicalTriggerBlockAfterHeading([
    '### Final question - How much are you willing to invest in AI-assisted research?',
    '{iconlist}',
    '{id=uyee5} {split=50}',
    '',
    'Body'
  ], 0),
  {
    start: 1,
    end: 3,
    line: '{iconlist}{id=uyee5}{split=50}',
    warnings: []
  },
  'a bare modifier above an id-bearing Trigger line is one logical block'
)

// Dominik ruling, 2026-07-29: land on the existing first body line; create one only when absent.
// Blank body line already present → land on it, insert nothing.
assert.deepEqual(caretLineAfterTriggerBlock(['### T', '{statement}', '', 'Body'], 0), { targetLine: 2, insertBlankAt: null })
// Next slide follows immediately → open a fresh line between.
assert.deepEqual(caretLineAfterTriggerBlock(['### T', '{statement}', '### Next'], 0), { targetLine: 2, insertBlankAt: 2 })
// Trigger block at EOF → open a fresh line at the end.
assert.deepEqual(caretLineAfterTriggerBlock(['### T', '{statement}'], 0), { targetLine: 2, insertBlankAt: 2 })
// Content directly after the block → land on that existing body line without changing bytes.
assert.deepEqual(caretLineAfterTriggerBlock(['### T', '{statement}', 'Body'], 0), { targetLine: 2, insertBlankAt: null })
// Blank-separated trigger line (the tolerated read) still counts as the block.
assert.deepEqual(caretLineAfterTriggerBlock(['### T', '', '{statement}', 'Body'], 0), { targetLine: 3, insertBlankAt: null })
// No trigger line → null (default Enter behaviour).
assert.equal(caretLineAfterTriggerBlock(['### T', 'Body'], 0), null)

// Layout selection replaces every authored layout word, not only the first.
assert.equal(
  applyLayoutSelection('{statement}{quote}', { layout: 'cards', modifiers: [], removeModifiers: [] }),
  '{cards}'
)
assert.equal(
  applyLayoutSelection('{statement} {reveal} {quote}', { layout: 'cards', modifiers: [], removeModifiers: [] }),
  '{cards} {reveal}'
)
// Explicit layout= form counts as a layout word too.
assert.equal(
  applyLayoutSelection('{layout=statement}{quote}', { layout: 'cards', modifiers: [], removeModifiers: [] }),
  '{cards}'
)
// System tokens survive untouched.
assert.equal(
  applyLayoutSelection('{id=abc123}{statement}{quote}', { layout: 'cards', modifiers: [], removeModifiers: [] }),
  '{id=abc123}{cards}'
)

const spaced = '### Example  {statement, numbered}   {id=a1} tail'
assert.equal(applyLayoutSelection(spaced, { layout: 'quote', modifiers: [], removeModifiers: ['numbered'] }), spaced)

const triggerLine = '{statement}  {id=a1 tags=x} {unknown=verbatim}'
assert.equal(
  applyLayoutSelection(triggerLine, { layout: 'quote', modifiers: ['focus'], removeModifiers: [] }),
  '{quote}  {id=a1 tags=x} {unknown=verbatim} {focus}'
)

const contrastVariant = LAYOUTS.find((entry) => entry.name === 'contrast').options.find((group) => group.key === 'variant')
assert.equal(commitOptionSelection('{contrast=cards}', contrastVariant, 'contrast=rows'), '{contrast=rows}')
assert.equal(selectionForGroup('{contrast=cards}', contrastVariant), 'contrast=cards')

const fencedMermaid = LAYOUTS.find((entry) => entry.name === 'mermaid')
const originalMermaidKind = fencedMermaid.kind
try {
  fencedMermaid.kind = 'layout'
  assert.deepEqual(
    meaningForToken('mermaid'),
    [{ key: 'mermaid', value: true }],
    'a fenced registry entry never becomes a bare Trigger-line layout if its kind changes later'
  )
} finally {
  fencedMermaid.kind = originalMermaidKind
}

// T28 defect pair (fixed 2026-09-21): a list-style commit must drop the {iconlist=…} treatment
// token its commit orphaned — invisible in the Inspector while it still decides the render — and
// leave no trailing space, because the line is written byte-for-byte back into the file.
const listEntry = LAYOUTS.find((entry) => entry.name === 'list')
const listStyle = listEntry.options.find((group) => group.key === 'list-style')
const treatment = GLOBAL_OPTION_GROUPS.find((group) => group.key === 'iconlist-variant')
let reportedLine = '{id=vjjb9} {list} {iconlist}'
reportedLine = commitOptionSelection(reportedLine, treatment, 'iconlist=list')
assert.equal(reportedLine, '{id=vjjb9} {list}{iconlist=list} {iconlist}')
reportedLine = commitOptionSelection(reportedLine, listStyle, 'numbered')
assert.equal(reportedLine, '{id=vjjb9} {list}{numbered}',
  'the Numbered commit drops the orphaned treatment token and leaves no trailing space')
assert.equal(selectionForGroup(reportedLine, listStyle), 'numbered')
assert.equal(selectionForGroup(reportedLine, treatment), '',
  'the orphaned treatment no longer reads back from the line')
reportedLine = commitOptionSelection(reportedLine, listStyle, '')
assert.equal(reportedLine, '{id=vjjb9} {list}', 'the Plain commit clears Numbered; the orphan stays gone')

let iconsForced = '{id=vjjb9} {list} {iconlist} {icons=top}'
iconsForced = commitOptionSelection(iconsForced, treatment, 'iconlist=list')
iconsForced = commitOptionSelection(iconsForced, listStyle, 'numbered')
assert.equal(iconsForced, '{id=vjjb9} {list}{numbered}{iconlist=list} {icons=top}',
  '{icons=top} keeps the treatment group applicable, so the token survives a list-style commit')

// The line the shipped bug actually saved into Dominik's file: the stale token arrives with the
// trailing space the old commit left behind. Cleaning it must take that space with it.
const savedBrokenLine = '{id=vjjb9} {list}{numbered}{iconlist=list} '
assert.equal(commitOptionSelection(savedBrokenLine, listStyle, ''), '{id=vjjb9} {list}',
  'committing Plain on the saved broken line clears the stale token and its trailing space')

// ── T32 (Decision 1A): {plainlist} is a registered alt token of the Plain value ─────────
// The deck's List style choice is 'icons', so Plain must be able to WRITE {plainlist}; the row
// must READ it back as Plain; and a rival style commit must sweep it with the rest of the group.
assert.equal(
  selectionForGroup('{id=x} {list}{plainlist}', listStyle), '',
  'the {plainlist} override reads back as the Plain value'
)
assert.equal(
  groupHasSelection('{id=x} {list}', listStyle), false,
  'a bare list carries no authored List style selection'
)
assert.equal(
  groupHasSelection('{id=x} {list}{plainlist}', listStyle), true,
  'the {plainlist} override counts as an authored selection, not as following the deck'
)
assert.equal(
  commitOptionSelection('{id=x} {list}', listStyle, 'plainlist'), '{id=x} {list}{plainlist}',
  'the registered alt token commits exactly the {plainlist} override'
)
assert.equal(
  commitOptionSelection('{id=x} {list}{plainlist}', listStyle, 'iconlist'), '{id=x} {list}{iconlist}',
  'a rival style commit removes the {plainlist} override with the rest of the group'
)
assert.equal(
  commitOptionSelection('{id=x} {list}{plainlist}', listStyle, ''), '{id=x} {list}',
  'committing the empty Plain token removes the {plainlist} override (the slide follows the deck again)'
)
assert.equal(
  commitOptionSelection('{id=x} {list}{plainlist}', listStyle, 'plainlist'), '{id=x} {list}{plainlist}',
  're-committing {plainlist} keeps the line byte-identical'
)
assert.equal(
  commitOptionSelection('{id=x} {list} {plainlist}', listStyle, 'plainlist'), '{id=x} {list} {plainlist}',
  're-committing {plainlist} keeps its authored position and spacing'
)
assert.equal(
  commitOptionSelection('{id=x} {list}', listStyle, ''), '{id=x} {list}',
  'committing Plain on a bare list still writes nothing'
)
const fontBodyGroup = GLOBAL_OPTION_GROUPS.find((group) => group.key === 'font-body')
assert.equal(
  commitOptionSelection('{id=x} {list}{plainlist}{iconlist=list}', fontBodyGroup, 'font-body=l'),
  '{id=x} {list}{font-body=l}{plainlist}',
  'with {plainlist} authored the treatment group no longer applies, so its token is swept by a rival commit'
)

// T32 follow-up: the sweep reads a caller-supplied selection for a group the line does not write.
const deckIcons = { unwrittenSelections: () => ({ 'list-style': 'iconlist' }) }
assert.equal(
  commitOptionSelection('{id=x} {list}{iconlist=list}', fontBodyGroup, 'font-body=l', deckIcons),
  '{id=x} {list}{font-body=l}{iconlist=list}',
  'with the deck deciding Icons, the treatment token is relevant and survives an unrelated commit'
)
assert.equal(
  commitOptionSelection('{id=x} {list}{iconlist=list}', fontBodyGroup, 'font-body=l'),
  '{id=x} {list}{font-body=l}',
  'without that context the same line still sweeps the orphaned treatment (09-21 behaviour)'
)
assert.equal(
  commitOptionSelection('{id=x} {list}{iconlist=list}', listStyle, 'plainlist', deckIcons),
  '{id=x} {list}{plainlist}',
  'an authored {plainlist} outranks the deck’s choice, so the treatment is swept'
)
assert.equal(
  commitOptionSelection('{id=x} {list}{iconlist=list}{icons=off}', fontBodyGroup, 'font-body=l', {
    unwrittenSelections: (line) => ({ 'list-style': line.includes('{icons=off}') ? '' : 'iconlist' })
  }),
  '{id=x} {list}{font-body=l}{icons=off}',
  'the context is asked about the line being produced'
)

console.log('trigger-line: parsing and byte-preserving selection checks passed')
