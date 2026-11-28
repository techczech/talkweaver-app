import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, CodeXml, FileInput, Folder, FolderPlus, GraduationCap, HardDrive, ListTree, Square } from 'lucide-react'
import { WELCOME_COMMANDS, type StartingView } from '../../../../shared/workspace-view'
import { leafName } from '../../../../shared/vault-gallery-browse'
import { VaultBadge } from '../talklist/VaultRows'
import type { ExplorerPlace, ExplorerVault } from './explorerModel'

export interface ExplorerStartActions {
  start(title: string, view: StartingView, place: ExplorerPlace | null): Promise<string | null>
  examples(): Promise<string | null>
  importPowerPoint(): void
  chooseVault(): void
}

export default function ExplorerStart({ actions, place, places, setPlace, newFolder, busy, open, run, error }: {
  actions: ExplorerStartActions
  place: ExplorerPlace | null
  places: ExplorerVault[]
  setPlace(place: ExplorerPlace): void
  newFolder(place: ExplorerPlace): void
  busy: boolean
  open: boolean
  run(action: () => Promise<string | null>): void
  error: string
}) {
  const [title, setTitle] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const start = (view: StartingView) => {
    if (!open || busy) return
    if (!title.trim()) { field.current?.focus(); return }
    run(() => actions.start(title.trim(), view, place))
  }
  useEffect(() => window.tw.app.onRunCommand(id => {
    const view = (Object.keys(WELCOME_COMMANDS) as StartingView[]).find(view => WELCOME_COMMANDS[view] === id)
    if (view) start(view)
  }), [title, open, busy, actions, place, run])

  if (!open) return null
  return <aside className="vx-start" aria-labelledby="vx-start-heading">
    <form onSubmit={event => { event.preventDefault(); start('slide') }}>
      <h2 id="vx-start-heading">Start a new talk</h2>
      <label htmlFor="vx-title">Name of the talk</label>
      <input id="vx-title" ref={field} placeholder="For example: Community garden update" value={title} disabled={busy}
        onChange={event => setTitle(event.currentTarget.value)} />
      {error && <p role="alert" className="vx-error">{error}</p>}
      <button className="vx-start-card" type="submit" disabled={busy}>
        <span className="vx-start-preview" aria-hidden>Three priorities</span>
        <span><strong><Square size={16} /> Start with a slide</strong><span>Type a title and a few points, as you would in PowerPoint.</span></span>
      </button>
      <button className="vx-start-card" type="button" onClick={() => start('outline')} disabled={busy}>
        <span className="vx-start-preview outline" aria-hidden>Next season</span>
        <span><strong><ListTree size={16} /> Start with an outline</strong><span>Type or paste an outline, then turn it into slides.</span></span>
      </button>
      <div className="vx-start-actions">
        <button className="vx-button" type="button" onClick={() => start('markdown')} disabled={busy}><CodeXml size={15} />Write in Markdown</button>
        <button className="vx-button" type="button" onClick={actions.importPowerPoint} disabled={busy}><FileInput size={15} />Import PowerPoint…</button>
      </div>
      <SaveLocation place={place} places={places} setPlace={setPlace} newFolder={newFolder} chooseVault={actions.chooseVault} busy={busy} />
    </form>
    <button className="vx-examples vx-button" type="button" disabled={busy} onClick={() => run(actions.examples)}>
      <GraduationCap size={17} />Open the example talks
    </button>
  </aside>
}

