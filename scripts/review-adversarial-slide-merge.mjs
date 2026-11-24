// Opus's PR 512 probes, with assertions for the corrected behaviour.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listSlideBlocks } from '../compiler/scripts/lib/slide-blocks.mjs'
import { resolveSlideId, slideIdsInPrelude } from '../compiler/scripts/lib/slide-id.mjs'
import { parseOutlineTree } from '../compiler/scripts/lib/14-outline-tree.mjs'
import { blankHtmlCommentsKeepingCaptureMarkers } from '../compiler/scripts/lib/live-page-capture-markup.mjs'
import { applySlideMerge, planSlideMerge, mergeOutline, normalizeOutlineMergeText } from '../src/shared/outline-merge.ts'

const intro = '---\ntitle: T\n---\n\n'
const block = (id, body, title = 'Slide ' + id, depth = 3) => `${'#'.repeat(depth)} ${title}\n${id ? `{id=${id}}\n` : ''}\n${body}\n\n`
const loose = (body, title = 'Example') => block('', body, title)
const kept = (plan, choices, reservedIds) => {
  const out = applySlideMerge(plan, choices, reservedIds)
  assert.equal(out.ok, true, JSON.stringify(out))
  return out.text
}
const explicit = (plan, keys) => {
  assert.deepEqual(applySlideMerge(plan), { ok: false, reason: 'unresolved', keys })
}
const keepUnresolved = plan => Object.fromEntries(
  [...plan.rows, plan.details, plan.order].filter(row => row && !row.defaultChoice).map(row => [row.key, 'mine'])
)
const parents = text => {
  const result = new Map()
  const walk = node => {
    for (const child of node.children) {
      result.set(child.id, node.id)
      walk(child)
    }
  }
  walk(parseOutlineTree(blankHtmlCommentsKeepingCaptureMarkers(normalizeOutlineMergeText(text))).root)
  return result
}

test('F1: dirty editor and truncated disk require a choice per missing trailing slide', () => {
  const base = intro + block('a', 'alpha') + block('b', 'bravo') + block('c', 'charlie') + block('d', 'delta')
  const mine = base.replace('alpha', 'alpha EDITED')
  const disk = base.slice(0, base.indexOf('### Slide c'))
  const plan = planSlideMerge(base, mine, disk)
  explicit(plan, ['id:c', 'id:d'])
  assert.equal(kept(plan, { 'id:a': 'mine', 'id:c': 'mine', 'id:d': 'mine' }), mine)
  assert.equal(mergeOutline(base, mine, disk).conflicts.length, 2)
  assert.equal(kept(plan, { 'id:a': 'mine', 'id:c': 'disk', 'id:d': 'disk' }), mine.slice(0, mine.indexOf('### Slide c')))
  const editedPrefix = disk.replace('bravo', 'bravo disk edit')
  const changed = planSlideMerge(base, mine, editedPrefix)
  explicit(changed, ['id:b', 'id:c', 'id:d'])
  assert.equal(kept(changed, { ...keepUnresolved(changed), 'id:b': 'disk' }), mine.replace('bravo', 'bravo disk edit'))
})

test('F1b: zero-byte reads clear every default, including talk details', () => {
  const base = intro + block('a', 'alpha') + block('b', 'bravo') + block('c', 'charlie')
  const mine = base.replace('bravo', 'bravo EDITED') + block('local', 'written here')
  for (const window of [mine, base]) {
    const plan = planSlideMerge(base, window, '')
    const keys = [...plan.rows.map(row => row.key), 'talk-details']
    explicit(plan, keys)
    assert.equal(kept(plan, keepUnresolved(plan)), window)
    assert.equal(kept(plan, Object.fromEntries(keys.map(key => [key, 'disk']))), '')
  }
})

test('F1c: a nonempty partial slide requires a choice too', () => {
  const base = intro + block('a', 'alpha') + block('b', 'bravo line one\nbravo line two')
  const mine = base.replace('alpha', 'alpha EDITED')
  const disk = base.slice(0, base.indexOf('bravo line two'))
  const plan = planSlideMerge(base, mine, disk)
  explicit(plan, ['id:b'])
  assert.equal(kept(plan, { 'id:a': 'mine', 'id:b': 'mine' }), mine)
})

