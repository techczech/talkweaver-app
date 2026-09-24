/**
 * What a thumbnail render is allowed to cost the main process.
 *
 * Two lanes ask for thumbnails. The EDITOR strip re-requests after every edit pause for the deck
 * the user is looking at, and shares its prepared model with the `talk:compile` that precedes it —
 * one prepare serves both, and it must stay the same model Present and the Inspector see.
 * The BROWSER lane is the Slide Browser's background sweep: it walks every talk whose prints are
 * missing, unattended, and nobody is watching any single deck. On 2026-09-15 that sweep walked all
 * 84 vault talks and twice took the main process to 3.8-3.9GB against a 4096MB V8 ceiling — a
 * fatal OOM inside a libuv fs callback. See THUMBNAIL_MEDIA_OPTIONS in the compiler's
 * 08-source-adapters.mjs for the media half of the fix.
 *
 * This module holds the decisions, injected rather than read from globals, so they can be tested
 * without an Electron main process.
 */

/** The Slide Browser's background sweep. Must match SlideBrowser.tsx's `{ lane: 'browser' }`. */
export const BROWSER_THUMBNAIL_LANE = 'browser'

/**
 * The media options a lane compiles under. `undefined` means the standing defaults — the editor
 * lane keeps the model that compile, Present and the Inspector share, so nothing is prepared
 * twice per edit pause. The browser lane gets the video-free options, which are part of the
 * prepared-cache identity so a video-free model is never served to compile or Present.
 */
export function thumbnailMediaOptions<T>(lane: string | undefined, browserOptions: T): T | undefined {
  return lane === BROWSER_THUMBNAIL_LANE ? browserOptions : undefined
}

/**
 * Defence in depth. Measured on 2026-09-15: the main process's V8 old-space limit is 4096MB
 * (`ELECTRON_RUN_AS_NODE=1 TalkWeaver -e '...heap_size_limit'`), and it is NOT raised by the
 * `--max-old-space-size` switch in index.ts, which reaches renderers only. Half of it is the
 * point at which one more full-deck inline can plausibly finish the job.
 */
export const THUMBNAIL_HEAP_GUARD_BYTES = 2048 * 1024 * 1024

export interface HeapGuardDecision {
  /** True when this pass must not prepare a deck. The caller returns `{}` for the talk. */
  skip: boolean
  /** Heap in whole MB, for the log line. */
  heapMb: number
}

/**
 * Whether a background thumbnail pass may prepare a deck at this heap level. Pure: heapUsed and
 * the threshold are both injected. At OR above the threshold the answer is skip — the renderer
 * treats an empty result as one retry and then the schematic fallback, so a skipped talk is a
 * missing picture for this pass, not a lost one.
 */
export function heapGuardDecision(
  heapUsedBytes: number,
  thresholdBytes: number = THUMBNAIL_HEAP_GUARD_BYTES
): HeapGuardDecision {
  const heapMb = Math.round(heapUsedBytes / (1024 * 1024))
  return { skip: Number.isFinite(heapUsedBytes) && heapUsedBytes >= thresholdBytes, heapMb }
}

/** How often the deferred lane re-reads the heap, and how long it is willing to wait. */
export const THUMBNAIL_HEAP_WAIT_INTERVAL_MS = 5_000
export const THUMBNAIL_HEAP_WAIT_MAX_MS = 180_000

export interface HeapWaitResult {
  /** True when the heap came back under the threshold in time. */
  proceeded: boolean
  waitedMs: number
  /** The last reading, in whole MB, for the log line. */
  heapMb: number
  /** How many times the heap was read, including the first. */
  reads: number
}

export interface HeapWaitOptions {
  intervalMs?: number
  maxMs?: number
  /** Injected for tests; default the real clock and a real timer. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Wait for the heap to come down, rather than giving up on the talk.
 *
 * The first guard (2026-09-15) returned an empty map the moment the heap was high — and the
 * Slide Browser counted that as one of a talk's two attempts, so a talk skipped while the editor
 * lane held a heavy deck in memory stayed on its schematic for the rest of the session. Deferring
 * is the honest answer: the background sweep is not urgent, the condition is temporary, and
 * nothing else is waiting on this particular talk. Only after `maxMs` does the pass give up, and
 * the renderer treats even that as "not now" rather than "never".
 *
 * Pure with respect to time: the clock and the sleep are injected, so the whole three minutes can
 * be exercised in a test without one.
 */
export async function waitForHeap(
  readHeapUsed: () => number,
  thresholdBytes: number = THUMBNAIL_HEAP_GUARD_BYTES,
  options: HeapWaitOptions = {}
): Promise<HeapWaitResult> {
  const intervalMs = options.intervalMs ?? THUMBNAIL_HEAP_WAIT_INTERVAL_MS
  const maxMs = options.maxMs ?? THUMBNAIL_HEAP_WAIT_MAX_MS
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const started = now()
  let reads = 0
  for (;;) {
    const decision = heapGuardDecision(readHeapUsed(), thresholdBytes)
    reads += 1
    const waitedMs = now() - started
    if (!decision.skip) return { proceeded: true, waitedMs, heapMb: decision.heapMb, reads }
    if (waitedMs >= maxMs) return { proceeded: false, waitedMs, heapMb: decision.heapMb, reads }
    await sleep(Math.min(intervalMs, Math.max(0, maxMs - waitedMs)))
  }
}
