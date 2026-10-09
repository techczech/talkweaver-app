// Tests for the Slide Browser's pure helpers (src/renderer/src/components/slide-browser/browserHelpers.ts):
// the formatting, set operations and rail/grid derivations the SlideBrowser.tsx shell composes.
// Imports the REAL module — Node strips erasable TypeScript natively — so this cannot drift from
// the shipped code.
import { strict as assert } from 'node:assert'
import {
  rowTitle, formatVersionDate, versionTitle, sealLabel, cardTitleFor, countLabelFor,
  clampDensity, toggleInSet, addAllToSet, rowTagsOf, tagsAfter, versionSourceOutline,
  expansionPos, expansionAfterIndex, toggleFacetValue, mergedSectionNames, rowsGroupedByTalk,
  withoutActiveTalk, sectionNumbers, titleMap, buildOutlinePlan, viewerDeckFor, viewerIndexFor,
  sectionSourceFor, countByTalk, treeSectionsBySlug, coverUrlOf, recentEditRows, deliveryRows,
  layoutFacetItems, contentFacetItems, tagFacetItems, sectionFacetItems
} from '../src/renderer/src/components/slide-browser/browserHelpers.ts'
import { emptyFacets } from '../src/renderer/src/components/browser-rail/railModel.ts'
import { sectionKey } from '../src/renderer/src/components/slideBrowserModel.ts'

let checks = 0
const check = (name, fn) => { fn(); checks++; console.log(`  ✓ ${name}`) }
const row = (o) => ({ talkSlug: 'a', talkTitle: 'Talk A', outlinePath: '/v/a.md', ...o })

console.log('Formatting:')
check('rowTitle prefers the nav title', () => {
  assert.equal(rowTitle(row({ nav_title: 'N', title: 'T' })), 'N')
  assert.equal(rowTitle(row({ title: 'T' })), 'T')
  assert.equal(rowTitle(row({})), '(untitled)')
})
check('versionTitle drops heading marks and trigger tokens', () => {
  assert.equal(versionTitle('### Big idea {id=abc}\nbody'), 'Big idea')
  assert.equal(versionTitle('   '), '(untitled)')
})
check('formatVersionDate is en-GB d MMM yyyy', () => {
  assert.equal(formatVersionDate('2026-06-28T12:00:00Z'), '28 Jun 2026')
})
check('sealLabel names the seal, or current session for the head, else a later edit', () => {
  assert.equal(sealLabel({ sealedBy: 'present' }, 3), 'sealed by presenting')
  assert.equal(sealLabel({ sealedBy: 'export' }, 0), 'sealed by export')
  assert.equal(sealLabel({}, 0), 'current session')
  assert.equal(sealLabel({}, 2), 'sealed by later edit')
})
check('cardTitleFor and countLabelFor', () => {
  assert.match(cardTitleFor('identical', 3), /^3 byte-identical copies/)
  assert.match(cardTitleFor('near', 2), /^2 near-identical variants/)
  assert.match(cardTitleFor('single', undefined), /^Click selects/)
  const base = { unavailable: false, loading: false, grouped: true, slideCount: 1, sectionCount: 2, leftCount: 5, talkCount: 1 }
  assert.equal(countLabelFor({ ...base, unavailable: true }), 'search unavailable')
  assert.equal(countLabelFor({ ...base, loading: true }), 'searching…')
  assert.equal(countLabelFor(base), '1 slide · 2 sections')
  assert.equal(countLabelFor({ ...base, grouped: false }), '5 slides · 1 talk')
})

console.log('Sets and selection:')
check('clampDensity keeps 2..6', () => {
  assert.deepEqual([1, 2, 4, 6, 9].map(clampDensity), [2, 2, 4, 6, 6])
})
check('toggleInSet and addAllToSet return new sets and leave the input alone', () => {
  const s = new Set(['a'])
  assert.deepEqual([...toggleInSet(s, 'b')], ['a', 'b'])
  assert.deepEqual([...toggleInSet(s, 'a')], [])
  assert.deepEqual([...addAllToSet(s, ['b', 'c'])], ['a', 'b', 'c'])
  assert.deepEqual([...s], ['a'])
})
check('rowTagsOf uses the projection tags, else parses the source', () => {
  assert.deepEqual(rowTagsOf({ tags: ['x'], source_markdown: '### T\n{tags=y}' }), ['x'])
  assert.ok(Array.isArray(rowTagsOf({ source_markdown: '### T' })))
})
check('tagsAfter adds once and removes', () => {
  assert.deepEqual(tagsAfter(['a'], 'b', 'add'), ['a', 'b'])
  assert.deepEqual(tagsAfter(['a', 'b'], 'b', 'add'), ['a', 'b'])
  assert.deepEqual(tagsAfter(['a', 'b'], 'a', 'remove'), ['b'])
})
check('versionSourceOutline resolves the version outline against the vault root', () => {
  assert.equal(versionSourceOutline({ outline: 'x/t.md' }, '/vault/', '/fallback.md'), '/vault/x/t.md')
  assert.equal(versionSourceOutline({}, '/vault', '/fallback.md'), '/fallback.md')
})

