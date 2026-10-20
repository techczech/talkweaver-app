// Work-files ticket 14: the pin writer and reader (src/main/run-work-pin.ts), against a temp vault.
//   1. first pin: the copy sits in the Run's own folder, its sha256 matches its bytes (node:crypto) and
//      it reads with the 02 reader; the Run records id, title, revision, sha256 and the copy path;
//   2. publishing again (after an unpublish) reuses the same pin, writing nothing;
//   3. a later edit to the work file leaves the pin's hash and the copy unchanged; the next Run of
//      another talk pins the edited file;
//   4. a hostile copy path on the Run record is refused (pin and read), never followed;
//   5. a symlinked Run folder is refused and the Run record is left unchanged; a talk folder linked to
//      another folder INSIDE the vault is accepted (its Run folder is checked against its real path);
//      one linked outside the vault is refused;
//   6. a file that is not ready, not UTF-8, or names another id is refused and writes nothing;
//   7. "Runs already sent" from the records;
//   8. (ticket 14 review) a talk slug with `:` or a leading `~` pins; an unpinned copy whose bytes differ
//      is never overwritten; a work file that links to a FIFO or a device is refused before it is read.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-run-work-pin.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createPlannedRun, persistRunForTalk, readRunForTalk, updatePlannedRun } from '../src/main/runs.ts'
import { pinRunWork, readPinnedWork } from '../src/main/run-work-pin.ts'
import { readWorkFile } from '../src/shared/work-file.ts'
import { safeCopyPath, sentRunsForWorkFile } from '../src/shared/run-work.ts'
import { isSafeTalkSlug } from '../src/main/runs.ts'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const workFile = (revision, extra = '') => [
  '---', 'id: intake', 'title: Research teams intake', `revision: ${revision}`, '---',
  'Two short steps before we meet.', '',
  '### What do you most want from the session?', '{id=what-you-want}{poll=open}',
  '### Try one prompt', `{id=try}{task}{minutes=20}`, extra, ''
].join('\n')
const at = (iso) => () => new Date(iso)

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function vault(talks = ['work-talk']) {
  const root = mkdtempSync(join(tmpdir(), 'talkweaver-pin-'))
  mkdirSync(join(root, 'Work files'), { recursive: true })
  writeFileSync(join(root, 'Work files', 'intake.md'), workFile(3))
  const base = { timeZone: 'Europe/London', talkTitle: 'Work talk', plannedDate: '2026-10-06', startTime: '10:00', eventTitle: 'Briefing', audience: '', slideSet: { kind: 'full' } }
  for (const talkSlug of talks) {
    createPlannedRun(root, { ...base, talkSlug, work: { pre: { fileId: 'intake', opens: '2026-09-22T09:00' }, post: { fileId: 'intake', closes: '2026-10-20T18:00' } } }, () => 'r1')
  }
  return root
}
const runFile = (root, talk = 'work-talk') => join(root, '_PRESENTATIONS', talk, 'r1.json')

check('first pin: copy in the Run folder, hash of its bytes, reads with the 02 reader, recorded on the Run', () => {
  const root = vault()
  const result = pinRunWork(root, 'work-talk', 'r1', 'pre', at('2026-09-23T10:00:00Z'))
  assert.equal(result.created, true)
  const copy = join(root, '_PRESENTATIONS', 'work-talk', 'r1', 'work-pre.md')
  const bytes = readFileSync(copy)
  assert.deepEqual(bytes, readFileSync(join(root, 'Work files', 'intake.md')), 'the copy is the file\'s bytes')
  assert.deepEqual(result.pinned, {
    fileId: 'intake', title: 'Research teams intake', revision: 3, sha256: sha(bytes),
    copy: '_PRESENTATIONS/work-talk/r1/work-pre.md', pinnedAt: '2026-09-23T10:00:00.000Z'
  })
  const reading = readWorkFile(bytes.toString('utf8'))
  assert.equal(reading.ok, true)
  assert.equal(reading.hash, result.pinned.sha256)
  assert.deepEqual(readRunForTalk(root, 'work-talk', 'r1').work.pre.pinned, result.pinned, 'the Run file records the pin')
  assert.equal('pinned' in readRunForTalk(root, 'work-talk', 'r1').work.post, false, 'the other phase is not pinned')
  const read = readPinnedWork(root, 'work-talk', 'r1', 'pre')
  assert.equal(read.text, bytes.toString('utf8'))
  assert.equal(read.reading.definition.steps.length, 2)
  // Post-work pins its own copy beside it.
  assert.equal(pinRunWork(root, 'work-talk', 'r1', 'post').pinned.copy, '_PRESENTATIONS/work-talk/r1/work-post.md')
  assert.deepEqual(readdirSync(join(root, '_PRESENTATIONS', 'work-talk', 'r1')).sort(), ['work-post.md', 'work-pre.md'], 'no temporary file is left')
})

