// The edit list of a layered Run (ADR-0043): cuts as time ranges on the Run's recording clock, in
// milliseconds. Stored in the source-preserving sidecar `<runId>.edits.json`; the recording itself is
// never changed. Pure: main writes the file (recording-edits-store.ts), the renderer and the export read
// the same functions, so the player and the exported video skip exactly the same time.
//
// The model is general on purpose: any number of cut ranges, merged when they touch, split when a
// range inside one is restored. Release 0.44 offers two of them (Trim start, Trim end); the 0.45
// editor adds word and slide cuts on the same list and the same history, and slide edit boundaries
// (version 4): where the owner moved the start of a slide's words.

export type TimeRange = { start: number; end: number }

/**
 * Where the owner moved the start of a slide's words (the Slide boundary rule, rule 4). `change` names
 * the slide change it replaces: the Run-time of that slide's `enter` event, in whole milliseconds.
 * `at` is the new start in Run time. `any` is true when it was put on a word rather than a clear pause.
 */
export type EditBoundary = { change: number; at: number; any?: true }
/**
 * One step of the history: the whole cut list, the whole boundary list, the slides left out and the
 * finishing choices, before (or after) a change.
 */
export type EditsHistoryEntry = { cuts: TimeRange[]; boundaries: EditBoundary[]; leftOut: number[]; finish: RecordingFinish; faces: RecordingFaces; takes: ChosenTake[] }

/** The take used for a slide ("Record this slide again"): its slide change and the take's Run id. None: the first take. */
export type ChosenTake = { change: number; run: string }
const TAKE_ID = /^[A-Za-z0-9_-]{1,80}$/
function validTakes(v: unknown): v is ChosenTake[] {
  return Array.isArray(v) && v.length <= MAX_RANGES && v.every((t) => t && typeof t === 'object' && Number.isFinite((t as ChosenTake).change) && typeof (t as ChosenTake).run === 'string' && TAKE_ID.test((t as ChosenTake).run))
}
function normaliseTakes(v: readonly ChosenTake[]): ChosenTake[] {
  const by = new Map<number, string>()
  for (const t of v) by.set(Math.max(0, Math.round(t.change)), t.run)
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([change, run]) => ({ change, run }))
}

/**
 * Where the face appears (the design's "picture" contract): In the corner (a corner and a size), Side by
 * side, Face only, Slide only (the camera hidden). Only the bottom corners are offered: a talk's slide
 * titles sit at the top, and a face in a top corner would cover them.
 */
export type FaceLayout = 'corner' | 'side' | 'face' | 'slide'
export type FaceCorner = 'bottom-right' | 'bottom-left'
export type FaceSize = 'small' | 'medium' | 'large'
export type FacePlacement = { layout: FaceLayout; corner: FaceCorner; size: FaceSize }
/** 0.44's one placement, and every slide's until it is changed. */
export const DEFAULT_FACE: FacePlacement = { layout: 'corner', corner: 'bottom-right', size: 'medium' }
/** The whole video's placement, and slides placed otherwise, each named by its slide change. */
export type RecordingFaces = { all: FacePlacement; slides: Array<{ change: number; face: FacePlacement }> }
const FACE_LAYOUTS: readonly FaceLayout[] = ['corner', 'side', 'face', 'slide']
const FACE_CORNERS: readonly FaceCorner[] = ['bottom-right', 'bottom-left']
const FACE_SIZES: readonly FaceSize[] = ['small', 'medium', 'large']
export function emptyFaces(): RecordingFaces { return { all: { ...DEFAULT_FACE }, slides: [] } }
export function validFace(v: unknown): v is FacePlacement {
  const f = v as FacePlacement
  return !!f && typeof f === 'object' && !Array.isArray(f) && FACE_LAYOUTS.includes(f.layout) && FACE_CORNERS.includes(f.corner) && FACE_SIZES.includes(f.size)
}
function validFaces(v: unknown): v is RecordingFaces {
  const f = v as RecordingFaces
  return !!f && typeof f === 'object' && validFace(f.all) && Array.isArray(f.slides) && f.slides.length <= MAX_RANGES && f.slides.every((e) => e && Number.isFinite(e.change) && validFace(e.face))
}
const sameFace = (a: FacePlacement, b: FacePlacement): boolean => a.layout === b.layout && a.corner === b.corner && a.size === b.size
/** Sorted by change, one entry per slide, and none that says what the whole video says. */
function normaliseFaces(f: RecordingFaces): RecordingFaces {
  const by = new Map<number, FacePlacement>()
  for (const e of f.slides) by.set(Math.max(0, Math.round(e.change)), { layout: e.face.layout, corner: e.face.corner, size: e.face.size })
  const all = { layout: f.all.layout, corner: f.all.corner, size: f.all.size }
  return { all, slides: [...by.entries()].filter(([, face]) => !sameFace(face, all)).sort((a, b) => a[0] - b[0]).map(([change, face]) => ({ change, face })) }
}
/** The placement of the slide that starts at slide change `change`. */
export function faceOf(faces: RecordingFaces, change: number): FacePlacement {
  return faces.slides.find((e) => e.change === Math.round(change))?.face ?? faces.all
}
const sameFaces = (a: RecordingFaces, b: RecordingFaces): boolean => sameFace(a.all, b.all) && a.slides.length === b.slides.length && a.slides.every((e, i) => e.change === b.slides[i].change && sameFace(e.face, b.slides[i].face))

