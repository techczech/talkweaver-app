// "Move to a work file" (work-files ticket 28): the write path behind the Layout Doctor's action for a
// retired `{prework}` section. The plan itself is src/shared/prework-move.ts (pure); this module only
// performs it, in an order that cannot leave the talk pointing at a file that is not there:
//   1. inside the outline writer's turn (writeTalkOutline: the open editor's buffer when a window has
//      the talk, else the file under its lock) the plan is worked out from the talk's CURRENT text (and
//      the compiler's reading of that text, for the steps' ids), and the new work file is written with
//      'wx' (a file of that name is never replaced; the plan picks a name no file or id has). A refusal
//      or a failed file write throws, so the outline is not touched and the section stays;
//   2. the writer then writes the outline without the section.
// This module never deletes a work file, in any path (review round 2): a delete by pathname cannot be
// made safe against another program replacing the file in between, and an extra file is harmless.
//   - When the outline write does not complete (refused, unconfirmed, failed halfway), the work file is
//     kept and the reply names it (`keptFile`).
//   - The writer may work the transformation out again against a fresh buffer. When the file the
//     earlier attempt made still holds exactly the bytes it wrote and the new plan would write the same
//     file, it is reused (one file). Otherwise the new attempt writes the next free name ('wx') and the
//     earlier file is reported as kept.
// The outline is written by the one outline writer only (ADR-0001); the work file by the same folder
// guard as ticket 07 (`Work files/` inside the vault, no link followed).
// No Electron import: the IPC channel (`work-files:move-prework`) is registered in index.ts.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'fs'
import { join } from 'path'
import { WORK_FILES_FOLDER } from '../shared/work-files-view.ts'
import { readWorkFile } from '../shared/work-file.ts'
import { planPreworkMove, type CompiledPreworkStep, type PreworkMovePlan } from '../shared/prework-move.ts'
import { readWorkFileSources } from './work-files.ts'
import { pathStaysInside } from './path-containment.ts'
import type { TalkWriteNext, TalkWriteOrigin, TalkWriteResult } from './talk-writer.ts'

export type PreworkMoveWriter = (outlinePath: string, next: TalkWriteNext, origin: TalkWriteOrigin) => Promise<TalkWriteResult>
/** The compiler's pre-work steps for an outline text (compiled model `prework.steps`), or null. Sync:
 *  it runs inside the writer's transformation. */
export type PreworkCompile = (outline: string) => readonly CompiledPreworkStep[] | null
export type PreworkMoveResult =
  /** `keptFiles`: work files an earlier attempt of this move made that the talk does not use (vault-relative). */
  | { ok: true; fileName: string; relPath: string; id: string; stepIds: string[]; outline: string; keptFiles?: string[] }
  /** `keptFile`: the latest work file made by this move; it is still in `Work files/` (vault-relative). */
  | { ok: false; error: string; keptFile?: string }

const NOT_A_FOLDER = 'The Work files folder is not a folder inside this vault, so nothing was changed.'

function isLink(path: string): boolean { try { return lstatSync(path).isSymbolicLink() } catch { return false } }

/** The `Work files/` folder, made if absent; null when it is there as anything but a real folder inside the vault. */
function ensureFolder(vaultRoot: string): string | null {
  const dir = join(vaultRoot, WORK_FILES_FOLDER)
  if (existsSync(dir) || isLink(dir)) {
    try { if (!lstatSync(dir).isDirectory()) return null } catch { return null }
  } else {
    if (!pathStaysInside(vaultRoot, dir)) return null
    mkdirSync(dir, { recursive: true })
  }
  return pathStaysInside(vaultRoot, dir) ? dir : null
}

/** A file this move made: where, and the exact bytes written. */
interface MadeFile { path: string; fileName: string; bytes: Buffer }

/** Whether `made` is still a plain file holding exactly the bytes this move wrote. Read only. */
function stillAsWritten(made: MadeFile): boolean {
  try {
    if (!lstatSync(made.path).isFile()) return false
    return readFileSync(made.path).equals(made.bytes)
  } catch { return false }
}

/** Writes `text` to a new file at `path` ('wx': never over an existing one). A half-written file is
 *  left where it is (it is never deleted) and the error is thrown. */
function writeNewFile(path: string, fileName: string, text: string): MadeFile {
  const bytes = Buffer.from(text, 'utf8')
  const fd = openSync(path, 'wx', 0o666)
  try {
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
  } finally {
    try { closeSync(fd) } catch { /* nothing more to do */ }
  }
  return { path, fileName, bytes }
}

