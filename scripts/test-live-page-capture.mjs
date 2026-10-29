// Saved views of a live web page (the capture gallery): the records' rules
// (compiler/scripts/lib/live-page-captures.mjs), the writer in the talk folder
// (src/main/live-page-capture-core.ts), main's checks and queue (src/main/live-page-capture.ts), the
// writer's own process started in the talk folder, and the compiler carrying the public fields only.
// Plain Node, a scratch vault under research/, no Electron, no browser.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LIVE_PAGE_CAPTURES_DIR, MAX_CAPTURE_ENTRY_BYTES, MAX_CAPTURE_URL_LENGTH, MAX_CAPTURES_PER_PAGE, MAX_CAPTURES_TOTAL, captureEntryName, captureImagePath,
  encodeCaptureEntry, galleryFromEntries, normaliseCaptureUrl, parseCaptureEntry, publicCapturesFor
} from '../compiler/scripts/lib/live-page-captures.mjs'
import { writeCaptureInWorkingFolder } from '../src/main/live-page-capture-core.ts'
import { createLivePageCaptureRunner, createLivePageCaptureSaver, encodeCapture, livePageCaptureJob, placeSavedView } from '../src/main/live-page-capture.ts'
import { loadOutlineTools } from '../src/main/instant-slide-insert.ts'

const repo = fileURLToPath(new URL('..', import.meta.url))
let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
fs.mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const scratch = fs.mkdtempSync(join(repo, 'research/scratch-live-page-capture-'))
const home = process.cwd()
const PAGE = 'https://example.org/'
const sha = (b) => createHash('sha256').update(b).digest('hex')
const jpeg = (n) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, n + 1, n + 2])
let ids = 0
const capture = (over = {}) => ({
  id: `cap-${(++ids).toString(16).padStart(12, '0')}`, capturedAt: '2026-10-27T10:00:00.000Z', currentUrl: `${PAGE}episodes?id=7`, slideId: 'page',
  width: 1280, height: 720, source: 'audience', viewport: { w: 1280, h: 720, zoom: 1 }, scroll: { fx: 0, fy: 0.25 }, ...over
})

/** A talk in a vault; returns the paths and a job maker (the writer runs with the talk folder as cwd). */
function talk(name) {
  const root = join(scratch, name)
  const dir = join(root, 'talks', 'radio')
  fs.mkdirSync(dir, { recursive: true })
  const outlinePath = join(dir, 'radio-outline.md')
  fs.writeFileSync(outlinePath, '### Radio Times\n\n[Embed: https://example.org]\n')
  const real = (p) => fs.realpathSync.native(p)
  const job = (over = {}) => {
    const st = fs.statSync(outlinePath)
    return { realRoot: real(root), realTalkPath: real(dir), outlineName: 'radio-outline.md', outline: { dev: st.dev, ino: st.ino }, pageUrl: PAGE, capture: capture(), jpeg: jpeg(1), ...over }
  }
  const run = (j, fsImpl) => { process.chdir(dir); try { return writeCaptureInWorkingFolder(j, fsImpl) } finally { process.chdir(home) } }
  const folder = join(dir, LIVE_PAGE_CAPTURES_DIR)
  // The gallery as every reader sees it: the saved views' own records, in order.
  const views = () => {
    const names = fs.existsSync(folder) ? fs.readdirSync(folder).filter((n) => n.endsWith('.json')).sort() : []
    return galleryFromEntries(names.map((name) => { const e = parseCaptureEntry(fs.readFileSync(join(folder, name), 'utf8'), name); return e && { ...e, name } }))
  }
  return { root, dir, outlinePath, folder, job, run, views, page: () => views().pages[PAGE] ?? [] }
}

console.log('live page capture')

