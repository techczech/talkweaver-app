// Cloudflare Pages Direct Upload, made the way the bundled wrangler (4.153, wrangler-dist/cli.js) makes it for `pages deploy`,
// for ONE change merged into the live manifest (spec docs/plans/2026-11-05-per-talk-publishing/spec.md, steps 3 to 8).
//
//   hash       blake3(base64(bytes) + extension without the dot), hex, first 32 characters: wrangler's `hashFile`, with the
//              same blake3-wasm module wrangler itself loads (`loadWranglerBlake3`). Pinned by a vector wrangler produced
//              (scripts/test-per-talk-publishing.mjs).
//   upload     GET  /accounts/:a/pages/projects/:p/upload-token  (the person's token)  → a JWT
//              POST /pages/assets/check-missing {hashes}          (the JWT)  5 attempts, 2^n s apart, a new JWT on 8000013 or expiry
//              POST /pages/assets/upload [{key, value, metadata: {contentType}, base64: true}]
//                   buckets of at most 40 MiB and 2000 files (1000 on Windows), largest first, 3 at a time; 5 attempts, 2^n s
//                   apart; a gateway error waits 2^g × 5 s and counts as an attempt after 5 of them
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
// Only the bytes check-missing names are read and sent (`StagedAsset.read`). Every failure is a PagesApiError whose message is
// built from fixed words, the HTTP status and Cloudflare's numeric error codes: never the token, a JWT, an address with a
// secret in it, or text from a reply. Redirects are never followed. No Electron import: the tests import this file as it is.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
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
  gatewayErrors: 5,
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

