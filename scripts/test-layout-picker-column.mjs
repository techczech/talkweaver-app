// The docked layout picker's model (ADR-0032; ticket 03): catalog, search, grouping, keyboard, commit.
import { strict as assert } from 'node:assert'
import {
  buildPickerCatalog, initialPickerState, pickerCommit, pickerTry, pickerView, reducePicker,
  rememberLayout, searchPickerEntries, highlightedStop, stopKey, SUGGESTED_COLUMNS_NARROW,
  ownPictureWanted, TRY_DELAY_MS, withRenderVerdicts
} from '../src/renderer/src/components/layoutPickerColumnModel.ts'
import {
  VARIANT_PICTURE_POLICY, createVariantPictureQueue, createVariantPictureSlots, nextPictureStep
} from '../src/shared/variant-picture-queue.ts'
import { readFileSync } from 'node:fs'
import { previewLayout } from '../src/shared/layout-verbs.ts'
import { setLayout } from '../src/shared/layout-verbs.ts'

const outline = `---
title: Picker fixture
---

# Picker fixture

## Section one

{id=sec1}

### Five things

{id=five}{iconrow}

- Catalogue and organise data
- Manage projects and keep notes
- Create tools and websites
- Run experiments and keep records
- Set up and control your computer

### A quote

{id=quo}{statement}

Some words worth keeping.

### Empty one

{id=empty}

### Another list

{id=other}{cards}

- One
- Two
- Three
`

let failures = 0
const test = (name, fn) => {
  try { fn(); console.log('PASS', name) } catch (error) { failures += 1; console.error('FAIL', name, '\n ', error.message) }
}
const testAsync = async (name, fn) => {
  try { await fn(); console.log('PASS', name) } catch (error) { failures += 1; console.error('FAIL', name, '\n ', error.message) }
}
const press = (catalog, state, ...actions) => actions.reduce((current, action) => reducePicker(catalog, current, action), state)
const type = (query) => ({ type: 'query', query })
const move = (dir) => ({ type: 'move', dir })

const five = buildPickerCatalog({ outline, slide: 'five' })

test('the catalog offers the 71 picker layouts, none of them components, each with a when-it-fits line', () => {
  assert.equal(five.entries.length, 71)
  assert.ok(five.entries.every((entry) => entry.kind !== 'component' && entry.fits.length > 0 && entry.purpose))
})

test('the catalog names the slide’s own layout, suggestions and recent layouts', () => {
  assert.equal(five.currentName, 'iconrow')
  assert.ok(five.suggested.length > 0 && five.suggested.every((s) => s.layout !== 'iconrow'))
  assert.ok(five.suggested.some((s) => s.layout === 'cards'))
  assert.ok(five.recent.includes('statement') && five.recent.includes('cards'))
  assert.equal(five.headingOnly, false)
  assert.equal(five.container, null)
})

test('session recent layouts come first', () => {
  const catalog = buildPickerCatalog({ outline, slide: 'five', sessionRecent: ['carousel', 'cards'] })
  assert.deepEqual(catalog.recent.slice(0, 2), ['carousel', 'cards'])
  assert.deepEqual(rememberLayout(['a', 'b', 'c'], 'c'), ['c', 'a', 'b'])
})

test('a layout the slide cannot take is greyed with its reason (S10)', () => {
  const zoom = five.entries.find((entry) => entry.name === 'grid-zoom')
  assert.equal(zoom.usable, false)
  assert.equal(zoom.reason, 'Needs a ## section heading')
  assert.equal(five.entries.find((entry) => entry.name === 'cards').usable, true)
})

test('search: "car" puts Cards first, then Carousel (S2)', () => {
  const found = searchPickerEntries(five.entries, 'car').map((entry) => entry.name)
  assert.equal(found[0], 'cards')
  assert.equal(found[1], 'carousel')
})

test('search reads aliases and the when-it-fits line, and every word must match', () => {
  const byLine = searchPickerEntries(five.entries, 'equal weight').map((entry) => entry.name)
  assert.ok(byLine.includes('cards'))
  assert.deepEqual(searchPickerEntries(five.entries, 'cards xyz'), [])
  assert.equal(searchPickerEntries(five.entries, '').length, 71)
})

