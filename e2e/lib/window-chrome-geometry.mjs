// Runs in the renderer. Range boxes measure title text, clipped like its ellipsis.
export function chromeCollisions({ native, titleSelector }) {
  const controls = [...document.querySelectorAll(
    'button, input:not([type=hidden]), select, textarea, summary, a[href], [role=button], [role=tab], [role=menuitem], [role=option], [tabindex]:not([tabindex="-1"]), [contenteditable=true]'
  )]
  const intersect = (a, b) => ({
    left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom)
  })
  const area = r => r.right > r.left + 0.5 && r.bottom > r.top + 0.5
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
  const label = el => String(el.getAttribute('aria-label') || el.textContent.trim() || el.className || el.tagName).slice(0, 85)
  const bounds = (el, box) => {
    let result = intersect(box, viewport)
    for (let parent = el; parent && area(result); parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (style.visibility !== 'visible' || Number(style.opacity) === 0 || parent.inert) return null
      const clip = parent.getBoundingClientRect()
      result = intersect(result, {
        left: style.overflowX === 'visible' ? viewport.left : clip.left,
        right: style.overflowX === 'visible' ? viewport.right : clip.right,
        top: style.overflowY === 'visible' ? viewport.top : clip.top,
        bottom: style.overflowY === 'visible' ? viewport.bottom : clip.bottom
      })
    }
    return area(result) ? result : null
  }
  const hitVisible = (el, overlap) => el.contains(document.elementFromPoint(
    (overlap.left + overlap.right) / 2, (overlap.top + overlap.bottom) / 2
  ))
  const hitboxes = controls.flatMap(el => {
    const rect = bounds(el, el.getBoundingClientRect())
    return rect ? [{ el, rect }] : []
  })
  const problems = []
  if (native) for (const { el, rect } of hitboxes) {
    const shared = intersect(native, rect)
    if (area(shared) && hitVisible(el, shared)) problems.push('native controls intersect "' + label(el) + '"')
  }
  for (const title of document.querySelectorAll(titleSelector)) {
    const range = document.createRange()
    range.selectNodeContents(title)
    for (const box of range.getClientRects()) {
      const rect = bounds(title, box)
      if (!rect) continue
      const shared = native && intersect(native, rect)
      if (shared && area(shared) && hitVisible(title, shared)) problems.push('native controls intersect title "' + label(title) + '"')
      for (const { el, rect: control } of hitboxes) {
        if (el.contains(title) || title.contains(el)) continue
        const shared = intersect(rect, control)
        if (area(shared) && (hitVisible(title, shared) || hitVisible(title, rect) && hitVisible(el, shared))) {
          problems.push('title "' + label(title) + '" overlaps "' + label(el) + '"')
        }
      }
    }
  }
  return [...new Set(problems)]
}
