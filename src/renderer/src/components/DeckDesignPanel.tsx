import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Save, X, Lock, Wand2 } from 'lucide-react'
import { METADATA_REGISTRY } from '../../../shared/metadata-registry'
import {
  applyMetadataDefaults,
  deckSettingsViewModel,
  type MetadataDefaults,
  type SurfaceFieldModel,
  type SurfaceOptionModel
} from '../../../shared/metadata-surfaces'
import { ensureMetadataDefaults } from '../lib/metadata-defaults'
import { editFrontmatterText, parseFrontmatterPairs } from '../../../shared/frontmatter-editor'

interface Props {
  isOpen: boolean
  outlineContent: string
  activeTalk: { title: string; outlinePath: string } | null
  onClose: () => void
  onSave: (newOutline: string) => void
}

/** Everything searchable about a field: its own words AND every choice's words. */
function haystack(groupLabel: string, field: SurfaceFieldModel): string {
  const choices = (field.options ?? []).map((option) => `${option.label} ${option.value} ${option.explanation}`).join(' ')
  return `${groupLabel} ${field.key} ${field.aliases.join(' ')} ${field.label} ${field.explanation} ${choices}`.toLowerCase()
}

export default function DeckDesignPanel({ isOpen, outlineContent, activeTalk, onClose, onSave }: Props) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [baseline, setBaseline] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  // Settings → Presenter identity and deck defaults. Shown as placeholder text and offered
  // through "Use default"; NOTHING here is written without a click.
  const [appDefaults, setAppDefaults] = useState<MetadataDefaults>({})
  const searchRef = useRef<HTMLInputElement>(null)

  const pairs = useMemo(() => parseFrontmatterPairs(outlineContent), [outlineContent])
  const model = useMemo(() => deckSettingsViewModel(METADATA_REGISTRY, pairs), [pairs])
  const editableFields = useMemo(
    () => model.groups.flatMap((group) => group.fields).filter((field) => !field.readOnly),
    [model]
  )
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return model.groups
    return model.groups
      .map((group) => ({ ...group, fields: group.fields.filter((field) => haystack(group.label, field).includes(needle)) }))
      .filter((group) => group.fields.length > 0)
  }, [model, query])
  const dirty = Object.keys(draft).some((key) => draft[key] !== baseline[key])

  useEffect(() => {
    if (!isOpen) return
    const next: Record<string, string> = {}
    for (const field of editableFields) next[field.key] = field.value
    setDraft(next)
    setBaseline(next)
    setQuery('')
    setSaved(false)
    void ensureMetadataDefaults().then(setAppDefaults).catch(() => {})
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [isOpen, editableFields])

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

  /** Fill every still-empty defaultable field from Settings. Authored values are never touched. */
  function fillMissingFromDefaults() {
    const current = editableFields.map((field) => ({ key: field.key, value: draft[field.key] ?? field.value }))
    const { edits } = applyMetadataDefaults(current, appDefaults, { mode: 'fill-missing', registry: METADATA_REGISTRY })
    if (edits.length === 0) return
    setDraft((existing) => {
      const next = { ...existing }
      for (const edit of edits) next[edit.key] = edit.value
      return next
    })
    setSaved(false)
  }

  const fillableCount = (() => {
    const current = editableFields.map((field) => ({ key: field.key, value: draft[field.key] ?? field.value }))
    return applyMetadataDefaults(current, appDefaults, { mode: 'fill-missing', registry: METADATA_REGISTRY }).edits.length
  })()

  function handleSave() {
    if (!dirty) return
    const edits = editableFields
      .filter((field) => draft[field.key] !== baseline[field.key])
      .map((field) => ({
        key: field.key,
        aliases: field.aliases,
        value: draft[field.key] === '' ? null : draft[field.key],
        raw: field.control === 'map'
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
            <div style={S.subtitle}>{activeTalk.title} · {model.fieldCount} registered settings</div>
          </div>
          <div style={S.headerActions}>
            <button
              type="button"
              onClick={fillMissingFromDefaults}
              disabled={fillableCount === 0}
              style={{ ...S.button, ...S.secondary, ...(fillableCount === 0 ? S.disabled : {}) }}
              title="Fill every empty identity and house-style field from Settings → Presenter identity and deck defaults. Nothing you have written is changed."
            >
              <Wand2 size={13} /> Fill missing from defaults{fillableCount > 0 ? ` (${fillableCount})` : ''}
            </button>
            <button type="button" onClick={onClose} style={S.iconButton} aria-label="Close deck settings" title="Close (Esc)">
              <X size={17} />
            </button>
          </div>
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
              {group.fields.map((field) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  value={field.readOnly ? field.value : (draft[field.key] ?? field.value)}
                  appDefault={appDefaults[field.key] ?? ''}
                  onChange={(value) => setValue(field.key, value)}
                />
              ))}
            </section>
          ))}
          {visibleGroups.length === 0 && <div style={S.empty}>No registered deck options match “{query}”.</div>}

          {model.unknown.length > 0 && (!query || 'other unknown frontmatter'.includes(query.toLowerCase())) && (
            <section style={{ ...S.group, opacity: 0.72 }}>
              <h2 style={S.groupTitle}>Other</h2>
              <p style={S.otherNote}>Hand-authored keys not in the deck register are shown read-only and will be preserved.</p>
              {model.unknown.map((pair) => (
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

function FieldRow({ field, value, appDefault, onChange }: { field: SurfaceFieldModel; value: string; appDefault: string; onChange: (value: string) => void }) {
  const id = `deck-${field.key}`
  const canUseDefault = !field.readOnly && appDefault !== '' && value.trim() !== appDefault
  return (
    <div style={S.field}>
      <div style={S.fieldHeader}>
        <label htmlFor={id} style={S.label}>{field.label}</label>
        <code style={S.key}>{field.key}</code>
        {field.readOnly && <span style={S.lock}><Lock size={11} aria-hidden="true" /> read-only</span>}
        {canUseDefault && (
          <button
            type="button"
            onClick={() => onChange(appDefault)}
            style={S.useDefault}
            title={`Set this to your default: ${appDefault}`}
          >
            Use default
          </button>
        )}
      </div>
      <div style={S.description}>{field.explanation}</div>
      {appDefault !== '' && field.options && (
        <div style={S.defaultNote}>Your default: {appDefault}</div>
      )}
      {field.readOnly
        ? (
            <div>
              <div style={S.readonlyValue}>{value || '(not set)'}</div>
              {field.note && <div style={S.note}>{field.note}</div>}
            </div>
          )
        : field.options
          ? <Picker id={id} field={field} value={value} onChange={onChange} />
          : field.control === 'map'
            ? <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} style={S.textarea} rows={4} spellCheck={false} />
            : (
                <div style={S.inputRow}>
                  <input
                    id={id}
                    type={field.control === 'url' ? 'url' : field.control === 'number' ? 'number' : 'text'}
                    value={value}
                    placeholder={appDefault ? `${appDefault} (your default)` : field.placeholder}
                    onChange={(event) => onChange(event.target.value)}
                    style={S.input}
                  />
                  {field.unit && <span style={S.unit}>{field.unit}</span>}
                </div>
              )}
    </div>
  )
}

/** A closed vocabulary, always as choices: segmented up to five, a select above that. */
function Picker({ id, field, value, onChange }: { id: string; field: SurfaceFieldModel; value: string; onChange: (value: string) => void }) {
  const options = field.options as SurfaceOptionModel[]
  const chosen = options.find((option) => option.value === value) ?? null
  return (
    <div>
      {field.control === 'select'
        ? (
            <select id={id} value={value} onChange={(event) => onChange(event.target.value)} style={S.input}>
              {!chosen && <option value={value}>custom: {value}</option>}
              {options.map((option) => (
                <option key={option.value || '(default)'} value={option.value} title={option.explanation}>{option.label}</option>
              ))}
            </select>
          )
        : (
            <div id={id} role="group" aria-label={field.label} style={S.segments}>
              {options.map((option) => {
                const active = option.value === value
                return (
                  <button
                    key={option.value || '(default)'}
                    type="button"
                    onClick={() => onChange(option.value)}
                    aria-pressed={active}
                    title={option.explanation}
                    style={{ ...S.segment, ...(active ? S.segmentActive : {}) }}
                  >
                    {option.swatch && <span style={{ ...S.swatch, background: option.swatch }} />}
                    {option.label}
                  </button>
                )
              })}
            </div>
          )}
      {!chosen && value !== '' && (
        <div style={S.custom}>
          This outline holds <code style={S.code}>{value}</code>, which is not one of the documented choices. Pick one above to return to them.
        </div>
      )}
      <details style={S.choices}>
        <summary style={S.choicesSummary}>What each choice does</summary>
        <dl style={S.choiceList}>
          {options.map((option) => (
            <div key={option.value || '(default)'} style={S.choiceRow}>
              <dt style={S.choiceTerm}>{option.label}</dt>
              <dd style={S.choiceBody}>{option.explanation}</dd>
            </div>
          ))}
        </dl>
      </details>
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
  headerActions: { display: 'flex', alignItems: 'center', gap: 8 },
  useDefault: { marginLeft: 'auto', padding: '2px 7px', border: '1px solid var(--line, #c8b89a)', borderRadius: 4, background: 'transparent', color: 'var(--oxford, #0b3a6b)', fontSize: 11, cursor: 'pointer' },
  defaultNote: { margin: '-4px 0 8px', fontSize: 11, color: 'var(--ink-faint, #746b60)' },
  lock: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--ink-faint, #746b60)' },
  readonlyValue: { padding: '7px 9px', border: '1px dashed var(--line, #c8b89a)', borderRadius: 4, background: 'transparent', color: 'var(--ink-faint, #746b60)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, overflowWrap: 'anywhere' },
  note: { marginTop: 5, fontSize: 11, lineHeight: 1.45, color: 'var(--ink-faint, #746b60)' },
  inputRow: { display: 'flex', alignItems: 'center', gap: 9 }, input: { minWidth: 220, maxWidth: '100%', padding: '7px 9px', border: '1px solid var(--line, #c8b89a)', borderRadius: 4, background: 'var(--paper-light, #fffdf8)', color: 'inherit' }, unit: { fontSize: 11, color: 'var(--ink-faint, #746b60)' }, textarea: { width: '100%', boxSizing: 'border-box', padding: 9, border: '1px solid var(--line, #c8b89a)', borderRadius: 4, background: 'var(--paper-light, #fffdf8)', color: 'inherit', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  segments: { display: 'flex', flexWrap: 'wrap', gap: 5 }, segment: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', border: '1px solid var(--line, #c8b89a)', borderRadius: 4, background: 'var(--paper-light, #fffdf8)', color: 'inherit', cursor: 'pointer' }, segmentActive: { color: '#fff', borderColor: 'var(--oxford, #0b3a6b)', background: 'var(--oxford, #0b3a6b)' }, swatch: { width: 11, height: 11, borderRadius: '50%', border: '1px solid rgba(0,0,0,.25)' },
  custom: { marginTop: 7, padding: '6px 8px', border: '1px solid color-mix(in srgb, var(--crimson, #8c1d1d) 40%, transparent)', borderRadius: 4, fontSize: 11.5, lineHeight: 1.45 },
  choices: { marginTop: 7 }, choicesSummary: { fontSize: 11.5, color: 'var(--oxford, #0b3a6b)', cursor: 'pointer' },
  choiceList: { margin: '6px 0 0', padding: 0 }, choiceRow: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: 10, padding: '3px 0' }, choiceTerm: { fontSize: 12, fontWeight: 650 }, choiceBody: { margin: 0, fontSize: 11.5, lineHeight: 1.45, color: 'var(--ink-faint, #746b60)' },
  otherNote: { fontSize: 12, color: 'var(--ink-faint, #746b60)' }, otherRow: { display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--line, #c8b89a)' }, code: { fontSize: 12 }, otherValue: { margin: 0, overflow: 'hidden', whiteSpace: 'pre-wrap', fontSize: 11 }, empty: { padding: 30, textAlign: 'center', color: 'var(--ink-faint, #746b60)' },
  footer: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderTop: '1px solid var(--line, #c8b89a)' }, status: { flex: 1, fontSize: 12, color: 'var(--ink-faint, #746b60)' }, button: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }, secondary: { border: '1px solid var(--line, #c8b89a)', background: 'transparent', color: 'inherit' }, primary: { border: '1px solid var(--oxford, #0b3a6b)', background: 'var(--oxford, #0b3a6b)', color: '#fff' }, disabled: { opacity: .45, cursor: 'not-allowed' }, shortcut: { opacity: .7, fontSize: 11 }
}
