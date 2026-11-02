import type { TalkInfo, VaultView } from '../../../../preload/index'
import { rebaseTalk, topicOf } from '../talkTreeNav'
import { notify } from '../../lib/notify'
import { commandRan } from '../../commands/command-ran'
import { talkKey } from './model'
import type { OpenInNewWindowTarget } from '../../../../shared/open-in-new-window'
import type { TalkAction, FolderAction } from './menus'

// Vault operations for the Talks browser. Every op toasts on failure — a silent no-op
// re-render reads as "the click didn't register" (ADR-0023 never fail silently).

export type Prompt = { label: string; initial: string; cta: string; onSubmit: (value: string) => void | Promise<void> }
export type Confirm = { label: string; cta: string; danger?: boolean; onConfirm: () => void | Promise<void> }

interface Deps {
  talks: TalkInfo[]
  /** Every vault: a talk or folder is acted on within its own vault. */
  vaults: VaultView[]
  activeTalk: TalkInfo | null
  onSelectTalk: (talk: TalkInfo, movedFrom?: string) => void | Promise<boolean>
  onDeletedTalk?: (outlinePath: string) => void
  onRefresh: () => void | Promise<void>
  onOperationResult?: (result: { from?: TalkInfo; talk?: TalkInfo; folder?: string }) => void
  onNewTalk?: (topic?: string, vaultId?: string) => void
  /** Open the per-talk Metadata panel (ADR-0036) for this talk. */
  onOpenMetadata?: (talk: TalkInfo) => void
  flushActive?: () => Promise<void>
  /** The outline external-change guard's leave check (App → WorkspaceLayout): flushes the active talk
   *  and, while its file differs from the editor, holds behind the sheet until the person has chosen.
   *  False when they chose Stay here. Run before any app-side move of the active talk. */
  leaveActive?: () => Promise<boolean>
  setPrompt: (p: Prompt | null) => void
  setConfirm: (c: Confirm | null) => void
  setMenu: (m: null) => void
  setMoveMenu: (m: { talk: TalkInfo; x: number; y: number } | null) => void
  setFocusKey: (key: string) => void
}

