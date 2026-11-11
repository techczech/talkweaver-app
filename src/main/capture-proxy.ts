// Capture-only HTTP/CONNECT transport boundary. DNS is resolved once; sockets use the vetted IP.
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import { connect, isIP, type Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import { classifyHost, isLocalAddress } from './local-address-filter.ts'

export interface CaptureProxyOptions {
  denyAll?: boolean
  /** Main's existing unpackaged E2E allowance only; never populated in a packaged app. */
  testAllowance?: ReadonlySet<string>
}

export async function captureDestination(host: string, port: number, opts: CaptureProxyOptions,
  resolve: (host: string) => Promise<string[]> = async host => (await lookup(host, { all: true })).map(item => item.address)
): Promise<string | null> {
  if (opts.denyAll || !Number.isInteger(port) || port < 1 || port > 65535) return null
  host = host.replace(/^\[|\]$/g, '')
  if (opts.testAllowance?.has(`${host}:${port}`) && host === '127.0.0.1') return host
  if (classifyHost(host) === 'local') return null
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [])
  if (!addresses.length || addresses.some(ip => !isIP(ip) || isLocalAddress(ip))) return null
  return addresses[0]
}

function headersFor(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out = { ...headers }
  const connection = String(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase())
  for (const name of [...connection, 'connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'upgrade', 'te', 'trailer']) delete out[name]
  return out
}

export async function createCaptureProxy(opts: CaptureProxyOptions = {}): Promise<{ url: string; close: () => void }> {
  const sockets = new Set<Socket>()
  let closed = false
  const track = (socket: Socket): Socket => {
    if (closed) socket.destroy()
    else { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.setTimeout(20_000, () => socket.destroy()); socket.on('error', () => socket.destroy()) }
    return socket
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '')
      if (url.protocol !== 'http:' || url.username || url.password || req.method === 'CONNECT') throw Error('Refused')
      const port = Number(url.port || 80)
      const ip = await captureDestination(url.hostname, port, opts)
      if (!ip || closed || req.destroyed) throw Error('Refused')
      const headers = headersFor(req.headers); headers.host = url.host
      // A URL keeps the HTTP route separate from filesystem path options.
      const destination = new URL(url)
      destination.hostname = isIP(ip) === 6 ? `[${ip}]` : ip
      const upstream = request(destination, { method: req.method, headers, agent: false }, reply => {
        if (res.destroyed) { reply.destroy(); return }
        reply.on('error', () => res.destroy())
        res.writeHead(reply.statusCode ?? 502, headersFor(reply.headers)); reply.pipe(res)
      })
      upstream.on('socket', track)
      upstream.on('error', () => { if (res.destroyed || res.writableEnded) return; if (!res.headersSent) res.writeHead(502); res.end() })
      res.on('close', () => upstream.destroy())
      res.on('error', () => upstream.destroy())
      req.on('error', () => upstream.destroy())
      req.pipe(upstream)
    } catch { res.writeHead(403); res.end() }
  })
  server.on('connection', track)
  server.on('connect', async (req, client, head) => {
    try {
      if (!/^([A-Za-z0-9.-]+|\[[0-9a-fA-F:.]+\]):\d+$/.test(req.url ?? '')) throw Error('Refused')
      const url = new URL(`http://${req.url}`)
      const port = Number(url.port || 80)
      const ip = await captureDestination(url.hostname, port, opts)
      if (!ip || closed || client.destroyed) throw Error('Refused')
      const upstream = track(connect({ host: ip, port }))
      upstream.once('connect', () => {
        if (client.destroyed) { upstream.destroy(); return }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream); upstream.pipe(client)
      })
      upstream.on('error', () => client.destroy())
      client.on('close', () => upstream.destroy())
    } catch { if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') }
  })
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.maxConnections = 96
  server.headersTimeout = 20_000
  server.requestTimeout = 20_000
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Capture proxy unavailable')
  return { url: `http://127.0.0.1:${address.port}`, close: () => {
    closed = true
    for (const socket of sockets) socket.destroy()
    server.close()
  } }
}
