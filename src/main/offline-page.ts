// One content operation for the app and in-process agents. Authority is retained before source execution.
import { mkdtempSync, rmSync, openSync, closeSync, writeFileSync, lstatSync, realpathSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, relative, sep } from 'node:path'
import { htmlPageImportJob, type RunHtmlPageImport, type HtmlPageImportJob } from './html-page-import.ts'
import type { OfflinePageInput, OfflinePageSaveResult } from '../shared/offline-page.ts'
import type { OfflinePageResult } from './offline-page-policy.ts'

export type OfflinePageAuthority = Pick<HtmlPageImportJob, 'realRoot' | 'realTalkPath' | 'outlineName' | 'outline'> & { directory: { dev: number; ino: number }; outlineVersion: NonNullable<HtmlPageImportJob['outlineVersion']> }
export function offlineAuthorityCurrent(target: OfflinePageAuthority): boolean {
  try {
    const rel = relative(target.realRoot, target.realTalkPath)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || /[\\/\0]/.test(target.outlineName)) return false
    if (realpathSync.native(target.realRoot) !== target.realRoot || realpathSync.native(target.realTalkPath) !== target.realTalkPath) return false
    const directory = lstatSync(target.realTalkPath)
    const outline = lstatSync(join(target.realTalkPath, target.outlineName))
    return directory.isDirectory() && outline.isFile() && directory.dev === target.directory.dev && directory.ino === target.directory.ino
      && outline.dev === target.outline.dev && outline.ino === target.outline.ino
      && outline.size === target.outlineVersion.size && outline.mtimeMs === target.outlineVersion.mtimeMs
  } catch { return false }
}
export interface OfflinePageDeps {
  writableTalkRoot: (outlinePath: string) => string | undefined
  capture: (input: OfflinePageInput, target: OfflinePageAuthority) => Promise<OfflinePageResult>
  runImport: RunHtmlPageImport
}
export async function saveOfflinePage(raw: unknown, deps: OfflinePageDeps): Promise<OfflinePageSaveResult> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'Choose a page in an open talk.' }
  const input = raw as OfflinePageInput
  if (typeof input.outlinePath !== 'string' || !isAbsolute(input.outlinePath) || input.outlinePath.includes('\0') || typeof input.source !== 'string' || !input.source || input.source.length > 4096) return { ok: false, message: 'Choose a page in an open talk.' }
  const root = deps.writableTalkRoot(input.outlinePath)
  if (!root) return { ok: false, message: 'The talk’s vault is not available.' }
  let temporary: string | undefined, fd: number | undefined
  try {
    temporary = mkdtempSync(join(tmpdir(), 'tw-offline-page-'))
    const source = join(temporary, 'offline-page.html')
    fd = openSync(source, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
    // Reuse the importer's existence/containment checks BEFORE any untrusted page runs. Keep this
    // exact job's outline identity through capture and write; never authorise a replacement inode.
    const prepared = htmlPageImportJob({ root, outlinePath: input.outlinePath }, source, undefined, undefined, { alwaysCopy: true })
    if (!prepared.ok) return { ok: false, message: prepared.message }
    const job = prepared.job
    const directory = lstatSync(job.realTalkPath)
    const outline = lstatSync(join(job.realTalkPath, job.outlineName))
    const outlineVersion = { size: outline.size, mtimeMs: outline.mtimeMs }
    job.outlineVersion = outlineVersion
    job.talkDirectory = { dev: directory.dev, ino: directory.ino }
    const target: OfflinePageAuthority = { ...job, outlineVersion, directory: { dev: directory.dev, ino: directory.ino } }
    if (realpathSync.native(root) !== job.realRoot || !offlineAuthorityCurrent(target)) return { ok: false, message: 'The talk changed before capture. Nothing was added.' }
    const result = await deps.capture({ ...input, outlinePath: join(job.realTalkPath, job.outlineName) }, target)
    if (deps.writableTalkRoot(input.outlinePath) !== root || realpathSync.native(root) !== job.realRoot || !offlineAuthorityCurrent(target)) return { ok: false, message: 'The talk changed while saving. Nothing was added.' }
    writeFileSync(fd, result.html, 'utf8')
    // The original job also protects a replacement between this check and the utility process's write.
    const copied = await deps.runImport(job)
    if (!copied.ok) return { ok: false, message: copied.message }
    return { ok: true, embedPath: copied.embedPath, title: result.title, omitted: result.omitted, images: result.images, dataFiles: result.dataFiles }
  } catch { return { ok: false, message: 'The page could not be saved. Check that it opens, then try again.' } }
  finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* already closed */ } }
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}
