/**
 * Read-only inventory of ONE Cloudflare Pages production deployment (spec §4).
 *
 * Plan: project → deployment (with its undocumented `files` map) → project again; if production
 * moved, one retry, then `incomplete`. At most five GET requests, only the two URL templates, only
 * the fixed production base (a loopback base exists for tests behind an explicit flag). Redirects
 * are never followed. Every reply is size-capped, decoded as strict UTF-8 and parsed by the strict
 * parser. Results carry fixed reason codes, HTTP status and numeric API error codes only: never a
 * message, a body, a value from the transport's own error (it can quote the request), or the token.
 * Nothing in a reply is opened, fetched or resolved.
 */
import { evidenceTime } from '../../shared/inventory-schema.ts'
import {
  ACCOUNT_ID,
  MAX_INVENTORY_FILES,
  MAX_INVENTORY_REQUESTS,
  PAGES_ASSET_HASH,
  PROJECT_NAME,
  UUID,
  classifyInventoryPath,
  toISO,
  type InventoryResult,
  type MalformedDetail,
  type PathIssue,
  type ProductionDeployment,
  type WorkerFailureReason,
  type WorkerIncompleteReason
} from '../../shared/inventory-schema.ts'
import { parseStrictJson } from './strict-json.ts'

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const LOOPBACK_BASE = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/client\/v4$/u

export interface InventoryLimits {
  requestTimeoutMs: number
  totalMs: number
  projectBytes: number
  deploymentBytes: number
}
/** Ceilings. A caller may tighten them (tests do); it can never widen them. */
export const INVENTORY_LIMITS: Readonly<InventoryLimits> = Object.freeze({
  requestTimeoutMs: 15_000,
  totalMs: 45_000,
  projectBytes: 4 * 1024 * 1024,
  deploymentBytes: 32 * 1024 * 1024
})
const ERROR_BODY_BYTES = 64 * 1024
const TOKEN = /^[\x21-\x7e]{16,512}$/u
const API_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u
const SHORT_ID = /^[0-9a-f]{8}$/u
const EARLIEST_DEPLOYMENT = Date.parse('2015-01-01T00:00:00.000Z')

export interface InventoryQuery {
  fetch: typeof fetch
  apiBase: string
  /** Tests only: allows `http://127.0.0.1:<port>/client/v4`. The worker entry never passes it. */
  allowLoopbackForTests?: boolean
  token: string
  accountId: string
  projectName: string
  clock: () => number
  signal?: AbortSignal
  /** Epoch ms; the whole query ends at min(start + 45 s, deadlineAt). */
  deadlineAt: number
  limits?: Partial<InventoryLimits>
}

type Stopped =
  | { outcome: 'incomplete'; reason: WorkerIncompleteReason; pathIssue?: PathIssue; unsupportedPath?: string }
  | { outcome: 'failed'; reason: WorkerFailureReason; detail?: MalformedDetail; httpStatus?: number; apiErrorCodes?: number[] }
/** Thrown inside the plan; carries fixed codes only, never text from a reply or the transport. */
class InventoryStop {
  readonly result: Stopped
  constructor(result: Stopped) { this.result = result }
}
type FailureExtra = { detail?: MalformedDetail; httpStatus?: number; apiErrorCodes?: number[] }
function failed(reason: WorkerFailureReason, extra: FailureExtra = {}): never {
  throw new InventoryStop({ outcome: 'failed', reason, ...extra })
}
function malformed(detail: MalformedDetail, extra: { apiErrorCodes?: number[] } = {}): never {
  return failed('malformed-response', { detail, ...extra })
}
function incomplete(reason: WorkerIncompleteReason, pathIssue?: PathIssue, unsupportedPath?: string): never {
  throw new InventoryStop({ outcome: 'incomplete', reason, ...(pathIssue ? { pathIssue } : {}), ...(unsupportedPath ? { unsupportedPath } : {}) })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Cloudflare time → `toISO` form, or null. Fractional digits beyond three are cut, not rounded. */
export function normaliseApiTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = API_TIME.exec(value)
  if (!match) return null
  const [, clock, fraction, zone] = match
  const text = `${clock}${fraction === undefined ? '' : `.${fraction.slice(0, 3)}`}${zone}`
  try { evidenceTime(text, '') } catch { return null }
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? toISO(ms) : null
}

const TIMED_OUT = Symbol('timeout')
const CANCELLED = Symbol('cancelled')
const NETWORK = Symbol('network')
type Interrupted = typeof TIMED_OUT | typeof CANCELLED | typeof NETWORK | InventoryStop

/**
 * Settle with `work`, or reject when `ms` pass or `cancelled` fires, whatever the transport does
 * with the abort. A transport error becomes NETWORK; its own text is dropped unread.
 */
