import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EditorState } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { listSlideBlocks } from '../compiler/scripts/lib/slide-blocks.mjs'
import { resolveSlideId } from '../compiler/scripts/lib/slide-id.mjs'
import { replaceDocTransaction } from '../src/renderer/src/lib/replaceDocTransaction.ts'
import { applySlideMerge, planSlideMerge } from '../src/shared/outline-merge.ts'

const intro = '---\ntitle: Merge fixture\n---\n\n'
const block = (id, body, title = 'Slide ' + id) => `### ${title}\n${id ? `{id=${id}}\n` : ''}\n${body}\n\n`
const before = block('a', 'before')
const here = block('a', 'window words')
const there = block('a', 'disk words')
const planFor = (base, mine, disk) => planSlideMerge(intro + base, intro + mine, intro + disk)
const apply = (plan, choices) => {
  const result = applySlideMerge(plan, choices)
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.text
}
const idsIn = text => {
  const lines = text.split('\n')
  return listSlideBlocks(text).map(({start, end}) => resolveSlideId(lines, start, end)?.id)
}

for (const [name, base, mine, disk, choice, warns] of [
  ['changed-here', before, here, before, 'mine', true],
  ['changed-on-disk', before, before, there, 'disk', false],
  ['changed-in-both', before, here, there, undefined, true],
  ['added-on-disk', '', '', there, 'disk', false],
  ['removed-on-disk', before, before, '', 'disk', false],
  ['added-here', '', here, '', 'mine', true],
  ['removed-here', before, '', before, 'mine', true],
  ['removed-on-disk', before, here, '', undefined, true],
  ['removed-here', before, '', there, undefined, true],
  ['changed-in-both', '', here, there, undefined, true],
]) {
  test(`${name}: ${base && mine && disk ? 'edits' : 'presence'} ${choice ?? 'explicit'} (${warns ? 'discards window edits' : 'keeps window edits'})`, () => {
    const tail = block('tail', 'unchanged')
    const plan = planFor(base + tail, mine + tail, disk + tail)
    assert.equal(plan.rows.length, 1)
    const [row] = plan.rows
    assert.equal(row.status, name)
    assert.equal(row.defaultChoice, choice)
    assert.equal(row.diskDiscardsWindowEdits, warns)
    assert.equal(row.base?.text ?? '', base)
    assert.equal(row.mine?.text ?? '', mine)
    assert.equal(row.disk?.text ?? '', disk)
    if (choice) assert.equal(apply(plan), intro + (choice === 'mine' ? mine : disk) + tail)
    else {
      assert.deepEqual(applySlideMerge(plan), { ok: false, reason: 'unresolved', keys: [row.key] })
      assert.equal(apply(plan, { [row.key]: 'mine' }), intro + mine + tail)
      assert.equal(apply(plan, { [row.key]: 'disk' }), intro + disk + tail)
    }
  })
}

test('agreed edits and deletions need no choices, and talk details are separate', () => {
  const plan = planSlideMerge(intro + before + block('b', 'Gone'), intro + here, intro.replace('Merge fixture', 'New title') + here)
  assert.deepEqual(plan.rows, [])
  assert.equal(plan.details.status, 'changed-on-disk')
  assert.equal(apply(plan), intro.replace('Merge fixture', 'New title') + here)
  const detailsConflict = planSlideMerge(intro, intro.replace('Merge', 'Window'), intro.replace('Merge', 'Disk'))
  assert.equal(detailsConflict.details.defaultChoice, undefined)
  assert.deepEqual(applySlideMerge(detailsConflict), { ok: false, reason: 'unresolved', keys: [detailsConflict.details.key] })
})

test('IDs survive renamed headings, while unstamped siblings match by heading and occurrence', () => {
  const loose = (body, title = 'Repeated') => block('', body, title)
  const base = before + loose('first') + block('b', 'separator') + loose('second')
  const mine = here + loose('first') + block('b', 'separator') + loose('edited second')
  const disk = block('a', 'before', 'Renamed') + block('c', 'new') + loose('first') + block('b', 'separator') + loose('second')
  const plan = planFor(base, mine, disk)
  assert.deepEqual(plan.rows.map(row => row.status), ['changed-in-both', 'added-on-disk', 'changed-here'])
  assert.equal(plan.rows[0].disk.title, 'Renamed')
  assert.equal(plan.rows[2].mine.number, 4)
  assert.equal(plan.rows[2].disk.number, 5)
  assert.deepEqual(idsIn(apply(plan, {[plan.rows[0].key]: 'mine'})), ['a', 'c', undefined, 'b', undefined])
  const stripped = planFor(before, here, loose('disk without id', 'Slide a'))
  assert.deepEqual(stripped.rows.map(row => row.status), ['removed-on-disk', 'added-on-disk'])
  const unstampedDiskSlide = stripped.rows[1]
  assert.equal(unstampedDiskSlide.defaultChoice, undefined)
  assert.match(apply(stripped, {'id:a': 'mine', [unstampedDiskSlide.key]: 'disk'}), /window words[\s\S]*disk without id/)
  const layout = planFor(loose('text'), loose('typed'), loose('text', 'Repeated {statement}'))
  assert.deepEqual(layout.rows.map(row => row.status), ['changed-in-both'], 'a trigger change leaves the unstamped visible heading intact')
})

