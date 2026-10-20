// Work-files ticket 13: the app's work service per phase (src/main/run-prework.ts) against a fake
// Worker endpoint. The fake answers through the Worker's own pure rules (worker/prework-state.ts:
// push, close, withdraw, results, submissions), so reopening and closing behave as they do there;
// the real Worker is `npm run test:run-prework:live`. Real registry, real secrets store (in memory),
// a temp vault and the real atomic Run writer.
//   1. one registry row per Run and phase; pre and post answers land in their own sections, by id;
//   2. answers the Worker says belong to the other phase are never mirrored;
//   3. the cursor moves only after the Run is written: a write that fails leaves it, the next pull reads again;
//   4. a locked secrets store leaves the row untouched: every operation says so and sends nothing;
//   5. a 0.37 registry row keeps working as phase `pre`;
//   6. a later closing time re-pushes the window and reopens the phase (by date or the owner's early
//      close); an admin's close stays; the Run's early close is cleared once reopened;
//   7. withdraw and serve again; the answers can still be pulled;
//   8. the IPC handlers take a phase; no owner token reaches a window, the registry file or a log;
//   9. (ticket 18) picking and marking work on post-work answers; a malformed Run id is refused before
//      the registry is read (it cannot reach another phase's row); a 2xx pull that is not JSON is an error, not a throw.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-run-work-service.mjs
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PREWORK_LOCKED, createRunPrework, parseRunPreworkKey, registerRunPreworkIpc, runPreworkKey, vaultKeyPart, workWindowMs } from '../src/main/run-prework.ts'
import { createOwnerTokens } from '../src/main/owner-tokens.ts'
import { sentPhases, withdrawRunWork } from '../src/main/run-unpublish.ts'
import { serveWorkAgain } from '../src/main/run-work-publish.ts'
import { normaliseRun, persistRunForTalk, readRunForTalk } from '../src/main/runs.ts'
import { workKeyMissing, workOwnerUnknown } from '../src/shared/run-work.ts'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { memoryOwnerTokens } from './lib/memory-secrets.mjs'

