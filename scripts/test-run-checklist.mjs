// Work-files ticket 04: the Run checklist state machine (src/shared/run-checklist.ts).
//   1. one table case per drawn Run state (hifi shots 3-*): Saïd (not published, publishing, published,
//      unpublished, pre-work closed, post-work open), Medical Sciences (before pre-work opens), Keble, ITLC (delivered, 6 of 6);
//   2. a post-only Run has no "Pre-work ready" and no "Pre-work closes"; a Run with no files has neither phase;
//   3. live: "Delivered" is "Live now" with Open live view; Results are disabled before the session, enabled while live;
//   4. a blocking finding makes "Pre-work ready" current, with the finding and Open file;
//   5. publication transitions, the QR choice, the pill, and the zone: times are read in the attachment's zone;
//   6. ticket 16: runQrTarget, the work page links (no doubled slash), and runInvitationText (both links);
//   7. ticket 17: an unpublished Run's "N answers kept" counts pre-work and post-work answers together;
//   8. ticket 19: post-work that opens when the session ends is open from its noted opening (`openedAt`), not
//      from "delivered"; a set-time post-work opens at its time whether or not the Run is delivered; a later
//      closing time makes a closed phase current again; ticket 19 review: an opening still to come is not open,
//      an unpublished Run's post-work is not open, and past its closing time with no opening it reads closed,
//      never opened, and Results kept goes on.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-run-checklist.mjs
import assert from 'node:assert/strict'
import { answersKept, runChecklist, localTimeIn, whenLabel, runQrTarget } from '../src/shared/run-checklist.ts'
import { runInvitationText } from '../src/shared/run-invitation.ts'
import { workPageUrl } from '../src/shared/run-work.ts'

const TZ = 'Europe/London'
const PRE_OK = { title: 'Research teams intake', steps: 4 }
const POST_OK = { title: 'Session feedback', steps: 3 }
const at = (iso) => new Date(iso)

const said = (extra = {}, workExtra = {}) => ({
  status: 'planned', plannedDate: '2026-10-21', startTime: '14:00', expectedPeople: 18, timeZone: TZ,
  work: {
    pre: { fileId: 'research-teams-intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00', timeZone: TZ, ...(workExtra.pre ?? {}) },
    post: { fileId: 'session-feedback', opens: 'session-end', closes: '2026-11-04T17:00', timeZone: TZ, ...(workExtra.post ?? {}) }
  },
  ...extra
})
const PUBLISHED = { pre: { publishedAt: '2026-10-14T08:00:00Z' }, post: { publishedAt: '2026-10-14T08:00:00Z' } }
const FILES = { pre: PRE_OK, post: POST_OK }
/** Ticket 19: post-work that opens when the session ends is open once the app pushed its opening and noted it. */
const OPENED = { pre: PUBLISHED.pre, post: { ...PUBLISHED.post, openedAt: '2026-10-21T14:58:00Z' } }
const brief = (c) => c.steps.map((s) => `${s.id}:${s.state}`).join(' ')

