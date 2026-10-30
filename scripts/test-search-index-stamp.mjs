// The Slide Browser's freshness stamp (src/main/search-index-stamp.ts; review round 1 of the drawing
// ticket). The Browser reuses its held whole-index rows on clearing the search only while main's stamp
// equals the one the rows came with, so the stamp must move on every change a scan would see, and a
// reply must carry the stamp from BEFORE its scan: an outline changed while the scan runs must leave
// the reply stale, never stamped as current.
//   - an ordinary save (another window, a sync client: no event reaches main) moves the stamp;
//   - a talk added, removed, renamed or retitled, a vault change, a new compiler and an index reset move it;
//   - nothing changed: the same stamp;
//   - with the real scan module, a change during the scan leaves the reply's stamp behind main's.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentSearchTalks, scanWithStartStamp, searchIndexStamp } from '../src/main/search-index-stamp.ts'
import { createSlideSearch, normalizeSearchQuery } from '../src/main/slide-search.ts'
import { compactSlideSearchReply } from '../src/shared/slide-search-reply.ts'
import ts from 'typescript'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok  ${name}`) }

const root = mkdtempSync(join(tmpdir(), 'tw-search-index-stamp-'))
try {
  const vault = join(root, 'vault')
  let clock = Date.now() - 3600_000
  // Each write gets its own whole-second mtime, so the test never depends on the file system's resolution.
  const write = (file, text) => { writeFileSync(file, text); clock += 1000; utimesSync(file, clock / 1000, clock / 1000) }
  const makeTalk = (slug, text) => {
    mkdirSync(join(vault, slug), { recursive: true })
    const outlinePath = join(vault, slug, `${slug}-outline.md`)
    write(outlinePath, text)
    return { outlinePath, slug, title: slug }
  }
  const a = makeTalk('alpha', '### One\n\nfirst\n')
  const b = makeTalk('beta', '### Two\n\nsecond\n')
  const c = makeTalk('gamma', '### Three\n\nthird\n')
  let talks = [a, b, c]
  let vaults = [{ id: 'v1', root: vault }]
  let compilerTag = 'compiler-1'
  let resets = 0
  const { statSync } = await import('node:fs')
  const searched = () => vaults.flatMap((v) => talks.map((talk) => ({ vaultId: v.id, vaultRoot: v.root, talk })))
  const stampNow = () => searchIndexStamp({
    talks: searched(),
    mtimeOf: (p) => { try { return statSync(p).mtimeMs } catch { return null } },
    compilerTag,
    resets
  })

  await test('nothing changed: the same stamp', async () => {
    assert.equal(stampNow(), stampNow())
    assert.match(stampNow(), /^[0-9a-f]{40}$/)
  })

  await test('an ordinary save moves the stamp (no event needs to reach main)', async () => {
    const before = stampNow()
    write(b.outlinePath, '### Two\n\nsecond, edited elsewhere\n')
    assert.notEqual(stampNow(), before)
  })

  await test('talks added, removed, renamed or retitled move the stamp', async () => {
    let before = stampNow()
    const d = makeTalk('delta', '### Four\n')
    talks = [a, b, c, d]
    assert.notEqual(stampNow(), before, 'added')
    before = stampNow()
    talks = [a, b, c]
    assert.notEqual(stampNow(), before, 'removed')
    before = stampNow()
    talks = [a, b, { ...c, slug: 'gamma-2', outlinePath: c.outlinePath.replace('gamma-outline', 'gamma-2-outline') }]
    assert.notEqual(stampNow(), before, 'renamed')
    talks = [a, b, c]
    before = stampNow()
    talks = [a, b, { ...c, title: 'Gamma, retitled' }]
    assert.notEqual(stampNow(), before, 'retitled')
    talks = [a, b, c]
  })

  await test('a deleted outline file moves the stamp', async () => {
    const before = stampNow()
    talks = [a, b, c, { outlinePath: join(vault, 'gone', 'gone-outline.md'), slug: 'gone', title: 'gone' }]
    assert.notEqual(stampNow(), before)
    talks = [a, b, c]
  })

  await test('a vault change, a new compiler and an index reset move the stamp', async () => {
    let before = stampNow()
    vaults = [{ id: 'v1', root: vault }, { id: 'v2', root: vault }]
    assert.notEqual(stampNow(), before, 'vault opened')
    vaults = [{ id: 'v1', root: vault }]
    before = stampNow()
    compilerTag = 'compiler-2'
    assert.notEqual(stampNow(), before, 'compiler')
    before = stampNow()
    resets += 1
    assert.notEqual(stampNow(), before, 'index reset')
  })

  await test('real scan module: an outline changed during the scan leaves the reply stale', async () => {
    const search = createSlideSearch({ imageText: { generation: () => 1, textLower: () => '' } })
    const rowsOf = (talk) => {
      const text = readFileSync(talk.outlinePath, 'utf8')
      return [{ slide_id: `${talk.slug}-1`, nav_title: text.split('\n')[0].replace(/^#+\s*/, ''), title: '', source_markdown: text }]
    }
    let edited = false
    const scan = () => search.scan({
      query: normalizeSearchQuery(''),
      talks: searched(),
      load: async ({ talk }) => {
        // Another window saves beta while the scan is on alpha (after the scan began, before it read beta).
        if (talk.slug === 'alpha' && !edited) { edited = true; write(b.outlinePath, '### Two\n\nsaved during the scan\n') }
        return { key: talk.outlinePath, freshness: String(statSync(talk.outlinePath).mtimeMs), rows: rowsOf(talk), imageRefsFor: () => [], resolveImages: () => [] }
      }
    })
    const { stamp, result } = await scanWithStartStamp(stampNow, scan)
    assert.equal(result.length, 3, 'the scan returned every talk')
    const probe = stampNow()
    assert.notEqual(stamp, probe, 'the reply carries the stamp from before the change: the Browser treats it as stale')
    // Why the start: a stamp taken when the scan finished would equal the probe and pass these rows as
    // current although alpha was read before the change and could hold the old text.
    assert.equal(stampNow(), probe, 'nothing changed since the scan: the probe is steady')
    // A scan with nothing changing during it is current.
    const quiet = await scanWithStartStamp(stampNow, () => search.scan({
      query: normalizeSearchQuery(''), talks: searched(),
      load: async ({ talk }) => ({ key: talk.outlinePath, freshness: String(statSync(talk.outlinePath).mtimeMs), rows: rowsOf(talk), imageRefsFor: () => [], resolveImages: () => [] })
    }))
    assert.equal(quiet.stamp, stampNow(), 'an undisturbed scan is current')
  })

  await test('a talk added within the talk-list cache window moves the probe stamp (fresh walk, not the cache)', async () => {
    // Real folders; a 5 s cached lister like findTalks, and the fresh walk the probe uses.
    const walk = (r) => readdirSync(r, { withFileTypes: true }).filter((e) => e.isDirectory())
      .map((e) => ({ slug: e.name, title: e.name, outlinePath: join(r, e.name, `${e.name}-outline.md`) }))
    const held = new Map()
    const cachedList = (r) => { if (!held.has(r)) held.set(r, walk(r)); return held.get(r) }
    const stampOf = (list) => searchIndexStamp({
      talks: vaults.flatMap((v) => list(v.root).map((talk) => ({ vaultId: v.id, vaultRoot: v.root, talk }))),
      mtimeOf: (p) => { try { return statSync(p).mtimeMs } catch { return null } }, compilerTag, resets
    })
    const freshStamp = () => searchIndexStamp({
      talks: currentSearchTalks(vaults, walk, (r, t) => held.set(r, t)),
      mtimeOf: (p) => { try { return statSync(p).mtimeMs } catch { return null } }, compilerTag, resets
    })
    const cachedBefore = stampOf(cachedList)
    const freshBefore = freshStamp()
    makeTalk('epsilon', '### Five\n')
    assert.equal(stampOf(cachedList), cachedBefore, 'the cached list misses the new talk (the gap)')
    assert.notEqual(freshStamp(), freshBefore, 'the fresh walk sees it')
    assert.equal(stampOf(cachedList), freshStamp(), 'the cache was refreshed for other callers')
    rmSync(join(vault, 'epsilon'), { recursive: true })
    assert.equal(currentSearchTalks(vaults, walk, () => {}).some((t) => t.talk.slug === 'epsilon'), false, 'removal seen')
  })

  await test('a scan that skipped a talk carries a stamp that never matches a probe', async () => {
    const search = createSlideSearch({ imageText: { generation: () => 1, textLower: () => '' } })
    const run = (failSlug) => scanWithStartStamp(stampNow, () => search.scan({
      query: normalizeSearchQuery(''), talks: searched(),
      load: async ({ talk }) => talk.slug === failSlug ? null
        : { key: talk.outlinePath, freshness: String(statSync(talk.outlinePath).mtimeMs), rows: [{ slide_id: `${talk.slug}-1`, nav_title: talk.slug, title: '', source_markdown: 'x' }], imageRefsFor: () => [], resolveImages: () => [] }
    }), /* skipped? */ () => skipped)
    let skipped = false
    const whole = await run(null)
    assert.equal(whole.stamp, stampNow(), 'normal case: a complete scan still matches (no needless rescans)')
    skipped = true
    const partial = await run('beta')
    assert.notEqual(partial.stamp, stampNow(), 'beta failed to load: the stamp is marked incomplete')
    // The talk loads later: nothing in the files changed, yet the held (incomplete) set must not read as current.
    assert.notEqual(partial.stamp, stampNow(), 'still stale after the talk recovers')
  })

  await test('IPC queries reuse cached discovery; only full snapshots and probes walk fresh', async () => {
    // Execute the real registrations without starting Electron or importing the rest of main.
    const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    const start = main.indexOf('function searchTalksOf(')
    const handler = main.indexOf("ipcMain.handle('search:all-slides'", start)
    const end = main.indexOf('\n})', handler) + 4
    assert.ok(start >= 0 && handler > start && end > handler, 'search IPC registrations found')
    const source = ts.transpileModule(main.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }
    }).outputText
    const handlers = new Map()
    let walks = 0, cachedCalls = 0, stats = 0
    const cache = new Map([[vault, { at: Date.now(), talks: [a, b, c] }]])
    const deps = {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      currentSearchTalks, scanWithStartStamp, searchIndexStamp, normalizeSearchQuery, compactSlideSearchReply,
      scanTalks: () => { walks++; return [a, b, c] },
      findTalks: (r) => { cachedCalls++; return cache.get(r).talks },
      talkCache: cache,
      vaultRegistry: { list: () => vaults },
      vaultAvailability: { isUnavailable: () => false },
      searchVaults: (vs) => vs,
      getCompilerPath: () => '/compiler',
      join, dirname: () => vault,
      pathToFileURL: () => ({ href: 'data:text/javascript,export const prepareSource = null; export const buildPerSlideProjections = null' }),
      searchSupersede: { begin: () => () => false },
      watchSearchSender: () => {},
      statSync: (p) => { stats++; return statSync(p) },
      thumbCacheRoot: () => compilerTag,
      searchCache: { resets, get: () => ({ mtimeMs: 1, meta: '' }) },
      slideSearch: createSlideSearch({ imageText: { generation: () => 1, textLower: () => '' } }),
      ensureTalkRows: async () => [{ slide_id: 'one', nav_title: 'needle', source_markdown: '' }],
      rowImageRefs: () => [], resolveImagePaths: () => []
    }
    new Function(...Object.keys(deps), source)(...Object.values(deps))
    const search = (query, compact) => handlers.get('search:all-slides')({ sender: { id: 1 } }, query, { compact })
    for (const query of ['', 'needle', { scope: 'title', exact: true, text: 'needle', terms: [] }]) {
      for (let i = 0; i < 2; i++) assert.equal((await search(query, false)).length, 3)
    }
    for (const query of ['needle', { scope: 'title', exact: true, text: 'needle', terms: [] }]) {
      for (let i = 0; i < 2; i++) {
        const reply = await search(query, true)
        assert.equal(reply.rows.length, 3)
        assert.equal(reply.stamp, null, 'filtered replies cannot validate a whole-index snapshot')
      }
    }
    assert.equal(cachedCalls, 10, 'each ordinary query uses findTalks')
    assert.equal(walks, 0, 'repeated ordinary queries never bypass the discovery cache')
    assert.equal(stats, 0, 'ordinary queries do not stat outlines for a stamp')
    for (const query of ['', { scope: 'all', exact: false, text: '  ', terms: [] }]) {
      const reply = await search(query, true)
      assert.equal(reply.rows.length, 3)
      assert.match(reply.stamp, /^[0-9a-f]{40}$/, 'whole-index snapshot is stamped')
    }
    assert.equal(walks, 2, 'every whole-index snapshot discovers fresh talks')
    assert.equal(cachedCalls, 10, 'snapshots bypass findTalks')
    const probe = handlers.get('search:index-stamp')({}, {})
    assert.equal(walks, 3, 'freshness probe also discovers fresh talks')
    assert.equal(probe, (await search('', true)).stamp, 'quiet snapshot and probe agree')
    assert.equal(walks, 4)
  })

  console.log(`PASS search index stamp (${passed} checks)`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
