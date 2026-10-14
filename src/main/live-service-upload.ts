// The live service as it is uploaded: the shipped bundle, checked, and the requests that put it at
// Cloudflare (spec docs/plans/cloudflare-setup-in-app, decision D2 and ticket 11).
//
// Nothing is compiled on the person's computer. The Worker is compiled ONCE, when the app is built
// (scripts/build-worker-dist.mjs), into `worker-dist/`, which ships in the app's resources:
//   index.js            the bundle, exactly as wrangler's own `deploy` would upload it
//   upload-config.json  what the upload needs from worker/wrangler.jsonc (name, compatibility date
//                       and flags, the Durable Object bindings and migrations, observability)
//   manifest.json       the wrangler version that compiled it, the Worker's build string
//                       (LIVE_WORKER_BUILD), and the SHA-256 and size of both files above
// So no esbuild and no wrangler run when the live service is set up or updated, and no file outside
// the app (a tsconfig.json, jsconfig.json or package.json in a parent folder) can stop the set-up or
// change one byte of what is uploaded.
//
// Two pure functions, the seams the tests drive:
//   verifyShippedBundle(manifest, files)   ok, or "This TalkWeaver installation is incomplete" with
//                                          Details: run before ANY request is sent;
//   planLiveServiceUpload(input)           the write requests, in order, with their bodies.
// The request bodies follow what wrangler 4.144 sends for `deploy` and `secret bulk` (its source is
// node_modules/wrangler/wrangler-dist/cli.js: createWorkerUploadForm, getMigrationsToUpload,
// subdomainDeploy, putBulkSecrets).
//
// The code upload sends NO secret, ever: the plan has no secrets step (going live from several Macs,
// decision T1; proved as P2: an upload with `bindings_inherit=strict` keeps every secret). And it
// touches NO custom domain or route (decision R2): the plan is the script and its workers.dev switch,
// nothing else. A share-link domain is attached or removed only by live-service-share-domain.ts.
// Secrets travel in two other requests, each one `PATCH …/secrets-bulk`, built by the functions at
// the end of this file and nowhere else:
//   addKeyBody          this computer's admin key, `ADMIN_SECRET_<computer id>`, and nothing else (P1);
//   removeKeyBody       one admin key set to null (P3).
// Neither can name any secret but an admin key: the app never sends, lists or stores a signing key
// (decision R1; the live service keeps its own).
// A request names its secrets; the values are put in by the sequence that sends it, as it is sent.
//
// No Electron import, erasable TypeScript only.
import { createHash } from 'node:crypto'

export const INSTALLATION_INCOMPLETE = 'This TalkWeaver installation is incomplete.'
export const MANIFEST_FILE = 'manifest.json'
export const MANIFEST_FORMAT = 1
/** The shipped folder's name, beside `worker/` in the app's resources (and in the repository). */
export const WORKER_DIST_DIR = 'worker-dist'
/** wrangler 4.144 sends this for a Worker with Durable Objects. */
export const CODE_UPDATE_STRATEGY = { mode: 'deferred', max_delay: 300 } as const
/** The header wrangler 4.144 sends with the workers.dev switch. */
export const SCRIPT_API_DATE = '2025-08-01'
/** The first computer's admin key as 0.38.2 set it. Never sent by this build; removable only on purpose. */
export const LEGACY_ADMIN_SECRET_NAME = 'ADMIN_SECRET'
export const ADMIN_SECRET_PREFIX = 'ADMIN_SECRET_'
export const SECRETS_CONTENT_TYPE = 'application/merge-patch+json'

export type WorkerDistManifest = {
  format: typeof MANIFEST_FORMAT
  /** The wrangler that compiled the bundle. */
  wrangler: string
  /** LIVE_WORKER_BUILD of the Worker's sources it was compiled from. */
  build: string
  mainModule: string
  configFile: string
  /** file name → its SHA-256 (hex) and size in bytes. */
  files: Record<string, { sha256: string; bytes: number }>
  /** A digest of the Worker's sources (scripts/lib/worker-dist.mjs): how the build step tells a stale folder. */
  sources: string
}