test('byte-exact word diff includes punctuation and never includes neighbouring text', () => {
  const mine = block('a', 'A blue word, today.') + block('b', 'neighbour text')
  const disk = block('a', 'A green word! today.') + block('b', 'neighbour text')
  const plan = planFor(mine, mine, disk)
  const { diff } = plan.rows[0]
  assert.equal(diff.filter(x => x.kind !== 'added').map(x => x.text).join(''), block('a', 'A blue word, today.'))
  assert.equal(diff.filter(x => x.kind !== 'removed').map(x => x.text).join(''), block('a', 'A green word! today.'))
  assert.deepEqual(diff.filter(x => x.kind === 'removed').map(x => x.text), ['blue', ','])
  assert.deepEqual(diff.filter(x => x.kind === 'added').map(x => x.text), ['green', '!'])
})

test('Keep both puts the disk slide directly after the window slide and gives it a fresh ID', () => {
  const same = block('b', 'unchanged')
  const inline = there.replace('### Slide a\n{id=a}', '### Slide a {id=a} {statement}')
  const plan = planFor(before + same, here + same, inline + same)
  const choice = { [plan.rows[0].key]: 'both' }
  const text = apply(plan, choice)
  const [a, copy, b] = idsIn(text)
  assert.deepEqual([a, b], ['a', 'b'])
  assert.match(copy, /^[a-z0-9]{5}$/)
  assert.equal(new Set([a, copy, b]).size, 3)
  assert.equal(text, intro + here + inline.replace('{id=a}', `{id=${copy}}`) + same)
  assert.equal(apply(plan, choice), text, 'the engine is deterministic')
  const unstamped = planFor(block('', 'old', 'Same'), block('', 'typed', 'Same'), block('', 'disk', 'Same'))
  const unstampedIds = idsIn(apply(unstamped, {[unstamped.rows[0].key]: 'both'}))
  assert.equal(unstampedIds[0], undefined, 'only the copy gets an ID')
  assert.match(unstampedIds[1], /^[a-z0-9]{5}$/)
  const added = planFor('', '', there)
  assert.deepEqual(applySlideMerge(added, {[added.rows[0].key]: 'both'}), {ok: false, reason: 'invalid-choice', keys: [added.rows[0].key]})
})

test('moves preserve text, and incompatible reorders require an order choice', () => {
  const b = block('b', 'B')
  const c = block('c', 'C')
  const plan = planFor(before + b + c, here + b + c, c + before + b)
  assert.deepEqual(plan.rows.map(row => row.status), ['changed-here'])
  assert.equal(plan.order.status, 'changed-on-disk')
  assert.equal(apply(plan), intro + c + here + b)
  const conflict = planFor(before + b + c, b + before + c, before + c + b)
  assert.deepEqual(applySlideMerge(conflict), {ok:false, reason:'unresolved', keys:[conflict.order.key]})
  assert.equal(apply(conflict, {[conflict.order.key]:'disk'}), intro + before + c + b)
  const newSlides = planFor(before, before + b + c, before + c + b)
  assert.deepEqual(newSlides.rows, [], 'the new slide texts agree')
  assert.deepEqual(applySlideMerge(newSlides), {ok:false, reason:'unresolved', keys:[newSlides.order.key]})
  assert.equal(apply(newSlides, {[newSlides.order.key]:'disk'}), intro + before + c + b)
})

test('refuses duplicate source IDs and choices that hide a following slide in an open fence', () => {
  const duplicate = planFor(before, here, before + there)
  assert.deepEqual(applySlideMerge(duplicate), {ok:false, reason:'duplicate-ids', ids:['a']})
  const unfinished = block('a', '\x60\x60\x60md\nunfinished').trimEnd()
  const plan = planFor(before, unfinished, before + block('b', 'disk addition'))
  assert.deepEqual(applySlideMerge(plan, {'id:b': 'disk'}), {ok:false, reason:'unsafe-structure'})
  assert.equal(apply(plan, {'id:a': 'disk', 'id:b': 'disk'}), intro + before + block('b', 'disk addition'))
})

test('preserves source bytes across BOM, CRLF, mixed separators and EOF without a newline', () => {
  const mine = '\ufeff' + (intro + here).trimEnd().replaceAll('\n', '\r\n')
  const disk = intro + there + block('b', 'disk additional')
  const plan = planSlideMerge(intro + before, mine, disk)
  const [a, b] = plan.rows
  assert.equal(apply(plan, {[a.key]: 'mine', [b.key]: 'mine'}), mine)
  assert.equal(apply(plan, {[a.key]: 'mine', [b.key]: 'disk'}), mine + '\r\n' + block('b', 'disk additional'))
  assert.equal(apply(plan, {[a.key]: 'disk', [b.key]: 'disk'}), disk)
  assert.equal(apply(planSlideMerge(intro + before, intro + before, disk.replaceAll('\n', '\r\n'))), disk.replaceAll('\n', '\r\n'))
})