test('empty box: Recent, Suggested and All layouts with five closed purposes (S1)', () => {
  const view = pickerView(five, initialPickerState())
  assert.deepEqual(view.groups.map((group) => group.id), ['recent', 'suggested', 'all'])
  const all = view.groups[2]
  assert.deepEqual(all.blocks.map((block) => block.header.purpose), ['Everyday', 'Structure', 'Diagrams', 'Modes', 'Specialised'])
  assert.ok(all.blocks.every((block) => block.rows.length === 0 && block.header.open === false))
  assert.equal(all.caption, '71')
  assert.equal(highlightedStop(view, initialPickerState()), null)
})

test('the Suggested row wraps to three across in a narrow column (S12)', () => {
  const view = pickerView(five, initialPickerState(), { suggestedColumns: SUGGESTED_COLUMNS_NARROW })
  const suggested = view.groups.find((group) => group.id === 'suggested')
  assert.equal(suggested.blocks[0].rows[0].length, 3)
  assert.equal(suggested.blocks[0].rows.flat().length, five.suggested.length)
})

test('typing highlights the top match and shows a flat result list; no other groups (S2)', () => {
  const state = press(five, initialPickerState(), type('car'))
  const view = pickerView(five, state)
  assert.deepEqual(view.groups.map((group) => group.id), ['results'])
  assert.equal(highlightedStop(view, state).name, 'cards')
  assert.equal(pickerTry(five, view, state), 'cards')
  assert.deepEqual(pickerCommit(five, view, state), { layout: 'cards' })
})

test('emptying the box highlights nothing again', () => {
  const state = press(five, initialPickerState(), type('car'), type(''))
  assert.equal(state.cursor, null)
})

test('no results names the search and offers Browse all (S9)', () => {
  const state = press(five, initialPickerState(), type('xyz'))
  const view = pickerView(five, state)
  assert.equal(view.noResults, true)
  assert.equal(view.rows.length, 0)
  assert.equal(pickerCommit(five, view, state), null)
  const browse = press(five, state, { type: 'browse-all' })
  assert.equal(pickerView(five, browse).noResults, false)
})

test('a greyed row is highlighted but tries nothing and keeps nothing (S10)', () => {
  const state = press(five, initialPickerState(), type('grid'))
  const view = pickerView(five, state)
  const names = view.rows.map((row) => row[0].name)
  assert.ok(names.includes('grid-zoom'))
  let cursor = state
  while (highlightedStop(pickerView(five, cursor), cursor).name !== 'grid-zoom') cursor = press(five, cursor, move('down'))
  const at = pickerView(five, cursor)
  assert.equal(pickerTry(five, at, cursor), null)
  assert.deepEqual(pickerCommit(five, at, cursor), { blocked: 'Needs a ## section heading' })
})

test('↓ from the box walks Recent, Suggested, then the purposes; ↑ from the top returns to the box', () => {
  let state = press(five, initialPickerState(), move('down'))
  let view = pickerView(five, state)
  assert.equal(highlightedStop(view, state).group, 'recent')
  state = press(five, state, move('down'))
  assert.equal(highlightedStop(pickerView(five, state), state).group, 'suggested')
  state = press(five, state, move('up'), move('up'))
  assert.equal(state.cursor, null)
})

test('← → move along a row and stop at its ends', () => {
  let state = press(five, initialPickerState(), move('down'))
  const first = state.cursor
  assert.equal(press(five, state, move('left')).cursor, first)
  state = press(five, state, move('right'))
  assert.notEqual(state.cursor, first)
  const row = pickerView(five, state).rows[0]
  for (let i = 0; i < row.length + 2; i += 1) state = press(five, state, move('right'))
  assert.equal(state.cursor, stopKey(row[row.length - 1]))
})

