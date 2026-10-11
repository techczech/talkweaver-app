import { X } from 'lucide-react'
import { GUIDE_TEXT, rightColumnTabs, type RightColumnTab } from '../../../shared/guide'

// The right-hand column's tab row (onboarding ticket 07; state 02): Guide, Slides, Inspector. Drawn
// only while the Guide tab is up; without it the column is the strip or the Inspector, as before.
// The Guide tab carries a close mark.

const LABELS: Record<RightColumnTab, string> = { guide: GUIDE_TEXT.button, slides: 'Slides', inspector: 'Inspector' }

export default function RightColumnTabs({ guideUp, hasTalk, active, onSelect, onCloseGuide }: {
  guideUp: boolean
  hasTalk: boolean
  active: RightColumnTab
  onSelect: (tab: RightColumnTab) => void
  onCloseGuide: () => void
}) {
  const tabs = rightColumnTabs({ guideUp, hasTalk })
  if (tabs.length === 0) return null
  return (
    <div className="rc-tabs" role="tablist" aria-label="Right-hand column" data-right-column-tabs>
      {tabs.map((tab) => (
        <div key={tab} className={`rc-tab${active === tab ? ' rc-tab--on' : ''}`} data-rc-tab={tab}>
          <button type="button" role="tab" aria-selected={active === tab} className="rc-tab-btn" onClick={() => onSelect(tab)}>
            {LABELS[tab]}
          </button>
          {tab === 'guide' && (
            <button type="button" className="rc-tab-close" aria-label="Close the Guide" title="Close the Guide" data-guide-close onClick={onCloseGuide}>
              <X size={11} strokeWidth={2.5} aria-hidden />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
