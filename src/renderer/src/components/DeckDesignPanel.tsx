// The talk-wide design settings and the identity fields, as the Talk tab of the right sidebar draws them (house rule R11: they
// were a modal, "Talk design"; the modal is gone and the command ids open the tab). Details = TALK_DETAILS_KEYS, Design = the rest.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Save, Lock, Wand2 } from 'lucide-react'
import { METADATA_REGISTRY } from '../../../shared/metadata-registry'
import {
  applyMetadataDefaults,
  deckSettingsViewModel,
  type MetadataDefaults,
  type SurfaceFieldModel,
  type SurfaceOptionModel
} from '../../../shared/metadata-surfaces'
import { ensureMetadataDefaults } from '../lib/metadata-defaults'
import { discardedNotice, keepDraft, restoreDraft, setStoredNotice, storedNotice } from '../lib/talkDrafts'
import { plainTalkTitle } from '../../../shared/plain-title'
import { parseFrontmatterPairs, type FrontmatterEdit } from '../../../shared/frontmatter-editor'

interface Props {
  isOpen: boolean
  outlineContent: string
  activeTalk: { title: string; outlinePath: string } | null
  /** The frontmatter edits to make. The host applies them to the talk's text as it stands (the
   *  editor buffer, one-writer spec D1) — never a whole outline worked out from `outlineContent`,
   *  which can be older than the buffer. */
  onSave: (edits: FrontmatterEdit[]) => void
}

/** The keys the Talk tab lists under Details (what the talk is called and who gave it where); every other field is Design. */
export const TALK_DETAILS_KEYS: readonly string[] = ['title', 'subtitle', 'event', 'author', 'hide_email', 'date', 'series', 'affiliation', 'web']

/** Everything searchable about a field: its own words AND every choice's words. */
function haystack(groupLabel: string, field: SurfaceFieldModel): string {
  const choices = (field.options ?? []).map((option) => `${option.label} ${option.value} ${option.explanation}`).join(' ')
  return `${groupLabel} ${field.key} ${field.aliases.join(' ')} ${field.label} ${field.explanation} ${choices}`.toLowerCase()
}

