import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addRunPoll,
  addRunPollResponse,
  applyRunAudienceFeedback,
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
  reactionCountsBySlide,
  readRun,
  readRunForTalk,
  runPathForTalk,
  imageHeader,
  sniffImageFormat,
  resolveRunSlideSet,
  runHandoutSlug,
  runInstantSlideFrom,
  setRunHandoutUrl,
  preworkWindow,
  updatePlannedRun
} from '../src/main/runs.ts'
import { parseAudienceQuestion } from '../worker/protocol.ts'
import { INK_READBACK_BYTES, inkMarkFileBytes, readbackInkMark, readbackSlideTimeIndex, sessionForList } from '../src/main/run-ink-readback.ts'
import { applyRunBoards } from '../src/main/runs.ts'
import { isHiddenCard, runBoardFromPollState, runBoardMarkdown, runBoardState, runBoardView, setRunBoardCardPutBack } from '../src/shared/run-board.ts'
import { runSharePayload } from '../src/shared/run-results-share.ts'
import { createRunResultsShares } from '../src/main/run-results-share.ts'
import { LINK_NOT_UPDATED, registerRunBoardIpc } from '../src/main/run-board-ipc.ts'
import { parseRunSharePush } from '../worker/run-share-state.ts'
import { applyRunPrework } from '../src/main/runs.ts'
import { mergeRunPrework, preworkWindowMs, publicPreworkForm } from '../src/shared/run-prework.ts'
import { PREWORK_PURGED_MESSAGE, createRunPrework, registerRunPreworkIpc } from '../src/main/run-prework.ts'
import { sheetTimeZone, zoneToSend } from '../src/shared/plan-run.ts'

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
  // A link shown with text or a countdown is kept (never its QR); Runs without one read unchanged; unsafe links are not kept.
  {
    const link = 'https://example.com/form'
    const withLink = [
      runInstantSlideFrom({ kind: 'text', text: 'Fill in', link, linkQrSvg: '<svg>big</svg>', shownAt: 6000 }, 'slide-2'),
      runInstantSlideFrom({ kind: 'countdown', startedAt: 7000, durationMs: 60000, link, linkQrSvg: '<svg>big</svg>', shownAt: 7000 }, null),
    ]
    assert.equal(withLink[0].link, link); assert.equal(withLink[1].link, link)
    assert.equal(JSON.stringify(withLink).includes('<svg'), false, 'the link QR is not stored')
    assert.equal('link' in shown[1], false, 'a text slide without a link carries no link key')
    const kept = applyRunInstantSlides(bare, withLink)
    assert.deepEqual(kept.instantSlides.map((e) => e.link), [link, link])
    const dir = mkdtempSync(join(tmpdir(), 'talkweaver-instant-link-'))
    persistRun(dir, kept)
    assert.deepEqual(readRun(dir, 'live-talk', 'run-live').instantSlides, kept.instantSlides, 'the link survives a write and re-read')
    assert.equal(runInstantSlideFrom({ kind: 'text', text: 'T', link: 'https://x.com/<!--', shownAt: 8000 }, null).link, 'https://x.com/%3C!--', 'a Run stores the canonical href')
    assert.equal(normaliseRun({ ...bare, instantSlides: [{ kind: 'link', url: 'https://x.com/a>b', shownAt: 9 }] }).instantSlides[0].url, 'https://x.com/a%3Eb')
    assert.equal(normaliseRun({ ...bare, instantSlides: [{ kind: 'text', text: 'T', link: 'https://x.com/?q=`', shownAt: 9 }] }).instantSlides[0].link, undefined)
    for (const bad of ['javascript:alert(1)', 'https://good.example@evil.example/x', 'https://x.com/?q=`', 'example.com/form', 'https://a b.example', '', 5]) {
      const dropped = normaliseRun({ ...bare, instantSlides: [{ kind: 'text', text: 'T', link: bad, shownAt: 1 }, { kind: 'countdown', durationMs: 60000, link: bad, shownAt: 2 }] })
      assert.deepEqual(dropped.instantSlides.map((e) => 'link' in e), [false, false], `link ${JSON.stringify(bad)} is not kept; the slides are`)
    }
  }
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

// Reactions ticket 06: a Run keeps the talk's reactions ({reaction, tMs, slideId}, undos as
// withdrawn: true) and questions ({text, name?, slideId, tMs, answered}) as optional fields. Old Runs
// read and re-persist byte for byte; malformed entries are dropped and the rest of the Run is kept.
{
  const vault = mkdtempSync(join(tmpdir(), 'talkweaver-feedback-'))
  const old = { id: 'run-old', talkSlug: 'feedback-talk', talkTitle: 'Feedback talk', kind: 'delivery', status: 'delivered',
    slideSet: { kind: 'full' }, startedAt: '2026-09-23T13:05:00.000Z', endedAt: '2026-09-23T14:00:00.000Z',
    recordingMs: 0, wallClockMs: 0, timerTargetMin: 30, context: null, pathwayId: null, audio: null, transcript: null,
    slideTimeIndex: [], polls: [], pollResponses: [] }
  const oldPath = join(vault, '_PRESENTATIONS', 'feedback-talk', 'run-old.json')
  _mkdirSync(join(vault, '_PRESENTATIONS', 'feedback-talk'), { recursive: true })
  const oldBytes = `${JSON.stringify(old, null, 2)}\n`
  _writeFileSync(oldPath, oldBytes)
  const oldRun = readRun(vault, 'feedback-talk', 'run-old')
  assert.equal('reactions' in oldRun, false, 'an old Run gains no reactions key')
  assert.equal('questions' in oldRun, false, 'an old Run gains no questions key')
  persistRun(vault, oldRun)
  assert.equal(readFileSync(oldPath, 'utf8'), oldBytes, 'an old Run re-persists byte for byte')
  assert.equal(applyRunAudienceFeedback(oldRun, {}), oldRun, 'nothing to merge changes nothing')

  const reactions = [
    { id: 's:r1', reaction: 'puzzled', slideId: 'slide-3', tMs: 41000 },
    { id: 's:r2', reaction: 'puzzled', slideId: 'slide-3', tMs: 42000 },
    { id: 's:r3', reaction: 'puzzled', slideId: 'slide-3', tMs: 45000, withdrawn: true },
    { id: 's:r4', reaction: 'helped', slideId: 'slide-3', tMs: 45000 },
    { id: 's:r5', reaction: 'bookmark', slideId: 'slide-3', tMs: 46000 },
    { id: 's:r6', reaction: 'custom:Too fast', slideId: 'slide-6', tMs: 50000 },
    { id: 's:r7', reaction: 'agree', slideId: 'slide-9', tMs: 60000 },
    { id: 's:r8', reaction: 'agree', slideId: 'slide-9', tMs: 61000, withdrawn: true },
  ]
  const questions = [
    { id: 's:question-2', text: 'Where can I read it?', slideId: 'slide-6', tMs: 52000, answered: false },
    { id: 's:question-1', text: 'Why?', name: 'Priya', slideId: 'slide-3', tMs: 46000, answered: true },
  ]
  let run = applyRunAudienceFeedback(oldRun, { reactions, questions })
  assert.equal(run.reactions.length, 8, 'every tap and undo is kept, in arrival order')
  assert.deepEqual(run.reactions[2], { id: 's:r3', reaction: 'puzzled', slideId: 'slide-3', tMs: 45000, withdrawn: true })
  assert.equal('withdrawn' in run.reactions[0], false, 'a tap carries no withdrawn key')
  assert.deepEqual(run.questions, [
    { id: 's:question-1', text: 'Why?', name: 'Priya', slideId: 'slide-3', tMs: 46000, answered: true },
    { id: 's:question-2', text: 'Where can I read it?', slideId: 'slide-6', tMs: 52000, answered: false },
  ], 'questions are kept oldest first; no name means no name key')
  assert.deepEqual(reactionCountsBySlide(run.reactions), [
    { slideId: 'slide-3', counts: { puzzled: 1, helped: 1, bookmark: 1 } },
    { slideId: 'slide-6', counts: { 'custom:Too fast': 1 } },
  ], 'net counts: a withdrawal takes one away; a slide netting to nothing is left out')
  assert.equal(applyRunAudienceFeedback(run, { reactions, questions }), run, 're-flushing the same feedback changes nothing')
  run = applyRunAudienceFeedback(run, { reactions: reactions.slice(0, 2), questions: [{ ...questions[0], answered: true }] })
  assert.equal(run.reactions.length, 8, 'a later flush never removes a reaction')
  assert.equal(run.questions.length, 2, 'a later flush never removes a question')
  assert.equal(run.questions[1].answered, true, 'a later "Mark answered" reaches the Run')
  persistRun(vault, run)
  assert.deepEqual(readRun(vault, 'feedback-talk', 'run-old'), run, 'reactions and questions survive a round trip')

  // Malformed entries are dropped; the Run and its good entries are kept.
  _writeFileSync(oldPath, JSON.stringify({ ...old, reactions: [
    reactions[0],
    { reaction: 'shrug', slideId: 'slide-1', tMs: 1 },
    { reaction: 'custom:', slideId: 'slide-1', tMs: 1 },
    { reaction: 'helped', tMs: 1 },
    { reaction: 'helped', slideId: 'slide-1', tMs: 'soon' },
    { reaction: 'helped', slideId: 'slide-1', tMs: 1, withdrawn: 'yes' },
    { reaction: 'helped', slideId: 'x'.repeat(101), tMs: 1 },
    { ...reactions[0] },
    null, 'puzzled', [1],
    { reaction: 'helped', slideId: 'slide-1', tMs: -5.4 },
  ], questions: [
    questions[1],
    { text: '   ', slideId: 'slide-1', tMs: 1 },
    { text: 'x'.repeat(501), slideId: 'slide-1', tMs: 1 },
    { text: 'Who?', name: 'n'.repeat(61), slideId: 'slide-1', tMs: 1 },
    { text: 'Who?', name: 42, slideId: 'slide-1', tMs: 1 },
    { text: 'Who?', slideId: 'slide-1', tMs: 1, answered: 'yes' },
    { text: '<img src=x onerror=alert(1)>', slideId: 'slide-1', tMs: 3 },
    { text: '  Trimmed  ', name: '  Lena  ', slideId: 'slide-1', tMs: 2 },
    { text: 'Duplicate', id: 's:question-1', slideId: 'slide-1', tMs: 9 },
  ] }))
  const repaired = readRun(vault, 'feedback-talk', 'run-old')
  assert.equal(repaired.id, 'run-old', 'a Run with malformed feedback still loads')
  assert.deepEqual(repaired.reactions, [reactions[0], { reaction: 'helped', slideId: 'slide-1', tMs: 0 }],
    'unknown reactions, missing slides, bad times and flags, duplicate ids and non-objects are dropped; negative times clamp to 0')
  assert.deepEqual(repaired.questions, [
    { text: 'Trimmed', name: 'Lena', slideId: 'slide-1', tMs: 2, answered: false },
    { text: '<img src=x onerror=alert(1)>', slideId: 'slide-1', tMs: 3, answered: false },
    { id: 's:question-1', text: 'Why?', name: 'Priya', slideId: 'slide-3', tMs: 46000, answered: true },
  ], 'empty, over-long, badly named, badly flagged and duplicate questions are dropped; text is kept as text')
  const notArrays = normaliseRun({ ...old, reactions: { puzzled: 3 }, questions: 'Why?' })
  assert.equal('reactions' in notArrays || 'questions' in notArrays, false, 'non-array fields are dropped')
  assert.equal(listRuns(vault, 'feedback-talk').length, 1, 'History still lists the Run')
}

