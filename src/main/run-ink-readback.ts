// The Pen's ink in a recording (ticket 08), checked wherever it comes in from outside this process:
// a recording checkpoint from the presenter window (recording-stream.ts) and a stored recording read
// back from disk (runs.ts, recording.ts), before it is passed anywhere. A recording file may be old,
// hand-edited or damaged; a renderer may be compromised.
//
// Order of checks, so nothing large is ever serialised or encoded: structure and field counts first
// (only known fields; an unknown field anywhere refuses the mark, without reading its value), then
// the field checks of live ink (worker/protocol.ts parseCappedInkMessage: tools, palette, ranges,
// points per stroke, strokes and points per layer), then the byte cap on the rebuilt mark only.
// A mark that fails is dropped; every other mark, and the recording, is kept. The ink of one
// recording is held to INK_READBACK_BYTES as it is written to the file (inkMarkFileBytes): once
// that is spent, later ink marks are dropped unread.
import { INK_LIMITS, parseCappedInkMessage, type InkStroke } from '../../worker/protocol.ts'

/**
 * All the ink one recording may carry, in bytes as the Run and session files hold it: so a
 * recording's ink cannot dominate its file (the largest real recording file measured on 9 Oct 2026
 * was 225 KB).
 */
export const INK_READBACK_BYTES = 2_000_000

/**
 * The bytes one ink mark takes in a recording file. Run and session files are written with
 * JSON.stringify(record, null, 2) (runs.ts writeRun, the ledger's serialiseSession), where a mark
 * sits in `slideTimeIndex` one level below the root: its own two-space-indented form, plus four
 * spaces of base indent on each of its lines, plus the ",\n" after it. A probe (a two-stroke,
 * 800-point mark: 11,204 bytes compact) matched the file growth exactly: 56,208 bytes, about 5×.
 */
export function inkMarkFileBytes(mark: InkMark): number {
  const pretty = JSON.stringify(mark, null, 2)
  let lines = 1
  for (let i = 0; i < pretty.length; i++) if (pretty.charCodeAt(i) === 10) lines++
  return new TextEncoder().encode(pretty).length + 4 * lines + 2
}

/** An ink mark as stored: the slide's own layer, or a zoomed image's (`space: 'image'` and its index). */
export type InkMark = { event: 'ink'; slideId: string; tMs: number; space?: 'image'; image?: number; ink: InkStroke[] }

const MARK_FIELDS = new Set(['event', 'slideId', 'tMs', 'space', 'image', 'ink'])
const STROKE_FIELDS = new Set(['tool', 'ink', 'width', 'points'])

/** A plain object whose own and inherited enumerable keys are all `allowed`; values are not read. */
function onlyFields(value: unknown, allowed: Set<string>): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  for (const key in value) if (!allowed.has(key)) return false
  return true
}

/** One ink mark checked and rebuilt from its checked fields, or null. Never throws. */
export function readbackInkMark(value: unknown): InkMark | null {
  try {
    if (!onlyFields(value, MARK_FIELDS)) return null
    const m = value
    if (m.event !== 'ink' || typeof m.tMs !== 'number' || !Number.isFinite(m.tMs) || m.tMs < 0) return null
    if (typeof m.slideId !== 'string' || m.slideId.length > 100) return null
    const image = m.space === 'image'
    if (!image && m.space !== undefined) return null
    if (!Array.isArray(m.ink) || m.ink.length > INK_LIMITS.strokesPerLayer) return null
    for (const stroke of m.ink) {
      if (!onlyFields(stroke, STROKE_FIELDS)) return null
      if (!Array.isArray(stroke.points) || stroke.points.length > INK_LIMITS.pointsPerStroke) return null
      for (const tag of [stroke.tool, stroke.ink, stroke.width]) if (typeof tag !== 'string' || tag.length > 16) return null
    }
    const parsed = parseCappedInkMessage({ type: 'ink.live',
      ink: { slideId: m.slideId, space: image ? 'image' : 'slide', ...(image ? { image: m.image } : {}), strokes: m.ink, draft: null } })
    if (!parsed) return null
    const view = parsed.ink
    return { event: 'ink', slideId: view.slideId, tMs: m.tMs, ...(image ? { space: 'image' as const, image: view.image } : {}), ink: view.strokes }
  } catch {
    return null
  }
}

/**
 * A recording's marks (stored slide-time index, or a checkpoint's raw marks): [] unless an array;
 * ink marks checked (readbackInkMark) and dropped when they fail; once the recording's ink passes
 * INK_READBACK_BYTES, every later ink mark is dropped without being checked. Other marks pass.
 */
export function readbackSlideTimeIndex<T = unknown>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  const out: unknown[] = []
  let inkBytes = 0
  let spent = false
  for (const mark of value) {
    if (!mark || typeof mark !== 'object' || (mark as { event?: unknown }).event !== 'ink') { out.push(mark); continue }
    if (spent) continue
    const checked = readbackInkMark(mark)
    if (!checked) continue
    const bytes = inkMarkFileBytes(checked)
    // Past the budget the rest of the recording's ink is dropped (what was drawn first is kept).
    if (inkBytes + bytes > INK_READBACK_BYTES) { spent = true; continue }
    inkBytes += bytes
    out.push(checked)
  }
  return out as T[]
}

/**
 * A session file's parsed root as Studio's lists take it, or null when the root is not an object
 * (null, an array, a number): such a file is skipped instead of breaking the list's sort. The ink
 * is checked and capped (readbackSlideTimeIndex); a session without a kind is a delivery.
 */
export function sessionForList(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const s = value as Record<string, unknown>
  const checked = 'slideTimeIndex' in s ? { slideTimeIndex: readbackSlideTimeIndex(s.slideTimeIndex) } : {}
  return { ...s, ...checked, ...(!('kind' in s) ? { kind: 'delivery' } : {}) }
}