check('publish again (after an unpublish) reuses the same pin and writes nothing', () => {
  const root = vault()
  const first = pinRunWork(root, 'work-talk', 'r1', 'pre', at('2026-09-23T10:00:00Z'))
  const run = readRunForTalk(root, 'work-talk', 'r1')
  persistRunForTalk(root, 'work-talk', 'r1', { ...run, work: { ...run.work, pre: { ...run.work.pre, publishedAt: '2026-09-23T10:00:00Z', unpublishedAt: '2026-09-24T10:00:00Z' } } })
  const before = readFileSync(runFile(root), 'utf8')
  const copyStat = lstatSync(join(root, '_PRESENTATIONS', 'work-talk', 'r1', 'work-pre.md')).mtimeMs
  const again = pinRunWork(root, 'work-talk', 'r1', 'pre', at('2026-09-30T10:00:00Z'))
  assert.equal(again.created, false)
  assert.deepEqual(again.pinned, first.pinned, 'same pin, same pinnedAt')
  assert.equal(readFileSync(runFile(root), 'utf8'), before, 'the Run file is untouched')
  assert.equal(lstatSync(join(root, '_PRESENTATIONS', 'work-talk', 'r1', 'work-pre.md')).mtimeMs, copyStat, 'the copy is untouched')
  // Re-planning the same file keeps the pin (ticket 03); the pin still reads.
  updatePlannedRun(root, 'work-talk', 'r1', { work: { pre: { fileId: 'intake', opens: '2026-09-21T09:00' } } })
  assert.deepEqual(readPinnedWork(root, 'work-talk', 'r1', 'pre').pinned, first.pinned)
})

check('an edit to the work file leaves the pin unchanged and reaches only the next Run', () => {
  const root = vault(['work-talk', 'other-talk'])
  const sent = pinRunWork(root, 'work-talk', 'r1', 'pre')
  writeFileSync(join(root, 'Work files', 'intake.md'), workFile(4, 'An edited line.'))
  const again = pinRunWork(root, 'work-talk', 'r1', 'pre')
  assert.equal(again.pinned.sha256, sent.pinned.sha256)
  assert.equal(again.pinned.revision, 3)
  assert.equal(readPinnedWork(root, 'work-talk', 'r1', 'pre').text.includes('An edited line.'), false, 'the page already sent never shows the edit')
  const next = pinRunWork(root, 'other-talk', 'r1', 'pre')
  assert.equal(next.pinned.revision, 4)
  assert.notEqual(next.pinned.sha256, sent.pinned.sha256)
  assert.equal(readPinnedWork(root, 'other-talk', 'r1', 'pre').text.includes('An edited line.'), true, 'the next Run carries the edit')
  // A copy changed on disk is caught on read, and a re-publish does not silently re-pin.
  writeFileSync(join(root, '_PRESENTATIONS', 'work-talk', 'r1', 'work-pre.md'), workFile(9))
  assert.throws(() => readPinnedWork(root, 'work-talk', 'r1', 'pre'), /^Error: work-pin-copy-changed$/)
  assert.throws(() => pinRunWork(root, 'work-talk', 'r1', 'pre'), /^Error: work-pin-copy-changed$/)
})