// Ticket 06 fix round: reactions are replaced by id like questions (a time recomputed from the Run's
// true start replaces one computed from a planned Run's midnight start); `withdrawn` is exactly true
// or absent; ids are at most 100 characters; attaching a delivery keeps what a live session flushed.
{
  const base = normaliseRun({ id: 'run-fix', talkSlug: 'fix-talk', startedAt: '2026-09-29T00:00:00.000Z' })
  let run = applyRunAudienceFeedback(base, { reactions: [{ id: 's:r1', reaction: 'helped', slideId: 's1', tMs: 50_400_000 }] })
  run = applyRunAudienceFeedback(run, { reactions: [{ id: 's:r1', reaction: 'helped', slideId: 's1', tMs: 12_000 }, { id: 's:r2', reaction: 'bookmark', slideId: 's1', tMs: 13_000 }] })
  assert.deepEqual(run.reactions.map((r) => [r.id, r.tMs]), [['s:r1', 12_000], ['s:r2', 13_000]], 'a reaction with a known id is replaced in place')
  const strict = normaliseRun({ ...base, reactions: [
    { reaction: 'helped', slideId: 's1', tMs: 1, withdrawn: 'yes' },
    { reaction: 'helped', slideId: 's1', tMs: 2, withdrawn: false },
    { reaction: 'helped', slideId: 's1', tMs: 3, withdrawn: 1 },
    { reaction: 'helped', slideId: 's1', tMs: 4, withdrawn: true },
    { reaction: 'helped', slideId: 's1', tMs: 5, id: 'r'.repeat(101) },
    { reaction: 'helped', slideId: 's1', tMs: 6, id: 'r'.repeat(100) },
    { reaction: 'helped', slideId: 's1', tMs: 7, id: 42 },
  ], questions: [
    { text: 'Too long an id', slideId: 's1', tMs: 1, id: 'q'.repeat(101) },
    { text: 'Just fits', slideId: 's1', tMs: 2, id: 'q'.repeat(100) },
  ] })
  assert.deepEqual(strict.reactions.map((r) => r.tMs), [4, 6], 'withdrawn other than true, and ids over 100 characters or not strings, drop the entry')
  assert.deepEqual(strict.questions.map((q) => q.text), ['Just fits'])
  const q = { questionId: 'question-1', text: 'Why?', slideId: 's1', tMs: 1, acceptedAt: 2, answered: false }
  assert.ok(parseAudienceQuestion(q))
  assert.ok(parseAudienceQuestion({ ...q, questionId: 'x'.repeat(100) }))
  assert.equal(parseAudienceQuestion({ ...q, questionId: 'x'.repeat(101) }), null, 'a question id over 100 characters is refused')

  // A planned Run that a live session already wrote into, then the delivery saved onto it.
  const planned = normaliseRun({ id: 'run-planned', talkSlug: 'fix-talk', status: 'planned', plannedDate: '2026-09-30',
    eventTitle: 'Seminar', slideSet: { kind: 'full' }, startedAt: '2026-09-30T00:00:00.000Z',
    polls: [{ id: 'p1', type: 'single', question: 'Choose', options: [{ optionId: 'a', label: 'A' }], visibility: 'live' }],
    pollResponses: [{ responseId: 's:1', pollId: 'p1', choice: 'a', tMs: 5, slideId: 's1' }],
    instantSlides: [{ id: 'text-1', kind: 'text', shownAt: 1, afterSlideId: 's1', text: 'Hi' }],
    reactions: [{ id: 's:r1', reaction: 'helped', slideId: 's1', tMs: 50_400_000 }],
    questions: [{ id: 's:question-1', text: 'Why?', slideId: 's1', tMs: 50_400_000, answered: true }] })
  const delivery = normaliseRun({ id: 'sess-x', talkSlug: 'fix-talk', startedAt: '2026-09-30T14:00:00.000Z', slideTimeIndex: [{ event: 'enter', slideId: 's1', tMs: 0 }] })
  const attached = attachDeliveryToPlanned(planned, delivery)
  assert.equal(attached.status, 'delivered')
  assert.equal(attached.startedAt, '2026-09-30T14:00:00.000Z')
  assert.deepEqual([attached.polls.length, attached.pollResponses.length, attached.instantSlides?.length, attached.reactions?.length, attached.questions?.length], [1, 1, 1, 1, 1],
    'polls, answers, instant slides, reactions and questions already on the planned Run are kept')
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

// ADR-0032 point 5 / boards ticket 07: a planned Run carries a start time, an optional head count and
// an optional pre-work window; old Runs re-persist byte for byte.
{
  const planRoot = mkdtempSync(join(tmpdir(), 'talkweaver-plan-'))
  const legacy = { id: 'old', talkSlug: 'plan-talk', talkTitle: 'Plan talk', kind: 'delivery', status: 'planned', plannedDate: '2026-10-06', eventTitle: 'Old plan', audience: 'X', slideSet: { kind: 'full' } }
  const legacyRun = normaliseRun(legacy)
  for (const key of ['startTime', 'expectedPeople', 'preworkOpens', 'preworkCloses']) assert.equal(key in legacyRun, false, `a Run without ${key} carries no ${key} key`)
  assert.equal(JSON.stringify(normaliseRun(JSON.parse(JSON.stringify(legacyRun)))), JSON.stringify(legacyRun), 'a Run without plan fields re-normalises byte for byte')
  const withPlan = createPlannedRun(planRoot, {
    talkSlug: 'plan-talk', talkTitle: 'Plan talk', plannedDate: '2026-10-06', eventTitle: 'ITSS Briefing, October', audience: 'IT Services staff', slideSet: { kind: 'full' },
    startTime: '10:00', expectedPeople: 22, preworkOpens: '2026-09-22T09:00'
  }, () => 'plan-1')
  assert.equal(withPlan.startTime, '10:00')
  assert.equal(withPlan.expectedPeople, 22)
  assert.equal(withPlan.preworkOpens, '2026-09-22T09:00')
  assert.equal('preworkCloses' in withPlan, false, 'closing is left unset so it follows the talk start')
  assert.deepEqual(preworkWindow(withPlan), { opens: '2026-09-22T09:00', closes: '2026-10-06T10:00' }, 'pre-work closes when the talk starts by default')
  assert.deepEqual(readRun(planRoot, 'plan-talk', 'plan-1'), withPlan, 'the plan fields survive a read from disk')
  assert.equal(preworkWindow(legacyRun), null, 'a Run without pre-work has no window')

  // Whitelisting: garbage is dropped by the normaliser, refused by the writers.
  const junk = normaliseRun({ ...legacy, startTime: '25:99', expectedPeople: -3, preworkOpens: 'tomorrow', preworkCloses: '2026-10-06T09:00' })
  for (const key of ['startTime', 'expectedPeople', 'preworkOpens', 'preworkCloses']) assert.equal(key in junk, false, `unreadable ${key} is dropped`)
  assert.throws(() => createPlannedRun(planRoot, { ...baseInput, expectedPeople: '12' }, () => 'bad-s1'), /expected-people-invalid/, 'a string head count is refused, not coerced')
  assert.throws(() => createPlannedRun(planRoot, { ...baseInput, expectedPeople: '1e1' }, () => 'bad-s2'), /expected-people-invalid/)
  assert.equal('expectedPeople' in normaliseRun({ ...legacy, expectedPeople: '12' }), false, 'the normaliser drops a string head count')
  assert.equal('expectedPeople' in normaliseRun({ ...legacy, expectedPeople: '1e1' }), false)
  assert.equal('preworkOpens' in normaliseRun({ ...legacy, preworkOpens: '2026-02-31T09:00' }), false, 'an impossible date is dropped')
  assert.throws(() => createPlannedRun(planRoot, { ...baseInput, preworkOpens: '2026-02-31T09:00' }, () => 'bad-d1'), /prework-opens-invalid/, 'an impossible date is refused')
  assert.throws(() => createPlannedRun(planRoot, { ...baseInput, preworkCloses: '2026-07-21T09:00' }, () => 'bad-c1'), /prework-closes-without-opens/, 'a closing time without an opening is refused')
  assert.throws(() => createPlannedRun(planRoot, { ...baseInput, startTime: '9am' }, () => 'bad-1'), /start-time-invalid/)
  assert.throws(() => createPlannedRun(planRoot, { ...baseInput, expectedPeople: 0.5 }, () => 'bad-2'), /expected-people-invalid/)
  assert.throws(() => createPlannedRun(planRoot, { ...baseInput, preworkOpens: 'soon' }, () => 'bad-3'), /prework-opens-invalid/)
  assert.throws(() => createPlannedRun(planRoot, { ...baseInput, startTime: '10:00', preworkOpens: '2026-07-22T10:00' }, () => 'bad-4'), /prework-closes-before-opens/, 'pre-work cannot close before it opens')

  // Editing: set a closing time, change the count, then clear pre-work with null.
  const edited = updatePlannedRun(planRoot, 'plan-talk', 'plan-1', { preworkCloses: '2026-10-05T18:00', expectedPeople: 30 })
  assert.deepEqual(preworkWindow(edited), { opens: '2026-09-22T09:00', closes: '2026-10-05T18:00' })
  assert.equal(edited.expectedPeople, 30)
  const cleared = updatePlannedRun(planRoot, 'plan-talk', 'plan-1', { preworkOpens: null, expectedPeople: null })
  assert.equal(preworkWindow(cleared), null)
  assert.equal('preworkOpens' in cleared, false)
  assert.equal('preworkCloses' in cleared, false, 'a closing time without an opening is dropped')
  assert.equal('expectedPeople' in cleared, false)
  assert.equal(cleared.startTime, '10:00', 'fields the patch does not name are kept')
  assert.throws(() => updatePlannedRun(planRoot, 'plan-talk', 'plan-1', { preworkCloses: '2026-10-05T18:00' }), /prework-closes-without-opens/, 'naming a closing time with no opening is refused')

  // Delivering against a planned Run keeps the plan.
  const attachedPlan = attachDeliveryToPlanned(withPlan, normaliseRun({ id: 'delivery', talkSlug: 'plan-talk', talkTitle: 'Plan talk', kind: 'delivery', startedAt: '2026-10-06T10:02:00.000Z', endedAt: '2026-10-06T11:00:00.000Z' }))
  assert.equal(attachedPlan.status, 'delivered')
  assert.equal(attachedPlan.preworkOpens, '2026-09-22T09:00')
  assert.equal(attachedPlan.expectedPeople, 22)
}

// The planned-Run writers take renderer-supplied names: none may reach a path outside _PRESENTATIONS.
{
  const boundary = mkdtempSync(join(tmpdir(), 'talkweaver-plan-boundary-'))
  const vaultB = join(boundary, 'vault')
  _mkdirSync(join(vaultB, '_PRESENTATIONS', 'real-talk'), { recursive: true })
  const outsideDir = join(boundary, 'outside')
  _mkdirSync(outsideDir)
  const okInput = { talkSlug: 'real-talk', talkTitle: 'Real', plannedDate: '2026-10-06', eventTitle: 'E', audience: '', slideSet: { kind: 'full' } }
  for (const talkSlug of ['../../escape', '..', '/etc', join(outsideDir, 'abs'), 'a/b', '', ' spaced ']) {
    assert.throws(() => createPlannedRun(vaultB, { ...okInput, talkSlug }, () => 'r1'), /run-path-unsafe/, `create refuses talkSlug ${JSON.stringify(talkSlug)}`)
    assert.throws(() => updatePlannedRun(vaultB, talkSlug, 'r1', { eventTitle: 'x' }), /run-path-unsafe/, `update refuses talkSlug ${JSON.stringify(talkSlug)}`)
    assert.throws(() => deletePlannedRun(vaultB, talkSlug, 'r1'), /run-path-unsafe/, `delete refuses talkSlug ${JSON.stringify(talkSlug)}`)
  }
  for (const runId of ['../x', '../../escape', '/tmp/x', 'a/b', '.', '']) {
    assert.throws(() => createPlannedRun(vaultB, okInput, () => runId), /run-path-unsafe|run-id-collision/, `create refuses runId ${JSON.stringify(runId)}`)
    assert.throws(() => updatePlannedRun(vaultB, 'real-talk', runId, { eventTitle: 'x' }), /run-path-unsafe/, `update refuses runId ${JSON.stringify(runId)}`)
    assert.throws(() => deletePlannedRun(vaultB, 'real-talk', runId), /run-path-unsafe/, `delete refuses runId ${JSON.stringify(runId)}`)
  }
  assert.deepEqual(readdirSync(outsideDir), [], 'nothing was written outside')
  assert.deepEqual(readdirSync(boundary).sort(), ['outside', 'vault'])
  // A symlinked talk folder that leaves the vault is refused too.
  symlinkSync(outsideDir, join(vaultB, '_PRESENTATIONS', 'linked-talk'))
  assert.throws(() => createPlannedRun(vaultB, { ...okInput, talkSlug: 'linked-talk' }, () => 'r2'), /run-path-unsafe/, 'a symlinked talk folder is refused')
  assert.deepEqual(readdirSync(outsideDir), [], 'nothing was written through the symlink')
  // The safe path still works.
  assert.equal(createPlannedRun(vaultB, okInput, () => 'r3').id, 'r3')
}

// Feedback-boards ticket 06: the board on the Run — merged by id, validated on read, old Runs
// byte-stable; hidden cards kept on the Run and never in Markdown or on the share link.
{
  const boardsRoot = mkdtempSync(join(tmpdir(), 'talkweaver-run-boards-'))
  const ended = Date.UTC(2026, 8, 28, 14, 2)
  const board = (cards, extra = {}) => ({
    id: 'poll-board', slideId: 'slide-44', question: 'What should we keep, change, try?',
    columns: [{ id: 'keep', label: 'Keep' }, { id: 'change', label: 'Change' }, { id: 'try', label: 'Try' }],
    cards, groups: [{ n: 1, column: 'keep', cardIds: ['card-1', 'card-2', 'card-3'] }], sessionId: 'session-a', liveEndedAt: ended, ...extra,
  })
  const liveCards = [
    { id: 'card-1', column: 'keep', text: 'More time for hands-on', acceptedAt: ended - 50_000, group: 1 },
    { id: 'card-2', column: 'keep', text: 'More hands-on, less talk', acceptedAt: ended - 40_000, group: 1 },
    { id: 'card-3', column: 'keep', text: 'Hands-on please', acceptedAt: ended - 30_000, group: 1 },
    { id: 'card-4', column: 'change', text: 'Shorter breaks', acceptedAt: ended - 20_000 },
    { id: 'card-5', column: 'change', text: 'Does anyone know the wifi password?', acceptedAt: ended - 10_000, hidden: true },
    { id: 'card-6', column: 'try', text: 'Pair work', acceptedAt: ended - 5_000, name: 'Sam' },
  ]
  const legacy = normaliseRun({ id: 'run-b', talkSlug: 'boards-talk', talkTitle: 'The current state of AI agents', kind: 'delivery', status: 'delivered',
    eventTitle: 'ITSS Briefing', audience: 'Oxford', startedAt: '2026-09-28T13:00:00.000Z', endedAt: '2026-09-28T14:02:00.000Z' })
  assert.equal('boards' in legacy, false, 'a Run without a board carries no boards key')
  assert.equal(JSON.stringify(normaliseRun(JSON.parse(JSON.stringify(legacy)))), JSON.stringify(legacy), 'an old Run re-normalises byte for byte')
  assert.equal(applyRunBoards(legacy, []), legacy, 'no boards: the same Run, nothing to write')

  const withBoard = applyRunBoards(legacy, [board(liveCards)])
  persistRun(boardsRoot, withBoard)
  const read = readRun(boardsRoot, 'boards-talk', 'run-b')
  assert.deepEqual(read.boards, withBoard.boards, 'the board survives a write and a read')
  assert.equal(read.boards[0].cards.length, 6, 'every card is kept, hidden ones included')
  assert.equal(read.boards[0].cards.find((card) => card.id === 'card-5').hidden, true)
  assert.equal(applyRunBoards(withBoard, [board(liveCards)]), withBoard, 'the same board again changes nothing')

  // Validation on read: a Run file is JSON anyone can edit.
  const messy = normaliseRun({ ...withBoard, boards: [
    board([...liveCards, { id: 'card-9', column: 'nowhere', text: 'x', acceptedAt: ended }, { id: 'card-4', column: 'keep', text: 'dup', acceptedAt: ended },
      { id: 'card-10', column: 'keep', text: '', acceptedAt: ended }, { id: 'card-11', column: 'keep', text: 'x', acceptedAt: 'soon' },
      { id: 'card-12', column: 'keep', text: 'y', acceptedAt: ended, hidden: 'yes' }]),
    { id: 'poll-broken', question: 'Q', columns: [], cards: [], groups: [] },
    board([], { id: 'poll-board' }),
    { ...board([{ id: 'card-1', column: 'keep', text: 'Lonely', acceptedAt: ended, group: 7 }]), id: 'poll-other', groups: [{ n: 3, column: 'keep', cardIds: ['ghost'] }] },
  ] })
  assert.deepEqual(messy.boards.map((b) => b.id), ['poll-board', 'poll-other'], 'unreadable and duplicate boards are dropped')
  assert.deepEqual(messy.boards[0].cards.map((card) => card.id), liveCards.map((card) => card.id), 'unreadable and duplicate cards are dropped; the rest are kept')
  assert.equal(messy.boards[1].groups.length, 0, 'a group naming no card on the board is dropped')
  assert.equal('group' in messy.boards[1].cards[0], false, 'a card whose group is gone is a single')

  // Merge by id: a fresh copy is the whole board (a withdrawn card is gone, a hide lands); Put back and
  // the times it does not name are kept; other boards are kept.
  const putBack = { ...withBoard, boards: [setRunBoardCardPutBack(withBoard.boards[0], 'card-5', true)] }
  assert.equal(isHiddenCard(putBack.boards[0].cards.find((card) => card.id === 'card-5')), false, 'a card put back is shown')
  assert.throws(() => setRunBoardCardPutBack(withBoard.boards[0], 'card-4', true), /card-not-hidden/, 'only a hidden card can be put back')
  const late = { id: 'card-7', column: 'change', text: 'Recording of the demo, please', acceptedAt: ended + 3_600_000 }
  const fresh = board([...liveCards.filter((card) => card.id !== 'card-6'), late], { liveEndedAt: undefined, openUntil: ended + 7 * 86_400_000, refreshedAt: ended + 3_700_000 })
  const merged = applyRunBoards({ ...putBack, boards: [...putBack.boards, board([], { id: 'poll-second' })] }, [fresh])
  const mergedBoard = merged.boards.find((b) => b.id === 'poll-board')
  assert.deepEqual(mergedBoard.cards.map((card) => card.id), ['card-1', 'card-2', 'card-3', 'card-4', 'card-5', 'card-7'], 'the withdrawn card is gone, the late card is in')
  assert.equal(mergedBoard.cards.find((card) => card.id === 'card-5').putBack, true, 'Put back survives a refresh')
  assert.equal(mergedBoard.liveEndedAt, ended, 'the end time the fresh copy does not name is kept')
  assert.equal(mergedBoard.openUntil, ended + 7 * 86_400_000)
  assert.deepEqual(merged.boards.map((b) => b.id), ['poll-board', 'poll-second'], 'a board the fresh list does not name is kept')
  assert.equal(runBoardState(mergedBoard, ended + 3_800_000), 'open')
  assert.equal(runBoardState(mergedBoard, ended + 8 * 86_400_000), 'closed', 'past its time the board reads as closed')
  assert.equal(runBoardState({ ...mergedBoard, closedAt: ended + 4_000_000 }, ended + 4_100_000), 'closed')

  // The Run card's view: groups first with their counts, singles newest first, hidden cards apart, late cards marked.
  const view = runBoardView(board([...liveCards, late]))
  assert.deepEqual(view.columns.map((column) => [column.label, column.count]), [['Keep', 3], ['Change', 2], ['Try', 1]], 'hidden cards are not counted')
  assert.deepEqual(view.columns[0].entries, [{ kind: 'group', n: 1, text: 'More time for hands-on', count: 3, cardIds: ['card-1', 'card-2', 'card-3'], late: false }])
  assert.deepEqual(view.columns[1].entries.map((entry) => [entry.text, entry.late]), [['Recording of the demo, please', true], ['Shorter breaks', false]])
  assert.deepEqual(view.hidden.map((card) => [card.id, card.columnLabel]), [['card-5', 'Change']])
  assert.equal(view.lateCount, 1)

  // Copy as Markdown (R5): numbers and counts kept, hidden cards and names left out, markup made harmless.
  const markdown = runBoardMarkdown(board([...liveCards, { id: 'card-8', column: 'try', text: 'Try <b>this</b>\n## now', acceptedAt: ended - 1 }]),
    { talkTitle: 'The current state of AI agents', event: 'ITSS Briefing', date: '28 Sep 2026' })
  assert.equal(markdown, [
    '## What should we keep, change, try?',
    'The current state of AI agents · ITSS Briefing · 28 Sep 2026 · 6 cards',
    '', '### Keep (3)', '1. More time for hands-on (×3)',
    '', '### Change (1)', '- Shorter breaks',
    '', '### Try (2)', '- Try &lt;b&gt;this&lt;/b&gt; ## now', '- Pair work', '',
  ].join('\n'))
  assert.equal(markdown.includes('wifi'), false, 'a hidden card is not copied')
  assert.equal(markdown.includes('Sam'), false, 'a name is not copied')

  // Feedback-boards ticket 05 (D13): a group's own wording is kept on the Run — from the live poll,
  // through a write and a read, replaced by a fresh copy (merged by the same key), shown and copied in
  // place of the first card's text; an unreadable wording is dropped and the group kept.
  {
    const worded = board(liveCards, { groups: [{ n: 1, column: 'keep', cardIds: ['card-1', 'card-2', 'card-3'], label: 'Hands-on time' }] })
    const fromLive = runBoardFromPollState({ type: 'poll.state', pollId: 'poll-board', slideId: 'slide-44', pollType: 'board', question: 'What should we keep, change, try?',
      options: [{ optionId: 'keep', label: 'Keep' }], visibility: 'live', open: true, revealed: false, board: { limit: 24, cardChars: 140, cardsPerPhone: 5, names: false, closesAfterDays: 7 },
      boardState: { frozen: false, limit: 24, release: { extra: 0, all: false, groupsOnly: false, columns: {} }, entries: 1, shown: 1, waiting: 0, cardCount: 2,
        cards: [{ cardId: 'card-1', column: 'keep', text: 'One', acceptedAt: 1, group: 1 }, { cardId: 'card-2', column: 'keep', text: 'Two', acceptedAt: 2, group: 1 }],
        groups: [{ n: 1, column: 'keep', cardIds: ['card-1', 'card-2'], count: 2, label: 'Both' }], columns: [{ columnId: 'keep', onScreen: [{ group: 1 }], waiting: 0, cards: 2 }] } })
    assert.equal(fromLive.groups[0].label, 'Both', 'the live group\'s wording comes onto the Run')
    const wordedRun = applyRunBoards(legacy, [worded])
    persistRun(boardsRoot, wordedRun)
    const reread = readRun(boardsRoot, 'boards-talk', 'run-b')
    assert.equal(reread.boards[0].groups[0].label, 'Hands-on time', 'the wording survives a write and a read')
    assert.equal(runBoardView(reread.boards[0]).columns[0].entries[0].text, 'Hands-on time', 'the Run card shows the wording')
    assert.match(runBoardMarkdown(reread.boards[0], { talkTitle: 'T' }), /1\. Hands-on time \(×3\)/, 'Copy as Markdown uses the wording')
    const cleared = applyRunBoards(reread, [board(liveCards)])
    assert.equal('label' in cleared.boards[0].groups[0], false, 'a fresh copy without a wording replaces it (merged by the same key)')
    const junk = normaliseRun({ ...wordedRun, boards: [board(liveCards, { groups: [{ n: 1, column: 'keep', cardIds: ['card-1'], label: 7 }] })] })
    assert.deepEqual(junk.boards[0].groups, [{ n: 1, column: 'keep', cardIds: ['card-1'] }], 'an unreadable wording is dropped, the group kept')
    persistRun(boardsRoot, withBoard)
  }

  // The share link's push: no hidden card, no name; the Worker's own parser accepts it.
  const run = { ...withBoard, polls: [{ id: 'poll-1', type: 'single', question: 'Which tool?', options: [{ optionId: 'a', label: 'ChatGPT' }, { optionId: 'b', label: 'Claude' }], visibility: 'live' },
    { id: 'poll-open', type: 'open', question: 'Hopes?', options: [], visibility: 'live' }],
  pollResponses: [{ pollId: 'poll-1', choice: 'a', tMs: 1, slideId: 's' }, { pollId: 'poll-1', choice: 'b', tMs: 2, slideId: 's' }, { pollId: 'poll-open', text: 'secret hope', tMs: 3, slideId: 's' }] }
  const now = ended + 86_400_000
  const payload = runSharePayload(run, { board: true, polls: true, prework: false }, now + 30 * 86_400_000, now)
  const text = JSON.stringify(payload)
  for (const absent of ['wifi', 'Sam', 'secret hope', 'hidden', 'name']) assert.equal(text.includes(absent), false, `the push never carries ${absent}`)
  assert.deepEqual(payload.polls, [{ kind: 'bars', question: 'Which tool?', people: 2, rows: [{ label: 'ChatGPT', count: 1 }, { label: 'Claude', count: 1 }] }], 'open answers are not shared')
  assert.equal(payload.boards[0].state, 'final')
  assert.ok('value' in parseRunSharePush(payload, now), 'the Worker accepts the app\'s push')
  const withPutBack = runSharePayload({ ...run, boards: putBack.boards }, { board: true, polls: false, prework: false }, null, now)
  assert.ok(JSON.stringify(withPutBack).includes('wifi'), 'a card put back is on the link')
  assert.deepEqual(runSharePayload(run, { board: false, polls: true, prework: false }, null, now).boards, [], 'the board can be left off')

  // A planned Run that took board flushes keeps them when the delivery is attached.
  const plannedWithBoard = normaliseRun({ ...legacy, id: 'planned-b', status: 'planned', plannedDate: '2026-09-28', eventTitle: 'ITSS Briefing', boards: [board(liveCards)] })
  const attachedBoard = attachDeliveryToPlanned(plannedWithBoard, normaliseRun({ id: 'delivery-b', talkSlug: 'boards-talk', talkTitle: 'T', kind: 'delivery', startedAt: '2026-09-28T13:00:00.000Z' }))
  assert.equal(attachedBoard.boards?.[0].cards.length, 6, 'the planned Run\'s board is kept on the delivered Run')
}

// Boards fix round, item 1: a board's identity on the Run is its poll AND its live session. A second
// Go live in the same recording shows the same authored board again; both copies are kept, and a
// fresh copy from one session replaces only its own.
{
  const t0 = Date.UTC(2026, 8, 28, 13, 0)
  const cols = [{ id: 'keep', label: 'Keep' }, { id: 'try', label: 'Try' }]
  const sessionBoard = (sessionId, texts, extra = {}) => ({ id: 'poll-board', question: 'Keep, try?', columns: cols, groups: [], sessionId,
    cards: texts.map((text, i) => ({ id: `card-${i + 1}`, column: 'keep', text, acceptedAt: t0 + i })), ...extra })
  const base = normaliseRun({ id: 'run-two', talkSlug: 'two-sessions', startedAt: new Date(t0).toISOString() })
  const first = applyRunBoards(base, [sessionBoard('session-1', ['First A', 'First B'], { liveStartedAt: t0 })])
  const both = applyRunBoards(first, [sessionBoard('session-2', [], { liveStartedAt: t0 + 3_600_000 })])
  assert.deepEqual(both.boards.map((b) => [b.sessionId, b.cards.length]), [['session-1', 2], ['session-2', 0]], 'the second session\'s empty board does not replace the first')
  const refreshedSecond = applyRunBoards(both, [sessionBoard('session-2', ['Second A'])])
  assert.deepEqual(refreshedSecond.boards.map((b) => [b.sessionId, b.cards.map((c) => c.text)]), [['session-1', ['First A', 'First B']], ['session-2', ['Second A']]])
  const refreshedFirst = applyRunBoards(refreshedSecond, [sessionBoard('session-1', ['First A', 'First B', 'First late'])])
  assert.deepEqual(refreshedFirst.boards.map((b) => b.cards.length), [3, 1], 'a refresh from either session replaces only its own board')
  assert.equal(refreshedFirst.boards[1].liveStartedAt, t0 + 3_600_000, 'times the copy does not name are kept')
  // A board with no session keeps its own key: a fresh copy of the same poll is appended, never over it.
  const legacyBoard = normaliseRun({ ...base, boards: [{ ...sessionBoard(undefined, ['Old']), sessionId: undefined, liveEndedAt: t0 }] })
  assert.equal(legacyBoard.boards[0].sessionId, undefined, 'an old board with no session still loads')
  const kept = applyRunBoards(legacyBoard, [sessionBoard('session-9', ['New'])])
  assert.deepEqual(kept.boards.map((b) => [b.sessionId, b.cards.map((c) => c.text)]), [[undefined, ['Old']], ['session-9', ['New']]],
    'the unnamed board and the fresh copy of the same poll are both kept')
  const duplicates = normaliseRun({ ...base, boards: [sessionBoard('session-1', ['A']), sessionBoard('session-1', ['B']), sessionBoard('session-2', ['C'])] })
  assert.deepEqual(duplicates.boards.map((b) => b.cards[0].text), ['A', 'C'], 'the same poll and session twice in a file keeps the first')
}

// Boards fix round, item 2: a share link that could not be pushed after the Run changed is reported,
// never swallowed; Put back returns it as a warning.
{
  const shareRoot = mkdtempSync(join(tmpdir(), 'talkweaver-share-fail-'))
  let fail = false
  const fakeFetch = async (url, init = {}) => {
    if (String(url).endsWith('/results') && init.method === 'POST') return new Response(JSON.stringify({ shareId: 'abcd2345', ownerToken: 'owner-token-0123456789' }), { status: 201 })
    if (fail) throw new Error('offline')
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const shares = createRunResultsShares({ registryPath: join(shareRoot, 'registry.json'), endpoint: async () => ({ baseUrl: 'https://live.example.test', adminSecret: 'admin' }),
    linkBase: () => null, fetch: fakeFetch })
  const ended = Date.UTC(2026, 8, 28, 14)
  const run = normaliseRun({ id: 'run-share', talkSlug: 'share-talk', talkTitle: 'T', startedAt: new Date(ended - 3_600_000).toISOString(),
    boards: [{ id: 'poll-board', sessionId: 's-1', question: 'Q', columns: [{ id: 'keep', label: 'Keep' }], groups: [], liveEndedAt: ended,
      cards: [{ id: 'card-1', column: 'keep', text: 'Shown', acceptedAt: ended - 5 }, { id: 'card-2', column: 'keep', text: 'Hidden', acceptedAt: ended - 4, hidden: true }] }] })
  const vault = join(shareRoot, 'vault')
  _mkdirSync(vault, { recursive: true })
  persistRunForTalk(vault, 'share-talk', 'run-share', run)
  await shares.share('share-talk', 'run-share', run, { lifetime: '7', include: { board: true, polls: false } })
  assert.deepEqual((await shares.refresh('share-talk', 'run-share', run)).ok, true)
  fail = true
  assert.deepEqual(await shares.refresh('share-talk', 'run-share', run), { ok: false, error: 'offline' }, 'a failed push is returned, not swallowed')
  const handlers = new Map()
  registerRunBoardIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, vaultRoot: () => vault, sessions: () => null, shares })
  const putBack = await handlers.get('history:board-put-back')(null, { talkSlug: 'share-talk', runId: 'run-share', boardId: 'poll-board', sessionId: 's-1', cardId: 'card-2', putBack: true })
  assert.equal(putBack.ok, true, 'the card is put back on the Run')
  assert.equal(putBack.warning, LINK_NOT_UPDATED, 'and History is told the link may still show the old board')
  assert.equal(putBack.run.boards[0].cards[1].putBack, true)
  const wrongSession = await handlers.get('history:board-put-back')(null, { talkSlug: 'share-talk', runId: 'run-share', boardId: 'poll-board', sessionId: 's-2', cardId: 'card-2', putBack: true })
  assert.equal(wrongSession.ok, false, 'Put back names the board by its poll and session')
  fail = false
  const ok = await handlers.get('history:board-put-back')(null, { talkSlug: 'share-talk', runId: 'run-share', boardId: 'poll-board', sessionId: 's-1', cardId: 'card-2', putBack: false })
  assert.equal(ok.ok, true)
  assert.equal('warning' in ok, false, 'no warning when the link was updated')
}

