// Post-work opens when the session ends (work-files ticket 19; ADR-0040 decision 3), main-process side.
//
// What is owed for a Run is decided by the pure rule (src/shared/post-work-opening.ts); this module asks it
// and carries it out: it pushes the opening to the post-work object through the work service (only while
// that object still holds the window that never opens, decided again inside the object's own turn), then
// notes `work.post.openedAt` on the Run through the atomic Run writer, from a fresh read.
//
// Asked when a live session bound to the Run ends, when the Run is marked delivered or saved as delivered,
// after the Run is published, at launch and on every pull cycle (so post-work whose session ended while the
// app was not running opens on the next launch, and the checklist says when). Nothing here sends anything
// for a Run with no post-work, post-work never sent, or a Run whose pages were unpublished.
//
// Which vault (ticket 19 review, rounds 1 and 2): the post-work object belongs to the vault whose Run was
// published to it, which its registry row records (`vaultRoot`, written by every publish). The opener acts
// only when that recorded vault is the vault the Run is read from, and that vault is open: a session's end
// and Mark as delivered name their vault (the one the session recorded when it was bound, the one the Run
// was found in), and the timer reads each row's Run in the row's own vault. A copy of the Run in another
// vault, open or not, never opens the object. A row that records no vault (published before it was kept)
// never opens on its own; publishing again records it. Never the writable vault in its place. The row's
// vault is checked again inside the object's turn, so a vault opened, closed or published from meanwhile
// cannot change the outcome.
//
// Deciding (ticket 19 review): the rule is asked once here, and again inside the object's own turn on the
// service over the Run read again then, which must still hold the same sent post-work (postWorkIdentity).
// After the push, `openedAt` is noted only if the Run read afresh still holds that post-work.
import { createKeyedQueue } from './owner-tokens.ts'
import { noteRunPostOpened, persistRunForTalk, readRunForTalk, type RunRecord } from './runs.ts'
import { PREWORK_PULL_INTERVAL_MS, type RunPreworkService } from './run-prework.ts'
import { postWorkIdentity, postWorkOpening, type PostWorkOpeningSkip } from '../shared/post-work-opening.ts'

export interface PostWorkOpenerDeps {
  service: Pick<RunPreworkService, 'status' | 'openWhenEnded' | 'sentRuns'>
  /** The roots of the vaults open now whose folders are there. A Run is read and written only in one of these. */
  vaults(): readonly string[]
  /** Whether a live session bound to this Run of this vault has ended (or expired). */
  liveEnded(talkSlug: string, runId: string, vaultRoot: string): boolean
  now?(): number
}

/**
 * Why nothing was opened: the rule's reason; `no-run` (the Run is not in that vault, or the vault is not
 * open); `no-vault` (the object's row records no vault: published before it was kept); `other-vault` (the
 * row records another vault than the one the Run was read from); `changed` (the Run no longer held the
 * post-work decided on, or the row another vault, inside the service's turn or when the opening was to be
 * noted).
 */
export type PostWorkOpenSkip = PostWorkOpeningSkip | 'no-run' | 'no-vault' | 'other-vault' | 'changed'

export type PostWorkOpenResult =
  | { ok: true; talkSlug: string; runId: string; opened: false; why: PostWorkOpenSkip }
  /** `pushed`: this call sent the opening; otherwise it only noted one already on the service. */
  | { ok: true; talkSlug: string; runId: string; opened: true; openedAt: string; pushed: boolean }
  | { ok: false; talkSlug: string; runId: string; error: string }

