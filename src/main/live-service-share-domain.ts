// The share-link address at Cloudflare: the ONLY place a Workers custom domain is attached or
// removed (going live from several Macs, decisions R2 and R11).
//
// A set-up or a code update of the live service never touches a custom domain or a route
// (live-service-upload.ts plans two requests, the script and its workers.dev switch). A domain is
// attached or removed only because a person set or cleared the share-link address in Settings →
// Cloudflare (Save, the "Use share.<domain>" button, `setup cloudflare share-domain`), through ONE
// action, `changeShareAddress(ports, { wanted })`. Nothing else in this file is exported that sends.
//
// THE LIST (R11). This computer keeps, in config.json (`liveWorkerShareDomains`, through
// `ports.records`), every hostname it has asked Cloudflare to attach: `{ hostname, wanted }`, at most
// one `wanted` (the address in use). The rules:
//   - a hostname is put on the list BEFORE any attach request for it is sent, never as `wanted`. It
//     becomes `wanted` in ONE place (`want`), on proof that it is attached to this Worker's
//     production environment: an attach Cloudflare took, or a lookup read in full that shows it
//     (R13: share links are built from the `wanted` entry and from nothing else, `shareLinkBase`).
//     An answer that is lost therefore leaves it listed, and no link uses it;
//   - whenever a lookup read in full shows a listed hostname is NOT attached to this Worker (absent,
//     or held elsewhere), it stops being `wanted` BEFORE anything else is sent for it: it is marked
//     as disproved in memory at once (`disproved`, which `shareLinkBase` consults), and then the
//     list is written. If the write fails nothing further is sent, the failure is reported, and the
//     mark stands for the life of the process, so no link uses the hostname although the file still
//     says `wanted`. Every write of the list writes a marked hostname as not `wanted`, and a write
//     that was kept clears the marks. A lookup that failed, was not answered, or could not be read
//     in full is no evidence either way: nothing is changed and nothing is sent;
//   - an entry leaves the list only on PROOF: its removal was taken by Cloudflare (or answered "not
//     found"), or a lookup of exactly that hostname answered and shows it is not attached to this
//     Worker. A request that failed, or was not answered, proves nothing and removes nothing; nor
//     does a lookup whose record for that hostname cannot be read in full (R14: unknown, not absent);
//   - after an attach attempt that did not clearly succeed, the hostname is looked up: attached to
//     this Worker is success; shown not attached to it takes it off the list (and the refusal is
//     reported); a lookup that failed leaves it listed;
//   - once the address set is attached it becomes the `wanted` one, and every OTHER entry is
//     detached: a lookup of that hostname on this Worker, then the removal of exactly that record.
//     One that could not be detached stays listed, the answer is SHARE_DOMAIN_OLD_NOT_REMOVED, and
//     the next Save tries every such entry again;
//   - clearing detaches every entry by the same rule; what could not be detached stays listed and
//     is tried again by the next Save or clear. An entry stops being `wanted` BEFORE its removal is
//     sent (not saved: not sent), so no link is built on an address that is being taken away;
//   - a change Cloudflare took that the list could not then record is reported (R15), with
//     `changed: true`, and the next Save finishes it from a lookup, with no request repeated.
// What is never done: no hostname is detached that is not on this computer's list (`detach` checks
// the list itself before it sends); no list of the account's domains decides a removal (a lookup is
// asked for one hostname, and only an entry with exactly that hostname, on this Worker's production
// environment, is ever removed); no attach displaces another Worker's domain, another origin or an
// existing DNS record (every override is sent false, so Cloudflare refuses instead).
//
// Before the list there were two fields, `liveWorkerShareDomain` (the one hostname recorded) and
// `liveWorkerShareDomainPrevious` (one whose removal had failed). `shareDomainEntries` reads them as
// a `wanted` entry and one that is not, and the first write of the list removes both.
//
// Failures are fixed sentences; Details are numbers (the HTTP status and Cloudflare's error codes),
// never text from a reply. No secret is involved: the token goes in its header through the
// connection's authorisation and nowhere else.
//
// No Electron import and erasable TypeScript only: scripts/test-live-service-upload.mjs drives it.
import { DEPLOY_SUPERSEDED_ERROR, send, type Answer, type DeployCredentials, type LiveDeployAuthorisation, type OutgoingRequest } from './cloudflare-connection.ts'
import { validAccountSegment, validDomainId } from './live-service-upload.ts'
import { isValidShareDomain } from '../shared/shared-talk.ts'

