// Cloudflare Pages Direct Upload, made the way the bundled wrangler (4.153, wrangler-dist/cli.js) makes it for `pages deploy`,
// for ONE change merged into the live manifest (spec docs/plans/2026-11-05-per-talk-publishing/spec.md, steps 3 to 8).
//
//   hash       blake3(base64(bytes) + extension without the dot), hex, first 32 characters: wrangler's `hashFile`, with the
//              same blake3-wasm module wrangler itself loads (`loadWranglerBlake3`). Pinned by a vector wrangler produced
//              (scripts/test-per-talk-publishing.mjs).
//   upload     GET  /accounts/:a/pages/projects/:p/upload-token  (the person's token)  → a JWT
//              POST /pages/assets/check-missing {hashes}          (the JWT)  5 attempts, 2^n s apart, a new JWT on 8000013 or expiry
//              POST /pages/assets/upload [{key, value, metadata: {contentType}, base64: true}]
//                   buckets of at most 40 MiB and 2000 files (1000 on Windows), largest first, 3 at a time; up to 5 attempts
//                   for transient responses and connection failures, with Retry-After taking precedence over backoff
//              POST /pages/assets/upsert-hashes {hashes}         once more after 1 s; a failure there only slows a later upload
//              Unlike wrangler, every attempt counts (a new upload token too), at most 3 new upload tokens are asked for in
//              all, and the caller's `stillCurrent` is asked between attempts: a superseded publish uploads nothing further.
//   deploy     POST /accounts/:a/pages/projects/:p/deployments  multipart: manifest, branch, commit_message, commit_dirty,
//                   _headers and _redirects (each only when not empty). ONE request, never retried here (wrangler retries
//                   Cloudflare's 8000000): a request that may have made a deployment is reconciled before another is sent
//                   (`findDeployment`), and the caller reads the production revision again immediately before it.
//   confirm    GET  …/deployments/:id until its last stage is `deploy` and settled (5 attempts, 2^n s apart), then the project:
//              the deployment is production and its `files` are exactly the merged manifest.
//   find       GET  …/deployments/:id, or the project's recent deployments by the candidate digest in their commit message:
//              whether an earlier attempt's deployment exists, and whether it is still pending, succeeded or failed.
//   types      wrangler's own `mime` (3.0) tables, read from its bundled entry script (`loadWranglerMime`).
//
// Only the bytes check-missing names are read and sent (`StagedAsset.read`). A PagesApiError has a fixed message.
// Only redacted error-envelope text is retained for structured publish diagnostics. Redirects are never followed.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { subscribe } from 'node:diagnostics_channel'
import { setTimeout as wait } from 'node:timers/promises'
import { redactPublishException, redactPublishText, type PublishDiagnostic, type PublishLocation, type PublishProgress } from '../shared/publish-diagnostic.ts'
import { CLOUDFLARE_API_BASE } from './observation/cloudflare-inventory.ts'
import type { PublishFailureKind } from './publishing-logic.ts'
import { wranglerEntryPath } from './wrangler-launcher.ts'

export type Blake3 = { hash(input: string | Uint8Array): { toString(encoding: 'hex'): string } }

/**
 * The blake3 module wrangler itself loads: `require('blake3-wasm')` resolved from wrangler's own entry script, exactly as
 * that script resolves it, in the app's `node_modules` (where the launcher finds wrangler: wrangler-launcher.ts).
 */
export function loadWranglerBlake3(appRoot: string): Blake3 {
  const fromWrangler = createRequire(wranglerEntryPath({ appRoot, platform: process.platform }))
  return fromWrangler('blake3-wasm') as Blake3
}

