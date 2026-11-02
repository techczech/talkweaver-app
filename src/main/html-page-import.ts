// Insert › HTML page… (roadmap insert-an-html-page-with-a-file-picker, part one): an HTML file chosen
// in the native file picker becomes an `[Embed: assets/<name>.html]` line on the slide at the caret.
//
//   talk:choose-html-page(outlinePath) → the picker (HTML files only). Nothing is written: the chosen
//       file is checked and held here behind a one-time token tied to the asking window and the talk.
//       Cancel answers null.
//   talk:import-html-page(token, outlinePath) → the file's bytes copied into `<talk folder>/assets/`
//       (or the file already in the talk folder named as it is), answered as the reference to write.
//       The renderer writes the line itself, through the editor, so it is one Undo step and the
//       talk's unsaved text is never touched here.
//
// Rules this module holds (main's side; the copy itself is html-page-import-core.ts):
//   - Only the talk named at choose time is written to: import refuses a token asked for another talk
//     or by another window, and re-resolves the talk's vault for the write (the vault may have been
//     closed or gone missing while the picker was open). Nothing ever re-creates a missing vault.
//   - The source must be a regular `.html`/`.htm` file once symlinks are resolved, and at import it
//     must still be the file chosen (device and inode, taken when it was chosen).
//   - Main writes nothing. It checks, names the job (real paths and file identities, now) and hands it
//     to the import's own process, started with the talk folder as its working directory: that held
//     folder is the write authority (html-page-import-core.ts says why a path cannot be). The copy and
//     the page's names scan run there; main only waits for the one answer (review 2026-10-27, F1, F4).
//   - Only the page is copied. The compiler inlines it into a sealed frame that loads nothing local
//     (08-source-adapters.mjs, withEmbedPolicy), so files beside it would not load even if copied; the
//     renderer says so after every insert (insertHtmlPage.ts), naming the files found in its tags.
import { randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import type { BrowserWindow as BrowserWindowT, Dialog, IpcMain, OpenDialogOptions } from 'electron'
import { pathStaysInside } from './path-containment.ts'
import { HTML_PAGE_MAX_BYTES, HTML_PAGE_TEXT, htmlPageImportSupportedOn, refusal, type CopiedFileKind, type FileId, type HtmlPageImportJob } from './html-page-import-core.ts'
import type { HtmlPageChoice, HtmlPageImport, HtmlPageRefusal, HtmlPageRefusalReason } from '../shared/html-page-import.ts'

export type { HtmlPageChoice, HtmlPageImport, HtmlPageRefusal, HtmlPageRefusalReason, HtmlPageImportJob }
export { HTML_PAGE_ASSETS_DIR, HTML_PAGE_MAX_BYTES, HTML_PAGE_TEXT, htmlPageImportSupportedOn, localReferencesOf, safePageFileName, writableAsReference } from './html-page-import-core.ts'

export const HTML_PAGE_EXTENSIONS = ['html', 'htm'] as const
const TOKEN_TTL_MS = 10 * 60 * 1000
/** How long main waits for the import's own process before refusing (a 20 MB page takes well under a second). */
export const HTML_PAGE_IMPORT_TIMEOUT_MS = 60_000

/** What main reads of the file system: checks only, never a write. */
export type HtmlPageMainFs = Pick<typeof nodeFs, 'existsSync' | 'statSync' | 'realpathSync'>

export function isHtmlPageName(path: string): boolean {
  return (HTML_PAGE_EXTENSIONS as readonly string[]).includes(extname(path).slice(1).toLowerCase())
}
/** The name check for what is copied: an HTML page, or (Slide Scratchpad) an SVG picture. */
const nameFits = (path: string, kind: CopiedFileKind): boolean => (kind === 'svg' ? extname(path).toLowerCase() === '.svg' : isHtmlPageName(path))

/** Slide Scratchpad (ticket 2): the same checked copy for an agent's file. `kind` 'svg' copies an SVG picture;
 *  `alwaysCopy` copies a file that is already in the talk folder instead of naming it where it is. */
export type CopyOptions = { kind?: CopiedFileKind; alwaysCopy?: boolean }

const realNow = (fs: HtmlPageMainFs, path: string): string => (fs.realpathSync.native ?? fs.realpathSync)(path)

/** The real path and identity of a chosen file when it is a regular HTML file within the size limit, else a refusal. */
export function checkHtmlPageSource(chosen: string, fs: HtmlPageMainFs = nodeFs, kind: CopiedFileKind = 'html'): { ok: true; real: string; id: FileId } | HtmlPageRefusal {
  if (typeof chosen !== 'string' || !chosen || chosen.includes('\0') || !isAbsolute(chosen)) return refusal('missing', HTML_PAGE_TEXT.missing)
  if (!nameFits(chosen, kind)) return refusal('not-html', HTML_PAGE_TEXT.notHtml)
  let real: string
  try { real = realNow(fs, chosen) } catch { return refusal('missing', HTML_PAGE_TEXT.missing) }
  if (!nameFits(real, kind)) return refusal('not-html', HTML_PAGE_TEXT.notHtml)
  let info: nodeFs.Stats
  try { info = fs.statSync(real) } catch { return refusal('missing', HTML_PAGE_TEXT.missing) }
  if (!info.isFile()) return refusal('missing', HTML_PAGE_TEXT.missing)
  if (info.size > HTML_PAGE_MAX_BYTES) return refusal('too-large', HTML_PAGE_TEXT.tooLarge)
  return { ok: true, real, id: { dev: info.dev, ino: info.ino } }
}

export type ImportTarget = {
  /** The writable root of the talk's open vault, resolved now (not when the picker opened). */
  root: string
  outlinePath: string
}

/**
 * Main's checks for an import, read-only: the job for the import's own process, or why not.
 * `chosen`: the file's identity when it was chosen; the source must still be that file.
 */
export function htmlPageImportJob(target: ImportTarget, source: string, chosen?: FileId, fs: HtmlPageMainFs = nodeFs, copy: CopyOptions = {}): { ok: true; job: HtmlPageImportJob } | HtmlPageRefusal {
  const { root, outlinePath } = target
  if (!fs.existsSync(root)) return refusal('vault-unavailable', HTML_PAGE_TEXT.vaultUnavailable)
  if (!pathStaysInside(root, outlinePath)) return refusal('outside-vault', HTML_PAGE_TEXT.outsideVault)
  let outline: nodeFs.Stats
  try { outline = fs.statSync(outlinePath) } catch { return refusal('no-talk', HTML_PAGE_TEXT.noTalk) }
  if (!outline.isFile()) return refusal('no-talk', HTML_PAGE_TEXT.noTalk)
  const checked = checkHtmlPageSource(source, fs, copy.kind ?? 'html')
  if (!checked.ok) return checked
  if (chosen && (chosen.dev !== checked.id.dev || chosen.ino !== checked.id.ino)) return refusal('missing', HTML_PAGE_TEXT.missing)
  let realRoot: string
  try { realRoot = realNow(fs, root) } catch { return refusal('vault-unavailable', HTML_PAGE_TEXT.vaultUnavailable) }
  let realTalkPath: string
  try { realTalkPath = realNow(fs, dirname(outlinePath)) } catch { return refusal('no-talk', HTML_PAGE_TEXT.noTalk) }
  if (!pathStaysInside(realRoot, realTalkPath, true)) return refusal('outside-vault', HTML_PAGE_TEXT.outsideVault)
  return {
    ok: true,
    job: {
      realRoot, realTalkPath, outlineName: basename(outlinePath), outline: { dev: outline.dev, ino: outline.ino }, source: checked.real, sourceId: chosen ?? checked.id,
      ...(copy.kind === 'svg' ? { kind: 'svg' as const } : {}), ...(copy.alwaysCopy ? { alwaysCopy: true } : {})
    }
  }
}

/** Runs a job in the import's own process (working directory: job.realTalkPath) and answers its result. */
export type RunHtmlPageImport = (job: HtmlPageImportJob) => Promise<HtmlPageImport>

/** Main checks, then the run (the app's: createHtmlPageImportRunner). */
export async function importHtmlPage(target: ImportTarget, source: string, run: RunHtmlPageImport, chosen?: FileId, fs: HtmlPageMainFs = nodeFs, copy: CopyOptions = {}): Promise<HtmlPageImport> {
  const prepared = htmlPageImportJob(target, source, chosen, fs, copy)
  if (!prepared.ok) return prepared
  return run(prepared.job)
}

/** The import's own process as main sees it: an Electron utility process (or, in tests, a Node child). */
export type HtmlPageImportChild = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: unknown) => void): unknown
  kill(): unknown
}