export type DurableObjectBinding = { name: string; class_name: string }
export type Migration = { tag: string } & Record<string, unknown>
/** What the upload needs of worker/wrangler.jsonc, as the build step wrote it into upload-config.json. */
export type ShippedWorkerConfig = {
  name: string
  compatibility_date: string
  compatibility_flags: string[]
  durable_objects: { bindings: DurableObjectBinding[] }
  migrations: Migration[]
  observability?: { enabled: boolean }
}

export type ShippedFiles = { manifest: string | null; bundle: Uint8Array | null; config: Uint8Array | null }
export type Verified = { ok: true; manifest: WorkerDistManifest; config: ShippedWorkerConfig; bundle: Uint8Array }
export type Incomplete = { ok: false; error: typeof INSTALLATION_INCOMPLETE; details: string }

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const isText = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)
const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const TAG = /^[A-Za-z0-9._-]{1,64}$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HEX64 = /^[0-9a-f]{64}$/

/** The manifest's shape, or a sentence saying what is wrong with it. */
function readManifest(text: string | null): WorkerDistManifest | string {
  if (text === null) return `${WORKER_DIST_DIR}/${MANIFEST_FILE} is missing.`
  let value: unknown
  try { value = JSON.parse(text) } catch { return `${WORKER_DIST_DIR}/${MANIFEST_FILE} is not readable.` }
  const m = value as Partial<WorkerDistManifest> | null
  if (!m || typeof m !== 'object' || m.format !== MANIFEST_FORMAT) return `${WORKER_DIST_DIR}/${MANIFEST_FILE} is not one this version of TalkWeaver reads.`
  if (!isText(m.wrangler, /^\d+\.\d+\.\d+$/) || !isText(m.build, /^[A-Za-z0-9._-]{1,64}$/) || !isText(m.mainModule, FILE) || !isText(m.configFile, FILE)
    || !isText(m.sources, HEX64) || !m.files || typeof m.files !== 'object') return `${WORKER_DIST_DIR}/${MANIFEST_FILE} is incomplete.`
  for (const name of [m.mainModule, m.configFile]) {
    const entry = (m.files as Record<string, unknown>)[name] as { sha256?: unknown; bytes?: unknown } | undefined
    if (!entry || !isText(entry.sha256, HEX64) || !Number.isInteger(entry.bytes) || (entry.bytes as number) <= 0) return `${WORKER_DIST_DIR}/${MANIFEST_FILE} does not describe ${name}.`
  }
  return m as WorkerDistManifest
}

/** upload-config.json's shape, or a sentence saying what is wrong with it. */
export function readShippedConfig(value: unknown): ShippedWorkerConfig | string {
  const c = value as Partial<ShippedWorkerConfig> | null
  const where = 'the live service\'s upload settings'
  if (!c || typeof c !== 'object') return `${where} are not readable.`
  if (!isText(c.name, SCRIPT_NAME)) return `${where} name no valid Worker.`
  if (!isText(c.compatibility_date, /^\d{4}-\d{2}-\d{2}$/)) return `${where} have no compatibility date.`
  if (!Array.isArray(c.compatibility_flags) || !c.compatibility_flags.every((flag) => isText(flag, /^[a-z0-9_]{1,64}$/))) return `${where} have unreadable compatibility flags.`
  const bindings = c.durable_objects?.bindings
  if (!Array.isArray(bindings) || bindings.length === 0 || !bindings.every((binding) => isText(binding?.name, IDENTIFIER) && isText(binding?.class_name, IDENTIFIER))) return `${where} have unreadable Durable Object bindings.`
  if (!Array.isArray(c.migrations) || !c.migrations.every((migration) => migration && typeof migration === 'object' && isText(migration.tag, TAG))) return `${where} have unreadable migrations.`
  if (new Set(c.migrations.map((migration) => migration.tag)).size !== c.migrations.length) return `${where} name a migration twice.`
  if (c.observability !== undefined && typeof c.observability?.enabled !== 'boolean') return `${where} have unreadable observability settings.`
  return c as ShippedWorkerConfig
}

