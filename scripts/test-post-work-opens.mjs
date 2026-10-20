// Work-files ticket 19: post-work opens when the session ends and closes on time.
//   1. the open-on-end rule (src/shared/post-work-opening.ts), as a table: no post-work, set time, not ended,
//      ended live session, delivered Run, never sent, unpublished (Run, phase, withdrawn, withdraw asked), gone,
//      already open, open but not noted, past its closing time;
//   2. the live end → push path (src/main/post-work-open.ts) over the real work service and a fake Worker
//      that answers through the Worker's own rules: post-work sent before the session does not take answers;
//      the session's end pushes the opening, the page takes answers, the Run notes when it opened;
//   3. idempotent: a repeat end event, the timer, two calls at once and a relaunch never push a second
//      opening, and the answers already given stay;
//   4. app not running at the session's end: the next launch opens it, and the checklist says when it opened;
//   5. a Run with no post-work file, or post-work never sent, or at a set time, never pushes anything;
//   6. an unpublished Run never pushes anything;
//   7. Change time after close (changeDeliveredRunWork, then syncWindows) reopens the phase, with its opening
//      kept; the checklist shows it current again; a delivered Run's file cannot be changed;
//   8. a Run that could not be saved after the push is noted on the next pull cycle, with no second push;
//   9. review round 1: the Run's own vault only (two vaults holding copied Runs of the same ids: ending A's
//      session never opens B's; the timer leaves a Run two open vaults hold; a closed vault is never read);
//      decided inside the object's turn (post-work removed while a pull holds it: no opening); a recorded
//      publish is needed (a failed first publish leaves a row, nothing opens); the opening is noted only on
//      the post-work that was opened (replaced while the push was in flight: nothing noted); a plan change
//      while the opening is in flight keeps the opening;
//  10. review round 2: a delivered Run's post-work changed from a set time tomorrow to when the session ends
//      opens now (9e); the object belongs to the vault its row records (the reviewer's probe: A published,
//      copied to B, A closed, B delivered: the timer opens nothing); queued behind a pull, a vault opened,
//      closed meanwhile cannot change the outcome, and a copy published from another vault gets its own object
//      (issue 256); a row with no vault never opens on its own.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-post-work-opens.mjs
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createRunPrework, workPushWindowMs } from '../src/main/run-prework.ts'
import { createPostWorkOpener } from '../src/main/post-work-open.ts'
import { changeDeliveredRunWork, normaliseRun, persistRunForTalk, readRunForTalk, stampRunUnpublished } from '../src/main/runs.ts'
import { isNotYetOpenedWindow, notYetOpenedWindow, postWorkOpening } from '../src/shared/post-work-opening.ts'
import { runChecklist } from '../src/shared/run-checklist.ts'
import { memoryOwnerTokens } from './lib/memory-secrets.mjs'

