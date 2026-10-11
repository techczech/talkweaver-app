// Onboarding 0.38.1 ticket 02: TalkWeaver knows where the caret is, and the status bar says so.
//   - the place function over a fixture outline covering every place, nested constructs included;
//   - the focus rule (Talks-panel row, strip, editor);
//   - the work is bounded: the caret's line, and the metadata scan only when the file opens with ---;
//   - every command declares its places; the slide-heading list is the drawing's 14 (state 12);
//   - the status-bar model: presence, text, absorption and the setting.
import { strict as assert } from 'node:assert'

const { placeOfLine, placeAt, actionsAt, actionCountText, placeLabel, PLACES, PLACE_LABELS, METADATA_SCAN_LINES } =
  await import(new URL('../src/shared/place.ts', import.meta.url))
const { COMMAND_PLACES, EVERYWHERE, NOT_BY_PLACE } = await import(new URL('../src/shared/command-places.ts', import.meta.url))
const { COMMAND_REGISTRY } = await import(new URL('../src/shared/command-registry.ts', import.meta.url))
const { placeChipView, placeChipLayout, FULL_FROM_PX, PLACE_ONLY_FROM_PX } =
  await import(new URL('../src/renderer/src/components/placeChipModel.ts', import.meta.url))
const { placeChipVisibleFrom, PLACE_CHIP_VISIBLE_DEFAULT } = await import(new URL('../src/shared/place-chip-settings.ts', import.meta.url))

const results = []
const test = (name, fn) => { try { fn(); results.push([true, name]) } catch (error) { results.push([false, `${name}: ${error.message}`]) } }

// Each fixture line carries the place the caret on it must read. Every place of the outline editor
// appears, with nested constructs: a list inside a quotation, a quotation inside a list, a heading and
// a layout line inside a quotation, a heading with a trailing id, a nested list, rules and blanks.
const FIXTURE = [
  ['---', 'metadata'],
  ['title: The Saturday market', 'metadata'],
  ['# not a title inside the metadata', 'metadata'],
  ['- not a list inside the metadata', 'metadata'],
  ['---', 'metadata'],
  ['', 'slide-text'],
  ['# The Saturday market', 'talk-title'],
  ['', 'slide-text'],
  ['## 01 Write the outline', 'slide-heading'],
  ['### Four stalls', 'slide-heading'],
  ['### Opening hours {id=s4}', 'slide-heading'],
  ['###### Deepest heading', 'slide-heading'],
  ['{id=s3}', 'layout-line'],
  ['{statement}', 'layout-line'],
  ['{statement} {id=s1}', 'layout-line'],
  ['  {id=s2}  ', 'layout-line'],
  ['This talk is the example.', 'slide-text'],
  ['Press `F5` to present. {not a layout line', 'slide-text'],
  ['#hashtag is not a heading', 'slide-text'],
  ['- Bread and cakes', 'list'],
  ['* Vegetables', 'list'],
  ['1. Plants', 'list'],
  ['2) Second-hand books', 'list'],
  ['  - nested item', 'list'],
  ['-', 'list'],
  ['- {statement}', 'list'],
  ['> Press **⌘L** to try a layout.', 'quotation'],
  ['> - a list inside a quotation', 'list'],
  ['- > a quotation inside a list', 'quotation'],
  ['> > a quotation inside a quotation', 'quotation'],
  ['> ### a heading inside a quotation', 'quotation'],
  ['> {statement}', 'quotation'],
  ['>', 'quotation'],
  ['---', 'slide-text'],
  ['***', 'slide-text'],
  ['-5 degrees at dawn', 'slide-text'],
  ['    indented continuation', 'slide-text']
]
const lines = FIXTURE.map(([text]) => text)
const lineAt = (n) => lines[n - 1] ?? ''

test('every outline line reads its place', () => {
  const wrong = FIXTURE.flatMap(([text, want], index) => {
    const got = placeOfLine(text, index + 1, lineAt)
    return got === want ? [] : [`line ${index + 1} ${JSON.stringify(text)}: ${got}, want ${want}`]
  })
  assert.deepEqual(wrong, [])
})

test('the fixture covers every outline place', () => {
  const covered = new Set(FIXTURE.map(([, place]) => place))
  for (const place of ['slide-heading', 'talk-title', 'layout-line', 'slide-text', 'list', 'quotation', 'metadata']) assert.ok(covered.has(place), place)
})

