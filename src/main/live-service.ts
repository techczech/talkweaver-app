// Going live and sharing: whether there is a live service to use, what to do before using it, and
// the Settings row that says so (spec docs/plans/cloudflare-setup-in-app, D7, D8, D9, D12; ticket 05).
//
// Two layers, the seams the tests drive:
//   ensureLiveService(facts, intent)  PURE. From the connection, the stored keys, what Settings records
//                                     as deployed and this app's build, to the ONE action to take and
//                                     the row to show. Every state of the spec's row comes from here.
//   createLiveService(ports)          the service: it reads the facts, takes the action (one set-up or
//                                     update at a time; a second caller joins the first), keeps what
//                                     the last set-up came to, and tells the windows.
//
// The decision (intent `use`: Go live, Share for comments, a share or pre-work link, a publish;
// intent `set-up`: "Set up going live" in Settings, Try again, or "Set up going live now"):
//
//   Facts                                             | row             | use              | set-up
//   --------------------------------------------------|-----------------|------------------|-----------
//   a set-up or update under way                      | setting-up /    | wait for it      | wait for it
//                                                     | updating        |                  |
//   Settings records an address for this account,     | keys-lost       | stop             | stop
//     and this computer has no keys for it            |                 |                  |
//   no working connection (no token, rejected, choose | unknown         | use it if one is | stop: not
//     an account, storage), nothing deployed          |                 | recorded with    | connected
//                                                     |                 | keys; else "not  |
//                                                     |                 | set up · Open    |
//                                                     |                 | Settings"        |
//   the token cannot run the live service (the check, | no-permission   | use what is      | stop
//     or a set-up Cloudflare refused)                 |                 | deployed (with   |
//                                                     |                 | its keys), else  |
//                                                     |                 | stop             |
//   nothing deployed for this account                 | not-set-up      | "not set up ·    | set up
//     (or one deployed for another account)           | (failed after a | Set up going     |
//                                                     |  failed set-up) | live now"; one   |
//                                                     |                 | for another      |
//                                                     |                 | account is used  |
//                                                     |                 | as it is         |
//   deployed for this account, keys here, an older    | ready (says the | update first,    | update
//     build than this app's                           | update is due)  | then use         |
//   deployed for this account, keys here, this build  | ready           | look it up at    | look it up
//                                                     |                 | Cloudflare (for  |
//                                                     |                 | the recorded     |
//                                                     |                 | account), then   |
//                                                     |                 | use; with no     |
//                                                     |                 | account recorded:|
//                                                     |                 | use as it is     |
//
// INVARIANTS.
//   - Nothing is set up on a use: the first set-up is always asked for (D9: "set up on purpose").
//     A publish with no live service publishes without it (D7). An update of a service already
//     deployed from here IS done on a use, once, with the stored keys, and the person is told.
//   - The stored admin and signing keys are never replaced. With an address recorded and no keys the
//     answer is the keys-lost stop, and the set-up sequence (live-service-deploy.ts) stops the same
//     way when Cloudflare has the Worker and this computer has no keys. There is no reset button:
//     the row says what resetting breaks and how to do it (delete the Worker, then Check again).
//   - An address recorded for the account in use is looked up at Cloudflare before it is handed out
//     (published pages, Go live, shares) whenever the connection can: a Worker deleted in the
//     dashboard is found missing, its record is dropped and the row reads Not set up. With no way to
//     look (offline, or a token that may not read Workers) it is used as it is, as before (spec,
//     "Migration": the deployed service keeps working with its stored credentials).
//   - No secret is in a row, a reason, Details, or a thrown error: the keys stay with the ports.
//
// No Electron import and erasable TypeScript only: scripts/test-going-live-row.mjs imports it as it is.
import { DEPLOY_NOT_CONNECTED_ERROR, DEPLOY_SUPERSEDED_ERROR } from './cloudflare-connection.ts'
import { LIVE_KEYS_LOST, LIVE_NOT_SET_UP, LIVE_SETUP_FAILED, LIVE_SETUP_REFUSED, LiveServiceError, type LiveDeployResult } from './live-service-deploy.ts'
import { WORKERS_PERMISSION } from '../shared/cloudflare-status.ts'
import { LIVE_KEYS_LOST_EXPLAINED, LIVE_SETTING_UP_NOTICE, LIVE_UPDATING_NOTICE, unknownGoingLive, type GoingLiveRow, type LiveSetupPrompt } from '../shared/live-service-status.ts'

/** What a set-up or update last came to, kept until it no longer describes the connection in use. */
export type LastOutcome =
  | { outcome: 'failed'; reason: string; details: string | null }
  /** Cloudflare refused the deploy for permission: the token cannot run the live service. */
  | { outcome: 'refused'; details: string | null }
  /** Cloudflare has the Worker and this computer has no keys for it (the sequence's stop). */
  | { outcome: 'keys-lost' }
  /** A lookup found no Worker where Settings recorded one: its record was dropped. */
  | { outcome: 'not-found' }