// The Worker's own rules, bundled (they use TypeScript Node cannot strip).
const rulesDir = mkdtempSync(join(tmpdir(), 'tw-post-open-rules-'))
const repo = new URL('..', import.meta.url).pathname
writeFileSync(join(rulesDir, 'rules.ts'), `export * from '${repo}worker/prework-state.ts'\nexport { parsePreworkFormPush } from '${repo}worker/prework-protocol.ts'\n`)
const bundled = await build({ entryPoints: [join(rulesDir, 'rules.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
writeFileSync(join(rulesDir, 'rules.mjs'), bundled.outputFiles[0].text)
const { PreworkError, createMemoryPreworkStore, createPrework, parsePreworkFormPush, preworkStatus, pushForm, resultsPage, submitPrework, withdrawPrework } =
  await import(pathToFileURL(join(rulesDir, 'rules.mjs')).href)
rmSync(rulesDir, { recursive: true, force: true })

const results = []
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`) }
const ORIGIN = 'https://live.example.test'
const SLUG = 'post-open-talk'
const RUN = 'run-post-open'
const clock = { now: Date.UTC(2026, 9, 21, 9) }
const MIN = 60_000
const P1 = 'a1b2c3d4e5f60718'
const P2 = '0f1e2d3c4b5a6978'
const P3 = '1234567890abcdef'

function fakeWorker() {
  const objects = new Map()
  const world = { objects, calls: [], made: 0 }
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  world.submit = (id, participant, submission) => {
    const object = objects.get(id)
    try {
      submitPrework(object.prework, object.store, participant, { participantId: `device-${participant}`, submissionId: `sub-${Math.random()}`, ...submission }, clock.now)
      return 201
    } catch (error) { if (error instanceof PreworkError) return error.status; throw error }
  }
  world.state = (id) => preworkStatus(objects.get(id).prework, clock.now).state
  world.pushes = () => world.calls.filter((call) => call.startsWith('PUT ')).length
  /** The next request whose path ends with `action` waits until `release()`; `reached` settles when it arrives. */
  world.holdNext = (action) => {
    let release, arrived
    const gate = new Promise((resolve) => { release = resolve })
    const reached = new Promise((resolve) => { arrived = resolve })
    world.hold = { action, gate, arrived }
    return { release, reached }
  }
  world.fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url)
    const method = init.method ?? 'GET'
    const auth = new Headers(init.headers).get('authorization')
    world.calls.push(`${method} ${pathname}`)
    if (world.hold && pathname.endsWith(`/${world.hold.action}`)) {
      const { gate, arrived } = world.hold
      world.hold = null
      arrived()
      await gate
    }
    if (pathname === '/prework' && method === 'POST') {
      world.made += 1
      const id = `wkobj${String(world.made).padStart(3, '0')}`
      objects.set(id, { prework: createPrework(id, clock.now), store: createMemoryPreworkStore(), token: `owner-token-${id}-0123456789abcdef` })
      return reply({ preworkId: id, ownerToken: objects.get(id).token }, 201)
    }
    const [, , id, action] = pathname.split('/')
    const object = objects.get(id)
    if (!object) return reply({ error: { code: 'not_found' } }, 404)
    if (auth !== `Bearer ${object.token}`) return reply({ error: { code: 'owner_auth_required' } }, 401)
    try {
      if (action === 'form') {
        const parsed = parsePreworkFormPush(JSON.parse(init.body), clock.now)
        if ('error' in parsed) return reply({ error: parsed.error }, 400)
        pushForm(object.prework, parsed.value, clock.now)
        return reply({ ok: true, status: preworkStatus(object.prework, clock.now) })
      }
      if (action === 'results') return reply(resultsPage(object.prework, object.store, Number(searchParams.get('after') ?? 0), clock.now))
      if (action === 'withdraw') {
        const withdrawn = init.body ? JSON.parse(init.body).withdrawn !== false : true
        const withdrawnAt = withdrawPrework(object.prework, withdrawn, clock.now)
        return reply({ ok: true, withdrawn, ...(withdrawnAt !== null ? { withdrawnAt } : {}) })
      }
    } catch (error) {
      if (error instanceof PreworkError) return reply({ error: { code: error.code, message: error.message } }, error.status)
      throw error
    }
    return reply({ error: { code: 'not_found' } }, 404)
  }
  return world
}

const FORM = { title: 'Feedback', intro: '', steps: [{ id: 'q1', n: 1, title: 'Useful?', kind: 'question', questions: true, poll: { type: 'open', question: 'Useful?', options: [] } }] }
const POST = { fileId: 'session-feedback', opens: 'session-end', closes: '2026-11-04T17:00', timeZone: 'UTC' }
const PRE = { fileId: 'intake', opens: '2026-10-14T09:00', closes: '2026-10-21T13:00', timeZone: 'UTC' }

function aRun(work, extra = {}) {
  return normaliseRun({
    id: RUN, talkSlug: SLUG, talkTitle: 'Post open', kind: 'delivery', status: 'planned', plannedDate: '2026-10-21', startTime: '14:00',
    timeZone: 'UTC', slideSet: { kind: 'full' }, startedAt: '2026-10-21T00:00:00.000Z', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0,
    context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], handoutUrl: 'https://h.test/dl/said',
    work, ...extra,
  })
}

/** A vault with one Run, a work service over a fake Worker, and an opener whose live sessions are `live`. */
function setUp(work = { pre: PRE, post: POST }, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tw-post-open-'))
  const vault = join(root, 'vault')
  mkdirSync(join(vault, '_PRESENTATIONS', SLUG), { recursive: true })
  persistRunForTalk(vault, SLUG, RUN, aRun(work, extra))
  const worker = fakeWorker()
  const tokens = memoryOwnerTokens()
  const registryPath = join(root, 'run-prework-registry.json')
  const live = { ended: new Set() }
  const service = () => createRunPrework({ registryPath, ownerTokens: tokens, endpoint: async () => ({ baseUrl: ORIGIN, adminSecret: 'admin' }), vaultRoot: () => vault, fetch: worker.fetch, now: () => clock.now })
  const opener = (svc) => createPostWorkOpener({ service: svc, vaults: () => [vault],
    liveEnded: (talkSlug, runId, vaultRoot) => vaultRoot === vault && live.ended.has(`${talkSlug}/${runId}`), now: () => clock.now })
  const t = { root, vault, worker, live, service: service(), run: () => readRunForTalk(vault, SLUG, RUN), write: (run) => persistRunForTalk(vault, SLUG, RUN, run) }
  t.opener = opener(t.service)
  /** The app quits and starts again: a new service and opener over the same registry, secrets and vault. */
  t.relaunch = () => { t.service = service(); t.opener = opener(t.service); return t }
  /** Publish for this run: each attached phase pushed as ticket 16 pushes it, and stamped. */
  t.publish = async () => {
    const run = t.run()
    const sent = {}
    for (const phase of ['pre', 'post']) {
      const w = run.work?.[phase]
      if (!w) continue
      sent[phase] = await t.service.publish(SLUG, RUN, FORM, workPushWindowMs(w, t.service.status(SLUG, RUN, phase)), phase, vault)
      run.work[phase] = { ...run.work[phase], publishedAt: new Date(clock.now).toISOString() }
    }
    t.write(run)
    return sent
  }
  t.done = () => rmSync(root, { recursive: true, force: true })
  return t
}

// 1. The rule ────────────────────────────────────────────────────────────────────────────────────
{
  const now = Date.UTC(2026, 9, 21, 15)
  const closesAt = Date.UTC(2026, 10, 4, 17)
  const waiting = notYetOpenedWindow(closesAt)
  const opened = { opensAt: Date.UTC(2026, 9, 21, 14, 58), closesAt }
  const published = { ...POST, publishedAt: '2026-10-14T08:00:00Z' }
  const unstampedPost = () => { const { publishedAt: _p, ...rest } = published; return rest }
  const run = (over = {}, post = published) => ({ status: 'delivered', handoutUrl: 'u', work: { post }, ...over })
  const rule = (input) => postWorkOpening({ liveEnded: false, sent: waiting, now, ...input })
  assert.ok(isNotYetOpenedWindow(waiting) && !isNotYetOpenedWindow(opened))
  assert.deepEqual(rule({ run: { status: 'delivered', work: { pre: PRE } } }), { act: 'none', why: 'no-post-work' })
  assert.deepEqual(rule({ run: run({}, { ...published, opens: '2026-10-22T09:00' }) }), { act: 'none', why: 'set-time' }, 'a set time opens by itself')
  assert.deepEqual(rule({ run: run({ status: 'planned' }) }), { act: 'none', why: 'not-ended' })
  assert.deepEqual(rule({ run: run({ status: 'planned' }), liveEnded: true }), { act: 'push', window: { opensAt: now, closesAt } }, 'an ended live session bound to the Run')
  assert.deepEqual(rule({ run: run() }), { act: 'push', window: { opensAt: now, closesAt } }, 'a delivered Run')
  assert.deepEqual(rule({ run: run(), sent: null }), { act: 'none', why: 'not-sent' })
  assert.deepEqual(rule({ run: run({ unpublishedAt: '2026-10-20T09:00:00Z' }) }), { act: 'none', why: 'unpublished' }, 'the Run unpublished (ticket 17 D1)')
  assert.deepEqual(rule({ run: run({}, { ...published, unpublishedAt: '2026-10-20T09:00:00Z' }) }), { act: 'none', why: 'unpublished' }, 'the phase unpublished')
  assert.deepEqual(rule({ run: run(), sent: { ...waiting, withdrawnAt: now - MIN } }), { act: 'none', why: 'unpublished' }, 'withdrawn on the service')
  assert.deepEqual(rule({ run: run(), sent: { ...waiting, withdrawAskedAt: now - MIN } }), { act: 'none', why: 'unpublished' }, 'a withdraw asked for')
  assert.deepEqual(rule({ run: run(), sent: { ...waiting, purgedAt: now - MIN } }), { act: 'none', why: 'gone' })
  assert.deepEqual(rule({ run: run({}, { ...published, openedAt: new Date(opened.opensAt).toISOString() }), sent: opened }), { act: 'none', why: 'already-open' })
  assert.deepEqual(rule({ run: run(), sent: opened }), { act: 'note', openedAt: opened.opensAt }, 'open on the service, not on the Run: noted, not pushed')
  // Review round 2: an object holding an opening still to come (a set time since changed to when the session
  // ends) opens now that the session has ended; never noted as open as it stands.
  assert.deepEqual(rule({ run: run(), sent: { opensAt: now + 60 * MIN, closesAt } }), { act: 'push', window: { opensAt: now, closesAt } })
  assert.deepEqual(rule({ run: run({ status: 'planned' }), sent: { opensAt: now + 60 * MIN, closesAt } }), { act: 'none', why: 'not-ended' })
  assert.deepEqual(rule({ run: run(), sent: { opensAt: now + 60 * MIN, closesAt, withdrawnAt: now - MIN } }), { act: 'none', why: 'unpublished' })
  assert.deepEqual(rule({ run: run(), sent: { opensAt: now + 60 * MIN, closesAt, purgedAt: now - MIN } }), { act: 'none', why: 'gone' })
  assert.deepEqual(rule({ run: run({}, unstampedPost()), sent: { opensAt: now + 60 * MIN, closesAt } }), { act: 'none', why: 'not-published' })
  assert.deepEqual(rule({ run: run(), sent: { opensAt: closesAt + MIN, closesAt: closesAt + 2 * MIN }, now: closesAt }), { act: 'none', why: 'closed' })
  // Review round 1: a row with no recorded publish of the Run (a first publish that failed after the object was made).
  const { publishedAt: _p, ...unstamped } = published
  assert.deepEqual(rule({ run: run({}, unstamped) }), { act: 'none', why: 'not-published' })
  assert.deepEqual(rule({ run: run({ handoutUrl: undefined }, unstamped) }), { act: 'none', why: 'not-published' })
  assert.deepEqual(rule({ run: { status: 'delivered', handoutUrl: 'u', work: { pre: { ...PRE, publishedAt: '2026-10-14T08:00:00Z' }, post: unstamped } } }), { act: 'none', why: 'not-published' },
    'pre-work published is not post-work published')
  assert.deepEqual(rule({ run: run(), now: closesAt }), { act: 'none', why: 'closed' })
  assert.deepEqual(rule({ run: run(), now: closesAt - 1 }), { act: 'none', why: 'closed' }, 'never a window that reads as not yet opened')
  assert.deepEqual(rule({ run: run({}, { ...published, problem: 'zone-mismatch' }) }), { act: 'none', why: 'unreadable' })
  // Published again after an unpublish: owed again.
  assert.deepEqual(rule({ run: run({}, { ...published, unpublishedAt: '2026-10-15T09:00:00Z', publishedAt: '2026-10-16T09:00:00Z' }) }).act, 'push')
  pass('the rule: ended live session, delivered Run, set time, already open, never sent, unpublished, closed')
}

// 2–3. The session ends: the opening is pushed once; the page takes answers ─────────────────────────
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    const sent = await t.publish()
    const id = sent.post.preworkId
    assert.equal(t.worker.state(id), 'not_yet', 'sent before the session: post-work is not open')
    assert.notEqual(t.worker.submit(id, P1, { stepId: 'q1', kind: 'answer', text: 'too early' }), 201, 'and takes no answer')
    assert.deepEqual(await t.opener.open(SLUG, RUN, t.vault), { ok: true, talkSlug: SLUG, runId: RUN, opened: false, why: 'not-ended' }, 'nothing before the session ends')
    const before = t.worker.pushes()

    clock.now = Date.UTC(2026, 9, 21, 14, 58)
    t.live.ended.add(`${SLUG}/${RUN}`) // the live session bound to the Run has ended (the manager's onEnded)
    const opened = await t.opener.open(SLUG, RUN, t.vault)
    assert.deepEqual(opened, { ok: true, talkSlug: SLUG, runId: RUN, opened: true, openedAt: '2026-10-21T14:58:00.000Z', pushed: true })
    assert.equal(t.worker.pushes(), before + 1, 'one push')
    assert.equal(t.worker.state(id), 'open')
    assert.equal(t.worker.submit(id, P1, { stepId: 'q1', kind: 'answer', text: 'Useful' }), 201, 'the page accepts answers')
    assert.equal(t.run().work.post.openedAt, '2026-10-21T14:58:00.000Z', 'the Run notes when it opened')
    assert.equal(t.run().status, 'planned', 'the Run itself is untouched otherwise')
    const status = t.service.status(SLUG, RUN, 'post')
    assert.deepEqual([status.opensAt, status.closesAt], [clock.now, Date.UTC(2026, 10, 4, 17)])
    // The pull cycle now pulls it.
    assert.deepEqual(t.service.due().filter((ref) => ref.phase === 'post'), [{ talkSlug: SLUG, runId: RUN, phase: 'post' }])
    assert.equal((await t.service.pull(SLUG, RUN, 'post')).ok, true)
    assert.deepEqual(t.run().postwork.entries.map((entry) => entry.text), ['Useful'])
    pass('the session ends: post-work pushed open once, the page accepts answers, the Run notes when it opened')

    // Repeat end events, the timer, the Run marked delivered, two calls at once: no second push.
    clock.now += 7 * MIN
    const pushes = t.worker.pushes()
    assert.equal((await t.opener.open(SLUG, RUN, t.vault)).why, 'already-open')
    assert.deepEqual((await t.opener.openDue()).map((result) => result.why), ['already-open'])
    t.write({ ...t.run(), status: 'delivered', endedAt: '2026-10-21T15:00:00.000Z' })
    const both = await Promise.all([t.opener.open(SLUG, RUN, t.vault), t.opener.open(SLUG, RUN, t.vault)])
    assert.deepEqual(both.map((result) => result.why), ['already-open', 'already-open'])
    // Also when the opening is asked of the service directly, as a second caller would.
    const again = await t.service.openWhenEnded(SLUG, RUN, () => ({ opensAt: clock.now, closesAt: Date.UTC(2026, 10, 4, 17) }))
    assert.equal(again.ok && again.unchanged, true, 'the service refuses a second opening inside the row\'s turn')
    assert.equal(again.opensAt, Date.UTC(2026, 9, 21, 14, 58))
    assert.equal(t.worker.pushes(), pushes, 'no push at all')
    assert.equal((await t.service.pull(SLUG, RUN, 'post')).ok, true)
    assert.deepEqual(t.run().postwork.entries.map((entry) => entry.text), ['Useful'], 'the answers stay')
    assert.equal(t.run().work.post.openedAt, '2026-10-21T14:58:00.000Z', 'and so does when it opened')
    // A relaunch: the timer at launch asks every sent Run; nothing is pushed again.
    t.relaunch()
    assert.deepEqual((await t.opener.openDue()).map((result) => result.why), ['already-open'])
    assert.equal(t.worker.pushes(), pushes)
    pass('idempotent: repeat end events, the timer, two calls at once and a relaunch never push again; the answers stay')

    // Two openers racing on a fresh Run (the end event and the timer): exactly one push.
    const u = setUp()
    try {
      clock.now = Date.UTC(2026, 9, 20, 9)
      await u.publish()
      clock.now = Date.UTC(2026, 9, 21, 15)
      u.write({ ...u.run(), status: 'delivered' })
      const p = u.worker.pushes()
      const raced = await Promise.all([u.opener.open(SLUG, RUN, u.vault), u.opener.openDue(), u.opener.open(SLUG, RUN, u.vault)])
      assert.equal(u.worker.pushes(), p + 1, 'one push')
      assert.equal(raced.flat().filter((result) => result.pushed).length, 1)
      pass('two triggers at once (the end event and the timer): exactly one push')
    } finally { u.done() }
  } finally { t.done() }
}

// 4. App not running at the session's end: opens on the next launch; the checklist says when ──────────
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    const sent = await t.publish()
    // The session ended at 14:58; the app was closed before it could push. Its live session record says ended.
    t.live.ended.add(`${SLUG}/${RUN}`)
    clock.now = Date.UTC(2026, 9, 22, 7, 12)
    t.relaunch()
    const results = await t.opener.openDue()
    assert.deepEqual(results.map((result) => [result.opened, result.pushed]), [[true, true]])
    assert.equal(t.worker.state(sent.post.preworkId), 'open')
    assert.equal(t.worker.submit(sent.post.preworkId, P2, { stepId: 'q1', kind: 'answer', text: 'Late but here' }), 201)
    const run = t.run()
    assert.equal(run.work.post.openedAt, '2026-10-22T07:12:00.000Z')
    const checklist = runChecklist(run, new Date(clock.now + MIN), { files: { pre: { title: 'Intake', steps: 2 }, post: { title: 'Feedback', steps: 1 } } })
    assert.equal(checklist.steps.find((step) => step.id === 'post-open').detail, 'Since Thu 22 Oct 07:12 · 1 step · file “Feedback”', 'the checklist says when it opened')
    assert.equal(checklist.steps.find((step) => step.id === 'published').links.at(-1).label, 'Post-work · open')
    pass('app not running at the session\'s end: the next launch opens it, and the checklist says when it opened')
  } finally { t.done() }
}

// 5. Nothing to open: no post-work file, never sent, a set time ─────────────────────────────────────
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp({ pre: PRE })
  try {
    await t.publish()
    const calls = t.worker.calls.length
    clock.now = Date.UTC(2026, 9, 21, 15)
    t.write({ ...t.run(), status: 'delivered' })
    t.live.ended.add(`${SLUG}/${RUN}`)
    assert.equal((await t.opener.open(SLUG, RUN, t.vault)).why, 'no-post-work')
    assert.deepEqual(await t.opener.openDue(), [], 'the timer finds no post-work row')
    assert.equal(t.worker.calls.length, calls, 'not one request')
  } finally { t.done() }
  const u = setUp() // post-work attached, the Run never published
  try {
    u.write({ ...u.run(), status: 'delivered' })
    assert.equal((await u.opener.open(SLUG, RUN, u.vault)).why, 'not-sent')
    assert.deepEqual(await u.opener.openDue(), [])
    assert.deepEqual(u.worker.calls, [])
  } finally { u.done() }
  clock.now = Date.UTC(2026, 9, 20, 9)
  const v = setUp({ post: { ...POST, opens: '2026-10-21T16:00' } })
  try {
    await v.publish()
    const calls = v.worker.calls.length
    clock.now = Date.UTC(2026, 9, 21, 15)
    v.write({ ...v.run(), status: 'delivered' })
    assert.equal((await v.opener.open(SLUG, RUN, v.vault)).why, 'set-time')
    assert.equal(v.worker.calls.length, calls)
    clock.now = Date.UTC(2026, 9, 21, 16, 1)
    assert.equal(v.worker.submit([...v.worker.objects.keys()][0], P1, { stepId: 'q1', kind: 'answer', text: 'At its time' }), 201, 'a set time opens by itself')
  } finally { v.done() }
  pass('a Run with no post-work file, post-work never sent, or post-work at a set time: nothing is pushed')
}

// 6. An unpublished Run never pushes ────────────────────────────────────────────────────────────
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    await t.publish()
    // Unpublish (ticket 17): each phase withdrawn, the Run stamped.
    assert.deepEqual(await t.service.withdraw(SLUG, RUN, 'pre'), { ok: true, withdrawn: true })
    assert.deepEqual(await t.service.withdraw(SLUG, RUN, 'post'), { ok: true, withdrawn: true })
    t.write(stampRunUnpublished(t.run(), new Date(clock.now).toISOString()))
    const calls = t.worker.calls.length
    clock.now = Date.UTC(2026, 9, 21, 15)
    t.write({ ...t.run(), status: 'delivered' })
    t.live.ended.add(`${SLUG}/${RUN}`)
    assert.equal((await t.opener.open(SLUG, RUN, t.vault)).why, 'unpublished')
    assert.deepEqual((await t.opener.openDue()).map((result) => result.why), ['unpublished'])
    // Even a Run whose stamp was lost by hand: the service's own record of the withdraw stops it.
    const { unpublishedAt: _dropped, ...unstamped } = t.run()
    t.write(unstamped)
    assert.equal((await t.opener.open(SLUG, RUN, t.vault)).why, 'unpublished')
    const refused = await t.service.openWhenEnded(SLUG, RUN, () => ({ opensAt: clock.now, closesAt: Date.UTC(2026, 10, 4, 17) }))
    assert.equal(refused.ok, false, 'and the service refuses it inside the row\'s turn')
    assert.equal(t.worker.calls.length, calls, 'not one request')
    assert.equal(t.run().work.post.openedAt, undefined)
    pass('an unpublished Run never pushes post-work open')
  } finally { t.done() }
}

// 7. Change time after close reopens the phase ─────────────────────────────────────────────────────
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    const sent = await t.publish()
    clock.now = Date.UTC(2026, 9, 21, 15)
    t.write({ ...t.run(), status: 'delivered', endedAt: '2026-10-21T15:00:00.000Z' })
    assert.equal((await t.opener.open(SLUG, RUN, t.vault)).pushed, true)
    const openedAt = t.service.status(SLUG, RUN, 'post').opensAt
    clock.now = Date.UTC(2026, 10, 5, 9) // after it closed
    assert.equal(t.worker.state(sent.post.preworkId), 'closed')
    const files = { files: { pre: { title: 'Intake', steps: 2 }, post: { title: 'Feedback', steps: 1 } } }
    assert.equal(runChecklist(t.run(), new Date(clock.now), files).steps.find((step) => step.id === 'post-closes').state, 'done')
    // Change time on the delivered Run: only the times; the file and the delivery stay.
    assert.throws(() => changeDeliveredRunWork(t.vault, SLUG, RUN, { work: { post: { fileId: 'another-file', closes: '2026-11-11T17:00' } } }), /run-delivered-times-only/)
    assert.throws(() => changeDeliveredRunWork(t.vault, SLUG, RUN, { eventTitle: 'Renamed', work: {} }), /run-delivered-times-only/)
    assert.throws(() => changeDeliveredRunWork(t.vault, SLUG, RUN, { work: { post: null } }), /run-delivered-times-only/)
    // Review round 3: a delivered Run is not held to the closing-against-start rules, but the rest still apply.
    assert.throws(() => changeDeliveredRunWork(t.vault, SLUG, RUN, { work: { post: { fileId: POST.fileId, opens: '2026-11-06T10:00', closes: '2026-11-06T09:00' } } }), /work-closes-before-opens/)
    assert.throws(() => changeDeliveredRunWork(t.vault, SLUG, RUN, { work: { post: { fileId: POST.fileId, opens: '2026-10-21T13:00', closes: '2026-11-11T17:00' } } }), /work-post-opens-before-start/)
    const changed = changeDeliveredRunWork(t.vault, SLUG, RUN, { work: { post: { fileId: POST.fileId, opens: 'session-end', closes: '2026-11-11T17:00' } } })
    assert.equal(changed.status, 'delivered')
    assert.equal(changed.endedAt, '2026-10-21T15:00:00.000Z')
    assert.equal(changed.work.post.openedAt, new Date(openedAt).toISOString(), 'when it opened is kept')
    assert.ok(changed.work.post.publishedAt, 'what was sent of it is kept')
    assert.equal(changeDeliveredRunWork(t.vault, SLUG, 'run-not-here', { work: {} }), null)
    // What the plan sheet's save then does in main (onPlannedRunUpdated): push the new window.
    const synced = await t.service.syncWindows(SLUG, RUN)
    assert.deepEqual(synced.map((result) => [result.phase, result.ok]), [['post', true]])
    assert.equal(t.service.status(SLUG, RUN, 'post').opensAt, openedAt, 'the opening is the one pushed at the session\'s end')
    assert.equal(t.worker.state(sent.post.preworkId), 'open', 'a later closing time reopens it')
    assert.equal(t.worker.submit(sent.post.preworkId, P3, { stepId: 'q1', kind: 'answer', text: 'After reopening' }), 201)
    const checklist = runChecklist(t.run(), new Date(clock.now), files)
    assert.equal(checklist.steps.find((step) => step.id === 'post-closes').state, 'current', 'the checklist shows it current again')
    assert.equal(checklist.phase, 'post-open')
    assert.equal((await t.opener.open(SLUG, RUN, t.vault)).why, 'already-open', 'and nothing opens it twice')
    pass('Change time after close: only the times change on a delivered Run; a later closing time reopens it; the checklist shows it current')
  } finally { t.done() }
}

// 7b. Review round 3: Change time on a delivered Run reopens pre-work that closed before the session ──
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    const sent = await t.publish()
    clock.now = Date.UTC(2026, 9, 21, 15) // pre-work closed at 13:00, the session started at 14:00
    t.write({ ...t.run(), status: 'delivered', endedAt: '2026-10-21T15:00:00.000Z' })
    assert.equal(t.worker.state(sent.pre.preworkId), 'closed')
    const files = { files: { pre: { title: 'Intake', steps: 2 }, post: { title: 'Feedback', steps: 1 } } }
    assert.equal(runChecklist(t.run(), new Date(clock.now), files).steps.find((step) => step.id === 'pre-closes').state, 'done')
    assert.throws(() => changeDeliveredRunWork(t.vault, SLUG, RUN, { work: { pre: { fileId: PRE.fileId, opens: PRE.opens, closes: '2026-10-14T08:00' } } }), /work-closes-before-opens/)
    assert.throws(() => changeDeliveredRunWork(t.vault, SLUG, RUN, { work: { pre: { fileId: 'another-file', opens: PRE.opens, closes: '2026-10-22T17:00' } } }), /run-delivered-times-only/)
    const changed = changeDeliveredRunWork(t.vault, SLUG, RUN, { work: { pre: { fileId: PRE.fileId, opens: PRE.opens, closes: '2026-10-22T17:00' } } })
    assert.equal(changed.status, 'delivered')
    assert.equal(changed.endedAt, '2026-10-21T15:00:00.000Z')
    assert.equal(changed.work.pre.closes, '2026-10-22T17:00', 'a closing time after the session is kept')
    assert.ok(changed.work.pre.publishedAt, 'what was sent of it is kept')
    const synced = await t.service.syncWindows(SLUG, RUN)
    assert.deepEqual(synced.filter((result) => result.phase === 'pre').map((result) => result.ok), [true])
    assert.equal(t.service.status(SLUG, RUN, 'pre').closesAt, Date.UTC(2026, 9, 22, 17), 'the service window is updated')
    assert.equal(t.worker.state(sent.pre.preworkId), 'open', 'a later closing time reopens pre-work')
    assert.equal(t.worker.submit(sent.pre.preworkId, P3, { stepId: 'q1', kind: 'answer', text: 'After reopening' }), 201)
    const checklist = runChecklist(t.run(), new Date(clock.now), files)
    assert.equal(checklist.steps.find((step) => step.id === 'pre-closes').state, 'current', 'the checklist shows it current again')
    assert.equal(checklist.steps.find((step) => step.id === 'published').links.find((link) => link.kind === 'pre-work').label, 'Pre-work')
    pass('Change time on a delivered Run: pre-work closed before the session reopens with a later closing time; the checklist shows it current')
  } finally { t.done() }
}

// 8. Pushed, but the Run could not be saved: noted on the next cycle, with no second push ──────────────
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    await t.publish()
    clock.now = Date.UTC(2026, 9, 21, 15)
    t.write({ ...t.run(), status: 'delivered' })
    const folder = join(t.vault, '_PRESENTATIONS', SLUG)
    chmodSync(folder, 0o555)
    let first
    try { first = await t.opener.open(SLUG, RUN, t.vault) } finally { chmodSync(folder, 0o755) }
    assert.equal(first.ok, false)
    assert.match(first.error, /Post-work is open, but the Run could not be saved/)
    assert.equal(t.run().work.post.openedAt, undefined)
    const pushes = t.worker.pushes()
    clock.now += 5 * MIN
    const next = await t.opener.openDue()
    assert.deepEqual(next.map((result) => [result.opened, result.pushed]), [[true, false]], 'noted, not pushed')
    assert.equal(t.run().work.post.openedAt, '2026-10-21T15:00:00.000Z', 'the opening as pushed, not the time of the note')
    assert.equal(t.worker.pushes(), pushes)
    pass('a Run that could not be saved after the push is noted on the next cycle, with no second push')
  } finally { t.done() }
}

// 9. Review round 1 ───────────────────────────────────────────────────────────────────────────────
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)) }
const step = (checklist, id) => checklist.steps.find((item) => item.id === id)
const FILES9 = { files: { pre: { title: 'Intake', steps: 2 }, post: { title: 'Feedback', steps: 1 } } }

// 9a. The Run's own vault only.
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    await t.publish()
    const published = t.run()
    // Vault B holds a copy of the Run: the same talk slug and Run id, published, and delivered.
    const B = join(t.root, 'vault-b')
    mkdirSync(join(B, '_PRESENTATIONS', SLUG), { recursive: true })
    persistRunForTalk(B, SLUG, RUN, { ...published, status: 'delivered' })
    const runB = () => readRunForTalk(B, SLUG, RUN)
    const ended = new Set()
    const openerOver = (vaults) => createPostWorkOpener({ service: t.service, vaults: () => vaults,
      liveEnded: (talkSlug, runId, vaultRoot) => ended.has(`${vaultRoot}|${talkSlug}/${runId}`), now: () => clock.now })
    const both = openerOver([t.vault, B])
    clock.now = Date.UTC(2026, 9, 21, 15)
    const pushes = t.worker.pushes()
    // A's session ends; A's Run has had its post-work removed. B's copy still holds post-work and is delivered.
    const { post: _removed, ...onlyPre } = published.work
    t.write({ ...published, work: onlyPre })
    ended.add(`${t.vault}|${SLUG}/${RUN}`)
    assert.equal((await both.open(SLUG, RUN, t.vault)).why, 'no-post-work', 'ending A\'s session reads A\'s Run only')
    // The timer reads the Run in the vault the object's row records (A), never B's copy.
    assert.deepEqual((await both.openDue()).map((result) => result.why), ['no-post-work'])
    // A's vault closed: the session's end names it, so nothing is read, and B is never used in its place.
    const onlyB = openerOver([B])
    assert.equal((await onlyB.open(SLUG, RUN, t.vault)).why, 'no-run')
    assert.equal((await onlyB.open(SLUG, RUN, null)).why, 'no-run', 'a session that recorded no vault opens nothing')
    assert.equal(t.worker.pushes(), pushes, 'not one push')
    assert.equal(runB().work.post.openedAt, undefined, 'B\'s Run is never noted')
    // A session of B's ended does not count as A's.
    t.write(published)
    ended.clear()
    ended.add(`${B}|${SLUG}/${RUN}`)
    assert.equal((await both.open(SLUG, RUN, t.vault)).why, 'not-ended')
    // A's own session ends: A's Run is opened and noted; B's copy is untouched.
    ended.add(`${t.vault}|${SLUG}/${RUN}`)
    const opened = await both.open(SLUG, RUN, t.vault)
    assert.equal(opened.opened && opened.pushed, true)
    assert.equal(t.run().work.post.openedAt, '2026-10-21T15:00:00.000Z')
    assert.equal(runB().work.post.openedAt, undefined)
    pass('the Run\'s own vault only: ending A\'s session never opens B\'s copy; the timer reads A\'s Run, not B\'s; a closed vault is not read')
  } finally { t.done() }
}

// 9b. Decided inside the object's turn: post-work removed while a pull holds it.
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    const sent = await t.publish()
    clock.now = Date.UTC(2026, 9, 21, 15)
    t.write({ ...t.run(), status: 'delivered' })
    const pushes = t.worker.pushes()
    const held = t.worker.holdNext('results')
    const pulling = t.service.pull(SLUG, RUN, 'post')
    await held.reached
    const opening = t.opener.open(SLUG, RUN, t.vault) // decides from the Run as it is now, then waits for the object's turn
    await ticks()
    const { post: _removed, ...onlyPre } = t.run().work
    t.write({ ...t.run(), work: onlyPre })
    held.release()
    await pulling
    assert.equal((await opening).why, 'changed')
    assert.equal(t.worker.pushes(), pushes, 'no opening was sent')
    assert.equal(t.worker.state(sent.post.preworkId), 'not_yet')
    pass('post-work removed while a pull holds the object\'s turn: the queued opening is decided again and nothing opens')
  } finally { t.done() }
}

// 9c. A recorded publish is needed: a first publish that failed after the object was made opens nothing.
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    // The object is made and its form pushed; the pages then fail, so the Run is never stamped published.
    await t.service.publish(SLUG, RUN, FORM, workPushWindowMs(t.run().work.post, null), 'post', t.vault)
    clock.now = Date.UTC(2026, 9, 21, 15)
    t.write({ ...t.run(), status: 'delivered' })
    t.live.ended.add(`${SLUG}/${RUN}`)
    const pushes = t.worker.pushes()
    assert.equal((await t.opener.open(SLUG, RUN, t.vault)).why, 'not-published')
    assert.deepEqual((await t.opener.openDue()).map((result) => result.why), ['not-published'])
    assert.equal(t.worker.pushes(), pushes)
    pass('a row with no recorded publish of the Run (a failed first publish): nothing opens')
  } finally { t.done() }
}

// 9d. Noted only on the post-work that was opened: replaced while the push was in flight.
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    await t.publish()
    clock.now = Date.UTC(2026, 9, 21, 15)
    t.write({ ...t.run(), status: 'delivered' })
    const held = t.worker.holdNext('form')
    const opening = t.opener.open(SLUG, RUN, t.vault)
    await held.reached
    t.write({ ...t.run(), work: { ...t.run().work, post: { fileId: 'another-file', opens: 'session-end', closes: POST.closes, timeZone: 'UTC' } } })
    held.release()
    assert.equal((await opening).why, 'changed')
    assert.equal(t.run().work.post.openedAt, undefined, 'the replacement was never sent, so it is not noted open')
    assert.notEqual(step(runChecklist(t.run(), new Date(clock.now + MIN), FILES9), 'post-open').state, 'done')
    assert.equal((await t.opener.open(SLUG, RUN, t.vault)).why, 'not-published', 'and the next cycle decides again')
    pass('post-work replaced while its opening was in flight: nothing is noted on the replacement')
  } finally { t.done() }
}

// 9e. Review round 2: set time tomorrow changed to when the session ends, after delivery: it opens now.
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp({ pre: PRE, post: { ...POST, opens: '2026-10-22T09:00' } })
  try {
    const sent = await t.publish()
    clock.now = Date.UTC(2026, 9, 21, 15)
    t.write({ ...t.run(), status: 'delivered', endedAt: '2026-10-21T15:00:00.000Z' })
    changeDeliveredRunWork(t.vault, SLUG, RUN, { work: { post: { fileId: POST.fileId, opens: 'session-end', closes: POST.closes } } })
    assert.equal(t.run().work.post.opens, 'session-end')
    // What main does after a timing edit (onPlannedRunUpdated): push the new times, then open what is owed.
    await t.service.syncWindows(SLUG, RUN)
    assert.equal(t.service.status(SLUG, RUN, 'post').opensAt, Date.UTC(2026, 9, 22, 9), 'the times pushed keep tomorrow\'s opening')
    assert.equal(t.worker.state(sent.post.preworkId), 'not_yet')
    const opened = await t.opener.open(SLUG, RUN, t.vault)
    assert.deepEqual([opened.opened, opened.pushed, opened.openedAt], [true, true, '2026-10-21T15:00:00.000Z'], 'opened now, not tomorrow')
    assert.equal(t.worker.state(sent.post.preworkId), 'open', 'participants can answer now')
    assert.equal(t.service.status(SLUG, RUN, 'post').opensAt, clock.now)
    assert.equal(t.run().work.post.openedAt, '2026-10-21T15:00:00.000Z')
    const checklist = runChecklist(t.run(), new Date(clock.now + MIN), FILES9)
    assert.equal(step(checklist, 'post-open').state, 'done', 'the checklist reads open')
    assert.equal(step(checklist, 'published').qr, 'post-work')
    // Once: the timer, a later plan sync and the next day push nothing more.
    const pushes = t.worker.pushes()
    assert.equal((await t.opener.openDue())[0].why, 'already-open')
    await t.service.syncWindows(SLUG, RUN)
    assert.equal(t.service.status(SLUG, RUN, 'post').opensAt, Date.UTC(2026, 9, 21, 15), 'the opening is kept')
    assert.equal(t.worker.pushes(), pushes)
    pass('a delivered Run\'s post-work changed from tomorrow to when the session ends opens now, and the checklist reads open')
  } finally { t.done() }
}

// 9f. A plan change while the opening is in flight keeps the opening (syncWindows decides inside the turn).
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    const sent = await t.publish()
    clock.now = Date.UTC(2026, 9, 21, 15)
    t.write({ ...t.run(), status: 'delivered', endedAt: '2026-10-21T15:00:00.000Z' })
    const held = t.worker.holdNext('form')
    const opening = t.opener.open(SLUG, RUN, t.vault)
    await held.reached
    changeDeliveredRunWork(t.vault, SLUG, RUN, { work: { post: { fileId: POST.fileId, opens: 'session-end', closes: '2026-11-11T17:00' } } })
    const syncing = t.service.syncWindows(SLUG, RUN)
    await ticks()
    held.release()
    const [opened, synced] = await Promise.all([opening, syncing])
    assert.equal(opened.opened && opened.pushed, true)
    assert.deepEqual(synced.map((result) => [result.phase, result.ok]), [['post', true]])
    const status = t.service.status(SLUG, RUN, 'post')
    assert.deepEqual([status.opensAt, status.closesAt], [clock.now, Date.UTC(2026, 10, 11, 17)], 'the opening kept, the new closing time pushed')
    assert.equal(t.worker.state(sent.post.preworkId), 'open', 'never pushed back to the window that never opens')
    assert.equal(t.run().work.post.openedAt, '2026-10-21T15:00:00.000Z')
    const pushes = t.worker.pushes()
    assert.equal((await t.opener.openDue())[0].why, 'already-open')
    assert.equal(t.worker.pushes(), pushes, 'and no second opening')
    pass('a plan change saved while the opening is in flight: the opening is kept and the new closing time pushed')
  } finally { t.done() }
}

// 10. Review round 2: the object belongs to the vault its row records ────────────────────────────────
/** Vault B beside the harness's vault (A), holding a copy of A's Run as published, delivered. */
function copyIntoB(t, run) {
  const B = join(t.root, 'vault-b')
  mkdirSync(join(B, '_PRESENTATIONS', SLUG), { recursive: true })
  persistRunForTalk(B, SLUG, RUN, { ...run, status: 'delivered' })
  return B
}

// 10a. The reviewer's probe: A published, its record copied to B, A closed, B delivered: the timer opens nothing.
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    const sent = await t.publish()
    assert.equal(t.service.status(SLUG, RUN, 'post').vaultRoot, t.vault, 'the publish records its vault on the row')
    const B = copyIntoB(t, t.run())
    clock.now = Date.UTC(2026, 9, 21, 15)
    const pushes = t.worker.pushes()
    const ended = new Set([`${B}|${SLUG}/${RUN}`])
    const onlyB = createPostWorkOpener({ service: t.service, vaults: () => [B],
      liveEnded: (talkSlug, runId, vaultRoot) => ended.has(`${vaultRoot}|${talkSlug}/${runId}`), now: () => clock.now })
    assert.deepEqual((await onlyB.openDue()).map((result) => [result.opened, result.why]), [[false, 'no-run']], 'A is closed: its Run is not read, and B is not used')
    // Issue 256: B's Run is looked up under B's own key, where nothing was sent; A's object is not even read.
    assert.equal((await onlyB.open(SLUG, RUN, B)).why, 'not-sent', 'naming B does not make A\'s object B\'s')
    // Both open: still A's Run only (planned, so nothing is owed), never B's delivered copy.
    const both = createPostWorkOpener({ service: t.service, vaults: () => [t.vault, B],
      liveEnded: (talkSlug, runId, vaultRoot) => ended.has(`${vaultRoot}|${talkSlug}/${runId}`), now: () => clock.now })
    assert.deepEqual((await both.openDue()).map((result) => result.why), ['not-ended'])
    assert.equal(t.worker.pushes(), pushes, 'not one push')
    assert.equal(t.worker.state(sent.post.preworkId), 'not_yet', 'A\'s object stays unopened')
    assert.equal(readRunForTalk(B, SLUG, RUN).work.post.openedAt, undefined)
    pass('the reviewer\'s probe: A published, copied to B, A closed, B delivered: the timer opens nothing; naming B opens nothing')
  } finally { t.done() }
}

// 10b. Queued while a pull holds the object's turn: a second vault opened meanwhile changes nothing; A closed
// meanwhile, or the Run published from B meanwhile, opens nothing.
{
  for (const meanwhile of ['b-opens', 'a-closes', 'b-publishes']) {
    clock.now = Date.UTC(2026, 9, 20, 9)
    const t = setUp()
    try {
      const sent = await t.publish()
      clock.now = Date.UTC(2026, 9, 21, 15)
      t.write({ ...t.run(), status: 'delivered' })
      const B = copyIntoB(t, t.run())
      let open = [t.vault]
      const opener = createPostWorkOpener({ service: t.service, vaults: () => open, liveEnded: () => false, now: () => clock.now })
      const pushes = t.worker.pushes()
      const held = t.worker.holdNext('results')
      const pulling = t.service.pull(SLUG, RUN, 'post')
      await held.reached
      // Published from B (queued behind the pull, ahead of the opening's push): the row then records B.
      const republish = meanwhile === 'b-publishes'
        ? t.service.publish(SLUG, RUN, FORM, workPushWindowMs(t.run().work.post, t.service.status(SLUG, RUN, 'post')), 'post', B) : null
      const due = opener.openDue() // decides on A's Run now (the row still records A), then waits for the object's turn
      await ticks()
      if (meanwhile === 'b-opens') open = [t.vault, B]
      if (meanwhile === 'a-closes') open = [B]
      held.release()
      await pulling
      const [result] = await due
      const republished = await republish
      if (meanwhile === 'b-publishes') {
        // Issue 256: publishing B's copy makes B's own object; A's row and object are not B's to take, so A's
        // Run (in A, open) has its post-work opened as owed, and B's object is left as it was pushed.
        assert.notEqual(republished.preworkId, sent.post.preworkId, 'B\'s copy gets its own object')
        assert.deepEqual([result.opened, result.pushed], [true, true], 'A\'s Run, in A\'s vault, opens A\'s object')
        assert.equal(t.service.status(SLUG, RUN, 'post').vaultRoot, t.vault, 'A\'s row still records A')
        assert.equal(t.service.status(SLUG, RUN, 'post', B).preworkId, republished.preworkId, 'B\'s row is B\'s')
        assert.equal(t.worker.state(republished.preworkId), 'not_yet', 'B\'s object is not opened')
        assert.equal(readRunForTalk(B, SLUG, RUN).work.post.openedAt, undefined, 'B\'s copy is never written')
      } else if (meanwhile === 'b-opens') {
        assert.deepEqual([result.opened, result.pushed], [true, true], 'A\'s Run, in A\'s vault, opens A\'s object')
        assert.equal(t.run().work.post.openedAt, '2026-10-21T15:00:00.000Z')
        assert.equal(readRunForTalk(B, SLUG, RUN).work.post.openedAt, undefined, 'B\'s copy is never written')
      } else {
        assert.equal(result.why, 'changed', meanwhile)
        assert.equal(t.worker.state(sent.post.preworkId), 'not_yet', meanwhile)
        assert.equal(t.run().work.post.openedAt, undefined, meanwhile)
        assert.equal(t.worker.pushes(), pushes, `${meanwhile}: no opening was sent`)
      }
    } finally { t.done() }
  }
  pass('queued behind a pull: a vault opened meanwhile changes nothing; the row\'s vault closed meanwhile opens nothing; a copy published from another vault meanwhile gets its own object and leaves A\'s alone')
}

// 10c. A row that records no vault (published before it was kept) never opens on its own; publishing again records it.
{
  clock.now = Date.UTC(2026, 9, 20, 9)
  const t = setUp()
  try {
    const run = t.run()
    const sent = await t.service.publish(SLUG, RUN, FORM, workPushWindowMs(run.work.post, null), 'post')
    t.write({ ...run, work: { ...run.work, post: { ...run.work.post, publishedAt: new Date(clock.now).toISOString() } } })
    assert.equal(t.service.status(SLUG, RUN, 'post').vaultRoot, undefined)
    clock.now = Date.UTC(2026, 9, 21, 15)
    t.write({ ...t.run(), status: 'delivered' })
    t.live.ended.add(`${SLUG}/${RUN}`)
    const pushes = t.worker.pushes()
    assert.deepEqual((await t.opener.openDue()).map((result) => result.why), ['no-vault'])
    assert.equal((await t.opener.open(SLUG, RUN, t.vault)).why, 'no-vault', 'not by the session\'s end either')
    assert.equal(t.worker.pushes(), pushes)
    await t.publish()
    const opened = await t.opener.open(SLUG, RUN, t.vault)
    assert.deepEqual([opened.opened, opened.pushed], [true, true], 'published again: the row records the vault, and it opens')
    assert.equal(t.worker.state(sent.preworkId), 'open')
    pass('a row that records no vault never opens on its own; publishing again records it and it opens')
  } finally { t.done() }
}

console.log(`\npost-work opens: ${results.length} groups passed`)
