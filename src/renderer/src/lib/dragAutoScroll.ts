// Edge auto-scroll while something is being dragged over a scrolling list: the Slides organizer,
// the slide grid and the Talks list all use this one module.
//
// HTML5 `dragover` fires only over elements and thins out when the pointer is held still, so the
// scroll is not driven by those events. A requestAnimationFrame loop reads the LAST KNOWN pointer
// position (recorded from document-level `dragover` and `dragenter`) and scrolls the container every frame while
// that position is inside an edge zone, faster the deeper into the zone it is. The loop ends on
// drop, on drag end (which is also what Escape produces), and when the container goes away.
//
// No imports: scripts/test-drag-auto-scroll.mjs loads this file directly.

/** Height of the zone at the top and bottom of the container in which the list scrolls (px).
 *  Capped at a third of the container so a short list keeps a still middle. */
export const DRAG_SCROLL_EDGE_ZONE = 56
/** How far past the container's edge (above, below, left or right) the pointer may be and still
 *  scroll (px). Beyond it the pointer is taken to be somewhere else and nothing scrolls. */
export const DRAG_SCROLL_OUTSIDE_SLACK = 72
/** Speed at the inner boundary of the zone, px per 60 Hz frame (120 px/s). */
export const DRAG_SCROLL_MIN_SPEED = 2
/** Speed at the container's edge and past it, px per 60 Hz frame (1920 px/s). */
export const DRAG_SCROLL_MAX_SPEED = 32

const FRAME_MS = 1000 / 60

export interface PointerPosition { x: number; y: number }
export interface EdgeRect { top: number; bottom: number; left: number; right: number }
/** How much of the container's top and bottom is covered by something that does not scroll with the
 *  list (a sticky search box, a sticky toolbar), in px. The edge zones start where the cover ends. */
export interface EdgeCover { top: number; bottom: number }

/**
 * Scroll delta for one 60 Hz frame: negative scrolls up, positive down, 0 outside the edge zones.
 * Inside a zone the speed is MIN + (MAX − MIN) · t², where t runs from 0 at the zone's inner
 * boundary to 1 at the container's edge; past the edge (up to the slack) it stays at MAX.
 * The two zones mirror each other: delta(top + d) === −delta(bottom − d).
 *
 * `cover` moves the zones inwards: with a sticky header 40px tall over the top of the list, the top
 * zone is the 56px of visible rows under the header, and the header itself (like the space above the
 * list) scrolls at MAX. The slack is still measured from the container's own edges.
 */
export function edgeScrollDelta(pointer: PointerPosition, rect: EdgeRect, cover: EdgeCover = { top: 0, bottom: 0 }): number {
  if (!(rect.bottom - rect.top > 0)) return 0
  if (pointer.x < rect.left - DRAG_SCROLL_OUTSIDE_SLACK || pointer.x > rect.right + DRAG_SCROLL_OUTSIDE_SLACK) return 0
  if (pointer.y < rect.top - DRAG_SCROLL_OUTSIDE_SLACK || pointer.y > rect.bottom + DRAG_SCROLL_OUTSIDE_SLACK) return 0
  const top = rect.top + Math.max(0, cover.top)
  const bottom = rect.bottom - Math.max(0, cover.bottom)
  const height = bottom - top
  // Covered from top to bottom: there is no visible list to read a zone from; only the edges scroll.
  if (!(height > 0)) return pointer.y <= rect.top ? -DRAG_SCROLL_MAX_SPEED : pointer.y >= rect.bottom ? DRAG_SCROLL_MAX_SPEED : 0
  const zone = Math.min(DRAG_SCROLL_EDGE_ZONE, height / 3)
  const speed = (depth: number): number => {
    const t = Math.min(1, Math.max(0, depth / zone))
    return DRAG_SCROLL_MIN_SPEED + (DRAG_SCROLL_MAX_SPEED - DRAG_SCROLL_MIN_SPEED) * t * t
  }
  const fromTop = pointer.y - top
  const fromBottom = bottom - pointer.y
  if (fromTop < zone) return -speed(zone - fromTop)
  if (fromBottom < zone) return speed(zone - fromBottom)
  return 0
}

/**
 * How much of `container`'s top and bottom edge is covered right now by the elements matching
 * `selector` inside it: measured from where they are on screen, so a sticky box that has not stuck
 * (it is still down in the list) covers nothing. An element counts for the top when its top is at the
 * container's top edge (within a pixel) or above it, for the bottom likewise.
 */
