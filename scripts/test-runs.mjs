import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addRunPoll,
  addRunPollResponse,
  applyRunPollBuffer,
  attachDeliveryToPlanned,
  clearRunHandoutUrl,
  createPlannedRun,
  deletePlannedRun,
  injectRunCoverMetadata,
  listRuns,
  normaliseRun,
  plannedRunCandidates,
  persistRun,
  readRun,
  resolveRunSlideSet,
  runHandoutSlug,
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
import { writeFileSync as _writeFileSync, mkdirSync as _mkdirSync } from 'node:fs'
const dsRoot = mkdtempSync(join(tmpdir(), 'talkweaver-dsstore-'))
_mkdirSync(join(dsRoot, '_PRESENTATIONS'), { recursive: true })
_writeFileSync(join(dsRoot, '_PRESENTATIONS', '.DS_Store'), 'not a directory', 'utf8')
_writeFileSync(join(dsRoot, '_PRESENTATIONS', 'stray-file.txt'), 'also not a directory', 'utf8')
createPlannedRun(dsRoot, { ...baseInput, eventTitle: 'Survives DS_Store' }, () => 'survivor')
const survived = listRuns(dsRoot) // no slug → enumerates every _PRESENTATIONS child
assert.equal(survived.length, 1, 'listRuns must skip non-directory entries and still return real runs')
assert.equal(survived[0].id, 'survivor')

console.log('runs: planned CRUD, legacy interpretation, attach, slide sets, cover and URLs, DS_Store tolerance passed')
