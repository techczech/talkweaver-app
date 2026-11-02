/**
 * Run heavy tasks strictly one at a time in this process.
 *
 * The compiler's `prepareSource` inlines a whole deck's media as base64 and builds one enormous
 * HTML string. Two decks inlined at once means two such strings live together, and on 2026-09-15
 * that was half of a main-process OOM: the Slide Browser's thumbnail lane prepared one talk while
 * the editor lane prepared another (the render queue serialises RENDERS, not PREPARATION).
 * T11's law from the backup sweep — one deck in memory at a time — applies here too.
 *
 * `beforeRequest` runs synchronously on every request except the prewarm's own, ahead of queueing.
 *
 * Nothing is dropped: a request waits its turn and then runs. A task that throws releases the
 * gate like any other, so one bad deck cannot wedge the queue.
 */
export interface SingleFlight {
  /** Queue `task`; it starts only once every earlier task has settled. */
  <T>(task: () => Promise<T>): Promise<T>
  /** Queue `task` at background priority: it still runs one at a time with everything else, but
   *  never starts while an ordinary task is waiting — a background share build cannot hold the
   *  editor strip's preparation up behind it. Background tasks keep their own order. */
  background<T>(task: () => Promise<T>): Promise<T>
  /** The prewarm's own idle preparation: background priority without releasing itself.
   *  Every other caller must use the ordinary call or `background`, which release its held deck. */
  prewarm<T>(task: () => Promise<T>): Promise<T>
  /** Run immediately, outside either queue: release the prewarm and keep it busy until fn settles. */
  withPrewarmYield<T>(fn: () => T): Promise<Awaited<T>>
  /** Any queued/running preparation or immediate foreground compile scope. */
  foregroundBusy(): boolean
  /** Tasks queued and not yet settled, including the running one. Diagnostics only. */
  waiting(): number
}

export function createSingleFlight(hooks: { beforeRequest?: () => void } = {}): SingleFlight {
  type Job = { run: () => Promise<void>; prewarm: boolean }
  const normal: Job[] = []
  const low: Job[] = []
  let running = false
  let queued = 0
  let foregroundCompiles = 0
  // An export never joins the queue. Only prewarm jobs become ineligible while it runs;
  // ordinary and other background jobs retain their priority and order.
  function takeNext(): Job | undefined {
    if (normal.length) return normal.shift()
    const index = foregroundCompiles > 0 ? low.findIndex((job) => !job.prewarm) : 0
    return index >= 0 ? low.splice(index, 1)[0] : undefined
  }
  function pump(): void {
    if (running) return
    if (normal.length === 0 && low.length === 0) return
    running = true
    // The gate must survive a failing task: the job settles either way and the NEXT one starts,
    // while the caller keeps the real rejection.
    // With a hook installed the next task starts on a later turn of the event loop, not a microtask
    // later: whoever was waiting on the task that just ended (the prewarm, holding its result) has then
    // run its continuation and let go before the next compile begins.
    // The job is chosen when it starts, not when the gate is reserved, so an ordinary request that
    // arrives during the deferral still goes ahead of a waiting background job.
    const start = (): void => {
      const next = takeNext()
      if (!next) { running = false; return }
      void next.run().finally(() => { running = false; pump() })
    }
    if (hooks.beforeRequest) setImmediate(start)
    else start()
  }
  function enqueue<T>(lane: Job[], task: () => Promise<T>, prewarm = false): Promise<T> {
    queued += 1
    return new Promise<T>((resolve, reject) => {
      lane.push({ prewarm, run: async () => {
        let value: T
        try { value = await task() } catch (error) { queued -= 1; reject(error); return }
        queued -= 1
        resolve(value)
      } })
      // Start on a later microtask, as the chained gate did: a caller never runs inside its own call.
      void Promise.resolve().then(pump)
    })
  }
  function announce(): void {
    // Foreground AND background requests release the prewarm's held deck synchronously before
    // queueing, so it is dropped before another compile starts. Only the explicit prewarm entry
    // point skips this hook: its own idle preparation must not release itself. A failing hook
    // never blocks the request.
    try { hooks.beforeRequest?.() } catch { /* never block a preparation on a hook */ }
  }
  const run = (<T>(task: () => Promise<T>): Promise<T> => {
    announce()
    return enqueue(normal, task)
  }) as SingleFlight
  run.background = <T>(task: () => Promise<T>): Promise<T> => {
    announce()
    return enqueue(low, task)
  }
  run.prewarm = <T>(task: () => Promise<T>): Promise<T> => enqueue(low, task, true)
  // Scope: counted, does not queue. If it starts while a prewarm compile is already running in the worker, the scope's deck
  // and the prewarm's incoming video-free deck are both in the main heap until wantedWhilePreparing drops the latter.
  run.withPrewarmYield = async <T>(fn: () => T): Promise<Awaited<T>> => {
    foregroundCompiles += 1
    try {
      announce()
      return await fn()
    } finally {
      foregroundCompiles -= 1
      if (foregroundCompiles === 0) pump()
    }
  }
  run.foregroundBusy = (): boolean => queued > 0 || foregroundCompiles > 0
  run.waiting = (): number => queued
  return run
}
