// The live service's set-up, update and joining, as one sequence (spec docs/plans/cloudflare-setup-in-app,
// D1, D2, D9, D12, ticket 11; spec docs/plans/going-live-from-several-macs, decision T1, ticket 02; and
// the invariant at the top of cloudflare-connection.ts).
// `deployLiveWorker` in the main process is a thin caller: it supplies the shipped files, this
// computer's key store and the settings write as ports, and this function decides the order and, at
// every step, whether the set-up may still go on.
//
// No program is started. The shipped bundle (worker-dist/, compiled when the app was built) is
// checked against its manifest, then put at Cloudflare with its API (live-service-upload.ts plans
// the requests). In order:
//   0. the shipped files are checked against the manifest: a mismatch is "This TalkWeaver
//      installation is incomplete", with Details, and NOTHING is sent;
//   1. leave from the connection (the token, the account and a completed check of one generation);
//   2. reads: the script as deployed (its migration tag; whether it exists), the account's workers.dev
//      subdomain (the address) and, when it exists, the build the live service itself answers as
//      (`GET /capabilities`). A build that is newer, or that cannot be read or ordered, stops here
//      with a fixed sentence and nothing is sent. One exception to "nothing": when Cloudflare has the
//      script and its address gives no build at all (a first set-up that stopped between its two
//      requests leaves exactly that), the workers.dev switch alone is sent again (it changes no code,
//      secret or domain), the build is asked for again for up to a minute, and the comparison is then
//      made as always. Still no build: the same sentence, and nothing else is sent;
//   3. this computer's key FOR THIS LIVE SERVICE (this account, this Worker), STORED before anything
//      is written at Cloudflare: the one held for it, or a new one (with a new id) made and stored
//      beside the others when there is none. If the slot cannot be read, or the key cannot be
//      stored, nothing is sent;
//   4. the code, only when there is no Worker yet or `uploadDecision` says this app's build is newer
//      than the one just read (R3): the script and its workers.dev switch, nothing else. The upload
//      carries NO secret and touches NO custom domain or route (R2);
//   5. the key at the live service. A key that was already held is asked about first: accepted
//      means nothing is sent at all (a 0.38.2 computer stays as it is). Refused, or never sent: ONE
//      `PATCH …/secrets-bulk` adds this computer's own key and nothing else, and the live service is
//      polled for up to a minute until it accepts the key;
//      After an upload of this run, the build is read once more (R10): there is no conditional
//      upload, so two computers updating inside the propagation window are last-write-wins. A lower
//      build still answering at the deadline is one of two things. The build this upload went over:
//      Cloudflare has not switched to the upload yet, which is success with LIVE_UPDATE_PENDING
//      said. Any other lower build: an older TalkWeaver's upload over this one, LIVE_OVERWRITTEN.
//      Nothing is uploaded again without a press in either case;
//   6. this computer recorded on the live service's list, and the address and build kept in Settings.
//
// What is never done: no signing key is made, sent, listed or stored (R1: the live service keeps its
// own); no custom domain or route is read or written (R2); no code is uploaded over a live service
// whose build was not read, or is not older (R3); a slot that cannot be read is never taken as "no
// key" (R4); no stored key is removed or replaced (R6: a refused 0.38.2 key stays, and this
// computer's own is added beside it); no key is shown to, or registered on, any live service but the
// one it was made for; the 0.38.2 `ADMIN_SECRET` is never sent, changed or removed; no other
// computer's key is named in any request.
//
// A set-up acts on an authorisation. That generation must still be the current one
//   (a) before each request (`authorisation.run` does not start it otherwise),
//   (b) after every await (`run` does not hand back an answer otherwise), and
//   (c) immediately before anything is written on this computer (the stored key, the Worker's
//       address and version) and before success is returned.
// A superseded set-up writes nothing here and answers DEPLOY_SUPERSEDED_ERROR. What a request already
// did at Cloudflare before it was superseded cannot be undone from here.
//
// Failures are sorted before they are shown (decision D12). `error` is always one of the fixed
// sentences below; `details` says which step failed and what Cloudflare answered in numbers (the
// HTTP status and its error codes), never text from a reply, and never the token or a key.
//
// No Electron import and erasable TypeScript only: scripts/test-live-service-upload.mjs,
// scripts/test-live-service-keys.mjs and scripts/test-cloudflare-connection.mjs drive it.
import { DEPLOY_SUPERSEDED_ERROR, send, type Answer, type DeployCredentials, type LiveDeployAuthorisation, type OutgoingRequest } from './cloudflare-connection.ts'
import { LIVE_NO_PERMISSION, WORKERS_PERMISSION } from '../shared/cloudflare-status.ts'
import type { LiveSetupPrompt } from '../shared/live-service-status.ts'
import {
  UnknownMigrationTagError, migrationsToApply, planLiveServiceUpload, validAccountSegment, verifyShippedBundle, workersDevAddress, workersDevRequest,
  type PlannedRequest, type SecretsStep, type ShippedFiles, type UploadStep,
} from './live-service-upload.ts'
import {
  KEY_UNREADABLE, acceptedKey, addComputerKey, readBackAfterUpload, readLiveBuild, recordComputer, unreferencedWait, uploadDecision, waitForBuild, waitForKey,
  type ComputerKeyStore, type KeyChange, type KeyTarget, type LiveIo, type LiveServiceAt, type StoredKey,
} from './live-service-key.ts'