// Feedback-boards ticket 09: pre-work answers mirrored onto the Run — merged by id, validated on
// read (hostile entries dropped, the rest kept), old Runs byte-stable; the public form never carries
// the right answer; the service pulls through the atomic Run writer and moves its cursor only after.
{
  const P1 = 'a1b2c3d4e5f60718', P2 = '0f1e2d3c4b5a6978'
  const at = Date.UTC(2026, 9, 1, 9)
  const entry = (participant, kind, stepId, extra = {}, seq = 1) => ({
    id: kind === 'question' ? `${participant}:q:${extra.sub ?? 's1'}` : `${participant}:${kind}:${stepId}`,
    seq, participant, stepId, kind, at, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'sub')),
  })
  const planned = normaliseRun({ id: 'run-pw', talkSlug: 'pw-talk', talkTitle: 'T', kind: 'delivery', status: 'planned', plannedDate: '2026-10-06',
    eventTitle: 'ITSS Briefing', startTime: '10:00', preworkOpens: '2026-09-30T09:00', slideSet: { kind: 'full' }, startedAt: '2026-10-06T00:00:00.000Z' })
  assert.equal('prework' in planned, false, 'a Run without pre-work carries no prework key')
  assert.equal(JSON.stringify(normaliseRun(JSON.parse(JSON.stringify(planned)))), JSON.stringify(planned), 'an old Run re-normalises byte for byte')
  assert.equal(applyRunPrework(planned, []), planned, 'nothing pulled and nothing known: the same Run, nothing to write')

  const first = applyRunPrework(planned, [
    entry(P1, 'read', 'pwwelcome'),
    entry(P1, 'answer', 'pwquiz', { choice: 'poll-pwquiz-option-2' }, 2),
    entry(P2, 'answer', 'pwhope', { text: '<b>save time</b>' }, 3),
    entry(P1, 'question', 'pwtask1', { text: 'Which email?', sub: 's9' }, 4),
    entry(P1, 'done', 'pwtask1', { done: true }, 5),
  ], { people: 2, lastActivityAt: at })
  assert.equal(first.prework.entries.length, 5)
  assert.equal(first.prework.people, 2)
  assert.equal('seq' in first.prework.entries[0], false, 'the Worker\'s sequence is not kept on the Run')
  assert.equal(first.prework.entries[2].text, '<b>save time</b>', 'text is kept as text (escaped wherever it is shown)')

  // Merge by id: a changed answer replaces, History's "answered" survives, nothing is removed.
  const marked = { ...first, prework: { ...first.prework, entries: first.prework.entries.map((item) => item.kind === 'question' ? { ...item, answered: true } : item) } }
  const second = applyRunPrework(normaliseRun(marked), [
    entry(P1, 'answer', 'pwquiz', { choice: 'poll-pwquiz-option-1' }, 6),
    entry(P1, 'question', 'pwtask1', { text: 'Which email?', sub: 's9' }, 4),
    entry(P1, 'done', 'pwtask1', { done: false }, 7),
  ], { people: 2 })
  assert.equal(second.prework.entries.length, 5, 'merged by id: no duplicates')
  assert.equal(second.prework.entries.find((item) => item.kind === 'answer' && item.stepId === 'pwquiz').choice, 'poll-pwquiz-option-1', 'the latest answer wins')
  assert.equal(second.prework.entries.find((item) => item.kind === 'done').done, false, 'Tap to untick reaches the Run')
  assert.equal(second.prework.entries.find((item) => item.kind === 'question').answered, true, 'History\'s Mark answered survives a pull')
  assert.deepEqual(second.prework.entries.map((item) => item.id), first.prework.entries.map((item) => item.id), 'entries keep their place')
  const again = applyRunPrework(second, [entry(P1, 'done', 'pwtask1', { done: false }, 7)], { people: 2 })
  assert.equal(again, second, 'an unchanged pull is the same Run: nothing is written')

  // Hostile input: from the Worker or edited into the Run file, bad entries are dropped, the rest kept.
  const hostile = [
    entry(P1, 'answer', 'pwhope', { text: 'x'.repeat(1001) }),
    { ...entry(P1, 'read', 'pwwelcome'), id: `${P2}:read:pwwelcome` },
    { ...entry(P1, 'read', 'pwwelcome'), participant: 'Sam Smith' },
    entry(P1, 'answer', 'pwquiz', { choice: 'a', text: 'b' }),
    { ...entry(P1, 'read', 'pwother'), kind: 'vote' },
    entry(P1, 'done', 'pwtask2', { done: 'yes' }),
    { ...entry(P2, 'read', '../../etc'), stepId: '../../etc' },
    entry(P2, 'question', 'pwquiz', { text: 'Name too long', name: 'n'.repeat(61), sub: 's2' }),
    null, 'text', [],
  ]
  assert.equal(applyRunPrework(second, hostile), second, 'hostile entries from the Worker are dropped')
  const edited = normaliseRun({ ...JSON.parse(JSON.stringify(second)), prework: { entries: [...hostile, ...second.prework.entries, second.prework.entries[0]], people: -3, closedAt: 'soon' } })
  assert.deepEqual(edited.prework.entries, second.prework.entries, 'a hand-edited Run keeps its good entries and drops the rest (and duplicates)')
  assert.equal('people' in edited.prework, false)
  assert.equal(normaliseRun({ ...planned, prework: { entries: 'no' } }).prework, undefined, 'unreadable pre-work is dropped, the Run is kept')

  // Written and read back through the atomic writer; kept when the delivery is attached to the plan.
  const root = mkdtempSync(join(tmpdir(), 'talkweaver-run-prework-'))
  _mkdirSync(join(root, '_PRESENTATIONS', 'pw-talk'), { recursive: true })
  persistRunForTalk(root, 'pw-talk', 'run-pw', second)
  assert.deepEqual(readRunForTalk(root, 'pw-talk', 'run-pw').prework, second.prework, 'the pre-work survives a write and a read')
  const delivered = attachDeliveryToPlanned(second, normaliseRun({ id: 'rec-1', talkSlug: 'pw-talk', talkTitle: 'T', startedAt: '2026-10-06T09:00:00.000Z', endedAt: '2026-10-06T10:00:00.000Z' }))
  assert.deepEqual(delivered.prework, second.prework, 'the pre-work belongs to the Run once it is delivered, History\'s marks included')

  // The public form: built field by field, never the right answer.
  const compiledPrework = { sectionId: 'pwform', title: 'Before the session', intro: 'Intro.', slideIds: ['pwform', 'pwwelcome', 'pwquiz', 'pwtools', 'pwtask1', 'pwboard'], steps: [
    { n: 1, id: 'pwwelcome', title: 'Welcome', kind: 'slide', questions: false, sourceLine: 20 },
    { n: 2, id: 'pwquiz', title: 'Quick check', kind: 'check', questions: true, pollType: 'single', options: ['A', 'B'], right: { index: 1, label: 'B' }, sourceLine: 24 },
    { n: 3, id: 'pwtools', title: 'Tools', kind: 'question', questions: true, pollType: 'multiple' },
    { n: 4, id: 'pwtask1', title: 'Task', kind: 'task', questions: true, done: true, minutes: 20 },
    { n: 5, id: 'pwboard', title: 'Ideas', kind: 'question', questions: true, pollType: 'board' },
  ] }
  const slides = [
    { id: 'pwquiz', poll: { pollId: 'poll-pwquiz', type: 'single', question: 'Quick check', visibility: 'live', right: 'B',
      options: [{ optionId: 'poll-pwquiz-option-1', label: 'A' }, { optionId: 'poll-pwquiz-option-2', label: 'B', right: true }] } },
    { id: 'pwtools', poll: { pollId: 'poll-pwtools', type: 'multiple', question: 'Tools', visibility: 'live', options: [{ optionId: 't1', label: 'ChatGPT' }] } },
    { id: 'pwboard', poll: { pollId: 'poll-pwboard', type: 'board', question: 'Ideas', visibility: 'live', options: [{ optionId: 'c1', label: 'Keep' }], board: {} } },
  ]
  const form = publicPreworkForm(compiledPrework, slides)
  assert.deepEqual(form.steps.map((step) => [step.id, step.kind]), [['pwwelcome', 'slide'], ['pwquiz', 'check'], ['pwtools', 'question'], ['pwtask1', 'task'], ['pwboard', 'slide']],
    'every step, in order; a board step is sent as a slide participants read')
  assert.equal(/right/i.test(JSON.stringify(form)), false, 'the form carries no right answer, wherever the source had one')
  assert.equal(/sourceLine|pollId|visibility/.test(JSON.stringify(form)), false, 'nothing but what participants need')
  assert.deepEqual(form.steps[1].poll.options.map((option) => option.label), ['A', 'B'])
  assert.equal(publicPreworkForm(null, slides), null)
  assert.equal(publicPreworkForm({ steps: [] }, []), null, 'a form with no steps is not sent')

  // The window: the Run's local times, closing at the talk's start by default.
  const opens = new Date(2026, 8, 30, 9, 0).getTime(), closes = new Date(2026, 9, 6, 10, 0).getTime()
  assert.deepEqual(preworkWindowMs(preworkWindow(planned)), { opensAt: opens, closesAt: closes })
  assert.equal(preworkWindowMs(null), null)
  assert.equal(preworkWindowMs({ opens: '2026-10-06T10:00', closes: '2026-10-06T09:00' }), null)
  assert.equal(mergeRunPrework(null, []), null)

  // Time zone (fix round): the zone the times were entered in is kept with them and used.
  const zoned = { opens: '2026-10-01T09:00', closes: '2026-10-06T10:00' }
  assert.deepEqual(preworkWindowMs(zoned, 'Europe/London'), { opensAt: Date.UTC(2026, 9, 1, 8), closesAt: Date.UTC(2026, 9, 6, 9) })
  assert.deepEqual(preworkWindowMs(zoned, 'America/New_York'), { opensAt: Date.UTC(2026, 9, 1, 13), closesAt: Date.UTC(2026, 9, 6, 14) })
  assert.deepEqual(preworkWindowMs(zoned), { opensAt: new Date(2026, 9, 1, 9).getTime(), closesAt: new Date(2026, 9, 6, 10).getTime() }, 'no zone: the machine\'s own')
  assert.equal(preworkWindowMs({ opens: '2026-10-25T01:30', closes: '2026-10-25T03:00' }, 'Europe/London').opensAt, Date.UTC(2026, 9, 25, 0, 30), 'a repeated hour reads as the first')
  const zRoot = mkdtempSync(join(tmpdir(), 'talkweaver-run-zone-'))
  const zoneRun = createPlannedRun(zRoot, { talkSlug: 'z-talk', talkTitle: 'Z', plannedDate: '2026-10-06', eventTitle: 'E', audience: '', slideSet: { kind: 'full' },
    startTime: '10:00', preworkOpens: '2026-10-01T09:00', timeZone: 'America/New_York' }, () => 'run-z')
  assert.equal(zoneRun.timeZone, 'America/New_York', 'the zone sent with the times is kept')
  const machineRun = createPlannedRun(zRoot, { talkSlug: 'z-talk', talkTitle: 'Z', plannedDate: '2026-10-06', eventTitle: 'E', audience: '', slideSet: { kind: 'full' },
    startTime: '10:00', preworkOpens: '2026-10-01T09:00' }, () => 'run-m')
  assert.equal(machineRun.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone, 'else this machine\'s')
  assert.throws(() => createPlannedRun(zRoot, { talkSlug: 'z-talk', talkTitle: 'Z', plannedDate: '2026-10-06', eventTitle: 'E', audience: '', slideSet: { kind: 'full' },
    preworkOpens: '2026-10-01T09:00', timeZone: 'Mars/Olympus' }, () => 'run-x'), /time-zone-invalid/)
  const noPrework = createPlannedRun(zRoot, { talkSlug: 'z-talk', talkTitle: 'Z', plannedDate: '2026-10-06', eventTitle: 'E', audience: '', slideSet: { kind: 'full' } }, () => 'run-n')
  assert.equal('timeZone' in noPrework, false, 'no pre-work, no zone')
  assert.equal(updatePlannedRun(zRoot, 'z-talk', 'run-z', { preworkOpens: '2026-10-02T09:00', timeZone: 'Europe/London' }).timeZone, 'Europe/London', 'new times, the zone they were entered in')
  assert.equal(updatePlannedRun(zRoot, 'z-talk', 'run-z', { eventTitle: 'F' }).timeZone, 'Europe/London', 'other edits keep it')
  assert.equal('timeZone' in updatePlannedRun(zRoot, 'z-talk', 'run-z', { preworkOpens: null }), false, 'switching pre-work off drops it')
  assert.equal(normaliseRun({ ...planned, timeZone: '../../etc' }).timeZone, undefined, 'an unknown zone in the file is dropped')
  assert.equal(normaliseRun({ ...planned, timeZone: 'Asia/Kolkata' }).timeZone, 'Asia/Kolkata')
}

