// A stand-in for the live worker, for looking at the audience page locally. It keeps one session's
// state (slide, polls, board, instant slide) and speaks the audience side of worker/protocol.ts and
// worker/recovery-protocol.ts: discovery (GET /session/<slug>), capabilities, and the audience socket
// messages (session.hello / sync / snapshot / ping / pong, vote.submit, reaction.send, question.submit,
// card.add and their acks, plus slide.state, poll.state, instant.state, session.closed pushes).
// No I/O here: `connect(send)` registers an audience socket, `handle(socket, raw)` answers its messages,
// and the control methods push state to every connected socket. The server wiring is in
// scripts/local-handout-preview.mjs.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The worker build the page's reaction check expects, read from the worker's own source of truth. */
export function liveWorkerBuild() {
  const match = /LIVE_WORKER_BUILD\s*=\s*'([^']+)'/.exec(readFileSync(join(REPO, 'worker/recovery-protocol.ts'), 'utf8'))
  return match ? match[1] : 'unknown'
}

export const SAMPLE_POLL = {
  pollId: 'poll-sample', pollType: 'single', question: 'Which of these would you call an agent?',
  options: [
    { optionId: 'o1', label: 'A chatbot that answers questions' },
    { optionId: 'o2', label: 'A tool that does the steps for you' },
    { optionId: 'o3', label: 'A script that runs on a schedule' },
  ],
}

function boardState(cards = []) {
  const columns = ['keep', 'change', 'try']
  return {
    frozen: false, limit: 24, release: { extra: 0, all: false, groupsOnly: false, columns: {} },
    cards, groups: [],
    columns: columns.map((columnId) => ({ columnId, onScreen: cards.filter((c) => c.column === columnId).map((c) => ({ cardId: c.cardId })), waiting: 0, cards: cards.filter((c) => c.column === columnId).length })),
    entries: cards.length, shown: cards.length, waiting: 0, cardCount: cards.length,
  }
}

