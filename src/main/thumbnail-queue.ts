type ThumbnailResult = Record<string, string>

/** How urgently a render is wanted. `normal`: the editor strip and the Slide Browser. `background`: a
 *  layout variant (the picker's and the Inspector's pictures of the slide). `idle`: the background
 *  prewarm (thumbnail-prewarm.ts), which nobody is waiting for. */
export type ThumbnailPriority = 'normal' | 'background' | 'idle'

export interface ThumbnailQueue<T> {
  /** `background`: true for a layout variant, 'idle' for the prewarm. */
  (options: T, owner?: string, background?: boolean | 'idle'): Promise<ThumbnailResult>
  /** True while any render other than an idle one is running or waiting. */
  foregroundBusy(): boolean
  /** When a render other than an idle one was last asked for (the queue's clock), 0 if never. */
  lastForegroundAt(): number
  /** Stop the owner's render: a running one is aborted (it settles with what it has), a waiting one
   *  settles with nothing. */
  cancel(owner: string): void
}

/** One renderer, one pending document per editor; replaced callers still settle. A `background`
 *  job (a layout variant: the picker's and the Inspector's pictures of the slide) starts only when no
 *  normal job is pending, so the editor strip and the Slide Browser never wait behind a QUEUED variant;
 *  at most the one render already running (renders are not interrupted) finishes first. The variant's
 *  compile before it is ordered the same way, on the preparation gate's background lane
 *  (prepared-talk-cache.ts, createPreparationRoute).
 *
 *  An `idle` job (the prewarm) starts only when nothing else is waiting, and a running idle job IS
 *  interrupted the moment any other render is asked for: its signal aborts between two slides, the
 *  slides it finished stay written, and the newcomer starts next. Nobody waits behind the prewarm for
 *  longer than one slide. */
export function createThumbnailQueue<T>(
  render: (options: T, signal: AbortSignal) => Promise<ThumbnailResult>,
  now: () => number = () => Date.now()
): ThumbnailQueue<T> {
  type Job = {
    key: string | symbol
    priority: ThumbnailPriority
    options: T
    controller: AbortController
    resolve: (result: ThumbnailResult) => void
    reject: (error: unknown) => void
  }
  const pending = new Map<string | symbol, Job>()
  let active: Job | null = null
  let lastForeground = 0
  const rank: Record<ThumbnailPriority, number> = { normal: 0, background: 1, idle: 2 }
  async function drain(): Promise<void> {
    if (active) return
    let next: Job | undefined
    for (const job of pending.values()) {
      if (!next || rank[job.priority] < rank[next.priority]) next = job
      if (next.priority === 'normal') break
    }
    if (!next) return
    pending.delete(next.key)
    active = next
    try {
      const result = await render(next.options, next.controller.signal)
      next.resolve(next.controller.signal.aborted ? {} : result)
    } catch (error) {
      if (next.controller.signal.aborted) next.resolve({})
      else next.reject(error)
    } finally {
      active = null
      void drain()
    }
  }
  const enqueue = ((options: T, owner?: string, background: boolean | 'idle' = false): Promise<ThumbnailResult> => {
    const priority: ThumbnailPriority = background === 'idle' ? 'idle' : background ? 'background' : 'normal'
    const key = owner ?? Symbol()
    if (priority !== 'idle') {
      lastForeground = now()
      // Anything anyone is waiting for goes ahead of the prewarm, including the slide it is on.
      if (active && active.priority === 'idle' && active.key !== key) active.controller.abort()
    }
    if (active?.key === key) active.controller.abort()
    const replaced = pending.get(key)
    if (replaced) {
      pending.delete(key)
      replaced.resolve({})
    }
    return new Promise((resolve, reject) => {
      pending.set(key, { key, priority, options, controller: new AbortController(), resolve, reject })
      void drain()
    })
  }) as ThumbnailQueue<T>
  enqueue.foregroundBusy = () =>
    (active !== null && active.priority !== 'idle') || [...pending.values()].some((job) => job.priority !== 'idle')
  enqueue.lastForegroundAt = () => lastForeground
  enqueue.cancel = (owner: string) => {
    if (active?.key === owner) active.controller.abort()
    const waiting = pending.get(owner)
    if (waiting) {
      pending.delete(owner)
      waiting.resolve({})
    }
  }
  return enqueue
}

/** Establish recency before async preparation, which can finish out of order. */
export function createLatestThumbnailRequestHandler<Input, Prepared, Result>(
  prepare: (input: Input) => Promise<Prepared>,
  render: (input: Input, prepared: Prepared, owner: string, isCurrent: () => boolean) => Promise<Result>,
  cancelledResult: Result
): (owner: string, input: Input) => Promise<Result> {
  const latest = new Map<string, symbol>()
  return async (owner, input) => {
    const token = Symbol()
    latest.set(owner, token)
    const isCurrent = (): boolean => latest.get(owner) === token
    try {
      const prepared = await prepare(input)
      if (!isCurrent()) return cancelledResult
      const result = await render(input, prepared, owner, isCurrent)
      return isCurrent() ? result : cancelledResult
    } catch (error) {
      if (!isCurrent()) return cancelledResult
      throw error
    } finally {
      if (isCurrent()) latest.delete(owner)
    }
  }
}
