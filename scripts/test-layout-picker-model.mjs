import {
  commitPickerOption,
  digitPickForOptionStep,
  commitLayoutSelection,
  filterLayoutPickerEntries,
  inlineLayoutPickerModel,
  inlineOptionPickerStep,
  layoutPickerModel,
  layoutSubmenuEntries,
  optionGroupsForPickerEntry,
  pickerTypeStripModel,
  selectionFromTriggerLine,
  provisionalTriggerAtCursor,
  toggleLayoutSelection
} from '../src/renderer/src/components/layoutPickerModel.ts'
import { LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import { stampMissingIds } from '../compiler/scripts/lib/12-outline-edit.mjs'

let fail = 0
const check = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message)
    fail += 1
  }
}
const equal = (actual, expected, message) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message} — got ${JSON.stringify(actual)}`)

const before = '### One\n{id=abc}{statement}\nBody\n'
const provisional = before.replace('{statement}', '{statement}{side')
equal(
  provisionalTriggerAtCursor(provisional, provisional.indexOf('{side') + 5),
  { from: provisional.indexOf('{side'), to: provisional.indexOf('{side') + 5 },
  'incomplete token after existing triggers is provisional'
)
check(provisionalTriggerAtCursor(before, before.indexOf('{statement}') + 11) === null,
  'closed trigger is committed, not provisional')
check(provisionalTriggerAtCursor('### One\nBody {side', 17) === null,
  'ordinary prose brace is not treated as picker input')
const stampedMalformed = stampMissingIds(provisional, () => 0.12345)
check(stampedMalformed.stamped.length === 0 && stampedMalformed.text === provisional,
  'save-time stamping parks id minting while a provisional brace is unclosed')
const closedProvisional = provisional.replace('{side', '{sidebar}')
const stampedClosed = stampMissingIds(closedProvisional, () => 0.12345)
check(stampedClosed.stamped.length === 0 && stampedClosed.text === closedProvisional,
  'closing the provisional brace preserves the existing lower id without minting')

const statement = { name: 'statement', trigger: '{statement}', kind: 'layout' }
const cards = { name: 'cards', trigger: '{cards}', kind: 'layout' }
const sidebar = { name: 'sidebar', trigger: '{sidebar}', kind: 'modifier' }
const sidebar40 = { name: 'sidebar-40', trigger: '{sidebar-40}', kind: 'modifier' }

let selected = toggleLayoutSelection([], statement)
selected = toggleLayoutSelection(selected, sidebar)
selected = toggleLayoutSelection(selected, sidebar40)
equal(selected.map((item) => item.name), ['statement', 'sidebar', 'sidebar-40'],
  'layout and modifiers accumulate in selection order')
selected = toggleLayoutSelection(selected, cards)
equal(selected.map((item) => item.name), ['cards', 'sidebar', 'sidebar-40'],
  'a later slide layout replaces only the earlier slide layout')
selected = toggleLayoutSelection(selected, sidebar)
equal(selected.map((item) => item.name), ['cards', 'sidebar-40'],
  'modifier selection toggles off')

for (const layout of LAYOUTS) {
  check(filterLayoutPickerEntries(LAYOUTS, layout.name).some((item) => item.name === layout.name),
    `picker search finds registry entry by name: ${layout.name}`)
  check(filterLayoutPickerEntries(LAYOUTS, layout.trigger).some((item) => item.name === layout.name),
    `picker search finds registry entry by trigger: ${layout.trigger}`)
  for (const alias of layout.aliases) {
    check(filterLayoutPickerEntries(LAYOUTS, alias).some((item) => item.name === layout.name),
      `picker search finds registry entry ${layout.name} by alias: ${alias}`)
  }
}
check(filterLayoutPickerEntries(LAYOUTS, 'contents').some((item) => item.name === 'contents'),
  '{contents} is findable in the shared picker search')

const slideModel = layoutPickerModel(LAYOUTS, { headingLevel: 3, hasChildren: false })
const inlineModel = inlineLayoutPickerModel(LAYOUTS, { headingLevel: 3, hasChildren: false })
equal(inlineModel.map((section) => section.label), slideModel.map((section) => section.label),
  'inline { picker uses the same grouping as Command-L')
const inlineEntries = inlineModel.flatMap((section) => section.entries)
const commandEntries = slideModel.flatMap((section) => section.entries)
equal(inlineEntries.map((entry) => entry.name), commandEntries.map((entry) => entry.name),
  'inline { picker and Command-L expose the same registry item set')
check(inlineEntries.every((entry, index) => entry === commandEntries[index]),
  'inline { picker preserves registry object identity with Command-L')

const contrast = LAYOUTS.find((entry) => entry.name === 'contrast')
const statementEntry = LAYOUTS.find((entry) => entry.name === 'statement')
const optionLine = '{id=abc}{contrast}{contrast=rows}{font-body=l}'
const contrastOptionRows = optionGroupsForPickerEntry(contrast, optionLine)
equal(contrastOptionRows.map(({ group, selectedToken }) => [group.key, selectedToken]),
  [['variant', 'contrast=rows']],
  'Command-L derives the highlighted entry option row and current selection from the registry')
const statementOptionRows = optionGroupsForPickerEntry(statementEntry, optionLine)
equal(statementOptionRows.map(({ group, selectedToken }) => [group.key, selectedToken]),
  [['statement-variant', '']],
  'Command-L derives the statement variant row from the registry')

const typeStrip = pickerTypeStripModel(optionLine)
equal(typeStrip.map(({ group, selectedToken }) => [group.key, selectedToken]), [
  ['font-body', 'font-body=l'],
  ['font-title', '']
], 'Command-L type strip binds the two global font groups to the current trigger line')

const chained = inlineOptionPickerStep(contrast, optionLine, '')
check(chained != null, 'inline { choosing an entry with options creates a chained step')
equal(chained.crumb, ['{', 'contrast', 'options'],
  'inline option step exposes the locked crumb labels')
equal(chained.rows.map(({ digit, value }) => [digit, value.token]), [
  [1, ''], [2, 'contrast=ledger'], [3, 'contrast=rows'], [4, 'contrast=tint'], [5, 'contrast=flip']
], 'inline option step maps registry values to digit rows')
check(chained.group === contrastOptionRows[0].group,
  'inline and Command-L option paths preserve the same registry group object identity')
const statementStep = inlineOptionPickerStep(statementEntry, optionLine, '')
check(statementStep != null, 'inline { choosing statement creates its registry-driven variant step')
equal(statementStep.rows.map(({ digit, value }) => [digit, value.token]), [
  [1, ''], [2, 'statement=tint'], [3, 'statement=poster']
], 'inline statement step offers default, tint, and poster')

const filteredStep = inlineOptionPickerStep(contrast, optionLine, 'tin')
equal(filteredStep.rows.map(({ digit, value }) => [digit, value.token]), [[1, 'contrast=tint']],
  'continued typing filters inline option value rows and renumbers visible digit picks')
equal(digitPickForOptionStep(chained, 3)?.token, 'contrast=rows',
  'digit pick resolves the visible inline option row')
check(digitPickForOptionStep(chained, 9) === undefined,
  'digit pick outside the visible inline rows is ignored')
check(commitPickerOption('{contrast}', chained.group, 'contrast=tint') ===
  '{contrast}{contrast=tint}',
  'both picker paths commit options through the ADR-0011 trigger-line writer')
equal(slideModel.map((section) => section.label), ['Layout', 'Modifiers', 'Components'],
  'slide picker groups entries by kind in taxonomy order')
check(slideModel.every((section) => section.entries.every((entry) => entry.kind === section.kind)),
  'each picker section contains only its declared kind')
check(!slideModel.some((section) => section.kind === 'container'),
  'container is hidden on a ### heading')

const nestedSlideModel = layoutPickerModel(LAYOUTS, { headingLevel: 3, hasChildren: true })
check(nestedSlideModel.some((section) => section.kind === 'container'),
  'container entries are shown on a ### heading with #### child slides')

const sectionModel = layoutPickerModel(LAYOUTS, { headingLevel: 2, hasChildren: false })
equal(sectionModel.map((section) => section.label), ['Layout', 'Modifiers', 'Components', 'Container'],
  'section picker adds Container after Components')
equal(sectionModel.find((section) => section.kind === 'container').entries.map((entry) => entry.name),
  ['carousel', 'grid-linear', 'grid-zoom', 'contents', 'timer-audience'],
  'Container exposes the five registry entries on a ## heading')
const carousel = LAYOUTS.find((entry) => entry.name === 'carousel')
check(commitLayoutSelection('', [], [carousel]) === '{carousel}',
  'container insertion creates the section heading Trigger line through the shared editor')
const contents = LAYOUTS.find((entry) => entry.name === 'contents')
const switchedContainer = toggleLayoutSelection([contents], carousel)
equal(switchedContainer.map((entry) => entry.name), ['carousel'],
  'container picker entries are mutually exclusive')
check(commitLayoutSelection('{contents}', [contents], switchedContainer) === '{carousel}',
  'switching container mode removes the rival token')

const currentLine = '  {id=AbC tags="Team, AI" mystery=YES}   {statement sidebar}  '
const currentSelection = selectionFromTriggerLine(currentLine, LAYOUTS)
equal(currentSelection.map((entry) => entry.name), ['statement', 'sidebar'],
  'picker pre-checks current layout and modifier through the shared parser')
const withCards = toggleLayoutSelection(currentSelection, LAYOUTS.find((entry) => entry.name === 'cards'))
check(commitLayoutSelection(currentLine, currentSelection, withCards) ===
  '  {id=AbC tags="Team, AI" mystery=YES}   {cards sidebar}  ',
  'radio replacement keeps modifier and byte-preserves system and unknown tokens')
const withNumbered = toggleLayoutSelection(withCards, LAYOUTS.find((entry) => entry.name === 'numbered'))
check(commitLayoutSelection(currentLine, currentSelection, withNumbered) ===
  '  {id=AbC tags="Team, AI" mystery=YES}   {cards sidebar}   {numbered}',
  'modifier toggle keeps layout and system tokens in composed commit')
const withoutSidebar = toggleLayoutSelection(withNumbered, LAYOUTS.find((entry) => entry.name === 'sidebar'))
check(commitLayoutSelection(currentLine, currentSelection, withoutSidebar) ===
  '  {id=AbC tags="Team, AI" mystery=YES}   {cards }   {numbered}',
  'composed commit removes a current modifier and produces the expected bytes')

const registryLayouts = LAYOUTS.filter((entry) => entry.kind === 'layout')
const submenuLayouts = layoutSubmenuEntries(LAYOUTS)
equal(submenuLayouts.map((entry) => entry.name), registryLayouts.map((entry) => entry.name),
  'Command-K submenu is the registry layouts subset')
check(submenuLayouts.every((entry, index) => entry === registryLayouts[index]),
  'Command-K submenu preserves registry object identity')

if (fail) process.exit(1)
console.log('PASS: layout picker model')
