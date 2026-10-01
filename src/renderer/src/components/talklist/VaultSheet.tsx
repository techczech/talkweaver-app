import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type {
  ChosenVaultFolder, VaultActionResult, VaultPersonalFields, VaultRef, VaultSettingsResult, VaultSharedFields,
  VaultStyleOption, VaultView
} from '../../../../preload/index'
import { IcLock, IcPeople, IcWarn } from './icons'

// Add a vault, Edit this vault, and "This folder is already a vault" (several-vaults ticket 04;
// docs/design/2026-09-29-multi-vault/LOCKED-edit-vault.html). One sheet, two groups, never mixed:
// "Shared with everyone in this vault" (written to the vault file) above "Just for me" (author and
// badge, kept on this Mac). A refusal (the folder is already a vault, or sits inside one) is the
// small alert sheet of frame 3; it names the vault, never a path.

export type VaultSheetState =
  | { mode: 'new'; chosen: Extract<ChosenVaultFolder, { ok: true }> }
  | { mode: 'join'; chosen: Extract<ChosenVaultFolder, { ok: true }> }
  | { mode: 'edit'; vaultId: string }
  | { mode: 'refused'; reason: string; message: string; other?: VaultRef | null }

type Props = {
  state: VaultSheetState
  onClose: () => void
  /** A vault was created, joined or saved. */
  onDone: (vault: VaultView) => void
  /** "Choose another folder" on a refusal. */
  onChooseAnother: () => void
  /** "Show <vault>" on the already-open refusal. */
  onShowVault: (vaultId: string) => void
}

function Badge({ color, initial, size }: { color: string; initial: string; size?: 'sm' | 'lg' | 'xl' }) {
  return <span className={`vs-vb${size ? ' ' + size : ''}`} style={{ '--c': color } as CSSProperties} aria-hidden>{initial || '?'}</span>
}

const firstLetter = (name: string): string => ([...name.trim()][0] ?? '').toUpperCase()

export function VaultSheet(props: Props) {
  const { state } = props
  if (state.mode === 'refused') return <RefusedSheet {...props} state={state} />
  return <SettingsSheet {...props} state={state} />
}

function RefusedSheet({ state, onClose, onChooseAnother, onShowVault }: Props & { state: Extract<VaultSheetState, { mode: 'refused' }> }) {
  useEscape(onClose)
  const other = state.other ?? null
  let body: React.ReactNode
  let show = false
  if ((state.reason === 'duplicate' || state.reason === 'duplicate-id') && other) {
    show = true
    body = (
      <div>
        <b className="vs-alert-h">{state.reason === 'duplicate' ? 'This folder is already open as a vault.' : 'This folder is a copy of a vault you already have.'}</b>
        It is <Badge color={other.color} initial={other.initial} size="sm" /> <b>{other.name}</b>{other.service ? ` (${other.service})` : ''} in your sidebar. Nothing was added.
      </div>
    )
  } else if (state.reason === 'inside-another' && other) {
    body = (
      <div>
        <b className="vs-alert-h">This folder is inside another vault.</b>
        It sits inside <b>{other.name}</b>. A vault cannot contain another vault; its talks already appear under {other.name}.
      </div>
    )
  } else if (state.reason === 'contains-another' && other) {
    body = (
      <div>
        <b className="vs-alert-h">This folder contains another vault.</b>
        <b>{other.name}</b> sits inside it. A vault cannot contain another vault; close {other.name} first.
      </div>
    )
  } else {
    body = <div><b className="vs-alert-h">This folder cannot be added.</b>{state.message}</div>
  }
  return (
    <>
      <div className="vs-backdrop" onClick={onClose} />
      <div className="vs-sheet vs-sheet--narrow" role="dialog" aria-modal="true" aria-label="Add vault" data-vault-sheet="refused" data-refusal={state.reason}>
        <div className="vs-alert err"><IcWarn size={16} />{body}</div>
        <div className="vs-alert-btns">
          <button type="button" className={`vs-btn${show ? ' plain' : ''}`} onClick={onChooseAnother} data-choose-another>Choose another folder</button>
          {show && other && <button type="button" className="vs-btn" onClick={() => onShowVault(other.id)} data-show-vault>Show {other.name}</button>}
        </div>
      </div>
    </>
  )
}

