// The image search seam (ticket 10, src/main/image-search/): one contract run against both
// providers — SlideWell's shared store and the old-PowerPoint archive alone — plus what each must
// do on its own. Real SQLite fixtures made with the system sqlite3 binary in a temp folder; every
// name in them is invented.
//
//   contract   query → hits with key, source, thumbUrl, caption, score, used-in; empty query → [];
//              no store → unavailable and null; fileFor serves what a search returned, nothing else
//   archive    the palette's results are field for field what the archive search always returned
//   slidewell  a screenshot is found by its window title; emptied, Bin and online-only items stay
//              hidden; a screenshot in the well is one hit; used-in only for the vault SlideWell
//              scanned; picture matches come after words and never repeat them; nothing is written
//   fix round 1  S1 reads give way to SlideWell (250 ms busy wait, killed at 500 ms); S2 well items
//              found by file name; S3 serving re-checks SlideWell's state; T1 the archive serves only
//              registry or searched images; T2 a quote-only query makes no FTS call
//   fix round 2  a failed schema read fails closed and is not kept; one separator list for query
//              and file names (backslash, tab); a PNG needs all eight signature bytes
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArchiveProvider } from '../src/main/image-search/archive-provider.ts'
import { imageMagic } from '../src/main/image-search/image-file.ts'
import { createImageSearch, toPaletteHit } from '../src/main/image-search/image-search.ts'
import { createSlideWellProvider, fileNameWhere, ftsQuery, locateSlideWell, READ_BUSY_MS, READ_LIMIT_MS } from '../src/main/image-search/slidewell-provider.ts'
import { detectSqlite3, sqliteQuery } from '../src/main/image-search/sqlite-read.ts'
import { twarchiveUrl } from '../src/main/image-search/thumb-url.ts'

const sqlite3 = detectSqlite3()
assert.ok(sqlite3, 'sqlite3 must be on this machine')
const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-image-search-')))
const dir = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p }
// Image fixtures carry real leading bytes for their extension (the archive serves only images).
const MAGIC = { png: Buffer.from('89504e470d0a1a0a', 'hex'), jpg: Buffer.from('ffd8ffe0', 'hex'), webp: Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1') }
const file = (path, bytes) => {
  writeFileSync(path, bytes ?? Buffer.concat([MAGIC[path.split('.').pop()] ?? Buffer.alloc(0), Buffer.from('image-bytes:' + path)]))
  return path
}
const sql = (db, script) => execFileSync(sqlite3, [db], { input: script })
const lit = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
const DAY = 86_400_000
const NOW = Date.parse('2026-10-11T12:00:00Z')
const ago = (days) => new Date(NOW - days * DAY).toISOString()

// ── the old-PowerPoint archive ─────────────────────────────────────────────────────────────
const archiveRoot = dir('archive')
dir('archive', 'registry')
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)
const SHA_GONE = 'd'.repeat(64)
const PID_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
dir('archive', 'media-store', 'aa')
const fileA = file(join(archiveRoot, 'media-store', 'aa', SHA_A + '.png')) // sharded store
const fileB = file(join(archiveRoot, 'media-store', SHA_B + '.jpg')) // flat store
const fileC = file(join(dir('archive', 'extracted', PID_UUID, 'media'), 'image3.png')) // extracted copy
sql(join(archiveRoot, 'registry', 'media.db'), `
  CREATE TABLE ocr_assets (asset_key TEXT, presentation_id TEXT, rel_path TEXT, kind TEXT, text TEXT);
  INSERT INTO ocr_assets VALUES ('${SHA_A}', 'Harbour Talk 2019', 'media/image1.png', 'image', 'Harbour lights map with long caption text');
  INSERT INTO ocr_assets VALUES ('${SHA_B}', 'Harbour Talk 2019', 'media/image2.jpg', 'image', 'Harbour lights');
  INSERT INTO ocr_assets VALUES ('${SHA_C}', '${PID_UUID}', 'media/image3.png', 'image', 'harbour lights 50% off_sale');
  INSERT INTO ocr_assets VALUES ('${SHA_GONE}', 'Harbour Talk 2019', 'media/image4.png', 'image', 'Harbour lights but no file');
  INSERT INTO ocr_assets VALUES ('${'e'.repeat(64)}', 'Harbour Talk 2019', 'slides/slide1.png', 'slide', 'Harbour lights slide');
`)
const archive = createArchiveProvider({ archiveRoot: () => archiveRoot, sqlite3: () => sqlite3 })

// ── SlideWell's store ──────────────────────────────────────────────────────────────────────
const wellRoot = dir('SlideWell', 'well')
const captures = dir('Captures')
const vault = dir('Vault')
const otherVault = dir('Other Vault')
const SHOT = 'CleanShot 2026-10-08 at 08.01.22 from Google Chrome with Harbour Lights Layout Showcase.png'
const shotFile = file(join(captures, SHOT))
const emptiedFile = file(join(captures, 'emptied.png'))
const binFile = file(join(captures, 'bin.png'))
const freshFile = file(join(captures, 'fresh.png'))
const keptFile = file(join(captures, 'kept-original.png'))
file(join(captures, 'not-returned.png'))
const wellCopy = file(join(dir('SlideWell', 'well', 'images'), 'harbour-plan--c0ffee1.webp'))
const addedFile = file(join(wellRoot, 'images', 'marina-sunset-chart--d00d001.webp'))
const talkImage = file(join(dir('Vault', '_assets'), 'img-abc1234.png'))

const triageRow = (hash, rel, { app = '', window = '', takenAt = '', ocr = '', offline = '0', kind = 'image' } = {}) =>
  `INSERT INTO triage_fts (hash, kind, rel_path, filename, ext, size, mtime, poster_rel, offline, ocr_text, scanned_at, source, taken_at, app, window_title)
   VALUES (${[hash, kind, rel, rel, 'png', '10', String(Date.parse('2026-10-08T08:01:22Z')), '', offline, ocr, ago(1), captures, takenAt, app, window].map(lit).join(', ')});`
