import { CalendarDays, Files, FileInput, Globe, LayoutDashboard, type LucideIcon } from 'lucide-react'
import { toolsRail, type CanonicalToolsView, type ToolsRailItem } from '../../../shared/tools-views'
import '../tools-rail.css'

const ICONS: Record<ToolsRailItem['icon'], LucideIcon> = {
  'layout-dashboard': LayoutDashboard,
  'calendar-days': CalendarDays,
  'file-input': FileInput,
  globe: Globe,
  files: Files
}

/** The Tools window's left rail: Studio, Runs, Importer, Published pages and Work files.
 *  The list comes from src/shared/tools-views.ts. */
export function ToolsRail({ view, onSelect, badges }: { view: CanonicalToolsView; onSelect: (view: CanonicalToolsView) => void; /** A count on a rail item (Runs: Runs with responses waiting); 0 or none shows nothing. */ badges?: Partial<Record<CanonicalToolsView, number>> }): JSX.Element {
  return (
    <nav className="tw-tools-rail" aria-label="Tools views">
      {toolsRail().map((item) => {
        const Icon = ICONS[item.icon]
        const on = item.view === view
        const badge = badges?.[item.view] ?? 0
        return (
          <button
            key={item.view}
            type="button"
            className={`tw-tools-rail-item${on ? ' on' : ''}`}
            data-tools-rail={item.view}
            aria-current={on ? 'page' : undefined}
            title={badge > 0 && item.view === 'runs' ? `${item.label}: ${badge} with responses waiting` : item.label}
            onClick={() => onSelect(item.view)}
          >
            <span className="tw-tools-rail-icon"><Icon aria-hidden />{badge > 0 && <b className="tw-tools-rail-badge" data-tools-rail-badge={item.view}>{badge}</b>}</span>
            <span>{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
