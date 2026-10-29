// The main process's side of a publish's own process (handout-pages-worker.ts says why).
//
// One child per publish: it is started for the job, handed the job as a message (a utility process has
// no workerData), answers once with { ok: true, result } or { ok: false, error }, and is ended here
// as soon as it has answered. Whichever way the publish ends, the child is gone with it.
//
// A child that dies (out of memory, a crash, killed) fails that publish with the build error the
// handlers show for any failed build; the main process, the child being a process of its own, is not
// touched. A child that answers nothing for the deadline (10 minutes: a large talk takes a while to
// publish, so this is generous) is killed and the publish fails with a message that says so.
//
// How a child is started is passed in (spawn): the app passes Electron's utilityProcess
// (prepare-talk-utility-process.ts, forkUtilityChild); tests pass a fake, or a plain Node child
// process (scripts/lib/node-compile-child.mjs). This file imports nothing of Electron.
import type { HandoutPagesJob, HandoutPagesResult } from './handout-pages'

export type HandoutPagesReply = { ok: true; result: HandoutPagesResult } | { ok: false; error: string }

const DEADLINE_MS = 10 * 60_000

/** The part of a child process used here: Electron's UtilityProcess has this shape. */
export interface HandoutPagesChild {
  /** Throws when the job cannot be copied to the child. */
  postMessage(message: HandoutPagesJob): void
  on(event: 'message', listener: (reply: HandoutPagesReply) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  /** A fatal error the child reports as it ends (Electron: type, location). Its exit follows. */
  on(event: 'error', listener: (type: string, location?: string) => void): unknown
  kill(): unknown
}
/** Starts a child running the handout script at `path`. */
export type SpawnHandoutPagesChild = (path: string) => HandoutPagesChild

function formatLimit(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${ms / 1000} seconds`
}

export function createHandoutPagesOffProcess(childPath: string, spawn: SpawnHandoutPagesChild, deadlineMs = DEADLINE_MS) {
  return function buildHandoutPagesOffProcess(job: HandoutPagesJob): Promise<HandoutPagesResult> {
    return new Promise<HandoutPagesResult>((resolve, reject) => {
      let child: HandoutPagesChild
      try {
        child = spawn(childPath)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      let settled = false
      let timer: NodeJS.Timeout | null = null
      const settle = (finish: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        finish()
        try { child.kill() } catch { /* already gone */ }
      }
      const fail = (message: string) => settle(() => reject(new Error(message)))
      child.on('message', (reply: HandoutPagesReply) => {
        settle(() => (reply.ok ? resolve(reply.result) : reject(new Error(reply.error))))
      })
      child.on('error', (type: string, location?: string) => {
        fail(`The handout could not be built (the build stopped: ${type}${location ? ` at ${location}` : ''}).`)
      })
      child.on('exit', (code: number) => {
        fail(`The handout could not be built (the build stopped with code ${code}).`)
      })
      timer = setTimeout(() => {
        fail(`The handout could not be built (the build took longer than ${formatLimit(deadlineMs)}).`)
      }, deadlineMs)
      try {
        child.postMessage(job)
      } catch (error) {
        // A job that cannot be copied to the child: this publish fails.
        settle(() => reject(error instanceof Error ? error : new Error(String(error))))
      }
    })
  }
}
