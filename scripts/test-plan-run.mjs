import assert from 'node:assert/strict'
import { applyFix, blankDraft, copyDraftFromRun, moveDraftToDate, dayAndTime, draftFromRun, localToday, longDate, markedPhases, nextPlannedRun, planFromDraft, planIssues, preworkWindow, runChips, shortDate, workDefaults } from '../src/shared/plan-run.ts'
import { legacyPreWork, normaliseRunWork, normaliseRunWorkSet, workClosingError } from '../src/shared/run-work.ts'
import { statusChip } from '../src/shared/status-chip.ts'
import { lastDeliveredBySlug } from '../src/renderer/src/components/talklist/model.ts'
import { resolveRunSlideSet } from '../src/main/runs.ts'
import { placeRunExtraNodes, runCompileOption, withRunExtraIds } from '../compiler/scripts/lib/run-extras.mjs'
import { normaliseRun } from '../src/main/runs.ts'
import { extraSlidePlacement, extraSlideViews } from '../src/shared/run-extra-slides.ts'

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

// The sheet's draft (work-files ticket 11): empty date and time as the mockup draws them; each phase
// starts from the file the talk's metadata names.
const FILES = [
  { id: 'research-teams-intake', fileName: 'research-teams-intake.md' },
  { id: 'feedback', fileName: 'feedback.md' },
  { id: '', fileName: 'unnamed.md' }
]
assert.deepEqual(workDefaults({ prework: 'research-teams-intake', postwork: 'feedback' }, FILES), { pre: 'research-teams-intake', post: 'feedback' }, 'defaults come from the talk’s metadata')
assert.deepEqual(workDefaults({ prework: 'research-teams-intake.md  # note', postwork: '"feedback"' }, FILES), { pre: 'research-teams-intake', post: 'feedback' }, 'read as the strips read them')
assert.deepEqual(workDefaults({}, FILES), { pre: '', post: '' }, 'a talk that names nothing starts with None')
assert.deepEqual(workDefaults({ prework: 'true', postwork: 'gone' }, FILES), { pre: '', post: '' }, 'the 0.39 switch and a missing file name no file')
assert.deepEqual(workDefaults({ prework: 'unnamed' }, FILES), { pre: '', post: '' }, 'a file with no id cannot be attached to a Run')
const blank = blankDraft({ pre: 'research-teams-intake', post: 'feedback' })
assert.deepEqual(blank, { event: '', date: '', startTime: '', expected: '', audience: '', slideSet: 'full',
  pre: { fileId: 'research-teams-intake', opens: '', closes: '' }, post: { fileId: 'feedback', opens: 'session-end', closes: '' } })
assert.equal(blankDraft().pre.fileId, '', 'no defaults: None')
const ctx = { phases: true, editing: false }
assert.deepEqual(planFromDraft(blank, ctx), { ok: false, error: 'Give the event a name.' })
const filled = { ...blank, event: '  Saïd workshop ', date: '2026-10-21', startTime: '14:00', expected: '18', audience: 'IT Services staff',
  pre: { fileId: 'research-teams-intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00' }, post: { fileId: 'feedback', opens: 'session-end', closes: '2026-11-04T17:00' } }
const plan = planFromDraft(filled, ctx)
assert.equal(plan.ok, true)
assert.equal(plan.attached, true)
assert.deepEqual(plan.fields, { plannedDate: '2026-10-21', eventTitle: 'Saïd workshop', audience: 'IT Services staff', slideSet: { kind: 'full' }, startTime: '14:00', expectedPeople: 18,
  work: { pre: { fileId: 'research-teams-intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00' }, post: { fileId: 'feedback', opens: 'session-end', closes: '2026-11-04T17:00' } } })