/** A refusal or failure of one request. `definite`: Cloudflare answered with a refusal, so that request changed nothing. */
export class PagesApiError extends Error {
  readonly kind: PublishFailureKind
  readonly step: string
  readonly status?: number
  readonly codes: number[]
  readonly definite: boolean
  constructor(step: string, kind: PublishFailureKind, definite: boolean, status?: number, codes: number[] = []) {
    super(`Cloudflare ${step}: ${status ? `HTTP ${status}` : kind === 'unreachable' ? 'no answer' : 'an answer that could not be read'}${codes.length ? ` (codes ${codes.join(', ')})` : ''}`)
    this.step = step; this.kind = kind; this.definite = definite; this.status = status; this.codes = codes
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
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

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
  productionId(): Promise<string | null>
  /**
   * Step 4: upload what Cloudflare lacks of `staged`, then refresh every hash of the new deployment. Answers the hashes sent.
   * `stillCurrent` is asked before every request after the first: false stops the upload (UploadSuperseded).
   */
  uploadAssets(staged: readonly StagedAsset[], allHashes: readonly string[], stillCurrent?: () => boolean): Promise<{ missing: string[]; sent: string[] }>
  /** Step 7: ONE deployment request (see the top: never retried here). */
  createDeployment(form: { manifest: Record<string, string>; branch: string; commitMessage: string; redirects: string; headers: string }): Promise<{ id: string }>
  /** Step 8: the deployment `id` is production and its files are exactly `manifest`. */
  confirm(id: string, manifest: Record<string, string>): Promise<boolean>
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
  const sleep = transport.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const projectPath = `/accounts/${encodeURIComponent(site.accountId)}/pages/projects/${encodeURIComponent(site.project)}`

  async function call(step: string, path: string, init: { method?: string; auth: string; json?: unknown; body?: FormData | string; timeoutMs?: number; whole?: true }): Promise<unknown> {
    let response: Response
    try {
      response = await transport.fetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${init.auth}`, ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.body !== undefined ? { body: init.body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_MS),
      })
    } catch {
      // The transport's own text can quote the request: dropped unread.
      throw new PagesApiError(step, 'unreachable', false)
    }
    let envelope: unknown = null
    try {
      const declared = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > REPLY_BYTES) throw new Error('too large')
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > REPLY_BYTES) throw new Error('too large')
      envelope = bytes.byteLength ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : null
    } catch { envelope = null }
    const codes = isRecord(envelope) && Array.isArray(envelope.errors)
      ? envelope.errors.map((entry: unknown) => (isRecord(entry) ? entry.code : undefined)).filter((code): code is number => typeof code === 'number' && Number.isSafeInteger(code)).slice(0, 5)
      : []
    if (response.status >= 300 && response.status <= 399) throw new PagesApiError(step, 'failed', true, response.status)
    if (response.status === 200 && isRecord(envelope) && envelope.success === true) return init.whole ? envelope : envelope.result
    // A refusal Cloudflare stated (a 4xx with its envelope) changed nothing; anything else may have.
    const definite = response.status >= 400 && response.status < 500 && isRecord(envelope) && envelope.success === false
    const kind = response.status >= 500 && !codes.length ? 'unreachable' : kindOf(response.status, codes, step)
    throw new PagesApiError(step, kind, definite, response.status, codes)
  }

  async function uploadToken(): Promise<string> {
    const result = await call('upload token', `${projectPath}/upload-token`, { auth: site.token })
    if (!isRecord(result) || typeof result.jwt !== 'string' || !/^[\x21-\x7e]{1,8192}$/u.test(result.jwt)) throw new PagesApiError('upload token', 'failed', true)
    return result.jwt
  }

  async function project(): Promise<Record<string, unknown>> {
    const result = await call('project', projectPath, { auth: site.token })
    if (!isRecord(result) || result.name !== site.project) throw new PagesApiError('project', 'failed', false)
    return result
  }

  async function productionId(): Promise<string | null> {
    const found = await project()
    if (found.canonical_deployment === null) return null
    const canonical = found.canonical_deployment
    if (!isRecord(canonical) || typeof canonical.id !== 'string' || !canonical.id) throw new PagesApiError('project', 'failed', false)
    return canonical.id
  }

  return {
    productionId,

    async uploadAssets(staged, allHashes, stillCurrent = () => true) {
      const goOn = (): void => { if (!stillCurrent()) throw new UploadSuperseded('superseded') }
      let jwt = await uploadToken()
      let refreshes = 0
      const refresh = async (): Promise<void> => {
        if (refreshes >= PAGES_UPLOAD.tokenRefreshes) throw new PagesApiError('upload token', 'failed', true)
        refreshes++
        goOn()
        jwt = await uploadToken()
      }
      const refused = (error: unknown): boolean => (error instanceof PagesApiError && error.codes.includes(UNAUTHORIZED_JWT)) || jwtExpired(jwt)
      const hashes = [...new Set(staged.map((file) => file.hash))]
      const tooLarge = staged.find((file) => file.size > PAGES_UPLOAD.maxAssetBytes)
      if (tooLarge) throw new PagesApiError('upload', 'too-large', true)
      // check-missing: wrangler's retries, every one counted, with a new upload token when the old one is refused or has run out.
      let missing: string[] = []
      for (let attempts = 0; ; attempts++) {
        goOn()
        try {
          const result = await call('check-missing', '/pages/assets/check-missing', { method: 'POST', auth: jwt, json: { hashes } })
          if (!Array.isArray(result) || result.some((hash) => typeof hash !== 'string')) throw new PagesApiError('check-missing', 'failed', true)
          missing = result as string[]
          break
        } catch (error) {
          if (attempts + 1 >= PAGES_UPLOAD.checkMissingAttempts) throw error
          await sleep(2 ** attempts * 1000)
          if (refused(error)) await refresh()
        }
      }
      const wanted = new Set(missing)
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
      const sendBucket = async (bucket: { files: StagedAsset[] }): Promise<void> => {
        let attempts = 0
        let gateway = 0
        for (;;) {
          goOn()
          // The bytes of this bucket only, read when it is sent.
          const payload = bucket.files.map((file) => ({ key: file.hash, value: file.read().toString('base64'), metadata: { contentType: transport.contentType(file.path) }, base64: true }))
          try {
            await call('upload', '/pages/assets/upload', { method: 'POST', auth: jwt, json: payload, timeoutMs: UPLOAD_REQUEST_MS })
            return
          } catch (error) {
            // Every failed attempt counts, whatever comes next: the retries are bounded.
            attempts++
            if (attempts >= PAGES_UPLOAD.uploadAttempts + PAGES_UPLOAD.gatewayErrors) throw error
            await sleep(2 ** Math.min(attempts, 5) * 1000)
            const status = error instanceof PagesApiError ? error.status : undefined
            if (status === 502 || status === 503 || status === 504) { await sleep(2 ** gateway * 5000); gateway++ }
            else if (refused(error)) await refresh()
            else if (attempts >= PAGES_UPLOAD.uploadAttempts) throw error
          }
        }
      }
      const queue = buckets.filter((bucket) => bucket.files.length)
      let next = 0
      await Promise.all(Array.from({ length: Math.min(PAGES_UPLOAD.concurrency, queue.length) }, async () => {
        for (let i = next++; i < queue.length; i = next++) await sendBucket(queue[i])
      }))
      goOn()
      // Every hash of the new deployment, as wrangler sends every hash of its: only keeps Cloudflare's cache warm.
      const upsert = (): Promise<unknown> => call('upsert-hashes', '/pages/assets/upsert-hashes', { method: 'POST', auth: jwt, json: { hashes: [...new Set(allHashes)] } })
      try { await upsert() } catch (error) {
        await sleep(1000)
        try {
          goOn()
          if (refused(error)) await refresh()
          await upsert()
        } catch (again) { if (again instanceof UploadSuperseded) throw again /* else wrangler only warns: a later upload is slower */ }
      }
      return { missing, sent: toSend.map((file) => file.hash) }
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

    async confirm(id, manifest) {
      let deployment: Record<string, unknown> | null = null
      for (let attempts = 0; attempts < PAGES_UPLOAD.statusAttempts; attempts++) {
        await sleep(2 ** attempts * 1000)
        try {
          const result = await call('deployment status', `${projectPath}/deployments/${encodeURIComponent(id)}`, { auth: site.token })
          if (!isRecord(result) || result.id !== id) continue
          deployment = result
          const stage = isRecord(result.latest_stage) ? result.latest_stage : {}
          if (stage.name === 'deploy' && (stage.status === 'success' || stage.status === 'failure')) break
        } catch { /* asked again, as wrangler does */ }
      }
      if (!deployment) return false
      const stage = isRecord(deployment.latest_stage) ? deployment.latest_stage : {}
      if (stage.name !== 'deploy' || stage.status !== 'success' || deployment.environment !== 'production') return false
      const files = deployment.files
      if (!isRecord(files)) return false
      // The site-level files are sent beside the manifest; should Cloudflare list them among the files, they are not the manifest's.
      const keys = Object.keys(files).filter((key) => !SITE_LEVEL.has(key))
      if (keys.length !== Object.keys(manifest).length || keys.some((key) => files[key] !== manifest[key])) return false
      try { return (await productionId()) === id } catch { return false }
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