for (const [probe, tail] of [['P1', ''], ['P6', block('d', 'delta')]]) {
  test(`${probe}: an earlier disk edit cannot hide a partial slide at the end of the read`, () => {
    const base = intro + block('a', 'alpha') + block('b', 'bravo') + block('c', 'charlie line one\ncharlie line two\ncharlie line three') + tail
    const mine = base.replace('alpha', 'edited alpha')
    const edited = base.replace('bravo', 'bravo edited on disk')
    const disk = edited.slice(0, edited.indexOf('charlie line two'))
    const blocked = tail ? ['id:c', 'id:d'] : ['id:c']
    for (const snapshot of [disk, disk + '\uFFFD']) {
      const plan = planSlideMerge(base, mine, snapshot)
      assert.equal(plan.rows.find(row => row.key === 'id:b').defaultChoice, 'disk')
      explicit(plan, blocked)
      assert.equal(kept(plan, keepUnresolved(plan)), mine.replace('bravo', 'bravo edited on disk'))
    }
  })
}

const threeLines = 'charlie line one\ncharlie line two\ncharlie line three'
const threeSlides = intro + block('a', 'alpha') + block('b', 'bravo') + block('c', threeLines)
const windowEdit = threeSlides.replace('alpha', 'edited alpha')
const editedDisk = threeSlides.replace('charlie line one', 'charlie ONE disk')

for (const [variant, cut] of [
  ['after a line', 'charlie ONE disk\n'],
  ['with a decoding replacement character', 'charlie ONE disk\n\uFFFD'],
  ['mid-line', 'charlie ONE di']
]) {
  test(`T1: a changed final disk slide cut ${variant} requires a choice`, () => {
    const disk = editedDisk.slice(0, editedDisk.indexOf('charlie ONE disk')) + cut
    const plan = planSlideMerge(threeSlides, windowEdit, disk)
    assert.equal(plan.rows.find(row => row.key === 'id:c').status, 'changed-on-disk')
    explicit(plan, ['id:c'])
    assert.equal(kept(plan, { 'id:c': 'mine' }), windowEdit)
    assert.equal(kept(plan, { 'id:c': 'disk' }), disk.replace('alpha', 'edited alpha'))
    const clean = planSlideMerge(threeSlides, threeSlides, disk)
    assert.equal(clean.rows[0].defaultChoice, 'disk')
    assert.equal(kept(clean), disk)
  })
}

test('T1 with a new slide after C: complete C keeps its disk default and clipped D requires a choice', () => {
  const disk = editedDisk + '### Slide d\n{id=d}\n\nnew disk slide mid-li'
  const plan = planSlideMerge(threeSlides, windowEdit, disk)
  assert.equal(plan.rows.find(row => row.key === 'id:c').defaultChoice, 'disk')
  assert.equal(plan.rows.find(row => row.key === 'id:d').status, 'added-on-disk')
  explicit(plan, ['id:d'])
  assert.equal(kept(plan, { 'id:d': 'mine' }), editedDisk.replace('alpha', 'edited alpha'))
  assert.equal(kept(plan, { 'id:d': 'disk' }), disk.replace('alpha', 'edited alpha'))
})

for (const [probe, id] of [['N1', 'a'], ['N2', 'c']]) {
  test(`${probe}: appending in the window keeps its default when disk is unchanged`, () => {
    const body = id === 'a' ? 'alpha' : threeLines
    const mine = threeSlides.replace(body, body + '\nan added window line')
    const plan = planSlideMerge(threeSlides, mine, threeSlides)
    assert.equal(plan.rows.find(row => row.key === `id:${id}`).defaultChoice, 'mine')
    assert.equal(kept(plan), mine)
  })
}

