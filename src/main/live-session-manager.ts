import { createLivePresenterClient, isTerminalLiveStatus, type LiveStatus } from './live-presenter-client'
import type { AudienceQuestion, InstantSlide, PollStateMessage, PresenterAudienceMessage, PresenterBoardMessage, PresenterInstantMessage, PresenterPollMessage, ReactionCounts, ReactionRecord, SlideState } from '../../worker/protocol'
import type { SessionRecoveryRecord } from './live-session-store'
import type { LiveAudienceFeedback } from './live-session-history'
import { runInstantSlideFrom } from './runs'

const instantKey = (slide: InstantSlide): string => `${slide.kind}-${slide.shownAt}`
/** A final-history error the worker will never get past (HTTP 401 or 404): not retried. */
const isHistoryGone = (error: unknown): boolean => !!error && typeof error === 'object' && (error as { final?: unknown }).final === true
/** Reactions and questions are written to the Run at most once per this interval while they arrive. */
export const FEEDBACK_FLUSH_MS = 1500

type Client = Pick<ReturnType<typeof createLivePresenterClient>, 'disconnect' | 'reconnect' | 'publish' | 'sendPoll'>
interface Runtime {
  record: SessionRecoveryRecord
  windowId: number | null
  client: Client | null
  endTimer?: ReturnType<typeof setTimeout>
  historyTimer?: ReturnType<typeof setTimeout>
  /** Trailing flush for reactions and questions (at most one write per 1.5 s while they arrive). */
  feedbackTimer?: ReturnType<typeof setTimeout>
  recoverTimer?: ReturnType<typeof setTimeout>
  /** True once memory holds the ended session's whole history (after its final recovery). */
  finalRecovered: boolean
  recovering: boolean
  endAttempt: number
  ending: boolean
  venueScreens: number
  // Reactions and questions from phones (ADR-0027): live, kept here for the presenter window and
  // rebuilt from the worker's snapshot after any reconnect. The Run keeps its own copy (ticket 06):
  // every reaction record, in sequence, and the questions, flushed from here. Neither is written to
  // the recovery record; after a restart the worker replays them.
  reactionCounts: Record<string, ReactionCounts>
  questions: AudienceQuestion[]
  reactionRecords: ReactionRecord[]
}
export function createLiveSessionManager(deps: {
  load(): SessionRecoveryRecord[]
  save(records: SessionRecoveryRecord[]): void
  createClient?: (options: Parameters<typeof createLivePresenterClient>[0]) => Client
  endRemote(record: SessionRecoveryRecord): Promise<'ended' | 'expired'>
  /**
   * The session's final history once it has ended. `afterReactionSequence` is the last reaction
   * record already held; the reactions and questions returned stay in memory, like the live ones.
   */
  recoverFinal?(record: SessionRecoveryRecord, afterReactionSequence: number): Promise<Pick<SessionRecoveryRecord, 'polls' | 'voteRecords' | 'cursor'>
    & { reactionRecords?: ReactionRecord[]; questions?: AudienceQuestion[]; lateBoards?: Record<string, number>; endedAt?: number
      closedBoards?: Record<string, { at: number; reason: 'expired' | 'closed' | 'superseded' }> }>
  /** "Close it now" for boards left open after End live (feedback-boards ticket 06). */
  closeBoards?(record: SessionRecoveryRecord): Promise<void>
  probe(record: SessionRecoveryRecord): Promise<LiveStatus | null>
  notify(windowId: number, channel: string, value: unknown): void
  flushHistory(record: SessionRecoveryRecord, feedback: LiveAudienceFeedback): boolean
  diagnostic?(event: { sessionId: string; event: string; attempt?: number; code?: number; clean?: boolean }): void
  schedule?: typeof setTimeout
  cancelSchedule?: typeof clearTimeout
  now?: () => number
}) {
  const sessions = new Map<string, Runtime>()
  const windows = new Map<number, string>()
  const schedule = deps.schedule ?? setTimeout
  const cancelSchedule = deps.cancelSchedule ?? clearTimeout
  const now = deps.now ?? Date.now
  let stopped = false
  for (const record of deps.load()) sessions.set(record.sessionId, { record, windowId: null, client: null, endAttempt: 0, ending: false, venueScreens: 0, reactionCounts: {}, questions: [], reactionRecords: [], finalRecovered: false, recovering: false })

  function commit(runtime: Runtime, patch: Partial<SessionRecoveryRecord>) {
    const record = { ...runtime.record, ...patch }
    deps.save([...sessions.values()].map((item) => item === runtime ? record : item.record))
    runtime.record = record
  }
  function notify(runtime: Runtime, channel: string, value: unknown) {
    if (runtime.windowId !== null) deps.notify(runtime.windowId, channel, value)
  }
  // Writes the session's history onto its Run. `soon` (reactions and questions, which can arrive
  // many a second) waits up to 1.5 s and writes everything that arrived meanwhile in one go; every
  // other caller (terminal status, detach, bindRun, the end, a recording save) writes at once.
  // `historyPending` on the recovery record (content-free) says an ended session's reactions and
  // questions may not be on the Run yet; it is cleared only by a write made after the final recovery.
  function history(runtime: Runtime, when: 'now' | 'soon' = 'now') {
    if (!runtime.record.runId || stopped) return
    if (when === 'soon') {
      runtime.feedbackTimer ??= schedule(() => { runtime.feedbackTimer = undefined; history(runtime) }, FEEDBACK_FLUSH_MS)
      return
    }
    if (runtime.feedbackTimer !== undefined) cancelSchedule(runtime.feedbackTimer)
    runtime.feedbackTimer = undefined
    let written = false
    try { written = deps.flushHistory(runtime.record, { reactionRecords: runtime.reactionRecords, questions: runtime.questions }) } catch {}
    if (written) {
      if (runtime.historyTimer !== undefined) cancelSchedule(runtime.historyTimer)
      runtime.historyTimer = undefined
      if (runtime.record.historyPending && runtime.finalRecovered) commit(runtime, { historyPending: false })
      return
    }
    if (runtime.historyTimer !== undefined) return
    deps.diagnostic?.({ sessionId: runtime.record.sessionId, event: 'history-write-pending' })
    runtime.historyTimer = schedule(() => { runtime.historyTimer = undefined; history(runtime) }, 30_000)
  }
  // Ticket 07: every instant slide shown is kept with the slide it followed, then flushed to the Run.
  // The slide it followed is the presenter's slide at the moment of the show (captured in poll()
  // when instant.show is sent, and kept durably in `instantAnchors`), never the slide the presenter
  // has reached by the time the server confirms it. Confirmation, the server's instant.state echo
  // and a recovery snapshot may all report the same show; its `<kind>-<shownAt>` id records it once.
  // A show this presenter did not send (no captured anchor) falls back to the current slide.
  function recordInstant(runtime: Runtime, slide: InstantSlide | null | undefined) {
    if (!slide) return
    const id = instantKey(slide)
    const captured = runtime.record.instantAnchors
    const anchor = captured && Object.prototype.hasOwnProperty.call(captured, id) ? captured[id] : runtime.record.latest?.slideId ?? null
    const entry = runInstantSlideFrom(slide, anchor)
    const list = runtime.record.instantHistory ?? []
    if (list.some((item) => item.id === entry.id)) return
    commit(runtime, { instantHistory: [...list, entry] })
    history(runtime)
  }
  const reactionCursor = (runtime: Runtime) => runtime.reactionRecords.at(-1)?.sequence ?? 0
  function receiveReactionRecords(runtime: Runtime, records: ReactionRecord[]) {
    const fresh = records.filter((item, i) => item.sequence > reactionCursor(runtime) && records.findIndex((other) => other.sequence === item.sequence) === i)
      .sort((a, b) => a.sequence - b.sequence)
    if (!fresh.length) return
    runtime.reactionRecords = [...runtime.reactionRecords, ...fresh]
    history(runtime, 'soon')
  }
  function receiveQuestions(runtime: Runtime, questions: AudienceQuestion[]) {
    const changed = JSON.stringify(questions) !== JSON.stringify(runtime.questions)
    runtime.questions = questions
    if (changed) history(runtime, 'soon')
  }
  // A final recovery's history, committed: polls and answers, reactions and questions, and where the
  // boards left open stand. `ended`: this recovery follows End live itself, so the boards it names
  // open are the ones kept open; later recoveries only learn which of them have closed since.
  type Recovered = Awaited<ReturnType<NonNullable<typeof deps.recoverFinal>>>
  function applyRecovered(runtime: Runtime, recovered: Recovered, ended: boolean) {
    const { reactionRecords, questions, lateBoards, endedAt, closedBoards, ...final } = recovered
    const patch: Partial<SessionRecoveryRecord> = { ...final }
    if (ended || runtime.record.endedAtMs === undefined) patch.endedAtMs = endedAt ?? runtime.record.endedAtMs ?? now()
    if (ended && lateBoards && Object.keys(lateBoards).length) patch.boardsLeftOpen = { ...runtime.record.boardsLeftOpen, ...lateBoards }
    const leftOpen = patch.boardsLeftOpen ?? runtime.record.boardsLeftOpen
    if (leftOpen && !ended) {
      const stillOpen = lateBoards ?? {}
      const closed = { ...runtime.record.boardsClosedAt }
      const reasons = { ...runtime.record.boardsClosedReason }
      for (const pollId of Object.keys(leftOpen)) {
        if (pollId in stillOpen || closed[pollId] !== undefined) continue
        const told = closedBoards?.[pollId]
        closed[pollId] = told?.at ?? now()
        if (told) reasons[pollId] = told.reason
      }
      patch.boardsClosedAt = closed
      if (Object.keys(reasons).length) patch.boardsClosedReason = reasons
      patch.boardsRefreshedAt = now()
    }
    commit(runtime, patch)
    if (reactionRecords) receiveReactionRecords(runtime, reactionRecords)
    if (questions) receiveQuestions(runtime, questions)
  }
  // After a restart (or when its Run is saved) an ended session whose history is still pending
  // fetches its final history again — the worker keeps serving it after the session has ended —
  // and then writes it. A failed fetch is retried in 30 s.
  async function recoverPending(runtime: Runtime): Promise<void> {
    if (stopped || runtime.recovering || !runtime.record.runId) return
    if (!deps.recoverFinal) { runtime.finalRecovered = true; history(runtime); return }
    runtime.recovering = true
    try {
      const recovered = await deps.recoverFinal(runtime.record, reactionCursor(runtime))
      if (stopped) return
      applyRecovered(runtime, recovered, runtime.record.endedAtMs === undefined)
      runtime.finalRecovered = true
      history(runtime)
    } catch (error) {
      if (stopped) return
      if (isHistoryGone(error)) {
        // The worker will never serve it (401/404): stop asking, on this launch and every later one.
        deps.diagnostic?.({ sessionId: runtime.record.sessionId, event: 'history-recovery-gone', code: (error as { status?: number }).status })
        runtime.finalRecovered = true
        commit(runtime, { historyPending: false })
        return
      }
      if (runtime.recoverTimer === undefined) {
        deps.diagnostic?.({ sessionId: runtime.record.sessionId, event: 'history-recovery-pending' })
        runtime.recoverTimer = schedule(() => { runtime.recoverTimer = undefined; void recoverPending(runtime) }, 30_000)
      }
    } finally { runtime.recovering = false }
  }
  // Pull one ended session's boards left open from the worker and write them onto its Run. False when
  // the worker could not be reached; a worker that will never serve the session again closes them.
  async function pullBoards(runtime: Runtime): Promise<boolean> {
    if (!deps.recoverFinal) return false
    try {
      applyRecovered(runtime, await deps.recoverFinal(runtime.record, reactionCursor(runtime)), false)
      history(runtime)
      return true
    } catch (cause) {
      if (!isHistoryGone(cause)) return false
      const closed = { ...runtime.record.boardsClosedAt }
      for (const pollId of Object.keys(runtime.record.boardsLeftOpen ?? {})) closed[pollId] ??= now()
      commit(runtime, { boardsClosedAt: closed })
      history(runtime)
      return true
    }
  }
  /** Boards this session left open whose closing the app has not learned yet. */
  const awaitsBoards = (runtime: Runtime) => Object.keys(runtime.record.boardsLeftOpen ?? {})
    .some((pollId) => runtime.record.boardsClosedAt?.[pollId] === undefined)
  const pendingAfterEnd = (runtime: Runtime) => runtime.record.historyPending === true && !runtime.finalRecovered
    && (runtime.record.status === 'ended' || runtime.record.status === 'expired')
  function status(runtime: Runtime, value: LiveStatus) {
    if (value === 'ended' || value === 'expired') {
      commit(runtime, { endRequested: true, status: 'ending', pending: [] })
      notify(runtime, 'live:status', 'ending')
      void tryEnd(runtime)
      return
    }
    commit(runtime, { status: value })
    notify(runtime, 'live:status', value)
    if (isTerminalLiveStatus(value)) history(runtime)
  }
  function runtimeForWindow(id: number) {
    const sessionId = windows.get(id)
    return sessionId ? sessions.get(sessionId) : undefined
  }
  function connect(runtime: Runtime) {
    if (stopped || runtime.client || runtime.record.endRequested) return
    if (runtime.record.expiresAt <= now()) { status(runtime, 'expired'); return }
    if (isTerminalLiveStatus(runtime.record.status)) return
    const record = runtime.record
    runtime.client = (deps.createClient ?? createLivePresenterClient)({
      baseUrl: record.baseUrl, sessionId: record.sessionId, presenterToken: record.presenterToken,
      latest: record.latest, pending: record.pending, afterSequence: record.cursor, afterReactionSequence: reactionCursor(runtime),
      probe: () => deps.probe(runtime.record),
      onStatus: (value) => status(runtime, value),
      onPendingChange: (pending) => commit(runtime, { pending }),
      onCursorChange: (cursor) => commit(runtime, { cursor }),
      onPollState: (message) => {
        const previous = runtime.record.polls.find((poll) => poll.pollId === message.pollId)
        if (JSON.stringify(previous) !== JSON.stringify(message)) {
          commit(runtime, { polls: [...runtime.record.polls.filter((poll) => poll.pollId !== message.pollId), message] })
          history(runtime)
        }
        notify(runtime, 'live:poll-state', message)
      },
      onSnapshot: (snapshot) => {
        commit(runtime, { polls: snapshot.polls, instantSlide: snapshot.instantSlide ?? null, expiresAt: snapshot.expiresAt })
        recordInstant(runtime, snapshot.instantSlide)
        history(runtime)
      },
      onPresence: (presence) => {
        runtime.venueScreens = presence.venueScreens
        notify(runtime, 'live:presence', presence)
      },
      onReactionSnapshot: (counts) => {
        runtime.reactionCounts = counts
        notify(runtime, 'live:audience', { kind: 'snapshot', reactionCounts: runtime.reactionCounts, questions: runtime.questions })
      },
      onReactionCounts: (slideId, counts) => {
        runtime.reactionCounts = { ...runtime.reactionCounts, [slideId]: counts }
        notify(runtime, 'live:audience', { kind: 'reaction', slideId, counts })
      },
      onQuestions: (questions) => {
        receiveQuestions(runtime, questions)
        notify(runtime, 'live:audience', { kind: 'questions', questions })
      },
      onReactionRecords: (records) => receiveReactionRecords(runtime, records),
      onInstantSlide: (slide) => { commit(runtime, { instantSlide: slide }); recordInstant(runtime, slide); notify(runtime, 'live:instant-state', slide) },
      onPollVoteRecord: (vote) => {
        if (runtime.record.voteRecords.some((record) => record.sequence === vote.sequence)) return
        commit(runtime, { voteRecords: [...runtime.record.voteRecords, vote] })
        history(runtime)
      },
      onOperation: (operation) => {
        if (operation.status === 'confirmed' && (operation.message.type === 'instant.show' || operation.message.type === 'instant.clear')) {
          const slide = operation.message.type === 'instant.show' ? operation.message.slide : null
          commit(runtime, { instantSlide: slide })
          recordInstant(runtime, slide)
          notify(runtime, 'live:instant-state', slide)
        }
        notify(runtime, 'live:poll-operation', operation)
      },
      onDiagnostic: (event) => deps.diagnostic?.({ sessionId: record.sessionId, ...event }),
    })
  }
  async function tryEnd(runtime: Runtime): Promise<void> {
    if (stopped || runtime.ending || !runtime.record.endRequested || runtime.record.status === 'ended' || runtime.record.status === 'expired') return
    runtime.ending = true
    try {
      const outcome = runtime.record.expiresAt <= now() ? 'expired' : await deps.endRemote(runtime.record)
      if (deps.recoverFinal) {
        try {
          applyRecovered(runtime, await deps.recoverFinal(runtime.record, reactionCursor(runtime)), true)
        } catch (error) {
          // 401/404 is final: end with what the live session delivered instead of retrying forever.
          if (!isHistoryGone(error)) throw error
          deps.diagnostic?.({ sessionId: runtime.record.sessionId, event: 'history-recovery-gone', code: (error as { status?: number }).status })
        }
      }
      runtime.finalRecovered = true
      commit(runtime, { status: outcome, historyPending: true, ...(runtime.record.endedAtMs === undefined ? { endedAtMs: now() } : {}) })
      notify(runtime, 'live:status', outcome)
      history(runtime)
      if (runtime.endTimer !== undefined) cancelSchedule(runtime.endTimer)
      runtime.endTimer = undefined
    } catch {
      if (!stopped) {
        deps.diagnostic?.({ sessionId: runtime.record.sessionId, event: 'end-awaiting-confirmation' })
        runtime.endTimer = schedule(() => { runtime.endTimer = undefined; void tryEnd(runtime) },
          Math.min(8000, 750 * (2 ** Math.min(runtime.endAttempt++, 5))))
      }
    } finally { runtime.ending = false }
  }
  function detach(id: number) {
    const runtime = runtimeForWindow(id)
    windows.delete(id)
    if (runtime?.windowId === id) { runtime.windowId = null; history(runtime) }
  }
  function attachRuntime(runtime: Runtime, windowId: number) {
    if (runtime.windowId !== null && runtime.windowId !== windowId) windows.delete(runtime.windowId)
    runtime.windowId = windowId
    windows.set(windowId, runtime.record.sessionId)
    connect(runtime)
    return runtime.record
  }
  return {
    restore() {
      for (const runtime of sessions.values()) {
        if (pendingAfterEnd(runtime)) { void recoverPending(runtime); continue }
        if (runtime.record.endRequested) void tryEnd(runtime)
        else connect(runtime)
        history(runtime)
      }
    },
    create(record: SessionRecoveryRecord, windowId: number) {
      if (sessions.has(record.sessionId)) throw new Error('Live session already exists.')
      deps.save([...sessions.values()].map((item) => item.record).concat(record))
      const runtime: Runtime = { record, windowId: null, client: null, endAttempt: 0, ending: false, venueScreens: 0, reactionCounts: {}, questions: [], reactionRecords: [], finalRecovered: false, recovering: false }
      sessions.set(record.sessionId, runtime)
      // The worker closed this talk's boards left open by an earlier session when this one took the
      // join link (reason "superseded"); pull that into their Runs at once, so History says so.
      for (const other of sessions.values()) {
        if (other !== runtime && other.record.talkSlug === record.talkSlug && other.record.vaultRoot === record.vaultRoot && awaitsBoards(other)) void pullBoards(other)
      }
      return attachRuntime(runtime, windowId)
    },
    attach(windowId: number, talkSlug: string, vaultRoot: string | null) {
      const current = runtimeForWindow(windowId)
      if (current) return current.record
      const runtime = [...sessions.values()].reverse().find(({ record }) =>
        record.talkSlug === talkSlug && record.vaultRoot === vaultRoot
        && record.expiresAt > now() && record.status !== 'ended' && record.status !== 'expired')
      return runtime && runtime.windowId === null ? attachRuntime(runtime, windowId) : null
    },
    inUse(talkSlug: string, vaultRoot: string | null, windowId: number) {
      return [...sessions.values()].some((runtime) => runtime.windowId !== null && runtime.windowId !== windowId
        && runtime.record.talkSlug === talkSlug && runtime.record.vaultRoot === vaultRoot
        && !isTerminalLiveStatus(runtime.record.status))
    },
    snapshot(windowId: number) {
      const runtime = runtimeForWindow(windowId)
      const record = runtime?.record
      if (!record) return null
      return { status: record.status, shortUrl: record.shortUrl, qrSvg: record.qrSvg,
        venueScreens: runtime.venueScreens,
        polls: structuredClone(record.polls), expiresAt: record.expiresAt,
        instantSlide: record.instantSlide ?? null,
        reactionCounts: structuredClone(runtime.reactionCounts), questions: structuredClone(runtime.questions),
        pending: structuredClone(record.pending) }
    },
    record(windowId: number) { return runtimeForWindow(windowId)?.record ?? null },
    bindRun(windowId: number, reference: { talkSlug: string; runId: string } | null) {
      const runtime = runtimeForWindow(windowId)
      if (!runtime || !reference || reference.talkSlug !== runtime.record.talkSlug) return
      if (!runtime.record.runId) commit(runtime, { runId: reference.runId })
      history(runtime)
    },
    publish(windowId: number, slide: SlideState) {
      const runtime = runtimeForWindow(windowId)
      if (!runtime || runtime.record.endRequested || isTerminalLiveStatus(runtime.record.status)) return
      commit(runtime, { latest: slide })
      runtime.client?.publish(slide.slideId, slide.reveal, slide.focus, slide.lightbox, slide.talkQr === true)
    },
    poll(windowId: number, action: PresenterPollMessage | PresenterInstantMessage | PresenterAudienceMessage | PresenterBoardMessage) {
      const runtime = runtimeForWindow(windowId)
      if (!runtime || runtime.record.endRequested || isTerminalLiveStatus(runtime.record.status)) return { success: false, error: 'Live session is not accepting controls.' }
      if (action.type === 'instant.show' && runtime.client) {
        // The slide this instant slide follows is the one on screen NOW, as it is shown.
        commit(runtime, { instantAnchors: { ...(runtime.record.instantAnchors ?? {}), [instantKey(action.slide)]: runtime.record.latest?.slideId ?? null } })
      }
      const operationId = runtime.client?.sendPoll(action)
      return operationId ? { success: true, operationId, status: 'pending' as const } : { success: false, error: 'Live control could not be queued.' }
    },
    /** The boards still open in this window's session: End live asks whether to keep them open. */
    openBoards(windowId: number): Array<{ pollId: string; question: string; cards: number }> {
      const record = runtimeForWindow(windowId)?.record
      if (!record || isTerminalLiveStatus(record.status) || record.endRequested) return []
      return record.polls.filter((poll) => poll.pollType === 'board' && poll.open)
        .map((poll) => ({ pollId: poll.pollId, question: poll.question, cards: poll.boardState?.cardCount ?? 0 }))
    },
    /**
     * History's "Refresh from the board" and Re-check live (feedback-boards ticket 06): pull the
     * boards of the sessions bound to this Run from the worker — late cards on a board left open, or
     * the last cards of one that has closed by itself since — and write them onto the Run.
     */
    async refreshBoards(talkSlug: string, runId: string): Promise<{ refreshed: number; error?: string }> {
      const bound = [...sessions.values()].filter((runtime) => runtime.record.talkSlug === talkSlug && runtime.record.runId === runId
        && runtime.record.boardsLeftOpen && Object.keys(runtime.record.boardsLeftOpen).length)
      if (!bound.length) return { refreshed: 0, error: 'This board was not left open from this computer, so it cannot be refreshed here.' }
      if (!deps.recoverFinal) return { refreshed: 0, error: 'The live service is not available.' }
      let refreshed = 0
      let error: string | undefined
      for (const runtime of bound) {
        // Each session's pull replaces only that session's board on the Run (boards are keyed by poll and session).
        if (await pullBoards(runtime)) refreshed += 1
        else error = 'The board could not be reached. Check the connection and try again.'
      }
      return error ? { refreshed, error } : { refreshed }
    },
    /** History's "Close it now": the worker closes the boards left open; then their last cards are pulled. */
    async closeBoards(talkSlug: string, runId: string): Promise<{ refreshed: number; error?: string }> {
      const bound = [...sessions.values()].filter((runtime) => runtime.record.talkSlug === talkSlug && runtime.record.runId === runId
        && runtime.record.boardsLeftOpen && Object.keys(runtime.record.boardsLeftOpen).length)
      if (!bound.length || !deps.closeBoards) return { refreshed: 0, error: 'This board was not left open from this computer, so it cannot be closed here.' }
      try {
        for (const runtime of bound) await deps.closeBoards(runtime.record)
      } catch (cause) {
        return { refreshed: 0, error: cause instanceof Error ? cause.message : 'The board could not be closed. Try again.' }
      }
      return this.refreshBoards(talkSlug, runId)
    },
    async end(windowId: number, options: { keepBoardsOpen?: boolean } = {}) {
      const runtime = runtimeForWindow(windowId)
      if (!runtime) return { success: true, status: 'ended' as LiveStatus }
      commit(runtime, { endRequested: true, status: 'ending', pending: [], ...(options.keepBoardsOpen ? { keepBoardsOpen: true } : {}) })
      runtime.client?.disconnect(); runtime.client = null
      notify(runtime, 'live:status', 'ending')
      await tryEnd(runtime)
      return { success: true, status: runtime.record.status }
    },
    detach,
    /** A Run was saved (recording.ts): sessions bound to it write their history at once. */
    runSaved(talkSlug: string, runId: string) {
      for (const runtime of sessions.values()) {
        if (runtime.record.talkSlug !== talkSlug || runtime.record.runId !== runId) continue
        if (pendingAfterEnd(runtime)) void recoverPending(runtime)
        else history(runtime)
      }
    },
    reconnect() {
      for (const runtime of sessions.values()) {
        if (runtime.record.endRequested) void tryEnd(runtime)
        else runtime.client?.reconnect()
      }
    },
    shutdown() {
      // Reactions and questions waiting for their trailing write are written now.
      for (const runtime of sessions.values()) if (runtime.feedbackTimer !== undefined) history(runtime)
      stopped = true
      for (const runtime of sessions.values()) {
        runtime.client?.disconnect()
        if (runtime.endTimer !== undefined) cancelSchedule(runtime.endTimer)
        if (runtime.historyTimer !== undefined) cancelSchedule(runtime.historyTimer)
        if (runtime.recoverTimer !== undefined) cancelSchedule(runtime.recoverTimer)
      }
    },
  }
}
