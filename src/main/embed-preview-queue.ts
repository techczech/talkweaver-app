/** One active capture and a bounded waiting list; an obsolete caller owns its cancellation. */
export function createEmbedPreviewQueue(
  capture: (url: string, signal: AbortSignal) => Promise<string | null>,
  maxJobs = 8
) {
  type Job = { url: string; signal?: AbortSignal; controller: AbortController; resolve: (image: string | null) => void; stop: () => void }
  const waiting: Job[] = []
  let active: Job | null = null
  const drain = async (): Promise<void> => {
    if (active) return
    const job = waiting.shift()
    if (!job) return
    active = job
    try {
      const image = job.controller.signal.aborted ? null : await capture(job.url, job.controller.signal)
      job.resolve(job.controller.signal.aborted ? null : image)
    } catch { job.resolve(null) } finally {
      job.signal?.removeEventListener('abort', job.stop)
      active = null
      void drain()
    }
  }
  return (url: string, signal?: AbortSignal): Promise<string | null> => {
    if (signal?.aborted || waiting.length + (active ? 1 : 0) >= maxJobs) return Promise.resolve(null)
    return new Promise(resolve => {
      const controller = new AbortController()
      const job: Job = { url, signal, controller, resolve, stop: () => {
        controller.abort()
        const index = waiting.indexOf(job)
        if (index >= 0) waiting.splice(index, 1)
        signal?.removeEventListener('abort', job.stop)
        resolve(null)
      } }
      signal?.addEventListener('abort', job.stop, { once: true })
      waiting.push(job)
      void drain()
    })
  }
}
