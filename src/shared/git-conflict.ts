// What the app says when a vault data file holds Git conflict markers (0.45, second Mac): two Macs
// changed the same file and Git left both versions in it. The main process detects the markers
// (conflict-copies.mjs `hasGitConflictMarkers`) before its generic "could not be read", and nothing is
// written over the file: the owner resolves it in Git, or chooses an action that names what it does.
// Pure, no imports: main and renderer share the words.

/** A read refused because the file holds Git conflict markers. `file` is the path to reveal. */
export class GitConflictError extends Error {
  readonly gitConflict = true
  readonly file: string
  constructor(message: string, file: string) {
    super(message)
    this.name = 'GitConflictError'
    this.file = file
  }
}

export const isGitConflictError = (error: unknown): error is GitConflictError =>
  !!error && typeof error === 'object' && (error as { gitConflict?: unknown }).gitConflict === true && typeof (error as { file?: unknown }).file === 'string'

export const editsGitConflict = (name: string): string =>
  `The saved edits for this recording have a Git conflict from syncing (${name}). Resolve it in Git, then open the recording again.`

export const pathwaysGitConflict = (name: string): string =>
  `The Pathways file for this talk has a Git conflict from syncing (${name}). Resolve it in Git, then try again.`

export const runGitConflict = (name: string): string =>
  `A Run file has a Git conflict from syncing (${name}), so that Run is not listed. Resolve it in Git.`

export const NOTES_GIT_CONFLICT_HEADING = 'The notes have a Git conflict'
export const notesGitConflict = (name: string): string =>
  `The notes file for this Run has a Git conflict from syncing (${name}). Resolve it in Git, then try again.`

// A write refused because the file it would replace cannot be read (0.45): the file is kept exactly as it
// is, and what was not saved is said. `name` is the file's short name (`talk/run-id.json`).
export const runNotSavedGitConflict = (name: string): string =>
  `This Run was not saved: its file has a Git conflict from syncing (${name}). The file was left as it is. Resolve it in Git, then try again.`
export const runNotSavedUnreadable = (name: string): string =>
  `This Run was not saved: its file could not be read as a Run (${name}). The file was left as it is.`
export const pathwaysNotSavedUnreadable = (name: string): string =>
  `The Pathways file for this talk could not be read (${name}), so it was left as it is and nothing was saved.`
export const notesNotSavedUnreadable = (name: string): string =>
  `The notes file for this Run could not be read (${name}), so it was left as it is and nothing was saved.`
export const transcriptNotSavedGitConflict = (name: string): string =>
  `The new transcript was not saved: the transcript file has a Git conflict from syncing (${name}). The file was left as it is. Resolve it in Git, then transcribe again.`
