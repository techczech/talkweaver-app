// Work-files ticket 08: the editor's pre-work and post-work strips as a pure model (src/shared/work-strips.ts),
// one case per drawn state (hifi shots 1-*), with today = Wed 14 Oct 2026.
//   1. no file: "No pre-work" / "No post-work" with Attach a pre-work / post-work file;
//   2. attached, not sent: "Pre-work · Research teams intake · 4 steps · not sent to anyone" with Plan a run;
//      a Run that carries the file but is not published has sent it to no one;
//   3. sent to 1 run: the Run, its count and Open run; sent to 2 runs: "sent to 2 runs" and Open run listing both;
//   4. post-work: opens after the session, open ("Saïd workshop · 5/18 · closes Wed 4 Nov"), closed;
//   5. the zone-mismatch mark (ticket 03 review) on the strip and on that Run's row;
//   6. a file the talk names that is not in the vault; a file named by its file name; a Run of another talk is not counted;
//   7. (review round 1) sent is per phase (S1); Runs of the open talk's vault only, and Open run names that vault (S3);
//      the value is read as the Work files view reads it (S6); a file whose id is `true` (S7); Runs that could not be read (S10).
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-work-strips.mjs
import assert from 'node:assert/strict'
import { namedWorkFile, resolveWorkFile, workFileValue, workStrips } from '../src/shared/work-strips.ts'

const TZ = 'Europe/London'
const NOW = new Date('2026-10-14T10:00:00Z')
const T = 'ai-research'
const files = [
  { id: 'research-teams-intake', fileName: 'research-teams-intake.md', title: 'Research teams intake', steps: 4 },
  { id: 'session-feedback', fileName: 'session-feedback.md', title: 'Session feedback', steps: 3 },
  { id: '', fileName: 'loose-notes.md', title: 'Loose notes', steps: 1 },
]
const both = { prework: 'research-teams-intake', postwork: 'session-feedback' }
const pubd = '2026-10-14T08:00:00Z'
const pre = (extra = {}) => ({ fileId: 'research-teams-intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00', timeZone: TZ, ...extra })
const post = (extra = {}) => ({ fileId: 'session-feedback', opens: 'session-end', closes: '2026-11-04T17:00', timeZone: TZ, ...extra })
const run = (extra = {}) => ({
  talkSlug: T, runId: 'said', talkTitle: 'AI for research teams', eventTitle: 'Saïd workshop', status: 'planned', plannedDate: '2026-10-21', startTime: '14:00',
  expectedPeople: 18, timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/said', answers: { pre: 7 },
  work: { pre: pre({ publishedAt: pubd }), post: post({ publishedAt: pubd }) }, ...extra,
})
const med = (extra = {}) => run({ runId: 'med', eventTitle: 'Medical Sciences', plannedDate: '2026-11-04', expectedPeople: 24, answers: { pre: 0 }, ...extra })
const strips = (metadata, runs, over = {}) => workStrips({ talkSlug: T, metadata, files, runs, now: NOW, ...over })

// 1. No file named.
{
  const s = strips({}, [run()])
  assert.deepEqual([s.pre.text, s.post.text], ['No pre-work', 'No post-work'])
  assert.equal(s.pre.state, 'none'); assert.equal(s.pre.tone, 'none')
  assert.deepEqual(s.pre.action, { kind: 'attach', label: 'Attach a pre-work file' })
  assert.deepEqual(s.post.action, { kind: 'attach', label: 'Attach a post-work file' })
  assert.equal(strips({ prework: '', postwork: 'true' }, []).post.state, 'none', 'an empty value and the legacy true name no file')
}

