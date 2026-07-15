import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Save, X } from 'lucide-react'
import {
  DECK_OPTION_GROUPS,
  DECK_OPTION_KEYS,
  type DeckOption,
  type DeckOptionValue
} from '../../../shared/layout-registry/deck-options'
import { editFrontmatterText, parseFrontmatterPairs } from '../../../shared/frontmatter-editor'

interface Props {
  isOpen: boolean
  outlineContent: string
  activeTalk: { title: string; outlinePath: string } | null
  onClose: () => void
  onSave: (newOutline: string) => void
}

function valueFor(option: DeckOption, pairs: ReturnType<typeof parseFrontmatterPairs>): string {
  const spellings = [option.key, ...(option.aliases ?? [])]
  return pairs.find((pair) => spellings.includes(pair.key))?.value ?? ''
}

export default function DeckDesignPanel({ isOpen, outlineContent, activeTalk, onClose, onSave }: Props) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [baseline, setBaseline] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const pairs = useMemo(() => parseFrontmatterPairs(outlineContent), [outlineContent])
  const unknown = useMemo(() => pairs.filter((pair) => !DECK_OPTION_KEYS.has(pair.key)), [pairs])
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return DECK_OPTION_GROUPS
    return DECK_OPTION_GROUPS
      .map((group) => ({
        ...group,
        options: group.options.filter((option) =>
          `${group.label} ${option.key} ${option.label} ${option.description}`.toLowerCase().includes(needle)
        )
      }))
      .filter((group) => group.options.length > 0)
  }, [query])
  const dirty = Object.keys(draft).some((key) => draft[key] !== baseline[key])

  useEffect(() => {
    if (!isOpen) return
    const next: Record<string, string> = {}
    for (const group of DECK_OPTION_GROUPS) {
      for (const option of group.options) next[option.key] = valueFor(option, parseFrontmatterPairs(outlineContent))
    }
    setDraft(next)
    setBaseline(next)
    setQuery('')
    setSaved(false)
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [isOpen, outlineContent])

  useEffect(() => {
    if (!isOpen) return
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select()
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && dirty) {
        event.preventDefault(); handleSave()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  function setValue(key: string, value: string) {
    setDraft((current) => ({ ...current, [key]: value }))
    setSaved(false)
  }

  function handleSave() {
    if (!dirty) return
    const edits = DECK_OPTION_GROUPS.flatMap((group) => group.options)
      .filter((option) => draft[option.key] !== baseline[option.key])
      .map((option) => ({
        key: option.key,
        aliases: option.aliases,
        value: draft[option.key] === '' ? null : draft[option.key],
        raw: option.input.type === 'map'
      }))
    const next = editFrontmatterText(outlineContent, edits)
    onSave(next)
    setBaseline({ ...draft })
    setSaved(true)
  }

  if (!isOpen || !activeTalk) return null

  return (
    <div style={S.backdrop} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div style={S.modal} role="dialog" aria-modal="true" aria-label={`Deck settings — ${activeTalk.title}`}>
        <header style={S.header}>
          <div>
            <div style={S.title}>Deck settings</div>
            <div style={S.subtitle}>{activeTalk.title} · {DECK_OPTION_GROUPS.flatMap((group) => group.options).length} registered options</div>
          </div>
          <button type="button" onClick={onClose} style={S.iconButton} aria-label="Close deck settings" title="Close (Esc)">
            <X size={17} />
          </button>
        </header>

        <div style={S.searchWrap}>
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search deck options…"
            aria-label="Search deck options"
            style={S.search}
          />
          {query && <button type="button" onClick={() => setQuery('')} style={S.clear}>Clear</button>}
        </div>

        <div style={S.body}>
          {visibleGroups.map((group) => (
            <section key={group.key} style={S.group}>
              <h2 style={S.groupTitle}>{group.label}</h2>
              {group.options.map((option) => (
                <OptionField
                  key={option.key}
                  option={option}
                  value={draft[option.key] ?? ''}
                  onChange={(value) => setValue(option.key, value)}
                />
              ))}
            </section>
          ))}
          {visibleGroups.length === 0 && <div style={S.empty}>No registered deck options match “{query}”.</div>}

          {unknown.length > 0 && (!query || 'other unknown frontmatter'.includes(query.toLowerCase())) && (
            <section style={{ ...S.group, opacity: 0.72 }}>
              <h2 style={S.groupTitle}>Other</h2>
              <p style={S.otherNote}>Hand-authored keys not in the deck register are shown read-only and will be preserved.</p>
              {unknown.map((pair) => (
                <div key={pair.key} style={S.otherRow}>
                  <code style={S.code}>{pair.key}</code>
                  <pre style={S.otherValue}>{pair.value || '(structured value)'}</pre>
                </div>
              ))}
            </section>
          )}
        </div>

        <footer style={S.footer}>
          <span style={S.status}>{saved ? 'Saved' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          <button type="button" onClick={onClose} style={{ ...S.button, ...S.secondary }}>Close</button>
          <button type="button" onClick={handleSave} disabled={!dirty} style={{ ...S.button, ...S.primary, ...(!dirty ? S.disabled : {}) }}>
            <Save size={14} /> Save <span style={S.shortcut}>⌘↵</span>
          </button>
        </footer>
      </div>
    </div>
  )
}

function OptionField({ option, value, onChange }: { option: DeckOption; value: string; onChange: (value: string) => void }) {
  return (
    <div style={S.field}>
      <div style={S.fieldHeader}>
        <label htmlFor={`deck-${option.key}`} style={S.label}>{option.label}</label>
        <code style={S.key}>{option.key}</code>
      </div>
      <div style={S.description}>{option.description}</div>
      {option.values
        ? <EnumControl id={`deck-${option.key}`} option={option} value={value} onChange={onChange} />
        : option.input.type === 'map'
          ? <textarea id={`deck-${option.key}`} value={value} onChange={(event) => onChange(event.target.value)} style={S.textarea} rows={4} spellCheck={false} />
          : (
              <div style={S.inputRow}>
                <input
                  id={`deck-${option.key}`}
                  type={option.input.type === 'url' ? 'url' : option.input.type === 'number' ? 'number' : 'text'}
                  value={value}
                  placeholder={option.input.placeholder}
                  onChange={(event) => onChange(event.target.value)}
                  style={S.input}
                />
                {option.input.unit && <span style={S.unit}>{option.input.unit}</span>}
              </div>
            )}
    </div>
  )
}

function EnumControl({ id, option, value, onChange }: { id: string; option: DeckOption; value: string; onChange: (value: string) => void }) {
  const values = option.values as DeckOptionValue[]
  if (values.length > 5) {
    return (
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} style={S.input}>
        {!values.some((entry) => entry.value === value) && <option value={value}>Current: {value}</option>}
        {values.map((entry) => <option key={entry.value || '(default)'} value={entry.value}>{entry.label}</option>)}
      </select>
    )
  }
  return (
    <div id={id} role="group" aria-label={option.label} style={S.segments}>
      {values.map((entry) => {
        const active = entry.value === value
        return (
          <button
            key={entry.value || '(default)'}
            type="button"
            onClick={() => onChange(entry.value)}
            aria-pressed={active}
            title={entry.description}
            style={{ ...S.segment, ...(active ? S.segmentActive : {}) }}
          >
            {entry.swatch && <span style={{ ...S.swatch, background: entry.swatch }} />}
            {entry.label}
          </button>
        )
      })}
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(12,18,26,.48)', display: 'grid', placeItems: 'center' },
  modal: { width: 760, maxWidth: '94vw', height: '82vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--panel, #f5f0e8)', border: '1px solid var(--line, #c8b89a)', borderRadius: 8, boxShadow: '0 18px 54px rgba(0,0,0,.3)', color: 'var(--ink, #1a1410)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--line, #c8b89a)' },
  title: { fontSize: 17, fontWeight: 700 }, subtitle: { marginTop: 3, color: 'var(--ink-faint, #746b60)', fontSize: 12 },
  iconButton: { display: 'grid', placeItems: 'center', width: 32, height: 32, border: '1px solid var(--line, #c8b89a)', borderRadius: 5, background: 'transparent', color: 'inherit', cursor: 'pointer' },
  searchWrap: { margin: '12px 18px 4px', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', border: '1px solid var(--line, #c8b89a)', background: 'var(--paper-light, #fffdf8)', borderRadius: 5 },
  search: { flex: 1, border: 0, outline: 0, background: 'transparent', fontSize: 14, color: 'inherit' }, clear: { border: 0, background: 'transparent', color: 'var(--oxford, #0b3a6b)', cursor: 'pointer' },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 18px 24px' },
  group: { marginTop: 16 }, groupTitle: { margin: 0, paddingBottom: 6, borderBottom: '1px solid var(--line, #c8b89a)', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ink-faint, #746b60)' },
  field: { padding: '12px 0', borderBottom: '1px solid color-mix(in srgb, var(--line, #c8b89a) 55%, transparent)' }, fieldHeader: { display: 'flex', alignItems: 'baseline', gap: 8 }, label: { fontSize: 14, fontWeight: 650 }, key: { fontSize: 10, color: 'var(--ink-faint, #746b60)' }, description: { maxWidth: 680, margin: '4px 0 9px', color: 'var(--ink-faint, #746b60)', fontSize: 12, lineHeight: 1.45 },
  inputRow: { display: 'flex', alignItems: 'center', gap: 9 }, input: { minWidth: 220, maxWidth: '100%', padding: '7px 9px', border: '1px solid var(--line, #c8b89a)', borderRadius: 4, background: 'var(--paper-light, #fffdf8)', color: 'inherit' }, unit: { fontSize: 11, color: 'var(--ink-faint, #746b60)' }, textarea: { width: '100%', boxSizing: 'border-box', padding: 9, border: '1px solid var(--line, #c8b89a)', borderRadius: 4, background: 'var(--paper-light, #fffdf8)', color: 'inherit', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  segments: { display: 'flex', flexWrap: 'wrap', gap: 5 }, segment: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', border: '1px solid var(--line, #c8b89a)', borderRadius: 4, background: 'var(--paper-light, #fffdf8)', color: 'inherit', cursor: 'pointer' }, segmentActive: { color: '#fff', borderColor: 'var(--oxford, #0b3a6b)', background: 'var(--oxford, #0b3a6b)' }, swatch: { width: 11, height: 11, borderRadius: '50%', border: '1px solid rgba(0,0,0,.25)' },
  otherNote: { fontSize: 12, color: 'var(--ink-faint, #746b60)' }, otherRow: { display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--line, #c8b89a)' }, code: { fontSize: 12 }, otherValue: { margin: 0, overflow: 'hidden', whiteSpace: 'pre-wrap', fontSize: 11 }, empty: { padding: 30, textAlign: 'center', color: 'var(--ink-faint, #746b60)' },
  footer: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderTop: '1px solid var(--line, #c8b89a)' }, status: { flex: 1, fontSize: 12, color: 'var(--ink-faint, #746b60)' }, button: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }, secondary: { border: '1px solid var(--line, #c8b89a)', background: 'transparent', color: 'inherit' }, primary: { border: '1px solid var(--oxford, #0b3a6b)', background: 'var(--oxford, #0b3a6b)', color: '#fff' }, disabled: { opacity: .45, cursor: 'not-allowed' }, shortcut: { opacity: .7, fontSize: 11 }
}
