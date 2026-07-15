import { strict as assert } from 'node:assert'
import { parseHeadingAttrs } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { GLOBAL_OPTION_GROUPS, LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import {
  commitOptionSelection,
  parseTriggerLine,
  selectionForGroup
} from '../src/shared/trigger-line.ts'
import {
  optionGroupsForSlide
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
  ['', 'Boxes'],
  ['iconlist=list', 'List']
], 'iconlist offers its card grid default and restored plain rows')

const statementVariant = optionGroupsForSlide({ layoutName: 'statement', headingLevel: 3, hasChildren: false })[0].group
assert.equal(statementVariant.key, 'statement-variant')
assert.equal(statementVariant.preview, 'thumbs')
assert.deepEqual(statementVariant.values.map(({ token, label }) => [token, label]), [
  ['', 'Default'],
  ['statement=tint', 'Tint'],
  ['statement=poster', 'Poster']
], 'statement exposes default, tint, and poster treatments')

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
