import { CalendarDays, Files, Globe, History as HistoryIcon, LayoutDashboard, type LucideIcon } from 'lucide-react'
import { toolsRail, type ToolsRailItem, type ToolsRunRef, type ToolsView } from '../../../shared/tools-views'
import '../tools-rail.css'

const ICONS: Record<ToolsRailItem['icon'], LucideIcon> = {
  'layout-dashboard': LayoutDashboard,
  history: HistoryIcon,
  'calendar-days': CalendarDays,
  globe: Globe,
  files: Files
}

/** The Tools window's left rail: Studio, History, Sessions, Published pages and Work files.
 *  The list comes from src/shared/tools-views.ts. */
export function ToolsRail({ view, onSelect, badges }: { view: ToolsView; onSelect: (view: ToolsView) => void; /** A count on a rail item (Sessions: Runs with responses waiting); 0 or none shows nothing. */ badges?: Partial<Record<ToolsView, number>> }): JSX.Element {
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
            title={badge > 0 && item.view === 'sessions' ? `${item.label}: ${badge} with responses waiting` : item.label}
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

type EmptyKind = 'sessions' | 'published'
const EMPTY: Record<EmptyKind, { title: string; icon: LucideIcon; heading: string; note?: string; none: string }> = {
  sessions: { title: 'Sessions', icon: CalendarDays, heading: 'No runs yet', none: 'No run selected' },
  published: { title: 'Published pages', icon: Globe, heading: 'Nothing is published', none: 'No page selected' }
}

/** The pre-work views not built yet (Sessions, Published pages), empty states only. A later ticket fills each. `run` is the Run Sessions was asked to open. */
export function ToolsEmptyView({ kind, run }: { kind: EmptyKind; run?: ToolsRunRef | null }): JSX.Element {
  const spec = EMPTY[kind]
  const Icon = spec.icon
  return (
    <div className="tw-tools-view" data-tools-view={kind} data-run={run ? `${run.talkSlug}/${run.runId}` : undefined}>
      <section className="tw-tools-list" aria-label={spec.title}>
        <header><h2>{spec.title}</h2></header>
        <div className="tw-tools-empty">
          <Icon aria-hidden />
          <b>{spec.heading}</b>
          {spec.note && <p>{spec.note}</p>}
        </div>
      </section>
      <section className="tw-tools-detail" aria-label={`${spec.title} detail`}>
        <div className="tw-tools-none"><Icon aria-hidden /><span>{spec.none}</span></div>
      </section>
    </div>
  )
}
