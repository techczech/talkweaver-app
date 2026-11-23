import { useLayoutEffect, useRef, useState } from 'react'
import { X, Ellipsis, SlidersHorizontal, Rows3, BookOpen, Image as ImageIcon, GraduationCap, Inbox, FileText, Sparkles, Archive, type LucideIcon } from 'lucide-react'
import type { SlideTabView } from '../../../shared/workspace-view'
import { GUIDE_TEXT, rightColumnTabs, type RightColumnTab } from '../../../shared/guide'

// The right sidebar's tab row (house rules R11a, R18): Inspector (the default), Strip, Talk (the talk's details and design), then Guide, Research,
// Images, and Feedback and What's new while they apply. Always drawn: the sidebar is one place with tabs, and the
// toolbar's sidebar button is the only way to show or hide the whole of it. The Guide and What's new tabs carry a
// close mark (they close that tab, not the sidebar). Every tab shows its word while all of them fit in the row (R11a: the
// families are readable); when they do not, only the tab that is up keeps its word and the others keep their icon and
// tooltip. The row measures itself, so the switch happens where the words really stop fitting, not at a guessed width.

const LABELS: Record<RightColumnTab, string> = {
  inspector: 'Slide', slides: 'Strip', talk: 'Talk', scratchpad: 'Scratchpad', guide: GUIDE_TEXT.button, research: 'Research', images: 'Images', feedback: 'Feedback', 'whats-new': 'What’s new'
}
const ICONS: Record<RightColumnTab, LucideIcon> = {
  inspector: SlidersHorizontal, slides: Rows3, talk: FileText, scratchpad: Archive, guide: GraduationCap, research: BookOpen, images: ImageIcon, feedback: Inbox, 'whats-new': Sparkles
}

export default function RightColumnTabs({ guideUp, whatsNewUp = false, hasTalk, shared = false, scratchpad = false, active, onSelect, onCloseGuide, onCloseWhatsNew, slideTabView, onChooseSlideTabView, onDismissPanelOptions }: {
  guideUp: boolean
  whatsNewUp?: boolean
  hasTalk: boolean
  shared?: boolean
  scratchpad?: boolean
  active: RightColumnTab
  onSelect: (tab: RightColumnTab) => void
  slideTabView?: SlideTabView
  onChooseSlideTabView?: (view: SlideTabView) => void
  onDismissPanelOptions?: () => void
  onCloseGuide: () => void
  onCloseWhatsNew?: () => void
}) {
  const tabs = rightColumnTabs({ guideUp, whatsNewUp, hasTalk, shared, scratchpad })
  const rowRef = useRef<HTMLDivElement>(null)
  const fullWidth = useRef<number | null>(null)
  const [options, setOptions] = useState(false)
  const optionsButton = useRef<HTMLButtonElement>(null)
  const [compact, setCompact] = useState(false)
  const tabKey = tabs.join('|')
  // A new set of tabs is measured afresh with every word showing.
  useLayoutEffect(() => { fullWidth.current = null; setCompact(false) }, [tabKey])
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const fit = (): void => {
      if (!compact) {
        fullWidth.current = row.scrollWidth
        if (row.scrollWidth > row.clientWidth + 1) setCompact(true)
      } else if (fullWidth.current !== null && row.clientWidth >= fullWidth.current) setCompact(false)
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(row)
    return () => observer.disconnect()
  }, [compact, tabKey])
  if (tabs.length === 0) return null
  return (
    <div ref={rowRef} className="rc-tabs" role="tablist" aria-label="Sidebar" data-right-column-tabs data-compact={compact ? 'true' : undefined}>
      {tabs.map((tab) => {
        const Glyph = ICONS[tab]
        return (
          <div key={tab} className={`rc-tab${active === tab ? ' rc-tab--on' : ''}`} data-rc-tab={tab}>
            <button type="button" role={hasTalk && ['guide', 'research', 'images'].includes(tab) ? 'button' : 'tab'} aria-selected={hasTalk && ['guide', 'research', 'images'].includes(tab) ? undefined : active === tab}
              aria-pressed={hasTalk && ['guide', 'research', 'images'].includes(tab) ? active === tab : undefined} aria-label={LABELS[tab]} title={LABELS[tab]} className="rc-tab-btn" onClick={() => onSelect(tab)}>
              <Glyph size={13} strokeWidth={2} aria-hidden />
              <span className="rc-tab-label">{LABELS[tab]}</span>
            </button>
            {tab === 'guide' && guideUp && (
              <button type="button" className="rc-tab-close" aria-label="Close the Guide" title="Close the Guide" data-guide-close onClick={onCloseGuide}>
                <X size={11} strokeWidth={2.5} aria-hidden />
              </button>
            )}
            {tab === 'whats-new' && (
              <button type="button" className="rc-tab-close" aria-label="Close What&rsquo;s new" title="Close What&rsquo;s new" data-whats-new-close onClick={() => onCloseWhatsNew?.()}>
                <X size={11} strokeWidth={2.5} aria-hidden />
              </button>
            )}
          </div>
        )
      })}
      {slideTabView && <div className="tw-right-panel-options" onKeyDown={event => {
        if (!options || event.key !== 'Escape' || event.nativeEvent.isComposing ||
            event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
        event.preventDefault()
        event.stopPropagation()
        setOptions(false)
        onDismissPanelOptions?.()
        optionsButton.current?.focus()
      }}>
        <button ref={optionsButton} type="button" className="toolbar-btn" aria-label="Panel options" aria-expanded={options} onClick={event => {
          event.currentTarget.focus()
          setOptions(!options)
        }}><Ellipsis size={17} /></button>
        {options && <div className="tw-right-panel-menu">{(['pages', 'list'] as const).map(view =>
          <button type="button" key={view} className="toolbar-btn" aria-pressed={slideTabView === view} onClick={() => { onChooseSlideTabView?.(view); setOptions(false) }}>
            {view === 'pages' ? 'Pages' : 'One long list'}
          </button>)}</div>}
      </div>}
    </div>
  )
}
