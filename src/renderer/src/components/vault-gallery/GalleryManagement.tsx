import ManagementLayer from './ManagementLayer'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Clipboard, CopyPlus, Copy, Ellipsis, FileText, FolderInput, FolderPlus, Globe, Pencil, Plus, Presentation, Trash2, Check } from 'lucide-react'
import type { TalkInfo, VaultView } from '../../../../preload'
import { useTalkActions, type Prompt, type Confirm } from '../talklist/actions'
import { PromptModal, ConfirmModal } from '../talklist/modals'
import { topicOf } from '../talkTreeNav'
import type { GalleryTalk } from '../../../../shared/vault-gallery'
import { inspectOnlyPath } from '../../../../shared/vault-gallery-browse'
import { UI } from './galleryItems'

export interface GalleryManagementProps {
  talks: TalkInfo[]
  vaults: VaultView[]
  activeTalk: TalkInfo | null
  foldersByVault: Record<string, string[]>
  leaveActive(): Promise<boolean>
  onRefresh(): Promise<void>
  /** Re-checks which vaults are reachable (the focus path), without listing talks. */
  onRecheck?(): Promise<void>
  onSelectTalk(talk: TalkInfo, movedFrom?: string): Promise<boolean>
  onDeletedTalk(path: string): void
  onNewTalk(topic: string, vaultId: string): void
  onAddVault(): void
  onEditVault(id: string): void
  onSetVaultOpen(id: string, open: boolean): Promise<void>
}
/** Without a management seam (a read-only host) nothing is writable: only Open, Handouts and Copy location remain. */
export const NO_MANAGEMENT: GalleryManagementProps = { talks: [], vaults: [], activeTalk: null, foldersByVault: {}, leaveActive: async () => true, onRefresh: async () => { }, onRecheck: async () => { }, onSelectTalk: async () => false, onDeletedTalk: () => { }, onNewTalk: () => { }, onAddVault: () => { }, onEditVault: () => { }, onSetVaultOpen: async () => { } }
export type ManagementSelection = { kind: 'talk'; talk: GalleryTalk } | { kind: 'folder'; path: string; category: boolean } | { kind: 'entry' } | null
export interface MenuRequest { id: number; key: string; x: number; y: number }
export type FolderOperation = { kind: 'rename' | 'delete'; path: string }
interface Props {
  busy?: boolean
  /** The toolbar group shows only while the vault is browsable; the dialogs below it stay mounted through reloads. */
  toolbar?: boolean
  /** A right-click: opens the actions menu for the row at the pointer. `key` names the row and scope it was asked for. */
  menuRequest?: MenuRequest | null
  /** Names the selected row and the scope it is in; the menu is shown only while this still equals the key it was opened for. */
  menuKey?: string | null
  management: GalleryManagementProps
  vaultId: string | null
  /** Where New talk and New folder create: the folder you are in; All talks creates at the vault root. */
  folder: string
  selection: ManagementSelection
  openTalk(talk: GalleryTalk): void
  openFolder(path: string): void
  showHandouts(talk: GalleryTalk): void
  canPreview: boolean
  preview(): void
  copyLocation(): void
  resolve(talk: GalleryTalk): Promise<TalkInfo | null>
  reconcile(result: { from?: TalkInfo; talk?: TalkInfo; folder?: string; op?: FolderOperation | null }): void
  /** Runs under the gallery's one lock; false when something else is already running (nothing was started). */
  run(action: () => Promise<void>): boolean
}
interface BtnProps { label: string; icon: ReactNode; onClick(): void; danger?: boolean; primary?: boolean; secondary?: boolean; disabled?: boolean }
/** Module scope on purpose: a component declared inside the render would remount (and lose focus) on every re-render. */
const Btn = ({ busy, label, icon, onClick, danger, primary, secondary, disabled }: BtnProps & { busy: boolean }) =>
  <button className={`vg-tbtn ${primary ? 'primary' : ''} ${danger ? 'danger' : ''} ${secondary ? 'sec' : ''}`} disabled={busy || disabled} onClick={onClick}>{icon}{label}</button>