sql(join(wellRoot, 'triage.db'), `
  CREATE VIRTUAL TABLE triage_fts USING fts5(
    hash UNINDEXED, kind UNINDEXED, rel_path UNINDEXED, filename, ext UNINDEXED,
    size UNINDEXED, mtime UNINDEXED, poster_rel UNINDEXED, offline UNINDEXED, ocr_text, scanned_at UNINDEXED,
    source UNINDEXED, taken_at UNINDEXED, app, window_title);
  CREATE TABLE triage_decisions (hash TEXT PRIMARY KEY, state TEXT NOT NULL, decided_at TEXT, well_id TEXT);
  CREATE TABLE sorter_proposals (hash TEXT PRIMARY KEY, proposal TEXT NOT NULL, confidence REAL NOT NULL, p_keep REAL NOT NULL,
    reason TEXT NOT NULL, rule TEXT, sorter_version TEXT NOT NULL, model_id TEXT, proposed_at TEXT NOT NULL,
    throwaway_since TEXT, answered_at TEXT, answer TEXT);
  ${triageRow('aaaa11112222', SHOT, { app: 'Google Chrome', window: 'Harbour Lights Layout Showcase', takenAt: '2026-10-08T08:01:22', ocr: 'quarterly plan' })}
  ${triageRow('bbbb11112222', 'emptied.png', { window: 'Harbour Lights Old Draft' })}
  INSERT INTO triage_decisions VALUES ('bbbb11112222', 'emptied', ${lit(ago(2))}, NULL);
  ${triageRow('cccc11112222', 'bin.png', { window: 'Harbour Lights Bin Copy' })}
  INSERT INTO sorter_proposals VALUES ('cccc11112222', 'throwaway', 0.9, 0.1, 'Terminal', NULL, 's1', NULL, ${lit(ago(45))}, ${lit(ago(40))}, NULL, NULL);
  ${triageRow('dddd11112222', 'fresh.png', { window: 'Harbour Lights Fresh Throwaway' })}
  INSERT INTO sorter_proposals VALUES ('dddd11112222', 'throwaway', 0.9, 0.1, 'Terminal', NULL, 's1', NULL, ${lit(ago(5))}, ${lit(ago(5))}, NULL, NULL);
  ${triageRow('eeee11112222', 'offline.png', { window: 'Harbour Lights Online Only', offline: '1' })}
  ${triageRow('ffff11112222', 'kept-original.png', { app: 'Keynote', window: 'Harbour Lights Plan', takenAt: '2026-09-30T10:00:00', ocr: 'harbour plan' })}
  INSERT INTO triage_decisions VALUES ('ffff11112222', 'selected', ${lit(ago(3))}, 'c0ffee1');
`)
const wellRow = (id, slug, ext, rel, root, source, tags, notes, ocr, added) =>
  `INSERT INTO well_fts (id, slug, ext, rel_path, root, source, tags, notes, ocr_text, added_at) VALUES (${[id, slug, ext, rel, root, source, tags, notes, ocr, added].map(lit).join(', ')});`
sql(join(wellRoot, 'well.db'), `
  CREATE VIRTUAL TABLE well_fts USING fts5(id UNINDEXED, slug UNINDEXED, ext UNINDEXED, rel_path UNINDEXED,
    root UNINDEXED, source UNINDEXED, tags, notes, ocr_text, added_at UNINDEXED);
  CREATE TABLE well_sources (well_id TEXT NOT NULL, source_hash TEXT NOT NULL, PRIMARY KEY (well_id, source_hash));
  CREATE TABLE well_meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE talk_image_use (image_id TEXT NOT NULL, talk_rel_path TEXT NOT NULL, talk_title TEXT NOT NULL,
    slide INTEGER NOT NULL DEFAULT 0, scanned_at TEXT NOT NULL, PRIMARY KEY (image_id, talk_rel_path, slide));
  CREATE TABLE talk_usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  ${wellRow('c0ffee1', 'harbour-plan', 'webp', 'images/harbour-plan--c0ffee1.webp', 'well', 'screenshot', '', '', 'harbour plan', '2026-09-30T10:05:00Z')}
  INSERT INTO well_sources VALUES ('c0ffee1', 'ffff11112222');
  ${wellRow('d00d001', 'marina-sunset-chart', 'webp', 'images/marina-sunset-chart--d00d001.webp', 'well', 'screenshot', '', '', 'marina sunset chart', '2026-07-01T09:00:00Z')}
  ${wellRow('f00f001', 'pelican-wharf', 'webp', 'images/pelican-wharf--f00f001.webp', 'well', 'screenshot', '', '', '', '2026-08-01T09:00:00Z')}
  ${wellRow('e1e1e1e', 'old-draft', 'webp', 'images/old-draft--e1e1e1e.webp', 'well', 'screenshot', '', '', 'harbour lights old draft', '2026-07-01T09:00:00Z')}
  INSERT INTO well_sources VALUES ('e1e1e1e', 'bbbb11112222');
  ${wellRow('abc1234', 'tidal-diagram', 'png', '_assets/img-abc1234.png', 'vault', 'talkweaver', '', 'Tidal diagram', 'tides harbour', '2025-03-02T09:00:00Z')}
  INSERT INTO talk_usage_meta VALUES ('vault_root', ${lit(vault)});
  INSERT INTO talk_image_use VALUES ('abc1234', 'talks/tides-outline.md', 'Tides and Ports', 3, ${lit(ago(1))});
  INSERT INTO talk_image_use VALUES ('abc1234', 'talks/ports-outline.md', 'Ports Again', 0, ${lit(ago(1))});
`)
file(join(wellRoot, 'images', 'old-draft--e1e1e1e.webp'))
const pelicanFile = file(join(wellRoot, 'images', 'pelican-wharf--f00f001.webp'))