await test('record rules: one record per view, strict shape, fixed picture paths, addresses not paths, the readers\' limits, public fields', () => {
  assert.equal(captureImagePath('a'.repeat(64)), 'assets/live-page-captures/aaaaaaaaaaaaaaaa.jpg')
  assert.throws(() => captureImagePath('../x'))
  assert.equal(normaliseCaptureUrl('https://example.org'), PAGE)
  for (const bad of ['file:///etc/passwd', 'javascript:1', 'https://u:p@x.org/', '', 'x'.repeat(3000)]) assert.equal(normaliseCaptureUrl(bad), null, bad.slice(0, 40))
  const one = { ...capture(), image: captureImagePath('b'.repeat(64)), bytes: 7 }
  const name = captureEntryName(one)
  assert.match(name, /^20261027T100000000Z-cap-[0-9a-f]{12}\.json$/)
  const text = encodeCaptureEntry(PAGE, one)
  assert.deepEqual(parseCaptureEntry(text, name).capture, one)
  assert.equal(parseCaptureEntry(text, name.replace('cap-', 'cap-f')), null, 'a record under another name is not that view')
  for (const image of ['assets/../x.jpg', '/etc/passwd', 'assets/live-page-captures/bbbbbbbbbbbbbbbb.png', 'assets/live-page-captures/BBBBBBBBBBBBBBBB.jpg', '../assets/live-page-captures/bbbbbbbbbbbbbbbb.jpg', 'assets/live-page-bbbbbbbbbbbbbbbb.jpg']) {
    assert.throws(() => encodeCaptureEntry(PAGE, { ...one, image }), /capture-invalid/, image)
    assert.equal(parseCaptureEntry(text.replace(one.image, image), name), null, image)
  }
  assert.equal(parseCaptureEntry(text.replace('"v":1', '"v":1,"x":1'), name), null, 'unknown keys refuse')
  assert.equal(parseCaptureEntry(text.replace('"slideId"', '"note":"<script>","slideId"'), name).capture.note, undefined, 'unknown capture fields never survive')
  assert.equal(parseCaptureEntry(text.replace(one.capturedAt, '"><img onerror=1>'), name), null)
  assert.equal(parseCaptureEntry('{', name), null)
  assert.equal(parseCaptureEntry(text.replace(PAGE, 'file:///etc/'), name), null, 'a key that is not a web address')
  // Size: whatever encodes is within the readers' limit and reads back; larger is refused, never written.
  const longest = `${PAGE}?${'q'.repeat(MAX_CAPTURE_URL_LENGTH - PAGE.length - 1)}`
  assert.equal(normaliseCaptureUrl(longest), longest)
  assert.throws(() => encodeCaptureEntry(longest, { ...one, currentUrl: longest, slideId: 'x'.repeat(128) }), /capture-too-large/)
  const { currentUrl: _gone, ...noCurrent } = one
  const big = encodeCaptureEntry(longest, { ...noCurrent, slideId: 'x'.repeat(128) })
  assert.ok(Buffer.byteLength(big) <= MAX_CAPTURE_ENTRY_BYTES && parseCaptureEntry(big, name), 'the largest record a page address allows fits')
  assert.equal(parseCaptureEntry(`${big}${' '.repeat(MAX_CAPTURE_ENTRY_BYTES)}`, name), null, 'a reader takes nothing above the limit')
  // Gallery: name order; at most MAX_CAPTURES_PER_PAGE per page and MAX_CAPTURES_TOTAL in all; ids once.
  const entry = (n, page = PAGE) => { const c = { ...one, id: `cap-${n.toString(16).padStart(12, '0')}` }; return { pageUrl: page, capture: c, name: captureEntryName(c) } }
  const many = Array.from({ length: MAX_CAPTURES_PER_PAGE + 3 }, (_, n) => entry(n + 1)).reverse()
  const g = galleryFromEntries([...many, entry(1)])
  assert.equal(g.pages[PAGE].length, MAX_CAPTURES_PER_PAGE)
  assert.equal(g.pages[PAGE][0].id, 'cap-000000000001', 'in name order')
  const pages = Array.from({ length: MAX_CAPTURES_TOTAL + 5 }, (_, n) => entry(n + 1, `https://site${Math.floor(n / 50)}.example/`))
  assert.equal(galleryFromEntries(pages).total, MAX_CAPTURES_TOTAL)
  assert.deepEqual(publicCapturesFor(galleryFromEntries([entry(1)]), 'https://example.org'), [{ image: one.image, capturedAt: '2026-10-27T10:00:00.000Z' }])
})

await test('writer: picture and record written in the held folder; the same bytes reused, never replaced; outline untouched', () => {
  const t = talk('plain')
  const first = t.run(t.job())
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.how, 'written')
  assert.match(first.image, /^assets\/live-page-captures\/[0-9a-f]{16}\.jpg$/)
  assert.deepEqual(new Uint8Array(fs.readFileSync(join(t.dir, first.image))), jpeg(1))
  const second = t.run(t.job({ jpeg: jpeg(9), capture: capture({ capturedAt: '2026-10-27T10:00:01.000Z' }) }))
  assert.equal(second.ok, true)
  assert.equal(second.count, 2)
  const again = t.run(t.job({ jpeg: jpeg(1), capture: capture({ capturedAt: '2026-10-27T10:00:02.000Z' }) }))
  assert.equal(again.how, 'reused')
  assert.deepEqual(t.page().map((c) => c.image), [first.image, second.image, first.image])
  assert.equal(fs.readFileSync(t.outlinePath, 'utf8'), '### Radio Times\n\n[Embed: https://example.org]\n', 'the outline is never touched')
  assert.deepEqual(fs.readdirSync(join(t.dir, 'assets')), ['live-page-captures'], 'nothing else in assets')
  assert.equal(fs.readdirSync(t.folder).length, 5, 'two pictures, three records, no temporary file')
  assert.equal(process.cwd(), home, 'the working directory is given back')
})