/**
 * Version written by this build. 5 (release 0.44.5) adds where the face appears (`faces`) and makes it and
 * the finishing choices (camera, even volume, smooth joins) part of the history, so each is one undoable step; 4 (release 0.44) is read with its
 * history steps keeping the finishing choices the file has. 4 added `boundaries` (moved slide starts),
 * `leftOut` (slides left out of the video, named by their slide change) and history entries holding all
 * three; 3 is read with none of either and its history as cut lists. 1 and 2 are PR 316's flat-recording
 * sidecars, read as cuts only.
 */
export const RECORDING_EDITS_VERSION = 5
/** Undo and redo each keep at most this many steps, also across reopening (persisted in the sidecar). */
export const EDIT_HISTORY_LIMIT = 100
/** A sidecar larger than this is refused rather than parsed. */
export const EDITS_MAX_BYTES = 8 * 1024 * 1024
/**
 * The store never writes more than this (well under EDITS_MAX_BYTES, so the same build always reopens
 * what it wrote). Over budget, the oldest undo steps go first, then the oldest redo steps; if the cuts
 * alone are too large the change is refused. See fitEditsBudget.
 */
export const EDITS_WRITE_BUDGET = 6 * 1024 * 1024
const MAX_RANGES = 10_000

/**
 * The finishing choices for the whole video ("Look and sound"). `camera`: the camera picture is in the
 * video. `evenVolume`: the voice is evened out (EVEN_VOLUME in recording-video.ts). `smoothJoins`: every
 * join an edit made crossfades the sound and dissolves the picture; off, the sound only fades out and in.
 */
export type RecordingFinish = { camera: boolean; evenVolume: boolean; smoothJoins: boolean }
/** A new recording, and a sidecar written before a choice existed: everything on (the design's defaults). */
export const DEFAULT_FINISH: RecordingFinish = { camera: true, evenVolume: true, smoothJoins: true }
const FINISH_KEYS = ['camera', 'evenVolume', 'smoothJoins'] as const
export type RecordingEdits = {
  version: typeof RECORDING_EDITS_VERSION
  /** Increments on every saved change; a write naming an older revision is refused. */
  revision: number
  /**
   * The recording these edits belong to (recordingFingerprint). A sidecar naming another recording is
   * refused and kept, never applied. Absent only in files written before it existed (adopted on the
   * next save).
   */
  recording?: string
  cuts: TimeRange[]
  /** Moved slide starts, sorted by `change`, one per slide change at most. */
  boundaries: EditBoundary[]
  /**
   * Slides left out of the video, each named by its slide change (the `change` of EditBoundary). Kept as
   * a fact of its own, not merged into the cuts: the plan resolves each into a cut spanning that slide at
   * its edit boundaries, so putting a slide back removes this fact and nothing else.
   */
  leftOut: number[]
  /** Parts of the Run's own Trims (Studio's transcript trims) the owner restored. Read from PR 316's sidecars. */
  restoredTrims: TimeRange[]
  /** Earlier states (cuts and boundaries), oldest first; the last entry is what Undo returns to. */
  undo: EditsHistoryEntry[]
  /** States undone, oldest first; the last entry is what Redo returns to. */
  redo: EditsHistoryEntry[]
  /** Finishing choices for the whole video; each change is one undo step (version 5). */
  finish: RecordingFinish
  /** Where the face appears, for the whole video and per slide (version 5). */
  faces: RecordingFaces
  /** The take used for each slide recorded again (version 5); a slide not listed uses the recording's own. */
  takes: ChosenTake[]
}

