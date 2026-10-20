// Work-files ticket 09: the Sessions list model (src/shared/sessions-list.ts), on the four drawn example
// Runs (hifi shots 7-*) with today = Wed 14 Oct 2026.
//   1. unfiltered: Upcoming (Saïd, Keble, Medical Sciences) then Past (ITLC), with the drawn pills and progress;
//   2. each filter shows exactly the drawn rows (Upcoming, Live now, Past, Published only);
//   3. post-work open moves a delivered Run under Past with "post-work 5/18"; post-work closed reads "post-work closed";
//   4. ordering across vaults, a planned Run whose day has gone, a rehearsal left out, an unplanned delivered Run;
//   5. the empty list;
//   6. (2026-10-19 prework-responses) new responses per Run: the row's "N new", the Responses waiting filter and
//      its count, the rail badge; collectSessions adds what waits on the live service to what is new on the Run.
//   7. (2026-10-19 sessions title markdown) a talk title with **bold** shows as plain text (talkTitleText).
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-sessions-list.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { responsesBadge, runsWithResponses, selectSessionRow, sessionList, sessionLiveKey } from '../src/shared/sessions-list.ts'
import { collectSessions } from '../src/main/sessions-list.ts'

const TZ = 'Europe/London'
const NOW = new Date('2026-10-14T10:00:00Z')
const T1 = 'AI for research teams'
const T2 = 'Generative AI in teaching'
const pubd = '2026-10-14T08:00:00Z'
const pre = (opens, closes, extra = {}) => ({ fileId: 'research-teams-intake', opens, closes, timeZone: TZ, ...extra })
const post = (closes, extra = {}) => ({ fileId: 'session-feedback', opens: 'session-end', closes, timeZone: TZ, ...extra })

const said = (extra = {}) => ({
  vaultId: 'v1', talkSlug: 'ai-research', runId: 'said', talkTitle: T1, eventTitle: 'Saïd workshop', status: 'planned', plannedDate: '2026-10-21', startTime: '14:00',
  expectedPeople: 18, timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/said-21-oct', answers: { pre: 7 },
  work: { pre: pre('2026-10-14T09:00', '2026-10-21T13:00', { publishedAt: pubd }), post: post('2026-11-04T17:00', { publishedAt: pubd }) }, ...extra
})
const OPENED = { pre: pre('2026-10-14T09:00', '2026-10-21T13:00', { publishedAt: pubd }), post: post('2026-11-04T17:00', { publishedAt: pubd, openedAt: '2026-10-21T15:00:00Z' }) }
const keble = () => ({
  vaultId: 'v1', talkSlug: 'ai-teaching', runId: 'keble', talkTitle: T2, eventTitle: 'Keble', status: 'planned', plannedDate: '2026-10-28', startTime: '16:00',
  expectedPeople: 40, timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/keble-28-oct', answers: { pre: 31 },
  work: { pre: pre('2026-10-12T09:00', '2026-10-28T15:00', { publishedAt: '2026-10-12T08:00:00Z' }) }
})
const med = () => ({
  vaultId: 'v1', talkSlug: 'ai-research', runId: 'med', talkTitle: T1, eventTitle: 'Medical Sciences', status: 'planned', plannedDate: '2026-11-04', startTime: '10:00',
  expectedPeople: 24, timeZone: TZ, work: { pre: pre('2026-10-28T09:00', '2026-11-04T09:00') }
})
const itlc = () => ({
  vaultId: 'v1', talkSlug: 'ai-teaching', runId: 'itlc', talkTitle: T2, eventTitle: 'ITLC lunchtime', status: 'delivered', plannedDate: '2026-10-09', startTime: '12:30',
  expectedPeople: 15, timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/itlc-9-oct', answers: { pre: 12 }, endedAt: '2026-10-09T12:20:00Z',
  work: { pre: pre('2026-10-01T09:00', '2026-10-09T11:30', { publishedAt: '2026-10-01T08:00:00Z' }) }
})
const four = [keble(), itlc(), med(), said()] // deliberately not in order

