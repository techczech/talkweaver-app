// Reactions and questions as a Run keeps them (ADR-0027 with its 2026-09-29 amendment; reactions
// ticket 06). Shared by main (normalise, flush) and History (the Run card), so it carries no Node
// or DOM code. Times are milliseconds from the Run's start. Stored without participants: counts are
// only ever net counts per slide.

/** One accepted change to someone's reactions: a tap, or its undo (`withdrawn: true`). */
export interface RunReaction {
  /** `<sessionId>:r<sequence>`: stable for the session, so repeated flushes never duplicate it. */
  id?: string
  reaction: string
  slideId: string
  tMs: number
  withdrawn?: true
}

/** A question asked on a phone. Untrusted text: always rendered as text, never as markup. */
export interface RunQuestion {
  /** `<sessionId>:<questionId>`: a later flush updates `answered` in place. */
  id?: string
  text: string
  name?: string
  slideId: string
  tMs: number
  answered: boolean
}

/** A slide's net count per reaction; reactions netting to zero or below are left out. */
export interface SlideReactionCounts {
  slideId: string
  counts: Record<string, number>
}

/**
 * Net counts per slide, in the order slides first appear in the list. Each tap adds one and each
 * withdrawal takes one away; slides left with nothing are not listed.
 */
export function reactionCountsBySlide(reactions: readonly RunReaction[]): SlideReactionCounts[] {
  const bySlide = new Map<string, Map<string, number>>()
  for (const entry of reactions) {
    const slide = bySlide.get(entry.slideId) ?? new Map<string, number>()
    slide.set(entry.reaction, (slide.get(entry.reaction) ?? 0) + (entry.withdrawn ? -1 : 1))
    bySlide.set(entry.slideId, slide)
  }
  const result: SlideReactionCounts[] = []
  for (const [slideId, counts] of bySlide) {
    const kept = [...counts].filter(([, n]) => n > 0)
    if (kept.length) result.push({ slideId, counts: Object.fromEntries(kept) })
  }
  return result
}