const relOf = (fileName: string): string => `${WORK_FILES_FOLDER}/${fileName}`
const named = (names: readonly string[]): string => names.map((name) => `“${relOf(name)}”`).join(', ')

export async function movePreworkToWorkFile(vaultRoot: string, outlinePath: string, write: PreworkMoveWriter, compile: PreworkCompile): Promise<PreworkMoveResult> {
  // Every file this move wrote, in order, and the one the latest completed attempt's outline names.
  const made: MadeFile[] = []
  let current: MadeFile | null = null
  let done: { fileName: string; id: string; stepIds: string[] } | null = null
  // Partly written files (the write failed): kept, named in the reply.
  const partial: string[] = []

  const result = await write(outlinePath, (text) => {
    const prior = current // an earlier attempt of this same move, if any
    current = null
    done = null
    const sources = readWorkFileSources(vaultRoot)
    let compiledSteps: readonly CompiledPreworkStep[] | null = null
    try { compiledSteps = compile(text) } catch { compiledSteps = null }
    const planWith = (list: typeof sources): ReturnType<typeof planPreworkMove> => planPreworkMove(text, {
      existingFileNames: list.map((source) => source.fileName),
      existingIds: list.map((source) => readWorkFile(source.text).definition.id).filter(Boolean),
      compiledSteps,
    })
    const accept = (file: MadeFile, plan: PreworkMovePlan): string => {
      current = file
      done = { fileName: plan.fileName, id: plan.id, stepIds: plan.stepIds }
      return plan.outline
    }

    // Reuse the earlier attempt's file when it is untouched and this plan would write the same file.
    if (prior && stillAsWritten(prior)) {
      const again = planWith(sources.filter((source) => source.fileName.toLowerCase() !== prior.fileName.toLowerCase()))
      if (again.ok && again.fileName === prior.fileName && Buffer.from(again.workFileText, 'utf8').equals(prior.bytes)) return accept(prior, again)
    }

    const plan = planWith(sources)
    if (!plan.ok) throw new Error(plan.error)
    const dir = ensureFolder(vaultRoot)
    if (!dir) throw new Error(NOT_A_FOLDER)
    const path = join(dir, plan.fileName)
    if (!pathStaysInside(dir, path)) throw new Error(NOT_A_FOLDER)
    let file: MadeFile
    try {
      file = writeNewFile(path, plan.fileName, plan.workFileText)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`A work file named ${plan.fileName} already exists, so nothing was changed. Try again.`)
      if (existsSync(path) || isLink(path)) partial.push(plan.fileName)
      throw new Error('The work file could not be written, so the section was kept.')
    }
    made.push(file)
    return accept(file, plan)
  }, 'prework-move')

  const final = current as MadeFile | null
  if (result.ok && done && final) {
    const moved = done as { fileName: string; id: string; stepIds: string[] }
    const unused = [...made.filter((file) => file !== final).map((file) => file.fileName), ...partial]
    return {
      ok: true, fileName: moved.fileName, relPath: relOf(moved.fileName), id: moved.id, stepIds: moved.stepIds, outline: result.text,
      ...(unused.length ? { keptFiles: unused.map(relOf) } : {}),
    }
  }
  const why = result.ok ? 'Nothing was moved.' : result.error
  const left = [...made.map((file) => file.fileName), ...partial]
  if (!left.length) return { ok: false, error: why }
  const latest = final ? final.fileName : left[left.length - 1]
  const others = left.filter((name) => name !== latest)
  const alsoLeft = others.length ? ` An earlier attempt’s work file ${named(others)} is also left in place.` : ''
  if (!final || result.ok || result.untouched === true) {
    // Nothing of the move reached the talk; the file this move made is left where it is (never deleted).
    return {
      ok: false,
      keptFile: relOf(latest),
      error: `${why} The talk was not changed and its section stays. The work file ${named([latest])} that was made for the move is left in place; you can delete it.${alsoLeft}`,
    }
  }
  // The change may be in the open editor or partly on disk: the work file stays, so the talk never
  // names a file that is not there.
  return {
    ok: false,
    keptFile: relOf(latest),
    error: `The work file ${named([latest])} was made, but the talk’s outline was not saved: ${why} The work file is kept so the talk can still find its pre-work; check the talk before trying again.${alsoLeft}`,
  }
}