/** What a run of the bundled publishing tool came to (`pages deploy`, handout-publishing.ts). */
export type ToolRun = { ok: boolean; stdout: string; stderr: string }

export const LIVE_SETUP_FAILED = 'The live service could not be set up.'
export const LIVE_SETUP_REFUSED = `${LIVE_NO_PERMISSION}. Add the permission ${WORKERS_PERMISSION} to the token in Settings → Cloudflare.`
export const LIVE_KEYS_FAILED = 'The live service was deployed, but its keys could not be set, so it cannot be used yet.'
/** Nothing to go live with: no connection, and no service on this computer outside tests (decision D8). */
export const LIVE_NOT_SET_UP = 'Going live is not set up: Settings → Cloudflare'
/** This computer's key could not be added to a live service that is already set up. */
export const LIVE_KEY_NOT_ADDED = 'This computer could not be added to the live service.'
/** Secure storage refused the key: nothing was sent to Cloudflare. */
export const LIVE_KEY_NOT_STORED = 'This computer\'s key for the live service could not be saved, so nothing was changed.'
/** The key was sent and a minute has passed without the live service accepting it. Trying again sends the same key. */
export const LIVE_NOT_ACCEPTED_YET = 'The live service has not accepted this computer yet. Wait a minute, then try again.'
/** The live service gives no answer at its address (Cloudflare itself answered). */
export const LIVE_UNREACHABLE = 'The live service did not answer. Check that this computer is online, then try again.'
/** A use on a computer whose key the live service refuses. */
export const LIVE_ACCESS_REMOVED = 'This computer\'s access to going live was removed. Set it up again in Settings → Cloudflare.'
export const LIVE_NO_ADDRESS = 'The live service was deployed, but its address was not reported. Set the Worker base URL in Settings.'
/** The Worker deployed is at a migration tag this build does not list: nothing is sent (see UnknownMigrationTagError). */
export const LIVE_NEWER_SERVICE = 'The live service was set up by a newer TalkWeaver.'
/** The live service answers as a newer build than this app carries: nothing is sent (R3). */
export const LIVE_APP_OLDER = 'This TalkWeaver is older than your live service. Update TalkWeaver on this computer.'
/** The live service's build could not be read or ordered against this app's: nothing is sent (R3). */
export const LIVE_VERSION_UNREADABLE = 'TalkWeaver could not read your live service\'s version. Try again.'
/**
 * After this app's upload, the live service answers as an OLDER build: another computer's upload landed
 * over it (R10; there is no conditional upload, so two updates inside the propagation window are
 * last-write-wins). Nothing is uploaded again from here: the person presses Update.
 */
