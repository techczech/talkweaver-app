// The Cloudflare connection: the one token, the account it reaches, and whether handouts can be
// published with it (spec docs/plans/cloudflare-setup-in-app, decisions D1, D4, D5, D6, D12).
//
// The token sits in the `cloudflare-token` slot of secrets-store.ts and nowhere else. This module
// reads it for one operation at a time, sends it to Cloudflare's API in an `Authorization` header,
// and turns what Cloudflare answers into the states of src/shared/cloudflare-status.ts.
//
// What a check can and cannot tell. A check only READS: it never writes at Cloudflare to find
// something out. So "Ready" means the token was accepted and the site was found, and the row for
// going live says only that Cloudflare did not refuse a read. Whether the token may EDIT (publish,
// make a site, deploy the live service) is proven by the first publish, creation or deploy; a token
// that can only read shows Ready here and is refused there. Details says so in plain words.
//
// What this defends, and what it does not.
//   - The token leaves this module two ways only: in that header, and inside an authorisation (to
//     deploy the live service, `authoriseLiveDeploy`, or to publish, `authorisePublish`), which
//     hands it out for one launch or request at a time (to the bundled publishing tool, or to the
//     live service's set-up, which sends it through `send` below) and stops handing it out
//     once the token, the account or the site name has been changed. An authorisation also takes
//     the token back OUT of what the tool printed (`clean`), so "Details" never shows it. Every
//     request that carries it
//     goes through `send` (`ask` is `send` with a JSON body), which reads only the HTTP status,
//     Cloudflare's error NUMBERS and the few named fields each call needs. A request that fails to send becomes a fixed kind
//     (`unreachable`); the transport's own error, which can quote the header it refused, is dropped
//     and never read, logged or attached. A status, a reply to a window and `details` therefore hold
//     no token and no text from a Cloudflare reply, with one exception by design: an account's name
//     and id (the spec shows "Connected · <account name>"), cut to plain printable characters.
//   - A token is checked where it comes in (printable ASCII, no space, 16 to 512 characters) and
//     again before it is sent, so it cannot break out of the header.
//   - Requests go to https://api.cloudflare.com/client/v4 and nowhere else. The one exception is for
//     tests: an unpackaged app started with TW_E2E=1 may be pointed at a stand-in API on this
//     computer's own loopback address (`cloudflareApiBase`); a packaged build ignores it. A redirect
//     is never followed. Account ids and site names are checked before they are put in an address.
//   - Every request has a time limit that does not rely on the transport honouring it.
//   - NOT defended: code running as this person (it can read the slot through the operating system,
//     see secrets-store.ts), the token while it is in use (this process's memory, the environment
//     handed to the bundled publishing tool), what Cloudflare keeps, and a party that can change
//     this app's own settings file (it can name another account id or site; the token is still only
//     sent to Cloudflare).
//
// Order. Save token, check, choose account, create site, disconnect and the authorisation of a
// live deploy act on one connection and run ONE AT A TIME through a serial queue. A change of the
// token (save, replace, disconnect) or of the account, site name or custom domain in Settings
// (`settingsChanged`) also starts a new GENERATION at the moment it is asked for: it cancels the
// request under way, and anything under way or answered for an earlier generation changes nothing (no
// state, no setting, no slot) and launches nothing. (A request still waiting its turn belongs to the
// generation it starts in: it reads the token, the account and what is known afresh.) So a check that finishes after Disconnect,
// Replace token or an edit of the account cannot bring the old state back, a site is never made in
// an account Settings no longer names, and a deploy never starts with a replaced token.
//
//   State                    | save / replace token | check            | choose account      | create site     | disconnect
//   -------------------------|----------------------|------------------|---------------------|-----------------|-----------
//   no token                 | saves, then checks   | stays no token   | refused             | refused         | nothing to do
//   storage unavailable      | refused (the reason) | looks again      | refused             | refused         | clears the slot
//   checking (not yet known) | new generation       | joins the one    | refused             | refused         | new generation
//                            |                      | under way        |                     |                 |
//   connected                | new generation       | runs (a second   | if the id is one    | only when the   | new generation
//                            |                      | one joins it)    | the token listed    | row says "No    |
//                            |                      |                  |                     | site yet"       |
//   choose an account        | new generation       | runs             | if the id is listed | refused         | new generation
//   token rejected           | new generation       | runs             | refused             | refused         | new generation
//   could not check          | new generation       | runs             | refused             | refused         | new generation
//
//   "Refused" changes nothing and answers with a fixed sentence. "Create site" asked twice makes one
//   site: the second waits for the first, then finds the row Ready and does nothing.
//
// THE INVARIANT. The connection has one generation. Every event that changes the token, the account
// or the site name increments it, through ONE function (`nextGeneration`); nothing else writes those
// three (the slot is written only here; Settings' account and site are written only through this
// module's settings port, or by the Settings window, which then calls `settingsChanged`). A deploy
// authorisation is valid only while its generation is the current one.
//
//   Event                                                         | changes            | increments generation
//   --------------------------------------------------------------|--------------------|----------------------
//   save token (first token)                                      | token              | yes, when asked for
//   replace token                                                 | token              | yes, when asked for
//   disconnect                                                    | token              | yes, when asked for
//   choose account (the picker)                                   | account            | yes, when the account is saved
//   settingsChanged: account typed in Settings                    | account            | yes, when told
//   settingsChanged: site name typed in Settings                  | site name          | yes, when told
//   settingsChanged: custom domain typed in Settings              | (neither; same path)| yes, when told
//   a check that finds an account and saves it (first connect, or | account            | yes, when it is saved
//     an id in Settings the token no longer lists)                |                    |
//   a check that finds the site and saves its name in Settings    | site name          | yes, when it is saved
//   create site                                                   | the site itself    | yes, when Cloudflare made it
//   a check that changes nothing in Settings; a refused request   | nothing            | no
//   a publish Cloudflare refused for permission                   | nothing: a fact    | no. The Publishing handouts row
//     (`refusedForPermission` of a publish authorisation that is  | learned about this | says "The token cannot publish
//     still current)                                              | token              | pages" from then on
//   a publish that went up (`published`)                          | nothing            | no. That row is no longer overridden
//   start of the app; migration                                   | nothing (an earlier | no: there is no migration,
//                                                                 | install's token and | the slot and Settings are
//                                                                 | Settings are read)  | used as they are
//
//   The turn that causes an increment itself (a check that saves the account) carries on under the
//   new generation; everything else that was asked for earlier is superseded. An authorisation
//   cannot exist before the first check has saved an account: it is granted only for a completed
//   check whose account is the one Settings holds.
//
// The Publishing handouts row after a refused publish (decision D6, known limit). A check only
// reads, so it cannot see that a token may read the site but not publish to it: the first publish
// finds out. From that refusal the row says "The token cannot publish pages", and a later check,
// which again finds the site, does NOT turn it back to Ready. It is cleared by a publish that goes
// up, and by any change that starts a new generation from outside (Replace token, Disconnect, an
// edit of the account, site or domain in Settings): after those the refusal is no longer about the
// connection in use. It does not start a generation itself (nothing the connection is made of
// changed) and it does not stop the next publish from being tried: the permission may have been
// added at Cloudflare without replacing the token.
//
// No Electron import and erasable TypeScript only: scripts/test-cloudflare-connection*.mjs import
// this file as it is. The main process gives it the secrets store, the settings and `fetch`.
import { createKeyedQueue } from './owner-tokens.ts'
import { SecretsError, secretsFailureMessage, type SecretsStore } from './secrets-store.ts'
import {
  DEFAULT_PAGES_PROJECT, LIVE_NO_PERMISSION, PAGES_PERMISSION, ROUTES_PERMISSION, UNKNOWN_LIVE_SERVICE, WORKERS_PERMISSION, unknownPublishing,
  suggestedShareHost, unknownShareLink,
  type CloudflareAccount, type CloudflareConnection, type CloudflareStatus, type CustomDomainState,
  type LiveServiceRow, type PublishingRow, type ShareLinkRow,
} from '../shared/cloudflare-status.ts'
import { publishNotReady, type PublishNotReady } from '../shared/publish-status.ts'

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
/** How long one request may take. */
export const REQUEST_TIMEOUT_MS = 10_000
/** Opening Settings → Cloudflare checks at most this often (decision D6). */
export const OPEN_CHECK_INTERVAL_MS = 60_000
const MAX_REPLY_BYTES = 1024 * 1024