const cases = [
  {
    name: 'Saïd, not published', run: said(), now: '2026-10-13T10:00:00Z', opts: { files: FILES },
    steps: 'planned:done pre-ready:done published:current pre-closes:todo delivered:todo post-open:todo post-closes:todo results:todo',
    counter: '2 of 8', publication: 'not-published', phase: 'planned', pill: ['grey', 'Not published'],
    details: { planned: '18 expected · Europe/London', 'pre-ready': '4 steps · file “Research teams intake”', published: 'Not published', 'pre-closes': 'Wed 21 Oct 13:00 · opens Wed 14 Oct 09:00', delivered: 'Wed 21 Oct · 14:00', 'post-open': 'When the session ends · 3 steps · file “Session feedback”', 'post-closes': 'Wed 4 Nov 17:00' },
    actions: { published: ['publish', 'preview-page'], delivered: ['go-live', 'mark-delivered'], results: ['open-results!'] }
  },
  {
    name: 'Saïd, publishing', run: said(), now: '2026-10-13T10:00:00Z', opts: { files: FILES, publishing: true },
    steps: 'planned:done pre-ready:done published:current pre-closes:todo delivered:todo post-open:todo post-closes:todo results:todo',
    counter: '2 of 8', publication: 'publishing', phase: 'publishing', pill: ['blue', 'Publishing…'],
    details: { published: 'Publishing…' }, actions: { published: ['publish!'] }
  },
  {
    name: 'Saïd, published (pre-work open)', run: said({ handoutUrl: 'https://handouts.fyi/dl/said-21-oct' }, PUBLISHED), now: '2026-10-15T10:00:00Z', opts: { files: FILES },
    steps: 'planned:done pre-ready:done published:done pre-closes:current delivered:todo post-open:todo post-closes:todo results:todo',
    counter: '3 of 8', publication: 'published', phase: 'published', pill: ['green', 'Published'],
    details: { published: 'Since Wed 14 Oct 09:00', 'pre-closes': 'Wed 21 Oct 13:00' }, actions: { 'pre-closes': ['change-pre-time'] },
    qr: 'pre-work',
    links: ['Handout', 'Pre-work', 'Post-work · opens after the session']
  },
  {
    name: 'Saïd, unpublished', run: said({ handoutUrl: 'https://handouts.fyi/dl/said-21-oct' }, { pre: { ...PUBLISHED.pre, unpublishedAt: '2026-10-16T09:00:00Z' }, post: PUBLISHED.post }), now: '2026-10-17T10:00:00Z', opts: { files: FILES, answers: { pre: 7 } },
    steps: 'planned:done pre-ready:done published:warn pre-closes:todo delivered:todo post-open:todo post-closes:todo results:todo',
    counter: '2 of 8', publication: 'unpublished', phase: 'unpublished', pill: ['amber', 'Unpublished'],
    details: { published: '7 answers kept' }, actions: { published: ['publish-again', 'preview-page'] }, titles: { published: 'Unpublished' }
  },
  {
    name: 'Saïd, pre-work closed (13:30, 16 of 18)', run: said({ handoutUrl: 'https://handouts.fyi/dl/said-21-oct' }, PUBLISHED), now: '2026-10-21T12:30:00Z', opts: { files: FILES, answers: { pre: 16 } },
    steps: 'planned:done pre-ready:done published:done pre-closes:done delivered:current post-open:todo post-closes:todo results:todo',
    counter: '4 of 8', publication: 'published', phase: 'pre-closed', pill: ['green', 'Published'],
    details: { 'pre-closes': 'Wed 21 Oct 13:00' }, titles: { 'pre-closes': 'Pre-work closed' }, actions: { 'pre-closes': ['change-pre-time'], delivered: ['go-live', 'mark-delivered'] }, qr: 'handout'
  },
  {
    name: 'Saïd, post-work open (22 Oct, 5 of 18)',
    run: said({ status: 'delivered', endedAt: '2026-10-21T14:58:00Z', handoutUrl: 'https://handouts.fyi/dl/said-21-oct' }, OPENED), now: '2026-10-22T09:00:00Z', opts: { files: FILES, answers: { pre: 16, post: 5 } },
    steps: 'planned:done pre-ready:done published:done pre-closes:done delivered:done post-open:done post-closes:current results:todo',
    counter: '6 of 8', publication: 'published', phase: 'post-open', pill: ['blue', 'Delivered'],
    details: { delivered: 'Wed 21 Oct 15:58', 'post-open': 'Since Wed 21 Oct 15:58 · 3 steps · file “Session feedback”', 'post-closes': 'Wed 4 Nov 17:00 · 5/18 answered', results: 'Board and polls kept · post-work answers still coming in' },
    actions: { results: ['open-results'] }, qr: 'post-work'
  },
  {
    name: 'Saïd, post-work closed', run: said({ status: 'delivered', endedAt: '2026-10-21T14:58:00Z', handoutUrl: 'https://handouts.fyi/dl/said-21-oct' }, OPENED), now: '2026-11-05T09:00:00Z', opts: { files: FILES },
    steps: 'planned:done pre-ready:done published:done pre-closes:done delivered:done post-open:done post-closes:done results:done',
    counter: '8 of 8', publication: 'published', phase: 'post-closed', pill: ['blue', 'Delivered'], titles: { 'post-closes': 'Post-work closed' }
  },
  {
    name: 'Medical Sciences, published before pre-work opens',
    run: { status: 'planned', plannedDate: '2026-11-04', startTime: '10:00', expectedPeople: 24, timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/medical-sciences-4-nov',
      work: { pre: { fileId: 'research-teams-intake', opens: '2026-10-28T09:00', closes: '2026-11-04T09:00', timeZone: TZ, publishedAt: '2026-10-14T15:20:00Z' }, post: { fileId: 'session-feedback', opens: 'session-end', closes: '2026-11-18T17:00', timeZone: TZ, publishedAt: '2026-10-14T15:20:00Z' } } },
    now: '2026-10-15T10:00:00Z', opts: { files: FILES },
    steps: 'planned:done pre-ready:done published:done pre-closes:current delivered:todo post-open:todo post-closes:todo results:todo',
    counter: '3 of 8', publication: 'published', phase: 'published', qr: 'handout',
    details: { published: 'Since Wed 14 Oct 16:20', 'post-closes': 'Wed 18 Nov 17:00' }, links: ['Handout', 'Pre-work · opens Wed 28 Oct 09:00', 'Post-work · opens after the session']
  },
  {
    name: 'Keble, pre-work open', run: { status: 'planned', plannedDate: '2026-10-28', startTime: '16:00', expectedPeople: 40, timeZone: TZ, handoutUrl: 'https://handouts.fyi/dl/keble-28-oct',
      work: { pre: { fileId: 'research-teams-intake', opens: '2026-10-12T09:00', closes: '2026-10-28T15:00', timeZone: TZ, publishedAt: '2026-10-12T08:00:00Z' } } },
    now: '2026-10-15T10:00:00Z', opts: { files: { pre: PRE_OK } },
    steps: 'planned:done pre-ready:done published:done pre-closes:current delivered:todo results:todo',
    counter: '3 of 6', publication: 'published', phase: 'published', qr: 'pre-work', details: { planned: '40 expected · Europe/London' }
  },
  {
    name: 'ITLC lunchtime, delivered (no post-work file)', run: { status: 'delivered', plannedDate: '2026-10-09', startTime: '12:00', expectedPeople: 20, timeZone: TZ, endedAt: '2026-10-09T11:50:00Z', handoutUrl: 'https://handouts.fyi/dl/itlc-9-oct',
      work: { pre: { fileId: 'research-teams-intake', opens: '2026-10-01T09:00', closes: '2026-10-09T11:30', timeZone: TZ, publishedAt: '2026-10-01T08:00:00Z' } } },
    now: '2026-10-10T10:00:00Z', opts: { files: { pre: PRE_OK } },
    steps: 'planned:done pre-ready:done published:done pre-closes:done delivered:done results:done',
    counter: '6 of 6', publication: 'published', phase: 'delivered', pill: ['blue', 'Delivered'], details: { delivered: 'Fri 9 Oct 12:50' }
  }
]

