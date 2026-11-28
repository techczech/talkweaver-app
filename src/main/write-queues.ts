// Updating in place (ADR-0044 §6, rule C): every write queue in the main process, in one table, so that an update's
// restart can wait for each to finish before the native install is called. Before this, preference writes were
// waited for only in 'will-quit', for at most three seconds, after the install had already been asked for; the
// Scratchpad and Pathways queues and the others were not waited for at all.
//
// A queue reports each piece of work it starts with `trackWrite(name, work)`; a queue whose work is not a promise
// (the debounced config writes, the settings store's own writes) registers a `drainHook`. `drainWriteQueues` then
// waits until every queue is idle; `writeQueuesBusy` says, synchronously, which are not (the engine reads it in the
// turn of the native call). No Electron here: scripts/test-write-queues.mjs drives it.
//
// The source scan in scripts/test-write-queues.mjs finds every queue idiom in src/main (a promise chain, a serial
// runner, a map of per-key chains) and fails for one whose file is not in QUEUE_SOURCES below, so a new queue cannot
// slip in unwaited. The table in ADR-0044 §6 lists the same names.

/** Every write queue the restart waits for. */
export const WRITE_QUEUES = {
  'config-debounce': 'window sizes and other config.json writes waiting for their debounce (index.ts debouncedConfigWrite)',
  'settings-overlay': 'preference writes main makes through readConfig / writeConfig (settings-overlay.ts)',
  'settings-store': 'the settings store’s own writes, Settings window changes included (@app-patterns/settings SettingsStore)',
  'talk-writer': 'talk writes main makes (tags, details, image changes, routed edits; talk-writer.ts)',
  'outline-recovery': 'recovery copies of text a refused save kept (outline-recovery.ts)',
  scratchpad: 'Slide Scratchpad changes (scratchpad-store.ts)',
  pathways: 'Pathways manifest changes (index.ts mutatePathways)',
  research: 'research captures written into a talk’s folder (research-writer.ts)',
  'feedback-mirror': 'the feedback mirror’s file writes (feedback-mirror.ts)',
  'setup-folder': 'the setup folder’s record and shared preferences (setup-folder.ts)',
  'keyed-queue': 'Run results, prework and the publishing connection’s saved settings (owner-tokens.ts createKeyedQueue)',
  'live-page-capture': 'a live page view saved into a talk (live-page-capture.ts)',
  'shared-talk': 'a shared talk’s push and its saved revision (shared-talk-state.ts chains)',
} as const
export type WriteQueueName = keyof typeof WRITE_QUEUES
export const WRITE_QUEUE_NAMES = Object.keys(WRITE_QUEUES) as WriteQueueName[]

type NotAQueue = `not a write queue: ${string}`
/**
 * Every queue idiom in src/main (`let queue|chain|tail: Promise<…>`, `new Map<…, Promise<…>>`), file by file in the
 * order they appear: the write queue it is, or why it is not one. scripts/test-write-queues.mjs scans the sources and
 * fails for any file whose idioms do not match this list one for one, so a new queue cannot slip in unwaited.
 */
export const QUEUE_SOURCES: Record<string, ReadonlyArray<WriteQueueName | NotAQueue>> = {
  'src/main/index.ts': ['pathways'],
  'src/main/settings-overlay.ts': ['settings-overlay'],
  'src/main/talk-writer.ts': ['talk-writer', 'talk-writer'],
  'src/main/outline-recovery.ts': ['outline-recovery'],
  'src/main/scratchpad-store.ts': ['scratchpad'],
  'src/main/research-writer.ts': ['research'],
  'src/main/feedback-mirror.ts': ['feedback-mirror'],
  'src/main/setup-folder.ts': ['setup-folder'],
  'src/main/owner-tokens.ts': ['keyed-queue'],
  'src/main/cloudflare-connection.ts': ['not a write queue: the last keyed-queue turn, already counted as keyed-queue'],
  'src/main/live-page-capture.ts': ['live-page-capture'],
  'src/main/shared-talk-state.ts': ['shared-talk'],
  'src/main/handout-publishing.ts': ['not a write queue: a publish run; the publishing blocker holds the restart while one runs'],
  'src/main/scratchpad-html-thumb.ts': ['not a write queue: thumbnail pictures in a cache folder, made again when missing', 'not a write queue: the same thumbnail captures, one at a time'],
  'src/main/prepare-talk-worker.ts': ['not a write queue: compiler modules loaded once'],
  'src/main/search-rows-off-process.ts': ['not a write queue: shared read-only compiles for the rebuildable search index'],
  'src/main/local-address-filter.ts': ['not a write queue: address lookups in flight'],
  'src/main/recording-video.ts': ['not a write queue: loudness measures kept in memory', 'not a write queue: playback copies in the app’s cache, made again when missing', 'not a write queue: the same playback copies, levelled'],
  'src/main/gallery-site.ts': ['not a write queue: site listings read for the gallery'],
}