// 2. Attached, not sent.
{
  const s = strips(both, [])
  assert.equal(s.pre.text, 'Pre-work · Research teams intake · 4 steps · not sent to anyone')
  assert.equal(s.post.text, 'Post-work · Session feedback · 3 steps · not sent to anyone')
  assert.equal(s.pre.state, 'not-sent'); assert.equal(s.pre.tone, 'not-sent')
  assert.deepEqual(s.pre.action, { kind: 'plan-run', label: 'Plan a run' })
  // A Run that carries the file but is not published has sent it to no one.
  const unpublished = run({ handoutUrl: undefined, work: { pre: pre(), post: post() } })
  const u = strips(both, [unpublished])
  assert.equal(u.pre.status, 'not sent to anyone'); assert.equal(u.post.status, 'not sent to anyone')
  // Published, then unpublished: not sent either.
  const gone = run({ handoutUrl: undefined, work: { pre: pre({ publishedAt: pubd, unpublishedAt: '2026-10-14T09:00:00Z' }) } })
  assert.equal(strips(both, [gone]).pre.status, 'not sent to anyone')
  assert.equal(strips({ prework: 'research-teams-intake' }, []).post.state, 'none', 'phases are independent')
}

// 3. Sent to 1 run, then 2.
{
  const s = strips(both, [run()])
  assert.equal(s.pre.text, 'Pre-work · Research teams intake · 4 steps · sent to Saïd workshop · 7/18')
  assert.equal(s.pre.tone, 'sent'); assert.equal(s.pre.state, 'sent')
  assert.deepEqual(s.pre.action, { kind: 'open-run', label: 'Open run', ref: { talkSlug: T, runId: 'said' } })
  assert.equal(s.post.text, 'Post-work · Session feedback · 3 steps · sent to Saïd workshop · opens after the session')

  const two = strips(both, [med({ work: { pre: pre({ publishedAt: pubd, closes: '2026-11-04T13:00' }), post: post({ publishedAt: pubd }) } }), run()])
  assert.equal(two.pre.text, 'Pre-work · Research teams intake · 4 steps · sent to 2 runs')
  assert.equal(two.post.text, 'Post-work · Session feedback · 3 steps · sent to 2 runs · opens after each session')
  assert.equal(two.pre.action.kind, 'open-run-menu')
  assert.deepEqual(two.pre.action.rows.map((r) => [r.name, r.detail]), [['Saïd workshop', 'Wed 21 Oct · 7/18'], ['Medical Sciences', 'Wed 4 Nov · 0/24']], 'listed by date, with the drawn detail')
  assert.deepEqual(two.pre.action.rows.map((r) => r.ref.runId), ['said', 'med'])
  // One sent, one only planned: the strip names the sent one.
  const mixed = strips(both, [med({ handoutUrl: undefined, work: { pre: pre(), post: post() } }), run()])
  assert.equal(mixed.pre.status, 'sent to Saïd workshop · 7/18')
  // No expected figure: just the count.
  assert.equal(strips(both, [run({ expectedPeople: undefined })]).pre.status, 'sent to Saïd workshop · 7')
  // A Run with no event name is named by its talk.
  assert.equal(strips(both, [run({ eventTitle: undefined })]).pre.status, 'sent to AI for research teams · 7/18')
}

// 4. Post-work open and closed (the Run is delivered).
{
  // Post-work that opens when the session ends is open once its opening was pushed and noted (ticket 19).
  const delivered = (extra = {}) => run({ status: 'delivered', endedAt: '2026-10-21T15:00:00Z', answers: { pre: 16, post: 5 },
    work: { pre: pre({ publishedAt: pubd }), post: post({ publishedAt: pubd, openedAt: '2026-10-21T15:00:00Z' }) }, ...extra })
  const open = strips(both, [delivered()], { now: new Date('2026-10-22T10:00:00Z') })
  assert.equal(open.post.text, 'Post-work · Session feedback · 3 steps · Saïd workshop · 5/18 · closes Wed 4 Nov')
  assert.equal(open.pre.status, 'sent to Saïd workshop · 16/18')
  assert.deepEqual(open.post.action, { kind: 'open-run', label: 'Open run', ref: { talkSlug: T, runId: 'said' } })
  const closed = strips(both, [delivered()], { now: new Date('2026-11-05T10:00:00Z') })
  assert.equal(closed.post.status, 'sent to Saïd workshop · closed 5/18')
  // Before the session is delivered the post-work is not open, whatever the date.
  assert.equal(strips(both, [run()], { now: new Date('2026-11-01T10:00:00Z') }).post.status, 'sent to Saïd workshop · opens after the session')
  // A fixed opening time is named.
  const timed = run({ work: { pre: pre({ publishedAt: pubd }), post: post({ opens: '2026-10-22T09:00', publishedAt: pubd }) } })
  assert.equal(strips(both, [timed]).post.status, 'sent to Saïd workshop · opens Thu 22 Oct')
  // Two Runs, one with the post-work open.
  const mixed = strips(both, [delivered(), med()], { now: new Date('2026-10-22T10:00:00Z') })
  assert.equal(mixed.post.status, 'sent to 2 runs · 1 open')
}