check('a hostile copy path on the Run record is refused, never followed', () => {
  const root = vault(['work-talk', 'other-talk'])
  const good = pinRunWork(root, 'work-talk', 'r1', 'pre').pinned
  pinRunWork(root, 'other-talk', 'r1', 'pre')
  // Syntactically fine paths that are not this Run's own copy: another Run's copy, the work file
  // itself, a sibling file in the talk folder, the other phase's copy.
  for (const copy of ['_PRESENTATIONS/other-talk/r1/work-pre.md', 'Work files/intake.md', '_PRESENTATIONS/work-talk/r1.json', '_PRESENTATIONS/work-talk/r1/work-post.md']) {
    const run = readRunForTalk(root, 'work-talk', 'r1')
    persistRunForTalk(root, 'work-talk', 'r1', { ...run, work: { ...run.work, pre: { ...run.work.pre, pinned: { ...good, copy } } } })
    const before = readFileSync(runFile(root), 'utf8')
    assert.throws(() => readPinnedWork(root, 'work-talk', 'r1', 'pre'), /^Error: work-pin-copy-unsafe$/, copy)
    assert.throws(() => pinRunWork(root, 'work-talk', 'r1', 'pre'), /^Error: work-pin-copy-unsafe$/, copy)
    assert.equal(readFileSync(runFile(root), 'utf8'), before, 'nothing is written')
  }
  // A traversal path never reaches the record at all (dropped by the 03 reader): the phase reads as unpinned.
  const raw = JSON.parse(readFileSync(runFile(root), 'utf8'))
  raw.work.pre.pinned = { ...good, copy: '_PRESENTATIONS/work-talk/r1/../../../../etc/passwd' }
  writeFileSync(runFile(root), JSON.stringify(raw))
  assert.throws(() => readPinnedWork(root, 'work-talk', 'r1', 'pre'), /^Error: work-not-pinned$/)
  // The copy itself replaced by a link (to a file with the pinned bytes, even) is refused.
  const root2 = vault()
  pinRunWork(root2, 'work-talk', 'r1', 'pre')
  const copyPath = join(root2, '_PRESENTATIONS', 'work-talk', 'r1', 'work-pre.md')
  const outside = join(mkdtempSync(join(tmpdir(), 'talkweaver-pin-out-')), 'x.md')
  writeFileSync(outside, readFileSync(copyPath))
  rmSync(copyPath)
  symlinkSync(outside, copyPath)
  assert.throws(() => readPinnedWork(root2, 'work-talk', 'r1', 'pre'), /^Error: work-pin-copy-unsafe$/)
})

check('a symlinked Run folder is refused and the Run record is unchanged', () => {
  const root = vault()
  const elsewhere = mkdtempSync(join(tmpdir(), 'talkweaver-pin-elsewhere-'))
  symlinkSync(elsewhere, join(root, '_PRESENTATIONS', 'work-talk', 'r1'))
  const before = readFileSync(runFile(root), 'utf8')
  assert.throws(() => pinRunWork(root, 'work-talk', 'r1', 'pre'), /^Error: run-folder-unsafe$/)
  assert.equal(readFileSync(runFile(root), 'utf8'), before)
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing is written through the link')
  // A link to a folder inside the vault is refused too: the Run folder must be its own.
  const root2 = vault()
  mkdirSync(join(root2, 'inside'))
  symlinkSync(join(root2, 'inside'), join(root2, '_PRESENTATIONS', 'work-talk', 'r1'))
  assert.throws(() => pinRunWork(root2, 'work-talk', 'r1', 'pre'), /^Error: run-folder-unsafe$/)
  assert.deepEqual(readdirSync(join(root2, 'inside')), [])
  // A link at the copy's own name is never written through.
  const root3 = vault()
  mkdirSync(join(root3, '_PRESENTATIONS', 'work-talk', 'r1'))
  const target = join(elsewhere, 'target.md')
  symlinkSync(target, join(root3, '_PRESENTATIONS', 'work-talk', 'r1', 'work-pre.md'))
  assert.throws(() => pinRunWork(root3, 'work-talk', 'r1', 'pre'), /^Error: run-folder-unsafe$/)
  assert.equal(existsSync(target), false)
  assert.equal('pinned' in readRunForTalk(root3, 'work-talk', 'r1').work.pre, false)
})