export const SHARE_DOMAIN_NOT_ATTACHED = 'The share-link address could not be attached.'
export const SHARE_DOMAIN_NOT_REMOVED = 'The share-link address could not be removed.'
/** Something at Cloudflare already holds the hostname (another Worker, or a record of its own). */
export const SHARE_DOMAIN_IN_USE = 'That address is already in use on Cloudflare, so it was not attached. Nothing was changed.'
/** A change of address whose new address is attached and whose old one is still attached too. */
export const SHARE_DOMAIN_OLD_NOT_REMOVED = 'The new share-link address is attached and works. The old address could not be removed from Cloudflare, so it is still attached. Save the address again to try removing it.'
/** Cloudflare attached the address set, and the list could not record it as the one in use (R15). Nothing else was changed; links stay as they were. */
export const SHARE_DOMAIN_ATTACHED_NOT_SAVED = 'The new share-link address is attached on Cloudflare, but this computer could not save the change. Save the address again to finish.'
/** Cloudflare removed (or no longer has) an address, and the list could not record that (R15). */
export const SHARE_DOMAIN_REMOVED_NOT_SAVED = 'The share-link address was removed from Cloudflare, but this computer could not save the change. Save again to finish.'
export const SHARE_DOMAIN_REQUEST_MS = 30_000

/** One hostname this computer asked Cloudflare to attach. `wanted`: it is the share-link address in use (at most one is). */
export type ShareDomainEntry = { hostname: string; wanted: boolean }
/** What config.json holds of it: the list, and the two fields kept before there was one. No value is trusted as it is. */
export type ShareDomainRecords = { liveWorkerShareDomains?: unknown; liveWorkerShareDomain?: unknown; liveWorkerShareDomainPrevious?: unknown }

const listable = (hostname: unknown): hostname is string => typeof hostname === 'string' && isValidShareDomain(hostname) && hostname === hostname.trim().toLowerCase()
/**
 * The list as config.json holds it. Every hostname of the list and of the two earlier fields is kept,
 * once each; at most one is `wanted` (the list's own first; else the earlier `liveWorkerShareDomain`).
 * A value that is not a hostname could never be sent and is left out. `old`: an earlier field is
 * still there (the next write of the list removes it).
 */
export function shareDomainEntries(records: ShareDomainRecords): { entries: ShareDomainEntry[]; old: boolean } {
  const entries: ShareDomainEntry[] = []
  const add = (hostname: unknown, wanted: boolean): void => {
    if (!listable(hostname) || entries.some((entry) => entry.hostname === hostname)) return
    entries.push({ hostname, wanted: wanted && !entries.some((entry) => entry.wanted) })
  }
  if (Array.isArray(records.liveWorkerShareDomains)) {
    for (const entry of records.liveWorkerShareDomains.slice(0, 1000)) {
      const { hostname, wanted } = (entry ?? {}) as { hostname?: unknown; wanted?: unknown }
      add(hostname, wanted === true)
    }
  }
  add(records.liveWorkerShareDomain, true)
  add(records.liveWorkerShareDomainPrevious, false)
  return { entries, old: records.liveWorkerShareDomain !== undefined || records.liveWorkerShareDomainPrevious !== undefined }
}

/**
 * Hostnames a lookup read in full (or a removal Cloudflare took) showed NOT attached to this Worker,
 * while the list in config.json may still say `wanted` because it could not be written since. No
 * link is built on one. Emptied by the next write of the list that was kept (which writes each of
 * them as not `wanted`); a hostname leaves it too on proof that it is attached after all.
 */
const disproved = new Set<string>()

/**
 * THE link base (R13): what a share link, a Run's results link, or any other link on the share-link
 * address is built from. The `wanted` entry of this computer's list, which is `wanted` only once
 * Cloudflare has shown it attached to this Worker, and is passed over once Cloudflare has shown it
 * is not (`disproved`); with none, undefined, and links use the live
 * service's own workers.dev address. The address typed in Settings (`sharedTalkLinkBase`) is the
 * person's request and is never read to build a link.
 */
export function shareLinkBase(records: ShareDomainRecords): string | undefined {
  const inUse = shareDomainEntries(records).entries.find((entry) => entry.wanted && !disproved.has(entry.hostname))
  return inUse ? `https://${inUse.hostname}` : undefined
}

