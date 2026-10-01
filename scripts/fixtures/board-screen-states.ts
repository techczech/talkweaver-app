// Real worker board states for the big-screen gate (scripts/poll-board-screen.test.mjs). Run with bun:
//   bun scripts/fixtures/board-screen-states.ts <definition.json>
// The definition is the compiled board's own poll definition (its pollId, slideId and column ids), so
// the states carry the same ids as the deck they are shown on. Every state is produced by the worker's
// own code (acceptCard, applyBoardOperation, pollStateFor); nothing here writes the wire shape by hand.
import { readFileSync } from 'node:fs'
import { acceptCard, applyBoardOperation, ensureBoard, type CardSubmission } from '../../worker/board-state'
import type { PresenterBoardMessage } from '../../worker/board-protocol'
import { parsePollDefinition } from '../../worker/protocol'
import { closePoll, createSession, openPoll, pollStateFor, type StoredLiveSession } from '../../worker/session-state'

const compiled = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const settings = { ...(compiled.board ?? {}), names: true }
const definition = parsePollDefinition({ ...compiled, slideId: compiled.slideId ?? 'slide-board', visibility: 'live', board: settings })
if (!definition) throw new Error('the compiled board definition must parse')
const COLUMNS: string[] = definition.options.map((option) => option.optionId)

// Cards of the length a room writes (about 25 to 70 characters), by column.
const TEXTS = [
  ['More time for hands-on work', 'The live demo of the expenses form', 'Examples from real university work', 'The comparison of the tools',
    'Being able to ask on the phone', 'The pace of the first half', 'Honest about what does not work yet', 'Real prompts on the slides',
    'Small tables for discussion', 'The handout with every link', 'Short breaks between the parts', 'Working in pairs on a real task'],
  ['Shorter breaks', 'Less theory at the start', 'Send the links before the session, not after', 'Earlier start, later lunch',
    'Less jargon', 'More on data protection', 'Microphone for questions', 'Fewer slides on model names',
    'A bigger room, it was too warm', 'Start with what we can use tomorrow', 'A clearer split of the two halves', 'Say who the session is for'],
  ['Try pair work', 'A follow-up session in a month', 'Invite someone from IT security', 'Try it live with our own email',
    'A short reading list', 'An agent clinic in office hours', 'Let us try an agent on our own files', 'A shared channel for questions afterwards',
    'Bring a real task to work on', 'A monthly show and tell', 'Record the demo part', 'Ask the team what they would automate'],
]

interface Built { session: StoredLiveSession; add(column: number, n: number, name?: string): string }

function build(): Built {
  const session = createSession({ sessionId: 'session-board', shortId: 'abcd', talkSlug: 'talk', createdAt: 0, expiresAt: 60_000 })
  openPoll(session, definition!)
  let counter = 0
  return {
    session,
    add(column, n, name) {
      const text = TEXTS[column % 3][n % TEXTS[column % 3].length] + (n >= TEXTS[column % 3].length ? ` (${Math.floor(n / TEXTS[column % 3].length) + 1})` : '')
      const submission: CardSubmission = { kind: 'card.add', submissionId: `s-${++counter}`,
        input: { pollId: definition!.pollId, column: COLUMNS[column], text, ...(name ? { name } : {}) } }
      const outcome = acceptCard(ensureBoard(session, session.polls[definition!.pollId]), session.polls[definition!.pollId], `participant-${counter}`, submission, 1_000 + counter)
      if (outcome.ack.status !== 'confirmed') throw new Error(`fixture card refused: ${outcome.ack.error}`)
      return outcome.ack.cardId!
    },
  }
}

const op = (b: Built, action: Record<string, unknown>) =>
  applyBoardOperation(ensureBoard(b.session, b.session.polls[definition!.pollId]), b.session.polls[definition!.pollId], { pollId: definition!.pollId, ...action } as PresenterBoardMessage)

// Fill columns to the given counts (cards), merging `pairs` pairs into groups (a group counts once).
function fill(counts: number[], groupsPerColumn: number[] = [0, 0, 0], names = false): Built {
  const b = build()
  const ids: string[][] = [[], [], []]
  // Cards arrive round-robin across the columns, as they do in a room (the oldest ones fill the screen).
  for (let n = 0; n < Math.max(...counts); n++) {
    counts.forEach((count, column) => { if (n < count) ids[column].push(b.add(column, n, names ? `Person ${column}-${n}` : undefined)) })
  }
  groupsPerColumn.forEach((groups, column) => {
    for (let g = 0; g < groups; g++) {
      // Merge the newest card of the group onto its neighbour, and a third onto the first pair for one group.
      const [source, target] = [ids[column][g * 3 + 1], ids[column][g * 3]]
      op(b, { type: 'board.merge', source: { cardId: source }, target: { cardId: target } })
      if (g === 0) op(b, { type: 'board.merge', source: { cardId: ids[column][g * 3 + 2] }, target: { cardId: target } })
    }
  })
  return b
}

const states = (b: Built) => ({
  presenter: pollStateFor(b.session, b.session.polls[definition!.pollId], 'presenter'),
  audience: pollStateFor(b.session, b.session.polls[definition!.pollId], 'audience'),
})

const out: Record<string, unknown> = {}

// 6 cards, no groups.
out.six = states(fill([2, 2, 2]))

// 24 entries at the default limit: 30 cards, 3 groups of three cards and 15 singles.
{
  const b = fill([11, 10, 9], [1, 1, 1])
  out.twentyFour = states(b)
}

// 40 entries released with "Show all": 49 cards; each column holds a group of three and a group of two.
{
  const b = fill([17, 16, 16], [2, 2, 2])
  op(b, { type: 'board.release', mode: 'all' })
  out.forty = states(b)
}

// 61 cards at the limit of 24: the rest wait, "+ n more on your phone".
{
  const b = fill([25, 19, 17], [2, 2, 2])
  out.overLimit = states(b)
}

// A hidden card, names on the board: what must never reach a screen.
{
  const b = fill([4, 3, 3], [0, 0, 0], true)
  op(b, { type: 'board.hide', target: { cardId: 'card-1' }, hidden: true })
  // A group whose first card is hidden: the screen shows the first VISIBLE card's text.
  const first = b.add(1, 5, 'Secret Sam'), second = b.add(1, 6, 'Other Person')
  op(b, { type: 'board.merge', source: { cardId: second }, target: { cardId: first } })
  op(b, { type: 'board.hide', target: { cardId: first }, hidden: true })
  out.hidden = { ...states(b), hiddenText: TEXTS[0][0], hiddenGroupFirst: TEXTS[1][5] }
}

// Empty, closed (with cards) and frozen.
out.empty = states(build())
{
  const b = fill([3, 2, 2], [1, 0, 0])
  closePoll(b.session, definition.pollId)
  out.closed = states(b)
}
{
  const b = fill([3, 2, 2], [1, 0, 0])
  op(b, { type: 'board.freeze', frozen: true })
  out.frozen = states(b)
}
console.log(JSON.stringify(out))