/**
 * The shipped bundle and its settings, checked against the manifest beside them. `expectedBuild`:
 * the Worker build this app was made with (LIVE_WORKER_BUILD); a manifest for another build is an
 * installation put together from two versions. Pure: the file bytes are passed in.
 */
export function verifyShippedBundle(manifestText: string | null, files: Omit<ShippedFiles, 'manifest'>, expectedBuild?: string): Verified | Incomplete {
  const incomplete = (details: string): Incomplete => ({ ok: false, error: INSTALLATION_INCOMPLETE, details })
  const manifest = readManifest(manifestText)
  if (typeof manifest === 'string') return incomplete(manifest)
  if (expectedBuild !== undefined && manifest.build !== expectedBuild) {
    return incomplete(`${WORKER_DIST_DIR} holds live service build ${manifest.build}; this TalkWeaver was made with build ${expectedBuild}.`)
  }
  for (const [name, bytes] of [[manifest.mainModule, files.bundle], [manifest.configFile, files.config]] as const) {
    const expected = manifest.files[name]
    if (bytes === null) return incomplete(`${WORKER_DIST_DIR}/${name} is missing.`)
    if (bytes.byteLength === 0) return incomplete(`${WORKER_DIST_DIR}/${name} is empty.`)
    const found = sha256(bytes)
    if (found !== expected.sha256 || bytes.byteLength !== expected.bytes) {
      return incomplete(`${WORKER_DIST_DIR}/${name} does not match its manifest (SHA-256 ${found}, ${bytes.byteLength} bytes; the manifest says ${expected.sha256}, ${expected.bytes} bytes).`)
    }
  }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(files.config as Uint8Array).toString('utf8')) } catch { parsed = null }
  const config = readShippedConfig(parsed)
  if (typeof config === 'string') return incomplete(`${WORKER_DIST_DIR}/${manifest.configFile}: ${config}`)
  return { ok: true, manifest, config, bundle: files.bundle as Uint8Array }
}

/**
 * The script deployed is at a migration tag this build does not list: it was set up by a newer
 * TalkWeaver (or by hand). Its migrations cannot be worked out from here, and replaying them all
 * (what wrangler does) would ask Cloudflare to create classes that already exist, so nothing is sent.
 */
export class UnknownMigrationTagError extends Error {
  readonly tag: string
  constructor(tag: string) {
    super('The deployed migration tag is not one this build lists')
    this.name = 'UnknownMigrationTagError'
    this.tag = tag
  }
}

/**
 * What wrangler's getMigrationsToUpload sends, given the tag of the script already deployed (null:
 * none). A tag this build does not list throws UnknownMigrationTagError (wrangler would replay every
 * migration from it; TalkWeaver stops instead).
 */
export function migrationsToApply(migrations: Migration[], deployedTag: string | null): { old_tag?: string; new_tag: string; steps: Record<string, unknown>[] } | null {
  if (migrations.length === 0) return null
  const steps = (list: Migration[]): Record<string, unknown>[] => list.map(({ tag: _tag, ...rest }) => rest)
  const newTag = migrations[migrations.length - 1].tag
  if (!deployedTag) return { new_tag: newTag, steps: steps(migrations) }
  const at = migrations.findIndex((migration) => migration.tag === deployedTag)
  if (at === -1) throw new UnknownMigrationTagError(deployedTag)
  if (at === migrations.length - 1) return null
  return { old_tag: deployedTag, new_tag: newTag, steps: steps(migrations.slice(at + 1)) }
}

export type UploadStep = 'upload' | 'workers-dev'
/** The requests that carry secrets: never part of an upload plan. */
export type SecretsStep = 'add-key' | 'remove-key'
export type PlannedBody =
  | { kind: 'multipart'; metadata: Record<string, unknown>; module: { name: string; type: string; bytes: Uint8Array } }
  | { kind: 'json'; json: Record<string, unknown>; contentType?: string }
  /** Secrets by name only: the sequence that sends it puts in the values. */
  | { kind: 'secrets'; names: readonly string[]; contentType: string }
