import { BookmarkPlus, Check, Copy, CornerDownRight, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { liveShortcutLabel } from '../keymap/store'
import ToolbarMenu, { type MenuItem } from './ToolbarMenu'
import type { SectionKind } from '../../../shared/talk-structure'

export interface StructureActions {
  subsectionReason?: string
  groupReason?: string
  count: number
  create: (kind: SectionKind) => void
  newSlide: () => void
  group: () => void
  selectSeveral: () => void
  levelUp: () => void
  levelUpReason?: string
  duplicate: () => void
  delete: () => void
  clear: () => void
}

// ST1: the toolbar and the sidebar footer offer the same commands.
export function StructureMenu({ actions, opensUp }: { actions: StructureActions; opensUp?: boolean }) {
  const items: MenuItem[] = [
    { icon: 'section', label: 'New section', hint: liveShortcutLabel('editor.new-section'),
      onClick: () => actions.create('section'), note: 'Starts after this slide. The slides that follow in this section move into it.' },
    { icon: 'subsection', label: 'New subsection', hint: liveShortcutLabel('editor.new-subsection'),
      onClick: () => actions.create('subsection'), disabled: !!actions.subsectionReason,
      note: actions.subsectionReason ?? 'Starts a subsection inside the current section.' },
    { icon: 'slides', label: 'Make a section from several slides…', separatorBefore: true,
      onClick: actions.count > 0 ? actions.group : actions.selectSeveral,
      disabled: !!actions.groupReason, note: actions.groupReason },
    { icon: 'promote', label: 'Turn this slide into a section', hint: liveShortcutLabel('editor.promote'), onClick: actions.levelUp,
      disabled: !!actions.levelUpReason, note: actions.levelUpReason }
  ]
  return <ToolbarMenu icon="section" label="Section" title="New section or subsection" items={items} opensUp={opensUp} />
}

export function StructureFooter({ actions }: { actions: StructureActions }) {
  return <div className="tw-slides-footer">
    {actions.count ? <>
      <strong>{actions.count} <span className="tw-structure-control-label">{actions.count === 1 ? 'slide' : 'slides'} </span>selected</strong>
      <div className="tw-structure-batch">
        <button type="button" className="toolbar-btn" disabled={!!actions.groupReason} title={actions.groupReason ?? 'Make a section'}
          aria-label="Make a section" onClick={actions.group}><BookmarkPlus size={14} /><span className="tw-structure-control-label">Make a section</span></button>
        <button type="button" className="toolbar-btn" title="Duplicate" aria-label="Duplicate selected slides" onClick={actions.duplicate}><Copy size={14} /></button>
        <button type="button" className="toolbar-btn" title="Delete" aria-label="Delete selected slides" onClick={actions.delete}><Trash2 size={14} /></button>
        <button type="button" className="toolbar-btn" aria-label="Done" title="Done" onClick={actions.clear}>
          <Check size={14} /><span className="tw-structure-control-label">Done</span></button>
      </div>
      {actions.groupReason && <small>{actions.groupReason}</small>}
    </> : <div className="tw-structure-batch">
      <button type="button" className="toolbar-btn" aria-label="New slide" title="New slide" onClick={actions.newSlide}>
        <Plus size={14} /><span className="tw-structure-control-label">New slide</span></button>
      <StructureMenu actions={actions} opensUp />
    </div>}
  </div>
}

export function StructureAddLine({ onAdd, subsectionReason, always = false }: {
  onAdd: (kind: SectionKind | 'slide') => void
  subsectionReason?: string
  always?: boolean
}) {
  const [open, setOpen] = useState(false)
  const choicesId = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const choices = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (open) choices.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }, [open])
  useEffect(() => {
    if (!open) return
    // Dismiss after an outside click so the neighbouring row remains under the pointer.
    function dismiss(event: MouseEvent): void {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('click', dismiss)
    return () => document.removeEventListener('click', dismiss)
  }, [open])

  function choose(kind: SectionKind | 'slide'): void {
    setOpen(false)
    onAdd(kind)
  }

  return <div ref={root} className="tw-structure-add-line" data-always={always || undefined}
    onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ' || event.key.startsWith('Arrow') ||
          event.key === 'Home' || event.key === 'End') event.stopPropagation()
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        trigger.current?.focus({ preventScroll: true })
      }
    }}>
    {!always && <button ref={trigger} className="tw-structure-insert-trigger" type="button"
      aria-expanded={open} aria-controls={open ? choicesId : undefined} onClick={() => setOpen(value => !value)}>
      <span>Insert here</span>
    </button>}
    {(always || open) && <div ref={choices} id={choicesId} className="tw-structure-insert-choices" role="group" aria-label="Insert here">
      <button type="button" title="New slide" onClick={() => choose('slide')}><Plus size={13} /><span>Slide</span></button>
      <button type="button" title="New section" onClick={() => choose('section')}><BookmarkPlus size={13} /><span>Section</span></button>
      <button type="button" disabled={!!subsectionReason} title={subsectionReason ?? 'New subsection'} onClick={() => choose('subsection')}>
        <CornerDownRight size={13} /><span>Subsection</span></button>
    </div>}
  </div>
}
