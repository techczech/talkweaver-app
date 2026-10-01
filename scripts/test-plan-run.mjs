import assert from 'node:assert/strict'
import { blankDraft, dayAndTime, draftFromRun, localToday, longDate, nextPlannedRun, planFromDraft, preworkWindow, runChips, shortDate } from '../src/shared/plan-run.ts'
import { lastDeliveredBySlug } from '../src/renderer/src/components/talklist/model.ts'

// Dates.
assert.equal(shortDate('2026-10-06'), '6 Oct')
assert.equal(longDate('2026-10-06'), 'Tue 6 Oct 2026')
assert.equal(dayAndTime('2026-10-06T10:00'), 'Tue 6 Oct, 10:00')
assert.equal(localToday(new Date(2026, 8, 30, 23, 59)), '2026-09-30')

// Pre-work in the talk: the compiler's definition (scripts/test-prework.mjs).

// The next Run: earliest planned, not past, this talk only.
const runs = [
  { id: 'r-late', talkSlug: 't', status: 'planned', plannedDate: '2026-11-01', eventTitle: 'Late' },
  { id: 'r-next', talkSlug: 't', status: 'planned', plannedDate: '2026-10-06', eventTitle: 'ITSS Briefing, October', startTime: '10:00', preworkOpens: '2026-09-22T09:00' },
  { id: 'r-past', talkSlug: 't', status: 'planned', plannedDate: '2026-09-01', eventTitle: 'Past' },
  { id: 'r-done', talkSlug: 't', status: 'delivered', plannedDate: '2026-10-01', eventTitle: 'Done' },
  { id: 'r-other', talkSlug: 'u', status: 'planned', plannedDate: '2026-10-02', eventTitle: 'Other talk' }
]
assert.equal(nextPlannedRun(runs, 't', '2026-09-30')?.id, 'r-next')
assert.equal(nextPlannedRun(runs, 't', '2026-10-06')?.id, 'r-next', 'a Run planned for today is still next')
assert.equal(nextPlannedRun(runs, 't', '2026-10-07')?.id, 'r-late')
assert.equal(nextPlannedRun(runs, 't', '2026-12-01'), null)
assert.equal(nextPlannedRun([], 't', '2026-09-30'), null)

// Chips.
const now = new Date(2026, 8, 30, 12, 0)
const withPrework = runChips(runs[1], true, now)
assert.equal(withPrework.run.text, 'Next run: ITSS Briefing, October, 6 Oct')
assert.equal(withPrework.prework.text, 'Pre-work opened 22 Sep', 'pre-work that has already opened says so')
assert.equal(runChips({ ...runs[1], preworkOpens: '2026-10-01T09:00' }, true, now).prework.text, 'Pre-work opens 1 Oct')
// Once it is open, the chip counts people from the Run's mirrored answers (ticket 11).
assert.equal(runChips({ ...runs[1], expectedPeople: 22 }, true, now, { started: 14, finished: 9 }).prework.text, 'Pre-work: 14 of 22 started')
assert.equal(runChips({ ...runs[1], expectedPeople: undefined }, true, now, { started: 14, finished: 9 }).prework.text, 'Pre-work: 14 started', 'without expected people it is only a count')
assert.equal(runChips({ ...runs[1], expectedPeople: 22, preworkOpens: '2026-10-01T09:00' }, true, now, { started: 0, finished: 0 }).prework.text, 'Pre-work opens 1 Oct', 'before it opens the chip says when')
assert.equal(runChips({ ...runs[1], preworkOpens: undefined }, false, now).prework, null, 'no pre-work, no pre-work chip')
assert.deepEqual(runChips(null, true, now), { run: null, prework: null, nudge: { text: 'No run planned · Plan a run…' } })
assert.deepEqual(runChips(null, false, now), { run: null, prework: null, nudge: null }, 'no pre-work and no Run shows nothing')