export function useTalkActions(deps: Deps) {
  const {
    talks, vaults, activeTalk, onSelectTalk, onDeletedTalk, onRefresh, onNewTalk,
    onOpenMetadata, flushActive, leaveActive, onOperationResult, setPrompt, setConfirm, setMenu, setMoveMenu, setFocusKey
  } = deps

  // Before the app moves, renames or bins the active talk (or a folder holding it): pending typing is
  // flushed to the old path and any changed-on-disk difference is settled first, so nothing typed is
  // left behind at a path that is about to go. False: the person chose Stay here (nothing moves).
  async function settleActive(): Promise<boolean> {
    if (activeTalk) {
      const recovered = await window.tw.windows.recoverMovedTalk(activeTalk.outlinePath)
      if (recovered.kind === 'revoked') {
        window.dispatchEvent(new CustomEvent('tw-retire-moved-editor', {detail:{from:activeTalk.outlinePath}}))
        return false
      }
      if (recovered.kind === 'recoverable' && recovered.talk.outlinePath !== activeTalk.outlinePath) {
        await onSelectTalk(inVaultOf(activeTalk, recovered.talk), activeTalk.outlinePath)
        return false
      }
    }
    if (leaveActive) return leaveActive()
    await flushActive?.()
    return true
  }
  const firstOpen = vaults.find((v) => v.open)
  const vaultIdOf = (talk: TalkInfo): string | undefined => talk.vaultId ?? firstOpen?.id
  const rootOf = (talk: TalkInfo): string => vaults.find((v) => v.id === vaultIdOf(talk))?.root ?? firstOpen?.root ?? ''
  /** The talk as main returned it, with the vault it stays in. */
  const inVaultOf = (from: TalkInfo, moved: TalkInfo): TalkInfo => (from.vaultId ? { ...moved, vaultId: from.vaultId } : moved)
  const activeInside = (topic: string, vaultId?: string): boolean => {
    if (!activeTalk) return false
    if ((vaultId ?? firstOpen?.id) !== vaultIdOf(activeTalk)) return false
    const t = topicOf(activeTalk, rootOf(activeTalk))
    return t === topic || t.startsWith(topic + '/')
  }

  function startRename(talk: TalkInfo): void {
    setPrompt({ label: `Rename “${talk.title}” to`, initial: talk.title, cta: 'Rename', onSubmit: (v) => doRename(talk, v) })
  }
  async function doRename(talk: TalkInfo, newTitle: string): Promise<void> {
    const wasActive = activeTalk?.outlinePath === talk.outlinePath
    // Flush the editor's pending autosave BEFORE the folder moves — a late write to the old
    // path would recreate it and the two copies would drift (2026-07-05 hazard class).
    if (wasActive && !(await settleActive())) return
    const renamed = await window.tw.vault.renameTalk(talk.outlinePath, newTitle)
    const res = renamed && !('error' in renamed) ? inVaultOf(talk, renamed) : renamed
    if (res && 'error' in res) {
      if (res.error === 'open-elsewhere') notify(`“${talk.title}” is open in another window — close it there first.`, 'error')
      else if (res.error === 'target-exists') notify(`Couldn’t rename — a talk folder for “${newTitle}” already exists.`, 'error')
      else notify(`Couldn’t rename “${talk.title}”.`, 'error')
      return
    }
    if (!res) { notify(`Couldn’t rename “${talk.title}”.`, 'error'); return }
    commandRan('browser.rename', { outlinePath: talk.outlinePath })
    if (wasActive && await onSelectTalk(res, talk.outlinePath) === false) throw new Error("Moved talk adoption refused; keep this window open for recovery")
    await Promise.resolve().then(onRefresh).catch(() => notify("Talk renamed. Refresh failed; reopen the gallery to retry.", "error"))
    setFocusKey(talkKey(res.outlinePath))
    // Re-select so the editor reloads from the new path and the window claim moves with it.
    onOperationResult?.({ from: talk, talk: res })

  }
  function startDuplicate(talk: TalkInfo): void {
    setPrompt({ label: `Duplicate “${talk.title}” as`, initial: `${talk.title} (copy)`, cta: 'Duplicate', onSubmit: (v) => doClone(talk, v) })
  }
  async function doClone(talk: TalkInfo, newTitle: string): Promise<void> {
    if (activeTalk?.outlinePath === talk.outlinePath && !(await settleActive())) return
    const cloned = await window.tw.vault.cloneTalk(talk.outlinePath, newTitle)
    if (cloned) { await onRefresh(); const copy = inVaultOf(talk, cloned); onOperationResult?.({ talk: copy }); commandRan('browser.duplicate', { outlinePath: talk.outlinePath }); await onSelectTalk(copy) }
    else notify(`Couldn’t duplicate “${talk.title}”.`, 'error')
  }
  function startDelete(talk: TalkInfo): void {
    setConfirm({ label: `Move “${talk.title}” to the Bin? (recoverable from Finder)`, cta: 'Delete', danger: true, onConfirm: () => doDeleteTalk(talk) })
  }
  async function doDeleteTalk(talk: TalkInfo): Promise<void> {
    if (activeTalk?.outlinePath === talk.outlinePath && !(await settleActive())) return
    const ok = await window.tw.vault.deleteTalk(talk.outlinePath)
    if (!ok) { notify(`Couldn’t move “${talk.title}” to the Bin.`, 'error'); return }
    // Decision 12: main ticks Move talk to Bin only for a talk of the example vault (the path says which).
    commandRan('browser.delete-talk', { outlinePath: talk.outlinePath })
    onOperationResult?.({ from: talk })
    onDeletedTalk?.(talk.outlinePath)
    await onRefresh()
  }
  function startMove(talk: TalkInfo, at: { x: number; y: number }): void {
    setMenu(null)
    setMoveMenu({ talk, x: at.x, y: at.y })
  }
  async function doMove(talk: TalkInfo, destTopic: string): Promise<void> {
    if (topicOf(talk, rootOf(talk)) === destTopic) return
    if (activeTalk?.outlinePath === talk.outlinePath && !(await settleActive())) return
    const movedRaw = await window.tw.vault.moveTalk(talk.outlinePath, destTopic).catch(() => null)
      ?? await window.tw.windows.recoverMovedTalk(talk.outlinePath).then(r=>{if(r.kind === 'revoked') window.dispatchEvent(new CustomEvent('tw-retire-moved-editor',{detail:{from:talk.outlinePath}}));return r.kind === 'recoverable' ? r.talk : null})
    const moved = movedRaw ? inVaultOf(talk, movedRaw) : null
    if (!moved) { notify(`Couldn’t move “${talk.title}” — a talk of that name may already live there.`, 'error'); return }
    if (activeTalk?.outlinePath === talk.outlinePath && await onSelectTalk(moved, talk.outlinePath) === false) throw new Error("Moved talk adoption refused; keep this window open for recovery")
    await Promise.resolve().then(onRefresh).catch(() => notify("Talk moved. Refresh failed; reopen the gallery to retry.", "error"))
    onOperationResult?.({ from: talk, talk: moved })
    commandRan('browser.move-talk', { outlinePath: talk.outlinePath })
    setFocusKey(talkKey(moved.outlinePath))

  }
  async function doNewFolder(name: string, parentRel: string, vaultId?: string): Promise<void> {
    const created = await window.tw.vault.createFolder(name, parentRel, vaultId)
    if (created == null) { notify(`Couldn’t create the folder “${name}”.`, 'error'); return }
    await onRefresh()
  }
  async function doRenameFolder(topic: string, newName: string, vaultId?: string): Promise<void> {
    const moving = activeInside(topic, vaultId) ? activeTalk : null
    if (moving && !(await settleActive())) return
    const renamedRaw = await window.tw.vault.renameFolder(topic, newName, vaultId).catch(() => null)
    const recovered = moving ? await window.tw.windows.recoverMovedTalk(moving.outlinePath).then(r=>{if(r.kind === 'revoked') window.dispatchEvent(new CustomEvent('tw-retire-moved-editor',{detail:{from:moving!.outlinePath}}));return r.kind === 'recoverable' ? r.talk : null}) : null
    const renamed = renamedRaw ?? (recovered ? topicOf(recovered, rootOf(moving!)) : null)
    if (renamed == null) { notify(`Couldn’t rename the folder — a folder called “${newName}” may already exist.`, 'error'); return }
    const rebased = recovered ?? (moving ? rebaseTalk(moving, rootOf(moving), topic, renamed) : null)
    if (rebased && await onSelectTalk(rebased, moving!.outlinePath) === false) throw new Error("Moved folder adoption refused; keep this window open for recovery")
    await Promise.resolve().then(onRefresh).catch(() => notify("Folder renamed. Refresh failed; reopen the gallery to retry.", "error"))
    onOperationResult?.({ folder: renamed })
    if (rebased) setFocusKey(talkKey(rebased.outlinePath))
  }
  // The open talk inside the folder stays open: main reports its file as removed (the bar), so the
  // person chooses to let it go or save it again — its typing is never dropped or silently recreated.
  async function doDeleteFolder(topic: string, vaultId?: string): Promise<void> {
    if (activeInside(topic, vaultId) && !(await settleActive())) return
    const ok = await window.tw.vault.deleteFolder(topic, vaultId)
    if (!ok) { notify('Couldn’t move the folder to the Bin.', 'error'); return }
    onOperationResult?.({ folder: topic.split('/').slice(0,-1).join('/') })
    await onRefresh()
  }
  /** Right-click / palette "Open in new window". The current window is left as it is. */
  function openInNewWindow(target: OpenInNewWindowTarget): void {
    const open = window.tw?.windows?.openInNewWindow
    if (!open) { notify('Couldn’t open a new window.', 'error'); return }
    open(target)
      .then((res) => { if (!res?.ok) notify('Couldn’t open a new window.', 'error') })
      .catch(() => notify('Couldn’t open a new window.', 'error'))
  }
  function onTalkAction(talk: TalkInfo, action: TalkAction, at: { x: number; y: number }): void {
    setMenu(null)
    if (action === 'open') { onSelectTalk(talk); commandRan('browser.open-talk') }
    else if (action === 'open-new-window') openInNewWindow({ kind: 'talk', outlinePath: talk.outlinePath })
    else if (action === 'rename') startRename(talk)
    else if (action === 'duplicate') startDuplicate(talk)
    else if (action === 'move') startMove(talk, at)
    else if (action === 'metadata') onOpenMetadata?.(talk)
    else if (action === 'reveal') void window.tw?.shell?.showInFolder?.(talk.outlinePath)
    // The outline opens in TalkWeaver's own editor, never handed to whatever app the OS has for .md files.
    else if (action === 'open-file') { onSelectTalk(talk); commandRan('browser.open-talk') }
    else if (action === 'copy-path') {
      void navigator.clipboard.writeText(talk.outlinePath)
        .then(() => notify('Path copied', 'success'))
        .catch(() => notify('Couldn’t copy the path to the clipboard.', 'error'))
    }
    else if (action === 'delete') startDelete(talk)
  }
  function onFolderAction(topic: string, action: FolderAction, vaultId?: string): void {
    setMenu(null)
    const leaf = topic.split('/').pop() || topic
    if (action === 'open-new-window') openInNewWindow({ kind: 'folder', topic, vaultId })
    else if (action === 'new-talk') onNewTalk?.(topic, vaultId)
    else if (action === 'new-subfolder') setPrompt({ label: `New subfolder inside “${leaf}”`, initial: '', cta: 'Create', onSubmit: (v) => doNewFolder(v, topic, vaultId) })
    else if (action === 'rename') setPrompt({ label: `Rename folder “${leaf}” to`, initial: leaf, cta: 'Rename', onSubmit: (v) => doRenameFolder(topic, v, vaultId) })
    else if (action === 'delete') {
      const here = talks.filter((t) => vaultIdOf(t) === (vaultId ?? firstOpen?.id))
      const count = here.filter((t) => topicOf(t, rootOf(t)) === topic || topicOf(t, rootOf(t)).startsWith(topic + '/')).length
      setConfirm({
        label: count > 0
          ? `Move folder “${leaf}” and its ${count} talk${count === 1 ? '' : 's'} to the Bin? (recoverable from Finder)`
          : `Move folder “${leaf}” to the Bin? (recoverable from Finder)`,
        cta: 'Delete', danger: true, onConfirm: () => doDeleteFolder(topic, vaultId)
      })
    }
  }

  return { startRename, startDuplicate, startDelete, startMove, doMove, doNewFolder, onTalkAction, onFolderAction, openInNewWindow }
}