export const LIVE_OVERWRITTEN = 'Another computer updated your live service at the same moment, with an older TalkWeaver. Press Update again on this computer.'
/**
 * After this app's upload, the live service still answers as the build it had BEFORE the upload (R10):
 * Cloudflare took the upload and has not switched to it yet. Not a failure and not an overwrite: the
 * set-up or update is a success, with this said beside it. Nothing is uploaded again.
 */
export const LIVE_UPDATE_PENDING = 'TalkWeaver uploaded the update. Cloudflare has not switched to it yet. Check again in a few minutes.'
/** The slot that holds this computer's keys could not be read: nothing is made, written or sent (R4). */
export const LIVE_KEY_UNREADABLE = KEY_UNREADABLE
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
  /**
   * This computer's keys (`ComputerKeyStore`): the ones held for a live service, and its own made and
   * stored for one. Every call throws KeyStoreUnreadable when the slot cannot be read.
   */
  keys: Pick<ComputerKeyStore, 'check' | 'keysFor' | 'ownKeyFor'>
  /** The name this computer is recorded under on the live service's list. */
  computerName(): string
  /** Requests to Cloudflare's API. */
  fetch: typeof fetch
  /** Requests to the live service itself, at the address Cloudflare reports for it. */
  liveFetch: typeof fetch
  /** The API's address: `cloudflareApiBase(...)`. */
  apiBase(): string
  /** Keep the deployed Worker's address (and this build's version) in Settings, with the account it was deployed for. `recorded`: this computer is on the live service's list. */
  save(result: { baseUrl: string; accountId: string; recorded: boolean }): void
  /** Tests: shorter limits, and a clock and pause that do not really wait. */
  timeoutMs?: { upload: number; request: number }
  live?: Pick<LiveIo, 'wait' | 'now' | 'requestMs' | 'waitMs'>
  /** Told what the set-up is doing. Its failure is ignored. */
  progress?(phase: DeployPhase): void
}

/** `upload`: the code. `secrets`: this computer's key is being sent. `access`: waiting for the live service to accept it. */
export type DeployPhase = 'upload' | 'secrets' | 'access'

export type LiveDeployResult =
  /**
   * `others`: how many other computers are on the live service's list, when it said. `created`: there was no Worker before this set-up.
   * `pending`: this run's upload was taken and the live service still answers as `build`, the one from before it (LIVE_UPDATE_PENDING).
   */
  | { ok: true; baseUrl: string; adminSecret: string; others: number | null; created: boolean; pending?: { notice: string; build: string } }
  /** `error`: a fixed sentence. `details`: which step failed and what Cloudflare answered, without the token or the keys. */
  | { ok: false; error: string; details?: string }

