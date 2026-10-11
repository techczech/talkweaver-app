// The live service's set-up and update, as one sequence (spec docs/plans/cloudflare-setup-in-app,
// D1, D2, D9, D12, ticket 11; and the invariant at the top of cloudflare-connection.ts).
// `deployLiveWorker` in the main process is a thin caller: it supplies the shipped files, the stored
// keys and the settings write as ports, and this function decides the order and, at every step,
// whether the set-up may still go on.
//
// No program is started. The shipped bundle (worker-dist/, compiled when the app was built) is
// checked against its manifest, then put at Cloudflare with its API (live-service-upload.ts plans
// the requests). In order:
//   0. the shipped files are checked against the manifest: a mismatch is "This TalkWeaver
//      installation is incomplete", with Details, and NOTHING is sent (not even the check that an
//      authorisation may run);
//   1. leave from the connection (the token, the account and a completed check of one generation);
//   2. three reads: the script as deployed (its migration tag; whether it exists), the account's
//      workers.dev subdomain (the address), and the custom domains attached to the script;
//   3. the keys: the stored ones on every update; made and stored only when none are stored AND no
//      script is deployed. A deployed script with no stored keys stops here (decision D9): new keys
//      would end every existing share link;
//   4. the planned writes: the script, workers.dev on, the share-link domain attached or removed,
//      the two secrets (one PATCH …/secrets-bulk);
//   5. the address and this build kept in Settings.
//
// A set-up acts on an authorisation. That generation must still be the current one
//   (a) before each request (`authorisation.run` does not start it otherwise),
//   (b) after every await (`run` does not hand back an answer otherwise), and
//   (c) immediately before anything is written on this computer (the stored keys, the Worker's
//       address and version) and before success is returned.
// A superseded set-up writes nothing here and answers DEPLOY_SUPERSEDED_ERROR. What a request already
// did at Cloudflare before it was superseded cannot be undone from here.
//
// Failures are sorted before they are shown (decision D12). `error` is always one of the fixed
// sentences below; `details` says which step failed and what Cloudflare answered in numbers (the
// HTTP status and its error codes), never text from a reply, and never the token or a key.
//
// No Electron import and erasable TypeScript only: scripts/test-live-service-upload.mjs and
// scripts/test-cloudflare-connection.mjs drive it.
import { DEPLOY_SUPERSEDED_ERROR, send, type Answer, type DeployCredentials, type LiveDeployAuthorisation, type OutgoingRequest } from './cloudflare-connection.ts'
import { LIVE_NO_PERMISSION, WORKERS_PERMISSION } from '../shared/cloudflare-status.ts'
import type { LiveSetupPrompt } from '../shared/live-service-status.ts'
import {
  UnknownMigrationTagError, migrationsToApply, planLiveServiceUpload, secretsBody, validAccountSegment, validDomainId, verifyShippedBundle, workersDevAddress,
  type PlannedRequest, type ShippedFiles, type UploadStep,
} from './live-service-upload.ts'

/** What a run of the bundled publishing tool came to (`pages deploy`, handout-publishing.ts). */
export type ToolRun = { ok: boolean; stdout: string; stderr: string }
export type LiveServiceKeys = { adminSecret: string; signingSecret: string }

export const LIVE_SETUP_FAILED = 'The live service could not be set up.'
export const LIVE_SETUP_REFUSED = `${LIVE_NO_PERMISSION}. Add the permission ${WORKERS_PERMISSION} to the token in Settings → Cloudflare.`
export const LIVE_KEYS_FAILED = 'The live service was deployed, but its keys could not be set, so it cannot be used yet.'
/** Nothing to go live with: no connection, and no service on this computer outside tests (decision D8). */
export const LIVE_NOT_SET_UP = 'Going live is not set up: Settings → Cloudflare'
export const LIVE_KEYS_LOST = 'The live service exists but this computer has lost its keys.'
export const LIVE_NO_ADDRESS = 'The live service was deployed, but its address was not reported. Set the Worker base URL in Settings.'
/** The Worker deployed is at a migration tag this build does not list: nothing is sent (see UnknownMigrationTagError). */
export const LIVE_NEWER_SERVICE = 'The live service was set up by a newer TalkWeaver.'
/** How much of a failure's Details is kept: its end. */
export const DETAILS_CHARS = 600
export const KEY_REMOVED = '[key removed]'
/** Time limits for one request: the upload carries the bundle; the others are small. */
export const UPLOAD_TIMEOUT_MS = 120_000
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * A failure of the live service that is already a sorted sentence (`message`). `kind`: `not-set-up`
 * when nothing was tried because there is nothing to try with (no connection, no local service
 * allowed); `failed` when a set-up or a stored key failed. `details`: what lies behind it, cleaned.
 */