for (const c of cases) {
  const result = runChecklist(c.run, at(c.now), c.opts)
  assert.equal(brief(result), c.steps, `${c.name}: steps`)
  assert.equal(result.counter, c.counter, `${c.name}: counter`)
  assert.equal(result.publication, c.publication, `${c.name}: publication`)
  if (c.phase) assert.equal(result.phase, c.phase, `${c.name}: phase`)
  if (c.pill) assert.deepEqual([result.pill.kind, result.pill.label], c.pill, `${c.name}: pill`)
  for (const [id, detail] of Object.entries(c.details ?? {})) assert.equal(result.steps.find((s) => s.id === id).detail, detail, `${c.name}: ${id} detail`)
  for (const [id, title] of Object.entries(c.titles ?? {})) assert.equal(result.steps.find((s) => s.id === id).title, title, `${c.name}: ${id} title`)
  for (const [id, want] of Object.entries(c.actions ?? {})) {
    const got = result.steps.find((s) => s.id === id).actions.map((a) => a.id + (a.disabled ? '!' : ''))
    assert.deepEqual(got, want, `${c.name}: ${id} actions`)
  }
  const published = result.steps.find((s) => s.id === 'published')
  if (c.qr) assert.equal(published.qr, c.qr, `${c.name}: qr`)
  if (c.links) assert.deepEqual(published.links.map((l) => l.label), c.links, `${c.name}: links`)
  assert.equal(result.total, result.steps.length)
}