// ── Where requests go ───────────────────────────────────────────────────────────────────────────

/** `http://127.0.0.1:<port>/client/v4` exactly, or null. */
export function loopbackApiBase(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null
  try {
    const url = new URL(value)
    const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && url.pathname === '/client/v4'
      && !url.search && !url.hash && !url.username && !url.password
    return loopback ? `${url.origin}/client/v4` : null
  } catch {
    return null
  }
}

/**
 * Tests only (decision D1: environment overrides are for tests and are ignored in a packaged
 * build). The stand-in API's address, when all three hold: the app is not packaged, it was started
 * as a test harness (TW_E2E=1), and the address is this computer's loopback. Otherwise null.
 */
export function standInApiBase(context: { packaged: boolean; e2e: boolean; override: unknown }): string | null {
  if (context.packaged || !context.e2e) return null
  return loopbackApiBase(context.override)
}

/** The API this app's own calls go to: Cloudflare's, or the stand-in under the three conditions. */
export function cloudflareApiBase(context: { packaged: boolean; e2e: boolean; override: unknown }): string {
  return standInApiBase(context) ?? CLOUDFLARE_API_BASE
}

// ── What may be sent, and what may be put in an address ─────────────────────────────────────────

/** 16 to 512 printable ASCII characters with no space: safe to send as `Bearer <token>`. */
export function validCloudflareToken(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{16,512}$/.test(value)
}
function validAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}
/** A Pages site name that is safe as one path segment (Cloudflare's own rule is stricter). */
export function validProjectName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value)
}
/** Plain printable text of at most `max` characters, or '' when nothing usable is left. */
function plainText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // Control characters, line and paragraph separators and the characters that reorder text.
  const unprintable = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g')
  return value.replace(unprintable, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}
function hostOf(address: string): string {
  const text = address.trim()
  if (!text) return ''
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase() } catch { return '' }
}

// ── One request ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a request came to. `denied`: Cloudflare refused the token for this (401, 403). `missing`:
 * 404. `refused`: any other 4xx, or a success flag that is false. `unreachable`: no usable answer
 * (not sent, timed out, 5xx, not JSON). `cancelled`: a newer generation took over.
 */
export type AnswerKind = 'ok' | 'denied' | 'missing' | 'refused' | 'conflict' | 'unreachable' | 'cancelled'
export type Answer<Result = null> = { kind: AnswerKind; http: number | null; codes: number[]; result: Result | null }

const noAnswer = <Result>(kind: AnswerKind): Answer<Result> => ({ kind, http: null, codes: [], result: null })

export interface RequestPort {
  fetch: typeof fetch
  base: string
  timeoutMs: number
  /** Aborted when a newer generation takes over. */
  cancelled: AbortSignal
}

/** Settle with `work`, or reject when `ms` pass or `cancelled` fires, whatever `work` itself does. */
function within<Result>(work: (signal: AbortSignal) => Promise<Result>, ms: number, cancelled: AbortSignal): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const stop = new AbortController()
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cancelled.removeEventListener('abort', onCancel)
      settle()
    }
    const onCancel = (): void => { stop.abort(); finish(() => reject(new Error('cancelled'))) }
    const timer = setTimeout(() => { stop.abort(); finish(() => reject(new Error('timeout'))) }, ms)
    if (cancelled.aborted) return onCancel()
    cancelled.addEventListener('abort', onCancel, { once: true })
    let started: Promise<Result>
    try { started = work(stop.signal) } catch { return finish(() => reject(new Error('failed'))) }
    // The reason for a failure is never passed on: it can quote the request, header included.
    started.then((value) => finish(() => resolve(value)), () => finish(() => reject(new Error('failed'))))
  })
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_REPLY_BYTES) { try { await reader.cancel() } catch { /* already closed */ } throw new Error('too large') }
    parts.push(value)
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Send one request with the token and sort the answer. Every request that carries the token goes
 * through here. `pick` takes the reply's `result` and returns only the fields the caller needs
 * (null when it is not the expected shape); nothing else of the reply is kept.
 */
export async function ask<Result>(
  port: RequestPort, token: string, method: 'GET' | 'POST', path: string,
  pick: (result: unknown) => Result | null, body?: Record<string, unknown>,
): Promise<Answer<Result>> {
  return send(port, token, { method, path, ...(body ? { body: JSON.stringify(body), contentType: 'application/json' } : {}) }, pick)
}

/**
 * One request of any kind (the live service's upload, ticket 11: a multipart PUT, a merge-patch
 * PATCH, a DELETE), with the same rules as `ask`, which is this with a JSON body. `headers` may not
 * name the authorisation, and only plain header names and values are sent.
 */
