// A stand-in for the live worker's board, for the presenter board-panel harness
// (scripts/test-presenter-board.mjs). Run with bun: bun scripts/fixtures/board-panel-worker.ts
// One JSON command per stdin line, one JSON reply per stdout line. Every state is the worker's own
// (acceptCard, applyBoardOperation, pollStateFor); every operation goes through the worker's parser.
//   {"cmd":"init","definition":{…},"scene":"d1"|"limit"}  → presenter poll.state
//   {"cmd":"op","message":{…}}                              → {ok, error?, state}
//   {"cmd":"add","column":"keep","text":"…"}                → presenter poll.state
//   {"cmd":"close"} / {"cmd":"open"}                        → presenter poll.state
import { createInterface } from 'node:readline'
import { acceptCard, applyBoardOperation, ensureBoard } from '../../worker/board-state'
import { isPresenterBoardMessage, parsePollDefinition, parsePresenterMessage, type PollDefinition } from '../../worker/protocol'
import { closePoll, createSession, openPoll, pollStateFor, type StoredLiveSession } from '../../worker/session-state'

let session: StoredLiveSession
let definition: PollDefinition
let n = 0
let clock = Date.now() - 10 * 60_000
const poll = () => session.polls[definition.pollId]
const stored = () => ensureBoard(session, poll())
const state = () => pollStateFor(session, poll(), 'presenter')
function add(column: string, text: string, at = (clock += 20_000)) {
  n += 1
  const outcome = acceptCard(stored(), poll(), `participant-${n}`, { kind: 'card.add', submissionId: `s-${n}`, input: { pollId: definition.pollId, column, text } }, at)
  if (outcome.ack.status !== 'confirmed') throw new Error(`card refused: ${outcome.ack.error}`)
  return outcome.ack.cardId!
}
function op(message: unknown) {
  const parsed = parsePresenterMessage(JSON.stringify(message))
  if (!parsed || !isPresenterBoardMessage(parsed)) throw new Error('not_a_board_operation')
  applyBoardOperation(stored(), poll(), parsed)
}
const column = (i: number) => definition.options[i].optionId

// Round-2 D1: 22 cards, groups 1–5 as drawn, five new ones in the inbox, every other card sorted.
function sceneD1() {
  const k = column(0), c = column(1), t = column(2)
  const merge = (source: string, target: string) => op({ type: 'board.merge', pollId: definition.pollId, source: { cardId: source }, target: { cardId: target } })
  const sort = (id: string, to: string) => op({ type: 'board.move', pollId: definition.pollId, target: { cardId: id }, column: to })
  const g1 = add(k, 'More time for hands-on'); merge(add(k, 'Hands-on, please'), g1); merge(add(k, 'More practice time'), g1)
  const g2 = add(c, 'Shorter breaks'); merge(add(c, 'Shorter breaks please'), g2)
  const g3 = add(t, 'Try pair work'); merge(add(t, 'Pair work next time'), g3); merge(add(t, 'Work in pairs'), g3)
  const g4 = add(k, 'The live demo of the expenses form'); merge(add(k, 'Loved the expenses demo'), g4)
  const g5 = add(c, 'Less theory at the start'); merge(add(c, 'Less theory first'), g5)
  sort(add(k, 'Examples from real university work'), k); sort(add(k, 'Small tables for discussion'), k)
  sort(add(c, 'Send the links before the session, not after'), c)
  sort(add(t, 'A follow-up session in a month'), t); sort(add(t, 'Let us try an agent on our own files'), t); sort(add(t, 'A shared channel for questions afterwards'), t)
  // The inbox: five new cards, not sorted, already on screen.
  add(t, 'A follow-up in a month would help'); add(c, 'Does anyone know the wifi password?'); add(c, 'Breaks were too long')
  add(t, 'Pairs worked really well'); add(k, 'More hands-on, less talk', Date.now() - 2000)
}

// Past the limit (D7): limit 12, 20 cards, all sorted.
function sceneLimit() {
  op({ type: 'board.limit', pollId: definition.pollId, limit: 12 })
  for (let i = 0; i < 20; i++) {
    const id = add(column(i % 3), `Idea number ${i + 1} from the room`)
    op({ type: 'board.move', pollId: definition.pollId, target: { cardId: id }, column: column(i % 3) })
  }
}

const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  const command = JSON.parse(line)
  try {
    if (command.cmd === 'init') {
      definition = parsePollDefinition({ ...command.definition, visibility: 'live' })!
      if (!definition) throw new Error('the board definition must parse')
      session = createSession({ sessionId: 'session-harness', shortId: 'abcd', talkSlug: 'talk', createdAt: 0, expiresAt: Date.now() + 3_600_000 })
      openPoll(session, definition)
      n = 0
      if (command.scene === 'd1') sceneD1()
      if (command.scene === 'limit') sceneLimit()
      out({ ok: true, state: state() })
    } else if (command.cmd === 'op') {
      try { op(command.message); out({ ok: true, state: state() }) } catch (error) { out({ ok: false, error: error instanceof Error ? error.message : String(error), state: state() }) }
    } else if (command.cmd === 'add') {
      add(command.column, command.text); out({ ok: true, state: state() })
    } else if (command.cmd === 'close') {
      closePoll(session, definition.pollId); out({ ok: true, state: state() })
    } else if (command.cmd === 'open') {
      openPoll(session, definition); out({ ok: true, state: state() })
    } else out({ ok: false, error: 'unknown command' })
  } catch (error) { out({ ok: false, error: error instanceof Error ? error.message : String(error) }) }
}
