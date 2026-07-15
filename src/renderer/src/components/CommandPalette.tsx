import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LAYOUTS, type LayoutDef, type OptionGroup } from '../data/layouts'
import {
  filterLayoutPickerEntries,
  layoutPickerModel,
  optionGroupsForPickerEntry,
  pickerTypeStripModel,
  selectionFromTriggerLine,
  toggleLayoutSelection,
  type PickerOptionGroup,
  type LayoutPickerContext
} from './layoutPickerModel'

// Bespoke mini-previews, keyed by layout name. Any layout without an entry here
// falls back to genericPreview so every list row shows something.
const PREVIEWS: Record<string, React.ReactNode> = {
  statement: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: '6px'
        }}
      >
        <span
          style={{
            fontSize: '11px',
            fontWeight: 700,
            textAlign: 'center',
            color: 'var(--ink)',
            lineHeight: 1.2
          }}
        >
          A bold claim
        </span>
      </div>
    </div>
  ),
  contrast: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '3px',
          height: '100%',
          padding: '5px'
        }}
      >
        <div style={{ background: 'var(--hover)', borderRadius: '2px' }}></div>
        <div style={{ background: 'var(--active)', borderRadius: '2px' }}></div>
      </div>
    </div>
  ),
  cards: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gridTemplateRows: '1fr 1fr',
          gap: '3px',
          height: '100%',
          padding: '5px'
        }}
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ background: 'var(--hover)', borderRadius: '2px' }}></div>
        ))}
      </div>
    </div>
  ),
  list: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          padding: '6px',
          justifyContent: 'center'
        }}
      >
        {[70, 85, 60].map((w, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <div
              style={{
                width: '4px',
                height: '4px',
                borderRadius: '50%',
                background: 'var(--oxford)',
                flexShrink: 0
              }}
            ></div>
            <div
              style={{
                height: '2px',
                background: 'var(--line)',
                width: w + '%',
                borderRadius: '1px'
              }}
            ></div>
          </div>
        ))}
      </div>
    </div>
  ),
  quote: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: '3px',
          padding: '4px'
        }}
      >
        <span
          style={{
            fontSize: '22px',
            color: 'var(--oxford)',
            lineHeight: 1,
            opacity: 0.35,
            fontFamily: 'Georgia,serif'
          }}
        >
          &ldquo;
        </span>
        <div
          style={{
            height: '2px',
            background: 'var(--line)',
            width: '75%',
            borderRadius: '1px'
          }}
        ></div>
        <div
          style={{
            height: '2px',
            background: 'var(--line)',
            width: '55%',
            borderRadius: '1px'
          }}
        ></div>
        <div
          style={{
            height: '1px',
            background: 'var(--faint)',
            width: '35%',
            borderRadius: '1px',
            marginTop: '2px'
          }}
        ></div>
      </div>
    </div>
  ),
  code: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div style={{ padding: '4px', height: '100%', boxSizing: 'border-box' as const }}>
        <div
          style={{
            background: '#1e1e2e',
            borderRadius: '2px',
            height: '100%',
            padding: '4px',
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              fontSize: '6px',
              color: '#89b4fa',
              fontFamily: 'monospace',
              lineHeight: 1.6
            }}
          >
            <div>
              <span style={{ color: '#cba6f7' }}>function</span> hello() {'{'}
            </div>
            <div>
              &nbsp;&nbsp;<span style={{ color: '#a6e3a1' }}>return</span>{' '}
              <span style={{ color: '#fab387' }}>&quot;world&quot;</span>
            </div>
            <div>{'}'}</div>
          </div>
        </div>
      </div>
    </div>
  ),
  timeline: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '8px',
          gap: '4px'
        }}
      >
        {[0, 1, 2].map((i) => (
          <React.Fragment key={i}>
            <div
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                border: '2px solid var(--oxford)',
                background: 'var(--paper)',
                flexShrink: 0
              }}
            ></div>
            {i < 2 && <div style={{ height: '2px', background: 'var(--line)', flex: 1 }}></div>}
          </React.Fragment>
        ))}
      </div>
    </div>
  ),
  stats: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%'
        }}
      >
        <span
          style={{
            fontSize: '28px',
            fontWeight: 900,
            color: 'var(--oxford)',
            lineHeight: 1,
            opacity: 0.6
          }}
        >
          42
        </span>
      </div>
    </div>
  ),
  media: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{
          height: '100%',
          background: 'linear-gradient(135deg,#d9d0c1,#c0b8a8)',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          paddingBottom: '5px'
        }}
      >
        <div
          style={{
            height: '2px',
            background: 'rgba(255,255,255,0.6)',
            width: '60%',
            borderRadius: '1px'
          }}
        ></div>
      </div>
    </div>
  ),
  title: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: '5px'
        }}
      >
        <div
          style={{
            height: '3px',
            background: 'var(--oxford)',
            width: '65%',
            borderRadius: '1px'
          }}
        ></div>
        <div
          style={{
            height: '2px',
            background: 'var(--line)',
            width: '45%',
            borderRadius: '1px'
          }}
        ></div>
      </div>
    </div>
  ),
  subsection: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: '4px'
        }}
      >
        <div style={{ height: '1px', background: 'var(--line)', width: '80%' }}></div>
        <div
          style={{
            height: '2px',
            background: 'var(--oxford)',
            width: '50%',
            borderRadius: '1px'
          }}
        ></div>
        <div style={{ height: '1px', background: 'var(--line)', width: '80%' }}></div>
      </div>
    </div>
  ),
  highlight: (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div style={{ padding: '5px', height: '100%', boxSizing: 'border-box' as const }}>
        <div
          style={{
            background: 'rgba(11,58,107,0.07)',
            borderRadius: '3px',
            borderLeft: '3px solid var(--oxford)',
            height: '100%',
            padding: '4px',
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
            justifyContent: 'center'
          }}
        >
          <div
            style={{
              height: '2px',
              background: 'rgba(11,58,107,0.4)',
              width: '70%',
              borderRadius: '1px'
            }}
          ></div>
          <div
            style={{
              height: '2px',
              background: 'var(--line)',
              width: '85%',
              borderRadius: '1px'
            }}
          ></div>
        </div>
      </div>
    </div>
  )
}

