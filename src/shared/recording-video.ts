// One plan for the layered player and the video export (ADR-0043, contract C6: what the player shows
// is what the export produces). Pure: the same functions give the camera rectangle, the kept spans on
// the frame grid, chapters and captions to the renderer and to main.
import { normaliseRanges, type TimeRange } from './recording-edits.ts'

/** The exported picture. A capture with another size or rate keeps these: the slides layer is always 1920×1080 at 30 fps. */
export const VIDEO_FRAME = { width: 1920, height: 1080, fps: 30 } as const
/** The camera inset in the player and the export: one corner, one size. Per-slide face position comes later. */
export const CAMERA_INSET = { corner: 'bottom-right', widthFraction: 0.22, marginFraction: 0.025, aspect: 16 / 9 } as const
/** Audio fade at each join an edit makes (PR 316's value). */
export const JOIN_FADE_MS = 15
/** Suggest trimming a silent start or end only when it lasts at least this long. */
export const SILENT_END_SUGGEST_MS = 2000
/** Leave this much of the silence before the first or after the last speech when trimming it. */
export const SILENT_END_KEEP_MS = 300

export type Rect = { x: number; y: number; width: number; height: number }
const even = (n: number): number => 2 * Math.round(n / 2)

/** The camera rectangle in a frame, in pixels (even numbers, as H.264 needs). */
export function cameraRect(frame: { width: number; height: number } = VIDEO_FRAME): Rect {
  const width = even(frame.width * CAMERA_INSET.widthFraction)
  const height = even(width / CAMERA_INSET.aspect)
  const margin = Math.round(frame.height * CAMERA_INSET.marginFraction)
  return { x: frame.width - margin - width, y: frame.height - margin - height, width, height }
}

/** The camera rectangle as percentages of the frame, for the player's CSS. */
export function cameraRectPercent(): { left: number; top: number; width: number; height: number } {
  const r = cameraRect()
  return { left: (100 * r.x) / VIDEO_FRAME.width, top: (100 * r.y) / VIDEO_FRAME.height, width: (100 * r.width) / VIDEO_FRAME.width, height: (100 * r.height) / VIDEO_FRAME.height }
}

export const frameOf = (ms: number): number => Math.round((ms * VIDEO_FRAME.fps) / 1000)
export const msOfFrame = (frame: number): number => (frame * 1000) / VIDEO_FRAME.fps

/** A kept stretch of the Run on the frame grid: frames [startFrame, endFrame) of Run time. */
export type KeptSpan = { startFrame: number; endFrame: number; startMs: number; endMs: number; editedStartMs: number; editedEndMs: number; fadeIn: boolean; fadeOut: boolean }

/**
 * The kept spans. Every boundary is snapped to the nearest frame, so the picture (whole frames) and the
 * sound (cut at the same instants) stay together however many cuts there are.
 */
export function keptSpans(cuts: readonly TimeRange[], durationMs: number): KeptSpan[] {
  const totalFrames = frameOf(durationMs)
  const removed = normaliseRanges(cuts as TimeRange[], durationMs).map((c) => ({ start: frameOf(c.start), end: frameOf(c.end) }))
  const spans: KeptSpan[] = []
  let cursor = 0, edited = 0
  const push = (a: number, b: number): void => {
    if (b <= a) return
    spans.push({ startFrame: a, endFrame: b, startMs: msOfFrame(a), endMs: msOfFrame(b), editedStartMs: msOfFrame(edited), editedEndMs: msOfFrame(edited + b - a), fadeIn: false, fadeOut: false })
    edited += b - a
  }
  for (const c of removed) {
    push(cursor, Math.min(c.start, totalFrames))
    cursor = Math.max(cursor, c.end)
  }
  push(cursor, totalFrames)
  // Every edge an edit made fades; the recording's own start and end do not.
  for (const s of spans) {
    s.fadeIn = s.startFrame > 0
    s.fadeOut = s.endFrame < totalFrames
  }
  return spans
}

export function editedDurationMs(spans: readonly KeptSpan[]): number {
  return spans.at(-1)?.editedEndMs ?? 0
}

/** Run time to edited time on the plan; a time in a cut maps to the next kept moment. */
export function planRunToEdited(spans: readonly KeptSpan[], runMs: number): number {
  for (const s of spans) {
    if (runMs < s.startMs) return s.editedStartMs
    if (runMs < s.endMs) return s.editedStartMs + (runMs - s.startMs)
  }
  return editedDurationMs(spans)
}

