// The live compile's child script (src/main/prepare-talk-worker.ts) started under plain Node, for tests
// that cannot start Electron. The app starts it as an Electron utility process
// (src/main/prepare-talk-utility-process.ts); here it is a Node child process with the same message
// shape: the job arrives as `event.data` on process.parentPort, the answer leaves through
// process.parentPort.postMessage, and both directions use structured clone ("advanced"
// serialization), so a value that cannot be copied fails as it does in the app.
//
//   createPrepareTalkOffThread(childPath, forkNodeCompileChild)
//
// Run as a script (the child side), it sets up process.parentPort and then loads the child script.
import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'

const self = fileURLToPath(import.meta.url)

/** A CompileChild (prepare-talk-off-thread.ts) running `path` in a Node child process, in `cwd` when given. */
export function forkNodeCompileChild(path, { cwd } = {}) {
  const child = fork(self, [path], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], ...(cwd ? { cwd } : {}) })
  return {
    postMessage: (message) => { child.send(message) },
    on(event, listener) {
      if (event === 'exit') child.on('exit', (code, signal) => listener(code ?? signal))
      else if (event === 'message') child.on('message', listener)
      // 'error' here is a failure to start or to send, not Electron's fatal-error report: not passed on.
      return this
    },
    kill: () => child.kill(),
  }
}

if (process.argv[1] === self && process.send) {
  const port = new EventEmitter()
  port.postMessage = (message) => { process.send(message) }
  process.on('message', (data) => port.emit('message', { data }))
  process.parentPort = port
  await import(pathToFileURL(process.argv[2]).href)
}