// Generic fallback preview: a title bar plus two text lines. Used for any layout
// name that does not have a bespoke entry in PREVIEWS above.
const genericPreview: React.ReactNode = (
  <div style={{ width: '100%', height: '100%', position: 'relative' }}>
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '6px',
        justifyContent: 'center',
        height: '100%'
      }}
    >
      <div
        style={{
          height: '3px',
          background: 'var(--oxford)',
          width: '55%',
          borderRadius: '1px'
        }}
      ></div>
      <div
        style={{
          height: '2px',
          background: 'var(--line)',
          width: '85%',
          borderRadius: '1px',
          marginTop: '2px'
        }}
      ></div>
      <div
        style={{
          height: '2px',
          background: 'var(--line)',
          width: '70%',
          borderRadius: '1px'
        }}
      ></div>
    </div>
  </div>
)

// The hand-drawn fallback for a layout (bespoke if we have one, else the generic title+lines).
function fallbackPreviewFor(name: string): React.ReactNode {
  return PREVIEWS[name] ?? genericPreview
}

// The preview shown in a layout row: the REAL compiled thumbnail (an <img> of the layout's
// Reference fixture) when the IPC map has a URL for it, otherwise the hand-drawn fallback. The
// <img> drops back to the hand-drawn version on a load error so a missing PNG never shows broken.
function previewFor(name: string, thumbUrl: string | undefined): React.ReactNode {
  if (thumbUrl) {
    return (
      <img
        src={thumbUrl}
        alt=""
        data-layout-thumb={name}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        onError={(e) => {
          // Hide the broken image; the hand-drawn fallback layer underneath shows through.
          ;(e.currentTarget as HTMLImageElement).style.display = 'none'
        }}
      />
    )
  }
  return fallbackPreviewFor(name)
}