// The pre-work service against a fake Worker: publish creates once and pushes the form; pull pages
// the entries onto the Run through the atomic writer and moves the cursor only after; close stops it.
{
  const root = mkdtempSync(join(tmpdir(), 'talkweaver-prework-service-'))
  const vault = join(root, 'vault')
  _mkdirSync(join(vault, '_PRESENTATIONS', 'pw-talk'), { recursive: true })
  const run = normaliseRun({ id: 'run-pw', talkSlug: 'pw-talk', talkTitle: 'T', kind: 'delivery', status: 'planned', plannedDate: '2026-10-06',
    eventTitle: 'E', preworkOpens: '2026-09-30T09:00', slideSet: { kind: 'full' }, startedAt: '2026-10-06T00:00:00.000Z' })
  persistRunForTalk(vault, 'pw-talk', 'run-pw', run)
  const oldBytes = readFileSync(join(vault, '_PRESENTATIONS', 'pw-talk', 'run-pw.json'), 'utf8')
  const P1 = 'a1b2c3d4e5f60718'
  const worker = { created: 0, forms: [], entries: [], closed: false, fail: false }
  const calls = []
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fakeFetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url)
    calls.push(`${init.method ?? 'GET'} ${pathname}`)
    if (worker.fail) throw new Error('offline')
    if (pathname === '/prework') { worker.created += 1; return reply({ preworkId: 'pw123456', ownerToken: 'owner-token-0123456789' }, 201) }
    assert.equal(init.headers.authorization, 'Bearer owner-token-0123456789', 'owner routes carry the pre-work object\'s own token')
    if (pathname.endsWith('/form')) {
      if (worker.gone) { worker.gone = false; return reply({ error: { code: 'prework_gone' } }, 410) }
      worker.forms.push(JSON.parse(init.body)); return reply({ ok: true })
    }
    if (pathname.endsWith('/close')) { worker.closed = true; return reply({ ok: true, closedAt: 1_700_000_000_000 }) }
    const after = Number(searchParams.get('after'))
    const page = worker.entries.filter((item) => item.seq > after).slice(0, 2)
    return reply({ seq: worker.entries.length, people: 1, lastActivityAt: 1_600_000_000_000, entries: page, more: page.length === 2 && page[1].seq < worker.entries.length })
  }
  const service = createRunPrework({ registryPath: join(root, 'registry.json'), endpoint: async () => ({ baseUrl: 'https://live.example.test/', adminSecret: 'admin' }),
    vaultRoot: () => vault, fetch: fakeFetch, now: () => Date.UTC(2026, 9, 1, 12) })
  const form = { title: 'Before the session', intro: '', steps: [{ id: 'pwwelcome', n: 1, title: 'W', kind: 'slide', questions: true }] }
  const window = { opensAt: Date.UTC(2026, 8, 30, 8), closesAt: Date.UTC(2026, 9, 6, 9) }
  assert.deepEqual(await service.publish('pw-talk', 'run-pw', form, window), { preworkId: 'pw123456', workerBaseUrl: 'https://live.example.test', open: true })
  await service.publish('pw-talk', 'run-pw', form, { ...window, closesAt: window.closesAt + 60_000 })
  assert.equal(worker.created, 1, 'the object is created once per Run')
  assert.equal(worker.forms.length, 2)
  assert.equal(service.status('pw-talk', 'run-pw').closesAt, window.closesAt + 60_000, 'the window pushed last is kept')
  assert.equal(JSON.stringify(service.status('pw-talk', 'run-pw')).includes('owner-token'), false, 'no window ever sees the owner token')
  assert.equal((await import('node:fs')).statSync(join(root, 'registry.json')).mode & 0o777, 0o600, 'the registry is private')

  assert.equal((await service.pull('pw-talk', 'run-pw')).ok, true)
  assert.equal(readFileSync(join(vault, '_PRESENTATIONS', 'pw-talk', 'run-pw.json'), 'utf8').includes('"entries": []'), true, 'a first pull with nothing answered records the count only')
  worker.entries = [1, 2, 3, 4, 5].map((seq) => ({ id: `${P1}:q:s${seq}`, seq, participant: P1, stepId: 'pwwelcome', kind: 'question', text: `Q${seq}`, at: 1_600_000_000_000 }))
  const pulled = await service.pull('pw-talk', 'run-pw')
  assert.equal(pulled.ok && pulled.added, 5, 'every page is pulled')
  assert.equal(readRunForTalk(vault, 'pw-talk', 'run-pw').prework.entries.length, 5, 'the answers are on the Run in the vault')
  const before = calls.length
  const unchanged = await service.pull('pw-talk', 'run-pw')
  assert.equal(unchanged.ok && unchanged.changed, false, 'nothing new: nothing written')
  assert.deepEqual(calls.slice(before), ['GET /prework/pw123456/results'], 'the next pull starts after the cursor')

  worker.fail = true
  const offline = await service.pull('pw-talk', 'run-pw')
  assert.equal(offline.ok, false, 'a failed pull is reported, not swallowed')
  worker.fail = false
  assert.deepEqual(service.due(), [{ talkSlug: 'pw-talk', runId: 'run-pw' }], 'open pre-work is due for the timer')
  const handlers = new Map()
  registerRunPreworkIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, service)
  const closed = await handlers.get('history:prework-close')(null, { talkSlug: 'pw-talk', runId: 'run-pw' })
  assert.equal(closed.ok && worker.closed, true, 'Close pre-work now reaches the Worker')
  assert.equal(readRunForTalk(vault, 'pw-talk', 'run-pw').prework.closedAt, 1_700_000_000_000)
  assert.deepEqual(service.due(), [], 'closed long ago: no longer pulled')
  assert.equal((await handlers.get('history:prework-refresh')(null, { talkSlug: '../escape', runId: 'run-pw' })).ok, false, 'an unsafe Run name is refused')
  assert.equal((await handlers.get('history:prework-refresh')(null, { talkSlug: 'pw-talk', runId: 'nope' })).ok, false)
  assert.notEqual(oldBytes, readFileSync(join(vault, '_PRESENTATIONS', 'pw-talk', 'run-pw.json'), 'utf8'))

  // Purged on the Worker: recorded on the registry row, never asked again, never pulled by the timer.
  const later = createRunPrework({ registryPath: join(root, 'registry.json'), endpoint: async () => ({ baseUrl: 'https://live.example.test', adminSecret: 'admin' }),
    vaultRoot: () => vault, fetch: fakeFetch, now: () => Date.UTC(2026, 9, 3, 12) })
  worker.gone = true
  const gone = await later.publish('pw-talk', 'run-pw', form, { ...window, closesAt: Date.UTC(2026, 9, 6, 9) })
  assert.equal(gone.open, false, 'an object purged on the Worker is not silently replaced: the handout goes out without the form')
  assert.equal(gone.warning, PREWORK_PURGED_MESSAGE)
  assert.equal(worker.created, 1)
  assert.ok(later.status('pw-talk', 'run-pw').purgedAt, 'the registry row records the purge')
  const callsBefore = calls.length
  const asked = await later.pull('pw-talk', 'run-pw')
  assert.deepEqual([asked.ok, asked.error], [false, PREWORK_PURGED_MESSAGE], 'History is told without a Worker call')
  assert.equal((await later.publish('pw-talk', 'run-pw', form, window)).warning, PREWORK_PURGED_MESSAGE)
  assert.equal(calls.length, callsBefore, 'no Worker call once the purge is known')
  assert.deepEqual(later.due(), [], 'and the timer skips it')
  assert.equal(readRunForTalk(vault, 'pw-talk', 'run-pw').prework.entries.length, 5, 'the answers already pulled stay on the Run')
}

