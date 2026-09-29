import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addRunPoll,
  addRunPollResponse,
  applyRunInstantSlides,
  applyRunPollBuffer,
  attachDeliveryToPlanned,
  clearRunHandoutUrl,
  createPlannedRun,
  deletePlannedRun,
  injectRunCoverMetadata,
  listRuns,
  markRunInstantSlideAdded,
  normaliseRun,
  plannedRunCandidates,
  persistRun,
  persistRunForTalk,
  readRun,
  readRunForTalk,
  runPathForTalk,
  imageHeader,
  sniffImageFormat,
  resolveRunSlideSet,
  runHandoutSlug,
  runInstantSlideFrom,
  setRunHandoutUrl,
  updatePlannedRun
} from '../src/main/runs.ts'

const root = mkdtempSync(join(tmpdir(), 'talkweaver-runs-'))
const baseInput = {
  talkSlug: 'age-of-the-claw',
  talkTitle: 'The Age of the Claw',
  plannedDate: '2026-07-22',
  eventTitle: 'Dept. seminar',
  audience: 'Continuing Education',
  slideSet: { kind: 'pathway', pathwayId: 'short' }
}

const planned = createPlannedRun(root, baseInput, () => 'run-planned-1')
assert.equal(planned.status, 'planned')
assert.equal(planned.id, 'run-planned-1')
assert.deepEqual(listRuns(root, baseInput.talkSlug), [planned])

const edited = updatePlannedRun(root, baseInput.talkSlug, planned.id, {
  eventTitle: 'Department seminar',
  slideSet: { kind: 'full' }
})
assert.equal(edited?.eventTitle, 'Department seminar')
assert.deepEqual(edited?.slideSet, { kind: 'full' })

assert.equal(deletePlannedRun(root, baseInput.talkSlug, planned.id), true)
assert.deepEqual(listRuns(root, baseInput.talkSlug), [])

const legacy = normaliseRun({
  id: 'legacy', talkSlug: 'age-of-the-claw', talkTitle: 'The Age of the Claw',
  startedAt: '2026-06-28T10:00:00.000Z', endedAt: '2026-06-28T11:00:00.000Z',
  recordingMs: 0, wallClockMs: 3600000, timerTargetMin: 60, context: null,
  pathwayId: 'short', audio: null, transcript: null, slideTimeIndex: []
})
assert.equal(legacy.status, 'delivered')
assert.deepEqual(legacy.slideSet, { kind: 'pathway', pathwayId: 'short' })
assert.deepEqual(legacy.polls, [])
assert.deepEqual(legacy.pollResponses, [])

const pollDefinition = {
  id: 'poll-s1', type: 'single', question: 'Choose one',
  options: [{ optionId: 'poll-s1-option-1', label: 'First' }], visibility: 'held'
}
const withPoll = addRunPoll(legacy, pollDefinition)
assert.deepEqual(withPoll.polls, [pollDefinition])
const withResponse = addRunPollResponse(withPoll, {
  pollId: 'poll-s1', choice: 'poll-s1-option-1', tMs: 1_250, slideId: 's1'
})
assert.deepEqual(withResponse.pollResponses, [{
  pollId: 'poll-s1', choice: 'poll-s1-option-1', tMs: 1_250, slideId: 's1'
}])

const normalisedPollRun = normaliseRun({
  ...legacy,
  polls: [pollDefinition, null, { id: '', type: 'invalid' }],
  pollResponses: [
    { pollId: 'poll-s1', text: 'An answer', tMs: 2_500, slideId: 's1' },
    { pollId: '', choice: 'bad', tMs: 1, slideId: 's1' }
  ]
})
assert.deepEqual(normalisedPollRun.polls, [pollDefinition])
assert.deepEqual(normalisedPollRun.pollResponses, [
  { pollId: 'poll-s1', text: 'An answer', tMs: 2_500, slideId: 's1' }
])

