import { useEffect, useRef, useState } from 'react'

export interface Command {
  id: string
  title: string
  hint?: string // e.g. a keyboard shortcut shown on the right
  keywords?: string[]
  run: () => void
}

interface Props {
  isOpen: boolean
  onClose: () => void
  commands: Command[]
}

// ⌘⇧P command palette: fuzzy-filter and run any app command. Mirrors the ⌘S / "/" palettes'
// keyboard model (↑↓ navigate, ↵ run, esc close).
export default function CommandMenu({ isOpen, onClose, commands }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const q = query.toLowerCase().trim()
  const filtered = commands.filter(
    (c) => !q || c.title.toLowerCase().includes(q) || (c.hint ?? '').toLowerCase().includes(q) || (c.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(q))
  )

  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setActive(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [isOpen])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLLIElement>('[data-active="true"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = filtered[active]
        if (cmd) {
          onClose()
          cmd.run()
        }
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [isOpen, filtered, active, onClose])

  if (!isOpen) return null

  return (
    <>
      <div className="command-menu-backdrop" onClick={onClose} />
      <div className="command-menu" role="dialog" aria-modal="true" aria-label="Command palette" data-command-menu>
        <input
          ref={inputRef}
          className="command-menu-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Run a command…"
          aria-label="Command query"
        />
        <ul ref={listRef} className="command-menu-list" role="listbox">
          {filtered.length === 0 ? (
            <li className="command-menu-empty">No commands match</li>
          ) : (
            filtered.map((cmd, idx) => {
              const isActive = idx === active
              return (
                <li
                  key={cmd.id}
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive ? 'true' : 'false'}
                  className={`command-menu-item${isActive ? ' command-menu-item--active' : ''}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => {
                    onClose()
                    cmd.run()
                  }}
                >
                  <span className="command-menu-title">{cmd.title}</span>
                  {cmd.hint && <span className="command-menu-hint">{cmd.hint}</span>}
                </li>
              )
            })
          )}
        </ul>
        <div className="command-menu-footer">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </>
  )
}