for (const [probe, dirty] of [['N3', false], ['N4', true]]) {
  test(`${probe}: a trim to a non-final disk slide keeps its default with the window ${dirty ? 'dirty' : 'clean'}`, () => {
    const base = threeSlides.replace('bravo', 'bravo first line\nbravo last line')
    const mine = dirty ? base.replace('alpha', 'edited alpha') : base
    const disk = base.replace('\nbravo last line', '')
    const plan = planSlideMerge(base, mine, disk)
    assert.equal(plan.rows.find(row => row.key === 'id:b').defaultChoice, 'disk')
    assert.equal(kept(plan), mine.replace('\nbravo last line', ''))
  })
}

test('a shortened disk preamble keeps its default when slides follow it', () => {
  const finalPreambleLine = 'Preamble second line'
  const base = intro + 'Preamble first line\n' + finalPreambleLine + '\n\n' + block('a', 'alpha') + block('b', 'bravo') + block('c', 'charlie')
  const mine = base.replace('alpha', 'edited alpha')
  const disk = base.replace(finalPreambleLine + '\n', '').replace('bravo', 'bravo edited on disk')
  const plan = planSlideMerge(base, mine, disk)
  assert.equal(plan.details.defaultChoice, 'disk')
  assert.equal(kept(plan), disk.replace('alpha', 'edited alpha'))
})

test('a disk edit to talk details without slides requires a choice', () => {
  const disk = intro.replace('title: T', 'title: Rewritten')
  const plan = planSlideMerge(intro, intro, disk)
  explicit(plan, ['talk-details'])
  assert.equal(kept(plan, { 'talk-details': 'disk' }), disk)
  const windowOnly = planSlideMerge(threeSlides, threeSlides.replace('title: T', 'title: Local'), intro)
  assert.equal(windowOnly.details.defaultChoice, 'mine')
})

test('F2: inserting an unstamped duplicate keeps the unchanged slide and the edited window slide', () => {
  const base = intro + loose('AAA') + loose('BBB')
  const mine = intro + loose('AAA') + loose('BBB edited')
  const disk = intro + loose('NEW') + loose('AAA') + loose('BBB')
  const plan = planSlideMerge(base, mine, disk)
  assert.equal(plan.rows.filter(row => row.mine && row.disk).length, 0)
  assert.deepEqual(plan.rows.map(row => row.status).sort(), ['added-on-disk', 'added-on-disk', 'removed-on-disk'])
  const lastDiskRow = plan.rows.find(row => row.disk?.text === loose('BBB'))
  assert.equal(lastDiskRow.defaultChoice, undefined)
  const text = kept(plan, { ...keepUnresolved(plan), [lastDiskRow.key]: 'disk' })
  for (const body of ['AAA', 'NEW', 'BBB', 'BBB edited']) assert.ok(text.includes(`\n${body}\n`), body)
})

test('F2b: deleting one unstamped duplicate cannot drop the unchanged other slide', () => {
  const base = intro + loose('AAA') + loose('BBB')
  const mine = intro + loose('AAA edited') + loose('BBB')
  const disk = intro + loose('BBB')
  const plan = planSlideMerge(base, mine, disk)
  assert.equal(plan.rows.length, 1)
  assert.equal(plan.rows[0].status, 'removed-on-disk')
  explicit(plan, [plan.rows[0].key])
  assert.equal(kept(plan, { [plan.rows[0].key]: 'mine' }), mine)
  assert.equal(kept(plan, { [plan.rows[0].key]: 'disk' }), disk)
})

test('F3: a section copy follows its entire subtree', () => {
  const sec = body => block('s', body, 'Section', 2)
  const child = block('c', 'child body', 'Child', 3)
  const mine = intro + sec('window') + child
  const plan = planSlideMerge(intro + sec('old') + child, mine, intro + sec('disk') + child)
  const text = kept(plan, { 'id:s': 'both' })
  const structure = parents(text)
  assert.equal(structure.get('c'), 's')
  assert.deepEqual([...structure.keys()].slice(0, 2), ['s', 'c'])
  assert.equal(structure.size, 3)
})