export type PlannedRequest<Step extends string = UploadStep> = {
  step: Step
  method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE'
  /** Under the API's base address, with its query when it has one. */
  path: string
  headers?: Record<string, string>
  body?: PlannedBody
}

export type UploadInput = {
  config: ShippedWorkerConfig
  manifest: WorkerDistManifest
  bundle: Uint8Array
  accountId: string
  /** The migration tag of the script already deployed; null when there is none (first set-up). */
  deployedMigrationTag: string | null
}

/**
 * The write requests that put the shipped bundle at Cloudflare, in the order they are sent: the
 * script (bundle, settings, migrations still to apply) and its workers.dev address switched on.
 * Exactly those two. No secret is named or sent (the secrets Cloudflare holds for the Worker stay
 * as they are), and no custom domain or route is read, attached or removed (decision R2).
 */
export function planLiveServiceUpload(input: UploadInput): PlannedRequest[] {
  const { config, manifest, bundle, accountId, deployedMigrationTag } = input
  const script = `/accounts/${accountId}/workers/scripts/${config.name}`
  const migrations = migrationsToApply(config.migrations, deployedMigrationTag)
  // The metadata wrangler 4.144's createWorkerUploadForm builds for this Worker, in its order.
  const metadata: Record<string, unknown> = {
    main_module: manifest.mainModule,
    bindings: config.durable_objects.bindings.map(({ name, class_name }) => ({ name, type: 'durable_object_namespace', class_name })),
    compatibility_date: config.compatibility_date,
    ...(config.compatibility_flags.length ? { compatibility_flags: config.compatibility_flags } : {}),
    ...(migrations ? { migrations } : {}),
    code_update_strategy: { ...CODE_UPDATE_STRATEGY },
    ...(config.observability ? { observability: { ...config.observability } } : {}),
  }
  return [
    {
      step: 'upload', method: 'PUT', path: `${script}?excludeScript=true&bindings_inherit=strict`,
      body: { kind: 'multipart', metadata, module: { name: manifest.mainModule, type: 'application/javascript+module', bytes: bundle } },
    },
    workersDevRequest(accountId, config.name),
  ]
}

/**
 * The workers.dev switch on its own: the Worker's workers.dev address switched on. It changes no
 * code, no secret and no domain, and sending it again changes nothing. Also sent alone, by a set-up
 * that finds the script at Cloudflare and gets no answer at its address (a first set-up that stopped
 * between its two requests): live-service-deploy.ts.
 */
export function workersDevRequest(accountId: string, scriptName: string): PlannedRequest<'workers-dev'> {
  if (!validAccountSegment(accountId) || !SCRIPT_NAME.test(scriptName)) throw new TypeError('Not a live service.')
  return {
    step: 'workers-dev', method: 'POST', path: `${scriptPath(accountId, scriptName)}/subdomain`,
    headers: { 'Cloudflare-Workers-Script-Api-Date': SCRIPT_API_DATE },
    body: { kind: 'json', json: { enabled: true } },
  }
}

// ── Secrets ─────────────────────────────────────────────────────────────────────────────────────
// A computer id as worker/admin-keys.ts accepts one under `ADMIN_SECRET_<id>`: lower-case letters and
// digits, never `legacy`, `self` or `join` (scripts/test-live-service-keys.mjs holds the two together).
const COMPUTER_ID = /^[a-z0-9]{1,64}$/
const RESERVED_COMPUTER_IDS: readonly string[] = ['legacy', 'self', 'join']
export const validComputerId = (value: unknown): value is string => typeof value === 'string' && COMPUTER_ID.test(value) && !RESERVED_COMPUTER_IDS.includes(value)

