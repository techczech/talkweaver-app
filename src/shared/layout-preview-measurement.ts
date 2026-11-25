/// <reference lib="dom" />

import type { LayoutPreviewEvidence } from './list-layout-suggestions.ts'

/** Runs in the same isolated deck document as the thumbnail capture. It must stay self-contained
 * because the hidden Electron window evaluates the function, as does the headless verification. */
export function measureLayoutPreview(input: { selector?: string; layout?: string; title?: string }): LayoutPreviewEvidence {
  const stage = document.getElementById('stage')
  const slide = stage?.querySelector<HTMLElement>('.slide.active')
  const content = slide?.querySelector<HTMLElement>('.slide-content')
  if (!stage || !slide || !content) return { words: [], overflows: false, matches: false }
  const matches = (!input.layout || slide.dataset.layout === input.layout)
    && (!input.title || slide.dataset.titleLayout === input.title)
    && (!input.selector || Boolean(content.matches(input.selector) || content.querySelector(input.selector)))
  const steps = Array.from(slide.querySelectorAll('[data-mode-state]'), element => [element, element.getAttribute('data-mode-state')!] as const)
  // The whole slide has to fit, including points still due to be revealed.
  steps.forEach(([element]) => element.setAttribute('data-mode-state', 'full'))
  try {
    const frame = stage.getBoundingClientRect()
    const slideRect = slide.getBoundingClientRect()
    const bounds = {
      left: Math.max(frame.left, slideRect.left), top: Math.max(frame.top, slideRect.top),
      right: Math.min(frame.right, slideRect.right), bottom: Math.min(frame.bottom, slideRect.bottom)
    }
    let overflows = false
    const outside = (rect: DOMRect, box: typeof bounds, horizontal = true, vertical = true): boolean =>
      (horizontal && (rect.left < box.left - 2 || rect.right > box.right + 2)) ||
      (vertical && (rect.top < box.top - 2 || rect.bottom > box.bottom + 2))
    const clipped = (rect: DOMRect, element: Element): boolean => {
      if (outside(rect, bounds)) return true
      for (let parent: Element | null = element; parent && parent !== slide; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const clips = /^(hidden|clip|scroll|auto)$/
        const x = clips.test(style.overflowX)
        const y = clips.test(style.overflowY)
        if ((x || y) && outside(rect, parent.getBoundingClientRect(), x, y)) return true
      }
      return false
    }
    const ignored = '.sr-only,.kicker,.notes,script,style,template,svg title,svg desc'
    const visible = (element: Element): boolean => !element.closest(ignored)
      && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    const nodes = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    const groups = new Map<Element, string>()
    const range = document.createRange()
    for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
      const parent = node.parentElement
      if (!parent || !node.textContent || !visible(parent)) continue
      range.selectNodeContents(node)
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
      if (!rects.length && node.textContent.trim()) continue
      overflows ||= rects.some(rect => clipped(rect, parent))
      // Inline marks can split a single word (e.g. one<strong>word</strong>). Keep each
      // rendered block's inline text together while keeping separate diagram labels apart.
      let block = parent
      while (block.parentElement && block !== content && getComputedStyle(block).display === 'inline' &&
        block.namespaceURI !== 'http://www.w3.org/2000/svg') block = block.parentElement
      groups.set(block, (groups.get(block) ?? '') + node.textContent)
    }
    for (const visual of Array.from(content.querySelectorAll('img,svg,video,iframe,canvas'))) {
      if (visible(visual)) overflows ||= clipped(visual.getBoundingClientRect(), visual.parentElement ?? content)
    }
    const words = [...groups.values()].join(' ').normalize('NFC').match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
    return { words, overflows, matches }
  } finally {
    steps.forEach(([element, state]) => element.setAttribute('data-mode-state', state))
  }
}