// Time zone kept on edit (fix round 2): a Run planned for Prague, edited from a London machine.
{
  const zRoot = mkdtempSync(join(tmpdir(), 'talkweaver-run-zone-edit-'))
  const prague = createPlannedRun(zRoot, { talkSlug: 'z-talk', talkTitle: 'Z', plannedDate: '2026-10-06', eventTitle: 'E', audience: '', slideSet: { kind: 'full' },
    startTime: '10:00', preworkOpens: '2026-10-01T09:00', timeZone: 'Europe/Prague' }, () => 'run-prague')
  const before = preworkWindowMs(preworkWindow(prague), prague.timeZone)
  assert.deepEqual(before, { opensAt: Date.UTC(2026, 9, 1, 7), closesAt: Date.UTC(2026, 9, 6, 8) }, '09:00 and 10:00 in Prague')
  // The sheet on a London machine: it shows the Run's zone and sends none when the zone is unchanged.
  assert.equal(sheetTimeZone(prague, 'Europe/London'), 'Europe/Prague')
  assert.equal(zoneToSend(prague, sheetTimeZone(prague, 'Europe/London'), true), undefined)
  const edited = updatePlannedRun(zRoot, 'z-talk', 'run-prague', { eventTitle: 'Renamed', preworkOpens: '2026-10-01T09:00', preworkCloses: null,
    ...(zoneToSend(prague, 'Europe/Prague', true) ? { timeZone: 'Europe/Prague' } : {}) })
  assert.equal(edited.timeZone, 'Europe/Prague', 'the zone is unchanged')
  assert.deepEqual(preworkWindowMs(preworkWindow(edited), edited.timeZone), before, 'and so are the times')
  // Choosing another zone on purpose re-reads the same wall-clock times there.
  assert.equal(zoneToSend(prague, 'Europe/London', true), 'Europe/London')
  const moved = updatePlannedRun(zRoot, 'z-talk', 'run-prague', { preworkOpens: '2026-10-01T09:00', timeZone: 'Europe/London' })
  assert.equal(moved.timeZone, 'Europe/London')
  assert.deepEqual(preworkWindowMs(preworkWindow(moved), moved.timeZone), { opensAt: Date.UTC(2026, 9, 1, 8), closesAt: Date.UTC(2026, 9, 6, 9) }, 'an hour later in UTC')
  // A new plan sends the zone it shows; an old Run without one takes it only with its times.
  assert.equal(zoneToSend(null, 'Europe/Prague', true), 'Europe/Prague')
  assert.equal(zoneToSend(prague, 'Europe/London', false), undefined, 'no pre-work, no zone')
  assert.equal(zoneToSend({ preworkOpens: '2026-10-01T09:00' }, 'Europe/London', true), 'Europe/London')
}

