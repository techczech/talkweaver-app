// The Pen's ink as the preload reads it (ticket 08): the layer the deck writes for the venue screen
// (data-tw-live-ink), read by the live bridge (to the worker) and the recorder (into a recording),
// checked with the same structure, caps and byte cap as everywhere else (worker/protocol.ts
// parseCappedInkMessage). Nothing too large is parsed: a slot longer than the byte cap is refused unread.
import { INK_LIMITS, parseCappedInkMessage, type InkMessage, type InkStroke } from '../../worker/protocol.ts'

/** The deck's ink slot as one checked message, draft included, or null. Never throws. */
export function readInkSlot(slot: string | undefined): InkMessage | null {
  try {
    const text = slot || 'null'
    // Characters never outnumber UTF-8 bytes: a slot this long cannot fit one message.
    if (text.length > INK_LIMITS.bytes) return null
    return parseCappedInkMessage({ type: 'ink.live', ink: JSON.parse(text) })
  } catch {
    return null
  }
}

export type RecordedInk = { strokes: InkStroke[]; layer: { space?: 'image'; image?: number } }

/**
 * The committed ink of `slideId`'s layer shown now, or null: not this slide, a stroke still being
 * drawn (a draft), malformed, or over a cap. Never throws.
 */
export function recordedInk(slot: string | undefined, slideId: string): RecordedInk | null {
  try {
    const message = readInkSlot(slot)
    if (!message || message.ink.slideId !== slideId || message.ink.draft) return null
    return { strokes: message.ink.strokes, layer: message.ink.space === 'image' ? { space: 'image', image: message.ink.image ?? 0 } : {} }
  } catch {
    return null
  }
}