/** One process per import, started in the talk folder; it answers once and is ended. */
export function createHtmlPageImportRunner(workerPath: string, fork: (path: string, cwd: string) => HtmlPageImportChild, timeoutMs = HTML_PAGE_IMPORT_TIMEOUT_MS): RunHtmlPageImport {
  return (job) => new Promise<HtmlPageImport>((resolve) => {
    let done = false
    let child: HtmlPageImportChild | null = null
    const finish = (answer: HtmlPageImport): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child?.kill() } catch { /* already gone */ }
      resolve(answer)
    }
    const failed = (): void => finish(refusal('write-failed', HTML_PAGE_TEXT.writeFailed))
    const timer = setTimeout(failed, timeoutMs)
    try {
      child = fork(workerPath, job.realTalkPath)
      child.on('message', (message) => finish(isImportAnswer(message) ? message : refusal('write-failed', HTML_PAGE_TEXT.writeFailed)))
      child.on('exit', failed)
      child.postMessage(job)
    } catch { failed() }
  })
}

/** The answer's shape, checked: the child is ours, but a broken answer must not reach the editor. */
function isImportAnswer(value: unknown): value is HtmlPageImport {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.ok === false) return typeof v.reason === 'string' && typeof v.message === 'string'
  return v.ok === true && typeof v.embedPath === 'string' && (v.how === 'copied' || v.how === 'reused' || v.how === 'in-talk')
    && Array.isArray(v.localReferences) && v.localReferences.every((r) => typeof r === 'string')
}

