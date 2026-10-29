// Starts the live compile's own process (prepare-talk-worker.ts) as an Electron utility process: a
// separate operating-system process with a V8 heap of its own, so a compile that runs out of memory
// ends that process only (prepare-talk-off-thread.ts fails its job) and never the main process.
//
// The child's output is read here and passed on to the main process's console (whose writes are
// guarded against a closed pipe, index.ts), as a worker thread's output was: the child never writes
// to a stdout of its own that may not be there.
import { utilityProcess } from 'electron'
import type { CompileChild } from './prepare-talk-off-thread'
import type { HandoutPagesChild } from './handout-pages-off-process'
import type { HtmlPageImportChild } from './html-page-import'
import type { LivePageCaptureChild } from './live-page-capture'

function relay(stream: NodeJS.ReadableStream | null, write: (text: string) => void): void {
  if (!stream) return
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    const text = chunk.replace(/\n$/, '')
    if (!text) return
    try { write(text) } catch { /* logging must never take the app down */ }
  })
  stream.on('error', () => { /* the child is gone; nothing to pass on */ })
}

/** A utility process running `path` (in `cwd` when given), its output passed on to the main process's console. */
export function forkUtilityChild(path: string, serviceName: string, cwd?: string): Electron.UtilityProcess {
  const child = utilityProcess.fork(path, [], { serviceName, stdio: 'pipe', ...(cwd ? { cwd } : {}) })
  relay(child.stdout, (text) => console.log(text))
  relay(child.stderr, (text) => console.error(text))
  return child
}

export function forkCompileChild(path: string): CompileChild {
  return forkUtilityChild(path, 'TalkWeaver compile') as unknown as CompileChild
}

/** An HTML page import's own process, started IN the talk folder: its working directory is the write authority (html-page-import-core.ts). */
export function forkHtmlPageImportChild(path: string, cwd: string): HtmlPageImportChild {
  return forkUtilityChild(path, 'TalkWeaver HTML page import', cwd) as unknown as HtmlPageImportChild
}

/** A saved view's own process, started IN the talk folder: its working directory is the write authority (live-page-capture-core.ts). */
export function forkLivePageCaptureChild(path: string, cwd: string): LivePageCaptureChild {
  return forkUtilityChild(path, 'TalkWeaver live page capture', cwd) as unknown as LivePageCaptureChild
}

export function forkHandoutPagesChild(path: string): HandoutPagesChild {
  return forkUtilityChild(path, 'TalkWeaver handout pages') as unknown as HandoutPagesChild
}
