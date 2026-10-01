// The unified rail (ADR-0009): the collapsible left column that holds Search, Scope, Browse and
// Filters (BrowserRail) under its own head.
import type { ComponentProps } from 'react'
import { ChevronLeft } from 'lucide-react'
import BrowserRail from '../browser-rail/BrowserRail'

export function RailPane({ collapsed, onCollapse, railProps }: {
  collapsed: boolean
  onCollapse: () => void
  railProps: ComponentProps<typeof BrowserRail>
}) {
  return (
    <aside className={`lt-urail${collapsed ? ' collapsed' : ''}`} aria-label="Browser rail">
      <div className="lt-rail-head">
        <span className="lt-rail-title">Browser</span>
        <button type="button" className="lt-rail-collapse" title="Collapse rail (I)" onClick={onCollapse}>
          <ChevronLeft className="lt-icon" />
        </button>
      </div>
      <BrowserRail {...railProps} />
    </aside>
  )
}
