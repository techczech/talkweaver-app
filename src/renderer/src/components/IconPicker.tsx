import React, { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Palette to search the icon vocabulary (Lucide names/tags + SVGL brands) and pin a glyph onto
 * the caret's current list bullet (ADR-0021). The engine (html-presentations 05-icons.mjs) owns
 * the sets and the rendering; the main process exposes searchIcons/iconSvg over the
 * window.tw.icons bridge. On pick we emit onIconSelected(key); the parent writes
 * `{icon=KEY}` to the bullet via outline.setItemIcon.
 *
 * Mirrors ArchiveImageSearch: debounced search, results grid, ←↑↓→ navigation, Enter pick,
 * Escape close, capture-phase key handling so the editor never also sees the keystroke.
 */

type IconHit = { key: string; source: 'lucide' | 'svgl' }

type IconsApi = {
  search: (query: string) => Promise<IconHit[]>
  svg: (key: string) => Promise<string | null>
}

// Read window.tw.icons without depending on the preload's exported type, so a missing/lagging
// preload declaration never breaks this file's compilation (matches ArchiveImageSearch).
function iconsApi(): IconsApi | null {
  const tw = (window as unknown as { tw?: { icons?: IconsApi } }).tw
  return tw?.icons ?? null
}

interface Props {
  isOpen: boolean
  onClose: () => void
  /** Called with the chosen icon key (`lucide:name` / `svgl:name`). Parent pins it to the bullet. */
  onIconSelected: (key: string) => void
}

const DEBOUNCE_MS = 200
const COLUMNS = 6

export default function IconPicker({ isOpen, onClose, onIconSelected }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<IconHit[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [loading, setLoading] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  // Guards against out-of-order async resolutions clobbering newer results.
  const reqIdRef = useRef(0)
  // Prevents double-pick (Enter + click racing).
  const pickLockRef = useRef(false)

  // Reset + focus on open.
  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setResults([])
    setActiveIndex(0)
    setLoading(false)
    pickLockRef.current = false
    // Deferred + retried focus — CodeMirror can grab focus back on the opening shortcut's keyup.
    const focus = (): void => { inputRef.current?.focus(); inputRef.current?.select?.() }
    requestAnimationFrame(focus)
    const ft = setTimeout(focus, 60)
    return () => clearTimeout(ft)
  }, [isOpen])

  // Debounced icon search. searchIcons needs >= 2 chars; a shorter query yields no results.
  useEffect(() => {
    if (!isOpen) return
    const api = iconsApi()
    if (!api) return

    const reqId = ++reqIdRef.current
    setLoading(true)
    const handle = setTimeout(async () => {
      const hits = await api.search(query).catch(() => [])
      if (reqId !== reqIdRef.current) return // a newer request superseded this one
      setLoading(false)
      setResults(Array.isArray(hits) ? hits : [])
      setActiveIndex(0)
    }, DEBOUNCE_MS)

    return () => clearTimeout(handle)
  }, [query, isOpen])

  // Keep the active card in view.
  useEffect(() => {
    if (!gridRef.current) return
    const el = gridRef.current.querySelector<HTMLElement>('[data-active="true"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])

  const pick = useCallback(
    (hit: IconHit) => {
      if (pickLockRef.current) return
      pickLockRef.current = true
      onIconSelected(hit.key)
      onClose()
    },
    [onIconSelected, onClose]
  )

  // Keyboard navigation (capture so we intercept before editor handlers).
  useEffect(() => {
    if (!isOpen) return

    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (results.length === 0) return
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        setActiveIndex((i) => Math.min(i + 1, results.length - 1))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        setActiveIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setActiveIndex((i) => Math.min(i + COLUMNS, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setActiveIndex((i) => Math.max(i - COLUMNS, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        const hit = results[activeIndex]
        if (hit) pick(hit)
      }
    }

    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
  }, [isOpen, results, activeIndex, onClose, pick])

  if (!isOpen) return null

  return (
    <>
      <div style={backdropStyle} onClick={onClose} />

      <div style={modalStyle} role="dialog" aria-modal="true" aria-label="Search icons">
        <input
          ref={inputRef}
          autoFocus
          style={inputStyle}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search icons (Lucide + brands)…"
          aria-label="Icon search query"
          data-icon-search
        />

        <div ref={gridRef} style={bodyStyle}>
          {results.length === 0 ? (
            <div style={messageStyle}>
              {loading
                ? 'Searching…'
                : query.trim().length < 2
                  ? 'Type at least two letters to search icons'
                  : `No icons match "${query}"`}
            </div>
          ) : (
            <div style={gridStyle} role="listbox" aria-label="Icon results">
              {results.map((hit, idx) => (
                <IconCard
                  key={hit.key}
                  hit={hit}
                  active={idx === activeIndex}
                  onHover={() => setActiveIndex(idx)}
                  onSelect={() => pick(hit)}
                />
              ))}
            </div>
          )}
        </div>

        <div style={footerStyle}>
          <span>
            <kbd style={kbdStyle}>←↑↓→</kbd> navigate
          </span>
          <span>
            <kbd style={kbdStyle}>↵</kbd> pick
          </span>
          <span>
            <kbd style={kbdStyle}>Esc</kbd> close
          </span>
        </div>
      </div>
    </>
  )
}

interface CardProps {
  hit: IconHit
  active: boolean
  onHover: () => void
  onSelect: () => void
}

function IconCard({ hit, active, onHover, onSelect }: CardProps) {
  const [svg, setSvg] = useState<string | null>(null)
  // The bare name after the `lucide:` / `svgl:` prefix — the human-readable label.
  const label = hit.key.replace(/^(lucide|svgl):/, '')

  // Fetch the rendered glyph for this key. The engine returns sanitized SVG markup
  // (no <script>); we inject it via dangerouslySetInnerHTML into a sized box.
  useEffect(() => {
    let cancelled = false
    const api = iconsApi()
    if (!api) return
    api
      .svg(hit.key)
      .then((markup) => {
        if (!cancelled) setSvg(markup)
      })
      .catch(() => {
        if (!cancelled) setSvg(null)
      })
    return () => {
      cancelled = true
    }
  }, [hit.key])

  return (
    <div
      role="option"
      aria-selected={active}
      data-active={active ? 'true' : 'false'}
      data-icon-key={hit.key}
      onClick={onSelect}
      onMouseEnter={onHover}
      title={hit.key}
      style={{
        ...cardStyle,
        borderColor: active ? 'var(--oxford)' : 'var(--line)',
        background: active ? 'var(--hover)' : 'var(--panel)',
        boxShadow: active ? '0 0 0 2px color-mix(in srgb, var(--oxford) 25%, transparent)' : 'none'
      }}
    >
      <div style={glyphWrapStyle}>
        {svg ? (
          <span style={glyphStyle} dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <span style={glyphFallbackStyle}>{label.slice(0, 2).toUpperCase()}</span>
        )}
      </div>
      <div style={labelStyle}>{label}</div>
    </div>
  )
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  background: '#17202a30'
}

const modalStyle: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 1001,
  width: 640,
  maxWidth: 'calc(100vw - 48px)',
  maxHeight: 'calc(100vh - 96px)',
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  boxShadow: '0 8px 40px #17202a18',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden'
}

const inputStyle: React.CSSProperties = {
  padding: '12px 16px',
  border: 'none',
  borderBottom: '1px solid var(--line)',
  background: 'transparent',
  fontSize: 14,
  color: 'var(--ink)',
  outline: 'none',
  width: '100%'
}

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  minHeight: 160
}

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`,
  gap: 10,
  padding: 14
}

const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 5,
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: 8,
  cursor: 'pointer',
  transition: 'border-color 0.12s, background 0.12s, box-shadow 0.12s',
  minWidth: 0
}

const glyphWrapStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--oxford)'
}

// The injected SVG inherits color via currentColor; size it to the wrap box.
const glyphStyle: React.CSSProperties = {
  display: 'inline-flex',
  width: 28,
  height: 28,
  alignItems: 'center',
  justifyContent: 'center'
}

const glyphFallbackStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--faint)'
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--muted)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '100%'
}

const messageStyle: React.CSSProperties = {
  padding: '40px 16px',
  fontSize: 13,
  color: 'var(--muted)',
  textAlign: 'center'
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  gap: 16,
  padding: '8px 16px',
  borderTop: '1px solid var(--line)',
  fontSize: 11,
  color: 'var(--faint)'
}

const kbdStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  background: 'var(--hover)',
  border: '1px solid var(--line)',
  borderRadius: 3,
  padding: '2px 5px',
  color: 'var(--ink)',
  display: 'inline-block',
  margin: '0 1px'
}