test('Tab jumps Recent → Suggested → All layouts and around (S1 footer)', () => {
  const groups = []
  let state = initialPickerState()
  for (let i = 0; i < 4; i += 1) {
    state = press(five, state, { type: 'next-group' })
    const stop = highlightedStop(pickerView(five, state), state)
    groups.push(stop.kind === 'purpose' ? 'all' : stop.group)
  }
  assert.deepEqual(groups, ['recent', 'suggested', 'all', 'recent'])
})

test('on a purpose → opens, ← closes, ↵ toggles; open rows are cards two across (S7)', () => {
  let state = press(five, initialPickerState(), { type: 'next-group' }, { type: 'next-group' }, { type: 'next-group' })
  assert.equal(highlightedStop(pickerView(five, state), state).purpose, 'Everyday')
  state = press(five, state, move('down'), move('down'))
  assert.equal(highlightedStop(pickerView(five, state), state).purpose, 'Diagrams')
  state = press(five, state, move('right'))
  let view = pickerView(five, state)
  const diagrams = view.groups.find((group) => group.id === 'all').blocks.find((block) => block.header.purpose === 'Diagrams')
  assert.equal(diagrams.header.open, true)
  assert.ok(diagrams.rows.length > 1 && diagrams.rows[0].length === 2)
  state = press(five, state, move('left'))
  assert.equal(pickerView(five, state).groups.find((g) => g.id === 'all').blocks.find((b) => b.header.purpose === 'Diagrams').rows.length, 0)
  state = press(five, state, { type: 'activate' })
  assert.equal(state.open.includes('Diagrams'), true)
  state = press(five, state, { type: 'activate' })
  assert.equal(state.open.includes('Diagrams'), false)
  view = pickerView(five, state)
  assert.equal(pickerCommit(five, view, state), null, '↵ on a purpose keeps no layout')
})

test('↑↓ inside an opened purpose keep the column and stop at the last row', () => {
  let state = { ...initialPickerState(), open: ['Structure'] }
  state = press(five, state, { type: 'next-group' }, { type: 'next-group' }, { type: 'next-group' }, move('down'), move('down'))
  const view = pickerView(five, state)
  assert.equal(highlightedStop(view, state).kind, 'purpose' === 'x' ? '' : 'layout')
  state = press(five, state, move('right'))
  const col = pickerView(five, state).rows.findIndex((row) => row.some((stop) => stopKey(stop) === state.cursor))
  assert.ok(col > 0)
  const down = press(five, state, move('down'))
  assert.notEqual(down.cursor, state.cursor)
})

test('heading-only slide: starting points instead of suggestions (S6)', () => {
  const empty = buildPickerCatalog({ outline, slide: 'empty' })
  assert.equal(empty.headingOnly, true)
  assert.deepEqual(empty.suggested, [])
  const suggested = pickerView(empty, initialPickerState()).groups.find((group) => group.id === 'suggested')
  assert.equal(suggested.shape, 'note')
  assert.match(suggested.note, /starter text/)
  assert.equal(suggested.noteLead, 'Nothing to suggest for a heading alone.')
  // A heading-only slide takes every layout (the starter text supplies what it needs).
  assert.ok(empty.entries.every((entry) => entry.usable || entry.reason === 'Needs a ## section heading'))
})

test('a ## divider shows its container choices apart from its own layouts (S8)', () => {
  const divider = buildPickerCatalog({ outline, slide: 'sec1' })
  assert.ok(divider.container && divider.container.slides === 4)
  const view = pickerView(divider, initialPickerState())
  assert.deepEqual(view.groups.map((group) => group.id), ['container', 'all'])
  assert.match(view.groups[0].heading, /4 slides/)
  const container = view.groups[0].blocks[0].rows.flat().map((stop) => stop.name)
  assert.ok(container.includes('grid-zoom') && container.includes('carousel'))
  const own = view.groups[1].blocks.flatMap((block) => block.rows.flat().map((stop) => stop.name))
  assert.equal(own.includes('grid-zoom'), false)
})

test('↵ keeps the highlighted layout through set-layout: the trigger line gains {cards}', () => {
  const state = press(five, initialPickerState(), type('car'))
  const commit = pickerCommit(five, pickerView(five, state), state)
  const written = setLayout(outline, 'five', commit.layout)
  assert.match(written.triggerLine, /\{cards\}/)
  assert.match(written.triggerLine, /\{id=five\}/)
})

