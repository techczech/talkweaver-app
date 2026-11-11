/**
 * The editor's live-preview compile, at most one in flight per talk.
 *
 * Every typing pause used to send a whole-deck compile, and main ran each one in turn: on a heavy
 * 150-slide talk dozens of obsolete compiles queued up behind each other (2026-11-06 measurements).
 * Here a request for a talk that already has one in flight only remembers its text. When the reply
 * arrives (or fails), exactly one request goes out for the newest remembered text, if that is not
 * what was just compiled. Waiters for text that a newer request replaced settle as `superseded` and
 * must show nothing; main can also answer `{ superseded: true }` (single-flight.ts), treated the same.
 *
 * Replies for one talk arrive in the order the requests were sent, so a newer revision's preview is
 * never followed by an older one's. The caller's own stale-reply check stays as a second guard.
 */
export type LiveCompileOutcome<R> = { status: 'compiled'; result: R } | { status: 'superseded' }

type Waiter<R> = { resolve: (outcome: LiveCompileOutcome<R>) => void; reject: (error: unknown) => void }
type Batch<R> = { source: string; waiters: Waiter<R>[] }

export function isSupersededReply(value: unknown): value is { superseded: true } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { superseded?: unknown }).superseded === true
}

export function createLiveCompile<R>(send: (key: string, source: string) => Promise<R | { superseded: true }>) {
  const talks = new Map<string, { inFlight: Batch<R>; next: Batch<R> | null }>()

  function supersede(batch: Batch<R> | null): void {
    for (const waiter of batch?.waiters ?? []) waiter.resolve({ status: 'superseded' })
  }

  function start(key: string, batch: Batch<R>): void {
    const slot = { inFlight: batch, next: null as Batch<R> | null }
    talks.set(key, slot)
    let sent: Promise<R | { superseded: true }>
    try { sent = send(key, batch.source) } catch (error) { sent = Promise.reject(error) }
    // Retire the slot BEFORE settling anyone: a waiter's continuation may ask again for this talk on
    // the next microtask, and it must find the next compile (or none), never this finished one.
    const retire = (): void => {
      if (talks.get(key) !== slot) return
      if (slot.next) start(key, slot.next)
      else talks.delete(key)
    }
    sent.then(
      (reply) => {
        retire()
        const outcome: LiveCompileOutcome<R> = isSupersededReply(reply) ? { status: 'superseded' } : { status: 'compiled', result: reply as R }
        for (const waiter of batch.waiters) waiter.resolve(outcome)
      },
      (error: unknown) => {
        retire()
        for (const waiter of batch.waiters) waiter.reject(error)
      }
    )
  }

  return {
    /** Compile `source` for talk `key`, or wait for the compile already running for it. */
    request(key: string, source: string): Promise<LiveCompileOutcome<R>> {
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject }
        const slot = talks.get(key)
        if (!slot) { start(key, { source, waiters: [waiter] }); return }
        if (slot.next?.source === source) { slot.next.waiters.push(waiter); return }
        supersede(slot.next)
        if (slot.inFlight.source === source) { slot.next = null; slot.inFlight.waiters.push(waiter); return }
        slot.next = { source, waiters: [waiter] }
      })
    },
    /** True while a compile for talk `key` is in flight: a new edit should be recorded at once, not after the typing pause. */
    busy: (key: string): boolean => talks.has(key),
    /** Talks with a compile in flight. Diagnostics and tests. */
    inFlight: (): number => talks.size
  }
}
