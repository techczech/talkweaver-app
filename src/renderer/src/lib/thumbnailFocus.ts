/**
 * Which slides the author is looking at, told to main so the talk's thumbnail render captures them
 * before the rest (src/main/thumbnail-plan.ts). The focus is the active slide first, then the cards in
 * the strip's visible range, top to bottom. It is sent when it changes, at most every `waitMs`, with
 * the last change always sent (leading and trailing edge).
 */

/** Deck indices of the cards at least partly inside the list's viewport, in order. `cards[i]` is the
 *  card for deck index i (null: not in the DOM, e.g. a collapsed section). */
export function visibleCardIndices(list: HTMLElement | null, cards: ReadonlyArray<HTMLElement | null>): number[] {
  if (!list) return []
  const view = list.getBoundingClientRect()
  if (view.height <= 0) return []
  const visible: number[] = []
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index]
    if (!card) continue
    const box = card.getBoundingClientRect()
    if (box.bottom <= view.top) continue
    if (box.top >= view.bottom) break // cards are laid out in deck order: none further down is visible
    visible.push(index)
  }
  return visible
}

/** The focus to send: the active slide (when it exists), then the visible ones. */
export function thumbnailFocusOrder(activeIndex: number, visible: readonly number[], slideCount: number): number[] {
  const focus: number[] = []
  if (Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < slideCount) focus.push(activeIndex)
  for (const index of visible) if (index !== activeIndex && index < slideCount) focus.push(index)
  return focus
}

export interface FocusReporter {
  report(outlinePath: string, focus: number[]): void
  dispose(): void
}

export function createFocusReporter(
  send: (outlinePath: string, focus: number[]) => void,
  waitMs = 150
): FocusReporter {
  let lastSent = ''
  let lastAt = -Infinity
  let queued: { outlinePath: string; focus: number[] } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    timer = null
    if (!queued) return
    const { outlinePath, focus } = queued
    queued = null
    const signature = outlinePath + '\n' + focus.join(',')
    if (signature === lastSent) return
    lastSent = signature
    lastAt = Date.now()
    try { send(outlinePath, focus) } catch { /* best effort: ordering only */ }
  }
  return {
    report(outlinePath, focus) {
      queued = { outlinePath, focus }
      if (timer) return
      const wait = lastAt + waitMs - Date.now()
      if (wait <= 0) flush()
      else timer = setTimeout(flush, wait)
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      queued = null
    }
  }
}