// 5. The zone-mismatch mark.
{
  const marked = run({ work: { pre: pre({ publishedAt: pubd, problem: 'zone-mismatch' }), post: post({ publishedAt: pubd }) } })
  const s = strips(both, [marked])
  assert.equal(s.pre.mark, 'zone-mismatch')
  assert.equal(s.pre.text, 'Pre-work · Research teams intake · 4 steps · sent to Saïd workshop · 7/18 · time zone does not match the Run')
  assert.equal(s.post.mark, undefined, 'the mark belongs to the phase whose attachment carries it')
  assert.equal(s.post.text, 'Post-work · Session feedback · 3 steps · sent to Saïd workshop · opens after the session')
  const two = strips(both, [marked, med({ work: { pre: pre({ publishedAt: pubd }) } })])
  assert.deepEqual(two.pre.action.rows.map((r) => r.mark), ['zone-mismatch', undefined], 'the mark is on that Run’s row only')
  // A marked attachment on a Run that is not published still shows the mark; it is not "sent".
  const notSent = strips(both, [run({ handoutUrl: undefined, work: { pre: pre({ problem: 'zone-mismatch' }) } })])
  assert.equal(notSent.pre.state, 'not-sent'); assert.equal(notSent.pre.mark, 'zone-mismatch')
}

// 6. Odd inputs.
{
  const missing = strips({ prework: 'no-such-file' }, [])
  assert.equal(missing.pre.text, 'Pre-work · no-such-file · file not found')
  assert.deepEqual(missing.pre.action, { kind: 'attach', label: 'Choose a file' })
  // A file with no id is named by its file name (with or without .md, quoted or not).
  assert.equal(strips({ prework: '"loose-notes.md"' }, []).pre.text, 'Pre-work · Loose notes · 1 step · not sent to anyone')
  assert.equal(strips({ prework: 'loose-notes' }, [run({ work: { pre: pre({ fileId: 'loose-notes', publishedAt: pubd }) } })]).pre.status, 'not sent to anyone', 'Runs match by id only')
  // Another talk's Run is not this talk's.
  assert.equal(strips(both, [run({ talkSlug: 'other-talk' })]).pre.status, 'not sent to anyone')
  // Helpers.
  assert.equal(namedWorkFile(" 'a.md' "), 'a'); assert.equal(namedWorkFile(undefined), '')
  assert.equal(workFileValue(files[0]), 'research-teams-intake')
  assert.equal(workFileValue(files[2]), '', 'a file with no id has no value to write: a Run could not carry it (S9)')
  assert.equal(resolveWorkFile('research-teams-intake.md', files)?.title, 'Research teams intake')
  assert.equal(resolveWorkFile('nope', files), null)
}
// 7a. S1: sent is that phase's own publish stamp on that Run, for that file.
{
  // Pre-work published alone, post-work attached afterwards: the post-work has not been sent.
  const preOnly = run({ work: { pre: pre({ publishedAt: pubd }), post: post() } })
  const a = strips(both, [preOnly])
  assert.equal(a.pre.state, 'sent')
  assert.equal(a.post.state, 'not-sent'); assert.equal(a.post.status, 'not sent to anyone')
  // Pre-work swapped A → B on a published Run (re-planning drops the stamps): B has not been sent.
  const swapped = run({ work: { pre: pre({ fileId: 'session-feedback' }), post: post({ publishedAt: pubd }) } })
  assert.equal(strips({ prework: 'session-feedback' }, [swapped]).pre.status, 'not sent to anyone', 'the new file was never published')
  assert.equal(strips({ prework: 'research-teams-intake' }, [swapped]).pre.status, 'not sent to anyone', 'the old file is no longer on the Run')
  // An old Run with a handout link and no stamps has sent no work file.
  const old = run({ work: { pre: pre(), post: post() } })
  assert.equal(old.handoutUrl, 'https://handouts.fyi/dl/said')
  assert.deepEqual([strips(both, [old]).pre.state, strips(both, [old]).post.state], ['not-sent', 'not-sent'])
  // Unpublished after: not sent; published again after the unpublish: sent.
  const again = run({ work: { pre: pre({ publishedAt: '2026-10-14T09:30:00Z', unpublishedAt: '2026-10-14T09:00:00Z' }) } })
  assert.equal(strips(both, [again]).pre.state, 'sent')
  // One phase unpublished, the other still published: each strip reads its own phase.
  const half = run({ work: { pre: pre({ publishedAt: pubd, unpublishedAt: '2026-10-14T09:00:00Z' }), post: post({ publishedAt: pubd }) } })
  assert.deepEqual([strips(both, [half]).pre.state, strips(both, [half]).post.state], ['not-sent', 'sent'])
}

