// The presenter's board panel, its pure model (feedback-boards ticket 05; ADR-0032 amendment point 1).
// Seam: every gesture the panel offers maps to exactly ONE worker operation, which the worker's own
// parser accepts and its own reducer applies; the panel's view is the worker's, never recomputed
// (what waits, the groups and counts come from boardView); an undo is one operation that puts the
// board back as it was. States are made by the worker's code (acceptCard, applyBoardOperation,
// pollStateFor), as the big-screen gate does.
// Run: bun test ./scripts/board-panel-model.test.ts
import { describe, expect, test } from 'bun:test'
import { boardPanelRuntimeSource } from '../compiler/assets/runtime/board-panel.js'
import { bpDrop, bpFind, bpMessage, bpResolve, bpToast, bpUndo, bpView, boardPanelModelSource } from '../compiler/assets/runtime/board-panel-model.js'
import { acceptCard, applyBoardOperation, ensureBoard } from '../worker/board-state'
import { isPresenterBoardMessage, parsePollDefinition, parsePresenterMessage } from '../worker/protocol'
import { closePoll, createSession, openPoll, pollStateFor } from '../worker/session-state'

const COLUMNS = [{ optionId: 'keep', label: 'Keep' }, { optionId: 'change', label: 'Change' }, { optionId: 'try', label: 'Try' }]
const definition = parsePollDefinition({ pollId: 'poll-board', slideId: 'kct', type: 'board', question: 'What should we keep, change, try?',
  visibility: 'live', options: COLUMNS, board: { limit: 24, cardChars: 140, cardsPerPhone: 5, names: false, closesAfterDays: 7 } })!

function board() {
  const session = createSession({ sessionId: 's', shortId: 'abcd', talkSlug: 't', createdAt: 0, expiresAt: 60_000 })
  openPoll(session, definition)
  let n = 0
  const poll = () => session.polls[definition.pollId]
  const stored = () => ensureBoard(session, poll())
  return {
    session,
    add(column: string, text: string, at = 1000 + n) {
      n += 1
      const outcome = acceptCard(stored(), poll(), `p-${n}`, { kind: 'card.add', submissionId: `x-${n}`, input: { pollId: definition.pollId, column, text } }, at)
      if (outcome.ack.status !== 'confirmed') throw new Error(String(outcome.ack.error))
      return outcome.ack.cardId!
    },
    /** Send what the panel sends: parsed by the worker's parser, applied by its reducer. */
    send(message: unknown) {
      const parsed = parsePresenterMessage(JSON.stringify(message))
      if (!parsed || !isPresenterBoardMessage(parsed)) throw new Error(`not a board operation: ${JSON.stringify(message)}`)
      applyBoardOperation(stored(), poll(), parsed)
      return parsed
    },
    state: () => pollStateFor(session, poll(), 'presenter'),
    close: () => closePoll(session, definition.pollId),
  }
}
const view = (b: ReturnType<typeof board>, sorted = new Set<string>()) => bpView(definition, b.state(), sorted)
const plain = (b: ReturnType<typeof board>) => JSON.parse(JSON.stringify(b.state().boardState, (key, value) => key === 'touched' || key === 'fromGroup' ? undefined : value))

describe('every gesture is exactly one worker operation', () => {
  const intents = [
    { op: 'move', target: { cardId: 'card-1' }, column: 'try' },
    { op: 'move', target: { group: 1 }, column: 'try' },
    { op: 'merge', source: { cardId: 'card-3' }, target: { cardId: 'card-4' } },
    { op: 'merge', source: { cardId: 'card-3' }, target: { group: 1 } },
    { op: 'merge', source: { group: 1 }, target: { cardId: 'card-4' } },
    { op: 'split', group: 1 },
    { op: 'hide', target: { cardId: 'card-3' }, hidden: true },
    { op: 'hide', target: { group: 1 }, hidden: true },
    { op: 'hide', target: { cardId: 'card-3' }, hidden: false },
    { op: 'freeze', frozen: true },
    { op: 'freeze', frozen: false },
    { op: 'release', mode: 'next', count: 12 },
    { op: 'release', mode: 'all' },
    { op: 'release', mode: 'groupsOnly' },
    { op: 'release', mode: 'limit' },
    { op: 'release', mode: 'all', column: 'keep' },
    { op: 'release', mode: 'groupsOnly', column: 'keep' },
    { op: 'release', mode: 'limit', column: 'keep' },
    { op: 'limit', limit: 12 },
    { op: 'limit', limit: null },
    { op: 'relabel', group: 1, text: 'Hands-on time' },
    { op: 'relabel', group: 1, text: '' },
  ]
  for (const intent of intents) {
    test(`${intent.op} ${JSON.stringify(intent)}`, () => {
      const b = board()
      const [a, c] = [b.add('keep', 'More time for hands-on'), b.add('keep', 'Hands-on time')]
      b.send({ type: 'board.merge', pollId: definition.pollId, source: { cardId: c }, target: { cardId: a } })
      b.add('change', 'Shorter breaks'); b.add('try', 'Try pair work')
      const message = bpMessage(definition.pollId, intent)
      expect(message).not.toBeNull()
      expect(Array.isArray(message)).toBe(false)
      const parsed = b.send(message)
      expect(parsed.type).toBe(message!.type)
    })
  }
  test('what is not an operation sends nothing', () => {
    expect(bpMessage(definition.pollId, { op: 'mark-sorted' })).toBeNull()
    expect(bpMessage(definition.pollId, { op: 'move', target: { cardId: 'card-1' } })).toBeNull()
    expect(bpMessage(definition.pollId, { op: 'limit', limit: 0 })).toBeNull()
    expect(bpMessage('', { op: 'freeze', frozen: true })).toBeNull()
  })
})

