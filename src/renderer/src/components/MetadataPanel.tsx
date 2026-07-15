// Per-talk Metadata panel (ADR-0036) — the registry, rendered. Every field comes from
// src/shared/metadata-registry.ts: label + user-facing explanation + documented options
// (closed) or vault-wide autocomplete (open). No raw YAML anywhere. System keys sit behind a
// locked reveal; deleting one names its consequence first. An amber doctor row surfaces
// unregistered keys found in THIS outline (remove them, or keep-and-ignore).
//
// Design lock: docs/design/2026-07-11-v015-tags-metadata/direction-a-rail.html (stage 2).
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Lock, Unlock, Plus, X } from 'lucide-react'
import type { TalkInfo, MetadataVocabulary } from '../../../preload/index'
import {
  METADATA_REGISTRY,
  activeUserFrontmatterEntries,
  systemFrontmatterEntries,
  findEntry,
  type MetadataEntry
} from '../../../shared/metadata-registry'
import { notify } from '../lib/notify'

interface Props {
  talk: TalkInfo | null
  vaultRoot: string
  isOpen: boolean
  onClose: () => void
  /** Awaited before any disk read/write, so a live editor buffer's autosave lands first. */
  flushBeforeIO?: () => Promise<void>
  /** Called with the outline's new full text after every disk write (adoption path). */
  onSaved?: (outlinePath: string, content: string) => void
}