const STEP_NAMES: Record<UploadStep | SecretsStep | 'script' | 'subdomain', string> = {
  script: 'Looking up the live service',
  subdomain: 'Looking up the account\'s workers.dev address',
  upload: 'Uploading the live service',
  'workers-dev': 'Switching on its workers.dev address',
  'add-key': 'Adding this computer\'s key',
  'remove-key': 'Removing a computer\'s key',
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
export async function deployLiveService(ports: LiveDeployPorts): Promise<LiveDeployResult> {
  const superseded: LiveDeployResult = { ok: false, error: DEPLOY_SUPERSEDED_ERROR }

  // 0. The shipped files, before anything is sent.
  const shipped = ports.shipped()
  const verified = verifyShippedBundle(shipped.manifest, { bundle: shipped.bundle, config: shipped.config }, ports.expectedBuild)
  if (!verified.ok) return verified
  const { config, manifest, bundle } = verified
  const unreadable: LiveDeployResult = { ok: false, error: LIVE_KEY_UNREADABLE }
  // A slot that cannot be read stops the set-up before anything is asked or sent (R4).
  try { ports.keys.check() } catch { return unreadable }

  // 1. Leave.
  const authorised = await ports.authorise()
  if (!authorised.ok) return { ok: false, error: authorised.error }
  const { authorisation } = authorised
  if (!authorisation.current()) return superseded // nothing sent for a generation already over
  const accountId = authorisation.accountId
  if (!validAccountSegment(accountId)) return { ok: false, error: LIVE_SETUP_FAILED }

  const limits = ports.timeoutMs ?? { upload: UPLOAD_TIMEOUT_MS, request: REQUEST_TIMEOUT_MS }
  const never = new AbortController().signal
  let key: StoredKey | null = null
  /** The token and this computer's key out first (none should be there: Details are built from numbers), then its end. */
  const clean = (text: string): string => {
    let out = authorisation.clean(text)
    if (key) out = out.split(key.key).join(KEY_REMOVED)
    return out.trim().slice(-DETAILS_CHARS)
  }
  const failed = (error: string, details: string): LiveDeployResult => ({ ok: false, error, details: clean(details) })
  /** One request through the authorisation: null when the generation changed before or after it. */
  const request = async <Result>(outgoing: OutgoingRequest, pick: (result: unknown) => Result | null, timeoutMs: number): Promise<Answer<Result> | null> => {
    const ran = await authorisation.run((credentials: DeployCredentials) => send(
      { fetch: ports.fetch, base: ports.apiBase(), timeoutMs, cancelled: never }, credentials.CLOUDFLARE_API_TOKEN,
      // The key, once known, is refused in any address, as the token always is.
      key ? { ...outgoing, forbidden: [...(outgoing.forbidden ?? []), key.key] } : outgoing, pick,
    ))
    if (ran.superseded || !authorisation.current()) return null
    return ran.result
  }
  const told = (phase: DeployPhase): void => { try { ports.progress?.(phase) } catch { /* a window that has gone */ } }
  const io: LiveIo = { fetch: ports.liveFetch, wait: ports.live?.wait ?? unreferencedWait, ...(ports.live?.now ? { now: ports.live.now } : {}), ...(ports.live?.requestMs ? { requestMs: ports.live.requestMs } : {}), ...(ports.live?.waitMs !== undefined ? { waitMs: ports.live.waitMs } : {}) }

  // 2. The reads.
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

  /** THE live service of this run: this account, this Worker, at the address Cloudflare just reported for it. */
  const at: LiveServiceAt = { accountId, workerName: config.name, baseUrl }

  // The build the live service itself answers as, read now. Only a build that is older than this
  // app's, by the number it starts with, is ever uploaded over (R3). Nothing recorded on this
  // computer stands in for a build that could not be read.
  let uploadDue = !exists
  /** The build this run's upload goes over: the one read for the decision. Null: there was no live service. */
  let buildBefore: string | null = null
  if (exists) {
    let { build } = await readLiveBuild(io, baseUrl)
    if (!authorisation.current()) return superseded
    if (build === null) {
      // The script is there and its address gives no build: its workers.dev switch may never have been
      // sent (a first set-up that stopped after the script). The switch alone, then ask again. Code is
      // never uploaded over a build that was not read.
      const switched = await request(outgoingFor(workersDevRequest(accountId, config.name)), pickAny, limits.request)
      if (!switched) return superseded
      if (switched.kind !== 'ok') return failed(deniedFor(switched) ? LIVE_SETUP_REFUSED : LIVE_VERSION_UNREADABLE, answered('workers-dev', switched))
      build = await waitForBuild(io, baseUrl, () => !authorisation.current())
      if (!authorisation.current()) return superseded
    }
    const decision = uploadDecision(build, ports.expectedBuild)
    if (decision === 'app-older') return failed(LIVE_APP_OLDER, `The live service answers as build ${build}; this TalkWeaver carries build ${ports.expectedBuild}.`)
    if (decision === 'unreadable') return failed(LIVE_VERSION_UNREADABLE, build === null ? 'Asking the live service which build it is: no usable answer.' : `The live service answers as build ${build}; this TalkWeaver carries build ${ports.expectedBuild}. The two cannot be put in order.`)
    uploadDue = decision === 'upload'
    buildBefore = build
  }

  // 3. This computer's key for THIS live service, stored before anything is written at Cloudflare (c: before the slot may be written).
  if (!authorisation.current()) return superseded
  let heldKeys: StoredKey[]
  try { heldKeys = ports.keys.keysFor(at) } catch { return unreadable }
  /** This computer's own key for this live service, stored: the one held, or a new one added beside the others. False: it could not be stored. */
  const own = (): boolean => {
    try { key = ports.keys.ownKeyFor({ accountId, workerName: config.name }); return key.kind === 'own' } catch { return false }
  }
  const notStored = (): LiveDeployResult => failed(LIVE_KEY_NOT_STORED, 'Saving this computer\'s key: secure storage did not take it.')
  // With no Worker, a 0.38.2 key was for one that is gone: it is kept, never sent, and not asked about.
  // With one, the keys held are asked about in turn (step 5): this computer's own first, then the 0.38.2 one.
  const asked = exists ? heldKeys : []
  key = (exists ? heldKeys[0] : heldKeys.find((entry) => entry.kind === 'own')) ?? null
  /** The key was held before this run and there is a live service to ask about it. A Worker made in this run has no key yet: nothing to ask. */
  const ask = key !== null && exists
  if (!key && !own()) return notStored()

  // 4. The code: the script and its workers.dev switch. No secret is in it, and no domain or route.
  if (uploadDue) {
    const plan = planLiveServiceUpload({ config, manifest, bundle, accountId, deployedMigrationTag })
    told('upload')
    for (const planned of plan) {
      const answer = await request(outgoingFor(planned), pickAny, planned.step === 'upload' ? limits.upload : limits.request)
      if (!answer) return superseded
      if (answer.kind === 'ok') continue
      return failed(deniedFor(answer) ? LIVE_SETUP_REFUSED : LIVE_SETUP_FAILED, answered(planned.step, answer))
    }
  }

  // 5. The key at the live service.
  const notAnswering = (why: 'not-accepted' | 'not-ready' | 'unreachable'): LiveDeployResult => (why === 'unreachable'
    ? failed(LIVE_UNREACHABLE, 'Asking the live service whether it accepts this computer: no answer.')
    : failed(LIVE_NOT_ACCEPTED_YET, why === 'not-ready'
      ? 'Asking the live service whether it accepts this computer: it does not answer as this build yet.'
      : 'Asking the live service whether it accepts this computer: not yet (401).'))
  let others: number | null = null
  let accepted = false
  if (ask) {
    // After an upload the older code may answer for a while (not ready): the wait covers it.
    told('access')
    for (const held of asked) {
      const seen = await waitForKey(io, at, held, 'verdict', () => !authorisation.current())
      if (!authorisation.current()) return superseded
      // The first key it accepts is the one this computer uses: nothing is sent.
      if (seen.outcome === 'accepted') { accepted = true; others = seen.others; key = held; break }
      // No answer, or another status, about any key: nothing is concluded and nothing is sent.
      if (seen.outcome !== 'refused') return notAnswering(seen.outcome)
    }
    // Every key held was refused twice (its own 401, never a missing answer). A 0.38.2 key is not sent
    // again and is not thrown away: this computer gets its own key, stored beside it. Its own key is
    // sent again as it is.
    if (!accepted && !own()) return notStored()
  }
  if (!accepted) {
    const mine = key as StoredKey
    const target: KeyTarget = { send: request, io, accountId, scriptName: config.name, baseUrl, timeoutMs: limits.request, current: () => authorisation.current() }
    told('secrets')
    let change: KeyChange
    // The one write of this step: this computer's key and nothing else.
    try { change = await addComputerKey(target, mine) } catch { return failed(LIVE_SETUP_FAILED, `${STEP_NAMES['add-key']}: the request could not be made.`) }
    if (!change.ok) {
      if (change.why === 'superseded') return superseded
      if (change.why !== 'cloudflare') return notAnswering(change.why)
      return failed(deniedFor(change.answer) ? LIVE_SETUP_REFUSED : exists ? LIVE_KEY_NOT_ADDED : LIVE_KEYS_FAILED, answered('add-key', change.answer))
    }
    others = change.others
  }

  // 5b. The read-back (R10), only when this run uploaded code; its last read is at the deadline. A
  // lower build answering then that is NOT the one this upload went over is another computer's older
  // TalkWeaver, uploaded over this one: said so. The one this upload went over, still answering:
  // Cloudflare has not switched yet, which is no overwrite; the run goes on to success and says
  // LIVE_UPDATE_PENDING. This app's build, a higher one, or no readable answer: as before. Whatever
  // was read, nothing is uploaded again from here.
  let pending: { notice: string; build: string } | null = null
  if (uploadDue) {
    const read = await readBackAfterUpload(io, baseUrl, ports.expectedBuild, buildBefore, () => !authorisation.current())
    if (!authorisation.current()) return superseded
    if (read.outcome === 'overwritten') return failed(LIVE_OVERWRITTEN, `This TalkWeaver uploaded build ${ports.expectedBuild}; the live service now answers as build ${read.build}.`)
    if (read.outcome === 'pending') pending = { notice: LIVE_UPDATE_PENDING, build: read.build }
  }

  // 6. (c) immediately before the writes on this computer, and before success.
  if (!authorisation.current()) return superseded
  const mine = key as StoredKey
  // On the list under the id its key belongs to (a 0.38.2 computer: `legacy`). Not what set-up stands on: tried again later if it fails.
  const recorded = await recordComputer(io, at, mine, ports.computerName())
  if (!authorisation.current()) return superseded
  ports.save({ baseUrl, accountId, recorded })
  return { ok: true, baseUrl, adminSecret: mine.key, others, created: !exists, ...(pending ? { pending } : {}) }
}

/** A planned request as it is sent. No plan handled here carries a secret's value. */
function outgoingFor(planned: PlannedRequest<UploadStep | SecretsStep>): OutgoingRequest {
  const base = { method: planned.method, path: planned.path, ...(planned.headers ? { headers: planned.headers } : {}) }
  const body = planned.body
  if (!body) return base
  if (body.kind === 'json') return { ...base, body: JSON.stringify(body.json), contentType: body.contentType ?? 'application/json' }
  // Secrets requests are sent by live-service-key.ts, which alone puts the values in.
  if (body.kind === 'secrets') throw new TypeError('A secrets request is not sent from here.')
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

export type LiveSurvey = {
  /** The account that was asked. */
  accountId: string
  worker: 'present' | 'absent'
  /** The build the live service answers as, or null when it gave none (or did not answer). */
  build: string | null
  /** What the live service says of this computer's key for it: `unknown` with no key, or no clear answer. */
  key: 'accepted' | 'refused' | 'unknown'
  /** How many other computers are on its list, when it accepted the key. */
  others: number | null
}

export type SurveyPorts = Pick<LiveDeployPorts, 'shipped' | 'expectedBuild' | 'authorise' | 'fetch' | 'liveFetch' | 'apiBase' | 'timeoutMs' | 'live'> & {
  keys: Pick<ComputerKeyStore, 'check' | 'keysFor'>
  /** This computer is not on the live service's list yet (or was renamed): record it once its key is accepted. */
  record?: { due(accountId: string): boolean; name(): string; done(accountId: string): void }
}

/**
 * What is at Cloudflare for the connection's account, and what the live service says of this
 * computer's key: the facts the Going live row is decided from on a computer that may never have
 * set anything up. Reads only, except that an accepted computer not yet on the live service's list
 * is put on it (`POST /computers/self`; a 0.38.2 computer appears as `legacy` this way). Null when
 * Cloudflare cannot be asked (no leave, refused, no answer), or this computer's key slot cannot be
 * read (R4: then nothing is asked at all): a caller keeps what it knew.
 */
export async function surveyLiveService(ports: SurveyPorts): Promise<LiveSurvey | null> {
  const shipped = ports.shipped()
  const verified = verifyShippedBundle(shipped.manifest, { bundle: shipped.bundle, config: shipped.config }, ports.expectedBuild)
  if (!verified.ok) return null
  try { ports.keys.check() } catch { return null }
  const authorised = await ports.authorise()
  if (!authorised.ok || !authorised.authorisation.current()) return null
  const { authorisation } = authorised
  const accountId = authorisation.accountId
  if (!validAccountSegment(accountId)) return null
  const never = new AbortController().signal
  const timeoutMs = ports.timeoutMs?.request ?? REQUEST_TIMEOUT_MS
  const read = async <Result>(path: string, pick: (result: unknown) => Result | null): Promise<Answer<Result> | null> => {
    const ran = await authorisation.run((credentials: DeployCredentials) => send(
      { fetch: ports.fetch, base: ports.apiBase(), timeoutMs, cancelled: never }, credentials.CLOUDFLARE_API_TOKEN, { method: 'GET', path }, pick,
    ))
    return ran.superseded || !authorisation.current() ? null : ran.result
  }
  const service = await read(`/accounts/${accountId}/workers/services/${verified.config.name}`, pickMigrationTag)
  if (!service) return null
  if (service.kind === 'missing' || (service.kind === 'refused' && (service.codes.includes(10090) || service.codes.includes(10007)))) {
    return { accountId, worker: 'absent', build: null, key: 'unknown', others: null }
  }
  if (service.kind !== 'ok') return null
  const present: LiveSurvey = { accountId, worker: 'present', build: null, key: 'unknown', others: null }
  const subdomain = await read(`/accounts/${accountId}/workers/subdomain`, pickSubdomain)
  if (!subdomain) return null
  const baseUrl = subdomain.kind === 'ok' ? workersDevAddress(verified.config.name, subdomain.result?.subdomain) : null
  if (!baseUrl) return present
  const io: LiveIo = { fetch: ports.liveFetch, wait: ports.live?.wait ?? unreferencedWait, ...(ports.live?.requestMs ? { requestMs: ports.live.requestMs } : {}) }
  present.build = (await readLiveBuild(io, baseUrl)).build
  // The key held for THIS account's live service, at the address just resolved for it; no other is ever shown.
  const at: LiveServiceAt = { accountId, workerName: verified.config.name, baseUrl }
  let keys: StoredKey[]
  try { keys = ports.keys.keysFor(at) } catch { return null }
  if (keys.length === 0 || !authorisation.current()) return present
  // Its own key first, then the 0.38.2 one. One 401 is not taken as final (a key just added takes a
  // few seconds to arrive): asked once more. Refused only when EVERY key held is refused by a 401.
  const said = await acceptedKey(io, at, keys, 1500, () => !authorisation.current())
  if (!authorisation.current()) return null
  if (said.answer === 'refused') return { ...present, key: 'refused' }
  if (said.answer !== 'accepted') return present
  if (ports.record?.due(accountId) && await recordComputer(io, at, said.key, ports.record.name())) {
    try { ports.record.done(accountId) } catch { /* tried again next time */ }
  }
  return { ...present, key: 'accepted', others: said.others }
}