assert.equal(planFromDraft({ ...filled, date: '' }, ctx).error, 'Choose a date.')
assert.equal(planFromDraft({ ...filled, startTime: '' }, ctx).error, 'Choose a start time.')
assert.equal(planFromDraft({ ...filled, expected: '' }, ctx).fields.expectedPeople, null, 'expected people is optional')
assert.equal(planFromDraft({ ...filled, expected: '2.5' }, ctx).ok, false)
assert.equal(planFromDraft({ ...filled, slideSet: 'short' }, ctx).fields.slideSet.pathwayId, 'short')
// Pre-work closing is optional (the session start); opening is required once a file is chosen.
assert.equal('closes' in planFromDraft({ ...filled, pre: { ...filled.pre, closes: '' } }, ctx).fields.work.pre, false, 'pre-work with no closing time closes when the session starts')
assert.equal(planFromDraft({ ...filled, pre: { ...filled.pre, opens: '' } }, ctx).error, 'Choose when pre-work opens.')
// Post-work: Closes is required; "At a set time…" needs its time; the default opens when the session ends.
assert.equal(planFromDraft({ ...filled, post: { ...filled.post, closes: '' } }, ctx).error, 'Choose when post-work closes.', 'Closes is required')
assert.equal(planFromDraft({ ...filled, post: { ...filled.post, opens: '' } }, ctx).error, 'Choose when post-work opens.', 'a set time with no time chosen')
assert.equal(planFromDraft({ ...filled, post: { ...filled.post, opens: '2026-10-21T16:00' } }, ctx).fields.work.post.opens, '2026-10-21T16:00', 'At a set time…')
assert.equal(planFromDraft(filled, ctx).fields.work.post.opens, 'session-end', 'When the session ends is the default')
assert.equal(planFromDraft({ ...filled, post: { ...filled.post, opens: '2026-10-21T13:00' } }, ctx).error, 'Post-work must open after the session starts')
// "None" leaves the phase off: a new Run carries no attachment for it, an edited Run has it removed.
{
  const noPre = planFromDraft({ ...filled, pre: { fileId: '', opens: '', closes: '' } }, ctx)
  assert.equal(noPre.ok, true, 'None needs no times')
  assert.equal('pre' in noPre.fields.work, false, 'a new Run has no pre-work')
  assert.equal(noPre.fields.work.post.fileId, 'feedback')
  const none = planFromDraft({ ...filled, pre: { fileId: '', opens: '', closes: '' }, post: { fileId: '', opens: 'session-end', closes: '' } }, ctx)
  assert.equal(none.attached, false)
  assert.equal('work' in none.fields, false, 'neither phase: no work sent at all')
  const edit = planFromDraft({ ...filled, pre: { fileId: '', opens: '', closes: '' }, post: { fileId: '', opens: 'session-end', closes: '' } }, { phases: true, editing: true })
  assert.deepEqual(edit.fields.work, { pre: null, post: null }, 'editing a phase to None removes it')
  assert.equal(edit.fields.preworkOpens, null, 'and clears a migrated 0.39 window with it')
  // The sheet did not show the work blocks (no vault, pre-work off): the Run's work is left alone.
  const hidden = planFromDraft(filled, { phases: false, editing: true })
  assert.equal(hidden.ok, true)
  assert.equal('work' in hidden.fields || 'preworkOpens' in hidden.fields, false, 'hidden blocks send nothing')
}
// A migrated 0.39 window is saved through the old window fields; it is never sent as a work file.
{
  const legacy = planFromDraft({ ...filled, pre: { fileId: 'legacy-section', opens: '2026-10-14T09:00', closes: '' } }, { phases: true, editing: true })
  assert.equal(legacy.fields.preworkOpens, '2026-10-14T09:00')
  assert.equal(legacy.fields.preworkCloses, null)
  assert.equal('pre' in legacy.fields.work, false)
}
// A phase marked zone-mismatch (ticket 03) is left out of the save whatever the sheet holds.
{
  const withMark = planFromDraft({ ...filled, pre: { ...filled.pre, closes: '2026-10-22T09:00' } }, { phases: true, editing: true, marked: { pre: true } })
  assert.equal(withMark.ok, true, 'the other fields can still be saved')
  assert.equal('pre' in withMark.fields.work, false, 'the marked phase is not planned over')
  assert.equal(withMark.fields.work.post.fileId, 'feedback')
  assert.deepEqual(markedPhases({ work: { pre: { problem: 'zone-mismatch' }, post: {} } }), { pre: true, post: false })
  assert.deepEqual(markedPhases(null), { pre: false, post: false })
}

