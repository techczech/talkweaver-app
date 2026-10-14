// Going live and sharing: whether there is a live service to use, what to do before using it, and
// the Settings row that says so (spec docs/plans/cloudflare-setup-in-app, D7, D8, D9, D12, ticket 05;
// spec docs/plans/going-live-from-several-macs, states S1 to S8, ticket 02).
//
// Three layers, the seams the tests drive:
//   computerState(inputs)             PURE. Which of the spec's states S1 to S8 this computer is in,
//                                     from five explicit inputs: whether Cloudflare has the Worker,
//                                     which account Settings recorded it for, the key held here, what
//                                     the live service said of that key, and the build it answers as.
//   ensureLiveService(facts, intent)  PURE. From the connection, that state, what Settings records as
//                                     deployed and this app's build, to the ONE action to take and
//                                     the row to show. Every state of the row comes from here.
//   createLiveService(ports)          the service: it reads the facts, takes the action (one set-up or
//                                     update at a time; a second caller joins the first), keeps what
//                                     the last set-up came to and what Cloudflare and the live service
//                                     last said, and tells the windows.
//
// The states (spec, "States"):
//   S1  no Worker in the account                          Not set up · Set up going live
//   S2  Worker, the 0.38.2 key held here                  Ready
//   S3  Worker, no key here                               Set up on another computer · Set up going live on this computer
//   S4  Worker, this computer's own key, accepted         Ready · this computer and N others
//   S5  Worker, a key here that it refuses (401)          This computer's access was removed · Set up going live on this computer
//   S6  as S3, and the Worker is an older build           as S3; set-up updates the code first and sends no secret with it
//   S7  the Worker Settings records is in another account unchanged from 0.38.2
//   S8  Settings records an address, Cloudflare has none  unchanged from 0.38.2
//
// The decision (intent `use`: Go live, Share for comments, a share or pre-work link, a publish;
// intent `set-up`: the row's button in Settings, Try again):
//
//   Facts                                             | row              | use              | set-up
//   --------------------------------------------------|------------------|------------------|-----------
//   a set-up or update under way                      | setting-up /     | wait for it      | wait for it
//                                                     | updating         |                  |
//   no working connection (no token, rejected, choose | unknown          | use it if one is | stop: not
//     an account, storage)                            |                  | recorded with a  | connected
//                                                     |                  | key; else "not   |
//                                                     |                  | set up · Open    |
//                                                     |                  | Settings"        |
//   the token cannot run the live service (the check, | no-permission    | use what is      | stop
//     or a set-up Cloudflare refused)                 |                  | deployed (with   |
//                                                     |                  | its key), else   |
//                                                     |                  | stop             |
//   S1, S7, S8                                        | not-set-up       | "not set up ·    | set up
//                                                     | (failed after a  | Open Settings";  |
//                                                     |  failed set-up)  | S7 with a key is |
//                                                     |                  | used as it is    |
//   S3, S6                                            | set-up-elsewhere | "not set up ·    | set up (adds
//                                                     |                  | Open Settings"   | this computer)
//   S5                                                | access-removed   | "access was      | set up (adds
//                                                     |                  | removed"         | this computer)
//   S2, S4, an older build recorded than this app's   | ready (says the  | update first,    | update
//                                                     | update is due)   | then use         |
//   S2, S4, this build                                | ready            | look it up at    | look it up
//                                                     |                  | Cloudflare (for  |
//                                                     |                  | the recorded     |
//                                                     |                  | account), then   |
//                                                     |                  | use; with no     |
//                                                     |                  | account recorded:|
//                                                     |                  | use as it is     |
//
// INVARIANTS.
//   - Nothing is set up on a use: a first set-up, and adding this computer to a live service set up
//     on another, are always asked for (D9: "set up on purpose"). A publish with no live service
//     publishes without it (D7). An update of a service already in use from here IS done on a use,
//     once, and the person is told; it sends no secret.
//   - Nothing here resets anything. A computer without a key adds its own; the keys other computers
//     hold, and everything made with them, are untouched.
//   - A live service that does not answer is never taken as a refusal: only its 401 to this
//     computer's key (seen twice) reads "access was removed".
//   - An address recorded for the account in use is looked up at Cloudflare before it is handed out
//     (published pages, Go live, shares) whenever the connection can: a Worker deleted in the
//     dashboard is found missing, its record is dropped and the row reads Not set up. With no way to
//     look (offline, or a token that may not read Workers) it is used as it is, as before.
//   - A key slot that cannot be read is not "no key": the row says so, and nothing is set up, used or sent.
//   - No secret is in a row, a reason, Details, or a thrown error: the key stays with the ports.
//
// No Electron import and erasable TypeScript only: scripts/test-going-live-row.mjs and
// scripts/test-live-service-keys.mjs import it as it is.
import { DEPLOY_NOT_CONNECTED_ERROR, DEPLOY_SUPERSEDED_ERROR } from './cloudflare-connection.ts'
import { LIVE_ACCESS_REMOVED, LIVE_KEY_UNREADABLE, LIVE_NOT_SET_UP, LIVE_SETUP_FAILED, LIVE_SETUP_REFUSED, LiveServiceError, type DeployPhase, type LiveDeployResult, type LiveSurvey } from './live-service-deploy.ts'
import { uploadDecision, type KeyKind } from './live-service-key.ts'
import { WORKERS_PERMISSION } from '../shared/cloudflare-status.ts'
import { LIVE_SETTING_UP_NOTICE, LIVE_UPDATING_NOTICE, unknownGoingLive, type GoingLiveRow, type LiveSetupPrompt } from '../shared/live-service-status.ts'