await test('writer: links refused (assets folder, saved-view folder, picture or record name); nothing written outside the talk', () => {
  const outside = join(scratch, 'outside'); fs.mkdirSync(outside, { recursive: true })
  const a = talk('assets-link')
  fs.symlinkSync(outside, join(a.dir, 'assets'))
  const r1 = a.run(a.job())
  assert.equal(r1.ok, false); assert.equal(r1.reason, 'outside-vault')
  const b = talk('folder-link')
  fs.mkdirSync(join(b.dir, 'assets'))
  fs.symlinkSync(outside, b.folder)
  const r2 = b.run(b.job())
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'outside-vault')
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through a linked folder')
  const c = talk('picture-link')
  fs.mkdirSync(c.folder, { recursive: true })
  const target = join(outside, 'picture.jpg'); fs.writeFileSync(target, 'theirs')
  fs.symlinkSync(target, join(c.dir, captureImagePath(sha(jpeg(1)))))
  const r3 = c.run(c.job())
  assert.equal(r3.ok, false)
  assert.equal(fs.readFileSync(target, 'utf8'), 'theirs', 'a link in the picture\'s place is never followed or replaced')
  const d = talk('record-link')
  fs.mkdirSync(d.folder, { recursive: true })
  const j = d.job()
  const elsewhere = join(outside, 'theirs.json'); fs.writeFileSync(elsewhere, '{"mine":true}')
  fs.symlinkSync(elsewhere, join(d.folder, captureEntryName(j.capture)))
  const r4 = d.run(j)
  assert.equal(r4.ok, false)
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), '{"mine":true}', 'the linked file is untouched')
})

await test('writer (review P1): assets swapped for a link before or after the folder is held — nothing outside is written or replaced', () => {
  // The reviewer's reproduction (probe-independent-capture-write-authority.mjs): `assets` renamed aside
  // and replaced by a link to a folder outside, at the moment of the write; the old writer renamed its
  // record through the link and overwrote the outside file. Now nothing is opened by a path through `assets`.
  const outside = join(scratch, 'outside-p1'); fs.mkdirSync(join(outside, 'live-page-captures'), { recursive: true })
  const victim = join(outside, 'live-page-captures', captureImagePath(sha(jpeg(1))).split('/').pop())
  fs.writeFileSync(victim, 'outside victim')
  const swap = (dir) => { fs.renameSync(join(dir, 'assets'), join(dir, 'held-assets')); fs.symlinkSync(outside, join(dir, 'assets')) }
  // (a) between the folder check and entering it.
  const a = talk('p1-before')
  let swapped = false
  const before = { ...fs, chdir(p) { if (p === 'assets' && !swapped) { swapped = true; swap(a.dir) } process.chdir(p) }, cwd: () => process.cwd() }
  fs.mkdirSync(a.folder, { recursive: true })
  const ra = a.run(a.job(), before)
  assert.equal(swapped, true)
  assert.equal(ra.ok, false); assert.equal(ra.reason, 'outside-vault')
  // (b) once the folder is held, at the picture's exclusive create.
  const b = talk('p1-after')
  let late = false
  const after = { ...fs, openSync(p, flags, mode) { if (!late && String(p).endsWith('.jpg') && (flags & fs.constants.O_CREAT)) { late = true; swap(b.dir) } return fs.openSync(p, flags, mode) } }
  const rb = b.run(b.job(), after)
  assert.equal(late, true)
  assert.equal(rb.ok, false); assert.equal(rb.reason, 'moved', 'the held folder is no longer at its place: refused after the create')
  assert.equal(fs.readFileSync(victim, 'utf8'), 'outside victim', 'the outside file is untouched')
  assert.deepEqual(fs.readdirSync(join(outside, 'live-page-captures')), [victim.split('/').pop()], 'nothing created outside')
  assert.deepEqual(fs.readdirSync(join(b.dir, 'held-assets', 'live-page-captures')), [victim.split('/').pop()], 'the picture went into the held folder inside the talk')
  assert.equal(process.cwd(), home)
})