describe('drops', () => {
  test('onto a card or group merges, onto a column moves, onto itself does nothing', () => {
    expect(bpDrop({ cardId: 'card-2' }, { cardId: 'card-1' })).toEqual({ op: 'merge', source: { cardId: 'card-2' }, target: { cardId: 'card-1' } })
    expect(bpDrop({ cardId: 'card-2' }, { group: 4 })).toEqual({ op: 'merge', source: { cardId: 'card-2' }, target: { group: 4 } })
    expect(bpDrop({ group: 4 }, { column: 'try' })).toEqual({ op: 'move', target: { group: 4 }, column: 'try' })
    expect(bpDrop({ group: 4 }, { group: 4 })).toBeNull()
    expect(bpDrop({ cardId: 'card-2' }, { cardId: 'card-2' })).toBeNull()
  })
})

describe('the view is the worker\'s', () => {
  test('inbox: new singles, newest first; sorted ones leave it; columns hold the rest', () => {
    const b = board()
    const first = b.add('keep', 'Oldest', 100)
    const second = b.add('change', 'Middle', 200)
    const third = b.add('try', 'Newest', 300)
    let v = view(b)
    expect(v.inbox.map((entry) => entry.text)).toEqual(['Newest', 'Middle', 'Oldest'])
    expect(v.newCount).toBe(3)
    expect(v.columns.map((column) => column.entries.length)).toEqual([0, 0, 0])
    // Dragging a new card to its own column sorts it (one board.move, the worker marks it touched).
    b.send(bpMessage(definition.pollId, { op: 'move', target: { cardId: first }, column: 'keep' }))
    v = view(b)
    expect(v.inbox.map((entry) => entry.cardId)).toEqual([third, second])
    expect(v.columns[0].entries.map((entry) => entry.cardId)).toEqual([first])
    // "Mark all sorted" is the panel's own: nothing is sent, the inbox empties here.
    v = view(b, new Set([second, third]))
    expect(v.newCount).toBe(0)
    expect(v.columns.map((column) => column.count)).toEqual([1, 1, 1])
  })

  test('past the limit: the strip, waiting cards and counts come from the worker (D7, D9, D12)', () => {
    const b = board()
    b.send({ type: 'board.limit', pollId: definition.pollId, limit: 12 })
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push(b.add(['keep', 'change', 'try'][i % 3], `Card ${i}`, 1000 + i))
    let v = view(b, new Set(ids))
    expect(v.strip.text).toBe('Big screen 12 of 20')
    expect(v.strip.detail).toBe('8 waiting')
    expect(v.strip.next).toBe(8)
    const state = b.state().boardState!
    expect(v.columns.map((column) => column.waiting)).toEqual(state.columns.map((column) => column.waiting))
    const waitingIds = state.cards.filter((card) => card.waiting).map((card) => card.cardId).sort()
    expect(v.columns.flatMap((column) => column.entries).filter((entry: any) => entry.waiting).map((entry: any) => entry.cardId).sort()).toEqual(waitingIds)
    b.send(bpMessage(definition.pollId, { op: 'release', mode: 'all' }))
    v = view(b, new Set(ids))
    expect(v.strip.text).toBe('Big screen every card')
    expect(v.strip.detail).toBe('20, past the limit of 12')
    expect(v.strip.back).toBe(12)
  })

  test('groups: the first visible card names the group, its count is the worker\'s; hidden ones go last', () => {
    const b = board()
    const a = b.add('keep', 'More time for hands-on'), c = b.add('keep', 'Hands-on, please'), d = b.add('keep', 'Small tables')
    b.send(bpMessage(definition.pollId, { op: 'merge', source: { cardId: c }, target: { cardId: a } }))
    b.send(bpMessage(definition.pollId, { op: 'hide', target: { cardId: d }, hidden: true }))
    const v = view(b)
    const keep = v.columns[0]
    expect(keep.entries.map((entry: any) => entry.kind === 'group' ? `g${entry.n}×${entry.count}` : `${entry.text}${entry.hidden ? ' (hidden)' : ''}`))
      .toEqual(['g1×2', 'Small tables (hidden)'])
    expect(keep.count).toBe(2)
    expect(bpToast({ op: 'merge', source: { cardId: 'x' }, target: { group: 1 } }, v).detail).toBe('now ×3')
  })

  test('the phase: ready before it opens, open, closed, frozen', () => {
    const b = board()
    expect(bpView(definition, null, new Set()).phase).toBe('ready')
    expect(view(b).phase).toBe('open')
    b.send({ type: 'board.freeze', pollId: definition.pollId, frozen: true })
    expect(view(b).phase).toBe('frozen')
    b.send({ type: 'board.freeze', pollId: definition.pollId, frozen: false })
    b.close()
    expect(view(b).phase).toBe('closed')
  })
})