export interface ShareDomainPorts {
  authorise(): Promise<{ ok: true; authorisation: LiveDeployAuthorisation } | { ok: false; error: string }>
  /** Requests to Cloudflare's API. */
  fetch: typeof fetch
  apiBase(): string
  /** The live service's Worker name. */
  workerName: string
  /**
   * config.json's record of the hostnames this computer asked Cloudflare to attach. `read`: the list
   * field and the two earlier fields, as they are. `write`: the list replaces the list field, and the
   * two earlier fields are removed; it throws when it could not be kept (then nothing is sent).
   */
  records: { read(): ShareDomainRecords; write(entries: ShareDomainEntry[]): void }
  timeoutMs?: number
}

export type ShareDomainResult =
  /** `changed`: a request that changes Cloudflare was sent and taken. False: it was already so, and nothing was sent but lookups. */
  | { ok: true; changed: boolean }
  /** `changed: true`: a request that changes Cloudflare was taken before the failure (an address was attached or removed). */
  | { ok: false; error: string; details?: string; changed?: true }

type Listed = { id: unknown; hostname: unknown; service: unknown; environment: unknown }
function pickListed(result: unknown): Listed[] | null {
  // A reply longer than any real one is not read in part: it is no answer.
  if (!Array.isArray(result) || result.length > 1000) return null
  return result.map((entry) => {
    const { id, hostname, service, environment } = (entry ?? {}) as { id?: unknown; hostname?: unknown; service?: unknown; environment?: unknown }
    return { id, hostname, service, environment }
  })
}
/**
 * What ONE lookup's reply shows about ONE hostname and this Worker (R14).
 *   `ids`        the records for it on this Worker's production environment that have a usable id:
 *                proof that it is attached here, and the only records ever removed;
 *   `elsewhere`  a readable record for it that is not on this Worker's production environment;
 *   `unreadable` a record that is, or may be, for this hostname could not be read in full (no
 *                hostname, no service, this Worker with no environment, or this Worker's production
 *                environment with an id that is not one). Such a record is never removed, and while
 *                there is one the reply is not proof that the hostname is absent from this Worker.
 */
type Holding = { ids: string[]; elsewhere: boolean; unreadable: boolean }
function holding(records: Listed[], hostname: string, workerName: string): Holding {
  const found: Holding = { ids: [], elsewhere: false, unreadable: false }
  for (const record of records) {
    if (typeof record.hostname !== 'string') { found.unreadable = true; continue }
    if (record.hostname.toLowerCase() !== hostname) continue
    if (typeof record.service !== 'string') found.unreadable = true
    else if (record.service !== workerName) found.elsewhere = true
    else if (typeof record.environment !== 'string') found.unreadable = true
    else if (record.environment !== 'production') found.elsewhere = true
    else if (!validDomainId(record.id)) found.unreadable = true
    else found.ids.push(record.id)
  }
  return found
}
/** The Details of a lookup that answered and could not be read in full (R14). */
export const SHARE_DOMAIN_LOOKUP_INCOMPLETE = 'Looking up the share-link address: Cloudflare\'s answer could not be read in full.'
const pickAny = (): true => true
const WORKER_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/

function numbers(step: string, answer: Answer<unknown>): string {
  const what = answer.http === null ? 'Cloudflare could not be reached or did not answer in time' : `Cloudflare answered ${answer.http}${answer.codes.length ? ` (error ${answer.codes.join(', ')})` : ''}`
  return `${step}: ${what}.`
}

type Begun =
  | { ok: false; result: ShareDomainResult }
  | { ok: true; accountId: string; request: <Result>(outgoing: OutgoingRequest, pick: (result: unknown) => Result | null) => Promise<Answer<Result> | null>; current(): boolean }

async function begin(ports: ShareDomainPorts, hostname: string, sentence: string): Promise<Begun> {
  if (!isValidShareDomain(hostname) || hostname !== hostname.trim().toLowerCase() || !WORKER_NAME.test(ports.workerName)) return { ok: false, result: { ok: false, error: sentence } }
  const authorised = await ports.authorise()
  if (!authorised.ok) return { ok: false, result: { ok: false, error: authorised.error } }
  const { authorisation } = authorised
  if (!authorisation.current()) return { ok: false, result: { ok: false, error: DEPLOY_SUPERSEDED_ERROR } }
  const accountId = authorisation.accountId
  if (!validAccountSegment(accountId)) return { ok: false, result: { ok: false, error: sentence } }
  const never = new AbortController().signal
  const timeoutMs = ports.timeoutMs ?? SHARE_DOMAIN_REQUEST_MS
  return {
    ok: true, accountId, current: () => authorisation.current(),
    async request(outgoing, pick) {
      const ran = await authorisation.run((credentials: DeployCredentials) => send({ fetch: ports.fetch, base: ports.apiBase(), timeoutMs, cancelled: never }, credentials.CLOUDFLARE_API_TOKEN, outgoing, pick))
      return ran.superseded || !authorisation.current() ? null : ran.result
    },
  }
}
const superseded: ShareDomainResult = { ok: false, error: DEPLOY_SUPERSEDED_ERROR }
const lookupPath = (accountId: string, hostname: string): string => `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(hostname)}`