function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])
}

type Loaded = {
  mode: 'new' | 'join' | 'edit'
  vaultId?: string
  token?: string
  folderName: string
  service: VaultView['service']
  createdBy: string | null
  fields: VaultSharedFields
  styleLabel: string
  logoPreview: string | null
  /** A logo chosen outside the vault: main's token and the file name (copied in on Save / Create). */
  logoUpload?: string
  logoName?: string
  author: string
  appAuthor: string
  badgeColour: string
  badgeInitial: string
  initialChosen: boolean
  swatches: string[]
  styles: VaultStyleOption[]
  fileProblem: string | null
}

function fromChosen(state: Extract<VaultSheetState, { mode: 'new' | 'join' }>): Loaded {
  const c = state.chosen
  const v = c.vault
  return {
    mode: state.mode,
    token: c.token,
    folderName: c.folderName,
    service: c.service,
    createdBy: v?.createdBy ?? null,
    fields: v ? { name: v.name, shared: v.shared, affiliation: v.affiliation, style: v.style, logo: v.logo } : { name: c.suggested.name, shared: false, affiliation: '', style: '', logo: '' },
    styleLabel: v?.styleLabel ?? '',
    logoPreview: v?.logoPreview ?? null,
    author: c.suggested.author,
    appAuthor: c.suggested.author,
    badgeColour: c.suggested.badgeColour,
    badgeInitial: c.suggested.badgeInitial,
    initialChosen: false,
    swatches: c.swatches,
    styles: c.styles,
    fileProblem: null
  }
}

function fromSettings(s: Extract<VaultSettingsResult, { ok: true }>): Loaded {
  return {
    mode: 'edit',
    vaultId: s.vault.id,
    folderName: s.vault.name,
    service: s.vault.service,
    createdBy: s.vault.createdBy,
    fields: s.fields,
    styleLabel: '',
    logoPreview: s.logoPreview,
    author: s.personal.author || s.appAuthor,
    appAuthor: s.appAuthor,
    badgeColour: s.vault.color,
    badgeInitial: s.personal.badgeInitial || firstLetter(s.fields.name) || s.vault.initial,
    initialChosen: !!s.personal.badgeInitial,
    swatches: s.swatches,
    styles: s.styles,
    fileProblem: s.fileProblem
  }
}