test('an outline without metadata has none, and a # line at the top is the title', () => {
  const doc = ['# Title', '---', 'after a rule']
  const at = (n) => doc[n - 1] ?? ''
  assert.equal(placeOfLine(doc[0], 1, at), 'talk-title')
  assert.equal(placeOfLine(doc[2], 3, at), 'slide-text')
})

test('a metadata block that has not closed yet holds the caret', () => {
  const doc = ['---', 'title: x', 'author: y']
  const at = (n) => doc[n - 1] ?? ''
  assert.equal(placeOfLine(doc[2], 3, at), 'metadata')
})

test('the place reads the caret line only; the metadata scan is bounded', () => {
  const big = ['# Title', ...Array.from({ length: 5000 }, (_, i) => (i % 3 ? `- item ${i}` : `### Slide ${i}`))]
  let reads = 0
  const counted = (n) => { reads += 1; return big[n - 1] ?? '' }
  assert.equal(placeOfLine(big[4001], 4002, counted), 'list')
  assert.ok(reads <= 1, `${reads} lines read without metadata`)
  const fronted = ['---', ...Array.from({ length: 5000 }, () => 'key: value')]
  reads = 0
  const countedFront = (n) => { reads += 1; return fronted[n - 1] ?? '' }
  placeOfLine(fronted[4000], 4001, countedFront)
  assert.ok(reads <= 1, `${reads} lines read for a caret past the scan bound`)
  reads = 0
  placeOfLine(fronted[150], 151, countedFront)
  assert.ok(reads <= METADATA_SCAN_LINES, `${reads} lines read inside the bound`)
})

test('focus decides first: a Talks-panel row, then the strip, then the editor', () => {
  assert.equal(placeAt({ focus: 'talks', row: 'talk', editorPlace: 'slide-heading' }), 'talk')
  assert.equal(placeAt({ focus: 'talks', row: 'vault', editorPlace: 'slide-heading' }), 'vault')
  assert.equal(placeAt({ focus: 'talks', row: 'folder', editorPlace: 'slide-heading' }), 'vault')
  assert.equal(placeAt({ focus: 'talks', row: null, editorPlace: 'list' }), 'list')
  assert.equal(placeAt({ focus: 'strip', row: 'talk', editorPlace: 'list' }), 'strip-slide')
  assert.equal(placeAt({ focus: 'editor', row: 'talk', editorPlace: 'quotation' }), 'quotation')
})

test('the ten places, with the lock\'s words', () => {
  assert.deepEqual([...PLACES], ['slide-heading', 'talk-title', 'layout-line', 'slide-text', 'list', 'quotation', 'metadata', 'strip-slide', 'talk', 'vault'])
  assert.deepEqual(PLACES.map((place) => PLACE_LABELS[place].toLowerCase()), [
    'on a slide heading', 'on the talk title', 'on a layout line', 'in slide text', 'in a list',
    'in a quotation', 'in the metadata', 'on a slide in the strip', 'on a talk', 'on a vault'
  ])
})

test('every command declares its places', () => {
  const undeclared = COMMAND_REGISTRY.filter((command) => command.places === null).map((command) => command.id)
  assert.deepEqual(undeclared, [])
  for (const command of COMMAND_REGISTRY) {
    const places = command.places
    assert.ok(places === EVERYWHERE || places === NOT_BY_PLACE || (Array.isArray(places) && places.length > 0 && places.every((place) => PLACES.includes(place))), command.id)
  }
})

test('every declaration names a command the registry has, and no key inside a surface is offered', () => {
  const ids = new Set(COMMAND_REGISTRY.map((command) => command.id))
  assert.deepEqual(Object.keys(COMMAND_PLACES).filter((id) => !ids.has(id)), [])
  for (const command of COMMAND_REGISTRY) if (command.surface) assert.equal(command.places, NOT_BY_PLACE, command.id)
})

test('deck-wide commands are not offered by place (lock decision 11)', () => {
  for (const command of COMMAND_REGISTRY) {
    if (command.taskGroup === 'Present' || command.taskGroup === 'Share') assert.equal(command.places, NOT_BY_PLACE, command.id)
  }
  for (const id of ['pathways', 'app.context-menu', 'app.command-palette']) assert.equal(COMMAND_PLACES[id], NOT_BY_PLACE, id)
})

