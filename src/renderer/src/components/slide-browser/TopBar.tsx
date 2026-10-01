// The Slide Browser's top chrome: brand, the room label, result count, the "Across" density steps,
// the settings glimpse popover and the `?` cheat-sheet button.
import type { Dispatch, SetStateAction } from 'react'
import { LayoutGrid, Settings2 } from 'lucide-react'

/** The settings-glimpse popover's local state (real settings land in Task 11). It lives in the
 *  shell, not here, so it survives the Browser closing and reopening. */
export interface SettingsGlimpse {
  density: number
  setDensity: Dispatch<SetStateAction<number>>
  lastFilters: boolean
  setLastFilters: Dispatch<SetStateAction<boolean>>
  scoped: boolean
  setScoped: Dispatch<SetStateAction<boolean>>
}

export function TopBar({ countLabel, density, onDensity, openPop, setOpenPop, glimpse, onOpenHelp }: {
  countLabel: string
  density: number
  onDensity: (d: number) => void
  openPop: string | null
  setOpenPop: Dispatch<SetStateAction<string | null>>
  glimpse: SettingsGlimpse
  onOpenHelp: () => void
}) {
  return (
    <header className="lt-topbar">
      <div className="lt-brand">
        <span className="lt-wordmark">TalkWeaver</span>
        <span className="lt-room">Slide Browser</span>
      </div>
      {/* ↵ opens the insert-decision viewer (v0.15.x) — the old "Focus" tab promised a
          talk-switching flow that no longer exists, so the nav is just the room label. */}
      <nav className="lt-viewtabs" aria-label="View">
        <button className="active" type="button">
          <LayoutGrid className="lt-icon" /> Browser <kbd>⌘S</kbd>
        </button>
      </nav>
      <div className="lt-top-spacer" />
      <span className="lt-result-count">{countLabel}</span>
      <div className="lt-density">
        <span>Across</span>
        <div className="lt-steps">
          {[2, 3, 4, 5, 6].map((d) => (
            <button
              key={d}
              type="button"
              className={density === d ? 'active' : ''}
              title={`${d} across (${d})`}
              onClick={() => onDensity(d)}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <div
        className="lt-tool-btn iconbtn"
        role="button"
        tabIndex={0}
        title="Browser settings — full settings in Settings (⌘,)"
        style={{ cursor: 'pointer' }}
        onClick={(e) => { e.stopPropagation(); setOpenPop((p) => (p === 'settings' ? null : 'settings')) }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setOpenPop((p) => (p === 'settings' ? null : 'settings')) } }}
      >
        <Settings2 className="lt-icon" />
        {/* settings glimpse: these options LIVE in Settings (Task 11); the popover is a shortcut */}
        <div className={`lt-pop${openPop === 'settings' ? ' open' : ''}`} onClick={(e) => e.stopPropagation()}>
          <div className="lt-pop-title">Slide Browser settings</div>
          <div className="lt-pop-sub">A glimpse of Settings → Slide Browser. Nothing is configured from the chrome itself.</div>
          <div className="lt-prow">
            <span className="lt-pl">Default density<span className="lt-ph">Used when the Browser opens fresh</span></span>
            <div className="lt-steps-sm">
              {[2, 3, 4, 5, 6].map((d) => (
                <button key={d} type="button" className={glimpse.density === d ? 'active' : ''} onClick={() => glimpse.setDensity(d)}>{d}</button>
              ))}
            </div>
          </div>
          <div className="lt-prow">
            <span className="lt-pl">Reopen with last filters<span className="lt-ph">Remember search, Talk and layout filters between openings</span></span>
            <button type="button" className={`lt-switch${glimpse.lastFilters ? ' on' : ''}`} title="Toggle" onClick={() => glimpse.setLastFilters((v) => !v)} />
          </div>
          <div className="lt-prow">
            <span className="lt-pl">Open scoped to current Talk<span className="lt-ph">⌘S from the editor pre-filters to the Talk you are in</span></span>
            <button type="button" className={`lt-switch${glimpse.scoped ? ' on' : ''}`} title="Toggle" onClick={() => glimpse.setScoped((v) => !v)} />
          </div>
          <div className="lt-pop-foot">Full page, searchable, with the settings changelog: <b>Settings ⌘,</b> → Slide Browser.</div>
        </div>
      </div>
      <button
        type="button"
        className="lt-tool-btn iconbtn lt-help-btn"
        title="Keyboard cheat-sheet (?)"
        onClick={(e) => { e.stopPropagation(); onOpenHelp() }}
      >
        ?
      </button>
    </header>
  )
}
