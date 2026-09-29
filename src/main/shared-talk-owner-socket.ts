// Feedback rail (ticket 05): the owner socket client. One per shared talk, held by the main
// process. It opens `/shares/<id>/owner?since=<seq>` with the owner token as a bearer header
// (worker/README.md: the header is preferred; the token never travels in the URL), delivers each
// `item.new`, and reconnects with backoff.
//
// Invariants:
//   - The client keeps NO replay position of its own: every (re)connect asks `since()` — the
//     feedback file's position — so an item counts as received only once it is on disk.
//   - A dropped or refused socket is `paused` and retried, unless the share has ended: a
//     `share.closed` event, or the probe finding the share stopped (410) or the owner token refused
//     (401/403). Ended is terminal. Nothing here touches the outline or a save (ADR-0004 §6).
export type OwnerConnection = 'connecting' | 'connected' | 'paused' | 'ended'
export type EndedReason = 'stopped' | 'retired' | 'refused'

export interface OwnerSocketLike {
  onopen: (() => void) | null
  onclose: ((event?: { code?: number }) => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  close(code?: number, reason?: string): void
}

export type CreateOwnerSocket = (url: string, headers: Record<string, string>) => OwnerSocketLike

type Handle = ReturnType<typeof setTimeout>

export interface OwnerSocketOptions {
  baseUrl: string
  shareId: string
  ownerToken: string
  /** Replay position, asked at every (re)connect: the feedback file's replayFrom. */
  since(): number
  onItem(item: unknown, seq: number): void
  onConnection(connection: OwnerConnection): void
  /** The share has ended (terminal). */
  onEnded?(reason: EndedReason): void
  /** After a failed or dropped socket: is the share still there for this token? (The WebSocket
   *  API hides the upgrade's HTTP status, so a plain request asks.) */
  probe?(): Promise<EndedReason | null>
  /** The socket opened (a good moment to re-send owed statuses). */
  onOpen?(): void
  createSocket?: CreateOwnerSocket
  schedule?(fn: () => void, delay: number): Handle
  cancelSchedule?(handle: Handle): void
  reconnectDelayMs?: number
  maxDelayMs?: number
  random?(): number
  log?(message: string): void
}

export interface OwnerSocket {
  connection(): OwnerConnection
  /** Drop the socket and reconnect after the backoff (a write failed: ask again from the file). */
  restart(): void
  stop(): void
}

export function ownerSocketUrl(baseUrl: string, shareId: string, since: number): string {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/shares/${encodeURIComponent(shareId)}/owner`
  url.search = since > 0 ? `?since=${since}` : ''
  url.hash = ''
  return url.toString()
}

const defaultCreateSocket: CreateOwnerSocket = (url, headers) => {
  // Node's WebSocket (undici) takes headers in its options object; the DOM typing does not know it.
  const Ctor = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => OwnerSocketLike
  return new Ctor(url, { headers })
}

export function createOwnerSocket(options: OwnerSocketOptions): OwnerSocket {
  const createSocket = options.createSocket ?? defaultCreateSocket
  const schedule = options.schedule ?? ((fn, delay) => setTimeout(fn, delay))
  const cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle))
  const random = options.random ?? Math.random
  const base = options.reconnectDelayMs ?? 750
  const max = options.maxDelayMs ?? 8000
  let state: OwnerConnection = 'connecting'
  let socket: OwnerSocketLike | null = null
  let timer: Handle | null = null
  let attempt = 0
  let stopped = false
  let probes = 0

  function setState(next: OwnerConnection): void {
    if (state === next) return
    state = next
    options.onConnection(next)
  }

  function dispose(): void {
    const previous = socket
    socket = null
    if (!previous) return
    previous.onopen = previous.onclose = previous.onerror = previous.onmessage = null
    try { previous.close(1000, 'reconnecting') } catch { /* already closed */ }
  }

  function end(reason: EndedReason): void {
    if (state === 'ended') return
    stopped = true
    if (timer) { cancelSchedule(timer); timer = null }
    dispose()
    setState('ended')
    options.log?.(`[shared-talk] share ${options.shareId} ended (${reason})`)
    options.onEnded?.(reason)
  }

  function retry(): void {
    if (stopped) return
    dispose()
    setState('paused')
    const delay = Math.min(max, base * 2 ** Math.min(attempt, 6)) * (0.8 + 0.4 * random())
    attempt += 1
    if (timer) cancelSchedule(timer)
    timer = schedule(() => { timer = null; connect() }, delay)
    const generation = ++probes
    void options.probe?.().then((reason) => {
      if (reason && !stopped && generation === probes && state !== 'connected') end(reason)
    }).catch(() => { /* offline: keep retrying */ })
  }

  function handle(raw: unknown): void {
    let message: { type?: unknown; item?: unknown; seq?: unknown; reason?: unknown }
    try { message = JSON.parse(String(raw)) } catch { return }
    if (!message || typeof message !== 'object') return
    if (message.type === 'item.new') {
      const seq = Number(message.seq ?? (message.item as { seq?: unknown } | undefined)?.seq)
      if (!Number.isInteger(seq)) return
      options.onItem(message.item, seq)
      return
    }
    if (message.type === 'share.closed') end(message.reason === 'retired' ? 'retired' : 'stopped')
  }

  function connect(): void {
    if (stopped) return
    let next: OwnerSocketLike
    try {
      next = createSocket(ownerSocketUrl(options.baseUrl, options.shareId, Math.max(0, options.since() | 0)), { authorization: `Bearer ${options.ownerToken}` })
    } catch (error) {
      options.log?.(`[shared-talk] owner socket could not open: ${(error as Error).message}`)
      retry()
      return
    }
    socket = next
    next.onopen = () => {
      if (socket !== next) return
      attempt = 0
      setState('connected')
      options.onOpen?.()
    }
    next.onmessage = (event) => { if (socket === next) handle(event.data) }
    next.onerror = () => { if (socket === next) retry() }
    next.onclose = () => { if (socket === next) retry() }
  }

  connect()

  return {
    connection: () => state,
    restart() { if (!stopped) retry() },
    stop() {
      stopped = true
      if (timer) { cancelSchedule(timer); timer = null }
      dispose()
    },
  }
}