/** What a set-up or update last came to, kept until it no longer describes the connection in use. */
export type LastOutcome =
  | { outcome: 'failed'; reason: string; details: string | null }
  /** Cloudflare refused the deploy for permission: the token cannot run the live service. */
  | { outcome: 'refused'; details: string | null }
  /** A lookup found no Worker where Settings recorded one: its record was dropped. */
  | { outcome: 'not-found' }

export type LiveServiceFacts = {
  /** `not-connected`: no token, a rejected one, an account to choose, no storage. `not-checked`: checking, or Cloudflare not answering. */
  connection: 'not-connected' | 'not-checked' | 'connected'
  /** What the connection check found about the live-service permission. */
  permission: 'unknown' | 'not-refused' | 'no-permission'
  /** The account the connection uses, or null. */
  accountId: string | null
  /**
   * The key this computer holds FOR THE LIVE SERVICE IN QUESTION (the recorded one; with none recorded,
   * the account in use): none, the 0.38.2 one, or its own. `unreadable`: the slot cannot be read,
   * which is not "none" (R4).
   */
  key: KeyKind | 'unreadable'
  /** What Settings records as deployed: the address, the build deployed there, the account it was deployed for. */
  deployed: { baseUrl: string | null; version: string | null; accountId: string | null }
  /** LIVE_WORKER_BUILD of this app. */
  appBuild: string
  underway: null | { kind: 'set-up' | 'update'; phase: 'checking' | DeployPhase }
  last: LastOutcome | null
  /** What Cloudflare and the live service last said (a survey, or a set-up that went through); null when not asked. */
  seen: LiveSurvey | null
}

// ── The states S1 to S8 ─────────────────────────────────────────────────────────────────────────

export type ComputerState = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8'

export type ComputerInputs = {
  /** Cloudflare's answer for the account in use: is the Worker there? `unknown`: not asked, or no answer. */
  worker: 'present' | 'absent' | 'unknown'
  /** Whether Settings records a live service's address, and for which account: the one in use, or another. */
  recorded: 'none' | 'this-account' | 'other-account'
  /** The key held on this computer. */
  key: KeyKind
  /** What the live service said of that key: accepted (200), refused (401), or `unknown` (not asked, no key, or it did not answer). */
  answer: 'accepted' | 'refused' | 'unknown'
  /** The build the live service answers as (`GET /capabilities`), or null when it gave none. */
  workerBuild: string | null
  /** The build this TalkWeaver carries. */
  appBuild: string
}

