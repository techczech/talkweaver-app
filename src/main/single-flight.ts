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
  /** Tasks queued and not yet settled, including the running one. Diagnostics only. */
  waiting(): number
}

export function createSingleFlight(): SingleFlight {
  let tail: Promise<unknown> = Promise.resolve()
  let queued = 0
  function run<T>(task: () => Promise<T>): Promise<T> {
    queued += 1
    const result = tail.then(() => task())
    // The gate must survive a failing task: swallow here so the NEXT task still starts, while
    // the caller keeps the real rejection.
    tail = result.then(
      () => { queued -= 1 },
      () => { queued -= 1 }
    )
    return result
  }
  run.waiting = (): number => queued
  return run
}
