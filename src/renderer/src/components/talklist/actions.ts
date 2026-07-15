import type { TalkInfo } from '../../../../preload/index'
import { topicOf } from '../talkTreeNav'
import { notify } from '../../lib/notify'
import { talkKey } from './model'
import type { TalkAction, FolderAction } from './menus'

// Vault operations for the Talks browser. Every op toasts on failure — a silent no-op
// re-render reads as "the click didn't register" (ADR-0023 never fail silently).

export type Prompt = { label: string; initial: string; cta: string; onSubmit: (value: string) => void }
export type Confirm = { label: string; cta: string; danger?: boolean; onConfirm: () => void }

interface Deps {
  talks: TalkInfo[]
  vaultRoot: string
  activeTalk: TalkInfo | null
  onSelectTalk: (talk: TalkInfo) => void
  onDeletedTalk?: (outlinePath: string) => void
  onRefresh: () => void
  onNewTalk?: (topic?: string) => void
  /** Open the per-talk Metadata panel (ADR-0036) for this talk. */
  onOpenMetadata?: (talk: TalkInfo) => void
  flushActive?: () => Promise<void>
  setPrompt: (p: Prompt | null) => void
  setConfirm: (c: Confirm | null) => void
  setMenu: (m: null) => void
  setMoveMenu: (m: { talk: TalkInfo; x: number; y: number } | null) => void
  setFocusKey: (key: string) => void
}