/**
 * THE state of this computer (spec, "States"). Pure, and total: every combination of inputs is one
 * of the eight.
 *   - S7 and S8 are about what Settings records, so they come first, as in 0.38.2.
 *   - With no Worker known and nothing recorded there is nothing to join: S1.
 *   - "Set up here" means Settings records the address for this account: it is written only when a
 *     set-up finished with the key accepted. A key held without that record was stored by a set-up
 *     that did not finish, so the computer is still to be set up (S3 or S6), whatever the answer.
 *   - A refusal is only ever the live service's own 401. No answer leaves a computer that is set up
 *     as it was (S2 or S4): unreachable is not removed.
 */
export function computerState(inputs: ComputerInputs): ComputerState {
  const { worker, recorded, key, answer, workerBuild, appBuild } = inputs
  if (recorded === 'other-account') return 'S7'
  if (worker === 'absent') return recorded === 'this-account' ? 'S8' : 'S1'
  if (worker === 'unknown' && recorded === 'none') return 'S1'
  const toSetUp: ComputerState = uploadDecision(workerBuild, appBuild) === 'upload' ? 'S6' : 'S3'
  if (key === 'none' || recorded !== 'this-account') return toSetUp
  if (answer === 'refused') return 'S5'
  return key === 'legacy' ? 'S2' : 'S4'
}

export type LiveIntent = 'use' | 'set-up'

export type LiveAction =
  | { kind: 'wait' }
  /** Use the recorded address as it is. */
  | { kind: 'use' }
  /**
   * Look the recorded address up at Cloudflare (the recorded account), then use it. `strict`: after
   * a failed update, the address is used only if the lookup FINDS the Worker (absent or unanswered:
   * no address); otherwise an unanswered lookup leaves it in use as it is.
   */
  | { kind: 'look-up'; strict?: true }
  /** Redeploy this build with the stored keys, then use it. */
  | { kind: 'update' }
  /** The first set-up, or one into this account. */
  | { kind: 'set-up' }
  /** No live service to use: a fixed sentence, and what Go live and Share for comments offer. */
  | { kind: 'not-set-up'; message: string; prompt: LiveSetupPrompt | null; reason: 'failed' | 'not-set-up' }
  /** Stop with a fixed sentence: nothing is deployed and nothing is used. */
  | { kind: 'stop'; message: string }

export type LiveDecision = { action: LiveAction; row: GoingLiveRow }

/** A recorded address that can be used at all: an https or http address. */
function addressOf(value: string | null): string | null {
  if (!value) return null
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? value : null } catch { return null }
}

/**
 * THE decision (the table at the top). Pure: no clock, no network, no settings, no secret.
 */