// The sheet's draft: closing follows the talk start unless set.
const blank = blankDraft(new Date(2026, 8, 22, 9, 5), true)
assert.equal(blank.opens, '2026-09-22T09:05', 'pre-work opens when the plan is saved')
assert.equal(blank.closes, null)
assert.equal(blank.startTime, '10:00')
assert.equal(blank.preworkOn, true)
assert.deepEqual(planFromDraft(blank, true), { ok: false, error: 'Give the event a name.' })
const good = { ...blank, event: '  ITSS Briefing, October ', date: '2026-10-06', expected: '22', audience: 'IT Services staff' }
const plan = planFromDraft(good, true)
assert.equal(plan.ok, true)
assert.deepEqual(plan.fields, { plannedDate: '2026-10-06', eventTitle: 'ITSS Briefing, October', audience: 'IT Services staff', slideSet: { kind: 'full' }, startTime: '10:00', expectedPeople: 22, preworkOpens: '2026-09-22T09:05', preworkCloses: null })
assert.equal(planFromDraft({ ...good, expected: '' }, true).fields.expectedPeople, null, 'expected people is optional')
assert.equal(planFromDraft({ ...good, expected: '2.5' }, true).ok, false)
// Pre-work fields are omitted (an edit keeps the Run's window) unless the toggle was shown; only an
// explicit switch-off clears.
{
  const beforeDetection = planFromDraft(draftFromRun({ id: 'x', talkSlug: 't', plannedDate: '2026-10-06', eventTitle: 'E', preworkOpens: '2026-09-22T09:00' }, now), false)
  assert.equal(beforeDetection.ok, true)
  assert.equal('preworkOpens' in beforeDetection.fields, false, 'a save before the outline is read leaves pre-work alone')
  assert.equal('preworkCloses' in beforeDetection.fields, false)
  const noOutline = planFromDraft({ ...good, preworkOn: true }, false)
  assert.equal('preworkOpens' in noOutline.fields, false, 'an edit with no outline (History without an outline path) leaves pre-work alone')
  assert.equal('preworkOpens' in planFromDraft(good, false).fields, false, 'a talk without pre-work saves no pre-work fields')
  const off = planFromDraft({ ...good, preworkOn: false }, true)
  assert.equal(off.fields.preworkOpens, null, 'switching a shown toggle off clears the window')
  assert.equal(off.fields.preworkCloses, null)
}
assert.equal(planFromDraft({ ...good, opens: '2026-10-06T10:00' }, true).ok, false, 'closing at the talk start cannot precede an opening at the same minute')
assert.equal(planFromDraft({ ...good, closes: '2026-10-05T18:00' }, true).fields.preworkCloses, '2026-10-05T18:00')
assert.equal(planFromDraft({ ...good, slideSet: 'short' }, true).fields.slideSet.pathwayId, 'short')

// Editing round-trips.
const back = draftFromRun({ id: 'x', talkSlug: 't', status: 'planned', plannedDate: '2026-10-06', startTime: '11:30', eventTitle: 'E', audience: 'A', expectedPeople: 9, preworkOpens: '2026-09-22T09:00', preworkCloses: '2026-10-05T18:00', slideSet: { kind: 'pathway', pathwayId: 'short' } }, now)
assert.deepEqual(back, { event: 'E', date: '2026-10-06', startTime: '11:30', expected: '9', audience: 'A', slideSet: 'short', preworkOn: true, opens: '2026-09-22T09:00', closes: '2026-10-05T18:00' })
assert.equal(draftFromRun({ id: 'x', talkSlug: 't', plannedDate: '2026-10-06' }, now).preworkOn, false, 'a Run without pre-work opens the sheet with it off')
assert.deepEqual(preworkWindow({ plannedDate: '2026-10-06', preworkOpens: '2026-09-22T09:00' }), { opens: '2026-09-22T09:00', closes: '2026-10-06T00:00' })

// A planned Run does not count as delivered (status bar and talk list read this).
const sessions = [
  { talkSlug: 'a', kind: 'delivery', status: 'delivered', startedAt: new Date(Date.UTC(2026, 8, 28, 14)).toISOString() },
  { talkSlug: 'a', kind: 'delivery', status: 'planned', startedAt: '2026-10-06T00:00:00.000Z' },
  { talkSlug: 'b', kind: 'delivery', status: 'planned', startedAt: '2026-10-06T00:00:00.000Z' },
  { talkSlug: 'c', kind: 'delivery', startedAt: new Date(Date.UTC(2026, 8, 1)).toISOString() }
]
assert.deepEqual(lastDeliveredBySlug(sessions), { a: Date.UTC(2026, 8, 28, 14), c: Date.UTC(2026, 8, 1) }, 'planned Runs are not deliveries; legacy Runs without status still are')

console.log('plan-run: dates, next Run, chips, sheet draft, delivered count passed')