let vaultRoots = [vault]
let pictureAnswer = { ok: false, reason: 'not-running' }
const asked = []
const slidewellProvider = (overrides = {}) => createSlideWellProvider({
  location: () => ({ wellRoot, socketPath: join(base, 'no.sock') }),
  archive,
  sqlite3: () => sqlite3,
  vaultRoots: () => vaultRoots,
  askPictures: async (socket, text, limit) => { asked.push({ socket, text, limit }); return pictureAnswer },
  now: () => NOW,
  // The suite runs beside many others: roomy limits here so a slow process start is not a failure.
  // The S1 test runs with the app's own limits.
  readLimits: { busyMs: 2000, limitMs: 8000 },
  ...overrides
})
const slidewell = slidewellProvider()

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
const SOURCES = new Set(['screenshot', 'added-image', 'talk-image', 'archive-image', 'old-slide'])
const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// ── the contract, run against both providers ──────────────────────────────────────────────────
for (const [name, provider, absent] of [
  ['archive', archive, createArchiveProvider({ archiveRoot: () => null, sqlite3: () => sqlite3 })],
  ['slidewell', slidewell, slidewellProvider({ location: () => null })]
]) {
  await test(`contract (${name}): hits carry source, captions, score and used-in`, async () => {
    assert.equal(await provider.available(), true)
    const res = await provider.search('harbour', { match: 'words' })
    assert.equal(res.provider, name)
    assert.equal(res.meaning, 'off')
    assert.ok(res.hits.length > 0)
    for (const h of res.hits) {
      assert.match(h.key, /^(archive|well|triage):/)
      assert.ok(SOURCES.has(h.source), h.source)
      assert.match(h.thumbUrl, /^twarchive:\/\/f\//)
      for (const f of ['title', 'detail', 'ocrText']) assert.equal(typeof h[f], 'string', f)
      assert.equal(h.match, 'words')
      assert.ok(h.score >= 0 && h.score <= 1, String(h.score))
      assert.ok(Array.isArray(h.usedIn))
      const served = await provider.fileFor(h.thumbUrl)
      assert.ok(served && served.provenance.source && served.provenance.note.includes(served.absPath), h.key)
    }
    assert.equal(new Set(res.hits.map((h) => h.key)).size, res.hits.length, 'keys are unique')
  })
  await test(`contract (${name}): an empty query finds nothing; no store means unavailable`, async () => {
    assert.deepEqual((await provider.search('   ', { match: 'words' })).hits, [])
    assert.equal(await absent.available(), false)
    assert.equal(await absent.search('harbour'), null)
  })
  await test(`contract (${name}): files outside what it serves are refused`, async () => {
    assert.equal(await provider.fileFor(twarchiveUrl('/etc/hosts')), null)
    assert.equal(await provider.fileFor(twarchiveUrl(join(archiveRoot, '..', 'Captures', 'not-returned.png'))), null)
    assert.equal(await provider.fileFor('twarchive://f/%E0%A4%A'), null)
    assert.equal(await provider.fileFor(twarchiveUrl(join(archiveRoot, 'media-store', 'missing.png'))), null)
  })
}

// ── archive: the palette sees exactly what it always saw ─────────────────────────────────────
const legacyHit = (sha, pid, rel, text, path, title) => ({
  assetKey: sha, presentationId: pid, relPath: rel, sha256: sha, ocrText: text, thumbUrl: 'twarchive://f/' + Buffer.from(path).toString('base64url'), deckTitle: title
})
const expectedPalette = [
  legacyHit(SHA_A, 'Harbour Talk 2019', 'media/image1.png', 'Harbour lights map with long caption text', fileA, 'Harbour Talk 2019'),
  legacyHit(SHA_C, PID_UUID, 'media/image3.png', 'harbour lights 50% off_sale', fileC, undefined),
  legacyHit(SHA_B, 'Harbour Talk 2019', 'media/image2.jpg', 'Harbour lights', fileB, 'Harbour Talk 2019')
]
await test('archive: palette results without SlideWell are today\'s, in today\'s order', async () => {
  for (const search of [
    createImageSearch({ slidewell: null, archive }),
    createImageSearch({ slidewell: slidewellProvider({ location: () => null }), archive })
  ]) {
    assert.deepEqual(await search.status(), { provider: 'archive' })
    assert.deepEqual(await search.paletteSearch('harbour lights'), expectedPalette)
    assert.deepEqual(await search.paletteSearch(''), [])
  }
})
await test('archive: LIKE wildcards are literal, words are ANDed, slides and missing files skipped', async () => {
  const search = createImageSearch({ slidewell: null, archive })
  assert.deepEqual((await search.paletteSearch('50%')).map((h) => h.assetKey), [SHA_C])
  assert.deepEqual((await search.paletteSearch('off_sale')).map((h) => h.assetKey), [SHA_C])
  assert.deepEqual(await search.paletteSearch('harbour zebra'), [])
  assert.deepEqual((await search.paletteSearch('slide')).length, 0)
})
await test('archive: import provenance is unchanged; nothing at all without an archive', async () => {
  const f = await archive.fileFor(twarchiveUrl(fileB))
  assert.deepEqual(f, { absPath: fileB, provenance: { source: 'ppt-archive', note: 'imported from ppt-archive: ' + fileB } })
  assert.equal((await archive.fileFor(fileB))?.absPath, fileB, 'a raw absolute path still works, as before')
  const none = createImageSearch({ slidewell: null, archive: createArchiveProvider({ archiveRoot: () => null, sqlite3: () => sqlite3 }) })
  assert.deepEqual(await none.status(), { provider: null })
  assert.equal(await none.paletteSearch('harbour'), null)
})

// ── SlideWell ─────────────────────────────────────────────────────────────────────────────
const before = { well: digest(join(wellRoot, 'well.db')), triage: digest(join(wellRoot, 'triage.db')), files: readdirSync(wellRoot).sort() }
const search = createImageSearch({ slidewell, archive })

await test('slidewell: a screenshot is found by its window title, with app and date', async () => {
  const res = await search.search('Layout Showcase', { match: 'words' })
  assert.equal(res.provider, 'slidewell')
  const hit = res.hits.find((h) => h.windowTitle === 'Harbour Lights Layout Showcase')
  assert.ok(hit, JSON.stringify(res.hits.map((h) => h.title)))
  assert.equal(hit.key, 'triage:aaaa11112222')
  assert.equal(hit.source, 'screenshot')
  assert.equal(hit.app, 'Google Chrome')
  assert.equal(hit.date, '2026-10-08')
  assert.equal(hit.title, 'Harbour Lights Layout Showcase')
  assert.equal(hit.detail, 'Google Chrome · 2026-10-08')
  assert.equal(hit.score, 1)
  assert.equal((await search.fileFor(hit.thumbUrl)).absPath, shotFile)
  assert.equal((await search.fileFor(hit.thumbUrl)).provenance.source, 'screenshot')
  // prefix match while typing, and the palette's shape carries the caption
  assert.ok((await search.search('Showc', { match: 'words' })).hits.some((h) => h.key === hit.key))
  const palette = await search.paletteSearch('Layout Showcase')
  assert.ok(palette.some((p) => p.assetKey === 'triage:aaaa11112222' && p.deckTitle === 'Harbour Lights Layout Showcase · Google Chrome · 2026-10-08'))
})
await test('slidewell: emptied, Bin and online-only screenshots stay hidden; a fresh throwaway is listed', async () => {
  const titles = (await search.search('Harbour Lights', { match: 'words' })).hits.map((h) => h.title)
  assert.ok(titles.includes('Harbour Lights Fresh Throwaway'))
  for (const gone of ['Harbour Lights Old Draft', 'Harbour Lights Bin Copy', 'Harbour Lights Online Only']) assert.ok(!titles.includes(gone), gone)
  assert.ok(!(await search.search('old draft', { match: 'words' })).hits.some((h) => h.key === 'well:e1e1e1e'), 'emptied well copy hidden too')
})
await test('slidewell: a screenshot kept into the well is one hit, served from the well copy', async () => {
  const hits = (await search.search('harbour plan', { match: 'words' })).hits.filter((h) => h.key === 'well:c0ffee1' || h.key === 'triage:ffff11112222')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].key, 'well:c0ffee1')
  assert.equal(hits[0].windowTitle, 'Harbour Lights Plan')
  assert.equal((await search.fileFor(hits[0].thumbUrl)).absPath, wellCopy)
  rmSync(wellCopy)
  const again = (await search.search('harbour plan', { match: 'words' })).hits.find((h) => h.key === 'well:c0ffee1')
  assert.equal((await search.fileFor(again.thumbUrl)).absPath, keptFile, 'original used when the copy is gone')
  file(wellCopy)
})
await test('slidewell: talk images say which talks use them, only for the vault SlideWell scanned', async () => {
  const hit = (await search.search('tidal', { match: 'words' })).hits.find((h) => h.key === 'well:abc1234')
  assert.equal(hit.source, 'talk-image')
  assert.equal(hit.title, 'Ports Again')
  assert.deepEqual(hit.usedIn, [
    { talkTitle: 'Ports Again', talkPath: 'talks/ports-outline.md', slide: 0 },
    { talkTitle: 'Tides and Ports', talkPath: 'talks/tides-outline.md', slide: 3 }
  ])
  assert.equal((await search.fileFor(hit.thumbUrl)).absPath, talkImage)
  vaultRoots = [otherVault, vault]
  const elsewhere = (await search.search('tidal', { match: 'words' })).hits.find((h) => h.key === 'well:abc1234')
  assert.deepEqual(elsewhere.usedIn, [])
  vaultRoots = [vault]
})
await test('slidewell: words from every source, old-PowerPoint images included, best title match first', async () => {
  const hits = (await search.search('harbour lights', { match: 'words' })).hits
  assert.ok(hits.some((h) => h.source === 'archive-image'))
  assert.ok(hits.some((h) => h.source === 'screenshot'))
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score)
})
await test('slidewell: picture matches follow the words, never repeat them, in SlideWell\'s order', async () => {
  pictureAnswer = { ok: true, hits: [
    { id: 'slide:Harbour Talk 2019#2', score: 0.95 },
    { id: 'well:d00d001', score: 0.81 },
    { id: 'triage:aaaa11112222', score: 0.8 },
    { id: 'well:c0ffee1', score: 0.7 }, // a kept screenshot, asked for by its well id
    { id: 'well:0000000', score: 0.6 },
    { id: 'triage:dddd11112222', score: 0.5 }
  ] }
  asked.length = 0
  const res = await search.search('Layout Showcase')
  assert.equal(res.meaning, 'used')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].text, 'Layout Showcase')
  const words = res.hits.filter((h) => h.match === 'words')
  const related = res.hits.filter((h) => h.match === 'meaning')
  assert.deepEqual(res.hits.slice(0, words.length), words, 'words band first')
  assert.deepEqual(related.map((h) => [h.key, h.score]), [['well:d00d001', 0.81], ['well:c0ffee1', 0.7], ['triage:dddd11112222', 0.5]])
  assert.ok(!related.some((h) => h.key === 'triage:aaaa11112222'), 'a words hit is not repeated')
  assert.equal(related[1].windowTitle, 'Harbour Lights Plan', 'its window title comes along')
  asked.length = 0
  assert.equal((await search.search('Layout Showcase', { match: 'words' })).meaning, 'off')
  assert.equal(asked.length, 0, 'Words makes no picture query')
  const meaningOnly = await search.search('Layout Showcase', { match: 'meaning' })
  assert.ok(meaningOnly.hits.every((h) => h.match === 'meaning'))
  assert.equal(meaningOnly.hits[0].key, 'well:d00d001')
  pictureAnswer = { ok: false, reason: 'not-running' }
  const off = await search.search('Layout Showcase')
  assert.equal(off.meaning, 'unavailable')
  assert.ok(off.hits.some((h) => h.key === 'triage:aaaa11112222'), 'words still answer without SlideWell running')
})
await test('slidewell: only files a search returned are served', async () => {
  const fresh = slidewellProvider()
  assert.equal(await fresh.fileFor(twarchiveUrl(freshFile)), null, 'not returned yet')
  await fresh.search('Fresh Throwaway', { match: 'words' })
  assert.equal((await fresh.fileFor(twarchiveUrl(freshFile)))?.absPath, freshFile)
  assert.equal(await fresh.fileFor(twarchiveUrl(binFile)), null, 'a hidden item is never served')
  assert.equal(await fresh.fileFor(twarchiveUrl(emptiedFile)), null)
  assert.equal((await fresh.fileFor(twarchiveUrl(fileA)))?.provenance.source, 'ppt-archive', 'archive files as before')
})
await test('slidewell: the store is never written', async () => {
  assert.equal(digest(join(wellRoot, 'well.db')), before.well)
  assert.equal(digest(join(wellRoot, 'triage.db')), before.triage)
  assert.deepEqual(readdirSync(wellRoot).sort(), before.files)
})
await test('fallback: a failing SlideWell provider hands the search to the archive', async () => {
  const broken = { name: 'slidewell', available: async () => true, search: async () => { throw new Error('store locked') }, fileFor: async () => null }
  const s = createImageSearch({ slidewell: broken, archive })
  const res = await s.search('harbour lights')
  assert.equal(res.provider, 'archive')
  assert.deepEqual(res.hits.map(toPaletteHit), expectedPalette)
})
await test('fts query: user text is always quoted words, never syntax', () => {
  assert.equal(ftsQuery(['Layout', 'Show"case', 'OR', 'NEAR(x']), '"Layout"* "Showcase"* "OR"* "NEAR(x"*')
})
await test('locate: SlideWell found from its config, its default, or not at all', async () => {
  const home = dir('home')
  assert.equal(locateSlideWell(home), null)
  const support = dir('home', 'Library', 'Application Support', 'SlideWell')
  writeFileSync(join(support, 'config.json'), JSON.stringify({ wellRoot }))
  assert.deepEqual(locateSlideWell(home), { wellRoot, socketPath: join(support, 'picture-query.sock') })
  writeFileSync(join(support, 'config.json'), JSON.stringify({}))
  assert.equal(locateSlideWell(home), null, 'default well folder has no store')
  const defaultWell = dir('home', 'SlideWell', 'well')
  file(join(defaultWell, 'triage.db'))
  assert.equal(locateSlideWell(home)?.wellRoot, defaultWell)
})

