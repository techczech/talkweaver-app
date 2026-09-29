import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { FolderOpenState } from './model'

// Folder open/closed memory for the shared tree (ADR-0029 §3, §4): ONE store that the file list
// and the slide picker's Files tab both read and write, so a folder opened in one is open in the
// other, and both survive a restart. Persisted in main (<userData>/config.json,
// `talkListFolders`, one map per vault); mirrored here so a remount (sidebar tab switch, the
// picker reopening) draws folders as left at once instead of waiting for the IPC read.
//
// Only the user's choices are held (vault-relative path → open); a folder without one takes
// the default in the tree model: closed, in both surfaces.

type Snapshot = { vaultRoot: string; open: FolderOpenState }

const EMPTY: FolderOpenState = {}
let snapshot: Snapshot = { vaultRoot: '', open: EMPTY }
// Choices made since the last read was requested: they win over the stored map when it lands.
let changesSinceRead: FolderOpenState = {}
let readSeq = 0
const listeners = new Set<() => void>()

function publish(next: Snapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Read the stored choices for `vaultRoot` (each consumer's mount asks, as the file list always
 *  did); a choice made before the read lands wins over the stored one. */
function readStored(vaultRoot: string): void {
  if (snapshot.vaultRoot !== vaultRoot) publish({ vaultRoot, open: EMPTY })
  changesSinceRead = {}
  const seq = ++readSeq
  const read = window.tw?.talks?.folderState
  if (!read) return
  read()
    .then((stored) => {
      if (seq !== readSeq || snapshot.vaultRoot !== vaultRoot || !stored || typeof stored !== 'object') return
      publish({ vaultRoot, open: { ...stored, ...changesSinceRead } })
    })
    .catch(() => { /* no stored state: defaults apply */ })
}

/** Record open/closed choices for folders of `vaultRoot`: every consumer redraws at once and the
 *  choice is persisted. */
export function chooseFolders(vaultRoot: string, changes: FolderOpenState): void {
  if (Object.keys(changes).length === 0) return
  Object.assign(changesSinceRead, changes)
  const base = snapshot.vaultRoot === vaultRoot ? snapshot.open : EMPTY
  publish({ vaultRoot, open: { ...base, ...changes } })
  window.tw?.talks?.setFolderState?.(changes)?.catch(() => { /* kept for this session */ })
}

/** The shared folder choices for `vaultRoot` and the function that changes them. */
export function useFolderMemory(vaultRoot: string): [FolderOpenState, (changes: FolderOpenState) => void] {
  useEffect(() => { readStored(vaultRoot) }, [vaultRoot])
  const current = useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
  const choose = useCallback((changes: FolderOpenState) => chooseFolders(vaultRoot, changes), [vaultRoot])
  return [current.vaultRoot === vaultRoot ? current.open : EMPTY, choose]
}
