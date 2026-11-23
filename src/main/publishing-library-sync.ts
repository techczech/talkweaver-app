// Explicit recovery action only. Never run automatically during a publish or save.
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'

/** Fast-forward while Git preserves disjoint edits and refuses overwrites. Never stash or reset. */
export async function getLibraryFiles(root: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const deadline = performance.now() + 60_000
  const runGit = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
    const timeout = Math.floor(deadline - performance.now())
    if (timeout < 1) return reject(new Error('Git recovery timed out.'))
    execFile('git', ['-C', root, '-c', 'submodule.recurse=false', ...args], { timeout, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => error ? reject(error) : resolve(stdout))
  })
  try {
    const top = (await runGit(['rev-parse', '--show-toplevel'])).trim()
    if (await realpath(top) !== await realpath(root)) return { ok: false, error: 'This library is inside a larger repository. Get its files through your normal sync tool or Finder.' }
    // Pull's merge overwrites ignored files by default, and pull has no flag to prevent it.
    await runGit(['fetch', '--no-recurse-submodules'])
    await runGit(['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '@{upstream}'])
    return { ok: true }
  } catch {
    return { ok: false, error: 'The library could not fast-forward. Check the connection, or compare competing Git edits. Nothing was reset or discarded. For cloud-only files, use Finder’s Download Now.' }
  }
}