export type OutgoingRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: string | FormData
  /** For a string body. A FormData body sets its own (with the boundary). */
  contentType?: string
  headers?: Record<string, string>
  /** Values that must never be in an address (the live service's keys); the token never is either. */
  forbidden?: string[]
}
export async function send<Result>(
  port: RequestPort, token: string, request: OutgoingRequest, pick: (result: unknown) => Result | null,
): Promise<Answer<Result>> {
  const { method, path, body } = request
  if (!validCloudflareToken(token)) return noAnswer('refused')
  if (port.base !== CLOUDFLARE_API_BASE && loopbackApiBase(port.base) !== port.base) return noAnswer('unreachable')
  if (!path.startsWith('/') || path.includes('..') || /[\s\\#]/.test(path)) return noAnswer('unreachable')
  // No secret is ever put in an address, whatever a reply put into the parts of one: refused, unsent.
  let decoded = path
  try { decoded = decodeURIComponent(path) } catch { /* not encoded text: compared as it is */ }
  const secretsOf = [token, ...(request.forbidden ?? [])].filter((value) => typeof value === 'string' && value.length > 0)
  if (secretsOf.some((value) => path.includes(value) || decoded.includes(value) || path.includes(encodeURIComponent(value)))) return noAnswer('refused')
  const extra = Object.entries(request.headers ?? {})
  if (extra.some(([name, value]) => !/^[A-Za-z0-9-]{1,64}$/.test(name) || /^authorization$/i.test(name) || !/^[\x20-\x7e]{0,256}$/.test(value))) return noAnswer('refused')
  let http = 0
  let text = ''
  try {
    const sent = await within(async (signal) => {
      const response = await port.fetch(`${port.base}${path}`, {
        method, signal, redirect: 'error',
        headers: {
          ...Object.fromEntries(extra),
          authorization: `Bearer ${token}`, accept: 'application/json',
          ...(typeof body === 'string' && request.contentType ? { 'content-type': request.contentType } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      })
      return { http: response.status, text: await readCapped(response) }
    }, port.timeoutMs, port.cancelled)
    http = sent.http
    text = sent.text
  } catch {
    // Nothing of the failure is read: only whether a newer generation asked for it.
    return noAnswer(port.cancelled.aborted ? 'cancelled' : 'unreachable')
  }
  type Reply = { success?: unknown; errors?: unknown; result?: unknown }
  let reply = null as Reply | null
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) reply = parsed as Reply
  } catch { /* not JSON: sorted by the HTTP status alone; the parser's message could quote the reply */ }
  const codes = Array.isArray(reply?.errors)
    ? (reply.errors as unknown[]).map((error) => (error as { code?: unknown } | null)?.code).filter((code): code is number => Number.isInteger(code)).slice(0, 8)
    : []
  const sorted = (kind: AnswerKind, result: Result | null = null): Answer<Result> => ({ kind, http, codes, result })
  if (http === 401 || http === 403) return sorted('denied')
  if (http === 404) return sorted('missing')
  if (http === 409) return sorted('conflict')
  if (http >= 400 && http < 500 && http !== 408 && http !== 429) return sorted('refused')
  if (http < 200 || http >= 300 || !reply) return sorted('unreachable')
  if (reply.success !== true) return sorted('refused')
  const result = pick(reply.result)
  return result === null ? sorted('unreachable') : sorted('ok', result)
}

// ── The four questions, and what is kept of each answer ─────────────────────────────────────────

const TOKEN_STATUSES = ['active', 'disabled', 'expired'] as const
type TokenStatus = typeof TOKEN_STATUSES[number]

function pickVerify(result: unknown): { status: TokenStatus } | null {
  const status = (result as { status?: unknown } | null)?.status
  return TOKEN_STATUSES.includes(status as TokenStatus) ? { status: status as TokenStatus } : null
}
/** How many accounts are asked for at a time, and how many are listed before giving up. */
export const ACCOUNTS_PER_PAGE = 50
export const ACCOUNTS_CAP = 1000
type AccountsPage = { accounts: CloudflareAccount[]; entries: number }
function pickAccountsPage(result: unknown): AccountsPage | null {
  if (!Array.isArray(result)) return null
  const accounts: CloudflareAccount[] = []
  for (const entry of result.slice(0, ACCOUNTS_PER_PAGE)) {
    const id = (entry as { id?: unknown } | null)?.id
    if (!validAccountId(id)) continue
    accounts.push({ id, name: plainText((entry as { name?: unknown }).name, 80) || id })
  }
  return { accounts, entries: result.length }
}
/**
 * Every account the token lists, a page at a time, up to ACCOUNTS_CAP. A page that does not answer
 * makes the whole list unanswered (a partial list would pick the wrong account). `truncated`: the
 * cap was reached and there were still more.
 */
export async function listAccounts(port: RequestPort, token: string): Promise<{ answer: Answer<CloudflareAccount[]>; truncated: boolean }> {
  const accounts: CloudflareAccount[] = []
  const seen = new Set<string>()
  for (let page = 1; ; page += 1) {
    const answer = await ask(port, token, 'GET', `/accounts?page=${page}&per_page=${ACCOUNTS_PER_PAGE}`, pickAccountsPage)
    if (answer.kind !== 'ok' || !answer.result) return { answer: { ...answer, result: null }, truncated: false }
    for (const account of answer.result.accounts) if (!seen.has(account.id)) { seen.add(account.id); accounts.push(account) }
    const more = answer.result.entries >= ACCOUNTS_PER_PAGE
    if (!more || page * ACCOUNTS_PER_PAGE >= ACCOUNTS_CAP) return { answer: { ...answer, result: accounts }, truncated: more }
  }
}
/** The site was found, and its own pages.dev address (`subdomain` in Cloudflare's reply), when it is one. */
type FoundProject = { found: true; subdomain: string | null }
function pickProject(result: unknown): FoundProject | null {
  if (!result || typeof result !== 'object' || typeof (result as { name?: unknown }).name !== 'string') return null
  const given = (result as { subdomain?: unknown }).subdomain
  const subdomain = typeof given === 'string' ? hostOf(given) : ''
  return { found: true, subdomain: subdomain.endsWith('.pages.dev') && validHostname(subdomain) ? subdomain : null }
}
type AttachedDomain = { name: string; active: boolean }

/**
 * The handout web address (spec "Publishing handouts"; Dominik, 10 Oct: the row shows the address
 * itself). From GET …/pages/projects/<site>/domains: the custom domain in Settings when it is active
 * on the site, else the first active custom domain Cloudflare lists, else the site's own pages.dev
 * address. Null when neither question was answered. Pure.
 */
export function siteAddress(domains: Answer<AttachedDomain[]> | undefined, project: Answer<FoundProject> | undefined, preferred: string): string | null {
  const active = domains?.kind === 'ok' ? (domains.result ?? []).filter((domain) => domain.active && !domain.name.endsWith('.pages.dev')).map((domain) => domain.name) : []
  if (preferred && active.includes(preferred)) return preferred
  if (active.length) return active[0]
  if (domains?.kind !== 'ok') return null
  return project?.kind === 'ok' ? project.result?.subdomain ?? null : null
}
function pickDomains(result: unknown): AttachedDomain[] | null {
  if (!Array.isArray(result)) return null
  return result.slice(0, 100).flatMap((entry) => {
    const name = hostOf(typeof (entry as { name?: unknown } | null)?.name === 'string' ? (entry as { name: string }).name : '')
    return name ? [{ name, active: (entry as { status?: unknown }).status === 'active' }] : []
  })
}
const pickAnything = (): true => true

// ── The share-link address: three reads, no write ───────────────────────────────────────────────
// Asked only when Settings holds a share-link address. (1) Which zones of this account contain the
// hostname: GET /zones?name=<each parent name>&account.id=<account>. (2) Whether the token is let
// into Workers routes for that zone: GET /zones/<zone>/workers/routes. (3) Whether the hostname is
// already a Workers custom domain of the account: GET /accounts/<account>/workers/domains. All
// three only read. Like the other rows, a read that is not refused does not prove the token may
// EDIT routes; the attaching ticket finds that out when it writes.
type Zone = { id: string; name: string }
const ZONE_CANDIDATES_CAP = 6
function validHostname(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)
}
function pickZones(result: unknown): Zone[] | null {
  if (!Array.isArray(result)) return null
  return result.slice(0, 50).flatMap((entry) => {
    const id = (entry as { id?: unknown } | null)?.id
    const name = hostOf(typeof (entry as { name?: unknown } | null)?.name === 'string' ? (entry as { name: string }).name : '')
    return validAccountId(id) && name ? [{ id, name }] : []
  })
}
type WorkerDomain = { hostname: string }
function pickWorkerDomains(result: unknown): WorkerDomain[] | null {
  if (!Array.isArray(result)) return null
  return result.slice(0, 1000).flatMap((entry) => {
    const hostname = hostOf(typeof (entry as { hostname?: unknown } | null)?.hostname === 'string' ? (entry as { hostname: string }).hostname : '')
    return hostname ? [{ hostname }] : []
  })
}
/** The zone of this account the hostname lives in: the longest zone name that is the host or a parent of it. */
export function zoneOfHost(host: string, zones: readonly Zone[]): Zone | null {
  let best: Zone | null = null
  for (const zone of zones) {
    if ((host === zone.name || host.endsWith(`.${zone.name}`)) && (!best || zone.name.length > best.name.length)) best = zone
  }
  return best
}
/** The names a zone containing `host` could have: the host and its parents, down to two labels. */
function zoneNames(host: string): string[] {
  const labels = host.split('.')
  const names: string[] = []
  for (let from = 0; from <= labels.length - 2 && names.length < ZONE_CANDIDATES_CAP; from += 1) names.push(labels.slice(from).join('.'))
  return names
}
/** Which zones of the account contain the host. Any refusal speaks for all; an unanswered name makes the list unanswered. */
async function listZonesOfHost(port: RequestPort, token: string, accountId: string, host: string): Promise<Answer<Zone[]>> {
  const answers = await Promise.all(zoneNames(host).map((name) =>
    ask(port, token, 'GET', `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(accountId)}&per_page=5`, pickZones)))
  const zones: Zone[] = []
  for (const answer of answers) if (answer.kind === 'ok') zones.push(...(answer.result ?? []))
  const found = zoneOfHost(host, zones)
  if (found) return { kind: 'ok', http: 200, codes: [], result: [found] }
  const trouble = answers.find((answer) => answer.kind === 'denied') ?? answers.find((answer) => answer.kind !== 'ok')
  return trouble ? { ...trouble, result: null } : { kind: 'ok', http: 200, codes: [], result: [] }
}
/** Everything the share-link row needs, asked only for a valid hostname. */
async function askShareLink(port: RequestPort, token: string, accountId: string, host: string): Promise<Pick<CheckAnswers, 'shareZones' | 'shareRoutes' | 'shareDomains'>> {
  if (!validHostname(host)) return {}
  const [shareZones, shareDomains] = await Promise.all([
    listZonesOfHost(port, token, accountId, host),
    ask(port, token, 'GET', `/accounts/${encodeURIComponent(accountId)}/workers/domains`, pickWorkerDomains),
  ])
  const zone = shareZones.kind === 'ok' ? shareZones.result?.[0] : undefined
  const shareRoutes = zone ? await ask(port, token, 'GET', `/zones/${encodeURIComponent(zone.id)}/workers/routes`, pickAnything) : undefined
  return { shareZones, shareRoutes, shareDomains }
}

/**
 * The Share-link domain row, from the answers (decision D1, spec "Per feature"). Pure. `host`: the
 * address in Settings, '' for none. `known`: the row as last known, kept (greyed) when nothing
 * decisive was answered. Only reads: `attached` is "the hostname is a Workers custom domain of this
 * account"; `no-permission` is a refused read of the zone or of its Workers routes.
 */
export function shareLinkRow(host: string, answers: Pick<CheckAnswers, 'shareZones' | 'shareRoutes' | 'shareDomains'>, known: ShareLinkRow | null): ShareLinkRow {
  if (!host) return { ...unknownShareLink(''), state: 'none' }
  const row = (state: ShareLinkRow['state'], permission: string | null = null): ShareLinkRow => ({ state, host, suggested: null, permission, stale: false })
  const last = (): ShareLinkRow => (known && known.host === host && known.state !== 'unknown' && known.state !== 'none' ? { ...known, stale: true } : unknownShareLink(host))
  const { shareZones, shareRoutes, shareDomains } = answers
  if (!shareZones && !shareDomains) return last()
  if (shareDomains?.kind === 'ok' && (shareDomains.result ?? []).some((domain) => domain.hostname === host)) return row('attached')
  if (!shareZones) return last()
  if (shareZones.kind === 'denied') return row('no-permission', ROUTES_PERMISSION)
  if (shareZones.kind !== 'ok') return last()
  if ((shareZones.result ?? []).length === 0) return row('not-on-account')
  if (shareRoutes?.kind === 'denied') return row('no-permission', ROUTES_PERMISSION)
  // The zone is this account's and routes were not refused to the token: the address can be attached, and is not yet.
  if (shareRoutes?.kind === 'ok') return row('not-attached')
  return last()
}

/**
 * The None row with no address in Settings, carrying the address it suggests from the handout web
 * address (share.<custom domain>). Text only (Dominik, 10 Oct): nothing is read or attached for it.
 */
export function withShareSuggestion(row: ShareLinkRow, address: string | null): ShareLinkRow {
  return row.state === 'none' ? { ...row, suggested: suggestedShareHost(address) } : row
}

export type CheckAnswers = {
  verify: Answer<{ status: TokenStatus }>
  accounts: Answer<CloudflareAccount[]>
  /** The token lists more accounts than are read (ACCOUNTS_CAP): the list is not the whole of them. */
  accountsTruncated?: boolean
  /** The three below are asked only once an account is known. */
  project?: Answer<FoundProject>
  /** The site's custom domains: asked whenever the site is named (the row shows the handout web address). */
  domains?: Answer<AttachedDomain[]>
  workers?: Answer<true>
  /** The three below are asked only when Settings holds a share-link address. */
  shareZones?: Answer<Zone[]>
  shareRoutes?: Answer<true>
  shareDomains?: Answer<WorkerDomain[]>
}

export type ConnectionSettings = {
  /** `cfAccountId`: found by the app, or typed as the advanced override. '' when unset. */
  accountId: string
  /** `cfPagesProject`. '' when unset: the default name is used. */
  project: string
  /** `publishBaseUrl`: the custom domain, or ''. */
  baseUrl: string
  /** `sharedTalkLinkBase` as a bare hostname, or ''. Optional: a settings port that knows no share-link address leaves it out. */
  shareDomain?: string
}

export type AccountChoice =
  | { kind: 'one'; account: CloudflareAccount }
  | { kind: 'several'; accounts: CloudflareAccount[] }
  | { kind: 'none' }

/**
 * Which account the token is used with (decision D4). One account listed: that one. Several: the one
 * Settings already names, else a picker. None listed (or the list did not answer): the id typed in
 * Settings, if any. An id in Settings that the token's own list does not contain is not used: it
 * belongs to an earlier token. A list cut short at ACCOUNTS_CAP: only the id typed in Settings.
 */
export function resolveAccount(accounts: Answer<CloudflareAccount[]>, configuredId: string, truncated = false): AccountChoice {
  const listed = accounts.kind === 'ok' ? accounts.result ?? [] : []
  const configured = listed.find((account) => account.id === configuredId)
  if (configured) return { kind: 'one', account: configured }
  // Too many accounts to list: the id typed in Settings is used as it is, and with none typed there
  // is no picker to offer (it would be missing accounts).
  if (truncated) return validAccountId(configuredId) ? { kind: 'one', account: { id: configuredId, name: configuredId } } : { kind: 'several', accounts: [] }
  if (listed.length === 1) return { kind: 'one', account: listed[0] }
  if (listed.length > 1) return { kind: 'several', accounts: listed }
  return validAccountId(configuredId) ? { kind: 'one', account: { id: configuredId, name: configuredId } } : { kind: 'none' }
}

function describe(name: string, answer: Answer<unknown> | undefined): string | null {
  if (!answer || answer.kind === 'ok' || answer.kind === 'cancelled') return null
  const status = answer.http === null ? 'no answer' : `HTTP ${answer.http}`
  return `${name}: ${status}${answer.codes.length ? ` (Cloudflare error ${answer.codes.join(', ')})` : ''}`
}
function detailsOf(answers: CheckAnswers): string | null {
  const lines = [
    describe('Token check', answers.verify), describe('Account list', answers.accounts),
    // A site that is not there yet is an answer, not a failure: the row says so itself.
    describe('Site', answers.project?.kind === 'missing' ? undefined : answers.project),
    describe('Custom domains', answers.project?.kind === 'ok' ? answers.domains : undefined), describe('Live service permission', answers.workers),
    describe('Share-link zone', answers.shareZones), describe('Share-link routes', answers.shareRoutes), describe('Share-link domains', answers.shareDomains),
  ].filter((line): line is string => line !== null)
  return lines.length ? lines.join(' · ') : null
}

export const SITE_NAME_NOTICE = 'The site name in Settings cannot be used: letters, digits and hyphens only.'
export const TOO_MANY_ACCOUNTS_NOTICE = 'This token can see too many accounts to list. Type the account id below.'
/** Details, for a row that was only read: what the state does and does not mean. */
export const SITE_FOUND_DETAIL = 'Site: found. The permission to publish is proven by the first publish.'
export const LIVE_NOT_REFUSED_DETAIL = 'Live service: a read was not refused. The permission to deploy is proven by the first set-up.'

export type CheckInput = {
  answers: CheckAnswers
  settings: ConnectionSettings
  /** The status before this check: the source of "last known" states and of "last checked". */
  previous: CloudflareStatus | null
  now: number
}

/**
 * The connection check (decision D6): from what Cloudflare answered to the state of the connection
 * and of each row. Pure: no clock, no network, no settings written.
 */
export function connectionCheck(input: CheckInput): CloudflareStatus {
  const { answers, settings, previous, now } = input
  const project = settings.project || DEFAULT_PAGES_PROJECT
  const details = [detailsOf(answers), answers.project?.kind === 'ok' ? SITE_FOUND_DETAIL : null, answers.workers?.kind === 'ok' ? LIVE_NOT_REFUSED_DETAIL : null]
    .filter((line): line is string => line !== null).join(' · ') || null
  const listed = answers.accounts.kind === 'ok' && (answers.accounts.result ?? []).length > 0
  const turnedAway = (answer: Answer<unknown>): boolean => answer.kind === 'denied' || answer.kind === 'refused' || answer.kind === 'missing'

  // Is the token one Cloudflare accepts? `verify` speaks for a person's token; a token that belongs
  // to an account is unknown to it and shows itself by listing its account.
  let token: 'accepted' | 'rejected' | 'unknown'
  if (answers.verify.kind === 'ok') token = answers.verify.result?.status === 'active' ? 'accepted' : 'rejected'
  else if (listed) token = 'accepted'
  else if (turnedAway(answers.accounts)) token = 'rejected'
  else if (turnedAway(answers.verify) && answers.accounts.kind === 'ok') token = 'rejected'
  else token = 'unknown'

  const shareHost = hostOf(settings.shareDomain ?? '')
  const lastKnown = (): Pick<CloudflareStatus, 'publishing' | 'liveService' | 'shareLink'> => ({
    // A suggestion last shown stays, greyed (and not offered as a button) while Cloudflare does not answer.
    shareLink: ((row) => (row.state === 'none' && row.suggested ? { ...row, stale: true } : row))(
      withShareSuggestion(shareLinkRow(shareHost, {}, previous?.shareLink ?? null), previous?.publishing.address ?? null)),
    publishing: previous && previous.publishing.state !== 'unknown' && previous.publishing.state !== 'creating'
      ? { ...previous.publishing, stale: true } : unknownPublishing(project),
    liveService: previous && previous.liveService.state !== 'unknown' ? { ...previous.liveService, stale: true } : UNKNOWN_LIVE_SERVICE,
  })
  const nothingKnown = { publishing: unknownPublishing(project), liveService: UNKNOWN_LIVE_SERVICE, shareLink: unknownShareLink(shareHost) }
  const answered = { busy: false, checkedAt: now, notice: null, details }

  if (token === 'rejected') return { connection: { state: 'rejected' }, ...nothingKnown, ...answered }
  const choice = resolveAccount(answers.accounts, settings.accountId, answers.accountsTruncated === true)
  // No account to use and no list to choose from: that is "could not check", not "no account".
  if (token === 'unknown' || (choice.kind === 'none' && answers.accounts.kind !== 'ok')) {
    return { connection: { state: 'unreachable', lastCheckedAt: previous?.checkedAt ?? null }, ...lastKnown(), busy: false, checkedAt: previous?.checkedAt ?? null, notice: null, details }
  }

  if (choice.kind === 'several') {
    return { connection: { state: 'choose-account', accounts: choice.accounts }, ...nothingKnown, ...answered, notice: choice.accounts.length === 0 ? TOO_MANY_ACCOUNTS_NOTICE : null }
  }
  if (choice.kind === 'none') {
    // A valid token that reaches no account cannot publish: the row says which permission to add.
    return {
      connection: { state: 'connected', account: null },
      publishing: { ...unknownPublishing(project), state: 'no-permission', permission: PAGES_PERMISSION },
      liveService: UNKNOWN_LIVE_SERVICE, shareLink: unknownShareLink(shareHost), ...answered,
    }
  }

  // An id used without the list (the list did not answer) keeps the name it was last shown with.
  const before = previous?.connection.state === 'connected' ? previous.connection.account : null
  const account = before && before.id === choice.account.id && choice.account.name === choice.account.id ? before : choice.account
  const connection: CloudflareConnection = { state: 'connected', account }
  const known = lastKnown()

  let customDomain: CustomDomainState = 'none'
  const host = hostOf(settings.baseUrl)
  const activeCustom = answers.domains?.kind === 'ok' && (answers.domains.result ?? []).some((domain) => domain.active && !domain.name.endsWith('.pages.dev'))
  if (host) {
    if (host.endsWith('.pages.dev')) customDomain = 'set'
    else if (answers.domains?.kind === 'ok') customDomain = (answers.domains.result ?? []).some((domain) => domain.name === host && domain.active) ? 'set' : 'not-reachable'
    else if (answers.project?.kind === 'missing') customDomain = 'not-reachable'
    else customDomain = previous?.publishing.customDomain === 'not-reachable' ? 'not-reachable' : 'set'
  } else if (activeCustom) customDomain = 'set'
  // The handout web address. Unanswered domains: the address last shown, kept.
  const address = siteAddress(answers.domains, answers.project, host)
    ?? (answers.project?.kind === 'ok' && previous?.publishing.project === project ? previous.publishing.address : null)

  let publishing: PublishingRow
  let notice: string | null = null
  const row = (state: PublishingRow['state'], permission: string | null = null): PublishingRow => ({ state, project, permission, customDomain, address, stale: false })
  if (!validProjectName(project)) { publishing = row('unknown'); notice = SITE_NAME_NOTICE }
  else if (answers.project?.kind === 'ok') publishing = row('ready')
  else if (answers.project?.kind === 'missing') publishing = row('no-site')
  else if (answers.project?.kind === 'denied') publishing = row('no-permission', PAGES_PERMISSION)
  else publishing = known.publishing

  let liveService: LiveServiceRow
  if (answers.workers?.kind === 'ok') liveService = { state: 'not-refused', permission: null, stale: false }
  else if (answers.workers?.kind === 'denied') liveService = { state: 'no-permission', permission: WORKERS_PERMISSION, stale: false }
  else liveService = known.liveService

  // No address in Settings and a custom domain on the site: the row suggests share.<it>, as text.
  const shareLink = withShareSuggestion(shareLinkRow(shareHost, answers, previous?.shareLink ?? null), publishing.state === 'ready' ? publishing.address : null)

  return { connection, publishing, liveService, shareLink, ...answered, notice }
}

// ── The connection ──────────────────────────────────────────────────────────────────────────────

export const TOKEN_SHAPE_ERROR = 'This is not a Cloudflare API token: it should be one line of letters, digits and punctuation with no spaces.'
export const NO_TOKEN_ERROR = 'Paste a Cloudflare token first.'
export const NOT_LISTED_ERROR = 'That account is not one this token can see.'
export const NOT_NOW_ERROR = 'There is no site to create just now.'
export const SUPERSEDED_ERROR = 'A newer request replaced this one.'
export const CREATE_FAILED_NOTICE = 'The site could not be created.'
export const UNREADABLE_TOKEN_NOTICE = 'The saved token could not be read on this computer. Paste it again.'
export const SETTINGS_NOT_SAVED_NOTICE = 'The account and site could not be saved in Settings, so publishing is not ready. Check again once this computer can save.'
export const SETTINGS_CHANGED_ERROR = 'The account or site in Settings changed. Nothing was created; check the row again.'
export const SETTINGS_CHANGED_PUBLISH_ERROR = 'The account or site in Settings is not the one that was checked. Nothing was published; check the connection in Settings → Cloudflare.'
export const CHECK_FAILED_ERROR = 'The check could not be completed.'
export const DEPLOY_SUPERSEDED_ERROR = 'The Cloudflare token or account changed while the live service was being set up, so set-up stopped.'
export const DEPLOY_NOT_CONNECTED_ERROR = 'Going live needs a working Cloudflare connection: see Settings → Cloudflare.'
export const DEPLOY_NOT_CHECKED_ERROR = 'Cloudflare could not be checked, so the live service was not set up. Try again when this computer is online.'
/** What a publish reports when the token, the account or the site changed under it. Nothing was recorded. */
export const PUBLISH_SUPERSEDED_ERROR = 'The Cloudflare token, account or site changed while publishing, so publishing stopped. Publish again.'
/** Details, for a row a refused publish turned to "The token cannot publish pages". */
export const PUBLISH_REFUSED_DETAIL = 'Publishing: Cloudflare refused the last publish. The site is found, but this token may not publish to it.'
/** What stands in for the token in text an authorisation has cleaned. */
export const TOKEN_REMOVED = '[token removed]'

/** What a call gets back. `error` is always a fixed sentence. (The preload file types the same shape for the window.) */
export type ConnectionReply = { ok: true; status: CloudflareStatus } | { ok: false; error: string; status: CloudflareStatus }

/** The two variables the bundled publishing tool is given for one launch. */
export type DeployCredentials = { CLOUDFLARE_API_TOKEN: string; CLOUDFLARE_ACCOUNT_ID: string }
/**
 * Leave to deploy the live service, taken in one turn of the queue: the token, the account and the
 * verdict of a completed check all belong to one generation. The token is not a field: it is handed
 * to `launch` by `run`, once per launch, and only while that generation is still the current one.
 */
export interface LiveDeployAuthorisation {
  readonly accountId: string
  /** Still the current generation: no token, account or site change since. */
  current(): boolean
  /**
   * Run one launch with the credentials. Answers `superseded`, without the launch's result, when the
   * generation is no longer current before the launch (which then does not start) or after it.
   */
  run<Result>(launch: (credentials: DeployCredentials) => Promise<Result>): Promise<{ superseded: true } | { superseded: false; result: Result }>
  /** `text` (what the tool printed) with every occurrence of the token taken out. */
  clean(text: string): string
}

/**
 * Leave to publish the site: the same rule as a live deploy (one turn of the queue; token, account
 * and site name of one generation; the token only through `run`), plus the site to publish to and
 * the two things a publish teaches the connection.
 */
export interface PublishAuthorisation extends LiveDeployAuthorisation {
  /** The Pages site the check found. */
  readonly project: string
  readonly productionBranch: string
  /** Cloudflare refused this publish for permission. Changes the row only while this authorisation is current. */
  refusedForPermission(): void
  /** This publish went up, so the token may publish. Only while this authorisation is current. */
  published(): void
}

export type PublishGrant =
  | { ok: true; authorisation: PublishAuthorisation }
  /** `notReady`: what is missing, for the sheet. `superseded`: the connection changed while this was being decided. */
  | { ok: false; error: string; notReady?: PublishNotReady; superseded?: true }

export interface ConnectionSettingsPort {
  read(): ConnectionSettings & { productionBranch: string }
  /** Keep what the app found. Only ever called with an account id or a site name. */
  write(patch: { accountId?: string; project?: string }): void
}

export interface CloudflareConnectionOptions {
  secrets: SecretsStore
  settings: ConnectionSettingsPort
  fetch: typeof fetch
  /** The API's address: `cloudflareApiBase(...)`. Asked for at each operation. */
  apiBase: () => string
  now?: () => number
  timeoutMs?: number
  /** Called with every new status (to tell the windows). Its failure is ignored. */
  onChange?: (status: CloudflareStatus) => void
}

export interface CloudflareConnectionService {
  /** The status as it stands. Starts nothing. */
  status(): CloudflareStatus
  /** Save (or replace) the token, then check it. Answers once the token is stored; the check goes on. */
  saveToken(text: unknown): Promise<ConnectionReply>
  /**
   * Ask Cloudflare. `opened`: because Settings → Cloudflare was opened, so at most once a minute.
   * A check asked for while one is under way joins it.
   */
  check(reason?: 'asked' | 'opened'): Promise<ConnectionReply>
  chooseAccount(id: unknown): Promise<ConnectionReply>
  /** Make the Pages site the row names. */
  createSite(): Promise<ConnectionReply>
  /** Remove the token. Nothing at Cloudflare is touched. */
  disconnect(): Promise<ConnectionReply>
  /**
   * The account, the site name or the custom domain in Settings was changed by hand (already
   * written): a new generation, then a check. What was under way for the earlier values is cancelled.
   */
  settingsChanged(): Promise<ConnectionReply>
  /**
   * Leave to deploy the live service with the saved token. Waits its turn in the queue; with no
   * completed check of the current generation it runs one first. Refused, with a fixed sentence,
   * when there is no working connection, when the check found the token cannot run the live
   * service, or when Cloudflare could not be checked: never granted on "nothing known".
   */
  authoriseLiveDeploy(): Promise<{ ok: true; authorisation: LiveDeployAuthorisation } | { ok: false; error: string }>
  /**
   * Leave to publish handouts with the saved token. Waits its turn in the queue. Unless a completed
   * check of the current generation already found the row Ready, it checks first (so a connection
   * that was offline, or a site made a moment ago, is seen as it is now). Refused, naming what is
   * missing, in every other state.
   */
  authorisePublish(): Promise<PublishGrant>
  /** Everything queued has finished (tests). */
  idle(): Promise<void>
}

export function createCloudflareConnection(options: CloudflareConnectionOptions): CloudflareConnectionService {
  const { secrets, settings } = options
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const queue = createKeyedQueue()
  const QUEUE = 'connection'

  let generation = 0
  let cancel = new AbortController()
  /** The result of the last check or operation of this generation; null until there is one. */
  let known: CloudflareStatus | null = null
  /** Whether the slot held something when `known` was set: a status is dropped when that changes. */
  let knownHas = false
  /** The accounts the token last listed: what `chooseAccount` accepts. */
  let listedAccounts: CloudflareAccount[] = []
  let busy = 0
  let lastCheckAt: number | null = null
  let checkUnderWay: { requested: number; promise: Promise<ConnectionReply> } | null = null
  let tail: Promise<unknown> = Promise.resolve()
  /** Cloudflare refused a publish with the token of this generation (see the header: the row after a refused publish). */
  let publishRefused = false

  const projectName = (): string => {
    try { return settings.read().project || DEFAULT_PAGES_PROJECT } catch { return DEFAULT_PAGES_PROJECT }
  }

  const shareDomainNow = (): string => {
    try { return hostOf(settings.read().shareDomain ?? '') } catch { return '' }
  }

  /** With no check result: what the slot and the store themselves say. */
  function unchecked(): CloudflareStatus {
    let connection: CloudflareConnection
    if (secrets.has('cloudflare-token')) connection = { state: 'checking' }
    else connection = secrets.availability().ok ? { state: 'no-token' } : { state: 'storage-unavailable', doing: 'save' }
    return { connection, publishing: unknownPublishing(projectName()), liveService: UNKNOWN_LIVE_SERVICE, shareLink: unknownShareLink(shareDomainNow()), busy: false, checkedAt: null, notice: null, details: null }
  }

  /** `own`: 1 when asked from inside a queued operation, which is itself counted in `busy`. */
  function status(own: 0 | 1 = 0): CloudflareStatus {
    // The slot can be filled or emptied from outside this module (a later ticket's command line):
    // a status never describes a token that is no longer the one in the slot.
    const base = known && secrets.has('cloudflare-token') === knownHas ? known : unchecked()
    return { ...shown(base), busy: busy - own > 0 }
  }
  /** What a window is shown: what the check found, except that a row a publish was refused on does not read Ready. */
  function shown(base: CloudflareStatus): CloudflareStatus {
    if (!publishRefused || base.connection.state !== 'connected' || base.publishing.state !== 'ready') return base
    return {
      ...base,
      publishing: { ...base.publishing, state: 'no-permission', permission: PAGES_PERMISSION },
      // "Site: found. The permission to publish is proven by the first publish" has been answered.
      details: [...(base.details ?? '').split(' · ').filter((line) => line && line !== SITE_FOUND_DETAIL), PUBLISH_REFUSED_DETAIL].join(' · '),
    }
  }

  function emit(): void {
    try { options.onChange?.(status()) } catch { /* a window that has gone is not this module's failure */ }
  }
  function set(next: CloudflareStatus | null): void {
    known = next
    knownHas = secrets.has('cloudflare-token')
    emit()
  }
  /** Replies from inside a queued operation. */
  const ok = (): ConnectionReply => ({ ok: true, status: status(1) })
  const refused = (error: string): ConnectionReply => ({ ok: false, error, status: status(1) })
  /** A refusal given without queuing anything. */
  const refusedAtOnce = (error: string): ConnectionReply => ({ ok: false, error, status: status() })

  /** One queued request: the generation it belongs to. */
  type Turn = { g: number }
  const turnNow = (): Turn => ({ g: generation })

  /**
   * THE one place the generation changes (see THE INVARIANT at the top). Requests under way are
   * cancelled and nothing asked for under an earlier generation can change anything or launch
   * anything. `by`: the turn whose own work caused it (it saved an account or a site name, or made
   * the site) carries on under the new generation and keeps what it knows. With no `by` the change
   * came from outside the queue (a token change, an edit in Settings): what was known is dropped.
   */
  function nextGeneration(by: Turn | null): Turn {
    generation += 1
    cancel.abort()
    cancel = new AbortController()
    if (by) {
      by.g = generation
      return by
    }
    known = null
    listedAccounts = []
    lastCheckAt = null
    checkUnderWay = null
    // The refusal was about the token, account and site of the generation that has just ended.
    publishRefused = false
    return turnNow()
  }
  /** Save what this turn found or was told in Settings: a change of account or site name, so a new generation. Throws when it cannot be saved. */
  function keepInSettings(by: Turn, patch: { accountId?: string; project?: string }): void {
    settings.write(patch)
    nextGeneration(by)
  }

  /** One operation at a time; `busy` covers the time it waits as well as the time it runs. */
  function turn<Result>(operation: () => Promise<Result>, failed: () => Result): Promise<Result> {
    busy += 1
    emit()
    const result = queue.run(QUEUE, operation).catch(failed).then((reply) => { busy -= 1; emit(); return reply })
    tail = result
    return result
  }
  function enqueue(operation: () => Promise<ConnectionReply>): Promise<ConnectionReply> {
    return turn(operation, () => refused('Something went wrong. Nothing was changed.'))
  }

  /** The saved token, or the state that says why there is none to use. */
  function readToken(): { token: string } | { state: CloudflareConnection; notice: string | null } {
    let token: string | null
    try {
      token = secrets.read('cloudflare-token')
    } catch (error) {
      // Secure storage cannot be reached: nothing to do but say so. A slot that is there but cannot
      // be decrypted (a user-data folder copied from another computer) is as good as empty: the
      // person pastes the token again, which replaces it.
      return error instanceof SecretsError && error.code === 'unavailable'
        ? { state: { state: 'storage-unavailable', doing: 'read' }, notice: null }
        : { state: { state: 'no-token' }, notice: UNREADABLE_TOKEN_NOTICE }
    }
    if (token === null) return { state: secrets.availability().ok ? { state: 'no-token' } : { state: 'storage-unavailable', doing: 'save' }, notice: null }
    // Its shape is checked where it is sent (`ask`): a saved token that could not travel in a header
    // is never sent, and shows as one Cloudflare did not accept.
    return { token }
  }
  const withoutToken = (read: { state: CloudflareConnection; notice: string | null }): CloudflareStatus => ({ ...unchecked(), connection: read.state, notice: read.notice })

  function port(): RequestPort {
    return { fetch: options.fetch, base: options.apiBase(), timeoutMs, cancelled: cancel.signal }
  }

  const sameSettings = (a: ConnectionSettings, b: ConnectionSettings): boolean => a.accountId === b.accountId && a.project === b.project && a.baseUrl === b.baseUrl && (a.shareDomain ?? '') === (b.shareDomain ?? '')

  /**
   * Ask Cloudflare everything the check needs and apply the answer, unless a newer generation took
   * over. Returns a fixed sentence when the check ended without a usable result, else null.
   */
  async function runCheck(mine: Turn): Promise<string | null> {
    try {
      // Settings read again at the end: answers about an account or site that Settings no longer
      // names are thrown away and asked again (a change that did not come through `settingsChanged`).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await checkOnce(mine)
        if (outcome !== 'settings-moved') return outcome
      }
      throw new Error('settings kept changing')
    } catch {
      // A port that threw (Settings could not be read, the API address not known): the spec's
      // "could not check", never a state left at "Checking…". The error itself is not read.
      if (mine.g !== generation) return null
      set(connectionCheck({ answers: { verify: noAnswer('unreachable'), accounts: noAnswer('unreachable') }, settings: { accountId: '', project: '', baseUrl: '' }, previous: known, now: now() }))
      return CHECK_FAILED_ERROR
    }
  }

  async function checkOnce(mine: Turn): Promise<string | null | 'settings-moved'> {
    const read = readToken()
    if (mine.g !== generation) return null
    if ('state' in read) {
      set(withoutToken(read))
      return null
    }
    const { token } = read
    const request = port()
    const current = settings.read()
    lastCheckAt = now()
    const [verify, listed] = await Promise.all([
      ask(request, token, 'GET', '/user/tokens/verify', pickVerify),
      listAccounts(request, token),
    ])
    if (mine.g !== generation) return null
    const accounts = listed.answer
    const answers: CheckAnswers = { verify, accounts, accountsTruncated: listed.truncated }
    const choice = resolveAccount(accounts, current.accountId, listed.truncated)
    const project = current.project || DEFAULT_PAGES_PROJECT
    // Nothing more is asked with a token neither question got an answer for (rejected, or offline).
    if (choice.kind === 'one' && (verify.kind === 'ok' || accounts.kind === 'ok')) {
      const account = encodeURIComponent(choice.account.id)
      const site = `/accounts/${account}/pages/projects/${encodeURIComponent(project)}`
      const named = validProjectName(project)
      const host = hostOf(current.baseUrl)
      const [projectAnswer, domains, workers] = await Promise.all([
        named ? ask(request, token, 'GET', site, pickProject) : undefined,
        named ? ask(request, token, 'GET', `${site}/domains`, pickDomains) : undefined,
        ask(request, token, 'GET', `/accounts/${account}/workers/scripts`, pickAnything),
      ])
      if (mine.g !== generation) return null
      answers.project = projectAnswer
      answers.domains = domains
      answers.workers = workers
      const share = hostOf(current.shareDomain ?? '')
      if (share) Object.assign(answers, await askShareLink(request, token, choice.account.id, share))
      if (mine.g !== generation) return null
    }
    if (!sameSettings(settings.read(), current)) return 'settings-moved'
    const next = connectionCheck({ answers, settings: current, previous: known, now: now() })
    if (accounts.kind === 'ok') listedAccounts = accounts.result ?? []
    // What the app found is kept, so publishing has an account and a site to use (decision D4).
    if (next.connection.state === 'connected' && next.connection.account) {
      const patch: { accountId?: string; project?: string } = {}
      if (next.connection.account.id !== current.accountId) patch.accountId = next.connection.account.id
      if (next.publishing.state === 'ready' && !current.project) patch.project = project
      if (Object.keys(patch).length) {
        try {
          keepInSettings(mine, patch)
        } catch {
          // Publishing reads the account and the site from Settings: until they are saved there it
          // is not ready, whatever Cloudflare answered.
          set({ ...next, publishing: unknownPublishing(project), notice: SETTINGS_NOT_SAVED_NOTICE })
          return SETTINGS_NOT_SAVED_NOTICE
        }
      }
    }
    set(next)
    return null
  }

  function check(reason: 'asked' | 'opened' = 'asked'): Promise<ConnectionReply> {
    if (checkUnderWay && checkUnderWay.requested === generation) return checkUnderWay.promise
    if (reason === 'opened' && lastCheckAt !== null && now() - lastCheckAt < OPEN_CHECK_INTERVAL_MS) return Promise.resolve({ ok: true, status: status() })
    const requested = generation
    const promise = enqueue(async () => {
      // A turn belongs to the generation it STARTS in: it reads the token, the account and what is
      // known afresh, so one that waited through a change acts on what is there now. One already
      // under way when a change arrives is superseded.
      const mine = turnNow()
      let failure: string | null
      try {
        failure = await runCheck(mine)
      } finally {
        if (checkUnderWay?.promise === promise) checkUnderWay = null
      }
      if (mine.g !== generation) return refused(SUPERSEDED_ERROR)
      return failure ? refused(failure) : ok()
    })
    checkUnderWay = { requested, promise }
    return promise
  }

  /** The token and the account of generation `granted`, for one launch at a time while it is the current one. */
  function authorisation(granted: number, token: string, accountId: string): LiveDeployAuthorisation {
    const current = (): boolean => granted === generation
    return {
      accountId,
      current,
      async run(launch) {
        if (!current()) return { superseded: true }
        const result = await launch({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId })
        // What a launch brought back is not handed on once the token, account or site has changed.
        return current() ? { superseded: false, result } : { superseded: true }
      },
      clean: (text) => String(text).split(token).join(TOKEN_REMOVED),
    }
  }

  return {
    status,
    check,

    saveToken(text) {
      const token = typeof text === 'string' ? text.trim() : ''
      if (!validCloudflareToken(token)) return Promise.resolve(refusedAtOnce(TOKEN_SHAPE_ERROR))
      const mine = nextGeneration(null)
      const saved = enqueue(async () => {
        if (mine.g !== generation) return refused(SUPERSEDED_ERROR)
        try {
          secrets.write('cloudflare-token', token)
        } catch (error) {
          // The earlier token, if any, is still in the slot (a write is all or nothing).
          const code = error instanceof SecretsError ? error.code : 'not-saved'
          set(code === 'unavailable' && !secrets.has('cloudflare-token') ? { ...unchecked(), connection: { state: 'storage-unavailable', doing: 'save' } } : null)
          return refused(secretsFailureMessage(code, 'cloudflare-token'))
        }
        set(null)
        return ok()
      })
      // The check follows in the queue; the reply does not wait for it. After a save that failed,
      // it is the earlier token (still in the slot) that is checked.
      void saved.then(() => { if (mine.g === generation && secrets.has('cloudflare-token')) void check() })
      return saved
    },

    chooseAccount(id) {
      return enqueue(async () => {
        const mine = turnNow()
        const account = listedAccounts.find((listed) => listed.id === id)
        if (!account) return refused(NOT_LISTED_ERROR)
        // A change of account: a new generation, so a deploy authorised for the earlier account stops.
        try { keepInSettings(mine, { accountId: account.id }) } catch { return refused(SETTINGS_NOT_SAVED_NOTICE) }
        const failure = await runCheck(mine)
        if (mine.g !== generation) return refused(SUPERSEDED_ERROR)
        return failure ? refused(failure) : ok()
      })
    },

    createSite() {
      return enqueue(async () => {
        const mine = turnNow()
        const before = known
        // Asked twice: the second finds the site made and has nothing to do.
        if (before?.connection.state === 'connected' && before.publishing.state === 'ready') return ok()
        if (!before || before.connection.state !== 'connected' || !before.connection.account || before.publishing.state !== 'no-site') return refused(NOT_NOW_ERROR)
        const read = readToken()
        if ('state' in read) { set(withoutToken(read)); return refused(NO_TOKEN_ERROR) }
        const current = settings.read()
        const project = before.publishing.project
        // The row was offered for one account and one site name. Settings must still name both, in
        // this very turn: otherwise the site would be made somewhere the person is no longer looking.
        if (current.accountId !== before.connection.account.id || (current.project || DEFAULT_PAGES_PROJECT) !== project) {
          known = null
          await runCheck(mine)
          return refused(mine.g === generation ? SETTINGS_CHANGED_ERROR : SUPERSEDED_ERROR)
        }
        if (!validProjectName(project)) return refused(SITE_NAME_NOTICE)
        set({ ...before, publishing: { ...before.publishing, state: 'creating' }, notice: null, details: null })
        const created = await ask(port(), read.token, 'POST', `/accounts/${encodeURIComponent(before.connection.account.id)}/pages/projects`, pickProject,
          { name: project, production_branch: current.productionBranch || 'main' })
        if (mine.g !== generation) return refused(SUPERSEDED_ERROR)
        const details = describe('Create site', created)
        if (created.kind === 'denied') {
          set({ ...before, publishing: { ...before.publishing, state: 'no-permission', permission: PAGES_PERMISSION }, notice: null, details })
          return ok()
        }
        // A conflict means a site of that name is already there: the check that follows finds it.
        if (created.kind !== 'ok' && created.kind !== 'conflict') {
          set({ ...before, notice: CREATE_FAILED_NOTICE, details })
          return refused(CREATE_FAILED_NOTICE)
        }
        // The site now exists: a new generation. The check that follows finds it and keeps its name in Settings.
        nextGeneration(mine)
        known = before
        const failure = await runCheck(mine)
        if (mine.g !== generation) return refused(SUPERSEDED_ERROR)
        return failure ? refused(failure) : ok()
      })
    },

    disconnect() {
      const mine = nextGeneration(null)
      return enqueue(async () => {
        if (mine.g !== generation) return refused(SUPERSEDED_ERROR)
        try {
          secrets.clear('cloudflare-token')
        } catch (error) {
          set(null)
          return refused(secretsFailureMessage(error instanceof SecretsError ? error.code : 'not-removed', 'cloudflare-token'))
        }
        set(null)
        return ok()
      })
    },

    settingsChanged() {
      nextGeneration(null)
      return check()
    },

    authoriseLiveDeploy() {
      type Granted = { ok: true; authorisation: LiveDeployAuthorisation } | { ok: false; error: string }
      const no = (error: string): Granted => ({ ok: false, error })
      return turn<Granted>(async () => {
        const mine = turnNow()
        // Nothing known is not leave: a check of this generation must have completed.
        if (!known || known.checkedAt === null) await runCheck(mine)
        if (mine.g !== generation) return no(DEPLOY_SUPERSEDED_ERROR)
        const checked = known as CloudflareStatus | null
        if (!checked || checked.connection.state === 'unreachable' || checked.connection.state === 'checking') return no(DEPLOY_NOT_CHECKED_ERROR)
        if (checked.connection.state !== 'connected' || !checked.connection.account) return no(DEPLOY_NOT_CONNECTED_ERROR)
        if (checked.checkedAt === null) return no(DEPLOY_NOT_CHECKED_ERROR)
        if (checked.liveService.state === 'no-permission') return no(`${LIVE_NO_PERMISSION}. Add the permission ${checked.liveService.permission} to the token in Settings → Cloudflare.`)
        // Token, account and verdict from the same turn: nothing else runs between these reads.
        const read = readToken()
        const accountId = checked.connection.account.id
        if ('state' in read || !validCloudflareToken(read.token) || settings.read().accountId !== accountId) return no(DEPLOY_NOT_CONNECTED_ERROR)
        return { ok: true, authorisation: authorisation(mine.g, read.token, accountId) }
      }, () => no(CHECK_FAILED_ERROR))
    },

    authorisePublish() {
      const no = (error: string, notReady?: PublishNotReady): PublishGrant => ({ ok: false, error, ...(notReady ? { notReady } : {}) })
      return turn<PublishGrant>(async () => {
        const mine = turnNow()
        // Leave is given on a completed check of this generation that found the row Ready. Anything
        // else is asked again first: offline a minute ago, or a site made since, is not today's answer.
        const ready = (status: CloudflareStatus | null): boolean => Boolean(status && status.checkedAt !== null && status.connection.state === 'connected' && status.publishing.state === 'ready' && !status.publishing.stale)
        if (!ready(known)) await runCheck(mine)
        if (mine.g !== generation) return { ok: false, error: PUBLISH_SUPERSEDED_ERROR, superseded: true }
        // What the CHECK found, not what the row shows: an earlier refused publish does not stop this one.
        const checked = (known as CloudflareStatus | null) ?? unchecked()
        const missing = checked.publishing.stale && checked.connection.state === 'connected'
          ? publishNotReady({ ...checked, connection: { state: 'unreachable', lastCheckedAt: checked.checkedAt } })
          : publishNotReady(checked)
        if (missing) return no(missing.detail ? `${missing.title}. ${missing.detail}` : missing.title, missing)
        // Token, account and site from the same turn: nothing else runs between these reads.
        const read = readToken()
        const current = settings.read()
        const account = checked.connection.state === 'connected' ? checked.connection.account : null
        const project = checked.publishing.project
        if ('state' in read || !validCloudflareToken(read.token) || !account || current.accountId !== account.id
          || (current.project || DEFAULT_PAGES_PROJECT) !== project || !validProjectName(project)) {
          return no(SETTINGS_CHANGED_PUBLISH_ERROR, { kind: 'not-ready', title: 'Publishing is not ready', detail: 'Check the connection in Settings → Cloudflare.', fix: { action: 'open-settings', label: 'Open Settings' } })
        }
        const leave = authorisation(mine.g, read.token, account.id)
        return {
          ok: true,
          authorisation: {
            ...leave,
            project,
            productionBranch: current.productionBranch || 'main',
            refusedForPermission() {
              if (!leave.current() || publishRefused) return
              publishRefused = true
              emit()
            },
            published() {
              if (!leave.current() || !publishRefused) return
              publishRefused = false
              emit()
            },
          },
        }
      }, () => no(CHECK_FAILED_ERROR))
    },

    async idle() {
      for (let settled: unknown = null; settled !== tail;) {
        settled = tail
        await tail
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
  }
}