// The Pen's ink in a stored recording is checked and capped as it is read, before it goes anywhere;
// a bad ink mark is dropped and the rest of the recording kept.
{
  const box = { tool: 'rectangle', ink: 'blue', width: 'thick', points: [[100, 100], [400, 300]] }
  const picture = { tool: 'arrow', ink: 'red', width: 'thin', points: [[0.2, 0.2], [0.7, 0.6]] }
  const heavy = Array.from({ length: 6 }, () => ({ tool: 'freehand', ink: 'red', width: 'thin',
    points: Array.from({ length: 400 }, (_, i) => [100 + i / 1000 + 0.1234567890123, 200 + i / 1000 + 0.9876543210987]) }))
  const raw = [
    { event: 'enter', slideId: 's1', tMs: 0 },
    { event: 'ink', slideId: 's1', tMs: 100, ink: [box] },
    { event: 'ink', slideId: 's1', tMs: 110, ink: [{ ...box, href: 'javascript:x' }] },
    { event: 'ink', slideId: 's1', tMs: 120, ink: [box], note: 'x' },
    { event: 'ink', slideId: 's1', tMs: 130, ink: [{ ...box, junk: 'x'.repeat(2_000_000) }] },
    { event: 'ink', slideId: 's1', tMs: 200, space: 'image', image: 1, ink: [picture] },
    { event: 'ink', slideId: 's1', tMs: 300, ink: [{ ...box, ink: ['red'] }] },
    { event: 'ink', slideId: 's1', tMs: 310, ink: [{ ...box, ink: { toString: null, valueOf: null } }] },
    { event: 'ink', slideId: 's1', tMs: 320, ink: heavy },
    { event: 'ink', slideId: 's1', tMs: 330, ink: Array.from({ length: 101 }, () => box) },
    { event: 'ink', slideId: 's1', tMs: 340, space: 'image', image: 1, ink: [box] },
    { event: 'ink', slideId: 's1', tMs: 350, space: 'image', image: '1', ink: [picture] },
    { event: 'ink', slideId: 's1', tMs: 360, space: 'canvas', ink: [box] },
    { event: 'ink', slideId: 's1', tMs: 'x', ink: [box] },
    { event: 'ink', tMs: 370, ink: [box] },
    'junk',
    { event: 'reveal', slideId: 's1', hidden: 1, tMs: 400 },
  ]
  const run = normaliseRun({ id: 'ink-run', talkSlug: 'ink-talk', startedAt: '2026-10-09T10:00:00.000Z', slideTimeIndex: raw })
  assert.deepEqual(run.slideTimeIndex, [
    { event: 'enter', slideId: 's1', tMs: 0 },
    { event: 'ink', slideId: 's1', tMs: 100, ink: [box] },
    { event: 'ink', slideId: 's1', tMs: 200, space: 'image', image: 1, ink: [picture] },
    'junk',
    { event: 'reveal', slideId: 's1', hidden: 1, tMs: 400 },
  ], 'valid ink kept, a zoomed image\'s with its image; every bad ink mark dropped, an unknown field anywhere included')
  // Structure first: an unknown field is refused without its value being read (no serialising it).
  let reads = 0
  const trap = { ...box }
  Object.defineProperty(trap, 'junk', { enumerable: true, get() { reads++; return 'x'.repeat(2_000_000) } })
  const markTrap = { event: 'ink', slideId: 's1', tMs: 1, ink: [box] }
  Object.defineProperty(markTrap, 'extra', { enumerable: true, get() { reads++; return 'x' } })
  assert.equal(readbackInkMark({ event: 'ink', slideId: 's1', tMs: 1, ink: [trap] }), null)
  assert.equal(readbackInkMark(markTrap), null)
  assert.equal(reads, 0, 'unknown fields are refused unread')
  assert.equal(readbackInkMark({ event: 'ink', slideId: 's1', tMs: 1, ink: [{ ...box, tool: 'x'.repeat(5000) }] }), null, 'an oversized field')
  assert.deepEqual(normaliseRun({ id: 'r', talkSlug: 't', slideTimeIndex: 'nope' }).slideTimeIndex, [])
  // The recording's ink as a whole is capped: past the budget the later ink is dropped.
  const full = Array.from({ length: 5 }, () => ({ ...heavy[0], points: heavy[0].points.map(([x, y]) => [Math.round(x), Math.round(y)]) }))
  const many = Array.from({ length: 2000 }, (_, i) => ({ event: 'ink', slideId: 's1', tMs: i, ink: full }))
  const capped = readbackSlideTimeIndex(many)
  const bytes = capped.reduce((sum, m) => sum + inkMarkFileBytes(m), 0)
  assert.ok(capped.length > 0 && capped.length < many.length && bytes <= INK_READBACK_BYTES, `${capped.length} marks, ${bytes} bytes`)
  // The budget is what the ink takes in the written file (indented), not its compact form.
  const compact = capped.reduce((sum, m) => sum + new TextEncoder().encode(JSON.stringify(m)).length, 0)
  assert.ok(compact < INK_READBACK_BYTES / 3, `compact ${compact} is a fraction of the file form ${bytes}`)
  const fileVault = mkdtempSync(join(tmpdir(), 'talkweaver-run-ink-file-'))
  const plain = { id: 'sess-20261009-110000-a', talkSlug: 'ink-file', startedAt: '2026-10-09T11:00:00.000Z', slideTimeIndex: [{ event: 'enter', slideId: 's1', tMs: 0 }] }
  persistRunForTalk(fileVault, 'ink-file', plain.id, normaliseRun(plain))
  const plainSize = readFileSync(runPathForTalk(fileVault, 'ink-file', plain.id)).length
  persistRunForTalk(fileVault, 'ink-file', plain.id, normaliseRun({ ...plain, slideTimeIndex: [...plain.slideTimeIndex, ...many] }))
  const grown = readFileSync(runPathForTalk(fileVault, 'ink-file', plain.id)).length - plainSize
  assert.equal(grown, bytes, `the ink grows the Run file by exactly its measured bytes (${grown})`)
  assert.ok(grown <= 2_000_000, `a recording's ink takes at most 2 MB of its file (${grown})`)
  assert.deepEqual(capped.map((m) => m.tMs), capped.map((_, i) => i), 'the first ink is the ink kept')
  // Once the budget is spent, later ink marks are dropped without being looked at.
  let after = 0
  const late = Array.from({ length: 50 }, (_, i) => {
    const mark = { event: 'ink', slideId: 's1', tMs: 5000 + i }
    Object.defineProperty(mark, 'ink', { enumerable: true, get() { after++; return [box] } })
    return mark
  })
  const withLate = readbackSlideTimeIndex([...many, ...late, { event: 'reveal', slideId: 's1', hidden: 0, tMs: 9999 }])
  assert.equal(after, 0, 'no ink mark after the budget is read')
  assert.equal(withLate.length, capped.length + 1, 'only the non-ink mark after it is kept')
}

