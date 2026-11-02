// Slide search module (src/main/slide-search.ts): the match rules are the ones the handler had (parity
// against a verbatim copy of the old per-row logic), prepared strings are reused until a talk's rows
// are rebuilt, picture text refreshes when the image-text index changes, and a superseded scan stops.
import assert from 'node:assert/strict'
import { createSlideSearch, matchHay, normalizeSearchQuery } from '../src/main/slide-search.ts'
import { createSupersedeTracker } from '../src/main/search-supersede.ts'
import { readFileSync } from 'node:fs'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok  ${name}`) }

// Picture text store with a generation counter, like the OCR index.
function imageStore(initial = {}) {
  const text = { ...initial }
  let gen = 1
  return { generation: () => gen, textLower: (p) => (text[p] || '').toLowerCase(), set(p, t) { text[p] = t; gen += 1 } }
}
const row = (id, title, md, nav) => ({ slide_id: id, nav_title: nav ?? title, title, source_markdown: md })
// References are the picture paths themselves here; resolving keeps the ones that exist (all, by default).
const mkTalk = (key, rows, freshness = '1|t', pics = {}, exists = () => true) => ({ key, freshness, rows, imageRefsFor: (r) => pics[r.slide_id] || [], resolveImages: (refs) => refs.filter(exists) })
const run = (search, query, talks, extra = {}) => search.scan({ query: normalizeSearchQuery(query), talks, load: async (t) => t, yieldToLoop: async () => {}, ...extra })

// Verbatim copy of the match step the handler ran per row before the module (index.ts, 2026-10-20).
function legacyMatches(r, imageHay, q) {
  const titleHay = `${r.nav_title || ''}\n${r.title || ''}`.toLowerCase()
  const bodyHay = String(r.source_markdown || '').toLowerCase()
  const fieldHay = q.scope === 'title' ? titleHay : q.scope === 'body' ? bodyHay : q.scope === 'image' ? imageHay : `${titleHay}\n${bodyHay}\n${imageHay}`
  return matchHay(fieldHay, q) ? { titleHit: q.scope === 'title' ? true : matchHay(titleHay, q) } : null
}

await test('parity: every scope, word/phrase, case and empty-query form matches like the old logic', async () => {
  const ocr = { '/p/a.png': 'Quarterly REVENUE chart', '/p/b.png': 'Cabinet Office' }
  const store = imageStore(ocr)
  const rows = [
    row('1', 'Welcome', 'Hello World\n- point one'),
    row('2', 'Revenue Review', 'figures\n![x](a.png)'),
    row('3', 'Cabinet', 'nothing here ![](b.png)'),
    row('4', 'Chart', 'plain body with Revenue in body'),
    row('5', '', '')
  ]
  const pics = { 2: ['/p/a.png'], 3: ['/p/b.png'] }
  const talk = mkTalk('/t/one', rows, '1|t', pics)
  const search = createSlideSearch({ imageText: store })
  const images = (r) => (pics[r.slide_id] || []).map((p) => '\n' + store.textLower(p)).join('')
  const queries = [
    '', 'revenue', 'REVENUE chart', 'office cabinet', 'hello world', 'zzz', 'point one',
    { scope: 'title', exact: false, text: 'revenue', terms: ['revenue'] },
    { scope: 'body', exact: false, text: 'revenue', terms: ['revenue'] },
    { scope: 'image', exact: false, text: 'revenue', terms: ['revenue'] },
    { scope: 'image', exact: true, text: 'Cabinet Office', terms: ['cabinet', 'office'] },
    { scope: 'all', exact: true, text: 'hello world', terms: ['hello', 'world'] },
    { scope: 'all', exact: true, text: 'world hello', terms: ['world', 'hello'] },
    { scope: 'all', exact: false, text: 'welcome cabinet', terms: ['welcome', 'cabinet'] }, // terms in different rows' fields
    { scope: 'all', exact: false, text: 'review figures', terms: ['review', 'figures'] }, // one term in title, one in body
    { scope: 'title', exact: false, text: '', terms: [] },
    { scope: 'nonsense', exact: 1, text: 5, terms: [3, 'x', ''] }
  ]
  for (const raw of queries) {
    const q = normalizeSearchQuery(raw)
    const expected = rows.map((r) => [r, legacyMatches(r, images(r), q)]).filter(([, m]) => m).map(([r, m]) => [r.slide_id, m.titleHit])
    const hits = await run(search, raw, [talk])
    assert.deepEqual(hits.map((h) => [h.row.slide_id, h.titleHit]), expected, 'query ' + JSON.stringify(raw))
  }
})

await test('normalizeSearchQuery: a bare string is the all-words all-fields form', () => {
  assert.deepEqual(normalizeSearchQuery('Foo  Bar'), { scope: 'all', exact: false, text: 'Foo  Bar', terms: ['foo', 'bar'] })
  assert.deepEqual(normalizeSearchQuery(undefined), { scope: 'all', exact: false, text: '', terms: [] })
})

await test('haystacks are built once per talk and reused until that talk is rebuilt', async () => {
  const search = createSlideSearch({ imageText: imageStore() })
  const a = mkTalk('/t/a', [row('1', 'Alpha', 'alpha')]); const b = mkTalk('/t/b', [row('2', 'Beta', 'beta')])
  await run(search, 'a', [a, b]); await run(search, 'beta', [a, b]); await run(search, '', [a, b])
  assert.equal(search.prepareCount(), 2, 'two talks, prepared once each, however many queries')
  const a2 = mkTalk('/t/a', [row('1', 'Alpha', 'alpha changed')], '2|t') // saved: new rows, new freshness
  const hits = await run(search, 'changed', [a2, b])
  assert.equal(search.prepareCount(), 3, 'only the rebuilt talk is prepared again')
  assert.deepEqual(hits.map((h) => h.row.slide_id), ['1'])
  assert.deepEqual((await run(search, 'changed', [a, b])).map((h) => h.row.slide_id), [], 'old rows still answer from their own strings')
})

await test('a new freshness key (compiler changed) with the same rows array re-prepares', async () => {
  const search = createSlideSearch({ imageText: imageStore() })
  const rows = [row('1', 'Alpha', 'alpha')]
  await run(search, 'alpha', [mkTalk('/t/a', rows, '1|v1')]); await run(search, 'alpha', [mkTalk('/t/a', rows, '1|v1')])
  assert.equal(search.prepareCount(), 1)
  await run(search, 'alpha', [mkTalk('/t/a', rows, '1|v2')])
  assert.equal(search.prepareCount(), 2)
})

await test('picture text that arrives later is found without rebuilding the talk; only rows with pictures refresh', async () => {
  const store = imageStore()
  const search = createSlideSearch({ imageText: store })
  const rows = [row('1', 'One', 'text'), row('2', 'Two', '![](a.png)'), row('3', 'Three', '![](b.png)'), row('4', 'Four', 'more text')]
  const talk = mkTalk('/t/a', rows, '1|t', { 2: ['/p/a.png'], 3: ['/p/b.png'] })
  assert.deepEqual(await run(search, { scope: 'image', exact: false, text: 'zebra', terms: ['zebra'] }, [talk]), [], 'no picture text yet')
  store.set('/p/a.png', 'A Zebra crossing')
  const hits = await run(search, { scope: 'image', exact: false, text: 'zebra', terms: ['zebra'] }, [talk])
  assert.deepEqual(hits.map((h) => h.row.slide_id), ['2'])
  assert.equal(search.prepareCount(), 1, 'the talk was not rebuilt')
  assert.equal(search.imageRefreshCount(), 2, 'the two rows that name pictures were refreshed, nobody else')
  await run(search, 'zebra', [talk])
  assert.equal(search.imageRefreshCount(), 2, 'no change in picture text, no refresh')
  assert.deepEqual((await run(search, 'zebra', [talk])).map((h) => h.row.slide_id), ['2'], 'scope all reads the picture text too')
})

await test('a scan stops as soon as it is superseded and answers null', async () => {
  const search = createSlideSearch({ imageText: imageStore() })
  const talks = Array.from({ length: 10 }, (_, i) => mkTalk('/t/' + i, [row('s' + i, 'T' + i, 'x')]))
  let loaded = 0; let stopAfter = 3
  const res = await search.scan({
    query: normalizeSearchQuery(''), talks, yieldToLoop: async () => {}, shouldStop: () => loaded >= stopAfter,
    load: async (t) => { loaded += 1; return t }
  })
  assert.equal(res, null)
  assert.equal(loaded, 3, 'no talk is loaded after the stop')
})

await test('the scan yields to the event loop between talks and inside a very long talk', async () => {
  const search = createSlideSearch({ imageText: imageStore() })
  let yields = 0
  const big = mkTalk('/t/big', Array.from({ length: 4500 }, (_, i) => row('b' + i, 'T', 'x')))
  const small = mkTalk('/t/small', [row('s', 'T', 'x')])
  await search.scan({ query: normalizeSearchQuery(''), talks: [big, small], load: async (t) => t, yieldToLoop: async () => { yields += 1 } })
  assert.ok(yields >= 2 + 2, 'one yield per talk plus mid-talk yields: ' + yields)
  // With the real yield, a task queued before the scan runs while the scan is still going.
  let queuedRan = false; setImmediate(() => { queuedRan = true })
  let ranDuringScan = false
  await search.scan({ query: normalizeSearchQuery(''), talks: [small, small, small], load: async (t) => { if (queuedRan) ranDuringScan = true; return t } })
  assert.equal(ranDuringScan, true)
})

await test('a picture that did not exist when the talk was prepared is found once it arrives and its text is read', async () => {
  const store = imageStore()
  const search = createSlideSearch({ imageText: store })
  const present = new Set()
  const rows = [row('1', 'One', '![](img-1a2b3c4)'), row('2', 'Two', 'no pictures')]
  const talk = mkTalk('/t/a', rows, '1|t', { 1: ['/v/_assets/img-1a2b3c4.png'] }, (p) => present.has(p))
  const q = { scope: 'image', exact: false, text: 'giraffe', terms: ['giraffe'] }
  assert.deepEqual(await run(search, q, [talk]), [], 'the pooled picture is missing')
  present.add('/v/_assets/img-1a2b3c4.png'); store.set('/v/_assets/img-1a2b3c4.png', 'A Giraffe')
  assert.deepEqual((await run(search, q, [talk])).map((h) => h.row.slide_id), ['1'])
  assert.equal(search.prepareCount(), 1, 'the talk was not rebuilt')
  assert.equal(search.imageRefreshCount(), 1, 'only the row that names a picture was re-resolved')
})

await test('supersede: a newer request from the same window and key stops the older one; others are untouched', () => {
  const t = createSupersedeTracker()
  const first = t.begin(1, 'slide-browser:a', 1)
  assert.equal(first(), false)
  const second = t.begin(1, 'slide-browser:a', 2)
  assert.equal(first(), true); assert.equal(second(), false)
  assert.equal(t.begin(2, 'slide-browser:a', 1)(), false, 'another window is separate')
  assert.equal(t.begin(1, 'other', 1)(), false, 'another key is separate')
  assert.equal(t.begin(1, '', 1)(), false); assert.equal(t.begin(1, 'k', undefined)(), false, 'no id or key: never superseded')
})

await test('supersede: after a reload (ids start again at 1) the new document\'s searches are answered', () => {
  const t = createSupersedeTracker()
  for (let id = 1; id <= 50; id++) t.begin(7, 'slide-browser:old-load', id)
  // Main forgets the window when its page navigates or reloads.
  t.forgetSender(7)
  assert.equal(t.begin(7, 'slide-browser:old-load', 1)(), false, 'id 1 after the reload is answered')
  // And a new document's own key (fresh per-load token) never meets an old document's ids.
  const t2 = createSupersedeTracker()
  for (let id = 1; id <= 50; id++) t2.begin(7, 'slide-browser:old-load', id)
  assert.equal(t2.begin(7, 'slide-browser:new-load', 1)(), false)
  // Forgetting never stops a request on its own: if the navigation event reaches main after the new
  // document's first search, that search must still be answered.
  const t3 = createSupersedeTracker()
  const old = t3.begin(3, 'k', 5); t3.forgetSender(3); t3.begin(3, 'k', 9)
  assert.equal(old(), false); assert.equal(t3.size(), 1)
})

await test('supersede wiring: the renderer keys its searches with a per-load token; main forgets a window on navigation and close', () => {
  const hook = readFileSync(new URL('../src/renderer/src/components/slide-browser/useSlideSearch.ts', import.meta.url), 'utf8')
  assert.match(hook, /supersedeKey: `slide-browser:\$\{SEARCH_LOAD_TOKEN\}`/)
  assert.match(hook, /const SEARCH_LOAD_TOKEN = /)
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(main, /on\('did-navigate', forget\)/)
  assert.match(main, /once\('destroyed'/)
})

console.log(`PASS slide search: ${passed} checks`)
