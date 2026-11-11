import '../ui-kit.css'
import { ArrowLeft } from 'lucide-react'
import { plainTalkTitle } from '../../../shared/plain-title'

/**
 * The one back control of a workspace mode (house rule R16): Vault Gallery, Slide focus, Pathways, the Slide Browser. It sits at
 * the top left, says where it returns ("Back to <talk>"), and Esc does the same; every mode wires its own Esc to the same
 * `onBack`. With no talk open it says "Back".
 */
export function modeBackLabel(talkTitle: string | null | undefined): string {
  const title = talkTitle ? plainTalkTitle(talkTitle).trim() : ''
  return title ? `Back to ${title}` : 'Back'
}

export default function ModeBack({ talkTitle, onBack, disabled = false, className = '' }: {
  talkTitle: string | null | undefined
  onBack: () => void
  disabled?: boolean
  className?: string
}) {
  const label = modeBackLabel(talkTitle)
  return (
    <button type="button" className={`tw-btn tw-btn--secondary mode-back ${className}`.trim()} data-mode-back disabled={disabled} onClick={onBack} title={`${label} (Esc)`} aria-label={label}>
      <ArrowLeft size={15} aria-hidden />
      <span className="mode-back-label">{label}</span>
    </button>
  )
}
