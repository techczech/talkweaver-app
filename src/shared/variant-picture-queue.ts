// The one client-side policy for pictures of the author's own slide (ADR-0032 §6): the layout picker's
// rows and the Inspector's option pictures both ask `layout:variant-thumbnail` through this module, so
// they share one set of limits and one answer to "ask again?".
//
//   - A window never has more than `maxInFlight` requests out, across every surface: the slots are
//     shared (`windowPictureSlots`). Main's own queue caps (layout-variant-thumbnail.ts) are then a
//     backstop, not the everyday path, and a busy Inspector cannot starve the picker or itself.
//   - Only what is wanted NOW is asked for: a surface names its wanted keys in priority order (the
//     picker: Suggested, then rows on screen; the Inspector: a group while it is on screen), and a key
//     that stopped being wanted before its turn is never asked.
//   - A failed render is tried once more after a pause, then the surface keeps its fallback.
//   - A `superseded` answer (main dropped or refused the request) is asked again only if still wanted
//     when its backoff has run, with a growing pause, and given up after a few tries.
//   - New text makes every earlier answer stale: answers for the old text are dropped on arrival.
//   - Leaving the slide abandons its requests still out: their slots go back to the window at once, so
//     the new slide's first picture never waits behind the old slide's full-deck compiles (main drops
//     the old slide's queued jobs when the new slide's first request arrives).
//
// Plain objects with an injectable clock, so the policy runs headless under test.
import { variantPictureAction, type VariantThumbnail } from './variant-thumbnail-result.ts'

export const VARIANT_PICTURE_POLICY = {
  /** Requests out at once from one window, all surfaces together (each is a compile and a render). */
  maxInFlight: 3,
  /** Wait for the wanted set and the text to settle (typing, arrowing) before asking. */
  settleMs: 150,
  /** A failed render is tried again after this pause… */
  retryDelayMs: 1500,
  /** …up to this many attempts in all; then the surface shows its fallback. */
  maxFailedAttempts: 2,
  /** A superseded request waits this long before it is asked again, doubling each time… */
  askAgainBaseMs: 400,
  askAgainMaxMs: 3200,
  /** …and is given up after this many superseded answers for the same text. */
  maxAskAgain: 3
} as const

/** What a surface draws for a key: a picture URL, `null` (keep the fallback: the sample, the named tile)
 *  or `{ reason }` (the render says the slide cannot take it: grey it, say why). Absent while unasked. */
export type VariantPictureMark = string | null | { reason: string }
export type VariantPictureMarks = Readonly<Record<string, VariantPictureMark>>

export function isGreyMark(mark: VariantPictureMark | undefined): mark is { reason: string } {
  return typeof mark === 'object' && mark !== null
}

/** A key's marks after an answer: a picture or a verdict replaces what was there. */
export function markSettled(marks: VariantPictureMarks, key: string, mark: VariantPictureMark): VariantPictureMarks {
  const current = marks[key]
  if (current === mark || (isGreyMark(current) && isGreyMark(mark) && current.reason === mark.reason)) return marks
  return { ...marks, [key]: mark }
}

/** The marks once the text has changed: pictures and fallbacks stay on screen until their replacements
 *  arrive (no flicker while the author types: a fallback never goes sample → pending → sample), but a
 *  "cannot take" verdict was about the old text and goes. */
export function marksForNewText(marks: VariantPictureMarks): VariantPictureMarks {
  const keys = Object.keys(marks)
  if (!keys.some((key) => isGreyMark(marks[key]))) return marks
  const next: Record<string, VariantPictureMark> = {}
  for (const key of keys) if (!isGreyMark(marks[key])) next[key] = marks[key]
  return next
}

export interface AttemptCounts { failed: number; superseded: number }

/** What to do with one answer (`null` = the IPC call itself failed): settle the key with a mark, or
 *  ask again after a pause (with the counts that pause used up). */
export function nextPictureStep(
  result: VariantThumbnail | null | undefined,
  counts: AttemptCounts
): { kind: 'settle'; mark: VariantPictureMark } | { kind: 'later'; ms: number; counts: AttemptCounts } {
  const action = variantPictureAction(result)
  const policy = VARIANT_PICTURE_POLICY
  switch (action.kind) {
    case 'picture': return { kind: 'settle', mark: action.url }
    case 'grey': return { kind: 'settle', mark: { reason: action.reason } }
    case 'sample': return { kind: 'settle', mark: null }
    case 'ask-again': {
      const superseded = counts.superseded + 1
      if (superseded > policy.maxAskAgain) return { kind: 'settle', mark: null }
      const ms = Math.min(policy.askAgainMaxMs, policy.askAgainBaseMs * 2 ** (superseded - 1))
      return { kind: 'later', ms, counts: { ...counts, superseded } }
    }
    default: {
      const failed = counts.failed + 1
      if (failed >= policy.maxFailedAttempts) return { kind: 'settle', mark: null }
      return { kind: 'later', ms: policy.retryDelayMs, counts: { ...counts, failed } }
    }
  }
}

// ── The window's request slots ────────────────────────────────────────────────────────────────

