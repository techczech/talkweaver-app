// Feedback-boards ticket 06 against a real live worker: `wrangler dev` (local, throwaway secrets and
// state, nothing deployed), the main process's own live-session manager and presenter client, the
// real history flush and atomic Run writer, the Run's share-link module, and phones speaking the
// audience protocol over real WebSockets.
// Checks:
//   - the board lands on the Run while the talk is live (cards, a numbered group with its count, a
//     hidden card kept and marked) within two seconds of a change;
//   - End live keeping the board open: the Run says until when; a phone that joins the next morning
//     adds a late card; Refresh pulls it into the Run, marked late;
//   - the share link shows the board without the hidden card; Put back puts it on the link; Stop
//     sharing revokes it (410);
//   - Close it now closes the board on the worker (a card after it is refused) and the Run records it.
// Usage: node scripts/test-run-board-live.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, statSync } from 'node:fs'
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

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-run-board-live-'))
const worker = await startLiveWorker()
const phones = []
let manager
try {
  const repo = new URL('..', import.meta.url).pathname
  const entry = join(scratch, 'main-side.ts')
  await writeFile(entry, [
    `export { createLiveSessionManager } from '${repo}src/main/live-session-manager'`,
    `export { closeLiveBoardsLeftOpen, flushLiveSessionHistory, recoverFinalLiveHistory } from '${repo}src/main/live-session-history'`,
    `export { normaliseRun, persistRun, persistRunForTalk, readRun } from '${repo}src/main/runs'`,
    `export { createRunResultsShares } from '${repo}src/main/run-results-share'`,
    `export { runBoardView, setRunBoardCardPutBack } from '${repo}src/shared/run-board'`,
  ].join('\n'))
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
  const bundlePath = join(scratch, 'main-side.mjs')
  await writeFile(bundlePath, bundled.outputFiles[0].text)
  const m = await import(pathToFileURL(bundlePath).href)

  const vault = join(scratch, 'vault')
  mkdirSync(vault, { recursive: true })
  const talkSlug = 'run-board-live'
  const runStart = Date.now() - 60_000
  m.persistRun(vault, m.normaliseRun({ id: 'run-live', talkSlug, talkTitle: 'The current state of AI agents', eventTitle: 'ITSS Briefing',
    startedAt: new Date(runStart).toISOString() }))
  const created = await fetch(`${worker.baseUrl}/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${worker.adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug }),
  }).then((response) => response.json())

  manager = m.createLiveSessionManager({
    load: () => [], save: () => {},
    endRemote: async (record) => {
      const response = await fetch(`${record.baseUrl}/sessions/${encodeURIComponent(record.sessionId)}/close`, {
        method: 'POST', headers: { authorization: `Bearer ${record.presenterToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ keepBoardsOpen: record.keepBoardsOpen === true }) })
      if (!response.ok && response.status !== 404) throw new Error('close failed')
      return 'ended'
    },
    recoverFinal: (record, after) => m.recoverFinalLiveHistory(record, after),
    closeBoards: (record) => m.closeLiveBoardsLeftOpen(record),
    probe: async () => null, notify: () => {}, flushHistory: m.flushLiveSessionHistory,
  })
  manager.create({ sessionId: created.sessionId, baseUrl: worker.baseUrl, presenterToken: created.presenterToken,
    shortId: 'x', shortUrl: 'https://example.test/x', qrSvg: '<svg/>', talkSlug, vaultRoot: vault,
    expiresAt: created.expiresAt, startedAtMs: runStart, status: 'connecting', endRequested: false,
    pending: [], polls: [], voteRecords: [], cursor: 0, latest: { slideId: 'slide-44', reveal: 0, focus: null } }, 1)
  manager.bindRun(1, { talkSlug, runId: 'run-live' })
  await until(() => manager.snapshot(1)?.status, (s) => s === 'live', 15_000, 'presenter live')

  const board = { pollId: 'poll-board', slideId: 'slide-44', type: 'board', question: 'What should we keep, change, try?', visibility: 'live',
    options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'change', label: 'Change' }, { optionId: 'try', label: 'Try' }],
    board: { closesAfterDays: 1 } }
  assert.equal(manager.poll(1, { type: 'poll.open', poll: board }).success, true)
  await until(() => manager.snapshot(1)?.polls?.find((p) => p.pollId === 'poll-board')?.open, Boolean, 5000, 'board open')

  async function phone(participantId) {
    const socket = await openSocket(`${worker.wsUrl}/sessions/${created.sessionId}/audience?protocol=2&participantId=${participantId}`)
    phones.push(socket)
    const inbox = []
    socket.addEventListener('message', (event) => inbox.push(JSON.parse(String(event.data))))
    let n = 0
    return async (column, text) => {
      const submissionId = `${participantId}-${++n}`
      socket.send(JSON.stringify({ type: 'card.add', submissionId, pollId: 'poll-board', column, text }))
      return until(() => inbox.find((message) => message.submissionId === submissionId), Boolean, 5000, `ack ${submissionId}`)
    }
  }
  const run = () => m.readRun(vault, talkSlug, 'run-live')
  const runBoard = () => run()?.boards?.find((b) => b.id === 'poll-board')
  const ann = await phone('phone-ann-1')
  const ben = await phone('phone-ben-1')
  assert.equal((await ann('keep', 'More time for hands-on')).status, 'confirmed')
  assert.equal((await ben('keep', 'Hands-on please')).status, 'confirmed')
  assert.equal((await ben('change', 'This is a waste of a morning')).status, 'confirmed')
  const started = Date.now()
  await until(() => runBoard()?.cards.length ?? 0, (n) => n === 3, 2_000, 'three cards on the Run within two seconds')
  console.log(`  ok  cards reach the Run while the talk is live (${Date.now() - started} ms)`)

  assert.equal(manager.poll(1, { type: 'board.merge', pollId: 'poll-board', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } }).success, true)
  assert.equal(manager.poll(1, { type: 'board.hide', pollId: 'poll-board', target: { cardId: 'card-3' }, hidden: true }).success, true)
  await until(() => runBoard(), (b) => b?.groups.length === 1 && b.cards.find((c) => c.id === 'card-3')?.hidden === true, 2_000, 'merge and hide on the Run')
  assert.deepEqual(runBoard().groups, [{ n: 1, column: 'keep', cardIds: ['card-1', 'card-2'] }])
  console.log('  ok  a merge (numbered group) and a hide land on the Run; the hidden card is kept, marked')

  const endAt = Date.now()
  await manager.end(1, { keepBoardsOpen: true })
  let current = runBoard()
  assert.ok(current.liveEndedAt >= endAt - 1000, 'the Run knows when the talk ended')
  assert.ok(current.openUntil >= endAt + 86_400_000 - 5_000 && current.openUntil <= Date.now() + 86_400_000, 'left open for its one day')
  assert.equal(current.closedAt, undefined)
  console.log('  ok  End live keeping the board open: the Run says it is open until a day after the end')

  const cat = await phone('phone-cat-1')
  assert.equal((await cat('try', 'Recording of the demo, please')).status, 'confirmed', 'a late card lands on the board left open')
  await sleep(300)
  assert.equal(runBoard().cards.length, 3, 'a late card waits on the worker until History pulls it')
  const refreshed = await manager.refreshBoards(talkSlug, 'run-live')
  assert.deepEqual(refreshed, { refreshed: 1 })
  current = runBoard()
  assert.deepEqual(current.cards.map((c) => c.id), ['card-1', 'card-2', 'card-3', 'card-4'])
  assert.equal(m.runBoardView(current).lateCount, 1, 'the late card is marked late')
  assert.ok(current.refreshedAt >= endAt)
  console.log('  ok  Refresh from the board pulls the late card into the Run, marked late')

  // The Run's share link, served by the same worker.
  const registryPath = join(scratch, 'userData', 'run-results-share-registry.json')
  const shares = m.createRunResultsShares({ registryPath, endpoint: async () => ({ baseUrl: worker.baseUrl, adminSecret: worker.adminSecret }),
    linkBase: () => null, fetch })
  const shared = await shares.share(talkSlug, 'run-live', run(), { lifetime: '7', include: { board: true, polls: true } })
  assert.equal('ownerToken' in shared, false, 'a window never sees the owner token')
  assert.equal(statSync(registryPath).mode & 0o777, 0o600, 'the registry is private')
  let html = await (await fetch(shared.url)).text()
  assert.ok(html.includes('More time for hands-on') && html.includes('×2') && html.includes('Recording of the demo, please'))
  assert.ok(html.includes('Still open for cards'), 'the link says the board is still open')
  assert.equal(html.includes('waste of a morning'), false, 'the hidden card is never on the link')
  assert.ok(shared.expiresAt > Date.now() + 6 * 86_400_000 && shared.expiresAt <= Date.now() + 7 * 86_400_000)
  const putBack = { ...run(), boards: run().boards.map((b) => m.setRunBoardCardPutBack(b, 'card-3', true)) }
  m.persistRunForTalk(vault, talkSlug, 'run-live', putBack)
  assert.equal((await shares.refresh(talkSlug, 'run-live', run())).ok, true)
  html = await (await fetch(shared.url)).text()
  assert.ok(html.includes('waste of a morning'), 'Put back puts the card on the link')
  assert.equal(shares.status(talkSlug, 'run-live').url, shared.url, 'one address per Run')
  console.log('  ok  the share link shows the board without the hidden card; Put back puts it on; one address per Run')

  // Close it now.
  const closed = await manager.closeBoards(talkSlug, 'run-live')
  assert.deepEqual(closed, { refreshed: 1 })
  current = runBoard()
  assert.ok(current.closedAt >= endAt)
  assert.equal(current.cards.find((c) => c.id === 'card-3').putBack, true, 'Put back survives the last pull')
  const dan = await phone('phone-dan-1').catch(() => null)
  assert.equal(dan, null, 'no phone can join a closed board')
  assert.equal((await shares.refresh(talkSlug, 'run-live', run())).ok, true)
  html = await (await fetch(shared.url)).text()
  assert.ok(html.includes('Final board'), 'the link now shows the final board')
  console.log('  ok  Close it now closes the board on the worker; the Run and the link record it')

  assert.deepEqual(await shares.stop(talkSlug, 'run-live'), { ok: true })
  assert.equal((await fetch(shared.url)).status, 410)
  assert.equal(shares.status(talkSlug, 'run-live'), null)
  console.log('  ok  Stop sharing revokes the link')
  console.log('run board live: passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  manager?.shutdown()
  for (const socket of phones) { try { socket.close() } catch {} }
  await worker.stop()
  await rm(scratch, { recursive: true, force: true })
}