export function createLiveStub({ slug, slideIds, poll = SAMPLE_POLL, build = liveWorkerBuild(), now = () => Date.now() }) {
  const sessionId = 'local-session-1'
  const sockets = new Set()
  let live = false
  let revision = 0
  let slideIndex = 0
  let instant = null
  let pollRuns = 0
  const polls = new Map() // pollId -> poll.state message
  const log = []
  const note = (line) => { log.push(`${new Date(now()).toISOString().slice(11, 19)} ${line}`); if (log.length > 40) log.shift() }

  const slideState = () => ({ type: 'slide.state', slideId: slideIds[slideIndex] ?? slideIds[0], reveal: 0, focus: null, revision })
  const broadcast = (message) => { for (const send of sockets) send(JSON.stringify(message)) }
  const pollMessage = (def, extra = {}) => ({
    type: 'poll.state', pollId: def.pollId, slideId: slideIds[slideIndex], pollType: def.pollType, question: def.question,
    options: def.options, visibility: 'live', open: true, revealed: false, ...(def.board ? { board: def.board } : {}), ...extra,
  })
  const snapshot = (syncId) => ({
    type: 'session.snapshot', protocol: 2, sessionId, syncId, expiresAt: now() + 6 * 3600_000,
    slideState: slideState(), instantSlide: instant, polls: [...polls.values()], receipts: [],
    presence: { presenterConnected: true, venueScreens: 0 }, switches: { questionsAllowed: true, reactionsAllowed: true },
  })

  // A choice vote adds to the poll's tallies and the new poll.state goes to every page, as the worker does for live polls.
  function countVote(pollId, choice) {
    const current = polls.get(pollId)
    if (!current || (typeof choice !== 'string' && !Array.isArray(choice))) return
    const tallies = { ...(current.tallies ?? {}) }
    for (const id of [choice].flat()) tallies[id] = (tallies[id] ?? 0) + 1
    polls.set(pollId, { ...current, tallies, responseCount: (current.responseCount ?? 0) + 1 })
    broadcast(polls.get(pollId))
  }

  function ack(type, message, extra = {}) {
    return { type, submissionId: message.submissionId, status: 'confirmed', ...extra }
  }

  return {
    sessionId,
    isLive: () => live,
    state: () => ({ live, slideIndex, slideCount: slideIds.length, slideId: slideIds[slideIndex], polls: [...polls.values()].map((p) => ({ pollId: p.pollId, open: p.open })), instant, sockets: sockets.size, log: [...log] }),

    discovery: () => (live ? { live: true, sessionId, protocol: 2 } : { live: false }),
    capabilities: () => ({ protocol: 2, build }),

    connect(send) {
      sockets.add(send)
      send(JSON.stringify({ type: 'session.hello', protocol: 2, expiresAt: now() + 6 * 3600_000 }))
      return () => sockets.delete(send)
    },
    /** One audience message in, the replies out (also returned, for tests). */
    handle(send, raw) {
      let m
      try { m = JSON.parse(String(raw)) } catch { return [] }
      const replies = []
      if (m?.type === 'session.ping') replies.push({ type: 'session.pong', nonce: m.nonce })
      else if (m?.type === 'session.sync') replies.push(snapshot(m.syncId))
      else if (m?.type === 'vote.submit') {
        note(`vote ${m.pollId} ${JSON.stringify(m.choice)}`)
        replies.push({ type: 'vote.ack', submissionId: m.submissionId, pollId: m.pollId, status: 'confirmed', choice: m.choice })
        countVote(m.pollId, m.choice)
      } else if (m?.type === 'reaction.send') { note(`reaction ${m.reaction}`); replies.push(ack('reaction.ack', m)) }
      else if (m?.type === 'question.submit') { note(`question "${m.text}"`); replies.push(ack('question.ack', m)) }
      else if (m?.type === 'card.add') { note(`card "${m.text}"`); replies.push(ack('card.ack', m, { pollId: m.pollId, cardId: `card-${log.length}`, cardsUsed: 1 })) }
      for (const reply of replies) send(JSON.stringify(reply))
      return replies
    },

    startLive() {
      if (live) return
      live = true; revision++; note('live started')
    },
    endLive() {
      if (!live) return
      live = false; polls.clear(); instant = null; pollRuns = 0; slideIndex = 0; note('live ended')
      broadcast({ type: 'session.closed', reason: 'ended' })
    },
    goToSlide(delta) {
      slideIndex = Math.max(0, Math.min(slideIds.length - 1, slideIndex + delta))
      revision++; note(`slide ${slideIndex + 1}`)
      if (live) broadcast(slideState())
    },
    /** Opens the poll. Opening it again after a close is a new poll (a new id), so a page that answered the first sees a fresh one. */
    openPoll() {
      pollRuns++
      const def = pollRuns === 1 ? poll : { ...poll, pollId: `${poll.pollId}-${pollRuns}` }
      polls.set(def.pollId, pollMessage(def)); note('poll opened')
      if (live) broadcast(polls.get(def.pollId))
    },
    closePoll() {
      for (const [id, p] of polls) { polls.set(id, { ...p, open: false, revealed: true }); if (live) broadcast(polls.get(id)) }
      note('poll closed')
    },
    openBoard() {
      const def = {
        pollId: 'board-sample', pollType: 'board', question: 'What should we keep, change, try?',
        options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'change', label: 'Change' }, { optionId: 'try', label: 'Try' }],
        board: { limit: 24, cardChars: 140, cardsPerPhone: 5, names: false, closesAfterDays: 7, instructions: 'Add one idea per card.', example: 'More time to try things', hints: {} },
      }
      polls.set(def.pollId, pollMessage(def, { boardState: boardState() })); note('board opened')
      if (live) broadcast(polls.get(def.pollId))
    },
    showInstant({ text, link }) {
      instant = { kind: 'text', text: String(text || 'Back at 11:15'), ...(link ? { link: String(link) } : {}), shownAt: now() }
      note('instant slide shown')
      if (live) broadcast({ type: 'instant.state', slide: instant })
    },
    clearInstant() {
      instant = null; note('instant slide cleared')
      if (live) broadcast({ type: 'instant.state', slide: null })
    },
  }
}
