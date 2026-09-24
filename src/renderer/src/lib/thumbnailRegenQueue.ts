/**
 * What happens to a talk after the Slide Browser asks main to render its thumbnails.
 *
 * The Browser fills in missing prints in the background, strictly one talk at a time. The
 * decision that matters is what an EMPTY result means. Until 2026-09-15 it meant "one of your two
 * attempts is gone": main started returning `{}` whenever the heap was high, so a whole vault's
 * worth of talks burned both attempts in a few seconds while the editor lane held a heavy deck,
 * and every card stayed schematic until the app was relaunched — with the PNGs sitting on disk
 * under matching keys.
 *
 * So: an empty result is "not now", never "never". It costs no attempt and the talk comes back
 * after a delay, as often as it takes, while the Browser stays open. The two-attempt cap survives
 * only for a talk whose outline could not be READ, which is a real fault and will not fix itself.
 *
 * Kept out of the component so the rule can be tested without a DOM.
 */

/** How long a deferred talk waits before the chain offers it again. */
export const THUMB_DEFER_DELAY_MS = 30_000
/** Attempts allowed for a talk whose outline could not be read. */
export const THUMB_READ_ATTEMPTS_MAX = 2

/**
 * The outcome of one run. `rendered` is the number of thumbnails main returned: a positive count
 * is a finished talk, `0` is main saying "not now" (deferred, superseded or aborted), and `null`
 * is a fault — the outline could not be read, main returned null, or the call threw.
 */
export interface ThumbRunOutcome {
  rendered: number | null
}

export interface ThumbSettleResult {
  /** Remount this talk's <img>s: there are new prints to load. */
  bumpNonce: boolean
  /** Set when the talk goes back in the queue behind a delay. */
  deferredMs: number | null
  /** Set when the talk is given up on: its outline could not be read often enough. */
  abandoned: boolean
}

export type ThumbNextStep =
  | { kind: 'run'; slug: string; outlinePath: string }
  /** Everything queued is still deferred; ask again in this many ms. */
  | { kind: 'wait'; ms: number }
  | { kind: 'idle' }

export interface ThumbRegenQueue {
  /** Queue a talk whose print 404'd. Returns false when it is already queued, running or done. */
  note(slug: string, outlinePath: string): boolean
  /** Take the next talk that is ready to run, or say how long to wait. */
  next(now: number): ThumbNextStep
  /** Record what a run returned and decide what becomes of the talk. */
  settle(slug: string, outcome: ThumbRunOutcome, now: number): ThumbSettleResult
  /** Forget everything — a fresh opening of the Browser looks at every talk again. */
  reset(): void
  /** Diagnostics for tests: what the queue is holding. */
  stats(): { queued: number; running: string | null; done: number; abandoned: number }
}

export function createThumbRegenQueue(options: { deferDelayMs?: number; readAttemptsMax?: number } = {}): ThumbRegenQueue {
  const deferDelayMs = options.deferDelayMs ?? THUMB_DEFER_DELAY_MS
  const readAttemptsMax = options.readAttemptsMax ?? THUMB_READ_ATTEMPTS_MAX
  // Insertion-ordered: the talk whose card 404'd first is rendered first.
  const queue = new Map<string, string>()
  const paths = new Map<string, string>()
  const readyAt = new Map<string, number>()
  const readFailures = new Map<string, number>()
  const done = new Set<string>()
  const abandoned = new Set<string>()
  let running: string | null = null

  return {
    note(slug, outlinePath) {
      if (!slug || !outlinePath) return false
      // One in-flight request per talk, and one entry in the queue: a card that 404s on every
      // scroll must not be able to queue the same talk twice.
      if (running === slug || queue.has(slug) || done.has(slug) || abandoned.has(slug)) return false
      paths.set(slug, outlinePath)
      queue.set(slug, outlinePath)
      return true
    },
    next(now) {
      if (running) return { kind: 'wait', ms: 0 }
      let soonest = Infinity
      for (const [slug, outlinePath] of queue) {
        const ready = readyAt.get(slug) ?? 0
        if (ready <= now) {
          queue.delete(slug)
          readyAt.delete(slug)
          running = slug
          return { kind: 'run', slug, outlinePath }
        }
        soonest = Math.min(soonest, ready)
      }
      return soonest === Infinity ? { kind: 'idle' } : { kind: 'wait', ms: Math.max(0, soonest - now) }
    },
    settle(slug, outcome, now) {
      if (running === slug) running = null
      const { rendered } = outcome
      if (rendered != null && rendered > 0) {
        done.add(slug)
        readFailures.delete(slug)
        return { bumpNonce: true, deferredMs: null, abandoned: false }
      }
      if (rendered === 0) {
        // "Not now." No attempt is consumed and there is no cap: main deferred this pass because
        // the main-process heap was high, and that clears on its own.
        const outlinePath = paths.get(slug)
        if (outlinePath) {
          queue.set(slug, outlinePath)
          readyAt.set(slug, now + deferDelayMs)
        }
        return { bumpNonce: false, deferredMs: deferDelayMs, abandoned: false }
      }
      // A fault. This one is capped: a talk whose outline cannot be read will not read next time.
      const failures = (readFailures.get(slug) ?? 0) + 1
      readFailures.set(slug, failures)
      if (failures >= readAttemptsMax) {
        abandoned.add(slug)
        return { bumpNonce: false, deferredMs: null, abandoned: true }
      }
      // Under the cap the talk is neither queued nor blocked: the next 404 from its card offers
      // it again, exactly as before.
      return { bumpNonce: false, deferredMs: null, abandoned: false }
    },
    reset() {
      queue.clear()
      paths.clear()
      readyAt.clear()
      readFailures.clear()
      done.clear()
      abandoned.clear()
      running = null
    },
    stats: () => ({ queued: queue.size, running, done: done.size, abandoned: abandoned.size })
  }
}
