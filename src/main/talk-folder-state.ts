// Talks browser folder open/closed state, persisted across restarts (ADR-0029 §3; Journey 2:
// "a folder he expanded before quitting is still expanded after relaunch").
//
// It lives in the app's persisted preferences (`<userData>/config.json`, key `talkListFolders`),
// one map per vault root: vault-relative folder path (`/`-separated) → true (open) | false
// (closed). Only the user's choices are stored; a folder without one takes the renderer's default:
// closed, in the file list and the slide picker's Files tab alike. Reads are tolerant: a malformed value, an absolute or
// `..` path, or a non-boolean choice is dropped, never an error. Paths the vault no longer has
// are kept (a folder may come back) and ignored by the renderer, which applies only the paths
// its tree holds.

export type FolderOpenState = Record<string, boolean>
/** The stored shape: vault root → that vault's folder choices. */
export type StoredFolderStates = Record<string, FolderOpenState>

export const TALK_FOLDER_STATE_KEY = 'talkListFolders'

const MAX_PATH_LENGTH = 1024

/** A vault-relative folder path the store accepts, or null. */
export function cleanFolderPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const path = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!path || path.length > MAX_PATH_LENGTH || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return null
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) return null
  return path
}

/** One vault's choices, with every malformed entry dropped. */
export function cleanFolderState(raw: unknown): FolderOpenState {
  const out: FolderOpenState = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const path = cleanFolderPath(key)
    if (path && typeof value === 'boolean') out[path] = value
  }
  return out
}

function cleanStored(raw: unknown): StoredFolderStates {
  const out: StoredFolderStates = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [root, state] of Object.entries(raw as Record<string, unknown>)) {
    if (root) out[root] = cleanFolderState(state)
  }
  return out
}

export interface TalkFolderStateStore {
  /** The current vault's stored choices ({} with no vault). */
  read(): FolderOpenState
  /** Merge choices into the current vault's map and persist; returns the stored map. */
  write(changes: unknown): FolderOpenState
}

/** The store over the app's config: `readValue`/`writeValue` read and write the
 *  `talkListFolders` value of config.json (the caller owns the file). */
export function createTalkFolderStateStore(options: {
  vaultRoot: () => string | null
  readValue: () => unknown
  writeValue: (value: StoredFolderStates) => void
}): TalkFolderStateStore {
  return {
    read(): FolderOpenState {
      const root = options.vaultRoot()
      if (!root) return {}
      return cleanStored(options.readValue())[root] ?? {}
    },
    write(changes: unknown): FolderOpenState {
      const root = options.vaultRoot()
      if (!root) return {}
      const patch = cleanFolderState(changes)
      const stored = cleanStored(options.readValue())
      const next = { ...(stored[root] ?? {}), ...patch }
      if (Object.keys(patch).length > 0) options.writeValue({ ...stored, [root]: next })
      return next
    }
  }
}