export class LiveServiceError extends Error {
  readonly kind: 'not-set-up' | 'failed'
  readonly details: string | null
  /** What Go live and Share for comments offer for it (spec, "What each user action does"), when anything. */
  readonly prompt: LiveSetupPrompt | null
  constructor(kind: 'not-set-up' | 'failed', message: string, details: string | null = null, prompt: LiveSetupPrompt | null = null) {
    super(message)
    this.name = 'LiveServiceError'
    this.kind = kind
    this.details = details
    this.prompt = prompt
  }
}

export interface LiveDeployPorts {
  /** The shipped worker-dist files (null for one that is not there). Reads only; nothing is sent. */
  shipped(): ShippedFiles
  /** LIVE_WORKER_BUILD of this app: the build the shipped bundle must be. */
  expectedBuild: string
  authorise(): Promise<{ ok: true; authorisation: LiveDeployAuthorisation } | { ok: false; error: string }>
  /** The stored admin and signing secrets, or null when none are stored. A read. */
  storedKeys(): LiveServiceKeys | null
  /** New admin and signing secrets, stored: a write. Asked for only when none are stored and no script is deployed. */
  makeKeys(): LiveServiceKeys
  /** The share-link domain to attach (validated), or null when none is set. */
  shareHostname(): string | null
  /**
   * The record says a share-link domain may be attached by this app (`recordShareDomain`). Then a
   * domain lookup Cloudflare refuses is a failure even with none set now: it may still be there.
   */
  shareDomainAttachedBefore(): boolean
  /**
   * Write the record. INVARIANT: whenever a share-link domain may be attached on Cloudflare by this
   * app, the record says so. So it is written with the hostname BEFORE the attach is sent, kept
   * through any failure or supersession after that, and cleared (null) only once a lookup and the
   * removals it called for have shown none of ours is attached.
   */
  recordShareDomain(hostname: string | null): void
  fetch: typeof fetch
  /** The API's address: `cloudflareApiBase(...)`. */
  apiBase(): string
  /** Keep the deployed Worker's address (and this build's version) in Settings, with the account it was deployed for. */
  save(result: { baseUrl: string; accountId: string }): void
  /** Tests: shorter limits. */
  timeoutMs?: { upload: number; request: number }
  /** Told what the set-up is doing: the upload (from the first write), then the secrets. Its failure is ignored. */
  progress?(phase: 'upload' | 'secrets'): void
}

export type LiveDeployResult =
  | { ok: true; baseUrl: string; adminSecret: string }
  /** `error`: a fixed sentence. `details`: which step failed and what Cloudflare answered, without the token or the keys. */
  | { ok: false; error: string; details?: string }

const STEP_NAMES: Record<UploadStep | 'script' | 'subdomain' | 'domains', string> = {
  script: 'Looking up the live service',
  subdomain: 'Looking up the account\'s workers.dev address',
  domains: 'Looking up the live service\'s custom domains',
  upload: 'Uploading the live service',
  'workers-dev': 'Switching on its workers.dev address',
  'attach-domain': 'Attaching the share-link domain',
  'remove-domain': 'Removing a share-link domain that is no longer set',
  secrets: 'Setting its keys',
}

