import { useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'

// Help on demand (house rule R13): an explainer sentence is an info mark with the sentence as its tooltip and name,
// and a small popover on click, never resident text in the sidebar.
export default function InfoTip({ text, icon }: { text: string; icon?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="tw-infotip">
      <button type="button" className="tw-infotip-btn" title={text} aria-label={text} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {icon ?? <Info size={13} aria-hidden />}
      </button>
      {open && <span role="note" className="tw-infotip-pop">{text}</span>}
    </span>
  )
}
