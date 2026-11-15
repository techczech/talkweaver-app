// The only writer of a layered Run's edit sidecar `<runId>.edits.json` (ADR-0043). It never writes the
// Run, its transcript or any media. Every write is atomic: a new file under an exclusive temporary name
// in the same folder, written and flushed through its own descriptor, then renamed over the sidecar.
// Flushing the folder afterwards is best effort (Windows cannot open a folder for it): once the rename
// has happened the change is committed and is reported as such. A write names the revision it was based
// on; a newer revision on disk refuses it.
//
// A missing sidecar is a fresh, empty edit list. PR 316's versions 1 and 2 are migrated when their
// source binding matches this recording. A newer, unreadable or other-recording sidecar is refused with
// a stated reason and kept unchanged; nothing is written until the owner chooses "Start new edits",
// which moves it aside to `<runId>.edits.kept-<time>.json` first.
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { applyEditOp, EDITS_MAX_BYTES, emptyEdits, fitEditsBudget, parseEditsText, serialiseEdits, type EditOp, type EditsContext, type EditsProblem, type RecordingEdits } from '../shared/recording-edits.ts'

export type EditsLocation = { path: string; runId: string; durationMs: number; fingerprint: string; context?: Omit<EditsContext, 'fingerprint'> }
export type EditsSnapshot = { edits: RecordingEdits; problem: (EditsProblem & { file: string }) | null; keptAs?: string }
/** File operations a test can make fail. */
export type EditsIo = { write?: (fd: number, bytes: Uint8Array, offset: number) => number; flushFolder?: (folder: string) => void }

function readSidecar(path: string): { text: string } | { missing: true } | { unreadable: true } {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { missing: true }
    return { unreadable: true }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > EDITS_MAX_BYTES) return { unreadable: true }
    try { return { text: readFileSync(fd, 'utf8') } } catch { return { unreadable: true } }
  } finally { closeSync(fd) }
}

/** Flush a folder's entry list. Best effort: some platforms cannot open a folder at all. */
export function flushFolder(folder: string): void {
  let fd: number | null = null
  try { fd = openSync(folder, constants.O_RDONLY); fsyncSync(fd) } catch { /* the rename itself is atomic */ } finally { if (fd !== null) try { closeSync(fd) } catch { /* closed */ } }
}

/**
 * Write text atomically as `target`. The temporary file is created exclusively, so it is ours from the
 * moment it exists; it is removed on every failure before the rename, and an existing file of the same
 * name (not ours) is never touched. After the rename nothing can turn the write into a failure.
 */
export function writeTextAtomic(target: string, text: string, beforeRename?: () => void, io: EditsIo = {}): void {
  const folder = dirname(target)
  try { if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) throw Error('The edits file is not a plain file') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temp = join(folder, `.${basename(target)}.${randomUUID()}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let owned = true, open = true
  try {
    const bytes = new TextEncoder().encode(text)
    const write = io.write ?? ((f: number, b: Uint8Array, offset: number) => writeSync(f, b, offset, b.length - offset))
    for (let offset = 0; offset < bytes.length;) {
      const wrote = write(fd, bytes, offset)
      if (!(wrote > 0)) throw Error('The disk stopped accepting data')
      offset += wrote
    }
    fsyncSync(fd)
    closeSync(fd); open = false
    beforeRename?.()
    renameSync(temp, target)
    owned = false
  } finally {
    if (open) try { closeSync(fd) } catch { /* already closed */ }
    if (owned) try { unlinkSync(temp) } catch { /* already gone */ }
  }
  ;(io.flushFolder ?? flushFolder)(folder)
}

export function createRecordingEditsStore(deps: { locate: (key: unknown) => EditsLocation; beforeRename?: () => void; now?: () => Date; io?: EditsIo }) {
  function load(loc: EditsLocation): EditsSnapshot {
    const read = readSidecar(loc.path)
    if ('missing' in read) return { edits: emptyEdits(), problem: null }
    if ('unreadable' in read) return { edits: emptyEdits(), problem: { kind: 'corrupt', message: 'The saved edits for this recording could not be read.', file: loc.path } }
    const parsed = parseEditsText(read.text, loc.durationMs, { ...loc.context, fingerprint: loc.fingerprint })
    return parsed.ok ? { edits: parsed.edits, problem: null } : { edits: emptyEdits(), problem: { ...parsed.problem, file: loc.path } }
  }
  return {
    get(key: unknown): EditsSnapshot {
      return load(deps.locate(key))
    },
    /** Apply one operation based on `revision`. Throws when the file changed since, or holds a problem. */
    apply(key: unknown, op: EditOp, revision: number): EditsSnapshot {
      const loc = deps.locate(key)
      const current = load(loc)
      if (current.problem) throw Error(`${current.problem.message} It was kept unchanged. Choose Start new edits to continue.`)
      if (revision !== current.edits.revision) throw Error('The edits changed in another window. Reopen the recording to see them.')
      const changed = applyEditOp(current.edits, op, loc.durationMs)
      if (changed === current.edits) return current
      const next = fitEditsBudget({ ...changed, recording: loc.fingerprint })
      const text = next && serialiseEdits(next)
      // Exactly what the reader would make of these bytes: a change it would refuse is never written.
      if (!next || !text || !parseEditsText(text, loc.durationMs, { ...loc.context, fingerprint: loc.fingerprint }).ok) throw Error('There are too many cuts to save. Use the whole recording, then cut again.')
      writeTextAtomic(loc.path, text, () => {
        deps.beforeRename?.()
        // A second writer between our read and rename loses nothing: we refuse instead.
        const again = load(loc)
        if (again.problem || again.edits.revision !== revision) throw Error('The edits changed in another window. Reopen the recording to see them.')
      }, deps.io)
      return { edits: next, problem: null }
    },
    /** Keep an unreadable, newer or other-recording sidecar beside a fresh one. Only on the owner's explicit choice. */
    startFresh(key: unknown): EditsSnapshot {
      const loc = deps.locate(key)
      const current = load(loc)
      if (!current.problem) return current
      const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')
      const kept = join(dirname(loc.path), `${loc.runId}.edits.kept-${stamp}.json`)
      // Exclusive: never overwrite an earlier kept copy.
      closeSync(openSync(kept, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600))
      renameSync(loc.path, kept)
      ;(deps.io?.flushFolder ?? flushFolder)(dirname(loc.path))
      return { edits: emptyEdits(), problem: null, keptAs: kept }
    }
  }
}
export type RecordingEditsStore = ReturnType<typeof createRecordingEditsStore>