/** wrangler's `hashFile` for the bytes of the file kept at `path` (its extension, without the dot, is part of the hash). */
export function pagesAssetHash(blake3: Blake3, bytes: Uint8Array, path: string): string {
  const extension = posix.extname(path).substring(1)
  return blake3.hash(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') + extension).toString('hex').slice(0, 32)
}

/**
 * wrangler's content types: the `mime` 3.0 tables bundled in its entry script (`standard` then `other`, an `*ext` never
 * replacing one already given), looked up the way its `getType` looks up `validate`'s relative file names. Anything it does not
 * know is wrangler's own fallback, `application/octet-stream`. Throws when the tables cannot be read from that script.
 */
export function loadWranglerMime(appRoot: string): (path: string) => string {
  const text = readFileSync(wranglerEntryPath({ appRoot, platform: process.platform }), 'utf8')
  const table = (name: string): Record<string, string[]> => {
    const at = text.indexOf(`/mime/types/${name}.js"(exports2, module2) {`)
    const start = at < 0 ? -1 : text.indexOf('module2.exports = ', at)
    const end = start < 0 ? -1 : text.indexOf('};\n', start)
    if (at < 0 || start < 0 || end < 0) throw new Error(`wrangler's ${name} content types were not found`)
    return JSON.parse(text.slice(start + 'module2.exports = '.length, end + 1)) as Record<string, string[]>
  }
  const types = new Map<string, string>()
  for (const map of [table('standard'), table('other')]) {
    for (const [type, extensions] of Object.entries(map)) {
      for (const extension of extensions.map((ext) => ext.toLowerCase())) if (!extension.startsWith('*') && !types.has(extension)) types.set(extension, type.toLowerCase())
    }
  }
  if (types.size < 500) throw new Error("wrangler's content types are incomplete")
  return (path: string): string => {
    const name = path.replace(/^\/+/u, '') // as `validate` names it: relative to the site
    const last = name.replace(/^.*[/\\]/u, '').toLowerCase()
    const extension = last.replace(/^.*\./u, '').toLowerCase()
    const hasPath = last.length < name.length
    const hasDot = extension.length < last.length - 1
    return ((hasDot || !hasPath) && types.get(extension)) || 'application/octet-stream'
  }
}

/** wrangler's numbers (src/pages/constants.ts, src/pages/upload.ts). */
export const PAGES_UPLOAD = Object.freeze({
  maxAssetBytes: 25 * 1024 * 1024,
  bucketBytes: 40 * 1024 * 1024,
  bucketFiles: process.platform === 'win32' ? 1000 : 2000,
  concurrency: 3,
  uploadAttempts: 5,
  checkMissingAttempts: 5,
  /** New upload tokens asked for after the first, in all (wrangler has no limit). */
  tokenRefreshes: 3,
  statusAttempts: 5,
  commitMessageBytes: 384,
})
/** How many of the project's deployments one page holds, and how many pages a search for an earlier attempt reads at most. */
const DEPLOYMENTS_PER_PAGE = 25
const DEPLOYMENT_PAGES = 40
const SITE_LEVEL = new Set(['/_redirects', '/_headers', '/_routes.json', '/_worker.js'])
/** Cloudflare's codes wrangler acts on. */
const UNAUTHORIZED_JWT = 8000013

/** One file of the change: where it will be kept, its hash, its size, and how to read its bytes (asked only if Cloudflare lacks them). */
export interface StagedAsset { path: string; hash: string; size: number; read(): Buffer }

/** The publish was superseded (the connection changed) between two requests: nothing further is sent. */
export class UploadSuperseded extends Error {}
export class UploadCancelled extends Error {}

type RequestFailure = Pick<PublishDiagnostic, 'networkCode' | 'timeoutMs' | 'retryAfterMs' | 'cloudflareErrors' | 'viaIntermediary' | 'cause'> & {
  kind?: PublishDiagnostic['kind']
}
type TransferReport = Omit<PublishProgress, 'canCancel'>
type Transfer = { signal?: AbortSignal; report?: (progress: TransferReport) => void }

/** A refusal or failure of one request. `definite`: Cloudflare answered with a refusal, so that request changed nothing. */
export class PagesApiError extends Error {
  readonly kind: PublishFailureKind
  readonly step: string
  readonly status?: number
  readonly codes: number[]
  readonly definite: boolean
  readonly failure: RequestFailure
  location?: PublishLocation
  constructor(step: string, kind: PublishFailureKind, definite: boolean, status?: number, codes: number[] = [], failure: RequestFailure = {}) {
    super(`Cloudflare ${step}: ${status ? `HTTP ${status}` : kind === 'unreachable' ? 'no answer' : 'an answer that could not be read'}${codes.length ? ` (codes ${codes.join(', ')})` : ''}`)
    this.step = step; this.kind = kind; this.definite = definite; this.status = status; this.codes = codes; this.failure = failure
  }
}

/** What reaches Cloudflare: its API, or the stand-in on loopback (tests only, never a packaged build). */
export interface PagesTransport {
  fetch: typeof fetch
  apiBase: string
  /** Tests only: `http://127.0.0.1:<port>/client/v4` is allowed, and the site record is read from the stand-in too. */
  allowLoopbackForTests?: boolean
  /** The site's public address (Settings → Cloudflare), a second place to read the site record. */
  publicBase?: string
  /** The content type an asset is uploaded with: wrangler's (`loadWranglerMime`). */
  contentType(path: string): string
  sleep?(ms: number): Promise<void>
  /** Accelerates request deadlines against the loopback test server only. */
  testRequestMs?: number
}

const LOOPBACK_BASE = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/client\/v4$/u
function checkedBase(transport: PagesTransport): string {
  if (transport.apiBase === CLOUDFLARE_API_BASE) return CLOUDFLARE_API_BASE
  if (transport.allowLoopbackForTests === true && LOOPBACK_BASE.test(transport.apiBase)) return transport.apiBase
  throw new PagesApiError('address', 'failed', true)
}

const REQUEST_MS = 60_000
const UPLOAD_REQUEST_MS = 10 * 60_000
const REPLY_BYTES = 32 * 1024 * 1024
const MAX_RETRY_DELAY_MS = 120_000
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

const uploadDeadline = new AsyncLocalStorage<{ url: URL; ms: number }>()
// As in wrangler-launcher, extend Undici's separate 300 s timers before the dispatcher
// reads them. Scope the hook to this request so it also works through a proxy dispatcher.
subscribe('undici:request:create', (event: unknown) => {
  const deadline = uploadDeadline.getStore()
  if (!deadline || !isRecord(event) || !isRecord(event.request)) return
  const request = event.request
  if (request.method !== 'POST' || request.origin !== deadline.url.origin || request.path !== deadline.url.pathname) return
  request.headersTimeout = deadline.ms
  request.bodyTimeout = deadline.ms
})

function retryAfter(value: string | null): number | undefined {
  if (!value) return
  const ms = /^\d+$/u.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  if (Number.isSafeInteger(ms)) return Math.max(0, ms)
  if (/^\d+$/u.test(value)) return Number.MAX_SAFE_INTEGER
}

function networkCode(error: unknown): string | undefined {
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : error
  const code = isRecord(cause) ? cause.code : undefined
  return typeof code === 'string' && /^(?:EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETDOWN|ENETUNREACH|ENOTFOUND|EPIPE|ETIMEDOUT|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/u.test(code) ? code : undefined
}

function retryDelay(error: PagesApiError, attempt: number): number | undefined {
  const { status, failure } = error
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)
    || ((status === undefined || status < 300) && (failure.kind === 'network' || failure.kind === 'timeout'))) {
    const ms = failure.retryAfterMs ?? 1000 * 2 ** (attempt - 1)
    if (ms <= MAX_RETRY_DELAY_MS) return ms
  }
}

