import { parsePresenterServerMessage, type PollStateMessage, type PresenterPollMessage, type SlideFocusState, type SlideState } from '../../worker/protocol'
import { parseRecoveredVoteRecord, parseRecoveryServerMessage, type RecoveredVoteRecord, type SessionSnapshot } from '../../worker/recovery-protocol'

export type LiveStatus = 'connecting' | 'live' | 'paused-reconnecting' | 'ending' | 'ended'
  | 'expired' | 'authentication-failed' | 'incompatible' | 'superseded'
export interface PendingPollOperation { operationId: string; action: PresenterPollMessage }
export interface LiveOperationUpdate {
  operationId: string
  status: 'pending' | 'confirmed' | 'rejected'
  message: PresenterPollMessage
  error?: string
}
interface SocketLike {
  readyState: number
  onopen: (() => void) | null
  onclose: ((event?: { code?: number; wasClean?: boolean }) => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(value: string): void
  close(code?: number, reason?: string): void
}
type ScheduleHandle = ReturnType<typeof setTimeout>
export function presenterSocketUrl(baseUrl: string, sessionId: string, presenterToken: string): string {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/sessions/${encodeURIComponent(sessionId)}/presenter`
  url.search = new URLSearchParams({ token: presenterToken, protocol: '2' }).toString()
  url.hash = ''
  return url.toString()
}
export function isTerminalLiveStatus(status: LiveStatus): boolean {
  return ['ended', 'expired', 'authentication-failed', 'incompatible', 'superseded'].includes(status)
}
export function createLivePresenterClient(options: {
  baseUrl: string; sessionId: string; presenterToken: string
  createSocket?: (url: string) => SocketLike
  schedule?: (fn: () => void, delay: number) => ScheduleHandle
  cancelSchedule?: (handle: ScheduleHandle) => void
  random?: () => number
  onStatus?: (status: LiveStatus) => void
  onPollState?: (message: PollStateMessage) => void
  onPollVoteRecord?: (message: RecoveredVoteRecord) => void
  onSnapshot?: (message: SessionSnapshot) => void
  onOperation?: (update: LiveOperationUpdate) => void
  onPendingChange?: (pending: PendingPollOperation[]) => void
  onCursorChange?: (sequence: number) => void
  onDiagnostic?: (event: { event: string; attempt: number; code?: number; clean?: boolean }) => void
  probe?: () => Promise<LiveStatus | null>
  pending?: PendingPollOperation[]
  afterSequence?: number
  latest?: SlideState | null
  reconnectDelayMs?: number
  handshakeTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
}) {
  const createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike)
  const schedule = options.schedule ?? ((fn, delay) => setTimeout(fn, delay))
  const cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle))
  const random = options.random ?? Math.random
  let liveStatus: LiveStatus = 'connecting'
  let socket: SocketLike | null = null
  let stopped = false, attempt = 0, generation = 0
  let latest: SlideState | null = options.latest ?? null
  let cursor = options.afterSequence ?? 0
  const bufferedRecords = new Map<number, RecoveredVoteRecord>()
  let pending = structuredClone(options.pending ?? [])
  let syncId = '', syncSlide = '', nonce = ''
  let inFlight = ''
  const timers = new Map<string, ScheduleHandle>()
  const uuid = () => crypto.randomUUID()

  function cancel(name: string) {
    const handle = timers.get(name)
    if (handle !== undefined) cancelSchedule(handle)
    timers.delete(name)
  }
  function later(name: string, fn: () => void, delay: number) {
    cancel(name)
    timers.set(name, schedule(() => { timers.delete(name); fn() }, delay))
  }
  function setStatus(status: LiveStatus) {
    if (liveStatus === status) return
    liveStatus = status
    options.onStatus?.(status)
  }
  function disposeSocket() {
    const previous = socket
    socket = null
    for (const name of [...timers.keys()]) cancel(name)
    nonce = ''; syncId = ''; inFlight = ''
    try { previous?.close(1000, 'Reconnecting') } catch {}
  }
  function terminal(status: LiveStatus) {
    if (stopped) return
    stopped = true; generation++
    disposeSocket()
    setStatus(status)
  }
  function diagnostic(event: string, details: { code?: number; clean?: boolean } = {}) {
    options.onDiagnostic?.({ event, attempt, ...details })
  }
  function fail(event: string, details: { code?: number; clean?: boolean } = {}) {
    if (stopped) return
    diagnostic(event, details)
    disposeSocket()
    const currentGeneration = ++generation
    setStatus('paused-reconnecting')
    const delay = Math.min(8000, (options.reconnectDelayMs ?? 750) * (2 ** Math.min(attempt++, 5))) * (0.8 + 0.4 * random())
    later('reconnect', connect, delay)
    if (options.probe) void options.probe().then((status) => {
      if (!stopped && generation === currentGeneration && status && isTerminalLiveStatus(status)) terminal(status)
    }).catch(() => {})
  }
  function send(message: unknown): boolean {
    if (!socket || socket.readyState !== 1 || stopped) return false
    try { socket.send(JSON.stringify(message)); return true } catch { fail('send-failed'); return false }
  }
  function sendSync() {
    syncId = uuid()
    syncSlide = JSON.stringify(latest)
    later('handshake', () => fail('synchronisation-timeout'), options.handshakeTimeoutMs ?? 10_000)
    send({ type: 'session.sync', syncId, slideState: latest, afterSequence: cursor })
  }
  function heartbeat() {
    later('heartbeat', () => {
      nonce = uuid()
      if (!send({ type: 'session.ping', nonce })) return
      later('pong', () => fail('heartbeat-timeout'), options.heartbeatTimeoutMs ?? 10_000)
    }, options.heartbeatIntervalMs ?? 15_000)
  }
  function flush() {
    if (liveStatus !== 'live' || stopped || inFlight || !pending.length) return
    const next = pending[0]
    inFlight = next.operationId
    if (send({ type: 'operation', ...next })) {
      later('operation', () => fail('operation-acknowledgement-timeout'), 10_000)
    }
  }
  function receiveRecord(record: RecoveredVoteRecord) {
    if (record.sequence <= cursor) return
    bufferedRecords.set(record.sequence, record)
    // Live records can arrive between pages. Never skip a gap in replay history.
    while (bufferedRecords.has(cursor + 1)) {
      const next = bufferedRecords.get(cursor + 1)!
      options.onPollVoteRecord?.(next)
      options.onCursorChange?.(next.sequence)
      cursor = next.sequence
      bufferedRecords.delete(cursor)
    }
  }
  function connect() {
    if (stopped) return
    generation++
    try {
      const current = createSocket(presenterSocketUrl(options.baseUrl, options.sessionId, options.presenterToken))
      socket = current
      later('handshake', () => fail('connection-timeout'), options.handshakeTimeoutMs ?? 10_000)
      current.onopen = () => { if (socket === current && !stopped) diagnostic('socket-open') }
      current.onclose = (event) => {
        if (socket !== current || stopped) return
        if (event?.code === 4001) { terminal('superseded'); return }
        fail('socket-close', { code: event?.code, clean: event?.wasClean })
      }
      current.onerror = () => { if (socket === current && !stopped) fail('socket-error') }
      current.onmessage = (event) => {
        if (socket !== current || stopped || typeof event.data !== 'string') return
        try {
          const message = parseRecoveryServerMessage(event.data)
          if (message?.type === 'session.closed') { terminal(message.reason === 'expired' ? 'expired' : 'ended'); return }
          if (message?.type === 'session.superseded') { terminal('superseded'); return }
          if (message?.type === 'session.hello') { sendSync(); return }
          if (message?.type === 'session.pong') {
            if (message.nonce === nonce) { cancel('pong'); nonce = ''; heartbeat() }
            return
          }
          if (message?.type === 'session.snapshot') {
            if (message.sessionId !== options.sessionId || message.syncId !== syncId) return
            for (const poll of message.polls) options.onPollState?.(poll)
            for (const record of message.voteRecords ?? []) receiveRecord(record)
            options.onSnapshot?.(message)
            if (message.moreRecords || syncSlide !== JSON.stringify(latest)) { sendSync(); return }
            cancel('handshake')
            syncId = ''; attempt = 0
            setStatus('live')
            diagnostic('synchronised')
            heartbeat(); flush()
            return
          }
          if (message?.type === 'operation.ack') {
            const first = pending[0]
            if (!first || first.operationId !== message.operationId || inFlight !== message.operationId) return
            const remaining = pending.slice(1)
            options.onPendingChange?.(remaining)
            pending = remaining; inFlight = ''
            cancel('operation')
            options.onOperation?.({ operationId: message.operationId, status: message.status, message: first.action, error: message.error })
            flush()
            return
          }
          const record = parseRecoveredVoteRecord(JSON.parse(event.data))
          if (record) { receiveRecord(record); return }
          const state = parsePresenterServerMessage(event.data)
          if (state?.type === 'poll.state') options.onPollState?.(state)
        } catch { fail('recovery-state-write-failed') }
      }
    } catch { fail('connection-failed') }
  }
  connect()
  return {
    publish(slideId: string, reveal: number, focus: SlideFocusState | null = null) {
      if (stopped || !slideId || !Number.isInteger(reveal) || reveal < 0) return
      latest = { slideId, reveal, focus }
      if (liveStatus === 'live') send({ type: 'slide.publish', ...latest })
    },
    sendPoll(action: PresenterPollMessage): string | false {
      if (stopped) return false
      const operationId = uuid()
      const next = [...pending, { operationId, action: structuredClone(action) }]
      // A command must be durable before it can be sent or reported as queued.
      options.onPendingChange?.(next)
      pending = next
      options.onOperation?.({ operationId, status: 'pending', message: action })
      flush()
      return operationId
    },
    end() { terminal('ended') },
    disconnect() { stopped = true; generation++; disposeSocket() },
    reconnect() { if (!stopped) fail('resume-check') },
    status: () => liveStatus,
  }
}
