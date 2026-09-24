import { Fragment, useEffect, useState } from 'react'

// ── Inline icon set (Lucide-derived, 24×24 stroke paths, currentColor) ───────────────────────────
export type IconName =
  | 'chevron-down' | 'share' | 'present' | 'insert' | 'tools'
  | 'handout' | 'html' | 'publish'
  | 'layout' | 'image' | 'slides' | 'sparkles'
  | 'abstract' | 'settings' | 'keyboard' | 'refresh'
  | 'window' | 'presenter' | 'audience'
  | 'file' | 'folder' | 'folder-open' | 'enter'
  | 'file-plus' | 'folder-plus' | 'collapse' | 'swap'
  | 'pane-editor' | 'pane-both' | 'pane-strip' | 'pane-grid'
  | 'design' | 'trash' | 'sort' | 'strip' | 'command' | 'undo' | 'redo' | 'newslide' | 'promote' | 'demote' | 'bullets' | 'numbered' | 'more'
  | 'table' | 'mindmap' | 'chart' | 'mermaid' | 'diagram' | 'svg'

const PATHS: Record<IconName, string> = {
  'chevron-down': 'M6 9l6 6 6-6',
  share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7 M16 6l-4-4-4 4 M12 2v13',
  present: 'M2 3h20v14H2z M8 21h8 M12 17v4',
  insert: 'M12 5v14 M5 12h14',
  tools: 'M14.7 6.3a4 4 0 0 0-5.6 5.6L3 18.1V21h2.9l6.2-6.1a4 4 0 0 0 5.6-5.6l-2.9 2.9-2.6-.6-.6-2.6 2.9-2.9z',
  handout: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h6',
  html: 'M8 6l-6 6 6 6 M16 6l6 6-6 6',
  publish: 'M16 16l-4-4-4 4 M12 12v9 M20.4 18.4A5 5 0 0 0 18 9h-1.3A8 8 0 1 0 4 16.3',
  layout: 'M3 3h18v18H3z M3 9h18 M9 9v12',
  image: 'M3 3h18v18H3z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 15l-5-5L5 21',
  slides: 'M8 4h12a2 2 0 0 1 2 2v12 M4 8h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z',
  sparkles: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
  abstract: 'M4 6h16 M4 12h12 M4 18h16',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.3 6.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-1.2 2.9V11a1.7 1.7 0 0 0 1.5 2.5z',
  keyboard: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M6 9h0 M10 9h0 M14 9h0 M18 9h0 M6 13h0 M18 13h0 M8 16h8',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4 M21 4v5h-5',
  window: 'M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M2 9h20',
  presenter: 'M3 4h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M8 20h8 M12 16v4 M7 8h5 M7 11h8',
  audience: 'M2 5h20v12H2z M12 21a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3z',
  file: 'M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M13 2v7h7',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  'folder-open': 'M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2 M3 8v9a2 2 0 0 0 2 2h13l2.5-7.5A1 1 0 0 0 21.5 11H7a2 2 0 0 0-1.9 1.4z',
  enter: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4 M10 17l5-5-5-5 M15 12H3',
  // New talk = file + plus; new folder = folder + plus (parallel pair, like Finder/VS Code).
  'file-plus': 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M12 12v6 M9 15h6',
  'folder-plus': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 11v6 M9 14h6',
  // Collapse all = two chevrons folding toward the centre; change vault = swap arrows (switch source).
  collapse: 'M7 4l5 5 5-5 M7 20l5-5 5 5',
  swap: 'M16 3l4 4-4 4 M20 7H8 M8 21l-4-4 4-4 M4 17h12',
  // Pane/view switcher — each glyph IS the layout it selects:
  // editor = one text pane; both = text pane + side slide strip; strip = stacked slides; grid = cells.
  'pane-editor': 'M3 4h18v16H3z M7 9h10 M7 13h10 M7 17h6',
  'pane-both': 'M3 4h18v16H3z M15 4v16 M7 9h5 M7 13h5',
  'pane-strip': 'M5 4h14v4H5z M5 10h14v4H5z M5 16h14v4H5z',
  'pane-grid': 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  design: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  trash: 'M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M10 11v6 M14 11v6',
  sort: 'M4 7h12 M4 12h8 M4 17h4 M18 5v14 M14 15l4 4 4-4',
  strip: 'M3 5h18v14H3z M9 5v14 M15 5v14',
  command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
  undo: 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  newslide: 'M3 5h18v14H3z M12 9v6 M9 12h6',
  promote: 'M3 5v14 M11 5v14 M3 12h8 M15 10l3.5-3.5L22 10 M18.5 6.5V18',
  demote: 'M3 5v14 M11 5v14 M3 12h8 M15 14l3.5 3.5L22 14 M18.5 6v11.5',
  bullets: 'M9 6h12 M9 12h12 M9 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  numbered: 'M10 6h11 M10 12h11 M10 18h11 M4 4h1v5 M3.5 9h3 M6 20H3.5c0-1.2 2.5-2 2.5-3.3 0-.9-1.5-1.3-2.5-.4',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  // The six object inserts (T27) — minimal Lucide-style glyphs in the same 24×24 stroke language:
  // table = gridded sheet; mindmap = two branches into one node; chart = axis + bars; mermaid =
  // flowchart boxes + connector; diagram = shape trio; svg = the vector pen.
  table: 'M3 5h18v14H3z M3 12h18 M12 5v14',
  mindmap: 'M3 5h5v4H3z M3 15h5v4H3z M14 9h7v6h-7z M8 7c4 0 3 3.5 6 4.2 M8 17c4 0 3-3.5 6-4.2',
  chart: 'M3 3v18h18 M8 17v-6 M13 17V7 M18 17v-3',
  mermaid: 'M3 3h8v8H3z M13 13h8v8h-8z M7 11v4h6',
  diagram: 'M12 3l5 8H7z M4 21h7v-6H4z M17.5 20a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7',
  svg: 'M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M11 9.5a1.5 1.5 0 1 0 0-.01'
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : 1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false"
      style={{ flexShrink: 0 }}
    >
      {PATHS[name].split(' M').map((seg, i) => (
        <path key={i} d={i === 0 ? seg : 'M' + seg} />
      ))}
    </svg>
  )
}

export type MenuItem = { icon: IconName; label: string; onClick: () => void; danger?: boolean; hint?: string; separatorBefore?: boolean }

// A toolbar button that opens a polished popup menu of icon+label items.
export default function ToolbarMenu({
  icon,
  label,
  items,
  primary,
  title
}: {
  icon: IconName
  label: string
  items: MenuItem[]
  primary?: boolean
  title?: string
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className={`toolbar-btn ${primary ? 'toolbar-btn--primary' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title ?? label}
      >
        <span className="toolbar-btn-content">
          <Icon name={icon} size={15} />
          <span>{label}</span>
          <Icon name="chevron-down" size={12} />
        </span>
      </button>
      {open && (
        <>
          <div className="toolbar-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="toolbar-menu" role="menu">
            {items.map((it, i) => (
              <Fragment key={i}>
                {it.separatorBefore && <div className="toolbar-menu-separator" role="separator" />}
                <button
                  role="menuitem"
                  className={`toolbar-menu-item ${it.danger ? 'is-danger' : ''}`}
                  onClick={() => { setOpen(false); it.onClick() }}
                >
                  <Icon name={it.icon} size={15} />
                  <span>{it.label}</span>
                  {it.hint && <span className="toolbar-menu-hint">{it.hint}</span>}
                </button>
              </Fragment>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