const show = (list) => list.groups.map((g) => `${g.label}: ${g.rows.map((r) => r.name).join(', ')}`).join(' | ')
let failures = 0
const check = (name, fn) => { try { fn(); console.log(`PASS  ${name}`) } catch (e) { failures += 1; console.log(`FAIL  ${name}\n  ${e.message}`) } }

check('unfiltered: Upcoming then Past, soonest first', () => {
  const list = sessionList(four, NOW)
  assert.equal(show(list), 'Upcoming: Saïd workshop, Keble, Medical Sciences | Past: ITLC lunchtime')
  assert.equal(list.total, 4)
})

check('rows carry the drawn text', () => {
  const rows = Object.fromEntries(sessionList(four, NOW).rows.map((r) => [r.name, r]))
  assert.deepEqual([rows['Saïd workshop'].when, rows['Saïd workshop'].pill, rows['Saïd workshop'].progress, rows['Saïd workshop'].talk],
    ['Wed 21 Oct · 14:00', { kind: 'green', label: 'Published' }, 'pre-work 7/18', T1])
  assert.deepEqual([rows.Keble.when, rows.Keble.pill.label, rows.Keble.progress], ['Wed 28 Oct · 16:00', 'Published', 'pre-work 31/40'])
  assert.deepEqual([rows['Medical Sciences'].when, rows['Medical Sciences'].pill, rows['Medical Sciences'].progress], ['Wed 4 Nov · 10:00', { kind: 'grey', label: 'Not published' }, 'pre-work not open'])
  assert.deepEqual([rows['ITLC lunchtime'].when, rows['ITLC lunchtime'].pill, rows['ITLC lunchtime'].progress], ['Fri 9 Oct · 12:30', { kind: 'blue', label: 'Delivered' }, 'pre-work closed 12/15'])
})

check('Upcoming filter', () => assert.equal(show(sessionList(four, NOW, { filter: 'upcoming' })), 'Upcoming: Saïd workshop, Keble, Medical Sciences'))
check('Past filter', () => assert.equal(show(sessionList(four, NOW, { filter: 'past' })), 'Past: ITLC lunchtime'))
check('Published only keeps both groups', () => assert.equal(show(sessionList(four, NOW, { filter: 'published' })), 'Upcoming: Saïd workshop, Keble | Past: ITLC lunchtime'))
check('Live now with nothing live is empty', () => assert.equal(sessionList(four, NOW, { filter: 'live' }).groups.length, 0))

check('Live now: the live Run, headed Live now, pre-work closed 16/18', () => {
  const at = new Date('2026-10-21T13:30:00Z') // 14:30 BST, session running
  const live = new Set([sessionLiveKey('v1', { talkSlug: 'ai-research', runId: 'said' })])
  const list = sessionList([said({ answers: { pre: 16 } }), keble()], at, { filter: 'live', live })
  assert.equal(show(list), 'Live now: Saïd workshop')
  const row = list.rows[0]
  assert.deepEqual([row.pill, row.progress, row.live], [{ kind: 'red', label: 'Live now' }, 'pre-work closed 16/18', true])
  assert.equal(show(sessionList([said(), keble()], at, { live })).startsWith('Upcoming: Saïd workshop'), true) // unfiltered: live sits under Upcoming
})

check('post-work open: delivered Run moves under Past with "post-work 5/18"', () => {
  const at = new Date('2026-10-21T16:00:00Z')
  // Post-work that opens when the session ends is open once its opening was pushed and noted (ticket 19).
  const delivered = said({ status: 'delivered', answers: { pre: 16, post: 5 }, endedAt: '2026-10-21T15:00:00Z', work: OPENED })
  const list = sessionList([delivered, keble(), med(), itlc()], at)
  assert.equal(show(list), 'Upcoming: Keble, Medical Sciences | Past: Saïd workshop, ITLC lunchtime')
  const row = list.rows.find((r) => r.name === 'Saïd workshop')
  assert.deepEqual([row.progress, row.phase, row.pill.label], ['post-work 5/18', 'post-open', 'Delivered'])
  assert.equal(show(sessionList([delivered, keble()], at, { filter: 'upcoming' })), 'Upcoming: Keble')
  assert.equal(show(sessionList([delivered, keble()], at, { filter: 'past' })), 'Past: Saïd workshop')
})