await test('writer (review P2): another writer saving at the same moment — both views kept, neither replaced', () => {
  // The reviewer's reproduction: a concurrent edit to the shared list was silently replaced by the
  // old writer's rename. Now each view is its own new file; a writer running entirely inside another's
  // write adds its view, and the first adds its own.
  const t = talk('concurrent')
  assert.equal(t.run(t.job()).ok, true)
  let inner = null
  const racing = {
    ...fs,
    fsyncSync(fd) {
      fs.fsyncSync(fd)
      if (inner) return
      // The other writer is its own process in the talk folder (here: the same process, its own cwd).
      const ours = process.cwd()
      process.chdir(t.dir)
      try { inner = writeCaptureInWorkingFolder(t.job({ jpeg: jpeg(7), capture: capture({ capturedAt: '2026-10-27T10:00:03.000Z' }) })) } finally { process.chdir(ours) }
    }
  }
  const outer = t.run(t.job({ jpeg: jpeg(5), capture: capture({ capturedAt: '2026-10-27T10:00:04.000Z' }) }), racing)
  assert.equal(inner.ok, true, JSON.stringify(inner))
  assert.equal(outer.ok, true, JSON.stringify(outer))
  assert.equal(t.page().length, 3, 'all three views kept')
  // Someone else's file in the folder (a sync copy, a hand edit) is read, never replaced or removed.
  const theirs = join(t.folder, '20261027T100005000Z-cap-ffffffffffff.json'); fs.writeFileSync(theirs, 'not a record')
  assert.equal(t.run(t.job({ capture: capture({ capturedAt: '2026-10-27T10:00:06.000Z' }) })).ok, true)
  assert.equal(fs.readFileSync(theirs, 'utf8'), 'not a record')
  assert.equal(t.page().length, 4)
})

await test('writer failure cleanup never deletes a pathname', () => {
  const t = talk('failure-no-unlink')
  let recordFd = null
  let unlinks = 0
  const failing = {
    ...fs,
    openSync(p, flags, mode) {
      const fd = fs.openSync(p, flags, mode)
      if (String(p).endsWith('.json') && (flags & fs.constants.O_CREAT)) recordFd = fd
      return fd
    },
    fsyncSync(fd) {
      if (fd === recordFd) throw Object.assign(new Error('injected record fsync failure'), { code: 'EIO' })
      fs.fsyncSync(fd)
    },
    unlinkSync(p) { unlinks++; return fs.unlinkSync(p) }
  }
  const result = t.run(t.job(), failing)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'write-failed')
  assert.equal(unlinks, 0, 'cleanup must only empty its descriptor, never delete a replaceable pathname')
  const records = fs.readdirSync(t.folder).filter((n) => n.endsWith('.json'))
  assert.equal(records.length, 1)
  assert.equal(fs.statSync(join(t.folder, records[0])).size, 0)
  assert.equal(t.page().length, 0, 'readers skip the empty record')
})