test('F4: the copy keeps one ID token and preserves other triggers and body text', () => {
  const tricky = '### Slide a\n{id=zzold} {statement}\n{id=a} {id=extra}\n\ndisk text mentions {id=literal}\n\n'
  const plan = planSlideMerge(intro + block('a', 'base'), intro + block('a', 'window'), intro + tricky)
  const text = kept(plan, { 'id:a': 'both' })
  const lines = text.split('\n')
  const copy = listSlideBlocks(text)[1]
  const id = resolveSlideId(lines, copy.start, copy.end)?.id
  assert.match(id, /^[a-z0-9]{5}$/)
  assert.deepEqual(slideIdsInPrelude(lines, copy.start, copy.end).map(item => item.id), [id])
  assert.ok(text.includes('{statement}'))
  assert.ok(text.includes('disk text mentions {id=literal}'))
})

test('F5: ambiguous ancestry in a duplicate-ID base is refused', () => {
  const base = intro + block('a', 'one') + block('a', 'two')
  const fixed = intro + block('a', 'one') + block('b', 'two')
  const plan = planSlideMerge(base, fixed.replace('one', 'one win'), fixed.replace('two', 'two disk'))
  assert.deepEqual(applySlideMerge(plan), { ok: false, reason: 'duplicate-ids', ids: ['a'] })
})

test('F6: both duplicate-ID blocks remain visible to review and Apply is refused', () => {
  const mine = intro + block('a', 'first copy') + block('a', 'second copy')
  const plan = planSlideMerge(intro + block('a', 'x'), mine, intro + block('a', 'y'))
  assert.deepEqual(plan.rows.map(row => row.mine.text), [block('a', 'first copy'), block('a', 'second copy')])
  assert.deepEqual(applySlideMerge(plan), { ok: false, reason: 'duplicate-ids', ids: ['a'] })
})

test('F7: a window-only reorder and a disk append both survive', () => {
  const a = block('a', 'A'), b = block('b', 'B'), c = block('c', 'C')
  const plan = planSlideMerge(intro + a + b, intro + b + a, intro + a + b + c)
  assert.equal(plan.order.defaultChoice, 'mine')
  explicit(plan, ['id:c'])
  assert.equal(kept(plan, { 'id:c': 'disk' }), intro + b + a + c)
})

test('F8: CRLF window with LF disk keeps both slide bodies and the appended slide', () => {
  const crlf = s => s.replaceAll('\n', '\r\n')
  const window = crlf(intro + block('a', 'window'))
  const plan = planSlideMerge(intro + block('a', 'base'), window, intro + block('a', 'disk') + block('b', 'more'))
  const text = kept(plan, { 'id:a': 'both', 'id:b': 'disk' })
  assert.ok(text.startsWith(window))
  assert.match(text, /\ndisk\n\n### Slide b/)
  assert.ok(text.endsWith(block('b', 'more')))
})

test('F3b: copying a carousel and an item preserves each original item parent', () => {
  const parent = body => `## Tour {carousel}\n{id=p}\n\n${body}\n\n`
  const item = (id, body) => block(id, body, 'Item ' + id, 3)
  const base = intro + parent('intro') + item('i1', 'one') + item('i2', 'two') + block('z', 'after', 'After', 2)
  const plan = planSlideMerge(base, base.replace('intro', 'intro win').replace('one', 'one win'), base.replace('intro', 'intro disk').replace('one', 'one disk'))
  const text = kept(plan, { 'id:p': 'both', 'id:i1': 'both' })
  const tree = parents(text)
  const [p, i1, i1Copy, i2, pCopy, z] = [...tree.keys()]
  assert.deepEqual([p, i1, i2, z], ['p', 'i1', 'i2', 'z'])
  for (const id of [i1, i1Copy, i2]) assert.equal(tree.get(id), p)
  assert.equal(tree.get(pCopy), tree.get(p))
})

test('Keep both accepts IDs held in the vault ledger as reserved', () => {
  const plan = planSlideMerge(intro + block('a', 'old'), intro + block('a', 'window'), intro + block('a', 'disk'))
  const choice = { 'id:a': 'both' }
  const originalCopy = [...parents(kept(plan, choice)).keys()].at(-1)
  const withReservation = [...parents(kept(plan, choice, [originalCopy])).keys()].at(-1)
  assert.notEqual(withReservation, originalCopy)
  assert.match(withReservation, /^[a-z0-9]{5}$/)
})

function generator(seed) {
  return n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed >>> 8) % n
  }
}

