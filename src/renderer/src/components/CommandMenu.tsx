import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { TASK_GROUPS, type TaskGroup } from '../../../shared/task-groups'
import { TaskGroupIcon } from './TaskGroupIcon'
import './command-menu.css'

export interface Command {
  id: string
  title: string
  hint?: string
  group?: string
  subgroup?: string
  keywords?: string[]
  /** Unavailable commands stay discoverable but cannot run. */
  disabled?: boolean
  run: () => void
}

interface Props {
  isOpen: boolean
  onClose: () => void
  commands: Command[]
  /** Text handed over by Actions here. */
  initialQuery?: string
  hideEmptyGroups?: boolean
}

type Row = { kind: 'group'; group: TaskGroup; count: number } | { kind: 'command'; command: Command; heading?: string }

function matchBand(command: Command, query: string, queryWords: string[]): number {
  const label = command.title.toLowerCase()
  if (label.replace(/…$/, '') === query.replace(/…$/, '')) return 0
  if (label.startsWith(query)) return 1
  const labelWords = label.split(/[^\p{L}\p{N}]+/u)
  if (queryWords.every(word => labelWords.some(labelWord => labelWord.startsWith(word)))) return 2
  const other = [label, command.hint ?? '', command.group ?? '', command.subgroup ?? '', ...(command.keywords ?? [])]
  return other.some(text => text.toLowerCase().includes(query)) ? 3 : -1
}

