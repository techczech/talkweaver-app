// A stand-in for an S3-compatible store (Cloudflare R2), on this computer's loopback address, for
// tests of recording storage (src/main/recording-storage.ts). It answers the two calls the app
// makes, in S3's own XML: a list of a bucket (GET /<bucket>?list-type=2) and a put of one object
// (PUT /<bucket>/<key>). It is strict: anything else is recorded in `unknown` and refused.
//
// It tells access key ids apart by the id in the Authorization header; it does not verify the
// signature (it never has the secret access key, as a real store never receives it). Every refusal
// carries REPLY_TEXT_MARK and repeats the access key id it was sent, as real stores do, so a test
// can prove that no text of a reply travels on into what the app shows.
import { createServer } from 'node:http'

export const S3_REPLY_TEXT_MARK = 'text-of-a-storage-reply-that-must-not-be-shown'

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`
const refusal = (code, id) => xml(`<Error><Code>${code}</Code><Message>${S3_REPLY_TEXT_MARK} ${id}</Message><RequestId>stub</RequestId></Error>`)

/**
 * `buckets`: names that exist. `keys`: access key ids the store knows; `readOnly`: those of them
 * that may list but not put. `model.hang = true` leaves every request unanswered; `model.answer`
 * (a function of the request) may return `{ status, body, type }` to answer in the store's place.
 */
export async function startS3Stub({ buckets = [], keys = [], readOnly = [] } = {}) {
  const model = { buckets: new Set(buckets), keys: new Set(keys), readOnly: new Set(readOnly), objects: new Map(), hang: false, answer: null }
  const requests = []
  const unknown = []
  const held = new Set()

  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url, 'http://stub.invalid')
      const authorization = String(request.headers.authorization ?? '')
      const accessKeyId = /Credential=([^/,\s]+)\//.exec(authorization)?.[1] ?? ''
      const [bucket = '', ...rest] = decodeURIComponent(url.pathname).replace(/^\//, '').split('/')
      const key = rest.join('/')
      const body = Buffer.concat(chunks)
      // `route`: the request's own path on the stand-in (an address, never a file's path).
      const seen = { method: request.method, route: url.pathname, search: url.search, authorization, accessKeyId, bucket, key, bytes: body.length, headers: { ...request.headers } }
      requests.push(seen)
      if (model.hang) { held.add(response); return }
      const send = (status, text, type = 'application/xml') => { response.writeHead(status, { 'content-type': type }); response.end(text) }
      const custom = model.answer?.(seen)
      if (custom) return send(custom.status, custom.body ?? '', custom.type)
      const isList = request.method === 'GET' && bucket && !key && url.searchParams.get('list-type') === '2'
      const isPut = request.method === 'PUT' && bucket && key
      if (!isList && !isPut) { unknown.push(`${request.method} ${url.pathname}${url.search}`); return send(400, refusal('NotImplemented', accessKeyId)) }
      if (!model.keys.has(accessKeyId)) return send(403, refusal('InvalidAccessKeyId', accessKeyId))
      if (!model.buckets.has(bucket)) return send(404, refusal('NoSuchBucket', accessKeyId))
      if (isList) {
        const names = [...model.objects.keys()].filter((name) => name.startsWith(`${bucket}/`)).map((name) => name.slice(bucket.length + 1))
        const max = Math.max(0, Number(url.searchParams.get('max-keys') ?? 1000))
        const shown = names.slice(0, max)
        return send(200, xml(
          `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix></Prefix><KeyCount>${shown.length}</KeyCount>`
          + `<MaxKeys>${max}</MaxKeys><IsTruncated>${names.length > shown.length}</IsTruncated>`
          + shown.map((name) => `<Contents><Key>${name}</Key><Size>${model.objects.get(`${bucket}/${name}`).length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')
          + '</ListBucketResult>',
        ))
      }
      if (model.readOnly.has(accessKeyId)) return send(403, refusal('AccessDenied', accessKeyId))
      model.objects.set(`${bucket}/${key}`, body)
      response.writeHead(200, { etag: '"stub"' })
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  return {
    endpoint, model, requests, unknown,
    async close() {
      for (const response of held) { try { response.destroy() } catch { /* already gone */ } }
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