const format = (text, rand) => {
  if (rand(2)) text = text.trimEnd()
  if (rand(2)) text = text.replaceAll('\n', '\r\n')
  return rand(2) ? '\ufeff' + text : text
}

const randomChoices = (plan, rand) => Object.fromEntries(
  [...plan.rows, plan.details, plan.order].filter(Boolean).map(row => {
    const options = row.mine && row.disk && typeof row.mine === 'object' ? ['mine', 'disk', 'both'] : ['mine', 'disk']
    return [row.key, options[rand(options.length)]]
  })
)

test('500 byte truncations leave every window byte intact when the unresolved rows keep it', () => {
  const rand = generator(0x8b015f1)
  for (let round = 0; round < 500; round++) {
    const end = rand(2) ? '\n~~~txt\n## Fenced example\n~~~' : '\n<!--\n## Hidden example\n-->'
    const section = block('parent', 'Zażółć 🧪 parent marker', 'Section {carousel}', 2)
    const stamped = block('a', 'Head marker 🧪')
    const repeats = loose('Unstamped one á') + loose('Unstamped two 漢')
    const base = format(intro + section + stamped + repeats + block('z', 'Tail marker' + end), rand)
    const raw = Buffer.from(base)
    const disk = raw.subarray(0, rand(raw.length)).toString('utf8')
    const mine = base.replace('Head marker', 'Here is my edit').replace('title: T', 'title: T amended')
    const plan = planSlideMerge(base, mine, disk)
    const automatic = applySlideMerge(plan)
    if (automatic.ok) assert.equal(automatic.text, mine, `default result in round ${round}`)
    else assert.equal(automatic.reason, 'unresolved', JSON.stringify({ round, automatic }))
    assert.equal(kept(plan, keepUnresolved(plan)), mine, `keep the window in round ${round}`)
  }
})

test('300 truncated reads of edited disk text preserve independent edits and require choices for clipped slides', () => {
  const rand = generator(0x33c561)
  for (let round = 0; round < 300; round++) {
    const tail = rand(2) ? block('d', 'trailing slide') : ''
    const base = format(intro + block('a', 'alpha') + block('b', 'bravo') + block('c', 'First line 🧪\nSecond line 漢\nLast line of the slide') + tail, rand)
    const mine = base.replace('alpha', 'edited alpha')
    const edited = base.replace('bravo', 'bravo edited on disk')
    const raw = Buffer.from(edited)
    const from = raw.indexOf('First line')
    const to = raw.indexOf('Last line of the slide')
    const disk = raw.subarray(0, from + rand(to - from)).toString('utf8')
    const plan = planSlideMerge(base, mine, disk)
    explicit(plan, tail ? ['id:c', 'id:d'] : ['id:c'])
    assert.equal(kept(plan, keepUnresolved(plan)), mine.replace('bravo', 'bravo edited on disk'), `round ${round}`)
  }
})

test('500 triples with unstamped duplicate pools keep the shared text under random choices', () => {
  const rand = generator(0x17acf49)
  const detail = side => `---\ntitle: T ${side}\n---\n\nPreamble ${side}\n\n`
  const pool = () => Array.from({ length: 1 + rand(6) }, () => rand(7))
  for (let round = 0; round < 500; round++) {
    const before = pool(), here = pool(), there = pool()
    const same = block('shared', 'an unambiguous shared body')
    const outline = (items, side) => detail(side) + items.map(n => loose(`[pool-${n}]`)).join('') + same
    const sources = [outline(before, 'base'), outline(here, 'mine'), outline(there, 'disk')].map(text => format(text, rand))
    const plan = planSlideMerge(...sources)
    assert.equal(new Set(plan.rows.map(row => row.key)).size, plan.rows.length)
    const choices = randomChoices(plan, rand)
    const text = kept(plan, choices)
    assert.equal(text.split('an unambiguous shared body').length, 2)
    for (let n = 0; n < 7; n++) {
      const overlap = Math.min(here.filter(value => value === n).length, there.filter(value => value === n).length)
      assert.ok(text.split(`[pool-${n}]`).length - 1 >= overlap, `round ${round}, shared body ${n}`)
    }
    const actualIds = [...parents(text).keys()].filter(Boolean)
    const copies = Object.values(choices).filter(value => value === 'both').length
    assert.equal(actualIds.length, copies + 1)
    assert.ok(text.includes(`Preamble ${choices['talk-details']}`))
  }
})