// ITLC and every pre-only Run: no post-work steps at all (absent, not greyed).
const itlc = runChecklist(cases.at(-1).run, at('2026-10-10T10:00:00Z'), { files: { pre: PRE_OK } })
assert.ok(!itlc.steps.some((s) => s.id.startsWith('post-')))

// A post-only Run: no Pre-work ready, no Pre-work closes; 6 steps.
const postOnly = runChecklist({ ...said(), work: { post: said().work.post } }, at('2026-10-13T10:00:00Z'), { files: FILES })
assert.deepEqual(postOnly.steps.map((s) => s.id), ['planned', 'published', 'delivered', 'post-open', 'post-closes', 'results'])
assert.equal(postOnly.counter, '1 of 6')

// No attachments at all (a Run from before work files): the four unconditional steps.
const bare = runChecklist({ status: 'planned', plannedDate: '2026-10-21', startTime: '14:00' }, at('2026-10-13T10:00:00Z'))
assert.deepEqual(bare.steps.map((s) => s.id), ['planned', 'published', 'delivered', 'results'])
assert.equal(bare.steps[0].detail, '')

// Live: "Delivered" shows as "Live now" with Open live view; Results disabled until the session is over.
const live = runChecklist(said({ handoutUrl: 'https://h/dl/x' }, PUBLISHED), at('2026-10-21T13:10:00Z'), { files: FILES, live: true, liveSince: '14:02' })
const liveStep = live.steps.find((s) => s.id === 'delivered')
assert.equal(liveStep.state, 'live'); assert.equal(liveStep.title, 'Live now'); assert.equal(liveStep.detail, 'Since 14:02')
assert.deepEqual(liveStep.actions.map((a) => a.id), ['open-live-view'])
assert.equal(live.phase, 'live'); assert.deepEqual([live.pill.kind, live.pill.label], ['red', 'Live now'])
assert.equal(live.steps.find((s) => s.id === 'results').actions[0].disabled, undefined) // enabled while live: only before the session is it disabled
assert.equal(runChecklist(said(), at('2026-10-13T10:00:00Z')).steps.at(-1).actions[0].disabled, true)

// A blocking finding: Pre-work ready is current with the finding and Open file; Published waits behind it.
const blocked = runChecklist(said(), at('2026-10-13T10:00:00Z'), { files: { pre: { ...PRE_OK, blocking: 'Step “watch” has no video link' }, post: POST_OK } })
assert.equal(brief(blocked).split(' ').slice(0, 3).join(' '), 'planned:done pre-ready:current published:todo')
assert.equal(blocked.steps[1].detail, 'Step “watch” has no video link')
assert.deepEqual(blocked.steps[1].actions.map((a) => a.id), ['open-pre-file'])
// A file that cannot be found is not ready either.
assert.equal(runChecklist(said(), at('2026-10-13T10:00:00Z')).steps[1].state, 'current')