// The Worker's own rules, bundled (they use TypeScript Node cannot strip).
const rulesDir = mkdtempSync(join(tmpdir(), 'tw-work-rules-'))
const rulesEntry = join(rulesDir, 'rules.ts')
const repo = new URL('..', import.meta.url).pathname
writeFileSync(rulesEntry, `export * from '${repo}worker/prework-state.ts'\nexport { parsePreworkFormPush } from '${repo}worker/prework-protocol.ts'\n`)
const bundled = await build({ entryPoints: [rulesEntry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
writeFileSync(join(rulesDir, 'rules.mjs'), bundled.outputFiles[0].text)
const {
  PreworkError, closePrework, createMemoryPreworkStore, createPrework, parsePreworkFormPush, preworkStatus, pushForm, resultsPage, submitPrework, withdrawPrework,
} = await import(pathToFileURL(join(rulesDir, 'rules.mjs')).href)
rmSync(rulesDir, { recursive: true, force: true })

const results = []
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`) }
const ORIGIN = 'https://live.example.test'
const SLUG = 'work-service-talk'
const RUN = 'run-work-service'
const P1 = 'a1b2c3d4e5f60718'
const P2 = '0f1e2d3c4b5a6978'
const clock = { now: Date.UTC(2026, 9, 2, 12) }

// Everything written to the console while this runs: no owner token may ever be in it.
const logged = []
for (const level of ['log', 'warn', 'error']) {
  const original = console[level]
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); if (level !== 'warn') original(...args) }
}

// ── The fake Worker: the real rules over memory ───────────────────────────────────────────────
function fakeWorker() {
  const objects = new Map()
  const world = { objects, calls: [], made: 0, offline: false, phaseOverride: null }
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const refusal = (error) => reply({ error: { code: error.code, message: error.message } }, error.status)
  world.create = () => {
    world.made += 1
    const id = `wkobj${String(world.made).padStart(3, '0')}`
    const object = { prework: createPrework(id, clock.now), store: createMemoryPreworkStore(), token: `owner-token-${id}-0123456789abcdef` }
    objects.set(id, object)
    return { preworkId: id, ownerToken: object.token }
  }
  world.submit = (id, participant, submission) => {
    const object = objects.get(id)
    return submitPrework(object.prework, object.store, participant, { participantId: `device-${participant}`, submissionId: `sub-${Math.random()}`, ...submission }, clock.now)
  }
  world.adminClose = (id) => closePrework(objects.get(id).prework, clock.now, 'admin')
  world.status = (id) => preworkStatus(objects.get(id).prework, clock.now)
  world.fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url)
    const method = init.method ?? 'GET'
    const auth = new Headers(init.headers).get('authorization')
    world.calls.push(`${method} ${pathname}${searchParams.size ? `?${searchParams}` : ''}`)
    if (world.offline) throw new TypeError(`fetch failed for ${auth}`) // a transport error that quotes the header: must never surface
    if (pathname === '/prework' && method === 'POST') return auth === 'Bearer admin' ? reply(world.create(), 201) : reply({ error: { code: 'admin_auth_required' } }, 401)
    const [, , id, action] = pathname.split('/')
    const object = objects.get(id)
    if (!object) return reply({ error: { code: 'not_found', message: 'Pre-work not found.' } }, 404)
    if (auth !== `Bearer ${object.token}`) return reply({ error: { code: 'owner_auth_required' } }, 401)
    try {
      switch (action) {
        case 'form': {
          const parsed = parsePreworkFormPush(JSON.parse(init.body), clock.now)
          if ('error' in parsed) return reply({ error: parsed.error }, 400)
          pushForm(object.prework, parsed.value, clock.now)
          return reply({ ok: true, status: preworkStatus(object.prework, clock.now) })
        }
        case 'results': {
          if (world.garbage) return new Response('<html>a proxy page, not JSON</html>', { status: 200, headers: { 'content-type': 'text/html' } })
          const page = resultsPage(object.prework, object.store, Number(searchParams.get('after') ?? 0), clock.now)
          return reply(world.phaseOverride ? { ...page, phase: world.phaseOverride } : page)
        }
        case 'close': return reply({ ok: true, closedAt: closePrework(object.prework, clock.now, 'owner') })
        case 'waiting': return reply({ waiting: world.waiting ?? 0 })
        case 'withdraw': {
          const withdrawn = init.body ? JSON.parse(init.body).withdrawn !== false : true
          const withdrawnAt = withdrawPrework(object.prework, withdrawn, clock.now)
          return reply({ ok: true, withdrawn, ...(withdrawnAt !== null ? { withdrawnAt } : {}) })
        }
      }
    } catch (error) {
      if (error instanceof PreworkError) return refusal(error)
      throw error
    }
    return reply({ error: { code: 'not_found' } }, 404)
  }
  return world
}

const FORM = {
  title: 'Work', intro: '',
  steps: [
    { id: 's1', n: 1, title: 'Read this', kind: 'slide', questions: true },
    { id: 'q1', n: 2, title: 'Hopes', kind: 'question', questions: true, poll: { type: 'open', question: 'Hopes', options: [] } },
  ],
}

function plannedRun(work) {
  return normaliseRun({
    id: RUN, talkSlug: SLUG, talkTitle: 'Work service', kind: 'delivery', status: 'planned', plannedDate: '2026-10-06', startTime: '10:00',
    timeZone: 'UTC', slideSet: { kind: 'full' }, startedAt: '2026-10-06T10:00:00.000Z', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0,
    context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [],
    work,
  })
}
const WORK = {
  pre: { fileId: 'intake', opens: '2026-10-01T09:00', closes: '2026-10-05T10:00', timeZone: 'UTC' },
  post: { fileId: 'feedback', opens: '2026-10-06T11:00', closes: '2026-10-13T17:00', timeZone: 'UTC' },
}

function setUp() {
  const root = mkdtempSync(join(tmpdir(), 'tw-work-service-'))
  const vault = join(root, 'vault')
  mkdirSync(join(vault, '_PRESENTATIONS', SLUG), { recursive: true })
  persistRunForTalk(vault, SLUG, RUN, plannedRun(WORK))
  const worker = fakeWorker()
  const tokens = memoryOwnerTokens()
  const registryPath = join(root, 'run-prework-registry.json')
  const make = (ownerTokens = tokens) => createRunPrework({ registryPath, ownerTokens, endpoint: async () => ({ baseUrl: ORIGIN, adminSecret: 'admin' }), vaultRoot: () => vault, fetch: worker.fetch, now: () => clock.now })
  const runFile = join(vault, '_PRESENTATIONS', SLUG, `${RUN}.json`)
  const registry = () => JSON.parse(readFileSync(registryPath, 'utf8')).preworks
  // The registry key of this Run's phase in this vault (issue 256: keys name the vault).
  const key = (phase = 'pre') => runPreworkKey(SLUG, RUN, phase, vaultKeyPart({ root: vault }))
  return { root, vault, worker, tokens, registryPath, service: make(), make, runFile, registry, key, run: () => readRunForTalk(vault, SLUG, RUN) }
}

async function publishBoth(t) {
  const run = t.run()
  const pre = await t.service.publish(SLUG, RUN, FORM, workWindowMs(run.work.pre), 'pre', t.vault)
  const post = await t.service.publish(SLUG, RUN, FORM, workWindowMs(run.work.post), 'post', t.vault)
  return { pre, post }
}

const allTokens = (t) => [...t.worker.objects.values()].map((object) => object.token)

// 1. One row per Run and phase; answers land in their own sections, merged by id ───────────────
{
  clock.now = Date.UTC(2026, 9, 2, 12)
  const t = setUp()
  try {
    const { pre, post } = await publishBoth(t)
    assert.notEqual(pre.preworkId, post.preworkId, 'pre-work and post-work are two objects')
    assert.deepEqual(Object.keys(t.registry()).sort(), [t.key('post'), t.key()].sort(), 'one registry row per Run and phase, under the vault\'s key')
    assert.equal(t.registry()[t.key('post')].phase, 'post')
    assert.equal('phase' in t.registry()[t.key()], false, 'a pre-work row is written as 0.37 wrote it')
    assert.equal(t.worker.objects.get(post.preworkId).prework.phase, 'post', 'the post-work form was pushed as post')
    assert.equal(t.service.status(SLUG, RUN, 'post').phase, 'post')
    assert.equal(t.service.status(SLUG, RUN).preworkId, pre.preworkId, 'no phase asked: pre-work')
    // A republish reuses each phase's own object.
    await publishBoth(t)
    assert.equal(t.worker.made, 2)

    t.worker.submit(pre.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'Before: first try' })
    t.worker.submit(pre.preworkId, P2, { stepId: 's1', kind: 'read' })
    clock.now = Date.UTC(2026, 9, 7, 9)
    t.worker.submit(post.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'After: it helped' })
    assert.equal((await t.service.pull(SLUG, RUN, 'pre')).ok, true)
    assert.equal((await t.service.pull(SLUG, RUN, 'post')).ok, true)
    let run = t.run()
    assert.deepEqual(run.prework.entries.map((entry) => entry.text ?? entry.kind), ['Before: first try', 'read'], 'pre-work answers are in prework')
    assert.deepEqual(run.postwork.entries.map((entry) => entry.text), ['After: it helped'], 'post-work answers are in postwork')
    // A changed answer replaces its copy by id; nothing doubles; the other phase is untouched.
    clock.now = Date.UTC(2026, 9, 8, 9)
    t.worker.submit(post.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'After: it helped a lot' })
    t.worker.submit(post.preworkId, P2, { stepId: 'q1', kind: 'answer', text: 'After: more time please' })
    const before = JSON.stringify(t.run().prework)
    const pulled = await t.service.pull(SLUG, RUN, 'post')
    assert.equal(pulled.ok && pulled.added, 1)
    run = t.run()
    assert.deepEqual(run.postwork.entries.map((entry) => entry.text), ['After: it helped a lot', 'After: more time please'], 'merged by entry id')
    assert.equal(JSON.stringify(run.prework), before, 'a post-work pull leaves pre-work as it was')
    assert.equal(t.registry()[t.key('post')].cursor, 3, 'the post-work cursor is its own')
    assert.equal(t.registry()[t.key()].cursor, 2)
    // The timer pulls each open phase.
    assert.deepEqual(t.service.due(), [{ talkSlug: SLUG, runId: RUN, phase: 'post' }], 'after the session only post-work is open')
    pass('one row per Run and phase; pre and post answers land in their own sections on the Run, merged by id; each phase has its own cursor')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
}

// 2. Answers of the other phase are never mirrored ────────────────────────────────────────────
{
  clock.now = Date.UTC(2026, 9, 2, 12)
  const t = setUp()
  try {
    const { pre } = await publishBoth(t)
    t.worker.submit(pre.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'pre answer' })
    t.worker.phaseOverride = 'post'
    const bytes = readFileSync(t.runFile, 'utf8')
    const refused = await t.service.pull(SLUG, RUN, 'pre')
    assert.equal(refused.ok, false)
    assert.match(refused.error, /other work/)
    assert.equal(readFileSync(t.runFile, 'utf8'), bytes, 'the Run is not written')
    assert.equal(t.registry()[t.key()].cursor, 0, 'and the cursor does not move')
    t.worker.phaseOverride = null
    assert.equal((await t.service.pull(SLUG, RUN, 'pre')).ok, true)
    pass('answers the Worker says are the other phase\'s are refused: nothing written, the cursor stays')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
}

// 3. The cursor moves only after the write lands ──────────────────────────────────────────────
{
  clock.now = Date.UTC(2026, 9, 2, 12)
  const t = setUp()
  const folder = join(t.vault, '_PRESENTATIONS', SLUG)
  try {
    const { pre } = await publishBoth(t)
    t.worker.submit(pre.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'kept for later' })
    t.worker.submit(pre.preworkId, P2, { stepId: 'q1', kind: 'answer', text: 'also kept' })
    chmodSync(folder, 0o555) // the atomic writer cannot put its temporary file beside the Run
    const failed = await t.service.pull(SLUG, RUN, 'pre')
    chmodSync(folder, 0o755)
    assert.equal(failed.ok, false, 'a Run that cannot be written is reported')
    assert.match(failed.error, /could not be saved to the Run/)
    assert.equal(t.registry()[t.key()].cursor, 0, 'the cursor did not move')
    assert.equal(t.run().prework, undefined)
    const from = t.worker.calls.length
    const again = await t.service.pull(SLUG, RUN, 'pre')
    assert.equal(again.ok && again.added, 2, 'the next pull reads the same answers again and writes them')
    assert.deepEqual(t.worker.calls.slice(from), [`GET /prework/${pre.preworkId}/results?after=0`], 'from where the Run was last written')
    assert.equal(t.registry()[t.key()].cursor, 2, 'and only then the cursor moves')
    pass('the cursor moves only after the Run is written: a failed write leaves it, and the next pull reads the same answers again')
  } finally { chmodSync(folder, 0o755); rmSync(t.root, { recursive: true, force: true }) }
}

// 4. A locked secrets store leaves the row untouched ─────────────────────────────────────────
{
  clock.now = Date.UTC(2026, 9, 2, 12)
  const t = setUp()
  try {
    const { pre } = await publishBoth(t)
    t.worker.submit(pre.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'waiting' })
    const registryBytes = readFileSync(t.registryPath, 'utf8')
    const runBytes = readFileSync(t.runFile, 'utf8')
    const storeBytes = JSON.stringify([...t.tokens.secrets.files.blobs.entries()].map(([path, blob]) => [path, blob.toString('base64')]))
    const calls = t.worker.calls.length
    t.tokens.secrets.cipher.state.locked = true
    const locked = t.make(createOwnerTokens(t.tokens.secrets.store, { now: () => 0 }))
    for (const phase of ['pre', 'post']) {
      const word = phase === 'post' ? 'Post-work' : 'Pre-work'
      const lockedText = PREWORK_LOCKED.replace('pre-work', `${word.toLowerCase()}`)
      assert.equal(locked.status(SLUG, RUN, phase), null, `${phase}: no state while the key cannot be read`)
      assert.deepEqual(await locked.pull(SLUG, RUN, phase), { ok: false, error: lockedText, run: t.run() }, `${phase}: a pull says the key cannot be read`)
      assert.deepEqual(await locked.close(SLUG, RUN, phase), { ok: false, error: lockedText })
      assert.deepEqual(await locked.withdraw(SLUG, RUN, phase), { ok: false, error: lockedText })
      assert.deepEqual(await locked.pushWindow(SLUG, RUN, phase, { opensAt: clock.now, closesAt: clock.now + 86_400_000 }), { ok: false, phase, error: lockedText })
      await assert.rejects(locked.publish(SLUG, RUN, FORM, { opensAt: clock.now, closesAt: clock.now + 86_400_000 }, phase), { message: lockedText }, `${phase}: no second object is made`)
    }
    // A plan change while locked: said, nothing sent.
    persistRunForTalk(t.vault, SLUG, RUN, plannedRun({ ...WORK, pre: { ...WORK.pre, closes: '2026-10-06T10:00' } }))
    const synced = await locked.syncWindows(SLUG, RUN)
    assert.deepEqual(synced.map((result) => [result.phase, result.ok]), [['pre', false], ['post', false]])
    assert.deepEqual(locked.due(), [], 'the timer does not reach rows it cannot use')
    assert.equal(t.worker.calls.length, calls, 'nothing was sent to the Worker')
    assert.equal(readFileSync(t.registryPath, 'utf8'), registryBytes, 'the registry rows are untouched')
    assert.equal(JSON.stringify([...t.tokens.secrets.files.blobs.entries()].map(([path, blob]) => [path, blob.toString('base64')])), storeBytes, 'the secrets store is not written over')
    persistRunForTalk(t.vault, SLUG, RUN, plannedRun(WORK))
    assert.equal(readFileSync(t.runFile, 'utf8'), runBytes)
    // Unlocked: the same rows work again.
    t.tokens.secrets.cipher.state.locked = false
    const unlocked = t.make(createOwnerTokens(t.tokens.secrets.store))
    const pulled = await unlocked.pull(SLUG, RUN, 'pre')
    assert.equal(pulled.ok && pulled.added, 1, 'unlocked, the row is back and its answers are pulled')
    pass('a locked secrets store: every operation on either phase says the key cannot be read; nothing is sent, and the registry, the store and the Run are untouched')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
}

// 5. A 0.37 registry row keeps working as phase pre ──────────────────────────────────────────
{
  clock.now = Date.UTC(2026, 9, 2, 12)
  const t = setUp()
  try {
    // As 0.37 made it: the object pushed without a phase, the row in plain JSON with its token and no phase.
    const made = t.worker.create()
    const push = await t.worker.fetch(`${ORIGIN}/prework/${made.preworkId}/form`, { method: 'PUT', headers: { authorization: `Bearer ${made.ownerToken}` },
      body: JSON.stringify({ opensAt: Date.UTC(2026, 9, 1, 9), closesAt: Date.UTC(2026, 9, 5, 10), form: FORM }) })
    assert.equal(push.status, 200)
    const key = `${SLUG}/${RUN}`
    writeFileSync(t.registryPath, `${JSON.stringify({ version: 1, preworks: { [key]: { key, preworkId: made.preworkId, ownerToken: made.ownerToken, workerBaseUrl: ORIGIN,
      opensAt: Date.UTC(2026, 9, 1, 9), closesAt: Date.UTC(2026, 9, 5, 10), cursor: 0, vaultRoot: t.vault, createdAt: Date.UTC(2026, 8, 30) } } }, null, 2)}\n`)
    const service = t.make()
    assert.deepEqual(service.status(SLUG, RUN), { preworkId: made.preworkId, phase: 'pre', opensAt: Date.UTC(2026, 9, 1, 9), closesAt: Date.UTC(2026, 9, 5, 10), vaultRoot: t.vault })
    assert.equal(service.status(SLUG, RUN, 'post'), null, 'it is never read as post-work')
    t.worker.submit(made.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'from 0.37' })
    assert.equal((await service.pull(SLUG, RUN)).ok, true)
    assert.equal(t.run().prework.entries[0].text, 'from 0.37')
    assert.equal(t.run().postwork, undefined)
    const republished = await service.publish(SLUG, RUN, FORM, workWindowMs(t.run().work.pre), 'pre', t.vault)
    assert.equal(republished.preworkId, made.preworkId, 'publishing pre-work reuses it')
    // Issue 256: the publish moves the row under its vault's key; the old key is gone and its token still reads.
    assert.equal(t.registry()[key], undefined, 'the row from before keys named the vault is moved')
    assert.equal(t.registry()[t.key()].preworkId, made.preworkId, 'under the vault\'s own key')
    assert.equal(service.status(SLUG, RUN).preworkId, made.preworkId, 'and still read, with its token')
    const post = await service.publish(SLUG, RUN, FORM, workWindowMs(t.run().work.post), 'post', t.vault)
    assert.notEqual(post.preworkId, made.preworkId, 'post-work gets its own object beside it')
    assert.deepEqual(service.due(), [{ talkSlug: SLUG, runId: RUN, phase: 'pre' }])
    pass('a 0.37 registry row (no phase, token in plain JSON) keeps working as pre-work: status, pull, republish; post-work is made beside it')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
}

// 6. A later closing time reopens; an admin close stays ──────────────────────────────────────
{
  clock.now = Date.UTC(2026, 9, 2, 12)
  const t = setUp()
  try {
    const { pre, post } = await publishBoth(t)
    // Post-work closed by its date; the Run's closing time moves later: reopened.
    clock.now = Date.UTC(2026, 9, 14, 9)
    assert.equal(t.worker.status(post.preworkId).state, 'closed')
    assert.throws(() => t.worker.submit(post.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'late' }), { code: 'prework_closed' })
    persistRunForTalk(t.vault, SLUG, RUN, plannedRun({ ...WORK, post: { ...WORK.post, closes: '2026-10-20T17:00' } }))
    const calls = t.worker.calls.length
    const synced = await t.service.syncWindows(SLUG, RUN)
    assert.deepEqual(synced, [{ ok: true, phase: 'post', opensAt: Date.UTC(2026, 9, 6, 11), closesAt: Date.UTC(2026, 9, 20, 17) }], 'only the phase whose time changed is pushed')
    assert.deepEqual(t.worker.calls.slice(calls), [`PUT /prework/${post.preworkId}/form`])
    assert.equal(t.worker.status(post.preworkId).state, 'open', 'a later closing time reopens it')
    assert.deepEqual(t.worker.objects.get(post.preworkId).prework.form, FORM, 'the window is pushed without the form; the form stays')
    assert.equal(t.service.status(SLUG, RUN, 'post').closesAt, Date.UTC(2026, 9, 20, 17))
    t.worker.submit(post.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'late but welcome' })
    assert.deepEqual(await t.service.syncWindows(SLUG, RUN), [], 'nothing changed: nothing pushed')

    // Pre-work closed early by the owner, then given a later closing time: reopened, and the Run says so.
    clock.now = Date.UTC(2026, 9, 3, 9)
    assert.equal((await t.service.close(SLUG, RUN, 'pre')).ok, true)
    assert.equal(t.run().prework.closedAt, clock.now)
    persistRunForTalk(t.vault, SLUG, RUN, { ...t.run(), work: { ...WORK, pre: { ...WORK.pre, closes: '2026-10-06T10:00' }, post: { ...WORK.post, closes: '2026-10-20T17:00' } } })
    const reopened = await t.service.syncWindows(SLUG, RUN)
    assert.deepEqual(reopened, [{ ok: true, phase: 'pre', opensAt: Date.UTC(2026, 9, 1, 9), closesAt: Date.UTC(2026, 9, 6, 10) }])
    assert.equal(t.worker.status(pre.preworkId).state, 'open')
    assert.equal(t.service.status(SLUG, RUN, 'pre').closedAt, undefined, 'the row no longer says closed')
    assert.equal((await t.service.pull(SLUG, RUN, 'pre')).ok, true)
    assert.equal(t.run().prework.closedAt, undefined, 'and once pulled, neither does the Run')

    // An admin's close stays closed whatever time is pushed; the push says so.
    t.worker.adminClose(post.preworkId)
    persistRunForTalk(t.vault, SLUG, RUN, { ...t.run(), work: { ...t.run().work, post: { ...WORK.post, closes: '2026-10-27T17:00' } } })
    const kept = await t.service.syncWindows(SLUG, RUN)
    assert.equal(kept.length, 1)
    assert.equal(kept[0].ok && kept[0].closedAt, clock.now, 'still closed early, as the Worker says')
    assert.equal(t.worker.status(post.preworkId).state, 'closed')
    assert.equal(t.service.status(SLUG, RUN, 'post').closedAt, clock.now)
    // Republishing a closed phase says it stays closed.
    const again = await t.service.publish(SLUG, RUN, FORM, workWindowMs(t.run().work.post), 'post', t.vault)
    assert.equal(again.warning, 'Post-work was closed; it stays closed.')
    // A window that cannot be pushed is refused before anything is sent.
    const bad = await t.service.pushWindow(SLUG, RUN, 'pre', { opensAt: 10, closesAt: 5 })
    assert.equal(bad.ok, false)
    pass('a later closing time re-pushes the window without the form and reopens the phase (closed by date, or early by the owner); an admin\'s close stays and is reported')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
}

// 7. Withdraw and serve again ─────────────────────────────────────────────────────────────────
{
  clock.now = Date.UTC(2026, 9, 2, 12)
  const t = setUp()
  try {
    const { pre } = await publishBoth(t)
    t.worker.submit(pre.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'before unpublish' })
    assert.deepEqual(await t.service.withdraw(SLUG, RUN, 'pre'), { ok: true, withdrawn: true })
    assert.equal(t.service.status(SLUG, RUN, 'pre').withdrawnAt, clock.now)
    assert.throws(() => t.worker.submit(pre.preworkId, P2, { stepId: 's1', kind: 'read' }), { code: 'not_available' })
    const pulled = await t.service.pull(SLUG, RUN, 'pre')
    assert.equal(pulled.ok && pulled.added, 1, 'the answers can still be pulled')
    assert.deepEqual(await t.service.withdraw(SLUG, RUN, 'pre', false), { ok: true, withdrawn: false })
    assert.equal(t.service.status(SLUG, RUN, 'pre').withdrawnAt, undefined)
    assert.equal(t.worker.submit(pre.preworkId, P2, { stepId: 's1', kind: 'read' }).changed, true, 'served again')
    assert.deepEqual(await t.service.withdraw('other-talk', RUN, 'post'), { ok: true, withdrawn: true }, 'work never sent is already not available')
    t.worker.offline = true
    const offline = await t.service.withdraw(SLUG, RUN, 'post')
    t.worker.offline = false
    assert.equal(offline.ok, false)
    assert.equal(offline.error.includes('Bearer'), false, 'a failure to send is a fixed sentence, never the transport\'s text')
    pass('withdraw: participants are refused, the answers can still be pulled, and serving again takes answers; never-sent work is already not available')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
}

// 7b. Ticket 17 round 3 (Sol's probe): the registry row survives but its owner key is not in this computer's
//     secure storage, which reads fine. The phase counts as sent, and a withdraw is NEVER reported as done.
{
  clock.now = Date.UTC(2026, 9, 2, 12)
  const t = setUp()
  try {
    await publishBoth(t)
    assert.equal(t.service.ownerRecord(SLUG, RUN, 'pre'), 'usable')
    const restored = t.make(memoryOwnerTokens()) // readable, holding no key
    const calls = t.worker.calls.length
    const registryBytes = readFileSync(t.registryPath, 'utf8')
    assert.deepEqual(restored.phasesSent(SLUG, RUN), ['pre', 'post'], 'sent: the registry says so')
    assert.deepEqual([restored.ownerRecord(SLUG, RUN, 'pre'), restored.ownerRecord(SLUG, RUN, 'post')], ['none', 'none'])
    const probe = { sent: restored.phasesSent(SLUG, RUN).slice(0, 1), result: await restored.withdraw(SLUG, RUN, 'pre'), requests: t.worker.calls.length - calls }
    assert.deepEqual(probe, { sent: ['pre'], result: { ok: false, error: workKeyMissing('pre') }, requests: 0 }, 'refused, nothing asked of the Worker')
    assert.deepEqual(await restored.withdraw(SLUG, RUN, 'post'), { ok: false, error: workKeyMissing('post') })
    assert.equal(readFileSync(t.registryPath, 'utf8'), registryBytes, 'the registry is untouched')
    assert.equal(t.service.status(SLUG, RUN, 'pre').withdrawnAt, undefined, 'and the phase is not marked withdrawn')
    assert.equal(restored.ownerRecord('other-talk', RUN, 'pre'), 'none', 'no row at all: none')
    assert.deepEqual(await restored.withdraw('other-talk', RUN, 'pre'), { ok: true, withdrawn: true }, 'work never sent from anywhere is still already not available')
    pass('ticket 17: a row whose owner key is not on this computer is never withdrawn "successfully": refused, nothing asked or written')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
}

// 8. The IPC takes a phase; no token reaches a window, the registry file or a log ────────────
{
  clock.now = Date.UTC(2026, 9, 7, 12)
  const t = setUp()
  try {
    const { post } = await publishBoth(t)
    t.worker.submit(post.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'over IPC' })
    const handlers = new Map()
    registerRunPreworkIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, t.service)
    const status = await handlers.get('history:prework-status')(null, { talkSlug: SLUG, runId: RUN, phase: 'post' })
    assert.equal(status.phase, 'post')
    assert.equal(await handlers.get('history:prework-status')(null, { talkSlug: SLUG, runId: RUN, phase: 'during' }), null, 'a phase that is neither is refused')
    assert.equal((await handlers.get('history:prework-refresh')(null, { talkSlug: SLUG, runId: RUN, phase: 'during' })).ok, false)
    const refreshed = await handlers.get('history:prework-refresh')(null, { talkSlug: SLUG, runId: RUN, phase: 'post' })
    assert.equal(refreshed.ok && refreshed.run.postwork.entries[0].text, 'over IPC')
    assert.equal((await handlers.get('history:prework-refresh')(null, { talkSlug: '../escape', runId: RUN, phase: 'post' })).ok, false, 'an unsafe Run name is refused')
    t.worker.offline = true
    const offline = await handlers.get('history:prework-refresh')(null, { talkSlug: SLUG, runId: RUN, phase: 'post' })
    t.worker.offline = false
    await t.service.pullDue()
    const windows = JSON.stringify([status, refreshed, offline, t.service.status(SLUG, RUN), t.service.status(SLUG, RUN, 'post'), await t.service.syncWindows(SLUG, RUN)])
    const registryText = readFileSync(t.registryPath, 'utf8')
    for (const token of allTokens(t)) {
      assert.equal(windows.includes(token), false, 'no state a window gets carries an owner token')
      assert.equal(registryText.includes(token), false, 'the registry file holds no owner token')
      assert.equal(logged.some((line) => line.includes(token)), false, 'no log line carries one')
    }
    assert.deepEqual(parseRunPreworkKey(runPreworkKey('talk #1', 'run-1', 'post')), { talkSlug: 'talk #1', runId: 'run-1', phase: 'post' }, 'a talk slug may hold #; the key still reads back')
    assert.equal(parseRunPreworkKey('no-slash'), null)
    assert.deepEqual(parseRunPreworkKey(runPreworkKey('talk @1|x', 'run-1', 'post', 'root:/a b/@#|vault')), { talkSlug: 'talk @1|x', runId: 'run-1', phase: 'post', vault: 'root:/a b/@#|vault' }, 'a key naming the vault reads back, whatever the root holds')
    pass('the IPC handlers take a phase (none is pre-work, anything else is refused); no owner token reaches a window, the registry file or a log')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
}

// 9. Post-work picks and marks; a Run reference is checked first; a pull that is not JSON ────
{
  clock.now = Date.UTC(2026, 9, 7, 12)
  const t = setUp()
  try {
    clock.now = Date.UTC(2026, 9, 2, 12)
    const { pre, post } = await publishBoth(t)
    t.worker.submit(pre.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'Before' })
    clock.now = Date.UTC(2026, 9, 7, 12)
    t.worker.submit(post.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'After one' })
    t.worker.submit(post.preworkId, P2, { stepId: 'q1', kind: 'answer', text: 'After two' })
    t.worker.submit(post.preworkId, P2, { stepId: 'q1', kind: 'question', text: 'A question after?', submissionId: 'qa' })
    assert.equal((await t.service.pull(SLUG, RUN, 'pre')).ok, true)
    assert.equal((await t.service.pull(SLUG, RUN, 'post')).ok, true)
    const after = t.run().postwork.entries.filter((entry) => entry.kind === 'answer')
    const preBefore = JSON.stringify(t.run().prework)
    // Picking acts on post-work when asked, and on pre-work by default.
    assert.equal(t.service.changePick(SLUG, RUN, 'q1', { type: 'toggle', id: after[1].id }, 'post').ok, true)
    assert.deepEqual(t.run().postwork.picks, { q1: { mode: 'picked', ids: [after[1].id] } }, 'the pick is on the post-work section')
    assert.equal(JSON.stringify(t.run().prework), preBefore, 'pre-work is untouched by a post-work pick')
    const pickedPre = t.service.changePick(SLUG, RUN, 'q1', { type: 'toggle', id: after[0].id })
    assert.equal(pickedPre.ok, true)
    assert.deepEqual(t.run().postwork.picks.q1.ids, [after[1].id], 'a pre-work pick leaves the post-work pick as it was')
    assert.equal(t.service.changePick(SLUG, RUN, 'q1', { type: 'mode', mode: 'all' }, 'post').ok, true)
    assert.equal(t.run().postwork.picks.q1.mode, 'all')
    // Marking a question.
    const question = t.run().postwork.entries.find((entry) => entry.kind === 'question')
    assert.equal(t.service.markQuestion(SLUG, RUN, question.id, { answered: true }, 'post').ok, true)
    assert.equal(t.run().postwork.entries.find((entry) => entry.id === question.id).answered, true, 'the mark is on the post-work question')
    assert.equal(t.service.markQuestion(SLUG, RUN, question.id, { answered: true }).ok, false, 'the same id is not a question of pre-work')
    // Over IPC the phase rides in the payload.
    const handlers = new Map()
    registerRunPreworkIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, t.service)
    assert.equal(handlers.get('history:prework-question')(null, { talkSlug: SLUG, runId: RUN, phase: 'post', entryId: question.id, patch: { answered: false } }).ok, true)
    assert.equal(t.run().postwork.entries.find((entry) => entry.id === question.id).answered, undefined)
    assert.equal(handlers.get('history:prework-pick')(null, { talkSlug: SLUG, runId: RUN, phase: 'post', stepId: 'q1', change: { type: 'toggle', id: after[0].id } }).ok, true)
    assert.deepEqual(t.run().postwork.picks.q1.ids, [after[1].id, after[0].id])

    // A malformed Run id is refused before any registry row is read. `${RUN}#post` as a "pre-work" Run id
    // would otherwise name the post-work row and close it.
    const calls = t.worker.calls.length
    const registryBefore = JSON.stringify(t.registry())
    const evil = `${RUN}#post`
    for (const result of [await t.service.close(SLUG, evil, 'pre'), await t.service.pull(SLUG, evil, 'pre'), await t.service.withdraw(SLUG, evil, 'pre')]) {
      assert.equal(result.ok, false)
      assert.equal(result.error.includes('no longer in the vault'), false, 'refused as a bad reference, not reported as a Run that left the vault')
    }
    assert.equal((await t.service.pushWindow(SLUG, evil, 'pre', { opensAt: 1, closesAt: 2 })).ok, false)
    // The guard's own sentence, not "no longer in the vault": the sentence says the reference was refused
    // before the Run was read (a slug that fails isSafeTalkSlug alone: a leading dot, a separator, a control character).
    const BAD_REF = 'That is not a Run of this vault.'
    for (const slug of ['../escape', '.hidden', 'a/b', 'tab\tslug']) {
      assert.equal(t.service.changePick(slug, RUN, 'q1', { type: 'mode', mode: 'all' }, 'post').error, BAD_REF, `changePick refuses the slug ${JSON.stringify(slug)} as a bad reference`)
      assert.equal(t.service.markQuestion(slug, RUN, question.id, { answered: true }, 'post').error, BAD_REF, `markQuestion refuses the slug ${JSON.stringify(slug)} as a bad reference`)
      await assert.rejects(t.service.publish(slug, RUN, FORM, workWindowMs(t.run().work.pre), 'pre'), { message: BAD_REF }, `publish refuses the slug ${JSON.stringify(slug)}`)
    }
    assert.equal(t.service.changePick(SLUG, evil, 'q1', { type: 'mode', mode: 'all' }, 'post').error, BAD_REF)
    assert.equal(t.service.markQuestion(SLUG, evil, question.id, { answered: true }, 'post').error, BAD_REF)
    await assert.rejects(t.service.publish(SLUG, evil, FORM, workWindowMs(t.run().work.pre), 'pre'), { message: BAD_REF }, 'publish refuses a malformed Run id')
    // Over IPC a phase that is present but not pre or post is refused; an absent one still means pre-work.
    assert.equal(handlers.get('history:prework-pick')(null, { talkSlug: SLUG, runId: RUN, phase: 'during', stepId: 'q1', change: { type: 'mode', mode: 'all' } }).error, 'That is neither pre-work nor post-work.')
    assert.equal(handlers.get('history:prework-pick')(null, { talkSlug: SLUG, runId: RUN, phase: 7, stepId: 'q1', change: { type: 'mode', mode: 'all' } }).ok, false)
    assert.equal(handlers.get('history:prework-question')(null, { talkSlug: SLUG, runId: RUN, phase: 'during', entryId: question.id, patch: { answered: true } }).error, 'That is neither pre-work nor post-work.')
    assert.equal(t.run().postwork.entries.find((entry) => entry.id === question.id).answered, undefined, 'a refused phase changed nothing (the mark "answered" would have been written)')
    assert.equal(handlers.get('history:prework-pick')(null, { talkSlug: SLUG, runId: RUN, stepId: 'q1', change: { type: 'mode', mode: 'all' } }).ok, true, 'no phase: pre-work')
    assert.equal(t.service.status(SLUG, evil, 'pre'), null)
    assert.equal(t.worker.calls.length, calls, 'nothing was sent to the service')
    assert.equal(JSON.stringify(t.registry()), registryBefore, 'no registry row was touched')

    // A 2xx that is not JSON.
    t.worker.garbage = true
    const garbled = await t.service.pull(SLUG, RUN, 'post')
    t.worker.garbage = false
    assert.equal(garbled.ok, false, 'a reply that is not JSON is an error result')
    assert.match(garbled.error, /unreadable/)
    assert.equal(t.registry()[t.key('post')].cursor, 3, 'the cursor stayed')
    pass('post-work picks and marks; a malformed Run id is refused before the registry is read; a pull answered 2xx with a body that is not JSON returns an error')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
}

// 10. Issue 256, finding 1: two open vaults hold the same talk and Run id (a copied vault) ──────────────────
// Each vault's publish makes and pushes its own object: the second never reuses, replaces or pushes a form to the
// first's, answers never mix, a withdraw from one leaves the other served, and a row from before keys named the
// vault is read only by the vault it records (and moved under that vault's key when it publishes again).
{
  clock.now = Date.UTC(2026, 9, 2, 12)
  const t = setUp()
  try {
    const A = t.vault
    const B = join(t.root, 'vault-b')
    mkdirSync(join(B, '_PRESENTATIONS', SLUG), { recursive: true })
    persistRunForTalk(B, SLUG, RUN, plannedRun(WORK))
    const ids = new Map([[A, 'va'], [B, 'vb']])
    // As main wires it: vault ids by root, every open vault writable; A is the current (first) vault.
    const service = createRunPrework({ registryPath: t.registryPath, ownerTokens: t.tokens, endpoint: async () => ({ baseUrl: ORIGIN, adminSecret: 'admin' }),
      vaultRoot: () => A, writableVault: (root) => (ids.has(root) ? root : null), vaultIdAt: (root) => ids.get(root) ?? null, fetch: t.worker.fetch, now: () => clock.now })
    const window = workWindowMs(WORK.pre)
    const formA = { ...FORM, title: 'Vault A form' }
    const formB = { ...FORM, title: 'Vault B form' }
    const inA = await service.publish(SLUG, RUN, formA, window, 'pre', A)
    const inB = await service.publish(SLUG, RUN, formB, window, 'pre', B)
    assert.equal(t.worker.made, 2, 'the second vault\'s publish makes its own object')
    assert.notEqual(inB.preworkId, inA.preworkId)
    assert.equal(t.worker.objects.get(inA.preworkId).prework.form.title, 'Vault A form', 'A\'s form is not replaced by B\'s')
    assert.equal(t.worker.objects.get(inB.preworkId).prework.form.title, 'Vault B form')
    assert.deepEqual(Object.keys(t.registry()).sort(), [runPreworkKey(SLUG, RUN, 'pre', vaultKeyPart({ id: 'va' })), runPreworkKey(SLUG, RUN, 'pre', vaultKeyPart({ id: 'vb' }))].sort(), 'one row per vault')
    assert.equal(service.status(SLUG, RUN, 'pre', A).preworkId, inA.preworkId)
    assert.equal(service.status(SLUG, RUN, 'pre', B).preworkId, inB.preworkId)
    assert.equal(service.status(SLUG, RUN).preworkId, inA.preworkId, 'no vault named: the current vault\'s')
    // Republishing each reuses its own object.
    await service.publish(SLUG, RUN, formB, window, 'pre', B)
    await service.publish(SLUG, RUN, formA, window, 'pre', A)
    assert.equal(t.worker.made, 2)
    assert.equal(t.worker.objects.get(inA.preworkId).prework.form.title, 'Vault A form')
    // Answers never mix: each vault's Run gets its own object's answers.
    t.worker.submit(inA.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'Answer for A' })
    t.worker.submit(inB.preworkId, P2, { stepId: 'q1', kind: 'answer', text: 'Answer for B' })
    assert.equal((await service.pull(SLUG, RUN, 'pre', A)).ok, true)
    assert.equal((await service.pull(SLUG, RUN, 'pre', B)).ok, true)
    assert.deepEqual(readRunForTalk(A, SLUG, RUN).prework.entries.map((entry) => entry.text), ['Answer for A'])
    assert.deepEqual(readRunForTalk(B, SLUG, RUN).prework.entries.map((entry) => entry.text), ['Answer for B'])
    // The timer pulls each into its own vault.
    t.worker.submit(inB.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'Later for B' })
    await service.pullDue()
    assert.deepEqual(readRunForTalk(A, SLUG, RUN).prework.entries.map((entry) => entry.text), ['Answer for A'], 'the timer writes nothing of B\'s into A')
    assert.deepEqual(readRunForTalk(B, SLUG, RUN).prework.entries.map((entry) => entry.text).sort(), ['Answer for B', 'Later for B'])
    // Unpublishing B (the job's withdraw, naming B) withdraws B's object only.
    assert.deepEqual(sentPhases(service, readRunForTalk(B, SLUG, RUN), B), ['pre'])
    assert.equal(service.ownerRecord(SLUG, RUN, 'pre', B), 'usable')
    assert.deepEqual(await withdrawRunWork(service, SLUG, RUN, ['pre'], B), { ok: true })
    assert.notEqual(t.worker.objects.get(inB.preworkId).prework.withdrawnAt ?? null, null, 'B\'s object is withdrawn')
    assert.equal(t.worker.objects.get(inA.preworkId).prework.withdrawnAt ?? null, null, 'A\'s object is still served')
    assert.equal(service.status(SLUG, RUN, 'pre', A).withdrawnAt, undefined)
    // Publishing B again serves B's object again (serveWorkAgain, naming B); A's is not asked.
    assert.deepEqual(await serveWorkAgain(service, SLUG, RUN, 'pre', {}, B), { ok: true })
    assert.equal(t.worker.objects.get(inB.preworkId).prework.withdrawnAt ?? null, null, 'B\'s object is served again')
    assert.equal(service.status(SLUG, RUN, 'pre', B).withdrawnAt, undefined)
    pass('issue 256: two vaults with the same talk and Run id each get their own object, form and answers; a withdraw in one leaves the other')

    // A row from before keys named the vault, recorded as A's: B never reads or reuses it; A does, and moves it.
    const rows = JSON.parse(readFileSync(t.registryPath, 'utf8'))
    const aKey = runPreworkKey(SLUG, RUN, 'pre', vaultKeyPart({ id: 'va' }))
    const old = rows.preworks[aKey]
    delete rows.preworks[aKey]
    delete rows.preworks[runPreworkKey(SLUG, RUN, 'pre', vaultKeyPart({ id: 'vb' }))]
    rows.preworks[`${SLUG}/${RUN}`] = { ...old, key: `${SLUG}/${RUN}` }
    writeFileSync(t.registryPath, `${JSON.stringify(rows, null, 2)}\n`)
    assert.equal(service.status(SLUG, RUN, 'pre', B), null, 'B does not see A\'s older row')
    assert.deepEqual(service.phasesSent(SLUG, RUN, B), [], 'nor count it as sent')
    assert.equal(service.status(SLUG, RUN, 'pre', A).preworkId, inA.preworkId, 'A still reads it')
    const madeBefore = t.worker.made
    const freshB = await service.publish(SLUG, RUN, formB, window, 'pre', B)
    assert.equal(t.worker.made, madeBefore + 1, 'B\'s publish makes its own object again')
    assert.equal(t.worker.objects.get(inA.preworkId).prework.form.title, 'Vault A form', 'and never pushes to A\'s')
    assert.equal(t.registry()[`${SLUG}/${RUN}`].preworkId, inA.preworkId, 'A\'s older row is left where it is')
    const againA = await service.publish(SLUG, RUN, formA, window, 'pre', A)
    assert.equal(againA.preworkId, inA.preworkId, 'A\'s publish reuses its object')
    assert.equal(t.registry()[`${SLUG}/${RUN}`], undefined, 'and moves the row under A\'s key')
    assert.equal(t.registry()[aKey].preworkId, inA.preworkId)
    assert.equal(service.status(SLUG, RUN, 'pre', B).preworkId, freshB.preworkId)
    // A row that records no vault at all (published before rows kept one) belongs to no vault, the current one included.
    const noVault = JSON.parse(readFileSync(t.registryPath, 'utf8'))
    const moved = noVault.preworks[aKey]
    delete noVault.preworks[aKey]
    delete moved.vaultRoot; delete moved.vaultId
    noVault.preworks[`${SLUG}/${RUN}`] = { ...moved, key: `${SLUG}/${RUN}` }
    writeFileSync(t.registryPath, `${JSON.stringify(noVault, null, 2)}\n`)
    assert.equal(service.status(SLUG, RUN, 'pre', A), null, 'not even the current vault reads a row with no vault')
    assert.equal(service.ownerUnknown(SLUG, RUN, 'pre', A), true, 'A is told its pre-work has an owner nothing records')
    assert.equal(service.status(SLUG, RUN, 'pre', B).preworkId, freshB.preworkId, 'another vault reads only its own')
    assert.equal(service.ownerUnknown(SLUG, RUN, 'pre', B), false, 'B has an object of its own')
    pass('issue 256: a registry row from before keys named the vault is read only by the vault it records, and moved under that vault\'s key by its next publish')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
}

// 11. Issue 256 review round 2: a row from before 0.41 that records no vault is never given to the current vault.
// A published it; A is closed, so B (same talk and Run id) is the first vault. B's Unpublish sends no withdraw for
// A's object, B's publish never reuses it, and the timer pulls nothing from it into B.
{
  clock.now = Date.UTC(2026, 9, 2, 12)
  const t = setUp()
  try {
    const A = t.vault
    const B = join(t.root, 'vault-b')
    mkdirSync(join(B, '_PRESENTATIONS', SLUG), { recursive: true })
    const stamped = { ...plannedRun(WORK), work: { ...plannedRun(WORK).work, pre: { ...plannedRun(WORK).work.pre, publishedAt: '2026-10-01T09:00:00.000Z' } } }
    persistRunForTalk(B, SLUG, RUN, stamped) // a copied vault: its Run says the pre-work went out
    const ids = new Map([[A, 'va'], [B, 'vb']])
    const open = new Set([A, B])
    let current = A
    const service = createRunPrework({ registryPath: t.registryPath, ownerTokens: t.tokens, endpoint: async () => ({ baseUrl: ORIGIN, adminSecret: 'admin' }),
      vaultRoot: () => current, writableVault: (root) => (open.has(root) ? root : null), vaultIdAt: (root) => (open.has(root) ? ids.get(root) ?? null : null),
      fetch: t.worker.fetch, now: () => clock.now })
    const window = workWindowMs(WORK.pre)
    // A's object, as 0.40 left it: under `<talk>/<run>`, recording no vault.
    const inA = await service.publish(SLUG, RUN, { ...FORM, title: 'Vault A form' }, window, 'pre', A)
    const rows = JSON.parse(readFileSync(t.registryPath, 'utf8'))
    const aKey = runPreworkKey(SLUG, RUN, 'pre', vaultKeyPart({ id: 'va' }))
    const legacy = { ...rows.preworks[aKey], key: `${SLUG}/${RUN}` }
    delete legacy.vaultRoot; delete legacy.vaultId
    delete rows.preworks[aKey]
    rows.preworks[legacy.key] = legacy
    writeFileSync(t.registryPath, `${JSON.stringify(rows, null, 2)}\n`)
    t.worker.submit(inA.preworkId, P1, { stepId: 'q1', kind: 'answer', text: 'A participant\'s answer' })
    // A is closed: B is the first vault now.
    open.delete(A); current = B
    assert.equal(service.status(SLUG, RUN, 'pre', B), null, 'B does not read A\'s object')
    assert.equal(service.status(SLUG, RUN, 'pre'), null, 'nor does the current vault, named or not')
    assert.equal(service.ownerUnknown(SLUG, RUN, 'pre', B), true)
    // Unpublish from B: no withdraw is sent for A's object, and the refusal says why.
    const callsBefore = t.worker.calls.length
    const unpublished = await withdrawRunWork(service, SLUG, RUN, sentPhases(service, readRunForTalk(B, SLUG, RUN), B), B)
    assert.equal(unpublished.ok, false)
    assert.equal(unpublished.error, workOwnerUnknown('pre', true))
    const direct = await service.withdraw(SLUG, RUN, 'pre', true, B)
    assert.deepEqual(direct, { ok: true, withdrawn: true }, 'the service has nothing of B\'s to withdraw')
    assert.deepEqual(t.worker.calls.slice(callsBefore).filter((call) => call.includes(inA.preworkId)), [], 'no request reaches A\'s object')
    assert.equal(t.worker.objects.get(inA.preworkId).prework.withdrawnAt ?? null, null, 'A\'s object is still served')
    assert.equal(t.registry()[legacy.key].withdrawAskedAt, undefined, 'and its row is not marked')
    // The timer pulls nothing from it into B.
    await service.pullDue()
    assert.equal(readRunForTalk(B, SLUG, RUN).prework, undefined, 'the timer writes none of A\'s answers into B')
    // Round 3: nor does the timer count it: no request reaches A's object and its row is not written.
    t.worker.waiting = 3
    const countBefore = t.worker.calls.length
    assert.equal(service.due().length, 0, 'a row with no vault is not due for any vault')
    assert.equal(await service.countDue(), 0)
    assert.deepEqual(t.worker.calls.slice(countBefore), [], 'the timer sends no request for A\'s object')
    assert.deepEqual(t.registry()[legacy.key], legacy, 'and does not write its row')
    // Round 3: the work attachment removed, so nothing on the Run says the pre-work went out. Unpublish still
    // refuses: the registry holds an object of this Run's that no vault owns, and it is left live.
    persistRunForTalk(B, SLUG, RUN, plannedRun({ post: WORK.post }))
    const unstamped = sentPhases(service, readRunForTalk(B, SLUG, RUN), B)
    assert.deepEqual(unstamped, [], 'the sent set is empty')
    const removed = await withdrawRunWork(service, SLUG, RUN, unstamped, B)
    assert.deepEqual(removed, { ok: false, error: workOwnerUnknown('pre', true) }, 'and Unpublish is refused, said as such')
    assert.deepEqual(t.worker.calls.slice(countBefore), [], 'still no request reaches A\'s object')
    persistRunForTalk(B, SLUG, RUN, stamped)
    // Publishing B makes B an object of its own; A's object and row are left as they are.
    const made = t.worker.made
    const inB = await service.publish(SLUG, RUN, { ...FORM, title: 'Vault B form' }, window, 'pre', B)
    assert.equal(t.worker.made, made + 1, 'B\'s publish makes its own object')
    assert.notEqual(inB.preworkId, inA.preworkId, 'never A\'s')
    assert.equal(t.worker.objects.get(inA.preworkId).prework.form.title, 'Vault A form', 'A\'s form is not replaced')
    assert.deepEqual(t.registry()[legacy.key], legacy, 'A\'s row is left as it was')
    assert.equal(t.registry()[legacy.key].vaultRoot, undefined, 'and is not stamped with B')
    assert.equal(service.ownerUnknown(SLUG, RUN, 'pre', B), false)
    await service.pullDue()
    assert.deepEqual(readRunForTalk(B, SLUG, RUN).prework?.entries ?? [], [], 'the timer still pulls none of A\'s answers into B')
    pass('issue 256 round 2: a row from before 0.41 with no vault is never withdrawn, reused or pulled by the vault that happens to be first')
  } finally { rmSync(t.root, { recursive: true, force: true }) }
}

// Work-files ticket 16: the window pushed for post-work that opens when the session ends.
{
  const { workPushWindowMs, notYetOpenedWindow, isNotYetOpenedWindow } = await import('../src/main/run-prework.ts')
  const post = { opens: 'session-end', closes: '2099-10-20T17:00', timeZone: 'Europe/London' }
  const closesAt = Date.UTC(2099, 9, 20, 16)
  assert.deepEqual(workPushWindowMs(post), notYetOpenedWindow(closesAt), 'not yet opened: it opens a millisecond before it closes')
  assert.ok(isNotYetOpenedWindow(workPushWindowMs(post)))
  assert.deepEqual(workPushWindowMs(post, notYetOpenedWindow(closesAt)), notYetOpenedWindow(closesAt), 'republished before the session ends: still not open')
  const opened = { opensAt: Date.UTC(2099, 9, 6, 11), closesAt }
  assert.deepEqual(workPushWindowMs(post, opened), opened, 'once the session ended, its opening is kept')
  assert.deepEqual(workPushWindowMs({ opens: '2099-10-01T09:00', closes: '2099-10-06T09:00', timeZone: 'Europe/London' }), { opensAt: Date.UTC(2099, 9, 1, 8), closesAt: Date.UTC(2099, 9, 6, 8) })
  assert.equal(workPushWindowMs({ opens: '2099-10-07T09:00', closes: '2099-10-06T09:00', timeZone: 'Europe/London' }), null, 'closes before it opens')
  assert.equal(workPushWindowMs({ ...post, problem: 'zone-mismatch' }), null)
  pass('ticket 16: the post-work window before and after the session ends')
}

console.log(`\n${results.length} groups passed`)