check('a file not ready, not UTF-8, with another id, or missing is refused and writes nothing', () => {
  const cases = [
    ['---\nid: intake\ntitle: Intake\nrevision: 1\n---\nNo steps.\n', /^Error: work-file-not-ready$/],
    [Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]), /^Error: work-file-not-utf8$/],
    [workFile(3).replace('id: intake', 'id: something-else'), /^Error: work-file-id-mismatch$/],
    [workFile(3).replace('revision: 3\n', ''), /^Error: work-file-revision-missing$/],
    [null, /^Error: work-file-missing$/]
  ]
  for (const [content, code] of cases) {
    const root = vault()
    const file = join(root, 'Work files', 'intake.md')
    if (content === null) rmSync(file)
    else writeFileSync(file, content)
    const before = readFileSync(runFile(root), 'utf8')
    assert.throws(() => pinRunWork(root, 'work-talk', 'r1', 'pre'), code)
    assert.equal(readFileSync(runFile(root), 'utf8'), before)
    assert.equal(existsSync(join(root, '_PRESENTATIONS', 'work-talk', 'r1')), false, 'no Run folder is made')
  }
  // A work file that is a link out of the vault is refused.
  const root = vault()
  const outside = join(mkdtempSync(join(tmpdir(), 'talkweaver-pin-src-')), 'intake.md')
  writeFileSync(outside, workFile(3))
  rmSync(join(root, 'Work files', 'intake.md'))
  symlinkSync(outside, join(root, 'Work files', 'intake.md'))
  assert.throws(() => pinRunWork(root, 'work-talk', 'r1', 'pre'), /^Error: work-file-path-unsafe$/)
  // Unsafe names from the renderer never reach the file system.
  for (const [slug, id] of [['../x', 'r1'], ['work-talk', '../r1'], ['work-talk', 'manifest']]) {
    assert.throws(() => pinRunWork(root, slug, id, 'pre'), /^Error: run-path-unsafe$/)
    assert.throws(() => readPinnedWork(root, slug, id, 'pre'), /^Error: run-path-unsafe$/)
  }
  assert.throws(() => pinRunWork(root, 'work-talk', 'nope', 'pre'), /^Error: run-not-found$/)
})

check('a talk folder with spaces and accents pins and reads back', () => {
  const root = vault(['Café talk 2026'])
  const result = pinRunWork(root, 'Café talk 2026', 'r1', 'pre')
  assert.equal(result.pinned.copy, '_PRESENTATIONS/Café talk 2026/r1/work-pre.md')
  assert.deepEqual(readRunForTalk(root, 'Café talk 2026', 'r1').work.pre.pinned, result.pinned, 'the 03 reader keeps the path')
  assert.equal(readPinnedWork(root, 'Café talk 2026', 'r1', 'pre').pinned.sha256, result.pinned.sha256)
})

check('Runs already sent come from the pin records', () => {
  const root = vault(['work-talk', 'other-talk'])
  pinRunWork(root, 'work-talk', 'r1', 'pre', at('2026-09-23T10:00:00Z'))
  pinRunWork(root, 'other-talk', 'r1', 'post', at('2026-09-25T10:00:00Z'))
  const runs = [readRunForTalk(root, 'work-talk', 'r1'), readRunForTalk(root, 'other-talk', 'r1')]
  assert.deepEqual(sentRunsForWorkFile(runs, 'intake').map((s) => `${s.talkSlug}/${s.runId}/${s.phase}@${s.revision}`), ['other-talk/r1/post@3', 'work-talk/r1/pre@3'])
  assert.deepEqual(sentRunsForWorkFile(runs, 'other-file'), [])
})

