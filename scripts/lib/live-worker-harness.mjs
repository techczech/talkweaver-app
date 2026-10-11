// Shared harness for the live-sessions Worker integration tests: starts `wrangler dev` on a free
// port with throwaway secrets and state, and offers small WebSocket helpers. wrangler is the app's
// own dependency, started through the app's launcher (never a `wrangler` found on PATH).
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { prepareWranglerRun } from '../../src/main/wrangler-launcher.ts'

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

async function waitForWorker(baseUrl, output) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { await fetch(baseUrl); return } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new Error(`wrangler dev did not start\n${output().slice(-4000)}`)
}

/** For `accept`: every message but the presence broadcast (sent to ALL sockets whenever any socket joins or leaves). */
export const notPresence = (message) => message?.type !== 'session.presence'

/**
 * The next message on `socket`. With `accept`, the next message it accepts: others are skipped, so a
 * broadcast that happens to be in flight (presence, after another socket joined or left) cannot be
 * taken for the answer being waited for.
 */
export function nextMessage(socket, timeoutMs = 5000, accept = () => true) {
  return nextMessages(socket, 1, timeoutMs, accept).then((messages) => messages[0])
}

export function nextMessages(socket, count, timeoutMs = 5000, accept = () => true) {
  return new Promise((resolveMessages, reject) => {
    const messages = []
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error(count === 1 ? 'Timed out waiting for WebSocket message' : `Timed out waiting for ${count} WebSocket messages`))
    }, timeoutMs)
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (!accept(message)) return
      messages.push(message)
      if (messages.length < count) return
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      resolveMessages(messages)
    }
    socket.addEventListener('message', onMessage)
  })
}

export function openSocket(url, timeoutMs = 5000, options = undefined) {
  return new Promise((resolveSocket, reject) => {
    const socket = options ? new WebSocket(url, options) : new WebSocket(url)
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`Timed out opening WebSocket: ${url}`))
    }, timeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolveSocket(socket)
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`WebSocket failed: ${url}`))
    }, { once: true })
  })
}

/** `vars`: extra Worker vars for this run only (e.g. a short PREWORK_IDLE_PURGE_MS). */
export async function startLiveWorker({ vars = {} } = {}) {
  // A local Worker: submissions without cf-connecting-ip share one pre-work source (unless a test clears it).
  vars = { PREWORK_LOCAL_SOURCE: '1', ...vars }
  const root = resolve(import.meta.dirname, '../..')
  const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-live-worker-'))
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const adminSecret = randomBytes(24).toString('hex')
  const signingSecret = randomBytes(24).toString('hex')
  let output = ''
  const resolved = prepareWranglerRun({ execPath: process.execPath, appRoot: root, platform: process.platform, workDir: join(scratch, 'wrangler-runs') }, [
    'dev', '--config', join(root, 'worker/wrangler.jsonc'), '--ip', '127.0.0.1', '--port', String(port),
    '--var', `ADMIN_SECRET:${adminSecret}`, '--var', `SESSION_SIGNING_SECRET:${signingSecret}`,
    ...Object.entries(vars).flatMap(([key, value]) => ['--var', `${key}:${value}`]),
    '--persist-to', join(scratch, 'state'), '--show-interactive-dev-session=false', '--log-level=error',
  ], { inherited: process.env, set: { WRANGLER_LOG_PATH: join(scratch, 'wrangler.log') } })
  if (!resolved.ok) throw new Error(`${resolved.error}. ${resolved.details} (run npm ci)`)
  const child = spawn(resolved.launch.command, resolved.launch.args, {
    cwd: resolved.launch.cwd,
    env: resolved.launch.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })

  async function stop() {
    child.kill('SIGTERM')
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) return resolveExit()
      child.once('exit', resolveExit)
      setTimeout(() => { child.kill('SIGKILL'); resolveExit() }, 2000).unref()
    })
    await rm(scratch, { recursive: true, force: true })
  }

  try {
    await waitForWorker(baseUrl, () => output)
  } catch (error) {
    await stop()
    throw error
  }
  return { baseUrl, wsUrl: baseUrl.replace('http:', 'ws:'), adminSecret, signingSecret, stop }
}