/** "<step>: Cloudflare answered 403 (error 10000)." Numbers only: nothing of a reply's text. */
function answered(step: keyof typeof STEP_NAMES, answer: Answer<unknown>): string {
  const what = answer.http === null
    ? (answer.kind === 'cancelled' ? 'it was cancelled' : 'Cloudflare could not be reached or did not answer in time')
    : `Cloudflare answered ${answer.http}${answer.codes.length ? ` (error ${answer.codes.join(', ')})` : ''}${answer.kind === 'unreachable' && answer.http >= 200 && answer.http < 300 ? ' without what was asked for' : ''}`
  return `${STEP_NAMES[step]}: ${what}.`
}
const deniedFor = (answer: Answer<unknown>): boolean => answer.kind === 'denied' || answer.codes.includes(10000)

/** A write: its success flag is the answer; nothing of its result is kept. */
const pickAny = (): true => true
/** The deployed script's migration tag (services endpoint, as wrangler reads it). */
function pickMigrationTag(result: unknown): { tag: string | null } | null {
  const script = (result as { default_environment?: { script?: { migration_tag?: unknown } } } | null)?.default_environment?.script
  if (!script || typeof script !== 'object') return null
  const tag = script.migration_tag
  return { tag: typeof tag === 'string' && tag ? tag : null }
}
function pickSubdomain(result: unknown): { subdomain: unknown } | null {
  return result && typeof result === 'object' ? { subdomain: (result as { subdomain?: unknown }).subdomain } : null
}
function pickDomains(scriptName: string) {
  return (result: unknown): { id: string; hostname: string }[] | null => {
    if (!Array.isArray(result)) return null
    return result.flatMap((entry) => {
      const { id, hostname, service, environment } = (entry ?? {}) as { id?: unknown; hostname?: unknown; service?: unknown; environment?: unknown }
      // Ours: this Worker's production environment, said so. An entry that does not say its
      // environment is not taken to be production (the strict reading), so it is never removed.
      return service === scriptName && environment === 'production' && validDomainId(id) && typeof hostname === 'string' && hostname.length <= 253 ? [{ id, hostname }] : []
    })
  }
}

