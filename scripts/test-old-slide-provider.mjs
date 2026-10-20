// Old slides from the archive's own registry (ticket 12): slides.db + images.db + media.db + renders,
// read-only, through the archive provider and the one image search. Real SQLite fixtures in a temp
// folder; every name in them is invented.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveRenderPath, createArchiveProvider } from '../src/main/image-search/archive-provider.ts'
import { createImageSearch } from '../src/main/image-search/image-search.ts'
import { detectSqlite3 } from '../src/main/image-search/sqlite-read.ts'
import { pathFromThumbUrl } from '../src/main/image-search/thumb-url.ts'

const sqlite3 = detectSqlite3()
assert.ok(sqlite3, 'sqlite3 must be on this machine')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-old-slides-')))
const dir = (...p) => { const d = join(root, ...p); mkdirSync(d, { recursive: true }); return d }
const sql = (db, script) => execFileSync(sqlite3, [db], { input: script })
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fixture')])
const SHA = 'c'.repeat(64)
const PID = 'Oxford AI Day - 05 Jun 25'

dir('registry'); dir('extracted', PID, 'renders'); dir('extracted', PID, 'media'); dir('media-store')
writeFileSync(join(root, 'extracted', PID, 'renders', 'slide_0003.png'), PNG)
writeFileSync(join(root, 'extracted', PID, 'renders', 'slide_0004.png'), PNG)
writeFileSync(join(root, 'extracted', PID, 'media', 'slide_3_1.png'), PNG)
sql(join(root, 'registry', 'slides.db'), `
  CREATE TABLE slides (content_hash TEXT PRIMARY KEY, title TEXT, text_content TEXT);
  CREATE VIRTUAL TABLE slides_fts USING fts5(title, text_content, content='slides', content_rowid='rowid');
  CREATE TABLE slide_locations (content_hash TEXT, presentation_id TEXT, slide_order INTEGER, role TEXT);
  INSERT INTO slides VALUES ('h1', 'What AI literacy is not', 'What AI literacy is not' || char(10) || 'Not prompt tricks' || char(10) || 'Not a tool list');
  INSERT INTO slides VALUES ('h2', 'Cover only', 'Cover only');
  INSERT INTO slides VALUES ('h3', 'Literacy with no render', 'literacy');
  INSERT INTO slide_locations VALUES ('h1', '${PID}', 2, 'content'), ('h2', '${PID}', 3, 'content'), ('h3', '${PID}', 9, 'content');
  INSERT INTO slides_fts(rowid, title, text_content) SELECT rowid, title, text_content FROM slides;
`)
sql(join(root, 'registry', 'images.db'), `
  CREATE TABLE image_locations (sha256 TEXT, presentation_id TEXT, slide_order INTEGER);
  INSERT INTO image_locations VALUES ('${SHA}', '${PID}', 2);
`)
sql(join(root, 'registry', 'media.db'), `
  CREATE TABLE ocr_assets (asset_key TEXT, presentation_id TEXT, rel_path TEXT, kind TEXT, text TEXT);
  INSERT INTO ocr_assets VALUES ('${SHA}', '${PID}', 'media/slide_3_1.png', 'image', 'diagram');
`)