// Republishing after unpublishing returns to published (published => unpublished => published).
const again = runChecklist(said({ handoutUrl: 'u' }, { pre: { publishedAt: '2026-10-18T08:00:00Z', unpublishedAt: '2026-10-16T09:00:00Z' }, post: {} }), at('2026-10-19T10:00:00Z'), { files: FILES })
assert.equal(again.publication, 'published')
// Ticket 17: an unpublished Run keeps its answers, pre-work and post-work together ("N answers kept").
const UNPUB = { pre: { ...PUBLISHED.pre, unpublishedAt: '2026-10-25T09:00:00Z' }, post: { ...PUBLISHED.post, unpublishedAt: '2026-10-25T09:00:00Z' } }
const keptBoth = runChecklist(said({ handoutUrl: 'u' }, UNPUB), at('2026-10-26T10:00:00Z'), { files: FILES, answers: { pre: 7, post: 5 } })
assert.deepEqual([keptBoth.publication, keptBoth.steps.find((s) => s.id === 'published').detail], ['unpublished', '12 answers kept'])
assert.equal(runChecklist(said({ handoutUrl: 'u' }, UNPUB), at('2026-10-26T10:00:00Z'), { files: FILES, answers: { pre: 1 } }).steps.find((s) => s.id === 'published').detail, '1 answer kept')
assert.equal(runChecklist(said({ handoutUrl: 'u' }, UNPUB), at('2026-10-26T10:00:00Z'), { files: FILES }).steps.find((s) => s.id === 'published').detail, 'Answers kept')
// Ticket 17 round 3 (D1): a Run whose sent phases are known only from the work service's record (no
// attachment carries `publishedAt`) is stamped on the Run itself when Unpublish replaces its pages; the
// checklist reads that stamp too and says Unpublished, with Publish again.
const historyOnly = runChecklist(said({ handoutUrl: 'u', unpublishedAt: '2026-10-25T09:00:00Z' }, { pre: { publishedAt: undefined }, post: { publishedAt: undefined } }), at('2026-10-26T10:00:00Z'), { files: FILES, answers: { pre: 3 } })
assert.deepEqual([historyOnly.publication, historyOnly.phase, historyOnly.steps.find((s) => s.id === 'published').detail, historyOnly.steps.find((s) => s.id === 'published').actions.map((a) => a.id)],
  ['unpublished', 'unpublished', '3 answers kept', ['publish-again', 'preview-page']], 'history-only: Unpublished from the Run\'s own stamp')
assert.equal(runChecklist(said({ handoutUrl: 'u' }, { pre: { publishedAt: undefined }, post: { publishedAt: undefined } }), at('2026-10-26T10:00:00Z'), { files: FILES }).publication, 'published', 'without the stamp it reads published (its link)')
// The Run's stamp counts like a phase's: a phase published after it is published again.
assert.equal(runChecklist(said({ handoutUrl: 'u', unpublishedAt: '2026-10-16T09:00:00Z' }, { pre: { publishedAt: '2026-10-18T08:00:00Z' }, post: {} }), at('2026-10-19T10:00:00Z'), { files: FILES }).publication, 'published')
assert.equal(runChecklist(said({ handoutUrl: 'u', unpublishedAt: 'not a time' }, { pre: { publishedAt: undefined }, post: { publishedAt: undefined } }), at('2026-10-26T10:00:00Z'), { files: FILES }).publication, 'published', 'a stamp that is not a time is not read')
assert.equal(answersKept({ pre: 7, post: -1 }) + answersKept(undefined) + answersKept({ pre: 1.5 }), 7, 'only whole counts of people are added')

// Pre-work whose closing time is moved later reopens: closes is todo again and the QR is the pre-work link.
const reopened = runChecklist(said({ handoutUrl: 'u' }, { pre: { ...PUBLISHED.pre, closes: '2026-10-21T13:45' } }), at('2026-10-21T12:30:00Z'), { files: FILES })
assert.equal(reopened.steps.find((s) => s.id === 'pre-closes').state, 'current')
assert.equal(reopened.steps.find((s) => s.id === 'published').qr, 'pre-work')