export type EditOp =
  | { kind: 'cut'; ranges: TimeRange[] }
  | { kind: 'restore'; ranges: TimeRange[] }
  /** Keep the recording from `at`; 0 keeps it from the beginning. */
  | { kind: 'trim-start'; at: number }
  /** Keep the recording up to `at`; the Run's length keeps it to the end. */
  | { kind: 'trim-end'; at: number }
  /** "Use the whole recording": remove every cut. */
  | { kind: 'restore-all' }
  /** Move the start of a slide's words (`at`, Run time) or put it back where it was (`at: null`). */
  | { kind: 'boundary'; change: number; at: number | null; any?: boolean }
  /** Leave the slide that starts at slide change `change` out of the video (`out: true`) or put it back. */
  | { kind: 'leave-out'; change: number; out: boolean }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'finish'; finish: Partial<RecordingFinish> }
  /**
   * Where the face appears. `changes: null` is the whole video (every slide follows it again);
   * otherwise those slides, by their slide changes. `face: null` puts those slides back to the whole video's.
   */
  | { kind: 'face'; changes: number[] | null; face: FacePlacement | null }
  /** Use take `run` for the slide that starts at slide change `change`; `run: null` goes back to the first take. */
  | { kind: 'take'; change: number; run: string | null }

export type EditsProblem = { kind: 'newer' | 'corrupt' | 'stale'; message: string }
/** What a sidecar is checked against when read. */
export type EditsContext = {
  /** This recording's fingerprint (recordingFingerprint of the Run). */
  fingerprint?: string
  /** The Run's own Trims. */
  runTrims?: readonly TimeRange[]
  /** PR 316's source identity of this recording for its sidecar version, or null when it cannot be computed. */
  legacySource?: (version: 1 | 2) => string | null
}
export type ParsedEdits = { ok: true; edits: RecordingEdits; from: 1 | 2 | 3 | 4 | 5 | null } | { ok: false; problem: EditsProblem }

export function emptyEdits(): RecordingEdits {
  return { version: RECORDING_EDITS_VERSION, revision: 0, cuts: [], boundaries: [], leftOut: [], restoredTrims: [], undo: [], redo: [], finish: { ...DEFAULT_FINISH }, faces: emptyFaces(), takes: [] }
}