/** `ADMIN_SECRET_<id>`: the only name under which a computer's key is ever sent. Throws for anything that is not a computer's id. */
export function computerSecretName(computerId: string): string {
  if (!validComputerId(computerId)) throw new TypeError('Not a computer id.')
  return ADMIN_SECRET_PREFIX + computerId
}
const scriptPath = (accountId: string, scriptName: string): string => {
  if (!validAccountSegment(accountId) || !SCRIPT_NAME.test(scriptName)) throw new TypeError('Not an account or a Worker name.')
  return `/accounts/${accountId}/workers/scripts/${scriptName}`
}
const secretValue = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('A secret needs a value.')
  return value
}
const secretsRequest = <Step extends SecretsStep>(step: Step, accountId: string, scriptName: string, names: readonly string[]): PlannedRequest<Step> => ({
  step, method: 'PATCH', path: `${scriptPath(accountId, scriptName)}/secrets-bulk`,
  body: { kind: 'secrets', names, contentType: SECRETS_CONTENT_TYPE },
})

/** Add this computer's key: ONE request naming ONE secret, `ADMIN_SECRET_<id>` (proof P1). */
export function addKeyRequest(accountId: string, scriptName: string, computerId: string): PlannedRequest<'add-key'> {
  return secretsRequest('add-key', accountId, scriptName, [computerSecretName(computerId)])
}
/**
 * The body of addKeyRequest, made only as it is sent. It holds exactly one entry, this computer's:
 * `ADMIN_SECRET` and every other computer's key are not in it, so Cloudflare leaves them (and every
 * other secret of the Worker) as they are.
 */
export function addKeyBody(computerId: string, key: string): string {
  const name = computerSecretName(computerId)
  return JSON.stringify({ secrets: { [name]: { name, text: secretValue(key), type: 'secret_text' } } })
}

/**
 * Which secret a removal names. A computer's own (`{ computerId }`) is the ordinary case. The first
 * computer's `ADMIN_SECRET` is removed only by a caller that says so in as many words
 * (`{ legacy: true }`). No other secret can be named: no value of this type reaches one.
 */
export type KeyToRemove = { computerId: string } | { legacy: true }
function removedName(target: KeyToRemove): string {
  if ('legacy' in target) {
    if (target.legacy !== true || 'computerId' in target) throw new TypeError('Not a key to remove.')
    return LEGACY_ADMIN_SECRET_NAME
  }
  return computerSecretName(target.computerId)
}
/** Remove one admin key: ONE request naming ONE secret, set to null (proof P3). */
export function removeKeyRequest(accountId: string, scriptName: string, target: KeyToRemove): PlannedRequest<'remove-key'> {
  return secretsRequest('remove-key', accountId, scriptName, [removedName(target)])
}
export function removeKeyBody(target: KeyToRemove): string {
  return JSON.stringify({ secrets: { [removedName(target)]: null } })
}

/** The Worker's workers.dev address, from the account's subdomain as Cloudflare reports it; null when that is not a plain label. */
export function workersDevAddress(scriptName: string, subdomain: unknown): string | null {
  if (!SCRIPT_NAME.test(scriptName) || !isText(subdomain, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)) return null
  return `https://${scriptName}.${subdomain}.workers.dev`
}

/** Path segments the plan puts in an address: an account id, and a custom domain's id. */
export const validAccountSegment = (value: unknown): value is string => isText(value, /^[A-Za-z0-9_-]{1,64}$/)
/** A Workers custom domain's id as Cloudflare makes them: 32 lowercase hex. Anything else from a reply is not used. */
export const validDomainId = (value: unknown): value is string => isText(value, /^[0-9a-f]{32}$/)

/**
 * The shipped files, given a reader for one file of the shipped folder (null when it cannot be
 * read). The manifest names the other two; a manifest that is not a JSON object names none, and
 * verifyShippedBundle then says the installation is incomplete. Never throws.
 */
export function readShippedFiles(read: (name: string) => Uint8Array | null): ShippedFiles {
  const manifestBytes = read(MANIFEST_FILE)
  const manifest = manifestBytes ? new TextDecoder().decode(manifestBytes) : null
  let named: Record<string, unknown> = {}
  try {
    const parsed: unknown = manifest ? JSON.parse(manifest) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) named = parsed as Record<string, unknown>
  } catch { /* verifyShippedBundle says so */ }
  const file = (name: unknown): Uint8Array | null => (isText(name, FILE) ? read(name) : null)
  return { manifest, bundle: file(named.mainModule), config: file(named.configFile) }
}
