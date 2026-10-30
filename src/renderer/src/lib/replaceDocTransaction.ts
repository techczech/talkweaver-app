// The editor transaction that puts rewritten text into the buffer (Editor.tsx registerReplaceDoc):
// the minimal change (lib/minimalChange), and, for an explicit operation the user asked for by name
// (Inspector › Web page › Remove from slide), its own undo step. CodeMirror otherwise joins a
// programmatic change to typing just before or after it, so one Undo would also take the typing away
// (review e3b41fd1). `isolateHistory.of('full')` keeps it apart on both sides, as the slide
// cut/paste and the icon tools already do.
import { isolateHistory } from '@codemirror/commands'
import type { TransactionSpec } from '@codemirror/state'
import { applyMinimalChange } from './minimalChange.ts'

export function replaceDocTransaction(current: string, next: string, opts?: { ownUndoStep?: boolean }): TransactionSpec | null {
  const change = applyMinimalChange(current, next)
  if (!change) return null
  return opts?.ownUndoStep ? { changes: change, annotations: isolateHistory.of('full') } : { changes: change }
}