// Times are read in the attachment's zone, not the machine's: 12:30Z is 13:30 in London and 08:30 in New York.
assert.equal(localTimeIn(at('2026-10-21T12:30:00Z'), 'Europe/London'), '2026-10-21T13:30')
assert.equal(localTimeIn(at('2026-10-21T12:30:00Z'), 'America/New_York'), '2026-10-21T08:30')
assert.equal(localTimeIn(at('2026-10-21T23:30:00Z'), 'Europe/London'), '2026-10-22T00:30')
assert.equal(whenLabel('2026-11-04T17:00'), 'Wed 4 Nov 17:00')
// Post-work at a set time that is not yet open: the link says when it opens, not "after the session" (only SESSION_END says that).
const postSet = runChecklist(said({ handoutUrl: 'https://h/dl/x' }, { pre: PUBLISHED.pre, post: { ...PUBLISHED.post, opens: '2026-10-28T09:00' } }), at('2026-10-22T10:00:00Z'), { files: FILES })
assert.equal(postSet.steps.find((s) => s.id === 'published').links.at(-1).label, `Post-work · opens ${whenLabel('2026-10-28T09:00')}`)
assert.equal(postSet.steps.find((s) => s.id === 'published').links.at(-1).label, 'Post-work · opens Wed 28 Oct 09:00')
assert.ok(!postSet.steps.find((s) => s.id === 'published').links.at(-1).label.includes('after the session'))
const ny = runChecklist(said({}, { pre: { timeZone: 'America/New_York', opens: '2026-10-14T09:00', closes: '2026-10-21T09:00', publishedAt: '2026-10-14T08:00:00Z' }, post: {} }), at('2026-10-21T12:30:00Z'), { files: FILES })
assert.equal(ny.steps.find((s) => s.id === 'pre-closes').state, 'current') // 08:30 in New York is before the 09:00 close

