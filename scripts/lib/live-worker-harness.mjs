// Shared harness for the live-sessions Worker integration tests: starts `wrangler dev` on a free
// port with throwaway secrets and state, and offers small WebSocket helpers.
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

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

export function nextMessage(socket, timeoutMs = 5000) {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), timeoutMs)
    socket.addEventListener('message', (event) => {
      clearTimeout(timer)
      resolveMessage(JSON.parse(String(event.data)))
    }, { once: true })
  })
}

export function nextMessages(socket, count, timeoutMs = 5000) {
  return new Promise((resolveMessages, reject) => {
    const messages = []
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${count} WebSocket messages`)), timeoutMs)
    const onMessage = (event) => {
      messages.push(JSON.parse(String(event.data)))
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

export async function startLiveWorker() {
  const root = resolve(import.meta.dirname, '../..')
  const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-live-worker-'))
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const adminSecret = randomBytes(24).toString('hex')
  const signingSecret = randomBytes(24).toString('hex')
  let output = ''
  const child = spawn('wrangler', [
    'dev', '--config', join(root, 'worker/wrangler.jsonc'), '--ip', '127.0.0.1', '--port', String(port),
    '--var', `ADMIN_SECRET:${adminSecret}`, '--var', `SESSION_SIGNING_SECRET:${signingSecret}`,
    '--persist-to', join(scratch, 'state'), '--show-interactive-dev-session=false', '--log-level=error',
  ], {
    cwd: scratch,
    env: { ...process.env, WRANGLER_LOG_PATH: join(scratch, 'wrangler.log') },
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