// The drawing's Actions here at a slide heading (state 12), in its order.
const DRAWN_SLIDE_HEADING = [
  ['Write the outline', 'promote-heading'], ['Write the outline', 'demote-heading'], ['Write the outline', 'editor.move-up'],
  ['Write the outline', 'editor.move-down'], ['Write the outline', 'delete-slide'], ['Write the outline', 'editor.heading-same'],
  ['Write the outline', 'editor.heading-sub'], ['Build a slide', 'layout'], ['Build a slide', 'image'], ['Build a slide', 'icon-picker'],
  ['Build a slide', 'toggle-inspector'], ['Reuse slides', 'where-used'], ['Reuse slides', 'tag-slide'], ['See the talk', 'focus-slide']
]
test('on a slide heading: the drawn 14, in the drawn order', () => {
  assert.deepEqual(actionsAt('slide-heading').map((command) => [command.taskGroup, command.id]), DRAWN_SLIDE_HEADING)
})

test('every place offers at least one command, grouped in task-group order', () => {
  const groups = ['Write the outline', 'Build a slide', 'Reuse slides', 'See the talk', 'Shape the talk', 'Present', 'Share', 'Manage talks', 'Check and repair', 'Set up TalkWeaver']
  for (const place of PLACES) {
    const list = actionsAt(place)
    assert.ok(list.length > 0, place)
    const order = list.map((command) => groups.indexOf(command.taskGroup))
    assert.deepEqual(order, [...order].sort((a, b) => a - b), place)
  }
})

test('count text', () => {
  assert.equal(actionCountText(14), '14 actions')
  assert.equal(actionCountText(1), '1 action')
  assert.equal(placeLabel('slide-heading'), 'On a slide heading')
})

test('the chip reads as drawn: "On a slide heading · 14 actions ⌘K"', () => {
  const view = placeChipView({ place: 'slide-heading', count: actionsAt('slide-heading').length, chord: '⌘K', visible: true, minimal: false, barWidth: 1200 })
  assert.equal(view.show, true)
  assert.equal(view.layout, 'full')
  assert.equal(`${view.text} ${view.chord}`, 'On a slide heading · 14 actions ⌘K')
})

test('absorption: full, then place only, then absorbed as the bar narrows', () => {
  assert.equal(placeChipLayout(null), 'full')
  assert.equal(placeChipLayout(FULL_FROM_PX), 'full')
  assert.equal(placeChipLayout(FULL_FROM_PX - 1), 'place-only')
  assert.equal(placeChipLayout(PLACE_ONLY_FROM_PX), 'place-only')
  assert.equal(placeChipLayout(PLACE_ONLY_FROM_PX - 1), 'absorbed')
  const base = { place: 'list', count: 20, chord: '⌘K', visible: true, minimal: false }
  const middle = placeChipView({ ...base, barWidth: PLACE_ONLY_FROM_PX + 10 })
  assert.equal(middle.show, true)
  assert.equal(middle.text, 'In a list')
  assert.match(middle.title, /^In a list · 20 actions/)
  assert.equal(placeChipView({ ...base, barWidth: PLACE_ONLY_FROM_PX - 10 }).show, false)
})

test('the setting: on by default, off hides the chip', () => {
  assert.equal(PLACE_CHIP_VISIBLE_DEFAULT, true)
  assert.equal(placeChipVisibleFrom(undefined), true)
  assert.equal(placeChipVisibleFrom('no'), true)
  assert.equal(placeChipVisibleFrom(false), false)
  assert.equal(placeChipView({ place: 'list', count: 20, chord: '⌘K', visible: false, minimal: false, barWidth: 1200 }).show, false)
})

test('with no talk open, only a Talks-panel place shows', () => {
  const base = { count: 6, chord: '⌘K', visible: true, minimal: true, barWidth: 1200 }
  assert.equal(placeChipView({ ...base, place: 'talk' }).show, true)
  assert.equal(placeChipView({ ...base, place: 'vault' }).show, true)
  assert.equal(placeChipView({ ...base, place: 'slide-text' }).show, false)
})

for (const [pass, name] of results) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
const failed = results.filter(([pass]) => !pass).length
console.log(`${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
