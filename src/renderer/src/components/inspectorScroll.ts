// The Inspector's options pane as tabs (Dominik's preview.11 check, 29 Sep).
//
// Invariants:
// - A section chip puts that section's heading at the top of the options pane, the last section
//   included: the pane carries trailing space so any heading can reach the top.
// - The pane keeps its place when the Inspector re-renders: the position is held as an anchor (an
//   option group or section, and how far the pane has scrolled past its top), so content that
//   grows, shrinks or disappears elsewhere never moves what the user is looking at.
// - Each slide keeps its own anchor; a slide not seen before opens at the top.
//
// All positions are in the pane's content coordinates: 0 is the top of the scrollable content.

/** A section or an option group in the options pane. */
export interface PaneNode {
  key: string
  top: number
}

/** Where the pane is: `offset` pixels past the top of node `key` (null: no node reached yet), the
 *  node's top when the anchor was taken, and the scroll position itself. */
export interface PaneAnchor {
  key: string | null
  top: number
  offset: number
  scrollTop: number
}

/** The scroll position a chip jumps to: its section's top, within the pane's scroll range. */
export function tabJumpScrollTop(sectionTop: number, maxScrollTop: number): number {
  return Math.max(0, Math.min(Math.max(0, maxScrollTop), sectionTop))
}

/**
 * The trailing space the pane needs so the last section's heading can reach the top: the pane is
 * `paneHeight` tall, the last section starts at `lastSectionTop`, and the content (the pane's own
 * bottom padding included) ends at `contentEnd` without the space.
 */
export function tabTrailingSpace(paneHeight: number, lastSectionTop: number, contentEnd: number): number {
  return Math.max(0, Math.ceil(lastSectionTop + paneHeight - contentEnd))
}

/** The anchor for a scroll position: the last node (in document order) whose top the pane has reached. */
export function paneAnchorAt(nodes: readonly PaneNode[], scrollTop: number): PaneAnchor {
  let anchor: PaneNode | null = null
  for (const node of nodes) if (node.top <= scrollTop + 0.5) anchor = node
  return anchor
    ? { key: anchor.key, top: anchor.top, offset: scrollTop - anchor.top, scrollTop }
    : { key: null, top: 0, offset: scrollTop, scrollTop }
}

/** The scroll position that puts an anchor back where it was; a vanished node keeps the old position. */
export function scrollTopForAnchor(anchor: PaneAnchor, nodes: readonly PaneNode[]): number {
  if (anchor.key == null) return anchor.scrollTop
  const node = nodes.find((candidate) => candidate.key === anchor.key)
  return node ? Math.max(0, node.top + anchor.offset) : anchor.scrollTop
}

/** Per-slide pane positions. A slide not seen before opens at the top. */
export class PaneMemory {
  private readonly anchors = new Map<string, PaneAnchor>()
  private readonly limit: number

  constructor(limit = 200) {
    this.limit = limit
  }

  remember(slideKey: string, anchor: PaneAnchor): void {
    this.anchors.delete(slideKey)
    this.anchors.set(slideKey, anchor)
    if (this.anchors.size > this.limit) this.anchors.delete(this.anchors.keys().next().value as string)
  }

  /** Where the pane belongs for this slide now, given the nodes it holds. */
  scrollTopFor(slideKey: string, nodes: readonly PaneNode[]): number {
    const anchor = this.anchors.get(slideKey)
    return anchor ? scrollTopForAnchor(anchor, nodes) : 0
  }

  get(slideKey: string): PaneAnchor | undefined {
    return this.anchors.get(slideKey)
  }
}

/**
 * Where the pane goes after a render. Another slide takes its remembered place (the top when new).
 * On the same slide the user's own scrolling is the authority, except when the render moved the
 * anchor node (content above it grew or shrank) or cut the pane short so the browser pulled the
 * position back (`maxScrollTop` is the range before the trailing space is re-sized): then the
 * anchor is put back.
 */
export function paneScrollTarget(
  memory: PaneMemory,
  slideKey: string,
  previousSlideKey: string | null,
  nodes: readonly PaneNode[],
  currentScrollTop: number,
  maxScrollTop: number
): number {
  if (slideKey !== previousSlideKey) return memory.scrollTopFor(slideKey, nodes)
  const anchor = memory.get(slideKey)
  if (!anchor) return currentScrollTop
  const node = anchor.key == null ? undefined : nodes.find((candidate) => candidate.key === anchor.key)
  const moved = node !== undefined && Math.abs(node.top - anchor.top) > 0.5
  const pulledBack = currentScrollTop < anchor.scrollTop - 1 && currentScrollTop >= maxScrollTop - 1
  return moved || pulledBack ? scrollTopForAnchor(anchor, nodes) : currentScrollTop
}