export function ensureLiveService(facts: LiveServiceFacts, intent: LiveIntent): LiveDecision {
  const { connection, permission, accountId, deployed, appBuild, underway, last, seen } = facts
  const address = addressOf(deployed.baseUrl)
  const base = unknownGoingLive(appBuild)
  const row = (state: GoingLiveRow['state'], extra: Partial<GoingLiveRow> = {}): GoingLiveRow => ({
    ...base, address, build: address ? deployed.version : null,
    details: address ? `Live service build ${deployed.version ?? 'not recorded'} at ${address}${deployed.version !== appBuild ? ` · this TalkWeaver carries build ${appBuild}` : ''}` : null,
    state, ...extra,
  })
  const decide = (action: LiveAction, shown: GoingLiveRow): LiveDecision => ({ action, row: shown })

  if (underway) return decide({ kind: 'wait' }, row(underway.kind === 'update' ? 'updating' : 'setting-up', { phase: underway.phase }))

  // The slot that holds this computer's keys cannot be read (R4): said so, and nothing is used. Try
  // again runs the set-up, which reads the slot first and sends nothing while it cannot.
  if (facts.key === 'unreadable') {
    const shown = row('failed', { address: null, build: null, reason: LIVE_KEY_UNREADABLE, details: null })
    if (intent === 'set-up') return decide(connection === 'not-connected' ? { kind: 'stop', message: DEPLOY_NOT_CONNECTED_ERROR } : { kind: 'set-up' }, shown)
    return decide({ kind: 'not-set-up', message: LIVE_KEY_UNREADABLE, prompt: 'open-settings', reason: 'failed' }, shown)
  }
  const key: KeyKind = facts.key

  // Deployed for an account the connection is not on (when both are known): not this connection's service.
  const otherAccount = Boolean(address && deployed.accountId && accountId && deployed.accountId !== accountId)
  const here = Boolean(address) && !otherAccount
  const held = key !== 'none'
  const connected = connection === 'connected'
  const refused = permission === 'no-permission' || last?.outcome === 'refused'
  const noPermissionRow = (): GoingLiveRow => row('no-permission', { permission: WORKERS_PERMISSION, details: last?.outcome === 'refused' ? last.details : row('no-permission').details })
  const notSetUp = (prompt: LiveSetupPrompt): LiveAction => (last?.outcome === 'failed'
    ? { kind: 'not-set-up', message: last.reason, prompt, reason: 'failed' }
    : { kind: 'not-set-up', message: LIVE_NOT_SET_UP, prompt, reason: 'not-set-up' })

  if (connection === 'not-connected') {
    if (intent === 'set-up') return decide({ kind: 'stop', message: DEPLOY_NOT_CONNECTED_ERROR }, base)
    // A service already in use from here keeps working with its key; nothing can be looked up or updated.
    return decide(address && held ? { kind: 'use' } : notSetUp('open-settings'), base)
  }

  if (refused) {
    if (intent === 'set-up') return decide({ kind: 'stop', message: LIVE_SETUP_REFUSED }, noPermissionRow())
    // Spec, "Migration": the deployed service keeps working with its stored key; nothing is redeployed.
    return decide(address && held ? { kind: 'use' } : { kind: 'stop', message: LIVE_SETUP_REFUSED }, noPermissionRow())
  }

  // What was last seen counts only for the account it was seen on: the one in use (or, not checked yet, the recorded one).
  // An address recorded before accounts were recorded cannot be matched to an account: nothing seen is applied to it.
  const seenHere = seen && seen.accountId === (accountId ?? deployed.accountId) && (!address || Boolean(deployed.accountId)) ? seen : null
  const state = computerState({
    worker: seenHere?.worker ?? 'unknown', recorded: otherAccount ? 'other-account' : address ? 'this-account' : 'none',
    key, answer: seenHere?.key ?? 'unknown', workerBuild: seenHere?.build ?? null, appBuild,
  })
  const failedLast = last?.outcome === 'failed' ? last : null

  if (state === 'S1' || state === 'S7' || state === 'S8') {
    const shown = failedLast
      ? row('failed', { address: null, build: null, reason: failedLast.reason, details: failedLast.details })
      : row('not-set-up', { address: null, build: null, details: null, note: otherAccount ? 'other-account' : last?.outcome === 'not-found' || state === 'S8' ? 'not-found' : null })
    if (intent === 'set-up') return decide({ kind: 'set-up' }, shown)
    // One deployed for another account still answers with its key; publishing refuses it by its account (handout-publishing.ts).
    if (otherAccount && held) return decide({ kind: 'use' }, shown)
    return decide(notSetUp('open-settings'), shown)
  }

  if (state === 'S3' || state === 'S6' || state === 'S5') {
    // Set up on another computer, or this computer's access removed: the button adds this computer. Never on a use.
    const shown = failedLast
      ? row('failed', { address: null, build: null, reason: failedLast.reason, details: failedLast.details })
      : state === 'S5'
        ? row('access-removed')
        : row('set-up-elsewhere', { address: null, build: seenHere?.build ?? null, details: seenHere?.build ? `Live service build ${seenHere.build}${state === 'S6' ? ` · this TalkWeaver carries build ${appBuild}` : ''}` : null, updatesFirst: state === 'S6' })
    if (intent === 'set-up') return decide({ kind: 'set-up' }, shown)
    if (state === 'S5' && !failedLast) return decide({ kind: 'not-set-up', message: LIVE_ACCESS_REMOVED, prompt: 'open-settings', reason: 'failed' }, shown)
    return decide(notSetUp('open-settings'), shown)
  }

  // S2 or S4: set up on this computer, with its key.
  const others = state === 'S4' ? seenHere?.others ?? null : null
  const failedRow = failedLast ? row('failed', { reason: failedLast.reason, details: failedLast.details }) : null
  if (deployed.version !== appBuild) {
    // The next use updates it first (D9). Not checked: the update itself asks for a check. After a
    // failed update, uses go on with the service as it is until Try again (or a change of
    // connection), one attempt and not one per use; but each use first finds the Worker at
    // Cloudflare, for the account it was recorded for, or hands out no address at all.
    if (intent === 'set-up' || !failedRow) return decide({ kind: 'update' }, failedRow ?? row('ready', { others }))
    if (deployed.accountId && (connected ? deployed.accountId === accountId : connection === 'not-checked')) return decide({ kind: 'look-up', strict: true }, failedRow)
    return decide(notSetUp('open-settings'), failedRow)
  }
  const shown = failedRow ?? row('ready', { others })
  // Looked up only for the account it was recorded for. Not checked yet: the lookup's own leave runs
  // the check first (and is refused for another account, or offline, when the service is used as it is).
  const canAsk = connected ? deployed.accountId === accountId : connection === 'not-checked'
  if (deployed.accountId && canAsk) return decide({ kind: 'look-up' }, shown)
  return decide({ kind: 'use' }, shown)
}

