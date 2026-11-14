// Record one slide again (docs/design/2026-11-10-record-and-edit-video, contract "retake"). A new take of
// a slide is a Run of its own (saved with `takeOf`); the edits file names the take chosen for each slide.
// Pure: the player and the export compose the video on one "video clock" made from the Run's clock with
// each chosen take inserted where its slide starts, and the slide's original stretch cut.
//
// Run time → video clock: a moment before a take's slide is unchanged; at or after it, later by the
// take's length. The slide's original stretch [row.start, row.end) is cut (the recording keeps it), so on
// the video clock the take plays where the slide was. Times inside a take have no Run time; they map back
// to the slide's start. With no take chosen the video clock is the Run clock.

/** A take chosen for a slide, as the edits file stores it: the slide change and the take's Run id. */
export type ChosenTake = { change: number; run: string }

/**
 * Record one slide again ships switched off in 0.44.5: its take paths still had open faults when the release
 * was cut (PR 373 holds the fixes for the next release). It is on only in a development build started with
 * TW_RECORD_AGAIN=1. Main decides (takesEnabled) and passes the answer to the editor with the opened recording.
 * Off: no control offers it, main refuses every take request, and take discovery returns none, so a
 * recording plays, exports, captions and is deleted as one without takes. Take choices already in an edits
 * file (only a development build can have written them) stay in the file and are not used.
 */
export const RECORD_AGAIN_ENV = 'TW_RECORD_AGAIN'
export const TAKES_OFF_ERROR = 'Recording a slide again is not available in this version of TalkWeaver.'
/** Undo or Redo of a step that would change the take choices, while off. */
export const TAKE_STEP_OFF_ERROR = 'This step belongs to recording a slide again, which is not available in this version.'
export function takesEnabled(context: { packaged: boolean; flag: unknown }): boolean {
  return !context.packaged && context.flag === '1'
}
/** The take choices the player, the export and the editor use: none while Record one slide again is off. */
export function takesInUse(enabled: boolean, chosen: readonly ChosenTake[] | undefined): ChosenTake[] {
  return enabled ? [...(chosen ?? [])] : []
}
/** What a slide row offers: Record this slide again, and the take chooser (Which take of slide n?). Nothing while off. */
export function rowTakeControls(enabled: boolean, row: { hasPicture: boolean; slideId: string; leftOut: boolean; takes: number }): { recordAgain: boolean; chooser: boolean } {
  if (!enabled) return { recordAgain: false, chooser: false }
  return { recordAgain: row.hasPicture && !!row.slideId && !row.leftOut, chooser: row.takes > 0 && !row.leftOut }
}
/** One insertion: at Run time `at` (the slide's start), `length` ms of the take `run`. */
export type TakeInsert = { at: number; length: number; run: string; change: number; end: number }
export type TakeClock = { inserts: TakeInsert[] }
export const NO_TAKES: TakeClock = { inserts: [] }

export function takeClock(inserts: readonly TakeInsert[]): TakeClock {
  return { inserts: [...inserts].filter((i) => i.length > 0).sort((a, b) => a.at - b.at) }
}

/** Run time to the video clock. The slide start itself goes to the start of its take. */
export function toVideoClock(clock: TakeClock, runMs: number): number {
  let t = runMs
  for (const i of clock.inserts) if (i.at < runMs) t += i.length
  return t
}

/** The video clock to Run time; a moment inside a take maps to its slide's start. */
export function fromVideoClock(clock: TakeClock, ms: number): number {
  let shift = 0
  for (const i of clock.inserts) {
    const start = i.at + shift
    if (ms < start) break
    if (ms < start + i.length) return i.at
    shift += i.length
  }
  return ms - shift
}

/** The take playing at a moment of the video clock, if any, with its own time. */
export function takeAt(clock: TakeClock, ms: number): { insert: TakeInsert; takeMs: number } | null {
  let shift = 0
  for (const i of clock.inserts) {
    const start = i.at + shift
    if (ms >= start && ms < start + i.length) return { insert: i, takeMs: ms - start }
    shift += i.length
  }
  return null
}

/** The video clock's length. */
export function videoClockMs(clock: TakeClock, durationMs: number): number {
  return durationMs + clock.inserts.reduce((n, i) => n + i.length, 0)
}

/** Ranges of Run time moved onto the video clock, each split where a take goes in inside it. */
export function rangesToVideoClock(clock: TakeClock, ranges: ReadonlyArray<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const movedAt = (a: number): number => clock.inserts.reduce((n, i) => n + (i.at <= a ? i.length : 0), 0)
  const out: Array<{ start: number; end: number }> = []
  for (const r of ranges) {
    const points = [r.start, ...clock.inserts.map((i) => i.at).filter((at) => at > r.start && at < r.end), r.end]
    for (let p = 0; p + 1 < points.length; p++) { const m = movedAt(points[p]); out.push({ start: points[p] + m, end: points[p + 1] + m }) }
  }
  return out.filter((r) => r.end > r.start)
}

/** A file of a layer placed on a clock: media time `offsetMs` at `startMs`; shown from `shownFromMs` (its first frame held). */
export type ClipPiece<T> = T & { startMs: number; endMs: number; offsetMs: number; shownFromMs: number }

