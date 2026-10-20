// The Work files view's writes (work-files ticket 07): make a new work file, add a step to one.
// The only writes here go into the vault's `Work files/` folder: the new file's name is a slug of its
// title (letters, digits and hyphens), checked to stay inside the folder (a link out is refused) and
// never to replace a file; an added step goes into an existing plain `.md` file of that folder.
// Nothing is added that the author did not pick: no preset is attached unless named, no step unless asked.
// Where a step's answer goes (`{local}`) is written the same way into an existing file (2026-10-19 prework-responses design).
// No Electron import: the IPC channels (`work-files:create`, `work-files:add-step`, `work-files:set-step-local`) are registered in index.ts.
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { WORK_FILES_FOLDER } from '../shared/work-files-view.ts'
import { readWorkFile } from '../shared/work-file.ts'
import {
  appendStep, checkNewTitle, isWorkFileAdd, newWorkFileText, presetById, setStepLocal, type WorkFileAdd,
} from '../shared/work-file-write.ts'
import { MAX_WORK_FILE_BYTES, readWorkFileSources } from './work-files.ts'
import { pathStaysInside } from './path-containment.ts'

export type WorkFileWriteResult = { ok: true; fileName: string; relPath: string; id?: string } | { ok: false; error: string }

/** The `Work files/` folder, made if it is not there; null when it is there as anything but a real folder inside the vault. */
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
function isLink(path: string): boolean { try { return lstatSync(path).isSymbolicLink() } catch { return false } }

/** Creates `Work files/<slug>.md` with `id`, `title`, `revision: 1` and only the steps the author chose (a preset, the Adds). */
export function createWorkFile(vaultRoot: string, input: { title?: unknown; presetId?: unknown; adds?: unknown }): WorkFileWriteResult {
  const adds: WorkFileAdd[] = []
  if (input.adds !== undefined) {
    if (!Array.isArray(input.adds) || input.adds.length > 200 || !input.adds.every(isWorkFileAdd)) return { ok: false, error: 'One of the steps to add is not one this app writes.' }
    adds.push(...(input.adds as WorkFileAdd[]))
  }
  if (input.presetId != null && input.presetId !== '' && !presetById(input.presetId)) return { ok: false, error: 'That starting point does not exist.' }
  const sources = readWorkFileSources(vaultRoot)
  const ids = sources.map((s) => readWorkFile(s.text).definition.id).filter(Boolean)
  const check = checkNewTitle(input.title, sources.map((s) => s.fileName), ids)
  if (!check.ok) return check
  const dir = ensureFolder(vaultRoot)
  if (!dir) return { ok: false, error: 'The Work files folder is not a folder inside this vault.' }
  const path = join(dir, check.fileName)
  if (!pathStaysInside(dir, path)) return { ok: false, error: 'That title would put the file outside the Work files folder.' }
  const text = newWorkFileText({ id: check.slug, title: check.title, presetId: input.presetId as string | null, adds })
  try {
    // 'wx': never replaces a file that appeared since the check.
    writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, error: `A work file named ${check.fileName} already exists. Choose another title.` }
    return { ok: false, error: 'The file could not be written.' }
  }
  return { ok: true, fileName: check.fileName, relPath: `${WORK_FILES_FOLDER}/${check.fileName}`, id: check.slug }
}

/**
 * Rewrites one existing plain `.md` file of `Work files/` with `change` (its text in, the new text out),
 * atomically: a temp file beside it, then a rename. The name is checked to stay inside the folder.
 */
function rewriteWorkFile(vaultRoot: string, fileName: unknown, change: (text: string) => { text: string; id?: string } | { error: string }, failed: string): WorkFileWriteResult {
  if (typeof fileName !== 'string' || !/^[^/\\\0]+\.md$/i.test(fileName) || fileName.startsWith('.')) return { ok: false, error: 'That is not a work file name.' }
  const dir = join(vaultRoot, WORK_FILES_FOLDER)
  const path = join(dir, fileName)
  if (!pathStaysInside(dir, path) || !pathStaysInside(vaultRoot, path)) return { ok: false, error: 'That file is outside the Work files folder.' }
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > MAX_WORK_FILE_BYTES) return { ok: false, error: 'That is not a work file.' }
  } catch { return { ok: false, error: 'That work file is not there any more.' } }
  // A random part in the temp name, and 'wx': a link or file already at the name is never followed or replaced.
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    const before = readFileSync(path, 'utf8')
    const result = change(before)
    if ('error' in result) return { ok: false, error: result.error }
    if (result.text === before) return { ok: true, fileName, relPath: `${WORK_FILES_FOLDER}/${fileName}`, ...(result.id ? { id: result.id } : {}) }
    writeFileSync(temp, result.text, { encoding: 'utf8', flag: 'wx' })
    renameSync(temp, path)
    return { ok: true, fileName, relPath: `${WORK_FILES_FOLDER}/${fileName}`, ...(result.id ? { id: result.id } : {}) }
  } catch {
    try { rmSync(temp, { force: true }) } catch { /* the error result below stands */ }
    return { ok: false, error: failed }
  }
}

/** Appends one step to an existing work file of `Work files/` and raises its `revision` by one. */
export function addWorkFileStep(vaultRoot: string, fileName: unknown, add: unknown): WorkFileWriteResult {
  if (!isWorkFileAdd(add)) return { ok: false, error: 'That is not a step this app writes.' }
  return rewriteWorkFile(vaultRoot, fileName, (text) => appendStep(text, add), 'The step could not be written.')
}

/**
 * Where one step's answer goes (2026-10-19 prework-responses design): `local: true` writes `{local}` on
 * the step, `false` takes it out; the revision rises by one. A file already saying so is not rewritten.
 */
export function setWorkFileStepLocal(vaultRoot: string, fileName: unknown, stepId: unknown, local: unknown): WorkFileWriteResult {
  if (typeof stepId !== 'string' || !stepId || stepId.length > 200 || typeof local !== 'boolean') return { ok: false, error: 'That is not a step of this file.' }
  return rewriteWorkFile(vaultRoot, fileName, (text) => {
    const result = setStepLocal(text, stepId, local)
    return result.ok ? { text: result.text } : { error: result.error }
  }, 'The step could not be written.')
}
