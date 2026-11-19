// ADR-0044 §6, rule C: every write queue in the main process is waited for before an update's native call
// (src/main/write-queues.ts). This checks the registry itself, each row of the ADR's queue table (its source reports
// its work under that name; several through the real module), and a source scan that fails for a queue idiom in
// src/main that is not classified in QUEUE_SOURCES, so a new queue cannot slip in unwaited. Also the save-delay test
// hook: absent from a release. Plain Node, no Electron. (The pending-preference reproduction, with the engine, is in
// scripts/test-update-engine.mjs, "rule C".)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  QUEUE_SOURCES, WRITE_QUEUES, WRITE_QUEUE_NAMES, drainWriteQueues, registerDrainHook, resetWriteQueuesForTest, trackWrite, writeQueuesBusy,
} from '../src/main/write-queues.ts'
import { createConfigOverlay } from '../src/main/settings-overlay.ts'
import { createKeyedQueue } from '../src/main/owner-tokens.ts'
import { withTalkFileLock } from '../src/main/talk-writer.ts'
import { createOutlineRecovery } from '../src/main/outline-recovery.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
async function test(name, fn) {
  resetWriteQueuesForTest()
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}
const later = (ms, value = true) => new Promise((resolve) => setTimeout(() => resolve(value), ms))
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : []
})
const IDIOM = /let\s+[A-Za-z]*(?:[Qq]ueue|[Cc]hain|[Tt]ail)\s*:\s*Promise<|=\s*new Map<[^>]*,\s*Promise</g

await test('the source scan: every queue idiom in src/main is classified in QUEUE_SOURCES, one for one, file by file', () => {
  const found = {}
  for (const file of walk(join(ROOT, 'src/main'))) {
    const n = (readFileSync(file, 'utf8').match(IDIOM) ?? []).length
    if (n > 0) found[relative(ROOT, file)] = n
  }
  for (const [file, n] of Object.entries(found)) {
    assert.ok(QUEUE_SOURCES[file], `${file} has ${n} queue idiom(s) and is not in QUEUE_SOURCES (write-queues.ts): is it a write queue?`)
    assert.equal(QUEUE_SOURCES[file].length, n, `${file}: ${n} idiom(s), ${QUEUE_SOURCES[file].length} classified`)
  }
  for (const file of Object.keys(QUEUE_SOURCES)) assert.ok(found[file], `${file} is classified but holds no queue idiom any more`)
  for (const entries of Object.values(QUEUE_SOURCES)) for (const e of entries) assert.ok(WRITE_QUEUE_NAMES.includes(e) || e.startsWith('not a write queue: '), e)
})

