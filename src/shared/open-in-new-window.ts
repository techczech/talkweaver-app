// "Open in new window" (file-list right-click, palette). One decision, no Electron: the main process
// resolves which window (if any) already holds the talk and asks here what to do. A talk lives in one
// window at a time (one-writer rule; window:claim-talk), so a talk that is already open anywhere —
// including in the window the request came from — is brought to the front instead of opened twice.

/** What the file list asks for: a talk, or a folder to scope the new window's file list to. */
export type OpenInNewWindowTarget =
  | { kind: 'talk'; outlinePath: string }
  | { kind: 'folder'; topic: string; vaultId?: string }

export type OpenInNewWindowDecision<W> =
  | { action: 'focus'; window: W }
  | { action: 'open' }

/** Focus the window that already holds the talk; otherwise open a new one. A folder has no holder
 *  (pass null): it always opens a new window. */
export function decideOpenInNewWindow<W>(holder: W | null | undefined): OpenInNewWindowDecision<W> {
  return holder ? { action: 'focus', window: holder } : { action: 'open' }
}

/** Validate an IPC payload; null when it is not a usable target. */
export function parseOpenInNewWindowTarget(raw: unknown): OpenInNewWindowTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'talk' && typeof r.outlinePath === 'string' && r.outlinePath) {
    return { kind: 'talk', outlinePath: r.outlinePath }
  }
  if (r.kind === 'folder' && typeof r.topic === 'string' && r.topic) {
    return { kind: 'folder', topic: r.topic, ...(typeof r.vaultId === 'string' && r.vaultId ? { vaultId: r.vaultId } : {}) }
  }
  return null
}