// The two drawn validation states and the value each fix puts in (hifi shots 2-validation-error, 2-post-work-validation-error).
{
  const late = { ...filled, pre: { ...filled.pre, closes: '2026-10-21T14:30' } }
  const [issue] = planIssues(late)
  assert.equal(issue.message, 'Pre-work must close before the session starts')
  assert.equal(issue.phase, 'pre')
  assert.equal(issue.fix.label, 'Close at 13:00', 'an hour before the session starts, on the same day')
  assert.equal(applyFix(late, issue.fix).pre.closes, '2026-10-21T13:00')
  assert.equal(planIssues(applyFix(late, issue.fix)).length, 0, 'the fix clears the message')
  assert.equal(planFromDraft(late, ctx).error, 'Pre-work must close before the session starts', 'and Save is refused with the same words')
  const across = planIssues({ ...late, startTime: '00:30', pre: { ...late.pre, closes: '2026-10-21T01:00' } })[0]
  assert.equal(across.fix.label, 'Close Tue 20 Oct 23:30', 'the fix keeps the day when the hour before is yesterday')
  assert.equal(planIssues({ ...filled, pre: { ...filled.pre, closes: '2026-10-21T14:00' } }).length, 0, 'pre-work may close as the session starts')

  const early = { ...filled, post: { ...filled.post, closes: '2026-10-20T17:00' } }
  const [post] = planIssues(early)
  assert.equal(post.message, 'Post-work must close after the session ends')
  assert.equal(post.phase, 'post')
  assert.equal(post.fix.label, 'Close Wed 4 Nov 17:00', 'a fortnight after the session, 17:00')
  assert.equal(applyFix(early, post.fix).post.closes, '2026-11-04T17:00')
  assert.equal(planIssues(applyFix(early, post.fix)).length, 0)
  assert.equal(planIssues({ ...filled, post: { ...filled.post, closes: '2026-10-21T14:00' } }).length, 1, 'closing at the session start is too early for post-work')
  const setBefore = planIssues({ ...filled, post: { fileId: 'feedback', opens: '2026-10-21T13:00', closes: '2026-11-04T17:00' } })[0]
  assert.equal(setBefore.fix.label, 'Open when the session ends')
  assert.equal(applyFix({ ...filled, post: { fileId: 'feedback', opens: '2026-10-21T13:00', closes: '2026-11-04T17:00' } }, setBefore.fix).post.opens, 'session-end')
  assert.equal(planIssues({ ...filled, pre: { ...filled.pre, closes: '2026-10-14T08:00' } })[0].message, 'Pre-work must close after it opens')
  // Nothing is judged until the values are complete, or for a phase left off.
  assert.deepEqual(planIssues({ ...early, startTime: '' }), [])
  assert.deepEqual(planIssues({ ...early, post: { ...early.post, fileId: '' } }), [])
  assert.deepEqual(planIssues({ ...early }, { post: true }), [])
  // Review round 3 (ticket 19): Change time on a delivered Run may close either phase on either side of the
  // session; a planned Run is still refused, and the other rules still hold for a delivered one.
  const given = { phases: true, editing: true, delivered: true }
  assert.deepEqual(planIssues(late, {}, { delivered: true }), [], 'pre-work closing after the start is not judged on a delivered Run')
  assert.deepEqual(planIssues(early, {}, { delivered: true }), [], 'nor post-work closing before it')
  assert.equal(planFromDraft(late, given).ok, true, 'and the sheet saves it')
  assert.equal(planFromDraft(early, given).ok, true)
  assert.equal(planFromDraft(late, { phases: true, editing: true }).error, 'Pre-work must close before the session starts', 'a planned Run being edited is still refused')
  assert.equal(planFromDraft(late, { ...given, delivered: false }).error, 'Pre-work must close before the session starts')
  assert.equal(planIssues({ ...filled, pre: { ...filled.pre, closes: '2026-10-14T08:00' } }, {}, { delivered: true })[0].message, 'Pre-work must close after it opens')
  assert.equal(planIssues({ ...filled, post: { fileId: 'feedback', opens: '2026-10-21T13:00', closes: '2026-11-04T17:00' } }, {}, { delivered: true })[0].code, 'post-opens-before-start')
}

// Editing round-trips.
const back = draftFromRun({ id: 'x', talkSlug: 't', status: 'planned', plannedDate: '2026-10-21', startTime: '14:00', eventTitle: 'E', audience: 'A', expectedPeople: 9, slideSet: { kind: 'pathway', pathwayId: 'short' },
  work: { pre: { fileId: 'intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00' }, post: { fileId: 'feedback', opens: 'session-end', closes: '2026-11-04T17:00' } } }, now)
