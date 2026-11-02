// A stand-in for Cloudflare's upload step, in front of the stand-in API (cloudflare-api-stub.mjs): a real
// `pages deploy` runs against it on this computer's loopback address with a made-up token. The first
// `hold` uploads are answered late, either by holding the whole answer back ('headers') or by stopping
// half way through it ('body'), and every upload's fate is kept: when it arrived, and whether the tool
// gave up on it (closed the connection before the answer was finished) and after how long.
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startCloudflareApiStub } from './cloudflare-api-stub.mjs'

export const STAND_IN_ACCOUNT = 'standin0account'
export const STAND_IN_PROJECT = 'talkweaver-handouts'
const TOKEN = 'stand-in'

export async function startPagesUploadStandIn({ mode = 'headers', hold = 0, holdMs = 0 } = {}) {
  const api = await startCloudflareApiStub({ sites: [STAND_IN_PROJECT], accounts: [{ id: STAND_IN_ACCOUNT, name: 'Stand-in' }], tokens: { [TOKEN]: { accounts: [STAND_IN_ACCOUNT] } } })
  const uploads = []
  const forward = async (request, body) => {
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(name)))
    return fetch(`${api.baseUrl}${request.url.replace(/^\/client\/v4/, '')}`, { method: request.method, headers, ...(body.length ? { body } : {}) })
  }
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks)
        const isUpload = request.method === 'POST' && request.url.split('?')[0].endsWith('/pages/assets/upload')
        const held = isUpload && uploads.filter((upload) => upload.held).length < hold
        const upload = isUpload ? { held, at: Date.now(), gaveUpAfterMs: null } : null
        if (upload) {
          uploads.push(upload)
          response.once('close', () => { if (!response.writableFinished) upload.gaveUpAfterMs = Date.now() - upload.at })
        }
        const answer = await forward(request, body)
        const text = await answer.text()
        if (held && mode === 'body') {
          response.writeHead(answer.status, { 'content-type': 'application/json' })
          response.write(' ') // what JSON allows before its first character: the answer has begun, and it stops here
          await new Promise((resolve) => setTimeout(resolve, holdMs))
        } else if (held) {
          await new Promise((resolve) => setTimeout(resolve, holdMs))
        }
        if (response.destroyed) return
        if (!response.headersSent) response.writeHead(answer.status, { 'content-type': 'application/json' })
        response.end(text)
      })().catch(() => { response.destroy() })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    uploads,
    api,
    credentials: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: STAND_IN_ACCOUNT, CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${server.address().port}/client/v4` },
    async stop() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await api.close()
    },
  }
}

/** The arguments `talk:publish-handout` gives the tool, for a small site made here. */
export function pagesDeployArgs(scratch) {
  const site = join(scratch, 'cloudflare-pages-site')
  mkdirSync(site, { recursive: true })
  writeFileSync(join(site, 'index.html'), '<!doctype html><title>Upload stand-in</title>')
  return ['pages', 'deploy', site, '--project-name', STAND_IN_PROJECT, '--branch', 'main', '--commit-dirty=true']
}

/** What the probe (pages-transport-probe.cjs) wrote: one entry per request the tool sent. */
export const transportSeen = (file) => {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch { return [] }
}