await test('each queue in the table reports its work under its own name, where its work starts (source)', () => {
  const where = {
    'settings-overlay': ['src/main/settings-overlay.ts', /chain = trackWrite\('settings-overlay', chain\.then\(/],
    'talk-writer': ['src/main/talk-writer.ts', /const run = trackWrite\('talk-writer', \(chains\.get\(key\)/],
    'outline-recovery': ['src/main/outline-recovery.ts', /const run = trackWrite\('outline-recovery', chain\.then\(work\)\)/],
    scratchpad: ['src/main/scratchpad-store.ts', /const next = trackWrite\('scratchpad', queue\.then\(run, run\)\)/],
    pathways: ['src/main/index.ts', /const operation = trackWrite\('pathways', \(pathwayMutationQueue\.get\(path\)/],
    research: ['src/main/research-writer.ts', /const next = trackWrite\('research', writeQueue\.then\(/],
    'feedback-mirror': ['src/main/feedback-mirror.ts', /const next = trackWrite\('feedback-mirror', chain\.then\(work\)\)/],
    'setup-folder': ['src/main/setup-folder.ts', /const next = trackWrite\('setup-folder', queue\.then\(run, run\)\)/],
    'keyed-queue': ['src/main/owner-tokens.ts', /const result = trackWrite\('keyed-queue', \(tails\.get\(key\)/],
    'live-page-capture': ['src/main/live-page-capture.ts', /const step = trackWrite\('live-page-capture', queue\.then\(/],
    'shared-talk': ['src/main/shared-talk-push.ts', /const next = trackWrite\('shared-talk', previous\.then\(/],
    'config-debounce': ['src/main/index.ts', /registerDrainHook\('config-debounce', \{/],
    'settings-store': ['src/main/index.ts', /registerDrainHook\('settings-store', \{\n  idle: \(\) => !sharedSettings \|\| sharedSettings\.store\.pending\(\) === 0,\n  drain: async \(\) => !sharedSettings \|\| await sharedSettings\.store\.flushWithin\(/],
  }
  assert.deepEqual(Object.keys(where).sort(), [...WRITE_QUEUE_NAMES].sort(), 'every queue in the table has its place')
  for (const [name, [file, pattern]] of Object.entries(where)) assert.match(readFileSync(join(ROOT, file), 'utf8'), pattern, `${name} in ${file}`)
  const index = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
  assert.match(index, /const outcome = await drainWriteQueues\(20_000, baseline\)/, 'the restart waits for the queues')
  assert.match(index, /writeQueuesBusy: \(\) => writeQueuesBusy\(\),/, 'and reads them in the turn of the native call')
})

await test('ADR-0044 §6 lists every queue in WRITE_QUEUES, and every source in QUEUE_SOURCES', () => {
  const adr = readFileSync(join(ROOT, '_ADR/0044-in-place-updates.md'), 'utf8')
  const table = adr.slice(adr.indexOf('**Every write queue in the main process**'), adr.indexOf('**What holds the restart**'))
  const rows = [...table.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1])
  assert.deepEqual(rows.sort(), [...WRITE_QUEUE_NAMES].sort())
  for (const file of Object.keys(QUEUE_SOURCES)) assert.ok(table.includes(file.replace('src/main/', '')), `${file} is named in the ADR`)
})

for (const name of WRITE_QUEUE_NAMES) {
  await test(`queue ${name}: busy while its work runs; the drain waits for it; a failure while waiting fails the drain`, async () => {
    const work = trackWrite(name, later(40))
    assert.deepEqual(writeQueuesBusy(), [name])
    const drained = await drainWriteQueues(1_000)
    assert.equal(await work, true)
    assert.deepEqual(drained, { ok: true, failed: [], timedOut: [] })
    assert.deepEqual(writeQueuesBusy(), [])
    trackWrite(name, later(20).then(() => { throw new Error('the disk is full') })).catch(() => {})
    const failed = await drainWriteQueues(1_000)
    assert.equal(failed.ok, false)
    assert.deepEqual(failed.failed, [name])
  })
}

await test('a drain that runs out of time is not ok, and names the queue still busy', async () => {
  trackWrite('scratchpad', later(200)).catch(() => {})
  const out = await drainWriteQueues(30)
  assert.equal(out.ok, false)
  assert.deepEqual(out.timedOut, ['scratchpad'])
  await delay(220)
})

await test('a failure before the restart began does not hold it (it was reported when it happened)', async () => {
  await trackWrite('research', Promise.reject(new Error('earlier'))).catch(() => {})
  assert.equal((await drainWriteQueues(100)).ok, true)
})

await test('hooks: a debounced write is written at once; the settings store is flushed; a hook that answers false or throws fails the drain', async () => {
  let waiting = 1
  registerDrainHook('config-debounce', { idle: () => waiting === 0, drain: async () => { waiting = 0; return true } })
  assert.deepEqual(writeQueuesBusy(), ['config-debounce'])
  assert.equal((await drainWriteQueues(100)).ok, true)
  assert.deepEqual(writeQueuesBusy(), [])
  registerDrainHook('settings-store', { idle: () => false, drain: async () => false })
  const out = await drainWriteQueues(100)
  assert.equal(out.ok, false)
  assert.ok(out.failed.includes('settings-store'))
  registerDrainHook('settings-store', { idle: () => true, drain: async () => { throw new Error('closed') } })
  assert.equal((await drainWriteQueues(100)).ok, false)
})

await test('real module, settings-overlay: a preference write is busy until the store answers; the drain waits for it', async () => {
  let stored = null
  const store = { view: () => ({ settings: {} }), set: (k, v) => later(40).then(() => { stored = [k, v]; return { ok: true } }), reset: () => Promise.resolve({ ok: true }) }
  const overlay = createConfigOverlay({ file: { read: () => ({}), write: () => {} }, store, log: () => {} })
  overlay.write({ updatesAlphaVersions: true })
  assert.deepEqual(writeQueuesBusy(), ['settings-overlay'])
  assert.equal((await drainWriteQueues(1_000)).ok, true)
  assert.deepEqual(stored, ['updates.alphaVersions', true])
})

for (const failure of ['refused', 'thrown']) {
  await test(`settings-overlay: a ${failure} write fails the registry drain and retains its UI handling`, async () => {
    const logs = []
    const store = {
      view: () => ({ settings: {} }),
      set: async () => { await delay(10); if (failure === 'thrown') throw new Error('disk full'); return { ok: false, error: 'disk full' } },
      reset: async () => ({ ok: true }),
    }
    const overlay = createConfigOverlay({ file: { read: () => ({}), write: () => {} }, store, log: (line) => logs.push(line) })
    overlay.write({ updatesAlphaVersions: true })
    const result = await drainWriteQueues(1_000)
    assert.equal(result.ok, false, 'the registry must see the real failed write')
    assert.deepEqual(result.failed, ['settings-overlay'])
    await overlay.settled()
    assert.deepEqual(overlay.unsaved(), ['updates.alphaVersions'])
    assert.equal(logs.length, 1)
    // A refused write must not poison the next queue turn.
    store.set = async () => ({ ok: true })
    overlay.write({ updatesAlphaVersions: false })
    assert.equal((await drainWriteQueues(1_000)).ok, true)
  })
}

await test('real module, keyed-queue (Run results, prework, the publishing connection): busy until the operation ends', async () => {
  const q = createKeyedQueue()
  let done = false
  void q.run('k', async () => { await delay(30); done = true })
  assert.deepEqual(writeQueuesBusy(), ['keyed-queue'])
  assert.equal((await drainWriteQueues(1_000)).ok, true)
  assert.equal(done, true)
})

await test('real modules, talk-writer and outline-recovery: a talk write under the file lock, and a recovery copy, are waited for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-queues-'))
  try {
    const file = join(dir, 'talk-outline.md')
    writeFileSync(file, '# Talk\n')
    let wrote = false
    void withTalkFileLock(file, async () => { await delay(30); wrote = true })
    assert.ok(writeQueuesBusy().includes('talk-writer'))
    const recovery = createOutlineRecovery(join(dir, 'recovery'))
    void recovery.save(file, 'kept text')
    assert.ok(writeQueuesBusy().includes('outline-recovery'))
    assert.equal((await drainWriteQueues(2_000)).ok, true)
    assert.equal(wrote, true)
    assert.equal((await recovery.read(file))?.text, 'kept text')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test('the save-delay test hook is absent from a release: allowed only in the packaged update-test flavour or an unpackaged test run', async () => {
  const src = readFileSync(join(ROOT, 'src/main/update-test-hooks.ts'), 'utf8')
  // The module imports Electron, so its one decision is read from the source and checked as a function.
  const body = /export function saveDelayAllowed\([^)]*\): boolean \{\n  return ([^\n]+)\n\}/.exec(src)?.[1]
  assert.ok(body, 'saveDelayAllowed is one expression')
  const allowed = new Function('build', `return ${body}`)
  for (const e2e of [false, true]) assert.equal(allowed({ updateTest: false, packaged: true, e2e }), false, `a release (TW_E2E ${e2e}) never waits`)
  assert.equal(allowed({ updateTest: true, packaged: true, e2e: false }), true, 'the packaged update-test flavour')
  assert.equal(allowed({ updateTest: false, packaged: false, e2e: true }), true, 'a test run from source')
  assert.equal(allowed({ updateTest: false, packaged: false, e2e: false }), false, 'a run from source that is not a test')
  assert.match(src, /if \(!saveDelayAllowed\(\{ updateTest: __TW_UPDATE_TEST__, packaged: app\.isPackaged, e2e: process\.env\.TW_E2E === '1' \}\)\) return/)
  assert.match(readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf8'), /__TW_UPDATE_TEST__: 'false'/, 'a release build defines the flag false')
  assert.match(readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8'), /await updateTestSaveDelay\(\)/, 'the one place it is awaited')
})

await test('the queue table is the registry\'s, with a line of what each writes', () => {
  for (const name of WRITE_QUEUE_NAMES) assert.ok(WRITE_QUEUES[name].length > 10, name)
})

console.log(`write queues: ${passed} checks passed`)
