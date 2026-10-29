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
// A child that answers nothing for the deadline (3 minutes) is retired the same way: killed, its jobs
// failed, replaced on the next compile, so the preparation gate never stays occupied.
//
// A child that dies (out of memory, a crash, killed) fails the jobs it held and is replaced on the next
// compile: one bad deck cannot leave compiles hanging, and, the child being a process of its own, it
// cannot take the main process down with it.
//
// How a child is started is passed in (spawn): the app passes Electron's utilityProcess
// (prepare-talk-utility-process.ts); tests pass a fake, or a plain Node child process. This file
// imports nothing of Electron, so plain-Node tests load it as it is.
import type { PrepareTalkJob, PrepareTalkReply } from './prepare-talk-worker'

export type PrepareTalkRequest = Omit<PrepareTalkJob, 'id'>
export type PrepareTalkAnswer = { model: Record<string, unknown>; rows: Array<Record<string, unknown>> | null; previewKey?: string }

const IDLE_MS = 60_000
const DEADLINE_MS = 180_000

/** The part of a child process used here: Electron's UtilityProcess has this shape. */
export interface CompileChild {
  /** Throws when the job cannot be copied to the child. */
  postMessage(message: PrepareTalkJob): void
  on(event: 'message', listener: (reply: PrepareTalkReply) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  /** A fatal error the child reports as it ends (Electron: type, location). Its exit follows. */
  on(event: 'error', listener: (type: string, location?: string) => void): unknown
  kill(): unknown
}
/** Starts a child running the compile script at `path`. */
export type SpawnCompileChild = (path: string) => CompileChild

type Waiting = { resolve: (answer: PrepareTalkAnswer) => void; reject: (error: Error) => void }
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
    for (const job of jobs) job.reject(error)
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
      const job = slot.jobs.get(reply.id)
      if (!job) return
      slot.jobs.delete(reply.id)
      if (reply.ok) job.resolve({ model: reply.model, rows: reply.rows, previewKey: reply.previewKey })
      else job.reject(new Error(reply.error))
      armIdle()
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

  return function prepareTalkOffThread(request: PrepareTalkRequest): Promise<PrepareTalkAnswer> {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    return new Promise<PrepareTalkAnswer>((resolve, reject) => {
      let slot: Slot
      try {
        slot = (current ??= start())
      } catch (error) {
        // The child could not be started: this compile fails, the next one tries again.
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const id = nextId++
      const job: PrepareTalkJob = { id, ...request }
      // The deadline ends with the job: whichever way it settles, its timer goes.
      const timer: NodeJS.Timeout = setTimeout(() => expire(slot), deadlineMs)
      slot.jobs.set(id, {
        resolve: (answer) => { clearTimeout(timer); resolve(answer) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      try {
        slot.child.postMessage(job)
      } catch (error) {
        // Options that cannot be copied to the child: this compile fails, the child stays.
        slot.jobs.delete(id)
        clearTimeout(timer)
        armIdle()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
