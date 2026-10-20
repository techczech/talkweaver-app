// A planned Run lives in the vault of its talk (multi-vault architecture: "runs … take a root; pass the talk's
// vault root"). Two vaults as the probe had them: A is the first (current) vault and holds nothing; B holds the
// talk and its `Work files/`.
//   1. Plan a run naming vault B writes the Run into B, never A; changing it and "Plan the next run like this"
//      stay in B; with no vault named the current vault is used, as before;
//   2. a write naming a closed vault, a vault whose folder is gone, an unknown vault or a vault that does not
//      hold the talk is refused, and nothing is written anywhere;
//   3. the Run page (run-page.ts) reads the Run, its work files and its talk from B, and its answers are
//      writable there; Publish for this run resolves B (runVaultRoot) and plans its work from B's Work files;
//   4. pulls, stars and marks (run-prework.ts IPC) go to the Run's own vault, are refused for a vault that is not
//      open (or a vault id that is null, empty or not text), and with no vault named stay with the current vault;
//   5. a pull whose answers are on their way when the Run's vault closes writes nothing in any vault, and the same
//      answers are pulled once the vault is back.
//   6. the vault replaced at the same folder (another vault id at the same root) while a reply is held: the
//      timer's pull and a pull naming no vault write nothing and leave the cursor; restored, the answers are pulled.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-runs-in-talk-vault.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlannedRunIn, deletePlannedRunIn, NAME_THE_VAULT, plannedRunVault, readRoot, updatePlannedRunIn, TALK_NOT_IN_VAULT } from '../src/main/planned-runs-ipc.ts'
import { registerRunPageIpc, runVaultRoot, RUN_VAULT_NOT_OPEN } from '../src/main/run-page.ts'
import { createRunPrework, registerRunPreworkIpc, RUN_VAULT_GONE, runPreworkKey, vaultKeyPart, workWindowMs } from '../src/main/run-prework.ts'
import { planRunWork } from '../src/main/run-work-publish.ts'
import { normaliseRun, persistRunForTalk, readRunForTalk } from '../src/main/runs.ts'
import { writableRoot } from '../src/main/vault-availability.ts'
import { memoryOwnerTokens } from './lib/memory-secrets.mjs'
const NO_PREWORK_YET = 'This Run has no pre-work on the handout yet.'

const TZ = 'Europe/London'
const SLUG = 'ai-research'
const FILE = 'research-teams-intake'
const WORK_TEXT = ['---', `id: ${FILE}`, 'title: Research teams intake', 'revision: 1', '---', '', '### Watch', '{id=watch}{video}', ''].join('\n')

const base = mkdtempSync(join(tmpdir(), 'tw-runs-in-talk-vault-'))
const A = join(base, 'vault-a')
const B = join(base, 'vault-b')
const C = join(base, 'vault-c') // open, holds no talk
mkdirSync(A); mkdirSync(C)
mkdirSync(join(B, 'Talks', SLUG), { recursive: true })
writeFileSync(join(B, 'Talks', SLUG, `${SLUG}-outline.md`), '# AI for research teams\n\n## One\n\nHello.\n')
mkdirSync(join(B, 'Work files'))
writeFileSync(join(B, 'Work files', `${FILE}.md`), WORK_TEXT)

// The registry as index.ts sees it: open vaults; `closed` ones are not in availableVaults().
const registry = [{ id: 'va', root: A }, { id: 'vb', root: B }, { id: 'vc', root: C }, { id: 'vclosed', root: join(base, 'closed') }]
const closed = new Set(['vclosed'])
const fsLike = { isDirectory: (path) => { try { return statSync(path).isDirectory() } catch { return false } } }
const available = () => registry.filter((vault) => !closed.has(vault.id) && fsLike.isDirectory(vault.root))
const writableVaultRoot = () => writableRoot(available()[0]?.root, fsLike) ?? undefined
// index.ts runVaultFor, over the real runVaultRoot and writableRoot.
const runVaultFor = (vaultId) => runVaultRoot(available(), vaultId, writableVaultRoot, (root) => writableRoot(root, fsLike) ?? undefined)
const hasTalk = (root, slug) => existsSync(join(root, 'Talks', slug, `${slug}-outline.md`))