export default function DeckDesignPanel({ isOpen, outlineContent, activeTalk, onSave }: Props) {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [baseline, setBaseline] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [notice, setNotice] = useState('')
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

  // The dialog could not change under its own draft; the sidebar can (the editor is live beside it). So when the text
  // changes while the panel is up, a field still at what was last read takes the new text and a field being edited keeps
  // its draft. A different talk, or the panel coming up, starts clean.
  const presenceRef = useRef<Record<string, boolean>>({})
  const baselineRef = useRef(baseline)
  baselineRef.current = baseline
  const shownForRef = useRef<string | null>(null)
  const talkPath = activeTalk?.outlinePath ?? null
  useEffect(() => {
    if (!isOpen) { shownForRef.current = null; return }
    // A talk's text has not arrived yet (the editor starts a newly opened talk empty): nothing to compare a kept draft with.
    if (outlineContent === '') return
    const next: Record<string, string> = {}
    const present: Record<string, boolean> = {}
    for (const field of editableFields) { next[field.key] = field.value; present[field.key] = field.present }
    presenceRef.current = present
    if (shownForRef.current !== talkPath) {
      shownForRef.current = talkPath
      const restored = talkPath ? restoreDraft('design', talkPath, next, present) : { draft: next, discarded: [] }
      setDraft(restored.draft)
      const fresh = discardedNotice(restored.discarded.map((key) => editableFields.find((field) => field.key === key)?.label ?? key))
      if (talkPath && fresh) setStoredNotice('design', talkPath, fresh)
      setNotice(fresh || (talkPath ? storedNotice('design', talkPath) : ''))
      setQuery('')
      setSaved(false)
      void ensureMetadataDefaults().then(setAppDefaults).catch(() => {})
    } else {
      const was = baselineRef.current
      setDraft((current) => {
        const merged: Record<string, string> = {}
        for (const key of Object.keys(next)) merged[key] = key in current && current[key] !== was[key] ? current[key] : next[key]
        return merged
      })
    }
    setBaseline(next)
  }, [isOpen, editableFields, talkPath, outlineContent])

  // Kept per talk while the tab is away (lib/talkDrafts.ts); not before the first read has set the baseline.
  useEffect(() => {
    if (isOpen && talkPath && Object.keys(baseline).length > 0) keepDraft('design', talkPath, draft, baseline, presenceRef.current)
  }, [isOpen, talkPath, draft, baseline])

  function dismissNotice() {
    setNotice('')
    if (talkPath) setStoredNotice('design', talkPath, '')
  }

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
    const edits: FrontmatterEdit[] = editableFields
      .filter((field) => draft[field.key] !== baseline[field.key])
      .map((field) => ({
        key: field.key,
        aliases: field.aliases,
        value: draft[field.key] === '' ? null : draft[field.key],
        raw: field.control === 'map'
      }))
    onSave(edits)
    dismissNotice()
    setBaseline({ ...draft })
    setSaved(true)
  }

  if (!isOpen || !activeTalk) return null

  const detailsKeys = new Set(TALK_DETAILS_KEYS)
  const groupBlock = (group: (typeof visibleGroups)[number], fields: SurfaceFieldModel[]) => fields.length === 0 ? null : (
    <section key={group.key} style={S.group}>
      <h3 style={S.groupTitle}>{group.label}</h3>
      {fields.map((field) => (
        <FieldRow
          key={field.key}
          field={field}
          value={field.readOnly ? field.value : (draft[field.key] ?? field.value)}
          appDefault={appDefaults[field.key] ?? ''}
          showKey={false}
          onChange={(value) => setValue(field.key, value)}
        />
      ))}
    </section>
  )
  const unknownBlock = model.unknown.length > 0 && (!query || 'other unknown frontmatter'.includes(query.toLowerCase())) ? (
    <section style={{ ...S.group, opacity: 0.72 }}>
      <h3 style={S.groupTitle}>Other</h3>
      <p style={S.otherNote}>Settings you wrote by hand that TalkWeaver does not know are shown read-only and kept as they are.</p>
      {model.unknown.map((pair) => (
        <div key={pair.key} style={S.otherRowNarrow}>
          <code style={S.code}>{pair.key}</code>
          <pre style={S.otherValue}>{pair.value || '(structured value)'}</pre>
        </div>
      ))}
    </section>
  ) : null
  const fillButton = (
    <button
      type="button"
      onClick={fillMissingFromDefaults}
      disabled={fillableCount === 0}
      style={{ ...S.button, ...S.secondary, ...(fillableCount === 0 ? S.disabled : {}) }}
      title="Fill every empty identity and house-style field from your defaults in Settings. Nothing you have written is changed."
    >
      <Wand2 size={13} /> Fill missing from defaults{fillableCount > 0 ? ` (${fillableCount})` : ''}
    </button>
  )
  const searchBox = (
    <div style={{ ...S.searchWrap, margin: '0 0 6px' }}>
      <Search size={15} aria-hidden="true" />
      <input
        ref={searchRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search talk design options…"
        aria-label="Search talk design options"
        style={S.search}
      />
      {query && <button type="button" onClick={() => setQuery('')} style={S.clear}>Clear</button>}
    </div>
  )
  const saveFooter = (
    <footer style={{ ...S.footer, ...S.footerEmbedded }} data-deck-design-footer>
      <span style={S.status}>{saved ? 'Saved' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      <button type="button" onClick={handleSave} disabled={!dirty} style={{ ...S.button, ...S.primary, ...(!dirty ? S.disabled : {}) }} data-deck-design-save>
        <Save size={14} /> Save
      </button>
    </footer>
  )

  {
    const detailGroups = visibleGroups.map((group) => ({ group, fields: group.readOnly ? [] : group.fields.filter((field) => detailsKeys.has(field.key)) }))
    // The keys TalkWeaver manages (a read-only group) are listed under Advanced, with what removing each one costs.
    const designGroups = visibleGroups.map((group) => ({ group, fields: group.readOnly ? [] : group.fields.filter((field) => !detailsKeys.has(field.key)) }))
    const hasDetails = detailGroups.some((entry) => entry.fields.length > 0)
    const hasDesign = designGroups.some((entry) => entry.fields.length > 0)
    return (
      <div style={S.embeddedRoot} data-talk-design-embedded>
        <div style={S.embeddedTools}>{searchBox}<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{fillableCount > 0 && fillButton}</div></div>
        <div style={S.embeddedBody}>
          {notice && (
            <div role="status" style={S.notice} data-draft-notice="true">
              {notice} <button type="button" style={S.noticeDismiss} onClick={dismissNotice}>Dismiss</button>
            </div>
          )}
          {hasDetails && (
            <div data-talk-section="details">
              <h2 style={S.sectionTitle}>Details</h2>
              {detailGroups.map(({ group, fields }) => groupBlock(group, fields))}
            </div>
          )}
          {hasDesign && (
            <div data-talk-section="design">
              <h2 style={S.sectionTitle}>Design</h2>
              {designGroups.map(({ group, fields }) => groupBlock(group, fields))}
            </div>
          )}
          {visibleGroups.length === 0 && <div style={S.empty}>No talk design options match “{query}”.</div>}
          {unknownBlock}
        </div>
        {saveFooter}
      </div>
    )
  }
}

function FieldRow({ field, value, appDefault, showKey, onChange }: { field: SurfaceFieldModel; value: string; appDefault: string; showKey: boolean; onChange: (value: string) => void }) {
  const id = `deck-${field.key}`
  const canUseDefault = !field.readOnly && appDefault !== '' && value.trim() !== appDefault
  return (
    <div style={S.field}>
      <div style={S.fieldHeader}>
        <label htmlFor={id} style={S.label}>{field.label}</label>
        {showKey && <code style={S.key}>{field.key}</code>}
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
                    style={{ ...S.input, ...S.inputEmbedded }}
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
            <select id={id} value={value} onChange={(event) => onChange(event.target.value)} style={{ ...S.input, ...S.inputEmbedded }}>
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
            <div key={option.value || '(default)'} style={S.choiceRowNarrow}>
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
  title: { fontSize: 17, fontWeight: 700 }, subtitle: { marginTop: 3, color: 'var(--ink-faint, #746b60)', fontSize: 12 },
  iconButton: { display: 'grid', placeItems: 'center', width: 32, height: 32, border: '1px solid var(--line, #c8b89a)', borderRadius: 5, background: 'transparent', color: 'inherit', cursor: 'pointer' },
  searchWrap: { margin: '12px 18px 4px', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', border: '1px solid var(--line, #c8b89a)', background: 'var(--paper-light, #fffdf8)', borderRadius: 5 },
  search: { flex: 1, border: 0, outline: 0, background: 'transparent', fontSize: 14, color: 'inherit' }, clear: { border: 0, background: 'transparent', color: 'var(--oxford, #0b3a6b)', cursor: 'pointer' },
  group: { marginTop: 16 }, groupTitle: { margin: 0, paddingBottom: 6, borderBottom: '1px solid var(--line, #c8b89a)', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ink-faint, #746b60)' },
  field: { padding: '12px 0', borderBottom: '1px solid color-mix(in srgb, var(--line, #c8b89a) 55%, transparent)' }, fieldHeader: { display: 'flex', alignItems: 'baseline', gap: 8 }, label: { fontSize: 14, fontWeight: 650 }, key: { fontSize: 10, color: 'var(--ink-faint, #746b60)' }, description: { maxWidth: 680, margin: '4px 0 9px', color: 'var(--ink-faint, #746b60)', fontSize: 12, lineHeight: 1.45 },
  notice: { margin: '10px 0 0', padding: '7px 9px', border: '1px solid #b45309', borderRadius: 4, background: 'rgba(180,83,9,.08)', fontSize: 12, lineHeight: 1.45 },
  noticeDismiss: { marginLeft: 6, border: 0, background: 'transparent', color: 'var(--oxford, #0b3a6b)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' },
  embeddedRoot: { display: 'flex', flexDirection: 'column', minHeight: 0, color: 'var(--ink, #1a1410)' },
  embeddedTools: { padding: '10px 12px 4px' },
  embeddedBody: { padding: '0 12px 8px' },
  sectionTitle: { margin: '14px 0 0', fontSize: 13, fontWeight: 700, letterSpacing: '.02em', color: 'var(--ink, #1a1410)' },
  inputEmbedded: { minWidth: 0, width: '100%', boxSizing: 'border-box' },
  footerEmbedded: { position: 'sticky', bottom: 0, background: 'var(--panel, #f5f0e8)', padding: '8px 12px' },
  choiceRowNarrow: { display: 'grid', gridTemplateColumns: '1fr', gap: 2, padding: '3px 0' },
  otherRowNarrow: { display: 'grid', gridTemplateColumns: '1fr', gap: 2, padding: '8px 0', borderBottom: '1px solid var(--line, #c8b89a)' },
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
