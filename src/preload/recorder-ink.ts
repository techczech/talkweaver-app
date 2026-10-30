// The Pen's ink as the preload reads it (ticket 08): the layer the deck writes for the venue screen
// (data-tw-live-ink), read by the live bridge (to the worker) and the recorder (into a recording),
// checked with the same structure, caps and byte cap as everywhere else (worker/protocol.ts
// parseCappedInkMessage). Nothing too large is parsed: a slot longer than the byte cap is refused unread.
import { INK_LIMITS, parseCappedInkMessage, parsePointerMessage, type InkMessage, type InkStroke, type PointerMessage } from '../../worker/protocol.ts'

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

/**
 * The presenter deck's freeze mark on its own root (live page Freeze and mark; the deck sets it while a
 * freeze is asked for or on). The deck is app-compiled; the live page is another WebContents and cannot
 * reach it. While the mark is there no pointer or ink of this window goes to the venue screen, phones or
 * a recording, whatever the slots say.
 */
export const LIVE_FREEZE_ATTRIBUTE = 'data-tw-live-freeze'
export type DeckRoot = { hasAttribute(name: string): boolean; dataset: { twLiveInk?: string; twLivePointer?: string } }

/** The deck is frozen (or cannot be read: then treated as frozen). */
export function liveFrozen(root: DeckRoot): boolean {
  try { return root.hasAttribute(LIVE_FREEZE_ATTRIBUTE) } catch { return true }
}

/** The ink to send to the venue screen now, or null (frozen, or nothing valid in the slot). Never throws. */
export function venueInk(root: DeckRoot): InkMessage | null {
  if (liveFrozen(root)) return null
  try { return readInkSlot(root.dataset.twLiveInk) } catch { return null }
}

/** The pointer to send to the venue screen now: 'gone' while frozen, else the checked slot, or null. Never throws. */
export function venuePointer(root: DeckRoot): PointerMessage | null {
  if (liveFrozen(root)) return { type: 'pointer.live', pointer: 'gone' }
  try { return parsePointerMessage({ type: 'pointer.live', pointer: JSON.parse(root.dataset.twLivePointer || '') }) } catch { return null }
}

/** recordedInk of the deck's slot, or null while the deck is frozen. Never throws. */
export function recordedDeckInk(root: DeckRoot, slideId: string): RecordedInk | null {
  if (liveFrozen(root)) return null
  try { return recordedInk(root.dataset.twLiveInk, slideId) } catch { return null }
}