let next = 0
const updated = []
const deps = {
  vaultRoot: () => writableVaultRoot() ?? null,
  runVault: runVaultFor,
  hasTalk,
  onPlannedRunUpdated: (talkSlug, runId, root) => updated.push([talkSlug, runId, root]),
  mintId: () => `run-test-${++next}`,
}
const plan = (extra = {}) => ({
  talkSlug: SLUG, talkTitle: 'AI for research teams', plannedDate: '2026-11-20', eventTitle: 'Saïd workshop', audience: 'Researchers',
  slideSet: { kind: 'full' }, startTime: '14:00', timeZone: TZ,
  work: { pre: { fileId: FILE, opens: '2026-11-13T09:00', closes: '2026-11-20T13:00', timeZone: TZ } }, ...extra,
})
const runsIn = (root) => {
  const folder = join(root, '_PRESENTATIONS', SLUG)
  return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.json')).sort() : []
}
const nothingIn = (root) => !existsSync(join(root, '_PRESENTATIONS'))

// ---- 1. create, change and copy land in the talk's vault
{
  const made = createPlannedRunIn(deps, plan({ vaultId: 'vb' }))
  assert.equal(made.ok, true, made.error)
  assert.deepEqual(runsIn(B), ['run-test-1.json'], 'the Run is written into vault B, the talk\'s vault')
  assert.ok(nothingIn(A), 'and nothing into vault A, the current vault')
  assert.equal(made.run.vaultId, undefined, 'the vault id is not kept on the Run record')
  assert.equal(readRunForTalk(B, SLUG, 'run-test-1').eventTitle, 'Saïd workshop')

  const changed = updatePlannedRunIn(deps, { talkSlug: SLUG, runId: 'run-test-1', patch: { eventTitle: 'Saïd workshop (moved)' }, vaultId: 'vb' })
  assert.equal(changed.ok, true, changed.error)
  assert.equal(readRunForTalk(B, SLUG, 'run-test-1').eventTitle, 'Saïd workshop (moved)', 'the change is written in B')
  assert.deepEqual(updated, [[SLUG, 'run-test-1', B]], 'the work-time sync and post-work opening are told the Run\'s own vault')
  assert.ok(nothingIn(A))

  // "Plan the next run like this" sends a new plan prefilled from the Run, with the talk's vault.
  const copy = createPlannedRunIn(deps, plan({ plannedDate: '2026-12-04', vaultId: 'vb' }))
  assert.equal(copy.ok, true, copy.error)
  assert.deepEqual(runsIn(B), ['run-test-1.json', 'run-test-2.json'], 'the copy is in B too')
  assert.ok(nothingIn(A))

  // Changing it with no vault named looks in the current vault (A), where it is not: refused, B untouched.
  const elsewhere = updatePlannedRunIn(deps, { talkSlug: SLUG, runId: 'run-test-2', patch: { eventTitle: 'X' } })
  assert.deepEqual(elsewhere, { ok: false, error: 'planned-run-not-found' })
  assert.ok(nothingIn(A), 'a change that names no vault never creates the Run in the current vault')
  assert.equal(readRunForTalk(B, SLUG, 'run-test-2').eventTitle, 'Saïd workshop')

  // No vault named: the current vault, as History and older callers have it.
  const legacy = createPlannedRunIn(deps, plan({ eventTitle: 'From History' }))
  assert.equal(legacy.ok, true, legacy.error)
  assert.deepEqual(runsIn(A), ['run-test-3.json'], 'with no vault id the current vault is written, as before')
  assert.equal(deletePlannedRunIn(deps, { talkSlug: SLUG, runId: 'run-test-3' }).ok, true)
  assert.deepEqual(runsIn(A), [])
  rmSync(join(A, '_PRESENTATIONS'), { recursive: true, force: true })

  // Issue 256: with several vaults open (index.ts passes openVaults), a new plan naming no vault goes to the current
  // vault only when that vault holds its talk; the talk is in B, so it is refused and nothing is written anywhere.
  const many = { ...deps, openVaults: () => 3 }
  const beforeB = runsIn(B).join(',')
  assert.deepEqual(createPlannedRunIn(many, plan({ eventTitle: 'From History' })), { ok: false, error: NAME_THE_VAULT })
  assert.ok(nothingIn(A), 'never written into the first vault because it is first')
  assert.equal(runsIn(B).join(','), beforeB)
  // History plans its own (current) vault's talks: the current vault holds the talk, so it is written there.
  mkdirSync(join(A, 'Talks', SLUG), { recursive: true })
  writeFileSync(join(A, 'Talks', SLUG, `${SLUG}-outline.md`), '# A copy in A\n')
  const inA = createPlannedRunIn(many, plan({ eventTitle: 'From History' }))
  assert.equal(inA.ok, true, inA.error)
  assert.equal(runsIn(A).length, 1, 'a talk the current vault holds is planned there, as History has it')
  rmSync(join(A, '_PRESENTATIONS'), { recursive: true, force: true })
  rmSync(join(A, 'Talks'), { recursive: true, force: true })
  console.log('ok  1 create, change and copy are written in the talk\'s vault')
}

