import { strict as assert } from 'node:assert'
import { parseHeadingAttrs } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { GLOBAL_OPTION_GROUPS, LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import {
  commitOptionSelection,
  parseTriggerLine,
  selectionForGroup
} from '../src/shared/trigger-line.ts'
import {
  groupApplies,
  optionGroupsForSlide,
  valuesForGroup
} from '../src/shared/layout-registry/options.ts'

const entriesWithOptions = LAYOUTS.filter((entry) => entry.options?.length)
const allGroups = [
  ...GLOBAL_OPTION_GROUPS,
  ...entriesWithOptions.flatMap((entry) => entry.options)
]

function assertScopeIntegrity(groups, scope) {
  assert.equal(new Set(groups.map((group) => group.key)).size, groups.length,
    `${scope}: option-group keys must be unique`)
  for (const group of groups) {
    assert.equal(group.values.filter((value) => value.token === '').length, 1,
      `${scope}/${group.key}: exactly one value must have the empty default token`)
  }
}

assertScopeIntegrity(GLOBAL_OPTION_GROUPS, 'global')
for (const entry of entriesWithOptions) assertScopeIntegrity(entry.options, entry.name)

for (const group of allGroups) {
  for (const value of group.values.filter((candidate) => candidate.token)) {
    const source = `{${value.token}}`
    const parsed = parseHeadingAttrs(source)
    assert.equal(parsed.warnings.some((warning) => warning.startsWith('unknown-trigger:')), false,
      `${group.key}/${value.token}: compiler dictionary must accept the option token`)
    assert.equal(parseTriggerLine(source).length, 1,
      `${group.key}/${value.token}: shared trigger parser must yield exactly one token`)
  }
}

const contrastGroup = LAYOUTS.find((entry) => entry.name === 'contrast').options[0]
assert.equal(
  commitOptionSelection('{id=abc}{contrast}{reveal}', contrastGroup, 'contrast=rows'),
  '{id=abc}{contrast}{contrast=rows}{reveal}',
  'setting a missing option inserts it directly after the layout token'
)
assert.equal(
  commitOptionSelection('{id=abc}{contrast}{contrast=tint}{reveal}', contrastGroup, 'contrast=rows'),
  '{id=abc}{contrast}{contrast=rows}{reveal}',
  'replacing an option removes the rival value before inserting the selection'
)
assert.equal(
  commitOptionSelection('{id=abc}{contrast}{contrast=tint}{reveal}', contrastGroup, ''),
  '{id=abc}{contrast}{reveal}',
  'clearing an option removes the authored group value'
)

const dirtyLine = '{id=abc}{contrast=tint}{reveal} stray text'
const dirtyFlipped = commitOptionSelection(dirtyLine, contrastGroup, 'contrast=flip')
assert.equal(dirtyFlipped, '{id=abc}{reveal} stray text {contrast=flip}',
  'variant replacement preserves id and stray bytes when no layout token anchors insertion')

const alreadyActive = '{id=abc}  {contrast}{contrast=ledger} {unknown=yes}'
assert.equal(commitOptionSelection(alreadyActive, contrastGroup, 'contrast=ledger'), alreadyActive,
  'committing the active option is byte-identically idempotent')

const arrivalGroup = GLOBAL_OPTION_GROUPS.find((group) => group.key === 'arrival-mode')
const once = commitOptionSelection('{contrast}', contrastGroup, 'contrast=rows')
const twice = commitOptionSelection(once, arrivalGroup, 'reveal')
assert.equal(twice, '{contrast}{reveal}{contrast=rows}',
  'sequential commits keep a stable layout-first option order')
assert.equal(commitOptionSelection(twice, contrastGroup, 'contrast=rows'), twice,
  'recommitting one of two selections does not reorder either group')

for (const group of allGroups) {
  const base = '{statement}'
  for (const value of group.values) {
    const rival = group.values.find((candidate) => candidate.token && candidate.token !== value.token)
    const startingLine = rival ? commitOptionSelection(base, group, rival.token) : base
    const committed = commitOptionSelection(startingLine, group, value.token)
    assert.equal(selectionForGroup(committed, group), value.token,
      `${group.key}/${value.token || 'default'}: selection must round-trip`)
  }
}

const contrastGroups = optionGroupsForSlide({ layoutName: 'contrast', headingLevel: 3, hasChildren: false })
assert.deepEqual(contrastGroups.map(({ group, source }) => [group.key, source]), [
  ['variant', 'entry'],
  ...GLOBAL_OPTION_GROUPS.filter((group) => group.key !== 'container-mode').map((group) => [group.key, 'global'])
])

const iconlistVariant = optionGroupsForSlide({ layoutName: 'iconlist', headingLevel: 3, hasChildren: false })[0].group
assert.equal(iconlistVariant.key, 'iconlist-variant')
assert.equal(iconlistVariant.preview, 'thumbs')
assert.deepEqual(iconlistVariant.values.map(({ token, label }) => [token, label]), [
  ['', 'Auto'],
  ['iconlist=boxes', 'Boxes'],
  ['iconlist=list', 'List']
], 'iconlist offers the count-rule Auto, the explicit card grid, and the plain rows')

// T28: iconlist-variant resolves THROUGH the list layout too (icons via {icons=top}/{icons=all}),
// gated by the declarative applicability seam — never a group-name if.
const iconlistVariantOnList = optionGroupsForSlide({ layoutName: 'list', headingLevel: 3, hasChildren: false })
  .find(({ group }) => group.key === 'iconlist-variant')
assert.ok(iconlistVariantOnList, 'iconlist-variant is a candidate wherever the icon tokens can be authored')
assert.equal(
  groupApplies(iconlistVariantOnList.group, {
    layoutName: 'list', headingLevel: 3, hasChildren: false,
    selectedTokens: { 'list-style': '', 'icon-level': '' }
  }), false,
  'a plain list offers no icon-list treatment'
)
assert.equal(
  groupApplies(iconlistVariantOnList.group, {
    layoutName: 'list', headingLevel: 3, hasChildren: false,
    selectedTokens: { 'list-style': 'iconlist', 'icon-level': '' }
  }), true,
  '{iconlist} reveals the treatment choice'
)
assert.equal(
  groupApplies(iconlistVariantOnList.group, {
    layoutName: 'list', headingLevel: 3, hasChildren: false,
    selectedTokens: { 'list-style': '', 'icon-level': 'icons=all' }
  }), true,
  '{icons=all} reveals the treatment choice'
)
assert.equal(
  groupApplies(iconlistVariantOnList.group, {
    layoutName: 'list', headingLevel: 3, hasChildren: false,
    selectedTokens: { 'list-style': '', 'icon-level': 'icons=off' }
  }), false,
  '{icons=off} overrides nothing, so there is no icon list to treat'
)

// Ticket 02 (Dominik, 29 Sep): the statement's options are separate choices — Sidebar, Background,
// Alignment, Bar and Sidebar colour — each a small segmented control.
const statementGroups = optionGroupsForSlide({ layoutName: 'statement', headingLevel: 3, hasChildren: false })
  .filter(({ source }) => source === 'entry').map(({ group }) => group)
assert.deepEqual(statementGroups.map((group) => [group.key, group.sectionLabel ?? group.label, group.preview]), [
  ['statement-sidebar', 'Sidebar', 'segmented'],
  ['statement-bg', 'Background', 'segmented'],
  ['statement-align', 'Alignment', 'segmented'],
  ['statement-bar', 'Bar', 'segmented'],
  ['statement-colour', 'Sidebar colour', 'segmented']
], 'ticket 02: five separate statement choices, each a segmented control')
const statementGroup = (key) => statementGroups.find((group) => group.key === key)
assert.deepEqual(statementGroups.map((group) => group.values.map(({ token, label }) => `${label}${token ? `=${token}` : ''}`)), [
  ['Auto', 'With sidebar=statement-sidebar=on', 'No sidebar=statement-sidebar=off'],
  ['Halo', 'Full=statement-bg=full', 'None=statement-bg=none'],
  ['Aligned', 'Centred=statement-align=centred'],
  ['None', 'Left=statement-bar=left', 'Top=statement-bar=top', 'Bottom=statement-bar=bottom'],
  ['Section', 'Cobalt=accent=cobalt', 'Emerald=accent=emerald', 'Vermilion=accent=vermilion', 'Forest=accent=forest']
], 'each choice offers exactly the values the ticket names')
assert.deepEqual(statementGroups.flatMap((group) => group.dictionaryTokens ?? []).sort(), [
  'statement-align=left', 'statement-bar=none', 'statement-bg=halo',
  'statement=bar', 'statement=centred', 'statement=default', 'statement=full', 'statement=poster', 'statement=tint'
], 'the older one-word options and the explicit defaults stay accepted vocabulary without being buttons')
const statementContext = { layoutName: 'statement', headingLevel: 3, hasChildren: false }
for (const titlePainted of [true, false, undefined]) {
  assert.deepEqual(valuesForGroup(statementGroup('statement-align'), { ...statementContext, titlePainted }).map(({ label }) => label),
    ['Aligned', 'Centred'], `Centred is offered with or without a title (titlePainted ${titlePainted})`)
}

// The write path: a statement control changes only its own dimension. The older one-word options
// are rewritten as the per-dimension tokens they mean before the click lands.
const commitStatement = (line, key, token, statement = {}) => commitOptionSelection(line, statementGroup(key), token, { statement })
assert.equal(commitStatement('{id=a}{statement}{font-body=xl}', 'statement-bar', 'statement-bar=top'),
  '{id=a}{statement}{statement-bar=top}{font-body=xl}', 'a new choice goes after the layout token')
assert.equal(commitStatement('{id=a}{statement}{statement-bar=top}{statement-bg=full}', 'statement-bar', 'statement-bar=bottom'),
  '{id=a}{statement}{statement-bar=bottom}{statement-bg=full}', 'a per-dimension line changes only its own token')
assert.equal(commitStatement('{id=a}{statement}{statement-bar=top}', 'statement-bar', ''),
  '{id=a}{statement}', 'the default removes the token')
assert.equal(commitStatement('{id=a}{statement=tint}', 'statement-bar', 'statement-bar=top'),
  '{id=a}{statement}{statement-bar=top}', 'Tint (Halo + Left) → Top bar: the halo stays, the bar moves; {statement} stays the layout')
assert.equal(commitStatement('{id=a}{statement}{statement=bar}', 'statement-bg', 'statement-bg=full'),
  '{id=a}{statement}{statement-bg=full}{statement-bar=left}', 'Bar (None + Left) → Full: the bar stays')
assert.equal(commitStatement('{id=a}{statement}{claim=bar}', 'statement-align', 'statement-align=centred'),
  '{id=a}{statement}{statement-align=centred}{statement-bg=none}{statement-bar=left}', '{claim=bar} is the Bar preset; the click lands after the layout token')
assert.equal(commitStatement('{id=a}{statement=full}', 'statement-colour', 'accent=vermilion'),
  '{id=a}{statement}{accent=vermilion}{statement-bg=full}', 'the colour choice rewrites the older option too, then adds its token')
assert.equal(commitStatement('{id=a}{statement=centred}', 'statement-bar', 'statement-bar=left', { titleHidden: true }),
  '{id=a}{statement}{statement-bar=left}{statement-align=centred}', 'the older Centred without a title stays centred')
assert.equal(commitStatement('{id=a}{statement=centred}', 'statement-bar', 'statement-bar=left', { titleHidden: false }),
  '{id=a}{statement}{statement-bar=left}', 'the older Centred beside a title rendered as the Default, and stays so')
assert.equal(commitStatement('{id=a}{statement}{statement=poster}', 'statement-sidebar', 'statement-sidebar=on'),
  '{id=a}{statement}{statement-sidebar=on}', 'Poster is the Default: nothing to rewrite but the word itself')
// A deck `claim_style: bar` decides a statement with no token of its own (None + Left).
assert.equal(commitStatement('{id=a}{statement}', 'statement-bar', '', { deckClaimStyle: 'bar' }),
  '{id=a}{statement}{statement-bg=none}', 'no bar on a Bar deck: the colourless look stays as a token of its own, so the slide stops following the deck')
assert.equal(commitStatement('{id=a}{statement}{statement-bar=left}', 'statement-bar', '', { deckClaimStyle: 'bar' }),
  '{id=a}{statement}{statement-bar=none}', 'the last token removed on a Bar deck is kept as its explicit default')
assert.equal(commitStatement('{id=a}{statement}', 'statement-bg', 'statement-bg=full', { deckClaimStyle: 'bar' }),
  '{id=a}{statement}{statement-bg=full}{statement-bar=left}', 'Full on a Bar deck keeps the deck\'s bar')

const backgroundGroup = GLOBAL_OPTION_GROUPS.find((group) => group.key === 'background')
assert.ok(backgroundGroup, 'global Background option exists')
assert.equal(backgroundGroup.preview, 'segmented')
assert.deepEqual(backgroundGroup.values.map(({ token, label, swatch }) => [token, label, swatch]), [
  ['', 'Auto', undefined],
  ['bg=cobalt', 'Cobalt', '#e8eefc'],
  ['bg=emerald', 'Emerald', '#e4f3ee'],
  ['bg=vermilion', 'Vermilion', '#fcece3'],
  ['bg=forest', 'Forest', '#e4f3ee']
], 'Background uses the readable tint hexes, never saturated accents')

const chartGroups = optionGroupsForSlide({ layoutName: 'chart', headingLevel: 3, hasChildren: false })
assert.equal(chartGroups[0].group.key, 'values')
assert.equal(chartGroups.some(({ group }) => group.key === 'list-style'), false,
  'chart options must not leak list-specific groups')

assert.equal(optionGroupsForSlide({ layoutName: 'contents', headingLevel: 3, hasChildren: false })[0].source, 'global',
  'container-only entry options are hidden from content headings')
assert.equal(optionGroupsForSlide({ layoutName: 'contents', headingLevel: 2, hasChildren: false })[0].group.key, 'variant',
  'container entry options are exposed on section headings')

const sectionAccentGroups = optionGroupsForSlide({ layoutName: 'section', headingLevel: 2, hasChildren: false })
const accentGroup = sectionAccentGroups.find(({ group }) => group.key === 'accent')?.group
assert.ok(accentGroup, 'section headings expose the registry-driven accent option')
assert.deepEqual(accentGroup.values.map(({ token }) => token), [
  '', 'accent=cobalt', 'accent=emerald', 'accent=vermilion', 'accent=forest'
], 'section accent options expose named palette colours rather than hex values')
assert.equal(optionGroupsForSlide({ layoutName: 'statement', headingLevel: 3, hasChildren: false }).some(({ group }) => group.key === 'accent'), false,
  'content slides never expose the section-only accent option')

const nestedGroups = optionGroupsForSlide({ layoutName: 'statement', headingLevel: 3, hasChildren: true })
const containerMode = nestedGroups.find(({ group }) => group.key === 'container-mode')?.group
assert.ok(containerMode, 'a ### slide with #### children exposes Container mode')
assert.deepEqual(containerMode.values.map(({ token, label }) => [token, label]), [
  ['', 'Linear'],
  ['carousel', 'Carousel'],
  ['contents', 'Contents'],
  ['grid-linear', 'Grid linear'],
  ['grid-zoom', 'Grid zoom']
], 'Container mode offers the five mutually-exclusive modes from the spec')
assert.equal(
  commitOptionSelection('{statement}{contents}', containerMode, 'carousel'),
  '{statement}{carousel}',
  'committing Carousel removes the rival container mode'
)
assert.ok(optionGroupsForSlide({ layoutName: 'section', headingLevel: 2, hasChildren: false })
  .some(({ group }) => group.key === 'container-mode'),
  '## sections keep their existing Container mode behaviour')

const titlePlacement = GLOBAL_OPTION_GROUPS.find((group) => group.key === 'title-placement')
assert.ok(titlePlacement, 'global title-placement group exists')
assert.equal(GLOBAL_OPTION_GROUPS.some((group) => group.key === 'rail-width'), false,
  'title placement and rail width are one coherent group')
assert.deepEqual(titlePlacement.values.map(({ token, label }) => [token, label]), [
  ['', 'Auto'],
  ['titletop', 'Top'],
  ['notitle', 'Hidden'],
  ['sidebar', 'Sidebar'],
  ['split=30', '30'],
  ['split=35', '35'],
  ['split=40', '40'],
  ['split=50', '50']
], 'merged title placement offers Auto, Top, Hidden, Sidebar and explicit side widths')
assert.equal(selectionForGroup('{sidebar}', titlePlacement), 'sidebar',
  'authored Sidebar is recognised as the active title placement')
for (const from of ['titletop', 'notitle', 'sidebar']) {
  for (const to of ['titletop', 'notitle', 'sidebar']) {
    assert.equal(
      commitOptionSelection(`{image-grid}{${from}}`, titlePlacement, to),
      `{image-grid}{${to}}`,
      `${from} is replaced by ${to} within title placement`
    )
  }
}
assert.equal(
  commitOptionSelection('{image-grid}{sidebar}', titlePlacement, 'split=40'),
  '{image-grid}{split=40}{sidebar}',
  'Sidebar keeps its compiler-supported style when choosing a rail width'
)
const compiledSidebarWidth = parseHeadingAttrs('{sidebar}{split=40}').attrs
assert.equal(compiledSidebarWidth.title, 'side', 'compiler resolves Sidebar to the tint title rail')
assert.equal(compiledSidebarWidth.split, '40', 'compiler applies an explicit width to the Sidebar rail')
assert.equal(
  commitOptionSelection('{image-grid}{sidebar}{split=40}', titlePlacement, 'titletop'),
  '{image-grid}{titletop}',
  'Top removes both Sidebar and its width'
)
assert.equal(
  commitOptionSelection('{image-grid}{split=35}', titlePlacement, 'split=40'),
  '{image-grid}{split=40}',
  'changing side width keeps exactly one split token'
)
assert.equal(
  commitOptionSelection('{image-grid}{split=40}', titlePlacement, ''),
  '{image-grid}',
  'Auto removes explicit side placement'
)
assert.equal(
  commitOptionSelection('{image-grid}{notitle}', titlePlacement, 'split=35'),
  '{image-grid}{split=35}',
  'side placement replaces Hidden in the same group'
)
assert.equal(parseHeadingAttrs('{sidebar-40}').warnings.some((warning) => warning.startsWith('unknown-trigger:')), false,
  'legacy sidebar width tokens remain valid compiler input without being offered by the group')

console.log(`layout options model: ${allGroups.length} groups pass schema, commit and applicability checks`)
