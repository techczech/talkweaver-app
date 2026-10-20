// Work-files ticket 17 against a real live Worker (`wrangler dev`: local, throwaway secrets and state,
// nothing deployed): unpublishing a Run withdraws each phase on the Worker, and Publish again serves it
// again. The REAL pieces: the run work service (src/main/run-prework.ts) with its registry and an
// in-memory secrets store, the Run's publish of its work (run-work-publish.ts:
// the push and serveWorkAgain, as sendRunWork does them), the Run unpublish job (run-unpublish.ts) in the REAL publishing sequence
// (handout-publishing.ts, in the app's own test mode: pages built and checked, nothing uploaded), a temp
// vault with the real atomic Run writer.
//   - published: both phases take answers on their public routes;
//   - Unpublish: both public status routes and a submission answer 404 not_available (never cached); every
//     page of the Run's site folder is "This page is not available"; the answers can still be pulled onto
//     the Run, and the Run keeps its link with both phases stamped unpublished;
//   - Publish again (the push and serveWorkAgain after the unpublish): both phases are served again and take answers again,
//     with the same objects;
//   - a withdraw the Worker applies whose answer is lost on the way back (ticket 17 fix round): Unpublish fails
//     and stamps nothing, and Publish again still serves the phase again.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-run-unpublish-live.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLiveWorker } from './lib/live-worker-harness.mjs'
import { COMPILER_DIR } from './lib/work-page-fixture.mjs'
import { createRunPrework, workWindowMs } from '../src/main/run-prework.ts'
import { serveWorkAgain } from '../src/main/run-work-publish.ts'
import { runUnpublishJob } from '../src/main/run-unpublish.ts'
import { createHandoutPublishing } from '../src/main/handout-publishing.ts'
import { buildNotAvailablePage } from '../src/main/work-page.ts'
import { normaliseRun, persistRunForTalk, readRunForTalk, setRunHandoutUrl, stampRunWork } from '../src/main/runs.ts'
import { memoryOwnerTokens } from './lib/memory-secrets.mjs'