check('post-work closed reads "post-work closed 5/18"', () => {
  const at = new Date('2026-11-05T10:00:00Z')
  const row = sessionList([said({ status: 'delivered', answers: { pre: 16, post: 5 }, endedAt: '2026-10-21T15:00:00Z', work: OPENED })], at).rows[0]
  assert.equal(row.progress, 'post-work closed 5/18')
})

check('Past is latest first; a planned Run whose day has gone is Past; a rehearsal is left out', () => {
  const old = { ...med(), runId: 'old', eventTitle: 'Old plan', plannedDate: '2026-09-01' }
  const rehearsal = { ...itlc(), runId: 'rehearsal', eventTitle: 'Rehearsal', kind: 'rehearsal' }
  const list = sessionList([itlc(), old, rehearsal, said()], NOW)
  assert.equal(show(list), 'Upcoming: Saïd workshop | Past: ITLC lunchtime, Old plan')
  assert.equal(list.total, 3)
})

check('Runs from two vaults interleave by date; the key keeps them apart', () => {
  const other = { ...keble(), vaultId: 'v2', runId: 'said' , talkSlug: 'ai-research', eventTitle: 'Other vault, same ids', plannedDate: '2026-10-22' }
  const list = sessionList([said(), other], NOW)
  assert.deepEqual(list.rows.map((r) => r.name), ['Saïd workshop', 'Other vault, same ids'])
  assert.notEqual(list.rows[0].key, list.rows[1].key)
})

check('a talk title with inline Markdown shows as plain text on the row (the name and the talk line); the same helper as the Talks list', () => {
  const list = sessionList([{ ...said(), talkTitle: 'TalkWeaver **Pre-work Workshop**', eventTitle: undefined }], NOW)
  assert.deepEqual([list.rows[0].name, list.rows[0].talk], ['TalkWeaver Pre-work Workshop', 'TalkWeaver Pre-work Workshop'])
})

check('an unplanned delivered Run is dated from when it started; no event title falls back to the talk', () => {
  const run = { vaultId: 'v1', talkSlug: 'ai-teaching', runId: 'r1', talkTitle: T2, status: 'delivered', kind: 'delivery', startedAt: '2026-10-02T13:05:00Z', timeZone: TZ }
  const row = sessionList([run], NOW).rows[0]
  assert.deepEqual([row.name, row.when, row.progress, row.pill.label], [T2, 'Fri 2 Oct · 14:05', '', 'Delivered'])
})

check('no Runs: empty list', () => {
  const list = sessionList([], NOW)
  assert.deepEqual([list.groups, list.rows, list.total], [[], [], 0])
})