describe('undo is one operation that puts the board back', () => {
  const cases: Array<[string, (b: ReturnType<typeof board>, ids: string[]) => any]> = [
    ['hide a card', (_b, ids) => ({ op: 'hide', target: { cardId: ids[2] }, hidden: true })],
    ['hide a group', () => ({ op: 'hide', target: { group: 1 }, hidden: true })],
    ['move a card', (_b, ids) => ({ op: 'move', target: { cardId: ids[2] }, column: 'try' })],
    ['move a group', () => ({ op: 'move', target: { group: 1 }, column: 'change' })],
    ['merge a card into a group', (_b, ids) => ({ op: 'merge', source: { cardId: ids[2] }, target: { group: 1 } })],
    ['freeze', () => ({ op: 'freeze', frozen: true })],
    ['show all', () => ({ op: 'release', mode: 'all' })],
    ['a column\'s groups only', () => ({ op: 'release', mode: 'groupsOnly', column: 'keep' })],
    ['the limit', () => ({ op: 'limit', limit: 12 })],
    ['a group\'s wording', () => ({ op: 'relabel', group: 1, text: 'A and B' })],
  ]
  for (const [name, make] of cases) {
    test(name, () => {
      const b = board()
      const ids = [b.add('keep', 'A'), b.add('keep', 'B'), b.add('keep', 'C'), b.add('change', 'D')]
      b.send({ type: 'board.merge', pollId: definition.pollId, source: { cardId: ids[1] }, target: { cardId: ids[0] } })
      const before = plain(b)
      const intent = make(b, ids)
      const undo = bpUndo(intent, view(b))
      expect(undo).not.toBeNull()
      b.send(bpMessage(definition.pollId, intent))
      b.send(bpMessage(definition.pollId, bpResolve(undo, view(b))))
      expect(plain(b)).toEqual(before)
    })
  }
  test('a merge of two singles is undone by splitting the group it made (its number retires)', () => {
    const b = board()
    const [a, c] = [b.add('keep', 'A'), b.add('keep', 'B')]
    const intent = { op: 'merge', source: { cardId: c }, target: { cardId: a } }
    const undo = bpUndo(intent, view(b))
    b.send(bpMessage(definition.pollId, intent))
    const resolved = bpResolve(undo, view(b))
    expect(resolved).toEqual({ op: 'split', group: 1 })
    b.send(bpMessage(definition.pollId, resolved))
    expect(b.state().boardState!.groups).toEqual([])
    expect(b.state().boardState!.cards.filter((card) => card.group === undefined).length).toBe(2)
  })
  test('no undo where one operation cannot: merging a group, splitting, a release on a release', () => {
    const b = board()
    const [a, c, d] = [b.add('keep', 'A'), b.add('keep', 'B'), b.add('keep', 'C')]
    b.send({ type: 'board.merge', pollId: definition.pollId, source: { cardId: c }, target: { cardId: a } })
    expect(bpUndo({ op: 'merge', source: { group: 1 }, target: { cardId: d } }, view(b))).toBeNull()
    expect(bpUndo({ op: 'split', group: 1 }, view(b))).toBeNull()
    b.send({ type: 'board.release', pollId: definition.pollId, mode: 'all' })
    expect(bpUndo({ op: 'release', mode: 'groupsOnly' }, view(b))).toBeNull()
  })
})

