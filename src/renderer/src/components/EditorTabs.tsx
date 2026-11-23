import { useRef, type KeyboardEvent } from 'react'
import { CodeXml, LayoutGrid, ListTree, Square } from 'lucide-react'
import { WORKSPACE_VIEWS, WORKSPACE_VIEW_LABELS, type WorkspaceView } from '../../../shared/workspace-view'

const ICONS = { slide: Square, grid: LayoutGrid, outline: ListTree, markdown: CodeXml }

/** WN1: one view switch in the title bar; all four views share one document. */
export default function EditorTabs({ mode, onChange, shortcut }: {
  mode: WorkspaceView | null
  onChange: (mode: WorkspaceView) => void
  shortcut: (mode: WorkspaceView) => string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const index = mode ? WORKSPACE_VIEWS.indexOf(mode) : 0
    const count = WORKSPACE_VIEWS.length
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % count
    else if (event.key === 'ArrowLeft') next = (index + count - 1) % count
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else return
    event.preventDefault()
    onChange(WORKSPACE_VIEWS[next])
    refs.current[next]?.focus()
  }
  return (
    <div className="pane-toggle workspace-view-switch" role="group" aria-label="View" data-view-segment onKeyDown={onKeyDown}>
      {WORKSPACE_VIEWS.map((view, i) => {
        const Glyph = ICONS[view]
        const label = WORKSPACE_VIEW_LABELS[view]
        return (
          <button type="button" className={`pane-btn${mode === view ? ' pane-btn--active' : ''}`} key={view}
            ref={el => { refs.current[i] = el }}
            aria-label={label} aria-pressed={mode === view} title={`${label} view (${shortcut(view)})`}
            data-testid={view === 'slide' ? 'slides-toggle' : `${view}-toggle`} onClick={() => onChange(view)}>
            <Glyph size={15} strokeWidth={1.75} aria-hidden /><span className="pane-btn-label">{label}</span>
          </button>
        )
      })}
    </div>
  )
}