// Studio's lists: a session file whose root is not an object is skipped (it would break the sort and
// blank the list); a session is listed with its ink checked and a default kind.
{
  for (const root of [null, [], [{ id: 'x' }], 3, 'text', true]) assert.equal(sessionForList(root), null, JSON.stringify(root))
  const listed = [null, { id: 'b', startedAt: '2026-10-09T10:00:00.000Z' }, 7, { id: 'a', startedAt: '2026-10-08T10:00:00.000Z', kind: 'rehearsal',
    slideTimeIndex: [{ event: 'ink', slideId: 's', tMs: 1, ink: [{ tool: 'arrow', ink: ['red'], width: 'thin', points: [[1, 1], [2, 2]] }] }] }]
    .map(sessionForList).filter(Boolean)
  listed.sort((x, y) => String(y.startedAt ?? '').localeCompare(String(x.startedAt ?? '')))
  assert.deepEqual(listed.map((x) => [x.id, x.kind]), [['b', 'delivery'], ['a', 'rehearsal']])
  assert.deepEqual(listed[1].slideTimeIndex, [], 'its bad ink dropped')
}

console.log('runs: planned CRUD, legacy interpretation, attach, slide sets, cover and URLs, DS_Store tolerance, instant slides, image checks, reactions and questions, Run path boundary, plan fields, boards, pre-work passed')