check('collectSessions reads every vault, skips rehearsals, counts people, and marks live Runs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tw-sessions-list-'))
  const put = (vault, slug, run) => {
    mkdirSync(join(tmp, vault, '_PRESENTATIONS', slug), { recursive: true })
    writeFileSync(join(tmp, vault, '_PRESENTATIONS', slug, `${run.id}.json`), JSON.stringify({ talkTitle: slug, kind: 'delivery', ...run }))
  }
  put('a', 'talk-a', { id: 'r1', talkSlug: 'talk-a', status: 'planned', plannedDate: '2026-10-21', startTime: '14:00', expectedPeople: 18, eventTitle: 'One', prework: { entries: [], people: 7 } })
  put('a', 'talk-a', { id: 'rh', talkSlug: 'talk-a', status: 'delivered', kind: 'rehearsal', startedAt: '2026-10-01T10:00:00Z' })
  put('b', 'talk-b', { id: 'r2', talkSlug: 'talk-b', status: 'planned', plannedDate: '2026-10-22', eventTitle: 'Two' })
  const out = collectSessions([{ id: 'va', root: join(tmp, 'a') }, { id: 'vb', root: join(tmp, 'b') }, { id: 'vc', root: join(tmp, 'missing') }], [{ talkSlug: 'talk-b', runId: 'r2', vaultRoot: join(tmp, 'b') }])
  assert.deepEqual(out.runs.map((r) => [r.vaultId, r.runId]).sort(), [['va', 'r1'], ['vb', 'r2']])
  assert.equal(out.runs.find((r) => r.runId === 'r1').answers.pre, 7)
  assert.deepEqual(out.live, ['vb|talk-b/r2'])
  const list = sessionList(out.runs, NOW, { live: new Set(out.live) })
  assert.deepEqual(list.rows.map((r) => [r.name, r.live]), [['One', false], ['Two', true]])
})

check('collectSessions carries the sent set main computes (ticket 17, D1), and a failing one never blanks the list', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tw-sessions-sent-'))
  mkdirSync(join(tmp, 'a', '_PRESENTATIONS', 'talk-a'), { recursive: true })
  for (const id of ['r1', 'r2']) writeFileSync(join(tmp, 'a', '_PRESENTATIONS', 'talk-a', `${id}.json`), JSON.stringify({ id, talkSlug: 'talk-a', talkTitle: 'A', kind: 'delivery', status: 'planned', plannedDate: '2026-10-21' }))
  const out = collectSessions([{ id: 'va', root: join(tmp, 'a') }], [], (run) => { if (run.id === 'r2') throw new Error('unreadable'); return ['pre'] })
  assert.deepEqual(out.runs.map((r) => [r.runId, r.sent]).sort(), [['r1', ['pre']], ['r2', undefined]])
})

check('responses waiting: the row says "N new", the filter keeps only those Runs and counts them, the rail badge counts Runs', () => {
  const sources = [said({ responses: 12 }), keble({}), med(), itlc()]
  sources[1].responses = 4
  const list = sessionList(sources, NOW)
  const rows = Object.fromEntries(list.rows.map((r) => [r.name, r]))
  assert.deepEqual([responsesBadge(rows['Saïd workshop']), responsesBadge(rows.Keble), responsesBadge(rows['Medical Sciences'])], ['12 new', '4 new', ''])
  assert.equal(list.waiting, 2)
  const only = sessionList(sources, NOW, { filter: 'responses' })
  assert.equal(show(only), 'Upcoming: Saïd workshop, Keble')
  assert.equal(only.waiting, 2, 'the chip counts whatever the filter')
  assert.equal(runsWithResponses([...sources, { kind: 'rehearsal', responses: 3 }]), 2, 'a rehearsal is not counted')
})

check('collectSessions: new responses are what waits on the live service plus what was pulled and not seen', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tw-sessions-responses-'))
  mkdirSync(join(tmp, 'a', '_PRESENTATIONS', 'talk-a'), { recursive: true })
  const person = (n) => n.toString(16).padStart(16, '0')
  const entry = (n, kind, at) => ({ id: `${person(n)}:${kind === 'question' ? `q:s${n}` : `${kind}:hope`}`, participant: person(n), stepId: 'hope', kind, at, ...(kind === 'answer' || kind === 'question' ? { text: 'x' } : {}) })
  const prework = { entries: [entry(1, 'answer', 100), entry(2, 'answer', 300), entry(3, 'read', 400), entry(4, 'question', 500)], seen: { through: 200, at: 250 } }
  for (const [id, extra] of [['r1', { prework }], ['r2', {}]]) writeFileSync(join(tmp, 'a', '_PRESENTATIONS', 'talk-a', `${id}.json`), JSON.stringify({ id, talkSlug: 'talk-a', talkTitle: 'A', kind: 'delivery', status: 'planned', plannedDate: '2026-10-21', ...extra }))
  const out = collectSessions([{ id: 'va', root: join(tmp, 'a') }], [], undefined, (run, root) => { assert.equal(root, join(tmp, 'a')); if (run.id === 'r2') throw new Error('unreadable'); return 5 })
  assert.deepEqual(out.runs.map((r) => [r.runId, r.responses]).sort(), [['r1', 7], ['r2', undefined]], '5 waiting + 2 pulled and not seen (a read is progress, not a response)')
})

