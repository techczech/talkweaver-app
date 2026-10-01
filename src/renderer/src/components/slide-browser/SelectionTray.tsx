// The action tray (A4, insert context; mockup 545-561/1506-1516): floats bottom-centre INSIDE the
// browser body (bottom:18px), so it never overlaps the hint bar below. Appears whenever anything
// is selected.
import { ArrowDown, Tag } from 'lucide-react'
import { liveShortcutLabel } from '../../keymap/store'

export function SelectionTray({ count, onClear, onTag, onInsert }: {
  count: number
  onClear: () => void
  onTag: () => void
  onInsert: () => void
}) {
  return (
    <div className="lt-tray" role="toolbar" aria-label="Selection actions">
      <div className="lt-t-count">
        <span className="lt-n">{count}</span>
        <span className="lt-w">{count === 1 ? 'slide selected' : 'slides selected'}</span>
      </div>
      <div className="lt-t-sep" />
      <button type="button" className="lt-t-clear" title="Clear selection (Esc)" onClick={onClear}>
        Clear
      </button>
      <span className="lt-t-hint">⇧-click for a range · S selects a section</span>
      <button type="button" className="lt-btn" onClick={onTag} title="Tag the selected slides (T)">
        <Tag className="lt-icon" />
        Tag <kbd>{liveShortcutLabel('slide-picker.tags')}</kbd>
      </button>
      <button type="button" className="lt-btn primary" onClick={onInsert}>
        <ArrowDown className="lt-icon" />
        Insert {count} selected at caret <kbd>{liveShortcutLabel('slide-picker.insert')}</kbd>
      </button>
    </div>
  )
}