/** Edited time to Run time on the plan. */
export function planEditedToRun(spans: readonly KeptSpan[], editedMs: number): number {
  for (const s of spans) if (editedMs < s.editedEndMs) return s.startMs + Math.max(0, editedMs - s.editedStartMs)
  return spans.at(-1)?.endMs ?? 0
}

/** The span that holds `runMs`, or the next one after it (a time inside a cut plays on from there). */
export function spanFor(spans: readonly KeptSpan[], runMs: number): KeptSpan | null {
  return spans.find((s) => runMs < s.endMs) ?? null
}

// ---- Layers ---------------------------------------------------------------------------------------

/** The parts of a capture manifest this plan reads (main's LayerManifest satisfies it). */
export type CaptureLike = {
  durationMs?: number
  layers: Partial<Record<'slides' | 'camera', { file: string; bytes: number; startMs?: number; endMs?: number; lostAtMs?: number; segments?: Array<{ file: string; bytes: number; startMs?: number; endMs?: number; lostAtMs?: number }> }>>
}
export type LayerName = 'slides' | 'camera'
/** One recorded file of a picture layer, placed on Run time: media time 0 is Run time `startMs`. */
export type LayerClip = { layer: LayerName; part: number; file: string; bytes: number; startMs: number; endMs: number }

/**
 * The slides picture starts a moment after the voice (the capture source needs a few frames). Until it
 * does, the player and the export both show its first frame rather than black. Only that first gap,
 * and only when it is this short.
 */
export const SLIDES_LEAD_HOLD_MS = 2000
/** Where a clip is shown from: its start, or 0 for a slides file starting within SLIDES_LEAD_HOLD_MS. */
export function shownFrom(clip: { layer: LayerName; startMs: number }, first: boolean): number {
  return clip.layer === 'slides' && first && clip.startMs <= SLIDES_LEAD_HOLD_MS ? 0 : clip.startMs
}

/** The picture layers' files on Run time. A part that never started or holds no bytes is left out. */
export function layerClips(capture: CaptureLike | null | undefined, durationMs: number): Record<LayerName, LayerClip[]> {
  const out: Record<LayerName, LayerClip[]> = { slides: [], camera: [] }
  for (const layer of ['slides', 'camera'] as const) {
    const meta = capture?.layers?.[layer]
    if (!meta) continue
    const parts = meta.segments?.length ? meta.segments : [meta]
    parts.forEach((p, part) => {
      if (!p || !(p.bytes > 0) || !Number.isFinite(p.startMs)) return
      const start = Math.max(0, p.startMs as number)
      const end = Math.min(durationMs, p.endMs ?? durationMs, p.lostAtMs ?? Infinity)
      if (end > start) out[layer].push({ layer, part, file: p.file, bytes: p.bytes, startMs: start, endMs: end })
    })
  }
  return out
}

/** Whether a Run has a picture to play: a slides layer with recorded bytes. */
export function hasPictureLayers(capture: CaptureLike | null | undefined): boolean {
  const slides = capture?.layers?.slides
  return !!slides && (slides.bytes > 0 || !!slides.segments?.some((s) => s.bytes > 0))
}

// ---- Chapters -------------------------------------------------------------------------------------

export type ChapterSlide = { title: string; section?: string }
export type Chapter = { startMs: number; endMs: number; title: string }

/**
 * Chapters in edited time from the Run's slide `enter` events. Where the talk has sections, one chapter
 * per section (titled by the section); otherwise one per slide. A slide shown only inside a cut adds
 * nothing. The first chapter starts at 0, as players and YouTube expect.
 */
