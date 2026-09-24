// =============================================================================
// Option applicability (ADR-0020 §5 — "the Inspector shows only relevant options")
//
// Dominik, 2026-09-11: "the panel options are only there for relevant things and exist for
// everything." Both halves are gated here:
//
//   (a) every GLOBAL option group declares `appliesTo` — applicability is registry data, never a
//       group-name `if` inside options.ts;
//   (b) every kind:'layout' entry resolves a NON-EMPTY, relevant group set;
//   (c) a group never resolves for a layout where it is meaningless;
//   (d) the two rules that predate the declaration still behave EXACTLY as they did (poll limits
//       by poll type; Container mode on a `##` or a heading with children);
//   (e) `title=compact` is retired as a choice — gone from the picker, still accepted by the
//       compiler dictionary, and answered with a hint.
//
// The Media-placement half of (c) is proved against the compiler's ONE eligibility decision
// (`slotCompositionFor`, ADR-0023 §3) rather than a hand-copied layout list.
// =============================================================================
import { strict as assert } from 'node:assert'
import { GLOBAL_OPTION_GROUPS, LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import { groupApplies, optionGroupsForSlide } from '../src/shared/layout-registry/options.ts'
import {
  inlineOptionPickerStep,
  optionGroupsForPickerEntry
} from '../src/renderer/src/components/layoutPickerModel.ts'
import { slotCompositionFor } from '../compiler/scripts/lib/slot-composition.mjs'
import { parseHeadingAttrs } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { WARNING_REGISTRY } from '../compiler/scripts/lib/warning-registry.mjs'

const layoutEntries = LAYOUTS.filter((entry) => entry.kind === 'layout')
const groupsFor = (layoutName, extra = {}) =>
  optionGroupsForSlide({ layoutName, headingLevel: 3, hasChildren: false, ...extra })
    .map(({ group }) => group.key)

// -----------------------------------------------------------------------------
// (a) Applicability is declared, not decided.
// -----------------------------------------------------------------------------
const undeclared = GLOBAL_OPTION_GROUPS
  .filter((group) => typeof group.appliesTo !== 'object' || group.appliesTo === null)
  .map((group) => group.key)
assert.deepEqual(undeclared, [], `every global option group declares appliesTo: missing ${undeclared.join(', ')}`)

const KNOWN_FACETS = new Set([
  'kinds', 'layouts', 'excludeLayouts', 'titleRegimes', 'headingLevels',
  'requiresChildren', 'requiresTokens', 'anyOf'
])
const knownLayoutNames = new Set(LAYOUTS.map((entry) => entry.name))
for (const group of GLOBAL_OPTION_GROUPS) {
  for (const facet of Object.keys(group.appliesTo)) {
    assert(KNOWN_FACETS.has(facet), `${group.key}: unknown appliesTo facet "${facet}"`)
  }
  for (const name of [...(group.appliesTo.layouts ?? []), ...(group.appliesTo.excludeLayouts ?? [])]) {
    assert(knownLayoutNames.has(name), `${group.key}: appliesTo names an unregistered layout "${name}"`)
  }
}

// options.ts is an interpreter: no group key may be named in its logic.
const optionsSource = await import('node:fs').then(({ readFileSync }) =>
  readFileSync(new URL('../src/shared/layout-registry/options.ts', import.meta.url), 'utf8'))
const decisionCode = optionsSource.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n')
for (const group of GLOBAL_OPTION_GROUPS) {
  assert.equal(decisionCode.includes(`'${group.key}'`), false,
    `options.ts must not decide for "${group.key}" by name — declare the rule in the registry`)
}

// -----------------------------------------------------------------------------
// (b) Options exist for EVERYTHING: every layout resolves a non-empty, relevant set.
// -----------------------------------------------------------------------------
const resolved = new Map()
for (const entry of layoutEntries) {
  const headingLevel = entry.titleRegime === 'own' && entry.name === 'section' ? 2 : 3
  const keys = groupsFor(entry.name, { headingLevel })
  resolved.set(entry.name, keys)
  assert(keys.length > 0, `${entry.name}: resolves no option group at all`)
  const ownGroups = (entry.options ?? []).map((group) => group.key)
  if (entry.titleRegime === 'own') {
    // A structural poster composes its own stage (ADR-0015 30/70), so it offers no title choice —
    // but it is still a slide: paper and type must be choosable on it.
    for (const key of ['background', 'font-title', 'font-body']) {
      assert(keys.includes(key), `${entry.name}: a structural poster still chooses its ${key}`)
    }
  } else {
    const titleGroups = keys.filter((key) => key === 'title-placement' || key === 'title-display')
    assert(
      titleGroups.length > 0 || ownGroups.some((key) => keys.includes(key)),
      `${entry.name}: resolves neither a title group nor any option of its own`
    )
  }
}

// -----------------------------------------------------------------------------
// (c) Nothing meaningless resolves.
// -----------------------------------------------------------------------------
const MEANINGLESS = [
  ['media-placement', 'chart', 'a chart body is one object; no copy for media to sit beside'],
  ['media-placement', 'mindmap', 'a diagram body is one object'],
  ['media-placement', 'image-grid', 'a wall of media has no copy column'],
  ['claim-style', 'table', 'a table renders no paragraph, so it renders no claim'],
  ['claim-style', 'barchart', 'a chart renders no paragraph'],
  ['claim-style', 'quote', 'the body IS the quotation (ADR-0023 §5), never a claim'],
  ['title-placement', 'section', 'a structural poster composes its whole stage'],
  ['title-placement', 'title', 'a structural poster composes its whole stage'],
  ['title-placement', 'quote', 'a hidden-regime layout has no placement to choose'],
  ['title-display', 'closing', 'a structural poster has no heading to quieten'],
  ['section-label', 'section', 'the divider IS the section marker'],
  ['poll-type', 'title', 'a title poster carries nothing to answer']
]
for (const [key, layoutName, why] of MEANINGLESS) {
  const headingLevel = layoutName === 'section' ? 2 : 3
  assert.equal(groupsFor(layoutName, { headingLevel }).includes(key), false,
    `${key} must not resolve on ${layoutName}: ${why}`)
}
assert.equal(groupsFor('statement').includes('container-mode'), false,
  'container-mode must not resolve on a ### slide without children')

// Media placement resolves wherever the compiler's ONE slot decision can compose (ADR-0023 §3).
const COPY_AND_MEDIA = [{ type: 'paragraph' }, { type: 'image' }]
const CARDS_AND_MEDIA = [{ type: 'cards' }, { type: 'image' }]
const slotComposes = (layoutName) =>
  slotCompositionFor({}, COPY_AND_MEDIA, layoutName).kind === 'beside'
  || slotCompositionFor({}, CARDS_AND_MEDIA, layoutName).kind === 'beside'
const slotLayouts = layoutEntries.filter((entry) => slotComposes(entry.name)).map((entry) => entry.name)
assert(slotLayouts.length >= 5, 'the slot alias set is still the five old triggers unified')
for (const name of slotLayouts) {
  assert(resolved.get(name).includes('media-placement'),
    `${name}: the compiler composes a media slot here, so Media placement must be offered`)
}
// …and the excluded layouts are exactly layouts the slot can never compose on by inference.
for (const [key, layoutName] of MEANINGLESS.filter(([key]) => key === 'media-placement')) {
  assert.equal(slotComposes(layoutName), false, `${layoutName}: ${key} exclusion contradicts slotCompositionFor`)
}
// HIDDEN IS NOT REMOVED. Withholding the control is a relevance judgement about the Inspector, not
// a capability the compiler loses: an author who writes {image=left} on a structured body still
// gets the slot, through slotCompositionFor's authored arm.
assert.equal(
  slotCompositionFor({ frameImageExplicit: true, frame: { image: 'left' } }, COPY_AND_MEDIA, 'chart').kind,
  'beside',
  'an authored {image=left} still composes on a chart — the group is hidden, the token is not retired'
)

// -----------------------------------------------------------------------------
// (d) The two legacy hard-coded behaviours, preserved exactly.
// -----------------------------------------------------------------------------
const pollGroup = (key) => GLOBAL_OPTION_GROUPS.find((group) => group.key === key)
const pollContext = (token) => ({
  layoutName: 'list', headingLevel: 3, hasChildren: false, selectedTokens: { 'poll-type': token }
})
assert.equal(groupApplies(pollGroup('pollselections'), pollContext('poll=multiple')), true,
  'multiple choice keeps its selection cap')
assert.equal(groupApplies(pollGroup('pollselections'), pollContext('poll=open')), false,
  'open response has no selection cap')
assert.equal(groupApplies(pollGroup('pollsubmissions'), pollContext('poll=open')), true,
  'open response keeps its submission allowance')
assert.equal(groupApplies(pollGroup('pollsubmissions'), pollContext('poll=multiple')), false,
  'multiple choice has no submission allowance')
assert.equal(groupApplies(pollGroup('pollselections'), pollContext('')), false,
  'a slide that is not a poll offers no poll limits')
// A candidate listing carries no authored selection yet, so the limits stay available to the
// Inspector's second pass — the two-stage filter that has always produced the poll controls.
assert(groupsFor('list').includes('pollselections'), 'poll limits stay candidates until a selection is known')
assert(groupsFor('list').includes('pollsubmissions'), 'poll limits stay candidates until a selection is known')

const containerMode = pollGroup('container-mode')
assert.equal(groupApplies(containerMode, { layoutName: 'statement', headingLevel: 2, hasChildren: false }), true,
  '## sections are containers by construction')
assert.equal(groupApplies(containerMode, { layoutName: 'statement', headingLevel: 3, hasChildren: true }), true,
  'a ### slide with #### children can sequence them')
assert.equal(groupApplies(containerMode, { layoutName: 'statement', headingLevel: 3, hasChildren: false }), false,
  'a leaf ### slide is not a container')
assert.equal(optionGroupsForSlide({ layoutName: 'contents', headingLevel: 3, hasChildren: false })[0].source, 'global',
  'container-only entry options stay hidden on content headings')
assert.equal(optionGroupsForSlide({ layoutName: 'contents', headingLevel: 2, hasChildren: false })[0].group.key, 'variant',
  'container entry options are exposed on section headings')

// A layout that adopts a global group as its own renders it once, from its own declaration.
const tableGroups = optionGroupsForSlide({ layoutName: 'table', headingLevel: 3, hasChildren: false })
assert.deepEqual(
  tableGroups.filter(({ group }) => group.key === 'media-placement').map(({ source }) => source),
  ['entry'],
  'table declares Media placement itself; the global copy must not render a second time'
)

// -----------------------------------------------------------------------------
// (d2) ONE resolver for all three choosing surfaces.
//
// The Inspector, the ⌘L picker and the inline `{` palette must agree because they ask the same
// function, not because three filters happen to match. `optionGroupsForPickerEntry` is the picker
// and palette's only door to relevance, so proving it is a projection of `optionGroupsForSlide`
// proves the surfaces cannot drift.
// -----------------------------------------------------------------------------
const contents = LAYOUTS.find((entry) => entry.name === 'contents')
assert.deepEqual(
  optionGroupsForPickerEntry(contents, '', { headingLevel: 3, hasChildren: false }).map(({ group }) => group.key),
  [],
  'the picker hides a container entry’s options on a leaf ### — the shared resolver says so'
)
assert.deepEqual(
  optionGroupsForPickerEntry(contents, '', { headingLevel: 2, hasChildren: false }).map(({ group }) => group.key),
  ['variant'],
  'the picker shows them on a ## section, exactly as the Inspector does'
)
for (const entry of LAYOUTS) {
  for (const headingLevel of [2, 3]) {
    const context = { headingLevel, hasChildren: false }
    const pickerKeys = optionGroupsForPickerEntry(entry, '', context).map(({ group }) => group.key)
    const resolverKeys = optionGroupsForSlide({ ...context, layoutName: entry.name })
      .filter(({ source, owner }) => source === 'entry' && owner?.name === entry.name)
      .map(({ group }) => group.key)
    assert.deepEqual(pickerKeys, resolverKeys,
      `${entry.name} @h${headingLevel}: the picker must project optionGroupsForSlide, never filter for itself`)
  }
}
// The inline `{` chain is the same door: its step is built from the picker rows.
const inlineOnLeaf = inlineOptionPickerStep(contents, '', '', { headingLevel: 3, hasChildren: false })
assert.equal(inlineOnLeaf, null, 'the inline { chain offers no container option step on a leaf ###')
const inlineOnSection = inlineOptionPickerStep(contents, '', '', { headingLevel: 2, hasChildren: false })
assert.equal(inlineOnSection?.group.key, 'variant', 'the inline { chain offers it on a ## section')

// -----------------------------------------------------------------------------
// (e) `title=compact` retired deliberately.
// -----------------------------------------------------------------------------
const everyGroup = [...GLOBAL_OPTION_GROUPS, ...LAYOUTS.flatMap((entry) => entry.options ?? [])]
const compactOffers = everyGroup
  .filter((group) => group.values.some((value) => value.token === 'title=compact'))
  .map((group) => group.key)
assert.deepEqual(compactOffers, [], 'title=compact is no longer a choosable value anywhere')
const titleDisplay = pollGroup('title-display')
assert(titleDisplay.dictionaryTokens?.includes('title=compact'),
  'title=compact stays a registered legacy alias so old decks still compile')
assert.equal(
  parseHeadingAttrs('{title=compact}').warnings.some((warning) => warning.startsWith('unknown-trigger:')),
  false,
  'the compiler dictionary still resolves the legacy token'
)
const retired = WARNING_REGISTRY.find((warning) => warning.id === 'retired-title-compact')
assert.equal(retired?.severity, 'hint', 'the retired treatment answers with a hint, never an error')
const source = [
  '---', 'title: Retired', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Fixtures', '', '### Compact heading', '{list}{title=compact}', '', '- One', '- Two', ''
].join('\n')
const model = await prepareSource('/tmp/option-applicability-probe.md', source, 'Retired')
assert(
  model.warnings.some((warning) => warning.startsWith('retired-title-compact:')),
  'compiling {title=compact} emits the retirement hint'
)

// -----------------------------------------------------------------------------
// Ticket 21 — the table's two row/column groups and the cards Icons option are offered exactly
// where their layout renders, and `{iconlist}` on a cards slide selects the Icons value.
// -----------------------------------------------------------------------------
for (const key of ['table-header', 'table-columns']) {
  assert(groupsFor('table').includes(key), `${key} is offered on a table slide`)
  assert.equal(groupsFor('list').includes(key), false, `${key} has nothing to switch on a list`)
}
assert(groupsFor('cards').includes('cards-icons'), 'the cards Icons option is offered on any cards slide')
assert.equal(groupsFor('list').includes('cards-icons'), false, 'a list keeps its own icon-list treatment instead')
const cardsIcons = LAYOUTS.find((entry) => entry.name === 'cards').options.find((group) => group.key === 'cards-icons')
assert(cardsIcons.dictionaryTokens.includes('iconlist'), '{iconlist} is registered as the accepted alias of the cards Icons value')
const { selectionForGroup } = await import('../src/shared/trigger-line.ts')
assert.equal(selectionForGroup('{cards}{iconlist}', cardsIcons), 'icons', '{iconlist} on a cards trigger line reads as the Icons value')
assert.equal(selectionForGroup('{cards}{icons}', cardsIcons), 'icons', '{icons} on a cards trigger line reads as the Icons value')
assert.equal(selectionForGroup('{cards}', cardsIcons), '', 'a bare {cards} has no icons selected')
const aliasModel = await prepareSource('/tmp/option-applicability-cards.md', [
  '---', 'title: Cards alias', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Fixtures', '', '### Cards via alias', '{cards}{iconlist}', '', '- Speed {icon=lucide:zap}', '- Craft {icon=lucide:wrench}', ''
].join('\n'), 'Cards alias')
assert(aliasModel.warnings.some((warning) => warning.startsWith('cards-iconlist-alias:')), 'compiling {iconlist} on a cards slide emits the alias hint')
assert.equal(WARNING_REGISTRY.find((warning) => warning.id === 'cards-iconlist-alias')?.severity, 'hint', 'the alias answers with a hint, never an error')

// -----------------------------------------------------------------------------
// T28 orphan sweep — the commit side reads the same declared relevance. `appliesToHoldsOnTokens`
// is the Trigger-line-decidable half of `appliesTo`: it must agree with groupApplies wherever the
// line itself can answer, and commitOptionSelection sweeps with it, so a commit drops tokens
// whose group the resulting line no longer satisfies.
// -----------------------------------------------------------------------------
const { commitOptionSelection } = await import('../src/shared/trigger-line.ts')
const { appliesToHoldsOnTokens, registryOptionGroups } = await import('../src/shared/layout-registry/options.ts')
const treatmentGroup = GLOBAL_OPTION_GROUPS.find((group) => group.key === 'iconlist-variant')
assert.equal(registryOptionGroups().filter((group) => group === treatmentGroup).length, 1,
  'the sweep iterates each declared group once, however many entries adopt it')
const listStyleGroup = LAYOUTS.find((entry) => entry.name === 'list').options.find((group) => group.key === 'list-style')
for (const listStyle of ['', 'iconlist']) {
  for (const iconLevel of ['', 'icons=top', 'icons=all', 'icons=off']) {
    const selectedTokens = { 'list-style': listStyle, 'icon-level': iconLevel }
    assert.equal(
      appliesToHoldsOnTokens(treatmentGroup, selectedTokens),
      groupApplies(treatmentGroup, { layoutName: 'list', headingLevel: 3, hasChildren: false, selectedTokens }),
      `iconlist-variant token-decidable relevance matches the registry rule (list-style=${listStyle}, icon-level=${iconLevel})`
    )
  }
}
assert.equal(
  commitOptionSelection('{id=vjjb9} {list}{iconlist=list}', listStyleGroup, 'numbered'),
  '{id=vjjb9} {list}{numbered}',
  'a list-style commit drops the iconlist token whose group the resulting line no longer satisfies'
)
assert.equal(
  commitOptionSelection('{id=vjjb9} {list}{iconlist=list}{icons=top}', listStyleGroup, 'numbered'),
  '{id=vjjb9} {list}{numbered}{iconlist=list}{icons=top}',
  'with {icons=top} the treatment group still applies and the token survives the commit'
)

// -----------------------------------------------------------------------------
// T32 (Decision 2A) — the Inspector's sections, at the options seam. `sectionedOptionGroups`
// orders what `optionGroupsForSlide` + `groupApplies` resolved: the slide's own layout first,
// then Title, Slide, Steps, Poll, empty sections dropped; a group that only applies because of
// another group's value nests directly under it, derived from `appliesTo.requiresTokens`.
// -----------------------------------------------------------------------------
const { sectionedOptionGroups } = await import('../src/shared/layout-registry/options.ts')
function sectionModelFor(layoutName, triggerLine, extra = {}) {
  const context = { layoutName, headingLevel: 3, hasChildren: false, ...extra }
  const candidates = optionGroupsForSlide(context)
  const selectedTokens = Object.fromEntries(candidates.map(({ group }) => [group.key, selectionForGroup(triggerLine, group)]))
  const applicable = candidates.filter(({ group }) => groupApplies(group, { ...context, selectedTokens }))
  const label = LAYOUTS.find((entry) => entry.name === layoutName)?.label
  return sectionedOptionGroups(applicable, label)
}
function sectionsFor(layoutName, triggerLine, extra = {}) {
  return sectionModelFor(layoutName, triggerLine, extra).map((section) => [
    section.heading,
    section.bindings.map((binding) => binding.nestedUnder ? `${binding.nestedUnder}>${binding.group.key}` : binding.group.key)
  ])
}
assert.deepEqual(sectionsFor('list', '{list}{iconlist}'), [
  ['List', ['list-style', 'list-style>iconlist-variant', 'icon-level']],
  ['Title', ['title-placement', 'title-display', 'font-title']],
  ['Slide', ['background', 'font-body', 'media-placement', 'section-label', 'claim-style']],
  ['Steps', ['arrival-mode', 'stepping']],
  ['Poll', ['poll-type']]
], 'an icon list: layout section first (an undeclared global, Claim style, falls into Slide) with the treatment under List style, then the fixed run in the drawn order')
assert.deepEqual(sectionsFor('list', '{list}')[0], ['List', ['list-style', 'icon-level']],
  'the treatment is not offered while the decided style is not Icons')
assert.deepEqual(sectionsFor('list', '{list}{icons=top}')[0],
  ['List', ['list-style', 'list-style>iconlist-variant', 'icon-level']],
  '{icons=top} switches the treatment on and it still nests under List style — the first group its rule reads')
assert.deepEqual(sectionsFor('list', '{list}{poll=multiple}').at(-1),
  ['Poll', ['poll-type', 'poll-type>poll-results', 'poll-type>pollselections']],
  'Poll results and the multiple-choice limit appear only on a poll, nested under Poll type')
assert.deepEqual(sectionsFor('list', '{list}{poll=rating}').at(-1),
  ['Poll', ['poll-type', 'poll-type>poll-skip', 'poll-type>poll-results']],
  'rating adds the skip rule under Poll type')
assert.deepEqual(sectionsFor(undefined, '', { headingLevel: 2 }).map(([heading]) => heading).includes('Slide'), true,
  'a plain ## still gets its Slide section')
assert.ok(
  sectionsFor(undefined, '', { headingLevel: 2 }).find(([heading]) => heading === 'Slide')[1].includes('container-mode'),
  'Container mode renders in Slide on a ## section'
)
assert.deepEqual(
  sectionModelFor('list', '{list}{iconlist}').map((section) => [
    section.heading, section.bindings.map(({ group }) => group.sectionLabel ?? group.label)
  ]),
  [
    ['List', ['Style', 'Icon treatment', 'Icons on']],
    ['Title', ['Placement', 'Display', 'Size']],
    ['Slide', ['Background', 'Body size', 'Media', 'Section label', 'Claim style']],
    ['Steps', ['Arrival', 'Stepping']],
    ['Poll', ['Type']]
  ],
  'inside a section each group carries the label the sheet draws — no “List —” prefix, no repeated section name'
)
assert.deepEqual(
  sectionedOptionGroups([{ group: treatmentGroup, source: 'global' }], 'Cards').map((section) => [section.id, section.heading]),
  [['layout', 'Cards']],
  'a global group a modifier entry adopts (iconlist → treatment) belongs to the layout section even without its parent'
)
for (const entry of layoutEntries) {
  const sections = sectionModelFor(entry.name, entry.trigger)
  const order = ['layout', 'title', 'slide', 'steps', 'poll']
  const ids = sections.map((section) => section.id)
  assert.deepEqual(ids, order.filter((id) => ids.includes(id)), `${entry.name}: sections run in the fixed order`)
  if (entry.options?.length) {
    assert.deepEqual([sections[0].id, sections[0].heading], ['layout', entry.label], `${entry.name}: its own groups come first, under its label`)
  }
}

// -----------------------------------------------------------------------------
// Report the resolved set for every layout, so a relevance regression is readable in CI output.
// -----------------------------------------------------------------------------
for (const entry of layoutEntries) {
  console.log(`  ${entry.name.padEnd(16)} ${resolved.get(entry.name).join(' ')}`)
}
console.log(`option applicability: ${GLOBAL_OPTION_GROUPS.length} global groups declared, ${layoutEntries.length} layouts resolved.`)