await test('writer (review P2 size): every record the writer makes is one the readers take; a full page refuses before writing', async () => {
  // The reviewer's reproduction: a compact record of 1.3 MB was rewritten pretty-printed at 2.1 MB,
  // above the readers' 2 MB, and the whole gallery became unreadable. Now each record is checked
  // against the readers' own limit before it is written; the address the page had reached is dropped
  // when the record would be too large with it; the count limit is the readers' too.
  const t = talk('size')
  const longest = `${PAGE}?${'q'.repeat(MAX_CAPTURE_URL_LENGTH - PAGE.length - 1)}`
  const r = t.run(t.job({ pageUrl: longest, capture: capture({ currentUrl: longest, slideId: 'x'.repeat(128) }) }))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.capture.currentUrl, undefined, 'the private address is dropped, the view is kept')
  for (let i = 1; i < MAX_CAPTURES_PER_PAGE; i++) {
    const ok = t.run(t.job({ capture: capture({ capturedAt: `2026-10-27T11:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` }) }))
    assert.equal(ok.ok, true, `${i} ${JSON.stringify(ok)}`)
  }
  const files = fs.readdirSync(t.folder).filter((n) => n.endsWith('.json'))
  assert.ok(files.every((n) => fs.statSync(join(t.folder, n)).size <= MAX_CAPTURE_ENTRY_BYTES), 'every record within the readers\' limit')
  assert.equal(t.page().length, MAX_CAPTURES_PER_PAGE - 1)
  assert.equal(t.views().pages[longest].length, 1, 'the largest record is read back')
  const before = fs.readdirSync(t.folder).length
  const extra = t.run(t.job({ capture: capture({ capturedAt: '2026-10-27T12:00:00.000Z' }) }))
  assert.equal(extra.ok, true, 'the page\'s last place')
  const full = t.run(t.job({ jpeg: jpeg(3), capture: capture({ capturedAt: '2026-10-27T12:00:01.000Z' }) }))
  assert.equal(full.ok, false); assert.equal(full.reason, 'full')
  assert.equal(fs.readdirSync(t.folder).length, before + 1, 'a refused view writes nothing (not even its picture)')
  // The compiler reads all of them.
  const { prepareSource } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
  const outline = '---\ntitle: Radio\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Radio Times {id=page}\n\n[Embed: https://example.org]\n'
  fs.writeFileSync(t.outlinePath, outline)
  const model = await prepareSource(t.outlinePath, outline, null, fs.statSync(t.outlinePath), {}, {})
  assert.equal((model.fullHtml.match(/<figure class="embed-saved-view/g) || []).length, MAX_CAPTURES_PER_PAGE, 'the gallery is readable at its limit')
  assert.ok(!model.warnings.some((w) => String(w).startsWith('live-page-captures-unreadable')), model.warnings.join('\n'))
})

await test('writer: a record out of shape or a different file under the picture\'s name is left as it is', () => {
  const t = talk('foreign')
  fs.mkdirSync(t.folder, { recursive: true })
  const bad = join(t.folder, '20261027T090000000Z-cap-aaaaaaaaaaaa.json')
  fs.writeFileSync(bad, '{"v":1,"pageUrl":"https://example.org/","capture":{"image":"../../secret"}}')
  const r = t.run(t.job())
  assert.equal(r.ok, true, 'a record out of shape is skipped, not repaired and not a reason to refuse')
  assert.match(fs.readFileSync(bad, 'utf8'), /secret/, 'unchanged')
  assert.equal(t.page().length, 1)
  const u = talk('taken')
  fs.mkdirSync(u.folder, { recursive: true })
  fs.writeFileSync(join(u.dir, captureImagePath(sha(jpeg(1)))), 'a user file')
  const r2 = u.run(u.job())
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'taken')
  assert.equal(fs.readFileSync(join(u.dir, captureImagePath(sha(jpeg(1)))), 'utf8'), 'a user file')
  assert.deepEqual(fs.readdirSync(u.folder), [captureImagePath(sha(jpeg(1))).split('/').pop()], 'no record')
})

await test('writer: the talk folder must be the one main named (moved or replaced outline refuses); not a JPEG refuses; other systems refuse', () => {
  const t = talk('moved')
  const j = t.job()
  fs.renameSync(t.outlinePath, `${t.outlinePath}.old`); fs.writeFileSync(t.outlinePath, 'another file')
  const r = t.run(j)
  assert.equal(r.ok, false); assert.equal(r.reason, 'moved')
  assert.equal(fs.existsSync(join(t.dir, 'assets')), false, 'nothing created')
  const u = talk('not-jpeg')
  const r2 = u.run(u.job({ jpeg: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }))
  assert.equal(r2.reason, 'not-a-picture')
  const w = talk('elsewhere')
  process.chdir(w.dir)
  try { assert.equal(writeCaptureInWorkingFolder(w.job(), fs, false).reason, 'unsupported') } finally { process.chdir(home) }
  assert.equal(fs.existsSync(join(w.dir, 'assets')), false, 'fails closed: nothing created')
})

await test('main: the talk comes from main\'s record of the window; outside the vault refused; one capture at a time', async () => {
  const t = talk('main')
  const request = { pageUrl: 'https://example.org', currentUrl: 'file:///etc/passwd', slideId: '../../x', source: 'audience', jpeg: jpeg(1), width: 1280, height: 720, viewport: { w: 1280, h: 720, zoom: 1 }, scroll: { fx: 0, fy: 0 } }
  const ok = livePageCaptureJob({ root: t.root, outlinePath: t.outlinePath }, request, new Date('2026-10-27T10:00:00Z'))
  assert.equal(ok.ok, true)
  assert.equal(ok.job.capture.currentUrl, undefined, 'a non-web current address is dropped')
  assert.equal(ok.job.capture.slideId, '', 'a slide id out of shape is dropped')
  assert.equal(ok.job.realTalkPath, fs.realpathSync.native(t.dir))
  const other = talk('other')
  assert.equal(livePageCaptureJob({ root: t.root, outlinePath: other.outlinePath }, request, new Date()).ok, false, 'a talk outside the vault')
  assert.equal(livePageCaptureJob({ root: t.root, outlinePath: join(t.dir, 'notes.md') }, request, new Date()).ok, false, 'not an outline')
  let running = 0; let most = 0
  const save = createLivePageCaptureSaver({
    talkOf: (deckId) => (deckId === 1 ? { root: t.root, outlinePath: t.outlinePath } : null),
    run: async (job) => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 5)); running--; return { ok: true, image: 'assets/live-page-0000000000000000.jpg', how: 'written', capture: { ...job.capture, image: 'x', bytes: 1 }, count: 1 } }
  })
  const answers = await Promise.all([save(1, request), save(1, request), save(2, request), save(1, { ...request, isCurrent: () => false })])
  assert.equal(most, 1, 'serialised')
  assert.deepEqual(answers.map((a) => a.ok), [true, true, false, false], 'a window main did not open for a talk saves nothing; a press no longer current is not written')
  assert.match(answers[3].message, /changed while capturing/)
})