check('a Run reference selects by vault, talk and Run id; never the first of two vaults\' same-slug Runs (review round 1, finding 2)', () => {
  const list = sessionList([said(), said({ vaultId: 'v2', eventTitle: 'Saïd in vault two' })], NOW)
  assert.deepEqual(list.rows.map((row) => row.ref.vaultId).sort(), ['v1', 'v2'], 'each row\'s reference names its vault')
  assert.equal(selectSessionRow(list.rows, { vaultId: 'v2', talkSlug: 'ai-research', runId: 'said' }).name, 'Saïd in vault two', 'vault two\'s Run, not the first match')
  assert.equal(selectSessionRow(list.rows, { vaultId: 'v1', talkSlug: 'ai-research', runId: 'said' }).name, 'Saïd workshop')
  assert.equal(selectSessionRow(list.rows, { talkSlug: 'ai-research', runId: 'said' }), null, 'no vault and two matches: nothing selected')
  assert.equal(selectSessionRow(list.rows, { vaultId: 'v3', talkSlug: 'ai-research', runId: 'said' }), null, 'a vault that holds no such Run: nothing')
  const one = sessionList([said()], NOW)
  assert.equal(selectSessionRow(one.rows, { talkSlug: 'ai-research', runId: 'said' }).vaultId, 'v1', 'no vault and one match: that Run')
  assert.equal(selectSessionRow(one.rows, null), null)
})

// Issue 256, finding 4: two open vaults hold the same talk and Run id; a session live in one marks only that vault's Run.
check('two vaults with the same talk and Run id: only the vault whose session is live shows Live now', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tw-sessions-live-two-'))
  const run = { id: 'r1', talkSlug: 'talk-x', talkTitle: 'X', kind: 'delivery', status: 'planned', plannedDate: '2026-10-21', startTime: '14:00' }
  for (const vault of ['a', 'b']) {
    mkdirSync(join(tmp, vault, '_PRESENTATIONS', 'talk-x'), { recursive: true })
    writeFileSync(join(tmp, vault, '_PRESENTATIONS', 'talk-x', 'r1.json'), JSON.stringify({ ...run, eventTitle: `In ${vault}` }))
  }
  const vaults = [{ id: 'va', root: join(tmp, 'a') }, { id: 'vb', root: join(tmp, 'b') }]
  const out = collectSessions(vaults, [{ talkSlug: 'talk-x', runId: 'r1', vaultRoot: join(tmp, 'b') }])
  assert.deepEqual(out.live, ['vb|talk-x/r1'], 'the live key names the session\'s vault')
  const list = sessionList(out.runs, NOW, { live: new Set(out.live) })
  assert.deepEqual(list.rows.map((r) => [r.name, r.live]).sort(), [['In a', false], ['In b', true]], 'only vault B\'s copy is live')
  // A session whose vault is not open, or that recorded none, marks no Run.
  assert.deepEqual(collectSessions(vaults, [{ talkSlug: 'talk-x', runId: 'r1', vaultRoot: join(tmp, 'c') }, { talkSlug: 'talk-x', runId: 'r1', vaultRoot: null }]).live, [])
  rmSync(tmp, { recursive: true, force: true })
})

if (failures) { console.log(`\n${failures} failed`); process.exit(1) }
console.log('\nall passed')