assert.deepEqual(back, { event: 'E', date: '2026-10-21', startTime: '14:00', expected: '9', audience: 'A', slideSet: 'short',
  pre: { fileId: 'intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00' }, post: { fileId: 'feedback', opens: 'session-end', closes: '2026-11-04T17:00' } })
assert.equal(draftFromRun({ id: 'x', talkSlug: 't', plannedDate: '2026-10-06' }, now).pre.fileId, '', 'a Run without work files opens the sheet with None')
assert.equal(draftFromRun({ id: 'x', talkSlug: 't', plannedDate: '2026-10-06' }, now).post.opens, 'session-end')
assert.deepEqual(preworkWindow({ plannedDate: '2026-10-06', preworkOpens: '2026-09-22T09:00' }), { opens: '2026-09-22T09:00', closes: '2026-10-06T00:00' })

// Work-file windows (work-files ticket 03): pre closes by the session start, post after it.
{
  const start = '2026-10-06T10:00'
  assert.equal(workClosingError('pre', { opens: '2026-10-01T09:00', closes: start }, start), null, 'pre-work may close as the session starts')
  assert.equal(workClosingError('pre', { opens: '2026-10-01T09:00', closes: '2026-10-06T10:01' }, start), 'work-pre-closes-after-start')
  assert.equal(workClosingError('post', { opens: 'session-end', closes: start }, start), 'work-post-closes-before-start')
  assert.equal(workClosingError('post', { opens: 'session-end', closes: '2026-10-07T10:00' }, start), null)
  assert.equal(workClosingError('post', { opens: '2026-10-06T12:00', closes: '2026-10-06T11:00' }, start), 'work-closes-before-opens')
  // A delivered Run (Change time, ticket 19 review round 3) skips only the two closing-against-start rules.
  assert.equal(workClosingError('pre', { opens: '2026-10-01T09:00', closes: '2026-10-06T10:01' }, start, { delivered: true }), null)
  assert.equal(workClosingError('post', { opens: 'session-end', closes: start }, start, { delivered: true }), null)
  assert.equal(workClosingError('post', { opens: '2026-10-06T12:00', closes: '2026-10-06T11:00' }, start, { delivered: true }), 'work-closes-before-opens')
  assert.equal(workClosingError('post', { opens: '2026-10-06T09:00', closes: '2026-10-07T11:00' }, start, { delivered: true }), 'work-post-opens-before-start')
  assert.equal(workClosingError('pre', { opens: '2026-10-01T09:00', closes: '2026-10-06T10:01' }, start, { delivered: false }), 'work-pre-closes-after-start')
  const zone = 'Europe/London'
  assert.equal(normaliseRunWork({ fileId: 'f', opens: 'session-end', closes: '2026-10-07T10:00', timeZone: zone }, 'pre'), null, 'only post-work opens at session end')
  assert.equal(normaliseRunWork({ fileId: 'f', opens: 'session-end', closes: '2026-10-07T10:00', timeZone: zone }, 'post').opens, 'session-end')
  assert.equal(normaliseRunWorkSet({ later: { fileId: 'f', opens: '2026-10-01T09:00', closes: start, timeZone: zone } }), undefined, 'an unknown phase is dropped')
  assert.equal(legacyPreWork({ plannedDate: '2026-10-06', preworkOpens: 'soon' }, zone), null)
  assert.equal(legacyPreWork({ preworkOpens: '2026-10-01T09:00' }, zone), null, 'no closing can be worked out')
  assert.equal(legacyPreWork({ plannedDate: '2026-10-06', startTime: '10:00', preworkOpens: '2026-10-01T09:00' }, zone).fileId, 'legacy-section')
}