// 7b. S3: only the open talk's vault counts, and Open run names the vault.
{
  const here = run({ vaultId: 'v1' })
  const there = med({ vaultId: 'v2' })
  const s = strips(both, [here, there], { vaultId: 'v1' })
  assert.equal(s.pre.status, 'sent to Saïd workshop · 7/18', 'the same talk in another vault is another talk')
  assert.deepEqual(s.pre.action, { kind: 'open-run', label: 'Open run', ref: { talkSlug: T, runId: 'said', vaultId: 'v1' } })
  assert.equal(strips(both, [there], { vaultId: 'v1' }).pre.status, 'not sent to anyone')
  assert.equal(strips(both, [here, there]).pre.status, 'sent to 2 runs', 'with no vault known, every vault counts (as the status chip does)')
}

// 7c. S6: the value is read as the Work files view reads it (work-file-name.ts).
{
  assert.equal(strips({ prework: 'research-teams-intake # the intake' }, []).pre.text, 'Pre-work · Research teams intake · 4 steps · not sent to anyone')
  assert.equal(strips({ prework: 'research-teams-intake" # note' }, []).pre.fileName, 'Research teams intake', 'as the shared reader hands a quoted value with a comment')
  const dup = [...files, { id: 'research-teams-intake', fileName: 'copy.md', title: 'Copy', steps: 2 }]
  const d = strips({ prework: 'research-teams-intake' }, [run()], { files: dup })
  assert.equal(d.pre.state, 'missing'); assert.equal(d.pre.text, 'Pre-work · research-teams-intake · more than one work file has this id')
  assert.equal(resolveWorkFile('research-teams-intake', dup), null, 'an id two files share names neither, as in the Work files view')
  // A file with no id is not named by its file name when another file has that name as its id.
  const shadow = [{ id: 'loose-notes', fileName: 'other.md', title: 'Other', steps: 2 }, { id: '', fileName: 'loose-notes.md', title: 'Loose notes', steps: 1 }]
  assert.equal(resolveWorkFile('loose-notes', shadow)?.title, 'Other')
}

// 7d. S7: `true` / `false` name a file only when one has that id.
{
  const truthy = [...files, { id: 'true', fileName: 'true.md', title: 'True story', steps: 2 }]
  assert.equal(strips({ prework: 'true' }, [], { files: truthy }).pre.text, 'Pre-work · True story · 2 steps · not sent to anyone')
  assert.equal(strips({ prework: 'true' }, []).pre.state, 'none', 'with no such file it is the 0.39 switch')
  assert.equal(strips({ postwork: 'false' }, []).post.state, 'none')
}

// 7e. S10: Runs that could not be read are not "not sent to anyone".
{
  const s = strips(both, null)
  assert.equal(s.pre.state, 'runs-unknown')
  assert.equal(s.pre.text, 'Pre-work · Research teams intake · 4 steps · could not read Runs')
  assert.equal(s.post.text, 'Post-work · Session feedback · 3 steps · could not read Runs')
  assert.equal(strips({}, null).pre.state, 'none', 'with nothing named, the Runs do not matter')
  assert.equal(strips({ prework: 'no-such-file' }, null).pre.state, 'missing')
}

console.log('work strips: every drawn state, the zone-mismatch mark, the odd inputs and review round 1 hold')