const bufferedPollRun = applyRunPollBuffer(legacy, {
  polls: [
    pollDefinition,
    { id: 'poll-open', type: 'open', question: 'What matters?', options: [], visibility: 'live' }
  ],
  responses: [
    { pollId: 'poll-s1', choice: ['poll-s1-option-1'], tMs: 3_000, slideId: 's1' },
    { pollId: 'poll-open', text: 'Accountability', tMs: 3_250, slideId: 's2' },
    { pollId: 'poll-open', text: 'Judgement', tMs: 3_500, slideId: 's2' }
  ]
})
assert.deepEqual(bufferedPollRun.polls.map((poll) => poll.id), ['poll-s1', 'poll-open'])
assert.deepEqual(bufferedPollRun.pollResponses, [
  { pollId: 'poll-s1', choice: ['poll-s1-option-1'], tMs: 3_000, slideId: 's1' },
  { pollId: 'poll-open', text: 'Accountability', tMs: 3_250, slideId: 's2' },
  { pollId: 'poll-open', text: 'Judgement', tMs: 3_500, slideId: 's2' }
])
persistRun(root, bufferedPollRun)
assert.deepEqual(readRun(root, legacy.talkSlug, legacy.id)?.pollResponses, bufferedPollRun.pollResponses)

const attached = attachDeliveryToPlanned(
  { ...planned, status: 'planned' },
  {
    id: 'bare-delivery', talkSlug: planned.talkSlug, talkTitle: planned.talkTitle,
    status: 'delivered', kind: 'delivery', startedAt: '2026-07-22T09:58:00.000Z',
    endedAt: '2026-07-22T10:42:00.000Z', recordingMs: 0, wallClockMs: 2640000,
    timerTargetMin: 45, context: null, pathwayId: 'short', audio: null, transcript: null,
    slideTimeIndex: [{ event: 'enter', slideId: 's1', tMs: 0 }]
  }
)
assert.equal(attached.id, planned.id)
assert.equal(attached.status, 'delivered')
assert.equal(attached.plannedDate, planned.plannedDate)
assert.equal(attached.eventTitle, planned.eventTitle)
assert.equal(attached.wallClockMs, 2640000)

const candidates = plannedRunCandidates([
  { ...planned, id: 'later', plannedDate: '2026-08-01' },
  { ...planned, id: 'full', plannedDate: '2026-07-20', slideSet: { kind: 'full' } },
  { ...planned, id: 'match', plannedDate: '2026-07-24' },
  attached
], 'short')
assert.deepEqual(candidates.map((run) => run.id), ['full', 'match', 'later'])
assert.equal(candidates.findIndex((run) => run.id === 'match'), 1)

const rows = [{ slide_id: 's1' }, { slide_id: 's2' }, { slide_id: 's3' }]
const pathways = [{ id: 'short', name: 'Short', slideIds: ['s3', 'missing', 's1'] }]
assert.deepEqual(resolveRunSlideSet({ kind: 'full' }, pathways, rows), { rows, missing: [] })
assert.deepEqual(resolveRunSlideSet({ kind: 'pathway', pathwayId: 'short' }, pathways, rows), {
  rows: [rows[2], rows[0]], missing: ['missing']
})

assert.equal(runHandoutSlug('age-of-the-claw', 'Dept. seminar', '2026-07-22', []), 'age-of-the-claw-dept-seminar-2026-07-22')
assert.equal(runHandoutSlug('age-of-the-claw', 'Dept. seminar', '2026-07-22', ['age-of-the-claw-dept-seminar-2026-07-22']), 'age-of-the-claw-dept-seminar-2026-07-22-2')

const cover = '<section class="slide cover"><div class="slide-content"><h1>The Age of the Claw</h1></div></section>'
const covered = injectRunCoverMetadata(cover, 'Dept. seminar', '2026-07-22')
assert.match(covered, /run-cover-meta/)
assert.match(covered, /Dept\. seminar/)
assert.match(covered, /22 July 2026/)
assert.match(covered, /<h1>The Age of the Claw<\/h1>/)

const withUrl = setRunHandoutUrl(attached, 'https://handouts.example/run')
assert.equal(withUrl.handoutUrl, 'https://handouts.example/run')
assert.equal(clearRunHandoutUrl(withUrl).handoutUrl, undefined)

// Run URL bookkeeping never needs the outline, so its frontmatter remains byte-identical.
const outline = '---\ntitle: The Age of the Claw\nhandout_url: https://evergreen.example/claw\n---\n\n### One\n'
const before = Buffer.from(outline)
setRunHandoutUrl(attached, 'https://handouts.example/run')
assert.deepEqual(Buffer.from(outline), before)