// A planned Run does not count as delivered (status bar and talk list read this).
const sessions = [
  { talkSlug: 'a', kind: 'delivery', status: 'delivered', startedAt: new Date(Date.UTC(2026, 8, 28, 14)).toISOString() },
  { talkSlug: 'a', kind: 'delivery', status: 'planned', startedAt: '2026-10-06T00:00:00.000Z' },
  { talkSlug: 'b', kind: 'delivery', status: 'planned', startedAt: '2026-10-06T00:00:00.000Z' },
  { talkSlug: 'c', kind: 'delivery', startedAt: new Date(Date.UTC(2026, 8, 1)).toISOString() }
]
assert.deepEqual(lastDeliveredBySlug(sessions), { a: Date.UTC(2026, 8, 28, 14), c: Date.UTC(2026, 8, 1) }, 'planned Runs are not deliveries; legacy Runs without status still are')

// The status bar chip (work-files ticket 21), one case per drawn state (hifi shots 6-*).
{
  const TZ = 'Europe/London'
  const published = '2026-10-14T08:00:00Z'
  const said = (extra = {}) => ({
    vaultId: 'v1', talkSlug: 'ai-research', runId: 'said', talkTitle: 'AI for research teams', eventTitle: 'Saïd workshop', status: 'planned',
    plannedDate: '2026-10-21', startTime: '14:00', expectedPeople: 18, timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/said',
    work: { pre: { fileId: 'intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00', timeZone: TZ, publishedAt: published },
      post: { fileId: 'feedback', opens: 'session-end', closes: '2026-11-04T17:00', timeZone: TZ, publishedAt: published } }, ...extra
  })
  const none = new Set()
  const chipOf = (sources, at, live = none) => statusChip(sources, live, new Date(at))
  const upcoming = chipOf([said({ answers: { pre: 7 } })], '2026-10-14T10:00:00Z')
  assert.deepEqual([upcoming.text, upcoming.tone, upcoming.icon], ['Saïd workshop · Wed 21 Oct · pre-work 7/18', 'blue', 'list-checks'], 'upcoming')
  assert.deepEqual(upcoming.ref, { vaultId: 'v1', talkSlug: 'ai-research', runId: 'said' }, 'the chip names the Run\'s vault')
  // Two open vaults with the same talk and Run id: the chip of vault v2's Run names v2 (review round 1, finding 2).
  assert.equal(statusChip([said({ vaultId: 'v2' })], none, new Date('2026-10-14T10:00:00Z')).ref.vaultId, 'v2')
  const closed = chipOf([said({ answers: { pre: 16 } })], '2026-10-21T12:30:00Z')
  assert.deepEqual([closed.text, closed.tone, closed.icon], ['Saïd workshop · Wed 21 Oct · pre-work closed 16/18', 'amber', 'lock'], 'pre-work closed')
  const live = chipOf([said({ answers: { pre: 16 } })], '2026-10-21T13:05:00Z', new Set(['ai-research/said']))
  assert.deepEqual([live.text, live.tone, live.icon], ['Saïd workshop · live now', 'red', 'live-dot'], 'live now')
  // Post-work that opens when the session ends is open once its opening was pushed and noted (ticket 19).
  // Opened when its session ended (an opening later than now is not open: ticket 19 review).
  const opened = (extra) => { const run = said(extra); run.work.post.openedAt = extra?.endedAt ?? '2026-10-21T15:30:00Z'; return run }
  const post = chipOf([opened({ status: 'delivered', endedAt: '2026-10-21T15:30:00Z', answers: { pre: 16, post: 5 } })], '2026-10-22T09:00:00Z')
  assert.deepEqual([post.text, post.tone, post.icon], ['Saïd workshop · post-work 5/18 · closes Wed 4 Nov', 'blue', 'message-square-heart'], 'post-work open')
  // Absent: nothing published, no work files, post-work closed, a rehearsal, nothing at all.
  const unpublished = said({ handoutUrl: undefined, work: { pre: { fileId: 'intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00', timeZone: TZ } } })
  assert.equal(chipOf([unpublished], '2026-10-14T10:00:00Z'), null, 'absent: not sent to anyone')
  assert.equal(chipOf([said({ work: undefined })], '2026-10-14T10:00:00Z'), null, 'absent: no work files')
  assert.equal(chipOf([opened({ status: 'delivered', endedAt: '2026-10-21T15:30:00Z' })], '2026-11-05T09:00:00Z'), null, 'absent: post-work closed')
  assert.equal(chipOf([said({ kind: 'rehearsal' })], '2026-10-14T10:00:00Z'), null, 'absent: a rehearsal')
  assert.equal(chipOf([], '2026-10-14T10:00:00Z'), null, 'absent: no Runs')
  // Several Runs: live beats upcoming, the soonest upcoming beats post-work open.
  const later = said({ runId: 'later', eventTitle: 'Later', plannedDate: '2026-10-28', work: { pre: { fileId: 'intake', opens: '2026-10-14T09:00', closes: '2026-10-28T13:00', timeZone: TZ, publishedAt: published } } })
  const done = opened({ runId: 'done', eventTitle: 'Done', status: 'delivered', plannedDate: '2026-10-09', endedAt: '2026-10-09T15:00:00Z' })
  assert.equal(chipOf([later, said(), done], '2026-10-14T10:00:00Z').ref.runId, 'said', 'the soonest upcoming Run')
  assert.equal(chipOf([said(), later], '2026-10-14T10:00:00Z', new Set(['ai-research/later'])).ref.runId, 'later', 'a live Run wins')
  assert.equal(chipOf([done, later], '2026-10-14T10:00:00Z').ref.runId, 'later', 'upcoming beats post-work open')
  assert.equal(chipOf([done], '2026-10-14T10:00:00Z').ref.runId, 'done', 'post-work open alone')
}

