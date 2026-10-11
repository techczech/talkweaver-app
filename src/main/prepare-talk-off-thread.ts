// The main process's side of the live compile's worker thread (prepare-talk-worker.ts says why).
//
// One worker, started on the first compile, reused while compiles keep coming, ended after a quiet
// minute (it holds the compiler's modules, nothing of a deck once a job is answered). The preparation
// gate in index.ts already lets only one compile run at a time; the worker answers jobs by id, so a
// second job sent while one is running would simply wait in the worker's own queue.
//
// Jobs belong to the worker that runs them: each worker has its own table of waiting jobs, and a
// worker ended on purpose (the idle end) fails nothing when its exit arrives late, so a compile that
// started a new worker in the meantime is never failed by the old one.
//
// A worker that dies (an error thrown outside a job, out of memory, ended) fails the jobs it held and
// is replaced on the next compile: one bad deck cannot leave compiles hanging.
import { Worker } from 'node:worker_threads'
import type { PrepareTalkJob, PrepareTalkReply } from './prepare-talk-worker'

export type PrepareTalkRequest = Omit<PrepareTalkJob, 'id'>
export type PrepareTalkAnswer = { model: Record<string, unknown>; rows: Array<Record<string, unknown>> | null; previewKey?: string }

const IDLE_MS = 60_000

type Waiting = { resolve: (answer: PrepareTalkAnswer) => void; reject: (error: Error) => void }
type Slot = { worker: Worker; jobs: Map<number, Waiting>; retired: boolean }
/** The part of the Worker class used here; tests pass a fake. */
export type WorkerClass = new (path: string) => Worker

export function createPrepareTalkOffThread(workerPath: string, idleMs = IDLE_MS, WorkerImpl: WorkerClass = Worker) {
  let current: Slot | null = null
  let idleTimer: NodeJS.Timeout | null = null
  let nextId = 1

  function failAll(slot: Slot, error: Error): void {
    const jobs = [...slot.jobs.values()]
    slot.jobs.clear()
    for (const job of jobs) job.reject(error)
  }
  function drop(slot: Slot): void {
    if (current === slot) current = null
  }
  function start(): Slot {
    const slot: Slot = { worker: new WorkerImpl(workerPath), jobs: new Map(), retired: false }
    slot.worker.on('message', (reply: PrepareTalkReply) => {
      const job = slot.jobs.get(reply.id)
      if (!job) return
      slot.jobs.delete(reply.id)
      if (reply.ok) job.resolve({ model: reply.model, rows: reply.rows, previewKey: reply.previewKey })
      else job.reject(new Error(reply.error))
      armIdle()
    })
    slot.worker.on('error', (error) => {
      drop(slot)
      if (slot.retired) return
      failAll(slot, error instanceof Error ? error : new Error(String(error)))
    })
    slot.worker.on('exit', (code) => {
      drop(slot)
      // Ended on purpose: it held no job, and whatever runs now belongs to another worker.
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
      void ending.worker.terminate()
    }, idleMs)
    idleTimer.unref?.()
  }

  return function prepareTalkOffThread(request: PrepareTalkRequest): Promise<PrepareTalkAnswer> {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    const slot = (current ??= start())
    const id = nextId++
    const job: PrepareTalkJob = { id, ...request }
    return new Promise<PrepareTalkAnswer>((resolve, reject) => {
      slot.jobs.set(id, { resolve, reject })
      try {
        slot.worker.postMessage(job)
      } catch (error) {
        // Options that cannot be copied to the worker: this compile fails, the worker stays.
        slot.jobs.delete(id)
        armIdle()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
