import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachDeliveryToPlanned,
  clearRunHandoutUrl,
  createPlannedRun,
  deletePlannedRun,
  injectRunCoverMetadata,
  listRuns,
  normaliseRun,
  plannedRunCandidates,
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

console.log('runs: planned CRUD, legacy interpretation, attach, slide sets, cover and URLs passed')
