/** Shared bounded inventory schema; no application observation or catalogue dependency. */
export const MAX_INVENTORY_FILES = 100_000
export const MAX_INVENTORY_REQUESTS = 5
export const ACCOUNT_ID = /^[0-9a-f]{32}$/u
export const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
export const PAGES_ASSET_HASH = /^[0-9a-f]{32}$/u
export type WorkerIncompleteReason = 'no-production-deployment' | 'production-not-settled' | 'file-inventory-absent'
  | 'too-many-files' | 'unsupported-path' | 'production-changed-during-check'
export type WorkerFailureReason = 'request-invalid' | 'request-refused' | 'credential-missing' | 'credential-invalid-shape'
  | 'auth-rejected' | 'project-not-found' | 'deployment-not-found' | 'rate-limited' | 'api-error' | 'network'
  | 'timeout' | 'cancelled' | 'redirect-rejected' | 'response-too-large' | 'malformed-response' | 'clock-skew'
  | 'worker-internal'
export type MalformedDetail = 'syntax' | 'duplicate-key' | 'lone-surrogate' | 'depth' | 'string-too-long' | 'trailing'
  | 'envelope' | 'identity-mismatch' | 'time' | 'invalid-path' | 'invalid-hash' | 'shape'
export type PathIssue = 'reserved-character' | 'nfc-ambiguous'

export interface ProductionDeployment { deploymentId: string; createdOn: string; shortId?: string; candidateDigest?: string
  /** The deployment's own address, only in the one shape Cloudflare gives it (`https://<8 hex>.<site>.pages.dev`). */
  url?: string }
export type InventoryResult =
  | { outcome: 'complete'; requests: number; retried: boolean; production: ProductionDeployment;
      confirmedAt: string; explicitEmpty: boolean; files: Array<[path: string, hash: string]> }
  | { outcome: 'incomplete'; requests: number; retried: boolean; reason: WorkerIncompleteReason; pathIssue?: PathIssue; unsupportedPath?: string;
      /** Set only when Cloudflare answered for this very project and said, in so many words (`canonical_deployment: null`), that it has no production deployment. */
      noProductionDeployment?: true }
  | { outcome: 'failed'; requests: number; reason: WorkerFailureReason; detail?: MalformedDetail;
      httpStatus?: number; apiErrorCodes?: number[] }

export function evidenceTime(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new TypeError(path)
  const text = value
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(text)
  if (!match || !Number.isFinite(Date.parse(text))) throw new TypeError(path)
  const [, y, m, d, h, min, s, zone] = match
  const days = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate()
  if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > days || Number(h) > 23 || Number(min) > 59 || Number(s) > 59 || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) throw new TypeError(path)
  return text
}

export type InventoryPathClass = { ok: true; path: string } | { ok: false; kind: 'invalid' | 'unsupported' }
/** File-map keys are literal names; percent sequences never alias decoded names. */
export function classifyInventoryPath(key: unknown): InventoryPathClass {
  if (typeof key !== 'string' || !key || new TextEncoder().encode(key).length > 1024) return { ok: false, kind: 'invalid' }
  if (/[%?#\\]/u.test(key)) return { ok: false, kind: 'unsupported' }
  if (!key.startsWith('/') || key.startsWith('//') || key.endsWith('/') || key.slice(1).split('/').some(p => !p || p === '.' || p === '..')) return { ok: false, kind: 'invalid' }
  if (/[\\\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(key)) return { ok: false, kind: 'invalid' }
  return { ok: true, path: key }
}

export function toISO(ms: number): string { return new Date(ms).toISOString() }
