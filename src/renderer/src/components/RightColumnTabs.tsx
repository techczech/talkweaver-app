import { useLayoutEffect, useRef, useState } from 'react'
import { X, SlidersHorizontal, Rows3, BookOpen, Image as ImageIcon, GraduationCap, Inbox, FileText, Sparkles, type LucideIcon } from 'lucide-react'
import { GUIDE_TEXT, rightColumnTabs, type RightColumnTab } from '../../../shared/guide'

// The right sidebar's tab row (house rules R11a, R18): Inspector (the default), Strip, Talk (the talk's details and design), then Guide, Research,
// Images, and Feedback and What's new while they apply. Always drawn: the sidebar is one place with tabs, and the
// toolbar's sidebar button is the only way to show or hide the whole of it. The Guide and What's new tabs carry a
// close mark (they close that tab, not the sidebar). Every tab shows its word while all of them fit in the row (R11a: the
// families are readable); when they do not, only the tab that is up keeps its word and the others keep their icon and
// tooltip. The row measures itself, so the switch happens where the words really stop fitting, not at a guessed width.

const LABELS: Record<RightColumnTab, string> = {
  inspector: 'Inspector', slides: 'Strip', talk: 'Talk', guide: GUIDE_TEXT.button, research: 'Research', images: 'Images', feedback: 'Feedback', 'whats-new': 'What’s new'
}
const ICONS: Record<RightColumnTab, LucideIcon> = {
  inspector: SlidersHorizontal, slides: Rows3, talk: FileText, guide: GraduationCap, research: BookOpen, images: ImageIcon, feedback: Inbox, 'whats-new': Sparkles
}

export default function RightColumnTabs({ guideUp, whatsNewUp = false, hasTalk, shared = false, active, onSelect, onCloseGuide, onCloseWhatsNew }: {
  guideUp: boolean
  whatsNewUp?: boolean
  hasTalk: boolean
  shared?: boolean
  active: RightColumnTab
  onSelect: (tab: RightColumnTab) => void
  onCloseGuide: () => void
  onCloseWhatsNew?: () => void
}) {
  const tabs = rightColumnTabs({ guideUp, whatsNewUp, hasTalk, shared })
  const rowRef = useRef<HTMLDivElement>(null)
  const fullWidth = useRef<number | null>(null)
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
            <button type="button" role="tab" aria-selected={active === tab} aria-label={LABELS[tab]} title={LABELS[tab]} className="rc-tab-btn" onClick={() => onSelect(tab)}>
              <Glyph size={13} strokeWidth={2} aria-hidden />
              <span className="rc-tab-label">{LABELS[tab]}</span>
            </button>
            {tab === 'guide' && (
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
    </div>
  )
}