// ---- 2. refusals write nothing anywhere
{
  const snapshot = () => [runsIn(A), runsIn(B), runsIn(C)].map((list) => list.join(','))
  const before = snapshot()
  const malformed = [[null, 'a null vault id'], ['', 'an empty vault id'], [42, 'a vault id that is not text'], [{ id: 'vb' }, 'an object'], [['vb'], 'a list']]
  for (const [vaultId, why] of [['vclosed', 'a closed vault'], ['vmissing', 'an unknown vault'], ...malformed]) {
    const made = createPlannedRunIn(deps, plan({ vaultId }))
    assert.deepEqual(made, { ok: false, error: RUN_VAULT_NOT_OPEN }, why)
    const changed = updatePlannedRunIn(deps, { talkSlug: SLUG, runId: 'run-test-1', patch: { eventTitle: 'Nope' }, vaultId })
    assert.deepEqual(changed, { ok: false, error: RUN_VAULT_NOT_OPEN }, `${why}: a change is refused`)
    assert.deepEqual(deletePlannedRunIn(deps, { talkSlug: SLUG, runId: 'run-test-1', vaultId }), { ok: false, error: RUN_VAULT_NOT_OPEN }, `${why}: a delete is refused`)
  }
  assert.deepEqual(snapshot(), before, 'nothing was written in any vault')
  assert.ok(nothingIn(A) && nothingIn(C))
  assert.ok(!existsSync(join(base, 'closed')), 'the closed vault\'s folder is never created')

  // The vault is open but holds no talk of that slug: the plan is refused, nothing written there or elsewhere.
  assert.deepEqual(createPlannedRunIn(deps, plan({ vaultId: 'vc' })), { ok: false, error: TALK_NOT_IN_VAULT })
  assert.deepEqual(snapshot(), before)

  // Vault B's folder goes (a moved folder, a signed-out cloud drive): refused, never written to A instead.
  const moved = join(base, 'vault-b-moved')
  const { renameSync } = await import('node:fs')
  renameSync(B, moved)
  assert.deepEqual(createPlannedRunIn(deps, plan({ vaultId: 'vb' })), { ok: false, error: RUN_VAULT_NOT_OPEN })
  assert.deepEqual(updatePlannedRunIn(deps, { talkSlug: SLUG, runId: 'run-test-1', patch: { eventTitle: 'Nope' }, vaultId: 'vb' }), { ok: false, error: RUN_VAULT_NOT_OPEN })
  assert.ok(!existsSync(B), 'the missing vault folder is not re-created')
  assert.ok(nothingIn(A) && nothingIn(C), 'and nothing went to another vault')
  renameSync(moved, B)
  assert.equal(readRunForTalk(B, SLUG, 'run-test-1').eventTitle, 'Saïd workshop (moved)', 'the Run is as it was')

  // Reads (history:list-runs, history:talk-handouts): only an absent id is the current vault.
  const reads = { vaultRoot: () => A, readVault: (id) => available().find((vault) => vault.id === id)?.root }
  assert.equal(readRoot(reads, undefined), A)
  assert.equal(readRoot(reads, 'vb'), B)
  for (const [vaultId, why] of [['vclosed', 'a closed vault'], ...malformed]) assert.equal(readRoot(reads, vaultId), null, `${why} reads nothing`)

  // Without the vault resolver a named vault is refused (never the current vault in its place).
  assert.deepEqual(plannedRunVault({ vaultRoot: () => A }, 'vb'), { error: RUN_VAULT_NOT_OPEN })
  console.log('ok  2 closed, missing, unknown or talk-less vaults are refused and nothing is written')
}