test('300 nested section and carousel triples preserve parentage for arbitrary copy and order choices', () => {
  const rand = generator(0x6d79f2a)
  for (let round = 0; round < 300; round++) {
    const entries = [
      ['section', 2, 'Section'],
      ['parent', 3, round % 2 ? 'Tour {carousel}' : 'Topic'],
      ['i1', 4, 'Item 1'],
      ['sub', 5, 'Nested item'],
      ['i2', 4, 'Item 2'],
      ['sibling', 3, 'Sibling'],
      ['after', 2, 'After']
    ]
    const source = (order, side) => intro.replace('title: T', `title: ${side}`) + order.map(([id, depth, title]) => {
      const fence = rand(2) ? '\n~~~md\n#### Fenced\n~~~' : '\n<!--\n#### Commented\n-->'
      return block(id, `[body-${id}-${side}]${fence}`, title, depth)
    }).join('')
    const [section, parent, i1, sub, i2, sibling, after] = entries
    const mine = [after, section, parent, i1, sub, i2, sibling]
    const diskSibling = ['sibling', 2, 'Sibling'] // disk can promote it without promoting a Keep both copy
    const disk = [section, parent, i2, i1, sub, diskSibling, after]
    const plan = planSlideMerge(format(source(entries, 'base'), rand), format(source(mine, 'mine'), rand), format(source(disk, 'disk'), rand))
    const choices = randomChoices(plan, rand)
    const withoutCopies = Object.fromEntries(Object.entries(choices).map(([key, choice]) => [key, choice === 'both' ? 'mine' : choice]))
    const reference = parents(kept(plan, withoutCopies))
    const text = kept(plan, choices)
    const output = parents(text)
    for (const [id, originalParent] of reference) assert.equal(output.get(id), originalParent, `round ${round}, ${id}`)
    for (const [id] of entries) {
      const choice = choices[`id:${id}`]
      for (const side of ['mine', 'disk']) assert.equal(text.includes(`[body-${id}-${side}]`), choice === side || choice === 'both')
    }
    assert.equal(output.size, reference.size + Object.values(choices).filter(choice => choice === 'both').length)
  }
})

test('source formats with an open terminal fence or comment cannot swallow a chosen following slide', () => {
  const rand = generator(0xa9281d)
  for (const boundary of ['~~~md\n## Open fence', '<!--\n## Open comment']) {
    for (let i = 0; i < 20; i++) {
      const base = intro + block('a', 'old')
      const mine = format(intro + block('a', boundary), rand)
      const disk = format(base + block('b', 'new disk slide'), rand)
      const plan = planSlideMerge(base, mine, disk)
      assert.deepEqual(applySlideMerge(plan, { 'id:b': 'disk' }), { ok: false, reason: 'unsafe-structure' })
      assert.equal(kept(plan, { 'id:b': 'mine' }), mine)
    }
  }
})

test('90 generated duplicate-ID snapshots keep both blocks available and refuse every set of choices', () => {
  const rand = generator(0xe5f3ca)
  for (let round = 0; round < 90; round++) {
    const id = 'd' + rand(15)
    const ordinary = intro + block(id, 'original') + block('stable', 'shared')
    const versions = [ordinary, ordinary, ordinary]
    const side = round % 3
    versions[side] += block(id, 'duplicate body ' + round)
    const plan = planSlideMerge(...versions.map(text => format(text, rand)))
    const snapshot = plan.versions[['base', 'mine', 'disk'][side]]
    assert.deepEqual([...snapshot.slides.values()].filter(slide => slide.id === id).length, 2)
    assert.deepEqual(applySlideMerge(plan, randomChoices(plan, rand)), { ok: false, reason: 'duplicate-ids', ids: [id] })
  }
})
