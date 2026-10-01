// Reactions ticket 06 against a real live worker: `wrangler dev` (local, throwaway secrets and state,
// nothing deployed), the main process's own live-session manager and presenter client, the real
// history flush and Run writer, and two phones speaking the audience protocol over real WebSockets.
// Checks:
//   - taps, a replacement (withdraw + add), an undo and a bookmark land on the Run as
//     {reaction, tMs, slideId[, withdrawn]}, with times from the Run's start (clamped at 0), and net out;
//   - questions land with name when given; "Mark answered" reaches the Run;
//   - a bookmark made while reactions are paused (stored by the worker, never pushed to the presenter)
//     reaches the Run through the final recovery when the session ends;
//   - question text never reaches the encrypted recovery record.
// Usage: node scripts/test-run-feedback-live.mjs
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { openSocket, startLiveWorker } from './lib/live-worker-harness.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read, predicate, timeoutMs, label) {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (predicate(value)) return value
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out (${timeoutMs} ms) waiting for ${label}; last: ${JSON.stringify(value)}`)
    await sleep(25)
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-run-feedback-live-'))
const worker = await startLiveWorker()
const phones = []
let manager
try {
  const repo = new URL('..', import.meta.url).pathname
  const entry = join(scratch, 'main-side.ts')
  await writeFile(entry, [
    `export { createLiveSessionManager } from '${repo}src/main/live-session-manager'`,
    `export { flushLiveSessionHistory, recoverFinalLiveHistory } from '${repo}src/main/live-session-history'`,
    `export { normaliseRun, persistRun, readRun, reactionCountsBySlide } from '${repo}src/main/runs'`,
  ].join('\n'))
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
  const bundlePath = join(scratch, 'main-side.mjs')
  await writeFile(bundlePath, bundled.outputFiles[0].text)
  const { createLiveSessionManager, flushLiveSessionHistory, recoverFinalLiveHistory, normaliseRun, persistRun, readRun, reactionCountsBySlide } = await import(pathToFileURL(bundlePath).href)

  const vault = join(scratch, 'vault')
  // The Run writer refuses a vault that does not exist (runPathForTalk resolves the real path).
  await mkdir(vault, { recursive: true })
  const talkSlug = 'run-feedback-live'
  const runStart = Date.now() - 60_000
  persistRun(vault, normaliseRun({ id: 'run-live', talkSlug, talkTitle: 'Run feedback live', startedAt: new Date(runStart).toISOString() }))
  const created = await fetch(`${worker.baseUrl}/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${worker.adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug }),
  }).then((response) => response.json())

  let saved = []
  manager = createLiveSessionManager({
    load: () => [], save: (records) => { saved = structuredClone(records) },
    endRemote: async (record) => {
      const response = await fetch(`${record.baseUrl}/sessions/${encodeURIComponent(record.sessionId)}/close`, {
        method: 'POST', headers: { authorization: `Bearer ${record.presenterToken}` } })
      if (!response.ok && response.status !== 404) throw new Error('close failed')
      return 'ended'
    },
    recoverFinal: (record, after) => recoverFinalLiveHistory(record, after),
    probe: async () => null, notify: () => {}, flushHistory: flushLiveSessionHistory,
  })
  manager.create({ sessionId: created.sessionId, baseUrl: worker.baseUrl, presenterToken: created.presenterToken,
    shortId: 'x', shortUrl: 'https://example.test/x', qrSvg: '<svg/>', talkSlug, vaultRoot: vault,
    expiresAt: created.expiresAt, startedAtMs: runStart, status: 'connecting', endRequested: false,
    pending: [], polls: [], voteRecords: [], cursor: 0, latest: { slideId: 'slide-1', reveal: 0, focus: null } }, 1)
  manager.bindRun(1, { talkSlug, runId: 'run-live' })
  await until(() => manager.snapshot(1)?.status, (s) => s === 'live', 15_000, 'presenter live')

  async function phone(participantId) {
    const socket = await openSocket(`${worker.wsUrl}/sessions/${created.sessionId}/audience?protocol=2&participantId=${participantId}`)
    phones.push(socket)
    const inbox = []
    socket.addEventListener('message', (event) => inbox.push(JSON.parse(String(event.data))))
    let n = 0
    const send = async (message) => {
      const submissionId = `${participantId}-${++n}`
      socket.send(JSON.stringify({ ...message, submissionId }))
      const ack = await until(() => inbox.find((m) => m.submissionId === submissionId), Boolean, 5000, `ack ${submissionId}`)
      assert.equal(ack.status, 'confirmed', `${message.type} ${JSON.stringify(ack)}`)
    }
    return {
      react: (reaction, slideId, offsetMs, withdrawn = false) => send({ type: 'reaction.send', reaction, slideId, tMs: runStart + offsetMs, ...(withdrawn ? { withdrawn: true } : {}) }),
      ask: (text, slideId, offsetMs, name) => send({ type: 'question.submit', text, ...(name ? { name } : {}), slideId, tMs: runStart + offsetMs }),
    }
  }
  const one = await phone('phone-one')
  const two = await phone('phone-two')
  await one.react('puzzled', 'slide-1', 10_000)
  await one.react('helped', 'slide-1', 12_000) // replaces Puzzled: worker records a withdrawal and a tap
  await one.react('bookmark', 'slide-1', 13_000)
  await two.react('puzzled', 'slide-1', 14_000)
  await two.react('custom:Too fast', 'slide-2', -5_000) // a device clock behind the Run's start
  await two.react('custom:Too fast', 'slide-2', 20_000, true) // undo
  await two.ask('<b>Why</b> this?', 'slide-1', 15_000, 'Priya')
  await one.ask('How long did it take?', 'slide-2', 21_000)

  const run = () => readRun(vault, talkSlug, 'run-live')
  await until(() => run()?.reactions?.length ?? 0, (n) => n === 7, 10_000, 'seven reaction records on the Run')
  await until(() => run()?.questions?.length ?? 0, (n) => n === 2, 10_000, 'two questions on the Run')
  let current = run()
  assert.deepEqual(current.reactions.map(({ reaction, slideId, tMs, withdrawn }) => [reaction, slideId, tMs, withdrawn === true]), [
    ['puzzled', 'slide-1', 10_000, false], ['puzzled', 'slide-1', 12_000, true], ['helped', 'slide-1', 12_000, false],
    ['bookmark', 'slide-1', 13_000, false], ['puzzled', 'slide-1', 14_000, false],
    ['custom:Too fast', 'slide-2', 0, false], ['custom:Too fast', 'slide-2', 20_000, true],
  ])
  console.log('  ok  taps, a replacement, an undo and a bookmark land on the Run with run-relative times (clamped at 0)')
  assert.deepEqual(reactionCountsBySlide(current.reactions), [{ slideId: 'slide-1', counts: { puzzled: 1, helped: 1, bookmark: 1 } }])
  console.log('  ok  net counts: slide-1 puzzled 1, helped 1, bookmark 1; slide-2 nets to nothing and is left out')
  assert.deepEqual(current.questions.map(({ text, name, slideId, tMs, answered }) => [text, name ?? null, slideId, tMs, answered]), [
    ['<b>Why</b> this?', 'Priya', 'slide-1', 15_000, false], ['How long did it take?', null, 'slide-2', 21_000, false]])
  console.log('  ok  questions land with slide, time and name when given; text kept as typed')

  const firstQuestion = manager.snapshot(1).questions.find((q) => q.text.startsWith('<b>'))
  assert.equal(manager.poll(1, { type: 'question.answer', questionId: firstQuestion.questionId, answered: true }).success, true)
  await until(() => run()?.questions?.[0]?.answered, (v) => v === true, 10_000, 'answered on the Run')
  console.log('  ok  "Mark answered" reaches the Run')

  assert.equal(manager.poll(1, { type: 'switches.set', reactionsAllowed: false }).success, true)
  await sleep(500)
  await one.react('bookmark', 'slide-2', 30_000) // stored while paused; no counts go to the presenter
  await sleep(300)
  assert.equal(run().reactions.length, 7, 'the paused bookmark has not reached the presenter yet')
  await manager.end(1)
  current = run()
  assert.equal(current.reactions.length, 8)
  assert.deepEqual(current.reactions.at(-1), { id: `${created.sessionId}:r8`, reaction: 'bookmark', slideId: 'slide-2', tMs: 30_000 })
  console.log('  ok  a bookmark made while reactions were paused reaches the Run through the final recovery')
  assert.equal(JSON.stringify(saved).includes('How long did it take?'), false)
  assert.equal(JSON.stringify(saved).includes('reactionRecords'), false)
  console.log('  ok  the recovery record holds no question text and no reaction records')
  console.log('run feedback live: passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  manager?.shutdown()
  for (const socket of phones) try { socket.close() } catch {}
  await worker.stop()
  await rm(scratch, { recursive: true, force: true })
}
