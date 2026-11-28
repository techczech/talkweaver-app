// Per-talk Metadata panel (ADR-0036) — the registry, rendered. Every field comes from
// src/shared/metadata-registry.ts: label + user-facing explanation + documented options
// (closed) or vault-wide autocomplete (open). No raw YAML anywhere. System keys sit behind a
// locked reveal; deleting one names its consequence first. An amber doctor row surfaces
// unregistered keys found in THIS outline (remove them, or keep-and-ignore).
//
// Design lock: docs/design/2026-07-11-v015-tags-metadata/direction-a-rail.html (stage 2).
import { useState, useEffect, useMemo, useRef } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Lock, Unlock, Plus } from 'lucide-react'
import type { TalkInfo, MetadataVocabulary } from '../../../preload/index'
import {
  METADATA_REGISTRY,
  activeUserFrontmatterEntries,
  systemFrontmatterEntries,
  findEntry,
  type MetadataEntry
} from '../../../shared/metadata-registry'
import { notify } from '../lib/notify'
import { parseFrontmatterPairs, type FrontmatterEdit } from '../../../shared/frontmatter-editor'
import type { TalkMetadata } from './useTalkMetadata'

interface Props {
  talk: TalkInfo
  outlineContent: string
  metadata: TalkMetadata
  onEdit: (edits: FrontmatterEdit[]) => boolean
}

/** The value an entry currently holds in the outline, under any accepted spelling. */
function valueFor(entry: MetadataEntry, pairs: Array<{ key: string; value: string }>): string {
  const spellings = [entry.key, ...(entry.aliases ?? [])]
  const hit = spellings.map(key => pairs.find(p => p.key === key)).find(Boolean)
  return hit ? hit.value : ''
}

type DoctorRowState = 'open' | 'removed' | 'kept'