export function measureEdgeCover(container: HTMLElement, selector: string | undefined): EdgeCover {
  const cover: EdgeCover = { top: 0, bottom: 0 }
  if (!selector) return cover
  const rect = container.getBoundingClientRect()
  for (const el of container.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect()
    if (!(r.height > 0)) continue
    if (r.top <= rect.top + 1 && r.bottom > rect.top) cover.top = Math.max(cover.top, r.bottom - rect.top)
    else if (r.bottom >= rect.bottom - 1 && r.top < rect.bottom) cover.bottom = Math.max(cover.bottom, rect.bottom - r.top)
  }
  return cover
}

export interface DragAutoScrollOptions {
  /** CSS selector for the elements inside the container that stay put over its top or bottom edge
   *  while the list scrolls (sticky headers and footers). They are measured every frame; the edge
   *  zones start where they end. */
  sticky?: string
  /** Called after each frame that actually moved the list, with the pointer position the frame
   *  used. The list has moved under a pointer that may be still, so the caller re-reads what is
   *  under it (document.elementFromPoint) to keep its drop indicator on the right row. */
  onScroll?: (pointer: PointerPosition) => void
}

/**
 * Start auto-scrolling `container` for the drag that has just begun (call from `dragstart`).
 * Returns a stop function; calling it more than once is harmless. The loop also stops by itself
 * on `drop`, on `dragend` (which is what Escape produces: the browser cancels the drag itself and
 * the page gets no key event during one), on the first mouse move with no button down (the drag is
 * over even if its source row was unmounted and never got a `dragend`) and when the container
 * leaves the page.
 */
export function startDragAutoScroll(container: HTMLElement, options: DragAutoScrollOptions = {}): () => void {
  const doc = container.ownerDocument
  const win = doc.defaultView
  if (!win) return () => {}
  let pointer: PointerPosition | null = null
  let frame: number | null = null
  let last: number | null = null
  // The list's position while the pointer is in an edge zone, as a fraction-keeping number. While
  // it is set, this loop OWNS the position: Chromium has its own drag auto-scroll (a 20px belt just
  // inside the edge, about 2000 px/s at its fastest, starting after a pause), and left alone the
  // two add up to roughly twice the intended top speed. Writing the tracked position every frame
  // keeps the speed to the curve above.
  let position: number | null = null
  let stopped = false

  const onDragOver = (e: DragEvent): void => { pointer = { x: e.clientX, y: e.clientY } }
  const onMouseMove = (e: MouseEvent): void => { if (e.buttons === 0) stop() }

  function stop(): void {
    if (stopped) return
    stopped = true
    if (frame != null) win!.cancelAnimationFrame(frame)
    frame = null
    doc.removeEventListener('dragover', onDragOver, true)
    doc.removeEventListener('dragenter', onDragOver, true)
    doc.removeEventListener('drop', stop, true)
    doc.removeEventListener('dragend', stop, true)
    doc.removeEventListener('mousemove', onMouseMove, true)
  }

  function tick(now: number): void {
    if (stopped) return
    if (!container.isConnected) { stop(); return }
    const elapsed = last == null ? FRAME_MS : Math.min(50, Math.max(0, now - last))
    last = now
    const perFrame = pointer ? edgeScrollDelta(pointer, container.getBoundingClientRect(), measureEdgeCover(container, options.sticky)) : 0
    if (perFrame === 0) {
      position = null
    } else {
      const max = Math.max(0, container.scrollHeight - container.clientHeight)
      const before = container.scrollTop
      if (position == null) position = before
      position = Math.max(0, Math.min(max, position + perFrame * (elapsed / FRAME_MS)))
      const next = Math.round(position)
      if (next !== before) {
        container.scrollTop = next
        if (pointer) options.onScroll?.(pointer)
      }
    }
    frame = win!.requestAnimationFrame(tick)
  }

  doc.addEventListener('dragover', onDragOver, true)
  doc.addEventListener('dragenter', onDragOver, true)
  doc.addEventListener('drop', stop, true)
  doc.addEventListener('dragend', stop, true)
  doc.addEventListener('mousemove', onMouseMove, true)
  frame = win.requestAnimationFrame(tick)
  return stop
}