/** The contextual toolbar group and the management sheets. Every command goes through the existing guarded talk actions. */
export default function GalleryManagement({ management: m, vaultId, folder, selection, resolve, reconcile, run, busy = false, toolbar = true, menuRequest = null, menuKey = null, openTalk, openFolder, showHandouts, canPreview, preview, copyLocation }: Props) {
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [moving, setMoving] = useState<TalkInfo | null>(null)
  const [destination, setDestination] = useState('')
  const [menu, setMenu] = useState<{ key: string; x: number | null; y: number } | null>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const vault = m.vaults.find(v => v.id === vaultId)
  const writable = !!vault?.open && !vault.unavailable
  const category = (!folder || (m.foldersByVault[vaultId ?? ''] ?? []).includes(folder)) && !inspectOnlyPath(folder)
  const folderOp = useRef<FolderOperation | null>(null)
  const actions = useTalkActions({ ...m, onNewTalk: (topic, id) => { if (id) m.onNewTalk(topic ?? '', id) }, onOperationResult: result => reconcile({ ...result, op: result.folder === undefined ? null : folderOp.current }), setPrompt, setConfirm, setMenu: () => { }, setMoveMenu: () => { }, setFocusKey: () => { } })
  const act = (kind: 'rename' | 'duplicate' | 'delete' | 'move', talk: GalleryTalk) => { run(async () => {
    const resolved = await resolve(talk)
    if (!resolved) throw new Error('This talk is no longer available. Choose it again.')
    if (kind === 'move') { setMoving(resolved); setDestination(topicOf(resolved, vault?.root ?? '')) }
    else if (kind === 'rename') actions.startRename(resolved)
    else if (kind === 'duplicate') actions.startDuplicate(resolved)
    else actions.startDelete(resolved)
  }) }
  const folderAction = (path: string, kind: 'rename' | 'delete') => { folderOp.current = { kind, path }; actions.onFolderAction(path, kind, vaultId ?? undefined) }
  useEffect(() => { if (menuRequest) setMenu({ key: menuRequest.key, x: menuRequest.x, y: menuRequest.y }) }, [menuRequest?.id])
  // The menu belongs to one row in one scope: choosing another row or moving folder closes it, and so does any running action.
  const shown = !!menu && !busy && menu.key === menuKey
  useEffect(() => { if (menu && (busy || menu.key !== menuKey)) setMenu(null) }, [menu, busy, menuKey])
  const menuEl = useRef<HTMLDivElement | null>(null)
  // Focus enters once for each menu opened; a later re-render never pulls it back.
  useEffect(() => { if (shown) menuEl.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus() }, [shown, menu])
  const folderManaged = selection?.kind === 'folder' && selection.category && writable && !inspectOnlyPath(selection.path)
  // A press anywhere else closes the menu and still reaches what was pressed (another row, a button).
  useEffect(() => {
    if (!shown) return
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!menuEl.current?.contains(t) && !moreRef.current?.contains(t)) setMenu(null) }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [shown])
  const closeMenu = (refocus = true) => { setMenu(null); if (refocus) moreRef.current?.focus() }
  const item = (label: string, icon: ReactNode, onClick: () => void, opts: { hint?: string; danger?: boolean; disabled?: boolean } = {}) =>
    <button role="menuitem" disabled={opts.disabled || busy} className={opts.danger ? 'danger' : ''} onClick={() => { closeMenu(false); onClick() }}>{icon}{label}{opts.hint && <kbd>{opts.hint}</kbd>}</button>
  const rule = (key: string) => <hr key={key} role="separator" />
  // At the pointer for a right-click (kept inside the window), under the More button otherwise.
  // The toolbar is a layout container, so the menu is drawn in the gallery panel itself and placed from the panel's own box.
  const panel = shown ? moreRef.current?.closest<HTMLElement>('.vault-gallery') ?? null : null
  const box = panel?.getBoundingClientRect()
  const place = box && menu ? (() => {
    const anchor = menu.x == null ? moreRef.current?.getBoundingClientRect() : null
    const x = (anchor ? anchor.left : menu.x!) - box.left, y = (anchor ? anchor.bottom + 4 : menu.y) - box.top
    return { left: Math.max(8, Math.min(x, box.width - 292)), top: Math.max(8, Math.min(y, box.height - 360)) }
  })() : undefined
  return <>
    {toolbar && <>
    {selection?.kind === 'talk' && <>
      <Btn busy={busy} primary label={UI.openTalk} icon={<FileText size={16} />} onClick={() => openTalk(selection.talk)} />
      <Btn busy={busy} secondary label={UI.handouts} icon={<Globe size={16} />} onClick={() => showHandouts(selection.talk)} />
      {writable && <>
        <span className="vg-vsep sec" />
        <Btn busy={busy} secondary label={UI.rename} icon={<Pencil size={16} />} onClick={() => act('rename', selection.talk)} />
        <Btn busy={busy} secondary label={UI.duplicate} icon={<Copy size={16} />} onClick={() => act('duplicate', selection.talk)} />
        <Btn busy={busy} secondary label={UI.move} icon={<FolderInput size={16} />} onClick={() => act('move', selection.talk)} />
        <Btn busy={busy} secondary danger label={UI.bin} icon={<Trash2 size={16} />} onClick={() => act('delete', selection.talk)} />
      </>}
    </>}
    {selection?.kind === 'folder' && <>
      <Btn busy={busy} primary label={UI.openFolder} icon={<FolderInput size={16} />} onClick={() => openFolder(selection.path)} />
      {folderManaged && <>
        <span className="vg-vsep sec" />
        <Btn busy={busy} secondary label={UI.rename} icon={<Pencil size={16} />} onClick={() => folderAction(selection.path, 'rename')} />
        <Btn busy={busy} secondary danger label={UI.bin} icon={<Trash2 size={16} />} onClick={() => folderAction(selection.path, 'delete')} />
      </>}
    </>}
    {!selection && writable && category && vault && <>
      <Btn busy={busy} primary label={UI.newTalk} icon={<Plus size={16} />} onClick={() => m.onNewTalk(folder, vault.id)} />
      <Btn busy={busy} label={UI.newFolder} icon={<FolderPlus size={16} />} onClick={() => setPrompt({ label: `New folder in ${vault.name} / ${folder || 'root'}`, initial: '', cta: 'Create', onSubmit: async name => { await actions.doNewFolder(name, folder, vault.id); reconcile({}) } })} />
    </>}
    {/* Nothing inspect-only has a menu: its one action is in the toolbar and Copy location is in Details. */}
    {selection && selection.kind !== 'entry' && !(selection.kind === 'folder' && inspectOnlyPath(selection.path)) ? <span className="vg-menuwrap">
      <button ref={moreRef} className="vg-tbtn more" aria-label={UI.more} aria-haspopup="menu" aria-expanded={shown} disabled={busy} onClick={() => setMenu(v => v ? null : { key: menuKey ?? '', x: null, y: 0 })}><Ellipsis size={16} /></button>
      {shown && panel && createPortal(<>
      <div className="vg-menu" role="menu" aria-label={selection.kind === 'talk' ? 'Actions for this talk' : 'Actions for this folder'} style={place} onKeyDown={e => {
        // SCAN_IGNORE: local menu keyboard handling, not an app command.
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu() }
        // Tab leaves the menu: closed, focus on ⋯, and the key then moves on from there as usual.
        else if (e.key === 'Tab') closeMenu()
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')).filter(el => el.getClientRects().length)
          const at = items.indexOf(document.activeElement as HTMLElement)
          items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
        }
      }} ref={menuEl}>
        <h4>{selection.kind === 'talk' ? 'Actions for this talk' : 'Actions for this folder'}</h4>
        {selection.kind === 'talk' && <>
          {item(UI.openTalk, <FileText size={16} aria-hidden />, () => openTalk(selection.talk), { hint: '↩' })}
          {item('View handouts', <Globe size={16} aria-hidden />, () => showHandouts(selection.talk))}
          {item(UI.previewTitle, <Presentation size={16} aria-hidden />, preview, { disabled: !canPreview, hint: 'Space' })}
          {item(UI.copyLocation, <Clipboard size={16} aria-hidden />, copyLocation)}
          {writable && <>{rule('a')}
            {item(UI.rename, <Pencil size={16} aria-hidden />, () => act('rename', selection.talk))}
            {item(UI.duplicate, <CopyPlus size={16} aria-hidden />, () => act('duplicate', selection.talk))}
            {item('Move within this vault…', <FolderInput size={16} aria-hidden />, () => act('move', selection.talk))}
            {rule('b')}
            {item(UI.bin, <Trash2 size={16} aria-hidden />, () => act('delete', selection.talk), { danger: true })}</>}
        </>}
        {selection.kind === 'folder' && <>
          {item(UI.openFolder, <FolderInput size={16} aria-hidden />, () => openFolder(selection.path), { hint: '↩' })}
          {item(UI.copyLocation, <Clipboard size={16} aria-hidden />, copyLocation)}
          {folderManaged && <>{rule('a')}{item(UI.rename, <Pencil size={16} aria-hidden />, () => folderAction(selection.path, 'rename'))}{rule('b')}{item(UI.bin, <Trash2 size={16} aria-hidden />, () => folderAction(selection.path, 'delete'), { danger: true })}</>}
        </>}
      </div></>, panel)}
    </span> : null}
    </>}
    {prompt && <ManagementLayer onDismiss={() => setPrompt(null)}><PromptModal {...prompt} onCancel={() => setPrompt(null)} onSubmit={value => { if (!value.trim()) return; const fn = prompt.onSubmit; if (run(async () => { await fn(value.trim()) })) setPrompt(null) }} /></ManagementLayer>}
    {confirm && <ManagementLayer onDismiss={() => setConfirm(null)}><ConfirmModal {...confirm} onCancel={() => setConfirm(null)} onConfirm={() => { const fn = confirm.onConfirm; if (run(async () => { await fn() })) setConfirm(null) }} /></ManagementLayer>}
    {/* SCAN_IGNORE: Escape dismisses the local move dialog. */}
    {moving && <ManagementLayer onDismiss={() => setMoving(null)}><div role="dialog" aria-modal="true" aria-label="Move talk within this vault" className="vg-sheet" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setMoving(null) } }}>
      <h2>Move within this vault</h2>
      <p className="vg-sb">“{moving.title}” moves with all its files. Choose a folder in {vault?.name}.</p>
      <div className="vg-picker" role="listbox" aria-label="Destination folder">{[...new Set(['', ...(m.foldersByVault[vaultId ?? ''] ?? []).filter(f => !inspectOnlyPath(f))])].map(f =>
        <button key={f} role="option" aria-selected={destination === f} className={`vg-pick ${destination === f ? 'sel' : ''}`} onClick={() => setDestination(f)} autoFocus={destination === f}><span className="vg-tx">{f || 'Vault root'}</span>{f === topicOf(moving, vault?.root ?? '') && <span className="vg-ct">Currently here</span>}{destination === f && <Check size={14} aria-hidden />}</button>)}</div>
      <div className="vg-foot"><button className="vg-tbtn" onClick={() => setMoving(null)}>Cancel</button><button className="vg-tbtn primary" onClick={() => { const talk = moving; if (run(() => actions.doMove(talk, destination))) setMoving(null) }}>Move here</button></div>
    </div></ManagementLayer>}
  </>
}
