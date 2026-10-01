type ThumbnailResult = Record<string, string>

/** One renderer, one pending document per editor; replaced callers still settle. A `background`
 *  job (a layout variant: the picker's and the Inspector's pictures of the slide) starts only when no
 *  normal job is pending, so the editor strip and the Slide Browser never wait behind a QUEUED variant;
 *  at most the one render already running (renders are not interrupted) finishes first. The variant's
 *  compile before it is ordered the same way, on the preparation gate's background lane
 *  (prepared-talk-cache.ts, createPreparationRoute). */
export function createThumbnailQueue<T>(render: (options: T, signal: AbortSignal) => Promise<ThumbnailResult>) {
  type Job = {
    key: string | symbol
    background: boolean
    options: T
    controller: AbortController
    resolve: (result: ThumbnailResult) => void
    reject: (error: unknown) => void
  }
  const pending = new Map<string | symbol, Job>()
  let active: Job | null = null
  async function drain(): Promise<void> {
    if (active) return
    let next: Job | undefined
    for (const job of pending.values()) {
      if (!job.background) { next = job; break }
      next ??= job
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
  return (options: T, owner?: string, background = false): Promise<ThumbnailResult> => {
    const key = owner ?? Symbol()
    if (active?.key === key) active.controller.abort()
    const replaced = pending.get(key)
    if (replaced) {
      pending.delete(key)
      replaced.resolve({})
    }
    return new Promise((resolve, reject) => {
      pending.set(key, { key, background, options, controller: new AbortController(), resolve, reject })
      void drain()
    })
  }
}

/** Establish recency before async preparation, which can finish out of order. */
export function createLatestThumbnailRequestHandler<Input, Prepared, Result>(
  prepare: (input: Input) => Promise<Prepared>,
  render: (input: Input, prepared: Prepared, owner: string) => Promise<Result>,
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
      const result = await render(input, prepared, owner)
      return isCurrent() ? result : cancelledResult
    } catch (error) {
      if (!isCurrent()) return cancelledResult
      throw error
    } finally {
      if (isCurrent()) latest.delete(owner)
    }
  }
}
