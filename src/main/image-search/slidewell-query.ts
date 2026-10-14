// SlideWell's local picture-search query (ticket 10): the request contract and TalkWeaver's client.
// SlideWell answers; TalkWeaver only asks. Picture search needs SlideWell's model and process, so
// a meaning query is answered only while SlideWell is running; otherwise TalkWeaver searches words.
//
// CONTRACT v1 (SlideWell implements the server side; this file is the reference for both)
//   Transport  A Unix domain socket at <SlideWell user data>/picture-query.sock, i.e.
//              ~/Library/Application Support/SlideWell/picture-query.sock. A Unix socket has no
//              network address, so no other machine can connect at all; SlideWell creates it with
//              mode 0600 inside its own user-data folder, so only the same local user can. The
//              client refuses a path that is not a socket or is owned by another user.
//   Framing    One request per connection: one line of JSON (UTF-8, ending '\n'); one line back;
//              the server closes. Requests over 4 KB and responses over 1 MB are refused.
//   Request    {"v":1,"op":"picture-query","text":"<words>","limit":<1..200>}
//   Response   {"v":1,"ok":true,"hits":[{"id":"<id>","score":<0..1>}, ...]}  ranked, best first
//              {"v":1,"ok":false,"reason":"model-not-ready"|"busy"|"bad-request"}
//   Ids        The picture-search store's own ids: 'well:<7-hex well id>' (well and talk images),
//              'triage:<12-hex content hash>' (screenshots not yet in the well) and
//              'slide:<presentation id>#<slide order>' (old slides). Unknown kinds are ignored.
//   Privacy    The query text never leaves the Mac; SlideWell logs no query text.

import { lstatSync } from 'fs'
import { connect } from 'net'
import { homedir } from 'os'
import { join } from 'path'

export const PICTURE_QUERY_SOCKET = 'picture-query.sock'
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_REQUEST_BYTES = 4096

export type PictureHit = { id: string; score: number }
export type PictureAnswer =
  | { ok: true; hits: PictureHit[] }
  | { ok: false; reason: 'not-running' | 'refused' | 'timeout' | 'model-not-ready' | 'busy' | 'bad-request' | 'bad-response' }

/** SlideWell's user-data folders (packaged name first, then the dev name). */
export function slidewellUserDataDirs(home = homedir()): string[] {
  const support = join(home, 'Library', 'Application Support')
  return [join(support, 'SlideWell'), join(support, 'slidewell')]
}

/** One request line, or null when the request would break the contract. */
export function encodePictureRequest(text: string, limit: number): string | null {
  const clean = String(text ?? '').replace(/[\u0000-\u001f]/g, ' ').trim()
  if (!clean) return null
  const n = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 60)))
  const line = JSON.stringify({ v: 1, op: 'picture-query', text: clean, limit: n }) + '\n'
  return Buffer.byteLength(line) <= MAX_REQUEST_BYTES ? line : null
}

/** Parse one response line strictly: wrong shapes become bad-response, never thrown. */
export function decodePictureResponse(line: string): PictureAnswer {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'bad-response' }
  }
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'bad-response' }
  const m = msg as { v?: unknown; ok?: unknown; hits?: unknown; reason?: unknown }
  if (m.v !== 1) return { ok: false, reason: 'bad-response' }
  if (m.ok === false) {
    const reason = m.reason === 'model-not-ready' || m.reason === 'busy' || m.reason === 'bad-request' ? m.reason : 'bad-response'
    return { ok: false, reason }
  }
  if (m.ok !== true || !Array.isArray(m.hits)) return { ok: false, reason: 'bad-response' }
  const hits: PictureHit[] = []
  for (const h of m.hits as unknown[]) {
    const x = h as { id?: unknown; score?: unknown }
    if (!x || typeof x.id !== 'string' || !x.id || x.id.length > 512) continue
    const score = typeof x.score === 'number' && Number.isFinite(x.score) ? Math.max(0, Math.min(1, x.score)) : null
    if (score === null) continue
    hits.push({ id: x.id, score })
  }
  return { ok: true, hits }
}

/** Is this path a socket owned by the current user? (Anything else is refused, unconnected.) */
export function socketIsOurs(path: string): boolean {
  try {
    const st = lstatSync(path)
    if (!st.isSocket()) return false
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return uid === null || st.uid === uid
  } catch {
    return false
  }
}

/** Ask SlideWell for picture matches. Never throws; a missing or silent SlideWell is an answer too. */
export function askPictureQuery(socketPath: string, text: string, limit = 60, timeoutMs = 2000): Promise<PictureAnswer> {
  const request = encodePictureRequest(text, limit)
  if (!request) return Promise.resolve({ ok: false, reason: 'bad-request' })
  try {
    lstatSync(socketPath)
  } catch {
    return Promise.resolve({ ok: false, reason: 'not-running' })
  }
  if (!socketIsOurs(socketPath)) return Promise.resolve({ ok: false, reason: 'refused' })
  return new Promise((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    let size = 0
    const sock = connect({ path: socketPath })
    const done = (answer: PictureAnswer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(answer)
    }
    const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs)
    sock.on('connect', () => sock.write(request))
    sock.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_RESPONSE_BYTES) return done({ ok: false, reason: 'bad-response' })
      chunks.push(chunk)
      const nl = chunk.indexOf(10)
      if (nl >= 0) {
        const all = Buffer.concat(chunks).toString('utf8')
        done(decodePictureResponse(all.slice(0, all.indexOf('\n'))))
      }
    })
    sock.on('end', () => {
      const all = Buffer.concat(chunks).toString('utf8').trim()
      done(all ? decodePictureResponse(all) : { ok: false, reason: 'bad-response' })
    })
    sock.on('error', () => done({ ok: false, reason: 'not-running' }))
  })
}