await test('main: a Capture embed window saves only its own slide\'s page; a saved view is then placed on the slide (or says why not)', async () => {
  const t = talk('bound')
  const request = { pageUrl: 'https://example.org', slideId: 'page', source: 'window', jpeg: jpeg(1), width: 1280, height: 720, viewport: { w: 1280, h: 720, zoom: 1 }, scroll: { fx: 0, fy: 0 }, mode: 'page' }
  const ran = []; const placed = []; const stale = []
  let place = async (outlinePath, view) => { placed.push({ outlinePath, view }); return { ok: true, changed: true } }
  const save = createLivePageCaptureSaver({
    talkOf: () => ({ root: t.root, outlinePath: t.outlinePath, bound: { slideId: 'page', pageUrl: PAGE } }),
    run: async (job) => { ran.push(job); return { ok: true, image: 'assets/live-page-captures/00000000000000aa.jpg', how: 'written', capture: { ...job.capture, image: 'x', bytes: 1 }, count: ran.length, earlier: [] } },
    saved: (p) => stale.push(p),
    place: (...a) => place(...a)
  })
  for (const other of [{ ...request, slideId: 'other' }, { ...request, pageUrl: 'https://example.com/' }]) {
    const r = await save(1, other)
    assert.equal(r.ok, false); assert.match(r.message, /captures one slide/)
  }
  assert.equal(ran.length, 0, 'another slide or page: nothing written')
  const ok = await save(1, request)
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.deepEqual([ok.mode, ok.onSlide, ok.note, ok.image], ['page', true, undefined, 'assets/live-page-captures/00000000000000aa.jpg'])
  assert.equal(ran[0].capture.mode, 'page')
  assert.equal(ran[0].capture.slideMarkup, true, 'recorded as a view the slide\'s lines show (deleting its line is honoured)')
  assert.deepEqual(placed[0], { outlinePath: t.outlinePath, view: { slideId: 'page', pageUrl: PAGE, image: ok.image, capturedAt: ran[0].capture.capturedAt, mode: 'page', earlier: [] } })
  assert.equal(stale.length, 2, 'decks made stale after the record and again after the line')
  place = async () => ({ ok: false, message: 'Not added to the slide: the slide is no longer in the talk.' })
  const gone = await save(1, request)
  assert.deepEqual([gone.ok, gone.onSlide, gone.note], [true, false, 'Not added to the slide: the slide is no longer in the talk.'], 'still saved with the talk')
  place = async () => { throw new Error('boom') }
  const threw = await save(1, request)
  assert.deepEqual([threw.ok, threw.onSlide], [true, false]); assert.match(threw.note, /could not be added to the slide/)
  assert.equal(fs.readFileSync(t.outlinePath, 'utf8'), '### Radio Times\n\n[Embed: https://example.org]\n', 'the saver never writes the outline itself')
})