// ---- 3. the Run page and Publish for this run read from B
{
  const handlers = new Map()
  const call = (channel, payload) => handlers.get(channel)(null, payload)
  const talkSlidesAsked = []
  const outlinesAsked = []
  registerRunPageIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    vaults: () => available().map(({ id, root }) => ({ id, root })),
    openPath: async () => '', focusLive: () => false,
    readOutline: (root, slug) => { outlinesAsked.push(root); return hasTalk(root, slug) ? '# Talk\n' : null },
    writableVault: (vaultId) => { const picked = runVaultFor(vaultId); return !('error' in picked) && Boolean(picked.root) },
    talkSlides: async (root, slug) => { talkSlidesAsked.push(root); return hasTalk(root, slug) ? { slides: [{ id: 'one', title: 'One' }], preworkIds: [] } : null },
  })
  const ref = { vaultId: 'vb', talkSlug: SLUG, runId: 'run-test-1' }
  const files = await call('sessions:run-files', ref)
  assert.equal(files.ok, true, files.error)
  assert.deepEqual(files.files.pre, { title: 'Research teams intake', steps: 1 }, 'the work file is read from B\'s Work files, not "not found"')
  const answers = await call('sessions:run-answers', ref)
  assert.equal(answers.ok, true)
  assert.equal(answers.pre.source, 'file')
  assert.equal(answers.writable, true, 'a Run of vault B, which can be written, takes pulls and marks')
  const extras = await call('sessions:extra-slides', ref)
  assert.equal(extras.ok, true, extras.error)
  assert.deepEqual(talkSlidesAsked, [B], 'the talk of the Run is read from B')
  assert.deepEqual((await call('sessions:run-files', { ...ref, vaultId: 'va' })), { ok: false, error: 'That Run is no longer there.' }, 'vault A does not have it')
  closed.add('vb')
  assert.equal((await call('sessions:run-files', ref)).ok, false, 'a closed vault reads nothing')
  closed.delete('vb')

  // Publish for this run (index.ts run:publish-handout): the named vault is B, and its work plans from B's file.
  const picked = runVaultFor('vb')
  assert.deepEqual(picked, { root: B })
  const run = readRunForTalk(picked.root, SLUG, 'run-test-1')
  assert.ok(run && hasTalk(picked.root, SLUG), 'the Run and its talk are both in the vault Publish resolves')
  assert.deepEqual(planRunWork(picked.root, run), { ok: true, phases: ['pre'] }, 'its pre-work is read from B\'s Work files')
  assert.equal(planRunWork(A, run).ok, false, 'vault A has no such work file (the defect\'s "not found")')
  assert.deepEqual(runVaultFor('vclosed'), { error: RUN_VAULT_NOT_OPEN })
  assert.deepEqual(runVaultFor(undefined), { root: A }, 'an older caller with no vault id: the current vault')
  console.log('ok  3 the Run page and Publish for this run resolve the talk and work files from B')
}

