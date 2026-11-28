import { GUIDE_TEXT } from '../../../../shared/guide'
import { IcGraduationCap, IcPlus } from './icons'

// The Guide is available from both sidebar tabs. Talks also offers Add vault….
export interface GuideButtonState { open: boolean; onToggle: () => void }

export default function SidebarFoot({ onAddVault, guide }: { onAddVault?: () => void; guide: GuideButtonState | null }) {
  return (
    <div className="tl-foot" data-sidebar-foot>
      {onAddVault && <button type="button" className="tl-addvault" onClick={onAddVault} data-add-vault>
        <IcPlus size={11} />Add vault…
      </button>}
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