console.log('Expansion placement:')
check('expansionPos finds the expanded card in the visual order, or -1', () => {
  const rows = [row({ slide_id: 'p' }), row({ slide_id: 'q' })]
  assert.equal(expansionPos(rows, 'a:q'), 1)
  assert.equal(expansionPos(rows, 'a:gone'), -1)
  assert.equal(expansionPos(rows, null), -1)
})
check('expansionAfterIndex ends the grid row holding the expanded card', () => {
  assert.deepEqual(expansionAfterIndex(4, 0, 10, 3), { jExp: 4, expAfter: 5 })
  assert.deepEqual(expansionAfterIndex(9, 0, 10, 3), { jExp: 9, expAfter: 9 })
  assert.deepEqual(expansionAfterIndex(12, 10, 5, 2), { jExp: 2, expAfter: 3 })
  assert.deepEqual(expansionAfterIndex(2, 5, 5, 2), { jExp: -1, expAfter: -1 })
})

console.log('Facets:')
check('toggleFacetValue flips one value in the right set without touching the input', () => {
  const f = emptyFacets()
  const on = toggleFacetValue(f, 'sec', 'Intro')
  assert.deepEqual([...on.sectionSet], ['Intro'])
  assert.equal(f.sectionSet.size, 0)
  assert.equal(toggleFacetValue(on, 'sec', 'Intro').sectionSet.size, 0)
  assert.deepEqual([...toggleFacetValue(f, 'lay', 'list').layoutSet], ['list'])
  assert.deepEqual([...toggleFacetValue(f, 'tag', 't').tagSet], ['t'])
  assert.deepEqual([...toggleFacetValue(f, 'content', 'code').contentSet], ['code'])
})

console.log('Derivations over the index snapshot:')
const full = [
  row({ slide_id: '1', section: 'intro', role: 'section-title', nav_title: 'Introduction', order: 0 }),
  row({ slide_id: '2', section: 'intro', title: 'One', order: 1, layout: 'list' }),
  row({ slide_id: '3', section: '', title: 'Closing', order: 2 }),
  row({ talkSlug: 'b', talkTitle: 'Talk B', slide_id: '4', section: 'deep', title: 'Deep', order: 0 })
]
check('mergedSectionNames reads authored names, the live results fill gaps', () => {
  const live = [row({ talkSlug: 'b', section: 'deep', role: 'section-title', title: 'Deep dive', slide_id: '9' })]
  const m = mergedSectionNames(full, live)
  assert.equal(m.get(sectionKey('a', 'intro')), 'Introduction')
  assert.equal(m.get(sectionKey('b', 'deep')), 'Deep dive')
})
check('rowsGroupedByTalk, withoutActiveTalk, countByTalk', () => {
  assert.deepEqual([...rowsGroupedByTalk(full).keys()], ['a', 'b'])
  assert.equal(rowsGroupedByTalk(full).get('a').length, 3)
  assert.equal(withoutActiveTalk(full, 'a').length, 1)
  assert.equal(withoutActiveTalk(full, ''), full)
  assert.deepEqual([...countByTalk(full)], [['a', 3], ['b', 1]])
})
check('sectionNumbers counts sections per talk in first-appearance order', () => {
  const m = sectionNumbers(full)
  assert.equal(m.get(sectionKey('a', 'intro')), 1)
  assert.equal(m.get(sectionKey('a', '')), 2)
  assert.equal(m.get(sectionKey('b', 'deep')), 1)
})
check('titleMap prefers the vault list and falls back to the results', () => {
  const m = titleMap([{ slug: 'a', title: 'Vault A' }, { slug: 'c', title: '' }], full)
  assert.equal(m.get('a'), 'Vault A')
  assert.equal(m.get('c'), 'c')
  assert.equal(m.get('b'), 'Talk B')
})
check('buildOutlinePlan is empty when grouped, else one plan per scoped talk in outline order', () => {
  const secName = (k, f) => (k === sectionKey('a', 'intro') ? 'Introduction' : f)
  assert.deepEqual(buildOutlinePlan({ grouped: true, scopedSlugs: ['a'], visibleResults: full, passing: () => true, talks: [], secName }), [])
  const plan = buildOutlinePlan({
    grouped: false, scopedSlugs: ['a', 'zz'], visibleResults: [...full].reverse(),
    passing: (r) => r.title !== 'One', talks: [{ slug: 'zz', title: 'Empty talk' }], secName
  })
  assert.equal(plan.length, 2)
  assert.equal(plan[0].title, 'Talk A')
  assert.equal(plan[0].total, 2)
  assert.deepEqual(plan[0].chunks.map((c) => [c.section, c.label, c.cards.length]), [['intro', 'Introduction', 1], ['', '', 1]])
  assert.deepEqual(plan[1], { slug: 'zz', title: 'Empty talk', total: 0, chunks: [] })
})
check('viewerDeckFor uses the snapshot, else the results, sorted by order', () => {
  assert.deepEqual(viewerDeckFor(null, full, []), [])
  assert.deepEqual(viewerDeckFor({ slug: 'a' }, full, []).map((r) => r.slide_id), ['1', '2', '3'])
  const live = [row({ slide_id: 'b', order: 5 }), row({ slide_id: 'a', order: 2 })]
  assert.deepEqual(viewerDeckFor({ slug: 'a' }, [], live).map((r) => r.slide_id), ['a', 'b'])
  assert.equal(viewerIndexFor({ order: 2 }, full.slice(0, 3)), 2)
  assert.equal(viewerIndexFor({ order: 99 }, full.slice(0, 3)), 0)
  assert.equal(viewerIndexFor(null, full), 0)
})
check('sectionSourceFor is null until the whole talk is known', () => {
  const rows = [row({ section: 'intro', source_line: 3, source_markdown: '## Intro\n', slide_id: 'h' })]
  assert.equal(sectionSourceFor(new Map(), 'a', 'intro'), null)
  assert.equal(sectionSourceFor(new Map([['a', rows]]), 'a', 'intro').line, 3)
})