// Plan the next run like this (work-files ticket 26).
{
  const source = {
    id: 'said', talkSlug: 'ai-research', status: 'delivered', plannedDate: '2026-10-21', startTime: '14:00', eventTitle: 'Saïd workshop', audience: 'Research teams', expectedPeople: 18,
    handoutUrl: 'https://handouts.fyi/dl/said-21-oct', handoutFolder: 'said-21-oct', publishedAt: '2026-10-14T09:00:00Z', unpublishedAt: '2026-10-30T09:00:00Z',
    slideSet: { kind: 'pathway', pathwayId: 'short-45' }, answers: { pre: 7 }, pin: { fileId: 'intake' },
    work: {
      pre: { fileId: 'intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00', timeZone: 'Europe/London', publishedAt: '2026-10-14T09:00:00Z', pin: 'abc' },
      post: { fileId: 'feedback', opens: 'session-end', closes: '2026-11-04T17:00', timeZone: 'Europe/London' }
    }
  }
  const copy = copyDraftFromRun(source)
  assert.deepEqual(copy, { event: 'Saïd workshop', date: '', startTime: '14:00', expected: '18', audience: 'Research teams', slideSet: 'short-45',
    pre: { fileId: 'intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00' }, post: { fileId: 'feedback', opens: 'session-end', closes: '2026-11-04T17:00' } }, 'same event, slides, files and windows; date empty; nothing else carried')
  const json = JSON.stringify(copy)
  for (const gone of ['handouts.fyi', 'said-21-oct', 'publishedAt', 'unpublishedAt', 'pin', 'answers']) assert.ok(!json.includes(gone), `no ${gone} in the copy`)
  const moved = moveDraftToDate(copy, '2026-10-21', '2026-11-18')
  assert.equal(moved.date, '2026-11-18')
  assert.deepEqual([moved.pre.opens, moved.pre.closes, moved.post.opens, moved.post.closes], ['2026-11-11T09:00', '2026-11-18T13:00', 'session-end', '2026-12-02T17:00'], 'windows shift by the days between the dates, post-work still opens at the session end')
  assert.deepEqual(copyDraftFromRun(source, '2026-11-18'), moved, 'a date given at once equals copy then move')
  assert.deepEqual(moveDraftToDate(copy, '2026-10-21', '2026-09-30').pre.opens, '2026-09-23T09:00', 'earlier dates shift back')
  assert.deepEqual(moveDraftToDate(copy, '2026-10-21', '2026-10-21').pre, copy.pre, 'same date moves nothing')
  assert.equal(moveDraftToDate({ ...copy, pre: { ...copy.pre, opens: '' } }, '2026-10-21', '2026-11-18').pre.opens, '', 'an unset time stays unset')
  assert.equal(planFromDraft(copy, { phases: true, editing: false }).ok, false, 'the copy is not savable until a date is chosen')
  const planned = planFromDraft(moved, { phases: true, editing: false })
  assert.equal(planned.ok, true)
  assert.deepEqual(Object.keys(planned.fields).sort(), ['audience', 'eventTitle', 'expectedPeople', 'plannedDate', 'slideSet', 'startTime', 'work'], 'the saved fields carry no answers, pins or handout fields')
  assert.deepEqual(planned.fields.slideSet, { kind: 'pathway', pathwayId: 'short-45' })
  const plain = copyDraftFromRun({ id: 'x', talkSlug: 't', plannedDate: '2026-10-21', eventTitle: 'Plain' })
  assert.deepEqual([plain.pre.fileId, plain.post.fileId, plain.slideSet, plain.date], ['', '', 'full', ''], 'a Run without work files copies none')
  const markedCopy = copyDraftFromRun({ ...source, work: { ...source.work, pre: { ...source.work.pre, problem: 'zone-mismatch' } } })
  assert.equal(markedCopy.pre.fileId, '', 'a phase marked zone-mismatch is not copied')
  assert.equal(markedCopy.post.fileId, 'feedback')
  // Ticket 29: a talk's old {prework} section (legacy-section) is not copied; work files are.
  const legacyCopy = copyDraftFromRun({ ...source, preworkOpens: '2026-10-14T09:00', work: { ...source.work, pre: { fileId: 'legacy-section', opens: '2026-10-14T09:00', closes: '2026-10-21T14:00', timeZone: 'Europe/London' } } }, '2026-11-18')
  assert.deepEqual(legacyCopy.pre, { fileId: '', opens: '', closes: '' }, 'the old section is dropped: the copy has no pre-work, as if none was chosen')
  assert.deepEqual(legacyCopy.post, moved.post, 'post-work still copies with its window moved')
  const legacyPlan = planFromDraft(legacyCopy, { phases: true, editing: false })
  assert.equal(legacyPlan.ok, true)
  assert.equal('preworkOpens' in legacyPlan.fields || 'preworkCloses' in legacyPlan.fields, false, 'saving the copy sends no old window fields')
  assert.deepEqual(Object.keys(legacyPlan.fields.work), ['post'], 'only the work file is sent')
  assert.deepEqual(copyDraftFromRun(source, '2026-11-18').pre, moved.pre, 'a work-file pre-work still copies')
}