function within<Result>(work: (signal: AbortSignal) => Promise<Result>, ms: number, cancelled: AbortSignal | undefined): Promise<Result> {
  return new Promise<Result>((resolve, reject: (reason: Interrupted) => void) => {
    const stop = new AbortController()
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cancelled?.removeEventListener('abort', onCancel)
      settle()
    }
    const onCancel = (): void => { stop.abort(); finish(() => reject(CANCELLED)) }
    const timer = setTimeout(() => { stop.abort(); finish(() => reject(TIMED_OUT)) }, Math.max(0, ms))
    if (cancelled?.aborted) return onCancel()
    cancelled?.addEventListener('abort', onCancel, { once: true })
    let started: Promise<Result>
    try { started = work(stop.signal) } catch { return finish(() => reject(NETWORK)) }
    started.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error instanceof InventoryStop ? error : NETWORK))
    )
  })
}

function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined)
}

/** Whole body as strict UTF-8, refusing more than `cap` bytes; the reader is cancelled at the cap. */
async function readCapped(response: Response, cap: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > cap) { discard(response); failed('response-too-large') }
  const reader = response.body?.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > cap) {
        await reader.cancel().catch(() => undefined)
        failed('response-too-large')
      }
      parts.push(value)
    }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)) } catch { return malformed('syntax') }
}

function apiErrorCodes(envelope: unknown): number[] | undefined {
  if (!isRecord(envelope) || !Array.isArray(envelope.errors)) return undefined
  const codes = envelope.errors
    .map((entry: unknown) => isRecord(entry) ? entry.code : undefined)
    .filter((code): code is number => typeof code === 'number' && Number.isSafeInteger(code) && code >= 0)
    .slice(0, 5)
  return codes.length ? codes : undefined
}

async function errorCodesOf(response: Response): Promise<number[] | undefined> {
  try {
    const parsed = parseStrictJson(await readCapped(response, ERROR_BODY_BYTES))
    return parsed.ok ? apiErrorCodes(parsed.value) : undefined
  } catch {
    return undefined
  }
}

function tightened(limits: Partial<InventoryLimits> | undefined): InventoryLimits {
  const pick = (key: keyof InventoryLimits): number => {
    const value = limits?.[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, INVENTORY_LIMITS[key]) : INVENTORY_LIMITS[key]
  }
  return { requestTimeoutMs: pick('requestTimeoutMs'), totalMs: pick('totalMs'), projectBytes: pick('projectBytes'), deploymentBytes: pick('deploymentBytes') }
}

function checkedBase(apiBase: unknown, allowLoopback: boolean): URL {
  if (apiBase === CLOUDFLARE_API_BASE) return new URL(CLOUDFLARE_API_BASE)
  if (allowLoopback && typeof apiBase === 'string') {
    const match = LOOPBACK_BASE.exec(apiBase)
    if (match && Number(match[1]) >= 1 && Number(match[1]) <= 65535) return new URL(apiBase)
  }
  return failed('request-refused')
}