// ---- 6. ticket 16
assert.equal(runQrTarget({ preOpen: true, postOpen: false }), 'pre-work')
assert.equal(runQrTarget({ preOpen: false, postOpen: true }), 'post-work')
assert.equal(runQrTarget({ preOpen: false, postOpen: false }), 'handout')
assert.equal(runQrTarget({ preOpen: true, postOpen: true }), 'pre-work', 'pre-work wins if both were ever open')
assert.equal(workPageUrl('https://h.test/said/', 'pre'), 'https://h.test/said/pre-work')
assert.equal(workPageUrl('https://h.test/said', 'post'), 'https://h.test/said/post-work')
assert.equal(workPageUrl('', 'pre'), '', 'no handout link, no work page link')
{
  const published = said({ handoutUrl: 'https://h.test/said/' }, { pre: { publishedAt: '2026-10-14T08:00:00Z' }, post: { publishedAt: '2026-10-14T08:00:00Z' } })
  const step = runChecklist(published, at('2026-10-15T10:00:00Z'), { files: FILES }).steps.find((s) => s.id === 'published')
  assert.deepEqual(step.links.map((l) => l.url), ['https://h.test/said/', 'https://h.test/said/pre-work', 'https://h.test/said/post-work'])
  assert.equal(step.qr, 'pre-work')
}
{
  const both = runInvitationText({ eventTitle: 'Saïd workshop', talkTitle: 'AI for research teams', plannedDate: '2026-10-21', startTime: '14:00', handoutUrl: 'https://h.test/said/',
    work: { pre: { closes: '2026-10-21T13:00' }, post: { opens: 'session-end', closes: '2026-11-04T17:00' } } })
  assert.equal(both, [
    'Saïd workshop: AI for research teams\nWed 21 Oct, 14:00',
    'Before the session, please do the pre-work (open until Wed 21 Oct 13:00):\nhttps://h.test/said/pre-work',
    'After the session, the post-work (opens when the session ends and closes Wed 4 Nov 17:00):\nhttps://h.test/said/post-work',
    'The session handout:\nhttps://h.test/said/'
  ].join('\n\n'))
  const preOnly = runInvitationText({ talkTitle: 'Talk', handoutUrl: 'https://h.test/t', work: { pre: { closes: '' } } })
  assert.equal(preOnly, 'Talk\n\nBefore the session, please do the pre-work:\nhttps://h.test/t/pre-work\n\nThe session handout:\nhttps://h.test/t')
  assert.equal(runInvitationText({ talkTitle: 'Talk', eventTitle: 'Talk', handoutUrl: 'https://h.test/t' }), 'Talk\n\nThe handout for the session:\nhttps://h.test/t')
  const dated = runInvitationText({ talkTitle: 'T', handoutUrl: 'https://h.test/t', work: { post: { opens: '2026-11-01T09:00', closes: '2026-11-08T09:00' } } })
  assert.match(dated, /post-work \(opens on Sun 1 Nov 09:00 and closes Sun 8 Nov 09:00\)/)
  assert.doesNotMatch(both + preOnly + dated, /localhost|127\.0\.0\.1/)
}
// 8. Ticket 19.
{
  const step = (c, id) => c.steps.find((s) => s.id === id)
  const link = (c) => step(c, 'published').links.at(-1).label
  // Delivered, published, the opening not pushed yet: not open, and it says it is opening.
  const pending = runChecklist(said({ status: 'delivered', endedAt: '2026-10-21T14:58:00Z', handoutUrl: 'https://h/dl/x' }, PUBLISHED), at('2026-10-21T15:00:00Z'), { files: FILES })
  assert.equal(step(pending, 'post-open').state, 'current')
  assert.equal(step(pending, 'post-open').detail, 'Opening now the session has ended · 3 steps · file “Session feedback”')
  assert.equal(link(pending), 'Post-work · opens after the session')
  assert.equal(pending.phase, 'delivered')
  // Pushed: open, since when it was opened (the next launch, when the app was closed at the session's end).
  const nextLaunch = runChecklist(said({ status: 'delivered', endedAt: '2026-10-21T14:58:00Z', handoutUrl: 'https://h/dl/x' },
    { pre: PUBLISHED.pre, post: { ...PUBLISHED.post, openedAt: '2026-10-22T07:12:00Z' } }), at('2026-10-22T09:00:00Z'), { files: FILES, answers: { post: 2 } })
  assert.equal(step(nextLaunch, 'post-open').state, 'done')
  assert.equal(step(nextLaunch, 'post-open').detail, 'Since Thu 22 Oct 08:12 · 3 steps · file “Session feedback”', 'when it opened, not when the session ended')
  assert.equal(step(nextLaunch, 'post-closes').state, 'current')
  assert.equal(link(nextLaunch), 'Post-work · open')
  assert.equal(step(nextLaunch, 'published').qr, 'post-work', 'the QR switches to post-work')
  assert.equal(nextLaunch.phase, 'post-open')
  // A live session that ended on a Run still planned (no recording): open once the opening was noted.
  const livePlanned = runChecklist(said({ handoutUrl: 'https://h/dl/x' }, OPENED), at('2026-10-22T09:00:00Z'), { files: FILES })
  assert.equal(step(livePlanned, 'post-open').state, 'done')
  // Delivered but never published: post-work waits for the publish.
  const unsent = runChecklist(said({ status: 'delivered', endedAt: '2026-10-21T14:58:00Z' }), at('2026-10-22T09:00:00Z'), { files: FILES })
  assert.equal(step(unsent, 'post-open').detail, 'Opens once this run is published · 3 steps · file “Session feedback”')
  // The defect from ticket 16's review: a set-time post-work past its time on an undelivered Run is open.
  const setTime = said({ handoutUrl: 'https://h/dl/x' }, { pre: PUBLISHED.pre, post: { ...PUBLISHED.post, opens: '2026-10-20T09:00' } })
  const setOpen = runChecklist(setTime, at('2026-10-20T10:00:00Z'), { files: FILES })
  assert.equal(link(setOpen), 'Post-work · open', 'not "opens <a past time>"')
  assert.equal(step(setOpen, 'post-open').state, 'done')
  assert.equal(step(setOpen, 'post-open').detail, 'Since Tue 20 Oct 09:00 · 3 steps · file “Session feedback”')
  assert.equal(link(runChecklist(setTime, at('2026-10-20T07:00:00Z'), { files: FILES })), 'Post-work · opens Tue 20 Oct 09:00', 'before its time it says when')
  // Not published: a set time that has passed has not opened anything.
  const setUnsent = runChecklist({ ...setTime, handoutUrl: undefined, work: { ...setTime.work, pre: { ...setTime.work.pre, publishedAt: undefined }, post: { ...setTime.work.post, publishedAt: undefined } } }, at('2026-10-20T10:00:00Z'), { files: FILES })
  assert.equal(step(setUnsent, 'post-open').state, 'todo')
  // Change time after close: a later closing time makes the phase current again.
  const closedRun = said({ status: 'delivered', endedAt: '2026-10-21T14:58:00Z', handoutUrl: 'https://h/dl/x' }, OPENED)
  const closed = runChecklist(closedRun, at('2026-11-05T09:00:00Z'), { files: FILES })
  assert.equal(step(closed, 'post-closes').state, 'done')
  const reopened = runChecklist({ ...closedRun, work: { ...closedRun.work, post: { ...closedRun.work.post, closes: '2026-11-11T17:00' } } }, at('2026-11-05T09:00:00Z'), { files: FILES })
  assert.equal(step(reopened, 'post-closes').state, 'current', 'shows it current again')
  assert.equal(step(reopened, 'post-closes').title, 'Post-work closes')
  assert.equal(reopened.phase, 'post-open')
  const preClosed = runChecklist(said({ handoutUrl: 'u' }, PUBLISHED), at('2026-10-21T12:20:00Z'), { files: FILES })
  assert.equal(step(preClosed, 'pre-closes').state, 'done')
  const preAgain = runChecklist(said({ handoutUrl: 'u' }, { pre: { ...PUBLISHED.pre, closes: '2026-10-21T13:45' }, post: PUBLISHED.post }), at('2026-10-21T12:20:00Z'), { files: FILES })
  assert.equal(step(preAgain, 'pre-closes').state, 'current', 'pre-work too')

  // Ticket 19 review. An opening noted for later than now is not an opening: not open, no post-work QR.
  const future = runChecklist(said({ status: 'delivered', endedAt: '2026-10-21T14:58:00Z', handoutUrl: 'https://h/dl/x' },
    { pre: PUBLISHED.pre, post: { ...PUBLISHED.post, openedAt: '2026-10-23T09:00:00Z' } }), at('2026-10-22T09:00:00Z'), { files: FILES })
  assert.notEqual(step(future, 'post-open').state, 'done')
  assert.equal(link(future), 'Post-work · opens after the session')
  assert.notEqual(step(future, 'published').qr, 'post-work')
  assert.equal(future.phase, 'delivered')
  // Unpublished after it opened: participants are shown "not available", so it is not open here either.
  const withdrawn = runChecklist(said({ status: 'delivered', endedAt: '2026-10-21T14:58:00Z', handoutUrl: 'https://h/dl/x', unpublishedAt: '2026-10-22T08:00:00Z' }, OPENED),
    at('2026-10-22T09:00:00Z'), { files: FILES })
  assert.notEqual(step(withdrawn, 'post-open').state, 'done')
  assert.notEqual(withdrawn.phase, 'post-open')
  const setWithdrawn = runChecklist({ ...setTime, unpublishedAt: '2026-10-20T09:30:00Z' }, at('2026-10-20T10:00:00Z'), { files: FILES })
  assert.notEqual(step(setWithdrawn, 'post-open').state, 'done', 'a set time too')
  // Past its closing time and never opened (launched after the deadline): closed, never opened; results go on.
  const missed = runChecklist(said({ status: 'delivered', endedAt: '2026-10-21T14:58:00Z', handoutUrl: 'https://h/dl/x' }, PUBLISHED), at('2026-11-05T09:00:00Z'), { files: FILES })
  assert.equal(step(missed, 'post-open').title, 'Post-work never opened')
  assert.doesNotMatch(step(missed, 'post-open').detail, /Opening now/)
  assert.equal(step(missed, 'post-closes').state, 'done')
  assert.equal(step(missed, 'post-closes').title, 'Post-work closed')
  assert.equal(step(missed, 'post-closes').detail, 'Wed 4 Nov 17:00 · it never opened')
  assert.equal(step(missed, 'results').state, 'done', 'Results kept goes on')
  assert.equal(link(missed), 'Post-work · closed')
  assert.equal(missed.phase, 'post-closed')
  assert.equal(missed.steps.filter((s) => s.state === 'current').length, 0, 'nothing is left waiting')
}
console.log('run-checklist: ok')