test('try, keep and put back: a try names a layout and writes nothing; closing tries nothing', () => {
  const state = press(five, initialPickerState(), type('cards'))
  const view = pickerView(five, state)
  assert.equal(pickerTry(five, view, state), 'cards')
  // The preview is the trigger-line change ↵ would write, on a copy: the outline text is byte-identical.
  const before = outline
  const preview = previewLayout(before, 'five', 'cards')
  assert.notEqual(preview, before)
  assert.equal(before, outline)
  assert.equal(setLayout(outline, 'five', 'cards').outline, preview, 'what the try shows is what ↵ writes')
  // Esc / an emptied box / moving to the box: nothing highlighted, so nothing tried (the preview reverts).
  assert.equal(pickerTry(five, pickerView(five, { ...state, cursor: null }), { ...state, cursor: null }), null)
  const cleared = press(five, state, type(''))
  assert.equal(pickerTry(five, pickerView(five, cleared), cleared), null)
  // Moving from one layout to another changes the try; a purpose header tries nothing.
  const car = press(five, initialPickerState(), type('car'))
  const moved = press(five, car, move('down'))
  assert.equal(pickerTry(five, pickerView(five, car), car), 'cards')
  assert.notEqual(pickerTry(five, pickerView(five, moved), moved), 'cards')
})

test('a pointer rest highlights (and so tries) a picture; the delays are 40 ms keys, 300 ms typing, 250 ms pointer', () => {
  const state = press(five, initialPickerState(), { type: 'move', dir: 'down' })
  const target = pickerView(five, state).rows.flat().find((stop) => stop.kind === 'layout' && stop.group === 'suggested')
  const pointed = press(five, initialPickerState(), { type: 'point', key: stopKey(target) })
  assert.equal(pickerTry(five, pickerView(five, pointed), pointed), target.name)
  assert.deepEqual({ ...TRY_DELAY_MS }, { keys: 40, typing: 300, pointer: 250 })
})

test('own-slide pictures: Suggested first, then visible rows, only layouts the slide can take', () => {
  const unusable = five.entries.find((entry) => !entry.usable)
  const usableOther = five.entries.find((entry) => entry.usable && !five.suggested.some((s) => s.layout === entry.name))
  const wanted = ownPictureWanted(five, [usableOther.name, ...(unusable ? [unusable.name] : []), 'no-such-layout', five.suggested[0].layout])
  assert.deepEqual(wanted.slice(0, five.suggested.length), five.suggested.map((suggestion) => suggestion.layout))
  assert.ok(wanted.includes(usableOther.name))
  if (unusable) assert.equal(wanted.includes(unusable.name), false, 'an unusable layout keeps its sample')
  assert.equal(wanted.includes('no-such-layout'), false)
  assert.equal(new Set(wanted).size, wanted.length)
  assert.deepEqual(ownPictureWanted(five, []), five.suggested.map((suggestion) => suggestion.layout))
})