export async function deployLiveService(ports: LiveDeployPorts): Promise<LiveDeployResult> {
  const superseded: LiveDeployResult = { ok: false, error: DEPLOY_SUPERSEDED_ERROR }

  // 0. The shipped files, before anything is sent.
  const shipped = ports.shipped()
  const verified = verifyShippedBundle(shipped.manifest, { bundle: shipped.bundle, config: shipped.config }, ports.expectedBuild)
  if (!verified.ok) return verified
  const { config, manifest, bundle } = verified

  // 1. Leave.
  const authorised = await ports.authorise()
  if (!authorised.ok) return { ok: false, error: authorised.error }
  const { authorisation } = authorised
  if (!authorisation.current()) return superseded // nothing sent for a generation already over
  const accountId = authorisation.accountId
  if (!validAccountSegment(accountId)) return { ok: false, error: LIVE_SETUP_FAILED }

  const limits = ports.timeoutMs ?? { upload: UPLOAD_TIMEOUT_MS, request: REQUEST_TIMEOUT_MS }
  const never = new AbortController().signal
  let keys: LiveServiceKeys | null = null
  /** The token and both keys out first (none should be there: Details are built from numbers), then its end. */
  const clean = (text: string): string => {
    let out = authorisation.clean(text)
    for (const key of [keys?.adminSecret, keys?.signingSecret]) if (key) out = out.split(key).join(KEY_REMOVED)
    return out.trim().slice(-DETAILS_CHARS)
  }
  const failed = (error: string, details: string): LiveDeployResult => ({ ok: false, error, details: clean(details) })
  /** One request through the authorisation: null when the generation changed before or after it. */
  const request = async <Result>(outgoing: OutgoingRequest, pick: (result: unknown) => Result | null, timeoutMs: number): Promise<Answer<Result> | null> => {
    const ran = await authorisation.run((credentials: DeployCredentials) => send(
      { fetch: ports.fetch, base: ports.apiBase(), timeoutMs, cancelled: never }, credentials.CLOUDFLARE_API_TOKEN,
      // The keys, once known, are refused in any address, as the token always is.
      keys ? { ...outgoing, forbidden: [keys.adminSecret, keys.signingSecret] } : outgoing, pick,
    ))
    if (ran.superseded || !authorisation.current()) return null
    return ran.result
  }

  // 2. The three reads.
  const scriptPath = `/accounts/${accountId}/workers/scripts/${config.name}`
  const service = await request({ method: 'GET', path: `/accounts/${accountId}/workers/services/${config.name}` }, pickMigrationTag, limits.request)
  if (!service) return superseded
  // Not found (404; Cloudflare's 10090 or 10007): there is no live service yet, so every migration applies.
  const exists = service.kind !== 'missing' && !(service.kind === 'refused' && (service.codes.includes(10090) || service.codes.includes(10007)))
  if (exists && service.kind !== 'ok') return failed(deniedFor(service) ? LIVE_SETUP_REFUSED : LIVE_SETUP_FAILED, answered('script', service))
  const deployedMigrationTag = exists ? service.result?.tag ?? null : null
  // A tag this build does not list: set up by a newer TalkWeaver. Nothing is sent.
  try {
    migrationsToApply(config.migrations, deployedMigrationTag)
  } catch (error) {
    if (!(error instanceof UnknownMigrationTagError)) throw error
    const shown = /^[A-Za-z0-9._-]{1,64}$/.test(error.tag) ? error.tag : '(not a plain name)'
    const known = config.migrations.map((migration) => migration.tag)
    return failed(LIVE_NEWER_SERVICE, `${STEP_NAMES.script}: Cloudflare reports migration tag ${shown}; this TalkWeaver knows ${known.length ? known.join(', ') : 'none'}.`)
  }

  const subdomain = await request({ method: 'GET', path: `/accounts/${accountId}/workers/subdomain` }, pickSubdomain, limits.request)
  if (!subdomain) return superseded
  if (subdomain.kind !== 'ok') return failed(deniedFor(subdomain) ? LIVE_SETUP_REFUSED : LIVE_NO_ADDRESS, answered('subdomain', subdomain))
  const baseUrl = workersDevAddress(config.name, subdomain.result?.subdomain)
  if (!baseUrl) return failed(LIVE_NO_ADDRESS, `${STEP_NAMES.subdomain}: the subdomain Cloudflare reported is not a plain name.`)

  const shareHostname = ports.shareHostname()
  let attachedDomains: { id: string; hostname: string }[] = []
  /** A lookup answered: what of ours is attached is known, and the removals below act on all of it. */
  let lookedUp = false
  if (exists) {
    const domains = await request({ method: 'GET', path: `/accounts/${accountId}/workers/domains?service=${config.name}&environment=production` }, pickDomains(config.name), limits.request)
    if (!domains) return superseded
    if (domains.kind === 'ok') { attachedDomains = domains.result ?? []; lookedUp = true }
    // A refused lookup goes on only when there is nothing of ours it could hide: no domain to attach
    // now, and none attached by an earlier set-up from this computer.
    else if (shareHostname || ports.shareDomainAttachedBefore() || !deniedFor(domains)) return failed(deniedFor(domains) ? LIVE_SETUP_REFUSED : LIVE_SETUP_FAILED, answered('domains', domains))
  }

  // 3. The keys (c: before the slot may be written).
  if (!authorisation.current()) return superseded
  keys = ports.storedKeys()
  if (!keys) {
    if (exists) return { ok: false, error: LIVE_KEYS_LOST }
    keys = ports.makeKeys()
  }
  const values = { ADMIN_SECRET: keys.adminSecret, SESSION_SIGNING_SECRET: keys.signingSecret }

  // 4. The writes, as planned.
  const plan = planLiveServiceUpload({ config, manifest, bundle, accountId, deployedMigrationTag, shareHostname, attachedDomains })
  const told = (phase: 'upload' | 'secrets'): void => { try { ports.progress?.(phase) } catch { /* a window that has gone */ } }
  told('upload')
  for (const planned of plan) {
    if (planned.step === 'secrets') told('secrets')
    // The record first: from here on the domain may be attached, whatever happens next.
    if (planned.step === 'attach-domain') ports.recordShareDomain(shareHostname)
    const answer = await request(outgoingFor(planned, values), pickAny, planned.step === 'upload' ? limits.upload : limits.request)
    if (!answer) return superseded
    // Removing a domain that is already gone is what was wanted.
    if (answer.kind === 'ok' || (planned.step === 'remove-domain' && answer.kind === 'missing')) continue
    const refused = deniedFor(answer)
    return failed(refused ? LIVE_SETUP_REFUSED : planned.step === 'secrets' ? LIVE_KEYS_FAILED : LIVE_SETUP_FAILED, answered(planned.step, answer))
  }

  // 5. (c) immediately before the write, and before success.
  if (!authorisation.current()) return superseded
  // None set, the lookup answered and every removal it called for went through: none of ours is attached.
  if (!shareHostname && lookedUp) ports.recordShareDomain(null)
  ports.save({ baseUrl, accountId })
  return { ok: true, baseUrl, adminSecret: keys.adminSecret }
}