export default function MetadataPanel({ talk, outlineContent, metadata, onEdit }: Props) {
  const [vocab, setVocab] = useState<MetadataVocabulary>({})
  const [doctorRows, setDoctorRows] = useState<Array<{ key: string; value: string; state: DoctorRowState }>>([])
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [sysOpen, setSysOpen] = useState(false)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The Advanced part of the Talk tab (house rule R11): the design fields (Talk design) are already above it, so only the keys
  // outside the deck are here, with the notice about keys TalkWeaver does not know and the managed (System) keys.
  const userEntries = useMemo(() => activeUserFrontmatterEntries().filter((e) => e.outsideDeck), [])
  const systemEntries = useMemo(() => systemFrontmatterEntries(), [])
  const groups = useMemo(() => {
    const order: string[] = []
    const byGroup = new Map<string, MetadataEntry[]>()
    for (const e of userEntries) {
      const g = e.group ?? 'Other'
      if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g) }
      byGroup.get(g)!.push(e)
    }
    return order.map((g) => ({ name: g, entries: byGroup.get(g)! }))
  }, [userEntries])

  const pairs = useMemo(() => parseFrontmatterPairs(outlineContent), [outlineContent])
  const idStampCount = (outlineContent.match(/\{id=/g) ?? []).length
  const path = talk.outlinePath
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [doctor, vocabulary] = await Promise.all([window.tw.metadata.doctor(), window.tw.metadata.vocabulary()])
        if (cancelled) return
        setVocab(vocabulary ?? {})
        const mine = doctor?.find(row => row.outlinePath === path)
        setDoctorRows((mine?.unregistered ?? []).map(key => ({ ...key, state: 'open' })))
      } catch {
        if (!cancelled) setError('Couldn’t load vault-wide metadata. You can still edit this talk’s fields.')
      }
    })()
    return () => { cancelled = true }
  }, [path])

  function handleDoctorRemove(key: string) {
    if (!onEdit([{ key, value: null }])) return
    setDoctorRows(rows => rows.map(row => row.key === key ? { ...row, state: 'removed' } : row))
  }

  async function handleDoctorKeep(key: string) {
    const res = await window.tw.metadata.ignoreKey(talk.outlinePath, key)
    if (!res?.ok) { notify(`Couldn’t record “${key}” in the ignore list.`, 'error'); return }
    setDoctorRows((rows) => rows.map((r) => (r.key === key ? { ...r, state: 'kept' } : r)))
  }

  function handleSystemDelete(key: string) {
    const entry = findEntry(key)
    if (!onEdit([{ key, value: null, aliases: entry?.aliases }])) return
    setConfirmKey(null)
    notify(`${key} removed from the frontmatter.`, 'success')
  }

  const openDoctorRows = doctorRows.filter((r) => r.state === 'open')
  const presentSystem = systemEntries.filter((e) => valueFor(e, pairs) !== '')

  return (
    <div style={S.embeddedRoot} data-metadata-embedded>
      <div style={S.bodyEmbedded}>
        {error && <div style={S.errorBox}>{error}</div>}
          {/* Doctor status is ALWAYS visible — a clean bill of health is a designed state
              (Gate-5), not an absence. Green check + "Everything declared" when there is
              nothing to report; amber review row when unregistered keys were found. */}
          {doctorRows.length === 0 && (
            <div style={{ ...S.doctor, ...S.doctorClean }}>
              <div style={S.doctorRow}>
                <CheckCircle2 size={15} style={{ color: GREEN, flexShrink: 0 }} />
                <span style={S.doctorText}>
                  <b style={{ color: GREEN }}>All recognised ✓</b> — every setting in this
                  talk is one TalkWeaver knows.
                </span>
              </div>
            </div>
          )}
          {doctorRows.length > 0 && (
            <div style={S.doctor}>
              <div style={S.doctorRow}>
                <AlertTriangle size={15} style={{ color: AMBER, flexShrink: 0 }} />
                <span style={S.doctorText}>
                  {openDoctorRows.length > 0 ? (
                    <>
                      <b style={{ color: AMBER }}>
                        {openDoctorRows.length} unrecognised setting{openDoctorRows.length === 1 ? '' : 's'}
                      </b>{' '}
                      found in this talk. TalkWeaver cannot explain or edit {openDoctorRows.length === 1 ? 'it' : 'them'}.
                    </>
                  ) : (
                    <b style={{ color: GREEN }}>All clear — every setting in this talk is recognised or kept on purpose.</b>
                  )}
                </span>
                <button type="button" style={S.doctorBtn} onClick={() => setDoctorOpen((o) => !o)}>
                  {doctorOpen ? 'Hide' : 'Review'}
                </button>
              </div>
              {doctorOpen && (
                <div style={S.doctorKeys}>
                  {doctorRows.map((r) => (
                    <div key={r.key} style={{ ...S.dkey, ...(r.state !== 'open' ? S.dkeyGone : {}) }}>
                      <span style={{ ...S.dkeyName, ...(r.state !== 'open' ? { textDecoration: 'line-through' } : {}) }}>
                        {r.key}
                      </span>
                      <span style={S.dkeyWhere}>
                        frontmatter{r.value ? <> · value <code style={S.code}>{r.value}</code></> : null}
                      </span>
                      {r.state === 'open' ? (
                        <>
                          <button
                            type="button"
                            style={S.dkeyBtn}
                            title="Leave the key in the outline and stop flagging it here. Registering it properly is a development act — it needs an explanation and a vocabulary in the registry."
                            onClick={() => void handleDoctorKeep(r.key)}
                          >
                            Keep (ignore)
                          </button>
                          <button
                            type="button"
                            style={{ ...S.dkeyBtn, color: CRIMSON, borderColor: CRIMSON }}
                            title="Delete this key’s line from the outline’s frontmatter"
                            onClick={() => handleDoctorRemove(r.key)}
                          >
                            Remove from outline
                          </button>
                        </>
                      ) : (
                        <span style={{ color: r.state === 'removed' ? GREEN : MUTED, fontSize: '0.78rem' }}>
                          {r.state === 'removed' ? 'removed ✓' : 'kept ✓'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* No frontmatter yet — say so and point at the way forward (designed empty state),
              instead of presenting a wall of blank fields with no explanation. */}
          {pairs.length === 0 && (
            <div style={S.noFm}>
              TalkWeaver will create frontmatter when you edit a field.
            </div>
          )}
          {groups.map((group) => (
            <div key={group.name}>
              <div style={S.groupHead}>{group.name}</div>
              {group.entries.map(entry => {
                const present = pairs.some(pair => [entry.key, ...(entry.aliases ?? [])].includes(pair.key))
                const field = { ...entry, value: valueFor(entry, pairs), present }
                return <Field
                  key={entry.key}
                  entry={entry}
                  value={metadata.value(field)}
                  onType={value => metadata.type(field, value)}
                  onChoose={value => metadata.choose(field, value)}
                  onCommit={retry => { metadata.commitText(entry.key, retry ? field : undefined) }}
                  vocabValues={vocab[entry.key] ?? []}
                  mapPresent={present}
                />
              })}
            </div>
          ))}

          <div style={S.sys}>
            <button type="button" style={S.sysHead} onClick={() => setSysOpen((o) => !o)} aria-expanded={sysOpen}>
              {sysOpen ? <Unlock size={14} style={{ color: FAINT }} /> : <Lock size={14} style={{ color: FAINT }} />}
              <span style={S.sysTitle}>
                Kept by TalkWeaver
              </span>
              <span style={S.sysReveal}>
                {sysOpen ? 'Hide details' : 'Details'}
                {sysOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </span>
            </button>
            {sysOpen && (
              <div style={S.sysBody}>
                <div style={S.sysExp}>
                  {presentSystem.length} setting{presentSystem.length === 1 ? '' : 's'} and {idStampCount} slide marker{idStampCount === 1 ? '' : 's'} in this talk.{' '}
                  TalkWeaver manages these. They keep identity, provenance and migrations working — edit
                  the fields above instead. Deleting one always names its consequence first.
                </div>
                <div style={S.srow}>
                  <span style={S.srowKey}>{'{id=…}'} stamps</span>
                  <span style={S.srowVal}>{idStampCount} slide{idStampCount === 1 ? '' : 's'}</span>
                  <span style={S.srowWhy}>{findEntry('id')?.explanation}</span>
                </div>
                {presentSystem.map((entry) => (
                  <div key={entry.key}>
                    <div style={S.srow}>
                      <span style={S.srowKey}>{entry.key}</span>
                      <span style={S.srowVal}>{valueFor(entry, pairs)}</span>
                      <span style={S.srowWhy}>{entry.explanation}</span>
                      <button type="button" style={S.srowDel} onClick={() => setConfirmKey(entry.key)}>
                        Delete…
                      </button>
                    </div>
                    {confirmKey === entry.key && (
                      <div style={S.sysConfirm}>
                        Deleting <b style={{ color: CRIMSON }}>{entry.key}</b> — {entry.deleteConsequence}
                        <div style={S.confirmActs}>
                          <button
                            type="button"
                            style={{ ...S.confirmBtn, color: CRIMSON, borderColor: CRIMSON }}
                            onClick={() => handleSystemDelete(entry.key)}
                          >
                            Delete anyway
                          </button>
                          <button type="button" style={S.confirmBtn} onClick={() => setConfirmKey(null)}>
                            Keep it
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {presentSystem.length === 0 && (
                  <div style={{ ...S.sysExp, paddingTop: 6 }}>
                    No system frontmatter keys in this outline yet — publishing and migrations stamp them.
                  </div>
                )}
              </div>
            )}
          </div>
      </div>
    </div>
  )
}

// ── one registry-rendered field ────────────────────────────────────────────────
function Field({
  entry,
  value,
  onType,
  onChoose,
  onCommit,
  vocabValues,
  mapPresent
}: {
  entry: MetadataEntry
  value: string
  onType: (value: string) => void
  onChoose: (value: string) => void
  onCommit: (retry?: boolean) => void
  vocabValues: Array<{ value: string; count: number }>
  /** For 'map' entries: whether the key exists in the outline (its value line may be empty). */
  mapPresent?: boolean
}) {
  const badge =
    entry.vocabulary.kind === 'open' ? (
      <span style={{ ...S.vocabBadge, color: GREEN, background: 'rgba(22,101,52,.1)' }}>any value</span>
    ) : entry.vocabulary.kind === 'closed' ? (
      <span style={{ ...S.vocabBadge, color: OXFORD, background: 'rgba(11,58,107,.09)' }}>fixed choices</span>
    ) : null

  return (
    <div style={S.field}>
      <div style={S.fieldLab}>
        <span style={S.fieldName}>{entry.label}</span>
        {badge}
      </div>
      <div style={S.fieldExp}>{entry.explanation}</div>
      {entry.type === 'map' ? (
        <div style={S.mapNote}>
          {mapPresent ? 'Set in this outline (structured setting).' : 'Not set in this outline.'} Edited in the
          outline{entry.key === 'defaults' ? ' or in Talk design' : ''} — not on this form.
        </div>
      ) : entry.vocabulary.kind === 'closed' ? (
        <ClosedField options={entry.vocabulary.options} value={value} onChange={onChoose} label={entry.label} />
      ) : entry.vocabulary.kind === 'open' ? (
        <OpenVocabField value={value} onType={onType} onChoose={onChoose} onCommit={onCommit} options={vocabValues} label={entry.label} />
      ) : (
        <input
          type="text"
          value={value}
          onChange={event => onType(event.target.value)}
          onBlur={() => onCommit()}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) onCommit(true) }}
          style={{ ...S.textInput, ...(entry.type === 'number' ? { width: 140, fontFamily: MONO } : {}) }}
          aria-label={entry.label}
        />
      )}
    </div>
  )
}

// Closed vocabulary: every documented option as a segmented button; the selected option's
// explanation renders beneath (the registry's per-option text, verbatim).
function ClosedField({
  options,
  value,
  onChange,
  label
}: {
  options: Array<{ value: string; label: string; explanation: string }>
  value: string
  onChange: (v: string) => void
  label: string
}) {
  const selected = options.find((o) => o.value === value) ?? options[0]
  const unknown = value !== '' && !options.some((o) => o.value === value)
  return (
    <>
      <div style={S.seg} role="group" aria-label={label}>
        {options.map((o, i) => {
          const on = o.value === (unknown ? ' ' : selected.value)
          return (
            <button
              key={o.value || '(default)'}
              type="button"
              onClick={() => onChange(o.value)}
              aria-pressed={on}
              style={{
                ...S.segBtn,
                ...(i === options.length - 1 ? { borderRight: 'none' } : {}),
                ...(on ? S.segBtnOn : {})
              }}
            >
              {o.label}
            </button>
          )
        })}
      </div>
      <div style={S.segExp}>
        {unknown
          ? `The outline currently says “${value}” — not a documented option; pick one above to fix it.`
          : `${selected.label} — ${selected.explanation}`}
      </div>
    </>
  )
}

// Open vocabulary: values observed anywhere in the vault (with usage counts) + a "new value"
// row that states the vault-wide consequence of choosing it. ↑↓ move, ↵ picks, Esc closes.
function OpenVocabField({
  value,
  onType,
  onChoose,
  onCommit,
  options,
  label
}: {
  value: string
  onType: (value: string) => void
  onChoose: (value: string) => void
  onCommit: (retry?: boolean) => void
  options: Array<{ value: string; count: number }>
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLInputElement>(null)

  const q = value.trim().toLowerCase()
  const rows: Array<{ kind: 'existing' | 'new'; value: string; count?: number }> = options
    .filter((o) => q === '' || o.value.toLowerCase().includes(q))
    .map((o) => ({ kind: 'existing' as const, value: o.value, count: o.count }))
  if (q !== '' && !options.some((o) => o.value.toLowerCase() === q)) {
    rows.push({ kind: 'new', value: value.trim() })
  }
  const clampedActive = Math.min(active, Math.max(0, rows.length - 1))

  function pick(v: string) {
    onChoose(v)
    setOpen(false)
    ref.current?.blur()
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={ref}
        type="text"
        value={value}
        aria-label={label}
        autoComplete="off"
        style={S.textInput}
        onFocus={() => { setActive(0); setOpen(true) }}
        onChange={(e) => { onType(e.target.value); setActive(0); setOpen(true) }}
        onBlur={() => { onCommit(); setOpen(false) }}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); return }
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
          else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (open && rows[clampedActive]) pick(rows[clampedActive].value)
            else onCommit(true)
          }
          else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false) }
        }}
      />
      {open && rows.length > 0 && (
        <div style={S.acDrop}>
          <div style={S.acNote}>Values used anywhere in the vault — choose one or add your own.</div>
          {rows.map((r, i) => (
            <button
              key={r.kind + r.value}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); pick(r.value) }}
              onMouseEnter={() => setActive(i)}
              style={{
                ...S.acOpt,
                ...(i === clampedActive ? S.acOptActive : {}),
                ...(r.kind === 'new' ? { color: GREEN } : {})
              }}
            >
              {r.kind === 'new' ? (
                <>
                  <Plus size={12} style={{ flexShrink: 0 }} />
                  <span>use “{r.value}” — new value, offered vault-wide from now on</span>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, textAlign: 'left' }}>{r.value}</span>
                  <span style={{ fontFamily: MONO, fontSize: '0.7rem', color: FAINT }}>×{r.count}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline styles — warm-paper palette, matching AbstractPanel/DeckDesignPanel.
// ---------------------------------------------------------------------------
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const AMBER = '#92600a'
const GREEN = 'var(--green, #166534)'
const CRIMSON = 'var(--crimson, #9f1239)'
const OXFORD = 'var(--oxford, #0b3a6b)'
const MUTED = 'var(--ink-muted, #5d6875)'
const FAINT = 'var(--ink-faint, #8a9099)'
const LINE = 'var(--line, #c8b89a)'
const PANEL = 'var(--panel, #f5f0e8)'
const PAPER = 'var(--paper-light, #faf7f2)'
const INK = 'var(--ink, #1a1410)'

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100
  },
  modal: {
    width: 660, maxWidth: '94vw', maxHeight: '86vh',
    background: PANEL, border: `1px solid ${LINE}`, borderRadius: 6,
    overflow: 'hidden', display: 'flex', flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.22)'
  },
  header: {
    display: 'flex', alignItems: 'baseline', gap: 10,
    padding: '0.65rem 0.9rem 0.1rem', flex: '0 0 auto'
  },
  title: {
    fontFamily: "'Iowan Old Style', Palatino, Georgia, serif",
    fontSize: '1.15rem', fontWeight: 600, color: INK
  },
  headLabel: {
    fontSize: '0.62rem', letterSpacing: '0.1em', textTransform: 'uppercase',
    color: FAINT, fontWeight: 650, marginLeft: 10
  },
  registryNote: { marginLeft: 'auto', fontFamily: MONO, fontSize: '0.66rem', color: FAINT },
  closeBtn: {
    background: 'transparent', border: 'none', color: FAINT, cursor: 'pointer',
    padding: '0 0.15rem', alignSelf: 'center', display: 'flex'
  },
  srcPath: {
    fontFamily: MONO, fontSize: '0.66rem', color: FAINT,
    padding: '0 0.95rem 0.55rem', borderBottom: `1px solid ${LINE}`, flex: '0 0 auto',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
  },
  embeddedRoot: { display: 'flex', flexDirection: 'column', minHeight: 0 },
  bodyEmbedded: { padding: '0.5rem 0.75rem 0.5rem', minHeight: 0 },
  body: { flex: 1, overflowY: 'auto', padding: '0.85rem 0.95rem 1.1rem', minHeight: 0 },
  loading: { color: FAINT, fontSize: '0.85rem', padding: '1rem 0' },
  errorBox: {
    color: '#c0392b', fontSize: '0.82rem', border: '1px solid #c0392b', borderRadius: 4,
    padding: '0.4rem 0.6rem', marginBottom: '0.8rem', background: 'rgba(192,57,43,0.06)'
  },

  doctor: {
    border: '1px solid rgba(146,96,10,.4)', background: 'rgba(146,96,10,.07)',
    borderRadius: 6, marginBottom: '1rem', overflow: 'hidden'
  },
  doctorClean: { border: '1px solid rgba(22,101,52,.35)', background: 'rgba(22,101,52,.06)' },
  noFm: {
    fontSize: '0.78rem', color: MUTED, lineHeight: 1.5, border: `1px dashed ${LINE}`,
    borderRadius: 6, padding: '8px 12px', background: PAPER
  },
  doctorRow: { display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px' },
  doctorText: { flex: 1, fontSize: '0.8rem', color: INK, lineHeight: 1.4 },
  doctorBtn: {
    fontSize: '0.75rem', color: AMBER, border: '1px solid rgba(146,96,10,.45)', borderRadius: 5,
    padding: '3px 9px', background: PAPER, fontWeight: 550, cursor: 'pointer', flexShrink: 0
  },
  doctorKeys: { borderTop: '1px solid rgba(146,96,10,.25)', padding: '4px 12px 8px' },
  dkey: {
    display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', fontSize: '0.8rem',
    borderTop: '1px dashed rgba(146,96,10,.25)'
  },
  dkeyGone: { opacity: 0.55 },
  dkeyName: { fontFamily: MONO, fontSize: '0.74rem', minWidth: 110, color: INK },
  dkeyWhere: { flex: 1, color: MUTED, fontSize: '0.74rem' },
  dkeyBtn: {
    fontSize: '0.72rem', border: `1px solid ${LINE}`, borderRadius: 5, padding: '2px 8px',
    background: PAPER, color: MUTED, cursor: 'pointer', flexShrink: 0
  },
  code: { fontFamily: MONO, fontSize: '0.72rem', background: 'rgba(0,0,0,0.06)', borderRadius: 3, padding: '0 4px' },

  groupHead: {
    fontSize: '0.64rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: FAINT,
    fontWeight: 650, margin: '1.1rem 0 0.55rem'
  },
  field: { marginBottom: '0.95rem' },
  fieldLab: { display: 'flex', alignItems: 'baseline', gap: 8 },
  fieldName: { fontWeight: 650, fontSize: '0.83rem', color: INK },
  vocabBadge: {
    fontSize: '0.58rem', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 650,
    borderRadius: 3, padding: '1px 5px'
  },
  fieldExp: { fontSize: '0.74rem', color: MUTED, margin: '2px 0 6px', lineHeight: 1.4 },
  mapNote: { fontSize: '0.74rem', color: FAINT, fontStyle: 'italic' },
  textInput: {
    width: '100%', boxSizing: 'border-box', border: `1px solid ${LINE}`, borderRadius: 5,
    background: PAPER, padding: '6px 10px', fontSize: '0.83rem', color: INK, outline: 'none'
  },
  seg: {
    display: 'inline-flex', flexWrap: 'wrap', border: `1px solid ${LINE}`, borderRadius: 5,
    overflow: 'hidden', background: PAPER
  },
  segBtn: {
    padding: '5px 13px', fontSize: '0.78rem', color: MUTED, background: 'transparent',
    border: 'none', borderRight: `1px solid ${LINE}`, cursor: 'pointer'
  },
  segBtnOn: { background: OXFORD, color: '#fff', fontWeight: 600 },
  segExp: { fontSize: '0.7rem', color: FAINT, marginTop: 4, lineHeight: 1.4 },
  acDrop: {
    position: 'absolute', top: 'calc(100% + 3px)', left: 0, right: 0, zIndex: 8,
    background: PAPER, border: `1px solid ${LINE}`, borderRadius: 5,
    boxShadow: '0 10px 26px rgba(0,0,0,.16)', overflow: 'hidden', padding: 4,
    maxHeight: 220, overflowY: 'auto'
  },
  acNote: {
    fontSize: '0.66rem', color: FAINT, padding: '3px 8px 5px',
    borderBottom: `1px solid ${LINE}`, marginBottom: 3
  },
  acOpt: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
    padding: '5px 8px', borderRadius: 4, fontSize: '0.79rem', background: 'transparent',
    border: 'none', color: INK, cursor: 'pointer'
  },
  acOptActive: { background: 'rgba(11,58,107,.08)', outline: `1.5px solid ${OXFORD}`, outlineOffset: -1.5 },

  sys: { marginTop: '1.3rem', border: `1px solid ${LINE}`, borderRadius: 6, background: PAPER, overflow: 'hidden' },
  sysHead: {
    display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '9px 12px',
    textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', color: INK
  },
  sysTitle: { fontWeight: 650, fontSize: '0.8rem', flex: 1 },
  sysCount: { color: FAINT, fontWeight: 400, fontSize: '0.72rem', marginLeft: 8 },
  sysReveal: { fontSize: '0.74rem', color: OXFORD, fontWeight: 550, display: 'flex', alignItems: 'center', gap: 4 },
  sysBody: { borderTop: `1px solid ${LINE}`, padding: '4px 12px 10px' },
  sysExp: { fontSize: '0.7rem', color: FAINT, padding: '6px 0 8px', lineHeight: 1.45 },
  srow: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0',
    borderTop: `1px dashed ${LINE}`, fontSize: '0.8rem'
  },
  srowKey: { fontFamily: MONO, fontSize: '0.72rem', minWidth: 112, color: MUTED, flexShrink: 0 },
  srowVal: {
    fontFamily: MONO, fontSize: '0.72rem', color: INK, maxWidth: 170,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0
  },
  srowWhy: { flex: 1, fontSize: '0.68rem', color: FAINT, lineHeight: 1.35 },
  srowDel: {
    fontSize: '0.7rem', color: FAINT, border: '1px solid transparent', borderRadius: 4,
    padding: '1px 6px', background: 'transparent', cursor: 'pointer', flexShrink: 0
  },
  sysConfirm: {
    margin: '4px 0 6px', border: '1px solid rgba(159,18,57,.45)', background: 'rgba(159,18,57,.06)',
    borderRadius: 5, padding: '8px 10px', fontSize: '0.76rem', lineHeight: 1.45, color: INK
  },
  confirmActs: { display: 'flex', gap: 8, marginTop: 6 },
  confirmBtn: {
    fontSize: '0.72rem', borderRadius: 5, padding: '3px 10px',
    border: `1px solid ${LINE}`, background: PAPER, color: INK, cursor: 'pointer'
  },

  footer: {
    display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.9rem',
    borderTop: `1px solid ${LINE}`, flex: '0 0 auto'
  },
  btn: {
    padding: '0.4rem 1rem', fontSize: '0.85rem', borderRadius: 4,
    border: '1px solid transparent', cursor: 'pointer', fontWeight: 500
  },
  btnPrimary: { background: 'var(--oxford, #002147)', color: '#fff', border: '1px solid var(--oxford, #002147)' },
  btnSecondary: { background: 'transparent', color: INK, border: `1px solid ${LINE}` },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' }
}