export function createPostWorkOpener(deps: PostWorkOpenerDeps) {
  const now = deps.now ?? Date.now
  // One decision at a time per Run: a session's end and the timer never both decide on the same reading.
  const queue = createKeyedQueue()

  const vaultOpen = (vaultRoot: string): boolean => {
    try { return deps.vaults().includes(vaultRoot) } catch { return false }
  }
  /** The Run in its own vault while that vault is open, or null. */
  const readIn = (vaultRoot: string, talkSlug: string, runId: string): RunRecord | null => {
    if (!vaultOpen(vaultRoot)) return null
    try { return readRunForTalk(vaultRoot, talkSlug, runId) } catch { return null }
  }
  /** What the object's row says of this vault: null when it is the row's own vault (or there is no row). */
  const notOwnedBy = (sent: { vaultRoot?: string } | null, vaultRoot: string): PostWorkOpenSkip | null =>
    !sent ? null : !sent.vaultRoot ? 'no-vault' : sent.vaultRoot !== vaultRoot ? 'other-vault' : null

  /**
   * `named`: the vault the caller names (undefined: the timer, which names none). `rowRoot`: for the timer, the vault
   * the object's row records (null: none). The object is looked up in that vault only (issue 256): a copy of the Run
   * in another vault has its own object.
   */
  async function openNow(talkSlug: string, runId: string, named: string | null | undefined, rowRoot: string | null = null): Promise<PostWorkOpenResult> {
    const none = (why: PostWorkOpenSkip): PostWorkOpenResult => ({ ok: true, talkSlug, runId, opened: false, why })
    // The timer names no vault: the row's own.
    if (named === undefined && !rowRoot) return none('no-vault')
    const lookup = named !== undefined ? named : rowRoot
    if (!lookup) return none('no-run')
    const sent = deps.service.status(talkSlug, runId, 'post', lookup)
    const vaultRoot = named !== undefined ? named : sent ? (sent.vaultRoot ?? null) : null
    if (!vaultRoot) return none(named === undefined && sent ? 'no-vault' : 'no-run')
    const run = readIn(vaultRoot, talkSlug, runId)
    if (!run) return none('no-run')
    const foreign = notOwnedBy(sent, vaultRoot)
    if (foreign) return none(foreign)
    const identity = postWorkIdentity(run)
    const liveEnded = (): boolean => { try { return deps.liveEnded(talkSlug, runId, vaultRoot) } catch { return false } }
    const decision = postWorkOpening({ run, liveEnded: liveEnded(), sent, now: now() })
    if (decision.act === 'none') return none(decision.why)
    let openedAt = decision.act === 'note' ? decision.openedAt : decision.window.opensAt
    let pushed = false
    if (decision.act === 'push') {
      // Decided again inside the object's turn, from the row and the Run as they are then: the row must still
      // record this vault, the vault must still be open, and the Run there must hold the same sent post-work.
      const result = await deps.service.openWhenEnded(talkSlug, runId, (sent) => {
        if (notOwnedBy(sent, vaultRoot)) return null
        const current = readIn(vaultRoot, talkSlug, runId)
        if (!current || postWorkIdentity(current) !== identity) return null
        const again = postWorkOpening({ run: current, liveEnded: liveEnded(), sent, now: now() })
        return again.act === 'push' ? again.window : null
      }, vaultRoot)
      if (!result.ok) return { ok: false, talkSlug, runId, error: result.error }
      if ('declined' in result) return none('changed')
      openedAt = result.opensAt
      pushed = !result.unchanged
    }
    // An opening still to come (an object already holding a later one) is not an opening: nothing is noted.
    if (openedAt > now()) return none('not-yet-open')
    const at = new Date(openedAt).toISOString()
    // Written from a fresh read, with nothing awaited in between: answers pulled meanwhile are kept. Only
    // when the Run still holds the post-work that was opened; otherwise nothing is noted, and the next
    // cycle decides again.
    const current = readIn(vaultRoot, talkSlug, runId)
    if (!current) return { ok: false, talkSlug, runId, error: 'This Run is no longer in the vault.' }
    if (postWorkIdentity(current) !== identity || notOwnedBy(deps.service.status(talkSlug, runId, 'post', vaultRoot), vaultRoot)) return none('changed')
    const noted = noteRunPostOpened(current, at)
    if (noted !== current) {
      try { persistRunForTalk(vaultRoot, talkSlug, runId, noted) } catch {
        // Open on the service but not noted: the next pull cycle notes it (the rule answers `note`).
        return { ok: false, talkSlug, runId, error: 'Post-work is open, but the Run could not be saved. It will be noted next time.' }
      }
    }
    return { ok: true, talkSlug, runId, opened: true, openedAt: at, pushed }
  }

  /**
   * Open one Run's post-work if it is owed. `vaultRoot`: the vault the Run belongs to (a session's recorded
   * vault, the vault it was found or saved in); null when the caller knows of none (nothing is opened);
   * left out, nothing is opened either ('no-vault': the timer, openDue, names each row's vault itself). The
   * object is that vault's own (issue 256), and opens only when its row records that same vault. Never throws.
   */
  function open(talkSlug: string, runId: string, vaultRoot?: string | null): Promise<PostWorkOpenResult> {
    return queue.run(`${talkSlug}/${runId}`, () => openNow(talkSlug, runId, vaultRoot))
      .catch(() => ({ ok: false as const, talkSlug, runId, error: 'Post-work could not be opened just now.' }))
  }

  /**
   * Every Run whose post-work was sent, asked in turn (launch and every pull cycle), each in the vault its
   * row records (read again in the Run's turn). Never throws.
   */
  async function openDue(): Promise<PostWorkOpenResult[]> {
    let refs: Array<{ talkSlug: string; runId: string; vaultRoot: string | null }> = []
    try { refs = deps.service.sentRuns('post') } catch { return [] }
    const results: PostWorkOpenResult[] = []
    // Each row in the vault it records: two vaults with the same talk and Run id are two objects, each asked once.
    for (const ref of refs) {
      results.push(await queue.run(`${ref.talkSlug}/${ref.runId}`, () => openNow(ref.talkSlug, ref.runId, undefined, ref.vaultRoot))
        .catch(() => ({ ok: false as const, talkSlug: ref.talkSlug, runId: ref.runId, error: 'Post-work could not be opened just now.' })))
    }
    return results
  }

  return { open, openDue }
}

export type PostWorkOpener = ReturnType<typeof createPostWorkOpener>

/**
 * At launch and every pull cycle: open whatever post-work is owed. `onOpened` hears of the Runs that changed
 * (opened or noted). Returns a stop function.
 */
export function startPostWorkOpenTimer(opener: PostWorkOpener, onOpened: (results: PostWorkOpenResult[]) => void, intervalMs = PREWORK_PULL_INTERVAL_MS): () => void {
  let running = false
  // Said once per Run per launch: the row stays as it is until the Run is published again.
  const toldNoVault = new Set<string>()
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const results = await opener.openDue()
      for (const result of results) {
        if (!result.ok) console.warn(`[post-work] not opened: ${result.error}`)
        else if (!result.opened && result.why === 'no-vault' && !toldNoVault.has(`${result.talkSlug}/${result.runId}`)) {
          toldNoVault.add(`${result.talkSlug}/${result.runId}`)
          console.warn(`[post-work] ${result.talkSlug}/${result.runId}: published before this app recorded its vault, so its post-work does not open on its own; publish the Run again`)
        }
      }
      const opened = results.filter((result) => result.ok && result.opened)
      if (opened.length) onOpened(opened)
    } finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()
  void tick()
  return () => clearInterval(timer)
}
