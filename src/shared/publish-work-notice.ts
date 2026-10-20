// The sentence the talk's Publish dialog shows when the talk names a pre-work and/or post-work file
// (work-files ticket 23, ADR-0040 decision 7): the talk handout never carries work files; they go out
// with a Run. Pure. A named file is read by the one shared reading (work-file-name.ts); the sentence
// uses the file's TITLE. A name no file answers to is said plainly, never given an invented title.

import { talkWorkFile, type NameableWorkFile } from './work-file-name.ts'

export interface TitledWorkFile extends NameableWorkFile { title: string }

/** One phase as the sentence names it: the title, or the name as written when no file answers to it. */
function phaseName<F extends TitledWorkFile>(value: string | undefined, files: readonly F[]): string | null {
  const named = talkWorkFile(value, files)
  if (!named.name) return null
  if (named.file) return named.file.title || named.name
  return named.sharedId
    ? `${named.name} (two work files share this name)`
    : `${named.name} (no work file with this name was found)`
}

/**
 * The notice, or null when the talk names neither file. `files` are the vault's work files; null/undefined
 * (could not be read) still gives the notice, with each name as written.
 */
export function publishWorkNotice(
  names: { prework?: string; postwork?: string },
  files: readonly TitledWorkFile[] | null | undefined
): string | null {
  const list = files ?? []
  const pre = phaseName(names.prework, list)
  const post = phaseName(names.postwork, list)
  if (pre && post) return `Pre-work and post-work are not included. The talk’s pre-work file, ${pre}, and post-work file, ${post}, go out with a run.`
  if (pre) return `Pre-work is not included. The talk’s pre-work file, ${pre}, goes out with a run.`
  if (post) return `Post-work is not included. The talk’s post-work file, ${post}, goes out with a run.`
  return null
}