function SaveLocation({ place, places, setPlace, newFolder, chooseVault, busy }: {
  place: ExplorerPlace | null
  places: ExplorerVault[]
  setPlace(place: ExplorerPlace): void
  newFolder(place: ExplorerPlace): void
  chooseVault(): void
  busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [space, setSpace] = useState({ above: false, height: 0 })
  const folders = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const current = places.find(item => item.vault.id === place?.vaultId)
  const close = (focus: boolean) => { setOpen(false); if (focus) toggle.current?.focus() }
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open])
  useLayoutEffect(() => {
    if (!open || filter) return
    const list = folders.current
    const selected = list?.querySelector('[aria-pressed="true"]')
    if (list && selected) {
      const overflow = selected.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom
      list.scrollTop += Math.max(0, overflow)
    }
  }, [open, filter, place?.folder])
  const pick = (choice: ExplorerPlace) => { setPlace(choice); close(true) }
  const shown = current?.folders.filter(path => path.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) ?? []
  return <div className="vx-save" ref={box} onKeyDown={event => {
    // SCAN_IGNORE: Escape dismisses the local save-location popover.
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
  }}>
    <span id="vx-save-label">New talk is saved in</span>
    <button className="vx-button vx-save-trigger" type="button" aria-label="Change save location" aria-describedby="vx-save-label"
      ref={toggle} aria-expanded={open} aria-controls={open ? 'vx-save-choices' : undefined} disabled={busy}
      title={current ? [current.vault.root, place?.folder].filter(Boolean).join('/') : undefined}
      onClick={() => {
        const anchor = box.current?.getBoundingClientRect()
        const panel = box.current?.closest('.vx-start')?.getBoundingClientRect()
        if (!open && anchor && panel) {
          const before = anchor.top - panel.top
          const after = panel.bottom - anchor.bottom
          const above = after < 440 && before > after
          setSpace({ above, height: Math.max(0, (above ? before : after) - 8) })
        }
        setFilter(''); setOpen(!open)
      }}>
      {current ? <VaultBadge vault={current.vault} size={28} /> : <HardDrive size={23} />}
      <span><strong>{current?.vault.name ?? (places.length ? 'Choose a vault' : 'TalkWeaver')}</strong>
        <small><Folder size={14} /> {place?.folder ? place.folder.split('/').join(' › ') : current ? 'Top of the vault' : places.length ? 'No vault available' : 'Documents › TalkWeaver'}</small></span>
      <span className="vx-save-change">Change <ChevronDown size={14} /></span>
    </button>
    {open && <div className={`vx-popover${space.above ? ' vx-popover-above' : ''}`} style={{ maxHeight: space.height ? `min(30rem, ${space.height}px)` : undefined }} id="vx-save-choices" role="group" aria-label="Save location">
      {current && place && <>
        <h3>Folder in {current.vault.name}</h3>
        <input type="search" aria-label="Find a folder" placeholder="Find a folder" value={filter} autoFocus
          onChange={event => setFilter(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />
        <div className="vx-save-folders" ref={folders}>
          {!filter.trim() && <button type="button" aria-pressed={!place.folder} onClick={() => pick({ ...place, folder: '' })}>
            <VaultBadge vault={current.vault} />Top of the vault{!place.folder && <Check size={15} />}
          </button>}
          {shown.map(path => <button key={path} type="button" aria-pressed={path === place.folder} title={path}
            style={{ paddingInlineStart: Math.min(4, path.split('/').length) * 12 }}
            onClick={() => pick({ ...place, folder: path })}><Folder size={16} />{leafName(path)}{path === place.folder && <Check size={15} />}</button>)}
          {filter.trim() && shown.length === 0 && <p>No folders match.</p>}
        </div>
        <button type="button" className="vx-add-folder" onClick={() => { close(false); newFolder(place) }}><FolderPlus size={16} />
          {place.folder ? `New folder in ${leafName(place.folder)}…` : 'New folder…'}</button>
      </>}
      <h3>{current ? 'Save in another vault' : 'Save in a vault'}</h3>
      {places.filter(item => item !== current).map(item => <button type="button" key={item.vault.id} aria-label={item.vault.name}
        disabled={!item.vault.open || !!item.vault.unavailable} onClick={() => pick({ vaultId: item.vault.id, folder: '' })}>
        <VaultBadge vault={item.vault} />{item.vault.name}<small>{item.vault.unavailable ? 'Unavailable' : !item.vault.open ? 'Closed' : `${item.talks.length} talks`}</small></button>)}
      <button type="button" onClick={() => { close(false); chooseVault() }}><HardDrive size={16} />Choose a new vault…</button>
    </div>}
  </div>
}