function SettingsSheet({ state, onClose, onDone }: Props & { state: Extract<VaultSheetState, { mode: 'new' | 'join' | 'edit' }> }) {
  const [data, setData] = useState<Loaded | null>(() => (state.mode === 'edit' ? null : fromChosen(state)))
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [touchedName, setTouchedName] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const authorRef = useRef<HTMLInputElement>(null)
  useEscape(onClose)

  useEffect(() => {
    if (state.mode !== 'edit') return
    let live = true
    void window.tw.vault.getSettings(state.vaultId).then((s) => {
      if (!live) return
      if (s.ok) setData(fromSettings(s))
      else setLoadError(s.message)
    })
    return () => { live = false }
  }, [state])

  useEffect(() => {
    if (!data) return
    requestAnimationFrame(() => {
      const el = data.mode === 'join' ? authorRef.current : nameRef.current
      el?.focus()
    })
    // focus once, when the sheet has its data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data === null])

  if (loadError) {
    return (
      <>
        <div className="vs-backdrop" onClick={onClose} />
        <div className="vs-sheet vs-sheet--narrow" role="dialog" aria-modal="true" aria-label="Edit vault">
          <div className="vs-alert err"><IcWarn size={16} /><div>{loadError}</div></div>
          <div className="vs-alert-btns"><button type="button" className="vs-btn" onClick={onClose}>Close</button></div>
        </div>
      </>
    )
  }
  if (!data) return <div className="vs-backdrop" onClick={onClose} />

  const d = data
  const set = (patch: Partial<Loaded>): void => setData({ ...d, ...patch })
  const setField = <K extends keyof VaultSharedFields>(key: K, value: VaultSharedFields[K]): void => {
    const fields = { ...d.fields, [key]: value }
    // The badge initial follows the name's first letter until the person picks one.
    const badgeInitial = key === 'name' && !d.initialChosen ? firstLetter(String(value)) || d.badgeInitial : d.badgeInitial
    setData({ ...d, fields, badgeInitial })
    setError(null)
  }
  const sharedReadOnly = d.mode === 'join' || !!d.fileProblem
  const nameMissing = !d.fields.name.trim()
  const canSubmit = !busy && (sharedReadOnly || !nameMissing)
  const displayName = d.fields.name.trim() || d.folderName
  const personal = (): VaultPersonalFields => ({
    // An author equal to Settings' follows Settings; a different one is this vault's own.
    author: d.author.trim() === d.appAuthor.trim() ? '' : d.author.trim(),
    badgeColour: d.badgeColour,
    badgeInitial: d.initialChosen ? d.badgeInitial : ''
  })

  async function chooseLogo(): Promise<void> {
    const target = d.vaultId ? { vaultId: d.vaultId } : { token: d.token as string }
    const picked = await window.tw.vault.chooseLogo(target)
    if (!picked) return
    if (!picked.ok) { setError(picked.message); return }
    setData({ ...d, fields: { ...d.fields, logo: picked.logo }, logoPreview: picked.preview, logoUpload: picked.upload, logoName: picked.fileName })
    setError(null)
  }

  async function submit(): Promise<void> {
    if (!canSubmit) { setTouchedName(true); return }
    setBusy(true)
    setError(null)
    let result: VaultActionResult
    const shared = { ...d.fields, ...(d.logoUpload ? { logoUpload: d.logoUpload } : {}) }
    if (d.mode === 'new') result = await window.tw.vault.create(d.token as string, shared, personal())
    else if (d.mode === 'join') result = await window.tw.vault.join(d.token as string, personal())
    else result = await window.tw.vault.saveSettings(d.vaultId as string, d.fileProblem ? null : shared, personal())
    setBusy(false)
    if (!result.ok) { setError(result.message); return }
    onDone(result.vault)
  }

  const eyebrow = d.mode === 'new' ? 'New vault' : d.mode === 'join' ? 'This folder is already a vault' : 'Edit vault'
  const sub = d.mode === 'new'
    ? `A vault is a folder of talks. Folder: ${d.folderName} · ${d.service}`
    : d.mode === 'join'
      ? [d.createdBy ? `Set up by ${d.createdBy}` : null, d.service, d.fields.shared ? 'shared' : 'private'].filter(Boolean).join(' · ')
      : `${d.service} · ${d.fields.shared ? 'shared' : 'private'}`
  const cta = d.mode === 'new' ? 'Create vault' : d.mode === 'join' ? 'Open vault' : 'Done'
  const footNote = d.mode === 'new'
    ? 'Change any of this later from the vault’s ⋯ menu › Edit this vault…'
    : d.mode === 'join'
      ? 'Change the shared settings later in Edit this vault.'
      : `New talks in ${displayName} use these. Talks already written keep their own until you change them.`
  const styleOptions = d.styles.some((o) => o.value === d.fields.style) ? d.styles : [...d.styles, { value: d.fields.style, label: d.fields.style }]
  const styleLabel = d.styleLabel || styleOptions.find((o) => o.value === d.fields.style)?.label || d.fields.style

  const logoBox = (
    <div className="vs-logo-box" data-vault-logo={d.logoUpload ? `upload:${d.logoName ?? ''}` : d.fields.logo || ''} title={d.logoUpload ? 'Copied into this vault when you save' : undefined}>
      {d.logoPreview ? <img src={d.logoPreview} alt="Logo" /> : <span className="vs-none">{d.logoName || (d.fields.logo ? d.fields.logo.split('/').pop() : 'No logo')}</span>}
    </div>
  )

  return (
    <>
      <div className="vs-backdrop" onClick={onClose} />
      <div
        className={`vs-sheet${d.mode === 'join' ? ' vs-sheet--join' : ''}`}
        role="dialog" aria-modal="true" aria-label={eyebrow}
        data-vault-sheet={d.mode}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() } }}
      >
        <div className="vs-head">
          <Badge color={d.badgeColour} initial={d.badgeInitial} size="xl" />
          <div className="vs-head-text">
            <div className="vs-eyebrow">{eyebrow}</div>
            <div className="vs-title" data-vault-sheet-title>{displayName}</div>
            <div className="vs-sub">{sub}</div>
          </div>
        </div>

        <div className="vs-body">
          {d.mode === 'join' ? (
            <div className="vs-grp vs-grp--shared vs-grp--three" data-group="shared">
              <div className="vs-grp-h"><IcPeople size={15} /><b>Comes with the vault</b><span className="vs-d">{d.createdBy ? `Set by ${d.createdBy}. ` : ''}Shared with everyone who opens it.</span></div>
              <div className="vs-grp-b">
                <div><span className="vs-lbl">Affiliation</span><div className="vs-field is-ro">{d.fields.affiliation || '—'}</div></div>
                <div><span className="vs-lbl">Style</span><div className="vs-field is-ro">{styleLabel || 'TalkWeaver default'}</div></div>
                <div><span className="vs-lbl">Logo</span><div className="vs-field is-ro">{d.logoPreview && <img className="vs-logo-inline" src={d.logoPreview} alt="" />}{d.fields.logo ? d.fields.logo.split('/').pop() : 'No logo'}</div></div>
              </div>
            </div>
          ) : (
            <div className="vs-grp vs-grp--shared" data-group="shared">
              <div className="vs-grp-h">
                <IcPeople size={15} /><b>Shared with everyone in this vault</b>
                <span className="vs-d">{d.mode === 'edit' ? `Stored in the vault file. Changes reach everyone who opens ${displayName}.` : 'Stored in the vault file. Everyone who opens it gets these.'}</span>
              </div>
              <div className="vs-grp-b">
                {d.fileProblem && <div className="vs-alert warn vs-span2"><IcWarn size={16} /><div>{d.fileProblem}</div></div>}
                <div>
                  <label className="vs-lbl" htmlFor="vs-name">Name</label>
                  <input
                    id="vs-name" ref={nameRef} className={`vs-field${nameMissing && (touchedName || d.mode === 'edit') ? ' is-err' : ''}`}
                    value={d.fields.name} placeholder="Vault name" disabled={sharedReadOnly} maxLength={200}
                    onChange={(e) => setField('name', e.target.value)} onBlur={() => setTouchedName(true)} data-field="name"
                  />
                  {nameMissing && (touchedName || d.mode === 'edit') && <div className="vs-errtext">A vault needs a name.</div>}
                </div>
                <div>
                  <span className="vs-lbl">Shared</span>
                  <button
                    type="button" role="switch" aria-checked={d.fields.shared} disabled={sharedReadOnly}
                    className={`vs-switch${d.fields.shared ? '' : ' is-off'}`} onClick={() => setField('shared', !d.fields.shared)} data-field="shared"
                  >
                    <span className="vs-toggle" />{d.fields.shared ? 'Yes, others can open it' : 'No, only me'}
                  </button>
                </div>
                <div>
                  <label className="vs-lbl" htmlFor="vs-affiliation">Affiliation</label>
                  <input
                    id="vs-affiliation" className="vs-field" value={d.fields.affiliation} placeholder="e.g. University of Oxford" disabled={sharedReadOnly} maxLength={200}
                    onChange={(e) => setField('affiliation', e.target.value)} data-field="affiliation"
                  />
                </div>
                <div>
                  <label className="vs-lbl" htmlFor="vs-style">Style</label>
                  <select id="vs-style" className="vs-field" value={d.fields.style} disabled={sharedReadOnly} onChange={(e) => setField('style', e.target.value)} data-field="style">
                    {styleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="vs-span2">
                  <span className="vs-lbl">Logo</span>
                  <div className="vs-logo-row">
                    {logoBox}
                    <button type="button" className="vs-btn plain" disabled={sharedReadOnly} onClick={() => { void chooseLogo() }} data-choose-logo>Choose…</button>
                    {(d.fields.logo || d.logoUpload) && !sharedReadOnly && <button type="button" className="vs-link" onClick={() => set({ fields: { ...d.fields, logo: '' }, logoPreview: null, logoUpload: undefined, logoName: undefined })} data-remove-logo>Remove</button>}
                    <span className="vs-help" style={{ marginTop: 0 }}>Appears on the title slide of talks in this vault.</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="vs-grp vs-grp--mine" data-group="mine">
            <div className="vs-grp-h"><IcLock size={15} /><b>Just for me</b><span className="vs-d">Only you see these. They are not stored in the vault file.</span></div>
            <div className="vs-grp-b">
              <div>
                <label className="vs-lbl" htmlFor="vs-author">{d.mode === 'join' ? 'Your name in this vault' : 'Author'}</label>
                <input id="vs-author" ref={authorRef} className="vs-field" value={d.author} maxLength={120} onChange={(e) => set({ author: e.target.value })} data-field="author" />
                <div className="vs-help">
                  {d.mode === 'new'
                    ? 'Filled from Settings › Presenter identity. Used as author on your talks in this vault.'
                    : d.mode === 'join'
                      ? 'Your name in this vault. Used as author on your talks in it. Colleagues keep their own.'
                      : 'Used as author on your talks in this vault. Colleagues keep their own.'}
                </div>
              </div>
              <div>
                <span className="vs-lbl">Badge colour and initial</span>
                <div className="vs-badge-row">
                  <div className="vs-swatches" role="radiogroup" aria-label="Badge colour">
                    {d.swatches.map((c) => (
                      <button
                        key={c} type="button" role="radio" aria-checked={d.badgeColour === c} aria-label={c}
                        className={`vs-sw${d.badgeColour === c ? ' is-on' : ''}`} style={{ '--c': c } as CSSProperties}
                        onClick={() => set({ badgeColour: c })} data-swatch={c}
                      />
                    ))}
                  </div>
                  <input
                    className="vs-field is-initial" aria-label="Badge initial" value={d.badgeInitial} maxLength={2}
                    onChange={(e) => {
                      const v = firstLetter([...e.target.value].slice(-1).join(''))
                      set({ badgeInitial: v || firstLetter(displayName), initialChosen: !!v })
                    }}
                    data-field="initial"
                  />
                  <Badge color={d.badgeColour} initial={d.badgeInitial} size="lg" />
                </div>
                <div className="vs-help">Your badge for this vault in the sidebar, search, the Inspector and Copy to vault. Each person picks their own.</div>
              </div>
            </div>
          </div>
          {error && <div className="vs-alert err" role="alert" data-vault-sheet-error><IcWarn size={16} /><div>{error}</div></div>}
        </div>

        <div className="vs-foot">
          <span className="vs-foot-note">{footNote}</span>
          <div className="vs-foot-btns">
            <button type="button" className="vs-btn plain" onClick={onClose}>Cancel</button>
            <button type="button" className="vs-btn" disabled={!canSubmit} onClick={() => { void submit() }} data-vault-sheet-submit>{cta}</button>
          </div>
        </div>
      </div>
    </>
  )
}
