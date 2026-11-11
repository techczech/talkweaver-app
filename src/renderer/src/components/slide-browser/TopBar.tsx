// The Slide Browser's top chrome: the title (no wordmark: R14), result count, the "Across" density steps,
// the Open settings command and the `?` cheat-sheet button.
import { openSettingsAt } from '../../lib/open-settings'
import type { Dispatch, SetStateAction } from 'react'
import { LayoutGrid, Settings2 } from 'lucide-react'
import ModeBack from '../ModeBack'

export function TopBar({ countLabel, density, onDensity, openPop: _openPop, setOpenPop: _setOpenPop, onOpenHelp, talkTitle, onBack }: {
  countLabel: string
  density: number
  onDensity: (d: number) => void
  openPop: string | null
  setOpenPop: Dispatch<SetStateAction<string | null>>
  onOpenHelp: () => void
  /** The one back control of a workspace mode (house rule R16): top left, "Back to <talk>", Esc does the same. */
  talkTitle?: string | null
  onBack: () => void
}) {
  return (
    <header className="lt-topbar">
      <ModeBack talkTitle={talkTitle} onBack={onBack} />
      <div className="lt-brand">
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
      <button
        type="button"
        className="lt-tool-btn iconbtn"
        aria-label="Open settings for Slide Browser"
        title="Open settings for Slide Browser"
        onClick={(e) => { e.stopPropagation(); openSettingsAt() }}
      >
        <Settings2 className="lt-icon" />
      </button>
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