export type LiveServiceFacts = {
  /** `not-connected`: no token, a rejected one, an account to choose, no storage. `not-checked`: checking, or Cloudflare not answering. */
  connection: 'not-connected' | 'not-checked' | 'connected'
  /** What the connection check found about the live-service permission. */
  permission: 'unknown' | 'not-refused' | 'no-permission'
  /** The account the connection uses, or null. */
  accountId: string | null
  /** This computer has the live service's keys (slot `live-worker-credentials`). */
  keysStored: boolean
  /** What Settings records as deployed: the address, the build deployed there, the account it was deployed for. */
  deployed: { baseUrl: string | null; version: string | null; accountId: string | null }
  /** LIVE_WORKER_BUILD of this app. */
  appBuild: string
  underway: null | { kind: 'set-up' | 'update'; phase: 'upload' | 'secrets' }
  last: LastOutcome | null
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
  const { connection, permission, accountId, keysStored, deployed, appBuild, underway, last } = facts
  const address = addressOf(deployed.baseUrl)
  const base = unknownGoingLive(appBuild)
  const row = (state: GoingLiveRow['state'], extra: Partial<GoingLiveRow> = {}): GoingLiveRow => ({
    ...base, address, build: address ? deployed.version : null,
    details: address ? `Live service build ${deployed.version ?? 'not recorded'} at ${address}${deployed.version !== appBuild ? ` · this TalkWeaver carries build ${appBuild}` : ''}` : null,
    state, ...extra,
  })
  const decide = (action: LiveAction, shown: GoingLiveRow): LiveDecision => ({ action, row: shown })

  if (underway) return decide({ kind: 'wait' }, row(underway.kind === 'update' ? 'updating' : 'setting-up', { phase: underway.phase }))

  // Deployed for an account the connection is not on (when both are known): not this connection's service.
  const otherAccount = Boolean(address && deployed.accountId && accountId && deployed.accountId !== accountId)
  const here = Boolean(address) && !otherAccount
  const connected = connection === 'connected'
  const refused = permission === 'no-permission' || last?.outcome === 'refused'
  const noPermissionRow = (): GoingLiveRow => row('no-permission', { permission: WORKERS_PERMISSION, details: last?.outcome === 'refused' ? last.details : row('no-permission').details })
  const notSetUp = (prompt: LiveSetupPrompt): LiveAction => (last?.outcome === 'failed'
    ? { kind: 'not-set-up', message: last.reason, prompt, reason: 'failed' }
    : { kind: 'not-set-up', message: LIVE_NOT_SET_UP, prompt, reason: 'not-set-up' })

  // The keys are never replaced: an address recorded here with no keys on this computer is a stop.
  if (here && !keysStored) {
    return decide({ kind: 'stop', message: LIVE_KEYS_LOST }, row('keys-lost', { reason: LIVE_KEYS_LOST_EXPLAINED }))
  }
  if (last?.outcome === 'keys-lost' && !address) {
    return decide({ kind: 'stop', message: LIVE_KEYS_LOST }, row('keys-lost', { reason: LIVE_KEYS_LOST_EXPLAINED }))
  }

  if (connection === 'not-connected') {
    if (intent === 'set-up') return decide({ kind: 'stop', message: DEPLOY_NOT_CONNECTED_ERROR }, base)
    // A service already deployed keeps working with its keys; nothing can be looked up or updated.
    return decide(address && keysStored ? { kind: 'use' } : notSetUp('open-settings'), base)
  }

  if (refused) {
    if (intent === 'set-up') return decide({ kind: 'stop', message: LIVE_SETUP_REFUSED }, noPermissionRow())
    // Spec, "Migration": the deployed service keeps working with its stored keys; nothing is redeployed.
    return decide(address && keysStored ? { kind: 'use' } : { kind: 'stop', message: LIVE_SETUP_REFUSED }, noPermissionRow())
  }

  if (!here) {
    const shown = last?.outcome === 'failed'
      ? row('failed', { address: null, build: null, reason: last.reason, details: last.details })
      : row('not-set-up', { address: null, build: null, details: null, note: otherAccount ? 'other-account' : last?.outcome === 'not-found' ? 'not-found' : null })
    if (intent === 'set-up') return decide({ kind: 'set-up' }, shown)
    // One deployed for another account still answers with its keys; publishing refuses it by its account (handout-publishing.ts).
    if (otherAccount && keysStored) return decide({ kind: 'use' }, shown)
    return decide(notSetUp('open-settings'), shown)
  }

  // Deployed for this account, with its keys.
  const failedRow = last?.outcome === 'failed' ? row('failed', { reason: last.reason, details: last.details }) : null
  if (deployed.version !== appBuild) {
    // The next use updates it first (D9). Not checked: the update itself asks for a check. After a
    // failed update, uses go on with the service as it is until Try again (or a change of
    // connection), one attempt and not one per use; but each use first finds the Worker at
    // Cloudflare, for the account it was recorded for, or hands out no address at all.
    if (intent === 'set-up' || !failedRow) return decide({ kind: 'update' }, failedRow ?? row('ready'))
    if (deployed.accountId && (connected ? deployed.accountId === accountId : connection === 'not-checked')) return decide({ kind: 'look-up', strict: true }, failedRow)
    return decide(notSetUp('open-settings'), failedRow)
  }
  const shown = failedRow ?? row('ready')
  // Looked up only for the account it was recorded for. Not checked yet: the lookup's own leave runs
  // the check first (and is refused for another account, or offline, when the service is used as it is).
  const canAsk = connected ? deployed.accountId === accountId : connection === 'not-checked'
  if (deployed.accountId && canAsk) return decide({ kind: 'look-up' }, shown)
  return decide({ kind: 'use' }, shown)
}

