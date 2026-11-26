// Run under the bundled Electron's Node. This loopback check takes about eight minutes.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { pagesSiteApi } from '../src/main/pages-direct-upload.ts'

assert.ok(process.versions.electron, 'Use the bundled Electron with ELECTRON_RUN_AS_NODE=1')
const rate = 60_000
const size = 20 * 1024 * 1024
const hash = 'fixture-media-hash'
let uploadRequests = 0
let received = 0
const uploadReaders = new Set()
const server = createServer((request, response) => {
  const answer = result => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ success: true, result }))
  }
  if (request.url.endsWith('/pages/assets/upload')) {
    uploadRequests++
    const read = () => {
      let budget = rate / 10
      while (budget > 0) {
        const bytes = request.read(Math.min(4096, budget))
        if (!bytes) break
        received += bytes.length
        budget -= bytes.length
      }
    }
    uploadReaders.add(read)
    request.on('readable', () => {})
    request.on('end', () => { uploadReaders.delete(read); answer(null) })
    request.on('close', () => uploadReaders.delete(read))
    request.on('error', () => uploadReaders.delete(read))
    return
  }
  request.resume()
  if (request.url.endsWith('/upload-token')) answer({ jwt: 'test-upload-fixture' })
  else if (request.url.endsWith('/check-missing')) answer([hash])
  else if (request.url.endsWith('/upsert-hashes')) answer(null)
  else { response.writeHead(404); response.end() }
})
server.requestTimeout = 0
server.headersTimeout = 0
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const tick = setInterval(() => { for (const read of uploadReaders) read() }, 100)
try {
  const api = pagesSiteApi({
    fetch: (input, init) => {
      assert.equal(new URL(String(input)).hostname, '127.0.0.1')
      return fetch(input, init)
    },
    apiBase: 'http://127.0.0.1:' + server.address().port + '/client/v4',
    allowLoopbackForTests: true,
    contentType: () => 'application/octet-stream',
  }, { token: 'test-pages-fixture', accountId: 'test-account', project: 'fixture' })
  const began = performance.now()
  console.log('Electron ' + process.versions.electron + ', reading a 20 MiB asset at 60,000 bytes/s over loopback')
  const result = await api.uploadAssets([{ path: '/media.mp4', hash, size, read: () => Buffer.alloc(size) }], [hash])
  const elapsed = performance.now() - began
  assert.deepEqual(result.sent, [hash])
  assert.equal(uploadRequests, 1, 'transfer completed without restarting')
  assert.ok(received >= Math.ceil(size / 3) * 4, 'the mock received the whole base64 body')
  assert.ok(elapsed > 300_000 && elapsed < 600_000, 'the transfer ran beyond the old timeout and within the upload deadline')
  console.log('Slow Pages upload passed in ' + (elapsed / 1000).toFixed(1) + ' s, one upload request.')
} finally {
  clearInterval(tick)
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