export interface VariantPictureSlots {
  /** Take a slot if one is free. */
  take(): boolean
  /** Give a slot back (the answer arrived, stale or not); queues waiting for one are told. */
  release(): void
  /** Be told when a slot frees. Returns the unsubscribe. */
  onFree(listener: () => void): () => void
  inUse(): number
}

export function createVariantPictureSlots(max: number = VARIANT_PICTURE_POLICY.maxInFlight): VariantPictureSlots {
  let used = 0
  const listeners: Array<() => void> = []
  return {
    take() {
      if (used >= max) return false
      used += 1
      return true
    },
    release() {
      used = Math.max(0, used - 1)
      // Round robin: the queue told first this time is told last next time, so no surface starves.
      const turn = [...listeners]
      if (listeners.length > 1) listeners.push(listeners.shift() as () => void)
      for (const listener of turn) {
        if (used >= max) break
        listener()
      }
    },
    onFree(listener) {
      listeners.push(listener)
      return () => {
        const at = listeners.indexOf(listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
    inUse: () => used
  }
}

/** The slots every picture surface in this window shares. */
export const windowPictureSlots = createVariantPictureSlots()

// ── One surface's queue ───────────────────────────────────────────────────────────────────────

type Schedule = (run: () => void, ms: number) => void

export interface VariantPictureQueue<Request> {
  /** A new slide or new text: everything asked before is stale, and nothing is wanted until `want`.
   *  `slideKey` names the slide: when it changes, requests still out are abandoned and their slots freed. */
  reset(contentKey: string, request: Request | null, slideKey?: string): void
  /** The keys wanted now, most important first. */
  want(keys: readonly string[]): void
  /** Requests out from this queue right now and holding a slot, stale text included (for tests). */
  inFlight(): number
  /** Stop: no more requests; answers still out are dropped and their slots freed. */
  dispose(): void
}

/**
 * One surface's requests. `fetchPicture(key, request)` asks main for the picture of `key` (a layout, an
 * option token) of the slide in `request`; `onSettled` receives the mark for a key under the content
 * key it was asked for. Keys already settled for the current content are not asked again.
 */
export function createVariantPictureQueue<Request>(
  fetchPicture: (key: string, request: Request) => Promise<VariantThumbnail | null>,
  onSettled: (key: string, mark: VariantPictureMark, contentKey: string) => void,
  { slots = windowPictureSlots, schedule = (run, ms) => { setTimeout(run, ms) } }: { slots?: VariantPictureSlots; schedule?: Schedule } = {}
): VariantPictureQueue<Request> {
  let contentKey = ''
  let slide: string | undefined
  let request: Request | null = null
  let wanted: string[] = []
  let disposed = false
  const done = new Set<string>()
  // Requests out, by content key and key; `released` once its slot went back (answered or abandoned).
  const running = new Map<string, { released: boolean }>()
  const waiting = new Set<string>()
  const counts = new Map<string, AttemptCounts>()

  const later = (key: string, ms: number, forKey: string): void => {
    waiting.add(key)
    schedule(() => {
      if (forKey !== contentKey) return
      waiting.delete(key)
      pump()
    }, ms)
  }

  function pump(): void {
    if (!request || disposed) return
    for (const key of wanted) {
      const id = `${contentKey}\0${key}`
      if (done.has(key) || waiting.has(key) || running.has(id)) continue
      if (!slots.take()) return
      const out = { released: false }
      running.set(id, out)
      const forKey = contentKey
      let asked: Promise<VariantThumbnail | null>
      // A fetch that throws before it returns a promise is a failed answer: its slot still comes back.
      try { asked = fetchPicture(key, request) } catch { asked = Promise.resolve(null) }
      asked
        .then((result) => result, () => null)
        .then((result) => {
          if (running.get(id) === out) running.delete(id)
          if (forKey === contentKey && !disposed) {
            const step = nextPictureStep(result, counts.get(key) ?? { failed: 0, superseded: 0 })
            if (step.kind === 'settle') {
              done.add(key)
              onSettled(key, step.mark, forKey)
            } else {
              counts.set(key, step.counts)
              later(key, step.ms, forKey)
            }
          }
          // Releasing tells every queue waiting for a slot, this one included. An abandoned request's
          // slot went back when it was abandoned.
          if (!out.released) { out.released = true; slots.release() }
        })
    }
  }
  const unsubscribe = slots.onFree(pump)

  /** Give back the slots of every request still out; their answers, when they come, are dropped. */
  function abandonRunning(): void {
    const out = [...running.values()].filter((entry) => !entry.released)
    running.clear()
    for (const entry of out) { entry.released = true; slots.release() }
  }

  return {
    reset(nextKey, next, slideKey) {
      if (nextKey === contentKey) return
      const leftSlide = slideKey !== undefined && slide !== undefined && slideKey !== slide
      contentKey = nextKey
      slide = slideKey
      request = next
      wanted = []
      done.clear()
      waiting.clear()
      counts.clear()
      if (leftSlide) abandonRunning()
    },
    want(keys) { wanted = [...keys]; pump() },
    inFlight: () => running.size,
    dispose() { disposed = true; wanted = []; unsubscribe(); abandonRunning() }
  }
}
