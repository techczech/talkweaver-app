import { GUIDE_TEXT } from '../../../../shared/guide'
import { IcGraduationCap, IcPlus } from './icons'

// The foot of the Talks panel (onboarding ticket 07; states 02, 03, 16, 19): "+ Add vault…" and, beside
// it, the Guide button. The button reads "Guide" and, while the Guide tab is up, "Guide open" on the
// filled style. `guide` is null when the Settings switch has removed the button.
export interface GuideButtonState { open: boolean; onToggle: () => void }

export default function SidebarFoot({ onAddVault, guide }: { onAddVault: () => void; guide: GuideButtonState | null }) {
  return (
    <div className="tl-foot" data-sidebar-foot>
      <button type="button" className="tl-addvault" onClick={onAddVault} data-add-vault>
        <IcPlus size={11} />Add vault…
      </button>
      {guide && (
        <button
          type="button"
          className={`tl-guide${guide.open ? ' tl-guide--open' : ''}`}
          onClick={guide.onToggle}
          aria-pressed={guide.open}
          title={guide.open ? 'Close the Guide' : 'Open the Guide'}
          data-guide-button
        >
          <IcGraduationCap size={12} />{GUIDE_TEXT.button}{guide.open && <span className="tl-guide-open" data-guide-button-open>{GUIDE_TEXT.buttonOpen}</span>}
        </button>
      )}
    </div>
  )
}