// Slide-set resolution for a Run with extra slides (work-files ticket 25): the pathway's slides in the pathway's
// order, each extra slide after its chosen slide (several after one slide keep their order), and one whose
// slide is not in the pathway at the end. The full talk's set is every slide; its extras are already in place.
{
  const rows = ['open', 'a', 'b', 'c', 'risks', 'x1', 'x2', 'x3'].map((id) => ({ slide_id: id }))
  const pathways = [{ id: 'short', name: 'Short', slideIds: ['risks', 'a', 'gone'] }]
  const set = resolveRunSlideSet({ kind: 'pathway', pathwayId: 'short' }, pathways, rows)
  assert.deepEqual(set.rows.map((row) => row.slide_id), ['risks', 'a'])
  assert.deepEqual(set.missing, ['gone'])
  const placed = [
    { id: 'x1', title: 'One', after: 'risks', placed: 'after' },
    { id: 'x2', title: 'Two', after: 'b', placed: 'end' },
    { id: 'x3', title: 'Three', after: 'risks', placed: 'after' },
  ]
  // The compile's final slide order (model.runExtras.order): x1 and x3 after risks, x2 at the end.
  const deckOrder = ['open', 'a', 'b', 'c', 'risks', 'x1', 'x3', 'x2']
  assert.deepEqual(withRunExtraIds(set.rows.map((row) => row.slide_id), { slides: placed, order: deckOrder }), ['risks', 'x1', 'x3', 'a', 'x2'],
    'a pathway in its own order keeps it; each extra follows the slide before it in the deck; an end extra goes last')
  // Work-files ticket 25: an "at the end" extra is not anchored to b, so it does not follow b when the pathway is reordered.
  assert.deepEqual(withRunExtraIds(['b', 'a'], { slides: [{ id: 'extra-end', title: 'End', after: 'b', placed: 'end' }], order: ['a', 'b', 'extra-end'] }),
    ['b', 'a', 'extra-end'], 'a reordered pathway: the end extra after everything, not after b')
  assert.deepEqual(withRunExtraIds(['a', 'risks'], { slides: placed, order: deckOrder }), ['a', 'risks', 'x1', 'x3', 'x2'],
    'a pathway in the deck\'s order: the deck\'s order filtered')
  assert.deepEqual(withRunExtraIds(['open', 'x1', 'a'], { slides: placed, order: deckOrder }), ['open', 'a', 'x1', 'x3', 'x2'],
    'an extra already in the list is placed from the deck\'s order, once')
  assert.deepEqual(withRunExtraIds(['risks', 'a'], { slides: placed }), ['risks', 'a'], 'no order (not a Run compile): the list as given')
  assert.deepEqual(resolveRunSlideSet({ kind: 'full' }, pathways, rows).rows.map((row) => row.slide_id), rows.map((row) => row.slide_id))
  // What the Run page says about each place.
  const runSlides = [{ id: 'risks', title: 'Risks and checks' }, { id: 'a', title: 'Opening' }]
  const talkSlides = [...runSlides, { id: 'b', title: 'Background' }]
  const views = extraSlideViews([
    { id: 'x1', title: 'One', text: '', after: 'a' },
    { id: 'x2', title: 'Two', text: '', after: 'b' },
    { id: 'x3', title: 'Three', text: '', after: 'gone' },
    { id: 'x4', title: 'Four', text: '', after: '' },
  ], runSlides, talkSlides)
  assert.deepEqual(views.map((view) => view.placed), ['after', 'end', 'end', 'end'])
  assert.deepEqual(views.map(extraSlidePlacement), [
    'Extra slide · after “Opening”',
    'Extra slide · at the end: “Background” is not in this run’s slides',
    'Extra slide · at the end: its slide is no longer in the talk',
    'Extra slide · at the end',
  ])

  // Each Run's slide set from its own Run record: placed after its chosen slide, at the end when that slide is
  // not in the talk or not in the pathway; a second Run of the talk sees none of the first Run's slides.
  const tree = () => ({ children: [
    { level: 2, id: 'open', attrs: {}, children: [{ level: 3, id: 'a', attrs: {}, children: [] }, { level: 3, id: 'b', attrs: {}, children: [] }] },
    { level: 2, id: 'risks', attrs: {}, children: [] },
  ] })
  const order = (root) => { const out = []; const walk = (nodes) => { for (const node of nodes) { out.push(node.id); walk(node.children || []) } }; walk(root.children); return out }
  const runRecord = (id, extraSlides, slideSet = { kind: 'full' }) => normaliseRun({ id, talkSlug: 't', talkTitle: 'T', status: 'planned', slideSet, startedAt: '', endedAt: '', extraSlides })
  const placeFor = (run, slideIds = null) => {
    const option = runCompileOption({ id: run.id, slideIds, extraSlides: run.extraSlides })
    const root = tree()
    return { placed: option ? placeRunExtraNodes(root, option) : [], order: order(root) }
  }
  const first = runRecord('run-1', [{ id: 'x1', title: 'After a', after: 'a' }, { id: 'x2', title: 'Nowhere', after: 'gone' }, { id: 'x3', title: 'No place' }])
  const second = runRecord('run-2', [{ id: 'y1', title: 'Second run', after: 'b' }])
  const one = placeFor(first)
  assert.deepEqual(one.order, ['open', 'a', 'x1', 'b', 'risks', 'x2', 'x3'])
  assert.deepEqual(one.placed.map((extra) => extra.placed), ['after', 'end', 'end'])
  const onPathway = placeFor(first, ['b', 'risks'])
  assert.deepEqual(onPathway.placed.map((extra) => extra.placed), ['end', 'end', 'end'], 'a slide not in the pathway: at the end')
  assert.deepEqual(withRunExtraIds(['b', 'risks'], { slides: onPathway.placed, order: onPathway.order }), ['b', 'risks', 'x1', 'x2', 'x3'])
  const two = placeFor(second)
  assert.deepEqual(two.order, ['open', 'a', 'b', 'y1', 'risks'], 'the second Run: its own slide only')
  assert.equal(two.order.some((id) => id.startsWith('x')), false)
  assert.deepEqual(placeFor(runRecord('run-3', [])).order, order(tree()), 'a Run without extra slides: the talk')
}

console.log('plan-run: dates, next Run, chips, sheet draft, work windows, delivered count, copy-plan, a Run\'s slide set with its extra slides passed')