console.log('Rail vocabularies:')
check('treeSectionsBySlug counts sectioned slides with authored labels', () => {
  const m = treeSectionsBySlug(full, (k, f) => (k === sectionKey('a', 'intro') ? 'Introduction' : f))
  assert.deepEqual(m.get('a'), [{ sec: 'intro', label: 'Introduction', count: 2 }])
  assert.deepEqual(m.get('b'), [{ sec: 'deep', label: 'deep', count: 1 }])
})
check('coverUrlOf', () => {
  assert.equal(coverUrlOf('a', { a: { coverKey: 'k1' } }), 'twthumb://thumb/a/k1')
  assert.equal(coverUrlOf('a', {}), null)
  assert.equal(coverUrlOf(undefined, { a: { coverKey: 'k1' } }), null)
})
check('recentEditRows and deliveryRows are ordered, capped and titled', () => {
  const meta = Object.fromEntries(Array.from({ length: 8 }, (_v, i) => [`t${i}`, { editedMs: Date.now() - (i + 1) * 3600000 }]))
  meta.never = { editedMs: 0 }
  const titles = new Map([['t0', 'Zero']])
  const edits = recentEditRows(meta, titles)
  assert.equal(edits.length, 6)
  assert.deepEqual([edits[0].slug, edits[0].title, edits[0].when], ['t0', 'Zero', '1h ago'])
  assert.equal(edits[1].title, 't1')
  const sessions = Array.from({ length: 10 }, (_v, i) => ({ id: `s${i}`, talkSlug: 'a', talkTitle: i === 9 ? '' : `T${i}`, endedAt: new Date(Date.now() - (10 - i) * 86400000).toISOString(), context: i === 9 ? 'Oxford' : null }))
  const runs = deliveryRows(sessions, new Map([['a', 'Talk A']]))
  assert.equal(runs.length, 8)
  assert.deepEqual([runs[0].key, runs[0].title, runs[0].sub], ['run:s9', 'Talk A', 'Oxford'])
  // A planned Run (empty endedAt) is not a recent delivery and does not disturb the order.
  const withPlanned = deliveryRows([{ id: 'plan', talkSlug: 'a', talkTitle: 'Planned', status: 'planned', endedAt: '', context: null }, ...sessions.slice(0, 2)], new Map())
  assert.deepEqual(withPlanned.map((r) => r.key), ['run:s1', 'run:s0'], 'planned Runs are skipped')
})
check('layoutFacetItems lists registry and vault layouts, most used first', () => {
  const items = layoutFacetItems(['default', 'list'], full, [full[1], full[2], full[3]])
  assert.deepEqual(items.map((i) => [i.value, i.count]), [['default', 2], ['list', 1]])
})
check('contentFacetItems has one item per content kind', () => {
  const items = contentFacetItems([row({ image_count: 2 }), row({ has_code: true })])
  assert.deepEqual(items.map((i) => [i.key, i.count]), [['image', 1], ['icon', 0], ['video', 0], ['code', 1]])
})
check('tagFacetItems merges the vault vocabulary with row tags, conditioned counts first', () => {
  const rows = [row({ tags: ['b'] }), row({ tags: ['b', 'c'] })]
  const items = tagFacetItems([{ name: 'a', count: 9 }, { name: 'b', count: 1 }], rows, rows)
  assert.deepEqual(items, [{ value: 'b', count: 2 }, { value: 'c', count: 1 }, { value: 'a', count: 0 }])
})
check('sectionFacetItems lists zeroed sections dimmed and keeps active selections', () => {
  const label = (r) => r.section ?? ''
  const base = [row({ section: 'x' }), row({ section: 'y' }), row({ section: '' })]
  const items = sectionFacetItems(base, [base[0]], new Set(['gone']), label)
  assert.deepEqual(items, [{ value: 'x', count: 1 }, { value: 'gone', count: 0 }, { value: 'y', count: 0 }])
})

console.log(`\ntest-slide-browser-helpers: ${checks} checks passed.`)