await test('placement (review P2): an identical heading inserted while the view is placed refuses; the view stays saved; never the wrong slide', async () => {
  // The reviewer's reproduction: main compiled the talk, then (before the edit applied) the user
  // inserted a slide with the same heading above; the old placement named "the 2nd such heading"
  // and so put the line on the inserted slide. Here the compile reads one text and the writer
  // applies the edit to the text as it is by then, as the open editor's route does.
  const tools = await loadOutlineTools(join(repo, 'compiler/scripts'))
  const SITE = 'https://example.org'
  const head = '---\ntitle: Race\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n'
  const original = `${head}### Before\n\n- b\n\n### Radio\n\n[Embed: ${SITE}]\n\n### After\n\n- a\n`
  const inserted = original.replace('### Before', `### Radio\n\n[Embed: ${SITE}]\n\n### Before`)
  const path = join(scratch, 'race-outline.md'); fs.writeFileSync(path, original)
  const view = { slideId: 'radio', pageUrl: PAGE, image: 'assets/live-page-captures/00000000000000aa.jpg', capturedAt: '2026-10-27T11:05:00.000Z', mode: 'view', earlier: [] }
  const deps = (now) => {
    const written = []
    return {
      written,
      read: async () => original,
      compiledSlides: (p, text) => tools.compiledSlides(p, text),
      write: async (_p, next) => { const before = now(); try { const after = next(before); written.push(after); return { ok: true, changed: after !== before } } catch (e) { return { ok: false, error: String(e) } } }
    }
  }
  const raced = deps(() => inserted)
  const r = await placeSavedView(raced, path, view)
  assert.equal(r.ok, false)
  assert.match(r.message, /saved with the talk \(in assets\/live-page-captures\) but not added to the slide: more than one slide has this title/)
  assert.deepEqual(raced.written, [inserted], 'the edit applied changes nothing')
  // No race: the line goes under that slide's page.
  const calm = deps(() => original)
  assert.deepEqual(await placeSavedView(calm, path, view), { ok: true, changed: true })
  assert.equal(calm.written[0], original.replace(`[Embed: ${SITE}]\n`, `[Embed: ${SITE}]\n<!-- saved views {capture} -->\n![Saved view, 27 Oct 2026 11:05](${view.image}){capture}\n`))
  // Typing elsewhere meanwhile: kept, the line still under the one Radio slide.
  const typed = original.replace('- b', '- b typed')
  const typing = deps(() => typed)
  assert.deepEqual(await placeSavedView(typing, path, view), { ok: true, changed: true })
  assert.match(typing.written[0], /- b typed[\s\S]*### Radio\n\n\[Embed: [^\]]+\]\n<!-- saved views \{capture\} -->\n!\[Saved view[^\n]*\{capture\}\n\n### After/)
  // A slide with its own id: found by the id, whatever is inserted around it.
  const withId = original.replace('### Radio', '### Radio {id=radio}')
  const idRace = deps(() => withId.replace('### Before', `### Radio\n\n[Embed: ${SITE}]\n\n### Before`))
  assert.deepEqual(await placeSavedView({ ...idRace, read: async () => withId }, path, view), { ok: true, changed: true })
  assert.match(idRace.written[0], /### Radio \{id=radio\}\n\n\[Embed: [^\]]+\]\n<!-- saved views \{capture\} -->\n!\[Saved view/)
  assert.equal((idRace.written[0].match(/\)\{capture\}/g) ?? []).length, 1)
  // Two Radio slides already when compiled: refused, never "the first one".
  const both = deps(() => inserted)
  const r2 = await placeSavedView({ ...both, read: async () => inserted }, path, { ...view, slideId: 'radio-2' })
  assert.equal(r2.ok, false); assert.match(r2.message, /more than one slide has this title/)
  assert.ok(!both.written.some((t) => /\{capture\}/.test(t)), 'nothing placed, no marker')
  // The writer refuses: said, nothing claimed.
  const refused = await placeSavedView({ ...deps(() => original), write: async () => ({ ok: false, error: 'locked' }) }, path, view)
  assert.deepEqual(refused, { ok: false, message: 'It is saved with the talk (in assets/live-page-captures) but not added to the slide: the talk could not be changed just now.' })
})

await test('placement (re-review P2/P3): a save whose placement fails changes nothing shown; the next one moves all older views into the slide; an ambiguous one leaves the text byte for byte', async () => {
  // The re-review's reproduction (probe-capture-corrections-independent-rereview.mjs): two views saved
  // before the markup; a third saved, its placement refused by the talk writer; a fourth saved and
  // placed. It counted 2, then 0 (the third's record hid the older views), then 1 (the fourth's save
  // found no earlier views). The outline is now the only authority for which embeds are in the markup.
  const { prepareSource } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
  const tools = await loadOutlineTools(join(repo, 'compiler/scripts'))
  const root = join(scratch, 'rereview'); const dir = join(root, 'talk'); fs.mkdirSync(dir, { recursive: true })
  const path = join(dir, 'probe-outline.md')
  const SITE = 'https://example.com/'
  const head = '---\ntitle: Probe\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Page {id=page}\n'
  const embed = `[Embed: ${SITE}]\n`
  let disk = head + embed
  fs.writeFileSync(path, disk)
  const saveView = (n, markup) => {
    const st = fs.statSync(path); const home = process.cwd(); process.chdir(dir)
    try {
      const r = writeCaptureInWorkingFolder({ realRoot: fs.realpathSync.native(root), realTalkPath: fs.realpathSync.native(dir), outlineName: 'probe-outline.md', outline: { dev: st.dev, ino: st.ino }, pageUrl: SITE,
        capture: { id: `cap-00000000000${n}`, capturedAt: `2026-10-27T10:0${n}:00.000Z`, slideId: 'page', width: 2, height: 2, source: 'window', viewport: { w: 2, h: 2, zoom: 1 }, scroll: { fx: 0, fy: 0 }, ...(markup ? { slideMarkup: true } : {}) },
        jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, n, n]) })
      assert.equal(r.ok, true, JSON.stringify(r)); return r
    } finally { process.chdir(home) }
  }
  const shown = async () => { fs.writeFileSync(path, disk); const m = await prepareSource(path, disk, null, fs.statSync(path), {}, {}); return [...m.fullHtml.matchAll(/<figure class="embed-saved-view/g)].length }
  const view = (r) => ({ slideId: 'page', pageUrl: SITE, image: r.image, capturedAt: r.capture.capturedAt, mode: 'view', earlier: r.earlier })
  const deps = (write) => ({ read: async () => disk, compiledSlides: (p, text) => tools.compiledSlides(p, text), write })
  const old = [saveView(1, false), saveView(2, false)]
  assert.equal(await shown(), 2)
  const third = saveView(3, true)
  const refused = await placeSavedView(deps(async () => ({ ok: false, error: 'buffer moved; retry exhausted' })), path, view(third))
  assert.equal(refused.ok, false)
  assert.equal(disk, head + embed, 'the outline untouched')
  assert.equal(await shown(), 2, 'still the two older views (the third, never placed, shows nowhere)')
  const fourth = saveView(4, true)
  assert.deepEqual(fourth.earlier.map((e) => e.image), old.map((r) => r.image), 'the next save still finds both older views')
  const placed = await placeSavedView(deps(async (_p, next) => { const before = disk; disk = next(disk); return { ok: true, changed: disk !== before } }), path, view(fourth))
  assert.deepEqual(placed, { ok: true, changed: true })
  assert.equal(await shown(), 3, 'all three now as lines: the two older views and the fourth')
  assert.ok(!disk.includes(third.image), 'the refused third stays in the talk folder only')
  // Then the 2 → 1 → 0 deletion holds: the marker stays when the lines go.
  disk = disk.split('\n').filter((l) => !/\{capture\}$/.test(l)).join('\n')
  assert.equal(await shown(), 0, 'every line deleted: none come back')
  assert.equal(fs.readdirSync(join(dir, 'assets/live-page-captures')).filter((n) => n.endsWith('.json')).length, 4, 'every record kept')
  // Ambiguous (two "### Page" slides, no id): refused, the text byte for byte, no older view migrated.
  const ambiguous = `### Page\n${embed}\n### Page\n${embed}`
  let written = null
  const amb = await placeSavedView({ read: async () => ambiguous, compiledSlides: (p, text) => tools.compiledSlides(p, text), write: async (_p, next) => { written = next(ambiguous); return { ok: true, changed: written !== ambiguous } } }, path, { ...view(fourth), slideId: 'page-2', earlier: old.map((r) => ({ image: r.image, capturedAt: r.capture.capturedAt })) })
  assert.equal(amb.ok, false); assert.match(amb.message, /more than one slide has this title/)
  assert.equal(written, ambiguous, 'byte for byte')
})

await test('the writer\'s own process: started in the talk folder, answers once, the answer checked', async () => {
  const t = talk('child')
  const { forkNodeCompileChild } = await import('./lib/node-compile-child.mjs')
  const run = createLivePageCaptureRunner(join(repo, 'src/main/live-page-capture-worker.ts'), (path, cwd) => forkNodeCompileChild(path, { cwd }))
  const answer = await run(t.job())
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.ok(fs.existsSync(join(t.dir, answer.image)))
  assert.equal(t.page().length, 1)
})

await test('encode: empty pictures refused; wide pictures scaled to 1920', () => {
  assert.equal(encodeCapture(null), null)
  assert.equal(encodeCapture({ isEmpty: () => true }), null)
  const img = (w, h) => ({ isEmpty: () => false, getSize: () => ({ width: w, height: h }), resize: ({ width }) => img(width, Math.round(h * width / w)), toJPEG: () => jpeg(1) })
  assert.deepEqual(encodeCapture(img(3840, 2160)).width, 1920)
  assert.deepEqual(encodeCapture(img(1280, 720)).height, 720)
})

await test('compiler: saved views carried as pictures with their date only; a bad record shows none; the frame stays', async () => {
  const { prepareSource } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
  const t = talk('compile')
  assert.equal(t.run(t.job()).ok, true)
  const outline = '---\ntitle: Radio\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Radio Times {id=page}\n\n[Embed: https://example.org]\n'
  fs.writeFileSync(t.outlinePath, outline)
  const model = await prepareSource(t.outlinePath, outline, null, fs.statSync(t.outlinePath), {}, {})
  const html = model.fullHtml
  assert.match(html, /class="slide-embed has-saved-views/)
  assert.match(html, /<img src="data:image\/jpeg;base64,/)
  assert.match(html, /Saved view, captured 27 Oct 2026/)
  assert.match(html, /data-embed-url="https:\/\/example\.org\/?"/, 'the frame and its address stay')
  assert.doesNotMatch(html, /episodes\?id=7/, 'the address the page had reached stays private')
  assert.doesNotMatch(html, /live-page-captures\/|[0-9a-f]{16}\.jpg|cap-[0-9a-f]{12}/, 'no file path or record name in the output')
  for (const n of fs.readdirSync(t.folder)) if (n.endsWith('.json')) fs.writeFileSync(join(t.folder, n), fs.readFileSync(join(t.folder, n), 'utf8').replace(/assets\/live-page-captures\/[0-9a-f]{16}\.jpg/, 'assets/../../../etc/hosts'))
  const bad = await prepareSource(t.outlinePath, outline, null, fs.statSync(t.outlinePath), {}, {})
  assert.doesNotMatch(bad.fullHtml, /class="slide-embed has-saved-views/)
  assert.ok(bad.warnings.some((w) => String(w).startsWith('live-page-captures-unreadable')), bad.warnings.join('\n'))
})

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`live page capture: ${passed} passed`)