export function useTalkActions(deps: Deps) {
  const {
    talks, vaultRoot, activeTalk, onSelectTalk, onDeletedTalk, onRefresh, onNewTalk,
    onOpenMetadata, flushActive, setPrompt, setConfirm, setMenu, setMoveMenu, setFocusKey
  } = deps

  function startRename(talk: TalkInfo): void {
    setPrompt({ label: `Rename “${talk.title}” to`, initial: talk.title, cta: 'Rename', onSubmit: (v) => { void doRename(talk, v) } })
  }
  async function doRename(talk: TalkInfo, newTitle: string): Promise<void> {
    const wasActive = activeTalk?.outlinePath === talk.outlinePath
    // Flush the editor's pending autosave BEFORE the folder moves — a late write to the old
    // path would recreate it and the two copies would drift (2026-07-05 hazard class).
    if (wasActive) await flushActive?.()
    const res = await window.tw.vault.renameTalk(talk.outlinePath, newTitle)
    if (res && 'error' in res) {
      if (res.error === 'open-elsewhere') notify(`“${talk.title}” is open in another window — close it there first.`, 'error')
      else if (res.error === 'target-exists') notify(`Couldn’t rename — a talk folder for “${newTitle}” already exists.`, 'error')
      else notify(`Couldn’t rename “${talk.title}”.`, 'error')
      return
    }
    if (!res) { notify(`Couldn’t rename “${talk.title}”.`, 'error'); return }
    onRefresh()
    setFocusKey(talkKey(res.outlinePath))
    // Re-select so the editor reloads from the new path and the window claim moves with it.
    if (wasActive) onSelectTalk(res)
  }
  function startDuplicate(talk: TalkInfo): void {
    setPrompt({ label: `Duplicate “${talk.title}” as`, initial: `${talk.title} (copy)`, cta: 'Duplicate', onSubmit: (v) => void doClone(talk, v) })
  }
  async function doClone(talk: TalkInfo, newTitle: string): Promise<void> {
    const cloned = await window.tw.vault.cloneTalk(talk.outlinePath, newTitle)
    onRefresh()
    if (cloned) onSelectTalk(cloned)
    else notify(`Couldn’t duplicate “${talk.title}”.`, 'error')
  }
  function startDelete(talk: TalkInfo): void {
    setConfirm({ label: `Move “${talk.title}” to the Bin? (recoverable from Finder)`, cta: 'Delete', danger: true, onConfirm: () => void doDeleteTalk(talk) })
  }
  async function doDeleteTalk(talk: TalkInfo): Promise<void> {
    const ok = await window.tw.vault.deleteTalk(talk.outlinePath)
    if (!ok) { notify(`Couldn’t move “${talk.title}” to the Bin.`, 'error'); return }
    onDeletedTalk?.(talk.outlinePath)
    onRefresh()
  }
  function startMove(talk: TalkInfo, at: { x: number; y: number }): void {
    setMenu(null)
    setMoveMenu({ talk, x: at.x, y: at.y })
  }
  async function doMove(talk: TalkInfo, destTopic: string): Promise<void> {
    if (topicOf(talk, vaultRoot) === destTopic) return
    const moved = await window.tw.vault.moveTalk(talk.outlinePath, destTopic)
    onRefresh()
    if (moved) setFocusKey(talkKey(moved.outlinePath))
    if (moved && activeTalk?.outlinePath === talk.outlinePath) onSelectTalk(moved)
    if (!moved) notify(`Couldn’t move “${talk.title}” — a talk of that name may already live there.`, 'error')
  }
  async function doNewFolder(name: string, parentRel: string): Promise<void> {
    const created = await window.tw.vault.createFolder(name, parentRel)
    if (created == null) notify(`Couldn’t create the folder “${name}”.`, 'error')
    onRefresh()
  }
  async function doRenameFolder(topic: string, newName: string): Promise<void> {
    const renamed = await window.tw.vault.renameFolder(topic, newName)
    if (renamed == null) notify(`Couldn’t rename the folder — a folder called “${newName}” may already exist.`, 'error')
    onRefresh()
  }
  async function doDeleteFolder(topic: string): Promise<void> {
    const ok = await window.tw.vault.deleteFolder(topic)
    if (!ok) notify('Couldn’t move the folder to the Bin.', 'error')
    onRefresh()
  }
  function onTalkAction(talk: TalkInfo, action: TalkAction, at: { x: number; y: number }): void {
    setMenu(null)
    if (action === 'open') onSelectTalk(talk)
    else if (action === 'rename') startRename(talk)
    else if (action === 'duplicate') startDuplicate(talk)
    else if (action === 'move') startMove(talk, at)
    else if (action === 'metadata') onOpenMetadata?.(talk)
    else if (action === 'reveal') void window.tw?.shell?.showInFolder?.(talk.outlinePath)
    else if (action === 'open-file') void window.tw?.shell?.openPath?.(talk.outlinePath)
    else if (action === 'copy-path') {
      void navigator.clipboard.writeText(talk.outlinePath)
        .then(() => notify('Path copied', 'success'))
        .catch(() => notify('Couldn’t copy the path to the clipboard.', 'error'))
    }
    else if (action === 'delete') startDelete(talk)
  }
  function onFolderAction(topic: string, action: FolderAction): void {
    setMenu(null)
    const leaf = topic.split('/').pop() || topic
    if (action === 'new-talk') onNewTalk?.(topic)
    else if (action === 'new-subfolder') setPrompt({ label: `New subfolder inside “${leaf}”`, initial: '', cta: 'Create', onSubmit: (v) => void doNewFolder(v, topic) })
    else if (action === 'rename') setPrompt({ label: `Rename folder “${leaf}” to`, initial: leaf, cta: 'Rename', onSubmit: (v) => void doRenameFolder(topic, v) })
    else if (action === 'delete') {
      const count = talks.filter((t) => topicOf(t, vaultRoot) === topic || topicOf(t, vaultRoot).startsWith(topic + '/')).length
      setConfirm({
        label: count > 0
          ? `Move folder “${leaf}” and its ${count} talk${count === 1 ? '' : 's'} to the Bin? (recoverable from Finder)`
          : `Move folder “${leaf}” to the Bin? (recoverable from Finder)`,
        cta: 'Delete', danger: true, onConfirm: () => void doDeleteFolder(topic)
      })
    }
  }

  return { startRename, startDuplicate, startDelete, startMove, doMove, doNewFolder, onTalkAction, onFolderAction }
}