// ---- 4. pulls, stars and marks go to the Run's own vault
{
  const handlers = new Map()
  const call = (channel, payload) => handlers.get(channel)(null, payload)
  const service = createRunPrework({
    registryPath: join(base, 'run-prework-registry.json'), ownerTokens: memoryOwnerTokens(),
    endpoint: async () => { throw new Error('not used') }, vaultRoot: () => writableVaultRoot() ?? null,
    fetch: async () => { throw new Error('no network in this test') },
  })
  registerRunPreworkIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, service, { vaultFor: runVaultFor })
  const pick = (extra) => call('history:prework-pick', { talkSlug: SLUG, runId: 'run-test-1', stepId: 'watch', change: { type: 'mode', mode: 'all' }, phase: 'pre', ...extra })
  // The Run in B has no answers yet: B is where it is found (A would say the Run is not in the vault).
  assert.deepEqual(pick({ vaultId: 'vb' }), { ok: false, error: 'This Run has no pre-work answers yet.' }, 'the pick is applied to the Run in B')
  assert.deepEqual(pick({}), { ok: false, error: 'This Run is no longer in the vault.' }, 'no vault named: the current vault (A), which does not have it')
  assert.deepEqual(pick({ vaultId: 'vclosed' }), { ok: false, error: RUN_VAULT_NOT_OPEN }, 'a vault that is not open is refused')
  for (const vaultId of [null, '', 42, { id: 'vb' }]) {
    assert.deepEqual(pick({ vaultId }), { ok: false, error: RUN_VAULT_NOT_OPEN }, `a malformed vault id (${JSON.stringify(vaultId)}) is refused, never the current vault`)
    assert.deepEqual(await call('history:prework-refresh', { talkSlug: SLUG, runId: 'run-test-1', phase: 'pre', vaultId }), { ok: false, error: RUN_VAULT_NOT_OPEN })
    assert.equal(call('history:prework-status', { talkSlug: SLUG, runId: 'run-test-1', phase: 'pre', vaultId }), null)
  }
  const question = call('history:prework-question', { talkSlug: SLUG, runId: 'run-test-1', entryId: 'e1', patch: { answered: true }, phase: 'pre', vaultId: 'vb' })
  assert.deepEqual(question, { ok: false, error: 'That question is not on this Run.' }, 'a mark looks in B')
  const pulled = await call('history:prework-refresh', { talkSlug: SLUG, runId: 'run-test-1', phase: 'pre', vaultId: 'vb' })
  assert.equal(pulled.ok, false)
  assert.equal(pulled.error, 'This Run has no pre-work on the handout yet.', 'a pull finds the Run in B (it has nothing sent)')
  assert.equal(pulled.run?.id, 'run-test-1')
  assert.deepEqual(await call('history:prework-refresh', { talkSlug: SLUG, runId: 'run-test-1', phase: 'pre', vaultId: 'vmissing' }), { ok: false, error: RUN_VAULT_NOT_OPEN })
  assert.deepEqual(await call('history:prework-close', { talkSlug: SLUG, runId: 'run-test-1', phase: 'pre', vaultId: 'vclosed' }), { ok: false, error: RUN_VAULT_NOT_OPEN })
  assert.equal(call('history:prework-status', { talkSlug: SLUG, runId: 'run-test-1', phase: 'pre', vaultId: 'vclosed' }), null)
  assert.deepEqual(await service.syncWindows(SLUG, 'run-test-1', B), [], 'the work-time sync reads the Run in B (nothing sent: nothing to push)')
  assert.ok(nothingIn(A) && nothingIn(C), 'nothing was written in another vault')
  console.log('ok  4 pulls, stars and marks go to the Run\'s own vault')
}

