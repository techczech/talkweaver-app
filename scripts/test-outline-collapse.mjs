// Which outline sections are collapsed: the pure model (src/renderer/src/lib/outlineCollapse.ts) and
// the per-talk store that remembers it (outlineCollapseStore.ts). Both are the real files: the model
// is imported directly, the store is bundled with esbuild (it imports React and the outline parser).
// Mounting the outline and the grid on top of this is scripts/test-outline-collapse-dom.mjs.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { slideRows } from '../src/renderer/src/extensions/slideOutline.ts'
import * as model from '../src/renderer/src/lib/outlineCollapse.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'talk-weaver-outline-collapse-'))
let passed = 0
const pass = (m) => { passed += 1; console.log(`PASS ${m}`) }

const rowsOf = (doc) => model.keyRows(slideRows(doc))
const J = (...lines) => lines.join('\n')
const keysOf = (doc) => rowsOf(doc).map((r) => r.key)
const state = (keys = [], ghosts = []) => ({ collapsed: new Set(keys), ghosts })
const sorted = (set) => [...set].sort()
// What a user sees: the headings (by text) of the collapsed sections.
const collapsedTexts = (doc, st) => rowsOf(doc).filter((r) => st.collapsed.has(r.key)).map((r) => r.text).sort()

try {
  // ═══ keys ═══
  {
    const doc = ['# Deck', '## Intro', '### A', '{id=a1}', '### B', '## Notes', '### x', '## Notes', '### y', '## Notes {id=n3}', '### z'].join('\n')
    assert.deepEqual(keysOf(doc), [
      'h1:Deck', 'h2:Intro', 'id:a1', 'h3:B', 'h2:Notes', 'h3:x', 'h2:Notes~1', 'h3:y', 'id:n3', 'h3:z'
    ])
    pass('keys: id on the heading or the line below, else level+text, repeats numbered in order (the first keeps the bare key)')
    const rows = rowsOf(doc)
    assert.deepEqual(rows.filter((r) => r.section).map((r) => r.key), ['h1:Deck', 'h2:Intro', 'h2:Notes', 'h2:Notes~1', 'id:n3'])
    assert.equal(model.slideCount(rows, 'h2:Intro'), 2)
    assert.equal(model.slideCount(rows, 'h1:Deck'), 5, 'the deck title counts every slide under it')
    pass('sections are rows with a deeper row after them; slide counts are numbered leaves in the subtree')
  }

  // ═══ hiding, ancestors, subtree ═══
  {
    const doc = ['# Deck', '## S1', '### a', '#### a1', '#### a2', '### b', '## S2', '### c'].join('\n')
    const rows = rowsOf(doc)
    assert.deepEqual([...model.hiddenLines(rows, new Set(['h3:a']))], [4, 5])
    assert.deepEqual([...model.hiddenLines(rows, new Set(['h2:S1']))].sort(), [3, 4, 5, 6])
    assert.deepEqual([...model.hiddenLines(rows, new Set(['h2:S1', 'h3:a']))].sort(), [3, 4, 5, 6], 'a collapsed section inside a collapsed section hides nothing extra')
    assert.deepEqual(model.ancestorKeys(rows, 4), ['h1:Deck', 'h2:S1', 'h3:a'])
    assert.deepEqual(model.ancestorKeys(rows, 8), ['h1:Deck', 'h2:S2'])
    assert.deepEqual(model.subtreeSectionKeys(rows, 'h2:S1'), ['h2:S1', 'h3:a'])
    assert.equal(model.hidingSectionLine(rows, new Set(['h2:S1', 'h3:a']), 4), 2, 'the outermost collapsed section is the one shown for a hidden row')
    assert.equal(model.hidingSectionLine(rows, new Set(), 4), null)
    pass('hiding works at every depth; ancestors and subtree sections are read from the levels')

    // collapse all / expand all / subtree
    assert.deepEqual(sorted(model.collapseAll(rows)), ['h2:S1', 'h2:S2', 'h3:a'], 'collapse all leaves the level-1 title open')
    assert.deepEqual(sorted(model.collapseAll(rowsOf('## S1\n### a\n## S2\n### b'))), ['h2:S1', 'h2:S2'], 'no title: every section')
    assert.equal(model.expandAll().size, 0)
    const input = new Set(['h2:S2'])
    const opened = model.toggleSubtree(rows, new Set(['h2:S1', 'h3:a', 'h2:S2']), 'h2:S1')
    assert.deepEqual(sorted(opened), ['h2:S2'], 'option-click on a collapsed section opens it and every section inside')
    const closed = model.toggleSubtree(rows, input, 'h2:S1')
    assert.deepEqual(sorted(closed), ['h2:S1', 'h2:S2', 'h3:a'], 'option-click on an open section collapses it and every section inside')
    assert.deepEqual(sorted(input), ['h2:S2'], 'the input set is not changed')
    assert.deepEqual(sorted(model.toggleSubtree(rows, new Set(['h3:a']), 'h2:S1')), ['h2:S1', 'h3:a'], 'an open section with a collapsed child collapses (the clicked section decides the direction)')
    pass('collapse all (every level), expand all, option-click subtree toggle both ways, inputs untouched')
  }

  // ═══ reconcile: table ═══
  const BASE = ['# Deck', '## Intro', '### i1', '### i2', '## Method', '### m1', '## Notes', '### n1', '## Notes', '### n2', '## Close', '### c1'].join('\n')
  const lines = BASE.split('\n')
  const edit = (fn) => { const l = [...lines]; fn(l); return l.join('\n') }
  const step = (before, after, st) => model.reconcile(rowsOf(before), rowsOf(after), st)

  // collapsed: Intro, Method, the second Notes
  const start = state(['h2:Intro', 'h2:Method', 'h2:Notes~1'])
  assert.deepEqual(collapsedTexts(BASE, start), ['Intro', 'Method', 'Notes'])

  const cases = [
    ['typing a new slide above them', edit((l) => l.splice(2, 0, '### new above')), ['Intro', 'Method', 'Notes']],
    ['a new section at the top', edit((l) => l.splice(1, 0, '## Fresh', '### f1')), ['Intro', 'Method', 'Notes']],
    ['deleting a slide above', edit((l) => l.splice(2, 1)), ['Intro', 'Method', 'Notes']],
    ['moving Close (with its slide) to the top', (() => { const l = [...lines]; const blk = l.splice(10, 2); l.splice(1, 0, ...blk); return l.join('\n') })(), ['Intro', 'Method', 'Notes']],
    ['moving Method below Close', (() => { const l = [...lines]; const blk = l.splice(4, 2); l.push(...blk); return l.join('\n') })(), ['Intro', 'Method', 'Notes']],
    ['a new section with the same text as the first Notes, above it (so the flagged one is now the third)', edit((l) => l.splice(6, 0, '## Notes', '### nx')), ['Intro', 'Method', 'Notes']],
    ['deleting the FIRST Notes (the flagged second one becomes the only one)', edit((l) => l.splice(6, 2)), ['Intro', 'Method', 'Notes']],
    ['renaming a collapsed section: carried (same place, same level, one for one)', edit((l) => { l[4] = '## Approach' }), ['Approach', 'Intro', 'Notes']],
    ['promoting a collapsed section to a different level: not the same section, not carried', edit((l) => { l[4] = '# Method' }), ['Intro', 'Notes']]
  ]
  for (const [name, after, expected] of cases) {
    const next = step(BASE, after, start)
    const got = collapsedTexts(after, next)
    assert.deepEqual(got, expected, `${name}: collapsed headings`)
    assert.equal(next.collapsed.size, expected.length, `${name}: nothing else became collapsed`)
  }
  pass(`reconcile follows the sections through ${cases.length} edits (insert, delete, move, duplicate headings, rename, level change)`)

  // Which Notes exactly: the flagged second Notes keeps its slide n2 below it.
  {
    const after = edit((l) => l.splice(6, 2)) // first Notes deleted
    const next = step(BASE, after, start)
    const rows = rowsOf(after)
    const notes = rows.find((r) => r.text === 'Notes')
    assert(next.collapsed.has(notes.key))
    const after2 = edit((l) => l.splice(8, 2)) // second Notes deleted instead
    const next2 = step(BASE, after2, start)
    assert(!collapsedTexts(after2, next2).includes('Notes'), 'deleting the flagged Notes leaves the other open')
    assert.deepEqual(next2.ghosts, ['h2:Notes~1'], 'and remembers it as a ghost')
  }
  pass('duplicate headings: deleting the first twin keeps the second collapsed; deleting the flagged twin leaves the survivor open')

  // Ids make a section survive a rename and a move even when its text changes.
  {
    const A = ['## One {id=one}', '### a', '## Two {id=two}', '### b', '## Three', '### c'].join('\n')
    const st = state(['id:one', 'id:two', 'h2:Three'])
    const renamed = ['## Uno {id=one}', '### a', '## Dos {id=two}', '### b', '## Tres', '### c'].join('\n')
    const next = step(A, renamed, st)
    assert.deepEqual(collapsedTexts(renamed, next), ['Dos', 'Tres', 'Uno'], 'ids keep their flag; the one-for-one rename of Three is carried by position')
    // Two renamed and moved at once.
    const moved = ['## Zwei {id=two}', '### b', '## One {id=one}', '### a', '## Three', '### c'].join('\n')
    assert.deepEqual(collapsedTexts(moved, step(A, moved, st)), ['One', 'Three', 'Zwei'], 'id + move + rename')
    // A section whose id is stamped on the line below the heading (how the editor writes it).
    const below = ['## One', '{id=one}', '### a'].join('\n')
    assert.deepEqual(keysOf(below), ['id:one', 'h3:a'])
    // Adding an id to a no-id heading changes its key: the flag is carried by position (same place and level).
    const stamped = ['## One {id=one}', '### a', '## Two {id=two}', '### b', '## Three {id=three}', '### c'].join('\n')
    assert.deepEqual(collapsedTexts(stamped, step(A, stamped, st)), ['One', 'Three', 'Two'], 'stamping an id on a collapsed heading keeps it collapsed')
  }
  pass('ids: renamed, moved, renamed+moved and freshly stamped collapsed sections stay collapsed')

  // Delete then undo: the section comes back collapsed.
  {
    const deleted = edit((l) => l.splice(4, 2)) // Method gone
    const afterDelete = step(BASE, deleted, start)
    assert.deepEqual(collapsedTexts(deleted, afterDelete), ['Intro', 'Notes'])
    assert.deepEqual(afterDelete.ghosts, ['h2:Method'])
    const undone = step(deleted, BASE, afterDelete)
    assert.deepEqual(collapsedTexts(BASE, undone), ['Intro', 'Method', 'Notes'], 'undo of the delete re-collapses the section')
    assert.deepEqual(undone.ghosts, [])
    // Undo of a move.
    const moved = (() => { const l = [...lines]; const blk = l.splice(10, 2); l.splice(1, 0, ...blk); return l.join('\n') })()
    const there = step(BASE, moved, start)
    assert.deepEqual(collapsedTexts(BASE, step(moved, BASE, there)), ['Intro', 'Method', 'Notes'])
  }
  pass('undo: a deleted collapsed section is collapsed again when it comes back; a moved one returns collapsed')

  // Typing inside a section (no heading change) and an unloaded outline change nothing.
  {
    const typed = edit((l) => { l[2] = '### i1' ; l.splice(3, 0, 'body text', '- a bullet') })
    const same = step(BASE, typed, start)
    assert.deepEqual(sorted(same.collapsed), sorted(start.collapsed))
    assert.equal(model.reconcile(rowsOf(BASE), [], start), start, 'an empty outline (not loaded) changes nothing')
    // Several edits in a row.
    let cur = BASE
    let st = start
    for (const next of [edit((l) => l.splice(2, 0, '### p')), edit((l) => l.splice(2, 0, '### p', '### q')), edit((l) => { l.splice(2, 0, '### p', '### q'); l.splice(0, 1) })]) {
      st = step(cur, next, st)
      cur = next
    }
    assert.deepEqual(collapsedTexts(cur, st), ['Intro', 'Method', 'Notes'])
  }
  pass('typing in bodies, an unloaded outline and a run of edits leave the collapsed set alone')

  // Ghost cap.
  {
    let st = state(Array.from({ length: 150 }, (_, i) => `h2:S${i}`))
    const big = Array.from({ length: 150 }, (_, i) => `## S${i}\n### s${i}`).join('\n')
    const gone = '## Only\n### o'
    st = model.reconcile(rowsOf(big), rowsOf(gone), st)
    assert.equal(st.ghosts.length, model.MAX_GHOSTS)
  }
  pass(`ghosts are capped at ${model.MAX_GHOSTS}`)

  // First sight: saved keys that match stay; the rest wait.
  {
    const adopted = model.adoptRows(rowsOf(BASE), new Set(['h2:Intro', 'h2:Gone']))
    assert.deepEqual(sorted(adopted.collapsed), ['h2:Intro'])
    assert.deepEqual(adopted.ghosts, ['h2:Gone'])
  }
  pass('adopting a saved set keeps the keys that match a row and parks the others')

  // ═══ grid <-> outline ═══
  {
    const rows = rowsOf(BASE)
    assert.deepEqual(
      model.matchGroupsToSections(rows, ['', 'Intro', 'Method', 'Notes', 'Notes', 'Close', 'Missing']),
      [null, 'h2:Intro', 'h2:Method', 'h2:Notes', 'h2:Notes~1', 'h2:Close', null]
    )
    assert.deepEqual(model.matchGroupsToSections(rowsOf('## **Bold** one\n### a'), ['Bold one']), ['h2:**Bold** one'])
  }
  pass('grid groups map to outline sections by text and occurrence; slides before any section and unmatched text stay unshared')
  // What the compiler really gives the grid for an outline talk: the section's id when its heading has
  // one, else a slug of its title; the group's title is the heading text (0.38.3-preview.10: matching
  // by text alone matched nothing in the app, so the two views never agreed on a single section).
  {
    const TALK = J('# Deck', '### Welcome', '## Section 1', '{id=q7x2k}', '### a', '## Section 2', '### b', '## Section 3 {id=sec3}', '### c', '## Section 1', '{id=dup1}', '### d', '## Section 2', '### e', '## Été & co.', '### f')
    const rows = rowsOf(TALK)
    const g = (section, title) => ({ section, title })
    assert.deepEqual(
      model.matchGroupsToSections(rows, [g('', '(no section)'), g('q7x2k', 'Section 1'), g('section-2', 'Section 2'), g('sec3', 'Section 3'), g('dup1', 'Section 1'), g('section-2-2', 'Section 2'), g('ete-co', 'Été & co.'), g('', '(no section)')]),
      [null, 'id:q7x2k', 'h2:Section 2', 'id:sec3', 'id:dup1', 'h2:Section 2~1', 'h2:Été & co.', null],
      'by id where the heading has one, by title and occurrence where it has none'
    )
    // The same-titled twin with an id is not taken by title for the earlier group: ids are matched first.
    assert.deepEqual(model.matchGroupsToSections(rowsOf(J('## Notes', '### a', '## Notes', '{id=n2}', '### b')), [g('notes', 'Notes'), g('n2', 'Notes')]), ['h2:Notes', 'id:n2'])
    assert.deepEqual(model.matchGroupsToSections(rowsOf(J('## Notes', '{id=n1}', '### a', '## Notes', '### b')), [g('n1', 'Notes'), g('notes', 'Notes')]), ['id:n1', 'h2:Notes'])
    // No title of its own (no section-title slide): the slug still finds the heading.
    assert.deepEqual(model.matchGroupsToSections(rows, [g('section-2', 'section-2'), g('sec3', 'sec3')]), ['h2:Section 2', 'id:sec3'])
    // The buffer is ahead of the compiled slides (an id just stamped, not yet compiled): the title still matches.
    assert.deepEqual(model.matchGroupsToSections(rowsOf(J('## Section 2', '{id=new1}', '### b')), [g('section-2', 'Section 2')]), ['id:new1'])
    // No section is given to two groups, and a section with nothing under it is not collapsible.
    assert.deepEqual(model.matchGroupsToSections(rowsOf(J('## One', '### a', '## Empty')), [g('one', 'One'), g('one', 'One'), g('empty', 'Empty')]), ['h2:One', null, null])
  }
  pass('grid groups map to outline sections by the section id the compiler gives them, then by title, then by slug')

  // ═══ saved store ═══
  {
    let s = model.emptySaved()
    s = model.putTalk(s, '/a', ['k1', 'k2'], 100)
    s = model.putTalk(s, '/b', ['k3'], 200)
    assert.deepEqual(model.parseSaved(model.serialiseSaved(s)), s, 'round trip')
    assert.deepEqual(Object.keys(model.putTalk(s, '/a', [], 300).talks), ['/b'], 'nothing collapsed = nothing remembered')
    for (const bad of [null, '', 'not json', '{"v":2}', '{"v":1,"talks":{"x":{"keys":"no","at":1}}}', '[]']) {
      assert.deepEqual(model.parseSaved(bad).talks, bad === '{"v":1,"talks":{"x":{"keys":"no","at":1}}}' ? {} : {}, `reads ${bad} as empty`)
    }
    let many = model.emptySaved()
    for (let i = 0; i < model.MAX_TALKS + 25; i += 1) many = model.putTalk(many, `/t${i}`, ['k'], i)
    const names = Object.keys(many.talks)
    assert.equal(names.length, model.MAX_TALKS)
    assert(!names.includes('/t0') && names.includes(`/t${model.MAX_TALKS + 24}`), 'the least recently used talks are dropped')
    const longKeys = Array.from({ length: model.MAX_KEYS_PER_TALK + 50 }, (_, i) => `k${i}`)
    assert.equal(model.putTalk(model.emptySaved(), '/x', longKeys, 1).talks['/x'].keys.length, model.MAX_KEYS_PER_TALK)
  }
  pass('saved store: round trip, tolerant parse, least-recently-used talks and over-long key lists are cut')

  // ═══ the store ═══
  const outfile = join(tmp, 'store.mjs')
  await build({
    entryPoints: [join(root, 'src/renderer/src/lib/outlineCollapseStore.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error'
  })
  const store = await import(pathToFileURL(outfile).href)
  const memory = () => {
    const data = new Map()
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) }, data }
  }
  let disk = memory()
  let t = 1000
  const fresh = (keepDisk = true) => { if (!keepDisk) disk = memory(); store.resetOutlineCollapseForTests({ storage: disk, now: () => t++ }) }
  const talk = '/vault/talk/talk-outline.md'

  fresh(false)
  store.publishOutline(talk, BASE)
  store.toggleSection(talk, 'h2:Intro')
  store.toggleSection(talk, 'h2:Method')
  assert.deepEqual(sorted(store.getCollapseSnapshot(talk).collapsed), ['h2:Intro', 'h2:Method'])
  const s1 = store.getCollapseSnapshot(talk)
  assert.equal(store.getCollapseSnapshot(talk), s1, 'the snapshot is the same object until something changes (useSyncExternalStore needs that)')
  let notified = 0
  const off = store.subscribeOutlineCollapse(() => { notified += 1 })
  store.publishOutline(talk, BASE)
  assert.equal(notified, 0, 'publishing the same text again does nothing')
  store.publishOutline(talk, edit((l) => l.splice(2, 0, '### typed')))
  assert.deepEqual(sorted(store.getCollapseSnapshot(talk).collapsed), ['h2:Intro', 'h2:Method'], 'collapse state follows an edit above')
  off()
  pass('store: toggles, stable snapshots, no notification for unchanged text, state follows edits')

  // restart: new in-memory state, same disk
  fresh()
  assert.deepEqual(sorted(store.getCollapseSnapshot(talk).collapsed), ['h2:Intro', 'h2:Method'], 'restored from storage before any outline is published')
  store.publishOutline(talk, BASE)
  assert.deepEqual(sorted(store.getCollapseSnapshot(talk).collapsed), ['h2:Intro', 'h2:Method'])
  pass('store: remembered across an app restart')

  // a stale first read (another talk\'s text) does not wipe the saved state
  fresh()
  store.publishOutline(talk, '# Other talk\n## Elsewhere\n### x')
  assert.equal(store.getCollapseSnapshot(talk).collapsed.size, 0)
  store.publishOutline(talk, BASE)
  assert.deepEqual(sorted(store.getCollapseSnapshot(talk).collapsed), ['h2:Intro', 'h2:Method'], 'the talk\'s own text arriving after a stale read still finds its saved sections collapsed')
  pass('store: a stale first outline (the previous talk\'s text) does not lose what was saved')

  // two talks are separate; collapse all / expand all
  fresh()
  const other = '/vault/other/other-outline.md'
  store.publishOutline(other, '## O1\n### a\n## O2\n### b')
  store.publishOutline(talk, BASE)
  store.collapseAllSections(talk)
  assert.deepEqual(sorted(store.getCollapseSnapshot(talk).collapsed), ['h2:Close', 'h2:Intro', 'h2:Method', 'h2:Notes', 'h2:Notes~1'])
  assert.equal(store.getCollapseSnapshot(other).collapsed.size, 0)
  const bulk = store.getCollapseSnapshot(talk).bulkSeq
  store.expandAllSections(talk)
  assert.equal(store.getCollapseSnapshot(talk).collapsed.size, 0)
  assert(store.getCollapseSnapshot(talk).bulkSeq > bulk && store.getCollapseSnapshot(talk).bulkCollapsed === false)
  pass('store: collapse all and expand all act on that talk only and bump the bulk counter the grid reads')

  // subtree
  store.toggleSectionTree(talk, 'h1:Deck')
  assert.equal(store.getCollapseSnapshot(talk).collapsed.size, 6, 'option-click on the open deck title collapses every section')
  store.toggleSectionTree(talk, 'h1:Deck')
  assert.equal(store.getCollapseSnapshot(talk).collapsed.size, 0)

  // reveal
  for (const k of ['h1:Deck', 'h2:Method', 'h2:Close']) store.toggleSection(talk, k)
  const m1Line = BASE.split('\n').indexOf('### m1') + 1
  const seq = store.getCollapseSnapshot(talk).revealSeq
  store.revealLine(talk, m1Line)
  const r = store.getCollapseSnapshot(talk)
  assert.deepEqual(sorted(r.collapsed), ['h2:Close'], 'revealing a slide opens every section above it (deck title, Method) and nothing else')
  assert(r.revealSeq === seq + 1 && r.revealKey === 'h3:m1', 'and names the row to scroll to')
  pass('store: option-click subtree; reveal opens every section above the row, bumps the counter and names the row')

  // bounded persistence through the store
  fresh(false)
  for (let i = 0; i < model.MAX_TALKS + 10; i += 1) {
    const k = `/vault/t${i}/o.md`
    store.publishOutline(k, '## A\n### a')
    store.toggleSection(k, 'h2:A')
  }
  const saved = model.parseSaved(disk.getItem(store.STORAGE_KEY))
  assert.equal(Object.keys(saved.talks).length, model.MAX_TALKS)
  assert(!saved.talks['/vault/t0/o.md'] && saved.talks[`/vault/t${model.MAX_TALKS + 9}/o.md`])
  // no key / blank key: memory only
  store.publishOutline('', '## A\n### a')
  store.toggleSection('', 'h2:A')
  assert(!JSON.stringify(saved).includes('"":'))
  // a storage that throws never breaks the toggle
  store.resetOutlineCollapseForTests({ storage: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } } })
  store.publishOutline(talk, BASE)
  store.toggleSection(talk, 'h2:Intro')
  assert.deepEqual([...store.getCollapseSnapshot(talk).collapsed], ['h2:Intro'])
  pass('store: bounded to the most recently used talks; no talk key = memory only; a failing storage is survived')

  console.log(`\n${passed} outline-collapse checks passed`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
