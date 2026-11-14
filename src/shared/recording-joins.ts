// Joins at the cuts an edit made (Look and sound › "Smooth each join with a quick fade, so your face does
// not jump"). Pure, shared by main's export and the tests.
//
// Sound. The voice on the Run clock is spliced sample by sample from the kept spans (on the 30 fps grid,
// 1600 samples a frame at 48 kHz). With smooth joins every join is an equal-power crossfade of
// JOIN_CROSSFADE_MS centred on it: the end of the earlier span runs on into the cut while the start of the
// later one comes in from before it, so nothing is shifted and the edited length is exactly the frames
// kept (captions and chapters keep their times). Without smooth joins each side fades out and in over
// JOIN_FADE_MS (release 0.44's hard join). The recording's own trimmed start and end always fade.
//
// Picture. With smooth joins the first frames after a join dissolve from the frames before it over
// JOIN_DISSOLVE_FRAMES frames (the export averages the last frames; the player fades a still of the
// last frame). Without, the picture cuts on the frame boundary.
import { JOIN_FADE_MS, VIDEO_FRAME, type KeptSpan } from './recording-video.ts'

export const AUDIO_RATE = 48_000
export const SAMPLES_PER_FRAME = AUDIO_RATE / VIDEO_FRAME.fps
/** Length of the crossfade at a join: half of it before the join, half after. */
export const JOIN_CROSSFADE_MS = 20
/** Frames over which the picture dissolves after a join (6 frames: 200 ms at 30 fps; 5 of them mixed). */
export const JOIN_DISSOLVE_FRAMES = 6

const HALF = Math.round((JOIN_CROSSFADE_MS / 2 / 1000) * AUDIO_RATE)
const FADE = Math.round((JOIN_FADE_MS / 1000) * AUDIO_RATE)

/**
 * One stretch of input samples and what becomes of it. Stretches are in input order and never overlap;
 * output is their results in the same order. `mix-a` (the earlier side of a join, running into the cut)
 * is held until its `mix-b` (the later side, from before its start) has been read, then both are mixed.
 */
export type SplicePiece =
  | { op: 'copy' | 'fade-in' | 'fade-out'; from: number; to: number }
  | { op: 'mix-a' | 'mix-b'; from: number; to: number; join: number }

/** The splice of the voice for these kept spans, in input samples on the Run clock. */
export function voiceSplicePlan(spans: readonly KeptSpan[], totalFrames: number, smooth: boolean): SplicePiece[] {
  const out: SplicePiece[] = []
  spans.forEach((span, k) => {
    const s = span.startFrame * SAMPLES_PER_FRAME, e = span.endFrame * SAMPLES_PER_FRAME
    const first = k === 0, last = k === spans.length - 1
    let from = s, to = e
    if (!first && smooth) { out.push({ op: 'mix-b', from: s - HALF, to: s + HALF, join: k - 1 }); from = s + HALF }
    else if (s > 0) { out.push({ op: 'fade-in', from: s, to: s + FADE }); from = s + FADE }
    const tail: SplicePiece[] = []
    if (!last && smooth) { tail.push({ op: 'mix-a', from: e - HALF, to: e + HALF, join: k }); to = e - HALF }
    else if (span.endFrame < totalFrames) { tail.push({ op: 'fade-out', from: e - FADE, to: e }); to = e - FADE }
    if (to > from) out.push({ op: 'copy', from, to })
    out.push(...tail)
  })
  return out
}

/** Samples the plan writes: every kept frame's 1600 samples, no more and no less. */
export function splicedLength(spans: readonly KeptSpan[]): number {
  return spans.reduce((n, s) => n + (s.endFrame - s.startFrame) * SAMPLES_PER_FRAME, 0)
}

const clamp = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v))

/**
 * Applies a plan to 16-bit mono samples arriving in order, in chunks of any size. Memory is bounded by
 * the chunk size and one join's crossfade. Input that ends early (the voice is a little shorter than the
 * last frame) is read as silence.
 */
export function createVoiceSplicer(plan: readonly SplicePiece[]) {
  let g = 0, pi = 0
  let held: Float64Array | null = null, heldJoin = -1, b: Float64Array | null = null
  const feed = (chunk: Int16Array, out: Int16Array[]): void => {
    let off = 0
    while (off < chunk.length && pi < plan.length) {
      const p = plan[pi]
      if (g < p.from) { const skip = Math.min(p.from - g, chunk.length - off); off += skip; g += skip; continue }
      const take = Math.min(p.to - g, chunk.length - off)
      const at = g - p.from, part = chunk.subarray(off, off + take), len = p.to - p.from
      if (p.op === 'copy') out.push(part.slice())
      else if (p.op === 'fade-in' || p.op === 'fade-out') {
        const o = new Int16Array(take)
        // Linear, as ffmpeg's afade: 0 → 1 across the fade-in, 1 → 0 across the fade-out.
        for (let i = 0; i < take; i++) { const x = (at + i + 0.5) / len; o[i] = clamp(part[i] * (p.op === 'fade-in' ? x : 1 - x)) }
        out.push(o)
      } else {
        const into = p.op === 'mix-a' ? (held && heldJoin === p.join ? held : (held = new Float64Array(len), heldJoin = p.join, held)) : (b ??= new Float64Array(len))
        for (let i = 0; i < take; i++) into[at + i] = part[i]
      }
      off += take; g += take
      if (g >= p.to) { if (p.op === 'mix-b') out.push(mix(p.join)); pi++ }
    }
    g += chunk.length - off
  }
  /** Equal-power crossfade of the held earlier side with the later side. */
  const mix = (join: number): Int16Array => {
    const a = held && heldJoin === join ? held : new Float64Array(2 * HALF), bb = b ?? new Float64Array(2 * HALF)
    const o = new Int16Array(bb.length)
    for (let i = 0; i < bb.length; i++) { const x = ((i + 0.5) / bb.length) * (Math.PI / 2); o[i] = clamp(a[i] * Math.cos(x) + bb[i] * Math.sin(x)) }
    held = null; heldJoin = -1; b = null
    return o
  }
  return {
    push(chunk: Int16Array): Int16Array[] { const out: Int16Array[] = []; feed(chunk, out); return out },
    /** The input ended: whatever the plan still needs is silence. */
    end(): Int16Array[] {
      const out: Int16Array[] = []
      while (pi < plan.length) feed(new Int16Array(Math.min(1 << 16, Math.max(1, plan[pi].to - g))), out)
      return out
    }
  }
}

/**
 * Edited-time windows in which the export shows the dissolve (the frames after each join that still
 * hold some of the frames before it), as frame ranges [first, last] of the edited video.
 */
export function dissolveWindows(spans: readonly KeptSpan[]): Array<{ first: number; last: number }> {
  let edited = 0
  const out: Array<{ first: number; last: number }> = []
  spans.forEach((s, k) => {
    if (k > 0) out.push({ first: edited, last: edited + JOIN_DISSOLVE_FRAMES - 2 })
    edited += s.endFrame - s.startFrame
  })
  return out
}