/**
 * What a finished set-up or update leaves as the last outcome. Pure. A superseded one leaves nothing.
 * Nor does one stopped by a key slot that cannot be read: the row says that from the slot itself
 * (`facts.key`), each time it is asked, so nothing is kept that could outlast the slot being readable again.
 */
export function outcomeOf(result: LiveDeployResult): LastOutcome | null {
  if (result.ok || result.error === DEPLOY_SUPERSEDED_ERROR || result.error === LIVE_KEY_UNREADABLE) return null
  if (result.error === LIVE_SETUP_REFUSED) return { outcome: 'refused', details: result.details ?? null }
  return { outcome: 'failed', reason: result.error, details: result.details ?? null }
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

export type LiveEndpoint = { baseUrl: string; adminSecret: string; accountId: string | null }

export interface LiveServicePorts {
  /** The facts that are not the service's own (it adds `underway` and `last`). Reads only. */
  facts(): Omit<LiveServiceFacts, 'underway' | 'last' | 'seen'>
  /**
   * The admin secret to present to the recorded live service (its account, its address): the stored
   * one for it (or, in an unpackaged test run, the one handed over). Never another account's. With
   * two keys held for it (this computer's own and the 0.38.2 one), the one it accepts
   * (live-service-key.ts `keyToPresent`), which is why this may take a moment.
   */
  adminSecret(): string | null | Promise<string | null>
  /** Run the set-up sequence (live-service-deploy.ts), telling `progress` what it is doing. */
  deploy(progress: (phase: DeployPhase) => void): Promise<LiveDeployResult>
  /** Is the recorded address's Worker at Cloudflare, for the account it was recorded for? */
  lookUp(accountId: string): Promise<'exists' | 'missing' | 'unknown'>
  /**
   * What is at Cloudflare for the account in use, and what the live service says of this computer's
   * key (live-service-deploy.ts `surveyLiveService`). Null when it cannot be asked.
   */
  survey(): Promise<LiveSurvey | null>
  /** Drop the recorded address, build and account (a lookup found no Worker). The key is kept. */
  forget(): void
  /** Every new row (to tell the windows). Its failure is ignored. */
  onChange?(row: GoingLiveRow): void
  /** Tell the person something while they wait (an update before use). Its failure is ignored. */
  tell?(message: string): void
  now?(): number
}

/** `notice`: something to say beside a success (LIVE_UPDATE_PENDING: the update was uploaded and Cloudflare has not switched to it yet). */
export type SetUpReply = { ok: true; row: GoingLiveRow; notice?: string } | { ok: false; error: string; details: string | null; row: GoingLiveRow }

export interface LiveService {
  row(): GoingLiveRow
  /** "Set up going live", Try again, "Set up going live now". */
  setUp(): Promise<SetUpReply>
  /** The live service to use now, after any update or lookup it needs. Throws a LiveServiceError when there is none. */
  endpoint(): Promise<LiveEndpoint>
  /** Settings → Cloudflare opened or checked: look the recorded address up (`opened`: at most once a minute). */
  look(reason: 'opened' | 'asked'): Promise<GoingLiveRow>
  /** The connection or Settings changed: drop what no longer describes it, and tell the windows. */
  refresh(): void
  /** Everything under way has finished (tests). */
  idle(): Promise<void>
}

export const LOOK_INTERVAL_MS = 60_000

export function createLiveService(ports: LiveServicePorts): LiveService {
  const now = ports.now ?? Date.now
  let underway: LiveServiceFacts['underway'] = null
  let running: Promise<LiveDeployResult> | null = null
  let last: LastOutcome | null = null
  /** The connection `last` was about: when it changes, `last` no longer describes it. */
  let lastFor = ''
  let lookedAt: number | null = null
  let looking: Promise<unknown> | null = null
  let shownBefore = ''
  /**
   * Counts set-ups and updates that have finished. A lookup's "missing" may drop the record only if
   * none finished, and none was under way, between the lookup being asked and its answer: a
   * deployment in that time may have made the Worker again at the same address (fix round 1).
   */
  let deployments = 0

  /** What Cloudflare and the live service last said, and the account it was said for. */
  let seen: LiveSurvey | null = null

  const fingerprint = (facts: Omit<LiveServiceFacts, 'underway' | 'last' | 'seen'>): string => [facts.connection, facts.accountId ?? '', facts.permission].join('\n')
  function facts(): LiveServiceFacts {
    const read = ports.facts()
    if (last && fingerprint(read) !== lastFor) last = null
    // Seen on another account than the one now in use: it says nothing of this one.
    if (seen && read.accountId && seen.accountId !== read.accountId) seen = null
    return { ...read, underway, last, seen }
  }
  function remember(outcome: LastOutcome | null): void {
    last = outcome
    lastFor = fingerprint(ports.facts())
  }
  const decide = (intent: LiveIntent): LiveDecision => ensureLiveService(facts(), intent)
  function emit(): void {
    const row = decide('use').row
    const text = JSON.stringify(row)
    if (text === shownBefore) return
    shownBefore = text
    try { ports.onChange?.(row) } catch { /* a window that has gone */ }
  }
  const tell = (message: string): void => { try { ports.tell?.(message) } catch { /* a window that has gone */ } }
  /**
   * The runs whose "uploaded, not switched to yet" notice has reached the person: in a set-up's
   * reply (Settings shows it), or told beside the "Updating the live service…" line when the update
   * was part of going live or sharing. Each run's notice is given once, however many callers joined it.
   */
  const noticed = new WeakSet<LiveDeployResult>()
  function tellPending(result: LiveDeployResult): void {
    if (!result.ok || !result.pending || noticed.has(result)) return
    noticed.add(result)
    tell(result.pending.notice)
  }

  /** One set-up or update at a time: a second caller joins the one under way. */
  function run(kind: 'set-up' | 'update'): Promise<LiveDeployResult> {
    if (running) return running
    underway = { kind, phase: 'checking' }
    emit()
    const started = (async () => {
      try {
        const result = await ports.deploy((phase) => { if (underway) { underway = { ...underway, phase }; emit() } })
        remember(outcomeOf(result))
        // It went through: the Worker is there, at this build, and accepts this computer's key.
        if (result.ok) {
          const after = ports.facts()
          const account = after.deployed.accountId ?? after.accountId
          // The build it was last heard answering as: this app's, or (R10, the upload not switched to yet) still the one from before it.
          seen = account ? { accountId: account, worker: 'present', build: result.pending?.build ?? after.appBuild, key: 'accepted', others: result.others } : null
        }
        return result
      } catch {
        // A port that threw: sorted, never its text.
        const result: LiveDeployResult = { ok: false, error: LIVE_SETUP_FAILED }
        remember(outcomeOf(result))
        return result
      } finally {
        deployments += 1
        underway = null
        running = null
        emit()
      }
    })()
    running = started
    return started
  }

  /** The recorded address with this computer's key; with either missing, there is nothing to use. */
  async function recorded(): Promise<LiveEndpoint> {
    const read = ports.facts()
    const adminSecret = await ports.adminSecret()
    if (!read.deployed.baseUrl || !adminSecret) throw new LiveServiceError('not-set-up', LIVE_NOT_SET_UP, null, 'open-settings')
    return { baseUrl: read.deployed.baseUrl.replace(/\/+$/, ''), adminSecret, accountId: read.deployed.accountId }
  }

  async function lookUp(): Promise<'exists' | 'missing' | 'unknown'> {
    const read = ports.facts()
    const account = read.deployed.accountId
    if (!account) return 'unknown'
    const asked = { deployments, deploying: running !== null }
    let found: 'exists' | 'missing' | 'unknown'
    try { found = await ports.lookUp(account) } catch { found = 'unknown' }
    lookedAt = now()
    // A deployment that ran since it was asked may have made the Worker again: the answer is stale.
    const stale = asked.deploying || running !== null || deployments !== asked.deployments
    if (found === 'missing' && stale) return 'unknown'
    // Only when Settings still records what was looked up.
    const after = ports.facts()
    if (found === 'missing' && after.deployed.baseUrl === read.deployed.baseUrl && after.deployed.accountId === account) {
      ports.forget()
      // What was seen before said the Worker was there: it no longer is.
      seen = { accountId: account, worker: 'absent', build: null, key: 'unknown', others: null }
      remember({ outcome: 'not-found' })
      emit()
    } else if (found === 'exists' && last?.outcome === 'not-found') {
      remember(null)
      emit()
    }
    return found
  }

  /** Ask Cloudflare and the live service (one at a time), and keep what they said unless a set-up ran meanwhile. */
  async function survey(): Promise<void> {
    const read = ports.facts()
    const asked = { deployments, deploying: running !== null }
    let found: LiveSurvey | null
    try { found = await ports.survey() } catch { found = null }
    lookedAt = now()
    // A set-up that ran since it was asked knows better (it may have made the Worker, or added the key).
    if (!found || asked.deploying || running !== null || deployments !== asked.deployments) return
    const after = ports.facts()
    if (after.accountId !== found.accountId) return
    seen = found
    const recordedHere = Boolean(after.deployed.baseUrl) && after.deployed.baseUrl === read.deployed.baseUrl && after.deployed.accountId === found.accountId
    if (found.worker === 'absent' && recordedHere) {
      // Deleted in the dashboard: its record is dropped, and the row reads Not set up.
      ports.forget()
      remember({ outcome: 'not-found' })
    } else if (found.worker === 'present' && last?.outcome === 'not-found') {
      remember(null)
    }
    emit()
  }

  /** No address after a failed update whose Worker could not be found: the update's reason, and the prompt. */
  function noAddressAfterFailure(): LiveServiceError {
    return last?.outcome === 'failed'
      ? new LiveServiceError('failed', last.reason, last.details, 'open-settings')
      : new LiveServiceError('not-set-up', LIVE_NOT_SET_UP, null, 'open-settings')
  }

  async function endpoint(depth = 0): Promise<LiveEndpoint> {
    const { action } = decide('use')
    switch (action.kind) {
      case 'wait':
        await running
        return depth < 3 ? endpoint(depth + 1) : recorded()
      case 'use':
        return recorded()
      case 'look-up': {
        const found = await lookUp()
        // Missing: the record is gone, and the decision now says so.
        if (found === 'missing' && depth < 3) return endpoint(depth + 1)
        if (action.strict && found !== 'exists') throw noAddressAfterFailure()
        return recorded()
      }
      case 'update': {
        tell(LIVE_UPDATING_NOTICE)
        const result = await run('update')
        if (result.ok) {
          // Uploaded and not switched to yet (R10): said, on the path the progress line took. What was asked for goes on.
          tellPending(result)
          return { baseUrl: result.baseUrl, adminSecret: result.adminSecret, accountId: ports.facts().deployed.accountId }
        }
        // An update that did not go through: the service as it is, but only once it is found at
        // Cloudflare (a Worker deleted in the dashboard must not reach published pages).
        const found = await lookUp()
        if (found === 'exists') return recorded()
        // Missing: the record is gone, and the decision now says Not set up.
        if (found === 'missing' && depth < 3) return endpoint(depth + 1)
        throw noAddressAfterFailure()
      }
      case 'set-up':
        // Never on a use (the decision does not answer it for `use`): kept for the type.
        throw new LiveServiceError('not-set-up', LIVE_NOT_SET_UP, null, 'open-settings')
      case 'not-set-up':
        throw new LiveServiceError(action.reason === 'failed' ? 'failed' : 'not-set-up', action.message, action.reason === 'failed' && last?.outcome === 'failed' ? last.details : null, action.prompt)
      case 'stop':
        throw new LiveServiceError('failed', action.message, last?.outcome === 'refused' ? last.details : null)
    }
  }

  async function setUp(depth = 0): Promise<SetUpReply> {
    const reply = (result: LiveDeployResult): SetUpReply => {
      const row = decide('use').row
      if (result.ok && result.pending) noticed.add(result)
      return result.ok ? { ok: true, row, ...(result.pending ? { notice: result.pending.notice } : {}) } : { ok: false, error: result.error, details: result.details ?? null, row }
    }
    const { action } = decide('set-up')
    if (action.kind === 'wait') return reply(await (running as Promise<LiveDeployResult>))
    if (action.kind === 'stop') return reply({ ok: false, error: action.message })
    if (action.kind === 'look-up' || action.kind === 'use') {
      // Pressed with a service recorded and ready: looked up, and set up only if it is gone.
      if (action.kind === 'use' || await lookUp() !== 'missing' || depth > 0) return reply({ ok: true, baseUrl: '', adminSecret: '', others: null, created: false })
      return setUp(depth + 1)
    }
    if (action.kind !== 'set-up' && action.kind !== 'update') return reply({ ok: false, error: LIVE_SETUP_FAILED })
    tell(action.kind === 'update' ? LIVE_UPDATING_NOTICE : LIVE_SETTING_UP_NOTICE)
    return reply(await run(action.kind))
  }

  return {
    row: () => decide('use').row,
    setUp: () => setUp(),

    endpoint: () => endpoint(),

    async look(reason) {
      if (reason === 'opened' && lookedAt !== null && now() - lookedAt < LOOK_INTERVAL_MS) return decide('use').row
      // Asked whatever Settings records: this is how a computer that never set anything up learns
      // that the account has a live service (S3), and how a removed computer learns it was (S5).
      if (ports.facts().connection === 'connected' && !running) {
        looking ??= survey().finally(() => { looking = null })
        await looking
      }
      emit()
      return decide('use').row
    },

    refresh: () => emit(),

    async idle() {
      for (let i = 0; i < 5 && (running || looking); i += 1) {
        await running
        await looking
      }
    },
  }
}

/**
 * Whether an IPC call came from a window's own top frame, not a frame embedded in its page (fix
 * round 1). Electron's `event.senderFrame` is the frame that sent it, `event.sender.mainFrame` the
 * window's top frame.
 */
export function askedFromTopFrame(event: { sender?: { mainFrame?: unknown } | null; senderFrame?: unknown }): boolean {
  const top = event.sender?.mainFrame
  return Boolean(top) && event.senderFrame === top
}

/**
 * Whether a set-up may be started by this IPC call (fix round 2): only from an editor window, which
 * holds the Settings row, and only from its top frame. A presenter window (whose slides are the
 * person's content, embeds included), a History or Studio window, or a frame inside any page is refused.
 */
export function setUpAllowedFrom(event: { sender?: { id?: unknown; mainFrame?: unknown } | null; senderFrame?: unknown }, isEditorWindow: (webContentsId: number) => boolean): boolean {
  const id = event.sender?.id
  return askedFromTopFrame(event) && typeof id === 'number' && isEditorWindow(id)
}