// ── fix round 1 ─────────────────────────────────────────────────────────────────────────────
// A sqlite3 stand-in that logs every script it is given, so a test can see which queries ran.
const sqlLog = join(base, 'sqlite3-calls.log')
const loggingSqlite3 = join(dir('bin'), 'sqlite3-logging')
writeFileSync(loggingSqlite3, `#!/bin/sh\nin=$(cat)\nprintf '%s\\n--call--\\n' "$in" >> ${JSON.stringify(sqlLog)}\nprintf '%s\\n' "$in" | exec ${JSON.stringify(sqlite3)} "$@"\n`)
chmodSync(loggingSqlite3, 0o755)
// macOS scans a new executable on its first run, which can outlast the 500 ms read limit: run it once untimed
execFileSync(loggingSqlite3, [':memory:'], { input: 'SELECT 1;' })
const loggedCalls = () => (existsSync(sqlLog) ? readFileSync(sqlLog, 'utf8').split('--call--').filter((c) => c.trim()) : [])

await test('T2: an empty or quote-only query makes no FTS call and finds nothing', async () => {
  rmSync(sqlLog, { force: true })
  const logged = slidewellProvider({ sqlite3: () => loggingSqlite3 })
  asked.length = 0
  for (const q of ['"', '"" "', '   ']) {
    assert.deepEqual(await logged.search(q), { provider: 'slidewell', hits: [], meaning: 'off' }, JSON.stringify(q))
  }
  assert.ok(!loggedCalls().some((c) => c.includes('MATCH')), 'no MATCH was sent')
  assert.equal(asked.length, 0, 'no picture query either')
  assert.equal(ftsQuery(['"', '""']), '')
  // a quoted word is still searched, as the word
  assert.ok((await logged.search('"pelican"', { match: 'words' })).hits.some((h) => h.key === 'well:f00f001'))
})

