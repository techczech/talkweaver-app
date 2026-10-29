// The HTML page import's copy (src/main/html-page-import-core.ts) run in THIS process, for tests: the
// process changes into the talk folder exactly as the app's import process starts there, runs the
// copy with the given file system (a race seam may be passed), and changes back. The app never does
// this: it starts a process of its own in the talk folder (html-page-import-worker.ts).
import { HTML_PAGE_TEXT, importInWorkingFolder } from '../../src/main/html-page-import-core.ts'

export function runImportHere(job, fs) {
  const back = process.cwd()
  try { process.chdir(job.realTalkPath) } catch { return { ok: false, reason: 'write-failed', message: HTML_PAGE_TEXT.writeFailed } }
  try { return importInWorkingFolder(job, fs) } finally { process.chdir(back) }
}
