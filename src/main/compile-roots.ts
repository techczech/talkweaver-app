// The check a compile run OFF the main process's thread makes on the media folders it was handed
// (0.38 "Talks use only media inside their vault").
//
// The main process works out a talk's allowed media folders (assetRootsForTalk, asset-roots.ts) and
// passes them on every compile. Two compiles run off the main process and are handed those folders
// inside a job: the live compile (prepare-talk-worker.ts, a utility process of its own,
// job.options.allowedAssetRoots) and the handout build (handout-pages.ts in a worker thread, job.assetRoots). Given no list, the compiler would fall back to
// the outline's own folder; a job is plain data posted between threads or processes, so a caller that forgot the
// folders would compile without the talk's roots and nothing would say so. Here such a job is
// refused instead: the folders must be a list of absolute paths (an empty list is allowed and means
// "no local media at all"; a relative path would be read against the process's working folder).
//
// No Electron import and erasable TypeScript only: the workers and the tests load this file directly.
import { isAbsolute } from 'node:path'

/** The allowed media folders a job carries, or a thrown refusal when it carries none (or a bad list). */
export function requireAllowedAssetRoots(roots: unknown, what: string): string[] {
  if (!Array.isArray(roots)) {
    throw new Error(`${what} was refused: it was not given the talk's allowed media folders.`)
  }
  for (const root of roots) {
    if (typeof root !== 'string' || root === '' || !isAbsolute(root)) {
      throw new Error(`${what} was refused: an allowed media folder is not an absolute path (${JSON.stringify(root)}).`)
    }
  }
  return [...roots]
}

/** A job's compile options with its allowed media folders checked (requireAllowedAssetRoots). */
export function requireCompileOptionsWithRoots(options: unknown, what: string): Record<string, unknown> & { allowedAssetRoots: string[] } {
  const given = options && typeof options === 'object' ? (options as Record<string, unknown>) : {}
  return { ...given, allowedAssetRoots: requireAllowedAssetRoots(given.allowedAssetRoots, what) }
}