await test('S2: a well item is found by its file name alone, word by word, without duplicates', async () => {
  const keys = async (q) => (await search.search(q, { match: 'words' })).hits.map((h) => h.key)
  for (const q of ['pelican', 'wharf', 'Pelic', 'pelican-wh', 'pelican wharf', 'f00f001']) assert.ok((await keys(q)).includes('well:f00f001'), q)
  for (const q of ['lican', 'pelican zebra', '%ican', 'p_lican', 'pelican%']) assert.ok(!(await keys(q)).includes('well:f00f001'), q)
  const marina = await keys('marina')
  assert.equal(marina.filter((k) => k === 'well:d00d001').length, 1, 'found by text and by name, listed once')
  assert.equal((await search.fileFor((await search.search('pelican', { match: 'words' })).hits.find((h) => h.key === 'well:f00f001').thumbUrl)).absPath, pelicanFile)
  assert.ok(!(await keys('old-draft')).includes('well:e1e1e1e'), 'an emptied item stays hidden by name too')
  assert.equal(fileNameWhere(['"', '-']), null)
  assert.deepEqual(fileNameWhere(['50%_x']).params, ['% 50\\%%', '% 50\\%%', '% x%', '% x%'])
})

// From here on SlideWell's store is changed under the provider, as SlideWell would change it.
await test('S3: serving and import follow SlideWell\'s state now, not when the search ran', async () => {
  const p = slidewellProvider()
  const urlFor = async (q, key) => (await p.search(q, { match: 'words' })).hits.find((h) => h.key === key)?.thumbUrl
  const triageDb = join(wellRoot, 'triage.db')
  const wellDb = join(wellRoot, 'well.db')
  const fresh = await urlFor('Fresh Throwaway', 'triage:dddd11112222')
  const pelican = await urlFor('pelican', 'well:f00f001')
  const marina = await urlFor('marina', 'well:d00d001')
  assert.ok(fresh && pelican && marina)
  const served = async (url) => (await p.fileFor(url))?.absPath ?? null
  assert.equal(await served(fresh), freshFile)

  sql(triageDb, `INSERT INTO triage_decisions VALUES ('dddd11112222', 'emptied', ${lit(ago(0))}, NULL);`)
  assert.equal(await served(fresh), null, 'emptied after the search')
  sql(triageDb, `DELETE FROM triage_decisions WHERE hash = 'dddd11112222';`)
  assert.equal(await served(fresh), freshFile, 'rescued: served again')
  sql(triageDb, `UPDATE sorter_proposals SET throwaway_since = ${lit(ago(31))} WHERE hash = 'dddd11112222';`)
  assert.equal(await served(fresh), null, 'its Bin clock ran out')
  sql(triageDb, `UPDATE sorter_proposals SET throwaway_since = ${lit(ago(5))} WHERE hash = 'dddd11112222';
    UPDATE triage_fts SET offline = '1' WHERE hash = 'dddd11112222';`)
  assert.equal(await served(fresh), null, 'now online-only')
  sql(triageDb, `UPDATE triage_fts SET offline = '0' WHERE hash = 'dddd11112222';`)
  assert.equal(await served(fresh), freshFile)

  sql(wellDb, `INSERT INTO well_sources VALUES ('f00f001', '9999aaaa0000');`)
  sql(triageDb, `INSERT INTO triage_decisions VALUES ('9999aaaa0000', 'emptied', ${lit(ago(0))}, 'f00f001');`)
  assert.equal(await served(pelican), null, 'a well item emptied from the Bin')
  sql(wellDb, `DELETE FROM well_fts WHERE id = 'd00d001';`)
  assert.equal(await served(marina), null, 'a well item SlideWell no longer has')

  // thumbnails arriving together: one re-check query per database, each answered for itself
  rmSync(sqlLog, { force: true })
  const logged = slidewellProvider({ sqlite3: () => loggingSqlite3 })
  const shot = (await logged.search('Layout Showcase', { match: 'words' })).hits.find((h) => h.key === 'triage:aaaa11112222').thumbUrl
  const fresh2 = (await logged.search('Fresh Throwaway', { match: 'words' })).hits.find((h) => h.key === 'triage:dddd11112222').thumbUrl
  sql(triageDb, `INSERT INTO triage_decisions VALUES ('dddd11112222', 'emptied', ${lit(ago(0))}, NULL);`)
  rmSync(sqlLog, { force: true })
  const answers = await Promise.all([logged.fileFor(shot), logged.fileFor(fresh2), logged.fileFor(shot)])
  assert.deepEqual(answers.map((a) => a?.absPath ?? null), [shotFile, null, shotFile])
  assert.equal(loggedCalls().filter((c) => c.includes('triage_fts.hash IN')).length, 1)
  sql(triageDb, `DELETE FROM triage_decisions WHERE hash = 'dddd11112222';`)
})

