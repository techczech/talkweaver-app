import { useRef, type KeyboardEvent, type ReactElement } from 'react'
import type { EditorViewMode } from '../../../shared/editor-view-mode'

const TABS: ReadonlyArray<{ mode: EditorViewMode; label: string }> = [
  { mode: 'plain', label: 'Plain' },
  { mode: 'markdown', label: 'Markdown' }
]

export type EditorTabsProps = {
  mode: EditorViewMode
  onChange: (mode: EditorViewMode) => void
}

/** The two tabs above the editor: the same outline shown as Plain or as Markdown (spec T1, T3). */
export default function EditorTabs({ mode, onChange }: EditorTabsProps): ReactElement {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const index = TABS.findIndex((tab) => tab.mode === mode)
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    else return
    event.preventDefault()
    onChange(TABS[next].mode)
    refs.current[next]?.focus()
  }

  return (
    <div className="tw-editor-tabs" role="tablist" aria-label="Editor view" onKeyDown={onKeyDown}>
      {TABS.map((tab, i) => (
        <button
          key={tab.mode}
          ref={(el) => { refs.current[i] = el }}
          type="button"
          role="tab"
          id={`tw-editor-tab-${tab.mode}`}
          aria-selected={tab.mode === mode}
          tabIndex={tab.mode === mode ? 0 : -1}
          className={`tw-editor-tab${tab.mode === mode ? ' is-selected' : ''}`}
          onClick={() => onChange(tab.mode)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