export default function CommandMenu({ isOpen, onClose, commands, initialQuery = '', hideEmptyGroups = false }: Props) {
  const [query, setQuery] = useState(initialQuery)
  const [group, setGroup] = useState<TaskGroup | null>(null)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const composing = useRef(false)
  const listId = useId()
  const q = query.toLowerCase().trim()
  const groups = TASK_GROUPS.map(group => ({ kind: 'group' as const, group, count: commands.filter(c => c.group === group).length }))
    .filter(row => !hideEmptyGroups || row.count > 0)
  let rows: Row[]
  if (q) {
    const words = q.split(/\s+/)
    const bands: Command[][] = [[], [], [], []]
    for (const command of commands) {
      if (group && command.group !== group) continue
      const band = matchBand(command, q, words)
      if (band >= 0) bands[band].push(command)
    }
    rows = bands.flat().map(command => ({ kind: 'command', command }))
  } else if (group) {
    const filtered = commands.filter(c => c.group === group)
    // The same registry subgroups feed native menus. Preserve their first-declared order.
    const headings = [...new Set(filtered.map(c => c.subgroup ?? group))]
    rows = headings.flatMap(heading => filtered.filter(c => (c.subgroup ?? group) === heading).map((command, index) => ({ kind: 'command' as const, command, ...(index === 0 ? { heading } : {}) })))
  } else {
    rows = groups
  }

  const restoreFocus = (): void => {
    const target = previousFocus.current
    previousFocus.current = null
    if (target?.isConnected) target.focus()
  }

  useLayoutEffect(() => {
    if (!isOpen) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery(initialQuery)
    setGroup(null)
    setActive(0)
    composing.current = false
    inputRef.current?.focus()
    return restoreFocus
    // Actions here supplies the opening query; changes while open must not reset browsing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, group, query])

  const dismiss = (): void => {
    restoreFocus()
    onClose()
  }
  const back = (): void => {
    setActive(Math.max(0, groups.findIndex(row => row.group === group)))
    setGroup(null)
    setQuery('')
    inputRef.current?.focus()
  }
  const activate = (row: Row): void => {
    if (row.kind === 'group') { if (!row.count) return; setGroup(row.group); setQuery(''); setActive(0); inputRef.current?.focus(); return }
    if (row.command.disabled) return
    dismiss()
    row.command.run()
  }

  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent): void {
      if (composing.current || e.isComposing || e.keyCode === 229) return
      // Modified arrows/Backspace/Enter belong to text editing and platform input, not browsing.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Tab') {
        e.preventDefault()
        const backButton = document.querySelector<HTMLButtonElement>(`[data-command-menu] .command-menu-back`)
        if (backButton && document.activeElement === inputRef.current) backButton.focus()
        else inputRef.current?.focus()
        return
      }
      if (e.shiftKey) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (group) back(); else dismiss() }
      else if (group && !query && (e.key === 'ArrowLeft' || e.key === 'Backspace')) { e.preventDefault(); e.stopPropagation(); back() }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        setActive(i => Math.max(0, Math.min(i + (e.key === 'ArrowDown' ? 1 : -1), rows.length - 1)))
      } else if ((e.key === 'Enter' || e.key === 'ArrowRight') && rows[active]) {
        if (e.key === 'ArrowRight' && rows[active].kind !== 'group') return
        // A focused Back button retains its own native Enter behaviour.
        if (e.key === 'Enter' && document.activeElement !== inputRef.current) return
        e.preventDefault(); e.stopPropagation(); activate(rows[active])
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  })

  if (!isOpen) return null
  return <>
    <div className="command-menu-backdrop" onMouseDown={e => e.preventDefault()} onClick={dismiss} />
    <div className="command-menu" role="dialog" aria-modal="true" aria-label="Command palette" data-command-menu>
      {group && <div className="command-menu-breadcrumb">
        <button className="command-menu-back" onClick={back} aria-label="Back to task groups"><ChevronLeft size={15} />All groups</button>
        <TaskGroupIcon group={group} /><span>{group}</span>
      </div>}
      <input ref={inputRef} className="command-menu-input" type="text" value={query}
        onChange={e => { setQuery(e.target.value); setActive(0) }}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        placeholder={group ? `Search ${group}…` : 'Search commands or browse a task…'} aria-label="Command query"
        role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
        aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined} />
      <ul id={listId} ref={listRef} className="command-menu-list" role="listbox" aria-label={group ?? 'Commands and task groups'}>
        {!rows.length && <li className="command-menu-empty" role="presentation">No commands match</li>}
        {rows.map((row, idx) => {
          const isActive = idx === active
          const cmd = row.kind === 'command' ? row.command : null
          return <Fragment key={cmd?.id ?? (row.kind === 'group' ? row.group : idx)}>
            {row.kind === 'command' && row.heading && <li className="command-menu-subgroup" role="presentation">{row.heading}</li>}
            <li id={`${listId}-${idx}`} role="option" aria-selected={isActive} aria-disabled={cmd?.disabled || (row.kind === 'group' && !row.count) ? 'true' : undefined}
              data-active={isActive ? 'true' : 'false'} data-command={cmd?.id}
              data-task-group={row.kind === 'group' ? row.group : undefined} data-count={row.kind === 'group' ? row.count : undefined}
              className={`command-menu-item${row.kind === 'group' ? ' command-menu-category' : ''}${isActive ? ' command-menu-item--active' : ''}${cmd?.disabled || (row.kind === 'group' && !row.count) ? ' command-menu-item--disabled' : ''}`}
              onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(idx)} onClick={() => activate(row)}>
              {row.kind === 'group' ? <>
                <span className="command-menu-category-icon"><TaskGroupIcon group={row.group} /></span>
                <span className="command-menu-title">{row.group}</span><span className="command-menu-count">{row.count} {row.count === 1 ? 'command' : 'commands'}</span><ChevronRight size={15} aria-hidden="true" />
              </> : <>
                <span className="command-menu-title">{row.command.title}</span>
                {!group && row.command.group && <span className="command-menu-group">{row.command.group}</span>}
                {row.command.hint && <span className="command-menu-hint">{row.command.hint}</span>}
              </>}
            </li>
          </Fragment>
        })}
      </ul>
      <div className="command-menu-footer"><span>↑↓ navigate</span><span>{group ? '↵ run · ← back' : q ? '↵ run' : '↵ / → open group'}</span><span>{group ? 'esc back' : 'esc close'}</span></div>
    </div>
  </>
}
