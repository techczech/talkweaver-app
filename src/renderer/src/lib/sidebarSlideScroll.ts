/** Align a sidebar row once, with its real section heading visible above it. */
export function createSidebarSlideScroll() {
  let pinned: HTMLElement | null = null
  let alignedTop: number | null = null

  function release(): void {
    pinned?.removeAttribute('data-sidebar-follow-section')
    pinned = null
    alignedTop = null
  }

  return {
    align(list: HTMLElement, row: HTMLElement, section: HTMLElement | null, inset = 0): void {
      release()
      const viewport = list.getBoundingClientRect()
      const sectionHeight = section?.firstElementChild?.getBoundingClientRect().height ?? 0
      const top = Math.max(0, list.scrollTop + row.getBoundingClientRect().top - viewport.top - inset - sectionHeight)
      const tail = list.querySelector<HTMLElement>(':scope > .tw-sidebar-follow-tail')
      if (tail) {
        // Leave just enough room to top-align a slide at the end of the talk.
        const contentEnd = list.scrollTop + tail.getBoundingClientRect().top - viewport.top
        tail.style.height = `${Math.max(0, Math.ceil(top + list.clientHeight - contentEnd))}px`
      }
      if (section) {
        section.style.setProperty('--sidebar-follow-inset', `${inset}px`)
        section.setAttribute('data-sidebar-follow-section', '')
        pinned = section
      }
      list.scrollTo({ top, behavior: 'instant' })
      alignedTop = list.scrollTop
    },
    onScroll(list: HTMLElement): void {
      if (alignedTop !== null && Math.abs(list.scrollTop - alignedTop) <= 1) return
      release()
      const tail = list.lastElementChild
      // Shrink the extra space only once the viewport is back inside the authored rows.
      if (tail instanceof HTMLElement && tail.classList.contains('tw-sidebar-follow-tail') && tail.style.height &&
          tail.getBoundingClientRect().top >= list.getBoundingClientRect().bottom) tail.style.height = ''
    }
  }
}
