// SlideWell's local picture-search query (src/main/image-search/slidewell-query.ts): contract v1
// and TalkWeaver's client, against a stand-in SlideWell that speaks the contract over a real Unix
// socket in a temp folder.
//
//   - ranked ids and scores come back as sent; malformed entries are dropped, scores clamped
//   - SlideWell's refusals (model not ready) and silence (timeout) are answers, never throws
//   - no socket = not running; a path that is not a socket is refused without connecting
//   - oversized responses and bad JSON are rejected
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  askPictureQuery,
  decodePictureResponse,
  encodePictureRequest,
  socketIsOurs,
  slidewellUserDataDirs
} from '../src/main/image-search/slidewell-query.ts'

// Short base path: a Unix socket path is limited to 104 bytes on macOS.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'twq-')))
let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}

/** A stand-in SlideWell: reads one request line, answers with reply(request) (or stays silent). */
async function standIn(name, reply) {
  const path = join(base, name)
  const requests = []
  const server = createServer((sock) => {
    let buf = ''
    sock.on('error', () => {}) // the client may hang up first (timeout, oversized answer)
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const req = JSON.parse(buf.slice(0, nl))
      requests.push(req)
      const out = reply(req)
      if (out === null) return // silent
      sock.end(typeof out === 'string' ? out : JSON.stringify(out) + '\n')
    })
  })
  await new Promise((resolve) => server.listen(path, resolve))
  chmodSync(path, 0o600)
  return { path, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

await test('request: one JSON line, control characters flattened, limit clamped', () => {
  assert.equal(encodePictureRequest('robots\nin a classroom', 500), '{"v":1,"op":"picture-query","text":"robots in a classroom","limit":200}\n')
  assert.equal(encodePictureRequest('  ', 10), null)
  assert.equal(encodePictureRequest('x'.repeat(5000), 10), null, 'requests over 4 KB are not sent')
})

await test('response: strict parse, bad entries dropped, scores clamped to 0..1', () => {
  assert.deepEqual(decodePictureResponse('{"v":1,"ok":true,"hits":[{"id":"well:abc1234","score":0.9},{"id":5,"score":1},{"id":"triage:aa","score":"x"},{"id":"triage:bb","score":1.7}]}'),
    { ok: true, hits: [{ id: 'well:abc1234', score: 0.9 }, { id: 'triage:bb', score: 1 }] })
  assert.deepEqual(decodePictureResponse('{"v":1,"ok":false,"reason":"model-not-ready"}'), { ok: false, reason: 'model-not-ready' })
  assert.deepEqual(decodePictureResponse('{"v":2,"ok":true,"hits":[]}'), { ok: false, reason: 'bad-response' })
  assert.deepEqual(decodePictureResponse('not json'), { ok: false, reason: 'bad-response' })
  assert.deepEqual(decodePictureResponse('{"v":1,"ok":false,"reason":"something else"}'), { ok: false, reason: 'bad-response' })
})

await test('ask: ranked ids and scores from a running SlideWell', async () => {
  const sw = await standIn('a.sock', () => ({ v: 1, ok: true, hits: [{ id: 'well:d00d001', score: 0.81 }, { id: 'triage:aaaa11112222', score: 0.62 }] }))
  const answer = await askPictureQuery(sw.path, 'robots in a classroom', 40)
  assert.deepEqual(answer, { ok: true, hits: [{ id: 'well:d00d001', score: 0.81 }, { id: 'triage:aaaa11112222', score: 0.62 }] })
  assert.deepEqual(sw.requests, [{ v: 1, op: 'picture-query', text: 'robots in a classroom', limit: 40 }])
  await sw.close()
})

await test('ask: model not ready, silence and garbage are answers, not throws', async () => {
  const notReady = await standIn('b.sock', () => ({ v: 1, ok: false, reason: 'model-not-ready' }))
  assert.deepEqual(await askPictureQuery(notReady.path, 'boats'), { ok: false, reason: 'model-not-ready' })
  await notReady.close()
  const silent = await standIn('c.sock', () => null)
  const t0 = Date.now()
  assert.deepEqual(await askPictureQuery(silent.path, 'boats', 10, 150), { ok: false, reason: 'timeout' })
  assert.ok(Date.now() - t0 < 1500)
  await silent.close()
  const huge = await standIn('d.sock', () => '{"v":1,"ok":true,"hits":[' + '{"id":"well:abc1234","score":0.5},'.repeat(40000) + ']}\n')
  assert.deepEqual(await askPictureQuery(huge.path, 'boats'), { ok: false, reason: 'bad-response' })
  await huge.close()
})

await test('ask: no socket means not running; a plain file is refused without connecting', async () => {
  assert.deepEqual(await askPictureQuery(join(base, 'none.sock'), 'boats'), { ok: false, reason: 'not-running' })
  const plain = join(base, 'plain.sock')
  writeFileSync(plain, '')
  assert.equal(socketIsOurs(plain), false)
  assert.deepEqual(await askPictureQuery(plain, 'boats'), { ok: false, reason: 'refused' })
  const sw = await standIn('e.sock', () => ({ v: 1, ok: true, hits: [] }))
  assert.equal(socketIsOurs(sw.path), true)
  await sw.close()
})

await test('location: SlideWell\'s user-data folders, packaged name first', () => {
  assert.deepEqual(slidewellUserDataDirs('/home/example'), [
    '/home/example/Library/Application Support/SlideWell',
    '/home/example/Library/Application Support/slidewell'
  ])
})

rmSync(base, { recursive: true, force: true })
console.log(`slidewell query: ${passed} passed`)
