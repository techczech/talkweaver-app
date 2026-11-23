// Where the editor's commands go in time when new takes are in the video (Record this slide again).
// The edits are stored on the Run's clock (the recording as it was); the player and the export play the
// video clock (recording-takes.ts), where each chosen take is inserted where its slide starts. Every command
// that seeks, stops, highlights or places an edit at the playhead goes through one of these, so none of them
// reads a Run time as a video time. The table in the 0.44.5 build record lists each command with its clock;
// scripts/test-recording-clock-matrix.mjs runs them over takes before, at, inside and after a position and
// two takes at one point.
import { normaliseRanges, type EditOp, type TimeRange } from './recording-edits.ts'
import { rowAtPlayback, rowVideoStart, wordAt, type EditorWords, type ResolvedRecording } from './recording-editor.ts'
import { fromVideoClock, rangesToVideoClock, runStartOnVideoClock, takeAt, toVideoClock, type TakeClock } from './recording-takes.ts'
import { JOIN_FADE_MS, keptSpans, planEditedToRun, planRunToEdited, type KeptSpan } from './recording-video.ts'

export { rowAtPlayback, rowVideoStart }

type Resolved = Pick<ResolvedRecording, 'clock' | 'clockCuts' | 'clockMs' | 'spans'>

/**
 * Playing a stretch of the Run's own words (a word, a selection, a word moved to by the keyboard): from
 * where its first word plays to where its last word ends, on the video clock. A take that goes in between
 * the stretch's lead-in pause and its first word plays before the stretch, so the stretch starts after it; a
 * take that goes in between its last word and its tail pause plays after it, so the stretch stops before it.
 * Takes that go in between its words play inside it, as in the video.
 */
export function runStretchPlayback(r: Pick<ResolvedRecording, 'clock'>, range: TimeRange, words: { firstStart: number; lastEnd: number } = { firstStart: range.start, lastEnd: range.end }): { from: number; until: number } {
  let start = range.start, end = range.end
  for (const i of r.clock.inserts) if (i.at > start && i.at <= words.firstStart) start = i.at
  for (const i of r.clock.inserts) if (i.at >= words.lastEnd && i.at < end) end = i.at
  const from = runStartOnVideoClock(r.clock, start)
  return { from, until: Math.max(from, toVideoClock(r.clock, end)) }
}

/** The kept spans the player plays, on the video clock, with an extra cut being tried (Run time) added. */
export function previewSpans(r: Resolved, extraRunCuts: readonly TimeRange[] = []): KeptSpan[] {
  if (!extraRunCuts.length) return r.spans
  return keptSpans(normaliseRanges([...r.clockCuts, ...rangesToVideoClock(r.clock, extraRunCuts)], r.clockMs), r.clockMs)
}

/**
 * Listen to the join: a second either side of the join a cut makes, as the video plays it (takes included),
 * on the video clock. The join is where the cut's Run material started, after any takes that go in there.
 */
export function joinPlayback(r: Resolved, cut: TimeRange, extraRunCuts: readonly TimeRange[] = []): { from: number; until: number } {
  const plan = previewSpans(r, extraRunCuts)
  const join = planRunToEdited(plan, runStartOnVideoClock(r.clock, cut.start))
  return { from: planEditedToRun(plan, Math.max(0, join - 1000)), until: planEditedToRun(plan, join + 1000) }
}

/** Why a trim cannot go at the playhead. */
export const TRIM_IN_TAKE = 'A trim cannot go inside a new take, or between two takes, or just after one. Move the playhead to the recording itself and try again.'

/**
 * Trim start here / Trim end here at the playhead (video time). The trim is stored on the Run's clock; it
 * goes where the playhead is only when that video moment is the Run moment's own place: in the recording's
 * own time, or at the start of the first take where takes go in. Inside a take, at a later take of several at
 * one point, or just after a take, no Run time says the same, so it is refused.
 */
export function trimAtPlayhead(r: Pick<ResolvedRecording, 'clock'>, kind: 'trim-start' | 'trim-end', videoMs: number): { ok: true; op: EditOp } | { ok: false; error: string } {
  const at = fromVideoClock(r.clock, videoMs)
  if (Math.abs(toVideoClock(r.clock, at) - videoMs) > 1) return { ok: false, error: TRIM_IN_TAKE }
  return { ok: true, op: { kind, at } }
}

/** Where a moment of the recording (a flag, a cut's start) plays on the video clock: after takes that go in there. */
export function runMomentOnVideo(clock: TakeClock, runMs: number): number {
  return runStartOnVideoClock(clock, runMs)
}

/** A flag in To check: its time in the edited video, and where Go plays from (three seconds of video before it). */
export function flagPlayback(r: Pick<ResolvedRecording, 'clock' | 'spans'>, flagMs: number): { editedMs: number; from: number } {
  const v = runMomentOnVideo(r.clock, flagMs)
  return { editedMs: planRunToEdited(r.spans, v), from: planEditedToRun(r.spans, Math.max(0, planRunToEdited(r.spans, v) - 3000)) }
}

/**
 * The word to highlight while playing (an index into ctx.words, or -1): none inside a new take (no word of the
 * recording plays there); otherwise the timed word at the Run time.
 */
export function wordAtPlayback(r: Pick<ResolvedRecording, 'clock'>, ctx: EditorWords, runMs: number, videoMs: number): number {
  if (takeAt(r.clock, videoMs)) return -1
  let w = ctx.words.length ? wordAt(ctx, runMs) : -1
  while (w >= 0 && !ctx.words[w].timed) w--
  return w
}

/** A Run-time track (timeline, overview, Studio's track) asked to go to a Run moment: there on the video clock (a slide start goes to its first take). */
export function trackSeek(r: Pick<ResolvedRecording, 'clock'>, runMs: number): number {
  return toVideoClock(r.clock, runMs)
}

/** Where the playhead is drawn on a Run-time track: its Run time (inside a take, the point the take goes in). */
export function trackPlayhead(r: Pick<ResolvedRecording, 'clock'>, videoMs: number): number {
  return fromVideoClock(r.clock, videoMs)
}

/**
 * The edges of every take on the video clock (its start and its end). The export treats each as a join:
 * with smooth joins the picture dissolves there, and the sound fades out and in (there is no removed
 * material to crossfade with).
 */
export function takeEdges(clock: TakeClock): number[] {
  return [...new Set(clock.inserts.flatMap((i) => [i.outAt, i.outAt + i.length]))].sort((a, b) => a - b)
}

/** The player's voice level at a take's edges (video ms): faded out and in over JOIN_FADE_MS each side, as the export does. */
export function edgeVolume(edgesMs: readonly number[], videoMs: number): number {
  let v = 1
  for (const e of edgesMs) v = Math.min(v, Math.abs(videoMs - e) / JOIN_FADE_MS)
  return Math.max(0, Math.min(1, v))
}
