/**
 * The cache identity of one talk prepared one way. `defaults` (timer settings) and `options`
 * (the compiler's media contract) are both part of it: a model prepared WITHOUT video for a
 * background thumbnail render must never be handed to compile, the Inspector or Present, and a
 * full model must not be mistaken for one — so they cannot share a group.
 */
export function preparedTalkGroup(outlinePath: string, defaults?: unknown, options?: unknown): string {
  return outlinePath + '\0' + JSON.stringify(defaults ?? null) + '\0' + JSON.stringify(options ?? null)
}

/** Coalesce preparation work and retain one recent revision per path/defaults group. */
export function createPreparedTalkCache<T>(options: {
  maxEntries: number
  maxBytes: number
  sizeOf: (value: T) => number
}) {
  const retained = new Map<string, { group: string; value: T; bytes: number }>()
  const pending = new Map<string, { group: string; promise: Promise<T> }>()
  const latest = new Map<string, string>()
  let bytes = 0
  function remove(key: string): void {
    const value = retained.get(key)
    if (value) bytes -= value.bytes
    retained.delete(key)
  }
  function pruneGroups(): void {
    for (const group of latest.keys()) {
      if (![...retained.values(), ...pending.values()].some(value => value.group === group)) latest.delete(group)
    }
  }
  return {
    get(key: string, group: string, load: () => Promise<T>): Promise<T> {
      latest.set(group, key)
      const hit = retained.get(key)
      if (hit) {
        retained.delete(key)
        retained.set(key, hit)
        return Promise.resolve(hit.value)
      }
      const running = pending.get(key)
      if (running) return running.promise
      const promise = Promise.resolve().then(load).then(value => {
        // An older slow request may finish after a newer document. Return it to its caller,
        // but never let it evict the latest requested revision from the shared cache.
        if (latest.get(group) === key && pending.get(key)?.promise === promise) {
          for (const [oldKey, entry] of retained) if (entry.group === group) remove(oldKey)
          const weight = Math.max(0, options.sizeOf(value))
          retained.set(key, { group, value, bytes: weight })
          bytes += weight
          // Retain one oversized current document so compile -> thumbnails does not prepare it
          // twice. It must be the only cached document and is evicted on the next smaller one.
          while (retained.size > 1 && (retained.size > options.maxEntries || bytes > options.maxBytes)) {
            remove(retained.keys().next().value!)
          }
        }
        return value
      }).finally(() => {
        if (pending.get(key)?.promise === promise) pending.delete(key)
        pruneGroups()
      })
      pending.set(key, { group, promise })
      return promise
    },
    /**
     * Drop everything retained for one group. The retention above exists so a compile is
     * followed by a free thumbnail pass on the same model; a background sweep has no follow-up
     * request, so holding its deck — possibly the "one oversized current document" — is pure
     * cost. The browser thumbnail lane calls this the moment its render resolves (2026-09-15
     * main-process OOM). In-flight callers are untouched: a caller already awaiting this group
     * still gets its value, it is simply not kept afterwards.
     */
    evict(group: string): void {
      for (const [key, entry] of [...retained]) if (entry.group === group) remove(key)
      for (const [key, entry] of pending) if (entry.group === group) pending.delete(key)
      latest.delete(group)
    },
    /** Drop every retained preparation of one talk, whatever its defaults and options (its files beside the outline changed, e.g. a saved view of a live page). */
    evictOutline(outlinePath: string): void {
      const prefix = outlinePath + '\0'
      for (const group of new Set([...retained.values(), ...pending.values()].map(entry => entry.group))) if (group.startsWith(prefix)) this.evict(group)
    },
    stats: () => ({ entries: retained.size, bytes, pending: pending.size })
  }
}

/** Which preparation a compile is: the live deck (the editor strip, the Inspector, Present, the
 *  thumbnails of the talk as written) or a layout VARIANT of it (a picture of the slide in another
 *  layout, ADR-0032 §6), which nothing else will ask for again, or the prewarm's own idle work. */
export type PreparationLane = 'live' | 'variant' | 'prewarm'

/** Runs one heavy step (the compiler's `prepareSource`) on the preparation gate. */
export type GatedRun = <R>(task: () => Promise<R>) => Promise<R>

/**
 * Where a compile goes, by lane. A live compile goes through the prepared-talk cache and takes the
 * gate's ordinary lane. A variant compile bypasses the cache (it would evict the live deck's retained
 * model and stay retained itself) and takes the gate's background lane, so the live deck's compile on
 * a typing pause never waits behind a variant: it still runs one deck at a time with everything else,
 * and queues in order with the other background work (the share builder). The prewarm is also uncached
 * and at background priority, but uses its explicit entry point so it does not release itself.
 */
export function createPreparationRoute<T>(
  cache: { get(key: string, group: string, load: () => Promise<T>): Promise<T> },
  gate: GatedRun & { background: GatedRun; prewarm: GatedRun }
) {
  return (lane: PreparationLane, key: string, group: string, load: (gated: GatedRun) => Promise<T>): Promise<T> =>
    lane === 'prewarm'
      ? load((task) => gate.prewarm(task))
      : lane === 'variant'
        ? load((task) => gate.background(task))
        : cache.get(key, group, () => load((task) => gate(task)))
}

/**
 * `load` once, shared by every caller, but only once it has FOUND something: a load that rejects or
 * comes back empty (`undefined` — the compiler directory not there yet, an import that failed) is
 * forgotten, and the next call loads again, so one transient failure is never kept for the app's life.
 * Callers that arrive while a load is running share it.
 */
export function memoiseUntilFailure<T>(load: () => Promise<T | undefined>): () => Promise<T | undefined> {
  let kept: Promise<T | undefined> | null = null
  return () => {
    if (kept) return kept
    const attempt = load().then(
      (value) => { if (value === undefined && kept === attempt) kept = null; return value },
      (error: unknown) => { if (kept === attempt) kept = null; throw error }
    )
    kept = attempt
    return attempt
  }
}