function kindOf(status: number | undefined, codes: number[], step: string): PublishFailureKind {
  if (status === 403 || codes.includes(10000)) return 'permission'
  if (status === 401 || codes.includes(1000) || codes.includes(10001)) return 'token'
  if (codes.includes(8000007) || (status === 404 && step.startsWith('project'))) return 'no-site'
  if (status === 413) return 'too-large'
  return 'failed'
}

function jwtExpired(jwt: string): boolean {
  try { const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64').toString()) as { exp?: number }; return typeof payload.exp === 'number' && payload.exp <= Date.now() / 1000 } catch { return false }
}

export interface PagesSiteApi {
  /** The production deployment's id, or null when the site has none. */
  productionId(signal?: AbortSignal): Promise<string | null>
  /**
   * Step 4: upload what Cloudflare lacks of `staged`, then refresh every hash of the new deployment. Answers the hashes sent.
   * `stillCurrent` is asked before every request after the first: false stops the upload (UploadSuperseded).
   */
  uploadAssets(staged: readonly StagedAsset[], allHashes: readonly string[], stillCurrent?: () => boolean, transfer?: Transfer): Promise<{ missing: string[]; sent: string[] }>
  /** Step 7: ONE deployment request (see the top: never retried here). */
  createDeployment(form: { manifest: Record<string, string>; branch: string; commitMessage: string; redirects: string; headers: string }): Promise<{ id: string }>
  /** Step 8: the deployment succeeded and its files match. Require the current revision unless the caller reads it back. */
  confirm(id: string, manifest: Record<string, string>, requireCurrent?: boolean, report?: (attempt: number, retry?: TransferReport['retry']) => void): Promise<void>
  /**
   * An earlier attempt's deployment, by its id or (its answer lost) by the candidate digest of its commit message: `absent` when
   * there is none, else its state and id. By digest, the project's deployments are read page by page (newest first) until it is
   * found, the list ends, or it reaches deployments made before `notBefore` (ms): only then is it `absent`. Throws when
   * Cloudflare cannot say, or the search could not reach that far.
   */
  findDeployment(which: { id?: string; candidateDigest: string; notBefore?: number }): Promise<{ state: 'absent' } | { state: 'pending' | 'success' | 'failure'; id: string; production: boolean }>
}

/**
 * The calls of one publish to one Pages site with the person's token. Build it inside `authorisation.run` so the token is held
 * only for that launch.
 */
export function pagesSiteApi(transport: PagesTransport, site: { token: string; accountId: string; project: string }): PagesSiteApi {
  const base = checkedBase(transport)
  const sleep = (ms: number, signal?: AbortSignal) => transport.sleep?.(ms) ?? wait(ms, undefined, { signal })
  const projectPath = `/accounts/${encodeURIComponent(site.accountId)}/pages/projects/${encodeURIComponent(site.project)}`
  const credentials = [site.token]

  async function call(step: string, path: string, init: { method?: string; auth: string; json?: unknown; body?: FormData | string; timeoutMs?: number; whole?: true; signal?: AbortSignal }): Promise<unknown> {
    const timeoutMs = (base !== CLOUDFLARE_API_BASE ? transport.testRequestMs : undefined) ?? init.timeoutMs ?? REQUEST_MS
    const started = performance.now()
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const transportError = (error: unknown, status?: number): never => {
      if (init.signal?.aborted) throw new UploadCancelled()
      const code = networkCode(error)
      if (timeout.aborted || code?.endsWith('TIMEOUT') || code === 'ETIMEDOUT') {
        const actualTimeout = timeout.aborted ? timeoutMs : Math.round(performance.now() - started)
        throw new PagesApiError(step, 'unreachable', false, status, [], { kind: 'timeout', timeoutMs: actualTimeout, ...(code ? { networkCode: code } : {}) })
      }
      throw new PagesApiError(step, 'unreachable', false, status, [], { kind: 'network', ...(code ? { networkCode: code } : {}) })
    }
    let response: Response
    try {
      const address = `${base}${path}`
      const request = () => transport.fetch(address, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${init.auth}`, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.body !== undefined ? { body: init.body } : {}),
        redirect: 'manual',
        signal,
      })
      response = await (init.timeoutMs === UPLOAD_REQUEST_MS
        ? uploadDeadline.run({ url: new URL(address), ms: timeoutMs }, request)
        : request())
    } catch (error) { return transportError(error) }
    let envelope: unknown = null
    const declared = Number(response.headers.get('content-length') ?? '')
    if (declared > REPLY_BYTES) await response.body?.cancel().catch(() => {})
    else {
      let bytes: ArrayBuffer
      try { bytes = await response.arrayBuffer() } catch (error) { return transportError(error, response.status) }
      if (bytes.byteLength && bytes.byteLength <= REPLY_BYTES) {
        try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
        catch (error) {
          // A parser exception can quote the body, including a fragment of a credential.
          const name = error instanceof SyntaxError ? 'SyntaxError' : 'TypeError'
          console.warn(`[publish] ${step}: ${name}: Cloudflare returned a response that was not readable JSON.`)
        }
      }
    }
    const errors: NonNullable<PublishDiagnostic['cloudflareErrors']> = []
    if (isRecord(envelope) && Array.isArray(envelope.errors)) {
      for (const entry of envelope.errors.slice(0, 5)) {
        if (!isRecord(entry)) continue
        const code = typeof entry.code === 'number' && Number.isSafeInteger(entry.code) ? entry.code : undefined
        const message = typeof entry.message === 'string' ? redactPublishText(entry.message, credentials) : undefined
        if (code !== undefined || message) errors.push({ ...(code === undefined ? {} : { code }), ...(message ? { message } : {}) })
      }
    }
    const codes = errors.flatMap(error => error.code === undefined ? [] : [error.code])
    if (response.status >= 300 && response.status <= 399) throw new PagesApiError(step, 'failed', true, response.status)
    if (response.status === 200 && isRecord(envelope) && envelope.success === true) return init.whole ? envelope : envelope.result
    // A refusal Cloudflare stated (a 4xx with its envelope) changed nothing; anything else may have.
    const definite = response.status >= 400 && response.status < 500 && isRecord(envelope) && envelope.success === false
    const viaIntermediary = response.status === 403 && !definite
    const kind = viaIntermediary ? 'failed' : response.status >= 500 && !codes.length ? 'unreachable' : kindOf(response.status, codes, step)
    const retryAfterMs = retryAfter(response.headers.get('retry-after'))
    throw new PagesApiError(step, kind, definite, response.status, codes, {
      kind: response.status >= 400 ? 'http' : 'response',
      ...(errors.length ? { cloudflareErrors: errors } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(viaIntermediary ? { viaIntermediary: true } : {}),
    })
  }

  async function uploadToken(signal?: AbortSignal): Promise<string> {
    const result = await call('upload token', `${projectPath}/upload-token`, { auth: site.token, signal })
    if (!isRecord(result) || typeof result.jwt !== 'string' || !/^[\x21-\x7e]{1,8192}$/u.test(result.jwt)) throw new PagesApiError('upload token', 'failed', true)
    credentials.push(result.jwt)
    return result.jwt
  }

  async function project(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await call('project', projectPath, { auth: site.token, signal })
    if (!isRecord(result) || result.name !== site.project) throw new PagesApiError('project', 'failed', false)
    return result
  }

  async function productionId(signal?: AbortSignal): Promise<string | null> {
    const found = await project(signal)
    if (found.canonical_deployment === null) return null
    const canonical = found.canonical_deployment
    if (!isRecord(canonical) || typeof canonical.id !== 'string' || !canonical.id) throw new PagesApiError('project', 'failed', false)
    return canonical.id
  }

  return {
    productionId,

    async uploadAssets(staged, allHashes, stillCurrent = () => true, transfer = {}) {
      const stopBatches = new AbortController()
      const signal = transfer.signal ? AbortSignal.any([transfer.signal, stopBatches.signal]) : stopBatches.signal
      const goOn = (checkCurrent = true): void => {
        if (signal.aborted) throw new UploadCancelled()
        if (checkCurrent && !stillCurrent()) throw new UploadSuperseded('superseded')
      }
      let firstRequest = true
      let filesAcknowledged = 0
      let bytesSent = 0
      const sent = new Set<string>()
      const active = new Map<number, PublishLocation & { retry?: TransferReport['retry'] }>()
      const report = (location: PublishLocation, retry?: TransferReport['retry']): void => {
        const state = { ...location, ...(retry ? { retry } : {}) }
        if (location.batch) active.set(location.batch, state)
        const waiting = location.batch && [...active.values()].find(batch => batch.retry && batch.retry.at > Date.now())
        transfer.report?.({ ...(waiting || state), filesAcknowledged, filesTotal: staged.length, filesSent: sent.size, bytesSent })
      }
      async function retryRequest<T>(
        operation: Omit<PublishLocation, 'attempt'>, maxAttempts: number,
        request: () => Promise<T>, refresh?: () => Promise<boolean>,
        fallback?: (attempt: number) => Promise<T>, firstAttempt = 1,
      ): Promise<T> {
        for (let attempt = firstAttempt; ; attempt++) {
          // The launch already authorised the first token request. Check the current
          // connection before any later request and allow cancellation from the start.
          goOn(!firstRequest)
          firstRequest = false
          const location = { ...operation, attempt }
          report(location)
          try { return await request() }
          catch (error) {
            goOn()
            if (!(error instanceof PagesApiError)) throw error
            error.location = location
            if (attempt >= maxAttempts) throw error
            if (!error.failure.viaIntermediary && (error.status === 401 || error.status === 403 || error.status === 200) && refresh
              && (error.status === 401 || error.codes.includes(UNAUTHORIZED_JWT) || jwtExpired(jwt))) {
              if (await refresh()) {
                if (fallback) return await fallback(attempt + 1)
                continue
              }
              throw error
            }
            const delayMs = retryDelay(error, attempt)
            if (delayMs === undefined) throw error
            report(location, { delayMs, nextAttempt: attempt + 1, maxAttempts, at: Date.now() + delayMs })
            try { await sleep(delayMs, signal) } catch (error) { goOn(); throw error }
            if (fallback) return await fallback(attempt + 1)
          }
        }
      }
      const getJwt = () => retryRequest({ step: 'token' }, PAGES_UPLOAD.uploadAttempts, () => uploadToken(signal))
      let jwt = await getJwt()
      let refreshes = 0
      let refreshInFlight: Promise<void> | undefined
      const refresh = async (used: string): Promise<boolean> => {
        if (used !== jwt) return true
        if (!refreshInFlight) {
          if (refreshes >= PAGES_UPLOAD.tokenRefreshes) return false
          refreshes++
          refreshInFlight = getJwt().then(next => { jwt = next }).finally(() => { refreshInFlight = undefined })
        }
        await refreshInFlight
        return true
      }
      const hashes = [...new Set(staged.map(file => file.hash))]
      const tooLarge = staged.find((file) => file.size > PAGES_UPLOAD.maxAssetBytes)
      if (tooLarge) {
        const error = new PagesApiError('upload', 'too-large', true)
        error.location = { step: 'upload', attempt: 0 }
        throw error
      }
      let checkAttempt = 0
      function checkMissing(hashes: string[], reportAttempt?: () => void): Promise<string[]> {
        const requested = new Set(hashes)
        let used = jwt
        return retryRequest({ step: 'check-missing' }, PAGES_UPLOAD.checkMissingAttempts, async () => {
          reportAttempt?.()
          used = jwt
          const result = await call('check-missing', '/pages/assets/check-missing', { method: 'POST', auth: used, json: { hashes }, signal })
          if (!Array.isArray(result) || result.some(hash => typeof hash !== 'string' || !requested.has(hash))) {
            throw new PagesApiError('check-missing', 'failed', true)
          }
          return result as string[]
        }, () => refresh(used))
      }
      const missing = await checkMissing(hashes, () => { checkAttempt++ })
      const wanted = new Set(missing)
      const stagedCounts = new Map<string, number>()
      for (const file of staged) stagedCounts.set(file.hash, (stagedCounts.get(file.hash) ?? 0) + 1)
      filesAcknowledged = staged.filter(file => !wanted.has(file.hash)).length
      report({ step: 'check-missing', attempt: checkAttempt })
      // One copy of each missing hash, largest first, into wrangler's buckets.
      const seen = new Set<string>()
      const toSend = staged.filter((file) => wanted.has(file.hash) && !seen.has(file.hash) && seen.add(file.hash)).sort((a, b) => b.size - a.size)
      const buckets: Array<{ files: StagedAsset[]; remaining: number }> = Array.from({ length: PAGES_UPLOAD.concurrency }, () => ({ files: [], remaining: PAGES_UPLOAD.bucketBytes }))
      let offset = 0
      for (const file of toSend) {
        let placed = false
        for (let i = 0; i < buckets.length; i++) {
          const bucket = buckets[(i + offset) % buckets.length]
          if (bucket.remaining >= file.size && bucket.files.length < PAGES_UPLOAD.bucketFiles) { bucket.files.push(file); bucket.remaining -= file.size; placed = true; break }
        }
        if (!placed) buckets.push({ files: [file], remaining: PAGES_UPLOAD.bucketBytes - file.size })
        offset++
      }
      const queue = buckets.filter((bucket) => bucket.files.length)
      const acknowledgement = (files: readonly StagedAsset[], uploaded: boolean): void => {
        for (const file of files) {
          filesAcknowledged += stagedCounts.get(file.hash) ?? 0
          if (uploaded) { sent.add(file.hash); bytesSent += file.size }
        }
      }
      // A finished worker can report the count against a sibling that's still active.
      const sendBucket = async (i: number): Promise<void> => {
        const bucket = queue[i]
        const operation = { step: 'upload', batch: i + 1, batches: queue.length } as const
        let used = jwt
        async function upload(files: readonly StagedAsset[]): Promise<void> {
          let payload: { key: string; value: string; metadata: { contentType: string }; base64: true }[]
          try {
            payload = files.map(file => ({ key: file.hash, value: file.read().toString('base64'), metadata: { contentType: transport.contentType(file.path) }, base64: true }))
          } catch (error) {
            throw new PagesApiError('upload', 'failed', true, undefined, [], { kind: 'local', cause: redactPublishException(error) })
          }
          used = jwt
          await call('upload', '/pages/assets/upload', { method: 'POST', auth: used, json: payload, timeoutMs: UPLOAD_REQUEST_MS, signal })
          acknowledgement(files, true)
        }
        const resendIndividually = async (firstAttempt: number): Promise<void> => {
          active.delete(i + 1)
          const remaining = new Set(await checkMissing(bucket.files.map(file => file.hash)))
          for (const file of bucket.files) {
            if (remaining.has(file.hash)) {
              await retryRequest(operation, PAGES_UPLOAD.uploadAttempts, () => upload([file]), () => refresh(used), undefined, firstAttempt)
            } else acknowledgement([file], false)
          }
        }
        await retryRequest(operation, PAGES_UPLOAD.uploadAttempts, () => upload(bucket.files), () => refresh(used), resendIndividually)
        const finished = active.get(i + 1)
        active.delete(i + 1)
        const pending = active.values().next().value
        if (pending) report(pending, pending.retry)
        else transfer.report?.({ ...operation, attempt: finished?.attempt ?? 1, filesAcknowledged, filesTotal: staged.length, filesSent: sent.size, bytesSent })
      }
      let next = 0
      let failure: { error: unknown } | undefined
      await Promise.all(Array.from({ length: Math.min(PAGES_UPLOAD.concurrency, queue.length) }, async () => {
        try {
          for (let i = next++; i < queue.length; i = next++) await sendBucket(i)
        } catch (error) {
          failure ??= { error }
          stopBatches.abort()
        }
      }))
      if (failure) throw failure.error
      goOn()
      // Every hash of the new deployment, as wrangler sends every hash of its: only keeps Cloudflare's cache warm.
      let cachedWith = jwt
      try {
        await retryRequest({ step: 'upsert-hashes' }, 2, () => {
          cachedWith = jwt
          return call('upsert-hashes', '/pages/assets/upsert-hashes', { method: 'POST', auth: cachedWith, json: { hashes: [...new Set(allHashes)] }, signal })
        }, () => refresh(cachedWith))
      } catch { goOn() /* A later upload may be slower. */ }
      return { missing, sent: [...sent] }
    },

    async createDeployment(form) {
      const message = Buffer.from(form.commitMessage, 'utf8').subarray(0, PAGES_UPLOAD.commitMessageBytes).toString('utf8').replace(/�+$/u, '')
      const body = (): FormData => {
        const data = new FormData()
        data.append('manifest', JSON.stringify(form.manifest))
        data.append('branch', form.branch)
        if (message) data.append('commit_message', message)
        data.append('commit_dirty', 'true')
        if (form.headers) data.append('_headers', new File([form.headers], '_headers'))
        if (form.redirects) data.append('_redirects', new File([form.redirects], '_redirects'))
        return data
      }
      const result = await call('deployment', `${projectPath}/deployments`, { method: 'POST', auth: site.token, body: body(), timeoutMs: UPLOAD_REQUEST_MS })
      if (!isRecord(result) || typeof result.id !== 'string' || !result.id) throw new PagesApiError('deployment', 'failed', false)
      return { id: result.id }
    },

    async confirm(id, manifest, requireCurrent = true, report) {
      await sleep(1000)
      for (let attempt = 1; ; attempt++) {
        report?.(attempt)
        let delayMs = 1000 * 2 ** attempt
        try {
          const result = await call('deployment status', `${projectPath}/deployments/${encodeURIComponent(id)}`, { auth: site.token })
          if (!isRecord(result) || result.id !== id) throw new PagesApiError('deployment status', 'failed', false)
          const stage = isRecord(result.latest_stage) ? result.latest_stage : {}
          if (stage.status === 'failure' || stage.status === 'canceled') {
            throw new PagesApiError('deployment status', 'failed', false, undefined, [], {
              kind: 'response', cause: stage.status === 'failure' ? 'Cloudflare reported that the deployment failed.' : 'Cloudflare cancelled the deployment.',
            })
          }
          if (stage.name === 'deploy' && stage.status === 'success') {
            const files = result.files
            if (result.environment !== 'production' || !isRecord(files)) {
              throw new PagesApiError('confirm production manifest', 'failed', false, undefined, [], {
                kind: 'response', cause: 'Cloudflare did not return a production deployment with a file list.',
              })
            }
            // Site-level files travel beside the manifest.
            const keys = Object.keys(files).filter(key => !SITE_LEVEL.has(key))
            if (keys.length !== Object.keys(manifest).length || keys.some(key => files[key] !== manifest[key])) {
              throw new PagesApiError('confirm production manifest', 'failed', false, undefined, [], {
                kind: 'response', cause: 'Cloudflare’s production file list differed from the handout deployment.',
              })
            }
            if (requireCurrent && (await productionId()) !== id) throw new PagesApiError('confirm current deployment', 'failed', false)
            return
          }
          if (attempt >= PAGES_UPLOAD.statusAttempts) throw new PagesApiError('deployment still pending', 'failed', false, undefined, [], {
            kind: 'response', cause: 'Cloudflare was still processing the deployment at the last check.',
          })
        } catch (error) {
          if (!(error instanceof PagesApiError)) throw error
          error.location = { step: 'confirm', attempt }
          const transient = retryDelay(error, attempt)
          if (transient === undefined || attempt >= PAGES_UPLOAD.statusAttempts) throw error
          delayMs = transient
          report?.(attempt, { delayMs, nextAttempt: attempt + 1, maxAttempts: PAGES_UPLOAD.statusAttempts, at: Date.now() + delayMs })
        }
        await sleep(delayMs)
      }
    },

    async findDeployment(which) {
      const stateOf = (deployment: Record<string, unknown>): 'pending' | 'success' | 'failure' => {
        const stage = isRecord(deployment.latest_stage) ? deployment.latest_stage : {}
        if (stage.status === 'failure' || stage.status === 'canceled') return 'failure'
        return stage.name === 'deploy' && stage.status === 'success' ? 'success' : 'pending'
      }
      let found: Record<string, unknown> | null = null
      if (which.id) {
        try {
          const result = await call('deployment status', `${projectPath}/deployments/${encodeURIComponent(which.id)}`, { auth: site.token })
          if (isRecord(result) && result.id === which.id) found = result
        } catch (error) {
          if (!(error instanceof PagesApiError && error.status === 404)) throw error
        }
      } else {
        const marker = `tw-candidate:${which.candidateDigest}`
        const carries = (entry: unknown): entry is Record<string, unknown> => isRecord(entry) && isRecord(entry.deployment_trigger) && isRecord(entry.deployment_trigger.metadata) && entry.deployment_trigger.metadata.commit_message === marker
        const madeBefore = (entry: unknown): boolean => {
          const made = isRecord(entry) && typeof entry.created_on === 'string' ? Date.parse(entry.created_on) : Number.NaN
          return which.notBefore !== undefined && Number.isFinite(made) && made < which.notBefore
        }
        let searched = false
        for (let page = 1; page <= DEPLOYMENT_PAGES && !found && !searched; page++) {
          const envelope = await call('deployments', `${projectPath}/deployments?page=${page}&per_page=${DEPLOYMENTS_PER_PAGE}`, { auth: site.token, whole: true })
          const list = isRecord(envelope) ? envelope.result : null
          if (!Array.isArray(list)) throw new PagesApiError('deployments', 'failed', false)
          found = list.find(carries) ?? null
          const info = isRecord(envelope) && isRecord(envelope.result_info) ? envelope.result_info : null
          const lastPage = info && typeof info.total_pages === 'number' ? page >= info.total_pages : list.length < DEPLOYMENTS_PER_PAGE
          // Newest first: once the list holds a deployment made before the request was sent, every later page is older still.
          searched = list.length === 0 || lastPage || list.some(madeBefore)
        }
        if (!found && !searched) throw new PagesApiError('deployments', 'failed', false)
      }
      if (!found || typeof found.id !== 'string') return { state: 'absent' }
      return { state: stateOf(found), id: found.id, production: (await productionId()) === found.id }
    },
  }
}

/**
 * Where the site record of the production deployment can be read, in order: the deployment's own address, then the site's public
 * address. Under the stand-in API (tests) only the stand-in itself, so no request leaves this computer.
 */
export function siteAssetAddresses(transport: PagesTransport, deployment: { id: string; url?: string }, path: string): string[] {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  if (transport.allowLoopbackForTests === true) {
    const base = checkedBase(transport)
    return base === CLOUDFLARE_API_BASE ? [] : [`${base}/__pages-assets/${encodeURIComponent(deployment.id)}${encoded}`]
  }
  const addresses: string[] = []
  if (deployment.url && /^https:\/\/[0-9a-f]{8}\.[a-z0-9-]+\.pages\.dev$/u.test(deployment.url)) addresses.push(`${deployment.url}${encoded}`)
  const pub = (transport.publicBase ?? '').trim().replace(/\/+$/u, '')
  if (/^https:\/\/[a-z0-9.-]+(?::\d+)?$/iu.test(pub) && !/^https:\/\/(?:localhost|127\.|0\.0\.0\.0|\[)/iu.test(pub)) addresses.push(`${pub}${encoded}`)
  return addresses
}

/**
 * The bytes of one asset of the live site, read without any token from the addresses `siteAssetAddresses` gives, and taken only
 * when their hash is the manifest's (`expectedHash`). Null when no address gave those bytes.
 */
export async function readLiveAsset(transport: PagesTransport, blake3: Blake3, addresses: readonly string[], path: string, expectedHash: string, cap = 1024 * 1024): Promise<Buffer | null> {
  for (const address of addresses) {
    try {
      const response = await transport.fetch(address, { method: 'GET', redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
      if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); continue }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > cap) continue
      if (pagesAssetHash(blake3, bytes, path) === expectedHash) return bytes
    } catch { /* the next address */ }
  }
  return null
}
