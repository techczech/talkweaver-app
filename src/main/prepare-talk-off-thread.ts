// The main process's side of the live compile's own process (prepare-talk-worker.ts says why).
//
// One child process, started on the first compile, reused while compiles keep coming, ended after a
// quiet minute (it holds the compiler's modules, nothing of a deck once a job is answered). The
// preparation gate in index.ts already lets only one compile run at a time; the child answers jobs by
// id, so a second job sent while one is running would simply wait in the child's own queue.
//
// Jobs belong to the child that runs them: each child has its own table of waiting jobs, and a child
// ended on purpose (the idle end) fails nothing when its exit arrives late, so a compile that started a
// new child in the meantime is never failed by the old one.
//
// A child that gives a compile no answer for 3 minutes is retired the same way, so the preparation
// gate never stays occupied. A focused preview has its own deadline and cancels only its own job.
//
// A child that dies (out of memory, a crash, killed) fails the jobs it held and is replaced on the next
// compile: one bad deck cannot leave compiles hanging, and, the child being a process of its own, it
// cannot take the main process down with it.
//
// How a child is started is passed in (spawn): the app passes Electron's utilityProcess
// (prepare-talk-utility-process.ts); tests pass a fake, or a plain Node child process. This file
// imports nothing of Electron, so plain-Node tests load it as it is.
import type { MarkedPreview, MarkPreviewRequest, PrepareTalkJob, PrepareTalkMessage, PrepareTalkReply } from './prepare-talk-worker'
import type { PreviewVariant } from './preview-variant'

export type PrepareTalkRequest = Omit<PrepareTalkJob, 'id'>
export type PrepareTalkAnswer = {
  model: Record<string, unknown>
  rows: Array<Record<string, unknown>> | null
  previewKey?: string
  previewReady?: Promise<PreviewVariant | undefined>
}
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never
type Message = WithoutId<PrepareTalkMessage>
type Artwork = (url: string, signal: AbortSignal) => Promise<string | null>

const IDLE_MS = 60_000
const DEADLINE_MS = 180_000
const VARIANT_DEADLINE_MS = 15_000

