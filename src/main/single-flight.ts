/**
 * Run heavy tasks strictly one at a time in this process.
 *
 * The compiler's `prepareSource` inlines a whole deck's media as base64 and builds one enormous
 * HTML string. Two decks inlined at once means two such strings live together, and on 2026-09-15
 * that was half of a main-process OOM: the Slide Browser's thumbnail lane prepared one talk while
 * the editor lane prepared another (the render queue serialises RENDERS, not PREPARATION).
 * T11's law from the backup sweep — one deck in memory at a time — applies here too.
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
  /** Tasks queued and not yet settled, including the running one. Diagnostics only. */
  waiting(): number
}

export function createSingleFlight(): SingleFlight {
  type Job = () => Promise<void>
  const normal: Job[] = []
  const low: Job[] = []
  let running = false
  let queued = 0
  function pump(): void {
    if (running) return
    const next = normal.shift() ?? low.shift()
    if (!next) return
    running = true
    // The gate must survive a failing task: the job settles either way and the NEXT one starts,
    // while the caller keeps the real rejection.
    void next().finally(() => { running = false; pump() })
  }
  function enqueue<T>(lane: Job[], task: () => Promise<T>): Promise<T> {
    queued += 1
    return new Promise<T>((resolve, reject) => {
      lane.push(async () => {
        let value: T
        try { value = await task() } catch (error) { queued -= 1; reject(error); return }
        queued -= 1
        resolve(value)
      })
      // Start on a later microtask, as the chained gate did: a caller never runs inside its own call.
      void Promise.resolve().then(pump)
    })
  }
  const run = (<T>(task: () => Promise<T>): Promise<T> => enqueue(normal, task)) as SingleFlight
  run.background = <T>(task: () => Promise<T>): Promise<T> => enqueue(low, task)
  run.waiting = (): number => queued
  return run
}