/**
 * The list, read from config.json each time and written whole. What is read, and what is written,
 * never has a `disproved` hostname as the `wanted` one. A change answers true only when it was kept
 * (written, and read again as written); only then are the marks cleared.
 */
function listOf(ports: ShareDomainPorts) {
  const read = (): ShareDomainEntry[] => shareDomainEntries(ports.records.read()).entries.map((entry) => (entry.wanted && disproved.has(entry.hostname) ? { hostname: entry.hostname, wanted: false } : entry))
  const same = (a: ShareDomainEntry[], b: ShareDomainEntry[]): boolean => a.length === b.length && a.every((entry, index) => entry.hostname === b[index].hostname && entry.wanted === b[index].wanted)
  const change = (next: (entries: ShareDomainEntry[]) => ShareDomainEntry[]): boolean => {
    try {
      const entries = next(read())
      ports.records.write(entries)
      const kept = shareDomainEntries(ports.records.read())
      if (kept.old || !same(kept.entries, entries)) return false
      disproved.clear()
      return true
    } catch { return false }
  }
  return {
    read,
    has: (hostname: string): boolean => read().some((entry) => entry.hostname === hostname),
    wanted: (hostname: string): boolean => read().some((entry) => entry.hostname === hostname && entry.wanted),
    /** Shown NOT attached to this Worker: no link uses it from this moment, whatever can be written afterwards. */
    disprove(hostname: string): void { disproved.add(hostname) },
    /** On the list and not `wanted`: before its attach is sent (nothing has shown it attached yet), and before its removal is sent. */
    unwanted: (hostname: string): boolean => change((entries) => (entries.some((entry) => entry.hostname === hostname)
      ? entries.map((entry) => (entry.hostname === hostname ? { hostname, wanted: false } : entry))
      : [...entries, { hostname, wanted: false }])),
    /** THE one place `wanted` is set: `hostname` is attached to this Worker, as Cloudflare showed. No other entry is `wanted` then. */
    want(hostname: string): boolean {
      disproved.delete(hostname)
      return change((entries) => [
        ...entries,
        ...(entries.some((entry) => entry.hostname === hostname) ? [] : [{ hostname, wanted: true }]),
      ].map((entry) => ({ hostname: entry.hostname, wanted: entry.hostname === hostname })))
    },
    /** Off the list: only ever called on proof that it is not attached to this Worker. */
    drop: (hostname: string): boolean => change((entries) => entries.filter((entry) => entry.hostname !== hostname)),
    /** The two earlier fields become entries, once. */
    migrate(): void { try { if (shareDomainEntries(ports.records.read()).old) ports.records.write(read()) } catch { /* read as before, and tried again by the next run */ } },
  }
}
type List = ReturnType<typeof listOf>
const NOT_RECORDED = 'Recording the share-link address: Settings could not be saved.'

/**
 * THE share-address action (R2, R11). `wanted`: the address set in Settings now (null: none).
 *   set        looked up; attached if nothing holds it (listed first); once attached it is the
 *              `wanted` entry, and every other entry of this computer's list is then detached;
 *   refused    (something else holds it, or the attach failed and a lookup shows it is not on this
 *              Worker): nothing is detached, and the entries that were listed stay as they were;
 *   cleared    every entry of the list is detached. With nothing listed, clearing asks nothing and
 *              removes nothing, whatever the Worker has attached.
 * An entry that could not be detached stays listed and is tried again by the next run.
 */
