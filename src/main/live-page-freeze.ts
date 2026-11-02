// Freeze and mark on a live web page: the pure parts main uses (live-page-host.ts runs the lifecycle).
// Design: docs/design/2026-10-28-embed-objects-and-pointing/design-live-page-pointing-and-annotation-options-2026-10-28.md
// (approach locked by the owner 2026-10-28) and design-pointer-markup-freeze-on-live-page-2026-10-28.md (its root
// lifecycle clarification supersedes the rows it names).
//
// Turning on Pointer or Pen while a slide shows a live page takes ONE picture of what the room sees (the
// audience copy, else the presenter's), shows that same picture in every app-owned deck window that shows
// the page, and only then hides the native views and turns the tool on. Nothing is written, uploaded or
// run in the page: the picture is held in memory, sent to the decks with executeJavaScript in their own
// main world (app-compiled HTML), and shown there with img.src only.
//
// Who can start a freeze: only the presenter deck's own report (polled by main, live-page-host.ts). The
// remote page is another WebContents with no preload, no bridge and no IPC; it cannot reach the deck's
// main world, so it cannot start, answer or cancel a freeze.
import { createHash } from 'node:crypto'

/** The whole freeze, from the press until both windows have shown the picture (design: about three seconds). */
export const LIVE_PAGE_FREEZE_MS = 3000
/** A frozen picture larger than this (JPEG bytes) is refused, never sent to a window. */
export const LIVE_PAGE_FREEZE_MAX_JPEG = 4_000_000
/** The picture's id: the first 16 hex characters of the SHA-256 of its JPEG bytes (the capture gallery's naming). */
export const LIVE_STILL_ID = /^[0-9a-f]{16}$/

export const FREEZE_TEXT = {
  notShowing: 'The page is not showing yet, so there is nothing to point at.',
  failed: "Couldn't freeze the page. Pointer and Pen are off; the live page is unchanged.",
  unavailable: 'Freezing the page is not available in this window.',
  audienceNotShowing: "The audience window isn't showing this page, so nothing was frozen.",
  audienceLeft: 'The audience window moved to another slide or page, so the frozen view ended.'
} as const

export type FreezeTool = 'pointer' | 'pen'
/** The presenter deck's freeze field in its slot report: bumped on every press; `want` null asks for live. */
export type FreezeRequest = { seq: number; want: FreezeTool | null }

export function stillIdOf(jpeg: Uint8Array): string {
  return createHash('sha256').update(jpeg).digest('hex').slice(0, 16)
}

/** The report's `freeze` field, checked; null for anything else. */
export function validateFreezeRequest(value: unknown): FreezeRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const f = value as Record<string, unknown>
  if (Object.keys(f).sort().join(',') !== 'seq,want') return null
  if (typeof f.seq !== 'number' || !Number.isInteger(f.seq) || f.seq < 0 || f.seq > 1e9) return null
  if (f.want !== null && f.want !== 'pointer' && f.want !== 'pen') return null
  return { seq: f.seq, want: f.want as FreezeTool | null }
}

/** What main tells a deck window about a frozen picture (shown with img.src only, a JPEG data: address). */
export type FrozenMessage =
  | { v: 1; op: 'show'; seq: number; slideId: string; url: string; id: string; src: string; width: number; height: number; source: 'audience' | 'presenter' }
  | { v: 1; op: 'on'; seq: number; slideId: string; url: string; id: string }
  | { v: 1; op: 'clear'; seq: number; slideId: string; url: string; message?: string }

/** The script that hands one message to a deck and answers what the deck answered (its own promise). */
export function frozenCallScript(message: FrozenMessage): string {
  const json = JSON.stringify(JSON.stringify(message)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `window.__twLivePageFrozen ? window.__twLivePageFrozen(${json}) : false`
}

/** A deck's answer to `show`: it showed exactly this picture (the id it was sent), or not. */
export function frozenAck(value: unknown, id: string): boolean {
  return typeof value === 'string' && LIVE_STILL_ID.test(value) && value === id
}

export type DeadlineTimers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }

/**
 * `promise`, or a failure when the deadline passes first or the promise rejects. The timer is always
 * cleared, so nothing of a finished or abandoned freeze is left running; a late answer is dropped.
 */
export function withDeadline<T>(promise: Promise<T>, deadline: number, now: () => number, timers: DeadlineTimers): Promise<{ ok: true; value: T } | { ok: false; why: 'timeout' | 'error' }> {
  const left = Math.max(0, deadline - now())
  return new Promise((resolve) => {
    let settled = false
    const handle = timers.setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, why: 'timeout' }) } }, left)
    promise.then(
      (value) => { if (!settled) { settled = true; timers.clearTimeout(handle); resolve({ ok: true, value }) } },
      () => { if (!settled) { settled = true; timers.clearTimeout(handle); resolve({ ok: false, why: 'error' }) } }
    )
  })
}
