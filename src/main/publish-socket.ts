import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import type { AgentCliIO } from './agent-skill/cli.ts'
import { parsePublishArgs, publishBusy } from './publish-cli.ts'

const MAX_FRAME = 32 * 1024
const MAX_BACKLOG = 128 * 1024
type Request = { args: string[]; cwd: string }
type Response = { stream: 'stdout' | 'stderr'; text: string } | { exitCode: number }
export type PublishForward = number | 'unavailable' | 'interrupted' | 'cancelled'
type Run = (request: Request, io: AgentCliIO, signal: AbortSignal) => Promise<number>

function endpoint(profile: string, create: boolean): { directory: string; path: string; uid: number } {
  const uid = process.getuid?.()
  if (uid === undefined) throw Error('Unix socket unavailable')
  // The root-owned sticky directory protects the name against replacement by other users.
  // Resolve the system path, ignoring the caller's TMPDIR. Keep under macOS's socket path limit.
  const parent = realpathSync('/tmp')
  const root = lstatSync(parent)
  if (!root.isDirectory() || root.uid !== 0 || !(root.mode & 0o1000)) throw Error('Unsafe socket root')
  const identity = createHash('sha256').update(realpathSync(profile)).digest('hex').slice(0, 24)
  const directory = join(parent, `tw-publish-${uid}-${identity}`)
  if (create) {
    try { mkdirSync(directory, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700) throw Error('Unsafe socket directory')
  return { directory, path: join(directory, 'publish.sock'), uid }
}

function frame(socket: Socket, value: Request | Response | 'cancel'): void {
  if (socket.writableLength > MAX_BACKLOG) { socket.destroy(); return }
  const line = JSON.stringify(value)
  if (line.length > MAX_FRAME) { socket.destroy(); return }
  socket.write(line + '\n')
}

function receive(socket: Socket, onValue: (value: unknown) => void): void {
  let pending = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    pending += chunk
    for (;;) {
      const end = pending.indexOf('\n')
      if (end < 0) {
        if (pending.length > MAX_FRAME) socket.destroy()
        return
      }
      if (end > MAX_FRAME) { socket.destroy(); return }
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      try { onValue(JSON.parse(line)) } catch { socket.destroy(); return }
      if (socket.destroyed) return
    }
  })
}

function requestOf(value: unknown): Request | undefined {
  if (!value || typeof value !== 'object') return
  const { args, cwd } = value as Partial<Request>
  if (!Array.isArray(args) || args.length > 64 || !args.every(arg => typeof arg === 'string') ||
      typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) return
  const parsed = parsePublishArgs(args)
  if ((parsed.command === 'publish' || parsed.command === 'dry-run') && !parsed.talk.includes('\0')) return { args, cwd }
}

/** Start only in the process holding Electron's profile lock. The socket lives inside a 0700 directory. */
export async function listenForPublish(profile: string, run: Run): Promise<() => void> {
  const { directory, path, uid } = endpoint(profile, true)
  const stale = lstatSync(path, { throwIfNoEntry: false })
  if (stale) {
    if (!stale.isSocket() || stale.uid !== uid) throw Error('Unsafe socket entry')
    unlinkSync(path)
  }
  const clients = new Set<Socket>()
  let busy = false
  const server = createServer(socket => {
    clients.add(socket)
    const abort = new AbortController()
    const initialDeadline = setTimeout(() => socket.destroy(), 5000)
    socket.on('error', () => {})
    socket.once('close', () => { clearTimeout(initialDeadline); clients.delete(socket); abort.abort() })
    let accepted = false
    receive(socket, value => {
      if (accepted && value === 'cancel') { abort.abort(); return }
      if (accepted) throw Error('Unexpected request')
      const request = requestOf(value)
      if (!request) throw Error('Invalid request')
      clearTimeout(initialDeadline)
      accepted = true
      const io = {
        stdout: (text: string) => { if (!socket.destroyed) frame(socket, { stream: 'stdout', text }) },
        stderr: (text: string) => { if (!socket.destroyed) frame(socket, { stream: 'stderr', text }) },
      }
      if (busy) {
        const code = publishBusy(request.args, io)
        frame(socket, { exitCode: code })
        socket.end()
        return
      }
      busy = true
      void Promise.resolve().then(() => run(request, io, abort.signal)).then(code => {
        if (!socket.destroyed) { frame(socket, { exitCode: code }); socket.end() }
      }).catch(() => socket.destroy()).finally(() => { busy = false })
    })
  })
  server.maxConnections = 8
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.removeListener('error', reject)
      try { chmodSync(path, 0o600); resolve() }
      catch (error) { server.close(); reject(error) }
    })
  })
  server.on('error', () => {})
  return () => {
    for (const socket of clients) socket.destroy()
    server.close(() => { try { rmdirSync(directory) } catch { /* a later launch can reuse the empty directory */ } })
  }
}

async function dial(profile: string): Promise<Socket> {
  const { path, uid } = endpoint(profile, false)
  const info = lstatSync(path)
  if (!info.isSocket() || info.uid !== uid || (info.mode & 0o777) !== 0o600) throw Error('Unsafe socket entry')
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.setTimeout(1000, () => socket.destroy())
    socket.once('close', () => reject(Error('Publish connection closed')))
    socket.on('error', reject)
    socket.once('connect', () => { socket.setTimeout(0); resolve(socket) })
  })
}

export async function forwardPublish(profile: string, request: Request, io: AgentCliIO, signal: AbortSignal): Promise<PublishForward> {
  if (process.platform === 'win32') return 'unavailable'
  let socket: Socket | undefined
  // The first instance may still be opening Settings. Retry only the connection, before sending any request.
  const deadline = Date.now() + 3000
  do {
    if (signal.aborted) return 'cancelled'
    try { socket = await dial(profile) }
    catch {
      if (Date.now() >= deadline) return 'unavailable'
      await pause(100)
    }
  } while (!socket)
  const connection = socket
  if (signal.aborted) { connection.destroy(); return 'cancelled' }
  return new Promise(resolve => {
    const cancel = () => frame(connection, 'cancel')
    const finish = (result: PublishForward) => {
      signal.removeEventListener('abort', cancel)
      connection.destroy()
      resolve(result)
    }
    connection.once('close', () => finish('interrupted'))
    signal.addEventListener('abort', cancel, { once: true })
    receive(connection, value => {
      if (!value || typeof value !== 'object') throw Error('Invalid reply')
      const reply = value as Response
      if ('exitCode' in reply && Number.isInteger(reply.exitCode) && reply.exitCode >= 0 && reply.exitCode <= 255) finish(reply.exitCode)
      else if ('text' in reply && typeof reply.text === 'string' && (reply.stream === 'stdout' || reply.stream === 'stderr')) io[reply.stream](reply.text)
      else throw Error('Invalid reply')
    })
    frame(connection, request)
  })
}