export async function changeShareAddress(ports: ShareDomainPorts, now: { wanted: string | null }): Promise<ShareDomainResult> {
  const { wanted } = now
  const list = listOf(ports)
  list.migrate()
  let changed = false
  if (wanted) {
    const attached = await attach(ports, list, wanted)
    if (!attached.ok) return attached
    changed = attached.changed
  }
  // Every other hostname this computer asked for: detached now, each by its own lookup and removal.
  let failure: ShareDomainResult | null = null
  let unsaved = false
  for (const { hostname } of list.read()) {
    if (hostname === wanted) continue
    const removed = await detach(ports, list, hostname)
    if (removed.ok) { changed ||= removed.changed; continue }
    if (removed.error === DEPLOY_SUPERSEDED_ERROR) return removed
    if (removed.changed) changed = true
    // Shown gone, and the list could not record it (R15): it stays listed, and the next Save drops it after one lookup.
    if (removed.error === SHARE_DOMAIN_REMOVED_NOT_SAVED) { unsaved = true; continue }
    // It stays listed. The others are still tried; the first failure is the one reported.
    failure ??= removed
  }
  if (failure && !failure.ok) return { ok: false, error: wanted ? SHARE_DOMAIN_OLD_NOT_REMOVED : SHARE_DOMAIN_NOT_REMOVED, ...(failure.details ? { details: failure.details } : {}), ...(changed ? { changed } : {}) }
  if (unsaved) return { ok: false, error: SHARE_DOMAIN_REMOVED_NOT_SAVED, details: NOT_RECORDED, ...(changed ? { changed } : {}) }
  return { ok: true, changed }
}

/**
 * Attach ONE hostname to the live service as its custom domain. Sent only when a lookup of that
 * hostname shows nothing holds it; with the hostname on this computer's list, not `wanted`, before
 * it is sent; and with every override off, so that if something does hold it after all, Cloudflare
 * refuses and nothing is displaced. Already attached to this Worker: nothing is sent. An attach that
 * did not clearly succeed is followed by a lookup of the hostname, which alone decides (R11).
 * The same for a hostname that is already the `wanted` one: the lookup comes first, and one that
 * failed or could not be read changes nothing and sends nothing (it stays `wanted`: no evidence
 * against it).
 */
async function attach(ports: ShareDomainPorts, list: List, hostname: string): Promise<ShareDomainResult> {
  const begun = await begin(ports, hostname, SHARE_DOMAIN_NOT_ATTACHED)
  if (!begun.ok) return begun.result
  const { accountId, request } = begun
  /** Attached, as Cloudflare shows it: the one in use from now on. Not recorded (R15): said so, and nothing more is done by this run. */
  const inUse = (sent: boolean): ShareDomainResult => (list.want(hostname)
    ? { ok: true, changed: sent }
    : { ok: false, error: SHARE_DOMAIN_ATTACHED_NOT_SAVED, details: NOT_RECORDED, ...(sent ? { changed: true as const } : {}) })
  const listed = await request({ method: 'GET', path: lookupPath(accountId, hostname) }, pickListed)
  if (!listed) return superseded
  if (listed.kind !== 'ok' || !listed.result) return { ok: false, error: SHARE_DOMAIN_NOT_ATTACHED, details: numbers('Looking up the share-link address', listed) }
  // Whatever the reply holds, only records for exactly this hostname decide; one of them that cannot be read decides nothing (R14).
  const before = holding(listed.result, hostname, ports.workerName)
  if (before.ids.length > 0) return inUse(false)
  if (before.unreadable) return { ok: false, error: SHARE_DOMAIN_NOT_ATTACHED, details: SHARE_DOMAIN_LOOKUP_INCOMPLETE }
  // Read in full, and not attached to this Worker: no link uses it from here, before anything else is done.
  list.disprove(hostname)
  if (before.elsewhere) {
    // Something else holds it: it is not this computer's to remember. A drop that could not be kept is said; the mark stands.
    const dropped = !list.has(hostname) || list.drop(hostname)
    return { ok: false, error: SHARE_DOMAIN_IN_USE, ...(dropped ? {} : { details: NOT_RECORDED }) }
  }
  // The list first, with the hostname not `wanted`: from here on the domain may be attached, whatever happens next. Not kept: not sent.
  if (!list.unwanted(hostname)) return { ok: false, error: SHARE_DOMAIN_NOT_ATTACHED, details: NOT_RECORDED }
  if (!begun.current()) return superseded
  const attached = await request({
    method: 'PUT', path: `/accounts/${accountId}/workers/scripts/${ports.workerName}/domains/records`, contentType: 'application/json',
    body: JSON.stringify({ override_scope: false, override_existing_origin: false, override_existing_dns_record: false, origins: [{ hostname }] }),
  }, pickAny)
  if (!attached) return superseded
  if (attached.kind === 'ok') return inUse(true)
  // Not a clear success (refused, failed, or no answer): Cloudflare may have attached it all the same. Ask.
  const refusal: ShareDomainResult = { ok: false, error: attached.http === 409 ? SHARE_DOMAIN_IN_USE : SHARE_DOMAIN_NOT_ATTACHED, details: numbers('Attaching the share-link address', attached) }
  const after = await request({ method: 'GET', path: lookupPath(accountId, hostname) }, pickListed)
  if (!after) return superseded
  // The lookup failed: nothing is known, so the hostname stays listed (not `wanted`).
  if (after.kind !== 'ok' || !after.result) return refusal
  const now = holding(after.result, hostname, ports.workerName)
  // It is attached: the answer was lost, not the attach.
  if (now.ids.length > 0) return inUse(true)
  // Its record could not be read in full: nothing is known (R14), so it stays listed (not `wanted`), and that is what is said.
  if (now.unreadable) return { ok: false, error: SHARE_DOMAIN_NOT_ATTACHED, details: SHARE_DOMAIN_LOOKUP_INCOMPLETE }
  // Shown not attached to this Worker (absent, or held elsewhere): off the list.
  list.disprove(hostname)
  list.drop(hostname)
  return now.elsewhere ? { ...refusal, error: SHARE_DOMAIN_IN_USE } : refusal
}