check('a talk folder linked to another folder inside the vault is accepted; one linked outside is refused', () => {
  const root = vault()
  const real = join(root, 'elsewhere-in-vault')
  mkdirSync(real)
  // Move the talk's folder inside the vault and leave a link at its name.
  writeFileSync(join(real, 'r1.json'), readFileSync(runFile(root)))
  rmSync(join(root, '_PRESENTATIONS', 'work-talk'), { recursive: true })
  symlinkSync(real, join(root, '_PRESENTATIONS', 'work-talk'))
  const pinned = pinRunWork(root, 'work-talk', 'r1', 'pre')
  assert.equal(pinned.created, true)
  assert.ok(existsSync(join(real, 'r1', 'work-pre.md')), 'the copy is in the real talk folder\'s Run folder')
  assert.equal(readPinnedWork(root, 'work-talk', 'r1', 'pre').pinned.sha256, pinned.pinned.sha256)
  const root2 = vault()
  const out = mkdtempSync(join(tmpdir(), 'talkweaver-pin-talk-out-'))
  writeFileSync(join(out, 'r1.json'), readFileSync(runFile(root2)))
  rmSync(join(root2, '_PRESENTATIONS', 'work-talk'), { recursive: true })
  symlinkSync(out, join(root2, '_PRESENTATIONS', 'work-talk'))
  assert.throws(() => pinRunWork(root2, 'work-talk', 'r1', 'pre'), /^Error: run-(?:not-found|folder-unsafe)$/)
  assert.deepEqual(readdirSync(out), ['r1.json'], 'nothing is written outside the vault')
})

check('a talk slug with `:` or a leading `~` pins: the copy path and the talk slug agree', () => {
  for (const slug of ['talk: part 2', '~draft talk']) {
    assert.equal(isSafeTalkSlug(slug), true, slug)
    assert.equal(safeCopyPath(`_PRESENTATIONS/${slug}/r1/work-pre.md`), true, slug)
    const root = vault([slug])
    const result = pinRunWork(root, slug, 'r1', 'pre')
    assert.equal(result.pinned.copy, `_PRESENTATIONS/${slug}/r1/work-pre.md`)
    assert.deepEqual(readRunForTalk(root, slug, 'r1').work.pre.pinned, result.pinned, 'the record keeps the pin')
    assert.equal(readPinnedWork(root, slug, 'r1', 'pre').pinned.sha256, result.pinned.sha256)
  }
  // Only the first segment, where a drive or a home prefix would act, refuses them.
  for (const copy of ['C:/x/work-pre.md', '~/x/work-pre.md', '~x/work-pre.md', 'a/../b', '.hidden/x', 'a//b']) assert.equal(safeCopyPath(copy), false, copy)
})

check('an existing copy with no pin on the record is never overwritten silently', () => {
  const root = vault()
  const folder = join(root, '_PRESENTATIONS', 'work-talk', 'r1')
  mkdirSync(folder)
  writeFileSync(join(folder, 'work-pre.md'), 'left here by hand')
  const before = readFileSync(runFile(root), 'utf8')
  assert.throws(() => pinRunWork(root, 'work-talk', 'r1', 'pre'), /^Error: work-pin-copy-exists$/)
  assert.equal(readFileSync(join(folder, 'work-pre.md'), 'utf8'), 'left here by hand', 'the copy is untouched')
  assert.equal(readFileSync(runFile(root), 'utf8'), before, 'and the Run is unchanged')
  // The same bytes as the work file (an earlier attempt that stopped before the record): the pin goes ahead.
  writeFileSync(join(folder, 'work-pre.md'), readFileSync(join(root, 'Work files', 'intake.md')))
  assert.equal(pinRunWork(root, 'work-talk', 'r1', 'pre').created, true)
})

check('a work file that links to a FIFO or a device is refused before it is read', () => {
  const root = vault()
  const file = join(root, 'Work files', 'intake.md')
  rmSync(file)
  symlinkSync('/dev/zero', file)
  assert.throws(() => pinRunWork(root, 'work-talk', 'r1', 'pre'), /^Error: work-file-path-unsafe$/)
  rmSync(file)
  const fifo = join(root, 'Work files', 'pipe')
  execFileSync('mkfifo', [fifo])
  symlinkSync(fifo, file)
  // Would block for ever if the FIFO were opened.
  assert.throws(() => pinRunWork(root, 'work-talk', 'r1', 'pre'), /^Error: work-file-path-unsafe$/)
  rmSync(file)
  execFileSync('mkfifo', [file])
  assert.throws(() => pinRunWork(root, 'work-talk', 'r1', 'pre'), /^Error: work-file-path-unsafe$/)
  assert.equal(existsSync(join(root, '_PRESENTATIONS', 'work-talk', 'r1')), false, 'no Run folder is made')
})

console.log(`run-work-pin: ${passed} checks passed`)