test('front matter, fenced examples and comments stay with their source bytes', () => {
  const details = '---\ntitle: A title\n## YAML comment\n---\n\n'
  const a = block('a', '\x60\x60\x60\x60md\n## In a code fence\n\x60\x60\x60\n\x60\x60\x60\x60\n<!--\n## In a comment\n-->\nContent')
  const plan = planSlideMerge(details + a, details.replace('A title', 'A revised title') + a, details + a.replace('Content', 'Edited content'))
  assert.deepEqual(plan.rows.map(row => row.key), ['id:a'])
  assert.equal(plan.rows[0].base.line, 6)
  assert.equal(apply(plan, {'id:a': 'disk'}), details.replace('A title', 'A revised title') + a.replace('Content', 'Edited content'))
})

test('800 seeded triples retain every chosen slide, mint unique IDs, and undo byte-exactly', () => {
  let seed = 0xfa6d103
  const rand = n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed >>> 8) % n
  }
  const version = (ids, side, round) => ids.flatMap(id => {
    const action = rand(4)
    return action === 0 ? [] : [{id, body: action === 1 ? `{base:${id}:${round}}` : `{${side}:${id}:${round}}`}]
  })
  const markdown = items => intro + items.map(({id, body}) => block(id, body)).join('')
  for (let round = 0; round < 800; round++) {
    const ids = Array.from({ length: 2 + rand(9) }, (_, i) => 's' + i)
    const base = ids.map(id => ({ id, body: `{base:${id}:${round}}` }))
    const mine = version(ids.concat('new-here'), 'mine', round)
    const disk = version(ids.concat('new-disk'), 'disk', round)
    if (rand(3) === 0) mine.reverse()
    if (rand(3) === 0) disk.reverse()
    const plan = planSlideMerge(markdown(base), markdown(mine), markdown(disk))
    const choices = {}
    for (const row of plan.rows) {
      const windowSlide = mine.find(item => `id:${item.id}` === row.key)
      assert.equal(row.mine?.text, windowSlide && block(windowSlide.id, windowSlide.body))
      if (!row.defaultChoice) {
        choices[row.key] = row.mine && row.disk && rand(2) === 0 ? 'both' : 'mine'
      }
    }
    if (plan.order && !plan.order.defaultChoice) choices[plan.order.key] = 'mine'
    const merged = apply(plan, choices)
    const expectedBodies = []
    for (const id of ids.concat('new-here', 'new-disk')) {
      const b = base.find(item => item.id === id)?.body
      const m = mine.find(item => item.id === id)?.body
      const d = disk.find(item => item.id === id)?.body
      if (choices['id:' + id] === 'mine') expectedBodies.push(m)
      else if (choices['id:' + id] === 'both') expectedBodies.push(m, d)
      else if (m === d) expectedBodies.push(m)
      else if (m === b) expectedBodies.push(d)
      else if (d === b) expectedBodies.push(m)
      else if (!m || !d) expectedBodies.push(m ?? d)
      else expectedBodies.push(m)
    }
    const bodyMarkers = merged.match(/\{(?:base|mine|disk):[^}]+\}/g) ?? []
    assert.deepEqual(bodyMarkers.sort(), expectedBodies.filter(Boolean).sort(), `round ${round}`)
    const idsAfter = idsIn(merged)
    assert.equal(idsAfter.length, bodyMarkers.length)
    assert.equal(new Set(idsAfter).size, idsAfter.length)
    const onlyMine = Object.fromEntries(plan.rows.map(row => [row.key, 'mine']))
    if (plan.order) onlyMine[plan.order.key] = 'mine'
    assert.equal(apply(plan, onlyMine), markdown(mine), `choosing the window round-trips its bytes in round ${round}`)
    const onlyDisk = Object.fromEntries(plan.rows.map(row => [row.key, 'disk']))
    if (plan.order) onlyDisk[plan.order.key] = 'disk'
    assert.equal(apply(plan, onlyDisk), markdown(disk), `choosing disk round-trips its bytes in round ${round}`)
    let state = EditorState.create({ doc: markdown(base), extensions: history() })
    const originalTyping = replaceDocTransaction(state.doc.toString(), markdown(mine))
    if (originalTyping) state = state.update(originalTyping, { userEvent: 'input.type' }).state
    const transaction = replaceDocTransaction(state.doc.toString(), merged, {ownUndoStep:true})
    if (transaction) {
      state = state.update(transaction).state
      assert.equal(undo({ state, dispatch: tr => { state = tr.state } }), true)
    }
    assert.equal(state.doc.toString(), markdown(mine), `undo in round ${round}`)
    if (originalTyping) {
      assert.equal(undo({ state, dispatch: tr => { state = tr.state } }), true)
      assert.equal(state.doc.toString(), markdown(base), `undo before the merge in round ${round}`)
    }
  }
})