await testAsync('picture queue: three renders at a time, each layout once, stale answers dropped, wanted-only', async () => {
  const gates = new Map()
  const asked = []
  const settled = []
  const fetchPicture = (layout) => new Promise((resolve) => { asked.push(layout); gates.set(layout, resolve) })
  const own = () => ({ slots: createVariantPictureSlots(3) })
  const queue = createVariantPictureQueue(fetchPicture, (layout, mark) => settled.push([layout, mark]), own())
  queue.reset('k1', { outlinePath: 'a.md', outline: 't1', slideId: 'five' })
  queue.want(['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(asked, ['a', 'b', 'c'])
  // Rows scrolled away before their turn are never asked for.
  queue.want(['a', 'b', 'c', 'e'])
  gates.get('a')({ status: 'ok', slideId: 'five', url: 'u-a', cached: false })
  await new Promise((resolve) => setTimeout(resolve))
  assert.deepEqual(asked, ['a', 'b', 'c', 'e'])
  assert.deepEqual(settled, [['a', 'u-a']])
  // Asking again for a finished or running layout does nothing.
  queue.want(['a', 'b', 'c', 'e'])
  assert.equal(asked.length, 4)
  // New text: the answer for the old text is dropped; nothing is asked until the new wanted set arrives.
  queue.reset('k2', { outlinePath: 'a.md', outline: 't2', slideId: 'five' })
  gates.get('b')({ status: 'ok', slideId: 'five', url: 'old-b', cached: false })
  await new Promise((resolve) => setTimeout(resolve))
  assert.equal(settled.some(([, url]) => url === 'old-b'), false)
  assert.equal(asked.length, 4, 'a freed slot does not ask for the new text before it has settled')
  queue.want(['a'])
  assert.equal(asked.filter((layout) => layout === 'a').length, 2, 'the new text is asked for once wanted')
  // A failed render is tried once more, then settles as null (the sample shows).
  const tick = () => new Promise((resolve) => setTimeout(resolve))
  const now = (run) => { setTimeout(run) }
  let failCalls = 0
  const failing = createVariantPictureQueue(() => { failCalls += 1; return Promise.reject(new Error('render failed')) }, (layout, mark) => settled.push([layout, mark]), { ...own(), schedule: now })
  failing.reset('k', { outlinePath: 'a.md', outline: 't', slideId: 'five' })
  failing.want(['z'])
  for (let i = 0; i < 4; i += 1) await tick()
  assert.equal(failCalls, 2, 'one retry after a failed render')
  assert.deepEqual(settled.at(-1), ['z', null])
  // A render that fails once and then succeeds shows the picture.
  const answers = { flaky: [{ status: 'failed', slideId: 'five' }, { status: 'ok', slideId: 'five', url: 'u-flaky', cached: false }] }
  const got = []
  const flaky = createVariantPictureQueue((layout) => Promise.resolve(answers[layout].shift()), (layout, mark) => got.push([layout, mark]), { ...own(), schedule: now })
  flaky.reset('k', { outlinePath: 'a.md', outline: 't', slideId: 'five' })
  flaky.want(['flaky'])
  for (let i = 0; i < 4; i += 1) await tick()
  assert.deepEqual(got, [['flaky', 'u-flaky']])
  // Cannot take (main's verdict) settles with its reason: grey, never retried. Invalid shows the sample.
  // Superseded is asked again without counting as a failure.
  const script = {
    grey: [{ status: 'cannot-take', slideId: 'five', reason: 'Needs an image' }],
    bad: [{ status: 'invalid', slideId: 'five', reason: 'unknown layout' }],
    busy: [{ status: 'superseded', slideId: 'five' }, { status: 'superseded', slideId: 'five' }, { status: 'ok', slideId: 'five', url: 'u-busy', cached: false }]
  }
  const calls = {}
  const outcomes = []
  const typed = createVariantPictureQueue((layout) => { calls[layout] = (calls[layout] ?? 0) + 1; return Promise.resolve(script[layout].shift()) }, (layout, mark) => outcomes.push([layout, mark]), { ...own(), schedule: now })
  typed.reset('k', { outlinePath: 'a.md', outline: 't', slideId: 'five' })
  typed.want(['grey', 'bad', 'busy'])
  for (let i = 0; i < 8; i += 1) await tick()
  assert.deepEqual(outcomes.sort(), [['bad', null], ['busy', 'u-busy'], ['grey', { reason: 'Needs an image' }]])
  assert.deepEqual(calls, { grey: 1, bad: 1, busy: 3 })
})

await testAsync('picture policy: superseded is asked again only while wanted, with backoff, then given up', async () => {
  // One policy for both surfaces: growing pauses, a limit, and failures counted apart.
  const steps = []
  let counts = { failed: 0, superseded: 0 }
  for (let i = 0; i < VARIANT_PICTURE_POLICY.maxAskAgain + 1; i += 1) {
    const step = nextPictureStep({ status: 'superseded', slideId: 's' }, counts)
    steps.push(step)
    if (step.kind === 'later') counts = step.counts
  }
  const pauses = steps.filter((step) => step.kind === 'later').map((step) => step.ms)
  assert.equal(pauses.length, VARIANT_PICTURE_POLICY.maxAskAgain)
  assert(pauses.every((ms, index) => index === 0 || ms > pauses[index - 1]), `pauses grow (${pauses})`)
  assert(pauses[0] >= 400, 'never a quick blind re-ask')
  assert.deepEqual(steps.at(-1), { kind: 'settle', mark: null }, 'given up: the sample shows')
  // A superseded request whose row scrolled away is not asked again.
  const timers = []
  const asked = []
  const queue = createVariantPictureQueue((layout) => { asked.push(layout); return Promise.resolve({ status: 'superseded', slideId: 's' }) }, () => {},
    { slots: createVariantPictureSlots(3), schedule: (run, ms) => timers.push({ run, ms }) })
  queue.reset('k', { outlinePath: 'a.md', outline: 't', slideId: 's' })
  queue.want(['gone', 'kept'])
  await new Promise((resolve) => setTimeout(resolve))
  assert.deepEqual(asked, ['gone', 'kept'])
  queue.want(['kept'])
  timers.splice(0).forEach(({ run }) => run())
  await new Promise((resolve) => setTimeout(resolve))
  assert.deepEqual(asked, ['gone', 'kept', 'kept'], 'only the still-wanted picture is asked again')
  assert(timers.length === 1 && timers[0].ms > 400, 'the second pause is longer')
})

await testAsync('picture slots: one window-wide budget shared by every surface', async () => {
  const slots = createVariantPictureSlots(3)
  const gates = []
  const hold = () => new Promise((resolve) => gates.push(resolve))
  const picker = createVariantPictureQueue(() => hold(), () => {}, { slots })
  const inspector = createVariantPictureQueue(() => hold(), () => {}, { slots })
  picker.reset('p', {}); inspector.reset('i', {})
  picker.want(['a', 'b'])
  inspector.want(['x', 'y', 'z'])
  assert.equal(picker.inFlight() + inspector.inFlight(), 3, 'never more than the budget out at once')
  gates.shift()({ status: 'ok', slideId: 's', url: 'u', cached: false })
  await new Promise((resolve) => setTimeout(resolve))
  assert.equal(slots.inUse(), 3, 'a freed slot goes to a waiting surface')
  assert.equal(inspector.inFlight(), 2)
  inspector.dispose()
})

test('render verdicts grey a row as the registry does: aria-disabled, ↵ blocked, the reason shown', () => {
  const usable = five.entries.find((entry) => entry.usable && entry.kind === 'layout' && !five.suggested.some((s) => s.layout === entry.name))
  const judged = withRenderVerdicts(five, { [usable.name]: 'Needs an image' })
  const entry = judged.entries.find((candidate) => candidate.name === usable.name)
  assert.equal(entry.usable, false)
  assert.equal(entry.reason, 'Needs an image')
  assert.equal(withRenderVerdicts(five, {}), five, 'no verdicts, the same catalog')
  const state = reducePicker(judged, initialPickerState(), { type: 'query', query: usable.label })
  const view = pickerView(judged, state)
  const focused = reducePicker(judged, state, { type: 'point', key: stopKey(view.rows.flat().find((stop) => stop.kind === 'layout' && stop.name === usable.name)) })
  assert.deepEqual(pickerCommit(judged, pickerView(judged, focused), focused), { blocked: 'Needs an image' })
  assert.equal(pickerTry(judged, pickerView(judged, focused), focused), null, 'a greyed row is not tried')
  // The column reads usability and its tooltip from the judged catalog only.
  const column = readFileSync(new URL('../src/renderer/src/components/LayoutPickerColumn.tsx', import.meta.url), 'utf8')
  assert(column.includes("'aria-disabled': !entry.usable || undefined") && column.includes('title: entry.usable ? entry.fits : entry.reason'))
  assert(column.includes('withRenderVerdicts(baseCatalog, greyReasons(own))'))
  assert(!column.includes('!== false'), 'no second, render-only greying path')
})

if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('layout picker column model: all checks pass')