// Persistence uses the planned record's file and keeps it valid JSON.
const persisted = createPlannedRun(root, { ...baseInput, eventTitle: 'Persistence check' }, () => 'persisted')
assert.equal(JSON.parse(readFileSync(join(root, '_PRESENTATIONS', baseInput.talkSlug, 'persisted.json'), 'utf8')).eventTitle, persisted.eventTitle)

// A non-directory entry in _PRESENTATIONS (e.g. a Finder .DS_Store) must NOT make listRuns throw —
// otherwise the whole History window silently blanks even though the recordings are right there.
import { writeFileSync as _writeFileSync, mkdirSync as _mkdirSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
const dsRoot = mkdtempSync(join(tmpdir(), 'talkweaver-dsstore-'))
_mkdirSync(join(dsRoot, '_PRESENTATIONS'), { recursive: true })
_writeFileSync(join(dsRoot, '_PRESENTATIONS', '.DS_Store'), 'not a directory', 'utf8')
_writeFileSync(join(dsRoot, '_PRESENTATIONS', 'stray-file.txt'), 'also not a directory', 'utf8')
createPlannedRun(dsRoot, { ...baseInput, eventTitle: 'Survives DS_Store' }, () => 'survivor')
const survived = listRuns(dsRoot) // no slug → enumerates every _PRESENTATIONS child
assert.equal(survived.length, 1, 'listRuns must skip non-directory entries and still return real runs')
assert.equal(survived[0].id, 'survivor')

// Live-presenting ticket 07: instant slides shown in a session are stamped on the Run, once each,
// with the slide they followed; "Add to talk" is recorded on the entry and survives later flushes.
{
  const instantRoot = mkdtempSync(join(tmpdir(), 'talkweaver-instant-'))
  const WEBP_PIXEL = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA='
  const bare = persistRun(instantRoot, normaliseRun({ id: 'run-live', talkSlug: 'live-talk', startedAt: '2026-09-23T13:05:00.000Z' }))
  assert.equal('instantSlides' in bare, false, 'a Run without instant slides carries no instantSlides key')
  assert.equal(readFileSync(join(instantRoot, '_PRESENTATIONS', 'live-talk', 'run-live.json'), 'utf8').includes('instantSlides'), false)
  const shown = [
    runInstantSlideFrom({ kind: 'link', url: 'https://example.org/a', qrSvg: '<svg>big</svg>', shownAt: 2000 }, 'slide-5'),
    runInstantSlideFrom({ kind: 'text', text: 'Try it now', shownAt: 1000 }, 'slide-3'),
    runInstantSlideFrom({ kind: 'countdown', startedAt: 3000, durationMs: 300000, label: 'Discussion', shownAt: 3000 }, 'slide-7'),
    runInstantSlideFrom({ kind: 'time', shownAt: 4000 }, null),
    runInstantSlideFrom({ kind: 'image', dataUrl: WEBP_PIXEL, width: 1600, height: 1000, shownAt: 5000 }, 'slide-12'),
  ]
  assert.equal('qrSvg' in shown[0], false, 'the QR code is not stored; the URL regenerates it')
  let run = applyRunInstantSlides(bare, shown)
  assert.deepEqual(run.instantSlides.map((e) => [e.id, e.kind, e.afterSlideId]), [
    ['text-1000', 'text', 'slide-3'], ['link-2000', 'link', 'slide-5'], ['countdown-3000', 'countdown', 'slide-7'],
    ['time-4000', 'time', null], ['image-5000', 'image', 'slide-12'],
  ])
  assert.deepEqual(run.instantSlides[2], { id: 'countdown-3000', kind: 'countdown', shownAt: 3000, afterSlideId: 'slide-7', durationMs: 300000, label: 'Discussion' })
  assert.equal(applyRunInstantSlides(run, shown), run, 're-flushing the same shows changes nothing')
  run = markRunInstantSlideAdded(run, 'text-1000', { afterSlideNumber: 3, afterSlideTitle: 'Three shifts', slideId: 'k2x9a', at: '2026-09-24T09:00:00.000Z' })
  run = applyRunInstantSlides(run, [{ ...shown[1], afterSlideId: 'other' }])
  assert.deepEqual(run.instantSlides[0].added, { afterSlideNumber: 3, afterSlideTitle: 'Three shifts', slideId: 'k2x9a', at: '2026-09-24T09:00:00.000Z' })
  assert.equal(run.instantSlides[0].afterSlideId, 'slide-3', 'a later flush never rewrites a recorded entry')
  persistRun(instantRoot, run)
  const reread = readRun(instantRoot, 'live-talk', 'run-live')
  assert.deepEqual(reread.instantSlides, run.instantSlides, 'instant slides and their Added state survive a re-read')
  assert.throws(() => markRunInstantSlideAdded(run, 'nope', run.instantSlides[0].added), /instant-slide-not-found/)
  const junk = normaliseRun({ ...run, instantSlides: [{ kind: 'text', shownAt: 1 }, { kind: 'link', url: 'javascript:alert(1)', shownAt: 2 },
    { kind: 'image', dataUrl: 'data:image/png;base64,AA', width: 1, height: 1, shownAt: 3 }, { kind: 'bogus', shownAt: 4 }] })
  assert.equal('instantSlides' in junk, false, 'invalid instant-slide records are dropped')

  // Images kept on a Run are within the live cap (120,000 data-URL characters) and carry a complete
  // WebP/PNG/JPEG header with a real size; anything else is not kept.
  const pixelBase64 = WEBP_PIXEL.slice('data:image/webp;base64,'.length)
  const pixelBytes = Buffer.from(pixelBase64, 'base64')
  const zeroSized = Buffer.from(pixelBytes); zeroSized.writeUInt16LE(0, 26) // VP8 frame width 0
  // A real 1×1 PNG and 2×1 JPEG (made with sharp).
  const REAL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
  const REAL_JPEG = '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z'
  const oversize = `data:image/webp;base64,${pixelBase64}${'A'.repeat(120_004 - WEBP_PIXEL.length)}`
  const images = normaliseRun({ ...run, instantSlides: [
    { kind: 'image', dataUrl: WEBP_PIXEL, width: 1, height: 1, shownAt: 10 },
    { kind: 'image', dataUrl: oversize, width: 1, height: 1, shownAt: 11 },
    { kind: 'image', dataUrl: `data:image/webp;base64,${Buffer.from('<svg onload=alert(1)>not an image</svg>').toString('base64')}`, width: 1, height: 1, shownAt: 12 },
    { kind: 'image', dataUrl: `data:image/webp;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')}`, width: 1, height: 1, shownAt: 13 },
    { kind: 'image', dataUrl: `data:image/webp;base64,${REAL_PNG}`, width: 1, height: 1, shownAt: 14 },
    // Round 2: a bare 16-byte RIFF…WEBP header, a zero-size frame and a truncated file are not pictures.
    { kind: 'image', dataUrl: `data:image/webp;base64,${Buffer.from('RIFF\x08\0\0\0WEBPVP8 ', 'latin1').toString('base64')}`, width: 1, height: 1, shownAt: 15 },
    { kind: 'image', dataUrl: `data:image/webp;base64,${zeroSized.toString('base64')}`, width: 1, height: 1, shownAt: 16 },
    { kind: 'image', dataUrl: `data:image/webp;base64,${pixelBytes.subarray(0, 36).toString('base64')}`, width: 1, height: 1, shownAt: 17 },
  ] })
  assert.ok(oversize.length > 120_000)
  assert.deepEqual(images.instantSlides.map((e) => e.shownAt), [10, 14],
    'oversize, non-image, signature-only, zero-size and truncated data are dropped; real WebP and PNG are kept')
  assert.equal(sniffImageFormat(Buffer.from('RIFF\x08\0\0\0WEBPVP8 ', 'latin1')), null, 'a 16-byte RIFF…WEBP header is not a WebP')
  assert.deepEqual(imageHeader(pixelBytes), { format: 'webp', width: 1, height: 1 })
  assert.deepEqual(imageHeader(Buffer.from(REAL_PNG, 'base64')), { format: 'png', width: 1, height: 1 })
  assert.deepEqual(imageHeader(Buffer.from(REAL_JPEG, 'base64')), { format: 'jpeg', width: 2, height: 1 })
}

// Ticket 07 path boundary: a Run is read only from its talk's folder, only when it names that talk,
// and written back only to that same path. Hostile ids and slugs are refused and write nothing.
{
  const vault = mkdtempSync(join(tmpdir(), 'talkweaver-run-boundary-'))
  persistRun(vault, normaliseRun({ id: 'run-a', talkSlug: 'talk-a', startedAt: '2026-09-23T13:05:00.000Z' }))
  persistRun(vault, normaliseRun({ id: 'run-b', talkSlug: 'other-talk', startedAt: '2026-09-23T13:05:00.000Z' }))
  // A Run file in talk-a's folder whose own id/talkSlug point elsewhere.
  _mkdirSync(join(vault, '_PRESENTATIONS', 'talk-a'), { recursive: true })
  _writeFileSync(join(vault, '_PRESENTATIONS', 'talk-a', 'run-evil.json'), JSON.stringify({ id: '../../../outside/target', talkSlug: 'talk-a', startedAt: '2026-09-23T13:05:00.000Z' }))
  _writeFileSync(join(vault, '_PRESENTATIONS', 'talk-a', 'run-moved.json'), JSON.stringify({ id: 'run-moved', talkSlug: 'other-talk', startedAt: '2026-09-23T13:05:00.000Z' }))
  assert.equal(readRunForTalk(vault, 'talk-a', 'run-a')?.id, 'run-a')
  assert.equal(readRunForTalk(vault, 'talk-a', 'run-evil'), null, 'a Run whose own id is a path is refused')
  assert.equal(readRunForTalk(vault, 'talk-a', 'run-moved'), null, 'a Run naming another talk is refused')
  assert.equal(readRunForTalk(vault, 'talk-a', '../other-talk/run-b'), null, 'a run id with a path is refused')
  assert.equal(readRunForTalk(vault, '../_PRESENTATIONS/other-talk', 'run-b'), null)
  for (const [slug, id] of [['talk-a', '../x'], ['talk-a', 'a/b'], ['talk-a', ''], ['..', 'run-a'], ['.', 'run-a'], ['a/b', 'run-a'], ['a\\b', 'run-a'], ['', 'run-a'], ['talk-a', '.hidden']]) {
    assert.equal(runPathForTalk(vault, slug, id), null, `refused: ${slug} / ${id}`)
  }
  assert.equal(runPathForTalk(vault, 'Talk with spaces – ünïcode', 'sess-20260706-120000-i'), join(vault, '_PRESENTATIONS', 'Talk with spaces – ünïcode', 'sess-20260706-120000-i.json'))
  const evil = normaliseRun({ id: '../../../outside/target', talkSlug: 'talk-a' })
  assert.throws(() => persistRunForTalk(vault, 'talk-a', 'run-evil', evil), /run-identity-mismatch/)
  assert.throws(() => persistRunForTalk(vault, 'talk-a', 'run-a', normaliseRun({ id: 'run-a', talkSlug: 'other-talk' })), /run-identity-mismatch/)
  assert.throws(() => persistRunForTalk(vault, '../escape', 'run-a', normaliseRun({ id: 'run-a', talkSlug: '../escape' })), /run-path-unsafe/)
  assert.equal(existsSync(join(vault, '..', 'outside')), false)
  assert.equal(existsSync(join(vault, 'escape')), false)
  // A talk folder that is a symlink out of the vault is refused.
  const outside = mkdtempSync(join(tmpdir(), 'talkweaver-run-outside-'))
  symlinkSync(outside, join(vault, '_PRESENTATIONS', 'linked-talk'))
  assert.equal(runPathForTalk(vault, 'linked-talk', 'run-x'), null)
  assert.throws(() => persistRunForTalk(vault, 'linked-talk', 'run-x', normaliseRun({ id: 'run-x', talkSlug: 'linked-talk' })), /run-path-unsafe/)
  assert.deepEqual(readdirSync(outside), [], 'nothing written through the symlink')
  const saved = persistRunForTalk(vault, 'talk-a', 'run-a', normaliseRun({ ...readRunForTalk(vault, 'talk-a', 'run-a'), context: 'ok' }))
  assert.equal(readRun(vault, 'talk-a', 'run-a').context, saved.context)
  // A talk folder that does not exist yet is created inside the vault.
  persistRunForTalk(vault, 'new-talk', 'run-n', normaliseRun({ id: 'run-n', talkSlug: 'new-talk' }))
  assert.equal(readRunForTalk(vault, 'new-talk', 'run-n')?.id, 'run-n')

  // Round 2 (re-review of 743fef9): a Run file linked to matching JSON outside the vault is refused.
  const elsewhere = mkdtempSync(join(tmpdir(), 'talkweaver-run-elsewhere-'))
  _writeFileSync(join(elsewhere, 'run-l.json'), JSON.stringify({ id: 'run-l', talkSlug: 'talk-a', startedAt: '2026-09-23T13:05:00.000Z' }))
  symlinkSync(join(elsewhere, 'run-l.json'), join(vault, '_PRESENTATIONS', 'talk-a', 'run-l.json'))
  assert.equal(readRunForTalk(vault, 'talk-a', 'run-l'), null, 'a Run file symlinked out of the vault is not read')
  assert.equal(runPathForTalk(vault, 'talk-a', 'run-l'), null)
  assert.throws(() => persistRunForTalk(vault, 'talk-a', 'run-l', normaliseRun({ id: 'run-l', talkSlug: 'talk-a' })), /run-path-unsafe/)
  assert.equal(readFileSync(join(elsewhere, 'run-l.json'), 'utf8').includes('"run-l"'), true, 'the outside file is untouched')
  // A Run file linked to another file INSIDE the vault is still readable (links within the vault are fine).
  symlinkSync(join(vault, '_PRESENTATIONS', 'talk-a', 'run-a.json'), join(vault, '_PRESENTATIONS', 'talk-a', 'run-alias.json'))
  assert.equal(readRunForTalk(vault, 'talk-a', 'run-alias'), null, 'still refused: the linked Run names run-a, not run-alias')
  assert.ok(runPathForTalk(vault, 'talk-a', 'run-alias'), 'the path itself is inside the vault')
}

// Round 2: `_PRESENTATIONS` itself symlinked out of the vault, with the talk folder absent — the
// writer must create nothing outside (the old check skipped a folder whose realpath failed).
{
  const vault = mkdtempSync(join(tmpdir(), 'talkweaver-run-linked-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'talkweaver-run-linked-root-outside-'))
  symlinkSync(outside, join(vault, '_PRESENTATIONS'))
  assert.equal(runPathForTalk(vault, 'new-talk', 'run-a'), null)
  assert.throws(() => persistRunForTalk(vault, 'new-talk', 'run-a', normaliseRun({ id: 'run-a', talkSlug: 'new-talk' })), /run-path-unsafe/)
  assert.deepEqual(readdirSync(outside), [], 'nothing created outside the vault')
  assert.equal(readRunForTalk(vault, 'new-talk', 'run-a'), null)
  // A dangling `_PRESENTATIONS` link is refused too.
  const dangling = mkdtempSync(join(tmpdir(), 'talkweaver-run-dangling-'))
  symlinkSync(join(outside, 'not-there'), join(dangling, '_PRESENTATIONS'))
  assert.throws(() => persistRunForTalk(dangling, 'new-talk', 'run-a', normaliseRun({ id: 'run-a', talkSlug: 'new-talk' })), /run-path-unsafe/)
  assert.equal(existsSync(join(outside, 'not-there')), false)
  // A vault reached through a symlink (e.g. a synced folder) still works: containment is judged on real paths.
  const realVault = mkdtempSync(join(tmpdir(), 'talkweaver-run-real-vault-'))
  const linkedVault = join(mkdtempSync(join(tmpdir(), 'talkweaver-run-vault-link-')), 'vault')
  symlinkSync(realVault, linkedVault)
  persistRunForTalk(linkedVault, 'talk-z', 'run-z', normaliseRun({ id: 'run-z', talkSlug: 'talk-z' }))
  assert.equal(readRunForTalk(linkedVault, 'talk-z', 'run-z')?.id, 'run-z')
  assert.ok(existsSync(join(realVault, '_PRESENTATIONS', 'talk-z', 'run-z.json')))
}

console.log('runs: planned CRUD, legacy interpretation, attach, slide sets, cover and URLs, DS_Store tolerance, instant slides, image checks, Run path boundary passed')
