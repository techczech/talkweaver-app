export function visibleIntersectionCentre(rect, viewport) {
  const left = Math.max(0, rect.left)
  const top = Math.max(0, rect.top)
  const right = Math.min(viewport.width, rect.right)
  const bottom = Math.min(viewport.height, rect.bottom)

  if (right <= left || bottom <= top) return null

  return {
    x: left + ((right - left) / 2),
    y: top + ((bottom - top) / 2),
    rect: {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    }
  }
}