await test('T1: the archive serves only images the registry lists or a search returned', async () => {
  const unsearched = createArchiveProvider({ archiveRoot: () => archiveRoot, sqlite3: () => sqlite3 })
  writeFileSync(join(archiveRoot, 'package.json'), '{"name":"invented"}')
  const fakePng = file(join(archiveRoot, 'media-store', 'f'.repeat(64) + '.png'), 'not an image at all')
  const unlisted = file(join(archiveRoot, 'media-store', '1'.repeat(64) + '.png'))
  const loose = file(join(dir('archive', 'loose'), 'picture.png'))
  file(join(dir('archive', 'extracted', 'Invented Deck', 'media'), 'image9.png'))
  for (const refused of [join(archiveRoot, 'registry', 'media.db'), join(archiveRoot, 'package.json'), fakePng, unlisted, loose,
    join(archiveRoot, 'extracted', 'Invented Deck', 'media', 'image9.png')]) {
    assert.equal(await unsearched.fileFor(twarchiveUrl(refused)), null, refused)
    assert.equal(await unsearched.fileFor(refused), null, 'raw path ' + refused)
    assert.equal(await search.fileFor(twarchiveUrl(refused)), null, 'through the seam ' + refused)
  }
  // registry members are served without a search: sharded store, flat store, extracted copy
  for (const listed of [fileA, fileB, fileC]) assert.equal((await unsearched.fileFor(twarchiveUrl(listed)))?.absPath, listed)
  // a real image the search returned is served; the same bytes renamed to .txt are not
  assert.equal((await archive.fileFor(twarchiveUrl(fileA)))?.absPath, fileA)
  const renamed = join(archiveRoot, 'media-store', SHA_B + '.txt')
  cpSync(fileB, renamed)
  assert.equal(await unsearched.fileFor(twarchiveUrl(renamed)), null)
})