/** What a finished set-up or update leaves as the last outcome. Pure. A superseded one leaves nothing. */
export function outcomeOf(result: LiveDeployResult): LastOutcome | null {
  if (result.ok || result.error === DEPLOY_SUPERSEDED_ERROR) return null
  if (result.error === LIVE_KEYS_LOST) return { outcome: 'keys-lost' }
  if (result.error === LIVE_SETUP_REFUSED) return { outcome: 'refused', details: result.details ?? null }
  return { outcome: 'failed', reason: result.error, details: result.details ?? null }
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

export type LiveEndpoint = { baseUrl: string; adminSecret: string; accountId: string | null }

export interface LiveServicePorts {
  /** The facts that are not the service's own (it adds `underway` and `last`). Reads only. */
  facts(): Omit<LiveServiceFacts, 'underway' | 'last'>
  /** The admin secret for the recorded address: the stored one (or, in an unpackaged test run, the one handed over). */
  adminSecret(): string | null
  /** Run the set-up sequence (live-service-deploy.ts), telling `progress` what it is doing. */
  deploy(progress: (phase: 'upload' | 'secrets') => void): Promise<LiveDeployResult>
  /** Is the recorded address's Worker at Cloudflare, for the account it was recorded for? */
  lookUp(accountId: string): Promise<'exists' | 'missing' | 'unknown'>
  /** Drop the recorded address, build and account (a lookup found no Worker). The keys are kept. */
  forget(): void
  /** Every new row (to tell the windows). Its failure is ignored. */
  onChange?(row: GoingLiveRow): void
  /** Tell the person something while they wait (an update before use). Its failure is ignored. */
  tell?(message: string): void
  now?(): number
}

export type SetUpReply = { ok: true; row: GoingLiveRow } | { ok: false; error: string; details: string | null; row: GoingLiveRow }

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

  const fingerprint = (facts: Omit<LiveServiceFacts, 'underway' | 'last'>): string => [facts.connection, facts.accountId ?? '', facts.permission].join('\n')
  function facts(): LiveServiceFacts {
    const read = ports.facts()
    if (last && fingerprint(read) !== lastFor) last = null
    return { ...read, underway, last }
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

  /** One set-up or update at a time: a second caller joins the one under way. */
  function run(kind: 'set-up' | 'update'): Promise<LiveDeployResult> {
    if (running) return running
    underway = { kind, phase: 'upload' }
    emit()
    const started = (async () => {
      try {
        const result = await ports.deploy((phase) => { if (underway) { underway = { ...underway, phase }; emit() } })
        remember(outcomeOf(result))
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

  /** The recorded address with its keys, or the keys-lost stop. */
  function recorded(): LiveEndpoint {
    const read = ports.facts()
    const adminSecret = ports.adminSecret()
    if (!read.deployed.baseUrl || !adminSecret) throw new LiveServiceError('failed', LIVE_KEYS_LOST)
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
      remember({ outcome: 'not-found' })
      emit()
    } else if (found === 'exists' && (last?.outcome === 'not-found' || last?.outcome === 'keys-lost')) {
      remember(null)
      emit()
    }
    return found
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
        if (result.ok) return { baseUrl: result.baseUrl, adminSecret: result.adminSecret, accountId: ports.facts().deployed.accountId }
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
      return result.ok ? { ok: true, row } : { ok: false, error: result.error, details: result.details ?? null, row }
    }
    const { action } = decide('set-up')
    if (action.kind === 'wait') return reply(await (running as Promise<LiveDeployResult>))
    if (action.kind === 'stop') return reply({ ok: false, error: action.message })
    if (action.kind === 'look-up' || action.kind === 'use') {
      // Pressed with a service recorded and ready: looked up, and set up only if it is gone.
      if (action.kind === 'use' || await lookUp() !== 'missing' || depth > 0) return reply({ ok: true, baseUrl: '', adminSecret: '' })
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
      // A keys-lost stop learned from a set-up is looked at afresh: the Worker may have been deleted since.
      if (last?.outcome === 'keys-lost' && !ports.facts().deployed.baseUrl) { remember(null); emit() }
      const { action } = ensureLiveService({ ...facts(), keysStored: true }, 'use')
      // Keys or not, a recorded address for this account is looked up: that is how a reset (the Worker deleted) is seen.
      if ((action.kind === 'look-up' || action.kind === 'update') && ports.facts().connection === 'connected') {
        looking ??= lookUp().finally(() => { looking = null })
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