/**
 * Remove ONE hostname from the live service, and only one that is on this computer's list. One
 * lookup, of that hostname on this Worker; only an entry with exactly that hostname, on this Worker's
 * production environment, is removed. The hostname leaves the list only when the lookup shows it is
 * not there, or its removal was taken (or answered "not found"). A hostname the lookup shows absent
 * needs no id: it is no link's base from that moment, and it is dropped.
 */
async function detach(ports: ShareDomainPorts, list: List, hostname: string): Promise<ShareDomainResult> {
  // Never a hostname this computer did not ask Cloudflare to attach.
  if (!list.has(hostname)) return { ok: false, error: SHARE_DOMAIN_NOT_REMOVED }
  const begun = await begin(ports, hostname, SHARE_DOMAIN_NOT_REMOVED)
  if (!begun.ok) return begun.result
  const { accountId, request } = begun
  const listed = await request({ method: 'GET', path: `${lookupPath(accountId, hostname)}&service=${ports.workerName}&environment=production` }, pickListed)
  if (!listed) return superseded
  if (listed.kind !== 'ok' || !listed.result) return { ok: false, error: SHARE_DOMAIN_NOT_REMOVED, details: numbers('Looking up the share-link address', listed) }
  const found = holding(listed.result, hostname, ports.workerName)
  // Only records read in full as this Worker's production entry for exactly this hostname are removed.
  const { ids } = found
  // Read in full, and not on this Worker: no link uses it from here, whether or not the drop below can be kept.
  if (ids.length === 0 && !found.unreadable) list.disprove(hostname)
  // No link is built on an address that is being taken away: it stops being the one in use first. Not kept: not sent.
  if (ids.length > 0 && list.wanted(hostname) && !list.unwanted(hostname)) return { ok: false, error: SHARE_DOMAIN_NOT_REMOVED, details: NOT_RECORDED }
  let sent = false
  for (const id of ids) {
    const removed = await request({ method: 'DELETE', path: `/accounts/${accountId}/workers/domains/${id}` }, pickAny)
    if (!removed) return superseded
    // Already gone is what was wanted.
    if (removed.kind !== 'ok' && removed.kind !== 'missing') return { ok: false, error: SHARE_DOMAIN_NOT_REMOVED, details: numbers('Removing the share-link address', removed), ...(sent ? { changed: true as const } : {}) }
    sent = true
  }
  // A record for it that could not be read in full (R14) is not removed, and is not proof that the hostname is gone: it stays listed.
  if (found.unreadable) return { ok: false, error: SHARE_DOMAIN_NOT_REMOVED, details: SHARE_DOMAIN_LOOKUP_INCOMPLETE, ...(sent ? { changed: true as const } : {}) }
  // Shown not attached to this Worker, or removed: off the list. Not recorded (R15): said so; the next Save looks it up and drops it.
  if (!list.drop(hostname)) return { ok: false, error: SHARE_DOMAIN_REMOVED_NOT_SAVED, details: NOT_RECORDED, ...(sent ? { changed: true as const } : {}) }
  return { ok: true, changed: sent }
}