function optionThumbKind(entry: LayoutDef, token: string): string | null {
  const key = `${entry.name}:${token || 'default'}`
  const kinds: Record<string, string> = {
    'contrast:default': 'contrast-default',
    'contrast:contrast=ledger': 'contrast-ledger',
    'contrast:contrast=rows': 'contrast-rows',
    'contrast:contrast=tint': 'contrast-tint',
    'contrast:contrast=flip': 'contrast-flip',
    'cards:default': 'cards-grid',
    'cards:cards=grid': 'cards-grid',
    'cards:cards=rows': 'cards-rows',
    'cards:cards=stepped': 'cards-stepped'
  }
  return kinds[key] ?? null
}

export function OptionThumb({ entry, token }: { entry: LayoutDef; token: string }): React.JSX.Element {
  const kind = optionThumbKind(entry, token)
  return (
    <span className={`layout-option-thumb${kind ? ` layout-option-thumb--${kind}` : ' layout-option-thumb--neutral'}`}>
      <i /><i /><i /><i /><i /><i />
    </span>
  )
}

export function OptionControl({
  entry,
  binding,
  onSelect
}: {
  entry?: LayoutDef
  binding: PickerOptionGroup
  onSelect: (group: OptionGroup, token: string) => void
}): React.JSX.Element {
  const { group, selectedToken } = binding
  const isThumbs = group.preview === 'thumbs' && entry != null
  const moveWithinGroup = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      onSelect(group, group.values[index].token)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    const nextIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + group.values.length) % group.values.length
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')
    buttons?.[nextIndex]?.focus()
  }

  return (
    <div className={isThumbs ? 'layout-option-thumbs' : 'layout-option-segments'} role="group" aria-label={group.label}>
      {group.values.map((value, index) => {
        const selected = value.token === selectedToken
        return (
          <button
            key={`${group.key}:${value.token || 'default'}`}
            type="button"
            className={selected ? 'is-selected' : undefined}
            aria-pressed={selected}
            title={value.description}
            tabIndex={selected || (!group.values.some((candidate) => candidate.token === selectedToken) && index === 0) ? 0 : -1}
            onClick={() => onSelect(group, value.token)}
            onKeyDown={(event) => moveWithinGroup(event, index)}
          >
            {isThumbs && <OptionThumb entry={entry} token={value.token} />}
            {value.swatch && <span className="layout-option-swatch" style={{ background: value.swatch }} aria-hidden />}
            <span>{value.label}</span>
          </button>
        )
      })}
    </div>
  )
}

interface Props {
  isOpen: boolean
  query: string
  context: LayoutPickerContext | null
  onClose: () => void
  onCommit: (initial: LayoutDef[], selected: LayoutDef[]) => void
  onCommitOption: (entry: LayoutDef | undefined, group: OptionGroup, token: string) => string | null
  onInsertComponent: (text: string) => void
}

