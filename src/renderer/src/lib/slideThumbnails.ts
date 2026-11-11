// One renderer route for compiled slide pictures. Live buffers keep their own lane; source talks
// share one missing-picture queue. Concrete outline paths and portable source identities stay distinct.
import { createThumbRegenQueue } from './thumbnailRegenQueue.ts'

type ThumbMap = Record<string, string> | null
const inFlight = new Map<string, { outlinePath: string; content: string; request: Promise<ThumbMap> }>()
export function requestSlideThumbnails(outlinePath: string, content: string, opts?: { lane?: string; requestId?: string }): Promise<ThumbMap> {
  // Main supersedes by window + lane, across documents. Only its latest request is shareable:
  // A -> B -> Undo A must issue a new A, since the first A has already been superseded.
  const key = typeof opts?.lane === 'string' && /^[a-z-]{1,32}$/.test(opts.lane) ? opts.lane : ''
  const held = inFlight.get(key)
  if (!opts?.requestId && held?.outlinePath === outlinePath && held.content === content) return held.request
  const request = Promise.resolve().then(() => window.tw.talk.thumbnails(outlinePath, content, opts))
  inFlight.set(key, { outlinePath, content, request })
  void request.finally(() => { if (inFlight.get(key)?.request === request) inFlight.delete(key) }).catch(() => undefined)
  return request
}

type SourceResolver = () => Promise<{ path: string; content: string } | null>
interface SourceClient {
  paths: Set<string>
  resolvers: Map<string, SourceResolver>
  rendered: (path: string, map: Record<string, string>, sourcePath: string) => void
  busy?: (path: string | null) => void
}
const clients = new Set<SourceClient>()
const queue = createThumbRegenQueue()
let running = false
let timer: ReturnType<typeof setTimeout> | null = null
const interested = (path: string): SourceClient[] => [...clients].filter(c => c.paths.has(path))

async function drain(): Promise<void> {
  if (running) return
  if (timer) { clearTimeout(timer); timer = null }
  running = true
  try {
    while (clients.size > 0) {
      const step = queue.next(Date.now())
      if (step.kind === 'idle') break
      if (step.kind === 'wait') {
        timer = setTimeout(() => { timer = null; void drain() }, Math.max(step.ms, 50))
        break
      }
      const path = step.outlinePath
      if (interested(path).length === 0) { queue.settle(path, { rendered: 1 }, Date.now()); continue }
      for (const c of interested(path)) c.busy?.(path)
      let map: ThumbMap = null
      let sourcePath = path
      const resolver = interested(path).map(c => c.resolvers.get(path)).find(Boolean)
      try {
        const source = resolver ? await resolver() : await window.tw.talk.readOutline(path).then(content => content == null ? null : { path, content })
        if (source && interested(path).length > 0) {
          sourcePath = source.path
          map = await requestSlideThumbnails(source.path, source.content, { lane: 'browser' })
        }
      } catch { /* one unreadable source does not stall other talks */ }
      const settled = queue.settle(path, { rendered: map ? Object.keys(map).length : resolver ? 0 : null }, Date.now())
      for (const c of interested(path)) {
        if (settled.bumpNonce && map) c.rendered(path, map, sourcePath)
        c.busy?.(null)
      }
    }
  } finally {
    running = false
    if (clients.size === 0) queue.reset()
  }
}

/** A surface owns its subscriptions, never its own renderer or retry policy. */
export function sourceThumbnailClient(rendered: SourceClient['rendered'], busy?: SourceClient['busy']) {
  const client: SourceClient = { paths: new Set(), resolvers: new Map(), rendered, busy }
  clients.add(client)
  const reset = (): void => { client.paths.clear(); client.resolvers.clear(); busy?.(null) }
  return {
    note(path: string, resolver?: SourceResolver): void {
      if (!clients.has(client)) return
      const fresh = !client.paths.has(path)
      client.paths.add(path)
      if (resolver) client.resolvers.set(path, resolver)
      // A new opening may retry a source completed or abandoned by an earlier opening.
      if (fresh) queue.forget(path)
      queue.note(path, path, resolver ? { attemptsMax: 2, deferDelayMs: 15_000 } : undefined)
      void drain()
    },
    reset,
    dispose(): void {
      reset(); clients.delete(client)
      if (clients.size === 0) {
        if (timer) { clearTimeout(timer); timer = null }
        if (!running) queue.reset()
      }
    }
  }
}