export function chaptersFor(
  enters: ReadonlyArray<{ tMs: number; slideId?: string }>,
  slides: Readonly<Record<string, ChapterSlide>>,
  spans: readonly KeptSpan[]
): Chapter[] {
  const total = editedDurationMs(spans)
  if (total <= 0) return []
  const useSections = enters.some((e) => e.slideId && slides[e.slideId]?.section)
  const titleOf = (id?: string): string => {
    const s = id ? slides[id] : undefined
    return ((useSections ? s?.section || s?.title : s?.title) || 'Slide').trim()
  }
  const sorted = [...enters].filter((e) => Number.isFinite(e.tMs)).sort((a, b) => a.tMs - b.tMs)
  const points: Array<{ at: number; title: string }> = []
  for (const e of sorted) {
    const span = spanFor(spans, e.tMs)
    if (!span) continue
    // A slide entered inside a cut is only shown if it is still on screen when the cut ends.
    const at = e.tMs < span.startMs ? span.editedStartMs : planRunToEdited(spans, e.tMs)
    const title = titleOf(e.slideId)
    const prev = points.at(-1)
    if (prev && Math.abs(prev.at - at) < 1) { prev.title = title; continue }
    if (prev && prev.title === title) continue
    points.push({ at, title })
  }
  if (!points.length) return [{ startMs: 0, endMs: total, title: 'Recording' }]
  points[0].at = 0
  return points.map((p, i) => ({ startMs: Math.round(p.at), endMs: Math.round(points[i + 1]?.at ?? total), title: p.title })).filter((c) => c.endMs > c.startMs)
}

