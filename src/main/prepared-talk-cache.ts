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
        if (latest.get(group) === key) {
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
        pending.delete(key)
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
     * main-process OOM). In-flight work is untouched: a caller already awaiting this group
     * still gets its value, it is simply not kept afterwards.
     */
    evict(group: string): void {
      for (const [key, entry] of [...retained]) if (entry.group === group) remove(key)
      if (!pending.size || ![...pending.values()].some(value => value.group === group)) latest.delete(group)
    },
    stats: () => ({ entries: retained.size, bytes, pending: pending.size })
  }
}
