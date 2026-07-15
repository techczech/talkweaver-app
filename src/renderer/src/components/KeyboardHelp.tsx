import { useEffect } from 'react'
import { SHORTCUT_REGISTRY } from '../../../shared/shortcut-registry'

interface Props {
  isOpen: boolean
  onClose: () => void
}

interface ShortcutRow {
  keys: string[]
  action: string
}

interface Section {
  heading: string
  rows: ShortcutRow[]
}

// Group the shared declarations by scope and category, preserving first-seen order. The live
// editor keymap and this sheet now resolve the same registry ids, so labels and default keys cannot
// drift apart.
function group<T>(items: T[], cat: (t: T) => string, row: (t: T) => ShortcutRow): Section[] {
  const order: string[] = []
  const map = new Map<string, ShortcutRow[]>()
  for (const it of items) {
    const c = cat(it)
    if (!map.has(c)) {
      map.set(c, [])
      order.push(c)
    }
    map.get(c)!.push(row(it))
  }
  return order.map((h) => ({ heading: h, rows: map.get(h)! }))
}

const SECTIONS: Section[] = group(
  SHORTCUT_REGISTRY.filter((shortcut) => shortcut.scope !== 'presenter'),
  (shortcut) => `${shortcut.scope === 'app' ? 'App' : shortcut.scope[0].toUpperCase() + shortcut.scope.slice(1)} · ${shortcut.group}`,
  (shortcut) => ({ keys: [shortcut.keys], action: shortcut.label })
)

function Kbd({ children }: { children: string }) {
  return (
    <kbd style={kbdStyle}>{children}</kbd>
  )
}

function ShortcutKeys({ keys }: { keys: string[] }) {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  )
}

export default function KeyboardHelp({ isOpen, onClose }: Props) {
  useEffect(() => {
    if (!isOpen) return

    // Close on Escape (and on a second Ctrl-/ — handled by the global toggle). NOT on "?",
    // because this popup can be opened WHILE typing in the editor, where "?" is a real character.
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          background: 'rgba(23, 32, 42, 0.35)'
        }}
      />

      {/* Help panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 1001,
          width: 620,
          maxWidth: '92vw',
          maxHeight: '84vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 12px 40px #17202a2e, 0 2px 10px #17202a18',
          fontFamily: 'var(--font-ui)',
          overflow: 'hidden'
        }}
      >
        {/* Title bar */}
        <div
          style={{
            padding: '12px 14px 10px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>
            Keyboard Shortcuts
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 18,
              color: 'var(--muted)',
              lineHeight: 1,
              padding: '2px 6px',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            ×
          </button>
        </div>

        {/* Sections */}
        <div style={{ padding: '8px 0 12px', flex: 1, overflowY: 'auto' }}>
          {SECTIONS.map((section) => (
            <div key={section.heading} style={{ marginBottom: 4 }}>
              {/* Section heading */}
              <div
                style={{
                  padding: '8px 14px 4px',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--faint)'
                }}
              >
                {section.heading}
              </div>

              {/* Rows: 2-column layout */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '0 0',
                  padding: '0 14px'
                }}
              >
                {section.rows.map((row, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '5px 0',
                      borderBottom: '1px solid var(--line)'
                    }}
                  >
                    <div style={{ minWidth: 120, flexShrink: 0 }}>
                      <ShortcutKeys keys={row.keys} />
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--ink)',
                        lineHeight: 1.3
                      }}
                    >
                      {row.action}
                    </div>
                  </div>
                ))}
                {/* If odd number of rows, fill last cell */}
                {section.rows.length % 2 !== 0 && (
                  <div
                    style={{
                      borderBottom: '1px solid var(--line)',
                      padding: '5px 0'
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '6px 14px',
            borderTop: '1px solid var(--line)',
            fontSize: 11,
            color: 'var(--faint)',
            textAlign: 'center',
            flexShrink: 0
          }}
        >
          <kbd style={kbdStyle}>⌃</kbd><kbd style={kbdStyle}>/</kbd> to open anywhere · <kbd style={kbdStyle}>Esc</kbd> to close
        </div>
      </div>
    </>
  )
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
