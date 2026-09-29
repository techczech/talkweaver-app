// Outline writes, one at a time per outline file (live-presenting ticket 07). Every `talk:write-outline`
// the renderer sends — the editor's debounced autosave, flushSave, an "Add to talk" insertion routed through
// the open buffer, and every workspace write — runs through one queue, so a write is never sent while another is still in
// flight and an older buffer can never land on disk after a newer one. `settled()` resolves once
// every write queued so far has finished (success or failure); a caller that plans against the
// buffer waits for it first, so it sees the buffer after any stamped-id adoption a save brings back.
export interface SaveQueue {
  /** Runs `write` after every write queued before it has finished; resolves with its own result. */
  run<T>(write: () => Promise<T>): Promise<T>
  /** Resolves when every write queued so far has finished. Never rejects. */
  settled(): Promise<void>
  /** True while a queued write has not yet finished. */
  busy(): boolean
}

export function createSaveQueue(): SaveQueue {
  let tail: Promise<void> = Promise.resolve()
  let pending = 0
  return {
    run<T>(write: () => Promise<T>): Promise<T> {
      pending += 1
      const result = tail.then(write)
      tail = result.then(() => undefined, () => undefined).finally(() => { pending -= 1 })
      return result
    },
    settled: () => tail,
    busy: () => pending > 0,
  }
}

// One queue per outline FILE, shared by every writer in this window: the Editor (autosave,
// flushSave, "Add to talk" through the open buffer) and the workspace (drag-reorder, search and
// archive inserts, icon pins, grid undo, deck design). A write made before an instant-slide save
// therefore always lands before it, never after (live-presenting ticket 07).
//
// "File", not "path string": one outline can be reached through a symlink, a linked folder, a second
// hard link and its real path, so queues are keyed by the file's identity key (device + inode), which
// the main process resolves (outline-identity.ts). The key is resolved again on EVERY write — never
// cached — so a symlink retargeted while the talk is open lands in its new file's queue on its next
// write (one-writer spec D3). Writes are handed to their queue strictly in call order, even while an
// earlier resolution is still in flight, so two aliases can never race.
const outlineQueues = new Map<string, SaveQueue>()
// Every write and settle request passes through this chain before it reaches its queue.
let handOff: Promise<unknown> = Promise.resolve()

type OutlinePathResolver = (outlinePath: string) => Promise<string | null | undefined>

// Default: the main process's identity key (window.tw.outline.identity). Absent (the browser-only dev
// mock, headless tests) or failing, the path string itself is the key.
type OutlineBridge = { identity?: (outlinePath: string) => Promise<{ key: string } | null | undefined> }
const bridgeResolver: OutlinePathResolver = async (outlinePath) => {
  const bridge = (globalThis as { window?: { tw?: { outline?: OutlineBridge } } }).window?.tw?.outline
  return bridge?.identity ? (await bridge.identity(outlinePath))?.key : outlinePath
}
let resolver: OutlinePathResolver = bridgeResolver

/** Replaces how outline paths are resolved to queue keys (tests); null restores the bridge. */
export function setOutlinePathResolver(next: OutlinePathResolver | null): void {
  resolver = next ?? bridgeResolver
}

/** The queue key for `outlinePath`: its file identity key, resolved now (one main-process stat). */
export function outlineQueueKey(outlinePath: string): Promise<string> {
  return Promise.resolve()
    .then(() => resolver(outlinePath))
    .then((key) => key || outlinePath, () => outlinePath)
}

// Resolves the key after every earlier write/settle request has been handed to its queue.
function keyInOrder(outlinePath: string): Promise<string> {
  const key = handOff.then(() => outlineQueueKey(outlinePath))
  handOff = key.catch(() => undefined)
  return key
}

/** The shared save queue for the canonical key `key` (created on first use). */
export function outlineSaveQueue(key: string): SaveQueue {
  let queue = outlineQueues.get(key)
  if (!queue) {
    queue = createSaveQueue()
    outlineQueues.set(key, queue)
  }
  return queue
}

/** Runs `write` (an outline write for `outlinePath`) through that file's shared queue. */
export function queueOutlineWrite<T>(outlinePath: string, write: () => Promise<T>): Promise<T> {
  return keyInOrder(outlinePath).then((key) => outlineSaveQueue(key).run(write))
}

/** Resolves once every write queued so far for `outlinePath`'s file — under any alias — has finished. */
export function outlineWritesSettled(outlinePath: string): Promise<void> {
  return keyInOrder(outlinePath).then((key) => outlineSaveQueue(key).settled())
}