export type HtmlPageImportDeps = {
  ipcMain: Pick<IpcMain, 'handle'>
  dialog: Pick<Dialog, 'showOpenDialog'>
  windowOf: (sender: Electron.WebContents) => BrowserWindowT | null
  /** The writable root of the open vault holding the talk, now; undefined when it is closed, missing or not a vault's. */
  writableTalkRoot: (outlinePath: string) => string | undefined
  /** Runs the copy in the import's own process (createHtmlPageImportRunner). */
  runImport: RunHtmlPageImport
  now?: () => number
  fs?: HtmlPageMainFs
  /** Tests only: the platform the handlers act for (default: this one). */
  platform?: string
}

/** Registers talk:choose-html-page and talk:import-html-page. */
export function registerHtmlPageImportIpc(deps: HtmlPageImportDeps): void {
  const fs = deps.fs ?? nodeFs
  const now = deps.now ?? Date.now
  // Outside macOS the copy cannot be made safely (html-page-import-core.ts, htmlPageImportSupportedOn):
  // both handlers say so before the picker opens or a job is named.
  const supported = htmlPageImportSupportedOn(deps.platform ?? process.platform)
  const pending = new Map<string, { source: string; chosen: FileId; outlinePath: string; sender: number; at: number }>()
  const sweep = (): void => { for (const [token, held] of pending) if (now() - held.at > TOKEN_TTL_MS) pending.delete(token) }
  const talkPath = (value: unknown): string | null =>
    typeof value === 'string' && value && !value.includes('\0') && isAbsolute(value) && value.endsWith('-outline.md') ? value : null

  deps.ipcMain.handle('talk:choose-html-page', async (event, outlinePath: unknown): Promise<HtmlPageChoice | null> => {
    if (!supported) return refusal('unsupported', HTML_PAGE_TEXT.unsupported)
    const talk = talkPath(outlinePath)
    if (!talk || !deps.writableTalkRoot(talk)) return refusal('no-talk', HTML_PAGE_TEXT.noTalk)
    const options: OpenDialogOptions = {
      title: 'Insert HTML page',
      message: 'Choose an HTML page to show on this slide. A page from outside the talk is copied into its assets folder.',
      buttonLabel: 'Insert',
      properties: ['openFile'],
      filters: [{ name: 'HTML pages', extensions: [...HTML_PAGE_EXTENSIONS] }]
    }
    const win = deps.windowOf(event.sender)
    const result = win ? await deps.dialog.showOpenDialog(win, options) : await deps.dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return null
    const checked = checkHtmlPageSource(result.filePaths[0], fs)
    if (!checked.ok) return checked
    sweep()
    const token = randomUUID()
    pending.set(token, { source: result.filePaths[0], chosen: checked.id, outlinePath: talk, sender: event.sender.id, at: now() })
    return { ok: true, token, fileName: basename(result.filePaths[0]) }
  })

  deps.ipcMain.handle('talk:import-html-page', async (event, token: unknown, outlinePath: unknown): Promise<HtmlPageImport> => {
    if (!supported) return refusal('unsupported', HTML_PAGE_TEXT.unsupported)
    sweep()
    const held = typeof token === 'string' ? pending.get(token) : undefined
    if (!held || held.sender !== event.sender.id) return refusal('expired', HTML_PAGE_TEXT.expired)
    pending.delete(token as string)
    const talk = talkPath(outlinePath)
    if (!talk || talk !== held.outlinePath) return refusal('talk-changed', HTML_PAGE_TEXT.talkChanged)
    const root = deps.writableTalkRoot(talk)
    if (!root) return refusal('vault-unavailable', HTML_PAGE_TEXT.vaultUnavailable)
    return importHtmlPage({ root, outlinePath: talk }, held.source, deps.runImport, held.chosen, fs)
  })
}