/**
 * A Run's layer files on the video clock: each split at the takes inside it, later parts moved by the
 * takes before them; then each chosen take's own files, placed where its take starts. `takeFiles(run)`
 * gives a take's files on its own clock.
 */
export function clipsOnVideoClock<T extends { startMs: number; endMs: number }>(clock: TakeClock, run: readonly T[], takeFiles: (run: string) => readonly T[], holdFirst: (clip: T, first: boolean) => number): Array<ClipPiece<T>> {
  const out: Array<ClipPiece<T>> = []
  // A stretch starting at or after an insertion point plays after that take.
  const movedAt = (a: number): number => clock.inserts.reduce((n, i) => n + (i.at <= a ? i.length : 0), 0)
  run.forEach((clip, k) => {
    const shown = holdFirst(clip, k === 0)
    const points = [shown, ...clock.inserts.map((i) => i.at).filter((at) => at > shown && at < clip.endMs), clip.endMs]
    for (let p = 0; p + 1 < points.length; p++) {
      const a = points[p], b = points[p + 1], moved = movedAt(a), start = Math.max(a, clip.startMs)
      if (b > start || a < clip.startMs) out.push({ ...clip, startMs: start + moved, endMs: b + moved, offsetMs: start - clip.startMs, shownFromMs: a + moved })
    }
  })
  for (const i of clock.inserts) {
    const at = toVideoClock(clock, i.at)
    takeFiles(i.run).forEach((clip, k) => {
      const end = Math.min(clip.endMs, i.length)
      if (end <= clip.startMs) return
      const shown = Math.min(holdFirst(clip, k === 0), clip.startMs)
      out.push({ ...clip, startMs: at + clip.startMs, endMs: at + end, offsetMs: 0, shownFromMs: at + shown })
    })
  }
  return out
}

/** Record one slide again, as the editor asks main for it: the Run, the slide and whether the Run has a camera. */
export type RetakeContext = { runId: string; change: number; slideId: string; slideN: number; camera: boolean }
/** A retake request, checked: anything else is refused. */
export function parseRetake(value: unknown): RetakeContext | null {
  const v = value as RetakeContext | null
  if (!v || typeof v !== 'object' || typeof v.runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(v.runId) || !Number.isFinite(v.change) || typeof v.slideId !== 'string' || v.slideId.length > 200
    || !Number.isInteger(v.slideN) || v.slideN < 1 || v.slideN > 100_000 || typeof v.camera !== 'boolean') return null
  return { runId: v.runId, change: Math.max(0, Math.round(v.change)), slideId: v.slideId, slideN: v.slideN, camera: v.camera }
}

/**
 * Whether a saved Run is a new take of another Run's slide (Record this slide again). Takes are listed
 * with their Run in the editor only: every user-facing list of Runs (Runs, History, Sessions, published
 * pages, search, work files) leaves them out; internal enumerations (take discovery, deletion, id checks)
 * ask for them explicitly.
 */
export function isTakeRun(run: unknown): boolean {
  const t = run && typeof run === 'object' ? (run as { takeOf?: unknown }).takeOf : undefined
  return !!t && typeof t === 'object'
}

/**
 * A retake request checked against the Run it names, as read from disk by main: the Run exists in the
 * presented talk, is not itself a take, recorded the slide (an `enter` of `slideId` at slide change
 * `change`), and was recorded with layers. The camera choice is the Run's own, never the request's.
 * Returns the context to register, or why it is refused.
 */
export function verifyRetake(request: RetakeContext, parent: unknown, talkSlug: string): { ok: true; retake: RetakeContext } | { ok: false; error: string } {
  const p = parent as { id?: unknown; talkSlug?: unknown; takeOf?: unknown; slideTimeIndex?: unknown; capture?: { layers?: { slides?: { bytes?: number; segments?: Array<{ bytes?: number }> }; camera?: { bytes?: number; segments?: Array<{ bytes?: number }> } } } | null } | null
  if (!p || typeof p !== 'object' || p.id !== request.runId || p.talkSlug !== talkSlug) return { ok: false, error: 'The recording to record a slide again for is not in this talk.' }
  if (isTakeRun(p)) return { ok: false, error: 'A new take cannot itself be recorded again; choose the slide in its Run.' }
  const marks = Array.isArray(p.slideTimeIndex) ? p.slideTimeIndex as Array<{ event?: unknown; slideId?: unknown; tMs?: unknown }> : []
  const recorded = marks.some((m, i) => m && m.event === 'enter' && m.slideId === request.slideId && Number.isFinite(m.tMs) && (Math.round(m.tMs as number) === request.change || (i === 0 && request.change === 0)))
  if (!recorded) return { ok: false, error: 'That slide is not one this recording has.' }
  const has = (layer?: { bytes?: number; segments?: Array<{ bytes?: number }> }): boolean => !!layer && ((layer.bytes ?? 0) > 0 || !!layer.segments?.some((s) => (s.bytes ?? 0) > 0))
  if (!has(p.capture?.layers?.slides)) return { ok: false, error: 'This recording has no slides picture, so a slide cannot be recorded again.' }
  return { ok: true, retake: { ...request, camera: has(p.capture?.layers?.camera) } }
}