// ---- 5. a pull in flight when the Run's vault closes writes nothing
{
  // The Worker's own rules (as test-run-work-service.mjs builds them), behind a fake fetch whose results reply can be held.
  const rulesDir = mkdtempSync(join(tmpdir(), 'tw-runs-vault-rules-'))
  const repo = new URL('..', import.meta.url).pathname
  writeFileSync(join(rulesDir, 'rules.ts'), `export * from '${repo}worker/prework-state.ts'\nexport { parsePreworkFormPush } from '${repo}worker/prework-protocol.ts'\n`)
  const bundled = await build({ entryPoints: [join(rulesDir, 'rules.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
  writeFileSync(join(rulesDir, 'rules.mjs'), bundled.outputFiles[0].text)
  const { createMemoryPreworkStore, createPrework, parsePreworkFormPush, preworkStatus, pushForm, resultsPage, submitPrework } = await import(pathToFileURL(join(rulesDir, 'rules.mjs')).href)
  rmSync(rulesDir, { recursive: true, force: true })

  const NOW = Date.UTC(2026, 9, 2, 12)
  const RUN = 'run-race'
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const object = { prework: createPrework('wkobj901', NOW), store: createMemoryPreworkStore(), token: 'owner-token-wkobj901-0123456789abcdef' }
  let hold = null // { reached, release }
  let resultsCalls = 0
  const fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url)
    const method = init.method ?? 'GET'
    if (pathname === '/prework' && method === 'POST') return reply({ preworkId: 'wkobj901', ownerToken: object.token }, 201)
    const action = pathname.split('/')[3]
    if (action === 'form') {
      const parsed = parsePreworkFormPush(JSON.parse(init.body), NOW)
      if ('error' in parsed) return reply({ error: parsed.error }, 400)
      pushForm(object.prework, parsed.value, NOW)
      return reply({ ok: true, status: preworkStatus(object.prework, NOW) })
    }
    if (action === 'results') {
      resultsCalls += 1
      if (hold) { hold.reached(); await hold.released }
      return reply(resultsPage(object.prework, object.store, Number(searchParams.get('after') ?? 0), NOW))
    }
    return reply({ error: { code: 'not_found' } }, 404)
  }
  const service = createRunPrework({
    registryPath: join(base, 'race-registry.json'), ownerTokens: memoryOwnerTokens(),
    endpoint: async () => ({ baseUrl: 'https://live.example.test', adminSecret: 'admin' }),
    vaultRoot: () => writableVaultRoot() ?? null,
    writableVault: (root) => available().some((vault) => vault.root === root) ? writableRoot(root, fsLike) : null,
    vaultIdAt: (root) => available().find((vault) => vault.root === root)?.id ?? null, // index.ts, over availableVaults()
    fetch, now: () => NOW,
  })
  const handlers = new Map()
  registerRunPreworkIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, service, { vaultFor: runVaultFor })
  const refresh = () => handlers.get('history:prework-refresh')(null, { talkSlug: SLUG, runId: RUN, phase: 'pre', vaultId: 'vb' })

  const work = { pre: { fileId: FILE, opens: '2026-10-01T09:00', closes: '2026-10-05T10:00', timeZone: 'UTC' } }
  persistRunForTalk(B, SLUG, RUN, normaliseRun({
    id: RUN, talkSlug: SLUG, talkTitle: 'AI for research teams', kind: 'delivery', status: 'planned', plannedDate: '2026-10-06', startTime: '10:00',
    timeZone: 'UTC', slideSet: { kind: 'full' }, startedAt: '2026-10-06T10:00:00.000Z', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0,
    context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], work,
  }))
  const FORM = { title: 'Work', intro: '', steps: [{ id: 'q1', n: 1, title: 'Hopes', kind: 'question', questions: true, poll: { type: 'open', question: 'Hopes', options: [] } }] }
  await service.publish(SLUG, RUN, FORM, workWindowMs(readRunForTalk(B, SLUG, RUN).work.pre), 'pre', B)
  submitPrework(object.prework, object.store, 'a1b2c3d4e5f60718', { participantId: 'device-a1b2c3d4e5f60718', submissionId: 'sub-1', stepId: 'q1', kind: 'answer', text: 'First try' }, NOW)

  const runFile = join(B, '_PRESENTATIONS', SLUG, `${RUN}.json`)
  const bytesBefore = readFileSync(runFile, 'utf8')
  const snapshot = () => [A, C].map((root) => existsSync(join(root, '_PRESENTATIONS')))
  let reached
  const reachedP = new Promise((resolve) => { reached = resolve })
  let release
  hold = { reached, released: new Promise((resolve) => { release = resolve }) }
  const pending = refresh()
  await reachedP
  closed.add('vb') // the vault closes while the answers are on their way
  release()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error, RUN_VAULT_GONE, 'the pull says the vault is not open')
  assert.equal(readFileSync(runFile, 'utf8'), bytesBefore, 'the Run in B is byte for byte as it was')
  assert.deepEqual(snapshot(), [false, false], 'and nothing went to another vault')

  // Back open: the same answers are pulled (the cursor did not move), so the test above was not empty.
  closed.delete('vb')
  hold = null
  const again = await refresh()
  assert.equal(again.ok, true, again.error)
  assert.equal(again.added, 1, 'the held answer is pulled now')
  assert.equal(readRunForTalk(B, SLUG, RUN).prework.entries.length, 1)

  // The same race for the timer's pull (a bare root, checked through writableVault).
  submitPrework(object.prework, object.store, '0f1e2d3c4b5a6978', { participantId: 'device-0f1e2d3c4b5a6978', submissionId: 'sub-2', stepId: 'q1', kind: 'answer', text: 'Second' }, NOW)
  const bytesMid = readFileSync(runFile, 'utf8')
  const reached2P = new Promise((resolve) => { reached = resolve })
  hold = { reached, released: new Promise((resolve) => { release = resolve }) }
  const due = service.pullDue()
  await reached2P
  closed.add('vb')
  release()
  assert.deepEqual(await due, [], 'the timer\'s pull changed no Run')
  assert.equal(readFileSync(runFile, 'utf8'), bytesMid, 'and wrote nothing into the closed vault')
  assert.deepEqual(snapshot(), [false, false])
  closed.delete('vb')
  hold = null
  console.log('ok  5 a pull in flight when the vault closes writes nothing anywhere')

  // ---- 6. the vault is replaced at the same folder (removed, another vault id opened there) while a reply is held:
  // the root alone still matches, the id does not. Nothing is written and the cursor stays; restored, the same
  // answer is pulled. Both the timer's pull and a pull that names no vault (B made the current vault).
  const registryFile = join(base, 'race-registry.json')
  const entryB = registry.find((vault) => vault.root === B)
  const heldPull = async (start, label) => {
    const runBytes = readFileSync(runFile, 'utf8')
    const cursorBytes = readFileSync(registryFile, 'utf8')
    const reachedHere = new Promise((resolve) => { reached = resolve })
    hold = { reached, released: new Promise((resolve) => { release = resolve }) }
    const pending = start()
    await reachedHere
    entryB.id = 'vb-replaced' // the same root, another vault
    release()
    await pending
    hold = null
    assert.equal(readFileSync(runFile, 'utf8'), runBytes, `${label}: the Run file is byte for byte as it was`)
    assert.equal(readFileSync(registryFile, 'utf8'), cursorBytes, `${label}: the cursor did not move`)
    assert.deepEqual(snapshot(), [false, false], `${label}: nothing went to another vault`)
    entryB.id = 'vb'
  }
  submitPrework(object.prework, object.store, '1a2b3c4d5e6f7081', { participantId: 'device-1a2b3c4d5e6f7081', submissionId: 'sub-3', stepId: 'q1', kind: 'answer', text: 'Third' }, NOW)
  await heldPull(() => service.pullDue(), 'the timer\'s pull')
  // A row published from vault vb, whose root now holds another vault, is not pulled at all.
  entryB.id = 'vb-replaced'
  const runBytesNow = readFileSync(runFile, 'utf8')
  assert.deepEqual(await service.pullDue(), [], 'the timer skips a Run whose recorded vault is not the one at its root')
  assert.equal(readFileSync(runFile, 'utf8'), runBytesNow)
  entryB.id = 'vb'
  const timerRestored = await service.pullDue()
  assert.equal(timerRestored.length, 1, 'restored, the timer pulls the held answers (the cursor had not moved)')
  assert.equal(readRunForTalk(B, SLUG, RUN).prework.entries.length, 3, 'Second and Third are in the Run now')
  submitPrework(object.prework, object.store, '8a7b6c5d4e3f2011', { participantId: 'device-8a7b6c5d4e3f2011', submissionId: 'sub-4', stepId: 'q1', kind: 'answer', text: 'Fourth' }, NOW)
  closed.add('va') // B is now the current vault
  const unnamed = () => handlers.get('history:prework-refresh')(null, { talkSlug: SLUG, runId: RUN, phase: 'pre' })
  await heldPull(unnamed, 'a pull that names no vault')
  const restored = await unnamed()
  assert.equal(restored.ok, true, restored.error)
  assert.equal(restored.added, 1, 'restored, the held answer is pulled (the cursor had not moved)')
  assert.equal(readRunForTalk(B, SLUG, RUN).prework.entries.length, 4)
  closed.delete('va')
  console.log('ok  6 a vault replaced at the same folder while a reply is held is never written')

  // ---- 7. a copied vault: A holds the same talk and Run id as B, whose publish the row records. A pull into A (the
  // Run page naming A, or the board seed's bare root) makes no request and writes nothing; B still pulls.
  persistRunForTalk(A, SLUG, RUN, readRunForTalk(B, SLUG, RUN))
  const copyFile = join(A, '_PRESENTATIONS', SLUG, `${RUN}.json`)
  const copyBytes = readFileSync(copyFile, 'utf8')
  const cursorBefore = readFileSync(registryFile, 'utf8')
  submitPrework(object.prework, object.store, '2b3c4d5e6f708192', { participantId: 'device-2b3c4d5e6f708192', submissionId: 'sub-5', stepId: 'q1', kind: 'answer', text: 'Fifth' }, NOW)
  const callsBefore = resultsCalls
  const intoCopy = await handlers.get('history:prework-refresh')(null, { talkSlug: SLUG, runId: RUN, phase: 'pre', vaultId: 'va' })
  assert.equal(intoCopy.ok, false, 'the Run page refresh in the copy is refused')
  // Issue 256: the registry keys rows by vault, so the copy has no row of its own: B's object is not even found.
  assert.equal(intoCopy.error, NO_PREWORK_YET)
  assert.ok(intoCopy.run, 'refused as an offline pull is: with the Run as it is on disk')
  const seedCopy = await service.pull(SLUG, RUN, 'pre', A) // the board seed's pull: a bare root
  assert.equal(seedCopy.ok, false, 'the board seed\'s pull into the copy is refused')
  assert.equal(resultsCalls, callsBefore, 'no request was made for the copy')
  assert.equal(readFileSync(copyFile, 'utf8'), copyBytes, 'the copy\'s Run is byte for byte as it was')
  assert.equal(readFileSync(registryFile, 'utf8'), cursorBefore, 'the cursor did not move')
  // A recorded root that matches but a vault id that does not (another vault opened at B's folder): refused before any request.
  entryB.id = 'vb-other'
  assert.equal((await service.pull(SLUG, RUN, 'pre', B)).error, NO_PREWORK_YET, 'the same root under another vault id is refused: that vault has no row')
  assert.equal(resultsCalls, callsBefore, 'and made no request')
  entryB.id = 'vb'
  const intoOwn = await handlers.get('history:prework-refresh')(null, { talkSlug: SLUG, runId: RUN, phase: 'pre', vaultId: 'vb' })
  assert.equal(intoOwn.ok, true, intoOwn.error)
  assert.equal(intoOwn.added, 1, 'the Run\'s own vault still pulls')
  assert.equal(readFileSync(copyFile, 'utf8'), copyBytes, 'and the copy is still untouched')
  // A row with no recorded root (no id either) is refused into any vault: written by a preview before 15 October 2026, it never pulls.
  // As such a preview wrote it: under the key with no vault (issue 256 keys name the vault).
  const legacy = JSON.parse(readFileSync(registryFile, 'utf8'))
  const ownKey = runPreworkKey(SLUG, RUN, 'pre', vaultKeyPart({ id: 'vb' }))
  const legacyRow = legacy.preworks[ownKey]
  assert.ok(legacyRow, 'B\'s row is under B\'s own key')
  delete legacy.preworks[ownKey]
  legacy.preworks[`${SLUG}/${RUN}`] = legacyRow
  legacyRow.key = `${SLUG}/${RUN}`
  delete legacyRow.vaultRoot; delete legacyRow.vaultId; legacyRow.cursor = 0
  writeFileSync(registryFile, JSON.stringify(legacy))
  const legacyBytes = readFileSync(copyFile, 'utf8')
  const legacyCursor = readFileSync(registryFile, 'utf8')
  const legacyCalls = resultsCalls
  const legacyPull = await service.pull(SLUG, RUN, 'pre', A)
  assert.equal(legacyPull.ok, false, 'an older row with no recorded vault is refused')
  // No vault owns it (issue 256 round 2), so the vault asking sees no row of its own at all.
  assert.equal(legacyPull.error, NO_PREWORK_YET)
  assert.equal(resultsCalls, legacyCalls, 'no request was made for the older row')
  assert.equal(readFileSync(copyFile, 'utf8'), legacyBytes, 'the Run is byte for byte as it was')
  assert.equal(readFileSync(registryFile, 'utf8'), legacyCursor, 'the cursor did not move')
  console.log('ok  7 a copied vault with the same talk and Run id is never pulled into')
}

rmSync(base, { recursive: true, force: true })
console.log('runs-in-talk-vault: all passed')