// The suite runs beside many others: roomy limits here so a slow process start is not a failure.
const ROOMY = { busyMs: 2000, limitMs: 8000, searchMs: 20000, manifestMs: 5000 }
const archive = createArchiveProvider({ archiveRoot: () => root, sqlite3: () => sqlite3, readLimits: ROOMY })
const hits = await archive.slideHits('literacy')
assert.deepEqual(hits.map((h) => h.key), ['old-slide:h1'], 'a slide with no render on disk is not offered; "Cover only" does not match')
const h = hits[0]
assert.equal(h.source, 'old-slide')
assert.equal(h.title, 'What AI literacy is not')
assert.equal(h.presentationTitle, PID)
assert.equal(pathFromThumbUrl(h.thumbUrl), join(root, 'extracted', PID, 'renders', 'slide_0003.png'), 'the render of slide order 2 is page 3')
assert.deepEqual(h.oldSlide.paragraphs, ['What AI literacy is not', 'Not prompt tricks', 'Not a tool list'])
assert.equal(h.oldSlide.slideNumber, 3)
assert.equal(h.oldSlide.images.length, 1)
assert.equal(pathFromThumbUrl(h.oldSlide.images[0].thumbUrl), join(root, 'extracted', PID, 'media', 'slide_3_1.png'))
// what a search returned can be imported: the render and the picture are both served with provenance
for (const url of [h.thumbUrl, h.oldSlide.images[0].thumbUrl]) {
  const f = await archive.fileFor(url)
  assert.ok(f && f.provenance.source === 'ppt-archive', 'served with archive provenance')
}
assert.equal(await archive.fileFor('twarchive://' + encodeURIComponent(join(root, 'registry', 'slides.db'))), null, 'the registry itself is never served')
assert.deepEqual(await archive.slideHits(''), [])
assert.deepEqual(await archive.slideHits('"'), [])

// the one search appends old slides to the pictures
const search = createImageSearch({ slidewell: null, archive })
const res = await search.search('literacy')
assert.ok(res && res.hits.some((x) => x.source === 'old-slide'))

// no slide index: nothing, quietly
const bare = createArchiveProvider({ archiveRoot: () => dir('bare'), sqlite3: () => sqlite3, readLimits: ROOMY })
assert.deepEqual(await bare.slideHits('literacy'), [])

// --- the render manifest and the renders stay inside the archive (fix round 1, defect 2)
// Everything here is in one presentation folder each; `outside` is a sibling of the archive root.
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tw-old-slides-outside-')))
mkdirSync(join(outside, 'renders'), { recursive: true })
writeFileSync(join(outside, 'renders', 'slide_0001.png'), PNG)
writeFileSync(join(outside, 'renders', 'secret.png'), PNG)
writeFileSync(join(outside, 'renders.json'), JSON.stringify({ renders: [{ slide_order: 0, render: 'renders/mapped.png' }] }))
const pres = (name) => { dir('extracted', name, 'renders'); return join(root, 'extracted', name) }
const manifest = (name, renders) => writeFileSync(join(pres(name), 'renders.json'), JSON.stringify({ renders }))
const render = (name, file) => { pres(name); writeFileSync(join(root, 'extracted', name, 'renders', file), PNG); return join(root, 'extracted', name, 'renders', file) }
const renderOf = (name, order = 0) => archiveRenderPath(root, name, order, ROOMY)