export async function queryProductionInventory(query: InventoryQuery): Promise<InventoryResult> {
  let requests = 0
  let retried = false
  try {
    const { accountId, projectName, token, clock, signal } = query
    const limits = tightened(query.limits)
    const base = checkedBase(query.apiBase, query.allowLoopbackForTests === true)
    if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId) || typeof projectName !== 'string' || !PROJECT_NAME.test(projectName)) failed('request-refused')
    if (typeof token !== 'string' || !TOKEN.test(token)) failed('credential-invalid-shape')
    if (typeof query.deadlineAt !== 'number' || !Number.isSafeInteger(query.deadlineAt)) failed('request-refused')
    const deadline = Math.min(clock() + limits.totalMs, query.deadlineAt)
    const basePath = base.pathname.replace(/\/$/u, '')

    /** Build, then re-check, one of the two templates; anything else is refused before sending. */
    const address = (segments: string[]): string => {
      const raw = `${basePath}/accounts/${segments[0]}/pages/projects/${segments[1]}${segments.length === 3 ? `/deployments/${segments[2]}` : ''}`
      const encoded = `${base.origin}${basePath}/accounts/${encodeURIComponent(segments[0])}/pages/projects/${encodeURIComponent(segments[1])}${segments.length === 3 ? `/deployments/${encodeURIComponent(segments[2])}` : ''}`
      let url: URL
      try { url = new URL(encoded) } catch { return failed('request-refused') }
      if (url.origin !== base.origin || url.pathname !== raw || url.search || url.hash) failed('request-refused')
      return url.href
    }

    const get = async (url: string, cap: number, notFound: WorkerFailureReason): Promise<Record<string, unknown>> => {
      if (requests >= MAX_INVENTORY_REQUESTS) failed('request-refused')
      if (signal?.aborted) failed('cancelled')
      const remaining = deadline - clock()
      if (!(remaining > 0)) failed('timeout')
      requests++
      try {
        return await within(async (stopSignal) => {
          const response = await query.fetch(url, {
            method: 'GET',
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
            redirect: 'manual',
            signal: stopSignal
          })
          if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status <= 399)) { discard(response); failed('redirect-rejected') }
          if (response.url && response.url !== url) { discard(response); failed('redirect-rejected') }
          if (response.status !== 200) {
            const codes = await errorCodesOf(response)
            const status = response.status
            const reason: WorkerFailureReason = status === 401 || status === 403 ? 'auth-rejected' : status === 404 ? notFound : status === 429 ? 'rate-limited' : 'api-error'
            failed(reason, { httpStatus: status, ...(codes ? { apiErrorCodes: codes } : {}) })
          }
          if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) { discard(response); malformed('envelope') }
          const parsed = parseStrictJson(await readCapped(response, cap))
          if (!parsed.ok) return parsed.code === 'too-many-keys' ? failed('response-too-large') : malformed(parsed.code)
          const envelope = parsed.value
          if (!isRecord(envelope) || envelope.success !== true || !isRecord(envelope.result)) {
            const codes = apiErrorCodes(envelope)
            return malformed('envelope', codes ? { apiErrorCodes: codes } : {})
          }
          return envelope.result
        }, Math.min(limits.requestTimeoutMs, remaining), signal)
      } catch (error) {
        if (error instanceof InventoryStop) throw error
        if (error === CANCELLED) failed('cancelled')
        if (error === TIMED_OUT) failed('timeout')
        return failed('network')
      }
    }

    const production = (value: unknown): ProductionDeployment => {
      if (value === null || value === undefined) incomplete('no-production-deployment')
      if (!isRecord(value) || typeof value.id !== 'string' || !UUID.test(value.id) || value.environment !== 'production') return malformed('shape')
      if (value.project_name !== undefined && value.project_name !== projectName) malformed('identity-mismatch')
      if (value.is_skipped === true || !isRecord(value.latest_stage) || value.latest_stage.status !== 'success') incomplete('production-not-settled')
      const createdOn = normaliseApiTime(value.created_on)
      if (createdOn === null || Date.parse(createdOn) < EARLIEST_DEPLOYMENT) return malformed('time')
      if (Date.parse(createdOn) > clock()) failed('clock-skew')
      const trigger = isRecord(value.deployment_trigger) ? value.deployment_trigger : {}
      const metadata = isRecord(trigger.metadata) ? trigger.metadata : {}
      const marker = typeof metadata.commit_message === 'string' ? /^tw-candidate:([0-9a-f]{64})$/u.exec(metadata.commit_message) : null
      return { deploymentId: value.id, createdOn, ...(marker ? { candidateDigest: marker[1] } : {}), ...(typeof value.short_id === 'string' && SHORT_ID.test(value.short_id) ? { shortId: value.short_id } : {}) }
    }

    const project = async (): Promise<ProductionDeployment> => {
      const result = await get(address([accountId, projectName]), limits.projectBytes, 'project-not-found')
      if (result.name !== projectName) malformed('identity-mismatch')
      return production(result.canonical_deployment)
    }

    const inventory = async (prod: ProductionDeployment): Promise<Array<[string, string]>> => {
      const result = await get(address([accountId, projectName, prod.deploymentId]), limits.deploymentBytes, 'deployment-not-found')
      if (result.id !== prod.deploymentId || result.environment !== 'production') malformed('shape')
      if (result.project_name !== undefined && result.project_name !== projectName) malformed('identity-mismatch')
      if (normaliseApiTime(result.created_on) !== prod.createdOn) malformed('time')
      const files = result.files
      if (!isRecord(files)) return incomplete('file-inventory-absent')
      const keys = Object.keys(files)
      if (keys.length > MAX_INVENTORY_FILES) incomplete('too-many-files')
      const classes = keys.map(classifyInventoryPath)
      if (classes.some(entry => !entry.ok && entry.kind === 'invalid')) malformed('invalid-path')
      const unsupported = classes.findIndex(entry => !entry.ok)
      if (unsupported >= 0) incomplete('unsupported-path', 'reserved-character', keys[unsupported])
      const composed = new Set<string>()
      for (const key of keys) {
        const nfc = key.normalize('NFC')
        if (composed.has(nfc)) incomplete('unsupported-path', 'nfc-ambiguous', key)
        composed.add(nfc)
      }
      const entries = keys.map((key): [string, string] => {
        const hash = files[key]
        if (typeof hash !== 'string' || !PAGES_ASSET_HASH.test(hash)) return malformed('invalid-hash')
        return [key, hash]
      })
      return entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    }

    const prod1 = await project()
    let files = await inventory(prod1)
    let confirmed = prod1
    const prod2 = await project()
    if (prod2.deploymentId !== prod1.deploymentId) {
      retried = true
      files = await inventory(prod2)
      const prod3 = await project()
      if (prod3.deploymentId !== prod2.deploymentId) incomplete('production-changed-during-check')
      confirmed = prod2
    }
    const confirmedAt = toISO(clock())
    if (Date.parse(confirmed.createdOn) > Date.parse(confirmedAt)) failed('clock-skew')
    return { outcome: 'complete', requests, retried, production: confirmed, confirmedAt, explicitEmpty: files.length === 0, files }
  } catch (error) {
    const stopped: Stopped = error instanceof InventoryStop ? error.result : { outcome: 'failed', reason: 'worker-internal' }
    return stopped.outcome === 'incomplete' ? { ...stopped, requests, retried } : { ...stopped, requests }
  }
}