/** The part of a child process used here: Electron's UtilityProcess has this shape. */
export interface CompileChild {
  /** Throws when the job cannot be copied to the child. */
  postMessage(message: PrepareTalkMessage): void
  on(event: 'message', listener: (reply: PrepareTalkReply) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  /** A fatal error the child reports as it ends (Electron: type, location). Its exit follows. */
  on(event: 'error', listener: (type: string, location?: string) => void): unknown
  kill(): unknown
}
/** Starts a child running the compile script at `path`. */
export type SpawnCompileChild = (path: string) => CompileChild

type Waiting = {
  reply: (answer: PrepareTalkReply) => void
  fail: (error: Error) => void
  timeout?: () => void
}
type Job<T> = {
  resolve: (answer: T) => void
  reject: (error: Error) => void
  send: (message: Message) => void
  finish: () => void
  variantDeadline: () => void
}
type Slot = { child: CompileChild; jobs: Map<number, Waiting>; retired: boolean }

function formatLimit(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${ms / 1000} seconds`
}

export function createPrepareTalkOffThread(childPath: string, spawn: SpawnCompileChild, idleMs = IDLE_MS, deadlineMs = DEADLINE_MS) {
  let current: Slot | null = null
  let idleTimer: NodeJS.Timeout | null = null
  let nextId = 1

  function failAll(slot: Slot, error: Error): void {
    const jobs = [...slot.jobs.values()]
    slot.jobs.clear()
    for (const job of jobs) job.fail(error)
  }
  /** A job that gets no answer in time: the child is retired and killed, every job it held fails. */
  function expire(slot: Slot): void {
    if (slot.retired) return
    slot.retired = true
    drop(slot)
    try { slot.child.kill() } catch { /* already gone */ }
    failAll(slot, new Error(`The talk could not be compiled (the compile took longer than ${formatLimit(deadlineMs)}).`))
    armIdle()
  }
  function drop(slot: Slot): void {
    if (current === slot) current = null
  }
  function start(): Slot {
    const slot: Slot = { child: spawn(childPath), jobs: new Map(), retired: false }
    slot.child.on('message', (reply: PrepareTalkReply) => {
      slot.jobs.get(reply.id)?.reply(reply)
    })
    slot.child.on('error', (type: string, location?: string) => {
      // The child is ending (its exit follows): no new job goes to it.
      drop(slot)
      if (slot.retired) return
      failAll(slot, new Error(`The talk could not be compiled (the compile stopped: ${type}${location ? ` at ${location}` : ''}).`))
    })
    slot.child.on('exit', (code: number) => {
      drop(slot)
      // Ended on purpose: it held no job, and whatever runs now belongs to another child.
      if (slot.retired) return
      failAll(slot, new Error(`The talk could not be compiled (the compile stopped with code ${code}).`))
    })
    return slot
  }
  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    if (current && current.jobs.size > 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (!current || current.jobs.size > 0) return
      const ending = current
      current = null
      ending.retired = true
      try { ending.child.kill() } catch { /* already gone */ }
    }, idleMs)
    idleTimer.unref?.()
  }

  function submit<T>(request: Message, listen: (job: Job<T>) => Waiting): Promise<T> {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    return new Promise<T>((resolve, reject) => {
      let slot: Slot
      try {
        slot = (current ??= start())
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const id = nextId++
      let timer: ReturnType<typeof setTimeout>
      const finish = (): void => {
        clearTimeout(timer)
        slot.jobs.delete(id)
        armIdle()
      }
      const send = (message: Message): void => slot.child.postMessage({ ...message, id })
      const waiting = listen({
        resolve, reject, finish, send,
        variantDeadline: () => {
          clearTimeout(timer)
          timer = setTimeout(() => expire(slot), Math.min(VARIANT_DEADLINE_MS, deadlineMs))
        }
      })
      timer = setTimeout(() => {
        if (waiting.timeout) waiting.timeout()
        else expire(slot)
      }, deadlineMs)
      slot.jobs.set(id, waiting)
      try { send(request) } catch (error) {
        waiting.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function prepareTalkOffThread(request: PrepareTalkRequest, signal?: AbortSignal): Promise<PrepareTalkAnswer> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    return submit<PrepareTalkAnswer>(request, ({ resolve, reject, finish, send, variantDeadline }) => {
      const done = (): void => {
        signal?.removeEventListener('abort', cancel)
        finish()
      }
      const cancel = (): void => {
        try { send({ kind: 'cancel-preview' }) } catch { /* the child has already stopped */ }
        fail(new Error('Preview cancelled'))
      }
      signal?.addEventListener('abort', cancel, { once: true })
      let resolveVariant: ((preview?: PreviewVariant) => void) | undefined
      const fail = (error: Error): void => {
        done()
        if (resolveVariant) resolveVariant()
        else reject(error)
      }
      return {
        fail,
        reply: (answer) => {
          if (answer.kind === 'variant' && resolveVariant) {
            done()
            resolveVariant(answer.preview)
          }
          if (answer.kind !== undefined || resolveVariant) return
          if (!answer.ok) { fail(new Error(answer.error)); return }
          let previewReady: PrepareTalkAnswer['previewReady']
          if (answer.pendingPreview) {
            previewReady = new Promise((ready) => { resolveVariant = ready })
            variantDeadline()
          } else {
            done()
          }
          resolve({ model: answer.model, rows: answer.rows, previewKey: answer.previewKey, previewReady })
        }
      }
    })
  }

  function markPreview(request: MarkPreviewRequest, artwork: Artwork, signal: AbortSignal): Promise<MarkedPreview> {
    if (signal.aborted) return Promise.reject(new Error('Preview cancelled'))
    return submit<MarkedPreview>({ kind: 'mark-preview', ...request }, ({ resolve, reject, finish, send }) => {
      const capture = new AbortController()
      const done = (): void => {
        signal.removeEventListener('abort', cancel)
        capture.abort()
        finish()
      }
      const fail = (error: Error): void => { done(); reject(error) }
      const abandon = (message: string): void => {
        try { send({ kind: 'cancel-preview' }) } catch { /* the compile process has already ended */ }
        fail(new Error(message))
      }
      const cancel = (): void => abandon('Preview cancelled')
      signal.addEventListener('abort', cancel, { once: true })
      return {
        fail,
        timeout: () => abandon(`The slide preview took longer than ${formatLimit(deadlineMs)}.`),
        reply: (answer) => {
          if (answer.kind === 'artwork') {
            void artwork(answer.url, capture.signal).catch(() => null).then((image) => {
              if (capture.signal.aborted) return
              try { send({ kind: 'artwork-answer', image }) } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)))
              }
            })
          } else if (answer.kind === 'marked-preview') {
            done()
            resolve(answer.document)
          } else if (answer.kind === undefined && !answer.ok) {
            fail(new Error(answer.error))
          }
        }
      }
    })
  }

  return Object.assign(prepareTalkOffThread, { markPreview })
}
