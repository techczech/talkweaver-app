// When post-work opens (work-files ticket 19; ADR-0040 decision 3). Pure: no Electron, no fs, no clock.
//
// Post-work that opens "when the session ends" is sent with its Run's publish as a window that never
// opens (`notYetOpenedWindow`: one millisecond before it closes). Once the live session bound to the Run
// has ended, or the Run is delivered, the app pushes the real opening (now) to the phase's object and
// notes it on the Run (`work.post.openedAt`). This module says, for one Run, which of those is owed.
// Post-work at a set time is not here: its window went out with the publish and opens by itself.
//
// Never owed: a Run with no post-work, or whose post-work was never sent (no object for it), or whose
// publication was never recorded (a first publish that failed after its object was made leaves a row, but
// no `publishedAt`), or whose pages were unpublished (ticket 17), or whose post-work closing time has
// passed. Owed once: a window already opened is never pushed again (a repeat end event, a relaunch, the
// timer); only the note on the Run is made up when it is missing, and only once that opening is reached
// (a window whose opening is still to come is not an opening). An object holding an opening still to come
// (post-work at a set time changed to "when the session ends", ticket 19 review round 2) is opened now,
// once the session has ended, as the window that never opens is.
//
// The opener (src/main/post-work-open.ts) asks this twice: once to see whether to ask the service at all,
// and again inside the object's own turn on the service, over the Run read again then. Between the two the
// Run may have changed: `postWorkIdentity` says whether it still holds the post-work that was sent.
import { runPublication, type ChecklistRun } from './run-checklist.ts'
import { zonedLocalToMs } from './run-prework.ts'
import { SESSION_END, type RunWork } from './run-work.ts'

export interface PushedWindow { opensAt: number; closesAt: number }

/**
 * Post-work that opens "when the session ends", sent before the session has ended: the Worker needs a
 * window, so it is sent one that opens 1 ms before it closes. It never opens by itself.
 */
export function notYetOpenedWindow(closesAt: number): PushedWindow {
  return { opensAt: closesAt - 1, closesAt }
}

/** Whether a window pushed for a phase is `notYetOpenedWindow`'s (post-work waiting for the session's end). */
export function isNotYetOpenedWindow(window: PushedWindow): boolean {
  return window.closesAt - window.opensAt === 1
}

export interface PostWorkOpeningInput {
  run: Pick<ChecklistRun, 'status' | 'handoutUrl' | 'unpublishedAt' | 'work'>
  /** A live session bound to this Run has ended (or expired). */
  liveEnded: boolean
  /** The phase's object as the work service last pushed it, or null when post-work was never sent. */
  sent: (PushedWindow & { purgedAt?: number; withdrawnAt?: number; withdrawAskedAt?: number }) | null
  now: number
}

export type PostWorkOpeningSkip =
  | 'no-post-work' | 'set-time' | 'not-ended' | 'not-sent' | 'not-published' | 'unpublished' | 'gone' | 'already-open' | 'not-yet-open'
  | 'closed' | 'unreadable'

export type PostWorkOpening =
  /** Push this window (opens now) to the phase's object, then note `openedAt` on the Run. */
  | { act: 'push'; window: PushedWindow }
  /** Already pushed open, but the Run does not say so (its write failed last time): note it. */
  | { act: 'note'; openedAt: number }
  | { act: 'none'; why: PostWorkOpeningSkip }

/** What is owed for one Run's post-work now. */
export function postWorkOpening(input: PostWorkOpeningInput): PostWorkOpening {
  const { run, sent, now } = input
  const post = run.work?.post
  if (!post) return { act: 'none', why: 'no-post-work' }
  if (post.opens !== SESSION_END) return { act: 'none', why: 'set-time' }
  if (!input.liveEnded && run.status !== 'delivered') return { act: 'none', why: 'not-ended' }
  if (!sent) return { act: 'none', why: 'not-sent' }
  if (sent.purgedAt !== undefined) return { act: 'none', why: 'gone' }
  // Unpublished (the Run or its phases stamped after they went out), or withdrawn on the service, or a
  // withdraw asked for and not answered: participants are shown "This page is not available"; nothing opens.
  const publication = runPublication(run)
  if (publication === 'unpublished' || sent.withdrawnAt !== undefined || sent.withdrawAskedAt !== undefined) return { act: 'none', why: 'unpublished' }
  // A row proves an object was made, not that the Run went out: its post-work must carry a recorded publish.
  if (publication !== 'published' || !Number.isFinite(Date.parse(post.publishedAt ?? ''))) return { act: 'none', why: 'not-published' }
  if (!isNotYetOpenedWindow(sent)) {
    if (!Number.isSafeInteger(now)) return { act: 'none', why: 'not-yet-open' }
    // Already opened on the service: never pushed again, only noted on the Run when the note is missing.
    if (sent.opensAt <= now) {
      const noted = Date.parse(post.openedAt ?? '')
      return Number.isFinite(noted) && noted === sent.opensAt ? { act: 'none', why: 'already-open' } : { act: 'note', openedAt: sent.opensAt }
    }
    // An opening still to come (the window a set time was sent with, the post-work since changed to open
    // when the session ends): the session has ended, so it opens now, as below. It is never noted as open.
  }
  if ((post as { problem?: string }).problem) return { act: 'none', why: 'unreadable' }
  const closesAt = zonedLocalToMs(post.closes, post.timeZone)
  if (!Number.isSafeInteger(closesAt) || !Number.isSafeInteger(now)) return { act: 'none', why: 'unreadable' }
  if (now >= closesAt - 1) return { act: 'none', why: 'closed' }
  return { act: 'push', window: { opensAt: now, closesAt } }
}

/**
 * What identifies the post-work a Run sent: its file, the revision pinned when it went out, and when it went
 * out. Null when the Run has no post-work. Two readings of a Run hold the same sent post-work exactly when
 * these are equal; a replaced or removed file, or one sent again, is not the post-work that was decided on.
 */
export function postWorkIdentity(run: { work?: { post?: Pick<RunWork, 'fileId' | 'opens' | 'pinned' | 'publishedAt'> } }): string | null {
  const post = run.work?.post
  if (!post) return null
  return JSON.stringify([post.fileId, post.opens, post.pinned?.revision ?? null, post.pinned?.sha256 ?? null, post.publishedAt ?? null])
}