/** Sorted, merged, whole milliseconds inside [0, duration]; empty and invalid ranges dropped. */
export function normaliseRanges(ranges: readonly TimeRange[], durationMs: number): TimeRange[] {
  const out: TimeRange[] = []
  const clean = ranges
    .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => ({ start: Math.max(0, Math.round(r.start)), end: Math.min(durationMs, Math.round(r.end)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  for (const r of clean) {
    const last = out.at(-1)
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/** Remove `span` from the cuts, splitting a cut that contains it. */
export function restoreRange(cuts: readonly TimeRange[], span: TimeRange): TimeRange[] {
  return cuts.flatMap((c) =>
    c.end <= span.start || c.start >= span.end
      ? [{ ...c }]
      : [...(c.start < span.start ? [{ start: c.start, end: span.start }] : []), ...(c.end > span.end ? [{ start: span.end, end: c.end }] : [])]
  )
}

/** Where the kept recording starts: the end of a cut that begins at 0, else 0. */
export function trimStartAt(cuts: readonly TimeRange[]): number {
  return cuts[0]?.start === 0 ? cuts[0].end : 0
}
/** Where the kept recording ends: the start of a cut that ends at the Run's length, else the length. */
export function trimEndAt(cuts: readonly TimeRange[], durationMs: number): number {
  const last = cuts.at(-1)
  return last && last.end >= durationMs ? last.start : durationMs
}

function sameCuts(a: readonly TimeRange[], b: readonly TimeRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.start === b[i].start && r.end === b[i].end)
}

function validRanges(value: unknown): value is TimeRange[] {
  return Array.isArray(value) && value.length <= MAX_RANGES && value.every((r) => r && typeof r === 'object' && Number.isFinite((r as TimeRange).start) && Number.isFinite((r as TimeRange).end))
}

function validBoundaries(value: unknown): value is EditBoundary[] {
  return Array.isArray(value) && value.length <= MAX_RANGES && value.every((b) => b && typeof b === 'object' && !Array.isArray(b) &&
    Number.isFinite((b as EditBoundary).change) && Number.isFinite((b as EditBoundary).at) && ((b as EditBoundary).any === undefined || (b as EditBoundary).any === true))
}

/** Whole milliseconds, `at` inside [0, duration], sorted by the change they move, the last of duplicates kept. */
export function normaliseBoundaries(boundaries: readonly EditBoundary[], durationMs: number): EditBoundary[] {
  const byChange = new Map<number, EditBoundary>()
  for (const b of boundaries) {
    if (!b || !Number.isFinite(b.change) || !Number.isFinite(b.at)) continue
    const change = Math.round(b.change)
    byChange.set(change, { change, at: Math.max(0, Math.min(durationMs, Math.round(b.at))), ...(b.any ? { any: true as const } : {}) })
  }
  return [...byChange.values()].sort((a, b) => a.change - b.change)
}

function validLeftOut(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= MAX_RANGES && value.every((c) => Number.isFinite(c))
}
/** Whole milliseconds, sorted, without duplicates. */
export function normaliseLeftOut(leftOut: readonly number[]): number[] {
  return [...new Set(leftOut.filter((c) => Number.isFinite(c)).map((c) => Math.max(0, Math.round(c))))].sort((a, b) => a - b)
}

function sameBoundaries(a: readonly EditBoundary[], b: readonly EditBoundary[]): boolean {
  return a.length === b.length && a.every((x, i) => x.change === b[i].change && x.at === b[i].at && !!x.any === !!b[i].any)
}

/** The next boundary list for a boundary operation, or null when it changes nothing. Throws on bad input. */
function nextBoundaries(boundaries: EditBoundary[], op: Extract<EditOp, { kind: 'boundary' }>, durationMs: number): EditBoundary[] | null {
  if (!Number.isFinite(op.change) || (op.at !== null && !Number.isFinite(op.at))) throw Error('Invalid slide start')
  const change = Math.round(op.change)
  const rest = boundaries.filter((b) => b.change !== change)
  const next = op.at === null ? rest : normaliseBoundaries([...rest, { change, at: op.at, ...(op.any ? { any: true as const } : {}) }], durationMs)
  if (next.length > MAX_RANGES) throw Error('Too many moved slide starts')
  return sameBoundaries(next, boundaries) ? null : next
}

/** The next cut list for an operation, or null when the operation changes nothing. Throws on bad input. */
function nextCuts(cuts: TimeRange[], op: EditOp, durationMs: number): TimeRange[] | null {
  const at = (value: number): number => {
    if (!Number.isFinite(value)) throw Error('Invalid edit time')
    return Math.max(0, Math.min(durationMs, Math.round(value)))
  }
  let next: TimeRange[]
  switch (op.kind) {
    case 'cut':
    case 'restore':
      if (!validRanges(op.ranges)) throw Error('Invalid edit ranges')
      next = op.kind === 'cut'
        ? normaliseRanges([...cuts, ...op.ranges], durationMs)
        : normaliseRanges(op.ranges.reduce((all, r) => restoreRange(all, r), cuts), durationMs)
      break
    case 'trim-start': {
      const t = at(op.at)
      if (t >= trimEndAt(cuts, durationMs)) throw Error('The start must come before the end')
      const without = cuts[0]?.start === 0 ? cuts.slice(1) : cuts
      next = normaliseRanges(t > 0 ? [{ start: 0, end: t }, ...without] : without, durationMs)
      break
    }
    case 'trim-end': {
      const t = at(op.at)
      if (t <= trimStartAt(cuts)) throw Error('The end must come after the start')
      const last = cuts.at(-1)
      const without = last && last.end >= durationMs ? cuts.slice(0, -1) : cuts
      next = normaliseRanges(t < durationMs ? [...without, { start: t, end: durationMs }] : without, durationMs)
      break
    }
    case 'restore-all':
      next = []
      break
    default:
      throw Error('Unknown edit')
  }
  if (!next.length && cuts.length === 0) return null
  if (sameCuts(next, cuts)) return null
  // Nothing may be left: a recording with no kept time cannot be played or exported.
  if (keptMs(next, durationMs) <= 0) throw Error('That would cut the whole recording')
  return next
}

/**
 * Apply one operation. Each change is one undo step; a change clears Redo. Returns the same object when
 * nothing changes (the caller then writes nothing).
 */
export function applyEditOp(edits: RecordingEdits, op: EditOp, durationMs: number): RecordingEdits {
  if (!op || typeof op !== 'object') throw Error('Unknown edit')
  const now: EditsHistoryEntry = { cuts: edits.cuts, boundaries: edits.boundaries, leftOut: edits.leftOut, finish: edits.finish, faces: edits.faces, takes: edits.takes }
  if (op.kind === 'undo' || op.kind === 'redo') {
    const from = op.kind === 'undo' ? edits.undo : edits.redo
    const target = from.at(-1)
    if (!target) return edits
    const rest = from.slice(0, -1)
    const other = [...(op.kind === 'undo' ? edits.redo : edits.undo), now].slice(-EDIT_HISTORY_LIMIT)
    return { ...edits, revision: edits.revision + 1, cuts: target.cuts, boundaries: target.boundaries, leftOut: target.leftOut, finish: target.finish, faces: target.faces, takes: target.takes, undo: op.kind === 'undo' ? rest : other, redo: op.kind === 'undo' ? other : rest }
  }
  if (op.kind === 'boundary') {
    const next = nextBoundaries(edits.boundaries, op, durationMs)
    if (!next) return edits
    return { ...edits, revision: edits.revision + 1, boundaries: next, undo: [...edits.undo, now].slice(-EDIT_HISTORY_LIMIT), redo: [] }
  }
  if (op.kind === 'leave-out') {
    if (!Number.isFinite(op.change) || typeof op.out !== 'boolean') throw Error('Invalid slide')
    const change = Math.max(0, Math.round(op.change))
    const has = edits.leftOut.includes(change)
    if (has === op.out) return edits
    const next = op.out ? normaliseLeftOut([...edits.leftOut, change]) : edits.leftOut.filter((c) => c !== change)
    if (next.length > MAX_RANGES) throw Error('Too many slides left out')
    return { ...edits, revision: edits.revision + 1, leftOut: next, undo: [...edits.undo, now].slice(-EDIT_HISTORY_LIMIT), redo: [] }
  }
  if (op.kind === 'take') {
    if (!Number.isFinite(op.change) || (op.run !== null && (typeof op.run !== 'string' || !TAKE_ID.test(op.run)))) throw Error('Invalid take')
    const change = Math.max(0, Math.round(op.change))
    const next = normaliseTakes([...edits.takes.filter((t) => t.change !== change), ...(op.run ? [{ change, run: op.run }] : [])])
    if (next.length === edits.takes.length && next.every((t, i) => t.change === edits.takes[i].change && t.run === edits.takes[i].run)) return edits
    return { ...edits, revision: edits.revision + 1, takes: next, undo: [...edits.undo, now].slice(-EDIT_HISTORY_LIMIT), redo: [] }
  }
  if (op.kind === 'face') {
    if ((op.face !== null && !validFace(op.face)) || (op.changes !== null && (!Array.isArray(op.changes) || op.changes.length > MAX_RANGES || !op.changes.every(Number.isFinite)))) throw Error('Invalid face position')
    if (op.changes === null && op.face === null) throw Error('Invalid face position')
    const changes = op.changes?.map((c) => Math.max(0, Math.round(c))) ?? []
    const next = normaliseFaces(op.changes === null
      ? { all: op.face as FacePlacement, slides: [] }
      : { all: edits.faces.all, slides: [...edits.faces.slides.filter((e) => !changes.includes(e.change)), ...(op.face ? changes.map((change) => ({ change, face: op.face as FacePlacement })) : [])] })
    if (sameFaces(next, edits.faces)) return edits
    return { ...edits, revision: edits.revision + 1, faces: next, undo: [...edits.undo, now].slice(-EDIT_HISTORY_LIMIT), redo: [] }
  }
  if (op.kind === 'finish') {
    const asked = op.finish
    if (!asked || typeof asked !== 'object') throw Error('Invalid export choice')
    const next = { ...edits.finish }
    for (const key of FINISH_KEYS) {
      if (asked[key] === undefined) continue
      if (typeof asked[key] !== 'boolean') throw Error('Invalid export choice')
      next[key] = asked[key] as boolean
    }
    if (FINISH_KEYS.every((k) => next[k] === edits.finish[k])) return edits
    return { ...edits, revision: edits.revision + 1, finish: next, undo: [...edits.undo, now].slice(-EDIT_HISTORY_LIMIT), redo: [] }
  }
  const next = nextCuts(edits.cuts, op, durationMs)
  if (!next) return edits
  return { ...edits, revision: edits.revision + 1, cuts: next, undo: [...edits.undo, now].slice(-EDIT_HISTORY_LIMIT), redo: [] }
}

/**
 * Read a sidecar's parsed JSON. Missing (null) is a fresh list. PR 316's versions 1 and 2 are read as
 * their cuts with an empty history. A newer version or anything malformed is a stated problem, never a
 * silent reset: the caller keeps the file and refuses to write until the owner chooses to start afresh.
 */
/** Identifies one recording: a new Run that happens to get the same talk and id has a different start. */
export function recordingFingerprint(run: { id: string; talkSlug: string; startedAt?: unknown; recordingMs?: unknown }): string {
  return `${run.talkSlug}/${run.id}@${String(run.startedAt ?? '')}/${Math.round(Number(run.recordingMs) || 0)}`
}

export function parseEdits(raw: unknown, durationMs: number, context: EditsContext = {}): ParsedEdits {
  if (raw === null || raw === undefined) return { ok: true, edits: emptyEdits(), from: null }
  const corrupt: ParsedEdits = { ok: false, problem: { kind: 'corrupt', message: 'The saved edits for this recording could not be read.' } }
  if (typeof raw !== 'object' || Array.isArray(raw)) return corrupt
  const value = raw as Record<string, unknown>
  const version = value.version
  if (typeof version === 'number' && Number.isInteger(version) && version > RECORDING_EDITS_VERSION)
    return { ok: false, problem: { kind: 'newer', message: 'The saved edits for this recording were made by a newer version of TalkWeaver.' } }
  const stale: ParsedEdits = { ok: false, problem: { kind: 'stale', message: 'The saved edits beside this recording were made for a different recording.' } }
  if (version === 1 || version === 2) {
    if (!validRanges(value.cuts) || (version === 2 && !validRanges(value.restoredLegacy))) return corrupt
    // PR 316 bound its sidecar to the recording by a source hash. Only a sidecar whose binding this
    // recording reproduces is migrated; anything else was made for another recording.
    const expected = context.legacySource?.(version) ?? null
    if (expected === null || value.source !== expected) return stale
    const trims = normaliseRanges((context.runTrims ?? []) as TimeRange[], durationMs)
    const cuts = normaliseRanges(value.cuts, durationMs)
    // Version 2 stores added cuts and restored Trims; version 1 stored the whole effective cut list,
    // so any Trim it does not cover had been restored.
    const restoredTrims = version === 2
      ? normaliseRanges(value.restoredLegacy as TimeRange[], durationMs)
      : normaliseRanges(cuts.reduce((rest, c) => restoreRange(rest, c), trims), durationMs)
    return { ok: true, from: version, edits: { ...emptyEdits(), cuts, restoredTrims } }
  }
  if (version !== 3 && version !== 4 && version !== RECORDING_EDITS_VERSION) return corrupt
  const revision = value.revision
  // Version 3 kept cut lists only; version 4 keeps cuts, boundaries and slides left out in each step;
  // version 5 adds the finishing choices to each step.
  const entryOk = (e: unknown): boolean => version === 3 ? validRanges(e)
    : !!e && typeof e === 'object' && !Array.isArray(e) && validRanges((e as EditsHistoryEntry).cuts) && validBoundaries((e as EditsHistoryEntry).boundaries) && ((e as EditsHistoryEntry).leftOut === undefined || validLeftOut((e as EditsHistoryEntry).leftOut))
      // A version 5 step names its finish, faces and takes; one without them keeps the document's (as a version 4 step does).
      && (version === 4 ? (e as EditsHistoryEntry).finish === undefined && (e as EditsHistoryEntry).faces === undefined
        : ((e as EditsHistoryEntry).finish === undefined || validFinish((e as EditsHistoryEntry).finish)) && ((e as EditsHistoryEntry).faces === undefined || validFaces((e as EditsHistoryEntry).faces)) && ((e as EditsHistoryEntry).takes === undefined || validTakes((e as EditsHistoryEntry).takes)))
  const history = (h: unknown): h is unknown[] => Array.isArray(h) && h.length <= EDIT_HISTORY_LIMIT && h.every(entryOk)
  const finish = value.finish as Record<string, unknown> | undefined
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 || !validRanges(value.cuts) || !history(value.undo) || !history(value.redo)) return corrupt
  if (version !== 3 ? !validBoundaries(value.boundaries) || (value.leftOut !== undefined && !validLeftOut(value.leftOut)) : value.boundaries !== undefined || value.leftOut !== undefined) return corrupt
  if (finish !== undefined && !validFinish(finish)) return corrupt
  if (version === RECORDING_EDITS_VERSION ? !validFaces(value.faces) || !validTakes(value.takes) : value.faces !== undefined || value.takes !== undefined) return corrupt
  if (value.restoredTrims !== undefined && !validRanges(value.restoredTrims)) return corrupt
  if (value.recording !== undefined && typeof value.recording !== 'string') return corrupt
  if (typeof value.recording === 'string' && context.fingerprint !== undefined && value.recording !== context.fingerprint) return stale
  const norm = (r: TimeRange[]): TimeRange[] => normaliseRanges(r, durationMs)
  const finishNow = readFinish(finish)
  const facesNow = version === RECORDING_EDITS_VERSION ? normaliseFaces(value.faces as RecordingFaces) : emptyFaces()
  const takesNow = version === RECORDING_EDITS_VERSION ? normaliseTakes(value.takes as ChosenTake[]) : []
  // Before version 5 the finishing choices were not in the history: undoing an older step keeps them as they are.
  const step = (e: unknown): EditsHistoryEntry => version === 3
    ? { cuts: norm(e as TimeRange[]), boundaries: [], leftOut: [], finish: finishNow, faces: facesNow, takes: takesNow }
    : { cuts: norm((e as EditsHistoryEntry).cuts), boundaries: normaliseBoundaries((e as EditsHistoryEntry).boundaries, durationMs), leftOut: normaliseLeftOut((e as EditsHistoryEntry).leftOut ?? []),
      finish: (e as EditsHistoryEntry).finish === undefined ? finishNow : readFinish((e as EditsHistoryEntry).finish),
      faces: (e as EditsHistoryEntry).faces === undefined ? facesNow : normaliseFaces((e as EditsHistoryEntry).faces),
      takes: (e as EditsHistoryEntry).takes === undefined ? takesNow : normaliseTakes((e as EditsHistoryEntry).takes) }
  return {
    ok: true,
    from: version,
    edits: {
      version: RECORDING_EDITS_VERSION,
      revision: revision as number,
      ...(typeof value.recording === 'string' ? { recording: value.recording } : {}),
      cuts: norm(value.cuts),
      boundaries: version === 3 ? [] : normaliseBoundaries(value.boundaries as EditBoundary[], durationMs),
      // The first build of version 4 wrote no `leftOut`: absent means none.
      leftOut: version === 3 ? [] : normaliseLeftOut((value.leftOut as number[] | undefined) ?? []),
      restoredTrims: norm((value.restoredTrims as TimeRange[] | undefined) ?? []),
      undo: (value.undo as unknown[]).map(step),
      redo: (value.redo as unknown[]).map(step),
      finish: finishNow,
      faces: facesNow,
      takes: takesNow
    }
  }
}

/** A stored finish: an object whose known choices, where present, are true or false. */
function validFinish(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return FINISH_KEYS.every((k) => (value as Record<string, unknown>)[k] === undefined || typeof (value as Record<string, unknown>)[k] === 'boolean')
}
/** The stored choices, each absent one at its default. */
function readFinish(value: unknown): RecordingFinish {
  const v = (value ?? {}) as Partial<RecordingFinish>
  return { camera: v.camera !== false, evenVolume: v.evenVolume !== false, smoothJoins: v.smoothJoins !== false }
}

/**
 * Read a sidecar from its exact bytes: the size limit, the JSON and parseEdits, in one place. The store
 * reads every sidecar through this and checks every write with it before writing, so the writer can
 * never produce a file the reader refuses.
 */
export function parseEditsText(text: string, durationMs: number, context: EditsContext = {}): ParsedEdits {
  const corrupt: ParsedEdits = { ok: false, problem: { kind: 'corrupt', message: 'The saved edits for this recording could not be read.' } }
  if (new TextEncoder().encode(text).length > EDITS_MAX_BYTES) return corrupt
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return corrupt }
  return parseEdits(raw, durationMs, context)
}

/** Total kept time. */
export function keptMs(cuts: readonly TimeRange[], durationMs: number): number {
  return durationMs - cuts.reduce((sum, c) => sum + Math.max(0, Math.min(durationMs, c.end) - Math.max(0, c.start)), 0)
}

/** Run time to edited time. A time inside a cut maps to the join where that cut was removed. */
export function runToEdited(runMs: number, cuts: readonly TimeRange[]): number {
  let removed = 0
  for (const c of cuts) {
    if (runMs <= c.start) break
    removed += Math.min(runMs, c.end) - c.start
  }
  return runMs - removed
}

/** Edited time to Run time; a join maps to the first kept moment after it. */
export function editedToRun(editedMs: number, cuts: readonly TimeRange[]): number {
  let t = editedMs
  for (const c of cuts) {
    if (t < c.start) break
    t += c.end - c.start
  }
  return t
}

/** The cut that contains `runMs`, if any. */
export function cutAt(runMs: number, cuts: readonly TimeRange[]): TimeRange | null {
  return cuts.find((c) => runMs >= c.start && runMs < c.end) ?? null
}

/**
 * The effective cuts of a Run: the sidecar's cuts plus the Trims saved on the Run itself (Studio's
 * segment trims), less the parts of those Trims the owner restored.
 */
export function effectiveCuts(sidecarCuts: readonly TimeRange[], runTrims: readonly TimeRange[] | undefined, durationMs: number, restoredTrims: readonly TimeRange[] = []): TimeRange[] {
  const trims = restoredTrims.reduce((rest, r) => restoreRange(rest, r), normaliseRanges((runTrims ?? []) as TimeRange[], durationMs))
  return normaliseRanges([...sidecarCuts, ...trims], durationMs)
}

/** The bytes the store writes for a document. */
export function serialiseEdits(edits: RecordingEdits): string {
  return JSON.stringify(edits) + '\n'
}

/**
 * Keep a document within EDITS_WRITE_BUDGET: drop the oldest undo steps first, then the oldest redo
 * steps. Returns null when the cuts alone exceed the budget (the change is then refused).
 */
export function fitEditsBudget(edits: RecordingEdits, budget = EDITS_WRITE_BUDGET): RecordingEdits | null {
  const bytes = (text: string): number => new TextEncoder().encode(text).length
  let total = bytes(serialiseEdits(edits))
  if (total <= budget) return edits
  const undo = [...edits.undo], redo = [...edits.redo]
  // Each history entry costs its JSON plus a separating comma.
  while (total > budget && undo.length) total -= bytes(JSON.stringify(undo.shift())) + 1
  while (total > budget && redo.length) total -= bytes(JSON.stringify(redo.shift())) + 1
  const next = { ...edits, undo, redo }
  return bytes(serialiseEdits(next)) <= budget ? next : null
}