test('the embedded source defines every function without module syntax', () => {
  const source = boardPanelModelSource()
  expect(source).not.toMatch(/^\s*(export|import)\b/m)
  const fns = new Function(`${source}; return { bpView, bpFind, bpDrop, bpMessage, bpUndo, bpResolve, bpToast, bpRefusal, bpAgo }`)()
  expect(Object.values(fns).every((fn) => typeof fn === 'function')).toBe(true)
  expect(bpFind(null, { cardId: 'x' })).toBeNull()
})

// The controller as the presenter template embeds it: the model's functions and the controller in one scope.
const createBoardController = new Function(`${boardPanelRuntimeSource(boardPanelModelSource())}; return createBoardController`)()

describe('the controller: undo and the keyboard drop', () => {
  function controlled() {
    const b = board()
    const sent: any[] = []
    const controller = createBoardController({ send: async (message: any) => { sent.push(message); b.send(message); return { success: true, status: 'pending' } }, store: null })
    const sync = () => controller.set(definition, b.state())
    return { b, sent, controller, sync }
  }
  test('S1: ⌘Z pressed before the worker answers a merge of two singles still undoes it, once the answer comes', async () => {
    const { b, sent, controller, sync } = controlled()
    const [a, c] = [b.add('keep', 'A'), b.add('keep', 'B')]
    sync()
    await controller.apply({ op: 'merge', source: { cardId: c }, target: { cardId: a } })
    // The state carrying group 1 has not reached the panel yet.
    expect(controller.undo()).toBe(true)
    expect(sent.length).toBe(1)
    sync()
    await Promise.resolve()
    expect(sent.length).toBe(2)
    expect(sent[1]).toMatchObject({ type: 'board.split', group: 1 })
    sync()
    expect(b.state().boardState!.groups).toEqual([])
  })
  test('S1: a new change cancels an undo still waiting', async () => {
    const { b, sent, controller, sync } = controlled()
    const [a, c] = [b.add('keep', 'A'), b.add('keep', 'B')]
    sync()
    await controller.apply({ op: 'merge', source: { cardId: c }, target: { cardId: a } })
    controller.undo()
    await controller.apply({ op: 'freeze', frozen: true })
    sync()
    expect(sent.map((m) => m.type)).toEqual(['board.merge', 'board.freeze'])
  })
  test('N1: a refused merge leaves no undo waiting', async () => {
    const b = board()
    const [a, c] = [b.add('keep', 'A'), b.add('keep', 'B')]
    const sent: any[] = []
    const controller = createBoardController({ send: async (message: any) => { sent.push(message); return { success: false, status: 'rejected', error: 'board_frozen' } }, store: null })
    controller.set(definition, b.state())
    const applying = controller.apply({ op: 'merge', source: { cardId: c }, target: { cardId: a } })
    controller.undo()
    await applying
    expect(controller.toast().text).not.toBe('Undoing…')
    controller.set(definition, b.state())
    await Promise.resolve()
    expect(sent.length).toBe(1)
  })
  test('T2: the undo goes when the board goes', async () => {
    const { b, sent, controller, sync } = controlled()
    const id = b.add('keep', 'A')
    sync()
    await controller.apply({ op: 'hide', target: { cardId: id }, hidden: true })
    sync()
    expect(controller.hasUndo()).toBe(true)
    controller.set(null, null)
    expect(controller.hasUndo()).toBe(false)
    sync()
    expect(controller.undo()).toBe(false)
    expect(sent.length).toBe(1)
  })
  test('S3: a hidden card or group is no keyboard drop target; the pick stays held', async () => {
    const { b, sent, controller, sync } = controlled()
    const [a, c, d] = [b.add('keep', 'A'), b.add('keep', 'B'), b.add('keep', 'C')]
    b.send({ type: 'board.merge', pollId: definition.pollId, source: { cardId: c }, target: { cardId: a } })
    b.send({ type: 'board.hide', pollId: definition.pollId, target: { group: 1 }, hidden: true })
    const e = b.add('change', 'D')
    b.send({ type: 'board.hide', pollId: definition.pollId, target: { cardId: e }, hidden: true })
    sync()
    expect(controller.pickUp({ cardId: d })).toBe(true)
    expect(controller.drop({ group: 1 })).toBe(true)
    expect(controller.drop({ cardId: e })).toBe(true)
    expect(sent.length).toBe(0)
    expect(controller.pick()).not.toBeNull()
    controller.drop({ column: 'change' })
    await Promise.resolve()
    expect(sent).toEqual([expect.objectContaining({ type: 'board.move', column: 'change' })])
  })
})