interface QueueState { running: number; failedSince: number; waiters: Array<() => void> }
const states = new Map<WriteQueueName, QueueState>()
const stateOf = (name: WriteQueueName): QueueState => {
  let s = states.get(name)
  if (!s) { s = { running: 0, failedSince: 0, waiters: [] }; states.set(name, s) }
  return s
}

/** Work a queue has started: counted until it settles. Returns `work` unchanged. */
export function trackWrite<T>(name: WriteQueueName, work: Promise<T>): Promise<T> {
  const s = stateOf(name)
  s.running += 1
  const done = (failed: boolean): void => {
    s.running -= 1
    if (failed) s.failedSince += 1
    if (s.running === 0) for (const wake of s.waiters.splice(0)) wake()
  }
  work.then(() => done(false), () => done(true))
  return work
}

/** A queue whose work is not a promise: whether it is idle now, and how to finish it (true when everything it held
 *  was written). */
export interface DrainHook { idle(): boolean; drain(): Promise<boolean> }
const hooks = new Map<WriteQueueName, DrainHook>()
export function registerDrainHook(name: WriteQueueName, hook: DrainHook): void { hooks.set(name, hook) }

/** The queues with work in flight now (the engine reads this in the turn of the native call). */
export function writeQueuesBusy(): WriteQueueName[] {
  const busy: WriteQueueName[] = []
  for (const name of WRITE_QUEUE_NAMES) {
    const s = states.get(name)
    let hookBusy = false
    try { hookBusy = hooks.has(name) && !hooks.get(name)!.idle() } catch { hookBusy = true }
    if ((s && s.running > 0) || hookBusy) busy.push(name)
  }
  return busy
}

export interface DrainOutcome {
  ok: boolean
  /** Queues whose work failed while the restart waited, or whose drain answered false or threw. */
  failed: WriteQueueName[]
  /** Queues still busy when the time ran out. */
  timedOut: WriteQueueName[]
}

/** Failure counts before the restart begins closing windows; retained through its final gate. */
export type WriteFailureBaseline = ReadonlyMap<WriteQueueName, number>
export function snapshotWriteFailures(): WriteFailureBaseline {
  return new Map(WRITE_QUEUE_NAMES.map((name) => [name, stateOf(name).failedSince]))
}
export function writeQueueFailuresSince(baseline: WriteFailureBaseline): WriteQueueName[] {
  return WRITE_QUEUE_NAMES.filter((name) => stateOf(name).failedSince !== baseline.get(name))
}

/**
 * Waits for every queue to finish what it holds (hooks drain first: a debounced write starts a tracked one). OK only
 * when every hook answered true, no queue's work failed while waiting, and every queue is idle at the end, within
 * `timeoutMs`.
 */
export async function drainWriteQueues(timeoutMs: number, failedAtStart: WriteFailureBaseline = snapshotWriteFailures()): Promise<DrainOutcome> {
  const failed = new Set<WriteQueueName>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), timeoutMs) })
  const settle = async (): Promise<void> => {
    for (const [name, hook] of hooks) {
      let ok = false
      try { ok = (await hook.drain()) === true } catch { ok = false }
      if (!ok) failed.add(name)
    }
    // Work that settles may start more (a recovery copy after a refused write): wait until all are idle at once.
    for (let round = 0; round < 50; round++) {
      const busy = WRITE_QUEUE_NAMES.filter((n) => stateOf(n).running > 0)
      if (busy.length === 0) return
      await Promise.all(busy.map((n) => new Promise<void>((wake) => {
        const s = stateOf(n)
        if (s.running === 0) wake(); else s.waiters.push(wake)
      })))
    }
  }
  const outcome = await Promise.race([settle().then(() => 'done' as const), deadline])
  clearTimeout(timer)
  for (const name of writeQueueFailuresSince(failedAtStart)) failed.add(name)
  const timedOut = outcome === 'late' ? writeQueuesBusy() : []
  const busyNow = writeQueuesBusy()
  return { ok: failed.size === 0 && timedOut.length === 0 && busyNow.length === 0, failed: [...failed], timedOut: outcome === 'late' ? timedOut : busyNow }
}

/** Tests only: forget every count and hook. */
export function resetWriteQueuesForTest(): void { states.clear(); hooks.clear() }