// Parse the outline's top-level frontmatter pairs (same shape the main process reads).
function parsePairs(text: string): Array<{ key: string; value: string }> {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return []
  const pairs: Array<{ key: string; value: string }> = []
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/)
    if (m) pairs.push({ key: m[1], value: m[2].trim().replace(/^["']|["']$/g, '').trim() })
  }
  return pairs
}

/** The value an entry currently holds in the outline, under any accepted spelling. */
function valueFor(entry: MetadataEntry, pairs: Array<{ key: string; value: string }>): string {
  const spellings = [entry.key, ...(entry.aliases ?? [])]
  const hit = pairs.find((p) => spellings.includes(p.key))
  return hit ? hit.value : ''
}

type DoctorRowState = 'open' | 'removed' | 'kept'

export default function MetadataPanel({ talk, vaultRoot, isOpen, onClose, flushBeforeIO, onSaved }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [baseline, setBaseline] = useState<Record<string, string>>({})
  const [vocab, setVocab] = useState<MetadataVocabulary>({})
  const [doctorRows, setDoctorRows] = useState<Array<{ key: string; value: string; state: DoctorRowState }>>([])
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [sysOpen, setSysOpen] = useState(false)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  const userEntries = useMemo(() => activeUserFrontmatterEntries(), [])
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

  const pairs = useMemo(() => (content ? parsePairs(content) : []), [content])
  const idStampCount = useMemo(() => (content ? (content.match(/\{id=/g) ?? []).length : 0), [content])
  const dirty = useMemo(
    () => Object.keys(draft).some((k) => (draft[k] ?? '') !== (baseline[k] ?? '')),
    [draft, baseline]
  )

  // Load everything when the panel opens: flush the live buffer, then read disk truth.
  useEffect(() => {
    if (!isOpen || !talk) return
    let cancelled = false
    setContent(null)
    setError(null)
    setSavedFlash(false)
    setConfirmKey(null)
    setSysOpen(false)
    setDoctorOpen(false)
    ;(async () => {
      try {
        await flushBeforeIO?.()
        const [text, doctor, vocabulary] = await Promise.all([
          window.tw.talk.readOutline(talk.outlinePath),
          window.tw.metadata.doctor(),
          window.tw.metadata.vocabulary()
        ])
        if (cancelled) return
        if (text == null) { setError('The outline could not be read.'); return }
        setContent(text)
        setVocab(vocabulary ?? {})
        const mine = doctor?.find((d) => d.outlinePath === talk.outlinePath)
        setDoctorRows((mine?.unregistered ?? []).map((k) => ({ ...k, state: 'open' as const })))
        const parsed = parsePairs(text)
        const values: Record<string, string> = {}
        for (const e of activeUserFrontmatterEntries()) values[e.key] = valueFor(e, parsed)
        setDraft(values)
        setBaseline(values)
        requestAnimationFrame(() => firstFieldRef.current?.focus())
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load metadata.')
      }
    })()
    return () => { cancelled = true }
  }, [isOpen, talk])

  // One write path for everything (fields, doctor removals, system deletes).
  const writeEdits = useCallback(
    async (edits: Array<{ key: string; value: string | null; aliases?: string[] }>): Promise<boolean> => {
      if (!talk) return false
      await flushBeforeIO?.()
      const res = await window.tw.metadata.editFrontmatter(talk.outlinePath, edits)
      if (!res.ok) {
        // Human-readable failure + recovery, never a raw code (Gate-5). Nothing was written.
        const why: Record<string, string> = {
          'bad-request': 'the request was malformed — close and reopen this panel',
          'bad-key': 'one of the keys was not a valid frontmatter name — close and reopen this panel',
          'bad-value': 'one of the values could not be written — check for unusual characters',
          unreadable: 'the outline file could not be read — check it still exists on disk',
          'write-failed': 'the outline file could not be written — check disk space and permissions, then try again'
        }
        setError(`Couldn’t save: ${why[res.error] ?? res.error}. The outline on disk is unchanged.`)
        return false
      }
      setContent(res.content)
      if (res.changed) onSaved?.(talk.outlinePath, res.content)
      return true
    },
    [talk, flushBeforeIO, onSaved]
  )

  async function handleSave() {
    if (!talk || saving) return
    const edits: Array<{ key: string; value: string | null; aliases?: string[] }> = []
    for (const e of userEntries) {
      const now = (draft[e.key] ?? '').trim()
      const was = (baseline[e.key] ?? '').trim()
      if (now === was) continue
      edits.push({ key: e.key, value: now === '' ? null : now, aliases: e.aliases })
    }
    if (edits.length === 0) return
    setSaving(true)
    setError(null)
    try {
      if (await writeEdits(edits)) {
        setBaseline({ ...draft })
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 2500)
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDoctorRemove(key: string) {
    if (!(await writeEdits([{ key, value: null }]))) return
    setDoctorRows((rows) => rows.map((r) => (r.key === key ? { ...r, state: 'removed' } : r)))
  }

  async function handleDoctorKeep(key: string) {
    if (!talk) return
    const res = await window.tw.metadata.ignoreKey(talk.outlinePath, key)
    if (!res?.ok) { notify(`Couldn’t record “${key}” in the ignore list.`, 'error'); return }
    setDoctorRows((rows) => rows.map((r) => (r.key === key ? { ...r, state: 'kept' } : r)))
  }

  async function handleSystemDelete(key: string) {
    const entry = findEntry(key)
    if (!(await writeEdits([{ key, value: null, aliases: entry?.aliases }]))) return
    setConfirmKey(null)
    notify(`${key} removed from the frontmatter.`, 'success')
  }

  // Esc: close the innermost thing first (confirm → panel). Autocomplete handles its own Esc
  // with stopPropagation before this listener sees it.
  useEffect(() => {
    if (!isOpen) return
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (confirmKey !== null) setConfirmKey(null)
      else onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, confirmKey, onClose])

  if (!isOpen || !talk) return null

  const openDoctorRows = doctorRows.filter((r) => r.state === 'open')
  const presentSystem = systemEntries.filter((e) => valueFor(e, pairs) !== '')
  const relPath = vaultRoot && talk.outlinePath.startsWith(vaultRoot)
    ? talk.outlinePath.slice(vaultRoot.length).replace(/^\//, '')
    : talk.outlinePath

  return (
    <div style={S.backdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={S.modal} role="dialog" aria-modal="true" aria-label={`Metadata — ${talk.title}`}>
        <div style={S.header}>
          <div style={{ minWidth: 0 }}>
            <span style={S.title}>{talk.title}</span>
            <span style={S.headLabel}>frontmatter</span>
          </div>
          <span style={S.registryNote}>{METADATA_REGISTRY.length} declared keys</span>
          <button type="button" onClick={onClose} style={S.closeBtn} aria-label="Close metadata panel" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div style={S.srcPath}>{relPath}</div>

        <div style={S.body}>
          {error && <div style={S.errorBox}>{error}</div>}
          {content === null && !error && <div style={S.loading}>Loading…</div>}
          {content !== null && (
            <>
              {/* Doctor status is ALWAYS visible — a clean bill of health is a designed state
                  (Gate-5), not an absence. Green check + "Everything declared" when there is
                  nothing to report; amber review row when unregistered keys were found. */}
              {doctorRows.length === 0 && (
                <div style={{ ...S.doctor, ...S.doctorClean }}>
                  <div style={S.doctorRow}>
                    <CheckCircle2 size={15} style={{ color: GREEN, flexShrink: 0 }} />
                    <span style={S.doctorText}>
                      <b style={{ color: GREEN }}>Everything declared ✓</b> — every frontmatter key in this
                      outline is in the Metadata Registry.
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
                            {openDoctorRows.length} unregistered key{openDoctorRows.length === 1 ? '' : 's'}
                          </b>{' '}
                          found in this outline — not declared in the Metadata Registry, so no surface can
                          explain or edit {openDoctorRows.length === 1 ? 'it' : 'them'}.
                        </>
                      ) : (
                        <b style={{ color: GREEN }}>All clear — every key in this outline is declared or kept on purpose.</b>
                      )}
                    </span>
                    <button type="button" style={S.doctorBtn} onClick={() => setDoctorOpen((o) => !o)}>
                      {doctorOpen ? 'Hide' : 'Review keys'}
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
                                onClick={() => void handleDoctorRemove(r.key)}
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
                  This talk has no frontmatter yet. Fill in any field below and press Save —
                  TalkWeaver will create the frontmatter block at the top of the outline for you.
                </div>
              )}
              {groups.map((group) => (
                <div key={group.name}>
                  <div style={S.groupHead}>{group.name}</div>
                  {group.entries.map((entry, i) => (
                    <Field
                      key={entry.key}
                      entry={entry}
                      value={draft[entry.key] ?? ''}
                      onChange={(v) => { setDraft((d) => ({ ...d, [entry.key]: v })); setSavedFlash(false) }}
                      vocabValues={vocab[entry.key] ?? []}
                      mapPresent={pairs.some((p) => [entry.key, ...(entry.aliases ?? [])].includes(p.key))}
                      inputRef={group.name === groups[0].name && i === 0 ? firstFieldRef : undefined}
                    />
                  ))}
                </div>
              ))}

              <div style={S.sys}>
                <button type="button" style={S.sysHead} onClick={() => setSysOpen((o) => !o)} aria-expanded={sysOpen}>
                  {sysOpen ? <Unlock size={14} style={{ color: FAINT }} /> : <Lock size={14} style={{ color: FAINT }} />}
                  <span style={S.sysTitle}>
                    System
                    <span style={S.sysCount}>
                      {presentSystem.length} managed key{presentSystem.length === 1 ? '' : 's'} · {idStampCount} slide id{idStampCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span style={S.sysReveal}>
                    {sysOpen ? 'Hide' : 'Reveal'}
                    {sysOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </span>
                </button>
                {sysOpen && (
                  <div style={S.sysBody}>
                    <div style={S.sysExp}>
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
                                onClick={() => void handleSystemDelete(entry.key)}
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
            </>
          )}
        </div>

        <div style={S.footer}>
          <div style={{ flex: 1, fontSize: '0.8rem' }}>
            {savedFlash ? (
              <span style={{ color: GREEN }}>Saved</span>
            ) : dirty ? (
              <span style={{ color: AMBER }}>Unsaved changes</span>
            ) : null}
          </div>
          <button type="button" onClick={onClose} style={{ ...S.btn, ...S.btnSecondary }}>
            Close
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !dirty || content === null}
            style={{ ...S.btn, ...S.btnPrimary, ...(saving || !dirty || content === null ? S.btnDisabled : {}) }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── one registry-rendered field ────────────────────────────────────────────────
function Field({
  entry,
  value,
  onChange,
  vocabValues,
  mapPresent,
  inputRef
}: {
  entry: MetadataEntry
  value: string
  onChange: (v: string) => void
  vocabValues: Array<{ value: string; count: number }>
  /** For 'map' entries: whether the key exists in the outline (its value line may be empty). */
  mapPresent?: boolean
  inputRef?: React.RefObject<HTMLInputElement>
}) {
  const badge =
    entry.vocabulary.kind === 'open' ? (
      <span style={{ ...S.vocabBadge, color: GREEN, background: 'rgba(22,101,52,.1)' }}>open · vault-wide</span>
    ) : entry.vocabulary.kind === 'closed' ? (
      <span style={{ ...S.vocabBadge, color: OXFORD, background: 'rgba(11,58,107,.09)' }}>closed · documented</span>
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
          {mapPresent ? 'Set in this outline (structured YAML).' : 'Not set in this outline.'} Edited in the
          outline{entry.key === 'defaults' ? ' or on the Deck design panel' : ''} — not on this form.
        </div>
      ) : entry.vocabulary.kind === 'closed' ? (
        <ClosedField options={entry.vocabulary.options} value={value} onChange={onChange} label={entry.label} />
      ) : entry.vocabulary.kind === 'open' ? (
        <OpenVocabField value={value} onChange={onChange} options={vocabValues} label={entry.label} inputRef={inputRef} />
      ) : (
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
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
  onChange,
  options,
  label,
  inputRef
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; count: number }>
  label: string
  inputRef?: React.RefObject<HTMLInputElement>
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const localRef = useRef<HTMLInputElement>(null)
  const ref = inputRef ?? localRef

  const q = value.trim().toLowerCase()
  const rows: Array<{ kind: 'existing' | 'new'; value: string; count?: number }> = options
    .filter((o) => q === '' || o.value.toLowerCase().includes(q))
    .map((o) => ({ kind: 'existing' as const, value: o.value, count: o.count }))
  if (q !== '' && !options.some((o) => o.value.toLowerCase() === q)) {
    rows.push({ kind: 'new', value: value.trim() })
  }
  const clampedActive = Math.min(active, Math.max(0, rows.length - 1))

  function pick(v: string) {
    onChange(v)
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
        onChange={(e) => { onChange(e.target.value); setActive(0); setOpen(true) }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { setOpen(true); return }
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
          else if (e.key === 'Enter') { e.preventDefault(); if (rows[clampedActive]) pick(rows[clampedActive].value) }
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
