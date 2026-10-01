// Feedback-boards ticket 11 against a real live Worker (`wrangler dev`: local, throwaway secrets and
// state, nothing deployed): the path a picked answer takes onto a board.
//   the Run's picks -> seedPollForRun (the app's own glue: the Run on disk, the compiler's feeds) ->
//   the presenter's real live client -> the Worker -> the board the presenter and a phone both see.
//   - "Only the answers I pick": the board opens with exactly the picked answers, in pick order, in the
//     first column, and the phone's public view has the same cards with nothing that names a participant;
//   - "Every answer": another session's board opens with every answer;
//   - a board the room has already added to keeps its cards when the poll is opened again: the seed is
//     taken once, a change of picks in between does not double or replace anything;
//   - a card the room adds after the seed sits after it; a seeded card is nobody's to withdraw;
//   - a board slide no step feeds opens empty; in a talk that repeats a slide title, the FED board (the second
//     of its title, with the compiler's deduped id) is the one that is seeded;
//   - a pre-work question put in the talk's questions and marked answered from the tray stays on the Run:
//     no audience socket and no worker question list ever carries it.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-run-prework-seed-live.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { startLiveWorker, openSocket } from './lib/live-worker-harness.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { seedPollForRun } from '../src/main/run-prework-seed.ts'
import { answerPreworkTrayQuestion, preworkTrayForSession } from '../src/main/prework-tray.ts'
import { answerRows } from '../src/shared/run-prework-results.ts'
import { markRunPreworkQuestion, normaliseRun, persistRunForTalk, readRunForTalk, setRunPreworkPick } from '../src/main/runs.ts'
import { DUP_TALK, OUTLINE, RUN_ID, SLUG, plannedRun } from './lib/prework-run-fixture.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read, predicate, timeoutMs, label) {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out (${timeoutMs} ms) waiting for ${label}; last: ${JSON.stringify(value)}`)
    await sleep(25)
  }
}
const results = []
const pass = (name) => { results.push(name); console.log(`PASS  ${name}`) }

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-prework-seed-'))
const worker = await startLiveWorker()
const clients = []
const workerQuestions = []
const sockets = []
try {
  const entry = join(scratch, 'presenter-side.ts')
  const repo = new URL('..', import.meta.url).pathname
  await writeFile(entry, `export { createLivePresenterClient } from '${repo}src/main/live-presenter-client'\n`)
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
  await writeFile(join(scratch, 'presenter-side.mjs'), bundled.outputFiles[0].text)
  const { createLivePresenterClient } = await import(pathToFileURL(join(scratch, 'presenter-side.mjs')).href)

  // The real compiled board of the fixture talk, as the presenter would open it.
  const sourcePath = join(scratch, 'talk.md')
  await writeFile(sourcePath, OUTLINE)
  const model = await prepareSource(sourcePath, OUTLINE, 'Seed live test', statSync(sourcePath))
  const compiled = model.slides.find((slide) => slide.id === 'hopesboard')?.poll
  assert.ok(compiled && compiled.type === 'board', 'the compiler emits the fed board poll')
  const base = { ...compiled, slideId: 'hopesboard' }
  const column = base.options[0].optionId
  const run = normaliseRun(plannedRun())
  const rows = answerRows(run.prework, 'pwhope')
  // The Run on disk, as the app reads it; the glue reads the outline and the compiler's feeds as the app does.
  const vault = join(scratch, 'vault')
  await mkdir(join(vault, '_PRESENTATIONS', SLUG), { recursive: true })
  persistRunForTalk(vault, SLUG, RUN_ID, run)
  const setPicks = (pick) => persistRunForTalk(vault, SLUG, RUN_ID, setRunPreworkPick(readRunForTalk(vault, SLUG, RUN_ID), 'pwhope', pick))
  const glue = (text) => ({ vaultRoot: () => vault, readOutline: () => text, feeds: async (outline) => {
    const path = join(scratch, 'glue.md'); await writeFile(path, outline)
    return (await prepareSource(path, outline, 'glue', statSync(path))).prework?.feeds ?? null } })
  const seedFor = (poll, text = OUTLINE) => seedPollForRun(poll, { talkSlug: SLUG, runId: RUN_ID }, glue(text))

  async function session(name) {
    const created = await fetch(`${worker.baseUrl}/sessions`, { method: 'POST', headers: { authorization: `Bearer ${worker.adminSecret}`, 'content-type': 'application/json' }, body: JSON.stringify({ talkSlug: name }) }).then((response) => response.json())
    const state = { board: null, status: 'connecting' }
    const client = createLivePresenterClient({
      baseUrl: worker.baseUrl, sessionId: created.sessionId, presenterToken: created.presenterToken, latest: { slideId: 'hopesboard', reveal: 0, focus: null },
      onStatus: (next) => { state.status = next }, onPollState: (message) => { if (message.pollType === 'board') state.board = message }, onQuestions: (questions) => workerQuestions.push(questions),
    })
    clients.push(client)
    await until(() => state.status, (value) => value === 'live', 10_000, 'presenter live')
    const phone = async (participantId) => {
      const socket = await openSocket(`${worker.wsUrl}/sessions/${created.sessionId}/audience?protocol=2&participantId=${participantId}`)
      sockets.push(socket)
      const inbox = []
      socket.addEventListener('message', (event) => inbox.push(JSON.parse(String(event.data))))
      return { socket, inbox }
    }
    return { created, state, client, phone, texts: () => (state.board?.boardState?.cards ?? []).map((card) => card.text) }
  }

  // 1. Only the picked answers, in pick order.
  {
    const s = await session('seed-picked')
    setPicks({ mode: 'picked', ids: [rows[3].id, rows[0].id, rows[2].id] })
    const poll = await seedFor(base)
    assert.equal(poll.seed.length, 3)
    const phone = await s.phone('phone-seed-viewer-1')
    s.client.sendPoll({ type: 'poll.open', poll })
    await until(() => s.texts(), (list) => list.length === 3, 5000, 'three seeded cards at the presenter')
    assert.deepEqual(s.texts(), ['Save time on admin email', 'Use an agent on my own files safely', 'Whether it is allowed with student data'])
    assert.ok(s.state.board.boardState.cards.every((card) => card.column === column), 'in the first column')
    assert.equal(s.state.board.seed, undefined, 'the seed is not part of the poll the worker reports')
    s.client.publish('hopesboard', 0, null)
        const view = await until(() => phone.inbox.find((message) => message.type === 'poll.state' && message.pollType === 'board'), Boolean, 5000, 'the phone\'s board')
    assert.deepEqual(view.boardState.cards.map((card) => card.text), s.texts(), 'the phone sees the same cards')
    const frames = JSON.stringify(view)
    assert.ok(!/seed:prework|participant|"name"|hidden/.test(frames), 'nothing that names a participant, and no presenter-only field, reaches the phone')
    pass('only the picked answers: on the board in pick order in the first column; the phone sees the same public cards')

    // 2. The room adds a card; the poll is opened again with different picks: nothing doubles or is replaced.
    const submissionId = 'seed-phone-add-1'
    phone.socket.send(JSON.stringify({ type: 'card.add', submissionId, pollId: base.pollId, column, text: 'Time to practise' }))
    await until(() => phone.inbox.find((message) => message.submissionId === submissionId), (ack) => ack?.status === 'confirmed', 5000, 'the room\'s card acknowledged')
    await until(() => s.texts(), (list) => list.length === 4, 5000, 'the room\'s card at the presenter')
    assert.equal(s.texts()[3], 'Time to practise', 'a card the room adds sits after the seed')
    s.client.sendPoll({ type: 'poll.close', pollId: base.pollId })
    await sleep(200)
    setPicks({ mode: 'all', ids: [rows[3].id] })
    s.client.sendPoll({ type: 'poll.open', poll: await seedFor(base) })
    await sleep(600)
    assert.equal(s.texts().length, 4, 'a reopened board keeps its cards and takes no second seed')
    assert.equal(s.texts()[3], 'Time to practise')
    // A seeded card is nobody's to withdraw.
    const seededId = s.state.board.boardState.cards[0].cardId
    phone.socket.send(JSON.stringify({ type: 'card.withdraw', submissionId: 'seed-phone-withdraw-1', pollId: base.pollId, cardId: seededId }))
    const refused = await until(() => phone.inbox.find((message) => message.submissionId === 'seed-phone-withdraw-1'), Boolean, 5000, 'the withdrawal answered')
    assert.notEqual(refused.status, 'confirmed', 'a phone cannot withdraw a seeded card')
    assert.equal(s.texts().length, 4)
    pass('the room adds after the seed; reopening takes no second seed; a seeded card cannot be withdrawn')
  }

  // 3. Every answer.
  {
    const s = await session('seed-all')
    setPicks(null)
    s.client.sendPoll({ type: 'poll.open', poll: await seedFor(base) })
    await until(() => s.texts(), (list) => list.length === 6, 5000, 'six seeded cards')
    assert.deepEqual(s.texts(), rows.map((row) => row.text))
    pass('every answer: the board opens with all six, oldest first, markup as plain text')
  }

  // 4. A board no step feeds opens empty.
  {
    const s = await session('seed-none')
    s.client.sendPoll({ type: 'poll.open', poll: await seedFor({ ...base, slideId: 'discuss' }) })
    await until(() => s.state.board, Boolean, 5000, 'the board open')
    assert.deepEqual(s.texts(), [])
    pass('a board slide no step feeds opens empty')
  }
  // 5. A talk that repeats a slide title: the fed board is the second, `hopes-for-today-2`.
  {
    const dupPath = join(scratch, 'dup.md')
    await writeFile(dupPath, DUP_TALK)
    const dup = await prepareSource(dupPath, DUP_TALK, 'Dup', statSync(dupPath))
    const board = dup.slides.find((slide) => slide.id === 'hopes-for-today-2').poll
    const s = await session('seed-dup')
    setPicks(null)
    const poll = await seedFor({ ...board, slideId: 'hopes-for-today-2' }, DUP_TALK)
    assert.equal(poll.seed?.length, 6, 'the second slide of a repeated title is seeded')
    s.client.sendPoll({ type: 'poll.open', poll })
    await until(() => s.texts(), (list) => list.length === 6, 5000, 'the repeated-title board seeded')
    const first = dup.slides.find((slide) => slide.id === 'hopes-for-today')
    assert.equal(first.poll, undefined, 'the first slide of that title is a plain slide')
    pass('two slides of one title: the fed board (compiler id hopes-for-today-2) opens with the answers')
  }

  // 6. The tray's questions never leave the Run.
  {
    const s = await session('seed-tray')
    const phone = await s.phone('phone-tray-viewer-1')
    s.client.sendPoll({ type: 'poll.open', poll: await seedFor(base) })
    s.client.publish('hopesboard', 0, null)
    const run0 = readRunForTalk(vault, SLUG, RUN_ID)
    const question = run0.prework.entries.find((entry) => entry.kind === 'question' && entry.name === 'Sam')
    persistRunForTalk(vault, SLUG, RUN_ID, markRunPreworkQuestion(run0, question.id, { inTalk: { slideId: 'hopesboard' } }))
    const tray = preworkTrayForSession(vault, { talkSlug: SLUG, runId: RUN_ID })
    assert.equal(tray.length, 1)
    const done = answerPreworkTrayQuestion(vault, { talkSlug: SLUG, runId: RUN_ID }, tray[0].questionId, true)
    assert.equal(done.success, true)
    assert.equal(readRunForTalk(vault, SLUG, RUN_ID).prework.entries.find((entry) => entry.id === question.id).answered, true, 'Mark answered from the tray updated the Run')
    await sleep(600)
    const wire = JSON.stringify([phone.inbox, s.state.board, workerQuestions])
    assert.ok(!wire.includes('student by name'), 'the question text is on no audience socket and in no presenter state from the Worker')
    assert.ok(!wire.includes(question.id) && !wire.includes('pw:'), 'nor is its id')
    const snapshot = await fetch(`${worker.baseUrl}/sessions/${s.created.sessionId}/status`, { headers: { authorization: `Bearer ${s.created.presenterToken}` } }).then((response) => response.text())
    assert.ok(!snapshot.includes('student by name'), 'the Worker\'s own status does not hold it either')
    pass('a pre-work question in the tray and its Mark answered live on the Run only: nothing reaches an audience socket or the Worker')
  }
  console.log(`\n${results.length} groups passed`)
} finally {
  for (const socket of sockets) { try { socket.close() } catch {} }
  for (const client of clients) { try { client.disconnect() } catch {} }
  await worker.stop()
  await rm(scratch, { recursive: true, force: true })
}