// the ordinary cases still work: a manifest maps the order to a file; without one, the numbered name
manifest('Plain mapped', [{ slide_order: 0, render: 'renders/page-seven.png' }])
const pageSeven = render('Plain mapped', 'page-seven.png')
const pageFive = render('Plain numbered', 'slide_0005.png')
assert.equal(await renderOf('Plain mapped'), pageSeven)
assert.equal(await renderOf('Plain numbered', 4), pageFive)
assert.equal(await renderOf('Plain numbered', 5), null)
// a presentation folder that is a link out of the archive
dir('extracted')
symlinkSync(outside, join(root, 'extracted', 'Linked folder'))
assert.ok(existsSync(join(root, 'extracted', 'Linked folder', 'renders', 'slide_0001.png')), 'fixture: the link resolves')
assert.equal(await renderOf('Linked folder'), null, 'a presentation folder linked out of the archive offers nothing')
// a manifest that is a link out of the archive: it is not read (its mapping would pick mapped.png)
render('Linked manifest', 'mapped.png')
symlinkSync(join(outside, 'renders.json'), join(pres('Linked manifest'), 'renders.json'))
assert.equal(await renderOf('Linked manifest'), null, 'a manifest linked out of the archive is not read')
// a manifest too big to be one
render('Huge manifest', 'mapped.png')
manifest('Huge manifest', [{ slide_order: 0, render: 'renders/mapped.png' }, ...Array.from({ length: 40000 }, (_, i) => ({ slide_order: i + 1, render: `renders/filler-${'x'.repeat(40)}-${i}.png` }))])
assert.ok(readFileSync(join(pres('Huge manifest'), 'renders.json')).length > 2 * 1024 * 1024, 'fixture: over the size limit')
assert.equal(await renderOf('Huge manifest'), null, 'an oversized manifest is not read')
// a manifest that is not what it should be: falls back to the numbered name, never throws
for (const [name, body] of [['Not json', '{"renders": ['], ['Wrong shape', '{"renders": {"0": "renders/mapped.png"}}'], ['Null', 'null'], ['Odd entries', '{"renders": [null, 7, {"slide_order": 0, "render": 42}, {"slide_order": 0}]}']]) {
  writeFileSync(join(pres(name), 'renders.json'), body)
  const numbered = render(name, 'slide_0001.png')
  assert.equal(await renderOf(name), numbered, `${name}: the numbered render is used`)
}
// a manifest that is a folder
mkdirSync(join(pres('Folder manifest'), 'renders.json'))
assert.equal(await renderOf('Folder manifest'), null)
// render paths that leave the presentation
render('Escaping renders', 'mapped.png')
symlinkSync(join(outside, 'renders', 'secret.png'), join(pres('Escaping renders'), 'renders', 'linked.png'))
symlinkSync(join(outside, 'renders'), join(pres('Escaping renders'), 'linked-renders'))
manifest('Escaping renders', [
  { slide_order: 0, render: '../Plain mapped/renders/page-seven.png' },
  { slide_order: 1, render: 'renders/../../Plain mapped/renders/page-seven.png' },
  { slide_order: 2, render: join(outside, 'renders', 'secret.png') },
  { slide_order: 3, render: 'renders/linked.png' },
  { slide_order: 4, render: 'linked-renders/secret.png' },
  { slide_order: 5, render: 'renders\u0000/mapped.png' },
  { slide_order: 6, render: 'renders/mapped.png' }
])
for (const order of [0, 1, 2, 3, 4, 5]) assert.equal(await renderOf('Escaping renders', order), null, `render path ${order} leaves the presentation and is not offered`)
assert.equal(await renderOf('Escaping renders', 6), join(pres('Escaping renders'), 'renders', 'mapped.png'), 'the honest entry beside them still works')
// a numbered render that is a link out of the archive
symlinkSync(join(outside, 'renders', 'secret.png'), join(pres('Linked render'), 'renders', 'slide_0001.png'))
assert.equal(await renderOf('Linked render'), null)
// presentation ids that are not one folder name
render('Nested', 'slide_0001.png')
writeFileSync(join(dir('extracted', 'renders'), 'slide_0001.png'), PNG)
for (const id of ['', '.', '..', 'Nested/renders', 'Nested/..', '../extracted/Nested', 'Nested\\renders', '/Nested', join(root, 'extracted', 'Nested'), 'Nested\u0000', 'Nested/']) {
  assert.equal(await archiveRenderPath(root, id, 0, ROOMY), null, `presentation id ${JSON.stringify(id)} is refused`)
}
assert.equal(await archiveRenderPath(root, 'Nested', null, ROOMY), null)
assert.equal(await archiveRenderPath(root, 'Nested', -1, ROOMY), null)
assert.equal(await archiveRenderPath(root, 'Nested', 1.5, ROOMY), null)
// a manifest or a render that is a FIFO: asked in a separate process, because a read that blocks would hang
// this one. The process must answer by itself, well inside the time allowed.
if (process.platform !== 'win32') {
  execFileSync('mkfifo', [join(pres('Fifo manifest'), 'renders.json')])
  render('Fifo manifest', 'slide_0001.png')
  execFileSync('mkfifo', [join(pres('Fifo render'), 'renders', 'slide_0001.png')])
  const provider = fileURLToPath(new URL('../src/main/image-search/archive-provider.ts', import.meta.url))
  const child = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', `
    const { archiveRenderPath } = await import(${JSON.stringify(provider)})
    const a = await archiveRenderPath(${JSON.stringify(root)}, 'Fifo manifest', 0)
    const b = await archiveRenderPath(${JSON.stringify(root)}, 'Fifo render', 0)
    console.log(JSON.stringify([a, b]))
  `], { timeout: 20000, encoding: 'utf8' })
  assert.equal(child.error, undefined, 'a FIFO in the archive does not hang the search')
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout.trim()), [join(pres('Fifo manifest'), 'renders', 'slide_0001.png'), null], 'a FIFO manifest is skipped (numbered render used); a FIFO render is not offered')
}
// --- the presentation folder swapped for a link between the check and the open (fix round 2, defect 1)
// The manifest is checked (inside the archive, a regular file) and then opened by its path. Here the
// provider's own `open` is wrapped: just before it runs, the presentation folder is replaced by a link to
// a folder outside the archive that holds a small, regular renders.json of its own; just after, the
// folder is put back. What was opened is not the file that was checked, so nothing of it may be used:
// the outside manifest names a render that does exist in the presentation, and it must not be picked.
{
  const swapped = pres('Swapped folder')
  manifest('Swapped folder', [{ slide_order: 0, render: 'renders/honest.png' }])
  const honest = render('Swapped folder', 'honest.png')
  render('Swapped folder', 'named-by-the-outside-manifest.png')
  render('Swapped folder', 'slide_0001.png')
  const outsideFolder = realpathSync(mkdtempSync(join(tmpdir(), 'tw-old-slides-swap-')))
  writeFileSync(join(outsideFolder, 'renders.json'), JSON.stringify({ renders: [{ slide_order: 0, render: 'renders/named-by-the-outside-manifest.png' }] }))
  assert.equal(await renderOf('Swapped folder'), honest, 'fixture: untouched, the manifest picks its own render')
  const realOpen = fsPromises.open
  let swaps = 0
  fsPromises.open = async (path, ...rest) => {
    if (String(path) !== join(swapped, 'renders.json')) return realOpen(path, ...rest)
    renameSync(swapped, swapped + '.held')
    symlinkSync(outsideFolder, swapped)
    swaps += 1
    try { return await realOpen(path, ...rest) } finally { unlinkSync(swapped); renameSync(swapped + '.held', swapped) }
  }
  syncBuiltinESMExports()
  let got
  try { got = await renderOf('Swapped folder') } finally { fsPromises.open = realOpen; syncBuiltinESMExports() }
  assert.equal(swaps, 1, 'fixture: the folder was swapped once, between the check and the open')
  assert.equal(got, null, 'a manifest that is not the file that was checked: nothing is read from it and the slide is not offered')
  assert.equal(await renderOf('Swapped folder'), honest, 'with the folder back as it was, the slide is offered again')
  // the manifest itself replaced by another regular file between the check and the open: also not the file checked
  fsPromises.open = async (path, ...rest) => {
    if (String(path) === join(swapped, 'renders.json')) {
      writeFileSync(join(swapped, 'renders.next'), JSON.stringify({ renders: [{ slide_order: 0, render: 'renders/named-by-the-outside-manifest.png' }] }))
      renameSync(join(swapped, 'renders.next'), join(swapped, 'renders.json'))
    }
    return realOpen(path, ...rest)
  }
  syncBuiltinESMExports()
  try { got = await renderOf('Swapped folder') } finally { fsPromises.open = realOpen; syncBuiltinESMExports() }
  assert.equal(got, null, 'a manifest replaced between the check and the open is not read this time')
}
// through the search: slides whose presentation is odd are not offered, the rest are, nothing throws
sql(join(root, 'registry', 'slides.db'), `
  INSERT INTO slides VALUES ('h4', 'Literacy in a linked folder', 'literacy linked');
  INSERT INTO slides VALUES ('h5', 'Literacy behind an escaping render', 'literacy escaping');
  INSERT INTO slides VALUES ('h6', 'Literacy with separators', 'literacy separators');
  INSERT INTO slide_locations VALUES ('h4', 'Linked folder', 0, 'content'), ('h5', 'Escaping renders', 3, 'content'), ('h6', '../extracted/Nested', 0, 'content');
  INSERT INTO slides_fts(rowid, title, text_content) SELECT rowid, title, text_content FROM slides WHERE content_hash IN ('h4', 'h5', 'h6');
`)
assert.deepEqual((await archive.slideHits('literacy')).map((x) => x.key), ['old-slide:h1'], 'odd presentations are not offered; the sound one still is')

// --- every old-slide read has a deadline (fix round 1, defect 3)
// The fake sqlite3 logs what it is asked and can be made slow: a lock held by the archive's owner looks like this.
const fakeDir = dir('fake-bin')
const sqlLog = join(fakeDir, 'calls.log')
const fakeSqlite = (name, delay) => {
  const path = join(fakeDir, name)
  writeFileSync(path, `#!/bin/sh\nin=$(cat)\nprintf '%s\\n--call--\\n' "$in" >> ${JSON.stringify(sqlLog)}\n${delay ? `sleep ${delay}\n` : ''}printf '%s\\n' "$in" | exec ${JSON.stringify(sqlite3)} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}
const logging = createArchiveProvider({ archiveRoot: () => root, sqlite3: () => fakeSqlite('logging-sqlite3', 0), readLimits: ROOMY })
assert.deepEqual((await logging.slideHits('literacy')).map((x) => x.key), ['old-slide:h1'])
const calls = readFileSync(sqlLog, 'utf8').split('--call--').map((c) => c.trim()).filter(Boolean)
assert.ok(calls.length >= 2, 'the slide index and the picture index were both read')
assert.ok(calls.length <= 3, `a search is a fixed, small number of reads, not one per slide (${calls.length})`)
for (const call of calls) assert.ok(/^\.timeout 2000\n/.test(call), 'every old-slide read sets how long it waits for a lock: ' + call.slice(0, 60))
// the app's own limits are the SlideWell read limits
const { ARCHIVE_READ_LIMITS } = await import('../src/main/image-search/archive-provider.ts')
assert.ok(ARCHIVE_READ_LIMITS.busyMs <= 250 && ARCHIVE_READ_LIMITS.limitMs <= 500, 'a read waits 250 ms for a lock and is killed at 500 ms')
assert.ok(ARCHIVE_READ_LIMITS.searchMs <= 2000, 'the whole old-slide search is bounded well inside the owner’s 5 s write timeout')
// a read that takes 3 s: with the app's limits the search gives up and returns no old slides
const slowProvider = createArchiveProvider({ archiveRoot: () => root, sqlite3: () => fakeSqlite('slow-sqlite3', 3) })
let started = Date.now()
assert.deepEqual(await slowProvider.slideHits('literacy'), [], 'a read past its deadline returns no old slides')
assert.ok(Date.now() - started < 1500, `and returns promptly (${Date.now() - started} ms)`)
// the first read answers but the whole search runs out of time: still no old slides, still prompt
const tight = createArchiveProvider({ archiveRoot: () => root, sqlite3: () => fakeSqlite('half-slow-sqlite3', 0.3), readLimits: { busyMs: 250, limitMs: 5000, searchMs: 450, manifestMs: 250 } })
started = Date.now()
assert.deepEqual(await tight.slideHits('literacy'), [], 'the whole search has its own limit')
assert.ok(Date.now() - started < 1500, `the whole search stops at its limit (${Date.now() - started} ms)`)
// and the one search still answers with the pictures when the old slides ran out of time
const slowSearch = createImageSearch({ slidewell: null, archive: { ...archive, slideHits: slowProvider.slideHits } })
const slowRes = await slowSearch.search('diagram')
assert.ok(slowRes && slowRes.hits.length === 1 && slowRes.hits[0].source === 'archive-image', 'pictures still come back when old slides time out')
console.log('old slide provider: ok')