/** A planned request as it is sent. The secrets' values go in here, and only here. */
function outgoingFor(planned: PlannedRequest, values: { ADMIN_SECRET: string; SESSION_SIGNING_SECRET: string }): OutgoingRequest {
  const base = { method: planned.method, path: planned.path, ...(planned.headers ? { headers: planned.headers } : {}) }
  const body = planned.body
  if (!body) return base
  if (body.kind === 'json') return { ...base, body: JSON.stringify(body.json), contentType: body.contentType ?? 'application/json' }
  if (body.kind === 'secrets') return { ...base, body: secretsBody(values), contentType: body.contentType }
  // As wrangler's createWorkerUploadForm: the metadata as a plain field, then the module as a file.
  const form = new FormData()
  form.set('metadata', JSON.stringify(body.metadata))
  form.set(body.module.name, new File([new Uint8Array(body.module.bytes)], body.module.name, { type: body.module.type }))
  return { ...base, body: form }
}

export type LookUpPorts = Pick<LiveDeployPorts, 'shipped' | 'expectedBuild' | 'authorise' | 'fetch' | 'apiBase' | 'timeoutMs'> & {
  /** The account the address was recorded for: the lookup is made there, and only when the connection is on it. */
  accountId: string
}

/**
 * Is the live service there, for the account recorded with its address? One read: the same lookup
 * the set-up starts with (GET …/workers/services/<name>), through the connection's authorisation, so
 * the token goes in its header only and a change of token or account stops it. `exists`: Cloudflare
 * reports the Worker. `missing`: Cloudflare says there is no such Worker on that account (deleted in
 * the dashboard). `unknown`: anything else (no leave, another account, refused, no answer), which a
 * caller does not take as missing.
 */
export async function lookUpLiveService(ports: LookUpPorts): Promise<'exists' | 'missing' | 'unknown'> {
  const shipped = ports.shipped()
  const verified = verifyShippedBundle(shipped.manifest, { bundle: shipped.bundle, config: shipped.config }, ports.expectedBuild)
  if (!verified.ok || !validAccountSegment(ports.accountId)) return 'unknown'
  const authorised = await ports.authorise()
  if (!authorised.ok || !authorised.authorisation.current() || authorised.authorisation.accountId !== ports.accountId) return 'unknown'
  const never = new AbortController().signal
  const timeoutMs = ports.timeoutMs?.request ?? REQUEST_TIMEOUT_MS
  const ran = await authorised.authorisation.run((credentials: DeployCredentials) => send(
    { fetch: ports.fetch, base: ports.apiBase(), timeoutMs, cancelled: never }, credentials.CLOUDFLARE_API_TOKEN,
    { method: 'GET', path: `/accounts/${ports.accountId}/workers/services/${verified.config.name}` }, pickMigrationTag,
  ))
  if (ran.superseded) return 'unknown'
  const answer = ran.result
  if (answer.kind === 'ok') return 'exists'
  if (answer.kind === 'missing' || (answer.kind === 'refused' && (answer.codes.includes(10090) || answer.codes.includes(10007)))) return 'missing'
  return 'unknown'
}