await test('S1: reads wait at most 250 ms for SlideWell\'s lock and are killed at 500 ms', async () => {
  assert.equal(READ_BUSY_MS <= 250 && READ_LIMIT_MS <= 500, true)
  const busyRoot = dir('Busy', 'well')
  for (const db of ['well.db', 'triage.db']) cpSync(join(wellRoot, db), join(busyRoot, db))
  const busyTriage = join(busyRoot, 'triage.db')
  const p = slidewellProvider({ location: () => ({ wellRoot: busyRoot, socketPath: join(base, 'no.sock') }), readLimits: undefined })
  // Unlocked reads under the app's limits can still lose a race with a loaded machine: a few tries.
  const retry = async (fn) => { for (let i = 0; ; i++) { const v = await fn(); if (v || i === 4) return v } }
  const issuedShot = await retry(async () => (await p.search('Layout Showcase', { match: 'words' }))?.hits.find((h) => h.key === 'triage:aaaa11112222')?.thumbUrl)
  assert.ok(issuedShot)

  // SlideWell holds a write lock: TalkWeaver gives up quickly instead of queueing behind it
  const writer = spawn(sqlite3, [busyTriage], { stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise((resolve) => {
    writer.stdout.on('data', (d) => { if (String(d).includes('locked')) resolve() })
    writer.stdin.write("BEGIN EXCLUSIVE;\nINSERT INTO triage_decisions VALUES ('zz01', 'selected', NULL, NULL);\nSELECT 'locked';\n")
  })
  let t0 = Date.now()
  const res = await p.search('Layout Showcase', { match: 'words' })
  const searchMs = Date.now() - t0
  t0 = Date.now()
  const servedWhileLocked = await p.fileFor(issuedShot)
  const fileForMs = Date.now() - t0
  writer.stdin.end('ROLLBACK;\n.quit\n')
  await new Promise((resolve) => writer.on('exit', resolve))
  assert.ok(searchMs < 1500, `search took ${searchMs} ms`)
  assert.ok(!res || !res.hits.some((h) => h.source === 'screenshot'), 'no screenshot rows read through the lock')
  assert.equal(servedWhileLocked, null, 'state unknown: refused')
  assert.ok(fileForMs < 1500, `fileFor took ${fileForMs} ms`)
  assert.equal((await retry(() => p.fileFor(issuedShot)))?.absPath, shotFile, 'served again once SlideWell is done')

  // A slow TalkWeaver read is killed at the limit, so SlideWell's commit goes through
  const slow = sqliteQuery({
    binary: sqlite3, dbPath: busyTriage, busyTimeoutMs: READ_BUSY_MS, timeoutMs: READ_LIMIT_MS, escapePaths: true,
    sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS n FROM c, (SELECT count(*) FROM triage_decisions) WHERE x < 5000000000'
  }).then(() => 'finished', () => 'killed')
  await new Promise((r) => setTimeout(r, 120))
  t0 = Date.now()
  await new Promise((resolve, reject) => execFile(sqlite3, [busyTriage], (err) => (err ? reject(err) : resolve())).stdin.end(
    ".timeout 4000\nINSERT INTO triage_decisions VALUES ('zz02', 'selected', NULL, NULL);\n"))
  const commitMs = Date.now() - t0
  assert.equal(await slow, 'killed')
  assert.ok(commitMs < 1500, `SlideWell's commit waited ${commitMs} ms`)
  assert.equal(execFileSync(sqlite3, [busyTriage, "SELECT count(*) FROM triage_decisions WHERE hash = 'zz02'"]).toString().trim(), '1')
  // a read-only reader of a rollback-journal store leaves no sidecar files behind
  assert.equal(execFileSync(sqlite3, [busyTriage, 'PRAGMA journal_mode']).toString().trim(), 'delete')
  assert.deepEqual(readdirSync(busyRoot).sort(), ['triage.db', 'well.db'])
})

// ── fix round 2 ─────────────────────────────────────────────────────────────────────────────
// A fresh copy of the store, with the old draft's well copy (e1e1e1e) relinked to a screenshot that
// is not emptied yet (and not in the scan, so it is listed as a well item), and two well images whose
// names hold a backslash and a tab.
const r2Root = dir('Round2', 'well')
for (const db of ['well.db', 'triage.db']) cpSync(join(wellRoot, db), join(r2Root, db))
const r2Triage = join(r2Root, 'triage.db')
sql(join(r2Root, 'well.db'), `UPDATE well_sources SET source_hash = '7777aaaa0000' WHERE well_id = 'e1e1e1e';`)
const draftFile = file(join(dir('Round2', 'well', 'images'), 'old-draft--e1e1e1e.webp'))
const slashFox = file(join(r2Root, 'images', 'red\\fox--a1a1a1a.webp'))
const tabFox = file(join(r2Root, 'images', 'red\tfox--b2b2b2b.webp'))
sql(join(r2Root, 'well.db'), `
  ${wellRow('a1a1a1a', 'red\\fox', 'webp', 'images/red\\fox--a1a1a1a.webp', 'well', 'screenshot', '', '', '', '2026-08-02T09:00:00Z')}
  ${wellRow('b2b2b2b', 'red\tfox', 'webp', 'images/red\tfox--b2b2b2b.webp', 'well', 'screenshot', '', '', '', '2026-08-02T09:00:00Z')}
`)
const r2Provider = (limits) => slidewellProvider({ location: () => ({ wellRoot: r2Root, socketPath: join(base, 'no.sock') }), readLimits: limits })

await test('round 2: a schema read that fails is not kept and does not let an emptied item through', async () => {
  // schemaTtlMs 0: every call reads the tables again, as after the 5 s cache runs out
  const p = r2Provider({ busyMs: 100, limitMs: 8000, schemaTtlMs: 0 })
  const draftUrl = (await p.search('old draft', { match: 'words' })).hits.find((h) => h.key === 'well:e1e1e1e')?.thumbUrl
  assert.ok(draftUrl, 'listed while not emptied')
  assert.equal((await p.fileFor(draftUrl))?.absPath, draftFile)
  sql(r2Triage, `INSERT INTO triage_decisions VALUES ('7777aaaa0000', 'emptied', ${lit(ago(0))}, 'e1e1e1e');`)

  const writer = spawn(sqlite3, [r2Triage], { stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise((resolve) => {
    writer.stdout.on('data', (d) => { if (String(d).includes('locked')) resolve() })
    writer.stdin.write("BEGIN EXCLUSIVE;\nINSERT INTO triage_decisions VALUES ('zz03', 'selected', NULL, NULL);\nSELECT 'locked';\n")
  })
  try {
    const during = await p.search('old draft', { match: 'words' })
    assert.ok(!during?.hits.some((h) => h.key === 'well:e1e1e1e'), 'not returned while triage is locked')
    assert.equal(await p.fileFor(draftUrl), null, 'not served while triage is locked')
    // a well image with no screenshot behind it cannot have been emptied: still found
    assert.ok((await p.search('tidal', { match: 'words' }))?.hits.some((h) => h.key === 'well:abc1234'))
  } finally {
    writer.stdin.end('ROLLBACK;\n.quit\n')
    await new Promise((resolve) => writer.on('exit', resolve))
  }
  // with the default cache: a context read under the lock is not kept
  const cached = r2Provider({ busyMs: 100, limitMs: 8000 })
  const after = await p.search('old draft', { match: 'words' })
  assert.ok(after && !after.hits.some((h) => h.key === 'well:e1e1e1e'), 'still hidden once the lock clears')
  assert.equal(await p.fileFor(draftUrl), null, 'still not served')
  assert.ok(!(await cached.search('old draft', { match: 'words' })).hits.some((h) => h.key === 'well:e1e1e1e'))
})

await test('round 2: a schema read under a lock is retried on the next call, not cached', async () => {
  const p = r2Provider({ busyMs: 100, limitMs: 8000 }) // default 5 s schema cache
  const writer = spawn(sqlite3, [r2Triage], { stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise((resolve) => {
    writer.stdout.on('data', (d) => { if (String(d).includes('locked')) resolve() })
    writer.stdin.write("BEGIN EXCLUSIVE;\nINSERT INTO triage_decisions VALUES ('zz04', 'selected', NULL, NULL);\nSELECT 'locked';\n")
  })
  let during
  try {
    during = await p.search('Layout Showcase', { match: 'words' })
  } finally {
    writer.stdin.end('ROLLBACK;\n.quit\n')
    await new Promise((resolve) => writer.on('exit', resolve))
  }
  assert.ok(!during?.hits.some((h) => h.key === 'triage:aaaa11112222'), 'no screenshots while locked')
  assert.ok((await p.search('Layout Showcase', { match: 'words' })).hits.some((h) => h.key === 'triage:aaaa11112222'), 'screenshots back at once')
})

await test('round 2: query words and file names split at the same separators (backslash, tab)', async () => {
  const p = r2Provider()
  for (const q of ['fox', 'red fox', 'red\\fox', 'Fo']) {
    const res = (await p.search(q, { match: 'words' })).hits
    const found = res.filter((h) => h.key === 'well:a1a1a1a' || h.key === 'well:b2b2b2b').map((h) => h.key).sort()
    assert.deepEqual(found, ['well:a1a1a1a', 'well:b2b2b2b'], q)
  }
  const fox = (await p.search('fox', { match: 'words' })).hits
  assert.equal((await p.fileFor(fox.find((h) => h.key === 'well:a1a1a1a').thumbUrl)).absPath, slashFox)
  assert.equal((await p.fileFor(fox.find((h) => h.key === 'well:b2b2b2b').thumbUrl)).absPath, tabFox)
  assert.ok(!(await p.search('ox', { match: 'words' })).hits.some((h) => h.key === 'well:a1a1a1a'), 'still a word prefix')
})

await test('round 2: a PNG needs all eight signature bytes', async () => {
  assert.equal(imageMagic(Buffer.from('89504e470d0a1a0a00', 'hex')), 'png')
  assert.equal(imageMagic(Buffer.from('89504e470d0a0000', 'hex')), null)
  const bad = file(join(archiveRoot, 'media-store', SHA_A.slice(0, 2), '2'.repeat(64) + '.png'), Buffer.concat([Buffer.from('89504e470d0a0000', 'hex'), Buffer.from('invented data')]))
  sql(join(archiveRoot, 'registry', 'media.db'), `INSERT INTO ocr_assets VALUES ('${'2'.repeat(64)}', 'Invented Deck', 'media/image8.png', 'image', 'broken signature');`)
  const unsearched = createArchiveProvider({ archiveRoot: () => archiveRoot, sqlite3: () => sqlite3 })
  assert.equal(await unsearched.fileFor(twarchiveUrl(join(archiveRoot, 'media-store', '2'.repeat(64) + '.png'))), null)
  assert.equal(await unsearched.fileFor(twarchiveUrl(bad)), null, 'registered, but not a PNG')
})

rmSync(base, { recursive: true, force: true })
console.log(`image search seam: ${passed} passed`)