const clock = (ms: number, withHours: boolean): string => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return `${withHours || h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`}:${String(sec).padStart(2, '0')}`
}

/** The chapter list to paste into a video description ("0:00 Title" per line). */
export function chapterListText(chapters: readonly Chapter[]): string {
  const hours = (chapters.at(-1)?.startMs ?? 0) >= 3_600_000
  return chapters.map((c) => `${clock(c.startMs, hours)} ${c.title}`).join('\n') + (chapters.length ? '\n' : '')
}

/** FFmpeg metadata with chapters, for MP4 chapter markers. */
export function ffmetadata(chapters: readonly Chapter[], title?: string): string {
  const esc = (s: string): string => s.replace(/[=;#\\\n]/g, (c) => (c === '\n' ? ' ' : `\\${c}`))
  return [';FFMETADATA1', ...(title ? [`title=${esc(title)}`] : []), ...chapters.flatMap((c) => ['[CHAPTER]', 'TIMEBASE=1/1000', `START=${c.startMs}`, `END=${c.endMs}`, `title=${esc(c.title)}`]), ''].join('\n')
}

// ---- Captions -------------------------------------------------------------------------------------

/** `order`: the word's place in the transcript; words with the same start keep this order in a cue (default: their place in the list). */
export type CaptionWord = { text: string; start: number; end: number; order?: number; alignment?: { status?: string; start?: number; end?: number } }
export type Cue = { startMs: number; endMs: number; text: string }
const CUE_MAX_MS = 6000, CUE_MAX_CHARS = 84, CUE_GAP_MS = 600, CUE_MIN_MS = 700

/** Aligned times where the alignment placed the word, else the transcriber's. */
function wordTimes(w: CaptionWord): TimeRange {
  return w.alignment?.status === 'aligned' && Number.isFinite(w.alignment.start) && Number.isFinite(w.alignment.end) ? { start: w.alignment.start as number, end: w.alignment.end as number } : { start: w.start, end: w.end }
}

/**
 * Caption cues in edited time from the stored words. A word whose middle falls in a cut is left out.
 * Cues break at a pause, after sentence punctuation the transcriber wrote, or when a cue grows too long.
 * Without words, the transcript's segments are used whole: a segment that any cut touches is left out
 * (its words cannot be split without inventing times) and counted in `leftOut`, so the export can say so.
 */
export function captionCues(words: readonly CaptionWord[], spans: readonly KeptSpan[], segments: readonly CaptionWord[] = []): { cues: Cue[]; leftOut: number } {
  const bySegment = !words.length
  let leftOut = 0
  const kept = (bySegment ? segments : words)
    // One line of plain text: newlines and runs of spaces inside a word or segment become one space.
    .map((w, i) => ({ text: String(w.text ?? '').replace(/\s+/g, ' ').trim(), ...wordTimes(w), order: Number.isFinite(w.order) ? (w.order as number) : i }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
    .filter((w) => {
      if (bySegment) {
        const whole = spans.some((s) => w.start >= s.startMs && w.end <= s.endMs)
        if (!whole && spans.some((s) => w.end > s.startMs && w.start < s.endMs)) leftOut++
        return whole
      }
      const mid = (w.start + w.end) / 2
      return spans.some((s) => mid >= s.startMs && mid < s.endMs)
    })
    .map((w) => ({ text: w.text, start: planRunToEdited(spans, w.start), end: planRunToEdited(spans, w.end), order: w.order }))
    // By time, and words at the same time in transcript order (an untimed word rides with its neighbour).
    .sort((a, b) => a.start - b.start || a.order - b.order)
  const cues: Cue[] = []
  let cur: Cue | null = null
  // Where the cue before ended: a new cue never starts earlier. Words that share a time (an untimed word
  // riding with its neighbour) can fall either side of a cue break; without this the earlier cue would be
  // cut back to nothing by the later one starting at the same instant, and its text lost.
  let previousEnd = 0
  for (const w of kept) {
    const end = Math.max(w.end, w.start + 1)
    if (cur && (bySegment || w.start - cur.endMs > CUE_GAP_MS || end - cur.startMs > CUE_MAX_MS || cur.text.length + 1 + w.text.length > CUE_MAX_CHARS || /[.!?…]["”’)]?$/.test(cur.text))) {
      cues.push(cur)
      previousEnd = cur.endMs
      cur = null
    }
    if (!cur) { const start = Math.max(w.start, previousEnd); cur = { startMs: start, endMs: Math.max(end, start + 1), text: w.text } }
    else { cur.text += ' ' + w.text; cur.endMs = Math.max(cur.endMs, end) }
  }
  if (cur) cues.push(cur)
  // Short cues stay up a little longer, never past the next one.
  return { cues: cues.map((c, i) => ({ ...c, startMs: Math.round(c.startMs), endMs: Math.round(Math.min(Math.max(c.endMs, c.startMs + CUE_MIN_MS), cues[i + 1]?.startMs ?? Infinity, editedDurationMs(spans))) })).filter((c) => c.endMs > c.startMs), leftOut }
}

const stamp = (ms: number, sep: ',' | '.'): string => {
  const t = Math.max(0, Math.round(ms))
  const h = Math.floor(t / 3_600_000), m = Math.floor((t % 3_600_000) / 60_000), s = Math.floor((t % 60_000) / 1000), f = t % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(f).padStart(3, '0')}`
}
/** Cue text for SRT: tags (<i>, <font …>) and style overrides ({\\an8}) are neutralised so they show as typed; no blank lines. */
export function srtText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/</g, '‹').replace(/>/g, '›').replace(/\{/g, '(').replace(/\}/g, ')')
}
/** Cue text for WebVTT: &, < and > escaped, so no tag or timestamp is read as markup; no blank lines or arrows. */
export function vttText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/-->/g, '→').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
export function toSrt(cues: readonly Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.startMs, ',')} --> ${stamp(c.endMs, ',')}\n${srtText(c.text.replace(/-->/g, '→'))}\n`).join('\n')
}
export function toWebVtt(cues: readonly Cue[]): string {
  return 'WEBVTT\n\n' + cues.map((c) => `${stamp(c.startMs, '.')} --> ${stamp(c.endMs, '.')}\n${vttText(c.text)}\n`).join('\n')
}

// ---- Silent ends ----------------------------------------------------------------------------------

export type SilenceSuggestion = { side: 'start' | 'end'; at: number; silentMs: number }

/**
 * A proposal to trim a silent start or end, from the measured silence the transcription stored. Only
 * offered when the silence lasts at least SILENT_END_SUGGEST_MS and the current trim keeps it. Never applied
 * by itself.
 */
export function silentEndSuggestions(silence: readonly TimeRange[] | undefined, durationMs: number, trimStart: number, trimEnd: number): SilenceSuggestion[] {
  const out: SilenceSuggestion[] = []
  const list = (silence ?? []).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
  const lead = list.find((s) => s.start <= 50)
  if (lead && lead.end - lead.start >= SILENT_END_SUGGEST_MS) {
    const at = Math.round(lead.end - SILENT_END_KEEP_MS)
    if (at > trimStart + 100 && at < trimEnd) out.push({ side: 'start', at, silentMs: Math.round(lead.end - lead.start) })
  }
  const tail = [...list].reverse().find((s) => s.end >= durationMs - 50)
  if (tail && tail !== lead && tail.end - tail.start >= SILENT_END_SUGGEST_MS) {
    const at = Math.round(tail.start + SILENT_END_KEEP_MS)
    if (at < trimEnd - 100 && at > trimStart) out.push({ side: 'end', at, silentMs: Math.round(tail.end - tail.start) })
  }
  return out
}
