import { createLivePresenterClient, isTerminalLiveStatus, type LiveStatus } from './live-presenter-client'
import type { PollStateMessage, PresenterPollMessage, SlideState } from '../../worker/protocol'
import type { SessionRecoveryRecord } from './live-session-store'

type Client = Pick<ReturnType<typeof createLivePresenterClient>, 'disconnect' | 'reconnect' | 'publish' | 'sendPoll'>
interface Runtime {
  record: SessionRecoveryRecord
  windowId: number | null
  client: Client | null
  endTimer?: ReturnType<typeof setTimeout>
  historyTimer?: ReturnType<typeof setTimeout>
  endAttempt: number
  ending: boolean
}
export function createLiveSessionManager(deps: {
  load(): SessionRecoveryRecord[]
  save(records: SessionRecoveryRecord[]): void
  createClient?: (options: Parameters<typeof createLivePresenterClient>[0]) => Client
  endRemote(record: SessionRecoveryRecord): Promise<'ended' | 'expired'>
  recoverFinal?(record: SessionRecoveryRecord): Promise<Pick<SessionRecoveryRecord, 'polls' | 'voteRecords' | 'cursor'>>
  probe(record: SessionRecoveryRecord): Promise<LiveStatus | null>
  notify(windowId: number, channel: string, value: unknown): void
  flushHistory(record: SessionRecoveryRecord): boolean
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
  for (const record of deps.load()) sessions.set(record.sessionId, { record, windowId: null, client: null, endAttempt: 0, ending: false })

  function commit(runtime: Runtime, patch: Partial<SessionRecoveryRecord>) {
    const record = { ...runtime.record, ...patch }
    deps.save([...sessions.values()].map((item) => item === runtime ? record : item.record))
    runtime.record = record
  }
  function notify(runtime: Runtime, channel: string, value: unknown) {
    if (runtime.windowId !== null) deps.notify(runtime.windowId, channel, value)
  }
  function history(runtime: Runtime) {
    if (!runtime.record.runId || stopped) return
    let written = false
    try { written = deps.flushHistory(runtime.record) } catch {}
    if (written) {
      if (runtime.historyTimer !== undefined) cancelSchedule(runtime.historyTimer)
      runtime.historyTimer = undefined
      return
    }
    if (runtime.historyTimer !== undefined) return
    deps.diagnostic?.({ sessionId: runtime.record.sessionId, event: 'history-write-pending' })
    runtime.historyTimer = schedule(() => { runtime.historyTimer = undefined; history(runtime) }, 30_000)
  }
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
      latest: record.latest, pending: record.pending, afterSequence: record.cursor,
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
      onSnapshot: (snapshot) => { commit(runtime, { polls: snapshot.polls, expiresAt: snapshot.expiresAt }); history(runtime) },
      onPollVoteRecord: (vote) => {
        if (runtime.record.voteRecords.some((record) => record.sequence === vote.sequence)) return
        commit(runtime, { voteRecords: [...runtime.record.voteRecords, vote] })
        history(runtime)
      },
      onOperation: (operation) => notify(runtime, 'live:poll-operation', operation),
      onDiagnostic: (event) => deps.diagnostic?.({ sessionId: record.sessionId, ...event }),
    })
  }
  async function tryEnd(runtime: Runtime): Promise<void> {
    if (stopped || runtime.ending || !runtime.record.endRequested || runtime.record.status === 'ended' || runtime.record.status === 'expired') return
    runtime.ending = true
    try {
      const outcome = runtime.record.expiresAt <= now() ? 'expired' : await deps.endRemote(runtime.record)
      if (deps.recoverFinal) commit(runtime, await deps.recoverFinal(runtime.record))
      commit(runtime, { status: outcome })
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
        if (runtime.record.endRequested) void tryEnd(runtime)
        else connect(runtime)
        history(runtime)
      }
    },
    create(record: SessionRecoveryRecord, windowId: number) {
      if (sessions.has(record.sessionId)) throw new Error('Live session already exists.')
      deps.save([...sessions.values()].map((item) => item.record).concat(record))
      const runtime: Runtime = { record, windowId: null, client: null, endAttempt: 0, ending: false }
      sessions.set(record.sessionId, runtime)
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
      const record = runtimeForWindow(windowId)?.record
      if (!record) return null
      return { status: record.status, shortUrl: record.shortUrl, qrSvg: record.qrSvg,
        polls: structuredClone(record.polls), expiresAt: record.expiresAt,
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
      runtime.client?.publish(slide.slideId, slide.reveal, slide.focus)
    },
    poll(windowId: number, action: PresenterPollMessage) {
      const runtime = runtimeForWindow(windowId)
      if (!runtime || runtime.record.endRequested || isTerminalLiveStatus(runtime.record.status)) return { success: false, error: 'Live session is not accepting controls.' }
      const operationId = runtime.client?.sendPoll(action)
      return operationId ? { success: true, operationId, status: 'pending' as const } : { success: false, error: 'Live control could not be queued.' }
    },
    async end(windowId: number) {
      const runtime = runtimeForWindow(windowId)
      if (!runtime) return { success: true, status: 'ended' as LiveStatus }
      commit(runtime, { endRequested: true, status: 'ending', pending: [] })
      runtime.client?.disconnect(); runtime.client = null
      notify(runtime, 'live:status', 'ending')
      await tryEnd(runtime)
      return { success: true, status: runtime.record.status }
    },
    detach,
    reconnect() {
      for (const runtime of sessions.values()) {
        if (runtime.record.endRequested) void tryEnd(runtime)
        else runtime.client?.reconnect()
      }
    },
    shutdown() {
      stopped = true
      for (const runtime of sessions.values()) {
        runtime.client?.disconnect()
        if (runtime.endTimer !== undefined) cancelSchedule(runtime.endTimer)
        if (runtime.historyTimer !== undefined) cancelSchedule(runtime.historyTimer)
      }
    },
  }
}