const results = []
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`) }
const SLUG = 'unpublish-live'
const RUN = 'run-unpublish-live'
/** A wall-clock minute in UTC, `YYYY-MM-DDTHH:MM`, `minutes` from now (rounded down). */
const FORM = {
  title: 'Work', intro: '',
  steps: [
    { id: 's1', n: 1, title: 'Read this', kind: 'slide', questions: true },
    { id: 'q1', n: 2, title: 'Hopes', kind: 'question', questions: true, poll: { type: 'open', question: 'Hopes', options: [] } },
  ],
}
const minute = (minutes) => new Date(Math.floor(Date.now() / 60_000) * 60_000 + minutes * 60_000).toISOString().slice(0, 16)

const worker = await startLiveWorker()
const root = mkdtempSync(join(tmpdir(), 'tw-unpublish-live-'))
try {
  const vault = join(root, 'vault')
  mkdirSync(join(vault, '_PRESENTATIONS', SLUG), { recursive: true })
  const work = {
    pre: { fileId: 'intake', opens: minute(-60), closes: minute(120), timeZone: 'UTC' },
    post: { fileId: 'feedback', opens: minute(-30), closes: minute(240), timeZone: 'UTC' },
  }
  persistRunForTalk(vault, SLUG, RUN, normaliseRun({
    id: RUN, talkSlug: SLUG, talkTitle: 'Unpublish live', eventTitle: 'Live check', kind: 'delivery', status: 'planned', plannedDate: minute(0).slice(0, 10), startTime: '10:00', timeZone: 'UTC',
    slideSet: { kind: 'full' }, startedAt: new Date().toISOString(), endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null,
    audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], work,
  }))
  // `loseWithdrawAnswers`: a withdraw request reaches the Worker, and its answer is lost on the way back.
  const net = { loseWithdrawAnswers: false }
  const lossyFetch = async (url, init) => {
    const response = await fetch(url, init)
    if (net.loseWithdrawAnswers && String(url).endsWith('/withdraw')) throw new TypeError('the answer was lost')
    return response
  }
  const service = createRunPrework({ registryPath: join(root, 'run-prework-registry.json'), ownerTokens: memoryOwnerTokens(),
    endpoint: async () => ({ baseUrl: worker.baseUrl, adminSecret: worker.adminSecret }), vaultRoot: () => vault, fetch: lossyFetch })
  const run = () => readRunForTalk(vault, SLUG, RUN)
  const status = (id) => fetch(`${worker.baseUrl}/prework/${id}`)
  const submit = (id, body) => fetch(`${worker.baseUrl}/prework/${id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: `device-${randomBytes(8).toString('hex')}`, submissionId: `sub-${randomBytes(6).toString('hex')}`, ...body }) })
  const notAvailable = async (response, label) => {
    assert.equal(response.status, 404, label)
    assert.equal(response.headers.get('cache-control'), 'no-store', `${label}: never cached, so publishing again is seen at once`)
    assert.equal((await response.json()).error.code, 'not_available', label)
  }
  // What a publish of the Run does to the Worker and the Run, as sendRunWork does it for each phase (push, then
  // serve again what Unpublish withdrew) and as the handler's `record` stamps it. (sendRunWork itself refuses a
  // Worker on this computer, which `wrangler dev` is: its pin and compile are test:prework-publish's.)
  const publishWork = async () => {
    const ids = {}
    for (const phase of ['pre', 'post']) {
      const published = await service.publish(SLUG, RUN, FORM, workWindowMs(run().work[phase]), phase)
      assert.equal(published.open, true)
      const served = await serveWorkAgain(service, SLUG, RUN, phase, run().work[phase])
      assert.equal(served.ok, true, served.error)
      ids[phase] = published.preworkId
    }
    persistRunForTalk(vault, SLUG, RUN, stampRunWork(setRunHandoutUrl(run(), 'https://talks.test/live-check/', 'live-check'), ['pre', 'post'], 'publishedAt', new Date().toISOString()))
    return ids
  }

  // ── Published: both phases take answers ─────────────────────────────────────────────────────
  const ids = await publishWork()
  assert.ok(ids.pre && ids.post && ids.pre !== ids.post)
  for (const phase of ['pre', 'post']) assert.equal((await status(ids[phase])).status, 200, `${phase}: served`)
  assert.equal((await submit(ids.pre, { stepId: 'q1', kind: 'answer', text: 'Before: which data is safe' })).status, 201)
  assert.equal((await submit(ids.post, { stepId: 'q1', kind: 'answer', text: 'After: the checklist' })).status, 201)
  pass('published: both phases are served and take answers')

  // ── Unpublish, through the real job in the real sequence ────────────────────────────────────
  const siteDir = join(root, 'site')
  for (const page of ['index.html', 'live-check.html', 'pre-work/index.html', 'post-work/index.html']) {
    mkdirSync(join(siteDir, 'live-check', page.includes('/') ? page.split('/')[0] : ''), { recursive: true })
    writeFileSync(join(siteDir, 'live-check', page), `<!doctype html><title>${page}</title>`)
  }
  mkdirSync(join(siteDir, 'other-talk'), { recursive: true })
  writeFileSync(join(siteDir, 'other-talk', 'index.html'), 'another handout')
  const publishing = createHandoutPublishing({
    siteDir: () => siteDir, authorise: async () => assert.fail('the test mode asks no leave'), live: async () => assert.fail('an unpublish asks no live service'),
    toolMissing: () => null, bundlingHazard: () => null, upload: async () => assert.fail('the test mode uploads nothing'), rehearsal: () => ({ project: 'talks' }),
  })
  const NA = await buildNotAvailablePage(COMPILER_DIR)
  const unpublish = () => publishing.publish({ entry: 'run-unpublish', ...runUnpublishJob({
    run, siteExists: () => true, readRegistry: () => ({}), writeRegistry: () => {}, notAvailablePage: async () => NA, service,
    persist: (next) => { persistRunForTalk(vault, SLUG, RUN, next) },
  }) })
  const unpublished = await unpublish()
  assert.equal(unpublished.ok, true, unpublished.error)
  assert.deepEqual([unpublished.built.way, unpublished.built.phases], ['replaced', ['pre', 'post']])
  for (const phase of ['pre', 'post']) {
    await notAvailable(await status(ids[phase]), `${phase}: the status`)
    await notAvailable(await submit(ids[phase], { stepId: 'q1', kind: 'answer', text: 'too late' }), `${phase}: a submission`)
    assert.ok(service.status(SLUG, RUN, phase).withdrawnAt > 0, `${phase}: the registry knows it is withdrawn`)
  }
  for (const page of ['index.html', 'live-check.html', 'pre-work/index.html', 'post-work/index.html']) assert.equal(readFileSync(join(siteDir, 'live-check', page), 'utf8'), NA, `${page}: not available`)
  assert.equal(readFileSync(join(siteDir, 'other-talk', 'index.html'), 'utf8'), 'another handout', 'another handout is untouched')
  assert.deepEqual(readdirSync(siteDir).sort(), ['live-check', 'other-talk'])
  assert.equal((await service.pull(SLUG, RUN, 'pre')).ok, true, 'the answers can still be pulled')
  assert.equal((await service.pull(SLUG, RUN, 'post')).ok, true)
  assert.deepEqual([run().prework.entries.map((entry) => entry.text), run().postwork.entries.map((entry) => entry.text)], [['Before: which data is safe'], ['After: the checklist']], 'the answers stay on the Run')
  assert.equal(run().handoutUrl, 'https://talks.test/live-check/', 'the Run keeps its link')
  assert.ok(['pre', 'post'].every((phase) => Date.parse(run().work[phase].unpublishedAt) >= Date.parse(run().work[phase].publishedAt)), 'both phases stamped unpublished')
  pass('unpublish: both phases "not available" on the Worker (no-store), every page of the Run "not available", answers kept and still pulled')

  // ── Publish again: the same objects, served again ───────────────────────────────────────────
  const again = await publishWork()
  assert.deepEqual(again, ids, 'the same objects')
  for (const phase of ['pre', 'post']) {
    const back = await status(again[phase])
    assert.equal(back.status, 200, `${phase}: served again`)
    assert.equal(service.status(SLUG, RUN, phase).withdrawnAt, undefined)
  }
  assert.equal((await submit(ids.pre, { stepId: 'q1', kind: 'answer', text: 'Before: back again' })).status, 201, 'and it takes answers again')
  pass('Publish again: both phases served again, with the same objects, and taking answers')

  // ── A withdraw applied on the Worker whose answer is lost ───────────────────────────────────
  const stampsBefore = JSON.stringify(run().work)
  net.loseWithdrawAnswers = true
  const lost = await unpublish()
  net.loseWithdrawAnswers = false
  assert.deepEqual([lost.ok, lost.error], [false, 'The pre-work service could not be reached, so nothing was changed. Try again.'])
  await notAvailable(await status(ids.pre), 'pre: withdrawn on the Worker all the same')
  assert.equal((await status(ids.post)).status, 200, 'post: the unpublish stopped before it')
  assert.deepEqual([service.status(SLUG, RUN, 'pre').withdrawnAt, typeof service.status(SLUG, RUN, 'pre').withdrawAskedAt], [undefined, 'number'], 'not known here as withdrawn, but noted as asked')
  assert.equal(JSON.stringify(run().work), stampsBefore, 'the Run is not stamped: it still says published')
  const recovered = await publishWork()
  assert.deepEqual(recovered, ids)
  assert.equal((await status(ids.pre)).status, 200, 'Publish again serves pre-work again')
  assert.equal(service.status(SLUG, RUN, 'pre').withdrawAskedAt, undefined)
  pass('a withdraw whose answer was lost: Unpublish stamps nothing, and Publish again serves the phase again')

  console.log(`\nrun unpublish live: ${results.length} groups passed`)
} finally {
  await worker.stop()
  rmSync(root, { recursive: true, force: true })
}