export default function CommandPalette({ isOpen, query, context, onClose, onCommit, onCommitOption, onInsertComponent }: Props) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [searchText, setSearchText] = useState(query)
  const [templates, setTemplates] = useState<Record<string, string>>({})
  const [aliases, setAliases] = useState<Record<string, string>>({})
  // Real per-layout preview thumbnails (Feature #3): { layoutName: twthumb://… }. Fetched once on
  // first open; layouts absent here fall back to the hand-drawn preview. `triedThumbnails` guards
  // the fetch so a null/empty result (compiler unavailable) is not retried every open.
  const [thumbnailMap, setThumbnailMap] = useState<Record<string, string>>({})
  const [triedThumbnails, setTriedThumbnails] = useState(false)
  const [showTemplate, setShowTemplate] = useState(false)
  const [selected, setSelected] = useState<LayoutDef[]>([])
  const [triggerLine, setTriggerLine] = useState(context?.triggerLine ?? '')
  const initialSelection = useMemo(
    () => selectionFromTriggerLine(context?.triggerLine ?? '', LAYOUTS),
    [context]
  )
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Fetch the single-source blank Layout templates once on first open (ADR-0021).
  useEffect(() => {
    if (!isOpen || Object.keys(templates).length) return
    window.tw.layout
      .templates()
      .then((res) => {
        if (res) {
          setTemplates(res.templates)
          setAliases(res.aliases)
        }
      })
      .catch(() => {})
  }, [isOpen, templates])

  // Fetch the real layout preview thumbnails once on first open (Feature #3). A null result keeps
  // the picker fully hand-drawn; an empty {} just means no layout had a fixture (also fine).
  useEffect(() => {
    if (!isOpen || triedThumbnails) return
    setTriedThumbnails(true)
    window.tw.layout
      .previewThumbnails()
      .then((res) => {
        if (res) setThumbnailMap(res)
      })
      .catch(() => {})
  }, [isOpen, triedThumbnails])

  // The blank scaffold for an item: its own template, an alias's, else just the bare trigger
  // (modes/element directives have no structural template — ⌘-Enter then behaves like Enter).
  const resolveTemplate = useCallback(
    (item: LayoutDef): string => templates[item.name] ?? templates[aliases[item.name] ?? ''] ?? item.trigger,
    [templates, aliases]
  )

  const filtered = useMemo(() => {
    const matches = filterLayoutPickerEntries(LAYOUTS, searchText)
    return layoutPickerModel(matches, context ?? { headingLevel: 3, hasChildren: false }).flatMap((section) => section.entries)
  }, [context, searchText])

  // Sync searchText when query or open state changes
  useEffect(() => {
    setSearchText(query)
    setActiveIndex(0)
    setShowTemplate(false)
    setSelected(initialSelection)
    setTriggerLine(context?.triggerLine ?? '')
  }, [query, isOpen, initialSelection])

  const commitOption = useCallback((group: OptionGroup, token: string, entry?: LayoutDef): void => {
    const next = onCommitOption(entry, group, token)
    if (next != null) setTriggerLine(next)
    if (entry) setSelected((current) => toggleLayoutSelection(current, entry))
  }, [onCommitOption])

  // Auto-focus the search input when opened. Focus is deferred AND retried because CodeMirror
  // (still focused when "/" opened the palette) can grab focus back on its keyup/blur cycle.
  useEffect(() => {
    if (!isOpen) return
    const focus = (): void => { searchRef.current?.focus(); searchRef.current?.select() }
    focus()
    const r = requestAnimationFrame(focus)
    const t = setTimeout(focus, 60)
    return () => { cancelAnimationFrame(r); clearTimeout(t) }
  }, [isOpen])

  // Reset selection when search text changes
  useEffect(() => {
    setActiveIndex(0)
  }, [searchText])

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return
    const activeEl = listRef.current.querySelector<HTMLLIElement>('[data-active="true"]')
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // Keyboard handling
  useEffect(() => {
    if (!isOpen) return

    function handleKey(e: KeyboardEvent): void {
      const target = e.target instanceof HTMLElement ? e.target : null
      // Option groups own ←/→/Space so Tab can move group-to-group without the list handler
      // swallowing their locked scene-B keyboard model during the window capture phase.
      if (target?.closest('.layout-option-thumbs, .layout-option-segments')) return
      // Two-column grid: Left/Right move by 1, Up/Down move by a row (2).
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 2, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 2, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = filtered[activeIndex]
        // ⌘/Ctrl-Enter keeps the established template action. Plain Enter commits the trigger set
        // accumulated by clicks; with no accumulated entries it retains the one-key legacy path.
        if (item) {
          if (e.metaKey || e.ctrlKey || item.kind === 'component') {
            onInsertComponent(resolveTemplate(item))
            onClose()
          } else {
            const composed = selected.some((candidate) => candidate.name === item.name)
              ? selected
              : toggleLayoutSelection(selected, item)
            onCommit(initialSelection, composed)
          }
        }
      } else if (e.key === ' ' && !searchText) {
        // Space (only when not mid-search, so it never eats a space in the query) reveals the
        // blank template for the active layout — making clear what structure it expects.
        e.preventDefault()
        setShowTemplate((v) => !v)
      }
    }

    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
  }, [isOpen, filtered, activeIndex, onClose, onCommit, onInsertComponent, resolveTemplate, searchText, selected, initialSelection])

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop: click outside closes */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 999
        }}
      />

      {/* Palette panel */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 1000,
          width: 760,
          maxHeight: 520,
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 8px 32px #17202a22, 0 2px 8px #17202a14',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: 'var(--font-ui)'
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '8px 12px 6px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: 'var(--faint)',
              fontWeight: 500
            }}
          >
            Insert layout
          </span>
          {searchText && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--oxford)',
                letterSpacing: 0
              }}
            >
              /{searchText}
            </span>
          )}
        </div>

        {/* Search input */}
        <div
          style={{
            padding: '6px 10px',
            borderBottom: '1px solid var(--line)',
            flexShrink: 0
          }}
        >
          <input
            ref={searchRef}
            autoFocus
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search layouts..."
            style={{
              width: '100%',
              background: 'var(--hover)',
              border: '1px solid var(--line)',
              borderRadius: 4,
              padding: '5px 8px',
              fontSize: 12,
              color: 'var(--ink)',
              fontFamily: 'var(--font-ui)',
              outline: 'none',
              boxSizing: 'border-box'
            }}
          />
        </div>

        {/* List — two-column grid; kind headers span both columns */}
        <div
          ref={listRef}
          role="listbox"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            columnGap: 6,
            rowGap: 2,
            alignContent: 'start',
            margin: 0,
            padding: '4px 8px',
            overflowY: 'auto',
            flex: 1
          }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                gridColumn: '1 / -1',
                padding: '12px 16px',
                fontSize: 12,
                color: 'var(--faint)',
                textAlign: 'center'
              }}
            >
              No layouts match
            </div>
          ) : (
            filtered.map((item, idx) => {
              const isActive = idx === activeIndex
              const isSelected = selected.some((candidate) => candidate.name === item.name)
              const prevItem = idx > 0 ? filtered[idx - 1] : undefined
              const showDivider = !prevItem || prevItem.kind !== item.kind
              return (
                <React.Fragment key={item.name}>
                  {showDivider && (
                    <div
                      aria-hidden="true"
                      style={{
                        gridColumn: '1 / -1',
                        padding: '8px 4px 2px',
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color: 'var(--faint)'
                      }}
                    >
                      {{ layout: 'Layout', modifier: 'Modifiers', component: 'Components', container: 'Container' }[item.kind]}
                    </div>
                  )}
                  <div
                    role="option"
                    tabIndex={isActive ? 0 : -1}
                    aria-selected={isSelected}
                    data-active={isActive ? 'true' : 'false'}
                    data-selected={isSelected ? 'true' : 'false'}
                    onClick={() => {
                      if (item.kind === 'component') { onInsertComponent(resolveTemplate(item)); onClose(); return }
                      setSelected((current) => toggleLayoutSelection(current, item))
                    }}
                    onMouseEnter={() => setActiveIndex(idx)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 6px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      minWidth: 0,
                      background: isSelected ? 'var(--active)' : isActive ? 'var(--hover)' : 'transparent',
                      borderLeft: isActive ? '3px solid var(--oxford)' : '3px solid transparent',
                      transition: 'background 0.1s'
                    }}
                  >
                    {/* Mini-preview box. The hand-drawn fallback is the base layer; when a real
                        compiled thumbnail exists it overlays on top, so an <img> load error
                        reveals the fallback underneath rather than a broken image. */}
                    <div
                      data-layout-name={item.name}
                      style={{
                        width: 72,
                        height: 40,
                        flexShrink: 0,
                        position: 'relative',
                        border: '1px solid var(--line)',
                        borderRadius: 4,
                        background: 'var(--paper)',
                        overflow: 'hidden'
                      }}
                    >
                      <div style={{ position: 'absolute', inset: 0 }}>
                        {fallbackPreviewFor(item.name)}
                      </div>
                      {thumbnailMap[item.name] && (
                        <div style={{ position: 'absolute', inset: 0 }}>
                          {previewFor(item.name, thumbnailMap[item.name])}
                        </div>
                      )}
                    </div>

                    {/* Label + trigger */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: 'var(--ink)',
                          lineHeight: 1.25,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {isSelected ? '✓ ' : ''}{item.label}
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                          color: 'var(--faint)',
                          marginTop: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                        title={item.description}
                      >
                        {item.trigger}
                      </div>
                    </div>
                  </div>
                  {isActive && optionGroupsForPickerEntry(item, triggerLine).map((binding) => (
                    <div className="layout-picker-option-row" key={binding.group.key}>
                      <span className="layout-picker-group-label">{binding.group.label}</span>
                      <OptionControl entry={item} binding={binding} onSelect={(group, token) => commitOption(group, token, item)} />
                    </div>
                  ))}
                </React.Fragment>
              )
            })
          )}
        </div>

        {/* Template preview — Space toggles the blank scaffold for the active layout */}
        {showTemplate && filtered[activeIndex] && (
          <div
            style={{
              borderTop: '1px solid var(--line)',
              padding: '6px 12px 8px',
              background: 'var(--hover)',
              flexShrink: 0,
              maxHeight: 150,
              overflowY: 'auto'
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--faint)',
                marginBottom: 4
              }}
            >
              {filtered[activeIndex].label} template — ⌘↵ to insert
            </div>
            <pre
              data-template-preview="true"
              style={{
                margin: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--ink)',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.45
              }}
            >
              {resolveTemplate(filtered[activeIndex])}
            </pre>
          </div>
        )}

        <div className="layout-picker-type-strip">
          <span className="layout-picker-group-label">Type</span>
          {pickerTypeStripModel(triggerLine).map((binding) => (
            <React.Fragment key={binding.group.key}>
              <span className="layout-picker-type-label">{binding.group.label.replace(' size', '')}</span>
              <OptionControl binding={binding} onSelect={commitOption} />
            </React.Fragment>
          ))}
          <span className="layout-picker-type-hint">Tab groups · ←→ · Space</span>
        </div>

        {/* Footer hints */}
        <div
          style={{
            padding: '5px 12px',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            gap: 16,
            fontSize: 11,
            color: 'var(--faint)',
            flexShrink: 0
          }}
        >
          <span>
            <kbd style={kbdStyle}>↑↓</kbd> navigate
          </span>
          <span>
            <kbd style={kbdStyle}>click</kbd> compose
          </span>
          <span>
            <kbd style={kbdStyle}>↵</kbd> commit
          </span>
          <span>
            <kbd style={kbdStyle}>⌘↵</kbd> template
          </span>
          <span>
            <kbd style={kbdStyle}>space</kbd> preview
          </span>
          <span>
            <kbd style={kbdStyle}>Esc</kbd> close
          </span>
        </div>
      </div>
    </>
  )
}

const kbdStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  background: 'var(--hover)',
  border: '1px solid var(--line)',
  borderRadius: 3,
  padding: '1px 4px',
  marginRight: 3
}
